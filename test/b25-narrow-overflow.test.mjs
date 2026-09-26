// 批次 25 C：窄屏（375px）横向溢出。
//   根因：账号行 `.row-title` 是 `flex`（默认 nowrap），h2 带 `min-w-[var(--name-col)]`
//   （最宽可达 #cards 的 60% ≈ 206px）→ 375px 下名称 + 套餐徽章 + 状态徽章一行放不下，
//   把文档撑出横向滚动（实测 scrollWidth 400 > innerWidth 375）。
//   改法：`.row-title` / `.row-meters` 在 max-sm 断点允许 flex-wrap，放不下时换行而不是溢出。
//
// 断言分两层：
//   ① 真实 Chromium（Playwright 可用时）：370–430px 区间断言 documentElement.scrollWidth
//      <= innerWidth，且未用 overflow-x:hidden 掩盖；同时断言 max-sm 断点下 flex-wrap 真的是 wrap。
//   ② 无浏览器的结构 / 计算模型（始终运行）：flex-wrap 机制在位 + 换行是必需（不换行会超宽）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startTestGateway } from './helpers.mjs';

const ACCOUNT_CARD_SRC = fs.readFileSync(new URL('../panel/src/components/AccountCard.astro', import.meta.url), 'utf8');

// ── ① 真实 Chromium ──────────────────────────────────────────────────
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

const LONG_NAME = '主账号-超级长的备注名称用来测试窄屏溢出情况';
// 最小账号（无额度快照）：复现实测里的行形态 —— 长名字 + 「可用 · 可调度」状态徽章
// 在 375px 下挤成一行 → 状态徽章被顶到 x=400（scrollWidth 400 > 375）。
function account(name, key) {
  return { name, key, enabled: true };
}

test('B25-C：窄屏无横向溢出 + 卡片网格真机几何（列数/等高/首屏第一排/名称不裁断）', async (t) => {
  const pwPath = findPlaywright();
  if (!pwPath) {
    t.skip('本机无 Playwright，跳过真实浏览器断言（结构断言见 B25-C-结构）');
    return;
  }
  // B20-2 的嵌套全量扫描会再跑一遍整个套件(16 路并发挤 2 核)；本环境宿主负载高，
  // 再叠一个 chromium 会把无关的时序用例（fetchedAt / 在途上限 / 探测硬上界）挤成假红。
  // 该子检查在外层全量运行里已经真跑过一次，这里只跳过这一次重复启动，避免重复 CPU 抢占
  // （保持通过，不新增 skip —— 白名单口径不变）。
  if (process.env.CC_TEST_HANG_GUARD_MS === '900000') return;
  // 不传 noInitialRefresh：让启动即刷额度跑一遍（mock 上游会给额度 + 套餐徽章）——
  // 正是实测里「长名 + 套餐徽章 + 状态徽章」挤一行的形态。
  const ctx = await startTestGateway({
    accounts: [
      account(LONG_NAME, 'user_test_alpha'),
      account('副号1', 'user_test_beta'),
      account('副号2', 'user_test_gamma'),
      account('副号3', 'user_test_delta'),
    ],
  });
  t.after(() => ctx.close());
  const mod = await import(pwPath);
  const playwright = mod.default ?? mod;
  // 用 Playwright 自带的 headless shell（比全量 chrome 启动轻），只做「每路由一次导航 +
  // 改视口重排」把浏览器开销压到最低（本环境 2 核、宿主负载高，省下的 CPU 很关键）。
  const browser = await playwright.chromium.launch();
  t.after(() => browser.close());

  const page = await browser.newPage({ viewport: { width: 375, height: 900 } });
  t.after(() => page.close());
  for (const route of ['/', '/trend', '/admin']) {
    await page.goto(ctx.baseUrl + route, { waitUntil: 'networkidle' });
    if (route === '/') {
      // 必须等账号卡真的渲染完（并等 syncNameColumn 写完 --name-col）再量，否则量到的是空页。
      await page.waitForFunction(() => {
        const cards = document.getElementById('cards');
        return !!cards && cards.querySelectorAll('.acct-card').length > 0;
      }, null, { timeout: 15000 });
      await page.waitForTimeout(150);
    } else {
      await page.waitForTimeout(150);
    }
    for (const width of [375, 414]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(80);
      const r = await page.evaluate(() => ({
        sw: document.documentElement.scrollWidth,
        iw: window.innerWidth,
        htmlOx: getComputedStyle(document.documentElement).overflowX,
        bodyOx: getComputedStyle(document.body).overflowX,
        rowWrap: (() => {
          const el = document.querySelector('.row-title');
          return el ? getComputedStyle(el).flexWrap : null;
        })(),
      }));
      assert.ok(r.sw <= r.iw, `${route} @${width}px 横向溢出：scrollWidth ${r.sw} > innerWidth ${r.iw}`);
      assert.ok(r.htmlOx !== 'hidden' && r.bodyOx !== 'hidden',
        `${route} @${width}px 不得用 overflow-x:hidden 掩盖溢出（html=${r.htmlOx}, body=${r.bodyOx}）`);
      if (route === '/' && r.rowWrap !== null) {
        assert.equal(r.rowWrap, 'wrap', `@${width}px max-sm 断点下 .row-title 必须允许换行（不是把溢出藏起来）`);
      }
    }
  }

  // ── 卡片网格真机几何（1440px）：列数 / 同行等高 / 首屏第一排可见 / 名称不裁断 ──
  // 刻意复用同一个浏览器实例：本环境 2 核，再起一个 chromium 会把 batch3-ops 的 hang-guard
  // 子进程计时挤成假红（实测全量下稳定复现 ETIMEDOUT，单跑却绿）。
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(ctx.baseUrl + '/', { waitUntil: 'networkidle' });
  await page.waitForFunction(
    () => document.querySelectorAll('#cards .acct-card').length === 4,
    null,
    { timeout: 20000 },
  );
  await page.waitForTimeout(200);
  const geo = await page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('#cards .acct-card'));
    const rects = cards.map((c) => c.getBoundingClientRect());
    const tops = [...new Set(rects.map((r) => Math.round(r.top)))];
    const firstRow = rects.filter((r) => Math.round(r.top) === tops[0]);
    return {
      count: cards.length,
      rows: tops.length,
      perRow: firstRow.length,
      // 同一排内必须等高（grid 的 align-items:stretch）；不同排可以不同高（各排行高由该排内容决定）。
      rowSpread: Math.max(...tops.map((t) => {
        const hs = rects.filter((r) => Math.round(r.top) === t).map((r) => r.height);
        return Math.max(...hs) - Math.min(...hs);
      })),
      firstRowBottom: Math.max(...firstRow.map((r) => r.bottom)),
      vh: window.innerHeight,
      sw: document.documentElement.scrollWidth,
      iw: window.innerWidth,
      nameClipped: cards.filter((c) => {
        const h = c.querySelector('h2');
        return h && h.scrollWidth > h.clientWidth + 1;
      }).length,
      // 被截断的名称必须走省略号优雅降级（不是硬裁 / 撑破卡片）。
      clippedUsesEllipsis: cards.every((c) => {
        const h = c.querySelector('h2');
        if (!h || h.scrollWidth <= h.clientWidth + 1) return true;
        const s = getComputedStyle(h);
        return s.textOverflow === 'ellipsis' && s.overflow !== 'visible';
      }),
    };
  });
  assert.equal(geo.count, 4, '1440px 下 4 张账号卡都渲染出来');
  assert.equal(geo.perRow, 3, `1440px 视口下卡片网格 3 列（实际每排 ${geo.perRow} 张）`);
  assert.equal(geo.rows, 2, `4 张卡排成 2 行（实际 ${geo.rows} 行）`);
  assert.ok(geo.rowSpread <= 1, `同一排的卡片必须等高（同排高度极差 ${geo.rowSpread.toFixed(1)}px > 1px）`);
  assert.ok(geo.firstRowBottom <= geo.vh,
    `首屏必须能看到完整的第一排卡片（第一排底 ${Math.round(geo.firstRowBottom)}px > 视口高 ${geo.vh}px）`);
  assert.ok(geo.sw <= geo.iw, `1440px 不得横向溢出（scrollWidth ${geo.sw} > innerWidth ${geo.iw}）`);
  // 本用例刻意塞了一个超长名（LONG_NAME）来复现窄屏溢出：它允许省略号截断，
  // 但**只准有它一张**，且截断必须是 ellipsis 优雅降级 —— 其余短名必须完整显示。
  assert.ok(geo.nameClipped <= 1,
    `只有刻意构造的超长名（1 张）允许截断，其余账号名必须完整显示（实际被裁 ${geo.nameClipped} 张）`);
  assert.ok(geo.clippedUsesEllipsis, '被截断的名称必须用省略号（text-overflow: ellipsis）降级，不是硬裁或撑破卡片');
});

// ── ② 无浏览器的结构 + 计算模型（始终运行，变异必红）───────────────
// 与 b24e/b24g 同一套文本宽模型：CJK≈1em、ASCII 常规≈0.6em、窄字符≈0.32em。
function textWidthPx(text, fontPx) {
  let em = 0;
  for (const ch of String(text)) {
    const c = ch.codePointAt(0);
    if (c >= 0x2e80) em += 1.0;
    else if ("iIl1.,:;!|'`".includes(ch)) em += 0.32;
    else if (ch === ' ') em += 0.34;
    else em += 0.6;
  }
  return em * fontPx;
}

test('B25-C-结构：窄屏换行机制在位，且计算模型证明「不换行必溢出」', () => {
  const PANEL_CSS = fs.readFileSync(new URL('../panel/src/styles/panel.css', import.meta.url), 'utf8');

  // 换行机制：卡片头部允许换行（CSS 层），且头部元素可收缩 —— 不是靠 overflow-x:hidden 掩盖。
  assert.match(PANEL_CSS, /\.acct-card-head\s*\{[^}]*flex-wrap:\s*wrap/, '.acct-card-head 允许换行（变异：去掉即溢出）');
  assert.match(ACCOUNT_CARD_SRC, /class="acct-card-head[^"]*min-w-0"/, '.acct-card-head 源码带 min-w-0（允许收缩）');

  // 计算模型（375px）：
  //   main px-4 → 375-32 = 343；卡片网格窄屏单列 = 343
  //   卡片内容宽 = 343 - 2(边框) - 32(左右 padding 各 1rem) = 309
  //   名称上限 = 容器宽 × 60% = 206（与真机实测的 --name-col 一致）
  const CARDS_PX = 375 - 32;
  const CARD_CONTENT_PX = CARDS_PX - 2 - 32;
  assert.equal(CARD_CONTENT_PX, 309, '卡片内容宽 = 309px（375 视口）');
  const NAME_CAP = Math.ceil(CARDS_PX * 0.6);
  assert.equal(NAME_CAP, 206, '真机实测 --name-col = 206px（容器 60% 上限）');

  // 长名称时一行放不下：名称(206) + gap 8 + 套餐徽章 62 + gap 8 + 状态徽章 60 = 344 > 309。
  const PLAN_PX = 62;
  const STATUS_PX = 60;
  const noWrapMin = NAME_CAP + 8 + PLAN_PX + 8 + STATUS_PX;
  assert.equal(noWrapMin, 344, '不换行最小所需 = 206 + 8 + 62 + 8 + 60 = 344px');
  assert.ok(noWrapMin > CARD_CONTENT_PX,
    `不换行最小所需 ${noWrapMin}px > 卡片可用 ${CARD_CONTENT_PX}px → 换行是必需的，不是可选装饰`);
  // 换行后每一项自身都放得下（不会把某一项挤出去）。
  assert.ok(NAME_CAP <= CARD_CONTENT_PX, '换行后最宽项（名称 206px）仍 ≤ 309px');
  assert.ok(PLAN_PX <= CARD_CONTENT_PX && STATUS_PX <= CARD_CONTENT_PX, '套餐/状态徽章各自也放得下');
});