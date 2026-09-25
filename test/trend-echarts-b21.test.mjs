// 批次 21：用 ECharts 重做「近 24 小时趋势」。
//   - 纯函数 buildTrendOption() 在 vm 里直接断言（不碰 DOM、不需要 ECharts 运行时）；
//   - 懒加载 / 挂载路径用假 document + 假 echarts 覆盖「安全跳过」；
//   - /vendor/ 长缓存用真实网关进程验证。
// 不联网（网关只连本地 mock）、不依赖浏览器 / canvas。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { startTestGateway, request } from './helpers.mjs';

const INDEX_HTML = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const TREND_JS = fs.readFileSync(new URL('../public/js/render-trend.js', import.meta.url), 'utf8');
const TOKENS_CSS = fs.readFileSync(new URL('../public/css/tokens.css', import.meta.url), 'utf8');
const VENDOR_README = fs.readFileSync(new URL('../public/vendor/README.md', import.meta.url), 'utf8');
const PKG = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const TEST_THEME = {
  request: 'rgb(1, 2, 3)', error: 'rgb(4, 5, 6)', balance: 'rgb(7, 8, 9)',
  grid: 'rgb(10, 11, 12)', gridH: 'rgb(11, 12, 13)', now: 'rgb(29, 30, 31)', axis: 'rgb(13, 14, 15)', label: 'rgb(16, 17, 18)',
  tooltipBg: 'rgb(19, 20, 21)', tooltipBorder: 'rgb(22, 23, 24)', tooltipText: 'rgb(25, 26, 27)', cursor: 'rgb(28, 29, 30)',
};

function pureContext(extra = {}) {
  const context = vm.createContext({ Number, Math, Array, JSON, Object, String, Boolean, isNaN, RegExp, Date, Promise, ...extra });
  vm.runInContext(TREND_JS, context, { filename: 'render-trend.js' });
  return context;
}

function optionFor(context, samples, extra = {}) {
  return context.buildTrendOption({ samples, capacity: 288, theme: TEST_THEME, reducedMotion: false, ...extra });
}

const T0 = 1_700_000_000_000;
const samplesOf = (n) => Array.from({ length: n }, (_, i) => ({ t: T0 + i * 300_000, r: i % 7, e: i % 13 === 0 ? 2 : 0, m: 10 + (i % 5) }));

// 加载 vendored 的**真实** ECharts（UMD 的 CJS 分支），用 SSR 跑同一条 option/图元管线。
// 这是 BUG 2 的关键：只在 vm 里断言 option 字段抓不到「renderItem 返回数组 → setOption 抛错」。
function loadVendoredECharts() {
  const code = fs.readFileSync(new URL('../public/vendor/echarts.min.js', import.meta.url), 'utf8');
  const exportsObj = {};
  const context = { exports: exportsObj, module: { exports: exportsObj }, console, setTimeout, clearTimeout, Date, Math, JSON };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(code, context, { filename: 'echarts.min.js' });
  return context.echarts || context.module.exports || exportsObj;
}

// 极简 DOM 垫片：解析 renderTrend 写入的 innerHTML；**同名 class 的节点跨渲染复用**，
// 于是 hidden 之类的状态会残留 —— 正好复现「失败过一次后再成功，节点没被纠回来」。
// 真实浏览器里 innerHTML 会重建节点，但可见性必须由渲染代码显式对齐（见 B21-32）。
function shimTrendHost() {
  const byClass = new Map();
  const host = {
    _html: '',
    querySelector(sel) {
      const cls = String(sel).replace(/^\./, '');
      return byClass.get(cls) || null;
    },
    appendChild() {},
  };
  const makeEl = (tag, classes, attrs) => {
    const el = {
      tagName: String(tag).toUpperCase(),
      className: classes,
      _attrs: {},
      setAttribute(name) { this._attrs[name] = ''; if (name === 'hidden') this._hidden = true; },
      removeAttribute(name) { delete this._attrs[name]; if (name === 'hidden') this._hidden = false; },
      hasAttribute(name) { return Object.prototype.hasOwnProperty.call(this._attrs, name); },
    };
    Object.defineProperty(el, 'hidden', {
      get() { return !!this._hidden; },
      set(v) { this._hidden = !!v; if (v) this._attrs.hidden = ''; else delete this._attrs.hidden; },
    });
    el._hidden = /(^|\s)hidden(\s|$)/.test(attrs || '');
    if (el._hidden) el._attrs.hidden = '';
    return el;
  };
  Object.defineProperty(host, 'innerHTML', {
    get() { return this._html; },
    set(value) {
      this._html = String(value);
      const re = /<([a-zA-Z0-9]+)\s+class="([^"]*)"([^>]*)>/g;
      let m;
      while ((m = re.exec(this._html))) {
        const classes = m[2];
        const key = classes.split(/\s+/)[0];
        if (byClass.has(key)) continue;   // 复用：模拟节点跨渲染存活
        byClass.set(key, makeEl(m[1], classes, m[3]));
      }
    },
  });
  return host;
}

// 造一个能渲染趋势的上下文；echarts 缺省时不注入（走降级路径）。
function trendContext(host, echartsLib) {
  const extra = {
    $: (id) => (id === 'trend' ? host : null),
    esc: (v) => String(v == null ? '' : v),
    num: String, money: String,
  };
  if (echartsLib) extra.echarts = echartsLib;
  return pureContext(extra);
}

const fakeECharts = () => ({ init: () => ({ setOption() {}, dispose() {} }) });
const boomECharts = () => ({ init: () => ({ setOption() { throw new Error('boom'); }, dispose() {} }) });

// ── 1：纯函数签名与关键字段 ─────────────────────────────────────────
test('B21-1：buildTrendOption 产出一套共享坐标系：time X 轴 + 两根 Y 轴 + axis tooltip + legend', () => {
  const context = pureContext();
  assert.equal(typeof context.buildTrendOption, 'function', '必须导出纯函数 buildTrendOption');

  const opt = optionFor(context, samplesOf(12));
  assert.equal(opt.xAxis.type, 'time', 'X 轴必须是时间轴（能回答「尖峰在几点」）');
  assert.equal(opt.xAxis.splitLine.show, true, '时间轴要有浅色网格线');
  assert.equal(opt.xAxis.axisLabel.formatter(T0).length, 5, '刻度格式为 HH:mm');
  assert.equal(opt.yAxis.length, 2, '必须且只有两根 Y 轴');
  assert.equal(opt.yAxis[0].min, 0, '左轴零基准');
  assert.equal(opt.yAxis[1].min, 0, '右轴零基准');
  assert.equal(opt.yAxis[0].name, '次', '左轴轴名带单位「次」');
  assert.equal(opt.yAxis[1].name, 'USD', '右轴轴名带单位「USD」');
  assert.equal(opt.yAxis[0].splitLine.show, true, '左轴给横向网格（为主）');
  assert.equal(opt.yAxis[0].splitLine.lineStyle.color, TEST_THEME.gridH, '横向网格用更淡一档的 --chart-grid-h');
  assert.equal(opt.yAxis[1].splitLine.show, false, '右轴不重复画网格');
  assert.equal(opt.tooltip.trigger, 'axis', 'tooltip 必须是 axis 触发（竖直参考线 + 同屏三值）');
  assert.equal(opt.tooltip.axisPointer.type, 'line', 'axisPointer 是竖直线（十字参考线）');
  assert.equal(opt.tooltip.axisPointer.lineStyle.type, 'dashed', 'axisPointer 是安静虚线');
  assert.equal(opt.legend.show, true, '必须有图例');
  assert.equal(opt.legend.top, 0);
  assert.equal(opt.legend.left, 'center', '图例整块居中（窄屏折行时也居中 + itemGap 等距，孤儿项不会被甩到最右）');
  assert.equal(opt.legend.icon, 'circle', '图例小圆点');
  const drawn = opt.series.filter((s) => s.type !== 'custom');
  assert.equal(drawn.length, 3, '三条数据序列（另有隐藏的「无数据」带 series）');
  assert.deepEqual([...drawn.map((s) => s.name)], ['请求数', '错误数', '可用余额']);
  assert.deepEqual([...drawn.map((s) => s.yAxisIndex)], [0, 0, 1], '余额单独走右轴');
  assert.equal(drawn[2].step, 'end', '余额是阶跃语义（step: end）');
});

// ── 2：颜色全部来自令牌解析值 ───────────────────────────────────────
test('B21-2：option 的配色原样来自 --chart-* 令牌，且浅/深两套令牌都齐全', () => {
  const context = pureContext();
  const opt = optionFor(context, samplesOf(12));
  assert.deepEqual([...opt.color], [TEST_THEME.request, TEST_THEME.error, TEST_THEME.balance], '色板顺序 = 三序列');
  assert.equal(opt.series[1].lineStyle.color, TEST_THEME.error);
  assert.equal(opt.series[2].lineStyle.color, TEST_THEME.balance);

  const darkAt = TOKENS_CSS.indexOf(':root[data-theme="dark"] {');
  assert.ok(darkAt > 0, '存在深色令牌块');
  const light = TOKENS_CSS.slice(0, darkAt);
  const dark = TOKENS_CSS.slice(darkAt);
  for (const name of ['--chart-series-request', '--chart-series-error', '--chart-series-balance',
    '--chart-grid', '--chart-grid-h', '--chart-now', '--chart-axis', '--chart-axis-label',
    '--chart-tooltip-bg', '--chart-tooltip-border', '--chart-tooltip-text', '--chart-cursor']) {
    assert.ok(light.includes(name + ':'), '浅色必须定义 ' + name);
    assert.ok(dark.includes(name + ':'), '深色必须覆盖 ' + name);
  }
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(TREND_JS), 'render-trend.js 不得出现字面 hex');
});

// ── 3：密集降采样 / 稀疏点 ──────────────────────────────────────────
test('B21-3：288 个点走 LTTB 降采样 + symbol none；错误序列不降采样以免丢尖峰', () => {
  const context = pureContext();
  const dense = optionFor(context, samplesOf(288));
  assert.equal(dense.series[0].sampling, 'lttb', '请求数密集时 LTTB');
  assert.equal(dense.series[0].symbol, 'none', '密集时 symbol none（消梳齿）');
  assert.equal(dense.series[0].showSymbol, false);
  assert.equal(dense.series[0].data.length, 288, '原始数据点不丢');
  assert.equal(dense.series[1].sampling, undefined, '错误数不得降采样（否则会丢尖峰）');
  assert.equal(dense.series[1].showSymbol, true, '错误数显示小圆点');

  const sparse = optionFor(context, samplesOf(6));
  assert.equal(sparse.series[0].symbol, 'circle', '点少时给圆点');
  assert.equal(sparse.series[0].sampling, undefined);
});

// ── 4：prefers-reduced-motion ───────────────────────────────────────
test('B21-4：reducedMotion 时 animation 关闭，正常时开启动画', () => {
  const context = pureContext();
  assert.equal(optionFor(context, samplesOf(12), { reducedMotion: true }).animation, false, 'reduced-motion → animation: false');
  assert.equal(optionFor(context, samplesOf(12), { reducedMotion: false }).animation, true, '正常 → 开动画');
});

// ── 5：空态分支（样本 < 2）───────────────────────────────────────────
test('B21-5：样本 < 2 的空态 branch：series 为空 + 中性「数据不足」+ 关图例/tooltip', () => {
  const context = pureContext();
  for (const samples of [[], [{ t: T0, r: 1, e: 1, m: 1 }]]) {
    const opt = context.buildTrendOption({ samples, capacity: 288, theme: TEST_THEME });
    assert.equal(opt.series.length, 0, '空态不画任何序列');
    assert.equal(opt.legend.show, false, '空态不显示图例');
    assert.equal(opt.tooltip.show, false, '空态不显示 tooltip');
    assert.match(opt.aria.label.description, /数据不足/, '空态的 aria 描述明说「数据不足」');
    assert.equal(opt.animation, false, '空态不做入场动画');
    assert.equal(opt.xAxis.type, 'time', '空态仍保留坐标系定义');
  }
});

// ── 6：全 0 不填充；错误全 0 时整条线不出现（零值不拿最重权重）────────
test('B21-6：全 0 序列不画面积；错误全 0 时整条贴底实线不出现（零值不拿最重权重）', () => {
  const context = pureContext();
  const zero = optionFor(context, [{ t: T0, r: 0, e: 0, m: 0 }, { t: T0 + 1, r: 0, e: 0, m: 0 }]);
  const zr = zero.series.find((sr) => sr.name === '请求数');
  const zb = zero.series.find((sr) => sr.name === '可用余额');
  assert.equal(zero.series.find((sr) => sr.name === '错误数'), undefined, '错误全 0 → 不画贴底实线（改由「0 错误」徽章表达）');
  assert.equal(zr.areaStyle, undefined, '全 0 请求数不填充');
  assert.equal(zb.areaStyle, undefined, '全 0 余额不填充');
  const mixed = optionFor(context, [{ t: T0, r: 2, e: 1, m: 5 }, { t: T0 + 1, r: 3, e: 0, m: 6 }]);
  const mr = mixed.series.find((sr) => sr.name === '请求数');
  const me = mixed.series.find((sr) => sr.name === '错误数');
  assert.ok(mr.areaStyle, '非全 0 请求数有填充');
  assert.equal(me.areaStyle, undefined, '错误数从不填充');
});

// ── 7：x 轴用样本时间戳 ─────────────────────────────────────────────
test('B21-7：x 取值用样本的 t（时间轴），缺失 t 也不产出 NaN', () => {
  const context = pureContext();
  const opt = optionFor(context, [{ t: T0, r: 1, e: 0, m: 2 }, { t: T0 + 300000, r: 2, e: 0, m: 3 }]);
  assert.equal(opt.series[0].data[0][0], T0, '第一个点用样本 t');
  assert.equal(opt.series[0].data[1][0], T0 + 300000, '第二个点用样本 t');
  assert.deepEqual([...opt.series[0].data.map((p) => p[1])], [1, 2]);
  const noT = optionFor(context, [{ r: 1, e: 0, m: 2 }, { r: 2, e: 0, m: 3 }]);
  assert.ok(!/NaN/.test(JSON.stringify(noT.series)), '缺 t 时退回序号，不得出现 NaN');
});

// ── 8：tooltip 带单位 ───────────────────────────────────────────────
test('B21-8：tooltip formatter 同屏三值并带单位（次 / USD）+ 时间表头', () => {
  const context = pureContext();
  const opt = optionFor(context, samplesOf(6));
  const html = opt.tooltip.formatter([
    { seriesName: '请求数', value: [T0, 1234], marker: '<i></i>' },
    { seriesName: '错误数', value: [T0, 3], marker: '<i></i>' },
    { seriesName: '可用余额', value: [T0, 17.4], marker: '<i></i>' },
  ]);
  assert.match(html, /请求数.*1,234.*次/s, '请求数带「次」');
  assert.match(html, /错误数.*3.*次/s, '错误数带「次」');
  assert.match(html, /可用余额.*17\.40.*USD/s, '余额带「USD」且两位小数');
  assert.match(html, /\d{2}-\d{2} \d{2}:\d{2}/, '表头是日期 + 时间');
});

// ── 9：aria-label 描述区间与当前值 ──────────────────────────────────
test('B21-9：aria-label 说明区间与最新值，空态也明说数据不足', () => {
  const host = { innerHTML: '' };
  const context = pureContext({
    $: (id) => (id === 'trend' ? host : null),
    esc: (v) => String(v == null ? '' : v),
    num: String, money: String,
  });
  context.renderTrend({ bucketMs: 5 * 60 * 1000, samples: [{ t: T0, r: 1, e: 2, m: 3 }, { t: T0 + 1, r: 4, e: 5, m: 6.25 }] });
  assert.match(host.innerHTML, /role="img"/, '图容器有 role=img');
  const label = /aria-label="([^"]*)"/.exec(host.innerHTML)[1];
  assert.match(label, /覆盖最近/, '说明覆盖区间');
  assert.match(label, /请求数 4 次/, '说明最新请求数');
  assert.match(label, /错误数 5 次/, '说明最新错误数');
  assert.match(label, /可用余额 6\.25 USD/, '说明最新余额');

  host.innerHTML = '';
  context.renderTrend({ bucketMs: 5 * 60 * 1000, samples: [{ r: 1 }] });
  assert.match(host.innerHTML, /role="img"[^>]*>数据不足/, '空态也给出可读的中性说明');
  assert.match(host.innerHTML, /近 24 小时趋势（数据收集中）/, 'aria-label 保留标题语义');
});

// ── 15（21c）：视觉主次：余额主角 / 请求退到背景 / 错误细红虚线 ──────
test('B21-15：视觉主次 —— 余额 2px 主角、请求 1px·0.7 淡出、错误 1px 语义红虚线', () => {
  const context = pureContext();
  const opt = optionFor(context, samplesOf(12));
  const byName = Object.fromEntries(opt.series.map((s) => [s.name, s]));
  assert.equal(byName['可用余额'].lineStyle.width, 2, '余额 2px 主角');
  assert.ok(byName['可用余额'].areaStyle, '余额带渐变面积');
  assert.equal(byName['请求数'].lineStyle.width, 1, '请求 1px');
  assert.equal(byName['请求数'].lineStyle.opacity, 0.7, '请求 0.7 透明度');
  // 面积透明度编码进渐变 stop（同色相 → alpha 0），不再叠 areaStyle.opacity：
  // 旧写法 (序列色 → transparent) 会在非预乘空间插值出暗褐，再乘 opacity 就发脏（批次 21f 第 4 条）。
  assert.equal(byName['请求数'].areaStyle.opacity, undefined, '面积不再整体 opacity');
  assert.equal(byName['请求数'].areaStyle.color.colorStops[0].color, 'rgba(1, 2, 3, 0.08)', '请求面积顶部 ~8%');
  assert.equal(byName['请求数'].areaStyle.color.colorStops[1].color, 'rgba(1, 2, 3, 0)', '请求面积底部全透明');
  assert.equal(byName['可用余额'].areaStyle.color.colorStops[0].color, 'rgba(7, 8, 9, 0.2)', '余额面积顶部 ~20%');
  assert.equal(byName['错误数'].lineStyle.width, 1, '错误 1px');
  assert.equal(byName['错误数'].lineStyle.type, 'dashed', '错误细虚线');

  // 语义红而不是橙色：错误令牌 = --danger，且不等于品牌洋红。
  const darkAt = TOKENS_CSS.indexOf(':root[data-theme="dark"] {');
  const light = TOKENS_CSS.slice(0, darkAt);
  const err = /--chart-series-error:\s*([^;]+);/.exec(light)[1].trim().toLowerCase();
  const danger = /--danger:\s*([^;]+);/.exec(light)[1].trim().toLowerCase();
  const accent = /--accent:\s*([^;]+);/.exec(light)[1].trim().toLowerCase();
  assert.equal(err, danger, '错误色 = 语义红 --danger');
  assert.notEqual(err, accent, '错误色不得等于品牌洋红');
  assert.ok(!TREND_JS.includes('c2410c') && !TREND_JS.includes('fb923c'), 'JS 里不得残留旧的橙色');
});

// ── 16（21c）：未覆盖区间可见（轴锚定真实窗口 + 极淡「无数据」带）────
test('B21-16：x 轴锚定真实窗口 —— 未覆盖的左端留白并标「无数据」', () => {
  const context = pureContext();
  const partial = optionFor(context, samplesOf(12));
  const reqData = partial.series.find((s) => s.name === '请求数').data;
  const firstT = reqData[0][0];
  const lastT = reqData[reqData.length - 1][0];
  assert.ok(partial.xAxis.min < firstT, '轴起点早于首个样本（未覆盖区间可见）');
  assert.ok(partial.xAxis.max > lastT, '轴终点在最后样本之后留余量（「现在」不贴右边缘被裁，批次 21f 第 6 条）');
  const gap = partial.series.find((s) => s.name === '无数据');
  assert.ok(gap, '未覆盖区间有极淡色带 + 「无数据」标注');
  assert.equal(gap.data[0][0], partial.xAxis.min, '带从轴起点开始');
  assert.equal(gap.data[0][2], firstT, '带到首个样本结束');
  const gapEls = gap.renderItem(
    { coordSys: { x: 0, y: 0, width: 400, height: 200 } },
    {
      value: (i) => gap.data[0][i],
      coord: (p) => [(p[0] - partial.xAxis.min) / (partial.xAxis.max - partial.xAxis.min) * 400, 0],
    },
  );
  assert.match(JSON.stringify(gapEls), /无数据/, '带上有「无数据」文字');
  assert.ok(partial.series.find((s) => s.name === '请求数').markArea === undefined,
    '不再用 markArea（polygon 画不出圆角），改由 custom series 承载');

  const full = optionFor(context, samplesOf(288));
  const fullFirst = full.series.find((s) => s.name === '请求数').data[0][0];
  assert.equal(full.xAxis.min, fullFirst, '满窗时轴起点 = 首个样本（不留假空白）');
  assert.equal(full.series.some((s) => s.name === '无数据'), false, '满窗不画「无数据」带');
});

// ── 17（21c）：充值跳变标注 + 「现在」终止标记 ──────────────────────
test('B21-17：余额阶跃标出「充值 +X USD」，数据末端标「现在」', () => {
  const context = pureContext();
  const samples = samplesOf(12).map((s, i) => ({ ...s, m: i < 8 ? 5 : 15 }));
  const opt = optionFor(context, samples);
  const bal = opt.series.find((s) => s.name === '可用余额');
  assert.ok(bal.markPoint, '有充值标注');
  assert.equal(bal.markPoint.data[0].coord[0], samples[8].t, '标注在跳变后的样本处');
  assert.equal(bal.markPoint.data[0].coord[1], 15, '标注在跳变后的余额上');
  assert.equal(bal.markPoint.label.formatter, context.trendClock(samples[8].t) + ' 充值 +10.00 USD',
    '充值额 = 两个样本差值（15 - 5），并补上该样本的 HH:mm 时间');
  assert.ok(bal.markLine, '有「现在」终止虚线');
  assert.equal(bal.markLine.data[0].xAxis, samples[samples.length - 1].t);
  assert.match(bal.markLine.label.formatter, /现在/);
});

// ── 18（21c）：DOM 副标题 + 摘要色点 + 「0 错误」正向徽章 ───────────
test('B21-18：DOM —— 副标题、摘要色点、0 错误正向徽章（不再是纯灰脚注）', () => {
  const host = { innerHTML: '' };
  const context = pureContext({
    $: (id) => (id === 'trend' ? host : null),
    esc: (v) => String(v == null ? '' : v),
    num: String, money: String,
  });
  const zero = Array.from({ length: 6 }, (_, i) => ({ t: T0 + i * 300000, r: 3, e: 0, m: 1 }));
  context.renderTrend({ bucketMs: 5 * 60 * 1000, samples: zero });
  assert.match(host.innerHTML, /class="trend-sub"/, '区间文案进副标题（不再是靠右的纯灰小字）');
  assert.match(host.innerHTML, /class="trend-pill trend-pill-ok">0 错误/, '错误全 0 → 正向「0 错误」徽章');
  assert.equal((host.innerHTML.match(/class="trend-dot /g) || []).length, 3, '摘要三条读数各带一枚色点');
  assert.match(host.innerHTML, /trend-dot-request/, '请求色点');
  assert.match(host.innerHTML, /trend-dot-balance/, '余额色点');
  assert.match(host.innerHTML, /trend-dot-error is-zero/, '错误为 0 时色点弱化，不抢视觉');
  assert.match(host.innerHTML, /最新样本/, '脚注写明余额是「最新样本」口径');

  host.innerHTML = '';
  const withErr = zero.map((s, i) => ({ ...s, e: i === 3 ? 2 : 0 }));
  context.renderTrend({ bucketMs: 5 * 60 * 1000, samples: withErr });
  assert.ok(!/trend-pill-ok/.test(host.innerHTML), '有错误时不出现「0 错误」徽章');
  assert.match(host.innerHTML, /trend-dot-error"/, '有错误时色点用语义红');
});

// ── 10：懒加载（假 document + 假 echarts）───────────────────────────
test('B21-10：ensureTrendECharts 动态插 <script>、去重、失败返回 null；无 document 安全返回 null', async () => {
  // 无 document：安全 no-op
  const bare = pureContext();
  assert.equal(await bare.ensureTrendECharts(), null, '测试环境没有 document → 返回 null');

  const makeLoader = () => {
    const appended = [];
    const script = { src: '', async: false, onload: null, onerror: null };
    const parent = { appendChild: (el) => { appended.push(el); return el; } };
    const document = { createElement: () => script, body: parent, documentElement: parent };
    return { context: pureContext({ document }), appended, script };
  };

  // 加载失败：优雅返回 null
  const fail = makeLoader();
  const p1 = fail.context.ensureTrendECharts();
  assert.equal(fail.appended.length, 1, '动态插入了 1 个 <script>');
  assert.equal(fail.appended[0].src, fail.context.TREND_ECHARTS_SRC, 'src 指向同源 vendored 路径');
  assert.match(fail.appended[0].src, /^vendor\/echarts\.min\.js\?v=.+/, 'src 必须带内容版本串（破 immutable 缓存）');
  assert.equal(fail.appended[0].async, true, 'async 加载，不阻塞解析');
  const p2 = fail.context.ensureTrendECharts();
  assert.equal(fail.appended.length, 1, '同一实例内只插入一次（promise 去重）');
  fail.appended[0].onerror();
  assert.equal(await p1, null, 'onerror → 优雅降级');
  assert.equal(await p2, null);

  // 加载成功：拿到 globalThis.echarts
  const ok = makeLoader();
  const p3 = ok.context.ensureTrendECharts();
  const fake = { version: '6.1.0' };
  ok.context.echarts = fake;
  ok.appended[0].onload();
  assert.equal(await p3, fake, 'onload → 返回 globalThis.echarts');
  assert.equal(await ok.context.ensureTrendECharts(), fake, '已加载过则直接返回（不再插标签）');
  assert.equal(ok.appended.length, 1);
});

// ── 11：挂载路径安全跳过 ────────────────────────────────────────────
test('B21-11：没有 ECharts 时 mountTrendChart 安全返回 false（不抛、文本摘要仍可用）', () => {
  const host = { innerHTML: '' };
  const context = pureContext({
    $: (id) => (id === 'trend' ? host : null),
    esc: (v) => String(v == null ? '' : v),
    num: String, money: String,
  });
  assert.equal(context.mountTrendChart({}, {}), false, '无 echarts → false');
  context.echarts = { init() { throw new Error('boom'); } };
  assert.equal(context.mountTrendChart({}, {}), false, 'init 抛错 → 吞掉并返回 false');
  context.echarts = { init() { return {}; } };
  assert.equal(context.mountTrendChart({}, {}), false, '实例没有 setOption → false');

  // 渲染本身不抛，且文本摘要始终在
  context.renderTrend({ bucketMs: 5 * 60 * 1000, samples: samplesOf(8) });
  assert.match(host.innerHTML, /class="trend-summary"/, '挂载失败也保留文本摘要');
  assert.match(host.innerHTML, /class="trend-fallback"[^>]*hidden/, '失败说明默认隐藏，只有真失败才亮出');
});

// ── 12：首屏不引 ECharts（懒加载证据）──────────────────────────────
test('B21-12：index.html 没有 vendor 静态 script；ECharts 不进 package.json', () => {
  assert.ok(!/<script[^>]*src="[^"]*vendor\//.test(INDEX_HTML), 'index.html 不得静态引 vendor 库');
  assert.ok(!/<script[^>]*src="[^"]*echarts/.test(INDEX_HTML));
  assert.ok(!('#trend' in {}) && INDEX_HTML.includes('id="trend"'), '趋势容器仍在 index.html');
  assert.ok(!('dependencies' in PKG) && !('devDependencies' in PKG), 'ECharts 不放进 package.json');
  assert.match(TREND_JS, /TREND_ECHARTS_SRC\s*=\s*'vendor\/echarts\.min\.js\?v='\s*\+\s*TREND_ECHARTS_BUILD/, '懒加载路径写死在 render-trend.js 且带内容版本串');
});

// ── 13：/vendor/ 长缓存（真实网关）──────────────────────────────────
test('B21-13：/vendor/ 命中真实文件才发 immutable 长缓存，css/js 仍 no-cache，未命中 404', async (t) => {
  const ctx = await startTestGateway({ noInitialRefresh: true });
  t.after(() => ctx.close());

  const vendor = await request(`${ctx.baseUrl}/vendor/echarts.min.js`);
  assert.equal(vendor.status, 200, 'vendored 库必须能同源取到');
  assert.match(vendor.headers['content-type'], /javascript/, '按 .js 提供');
  assert.equal(vendor.headers['cache-control'], 'public, max-age=31536000, immutable', '长缓存 immutable');
  assert.ok(vendor.body.length > 1_000_000, '返回的是完整全量库文件（>1MB，不是被截断的片段 / 部分构建）');
  assert.ok(vendor.body.includes('version:"6.1.0"'), '返回内容确为 ECharts 6.1.0');

  const versioned = await request(`${ctx.baseUrl}/vendor/echarts.min.js?v=6.1.0-b66b25ae`);
  assert.equal(versioned.status, 200, '带 ?v= 查询串仍命中静态文件（路由用 url.pathname，查询串不参与命中）');
  assert.equal(versioned.headers['cache-control'], 'public, max-age=31536000, immutable', '带版本串仍走 immutable 长缓存');

  const css = await request(`${ctx.baseUrl}/css/tokens.css`);
  assert.equal(css.headers['cache-control'], 'no-cache', 'public/css 行为不变');
  const js = await request(`${ctx.baseUrl}/js/render-trend.js`);
  assert.equal(js.headers['cache-control'], 'no-cache', 'public/js 行为不变');

  const miss = await request(`${ctx.baseUrl}/vendor/definitely-missing.js`);
  assert.equal(miss.status, 404, '没有真实文件就 404');
  assert.notEqual(miss.headers['cache-control'], 'public, max-age=31536000, immutable', '未命中不得发 immutable');

  const traversal = await request(`${ctx.baseUrl}/vendor/..%2f..%2fpackage.json`);
  assert.equal(traversal.status, 404, '路径穿越仍被拒绝');
});

// ── 14：库文件与署名信息一致 ────────────────────────────────────────
test('B21-14：public/vendor/README.md 记录版本 / 来源 / 许可证 / sha256，与库文件一致', () => {
  const buf = fs.readFileSync(new URL('../public/vendor/echarts.min.js', import.meta.url));
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  assert.match(VENDOR_README, /6\.1\.0/, '记录版本 6.1.0');
  assert.match(VENDOR_README, /Apache-2\.0/, '记录许可证 Apache-2.0');
  assert.match(VENDOR_README, /全量/, '记录用的是全量构建');
  assert.match(VENDOR_README, /common/, 'README 保留「common 会静默丢 custom series」的警示');
  assert.match(VENDOR_README, /simple/, 'README 保留「simple 会静默丢 mark*」的警示');
  assert.match(VENDOR_README, /renderItem|custom/i, 'README 记录 custom series / renderItem 这条坑');
  assert.match(VENDOR_README, /npm/, '记录来源是 npm');
  assert.ok(VENDOR_README.includes(sha), 'README 里的 sha256 必须与库文件一致');
  assert.ok(VENDOR_README.includes(String(buf.length)), 'README 里的大小必须与库文件一致');
  assert.match(VENDOR_README, /改文件名|版本参数/, '升级必须改文件名 / 加版本参数');
  assert.match(buf.toString('utf8', 0, 400), /Apache/, '库文件头部保留 Apache 许可声明');
});

// ── 28（21g）：vendor 构建身份防回归 —— 只认「全量构建」──────────────
//   教训（同一个坑踩了两次，所以不再用掐头去尾的部分构建）：
//     1) `simple` 精简构建里 markLine / markArea / markPoint 的字符串只在「注册名清单」
//        里出现，组件实现并未打进包 → option 里写了 mark* 也静默不渲染（21d 踩过）；
//     2) `common` 构建不含 custom series 实现（压缩版里 `renderItem` 出现 0 次）→
//        21f 用 custom series 画的「无数据」带在浏览器里一个 polygon 都不出（21g 定位）。
//   所以把「构建身份」钉死在全量构建上：谁把 vendor 换成 common / simple（或任何不含
//   mark* / custom 的瘦构建），这里必须在 Node 里就变红，而不是留到浏览器里静默丢功能。
//   ⚠️ 真有意升级 ECharts（换构建 / 升版本）时，必须同步改下面三个常量 + public/vendor/README.md。
const EXPECTED_VENDOR_SHA256 = 'b66b25aeb4df84e33199dc21694014d336d222cbd9deb0e5a7c14bd6aa0d0fd0';
const EXPECTED_MIN_MARK_OCCURRENCES = 8;
const EXPECTED_MIN_RENDER_ITEM_OCCURRENCES = 1;

test('B21-28 vendor 必须是全量构建（部分构建会静默丢掉 mark*/custom，配置写了也画不出来）', () => {
  const buf = fs.readFileSync(new URL('../public/vendor/echarts.min.js', import.meta.url));
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  assert.equal(sha, EXPECTED_VENDOR_SHA256,
    'vendor 构建身份变了。有意升级请同步本测试 + public/vendor/README.md；' +
    '若非有意，八成又被换回了 common / simple 瘦构建（它在 Node 里不会报错，' +
    '只会在浏览器里静默丢 mark* / custom 图元）');

  // 体积门槛：全量 ~1.07MB；common = 715,020、simple = 500,315，都会被这条线拦下。
  assert.ok(buf.length > 1_000_000,
    'vendor 体积只有 ' + buf.length + ' 字节，太小了 —— 全量构建约 1.07MB；' +
    'common(≈715KB) / simple(≈500KB) 都落在这条线以下，说明又被换成了部分构建');

  const src = buf.toString('utf8');
  for (const name of ['markLine', 'markArea', 'markPoint']) {
    const count = (src.match(new RegExp(name, 'g')) || []).length;
    assert.ok(count >= EXPECTED_MIN_MARK_OCCURRENCES,
      name + ' 在 vendor 里只出现 ' + count + ' 次（期望 ≥ ' + EXPECTED_MIN_MARK_OCCURRENCES + '）。' +
      'simple 构建是 3/2/3：字符串只在注册名清单里、组件实现没打进去，' +
      '因此 option 里写了 mark* 也画不出来。必须用 dist/echarts.min.js 全量构建。');
  }

  // 专门防「构建不含 custom series」：common 压缩版里 renderItem 出现 0 次，
  // 「无数据」带用的 custom series 会整个静默不渲染（21g 的回归根因）。
  const renderItemCount = (src.match(/renderItem/g) || []).length;
  assert.ok(renderItemCount >= EXPECTED_MIN_RENDER_ITEM_OCCURRENCES,
    'renderItem 在 vendor 里只出现 ' + renderItemCount + ' 次（期望 ≥ ' +
    EXPECTED_MIN_RENDER_ITEM_OCCURRENCES + '）。缺它说明构建不含 custom series 实现，' +
    '「无数据」带等自定义图元写了也不会画 —— 必须用 dist/echarts.min.js 全量构建。');
});

// ── 20（21d）：网格透明度只由令牌承载 + 「现在」游标对比度 ───────────
test('B21-20：splitLine 不再叠 opacity；两套主题的 --chart-cursor 都 ≥ 0.7 保证可见', () => {
  const context = pureContext();
  const opt = optionFor(context, samplesOf(12));
  for (const [label, axis] of [['x', opt.xAxis], ['左 Y', opt.yAxis[0]]]) {
    assert.equal(axis.splitLine.lineStyle.opacity, undefined,
      label + ' 轴网格的透明度必须只由令牌承载，不得再叠 lineStyle.opacity');
  }
  const darkAt = TOKENS_CSS.indexOf(':root[data-theme="dark"] {');
  const light = TOKENS_CSS.slice(0, darkAt);
  const dark = TOKENS_CSS.slice(darkAt);
  for (const [block, name] of [[light, '浅色'], [dark, '深色']]) {
    const cursor = /--chart-cursor:\s*rgba\([^)]*,\s*([\d.]+)\s*\)/.exec(block);
    assert.ok(cursor, name + '主题必须给出 --chart-cursor 的 rgba 值');
    assert.ok(Number(cursor[1]) >= 0.7,
      name + '主题游标透明度 ' + cursor[1] + ' 必须 ≥ 0.7（~50% 太淡，换 common 构建画出后仍看不清）');
  }
});

// ── 21（21e）：懒加载 URL 的内容版本锁 ──────────────────────────────
//   /vendor/ 发 immutable 一年长缓存。若 URL 不随库文件内容变化，老用户会一直吃缓存里
//   的旧构建：simple → common 换库后 mark* 永远画不出来，而无缓存浏览器验收会「假通过」。
//   这里把 TREND_ECHARTS_BUILD 与库文件 sha256 前 8 位锁死：换库不改版本串必红。
test('B21-21 vendor URL 的版本串必须随库文件内容变化（否则 immutable 缓存吃掉更新）', () => {
  const context = pureContext();
  assert.equal(typeof context.TREND_ECHARTS_BUILD, 'string',
    '必须从 render-trend.js 导出 TREND_ECHARTS_BUILD 供测试核对');
  assert.equal(typeof context.TREND_ECHARTS_SRC, 'string', '必须导出 TREND_ECHARTS_SRC');

  const buf = fs.readFileSync(new URL('../public/vendor/echarts.min.js', import.meta.url));
  const shortSha = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 8);
  assert.ok(context.TREND_ECHARTS_BUILD.includes(shortSha),
    'TREND_ECHARTS_BUILD（' + context.TREND_ECHARTS_BUILD + '）必须包含 public/vendor/echarts.min.js 的 ' +
    'sha256 前 8 位（' + shortSha + '）。换库文件却忘了改版本串 → 老浏览器继续用 immutable 缓存里的旧构建，' +
    '更新对老用户静默失效');

  assert.equal(context.TREND_ECHARTS_SRC, 'vendor/echarts.min.js?v=' + context.TREND_ECHARTS_BUILD,
    'src 必须由同源路径 + 内容版本串拼成');
  assert.ok(context.TREND_ECHARTS_SRC.includes(shortSha), '最终 URL 里必须带内容指纹');
  assert.match(context.TREND_ECHARTS_SRC, /^vendor\/echarts\.min\.js\?v=.+/, 'URL 形态 = 路径 + ?v=指纹');
});

// ══ 批次 21f：趋势图最后一轮打磨（用户标准：好看）══════════════════════
// 每一条都对应真实浏览器 + 截图确认过的观感问题；断言锁的是「怎么修」，不是「随手放宽」。

// ── 22（21f）：轴量程贴合数据（旧的 0/30/60/90 让图压在底部三分之一）──────
test('B21-22：左/右轴上限贴合数据峰值（×1.15 取整），min 仍恒为 0', () => {
  const context = pureContext();
  const samples = Array.from({ length: 24 }, (_, i) => ({
    t: T0 + i * 300_000, r: i === 12 ? 31 : i % 5, e: i === 8 ? 4 : 0, m: 10 + (i % 7),
  }));
  const opt = optionFor(context, samples);
  const left = opt.yAxis[0];
  const right = opt.yAxis[1];
  assert.equal(left.min, 0, '左轴零基准不动（13c 红线）');
  assert.equal(right.min, 0, '右轴零基准不动');
  assert.ok(left.max >= 31, '左轴上限不得低于请求峰值');
  assert.ok(left.max <= 31 * 1.5, '左轴上限必须贴合峰值（不再是峰值的 3 倍空档），实际 ' + left.max);
  assert.equal(left.interval % 1, 0, '计数轴步长必须是整数');
  assert.equal(left.max % left.interval, 0, '上限是步长整数倍（末刻度 = 上限，不留空档）');
  assert.ok(right.max >= 16, '右轴上限不低于余额峰值');
  assert.ok(right.max <= 16 * 1.5, '右轴上限贴合余额峰值，实际 ' + right.max);

  const allZero = optionFor(context, [{ t: T0, r: 0, e: 0, m: 0 }, { t: T0 + 1, r: 0, e: 0, m: 0 }]);
  assert.equal(allZero.yAxis[0].max, undefined, '全 0 不伪造量程（交给 ECharts 默认）');
  assert.equal(allZero.yAxis[1].max, undefined, '全 0 余额轴同样不伪造');
});

// ── 23（21f）：双 Y 轴归属 —— 轴名与对应序列同色 ─────────────────────
test('B21-23：左轴名「次」= 请求冷灰、右轴名「USD」= 余额洋红（只此一种归属做法）', () => {
  const context = pureContext();
  const opt = optionFor(context, samplesOf(12));
  assert.equal(opt.yAxis[0].name, '次');
  assert.equal(opt.yAxis[0].nameTextStyle.color, TEST_THEME.request, '左轴名用请求线色');
  assert.equal(opt.yAxis[1].name, 'USD');
  assert.equal(opt.yAxis[1].nameTextStyle.color, TEST_THEME.balance, '右轴名用余额线色');
  assert.notEqual(opt.yAxis[0].nameTextStyle.color, opt.yAxis[1].nameTextStyle.color, '两轴名不同色才分得清');
});

// ── 24（21f）：图例出绘图区 + 更大色点 / 字号 / 间距 + 逐项同色 ──────
test('B21-24：图例移到绘图区上方独立一行、色点 8~10px、序列名走正文档对比度、间距拉开', () => {
  const context = pureContext();
  const opt = optionFor(context, samplesOf(12));
  assert.ok(opt.legend.itemWidth >= 8 && opt.legend.itemWidth <= 10, '图例色点 8~10px，实际 ' + opt.legend.itemWidth);
  assert.equal(opt.legend.itemHeight, opt.legend.itemWidth, '色点正圆');
  assert.ok(opt.legend.itemGap >= 18, '图例项间距拉开');
  assert.ok(opt.legend.textStyle.fontSize >= 13, '图例字号不小于页面正文 --fs-sm(13)');
  assert.equal(opt.legend.textStyle.color, TEST_THEME.tooltipText, '序列名用主文字对比度令牌（不再是 11px 浅灰）');
  assert.ok(Number(opt.legend.textStyle.fontWeight) >= 600, '图例名加粗，扫一眼可读');
  assert.ok(opt.grid.top >= 42, '绘图区顶部让出一整条图例行，图例不再压进图里');
  assert.deepEqual([...opt.legend.data], ['请求数', '错误数', '可用余额'], '图例项只列真正画出来的序列');

  const zero = optionFor(context, [{ t: T0, r: 1, e: 0, m: 1 }, { t: T0 + 1, r: 2, e: 0, m: 2 }]);
  assert.deepEqual([...zero.legend.data], ['请求数', '可用余额'], '错误全 0 时不留幽灵图例项');
});

// ── 25（21f）：错误 0 值置 null、connectNulls false → 零星事件 ──────
test('B21-25：错误数 0 样本置 null（0 值不连线），非 0 处打点相连；全 0 仍整条消失', () => {
  const context = pureContext();
  const samples = [
    { t: T0, r: 1, e: 0, m: 1 },
    { t: T0 + 300_000, r: 2, e: 3, m: 1 },
    { t: T0 + 600_000, r: 1, e: 0, m: 1 },
    { t: T0 + 900_000, r: 1, e: 2, m: 1 },
  ];
  const opt = optionFor(context, samples);
  const err = opt.series.find((s) => s.name === '错误数');
  assert.equal(err.connectNulls, false, '不得跨过 0 样本连线');
  assert.deepEqual([...err.data.map((p) => p[1])], [null, 3, null, 2], '0 → null，非 0 保留');
  assert.equal(typeof err.symbolSize, 'function');
  assert.equal(err.symbolSize([0, 0]), 0, '0 / null 处不画点');
  assert.ok(err.symbolSize([0, 3]) > 0, '非 0 处画点');
  assert.equal(err.lineStyle.type, 'dashed', '仍是语义红细虚线（批次 21c 视觉主次不变）');

  const zero = optionFor(context, [{ t: T0, r: 1, e: 0, m: 1 }, { t: T0 + 1, r: 2, e: 0, m: 2 }]);
  assert.equal(zero.series.find((s) => s.name === '错误数'), undefined, '全 0 仍整条不出现');
  assert.ok(!zero.legend.data.includes('错误数'), '全 0 图例项也不出现');
});

// ── 26（21f）：x 轴右端留白 + 「现在」不再像被裁掉 ──────────────────
test('B21-26：x 轴右端留白（「现在」不贴边）+ 终止标签字号/字重提档', () => {
  const context = pureContext();
  const samples = samplesOf(12);
  const opt = optionFor(context, samples);
  const lastT = samples[samples.length - 1].t;
  assert.ok(opt.xAxis.max > lastT, '轴终点在最后样本之后，右端有呼吸空间');
  assert.ok(opt.xAxis.max - lastT >= 10 * 60 * 1000, '右端至少留 2 个 5 分钟桶（≥10 分钟）余量');
  const bal = opt.series.find((s) => s.name === '可用余额');
  assert.equal(bal.markLine.data[0].xAxis, lastT, '「现在」仍锚在最后样本上');
  assert.ok(bal.markLine.label.fontSize >= 11, '「现在」标签字号 ≥11');
  assert.ok(Number(bal.markLine.label.fontWeight) >= 600, '「现在」标签加粗，不淹没在网格里');
  assert.equal(bal.markLine.label.color, TEST_THEME.tooltipText, '「现在」标签用主文字对比度令牌');
  assert.equal(bal.markLine.label.rotate, 0, '「现在」标签必须横排（竖线默认会把文字转 90°）');
  assert.equal(bal.markLine.label.fontSize, opt.legend.textStyle.fontSize, '「现在」字号与图例一致');
});

// ── 27（21f）：「无数据」色带右端真圆角 + 低不透明度（像素空间 custom series）──
test('B21-27：「无数据」带用 custom series 在像素空间画右端圆角矩形 + 不透明度 ~0.2', () => {
  const context = pureContext();
  const opt = optionFor(context, samplesOf(12));
  const gap = opt.series.find((s) => s.name === '无数据');
  assert.ok(gap, '「无数据」带用 custom series 画（markArea 的 polygon 画不出圆角）');
  assert.equal(gap.z, 0, '垫在三条数据线之下');
  assert.equal(gap.tooltip.show, false, '不进 tooltip');
  assert.equal(gap.silent, true);
  assert.equal(opt.tooltip.formatter([{ seriesName: '无数据', value: [T0, 0] }]), '',
    '辅助 series 即便混进 params 也不进 tooltip');

  const api = {
    value: (i) => gap.data[0][i],
    coord: (p) => [(p[0] - opt.xAxis.min) / (opt.xAxis.max - opt.xAxis.min) * 400, 0],
  };
  const out = gap.renderItem({ coordSys: { x: 0, y: 0, width: 400, height: 200 } }, api);
  assert.ok(!Array.isArray(out), 'renderItem 绝不能返回数组 —— ECharts 6 会因此抛错、整张图被隐藏（21g 线上事故）');
  assert.equal(out.type, 'group', '多图元必须包成一个 group，用 children 承载');
  const els = out.children;
  assert.ok(Array.isArray(els), 'group 用 children 承载图元');
  const poly = els.find((el) => el.type === 'polygon');
  const text = els.find((el) => el.type === 'text');
  assert.ok(poly && text, '返回矩形 + 文字两类图元');
  assert.equal(text.style.text, '无数据');
  assert.ok(poly.style.opacity >= 0.15 && poly.style.opacity <= 0.25, '不透明度 ~0.2 档，实际 ' + poly.style.opacity);
  const pts = poly.shape.points;
  assert.ok(pts.length > 6, '右端用圆弧点描出圆角（不是普通 4 角矩形）');
  assert.equal(Math.min(...pts.map((p) => p[1])), 0, '带覆盖绘图区顶部');
  assert.equal(Math.max(...pts.map((p) => p[1])), 200, '带覆盖绘图区底部');
  assert.equal(Math.min(...pts.map((p) => p[0])), 0, '左端贴轴（方角）');
  // 圆角：存在 x 落在右端半径内、y 既非 0 也非 200 的弧点。
  const rightX = api.coord([gap.data[0][2], 0])[0];
  const curved = pts.filter((p) => p[0] > rightX - 10 && p[1] > 0 && p[1] < 200);
  assert.ok(curved.length >= 6, '右端上下两个圆角各由弧点构成，实际 ' + curved.length);
});

// ════════════════════════════════════════════════════════════════════
// 批次 21h：两个真 bug 的回归
//   BUG 1：挂载失败把图容器 hidden，之后成功也没纠回来（线上完全看不到图）
//   BUG 2：缺口带用 custom series + renderItem 返回**数组** → ECharts 6 抛错，
//          setOption 整个失败（既是 BUG 2 的根因，也是 BUG 1 的「第一次失败」来源）
// ════════════════════════════════════════════════════════════════════

// ── 29（21h）：拿真实 ECharts 6.1.0 渲染，缺口带必须真的画得出来 ──────
// 只断言 option 字段是抓不到这个 bug 的：option 里 custom series 一切正常，
// 但 renderItem 返回数组会让 ECharts 在 graphic 转换里 `throw new Error()`（消息为空），
// setOption 整体失败。这里用 SSR 走同一条管线：修复前 setOption 抛错 + SVG 无「无数据」。
test('B21-29：真实 ECharts 渲染 —— renderItem 不抛错，SVG 里必须有「无数据」', () => {
  const echarts = loadVendoredECharts();
  assert.equal(echarts.version, '6.1.0', '用 vendored 的真实 ECharts 6.1.0 渲染');
  const context = pureContext();
  const opt = optionFor(context, samplesOf(12), { reducedMotion: true });
  const gap = opt.series.find((s) => s.name === '无数据');
  assert.ok(gap, '缺口足够时 option 里必须有「无数据」序列');

  const chart = echarts.init(null, null, { renderer: 'svg', ssr: true, width: 1190, height: 260 });
  try {
    assert.doesNotThrow(() => chart.setOption(opt),
      'setOption 不得抛错：ECharts 6 的 renderItem 只接受单个图元，返回数组会炸掉整张图（21g 线上）');
    const svg = chart.renderToSVGString();
    assert.match(svg, /无数据/, '渲染出的 SVG 里必须出现「无数据」文案（带子不能静默消失）');
  } finally {
    try { chart.dispose(); } catch { /* 忽略 */ }
  }
});

// ── 30（21h）：缺口带存在时的完整渲染配置（名字判定，不再只看 type）────
test('B21-30：缺口足够时 series 必须含「无数据」带，且圆角 / 文案 / silent / tooltip / z 全在', () => {
  const context = pureContext();
  const opt = optionFor(context, samplesOf(12));
  const gap = opt.series.find((s) => s.name === '无数据');
  assert.ok(gap, '存在足够缺口（12 < 288 个样本）时 option.series 必须包含「无数据」带');
  assert.equal(gap.type, 'custom', '带子由 custom series 承载（保留圆角）');
  assert.equal(gap.silent, true, '带子静默，不吃交互');
  assert.equal(gap.tooltip.show, false, '带子不进 tooltip');
  assert.equal(gap.z, 0, '带子垫在三条数据线之下');
  assert.equal(gap.legendHoverLink, false, '带子不进图例高亮');

  const out = gap.renderItem(
    { coordSys: { x: 0, y: 0, width: 400, height: 200 } },
    {
      value: (i) => gap.data[0][i],
      coord: (pt) => [(pt[0] - opt.xAxis.min) / (opt.xAxis.max - opt.xAxis.min) * 400, 0],
    },
  );
  assert.equal(out.type, 'group');
  const poly = out.children.find((el) => el.type === 'polygon');
  const text = out.children.find((el) => el.type === 'text');
  assert.ok(poly && text, '矩形 + 「无数据」文字两类图元都在');
  assert.equal(text.style.text, '无数据');
  assert.ok(poly.style.opacity >= 0.15 && poly.style.opacity <= 0.25,
    '不透明度落在 0.15~0.25，实际 ' + poly.style.opacity);
  assert.ok(poly.shape.points.length > 6, '右端圆角仍在（圆弧点描边）');

  // 满窗（无缺口）时不画带子，避免把轴两端都涂成灰条。
  const full = optionFor(context, samplesOf(288));
  assert.equal(full.series.some((s2) => s2.name === '无数据'), false, '满窗不画「无数据」带');
});

// ── 31（21h）：挂载成功 → 图表可见、降级说明隐藏（断言 hidden 属性）───
test('B21-31：挂载成功后 chartEl.hidden=false（且无 hidden 属性）、fallbackEl.hidden=true', () => {
  const host = shimTrendHost();
  const context = trendContext(host, fakeECharts());
  context.renderTrend({ bucketMs: 5 * 60 * 1000, samples: samplesOf(8) });

  const chart = host.querySelector('.trend-chart');
  const fallback = host.querySelector('.trend-fallback');
  assert.ok(chart && fallback, '两个节点都存在');
  assert.equal(chart.hidden, false, '挂载成功 → 图容器可见');
  assert.equal(chart.hasAttribute('hidden'), false, 'hidden 属性必须被移除（不只看 style）');
  assert.equal(fallback.hidden, true, '挂载成功 → 降级说明收起');
  assert.equal(fallback.hasAttribute('hidden'), true, '降级说明带 hidden 属性');
});

// ── 32（21h，最关键）：失败 → 成功 的恢复态必须被纠回来 ───────────────
test('B21-32：失败 → 成功恢复态 —— 最终图表可见、降级提示收起（对应线上永久失败态）', async () => {
  const host = shimTrendHost();
  const context = trendContext(host);   // 无 echarts、无 document → 走失败/降级路径

  context.renderTrend({ bucketMs: 5 * 60 * 1000, samples: samplesOf(8) });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(host.querySelector('.trend-chart').hidden, true, '第一次失败：图表被隐藏');
  assert.equal(host.querySelector('.trend-fallback').hidden, false, '第一次失败：降级提示亮出');

  // 库恢复可用，下一次渲染必须把可见性纠回来（旧代码会永久钉在失败态）。
  context.echarts = fakeECharts();
  context.renderTrend({ bucketMs: 5 * 60 * 1000, samples: samplesOf(8) });
  const chart = host.querySelector('.trend-chart');
  const fallback = host.querySelector('.trend-fallback');
  assert.equal(chart.hidden, false, '恢复态：最终图表必须可见');
  assert.equal(chart.hasAttribute('hidden'), false, '恢复态：hidden 属性必须被移除');
  assert.equal(fallback.hidden, true, '恢复态：降级提示必须收起');
  assert.equal(fallback.hasAttribute('hidden'), true, '恢复态：降级提示带 hidden 属性');
});

// ── 33（21h）：反向 —— 成功 → 失败后降级提示可见、图表隐藏 ───────────
test('B21-33：成功 → 失败 —— 最终降级提示可见、图表隐藏', () => {
  const host = shimTrendHost();
  const context = trendContext(host, fakeECharts());
  context.renderTrend({ bucketMs: 5 * 60 * 1000, samples: samplesOf(8) });
  assert.equal(host.querySelector('.trend-chart').hidden, false, '先成功后图表可见');

  context.echarts = boomECharts();     // setOption 抛错 → 挂载失败
  context.renderTrend({ bucketMs: 5 * 60 * 1000, samples: samplesOf(8) });
  const chart = host.querySelector('.trend-chart');
  const fallback = host.querySelector('.trend-fallback');
  assert.equal(chart.hidden, true, '挂载失败后图表隐藏');
  assert.equal(chart.hasAttribute('hidden'), true, '隐藏要落到 hidden 属性上');
  assert.equal(fallback.hidden, false, '挂载失败后降级提示亮出');
  assert.equal(fallback.hasAttribute('hidden'), false, '降级提示的 hidden 属性被移除');
});

// ── 34（21h）：加载失败不永久缓存 —— 下一次会重新尝试 ─────────────────
test('B21-34：ensureTrendECharts 失败后不永久缓存，第二次调用重新插 <script> 且能成功', async () => {
  const appended = [];
  const script = { src: '', async: false, onload: null, onerror: null };
  const parent = { appendChild: (el) => { appended.push(el); return el; } };
  const document = { createElement: () => script, body: parent, documentElement: parent };
  const context = pureContext({ document });

  const first = context.ensureTrendECharts();
  assert.equal(appended.length, 1, '第一次插一个 <script>');
  appended[0].onerror();
  assert.equal(await first, null, '第一次失败返回 null');

  const second = context.ensureTrendECharts();
  assert.equal(appended.length, 2, '失败不缓存：第二次必须重新插 <script>（一次性抖动不该让图永久消失）');
  const fake = { version: '6.1.0' };
  context.echarts = fake;
  appended[1].onload();
  assert.equal(await second, fake, '重试成功拿到库');
  assert.equal(appended.length, 2, '成功后再调用直接走 globalThis.echarts，不再插标签');
  assert.equal(await context.ensureTrendECharts(), fake);
});

// ════════════════════════════════════════════════════════════════════
// 批次 21i：趋势图收尾打磨（图例一行 / 横向网格对比度 / 「现在」安静横排 / 充值锚点）
//   四项都对应独立可复现的观感问题；断言锁的是「怎么修」，不是随手放宽。
// ════════════════════════════════════════════════════════════════════

/** WCAG 相对对比度（#rrggbb），用来把「网格太淡」变成可算的数字。 */
function contrastRatio(a, b) {
  const parse = (h) => { const x = String(h).replace('#', ''); return [0, 2, 4].map((i) => parseInt(x.slice(i, i + 2), 16)); };
  const lum = ([r, g, bl]) => {
    const f = (c) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(bl);
  };
  const la = lum(parse(a)); const lb = lum(parse(b));
  const hi = Math.max(la, lb); const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/** 从一段 CSS 文本里取令牌值（去掉首尾空白）。 */
function tokenValue(block, name) {
  const m = new RegExp(name + ':\\s*([^;]+);').exec(block);
  return m ? m[1].trim() : '';
}

// ── 35（21i）：图例 = 纯序列名 + 单位只挂轴名；真实 ECharts 下三项同一行 ──
test('B21-35：图例三项纯序列名、单位只在轴名上；真实 ECharts 宽/窄屏都同一行', () => {
  const context = pureContext();
  const opt = optionFor(context, samplesOf(12));
  assert.deepEqual([...opt.legend.data], ['请求数', '错误数', '可用余额'], '图例 = 纯序列名');
  for (const name of opt.legend.data) {
    assert.ok(!/USD|次|·/.test(name), '图例项不得带单位 / 分隔符：' + name);
  }
  assert.equal(opt.legend.orient, 'horizontal', '图例横向排布');
  assert.equal(opt.legend.left, 'center', '图例整块居中（窄屏折行的兜底）');
  assert.equal(opt.yAxis[0].name, '次', '计数单位挂在左轴名');
  assert.equal(opt.yAxis[1].name, 'USD', '金额单位挂在右轴名');
  assert.equal(opt.yAxis[0].nameTextStyle.color, TEST_THEME.request, '左轴名与请求线同色（读左轴）');
  assert.equal(opt.yAxis[1].nameTextStyle.color, TEST_THEME.balance, '右轴名与余额线同色（读右轴）');

  // 真实 ECharts：三项图例的 y 必须完全相同 → 同一行、基线一致；300~1190 都不折行。
  const echarts = loadVendoredECharts();
  for (const width of [1190, 420, 300, 240]) {
    const chart = echarts.init(null, null, { renderer: 'svg', ssr: true, width, height: 260 });
    try {
      chart.setOption(optionFor(context, samplesOf(12), { reducedMotion: true }));
      const svg = chart.renderToSVGString();
      const ys = [...svg.matchAll(/<text[^>]*transform="translate\(([\d.]+) ([\d.]+)\)"[^>]*>(请求数|错误数|可用余额)<\/text>/g)]
        .map((m) => Number(m[2]));
      assert.equal(ys.length, 3, 'width ' + width + '：三项图例都渲染出来');
      assert.equal(new Set(ys).size, 1, 'width ' + width + '：三项图例 y 相同 → 同一行（实际 ' + ys.join(',') + '）');
    } finally {
      try { chart.dispose(); } catch { /* 忽略 */ }
    }
  }

  // ≤220px 的极端窄屏：plain 图例会整块折行（不丢项、不越界），居中兜底而不是孤儿项右对齐。
  const narrow = echarts.init(null, null, { renderer: 'svg', ssr: true, width: 220, height: 260 });
  try {
    narrow.setOption(optionFor(context, samplesOf(12), { reducedMotion: true }));
    const svg = narrow.renderToSVGString();
    const items = [...svg.matchAll(/<text[^>]*transform="translate\(([\d.]+) ([\d.]+)\)"[^>]*>(请求数|错误数|可用余额)<\/text>/g)]
      .map((m) => ({ x: Number(m[1]), y: Number(m[2]) }));
    assert.equal(items.length, 3, '折行也不丢图例项');
    assert.ok(items.every((it) => it.x >= 0 && it.x < 220), '图例项不越出容器');
  } finally {
    try { narrow.dispose(); } catch { /* 忽略 */ }
  }
});

// ── 36（21i）：暗色横向网格提到 1.9~2.2，且仍比纵向淡一档 ─────────────
test('B21-36：暗色横向网格对比度 1.9~2.2、横 < 纵、仍低于请求线；浅色同序', () => {
  const darkAt = TOKENS_CSS.indexOf(':root[data-theme="dark"] {');
  const light = TOKENS_CSS.slice(0, darkAt);
  const dark = TOKENS_CSS.slice(darkAt);
  const bg = '#12151c';
  const dg = tokenValue(dark, '--chart-grid');
  const dgh = tokenValue(dark, '--chart-grid-h');
  const h = contrastRatio(dgh, bg);
  const v = contrastRatio(dg, bg);
  assert.ok(h >= 1.9 && h <= 2.2, '暗色横向网格对比度必须落在 1.9~2.2（旧值 1.67 太淡），实际 ' + h.toFixed(2));
  assert.ok(v > h, '横向必须仍比纵向淡一档（纵 ' + v.toFixed(2) + ' > 横 ' + h.toFixed(2) + '）');
  assert.ok(contrastRatio(tokenValue(dark, '--chart-series-request'), bg) > v,
    '网格必须仍在请求线之下（不抢数据）');

  const lg = tokenValue(light, '--chart-grid');
  const lgh = tokenValue(light, '--chart-grid-h');
  assert.ok(contrastRatio(lgh, '#ffffff') < contrastRatio(lg, '#ffffff'), '浅色同样 横 < 纵（同步核过）');

  const context = pureContext();
  const opt = optionFor(context, samplesOf(12));
  for (const [label, axis] of [['x', opt.xAxis], ['左 Y', opt.yAxis[0]]]) {
    assert.equal(axis.splitLine.lineStyle.opacity, undefined, label + ' 网格不叠 opacity（亮度只由令牌承载）');
  }
});

// ── 37（21i）：「现在」线降到网格级 + 标签横排、字号 = 图例 ─────────
test('B21-37：「现在」标线用 --chart-now、明显低于数据线；标签横排且字号与图例一致', () => {
  const context = pureContext();
  const opt = optionFor(context, samplesOf(12));
  const bal = opt.series.find((s) => s.name === '可用余额');
  assert.equal(bal.markLine.lineStyle.color, TEST_THEME.now,
    '「现在」标线色 = --chart-now（不再借用偏亮的 --chart-cursor）');
  assert.notEqual(bal.markLine.lineStyle.color, TEST_THEME.cursor, '不得再和游标同色');
  assert.equal(bal.markLine.lineStyle.opacity, undefined, '亮度只由令牌承载，不叠 opacity');
  assert.equal(bal.markLine.label.rotate, 0, '标签必须横排');
  assert.equal(bal.markLine.label.position, 'insideEndTop', '标签贴绘图区顶部内侧');
  assert.equal(bal.markLine.label.fontSize, opt.legend.textStyle.fontSize, '标签字号与图例一致');

  const darkAt = TOKENS_CSS.indexOf(':root[data-theme="dark"] {');
  const dark = TOKENS_CSS.slice(darkAt);
  const nowC = contrastRatio(tokenValue(dark, '--chart-now'), '#12151c');
  const reqC = contrastRatio(tokenValue(dark, '--chart-series-request'), '#12151c');
  assert.ok(nowC < reqC, '「现在」线亮度必须低于数据线（' + nowC.toFixed(2) + ' < ' + reqC.toFixed(2) + '）');
  assert.ok(nowC > contrastRatio(tokenValue(dark, '--chart-grid-h'), '#12151c') * 0.8,
    '但仍在网格级，不至于看不见（实际 ' + nowC.toFixed(2) + '）');
});

// ── 38（21i）：充值锚点 = 实心圆点 + 竖直引线 + 带时间的低调 chip ────
test('B21-38：充值点有实心圆点、竖直短引线、带 HH:mm 的低调 chip；引线精确落在阶跃点', () => {
  const context = pureContext();
  const samples = samplesOf(12).map((s, i) => ({ ...s, m: i < 8 ? 5 : 15 }));
  const opt = optionFor(context, samples);
  const bal = opt.series.find((s) => s.name === '可用余额');
  const t = samples[8].t;

  // 实心圆点（真的在 markPoint 里）
  assert.equal(bal.markPoint.symbol, 'circle', '充值是实心圆点');
  assert.ok(bal.markPoint.symbolSize >= 6, '圆点足够大才看得见，实际 ' + bal.markPoint.symbolSize);
  assert.deepEqual([...bal.markPoint.data[0].coord], [t, 15], '圆点锚在阶跃后的样本上');

  // 带时间的低调 chip
  const label = bal.markPoint.label;
  assert.equal(label.formatter, context.trendClock(t) + ' 充值 +10.00 USD', '标签补上该样本的 HH:mm');
  assert.match(label.formatter, /^\d{2}:\d{2} 充值 \+10\.00 USD$/, '文案形如 14:05 充值 +9.82 USD');
  assert.equal(label.backgroundColor, TEST_THEME.tooltipBg, 'chip 用卡片一致底色（不直接压曲线）');
  assert.equal(label.borderRadius, 6, 'chip 有圆角');
  assert.notEqual(label.color, '#ffffff', '不是高亮胶囊，不抢数据线');

  // 竖直短引线（像素空间 custom series，markPoint 没有 labelLine）
  const leader = opt.series.find((s) => s.name === '充值引线');
  assert.ok(leader, '有充值引线序列');
  assert.equal(leader.type, 'custom', '引线用 custom series 画在像素空间');
  assert.equal(leader.yAxisIndex, 1, '引线走右轴（USD）量程才对得上余额点');
  assert.equal(leader.tooltip.show, false, '引线不进 tooltip');
  assert.equal(leader.legendHoverLink, false, '引线不进图例高亮');
  const el = leader.renderItem({}, { value: (i) => leader.data[0][i], coord: () => [100, 200] });
  assert.ok(!Array.isArray(el), 'renderItem 必须返回单个图元（返回数组会炸掉整张图）');
  assert.equal(el.type, 'line', '引线是一个线段图元');
  assert.equal(el.shape.x1, el.shape.x2, '引线竖直');
  assert.ok(el.shape.y2 < el.shape.y1, '引线从阶跃点向上');
  assert.equal(el.shape.y1 - el.shape.y2, 12, '引线是「短」引线（12px）');

  // 真实 ECharts：整张图仍能渲染，引线路径真的落在阶跃点的 x 上。
  const echarts = loadVendoredECharts();
  const chart = echarts.init(null, null, { renderer: 'svg', ssr: true, width: 900, height: 260 });
  try {
    assert.doesNotThrow(() => chart.setOption(optionFor(context, samples, { reducedMotion: true })),
      '加了引线后 setOption 仍不得抛错');
    const svg = chart.renderToSVGString();
    assert.ok(svg.includes('充值 +10.00 USD'), 'chip 文案必须出现在渲染结果里');
    assert.match(svg, /M([\d.]+) [\d.]+L\1 [\d.]+/, '引线在渲染结果里是一条竖直线段');
  } finally {
    try { chart.dispose(); } catch { /* 忽略 */ }
  }
});
