/* 用量统计页（可选页）：GET /api/admin/usage?range=24h&bucket=1h。
   KPI 一排 + ECharts 折线（懒加载 vendor/echarts.min.js，照 render-trend.js 的做法）+ 三张小表。
   拿不到 ECharts 就退回文字摘要，绝不抛异常到主流程。 */
const USAGE_ECHARTS_BUILD = '6.1.0-b66b25ae';
const USAGE_ECHARTS_SRC = 'vendor/echarts.min.js?v=' + USAGE_ECHARTS_BUILD;
const USAGE_OK_TEXT = '24 小时';
let usageChart = null;
let usageEChartsPromise = null;
let usageRange = '24h';

function usageBucket(range) { return range === '30d' ? '1d' : '1h'; }

function usageKpi(label, value) {
  return '<div class="card border border-base-300 bg-base-100"><div class="card-body gap-1 p-3">'
    + '<span class="text-xs text-base-content/60">' + esc(label) + '</span>'
    + '<span class="text-xl font-semibold tabular-nums">' + esc(value) + '</span></div></div>';
}

function usageTable(title, head, rows) {
  const body = rows.length
    ? rows.map((r) => '<tr>' + r.map((c) => '<td class="tabular-nums">' + esc(c) + '</td>').join('') + '</tr>').join('')
    : '<tr><td colspan="' + head.length + '" class="empty text-base-content/60">暂无数据</td></tr>';
  return '<section class="card min-w-64 flex-1 border border-base-300 bg-base-100"><div class="card-body gap-2 p-3">'
    + '<h4 class="text-sm font-semibold">' + esc(title) + '</h4>'
    + '<div class="overflow-x-auto"><table class="table table-sm"><thead><tr>'
    + head.map((h) => '<th>' + esc(h) + '</th>').join('') + '</tr></thead><tbody>' + body + '</tbody></table></div>'
    + '</div></section>';
}

function renderUsage(data) {
  const totals = (data && data.totals) || {};
  const kpis = $('usage-kpis');
  if (kpis) {
    kpis.innerHTML = [
      usageKpi('请求', String(Number(totals.requests) || 0)),
      usageKpi('错误', String(Number(totals.errors) || 0)),
      usageKpi('token 入', numText(totals.tokensIn)),
      usageKpi('token 出', numText(totals.tokensOut)),
    ].join('');
  }
  const tables = $('usage-tables');
  if (tables) {
    const byKey = ((data && data.byKey) || []).map((k) => [k.keyName || shortId(k.keyId) || '—', k.requests, numText(k.tokensIn + k.tokensOut)]);
    const byModel = ((data && data.byModel) || []).map((m) => [m.model || '—', m.requests, numText(m.tokensIn + m.tokensOut)]);
    const byAccount = ((data && data.byAccount) || []).map((a) => [a.accountName || shortId(a.accountKeyId) || '—', a.requests, String(a.errors)]);
    tables.innerHTML = usageTable('按客户端', ['客户端', '请求', 'token'], byKey)
      + usageTable('按模型', ['模型', '请求', 'token'], byModel)
      + usageTable('按账号', ['账号', '请求', '错误'], byAccount);
  }
  drawUsageChart(data);
}

/** 懒加载 ECharts（照 render-trend.js：只在进页面真正渲染时插 <script>）。 */
function ensureUsageECharts() {
  if (typeof globalThis !== 'undefined' && globalThis.echarts) return Promise.resolve(globalThis.echarts);
  if (usageEChartsPromise) return usageEChartsPromise;
  usageEChartsPromise = new Promise((resolve) => {
    let script = null;
    try { script = document.createElement('script'); } catch { resolve(null); return; }
    if (!script || typeof script !== 'object') { resolve(null); return; }
    script.src = USAGE_ECHARTS_SRC;
    script.async = true;
    script.onload = () => resolve(typeof globalThis !== 'undefined' ? globalThis.echarts : null);
    script.onerror = () => resolve(null);
    try { document.body.appendChild(script); } catch { resolve(null); }
  });
  usageEChartsPromise.then((lib) => { if (!lib) usageEChartsPromise = null; });
  return usageEChartsPromise;
}

function usageOption(series) {
  return {
    grid: { left: 8, right: 8, top: 24, bottom: 8, containLabel: true },
    tooltip: { trigger: 'axis' },
    legend: { data: ['请求', 'token'], top: 0 },
    xAxis: { type: 'category', data: series.map((s) => logTime(s.t)) },
    yAxis: { type: 'value', min: 0 },
    series: [
      { name: '请求', type: 'line', smooth: true, data: series.map((s) => Number(s.requests) || 0) },
      { name: 'token', type: 'line', smooth: true, data: series.map((s) => (Number(s.tokensIn) || 0) + (Number(s.tokensOut) || 0)) },
    ],
  };
}

async function drawUsageChart(data) {
  const el = $('usage-chart');
  if (!el) return;
  const series = (data && data.series) || [];
  const lib = await ensureUsageECharts();
  if (!lib || typeof lib.init !== 'function') return;   // 拿不到库：KPI 与三张表已经够用
  try {
    if (!usageChart) usageChart = lib.init(el);
    usageChart.setOption(usageOption(series));
  } catch { usageChart = null; }
}

async function loadUsage() {
  const data = await apiJSON('/api/admin/usage?range=' + encodeURIComponent(usageRange) + '&bucket=' + usageBucket(usageRange));
  renderUsage(data);
}

async function reloadUsage() { return loadUsage(); }
