import {
  defaultSettings, normalizeSettings, MODEL_META, MAX_LOCAL, APP_VERSION,
  MODEL_PRESETS, modelPresetFor,
  localCount, makeLocalModel, enabledModels,
  estimateTokens, estimateCost, effectivePrice, addUsage, getUsage, resetUsage,
  IMAGE_TOKEN_ESTIMATE, checkPricingConsistency,
} from './state.js';
import { masterVerdict, similaritySignal } from './analysis.js';
import {
  createChat, listChats, updateChatMeta, deleteChat,
  addTurn, updateTurn, listTurns, clearUserData, deleteAllChats, estimateUsage,
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
import { createShareLink, loadShareFromLocation, isShareUrl } from './share.js';
import { t, getLang, setLang, applyI18n, onLangChange } from './i18n.js';

// AI system instructions (rich formatting, continuity L0, master editor, cross-check,
// compaction) now live in src/i18n.js so they switch with the UI language.
// Use t('instr.rich' | 'instr.continuity' | 'instr.master' | 'instr.crosscheck' | 'instr.compaction').

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
let dragChatId = null; // id of chat being dragged onto a folder (desktop drag & drop)
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
const chatInstructionsBtn = $('#chatInstructionsBtn');
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
// Self-heal a stale device-wide "desktop" override that would otherwise strand a phone.
// The PC/Mobile toggle persists per-device, and forcing the desktop grid onto a ~390px
// screen removes the hamburger + ⋮ action menu and squishes the two columns, so the whole
// mobile UI reads as "broken". On a genuine phone-width viewport we drop the override and
// fall back to auto (→ mobile). Larger tablets/laptops keep an intentional desktop force.
if (layoutMode === 'desktop' && window.innerWidth > 0 && window.innerWidth <= NARROW_BREAKPOINT) {
  layoutMode = 'auto';
  localStorage.removeItem(LAYOUT_KEY);
}
const THEME_KEY = 'apitizer.theme'; // 'dark' | 'light' (device-level)
let theme = localStorage.getItem(THEME_KEY) || 'dark';
let swipeStart = null;

// =====================================================================
//  Boot
// =====================================================================
// A "#s=" share link opens a self-contained read-only viewer instead of the app /
// login gate — no session, no decryption of the local account, just the shared
// snapshot decrypted from the link fragment.
if (isShareUrl()) {
  enterShareViewer();
} else {
  initAppEvents();
  setupViewportHeight();
  setupSettingsModal();
  setupTooltips();
  setupLayoutToggle();
  setupThemeToggle();
  initAuth();
}

// Dev-only: warn if any model preset's price drifts from the PRICING table (a
// custom-typed model of the same name would then be priced differently). Gated to
// localhost so deployed users never see console noise.
if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
  try {
    const priceIssues = checkPricingConsistency();
    if (priceIssues.length) console.warn('[apitizer] MODEL_PRESETS \u2194 PRICING mismatch:', priceIssues);
  } catch { /* non-fatal dev check */ }
}

function initAppEvents() {
  $('#newChatBtn').addEventListener('click', () => { newChat(); closeDrawer(); });
  $('#brandHomeBtn').addEventListener('click', () => { newChat(); closeDrawer(); });
  $('#settingsBtn').addEventListener('click', () => { openSettings(); closeDrawer(); });
  $('#exportBtn').addEventListener('click', exportChat);
  $('#shareBtn').addEventListener('click', openShareModal);
  $('#compactBtn').addEventListener('click', manualCompact);
  $('#logoutBtn').addEventListener('click', logout);
  $('#resetUsageBtn').addEventListener('click', doResetUsage);
  $('#syncNowBtn').addEventListener('click', () => runSyncSafe());
  sendBtn.addEventListener('click', send);
  stopBtn.addEventListener('click', stop);
  chatInstructionsBtn.addEventListener('click', openChatInstructions);

  // chat instructions modal
  const ciModal = $('#chatInstructionsModal');
  if (ciModal) {
    ciModal.querySelectorAll('[data-chat-instr-close]').forEach(el => el.addEventListener('click', closeChatInstructions));
    $('#chatInstructionsSaveBtn').addEventListener('click', saveChatInstructions);
    // close on backdrop click already handled by data attr? but add
    const backdrop = ciModal.querySelector('.modal-backdrop');
    if (backdrop) backdrop.addEventListener('click', closeChatInstructions);
  }

  // mobile drawer
  $('#menuBtn').addEventListener('click', toggleDrawer);
  $('#sidebarBackdrop').addEventListener('click', closeDrawer);

  webSearchBtn.addEventListener('click', () => {
    settings.webSearchEnabled = !settings.webSearchEnabled;
    applyWebSearchButton();
    persistSettings();
  });

  chatSearchEl.addEventListener('input', onChatSearchInput);

  promptInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !isMobileLayout()) { e.preventDefault(); send(); }
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
      btn.textContent = t('copy.copied');
      btn.classList.add('copied');
      setTimeout(() => { btn.textContent = prev; btn.classList.remove('copied'); }, 1200);
    } catch {
      alert(t('copy.fail_clip'));
    }
  });

  // Global keyboard shortcuts
  document.addEventListener('keydown', onGlobalKeydown);
  setupDrawerGestures();
  window.addEventListener('popstate', onAppBack);
}

function setupViewportHeight() {
  const update = () => {
    const vv = window.visualViewport;
    const height = vv?.height || window.innerHeight;
    document.documentElement.style.setProperty('--app-height', `${height}px`);
    document.documentElement.style.setProperty('--vv-offset-top', `${vv?.offsetTop || 0}px`);
  };
  update();
  window.addEventListener('resize', update, { passive: true });
  window.visualViewport?.addEventListener('resize', update, { passive: true });
  window.visualViewport?.addEventListener('scroll', update, { passive: true });
  promptInput.addEventListener('focus', () => setTimeout(update, 80), { passive: true });
  promptInput.addEventListener('blur', () => setTimeout(update, 80), { passive: true });
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
    const compactModal = document.getElementById('compact-modal');
    const masterSel = document.getElementById('master-select-modal');
    const shareModal = document.getElementById('share-modal');
    if (compactModal) { if (typeof compactModal._resolveClose === 'function') compactModal._resolveClose(); else compactModal.remove(); }
    else if (masterSel) { if (typeof masterSel._resolveClose === 'function') masterSel._resolveClose(); else masterSel.remove(); }
    else if (shareModal) shareModal.remove();
    else if (!$('#chatInstructionsModal').hidden) closeChatInstructions();
    else if (!$('#helpModal').hidden) closeHelp();
    else if (!$('#promptModal').hidden) closePromptModal();
    else if (!$('#pwModal').hidden) closePwModal();
    else if (!settingsModal.hidden) closeSettings();
    else if (document.getElementById('app').classList.contains('drawer-open')) closeDrawer();
  }
}

function openHelp() { $('#helpModal').hidden = false; }
function closeHelp() { $('#helpModal').hidden = true; }

function isMobileLayout() { return document.body.classList.contains('is-mobile'); }

function updatePromptPlaceholder() {
  promptInput.placeholder = t(isMobileLayout() ? 'comp.ph_mobile' : 'comp.ph_desktop');
  autoGrow();
}

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
    list.appendChild(h('p', { class: 'muted', text: t('plib.empty') }));
    return;
  }
  for (const p of prompts) {
    list.appendChild(h('div', { class: 'prompt-item' }, [
      h('div', { class: 'prompt-item-main' }, [
        h('div', { class: 'prompt-item-title', text: p.title || t('plib.untitled') }),
        h('div', { class: 'prompt-item-text', text: p.text || '' }),
      ]),
      h('div', { class: 'prompt-item-acts' }, [
        h('button', { class: 'btn btn-primary btn-sm', title: t('plib.insert_title'),
          onclick: () => insertPrompt(p.id) }, t('plib.insert')),
        h('button', { class: 'q-act', title: t('common.delete'),
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
function openDrawer() { document.getElementById('app').classList.add('drawer-open'); }

function setupDrawerGestures() {
  const app = document.getElementById('app');
  const start = (e) => {
    if (!isMobileLayout() || settingsModal.hidden === false || !$('#helpModal').hidden || !$('#promptModal').hidden) return;
    const t = e.touches?.[0];
    if (!t) return;
    swipeStart = { x: t.clientX, y: t.clientY, at: Date.now(), drawerOpen: app.classList.contains('drawer-open') };
  };
  const move = (e) => {
    if (!swipeStart || !isMobileLayout()) return;
    const t = e.touches?.[0];
    if (!t) return;
    const dx = t.clientX - swipeStart.x;
    const dy = t.clientY - swipeStart.y;
    if (Math.abs(dy) > 80 || Math.abs(dx) < 70) return;
    if (!swipeStart.drawerOpen && dx > 0 && swipeStart.x < window.innerWidth * 0.68) {
      openDrawer();
      swipeStart = null;
    } else if (swipeStart.drawerOpen && dx < 0) {
      closeDrawer();
      swipeStart = null;
    }
  };
  const end = () => { swipeStart = null; };
  app.addEventListener('touchstart', start, { passive: true });
  app.addEventListener('touchmove', move, { passive: true });
  app.addEventListener('touchend', end, { passive: true });
  app.addEventListener('touchcancel', end, { passive: true });
}

function ensureAppHistoryState(screen = 'empty') {
  if (!history.state || !history.state.apitizer) {
    history.replaceState({ apitizer: true, screen }, '');
  }
}

function pushAppHistoryState(screen, chatId = null) {
  if (!isMobileLayout()) return;
  ensureAppHistoryState('empty');
  history.pushState({ apitizer: true, screen, chatId }, '');
}

function onAppBack() {
  if (!session || !isMobileLayout()) return;
  if (document.getElementById('app').classList.contains('drawer-open')) { closeDrawer(); return; }
  if (currentChat) {
    newChat({ skipHistory: true, focus: false });
    history.pushState({ apitizer: true, screen: 'empty' }, '');
  }
}

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
  updatePromptPlaceholder();
  renderUsage();
  const btn = $('#layoutToggle');
  if (btn) {
    btn.hidden = false;
    // Compact icon-only button: auto mode can be overridden once; any forced
    // mode returns to auto so PC/mobile follows the device again.
    btn.textContent = mobile ? '\uD83D\uDDA5\uFE0F' : '\uD83D\uDCF1';
    if (layoutMode === 'auto') {
      btn.setAttribute('aria-label', mobile ? t('top.layout_to_pc_auto') : t('top.layout_to_mobile_auto'));
      btn.setAttribute('data-tip', mobile ? t('top.layout_to_pc_tip') : t('top.layout_to_mobile_tip'));
    } else {
      btn.setAttribute('aria-label', t('top.layout_back_auto'));
      btn.setAttribute('data-tip', t('top.layout_back_auto'));
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
    if (layoutMode === 'auto') {
      localStorage.removeItem(LAYOUT_KEY);
    } else if (layoutMode === 'desktop' && window.innerWidth > 0 && window.innerWidth <= NARROW_BREAKPOINT) {
      // On a genuine phone width, "force desktop" is almost always a slip. Apply it
      // for this session only (don't persist), so a reload can't strand the phone in
      // the desktop grid — complements the boot-time self-heal above.
      localStorage.removeItem(LAYOUT_KEY);
    } else {
      localStorage.setItem(LAYOUT_KEY, layoutMode);
    }
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
    btn.setAttribute('data-tip', theme === 'light' ? t('top.theme_to_dark') : t('top.theme_to_light'));
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
  const verEl = $('#authVersion');
  if (verEl) verEl.textContent = APP_VERSION;
  // Web Crypto (encryption) requires a secure context: localhost or HTTPS.
  // Opening the app via a plain-HTTP LAN address would silently break login,
  // so fail loudly with guidance instead.
  if (!window.crypto || !window.crypto.subtle) {
    applyI18n();
    showAuthError(t('err.no_crypto'));
    $('#authSubmit').disabled = true;
    $('#authUser').disabled = true;
    $('#authPass').disabled = true;
    $('#authPass2').disabled = true;
    return;
  }
  // Always open on the LOGIN view (the first-ever user taps 회원가입).
  applyI18n();
  setupLangControls();
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
  $('#authSubmit').textContent = signupMode ? t('auth.signup') : t('auth.login');
  $('#authSwitchText').textContent = signupMode ? t('auth.switch_to_login') : t('auth.switch_to_signup');
  $('#authToggle').textContent = signupMode ? t('auth.login') : t('auth.signup');
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
    sub.textContent = online ? t('auth.sub_online_short') : t('auth.sub_local');
  }
}

function showAuthError(msg) {
  const el = $('#authError');
  el.textContent = msg;
  el.hidden = !msg;
}

// ---- Language (한국어 / English) ----
function setupLangControls() {
  for (const sel of ['#authLangSelect', '#settingsLangSelect']) {
    const box = $(sel);
    if (!box || box.dataset.wired) continue;
    box.dataset.wired = '1';
    box.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-lang]');
      if (btn) setLang(btn.dataset.lang);
    });
  }
  updateLangButtons();
}
function updateLangButtons() {
  const cur = getLang();
  document.querySelectorAll('#authLangSelect [data-lang], #settingsLangSelect [data-lang]')
    .forEach((b) => b.classList.toggle('active', b.dataset.lang === cur));
}
// Re-localise everything when the language changes at runtime.
function refreshLanguage() {
  applyI18n();
  updateLangButtons();
  applyAuthMode();
  applyLoginMode();
  applyTheme();
  applyLayoutMode(); // also refreshes the prompt placeholder + usage panel
  if (session) {
    updateCompactBtn();
    renderChatTitle();
    renderChatList();
    renderMessages({ keepScroll: true }); // preserve scroll position across a language switch
    const hint = document.querySelector('.sidebar-foot .hint');
    if (hint) hint.textContent = t(session.mode === 'online' ? 'side.foot_online' : 'side.foot_local');
    if (settingsModal && !settingsModal.hidden) {
      readModelForm();     // keep unsaved model-field edits before the rows are rebuilt
      renderModelSettings();
      // applyI18n rebuilt the reset-scope <p> (data-i18n-html), which reset this
      // <strong> back to the generic label — restore the actual user.
      $('#resetUserLabel').textContent = session ? `'${session.displayName}'` : t('reset.current_user');
    }
  }
}
onLangChange(refreshLanguage);

async function submitAuth() {
  const username = $('#authUser').value.trim();
  const password = $('#authPass').value;
  const submitBtn = $('#authSubmit');
  const autoLoginRequested = $('#autoLogin').checked;
  showAuthError('');
  if (!username || !password) { showAuthError(t('err.enter_id_pw')); return; }

  if (authMode === 'login') {
    const waitMs = loginWaitMs(username);
    if (waitMs > 0) {
      showAuthError(t('err.too_many', { wait: formatWait(waitMs) }));
      return;
    }
  }

  submitBtn.disabled = true;
  const prevText = submitBtn.textContent;
  submitBtn.textContent = t('auth.processing');
  try {
    let s;
    if (loginMode === 'online') {
      if (!syncConfigured()) {
        throw new Error(t('err.no_sync_server'));
      }
      if (authMode === 'signup') {
        const pass2 = $('#authPass2').value;
        if (password !== pass2) throw new Error(t('err.pw_mismatch'));
        s = await onlineSignup(username, password, { extractable: autoLoginRequested });
      } else {
        s = await onlineLogin(username, password, { extractable: autoLoginRequested });
      }
    } else if (authMode === 'signup') {
      const pass2 = $('#authPass2').value;
      if (password !== pass2) throw new Error(t('err.pw_mismatch'));
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
  submitBtn.textContent = t('auth.autologin_ing');
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
          showAuthError(t('err.autologin_expired'));
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
    showAuthError(t('err.autologin_read'));
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
  return minutes >= 60 ? t('time.hours', { h: Math.ceil(minutes / 60) }) : t('time.minutes', { m: minutes });
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
  ensureAppHistoryState('empty');
  $('#syncRow').hidden = (s.mode !== 'online');
  const hint = document.querySelector('.sidebar-foot .hint');
  if (hint) {
    hint.textContent = t(s.mode === 'online' ? 'side.foot_online' : 'side.foot_local');
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
      forceLogout(t('err.pw_changed_logout'));
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
    const fresh = chats.find((c) => c.id === currentChat.id);
    if (fresh) {
      currentChat = fresh;  // pick up updated chatPrompt / rich override from sync
      turns = await listTurns(currentChat.id, session.key);
      renderMessages();
    } else {
      currentChat = null; turns = []; renderChatTitle(); renderMessages();
    }
  }
}

function setSyncStatus(state, detail) {
  const el = $('#syncStatus');
  if (!el) return;
  const map = {
    syncing: t('sync.syncing'),
    synced: t('sync.synced'),
    offline: t('sync.offline'),
    error: t('sync.error'),
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
  const importedId = await maybeImportPendingShare();
  renderChatList();
  // On fresh login, land on the empty "new chat" page instead of auto-opening the
  // first (pinned) chat. A pending share import still opens its imported chat.
  if (importedId) {
    await openChat(importedId);
  } else {
    renderChatTitle();
    renderMessages();
    // On mobile, reveal the chat list once so returning users see their history
    // lives in the drawer (on desktop the sidebar is always visible).
    if (chats.length && isMobileLayout()) openDrawer();
  }
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
    forceLogout(t('err.idle_lock'));
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
  if (!confirm(t('confirm.logout'))) return;
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
  const minHeight = parseFloat(getComputedStyle(promptInput).minHeight) || 0;
  const maxHeight = 200; // keep in sync with #promptInput max-height in CSS
  promptInput.style.height = 'auto';
  const full = promptInput.scrollHeight;
  promptInput.style.height = Math.max(minHeight, Math.min(full, maxHeight)) + 'px';
  // Grow with content up to maxHeight, then stop growing and show a scrollbar so the clipped
  // top is reachable by mouse wheel / touch (not only by moving the caret up).
  promptInput.style.overflowY = full > maxHeight ? 'auto' : 'hidden';
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
  // Self-hosted (bundled under /vendor/pdfjs) instead of a CDN, so no third-party script runs
  // in the page context where decrypted data and the crypto key live. Resolved via import.meta.url
  // so the paths hold under any base path (e.g. GitHub Pages' /API-tizer/ subfolder).
  const vendor = new URL('../vendor/pdfjs/', import.meta.url);
  pdfjsPromise = import(new URL('pdf.min.mjs', vendor).href)
    .then((mod) => {
      mod.GlobalWorkerOptions.workerSrc = new URL('pdf.worker.min.mjs', vendor).href;
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
  if (doc.numPages > maxPages) text += t('pdf.trunc', { shown: maxPages, total: doc.numPages });
  return text.trim();
}

async function addFiles(fileList) {
  const files = [...(fileList || [])];
  for (const file of files) {
    if (file.size > MAX_FILE_BYTES) {
      alert(t('file.too_big', { name: file.name, size: fmtSize(MAX_FILE_BYTES) }));
      continue;
    }
    const isImage = file.type.startsWith('image/');
    const isPdf = !isImage && (file.type === 'application/pdf' || /\.pdf$/i.test(file.name));
    const isText = !isImage && !isPdf && (TEXT_EXT.test(file.name) || file.type.startsWith('text/'));
    if (!isImage && !isPdf && !isText) {
      alert(t('file.type_unsupported', { name: file.name }));
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
          if (!a.text) a.text = t('pdf.no_text');
        } catch (err) {
          pendingAttachments = pendingAttachments.filter((x) => x.id !== a.id);
          alert(t('file.pdf_read_fail', { name: file.name }));
        }
      } else {
        const text = await readAsText(file);
        pendingAttachments.push({ id: uid(), name: file.name, mime: file.type || 'text/plain', size: file.size, kind: 'text', text });
      }
    } catch {
      alert(t('file.read_fail', { name: file.name }));
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
        h('div', { class: 'fsize', text: a.extracting ? t('attach.pdf_reading') : fmtSize(a.size) }),
      ]),
      h('button', { class: 'rm', title: t('attach.remove'), onclick: () => removeAttachment(a.id) }, '✕'),
    ]);
    attachPreviewEl.appendChild(thumb);
  }

  // Warn if images are attached but some enabled models don't support vision.
  const hasImg = pendingAttachments.some((a) => a.kind === 'image');
  if (hasImg) {
    const noVision = enabledModels(settings).filter((m) => !m.vision);
    if (noVision.length) {
      attachPreviewEl.appendChild(h('div', { class: 'attach-warn' },
        t('attach.no_vision', { models: noVision.map((m) => m.label).join(', ') })));
    }
  }
}

// Build the per-message payload (text + images) for a turn's user message.
function userPayload(turn, opts = {}) {
  // historyStub: for PAST turns in history, reference attachments by name instead
  // of re-sending image bytes / re-inlining file text every turn (big token saver).
  const stub = !!opts.historyStub;
  let content = turn.user || '';
  const images = [];
  for (const a of turn.attachments || []) {
    if (a.kind === 'image' && a.dataUrl) {
      if (stub) content += `${content ? '\n\n' : ''}${t('payload.attach_img_stub', { name: a.name })}`;
      else images.push(a.dataUrl);
    } else if (a.kind === 'text' && a.text != null) {
      if (stub) content += `${content ? '\n\n' : ''}${t('payload.attach_file_stub', { name: a.name })}`;
      else content += `${content ? '\n\n' : ''}${t('payload.attach_file', { name: a.name, text: a.text })}`;
    }
  }
  return { content: content || t('payload.fallback'), images };
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
    chatListEl.appendChild(h('p', { class: 'hint', text: t('side.empty') }));
    return;
  }
  if (!list.length) {
    chatListEl.appendChild(h('p', { class: 'chat-search-empty', text: t('side.search_empty', { term: chatSearchTerm }) }));
    return;
  }

  // Group: pinned first (no folder header), then by folder.
  const pinned = list.filter((c) => c.pinned);
  const rest = list.filter((c) => !c.pinned);
  if (pinned.length) {
    chatListEl.appendChild(h('div', { class: 'chat-group-label' }, t('side.pinned')));
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
  const searching = !!chatSearchTerm; // while searching, force folders open so matches stay visible
  for (const [name, items] of [...folders.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const collapsed = !searching && isFolderCollapsed(name);
    const wrap = h('div', { class: 'chat-folder' });
    const head = h('div', {
      class: 'chat-group-label folder-head' + (searching ? ' static' : '') + (collapsed ? ' collapsed' : ''),
      title: searching ? '' : (collapsed ? t('folder.expand') : t('folder.collapse')),
      onclick: searching ? undefined : (() => toggleFolderCollapse(name)),
    }, [
      searching ? null : h('span', { class: 'fold-caret', text: collapsed ? '▸' : '▾' }),
      h('span', { class: 'fold-name', text: `📁 ${name}` }),
      h('span', { class: 'fold-count', text: String(items.length) }),
    ]);
    wrap.appendChild(head);
    if (!collapsed) items.forEach((c) => wrap.appendChild(chatItem(c)));
    makeDropZone(wrap, name);
    chatListEl.appendChild(wrap);
  }
  if (noFolder.length) {
    const wrap = h('div', { class: 'chat-folder no-folder' });
    if (folders.size || pinned.length) {
      wrap.appendChild(h('div', { class: 'chat-group-label folder-head static' }, [
        h('span', { class: 'fold-name', text: t('folder.no_folder') }),
      ]));
    }
    noFolder.forEach((c) => wrap.appendChild(chatItem(c)));
    makeDropZone(wrap, ''); // dropping here removes the chat from its folder
    chatListEl.appendChild(wrap);
  }
}

function chatItem(c) {
  const item = h('div', {
    class: 'chat-item' + (currentChat && c.id === currentChat.id ? ' active' : ''),
    draggable: 'true',
    onclick: () => openChat(c.id),
    ondblclick: (e) => { e.stopPropagation(); beginRename(c, item); },
    ondragstart: (e) => {
      // Keep the pin and action buttons (📁 ✎ 🗑) clickable by never starting a
      // drag from them. Note: when grabbing the title, e.target is usually a TEXT
      // node (no .closest), so normalise to its element before testing.
      const el = e.target instanceof Element ? e.target : e.target.parentElement;
      if (el && el.closest('.pin, .acts')) { e.preventDefault(); return; }
      dragChatId = c.id;
      try { e.dataTransfer.setData('text/plain', c.id); e.dataTransfer.effectAllowed = 'move'; } catch { /* older browsers */ }
      item.classList.add('dragging');
    },
    ondragend: () => {
      dragChatId = null;
      item.classList.remove('dragging');
      document.querySelectorAll('.chat-folder.drop-target').forEach((el) => el.classList.remove('drop-target'));
    },
  }, [
    h('span', { class: 'pin' + (c.pinned ? ' on' : ''), title: c.pinned ? t('chat.unpin') : t('chat.pin'),
      onclick: (e) => { e.stopPropagation(); togglePin(c); } }, c.pinned ? '📌' : '📍'),
    h('span', { class: 'title', title: c.title, text: c.title }),
    (c.chatPrompt && c.chatPrompt.trim() || (c.chatRichStyle === true || c.chatRichStyle === false)) ? h('span', { class: 'chat-instr-badge', title: t('chat.has_instr') }, '📝') : null,
    h('span', { class: 'acts' }, [
      h('span', { class: 'fld', title: t('chat.assign_folder'),
        onclick: (e) => { e.stopPropagation(); openFolderMenu(c, e.currentTarget); } }, '📁'),
      h('span', { class: 'ren', title: t('chat.rename'),
        onclick: (e) => { e.stopPropagation(); beginRename(c, item); } }, '✎'),
      h('span', { class: 'del', title: t('chat.delete'),
        onclick: async (e) => { e.stopPropagation(); await removeChat(c.id); } }, '🗑'),
    ]),
    // Mobile-only ⋮ trigger; opens the consolidated action menu (see CSS: hidden on desktop).
    h('span', { class: 'kebab', title: t('chat.more'),
      onclick: (e) => { e.stopPropagation(); openChatActionMenu(c, item, e.currentTarget); } }, '⋮'),
  ]);
  return item;
}

async function togglePin(c) {
  c.pinned = !c.pinned;
  await updateChatMeta(session.id, session.key, c);
  scheduleSync();
  renderChatList();
}

// ----- Folders: move, collapse, drag & drop, picker menu -----
function isFolderCollapsed(name) {
  return Array.isArray(settings.collapsedFolders) && settings.collapsedFolders.includes(name);
}

function toggleFolderCollapse(name) {
  if (!Array.isArray(settings.collapsedFolders)) settings.collapsedFolders = [];
  const i = settings.collapsedFolders.indexOf(name);
  if (i >= 0) settings.collapsedFolders.splice(i, 1);
  else settings.collapsedFolders.push(name);
  persistSettings();
  renderChatList();
}

// Drop a folder from the collapsed set without re-rendering (caller re-renders).
function expandFolder(name) {
  if (!Array.isArray(settings.collapsedFolders)) return;
  const i = settings.collapsedFolders.indexOf(name);
  if (i >= 0) { settings.collapsedFolders.splice(i, 1); persistSettings(); }
}

async function moveChatToFolder(chatId, folderName) {
  const c = chats.find((x) => x.id === chatId);
  if (!c) return;
  const target = (folderName || '').trim().slice(0, 30);
  if ((c.folder || '') === target) return;
  c.folder = target;
  await updateChatMeta(session.id, session.key, c);
  scheduleSync();
  if (target) expandFolder(target); // make sure the destination is open so the move is visible
  renderChatList();
}

// Make a sidebar container accept dropped chats and assign them to `folderName`
// ('' clears the folder). Only reacts to internal chat drags (dragChatId set).
function makeDropZone(el, folderName) {
  el.addEventListener('dragover', (e) => {
    if (dragChatId == null) return; // ignore file/text drags from elsewhere
    e.preventDefault();
    try { e.dataTransfer.dropEffect = 'move'; } catch { /* noop */ }
    el.classList.add('drop-target');
  });
  el.addEventListener('dragleave', (e) => {
    if (!el.contains(e.relatedTarget)) el.classList.remove('drop-target');
  });
  el.addEventListener('drop', (e) => {
    if (dragChatId == null) return;
    e.preventDefault();
    el.classList.remove('drop-target');
    const id = dragChatId;
    dragChatId = null;
    moveChatToFolder(id, folderName);
  });
}

let popupMenuEl = null;
function closePopupMenu() {
  if (popupMenuEl) { popupMenuEl.remove(); popupMenuEl = null; }
  document.removeEventListener('mousedown', onPopupMenuOutside, true);
  document.removeEventListener('keydown', onPopupMenuKey, true);
}
function onPopupMenuOutside(e) {
  if (popupMenuEl && !popupMenuEl.contains(e.target)) closePopupMenu();
}
function onPopupMenuKey(e) {
  if (e.key === 'Escape') { e.preventDefault(); closePopupMenu(); }
}

// Popup menu on the 📁 button: pick an existing folder, remove from folder,
// or create a new one. Replaces the old raw text-only prompt.
function openFolderMenu(c, anchor) {
  closePopupMenu();
  const existing = [...new Set(chats.map((x) => (x.folder || '').trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));

  const menu = h('div', { class: 'folder-menu' });
  menu.addEventListener('click', (e) => e.stopPropagation());
  menu.appendChild(h('div', { class: 'folder-menu-title', text: t('folder.move_to') }));

  const listWrap = h('div', { class: 'folder-menu-list' });
  if (existing.length) {
    for (const name of existing) {
      const isCurrent = (c.folder || '') === name;
      listWrap.appendChild(h('button', {
        class: 'folder-menu-item' + (isCurrent ? ' current' : ''), type: 'button',
        onclick: () => { closePopupMenu(); moveChatToFolder(c.id, name); },
      }, [
        h('span', { class: 'fm-ic', text: '📁' }),
        h('span', { class: 'fm-label', title: name, text: name }),
        isCurrent ? h('span', { class: 'fm-check', text: '✓' }) : null,
      ]));
    }
  } else {
    listWrap.appendChild(h('div', { class: 'folder-menu-empty', text: t('folder.none_yet') }));
  }
  menu.appendChild(listWrap);

  if (c.folder) {
    menu.appendChild(h('button', {
      class: 'folder-menu-item danger', type: 'button',
      onclick: () => { closePopupMenu(); moveChatToFolder(c.id, ''); },
    }, [
      h('span', { class: 'fm-ic', text: '↩' }),
      h('span', { class: 'fm-label', text: t('folder.remove_from') }),
    ]));
  }

  // New-folder row: click swaps it for an inline text input.
  const input = h('input', { class: 'folder-menu-input', type: 'text', maxlength: '30', placeholder: t('folder.new_ph') });
  const inputRow = h('div', { class: 'folder-menu-inputrow' }, [input]);
  const commitNew = () => {
    const v = input.value.trim().slice(0, 30);
    closePopupMenu();
    if (v) moveChatToFolder(c.id, v);
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commitNew(); }
    else if (e.key === 'Escape') { e.preventDefault(); closePopupMenu(); }
  });
  const newRow = h('button', {
    class: 'folder-menu-item new', type: 'button',
    onclick: () => { newRow.replaceWith(inputRow); input.focus(); },
  }, [
    h('span', { class: 'fm-ic', text: '＋' }),
    h('span', { class: 'fm-label', text: t('folder.new') }),
  ]);
  menu.appendChild(newRow);

  showPopupMenu(menu, anchor);
}

// Append a popup menu to the body, position it under `anchor` (clamped to the
// viewport), and wire outside-click / Esc dismissal. Shared by the folder picker
// and the mobile ⋮ chat-action menu (only one popup is open at a time).
function showPopupMenu(menu, anchor) {
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  let left = r.left;
  let top = r.bottom + 4;
  if (left + mw > window.innerWidth - 8) left = window.innerWidth - mw - 8;
  if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 4);
  menu.style.left = Math.max(8, left) + 'px';
  menu.style.top = top + 'px';
  popupMenuEl = menu;
  setTimeout(() => {
    document.addEventListener('mousedown', onPopupMenuOutside, true);
    document.addEventListener('keydown', onPopupMenuKey, true);
  }, 0);
}

// Mobile: a single ⋮ button per chat opens this action menu (pin / rename / move /
// delete) instead of cramming four always-on icons into every row. On desktop the
// same actions live as hover icons + drag-and-drop, so the ⋮ button is hidden there.
function openChatActionMenu(c, item, anchor) {
  closePopupMenu();
  const menu = h('div', { class: 'folder-menu' });
  menu.addEventListener('click', (e) => e.stopPropagation());
  menu.appendChild(h('div', { class: 'chat-menu-name', title: c.title, text: c.title }));

  const mkItem = (cls, icon, label, act) => h('button', {
    class: 'folder-menu-item' + (cls ? ' ' + cls : ''), type: 'button',
    onclick: () => { closePopupMenu(); act(); },
  }, [
    h('span', { class: 'fm-ic', text: icon }),
    h('span', { class: 'fm-label', text: label }),
  ]);

  menu.appendChild(mkItem('', c.pinned ? '📍' : '📌', c.pinned ? t('chat.unpin') : t('chat.pin'), () => togglePin(c)));
  menu.appendChild(mkItem('', '✎', t('chat.rename'), () => beginRename(c, item)));
  menu.appendChild(mkItem('', '📁', t('chat.assign_folder'), () => openFolderMenu(c, anchor)));
  menu.appendChild(mkItem('danger', '🗑', t('chat.delete'), () => { removeChat(c.id); }));

  showPopupMenu(menu, anchor);
}

function beginRename(c, item) {
  item.innerHTML = '';
  item.draggable = false; // don't let the drag handler hijack text selection while editing
  const input = h('input', { class: 'rename-input', type: 'text', value: c.title });
  const commit = async (save) => {
    if (save) {
      const v = input.value.trim();
      if (v && v !== c.title) {
        c.title = v.slice(0, 80);
        await updateChatMeta(session.id, session.key, c);
        scheduleSync();
        if (currentChat && currentChat.id === c.id) renderChatTitle();
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
          || (t.master && (t.master.text || '').toLowerCase().includes(term))
          || (t.kind === 'compaction' && (t.summary || '').toLowerCase().includes(term));
      })) matches.add(c.id);
    } catch { /* skip */ }
    if (chatSearchTerm.toLowerCase() !== term) return; // term changed; abort
  }
  searchMatchIds = matches;
  renderChatList();
}

async function newChat(options = {}) {
  // A fresh room forgets prior context → saves tokens.
  currentChat = null;
  turns = [];
  renderChatTitle();
  applyWebSearchButton(); // reflect the user's persisted web-search preference (don't override it)
  renderChatList();
  renderMessages();
  if (!options.skipHistory) pushAppHistoryState('empty');
  if (options.focus !== false) promptInput.focus();
}

async function openChat(id) {
  currentChat = chats.find((c) => c.id === id) || null;
  if (!currentChat) return;
  turns = await listTurns(id, session.key);
  renderChatTitle();
  renderChatList();
  renderMessages();
  pushAppHistoryState('chat', id);
  closeDrawer();
}

async function removeChat(id) {
  if (!confirm(t('confirm.delete_chat'))) return;
  await deleteChat(id);
  scheduleSync();
  chats = chats.filter((c) => c.id !== id);
  if (currentChat && currentChat.id === id) {
    // The currently-open chat was deleted → return to an empty (no-chat) state.
    currentChat = null;
    turns = [];
    renderChatTitle();
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
      title: t('chip.toggle'),
      onclick: () => toggleModelChip(m),
    }, [
      h('span', { class: 'badge', style: `background:${MODEL_META[m.type]?.color || 'var(--muted)'}` }),
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
    showInlineNotice(t('notice.master_excluded'));
  }
  persistSettings();
  renderChips();
  renderUsage();
}

function showInlineNotice(message) {
  document.querySelector('.inline-notice-layer')?.remove();
  const layer = h('div', { class: 'inline-notice-layer' });
  const notice = h('div', { class: 'inline-notice', role: 'alert' }, [
    h('span', { class: 'inline-notice-msg', text: message }),
    h('button', { type: 'button', text: t('common.ok'), onclick: () => layer.remove() }),
  ]);
  layer.appendChild(notice);
  document.body.appendChild(layer);
  // Auto-dismiss so it doesn't linger; any programmatic .inline-notice-layer removal still works.
  setTimeout(() => layer.remove(), 6000);
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
  panel.classList.add('usage-collapsible');
  if (!panel.dataset.boundToggle) {
    panel.dataset.boundToggle = '1';
    panel.querySelector('.usage-head')?.addEventListener('click', () => {
      panel.classList.toggle('open');
    });
  }
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
  if (!confirm(t('confirm.reset_usage'))) return;
  resetUsage(settings);
  await persistSettings();
  renderUsage();
}

// =====================================================================
//  Render messages (split / unified)
// =====================================================================
function renderMessages(opts = {}) {
  const prevTop = messagesEl.scrollTop;
  messagesEl.innerHTML = '';
  updateCompactBtn();
  if (!turns.length) {
    messagesEl.appendChild(emptyState());
    return;
  }
  for (const turn of turns) messagesEl.appendChild(renderTurn(turn));
  if (opts.keepScroll) messagesEl.scrollTop = prevTop;
  else scrollToBottom();
}

function emptyState() {
  return h('div', { class: 'empty-state' }, [
    h('h2', { text: t('empty.h2') }),
    h('p', { text: t('empty.p') }),
    h('ul', {}, [
      h('li', { text: t('empty.li1') }),
      h('li', { text: t('empty.li2') }),
      h('li', { text: t('empty.li3') }),
      h('li', { text: t('empty.li4') }),
    ]),
  ]);
}

// masterVerdict (the bilingual "### 소수 의견 / Minority opinion" parser) now lives in
// ./analysis.js (imported above) so it can be unit-tested.

// Timeout / abort are detected by matching either language's marker, so control
// flow keeps working after a language switch and for turns saved in the other lang.
function isTimeoutError(msg) { return !!msg && (String(msg).includes('타임아웃') || /timeout/i.test(String(msg))); }
function isAbortError(msg) { return msg === '중단됨' || msg === 'Stopped'; }

// Configure the agreement pill on a turn's master card: ⚠ 이견 (warn) or ✓ 일치 (ok).
function setDissentBadge(el, turn) {
  const v = masterVerdict(turn);
  if (!v) { el.hidden = true; el.textContent = ''; el.title = ''; el.className = 'dissent-badge'; return; }
  el.hidden = false;
  if (v.state === 'dissent') {
    el.className = 'dissent-badge is-dissent';
    el.textContent = t('master.dissent_badge');
    el.title = t('master.dissent_title') + v.text.slice(0, 240);
  } else {
    el.className = 'dissent-badge is-consensus';
    el.textContent = t('master.agree_badge');
    el.title = t('master.agree_title');
  }
}

function masterDissentBadge(turn) {
  const span = h('span', { class: 'dissent-badge', id: `dissent-${turn.id}` });
  setDissentBadge(span, turn);
  return span;
}

// Master card header label — shows the model that actually aggregated (may be a
// substitute if the designated master timed out / failed).
function masterHeadLabel(turn, masterModel) {
  const byId = turn.master?.by;
  if (byId && byId !== masterModel.id) {
    const by = turn.models?.[byId] || settings.models.find((x) => x.id === byId);
    if (by) return t('card.master_head_alt', { by: by.label });
  }
  return t('card.master_head', { label: masterModel.label });
}

function modelCard(turn, m, isMaster = false) {
  const key = isMaster ? 'master' : m.id;
  const resp = isMaster ? turn.master : turn.responses[m.id];
  const meta = MODEL_META[m.type];
  const body = h('div', { class: 'card-body md', id: `body-${turn.id}-${key}` });
  applyRespToBody(body, resp, turn, key);

  const stats = h('span', { class: 'card-stats', id: `stats-${turn.id}-${key}` });
  applyStats(stats, resp, statsModelFor(turn, key));

  const copyBtn = h('button', {
    class: 'card-act', title: t('card.copy_answer'),
    onclick: (e) => copyResp(turn, key, e.currentTarget),
  }, '⧉');
  const regenBtn = h('button', {
    class: 'card-act', title: isMaster ? t('card.regen_master') : t('card.regen_model'),
    onclick: () => regenerate(turn, key),
  }, '↻');

  const verdict = isMaster ? masterVerdict(turn) : null;
  return h('div', { class: 'model-card' + (isMaster ? ' master-card' : '') + (verdict && verdict.state === 'dissent' ? ' has-dissent' : '') }, [
    h('div', { class: 'card-head' }, [
      h('span', { class: 'badge', style: `background:${meta.color}` }),
      isMaster ? h('span', { class: 'crown' }, '👑') : null,
      h('span', isMaster ? { id: `masterhead-${turn.id}` } : {}, isMaster ? masterHeadLabel(turn, m) : m.label),
      h('span', { class: 'model-name', text: m.model }),
      isMaster ? masterDissentBadge(turn) : null,
      h('span', { class: 'card-acts' }, [stats, copyBtn, regenBtn]),
    ]),
    body,
  ]);
}

// Cross-check result card (master-off ensemble feature). Reuses the generic card body.
function crossCheckCard(turn) {
  const cc = turn.crossCheck;
  const body = h('div', { class: 'card-body md', id: `body-${turn.id}-crosscheck` });
  applyRespToBody(body, cc, turn, 'crosscheck');
  const byModel = cc?.by ? (turn.models?.[cc.by] || settings.models.find((x) => x.id === cc.by)) : null;
  const stats = h('span', { class: 'card-stats', id: `stats-${turn.id}-crosscheck` });
  applyStats(stats, cc, byModel);
  const copyBtn = h('button', { class: 'card-act', title: t('crosscheck.copy'), onclick: (e) => copyResp(turn, 'crosscheck', e.currentTarget) }, '⧉');
  return h('div', { class: 'model-card crosscheck-card' }, [
    h('div', { class: 'card-head' }, [
      h('span', {}, t('crosscheck.label')),
      byModel ? h('span', { class: 'model-name', text: byModel.label }) : null,
      h('span', { class: 'card-acts' }, [stats, copyBtn]),
    ]),
    body,
  ]);
}

// Resolve the model to price a card's usage against. For master it's the ACTUAL
// aggregator (turn.master.by), which may differ from the designated masterId after a
// substitution; for crosscheck it's turn.crossCheck.by.
function statsModelFor(turn, key) {
  if (key === 'master') {
    const id = turn.master?.by || turn.masterId;
    return turn.models?.[id] || settings.models.find((x) => x.id === id) || null;
  }
  if (key === 'crosscheck') {
    const id = turn.crossCheck?.by;
    return id ? (turn.models?.[id] || settings.models.find((x) => x.id === id)) : null;
  }
  return turn.models?.[key] || settings.models.find((x) => x.id === key) || null;
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
    parts.push(t('stats.tokens', { n: fmtTokens(pt + ct) }));
    // Prefer the live settings model (carries any user price override).
    const live = (model && settings.models.find((x) => x.id === model.id)) || model;
    const cost = estimateCost(live, pt, ct);
    if (cost != null) {
      parts.push(`~$${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(3)}`);
      el.title = t('stats.io_title', { in: pt.toLocaleString(), out: ct.toLocaleString() });
    }
  } else if (resp.text) {
    parts.push(t('stats.chars', { n: resp.text.length.toLocaleString() }));
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
    applyStats(s, resp, statsModelFor(turn, key));
  }
  if (key === 'master') {
    const d = document.getElementById(`dissent-${turn.id}`);
    if (d) setDissentBadge(d, turn);
    const card = b ? b.closest('.model-card') : null;
    if (card) card.classList.toggle('has-dissent', masterVerdict(turn)?.state === 'dissent');
    const head = document.getElementById(`masterhead-${turn.id}`);
    if (head) {
      const mm = turn.models?.[turn.masterId] || settings.models.find((x) => x.id === turn.masterId);
      if (mm) head.textContent = masterHeadLabel(turn, mm);
    }
  }
}

function refreshMasterProgress(turn) {
  if (!turn.master || (turn.master.status !== 'pending' && turn.master.status !== 'collecting')) return;
  refreshCard(turn, 'master', turn.master);
}

function renderResponseHtml(container, text) {
  container.innerHTML = renderMarkdown(text || '');
  enhanceResponseLinks(container);
}

function enhanceResponseLinks(container) {
  const links = [...container.querySelectorAll('a[href]')];
  for (const a of links) {
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
  }
  const imageLinks = links
    .map((a) => a.href)
    .filter((url, idx, arr) => isPreviewableImageUrl(url) && arr.indexOf(url) === idx)
    .slice(0, 8);
  container.querySelector('.link-previews')?.remove();
  if (!imageLinks.length) return;
  const previews = h('div', { class: 'link-previews' });
  for (const url of imageLinks) {
    previews.appendChild(h('a', { href: url, target: '_blank', rel: 'noopener noreferrer', title: url }, [
      h('img', { src: url, alt: t('img.preview_alt'), loading: 'lazy' }),
    ]));
  }
  container.appendChild(previews);
}

function isPreviewableImageUrl(url) {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) && /\.(png|jpe?g|gif|webp|avif)(?:$|[?#])/i.test(u.pathname + u.search + u.hash);
  } catch {
    return false;
  }
}

async function copyResp(turn, key, btn) {
  const resp = key === 'master' ? turn.master : key === 'crosscheck' ? turn.crossCheck : turn.responses[key];
  await copyText(resp?.text || '', btn);
}

// Shared clipboard helper with ✓ feedback on the clicked button.
async function copyText(text, btn) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    if (btn) { const old = btn.textContent; btn.textContent = '✓'; setTimeout(() => { btn.textContent = old; }, 1000); }
  } catch {
    alert(t('copy.fail'));
  }
}

// Put a turn's question back into the composer for editing (does not delete the
// original turn — user can tweak and send as a new message).
function editQuestion(turn) {
  promptInput.value = turn.user || '';
  autoGrow();
  promptInput.focus();
  promptInput.setSelectionRange(promptInput.value.length, promptInput.value.length);
  promptInput.scrollIntoView({ block: 'nearest' });
}

// Re-send the exact same question as a new message in the current chat.
async function resendQuestion(turn) {
  if (activeController) { alert(t('alert.wait_response')); return; }
  promptInput.value = turn.user || '';
  autoGrow();
  await send();
}

function applyRespToBody(body, resp, turn, key) {
  body.classList.remove('streaming');
  if (!resp || resp.status === 'pending') {
    if (key === 'master') renderMasterProgress(body, turn);
    else body.innerHTML = `<span class="card-status status-wait status-pending">${escapeText(t('status.pending_wait'))}</span>`;
    return;
  }
  if (resp.status === 'streaming') {
    body.classList.add('streaming');
    if (key === 'master' && !resp.text) {
      body.classList.remove('streaming');
      body.innerHTML = `<span class="card-status status-wait">${escapeText(t('status.master_collecting'))}</span>`;
    } else {
      renderResponseHtml(body, resp.text || '');
    }
    return;
  }
  if (resp.status === 'error') {
    body.innerHTML = `<span class="card-status status-err">⚠ ${escapeText(resp.error || t('common.error'))}</span>`;
    return;
  }
  // done
  renderResponseHtml(body, resp.text || '');
  // inline citation footnotes [n] + sources block
  if (resp.citations && resp.citations.length) {
    linkifyRefs(body, resp.citations);
    renderCitations(body, resp.citations);
  }
}

function modelProgressLabel(resp) {
  if (!resp || resp.status === 'pending') return t('statuslabel.pending');
  if (resp.status === 'streaming') return t('statuslabel.streaming');
  if (resp.status === 'done') return t('statuslabel.done');
  if (resp.status === 'error') {
    if (isTimeoutError(resp.error)) return t('statuslabel.timeout');
    return isAbortError(resp.error) ? t('statuslabel.aborted') : t('statuslabel.error');
  }
  return t('statuslabel.waiting');
}

function modelProgressClass(resp) {
  if (!resp || resp.status === 'pending') return 'status-pending';
  if (resp.status === 'streaming') return 'status-streaming';
  if (resp.status === 'done') return 'status-done';
  if (resp.status === 'error') return 'status-error';
  return 'status-pending';
}

function renderMasterProgress(body, turn) {
  const models = turnModels(turn);
  if (!models.length) {
    body.innerHTML = `<span class="card-status status-wait status-pending">${escapeText(t('status.sub_pending'))}</span>`;
    return;
  }
  const wrap = h('div', { class: 'master-progress-list' });
  for (const m of models) {
    const resp = turn.responses?.[m.id];
    wrap.appendChild(h('div', { class: `master-progress-row ${modelProgressClass(resp)}` }, [
      h('span', { class: 'master-progress-dot', style: `background:${MODEL_META[m.type]?.color || 'var(--muted)'}` }),
      h('span', { class: 'master-progress-name', text: m.label }),
      h('span', { class: 'master-progress-state', text: modelProgressLabel(resp) }),
    ]));
  }
  body.textContent = '';
  body.appendChild(wrap);

  // 진행 중이고 일부 모델이라도 완료됐다면, 강제 요약 버튼 제공
  const completed = models.filter((m) => {
    const r = turn.responses?.[m.id];
    return r && r.status === 'done' && r.text;
  });
  const canForceMaster = (turn.master && (turn.master.status === 'pending' || turn.master.status === 'error')) && completed.length > 0;
  if (canForceMaster) {
    const btnText = turn.master.status === 'error' ? t('master.force_error') : t('master.force_now');
    const forceBtn = h('button', {
      class: 'btn btn-sm',
      style: 'margin-top: 8px; font-size: 12px; width: 100%;',
      onclick: (e) => { e.stopPropagation(); triggerEarlyMaster(turn); }
    }, btnText);
    body.appendChild(forceBtn);
  }
}

function triggerEarlyMaster(turn) {
  if (!turn.masterEnabled || !turn.master || (turn.master.status !== 'pending' && turn.master.status !== 'error')) return;
  const master = settings.models.find((m) => m.id === turn.masterId) || turn.models?.[turn.masterId];
  if (!master) return;
  const completed = turnModels(turn).filter((m) => {
    const r = turn.responses?.[m.id];
    return r && r.status === 'done' && r.text;
  });
  if (completed.length === 0) {
    alert(t('alert.no_done_model'));
    return;
  }
  showMasterModelSelector(turn, master, completed).then(async (sel) => {
    if (!sel || sel.selected.length === 0) return;
    if (activeController) { alert(t('alert.wait_task')); return; }
    activeController = new AbortController();
    setSending(true);
    try {
      await runMaster(turn, sel.aggregator, sel.selected, activeController.signal);
      await updateTurn(session.key, turn, session.id);
    } finally {
      setSending(false);
      activeController = null;
    }
  });
}

// On-demand cross-check (master-off): one model identifies agreements/conflicts across answers.
async function triggerCrossCheck(turn) {
  if (turn.crossCheck && turn.crossCheck.status === 'streaming') return;
  if (activeController) { alert(t('alert.wait_task')); return; }
  const completed = turnModels(turn).filter((m) => { const r = turn.responses?.[m.id]; return r && r.status === 'done' && r.text; });
  if (completed.length < 2) { alert(t('alert.need_two_done')); return; }
  const aggregator = pickSummarizerModel();
  if (!aggregator) { showInlineNotice(t('crosscheck.no_key')); return; }
  activeController = new AbortController();
  setSending(true);
  try {
    await runCrossCheck(turn, aggregator, completed, activeController.signal);
    await updateTurn(session.key, turn, session.id);
  } finally {
    setSending(false);
    activeController = null;
  }
}

async function runCrossCheck(turn, aggregator, selectedModels, signal) {
  // Selector candidates come from turn.models snapshots (no apiKey) — re-resolve the live
  // model by id so a model that already answered isn't wrongly rejected as "no API key".
  aggregator = settings.models.find((m) => m.id === aggregator.id) || aggregator;
  if (aggregator.type !== 'local' && !aggregator.apiKey) {
    turn.crossCheck = { status: 'error', error: t('crosscheck.no_key_err'), text: '', by: aggregator.id };
    renderMessages({ keepScroll: true });
    return;
  }
  turn.crossCheck = { status: 'streaming', text: '', by: aggregator.id };
  const cc = turn.crossCheck;
  const startedAt = performance.now();
  renderMessages({ keepScroll: true }); // create/refresh the cross-check card slot in the DOM

  const tset = settings.timeoutMs;
  const timeoutMs = tset > 0 ? tset : 0;
  let ccTimeout = null;
  // Idle timeout: re-armed on any stream activity (incl. reasoning) so a slow aggregator isn't cut off.
  const armCcTimeout = () => {
    if (timeoutMs <= 0) return;
    if (ccTimeout) clearTimeout(ccTimeout);
    ccTimeout = setTimeout(() => {
      if (cc.status === 'streaming' && !cc.text) {
        cc.status = 'error';
        cc.error = t('timeout.secs', { s: Math.round(timeoutMs / 1000) });
        refreshCard(turn, 'crosscheck', cc);
        // Substitute aggregator on timeout, mirroring the master flow.
        const done2 = turnModels(turn).filter((m) => { const r = turn.responses?.[m.id]; return r && r.status === 'done' && r.text; });
        if (done2.length >= 2) {
          showMasterModelSelector(turn, aggregator, done2).then(async (selRes) => {
            if (!selRes || selRes.selected.length < 2) return;
            if (activeController) { alert(t('alert.wait_task')); return; }
            activeController = new AbortController();
            setSending(true);
            try {
              await runCrossCheck(turn, selRes.aggregator, selRes.selected, activeController.signal);
              await updateTurn(session.key, turn, session.id);
            } finally {
              setSending(false);
              activeController = null;
            }
          });
        }
      }
    }, timeoutMs);
  };
  armCcTimeout();

  let block = `${t('block.question')}\n${turn.user}\n\n${t('block.each_model_answer')}\n`;
  for (const m of selectedModels) {
    const r = turn.responses[m.id];
    if (r && r.status === 'done' && r.text) block += `\n### ${m.label}\n${r.text}\n`;
  }
  const messages = [];
  pushSystemLayers(messages, 'master'); // taste + RICH, no continuity L0
  messages.push({ role: 'system', content: t('instr.crosscheck') });
  messages.push({ role: 'user', content: block });
  cc.promptTokens = estimateTokens(messages.map((m) => m.content).join('\n'));

  try {
    const wrapped = new Promise((resolve) => {
      streamChat(aggregator, messages, {
        signal,
        maxTokens: settings.maxTokens,
        onRetry: (attempt, delay) => {
          if (turn.crossCheck !== cc || cc.status !== 'streaming' || cc.text) return;
          const b = document.getElementById(`body-${turn.id}-crosscheck`);
          if (b) { b.classList.remove('streaming'); b.innerHTML = `<span class="card-status status-wait">${escapeText(t('status.retry_busy', { delay: Math.round(delay / 1000), attempt }))}</span>`; }
        },
        onActivity: () => {
          if (turn.crossCheck === cc && cc.status === 'streaming' && !cc.text) armCcTimeout();
        },
        onChunk: (_c, full) => {
          if (turn.crossCheck !== cc || cc.status !== 'streaming') return; // superseded by a newer run
          if (ccTimeout) { clearTimeout(ccTimeout); ccTimeout = null; }
          cc.text = full;
          const b = document.getElementById(`body-${turn.id}-crosscheck`);
          if (b) { b.classList.add('streaming'); renderResponseHtml(b, full); }
        },
      }).then((full) => {
        if (ccTimeout) { clearTimeout(ccTimeout); ccTimeout = null; }
        if (turn.crossCheck === cc && cc.status === 'streaming') { cc.text = full; cc.status = 'done'; }
        resolve();
      }).catch((err) => {
        if (ccTimeout) { clearTimeout(ccTimeout); ccTimeout = null; }
        if (signal.aborted) { cc.status = cc.text ? 'done' : 'error'; cc.error = t('status.aborted'); }
        else { cc.status = 'error'; cc.error = String(err.message || err); }
        resolve();
      });
    });
    let raceTimer = null;
    const timeoutP = timeoutMs > 0 ? new Promise((r) => { raceTimer = setTimeout(r, timeoutMs); }) : Promise.resolve();
    await Promise.race([wrapped, timeoutP]);
    if (raceTimer) { clearTimeout(raceTimer); raceTimer = null; }
  } catch (err) {
    if (signal.aborted) { cc.status = cc.text ? 'done' : 'error'; cc.error = t('status.aborted'); }
    else { cc.status = 'error'; cc.error = String(err.message || err); }
  } finally {
    if (ccTimeout) { clearTimeout(ccTimeout); ccTimeout = null; }
  }
  cc.elapsedMs = performance.now() - startedAt;
  cc.completionTokens = estimateTokens(cc.text || '');
  if (aggregator.type !== 'local' && (cc.promptTokens != null || cc.completionTokens > 0)) {
    addUsage(settings, aggregator.id, aggregator, cc.promptTokens || 0, cc.completionTokens || 0);
    persistSettings(); renderUsage();
  }
  refreshCard(turn, 'crosscheck', cc);
  renderMessages({ keepScroll: true }); // refresh the ensemble bar button state (교차검증 중 → 다시)
}

// Resolves with { aggregator, selected } (aggregator = the model that will summarise,
// selected = whose answers to include), or null if cancelled. Letting the aggregator be
// chosen means a timed-out/failed master can be replaced by another completed model.
function showMasterModelSelector(turn, defaultAggregator, candidates) {
  return new Promise((resolve) => {
    if (!candidates || !candidates.length) { resolve(null); return; }
    const existing = document.getElementById('master-select-modal');
    if (existing && typeof existing._resolveClose === 'function') existing._resolveClose();
    else if (existing) existing.remove();

    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      modal.remove();
      resolve(result);
    };

    const modal = h('div', { id: 'master-select-modal', class: 'modal' });
    modal._resolveClose = () => finish(null);
    modal.appendChild(h('div', { class: 'modal-backdrop', onclick: () => finish(null) }));

    const card = h('div', { class: 'modal-card' });
    card.appendChild(h('div', { class: 'modal-head' }, [
      h('h2', { text: t('selector.title') }),
      h('button', { class: 'icon-btn', onclick: () => finish(null) }, '✕')
    ]));

    const bodyEl = h('div', { class: 'modal-body' });
    bodyEl.appendChild(h('p', { class: 'muted', style: 'margin-bottom:8px; font-size:12px;' },
      t('selector.desc')));

    const defId = candidates.some((m) => m.id === defaultAggregator?.id) ? defaultAggregator.id : candidates[0].id;
    bodyEl.appendChild(h('div', { class: 'sel-group-label' }, t('selector.group_model')));
    const aggRadios = {};
    candidates.forEach((m) => {
      const radio = h('input', { type: 'radio', name: 'aggregator' });
      radio.checked = (m.id === defId);
      aggRadios[m.id] = radio;
      bodyEl.appendChild(h('label', { class: 'opt-row' }, [radio, h('span', { text: m.label })]));
    });

    bodyEl.appendChild(h('div', { class: 'sel-group-label' }, t('selector.group_answers')));
    const checks = {};
    candidates.forEach((m) => {
      const r = turn.responses?.[m.id];
      const cb = h('input', { type: 'checkbox' });
      cb.checked = true;
      checks[m.id] = cb;
      bodyEl.appendChild(h('label', { class: 'opt-row' }, [cb, h('span', { text: `${m.label} (${modelProgressLabel(r)})` })]));
    });
    card.appendChild(bodyEl);

    card.appendChild(h('div', { class: 'modal-foot' }, [
      h('button', { class: 'btn btn-ghost', onclick: () => finish(null) }, t('common.cancel')),
      h('button', {
        class: 'btn btn-primary',
        onclick: () => {
          const selected = candidates.filter((m) => checks[m.id].checked);
          const aggregator = candidates.find((m) => aggRadios[m.id].checked) || candidates.find((m) => m.id === defId);
          finish(selected.length > 0 && aggregator ? { aggregator, selected } : null);
        }
      }, t('selector.run'))
    ]));

    modal.appendChild(card);
    document.body.appendChild(modal);
  });
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
    h('div', { class: 'citations-title' }, t('citations.title')),
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

function renderCompactionCard(turn) {
  const wrap = h('div', { class: 'turn compaction-turn', id: `turn-${turn.id}` });
  const card = h('div', { class: 'compaction-card' }, [
    h('div', { class: 'compaction-head' }, [
      h('span', { class: 'compaction-title' }, t('compaction.card_title', { n: turn.compactedCount || '' })),
      h('span', { class: 'compaction-sub' }, t('compaction.card_sub')),
    ]),
  ]);
  const body = h('div', { class: 'compaction-body md' });
  renderResponseHtml(body, turn.summary || '');
  card.appendChild(h('details', { class: 'compaction-details' }, [
    h('summary', {}, t('compaction.view')),
    body,
  ]));
  wrap.appendChild(card);
  return wrap;
}

// Client-side ensemble agreement signal (no API call): rough expression-similarity across
// the completed answers. The master-off analog of masterVerdict — a free "do the models
// broadly agree?" hint (independent-model agreement correlates with reliability).
// Readiness + optional similarity signal for the master-off ensemble strip.
// Returns null only when there aren't at least 2 models on this turn to compare.
// The strip appears as soon as the turn starts (button disabled) and "lights up"
// once every model has settled — done, or errored/timed-out. The per-model timeout
// flips a hung response to 'error', so `settled` naturally covers the "someone is
// stuck" case the user asked about without any extra timer here.
function ensembleInfo(turn) {
  const models = turnModels(turn);
  if (models.length < 2) return null;
  const resps = models.map((m) => turn.responses?.[m.id]);
  const doneTexts = resps.filter((r) => r && r.status === 'done' && r.text).map((r) => r.text);
  const settled = resps.every((r) => r && (r.status === 'done' || r.status === 'error'));
  const ready = settled && doneTexts.length >= 2;
  return { doneCount: doneTexts.length, total: models.length, settled, ready, sig: ready ? similaritySignal(doneTexts) : null };
}
// similaritySignal (with its ensembleGrams/jaccardSim helpers) now lives in
// ./analysis.js (imported above) so it can be unit-tested.

// The per-turn ensemble strip (shown when master is off). While answers are still
// arriving it stays muted with a disabled 교차검증 button; once every model has
// finished (or timed out) the button lights up and a similarity hint appears.
function renderEnsembleBar(turn, info) {
  const cc = turn.crossCheck;
  const ccRunning = cc && cc.status === 'streaming';
  const enabled = info.ready && !ccRunning;
  const sig = info.sig;

  let cls = 'ensemble-wait', label;
  if (!info.settled) {
    label = t('ensemble.waiting', { done: info.doneCount, total: info.total });
  } else if (!info.ready) {
    label = t('ensemble.insufficient');
  } else if (sig) {
    cls = `ensemble-${sig.state}`;
    label = sig.state === 'agree' ? t('ensemble.agree')
      : sig.state === 'diverge' ? t('ensemble.diverge')
      : t('ensemble.partial');
  } else {
    cls = 'ensemble-ready';
    label = t('ensemble.ready');
  }

  const btnLabel = ccRunning ? t('crosscheck.running')
    : (cc && (cc.status === 'done' || cc.status === 'error')) ? t('crosscheck.again') : t('crosscheck.label');
  const barTitle = info.ready
    ? t('ensemble.tip_ready')
    : t('ensemble.tip_wait');

  const right = [];
  if (info.ready && sig) right.push(h('span', { class: 'ens-score', text: t('ensemble.similarity', { pct: Math.round(sig.score * 100) }) }));
  right.push(h('button', {
    class: 'ens-cc-btn',
    disabled: !enabled,
    title: enabled ? t('crosscheck.btn_enabled') : t('crosscheck.btn_disabled'),
    onclick: (e) => { e.stopPropagation(); triggerCrossCheck(turn); },
  }, btnLabel));

  return h('div', { class: `ensemble-bar ${cls}`, title: barTitle }, [
    h('span', { class: 'ens-label' }, label),
    h('span', { class: 'ens-right' }, right),
  ]);
}

function renderTurn(turn) {
  if (turn.kind === 'compaction') return renderCompactionCard(turn);
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
    h('button', { class: 'q-act', title: t('q.copy'),
      onclick: (e) => copyText(turn.user || '', e.currentTarget) }, '⧉'),
    h('button', { class: 'q-act', title: t('q.edit_resend'),
      onclick: () => editQuestion(turn) }, '✎'),
    h('button', { class: 'q-act', title: t('q.resend'),
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
      h('summary', {}, t('unified.expand', { n: models.length })),
      grid,
    ]);
    if (masterModel) {
      answers = h('div', { class: 'answers-unified' }, [modelCard(turn, masterModel, true), details]);
    } else {
      // No master → still distinct from split: stacked single column + hint.
      details.open = true;
      answers = h('div', { class: 'answers-unified' }, [
        h('p', { class: 'unified-hint' }, t('unified.hint')),
        details,
      ]);
    }
  } else {
    // SPLIT: model answers side-by-side in an auto-fit grid. The master card is
    // rendered as a full-width sibling BELOW the grid (NOT as a grid item spanning
    // 1 / -1) because a spanning item keeps `auto-fit` from collapsing the empty
    // tracks — which used to squeeze the model cards to the left and leave a big
    // empty gap on the right whenever master was on.
    const grid = h('div', { class: 'split-grid' }, models.map((m) => modelCard(turn, m)));
    answers = masterModel
      ? h('div', { class: 'split-wrap' }, [grid, modelCard(turn, masterModel, true)])
      : grid;
  }

  const ens = turn.masterEnabled ? null : ensembleInfo(turn);
  const ensembleBar = ens ? renderEnsembleBar(turn, ens) : null;
  const crossCard = turn.crossCheck ? crossCheckCard(turn) : null;
  return h('div', { class: 'turn', id: `turn-${turn.id}` }, [userRow, ensembleBar, answers, crossCard]);
}

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

// =====================================================================
//  Sending — fan-out to all models, then master aggregation
// =====================================================================

/** Per-turn snapshot: master summary succeeded for this turn (not current settings toggle). */
function turnMasterReady(turn) {
  const m = turn?.master;
  return !!(turn?.masterEnabled && m && m.status === 'done' && m.text && String(m.text).trim());
}

/**
 * Assistant text for a past turn in this model's history.
 * Master success → official synthesis + this model's own answer (hybrid).
 * Else → own answer only. Returns null if this model did not complete that turn.
 * Uses turn.masterEnabled / turn.master only — never settings.masterEnabled.
 */
function assistantTextForHistory(turn, modelId, opts = {}) {
  const compact = !!opts.compact;
  const r = turn.responses?.[modelId];
  const own = (r && r.status === 'done' && r.text) ? r.text : null;
  const masterReady = turnMasterReady(turn);

  if (own && masterReady) {
    const master = String(turn.master.text).trim();
    if (compact) {
      // Old turn: keep only the shared official conclusion (the "spine") and drop
      // the bulky own answer to bound long-conversation token growth.
      return t('hist.prev_synth_user') + '\n' + master;
    }
    // Recent turn — hybrid, MY OWN answer FIRST (identity anchor) then the shared official
    // synthesis (context, explicitly not my words). Own-first ordering curbs convergence toward
    // the consensus while still carrying the synthesis the user's next question is premised on.
    return (
      t('hist.my_answer') + '\n' + own +
      '\n\n' + t('hist.prev_synth_user') + '\n' + master
    );
  }
  if (own) {
    // No master that turn. Recent → full own; old → truncated so it doesn't dominate.
    if (compact && own.length > HISTORY_OLD_OWN_CHARS) {
      return own.slice(0, HISTORY_OLD_OWN_CHARS) + t('hist.prev_answer_trunc');
    }
    return own;
  }
  if (masterReady) {
    // This model missed that turn (timeout/error) but the group reached an official
    // conclusion. Hand it that synthesis so it can rejoin coherently, clearly marked
    // as NOT its own words so it doesn't adopt the master's voice (keeps diversity).
    return (
      t('hist.absent_synth') + '\n' +
      String(turn.master.text).trim()
    );
  }
  return null;
}

/** Most recent successful master text before `beforeTurn` (for runMaster context). */
function latestSuccessfulMasterBefore(beforeTurn) {
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i];
    if (beforeTurn && t.id === beforeTurn.id) continue;
    // Only look at turns strictly BEFORE the target, so regenerating an earlier
    // turn never pulls a later turn's synthesis in as the "previous" official one.
    if (beforeTurn && t.createdAt >= beforeTurn.createdAt) continue;
    if (turnMasterReady(t)) return String(t.master.text).trim();
  }
  return null;
}

/**
 * System layers: optional L0 core, exclusive taste (chat > global), optional RICH.
 * @param {'model'|'master'} kind — model gets CONTINUITY_INSTRUCTION; master gets MASTER_INSTRUCTION later.
 */
function pushSystemLayers(msgs, kind = 'model') {
  if (kind === 'model') {
    msgs.push({ role: 'system', content: t('instr.continuity') });
  }

  const chatPrompt = currentChat?.chatPrompt?.trim() || '';
  if (chatPrompt) {
    // Per-chat taste replaces global customPrompt (one slot only; L0 stays separate).
    msgs.push({ role: 'system', content: chatPrompt });
  } else if (settings.customPrompt.trim()) {
    msgs.push({ role: 'system', content: settings.customPrompt.trim() });
  }

  const chatRich = currentChat && (currentChat.chatRichStyle === true || currentChat.chatRichStyle === false)
    ? currentChat.chatRichStyle
    : null;
  const effectiveRich = chatRich !== null ? chatRich : settings.richStyle;
  if (effectiveRich !== false) {
    msgs.push({ role: 'system', content: t('instr.rich') });
  }
}

// ---- History budgeting (hardcoded) ----
// Driven by estimated TOKENS, not a fixed turn count: turns vary 10–100× in size, so a
// token budget is a sounder unit for "how much recent context to send in full". Recent
// turns are kept FULL (hybrid own + official synthesis) up to ~HISTORY_FULL_TOKENS; older
// turns collapse to the official-synthesis "spine" (own dropped/truncated) so far-back
// decisions still survive cheaply. Attachments are only re-sent for the last few turns.
const HISTORY_FULL_TOKENS = 12000;   // recent turns kept verbatim up to ~this many tokens
const HISTORY_FULL_MAX_TURNS = 20;   // hard cap on full turns (guards pathological tiny-turn counts)
const HISTORY_OLD_OWN_CHARS = 600;   // older turns w/o a master: truncate own answer to this
const HISTORY_ATTACH_TURNS = 2;      // re-send real attachments only for the last N turns

function buildHistory(model, currentTurn) {
  // Per-model conversation: only turns where this model has history.
  // System: L0 continuity → exclusive taste → RICH.
  // Recent turns: hybrid (official synthesis + own). Older turns: official "spine"
  // only (own dropped/truncated). Attachments re-sent only within a short window.
  const modelId = model.id;
  const allowImages = !!model.vision;
  const msgs = [];

  pushSystemLayers(msgs, 'model');

  // If earlier turns were compacted into a summary, inject it once as shared context
  // and skip the turns it already covers.
  const marker = latestCompaction(currentTurn.createdAt);
  if (marker && marker.summary) {
    msgs.push({ role: 'system', content: t('hist.prev_summary') + '\n' + marker.summary });
  }

  // Eligible past turns (strictly before the current one) that this model can carry.
  const past = [];
  for (const t of turns) {
    if (t.kind === 'compaction') continue;
    if (t.id === currentTurn.id) continue;
    // Only turns BEFORE the current one — regenerating an earlier turn must not
    // leak later ("future") turns into its history as if they were past context.
    if (t.createdAt >= currentTurn.createdAt) continue;
    if (marker && t.createdAt <= (marker.coversUpTo ?? marker.createdAt)) continue; // already inside the summary
    if (!assistantTextForHistory(t, modelId)) continue;
    past.push(t);
  }
  const fullIds = new Set();
  let fullTok = 0;
  // Decide FULL vs spine by walking newest→oldest and keeping full until the token
  // budget (the newest eligible turn is always full). Older turns become spine.
  for (let i = past.length - 1; i >= 0 && (past.length - i) <= HISTORY_FULL_MAX_TURNS; i--) {
    const t = past[i];
    const txt = assistantTextForHistory(t, modelId, { compact: false }) || '';
    const tok = estimateTokens(txt) + estimateTokens(userPayload(t, { historyStub: true }).content);
    if (fullIds.size === 0 || fullTok + tok <= HISTORY_FULL_TOKENS) { fullIds.add(t.id); fullTok += tok; }
    else break;
  }
  const attachFrom = Math.max(0, past.length - HISTORY_ATTACH_TURNS);

  past.forEach((t, idx) => {
    const compact = !fullIds.has(t.id);   // outside the recent full-token window → spine only
    const stubAttach = idx < attachFrom;  // older than the attach window → stub attachments
    const assistantText = assistantTextForHistory(t, modelId, { compact });
    if (!assistantText) return;
    const p = userPayload(t, { historyStub: stubAttach });
    msgs.push({ role: 'user', content: p.content, images: (allowImages && !stubAttach) ? p.images : [] });
    msgs.push({ role: 'assistant', content: assistantText });
  });

  const cur = userPayload(currentTurn);
  msgs.push({ role: 'user', content: cur.content, images: allowImages ? cur.images : [] });
  return msgs;
}

// ---- Long-conversation compaction ----
// When a chat gets very long, the user can fold older turns into a single summary.
// The visible chat is NOT deleted — a summary card is inserted, and from then on only
// (summary + recent turns) is sent to the models, which bounds token cost. The summary
// marker is just another (encrypted, synced) turn with kind:'compaction'.
const COMPACT_TOKEN_BUDGET = 16000; // suggest folding once the foldable (old) region ≈ exceeds this many tokens
const COMPACT_KEEP = 10;      // recent turns kept verbatim (not folded into the summary)
const COMPACT_MIN = 6;        // don't bother folding fewer than this many turns

// COMPACTION_INSTRUCTION now lives in src/i18n.js as t('instr.compaction').

// The single compaction marker turn for this chat that precedes `beforeCreatedAt`.
function latestCompaction(beforeCreatedAt = Infinity) {
  let found = null;
  for (const t of turns) {
    if (t.kind !== 'compaction') continue;
    if (t.createdAt >= beforeCreatedAt) continue;
    if (!found || t.createdAt > found.createdAt) found = t;
  }
  return found;
}

// How many real (non-marker) turns exist after the latest compaction.
function uncompactedCount() {
  const m = latestCompaction();
  return turns.filter((t) => t.kind !== 'compaction' && (!m || t.createdAt > m.createdAt)).length;
}

// Estimated size of the region that WOULD be folded now (old turns beyond COMPACT_KEEP):
// { turns, tokens }. That region is re-sent as "spine" on every turn, so its token size
// (not turn count) is the right signal for when folding actually pays off.
function foldableStats() {
  const m = latestCompaction();
  const reals = turns.filter((t) => t.kind !== 'compaction' && (!m || t.createdAt > m.createdAt));
  const foldable = reals.slice(0, Math.max(0, reals.length - COMPACT_KEEP));
  let tokens = 0;
  for (const t of foldable) {
    tokens += estimateTokens(t.user || '');
    if (turnMasterReady(t)) tokens += estimateTokens(String(t.master.text));
    else {
      const first = (t.modelIds || []).map((id) => t.responses?.[id]).find((r) => r && r.status === 'done' && r.text);
      if (first) tokens += estimateTokens(first.text);
    }
  }
  return { turns: foldable.length, tokens };
}

// Prefer the master model as the summarizer; else any usable enabled model; else any usable.
function pickSummarizerModel() {
  const master = settings.models.find((m) => m.id === settings.masterId);
  if (master && (master.type === 'local' || master.apiKey)) return master;
  return settings.models.find((m) => m.enabled && (m.type === 'local' || m.apiKey))
    || settings.models.find((m) => m.type === 'local' || m.apiKey)
    || null;
}

function buildCompactionInput(prevSummary, turnsToCompact) {
  let s = '';
  if (prevSummary) s += t('block.prev_summary_existing') + '\n' + prevSummary + '\n\n';
  s += t('block.to_compress') + '\n';
  turnsToCompact.forEach((t2, i) => {
    const q = (t2.user || t('block.attach_only')).slice(0, 1000);
    let a;
    if (turnMasterReady(t2)) a = String(t2.master.text).trim();
    else {
      const first = (t2.modelIds || []).map((id) => t2.responses?.[id])
        .find((r) => r && r.status === 'done' && r.text);
      a = first ? first.text : t('block.no_response');
    }
    s += `\n#${i + 1}\n${t('block.user_prefix')}: ${q}\n${t('block.summary_prefix')}: ${a.slice(0, 1200)}\n`;
  });
  return s;
}

// Fold older turns into one summary marker (LLM call). Returns true on success.
async function runCompaction(signal) {
  if (!currentChat) return false;
  const chatId = currentChat.id;
  const summarizer = pickSummarizerModel();
  if (!summarizer) { showInlineNotice(t('notice.summ_no_key')); return false; }

  const prev = latestCompaction();
  const reals = turns.filter((t) => t.kind !== 'compaction' && (!prev || t.createdAt > prev.createdAt));
  const toCompact = reals.slice(0, Math.max(0, reals.length - COMPACT_KEEP));
  if (toCompact.length < COMPACT_MIN) return false;

  const input = buildCompactionInput(prev?.summary || '', toCompact);
  const messages = [
    { role: 'system', content: t('instr.compaction') },
    { role: 'user', content: input },
  ];

  showInlineNotice(t('notice.summarizing'));
  let summary = '';
  try {
    summary = await streamChat(summarizer, messages, {
      signal: signal || new AbortController().signal,
      maxTokens: settings.maxTokens,
    });
  } catch (err) {
    document.querySelector('.inline-notice-layer')?.remove();
    if (!(signal && signal.aborted)) showInlineNotice(t('notice.summ_fail', { err: String(err.message || err) }));
    return false;
  }
  if (!summary || !summary.trim()) { showInlineNotice(t('notice.summ_empty')); return false; }
  // If Stop was pressed after the summary text arrived, don't commit a marker
  // (send() also bails, so the message the user was sending isn't lost).
  if (signal && signal.aborted) { document.querySelector('.inline-notice-layer')?.remove(); return false; }

  if (summarizer.type !== 'local') {
    addUsage(settings, summarizer.id, summarizer, estimateTokens(input), estimateTokens(summary));
    persistSettings(); renderUsage();
  }

  const lastCompacted = toCompact[toCompact.length - 1];
  const marker = {
    id: prev?.id || uid(),
    chatId,
    createdAt: lastCompacted.createdAt + 1,
    kind: 'compaction',
    summary: summary.trim(),
    compactedCount: (prev?.compactedCount || 0) + toCompact.length,
    coversUpTo: lastCompacted.createdAt,
    summarizerLabel: summarizer.label,
  };
  await addTurn(session.key, marker, session.id);
  scheduleSync();

  // Only mutate the live view if the user is still on the chat we compacted
  // (they could have switched chats during the summary call). Storage is updated
  // either way, so the marker shows up when they return.
  if (currentChat && currentChat.id === chatId) {
    turns = turns.filter((t) => t.id !== marker.id);
    turns.push(marker);
    turns.sort((a, b) => a.createdAt - b.createdAt);
    currentChat.compactHintAt = 0;
    renderMessages();
    showInlineNotice(t('notice.compacted', { n: marker.compactedCount }));
  }
  return true;
}

// Modal asking whether to compact a long conversation. Resolves 'compact' | 'continue'.
function showCompactionPrompt(tokens) {
  return new Promise((resolve) => {
    const existing = document.getElementById('compact-modal');
    if (existing) existing.remove();
    let settled = false;
    const done = (r) => { if (settled) return; settled = true; modal.remove(); resolve(r); };
    const modal = h('div', { id: 'compact-modal', class: 'modal' });
    modal._resolveClose = () => done('continue');
    modal.appendChild(h('div', { class: 'modal-backdrop', onclick: () => done('continue') }));
    const card = h('div', { class: 'modal-card' }, [
      h('div', { class: 'modal-head' }, [
        h('h2', {}, t('compaction.prompt_title')),
        h('button', { class: 'icon-btn', onclick: () => done('continue') }, '✕'),
      ]),
      h('div', { class: 'modal-body' }, [
        h('p', {}, t('compaction.prompt_p', { k: Math.max(1, Math.round(tokens / 1000)) })),
        h('p', { class: 'muted' }, t('compaction.prompt_muted')),
      ]),
      h('div', { class: 'modal-foot' }, [
        h('button', { class: 'btn btn-ghost', onclick: () => done('continue') }, t('compaction.just_continue')),
        h('button', { class: 'btn btn-primary', onclick: () => done('compact') }, t('compaction.do_summarize')),
      ]),
    ]);
    modal.appendChild(card);
    document.body.appendChild(modal);
  });
}

// Keep the manual "🗜 대화 압축" button visible whenever a chat is open (so it's
// discoverable), but dim it — while staying clickable so its tooltip still works —
// until there's enough older conversation to actually compact.
function updateCompactBtn() {
  const btn = document.getElementById('compactBtn');
  if (!btn) return;
  if (!currentChat) { btn.hidden = true; return; }
  btn.hidden = false;
  const canCompact = (uncompactedCount() - COMPACT_KEEP) >= COMPACT_MIN;
  btn.classList.toggle('is-dim', !canCompact);
  btn.title = canCompact
    ? t('top.compact_title')
    : t('top.compact_title_inactive');
}

// Manual, on-demand compaction (top-bar button) — same fold as the auto prompt.
async function manualCompact() {
  if (activeController) { alert(t('alert.wait_task')); return; }
  if (!currentChat) return;
  if ((uncompactedCount() - COMPACT_KEEP) < COMPACT_MIN) {
    showInlineNotice(t('notice.not_long_enough'));
    return;
  }
  if (!confirm(t('confirm.manual_compact'))) return;
  activeController = new AbortController();
  setSending(true);
  try {
    await runCompaction(activeController.signal);
  } finally {
    setSending(false);
    activeController = null;
    updateCompactBtn();
  }
}

async function send() {
  const text = promptInput.value.trim();
  if ((!text && !pendingAttachments.length) || activeController) return;

  if (pendingAttachments.some((a) => a.extracting)) {
    alert(t('alert.pdf_reading'));
    return;
  }

  const active = enabledModels(settings);
  if (!active.length) { alert(t('alert.no_active_model')); return; }

  // Claim the send lock up-front so a second Enter (e.g. while the compaction prompt
  // is open) can't start an overlapping send. try/finally guarantees cleanup.
  activeController = new AbortController();
  const signal = activeController.signal;
  setSending(true);
  try {
  const title = text ? text.slice(0, 40) : t('chat.attach_title');

  // Ensure a chat room exists
  if (!currentChat) {
    currentChat = await createChat(session.id, session.key, title);
    chats.unshift(currentChat);
    renderChatTitle();
    renderChatList();
  } else if (turns.length === 0) {
    currentChat.title = title;
    await updateChatMeta(session.id, session.key, currentChat);
    renderChatTitle();
    renderChatList();
  }

  // Long conversation? Offer to fold older turns once the re-sent "old context" grows
  // costly (token-based, not a fixed turn count). Re-prompt only after another budget's
  // worth of growth; store the token level so a decline isn't re-nagged every turn.
  if (currentChat && turns.length) {
    const fold = foldableStats();
    const lastHint = currentChat.compactHintAt || 0;
    if (fold.turns >= COMPACT_MIN && fold.tokens >= COMPACT_TOKEN_BUDGET && fold.tokens - lastHint >= COMPACT_TOKEN_BUDGET) {
      const choice = await showCompactionPrompt(fold.tokens);
      if (choice === 'compact') {
        const ok = await runCompaction(signal);
        if (signal.aborted) return;
        if (!ok) currentChat.compactHintAt = fold.tokens; // couldn't compact — don't nag every turn
      } else {
        currentChat.compactHintAt = fold.tokens;
      }
    }
  }

  // snapshot models meta for stable historical rendering
  const modelsSnap = {};
  for (const m of active) modelsSnap[m.id] = { id: m.id, type: m.type, label: m.label, model: m.model };

  let masterEnabled = settings.masterEnabled &&
    active.some((m) => m.id === settings.masterId);
  const masterModel = active.find((m) => m.id === settings.masterId);

  // If the master model has no API key, its summary can only fail. Rather than make the
  // user wait for every model and then hit an error card, quietly skip the master for
  // THIS turn (auto-off) and tell them why — add the key and it works next time.
  if (masterEnabled && masterModel && masterModel.type !== 'local' && !masterModel.apiKey) {
    masterEnabled = false;
    showInlineNotice(t('notice.master_no_key'));
  }
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
  try {
    await addTurn(session.key, turn, session.id);
  } catch (e) {
    turns.pop();
    renderMessages();
    alert(String((e && e.message) || e));
    return;
  }
  scheduleSync();

  promptInput.value = '';
  clearAttachments();
  autoGrow();
  renderMessages();

  // Fan-out to all models in parallel
  await Promise.allSettled(active.map((m) => runModel(turn, m, signal)));

  // Master off → surface the client-side ensemble signal (agreement bar + 교차검증) now.
  if (!masterEnabled) renderMessages();

  // Master aggregation after all answers
  let didEarlyMaster = false;
  if (masterEnabled && !signal.aborted) {
    if (turn.master && turn.master.status === 'done') {
      // 이미 마스터가 완료된 상태에서는 추가 팝업 없이 넘어감
    } else {
      const completed = turnModels(turn).filter((m) => {
        const r = turn.responses[m.id];
        return r && r.status === 'done' && r.text;
      });
      if (completed.length === 0) {
        turn.master.status = 'error';
        turn.master.error = t('master.no_done');
        refreshCard(turn, 'master', turn.master);
      } else if (completed.length === active.length) {
        await runMaster(turn, masterModel, active, signal);
        // Summary failed (server error / blank) even after auto-retries, and it wasn't a timeout
        // (the timeout path already offers this popup) → offer to summarise with another completed
        // model, same as the timeout flow.
        if (!signal.aborted && turn.master?.status === 'error' && !isTimeoutError(turn.master.error)) {
          const done = turnModels(turn).filter((m) => { const r = turn.responses?.[m.id]; return r && r.status === 'done' && r.text; });
          if (done.length > 0) {
            const sel = await showMasterModelSelector(turn, masterModel, done);
            if (sel && sel.selected.length > 0) { await runMaster(turn, sel.aggregator, sel.selected, signal); }
          }
        }
      } else {
        didEarlyMaster = true;
        // 먼저 현재 모델 상태를 저장하고, 팝업이 닫힐 때까지 전송 상태를 유지한다.
        await updateTurn(session.key, turn, session.id);
        const sel = await showMasterModelSelector(turn, masterModel, completed);
        if (sel && sel.selected.length > 0) {
          await runMaster(turn, sel.aggregator, sel.selected, signal);
          await updateTurn(session.key, turn, session.id);
        }
      }
    }
  } else if (masterEnabled && signal.aborted && turn.master?.status === 'pending') {
    turn.master.status = 'error';
    turn.master.error = t('status.aborted');
    refreshCard(turn, 'master', turn.master);
  }

  if (!didEarlyMaster && (!turn.master || turn.master.status !== 'done')) {
    await updateTurn(session.key, turn, session.id);
  }
  } finally {
    setSending(false);
    activeController = null;
    scheduleSync();
  }
}

async function runModel(turn, model, signal) {
  const resp = turn.responses[model.id];

  if (model.type !== 'local' && !model.apiKey) {
    resp.status = 'error';
    resp.error = t('err.model_no_key');
    resp.text = '';
    resp.elapsedMs = undefined;
    refreshCard(turn, model.id, resp);
    refreshMasterProgress(turn);
    return;
  }

  resp.status = 'streaming';
  resp.text = '';
  resp.error = undefined;
  resp.elapsedMs = undefined;
  resp.citations = undefined;
  // Generation token: a late-finishing stream from a superseded run (e.g. this model timed
  // out and was then regenerated) must not clobber the newer response for the same model.
  const respGen = (resp._gen = (resp._gen || 0) + 1);
  const startedAt = performance.now();
  refreshCard(turn, model.id, resp);
  refreshMasterProgress(turn);

  // 모델 응답 타임아웃 (model response timeout) — idle-based: re-armed on any stream
  // activity (including a reasoning model's "thinking" events before visible text), so a
  // slow reasoning model isn't cut off mid-thought. Fires only after timeoutMs of silence.
  const tmo = settings.timeoutMs;
  const timeoutMs = tmo > 0 ? tmo : 0;
  let responseTimeout = null;
  const armResponseTimeout = () => {
    if (timeoutMs <= 0) return;
    if (responseTimeout) clearTimeout(responseTimeout);
    responseTimeout = setTimeout(() => {
      if (resp.status === 'streaming' && !resp.text) {
        resp.status = 'error';
        resp.error = t('timeout.secs', { s: Math.round(timeoutMs / 1000) });
        refreshCard(turn, model.id, resp);
        refreshMasterProgress(turn);
        updateTurn(session.key, turn, session.id).catch(() => {});
      }
    }, timeoutMs);
  };
  armResponseTimeout();

  try {
    const messages = buildHistory(model, turn);
    const imgCount = messages.reduce((n, m) => n + (Array.isArray(m.images) ? m.images.length : 0), 0);
    resp.promptTokens = estimateTokens(messages.map((m) => m.content || '').join('\n'))
      + imgCount * IMAGE_TOKEN_ESTIMATE;
    const useSearch = !!turn.webSearch && supportsWebSearch(model);

    const streamP = streamChat(model, messages, {
      signal,
      webSearch: useSearch,
      maxTokens: settings.maxTokens,
      onRetry: (attempt, delay) => {
        if (resp._gen !== respGen || resp.status !== 'streaming' || resp.text) return;
        const b = document.getElementById(`body-${turn.id}-${model.id}`);
        if (b) { b.classList.remove('streaming'); b.innerHTML = `<span class="card-status status-wait">${escapeText(t('status.retry_busy', { delay: Math.round(delay / 1000), attempt }))}</span>`; }
      },
      onCitations: model.type === 'local' ? undefined : (urls) => { if (resp._gen === respGen) resp.citations = urls; },
      onActivity: () => {
        // Reasoning/keepalive events keep the model "alive" so the idle timeout doesn't fire
        // while it's thinking but hasn't emitted visible text yet.
        if (resp._gen === respGen && resp.status === 'streaming' && !resp.text) armResponseTimeout();
      },
      onChunk: (_chunk, fullText) => {
        if (resp._gen !== respGen || resp.status !== 'streaming') return;
        if (responseTimeout) {
          clearTimeout(responseTimeout);
          responseTimeout = null;
        }
        resp.text = fullText;
        const b = document.getElementById(`body-${turn.id}-${model.id}`);
        if (b) { b.classList.add('streaming'); renderResponseHtml(b, fullText); }
        refreshMasterProgress(turn);
      },
    });

    // Wrap streamP so we *always* settle promptly (unblocks send/allSettled) and reliably set 'done' on success.
    // The separate timeoutP below unblocks even on complete hangs. Late-finishing streams after timeout will
    // still flip to 'done' and persist the final text (onChunk already updated live text).
    const wrapped = new Promise((resolve) => {
      streamP.then((full) => {
        if (responseTimeout) {
          clearTimeout(responseTimeout);
          responseTimeout = null;
        }
        if (resp._gen !== respGen) { resolve(); return; } // superseded by a newer run for this model
        if (resp.status === 'streaming') {
          resp.status = 'done';
          resp.text = full;
        }
        // Update final stats + persist terminal state here (covers late completion after unblock timeout).
        // Usage is handled in the post-await block below (added once with prompt+text-at-unblock for timeout cases).
        resp.elapsedMs = performance.now() - startedAt;
        resp.completionTokens = estimateTokens(resp.text || '');
        refreshCard(turn, model.id, resp);
        refreshMasterProgress(turn);
        if (resp.status === 'done' || resp.status === 'error') {
          updateTurn(session.key, turn, session.id).catch(() => {});
        }
        resolve();
      }).catch((err) => {
        if (responseTimeout) {
          clearTimeout(responseTimeout);
          responseTimeout = null;
        }
        if (resp._gen !== respGen) { resolve(); return; } // superseded by a newer run for this model
        if (signal.aborted) { resp.status = resp.text ? 'done' : 'error'; resp.error = t('status.aborted'); }
        else { resp.status = 'error'; resp.error = String(err.message || err); }
        resolve();
      });
    });

    // Race to unblock caller for early/partial master even if a stream hangs forever.
    let raceTimer = null;
    const timeoutP = timeoutMs > 0 ? new Promise((r) => { raceTimer = setTimeout(r, timeoutMs); }) : Promise.resolve();
    await Promise.race([wrapped, timeoutP]);
    if (raceTimer) { clearTimeout(raceTimer); raceTimer = null; }

    if (responseTimeout) {
      clearTimeout(responseTimeout);
      responseTimeout = null;
    }
  } catch (err) {
    if (responseTimeout) {
      clearTimeout(responseTimeout);
      responseTimeout = null;
    }
    if (signal.aborted) { resp.status = resp.text ? 'done' : 'error'; resp.error = t('status.aborted'); }
    else { resp.status = 'error'; resp.error = String(err.message || err); }
  } finally {
    if (responseTimeout) {
      clearTimeout(responseTimeout);
      responseTimeout = null;
    }
  }
  resp.elapsedMs = performance.now() - startedAt;
  resp.completionTokens = estimateTokens(resp.text || '');
  // Accumulate monthly usage (cloud models only; local is free).
  // Count even on error/timeout, as prompt + any partial output was consumed.
  if (model.type !== 'local' && (resp.promptTokens != null || resp.completionTokens > 0)) {
    addUsage(settings, model.id, model, resp.promptTokens || 0, resp.completionTokens || 0);
    persistSettings();
    renderUsage();
  }
  refreshCard(turn, model.id, resp);
  refreshMasterProgress(turn);

  // Ensure terminal states (done/error/timeout) are persisted promptly.
  // This is important for early summary and when some models timeout.
  if (resp.status === 'done' || resp.status === 'error') {
    updateTurn(session.key, turn, session.id).catch(() => {});
  }
}

async function runMaster(turn, master, modelsForBlock, signal) {
  if (!turn.master) turn.master = { status: 'pending', text: '' };
  // turn.models snapshots intentionally omit apiKey (they are persisted per turn), so an
  // aggregator picked from the early-summary selector arrives key-less. Re-resolve the live
  // model by id so a model that already answered individually isn't wrongly rejected as
  // "no API key" (and so the actual stream gets the real key).
  master = settings.models.find((m) => m.id === master.id) || master;
  if (master.type !== 'local' && !master.apiKey) {
    turn.master = { status: 'error', error: t('master.no_key'), text: '' };
    refreshCard(turn, 'master', turn.master);
    return;
  }
  if (turn.master.status === 'streaming' || turn.master.status === 'collecting') {
    // Already running a master; ignore duplicate/early re-call (e.g. race between timeout and post-send).
    return;
  }
  turn.master.by = master.id;  // which model actually aggregated (may differ from masterId on substitution)
  // Generation token: if this master run is superseded (e.g. it timed out and the user picked
  // a substitute aggregator), a stale late-finishing stream must not clobber the newer run's
  // summary. The stream callbacks below bail out when the generation no longer matches.
  const masterGen = (turn._masterGen = (turn._masterGen || 0) + 1);
  turn.master.status = 'collecting';
  turn.master.text = '';
  turn.master.error = undefined;
  turn.master.elapsedMs = undefined;
  refreshCard(turn, 'master', turn.master);
  turn.master.status = 'streaming';
  turn.master.text = '';
  turn.master.error = undefined;
  turn.master.elapsedMs = undefined;
  const startedAt = performance.now();
  refreshCard(turn, 'master', turn.master);

  // 마스터 요약 타임아웃 (master summary timeout) — idle-based: re-armed on any stream
  // activity (incl. reasoning) so a slow aggregator model isn't cut off mid-thought.
  const tmo = settings.timeoutMs;
  const timeoutMs = tmo > 0 ? tmo : 0;
  let masterTimeout = null;
  const armMasterTimeout = () => {
    if (timeoutMs <= 0) return;
    if (masterTimeout) clearTimeout(masterTimeout);
    masterTimeout = setTimeout(() => {
      if (turn.master.status === 'streaming' && !turn.master.text) {
        turn.master.status = 'error';
        turn.master.error = t('timeout.secs', { s: Math.round(timeoutMs / 1000) });
        refreshCard(turn, 'master', turn.master);
        updateTurn(session.key, turn, session.id).catch(() => {});

        // 마스터 타임아웃 시 자동으로 완료된 모델 선택 팝업 표시
        const completed = turnModels(turn).filter((m) => {
          const r = turn.responses?.[m.id];
          return r && r.status === 'done' && r.text;
        });
        if (completed.length > 0) {
          const mst = settings.models.find((m) => m.id === turn.masterId) || turn.models?.[turn.masterId];
          if (mst) {
            showMasterModelSelector(turn, mst, completed).then(async (sel) => {
              if (!sel || sel.selected.length === 0) return;
              if (activeController) { alert(t('alert.wait_task')); return; }
              activeController = new AbortController();
              setSending(true);
              try {
                await runMaster(turn, sel.aggregator, sel.selected, activeController.signal);
                await updateTurn(session.key, turn, session.id);
              } finally {
                setSending(false);
                activeController = null;
              }
            });
          }
        }
      }
    }, timeoutMs);
  };
  armMasterTimeout();

  // Aggregation input: optional previous official synthesis + this question + this-turn answers.
  const prevMaster = latestSuccessfulMasterBefore(turn);
  let block = '';
  if (prevMaster) {
    block += t('block.prev_synth_ref') + '\n' + prevMaster + '\n\n';
  }
  block += `${t('block.question')}\n${turn.user}\n\n${t('block.each_model_answer')}\n`;
  for (const m of modelsForBlock) {
    const r = turn.responses[m.id];
    if (r && r.status === 'done' && r.text) {
      block += `\n### ${m.label}\n${r.text}\n`;
    }
  }

  const messages = [];
  // Exclusive taste + RICH (no model-continuity L0), then master editor L0 instruction.
  pushSystemLayers(messages, 'master');
  messages.push({ role: 'system', content: t('instr.master') });
  messages.push({ role: 'user', content: block });
  turn.master.promptTokens = estimateTokens(messages.map((m) => m.content).join('\n'));

  try {
    // Wrap to ensure promise settles promptly even if stream hangs.
    // Race with timeoutP so runMaster await unblocks on hang (important when called with await from send's full path).
    const wrapped = new Promise((resolve) => {
      const streamP = streamChat(master, messages, {
        signal,
        maxTokens: settings.maxTokens,
        onRetry: (attempt, delay) => {
          if (turn._masterGen !== masterGen || turn.master.status !== 'streaming' || turn.master.text) return;
          const b = document.getElementById(`body-${turn.id}-master`);
          if (b) { b.classList.remove('streaming'); b.innerHTML = `<span class="card-status status-wait">${escapeText(t('status.retry_busy', { delay: Math.round(delay / 1000), attempt }))}</span>`; }
        },
        onActivity: () => {
          if (turn._masterGen === masterGen && turn.master.status === 'streaming' && !turn.master.text) armMasterTimeout();
        },
        onChunk: (_c, fullText) => {
          if (turn._masterGen !== masterGen || turn.master.status !== 'streaming') return;
          if (masterTimeout) {
            clearTimeout(masterTimeout);
            masterTimeout = null;
          }
          turn.master.text = fullText;
          const b = document.getElementById(`body-${turn.id}-master`);
          if (b) { b.classList.add('streaming'); renderResponseHtml(b, fullText); }
        },
      });

      streamP.then((full) => {
        if (masterTimeout) {
          clearTimeout(masterTimeout);
          masterTimeout = null;
        }
        if (turn._masterGen === masterGen && turn.master.status === 'streaming') {
          turn.master.text = full;
          turn.master.status = 'done';
        }
        resolve();
      }).catch((err) => {
        if (masterTimeout) {
          clearTimeout(masterTimeout);
          masterTimeout = null;
        }
        if (turn._masterGen !== masterGen) { resolve(); return; } // superseded by a newer master run
        if (signal.aborted) { turn.master.status = turn.master.text ? 'done' : 'error'; turn.master.error = t('status.aborted'); }
        else { turn.master.status = 'error'; turn.master.error = String(err.message || err); }
        resolve();
      });
    });

    let raceTimer = null;
    const timeoutP = timeoutMs > 0 ? new Promise((r) => { raceTimer = setTimeout(r, timeoutMs); }) : Promise.resolve();
    await Promise.race([wrapped, timeoutP]);
    if (raceTimer) { clearTimeout(raceTimer); raceTimer = null; }
  } catch (err) {
    if (masterTimeout) {
      clearTimeout(masterTimeout);
      masterTimeout = null;
    }
    if (signal.aborted) { turn.master.status = turn.master.text ? 'done' : 'error'; turn.master.error = t('status.aborted'); }
    else { turn.master.status = 'error'; turn.master.error = String(err.message || err); }
  } finally {
    if (masterTimeout) {
      clearTimeout(masterTimeout);
      masterTimeout = null;
    }
  }
  turn.master.elapsedMs = performance.now() - startedAt;
  turn.master.completionTokens = estimateTokens(turn.master.text || '');
  // Accumulate for master too, even on error (prompt + partial consumed).
  if (master.type !== 'local' && (turn.master.promptTokens != null || turn.master.completionTokens > 0)) {
    addUsage(settings, master.id, master, turn.master.promptTokens || 0, turn.master.completionTokens || 0);
    persistSettings();
    renderUsage();
  }
  refreshCard(turn, 'master', turn.master);

  // Ensure terminal states for master are persisted (for early/timeout cases).
  if (turn.master.status === 'done' || turn.master.status === 'error') {
    updateTurn(session.key, turn, session.id).catch(() => {});
  }
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
  if (activeController) { alert(t('alert.wait_response')); return; }
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
  lines.push(t('export.title', { title: currentChat?.title || t('chat.untitled_export') }));
  lines.push('');
  for (const tn of turns) {
    if (tn.kind === 'compaction') {
      lines.push(t('export.compaction', { n: tn.compactedCount || '' }));
      lines.push(tn.summary || '');
      lines.push('');
      lines.push('---');
      lines.push('');
      continue;
    }
    lines.push(t('export.question'));
    if (tn.attachments?.length) {
      lines.push(t('export.attach', { names: tn.attachments.map((a) => a.name).join(', ') }));
      lines.push('');
    }
    lines.push(tn.user || t('block.attach_only'));
    lines.push('');
    const models = turnModels(tn);
    for (const m of models) {
      const r = tn.responses?.[m.id];
      if (!r) continue;
      lines.push(`### 🤖 ${m.label} (${m.model})`);
      lines.push(r.status === 'error' ? `> ⚠ ${r.error || t('common.error')}` : (r.text || ''));
      lines.push('');
    }
    if (tn.masterEnabled && tn.master) {
      const mm = tn.models?.[tn.master.by || tn.masterId];
      lines.push(t('export.master', { label: mm ? ` · ${mm.label}` : '' }));
      lines.push(tn.master.status === 'error' ? `> ⚠ ${tn.master.error || t('common.error')}` : (tn.master.text || ''));
      lines.push('');
    }
    if (tn.crossCheck && tn.crossCheck.text) {
      const cm = tn.models?.[tn.crossCheck.by];
      lines.push(t('export.crosscheck', { label: cm ? ` · ${cm.label}` : '' }));
      lines.push(tn.crossCheck.status === 'error' ? `> ⚠ ${tn.crossCheck.error || t('common.error')}` : (tn.crossCheck.text || ''));
      lines.push('');
    }
    lines.push('---');
    lines.push('');
  }
  return lines.join('\n');
}

function exportChat() {
  if (!turns.length) { alert(t('alert.nothing_export')); return; }
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
//  Share — create a read-only zero-knowledge link
// =====================================================================
// The fresh per-share key stays in the returned URL fragment; the server only
// ever gets ciphertext. See src/share.js for the crypto + upload.
function openShareModal() {
  if (!currentChat || !turns.some((tn) => tn.kind !== 'compaction')) {
    showInlineNotice(t('share.empty'));
    return;
  }
  // Sharing needs the Worker (to host the ciphertext), so it requires an online
  // account. Local-only users have no server to publish to.
  if (!(session && session.mode === 'online' && session.token)) {
    showInlineNotice(t('share.need_online'));
    return;
  }

  const existing = document.getElementById('share-modal');
  if (existing) existing.remove();

  const modal = h('div', { id: 'share-modal', class: 'modal' });
  const close = () => modal.remove();
  modal.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));

  const imgToggle = h('input', { type: 'checkbox' });
  const hasImages = turns.some((tn) => (tn.attachments || []).some((a) => a.kind === 'image' && a.dataUrl));

  const linkInput = h('input', { class: 'share-link-input', type: 'text', readonly: true, onfocus: (e) => e.target.select() });
  const copyBtn = h('button', {
    class: 'btn btn-primary btn-sm',
    onclick: async () => {
      try { await navigator.clipboard.writeText(linkInput.value); }
      catch { linkInput.select(); }
      copyBtn.textContent = t('share.copied');
      setTimeout(() => { copyBtn.textContent = t('share.copy'); }, 1500);
    },
  }, t('share.copy'));
  const expiryLabel = h('div', { class: 'share-expiry muted' });
  const resultWrap = h('div', { class: 'share-result', hidden: true }, [
    h('div', { class: 'share-ready muted' }, t('share.ready')),
    h('div', { class: 'share-link-row' }, [linkInput, copyBtn]),
    expiryLabel,
  ]);

  const errBox = h('div', { class: 'share-err', hidden: true });
  const createBtn = h('button', { class: 'btn btn-primary' }, t('share.create'));

  const doCreate = async (forceTextOnly) => {
    createBtn.disabled = true;
    const prev = createBtn.textContent;
    createBtn.textContent = t('share.creating');
    errBox.hidden = true;
    try {
      const includeImages = forceTextOnly ? false : imgToggle.checked;
      const { url, expiresAt } = await createShareLink({ chat: currentChat, turns, includeImages, token: session.token });
      linkInput.value = url;
      expiryLabel.textContent = t('share.expires_on', { date: new Date(expiresAt).toLocaleString() });
      resultWrap.hidden = false;
      createBtn.style.display = 'none';
      try { await navigator.clipboard.writeText(url); copyBtn.textContent = t('share.copied'); setTimeout(() => { copyBtn.textContent = t('share.copy'); }, 1500); }
      catch { /* clipboard may be blocked; the field is selectable */ }
    } catch (err) {
      createBtn.disabled = false;
      createBtn.textContent = prev;
      errBox.hidden = false;
      errBox.textContent = '';
      if (err && err.code === 'share_too_large' && !forceTextOnly && imgToggle.checked) {
        // Offer the text-only fallback the user asked for.
        errBox.append(
          h('span', {}, t('share.err_too_large_images') + ' '),
          h('button', { class: 'btn btn-ghost btn-sm', onclick: () => doCreate(true) }, t('share.retry_text_only')),
        );
      } else if (err && err.code === 'share_too_large') {
        errBox.textContent = t('share.err_too_large');
      } else {
        errBox.textContent = t('share.err_generic', { err: String((err && err.message) || err) });
      }
    }
  };
  createBtn.addEventListener('click', () => doCreate(false));

  const card = h('div', { class: 'modal-card share-card' }, [
    h('div', { class: 'modal-head' }, [
      h('h2', {}, t('share.title')),
      h('button', { class: 'icon-btn', onclick: close }, '\u2715'),
    ]),
    h('div', { class: 'modal-body' }, [
      h('p', { class: 'muted', style: 'font-size:13px; line-height:1.5;' }, t('share.desc')),
      h('p', { class: 'share-note' }, t('share.snapshot_note')),
      h('p', { class: 'share-note' }, t('share.expiry_note')),
      hasImages ? h('label', { class: 'opt-row share-img-row' }, [
        imgToggle,
        h('span', {}, [
          h('div', {}, t('share.include_images')),
          h('div', { class: 'muted', style: 'font-size:12px;' }, t('share.include_images_hint')),
        ]),
      ]) : null,
      errBox,
      resultWrap,
    ]),
    h('div', { class: 'modal-foot' }, [
      h('button', { class: 'btn btn-ghost', onclick: close }, t('common.cancel')),
      createBtn,
    ]),
  ]);
  modal.appendChild(card);
  document.body.appendChild(modal);
}

// =====================================================================
//  Share — read-only viewer (opened when the URL is a #s= link)
// =====================================================================
async function enterShareViewer() {
  document.title = 'API-Tizer';
  applyTheme();
  applyShareViewLayout();
  window.addEventListener('resize', applyShareViewLayout);
  applyI18n();
  const authScreen = $('#authScreen');
  if (authScreen) authScreen.hidden = true;
  $('#app').hidden = true;
  const root = $('#shareView');
  root.hidden = false;
  document.body.classList.add('is-shareview');
  root.innerHTML = '';
  root.appendChild(h('div', { class: 'share-view-loading' }, t('view.loading')));

  try {
    const { snapshot, createdAt } = await loadShareFromLocation();
    renderShareView(root, snapshot, createdAt);
  } catch (err) {
    renderShareError(root, (err && err.code) || 'share_generic');
  }
}

// The viewer runs outside the normal boot, so applyLayoutMode never fires. Mirror
// its width→class logic (minus the app-only bits) so shared cards get the same
// mobile refinements (wrapping card heads, tighter spacing) on a phone.
function applyShareViewLayout() {
  const mobile = window.innerWidth <= MOBILE_BREAKPOINT;
  document.body.classList.toggle('is-mobile', mobile);
  document.body.classList.toggle('is-narrow', mobile && window.innerWidth <= NARROW_BREAKPOINT);
}

function renderShareError(root, code) {
  const map = {
    share_invalid: 'view.err_invalid',
    share_not_found: 'view.err_not_found',
    share_expired: 'view.err_expired',
    share_endpoint: 'view.err_endpoint',
    share_offline: 'view.err_offline',
  };
  root.innerHTML = '';
  root.appendChild(h('div', { class: 'share-view-error' }, [
    h('img', { class: 'share-view-logo', src: './apitizer_logo.png', alt: 'API-Tizer' }),
    h('p', { class: 'share-error-msg' }, t(map[code] || 'view.err_generic')),
    h('a', { class: 'btn btn-primary', href: location.origin + location.pathname }, t('view.open_app')),
  ]));
}

function renderShareView(root, snapshot, createdAt) {
  root.innerHTML = '';

  const copyBtn = h('button', { class: 'btn btn-ghost btn-sm' }, t('view.copy'));
  copyBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(buildSnapshotMarkdown(snapshot)).then(() => {
      copyBtn.textContent = t('view.copied');
      setTimeout(() => { copyBtn.textContent = t('view.copy'); }, 1800);
    }).catch(() => { /* clipboard blocked */ });
  });
  const importBtn = h('button', { class: 'btn btn-ghost btn-sm', onclick: () => stashImportAndOpen(snapshot) }, t('view.import'));
  const openBtn = h('a', { class: 'btn btn-primary btn-sm', href: location.origin + location.pathname }, t('view.open_app'));

  const header = h('header', { class: 'share-view-head' }, [
    h('div', { class: 'share-view-brand' }, [
      h('img', { class: 'brand-logo', src: './apitizer_mark.png', alt: '' }),
      h('span', { class: 'share-view-name' }, 'API-Tizer'),
      h('span', { class: 'share-badge' }, t('view.badge')),
    ]),
    h('div', { class: 'share-view-actions' }, [copyBtn, importBtn, openBtn]),
  ]);

  const body = h('div', { class: 'share-view-body' });
  body.appendChild(h('div', { class: 'share-banner' }, t('view.banner')));
  if (snapshot.title) body.appendChild(h('h1', { class: 'share-view-title' }, snapshot.title));
  if (createdAt) body.appendChild(h('div', { class: 'share-view-meta muted' }, t('view.shared_on', { date: new Date(createdAt).toLocaleString() })));

  const msgs = h('div', { class: 'share-messages' });
  for (const tn of (snapshot.turns || [])) msgs.appendChild(renderSharedTurn(tn));
  body.appendChild(msgs);

  root.append(header, body);
  window.scrollTo(0, 0);
}

function renderSharedTurn(tn) {
  if (tn.kind === 'compaction') {
    const cb = h('div', { class: 'compaction-body md' });
    renderResponseHtml(cb, tn.summary || '');
    return h('div', { class: 'turn compaction-turn' }, [
      h('div', { class: 'compaction-card' }, [
        h('div', { class: 'compaction-head' }, [
          h('span', { class: 'compaction-title' }, t('compaction.card_title', { n: tn.compactedCount || '' })),
        ]),
        h('details', { class: 'compaction-details' }, [h('summary', {}, t('compaction.view')), cb]),
      ]),
    ]);
  }

  const bubble = h('div', { class: 'user-bubble' });
  if (tn.attachments && tn.attachments.length) {
    const row = h('div', { class: 'bubble-attachments' });
    for (const a of tn.attachments) {
      if (a.kind === 'image' && a.dataUrl) {
        row.appendChild(h('img', { src: a.dataUrl, alt: a.name || '', title: a.name || '' }));
      } else if (a.kind === 'image') {
        row.appendChild(h('span', { class: 'bubble-file' }, t('view.image_omitted')));
      } else {
        row.appendChild(h('span', { class: 'bubble-file' }, (a.mime === 'application/pdf' ? '\ud83d\udcd5 ' : '\ud83d\udcc4 ') + (a.name || '')));
      }
    }
    bubble.appendChild(row);
  }
  if (tn.user) bubble.appendChild(document.createTextNode(tn.user));
  const userRow = h('div', { class: 'user-row' }, [h('div', { class: 'user-wrap' }, [bubble])]);

  const cards = [];
  for (const ans of (tn.answers || [])) cards.push(sharedAnswerCard(ans, false));
  if (tn.master && (tn.master.text || tn.master.error)) cards.push(sharedAnswerCard(tn.master, true));
  if (tn.crossCheck && tn.crossCheck.text) cards.push(sharedCrossCard(tn.crossCheck));

  return h('div', { class: 'turn' }, [userRow, h('div', { class: 'share-answers' }, cards)]);
}

function sharedAnswerCard(ans, isMaster) {
  const meta = MODEL_META[ans.type] || MODEL_META.openai;
  const body = h('div', { class: 'card-body md' });
  if (ans.status === 'error') {
    body.appendChild(h('div', { class: 'resp-error' }, '\u26a0 ' + (ans.error || t('common.error'))));
  } else {
    renderResponseHtml(body, ans.text || '');
    if (ans.citations && ans.citations.length) renderCitations(body, ans.citations);
  }
  let badge = null;
  if (isMaster) {
    const v = masterVerdict({ master: { status: 'done', text: ans.text || '' } });
    if (v) badge = h('span', { class: 'dissent-badge ' + (v.state === 'dissent' ? 'is-dissent' : 'is-consensus') }, v.state === 'dissent' ? t('master.dissent_badge') : t('master.agree_badge'));
  }
  const isDissent = !!(badge && badge.classList.contains('is-dissent'));
  return h('div', { class: 'model-card' + (isMaster ? ' master-card' : '') + (isDissent ? ' has-dissent' : '') }, [
    h('div', { class: 'card-head' }, [
      h('span', { class: 'badge', style: `background:${meta.color}` }),
      isMaster ? h('span', { class: 'crown' }, '\ud83d\udc51') : null,
      h('span', {}, isMaster ? (t('view.master_label') + (ans.label ? ' \u00b7 ' + ans.label : '')) : (ans.label || '')),
      ans.model ? h('span', { class: 'model-name', text: ans.model }) : null,
      badge,
    ]),
    body,
  ]);
}

function sharedCrossCard(cc) {
  const body = h('div', { class: 'card-body md' });
  renderResponseHtml(body, cc.text || '');
  return h('div', { class: 'model-card crosscheck-card' }, [
    h('div', { class: 'card-head' }, [
      h('span', {}, t('view.crosscheck_label')),
      cc.label ? h('span', { class: 'model-name', text: cc.label }) : null,
    ]),
    body,
  ]);
}

// Markdown of a shared snapshot (the viewer's "copy" button). Mirrors
// buildMarkdownExport but reads the snapshot shape instead of live turns.
function buildSnapshotMarkdown(snapshot) {
  const lines = [];
  lines.push(t('export.title', { title: snapshot.title || t('chat.untitled_export') }));
  lines.push('');
  for (const tn of (snapshot.turns || [])) {
    if (tn.kind === 'compaction') {
      lines.push(t('export.compaction', { n: tn.compactedCount || '' }));
      lines.push(tn.summary || '');
      lines.push(''); lines.push('---'); lines.push('');
      continue;
    }
    lines.push(t('export.question'));
    if (tn.attachments && tn.attachments.length) {
      lines.push(t('export.attach', { names: tn.attachments.map((a) => a.name).join(', ') }));
      lines.push('');
    }
    lines.push(tn.user || t('block.attach_only'));
    lines.push('');
    for (const ans of (tn.answers || [])) {
      lines.push(`### \ud83e\udd16 ${ans.label} (${ans.model})`);
      lines.push(ans.status === 'error' ? `> \u26a0 ${ans.error || t('common.error')}` : (ans.text || ''));
      lines.push('');
    }
    if (tn.master && tn.master.text) {
      lines.push(t('export.master', { label: tn.master.label ? ` \u00b7 ${tn.master.label}` : '' }));
      lines.push(tn.master.text);
      lines.push('');
    }
    if (tn.crossCheck && tn.crossCheck.text) {
      lines.push(t('export.crosscheck', { label: tn.crossCheck.label ? ` \u00b7 ${tn.crossCheck.label}` : '' }));
      lines.push(tn.crossCheck.text);
      lines.push('');
    }
    lines.push('---'); lines.push('');
  }
  return lines.join('\n');
}

// Import ("continue in my account"): stash the decrypted snapshot in this tab and
// reload into the normal app (login gate if needed). bootAppData picks it up.
const SHARE_IMPORT_KEY = 'apitizer.pendingShareImport';
function stashImportAndOpen(snapshot) {
  try { sessionStorage.setItem(SHARE_IMPORT_KEY, JSON.stringify(snapshot)); } catch { /* quota — skip */ }
  location.href = location.origin + location.pathname;
}

// After login, turn any stashed shared snapshot into a real (owned, encrypted,
// syncable) chat. Returns the new chatId, or null if there was nothing to import.
async function maybeImportPendingShare() {
  let raw = null;
  try { raw = sessionStorage.getItem(SHARE_IMPORT_KEY); } catch { /* ignore */ }
  if (!raw) return null;
  try { sessionStorage.removeItem(SHARE_IMPORT_KEY); } catch { /* ignore */ }
  let snapshot;
  try { snapshot = JSON.parse(raw); } catch { return null; }
  if (!snapshot || snapshot.v !== 1 || !Array.isArray(snapshot.turns)) return null;
  try {
    const chatId = await importSharedSnapshot(snapshot);
    showInlineNotice(t('share.imported'));
    return chatId;
  } catch { return null; }
}

async function importSharedSnapshot(snapshot) {
  const title = (snapshot.title || t('chat.default_title')).slice(0, 120);
  const chat = await createChat(session.id, session.key, title);
  // Order preserved and kept strictly in the past so a later real send sorts after.
  let stamp = Date.now() - (snapshot.turns.length + 1);
  for (const stn of snapshot.turns) {
    const createdAt = ++stamp;
    if (stn.kind === 'compaction') {
      await addTurn(session.key, { id: uid(), chatId: chat.id, createdAt, kind: 'compaction', summary: stn.summary || '', compactedCount: stn.compactedCount || 0, coversUpTo: createdAt }, session.id);
      continue;
    }
    const modelIds = [];
    const models = {};
    const responses = {};
    (stn.answers || []).forEach((ans, i) => {
      const id = 's' + i;
      modelIds.push(id);
      models[id] = { id, label: ans.label || id, model: ans.model || '', type: MODEL_META[ans.type] ? ans.type : 'openai', vision: false };
      responses[id] = ans.status === 'error'
        ? { status: 'error', error: ans.error || t('common.error') }
        : { status: 'done', text: ans.text || '', ...(ans.citations ? { citations: ans.citations } : {}) };
    });
    let master = null, masterId = null, masterEnabled = false;
    if (stn.master && (stn.master.text || stn.master.error)) {
      masterId = 'sm'; masterEnabled = true;
      models[masterId] = { id: masterId, label: stn.master.label || 'Master', model: '', type: MODEL_META[stn.master.type] ? stn.master.type : 'openai', vision: false };
      master = stn.master.status === 'error'
        ? { status: 'error', error: stn.master.error || t('common.error'), by: masterId }
        : { status: 'done', text: stn.master.text || '', by: masterId };
    }
    let crossCheck = null;
    if (stn.crossCheck && stn.crossCheck.text) {
      models.scc = { id: 'scc', label: stn.crossCheck.label || '', model: '', type: 'openai', vision: false };
      crossCheck = { status: 'done', text: stn.crossCheck.text, by: 'scc' };
    }
    const attachments = (stn.attachments || []).map((a) => ({ name: a.name || '', kind: a.kind || 'file', mime: a.mime || '', ...(a.dataUrl ? { dataUrl: a.dataUrl } : {}) }));
    await addTurn(session.key, {
      id: uid(), chatId: chat.id, createdAt,
      user: stn.user || '', attachments,
      modelIds, models, responses,
      masterEnabled, masterId, master, crossCheck,
    }, session.id);
  }
  chats.unshift(chat);
  scheduleSync();
  return chat.id;
}


// =====================================================================
//  Settings modal
// =====================================================================
function setupSettingsModal() {
  settingsModal.querySelectorAll('[data-close]').forEach((el) =>
    el.addEventListener('click', closeSettings));
  $('#addLocalBtn').addEventListener('click', addLocalRow);
  $('#saveSettingsBtn').addEventListener('click', saveSettingsFromForm);
  $('#resetChatsBtn').addEventListener('click', resetChatsOnly);
  $('#resetAllBtn').addEventListener('click', resetEverything);
  $('#deleteAccountBtn').addEventListener('click', deleteCurrentAccount);
  $('#changePwBtn').addEventListener('click', openPwModal);
  $('#backupExportBtn').addEventListener('click', exportBackup);
  $('#backupImportBtn').addEventListener('click', () => {
    if (!$('#backupImportPass').value) {
      $('#saveHint').textContent = t('savehint.enter_backup_pass');
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
  const richEl = $('#richStyleToggle');
  if (richEl) richEl.checked = settings.richStyle !== false;
  const timeoutInput = $('#timeoutInput');
  if (timeoutInput) timeoutInput.value = Math.round((settings.timeoutMs || 60000) / 1000);
  const maxTokInput = $('#maxTokensInput');
  if (maxTokInput) maxTokInput.value = settings.maxTokens || 8192;
  $('#resetUserLabel').textContent = session ? `'${session.displayName}'` : t('reset.current_user');
  renderModelSettings();
  refreshStorageInfo();
  $('#saveHint').textContent = '';
  settingsModal.hidden = false;
}
function closeSettings() { settingsModal.hidden = true; }

// =====================================================================
//  Per-chat instructions (chat-specific prompt + rich override)
// =====================================================================
let chatInstructionsModal = null;

async function openChatInstructions() {
  if (!currentChat) {
    // Create a new chat immediately when user wants to set per-chat instructions.
    // This allows configuring prompt + rich style before sending the first message.
    currentChat = await createChat(session.id, session.key, t('chat.default_title'));
    chats.unshift(currentChat);
    renderChatTitle();
    renderChatList();
    renderMessages();   // switch UI to this new (empty) chat
  }

  if (!chatInstructionsModal) chatInstructionsModal = $('#chatInstructionsModal');

  $('#chatInstructionsInput').value = currentChat.chatPrompt || '';
  const richToggle = $('#chatRichStyleToggle');
  const chatRich = currentChat.chatRichStyle;
  richToggle.checked = chatRich === null || chatRich === undefined ? settings.richStyle : !!chatRich;

  chatInstructionsModal.hidden = false;

  // focus
  setTimeout(() => $('#chatInstructionsInput').focus(), 50);
}

function closeChatInstructions() {
  const modal = $('#chatInstructionsModal');
  if (modal) modal.hidden = true;
}

async function saveChatInstructions() {
  if (!currentChat) return;

  const input = $('#chatInstructionsInput').value.trim();
  const richChecked = $('#chatRichStyleToggle').checked;

  currentChat.chatPrompt = input;
  // store explicit override only if different from global? but store always the choice for the chat
  currentChat.chatRichStyle = richChecked;  // true or false explicit for this chat

  // persist meta
  await updateChatMeta(session.id, session.key, currentChat);
  scheduleSync();

  // update header title + button state, and sidebar badge
  renderChatTitle();
  renderChatList();

  closeChatInstructions();

  // optional: tell user
  // alert('이 채팅 전용 지침이 저장되었습니다. 다음 메시지부터 적용됩니다.');
}

function renderChatTitle() {
  if (!currentChat) {
    chatTitleEl.textContent = '';
    if (chatInstructionsBtn) chatInstructionsBtn.classList.remove('has-custom');
    return;
  }
  chatTitleEl.textContent = currentChat.title || '';

  // Indicate in the button if this chat has custom instructions
  if (chatInstructionsBtn) {
    const hasCustom = !!(currentChat.chatPrompt && currentChat.chatPrompt.trim()) ||
                      (currentChat.chatRichStyle === true || currentChat.chatRichStyle === false);
    chatInstructionsBtn.classList.toggle('has-custom', hasCustom);
  }
}

async function refreshStorageInfo() {
  const el = $('#storageInfo');
  const est = await estimateUsage();
  if (!est || !est.quota) { el.textContent = t('storage.unavailable'); return; }
  const mb = (n) => (n / 1024 / 1024).toFixed(1);
  const pct = ((est.usage / est.quota) * 100).toFixed(1);
  el.textContent = t('storage.usage', { used: mb(est.usage), quota: mb(est.quota), pct });
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
  const listId = `model-presets-${m.id}`;
  const keyField = h('div', { class: 'field full' }, [
    h('label', { text: isLocal ? t('model.api_key_optional') : t('model.api_key') }),
    h('input', { type: 'password', value: m.apiKey || '', placeholder: isLocal ? t('model.key_ph_local') : t('model.key_ph'), 'data-id': m.id, 'data-k': 'apiKey' }),
  ]);

  const row = h('div', { class: 'model-row', 'data-row': m.id }, [
    h('div', { class: 'model-row-head' }, [
      h('span', { class: 'badge', style: `background:${meta.color}` }),
      h('span', { class: 'name', text: m.label }),
      meta.apiConsoleUrl
        ? h('a', {
            href: meta.apiConsoleUrl,
            target: '_blank',
            rel: 'noopener noreferrer',
            class: 'api-link',
            'data-tip': t('model.key_link_title', { label: meta.label }),
          }, '↗')
        : null,
      h('span', { class: 'spacer' }),
      h('label', { class: 'master-radio' }, [
        h('input', { type: 'radio', name: 'master', value: m.id, ...(settings.masterId === m.id ? { checked: 'checked' } : {}) }),
        t('model.master'),
      ]),
      h('label', { class: 'master-radio', title: t('model.vision_title') }, [
        h('input', { type: 'checkbox', 'data-id': m.id, 'data-k': 'vision', ...(m.vision ? { checked: 'checked' } : {}) }),
        t('model.vision'),
      ]),
      h('label', { class: 'master-radio' }, [
        h('input', { type: 'checkbox', 'data-id': m.id, 'data-k': 'enabled', ...(m.enabled ? { checked: 'checked' } : {}) }),
        t('model.use'),
      ]),
      isLocal ? h('button', {
        class: 'icon-btn remove-local', title: t('model.remove'),
        onclick: () => removeLocal(m.id),
      }, '🗑') : null,
    ]),
    h('div', { class: 'model-grid' }, [
      h('div', { class: 'field' }, [
        h('label', { text: t('model.display_name') }),
        h('input', { value: m.label, 'data-id': m.id, 'data-k': 'label' }),
      ]),
      h('div', { class: 'field' }, [
        h('label', { text: t('model.model_name') }),
        h('input', {
          value: m.model,
          list: listId,
          placeholder: presetPlaceholder(m.type),
          'data-id': m.id,
          'data-k': 'model',
          onchange: (e) => applyModelPreset(m.id, e.currentTarget.value),
        }),
        modelPresetDatalist(m.type, listId),
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

function presetPlaceholder(type) {
  return (MODEL_PRESETS[type] || []).length ? t('model.pick_or_type') : t('model.type_name');
}

function modelPresetDatalist(type, id) {
  const presets = MODEL_PRESETS[type] || [];
  const list = h('datalist', { id });
  for (const p of presets) {
    list.appendChild(h('option', {
      value: p.model,
      label: t('model.price_opt', { label: p.label, in: p.priceIn, out: p.priceOut }),
    }));
  }
  return list;
}

function applyModelPreset(modelId, value) {
  const m = settings.models.find((x) => x.id === modelId);
  if (!m) return;
  const preset = modelPresetFor(m.type, value);
  if (!preset) return;
  m.model = preset.model;
  m.priceIn = preset.priceIn;
  m.priceOut = preset.priceOut;
  m.vision = !!preset.vision;
  const row = document.querySelector(`[data-row="${CSS.escape(modelId)}"]`);
  if (!row) return;
  const inInput = row.querySelector('input[data-k="priceIn"]');
  const outInput = row.querySelector('input[data-k="priceOut"]');
  const visionInput = row.querySelector('input[data-k="vision"]');
  if (inInput) inInput.value = preset.priceIn;
  if (outInput) outInput.value = preset.priceOut;
  if (visionInput) visionInput.checked = !!preset.vision;
}

// Per-model price override (USD per 1M tokens). Pre-filled with the built-in
// estimate so the user can see and adjust what drives the monthly cost.
function priceFields(m) {
  const p = effectivePrice(m) || { in: '', out: '' };
  return h('div', { class: 'field full price-field' }, [
    h('label', {}, [
      t('model.price_label'),
      h('span', { class: 'help-q', 'data-tip': t('model.price_tip') }, '?'),
    ]),
    h('div', { class: 'price-row' }, [
      h('span', { class: 'price-cap' }, t('model.price_in')),
      h('input', { type: 'number', step: '0.01', min: '0', class: 'price-in', value: p.in ?? '', placeholder: t('model.price_in'), 'data-id': m.id, 'data-k': 'priceIn' }),
      h('span', { class: 'price-cap' }, t('model.price_out')),
      h('input', { type: 'number', step: '0.01', min: '0', class: 'price-out', value: p.out ?? '', placeholder: t('model.price_out'), 'data-id': m.id, 'data-k': 'priceOut' }),
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
  btn.textContent = atMax ? t('local.max', { n: MAX_LOCAL }) : t('local.add');
}

function readModelForm() {
  $('#modelSettings').querySelectorAll('input[data-k]').forEach((input) => {
    const m = settings.models.find((x) => x.id === input.dataset.id);
    if (!m) return;
    const k = input.dataset.k;
    if (k === 'enabled' || k === 'vision') m[k] = input.checked;
    else if (k === 'model') {
      m[k] = input.value.trim();
      const preset = modelPresetFor(m.type, m[k]);
      if (preset) {
        m.priceIn = preset.priceIn;
        m.priceOut = preset.priceOut;
        m.vision = !!preset.vision;
      }
    } else if (k === 'priceIn' || k === 'priceOut') {
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
  const richEl = $('#richStyleToggle');
  if (richEl) settings.richStyle = richEl.checked;
  const timeoutInput = $('#timeoutInput');
  if (timeoutInput) {
    const secs = parseInt(timeoutInput.value, 10);
    settings.timeoutMs = Number.isFinite(secs) && secs >= 0 ? secs * 1000 : 60000;
  }
  const maxTokInput = $('#maxTokensInput');
  if (maxTokInput) {
    const mt = parseInt(maxTokInput.value, 10);
    settings.maxTokens = Number.isFinite(mt) && mt >= 256 ? mt : 8192;
  }
  readModelForm();
  persistSettings();
  masterToggle.checked = settings.masterEnabled;
  applyWebSearchButton();
  resetIdleTimer();
  renderChips();
  renderUsage();
  renderMessages();
  $('#saveHint').textContent = t('savehint.saved');
  setTimeout(closeSettings, 350);
}

// Disable the destructive Danger-Zone buttons while a reset/delete runs, so a
// second click can't kick off an overlapping wipe (the batched delete of a huge
// account can take a moment).
function setDangerBusy(on) {
  for (const sel of ['#resetChatsBtn', '#resetAllBtn', '#deleteAccountBtn']) {
    const b = $(sel);
    if (b) b.disabled = !!on;
  }
}

async function resetEverything() {
  const who = session ? `'${session.displayName}'` : t('reset.current_user');
  const ok = confirm(t('confirm.reset_all', { who, count: chats.length }));
  if (!ok) return;

  setDangerBusy(true);
  try {
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
    renderChatTitle();

    // refresh the open settings form to defaults
    $('#customPrompt').value = settings.customPrompt;
    const richEl = $('#richStyleToggle');
    if (richEl) richEl.checked = settings.richStyle !== false;
    const timeoutInput = $('#timeoutInput');
    if (timeoutInput) timeoutInput.value = Math.round((settings.timeoutMs || 60000) / 1000);
    const maxTokInput = $('#maxTokensInput');
    if (maxTokInput) maxTokInput.value = settings.maxTokens || 8192;
    renderModelSettings();
    refreshStorageInfo();
    $('#saveHint').textContent = t('savehint.reset_done');
    if (session.mode === 'online') scheduleSync();
    setTimeout(closeSettings, 600);
  } finally {
    setDangerBusy(false);
  }
}

async function resetChatsOnly() {
  const who = session ? `'${session.displayName}'` : t('reset.current_user');
  const ok = confirm(t('confirm.reset_chats', { who, count: chats.length }));
  if (!ok) return;

  setDangerBusy(true);
  try {
    if (activeController) activeController.abort();
    await deleteAllChats(session.id);
    chats = [];
    currentChat = null;
    turns = [];
    renderChatTitle();
    renderChatList();
    renderMessages();
    refreshStorageInfo();
    $('#saveHint').textContent = t('savehint.reset_chats_done');
    if (session.mode === 'online') scheduleSync();
  } finally {
    setDangerBusy(false);
  }
}

async function deleteCurrentAccount() {
  if (session && session.mode === 'online') {
    alert(t('alert.online_delete_unsupported'));
    return;
  }
  const who = session ? `'${session.displayName}'` : '';
  const ok = confirm(t('confirm.delete_account', { who }));
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
    alert(t('alert.offline_no_pw'));
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
  if (!cur || !nw) { showPwError(t('pw.fill_all')); return; }
  if (nw !== nw2) { showPwError(t('pw.new_mismatch')); return; }

  const btn = $('#pwSubmitBtn');
  btn.disabled = true;
  const prev = btn.textContent;
  btn.textContent = t('pw.changing');
  try {
    if (session.mode === 'online') await changeOnlinePassword(cur, nw);
    else await changeLocalPassword(cur, nw);
    if (!session) return; // a forced logout happened mid-flow
    localStorage.removeItem(LEGACY_AUTOLOGIN_KEY);
    clearAutoLoginSession();
    closePwModal();
    $('#saveHint').textContent = session.mode === 'online'
      ? t('savehint.pw_done_sync')
      : t('savehint.pw_done');
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
    throw new Error(t('pwerr.offline'));
  }

  // 1) ensure nothing is left unsent and we have everything locally
  try {
    await runSync(session);
  } catch (e) {
    if (e && e.status === 401) { clearAutoLoginSession(); forceLogout(t('err.session_expired')); return; }
    throw new Error(t('pwerr.sync_fail'));
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
  if (!session) throw new Error(t('pwerr.session_ended'));
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
  if (!pass) throw new Error(t('backup.enter_pass'));
  if (pass.length < 8) throw new Error(t('backup.pass_min'));
  if (pass !== pass2) throw new Error(t('backup.pass_mismatch'));
  return pass;
}

function getBackupImportPassword() {
  const pass = $('#backupImportPass').value;
  if (!pass) throw new Error(t('backup.enter_pass'));
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
        richStyle: settings.richStyle,
        timeoutMs: settings.timeoutMs,
        maxTokens: settings.maxTokens,
        masterId: settings.masterId,
        masterEnabled: settings.masterEnabled,
        viewMode: settings.viewMode,
        webSearchEnabled: settings.webSearchEnabled,
        showCost: settings.showCost,
        autoLockMinutes: settings.autoLockMinutes,
        models: settings.models,
        usage: settings.usage || {},
        usageSince: settings.usageSince,
        prompts: settings.prompts || [],
      },
      // legacy top-level fields kept for backward-compat with older backups
      customPrompt: settings.customPrompt,
      richStyle: settings.richStyle,
      timeoutMs: settings.timeoutMs,
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
    $('#saveHint').textContent = t('savehint.backup_exported', { n: chatsData.length });
  } catch (err) {
    alert(t('alert.backup_export_fail', { err: String(err.message || err) }));
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
      throw new Error(t('backup.bad_file'));
    }
    let payload;
    if (parsed.kdf?.salt) {
      const backupKey = await deriveBackupKey(getBackupImportPassword(), parsed.kdf.salt, parsed.kdf.iterations);
      try {
        payload = await decryptJSON(backupKey, parsed.data);
      } catch {
        throw new Error(t('backup.pass_wrong'));
      }
    } else {
      try {
        payload = await decryptJSON(session.key, parsed.data);
      } catch {
        throw new Error(t('backup.old_format'));
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
      if (confirm(t('confirm.import_chats', { n: chatCount }))) {
        n = await importUserData(session.id, session.key, payload.chats);
      }
    }

    // 2) Restore full settings (API keys, models+단가, 개인 맞춤, 토글, 사용량).
    let settingsRestored = false;
    if (hasSettings) {
      if (confirm(t('confirm.import_settings'))) {
        const next = { ...settings };
        if (snap) {
          // copy every known setting field that's present
          for (const k of ['customPrompt', 'richStyle', 'timeoutMs', 'maxTokens', 'masterId', 'masterEnabled', 'viewMode',
                            'webSearchEnabled', 'showCost', 'autoLockMinutes', 'models', 'usage', 'usageSince', 'prompts']) {
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
    const richEl = $('#richStyleToggle');
    if (richEl) richEl.checked = settings.richStyle !== false;
    const timeoutInput = $('#timeoutInput');
    if (timeoutInput) timeoutInput.value = Math.round((settings.timeoutMs || 60000) / 1000);
    if (session.mode === 'online' && (n || settingsRestored)) scheduleSync();
    const parts = [];
    if (n) parts.push(t('backup.parts_chats', { n }));
    if (settingsRestored) parts.push(t('backup.parts_settings'));
    clearBackupPasswords();
    $('#saveHint').textContent = parts.length ? t('savehint.backup_imported', { parts: parts.join(' · ') }) : t('savehint.backup_nothing');
  } catch (err) {
    alert(t('alert.backup_import_fail', { err: String(err.message || err) }));
  }
}
