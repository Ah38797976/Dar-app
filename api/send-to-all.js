const admin = require('firebase-admin');
const crypto = require('crypto');

// خاصنا نبداو Firebase Admin مرة وحدة فقط (Vercel كيعاود يستعمل نفس الـ instance بين الطلبات)
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
    databaseURL: process.env.FIREBASE_DATABASE_URL
  });
}

/* ===================== الإرسال الجماعي — الحماية فالسيرفر فقط =====================
   1) الهوية: Firebase ID Token صحيح (checkRevoked) لحساب متجر. storeId كيتاخد من الـ custom
      claims فقط (ماشي من الـ body)، والإرسال محصور فـ stores/{storeId}/fcmTokens ديال هاد المتجر.
   2) رمز المسؤول (PIN): ما كاين حتى رمز ولا بصمة فالكود ولا فالمستودع. القيمة الصحيحة كتجي
      فقط من متغير البيئة BROADCAST_PIN فـ Vercel (Sensitive، 8 خانات أو أكثر).
      - إذا كان المتغير مفقود أو أقصر من 8 خانات => 503 (fail-closed): ما كيتبعث والو.
      - المقارنة constant-time (timingSafeEqual على بصمتين بنفس الطول، كتحسب فالذاكرة فقط).
   3) تحديد المحاولات: 5 محاولات لكل حساب (uid) فنافذة 15 دقيقة، ثم 429 + Retry-After حتى
      بالرمز الصحيح. العدّاد كيتسجّل قبل المقارنة (transaction) باش الطلبات المتوازية ما تقدرش
      تتجاوز الحد. كيتخزّن فـ _security/broadcast/{uid} (Admin SDK فقط؛ قواعد الجذر مغلقة
      على العملاء) وكيتمسح عند نجاح الرمز.
   4) verifyOnly: { pin, verifyOnly: true } كيتحقق من الرمز فقط ويرجع { ok: true } بلا إرسال
      (كيستعملها زر المسؤول فالواجهة). */
const STORE_ID_RE = /^[a-z0-9_]{1,64}$/;
const MIN_PIN_LENGTH = 8;
const MAX_PIN_LENGTH = 256;
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000;
const MAX_TITLE = 200;
const MAX_BODY = 1000;

const digestOf = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest();

function pinMatches(candidate, expected) {
  if (typeof candidate !== 'string' || candidate.length === 0 || candidate.length > MAX_PIN_LENGTH) return false;
  return crypto.timingSafeEqual(digestOf(candidate), digestOf(expected));
}

function attemptsRef(uid) {
  return admin.database().ref(`_security/broadcast/${uid}`);
}

// كيزيد المحاولة بشكل atomic ثم كيقرا العدّاد. كل طلب كيزيد قبل ما يتقارن رمزو، فالطلب رقم N
// فالتسلسل كيقرا عدّاد >= N، وبالتالي ماكاين حتى طلب يتقارن رمزو من بعد المحاولة الخامسة.
async function registerAttempt(uid, now) {
  const ref = attemptsRef(uid);
  await ref.transaction((cur) => {
    if (!cur || typeof cur.windowStart !== 'number' || now - cur.windowStart >= WINDOW_MS) {
      return { count: 1, windowStart: now };
    }
    return { count: (Number(cur.count) || 0) + 1, windowStart: cur.windowStart };
  });
  const st = (await ref.once('value')).val() || {};
  return { count: Number(st.count) || 0, windowStart: Number(st.windowStart) || now };
}

module.exports = async (req, res) => {
  // CORS: نسمحو للصفحة (GitHub Pages أو أي مكان مستضاف فيه التطبيق) تتصل بهذا الـ endpoint
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method Not Allowed' });
    return;
  }

  const authHeader = req.headers.authorization || '';
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!idToken) {
    res.status(401).json({ error: 'مطلوب تسجيل دخول (Authorization header مفقود)' });
    return;
  }

  let decoded;
  try {
    decoded = await admin.auth().verifyIdToken(idToken, true);
  } catch (err) {
    res.status(401).json({ error: 'رمز الدخول غير صالح أو منتهي' });
    return;
  }

  const storeId = decoded.storeId;
  if (typeof storeId !== 'string' || !STORE_ID_RE.test(storeId)) {
    res.status(403).json({ error: 'هذا الحساب غير مربوط بأي متجر' });
    return;
  }

  const expectedPin = process.env.BROADCAST_PIN;
  if (typeof expectedPin !== 'string' || expectedPin.length < MIN_PIN_LENGTH) {
    console.error('BROADCAST_PIN غير مهيّأ (مفقود أو أقصر من ' + MIN_PIN_LENGTH + ' خانات)');
    res.status(503).json({ error: 'خدمة الإرسال غير مهيّأة بعد' });
    return;
  }

  const { title, body, pin, verifyOnly } = req.body || {};

  try {
    const now = Date.now();
    const { count, windowStart } = await registerAttempt(decoded.uid, now);
    if (count > MAX_ATTEMPTS) {
      const retryAfter = Math.max(1, Math.ceil((windowStart + WINDOW_MS - now) / 1000));
      res.setHeader('Retry-After', String(retryAfter));
      res.status(429).json({ error: 'محاولات كثيرة، حاول بعد قليل' });
      return;
    }
    if (!pinMatches(pin, expectedPin)) {
      res.status(403).json({ error: 'رمز غير صحيح' });
      return;
    }
    await attemptsRef(decoded.uid).remove();
  } catch (err) {
    console.error(err && err.code ? err.code : 'pin check failed');
    res.status(500).json({ error: 'تعذّر التحقق من الرمز الآن' });
    return;
  }

  if (verifyOnly === true) {
    res.status(200).json({ ok: true });
    return;
  }

  const cleanTitle = typeof title === 'string' ? title.trim() : '';
  const cleanBody = typeof body === 'string' ? body.trim() : '';
  if (!cleanTitle || !cleanBody || cleanTitle.length > MAX_TITLE || cleanBody.length > MAX_BODY) {
    res.status(400).json({ error: 'العنوان والنص مطلوبين (العنوان حتى ' + MAX_TITLE + ' والنص حتى ' + MAX_BODY + ' حرف)' });
    return;
  }

  try {
    const tokensPath = `stores/${storeId}/fcmTokens`;
    const snap = await admin.database().ref(tokensPath).once('value');
    const tokensData = snap.val() || {};
    const tokens = Object.keys(tokensData);

    if (!tokens.length) {
      res.status(200).json({ sent: 0, failed: 0, note: 'ما كاين حتى توكن مسجل لهذا المتجر' });
      return;
    }

    const response = await admin.messaging().sendEachForMulticast({
      notification: { title: cleanTitle, body: cleanBody },
      tokens
    });

    // نمسحو التوكنات الميتة (registration-token-not-registered) — فقط داخل توكنات نفس المتجر
    const deletions = [];
    response.responses.forEach((r, i) => {
      if (!r.success && r.error && r.error.code === 'messaging/registration-token-not-registered') {
        deletions.push(admin.database().ref(`${tokensPath}/${tokens[i]}`).remove());
      }
    });
    await Promise.all(deletions);

    res.status(200).json({ sent: response.successCount, failed: response.failureCount });
  } catch (err) {
    console.error(err && err.code ? err.code : 'send failed');
    res.status(500).json({ error: 'صار خطأ فالسيرفر أثناء الإرسال' });
  }
};
