// 近 24 小时趋势：请求数 / 错误数 / 可用余额 三张迷你折线图。
// 纯内联 SVG（无任何第三方库），数据来自只读的 /api/history（只有聚合数字）。
// 依赖已先加载的 api.js（apiFetch）与 utils.js（num / money / esc）。

const TREND_VIEWBOX_W = 100;
const TREND_VIEWBOX_H = 24;
// 图内左右留白：折线端点不贴卡片内容边缘（三条线起止线一致）。
const TREND_PAD_X = 4;
// 图内上下留白：零基准映射后 0 → 底部基线，最大值 → 顶部。
const TREND_PAD_Y = 2;
// y=0 锚线（底部基线）在 viewBox 里的高度。
const TREND_BASELINE_Y = TREND_VIEWBOX_H - TREND_PAD_Y;
// 每 5 分钟一个采样时，攒满 24 小时窗口需要 12 个样本（1 小时）；
// 少于它时标题不得声称「近 24 小时」。
const TREND_FULL_WINDOW_SAMPLES = 12;

/** 非有限数（null / undefined / NaN / 非数字字符串）一律当 0 处理。 */
function trendNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** 一组值是否全为 0（空数组不算）。全 0 序列没有高度可言，不画面积填充。 */
function isAllZero(vals) {
  return vals.length > 0 && vals.every((v) => trendNum(v) === 0);
}

/**
 * 把一组数值映射成 SVG 折线点串（y 轴零基准，不是 min-max 归一化）。
 * 边界（全部显式处理，绝不出 NaN / 除零）：
 *   - 空数组 → 返回 null（调用方渲染「暂无数据」，不画线）；
 *   - 单点 → 在中线画一段短水平线（只有一个点无法定义斜率，也不能除以 0）；
 *     注意：调用方对样本数 < 2 一律走「数据不足」分支，把它当虚线基线画，
 *     绝不画成实心彩线（否则和「真实数据恰好是常量」在视觉上无法区分）；
 *   - 恒定非零序列（span 为 0）→ 统一落在竖直中线（没有高度差可比）；
 *   - 全 0 序列 → 落在底部基线（最少墨水，不再被画成全 panel 最重的色带）。
 * 映射：y(v) = padY + (1 - v / scale) * innerH，scale = max(所有值, 极小正数)；
 * 于是 0 自动塌到底部细线，数值大小真实反映高度。
 */
function sparkPoints(values, width = TREND_VIEWBOX_W, height = TREND_VIEWBOX_H, padY = TREND_PAD_Y, padX = TREND_PAD_X) {
  const vals = Array.isArray(values) ? values.map(trendNum) : [];
  const n = vals.length;
  if (n === 0) return null;                        // 空：不画线
  const midY = height / 2;
  if (n === 1) {
    // 单点：水平短线，落中线（值本身没有起伏可说）
    return (padX + (width - padX * 2) * 0.25).toFixed(2) + ',' + midY.toFixed(2) + ' '
      + (padX + (width - padX * 2) * 0.75).toFixed(2) + ',' + midY.toFixed(2);
  }
  const innerH = Math.max(1, height - padY * 2);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min;                          // 0 时下面的 span > 0 分支不生效（除零守卫）
  const scale = Math.max(max, 1e-6);               // 零基准：最大值当满量程（全 0 时退化为极小正数）
  const stepX = (width - padX * 2) / (n - 1);
  const xOf = (i) => padX + i * stepX;
  const yOf = (v) => (span > 0
    ? padY + (1 - v / scale) * innerH             // 零基准映射：不再按 span 缩放（已弃用 min-max 归一化）
    : (max > 0 ? midY : padY + innerH));          // 恒定非零 → 中线；全 0 → 底部基线
  return vals.map((v, i) => xOf(i).toFixed(2) + ',' + yOf(v).toFixed(2)).join(' ');
}

/**
 * 折线点串 → 闭合面积多边形的点串（在折线下方铺一层同色半透明填充，
 * 让高度方向的大小能被看出来）。闭合到 y=0 的底部基线，并保持图内左右留白。
 * 只给「非全 0」的实心折线分支使用；虚线空态与全 0 序列都不填充。
 * points 为空 / 非字符串时返回 null。
 */
function areaPoints(points, width = TREND_VIEWBOX_W, padX = TREND_PAD_X, baselineY = TREND_BASELINE_Y) {
  if (typeof points !== 'string' || points.length === 0) return null;
  return points + ' ' + (width - padX).toFixed(2) + ',' + baselineY.toFixed(2)
    + ' ' + padX.toFixed(2) + ',' + baselineY.toFixed(2);
}

/** 每张图底部的 y=0 锚线：很淡的水平规则线，给三条序列同一个高度基准。 */
function baselineMarkup() {
  return '<line class="trend-baseline" x1="' + TREND_PAD_X.toFixed(2) + '" y1="' + TREND_BASELINE_Y.toFixed(2)
    + '" x2="' + (TREND_VIEWBOX_W - TREND_PAD_X).toFixed(2) + '" y2="' + TREND_BASELINE_Y.toFixed(2)
    + '" vector-effect="non-scaling-stroke"/>';
}

/** 折线末端坐标（给端点小圆点用）；点串无效时返回 null。 */
function lastPoint(points) {
  if (typeof points !== 'string' || points.length === 0) return null;
  const pts = points.trim().split(' ');
  const parts = pts[pts.length - 1].split(',');
  if (parts.length !== 2) return null;
  return { x: parts[0], y: parts[1] };
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
  const capacity = Math.max(1, Math.round((24 * 60) / perMin)); // 24 小时窗口能装多少样本（5 分钟 → 288）
  if (n < 2) {
    // 数据不足：明说收集中，并给出「已攒 n / 满窗 capacity」的比例，别让人误以为是全量累计
    return '数据收集中 · ' + n + '/' + capacity + ' 个样本（每 ' + perMin + ' 分钟一个）';
  }
  // 样本够画线：明确写出这段曲线只覆盖最近这么长的时间窗（与上方累计值区分开）
  return '覆盖最近 ' + spanText(((n - 1) * bucketMs) / 60000) + ' · 共 ' + n + ' 个样本（每 ' + perMin + ' 分钟一个）';
}

/**
 * 标题：样本不足 1 小时（< 12 个）时别硬说「近 24 小时」，明说还在收集中；
 * 攒够了才显示纯「近 24 小时趋势」。右侧区间文案仍由 trendRangeText 负责。
 */
function trendTitle(sampleCount) {
  const n = trendNum(sampleCount);
  return n < TREND_FULL_WINDOW_SAMPLES ? '近 24 小时趋势（数据收集中）' : '近 24 小时趋势';
}

/**
 * 单张迷你折线卡，统一两行结构：
 *   行 1「标签 + 当前值」两端对齐（三个条目共享同一条基线）；
 *   行 2 sparkline 独占整宽（同一列宽 + 同一图内左右留白 → 三条线端点对齐）。
 * 三条序列同一种画法：底部基线 + 同色半透明面积 + 2px 圆头折线 + 末端小圆点；
 * 全 0 序列跳过面积填充（零高度的多边形只会糊成一条色带）。
 * 样本数 < 2 时不画实心彩线：画中性灰虚线基线 + 「数据不足」，且不加面积填充。
 */
function trendCard({ label, valueText, values, tone }) {
  const vals = Array.isArray(values) ? values : [];
  const points = sparkPoints(vals);
  const sparse = vals.length < 2;                  // 0 / 1 个样本：图上必须自己看得出「数据不足」
  const allZero = isAllZero(vals);                 // 全 0：不画面积填充（零高度多边形无意义）
  const svgOpen = '<svg class="trend-spark" viewBox="0 0 ' + TREND_VIEWBOX_W + ' ' + TREND_VIEWBOX_H + '"'
    + ' preserveAspectRatio="none" aria-hidden="true">';
  let plot;
  if (points === null) {
    // 一个样本都没有：图内不画任何线，只说明暂无数据
    plot = '<div class="trend-plot"><div class="trend-empty">暂无数据</div></div>';
  } else if (sparse) {
    // 只有 1 个样本：绝不用实心彩线（会和「常量真实数据」混淆），改用中性灰虚线基线 + 文字提示
    plot = '<div class="trend-plot trend-plot-sparse">'
      + svgOpen
      + baselineMarkup()
      + '<polyline class="trend-line trend-line-dashed" points="' + points + '" fill="none"'
      + ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round"'
      + ' stroke-dasharray="4 3" vector-effect="non-scaling-stroke"/>'
      + '</svg>'
      + '<span class="trend-note">数据不足</span>'
      + '</div>';
  } else {
    // 样本数 ≥ 2：底部基线 + 折线下方同色半透明面积 + 2px 圆头折线 + 末端圆点。
    // 全 0 序列（allZero）跳过面积，避免 0 变成整块面板最重的色带。
    const dot = lastPoint(points);
    plot = '<div class="trend-plot">'
      + svgOpen
      + baselineMarkup()
      + (allZero ? '' : '<polygon class="trend-area" points="' + areaPoints(points) + '"/>')
      + '<polyline class="trend-line" points="' + points + '" fill="none"'
      + ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round"'
      + ' vector-effect="non-scaling-stroke"/>'
      + (dot ? '<circle class="trend-dot" cx="' + dot.x + '" cy="' + dot.y + '" r="2"/>' : '')
      + '</svg>'
      + '</div>';
  }
  return '<div class="trend-card trend-item ' + esc(tone) + '">'
    + '<div class="trend-row">'
    + '<span class="trend-label">' + esc(label) + '</span>'
    + '<b class="trend-value">' + valueText + '</b>'
    + '</div>'
    + plot
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
    + '<span class="trend-title">' + esc(trendTitle(samples.length)) + '</span>'
    + '<span class="trend-range aux-text">' + esc(trendRangeText(samples, data)) + '</span>'
    + '</div>'
    + '<div class="trend-grid">'
    + trendCard({ label: '请求数', valueText: rLast === null ? '—' : num(rLast), values: rs, tone: 'trend-request' })
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
