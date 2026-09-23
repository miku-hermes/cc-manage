// 批次 2：设计系统令牌 / 断点契约 / 降级动效的回归。
// 只读 public/css/*.css 与合并样式文本；不联网、不起服务。
// 约定：这些用例在未修复（旧浅色令牌、无 --glass-*、无 reduced-motion）的源码上必须变红。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { styleText } from './helpers.mjs';

const INDEX_HTML = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const TOKENS_CSS = fs.readFileSync(new URL('../public/css/tokens.css', import.meta.url), 'utf8');
const BASE_CSS = fs.readFileSync(new URL('../public/css/base.css', import.meta.url), 'utf8');

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
test('令牌#1：tokens.css 定义 --glass-bg / --glass-blur 与 --dur-250 / --ease-out', () => {
  assert.match(TOKENS_CSS, /--glass-bg:\s*rgba\(255,\s*255,\s*255,\s*\.?\d*7\)/, '玻璃底色 rgba(255,255,255,.7) 量级');
  assert.match(TOKENS_CSS, /--glass-blur:\s*16px/, '玻璃模糊 16px');
  assert.match(TOKENS_CSS, /--glass-border:/, '玻璃描边令牌');
  assert.match(TOKENS_CSS, /--dur-250:\s*250ms/, '弹框动效时长 250ms');
  assert.match(TOKENS_CSS, /--dur-150:\s*150ms/, '交互动效时长 150ms');
  assert.match(TOKENS_CSS, /--ease-out:\s*cubic-bezier\(\.22,\s*\.61,\s*\.36,\s*1\)/, '统一缓出曲线');
  assert.match(TOKENS_CSS, /--elev-1:/, '柔和分层阴影 1');
  assert.match(TOKENS_CSS, /--elev-2:/, '柔和分层阴影 2');
});

// ── 2：dashboard.css ≤640px 标签条契约（合并样式源，同 mobile-tags）──
test('令牌#2：dashboard.css ≤640px 标签条单行横滚契约仍成立', () => {
  const css = styleText(INDEX_HTML).replace(/\/\*[\s\S]*?\*\//g, '');
  const mobile = mediaBlocks(css, 'max-width: 640px').join('\n');
  assert.ok(mobile, '存在 @media (max-width: 640px) 块');

  const tagsRules = rules(mobile).filter((r) => r.selector.split(',').map((s) => s.trim()).includes('.tags'));
  assert.ok(tagsRules.length > 0, '≤640px 块内存在作用于 .tags 的规则');
  const body = tagsRules.map((r) => r.body).join('\n').replace(/\s+/g, ' ');
  assert.match(body, /flex-wrap:\s*nowrap/, '窄屏 .tags 必须 flex-wrap: nowrap');
  assert.match(body, /overflow-x:\s*auto/, '窄屏 .tags 必须 overflow-x: auto');

  const tagRules = rules(mobile).filter((r) => r.selector.split(',').map((s) => s.trim()).includes('.tags .tag'));
  assert.ok(tagRules.length > 0, '≤640px 块内存在 .tags .tag 规则');
  const tagBody = tagRules.map((r) => r.body).join('\n').replace(/\s+/g, ' ');
  assert.match(tagBody, /flex:\s*0\s+0\s+auto/, '窄屏 pill 不压缩：flex: 0 0 auto');
});

// ── 3：base.css 提供 prefers-reduced-motion 降级 ─────────────────
test('令牌#3：base.css 含 prefers-reduced-motion 全局降级块', () => {
  const blocks = mediaBlocks(BASE_CSS.replace(/\/\*[\s\S]*?\*\//g, ''), 'prefers-reduced-motion: reduce');
  assert.ok(blocks.length > 0, 'base.css 要有 @media (prefers-reduced-motion: reduce) 块');
  const body = blocks.join('\n');
  assert.match(body, /transition-duration:\s*0?\.01ms\s*!important/, '过渡时长为 0.01ms 且 !important');
  assert.match(body, /animation-duration:\s*0?\.01ms\s*!important/, '动画时长为 0.01ms 且 !important');
});
