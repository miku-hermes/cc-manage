import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startTestGateway } from './helpers.mjs';

function findPlaywright() {
  const root = path.join(os.homedir(), '.npm/_npx');
  if (!fs.existsSync(root)) return null;
  let dirs;
  try { dirs = fs.readdirSync(root); } catch { return null; }
  for (const dir of dirs) {
    const candidate = path.join(root, dir, 'node_modules/playwright/index.js');
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

test('/trend：浏览器几何、图表令牌颜色与统计卡样式', async (t) => {
  const playwrightPath = findPlaywright();
  if (!playwrightPath) { t.skip('本机无 Playwright（趋势浏览器几何/样式实测）'); return; }
  const ctx = await startTestGateway({ accounts: [{ name: '趋势样例', key: 'user_trend_sample' }], noInitialRefresh: true });
  t.after(() => ctx.close());
  const imported = await import(playwrightPath);
  const browser = await (imported.default ?? imported).chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 375, height: 900 } });
  await page.route('**/api/history**', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, samples: Array.from({ length: 13 }, (_, i) => ({ t: Date.now() - (12 - i) * 300000, r: i * 3, e: i % 4 === 0 ? 1 : 0, m: 100 - i })) }) }));
  await page.route('**/api/status', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, accounts: [{ keyId: 'user_trend_sample', available: true, lastQuota: { remaining: 88 } }] }) }));
  await page.goto(ctx.baseUrl + '/trend', { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.querySelectorAll('#trend-stats > *').length === 4);
  await page.waitForFunction(() => !!window.echarts?.getInstanceByDom(document.querySelector('#trend .trend-chart')));
  const measurements = await page.evaluate(() => {
    const main = document.querySelector('main');
    const headerContent = document.querySelector('.navbar-row');
    const card = document.querySelector('#trend-stats .stat');
    const option = window.echarts.getInstanceByDom(document.querySelector('#trend .trend-chart')).getOption();
    const colors = option.series.map(series => series.lineStyle?.color);
    return {
      mainLeft: main.getBoundingClientRect().left,
      headerLeft: headerContent.getBoundingClientRect().left,
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      cardBorder: getComputedStyle(card).borderTopWidth,
      cardRadius: getComputedStyle(card).borderRadius,
      cardShadow: getComputedStyle(card).boxShadow,
      colors,
      tokenColors: ['--chart-series-request', '--chart-series-error', '--chart-series-balance'].map(name => getComputedStyle(document.documentElement).getPropertyValue(name).trim()),
    };
  });
  assert.equal(measurements.mainLeft, measurements.headerLeft, 'main 与顶栏内容左边界相同');
  assert.ok(measurements.scrollWidth <= measurements.clientWidth, `375px 横向溢出 ${measurements.scrollWidth} > ${measurements.clientWidth}`);
  for (const token of measurements.tokenColors) assert.ok(measurements.colors.includes(token), `图表未使用令牌颜色 ${token}`);
  assert.equal(measurements.cardBorder, '1px');
  assert.ok(measurements.cardRadius !== '0px');
  assert.ok(measurements.cardShadow !== 'none');
  console.log('/trend 浏览器实测（375px）', JSON.stringify(measurements));
});
