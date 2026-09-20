'use strict';
/* =============================================================================
   admin.js — لوحة System Admin (TajirApp)
   -----------------------------------------------------------------------------
   الأمان (مهم):
   - الحماية الفعلية والنهائية فالسيرفر: كل طلب كيمشي لـ /api/admin-merchants أو /api/setup-store
     مع Firebase ID Token، والسيرفر كيتحقق منه (checkRevoked) ويشترط systemAdmin === true.
     أي تحقق فهاد الملف (getIdTokenResult) هو فقط لتحسين تجربة الاستعمال، وما كيعطي حتى صلاحية.
   - لا نخزّن كلمة سر التاجر ولا كلمة سر الأدمن فأي تخزين محلي أو قاعدة بيانات. كلمة سر التاجر
     الجديدة كتبقى فقط فحقل النموذج، وبعد النجاح كتظهر مرة وحدة فبطاقة مؤقتة (كتتمسح بعد دقيقتين
     أو بالضغط على "تم" أو عند الخروج).
   - ما كنستعملوش innerHTML أبدًا: كل النصوص (أسماء، بريد، storeId) كتتحط بـ textContent.
   - الواجهة ما كتلمس قاعدة البيانات مباشرة، فقط الـ API.
   الملف مقسوم لجزئين: (1) منطق صرف قابل للاختبار بدون متصفح، (2) ربط الواجهة (كيشتغل فالمتصفح فقط).
   ============================================================================= */

/* ============================ 1) منطق صرف ============================ */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const STORE_ID_RE = /^[a-z0-9_]{1,64}$/;
// أحرف بلا التباس (بلا 0/O ولا 1/l/I) باش تنقرا وتنكتب بسهولة من الهاتف
const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

class ApiError extends Error {
  constructor(status, data) {
    super(apiErrorMessage(status, data));
    this.name = 'ApiError';
    this.status = status;
    this.data = data || null;
  }
}

function apiErrorMessage(status, data) {
  if (status === 0) return 'تعذّر الاتصال بالسيرفر، تحقق من الإنترنت ثم أعد المحاولة';
  if (status === 401) return 'انتهت الجلسة، سجّل الدخول من جديد';
  if (data && typeof data.error === 'string' && data.error) return data.error;
  return 'حدث خطأ غير متوقع (' + status + ')';
}

function authErrorMessage(code) {
  switch (code) {
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
    case 'auth/user-not-found':
    case 'auth/invalid-email':
      return 'البريد أو كلمة السر غير صحيحة';
    case 'auth/too-many-requests':
      return 'محاولات كثيرة، انتظر قليلًا ثم أعد المحاولة';
    case 'auth/user-disabled':
      return 'هذا الحساب معطّل';
    case 'auth/network-request-failed':
      return 'تعذّر الاتصال بالإنترنت';
    default:
      return 'تعذّر تسجيل الدخول، أعد المحاولة';
  }
}

/* كلمة سر عشوائية قوية (16 خانة افتراضيًا) بـ crypto.getRandomValues + rejection sampling
   (بلا انحياز modulo)، وكتضمن وجود حرف كبير وصغير ورقم. getRandomValues قابلة للحقن للاختبار. */
function generatePassword(length, getRandomValues) {
  const len = length || 16;
  const fill = getRandomValues || ((arr) => globalThis.crypto.getRandomValues(arr));
  const n = PASSWORD_ALPHABET.length;
  const limit = 256 - (256 % n);
  for (let attempt = 0; attempt < 50; attempt++) {
    let out = '';
    while (out.length < len) {
      const buf = new Uint8Array(len * 2);
      fill(buf);
      for (let i = 0; i < buf.length && out.length < len; i++) {
        if (buf[i] < limit) out += PASSWORD_ALPHABET[buf[i] % n];
      }
    }
    if (/[A-Z]/.test(out) && /[a-z]/.test(out) && /[0-9]/.test(out)) return out;
  }
  throw new Error('password generation failed');
}

/* نفس قواعد السيرفر (api/setup-store.js). name مطلوب فالواجهة، storeId اختياري. */
function validateMerchantForm(input) {
  const src = input || {};
  const errors = {};
  const name = String(src.name == null ? '' : src.name).trim();
  const email = String(src.email == null ? '' : src.email).trim().toLowerCase();
  const password = String(src.password == null ? '' : src.password);
  const storeId = String(src.storeId == null ? '' : src.storeId).trim().toLowerCase();

  if (!name) errors.name = 'اكتب اسم التاجر';
  else if (name.length > 80) errors.name = 'الاسم أطول من 80 حرفًا';

  if (!email) errors.email = 'اكتب البريد الإلكتروني';
  else if (email.length > 254 || !EMAIL_RE.test(email)) errors.email = 'البريد الإلكتروني غير صالح';

  if (password.length < 8) errors.password = 'كلمة السر 8 خانات على الأقل';
  else if (password.length > 128) errors.password = 'كلمة السر أطول من 128 خانة';

  if (storeId && !STORE_ID_RE.test(storeId)) {
    errors.storeId = 'حروف إنجليزية صغيرة وأرقام و _ فقط (حتى 64). اتركه فارغًا ليُولَّد تلقائيًا';
  }

  if (Object.keys(errors).length) return { ok: false, errors };
  const payload = { email, password, name };
  if (storeId) payload.storeId = storeId;
  return { ok: true, payload };
}

function statusOf(merchant) {
  return merchant && merchant.disabled ? 'disabled' : 'active';
}

function summarize(list) {
  const rows = Array.isArray(list) ? list : [];
  const disabled = rows.filter((m) => statusOf(m) === 'disabled').length;
  return { total: rows.length, active: rows.length - disabled, disabled };
}

function filterMerchants(list, opts) {
  const rows = Array.isArray(list) ? list : [];
  const o = opts || {};
  const q = String(o.query || '').trim().toLowerCase();
  const status = o.status || 'all';
  return rows.filter((m) => {
    if (status !== 'all' && statusOf(m) !== status) return false;
    if (!q) return true;
    return [m.name, m.email, m.storeId].some((v) => typeof v === 'string' && v.toLowerCase().includes(q));
  });
}

function formatDate(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (isNaN(d.getTime())) return '—';
  try {
    return d.toLocaleString('ar-u-nu-latn', { dateStyle: 'medium', timeStyle: 'short' });
  } catch (e) {
    return d.toISOString().slice(0, 16).replace('T', ' ');
  }
}

/* عميل الـ API: كيبعث ID Token فكل طلب (Authorization: Bearer)، POST فقط، نفس النطاق (بلا CORS). */
function createApiClient(opts) {
  const fetchFn = opts.fetchFn;
  const getToken = opts.getToken;
  const base = opts.base == null ? '/api' : opts.base;

  async function post(path, body) {
    let token = null;
    try { token = await getToken(); } catch (e) { token = null; }
    if (!token) throw new ApiError(401, null);
    let res;
    try {
      res = await fetchFn(base + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify(body),
        cache: 'no-store',
        credentials: 'omit',
        referrerPolicy: 'no-referrer'
      });
    } catch (e) {
      throw new ApiError(0, null);
    }
    let data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (!res.ok) throw new ApiError(res.status, data);
    return data || {};
  }

  return {
    listMerchants: () => post('/admin-merchants', { action: 'list' }),
    setDisabled: (uid, disabled) => post('/admin-merchants', { action: 'set-disabled', uid, disabled }),
    createMerchant: (payload) => post('/setup-store', payload)
  };
}

/* ============================ 2) ربط الواجهة (المتصفح فقط) ============================ */
const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyBQrCO1BOQ-0D9isZdTtbTUE4EK6vuGppA',
  authDomain: 'tajirapp-fe79d.firebaseapp.com',
  projectId: 'tajirapp-fe79d',
  appId: '1:790673886877:web:b58c57e4e70536efab4e74'
};
const CREATED_CARD_MS = 2 * 60 * 1000;

function initUi() {
  // ما نشتغلوش داخل iframe (حماية من clickjacking على مستوى الصفحة)
  if (window.top !== window.self) { document.body.textContent = ''; return; }

  const $ = (id) => document.getElementById(id);
  function h(tag, attrs) {
    const node = document.createElement(tag);
    const a = attrs || {};
    for (const key of Object.keys(a)) {
      const val = a[key];
      if (val == null || val === false) continue;
      if (key === 'class') node.className = val;
      else if (key.slice(0, 2) === 'on') node.addEventListener(key.slice(2), val);
      else node.setAttribute(key, val === true ? '' : val);
    }
    for (let i = 2; i < arguments.length; i++) {
      const kids = [].concat(arguments[i]);
      for (const kid of kids) {
        if (kid == null || kid === false) continue;
        node.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
      }
    }
    return node;
  }
  const show = (id, on) => { $(id).hidden = !on; };
  function showView(name) {
    show('view-boot', name === 'boot');
    show('view-login', name === 'login');
    show('view-panel', name === 'panel');
  }

  if (typeof firebase === 'undefined') {
    $('boot-msg').textContent = 'تعذّر تحميل Firebase. تحقق من الإنترنت ثم أعد فتح الصفحة.';
    return;
  }
  firebase.initializeApp(FIREBASE_CONFIG);
  const auth = firebase.auth();
  const api = createApiClient({
    fetchFn: (url, init) => fetch(url, init),
    getToken: () => (auth.currentUser ? auth.currentUser.getIdToken() : Promise.resolve(null))
  });

  const state = { merchants: [], query: '', status: 'all', busy: new Set(), notice: '', loaded: false };
  let created = null;
  let createdTimer = null;
  let toastTimer = null;

  /* ---------- رسائل ---------- */
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    clearTimeout(toastTimer);
    if (msg) toastTimer = setTimeout(() => { t.textContent = ''; }, 4500);
  }

  /* ---------- الدخول والخروج ---------- */
  function showLogin(notice) {
    showView('login');
    $('login-error').textContent = notice || '';
  }

  function clearSensitive() {
    hideCreated();
    $('add-form').reset();
    setPasswordVisible(false);
    for (const k of ['name', 'email', 'password', 'storeId']) setFieldError(k, '');
    $('form-msg').textContent = '';
    state.merchants = [];
    state.loaded = false;
    state.query = '';
    state.status = 'all';
    $('search').value = '';
    $('who').textContent = '';
    renderAll();
    toast('');
  }

  function forceLogout(message) {
    state.notice = message;
    auth.signOut().catch(() => { showLogin(message); });
  }

  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = $('login-email').value.trim();
    const pw = $('login-password').value;
    if (!email || !pw) { $('login-error').textContent = 'اكتب البريد وكلمة السر'; return; }
    $('login-error').textContent = '';
    $('login-submit').disabled = true;
    try {
      // الجلسة كتنتهي بإغلاق المتصفح (SESSION) — أنسب للوحة إدارة
      await auth.setPersistence(firebase.auth.Auth.Persistence.SESSION);
      await auth.signInWithEmailAndPassword(email, pw);
    } catch (err) {
      $('login-error').textContent = authErrorMessage(err && err.code);
    } finally {
      $('login-password').value = '';
      $('login-submit').disabled = false;
    }
  });

  $('btn-logout').addEventListener('click', () => { state.notice = ''; auth.signOut(); });

  auth.onAuthStateChanged(async (user) => {
    if (!user) {
      clearSensitive();
      const notice = state.notice;
      state.notice = '';
      showLogin(notice);
      return;
    }
    showView('boot');
    $('boot-msg').textContent = 'جارٍ التحقق من الصلاحية…';
    let ok = false;
    try {
      const tr = await user.getIdTokenResult(true);
      ok = tr.claims.systemAdmin === true; // للعرض فقط؛ السيرفر هو اللي يقرر
    } catch (e) {
      state.notice = 'تعذّر التحقق من الصلاحية، أعد المحاولة';
    }
    if (!ok) {
      if (!state.notice) state.notice = 'هذا الحساب ليس System Admin';
      try { await auth.signOut(); } catch (e) { showLogin(state.notice); }
      return;
    }
    $('who').textContent = user.email || '';
    showView('panel');
    await loadMerchants();
  });

  /* ---------- قائمة التجار ---------- */
  async function loadMerchants() {
    $('btn-refresh').disabled = true;
    $('list-error').textContent = '';
    try {
      const data = await api.listMerchants();
      state.merchants = Array.isArray(data.merchants) ? data.merchants : [];
      state.loaded = true;
    } catch (err) {
      if (err.status === 401) { forceLogout(err.message); return; }
      if (err.status === 403) { forceLogout('هذا الحساب ليس System Admin'); return; }
      $('list-error').textContent = err.message;
    } finally {
      $('btn-refresh').disabled = false;
    }
    renderAll();
  }

  function renderAll() {
    renderFilters();
    renderList();
    // النموذج مفتوح تلقائيًا إذا ما كاين حتى تاجر
    if (state.loaded && state.merchants.length === 0) $('add-box').open = true;
  }

  function renderFilters() {
    const s = summarize(state.merchants);
    const counts = { all: s.total, active: s.active, disabled: s.disabled };
    for (const btn of document.querySelectorAll('[data-filter]')) {
      const key = btn.getAttribute('data-filter');
      btn.setAttribute('aria-pressed', state.status === key ? 'true' : 'false');
      btn.querySelector('.count').textContent = String(counts[key]);
    }
  }

  function merchantRow(m) {
    const st = statusOf(m);
    const busy = state.busy.has(m.uid);
    const title = m.name || m.email || m.uid;
    return h('li', { class: 'row is-' + st, 'data-uid': m.uid },
      h('div', { class: 'row-head' },
        h('strong', { class: 'row-name' }, title),
        h('span', { class: 'badge badge-' + st }, st === 'active' ? 'نشط' : 'معطّل')),
      m.name && m.email ? h('div', { class: 'row-mail' }, h('span', { dir: 'ltr' }, m.email)) : null,
      h('div', { class: 'row-key' },
        h('span', { class: 'key', dir: 'ltr' }, m.storeId || '—'),
        h('button', { type: 'button', class: 'chip', 'aria-label': 'نسخ storeId', onclick: () => copy(m.storeId, 'تم نسخ storeId') }, 'نسخ')),
      h('div', { class: 'row-meta' },
        h('span', null, 'آخر دخول: ', formatDate(m.lastSignInAt)),
        h('span', null, 'أُنشئ: ', formatDate(m.createdAt))),
      h('button', {
        type: 'button',
        class: 'btn ' + (st === 'active' ? 'btn-danger' : 'btn-ok') + ' row-action',
        disabled: busy,
        onclick: () => toggleMerchant(m)
      }, busy ? 'جارٍ التنفيذ…' : (st === 'active' ? 'تعطيل الحساب' : 'تفعيل الحساب')));
  }

  function renderList() {
    const box = $('merchant-list');
    box.replaceChildren();
    const rows = filterMerchants(state.merchants, { query: state.query, status: state.status });
    for (const m of rows) box.append(merchantRow(m));
    const empty = $('list-empty');
    if (rows.length === 0 && state.loaded) {
      empty.hidden = false;
      empty.textContent = state.merchants.length === 0
        ? 'لا يوجد تجار بعد. أضف أول تاجر من النموذج أعلاه.'
        : 'لا توجد نتائج مطابقة.';
    } else {
      empty.hidden = true;
    }
  }

  async function toggleMerchant(m) {
    const target = !m.disabled;
    if (target) {
      const label = m.name || m.email || m.storeId;
      const ok = window.confirm('تعطيل حساب «' + label + '»؟\nلن يستطيع تسجيل الدخول، وتُبطَّل جلساته. قد تبقى بياناته مقروءة من تطبيقه حتى ساعة كحد أقصى.');
      if (!ok) return;
    }
    state.busy.add(m.uid);
    renderList();
    try {
      await api.setDisabled(m.uid, target);
      m.disabled = target;
      toast(target ? 'تم تعطيل الحساب' : 'تم تفعيل الحساب');
    } catch (err) {
      if (err.status === 401) { forceLogout(err.message); return; }
      toast(err.message);
    } finally {
      state.busy.delete(m.uid);
    }
    renderAll();
  }

  $('btn-refresh').addEventListener('click', loadMerchants);
  $('search').addEventListener('input', (e) => { state.query = e.target.value; renderList(); });
  for (const btn of document.querySelectorAll('[data-filter]')) {
    btn.addEventListener('click', () => { state.status = btn.getAttribute('data-filter'); renderAll(); });
  }

  /* ---------- إضافة تاجر ---------- */
  function setFieldError(key, msg) {
    const input = $('f-' + key);
    $('err-' + key).textContent = msg || '';
    if (msg) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid');
  }
  function setPasswordVisible(on) {
    $('f-password').type = on ? 'text' : 'password';
    $('btn-toggle-pw').textContent = on ? 'إخفاء' : 'إظهار';
  }
  $('btn-toggle-pw').addEventListener('click', () => setPasswordVisible($('f-password').type === 'password'));
  $('btn-generate-pw').addEventListener('click', () => {
    $('f-password').value = generatePassword();
    setPasswordVisible(true);
    setFieldError('password', '');
  });

  $('add-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = validateMerchantForm({
      name: $('f-name').value, email: $('f-email').value,
      password: $('f-password').value, storeId: $('f-storeId').value
    });
    const errs = v.ok ? {} : v.errors;
    for (const k of ['name', 'email', 'password', 'storeId']) setFieldError(k, errs[k]);
    $('form-msg').textContent = '';
    if (!v.ok) {
      const first = ['name', 'email', 'password', 'storeId'].find((k) => errs[k]);
      $('f-' + first).focus();
      return;
    }
    $('btn-create').disabled = true;
    try {
      const out = await api.createMerchant(v.payload);
      showCreated({ name: out.name || v.payload.name, email: out.email || v.payload.email, storeId: out.storeId, password: v.payload.password });
      $('add-form').reset();
      setPasswordVisible(false);
      toast('تم إنشاء حساب التاجر');
      await loadMerchants();
    } catch (err) {
      if (err.status === 401) { forceLogout(err.message); return; }
      $('form-msg').textContent = err.message;
    } finally {
      $('btn-create').disabled = false;
    }
  });

  /* ---------- بطاقة بيانات الدخول المؤقتة ---------- */
  function hideCreated() {
    clearTimeout(createdTimer);
    created = null;
    $('created').hidden = true;
    $('created-body').replaceChildren();
  }
  function showCreated(info) {
    created = info;
    clearTimeout(createdTimer);
    createdTimer = setTimeout(hideCreated, CREATED_CARD_MS);
    const body = $('created-body');
    body.replaceChildren(
      h('dt', null, 'الاسم'), h('dd', null, info.name),
      h('dt', null, 'البريد'), h('dd', null, h('span', { dir: 'ltr' }, info.email)),
      h('dt', null, 'storeId'), h('dd', null, h('span', { dir: 'ltr' }, info.storeId)),
      h('dt', null, 'كلمة السر'), h('dd', { class: 'secret' }, h('span', { dir: 'ltr' }, info.password)));
    $('created').hidden = false;
    $('created').scrollIntoView({ block: 'nearest' });
  }
  $('btn-copy-login').addEventListener('click', () => {
    if (!created) return;
    copy('البريد: ' + created.email + '\nكلمة السر: ' + created.password, 'تم نسخ بيانات الدخول');
  });
  $('btn-created-done').addEventListener('click', hideCreated);

  /* ---------- نسخ ---------- */
  async function copy(text, okMsg) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = h('textarea', { readonly: true, style: 'position:fixed;opacity:0;top:0' });
        ta.value = text;
        document.body.append(ta);
        ta.select();
        const done = document.execCommand('copy');
        ta.remove();
        if (!done) throw new Error('copy failed');
      }
      toast(okMsg);
    } catch (e) {
      toast('تعذّر النسخ، انسخ يدويًا');
    }
  }

  showView('boot');
}

if (typeof document !== 'undefined') {
  initUi();
} else if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    EMAIL_RE, STORE_ID_RE, PASSWORD_ALPHABET, ApiError,
    apiErrorMessage, authErrorMessage, generatePassword, validateMerchantForm,
    statusOf, summarize, filterMerchants, formatDate, createApiClient
  };
}
