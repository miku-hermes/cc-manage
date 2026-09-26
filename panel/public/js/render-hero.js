/* 数字滚动（批次 10）：记录上一次的值，首次同步显示，之后只在
   格式化结果真的变化时用 320ms 滚过去；不能动画时 setNumber 同步写终值。 */
let lastBalance = null;    // 上次余额数值；null = 尚未渲染过。无快照时为 NaN（money→—）
let lastTokens = null;     // 上次 token 数值；null = 尚未渲染过
const lastKpiValues = {};  // KPI 数字 id → 上次的值

/** 一个数字格：首次同步显示，之后格式化结果变了才用 320ms 滚过去。
    关键：renderKpis 每轮都从 <template> 克隆**全新**节点，所以每次都必须把值写进
    当前节点；不能因为「上次的值没变」就跳过（B24 回归：5s 轮询重建后数字变空白）。 */
function paintKpiNumber(el, key, value) {
  if (!el) return;
  const prev = key in lastKpiValues ? lastKpiValues[key] : null;
  if (prev === null) el.textContent = num(value);
  else if (num(prev) !== num(value)) setNumber(el, prev, value, num, 320);
  else el.textContent = num(value);   // 值没变：仍要同步写终值到新节点
  lastKpiValues[key] = value;
}

/* KPI 语义色：错误>0 红、可用<总数 黄、0 值弱化。 */
function kpiModifier(opts, value) {
  const v = Number(value);
  if (!Number.isFinite(v)) return '';
  if (opts.kind === 'danger' && v > 0) return ' is-danger text-error';
  if (opts.kind === 'warning' && opts.warnWhen && opts.warnWhen(v)) return ' is-warning text-warning';
  if (opts.kind === 'accent' && v > 0) return ' is-accent text-primary';
  if (v === 0) return ' is-muted text-base-content/50';
  return '';
}

/* KPI 定义：结构在 KpiCard.astro（唯一模板）；这里只有「显示哪些 / 填什么值」。
   零值卡（hideWhenZero）整张不渲染 —— 例如「暂停中 0」不再占一个槽位。
   token 不再出现在「总请求」副文案里（与 Hero 右上角累计 token 重复）。 */
function kpiDefs(s, st) {
  const defs = [
    { key: 'total', label: '总请求', icon: 'total', kind: 'accent', value: st.total, sub: '' },
    { key: 'errors', label: '上游错误数', icon: 'errors', kind: 'danger', value: st.errors, sub: '客户端错误 ' + num(st.clientErrors) },
    { key: 'paused', label: '暂停中', icon: 'paused', kind: '', value: s.paused, sub: '含冷却', hideWhenZero: true },
  ];
  return defs.filter((d) => !(d.hideWhenZero && !(Number(d.value) > 0)));
}

/** 用 <template id="tpl-kpi"> 克隆出可见的 KPI 卡（结构零拼接、数据零 innerHTML）。 */
function renderKpis(s, st) {
  const host = $('kpis');
  if (!host) return;
  const tpl = $('tpl-kpi');
  clearChildren(host);
  if (!tpl || !tpl.content || !tpl.content.firstElementChild) return;
  for (const def of kpiDefs(s, st)) {
    const node = tpl.content.firstElementChild.cloneNode(true);
    const value = Number(def.value);
    node.id = 'kpi-box-' + def.key;
    node.className = 'kpi stat bg-base-100 py-2 transition-colors' + kpiModifier(def, value);
    const icon = field(node, 'kpi-icon-' + def.icon);
    for (const svg of node.querySelectorAll('.kpi-icon svg')) svg.hidden = svg !== icon;
    const label = field(node, 'kpi-label');
    if (label) label.textContent = def.label;
    const b = field(node, 'kpi-value');
    if (b) {
      b.id = 'kpi-' + def.key;
      if (Number.isFinite(value)) paintKpiNumber(b, 'kpi-' + def.key, value);
      else b.textContent = '—';
    }
    const sub = field(node, 'kpi-sub');
    if (sub) {
      if (def.sub) { sub.id = 'kpi-sub-' + def.key; sub.textContent = def.sub; }
      else sub.remove();
    }
    host.appendChild(node);
  }
  // 内部钩子不留在产出 DOM 里（与账号卡一致）。
  for (const el of host.querySelectorAll('[data-f]')) el.removeAttribute('data-f');
}

/** 额度构成聚合：只统计「有 lastQuota 快照」的账号（无快照不参与求和）。 */
function creditsTotals(accounts) {
  const synced = accounts.filter((a) => a && a.lastQuota && a.lastQuota.credits);
  const sum = (k) => synced.reduce((s, a) => s + (Number(a.lastQuota.credits[k]) || 0), 0);
  let used = 0;
  let cap = 0;
  for (const a of synced) {
    const m = a.lastQuota.monthly;
    const c = m ? Number(m.cap) : NaN;
    if (Number.isFinite(c) && c > 0) {
      used += Number(m.used) || 0;
      cap += c;
    }
  }
  return {
    count: synced.length,
    monthly: sum('monthlyCredits'),
    purchased: sum('purchasedCredits'),
    free: sum('freeCredits'),
    used,
    cap,
    percent: cap > 0 ? (used / cap) * 100 : null,
  };
}

/* Hero 的**唯一**百分比口径：环内读数与左侧旁词「本月已用 X%」共用这一个格式化结果，
   两处逐字符相同 —— 不再出现「环里 63% / 旁边 62.6%」这种一件事两种写法。
   一位小数（不吞精度，与卡片进度条的 pctText 口径一致）；夹紧到 [0,100]（环本身画不出
   更多，旁词也不谎报超过上限）；≥99.95% 进位成「100%」—— 6 字符（100.0%）在 52px 的环里
   会压到描边，5 字符放得下。 */
function heroPctText(p) {
  const v = Number(p);
  if (p === null || p === undefined || !Number.isFinite(v)) return '—';
  const c = Math.max(0, Math.min(100, v));
  return c >= 99.95 ? '100%' : c.toFixed(1) + '%';
}

/** Hero 构成明细：月度/购买/赠送求和 + 本月已用加权百分比（只算 cap>0 的账号）。 */
function breakdownText(accounts) {
  const t = creditsTotals(accounts);
  if (!t.count) return '尚未获取额度快照';
  // 口径写清：剩余额度是上方的大数字；这一行是「本月已用百分比 + 月度池构成」。
  const used = t.cap > 0 ? '本月已用 ' + heroPctText(t.percent) : '本月用量待同步';
  // 恒为 0 的额度构成不占位（购买 0 / 赠送 0 直接不出现）。
  const parts = [];
  if (t.monthly > 0) parts.push('月度 $' + money(t.monthly));
  if (t.purchased > 0) parts.push('购买 $' + money(t.purchased));
  if (t.free > 0) parts.push('赠送 $' + money(t.free));
  return used + (parts.length ? ' · ' + parts.join(' · ') : '');
}

/* 状态筛选条：全部 / 可用 / 冷却 / 耗尽。
   口径与 accountStatus 同源（可用 = schedulable；冷却 = paused||rateLimited 且未耗尽；
   耗尽 = exhausted||creditsExhausted||authInvalid），计数全部来自真实 accounts。 */
const VIEW_FILTERS = [['all', '全部'], ['available', '可用'], ['cooldown', '冷却'], ['exhausted', '耗尽']];
function filterCounts(accounts) {
  return {
    all: accounts.length,
    available: accounts.filter((a) => accountStatus(a).schedulable).length,
    cooldown: accounts.filter((a) => (a.paused || a.rateLimited) && !isExhaustedAccount(a)).length,
    exhausted: accounts.filter(isExhaustedAccount).length,
  };
}
function renderFilters(accounts) {
  const host = $('filters');
  if (!host) return;
  const counts = filterCounts(accounts);
  clearChildren(host);
  for (const [key, label] of VIEW_FILTERS) {
    const active = state.viewFilter === key;
    const btn = document.createElement('button');
    btn.setAttribute('type', 'button');
    // B24d：筛选条是主页面主要导航控件，加大字号 / 字重，active 用主色，别再是几乎看不见的小灰字。
    btn.className = 'filter-btn btn btn-sm join-item text-sm font-semibold' + (active ? ' btn-active btn-primary is-active' : '');
    btn.setAttribute('data-filter', key);
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    btn.textContent = label + ' ' + num(counts[key]);
    host.appendChild(btn);
  }
}

function render(d) {
  state.data = d;
  const s = d.summary || {};
  const st = d.stats || {};
  const accounts = d.accounts || [];
  setStaleFrom(d);   // 阈值跟随后端轮询配置（空闲间隔的 2 倍）

  setHealth('可用 ' + num(s.available) + ' / ' + num(s.accounts), { tone: Number(s.available) > 0 ? 'ok' : 'bad' });
  $('updated').textContent = '更新于 ' + timeText(d.now);
  $('cadence').textContent = cadenceText(d.quotaPoll);
  // 公开面板不下发也不渲染内网上游地址（host/port 对匿名访客无用，只泄露拓扑）
  $('upstream').textContent = '内网上游' + (d.allowPassthrough ? ' · 已开启直连透传' : '');
  const tokensValue = st.totalTokens;
  if (lastTokens === null) $('tokens').textContent = num(tokensValue);
  else if (num(lastTokens) !== num(tokensValue)) setNumber($('tokens'), lastTokens, tokensValue, num, 320);
  lastTokens = tokensValue;

  // 余额：全页最大字号的主角（用不了的钱算 0，见 usableRemaining）。
  // 没有快照的账号 usableRemaining 返回 null：从合计里排除（不是当 0 低估池余额），并注明数量。
  const synced = accounts.filter((a) => Number.isFinite(usableRemaining(a)));
  const unsynced = accounts.length - synced.length;
  const remaining = synced.reduce((sum, a) => sum + usableRemaining(a), 0);
  const balanceValue = synced.length ? remaining : NaN;   // 无快照 → NaN，money(NaN)='—'
  if (lastBalance === null) $('balance').textContent = money(balanceValue);
  else if (money(lastBalance) !== money(balanceValue)) setNumber($('balance'), lastBalance, balanceValue, money, 320);
  lastBalance = balanceValue;
  $('bal-label').textContent = '剩余额度（USD）' + (unsynced ? ' · 含 ' + unsynced + ' 个未同步账号' : '');
  // 余额下方的构成明细（聚合口径见 breakdownText）。
  $('bal-breakdown').textContent = breakdownText(accounts);
  // daisyUI radial-progress：本月额度已用的单一图形表达（读数与 breakdown 文字共用
  // heroPctText 的同一个字符串，不再一个取整、一个一位小数）。
  const totals = creditsTotals(accounts);
  const gauge = $('usage-gauge');
  if (gauge) {
    if (totals.cap > 0 && Number.isFinite(totals.percent)) {
      const pct = Math.max(0, Math.min(100, Math.round(totals.percent)));
      const pctLabel = heroPctText(totals.percent);   // 与 breakdownText 同一口径（逐字符相同）
      gauge.setAttribute('style', '--value:' + pct);
      gauge.textContent = pctLabel;
      gauge.setAttribute('aria-label', '本月额度已用 ' + pctLabel);
    } else {
      gauge.setAttribute('style', '--value:0');
      gauge.textContent = '—';
      gauge.setAttribute('aria-label', '本月额度用量待同步');
    }
  }

  // KPI 卡：账号口径（账号数/可用/不可用）已合并进 Hero 的「网关状态 可用 N / M」，
  // 这里只保留不重复的指标；零值卡（暂停中）不渲染。结构在 KpiCard.astro。
  renderKpis(s, st);

  renderFilters(accounts);
  renderCards();
  if (typeof playIntro === 'function') playIntro();   // 首屏入场 stagger：只跑一次（introPending 守卫）
}
function clearKpis() {
  const host = $('kpis');
  if (host) clearChildren(host);
  for (const id of Object.keys(lastKpiValues)) lastKpiValues[id] = null;
}
function showPrivate() {
  state.data = null;
  lastBalance = null;
  lastTokens = null;
  setNumber($('balance'), 0, NaN, money, 0);   // 同步写 — 并取消在途动画
  $('bal-label').textContent = '剩余额度（USD）';
  $('bal-breakdown').textContent = '';
  setHealth('需要登录后台', { tone: 'bad' });
  setNumber($('tokens'), 0, NaN, num, 0);      // 同步写 0 并取消在途动画
  $('upstream').textContent = '';
  $('updated').textContent = '';
  $('cadence').textContent = '';
  const gauge = $('usage-gauge');
  if (gauge) { gauge.setAttribute('style', '--value:0'); gauge.textContent = '—'; gauge.setAttribute('aria-label', '本月额度用量待同步'); }
  clearKpis();
  const filters = $('filters');
  if (filters) filters.innerHTML = '';
  $('cards').innerHTML = emptyCard('当前实例已开启隐私模式（<span class="mono">PUBLIC_DASHBOARD=0</span>）：'
    + '请先<a href="/admin">登录后台</a>再查看面板数据。');
}
