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
