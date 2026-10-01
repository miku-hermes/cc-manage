/* 概览仪表盘（默认首页，只读）：数据全部来自**既有**接口，不新增后端端点。
   - KPI / 错误率：GET /api/admin/usage?range=24h&bucket=1h
   - 账号池概览 / 可用账号：GET /api/status（匿名视图：没有 displayName / lastError，不渲染它们）
   - 最近请求：GET /api/admin/logs?limit=10
   刷新跟随 app-admin.js 的既有 10s 定时器（本文件不含任何定时器）。
   所有进 DOM 的文本都走 textContent / 模板填值，绝不拼 HTML 字符串。 */

const OVERVIEW_USAGE_URL = '/api/admin/usage?range=24h&bucket=1h';
const OVERVIEW_STATUS_URL = '/api/status';
const OVERVIEW_LOGS_URL = '/api/admin/logs?limit=10';
const OVERVIEW_EMPTY_LOGS = '暂无请求日志';
const OVERVIEW_OK_TEXT = '一切正常';
const OVERVIEW_DOT_OK = 'bg-success';
const OVERVIEW_DOT_WARN = 'bg-warning';
const OVERVIEW_DOT_BAD = 'bg-error';
const OVERVIEW_DOT_UNKNOWN = 'bg-base-content/30';

const overviewData = { usage: null, status: null, logs: null };

function overviewSetText(id, text) {
  const el = $(id);
  if (el) el.textContent = text;
}

/** 错误率（百分比数值）；没有请求时返回 null（渲染成 —，绝不除零出 NaN）。 */
function overviewErrorRate(totals) {
  const requests = Number(totals && totals.requests) || 0;
  const errors = Number(totals && totals.errors) || 0;
  if (requests <= 0) return null;
  const rate = (errors / requests) * 100;
  return Number.isFinite(rate) ? rate : null;
}

/** 一个额度百分比条：value 取 1 位小数（垫片/真实 DOM 都能从属性读到），文案用 pctText。 */
function fillOverviewBar(root, slot, pctSlot, pct, who, windowLabel) {
  const bar = field(root, slot);
  const text = field(root, pctSlot);
  const known = typeof pct === 'number' && Number.isFinite(pct);
  const rounded = Math.round(Math.max(0, Math.min(100, known ? pct : 0)) * 10) / 10;
  if (bar) {
    bar.setAttribute('value', String(rounded));
    bar.setAttribute('aria-label', who + ' · ' + windowLabel + '额度使用');
    bar.setAttribute('aria-valuetext', pctText(pct));
  }
  if (text) text.textContent = pctText(pct);
}

/** 一行账号：克隆模板 + 填值；整行是一个链到 #/accounts 的 <a>（只读跳转）。 */
function overviewAccountRow(a) {
  const node = cloneTemplate('tpl-overview-account');
  if (!node) return '';
  const name = a.name || shortId(a.keyId) || '未命名账号';
  fillText(node, 'name', name);
  const st = accountStatus(a);
  const dot = field(node, 'dot');
  if (dot) {
    const tone = st.tone === 'ok' ? OVERVIEW_DOT_OK : st.tone === 'warn' ? OVERVIEW_DOT_WARN : OVERVIEW_DOT_BAD;
    dot.className = 'status-dot inline-block size-2 shrink-0 rounded-full ' + tone;
    dot.setAttribute('aria-label', name + ' · ' + st.t);
  }
  const q = a.lastQuota || null;
  const pct = q && q.percent ? q.percent : {};
  fillOverviewBar(node, 'bar-5h', 'pct-5h', pct.fiveHour, name, '5 小时窗口');
  fillOverviewBar(node, 'bar-week', 'pct-week', pct.weekly, name, '本周窗口');
  fillText(node, 'remaining', q ? '$' + money(q.remaining) : '—');
  node.setAttribute('title', name + ' · ' + st.t);
  return outerRow(node);
}

function renderOverviewAccounts(accounts) {
  const box = $('overview-accounts');
  if (!box) return;
  box.innerHTML = accounts.length
    ? accounts.map(overviewAccountRow).join('')
    : emptyLine('暂无账号');
}

/** 一行最近请求：时间 HH:mm:ss / 客户端 / 模型 / 状态（色点 + 码）/ 耗时。 */
function overviewLogRow(item) {
  const node = cloneTemplate('tpl-overview-log');
  if (!node) return '';
  const st = logStatusOf(item);
  fillText(node, 'time', shortTime(item.t));
  fillText(node, 'client', item.keyName || shortId(item.keyId) || '—');
  fillText(node, 'model', item.model || '—');
  const dot = field(node, 'dot');
  if (dot) {
    const tone = st.bad ? OVERVIEW_DOT_BAD : (st.label === '—' ? OVERVIEW_DOT_UNKNOWN : OVERVIEW_DOT_OK);
    dot.className = 'status-dot inline-block size-2 shrink-0 rounded-full ' + tone;
  }
  fillText(node, 'status', st.label);
  fillText(node, 'dur', durText(item.dur));
  return outerRow(node);
}

function renderOverviewLogs(items) {
  const tbody = $('overview-logs');
  if (!tbody) return;
  tbody.innerHTML = items.length
    ? items.map(overviewLogRow).join('')
    : emptyRow(5, OVERVIEW_EMPTY_LOGS);
}

/** 异常提示条：任一条命中就在顶部挂醒目提示，否则中性地说「一切正常」。 */
function renderOverviewAlert() {
  const el = $('overview-alert');
  if (!el) return;
  const summary = (overviewData.status && overviewData.status.summary) || {};
  const stats = (overviewData.logs && overviewData.logs.stats) || {};
  const totals = (overviewData.usage && overviewData.usage.totals) || {};
  const reasons = [];

  const unavailable = Number(summary.unavailable) || 0;
  if (unavailable > 0) reasons.push('有 ' + unavailable + ' 个账号不可用');

  const dropped = Number(stats.dropped) || 0;
  if (stats.degraded === true) reasons.push('请求日志写入已降级');
  if (dropped > 0) reasons.push('有 ' + dropped + ' 条请求日志被丢弃');

  const requests = Number(totals.requests) || 0;
  const rate = overviewErrorRate(totals);
  if (rate !== null && requests >= 20 && rate > 5) {
    reasons.push('近 24 小时错误率 ' + rate.toFixed(1) + '%（' + numText(requests) + ' 次请求）');
  }

  if (reasons.length) {
    el.textContent = '需关注：' + reasons.join('；') + '。';
    el.className = 'banner alert alert-warning';
  } else {
    el.textContent = OVERVIEW_OK_TEXT;
    el.className = 'banner alert';
  }
}

function renderOverview() {
  const totals = (overviewData.usage && overviewData.usage.totals) || {};
  const requests = Number(totals.requests) || 0;
  const errors = Number(totals.errors) || 0;
  const tokensIn = Number(totals.tokensIn) || 0;
  const tokensOut = Number(totals.tokensOut) || 0;
  const rate = overviewErrorRate(totals);

  overviewSetText('overview-requests', numText(requests));
  overviewSetText('overview-requests-sub', '失败 ' + numText(errors) + ' 次');
  overviewSetText('overview-error-rate', rate === null ? '—' : rate.toFixed(1) + '%');
  overviewSetText('overview-error-rate-sub', requests > 0 ? numText(errors) + ' / ' + numText(requests) : '窗口内没有请求');
  overviewSetText('overview-tokens', numText(tokensIn + tokensOut));
  overviewSetText('overview-tokens-sub', '入 ' + numText(tokensIn) + ' · 出 ' + numText(tokensOut));

  const summary = (overviewData.status && overviewData.status.summary) || {};
  const available = Number(summary.available) || 0;
  const accountsTotal = Number(summary.accounts) || 0;
  overviewSetText('overview-accounts-available', available + ' / ' + accountsTotal);
  overviewSetText('overview-accounts-sub', '不可用 ' + numText(Number(summary.unavailable) || 0) + ' 个');

  renderOverviewAccounts((overviewData.status && overviewData.status.accounts) || []);
  renderOverviewLogs((overviewData.logs && overviewData.logs.items) || []);
  renderOverviewAlert();
}

let overviewGeneration = 0;

/** 拉三个既有接口并渲染。单个接口失败不影响其余（401 已由 apiJSON 走登录页）。 */
async function loadOverview() {
  const generation = ++overviewGeneration;
  const [usage, status, logs] = await Promise.all([
    apiJSON(OVERVIEW_USAGE_URL).catch(() => null),
    apiJSON(OVERVIEW_STATUS_URL).catch(() => null),
    apiJSON(OVERVIEW_LOGS_URL).catch(() => null),
  ]);
  if (generation !== overviewGeneration) return;    // 过期响应直接丢弃
  overviewData.usage = usage;
  overviewData.status = status;
  overviewData.logs = logs;
  renderOverview();
}

/** 登出 / 会话失效时清空概览里的业务数据（账号名 / 客户端名 / 模型都在里面）。 */
function clearOverview() {
  overviewData.usage = null;
  overviewData.status = null;
  overviewData.logs = null;
  const alertEl = $('overview-alert');
  if (alertEl) { alertEl.textContent = ''; alertEl.className = 'banner alert hidden'; }
  for (const id of ['overview-requests', 'overview-error-rate', 'overview-tokens', 'overview-accounts-available']) {
    overviewSetText(id, '—');
  }
  for (const id of ['overview-requests-sub', 'overview-error-rate-sub', 'overview-tokens-sub', 'overview-accounts-sub']) {
    overviewSetText(id, '');
  }
  const accounts = $('overview-accounts');
  if (accounts) accounts.innerHTML = '';
  const logs = $('overview-logs');
  if (logs) logs.innerHTML = '';
}
