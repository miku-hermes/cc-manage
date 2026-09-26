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

test('MOBILE-390-1：显式化窄屏趋势链接换行规则', () => {
  assert.match(read('panel/src/components/HeroCard.astro'), /hero-actions[^"]*flex-wrap/);
  assert.match(css, /@media\s*\(max-width:\s*639px\)[\s\S]{0,400}?\.hero-actions \.trend-link\s*\{[^}]*flex:\s*(?:1 1 auto|auto)/,
    '产物 CSS 必须在手机断点把趋势链接放成可伸展的一项（不与刷新按钮挤在半行）');
  assert.match(css, /\.hero-actions \.trend-link\s*\{[^}]*justify-content:\s*flex-start/s);
});
test('MOBILE-390-2：KPI 统计胶囊窄屏允许换行、桌面横排一行', () => {
  const source = read('panel/src/components/StatsBar.astro');
  assert.match(source, /id="kpis" class="kpis kpi-pills/);
  assert.doesNotMatch(source.match(/id="kpis"[^>]+/)?.[0] || '', /\bstats(?:-vertical|-horizontal)?\b/);
  assert.match(css, /\.kpi-pills\{[^}]*display:\s*flex/, '统计胶囊容器横排');
  assert.match(css, /\.kpi-pills\{[^}]*flex-wrap:\s*wrap/, '窄屏放不下时换行，而不是横向溢出');
  assert.match(css, /\.kpi-pills \.kpi\{[^}]*flex:\s*(?:0 1 auto|0 auto)/,
    '单个胶囊按内容宽排布（变异：挂 daisyUI .stat 的 width:100% 会独占一行）');
  assert.match(html, /id="kpis" class="kpis kpi-pills/);
});
test('MOBILE-390-3：viewport-fit cover 配合仅窄屏生效的安全区底部留白', () => {
  assert.match(read('panel/src/layouts/Layout.astro'), /name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"/);
  assert.match(read('panel/src/styles/panel.css'), /padding-bottom:\s*1rem;\s*padding-bottom:\s*max\(1rem, env\(safe-area-inset-bottom\)\)/);
  assert.match(css, /@media\s*\(max-width:\s*639px\)[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*body\s*\{[^}]*padding-bottom:\s*1rem;[^}]*padding-bottom:\s*max\(1rem,env\(safe-area-inset-bottom\)\)/s,
    '安全区留白必须带 1rem 回退值，且限定手机断点');
  assert.match(html, /viewport-fit=cover/);
});
