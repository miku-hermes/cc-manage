// 导航（B24 改写）：搜索框展开态、登录后台按钮、极窄屏断点。
// 只读 panel/src/components/SiteHeader.astro、panel/src/styles/panel.css 与 js/app.js；不联网。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { styleText } from './helpers.mjs';

const INDEX_HTML = fs.readFileSync(new URL('../panel/dist/index.html', import.meta.url), 'utf8');
const SITE_HEADER = fs.readFileSync(new URL('../panel/src/components/SiteHeader.astro', import.meta.url), 'utf8');
const PANEL_CSS = fs.readFileSync(new URL('../panel/src/styles/panel.css', import.meta.url), 'utf8');
const APP_JS = fs.readFileSync(new URL('../panel/public/js/app.js', import.meta.url), 'utf8');
const BUILD_CSS = styleText(INDEX_HTML).replace(/\/\*[\s\S]*?\*\//g, '');

// 从 css[start]（'{' 缺失处）匹配成对花括号，返回块内文本
function braceBlock(css, start) {
  const open = css.indexOf('{', start);
  assert.ok(open >= 0, '找到 {');
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') { depth -= 1; if (depth === 0) return css.slice(open + 1, i); }
  }
  throw new Error('花括号不配平');
}
function mediaBlocks(css, query) {
  const blocks = [];
  const re = /@media[^{]*\{/g;
  let m;
  while ((m = re.exec(css))) {
    if (m[0].slice(0, -1).replace(/\s+/g, ' ').trim().includes(query)) blocks.push(braceBlock(css, m.index));
  }
  return blocks;
}

// ── 1：展开态宽度真的变大（.expanded 与 :focus-within 两条路径）──
// 原来查：components.css 里 `.search-box.expanded input, .search-box:focus-within input { opacity: 1 }`。
// 现在查：SiteHeader 的 search-box 同时带 [&.expanded]:w-44 与 focus-within:w-44，且构建 CSS 里
//         两条选择器都产出 width 声明。等价性：都是「展开态让输入框可见/可用」，从 opacity 换成宽度。
test('导航#1：展开态同时由 .expanded 与 :focus-within 驱动，且宽度真的展开', () => {
  assert.match(SITE_HEADER, /\[&\.expanded\]:w-44/, 'expanded 类展开宽度');
  assert.match(SITE_HEADER, /focus-within:w-44/, 'focus-within 也展开');
  // Tailwind v4 把 w-44 编译成 calc(var(--spacing) * 44)；配合根 --spacing:.25rem 即 11rem。
  assert.match(BUILD_CSS, /\.expanded[^{]*\{[^}]*width:\s*calc\(var\(--spacing\)\s*\*\s*44\)/, '.expanded 产出宽度声明（w-44）');
  assert.match(BUILD_CSS, /:focus-within[^{]*\{[^}]*width:\s*calc\(var\(--spacing\)\s*\*\s*44\)/, ':focus-within 产出宽度声明（w-44）');
  assert.match(BUILD_CSS, /--spacing:\s*\.25rem/, '根 --spacing:.25rem → w-44 实际就是 11rem');
});

// ── 2：折叠态固定窄盒，输入框可收缩 ───────────────────────────────
test('导航#2：折叠态是固定窄盒（w-10），输入框 min-w-0 可收缩', () => {
  // w-10 = 2.5rem = 40px：内容需 39px（px-2 两侧留白 + 15px 图标）。此前的 w-9(36px) / 窄屏
  // w-8(32px) 装不下，实测 scrollWidth 39 > clientWidth 27，放大镜被裁掉一截。
  assert.match(SITE_HEADER, /class="search-box[^"]*\bw-10\b/, '折叠态固定宽度（40px，够装图标）');
  assert.match(SITE_HEADER, /id="search"[^>]*class="[^"]*min-w-0/, '输入框 min-w-0（不撑破窄盒）');
});

// ── 3：登录后台按钮用 daisyUI 的圆形按钮 ──────────────────────────
test('导航#3：.admin-link 用 daisyUI btn/btn-ghost/btn-circle，不再是裸图标', () => {
  assert.match(SITE_HEADER, /class="admin-link btn btn-ghost btn-circle btn-sm/, '.admin-link 是 daisyUI 圆形按钮');
  assert.match(BUILD_CSS, /\.btn-circle\s*\{[^}]*border-radius/, 'btn-circle 产出圆角声明');
  // daisyUI 5 的 btn-ghost 用 --btn-bg:#0000 表达透明底（#0000 = 全透明），语义等价。
  assert.match(BUILD_CSS, /\.btn-ghost\s*\{[^}]*--btn-bg:\s*#0000/, 'btn-ghost 产出透明底（--btn-bg:#0000）');
});

// ── 4：≤340px 极窄屏的展开宽度被单独压住 ─────────────────────────
test('导航#4：≤340px 极窄屏的展开宽度被单独收紧（max-[340px] 覆盖 :focus-within）', () => {
  assert.match(SITE_HEADER, /max-\[340px\]:focus-within:w-28/, '极窄屏 focus-within 宽度');
  assert.match(SITE_HEADER, /max-\[340px\]:\[&\.expanded\]:w-28/, '极窄屏 expanded 宽度');
  // Tailwind v4 的 max-[340px] 编译成 `@media not all and (min-width:340px)`；旧写法是 max-width。
  const narrow = mediaBlocks(BUILD_CSS, 'max-width: 340px').join('\n')
    || mediaBlocks(BUILD_CSS, 'width < 340px').join('\n')
    || mediaBlocks(BUILD_CSS, 'not all and (min-width:340px)').join('\n');
  assert.ok(narrow, '存在 ≤340px 断点块');
  assert.match(narrow, /focus-within[^{]*\{[^}]*width/, '≤340px 块里覆盖 :focus-within 的宽度');
});

// ── 5：JS 展开/收起健壮（点 input 也展开 + focusin 兜底）─────────
test('导航#5：app.js 点击 .search-box 不再排除 INPUT，且有 focusin 兜底', () => {
  const clickStart = APP_JS.indexOf("addEventListener('click'");
  assert.ok(clickStart >= 0, "存在 document 级 click 委托");
  const rest = APP_JS.slice(clickStart + 1);
  const nextListener = rest.indexOf("addEventListener(");
  const clickHandler = nextListener >= 0 ? rest.slice(0, nextListener) : rest;

  assert.doesNotMatch(clickHandler, /[^!]!\(t\.tagName && t\.tagName\.toUpperCase\(\) === 'INPUT'\)/,
    'click 处理不再把 INPUT 目标排除在展开逻辑之外');
  assert.match(clickHandler, /INPUT'\)[\s\S]{0,200}?add\('expanded'\)/,
    'click 处理里存在对 INPUT 目标补 expanded 的分支');

  assert.match(APP_JS, /addEventListener\('focusin'/,
    "存在 focusin 监听：焦点落进 .search-box 就补 expanded");
});
