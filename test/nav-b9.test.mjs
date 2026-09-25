// 批次 9：四个实测缺陷的回归（搜索框闪烁 / 输入框多余线框 / 暗色主题失效 / 后台首屏闪）。
// 只读 panel/public/css/*.css、panel/public/js/*.js 与两页 HTML(.astro) 文本；不联网、不起服务。
// 用例在批次 9 的（修复前）源码上必须变红。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const INDEX_HTML = fs.readFileSync(new URL('../panel/dist/index.html', import.meta.url), 'utf8');
const ADMIN_HTML = fs.readFileSync(new URL('../panel/dist/admin.html', import.meta.url), 'utf8');
// B24：手写 tokens/components.css 已删除；令牌在 panel/src/styles/panel.css。
const TOKENS_CSS = fs.readFileSync(new URL('../panel/src/styles/panel.css', import.meta.url), 'utf8');
const SITE_HEADER = fs.readFileSync(new URL('../panel/src/components/SiteHeader.astro', import.meta.url), 'utf8');
const APP_JS = fs.readFileSync(new URL('../panel/public/js/app.js', import.meta.url), 'utf8');
const RENDER_GATE_JS = fs.readFileSync(new URL('../panel/public/js/render-gate.js', import.meta.url), 'utf8');

// 从 text[start]（'{' 缺失处）匹配成对花括号，返回块内文本
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

// 取某个选择器的声明块文本
function blockOf(css, selector) {
  const idx = css.indexOf(selector);
  assert.ok(idx >= 0, `存在 ${selector}`);
  return braceBlock(css, idx);
}

// 从声明块里取令牌值
function token(block, name) {
  const m = new RegExp(`--${name}:\\s*([^;]+);`).exec(block);
  return m ? m[1].trim() : null;
}

// ── 1：真有一套深色令牌（不是空壳）──────────────────────────────────
// 原来查：:root 与 :root[data-theme="dark"] 的 --surface-* 不同。
// 现在查：daisyUI 自定义主题对 light/dark 的 --color-base-* 不同，且深色主题覆盖面/文字/品牌色并带
//         color-scheme: dark。等价性：仍是「浅深两套基础色真的不同 + 关键面/文字/品牌令牌齐全」。
test('批次9#1：daisyUI dark 主题的 --color-base-100 与 light 不同，且基础令牌齐全', () => {
  // 主题块的 `{` 在 `name: "light"` 之前，所以从 name 处向左找块首。
  const themeBlock = (name) => {
    const at = TOKENS_CSS.indexOf('name: "' + name + '"');
    assert.ok(at > 0, `panel.css 里有 ${name} 主题块`);
    return braceBlock(TOKENS_CSS, TOKENS_CSS.lastIndexOf('{', at));
  };
  const light = themeBlock('light');
  const dark = themeBlock('dark');
  const lightBase = token(light, 'color-base-100');
  const darkBase = token(dark, 'color-base-100');
  assert.ok(lightBase, 'light 主题有 --color-base-100');
  assert.ok(darkBase, 'dark 主题必须有 --color-base-100');
  assert.notEqual(darkBase, lightBase, 'dark --color-base-100 必须与 light 不同（真深色底）');
  for (const name of ['color-base-200', 'color-base-300', 'color-base-content', 'color-primary']) {
    assert.ok(token(dark, name), `dark 主题必须定义 --${name}`);
  }
  assert.match(dark, /color-scheme:\s*dark/, 'dark 主题带 color-scheme: dark');
});

// ── 2：焦点环只有一层，且键盘可见 ────────────────────────────────
// 原来查：.search-box input:focus-visible { outline: none }（去掉多余的第三层线框）。
// 现在查：搜索框不再自带 outline-none，由 panel.css 的全局 :focus-visible 统一画 2px 焦点环。
//         等价性：仍是「搜索框不叠自己的焦点框」，且焦点环变成全局一致、可见（a11y 只升不降）。
test('批次9#2：搜索框不自绘焦点框，由全局 :focus-visible 统一提供可见焦点环', () => {
  assert.doesNotMatch(SITE_HEADER, /outline-none/, '搜索框 input 不得屏蔽焦点环');
  const css = TOKENS_CSS.replace(/\/\*[\s\S]*?\*\//g, '');
  const hit = rules(css).filter((r) => r.selectors.includes(':focus-visible'));
  assert.ok(hit.length > 0, '存在 :focus-visible 规则');
  const body = hit.map((r) => r.body).join('\n').replace(/\s+/g, ' ');
  assert.match(body, /outline:\s*2px solid/, '全局焦点环是 2px 实线');
});

// ── 3：点搜索框图标只展开、绝不收起 ─────────────────────────────────
test('批次9#3：app.js 搜索框点击分支只有 add(\'expanded\')，不再 toggle 收起', () => {
  const clickStart = APP_JS.indexOf("addEventListener('click'");
  assert.ok(clickStart >= 0, '存在 document 级 click 委托');
  const rest = APP_JS.slice(clickStart + 1);
  const nextListener = rest.indexOf('addEventListener(');
  const clickHandler = nextListener >= 0 ? rest.slice(0, nextListener) : rest;

  assert.doesNotMatch(clickHandler, /classList\.toggle\('expanded'\)/,
    '点击分支不得再 toggle expanded（否则「展开→缩回→再展开」会闪）');
  assert.match(clickHandler, /classList\.add\('expanded'\)/,
    '点击分支必须补 expanded（点图标只展开）');
  assert.match(clickHandler, /INPUT'\)[\s\S]{0,200}?add\('expanded'\)/,
    '点输入框本身也要展开');
});

// ── 4：两页 <head> 都有预绘制主题脚本 ───────────────────────────────
test('批次9#4：index.html / admin.html 的 <head> 内联预绘制主题脚本', () => {
  for (const [name, html] of [['index', INDEX_HTML], ['admin', ADMIN_HTML]]) {
    const headEnd = html.indexOf('</head>');
    assert.ok(headEnd > 0, `${name} 有 </head>`);
    const head = html.slice(0, headEnd);
    assert.match(head, /<script>/, `${name} 的 <head> 里有内联脚本`);
    assert.match(head, /localStorage\.getItem\('cc-manage-theme'\)/, `${name} 预绘制脚本读已保存主题`);
    assert.match(head, /prefers-color-scheme:\s*dark/, `${name} 预绘制脚本回退到系统偏好`);
    assert.match(head, /document\.documentElement\.setAttribute\('data-theme'/, `${name} 预绘制脚本写 data-theme`);
    assert.match(head, /catch\s*\(/, `${name} 预绘制脚本必须 try/catch 兜底`);
  }
});

// ── 5：后台首屏先显示无表单的加载占位 ───────────────────────────────
test('批次9#5：admin.html 隐藏 #gate-main 并插入 #boot-loading 占位，render-gate 负责隐藏它', () => {
  assert.match(ADMIN_HTML, /<main[^>]*id="gate-main"[^>]*style="display:none"/,
    '#gate-main 初始必须 display:none（别先画登录表单）');
  assert.match(ADMIN_HTML, /<main[^>]*id="boot-loading"/, '存在 #boot-loading 加载占位');

  // 占位里绝不能出现表单字段（那正是要避免闪出来的内容）
  const bootStart = ADMIN_HTML.indexOf('id="boot-loading"');
  const bootEnd = ADMIN_HTML.indexOf('</main>', bootStart);
  assert.ok(bootEnd > bootStart, '#boot-loading 有闭合 </main>');
  const boot = ADMIN_HTML.slice(bootStart, bootEnd);
  assert.doesNotMatch(boot, /<input\b/, '加载占位不得包含任何 input');
  assert.doesNotMatch(boot, /type="password"/, '加载占位不得包含密码框');

  for (const fn of ['showGate', 'showAdmin']) {
    const idx = RENDER_GATE_JS.indexOf(`function ${fn}(`);
    assert.ok(idx >= 0, `render-gate.js 存在 ${fn}`);
    const body = braceBlock(RENDER_GATE_JS, idx);
    assert.match(body, /\$\('boot-loading'\)\.style\.display\s*=\s*'none'/,
      `${fn} 必须隐藏 #boot-loading`);
  }
});
