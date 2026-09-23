const THEME_STORE = 'cc-manage-theme';
$('search').addEventListener('input', (e) => { state.filter = e.target.value || ''; renderCards(); });
// ── 主题：默认跟随系统，按钮手动切换 ────────────────────────────────
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
$('theme').onclick = () => setTheme(currentTheme() === 'dark' ? 'light' : 'dark');
// ── 问候语 + 实时时钟（时钟已降级为小字）────────────────────────────
function greetingOf(h) { return h < 5 ? '凌晨好' : h < 12 ? '早上好' : h < 18 ? '下午好' : '晚上好'; }
function tick() {
  const now = new Date();
  $('clock').textContent = now.toLocaleTimeString('zh-CN', { hour12: false });
  $('date').textContent = now.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' });
  $('greeting').textContent = greetingOf(now.getHours());
  tickFreshness();
}

/** 每秒本地重算所有卡片的相对时间（纯 DOM 更新，零请求）。 */
function tickFreshness() {
  const at = Date.now();
  for (const el of document.querySelectorAll('.card-fresh[data-fetched-at]')) {
    const t = Number(el.dataset.fetchedAt);
    const age = at - t;
    if (age >= staleMs) {
      el.textContent = '额度更新于 ' + timeText(t);
      el.classList.add('is-stale');
      el.title = staleText();
    } else {
      el.textContent = '额度更新于 ' + relText(t, at);
      el.classList.remove('is-stale');
      el.removeAttribute('title');
    }
  }
}
// ── 樱花花瓣：约束在视口内，容器 overflow:hidden，尺寸小、透明度低 ──
function petals() {
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const host = $('petals');
  const vw = Math.max(320, window.innerWidth);
  const tints = ['var(--accent)', '#f7b6c9', 'var(--accent-hover)'];
  const count = 10;
  for (let i = 0; i < count; i++) {
    const p = document.createElement('span');
    const size = 4 + Math.random() * 3;                       // 4–7px
    // 约束花瓣在 [0, 100vw] 内：留出 ±5vw 飘移余量，永不贴边被裁
    const lane = ((i + 0.5) / count) * 100;
    const jitter = (Math.random() - 0.5) * (50 / count);
    const left = Math.min(92, Math.max(8, lane + jitter));
    p.className = 'petal';
    p.style.left = left + '%';
    p.style.width = size.toFixed(1) + 'px';
    p.style.height = size.toFixed(1) + 'px';
    p.style.background = tints[i % tints.length];
    p.style.opacity = (0.15 + Math.random() * 0.1).toFixed(2);  // 0.15–0.25
    p.style.animationDuration = (14 + Math.random() * 10).toFixed(1) + 's';
    p.style.animationDelay = (-Math.random() * 24).toFixed(1) + 's';
    host.appendChild(p);
  }
}

/** 启动：恢复主题 + 首屏渲染 + 定时器（原来的顶层启动语句）。 */
function boot() {
  const savedTheme = storedTheme();
  if (savedTheme) document.documentElement.setAttribute('data-theme', savedTheme);
  petals();
  tick();
  setInterval(tick, 1000);

  load();
  setInterval(() => { if (!document.hidden) load(); }, 5000);
}
