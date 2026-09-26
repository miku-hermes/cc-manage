// 批次 25 A + B：/trend 的信息层次（A1–A7）与浅/深两套主题的图表对比度（B）。
//
// 断言全部走纯函数 / DOM 垫片 / CSS 令牌解析，不碰浏览器：
//   - A7-1/2/3：把 renderTrend 写进 #trend / #trend-stats 的 innerHTML 拆开逐项校验；
//     统计卡数值用固定输入 → 期望输出（trendStats 纯函数），改错公式必红。
//   - B：从 panel.css 解析 --chart-* 令牌与 daisyUI 主题的 --color-base-100（oklch），
//     自己做 sRGB/相对亮度/对比度换算；两套主题都断言序列 ≥3:1、轴标签/图例文字 ≥4.5:1。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const TREND_JS = fs.readFileSync(new URL('../panel/public/js/render-trend.js', import.meta.url), 'utf8');
const PANEL_CSS = fs.readFileSync(new URL('../panel/src/styles/panel.css', import.meta.url), 'utf8');

function pureContext(extra = {}) {
  const context = vm.createContext({ Number, Math, Array, JSON, Object, String, Boolean, isNaN, RegExp, Date, Promise, ...extra });
  vm.runInContext(TREND_JS, context, { filename: 'render-trend.js' });
  return context;
}

const T0 = 1_700_000_000_000;
const BUCKET_MS = 5 * 60 * 1000;
// 固定输入：25 个 5 分钟桶（覆盖 2 小时）。r 恒 10、每 10 桶 1 个错误、余额每桶降 1。
// 于是 24h 视图 = 25 桶，1h 视图 = 尾 13 桶 —— 期望值全部可手算。
const mk = (n) => Array.from({ length: n }, (_, i) => ({
  t: T0 + i * BUCKET_MS, r: 10, e: i % 10 === 0 ? 1 : 0, m: 100 - i,
}));

// 把 innerHTML 按 class 拆成「块」：split 后每段含到下一个同类块为止，便于逐项断言。
function blocks(html, cls) {
  return html.split('class="' + cls).slice(1).map((chunk) => chunk.split('class="' + cls)[0]);
}

// ── A7-1：底部摘要每一项都带明确时间口径 / 时间戳 ───────────────────
test('B25-A7-1：底部摘要每项都带时间口径或时间戳，不再是会被误读成 24h 总量的裸读数', () => {
  const host = { innerHTML: '' };
  const context = pureContext({ $: (id) => (id === 'trend' ? host : null), esc: (v) => String(v == null ? '' : v), num: String, money: String });
  context.renderTrend({ bucketMs: BUCKET_MS, samples: mk(25) });

  const stats = blocks(host.innerHTML, 'trend-stat ');
  assert.equal(stats.length, 3, '摘要三项读数');
  for (const block of stats) {
    assert.match(block, /近 \d+ 小时|最近 5 分钟|\d\d:\d\d/,
      '每一项都必须带时间口径（近 N 小时 / 最近 5 分钟）或 HH:mm 时间戳：' + block);
  }
  // 具体口径：请求/错误写「近 24 小时」；余额写「最新样本 HH:mm」。
  assert.match(stats[0], /近 24 小时请求/, '请求项口径 = 近 24 小时');
  assert.match(stats[1], /近 24 小时错误/, '错误项口径 = 近 24 小时');
  assert.match(stats[2], /最新样本 \d\d:\d\d · 余额/, '余额项带时间戳');
  // 旧缺陷：只写「请求数 0 次」这种无口径裸读数 —— 必须不存在。
  assert.doesNotMatch(host.innerHTML, />请求数</, '不出现无口径的「请求数」标签');
});

// ── A7-2：图例只出现一处，且不留「图例有、图上没有」的幽灵序列 ──────
test('B25-A7-2：图例只在顶部出现一处；错误全 0 时图例隐藏它并由摘要说明', () => {
  const host = { innerHTML: '' };
  const context = pureContext({ $: (id) => (id === 'trend' ? host : null), esc: (v) => String(v == null ? '' : v), num: String, money: String });
  context.renderTrend({ bucketMs: BUCKET_MS, samples: mk(25) });

  // ① 图例唯一来源 = 顶部 ECharts canvas 图例；底部摘要不再重复画色点 / 序列名标签。
  assert.equal((host.innerHTML.match(/trend-dot/g) || []).length, 0, '底部摘要不再重复图例色点');
  // 图表容器有一段 role=img 的 aria-label（无障碍描述，会顺带念出序列名），它不是图例标签节点；
  // 去掉属性文本后，DOM 里不应再有任何「请求数 / 错误数 / 可用余额」序列名。
  const noAria = host.innerHTML.replace(/aria-label="[^"]*"/g, '');
  for (const name of ['请求数', '错误数', '可用余额']) {
    assert.equal((noAria.match(new RegExp(name, 'g')) || []).length, 0,
      '除 aria-label 描述外，DOM 里不应再有 ' + name + ' 的图例标签节点（图例只在顶部出现一次）');
  }
  // ② option 里的图例只有一处、且序列名不重复。
  const opt = context.buildTrendOption({ samples: mk(25), capacity: 288, theme: null, reducedMotion: true });
  const data = [...opt.legend.data];
  assert.equal(new Set(data).size, data.length, '图例序列名不重复');
  assert.deepEqual(data, ['请求数', '错误数', '可用余额'], '有错误时三条序列都在图例里');

  // ③ 错误全 0：图例隐藏「错误数」，摘要明说「本时段无错误」——不再承诺一条不存在的红序列。
  const zero = Array.from({ length: 8 }, (_, i) => ({ t: T0 + i * BUCKET_MS, r: 3, e: 0, m: 1 }));
  const zeroOpt = context.buildTrendOption({ samples: zero, capacity: 288, theme: null, reducedMotion: true });
  assert.ok(!zeroOpt.legend.data.includes('错误数'), '错误全 0 时图例不列「错误数」（无可画的东西）');
  host.innerHTML = '';
  context.renderTrend({ bucketMs: BUCKET_MS, samples: zero });
  assert.match(host.innerHTML, /本时段无错误/, '摘要写明「本时段无错误」，解释图例为什么没有它');
});

// ── A6：时间范围切换 / 刷新按钮 —— 统计卡与图同步更新（复用现有接口，无新后端）──
test('B25-A6：1h/24h 切换后统计卡与图同步更新；刷新复用 loadTrend', async () => {
  const host = { innerHTML: '' };
  const stats = { innerHTML: '' };
  const calls = [];
  const apiFetch = async (url) => {
    calls.push(url);
    if (url.includes('history')) return { ok: true, status: 200, json: async () => ({ bucketMs: BUCKET_MS, samples: mk(25) }) };
    return { ok: true, status: 200, json: async () => ({ accounts: [{ lastQuota: { remaining: 24 }, exhausted: null }] }) };
  };
  const context = pureContext({
    $: (id) => (id === 'trend' ? host : (id === 'trend-stats' ? stats : null)),
    esc: (v) => String(v == null ? '' : v), num: String, money: String, apiFetch,
  });

  const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  await context.loadTrend();
  assert.equal(calls.length, 2, '首屏只打 /api/history 与 /api/status（不新增接口）');
  assert.match(text(stats.innerHTML), /近 24 小时请求总数 250/, '默认 24h 统计卡：请求 250 次');
  assert.match(text(host.innerHTML), /近 24 小时请求 250 次/, '图的摘要同步 24h');

  context.setTrendRange('1h');
  assert.match(text(stats.innerHTML), /近 1 小时请求总数 130/, '切到 1h 后统计卡跟着变：请求 130 次');
  assert.doesNotMatch(text(stats.innerHTML), /近 24 小时请求总数/, '旧的 24h 口径不再残留');
  assert.match(text(host.innerHTML), /近 1 小时请求 130 次/, '图的摘要同步 1h');
  assert.equal(calls.length, 2, '切换范围只重渲染，不重新请求');

  await context.refreshTrend();
  assert.equal(calls.length, 4, '刷新按钮复用 loadTrend（重新打两个接口）');
});

test('B25-A6-结构：/trend 有面包屑、范围 tabs、刷新按钮，且接线到 setTrendRange / refreshTrend', () => {
  const page = fs.readFileSync(new URL('../panel/src/pages/trend.astro', import.meta.url), 'utf8');
  assert.match(page, /breadcrumbs/, '有面包屑表明当前在趋势页');
  assert.match(page, /id="trend-range"/, '有时间范围切换容器');
  assert.match(page, /data-range="1h"/, '有 1h 选项');
  assert.match(page, /data-range="24h"/, '有 24h 选项');
  assert.match(page, /id="trend-refresh"/, '有刷新按钮');
  assert.match(page, /id="trend-stats"/, '有统计卡容器');
  assert.match(page, /setTrendRange\(rangeBtn\.getAttribute\('data-range'\)\)/, 'tab 点击 → setTrendRange');
  assert.match(page, /refreshTrend\(\)/, '刷新点击 → refreshTrend');
  // 内容列与顶栏 logo 左边界对齐：两处同一 max-w + px-4 容器。
  const header = fs.readFileSync(new URL('../panel/src/components/SiteHeader.astro', import.meta.url), 'utf8');
  assert.match(header, /navbar-row mx-auto flex w-full max-w-6xl items-center px-4 2xl:max-w-\[1600px\]/,
    '顶栏内容与 main 共用同一 max-w-6xl + px-4 容器（logo 左边界 = 内容列左边界）');
  assert.match(page, /<main class="[^"]*max-w-6xl[^"]*px-4[^"]*">/,
    'main 与顶栏使用相同 max-w + 水平内边距');
});

// ── A7-3：4 张统计卡的数值全部由历史 / 状态数据算出（固定输入 → 期望输出）──
test('B25-A7-3：trendStats 纯函数对固定输入给出确定输出（24h / 1h 两套口径）', () => {
  const context = pureContext();
  const all = mk(25);

  const d24 = context.trendStats(all, '24h', 24);
  assert.equal(d24.count, 25, '24h 视图保留全部 25 桶');
  assert.equal(d24.requests, 250, '请求总数 = 25 × 10');
  assert.equal(d24.errors, 3, '错误数 = 3（i=0/10/20）');
  assert.equal(d24.errorRate, 1.2, '错误率 = 3/250×100 = 1.2%');
  assert.equal(d24.consumed, 24, '消耗 = 逐桶下降量之和 = 24');
  assert.equal(d24.coveredHours, 2, '覆盖时长 = (25-1)×5min = 2 小时');
  assert.equal(d24.ratePerHour, 12, '平均消耗速率 = 24 / 2 = 12 USD/小时');
  assert.equal(d24.estimateHours, 2, '按此速率 24 USD 可用 2 小时');
  assert.equal(d24.rangeLabel, '近 24 小时');
  assert.equal(d24.errZero, false);
  assert.equal(d24.latestBucket.m, 76, '最新桶余额 = 100-24');

  const d1 = context.trendStats(all, '1h', 24);
  assert.equal(d1.count, 13, '1h 视图保留尾 13 桶（t ≥ 末点-1h）');
  assert.equal(d1.requests, 130, '1h 请求 = 13 × 10');
  assert.equal(d1.errors, 1, '1h 只含 i=20 这一个错误');
  assert.equal(Number(d1.errorRate.toFixed(2)), 0.77, '1h 错误率 ≈ 0.77%');
  assert.equal(d1.coveredHours, 1, '覆盖时长 = 1 小时');
  assert.equal(d1.ratePerHour, 12, '速率与窗口无关');
  assert.equal(d1.rangeLabel, '近 1 小时');

  // 满窗覆盖才说「按近 24 小时均值」，否则如实说覆盖了多少（避免被读成预测）。
  const full = mk(289); // (289-1)×5min = 24 小时
  assert.equal(context.trendStats(full, '24h', 12).coveredHours, 24, '289 桶正好覆盖 24 小时');
  assert.equal(context.trendRateLabel(context.trendStats(full, '24h', 12)), '按近 24 小时均值 · 非预测');
  assert.equal(context.trendRateLabel(d24), '按已覆盖 2 小时均值 · 非预测');
  assert.equal(context.trendRateLabel(context.trendStats([{ t: T0, r: 1, e: 0, m: 5 }], '24h', 5)), '样本不足，暂不可算');
});

test('B25-A7-3b：统计卡 HTML —— 4 张卡、第④项写明「非预测」、预计时长显式标「估算」', () => {
  const context = pureContext({ esc: (v) => String(v == null ? '' : v) });
  const stats = context.trendStats(mk(289), '24h', 12);
  const html = context.trendStatsHtml(stats);
  assert.match(fs.readFileSync(new URL('../panel/src/pages/trend.astro', import.meta.url), 'utf8'), /id="trend-stats"/, '统计卡容器存在');
  assert.match(html, /近 24 小时请求总数/, '① 请求总数');
  assert.match(html, /近 24 小时错误数/, '② 错误数（含错误率）');
  assert.match(html, /当前可用余额/, '③ 当前可用余额');
  assert.match(html, /平均消耗速率/, '④ 平均消耗速率');
  assert.match(html, /按近 24 小时均值 · 非预测/, '速率口径写明时段 + 非预测');
  assert.match(html, /预计可用约 1 小时（估算）/, '预计可用时长显式标注「估算」');
  const negativeExample = html.replace('（估算）', '');
  assert.doesNotMatch(negativeExample, /估算/, '负例：删掉「估算」后语义断言必然失败');

  // 余额缺快照时：显示 —，且不硬编一个预计时长。
  const noBal = context.trendStats(mk(25), '24h', null);
  assert.equal(noBal.balance, null);
  assert.equal(noBal.estimateHours, null);
  const html2 = context.trendStatsHtml(noBal);
  assert.ok(!/估算/.test(html2), '没有余额时不给预计时长');
  assert.match(html2, /当前可用余额[\s\S]{0,120}?—/, '余额缺失显示 —');
});

// ── 变异鉴别力：统计卡数值对公式敏感（改坏「消耗」口径立即不等）──
test('B25-A7-4：trendStats 消耗口径 = 相邻桶下降量之和（充值跃升不算负消耗）', () => {
  const context = pureContext();
  // m = 10,9,8,4,14,13：最后一段的 +10（充值）不能被算成 -10 消耗。
  const s = [
    { t: T0, r: 1, e: 0, m: 10 },
    { t: T0 + BUCKET_MS, r: 1, e: 0, m: 9 },
    { t: T0 + 2 * BUCKET_MS, r: 1, e: 0, m: 8 },
    { t: T0 + 3 * BUCKET_MS, r: 1, e: 0, m: 4 },
    { t: T0 + 4 * BUCKET_MS, r: 1, e: 0, m: 14 },
    { t: T0 + 5 * BUCKET_MS, r: 1, e: 0, m: 13 },
  ];
  const st = context.trendStats(s, '24h', 13);
  assert.equal(st.consumed, 7, '消耗 = 1+1+4+1 = 7（充值 +10 不计入，也不成为负消耗）');
  assert.equal(st.coveredHours, 0.4166666666666667, '覆盖 = 5×5min');
  assert.equal(Number(st.ratePerHour.toFixed(2)), 16.8, '速率 = 7 / (25/60) = 16.8 USD/小时');
  // 请求/错误口径同样可鉴别：把 r 求和改成「取最后一个样本」会立刻不等。
  assert.equal(st.requests, 6, '请求 = 6 桶求和（不是末值 1）');
  assert.equal(st.errors, 0, '全 0 错误');
  assert.equal(st.errZero, true, '全 0 错误 → errZero 为真（供摘要/图例隐藏用）');
});

// ══════════════════════════════════════════════════════════════════════
// B：浅/深两套主题的图表对比度 —— 按令牌值自己算 WCAG 对比度
// ══════════════════════════════════════════════════════════════════════
// 卡片背景 = daisyUI 主题的 --color-base-100（oklch），把它转成 sRGB 后再算对比度。
function srgbToLin(c) { const v = c / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }
function linToSrgb(c) { return c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055; }
/** oklch(L C H)（L/C 为 0..1 / 任意，H 为度）→ sRGB 0..255。 */
function oklchToRgb(L, C, H) {
  const hr = (H * Math.PI) / 180;
  const a = C * Math.cos(hr); const b = C * Math.sin(hr);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
  const l = l_ ** 3; const m = m_ ** 3; const s = s_ ** 3;
  const r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const bl = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;
  return [r, g, bl].map((v) => Math.round(Math.max(0, Math.min(1, linToSrgb(v))) * 255));
}
function relLum(rgb) { const [r, g, b] = rgb.map(srgbToLin); return 0.2126 * r + 0.7152 * g + 0.0722 * b; }
function contrast(a, b) {
  const la = relLum(a); const lb = relLum(b);
  const hi = Math.max(la, lb); const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}
function parseColor(text) {
  const s = String(text).trim();
  let m = /^#([0-9a-fA-F]{6})$/.exec(s);
  if (m) return { rgb: [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)), a: 1 };
  m = /^rgba?\(([^)]+)\)$/.exec(s);
  if (m) {
    const p = m[1].split(',').map((x) => parseFloat(x));
    return { rgb: p.slice(0, 3), a: p.length > 3 ? p[3] : 1 };
  }
  throw new Error('无法解析颜色：' + s);
}
const compositeOver = (fg, bgRgb) => fg.rgb.map((c, i) => c * fg.a + bgRgb[i] * (1 - fg.a));
/** 取 @layer base 里 :root 浅色块 / :root[data-theme="dark"] 深色块。 */
function tokenBlocks() {
  const darkAt = PANEL_CSS.indexOf(':root[data-theme="dark"]');
  assert.ok(darkAt > 0, 'panel.css 必须有深色令牌块');
  const lightAt = PANEL_CSS.lastIndexOf(':root {', darkAt);
  const lightBlock = PANEL_CSS.slice(lightAt, darkAt);
  const darkOpen = PANEL_CSS.indexOf('{', darkAt);
  let depth = 0;
  let darkEnd = darkOpen;
  for (; darkEnd < PANEL_CSS.length; darkEnd += 1) {
    if (PANEL_CSS[darkEnd] === '{') depth += 1;
    else if (PANEL_CSS[darkEnd] === '}' && --depth === 0) break;
  }
  const darkBlock = PANEL_CSS.slice(darkAt, darkEnd + 1);
  const grab = (block, name) => {
    const noComments = block.replace(/\/\*[\s\S]*?\*\//g, '');
    const m = new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*:\\s*([^;]+);').exec(noComments);
    return m ? m[1].trim() : null;
  };
  return { grab, lightBlock, darkBlock };
}
/** daisyUI 主题里 --color-base-100（oklch）→ 卡片背景 sRGB。 */
function base100Rgb(themeName) {
  const at = PANEL_CSS.indexOf('name: "' + themeName + '"');
  assert.ok(at > 0, '找不到 daisyUI 主题 ' + themeName);
  const m = /--color-base-100:\s*oklch\(\s*([\d.]+)%\s+([\d.]+)\s+([\d.]+)\s*\)/.exec(PANEL_CSS.slice(at));
  assert.ok(m, themeName + ' 主题必须有 --color-base-100 oklch()');
  return oklchToRgb(parseFloat(m[1]) / 100, parseFloat(m[2]), parseFloat(m[3]));
}

function themedTokens(themeName) {
  const { grab, lightBlock, darkBlock } = tokenBlocks();
  const block = themeName === 'dark' ? darkBlock : lightBlock;
  const need = (name) => {
    const v = grab(block, name);
    assert.ok(v, themeName + ' 必须定义 ' + name);
    return v;
  };
  return {
    bg: base100Rgb(themeName),
    request: parseColor(need('--chart-series-request')),
    error: parseColor(need('--chart-series-error')),
    balance: parseColor(need('--chart-series-balance')),
    grid: parseColor(need('--chart-grid')),
    gridH: parseColor(need('--chart-grid-h')),
    now: parseColor(need('--chart-now')),
    axis: parseColor(need('--chart-axis')),
    axisLabel: parseColor(need('--chart-axis-label')),
    tooltipText: parseColor(need('--chart-tooltip-text')),
    areaRequest: parseColor(need('--chart-area-request')),
    areaBalance: parseColor(need('--chart-area-balance')),
  };
}

// 请求折线的可见色 = 序列色 × 线条不透明度（ECharts lineStyle.opacity）叠在卡片底色上。
const REQ_ALPHA = Number((/TREND_REQUEST_LINE_OPACITY\s*=\s*([\d.]+)/.exec(TREND_JS) || [])[1]);
const eff = (token, bg, a = 1) => compositeOver({ rgb: token.rgb, a: token.a * a }, bg);

test('B25-B：两套主题下序列/网格可见、轴标签与图例文字达标（WCAG 对比度）', () => {
  assert.ok(REQ_ALPHA > 0 && REQ_ALPHA <= 1, '能从源码解析出请求线条不透明度');
  const measured = {};
  for (const themeName of ['light', 'dark']) {
    const t = themedTokens(themeName);
    const c = {
      request: contrast(eff(t.request, t.bg, REQ_ALPHA), t.bg),
      error: contrast(eff(t.error, t.bg), t.bg),
      balance: contrast(eff(t.balance, t.bg), t.bg),
      grid: contrast(eff(t.grid, t.bg), t.bg),
      gridH: contrast(eff(t.gridH, t.bg), t.bg),
      axisLabel: contrast(eff(t.axisLabel, t.bg), t.bg),
      legend: contrast(eff(t.tooltipText, t.bg), t.bg),
      areaRequest: contrast(eff(t.areaRequest, t.bg), t.bg),
      areaBalance: contrast(eff(t.areaBalance, t.bg), t.bg),
    };
    measured[themeName] = c;
    // 序列（图形对象）≥ 3:1。
    for (const k of ['request', 'error', 'balance']) {
      assert.ok(c[k] >= 3, themeName + ' 主题 ' + k + ' 对比度 ' + c[k].toFixed(2) + ':1 < 3:1');
    }
    // 请求线额外留 0.2 余量：旧浅色值 #5c6779 合成后只有 3.03（贴线），B25 提到 3.53 才安全。
    assert.ok(c.request >= 3.2, themeName + ' 主题请求线对比度 ' + c.request.toFixed(2) + ':1 < 3.2:1（贴线无余量）');
    // 轴标签 / 图例文字（小字）≥ 4.5:1。
    assert.ok(c.axisLabel >= 4.5, themeName + ' 轴标签对比度 ' + c.axisLabel.toFixed(2) + ':1 < 4.5:1');
    assert.ok(c.legend >= 4.5, themeName + ' 图例文字对比度 ' + c.legend.toFixed(2) + ':1 < 4.5:1');
    // 网格线可见性地板（旧浅色 #e6eaf2 只有 1.21 ≈ 隐形）：≥ 1.3:1。
    assert.ok(c.grid >= 1.3, themeName + ' 纵向网格对比度 ' + c.grid.toFixed(2) + ':1 < 1.3:1');
    assert.ok(c.gridH >= 1.25, themeName + ' 横向网格对比度 ' + c.gridH.toFixed(2) + ':1 < 1.25:1');
    // 填充 / 参考带：与底色有可分辨差异（不要求 3:1，只要不是「一点点色差」）。
    assert.ok(c.areaBalance >= 1.1, themeName + ' 余额填充带与底色差 ' + c.areaBalance.toFixed(3) + ' 太小');
    assert.ok(c.areaRequest >= 1.02, themeName + ' 请求填充带与底色差 ' + c.areaRequest.toFixed(3) + ' 太小');
    // 参考线（「现在」/数据起点）也要看得见。
    assert.ok(contrast(eff(t.now, t.bg), t.bg) >= 1.3, themeName + ' 「现在」参考线 < 1.3:1');
    assert.ok(contrast(eff(t.axis, t.bg), t.bg) >= 1.5, themeName + ' 坐标轴线 < 1.5:1');
  }
  // 交付要的两套主题实测值（断言失败时也能从报错里读到当前值）。
  assert.ok(measured.light && measured.dark, '两套主题都要有实测值');
});

test('B25-B-变异鉴别力：浅色请求线 / 网格调回旧值会跌破阈值（3.2 / 1.3）', () => {
  // 旧浅色请求线 #5c6779 合成后 3.03 → 低于 3.2 的余量线；旧浅色网格 #e6eaf2 = 1.21 → 低于 1.3。
  const bg = base100Rgb('light');
  const oldReq = contrast(compositeOver({ rgb: [0x5c, 0x67, 0x79], a: REQ_ALPHA }, bg), bg);
  const oldGrid = contrast(compositeOver({ rgb: [0xe6, 0xea, 0xf2], a: 1 }, bg), bg);
  assert.ok(oldReq < 3.2, '旧请求线 ' + oldReq.toFixed(3) + ':1 应低于 3.2（证明阈值有鉴别力）');
  assert.ok(oldGrid < 1.3, '旧网格 ' + oldGrid.toFixed(3) + ':1 应低于 1.3（证明阈值有鉴别力）');
  // 现值必须真的更高：浅色请求 ≥3.5、网格 ≥1.5。
  const t = themedTokens('light');
  assert.ok(contrast(eff(t.request, t.bg, REQ_ALPHA), t.bg) >= 3.5, '浅色请求线现值应 ≥3.5:1');
  assert.ok(contrast(eff(t.grid, t.bg), t.bg) >= 1.5, '浅色网格现值应 ≥1.5:1');
});
