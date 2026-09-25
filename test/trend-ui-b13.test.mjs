// 批次 13：前端迷你折线图（#trend 容器 / render-trend.js / app.js 轮询 / CSS stagger）回归。
// 只读 public/** 源码 + 用 vm 直接跑纯函数，不联网、不起服务。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const INDEX_HTML = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const APP_JS = fs.readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
const TREND_JS = fs.readFileSync(new URL('../public/js/render-trend.js', import.meta.url), 'utf8');
const DASHBOARD_CSS = fs.readFileSync(new URL('../public/css/dashboard.css', import.meta.url), 'utf8');

/** 从 css[start] 处的 '{' 匹配成对花括号，返回块内文本。 */
function braceBlock(text, start) {
  const open = text.indexOf('{', start);
  assert.ok(open >= 0, '找到 {');
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  throw new Error('花括号不配平');
}

// B21：ECharts 版的公共测试工具 —— 纯函数上下文 / DOM 垫片上下文 / option 构造。
const TOKENS_CSS = fs.readFileSync(new URL('../public/css/tokens.css', import.meta.url), 'utf8');
const TEST_THEME = {
  request: 'rgb(1, 2, 3)', error: 'rgb(4, 5, 6)', balance: 'rgb(7, 8, 9)',
  grid: 'rgb(10, 11, 12)', gridH: 'rgb(11, 12, 13)', axis: 'rgb(13, 14, 15)', label: 'rgb(16, 17, 18)',
  tooltipBg: 'rgb(19, 20, 21)', tooltipBorder: 'rgb(22, 23, 24)', tooltipText: 'rgb(25, 26, 27)', cursor: 'rgb(28, 29, 30)',
};

/** 只跑 render-trend.js 的纯函数上下文（无 DOM、无 ECharts）。 */
function pureContext() {
  const context = vm.createContext({ Number, Math, Array, JSON, Object, String, Boolean, isNaN, RegExp, Date, Promise });
  vm.runInContext(TREND_JS, context, { filename: 'render-trend.js' });
  return context;
}

/** 带极简 DOM 垫片 `$` 的上下文：renderTrend 能写 innerHTML，但拿不到 ECharts（安全 no-op）。 */
function domContext(host) {
  const context = vm.createContext({
    Number, Math, Array, JSON, Object, String, Boolean, isNaN, RegExp, Date, Promise,
    $: (id) => (id === 'trend' ? host : null),
    esc: (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    num: (n) => String(n), money: (n) => String(n),
  });
  vm.runInContext(TREND_JS, context, { filename: 'render-trend.js' });
  return context;
}

/** 用固定令牌配色构造 option（纯函数，不依赖运行时）。 */
function optionFor(context, samples, extra = {}) {
  return context.buildTrendOption({ samples, capacity: 288, theme: TEST_THEME, reducedMotion: false, ...extra });
}

/** 造 n 个带 t 的样本（值随 index 变化，避免常量序列掩盖降采样分支）。 */
function samplesOf(n) {
  return Array.from({ length: n }, (_, i) => ({ t: 1_700_000_000_000 + i * 300_000, r: i % 7, e: i % 11 === 0 ? 2 : 0, m: 10 + (i % 5) }));
}

// ── 13
test('B13-13：index.html 有 #trend 容器，且 js/render-trend.js 在 js/app.js 之前引入', () => {
  assert.match(INDEX_HTML, /<section[^>]*class="trend"[^>]*id="trend"/, '必须有 #trend 容器');
  assert.match(INDEX_HTML, /aria-label="近 24 小时趋势"/);
  const iTrend = INDEX_HTML.indexOf('js/render-trend.js');
  const iApp = INDEX_HTML.indexOf('js/app.js');
  assert.ok(iTrend > 0, '必须引入 js/render-trend.js');
  assert.ok(iApp > 0, '必须引入 js/app.js');
  assert.ok(iTrend < iApp, 'render-trend.js 必须在 app.js 之前加载');
  // 容器位于 .kpis 之后、.filters 之前
  assert.ok(INDEX_HTML.indexOf('class="kpis"') < INDEX_HTML.indexOf('id="trend"'));
  assert.ok(INDEX_HTML.indexOf('id="trend"') < INDEX_HTML.indexOf('id="filters"'));
});

// ── 14（B21 改写）：懒加载 vendored ECharts + 不引外部库 ─────────────
test('B13-14：render-trend.js 懒加载 vendored ECharts（同源），且不引外部库 / CDN / 模块加载器', () => {
  assert.match(TREND_JS, /vendor\/echarts\.min\.js/, '必须引用 vendored 的 ECharts（同源路径）');
  assert.match(TREND_JS, /createElement\('script'\)/, '必须动态插入 <script> 做懒加载');
  assert.match(TREND_JS, /apiFetch\(/, '必须复用已有 apiFetch');
  // 首屏不被 492KB 阻塞：index.html 里不能有静态 vendor script 标签
  assert.ok(!/<script[^>]*src="[^"]*vendor\/echarts/.test(INDEX_HTML), 'index.html 不得静态引入 ECharts');
  // 供应链：库必须本地 vendored（同源），不得引外部 URL / CDN / 模块加载器
  assert.ok(!TREND_JS.includes('<script src="http'), '不得引外部库');
  assert.ok(!/https?:\/\//.test(TREND_JS), '不得引外部 URL');
  assert.ok(!/\bimport\s/.test(TREND_JS) && !/\brequire\(/.test(TREND_JS), '不得用模块加载器');
});
// ── 15（B21 改写）：边界保护（空数组 / 单点 / 非有限数）─────────────
test('B13-15：空数组 / 单点 / 非有限数三条边界都有显式保护（纯函数不产出 NaN）', () => {
  const context = pureContext();
  assert.equal(typeof context.buildTrendOption, 'function', '必须导出纯函数 buildTrendOption');
  assert.equal(typeof context.trendNum, 'function');

  const empty = context.buildTrendOption({ samples: [], capacity: 288 });
  assert.equal(empty.series.length, 0, '空数组 → 不构造任何序列（不画假线）');
  assert.equal(typeof empty.xAxis, 'object', '空数组也要给出可构造的坐标系');

  const one = context.buildTrendOption({ samples: [{ t: 1, r: 42, e: 0, m: 1 }], capacity: 288 });
  assert.equal(one.series.length, 0, '单点同样不够画线（< 2 走数据不足分支）');

  assert.equal(context.trendNum(null), 0, 'null 当 0');
  assert.equal(context.trendNum(undefined), 0, 'undefined 当 0');
  assert.equal(context.trendNum(NaN), 0, 'NaN 当 0');
  assert.equal(context.trendNum('abc'), 0, '非数字字符串当 0');
  assert.equal(context.trendNum('3.5'), 3.5, '数字字符串照常解析');

  const nonfinite = context.buildTrendOption({
    samples: [{ t: 1, r: null, e: undefined, m: NaN }, { t: 2, r: NaN, e: 'x', m: null }],
    capacity: 288,
  });
  assert.ok(!/NaN/.test(JSON.stringify(nonfinite.series)), '非有限数当 0，option 里不得出现 NaN');
  assert.deepEqual(nonfinite.series[0].data.map((pt) => pt[1]), [0, 0], '请求数非有限数 → 0');
});
// ── 16：app.js 首次调用 + 60s 轮询 + hidden 守卫 ─────────────────────
test('B13-16：app.js 有 loadTrend 首次调用与 60s 轮询，且轮询带 document.hidden 守卫', () => {
  assert.match(APP_JS, /loadTrend\(\)/, 'boot() 必须首次调用 loadTrend()');
  assert.match(APP_JS, /if\s*\(!document\.hidden\)\s*loadTrend\(\)/, '轮询必须带 document.hidden 守卫');
  assert.match(APP_JS, /setInterval\([\s\S]*?loadTrend\(\)[\s\S]*?,\s*60000\)/, '趋势轮询间隔应为 60000ms');
  // 既有 5s 轮询语义不得被动掉
  assert.match(APP_JS, /if\s*\(!document\.hidden\)\s*load\(\);?\s*\}\s*,\s*5000\)/, '既有 5s 轮询保持不变');
});

// ── 17：CSS 入场 stagger + reduced-motion ────────────────────────────
test('B13-17：.trend 参与 body.is-intro 入场，并在 reduced-motion 里 animation:none', () => {
  assert.match(DASHBOARD_CSS, /body\.is-intro \.trend\s*\{[^}]*animation:\s*rise-in/, '.trend 参与入场 stagger');

  const at = DASHBOARD_CSS.indexOf('@media (prefers-reduced-motion: reduce)');
  assert.ok(at >= 0, '必须有 reduced-motion 块');
  const block = braceBlock(DASHBOARD_CSS, at);
  assert.match(block, /body\.is-intro \.trend/, 'reduced-motion 名单必须含 .trend');
  assert.match(block, /animation:\s*none/, 'reduced-motion 里必须 animation: none');
});

/** 取 marker 之后第一个成对 {…} 块的块内文本（.selector / function name 都适用）。 */
function blockAt(text, marker) {
  const at = text.indexOf(marker);
  assert.ok(at >= 0, '找到 ' + marker);
  return braceBlock(text, at);
}

// ── 18（B21 改写）：样本 < 2 → 不画假线，中性「数据不足」态 ─────────
test('B13b-18：样本 < 2 不画任何序列，改中性「数据不足」态 + 文本摘要仍在', () => {
  const context = pureContext();
  const opt = context.buildTrendOption({ samples: [{ t: 1, r: 1, e: 0, m: 1 }], capacity: 288, reducedMotion: false });
  assert.equal(opt.series.length, 0, '样本 < 2：一个序列都不画（绝不画假线）');
  assert.equal(opt.legend.show, false, '没有序列就不显示图例');
  assert.equal(opt.tooltip.show, false, '空态不显示 tooltip');
  assert.match(opt.aria.label.description, /数据不足/, 'option 的无障碍描述里必须有中性「数据不足」说明');

  const host = { innerHTML: '' };
  const dom = domContext(host);
  dom.renderTrend({ bucketMs: 5 * 60 * 1000, samples: [{ r: 1, e: 0, m: 1 }] });
  assert.match(host.innerHTML, /class="trend-empty"[^>]*>数据不足/, '渲染出来也必须明说「数据不足」');
  assert.ok(!/class="trend-chart"/.test(host.innerHTML), '空态不建图容器（也就不画线）');
  assert.match(host.innerHTML, /class="trend-summary"/, '文本摘要不退化');
  assert.match(host.innerHTML, /role="img"/, '空态也要有 role=img 的中性说明');
});
// ── 19（B21 改写）：面积填充只在实心分支，且是渐变（空态不填充）──────
test('B13b-19：面积填充只在实心折线分支出现，且是上深下透明的线性渐变', () => {
  const context = pureContext();
  const empty = context.buildTrendOption({ samples: [{ t: 1, r: 1, e: 1, m: 1 }], capacity: 288 });
  assert.equal(empty.series.length, 0, '空态没有任何序列 → 也没有面积填充');

  const opt = optionFor(context, [{ t: 1, r: 1, e: 0, m: 5 }, { t: 2, r: 2, e: 1, m: 6 }, { t: 3, r: 3, e: 0, m: 7 }]);
  const byName = Object.fromEntries(opt.series.map((sr) => [sr.name, sr]));
  const req = byName['请求数'];
  const err = byName['错误数'];
  const bal = byName['可用余额'];
  assert.ok(req.areaStyle, '请求数有面积填充');
  assert.ok(bal.areaStyle, '可用余额有面积填充');
  assert.equal(err.areaStyle, undefined, '错误数只画线、不填充');
  assert.equal(req.areaStyle.color.type, 'linear', '填充必须是线性渐变，不是纯色块');
  const alphaOf = (stop) => {
    const m = /,\s*([\d.]+)\s*\)$/.exec(stop.color);
    assert.ok(m, '渐变 stop 是 rgba(...)：' + stop.color);
    return Number(m[1]);
  };
  const reqTop = req.areaStyle.color.colorStops[0];
  const reqBottom = req.areaStyle.color.colorStops[1];
  const balTop = bal.areaStyle.color.colorStops[0];
  // 批次 21f 第 4 条：同色相淡出（不能和 transparent 黑插值，否则发脏）。
  assert.match(reqTop.color, /^rgba\(1, 2, 3, /, '渐变顶部保持序列色相');
  assert.equal(alphaOf(reqBottom), 0, '渐变底部 alpha=0（淡出到透明）');
  assert.equal(bal.areaStyle.color.colorStops[1].color.includes('transparent'), false, '不与 transparent 黑插值');
  const reqAlpha = alphaOf(reqTop);
  const balAlpha = alphaOf(balTop);
  // 批次 21c：请求数面积退到 ~8%（背景温度）；批次 21f：余额面积顶部落在 18%~22% 档。
  assert.ok(reqAlpha >= 0.05 && reqAlpha <= 0.12, '请求数面积极淡（约 8%），实际 ' + reqAlpha);
  assert.ok(balAlpha > reqAlpha, '余额面积必须比请求数更实（视觉主角）');
  assert.ok(balAlpha >= 0.16 && balAlpha <= 0.25, '余额顶部透明度落在 18%~22% 档，实际 ' + balAlpha);
});
// ── 20（B21 改写）：线宽 / 平滑 / 密集降采样 / 图高 ─────────────────
test('B13b-20：线宽分主次（余额 2px / 请求与错误 1px）、请求数适度平滑，密集时关 symbol + LTTB，图有固定高度', () => {
  const context = pureContext();
  const sparse = optionFor(context, samplesOf(6));
  const sparseByName = Object.fromEntries(sparse.series.map((sr) => [sr.name, sr]));
  assert.equal(sparseByName['可用余额'].lineStyle.width, 2, '余额 2px（主角）');
  assert.equal(sparseByName['请求数'].lineStyle.width, 1, '请求数 1px（退到背景）');
  assert.equal(sparseByName['错误数'].lineStyle.width, 1, '错误数 1px（细虚线）');
  assert.equal(sparseByName['错误数'].lineStyle.type, 'dashed', '错误数默认细虚线');
  assert.ok(typeof sparse.series[0].smooth === 'number' && sparse.series[0].smooth > 0, '请求数适度平滑');
  assert.notEqual(sparse.series[0].symbol, 'none', '点少时保留小圆点');

  const dense = optionFor(context, samplesOf(288));
  assert.equal(dense.series[0].showSymbol, false, '密集时隐藏数据点');
  assert.equal(dense.series[0].symbol, 'none', '密集时 symbol 为 none');
  assert.equal(dense.series[0].sampling, 'lttb', '密集时必须 LTTB 降采样（消梳齿）');
  assert.equal(dense.series[0].data.length, 288, '数据本身不丢（降采样交给渲染层）');

  const h = /height:\s*(\d+)px/.exec(blockAt(DASHBOARD_CSS, '.trend-chart {'));
  assert.ok(h, '.trend-chart 必须有固定高度');
  assert.ok(Number(h[1]) >= 200 && Number(h[1]) <= 320, '图高度落在 200~320px，实际 ' + h[1]);
});
// ── 21（B21 改写）：三序列合并成一张共享坐标系的大图 ────────────────
test('B13b-21：合并成一张图 —— 单个图容器 + 标题行 + 文本摘要，旧的 3 列栅格已移除', () => {
  const host = { innerHTML: '' };
  const dom = domContext(host);
  dom.renderTrend({ bucketMs: 5 * 60 * 1000, samples: samplesOf(5) });
  const html = host.innerHTML;
  assert.equal((html.match(/class="trend-chart"/g) || []).length, 1, '只有一个图容器（不再三张并排）');
  assert.equal((html.match(/class="trend-summary"/g) || []).length, 1, '只有一份文本摘要');
  assert.equal((html.match(/class="trend-stat"/g) || []).length, 3, '摘要覆盖三条序列');
  const iHead = html.indexOf('class="trend-head-row"');
  const iChart = html.indexOf('class="trend-chart"');
  const iSum = html.indexOf('class="trend-summary"');
  assert.ok(iHead >= 0 && iChart > iHead && iSum > iChart, 'DOM 顺序：标题行 → 图 → 摘要');
  assert.match(blockAt(DASHBOARD_CSS, '.trend-chart {'), /width:\s*100%/, '图占满卡片宽度');
  assert.match(blockAt(DASHBOARD_CSS, '.trend-summary {'), /border-top:/, '摘要有分隔线');
  assert.ok(!/\.trend-grid\s*[,{]/.test(DASHBOARD_CSS), '旧的「三列并排」栅格样式已移除');
});
// ── 22（B21 改写）：颜色来自 --chart-* 令牌，错误色与品牌色拉开 ──────
test('B13b-22：颜色全部取自 --chart-* 语义令牌（JS 不写死 hex），错误色≠品牌色', () => {
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(TREND_JS), 'render-trend.js 里不得出现字面 hex 色值');
  assert.match(TREND_JS, /--chart-series-request/, '请求数绑到 --chart-series-request');
  assert.match(TREND_JS, /--chart-series-error/, '错误数绑到 --chart-series-error');
  assert.match(TREND_JS, /--chart-series-balance/, '余额绑到 --chart-series-balance');

  const darkAt = TOKENS_CSS.indexOf(':root[data-theme="dark"] {');
  const lightBlock = TOKENS_CSS.slice(0, darkAt);
  const darkBlock = TOKENS_CSS.slice(darkAt);
  for (const name of ['--chart-series-request', '--chart-series-error', '--chart-series-balance',
    '--chart-grid', '--chart-grid-h', '--chart-axis', '--chart-axis-label', '--chart-tooltip-bg', '--chart-cursor']) {
    assert.ok(lightBlock.includes(name + ':'), '浅色主题必须定义 ' + name);
    assert.ok(darkBlock.includes(name + ':'), '深色主题必须覆盖 ' + name);
  }

  const context = pureContext();
  const opt = optionFor(context, [{ t: 1, r: 1, e: 2, m: 3 }, { t: 2, r: 4, e: 5, m: 6 }]);
  assert.equal(opt.series[0].lineStyle.color, TEST_THEME.request, '请求数色原样来自令牌解析值');
  assert.equal(opt.series[1].lineStyle.color, TEST_THEME.error, '错误数色原样来自令牌解析值');
  assert.equal(opt.series[2].lineStyle.color, TEST_THEME.balance, '余额色原样来自令牌解析值');

  const errorColor = /--chart-series-error:\s*([^;]+);/.exec(lightBlock)[1].trim().toLowerCase();
  const accent = /--accent:\s*([^;]+);/.exec(lightBlock)[1].trim().toLowerCase();
  assert.notEqual(errorColor, accent, '错误色不得等于品牌洋红（否则「红=品牌」会误读）');
});
// ── 23：表头文案区分两种样本量并写明覆盖窗口 ────────────────────────
test('B13b-23：表头文案在样本 < 2 / ≥ 2 两种情况下不同，且写明覆盖的时间窗', () => {
  const fn = blockAt(TREND_JS, 'function trendRangeText');
  assert.match(fn, /if\s*\(n\s*<\s*2\)/, '必须有 n < 2 分支');
  assert.match(fn, /数据收集中/, '数据不足 → 明说收集中');
  assert.match(fn, /覆盖最近/, '样本够 → 明说覆盖的窗口');
  assert.match(fn, /个样本/, '两种情况都要给出样本数');
  assert.match(fn, /capacity/, '给出「已攒 n / 满窗 capacity」比例');

  const context = vm.createContext({ Number, Math, Array, JSON, Object, String, Boolean, isNaN, RegExp });
  vm.runInContext(TREND_JS, context, { filename: 'render-trend.js' });
  const { trendRangeText } = context;
  assert.equal(typeof trendRangeText, 'function');
  const few = trendRangeText([{ r: 1 }], { bucketMs: 5 * 60 * 1000 });
  const many = trendRangeText([{ r: 1 }, { r: 2 }, { r: 3 }], { bucketMs: 5 * 60 * 1000 });
  assert.notEqual(few, many, '两种样本量必须给出不同文案');
  assert.match(few, /1\/288 个样本/, '单样本 → 1/288 个样本');
  assert.match(many, /覆盖最近 10 分钟 · 共 3 个样本/, '三样本 → 覆盖最近 10 分钟 / 共 3 个样本');
});

// ── 24（B21 改写）：y 轴零基准 + 双轴分工 ────────────────────────────
test('B13c-24：双 Y 轴各自零基准（min: 0），请求/错误走左轴、余额走右轴', () => {
  const context = pureContext();
  const opt = optionFor(context, [{ t: 1, r: 0, e: 0, m: 0 }, { t: 2, r: 10, e: 1, m: 5 }]);
  assert.equal(opt.yAxis.length, 2, '必须且只有两根 Y 轴');
  assert.equal(opt.yAxis[0].min, 0, '左轴（次）零基准：0 塌到基线，数值大小真实反映高度');
  assert.equal(opt.yAxis[1].min, 0, '右轴（USD）零基准');
  assert.equal(opt.yAxis[0].name, '次', '左轴轴名带单位「次」');
  assert.equal(opt.yAxis[1].name, 'USD', '右轴轴名带单位「USD」');
  assert.equal(opt.series[0].yAxisIndex, 0);
  assert.equal(opt.series[1].yAxisIndex, 0);
  assert.equal(opt.series[2].yAxisIndex, 1, '余额单独走右轴，绝不和「次」共轴');
  assert.equal(opt.xAxis.type, 'time', 'X 轴是时间轴（能回答「尖峰在几点」）');
});
// ── 25（B21 改写）：全 0 序列不画面积（零值不拿最重权重）─────────────
test('B13c-25：全 0 序列不画面积填充（显式分支 + 行为验证），点仍在零基线', () => {
  assert.match(TREND_JS, /function\s+isAllZero\s*\(/, '必须有全 0 判定（isAllZero）');
  assert.match(blockAt(TREND_JS, 'function isAllZero'), /every\(/, '逐个判断是否全为 0');
  assert.match(TREND_JS, /reqZero\s*\?/, '请求数面积由全 0 分支控制');
  assert.match(TREND_JS, /balZero\s*\?/, '余额面积由全 0 分支控制');

  const context = pureContext();
  const zero = optionFor(context, [{ t: 1, r: 0, e: 0, m: 0 }, { t: 2, r: 0, e: 0, m: 0 }, { t: 3, r: 0, e: 0, m: 0 }]);
  const zr = zero.series.find((sr) => sr.name === '请求数');
  const zb = zero.series.find((sr) => sr.name === '可用余额');
  assert.equal(zero.series.find((sr) => sr.name === '错误数'), undefined, '错误全 0 → 贴底实线整条不出现');
  assert.equal(zr.areaStyle, undefined, '全 0 的请求数不填充');
  assert.equal(zb.areaStyle, undefined, '全 0 的余额不填充');
  assert.equal(zr.data.length, 3, '请求数点还在（零值塌到底部基线，不是不画）');

  const mixed = optionFor(context, [{ t: 1, r: 1, e: 0, m: 0 }, { t: 2, r: 2, e: 0, m: 0 }, { t: 3, r: 3, e: 0, m: 0 }]);
  const mr = mixed.series.find((sr) => sr.name === '请求数');
  const mb = mixed.series.find((sr) => sr.name === '可用余额');
  assert.ok(mr.areaStyle, '非全 0 的请求数照常填充');
  assert.equal(mb.areaStyle, undefined, '全 0 的余额仍不填充');
  assert.equal(mixed.series.find((sr) => sr.name === '错误数'), undefined, '错误仍全 0 → 仍不出现');
});
// ── 26（B21 改写）：三条序列共享一张图（名字 / 类型 / 线宽一致）──────
test('B13c-26：三条序列共享一张图 —— 名字、类型、线宽分主次，一个 role=img', () => {
  const context = pureContext();
  const opt = optionFor(context, [{ t: 1, r: 1, e: 2, m: 3 }, { t: 2, r: 4, e: 5, m: 6 }, { t: 3, r: 7, e: 8, m: 9 }]);
  const drawn = opt.series.filter((s) => s.type !== 'custom');
  assert.equal(drawn.length, 3, '三条数据序列');
  assert.deepEqual([...drawn.map((s) => s.name)], ['请求数', '错误数', '可用余额'], '序列名带语义（图例/提示都用它）');
  for (const s of drawn) assert.equal(s.type, 'line', '三条都是折线');
  const byName = Object.fromEntries(drawn.map((s) => [s.name, s]));
  assert.equal(byName['可用余额'].lineStyle.width, 2, '余额 2px 主角');
  assert.equal(byName['请求数'].lineStyle.width, 1, '请求 1px 退到背景');
  assert.equal(byName['错误数'].lineStyle.width, 1, '错误 1px');
  assert.equal(byName['错误数'].lineStyle.type, 'dashed', '错误细虚线');
  assert.equal(byName['错误数'].symbol, 'circle', '错误数用小圆点定位（稀疏）');
  assert.equal(typeof byName['错误数'].symbolSize, 'function', '圆点尺寸按值给：0 值不画点');

  const host = { innerHTML: '' };
  const dom = domContext(host);
  dom.renderTrend({ bucketMs: 5 * 60 * 1000, samples: samplesOf(5) });
  assert.equal((host.innerHTML.match(/role="img"/g) || []).length, 1, '一张图只有一个 role=img');
  assert.match(host.innerHTML, /aria-label="[^"]*请求数[^"]*错误数[^"]*可用余额/, 'aria-label 要说明三条序列的当前值');
});
// ── 27（B21 改写）：请求数中性令牌、错误数独立警示色 ─────────────────
test('B13c-27：请求数用中性次要色令牌（不引品牌），错误数用独立警示色', () => {
  const darkAt = TOKENS_CSS.indexOf(':root[data-theme="dark"] {');
  const lightBlock = TOKENS_CSS.slice(0, darkAt);
  const request = /--chart-series-request:\s*([^;]+);/.exec(lightBlock)[1].trim();
  const secondary = /--text-secondary:\s*([^;]+);/.exec(lightBlock)[1].trim();
  const accent = /--accent:\s*([^;]+);/.exec(lightBlock)[1].trim();
  const error = /--chart-series-error:\s*([^;]+);/.exec(lightBlock)[1].trim();
  assert.equal(request.toLowerCase(), secondary.toLowerCase(), '请求数用中性次要色（与 --text-secondary 同值）');
  assert.notEqual(request.toLowerCase(), accent.toLowerCase(), '请求数不得用品牌色');
  assert.notEqual(error.toLowerCase(), accent.toLowerCase(), '错误数不得用品牌洋红');
  assert.match(TREND_JS, /request:\s*'--chart-series-request'/, '请求数绑到中性令牌');
  assert.match(TREND_JS, /error:\s*'--chart-series-error'/, '错误数绑到警示令牌');
});
// ── 28（B21 改写）：图区与文本摘要分成两块 ───────────────────────────
test('B13c-28：图区有固定高度、文本摘要有间距 + 分隔线（两块不糊在一起）', () => {
  const h = /height:\s*(\d+)px/.exec(blockAt(DASHBOARD_CSS, '.trend-chart {'));
  assert.ok(h, '.trend-chart 必须有固定高度');
  assert.ok(Number(h[1]) >= 200 && Number(h[1]) <= 320, '图区高度落在 200~320px，实际 ' + h[1]);

  const sum = blockAt(DASHBOARD_CSS, '.trend-summary {');
  const mt = /margin-top:\s*(\d+)px/.exec(sum);
  assert.ok(mt, '摘要与图之间必须有 margin-top');
  assert.ok(Number(mt[1]) >= 4, '至少隔 4px，实际 ' + mt[1]);
  assert.match(sum, /border-top:/, '摘要与图之间有分隔线');
});
// ── 29（13c）：标题按样本量分两支（< 12 收集中 / ≥ 12 近 24 小时）──
test('B13c-29：标题样本 < 12 时说「数据收集中」，≥ 12 才说「近 24 小时」', () => {
  const fn = blockAt(TREND_JS, 'function trendTitle');
  assert.match(TREND_JS, /TREND_FULL_WINDOW_SAMPLES\s*=\s*12/, '以 12 个样本为界（不足 1 小时）');
  assert.match(fn, /TREND_FULL_WINDOW_SAMPLES/, '用满窗样本常量做判断');
  assert.match(fn, /数据收集中/, '不足 12 → 明说收集中');
  assert.match(fn, /近 24 小时/, '够 12 → 才说近 24 小时');

  const context = vm.createContext({ Number, Math, Array, JSON, Object, String, Boolean, isNaN, RegExp });
  vm.runInContext(TREND_JS, context, { filename: 'render-trend.js' });
  const { trendTitle } = context;
  assert.equal(typeof trendTitle, 'function');
  assert.match(trendTitle(2), /数据收集中/, '2 个样本不宣称近 24 小时');
  assert.match(trendTitle(11), /数据收集中/, '11 个样本仍不足 1 小时');
  assert.ok(!/数据收集中/.test(trendTitle(12)), '12 个样本 → 纯标题');
  assert.match(trendTitle(12), /近 24 小时/);
  assert.ok(!/数据收集中/.test(trendTitle(288)));

  // 三张卡的标题共用同一分支
  const host = { innerHTML: '' };
  const ctx = vm.createContext({
    Number, Math, Array, JSON, Object, String, Boolean, isNaN, RegExp,
    $: (id) => (id === 'trend' ? host : null), esc: (s) => String(s), num: (n) => String(n), money: (n) => String(n),
  });
  vm.runInContext(TREND_JS, ctx, { filename: 'render-trend.js' });
  ctx.renderTrend({ bucketMs: 5 * 60 * 1000, samples: [{ r: 1 }, { r: 2 }] });
  assert.match(host.innerHTML, /trend-pill">数据收集中 2\/288</, '样本不足时右侧 pill 徽章明说收集中（不再全角括号硬拼）');
  assert.ok(!/trend-title">近 24 小时趋势（数据收集中）/.test(host.innerHTML), '可见标题保持干净的「近 24 小时趋势」');
  assert.match(host.innerHTML, /近 24 小时趋势（数据收集中）/, 'aria-label 保留完整标题语义（批次 19 的阈值判定不变）');
});
// ── 30（21f）：底部摘要字号 / 对比度提档 + 色点与图例对齐 ──────────────
test('B13c-30：摘要色点 10px、标签与单位用 --fs-sm + 次要文字色（读起来不再费劲）', () => {
  const dot = blockAt(DASHBOARD_CSS, '.trend-dot {');
  assert.match(dot, /width:\s*10px/, '摘要色点 10px（与图例色点一致）');
  assert.match(dot, /height:\s*10px/, '摘要色点正圆');
  const label = blockAt(DASHBOARD_CSS, '.trend-stat-label {');
  assert.match(label, /font-size:\s*var\(--fs-sm\)/, '标签字号提到 --fs-sm');
  assert.match(label, /color:\s*var\(--text-secondary\)/, '标签用次要文字对比度令牌（不再偏暗）');
  const unit = blockAt(DASHBOARD_CSS, '.trend-stat-unit {');
  assert.match(unit, /font-size:\s*var\(--fs-sm\)/, '单位字号提到 --fs-sm');
  assert.match(unit, /color:\s*var\(--text-secondary\)/, '单位不再弱化到看不清的 tertiary');
});
