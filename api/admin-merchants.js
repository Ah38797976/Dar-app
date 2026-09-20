const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
    databaseURL: process.env.FIREBASE_DATABASE_URL
  });
}

/* ===================== إدارة التجار — System Admin فقط =====================
   يستعملها admin.html. الحماية كاملة فالسيرفر:
   - POST فقط + Firebase ID Token صحيح (checkRevoked) لحساب عنده systemAdmin === true. أي تاجر => 403.
   - ما كاينش CORS (نفس النطاق فقط)، والردود no-store.
   - الأفعال: { action: 'list' } و { action: 'set-disabled', uid, disabled }.
   - القائمة كتاخد فقط الحقول المسموحة (whitelist): ما كنرجّعوش أبدًا passwordHash/passwordSalt
     ولا أي بيانات حساسة أخرى من Admin SDK. كلمات السر غير مخزّنة عندنا أصلاً وما كتظهرش.
   - التعطيل = updateUser(disabled:true) + revokeRefreshTokens: ما بقاش يقدر يدخل ولا يجدد
     توكن. (توكن ID اللي عند التاجر صالح حتى ساعة كحد أقصى لقراءة/كتابة قاعدة البيانات،
     لكن send-to-all كيرفضو فورًا لأنه كيستعمل checkRevoked.)
   - ما كنسمحوش تعطّل: نفسك، ولا حساب System Admin، ولا حساب بلا storeId. */
const UID_RE = /^[A-Za-z0-9]{1,128}$/;

function toRow(u) {
  const c = u.customClaims || {};
  const m = u.metadata || {};
  return {
    uid: u.uid,
    email: u.email || null,
    name: u.displayName || null,
    storeId: c.storeId,
    disabled: !!u.disabled,
    createdAt: m.creationTime || null,
    lastSignInAt: m.lastSignInTime || null
  };
}

async function listMerchants() {
  const rows = [];
  let pageToken;
  do {
    const page = await admin.auth().listUsers(1000, pageToken);
    for (const u of page.users) {
      const c = u.customClaims || {};
      if (typeof c.storeId === 'string' && c.storeId && c.systemAdmin !== true) rows.push(toRow(u));
    }
    pageToken = page.pageToken;
  } while (pageToken);
  // creationTime من Firebase نص RFC 1123 ("Thu, 04 Sep 2026 ...") — المقارنة النصية كترتّب بأسماء الأيام،
  // فكنحوّلوه لرقم (Date.parse) باش الترتيب يكون فعلاً من الأحدث للأقدم.
  const ts = (v) => { const t = Date.parse(v); return Number.isNaN(t) ? 0 : t; };
  rows.sort((a, b) => ts(b.createdAt) - ts(a.createdAt));
  return rows;
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

  const { action, uid, disabled } = req.body || {};

  if (action === 'list') {
    try {
      const merchants = await listMerchants();
      res.status(200).json({
        merchants,
        total: merchants.length,
        active: merchants.filter((m) => !m.disabled).length,
        disabled: merchants.filter((m) => m.disabled).length
      });
    } catch (err) {
      console.error(err && err.code ? err.code : 'listUsers failed');
      res.status(500).json({ error: 'تعذّر جلب قائمة التجار' });
    }
    return;
  }

  if (action === 'set-disabled') {
    if (typeof uid !== 'string' || !UID_RE.test(uid) || typeof disabled !== 'boolean') {
      res.status(400).json({ error: 'uid و disabled (true/false) مطلوبان' });
      return;
    }
    if (uid === decoded.uid) {
      res.status(400).json({ error: 'لا يمكنك تعطيل حسابك أنت' });
      return;
    }
    let target;
    try {
      target = await admin.auth().getUser(uid);
    } catch (err) {
      if (err && err.code === 'auth/user-not-found') {
        res.status(404).json({ error: 'الحساب غير موجود' });
      } else {
        console.error(err && err.code ? err.code : 'getUser failed');
        res.status(500).json({ error: 'تعذّر جلب الحساب' });
      }
      return;
    }
    const claims = target.customClaims || {};
    if (claims.systemAdmin === true || typeof claims.storeId !== 'string' || !claims.storeId) {
      res.status(403).json({ error: 'هذا الحساب ليس حساب تاجر' });
      return;
    }
    try {
      await admin.auth().updateUser(uid, { disabled });
      if (disabled) await admin.auth().revokeRefreshTokens(uid);
    } catch (err) {
      console.error(err && err.code ? err.code : 'updateUser failed');
      res.status(500).json({ error: 'تعذّر تحديث حالة الحساب' });
      return;
    }
    res.status(200).json({ ok: true, uid, disabled });
    return;
  }

  res.status(400).json({ error: 'action غير معروف' });
};
