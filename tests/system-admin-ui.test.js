/**
 * tests/system-admin-ui.test.js
 * -------------------------------------------------------------------------
 * اختبارات لوحة System Admin (admin.html + admin.js) بدون متصفح ولا شبكة:
 *   (أ) المنطق الصرف فـ admin.js (تحقق النموذج، توليد كلمة السر، تصفية القائمة، ...)
 *   (ب) عميل الـ API: المسارات، Authorization: Bearer، POST، وأن التوكن/كلمة السر ما كيتسربوش
 *   (ج) فحوص ساكنة: الربط بين admin.html و admin.js (كل id مستعمل موجود)، وبلا innerHTML ولا
 *       تخزين محلي ولا أسرار، وأن الواجهة ما كتلمس قاعدة البيانات.
 *   الاستعمال:  node tests/system-admin-ui.test.js
 * ⚠️ التفاعل الفعلي فالمتصفح (أزرار/شاشات) ما كيتغطاش هنا — يُجرَّب يدويًا حسب SECURITY-MULTI-TENANT.md.
 * -------------------------------------------------------------------------
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
async function check(label, fn) {
  try { await fn(); pass++; console.log('  ✅ ' + label); }
  catch (e) { fail++; console.log('  ❌ ' + label + ' — ' + e.message); }
}
const L = require(path.join(ROOT, 'admin.js'));
const html = fs.readFileSync(path.join(ROOT, 'admin.html'), 'utf8');
const js = fs.readFileSync(path.join(ROOT, 'admin.js'), 'utf8');
const jsNoComments = js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

(async () => {
  console.log('\n== (أ) منطق admin.js ==');
  const good = { name: '  متجر النور ', email: '  Noor@Example.COM ', password: 'S3cure-pass!', storeId: '' };

  await check('validateMerchantForm: مدخلات صحيحة => payload منظّف (trim/lowercase) وstoreId غائب إذا فارغ', async () => {
    const v = L.validateMerchantForm(good);
    assert.ok(v.ok); assert.deepEqual(v.payload, { email: 'noor@example.com', password: 'S3cure-pass!', name: 'متجر النور' });
    assert.ok(!('storeId' in v.payload)); });
  await check('validateMerchantForm: storeId مخصص يُحوَّل lowercase ويُرسَل', async () => {
    const v = L.validateMerchantForm({ ...good, storeId: ' My_Shop_1 ' }); assert.ok(v.ok); assert.equal(v.payload.storeId, 'my_shop_1'); });
  await check('validateMerchantForm: كلمة السر ما كتتقصّش (فراغات مسموحة) ولا كتتغيّر', async () => {
    const v = L.validateMerchantForm({ ...good, password: '  abc def 12 ' }); assert.ok(v.ok); assert.equal(v.payload.password, '  abc def 12 '); });
  await check('validateMerchantForm: الاسم مطلوب، والبريد، وكلمة السر (8+)', async () => {
    const v = L.validateMerchantForm({}); assert.ok(!v.ok); assert.deepEqual(Object.keys(v.errors).sort(), ['email', 'name', 'password']); });
  await check('validateMerchantForm: قيم حدّية مرفوضة', async () => {
    for (const bad of [{ name: 'x'.repeat(81) }, { email: 'a@b' }, { email: 'a b@c.com' }, { email: 'a'.repeat(250) + '@c.com' },
      { password: '1234567' }, { password: 'x'.repeat(129) }, { storeId: 'a b' }, { storeId: '../x' }, { storeId: 'ب' }, { storeId: 'a'.repeat(65) }]) {
      assert.ok(!L.validateMerchantForm({ ...good, ...bad }).ok, JSON.stringify(bad)); } });
  await check('validateMerchantForm: قيم حدّية مقبولة (name=80، pw=8 و128، storeId=64)', async () => {
    for (const ok of [{ name: 'x'.repeat(80) }, { password: '12345678' }, { password: 'x'.repeat(128) }, { storeId: 'a'.repeat(64) }]) {
      assert.ok(L.validateMerchantForm({ ...good, ...ok }).ok, JSON.stringify(ok)); } });
  await check('validateMerchantForm: مدخلات null/undefined ما كتكرّشيش', async () => {
    assert.ok(!L.validateMerchantForm(null).ok); assert.ok(!L.validateMerchantForm(undefined).ok); });

  await check('generatePassword: 16 خانة من الأبجدية الآمنة + حرف كبير وصغير ورقم (300 مرة)', async () => {
    const seen = new Set();
    for (let i = 0; i < 300; i++) {
      const p = L.generatePassword(); assert.equal(p.length, 16); seen.add(p);
      for (const ch of p) assert.ok(L.PASSWORD_ALPHABET.includes(ch), ch);
      assert.ok(/[A-Z]/.test(p) && /[a-z]/.test(p) && /[0-9]/.test(p), p); }
    assert.equal(seen.size, 300); });
  await check('generatePassword: الأبجدية بلا حروف ملتبسة (0 O 1 l I)', async () => { assert.ok(!/[0O1lI]/.test(L.PASSWORD_ALPHABET)); });
  await check('generatePassword: كيرفض البايتات ≥ 224 (بلا انحياز modulo) وكيكمّل من غيرها', async () => {
    let call = 0; const rng = (arr) => { call++; for (let i = 0; i < arr.length; i++) arr[i] = call === 1 ? 255 : (i * 7 + call * 13) % 224; };
    const p = L.generatePassword(12, rng); assert.equal(p.length, 12); assert.ok(call >= 2); });
  await check('generatePassword: RNG ثابت (يفشل شرط الأصناف) => يرمي خطأ بدل كلمة ضعيفة', async () => {
    assert.throws(() => L.generatePassword(16, (arr) => arr.fill(0)), /password generation failed/); });

  const list = [
    { uid: '1', name: 'متجر النور', email: 'noor@example.com', storeId: 'store_aaa', disabled: false },
    { uid: '2', name: null, email: 'bob@example.com', storeId: 'store_bbb', disabled: true },
    { uid: '3', name: 'Zed Shop', email: 'z@shop.io', storeId: 'my_zed', disabled: false }
  ];
  await check('statusOf / summarize', async () => {
    assert.equal(L.statusOf(list[0]), 'active'); assert.equal(L.statusOf(list[1]), 'disabled'); assert.equal(L.statusOf(null), 'active');
    assert.deepEqual(L.summarize(list), { total: 3, active: 2, disabled: 1 }); assert.deepEqual(L.summarize(null), { total: 0, active: 0, disabled: 0 }); });
  await check('filterMerchants: بالحالة', async () => {
    assert.deepEqual(L.filterMerchants(list, { status: 'disabled' }).map((m) => m.uid), ['2']);
    assert.deepEqual(L.filterMerchants(list, { status: 'active' }).map((m) => m.uid), ['1', '3']);
    assert.equal(L.filterMerchants(list, {}).length, 3); });
  await check('filterMerchants: بحث (اسم/بريد/storeId) غير حساس لحالة الأحرف + يتحمّل null', async () => {
    assert.deepEqual(L.filterMerchants(list, { query: 'ZED' }).map((m) => m.uid), ['3']);
    assert.deepEqual(L.filterMerchants(list, { query: 'BOB@' }).map((m) => m.uid), ['2']);
    assert.deepEqual(L.filterMerchants(list, { query: 'store_' }).map((m) => m.uid), ['1', '2']);
    assert.deepEqual(L.filterMerchants(list, { query: 'النور' }).map((m) => m.uid), ['1']);
    assert.deepEqual(L.filterMerchants(list, { query: 'zed', status: 'disabled' }), []);
    assert.deepEqual(L.filterMerchants(undefined, {}), []); });
  await check('formatDate: قيمة فارغة/غير صالحة => —، وصالحة => نص', async () => {
    assert.equal(L.formatDate(null), '—'); assert.equal(L.formatDate('garbage'), '—');
    assert.ok(L.formatDate('Thu, 04 Sep 2026 10:30:00 GMT').length > 4); });
  await check('apiErrorMessage / authErrorMessage', async () => {
    assert.match(L.apiErrorMessage(401, null), /انتهت الجلسة/); assert.match(L.apiErrorMessage(0, null), /الاتصال/);
    assert.equal(L.apiErrorMessage(409, { error: 'هذا البريد مسجّل مسبقًا' }), 'هذا البريد مسجّل مسبقًا');
    assert.match(L.apiErrorMessage(500, null), /500/);
    assert.match(L.authErrorMessage('auth/invalid-credential'), /غير صحيحة/); assert.match(L.authErrorMessage('auth/too-many-requests'), /كثيرة/);
    assert.ok(!/auth\//.test(L.authErrorMessage('auth/whatever'))); });

  console.log('\n== (ب) عميل الـ API ==');
  const mkFetch = (status, body, opts = {}) => {
    const calls = [];
    const fn = async (url, init) => { calls.push({ url, init }); if (opts.throws) throw new Error('net'); return { ok: status >= 200 && status < 300, status, json: async () => { if (opts.badJson) throw new Error('bad'); return body; } }; };
    fn.calls = calls; return fn;
  };
  await check('listMerchants: POST /api/admin-merchants + Bearer + body {action:list} + بلا cookies', async () => {
    const f = mkFetch(200, { merchants: [] }); const api = L.createApiClient({ fetchFn: f, getToken: async () => 'TOK' });
    await api.listMerchants(); const c = f.calls[0];
    assert.equal(c.url, '/api/admin-merchants'); assert.equal(c.init.method, 'POST');
    assert.equal(c.init.headers.Authorization, 'Bearer TOK'); assert.deepEqual(JSON.parse(c.init.body), { action: 'list' });
    assert.equal(c.init.credentials, 'omit'); assert.equal(c.init.cache, 'no-store'); });
  await check('setDisabled: body {action:set-disabled, uid, disabled} وTOKEN مش فالـ URL ولا الـ body', async () => {
    const f = mkFetch(200, { ok: true }); const api = L.createApiClient({ fetchFn: f, getToken: async () => 'SECRET-TOKEN' });
    await api.setDisabled('uid1', true); const c = f.calls[0];
    assert.deepEqual(JSON.parse(c.init.body), { action: 'set-disabled', uid: 'uid1', disabled: true });
    assert.ok(!c.url.includes('SECRET-TOKEN') && !c.init.body.includes('SECRET-TOKEN')); });
  await check('createMerchant: POST /api/setup-store بالـ payload كما هو', async () => {
    const f = mkFetch(200, { ok: true, storeId: 'store_x' }); const api = L.createApiClient({ fetchFn: f, getToken: async () => 'T' });
    const payload = { email: 'a@b.co', password: 'longpassword', name: 'N' }; const out = await api.createMerchant(payload);
    assert.equal(f.calls[0].url, '/api/setup-store'); assert.deepEqual(JSON.parse(f.calls[0].init.body), payload); assert.equal(out.storeId, 'store_x'); });
  await check('بلا توكن => ApiError 401 وfetch ما كيتستدعاش', async () => {
    const f = mkFetch(200, {}); const api = L.createApiClient({ fetchFn: f, getToken: async () => null });
    await assert.rejects(api.listMerchants(), (e) => e instanceof L.ApiError && e.status === 401); assert.equal(f.calls.length, 0); });
  await check('getToken يرمي => ApiError 401', async () => {
    const api = L.createApiClient({ fetchFn: mkFetch(200, {}), getToken: async () => { throw new Error('x'); } });
    await assert.rejects(api.listMerchants(), (e) => e.status === 401); });
  await check('خطأ شبكة => ApiError status=0', async () => {
    const api = L.createApiClient({ fetchFn: mkFetch(200, {}, { throws: true }), getToken: async () => 'T' });
    await assert.rejects(api.listMerchants(), (e) => e.status === 0 && /الاتصال/.test(e.message)); });
  await check('403/409/500 => ApiError برسالة السيرفر (أو عامة)', async () => {
    for (const [s, body, re] of [[403, { error: 'غير مسموح' }, /غير مسموح/], [409, { error: 'هذا الـ storeId مستعمل مسبقًا' }, /storeId/], [500, null, /500/]]) {
      const api = L.createApiClient({ fetchFn: mkFetch(s, body), getToken: async () => 'T' });
      await assert.rejects(api.createMerchant({}), (e) => e.status === s && re.test(e.message)); } });
  await check('رد غير JSON فحالة خطأ => ApiError عادي، وفحالة نجاح => {}', async () => {
    const bad = L.createApiClient({ fetchFn: mkFetch(502, null, { badJson: true }), getToken: async () => 'T' });
    await assert.rejects(bad.listMerchants(), (e) => e.status === 502);
    const okc = L.createApiClient({ fetchFn: mkFetch(200, null, { badJson: true }), getToken: async () => 'T' });
    assert.deepEqual(await okc.listMerchants(), {}); });

  console.log('\n== (ج) فحوص ساكنة: الربط والأمان ==');
  await check('admin.html كيحمّل admin.js وFirebase app+auth فقط (بلا database/messaging) وبلا JavaScript مضمّن', async () => {
    assert.match(html, /<script src="admin\.js"><\/script>/);
    const srcs = [...html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(srcs.filter((s) => s.includes('firebasejs')).map((s) => s.split('/').pop()), ['firebase-app-compat.js', 'firebase-auth-compat.js']);
    assert.ok(![...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)].some((m) => m[1].trim()), 'inline script');
    assert.ok(!/\son[a-z]+\s*=\s*["']/i.test(html), 'inline event handler'); });
  await check('كل id مستعمل فـ admin.js موجود فـ admin.html', async () => {
    const ids = new Set([...jsNoComments.matchAll(/\$\('([A-Za-z0-9-]+)'\)/g)].map((m) => m[1]));
    for (const k of ['name', 'email', 'password', 'storeId']) { ids.add('f-' + k); ids.add('err-' + k); }
    assert.ok(ids.size > 25, 'ids=' + ids.size);
    for (const id of ids) assert.ok(new RegExp('\\sid="' + id + '"').test(html), 'id مفقود فـ admin.html: ' + id); });
  await check('أزرار التصفية data-filter (all/active/disabled) موجودة، ومطابقة لـ statusOf', async () => {
    for (const f of ['all', 'active', 'disabled']) assert.ok(html.includes('data-filter="' + f + '"'), f); });
  await check('الربط بالـ API: /admin-merchants و/setup-store وأفعال list/set-disabled وBearer', async () => {
    for (const s of ["'/admin-merchants'", "'/setup-store'", "action: 'list'", "action: 'set-disabled'", "'Bearer '", 'listMerchants', 'setDisabled', 'createMerchant'])
      assert.ok(jsNoComments.includes(s), s);
    assert.match(jsNoComments, /api\.listMerchants\(\)/); assert.match(jsNoComments, /api\.setDisabled\(/); assert.match(jsNoComments, /api\.createMerchant\(/); });
  await check('كل الوظائف المطلوبة ظاهرة: name/email/password/storeId + Active/Disabled + تفعيل/تعطيل + عرض storeId/البريد', async () => {
    for (const s of ['f-name', 'f-email', 'f-password', 'f-storeId', 'btn-generate-pw', 'merchant-list', 'نشط', 'معطّل', 'تعطيل الحساب', 'تفعيل الحساب', 'm.storeId', 'm.email'])
      assert.ok(html.includes(s) || jsNoComments.includes(s), s); });
  await check('التحقق النهائي فالسيرفر: الواجهة ما كتعطي صلاحية بنفسها (systemAdmin للعرض فقط + 401/403 => خروج)', async () => {
    assert.match(jsNoComments, /claims\.systemAdmin === true/); assert.match(jsNoComments, /err\.status === 403[\s\S]{0,80}forceLogout/);
    assert.ok(!/isSystemAdmin\s*=\s*true|localAdmin/.test(jsNoComments)); });
  await check('بلا innerHTML/outerHTML/insertAdjacentHTML/document.write/eval/new Function', async () => {
    assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\s*\(|new Function/.test(jsNoComments)); });
  await check('كلمة السر ما كتتخزّنش: بلا localStorage/sessionStorage/indexedDB/cookie فـ admin.js وadmin.html', async () => {
    for (const s of [jsNoComments, html]) assert.ok(!/localStorage|sessionStorage|indexedDB|document\.cookie/.test(s)); });
  await check('كلمة السر ما كتتسجّلش: بلا console.* فـ admin.js', async () => { assert.ok(!/console\./.test(jsNoComments)); });
  await check('الواجهة ما كتلمسش قاعدة البيانات ولا كتتضمن أسرار (service account / hash / PIN)', async () => {
    assert.ok(!/firebase\.database|firebase-database|\.ref\(|firebase\.messaging/.test(js + html));
    assert.ok(!/private_key|client_email|BEGIN (RSA )?PRIVATE KEY|serviceAccount|FIREBASE_SERVICE_ACCOUNT|BROADCAST_PIN|SETUP_KEY/i.test(js + html));
    assert.ok(!/\b[a-f0-9]{64}\b/.test(js + html)); });
  await check('الجلسة SESSION (تنتهي بإغلاق المتصفح) + anti-iframe + noindex + no-referrer', async () => {
    assert.match(jsNoComments, /Persistence\.SESSION/); assert.match(jsNoComments, /window\.top !== window\.self/);
    assert.match(html, /name="robots" content="noindex/); assert.match(html, /name="referrer" content="no-referrer"/); });
  await check('حقل كلمة السر type=password + autocomplete مناسب (current-password للدخول، new-password للتاجر)', async () => {
    assert.match(html, /id="login-password"[^>]*type="password"[^>]*autocomplete="current-password"|id="login-password" type="password"[^>]*autocomplete="current-password"/);
    assert.match(html, /id="f-password" type="password"[^>]*autocomplete="new-password"/); });
  await check('تطبيق التاجر (index.html/sw.js) ما كيحمّلش لوحة الأدمن ولا كيستدعي API الأدمن', async () => {
    const idx = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'); const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
    for (const s of [idx, sw]) assert.ok(!/admin\.js|admin\.html|admin-merchants|setup-store/.test(s)); });

  console.log(`\n${pass} ناجح، ${fail} فاشل`);
  process.exit(fail ? 1 : 0);
})();
