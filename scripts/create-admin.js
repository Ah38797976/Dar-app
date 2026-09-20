/**
 * scripts/create-admin.js
 * -------------------------------------------------------------------------
 * سكريبت يشغّله المسؤول يدويًا على جهازه (Node.js) — ماشي جزء من التطبيق
 * المنشور، وما كيتdeployش لأي سيرفر. الغرض: إنشاء/تجهيز حساب "System Admin"
 * حقيقي عبر Firebase Authentication + Custom Claim واحدة فقط:
 *
 *     { systemAdmin: true }
 *
 * هذا الحساب منفصل تمامًا عن حسابات المتاجر (storeId):
 *   - لا يُضبط له storeId إطلاقًا (عمدًا).
 *   - بما أن index.html الحالي يرفض أي حساب بدون storeId claim (انظر
 *     auth.onAuthStateChanged فـ index.html)، فحساب System Admin لن يقدر
 *     يدخل لواجهة التاجر العادية إطلاقًا — بدون أي تعديل على index.html.
 *   - لا علاقة له بـ "Admin PIN" الموجود داخل index.html (ذاك رمز واجهة
 *     محلي لكل متجر، وليس حسابًا حقيقيًا، ولا نغيّره في هذه المرحلة).
 *
 * هذا السكريبت هو أداة CLI مؤقتة لهذه المرحلة فقط (المرحلة 1) — وليس الحل
 * النهائي لإدارة النظام. لوحة Admin (admin.html + API endpoints محمية
 * بـ systemAdmin) ستأتي في مرحلة لاحقة منفصلة.
 *
 * الاستعمال:
 *   1) npm install   (يثبّت firebase-admin، نفس تبعية create-store.js)
 *   2) حمّل ملف Service Account JSON من:
 *      Firebase Console → Project Settings → Service Accounts → Generate new private key
 *      (نفس الملف المستعمل مع scripts/create-store.js — لا تشاركه ولا ترفعه لأي Git repo)
 *   3) شغّل:
 *
 *      إنشاء حساب أدمن جديد:
 *      node scripts/create-admin.js create \
 *        --service-account ./serviceAccountKey.json \
 *        --email admin@example.com \
 *        --password "كلمة سر قوية هنا"
 *
 *      تحويل حساب Firebase موجود مسبقًا إلى System Admin (بدل إنشاء واحد جديد):
 *      node scripts/create-admin.js set-claim \
 *        --service-account ./serviceAccountKey.json \
 *        --uid <existing-firebase-uid>
 *
 *      عرض كل حسابات System Admin الحالية:
 *      node scripts/create-admin.js list \
 *        --service-account ./serviceAccountKey.json
 *
 *      سحب صلاحية System Admin من حساب (بدون حذف الحساب نفسه):
 *      node scripts/create-admin.js revoke \
 *        --service-account ./serviceAccountKey.json \
 *        --uid <existing-firebase-uid>
 *
 * ملاحظات أمان:
 *   - لا تشارك ملف serviceAccountKey.json مع أحد ولا ترفعه لأي مستودع Git —
 *     عنده صلاحية كاملة على المشروع (نفس تحذير create-store.js بالضبط).
 *   - هذا السكريبت لا يحتاج --database-url إطلاقًا (Custom Claims جزء من
 *     Firebase Authentication وليس Realtime Database)، ولا يلمس أي بيانات
 *     تحت stores/{storeId}/... إطلاقًا.
 *   - إذا كان الحساب الذي تحوّله عبر set-claim يملك storeId مسبقًا (حساب
 *     تاجر موجود)، السكريبت سيرفض العملية تلقائيًا ويطلب تأكيدًا صريحًا
 *     عبر --force، لمنع تحويل حساب تاجر حقيقي لأدمن بالخطأ.
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

  if (!cmd || !['create', 'set-claim', 'list', 'revoke'].includes(cmd)) {
    console.log('الاستعمال: node scripts/create-admin.js <create|set-claim|list|revoke> [--options]');
    process.exit(1);
  }
  if (!args['service-account']) {
    console.error('مطلوب: --service-account path/to/serviceAccountKey.json');
    process.exit(1);
  }

  const serviceAccount = require(require('path').resolve(args['service-account']));
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });

  if (cmd === 'create') {
    const { email, password } = args;
    if (!email || !password) {
      console.error('مطلوب: --email --password');
      process.exit(1);
    }
    if (String(password).length < 8) {
      console.error('كلمة السر يجب أن تكون 8 خانات على الأقل');
      process.exit(1);
    }
    const user = await admin.auth().createUser({ email, password });
    // عمدًا: لا نضبط storeId إطلاقًا لهذا الحساب — فقط systemAdmin.
    await admin.auth().setCustomUserClaims(user.uid, { systemAdmin: true });
    console.log(`✅ تم إنشاء حساب System Admin`);
    console.log(`   uid: ${user.uid}`);
    console.log(`   email: ${email}`);
    console.log('   ملاحظة: خاص المستخدم يخرج ويدخل من جديد (أو تنتهي صلاحية توكنه الحالي) باش الـ claim الجديد يتفعّل.');
    console.log('   هذا الحساب بدون storeId، لذلك index.html الحالي (واجهة التاجر) سيرفضه تلقائيًا — وهذا هو المطلوب.');
    return;
  }

  if (cmd === 'set-claim') {
    const { uid } = args;
    if (!uid) {
      console.error('مطلوب: --uid');
      process.exit(1);
    }
    const existing = await admin.auth().getUser(uid);
    const existingClaims = existing.customClaims || {};
    if (existingClaims.storeId && !args.force) {
      console.error(`⚠️ هذا الحساب (${existing.email || uid}) مربوط حاليًا بمتجر "${existingClaims.storeId}".`);
      console.error('   تحويله لـ System Admin سيبقي storeId كما هو إلا إذا استعملت --force لإزالته.');
      console.error('   إذا كنت متأكدًا فعلاً، أعد المحاولة مع --force.');
      process.exit(1);
    }
    const newClaims = args.force ? { systemAdmin: true } : { ...existingClaims, systemAdmin: true };
    await admin.auth().setCustomUserClaims(uid, newClaims);
    console.log(`✅ تم تفعيل systemAdmin للحساب ${uid}`);
    if (args.force && existingClaims.storeId) {
      console.log(`   تم إزالة storeId "${existingClaims.storeId}" من هذا الحساب (بسبب --force).`);
    }
    return;
  }

  if (cmd === 'revoke') {
    const { uid } = args;
    if (!uid) {
      console.error('مطلوب: --uid');
      process.exit(1);
    }
    const existing = await admin.auth().getUser(uid);
    const existingClaims = { ...(existing.customClaims || {}) };
    delete existingClaims.systemAdmin;
    await admin.auth().setCustomUserClaims(uid, existingClaims);
    console.log(`✅ تم سحب صلاحية systemAdmin من الحساب ${uid} (الحساب نفسه لم يُحذف)`);
    return;
  }

  if (cmd === 'list') {
    let nextPageToken;
    const rows = [];
    do {
      const page = await admin.auth().listUsers(1000, nextPageToken);
      page.users.forEach(u => {
        if (u.customClaims && u.customClaims.systemAdmin === true) {
          rows.push({
            uid: u.uid,
            email: u.email,
            disabled: u.disabled,
            hasStoreIdToo: u.customClaims.storeId || '(لا)'
          });
        }
      });
      nextPageToken = page.pageToken;
    } while (nextPageToken);
    if (!rows.length) {
      console.log('لا يوجد أي حساب System Admin حاليًا.');
    } else {
      console.table(rows);
    }
    return;
  }
}

main().catch(err => {
  console.error('❌ خطأ:', err.message || err);
  process.exit(1);
});
