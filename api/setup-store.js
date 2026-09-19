const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
  });
}

// ملف مؤقت: احذفه فور إنشاء الحساب
const SETUP_KEY = '7480d28bed94c0c7b5cff02f';

module.exports = async (req, res) => {
  const { key, email, password, storeId } = req.query || {};
  if (key !== SETUP_KEY) {
    res.status(403).json({ error: 'forbidden' });
    return;
  }
  if (!email || !password || !storeId || !/^[a-z0-9_]+$/.test(storeId) || String(password).length < 8) {
    res.status(400).json({ error: 'email, password (8+ chars), storeId (a-z 0-9 _) required' });
    return;
  }
  try {
    const user = await admin.auth().createUser({ email, password });
    await admin.auth().setCustomUserClaims(user.uid, { storeId });
    res.status(200).json({ ok: true, storeId, email });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
