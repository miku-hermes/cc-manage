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
