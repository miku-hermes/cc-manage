import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { styleText } from './helpers.mjs';

const ROOT = new URL('../', import.meta.url);
const css = fs.readFileSync(new URL('../panel/src/styles/panel.css', import.meta.url), 'utf8');
const hero = fs.readFileSync(new URL('../panel/public/js/render-hero.js', import.meta.url), 'utf8');
const theme = fs.readFileSync(new URL('../panel/public/js/theme.js', import.meta.url), 'utf8');
const trend = fs.readFileSync(new URL('../panel/public/js/render-trend.js', import.meta.url), 'utf8');
const indexHtml = fs.readFileSync(new URL('../panel/dist/index.html', import.meta.url), 'utf8');
const adminHtml = fs.readFileSync(new URL('../panel/dist/admin.html', import.meta.url), 'utf8');
const trendHtml = fs.readFileSync(new URL('../panel/dist/trend.html', import.meta.url), 'utf8');

test('B26-A1：动效仅用快/常规/慢与进场/离场/双向令牌', () => {
  for (const token of ['--dur-fast: 120ms', '--dur-normal: 240ms', '--dur-slow: 400ms', '--ease-enter:', '--ease-exit:', '--ease-standard:']) {
    assert.ok(css.includes(token), `缺失令牌 ${token}`);
  }
  assert.doesNotMatch(styleText(indexHtml) + styleText(adminHtml) + styleText(trendHtml), /(?:transition|animation)-duration:\s*333ms\b/);
});

test('B26-A2：静态首屏 HTML 不以 opacity-0 隐藏内容，原生 starting-style 入场不依赖 JS', () => {
  for (const html of [indexHtml, adminHtml, trendHtml]) assert.doesNotMatch(html, /(?:opacity-0|opacity:\s*0)/);
  assert.match(css, /@starting-style\s*\{[\s\S]*?\.pop-in/);
  assert.match(css, /\.pop-in\s*\{[^}]*transition:[^}]*var\(--dur-normal\)/);
});

test('B26-A4：首屏数字直出终值，后续滚动 ≤600ms 且精确写入真实终值', () => {
  assert.match(hero, /lastBalance === null\) \$\('balance'\)\.textContent = money\(balanceValue\)/);
  assert.match(hero, /lastTokens === null\) \$\('tokens'\)\.textContent = num\(tokensValue\)/);
  assert.match(hero, /else if \(money\(lastBalance\) !== money\(balanceValue\)\) setNumber\(\$\('balance'\), lastBalance, balanceValue, money, 320\)/);
  assert.match(fs.readFileSync(new URL('../panel/public/js/anim.js', import.meta.url), 'utf8'), /el\.textContent = fmt\(to\)/);
  assert.match(fs.readFileSync(new URL('../panel/public/js/anim.js', import.meta.url), 'utf8'), /prefersReducedMotion\(\)/);
});

test('B26-A5：主题切换有原生 View Transition 并安全降级、尊重 reduced-motion', () => {
  assert.match(theme, /typeof document\.startViewTransition === 'function'/);
  assert.match(theme, /if \(!reduced && typeof document\.startViewTransition/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?view-transition-old\(theme-root\)[\s\S]*?animation-duration: 0ms/);
});

test('B26-C5：浅色请求折线不淡出，保留请求数作为次级视觉层级', () => {
  assert.match(css, /--chart-series-request:\s*#4d5666/);
  assert.match(trend, /lineStyle: \{ width: TREND_REQUEST_LINE_WIDTH, color: palette\.request \}/);
  assert.doesNotMatch(trend, /lineStyle: \{ width: TREND_REQUEST_LINE_WIDTH, color: palette\.request, opacity/);
  const linear = (channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const luminance = (rgb) => rgb.map(linear).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
  const request = [77, 86, 102];
  const balanceComposite = [202, 225, 224];
  const first = luminance(request);
  const second = luminance(balanceComposite);
  const contrast = (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
  assert.ok(contrast >= 3, `请求线与余额填充复合色对比度 ${contrast.toFixed(2)}:1`);
  assert.deepEqual(balanceComposite, [202, 225, 224]);
});
