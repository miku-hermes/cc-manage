// 批次 14：工程卫生（零依赖 lint / 测试并发 / 删占位模块 / docs 归档）的回归。
// 只读仓库文本 + 真跑一次 lint；不联网、不起服务。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

const PKG = JSON.parse(read('package.json'));
const INDEX_HTML = read('panel/src/pages/index.astro');
const WORKFLOW = read('.github/workflows/docker-publish.yml');
const LINT_JS = read('scripts/lint.mjs');

// ── 1：package.json 有 lint 脚本并指向 scripts/lint.mjs ──────────────
test('B14-1：package.json 的 lint 脚本指向 scripts/lint.mjs', () => {
  assert.ok(PKG.scripts && typeof PKG.scripts.lint === 'string', '存在 scripts.lint');
  assert.match(PKG.scripts.lint, /scripts\/lint\.mjs/, 'lint 指向 scripts/lint.mjs');
});

// ── 2：test 脚本带并发 ──────────────────────────────────────────────
test('B14-2：package.json 的 test 脚本带 --test-concurrency', () => {
  assert.match(PKG.scripts.test, /--test-concurrency=\d+/, 'test 脚本启用并发');
  // 保留原有的 vendor 那一半
  assert.match(PKG.scripts.test, /vendor\/commandcode-proxy/, 'vendor 测试仍保留');
});

// ── 3：lint 只依赖 node: 内置模块 ────────────────────────────────────
test('B14-3：scripts/lint.mjs 只 import node: 内置模块', () => {
  assert.ok(exists('scripts/lint.mjs'), 'scripts/lint.mjs 存在');
  const specs = [];
  for (const re of [/from\s+['"]([^'"]+)['"]/g, /import\(\s*['"]([^'"]+)['"]\s*\)/g, /^\s*import\s+['"]([^'"]+)['"]/gm]) {
    for (const m of LINT_JS.matchAll(re)) specs.push(m[1]);
  }
  assert.ok(specs.length > 0, 'lint 至少 import 了内置模块');
  for (const spec of specs) {
    assert.match(spec, /^node:/, `依赖 ${spec} 必须以 node: 开头（零外部依赖）`);
  }
});

// ── 4：真跑一遍 lint，必须绿 ─────────────────────────────────────────
test('B14-4：node scripts/lint.mjs 退出码为 0 且打印汇总行', () => {
  const r = spawnSync(process.execPath, ['scripts/lint.mjs'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, `lint 必须全绿，实际退出码 ${r.status}\n${r.stdout}${r.stderr}`);
  const out = `${r.stdout}${r.stderr}`;
  assert.match(out, /lint ok/, '输出含汇总前缀');
  assert.match(out, /\d+\s*个文件/, '汇总行报告检查了多少文件');
});

// ── 5：守住零外部依赖 ───────────────────────────────────────────────
test('B14-5：package.json 无 dependencies/devDependencies 且根目录无 node_modules/package-lock.json', () => {
  assert.ok(!('dependencies' in PKG), '不得有 dependencies');
  assert.ok(!('devDependencies' in PKG), '不得有 devDependencies');
  assert.ok(!exists('node_modules'), '根目录不得有 node_modules');
  assert.ok(!exists('package-lock.json'), '根目录不得有 package-lock.json');
});

// ── 6：占位模块已删且不再被加载 ─────────────────────────────────────
test('B14-6：render-kpis.js 已删除且 index.html 不再引用', () => {
  assert.ok(!exists('panel/public/js/render-kpis.js'), 'panel/public/js/render-kpis.js 必须被删除');
  assert.doesNotMatch(INDEX_HTML, /render-kpis/, 'index.html 不得再出现 render-kpis');
});

// ── 7：脚本顺序不变量仍成立 utils → anim → render-hero ──────────────
test('B14-7：index.html 中 utils.js → anim.js → render-hero.js 顺序不变', () => {
  const utilsAt = INDEX_HTML.indexOf('<script src="js/utils.js">');
  const animAt = INDEX_HTML.indexOf('<script src="js/anim.js">');
  const heroAt = INDEX_HTML.indexOf('<script src="js/render-hero.js">');
  assert.ok(utilsAt >= 0 && animAt >= 0 && heroAt >= 0, '三个脚本都还在');
  assert.ok(utilsAt < animAt, 'utils 必须先于 anim');
  assert.ok(animAt < heroAt, 'anim 必须先于 render-hero');
});

// ── 8：CI 有 lint 步骤且测试步骤带并发 ───────────────────────────────
test('B14-8：workflow 有 Lint 步骤且 test 步骤带 --test-concurrency', () => {
  assert.match(WORKFLOW, /name:\s*Lint\b/, '存在名为 Lint 的步骤');
  assert.match(WORKFLOW, /npm run lint/, 'Lint 步骤跑 npm run lint');
  assert.match(WORKFLOW, /node --test --test-concurrency=\d+ test\/\*\.test\.mjs/, 'Run tests 带并发');
  // Lint 必须在 Run tests 之前
  assert.ok(WORKFLOW.indexOf('name: Lint') < WORKFLOW.indexOf('name: Run tests'), 'Lint 先于 Run tests');
});

// ── 9：docs 归档结构 ────────────────────────────────────────────────
test('B14-9：docs/archive 含 README + 7 个过程文档，docs 顶层保留 5 个参考文档', () => {
  const ARCHIVED = [
    'BRIEF-mobile-tags-oneline.md', 'BRIEF-remove-inflight-ui.md', 'MOBILE-FIX.md',
    'PAUSED-BADGE-FIX.md', 'QA-FIX-ROUND2.md', 'QA-FIX-ROUND2-RESULT.md', 'UI-POLISH.md',
  ];
  const KEEP = ['ADAPTIVE-REFRESH.md', 'ADMIN-UI.md', 'AUTH-REDESIGN.md', 'UI-REDESIGN.md', 'UI-REFACTOR-PLAN.md'];
  assert.ok(exists('docs/archive'), '存在 docs/archive/');
  assert.ok(exists('docs/archive/README.md'), '存在 docs/archive/README.md');
  for (const f of ARCHIVED) assert.ok(exists(`docs/archive/${f}`), `docs/archive/${f} 存在`);
  for (const f of KEEP) assert.ok(exists(`docs/${f}`), `docs/${f} 仍在顶层`);
});

// ── 10：被移动的文档不再出现在 docs 顶层（是移动而非复制）────────────
test('B14-10：归档文档不再出现在 docs/ 顶层', () => {
  const ARCHIVED = [
    'BRIEF-mobile-tags-oneline.md', 'BRIEF-remove-inflight-ui.md', 'MOBILE-FIX.md',
    'PAUSED-BADGE-FIX.md', 'QA-FIX-ROUND2.md', 'QA-FIX-ROUND2-RESULT.md', 'UI-POLISH.md',
  ];
  for (const f of ARCHIVED) assert.ok(!exists(`docs/${f}`), `docs/${f} 不应还在顶层`);
});
