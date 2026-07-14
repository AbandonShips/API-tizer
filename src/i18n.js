// =====================================================================
//  i18n — Korean / English UI (and AI-instruction) strings.
//
//  Language is a DEVICE-level preference (like theme / layout), stored in
//  localStorage under `apitizer.lang`. It is NOT part of the encrypted
//  per-user settings, so the login screen (which runs before decryption)
//  can already be localised.
//
//  Usage:
//    import { t, getLang, setLang, applyI18n, onLangChange } from './i18n.js';
//    t('auth.login')                     → localised string
//    t('err.file_too_big', { name, size })  → with {var} interpolation
//    applyI18n(root)                     → localise [data-i18n*] elements
// =====================================================================

const LANG_KEY = 'apitizer.lang';
export const LANGS = ['ko', 'en'];

function detectDefault() {
  try {
    const n = (navigator.language || navigator.userLanguage || 'ko').toLowerCase();
    return n.startsWith('en') ? 'en' : 'ko';
  } catch { return 'ko'; }
}

let lang = (() => {
  try { const v = localStorage.getItem(LANG_KEY); if (v === 'ko' || v === 'en') return v; } catch { /* ignore */ }
  return detectDefault();
})();

const listeners = new Set();

export function getLang() { return lang; }

export function setLang(next) {
  if (next !== 'ko' && next !== 'en') return;
  if (next === lang) return;
  lang = next;
  try { localStorage.setItem(LANG_KEY, lang); } catch { /* ignore */ }
  try { document.documentElement.lang = lang; } catch { /* ignore */ }
  for (const fn of listeners) { try { fn(lang); } catch { /* ignore */ } }
}

// Register a callback fired whenever the language changes.
export function onLangChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

// Translate a key with optional {var} interpolation. Falls back ko → key.
export function t(key, vars) {
  let s = (S[lang] && S[lang][key]);
  if (s == null) s = (S.ko && S.ko[key]);
  if (s == null) return key;
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? String(vars[k]) : m));
  return s;
}

// Localise a DOM subtree via data-i18n* attributes.
export function applyI18n(root = document) {
  const scope = root.querySelectorAll ? root : document;
  scope.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.getAttribute('data-i18n')); });
  scope.querySelectorAll('[data-i18n-html]').forEach((el) => { el.innerHTML = t(el.getAttribute('data-i18n-html')); });
  scope.querySelectorAll('[data-i18n-ph]').forEach((el) => { el.setAttribute('placeholder', t(el.getAttribute('data-i18n-ph'))); });
  scope.querySelectorAll('[data-i18n-title]').forEach((el) => { el.setAttribute('title', t(el.getAttribute('data-i18n-title'))); });
  scope.querySelectorAll('[data-i18n-tip]').forEach((el) => { el.setAttribute('data-tip', t(el.getAttribute('data-i18n-tip'))); });
  scope.querySelectorAll('[data-i18n-aria]').forEach((el) => { el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria'))); });
  if (scope === document) {
    try { document.title = t('meta.title'); document.documentElement.lang = lang; } catch { /* ignore */ }
  }
}

// =====================================================================
//  Dictionaries. Flat, dotted keys. English mirrors Korean 1:1.
// =====================================================================
const S = {
  ko: {
    'meta.title': 'API-Tizer · 멀티 AI 콘솔',

    // ---- auth screen ----
    'auth.sub_online': '여러 기기에서 안전하게 동기화됩니다. (영지식 암호화)',
    'auth.sub_online_short': '여러 기기에서 안전하게 동기화됩니다.',
    'auth.sub_local': '이 브라우저에만 암호화되어 저장됩니다.',
    'auth.mode_online': '☁ 온라인',
    'auth.mode_online_title': '여러 기기에서 자동 동기화 (서버에는 암호문만 저장)',
    'auth.mode_local': '💻 이 기기에 저장',
    'auth.mode_local_title': '이 브라우저에만 저장 (동기화 안 함)',
    'auth.sync_summary': '동기화 서버 설정',
    'auth.sync_ph': 'https://api-tizer-sync.이름.workers.dev',
    'auth.sync_hint_html': 'Cloudflare Worker 주소를 입력하세요. 배포 방법은 <code>worker/README.md</code> 참고.',
    'auth.user_ph': '아이디',
    'auth.pass_ph': '비밀번호',
    'auth.pass2_ph': '비밀번호 확인',
    'auth.remember_id': '아이디 기억',
    'auth.auto_login': '자동 로그인',
    'auth.check_warn': '개인 기기에서만 사용하세요. 로그아웃하면 자동 로그인 정보가 삭제됩니다.',
    'auth.login': '로그인',
    'auth.signup': '회원가입',
    'auth.switch_to_signup': '계정이 없으신가요?',
    'auth.switch_to_login': '이미 계정이 있으신가요?',
    'auth.warn': '비밀번호는 8자 이상이며, 길수록 안전합니다. 잊으면 암호화된 데이터를 복구할 수 없습니다.',
    'auth.processing': '처리 중…',
    'auth.autologin_ing': '자동 로그인 중…',

    // ---- sidebar ----
    'side.new_chat': '+ 새 채팅',
    'side.new_chat_title': '새 채팅 (앞선 내용 잊고 토큰 절약)',
    'side.brand_title': '새 채팅 시작',
    'side.search_ph': '🔍 채팅 검색 (제목·내용)',
    'side.usage_title': '누적 예상',
    'side.usage_tip': 'API 응답 길이 기반 클라이언트 추정치라 실제 청구액과 다를 수 있고, 로컬 모델은 무료라 제외됩니다. 초기화 전까지 계속 누적됩니다.\n\n토큰(=비용)이 늘어나는 경우\n· 켜진 모델이 많을수록\n· 마스터 요약을 켤수록\n· 대화가 길수록(이전 맥락도 함께 전송)\n· 이미지·PDF 첨부, 웹 검색을 켤수록\n\n이미지·PDF는 최근 몇 질문까지만 원본이 전송되고 오래되면 요약 참조로 바뀝니다(토큰 절약). 정밀 재분석이 필요하면 이미지를 다시 첨부하세요.',
    'side.usage_reset': '↺ 사용량 초기화',
    'side.usage_reset_title': '누적 사용량을 0으로 초기화',
    'side.sync_now': '↻ 동기화',
    'side.sync_now_title': '지금 동기화',
    'side.settings': '⚙️ 설정',
    'side.logout': '🔒 로그아웃',
    'side.foot_online': '키·기록은 암호화되어 저장되고 서버에는 암호문만 동기화됩니다.',
    'side.foot_local': '키·기록은 이 브라우저에만 암호화 저장됩니다.',
    'side.empty': '채팅이 없습니다. 새 채팅을 시작하세요.',
    'side.search_empty': '"{term}" 검색 결과가 없습니다.',
    'side.pinned': '📌 고정됨',

    // ---- topbar ----
    'top.menu': '메뉴',
    'top.chat_instr_title': '이 채팅 전용 프롬프트 / 지침 (전역 프롬프트 무시, rich 서식 개별 제어)',
    'top.layout_title': 'PC / 모바일 레이아웃 전환',
    'top.theme_title': '라이트 / 다크 테마 전환',
    'top.theme_to_dark': '다크 테마로 전환',
    'top.theme_to_light': '라이트 테마로 전환',
    'top.help_title': '도움말 · 단축키',
    'top.compact': '🗜 대화 압축',
    'top.compact_title': '이전 대화를 짧게 요약해서 다음 질문부터 토큰(비용)을 줄여줍니다. 화면의 대화 내용은 그대로 유지돼요.',
    'top.compact_title_inactive': '대화가 더 길어지면 쓸 수 있어요. 이전 대화를 짧게 요약해 다음 질문부터 토큰(비용)을 줄여주는 기능입니다.',
    'top.export': '⬇ 내보내기',
    'top.export_title': '대화를 Markdown 파일로 내보내기',
    'top.view_title': '분할: 모델별 답을 나란히 / 통합: 한 컬럼으로 모아 보기',
    'top.view_split': '⬛⬛ 분할',
    'top.view_split_title': '모델별 답변을 나란히 비교',
    'top.view_unified': '▤ 통합',
    'top.view_unified_title': '한 컬럼으로 모아 보기 (마스터 요약 + 개별 답 펼치기)',
    'top.master': '마스터',
    'top.master_title': '마스터 모델이 모든 답을 하나로 요약',
    'top.master_tip': '마스터 요약 켜기/끄기',
    'top.layout_to_pc_auto': 'PC 보기로 전환 (현재: 자동)',
    'top.layout_to_mobile_auto': '모바일 보기로 전환 (현재: 자동)',
    'top.layout_to_pc_tip': 'PC 레이아웃으로 전환 (현재: 자동)',
    'top.layout_to_mobile_tip': '모바일 레이아웃으로 전환 (현재: 자동)',
    'top.layout_back_auto': '자동 레이아웃으로 복귀',

    // ---- composer ----
    'comp.attach_title': '파일·이미지 첨부 (드래그/붙여넣기도 가능)',
    'comp.attach_aria': '파일 첨부',
    'comp.web_title': '웹 검색 (지원 모델: ChatGPT·Claude·Gemini·Grok)',
    'comp.plib_title': '프롬프트 라이브러리 (자주 쓰는 프롬프트 저장·삽입)',
    'comp.ph_desktop': '무엇이든 물어보세요. 활성화된 모든 모델이 동시에 답합니다.  (Enter 전송 · Shift+Enter 줄바꿈)',
    'comp.ph_mobile': '무엇이든 물어보세요. Enter 줄바꿈 · 전송 버튼으로 보내기',
    'comp.send': '전송',
    'comp.stop': '■ 정지',

    // ---- settings modal ----
    'set.title': '설정',
    'set.custom_h3': '개인 맞춤 (전역 시스템 프롬프트)',
    'set.custom_tip': "여기에 적은 내용은 모든 대화·모든 모델에 시스템 프롬프트로 항상 함께 전송됩니다. 예: 직업, 답변 말투, 출력 형식. '풍부한 응답 서식' 토글(기본 ON)과 함께 쓰면 웹 구독 제품 스타일의 이모지/표/구조를 유지하면서 개인 규칙을 적용합니다. 새 채팅을 만들어도 잃지 않습니다.",
    'set.custom_muted': "모든 대화에 적용되는 기본 시스템 프롬프트입니다. 특정 채팅에서 '📝' 버튼으로 전용 프롬프트를 설정하면, 전역 프롬프트는 그 채팅에서 완전히 무시됩니다.",
    'set.custom_ph': '예) 나는 제품을 만드는 1인 개발자입니다. 답변은 한국어로, 결론을 먼저 말하고 근거는 간결한 불릿으로. 추상적인 원론보다 바로 실행 가능한 제안을 선호합니다.',
    'set.model_h3': '모델 / API',
    'set.model_tip': '각 줄에서: 👑마스터=요약 담당 모델 1개 선택 · 비전=이미지 입력 지원 여부 · 사용=대화에 포함. API 키는 암호화되어 저장되며 온라인 모드에서는 암호문만 동기화됩니다.',
    'set.add_local': '+ 로컬 엔드포인트 추가',
    'set.model_muted': '마스터로 지정한 모델이 모든 답변을 하나로 정리하고 소수 의견을 덧붙입니다. 로컬은 최대 3개까지 추가할 수 있어요 (Ollama / LM Studio 등 OpenAI 호환).',
    'set.display_h3': '표시 옵션',
    'set.show_cost': '답변에 토큰·비용 추정 표시',
    'set.show_cost_tip': '토큰·비용 추정은 답변 길이를 기반으로 한 근사치이며 실제 청구액과 다를 수 있습니다. 끄면 글자 수만 표시합니다.',
    'set.rich': '풍부한 응답 서식 (이모지·표·구조화된 답변)',
    'set.rich_tip': '체크하면 구독 제품에서 보던 이모지·마크다운 표·제목 구조가 API 호출에서도 잘 나옵니다. (기본 ON) 체크를 해제하면 간결한 텍스트 위주로 나옵니다.',
    'set.timeout': '타임아웃 (초)',
    'set.timeout_tip': '응답이 지정 시간(초) 내에 시작되지 않으면 타임아웃으로 처리합니다. (기본 60초, 0=사용 안 함)',
    'set.max_tokens': '최대 응답 토큰',
    'set.max_tokens_tip': '한 응답의 최대 출력 토큰 수입니다. Claude(Anthropic)는 이 값이 필수라 너무 낮으면 긴 마스터 요약·답변이 잘립니다. 다른 모델은 각자 기본 상한을 사용합니다. (기본 8192)',
    'set.lang_h3': '언어 (Language)',
    'set.lang_muted': '앱 화면과 AI에게 보내는 지시문 언어를 바꿉니다. 기기 단위로 저장됩니다.',
    'set.security_h3': '보안 & 백업',
    'set.security_tip': '자동 잠금: 설정한 시간 동안 입력이 없으면 자동 로그아웃됩니다. 백업: 모든 데이터를 비밀번호로 암호화한 .json으로 내보내고, 같은 비밀번호로 다시 가져올 수 있습니다.',
    'set.autolock_label': '자동 잠금 (분) — 입력이 없으면 자동 로그아웃. 0 = 끔',
    'set.change_pw': '🔑 비밀번호 변경',
    'set.backup_export': '⬆ 암호화 백업 내보내기',
    'set.backup_import': '⬇ 백업 가져오기',
    'set.backup_pass_ph': '내보내기 백업 암호 (8자 이상)',
    'set.backup_pass2_ph': '백업 암호 확인',
    'set.backup_import_pass_ph': '가져오기 백업 암호',
    'set.backup_muted': '백업 파일은 별도 백업 암호로 암호화됩니다. 이 암호를 알면 다른 브라우저나 PC에서도 복원할 수 있습니다.',
    'set.storage_h3': '저장소 & 초기화',
    'set.storage_tip': '저장 공간은 이 브라우저가 이 사이트에 허용한 용량입니다. 대화내용 초기화는 채팅만 지우고, 데이터 초기화는 API 키·설정·채팅을 모두 지웁니다.',
    'set.storage_loading': '저장 공간 정보를 불러오는 중…',
    'set.reset_scope_html': '아래 작업은 <strong id="resetUserLabel">현재 사용자</strong>에게만 적용되며 되돌릴 수 없습니다. 대화내용 초기화는 채팅 기록만 지우고, 데이터 초기화는 API 키 · 설정 · 채팅 기록을 모두 지웁니다.',
    'set.reset_chats': '내 대화내용 초기화',
    'set.reset_all': '내 데이터 초기화 (설정 · 기록 삭제)',
    'set.delete_account': '계정 삭제 (데이터 포함)',
    'set.save_btn': '저장',

    // ---- password modal ----
    'pw.title': '비밀번호 변경',
    'pw.current_ph': '현재 비밀번호',
    'pw.new_ph': '새 비밀번호 (8자 이상)',
    'pw.new2_ph': '새 비밀번호 확인',
    'pw.muted': '변경하면 모든 데이터가 새 비밀번호로 다시 암호화됩니다. 잠시 시간이 걸릴 수 있습니다.',
    'pw.cancel': '취소',
    'pw.submit': '변경',
    'pw.changing': '변경 중…',
    'pw.fill_all': '모든 칸을 채워주세요.',
    'pw.new_mismatch': '새 비밀번호가 일치하지 않습니다.',

    // ---- help modal ----
    'help.title': '도움말 · 단축키',
    'help.shortcuts_h3': '단축키',
    'help.sc_new_html': '<kbd>Ctrl</kbd>+<kbd>N</kbd> — 새 채팅',
    'help.sc_search_html': '<kbd>Ctrl</kbd>+<kbd>K</kbd> — 채팅 검색으로 이동',
    'help.sc_enter_html': '<kbd>Enter</kbd> — PC 전송 / 모바일 줄바꿈 · <kbd>Shift</kbd>+<kbd>Enter</kbd> — PC 줄바꿈',
    'help.sc_esc_html': '<kbd>Esc</kbd> — 열린 창 닫기 / 이름 변경 취소',
    'help.features_h3': '기능 안내',
    'help.f_master_on_html': '<b>마스터 요약 (ON)</b> — 지정한 한 모델이 나머지 답을 하나로 합쳐 최종 답을 만들어 줍니다. 답들이 서로 맞으면 <b>✓ 일치</b>, 갈리면 <b>⚠ 이견</b> 배지가 붙어 어디가 미심쩍은지 바로 보입니다.',
    'help.f_master_off_html': '<b>마스터 요약 (OFF)</b> — 각 모델 답을 그대로 나란히 봅니다. 답들이 얼마나 비슷한지 막대로 알려주고, 모든 답이 도착하면 <b>🔍 교차검증</b> 버튼이 켜져 한 모델이 “어디가 같고 어디가 다른지”만 짚어 줍니다.',
    'help.f_web_html': '<b>🌐 웹 검색</b> — 켜면 최신 정보를 인터넷에서 찾아 출처와 함께 답합니다. 끄면 모델이 이미 아는 지식으로만 답합니다.',
    'help.f_view_html': '<b>⬛ 분할 / ▤ 통합</b> — 분할은 모델별 답을 나란히, 통합은 한 컬럼으로 모아서 봅니다.',
    'help.f_compact_html': '<b>🗜 대화 압축</b> — 대화가 길어지면 상단 <b>🗜 대화 압축</b> 버튼으로 이전 내용을 짧게 요약해 둡니다. 화면 대화는 그대로 남고, 다음 질문부터 토큰(비용)이 줄어듭니다.',
    'help.f_timeout_html': '<b>⏱️ 타임아웃</b> — 한 모델이 정한 시간(기본 60초) 안에 답을 안 주면 기다리지 않고 넘어갑니다. 마스터가 실패하면 다른 완료된 모델에게 요약을 대신 맡길 수 있습니다.',
    'help.f_chatinstr_html': '<b>📝 채팅별 지침</b> — 제목 옆 📝 버튼으로 이 채팅에서만 쓸 말투·규칙을 정합니다.',
    'help.f_plib_html': '<b>📚 자주 쓰는 프롬프트</b> — 즐겨 쓰는 문구를 저장해 두고 입력창에 한 번에 넣습니다.',
    'help.f_rich_html': '<b>✨ 풍부한 서식</b> — 켜면(기본) 답변에 표·이모지·소제목이 들어가 읽기 편하고, 끄면 담백한 글로 나옵니다.',
    'help.f_cost_html': '<b>💰 토큰·비용</b> — 답변마다 예상 사용량과 대략적 비용을 표시합니다(설정에서 끄기 가능). 켜진 모델이 많고 대화가 길수록, 첨부·웹 검색을 쓸수록 늘어납니다.',
    'help.f_attach_html': '<b>📎 첨부</b> — 이미지·PDF·텍스트 파일을 붙여 질문할 수 있습니다(이미지는 비전 지원 모델만).',
    'help.f_code_html': '<b>💻 코드 · 출처 [n]</b> — 답변 속 코드는 「복사」로 한 번에 복사하고, 출처 번호를 누르면 원문이 새 탭으로 열립니다.',
    'help.f_theme_html': '<b>🌙 테마 · 📌 고정 · 📁 폴더</b> — 우상단에서 다크·라이트를 바꾸고, 채팅을 상단 고정하거나 폴더로 정리합니다.',
    'help.mobile_h3': '📱 모바일 · 화면 전환',
    'help.m_toggle_html': '<b>상단 전환 버튼</b> — 상단 바의 <b>🖥️ / 📱</b> 버튼으로 PC·모바일 레이아웃을 직접 고정할 수 있습니다. 다시 누르면 자동 모드로 돌아갑니다.',
    'help.m_input_html': '<b>모바일 입력</b> — Enter는 줄바꿈이고, 전송은 하단 <b>전송</b> 버튼으로 합니다.',
    'help.m_gesture_html': '<b>모바일 제스처</b> — 화면 왼쪽/중앙 왼쪽에서 오른쪽으로 밀면 대시보드가 열리고, 열린 상태에서 왼쪽으로 밀면 닫힙니다.',
    'help.m_https_html': '<b>권장 접속 방식</b> — 배포 주소(<code>https://abandonships.github.io/API-tizer/</code>)로 접속하면 HTTPS 환경에서 로그인·암호화·온라인 동기화를 바로 사용할 수 있습니다.',
    'help.m_local_html': '<b>로컬 개발에서 휴대폰 접속</b> — 같은 와이파이의 <code>http://(PC주소):8753</code> 는 화면 확인용으로는 가능하지만, 일반 HTTP 특성상 로그인·암호화가 제한될 수 있습니다. 실제 로그인 테스트는 HTTPS 터널(cloudflared/ngrok) 또는 배포 주소를 사용하세요.',
    'help.m_sync_html': '<b>동기화 서버</b> — 로그인 화면의 <code>동기화 서버 설정</code>에서 Worker URL을 바꾸면 해당 기기에서만 다른 서버를 사용합니다.',
    'help.close': '닫기',

    // ---- per-chat instructions modal ----
    'chatinstr.title': '📝 이 채팅 전용 지침',
    'chatinstr.muted': '이 채팅에서만 적용되는 시스템 프롬프트입니다. 기존 전역 프롬프트를 대체합니다.',
    'chatinstr.ph': '예) 이번에는 캐주얼하고 간단하게 답해. 전문 용어 피하고, 재미있게.',
    'chatinstr.rich': '이 채팅에서 풍부한 응답 서식 (이모지·표·구조화) 사용',
    'chatinstr.rich_muted': '체크하면 이모지·표·구조 등을 사용하여 응답합니다.',
    'chatinstr.cancel': '취소',
    'chatinstr.save': '저장',

    // ---- prompt library modal ----
    'plib.title': '📚 프롬프트 라이브러리',
    'plib.muted': '자주 쓰는 프롬프트를 저장해 두고 한 번에 입력창에 넣을 수 있습니다. 저장된 프롬프트는 암호화되어 이 계정에만 보관되고 백업에도 포함됩니다.',
    'plib.new_title_ph': '제목 (예: 코드 리뷰)',
    'plib.new_text_ph': '프롬프트 내용을 입력하세요. (예: 아래 코드를 리뷰하고 버그·개선점을 한국어 불릿으로 정리해줘)',
    'plib.add': '+ 프롬프트 저장',
    'plib.close': '닫기',
    'plib.empty': '저장된 프롬프트가 없습니다. 위에서 추가해 보세요.',
    'plib.untitled': '(제목 없음)',
    'plib.insert': '삽입',
    'plib.insert_title': '입력창에 넣기',

    // ---- generic ----
    'common.ok': '확인',
    'common.cancel': '취소',
    'common.delete': '삭제',
    'common.error': '오류',
    'reset.current_user': '현재 사용자',

    // ---- strings in other modules (auth/db/sync/providers/markdown/state) ----
    'ext.empty_resp': '빈 응답을 받았습니다 (empty response)',
    'ext.all_attempts_failed': '{n}회 시도 모두 실패',
    'ext.storage_full': '브라우저 저장 공간이 가득 찼습니다. 오래된 채팅이나 큰 첨부 파일을 삭제해주세요.',
    'ext.decrypt_fail': '(복호화 실패)',
    'ext.bad_backup_format': '백업 형식이 올바르지 않습니다.',
    'ext.imported_chat': '가져온 채팅',
    'ext.pw_min': '비밀번호는 {n}자 이상이어야 합니다.',
    'ext.pw_mix': '비밀번호는 12자 미만이면 영문 대/소문자, 숫자, 특수문자 중 3종류 이상을 섞어주세요.',
    'ext.pw_repeat': '반복 문자만으로 된 비밀번호는 사용할 수 없습니다.',
    'ext.pw_common': '추측하기 쉬운 단어가 포함된 비밀번호는 사용할 수 없습니다.',
    'ext.id_required': '아이디를 입력하세요.',
    'ext.id_min': '아이디는 2자 이상이어야 합니다.',
    'ext.id_exists': '이미 존재하는 아이디입니다.',
    'ext.id_not_found': '존재하지 않는 아이디입니다.',
    'ext.pw_wrong': '비밀번호가 올바르지 않습니다.',
    'ext.account_not_found': '계정을 찾을 수 없습니다.',
    'ext.cur_pw_wrong': '현재 비밀번호가 올바르지 않습니다.',
    'ext.sync_no_server': '동기화 서버 주소가 설정되지 않았습니다.',
    'ext.sync_no_connect': '동기화 서버에 연결할 수 없습니다. 네트워크를 확인하세요.',
    'ext.sync_server_error': '서버 오류 ({status})',
    'ext.sync_no_session': '로그인 세션이 없습니다.',
    'ext.copy_code_title': '코드 복사',
    'ext.copy': '복사',
    'ext.local_label': '로컬',
    'ext.local_model': '로컬 모델 {n}',

    // ---- copy / clipboard ----
    'copy.copied': '복사됨 ✓',
    'copy.fail': '복사에 실패했습니다.',
    'copy.fail_clip': '복사에 실패했습니다. (localhost·HTTPS에서만 클립보드를 사용할 수 있습니다)',

    // ---- auth / session errors ----
    'err.no_crypto': '이 주소에서는 암호화를 사용할 수 없습니다. http://localhost:8753 로 접속하세요.',
    'err.enter_id_pw': '아이디와 비밀번호를 입력하세요.',
    'err.too_many': '로그인 시도가 너무 많습니다. {wait} 후 다시 시도하세요.',
    'err.no_sync_server': '동기화 서버 주소가 설정되지 않았습니다. 로컬 모드로 전환하거나 서버 주소를 등록하세요.',
    'err.pw_mismatch': '비밀번호가 일치하지 않습니다.',
    'err.autologin_expired': '자동 로그인 정보가 만료되었습니다. 다시 로그인하세요.',
    'err.autologin_read': '자동 로그인 정보를 읽지 못했습니다. 다시 로그인하세요.',
    'err.pw_changed_logout': '비밀번호가 변경되어 자동 로그아웃되었습니다. 새 비밀번호로 다시 로그인해주세요.',
    'err.idle_lock': '일정 시간 활동이 없어 자동 잠금되었습니다. 다시 로그인해주세요.',
    'err.session_expired': '세션이 만료되었습니다. 다시 로그인해주세요.',
    'err.model_no_key': 'API 키가 설정되지 않았습니다. ⚙️ 설정에서 키를 입력하세요.',

    // ---- time ----
    'time.hours': '{h}시간',
    'time.minutes': '{m}분',

    // ---- sync status ----
    'sync.syncing': '↻ 동기화 중…',
    'sync.synced': '✓ 동기화됨',
    'sync.offline': '⚠ 오프라인 (로컬 사용 중)',
    'sync.error': '⚠ 동기화 실패',

    // ---- confirms ----
    'confirm.logout': '로그아웃할까요? 다시 로그인하려면 비밀번호가 필요합니다.',
    'confirm.delete_chat': '이 채팅을 삭제할까요?',
    'confirm.reset_usage': '누적 사용량을 0으로 초기화할까요? (대화 기록은 유지됩니다)',
    'confirm.manual_compact': '이전 대화를 하나의 요약으로 압축할까요?\n\n채팅 화면의 내용은 그대로 남고, 이후 질문에는 (요약 + 최근 대화)만 전송돼 토큰을 아낍니다.',
    'confirm.reset_all': "{who} 데이터를 정말 초기화할까요?\n\n· 저장된 API 키와 설정\n· 모든 채팅 기록\n\n영구 삭제되며 되돌릴 수 없습니다. (계정은 유지됩니다)",
    'confirm.reset_chats': "{who}의 대화내용만 모두 삭제할까요?\n\n· 채팅방과 질문/답변 기록 삭제\n· API 키, 모델 설정, 개인 맞춤, 사용량은 유지\n\n되돌릴 수 없습니다.",
    'confirm.delete_account': '계정 {who} 을(를) 완전히 삭제할까요?\n\n이 계정의 모든 채팅 기록 · 설정 · API 키가 삭제되고\n로그인 화면으로 돌아갑니다. 되돌릴 수 없습니다.',
    'confirm.import_chats': '백업의 채팅 {n}개를 현재 계정에 추가할까요? (기존 기록은 유지됩니다)',
    'confirm.import_settings': '백업의 API 키 · 모델/단가 · 개인 맞춤 · 사용량 등 설정을 적용할까요? (현재 설정을 덮어씁니다)',

    // ---- alerts ----
    'alert.wait_response': '진행 중인 응답이 끝난 뒤 다시 시도해주세요.',
    'alert.wait_task': '진행 중인 작업이 끝난 뒤 다시 시도해주세요.',
    'alert.no_done_model': '아직 응답 완료된 모델이 없습니다.',
    'alert.need_two_done': '비교할 완료된 답변이 2개 이상 필요합니다.',
    'alert.pdf_reading': 'PDF를 읽는 중입니다. 잠시 후 다시 전송해주세요.',
    'alert.no_active_model': '활성화된 모델이 없습니다. 설정 또는 하단 칩에서 모델을 켜주세요.',
    'alert.nothing_export': '내보낼 대화가 없습니다.',
    'alert.online_delete_unsupported': '온라인 계정 삭제는 아직 서버 API가 없어 지원하지 않습니다.\n이 기기의 데이터만 지우려면 "내 데이터 초기화"를 사용하세요.',
    'alert.offline_no_pw': '오프라인 상태에서는 비밀번호를 변경할 수 없습니다.\n네트워크에 연결한 뒤 다시 시도해주세요.',
    'alert.backup_export_fail': '백업 내보내기 실패: {err}',
    'alert.backup_import_fail': '백업 가져오기 실패: {err}',

    // ---- attachments / files ----
    'file.too_big': '"{name}" 은(는) 너무 큽니다 (최대 {size}).',
    'file.type_unsupported': '"{name}" 형식은 지원하지 않습니다. 이미지 · PDF · 텍스트/코드 파일만 첨부할 수 있어요.',
    'file.pdf_read_fail': '"{name}" PDF를 읽지 못했습니다. (인터넷 연결이 필요하거나 손상된 파일일 수 있어요)',
    'file.read_fail': '"{name}" 을(를) 읽지 못했습니다.',
    'pdf.trunc': '\n…({total}쪽 중 {shown}쪽까지만 읽음)',
    'pdf.no_text': '(PDF에서 추출된 텍스트가 없습니다 — 스캔 이미지 PDF일 수 있습니다.)',
    'attach.pdf_reading': 'PDF 읽는 중…',
    'attach.remove': '제거',
    'attach.no_vision': '⚠ {models} 은(는) 비전 미지원으로 설정되어 이미지를 받지 않습니다. (설정에서 비전 체크)',

    // ---- payload / history block labels (sent to models) ----
    'payload.attach_img_stub': '[이전 첨부 이미지: {name} — 앞서 참고함]',
    'payload.attach_file_stub': '[이전 첨부 파일: {name} — 앞서 참고함]',
    'payload.attach_file': '[첨부 파일: {name}]\n```\n{text}\n```',
    'payload.fallback': '(첨부 파일을 참고해 답해주세요)',
    'hist.prev_synth_user': '[이전 공식 종합 — 사용자가 보고 이어가는 기준]',
    'hist.my_answer': '[내가 그 턴에 제출한 개별 답 — 내 관점·세부 참고]',
    'hist.prev_answer_trunc': '\n…(이전 답 일부 생략)',
    'hist.absent_synth': '[이전 공식 종합 — 이 턴에는 내가 응답하지 못했음. 내 답은 아니지만 그룹이 도달한 공식 결론이니 맥락으로만 참고]',
    'hist.prev_summary': '[이전 대화 요약 — 앞선 대화의 핵심입니다. 이 맥락을 이어서 답하세요]',
    'block.question': '[질문]',
    'block.each_model_answer': '[각 모델의 답변]',
    'block.prev_synth_ref': '[이전 공식 종합 — 참고]',
    'block.prev_summary_existing': '[기존 요약]',
    'block.to_compress': '[압축할 대화]',
    'block.user_prefix': '사용자',
    'block.summary_prefix': '정리',
    'block.attach_only': '(첨부만)',
    'block.no_response': '(응답 없음)',

    // ---- chat list / folders ----
    'folder.expand': '펼치기',
    'folder.collapse': '접기',
    'folder.no_folder': '채팅',
    'folder.move_to': '폴더로 이동',
    'folder.none_yet': '아직 만든 폴더가 없습니다.',
    'folder.remove_from': '폴더에서 빼기',
    'folder.new_ph': '새 폴더 이름',
    'folder.new': '새 폴더…',
    'chat.pin': '고정',
    'chat.unpin': '고정 해제',
    'chat.has_instr': '이 채팅 전용 지침 있음',
    'chat.assign_folder': '폴더 지정',
    'chat.rename': '이름 변경',
    'chat.delete': '삭제',
    'chat.default_title': '새 채팅',
    'chat.attach_title': '첨부 파일',
    'chat.untitled_export': '대화',

    // ---- model chips / cards ----
    'chip.toggle': '클릭하여 이 모델 켜기/끄기',
    'notice.master_excluded': '마스터 모델을 제외하면 마스터 기능이 꺼집니다.',
    'card.copy_answer': '이 답변 복사',
    'card.regen_master': '마스터 요약 재생성',
    'card.regen_model': '이 모델만 재생성',
    'card.master_head': '마스터 요약 · {label}',
    'card.master_head_alt': '마스터 요약 · {by} (대체)',
    'master.dissent_badge': '⚠ 이견',
    'master.dissent_title': '마스터가 소수 의견·이견을 표시했습니다. 판단을 확정하기 전에 각 모델의 원문을 확인해 보세요.\n\n',
    'master.agree_badge': '✓ 일치',
    'master.agree_title': '모델들의 답이 대체로 일치했습니다 (마스터가 특이한 소수 의견을 발견하지 못함).',
    'master.no_done': '완료된 모델이 없습니다.',
    'master.no_key': '마스터 모델 API 키가 없습니다.',
    'master.force_error': '요약 다시 실행 (모델 선택)',
    'master.force_now': '지금까지 응답으로 요약 실행',
    'notice.master_no_key': '👑 마스터 모델의 API 키가 없어 이번 답변은 요약 없이 진행합니다. ⚙️ 설정에서 키를 넣으면 다음부터 자동 요약됩니다.',

    // ---- cross-check ----
    'crosscheck.label': '🔍 교차검증',
    'crosscheck.copy': '교차검증 복사',
    'crosscheck.no_key': '교차검증할 모델의 API 키가 없습니다. ⚙️ 설정에서 키를 입력하세요.',
    'crosscheck.no_key_err': '교차검증 모델 API 키가 없습니다.',
    'crosscheck.running': '교차검증 중…',
    'crosscheck.again': '🔍 교차검증 다시',
    'crosscheck.btn_enabled': '완료된 답변들의 공통점·차이점을 한 모델이 짚어 줍니다 (토큰 사용)',
    'crosscheck.btn_disabled': '모든 답변이 도착하면 눌러서 교차 확인할 수 있어요',

    // ---- ensemble bar ----
    'ensemble.waiting': '⏳ 답변 기다리는 중… ({done}/{total} 완료)',
    'ensemble.insufficient': '완료된 답변이 부족해요 (비교하려면 2개 이상 필요)',
    'ensemble.agree': '✓ 답변 방향이 대체로 일치',
    'ensemble.diverge': '⚠ 답변이 갈립니다 — 교차 확인 권장',
    'ensemble.partial': '~ 부분적으로 일치',
    'ensemble.ready': '답변 비교 준비 완료',
    'ensemble.tip_ready': '완료된 답변들의 표현 유사도 근사치입니다. 정확한 비교는 🔍 교차검증을 눌러 확인하세요.',
    'ensemble.tip_wait': '모든 모델의 답변이 도착하면(또는 타임아웃되면) 교차검증을 사용할 수 있어요.',
    'ensemble.similarity': '유사도 ~{pct}%',

    // ---- status labels ----
    'status.pending_wait': '서버 응답 대기 중…',
    'status.master_collecting': '마스터가 전체 내용 취합 중…',
    'status.sub_pending': '서브 에이전트 응답 대기 중…',
    'status.retry_busy': '서버 혼잡 — {delay}초 후 자동 재시도… ({attempt}/2)',
    'status.aborted': '중단됨',
    'statuslabel.pending': '서버 응답 대기 중',
    'statuslabel.streaming': '응답 중',
    'statuslabel.done': '응답 완료',
    'statuslabel.timeout': '타임아웃',
    'statuslabel.aborted': '응답 중단됨',
    'statuslabel.error': '오류',
    'statuslabel.waiting': '대기 중',
    'timeout.secs': '{s}초 타임아웃',

    // ---- stats ----
    'stats.tokens': '~{n}토큰',
    'stats.io_title': '입력 ~{in} · 출력 ~{out} 토큰 (추정)',
    'stats.chars': '{n}자',
    'img.preview_alt': '링크 이미지 미리보기',

    // ---- aggregator selector ----
    'selector.title': '요약 모델 · 포함할 답변 선택',
    'selector.desc': '요약을 수행할 모델(집계자)과 요약에 포함할 답변을 고르세요. 마스터가 실패·지연되면 다른 모델로 요약할 수 있습니다.',
    'selector.group_model': '요약을 수행할 모델',
    'selector.group_answers': '요약에 포함할 답변',
    'selector.run': '요약 실행',

    // ---- citations ----
    'citations.title': '🔎 출처',

    // ---- compaction ----
    'compaction.card_title': '🗜 이전 대화 {n}개가 아래로 요약되었습니다',
    'compaction.card_sub': '채팅 내용은 그대로 남아 있어요. 이후 질문에는 이 요약 + 최근 대화만 전송됩니다 (토큰 절약).',
    'compaction.view': '요약 내용 보기',
    'compaction.prompt_title': '🗜 대화가 길어졌어요',
    'compaction.prompt_p': '이 대화가 길어져, 매 질문마다 함께 전송되는 이전 맥락이 약 {k}K 토큰까지 커졌어요. 그만큼 토큰(비용)이 늘어납니다.',
    'compaction.prompt_muted': '완전히 새로운 주제라면 “+ 새 채팅”이 가장 절약돼요. 지금 맥락을 이어가려면 앞부분 대화를 하나의 요약으로 압축할 수 있어요. 채팅 화면의 기존 내용은 그대로 남고 요약 카드가 하나 추가되며, 이후 질문에는 (요약 + 최근 대화)만 전송됩니다.',
    'compaction.just_continue': '그냥 계속',
    'compaction.do_summarize': '이전 대화 요약하기',
    'notice.summ_no_key': '요약할 모델의 API 키가 없습니다. ⚙️ 설정에서 키를 입력하세요.',
    'notice.summarizing': '🗜 이전 대화를 요약하는 중… (잠시만요)',
    'notice.summ_fail': '요약에 실패했습니다: {err}',
    'notice.summ_empty': '요약 결과가 비어 있어 압축을 건너뜁니다.',
    'notice.compacted': '✅ 이전 {n}개 대화를 요약했습니다. 이후 질문은 요약 + 최근 대화만 전송됩니다.',
    'notice.not_long_enough': '아직 요약할 만큼 대화가 길지 않습니다.',

    // ---- question / unified ----
    'q.copy': '질문 복사',
    'q.edit_resend': '질문 수정 후 다시 보내기',
    'q.resend': '같은 질문 다시 보내기',
    'unified.expand': '개별 모델 답변 {n}개 펼쳐 보기',
    'unified.hint': '💡 마스터 요약을 켜면 4개 답을 하나로 합쳐 줍니다. 지금은 개별 답을 펼쳐 보세요.',

    // ---- empty state ----
    'empty.h2': '하나의 질문, 여러 지성의 답',
    'empty.p': '한 번 입력하면 모든 모델이 동시에 사고하고, 마스터가 그 모두를 하나로 엮습니다.',
    'empty.li1': '⬛ 분할 뷰 — 모델별 답변을 나란히 비교',
    'empty.li2': '▤ 통합 뷰 + 마스터 요약 — 하나의 결론, 그리고 소수 의견',
    'empty.li3': '+ 새 채팅 — 맥락을 비워 토큰을 아끼고 새 주제로 시작',
    'empty.li4': '⚙️ 설정 — API 키 · 개인 맞춤 · 로컬 엔드포인트',

    // ---- export ----
    'export.title': '# {title}',
    'export.compaction': '## 🗜 이전 대화 요약 ({n}개 압축)',
    'export.question': '## 🙋 질문',
    'export.attach': '*첨부: {names}*',
    'export.master': '### 👑 마스터 요약{label}',
    'export.crosscheck': '### 🔍 교차검증{label}',

    // ---- model settings rows ----
    'model.api_key': 'API 키',
    'model.api_key_optional': 'API 키 (선택)',
    'model.key_ph': 'sk-...',
    'model.key_ph_local': '필요 시 입력',
    'model.key_link_title': '{label} API 키 발급/관리 페이지로 이동',
    'model.master': '👑 마스터',
    'model.vision': '비전',
    'model.vision_title': '이 모델이 이미지(비전) 입력을 지원하면 체크하세요. 끄면 이미지를 보내지 않습니다.',
    'model.use': '사용',
    'model.remove': '삭제',
    'model.display_name': '표시 이름',
    'model.model_name': '모델 이름',
    'model.pick_or_type': '목록에서 선택하거나 직접 입력',
    'model.type_name': '모델 이름 직접 입력',
    'model.price_opt': '{label} · 입력 ${in}/1M · 출력 ${out}/1M',
    'model.price_label': '예상 단가 (USD / 100만 토큰) ',
    'model.price_tip': '월 예상 금액은 각 답변의 추정 토큰 수 × 이 단가로 계산됩니다. 기본값은 공개 가격표 기준이며, 본인 요금제에 맞게 직접 수정할 수 있습니다. (토큰 수도 글자 길이 기반 추정치라 실제 청구액과 다를 수 있어요.)',
    'model.price_in': '입력',
    'model.price_out': '출력',
    'local.max': '로컬 최대 {n}개',
    'local.add': '+ 로컬 엔드포인트 추가',

    // ---- save hints ----
    'savehint.saved': '저장됨 ✓',
    'savehint.enter_backup_pass': '백업 암호를 입력해주세요.',
    'savehint.reset_done': '초기화 완료 ✓',
    'savehint.reset_chats_done': '대화내용 초기화 완료 ✓',
    'savehint.pw_done_sync': '비밀번호 변경 완료 ✓ (다른 기기는 새 비밀번호로 다시 로그인해야 합니다)',
    'savehint.pw_done': '비밀번호 변경 완료 ✓',
    'savehint.backup_exported': '백업 내보냄 ({n}개 채팅) ✓',
    'savehint.backup_imported': '백업 가져옴 ({parts}) ✓',
    'savehint.backup_nothing': '가져온 항목이 없습니다.',
    'storage.usage': '사용 중인 저장 공간: {used} MB / {quota} MB ({pct}%)',
    'storage.unavailable': '저장 공간 정보를 사용할 수 없습니다.',

    // ---- backup ----
    'backup.enter_pass': '백업 암호를 입력해주세요.',
    'backup.pass_min': '백업 암호는 8자 이상이어야 합니다.',
    'backup.pass_mismatch': '백업 암호 확인이 일치하지 않습니다.',
    'backup.bad_file': '올바른 API-Tizer 백업 파일이 아닙니다.',
    'backup.pass_wrong': '백업 암호가 올바르지 않습니다.',
    'backup.old_format': '이전 형식 백업입니다. 만든 브라우저의 같은 계정에서만 가져올 수 있습니다. 새 백업으로 다시 내보내 주세요.',
    'backup.parts_chats': '채팅 {n}개',
    'backup.parts_settings': '설정·API 키',

    // ---- password change (errors) ----
    'pwerr.offline': '오프라인 상태에서는 비밀번호를 변경할 수 없습니다. 네트워크 연결 후 다시 시도해주세요.',
    'pwerr.sync_fail': '동기화에 실패해 비밀번호를 바꾸지 못했습니다. 네트워크를 확인하고 다시 시도해주세요.',
    'pwerr.session_ended': '세션이 종료되어 비밀번호 변경을 완료하지 못했습니다. 새 비밀번호로 다시 로그인해주세요.',

    // ---- AI system instructions (sent to the models) ----
    'instr.rich':
      '모든 답변은 가독성이 높고 시각적으로 풍부한 마크다운 형식으로 작성하세요.\n' +
      '- ## 제목, ### 소제목을 사용해 명확히 구조화하세요.\n' +
      '- 번호 목록과 불릿 목록을 적극 활용하세요.\n' +
      '- 데이터, 비교, 목록, 단계 설명 등은 반드시 마크다운 표(| 컬럼 |)로 표현하세요. 구분선(|---|)을 반드시 포함하세요.\n' +
      '- 상황에 맞게 자연스럽게 이모지(✅ 📌 💡 ⚠️ 등)를 사용하세요. 이모지는 주로 제목이나 중요한 포인트 앞에 배치하는 것이 좋습니다.\n' +
      '- 핵심 내용은 **굵게**, 코드나 용어는 `인라인 코드`로 강조하세요.\n' +
      '- 전체적으로 친절하고 읽기 쉬우며 시각적으로 잘 정리된 스타일을 유지하세요.',
    'instr.continuity':
      '당신은 API-tizer의 여러 AI 중 하나입니다. 같은 질문에 여러 모델이 답하고, 필요할 때 마스터가 공식 종합을 만듭니다.\n' +
      '이전 대화에 아래 두 블록이 함께 있을 수 있습니다.\n' +
      '1) [이전 공식 종합] — 사용자가 읽고 이어가는 공통 기준. 후속 질문의 기본 전제로 우선하세요.\n' +
      '2) [내가 그 턴에 제출한 개별 답] — 당신이 그때 쓴 원문. 관점·세부·이견·톤을 파악하는 참고용입니다.\n' +
      '사용자가 공식 결론을 따르는 취지(예: 특정 옵션 선택)면 공식 종합을 우선하고, ' +
      '이견·심화를 묻거나 유의미한 보완이 있으면 개별 답의 개성을 살려도 됩니다. ' +
      '공식만 복창하거나 개별 소수 의견만 고집하지 마세요. 다른 모델의 원문은 주어지지 않습니다.',
    'instr.master':
      '당신은 여러 AI의 답변을 종합하는 편집자입니다. 목표는 매끄러운 하나의 답이 아니라, ' +
      '여러 독립 모델의 교차 검증으로 신뢰도를 높이고 불확실성을 드러내는 것입니다. 아래 규칙을 지키세요.\n' +
      '1) 여러 모델이 공통으로 말한 내용을 가장 신뢰도 높은 핵심으로 삼아 명확하고 충분히 자세한 최종 답변을 쓰세요. ' +
      '중요 수치·코드·고유명사·선택지 정의는 생략하지 마세요.\n' +
      '2) 모델 간 사실이 상충하면 임의로 하나를 고르지 말고 어느 모델이 무엇을 다르게 말했는지 그대로 드러내세요(예: "A는 X, B는 Y"). ' +
      '한 모델만 주장하고 다른 모델엔 없는 내용은 "한 모델 주장"으로 구분해 신뢰 수준을 낮춰 표시하세요.\n' +
      '3) 어떤 모델도 말하지 않은 새로운 사실을 지어내지 마세요. 답변들에 근거가 있는 내용만 쓰세요.\n' +
      '입력에 [이전 공식 종합 — 참고]가 있으면 용어·선택지·이전 결론의 연속을 맞추는 데 참고하되, 주 재료는 이번 질문과 이번 답변입니다. ' +
      '이전 종합을 고정하지 말고 필요하면 수정·갱신하세요.\n' +
      "마지막에 '### 소수 의견' 섹션을 추가해, 다른 모델들과 눈에 띄게 다른 주장을 한 모델이 있으면 어느 모델이 무엇을 다르게 말했는지 1~3줄로 적으세요. " +
      "의미 있는 차이가 없으면 '특이한 소수 의견 없음'이라고 적으세요.",
    'instr.crosscheck':
      '당신은 여러 AI 답변의 교차 검증관입니다. 답을 새로 종합하거나 최종 결론을 내리지 마세요. ' +
      '대신 아래 답변들을 비교해 (1) 여러 모델이 공통으로 일치하는 핵심과 (2) 서로 상충하거나 한 모델만 주장하는 지점(사실·수치·결론이 다른 부분)을 구분해 간결한 마크다운으로 정리하세요. ' +
      '상충 지점은 "A는 X, B는 Y"처럼 누가 무엇을 다르게 말했는지 명시하고, 사용자가 어디를 더 확인해야 하는지 알 수 있게 하세요. 새로운 사실을 지어내지 마세요.',
    'instr.compaction':
      '당신은 긴 대화를 이후 대화에 필요한 핵심만 남겨 압축하는 요약가입니다. ' +
      '결정된 사항, 사용자의 선호·전제·제약, 중요한 고유명사·수치·용어 정의, 아직 해결되지 않은 질문을 반드시 보존하세요. ' +
      '잡담과 중복은 지우고, 이후 어떤 모델이든 이 요약만 보고 맥락을 자연스럽게 이어갈 수 있도록 ' +
      '구조화된 마크다운(제목·불릿)으로 간결하게 작성하세요. 새로운 내용을 지어내지 마세요.',
    'instr.minority_header': '소수 의견',
    'instr.minority_none': '특이한 소수 의견 없음',
  },

  en: {
    'meta.title': 'API-Tizer · Multi-AI Console',

    // ---- auth screen ----
    'auth.sub_online': 'Securely synced across your devices. (Zero-knowledge encryption)',
    'auth.sub_online_short': 'Securely synced across your devices.',
    'auth.sub_local': 'Encrypted and stored in this browser only.',
    'auth.mode_online': '☁ Online',
    'auth.mode_online_title': 'Auto-sync across devices (only ciphertext is stored on the server)',
    'auth.mode_local': '💻 This device only',
    'auth.mode_local_title': 'Stored in this browser only (no sync)',
    'auth.sync_summary': 'Sync server settings',
    'auth.sync_ph': 'https://api-tizer-sync.name.workers.dev',
    'auth.sync_hint_html': 'Enter your Cloudflare Worker URL. See <code>worker/README.md</code> for deployment.',
    'auth.user_ph': 'Username',
    'auth.pass_ph': 'Password',
    'auth.pass2_ph': 'Confirm password',
    'auth.remember_id': 'Remember username',
    'auth.auto_login': 'Auto login',
    'auth.check_warn': 'Use only on your personal device. Logging out clears the auto-login info.',
    'auth.login': 'Log in',
    'auth.signup': 'Sign up',
    'auth.switch_to_signup': "Don't have an account?",
    'auth.switch_to_login': 'Already have an account?',
    'auth.warn': 'Passwords must be at least 8 characters; longer is safer. If you forget it, your encrypted data cannot be recovered.',
    'auth.processing': 'Processing…',
    'auth.autologin_ing': 'Auto logging in…',

    // ---- sidebar ----
    'side.new_chat': '+ New chat',
    'side.new_chat_title': 'New chat (clears earlier context to save tokens)',
    'side.brand_title': 'Start a new chat',
    'side.search_ph': '🔍 Search chats (title · content)',
    'side.usage_title': 'Estimated total',
    'side.usage_tip': 'This is a client-side estimate based on response length, so it may differ from your actual bill; local models are free and excluded. It keeps accumulating until reset.\n\nTokens (= cost) grow when:\n· more models are enabled\n· master summary is on\n· the conversation is long (prior context is sent too)\n· image/PDF attachments or web search are used\n\nImages/PDFs are sent in full only for the most recent questions; older ones become summary references (to save tokens). Re-attach an image if you need a precise re-analysis.',
    'side.usage_reset': '↺ Reset usage',
    'side.usage_reset_title': 'Reset accumulated usage to 0',
    'side.sync_now': '↻ Sync',
    'side.sync_now_title': 'Sync now',
    'side.settings': '⚙️ Settings',
    'side.logout': '🔒 Log out',
    'side.foot_online': 'Keys and history are stored encrypted; only ciphertext is synced to the server.',
    'side.foot_local': 'Keys and history are stored encrypted in this browser only.',
    'side.empty': 'No chats yet. Start a new one.',
    'side.search_empty': 'No results for "{term}".',
    'side.pinned': '📌 Pinned',

    // ---- topbar ----
    'top.menu': 'Menu',
    'top.chat_instr_title': 'Per-chat prompt / instructions (overrides the global prompt, per-chat rich formatting)',
    'top.layout_title': 'Switch PC / mobile layout',
    'top.theme_title': 'Switch light / dark theme',
    'top.theme_to_dark': 'Switch to dark theme',
    'top.theme_to_light': 'Switch to light theme',
    'top.help_title': 'Help · shortcuts',
    'top.compact': '🗜 Compact chat',
    'top.compact_title': 'Summarizes earlier messages so later questions use fewer tokens (cost). The on-screen conversation stays intact.',
    'top.compact_title_inactive': 'Available once the conversation gets longer. It summarizes earlier messages so later questions use fewer tokens (cost).',
    'top.export': '⬇ Export',
    'top.export_title': 'Export the conversation as a Markdown file',
    'top.view_title': 'Split: model answers side by side / Unified: one column',
    'top.view_split': '⬛⬛ Split',
    'top.view_split_title': 'Compare model answers side by side',
    'top.view_unified': '▤ Unified',
    'top.view_unified_title': 'One column (master summary + expandable individual answers)',
    'top.master': 'Master',
    'top.master_title': 'The master model condenses all answers into one',
    'top.master_tip': 'Toggle master summary',
    'top.layout_to_pc_auto': 'Switch to PC view (current: auto)',
    'top.layout_to_mobile_auto': 'Switch to mobile view (current: auto)',
    'top.layout_to_pc_tip': 'Switch to PC layout (current: auto)',
    'top.layout_to_mobile_tip': 'Switch to mobile layout (current: auto)',
    'top.layout_back_auto': 'Back to auto layout',

    // ---- composer ----
    'comp.attach_title': 'Attach files/images (drag & drop or paste too)',
    'comp.attach_aria': 'Attach file',
    'comp.web_title': 'Web search (supported: ChatGPT · Claude · Gemini · Grok)',
    'comp.plib_title': 'Prompt library (save & insert frequently used prompts)',
    'comp.ph_desktop': 'Ask anything. All enabled models answer at once.  (Enter to send · Shift+Enter for newline)',
    'comp.ph_mobile': 'Ask anything. Enter = newline · use the Send button',
    'comp.send': 'Send',
    'comp.stop': '■ Stop',

    // ---- settings modal ----
    'set.title': 'Settings',
    'set.custom_h3': 'Personalization (global system prompt)',
    'set.custom_tip': "Whatever you write here is always sent as a system prompt to every conversation and every model. E.g., your role, answer tone, output format. Combined with 'Rich formatting' (on by default), it keeps the emoji/table/structure style of the web chat apps (ChatGPT, Claude, etc.) while applying your rules. It is not lost when you start a new chat.",
    'set.custom_muted': "The default system prompt applied to all conversations. If you set a dedicated prompt for a specific chat with the '📝' button, the global prompt is completely ignored in that chat.",
    'set.custom_ph': 'e.g. I am a solo developer building products. Answer in English, state the conclusion first, then concise bullet points for reasons. I prefer immediately actionable suggestions over abstract theory.',
    'set.model_h3': 'Models / API',
    'set.model_tip': 'On each row: 👑Master = pick 1 model to write the summary · Vision = supports image input · Use = include in the conversation. API keys are stored encrypted, and in online mode only ciphertext is synced.',
    'set.add_local': '+ Add local endpoint',
    'set.model_muted': 'The model set as master condenses every answer into one and appends a minority opinion. You can add up to 3 local endpoints (Ollama / LM Studio, etc., OpenAI-compatible).',
    'set.display_h3': 'Display options',
    'set.show_cost': 'Show token/cost estimate on answers',
    'set.show_cost_tip': 'The token/cost estimate is an approximation based on answer length and may differ from your actual bill. Turn it off to show character count only.',
    'set.rich': 'Rich formatting (emoji · tables · structured answers)',
    'set.rich_tip': 'When checked, the emoji, Markdown tables, and heading structure you see in the web chat apps (ChatGPT, Claude, etc.) also come through on API calls. (On by default) Uncheck for plainer, text-focused answers.',
    'set.timeout': 'Timeout (sec)',
    'set.timeout_tip': "If a response doesn't start within the given time (sec), it is treated as a timeout. (Default 60s, 0 = disabled)",
    'set.max_tokens': 'Max response tokens',
    'set.max_tokens_tip': 'Maximum output tokens per response. Claude (Anthropic) requires this value, so too low a number truncates long master summaries/answers. Other models use their own defaults. (Default 8192)',
    'set.lang_h3': 'Language (언어)',
    'set.lang_muted': 'Changes the language of the app UI and the instructions sent to the AI. Saved per device.',
    'set.security_h3': 'Security & backup',
    'set.security_tip': 'Auto-lock: automatically logs you out after the set idle time. Backup: export all data as a password-encrypted .json and import it again with the same password.',
    'set.autolock_label': 'Auto-lock (min) — auto logout when idle. 0 = off',
    'set.change_pw': '🔑 Change password',
    'set.backup_export': '⬆ Export encrypted backup',
    'set.backup_import': '⬇ Import backup',
    'set.backup_pass_ph': 'Export backup password (8+ chars)',
    'set.backup_pass2_ph': 'Confirm backup password',
    'set.backup_import_pass_ph': 'Import backup password',
    'set.backup_muted': 'Backup files are encrypted with a separate backup password. Anyone with that password can restore them on another browser or PC.',
    'set.storage_h3': 'Storage & reset',
    'set.storage_tip': 'Storage is the quota this browser grants this site. Resetting chats clears chats only; resetting data clears API keys, settings, and chats.',
    'set.storage_loading': 'Loading storage info…',
    'set.reset_scope_html': 'The actions below apply only to <strong id="resetUserLabel">the current user</strong> and cannot be undone. Resetting chats clears chat history only; resetting data clears API keys, settings, and chat history.',
    'set.reset_chats': 'Reset my chats',
    'set.reset_all': 'Reset my data (delete settings · history)',
    'set.delete_account': 'Delete account (incl. data)',
    'set.save_btn': 'Save',

    // ---- password modal ----
    'pw.title': 'Change password',
    'pw.current_ph': 'Current password',
    'pw.new_ph': 'New password (8+ chars)',
    'pw.new2_ph': 'Confirm new password',
    'pw.muted': 'Changing it re-encrypts all your data with the new password. This may take a moment.',
    'pw.cancel': 'Cancel',
    'pw.submit': 'Change',
    'pw.changing': 'Changing…',
    'pw.fill_all': 'Please fill in every field.',
    'pw.new_mismatch': 'The new passwords do not match.',

    // ---- help modal ----
    'help.title': 'Help · shortcuts',
    'help.shortcuts_h3': 'Shortcuts',
    'help.sc_new_html': '<kbd>Ctrl</kbd>+<kbd>N</kbd> — New chat',
    'help.sc_search_html': '<kbd>Ctrl</kbd>+<kbd>K</kbd> — Jump to chat search',
    'help.sc_enter_html': '<kbd>Enter</kbd> — Send on PC / newline on mobile · <kbd>Shift</kbd>+<kbd>Enter</kbd> — newline on PC',
    'help.sc_esc_html': '<kbd>Esc</kbd> — Close open dialog / cancel rename',
    'help.features_h3': 'Features',
    'help.f_master_on_html': '<b>Master summary (ON)</b> — One chosen model merges the other answers into a final answer. If the answers agree you get a <b>✓ Match</b> badge; if they diverge, a <b>⚠ Dissent</b> badge shows you where to be skeptical.',
    'help.f_master_off_html': '<b>Master summary (OFF)</b> — See each model\'s answer side by side. A bar shows how similar they are, and once all answers arrive the <b>🔍 Cross-check</b> button lights up so one model points out only "what\'s the same and what differs".',
    'help.f_web_html': '<b>🌐 Web search</b> — When on, it finds up-to-date info online and answers with sources. When off, models answer from what they already know.',
    'help.f_view_html': '<b>⬛ Split / ▤ Unified</b> — Split shows model answers side by side; Unified gathers them into one column.',
    'help.f_compact_html': '<b>🗜 Compact chat</b> — When a conversation grows long, use the <b>🗜 Compact chat</b> button at the top to briefly summarize earlier content. The on-screen conversation stays, and later questions use fewer tokens (cost).',
    'help.f_timeout_html': "<b>⏱️ Timeout</b> — If a model doesn't answer within the set time (default 60s), it moves on without waiting. If the master fails, another finished model can write the summary instead.",
    'help.f_chatinstr_html': '<b>📝 Per-chat instructions</b> — Use the 📝 button next to the title to set the tone/rules used only in this chat.',
    'help.f_plib_html': '<b>📚 Frequent prompts</b> — Save your favorite phrases and drop them into the input in one click.',
    'help.f_rich_html': '<b>✨ Rich formatting</b> — When on (default), answers include tables, emoji, and subheadings for easy reading; off gives plainer text.',
    'help.f_cost_html': '<b>💰 Tokens/cost</b> — Each answer shows estimated usage and rough cost (can be turned off in Settings). It grows with more enabled models, longer chats, and attachment/web-search use.',
    'help.f_attach_html': '<b>📎 Attachments</b> — Attach images, PDFs, or text files to your question (images only for vision-capable models).',
    'help.f_code_html': '<b>💻 Code · Sources [n]</b> — Copy code in an answer with "Copy" in one click; click a source number to open the original in a new tab.',
    'help.f_theme_html': '<b>🌙 Theme · 📌 Pin · 📁 Folder</b> — Switch dark/light at the top right, and pin chats to the top or organize them into folders.',
    'help.mobile_h3': '📱 Mobile · layout switching',
    'help.m_toggle_html': '<b>Top toggle button</b> — Use the <b>🖥️ / 📱</b> button in the top bar to force PC/mobile layout. Press again to return to auto mode.',
    'help.m_input_html': '<b>Mobile input</b> — Enter makes a newline; send with the <b>Send</b> button at the bottom.',
    'help.m_gesture_html': '<b>Mobile gestures</b> — Swipe right from the left edge/left-center to open the sidebar; swipe left while open to close it.',
    'help.m_https_html': '<b>Recommended access</b> — Visiting the deployed URL (<code>https://abandonships.github.io/API-tizer/</code>) lets you use login, encryption, and online sync right away over HTTPS.',
    'help.m_local_html': '<b>Phone access in local dev</b> — <code>http://(PC-address):8753</code> on the same Wi-Fi works for viewing, but plain HTTP may limit login/encryption. For real login tests use an HTTPS tunnel (cloudflared/ngrok) or the deployed URL.',
    'help.m_sync_html': '<b>Sync server</b> — Changing the Worker URL under <code>Sync server settings</code> on the login screen uses a different server on that device only.',
    'help.close': 'Close',

    // ---- per-chat instructions modal ----
    'chatinstr.title': '📝 Instructions for this chat',
    'chatinstr.muted': 'A system prompt applied only to this chat. It replaces the global prompt.',
    'chatinstr.ph': 'e.g. This time answer casually and briefly. Avoid jargon and keep it fun.',
    'chatinstr.rich': 'Use rich formatting (emoji · tables · structure) in this chat',
    'chatinstr.rich_muted': 'When checked, answers use emoji, tables, structure, etc.',
    'chatinstr.cancel': 'Cancel',
    'chatinstr.save': 'Save',

    // ---- prompt library modal ----
    'plib.title': '📚 Prompt library',
    'plib.muted': 'Save frequently used prompts and drop them into the input in one click. Saved prompts are encrypted, kept only in this account, and included in backups.',
    'plib.new_title_ph': 'Title (e.g. Code review)',
    'plib.new_text_ph': 'Enter the prompt text. (e.g. Review the code below and list bugs/improvements as English bullet points)',
    'plib.add': '+ Save prompt',
    'plib.close': 'Close',
    'plib.empty': 'No saved prompts yet. Add one above.',
    'plib.untitled': '(Untitled)',
    'plib.insert': 'Insert',
    'plib.insert_title': 'Insert into the input',

    // ---- generic ----
    'common.ok': 'OK',
    'common.cancel': 'Cancel',
    'common.delete': 'Delete',
    'common.error': 'Error',
    'reset.current_user': 'the current user',

    // ---- strings in other modules (auth/db/sync/providers/markdown/state) ----
    'ext.empty_resp': 'Received an empty response',
    'ext.all_attempts_failed': 'All {n} attempts failed',
    'ext.storage_full': 'Browser storage is full. Please delete old chats or large attachments.',
    'ext.decrypt_fail': '(decryption failed)',
    'ext.bad_backup_format': 'The backup format is invalid.',
    'ext.imported_chat': 'Imported chat',
    'ext.pw_min': 'Password must be at least {n} characters.',
    'ext.pw_mix': 'Passwords under 12 characters must mix at least 3 of: uppercase, lowercase, digits, symbols.',
    'ext.pw_repeat': 'A password made of only repeated characters is not allowed.',
    'ext.pw_common': 'Passwords containing easy-to-guess words are not allowed.',
    'ext.id_required': 'Please enter a username.',
    'ext.id_min': 'Username must be at least 2 characters.',
    'ext.id_exists': 'That username already exists.',
    'ext.id_not_found': 'That username does not exist.',
    'ext.pw_wrong': 'Incorrect password.',
    'ext.account_not_found': 'Account not found.',
    'ext.cur_pw_wrong': 'The current password is incorrect.',
    'ext.sync_no_server': 'No sync server URL is set.',
    'ext.sync_no_connect': 'Cannot connect to the sync server. Check your network.',
    'ext.sync_server_error': 'Server error ({status})',
    'ext.sync_no_session': 'No login session.',
    'ext.copy_code_title': 'Copy code',
    'ext.copy': 'Copy',
    'ext.local_label': 'Local',
    'ext.local_model': 'Local model {n}',

    // ---- copy / clipboard ----
    'copy.copied': 'Copied ✓',
    'copy.fail': 'Copy failed.',
    'copy.fail_clip': 'Copy failed. (The clipboard is only available on localhost/HTTPS.)',

    // ---- auth / session errors ----
    'err.no_crypto': 'Encryption is not available at this address. Please visit http://localhost:8753.',
    'err.enter_id_pw': 'Please enter your username and password.',
    'err.too_many': 'Too many login attempts. Try again in {wait}.',
    'err.no_sync_server': 'No sync server URL is set. Switch to local mode or register a server URL.',
    'err.pw_mismatch': 'The passwords do not match.',
    'err.autologin_expired': 'Your auto-login has expired. Please log in again.',
    'err.autologin_read': 'Could not read the auto-login info. Please log in again.',
    'err.pw_changed_logout': 'You were logged out because the password changed. Please log in again with the new password.',
    'err.idle_lock': 'Auto-locked due to inactivity. Please log in again.',
    'err.session_expired': 'Your session has expired. Please log in again.',
    'err.model_no_key': 'No API key is set. Enter one in ⚙️ Settings.',

    // ---- time ----
    'time.hours': '{h}h',
    'time.minutes': '{m}m',

    // ---- sync status ----
    'sync.syncing': '↻ Syncing…',
    'sync.synced': '✓ Synced',
    'sync.offline': '⚠ Offline (using local)',
    'sync.error': '⚠ Sync failed',

    // ---- confirms ----
    'confirm.logout': 'Log out? You will need your password to log in again.',
    'confirm.delete_chat': 'Delete this chat?',
    'confirm.reset_usage': 'Reset accumulated usage to 0? (Chat history is kept.)',
    'confirm.manual_compact': 'Compress the earlier conversation into a single summary?\n\nThe on-screen chat stays intact, and later questions send only (summary + recent messages) to save tokens.',
    'confirm.reset_all': "Really reset {who}'s data?\n\n· Saved API keys and settings\n· All chat history\n\nThis is permanent and cannot be undone. (The account is kept.)",
    'confirm.reset_chats': "Delete all of {who}'s chats only?\n\n· Chats and their Q&A history are deleted\n· API keys, model settings, personalization, and usage are kept\n\nThis cannot be undone.",
    'confirm.delete_account': "Completely delete account {who}?\n\nAll chats, settings, and API keys for this account will be deleted\nand you'll return to the login screen. This cannot be undone.",
    'confirm.import_chats': 'Add {n} chats from the backup to the current account? (Existing history is kept.)',
    'confirm.import_settings': 'Apply the backup\'s API keys · models/pricing · personalization · usage settings? (Overwrites current settings.)',

    // ---- alerts ----
    'alert.wait_response': 'Please try again after the current response finishes.',
    'alert.wait_task': 'Please try again after the current task finishes.',
    'alert.no_done_model': 'No model has finished responding yet.',
    'alert.need_two_done': 'At least 2 finished answers are needed to compare.',
    'alert.pdf_reading': 'Reading the PDF. Please send again in a moment.',
    'alert.no_active_model': 'No models are enabled. Turn one on in Settings or the chips below.',
    'alert.nothing_export': 'There is no conversation to export.',
    'alert.online_delete_unsupported': 'Deleting an online account is not supported yet (no server API).\nTo erase only this device\'s data, use "Reset my data".',
    'alert.offline_no_pw': "You can't change your password while offline.\nConnect to a network and try again.",
    'alert.backup_export_fail': 'Backup export failed: {err}',
    'alert.backup_import_fail': 'Backup import failed: {err}',

    // ---- attachments / files ----
    'file.too_big': '"{name}" is too large (max {size}).',
    'file.type_unsupported': '"{name}" is an unsupported format. Only images · PDFs · text/code files can be attached.',
    'file.pdf_read_fail': 'Could not read the "{name}" PDF. (It may need an internet connection or be a corrupted file.)',
    'file.read_fail': 'Could not read "{name}".',
    'pdf.trunc': '\n…(read only {shown} of {total} pages)',
    'pdf.no_text': '(No text was extracted from the PDF — it may be a scanned-image PDF.)',
    'attach.pdf_reading': 'Reading PDF…',
    'attach.remove': 'Remove',
    'attach.no_vision': '⚠ {models} is set to no-vision and will not receive images. (Check Vision in Settings.)',

    // ---- payload / history block labels (sent to models) ----
    'payload.attach_img_stub': '[Previous attached image: {name} — referenced earlier]',
    'payload.attach_file_stub': '[Previous attached file: {name} — referenced earlier]',
    'payload.attach_file': '[Attached file: {name}]\n```\n{text}\n```',
    'payload.fallback': '(Please answer using the attached file.)',
    'hist.prev_synth_user': '[Previous official synthesis — the baseline the user reads and builds on]',
    'hist.my_answer': '[My individual answer for that turn — reference for my perspective/details]',
    'hist.prev_answer_trunc': '\n…(part of the previous answer omitted)',
    'hist.absent_synth': "[Previous official synthesis — I didn't answer this turn. It's not my answer, but it's the group's official conclusion, so use it only as context]",
    'hist.prev_summary': '[Previous conversation summary — the gist of earlier turns. Continue from this context]',
    'block.question': '[Question]',
    'block.each_model_answer': "[Each model's answer]",
    'block.prev_synth_ref': '[Previous official synthesis — reference]',
    'block.prev_summary_existing': '[Existing summary]',
    'block.to_compress': '[Conversation to compress]',
    'block.user_prefix': 'User',
    'block.summary_prefix': 'Summary',
    'block.attach_only': '(attachment only)',
    'block.no_response': '(no response)',

    // ---- chat list / folders ----
    'folder.expand': 'Expand',
    'folder.collapse': 'Collapse',
    'folder.no_folder': 'Chats',
    'folder.move_to': 'Move to folder',
    'folder.none_yet': 'No folders created yet.',
    'folder.remove_from': 'Remove from folder',
    'folder.new_ph': 'New folder name',
    'folder.new': 'New folder…',
    'chat.pin': 'Pin',
    'chat.unpin': 'Unpin',
    'chat.has_instr': 'Has per-chat instructions',
    'chat.assign_folder': 'Assign folder',
    'chat.rename': 'Rename',
    'chat.delete': 'Delete',
    'chat.default_title': 'New chat',
    'chat.attach_title': 'Attachment',
    'chat.untitled_export': 'Conversation',

    // ---- model chips / cards ----
    'chip.toggle': 'Click to toggle this model on/off',
    'notice.master_excluded': 'Excluding the master model turns the master feature off.',
    'card.copy_answer': 'Copy this answer',
    'card.regen_master': 'Regenerate master summary',
    'card.regen_model': 'Regenerate this model only',
    'card.master_head': 'Master summary · {label}',
    'card.master_head_alt': 'Master summary · {by} (fallback)',
    'master.dissent_badge': '⚠ Dissent',
    'master.dissent_title': 'The master flagged a minority opinion / dissent. Check each model\'s original answer before deciding.\n\n',
    'master.agree_badge': '✓ Match',
    'master.agree_title': 'The models\' answers largely agreed (the master found no notable minority opinion).',
    'master.no_done': 'No models finished.',
    'master.no_key': 'The master model has no API key.',
    'master.force_error': 'Re-run summary (choose model)',
    'master.force_now': 'Summarize with answers so far',
    'notice.master_no_key': '👑 The master model has no API key, so this answer proceeds without a summary. Add a key in ⚙️ Settings to auto-summarize next time.',

    // ---- cross-check ----
    'crosscheck.label': '🔍 Cross-check',
    'crosscheck.copy': 'Copy cross-check',
    'crosscheck.no_key': 'No API key for a cross-check model. Enter one in ⚙️ Settings.',
    'crosscheck.no_key_err': 'The cross-check model has no API key.',
    'crosscheck.running': 'Cross-checking…',
    'crosscheck.again': '🔍 Cross-check again',
    'crosscheck.btn_enabled': 'One model points out the common points and differences among finished answers (uses tokens)',
    'crosscheck.btn_disabled': 'Once all answers arrive, click to cross-check',

    // ---- ensemble bar ----
    'ensemble.waiting': '⏳ Waiting for answers… ({done}/{total} done)',
    'ensemble.insufficient': 'Not enough finished answers (need 2+ to compare)',
    'ensemble.agree': '✓ Answers mostly agree',
    'ensemble.diverge': '⚠ Answers diverge — cross-check recommended',
    'ensemble.partial': '~ Partially aligned',
    'ensemble.ready': 'Ready to compare answers',
    'ensemble.tip_ready': 'An approximate wording-similarity of the finished answers. For an accurate comparison, click 🔍 Cross-check.',
    'ensemble.tip_wait': 'Cross-check becomes available once all model answers arrive (or time out).',
    'ensemble.similarity': 'Similarity ~{pct}%',

    // ---- status labels ----
    'status.pending_wait': 'Waiting for server response…',
    'status.master_collecting': 'Master is gathering everything…',
    'status.sub_pending': 'Waiting for sub-agent response…',
    'status.retry_busy': 'Server busy — retrying in {delay}s… ({attempt}/2)',
    'status.aborted': 'Stopped',
    'statuslabel.pending': 'Waiting for server response',
    'statuslabel.streaming': 'Responding',
    'statuslabel.done': 'Done',
    'statuslabel.timeout': 'Timeout',
    'statuslabel.aborted': 'Response stopped',
    'statuslabel.error': 'Error',
    'statuslabel.waiting': 'Waiting',
    'timeout.secs': '{s}s timeout',

    // ---- stats ----
    'stats.tokens': '~{n} tokens',
    'stats.io_title': 'Input ~{in} · output ~{out} tokens (estimated)',
    'stats.chars': '{n} chars',
    'img.preview_alt': 'Link image preview',

    // ---- aggregator selector ----
    'selector.title': 'Choose the summary model and answers to include',
    'selector.desc': 'Pick the model to write the summary (aggregator) and the answers to include. If the master fails or is delayed, another model can summarize.',
    'selector.group_model': 'Model to write the summary',
    'selector.group_answers': 'Answers to include',
    'selector.run': 'Run summary',

    // ---- citations ----
    'citations.title': '🔎 Sources',

    // ---- compaction ----
    'compaction.card_title': '🗜 {n} earlier messages were summarized below',
    'compaction.card_sub': 'The chat content stays intact. Later questions send only this summary + recent messages (to save tokens).',
    'compaction.view': 'View summary',
    'compaction.prompt_title': '🗜 This conversation is getting long',
    'compaction.prompt_p': 'This conversation has grown, so the prior context sent with each question is now about {k}K tokens. That raises tokens (cost) accordingly.',
    'compaction.prompt_muted': 'For a completely new topic, "+ New chat" saves the most. To keep this context, you can compress the earlier part into a single summary. Your existing chat stays on screen with one summary card added, and later questions send only (summary + recent messages).',
    'compaction.just_continue': 'Just continue',
    'compaction.do_summarize': 'Summarize earlier chat',
    'notice.summ_no_key': 'No API key for a summarizing model. Enter one in ⚙️ Settings.',
    'notice.summarizing': '🗜 Summarizing the earlier conversation… (one moment)',
    'notice.summ_fail': 'Summarization failed: {err}',
    'notice.summ_empty': 'The summary result was empty, so compaction is skipped.',
    'notice.compacted': '✅ Summarized {n} earlier messages. Later questions send only the summary + recent messages.',
    'notice.not_long_enough': 'The conversation is not long enough to summarize yet.',

    // ---- question / unified ----
    'q.copy': 'Copy question',
    'q.edit_resend': 'Edit question and resend',
    'q.resend': 'Resend the same question',
    'unified.expand': 'Expand {n} individual model answers',
    'unified.hint': '💡 Turn on the master summary to merge the 4 answers into one. For now, expand the individual answers.',

    // ---- empty state ----
    'empty.h2': 'One question, answers from many minds',
    'empty.p': 'Ask once and every model thinks at the same time, then the master weaves them into one.',
    'empty.li1': '⬛ Split view — compare model answers side by side',
    'empty.li2': '▤ Unified view + master summary — one conclusion, plus the minority opinion',
    'empty.li3': '+ New chat — clear context to save tokens and start a new topic',
    'empty.li4': '⚙️ Settings — API keys · personalization · local endpoints',

    // ---- export ----
    'export.title': '# {title}',
    'export.compaction': '## 🗜 Earlier conversation summary ({n} compressed)',
    'export.question': '## 🙋 Question',
    'export.attach': '*Attachments: {names}*',
    'export.master': '### 👑 Master summary{label}',
    'export.crosscheck': '### 🔍 Cross-check{label}',

    // ---- model settings rows ----
    'model.api_key': 'API key',
    'model.api_key_optional': 'API key (optional)',
    'model.key_ph': 'sk-...',
    'model.key_ph_local': 'Enter if needed',
    'model.key_link_title': 'Go to the {label} API key page',
    'model.master': '👑 Master',
    'model.vision': 'Vision',
    'model.vision_title': 'Check if this model supports image (vision) input. If off, images are not sent.',
    'model.use': 'Use',
    'model.remove': 'Delete',
    'model.display_name': 'Display name',
    'model.model_name': 'Model name',
    'model.pick_or_type': 'Pick from the list or type your own',
    'model.type_name': 'Type the model name',
    'model.price_opt': '{label} · in ${in}/1M · out ${out}/1M',
    'model.price_label': 'Estimated price (USD / 1M tokens) ',
    'model.price_tip': 'Monthly estimate = each answer\'s estimated tokens × this price. Defaults follow public price lists; edit them to match your plan. (Token counts are also length-based estimates and may differ from your actual bill.)',
    'model.price_in': 'In',
    'model.price_out': 'Out',
    'local.max': 'Max {n} local',
    'local.add': '+ Add local endpoint',

    // ---- save hints ----
    'savehint.saved': 'Saved ✓',
    'savehint.enter_backup_pass': 'Please enter a backup password.',
    'savehint.reset_done': 'Reset complete ✓',
    'savehint.reset_chats_done': 'Chats reset ✓',
    'savehint.pw_done_sync': 'Password changed ✓ (other devices must log in again with the new password)',
    'savehint.pw_done': 'Password changed ✓',
    'savehint.backup_exported': 'Backup exported ({n} chats) ✓',
    'savehint.backup_imported': 'Backup imported ({parts}) ✓',
    'savehint.backup_nothing': 'Nothing was imported.',
    'storage.usage': 'Storage in use: {used} MB / {quota} MB ({pct}%)',
    'storage.unavailable': 'Storage info is unavailable.',

    // ---- backup ----
    'backup.enter_pass': 'Please enter a backup password.',
    'backup.pass_min': 'The backup password must be at least 8 characters.',
    'backup.pass_mismatch': 'The backup password confirmation does not match.',
    'backup.bad_file': 'This is not a valid API-Tizer backup file.',
    'backup.pass_wrong': 'The backup password is incorrect.',
    'backup.old_format': 'This is an old-format backup. It can only be imported on the same account in the browser that made it. Please export a fresh backup.',
    'backup.parts_chats': '{n} chats',
    'backup.parts_settings': 'settings · API keys',

    // ---- password change (errors) ----
    'pwerr.offline': "You can't change your password while offline. Connect to a network and try again.",
    'pwerr.sync_fail': 'Sync failed, so the password could not be changed. Check your network and try again.',
    'pwerr.session_ended': 'The session ended before the password change completed. Please log in again with the new password.',

    // ---- AI system instructions (sent to the models) ----
    'instr.rich':
      'Write every answer in highly readable, visually rich Markdown.\n' +
      '- Use ## headings and ### subheadings to structure clearly.\n' +
      '- Make active use of numbered and bulleted lists.\n' +
      '- Always present data, comparisons, lists, and step-by-step explanations as Markdown tables (| column |). Always include the separator row (|---|).\n' +
      '- Use emoji naturally where appropriate (✅ 📌 💡 ⚠️ etc.), preferably before headings or key points.\n' +
      '- Emphasize key content in **bold** and code or terms in `inline code`.\n' +
      '- Keep an overall friendly, easy-to-read, and visually well-organized style.',
    'instr.continuity':
      'You are one of several AIs in API-tizer. Multiple models answer the same question, and when needed a master builds an official synthesis.\n' +
      'Earlier turns may include the two blocks below together.\n' +
      '1) [Previous official synthesis] — the shared baseline the user reads and builds on. Prefer it as the default premise for follow-up questions.\n' +
      '2) [My individual answer for that turn] — what you originally wrote. Use it as reference for your perspective, details, dissent, and tone.\n' +
      'If the user is following the official conclusion (e.g., choosing a specific option), prioritize the official synthesis; ' +
      'if they ask about dissent or go deeper, or you have a meaningful addition, you may bring out the character of your individual answer. ' +
      "Do not merely repeat the official synthesis, nor stubbornly cling to your own minority view. You are not given other models' raw text.",
    'instr.master':
      'You are an editor synthesizing the answers of several AIs. The goal is not one smooth answer but to raise reliability and surface uncertainty through cross-validation of multiple independent models. Follow these rules.\n' +
      '1) Treat what multiple models agree on as the highest-confidence core, and write a clear, sufficiently detailed final answer. Do not omit important numbers, code, proper nouns, or option definitions.\n' +
      '2) When models factually conflict, do not arbitrarily pick one — show which model said what differently (e.g., "A says X, B says Y"). Mark content only one model claims as a "single-model claim" and lower its confidence.\n' +
      '3) Do not invent new facts that no model stated. Only write content grounded in the answers.\n' +
      'If the input includes [Previous official synthesis — reference], use it to keep terminology, options, and prior conclusions consistent, but the main material is this question and these answers. Do not freeze the previous synthesis; revise and update it as needed.\n' +
      "At the end, add a '### Minority opinion' section: if any model made a claim noticeably different from the others, write in 1–3 lines which model said what differently. " +
      "If there is no meaningful difference, write 'No notable minority opinion'.",
    'instr.crosscheck':
      'You are a cross-validator of several AI answers. Do not create a new synthesis or a final conclusion. ' +
      'Instead, compare the answers below and organize, in concise Markdown, (1) the core points multiple models agree on and (2) the points where they conflict or only one model claims (differing facts, numbers, or conclusions). ' +
      'For conflicts, state who said what differently (e.g., "A says X, B says Y") so the user knows where to double-check. Do not invent new facts.',
    'instr.compaction':
      'You are a summarizer that compresses a long conversation, keeping only what later turns need. ' +
      "Always preserve decisions made, the user's preferences/premises/constraints, important proper nouns/numbers/term definitions, and still-unresolved questions. " +
      'Remove chit-chat and redundancy, and write concisely in structured Markdown (headings, bullets) so that any model can continue the context naturally from this summary alone. Do not invent new content.',
    'instr.minority_header': 'Minority opinion',
    'instr.minority_none': 'No notable minority opinion',
  },
};
