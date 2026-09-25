// 前端重构批次 1：HTML 壳 + 外部 css/js 的静态结构回归。
// 只读 panel/* 文本 + 起真实网关验证静态路由；不联网。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startTestGateway, request, inlineStyleText, styleText } from './helpers.mjs';

const INDEX_HTML = fs.readFileSync(new URL('../panel/dist/index.html', import.meta.url), 'utf8');
const ADMIN_HTML = fs.readFileSync(new URL('../panel/src/pages/admin.astro', import.meta.url), 'utf8');

// ── 1：静态路由 200 + MIME ───────────────────────────────────────────
test('结构#1：GET /css/tokens.css 与 /js/state.js 返回 200 且 MIME 正确', async (t) => {
  const ctx = await startTestGateway();
  t.after(() => ctx.close());

  const css = await request(`${ctx.baseUrl}/css/tokens.css`);
  assert.equal(css.status, 200, 'tokens.css 必须可取');
  assert.match(css.headers['content-type'], /^text\/css; charset=utf-8$/i, 'css MIME');
  assert.match(css.body, /:root\s*\{[\s\S]*--/, 'tokens.css 里应有设计令牌');
  assert.match(css.headers['content-security-policy'], /script-src/, '静态资源也要带 CSP 头');

  const js = await request(`${ctx.baseUrl}/js/state.js`);
  assert.equal(js.status, 200, 'state.js 必须可取');
  assert.match(js.headers['content-type'], /^text\/javascript; charset=utf-8$/i, 'js MIME');
  assert.match(js.body, /const state\s*=/, 'state.js 里应有全局 state');
});

// ── 2：路径穿越必须 404 ──────────────────────────────────────────────
test('结构#2：/css/../ 与 /js/../ 等穿越路径一律 404', async (t) => {
  const ctx = await startTestGateway();
  t.after(() => ctx.close());
  const paths = [
    '/css/../gateway.mjs',
    '/js/../gateway.mjs',
    '/css/../../etc/passwd',
    '/css/%2e%2e/gateway.mjs',
    '/js/..%2f..%2fpackage.json',
    '/css/nope.css',
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
