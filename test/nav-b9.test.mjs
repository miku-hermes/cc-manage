// 批次 9：四个实测缺陷的回归（搜索框闪烁 / 输入框多余线框 / 暗色主题失效 / 后台首屏闪）。
// 只读 panel/public/css/*.css、panel/public/js/*.js 与两页 HTML(.astro) 文本；不联网、不起服务。
// 用例在批次 9 的（修复前）源码上必须变红。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const INDEX_HTML = fs.readFileSync(new URL('../panel/src/pages/index.astro', import.meta.url), 'utf8');
const ADMIN_HTML = fs.readFileSync(new URL('../panel/src/pages/admin.astro', import.meta.url), 'utf8');
const TOKENS_CSS = fs.readFileSync(new URL('../panel/public/css/tokens.css', import.meta.url), 'utf8');
const COMPONENTS_CSS = fs.readFileSync(new URL('../panel/public/css/components.css', import.meta.url), 'utf8');
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

// ── 1：tokens.css 真有一套深色令牌（不是空壳）────────────────────────
test('批次9#1：tokens.css 的 :root[data-theme="dark"] 定义 --surface-0，且与浅色 :root 不同', () => {
  const light = blockOf(TOKENS_CSS, ':root {');
  const dark = blockOf(TOKENS_CSS, ':root[data-theme="dark"] {');

  const lightSurface = token(light, 'surface-0');
  const darkSurface = token(dark, 'surface-0');
  assert.ok(lightSurface, '浅色 :root 有 --surface-0');
  assert.ok(darkSurface, '深色块必须有 --surface-0');
  assert.notEqual(darkSurface, lightSurface, '深色 --surface-0 必须与浅色不同（真深色底，不是空壳）');

  // 关键面 / 文字令牌都要在，避免「只改了底色」的半套主题
  for (const name of ['surface-1', 'surface-2', 'border', 'text-primary', 'accent']) {
    assert.ok(token(dark, name), `深色块必须定义 --${name}`);
  }
  assert.match(dark, /color-scheme:\s*dark/, '深色块带 color-scheme: dark');
});

// ── 2：搜索框 input 不再自己画第三层焦点框 ───────────────────────────
test('批次9#2：components.css 的 .search-box input:focus-visible 去掉 outline', () => {
  const css = COMPONENTS_CSS.replace(/\/\*[\s\S]*?\*\//g, '');
  const hit = rules(css).filter((r) => r.selectors.includes('.search-box input:focus-visible'));
  assert.ok(hit.length > 0, '存在 .search-box input:focus-visible 规则');
  const body = hit.map((r) => r.body).join('\n').replace(/\s+/g, ' ');
  assert.match(body, /outline:\s*none/, '搜索框 input 的 focus-visible 必须 outline: none');
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
