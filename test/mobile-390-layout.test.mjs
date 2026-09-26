import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const html = read('panel/dist/index.html');
const cssPath = html.match(/href="([^"]+\.css)"/)?.[1];
const css = cssPath ? read(`panel/dist/${cssPath.replace(/^\//, '')}`) : '';

test('MOBILE-390-1：窄屏趋势链接独占一行，避免 Hero 内容横向裁切', () => {
  assert.match(read('panel/src/components/HeroCard.astro'), /hero-aside[^\"]*flex-wrap/);
  assert.match(css, /@media\s*\(max-width:\s*639px\)[^{]*\{[^}]*\.hero-aside \.trend-link\s*\{[^}]*flex-basis:\s*100%/s,
    '产物 CSS 必须在手机断点将趋势链接放到完整新行');
  assert.match(css, /\.hero-aside \.trend-link\s*\{[^}]*justify-content:\s*flex-start/s);
});

test('MOBILE-390-2：KPI 采用窄屏单列 Grid，桌面双列，避免 stats 横向溢出', () => {
  const source = read('panel/src/pages/index.astro');
  assert.match(source, /id="kpis" class="kpis grid[^\"]*grid-cols-1[^\"]*lg:grid-cols-2/);
  assert.doesNotMatch(source.match(/id="kpis"[^>]+/)?.[0] || '', /\bstats(?:-vertical|-horizontal)?\b/);
  assert.match(css, /\.grid-cols-1\s*\{\s*grid-template-columns:\s*repeat\(1,minmax\(0,1fr\)\)/);
  assert.match(css, /@media\s*\(min-width:\s*64rem\)/);
  assert.match(css, /\.lg\\:grid-cols-2\s*\{\s*grid-template-columns:\s*repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(html, /id="kpis" class="kpis grid[^\"]*grid-cols-1[^\"]*lg:grid-cols-2/);
});

test('MOBILE-390-3：viewport-fit cover 配合仅窄屏生效的安全区底部留白', () => {
  assert.match(read('panel/src/layouts/Layout.astro'), /name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"/);
  assert.match(read('panel/src/styles/panel.css'), /padding-bottom:\s*1rem;\s*padding-bottom:\s*max\(1rem, env\(safe-area-inset-bottom\)\)/);
  assert.match(css, /@media\s*\(max-width:\s*639px\)[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*body\s*\{[^}]*padding-bottom:\s*1rem;[^}]*padding-bottom:\s*max\(1rem,env\(safe-area-inset-bottom\)\)/s,
    '安全区留白必须带 1rem 回退值，且限定手机断点');
  assert.match(html, /viewport-fit=cover/);
});
