/**
 * tests/system-admin-logic.test.js
 * -------------------------------------------------------------------------
 * اختبار انحدار (regression) صرف Node.js بدون أي حزمة خارجية ولا اتصال شبكة
 * ولا Firebase حقيقي — يشتغل مباشرة بـ:
 *   node tests/system-admin-logic.test.js
 *
 * يغطي منطق "قواعد الـ claims" المستعملة في scripts/create-admin.js فقط
 * (الدمج بين claims الموجودة و systemAdmin، وقاعدة رفض --force):
 * منسوخ كدوال صغيرة مطابقة للمنطق الفعلي في السكريبت، للتأكد أن القواعد
 * التالية صحيحة دائمًا:
 *   1) حساب جديد يُنشأ بـ systemAdmin فقط، بدون storeId إطلاقًا.
 *   2) تحويل حساب بدون storeId إلى systemAdmin لا يحتاج --force.
 *   3) تحويل حساب يملك storeId (حساب تاجر) يُرفض بدون --force.
 *   4) استعمال --force يزيل storeId ويبقي systemAdmin فقط.
 *   5) سحب systemAdmin (revoke) يبقي أي claims أخرى كما هي.
 *
 * هذا اختبار منطقي فقط (logic-level) — لا يتصل بـ Firebase الحقيقي ولا
 * يُنشئ أي مستخدم فعلي. اختبار التكامل الحقيقي (إنشاء حساب فعلي عبر
 * scripts/create-admin.js) يحتاج موافقة صريحة وتنفيذًا يدويًا منفصلاً.
 * -------------------------------------------------------------------------
 */
'use strict';

let pass = 0, fail = 0;
function assertEqual(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}
function assertTrue(cond, label) {
  if (cond) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}`); }
}

/* ===== نسخ مطابق لمنطق create-admin.js (create / set-claim / revoke) ===== */

function claimsForNewAdmin() {
  // cmd === 'create': لا نضبط storeId إطلاقًا
  return { systemAdmin: true };
}

function canSetClaimWithoutForce(existingClaims) {
  return !existingClaims.storeId;
}

function claimsForSetClaim(existingClaims, force) {
  if (existingClaims.storeId && !force) {
    throw new Error('BLOCKED_HAS_STORE_ID');
  }
  return force ? { systemAdmin: true } : { ...existingClaims, systemAdmin: true };
}

function claimsForRevoke(existingClaims) {
  const c = { ...existingClaims };
  delete c.systemAdmin;
  return c;
}

/* ===== الاختبارات ===== */

console.log('== اختبارات منطق System Admin claims (create-admin.js) ==');

assertEqual(claimsForNewAdmin(), { systemAdmin: true }, 'حساب أدمن جديد: systemAdmin فقط، بدون storeId');

assertTrue(canSetClaimWithoutForce({}), 'حساب بدون storeId: يمكن تحويله بدون --force');
assertTrue(!canSetClaimWithoutForce({ storeId: 'store_a' }), 'حساب يملك storeId: يحتاج --force');

assertEqual(
  claimsForSetClaim({}, false),
  { systemAdmin: true },
  'set-claim بدون storeId موجود مسبقًا => { systemAdmin: true }'
);

let threw = false;
try { claimsForSetClaim({ storeId: 'store_a' }, false); }
catch (e) { threw = (e.message === 'BLOCKED_HAS_STORE_ID'); }
assertTrue(threw, 'set-claim على حساب تاجر (له storeId) بدون --force => يُرفض (لا يُنفَّذ التحويل)');

assertEqual(
  claimsForSetClaim({ storeId: 'store_a' }, true),
  { systemAdmin: true },
  'set-claim مع --force على حساب تاجر => storeId يُزال، systemAdmin فقط يبقى'
);

assertEqual(
  claimsForRevoke({ systemAdmin: true }),
  {},
  'revoke على حساب أدمن بحت => يرجع بدون أي claims'
);

assertEqual(
  claimsForRevoke({ systemAdmin: true, someOtherClaim: 'x' }),
  { someOtherClaim: 'x' },
  'revoke يزيل systemAdmin فقط ويُبقي أي claims أخرى كما هي'
);

console.log(`\n${pass} ناجح، ${fail} فاشل`);
process.exit(fail ? 1 : 0);
