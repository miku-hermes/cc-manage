/* KPI 语义色：错误>0 红、可用<总数 黄、0 值弱化 */
function paintKpi(boxId, numId, value, opts) {
  const box = $(boxId);
  const b = $(numId);
  const v = Number(value);
  const known = Number.isFinite(v);
  box.className = 'kpi';
  if (known) {
    if (opts.kind === 'danger' && v > 0) box.classList.add('is-danger');
    else if (opts.kind === 'warning' && opts.warnWhen && opts.warnWhen(v)) box.classList.add('is-warning');
    else if (opts.kind === 'accent' && v > 0) box.classList.add('is-accent');
    else if (v === 0) box.classList.add('is-muted');
  }
  b.textContent = known ? num(v) : '—';
}

/** KPI 卡下方那行 12px 说明小字（真实数据，不塞假值）。 */
function setKpiSub(id, text) {
  const el = $(id);
  if (el) el.textContent = text;
}

/** summary.enabled 缺失时兜底数「未显式停用」的账号，避免显示成 0。 */
function enabledCount(s, accounts) {
  const v = Number(s.enabled);
  if (Number.isFinite(v)) return v;
  return accounts.filter((a) => a.enabled !== false).length;
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

/** Hero 构成明细：月度/购买/赠送求和 + 本月已用加权百分比（只算 cap>0 的账号）。 */
function breakdownText(accounts) {
  const t = creditsTotals(accounts);
  if (!t.count) return '尚未获取额度快照';
  const base = '月度 $' + money(t.monthly) + ' · 购买 $' + money(t.purchased) + ' · 赠送 $' + money(t.free);
  return base + ' · ' + (t.cap > 0 ? '本月已用 ' + pctText(t.percent) : '本月用量待同步');
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
  host.innerHTML = VIEW_FILTERS.map(([key, label]) => {
    const active = state.viewFilter === key;
    return '<button type="button" class="filter-btn' + (active ? ' is-active' : '') + '"'
      + ' data-filter="' + key + '" aria-pressed="' + (active ? 'true' : 'false') + '">'
      + label + ' ' + num(counts[key]) + '</button>';
  }).join('');
}

function render(d) {
  state.data = d;
  const s = d.summary || {};
  const st = d.stats || {};
  const accounts = d.accounts || [];
  setStaleFrom(d);   // 阈值跟随后端轮询配置（空闲间隔的 2 倍）

  $('health').textContent = '可用 ' + num(s.available) + ' / ' + num(s.accounts);
  $('health').className = 'pill ' + (Number(s.available) > 0 ? 'ok' : 'bad');
  $('updated').textContent = '更新于 ' + timeText(d.now);
  $('cadence').textContent = cadenceText(d.quotaPoll);
  // 公开面板不下发也不渲染内网上游地址（host/port 对匿名访客无用，只泄露拓扑）
  $('upstream').textContent = '内网上游' + (d.allowPassthrough ? ' · 已开启直连透传' : '');
  $('tokens').textContent = num(st.totalTokens);

  // 余额：全页最大字号的主角（用不了的钱算 0，见 usableRemaining）。
  // 没有快照的账号 usableRemaining 返回 null：从合计里排除（不是当 0 低估池余额），并注明数量。
  const synced = accounts.filter((a) => Number.isFinite(usableRemaining(a)));
  const unsynced = accounts.length - synced.length;
  const remaining = synced.reduce((sum, a) => sum + usableRemaining(a), 0);
  $('balance').textContent = synced.length ? money(remaining) : '—';
  $('bal-label').textContent = '剩余额度（USD）' + (unsynced ? ' · 含 ' + unsynced + ' 个未同步账号' : '');
  // 余额下方的构成明细（聚合口径见 breakdownText）。
  $('bal-breakdown').textContent = breakdownText(accounts);

  paintKpi('kpi-box-accounts', 'kpi-accounts', s.accounts, {});
  paintKpi('kpi-box-available', 'kpi-available', s.available, { kind: 'warning', warnWhen: (v) => Number(s.accounts) > v });
  paintKpi('kpi-box-paused', 'kpi-paused', s.paused, {});
  // 不可用 = accounts - available：暂停/冷却只是部分口径，这个数才补齐「账号 3 / 可用 2」的缺口。
  const unavailable = Number.isFinite(Number(s.unavailable)) ? s.unavailable : Number(s.accounts) - Number(s.available);
  paintKpi('kpi-box-unavailable', 'kpi-unavailable', unavailable, {});
  paintKpi('kpi-box-total', 'kpi-total', st.total, {});
  paintKpi('kpi-box-errors', 'kpi-errors', st.errors, { kind: 'danger' });

  setKpiSub('kpi-sub-accounts', '启用 ' + num(enabledCount(s, accounts)));
  setKpiSub('kpi-sub-available', '不可用 ' + num(unavailable));
  setKpiSub('kpi-sub-paused', '含冷却');
  setKpiSub('kpi-sub-unavailable', '暂停+耗尽');
  setKpiSub('kpi-sub-total', 'token ' + num(st.totalTokens));
  setKpiSub('kpi-sub-errors', '客户端错误 ' + num(st.clientErrors));

  renderFilters(accounts);
  renderCards();
}
function clearKpis() {
  for (const id of ['kpi-accounts', 'kpi-available', 'kpi-paused', 'kpi-unavailable', 'kpi-total', 'kpi-errors']) {
    $(id).textContent = '—';
  }
  for (const id of ['kpi-box-accounts', 'kpi-box-available', 'kpi-box-paused', 'kpi-box-unavailable', 'kpi-box-total', 'kpi-box-errors']) {
    $(id).className = 'kpi';
  }
  for (const id of ['kpi-sub-accounts', 'kpi-sub-available', 'kpi-sub-paused', 'kpi-sub-unavailable', 'kpi-sub-total', 'kpi-sub-errors']) {
    const el = $(id);
    if (el) el.textContent = '';
  }
}
function showPrivate() {
  state.data = null;
  $('balance').textContent = '—';
  $('bal-label').textContent = '剩余额度（USD）';
  $('bal-breakdown').textContent = '';
  $('health').textContent = '需要登录后台';
  $('health').className = 'pill bad';
  $('tokens').textContent = '0';
  $('upstream').textContent = '';
  $('updated').textContent = '';
  $('cadence').textContent = '';
  clearKpis();
  const filters = $('filters');
  if (filters) filters.innerHTML = '';
  $('cards').innerHTML = '<div class="card empty">当前实例已开启隐私模式（<span class="mono">PUBLIC_DASHBOARD=0</span>）：'
    + '请先<a href="/admin">登录后台</a>再查看面板数据。</div>';
}
