const admin = require('firebase-admin');
const crypto = require('crypto');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
    databaseURL: process.env.FIREBASE_DATABASE_URL
  });
}

const MAX_ATTEMPTS = 5;
const LOCK_SECONDS = 15 * 60;

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const aa = Buffer.from(a);
  const bb = Buffer.from(b);
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

/* حجز محاولة بشكل ذرّي: القراءة والفحص والزيادة كلها داخل transaction واحدة تعمل على القيمة
   الحالية فـ Firebase (وليس على قراءة قديمة)، فالطلبات المتوازية ما تقدرش تتجاوز الحد.
   - القفل ساري (lockedUntil فالمستقبل): abort بلا تغيير للحالة.
   - القفل انتهى (lockedUntil فالماضي): العداد يبدأ من الصفر.
   - العداد وصل الحد بلا قفل (حالة عالقة): نقفل الآن.
   - المحاولة رقم MAX_ATTEMPTS تُسجَّل مع قفل فورًا: تُفحص هي نفسها، لكن اللي بعدها 429.
   الدالة ممكن تتنادى أكثر من مرة (retry من Firebase)، لذلك كل فرع كيحدّد allowed من جديد
   والنداء الأخير هو المعتمد. الرمز الصحيح كيمسح العقدة كاملة (عدّاد + قفل). */
async function reserveAttempt(ref, now) {
  let allowed = false;
  let retryAfter = LOCK_SECONDS;
  const result = await ref.transaction((current) => {
    const cur = current && typeof current === 'object' ? current : {};
    const lockedUntil = Number(cur.lockedUntil) || 0;
    let attempts = Number(cur.attempts) || 0;
    if (lockedUntil > now) {
      allowed = false;
      retryAfter = Math.max(1, Math.ceil((lockedUntil - now) / 1000));
      return undefined;
    }
    if (lockedUntil) attempts = 0;
    if (attempts >= MAX_ATTEMPTS) {
      allowed = false;
      retryAfter = LOCK_SECONDS;
      return { attempts, lockedUntil: now + LOCK_SECONDS * 1000 };
    }
    attempts += 1;
    allowed = true;
    return attempts >= MAX_ATTEMPTS
      ? { attempts, lockedUntil: now + LOCK_SECONDS * 1000 }
      : { attempts };
  });
  if (result && result.committed === false) allowed = false;
  return { allowed, retryAfter };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  const configuredPin = process.env.BROADCAST_PIN;
  if (typeof configuredPin !== 'string' || configuredPin.length < 8) {
    return res.status(503).json({ error: 'الإشعارات غير مهيأة بشكل آمن' });
  }

  const authHeader = req.headers.authorization || '';
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!idToken) return res.status(401).json({ error: 'مطلوب تسجيل دخول (Authorization header مفقود)' });

  let decoded;
  try {
    decoded = await admin.auth().verifyIdToken(idToken, true);
  } catch {
    return res.status(401).json({ error: 'رمز الدخول غير صالح أو منتهي' });
  }

  const storeId = decoded.storeId;
  const uid = decoded.uid;
  if (!storeId || !uid) return res.status(403).json({ error: 'هذا الحساب غير مربوط بأي متجر' });

  const body = req.body || {};
  const pin = body.pin;
  const verifyOnly = body.verifyOnly === true;
  const title = body.title;
  const messageBody = body.body;
  const now = Date.now();
  const attemptsRef = admin.database().ref(`_security/broadcast/${uid}`);

  // نحجز محاولة ذرّيًا قبل فحص الرمز (fail-closed إذا تعذّر الوصول لقاعدة البيانات)
  let gate;
  try {
    gate = await reserveAttempt(attemptsRef, now);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'تعذّر التحقق الآن، حاول لاحقًا' });
  }
  if (!gate.allowed) {
    res.setHeader('Retry-After', String(gate.retryAfter));
    return res.status(429).json({ error: 'محاولات كثيرة، حاول لاحقًا' });
  }

  if (!safeEqual(pin, configuredPin)) return res.status(403).json({ error: 'رمز غير صحيح' });

  // رمز صحيح: نصفّر العداد والقفل. فشل المسح ما يمنعش هذا الطلب (العقدة ما زالت محدودة بالحد).
  try { await attemptsRef.remove(); } catch (err) { console.error(err); }
  if (verifyOnly) return res.status(200).json({ ok: true });
  if (!title || !messageBody) return res.status(400).json({ error: 'العنوان والنص مطلوبين' });

  try {
    const tokensPath = `stores/${storeId}/fcmTokens`;
    const snap = await admin.database().ref(tokensPath).once('value');
    const tokensData = snap.val() || {};
    const tokens = Object.keys(tokensData);
    if (!tokens.length) return res.status(200).json({ sent: 0, failed: 0, note: 'ما كاين حتى توكن مسجل لهذا المتجر' });

    const response = await admin.messaging().sendEachForMulticast({
      notification: { title, body: messageBody },
      tokens
    });

    const deletions = [];
    response.responses.forEach((r, i) => {
      if (!r.success && r.error && r.error.code === 'messaging/registration-token-not-registered') {
        deletions.push(admin.database().ref(`${tokensPath}/${tokens[i]}`).remove());
      }
    });
    await Promise.all(deletions);
    return res.status(200).json({ sent: response.successCount, failed: response.failureCount });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'صار خطأ فالسيرفر: ' + err.message });
  }
};
