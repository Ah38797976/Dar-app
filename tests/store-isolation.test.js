/**
 * tests/store-isolation.test.js
 * -------------------------------------------------------------------------
 * اختبار عزل بيانات المتاجر على نفس الجهاز عند الدخول والخروج وتبديل الحساب.
 * كيشغّل الكود الحقيقي من index.html (مستمع onAuthStateChanged، storeNamespaceReady، storeLogout،
 * unregisterPushToken، وسطور namespace ديال سكريبتي المنتجات والمخزون) داخل vm، مع محاكاة:
 *   - جهاز واحد (localStorage مشترك) + تبويبات (sessionStorage خاص بكل تبويب) + reload حقيقي (إعادة boot)،
 *   - Firebase Auth (جلسة محفوظة، وتزامن الحالة بين التبويبات).
 * القاعدة (invariant) المفحوصة: كل ما يظهر التطبيق (hideLoginScreen)، مفاتيح المنتجات/المخزون
 * لازم تكون مربوطة بـ storeId الحساب الموثَّق، وما يُكتب أبدًا شيء تحت _noStore.
 *   الاستعمال:  node tests/store-isolation.test.js
 *   (اختياري) INDEX_HTML=/path/to/other/index.html node tests/store-isolation.test.js
 * لا شبكة ولا Firebase حقيقي.
 * -------------------------------------------------------------------------
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(process.env.INDEX_HTML || path.join(ROOT, 'index.html'), 'utf8');
let pass = 0, fail = 0;
async function check(label, fn) {
  try { await fn(); pass++; console.log('  ✅ ' + label); }
  catch (e) { fail++; console.log('  ❌ ' + label + ' — ' + e.message); }
}

/* ---------- استخراج الكود الحقيقي من index.html ---------- */
function extractFunction(src, name) {
  const start = src.search(new RegExp('(async\\s+)?function\\s+' + name + '\\s*\\('));
  if (start < 0) return '';
  let i = src.indexOf('{', start), depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++; else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(start, j + 1); }
  }
  throw new Error('unbalanced braces for ' + name);
}
const bootSnippet = (html.match(/window\.TAJIR_BOOT_NS = \(function[\s\S]*?\}\)\(\);/) || [''])[0];
const listenerStart = html.indexOf('auth.onAuthStateChanged(');
const listenerSnippet = html.slice(listenerStart, html.indexOf('\n});\n', listenerStart) + 4);
const nsLines = html.match(/var STORE_NS = (?:\(function \(\) \{[\s\S]*?\}\)\(\)|[^\n]*);/g) || [];
const keyLine = (name) => (html.match(new RegExp('var ' + name + ' = [^\\n]*;')) || [''])[0];
assert.equal(nsLines.length, 2, 'يجب وجود سطر STORE_NS فسكريبتي المنتجات والمخزون');
const productsKeysSrc = `(function () { ${nsLines[0]} ${keyLine('KEY')} return { KEY: KEY }; })()`;
const inventoryKeysSrc = `(function () { ${nsLines[1]} ${keyLine('PRODUCTS_KEY')} ${keyLine('MOVES_KEY')} return { PRODUCTS_KEY: PRODUCTS_KEY, MOVES_KEY: MOVES_KEY }; })()`;

/* ---------- جهاز + تبويبات ---------- */
class Device {
  constructor(opts = {}) {
    this.map = new Map();          // localStorage المشترك بين كل التبويبات
    this.authUser = null;          // الجلسة المحفوظة عند Firebase: { uid, storeId, displayName } أو null
    this.tabs = [];
    this.writeLog = [];            // كل مفاتيح localStorage اللي اتكتبت
    this.throwOnSet = !!opts.throwOnSet;
    this.bootReadBroken = !!opts.bootReadBroken; // أول قراءة لـ dar.storeId فكل boot كترجع null (لاختبار حارس الحلقة)
  }
  get keys() { return [...this.map.keys()]; }
  async broadcastAuth() { for (const t of this.tabs) await t.emitAuth(this.authUser); await Promise.all(this.tabs.map((t) => t.settle())); }
}
class Tab {
  constructor(device) {
    this.device = device; this.session = new Map(); device.tabs.push(this);
    this.bootCount = 0; this.reloadPending = false; this.reloads = 0;
    this.violations = []; this.visibleCount = 0; this.calls = []; this.loginMessage = '';
    this.boot();
  }
  boot() {
    const tab = this, dev = this.device;
    this.bootCount++; this.reloadPending = false; this.visible = false; this.loadAllCalls = 0; this.listener = null;
    let firstBootRead = true;
    const localStorage = {
      getItem(k) { if (dev.bootReadBroken && k === 'dar.storeId' && firstBootRead) { firstBootRead = false; return null; } return dev.map.has(k) ? dev.map.get(k) : null; },
      setItem(k, v) { if (dev.throwOnSet) throw new Error('QuotaExceededError'); dev.map.set(k, String(v)); dev.writeLog.push(k); },
      removeItem(k) { dev.map.delete(k); }
    };
    const sessionStorage = {
      getItem: (k) => (tab.session.has(k) ? tab.session.get(k) : null),
      setItem: (k, v) => { tab.session.set(k, String(v)); }, removeItem: (k) => { tab.session.delete(k); }
    };
    const ctx = vm.createContext({
      console: { error() {}, log() {} }, Promise, setTimeout: () => 0, localStorage, sessionStorage,
      Notification: { permission: 'default' },
      navigator: { serviceWorker: { getRegistration: async () => null } },
      location: { reload() { tab.reloadPending = true; tab.reloads++; } },
      document: { getElementById: () => ({ style: {}, textContent: '', value: '' }) },
      FCM_VAPID_KEY: 'V',
      messaging: { getToken: async () => 'TOKEN', deleteToken: async () => { tab.calls.push('deleteToken'); return true; } },
      storeRef: () => ({ remove: async () => {}, set: async () => {} }),
      auth: {
        onAuthStateChanged(cb) { tab.listener = cb; },
        async signOut() { tab.calls.push('signOut'); dev.authUser = null; for (const t of dev.tabs) await t.emitAuth(null); }
      },
      showLoginScreen(msg) { tab.visible = false; tab.loginMessage = msg || ''; },
      hideLoginScreen() { tab.visible = true; tab.visibleCount++; tab.checkInvariant(); },
      loadAll() { tab.loadAllCalls++; }, registerPushToken() { tab.calls.push('registerPushToken'); }, updateAdminUI() {}
    });
    this.ctx = ctx;
    vm.runInContext('var window = this;', ctx);
    vm.runInContext(`var currentStoreId = null, currentUser = null, authReady = null, pushEnabled = false, isAdmin = localStorage.getItem('isAdmin') === '1';`, ctx);
    if (bootSnippet) vm.runInContext(bootSnippet, ctx);                       // 1) قراءة namespace عند التحميل (الكود الحقيقي)
    this.products = vm.runInContext(productsKeysSrc, ctx);                    // 2) مفاتيح سكريبتي المنتجات والمخزون (الأسطر الحقيقية)
    this.inventory = vm.runInContext(inventoryKeysSrc, ctx);
    for (const fn of ['unregisterPushToken', 'storeLogout', 'storeNamespaceReady']) { const src = extractFunction(html, fn); if (src) vm.runInContext(src, ctx); }
    vm.runInContext(listenerSnippet, ctx);                                    // 3) المستمع الحقيقي
  }
  get storeId() { return vm.runInContext('currentStoreId', this.ctx); }
  get isAdmin() { return vm.runInContext('isAdmin', this.ctx); }
  checkInvariant() {
    const want = '.' + this.storeId;
    for (const k of [this.products.KEY, this.inventory.PRODUCTS_KEY, this.inventory.MOVES_KEY]) {
      if (!k.endsWith(want)) this.violations.push(`التطبيق ظهر للمتجر ${this.storeId} لكن المفتاح ${k}`);
    }
  }
  async emitAuth(u) {
    if (!this.listener) return;
    await this.listener(u ? { uid: 'uid_' + u.storeId, displayName: u.displayName || u.storeId, getIdTokenResult: async () => ({ claims: { storeId: u.storeId } }) } : null);
  }
  async settle() { // reload حقيقي: boot جديد ثم Firebase كيرجّع الجلسة المحفوظة
    let guard = 0;
    while (this.reloadPending && guard++ < 10) { this.boot(); await this.emitAuth(this.device.authUser); }
  }
  async open() { await this.emitAuth(this.device.authUser); await this.settle(); return this; }   // فتح الصفحة
  async login(storeId) { this.device.authUser = { storeId, displayName: 'متجر ' + storeId }; await this.device.broadcastAuth(); }
  async logout() { await vm.runInContext('storeLogout()', this.ctx); await this.settle(); }
  /* نفس ما يعمله سكريبت المنتجات/المخزون: القراءة والكتابة بالمفتاح المحسوب وقت التحميل */
  saveProduct(name) { const k = this.products.KEY; const l = JSON.parse(this.device.map.get(k) || '[]'); l.push(name); this.device.map.set(k, JSON.stringify(l)); this.device.writeLog.push(k); }
  listProducts() { return JSON.parse(this.device.map.get(this.products.KEY) || '[]'); }
}
const noStoreWrites = (dev) => dev.writeLog.filter((k) => k.includes('_noStore'));

(async () => {
  console.log('== عزل المتاجر على نفس الجهاز (الكود الحقيقي من index.html) ==');

  await check('تبديل متجرين على نفس الجهاز: A ثم خروج ثم B ثم خروج ثم A — كل متجر يرى بياناته فقط', async () => {
    const dev = new Device(); const tab = new Tab(dev); await tab.open();
    assert.equal(tab.visible, false, 'بلا جلسة: شاشة الدخول');
    await tab.login('store_a');
    assert.equal(tab.visible, true); assert.equal(tab.storeId, 'store_a');
    assert.ok(tab.products.KEY.endsWith('.store_a'), 'بعد دخول A المنتجات مربوطة بـ store_a وليس ' + tab.products.KEY);
    tab.saveProduct('A-1'); tab.saveProduct('A-2');
    await tab.logout();
    assert.equal(tab.visible, false); assert.equal(dev.map.has('dar.storeId'), false, 'الخروج يمسح dar.storeId');
    await tab.login('store_b');
    assert.equal(tab.storeId, 'store_b'); assert.ok(tab.products.KEY.endsWith('.store_b'), 'بعد دخول B: ' + tab.products.KEY);
    assert.deepEqual(tab.listProducts(), [], 'متجر B ما كيشوف والو من بيانات A');
    tab.saveProduct('B-1');
    await tab.logout(); await tab.login('store_a');
    assert.deepEqual(tab.listProducts(), ['A-1', 'A-2'], 'A كيرجع لبياناتو فقط');
    assert.deepEqual(noStoreWrites(dev), [], 'ما كيتكتب أبدًا تحت _noStore');
    assert.deepEqual(tab.violations, []);
    assert.ok(dev.keys.includes('matjari.products.v1.store_a') && dev.keys.includes('matjari.products.v1.store_b'));
    assert.ok(!dev.keys.some((k) => k.includes('_noStore')), 'ما كاين حتى مفتاح _noStore فالجهاز');
  });

  await check('أول دخول على جهاز جديد: reload واحد قبل عرض التطبيق، وloadAll كيشتغل مرة وحدة بالـ namespace الصحيح', async () => {
    const dev = new Device(); const tab = new Tab(dev); await tab.open(); await tab.login('store_a');
    assert.equal(tab.reloads, 1); assert.equal(tab.visibleCount, 1); assert.equal(tab.loadAllCalls, 1); assert.deepEqual(tab.violations, []);
  });

  await check('جلسة محفوظة لنفس المتجر: ما كاين reload زائد', async () => {
    const dev = new Device(); dev.authUser = { storeId: 'store_a' }; dev.map.set('dar.storeId', 'store_a');
    const tab = new Tab(dev); await tab.open();
    assert.equal(tab.reloads, 0); assert.equal(tab.visible, true); assert.deepEqual(tab.violations, []);
  });

  await check('وضع المسؤول (isAdmin) ما يمرّش من حساب لآخر: الخروج يمسحو، ودخول B مقفول', async () => {
    const dev = new Device(); const tab = new Tab(dev); await tab.open(); await tab.login('store_a');
    dev.map.set('isAdmin', '1'); await tab.logout();
    assert.equal(dev.map.has('isAdmin'), false); await tab.login('store_b');
    assert.equal(tab.isAdmin, false); assert.equal(dev.map.has('isAdmin'), false);
  });

  await check('انتهاء الجلسة بدون خروج ثم دخول متجر آخر: reload + إبطال توكن الإشعارات القديم + namespace الجديد', async () => {
    const dev = new Device(); dev.authUser = { storeId: 'store_a' }; dev.map.set('dar.storeId', 'store_a'); dev.map.set('isAdmin', '1');
    const tab = new Tab(dev); await tab.open(); tab.saveProduct('A-1');
    dev.authUser = null; await dev.broadcastAuth();                       // الجلسة انتهت
    assert.equal(dev.map.has('isAdmin'), false, 'وضع المسؤول اتمسح عند نهاية الجلسة');
    await tab.login('store_b');
    assert.ok(tab.calls.includes('deleteToken'), 'التوكن القديم يتبطّل');
    assert.ok(tab.products.KEY.endsWith('.store_b')); assert.deepEqual(tab.listProducts(), []); assert.deepEqual(tab.violations, []);
  });

  await check('تبويبان: تبويب B يدخل بمتجر آخر → التبويب الأول ما يبقاش على namespace القديم', async () => {
    const dev = new Device(); dev.authUser = { storeId: 'store_a' }; dev.map.set('dar.storeId', 'store_a');
    const t1 = new Tab(dev), t2 = new Tab(dev); await t1.open(); await t2.open(); t1.saveProduct('A-1');
    await t2.logout();                                                    // t2 كيخرج (وt1 كيتلقى الخروج)
    await t2.login('store_b');                                            // t2 كيدخل B (وt1 كيتلقى الحالة الجديدة)
    assert.equal(t1.storeId, 'store_b'); assert.ok(t1.products.KEY.endsWith('.store_b'), 't1: ' + t1.products.KEY);
    assert.deepEqual(t1.listProducts(), []); assert.deepEqual(t1.violations, []); assert.deepEqual(t2.violations, []);
  });

  await check('تخزين محلي غير متاح (setItem كيرمي): ما كاين حلقة reload', async () => {
    const dev = new Device({ throwOnSet: true }); const tab = new Tab(dev); await tab.open(); await tab.login('store_a');
    assert.equal(tab.reloads, 0); assert.equal(tab.visible, true);
  });

  await check('حارس الحلقة: حتى لو القراءة وقت التحميل فشلت كل مرة، reload واحد فقط ثم رفض عرض التطبيق', async () => {
    const dev = new Device({ bootReadBroken: true }); const tab = new Tab(dev); await tab.open(); await tab.login('store_a');
    assert.equal(tab.reloads, 1, 'reloads=' + tab.reloads); assert.equal(tab.visible, false); assert.ok(tab.loginMessage.includes('تخزين'), tab.loginMessage);
    assert.deepEqual(tab.violations, []);
  });

  await check('المصدر: سكريبتا المنتجات والمخزون ما كيقراوش dar.storeId مباشرة (مصدر واحد ثابت وقت التحميل)', async () => {
    assert.ok(bootSnippet, 'window.TAJIR_BOOT_NS غير موجود');
    for (const l of nsLines) assert.ok(!/localStorage/.test(l), 'STORE_NS كيقرا localStorage: ' + l.slice(0, 60));
  });

  console.log(`\n${pass} ناجح، ${fail} فاشل`);
  process.exit(fail ? 1 : 0);
})();
