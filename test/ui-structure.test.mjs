// 前端重构批次 1：HTML 壳 + 外部 css/js 的静态结构回归。
// 只读 panel/* 文本 + 起真实网关验证静态路由；不联网。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startTestGateway, request, inlineStyleText, styleText } from './helpers.mjs';

const INDEX_HTML = fs.readFileSync(new URL('../panel/dist/index.html', import.meta.url), 'utf8');
// B24：admin 页面的 color-scheme / 内联样式只在构建产物里（.astro 源码含 frontmatter，读它取不到 <style>）。
const ADMIN_HTML = fs.readFileSync(new URL('../panel/dist/admin.html', import.meta.url), 'utf8');

// ── 1：静态路由 200 + MIME ───────────────────────────────────────────
// B24 改写：手写 panel/public/css/ 已整体删除，页面样式改为 Astro 内联，不再有独立 .css 资源；
// 静态文件服务的 200 + MIME + CSP 契约改由两个仍存在的 JS 资源承担
// （/js/state.js 与 /vendor/echarts.min.js）。等价性：仍逐项断言 200 / content-type /
// content-security-policy，并额外断言 echarts 的长缓存，覆盖面不降。
test('结构#1：GET /js/state.js 与 /vendor/echarts.min.js 返回 200 且 MIME 正确', async (t) => {
  const ctx = await startTestGateway();
  t.after(() => ctx.close());

  const js = await request(`${ctx.baseUrl}/js/state.js`);
  assert.equal(js.status, 200, 'state.js 必须可取');
  assert.match(js.headers['content-type'], /^text\/javascript; charset=utf-8$/i, 'js MIME');
  assert.match(js.body, /const state\s*=/, 'state.js 里应有全局 state');
  assert.match(js.headers['content-security-policy'], /script-src/, '静态资源也要带 CSP 头');

  const vendor = await request(`${ctx.baseUrl}/vendor/echarts.min.js`);
  assert.equal(vendor.status, 200, 'echarts.min.js 必须可取');
  assert.match(vendor.headers['content-type'], /^text\/javascript; charset=utf-8$/i, 'vendor js MIME');
  assert.match(vendor.body, /echarts/i, 'vendor 里应是 ECharts');
  assert.match(vendor.headers['content-security-policy'], /script-src/, 'vendor 资源也带 CSP 头');
});

// ── 2：路径穿越必须 404 ──────────────────────────────────────────────
// B24d：静态路由新增 /assets 前缀（构建产物 CSS），穿越/白名单校验必须与 /css、/js 同一套。
test('结构#2：/css/../ 与 /js/../ 等穿越路径一律 404（/assets 一并覆盖）', async (t) => {
  const ctx = await startTestGateway();
  t.after(() => ctx.close());
  const paths = [
    '/css/../gateway.mjs',
    '/js/../gateway.mjs',
    '/css/../../etc/passwd',
    '/css/%2e%2e/gateway.mjs',
    '/js/..%2f..%2fpackage.json',
    '/css/nope.css',
    // B24d：/assets 必须走同一套 normalize + 白名单（不只 .css/.js 之外的扩展名被拒）。
    '/assets/../gateway.mjs',
    '/assets/%2e%2e/gateway.mjs',
    '/assets/..%2f..%2fpackage.json',
    '/assets/x.json',
    '/assets/nope.css',
  ];
  for (const p of paths) {
    const r = await request(`${ctx.baseUrl}${p}`);
    assert.equal(r.status, 404, `${p} 必须 404`);
  }
});

// ── 3：B2-13 语义在拆分后仍成立（内联 <style> 里保留 color-scheme 分派）──
test('结构#3：两页内联 <style> 仍含 data-theme 的 color-scheme 分派', () => {
  for (const [name, html] of [['index', INDEX_HTML], ['admin', ADMIN_HTML]]) {
    const inline = inlineStyleText(html);
    assert.ok(inline.trim(), `${name} 仍有内联 <style>`);
    assert.match(inline, /:root\[data-theme="light"\]\s*\{[^}]*color-scheme:\s*light/, `${name} 亮色分派`);
    assert.match(inline, /:root\[data-theme="dark"\]\s*\{[^}]*color-scheme:\s*dark/, `${name} 暗色分派`);
    // 合并后的数据源同样满足原 B2-13 断言
    assert.match(styleText(html), /:root\[data-theme="dark"\]\s*\{[^}]*color-scheme:\s*dark/, `${name} 合并数据源`);
  }
});

// ── 4：<script src> 依赖顺序 utils → state → app ─────────────────────
test('结构#4：两页外链脚本按 utils → state → app 顺序加载', () => {
  for (const [name, html] of [['index', INDEX_HTML], ['admin', ADMIN_HTML]]) {
    const srcs = [...html.matchAll(/<script\b[^>]*\bsrc\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi)]
      .map((m) => m[2] ?? m[3] ?? m[4]);
    assert.ok(srcs.length >= 3, `${name} 应外链多个脚本`);
    const at = (kw) => srcs.findIndex((s) => s.includes(kw));
    const iUtils = at('utils');
    const iState = at('state');
    const iApp = at('app');
    assert.ok(iUtils >= 0 && iState >= 0 && iApp >= 0, `${name} 三个脚本都要有`);
    assert.ok(iUtils < iState, `${name}: utils 必须先于 state`);
    assert.ok(iState < iApp, `${name}: state 必须先于 app`);
    // 外链脚本不能带 type（测试正则只认无属性 <script> 与 src 形式）
    for (const m of html.matchAll(/<script\b([^>]*)\bsrc[^>]*>/gi)) {
      assert.doesNotMatch(m[1], /\btype\s*=/, `${name}: <script src> 不得带 type`);
    }
    // HTML 末尾保留无属性内联引导块，暴露 vm 需要的全局
    assert.match(html, /window\.state\s*=\s*state/, `${name} 引导块暴露 window.state`);
  }
  assert.match(ADMIN_HTML, /window\.renderAccounts\s*=\s*renderAccounts/, 'admin 引导块暴露 renderAccounts');
  assert.match(ADMIN_HTML, /window\.renderKeys\s*=\s*renderKeys/, 'admin 引导块暴露 renderKeys');
});

// ── 顶栏视图切换器：两个真实踩到的坑，各留一条哨兵 ─────────────────────────
// ① Astro **不解析引号内的 `{}`**：class="a b{cond ? ' c' : ''}" 会原样输出成字面量类名，
//    于是 `join-item` 连同选择器语法一起变成垃圾 token（按钮组拼合失效），而想要的 `is-active`
//    得靠 JS 补。必须用 class:list 或反引号模板字符串。
test('UI-结构：HTML 的 class 属性不得漏出 Astro 模板字面量（引号内 {} 不被解析）', () => {
  const files = ['index.html', 'admin.html', 'trend.html'];
  const bad = [];
  for (const f of files) {
    const html = fs.readFileSync(new URL('../panel/dist/' + f, import.meta.url), 'utf8');
    for (const m of html.match(/class="[^"]*\{[^"]*"/g) || []) bad.push(f + ': ' + m.slice(0, 70));
  }
  assert.deepEqual(bad, [], `class 属性里出现了未解析的 Astro 模板字面量：${bad.slice(0, 3).join(' | ')}`);
});

// ② daisyUI 5 的 `.btn` 落在 utilities 层（`@layer daisyui.l1.l2.l3`），而 components 层排在
//    utilities 之前 —— 跨层压制与特异性无关。所以只写在 @layer components 里的选中态规则会被
//    `.btn`（以及 `.btn:is([aria-pressed="true"])`）顶掉：实测线上选中按钮是浅灰而不是粉色。
//    这类规则必须留在所有 @layer 之外（非 layer 的普通 CSS 优先于任何 layer）。
test('UI-结构：需要压过 daisyUI 的规则必须放在所有 @layer 之外', () => {
  const css = fs.readFileSync(new URL('../panel/src/styles/panel.css', import.meta.url), 'utf8');
  const blocks = [];
  const re = /@layer\s+([\w.\-]+)\s*\{/g;
  let hit;
  while ((hit = re.exec(css)) !== null) {
    let depth = 1; let j = hit.index + hit[0].length;
    while (j < css.length && depth > 0) { if (css[j] === '{') depth++; else if (css[j] === '}') depth--; j++; }
    blocks.push({ name: hit[1], start: hit.index, end: j });
  }
  // 同一类坑的两处实例：daisyUI 的 .btn 与 .radial-progress 都在 utilities 层。
  for (const sel of ['.view-switch .view-btn.is-active', '.hero-gauge .radial-progress { --size: 1.5rem']) {
    const idx = css.indexOf(sel);
    assert.ok(idx > 0, `${sel} 必须在 panel.css 里存在`);
    const inside = blocks.filter((b) => idx > b.start && idx < b.end).map((b) => b.name);
    assert.deepEqual(inside, [], `${sel} 会被 daisyUI 的 utilities 层压过，必须放在所有 @layer 之外（实际落在：${inside.join(', ')}）`);
  }
});
