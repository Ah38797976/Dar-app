const admin = require('firebase-admin');
const crypto = require('crypto');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
    databaseURL: process.env.FIREBASE_DATABASE_URL
  });
}

/* ===================== إنشاء حسابات التجار — System Admin فقط =====================
   لا يوجد أي مفتاح مشترك (SETUP_KEY أُلغي نهائيًا). الشرط الوحيد: Firebase ID Token صحيح
   (Authorization: Bearer <idToken>) لحساب عنده الـ custom claim  systemAdmin === true
   (تُمنح فقط عبر scripts/create-admin.js بواسطة Admin SDK — لا يقدر أي مستخدم يعطيها لنفسه).
   - POST فقط، والبيانات فالـ body (ماشي فالرابط) حتى ما تبقاش فالسجلات ولا فتاريخ المتصفح.
   - ما كاينش CORS: مخصص للوحة الأدمن (admin.html) من نفس النطاق فقط.
   - storeId اختياري: إذا ما تبعثش كيتولّد تلقائيًا (store_ + 8 خانات عشوائية). وفكلتا الحالتين
     ممنوع يتكرر: نرفض (409) إذا كان مربوط بحساب آخر أو كاين عندو بيانات فـ stores/{storeId}
     (باش ما يرثش تاجر جديد بيانات متجر قديم أو متجر حالي).
   - الحساب اللي كيتنشأ كياخد claim واحدة فقط { storeId } — لا systemAdmin ولا أي صلاحية أخرى.
   - كلمة السر ما كتترجعش ولا كتتسجّل أبدًا. */
const STORE_ID_RE = /^[a-z0-9_]{1,64}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

function generateStoreId() {
  const bytes = crypto.randomBytes(8);
  let s = 'store_';
  for (const b of bytes) s += ALPHABET[b % ALPHABET.length];
  return s;
}

// true إذا كان storeId مستعمل: claim عند أي مستخدم، أو بيانات موجودة فـ stores/{storeId}
async function storeIdTaken(storeId) {
  let pageToken;
  do {
    const page = await admin.auth().listUsers(1000, pageToken);
    if (page.users.some((u) => u.customClaims && u.customClaims.storeId === storeId)) return true;
    pageToken = page.pageToken;
  } while (pageToken);
  const snap = await admin.database().ref(`stores/${storeId}`).once('value');
  return snap.val() !== null;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'Method Not Allowed' });
    return;
  }

  const authHeader = req.headers.authorization || '';
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!idToken) {
    res.status(401).json({ error: 'مطلوب تسجيل دخول' });
    return;
  }

  let decoded;
  try {
    decoded = await admin.auth().verifyIdToken(idToken, true);
  } catch (err) {
    res.status(401).json({ error: 'رمز الدخول غير صالح أو منتهي' });
    return;
  }
  if (decoded.systemAdmin !== true) {
    res.status(403).json({ error: 'غير مسموح' });
    return;
  }

  const body = req.body || {};
  const { password, storeId, name } = body;
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : body.email;
  if (
    typeof email !== 'string' || email.length > 254 || !EMAIL_RE.test(email) ||
    typeof password !== 'string' || password.length < 8 || password.length > 128 ||
    (storeId !== undefined && (typeof storeId !== 'string' || !STORE_ID_RE.test(storeId))) ||
    (name !== undefined && (typeof name !== 'string' || !name.trim() || name.trim().length > 80))
  ) {
    res.status(400).json({ error: 'email صالح، password (8+ خانات)، storeId اختياري (a-z 0-9 _ حتى 64)، name اختياري (حتى 80) مطلوبة' });
    return;
  }

  let finalStoreId = storeId;
  try {
    if (finalStoreId === undefined) {
      for (let i = 0; i < 5 && finalStoreId === undefined; i++) {
        const candidate = generateStoreId();
        if (!(await storeIdTaken(candidate))) finalStoreId = candidate;
      }
      if (finalStoreId === undefined) throw new Error('could not generate a free storeId');
    } else if (await storeIdTaken(finalStoreId)) {
      res.status(409).json({ error: 'هذا الـ storeId مستعمل مسبقًا' });
      return;
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'تعذّر التحقق من الـ storeId' });
    return;
  }

  let user;
  try {
    const props = { email, password };
    if (name !== undefined) props.displayName = name.trim();
    user = await admin.auth().createUser(props);
  } catch (err) {
    if (err && err.code === 'auth/email-already-exists') {
      res.status(409).json({ error: 'هذا البريد مسجّل مسبقًا' });
    } else {
      console.error(err && err.code ? err.code : 'createUser failed');
      res.status(500).json({ error: 'تعذّر إنشاء الحساب' });
    }
    return;
  }

  try {
    await admin.auth().setCustomUserClaims(user.uid, { storeId: finalStoreId });
  } catch (err) {
    console.error(err && err.code ? err.code : 'setCustomUserClaims failed');
    // ما نخليوش حساب بلا claim معلّق: نحذفوه ونرجّعو خطأ
    try { await admin.auth().deleteUser(user.uid); } catch (e) { console.error(e && e.code ? e.code : 'deleteUser failed'); }
    res.status(500).json({ error: 'تعذّر ربط الحساب بالمتجر، لم يُنشأ أي حساب' });
    return;
  }

  res.status(200).json({ ok: true, storeId: finalStoreId, email, uid: user.uid, name: name !== undefined ? name.trim() : null });
};
