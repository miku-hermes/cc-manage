// 批次 8：导航栏三处缺陷的回归（搜索框展开态不可见 / 图标未居中 / 登录后台裸图标）。
// 只读 public/css/components.css、public/css/dashboard.css 与 public/js/app.js；
// 不联网、不起服务。用例在批次 7 的（修复前）源码上必须变红。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const COMPONENTS_CSS = fs.readFileSync(new URL('../public/css/components.css', import.meta.url), 'utf8');
const DASHBOARD_CSS = fs.readFileSync(new URL('../public/css/dashboard.css', import.meta.url), 'utf8');
const APP_JS = fs.readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');

// 从 css[start]（'{' 缺失处）匹配成对花括号，返回块内文本
function braceBlock(css, start) {
  const open = css.indexOf('{', start);
  assert.ok(open >= 0, '找到 {');
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  throw new Error('花括号不配平');
}

// 返回所有 header 含 query 的 @media 块内容
function mediaBlocks(css, query) {
  const blocks = [];
  const re = /@media[^{]*\{/g;
  let m;
  while ((m = re.exec(css))) {
    const header = m[0].slice(0, -1).replace(/\s+/g, ' ').trim();
    if (header.includes(query)) blocks.push(braceBlock(css, m.index));
  }
  return blocks;
}

// 解析规则 [{ selector, body, selectors: [...] }]
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

// ── 1：搜索框展开态文字可见，且不依赖 .expanded 类 ───────────────
test('导航#1：components.css 展开态 input 同时挂 .expanded 与 :focus-within，且 opacity: 1', () => {
  const css = COMPONENTS_CSS.replace(/\/\*[\s\S]*?\*\//g, '');
  const hit = rules(css).filter((r) => r.selectors.includes('.search-box.expanded input')
    && r.selectors.includes('.search-box:focus-within input'));
  assert.ok(hit.length > 0,
    '存在同时匹配 .search-box.expanded input 与 .search-box:focus-within input 的规则');
  const body = hit.map((r) => r.body).join('\n').replace(/\s+/g, ' ');
  assert.match(body, /opacity:\s*1/, '展开态规则体必须含 opacity: 1（打字可见）');
});

// ── 2：折叠态 36px 盒子里只留图标，靠 justify-content 居中 ────────
test('导航#2：components.css 的 .search-box input 为 flex: 0 0 auto（图标居中）', () => {
  const css = COMPONENTS_CSS.replace(/\/\*[\s\S]*?\*\//g, '');
  const hit = rules(css).filter((r) => r.selectors.includes('.search-box input'));
  assert.ok(hit.length > 0, '存在 .search-box input 规则');
  const body = hit.map((r) => r.body).join('\n').replace(/\s+/g, ' ');
  assert.match(body, /flex:\s*0\s+0\s+auto/, '.search-box input 必须 flex: 0 0 auto');
});

// ── 3：登录后台恢复按钮外观，与 .icon-btn 成组 ────────────────────
test('导航#3：components.css 的 .admin-link 有描边与底色，不再是裸图标', () => {
  const css = COMPONENTS_CSS.replace(/\/\*[\s\S]*?\*\//g, '');
  const hit = rules(css).filter((r) => r.selectors.includes('.admin-link'));
  assert.ok(hit.length > 0, '存在 .admin-link 规则');
  const body = hit.map((r) => r.body).join('\n').replace(/\s+/g, ' ');
  assert.match(body, /border:\s*1px solid/, '.admin-link 必须有 1px solid 描边');
  assert.match(body, /background:\s*var\(--surface-1\)/, '.admin-link 必须有 surface-1 底色');
  assert.doesNotMatch(body, /border:\s*none/, '.admin-link 不再允许 border: none');

  const hover = rules(css).filter((r) => r.selectors.includes('.admin-link:hover'));
  assert.ok(hover.length > 0, '存在 .admin-link:hover 规则');
  const hoverBody = hover.map((r) => r.body).join('\n').replace(/\s+/g, ' ');
  assert.match(hoverBody, /border-color:\s*var\(--accent\)/, 'hover 描边用 accent（同 .icon-btn）');
  assert.match(hoverBody, /background:\s*var\(--accent-light\)/, 'hover 底色用 accent-light（同 .icon-btn）');
});

// ── 4：≤340px 极窄屏规则同步覆盖 :focus-within ────────────────────
test('导航#4：dashboard.css ≤340px 块的 .search-box 展开规则覆盖 :focus-within', () => {
  const css = DASHBOARD_CSS.replace(/\/\*[\s\S]*?\*\//g, '');
  const blocks = mediaBlocks(css, 'max-width: 340px');
  assert.ok(blocks.length > 0, '存在 @media (max-width: 340px) 块');
  const narrow = blocks.join('\n');
  const hit = rules(narrow).filter((r) => r.selectors.includes('.search-box.expanded'));
  assert.ok(hit.length > 0, '≤340px 块内存在 .search-box.expanded 规则');
  assert.ok(hit.some((r) => r.selectors.includes('.search-box:focus-within')),
    '≤340px 块内同一规则要同时覆盖 .search-box:focus-within');
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
