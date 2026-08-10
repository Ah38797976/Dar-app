const admin = require('firebase-admin');

// خاصنا نبداو Firebase Admin مرة وحدة فقط (Vercel كيعاود يستعمل نفس الـ instance بين الطلبات)
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
    databaseURL: process.env.FIREBASE_DATABASE_URL
  });
}

// نفس رمز المسؤول اللي فـ index.html (بصمة الرمز 1829) — نتحققو منو هنا زيادة على المتصفح،
// باش حتى شكون عندو رابط الـ endpoint ما يقدرش يبعث بلا الرمز الصحيح
const ADMIN_PIN_HASH = "19e639b064bdb018bbf393d0f751e6e5e9934f70394531ab3f617513529ab264";

module.exports = async (req, res) => {
  // CORS: نسمحو للصفحة (GitHub Pages أو أي مكان مستضاف فيه التطبيق) تتصل بهذا الـ endpoint
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method Not Allowed' });
    return;
  }

  const { title, body, pinHash } = req.body || {};

  if (pinHash !== ADMIN_PIN_HASH) {
    res.status(403).json({ error: 'رمز غير صحيح' });
    return;
  }
  if (!title || !body) {
    res.status(400).json({ error: 'العنوان والنص مطلوبين' });
    return;
  }

  try {
    const snap = await admin.database().ref('fcmTokens').once('value');
    const tokensData = snap.val() || {};
    const tokens = Object.keys(tokensData);

    if (!tokens.length) {
      res.status(200).json({ sent: 0, failed: 0, note: 'ما كاين حتى توكن مسجل' });
      return;
    }

    const message = {
      notification: { title, body },
      tokens
    };

    const response = await admin.messaging().sendEachForMulticast(message);

    // نمسحو التوكنات الميتة (اللي رجعو خطأ registration-token-not-registered)
    // باش قائمة "📲 حالة الإشعارات" فالتطبيق تبقى نظيفة ومحدثة
    const deletions = [];
    response.responses.forEach((r, i) => {
      if (!r.success && r.error && r.error.code === 'messaging/registration-token-not-registered') {
        deletions.push(admin.database().ref('fcmTokens/' + tokens[i]).remove());
      }
    });
    await Promise.all(deletions);

    res.status(200).json({ sent: response.successCount, failed: response.failureCount });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'صار خطأ فالسيرفر: ' + err.message });
  }
};
