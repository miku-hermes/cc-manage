// 批次 24d：B24 重构后浏览器实测发现的真 bug（KPI 静默空白 / 名称列错栅格 / 行高与概览
// 对齐 / 筛选条权重 / 宽屏空间浪费）的回归测试。
// 全部只读 panel/** 源码 + 构建产物，用既有 DOM 垫片跑页面脚本；零外部依赖、不联网。
//
// 约定（变异验证）：这些用例在修复前的代码上必须变红 ——
//   - BUG-1：renderKpis 重建节点后跳过着色 → KPI 数字空白 → 断言变红；
//   - BUG-2：把名称列改回固定 133px（grid-cols-[133px_...]）→ 断言变红；
//   - BUG-3：把标签条挪出 summary / hero 类名改回与 daisyUI .hero 冲突 → 断言变红。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createDomShim, runInlineScript, styleText } from './helpers.mjs';

const INDEX_HTML = fs.readFileSync(new URL('../panel/dist/index.html', import.meta.url), 'utf8');
const INDEX_SRC = fs.readFileSync(new URL('../panel/src/pages/index.astro', import.meta.url), 'utf8');
const ACCOUNT_CARD = fs.readFileSync(new URL('../panel/src/components/AccountCard.astro', import.meta.url), 'utf8');
const HERO_CARD = fs.readFileSync(new URL('../panel/src/components/HeroCard.astro', import.meta.url), 'utf8');
const RENDER_HERO_JS = fs.readFileSync(new URL('../panel/public/js/render-hero.js', import.meta.url), 'utf8');

function dom(html, fetchImpl) {
  return createDomShim({ html, fetchImpl: fetchImpl ?? (async () => ({ ok: true, status: 200, json: async () => ({}) })) });
}

function quota(overrides = {}) {
  return {
    ok: true, displayName: '显示名', plan: null, remaining: 9.9,
    credits: { monthlyCredits: 2, purchasedCredits: 1, freeCredits: 0.5 },
    fiveHour: { used: 0, cap: 3, percent: 0, resetAt: 0 },
    weekly: { used: 0, cap: 6, percent: 0, resetAt: 0 },
    monthly: { used: 0, cap: 10, percent: 0, resetAt: 0 },
    usage: { totalTokens: 12, totalCost: 1 }, fetchedAt: Date.now(),
    ...overrides,
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

function status(accounts, extra = {}) {
  return {
    now: Date.now(), quotaPoll: {},
    summary: {
      accounts: accounts.length, enabled: accounts.length, available: accounts.length,
      unavailable: 0, paused: 0, concurrency: 0, ...(extra.summary || {}),
    },
    stats: { total: 0, errors: 0, clientErrors: 0, totalTokens: 0, ...(extra.stats || {}) },
    accounts,
  };
}

/** 读 KPI：label → 大数字文本。经 DOM 垫片渲染后真实读元素，不做源码存在性断言。 */
function readKpis(shim) {
  const out = {};
  for (const box of shim.document.querySelectorAll('#kpis .stat')) {
    const label = box.querySelector('.kpi-label');
    const value = box.querySelector('.stat-value');
    out[label ? label.textContent : '?'] = value ? value.textContent : null;
  }
  return out;
}

// ── BUG-1：KPI 数字必须真的渲染出来，且轮询重建后不丢 ─────────────────
test('B24d-1：渲染后 KPI 数字落进正确元素；同数据再渲染（5s 轮询）后仍不空白', async () => {
  const shim = dom(INDEX_HTML);
  const page = await runInlineScript(INDEX_HTML, shim);
  const data = status([account()], { stats: { total: 1234, errors: 7, clientErrors: 3, totalTokens: 98765 } });

  page.render(data);
  const first = readKpis(shim);
  assert.deepEqual(first, { '总请求': '1,234', '上游错误数': '7' }, '首屏必须填进真实数字');
  for (const v of Object.values(first)) assert.match(String(v), /\d/, 'KPI 值必须是数字，不能是空串');

  // 5 秒轮询：数据没变，但 renderKpis 会从 <template> 重建节点 —— 值必须重新落进新节点。
  page.render(data);
  const second = readKpis(shim);
  assert.deepEqual(second, first, '同数据二次渲染（轮询重建）后 KPI 数字不能消失（B24 静默空白回归）');
  for (const v of Object.values(second)) assert.match(String(v), /\d/);
});

test('B24d-1b：异步 load() 数据到达后，KPI 数字落进正确元素', async () => {
  const payload = status([account()], { stats: { total: 88, errors: 2, clientErrors: 1, totalTokens: 5 } });
  const shim = dom(INDEX_HTML, async (url) => (String(url) === '/api/status'
    ? { ok: true, status: 200, json: async () => payload }
    : { ok: true, status: 200, json: async () => ({}) }));
  const page = await runInlineScript(INDEX_HTML, shim);
  await page.load();   // 数据到达 → render()
  assert.equal(shim.el('kpi-total').textContent, '88', '总请求落进 #kpi-total');
  assert.equal(shim.el('kpi-errors').textContent, '2', '上游错误落进 #kpi-errors');
  assert.match(shim.el('kpi-total').textContent, /\d/);
});

// ── BUG-2：名称列按内容自适应，不得再是固定窄列 ──────────────────────
test('B24d-2：名称列自适应内容（minmax(0,max-content) + 1fr），产物里无固定 133px 列宽', () => {
  const css = styleText(INDEX_HTML);
  assert.doesNotMatch(css, /133px/, '不得把名称列钉成 133px（变异检查点）');
  assert.match(css, /grid-template-columns:\s*minmax\(0,\s*max-content\)\s+minmax\(0,\s*1fr\)/,
    '名称列按内容自适应，剩余宽度交给右侧列');
  assert.match(ACCOUNT_CARD, /class="collapse-title row-summary grid grid-cols-\[minmax\(0,max-content\)_minmax\(0,1fr\)\]/,
    '模板 summary 必须用内容自适应网格（名称列在前）');
});

// ── BUG-3：行高一致 + 概览卡内部左对齐 ───────────────────────────────
test('B24d-3：标签条收进 summary 且固定行高；hero 不再撞 daisyUI .hero 组件类', () => {
  const details = /<details[\s\S]*<\/details>/.exec(ACCOUNT_CARD);
  assert.ok(details, '能找到 AccountCard 的 details');
  const summary = /<summary[\s\S]*?<\/summary>/.exec(details[0]);
  assert.ok(summary, '能找到 summary');
  assert.match(summary[0], /data-f="tags"/, '补充标签条必须挂在 summary 内（不能当 .collapse 网格的第 3 行跑到行外）');
  assert.doesNotMatch(details[0].slice(details[0].indexOf('</summary>')), /data-f="tags"/,
    '标签条不得再挂在 details 尾部（跑出行外会撑高不一致）');
  assert.match(summary[0], /class="tags[^"]*\bmin-h-6\b/, '标签条固定高度 → 有/无徽章的行等高');

  // 类名冲突：daisyUI 自带 .hero（grid + place-items:center）会把概览卡内容挤成居中缩水块。
  assert.doesNotMatch(HERO_CARD, /class="hero\s/, 'hero 类名不得与 daisyUI .hero 组件冲突（应改名为 hero-card）');
  assert.match(HERO_CARD, /class="hero-card overview card/, '概览卡用不冲突的 hero-card 类名');
});

// ── BUG-4：筛选条视觉权重提升 ────────────────────────────────────────
test('B24d-4：筛选标签加大字号/字重（主要导航控件）', async () => {
  const shim = dom(INDEX_HTML);
  const page = await runInlineScript(INDEX_HTML, shim);
  page.render(status([account()]));
  const btn = shim.el('filters').querySelector('.filter-btn');
  assert.ok(btn, '筛选按钮存在');
  assert.match(btn.className, /\btext-sm\b/, '字号提升到 14px（不再是 btn-sm 的 12px）');
  assert.match(btn.className, /\bfont-semibold\b/, '字重加粗');
  assert.match(styleText(INDEX_HTML), /\.text-sm\{[^}]*font-size:var\(--text-sm\)/, 'text-sm 产出 14px 字号');
});

// ── BUG-5：宽屏利用空间（更宽页壳 + 卡片多列，而非超长单行）──────────
test('B24d-5：宽屏页壳放宽到 1600px，卡片在超宽屏两列', () => {
  assert.match(INDEX_SRC, /<main class="[^"]*2xl:max-w-\[1600px\]/, '宽屏主内容放宽（>1152）');
  assert.match(INDEX_SRC, /id="cards"[^>]*class="[^"]*2xl:grid-cols-2/, '超宽屏卡片两列，避免超长单行');
  const css = styleText(INDEX_HTML);
  assert.match(css, /@media\(min-width:96rem\)/, '2xl 断点存在（96rem）');
  assert.match(css, /max-width:1600px/, '放宽值编译进产物');
  assert.match(RENDER_HERO_JS, /filter-btn btn btn-sm join-item text-sm font-semibold/, '筛选条类名来源固定');
});
