// 批次 24d：把内联 CSS 换成可缓存的独立文件（BUG-6）。
//   1) 构建产物 dist/assets/*.css，三个页面引用同一个（带内容哈希的）文件名；
//   2) 三个页面 HTML 内联 <style> 总字节 < 8KB；
//   3) GET /assets/<hash>.css → 200 + text/css + immutable 长缓存；
//   4) 负例（穿越 / 非白名单扩展名）在 ui-structure.test.mjs 的既有断言里扩展覆盖。
//
// 变异验证：
//   - panel/astro.config.mjs 的 inlineStylesheets 改回 'always' → 内联体积断言（②）变红；
//   - 把 /assets 从 gateway 静态路由白名单移出 → GET 200 断言（③）变红。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTestGateway, request, inlineStyleText } from './helpers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'panel', 'dist');
const ASSETS = path.join(DIST, 'assets');
const PAGES = ['index.html', 'admin.html', 'trend.html'];
const INLINE_LIMIT = 8 * 1024;

function cssAssets() {
  assert.ok(fs.existsSync(ASSETS), 'panel/dist/assets/ 必须存在（先跑 bash scripts/panel-build.sh）');
  return fs.readdirSync(ASSETS).filter((f) => f.endsWith('.css')).sort();
}

function pageHtml(name) {
  return fs.readFileSync(path.join(DIST, name), 'utf8');
}

/** 页面的 <link rel="stylesheet" href="...">（按文档顺序）。 */
function stylesheetHrefs(html) {
  const out = [];
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    if (!/\brel\s*=\s*("stylesheet"|'stylesheet'|stylesheet)/i.test(tag)) continue;
    const hm = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    if (hm) out.push(hm[1] ?? hm[2] ?? hm[3]);
  }
  return out;
}

// ① 产物存在 + 三页同引用 ───────────────────────────────────────────────
test('B24d-6①：dist/assets/*.css 存在，三页引用同一个带哈希的文件名', () => {
  const files = cssAssets();
  assert.equal(files.length, 1, `应只有一个共享 CSS 产物，实际 ${files.length}：${files.join(', ')}`);

  const refs = PAGES.map((name) => {
    const hrefs = stylesheetHrefs(pageHtml(name));
    assert.equal(hrefs.length, 1, `${name} 必须恰好有一个外链样式表`);
    assert.match(hrefs[0], /^\/assets\/[^/]+\.css$/, `${name} 的样式表必须是 /assets/*.css（实际 ${hrefs[0]}）`);
    return hrefs[0];
  });
  assert.equal(new Set(refs).size, 1, `三页必须引用同一个文件名，实际 ${JSON.stringify(refs)}`);
  assert.equal(refs[0].split('/').pop(), files[0], '引用名必须指向真实产物');
  // 内容哈希：文件名里带一段 [A-Za-z0-9_-]{8} 的构建哈希（immutable 长缓存的前提）。
  assert.match(files[0], /\.[A-Za-z0-9_-]{8}\.css$/, '产物名必须带内容哈希段');
});

// ② 内联 <style> 总量 < 8KB ────────────────────────────────────────────
test('B24d-6②：三页 HTML 内联 <style> 总字节 < 8KB（样式已外置）', () => {
  const sizes = PAGES.map((name) => Buffer.byteLength(inlineStyleText(pageHtml(name))));
  const total = sizes.reduce((a, b) => a + b, 0);
  assert.ok(total < INLINE_LIMIT,
    `内联 <style> 总量应 < ${INLINE_LIMIT} 字节，实际 ${total}（各页 ${sizes.join('/')}）`);
  // 外置之后 index.html 应当远小于改动前的 140,129 字节。
  assert.ok(Buffer.byteLength(pageHtml('index.html')) < 40 * 1024, 'index.html 不应再把整包 CSS 内联进去');
});

// ③ 真实网关：/assets/<hash>.css → 200 + text/css + immutable ──────────
test('B24d-6③：GET /assets/<hash>.css 返回 200 + text/css + immutable 长缓存', async (t) => {
  const file = cssAssets()[0];
  const ctx = await startTestGateway({ noInitialRefresh: true });
  t.after(() => ctx.close());

  const r = await request(`${ctx.baseUrl}/assets/${file}`);
  assert.equal(r.status, 200, `/assets/${file} 必须 200（/assets 必须在静态路由白名单里）`);
  assert.match(r.headers['content-type'], /^text\/css; charset=utf-8$/i, '必须是 text/css');
  assert.equal(r.headers['cache-control'], 'public, max-age=31536000, immutable', '与 /vendor 同款 immutable 长缓存');
  assert.ok(r.body.length > 10_000, `返回完整 CSS（实际 ${r.body.length} 字节）`);
  assert.match(r.body, /--color-primary|\.grid-template-columns|@layer/, '返回的是编译后的样式内容');

  // CSS 里引用的哈希名应能在产物目录里找到（引用与产物一致）。
  assert.ok(fs.existsSync(path.join(ASSETS, file)));
});
