/**
 * tests/inventory-logic.test.js
 * -------------------------------------------------------------------------
 * اختبار انحدار (regression) صرف Node.js بدون أي حزمة خارجية — يشتغل مباشرة بـ:
 *   node tests/inventory-logic.test.js
 *
 * يغطي جزءين:
 *  (أ) دوال منطق المخزون الأساسية (parseNumber/norm/isValidProduct/isValidMove) —
 *      منسوخة حرفيًا من index.html ولم تعدَّل إطلاقًا فهذا التغيير الأمني،
 *      للتأكد أن السلوك الحالي (الموجود من قبل) بقي صحيحا كما هو.
 *  (ب) آلية عزل مفاتيح localStorage الجديدة حسب المتجر (STORE_NS) — التأكد
 *      أن منتجات متجرين مختلفين على نفس الجهاز لا تختلط.
 *
 * ملاحظة: هذا اختبار منطقي (logic-level)، وليس اختبار متصفح كامل (DOM/UI) —
 * الوحدة الأصلية فـ index.html مرتبطة بعناصر DOM كثيرة، ولا يتوفر متصفح أو
 * اتصال شبكة فهذه البيئة لتشغيل اختبار متصفح حقيقي (Puppeteer/Emulator). راجع
 * "الفحص اليدوي المطلوب" فالتقرير النهائي للخطوات التي يجب تجربتها فمتصفح حقيقي.
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

/* ===================== (أ) دوال منسوخة حرفيًا من index.html (غير معدَّلة) ===================== */
const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩', FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
function digits(s) {
  return String(s)
    .replace(/[٠-٩]/g, function (d) { return AR_DIGITS.indexOf(d); })
    .replace(/[۰-۹]/g, function (d) { return FA_DIGITS.indexOf(d); });
}
function norm(s) {
  return digits(s).toLowerCase()
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '')
    .replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه')
    .replace(/\s+/g, ' ').trim();
}
function parseNumber(raw) {
  var s = digits(raw).replace(/[\s\u00A0\u066C]/g, '').replace(/\u066B/g, '.');
  if (s === '') return null;
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, '');
  if (!/^(\d+(\.\d*)?|\.\d+)$/.test(s)) return NaN;
  return Number(s);
}
function round2(n) { return Math.round(n * 100) / 100; }
function isValidProduct(p) {
  return p && typeof p === 'object' && typeof p.id === 'string' &&
    typeof p.name === 'string' && p.name.trim() !== '' &&
    typeof p.buyPrice === 'number' && isFinite(p.buyPrice) &&
    typeof p.sellPrice === 'number' && isFinite(p.sellPrice) &&
    typeof p.qty === 'number' && isFinite(p.qty);
}
function isValidMove(m) {
  return m && typeof m === 'object' && typeof m.id === 'string' && typeof m.productId === 'string' &&
    typeof m.productName === 'string' && (m.type === 'add' || m.type === 'deduct') &&
    typeof m.qty === 'number' && isFinite(m.qty) && typeof m.before === 'number' && isFinite(m.before) &&
    typeof m.after === 'number' && isFinite(m.after) && typeof m.at === 'number' && isFinite(m.at);
}

console.log('== (أ) اختبارات منطق المخزون الأساسي (غير مُعدَّل) ==');
assertEqual(parseNumber('١٢٣'), 123, 'parseNumber يحوّل أرقام عربية');
assertEqual(parseNumber('1,234.5'), 1234.5, 'parseNumber يفهم فاصل الآلاف');
assertTrue(Number.isNaN(parseNumber('abc')), 'parseNumber يرجع NaN لنص غير صالح');
assertEqual(parseNumber(''), null, 'parseNumber يرجع null للفراغ');
assertEqual(round2(1.005 * 1), 1, 'round2 يقرّب صحيح (حالة حافة)');
assertEqual(norm('أحمد'), norm('احمد'), 'norm يوحّد الألف بأشكالها');
assertTrue(isValidProduct({ id: 'p1', name: 'شاي', buyPrice: 10, sellPrice: 15, qty: 5 }), 'isValidProduct يقبل منتج صحيح');
assertTrue(!isValidProduct({ id: 'p1', name: '', buyPrice: 10, sellPrice: 15, qty: 5 }), 'isValidProduct يرفض اسم فارغ');
assertTrue(!isValidProduct({ id: 'p1', name: 'شاي', buyPrice: 'x', sellPrice: 15, qty: 5 }), 'isValidProduct يرفض سعر غير رقمي');
assertTrue(isValidMove({ id: 'm1', productId: 'p1', productName: 'شاي', type: 'add', qty: 2, before: 5, after: 7, at: Date.now() }), 'isValidMove يقبل حركة صحيحة');
assertTrue(!isValidMove({ id: 'm1', productId: 'p1', productName: 'شاي', type: 'x', qty: 2, before: 5, after: 7, at: Date.now() }), 'isValidMove يرفض type غير معروف');

/* ===================== (ب) آلية عزل المفاتيح الجديدة (STORE_NS) ===================== */
console.log('\n== (ب) اختبارات عزل بيانات المتاجر (localStorage namespacing) ==');

// نفس المنطق المضاف فـ index.html حرفيًا (نسختين: سكريبت المنتجات وسكريبت المخزون)
function computeKeys(fakeLocalStorage) {
  var STORE_NS = (function () {
    try { return fakeLocalStorage.getItem('dar.storeId') || '_noStore'; } catch (e) { return '_noStore'; }
  })();
  return {
    PRODUCTS_KEY: 'matjari.products.v1.' + STORE_NS,
    MOVES_KEY: 'matjari.stockMoves.v1.' + STORE_NS
  };
}

// محاكاة بسيطة لـ localStorage (Node لا يتوفر فيه localStorage افتراضيًا)
function makeFakeLocalStorage(initial) {
  const store = Object.assign({}, initial);
  return {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
    _dump: () => store
  };
}

// متجر A يسجل دخوله على هذا الجهاز
const lsA = makeFakeLocalStorage({ 'dar.storeId': 'store_a' });
const keysA = computeKeys(lsA);
lsA.setItem(keysA.PRODUCTS_KEY, JSON.stringify([{ id: 'p1', name: 'منتج متجر أ', buyPrice: 1, sellPrice: 2, qty: 10 }]));

assertEqual(keysA.PRODUCTS_KEY, 'matjari.products.v1.store_a', 'مفتاح المنتجات يتضمّن storeId الصحيح لمتجر A');

// نفس الجهاز، لكن الآن متجر B يسجّل دخوله (بعد storeLogout + إعادة تحميل، كما فـ التطبيق الفعلي)
const lsB = makeFakeLocalStorage({ 'dar.storeId': 'store_b' }); // جهاز جديد افتراضيا بعد reload، لكن نفس physical device
const keysB = computeKeys(lsB);
assertTrue(keysA.PRODUCTS_KEY !== keysB.PRODUCTS_KEY, 'مفتاح متجر B مختلف كليًا عن مفتاح متجر A (لا تصادم بالاسم)');

// محاكاة جهاز واحد استُعمل لمتجرين على التوالي (نفس كائن localStorage الحقيقي فالمتصفح)
const sharedDevice = makeFakeLocalStorage({});
sharedDevice.setItem('dar.storeId', 'store_a');
let k = computeKeys(sharedDevice);
sharedDevice.setItem(k.PRODUCTS_KEY, JSON.stringify([{ id: 'p1', name: 'سكر', buyPrice: 5, sellPrice: 8, qty: 20 }]));

// المستخدم يسجّل خروج من متجر A ويدخل متجر B على نفس الجهاز
sharedDevice.setItem('dar.storeId', 'store_b');
let k2 = computeKeys(sharedDevice);
const storeBProducts = sharedDevice.getItem(k2.PRODUCTS_KEY);
assertEqual(storeBProducts, null, 'متجر B الجديد على نفس الجهاز لا يرى منتجات متجر A إطلاقًا (مفتاح مختلف تمامًا)');

// بيانات متجر A تبقى موجودة (غير محذوفة) تحت مفتاحها الخاص، لو رجع نفس الجهاز لمتجر A
sharedDevice.setItem('dar.storeId', 'store_a');
let k3 = computeKeys(sharedDevice);
const storeAProductsAgain = JSON.parse(sharedDevice.getItem(k3.PRODUCTS_KEY));
assertEqual(storeAProductsAgain[0].name, 'سكر', 'بيانات متجر A محفوظة بسلامة (لم تحذف) عند الرجوع إليه لاحقًا');

// حالة عدم تسجيل الدخول إطلاقًا (لا ينبغي أن يكسر التطبيق)
const lsNone = makeFakeLocalStorage({});
const keysNone = computeKeys(lsNone);
assertEqual(keysNone.PRODUCTS_KEY, 'matjari.products.v1._noStore', 'بدون تسجيل دخول: مفتاح افتراضي آمن بدون كراش');

console.log(`\n${pass} ناجح، ${fail} فاشل`);
process.exit(fail ? 1 : 0);
