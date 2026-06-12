import {
  defaultSettings, normalizeSettings, MODEL_META, MAX_LOCAL,
  localCount, makeLocalModel, enabledModels,
  estimateTokens, estimateCost, effectivePrice, addUsage, getUsage, resetUsage,
} from './state.js';
import {
  createChat, listChats, updateChatMeta, deleteChat,
  addTurn, updateTurn, listTurns, clearUserData, estimateUsage,
  reencryptUserData, exportUserData, importUserData, uid,
  setSyncEnabled, loadSyncSettings, saveSyncSettings, markAllDirty,
  setLastSync,
} from './db.js';
import {
  signup, login, deleteAccount,
  preparePasswordChange, commitPasswordChange,
  onlineSignup, onlineLogin, onlineChangePassword, refreshOnlineCache,
} from './auth.js';
import {
  encryptJSON, decryptJSON, deriveKey, randomBytes, toB64, fromB64, PBKDF2_ITERATIONS,
} from './crypto.js';
import { runSync, isConfigured as syncConfigured, getEndpoint, setEndpoint, serverLogin, serverChangePassword } from './sync.js';
import { streamChat, supportsWebSearch } from './providers.js';
import { renderMarkdown } from './markdown.js';

// ---------- tiny DOM helper ----------
function h(tag, props = {}, children = []) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) el.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return el;
}
const $ = (sel) => document.querySelector(sel);

// ---------- app state ----------
let session = null;                 // { id, displayName, key } — key is in-memory only
let settings = defaultSettings();
let chats = [];
let currentChat = null;
let turns = [];
let activeController = null; // AbortController for in-flight send
const SETTINGS_PREFIX = 'apitizer.settings.';
let authMode = 'login'; // 'login' | 'signup'
// Online (synced) vs local-only login. Default to online so new devices sync
// out of the box; the user can flip the toggle to stay fully local.
const LOGIN_MODE_KEY = 'apitizer.loginMode';
let loginMode = localStorage.getItem(LOGIN_MODE_KEY) || 'online'; // 'online' | 'local'

// ---------- elements ----------
const messagesEl = $('#messages');
const chatListEl = $('#chatList');
const chatTitleEl = $('#chatTitle');
const promptInput = $('#promptInput');
const sendBtn = $('#sendBtn');
const stopBtn = $('#stopBtn');
const masterToggle = $('#masterToggle');
const modelChipsEl = $('#modelChips');
const settingsModal = $('#settingsModal');
const composerEl = $('#composer');
const attachBtn = $('#attachBtn');
const webSearchBtn = $('#webSearchBtn');
const fileInput = $('#fileInput');
const attachPreviewEl = $('#attachPreview');
const chatSearchEl = $('#chatSearch');

let pendingAttachments = []; // { id, name, mime, size, kind:'image'|'text', dataUrl?, text? }
const MAX_FILE_BYTES = 20 * 1024 * 1024; // 20MB per file guard
let chatSearchTerm = '';
let searchMatchIds = null;   // Set of chatIds matching a content search, or null
const REMEMBER_KEY = 'apitizer.lastUser';
const LEGACY_AUTOLOGIN_KEY = 'apitizer.autologin';
const AUTO_LOGIN_KEY = 'apitizer.autoLogin.v1';
const AUTO_LOGIN_SECRET_KEY = 'apitizer.autoLogin.secret.v1';
const LOGIN_THROTTLE_KEY = 'apitizer.loginThrottle.v1';
const LOGIN_MAX_FAILURES = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_LOCK_MS = 10 * 60 * 1000;
const BACKUP_VERSION = 2;
let idleTimer = null;
let tipEl = null;
const LAYOUT_KEY = 'apitizer.layout'; // 'auto' | 'mobile' | 'desktop' (device-level, not per-user)
const MOBILE_BREAKPOINT = 820;
const NARROW_BREAKPOINT = 480;
let layoutMode = localStorage.getItem(LAYOUT_KEY) || 'auto';
const THEME_KEY = 'apitizer.theme'; // 'dark' | 'light' (device-level)
let theme = localStorage.getItem(THEME_KEY) || 'dark';

// =====================================================================
//  Boot
// =====================================================================
initAppEvents();
setupSettingsModal();
setupTooltips();
setupLayoutToggle();
setupThemeToggle();
initAuth();

function initAppEvents() {
  $('#newChatBtn').addEventListener('click', () => { newChat(); closeDrawer(); });
  $('#brandHomeBtn').addEventListener('click', () => { newChat(); closeDrawer(); });
  $('#settingsBtn').addEventListener('click', () => { openSettings(); closeDrawer(); });
  $('#exportBtn').addEventListener('click', exportChat);
  $('#logoutBtn').addEventListener('click', logout);
  $('#resetUsageBtn').addEventListener('click', doResetUsage);
  $('#syncNowBtn').addEventListener('click', () => runSyncSafe());
  sendBtn.addEventListener('click', send);
  stopBtn.addEventListener('click', stop);

  // mobile drawer
  $('#menuBtn').addEventListener('click', toggleDrawer);
  $('#sidebarBackdrop').addEventListener('click', closeDrawer);

  $('#expandBtn').addEventListener('click', () => {
    composerEl.classList.toggle('expanded');
    promptInput.focus();
  });

  webSearchBtn.addEventListener('click', () => {
    settings.webSearchEnabled = !settings.webSearchEnabled;
    applyWebSearchButton();
    persistSettings();
  });

  chatSearchEl.addEventListener('input', onChatSearchInput);

  promptInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  promptInput.addEventListener('input', autoGrow);

  // ----- attachments: button, file picker, paste, drag & drop -----
  attachBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => { addFiles(fileInput.files); fileInput.value = ''; });
  promptInput.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.items || [])]
      .filter((it) => it.kind === 'file').map((it) => it.getAsFile()).filter(Boolean);
    if (files.length) { e.preventDefault(); addFiles(files); }
  });
  composerEl.addEventListener('dragover', (e) => { e.preventDefault(); composerEl.classList.add('drag-over'); });
  composerEl.addEventListener('dragleave', (e) => { if (e.target === composerEl) composerEl.classList.remove('drag-over'); });
  composerEl.addEventListener('drop', (e) => {
    e.preventDefault(); composerEl.classList.remove('drag-over');
    if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
  });

  masterToggle.addEventListener('change', () => {
    settings.masterEnabled = masterToggle.checked;
    if (settings.masterEnabled) {
      const master = settings.models.find((m) => m.id === settings.masterId);
      if (master) master.enabled = true;
      renderChips();
      renderUsage();
    }
    persistSettings();
  });

  $('#helpBtn').addEventListener('click', openHelp);
  $('#helpModal').querySelectorAll('[data-help-close]').forEach((el) =>
    el.addEventListener('click', closeHelp));

  // Prompt library
  $('#promptLibBtn').addEventListener('click', openPromptModal);
  $('#promptModal').querySelectorAll('[data-prompt-close]').forEach((el) =>
    el.addEventListener('click', closePromptModal));
  $('#promptAddBtn').addEventListener('click', addPromptFromForm);

  $('#viewToggle').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-view]');
    if (!btn) return;
    settings.viewMode = btn.dataset.view;
    persistSettings();
    setViewButtons();
    renderMessages();
  });

  // Copy buttons inside rendered code blocks (event delegation).
  messagesEl.addEventListener('click', async (e) => {
    const btn = e.target.closest('.code-copy');
    if (!btn) return;
    const code = decodeURIComponent(btn.dataset.code || '');
    try {
      await navigator.clipboard.writeText(code);
      const prev = btn.textContent;
      btn.textContent = '복사됨 ✓';
      btn.classList.add('copied');
      setTimeout(() => { btn.textContent = prev; btn.classList.remove('copied'); }, 1200);
    } catch {
      alert('복사에 실패했습니다. (localhost·HTTPS에서만 클립보드를 사용할 수 있습니다)');
    }
  });

  // Global keyboard shortcuts
  document.addEventListener('keydown', onGlobalKeydown);
}

function onGlobalKeydown(e) {
  // Only when logged in
  if (!session) {
    if (e.key === 'Escape') return;
    return;
  }
  const mod = e.ctrlKey || e.metaKey;
  if (mod && (e.key === 'k' || e.key === 'K')) {
    e.preventDefault();
    chatSearchEl.focus();
    chatSearchEl.select();
  } else if (mod && (e.key === 'n' || e.key === 'N')) {
    e.preventDefault();
    newChat();
  } else if (e.key === 'Escape') {
    if (!$('#helpModal').hidden) closeHelp();
    else if (!$('#promptModal').hidden) closePromptModal();
    else if (!$('#pwModal').hidden) closePwModal();
    else if (!settingsModal.hidden) closeSettings();
    else if (document.getElementById('app').classList.contains('drawer-open')) closeDrawer();
    else if (composerEl.classList.contains('expanded')) composerEl.classList.remove('expanded');
  }
}

function openHelp() { $('#helpModal').hidden = false; }
function closeHelp() { $('#helpModal').hidden = true; }

// ---- Prompt library ----
function openPromptModal() {
  if (!session) return;
  $('#promptNewTitle').value = '';
  $('#promptNewText').value = '';
  renderPromptList();
  $('#promptModal').hidden = false;
  closeDrawer();
}
function closePromptModal() { $('#promptModal').hidden = true; }

function renderPromptList() {
  const list = $('#promptList');
  list.innerHTML = '';
  const prompts = settings.prompts || [];
  if (!prompts.length) {
    list.appendChild(h('p', { class: 'muted', text: '저장된 프롬프트가 없습니다. 위에서 추가해 보세요.' }));
    return;
  }
  for (const p of prompts) {
    list.appendChild(h('div', { class: 'prompt-item' }, [
      h('div', { class: 'prompt-item-main' }, [
        h('div', { class: 'prompt-item-title', text: p.title || '(제목 없음)' }),
        h('div', { class: 'prompt-item-text', text: p.text || '' }),
      ]),
      h('div', { class: 'prompt-item-acts' }, [
        h('button', { class: 'btn btn-primary btn-sm', title: '입력창에 넣기',
          onclick: () => insertPrompt(p.id) }, '삽입'),
        h('button', { class: 'q-act', title: '삭제',
          onclick: () => deletePrompt(p.id) }, '🗑'),
      ]),
    ]));
  }
}

async function addPromptFromForm() {
  const title = $('#promptNewTitle').value.trim().slice(0, 60);
  const text = $('#promptNewText').value.trim();
  if (!text) { $('#promptNewText').focus(); return; }
  settings.prompts = settings.prompts || [];
  settings.prompts.push({ id: uid(), title: title || text.slice(0, 24), text });
  await persistSettings();
  $('#promptNewTitle').value = '';
  $('#promptNewText').value = '';
  renderPromptList();
}

function insertPrompt(id) {
  const p = (settings.prompts || []).find((x) => x.id === id);
  if (!p) return;
  const cur = promptInput.value;
  promptInput.value = cur && cur.trim() ? (cur.replace(/\s+$/, '') + '\n' + p.text) : p.text;
  closePromptModal();
  autoGrow();
  promptInput.focus();
  promptInput.setSelectionRange(promptInput.value.length, promptInput.value.length);
}

async function deletePrompt(id) {
  settings.prompts = (settings.prompts || []).filter((x) => x.id !== id);
  await persistSettings();
  renderPromptList();
}

// ---- Mobile sidebar drawer ----
function toggleDrawer() { document.getElementById('app').classList.toggle('drawer-open'); }
function closeDrawer() { document.getElementById('app').classList.remove('drawer-open'); }

// ---- PC ⇄ Mobile layout switch ----
// `auto`  : follow viewport width (≤820px = mobile)
// `mobile`: force the mobile/drawer layout on any screen
// `desktop`: force the desktop layout even on a phone
function prefersMobile() { return window.innerWidth <= MOBILE_BREAKPOINT; }
function applyLayoutMode() {
  const mobile = layoutMode === 'mobile' || (layoutMode === 'auto' && prefersMobile());
  document.body.classList.toggle('is-mobile', mobile);
  document.body.classList.toggle('is-narrow', mobile && window.innerWidth <= NARROW_BREAKPOINT);
  // When desktop layout is *forced* on a narrow screen, keep a usable min width and
  // let the page scroll horizontally instead of crushing the content column.
  document.body.classList.toggle('force-desktop', layoutMode === 'desktop' && window.innerWidth <= MOBILE_BREAKPOINT);
  if (!mobile) closeDrawer(); // a stuck-open drawer would hide content in desktop mode
  const btn = $('#layoutToggle');
  if (btn) {
    btn.hidden = false;
    // Compact icon-only button: auto mode can be overridden once; any forced
    // mode returns to auto so PC/mobile follows the device again.
    btn.textContent = mobile ? '\uD83D\uDDA5\uFE0F' : '\uD83D\uDCF1';
    if (layoutMode === 'auto') {
      btn.setAttribute('aria-label', mobile ? 'PC 보기로 전환 (현재: 자동)' : '모바일 보기로 전환 (현재: 자동)');
      btn.setAttribute('data-tip', mobile ? 'PC 레이아웃으로 전환 (현재: 자동)' : '모바일 레이아웃으로 전환 (현재: 자동)');
    } else {
      btn.setAttribute('aria-label', '자동 레이아웃으로 복귀');
      btn.setAttribute('data-tip', '자동 레이아웃으로 복귀');
    }
  }
}
function setupLayoutToggle() {
  const btn = $('#layoutToggle');
  btn.addEventListener('click', () => {
    if (layoutMode === 'auto') {
      const mobileNow = document.body.classList.contains('is-mobile');
      layoutMode = mobileNow ? 'desktop' : 'mobile';
    } else {
      layoutMode = 'auto';
    }
    if (layoutMode === 'auto') localStorage.removeItem(LAYOUT_KEY);
    else localStorage.setItem(LAYOUT_KEY, layoutMode);
    applyLayoutMode();
  });
  // Re-evaluate on rotate/resize (only matters while in `auto`).
  window.addEventListener('resize', () => { if (layoutMode === 'auto') applyLayoutMode(); });
  applyLayoutMode();
}

// ---- Light / dark theme ----
function applyTheme() {
  document.body.classList.toggle('theme-light', theme === 'light');
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === 'light' ? '#ffffff' : '#0b0e14');
  const btn = $('#themeBtn');
  if (btn) {
    btn.textContent = theme === 'light' ? '\u2600\uFE0F' : '\uD83C\uDF19'; // ☀️ when light shown, 🌙 when dark
    btn.setAttribute('data-tip', theme === 'light' ? '\uB2E4\uD06C \uD14C\uB9C8\uB85C \uC804\uD658' : '\uB77C\uC774\uD2B8 \uD14C\uB9C8\uB85C \uC804\uD658');
  }
}
function setupThemeToggle() {
  $('#themeBtn').addEventListener('click', () => {
    theme = theme === 'light' ? 'dark' : 'light';
    localStorage.setItem(THEME_KEY, theme);
    applyTheme();
  });
  applyTheme();
}

// ---- Tooltip layer (rendered on <body> so it is never clipped) ----
function setupTooltips() {
  tipEl = document.createElement('div');
  tipEl.id = 'tipLayer';
  tipEl.hidden = true;
  document.body.appendChild(tipEl);

  const show = (target) => {
    const tip = target.getAttribute('data-tip');
    if (!tip) return;
    tipEl.textContent = tip;
    tipEl.hidden = false;
    // measure then position above the element, clamped to the viewport
    const r = target.getBoundingClientRect();
    const tr = tipEl.getBoundingClientRect();
    let left = r.left + r.width / 2 - tr.width / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - tr.width - 8));
    let top = r.top - tr.height - 8;
    if (top < 8) top = r.bottom + 8; // flip below if no room above
    tipEl.style.left = left + 'px';
    tipEl.style.top = top + 'px';
    requestAnimationFrame(() => tipEl.classList.add('show'));
  };
  const hide = () => {
    tipEl.classList.remove('show');
    tipEl.hidden = true;
  };

  document.addEventListener('mouseover', (e) => {
    const t = e.target.closest('[data-tip]');
    if (t) show(t);
  });
  document.addEventListener('mouseout', (e) => {
    const t = e.target.closest('[data-tip]');
    if (t && !t.contains(e.relatedTarget)) hide();
  });
  // hide on scroll inside modals etc.
  document.addEventListener('scroll', hide, true);
}

// =====================================================================
//  Auth (login / signup gate)
// =====================================================================
function initAuth() {
  // Web Crypto (encryption) requires a secure context: localhost or HTTPS.
  // Opening the app via a plain-HTTP LAN address would silently break login,
  // so fail loudly with guidance instead.
  if (!window.crypto || !window.crypto.subtle) {
    showAuthError('이 주소에서는 암호화를 사용할 수 없습니다. http://localhost:8753 로 접속하세요.');
    $('#authSubmit').disabled = true;
    $('#authUser').disabled = true;
    $('#authPass').disabled = true;
    $('#authPass2').disabled = true;
    return;
  }
  // Always open on the LOGIN view (the first-ever user taps 회원가입).
  authMode = 'login';
  applyAuthMode();
  $('#authToggle').addEventListener('click', (e) => {
    e.preventDefault();
    authMode = authMode === 'login' ? 'signup' : 'login';
    applyAuthMode();
  });
  $('#authSubmit').addEventListener('click', submitAuth);
  for (const id of ['#authUser', '#authPass', '#authPass2']) {
    $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') submitAuth(); });
  }

  // Online vs local login toggle (default online, persisted per device).
  $('#authModeToggle').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-mode]');
    if (!btn) return;
    loginMode = btn.dataset.mode;
    localStorage.setItem(LOGIN_MODE_KEY, loginMode);
    applyLoginMode();
  });
  const ep = $('#syncEndpoint');
  if (ep) {
    ep.value = getEndpoint();
    ep.addEventListener('change', () => setEndpoint(ep.value.trim()));
  }
  applyLoginMode();

  // Remember-ID prefill
  const lastUser = localStorage.getItem(REMEMBER_KEY);
  if (lastUser) {
    $('#authUser').value = lastUser;
    $('#rememberId').checked = true;
    $('#authPass').focus();
  } else {
    $('#authUser').focus();
  }

  localStorage.removeItem(LEGACY_AUTOLOGIN_KEY);
  tryAutoLogin();
}

function applyAuthMode() {
  const signupMode = authMode === 'signup';
  $('#authPass2').hidden = !signupMode;
  $('#authSubmit').textContent = signupMode ? '회원가입' : '로그인';
  $('#authSwitchText').textContent = signupMode ? '이미 계정이 있으신가요?' : '계정이 없으신가요?';
  $('#authToggle').textContent = signupMode ? '로그인' : '회원가입';
  $('#authPass').setAttribute('autocomplete', signupMode ? 'new-password' : 'current-password');
  showAuthError('');
}

// Reflect the online/local login mode in the auth UI.
function applyLoginMode() {
  const online = loginMode === 'online';
  const onlineEl = document.querySelector('#authModeToggle [data-mode="online"]');
  const localEl = document.querySelector('#authModeToggle [data-mode="local"]');
  if (onlineEl) onlineEl.classList.toggle('active', online);
  if (localEl) localEl.classList.toggle('active', !online);
  const cfg = $('#syncConfig');
  if (cfg) cfg.hidden = !online;
  const sub = $('#authSub');
  if (sub) {
    sub.textContent = online
      ? '여러 기기에서 안전하게 동기화됩니다.'
      : '이 브라우저에만 암호화되어 저장됩니다.';
  }
}

function showAuthError(msg) {
  const el = $('#authError');
  el.textContent = msg;
  el.hidden = !msg;
}

async function submitAuth() {
  const username = $('#authUser').value.trim();
  const password = $('#authPass').value;
  const submitBtn = $('#authSubmit');
  const autoLoginRequested = $('#autoLogin').checked;
  showAuthError('');
  if (!username || !password) { showAuthError('아이디와 비밀번호를 입력하세요.'); return; }

  if (authMode === 'login') {
    const waitMs = loginWaitMs(username);
    if (waitMs > 0) {
      showAuthError(`로그인 시도가 너무 많습니다. ${formatWait(waitMs)} 후 다시 시도하세요.`);
      return;
    }
  }

  submitBtn.disabled = true;
  const prevText = submitBtn.textContent;
  submitBtn.textContent = '처리 중…';
  try {
    let s;
    if (loginMode === 'online') {
      if (!syncConfigured()) {
        throw new Error('동기화 서버 주소가 설정되지 않았습니다. 로컬 모드로 전환하거나 서버 주소를 등록하세요.');
      }
      if (authMode === 'signup') {
        const pass2 = $('#authPass2').value;
        if (password !== pass2) throw new Error('비밀번호가 일치하지 않습니다.');
        s = await onlineSignup(username, password, { extractable: autoLoginRequested });
      } else {
        s = await onlineLogin(username, password, { extractable: autoLoginRequested });
      }
    } else if (authMode === 'signup') {
      const pass2 = $('#authPass2').value;
      if (password !== pass2) throw new Error('비밀번호가 일치하지 않습니다.');
      s = await signup(username, password, { extractable: autoLoginRequested });
      s.mode = 'local';
    } else {
      s = await login(username, password, { extractable: autoLoginRequested });
      s.mode = 'local';
    }
    clearLoginFailures(username);
    // remember-ID
    if ($('#rememberId').checked) localStorage.setItem(REMEMBER_KEY, s.displayName);
    else localStorage.removeItem(REMEMBER_KEY);
    localStorage.removeItem(LEGACY_AUTOLOGIN_KEY);
    if (autoLoginRequested) await saveAutoLoginSession(s);
    else clearAutoLoginSession();
    await onAuthed(s);
  } catch (err) {
    if (authMode === 'login') recordLoginFailure(username);
    showAuthError(String(err.message || err));
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = prevText;
  }
}

async function autoLoginCryptoKey() {
  let secret = localStorage.getItem(AUTO_LOGIN_SECRET_KEY);
  if (!secret) {
    secret = toB64(randomBytes(32));
    localStorage.setItem(AUTO_LOGIN_SECRET_KEY, secret);
  }
  return crypto.subtle.importKey('raw', fromB64(secret), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

async function exportSessionKey(key) {
  const raw = await crypto.subtle.exportKey('raw', key);
  return toB64(new Uint8Array(raw));
}

async function importSessionKey(rawKey) {
  return crypto.subtle.importKey('raw', fromB64(rawKey), { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);
}

async function saveAutoLoginSession(s) {
  const payload = {
    id: s.id,
    displayName: s.displayName,
    mode: s.mode,
    key: await exportSessionKey(s.key),
    token: s.token || null,
    authToken: s.authToken || null,
    kdfSalt: s.kdfSalt || null,
    iterations: s.iterations || null,
    savedAt: Date.now(),
  };
  const env = await encryptJSON(await autoLoginCryptoKey(), payload);
  localStorage.setItem(AUTO_LOGIN_KEY, JSON.stringify(env));
}

function clearAutoLoginSession() {
  localStorage.removeItem(AUTO_LOGIN_KEY);
  localStorage.removeItem(AUTO_LOGIN_SECRET_KEY);
  const checkbox = $('#autoLogin');
  if (checkbox) checkbox.checked = false;
}

async function tryAutoLogin() {
  const raw = localStorage.getItem(AUTO_LOGIN_KEY);
  if (!raw || session) return false;
  const submitBtn = $('#authSubmit');
  const prevText = submitBtn.textContent;
  submitBtn.disabled = true;
  submitBtn.textContent = '자동 로그인 중…';
  try {
    const saved = await decryptJSON(await autoLoginCryptoKey(), JSON.parse(raw));
    const s = {
      id: saved.id,
      displayName: saved.displayName || saved.id,
      mode: saved.mode || 'local',
      key: await importSessionKey(saved.key),
      token: saved.token || null,
      authToken: saved.authToken || null,
      kdfSalt: saved.kdfSalt || null,
      iterations: saved.iterations || null,
      offline: false,
    };
    if (s.mode === 'online' && s.authToken) {
      try {
        const username = String(s.id || '').replace(/^online:/, '');
        const { token } = await serverLogin({ username, authToken: s.authToken });
        s.id = username;
        s.token = token;
        await saveAutoLoginSession(s);
      } catch (err) {
        if (err && (err.status === 401 || err.status === 403)) {
          clearAutoLoginSession();
          showAuthError('자동 로그인 정보가 만료되었습니다. 다시 로그인하세요.');
          return false;
        }
        s.offline = true;
        s.token = s.token || null;
      }
    }
    $('#autoLogin').checked = true;
    if (s.displayName) {
      $('#authUser').value = s.displayName;
      $('#rememberId').checked = true;
      localStorage.setItem(REMEMBER_KEY, s.displayName);
    }
    await onAuthed(s);
    return true;
  } catch {
    clearAutoLoginSession();
    showAuthError('자동 로그인 정보를 읽지 못했습니다. 다시 로그인하세요.');
    return false;
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = prevText;
  }
}

function loadLoginThrottle() {
  try { return JSON.parse(localStorage.getItem(LOGIN_THROTTLE_KEY)) || {}; }
  catch { return {}; }
}
function saveLoginThrottle(data) {
  localStorage.setItem(LOGIN_THROTTLE_KEY, JSON.stringify(data));
}
function throttleId(username) {
  return String(username || '').trim().toLowerCase() || '*';
}
function loginWaitMs(username) {
  const row = loadLoginThrottle()[throttleId(username)];
  const now = Date.now();
  if (!row) return 0;
  if (row.lockUntil && row.lockUntil > now) return row.lockUntil - now;
  return 0;
}
function recordLoginFailure(username) {
  const id = throttleId(username);
  const data = loadLoginThrottle();
  const now = Date.now();
  const row = data[id] || { count: 0, firstAt: now, lockUntil: 0 };
  if (now - row.firstAt > LOGIN_WINDOW_MS) {
    row.count = 0;
    row.firstAt = now;
    row.lockUntil = 0;
  }
  row.count += 1;
  if (row.count >= LOGIN_MAX_FAILURES) {
    row.lockUntil = now + LOGIN_LOCK_MS * Math.min(6, row.count - LOGIN_MAX_FAILURES + 1);
  }
  data[id] = row;
  saveLoginThrottle(data);
}
function clearLoginFailures(username) {
  const data = loadLoginThrottle();
  delete data[throttleId(username)];
  saveLoginThrottle(data);
}
function formatWait(ms) {
  const minutes = Math.ceil(ms / 60000);
  return minutes >= 60 ? `${Math.ceil(minutes / 60)}시간` : `${minutes}분`;
}

async function onAuthed(s) {
  // Partition local storage by mode so a local "kim" and an online "kim" never
  // collide in IndexedDB / settings (their data keys differ).
  if (s.mode === 'online') s.id = 'online:' + s.id;
  session = s;
  setSyncEnabled(s.mode === 'online');

  // header / sidebar identity (shown before the first sync so the app feels snappy)
  $('#userName').textContent = s.displayName;
  $('#userBadge').textContent = (s.displayName || '?').slice(0, 1);

  // Online: pull remote state first so settings / chats are present on a new device.
  if (s.mode === 'online' && s.token) {
    setSyncStatus('syncing');
    try { await runSync(session); setSyncStatus('synced'); }
    catch (e) { setSyncStatus('error', e && e.message); }
  } else if (s.mode === 'online' && s.offline) {
    setSyncStatus('offline');
  }

  settings = await loadSettingsFor(s);

  // clear sensitive inputs
  $('#authPass').value = '';
  $('#authPass2').value = '';
  showAuthError('');

  $('#authScreen').hidden = true;
  $('#app').hidden = false;
  $('#syncRow').hidden = (s.mode !== 'online');
  const hint = document.querySelector('.sidebar-foot .hint');
  if (hint) {
    hint.textContent = s.mode === 'online'
      ? '키·기록은 암호화되어 저장되고 서버에는 암호문만 동기화됩니다.'
      : '키·기록은 이 브라우저에만 암호화 저장됩니다.';
  }

  await bootAppData();
  startSyncLoop();
}

// =====================================================================
//  Background delta sync (online mode only)
// =====================================================================
const SYNC_INTERVAL_MS = 15000;
let syncTimer = null;
let syncDebounce = null;

function isOnlineSession() {
  return !!(session && session.mode === 'online' && session.token);
}

// Debounced trigger after a local change. Short delay = near write-through:
// just enough to coalesce a burst of rapid edits into a single push.
function scheduleSync() {
  if (!isOnlineSession()) return;
  if (syncDebounce) clearTimeout(syncDebounce);
  syncDebounce = setTimeout(() => { syncDebounce = null; runSyncSafe(); }, 300);
}

async function runSyncSafe() {
  if (!isOnlineSession()) return;
  // Don't fight an in-flight model stream; retry on the next tick instead.
  if (activeController) return;
  setSyncStatus('syncing');
  try {
    const r = await runSync(session);
    setSyncStatus('synced');
    if (r && r.pulled) await refreshAfterSync();
  } catch (e) {
    // Token rejected (e.g. another device changed the password): give up on
    // merging and bounce this device to the login screen. Any unsent local
    // (pending) edits are intentionally discarded per the sync design.
    if (e && e.status === 401) {
      clearAutoLoginSession();
      forceLogout('비밀번호가 변경되어 자동 로그아웃되었습니다. 새 비밀번호로 다시 로그인해주세요.');
      return;
    }
    setSyncStatus('error', e && e.message);
  }
}

function startSyncLoop() {
  stopSyncLoop();
  if (!isOnlineSession()) return;
  syncTimer = setInterval(runSyncSafe, SYNC_INTERVAL_MS);
  document.addEventListener('visibilitychange', onVisibilitySync);
  window.addEventListener('online', runSyncSafe);
}
function stopSyncLoop() {
  if (syncTimer) clearInterval(syncTimer);
  syncTimer = null;
  if (syncDebounce) { clearTimeout(syncDebounce); syncDebounce = null; }
  document.removeEventListener('visibilitychange', onVisibilitySync);
  window.removeEventListener('online', runSyncSafe);
}
function onVisibilitySync() { if (!document.hidden) runSyncSafe(); }

// Re-pull pulled changes into the live UI without disrupting an active edit.
async function refreshAfterSync() {
  if (!session) return;
  try { settings = await loadSettingsFor(session); }
  catch { /* keep current settings */ }
  applyWebSearchButton();
  renderChips();
  renderUsage();
  chats = await listChats(session.id, session.key);
  renderChatList();
  if (currentChat) {
    if (chats.some((c) => c.id === currentChat.id)) {
      turns = await listTurns(currentChat.id, session.key);
      renderMessages();
    } else {
      currentChat = null; turns = []; chatTitleEl.textContent = ''; renderMessages();
    }
  }
}

function setSyncStatus(state, detail) {
  const el = $('#syncStatus');
  if (!el) return;
  const map = {
    syncing: '↻ 동기화 중…',
    synced: '✓ 동기화됨',
    offline: '⚠ 오프라인 (로컬 사용 중)',
    error: '⚠ 동기화 실패',
  };
  el.textContent = map[state] || '';
  el.title = detail ? String(detail) : '';
  el.dataset.state = state || '';
}

async function bootAppData() {
  masterToggle.checked = settings.masterEnabled;
  setViewButtons();
  applyWebSearchButton();
  renderChips();
  renderUsage();
  chatSearchEl.value = '';
  chatSearchTerm = '';
  searchMatchIds = null;
  currentChat = null;
  turns = [];
  chats = await listChats(session.id, session.key);
  renderChatList();
  if (chats.length) await openChat(chats[0].id);
  else { chatTitleEl.textContent = ''; renderMessages(); }
  startIdleWatch();
}

function applyWebSearchButton() {
  webSearchBtn.classList.toggle('active', !!settings.webSearchEnabled);
}

// ----- Idle auto-lock -----
const IDLE_EVENTS = ['mousedown', 'keydown', 'wheel', 'touchstart'];
function resetIdleTimer() {
  if (!session) return;
  if (idleTimer) clearTimeout(idleTimer);
  const mins = Number(settings.autoLockMinutes) || 0;
  if (mins <= 0) return;
  idleTimer = setTimeout(() => {
    forceLogout('일정 시간 활동이 없어 자동 잠금되었습니다. 다시 로그인해주세요.');
  }, mins * 60 * 1000);
}
function startIdleWatch() {
  for (const ev of IDLE_EVENTS) document.addEventListener(ev, resetIdleTimer, { passive: true });
  resetIdleTimer();
}
function stopIdleWatch() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  for (const ev of IDLE_EVENTS) document.removeEventListener(ev, resetIdleTimer);
}

function clearSessionState() {
  if (activeController) activeController.abort();
  stopIdleWatch();
  stopSyncLoop();
  setSyncEnabled(false);
  setSyncStatus('');
  localStorage.removeItem(LEGACY_AUTOLOGIN_KEY);
  session = null;
  settings = defaultSettings();
  chats = [];
  currentChat = null;
  turns = [];
  if (!settingsModal.hidden) closeSettings();
  if (!$('#pwModal').hidden) closePwModal();
  closeDrawer();
}

function showAuthScreen() {
  $('#app').hidden = true;
  $('#authScreen').hidden = false;
  authMode = 'login';
  applyAuthMode();
  applyLoginMode();
  const lastUser = localStorage.getItem(REMEMBER_KEY);
  $('#authUser').value = lastUser || '';
  $('#authPass').value = '';
  $('#authPass2').value = '';
  $('#rememberId').checked = !!lastUser;
  (lastUser ? $('#authPass') : $('#authUser')).focus();
}

function logout() {
  if (!confirm('로그아웃할까요? 다시 로그인하려면 비밀번호가 필요합니다.')) return;
  clearAutoLoginSession();
  clearSessionState();
  showAuthScreen();
}

function forceLogout(message) {
  clearSessionState();
  showAuthScreen();
  if (message) showAuthError(message);
}

// =====================================================================
//  Encrypted settings persistence (per user)
// =====================================================================
async function loadSettingsFor(s) {
  // Online: prefer the synced settings blob (kept in IndexedDB `meta`) so a new
  // device picks up API keys / preferences right after the first pull.
  if (s.mode === 'online') {
    try {
      const synced = await loadSyncSettings(s.id, s.key);
      if (synced) return normalizeSettings(synced);
    } catch { /* fall back to local cache */ }
  }
  const raw = localStorage.getItem(SETTINGS_PREFIX + s.id);
  if (!raw) return defaultSettings();
  try {
    const env = JSON.parse(raw);
    const parsed = await decryptJSON(s.key, env);
    return normalizeSettings(parsed);
  } catch {
    return defaultSettings();
  }
}

let settingsSaveChain = Promise.resolve();
function persistSettings() {
  if (!session) return;
  // serialise saves so rapid edits never interleave
  settingsSaveChain = settingsSaveChain.then(async () => {
    const env = await encryptJSON(session.key, settings);
    localStorage.setItem(SETTINGS_PREFIX + session.id, JSON.stringify(env));
    if (session.mode === 'online') {
      await saveSyncSettings(session.id, session.key, settings);
    }
  }).catch(() => {});
  if (session.mode === 'online') scheduleSync();
  return settingsSaveChain;
}

function autoGrow() {
  promptInput.style.height = 'auto';
  promptInput.style.height = Math.min(promptInput.scrollHeight, 200) + 'px';
}

// =====================================================================
//  Attachments
// =====================================================================
const TEXT_EXT = /\.(txt|md|markdown|json|csv|tsv|js|ts|jsx|tsx|py|java|c|cpp|cs|go|rs|rb|php|html|css|scss|xml|yaml|yml|toml|ini|sh|bat|sql|log)$/i;

function fmtSize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

function readAsDataURL(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => rej(r.error);
    r.readAsDataURL(file);
  });
}
function readAsText(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => rej(r.error);
    r.readAsText(file);
  });
}

// Lazily load pdf.js (only when a PDF is actually attached) and extract text.
// Works for every model since the text is inlined like a .txt file — no
// per-provider setup needed.
let pdfjsPromise = null;
function loadPdfJs() {
  if (pdfjsPromise) return pdfjsPromise;
  pdfjsPromise = import('https://cdn.jsdelivr.net/npm/pdfjs-dist@4.8.69/build/pdf.min.mjs')
    .then((mod) => {
      mod.GlobalWorkerOptions.workerSrc =
        'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.8.69/build/pdf.worker.min.mjs';
      return mod;
    });
  return pdfjsPromise;
}

async function extractPdfText(file) {
  const pdfjs = await loadPdfJs();
  const data = await file.arrayBuffer();
  const doc = await pdfjs.getDocument({ data }).promise;
  let text = '';
  const maxPages = Math.min(doc.numPages, 100); // safety cap
  for (let i = 1; i <= maxPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    text += content.items.map((it) => it.str).join(' ') + '\n\n';
  }
  if (doc.numPages > maxPages) text += `\n…(${doc.numPages}쪽 중 ${maxPages}쪽까지만 읽음)`;
  return text.trim();
}

async function addFiles(fileList) {
  const files = [...(fileList || [])];
  for (const file of files) {
    if (file.size > MAX_FILE_BYTES) {
      alert(`"${file.name}" 은(는) 너무 큽니다 (최대 ${fmtSize(MAX_FILE_BYTES)}).`);
      continue;
    }
    const isImage = file.type.startsWith('image/');
    const isPdf = !isImage && (file.type === 'application/pdf' || /\.pdf$/i.test(file.name));
    const isText = !isImage && !isPdf && (TEXT_EXT.test(file.name) || file.type.startsWith('text/'));
    if (!isImage && !isPdf && !isText) {
      alert(`"${file.name}" 형식은 지원하지 않습니다. 이미지 · PDF · 텍스트/코드 파일만 첨부할 수 있어요.`);
      continue;
    }
    try {
      if (isImage) {
        const dataUrl = await readAsDataURL(file);
        pendingAttachments.push({ id: uid(), name: file.name, mime: file.type, size: file.size, kind: 'image', dataUrl });
      } else if (isPdf) {
        // show a placeholder chip while extracting (can take a moment)
        const a = { id: uid(), name: file.name, mime: 'application/pdf', size: file.size, kind: 'text', text: '', extracting: true };
        pendingAttachments.push(a);
        renderAttachPreview();
        try {
          a.text = await extractPdfText(file);
          a.extracting = false;
          if (!a.text) a.text = '(PDF에서 추출된 텍스트가 없습니다 — 스캔 이미지 PDF일 수 있습니다.)';
        } catch (err) {
          pendingAttachments = pendingAttachments.filter((x) => x.id !== a.id);
          alert(`"${file.name}" PDF를 읽지 못했습니다. (인터넷 연결이 필요하거나 손상된 파일일 수 있어요)`);
        }
      } else {
        const text = await readAsText(file);
        pendingAttachments.push({ id: uid(), name: file.name, mime: file.type || 'text/plain', size: file.size, kind: 'text', text });
      }
    } catch {
      alert(`"${file.name}" 을(를) 읽지 못했습니다.`);
    }
  }
  renderAttachPreview();
}

function removeAttachment(id) {
  pendingAttachments = pendingAttachments.filter((a) => a.id !== id);
  renderAttachPreview();
}

function clearAttachments() {
  pendingAttachments = [];
  renderAttachPreview();
}

function renderAttachPreview() {
  attachPreviewEl.innerHTML = '';
  if (!pendingAttachments.length) { attachPreviewEl.hidden = true; return; }
  attachPreviewEl.hidden = false;
  for (const a of pendingAttachments) {
    const isPdf = a.mime === 'application/pdf';
    const icon = a.kind === 'image'
      ? h('img', { src: a.dataUrl, alt: a.name })
      : h('div', { class: 'file-ic' }, isPdf ? '📕' : '📄');
    const thumb = h('div', { class: 'attach-thumb' }, [
      icon,
      h('div', { class: 'meta' }, [
        h('div', { class: 'fname', title: a.name, text: a.name }),
        h('div', { class: 'fsize', text: a.extracting ? 'PDF 읽는 중…' : fmtSize(a.size) }),
      ]),
      h('button', { class: 'rm', title: '제거', onclick: () => removeAttachment(a.id) }, '✕'),
    ]);
    attachPreviewEl.appendChild(thumb);
  }

  // Warn if images are attached but some enabled models don't support vision.
  const hasImg = pendingAttachments.some((a) => a.kind === 'image');
  if (hasImg) {
    const noVision = enabledModels(settings).filter((m) => !m.vision);
    if (noVision.length) {
      attachPreviewEl.appendChild(h('div', { class: 'attach-warn' },
        `⚠ ${noVision.map((m) => m.label).join(', ')} 은(는) 비전 미지원으로 설정되어 이미지를 받지 않습니다. (설정에서 비전 체크)`));
    }
  }
}

// Build the per-message payload (text + images) for a turn's user message.
function userPayload(turn) {
  let content = turn.user || '';
  const images = [];
  for (const a of turn.attachments || []) {
    if (a.kind === 'image' && a.dataUrl) images.push(a.dataUrl);
    else if (a.kind === 'text' && a.text != null) {
      content += `${content ? '\n\n' : ''}[첨부 파일: ${a.name}]\n\`\`\`\n${a.text}\n\`\`\``;
    }
  }
  return { content: content || '(첨부 파일을 참고해 답해주세요)', images };
}

function setViewButtons() {
  document.querySelectorAll('#viewToggle .seg-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.view === settings.viewMode);
  });
}

// =====================================================================
//  Sidebar / chats
// =====================================================================
function renderChatList() {
  chatListEl.innerHTML = '';
  let list = chats;
  if (chatSearchTerm) {
    const term = chatSearchTerm.toLowerCase();
    list = chats.filter((c) =>
      c.title.toLowerCase().includes(term) ||
      (searchMatchIds && searchMatchIds.has(c.id)));
  }
  if (!chats.length) {
    chatListEl.appendChild(h('p', { class: 'hint', text: '채팅이 없습니다. 새 채팅을 시작하세요.' }));
    return;
  }
  if (!list.length) {
    chatListEl.appendChild(h('p', { class: 'chat-search-empty', text: `"${chatSearchTerm}" 검색 결과가 없습니다.` }));
    return;
  }

  // Group: pinned first (no folder header), then by folder.
  const pinned = list.filter((c) => c.pinned);
  const rest = list.filter((c) => !c.pinned);
  if (pinned.length) {
    chatListEl.appendChild(h('div', { class: 'chat-group-label' }, '📌 고정됨'));
    pinned.forEach((c) => chatListEl.appendChild(chatItem(c)));
  }
  // folders among the rest
  const folders = new Map();
  const noFolder = [];
  for (const c of rest) {
    if (c.folder) {
      if (!folders.has(c.folder)) folders.set(c.folder, []);
      folders.get(c.folder).push(c);
    } else noFolder.push(c);
  }
  for (const [name, items] of [...folders.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    chatListEl.appendChild(h('div', { class: 'chat-group-label' }, `📁 ${name}`));
    items.forEach((c) => chatListEl.appendChild(chatItem(c)));
  }
  if (noFolder.length) {
    if (folders.size || pinned.length) chatListEl.appendChild(h('div', { class: 'chat-group-label' }, '채팅'));
    noFolder.forEach((c) => chatListEl.appendChild(chatItem(c)));
  }
}

function chatItem(c) {
  const item = h('div', {
    class: 'chat-item' + (currentChat && c.id === currentChat.id ? ' active' : ''),
    onclick: () => openChat(c.id),
    ondblclick: (e) => { e.stopPropagation(); beginRename(c, item); },
  }, [
    h('span', { class: 'pin' + (c.pinned ? ' on' : ''), title: c.pinned ? '고정 해제' : '고정',
      onclick: (e) => { e.stopPropagation(); togglePin(c); } }, c.pinned ? '📌' : '📍'),
    h('span', { class: 'title', title: c.title, text: c.title }),
    h('span', { class: 'acts' }, [
      h('span', { class: 'fld', title: '폴더 지정',
        onclick: (e) => { e.stopPropagation(); assignFolder(c, item); } }, '📁'),
      h('span', { class: 'ren', title: '이름 변경',
        onclick: (e) => { e.stopPropagation(); beginRename(c, item); } }, '✎'),
      h('span', { class: 'del', title: '삭제',
        onclick: async (e) => { e.stopPropagation(); await removeChat(c.id); } }, '🗑'),
    ]),
  ]);
  return item;
}

async function togglePin(c) {
  c.pinned = !c.pinned;
  await updateChatMeta(session.id, session.key, c);
  scheduleSync();
  renderChatList();
}

function assignFolder(c, item) {
  item.innerHTML = '';
  const input = h('input', {
    class: 'rename-input', type: 'text',
    value: c.folder || '', placeholder: '폴더 이름 (비우면 폴더 해제)',
  });
  const commit = async (save) => {
    if (save) {
      const v = input.value.trim().slice(0, 30);
      if (v !== (c.folder || '')) {
        c.folder = v;
        await updateChatMeta(session.id, session.key, c);
        scheduleSync();
      }
    }
    renderChatList();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(true); }
    else if (e.key === 'Escape') { e.preventDefault(); commit(false); }
  });
  input.addEventListener('blur', () => commit(true));
  input.addEventListener('click', (e) => e.stopPropagation());
  item.appendChild(input);
  input.focus();
  input.select();
}

function beginRename(c, item) {
  item.innerHTML = '';
  const input = h('input', { class: 'rename-input', type: 'text', value: c.title });
  const commit = async (save) => {
    if (save) {
      const v = input.value.trim();
      if (v && v !== c.title) {
        c.title = v.slice(0, 80);
        await updateChatMeta(session.id, session.key, c);
        scheduleSync();
        if (currentChat && currentChat.id === c.id) chatTitleEl.textContent = c.title;
      }
    }
    renderChatList();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(true); }
    else if (e.key === 'Escape') { e.preventDefault(); commit(false); }
  });
  input.addEventListener('blur', () => commit(true));
  input.addEventListener('click', (e) => e.stopPropagation());
  item.appendChild(input);
  input.focus();
  input.select();
}

// ----- Chat search (title + decrypted content) -----
let searchDebounce = null;
function onChatSearchInput() {
  chatSearchTerm = chatSearchEl.value.trim();
  if (searchDebounce) clearTimeout(searchDebounce);
  if (!chatSearchTerm) { searchMatchIds = null; renderChatList(); return; }
  // immediate title-only filter, then async content search
  renderChatList();
  searchDebounce = setTimeout(runContentSearch, 250);
}

async function runContentSearch() {
  const term = chatSearchTerm.toLowerCase();
  if (!term || !session) return;
  const matches = new Set();
  // search decrypted turn content per chat (lazy; fine for thousands of chats)
  for (const c of chats) {
    if (c.title.toLowerCase().includes(term)) { matches.add(c.id); continue; }
    try {
      const ts = await listTurns(c.id, session.key);
      if (ts.some((t) => {
        if ((t.user || '').toLowerCase().includes(term)) return true;
        if ((t.attachments || []).some((a) =>
          (a.name || '').toLowerCase().includes(term) ||
          (a.kind === 'text' && (a.text || '').toLowerCase().includes(term)))) return true;
        const rs = t.responses || {};
        return Object.values(rs).some((r) => (r.text || '').toLowerCase().includes(term))
          || (t.master && (t.master.text || '').toLowerCase().includes(term));
      })) matches.add(c.id);
    } catch { /* skip */ }
    if (chatSearchTerm.toLowerCase() !== term) return; // term changed; abort
  }
  searchMatchIds = matches;
  renderChatList();
}

async function newChat() {
  // A fresh room forgets prior context → saves tokens.
  currentChat = null;
  turns = [];
  chatTitleEl.textContent = '';
  // Web search defaults ON for a new conversation.
  settings.webSearchEnabled = true;
  applyWebSearchButton();
  persistSettings();
  renderChatList();
  renderMessages();
  promptInput.focus();
}

async function openChat(id) {
  currentChat = chats.find((c) => c.id === id) || null;
  if (!currentChat) return;
  turns = await listTurns(id, session.key);
  chatTitleEl.textContent = currentChat.title;
  renderChatList();
  renderMessages();
  closeDrawer();
}

async function removeChat(id) {
  if (!confirm('이 채팅을 삭제할까요?')) return;
  await deleteChat(id);
  scheduleSync();
  chats = chats.filter((c) => c.id !== id);
  if (currentChat && currentChat.id === id) {
    // The currently-open chat was deleted → return to an empty (no-chat) state.
    currentChat = null;
    turns = [];
    chatTitleEl.textContent = '';
  }
  renderChatList();
  renderMessages();
}

// =====================================================================
//  Composer chips
// =====================================================================
function renderChips() {
  modelChipsEl.innerHTML = '';
  for (const m of settings.models) {
    const chip = h('span', {
      class: 'chip ' + (m.enabled ? 'on' : 'off'),
      title: '클릭하여 이 모델 켜기/끄기',
      onclick: () => toggleModelChip(m),
    }, [
      h('span', { class: 'badge', style: `background:${MODEL_META[m.type].color}` }),
      m.label + (settings.masterId === m.id ? ' 👑' : ''),
    ]);
    modelChipsEl.appendChild(chip);
  }
}


function toggleModelChip(model) {
  const disablingMaster = model.enabled && settings.masterEnabled && settings.masterId === model.id;
  model.enabled = !model.enabled;
  if (disablingMaster) {
    settings.masterEnabled = false;
    masterToggle.checked = false;
    showInlineNotice('마스터 모델을 제외하면 마스터 기능이 꺼집니다.');
  }
  persistSettings();
  renderChips();
  renderUsage();
}

function showInlineNotice(message) {
  document.querySelector('.inline-notice-layer')?.remove();
  const layer = h('div', { class: 'inline-notice-layer', onclick: () => layer.remove() });
  const notice = h('div', { class: 'inline-notice', role: 'alert' }, [
    h('span', { text: message }),
    h('button', { type: 'button', text: '확인', onclick: (e) => { e.stopPropagation(); layer.remove(); } }),
  ]);
  notice.addEventListener('click', (e) => e.stopPropagation());
  layer.appendChild(notice);
  document.body.appendChild(layer);
}
// =====================================================================
//  Monthly usage estimate (sidebar)
// =====================================================================
function fmtUsd(n) {
  if (!n) return '$0.00';
  if (n < 0.01) return '<$0.01';
  return '$' + n.toFixed(2);
}

function renderUsage() {
  const panel = $('#usagePanel');
  if (!panel) return;
  // Cloud models only (local LLMs are free and excluded).
  const cloud = settings.models.filter((m) => m.type !== 'local');
  const { total, perModel } = getUsage(settings);
  const enabledCloud = cloud.filter((m) => m.enabled);

  // Hide entirely if nothing to show yet.
  if (total <= 0 && !enabledCloud.length) { panel.hidden = true; return; }
  panel.hidden = false;

  $('#usageTotal').textContent = fmtUsd(total);

  const list = $('#usageList');
  list.innerHTML = '';
  for (const m of enabledCloud) {
    const cost = perModel[m.id]?.cost || 0;
    list.appendChild(h('div', { class: 'usage-row' }, [
      h('span', { class: 'um-name' }, [
        h('span', { class: 'um-dot', style: `background:${MODEL_META[m.type].color}` }),
        m.label,
      ]),
      h('span', { class: 'um-cost', text: fmtUsd(cost) }),
    ]));
  }
}

async function doResetUsage() {
  if (!confirm('누적 사용량을 0으로 초기화할까요? (대화 기록은 유지됩니다)')) return;
  resetUsage(settings);
  await persistSettings();
  renderUsage();
}

// =====================================================================
//  Render messages (split / unified)
// =====================================================================
function renderMessages() {
  messagesEl.innerHTML = '';
  if (!turns.length) {
    messagesEl.appendChild(emptyState());
    return;
  }
  for (const turn of turns) messagesEl.appendChild(renderTurn(turn));
  scrollToBottom();
}

function emptyState() {
  return h('div', { class: 'empty-state' }, [
    h('h2', { text: '하나의 질문, 여러 지성의 답' }),
    h('p', { text: '한 번 입력하면 모든 모델이 동시에 사고하고, 마스터가 그 모두를 하나로 엮습니다.' }),
    h('ul', {}, [
      h('li', { text: '⬛ 분할 뷰 — 모델별 답변을 나란히 비교' }),
      h('li', { text: '▤ 통합 뷰 + 마스터 요약 — 하나의 결론, 그리고 소수 의견' }),
      h('li', { text: '+ 새 채팅 — 맥락을 비워 토큰을 아끼고 새 주제로 시작' }),
      h('li', { text: '⚙️ 설정 — API 키 · 개인 맞춤 · 로컬 엔드포인트' }),
    ]),
  ]);
}

function modelCard(turn, m, isMaster = false) {
  const key = isMaster ? 'master' : m.id;
  const resp = isMaster ? turn.master : turn.responses[m.id];
  const meta = MODEL_META[m.type];
  const body = h('div', { class: 'card-body md', id: `body-${turn.id}-${key}` });
  applyRespToBody(body, resp, turn, key);

  const stats = h('span', { class: 'card-stats', id: `stats-${turn.id}-${key}` });
  applyStats(stats, resp, m);

  const copyBtn = h('button', {
    class: 'card-act', title: '이 답변 복사',
    onclick: (e) => copyResp(turn, key, e.currentTarget),
  }, '⧉');
  const regenBtn = h('button', {
    class: 'card-act', title: isMaster ? '마스터 요약 재생성' : '이 모델만 재생성',
    onclick: () => regenerate(turn, key),
  }, '↻');

  return h('div', { class: 'model-card' + (isMaster ? ' master-card' : '') }, [
    h('div', { class: 'card-head' }, [
      h('span', { class: 'badge', style: `background:${meta.color}` }),
      isMaster ? h('span', { class: 'crown' }, '👑') : null,
      h('span', {}, isMaster ? `마스터 요약 · ${m.label}` : m.label),
      h('span', { class: 'model-name', text: m.model }),
      h('span', { class: 'card-acts' }, [stats, copyBtn, regenBtn]),
    ]),
    body,
  ]);
}

function applyStats(el, resp, model) {
  el.textContent = '';
  el.title = '';
  if (!resp || resp.status === 'pending' || resp.status === 'streaming' || resp.status === 'error') return;
  const parts = [];
  if (resp.elapsedMs != null) parts.push(`${(resp.elapsedMs / 1000).toFixed(1)}s`);
  const pt = resp.promptTokens || 0;
  const ct = resp.completionTokens || estimateTokens(resp.text || '');
  if (settings.showCost && (pt || ct)) {
    parts.push(`~${fmtTokens(pt + ct)}토큰`);
    // Prefer the live settings model (carries any user price override).
    const live = (model && settings.models.find((x) => x.id === model.id)) || model;
    const cost = estimateCost(live, pt, ct);
    if (cost != null) {
      parts.push(`~$${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(3)}`);
      el.title = `입력 ~${pt.toLocaleString()} · 출력 ~${ct.toLocaleString()} 토큰 (추정)`;
    }
  } else if (resp.text) {
    parts.push(`${resp.text.length.toLocaleString()}자`);
  }
  el.textContent = parts.join(' · ');
}

function fmtTokens(n) {
  if (n < 1000) return String(n);
  return (n / 1000).toFixed(1) + 'K';
}

function refreshCard(turn, key, resp) {
  const b = document.getElementById(`body-${turn.id}-${key}`);
  if (b) applyRespToBody(b, resp, turn, key);
  const s = document.getElementById(`stats-${turn.id}-${key}`);
  if (s) {
    const model = key === 'master'
      ? (turn.models?.[turn.masterId] || settings.models.find((x) => x.id === turn.masterId))
      : (turn.models?.[key] || settings.models.find((x) => x.id === key));
    applyStats(s, resp, model);
  }
}

async function copyResp(turn, key, btn) {
  const resp = key === 'master' ? turn.master : turn.responses[key];
  await copyText(resp?.text || '', btn);
}

// Shared clipboard helper with ✓ feedback on the clicked button.
async function copyText(text, btn) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    if (btn) { const old = btn.textContent; btn.textContent = '✓'; setTimeout(() => { btn.textContent = old; }, 1000); }
  } catch {
    alert('복사에 실패했습니다.');
  }
}

// Put a turn's question back into the composer for editing (does not delete the
// original turn — user can tweak and send as a new message).
function editQuestion(turn) {
  promptInput.value = turn.user || '';
  autoGrow();
  promptInput.focus();
  promptInput.setSelectionRange(promptInput.value.length, promptInput.value.length);
  if (composerEl.classList.contains('expanded')) { /* keep */ }
  promptInput.scrollIntoView({ block: 'nearest' });
}

// Re-send the exact same question as a new message in the current chat.
async function resendQuestion(turn) {
  if (activeController) { alert('진행 중인 응답이 끝난 뒤 다시 시도해주세요.'); return; }
  promptInput.value = turn.user || '';
  autoGrow();
  await send();
}

function applyRespToBody(body, resp, turn, key) {
  body.classList.remove('streaming');
  if (!resp || resp.status === 'pending') {
    body.innerHTML = '<span class="card-status status-wait">대기 중…</span>';
    return;
  }
  if (resp.status === 'streaming') {
    body.classList.add('streaming');
    body.innerHTML = renderMarkdown(resp.text || '');
    return;
  }
  if (resp.status === 'error') {
    body.innerHTML = `<span class="card-status status-err">⚠ ${escapeText(resp.error || '오류')}</span>`;
    return;
  }
  // done
  body.innerHTML = renderMarkdown(resp.text || '');
  // inline citation footnotes [n] + sources block
  if (resp.citations && resp.citations.length) {
    linkifyRefs(body, resp.citations);
    renderCitations(body, resp.citations);
  }
}

// ---- Citations ----
function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); }
  catch { return String(url).slice(0, 40); }
}

// Choose a readable label for a citation. Some providers (e.g. Grok) send a
// numeric/empty title — fall back to the source hostname so the list isn't
// just "1, 2, 3, 4".
function citationLabel(c) {
  const url = typeof c === 'string' ? c : c.url;
  const title = (typeof c === 'object' && c.title) ? String(c.title).trim() : '';
  const useful = title && !/^\d+$/.test(title) && title.length > 1;
  return useful ? title : hostOf(url);
}

function renderCitations(body, citations) {
  const wrap = h('div', { class: 'citations' }, [
    h('div', { class: 'citations-title' }, '🔎 출처'),
  ]);
  const ol = document.createElement('ol');
  citations.forEach((c) => {
    const url = typeof c === 'string' ? c : c.url;
    ol.appendChild(h('li', {}, [
      h('a', { href: url, target: '_blank', rel: 'noopener noreferrer', title: url }, citationLabel(c)),
    ]));
  });
  wrap.appendChild(ol);
  body.appendChild(wrap);
}

// Turn bare [1], [2] references in the answer body into clickable links that
// open the matching source in a new tab.
function linkifyRefs(body, citations) {
  const urlOf = (c) => (typeof c === 'string' ? c : c.url);
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) =>
      /\[\d+\]/.test(n.nodeValue) && !n.parentElement.closest('a, pre, code, .citations')
        ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT,
  });
  const targets = [];
  while (walker.nextNode()) targets.push(walker.currentNode);
  for (const node of targets) {
    const frag = document.createDocumentFragment();
    let last = 0;
    const text = node.nodeValue;
    const re = /\[(\d+)\]/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const n = parseInt(m[1], 10);
      if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      if (n >= 1 && n <= citations.length) {
        const url = urlOf(citations[n - 1]);
        const a = h('a', {
          class: 'cite-ref', href: url, target: '_blank',
          rel: 'noopener noreferrer', title: url,
        }, `[${n}]`);
        frag.appendChild(a);
      } else {
        frag.appendChild(document.createTextNode(m[0]));
      }
      last = m.index + m[0].length;
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    node.parentNode.replaceChild(frag, node);
  }
}

function escapeText(s) {
  const d = document.createElement('div'); d.textContent = s; return d.innerHTML;
}

function turnModels(turn) {
  // models snapshot at send time; fall back to current settings
  return (turn.modelIds || [])
    .map((id) => turn.models?.[id] || settings.models.find((m) => m.id === id))
    .filter(Boolean);
}

function renderTurn(turn) {
  const bubble = h('div', { class: 'user-bubble' });
  if (turn.attachments?.length) {
    const row = h('div', { class: 'bubble-attachments' });
    for (const a of turn.attachments) {
      if (a.kind === 'image' && a.dataUrl) {
        row.appendChild(h('img', { src: a.dataUrl, alt: a.name, title: a.name, onclick: () => window.open(a.dataUrl, '_blank') }));
      } else {
        row.appendChild(h('span', { class: 'bubble-file' }, [(a.mime === 'application/pdf' ? '📕 ' : '📄 ') + a.name]));
      }
    }
    bubble.appendChild(row);
  }
  if (turn.user) bubble.appendChild(document.createTextNode(turn.user));
  const bubbleActions = h('div', { class: 'bubble-actions' }, [
    h('button', { class: 'q-act', title: '질문 복사',
      onclick: (e) => copyText(turn.user || '', e.currentTarget) }, '⧉'),
    h('button', { class: 'q-act', title: '질문 수정 후 다시 보내기',
      onclick: () => editQuestion(turn) }, '✎'),
    h('button', { class: 'q-act', title: '같은 질문 다시 보내기',
      onclick: () => resendQuestion(turn) }, '↻'),
  ]);
  const userRow = h('div', { class: 'user-row' }, [
    h('div', { class: 'user-wrap' }, [bubble, bubbleActions]),
  ]);

  const models = turnModels(turn);
  const masterModel = turn.masterEnabled
    ? (turn.models?.[turn.masterId] || settings.models.find((m) => m.id === turn.masterId))
    : null;

  let answers;
  if (settings.viewMode === 'unified') {
    // UNIFIED: one reading column. Individual model answers are collapsed into
    // an expandable section; if a master summary exists it's shown on top.
    const grid = h('div', { class: 'unified-inner' }, models.map((m) => modelCard(turn, m)));
    const details = h('details', { class: 'unified-details' }, [
      h('summary', {}, `개별 모델 답변 ${models.length}개 펼쳐 보기`),
      grid,
    ]);
    if (masterModel) {
      answers = h('div', { class: 'answers-unified' }, [modelCard(turn, masterModel, true), details]);
    } else {
      // No master → still distinct from split: stacked single column + hint.
      details.open = true;
      answers = h('div', { class: 'answers-unified' }, [
        h('p', { class: 'unified-hint' }, '💡 마스터 요약을 켜면 4개 답을 하나로 합쳐 줍니다. 지금은 개별 답을 펼쳐 보세요.'),
        details,
      ]);
    }
  } else {
    // SPLIT: every model answer side-by-side. Master (if on) spans full width.
    const cards = models.map((m) => modelCard(turn, m));
    if (masterModel) cards.push(modelCard(turn, masterModel, true));
    answers = h('div', { class: 'split-grid' }, cards);
  }

  return h('div', { class: 'turn', id: `turn-${turn.id}` }, [userRow, answers]);
}

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

// =====================================================================
//  Sending — fan-out to all models, then master aggregation
// =====================================================================
function buildHistory(model, currentTurn) {
  // Per-model conversation: only turns where this model answered,
  // keeping clean user/assistant alternation. System = custom prompt.
  const modelId = model.id;
  const allowImages = !!model.vision;
  const msgs = [];
  if (settings.customPrompt.trim()) {
    msgs.push({ role: 'system', content: settings.customPrompt.trim() });
  }
  for (const t of turns) {
    if (t.id === currentTurn.id) continue;
    const r = t.responses?.[modelId];
    if (r && r.status === 'done' && r.text) {
      const p = userPayload(t);
      msgs.push({ role: 'user', content: p.content, images: allowImages ? p.images : [] });
      msgs.push({ role: 'assistant', content: r.text });
    }
  }
  const cur = userPayload(currentTurn);
  msgs.push({ role: 'user', content: cur.content, images: allowImages ? cur.images : [] });
  return msgs;
}

async function send() {
  const text = promptInput.value.trim();
  if ((!text && !pendingAttachments.length) || activeController) return;

  if (pendingAttachments.some((a) => a.extracting)) {
    alert('PDF를 읽는 중입니다. 잠시 후 다시 전송해주세요.');
    return;
  }

  const active = enabledModels(settings);
  if (!active.length) { alert('활성화된 모델이 없습니다. 설정 또는 하단 칩에서 모델을 켜주세요.'); return; }

  const title = text ? text.slice(0, 40) : '첨부 파일';

  // Ensure a chat room exists
  if (!currentChat) {
    currentChat = await createChat(session.id, session.key, title);
    chats.unshift(currentChat);
    chatTitleEl.textContent = currentChat.title;
    renderChatList();
  } else if (turns.length === 0) {
    currentChat.title = title;
    await updateChatMeta(session.id, session.key, currentChat);
    chatTitleEl.textContent = currentChat.title;
    renderChatList();
  }

  // snapshot models meta for stable historical rendering
  const modelsSnap = {};
  for (const m of active) modelsSnap[m.id] = { id: m.id, type: m.type, label: m.label, model: m.model };

  const masterEnabled = settings.masterEnabled &&
    active.some((m) => m.id === settings.masterId);
  const masterModel = active.find((m) => m.id === settings.masterId);
  if (masterEnabled) modelsSnap[masterModel.id] = { id: masterModel.id, type: masterModel.type, label: masterModel.label, model: masterModel.model };

  const turn = {
    id: uid(),
    chatId: currentChat.id,
    createdAt: Date.now(),
    user: text,
    attachments: pendingAttachments.slice(),
    webSearch: !!settings.webSearchEnabled,
    modelIds: active.map((m) => m.id),
    models: modelsSnap,
    responses: Object.fromEntries(active.map((m) => [m.id, { status: 'pending', text: '' }])),
    masterEnabled,
    masterId: settings.masterId,
    master: masterEnabled ? { status: 'pending', text: '' } : null,
  };
  turns.push(turn);
  await addTurn(session.key, turn, session.id);
  scheduleSync();

  promptInput.value = '';
  clearAttachments();
  autoGrow();
  composerEl.classList.remove('expanded');
  renderMessages();
  setSending(true);

  activeController = new AbortController();
  const signal = activeController.signal;

  // Fan-out to all models in parallel
  await Promise.allSettled(active.map((m) => runModel(turn, m, signal)));

  // Master aggregation after all answers
  if (masterEnabled && !signal.aborted) {
    await runMaster(turn, masterModel, active, signal);
  }

  await updateTurn(session.key, turn, session.id);
  setSending(false);
  activeController = null;
  scheduleSync();
}

async function runModel(turn, model, signal) {
  const resp = turn.responses[model.id];

  if (model.type !== 'local' && !model.apiKey) {
    resp.status = 'error';
    resp.error = 'API 키가 설정되지 않았습니다. ⚙️ 설정에서 키를 입력하세요.';
    resp.text = '';
    resp.elapsedMs = undefined;
    refreshCard(turn, model.id, resp);
    return;
  }

  resp.status = 'streaming';
  resp.text = '';
  resp.error = undefined;
  resp.elapsedMs = undefined;
  resp.citations = undefined;
  const startedAt = performance.now();
  refreshCard(turn, model.id, resp);

  try {
    const messages = buildHistory(model, turn);
    resp.promptTokens = estimateTokens(messages.map((m) => m.content || '').join('\n'));
    const useSearch = !!turn.webSearch && supportsWebSearch(model);
    const full = await streamChat(model, messages, {
      signal,
      webSearch: useSearch,
      // Local LLMs don't have a real web-search/citation source, so never
      // attach a sources block for them (avoids odd/garbage citations).
      onCitations: model.type === 'local' ? undefined : (urls) => { resp.citations = urls; },
      onChunk: (_chunk, fullText) => {
        resp.text = fullText;
        const b = document.getElementById(`body-${turn.id}-${model.id}`);
        if (b) { b.classList.add('streaming'); b.innerHTML = renderMarkdown(fullText); }
      },
    });
    resp.text = full;
    resp.status = 'done';
  } catch (err) {
    if (signal.aborted) { resp.status = resp.text ? 'done' : 'error'; resp.error = '중단됨'; }
    else { resp.status = 'error'; resp.error = String(err.message || err); }
  }
  resp.elapsedMs = performance.now() - startedAt;
  resp.completionTokens = estimateTokens(resp.text || '');
  // Accumulate monthly usage (cloud models only; local is free).
  if (resp.status === 'done' && model.type !== 'local') {
    addUsage(settings, model.id, model, resp.promptTokens || 0, resp.completionTokens || 0);
    persistSettings();
    renderUsage();
  }
  refreshCard(turn, model.id, resp);
}

async function runMaster(turn, master, active, signal) {
  if (!turn.master) turn.master = { status: 'pending', text: '' };
  if (master.type !== 'local' && !master.apiKey) {
    turn.master = { status: 'error', error: '마스터 모델 API 키가 없습니다.', text: '' };
    refreshCard(turn, 'master', turn.master);
    return;
  }
  turn.master.status = 'streaming';
  turn.master.text = '';
  turn.master.error = undefined;
  turn.master.elapsedMs = undefined;
  const startedAt = performance.now();
  refreshCard(turn, 'master', turn.master);

  // Build aggregation input from completed answers
  let block = `[질문]\n${turn.user}\n\n[각 모델의 답변]\n`;
  for (const m of active) {
    const r = turn.responses[m.id];
    if (r && r.status === 'done' && r.text) {
      block += `\n### ${m.label}\n${r.text}\n`;
    }
  }

  const instruction =
    '당신은 여러 AI의 답변을 종합하는 편집자입니다. 아래 답변들을 바탕으로 ' +
    "가장 정확하고 유용한 '하나의 최종 답변'을 작성하세요. 그런 다음 마지막에 " +
    "'### 소수 의견' 섹션을 추가해, 다른 모델들과 눈에 띄게 다른 주장을 한 모델이 있으면 " +
    '어떤 모델이 무엇을 다르게 말했는지 1~3줄로 요약하세요. 의미 있는 차이가 없으면 ' +
    "'특이한 소수 의견 없음'이라고 적으세요.";

  const messages = [];
  if (settings.customPrompt.trim()) messages.push({ role: 'system', content: settings.customPrompt.trim() });
  messages.push({ role: 'system', content: instruction });
  messages.push({ role: 'user', content: block });
  turn.master.promptTokens = estimateTokens(messages.map((m) => m.content).join('\n'));

  try {
    const full = await streamChat(master, messages, {
      signal,
      onChunk: (_c, fullText) => {
        turn.master.text = fullText;
        const b = document.getElementById(`body-${turn.id}-master`);
        if (b) { b.classList.add('streaming'); b.innerHTML = renderMarkdown(fullText); }
      },
    });
    turn.master.text = full;
    turn.master.status = 'done';
  } catch (err) {
    if (signal.aborted) { turn.master.status = turn.master.text ? 'done' : 'error'; turn.master.error = '중단됨'; }
    else { turn.master.status = 'error'; turn.master.error = String(err.message || err); }
  }
  turn.master.elapsedMs = performance.now() - startedAt;
  turn.master.completionTokens = estimateTokens(turn.master.text || '');
  if (turn.master.status === 'done' && master.type !== 'local') {
    addUsage(settings, master.id, master, turn.master.promptTokens || 0, turn.master.completionTokens || 0);
    persistSettings();
    renderUsage();
  }
  refreshCard(turn, 'master', turn.master);
}

function setSending(on) {
  sendBtn.style.display = on ? 'none' : '';
  stopBtn.style.display = on ? '' : 'none';
  promptInput.disabled = on;
}

function stop() {
  if (activeController) activeController.abort();
}

async function regenerate(turn, cardKey) {
  if (activeController) { alert('진행 중인 응답이 끝난 뒤 다시 시도해주세요.'); return; }
  activeController = new AbortController();
  const signal = activeController.signal;
  setSending(true);
  try {
    if (cardKey === 'master') {
      const master = settings.models.find((m) => m.id === turn.masterId)
        || turn.models?.[turn.masterId];
      if (master) await runMaster(turn, master, turnModels(turn), signal);
    } else {
      const model = settings.models.find((m) => m.id === cardKey) || turn.models?.[cardKey];
      if (model) await runModel(turn, model, signal);
      // refresh master too if this turn uses one
      if (turn.masterEnabled && !signal.aborted) {
        const master = settings.models.find((m) => m.id === turn.masterId) || turn.models?.[turn.masterId];
        if (master) await runMaster(turn, master, turnModels(turn), signal);
      }
    }
    await updateTurn(session.key, turn, session.id);
  } finally {
    setSending(false);
    activeController = null;
  }
}

// =====================================================================
//  Export conversation as Markdown
// =====================================================================
function buildMarkdownExport() {
  const lines = [];
  lines.push(`# ${currentChat?.title || '대화'}`);
  lines.push('');
  for (const t of turns) {
    lines.push(`## 🙋 질문`);
    if (t.attachments?.length) {
      lines.push(`*첨부: ${t.attachments.map((a) => a.name).join(', ')}*`);
      lines.push('');
    }
    lines.push(t.user || '(첨부만)');
    lines.push('');
    const models = turnModels(t);
    for (const m of models) {
      const r = t.responses?.[m.id];
      if (!r) continue;
      lines.push(`### 🤖 ${m.label} (${m.model})`);
      lines.push(r.status === 'error' ? `> ⚠ ${r.error || '오류'}` : (r.text || ''));
      lines.push('');
    }
    if (t.masterEnabled && t.master) {
      const mm = t.models?.[t.masterId];
      lines.push(`### 👑 마스터 요약${mm ? ` · ${mm.label}` : ''}`);
      lines.push(t.master.status === 'error' ? `> ⚠ ${t.master.error || '오류'}` : (t.master.text || ''));
      lines.push('');
    }
    lines.push('---');
    lines.push('');
  }
  return lines.join('\n');
}

function exportChat() {
  if (!turns.length) { alert('내보낼 대화가 없습니다.'); return; }
  const md = buildMarkdownExport();
  const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const safe = (currentChat?.title || 'chat').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 40);
  const a = h('a', { href: url, download: `${safe}.md` });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// =====================================================================
//  Settings modal
// =====================================================================
function setupSettingsModal() {
  settingsModal.querySelectorAll('[data-close]').forEach((el) =>
    el.addEventListener('click', closeSettings));
  $('#addLocalBtn').addEventListener('click', addLocalRow);
  $('#saveSettingsBtn').addEventListener('click', saveSettingsFromForm);
  $('#resetAllBtn').addEventListener('click', resetEverything);
  $('#deleteAccountBtn').addEventListener('click', deleteCurrentAccount);
  $('#changePwBtn').addEventListener('click', openPwModal);
  $('#backupExportBtn').addEventListener('click', exportBackup);
  $('#backupImportBtn').addEventListener('click', () => {
    if (!$('#backupImportPass').value) {
      $('#saveHint').textContent = '백업 암호를 입력해주세요.';
      $('#backupImportPass').focus();
      return;
    }
    $('#backupFile').click();
  });
  $('#backupFile').addEventListener('change', importBackup);
  setupPwModal();
}

function openSettings() {
  $('#customPrompt').value = settings.customPrompt;
  $('#autoLockInput').value = settings.autoLockMinutes ?? 60;
  $('#backupPass').value = '';
  $('#backupPass2').value = '';
  $('#backupImportPass').value = '';
  $('#showCostToggle').checked = settings.showCost !== false;
  $('#resetUserLabel').textContent = session ? `'${session.displayName}'` : '현재 사용자';
  renderModelSettings();
  refreshStorageInfo();
  $('#saveHint').textContent = '';
  settingsModal.hidden = false;
}
function closeSettings() { settingsModal.hidden = true; }

async function refreshStorageInfo() {
  const el = $('#storageInfo');
  const est = await estimateUsage();
  if (!est || !est.quota) { el.textContent = '저장 공간 정보를 사용할 수 없습니다.'; return; }
  const mb = (n) => (n / 1024 / 1024).toFixed(1);
  const pct = ((est.usage / est.quota) * 100).toFixed(1);
  el.textContent = `사용 중인 저장 공간: ${mb(est.usage)} MB / ${mb(est.quota)} MB (${pct}%)`;
}

function renderModelSettings() {
  const wrap = $('#modelSettings');
  wrap.innerHTML = '';
  for (const m of settings.models) wrap.appendChild(modelSettingRow(m));
  updateAddLocalState();
}

function modelSettingRow(m) {
  const meta = MODEL_META[m.type];
  const isLocal = m.type === 'local';
  const keyField = h('div', { class: 'field full' }, [
    h('label', { text: isLocal ? 'API 키 (선택)' : 'API 키' }),
    h('input', { type: 'password', value: m.apiKey || '', placeholder: isLocal ? '필요 시 입력' : 'sk-...', 'data-id': m.id, 'data-k': 'apiKey' }),
  ]);

  const row = h('div', { class: 'model-row', 'data-row': m.id }, [
    h('div', { class: 'model-row-head' }, [
      h('span', { class: 'badge', style: `background:${meta.color}` }),
      h('span', { class: 'name', text: m.label }),
      h('span', { class: 'spacer' }),
      h('label', { class: 'master-radio' }, [
        h('input', { type: 'radio', name: 'master', value: m.id, ...(settings.masterId === m.id ? { checked: 'checked' } : {}) }),
        '👑 마스터',
      ]),
      h('label', { class: 'master-radio', title: '이 모델이 이미지(비전) 입력을 지원하면 체크하세요. 끄면 이미지를 보내지 않습니다.' }, [
        h('input', { type: 'checkbox', 'data-id': m.id, 'data-k': 'vision', ...(m.vision ? { checked: 'checked' } : {}) }),
        '비전',
      ]),
      h('label', { class: 'master-radio' }, [
        h('input', { type: 'checkbox', 'data-id': m.id, 'data-k': 'enabled', ...(m.enabled ? { checked: 'checked' } : {}) }),
        '사용',
      ]),
      isLocal ? h('button', {
        class: 'icon-btn remove-local', title: '삭제',
        onclick: () => removeLocal(m.id),
      }, '🗑') : null,
    ]),
    h('div', { class: 'model-grid' }, [
      h('div', { class: 'field' }, [
        h('label', { text: '표시 이름' }),
        h('input', { value: m.label, 'data-id': m.id, 'data-k': 'label' }),
      ]),
      h('div', { class: 'field' }, [
        h('label', { text: '모델 이름' }),
        h('input', { value: m.model, 'data-id': m.id, 'data-k': 'model' }),
      ]),
      h('div', { class: 'field full' }, [
        h('label', { text: isLocal ? 'Base URL (Ollama: http://localhost:11434/v1, LM Studio: http://localhost:1234/v1)' : 'Base URL' }),
        h('input', { value: m.baseUrl, 'data-id': m.id, 'data-k': 'baseUrl' }),
      ]),
      keyField,
      isLocal ? null : priceFields(m),
    ]),
  ]);
  return row;
}

// Per-model price override (USD per 1M tokens). Pre-filled with the built-in
// estimate so the user can see and adjust what drives the monthly cost.
function priceFields(m) {
  const p = effectivePrice(m) || { in: '', out: '' };
  return h('div', { class: 'field full price-field' }, [
    h('label', {}, [
      '예상 단가 (USD / 100만 토큰) ',
      h('span', { class: 'help-q', 'data-tip': '월 예상 금액은 각 답변의 추정 토큰 수 × 이 단가로 계산됩니다. 기본값은 공개 가격표 기준이며, 본인 요금제에 맞게 직접 수정할 수 있습니다. (토큰 수도 글자 길이 기반 추정치라 실제 청구액과 다를 수 있어요.)' }, '?'),
    ]),
    h('div', { class: 'price-row' }, [
      h('span', { class: 'price-cap' }, '입력'),
      h('input', { type: 'number', step: '0.01', min: '0', class: 'price-in', value: p.in ?? '', placeholder: '입력', 'data-id': m.id, 'data-k': 'priceIn' }),
      h('span', { class: 'price-cap' }, '출력'),
      h('input', { type: 'number', step: '0.01', min: '0', class: 'price-out', value: p.out ?? '', placeholder: '출력', 'data-id': m.id, 'data-k': 'priceOut' }),
    ]),
  ]);
}

function addLocalRow() {
  if (localCount(settings) >= MAX_LOCAL) return;
  // pull current form edits first so typing a key/name and then adding a
  // local endpoint doesn't wipe the unsaved fields when we re-render.
  readModelForm();
  const idx = localCount(settings) + 1;
  settings.models.push(makeLocalModel(idx));
  renderModelSettings();
}

function removeLocal(id) {
  // pull current form edits first so we don't lose them
  readModelForm();
  settings.models = settings.models.filter((m) => m.id !== id);
  if (settings.masterId === id) settings.masterId = settings.models[0]?.id || null;
  renderModelSettings();
}

function updateAddLocalState() {
  const btn = $('#addLocalBtn');
  const atMax = localCount(settings) >= MAX_LOCAL;
  btn.disabled = atMax;
  btn.style.opacity = atMax ? 0.4 : 1;
  btn.textContent = atMax ? `로컬 최대 ${MAX_LOCAL}개` : '+ 로컬 엔드포인트 추가';
}

function readModelForm() {
  $('#modelSettings').querySelectorAll('input[data-k]').forEach((input) => {
    const m = settings.models.find((x) => x.id === input.dataset.id);
    if (!m) return;
    const k = input.dataset.k;
    if (k === 'enabled' || k === 'vision') m[k] = input.checked;
    else if (k === 'priceIn' || k === 'priceOut') {
      const v = parseFloat(input.value);
      m[k] = Number.isFinite(v) ? v : undefined;
    } else m[k] = input.value;
  });
  const masterRadio = $('#modelSettings').querySelector('input[name="master"]:checked');
  if (masterRadio) settings.masterId = masterRadio.value;
}

function saveSettingsFromForm() {
  settings.customPrompt = $('#customPrompt').value;
  const lock = parseInt($('#autoLockInput').value, 10);
  settings.autoLockMinutes = Number.isFinite(lock) && lock >= 0 ? lock : 60;
  settings.showCost = $('#showCostToggle').checked;
  readModelForm();
  persistSettings();
  masterToggle.checked = settings.masterEnabled;
  applyWebSearchButton();
  resetIdleTimer();
  renderChips();
  renderUsage();
  renderMessages();
  $('#saveHint').textContent = '저장됨 ✓';
  setTimeout(closeSettings, 350);
}

async function resetEverything() {
  const who = session ? `'${session.displayName}'` : '현재 사용자';
  const ok = confirm(
    `${who} 데이터를 정말 초기화할까요?\n\n` +
    '· 저장된 API 키와 설정\n' +
    '· 모든 채팅 기록\n\n' +
    '영구 삭제되며 되돌릴 수 없습니다. (계정은 유지됩니다)'
  );
  if (!ok) return;

  if (activeController) activeController.abort();
  if (session.mode === 'online') {
    const rows = await listChats(session.id, session.key);
    for (const c of rows) await deleteChat(c.id);
  } else {
    await clearUserData(session.id);
  }
  localStorage.removeItem(SETTINGS_PREFIX + session.id);
  settings = defaultSettings();
  await persistSettings();

  // reset in-memory UI state
  chats = [];
  currentChat = null;
  turns = [];

  masterToggle.checked = settings.masterEnabled;
  setViewButtons();
  renderChips();
  renderChatList();
  renderMessages();
  chatTitleEl.textContent = '';

  // refresh the open settings form to defaults
  $('#customPrompt').value = settings.customPrompt;
  renderModelSettings();
  refreshStorageInfo();
  $('#saveHint').textContent = '초기화 완료 ✓';
  if (session.mode === 'online') scheduleSync();
  setTimeout(closeSettings, 600);
}

async function deleteCurrentAccount() {
  if (session && session.mode === 'online') {
    alert('온라인 계정 삭제는 아직 서버 API가 없어 지원하지 않습니다.\n이 기기의 데이터만 지우려면 "내 데이터 초기화"를 사용하세요.');
    return;
  }
  const who = session ? `'${session.displayName}'` : '';
  const ok = confirm(
    `계정 ${who} 을(를) 완전히 삭제할까요?\n\n` +
    '이 계정의 모든 채팅 기록 · 설정 · API 키가 삭제되고\n' +
    '로그인 화면으로 돌아갑니다. 되돌릴 수 없습니다.'
  );
  if (!ok) return;

  if (activeController) activeController.abort();
  const id = session.id;
  await clearUserData(id);
  localStorage.removeItem(SETTINGS_PREFIX + id);
  if (localStorage.getItem(REMEMBER_KEY) && session.displayName === localStorage.getItem(REMEMBER_KEY)) {
    localStorage.removeItem(REMEMBER_KEY);
  }
  clearAutoLoginSession();
  deleteAccount(id);
  clearSessionState();
  showAuthScreen();
}

// =====================================================================
//  Password change
// =====================================================================
function setupPwModal() {
  $('#pwModal').querySelectorAll('[data-pw-close]').forEach((el) =>
    el.addEventListener('click', closePwModal));
  $('#pwSubmitBtn').addEventListener('click', submitPwChange);
  for (const id of ['#pwCurrent', '#pwNew', '#pwNew2']) {
    $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') submitPwChange(); });
  }
}
function openPwModal() {
  if (session && session.mode === 'online' && !session.token) {
    alert('오프라인 상태에서는 비밀번호를 변경할 수 없습니다.\n네트워크에 연결한 뒤 다시 시도해주세요.');
    return;
  }
  $('#pwCurrent').value = '';
  $('#pwNew').value = '';
  $('#pwNew2').value = '';
  $('#pwError').hidden = true;
  $('#pwModal').hidden = false;
  $('#pwCurrent').focus();
}
function closePwModal() { $('#pwModal').hidden = true; }
function showPwError(msg) { const e = $('#pwError'); e.textContent = msg; e.hidden = !msg; }

async function submitPwChange() {
  const cur = $('#pwCurrent').value;
  const nw = $('#pwNew').value;
  const nw2 = $('#pwNew2').value;
  showPwError('');
  if (!cur || !nw) { showPwError('모든 칸을 채워주세요.'); return; }
  if (nw !== nw2) { showPwError('새 비밀번호가 일치하지 않습니다.'); return; }

  const btn = $('#pwSubmitBtn');
  btn.disabled = true;
  const prev = btn.textContent;
  btn.textContent = '변경 중…';
  try {
    if (session.mode === 'online') await changeOnlinePassword(cur, nw);
    else await changeLocalPassword(cur, nw);
    if (!session) return; // a forced logout happened mid-flow
    localStorage.removeItem(LEGACY_AUTOLOGIN_KEY);
    clearAutoLoginSession();
    closePwModal();
    $('#saveHint').textContent = session.mode === 'online'
      ? '비밀번호 변경 완료 ✓ (다른 기기는 새 비밀번호로 다시 로그인해야 합니다)'
      : '비밀번호 변경 완료 ✓';
  } catch (err) {
    showPwError(String(err.message || err));
  } finally {
    btn.disabled = false;
    btn.textContent = prev;
  }
}

// Local-only account: re-encrypt this device's data and commit a new verifier.
async function changeLocalPassword(cur, nw) {
  const { oldKey, newKey, newSalt, iterations } =
    await preparePasswordChange(session.id, cur, nw);
  await reencryptUserData(session.id, oldKey, newKey);
  const env = await encryptJSON(newKey, settings);
  localStorage.setItem(SETTINGS_PREFIX + session.id, JSON.stringify(env));
  await commitPasswordChange(session.id, newKey, newSalt, iterations);
  session.key = newKey;
}

// Online (synced) account. Steps are ordered for safety:
//   1) flush pending + pull so THIS device holds the full, current dataset
//   2) verify the current password and derive the new Key A / Key B
//   3) re-encrypt every local record + settings under the new Key A
//   4) rotate server credentials (this invalidates other devices' tokens and
//      wipes server items) and adopt the fresh token returned for this device
//   5) re-push the whole re-encrypted dataset to overwrite the server
async function changeOnlinePassword(cur, nw) {
  if (!isOnlineSession()) {
    throw new Error('오프라인 상태에서는 비밀번호를 변경할 수 없습니다. 네트워크 연결 후 다시 시도해주세요.');
  }

  // 1) ensure nothing is left unsent and we have everything locally
  try {
    await runSync(session);
  } catch (e) {
    if (e && e.status === 401) { clearAutoLoginSession(); forceLogout('세션이 만료되었습니다. 다시 로그인해주세요.'); return; }
    throw new Error('동기화에 실패해 비밀번호를 바꾸지 못했습니다. 네트워크를 확인하고 다시 시도해주세요.');
  }

  // 2) verify current password + derive the new keys
  const realId = session.id.replace(/^online:/, '');
  const oldKey = session.key;
  const { newKey, newAuthToken, newKdfSalt, iterations } = await onlineChangePassword({
    currentPassword: cur,
    newPassword: nw,
    kdfSalt: session.kdfSalt,
    iterations: session.iterations,
    currentAuthToken: session.authToken,
  });

  // 3) re-encrypt all local data + settings under the new Key A
  await reencryptUserData(session.id, oldKey, newKey);
  const env = await encryptJSON(newKey, settings);
  localStorage.setItem(SETTINGS_PREFIX + session.id, JSON.stringify(env));
  await saveSyncSettings(session.id, newKey, settings);

  // 4) rotate server credentials -> fresh token for this device
  const { token: newToken } = await serverChangePassword({
    token: session.token,
    kdfSalt: newKdfSalt,
    kdfIterations: iterations,
    authToken: newAuthToken,
  });
  session.key = newKey;
  session.authToken = newAuthToken;
  session.kdfSalt = newKdfSalt;
  session.iterations = iterations;
  session.token = newToken;
  await refreshOnlineCache(realId, session.displayName, newKey, newKdfSalt, iterations);

  // 5) re-push the entire re-encrypted dataset to overwrite the server
  await markAllDirty(session.id);
  await setLastSync(session.id, 0);
  await runSync(session);
}

// =====================================================================
//  Encrypted backup (export / import)
// =====================================================================
function getBackupExportPassword() {
  const pass = $('#backupPass').value;
  const pass2 = $('#backupPass2').value;
  if (!pass) throw new Error('백업 암호를 입력해주세요.');
  if (pass.length < 8) throw new Error('백업 암호는 8자 이상이어야 합니다.');
  if (pass !== pass2) throw new Error('백업 암호 확인이 일치하지 않습니다.');
  return pass;
}

function getBackupImportPassword() {
  const pass = $('#backupImportPass').value;
  if (!pass) throw new Error('백업 암호를 입력해주세요.');
  return pass;
}

function clearBackupPasswords() {
  $('#backupPass').value = '';
  $('#backupPass2').value = '';
  $('#backupImportPass').value = '';
}

async function deriveBackupKey(password, saltB64, iterations) {
  return deriveKey(password, fromB64(saltB64), iterations || PBKDF2_ITERATIONS);
}

async function exportBackup() {
  if (!session) return;
  try {
    const backupPassword = getBackupExportPassword();
    const chatsData = await exportUserData(session.id, session.key);
    // Full settings snapshot: API keys, models (incl. price overrides),
    // custom prompt, view/toggle prefs, auto-lock, and accumulated usage.
    const payload = {
      settings: {
        customPrompt: settings.customPrompt,
        masterId: settings.masterId,
        masterEnabled: settings.masterEnabled,
        viewMode: settings.viewMode,
        webSearchEnabled: settings.webSearchEnabled,
        showCost: settings.showCost,
        autoLockMinutes: settings.autoLockMinutes,
        models: settings.models,
        usage: settings.usage || {},
        prompts: settings.prompts || [],
      },
      // legacy top-level fields kept for backward-compat with older backups
      customPrompt: settings.customPrompt,
      models: settings.models,
      chats: chatsData,
    };
    const salt = randomBytes(16);
    const saltB64 = toB64(salt);
    const iterations = PBKDF2_ITERATIONS;
    const backupKey = await deriveBackupKey(backupPassword, saltB64, iterations);
    const env = await encryptJSON(backupKey, payload);
    const file = {
      app: 'apitizer', kind: 'backup', version: BACKUP_VERSION,
      user: session.displayName, exportedAt: new Date().toISOString(),
      kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations, salt: saltB64 },
      data: env,
    };
    const blob = new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const safe = (session.displayName || 'user').replace(/[\\/:*?"<>|]+/g, '_');
    const a = h('a', { href: url, download: `apitizer-backup-${safe}.json` });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    clearBackupPasswords();
    $('#saveHint').textContent = `백업 내보냄 (${chatsData.length}개 채팅) ✓`;
  } catch (err) {
    alert('백업 내보내기 실패: ' + String(err.message || err));
  }
}

async function importBackup(e) {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file || !session) return;
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    if (parsed.app !== 'apitizer' || parsed.kind !== 'backup' || !parsed.data) {
      throw new Error('올바른 API-Tizer 백업 파일이 아닙니다.');
    }
    let payload;
    if (parsed.kdf?.salt) {
      const backupKey = await deriveBackupKey(getBackupImportPassword(), parsed.kdf.salt, parsed.kdf.iterations);
      try {
        payload = await decryptJSON(backupKey, parsed.data);
      } catch {
        throw new Error('백업 암호가 올바르지 않습니다.');
      }
    } else {
      try {
        payload = await decryptJSON(session.key, parsed.data);
      } catch {
        throw new Error('이전 형식 백업입니다. 만든 브라우저의 같은 계정에서만 가져올 수 있습니다. 새 백업으로 다시 내보내 주세요.');
      }
    }
    // Prefer the full settings snapshot (newer backups); fall back to the
    // legacy top-level fields for older backup files.
    const snap = (payload.settings && typeof payload.settings === 'object') ? payload.settings : null;
    const importedModels = snap?.models || payload.models;
    const importedPrompt = snap ? snap.customPrompt : payload.customPrompt;
    const chatCount = (payload.chats || []).length;
    const hasModels = Array.isArray(importedModels) && importedModels.length;
    const hasSettings = !!snap || hasModels || typeof importedPrompt === 'string';

    // 1) Restore chats (only ask if the backup actually has any).
    let n = 0;
    if (chatCount) {
      if (confirm(`백업의 채팅 ${chatCount}개를 현재 계정에 추가할까요? (기존 기록은 유지됩니다)`)) {
        n = await importUserData(session.id, session.key, payload.chats);
      }
    }

    // 2) Restore full settings (API keys, models+단가, 개인 맞춤, 토글, 사용량).
    let settingsRestored = false;
    if (hasSettings) {
      if (confirm('백업의 API 키 · 모델/단가 · 개인 맞춤 · 사용량 등 설정을 적용할까요? (현재 설정을 덮어씁니다)')) {
        const next = { ...settings };
        if (snap) {
          // copy every known setting field that's present
          for (const k of ['customPrompt', 'masterId', 'masterEnabled', 'viewMode',
                            'webSearchEnabled', 'showCost', 'autoLockMinutes', 'models', 'usage', 'prompts']) {
            if (snap[k] !== undefined) next[k] = snap[k];
          }
        } else {
          if (typeof importedPrompt === 'string') next.customPrompt = importedPrompt;
          if (hasModels) next.models = importedModels;
        }
        settings = normalizeSettings(next);
        await persistSettings();
        masterToggle.checked = settings.masterEnabled;
        setViewButtons();
        applyWebSearchButton();
        renderChips();
        renderUsage();
        settingsRestored = true;
      }
    }

    chats = await listChats(session.id, session.key);
    renderChatList();
    renderModelSettings();
    $('#customPrompt').value = settings.customPrompt;
    if (session.mode === 'online' && (n || settingsRestored)) scheduleSync();
    const parts = [];
    if (n) parts.push(`채팅 ${n}개`);
    if (settingsRestored) parts.push('설정·API 키');
    clearBackupPasswords();
    $('#saveHint').textContent = parts.length ? `백업 가져옴 (${parts.join(' · ')}) ✓` : '가져온 항목이 없습니다.';
  } catch (err) {
    alert('백업 가져오기 실패: ' + String(err.message || err));
  }
}
