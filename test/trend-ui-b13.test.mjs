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

// ── 13：容器 + 脚本顺序 ──────────────────────────────────────────────
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

// ── 14：生成 SVG 折线 + 不引外部库 ───────────────────────────────────
test('B13-14：render-trend.js 生成内联 SVG 折线，且不引任何外部库', () => {
  assert.match(TREND_JS, /polyline|<path/, '必须用 polyline / path 画折线');
  assert.match(TREND_JS, /viewBox/, '必须有固定 viewBox');
  assert.match(TREND_JS, /preserveAspectRatio="none"/, '必须 preserveAspectRatio=none 交给 CSS 控尺寸');
  assert.match(TREND_JS, /apiFetch\(/, '必须复用已有 apiFetch');
  assert.ok(!TREND_JS.includes('<script src="http'), '不得引外部库');
  assert.ok(!/https?:\/\//.test(TREND_JS), '不得引外部 URL');
  assert.ok(!/\bimport\s/.test(TREND_JS) && !/\brequire\(/.test(TREND_JS), '不得用模块加载器');
});

// ── 15：边界保护（源码分支 + 纯函数行为）────────────────────────────
test('B13-15：空数组 / 单点 / max===min 三条边界都有显式保护（且纯函数不产出 NaN）', () => {
  // 源码里确有对应分支 / 除零守卫
  assert.match(TREND_JS, /n\s*===\s*0/, '空数组分支');
  assert.match(TREND_JS, /n\s*===\s*1/, '单点分支');
  assert.match(TREND_JS, /span\s*>\s*0/, 'max===min（span 为 0）的除零守卫');

  // 行为验证：sparkPoints 是纯函数，直接在 vm 里跑
  const context = vm.createContext({ Number, Math, Array, JSON, Object, String, Boolean, isNaN, RegExp });
  vm.runInContext(TREND_JS, context, { filename: 'render-trend.js' });
  const { sparkPoints } = context;
  assert.equal(typeof sparkPoints, 'function');

  assert.equal(sparkPoints([]), null, '空数组 → null（不画线）');
  assert.equal(sparkPoints(null), null, 'null → null');

  const one = sparkPoints([42]);
  assert.equal(typeof one, 'string');
  assert.ok(!/NaN/.test(one), '单点不得出现 NaN');
  const [p1, p2] = one.split(' ');
  assert.equal(p1.split(',')[1], p2.split(',')[1], '单点画水平线（两点 y 相同）');

  const same = sparkPoints([5, 5, 5, 5]);
  assert.ok(!/NaN/.test(same), 'max===min 不得出现 NaN');
  for (const pt of same.split(' ')) assert.equal(pt.split(',')[1], '12.00', '全部相同 → 画在中线');

  const nonfinite = sparkPoints([null, undefined, NaN]);
  assert.ok(!/NaN/.test(nonfinite), '非有限数当 0，不得出现 NaN');
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

// ── 18：样本 < 2 → 不画实心彩线，改中性灰虚线基线 + 「数据不足」 ─────
test('B13b-18：样本 < 2 不画实心彩线，改中性灰虚线基线 + 「数据不足」提示', () => {
  assert.match(TREND_JS, /const\s+sparse\s*=\s*vals\.length\s*<\s*2/, '必须有「样本数 < 2」的判定分支');
  const sparseAt = TREND_JS.indexOf('} else if (sparse) {');
  assert.ok(sparseAt > 0, '必须有稀疏（样本 < 2）渲染分支');
  const sparseBranch = TREND_JS.slice(sparseAt, TREND_JS.indexOf('} else {', sparseAt));
  assert.match(sparseBranch, /trend-line-dashed/, '空态必须走虚线样式');
  assert.match(sparseBranch, /stroke-dasharray/, '虚线必须带 stroke-dasharray');
  assert.match(sparseBranch, /数据不足/, '必须给出「数据不足」文字提示');
  assert.ok(!/class="trend-line"/.test(sparseBranch), '空态分支不得使用实心彩线类');

  const dashedRule = blockAt(DASHBOARD_CSS, '.trend-line-dashed {');
  assert.match(dashedRule, /stroke-dasharray\s*:/, 'CSS 里也要有虚线定义');
  assert.match(dashedRule, /var\(--(?:border|border-strong|text-secondary|text-tertiary)\)/, '虚线用中性弱色令牌');
  assert.match(blockAt(DASHBOARD_CSS, '.trend-note {'), /var\(--text-tertiary\)/, '提示文字用弱色令牌');
});

// ── 19：面积填充只在实心折线分支 ─────────────────────────────────────
test('B13b-19：面积填充只在实心折线分支出现（虚线空态不填充）', () => {
  const sparseAt = TREND_JS.indexOf('} else if (sparse) {');
  const solidAt = TREND_JS.indexOf('} else {', sparseAt);
  assert.ok(sparseAt > 0 && solidAt > sparseAt, '实心 / 虚线两个分支都在');
  const sparseBranch = TREND_JS.slice(sparseAt, solidAt);
  const solidBranch = TREND_JS.slice(solidAt, TREND_JS.indexOf("return '<div class=\"trend-card"));
  assert.ok(!/trend-area|areaPoints\(|<polygon/.test(sparseBranch), '虚线空态绝不加面积填充');
  assert.match(solidBranch, /<polygon class="trend-area"/, '实心折线分支必须有同色面积多边形');
  assert.ok(!/dasharray/.test(solidBranch), '实心折线分支不画虚线');

  const areaRule = blockAt(DASHBOARD_CSS, '.trend-area {');
  assert.match(areaRule, /fill:\s*var\(--trend-tone\)/, '面积色与折线同色令牌');
  const m = /fill-opacity:\s*(\.?\d+(?:\.\d+)?)/.exec(areaRule);
  assert.ok(m, '面积必须有 fill-opacity');
  const op = Number(m[1]);
  assert.ok(op >= 0.1 && op <= 0.14, 'fill-opacity 必须落在 0.10~0.14，实际 ' + op);
});

// ── 20：折线 2px + 圆头圆角 + 高度收窄 ───────────────────────────────
test('B13b-20：折线 stroke-width 2、圆头圆角，sparkline 高度收紧', () => {
  assert.match(TREND_JS, /stroke-width="2"/, '折线属性里 stroke-width 为 2');
  assert.match(TREND_JS, /stroke-linecap="round"/, '折线属性里 stroke-linecap=round');
  assert.match(TREND_JS, /stroke-linejoin="round"/, '折线属性里 stroke-linejoin=round');

  const lineRule = blockAt(DASHBOARD_CSS, '.trend-line {');
  assert.match(lineRule, /stroke-width:\s*2(?:px)?\s*;/, 'CSS 里 stroke-width 为 2');
  assert.match(lineRule, /stroke-linecap:\s*round/);
  assert.match(lineRule, /stroke-linejoin:\s*round/);

  const sparkRule = blockAt(DASHBOARD_CSS, '.trend-spark {');
  const h = /height:\s*(\d+)px/.exec(sparkRule);
  assert.ok(h, 'sparkline 必须有固定高度');
  assert.ok(Number(h[1]) <= 30, 'sparkline 高度必须收窄（<= 30px），实际 ' + h[1]);
  assert.match(DASHBOARD_CSS, /\.trend-empty\s*\{\s*height:\s*28px/, '空态占位高度与折线一致');
});

// ── 21：三条目统一两行结构 ──────────────────────────────────────────
test('B13b-21：三个条目统一两行结构（标签+数值一行 / sparkline 独占一行）', () => {
  assert.match(TREND_JS, /class="trend-card trend-item /, '每个条目都是 .trend-item');
  assert.match(TREND_JS, /class="trend-row"/, '行 1：标签 + 数值');
  assert.match(TREND_JS, /class="trend-plot"/, '行 2：sparkline 独占整宽');
  assert.equal((TREND_JS.match(/class="trend-row"/g) || []).length, 1, '三张卡共用同一模板（只写一次）');

  // 行为验证：真渲染一次，确认 DOM 顺序与条目数
  const host = { innerHTML: '' };
  const context = vm.createContext({
    Number, Math, Array, JSON, Object, String, Boolean, isNaN, RegExp,
    $: (id) => (id === 'trend' ? host : null), esc: (s) => String(s), num: (n) => String(n), money: (n) => String(n),
  });
  vm.runInContext(TREND_JS, context, { filename: 'render-trend.js' });
  context.renderTrend({ bucketMs: 5 * 60 * 1000, samples: [{ r: 1 }, { r: 2 }, { r: 9 }] });
  const iRow = host.innerHTML.indexOf('class="trend-row"');
  const iPlot = host.innerHTML.indexOf('class="trend-plot"');
  assert.ok(iRow > 0 && iPlot > iRow, 'DOM 里行 1（标签+数值）必须排在 sparkline 之前');
  assert.equal((host.innerHTML.match(/class="trend-row"/g) || []).length, 3, '三个条目都要有行 1');
  assert.equal((host.innerHTML.match(/class="trend-plot"/g) || []).length, 3, '三个条目都要有行 2');

  const itemRule = blockAt(DASHBOARD_CSS, '.trend-item {');
  assert.match(itemRule, /display:\s*grid/);
  assert.match(itemRule, /grid-template-rows:\s*auto auto/, '两行网格');
  assert.match(blockAt(DASHBOARD_CSS, '.trend-row {'), /justify-content:\s*space-between/, '标签在左 / 数值在右');
  assert.match(blockAt(DASHBOARD_CSS, '.trend-plot {'), /min-width:\s*0/);
  assert.match(blockAt(DASHBOARD_CSS, '.trend-grid {'), /grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/, '三列等宽 → 三条线端点对齐');
});

// ── 22：颜色语义（请求数中性 / 错误 danger / 余额 success）───────────
test('B13b-22：请求数改中性令牌，错误数仍 danger、可用余额仍 success', () => {
  const trendAt = DASHBOARD_CSS.indexOf('.trend {');
  assert.ok(trendAt >= 0, '找到趋势面板 CSS 段');
  const section = DASHBOARD_CSS.slice(trendAt, DASHBOARD_CSS.indexOf('.trend-empty', trendAt));
  assert.ok(section.length > 0, '切出趋势面板 CSS 段');
  assert.ok(!section.includes('--accent'), '趋势面板内不得再用品牌粉 --accent');
  assert.match(blockAt(DASHBOARD_CSS, '.trend-item.trend-request'), /--text-secondary/, '请求数用中性弱色');
  assert.match(blockAt(DASHBOARD_CSS, '.trend-item.trend-danger'), /--danger/, '错误数保持 danger');
  assert.match(blockAt(DASHBOARD_CSS, '.trend-item.trend-success'), /--success/, '可用余额保持 success');
  assert.ok(!TREND_JS.includes('trend-accent'), 'JS 不得再给请求数用 accent 语义');
  assert.match(TREND_JS, /tone:\s*'trend-request'/);
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

// ── 24（13c）：y 轴零基准（v/scale），不再是 min-max 归一化 ──────────
test('B13c-24：y 轴改零基准（v / scale），不再是 min-max 归一化', () => {
  const fn = blockAt(TREND_JS, 'function sparkPoints');
  assert.match(fn, /v\s*\/\s*scale/, 'y 映射必须用 v / scale 的零基准写法');
  assert.match(fn, /Math\.max\(max,\s*1e-6\)/, 'scale 必须是 max(所有值, 极小正数)');
  assert.ok(!/\(\s*v\s*-\s*min\s*\)\s*\/\s*span/.test(fn), '不得再用 (v - min) / span 的 min-max 归一化');
  assert.ok(!/\/\s*span/.test(fn), 'y 映射里不得再除以 span（min-max 归一化写法已移除）');

  // 行为验证：0 → 底部基线；最大值 → 顶部；数值大小直接决定高度
  const context = vm.createContext({ Number, Math, Array, JSON, Object, String, Boolean, isNaN, RegExp });
  vm.runInContext(TREND_JS, context, { filename: 'render-trend.js' });
  const { sparkPoints } = context;
  const ys = sparkPoints([0, 10]).split(' ').map((p) => Number(p.split(',')[1]));
  assert.ok(ys[0] > ys[1], '0 的 y 必须在 10 的 y 下方（零基准 → 越大越高）');
  const zeroYs = sparkPoints([0, 0, 0]).split(' ').map((p) => Number(p.split(',')[1]));
  for (const y of zeroYs) assert.equal(y, 22, '全 0 序列整条落在底部基线 y=22');
});

// ── 25（13c）：全 0 序列不输出面积填充（有显式条件分支）─────────────
test('B13c-25：全 0 序列不画面积填充（显式条件分支 + 行为验证）', () => {
  assert.match(TREND_JS, /function\s+isAllZero\s*\(/, '必须有全 0 判定（isAllZero）');
  const fn = blockAt(TREND_JS, 'function isAllZero');
  assert.match(fn, /every\(/, '逐个判断是否全为 0');
  assert.match(TREND_JS, /allZero\s*\?/, '面积多边形必须由 allZero 条件分支控制');

  const host = { innerHTML: '' };
  const context = vm.createContext({
    Number, Math, Array, JSON, Object, String, Boolean, isNaN, RegExp,
    $: (id) => (id === 'trend' ? host : null), esc: (s) => String(s), num: (n) => String(n), money: (n) => String(n),
  });
  vm.runInContext(TREND_JS, context, { filename: 'render-trend.js' });
  context.renderTrend({ bucketMs: 5 * 60 * 1000, samples: [{ r: 0, e: 0, m: 0 }, { r: 0, e: 0, m: 0 }, { r: 0, e: 0, m: 0 }] });
  assert.equal((host.innerHTML.match(/<polygon class="trend-area"/g) || []).length, 0, '全 0 → 一个面积多边形都不画');
  context.renderTrend({ bucketMs: 5 * 60 * 1000, samples: [{ r: 1, e: 0, m: 5 }, { r: 2, e: 0, m: 6 }, { r: 3, e: 0, m: 7 }] });
  assert.equal((host.innerHTML.match(/<polygon class="trend-area"/g) || []).length, 2, '非全 0 的两条照常填充，全 0 的错误数仍不填');
});

// ── 26（13c）：三条序列统一画法（端点圆点 + 底部基线 + 描边 ≥ 2）────
test('B13c-26：三条序列同一种画法 —— 端点圆点 + 底部基线 + 描边 ≥ 2', () => {
  const host = { innerHTML: '' };
  const context = vm.createContext({
    Number, Math, Array, JSON, Object, String, Boolean, isNaN, RegExp,
    $: (id) => (id === 'trend' ? host : null), esc: (s) => String(s), num: (n) => String(n), money: (n) => String(n),
  });
  vm.runInContext(TREND_JS, context, { filename: 'render-trend.js' });
  context.renderTrend({ bucketMs: 5 * 60 * 1000, samples: [{ r: 1, e: 2, m: 3 }, { r: 4, e: 5, m: 6 }, { r: 7, e: 8, m: 9 }] });
  const html = host.innerHTML;
  assert.equal((html.match(/class="trend-dot"/g) || []).length, 3, '三条序列都要有端点小圆点');
  assert.match(html, /<circle class="trend-dot"[^>]*r="2"/, '端点圆点必须是 <circle r="2">');
  assert.equal((html.match(/class="trend-baseline"/g) || []).length, 3, '三条序列都要有底部基线');
  assert.equal((html.match(/class="trend-line"/g) || []).length, 3, '三条序列共用同一种描边类');

  const lineRule = blockAt(DASHBOARD_CSS, '.trend-line {');
  const m = /stroke-width:\s*([\d.]+)/.exec(lineRule);
  assert.ok(m && Number(m[1]) >= 2, '描边宽度必须 ≥ 2，实际 ' + (m && m[1]));
  assert.ok(/\.trend-dot\s*\{/.test(DASHBOARD_CSS), 'CSS 里必须有端点圆点样式');
  assert.match(blockAt(DASHBOARD_CSS, '.trend-baseline {'), /var\(--border/, '基线用 --border 类弱色令牌');
});

// ── 27（13c）：请求数中性色不再「隐形」——描边加粗到 ≥ 2.5 ─────────
test('B13c-27：请求数保留中性令牌但把描边加粗到 2.5~3px', () => {
  assert.match(blockAt(DASHBOARD_CSS, '.trend-item.trend-request'), /var\(--text-secondary\)/, '仍用中性弱色（不引品牌色）');
  const at = DASHBOARD_CSS.indexOf('.trend-item.trend-request .trend-line {');
  assert.ok(at > 0, '必须有针对请求数的描边加粗规则');
  const m = /stroke-width:\s*([\d.]+)/.exec(braceBlock(DASHBOARD_CSS, at));
  assert.ok(m, '请求数覆盖规则里必须有 stroke-width');
  const w = Number(m[1]);
  assert.ok(w >= 2.5, '请求数描边必须 ≥ 2.5px（把线拉成图），实际 ' + w);
  assert.ok(w <= 3, '也不要超过 3px 抢戏，实际 ' + w);
});

// ── 28（13c）：图上带区与数值行分离（固定高度 + ≥ 6px 间距）────────
test('B13c-28：图上带区与数值行拆成两个带区（固定高度 + ≥ 6px 间距）', () => {
  const h = /height:\s*(\d+)px/.exec(blockAt(DASHBOARD_CSS, '.trend-plot {'));
  assert.ok(h, '图上带区必须有固定高度');
  assert.ok(Number(h[1]) >= 24 && Number(h[1]) <= 32, '图上带区高度落在 24~32px，实际 ' + h[1]);

  const gap = /row-gap:\s*(\d+)px/.exec(blockAt(DASHBOARD_CSS, '.trend-item {'));
  assert.ok(gap, '两行之间必须有 row-gap');
  assert.ok(Number(gap[1]) >= 6, '数值行与图至少隔 6px，实际 ' + gap[1]);
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
  assert.match(host.innerHTML, /trend-title">近 24 小时趋势（数据收集中）</, '样本不足时标题明说收集中');
});
