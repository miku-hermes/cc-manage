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

  paintKpi('kpi-box-accounts', 'kpi-accounts', s.accounts, {});
  paintKpi('kpi-box-available', 'kpi-available', s.available, { kind: 'warning', warnWhen: (v) => Number(s.accounts) > v });
  paintKpi('kpi-box-paused', 'kpi-paused', s.paused, {});
  // 不可用 = accounts - available：暂停/冷却只是部分口径，这个数才补齐「账号 3 / 可用 2」的缺口。
  paintKpi('kpi-box-unavailable', 'kpi-unavailable', Number.isFinite(Number(s.unavailable)) ? s.unavailable : Number(s.accounts) - Number(s.available), {});
  paintKpi('kpi-box-total', 'kpi-total', st.total, {});
  paintKpi('kpi-box-errors', 'kpi-errors', st.errors, { kind: 'danger' });

  renderCards();
}
function clearKpis() {
  for (const id of ['kpi-accounts', 'kpi-available', 'kpi-paused', 'kpi-unavailable', 'kpi-total', 'kpi-errors']) {
    $(id).textContent = '—';
  }
  for (const id of ['kpi-box-accounts', 'kpi-box-available', 'kpi-box-paused', 'kpi-box-unavailable', 'kpi-box-total', 'kpi-box-errors']) {
    $(id).className = 'kpi';
  }
}
function showPrivate() {
  state.data = null;
  $('balance').textContent = '—';
  $('health').textContent = '需要登录后台';
  $('health').className = 'pill bad';
  $('tokens').textContent = '0';
  $('upstream').textContent = '';
  $('updated').textContent = '';
  $('cadence').textContent = '';
  clearKpis();
  $('cards').innerHTML = '<div class="card empty">当前实例已开启隐私模式（<span class="mono">PUBLIC_DASHBOARD=0</span>）：'
    + '请先<a href="/admin">登录后台</a>再查看面板数据。</div>';
}
