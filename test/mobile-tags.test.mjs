// 手机端标签条回归：只读 panel/src/pages/index.astro 文本，钉住 ≤640px 的 CSS 契约。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { styleText } from './helpers.mjs';

const INDEX_HTML = fs.readFileSync(new URL('../panel/dist/index.html', import.meta.url), 'utf8');

// styleText：内联 <style> + 外链 css 合并（见 helpers.mjs）

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

// 移除全部 @media 块，只留基础规则
function stripMedia(css) {
  let out = '';
  let i = 0;
  while (i < css.length) {
    const at = css.indexOf('@media', i);
    if (at < 0) { out += css.slice(i); break; }
    out += css.slice(i, at);
    const open = css.indexOf('{', at);
    const end = braceBlock(css, at).length;
    i = open + 1 + end + 1;
  }
  return out;
}

// 解析规则 [{ selector, body }]
function rules(css) {
  const list = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css))) list.push({ selector: m[1].replace(/\s+/g, ' ').trim(), body: m[2] });
  return list;
}

const CSS = styleText(INDEX_HTML).replace(/\/\*[\s\S]*?\*\//g, '');
const MOBILE = mediaBlocks(CSS, 'max-width: 640px').join('\n') || mediaBlocks(CSS, '40rem').join('\n');

test('移动端#1：≤640px 标签条强制单行 + 横向滚动（Tailwind max-sm 工具类）', () => {
  assert.ok(MOBILE, '存在窄屏断点块');
  // 原查 .tags { flex-wrap:nowrap; overflow-x:auto } / .tags .tag { flex: 0 0 auto }。
  // 现查构建后 CSS 里 max-sm 工具类的同名声明；胶囊不压缩由 shrink-0 承担。等价。
  assert.match(MOBILE, /\.max-sm\\:flex-nowrap[^{]*\{[^}]*flex-wrap:\s*nowrap/, '窄屏 flex-wrap: nowrap');
  assert.match(MOBILE, /\.max-sm\\:overflow-x-auto[^{]*\{[^}]*overflow-x:\s*auto/, '窄屏 overflow-x: auto');
  assert.match(CSS, /\.shrink-0\s*\{[^}]*flex-shrink:\s*0/, '胶囊 shrink-0 产出 flex-shrink: 0');
  assert.match(CSS, /\.flex-wrap\s*\{[^}]*flex-wrap:\s*wrap/, '桌面端基础 flex-wrap: wrap');
});
