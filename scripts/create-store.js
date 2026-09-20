/**
 * scripts/create-store.js
 * -------------------------------------------------------------------------
 * سكريبت يشغّله المسؤول يدويًا على جهازه (Node.js) — ماشي جزء من التطبيق
 * المنشور، وما كيتdeployش لأي سيرفر. الغرض: إنشاء حساب دخول لمتجر جديد
 * (بريد + كلمة سر) وربطه بـ storeId عبر Firebase Custom Claims، حتى تقدر
 * قواعد الأمان (database.rules.json) تعزل بيانات كل متجر.
 *
 * الاستعمال:
 *   1) npm install firebase-admin   (مرة وحدة، محليًا)
 *   2) حمّل ملف Service Account JSON من:
 *      Firebase Console → Project Settings → Service Accounts → Generate new private key
 *   3) شغّل:
 *      node scripts/create-store.js create \
 *        --service-account ./serviceAccountKey.json \
 *        --database-url https://tajirapp-fe79d-default-rtdb.firebaseio.com \
 *        --store-id store_alami \
 *        --email store-alami@dar-app.local \
 *        --password "كلمة سر قوية هنا"
 *
 *   لتحديث/إصلاح claim حساب موجود:
 *      node scripts/create-store.js set-claim \
 *        --service-account ./serviceAccountKey.json \
 *        --database-url ... \
 *        --uid <existing-firebase-uid> \
 *        --store-id store_alami
 *
 *   لعرض قائمة المتاجر المُنشأة (custom claims):
 *      node scripts/create-store.js list --service-account ./serviceAccountKey.json
 *
 * ملاحظة أمان: لا تشارك ملف serviceAccountKey.json مع أحد ولا ترفعه لأي
 * مستودع Git — عنده صلاحية كاملة على المشروع.
 * -------------------------------------------------------------------------
 */
'use strict';

const admin = require('firebase-admin');

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = (i + 1 < argv.length && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
      out[key] = val;
    } else {
      out._.push(a);
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];

  if (!cmd || !['create', 'set-claim', 'list'].includes(cmd)) {
    console.log('الاستعمال: node scripts/create-store.js <create|set-claim|list> [--options]');
    process.exit(1);
  }
  if (!args['service-account']) {
    console.error('مطلوب: --service-account path/to/serviceAccountKey.json');
    process.exit(1);
  }

  const serviceAccount = require(require('path').resolve(args['service-account']));
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: args['database-url'] || undefined
  });

  if (cmd === 'create') {
    const { 'store-id': storeId, email, password } = args;
    if (!storeId || !email || !password) {
      console.error('مطلوب: --store-id --email --password');
      process.exit(1);
    }
    const user = await admin.auth().createUser({ email, password });
    await admin.auth().setCustomUserClaims(user.uid, { storeId });
    console.log(`✅ تم إنشاء حساب المتجر "${storeId}"`);
    console.log(`   uid: ${user.uid}`);
    console.log(`   email: ${email}`);
    console.log('   ملاحظة: خاص المستخدم يخرج ويدخل من جديد (أو تنتهي صلاحية توكنه الحالي) باش الـ claim الجديد يتفعّل.');
    return;
  }

  if (cmd === 'set-claim') {
    const { uid, 'store-id': storeId } = args;
    if (!uid || !storeId) {
      console.error('مطلوب: --uid --store-id');
      process.exit(1);
    }
    await admin.auth().setCustomUserClaims(uid, { storeId });
    console.log(`✅ تم ربط الحساب ${uid} بالمتجر "${storeId}"`);
    return;
  }

  if (cmd === 'list') {
    let nextPageToken;
    const rows = [];
    do {
      const page = await admin.auth().listUsers(1000, nextPageToken);
      page.users.forEach(u => {
        rows.push({
          uid: u.uid,
          email: u.email,
          storeId: (u.customClaims && u.customClaims.storeId) || '(بدون متجر)'
        });
      });
      nextPageToken = page.pageToken;
    } while (nextPageToken);
    console.table(rows);
    return;
  }
}

main().catch(err => {
  console.error('❌ خطأ:', err.message || err);
  process.exit(1);
});
