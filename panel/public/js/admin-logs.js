/* 请求日志页：真实数据来自 GET /api/admin/logs。渲染走 <template id="tpl-log-row"> 克隆填值
   （与 logs.js 的运行日志同一套做法），所有进 DOM 的文本都经 textContent / esc()。 */
const LOGS_PAGE_SIZE = 50;

const STATUS_OK_TEXT = '成功';
const STATUS_FAIL_TEXT = '失败';
const STATUS_UNKNOWN_TEXT = '—';
const DOT_OK = 'bg-success';
const DOT_BAD = 'bg-error';
const DOT_UNKNOWN = 'bg-base-content/30';
const LOGS_CLOSED_TEXT = '请求日志已关闭（REQUEST_LOG_ENABLED=0）';
const LOGS_EMPTY_TEXT = '暂无请求日志';

/** 毫秒时间戳 → 「YYYY-MM-DD HH:mm:ss」（本地时区）。 */
function logTime(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '—';
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
    + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

/** 耗时毫秒 → 「1.24s」/「820ms」。 */
function durText(ms) {
  const v = Number(ms);
  if (!Number.isFinite(v) || v < 0) return '—';
  return v >= 1000 ? (v / 1000).toFixed(2) + 's' : Math.round(v) + 'ms';
}

/** 千分位整数（token 计数）。 */
function numText(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '0';
  return Math.round(v).toLocaleString('en-US');
}

/** 状态列：色点 + 状态码/文案；≥400 或带 error 一律算失败。 */
function logStatusOf(item) {
  const code = Number(item && item.status);
  const bad = (Number.isFinite(code) && code >= 400) || !!(item && item.error);
  const label = Number.isFinite(code) && code > 0 ? String(code) : (bad ? STATUS_FAIL_TEXT : STATUS_UNKNOWN_TEXT);
  return { bad, label, text: bad ? STATUS_FAIL_TEXT : STATUS_OK_TEXT };
}

/** 读取筛选条当前条件（每次请求实时读，避免与 DOM 脱节）。 */
function logsFilters() {
  const val = (id) => { const el = $(id); return el && el.value ? String(el.value).trim() : ''; };
  return { keyId: val('logs-key'), status: val('logs-status'), model: val('logs-model'), q: val('logs-q') };
}

function logsQuery(filters, offset) {
  const parts = ['limit=' + LOGS_PAGE_SIZE, 'offset=' + offset];
  if (filters.keyId) parts.push('keyId=' + encodeURIComponent(filters.keyId));
  if (filters.status) parts.push('status=' + encodeURIComponent(filters.status));
  if (filters.model) parts.push('model=' + encodeURIComponent(filters.model));
  if (filters.q) parts.push('q=' + encodeURIComponent(filters.q));
  return '/api/admin/logs?' + parts.join('&');
}

function logRow(item) {
  const node = cloneTemplate('tpl-log-row');
  if (!node) return '';
  const st = logStatusOf(item);
  fillText(node, 'time', logTime(item.t));
  fillText(node, 'client', item.keyName || shortId(item.keyId) || '—');
  fillText(node, 'account', item.accountName || shortId(item.accountKeyId) || '—');
  fillText(node, 'model', item.model || '—');
  const dot = field(node, 'dot');
  if (dot) dot.className = 'status-dot inline-block size-2 shrink-0 rounded-full ' + (st.bad ? DOT_BAD : (st.label === STATUS_UNKNOWN_TEXT ? DOT_UNKNOWN : DOT_OK));
  fillText(node, 'status', st.label);
  fillText(node, 'dur', durText(item.dur));
  fillText(node, 'tok-in', numText(item.tokensIn));
  fillText(node, 'tok-out', numText(item.tokensOut));
  return outerRow(node);
}

/** 写入解析出来的 JSON。data 用逐字段取值比较，避免点路径候选互相干扰。 */
function applyLogsData(data) {
  const enabled = !data || data.enabled !== false;
  state.logs = Array.isArray(data && data.items) ? data.items : [];
  state.logsHasMore = !!(data && data.hasMore);
  state.logsEnabled = enabled;
  state.logsStats = (data && data.stats) || { written: 0, dropped: 0, degraded: false };
  renderLogs();
}

function renderLogs() {
  const count = $('logs-count');
  if (count) count.textContent = state.logs.length + ' 条';
  const more = $('logs-more');
  if (more) more.classList.toggle('hidden', !state.logsHasMore);
  const rows = state.logsEnabled ? state.logs.map(logRow).join('') : '';
  const empty = state.logsEnabled ? LOGS_EMPTY_TEXT : LOGS_CLOSED_TEXT;
  $('logs').innerHTML = rows || emptyRow(8, empty);
  renderLogsDropped();
}

/** 写入失败被丢弃的条数绝不静默：> 0 就在页面顶部挂一条 alert。 */
function renderLogsDropped() {
  const el = $('logs-dropped');
  if (!el) return;
  const dropped = Number(state.logsStats && state.logsStats.dropped) || 0;
  if (dropped > 0) {
    el.textContent = '有 ' + dropped + ' 条请求日志写入失败被丢弃（请检查日志目录是否可写 / 磁盘是否已满）。';
    el.className = 'banner alert alert-error';
  } else {
    el.textContent = '';
    el.className = 'banner alert alert-error hidden';
  }
}

/** 客户端下拉：选项来自 GET /api/admin/keys（loadKeys 已把结果存进 state.keys）。 */
function renderLogsKeyOptions() {
  const sel = $('logs-key');
  if (!sel) return;
  const current = sel.value;
  const items = (state.keys || []).map((k) => '<option value="' + esc(k.keyId) + '">' + esc(k.name || shortId(k.keyId)) + '</option>');
  sel.innerHTML = '<option value="">全部客户端</option>' + items.join('');
  if (current) sel.value = current;
}

let logsGeneration = 0;
let logsOffset = 0;
async function loadLogs({ append = false } = {}) {
  const generation = ++logsGeneration;
  const offset = append ? logsOffset : 0;
  try {
    const data = await apiJSON(logsQuery(logsFilters(), offset));
    if (generation !== logsGeneration) return;      // 过期响应直接丢弃（同 loadEvents 的守卫）
    const items = (data && data.items) || [];
    if (append && Array.isArray(data && data.items) && items.length) {
      state.logs = state.logs.concat(items);
      state.logsHasMore = !!data.hasMore;
      state.logsEnabled = data.enabled !== false;
      state.logsStats = (data && data.stats) || state.logsStats;
      logsOffset = state.logs.length;
      renderLogs();
    } else {
      logsOffset = items.length;
      applyLogsData(data);
    }
  } catch (e) {
    if (generation !== logsGeneration) return;
    throw e;
  }
}

/** 筛选条件变化：回到第一页（offset=0）。 */
function reloadLogs() { logsOffset = 0; return loadLogs(); }

function ensureLogsBindings() {
  const status = $('logs-status');
  if (status && !status._logsBound) {
    status._logsBound = true;
    status.addEventListener('change', () => { reloadLogs().catch((e) => toast(e.message, true)); });
  }
  const key = $('logs-key');
  if (key && !key._logsBound) {
    key._logsBound = true;
    key.addEventListener('change', () => { reloadLogs().catch((e) => toast(e.message, true)); });
  }
}
