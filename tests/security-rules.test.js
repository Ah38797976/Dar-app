/**
 * tests/security-rules.test.js
 * -------------------------------------------------------------------------
 * اختبار قواعد الأمان (database.rules.json) عبر Firebase Realtime Database
 * Emulator + @firebase/rules-unit-testing. هذا الاختبار يتحقق من العزل
 * الحقيقي المفروض من السيرفر — وهو صلب المطلوب فمهمة "عزل بيانات المتاجر".
 *
 * ⚠️ لم أستطع تشغيل هذا الاختبار في بيئة التنفيذ الحالية: لا يوجد اتصال شبكة
 * (الشبكة معطّلة فهذا الـ sandbox) ولا Firebase CLI/emulator مثبَّت، ولا يمكن
 * تنزيلهما بدون إنترنت. الملف جاهز ويُشغَّل محليًا عندك كالتالي:
 *
 *   1) npm install --save-dev @firebase/rules-unit-testing firebase-tools
 *   2) firebase emulators:exec --only database "node tests/security-rules.test.js"
 *      (أو شغّل `firebase emulators:start --only database` فنافذة، ثم فنافذة
 *       ثانية `node tests/security-rules.test.js`)
 *
 * الاختبار يفترض أن database.rules.json مطبَّقة على الـ emulator (تلقائيًا إذا
 * كانت مذكورة فـ firebase.json تحت "database": { "rules": "database.rules.json" }).
 * -------------------------------------------------------------------------
 */
'use strict';

const assert = require('assert');
const {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails
} = require('@firebase/rules-unit-testing');
const fs = require('fs');

const PROJECT_ID = 'dar-app-rules-test';

async function main() {
  const testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    database: {
      rules: fs.readFileSync('database.rules.json', 'utf8')
    }
  });

  let pass = 0, fail = 0;
  async function check(label, fn) {
    try {
      await fn();
      pass++; console.log(`  ✅ ${label}`);
    } catch (e) {
      fail++; console.log(`  ❌ ${label} — ${e.message}`);
    }
  }

  // مستخدمون بـ claims مختلفة (مُحاكاة لِـ custom claims الحقيقية اللي كيضبطها create-store.js)
  const storeAUser = testEnv.authenticatedContext('uid_store_a', { storeId: 'store_a' });
  const storeBUser = testEnv.authenticatedContext('uid_store_b', { storeId: 'store_b' });
  const noClaimUser = testEnv.authenticatedContext('uid_no_claim', {}); // حساب بلا storeId
  const anon = testEnv.unauthenticatedContext();

  // نزرع بيانات أولية لمتجر A كـ "admin" (يتجاوز القواعد) باش نختبر القراءة بعدها
  await testEnv.withSecurityRulesDisabled(async (adminCtx) => {
    await adminCtx.database().ref('stores/store_a').set({
      absences: [{ id: 1, person: 'سري لمتجر A' }],
      fcmTokens: { tokA: { name: 'هاتف متجر A' } }
    });
    await adminCtx.database().ref('stores/store_b').set({
      absences: [{ id: 2, person: 'سري لمتجر B' }]
    });
  });

  console.log('== اختبارات عزل قواعد الأمان (Firebase Rules) ==');

  await check('متجر A يقدر يقرأ بياناته هو', async () => {
    await assertSucceeds(storeAUser.database().ref('stores/store_a').once('value'));
  });

  await check('متجر A يقدر يكتب فبياناته هو', async () => {
    await assertSucceeds(storeAUser.database().ref('stores/store_a/absences').set([{ id: 3 }]));
  });

  await check('متجر A ممنوع من قراءة بيانات متجر B', async () => {
    await assertFails(storeAUser.database().ref('stores/store_b').once('value'));
  });

  await check('متجر A ممنوع من الكتابة فبيانات متجر B', async () => {
    await assertFails(storeAUser.database().ref('stores/store_b/absences').set([{ hacked: true }]));
  });

  await check('متجر A ممنوع من حذف بيانات متجر B', async () => {
    await assertFails(storeAUser.database().ref('stores/store_b').remove());
  });

  await check('محاولة "تغيير store_id": متجر A يحاول القراءة عبر مسار متجر B رغم أن claim توكنه يبقى store_a — يُرفض من السيرفر بغض النظر عن أي شيء يرسله العميل', async () => {
    // هذا هو جوهر اختبار "تغيير store_id" المطلوب: القاعدة تعتمد فقط على
    // auth.token.storeId (الموثوق، من السيرفر)، وليس على أي قيمة يبعثها العميل،
    // فتغيير المسار يدويًا من طرف متجر A لا يفيده إطلاقًا.
    await assertFails(storeAUser.database().ref('stores/store_b/fcmTokens').once('value'));
  });

  await check('حساب بدون storeId (custom claim) ممنوع من كل شيء', async () => {
    await assertFails(noClaimUser.database().ref('stores/store_a').once('value'));
  });

  await check('مستخدم غير مسجّل الدخول إطلاقًا ممنوع من كل شيء', async () => {
    await assertFails(anon.database().ref('stores/store_a').once('value'));
  });

  await check('القراءة من الجذر مباشرة (بدون تحديد متجر) ممنوعة حتى لمستخدم مسجّل دخول', async () => {
    await assertFails(storeAUser.database().ref('/').once('value'));
  });

  await testEnv.cleanup();

  console.log(`\n${pass} ناجح، ${fail} فاشل`);
  process.exit(fail ? 1 : 0);
}

main().catch(err => {
  console.error('❌ تعذّر تشغيل الاختبار (تأكد من تشغيل الـ emulator):', err.message);
  process.exit(1);
});
