/**
 * tests/security-fixes.test.js
 * -------------------------------------------------------------------------
 * اختبارات الإصلاحات الأمنية الأخيرة. تشتغل بدون شبكة ولا Firebase: نستبدل
 * firebase-admin بـ mock فالذاكرة، ونشغّل دوال الواجهة (submitPin, unregisterPushToken,
 * storeLogout) المستخرجة من index.html داخل vm بـ mocks.
 *   الاستعمال:  node tests/security-fixes.test.js
 * ⚠️ هذا لا يعوّض اختبار قواعد Firebase الحقيقي (tests/security-rules.test.js مع الـ emulator).
 * -------------------------------------------------------------------------
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
async function check(label, fn) {
  try { await fn(); pass++; console.log('  ✅ ' + label); }
  catch (e) { fail++; console.log('  ❌ ' + label + ' — ' + e.message); }
}

/* ---------- mock ديال firebase-admin ---------- */
let CURRENT;
function makeState(overrides = {}) {
  const st = {
    tokens: {}, db: {}, users: [], claims: {}, deleted: [], sent: [], revokedFlags: [],
    failCreate: null, failClaims: false, ...overrides
  };
  st.admin = {
    apps: [],
    initializeApp() { this.apps.push(1); },
    credential: { cert: (x) => x },
    auth: () => ({
      verifyIdToken: async (tok, checkRevoked) => {
        st.revokedFlags.push(checkRevoked);
        if (!st.tokens[tok]) throw new Error('invalid token');
        return st.tokens[tok];
      },
      createUser: async ({ email, password, displayName }) => {
        if (st.failCreate) { const e = new Error('x'); e.code = st.failCreate; throw e; }
        const u = { uid: 'uid_' + (st.users.length + 1), email, password, displayName };
        st.users.push(u); return u;
      },
      // api/setup-store.js كيتحقق أن storeId غير مستعمل (claims الحسابات الموجودة) قبل الإنشاء
      listUsers: async () => ({ users: st.users.map((u) => ({ uid: u.uid, customClaims: st.claims[u.uid] })), pageToken: undefined }),
      setCustomUserClaims: async (uid, claims) => {
        if (st.failClaims) throw new Error('claims failed');
        st.claims[uid] = claims;
      },
      deleteUser: async (uid) => { st.deleted.push(uid); }
    }),
    database: () => ({
      ref: (p) => ({
        once: async () => ({ val: () => (st.db[p] === undefined ? null : st.db[p]) }),
        transaction: async (fn) => { st.db[p] = fn(st.db[p] === undefined ? null : st.db[p]); },
        remove: async () => { delete st.db[p]; }
      })
    }),
    messaging: () => ({
      sendEachForMulticast: async (m) => {
        st.sent.push(m);
        return { successCount: m.tokens.length, failureCount: 0, responses: m.tokens.map(() => ({ success: true })) };
      }
    })
  };
  return st;
}
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'firebase-admin') return CURRENT.admin;
  return origLoad.call(this, request, ...rest);
};
function loadHandler(file, st, env) {
  CURRENT = st;
  process.env.FIREBASE_SERVICE_ACCOUNT = '{"project_id":"test"}';
  process.env.FIREBASE_DATABASE_URL = 'https://test-default-rtdb.firebaseio.com';
  for (const k of ['BROADCAST_PIN', 'SETUP_KEY']) delete process.env[k];
  Object.assign(process.env, env || {});
  const full = require.resolve(path.join(ROOT, file));
  delete require.cache[full];
  return require(full);
}
function mkRes() {
  return { statusCode: null, headers: {}, body: null,
    setHeader(k, v) { this.headers[k] = v; }, status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; }, end() { return this; } };
}
const req = (o) => ({ method: 'POST', headers: {}, body: {}, ...o });
const bearer = (t) => ({ authorization: 'Bearer ' + t });
const GOOD_PIN = 'correct-horse-9271';

/* ---------- api/send-to-all.js ---------- */
async function testSendToAll() {
  console.log('\n== api/send-to-all.js ==');
  const mk = (extra = {}) => {
    const st = makeState({
      tokens: { tA: { uid: 'uA', storeId: 'store_a' }, tSys: { uid: 'uS', systemAdmin: true } },
      db: { 'stores/store_a/fcmTokens': { devA1: {}, devA2: {} }, 'stores/store_b/fcmTokens': { devB1: {} } }, ...extra });
    return { st, h: loadHandler('api/send-to-all.js', st, { BROADCAST_PIN: GOOD_PIN }) };
  };
  const call = async (h, r) => { const res = mkRes(); await h(r, res); return res; };

  await check('GET يُرفض (405)', async () => { const { h } = mk(); assert.equal((await call(h, req({ method: 'GET' }))).statusCode, 405); });
  await check('بدون Authorization => 401', async () => { const { h } = mk(); assert.equal((await call(h, req({}))).statusCode, 401); });
  await check('توكن غير صالح => 401', async () => { const { h } = mk(); assert.equal((await call(h, req({ headers: bearer('nope') }))).statusCode, 401); });
  await check('verifyIdToken كيتستدعى مع checkRevoked=true', async () => {
    const { h, st } = mk(); await call(h, req({ headers: bearer('tA'), body: { pin: GOOD_PIN, verifyOnly: true } }));
    assert.ok(st.revokedFlags.length && st.revokedFlags.every(f => f === true)); });
  await check('حساب بلا storeId (مثلاً System Admin) => 403 وما كيتبعث والو', async () => {
    const { h, st } = mk(); const r = await call(h, req({ headers: bearer('tSys'), body: { title: 't', body: 'b', pin: GOOD_PIN } }));
    assert.equal(r.statusCode, 403); assert.equal(st.sent.length, 0); });
  await check('BROADCAST_PIN مفقود => 503 (fail-closed) وما كيتبعث والو', async () => {
    const st = makeState({ tokens: { tA: { uid: 'uA', storeId: 'store_a' } }, db: { 'stores/store_a/fcmTokens': { d1: {} } } });
    const h = loadHandler('api/send-to-all.js', st, {});
    const r = await call(h, req({ headers: bearer('tA'), body: { title: 't', body: 'b', pin: 'anything-long' } }));
    assert.equal(r.statusCode, 503); assert.equal(st.sent.length, 0); });
  await check('BROADCAST_PIN أقصر من 8 خانات => 503', async () => {
    const st = makeState({ tokens: { tA: { uid: 'uA', storeId: 'store_a' } } });
    const h = loadHandler('api/send-to-all.js', st, { BROADCAST_PIN: '1234' });
    assert.equal((await call(h, req({ headers: bearer('tA'), body: { title: 't', body: 'b', pin: '1234' } }))).statusCode, 503); });
  await check('رمز خاطئ => 403 وما كيتبعث والو', async () => {
    const { h, st } = mk(); const r = await call(h, req({ headers: bearer('tA'), body: { title: 't', body: 'b', pin: 'wrong-pin-000' } }));
    assert.equal(r.statusCode, 403); assert.equal(st.sent.length, 0); });
  await check('الطريقة القديمة (pinHash بلا pin) ما بقاتش خدامة => 403', async () => {
    const { h, st } = mk(); const oldStyle = 'a'.repeat(64);
    const r = await call(h, req({ headers: bearer('tA'), body: { title: 't', body: 'b', pinHash: oldStyle } }));
    assert.equal(r.statusCode, 403); assert.equal(st.sent.length, 0); });
  await check('إرسال الـ hash كأنه pin => 403', async () => {
    const { h } = mk(); const r = await call(h, req({ headers: bearer('tA'), body: { title: 't', body: 'b', pin: 'a'.repeat(64) } }));
    assert.equal(r.statusCode, 403); });
  await check('الرمز الصحيح + verifyOnly => 200 {ok:true} بلا إرسال', async () => {
    const { h, st } = mk(); const r = await call(h, req({ headers: bearer('tA'), body: { pin: GOOD_PIN, verifyOnly: true } }));
    assert.equal(r.statusCode, 200); assert.deepEqual(r.body, { ok: true }); assert.equal(st.sent.length, 0); });
  await check('الرمز الصحيح => يبعث فقط لتوكنات متجر الـ claim (storeId فالـ body مهمل)', async () => {
    const { h, st } = mk(); const r = await call(h, req({ headers: bearer('tA'), body: { title: 't', body: 'b', pin: GOOD_PIN, storeId: 'store_b' } }));
    assert.equal(r.statusCode, 200); assert.equal(st.sent.length, 1);
    assert.deepEqual(st.sent[0].tokens.sort(), ['devA1', 'devA2']); assert.ok(!st.sent[0].tokens.includes('devB1')); });
  await check('5 محاولات خاطئة => المحاولة السادسة مقفولة (429) حتى بالرمز الصحيح', async () => {
    const { h, st } = mk();
    for (let i = 0; i < 5; i++) assert.equal((await call(h, req({ headers: bearer('tA'), body: { pin: 'bad-pin-' + i + 'xx' } }))).statusCode, 403);
    const r = await call(h, req({ headers: bearer('tA'), body: { title: 't', body: 'b', pin: GOOD_PIN } }));
    assert.equal(r.statusCode, 429); assert.ok(r.headers['Retry-After']); assert.equal(st.sent.length, 0); });
  await check('القفل خاص بالحساب (حساب آخر ما يتأثرش)', async () => {
    const st = makeState({ tokens: { tA: { uid: 'uA', storeId: 'store_a' }, tB: { uid: 'uB', storeId: 'store_b' } },
      db: { 'stores/store_b/fcmTokens': { devB1: {} } } });
    const h = loadHandler('api/send-to-all.js', st, { BROADCAST_PIN: GOOD_PIN });
    for (let i = 0; i < 5; i++) await call(h, req({ headers: bearer('tA'), body: { pin: 'bad-pin-' + i + 'xx' } }));
    const r = await call(h, req({ headers: bearer('tB'), body: { title: 't', body: 'b', pin: GOOD_PIN } }));
    assert.equal(r.statusCode, 200); });
  await check('الرمز الصحيح كيصفّر عدّاد الأخطاء', async () => {
    const { h, st } = mk();
    for (let i = 0; i < 3; i++) await call(h, req({ headers: bearer('tA'), body: { pin: 'bad-pin-' + i + 'xx' } }));
    await call(h, req({ headers: bearer('tA'), body: { pin: GOOD_PIN, verifyOnly: true } }));
    assert.equal(st.db['_security/broadcast/uA'], undefined); });
  await check('المصدر ما فيهش ADMIN_PIN_HASH ولا hash من 64 hex ولا قراءة pinHash', async () => {
    const src = fs.readFileSync(path.join(ROOT, 'api/send-to-all.js'), 'utf8');
    assert.ok(!/ADMIN_PIN_HASH/.test(src)); assert.ok(!/\b[a-f0-9]{64}\b/.test(src)); assert.ok(!/pinHash/.test(src)); });
}

/* ---------- api/setup-store.js ---------- */
async function testSetupStore() {
  console.log('\n== api/setup-store.js ==');
  const mk = (extra = {}, env = {}) => {
    const st = makeState({ tokens: {
      tSys: { uid: 'uS', systemAdmin: true }, tMerchant: { uid: 'uM', storeId: 'store_a' },
      tBoth: { uid: 'uB', systemAdmin: true, storeId: 'store_x' } }, ...extra });
    return { st, h: loadHandler('api/setup-store.js', st, env) };
  };
  const call = async (h, r) => { const res = mkRes(); await h(r, res); return res; };
  const good = { email: 'shop@example.com', password: 'S3cure-pass!', storeId: 'store_new' };

  await check('GET => 405 (لا مفتاح فالرابط ولا شيء)', async () => {
    const { h } = mk({}, { SETUP_KEY: 'legacy' }); const r = await call(h, req({ method: 'GET', query: { key: 'legacy', ...good } }));
    assert.equal(r.statusCode, 405); assert.equal(r.headers.Allow, 'POST'); });
  await check('SETUP_KEY القديم ما بقى يفتح شيء (POST بلا توكن => 401)', async () => {
    const { h, st } = mk({}, { SETUP_KEY: 'legacy' }); const r = await call(h, req({ query: { key: 'legacy' }, body: good }));
    assert.equal(r.statusCode, 401); assert.equal(st.users.length, 0); });
  await check('توكن غير صالح => 401', async () => { const { h } = mk(); assert.equal((await call(h, req({ headers: bearer('bad'), body: good }))).statusCode, 401); });
  await check('حساب تاجر (storeId بلا systemAdmin) => 403 وما كيتنشأ حساب', async () => {
    const { h, st } = mk(); const r = await call(h, req({ headers: bearer('tMerchant'), body: good }));
    assert.equal(r.statusCode, 403); assert.equal(st.users.length, 0); });
  await check('System Admin => 200 وclaims = { storeId } فقط', async () => {
    const { h, st } = mk(); const r = await call(h, req({ headers: bearer('tSys'), body: good }));
    assert.equal(r.statusCode, 200); assert.deepEqual(st.claims['uid_1'], { storeId: 'store_new' });
    assert.ok(!('systemAdmin' in st.claims['uid_1'])); });
  await check('الرد ما فيه كلمة السر أبدًا', async () => {
    const { h } = mk(); const r = await call(h, req({ headers: bearer('tSys'), body: good }));
    assert.ok(!JSON.stringify(r.body).includes(good.password)); assert.ok(!('password' in r.body)); });
  await check('Cache-Control: no-store', async () => { const { h } = mk(); assert.equal((await call(h, req({ headers: bearer('tSys'), body: good }))).headers['Cache-Control'], 'no-store'); });
  await check('storeId غير صالح (../x, أحرف كبيرة, فراغ, طويل, non-string) => 400', async () => {
    for (const bad of ['../x', 'Store_A', 'a b', 'a/b', 'x'.repeat(65), '', 123, null]) {
      const { h, st } = mk(); const r = await call(h, req({ headers: bearer('tSys'), body: { ...good, storeId: bad } }));
      assert.equal(r.statusCode, 400, 'storeId=' + JSON.stringify(bad)); assert.equal(st.users.length, 0); } });
  await check('بريد غير صالح أو كلمة سر قصيرة => 400', async () => {
    for (const b of [{ ...good, email: 'nope' }, { ...good, password: 'short' }, { ...good, email: 5 }, { ...good, password: ['x'.repeat(9)] }]) {
      const { h } = mk(); assert.equal((await call(h, req({ headers: bearer('tSys'), body: b }))).statusCode, 400); } });
  await check('بريد موجود => 409', async () => { const { h } = mk({ failCreate: 'auth/email-already-exists' });
    assert.equal((await call(h, req({ headers: bearer('tSys'), body: good }))).statusCode, 409); });
  await check('فشل ضبط الـ claim => يُحذف الحساب الجديد (ما يبقاش حساب بلا متجر) => 500', async () => {
    const { h, st } = mk({ failClaims: true }); const r = await call(h, req({ headers: bearer('tSys'), body: good }));
    assert.equal(r.statusCode, 500); assert.deepEqual(st.deleted, ['uid_1']); });
  await check('المصدر ما فيه أي استعمال لـ SETUP_KEY ولا req.query', async () => {
    const src = fs.readFileSync(path.join(ROOT, 'api/setup-store.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.ok(!/process\.env\.SETUP_KEY/.test(src)); assert.ok(!/req\.query/.test(src)); assert.ok(!/Access-Control-Allow-Origin/.test(src)); });
}

/* ---------- الواجهة: index.html / sw.js ---------- */
function extractFunction(src, name) {
  const start = src.search(new RegExp('(async\\s+)?function\\s+' + name + '\\s*\\('));
  assert.ok(start >= 0, 'function ' + name + ' not found');
  let i = src.indexOf('{', start), depth = 0;
  for (let j = i; j < src.length; j++) { if (src[j] === '{') depth++; else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(start, j + 1); } }
  throw new Error('unbalanced braces for ' + name);
}
async function testClient() {
  console.log('\n== الواجهة (index.html / sw.js) ==');
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');

  await check('لا ADMIN_PIN_HASH / pinHash / sha256Hex فالواجهة', async () => {
    assert.ok(!/ADMIN_PIN_HASH|pinHash|sha256Hex/.test(html)); });
  await check('لا أي hash من 64 hex فـ index.html ولا sw.js', async () => {
    assert.ok(!/\b[a-f0-9]{64}\b/.test(html)); assert.ok(!/\b[a-f0-9]{64}\b/.test(sw)); });
  await check('لا service account ولا private key فالواجهة', async () => {
    for (const s of [html, sw]) assert.ok(!/private_key|client_email|BEGIN (RSA )?PRIVATE KEY|serviceAccount/i.test(s)); });
  await check('لا كود تسجيل ذاتي فالواجهة (createUserWithEmailAndPassword)', async () => {
    assert.ok(!/createUserWithEmailAndPassword|signInAnonymously/.test(html)); });

  const mkCtx = (o = {}) => {
    const calls = [];
    const ctx = {
      console: { error() {}, log() {} }, calls, setTimeout, Promise,
      FCM_VAPID_KEY: 'VAPID', currentStoreId: 'store_a', currentUser: { getIdToken: async () => 'IDTOKEN' },
      isAdmin: false, BROADCAST_ENDPOINT: 'https://x/api/send-to-all',
      Notification: { permission: o.permission || 'granted' },
      navigator: { serviceWorker: { getRegistration: async () => (o.noReg ? null : { scope: 'sw' }) } },
      messaging: o.noMessaging ? null : {
        getToken: async () => { calls.push('getToken'); return 'TOKEN123'; },
        deleteToken: async () => { calls.push('deleteToken'); return true; } },
      storeRef: (p) => ({ remove: async () => { calls.push('remove:' + p); if (o.removeFails) throw new Error('offline'); } }),
      auth: { signOut: async () => { calls.push('signOut'); } },
      localStorage: { removeItem: (k) => calls.push('ls.remove:' + k), setItem: (k, v) => calls.push('ls.set:' + k + '=' + v), getItem: () => null },
      location: { reload: () => calls.push('reload') },
      alert() {}, document: { getElementById: () => ({ value: '', textContent: '', focus() {}, style: {} }) },
      closePinDialog: () => calls.push('closePinDialog'), updateAdminUI: () => calls.push('updateAdminUI'),
      fetch: o.fetch
    };
    return vm.createContext(ctx);
  };
  const load = (ctx, names) => names.forEach(n => vm.runInContext(extractFunction(html, n), ctx));

  await check('storeLogout: مسح التوكن من المتجر ثم deleteToken ثم signOut (بهاد الترتيب)', async () => {
    const ctx = mkCtx(); load(ctx, ['unregisterPushToken', 'storeLogout']); await vm.runInContext('storeLogout()', ctx);
    assert.deepEqual(ctx.calls.filter(c => !c.startsWith('ls.')), ['getToken', 'remove:fcmTokens/TOKEN123', 'deleteToken', 'signOut', 'reload']); });
  await check('storeLogout: حتى لو فشل مسح RTDB كيتبطّل التوكن ويتم الخروج', async () => {
    const ctx = mkCtx({ removeFails: true }); load(ctx, ['unregisterPushToken', 'storeLogout']); await vm.runInContext('storeLogout()', ctx);
    assert.ok(ctx.calls.includes('deleteToken')); assert.ok(ctx.calls.includes('signOut')); assert.ok(ctx.calls.indexOf('deleteToken') < ctx.calls.indexOf('signOut')); });
  await check('storeLogout: بلا إذن إشعارات => ما كيطلبش إذن، كيبطّل التوكن فقط ويخرج', async () => {
    const ctx = mkCtx({ permission: 'default' }); load(ctx, ['unregisterPushToken', 'storeLogout']); await vm.runInContext('storeLogout()', ctx);
    assert.ok(!ctx.calls.includes('getToken')); assert.ok(!ctx.calls.some(c => c.startsWith('remove:'))); assert.ok(ctx.calls.includes('signOut')); });
  await check('storeLogout: بلا Messaging => الخروج يمر عادي', async () => {
    const ctx = mkCtx({ noMessaging: true }); load(ctx, ['unregisterPushToken', 'storeLogout']); await vm.runInContext('storeLogout()', ctx);
    assert.ok(ctx.calls.includes('signOut')); });
  await check('تبديل المتجر: ترتيب الكود deleteToken < loadAll() < registerPushToken()', async () => {
    const i0 = html.indexOf('auth.onAuthStateChanged('); const seg = html.slice(i0, i0 + 2500);
    const a = seg.indexOf('messaging.deleteToken()'), b = seg.indexOf('loadAll()'), c = seg.indexOf('registerPushToken()');
    assert.ok(a > 0 && b > a && c > b, `order deleteToken=${a} loadAll=${b} register=${c}`); });

  await check('submitPin: كيبعث pin خام + verifyOnly للسيرفر (ماشي hash) وكيفتح وضع المسؤول عند 200', async () => {
    let sent; const ctx = mkCtx({ fetch: async (u, o) => { sent = { u, o }; return { ok: true, status: 200 }; } });
    ctx.document.getElementById = () => ({ value: 'my-secret-pin', textContent: '', focus() {}, style: {} });
    load(ctx, ['submitPin']); await vm.runInContext('submitPin()', ctx);
    const body = JSON.parse(sent.o.body); assert.equal(body.pin, 'my-secret-pin'); assert.equal(body.verifyOnly, true);
    assert.ok(!('pinHash' in body)); assert.equal(sent.o.headers.Authorization, 'Bearer IDTOKEN');
    assert.equal(vm.runInContext('isAdmin', ctx), true); });
  await check('submitPin: 403 => ما كيفتحش وضع المسؤول', async () => {
    const ctx = mkCtx({ fetch: async () => ({ ok: false, status: 403 }) });
    ctx.document.getElementById = () => ({ value: 'wrong', textContent: '', focus() {}, style: {} });
    load(ctx, ['submitPin']); await vm.runInContext('submitPin()', ctx); assert.equal(vm.runInContext('isAdmin', ctx), false); });
  await check('submitPin: خطأ شبكة => ما كيفتحش وضع المسؤول', async () => {
    const ctx = mkCtx({ fetch: async () => { throw new Error('net'); } });
    ctx.document.getElementById = () => ({ value: 'x', textContent: '', focus() {}, style: {} });
    load(ctx, ['submitPin']); await vm.runInContext('submitPin()', ctx); assert.equal(vm.runInContext('isAdmin', ctx), false); });
}

(async () => {
  await testSendToAll(); await testSetupStore(); await testClient();
  Module._load = origLoad;
  console.log(`\n${pass} ناجح، ${fail} فاشل`);
  process.exit(fail ? 1 : 0);
})();
