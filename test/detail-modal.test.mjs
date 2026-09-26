import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { startTestGateway } from './helpers.mjs';


test('详情窗口格式化：真实帮助函数输出已用额度、百分比与秒制重置时间', () => {
  const source = fs.readFileSync(new URL('../panel/public/js/detail.js', import.meta.url), 'utf8');
  const start = source.indexOf('function detailMoney');
  const end = source.indexOf('function detailChartLoad');
  assert.ok(start >= 0 && end > start, '详情窗口格式化函数存在');
  const elements = [];
  const document = { createElement() { const el = { children:[], appendChild(child) { this.children.push(child); } }; elements.push(el); return el; } };
  const context = { document, Date, Number, Math }; vm.runInNewContext(source.slice(start, end) + '\nglobalThis.makeWindow = detailWindow;', context);
  const node = context.makeWindow('5 小时', { used:2, cap:10, percent:20, resetAt:1893456000 }, Date.now());
  const text = elements.map(el => el.textContent).join(' ');
  assert.match(text, /已用 \$2\.00 \/ 上限 \$10\.00（20\.0%）/);
  assert.match(text, /重置 \d+\/\d+ \d{2}:\d{2}/);
  elements.length = 0;
  context.makeWindow('本月', null, Date.now());
  assert.match(elements.map(el => el.textContent).join(' '), /无数据/);
  assert.doesNotMatch(elements.map(el => el.textContent).join(' '), /0%/);
});

function findPlaywright() {
  const root = path.join(os.homedir(), '.npm/_npx');
  if (!fs.existsSync(root)) return null;
  let dirs = [];
  try { dirs = fs.readdirSync(root); } catch { return null; }
  for (const dir of dirs) {
    const candidate = path.join(root, dir, 'node_modules/playwright/index.js');
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

test('首页详情：真实数据填充、模态框 inert/焦点归还与窄屏布局', async (t) => {
  const playwrightPath = findPlaywright();
  if (!playwrightPath) { t.skip('本机无 Playwright（首页详情），详情 DOM 与窗口计算仍由此测试的固定接口断言覆盖'); return; }
  const ctx = await startTestGateway({ accounts: [{ name: '详情样例', key: 'user_detail_sample' }], noInitialRefresh: true });
  t.after(() => ctx.close());
  const imported = await import(playwrightPath);
  const browser = await (imported.default ?? imported).chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 375, height: 900 } });
  const status = { ok: true, accounts: [{ name:'详情样例',keyId:'user_detail_sample',enabled:true,available:true,lastQuota:{fetchedAt:Date.now(),remaining:8,plan:{planId:'pro'},credits:{monthlyCredits:10,purchasedCredits:2,freeCredits:1},fiveHour:{used:2,cap:10,percent:20,resetAt:1893456000},weekly:{used:5,cap:20,percent:25,resetAt:1893542400},monthly:{used:3,cap:30,percent:10,resetAt:1893628800}} }] };
  await page.route('**/api/status', route => route.fulfill({ contentType:'application/json', body:JSON.stringify(status) }));
  let actualKeyId = '';
  await page.route('**/api/history/accounts', route => route.fulfill({ contentType:'application/json', body:JSON.stringify({ok:true,accounts:[{keyId:actualKeyId || 'user_detail_sample',samples:[{t:Date.now()-60000,remaining:9},{t:Date.now(),remaining:8}],burnPerHour:1.25,etaHours:6.4}]}) }));
  await page.goto(ctx.baseUrl + '/', { waitUntil:'networkidle' });
  const trigger = page.getByRole('button', { name:'查看 详情样例 详情' });
  await trigger.waitFor();
  actualKeyId = await page.locator('.row-card').getAttribute('data-key-id');
  const originalNodes = await page.locator('body *').all();
  const originalInert = await Promise.all(originalNodes.map(node => node.getAttribute('inert')));
  await trigger.press('Enter');
  await page.waitForSelector('#m-detail.open');
  assert.equal(await page.locator('main').first().getAttribute('inert'), '');
  assert.equal(await page.locator('#m-detail').evaluate(el => el.contains(document.activeElement)), true);
  await page.waitForFunction(() => document.getElementById('m-detail-burn')?.textContent.includes('$1.25/小时'));
  assert.match(await page.locator('#m-detail-burn').innerText(), /最近平均消耗 \$1.25\/小时/);
  assert.notEqual(await page.locator('#m-detail-credits .seg-month').evaluate(el => getComputedStyle(el).backgroundColor), 'rgba(0, 0, 0, 0)');
  assert.match(await page.locator('#m-detail-windows').innerText(), /已用 \$2.00 \/ 上限 \$10.00（20.0%）/);
  assert.match(await page.locator('#m-detail-windows').innerText(), /重置/);
  assert.match(await page.locator('#m-detail-chart-empty').innerText(), /^$/);
  await page.keyboard.press('Escape');
  await page.waitForSelector('#m-detail:not(.open)');
  await page.route('**/api/history/accounts', route => route.fulfill({ contentType:'application/json', body:JSON.stringify({ok:true,accounts:[]}) }));
  await trigger.press('Enter');
  await page.waitForFunction(() => document.getElementById('m-detail-chart-empty')?.textContent === '数据不足');
  assert.equal(await page.locator('#m-detail h3').allInnerTexts().then(lines => lines.includes('消耗与预测')), true);
  const geometry = await page.evaluate(() => { const card=document.querySelector('.row-card'), summary=card.querySelector('.row-summary'), dialog=document.querySelector('.detail-dialog'); const status=card.querySelector('.acct-status'); const after={cardHeight:card.getBoundingClientRect().height,cardPadding:getComputedStyle(summary).paddingLeft,numberFont:getComputedStyle(document.querySelector('.usable-balance')).fontSize,lineGap:getComputedStyle(summary).rowGap,statusFont:getComputedStyle(status).fontSize,statusPadding:getComputedStyle(status).padding,dialogScrollWidth:dialog.scrollWidth,dialogClientWidth:dialog.clientWidth}; summary.style.paddingBlock='8px'; summary.style.paddingLeft='16px'; status.style.fontSize='12px'; status.style.padding='2px 8px'; const button=card.querySelector('.detail-trigger'); button.style.display='none'; const before={cardHeight:card.getBoundingClientRect().height,cardPadding:getComputedStyle(summary).paddingLeft,numberFont:after.numberFont,lineGap:getComputedStyle(summary).rowGap,statusFont:getComputedStyle(status).fontSize,statusPadding:getComputedStyle(status).padding}; summary.style.paddingBlock=''; summary.style.paddingLeft=''; status.style.fontSize=''; status.style.padding=''; button.style.display=''; return {before,after}; });
  assert.notEqual(geometry.after.cardPadding, geometry.before.cardPadding);
  assert.ok(parseFloat(geometry.after.statusFont) > parseFloat(geometry.before.statusFont));
  assert.ok(geometry.after.dialogScrollWidth <= geometry.after.dialogClientWidth, `详情横向溢出 ${geometry.after.dialogScrollWidth} > ${geometry.after.dialogClientWidth}`);
  console.log('首页账号卡尺寸（375px）', JSON.stringify(geometry));
  await page.evaluate(() => window.renderCards());
  const currentTrigger = page.locator(`.row-card[data-key-id="${actualKeyId}"] .detail-trigger`);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.getElementById('m-detail').classList.contains('open'));
  assert.equal(await page.locator('main').first().getAttribute('inert'), null);
  assert.equal(await currentTrigger.evaluate(el => el === document.activeElement), true);
  assert.deepEqual(await Promise.all(originalNodes.map(node => node.getAttribute('inert'))), originalInert);
  await currentTrigger.click();
  await page.waitForSelector('#m-detail.open');
  await page.locator('#m-detail .modal-backdrop').dispatchEvent('click');
  await page.waitForFunction(() => !document.getElementById('m-detail').classList.contains('open'));
  assert.equal(await currentTrigger.evaluate(el => el === document.activeElement), true);
});
