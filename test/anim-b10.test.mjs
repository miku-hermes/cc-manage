// 批次 10：前台/后台动效（首屏 stagger / 数字滚动 / 主题过渡 / 筛选重排淡入）的回归。
// 只读 public/** 源码 + 复用 DOM 垫片跑页面脚本；不联网、不起服务。
// 用例在本轮改动前的源码上必须变红。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createDomShim, runInlineScript } from './helpers.mjs';

const INDEX_HTML = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const ADMIN_HTML = fs.readFileSync(new URL('../public/admin.html', import.meta.url), 'utf8');
const APP_JS = fs.readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
const RENDER_HERO_JS = fs.readFileSync(new URL('../public/js/render-hero.js', import.meta.url), 'utf8');
const RENDER_CARDS_JS = fs.readFileSync(new URL('../public/js/render-cards.js', import.meta.url), 'utf8');
const DASHBOARD_CSS = fs.readFileSync(new URL('../public/css/dashboard.css', import.meta.url), 'utf8');
const COMPONENTS_CSS = fs.readFileSync(new URL('../public/css/components.css', import.meta.url), 'utf8');
const ADMIN_CSS = fs.readFileSync(new URL('../public/css/admin.css', import.meta.url), 'utf8');
const BASE_CSS = fs.readFileSync(new URL('../public/css/base.css', import.meta.url), 'utf8');
let ANIM_JS = '';
try { ANIM_JS = fs.readFileSync(new URL('../public/js/anim.js', import.meta.url), 'utf8'); } catch { /* 缺失时下面的用例变红 */ }

// 从 css[start]（'{' 缺失处）匹配成对花括号，返回块内文本
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

// 解析规则 [{ selector, selectors: [...], body }]
function rules(css) {
  const list = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css))) {
    const selector = m[1].replace(/\s+/g, ' ').trim();
    list.push({
      selector,
      selectors: selector.split(',').map((s) => s.replace(/\s+/g, ' ').trim()),
      body: m[2],
    });
  }
  return list;
}

// 返回所有 header 含 query 的 @media 块内容
function mediaBlocks(css, query) {
  const blocks = [];
  const re = /@media[^{]*\{/g;
  let m;
  while ((m = re.exec(css))) {
    const header = m[0].slice(0, -1).replace(/\s+/g, ' ').trim();
    if (header.includes(query)) blocks.push(braceBlock(css, m.index));
  }
  return blocks;
}

const strip = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

function dom(html, fetchImpl) {
  return createDomShim({ html, fetchImpl: fetchImpl ?? (async () => ({ ok: true, status: 200, json: async () => ({}) })) });
}
async function boot() {
  const shim = dom(INDEX_HTML);
  const page = await runInlineScript(INDEX_HTML, shim);
  return { shim, page };
}

function quota(overrides = {}) {
  return {
    ok: true, displayName: '显示名', plan: null, remaining: 4,
    credits: { monthlyCredits: 2, purchasedCredits: 1, freeCredits: 1 },
    fiveHour: { used: 0, cap: 3, percent: 0, resetAt: 0 },
    weekly: { used: 0, cap: 6, percent: 0, resetAt: 0 },
    monthly: { used: 0, cap: 10, percent: 0, resetAt: 0 },
    usage: { totalTokens: 12, totalCost: 1 }, fetchedAt: Date.now(), ...overrides,
  };
}
function account(overrides = {}) {
  return {
    keyId: '12345678', name: '测试号', enabled: true, available: true,
    creditsExhausted: false, exhausted: null, paused: false, pausedUntil: null,
    rateLimited: false, rateLimitedUntil: null, authInvalid: false, lastError: null,
    lastQuota: quota(), ...overrides,
  };
}

// ── 1：anim.js 与 canAnimate 的可见性判据 ────────────────────────────
test('B10-1：anim.js 的 canAnimate 以 document.visibilityState === "visible" 为判据', () => {
  assert.ok(ANIM_JS, '存在 public/js/anim.js');
  const idx = ANIM_JS.indexOf('function canAnimate(');
  assert.ok(idx >= 0, 'anim.js 定义 canAnimate');
  const block = braceBlock(ANIM_JS, idx);
  assert.match(block, /document\.visibilityState\s*===\s*'visible'/, '可见性判据必须是 === "visible"');
  assert.match(block, /typeof requestAnimationFrame\s*===\s*'function'/, '有 rAF 才动画');
  assert.match(block, /prefersReducedMotion\(\)/, '尊重系统减少动态效果');
  // 两页都按 utils → anim → 其余 的顺序引入
  assert.match(INDEX_HTML, /<script src="js\/anim\.js"><\/script>/, 'index.html 引入 anim.js');
  assert.match(ADMIN_HTML, /<script src="js\/anim\.js"><\/script>/, 'admin.html 引入 anim.js');
  const utilsAt = INDEX_HTML.indexOf('<script src="js/utils.js">');
  const animAt = INDEX_HTML.indexOf('<script src="js/anim.js">');
  const heroAt = INDEX_HTML.indexOf('<script src="js/render-hero.js">');
  assert.ok(utilsAt >= 0 && utilsAt < animAt && animAt < heroAt, 'anim.js 在 utils 之后、render-* 之前');
});

// ── 2：setNumber 不能动画时同步写终值 + 重入保护 ─────────────────────
test('B10-2：setNumber 不能动画时同步写 fmt(to)，重入用 el.__animId / cancelAnimationFrame', async () => {
  const { shim, page } = await boot();
  assert.equal(typeof page.setNumber, 'function', 'setNumber 是页面全局');
  const el = shim.document.createElement('b');
  page.setNumber(el, 0, 4, page.money, 700);   // 垫片 visibilityState === undefined → 同步
  assert.equal(el.textContent, '4.00', 'render() 返回后同步可读终值');
  assert.ok(el.__animId == null, '同步路径不残留 rAF 句柄');

  page.setNumber(el, 0, NaN, page.money, 700);
  assert.equal(el.textContent, '—', '不可用值仍是 —（与 money 同口径）');

  // render 全链路也同步
  page.render({
    now: Date.now(), quotaPoll: {},
    summary: { accounts: 1, available: 1, paused: 0, unavailable: 0, concurrency: 0 },
    stats: { total: 0, errors: 0, clientErrors: 0, totalTokens: 0 },
    accounts: [account({ keyId: 'aaaa1111' })],
  });
  assert.equal(shim.el('balance').textContent, '4.00', 'render 后余额同步可见');
  assert.equal(shim.el('tokens').textContent, '0', 'render 后 token 同步可见');

  assert.match(ANIM_JS, /el\.__animId/, '重入句柄存在 el.__animId');
  assert.match(ANIM_JS, /cancelAnimationFrame/, '重入先 cancelAnimationFrame');
});

// ── 3：卡片动画只在作用域类下，没有裸 .card animation ────────────────
test('B10-3：dashboard.css 不写裸 .card 常驻动画，只由 body.is-intro / #cards.is-reflow 驱动', () => {
  const css = strip(DASHBOARD_CSS);
  const animated = rules(css).filter((r) => /animation\s*:/.test(r.body));
  for (const r of animated) {
    for (const s of r.selectors) {
      assert.doesNotMatch(s, /^\.card\b/, `裸 .card 不得常驻动画（5s 轮询会重播）：${r.selector}`);
    }
  }
  assert.ok(animated.some((r) => r.selectors.some((s) => s.includes('body.is-intro') && s.includes('.card'))),
    '卡片入场动画必须挂在 body.is-intro 作用域');
  assert.ok(animated.some((r) => r.selectors.some((s) => s.includes('#cards.is-reflow') && s.includes('.card'))),
    '筛选重排动画必须挂在 #cards.is-reflow 作用域');
  assert.match(css, /@keyframes card-in/, '定义 card-in 关键帧');
  assert.match(css, /@keyframes rise-in/, '定义 rise-in 关键帧');
});

// ── 4：body.is-intro 一次性（add + remove + introPending） ────────────
test('B10-4：app.js 的 playIntro 只跑一次，加/移除 body.is-intro', () => {
  assert.match(APP_JS, /introPending/, '有一次性守卫');
  const idx = APP_JS.indexOf('function playIntro(');
  assert.ok(idx >= 0, '定义 playIntro');
  const block = braceBlock(APP_JS, idx);
  assert.match(block, /if\s*\(!introPending\)\s*return/, 'introPending 为 false 直接返回');
  assert.match(block, /classList\.add\('is-intro'\)/, '加 body.is-intro');
  assert.match(block, /classList\.remove\('is-intro'\)/, '之后移除 body.is-intro');
  assert.match(block, /setTimeout\(/, '移除是延时一次');
  assert.match(RENDER_HERO_JS, /playIntro\(\)/, '首次成功渲染路径调用 playIntro');
});

// ── 5：数字滚动挂载点 ───────────────────────────────────────────────
test('B10-5：render-hero.js 用 setNumber；首次 from 0，之后格式化结果变了才动', () => {
  assert.match(RENDER_HERO_JS, /setNumber\(\$\('balance'\), 0,/, '首次余额从 0 滚上来');
  assert.match(RENDER_HERO_JS, /setNumber\(\$\('tokens'\), 0,/, '首次 token 从 0 滚上来');
  assert.match(RENDER_HERO_JS, /money\(lastBalance\)\s*!==\s*money\(/, '余额格式化结果变了才动');
  assert.match(RENDER_HERO_JS, /num\(lastTokens\)\s*!==\s*num\(/, 'token 变了才动');
  assert.match(RENDER_HERO_JS, /setNumber\(el, 0, value, num, 700\)/, '6 个 KPI 数字同走 setNumber');
  assert.match(RENDER_HERO_JS, /let lastBalance = null/, '记录上次余额');
  assert.match(RENDER_HERO_JS, /let lastTokens = null/, '记录上次 token');
  assert.match(RENDER_HERO_JS, /, 320\)/, '后续变化用 320ms');
});

// ── 6：主题过渡（主要面含 background-color） ─────────────────────────
test('B10-6：至少 3 个主要面选择器带 background-color 过渡', () => {
  const targets = [
    [DASHBOARD_CSS, '.card'],
    [DASHBOARD_CSS, '.kpi'],
    [COMPONENTS_CSS, '.pill'],
    [ADMIN_CSS, 'section.panel'],
  ];
  let hit = 0;
  for (const [css, sel] of targets) {
    const body = rules(strip(css)).filter((r) => r.selectors.includes(sel))
      .map((r) => r.body).join('\n').replace(/\s+/g, ' ');
    if (/transition\s*:/.test(body) && /background-color/.test(body)) hit += 1;
  }
  assert.ok(hit >= 3, `至少 3 个主要面含 background-color 过渡，实际 ${hit}`);
});

// ── 7：两处 reduced-motion 降级都在 ─────────────────────────────────
test('B10-7：base.css 全局 reduced-motion 块保留，dashboard.css 降级本轮新增动画', () => {
  const baseBody = mediaBlocks(strip(BASE_CSS), 'prefers-reduced-motion: reduce').join('\n');
  assert.match(baseBody, /transition-duration:\s*0?\.01ms\s*!important/, '全局过渡降级仍在');
  assert.match(baseBody, /animation-duration:\s*0?\.01ms\s*!important/, '全局动画降级仍在');

  const dashBody = mediaBlocks(strip(DASHBOARD_CSS), 'prefers-reduced-motion: reduce').join('\n');
  assert.match(dashBody, /body\.is-intro/, 'dashboard.css 的 reduced-motion 块显式降级入场动画');
  assert.match(dashBody, /animation:\s*none/, '入场动画在 reduced-motion 下一律关闭');
});

// ── 8：卡片带 --i 序号 ──────────────────────────────────────────────
test('B10-8：render-cards.js 输出的卡片带 --i 序号变量', async () => {
  const { shim, page } = await boot();
  const accs = ['a1', 'a2', 'a3'].map((k) => account({ keyId: k, name: '号' + k }));
  page.render({
    now: Date.now(), quotaPoll: {},
    summary: { accounts: 3, available: 3, paused: 0, unavailable: 0, concurrency: 0 },
    stats: { total: 0, errors: 0, clientErrors: 0, totalTokens: 0 },
    accounts: accs,
  });
  const out = shim.el('cards').innerHTML;
  assert.match(out, /style="--i:0"/, '第 1 张卡 --i:0');
  assert.match(out, /style="--i:1"/, '第 2 张卡 --i:1');
  assert.match(out, /style="--i:2"/, '第 3 张卡 --i:2');
  assert.match(RENDER_CARDS_JS, /card\(a, i === list\.length - 1 && list\.length % 2 === 1, i\)/,
    'renderCards 把列表序号传进 card()');
});

// ── 9：筛选点击重排、搜索输入不触发；搜索框逻辑未动 ─────────────────
test('B10-9：只有 .filter-btn 点击触发 #cards 重排淡入，搜索框逻辑保持原样', () => {
  const clickStart = APP_JS.indexOf("addEventListener('click'");
  assert.ok(clickStart >= 0, '有 click 委托');
  const rest = APP_JS.slice(clickStart + 1);
  const nextListener = rest.indexOf('addEventListener(');
  const clickHandler = nextListener >= 0 ? rest.slice(0, nextListener) : rest;

  assert.match(clickHandler, /closest\('#filters \.filter-btn'\)/, '筛选分支仍走 #filters .filter-btn');
  assert.match(clickHandler, /reflowCards\(\)/, '筛选命中后触发重排动画');
  assert.ok(APP_JS.includes('function reflowCards('), '定义 reflowCards');
  assert.match(APP_JS, /classList\.add\('is-reflow'\)/, '重排短类 is-reflow');
  assert.match(APP_JS, /, 260\)/, '260ms 后移除重排短类');
  assert.match(strip(DASHBOARD_CSS), /\.26s/, '重排动画时长 .26s');

  // 搜索框点击分支没被改动（导航批次 8/9 的既有断言）
  assert.doesNotMatch(clickHandler, /classList\.toggle\('expanded'\)/, '点击分支不得 toggle expanded');
  assert.match(clickHandler, /classList\.add\('expanded'\)/, '点击分支补 expanded');
  assert.match(clickHandler, /INPUT'\)[\s\S]{0,200}?add\('expanded'\)/, '点输入框也展开');

  // 搜索输入监听里绝不出现重排
  const inputStart = APP_JS.indexOf("addEventListener('input'");
  assert.ok(inputStart >= 0, '有 input 委托');
  const inputRest = APP_JS.slice(inputStart + 1);
  const inputEnd = inputRest.indexOf('addEventListener(');
  const inputHandler = inputEnd >= 0 ? inputRest.slice(0, inputEnd) : inputRest;
  assert.doesNotMatch(inputHandler, /is-reflow|reflowCards/, '搜索输入不得触发重排动画');

  assert.match(strip(DASHBOARD_CSS), /#cards\.is-reflow \.card\s*\{[^}]*animation/, '重排动画样式存在');
});
