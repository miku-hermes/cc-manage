// ── 交互：主题按钮 / 搜索框走容器级事件委托 ──────────────────────────
// 不再 $('theme').onclick / $('search').addEventListener 直绑：监听挂在 document 上，
// 用 e.target.closest('#theme') / 目标 id 判断，行为与直绑完全一致。
document.addEventListener('click', (e) => {
  const t = e.target;
  if (!t || !t.closest) return;
  if (t.closest('#theme')) { setTheme(currentTheme() === 'dark' ? 'light' : 'dark'); return; }
  // 搜索框展开/收起：点击图标（非输入框本身）切换 expanded，展开时聚焦输入框。
  const sb = t.closest('.search-box');
  if (sb && !(t.tagName && t.tagName.toUpperCase() === 'INPUT')) {
    const input = sb.querySelector('input');
    const expand = !sb.classList.contains('expanded');
    sb.classList.toggle('expanded');
    if (input) { if (expand) input.focus(); else input.blur(); }
  }
  // 状态筛选条：document 级委托（禁内联 onclick），active 态与过滤叠加逻辑见 renderFilters/inViewFilter。
  const fb = t.closest('#filters .filter-btn');
  if (fb) {
    const next = fb.getAttribute('data-filter');
    if (next && state.viewFilter !== next) state.viewFilter = next;
    if (state.data) { renderFilters(state.data.accounts); renderCards(); }
  }
});
document.addEventListener('input', (e) => {
  const t = e.target;
  if (!t || t.id !== 'search') return;
  state.filter = t.value || '';
  renderCards();
});

// 搜索框键盘：Enter / 空格展开并聚焦，Escape 收起。
document.addEventListener('keydown', (e) => {
  const t = e.target;
  if (!t || !t.closest) return;
  const sb = t.closest('.search-box');
  if (!sb) return;
  if (e.key === 'Escape') {
    sb.classList.remove('expanded');
    const input = sb.querySelector('input');
    if (t.blur) t.blur();               // 焦点在图标上时也要放掉，才能撤掉 :focus-within
    if (input) input.blur();
    return;
  }
  const isInput = t.tagName && t.tagName.toUpperCase() === 'INPUT';
  if (!isInput && (e.key === 'Enter' || e.key === ' ')) {
    if (e.preventDefault) e.preventDefault();
    sb.classList.add('expanded');
    const input = sb.querySelector('input');
    if (input) input.focus();
  }
});

// 搜索框失焦：输入为空时收起，避免留下一个空的展开态。
document.addEventListener('focusout', (e) => {
  const t = e.target;
  if (!t || !t.closest || t.id !== 'search') return;
  const sb = t.closest('.search-box');
  if (sb && !t.value) sb.classList.remove('expanded');
});

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
