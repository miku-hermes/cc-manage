// 近 24 小时趋势：请求数 / 错误数 / 可用余额 三张迷你折线图。
// 纯内联 SVG（无任何第三方库），数据来自只读的 /api/history（只有聚合数字）。
// 依赖已先加载的 api.js（apiFetch）与 utils.js（num / money / esc）。

const TREND_VIEWBOX_W = 100;
const TREND_VIEWBOX_H = 24;

/** 非有限数（null / undefined / NaN / 非数字字符串）一律当 0 处理。 */
function trendNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * 把一组数值映射成 SVG 折线点串。
 * 边界（全部显式处理，绝不出 NaN / 除零）：
 *   - 空数组 → 返回 null（调用方渲染「暂无数据」，不画线）；
 *   - 单点 → 在中线画一段短水平线（只有一个点无法定义斜率，也不能除以 0）；
 *   - max === min（所有值相同）→ 用 span > 0 兜底，统一落在竖直中线。
 */
function sparkPoints(values, width = TREND_VIEWBOX_W, height = TREND_VIEWBOX_H, pad = 2) {
  const vals = Array.isArray(values) ? values.map(trendNum) : [];
  const n = vals.length;
  if (n === 0) return null;                        // 空：不画线
  const midY = height / 2;
  if (n === 1) {
    // 单点：水平短线，落中线（值本身没有起伏可说）
    return (width * 0.25).toFixed(2) + ',' + midY.toFixed(2) + ' '
      + (width * 0.75).toFixed(2) + ',' + midY.toFixed(2);
  }
  const innerH = Math.max(1, height - pad * 2);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min;                          // 0 时下面的 span > 0 分支不生效
  const step = width / (n - 1);
  const yOf = (v) => (span > 0 ? pad + (1 - (v - min) / span) * innerH : midY);
  return vals.map((v, i) => (i * step).toFixed(2) + ',' + yOf(v).toFixed(2)).join(' ');
}

/** 把毫秒跨度说成人话（分钟 / 小时），上限 24 小时。 */
function spanText(minutes) {
  const m = Math.min(24 * 60, Math.max(0, Math.round(minutes)));
  if (m < 60) return m + ' 分钟';
  const h = m / 60;
  return (Number.isInteger(h) ? h : h.toFixed(1)) + ' 小时';
}

/** 顶部区间文案：如实说明样本覆盖的时长；数据不足时明说「收集中」。 */
function trendRangeText(samples, data) {
  const bucketMs = trendNum(data?.bucketMs) || 5 * 60 * 1000;
  const perMin = Math.max(1, Math.round(bucketMs / 60000));
  const n = Array.isArray(samples) ? samples.length : 0;
  if (n === 0) return '近 24 小时 · 每 ' + perMin + ' 分钟 · 暂无数据';
  if (n === 1) return '每 ' + perMin + ' 分钟 · 数据收集中（1 个样本）';
  return '近 ' + spanText(((n - 1) * bucketMs) / 60000) + ' · 每 ' + perMin + ' 分钟';
}

/** 单张迷你折线卡：小标题 + sparkline + 当前值。 */
function trendCard({ label, valueText, values, tone }) {
  const points = sparkPoints(values);
  const body = points === null
    ? '<div class="trend-empty">暂无数据</div>'
    : '<svg class="trend-spark" viewBox="0 0 ' + TREND_VIEWBOX_W + ' ' + TREND_VIEWBOX_H + '"'
      + ' preserveAspectRatio="none" aria-hidden="true">'
      + '<polyline class="trend-line" points="' + points + '" fill="none" vector-effect="non-scaling-stroke"/>'
      + '</svg>';
  return '<div class="trend-card ' + esc(tone) + '">'
    + '<div class="trend-head">'
    + '<span class="trend-label">' + esc(label) + '</span>'
    + '<b class="trend-value">' + valueText + '</b>'
    + '</div>'
    + body
    + '</div>';
}

/** 渲染三张趋势卡到 #trend。samples 为空 / 字段缺失都不能抛。 */
function renderTrend(data) {
  const host = $('trend');
  if (!host) return;
  const samples = Array.isArray(data?.samples) ? data.samples : [];
  const rs = samples.map((s) => trendNum(s?.r));
  const es = samples.map((s) => trendNum(s?.e));
  const ms = samples.map((s) => trendNum(s?.m));
  const lastOf = (arr) => (arr.length ? arr[arr.length - 1] : null);
  const rLast = lastOf(rs);
  const eLast = lastOf(es);
  const mLast = lastOf(ms);
  host.innerHTML = '<div class="trend-head-row">'
    + '<span class="trend-title">近 24 小时趋势</span>'
    + '<span class="trend-range aux-text">' + esc(trendRangeText(samples, data)) + '</span>'
    + '</div>'
    + '<div class="trend-grid">'
    + trendCard({ label: '请求数', valueText: rLast === null ? '—' : num(rLast), values: rs, tone: 'trend-accent' })
    + trendCard({ label: '错误数', valueText: eLast === null ? '—' : num(eLast), values: es, tone: 'trend-danger' })
    + trendCard({ label: '可用余额', valueText: mLast === null ? '—' : money(mLast), values: ms, tone: 'trend-success' })
    + '</div>';
}

/** 拉取 + 渲染。失败静默降级：保留上一次内容，不打日志，绝不影响主面板。 */
async function loadTrend() {
  try {
    const r = await apiFetch('/api/history');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();
    renderTrend(data);
  } catch (e) {
    /* 趋势面板不是关键路径：失败就保持现状，不打扰主面板，也不刷控制台 */
  }
}
