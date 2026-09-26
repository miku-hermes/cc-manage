// B38：顶栏品牌 logo（照抄参考主题 komari-mikus）
//
// 背景：顶栏原来用 lucide 的 Activity 图标当 logo，用户要求改成参考主题的那张图。
// 这里锁三件事：①用的是图片而不是手绘图标；②样式与参考主题一致（36px / object-fit:contain /
// 窄屏 28px / 悬停旋转）；③/img/ 前缀真的能取到图（静态路由前缀白名单容易漏，本轮实测漏过一次），
// 且防穿越与未知扩展名仍然 404。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startTestGateway } from './helpers.mjs';

const SITE_HEADER = fs.readFileSync(new URL('../panel/src/components/SiteHeader.astro', import.meta.url), 'utf8');
const PANEL_CSS = fs.readFileSync(new URL('../panel/src/styles/panel.css', import.meta.url), 'utf8');
const LOGO_FILE = new URL('../panel/public/img/miku.png', import.meta.url);

test('B38-1：顶栏品牌 logo 是参考主题的图片，不再用手绘图标', () => {
  assert.ok(fs.existsSync(LOGO_FILE), 'panel/public/img/miku.png 必须存在（参考主题的 logo 原图）');
  assert.match(SITE_HEADER, /<img class="logo-icon" src="\/img\/miku\.png"/,
    '顶栏必须用 <img class="logo-icon" src="/img/miku.png">');
  assert.doesNotMatch(SITE_HEADER, /\bActivity\b/,
    '不得再引入手绘的 Activity 图标（用户要求照抄参考主题的图）');
});

test('B38-2：logo 样式与参考主题一致（尺寸 / 不压扁 / 窄屏 / 悬停）', () => {
  // 原图 474×355（4:3 横版）：没有 object-fit:contain 会被压成正方。
  const iconRule = /\.logo-icon\s*\{([^}]*)\}/.exec(PANEL_CSS);
  assert.ok(iconRule, '必须有 .logo-icon 规则');
  const body = iconRule[1];
  assert.match(body, /width:\s*36px/, '宽 36px（与参考主题一致）');
  assert.match(body, /height:\s*36px/, '高 36px');
  assert.match(body, /object-fit:\s*contain/, 'object-fit:contain —— 否则 474×355 的图会被压扁');
  assert.match(body, /border-radius/, '必须有圆角');
  assert.match(PANEL_CSS, /@media\s*\(max-width:\s*639px\)\s*\{[\s\S]{0,300}?\.logo-icon\s*\{[^}]*width:\s*28px/,
    '窄屏缩到 28px（与参考主题一致）');
  assert.match(PANEL_CSS, /\.logo:hover\s+\.logo-icon\s*\{[^}]*rotate\(-10deg\)/,
    '悬停旋转 -10deg（与参考主题一致）');
});

test('B38-3：/img/ 能取到图，且防穿越与未知扩展名仍 404', async (t) => {
  const ctx = await startTestGateway({ accounts: [{ name: '主号', key: 'user_test_alpha', enabled: true }] });
  t.after(() => ctx.close());

  const ok = await fetch(ctx.baseUrl + '/img/miku.png');
  assert.equal(ok.status, 200, '/img/miku.png 必须 200（静态路由前缀白名单要放行 /img/）');
  assert.equal(ok.headers.get('content-type'), 'image/png', 'MIME 必须是 image/png');
  // 关键：/img/ 不能落进 immutable 分支 —— 这张图文件名没有内容哈希，长缓存会导致换图不生效。
  assert.equal(ok.headers.get('cache-control'), 'no-cache', '/img/ 必须 no-cache（无内容哈希）');
  const bytes = Buffer.from(await ok.arrayBuffer());
  assert.equal(bytes.subarray(1, 4).toString('ascii'), 'PNG', '返回的必须是真正的 PNG 数据');

  // 安全边界不能被这次放行削弱
  assert.equal((await fetch(ctx.baseUrl + '/img/../gateway.mjs')).status, 404, '穿越路径必须 404');
  assert.equal((await fetch(ctx.baseUrl + '/img/nope.png')).status, 404, '不存在的图片必须 404');
  assert.equal((await fetch(ctx.baseUrl + '/img/evil.txt')).status, 404, '非白名单扩展名必须 404');
});
