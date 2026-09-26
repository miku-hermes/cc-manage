// 批次 23：组件化去重 + 拆分趋势页 + 主页面做减法。
//
// 本文件钉住四件事：
//   1) 关键结构（KPI 卡 / 账号卡 / 额度条 / Hero / 头部）在源码里只存在一处（组件）；
//      变异验证：往任意 JS 里塞一段手拼的同类 HTML，本断言必须变红。
//   2) JS 侧用 <template> 克隆填值，不再手拼同类 HTML 字符串。
//   3) /trend 路由：200 + 与 panel/dist/trend.html 逐字节一致；面板缺失走既有 503 提示。
//   4) 服务端产物层面：GET / 的响应体不含 render-trend.js；GET /trend 的响应体含它。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTestGateway, request, makeTmpDir } from './helpers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'panel', 'dist');
const DIST_INDEX = path.join(DIST, 'index.html');
const DIST_TREND = path.join(DIST, 'trend.html');

const COMPONENTS = [
  'SiteHeader.astro', 'HeroCard.astro', 'KpiCard.astro', 'CreditsBar.astro',
  'AccountCard.astro', 'TrendCard.astro', 'StatusPill.astro',
];

// 主面板源码树：组件 + index/trend 页 + 主面板 JS。
// 不含 admin.astro 与后台专用 JS —— 后台有自己的一套表格结构，不在本批次去重范围内。
function sourceFiles() {
  const files = COMPONENTS.map((n) => path.join(ROOT, 'panel/src/components', n));
  files.push(path.join(ROOT, 'panel/src/pages/index.astro'));
  files.push(path.join(ROOT, 'panel/src/pages/trend.astro'));
  for (const name of ['utils.js', 'anim.js', 'api.js', 'state.js', 'theme.js', 'render-hero.js', 'render-cards.js', 'app.js']) {
    files.push(path.join(ROOT, 'panel/public/js', name));
  }
  return files;
}

/** 统计「结构标记」出现在多少个源码文件里（应恰好 1 个 = 组件）。 */
function filesContaining(marker, extra = []) {
  const hits = [];
  for (const file of sourceFiles()) {
    const text = fs.readFileSync(file, 'utf8');
    if (text.includes(marker)) hits.push(path.relative(ROOT, file));
  }
  for (const [name, text] of extra) if (text.includes(marker)) hits.push(name);
  return hits;
}

// ── 1：组件存在 ──────────────────────────────────────────────────────
test('B23-1：7 个可复用组件都存在于 panel/src/components/', () => {
  for (const name of COMPONENTS) {
    assert.ok(fs.existsSync(path.join(ROOT, 'panel/src/components', name)), `缺少组件 ${name}`);
  }
});

// ── 2：结构去重（每条结构只在一个源码文件里出现）────────────────────
test('B23-2：关键结构标记在源码里只出现一次（结构唯一化）', () => {
  const markers = {
    'KPI 卡结构 class="kpi-head': ['class="kpi-head', /^panel\/src\/components\/KpiCard\.astro$/],
    'KPI 模板钩子 data-f="kpi-value"': ['data-f="kpi-value"', /^panel\/src\/components\/KpiCard\.astro$/],
    '账号卡结构 class="card-head': ['class="card-head', /^panel\/src\/components\/AccountCard\.astro$/],
    '账号卡模板钩子 data-f="account-head"': ['data-f="account-head"', /^panel\/src\/components\/AccountCard\.astro$/],
    '额度条结构 class="credits-bar': ['class="credits-bar', /^panel\/src\/components\/CreditsBar\.astro$/],
    'Hero 结构 class="hero-banner': ['class="hero-banner', /^panel\/src\/components\/HeroCard\.astro$/],
    '头部结构 class="brand-name': ['class="brand-name', /^panel\/src\/components\/SiteHeader\.astro$/],
    '空态卡结构 class="card empty"': ['class="card empty"', /^panel\/public\/js\/utils\.js$/],
  };
  for (const [label, [marker, expected]] of Object.entries(markers)) {
    const files = filesContaining(marker);
    assert.equal(files.length, 1,
      `${label} 必须只在 1 个源码文件里出现（结构唯一化），实际 ${files.length}：${files.join(', ')}`);
    assert.match(files[0], expected, `${label} 的唯一出处应是 ${expected}（实际 ${files[0]}）`);
  }
});

test('B23-2b：变异验证口径 —— 同样的标记一旦在 JS 里再出现，计数就变 2', () => {
  // 这不是「实现细节」：filesContaining 就是上面那条断言用的同一个计数器。
  // 这里模拟「在 JS 里重新插入一段手拼的 KPI HTML」，确认计数器会抓到它。
  const handBuilt = '<div class="kpi"><div class="kpi-head stat"></div></div>';
  const hits = filesContaining('class="kpi-head', [['panel/public/js/mutated.js', handBuilt]]);
  assert.equal(hits.length, 2, '手拼 KPI HTML 会让 kpi-head 出现在第 2 个文件 → B23-2 变红');
});

// ── 3：JS 用 <template> 克隆，不手拼同类 HTM L────────────────────────
test('B23-3：index 产出 tpl-kpi / tpl-account 模板；JS 走 cloneNode + [data-f] 填值', () => {
  const index = fs.readFileSync(path.join(ROOT, 'panel', 'src', 'pages', 'index.astro'), 'utf8');
  assert.match(index, /<template id="tpl-kpi">/, 'index 必须有 tpl-kpi 模板');
  assert.match(index, /<template id="tpl-account">/, 'index 必须有 tpl-account 模板');

  const renderCards = fs.readFileSync(path.join(ROOT, 'panel', 'public', 'js', 'render-cards.js'), 'utf8');
  assert.match(renderCards, /content\.firstElementChild\.cloneNode\(true\)/, '账号卡必须来自模板克隆');
  assert.match(renderCards, /querySelector\('\[data-f=/, '必须用 [data-f] 钩子填值');
  assert.doesNotMatch(renderCards, /innerHTML\s*=\s*['"`][^'"`]*<article/, '账号卡不得再手拼 HTML 字符串');

  const renderHero = fs.readFileSync(path.join(ROOT, 'panel', 'public', 'js', 'render-hero.js'), 'utf8');
  assert.match(renderHero, /cloneNode\(true\)/, 'KPI 卡必须来自模板克隆');
  assert.match(renderHero, /field\(node, 'kpi-/, 'KPI 必须用 [data-f] 钩子填值');
});

// ── 4：/trend 路由（200 + 逐字节 + 503 复用）────────────────────────
test('B23-4①：GET /trend 返回 200 且与 panel/dist/trend.html 逐字节一致', async (t) => {
  assert.ok(fs.existsSync(DIST_TREND), '先跑 `bash scripts/panel-build.sh`（trend.html 是构建产物）');
  const ctx = await startTestGateway({ config: { publicDashboard: true }, noInitialRefresh: true });
  t.after(() => ctx.close());

  const page = await request(`${ctx.baseUrl}/trend`);
  assert.equal(page.status, 200, `GET /trend 必须 200，实际 ${page.status}`);
  assert.equal(page.headers['content-type'], 'text/html; charset=utf-8', '必须是 HTML');
  assert.equal(page.headers['cache-control'], 'no-store', 'HTML 不缓存');
  assert.ok(Buffer.from(page.body, 'utf8').equals(fs.readFileSync(DIST_TREND)),
    'GET /trend 必须与构建产物逐字节一致');
});

test('B23-4②：面板缺失 → GET /trend 复用 503 + 「面板未构建」提示（不是裸 500）', async (t) => {
  const dir = makeTmpDir();
  const publicDir = path.join(dir, 'public');
  fs.mkdirSync(publicDir, { recursive: true });
  const ctx = await startTestGateway({ publicDir, config: { publicDashboard: true }, noInitialRefresh: true });
  t.after(async () => { await ctx.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  const page = await request(`${ctx.baseUrl}/trend`);
  assert.equal(page.status, 503, `面板缺失时 GET /trend 必须 503，实际 ${page.status}`);
  assert.equal(page.headers['content-type'], 'text/html; charset=utf-8', '必须是可读 HTML 提示');
  assert.match(page.body, /panel-build\.sh/, '503 必须给可照做的命令（与 /、/admin 同一套）');
});

test('B23-4③：/ 与 /admin 行为不变（仍显式路由）', async (t) => {
  const ctx = await startTestGateway({ config: { publicDashboard: true }, noInitialRefresh: true });
  t.after(() => ctx.close());
  assert.equal((await request(`${ctx.baseUrl}/`)).status, 200);
  assert.equal((await request(`${ctx.baseUrl}/admin`)).status, 200);
});

// ── 5：服务端产物层面：index 不引趋势资源，trend 引 ──────────────────
test('B23-5：GET / 的响应体不含 render-trend.js；GET /trend 的响应体含它', async (t) => {
  const ctx = await startTestGateway({ config: { publicDashboard: true }, noInitialRefresh: true });
  t.after(() => ctx.close());

  const index = await request(`${ctx.baseUrl}/`);
  assert.equal(index.status, 200);
  assert.ok(!index.body.includes('render-trend.js'), '主面板响应体不得含 render-trend.js');
  assert.ok(!index.body.includes('vendor/echarts.min.js'), '主面板响应体不得含 ECharts 路径');
  assert.ok(!index.body.includes('id="trend"'), '主面板不再有整块趋势图容器');
  assert.match(index.body, /href="\/trend"/, '主面板必须有到 /trend 的入口链接');

  const trend = await request(`${ctx.baseUrl}/trend`);
  assert.equal(trend.status, 200);
  assert.ok(trend.body.includes('js/render-trend.js'), '/trend 响应体必须含 render-trend.js');
  assert.ok(trend.body.includes('id="trend"'), '/trend 响应体必须有 #trend 容器');
});

// ── 6：a11y 语义不因删元素丢失 ───────────────────────────────────────
test('B23-6：删掉 KPI 账号卡后，账号口径的无障碍语义迁到 Hero 状态胶囊', async (t) => {
  const ctx = await startTestGateway({ config: { publicDashboard: true }, noInitialRefresh: true });
  t.after(() => ctx.close());
  const index = await request(`${ctx.baseUrl}/`);
  assert.match(index.body, /id="health"[^>]*role="status"[^>]*aria-live="polite"/,
    '账号口径（可用 N / M）保留在带 aria-live 的 Hero 状态胶囊里');
  assert.match(index.body, /id="filters"[^>]*role="group"/, '筛选条 role=group 保留');
});
