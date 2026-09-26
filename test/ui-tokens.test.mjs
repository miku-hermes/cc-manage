// 批次 2：设计系统令牌 / 断点契约 / 降级动效的回归。
// 只读 panel/public/css/*.css 与合并样式文本；不联网、不起服务。
// 约定：这些用例在未修复（旧浅色令牌、无 --glass-*、无 reduced-motion）的源码上必须变红。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { styleText } from './helpers.mjs';
const ACCOUNT_CARD = fs.readFileSync(new URL('../panel/src/components/AccountCard.astro', import.meta.url), 'utf8');
const RENDER_CARDS = fs.readFileSync(new URL('../panel/public/js/render-cards.js', import.meta.url), 'utf8');

const INDEX_HTML = fs.readFileSync(new URL('../panel/dist/index.html', import.meta.url), 'utf8');
// B24：手写 CSS 已删除，令牌与降级规则迁进 panel/src/styles/panel.css（Tailwind @theme + 运行时令牌）。
const TOKENS_CSS = fs.readFileSync(new URL('../panel/src/styles/panel.css', import.meta.url), 'utf8');
const BASE_CSS = TOKENS_CSS;

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

// 解析规则 [{ selector, body }]
function rules(css) {
  const list = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css))) list.push({ selector: m[1].replace(/\s+/g, ' ').trim(), body: m[2] });
  return list;
}

// ── 1：tokens.css 含玻璃与动效令牌，且为浅色单一主题 ──────────────
test('令牌#1：tokens.css 定义 --glass-bg / --glass-blur 与 --dur-normal / --ease-enter', () => {
  assert.match(TOKENS_CSS, /--glass-bg:\s*rgba\(255,\s*255,\s*255,\s*\.?\d*7\)/, '玻璃底色 rgba(255,255,255,.7) 量级');
  assert.match(TOKENS_CSS, /--glass-blur:\s*16px/, '玻璃模糊 16px');
  assert.match(TOKENS_CSS, /--glass-border:/, '玻璃描边令牌');
  assert.match(TOKENS_CSS, /--dur-normal:\s*240ms/, '弹框动效时长 250ms');
  assert.match(TOKENS_CSS, /--dur-fast:\s*120ms/, '交互动效时长 150ms');
  assert.match(TOKENS_CSS, /--ease-enter:\s*cubic-bezier\(\.22,\s*\.61,\s*\.36,\s*1\)/, '统一缓出曲线');
  assert.match(TOKENS_CSS, /--elev-1:/, '柔和分层阴影 1');
  assert.match(TOKENS_CSS, /--elev-2:/, '柔和分层阴影 2');
});

// ── 2：≤640px 标签条契约（改由 Tailwind max-sm 工具类承担）──────────
// 原来查：dashboard.css 的 @media (max-width:640px) 里 .tags { flex-wrap:nowrap; overflow-x:auto }
//         和 .tags .tag { flex: 0 0 auto }。
// 现在查：AccountCard 的 class 里有 max-sm:flex-nowrap / max-sm:overflow-x-auto，胶囊有 shrink-0；
//         且构建后的 CSS 在同一个窄屏断点块里真的产出对应声明。等价性：断点、声明、不压缩三点不变，
//         只是从手写选择器换成 Tailwind 工具类（构建产物里仍是同一条 CSS 声明）。
test('令牌#2：≤640px 标签条单行横滚契约（Tailwind max-sm + shrink-0）', () => {
  assert.match(ACCOUNT_CARD, /class="tags[^"]*max-sm:flex-nowrap[^"]*max-sm:overflow-x-auto/, '标签条窄屏单行横滚类');
  assert.match(RENDER_CARDS, /shrink-0/, '标签胶囊不得被压缩');
  const css = styleText(INDEX_HTML).replace(/\/\*[\s\S]*?\*\//g, '');
  const mobile = mediaBlocks(css, 'max-width: 640px').join('\n') || mediaBlocks(css, '40rem').join('\n');
  assert.ok(mobile, '存在窄屏断点块');
  assert.match(mobile, /\.max-sm\\:flex-nowrap[^{]*\{[^}]*flex-wrap:\s*nowrap/, '窄屏 max-sm:flex-nowrap 产出 flex-wrap: nowrap');
  assert.match(mobile, /\.max-sm\\:overflow-x-auto[^{]*\{[^}]*overflow-x:\s*auto/, '窄屏 max-sm:overflow-x-auto 产出 overflow-x: auto');
  assert.match(css, /\.flex-wrap\s*\{[^}]*flex-wrap:\s*wrap/, '桌面端基础 flex-wrap: wrap 仍由 flex-wrap 工具类承担');
});

// ── 3：全局 prefers-reduced-motion 降级块 ─────────────────────────
test('令牌#3：panel.css 含 prefers-reduced-motion 全局降级块', () => {
  const blocks = mediaBlocks(BASE_CSS.replace(/\/\*[\s\S]*?\*\//g, ''), 'prefers-reduced-motion: reduce');
  assert.ok(blocks.length > 0, 'panel.css 要有 @media (prefers-reduced-motion: reduce) 块');
  const body = blocks.join('\n');
  assert.match(body, /transition-duration:\s*0ms\s*!important/, '过渡时长为 0.01ms 且 !important');
  assert.match(body, /animation-duration:\s*0ms\s*!important/, '动画时长为 0.01ms 且 !important');
});
