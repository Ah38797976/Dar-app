/**
 * scripts/migrate-root-to-store.js
 * -------------------------------------------------------------------------
 * سكريبت هجرة (Migration) يشغّله المسؤول يدويًا مرة واحدة فقط، لنقل البيانات
 * الحالية الموجودة فجذر قاعدة البيانات (khidmaByWeekday, khidmaAll, daamList,
 * maaList, waragList, daamOffset, overrides, absences, expenses, maaState,
 * waragState, fcmTokens) إلى stores/{storeId}/... — أي البنية الجديدة التي
 * تقرأها index.html المحدّث وتفرضها database.rules.json.
 *
 * ⚠️ هذا السكريبت "ينسخ" فقط (copy) — لا يحذف أي شيء من الجذر القديم إطلاقا.
 *    بعد التأكد يدويًا أن كل شيء انتقل صحيحًا وأن التطبيق يشتغل من المسار
 *    الجديد، يمكنك حذف بيانات الجذر القديم بنفسك من Firebase Console إذا
 *    أردت — هذا السكريبت عمدًا لا يقوم بأي حذف.
 *
 * الاستعمال:
 *   node scripts/migrate-root-to-store.js \
 *     --service-account ./serviceAccountKey.json \
 *     --database-url https://dar-app-be4ed-default-rtdb.asia-southeast1.firebasedatabase.app \
 *     --store-id store_default \
 *     [--dry-run]
 * -------------------------------------------------------------------------
 */
'use strict';

const admin = require('firebase-admin');

const ROOT_KEYS = [
  'khidmaByWeekday', 'khidmaAll', 'daamList', 'daamOffset',
  'maaList', 'waragList', 'overrides', 'absences', 'expenses',
  'maaState', 'waragState', 'fcmTokens'
];

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = (i + 1 < argv.length && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
      out[key] = val;
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const storeId = args['store-id'];
  if (!args['service-account'] || !storeId) {
    console.error('مطلوب: --service-account path.json --store-id <id> [--database-url ...] [--dry-run]');
    process.exit(1);
  }

  const serviceAccount = require(require('path').resolve(args['service-account']));
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: args['database-url'] || undefined
  });
  const db = admin.database();

  console.log(`قراءة بيانات الجذر الحالية...`);
  const rootSnap = await db.ref('/').once('value');
  const rootData = rootSnap.val() || {};

  const payload = {};
  ROOT_KEYS.forEach(k => {
    if (rootData[k] !== undefined) payload[k] = rootData[k];
  });

  const foundKeys = Object.keys(payload);
  if (!foundKeys.length) {
    console.log('لا توجد بيانات جذر معروفة لنقلها (ربما تم النقل مسبقًا). لا شيء للفعل.');
    return;
  }
  console.log(`تم العثور على المفاتيح: ${foundKeys.join(', ')}`);

  const existingStoreSnap = await db.ref(`stores/${storeId}`).once('value');
  if (existingStoreSnap.exists()) {
    console.warn(`⚠️ stores/${storeId} موجود مسبقًا وفيه بيانات — سيتم الدمج (merge) فوقه بـ update()، وليس استبداله بالكامل.`);
  }

  if (args['dry-run']) {
    console.log('--dry-run: لن تتم أي كتابة. هذا ما كان سيُنسخ إلى stores/' + storeId + ':');
    console.log(JSON.stringify(payload, null, 2).slice(0, 2000));
    return;
  }

  console.log(`نسخ البيانات إلى stores/${storeId}/ ... (الجذر القديم لن يُمس أو يُحذف)`);
  await db.ref(`stores/${storeId}`).update(payload);
  console.log('✅ تم النسخ بنجاح.');
  console.log('   الخطوة التالية: تأكد أن index.html المحدّث يعمل بشكل صحيح مع هذا المتجر،');
  console.log('   ثم (اختياري ومتروك لك بالكامل) احذف بيانات الجذر القديم يدويًا من Firebase Console.');
}

main().catch(err => {
  console.error('❌ خطأ:', err.message || err);
  process.exit(1);
});
