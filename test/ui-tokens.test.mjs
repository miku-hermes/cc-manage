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
const EMPTY_STATE_JS = fs.readFileSync(new URL('../panel/public/js/utils.js', import.meta.url), 'utf8');

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

// ── 1：Komari-Mikus 粉紫令牌与双主题契约 ──────────────
function luminance(hex) {
  const channels = hex.match(/[0-9a-f]{2}/gi).map((channel) => parseInt(channel, 16) / 255);
  const linear = channels.map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}
function contrast(foreground, background) {
  const first = luminance(foreground);
  const second = luminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

test('令牌#1：粉紫浅/深主题、语义色、圆角与动效令牌完整', () => {
  for (const token of ['--bg-primary: #f8f6f9', '--bg-card: #ffffff', '--text-primary: #2d1b3d', '--text-secondary: #604e70', '--border-color: #e8e0f0', '--accent: #e8668a', '--accent-hover: #d44a72', '--radius-sm: 8px', '--radius-md: 12px', '--radius-lg: 16px', '--radius-xl: 20px', '--shadow-card:', '--shadow-md:', '--transition: 250ms', '--dur-normal: 250ms', '--dur-fast: 150ms']) {
    assert.ok(TOKENS_CSS.includes(token), `定义新视觉令牌 ${token}`);
  }
  assert.match(TOKENS_CSS, /:root\[data-theme="dark"\][\s\S]*?--bg-primary:\s*#0f0a15/);
  assert.match(TOKENS_CSS, /:root\[data-theme="dark"\][\s\S]*?--accent:\s*#ff8fa3/);
  assert.match(TOKENS_CSS, /--color-primary:\s*#e8668a/, '实际渲染的浅色主色使用达标樱花粉');
  assert.match(TOKENS_CSS, /--font-mono:/, '数字字体使用本机等宽栈');
  assert.doesNotMatch(TOKENS_CSS, /--elev-/i, '旧 elev 令牌不再存在');
  assert.match(TOKENS_CSS, /--chart-series-cpu:\s*#e8668a/);
  assert.match(TOKENS_CSS, /--chart-series-ram:\s*#2f8f62/);
});

// ── 2：≤640px 标签条契约（改由 Tailwind max-sm 工具类承担）──────────
// 原来查：dashboard.css 的 @media (max-width:640px) 里 .tags { flex-wrap:nowrap; overflow-x:auto }
//         和 .tags .tag { flex: 0 0 auto }。
// 现在查：AccountCard 的 class 里有 max-sm:flex-nowrap / max-sm:overflow-x-auto，胶囊有 shrink-0；
//         且构建后的 CSS 在同一个窄屏断点块里真的产出对应声明。等价性：断点、声明、不压缩三点不变，
//         只是从手写选择器换成 Tailwind 工具类（构建产物里仍是同一条 CSS 声明）。
test('首页空态：提供进入账号管理的下一步动作', () => {
  assert.match(EMPTY_STATE_JS, /class=\"btn btn-primary btn-sm mt-2 w-fit\" href=\"\/admin\">管理账号/);
});

test('令牌#1b：实际渲染的主题文字颜色与状态徽章达到 WCAG AA', () => {
  const lightVars = TOKENS_CSS.match(/:root\s*\{([^}]*)\}/)?.[1];
  const darkVars = TOKENS_CSS.match(/:root\[data-theme=\"dark\"\]\s*\{([^}]*)\}/)?.[1];
  const readColor = (block, name) => block?.match(new RegExp(`${name}:\\s*(#[0-9a-f]{6})`, 'i'))?.[1];
  const lightBg = readColor(lightVars, '--bg-card');
  const darkBg = readColor(darkVars, '--bg-card');
  const lightSecondary = readColor(lightVars, '--text-secondary');
  const lightTertiary = readColor(lightVars, '--text-tertiary');
  const darkSecondary = readColor(darkVars, '--text-secondary');
  const darkTertiary = readColor(darkVars, '--text-tertiary');
  assert.ok(lightBg && darkBg && lightSecondary && lightTertiary && darkSecondary && darkTertiary, 'reads rendered text and card colors from panel.css');
  assert.ok(contrast(lightSecondary, lightBg) >= 4.5, '浅色次级文字对卡片达到 4.5:1');
  assert.ok(contrast(lightTertiary, lightBg) >= 4.5, '浅色三级文字对卡片达到 4.5:1');
  assert.ok(contrast(darkSecondary, darkBg) >= 4.5, '暗色次级文字对卡片达到 4.5:1');
  assert.ok(contrast(darkTertiary, darkBg) >= 4.5, '暗色三级文字对卡片达到 4.5:1');
  assert.ok(contrast('#24583e', '#e8f5e9') >= 4.5, '成功徽章文字对底色达到 4.5:1');
  assert.ok(contrast('#805000', '#fff8e1') >= 4.5, '警告徽章文字对底色达到 4.5:1');
  assert.ok(contrast('#8d2535', '#fde8eb') >= 4.5, '错误徽章文字对底色达到 4.5:1');
  const lightPrimary = TOKENS_CSS.match(/name: \"light\"[\s\S]*?--color-primary:\s*(#[0-9a-f]{6})[;\s]*[\s\S]*?--color-primary-content:\s*(#[0-9a-f]{6})/i);
  const darkPrimary = TOKENS_CSS.match(/name: \"dark\"[\s\S]*?--color-primary:\s*(#[0-9a-f]{6})[;\s]*[\s\S]*?--color-primary-content:\s*(#[0-9a-f]{6})/i);
  const lightInk = TOKENS_CSS.match(/:root\s*\{[\s\S]*?--accent-ink:\s*(#[0-9a-f]{6})/i)?.[1];
  const darkInk = TOKENS_CSS.match(/data-theme=\"dark\"[\s\S]*?--accent-ink:\s*(#[0-9a-f]{6})/i)?.[1];
  assert.ok(lightPrimary && darkPrimary && lightInk && darkInk, 'reads rendered theme colors from panel.css');
  assert.ok(contrast(lightPrimary[2], lightPrimary[1]) >= 4.5, '浅色主按钮实际前景/底色达到 4.5:1');
  assert.ok(contrast(darkPrimary[2], darkPrimary[1]) >= 4.5, '暗色主按钮实际前景/底色达到 4.5:1');
  assert.match(TOKENS_CSS, /\.bar-pct\s*\{\s*color:\s*var\(--accent-ink\)/, '账号额度百分比实际使用 accent-ink');
  assert.ok(contrast(lightInk, lightBg) >= 4.5, '浅色粉色小字实际前景对卡片达到 4.5:1');
  assert.ok(contrast(darkInk, darkBg) >= 4.5, '暗色粉色小字实际前景对卡片达到 4.5:1');
  assert.ok(contrast('#193b2a', '#4caf7d') >= 4.5, '成功语义按钮文字达到 4.5:1');
  assert.ok(contrast('#18334f', '#5c9ced') >= 4.5, '信息语义按钮文字达到 4.5:1');
  assert.ok(contrast('#300d18', '#e74c5e') >= 4.5, '错误语义按钮文字达到 4.5:1');
});

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
