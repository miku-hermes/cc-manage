// 后台 /admin 移动端适配（本批：P1 顶栏折行/重叠、P2 表格窄列折行、P3 概览账号卡溢出、P4 触控目标）。
//
// 全部断言只在真实 Chromium 里量渲染后的几何：不读源码猜，避免「规则在、效果不在」。
// 覆盖：
//   ① 390×844（dSF3 / isMobile / hasTouch）：6 个 hash 路由 + 未登录态
//      - header 单行（高度阈值）、navbar-start/end 不重叠、#who 不再压住左区
//      - 页面无横向溢出（documentElement.scrollWidth <= innerWidth）
//      - 表头 white-space:nowrap 且文本只有一行（P2）
//      - 概览账号行 scrollWidth <= clientWidth，名称用省略号而非硬裁（P3）
//      - 顶栏可点控件 ≥40×40（P4）
//   ② 768×1024（lg 断点以下、who 仍可见）：#who 必须在 navbar-end 内且单行（P1 根因档位）
//   ③ 1440×900 桌面零回归：header 仍 56px、侧边栏仍 224px。
//
// 既有断言一律不动；新增断言只放本文件。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startTestGateway, request } from './helpers.mjs';

// ── Playwright / Chromium 定位（与 b25-narrow-overflow / detail-modal 同一套写法）──
function findPlaywright() {
  const root = path.join(os.homedir(), '.npm/_npx');
  let dirs = [];
  try { dirs = fs.readdirSync(root); } catch { return null; }
  for (const d of dirs) {
    const p = path.join(root, d, 'node_modules/playwright/index.js');
    if (fs.existsSync(p)) return p;
  }
  return null;
}
function findChromium() {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(os.homedir(), '.cache/ms-playwright');
  let dirs = [];
  try { dirs = fs.readdirSync(root); } catch { return null; }
  for (const d of dirs) {
    if (!/^chromium-\d+$/.test(d)) continue;
    for (const rel of ['chrome-linux64/chrome', 'chrome-linux/chrome']) {
      const p = path.join(root, d, rel);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

const ROUTES = ['#/overview', '#/logs', '#/usage', '#/keys', '#/accounts', '#/settings'];
const ACCOUNTS = [
  { name: '主号', key: 'user_test_alpha', enabled: true },
  { name: '副号1', key: 'user_test_beta', enabled: true },
  { name: '副号2', key: 'user_test_gamma', enabled: true },
  { name: '副号3', key: 'user_test_delta', enabled: true },
];
const MOBILE_390 = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true };

// 只包含「可见叶控件」的几何，用来做两两重叠检测（display:none 的 #who 自动排除）。
const MEASURE = () => {
  const box = (el) => { const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height, right: b.right, bottom: b.bottom }; };
  const visible = (el) => {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    const b = el.getBoundingClientRect();
    return b.width > 0 && b.height > 0;
  };
  const header = document.getElementById('admin-head');
  const start = header ? header.querySelector('.navbar-start') : null;
  const end = header ? header.querySelector('.navbar-end') : null;
  const who = document.getElementById('who');
  const leaf = [...(header ? header.querySelectorAll('a, button, label, #who') : [])].filter(visible)
    .map((el) => ({ label: (el.id || el.getAttribute('aria-label') || el.textContent || el.tagName).trim().slice(0, 12), box: box(el) }));
  // 触控目标只算真正可点的控件（#who 是展示文字，不算）。
  const tappable = [...(header ? header.querySelectorAll('a, button, label') : [])].filter(visible)
    .map((el) => box(el));
  const overlaps = [];
  for (let i = 0; i < leaf.length; i++) {
    for (let j = i + 1; j < leaf.length; j++) {
      const a = leaf[i].box, b = leaf[j].box;
      const ox = Math.min(a.right, b.right) - Math.max(a.x, b.x);
      const oy = Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y);
      if (ox > 1 && oy > 1) overlaps.push(`${leaf[i].label}×${leaf[j].label}(${Math.round(ox)}×${Math.round(oy)})`);
    }
  }
  const lines = (el) => {
    const tn = [...el.childNodes].find((n) => n.nodeType === 3 && n.textContent.trim());
    if (!tn) return 1;
    const rg = document.createRange();
    rg.selectNodeContents(tn);
    return rg.getClientRects().length;
  };
  const activePage = [...document.querySelectorAll('.admin-page')].find((p) => !p.hasAttribute('hidden') && p.offsetParent !== null);
  const tables = activePage ? [...activePage.querySelectorAll('table')].map((tbl) => {
    const ths = [...tbl.querySelectorAll('thead th')];
    const tds = [...tbl.querySelectorAll('tbody td')];
    const scroller = tbl.closest('.overflow-x-auto') || tbl.parentElement;
    return {
      thWhite: [...new Set(ths.map((th) => getComputedStyle(th).whiteSpace))],
      thLines: ths.map(lines),
      tdWhite: [...new Set(tds.map((td) => getComputedStyle(td).whiteSpace))],
      tdLines: tds.map(lines).filter((n) => n !== null),
      theadTrH: tbl.querySelector('thead tr') ? Math.round(tbl.querySelector('thead tr').getBoundingClientRect().height) : 0,
      overflowX: scroller ? getComputedStyle(scroller).overflowX : null,
    };
  }) : [];
  const settingsPage = document.getElementById('page-settings');
  const settingsTaps = (settingsPage && settingsPage.offsetParent !== null)
    ? [...settingsPage.querySelectorAll('.toggle, .input, .btn')].filter(visible).map((el) => Math.min(box(el).w, box(el).h))
    : [];
  const accounts = (activePage ? [...activePage.querySelectorAll('.overview-account')] : []).map((a) => {
    const name = a.querySelector('.cell-name');
    const cs = name ? getComputedStyle(name) : null;
    return {
      sw: a.scrollWidth, cw: a.clientWidth,
      nameW: name ? Math.round(name.getBoundingClientRect().width) : 0,
      nameOverflow: cs ? cs.overflow : null, nameEllipsis: cs ? cs.textOverflow : null,
    };
  });
  return {
    headerVisible: !!header && visible(header),
    header: header ? box(header) : null,
    start: start ? box(start) : null,
    end: end ? box(end) : null,
    who: who && visible(who) ? box(who) : null,
    whoHidden: !!who && !visible(who),
    leaf, overlaps,
    controlsMin: tappable.length ? Math.min(...tappable.map((b) => Math.min(b.w, b.h))) : 0,
    docSW: document.documentElement.scrollWidth, bodySW: document.body.scrollWidth, iw: window.innerWidth,
    activePageId: activePage ? activePage.id : null,
    tables, accounts, settingsTaps,
  };
};

async function waitActive(page) {
  await page.waitForFunction(() => {
    const p = [...document.querySelectorAll('.admin-page')].find((x) => !x.hasAttribute('hidden') && x.offsetParent !== null);
    return !!p && document.getElementById('admin-main') && getComputedStyle(document.getElementById('admin-main')).display !== 'none';
  }, null, { timeout: 20000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(250);
}

test('移动端后台适配：header 单行不重叠 + 无横向溢出 + 表头 nowrap + 触控 ≥40 + 账号卡不溢出', async (t) => {
  const pwPath = findPlaywright();
  if (!pwPath) { t.skip('本机无 Playwright，跳过真实浏览器断言'); return; }
  if (process.env.CC_TEST_HANG_GUARD_MS === '900000') return; // 嵌套全量扫描时避让 CPU

  const ctx = await startTestGateway({ accounts: ACCOUNTS, config: { requestLogEnabled: true, requestLogRetentionDays: 7 } });
  t.after(() => ctx.close());

  // 建管理员 → 拿会话 cookie → 造几条请求日志（让 logs/usage 页有真实行可量）。
  const setup = await request(`${ctx.baseUrl}/api/auth/setup`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'hunter2-secret' }),
  });
  assert.equal(setup.status, 201, '建管理员必须成功');
  const cookieRaw = (Array.isArray(setup.headers['set-cookie']) ? setup.headers['set-cookie'] : [setup.headers['set-cookie']])
    .find((c) => c && c.startsWith('cc_session='));
  assert.ok(cookieRaw, '必须拿到 cc_session');
  const sessionValue = cookieRaw.split(';')[0].split('=')[1];
  for (let i = 0; i < 3; i++) {
    const r = await request(`${ctx.baseUrl}/v1/messages`, {
      method: 'POST', headers: { 'x-api-key': ctx.localKey, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-4-20250514', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(r.status, 200, `造日志 #${i + 1} 必须成功`);
  }

  const mod = await import(pwPath);
  const playwright = mod.default ?? mod;
  const browser = await playwright.chromium.launch();
  t.after(() => browser.close());

  // ── ① 手机 390×844，6 个路由 ───────────────────────────────────────
  const mobile = await browser.newContext(MOBILE_390);
  await mobile.addCookies([{ name: 'cc_session', value: sessionValue, domain: '127.0.0.1', path: '/' }]);
  const page = await mobile.newPage();
  t.after(() => mobile.close());
  const seen = new Set();
  for (const route of ROUTES) {
    await page.goto(ctx.baseUrl + '/admin' + route, { waitUntil: 'networkidle' });
    await waitActive(page);
    const m = await page.evaluate(MEASURE);
    seen.add(m.activePageId);

    // P1：header 单行（56px 上下），不再被 #who 折行撑到 77px。
    assert.ok(m.headerVisible, `${route}：默认态 #admin-head 必须可见`);
    assert.ok(m.header.h <= 64, `${route}：手机端 header 必须单行（实测 ${Math.round(m.header.h)}px > 64）`);
    assert.ok(m.header.h >= 44, `${route}：header 不应被压塌（实测 ${m.header.h}px）`);
    // P1：左右两区不重叠；#who 不得越出 navbar-end 压住「控制台」。
    assert.ok(m.start.right <= m.end.x + 1, `${route}：navbar-start 与 navbar-end 重叠（start.right=${Math.round(m.start.right)} > end.x=${Math.round(m.end.x)}）`);
    if (m.who) {
      assert.ok(m.who.x >= m.end.x - 1 && m.who.right <= m.end.right + 1,
        `${route}：#who 必须落在 navbar-end 内（who ${Math.round(m.who.x)}~${Math.round(m.who.right)} vs end ${Math.round(m.end.x)}~${Math.round(m.end.right)}）`);
      assert.ok(m.who.h <= 24, `${route}：#who 文字不得折行（实测高 ${Math.round(m.who.h)}px）`);
    } else {
      assert.ok(m.whoHidden, `${route}：#who 要么可见且单行，要么明确 display:none`);
    }
    assert.equal(m.overlaps.length, 0, `${route}：顶栏控件互相压住 → ${m.overlaps.join(', ')}`);

    // 无横向溢出（内部表格横滚必须靠容器，不许把文档撑宽）。
    assert.ok(m.docSW <= m.iw, `${route}：页面横向溢出 scrollWidth ${m.docSW} > innerWidth ${m.iw}`);

    // P2：表头 nowrap 且每格文本只有一行。
    for (const [i, tbl] of m.tables.entries()) {
      assert.deepEqual(tbl.thWhite, ['nowrap'], `${route}：表#${i} 表头必须 white-space:nowrap（实测 ${JSON.stringify(tbl.thWhite)}）`);
      assert.ok(tbl.thLines.every((n) => n === 1), `${route}：表#${i} 表头存在折行（文本块行数 ${JSON.stringify(tbl.thLines)}）`);
      assert.deepEqual(tbl.tdWhite, ['nowrap'], `${route}：表#${i} 单元格必须 white-space:nowrap（实测 ${JSON.stringify(tbl.tdWhite)}）`);
      assert.ok(tbl.tdLines.every((n) => n === 1), `${route}：表#${i} 单元格文本折行（行数 ${JSON.stringify(tbl.tdLines)}）`);
      assert.ok(tbl.overflowX === 'auto' || tbl.overflowX === 'scroll',
        `${route}：表#${i} 外层必须是可横滚容器（overflow-x=${tbl.overflowX}）`);
    }

    // P3：概览账号卡不溢出，名称用省略号。
    for (const [i, a] of m.accounts.entries()) {
      assert.ok(a.sw <= a.cw + 1, `${route}：账号行#${i} 内容溢出容器（scrollWidth ${a.sw} > clientWidth ${a.cw}）`);
      assert.ok(a.nameW > 0, `${route}：账号行#${i} 名称被挤成 0 宽`);
      assert.equal(a.nameEllipsis, 'ellipsis', `${route}：账号行#${i} 名称必须用省略号（text-overflow=${a.nameEllipsis}）`);
    }

    // P4：顶栏可点控件 ≥40×40。
    assert.ok(m.controlsMin >= 40, `${route}：顶栏触控目标偏小（最小边 ${m.controlsMin}px < 40）`);
    // P4（补充）：设置页开关/输入框/保存钮同样 ≥40。
    if (m.activePageId === 'page-settings') {
      assert.ok(m.settingsTaps.length > 0, '设置页必须量到可点控件');
      const worst = Math.min(...m.settingsTaps);
      assert.ok(worst >= 40, `设置页触控目标偏小（最小边 ${worst}px < 40）`);
    }
  }
  assert.deepEqual([...seen].sort(), ['page-accounts', 'page-keys', 'page-logs', 'page-overview', 'page-settings', 'page-usage'],
    `6 个路由都应真正切到对应页面（实得 ${[...seen].sort().join(',')}）`);

  // ── ② 768×1024（lg 以下、who 可见档）：P1 根因仍被堵住 ──────────────
  const tablet = await browser.newContext({ viewport: { width: 768, height: 1024 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await tablet.addCookies([{ name: 'cc_session', value: sessionValue, domain: '127.0.0.1', path: '/' }]);
  const tp = await tablet.newPage();
  t.after(() => tablet.close());
  await tp.goto(ctx.baseUrl + '/admin#/overview', { waitUntil: 'networkidle' });
  await waitActive(tp);
  const tm = await tp.evaluate(MEASURE);
  assert.ok(tm.header.h <= 64, `768px：header 必须单行（实测 ${Math.round(tm.header.h)}px）`);
  assert.ok(tm.who, '768px：#who 应可见（该档只缩不可埋）');
  assert.ok(tm.who.h <= 24, `768px：#who 不得折行（实测高 ${Math.round(tm.who.h)}px）`);
  assert.ok(tm.who.x >= tm.end.x - 1 && tm.who.right <= tm.end.right + 1,
    `768px：#who 越出 navbar-end（who ${Math.round(tm.who.x)}~${Math.round(tm.who.right)} vs end ${Math.round(tm.end.x)}~${Math.round(tm.end.right)}）`);
  assert.ok(tm.start.right <= tm.end.x + 1, `768px：左右两区重叠（start.right=${Math.round(tm.start.right)} > end.x=${Math.round(tm.end.x)}）`);
  assert.deepEqual(tm.overlaps, [], `768px：顶栏控件互相压住 → ${tm.overlaps.join(', ')}`);
  assert.ok(tm.docSW <= tm.iw, `768px：页面横向溢出 ${tm.docSW} > ${tm.iw}`);
  assert.ok(tm.controlsMin >= 40, `768px：触控目标偏小（${tm.controlsMin}px）`);

  // ── ③ 未登录态 /admin：登录门顶栏同样单行、不溢出 ──────────────────
  const anon = await browser.newContext(MOBILE_390);
  const ap = await anon.newPage();
  t.after(() => anon.close());
  await ap.goto(ctx.baseUrl + '/admin', { waitUntil: 'networkidle' });
  await ap.waitForTimeout(400);
  const am = await ap.evaluate(() => {
    const box = (el) => { const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height, right: b.right, bottom: b.bottom }; };
    const gate = document.getElementById('gate-head');
    const shell = document.getElementById('admin-shell');
    const theme = document.getElementById('theme-gate');
    return {
      gate: gate ? box(gate) : null,
      gateVisible: !!gate && getComputedStyle(gate).display !== 'none',
      controlsMin: theme ? Math.min(box(theme).w, box(theme).h) : 0,
      shellHidden: !shell || getComputedStyle(shell).display === 'none',
      docSW: document.documentElement.scrollWidth, iw: window.innerWidth,
    };
  });
  assert.ok(am.gateVisible, '未登录态登录门顶栏必须可见');
  assert.ok(am.gate.h <= 64, `未登录态顶栏必须单行（实测 ${Math.round(am.gate.h)}px）`);
  assert.ok(am.controlsMin >= 40, `未登录态触控目标偏小（${am.controlsMin}px）`);
  assert.ok(am.shellHidden, '未登录态后台外壳必须整块隐藏');
  assert.ok(am.docSW <= am.iw, `未登录态横向溢出 ${am.docSW} > ${am.iw}`);

  // ── ④ 桌面 1440×900 零回归 ────────────────────────────────────────
  const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await desktop.addCookies([{ name: 'cc_session', value: sessionValue, domain: '127.0.0.1', path: '/' }]);
  const dp = await desktop.newPage();
  t.after(() => desktop.close());
  await dp.goto(ctx.baseUrl + '/admin#/overview', { waitUntil: 'networkidle' });
  await waitActive(dp);
  const dm = await dp.evaluate(() => {
    const box = (el) => { const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; };
    return {
      header: box(document.getElementById('admin-head')),
      sidebar: box(document.querySelector('.admin-sidebar')),
      who: box(document.getElementById('who')),
      docSW: document.documentElement.scrollWidth, iw: window.innerWidth,
    };
  });
  assert.ok(Math.abs(dm.header.h - 56) <= 1, `桌面 header 必须仍 56px（实测 ${dm.header.h}px）`);
  assert.ok(Math.abs(dm.sidebar.w - 224) <= 1, `桌面侧边栏必须仍 224px 常驻（实测 ${dm.sidebar.w}px）`);
  assert.ok(dm.who.w >= 60, `桌面 #who 仍完整显示（实测宽 ${dm.who.w}px）`);
  assert.ok(dm.docSW <= dm.iw, `桌面横向溢出 ${dm.docSW} > ${dm.iw}`);
});
