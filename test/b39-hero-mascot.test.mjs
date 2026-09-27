// B39：Hero 看板娘 —— 参考主题 komari-mikus 的 QWQ.webp（金发魔女装少女）
//
// 用户要求「用 komari-mikus 的素材 那个金发少女」。
// 教训：第一版我错拿了仓库根的 mikus.jpg —— 那是 komari-theme.json 里的主题预览图
// （"preview": "mikus.jpg"），页面并不使用它。真正在页面里当素材的是 dist/assets/img/QWQ.webp
// （index.html 里 <img class="greeting-icon" src="assets/img/QWQ.webp">，问候语旁的 mascot）。
// 判断"页面素材"只看 dist/index.html 引用了什么，别看仓库根散落的大图。
//
// 参考主题的形态照抄：绝对定位挂在问候语左上方（故意溢出容器）、上下弹跳、
// 问候语用 padding-left 让位。尺寸按 cc-manage 的 Hero 高度收敛。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { startTestGateway } from './helpers.mjs';

const read = (p) => readFileSync(p, 'utf8');

test('B39-1：用的是页面素材 QWQ.webp，不是预览图 mikus.jpg', () => {
  const f = 'panel/public/img/QWQ.webp';
  assert.ok(existsSync(f), 'QWQ.webp 必须存在');
  const b = readFileSync(f);
  assert.equal(b.subarray(0, 4).toString('latin1'), 'RIFF', '不是 RIFF 容器');
  assert.equal(b.subarray(8, 12).toString('latin1'), 'WEBP', '不是 WebP');
  // 预览图不该再出现在面板资源里（上一版误用它当看板娘）
  assert.ok(!existsSync('panel/public/img/mikus.webp'), '预览图 mikus.webp 不该留在面板资源里');
});

test('B39-2：DOM 引用 QWQ.webp 作为问候语 mascot，旧头像与旧水印都已移除', () => {
  const hero = read('panel/src/components/HeroCard.astro');
  assert.match(hero, /<img class="hero-mascot" src="\/img\/QWQ\.webp"/, 'Hero 必须引用 QWQ.webp');
  assert.doesNotMatch(hero, /hero-avatar/, '旧的猫脸头像 SVG 应已移除');
  assert.doesNotMatch(hero, /hero-mikus/, '上一版误用的预览图水印应已移除');
  // 图标要能溢出卡片外（参考主题就是挂在上方露出），所以 Hero 不能裁切
  const tag = /<section class="([^"]*)"/.exec(hero);
  assert.ok(tag, '找到 Hero section');
  assert.doesNotMatch(tag[1], /overflow-hidden/, 'Hero 不能 overflow-hidden，否则 mascot 会被裁掉');
});

test('B39-3：样式照抄参考主题（绝对定位 + 上下弹跳 + 问候语让位 + 降级）', () => {
  const css = read('panel/src/styles/panel.css');
  const m = /\.hero-mascot \{[^}]*\}/.exec(css);
  assert.ok(m, '.hero-mascot 规则缺失');
  const rule = m[0];
  assert.match(rule, /position:\s*absolute/, '必须绝对定位（参考主题挂在问候语左上方）');
  assert.match(rule, /object-fit:\s*contain/, '必须 contain，否则竖版 3:4 图会被压扁');
  assert.match(rule, /animation:\s*hero-bounce/, '必须有弹跳动画');
  assert.match(rule, /pointer-events:\s*none/, '不能拦点击');

  // keyframes 是多层嵌套的一行，截块容易在嵌套 } 处截断 —— 直接按偏移取窗口判断
  const kfIdx = css.indexOf('@keyframes hero-bounce');
  assert.ok(kfIdx !== -1, 'hero-bounce 关键帧缺失');
  assert.match(css.slice(kfIdx, kfIdx + 220), /translateY\(-10px\)/, '弹跳幅度与参考主题一致（-10px）');

  const ident = /\.hero-ident \{[^}]*\}/.exec(css);
  assert.ok(ident, '.hero-ident 规则缺失');
  assert.match(ident[0], /padding-left:\s*\d+px/, '问候语必须让位给图标，否则文字会压在图上');

  assert.match(css, /prefers-reduced-motion[\s\S]{0,140}\.hero-mascot \{ animation: none; \}/, '必须有动效降级');
  const narrow = /@media \(max-width: 639px\) \{[\s\S]*?\.hero-mascot \{ width: 76px;[\s\S]*?\}/.exec(css);
  assert.ok(narrow, '窄屏必须有收窄规则');
});

test('B39-4：静态路由放行 QWQ.webp，已删的预览图 404，安全边界不松', async (t) => {
  const ctx = await startTestGateway();
  t.after(() => ctx.close());
  const ok = await fetch(ctx.baseUrl + '/img/QWQ.webp');
  assert.equal(ok.status, 200, '.webp 必须可访问');
  assert.equal(ok.headers.get('content-type'), 'image/webp');
  const body = Buffer.from(await ok.arrayBuffer());
  assert.equal(body.subarray(8, 12).toString('latin1'), 'WEBP', '响应的确是 WebP');
  assert.equal((await fetch(ctx.baseUrl + '/img/mikus.webp')).status, 404, '误用的预览图应已删除');
  assert.equal((await fetch(ctx.baseUrl + '/img/../gateway.mjs')).status, 404, '防穿越失效');
  assert.equal((await fetch(ctx.baseUrl + '/img/evil.txt')).status, 404, '未知扩展名被放行了');
});
