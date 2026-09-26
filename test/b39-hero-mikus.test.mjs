// B39：Hero 看板娘（素材取自参考主题 komari-mikus 的 mikus.jpg）
//
// 用户要求「用 komari-mikus 的素材 那个金发少女」。参考主题里这张图只是主题预览图
// （komari-theme.json 的 "preview": "mikus.jpg"，页面未使用），所以这里放到 Hero
// 装饰层当氛围图：靠右下、左缘渐隐、低透明度不压数据、窄屏隐藏。
//
// 锁四件事：①图片本体在、且是压缩过的 webp；②静态路由放行 .webp；
// ③DOM 引用了它；④装饰层不得抢数据层的点击（pointer-events:none）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { startTestGateway } from './helpers.mjs';

// 测试的 cwd 就是项目根（与 b38 一致），直接用相对路径读
const read = (p) => readFileSync(p, 'utf8');
const HERO = 'panel/src/components/HeroCard.astro';
const CSS = 'panel/src/styles/panel.css';

test('B39-1：看板娘素材存在且已压缩（参考主题原图 609.8KB → webp）', () => {
  const st = statSync('panel/public/img/mikus.webp');
  // 原图 3541x2213 / 609.8KB，直接进首屏太重；压到 1200 宽后必须小于 200KB
  assert.ok(st.size > 20 * 1024, `webp 体积异常小：${st.size}`);
  assert.ok(st.size < 200 * 1024, `webp 未压缩到位：${(st.size / 1024).toFixed(1)}KB`);
  const b = readFileSync('panel/public/img/mikus.webp');
  assert.equal(b.subarray(0, 4).toString('latin1'), 'RIFF', '不是 RIFF 容器');
  assert.equal(b.subarray(8, 12).toString('latin1'), 'WEBP', '不是 WebP');
});

test('B39-2：DOM 把看板娘放进 Hero 装饰层，且不拦点击', () => {
  const src = read(HERO);
  assert.match(src, /<img class="hero-mikus" src="\/img\/mikus\.webp"/, 'Hero 必须引用压缩后的 webp');
  assert.match(src, /class="hero-deco"[^>]*aria-hidden="true"/, '看板娘属于装饰，必须在 aria-hidden 的装饰层里');
  // 装饰层的 CSS 必须 pointer-events:none，否则会挡住刷新/趋势按钮
  const css = read(CSS);
  const m = /\.hero-deco \{[^}]*\}/.exec(css);
  assert.ok(m, '.hero-deco 规则缺失');
  assert.match(m[0], /pointer-events:\s*none/, '装饰层必须不拦截指针');
});

test('B39-3：样式给了渐隐与低透明度，窄屏隐藏', () => {
  const css = read(CSS);
  const m = /\.hero-deco \.hero-mikus \{[^}]*\}/.exec(css);
  assert.ok(m, '.hero-deco .hero-mikus 规则缺失');
  const rule = m[0];
  assert.match(rule, /mask-image:\s*linear-gradient/, '必须有渐隐遮罩，否则硬边很难看');
  assert.match(rule, /opacity:\s*0?\.\d+/, '必须半透明，不能压住余额/环');
  assert.match(rule, /pointer-events:\s*none/);
  // 窄屏整段隐藏
  const narrow = /@media \(max-width: 639px\) \{\s*\.hero-deco \.hero-mikus \{ display: none; \}/.exec(css);
  assert.ok(narrow, '窄屏必须隐藏看板娘（Hero 空间不足）');
});

test('B39-4：静态路由放行 .webp，且未知扩展名/穿越仍 404', async (t) => {
  const ctx = await startTestGateway();
  t.after(() => ctx.close());
  const ok = await fetch(ctx.baseUrl + '/img/mikus.webp');
  assert.equal(ok.status, 200, '.webp 必须可访问');
  assert.equal(ok.headers.get('content-type'), 'image/webp');
  const body = Buffer.from(await ok.arrayBuffer());
  assert.equal(body.subarray(8, 12).toString('latin1'), 'WEBP', '响应的确是 WebP');
  // 放行 .webp 不得削弱安全边界
  assert.equal((await fetch(ctx.baseUrl + '/img/../gateway.mjs')).status, 404, '防穿越失效');
  assert.equal((await fetch(ctx.baseUrl + '/img/evil.txt')).status, 404, '未知扩展名被放行了');
  assert.equal((await fetch(ctx.baseUrl + '/img/mikus.webp.bak')).status, 404, '多段后缀被放行了');
});
