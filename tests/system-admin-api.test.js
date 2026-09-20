/**
 * tests/system-admin-api.test.js
 * -------------------------------------------------------------------------
 * اختبارات api/setup-store.js (النسخة الجديدة) و api/admin-merchants.js.
 * تشتغل بدون شبكة ولا Firebase: firebase-admin مستبدل بـ mock فالذاكرة (حسابات + claims + disabled
 * + ترقيم صفحات listUsers).   الاستعمال:  node tests/system-admin-api.test.js
 * ⚠️ هذا لا يعوّض التجربة الحقيقية على Firebase (Auth الحقيقي هو اللي يفرض checkRevoked/disabled).
 * -------------------------------------------------------------------------
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
async function check(label, fn) {
  try { await fn(); pass++; console.log('  ✅ ' + label); }
  catch (e) { fail++; console.log('  ❌ ' + label + ' — ' + e.message); }
}

/* ---------- mock ديال firebase-admin ---------- */
let CURRENT;
function makeState(o = {}) {
  const st = {
    tokens: {
      tSys: { uid: 'uSys', systemAdmin: true },
      tSysStr: { uid: 'uSysStr', systemAdmin: 'true' },          // ماشي boolean => يجب أن يُرفض
      tMerchant: { uid: 'uMer', storeId: 'store_a' },
      tBoth: { uid: 'uBoth', systemAdmin: true, storeId: 'store_x' }
    },
    users: new Map(),          // uid -> user record (كيما كيرجّعها Admin SDK)
    dbTaken: 0,                // كم مرة يرجّع stores/{id} أنه فيه بيانات (لاختبار إعادة المحاولة)
    dbData: {},                // path -> value
    pageSize: 2,               // صغير باش نختبروا الترقيم
    calls: [], verifyFlags: [], failList: false, failCreate: null, failClaims: false, failUpdate: false,
    seq: 0, ...o
  };
  const add = (u) => st.users.set(u.uid, {
    disabled: false, metadata: { creationTime: 'Mon, 01 Sep 2026 00:00:00 GMT', lastSignInTime: null },
    providerData: [{ providerId: 'password' }], passwordHash: 'HASH', passwordSalt: 'SALT', tokensValidAfterTime: 'x', ...u });
  st.add = add;
  st.admin = {
    apps: [], initializeApp() { this.apps.push(1); }, credential: { cert: (x) => x },
    auth: () => ({
      verifyIdToken: async (t, rev) => { st.verifyFlags.push(rev); if (!st.tokens[t]) throw new Error('invalid'); return st.tokens[t]; },
      listUsers: async (max, pageToken) => {
        if (st.failList) throw Object.assign(new Error('list boom'), { code: 'auth/internal-error' });
        const all = [...st.users.values()];
        const start = pageToken ? Number(pageToken) : 0;
        const slice = all.slice(start, start + st.pageSize);
        st.calls.push(['listUsers', start]);
        return { users: slice, pageToken: start + st.pageSize < all.length ? String(start + st.pageSize) : undefined };
      },
      getUser: async (uid) => {
        const u = st.users.get(uid);
        if (!u) throw Object.assign(new Error('nf'), { code: 'auth/user-not-found' });
        return u;
      },
      updateUser: async (uid, p) => { st.calls.push(['updateUser', uid, p]); if (st.failUpdate) throw new Error('boom'); Object.assign(st.users.get(uid), p); },
      revokeRefreshTokens: async (uid) => { st.calls.push(['revoke', uid]); },
      createUser: async (p) => {
        st.calls.push(['createUser', { ...p, password: p.password ? '<pw>' : undefined }]);
        if (st.failCreate) throw Object.assign(new Error('x'), { code: st.failCreate });
        const uid = 'new' + (++st.seq);
        add({ uid, email: p.email, displayName: p.displayName, customClaims: {} });
        return st.users.get(uid);
      },
      setCustomUserClaims: async (uid, c) => { st.calls.push(['claims', uid, c]); if (st.failClaims) throw new Error('claims boom'); st.users.get(uid).customClaims = c; },
      deleteUser: async (uid) => { st.calls.push(['deleteUser', uid]); st.users.delete(uid); }
    }),
    database: () => ({ ref: (p) => ({ once: async () => {
      st.calls.push(['dbOnce', p]);
      if (st.dbTaken > 0) { st.dbTaken--; return { val: () => ({ x: 1 }) }; }
      return { val: () => (st.dbData[p] === undefined ? null : st.dbData[p]) };
    } }) })
  };
  return st;
}
const origLoad = Module._load;
Module._load = function (request, ...rest) { return request === 'firebase-admin' ? CURRENT.admin : origLoad.call(this, request, ...rest); };
function load(file, st) {
  CURRENT = st;
  process.env.FIREBASE_SERVICE_ACCOUNT = '{"project_id":"test"}';
  process.env.FIREBASE_DATABASE_URL = 'https://test-default-rtdb.firebaseio.com';
  const full = require.resolve(path.join(ROOT, file));
  delete require.cache[full];
  return require(full);
}
const mkRes = () => ({ statusCode: null, headers: {}, body: null,
  setHeader(k, v) { this.headers[k] = v; }, status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; return this; } });
const req = (o) => ({ method: 'POST', headers: {}, body: {}, ...o });
const bearer = (t) => ({ authorization: 'Bearer ' + t });
const call = async (h, r) => { const res = mkRes(); await h(r, res); return res; };
function spyConsole() {
  const lines = []; const o = { error: console.error, log: console.log, warn: console.warn };
  console.error = console.log = console.warn = (...a) => lines.push(a.map((x) => (x instanceof Error ? x.stack + x.message : typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
  return { lines, restore() { Object.assign(console, o); } };
}
const seedMerchants = (st) => {
  st.add({ uid: 'uMer', email: 'a@example.com', displayName: 'متجر أ', customClaims: { storeId: 'store_a' },
    metadata: { creationTime: 'Tue, 02 Sep 2026 00:00:00 GMT', lastSignInTime: 'Wed, 03 Sep 2026 00:00:00 GMT' } });
  st.add({ uid: 'uOff', email: 'b@example.com', customClaims: { storeId: 'store_b' }, disabled: true,
    metadata: { creationTime: 'Thu, 04 Sep 2026 00:00:00 GMT', lastSignInTime: null } });
  st.add({ uid: 'uSys', email: 'admin@example.com', customClaims: { systemAdmin: true } });
  st.add({ uid: 'uNoClaims', email: 'plain@example.com', customClaims: undefined });
  st.add({ uid: 'uOld', email: 'old@example.com', customClaims: { storeId: 'store_old' },
    metadata: { creationTime: 'Mon, 01 Sep 2026 00:00:00 GMT', lastSignInTime: null } });
};

/* ================= api/admin-merchants.js ================= */
async function testAdminMerchants() {
  console.log('\n== api/admin-merchants.js ==');
  const mk = (extra) => { const st = makeState(extra); seedMerchants(st); return { st, h: load('api/admin-merchants.js', st) }; };
  const sys = (body) => req({ headers: bearer('tSys'), body });

  await check('GET => 405 + Allow: POST', async () => { const { h } = mk(); const r = await call(h, req({ method: 'GET' })); assert.equal(r.statusCode, 405); assert.equal(r.headers.Allow, 'POST'); });
  await check('no-store وبلا CORS', async () => { const { h } = mk(); const r = await call(h, sys({ action: 'list' })); assert.equal(r.headers['Cache-Control'], 'no-store'); assert.ok(!Object.keys(r.headers).some((k) => /access-control/i.test(k))); });
  await check('بلا Authorization => 401 وما كيتنفذ والو', async () => { const { h, st } = mk(); assert.equal((await call(h, req({ body: { action: 'list' } }))).statusCode, 401); assert.equal(st.calls.length, 0); });
  await check('توكن غير صالح => 401', async () => { const { h } = mk(); assert.equal((await call(h, req({ headers: bearer('nope'), body: { action: 'list' } }))).statusCode, 401); });
  await check('verifyIdToken مع checkRevoked=true', async () => { const { h, st } = mk(); await call(h, sys({ action: 'list' })); assert.deepEqual(st.verifyFlags, [true]); });
  await check('تاجر (storeId بلا systemAdmin) => 403 للقائمة والتعطيل', async () => {
    const { h, st } = mk();
    for (const body of [{ action: 'list' }, { action: 'set-disabled', uid: 'uOff', disabled: false }]) {
      const r = await call(h, req({ headers: bearer('tMerchant'), body })); assert.equal(r.statusCode, 403); assert.ok(!r.body.merchants); }
    assert.ok(!st.calls.some((c) => c[0] === 'updateUser')); });
  await check('systemAdmin ليس boolean true (مثلاً "true") => 403', async () => { const { h } = mk(); assert.equal((await call(h, req({ headers: bearer('tSysStr'), body: { action: 'list' } }))).statusCode, 403); });

  await check('list: التجار فقط (بلا أدمن ولا حساب بلا storeId) مرتبين من الأحدث', async () => {
    const { h } = mk(); const r = await call(h, sys({ action: 'list' }));
    assert.equal(r.statusCode, 200);
    assert.deepEqual(r.body.merchants.map((m) => m.uid), ['uOff', 'uMer', 'uOld']); });
  await check('list: عدادات total/active/disabled صحيحة', async () => {
    const { h } = mk(); const r = await call(h, sys({ action: 'list' }));
    assert.deepEqual([r.body.total, r.body.active, r.body.disabled], [3, 2, 1]); });
  await check('list: whitelist فقط — لا passwordHash/passwordSalt/claims/providerData', async () => {
    const { h } = mk(); const r = await call(h, sys({ action: 'list' }));
    for (const m of r.body.merchants) assert.deepEqual(Object.keys(m).sort(), ['createdAt', 'disabled', 'email', 'lastSignInAt', 'name', 'storeId', 'uid']);
    const s = JSON.stringify(r.body); for (const bad of ['HASH', 'SALT', 'passwordHash', 'passwordSalt', 'providerData', 'customClaims', 'tokensValidAfter']) assert.ok(!s.includes(bad), bad); });
  await check('list: الحقول صحيحة (name/email/storeId/disabled)', async () => {
    const { h } = mk(); const r = await call(h, sys({ action: 'list' }));
    const a = r.body.merchants.find((m) => m.uid === 'uMer');
    assert.equal(a.name, 'متجر أ'); assert.equal(a.email, 'a@example.com'); assert.equal(a.storeId, 'store_a'); assert.equal(a.disabled, false);
    assert.equal(r.body.merchants.find((m) => m.uid === 'uOff').disabled, true); });
  await check('list: يجمع كل الصفحات (ترقيم)', async () => {
    const { h, st } = mk(); const r = await call(h, sys({ action: 'list' }));
    assert.ok(st.calls.filter((c) => c[0] === 'listUsers').length >= 3); assert.equal(r.body.total, 3); });
  await check('list: فشل Admin SDK => 500 برسالة عامة بلا تفاصيل', async () => {
    const { h } = mk({ failList: true }); const spy = spyConsole(); const r = await call(h, sys({ action: 'list' })); spy.restore();
    assert.equal(r.statusCode, 500); assert.ok(!JSON.stringify(r.body).includes('boom')); });

  await check('set-disabled: تعطيل => updateUser({disabled:true}) + revokeRefreshTokens', async () => {
    const { h, st } = mk(); const r = await call(h, sys({ action: 'set-disabled', uid: 'uMer', disabled: true }));
    assert.equal(r.statusCode, 200); assert.deepEqual(r.body, { ok: true, uid: 'uMer', disabled: true });
    assert.deepEqual(st.calls.filter((c) => c[0] === 'updateUser' || c[0] === 'revoke'), [['updateUser', 'uMer', { disabled: true }], ['revoke', 'uMer']]); });
  await check('set-disabled: تفعيل => updateUser({disabled:false}) بلا revoke', async () => {
    const { h, st } = mk(); const r = await call(h, sys({ action: 'set-disabled', uid: 'uOff', disabled: false }));
    assert.equal(r.statusCode, 200); assert.deepEqual(st.calls.filter((c) => c[0] === 'updateUser'), [['updateUser', 'uOff', { disabled: false }]]);
    assert.ok(!st.calls.some((c) => c[0] === 'revoke')); assert.equal(st.users.get('uOff').disabled, false); });
  await check('set-disabled: مدخلات غير صالحة => 400 وما كيتغير والو', async () => {
    const { h, st } = mk();
    for (const b of [{ disabled: true }, { uid: '../x', disabled: true }, { uid: 'a b', disabled: true }, { uid: 'x'.repeat(129), disabled: true },
      { uid: 'uMer', disabled: 'true' }, { uid: 'uMer' }, { uid: 5, disabled: true }, { uid: 'uMer', disabled: 1 }]) {
      assert.equal((await call(h, sys({ action: 'set-disabled', ...b }))).statusCode, 400, JSON.stringify(b)); }
    assert.ok(!st.calls.some((c) => c[0] === 'updateUser')); });
  await check('set-disabled: ما تقدرش تعطّل نفسك', async () => {
    const { h, st } = mk(); const r = await call(h, sys({ action: 'set-disabled', uid: 'uSys', disabled: true }));
    assert.equal(r.statusCode, 400); assert.ok(!st.calls.some((c) => c[0] === 'updateUser')); });
  await check('set-disabled: حساب غير موجود => 404', async () => { const { h } = mk(); assert.equal((await call(h, sys({ action: 'set-disabled', uid: 'ghost', disabled: true }))).statusCode, 404); });
  await check('set-disabled: حساب System Admin آخر => 403', async () => {
    const { h, st } = mk(); st.add({ uid: 'uSys2', email: 's2@example.com', customClaims: { systemAdmin: true } });
    const r = await call(h, sys({ action: 'set-disabled', uid: 'uSys2', disabled: true }));
    assert.equal(r.statusCode, 403); assert.ok(!st.calls.some((c) => c[0] === 'updateUser')); });
  await check('set-disabled: حساب بلا storeId => 403', async () => {
    const { h, st } = mk(); const r = await call(h, sys({ action: 'set-disabled', uid: 'uNoClaims', disabled: true }));
    assert.equal(r.statusCode, 403); assert.ok(!st.calls.some((c) => c[0] === 'updateUser')); });
  await check('set-disabled: فشل updateUser => 500 برسالة عامة', async () => {
    const { h } = mk({ failUpdate: true }); const spy = spyConsole(); const r = await call(h, sys({ action: 'set-disabled', uid: 'uMer', disabled: true })); spy.restore();
    assert.equal(r.statusCode, 500); assert.ok(!JSON.stringify(r.body).includes('boom')); });
  await check('action ناقص أو مجهول => 400', async () => {
    const { h } = mk(); for (const b of [{}, { action: 'delete-all' }, { action: 5 }]) assert.equal((await call(h, sys(b))).statusCode, 400); });
  await check('المصدر: بلا CORS ولا SETUP_KEY ولا req.query', async () => {
    const src = fs.readFileSync(path.join(ROOT, 'api/admin-merchants.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.ok(!/Access-Control-Allow/.test(src)); assert.ok(!/SETUP_KEY/.test(src)); assert.ok(!/req\.query/.test(src)); });
}

/* ================= api/setup-store.js (النسخة الجديدة) ================= */
async function testSetupStore() {
  console.log('\n== api/setup-store.js (إنشاء تاجر) ==');
  const mk = (extra) => { const st = makeState(extra); return { st, h: load('api/setup-store.js', st) }; };
  const good = { email: 'shop@example.com', password: 'S3cure-pass!', name: 'متجر الأمل' };
  const asSys = (body) => req({ headers: bearer('tSys'), body });

  await check('GET => 405، وبلا توكن => 401، وتاجر => 403، وsystemAdmin نصي => 403', async () => {
    const { h, st } = mk();
    assert.equal((await call(h, req({ method: 'GET' }))).statusCode, 405);
    assert.equal((await call(h, req({ body: good }))).statusCode, 401);
    assert.equal((await call(h, req({ headers: bearer('tMerchant'), body: good }))).statusCode, 403);
    assert.equal((await call(h, req({ headers: bearer('tSysStr'), body: good }))).statusCode, 403);
    assert.ok(!st.calls.some((c) => c[0] === 'createUser')); });
  await check('verifyIdToken مع checkRevoked=true', async () => { const { h, st } = mk(); await call(h, asSys(good)); assert.deepEqual(st.verifyFlags, [true]); });
  await check('بلا storeId => يتولّد تلقائيًا بصيغة store_ + 8 (a-z0-9)', async () => {
    const { h, st } = mk(); const r = await call(h, asSys(good));
    assert.equal(r.statusCode, 200); assert.match(r.body.storeId, /^store_[a-z0-9]{8}$/);
    assert.deepEqual(st.users.get(r.body.uid).customClaims, { storeId: r.body.storeId }); });
  await check('storeId التلقائي مختلف بين طلبين', async () => {
    const { h } = mk(); const a = await call(h, asSys(good)); const b = await call(h, asSys({ ...good, email: 'other@example.com' }));
    assert.notEqual(a.body.storeId, b.body.storeId); });
  await check('storeId مخصص => يُستعمل كما هو، وclaims = { storeId } فقط (لا systemAdmin)', async () => {
    const { h, st } = mk(); const r = await call(h, asSys({ ...good, storeId: 'my_shop_1' }));
    assert.equal(r.statusCode, 200); assert.equal(r.body.storeId, 'my_shop_1');
    const c = st.users.get(r.body.uid).customClaims; assert.deepEqual(c, { storeId: 'my_shop_1' }); assert.ok(!('systemAdmin' in c)); });
  await check('name يُحفظ كـ displayName (trim) ويرجع فالرد', async () => {
    const { h, st } = mk(); const r = await call(h, asSys({ ...good, name: '  متجر الأمل  ' }));
    assert.equal(r.body.name, 'متجر الأمل'); assert.equal(st.users.get(r.body.uid).displayName, 'متجر الأمل'); });
  await check('بلا name => يمرّ (اختياري) وname=null', async () => {
    const { h, st } = mk(); const { name, ...noName } = good; const r = await call(h, asSys(noName));
    assert.equal(r.statusCode, 200); assert.equal(r.body.name, null); assert.equal(st.users.get(r.body.uid).displayName, undefined); });
  await check('البريد يُحوَّل lowercase + trim', async () => {
    const { h, st } = mk(); const r = await call(h, asSys({ ...good, email: '  Shop@Example.COM ' }));
    assert.equal(r.body.email, 'shop@example.com'); assert.equal(st.users.get(r.body.uid).email, 'shop@example.com'); });
  await check('كلمة السر ما كترجعش أبدًا ولا كتتسجّل (نجاح وفشل)', async () => {
    const PW = 'Sup3r-Secret-Value!';
    const spy = spyConsole();
    try {
      const a = mk(); const ok = await call(a.h, asSys({ ...good, password: PW }));
      assert.ok(!JSON.stringify(ok.body).includes(PW)); assert.ok(!('password' in ok.body));
      const b = mk({ failClaims: true }); await call(b.h, asSys({ ...good, password: PW }));
      const c = mk({ failCreate: 'auth/internal-error' }); await call(c.h, asSys({ ...good, password: PW }));
      const d = mk({ failList: true }); await call(d.h, asSys({ ...good, password: PW }));
    } finally { spy.restore(); }
    assert.ok(!spy.lines.join('\n').includes(PW), 'كلمة السر ظهرت فالسجلات'); });
  await check('storeId مستعمل من حساب آخر (claim) => 409 وما كيتنشأ حساب', async () => {
    const { h, st } = mk(); st.add({ uid: 'uMer', email: 'a@example.com', customClaims: { storeId: 'taken_1' } });
    const r = await call(h, asSys({ ...good, storeId: 'taken_1' })); assert.equal(r.statusCode, 409); assert.ok(!st.calls.some((c) => c[0] === 'createUser')); });
  await check('storeId مستعمل فصفحة ثانية من listUsers => 409 (ترقيم)', async () => {
    const { h, st } = mk(); for (let i = 0; i < 4; i++) st.add({ uid: 'u' + i, email: i + '@e.com', customClaims: { storeId: 's' + i } });
    const r = await call(h, asSys({ ...good, storeId: 's3' })); assert.equal(r.statusCode, 409); });
  await check('storeId عندو بيانات فـ stores/{id} (بلا حساب) => 409', async () => {
    const { h, st } = mk({ dbData: { 'stores/orphan_1': { products: {} } } });
    const r = await call(h, asSys({ ...good, storeId: 'orphan_1' })); assert.equal(r.statusCode, 409); assert.ok(!st.calls.some((c) => c[0] === 'createUser')); });
  await check('توليد تلقائي: إذا المرشّح مستعمل يعيد المحاولة (حتى ينجح)', async () => {
    const { h, st } = mk({ dbTaken: 2 }); const r = await call(h, asSys(good));
    assert.equal(r.statusCode, 200); assert.equal(st.calls.filter((c) => c[0] === 'dbOnce').length, 3); });
  await check('توليد تلقائي: إذا كل المحاولات (5) مستعملة => 500 وما كيتنشأ حساب', async () => {
    const { h, st } = mk({ dbTaken: 99 }); const spy = spyConsole(); const r = await call(h, asSys(good)); spy.restore();
    assert.equal(r.statusCode, 500); assert.ok(!st.calls.some((c) => c[0] === 'createUser')); });
  await check('مدخلات غير صالحة => 400 وما كيتنشأ حساب', async () => {
    const bads = [{ email: 'nope' }, { email: 5 }, { email: undefined }, { password: 'short' }, { password: 'x'.repeat(129) }, { password: ['x'.repeat(9)] },
      { storeId: 'Store_A' }, { storeId: '../x' }, { storeId: '' }, { storeId: null }, { storeId: 'a'.repeat(65) },
      { name: '' }, { name: '   ' }, { name: 'x'.repeat(81) }, { name: 5 }];
    for (const b of bads) { const { h, st } = mk(); const r = await call(h, asSys({ ...good, ...b }));
      assert.equal(r.statusCode, 400, JSON.stringify(b)); assert.ok(!st.calls.some((c) => c[0] === 'createUser')); } });
  await check('بريد موجود => 409', async () => { const { h } = mk({ failCreate: 'auth/email-already-exists' }); assert.equal((await call(h, asSys(good))).statusCode, 409); });
  await check('فشل ضبط الـ claim => الحساب الجديد يُحذف => 500', async () => {
    const { h, st } = mk({ failClaims: true }); const spy = spyConsole(); const r = await call(h, asSys(good)); spy.restore();
    assert.equal(r.statusCode, 500); assert.equal(st.users.size, 0); assert.ok(st.calls.some((c) => c[0] === 'deleteUser')); });
  await check('Cache-Control: no-store وبلا CORS ولا SETUP_KEY فالمصدر', async () => {
    const { h } = mk(); const r = await call(h, asSys(good)); assert.equal(r.headers['Cache-Control'], 'no-store');
    const src = fs.readFileSync(path.join(ROOT, 'api/setup-store.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.ok(!/Access-Control-Allow/.test(src)); assert.ok(!/process\.env\.SETUP_KEY/.test(src)); assert.ok(!/req\.query/.test(src)); });
}

(async () => {
  await testAdminMerchants(); await testSetupStore();
  Module._load = origLoad;
  console.log(`\n${pass} ناجح، ${fail} فاشل`);
  process.exit(fail ? 1 : 0);
})();
