// 近 24 小时趋势：一张 ECharts 图（共享时间 X 轴 + 左「次」/ 右「USD」双 Y 轴）。
//
// 设计要点：
//   - 图表配置由纯函数 buildTrendOption() 产出：不碰 DOM、不依赖 ECharts 运行时，
//     空态 / 全 0 等边界与每个字段都能在极简 DOM 垫片里直接断言。
//   - ECharts（public/vendor/echarts.min.js，6.1.0 全量构建，Apache-2.0，见 public/vendor/README.md）
//     懒加载：首屏不拉 ~1.1MB，趋势第一次真正渲染时才插入 <script>；拿不到库就退回
//     文本摘要 + 一行说明（不白屏、不报错）。
//   - 颜色全部来自 tokens.css 的 --chart-* 语义令牌（readTrendTokens 读计算值），
//     本文件不出现任何字面色值；暗色主题由同一套令牌的覆盖块给出，主题切换时重刷 option。
// 依赖已先加载的 api.js（apiFetch）与 utils.js（esc）。

const TREND_FULL_WINDOW_SAMPLES = 12;       // 拿不到 bucketMs 时的兜底满窗样本数（1 小时）
// 库文件带一年 immutable 缓存（见 public/vendor/README.md）：URL 必须随文件内容变化，
// 否则换构建对老用户不生效（浏览器吃旧缓存，mark* 永远画不出来）。
const TREND_ECHARTS_BUILD = '6.1.0-b66b25ae';
const TREND_ECHARTS_SRC = 'vendor/echarts.min.js?v=' + TREND_ECHARTS_BUILD;
// 导出给测试（vm 垫片）核对版本串与 public/vendor/echarts.min.js 的 sha256 一致。
if (typeof globalThis !== 'undefined') {
  globalThis.TREND_ECHARTS_BUILD = TREND_ECHARTS_BUILD;
  globalThis.TREND_ECHARTS_SRC = TREND_ECHARTS_SRC;
}
const TREND_DENSE_SAMPLES = 48;             // 超过这个点数：关掉数据点 + LTTB 降采样
const TREND_SYMBOL_SIZE = 3;                // 错误数非零点的小圆点直径（px）

// 视觉主次（批次 21c）：余额是主角、请求退到背景、错误只在有事时出现。
const TREND_REQUEST_LINE_WIDTH = 1;
const TREND_ERROR_LINE_WIDTH = 1;
const TREND_BALANCE_LINE_WIDTH = 2;
const TREND_REQUEST_LINE_OPACITY = 0.7;
const TREND_REQUEST_AREA_OPACITY = 0.08;   // 请求数面积顶部透明度：极淡，几乎只作背景温度
const TREND_BALANCE_AREA_OPACITY = 0.20;   // 余额面积顶部透明度：主角，落在 18%~22% 档
const TREND_AXIS_SPLIT = 4;                // 量程目标等分数：上限≈峰值×1.15 再取整，不留大片死区
const TREND_X_PAD_RATIO = 0.03;            // 时间轴右端留白 = 窗口跨度 3%（「现在」不贴边被裁）
const TREND_X_PAD_MIN_BUCKETS = 2;         // 右端留白至少 2 个桶（窄窗口也有呼吸空间）
const TREND_AXIS_NAME_SIZE = 12;           // 轴名小字：与对应序列同色 + 略放大（双轴归属一眼可辨）
const TREND_LEGEND_FONT_SIZE = 13;         // 图例字号 = 页面次要正文字号（--fs-sm）
const TREND_LEGEND_ITEM = 10;              // 图例色点直径 8~10px
const TREND_LEGEND_GAP = 20;               // 图例项间距
// 单位只挂左右 Y 轴的轴标题，绝不进图例：图例项 = 纯序列名，三项才放得下一行、基线对齐；
// 单位混进图例会拉长第三项，窄屏把「可用余额」挤到第二行，看着像排版崩了。
const TREND_UNIT_COUNT = '次';             // 左轴（请求数 / 错误数）单位
const TREND_UNIT_AMOUNT = 'USD';           // 右轴（可用余额）单位
const TREND_TOPUP_MIN_USD = 0.01;          // 余额单步上升超过这个数才算一次充值
const TREND_TOPUP_LEADER_PX = 12;          // 充值引线长度（像素空间，竖直指向阶跃点）
const TREND_TOPUP_LABEL_DISTANCE = 10;     // 充值 chip 底部与阶跃点的间距（px）
const TREND_TOPUP_CHIP_RADIUS = 6;         // 充值 chip 圆角半径（px）
const TREND_GAP_MIN_BUCKETS = 6;           // 未覆盖区间 >= 6 个桶（约 30 分钟）才画「无数据」带
const TREND_GAP_OPACITY = 0.20;            // 「无数据」带不透明度（适当降低，不与底色糊在一起）
const TREND_GAP_RADIUS = 10;               // 「无数据」带右端圆角半径（px，像素空间绘制）

// 调色板键 → tokens.css 里的语义令牌名。新增 / 改名令牌只需改这一张表。
const TREND_TOKEN_KEYS = Object.freeze({
  request: '--chart-series-request',
  error: '--chart-series-error',
  balance: '--chart-series-balance',
  grid: '--chart-grid',
  gridH: '--chart-grid-h',
  now: '--chart-now',
  axis: '--chart-axis',
  label: '--chart-axis-label',
  tooltipBg: '--chart-tooltip-bg',
  tooltipBorder: '--chart-tooltip-border',
  tooltipText: '--chart-tooltip-text',
  cursor: '--chart-cursor',
});

const TREND_SERIES_NAMES = Object.freeze({
  request: '请求数',
  error: '错误数',
  balance: '可用余额',
});

// ── 纯数据工具 ────────────────────────────────────────────────────────

/** 非有限数（null / undefined / NaN / 非数字字符串）一律当 0 处理。 */
function trendNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** 一组值是否全为 0（空数组不算）。全 0 序列没有高度可言，不画面积填充。 */
function isAllZero(vals) {
  return vals.length > 0 && vals.every((v) => trendNum(v) === 0);
}

/** 计数（「次」）：千分位整数，纯字符串实现，不依赖 Intl / 区域设置。 */
function trendInt(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return '0';
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** 金额（USD）：固定两位小数。 */
function trendUsdText(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(2) : '—';
}

/** 右轴刻度：整数就不带小数（5），否则两位（17.47）。 */
function trendUsdTick(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '';
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

function trendPad2(n) { return String(n).padStart(2, '0'); }

/** 时间轴刻度：HH:mm。 */
function trendClock(ms) {
  const d = new Date(Number(ms));
  if (!Number.isFinite(d.getTime())) return '';
  return trendPad2(d.getHours()) + ':' + trendPad2(d.getMinutes());
}

/** 提示框表头：MM-DD HH:mm。 */
function trendDayClock(ms) {
  const d = new Date(Number(ms));
  if (!Number.isFinite(d.getTime())) return '';
  return trendPad2(d.getMonth() + 1) + '-' + trendPad2(d.getDate()) + ' ' + trendClock(ms);
}

/** 把毫秒跨度说成人话（分钟 / 小时），上限 24 小时。 */
function spanText(minutes) {
  const m = Math.min(24 * 60, Math.max(0, Math.round(minutes)));
  if (m < 60) return m + ' 分钟';
  const h = m / 60;
  return (Number.isInteger(h) ? h : h.toFixed(1)) + ' 小时';
}

/** 24 小时窗口的满窗样本数：由后端 bucketMs 推出（5 分钟桶 → 288），不写死。 */
function trendCapacity(data) {
  const bucketMs = trendNum(data?.bucketMs) || 5 * 60 * 1000;
  const perMin = Math.max(1, Math.round(bucketMs / 60000));
  return Math.max(1, Math.round((24 * 60) / perMin));
}

/** capacity → bucketMs（buildTrendOption 的纯函数签名只收 capacity，这里反推）。 */
function trendBucketMsFromCapacity(capacity) {
  const c = Number(capacity);
  return Number.isFinite(c) && c > 0 ? Math.round((24 * 60 * 60 * 1000) / c) : 5 * 60 * 1000;
}

/** 顶部区间文案：如实说明样本覆盖的时长；数据不足时明说「收集中」。 */
function trendRangeText(samples, data) {
  const bucketMs = trendNum(data?.bucketMs) || 5 * 60 * 1000;
  const perMin = Math.max(1, Math.round(bucketMs / 60000));
  const n = Array.isArray(samples) ? samples.length : 0;
  if (n < 2) {
    // 数据不足：样本数已由标题旁的「数据收集中 n/capacity」徽章表达，这里只说明节拍。
    return '数据收集中 · 每 ' + perMin + ' 分钟一个点';
  }
  // 样本够画线：只写明覆盖的时间窗（样本数在徽章里，不再说第二遍）。
  return '覆盖最近 ' + spanText(((n - 1) * bucketMs) / 60000) + '（每 ' + perMin + ' 分钟一个点）';
}

/**
 * 标题：样本不足「满 24 小时窗口」（capacity，由 bucketMs 推出）时别硬说「近 24 小时」，
 * 明说还在收集中；攒够了才显示纯「近 24 小时趋势」。
 * capacity 缺失（无 bucketMs 的调用）时退回 TREND_FULL_WINDOW_SAMPLES 兜底。
 * 注意：标题文案是「近 24 小时趋势（数据收集中）」，但页面上不再用全角括号硬拼 ——
 * 可见部分拆成「标题 + 右侧 pill 徽章」，这个整串只用于图表容器的 aria-label。
 */
function trendTitle(sampleCount, capacity) {
  const n = trendNum(sampleCount);
  const full = Number.isFinite(Number(capacity)) && Number(capacity) > 0
    ? Math.round(Number(capacity))
    : TREND_FULL_WINDOW_SAMPLES;
  return n < full ? '近 24 小时趋势（数据收集中）' : '近 24 小时趋势';
}

/**
 * 数据覆盖区间：把 X 轴钉在真实 24h 窗口上，左侧没数据的时段留白，
 * 让「曲线从哪开始」可见（批次 21c 第 8 条）。返回 null 表示没有样本。
 * xMin 取窗口起点与首个样本里更靠左的那个 —— 数据比窗口还老时优先显示全部数据。
 */
function trendCoverage(list, capacity) {
  if (!Array.isArray(list) || list.length === 0) return null;
  const bucket = trendBucketMsFromCapacity(capacity);
  const cap = Math.max(1, Math.round(Number(capacity) || TREND_FULL_WINDOW_SAMPLES));
  const firstT = trendXOf(list[0], 0);
  const lastT = trendXOf(list[list.length - 1], list.length - 1);
  const windowStart = lastT - (cap - 1) * bucket;
  const xMin = Math.min(firstT, windowStart);
  return { firstT, lastT, xMin, xMax: lastT, bucket, gapMs: firstT - xMin };
}

/**
 * 余额阶跃里的「充值」：找相邻样本里最大的一次上升（step: 'end' 语义下，
 * 上升发生在后一个样本处）。差额小于阈值就当作噪声，不标注（批次 21c 第 6 条）。
 */
function trendTopup(list) {
  if (!Array.isArray(list) || list.length < 2) return null;
  let best = null;
  for (let i = 1; i < list.length; i += 1) {
    const amount = trendNum(list[i]?.m) - trendNum(list[i - 1]?.m);
    if (amount >= TREND_TOPUP_MIN_USD && (!best || amount > best.amount)) {
      best = { index: i, t: trendXOf(list[i], i), value: trendNum(list[i]?.m), amount };
    }
  }
  return best;
}

/** 充值标注文案：`HH:mm 充值 +X USD`（时间用该样本的 t 走现有 HH:mm 格式化）。 */
function trendTopupText(topup) {
  if (!topup) return '';
  return trendClock(topup.t) + ' 充值 +' + trendUsdText(topup.amount) + ' USD';
}

// ── 主题：从 CSS 令牌解析图表色 ──────────────────────────────────────

/**
 * 读 tokens.css 的图表令牌计算值（暗色主题由 data-theme="dark" 的覆盖块给出，
 * 因为计算值来自 documentElement，切换主题后重读即可拿到新色）。
 * 垫片环境没有 getComputedStyle：返回全空字符串，buildTrendOption 仍能构造（颜色为空）。
 */
function readTrendTokens(root) {
  const out = {};
  const el = root || (typeof document !== 'undefined' ? document.documentElement : null);
  let cs = null;
  try {
    if (el && typeof getComputedStyle === 'function') cs = getComputedStyle(el);
  } catch { cs = null; }
  for (const key of Object.keys(TREND_TOKEN_KEYS)) {
    let v = '';
    try {
      v = cs && typeof cs.getPropertyValue === 'function'
        ? String(cs.getPropertyValue(TREND_TOKEN_KEYS[key]) || '').trim()
        : '';
    } catch { v = ''; }
    out[key] = v;
  }
  return out;
}

function trendPalette(theme) {
  const t = theme && typeof theme === 'object' ? theme : {};
  const out = {};
  for (const key of Object.keys(TREND_TOKEN_KEYS)) out[key] = typeof t[key] === 'string' ? t[key] : '';
  return out;
}

/** 减少动态效果：与 base.css 的 reduced-motion 约定一致，命中就关掉图表动画。 */
function trendReducedMotion() {
  try {
    return !!(typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  } catch { return false; }
}

// ── 纯函数：ECharts option ───────────────────────────────────────────

/** 四舍五入到 6 位小数：消掉 step*n 这类浮点尾巴（0.6000000000000001 → 0.6）。 */
function trendRoundFloat(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 1e6) / 1e6 : v;
}

/** 同色淡出：把序列色按 alpha 包成 rgba（保持色相不变，不跟 transparent 黑做插值）。 */
function trendAlpha(color, alpha) {
  const a = Number.isFinite(Number(alpha)) ? Math.max(0, Math.min(1, Number(alpha))) : 1;
  const s = String(color == null ? '' : color).trim();
  let m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i.exec(s);
  if (m) return 'rgba(' + m[1] + ', ' + m[2] + ', ' + m[3] + ', ' + trendRoundFloat(a) + ')';
  m = /^#([0-9a-f]{6})$/i.exec(s);
  if (m) {
    const n = parseInt(m[1], 16);
    return 'rgba(' + ((n >> 16) & 255) + ', ' + ((n >> 8) & 255) + ', ' + (n & 255) + ', ' + trendRoundFloat(a) + ')';
  }
  m = /^#([0-9a-f]{3})$/i.exec(s);
  if (m) {
    const h = m[1];
    return 'rgba(' + parseInt(h[0] + h[0], 16) + ', ' + parseInt(h[1] + h[1], 16) + ', ' + parseInt(h[2] + h[2], 16) + ', ' + trendRoundFloat(a) + ')';
  }
  return s;
}

/**
 * 线性渐变面积：同一个色相由顶部 α 淡出到 0。
 * 关键：两个 stop 保持同色相、只降 alpha —— 不能写成 (序列色 → transparent)：
 * ECharts 在非预乘空间会把颜色插值成暗褐，再乘整体 opacity 就「发脏」（批次 21f 第 4 条）。
 */
function trendAreaStyle(color, opacity = TREND_BALANCE_AREA_OPACITY) {
  return {
    color: {
      type: 'linear',
      x: 0, y: 0, x2: 0, y2: 1,
      colorStops: [
        { offset: 0, color: trendAlpha(color, opacity) },
        { offset: 1, color: trendAlpha(color, 0) },
      ],
    },
  };
}

/** 整数 / 小数轴都合用的「整齐」步长：1 / 1.5 / 2 / 2.5 / 3 / 4 / 5 / 6 / 8 / 10 × 10^k。 */
function trendNiceStep(raw) {
  const v = Number(raw);
  if (!(v > 0) || !Number.isFinite(v)) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / mag;
  const mult = n <= 1 ? 1 : n <= 1.5 ? 1.5 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 3 ? 3
    : n <= 4 ? 4 : n <= 5 ? 5 : n <= 6 ? 6 : n <= 8 ? 8 : 10;
  return mult * mag;
}

/**
 * 轴量程：min 恒为 0（零基准红线不动），max 贴合数据 —— 峰值 ×1.15 后向上取整到
 * 整齐步长，而不是让 ECharts 默认 nice 给到峰值数倍、留下无信息死区（批次 21f 第 1 条）。
 * 全 0 / 无正数 → 不设 max，交给 ECharts 默认，绝不伪造量程。
 */
function trendAxisScale(values, { integer = false, split = TREND_AXIS_SPLIT } = {}) {
  const nums = (Array.isArray(values) ? values : []).map(trendNum).filter((v) => v > 0);
  const rawMax = nums.length ? Math.max(...nums) : 0;
  if (!(rawMax > 0)) return { max: undefined, interval: undefined, splitNumber: split };
  const target = rawMax * 1.15;
  let interval = trendNiceStep(target / split);
  if (integer) interval = Math.max(1, Math.ceil(interval));
  const max = Math.ceil(target / interval) * interval;
  const splitNumber = Math.max(2, Math.round(max / interval));
  return { max: trendRoundFloat(max), interval: trendRoundFloat(interval), splitNumber };
}

function trendAxisLabel(color) {
  return { color, fontSize: 11 };
}

/** x 轴取值：样本自带 t 用 t；缺失时退回序号（只保证 option 可构造，不假装真实时间）。 */
function trendXOf(sample, index) {
  const t = Number(sample?.t);
  return Number.isFinite(t) ? t : index;
}

/** 序列数据 → [时间, 值] 点对（time 轴要求二元组）。 */
function trendSeriesData(samples, key) {
  return samples.map((s, i) => [trendXOf(s, i), trendNum(s?.[key])]);
}

/** 右端圆角矩形的轮廓（像素空间）：左端贴轴保持方角，右端两角用圆弧倒角。 */
function trendRoundRightPoints(x0, x1, y0, y1, radius) {
  const rr = Math.max(0, Math.min(radius, (x1 - x0) / 2, (y1 - y0) / 2));
  const seg = 4;
  const pts = [[x0, y0], [x1 - rr, y0]];
  for (let i = 1; i <= seg; i += 1) {
    const a = -Math.PI / 2 + (Math.PI / 2) * (i / seg);
    pts.push([x1 - rr + rr * Math.cos(a), y0 + rr + rr * Math.sin(a)]);
  }
  for (let i = 1; i <= seg; i += 1) {
    const a = (Math.PI / 2) * (i / seg);
    pts.push([x1 - rr + rr * Math.cos(a), y1 - rr + rr * Math.sin(a)]);
  }
  pts.push([x0, y1]);
  return pts;
}

/**
 * 「无数据」带：覆盖整个绘图区高度，从轴上起点到首个样本。
 * 用 custom series 在**像素空间**画右端圆角矩形 —— markArea 内部走 polygon，
 * `itemStyle.borderRadius` 会被忽略、画不出圆角（批次 21f 第 7 条）。
 * 注意 renderItem 必须返回**单个**图元（本带把矩形 + 文字包成一个 group）；
 * 返回数组在 ECharts 6 会直接抛错，整张图被当成挂载失败（批次 21h 线上事故）。
 * 放在最后、z:0，只影响图层顺序（永远垫在三条数据线之下）。
 */
function trendGapSeries(coverage, palette) {
  return {
    type: 'custom',
    name: '无数据',
    silent: true,
    z: 0,
    clip: true,
    legendHoverLink: false,
    tooltip: { show: false },
    dimensions: ['x0', 'y', 'x1'],
    encode: { x: [0, 2], y: 1 },
    data: [[coverage.xMin, 0, coverage.firstT]],
    // ECharts 6 的 renderItem 只接受**单个**图元：返回数组会在 graphic 转换里
    // `throw new Error()`（消息为空），把整个 setOption 炸掉 —— 挂载方按失败处理，
    // 图容器被 hidden、降级文案亮出（线上 21g：canvas / 实例都在，就是看不见图）。
    // 多个图元必须包成一个 group，用 children 承载。
    renderItem: (params, api) => {
      const cs = params && params.coordSys ? params.coordSys : {};
      const y0 = cs.y || 0;
      const y1 = y0 + (cs.height || 0);
      const x0 = api.coord([api.value(0), 0])[0];
      const x1 = api.coord([api.value(2), 0])[0];
      return {
        type: 'group',
        children: [
          {
            type: 'polygon',
            shape: { points: trendRoundRightPoints(x0, x1, y0, y1, TREND_GAP_RADIUS) },
            style: { fill: palette.grid, opacity: TREND_GAP_OPACITY },
          },
          {
            type: 'text',
            x: (x0 + x1) / 2,
            y: y0 + 12,
            style: { text: '无数据', fill: palette.label, fontSize: 11, align: 'center', verticalAlign: 'middle' },
          },
        ],
      };
    },
  };
}

/**
 * 充值引线：在**像素空间**从余额阶跃点竖直向上画一小段。
 * markPoint 不支持 labelLine（写进 option 也不渲染），所以要一条真正落到阶跃点上的引线，
 * 只能用 custom series；renderItem 仍只返回单个图元（ECharts 6 返回数组会抛错，见「无数据」带）。
 * yAxisIndex 必须是 1：topup.value 是 USD，走右轴量程才能落在正确的高度。
 */
function trendTopupLeaderSeries(topup, palette) {
  return {
    type: 'custom',
    name: '充值引线',
    yAxisIndex: 1,
    silent: true,
    z: 5,
    clip: true,
    legendHoverLink: false,
    tooltip: { show: false },
    dimensions: ['x', 'y'],
    encode: { x: 0, y: 1 },
    data: [[topup.t, topup.value]],
    renderItem: (params, api) => {
      const xy = api.coord([api.value(0), api.value(1)]);
      return {
        type: 'line',
        shape: { x1: xy[0], y1: xy[1], x2: xy[0], y2: xy[1] - TREND_TOPUP_LEADER_PX },
        style: { stroke: palette.balance, lineWidth: 1, lineDash: [2, 2] },
      };
    },
  };
}

/** 提示框：同时列出三条序列 + 时间，并给数值带上单位（次 / USD）。 */
function trendTooltipFormatter(params) {
  const known = Object.values(TREND_SERIES_NAMES);
  // 只列三条数据序列：过滤掉「无数据」辅助 series 等任何非数据图元（批次 21f）。
  const rows = (Array.isArray(params) ? params : (params ? [params] : []))
    .filter((p) => p && known.indexOf(String(p.seriesName || '')) >= 0);
  if (rows.length === 0) return '';
  const head = trendDayClock(Array.isArray(rows[0].value) ? rows[0].value[0] : rows[0].axisValue);
  const lines = rows.map((p) => {
    const name = String(p.seriesName || '');
    const raw = Array.isArray(p.value) ? p.value[1] : p.value;
    const unit = name === TREND_SERIES_NAMES.balance ? 'USD' : '次';
    const value = unit === 'USD' ? trendUsdText(raw) : trendInt(raw);
    return (p.marker || '') + name + ' <b>' + value + '</b> ' + unit;
  });
  return head + '<br/>' + lines.join('<br/>');
}

/** 图表容器的 aria-label：说明区间与当前值（拿不到库时这段文本仍在）。 */
function trendAriaLabel(samples, capacity, range) {
  const list = Array.isArray(samples) ? samples : [];
  const title = trendTitle(list.length, capacity);
  const n = list.length;
  if (n < 2) return title + '。' + range + '，暂不足以绘制曲线。';
  const last = list[n - 1] || {};
  return title + '。' + range + '；最新请求数 ' + trendInt(trendNum(last.r))
    + ' 次、错误数 ' + trendInt(trendNum(last.e))
    + ' 次、可用余额 ' + trendUsdText(trendNum(last.m)) + ' USD。';
}

/**
 * 纯函数：样本 → ECharts option。不碰 DOM、不依赖 ECharts 运行时。
 *
 * @param {{samples?: Array, capacity?: number, theme?: object, reducedMotion?: boolean}} opts
 *   theme 是 readTrendTokens() 解析出的配色（键见 TREND_TOKEN_KEYS）；缺省按空色构造。
 * @returns {object} ECharts option（双 Y 轴 + time X 轴 + 三条序列）。
 *
 * 空态（样本 < 2）不画任何序列（绝不画假线），只给中性「数据不足」文字；
 * 全 0 序列不画面积填充（零值不拿最重的视觉权重）；错误数全 0 时整条线不出现，
 * 改由卡片上的「0 错误」徽章表达（批次 21c：零值不拿最重视觉权重）。
 * X 轴锚定在真实 24h 窗口上，未覆盖的左端留白（>=30 分钟再叠极淡「无数据」带）。
 */
function buildTrendOption({ samples, capacity, theme, reducedMotion } = {}) {
  const list = Array.isArray(samples) ? samples : [];
  const palette = trendPalette(theme);
  const coverage = trendCoverage(list, capacity);
  // 轴量程在序列构造前先用原始样本算好：min 恒 0，上限贴合数据（峰值 ×1.15 取整）。
  const countScale = trendAxisScale(
    list.map((s) => trendNum(s?.r)).concat(list.map((s) => trendNum(s?.e))),
    { integer: true },
  );
  const amountScale = trendAxisScale(list.map((s) => trendNum(s?.m)), {});

  const xAxis = {
    type: 'time',
    boundaryGap: false,
    // 有覆盖信息就把轴钉在真实窗口上：左侧未覆盖时段留白（另加极淡「无数据」带），
    // 而不是让曲线看似从坐标轴起点开始（批次 21c 第 8 条）。
    // 右端额外留白：给「现在」虚线 / 标签 / 行尾标注呼吸空间，不再像贴边被裁（批次 21f 第 6 条）。
    ...(coverage ? {
      min: coverage.xMin,
      max: coverage.xMax + Math.max(
        coverage.bucket * TREND_X_PAD_MIN_BUCKETS,
        (coverage.xMax - coverage.xMin) * TREND_X_PAD_RATIO,
      ),
    } : {}),
    axisLine: { lineStyle: { color: palette.axis } },
    axisTick: { show: false },
    axisLabel: {
      ...trendAxisLabel(palette.label),
      hideOverlap: true,
      formatter: (value) => trendClock(value),
    },
    // 纵向网格：虚线 + 低对比，有参考但不抢戏；透明度已编码进 --chart-grid 令牌，
    // 这里不再二次乘 opacity（否则以后调令牌会被这层削弱）。
    splitLine: { show: true, lineStyle: { color: palette.grid, type: 'dashed', width: 1 } },
    axisPointer: { label: { formatter: (p) => trendClock(p && p.value) } },
  };

  // 左轴 = 计数（次）：「请求数 / 错误数」共用；min: 0 保证零基准与零线可见。
  const countAxis = {
    type: 'value',
    name: TREND_UNIT_COUNT,
    position: 'left',
    nameGap: 10,
    // 轴名与「请求数」同色：一眼看出左轴读的是冷灰那条（批次 21f 第 2 条，仅此一种归属做法）。
    nameTextStyle: { color: palette.request, fontSize: TREND_AXIS_NAME_SIZE, fontWeight: 600, align: 'left' },
    min: 0,
    minInterval: 1,
    splitNumber: countScale.splitNumber,
    ...(countScale.max != null ? { max: countScale.max, interval: countScale.interval } : {}),
    axisLine: { show: true, lineStyle: { color: palette.axis } },
    axisTick: { show: false },
    axisLabel: { ...trendAxisLabel(palette.label), formatter: (v) => trendInt(v) },
    // 横向网格：用更淡一档的 --chart-grid-h 补上「只有竖线」的半成品感；
    // 颜色由令牌给定最终值，不叠 opacity。
    splitLine: { show: true, lineStyle: { color: palette.gridH || palette.grid, width: 1 } },
  };

  // 右轴 = 金额（USD）：单独一根，绝不和「次」共轴。右轴不画横向网格，避免双份网格线。
  const amountAxis = {
    type: 'value',
    name: TREND_UNIT_AMOUNT,
    position: 'right',
    nameGap: 10,
    // 轴名与「可用余额」同色：右轴读的是洋红那条。
    nameTextStyle: { color: palette.balance, fontSize: TREND_AXIS_NAME_SIZE, fontWeight: 600, align: 'right' },
    min: 0,
    splitNumber: amountScale.splitNumber,
    ...(amountScale.max != null ? { max: amountScale.max, interval: amountScale.interval } : {}),
    axisLine: { show: true, lineStyle: { color: palette.axis } },
    axisTick: { show: false },
    axisLabel: { ...trendAxisLabel(palette.label), formatter: (v) => trendUsdTick(v) },
    splitLine: { show: false },
  };

  const rangeText = trendRangeText(list, { bucketMs: trendBucketMsFromCapacity(capacity) });

  const base = {
    backgroundColor: 'transparent',
    // top 让出一整条独立图例行（图例不再压进绘图区右上）；right 给右轴名 / 行尾留呼吸。
    grid: { left: 4, right: 12, top: 46, bottom: 4, containLabel: true },
    xAxis,
    yAxis: [countAxis, amountAxis],
  };

  // 空态：样本 < 2 不画假线（series 为空），也不依赖 ECharts 的 graphic 组件（纯 DOM 呈现）。
  // 页面上可见的「数据不足」由 renderTrend 的 .trend-empty 承载；这里只保留无障碍描述。
  if (list.length < 2) {
    return {
      ...base,
      animation: false,
      legend: { show: false },
      tooltip: { show: false },
      series: [],
      aria: { enabled: true, label: { description: trendAriaLabel(list, capacity, rangeText) + '（数据不足）' } },
    };
  }

  const dense = list.length > TREND_DENSE_SAMPLES;   // 点数多：关 symbol + LTTB，消梳齿
  const reqData = trendSeriesData(list, 'r');
  const balData = trendSeriesData(list, 'm');
  const errValues = list.map((s) => trendNum(s?.e));
  const errZero = isAllZero(errValues);   // 全 0 → 整条序列不出现（见下）
  // 0 样本置 null：错误是零星事件，不该被连成一条贴 0 横贯全图的假线（批次 21f 第 5 条）。
  const errData = errValues.map((v, i) => [trendXOf(list[i], i), v > 0 ? v : null]);
  const reqZero = isAllZero(reqData.map((p) => p[1]));   // 全 0 → 不画面积（零值最轻）
  const balZero = isAllZero(balData.map((p) => p[1]));
  const topup = trendTopup(list);
  const showGap = !!(coverage && coverage.gapMs >= TREND_GAP_MIN_BUCKETS * coverage.bucket);
  const lastT = coverage ? coverage.lastT : trendXOf(list[list.length - 1], list.length - 1);

  // 请求数 / 余额：密集时降采样并隐藏数据点；稀疏时给 2px 小圆点。
  const reqPoints = dense
    ? { showSymbol: false, symbol: 'none', sampling: 'lttb' }
    : { showSymbol: true, symbol: 'circle', symbolSize: 2 };
  const balPoints = { showSymbol: false, symbol: 'none' };

  const series = [];

  // 请求数：低饱和冷色中性 —— 1px、0.7 透明度、极淡面积，信息量大但退到背景。
  const reqSeries = {
    name: TREND_SERIES_NAMES.request,
    type: 'line',
    yAxisIndex: 0,
    data: reqData,
    smooth: 0.25,
    lineStyle: { width: TREND_REQUEST_LINE_WIDTH, color: palette.request, opacity: TREND_REQUEST_LINE_OPACITY },
    itemStyle: { color: palette.request, opacity: TREND_REQUEST_LINE_OPACITY },
    emphasis: { focus: 'series', lineStyle: { width: 2, opacity: 1 } },
    ...reqPoints,
    ...(reqZero ? {} : { areaStyle: trendAreaStyle(palette.request, TREND_REQUEST_AREA_OPACITY) }),
    z: 1,
  };
  series.push(reqSeries);

  // 错误数：语义红 + 1px 细虚线；只在真出过错误时才出现（全 0 不画贴底实线）。
  if (!errZero) {
    series.push({
      name: TREND_SERIES_NAMES.error,
      type: 'line',
      yAxisIndex: 0,
      data: errData,
      symbol: 'circle',
      showSymbol: true,
      connectNulls: false,
      symbolSize: (value) => (trendNum(Array.isArray(value) ? value[1] : value) > 0 ? TREND_SYMBOL_SIZE : 0),
      lineStyle: { width: TREND_ERROR_LINE_WIDTH, color: palette.error, type: 'dashed' },
      itemStyle: { color: palette.error },
      emphasis: { focus: 'series', lineStyle: { width: 2 } },
      z: 3,
    });
  }

  // 可用余额：品牌洋红主角，2px + 更强的渐变面积；step 阶跃（充值跳变），右轴 USD。
  series.push({
    name: TREND_SERIES_NAMES.balance,
    type: 'line',
    yAxisIndex: 1,
    data: balData,
    step: 'end',
    lineStyle: { width: TREND_BALANCE_LINE_WIDTH, color: palette.balance },
    itemStyle: { color: palette.balance },
    emphasis: { focus: 'series' },
    ...balPoints,
    ...(balZero ? {} : { areaStyle: trendAreaStyle(palette.balance, TREND_BALANCE_AREA_OPACITY) }),
    // 「现在」终止标记：数据末端一条安静虚线，给时间轴一个锚点。
    // 亮度降到网格级（--chart-now，不再用偏亮的 --chart-cursor）；标签强制横排（rotate: 0，
    // 否则 markLine 会沿竖线把文字转 90°），字号与图例一致，位置贴绘图区顶部内侧。
    markLine: {
      silent: true,
      symbol: 'none',
      animation: false,
      lineStyle: { color: palette.now || palette.grid, type: 'dashed', width: 1 },
      label: {
        show: true, position: 'insideEndTop', rotate: 0,
        formatter: '现在', color: palette.tooltipText || palette.label,
        fontSize: TREND_LEGEND_FONT_SIZE, fontWeight: 600,
      },
      data: [{ xAxis: lastT }],
    },
    // 充值标注：最大的一次余额上升 = 实心圆点 + 低调 chip「HH:mm 充值 +X USD」。
    // 竖直短引线由 trendTopupLeaderSeries 画（markPoint 没有 labelLine）。
    // chip 用卡片一致的底色，避免文字直接压在洋红曲线上读不清；不做高亮胶囊，不抢数据线。
    ...(topup ? { markPoint: {
      symbol: 'circle',
      symbolSize: 7,
      itemStyle: { color: palette.balance, borderColor: palette.tooltipBg, borderWidth: 2 },
      label: {
        show: true, position: 'top', distance: TREND_TOPUP_LABEL_DISTANCE,
        color: palette.balance, fontSize: 11, fontWeight: 600,
        backgroundColor: palette.tooltipBg,
        borderColor: palette.tooltipBorder,
        borderWidth: 1,
        borderRadius: TREND_TOPUP_CHIP_RADIUS,
        padding: [3, 6],
        formatter: trendTopupText(topup),
      },
      data: [{ coord: [topup.t, topup.value] }],
    } } : {}),
    z: 4,
  });

  // 左端未覆盖时段：极淡色带 + 「无数据」，让人一眼看出数据从哪开始（右端圆角，不再硬切）。
  // 追加在末尾、z:0：不改变前三条数据序列的下标，只垫在它们下面。
  if (showGap) series.push(trendGapSeries(coverage, palette));
  // 充值引线：像素空间的一小段竖线，把 chip 锚回余额阶跃点（z:5 只压过数据线，不与 chip 重叠）。
  if (topup) series.push(trendTopupLeaderSeries(topup, palette));

  // 图例只列真正画出来的序列（错误全 0 时不该有一条幽灵图例）。
  // 序列名走页面正文字号 + 主文字对比度令牌（不再是 11px 浅灰），序列靠放大的彩色圆点区分。
  const legendData = [TREND_SERIES_NAMES.request];
  if (!errZero) legendData.push(TREND_SERIES_NAMES.error);
  legendData.push(TREND_SERIES_NAMES.balance);

  const option = {
    ...base,
    animation: !reducedMotion,
    color: [palette.request, palette.error, palette.balance],
    legend: {
      show: true,
      type: 'plain',
      // 一行放得下：图例项 = 纯序列名（单位在轴名上），三项永远同一行、基线对齐；
      // 极窄屏（容器 <= ~220px）放不下会整块换行，此时整体居中 + itemGap 等距，
      // 不会出现「第三项单独一行还右对齐」的参差感（实测 right:0 会把孤儿项甩到最右）。
      orient: 'horizontal',
      top: 0,
      left: 'center',
      icon: 'circle',
      itemWidth: TREND_LEGEND_ITEM,
      itemHeight: TREND_LEGEND_ITEM,
      itemGap: TREND_LEGEND_GAP,
      textStyle: { color: palette.tooltipText || palette.label, fontSize: TREND_LEGEND_FONT_SIZE, fontWeight: 600 },
      inactiveColor: palette.grid,
      data: legendData,
    },
    tooltip: {
      trigger: 'axis',
      backgroundColor: palette.tooltipBg,
      borderColor: palette.tooltipBorder,
      borderWidth: 1,
      padding: [8, 10],
      textStyle: { color: palette.tooltipText, fontSize: 12 },
      axisPointer: { type: 'line', lineStyle: { color: palette.cursor, width: 1, type: 'dashed' } },
      extraCssText: 'border-radius:10px;',
      formatter: trendTooltipFormatter,
    },
    series,
    aria: {
      enabled: true,
      label: { description: trendAriaLabel(list, capacity, rangeText) },
    },
  };
  return option;
}

// ── 懒加载 + 挂载 ────────────────────────────────────────────────────

let trendChart = null;            // 当前 ECharts 实例（拿不到库时为 null）
let trendEChartsPromise = null;   // 懒加载去重
let trendSnapshot = null;         // 最近一次数据（主题切换时重刷 option）
let trendListenersBound = false;

/**
 * 懒加载 vendor 里的 ECharts：只在趋势第一次真正渲染时插入 <script>。
 * 已经加载过（globalThis.echarts 在）就直接返回；测试环境没有 document → 返回 null。
 * @returns {Promise<object|null>}
 */
function ensureTrendECharts() {
  if (typeof globalThis !== 'undefined' && globalThis.echarts) return Promise.resolve(globalThis.echarts);
  if (trendEChartsPromise) return trendEChartsPromise;
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') {
    return Promise.resolve(null);
  }
  const load = new Promise((resolve) => {
    let settled = false;
    const done = (lib) => { if (!settled) { settled = true; resolve(lib || null); } };
    let script = null;
    try { script = document.createElement('script'); } catch { return done(null); }
    if (!script || typeof script !== 'object') return done(null);
    script.src = TREND_ECHARTS_SRC;
    script.async = true;
    script.onload = () => done(typeof globalThis !== 'undefined' ? globalThis.echarts : null);
    script.onerror = () => done(null);
    const parent = (typeof document !== 'undefined' && (document.head || document.body || document.documentElement)) || null;
    if (!parent || typeof parent.appendChild !== 'function') return done(null);
    try { parent.appendChild(script); } catch { return done(null); }
  });
  // 失败不永久缓存：resolve 成 null 时把缓存清掉，下一次渲染可以重新插 <script>。
  // 一次性网络抖动 / 短暂 404 不该让图在整个页面生命周期里再也出不来。
  trendEChartsPromise = load.then((lib) => {
    if (!lib) trendEChartsPromise = null;
    return lib;
  });
  return trendEChartsPromise;
}

/**
 * 用已就绪的 ECharts 初始化 / 重绘容器。拿不到库、拿到空元素或初始化抛错都返回 false，
 * 由调用方退回文本摘要 —— 绝不把异常抛给主面板。测试环境（无 echarts）恒返回 false。
 */
function mountTrendChart(el, option) {
  const lib = typeof globalThis !== 'undefined' ? globalThis.echarts : null;
  if (!lib || typeof lib.init !== 'function' || !el) return false;
  try {
    if (trendChart && typeof trendChart.dispose === 'function') trendChart.dispose();
    trendChart = lib.init(el);
    if (!trendChart || typeof trendChart.setOption !== 'function') { trendChart = null; return false; }
    trendChart.setOption(option);
    bindTrendChartListeners();
    return true;
  } catch {
    // setOption 抛错（例如 option 里有 ECharts 不接受的图元）：把刚 init 出来的
    // 半挂载实例 dispose 掉，别让 `_echarts_instance_` + 空 canvas 留在 DOM 里，
    // 否则页面上会看到「隐藏但仍有实例」的矛盾状态（批次 21h）。
    try { if (trendChart && typeof trendChart.dispose === 'function') trendChart.dispose(); } catch { /* 忽略 */ }
    trendChart = null;
    return false;
  }
}

/** 窗口 resize → chart.resize()。垫片里没有真实布局也不报错（resize 自身吞异常）。 */
function resizeTrendChart() {
  try {
    if (trendChart && typeof trendChart.resize === 'function') trendChart.resize();
  } catch { /* 忽略 */ }
}

/** 主题 / reduced-motion 变化：按最新令牌重刷 option（颜色从 CSS 变量重读）。 */
function refreshTrendChart() {
  if (!trendChart || !trendSnapshot || typeof trendChart.setOption !== 'function') return;
  const option = buildTrendOption({
    samples: trendSnapshot.samples,
    capacity: trendSnapshot.capacity,
    theme: readTrendTokens(),
    reducedMotion: trendReducedMotion(),
  });
  try { trendChart.setOption(option, true); } catch { /* 忽略 */ }
}

function bindTrendChartListeners() {
  if (trendListenersBound) return;
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
  trendListenersBound = true;
  window.addEventListener('resize', resizeTrendChart);
  if (typeof MutationObserver === 'function' && typeof document !== 'undefined' && document.documentElement) {
    try {
      new MutationObserver(refreshTrendChart).observe(document.documentElement, {
        attributes: true, attributeFilter: ['data-theme'],
      });
    } catch { /* 忽略：观察不到主题变化也不影响功能 */ }
  }
  try {
    if (typeof window.matchMedia === 'function') {
      const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
      if (mq && typeof mq.addEventListener === 'function') mq.addEventListener('change', refreshTrendChart);
    }
  } catch { /* 忽略 */ }
}

/**
 * 把「图表容器 / 降级说明」的可见性**一次性对齐**到同一状态（幂等）：
 *   visible=true  → 图表显示、说明隐藏（挂载成功）
 *   visible=false → 图表隐藏、说明显示（拿不到库 / 挂载失败）
 * 每条渲染路径（同步成功 / 同步失败 / 异步成功 / 异步失败）都必须调用它，
 * 而不是只在失败分支里设 —— 否则一次失败会把图永久钉在失败态（线上 21g）。
 * `el.hidden = bool` 会同步增删 hidden 属性，所以测试断言的是属性，不只是 style。
 */
function setTrendChartVisible(host, visible) {
  if (!host || typeof host.querySelector !== 'function') return;
  const show = !!visible;
  try {
    const chart = host.querySelector('.trend-chart');
    if (chart) chart.hidden = !show;
    const note = host.querySelector('.trend-fallback');
    if (note) note.hidden = show;
  } catch { /* 忽略：可见性对齐失败也不影响文本摘要 */ }
}

/** 拿不到 ECharts：藏掉空图容器、亮出说明，文本摘要继续可用。 */
function markTrendFallback(host) {
  setTrendChartVisible(host, false);
}

// ── DOM 渲染 ─────────────────────────────────────────────────────────

/**
 * 标题区：第一行「标题 + 徽章」，第二行副标题写明覆盖区间 / 样本数。
 * 副标题与页面其它副标题同字号同色（不再小一号、也不靠全角空格硬拼）；
 * 错误数为 0 时给一个低调的「0 错误」正向徽章，替掉那条贴底实线。
 */
function trendHeadHtml(samples, capacity, range) {
  const list = Array.isArray(samples) ? samples : [];
  const n = list.length;
  const cap = Number(capacity) > 0 ? Math.round(Number(capacity)) : TREND_FULL_WINDOW_SAMPLES;
  const collecting = n < cap;
  const errZero = n >= 2 && isAllZero(list.map((s) => trendNum(s?.e)));
  return '<div class="trend-head">'
    + '<div class="trend-head-row">'
    + '<span class="trend-heading">'
    + '<span class="trend-title">近 24 小时趋势</span>'
    + (collecting ? '<span class="trend-pill">数据收集中 ' + esc(n + '/' + cap) + '</span>' : '')
    + (errZero ? '<span class="trend-pill trend-pill-ok">0 错误</span>' : '')
    + '</span>'
    + '</div>'
    + '<p class="trend-sub">' + esc(range) + '</p>'
    + '</div>';
}

function trendStatHtml(label, value, unit, dotClass) {
  return '<span class="trend-stat">'
    + (dotClass ? '<span class="trend-dot ' + dotClass + '" aria-hidden="true"></span>' : '')
    + '<span class="trend-stat-label">' + esc(label) + '</span>'
    + '<b class="trend-stat-value">' + esc(value) + '</b>'
    + '<span class="trend-stat-unit">' + esc(unit) + '</span>'
    + '</span>';
}

/**
 * 文本摘要（图表之外的等价信息；拿不到库时就是唯一载体，绝不为空）。
 * 每个读数前带一枚与线色一致的小色点（不再是无颜色脚注）；余额口径写明是
 * 「最新样本」，避免和顶部卡片「剩余额度」看起来互相矛盾（批次 21c 第 7 条）。
 */
function trendSummaryHtml(samples) {
  const list = Array.isArray(samples) ? samples : [];
  const last = list.length ? list[list.length - 1] : null;
  const r = last ? trendInt(trendNum(last.r)) : '—';
  const e = last ? trendInt(trendNum(last.e)) : '—';
  const m = last ? trendUsdText(trendNum(last.m)) : '—';
  const errZero = list.length >= 2 && isAllZero(list.map((s) => trendNum(s?.e)));
  return '<div class="trend-summary">'
    + trendStatHtml('请求数', r, '次', 'trend-dot-request')
    + trendStatHtml('错误数', e, '次', errZero ? 'trend-dot-error is-zero' : 'trend-dot-error')
    + trendStatHtml('最新样本', m, 'USD', 'trend-dot-balance')
    + '</div>';
}

/**
 * 渲染趋势区。步骤：
 *   1. 纯函数算出 option（空态也不画假线，见 buildTrendOption）；
 *   2. 一次性写入「标题行 + 图容器(role=img) + 失败说明 + 文本摘要」；
 *   3. 有 ECharts 就直接挂载，没有就懒加载后再挂；失败退回文本摘要。
 * samples 为空 / 字段缺失都不能抛。
 */
function renderTrend(data) {
  const host = $('trend');
  if (!host) return;
  const samples = Array.isArray(data?.samples) ? data.samples : [];
  const capacity = trendCapacity(data);
  const range = trendRangeText(samples, data);
  const ariaLabel = trendAriaLabel(samples, capacity, range);
  const option = buildTrendOption({
    samples,
    capacity,
    theme: readTrendTokens(),
    reducedMotion: trendReducedMotion(),
  });

  if (trendChart && typeof trendChart.dispose === 'function') {
    try { trendChart.dispose(); } catch { /* 忽略 */ }
  }
  trendChart = null;
  trendSnapshot = { samples, capacity };

  // 样本 < 2：不建图容器、也不为一张空图去拉库，只给中性「数据不足」态（绝不画假线）
  const insufficient = samples.length < 2;
  const plot = insufficient
    ? '<div class="trend-empty" role="img" aria-label="' + esc(ariaLabel) + '">数据不足，等待更多样本</div>'
    : '<div class="trend-chart" role="img" aria-label="' + esc(ariaLabel) + '"></div>';
  host.innerHTML = trendHeadHtml(samples, capacity, range)
    + plot
    + '<p class="trend-fallback" hidden>图表库加载失败，已改用文本摘要。</p>'
    + trendSummaryHtml(samples);

  if (insufficient) return;

  const el = typeof host.querySelector === 'function' ? host.querySelector('.trend-chart') : null;
  // 新 DOM 默认图表可见；显式对齐一次，即使容器节点跨渲染复用也能纠正残留的 hidden。
  setTrendChartVisible(host, true);
  if (typeof globalThis !== 'undefined' && globalThis.echarts) {
    // 成功 → 再对齐一次（幂等）；失败 → 隐藏图表、亮出说明。
    setTrendChartVisible(host, mountTrendChart(el, option));
    return;
  }
  ensureTrendECharts()
    .then((lib) => {
      if (!lib) { setTrendChartVisible(host, false); return; }
      const current = typeof host.querySelector === 'function' ? host.querySelector('.trend-chart') : null;
      if (current !== el) return;   // 期间又渲染过：这次结果作废，别把旧 option 画到新容器
      setTrendChartVisible(host, mountTrendChart(el, option));
    })
    .catch(() => {
      // 只有当前容器还是本次渲染的那个时才收回可见性（别遮住期间新渲染出来的图）。
      const current = typeof host.querySelector === 'function' ? host.querySelector('.trend-chart') : null;
      if (current === el) setTrendChartVisible(host, false);
    });
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
