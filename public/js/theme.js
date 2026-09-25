// ── 主题：默认跟随系统，按钮手动切换（前台 / 后台共用一份）────────────
const THEME_STORE = 'cc-manage-theme';
function storedTheme() {
  try { return localStorage.getItem(THEME_STORE) || ''; } catch { return ''; }
}
function prefersDark() { return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches); }
/** 当前生效主题：手动选择优先，否则跟随系统。 */
function currentTheme() { return document.documentElement.getAttribute('data-theme') || (prefersDark() ? 'dark' : 'light'); }
/** 手动切换：写 data-theme 并记住选择。 */
function setTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  try { localStorage.setItem(THEME_STORE, t); } catch { /* 忽略 */ }
}

/** 无手动选择时跟随系统：系统主题变化就同步 data-theme（图标与配色一起换）。 */
function applySystemTheme() {
  if (storedTheme()) return;                 // 手动选择优先，系统变化不改写
  if (prefersDark()) document.documentElement.setAttribute('data-theme', 'dark');
  else document.documentElement.removeAttribute('data-theme');
}
/** 监听系统主题变化：只在用户从未手动选择过主题时生效。 */
function watchSystemTheme() {
  if (!window.matchMedia) return;
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  if (!mq) return;
  const onChange = () => applySystemTheme();
  if (typeof mq.addEventListener === 'function') mq.addEventListener('change', onChange);
  else if (typeof mq.addListener === 'function') mq.addListener(onChange);
}
