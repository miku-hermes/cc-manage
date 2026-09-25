// ── 交互：主题按钮 / 搜索框走容器级事件委托 ──────────────────────────
// 不再 $('theme').onclick / $('search').addEventListener 直绑：监听挂在 document 上，
// 用 e.target.closest('#theme') / 目标 id 判断，行为与直绑完全一致。
document.addEventListener('click', (e) => {
  const t = e.target;
  if (!t || !t.closest) return;
  if (t.closest('#theme')) { setTheme(currentTheme() === 'dark' ? 'light' : 'dark'); return; }
  if (t.closest('#refresh-quota')) { refreshQuota(); return; }
  // 搜索框：点图标或输入框都只负责展开，绝不在这里收起。
  // <label class="search-box"> 包着 <input>，浏览器会把图标点击再投递给 input；
  // 若图标分支还 toggle 收起，就会出现「展开→缩回→再展开」的闪烁。
  // 收起只保留 Escape 与「失焦且为空」两条路径（见下方 keydown / focusout）。
  const sb = t.closest('.search-box');
  if (sb) {
    const input = sb.querySelector('input');
    const isInput = !!(t.tagName && t.tagName.toUpperCase() === 'INPUT');
    if (isInput) {
      sb.classList.add('expanded');
    } else {
      sb.classList.add('expanded');
      if (input) input.focus();
    }
  }
  // 状态筛选条：document 级委托（禁内联 onclick），active 态与过滤叠加逻辑见 renderFilters/inViewFilter。
  const fb = t.closest('#filters .filter-btn');
  if (fb) {
    const next = fb.getAttribute('data-filter');
    if (next && state.viewFilter !== next) state.viewFilter = next;
    if (state.data) { renderFilters(state.data.accounts); renderCards(); reflowCards(); }
  }
});
document.addEventListener('input', (e) => {
  const t = e.target;
  if (!t || t.id !== 'search') return;
  state.filter = t.value || '';
  renderCards();
});

// 搜索框键盘：Escape 收起并放掉焦点（label 已不再是 role=button，无需再处理 Enter/空格）。
document.addEventListener('keydown', (e) => {
  const t = e.target;
  if (!t || !t.closest) return;
  const sb = t.closest('.search-box');
  if (!sb) return;
  if (e.key !== 'Escape') return;
  sb.classList.remove('expanded');
  const input = sb.querySelector('input');
  if (t.blur) t.blur();               // 焦点在图标上时也要放掉，才能撤掉 :focus-within
  if (input) input.blur();
});

// 搜索框获得焦点：只要焦点落进 .search-box 就补上 expanded（兜底点击投递差异）。
document.addEventListener('focusin', (e) => {
  const t = e.target;
  if (!t || !t.closest) return;
  const sb = t.closest('.search-box');
  if (sb) sb.classList.add('expanded');
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

// ── 首屏入场（批次 10）：只由一次性的 body.is-intro 驱动 ──────────────
// 5s 轮询会整块重建 #cards，若把 animation 写在常驻 .card 上就会每 5 秒重播；
// 这里首次成功渲染后加类、约 1150ms 后移除，之后的轮询重建不再匹配任何动画选择器。
let introPending = true;
function playIntro() {
  if (!introPending) return;
  introPending = false;
  const b = document.body;
  if (!b || !b.classList) return;
  b.classList.add('is-intro');
  setTimeout(() => b.classList.remove('is-intro'), 1150);
}

// ── 筛选 pill 点击 → 卡片重排淡入（只挂 260ms 短类；搜索框输入绝不触发）──
let reflowTimer = null;
function reflowCards() {
  const host = $('cards');
  if (!host || !host.classList) return;
  host.classList.remove('is-reflow');
  void host.offsetWidth;                 // 强制重排：连续点击也能重播动画
  host.classList.add('is-reflow');
  if (reflowTimer) clearTimeout(reflowTimer);
  reflowTimer = setTimeout(() => { host.classList.remove('is-reflow'); reflowTimer = null; }, 260);
}

// ── 手动刷新额度：POST /api/accounts/refresh（后端已就绪 + 匿名节流）──
let refreshingQuota = false;
async function refreshQuota() {
  if (refreshingQuota) return;                       // 除禁用态外的兜底：防连点
  const btn = $('refresh-quota');
  refreshingQuota = true;
  if (btn) btn.disabled = true;
  try {
    const r = await apiFetch('/api/accounts/refresh', { method: 'POST' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();
    if (data.throttled) setHint('刚刷新过，请稍候', false);
    else setHint('', false);
    render(data);                                    // 直接用响应里的新快照重绘
  } catch (e) {
    setHint('刷新失败：' + e.message, true);
  } finally {
    refreshingQuota = false;
    if (btn) btn.disabled = false;
  }
}

/** 启动：恢复主题 + 首屏渲染 + 定时器（原来的顶层启动语句）。 */
function boot() {
  const savedTheme = storedTheme();
  if (savedTheme) document.documentElement.setAttribute('data-theme', savedTheme);
  watchSystemTheme();                        // 未手动选择时跟随系统主题变化
  petals();
  tick();
  setInterval(tick, 1000);

  load();
  setInterval(() => { if (!document.hidden) load(); }, 5000);

  // 历史趋势：首屏拉一次 + 每 60s 刷新（与 5s 轮询同样的 hidden 守卫）。
  // 独立于主面板：loadTrend 内部失败静默降级，不影响 /api/status 的渲染。
  loadTrend();
  setInterval(() => { if (!document.hidden) loadTrend(); }, 60000);
}
