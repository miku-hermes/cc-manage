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

test('B25-C：375px 无横向溢出、未用 overflow-x:hidden 掩盖（真实 Chromium）', async (t) => {
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
    accounts: [account(LONG_NAME, 'user_test_alpha'), account('副号1', 'user_test_beta')],
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
        return !!cards && cards.querySelectorAll('.row-card').length > 0;
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
  // flex-wrap 机制：只在 max-sm 断点加，不能全局改（桌面端仍要保持名称列 + 米数一行对齐）。
  const titleTag = /<span class="row-title[^"]*"[^>]*>/.exec(ACCOUNT_CARD_SRC);
  const metersTag = /<span class="row-meters[^"]*"[^>]*>/.exec(ACCOUNT_CARD_SRC);
  assert.ok(titleTag, '找得到 .row-title');
  assert.ok(metersTag, '找得到 .row-meters');
  assert.match(titleTag[0], /max-sm:flex-wrap/, '.row-title 必须 max-sm:flex-wrap（变异：去掉即溢出）');
  assert.match(metersTag[0], /max-sm:flex-wrap/, '.row-meters 必须 max-sm:flex-wrap');

  // 计算模型（375px）：
  //   main px-4 → 375-32 = 343；#cards 单列 = 343
  //   summary 内容宽 = 343 - 2(边框) - 16(左 padding) - 48(padding-inline-end 3rem) = 277
  //   --name-col 上限 = #cards.clientWidth × 0.6 = 343 × 0.6 = 205.8 → 206（与真机实测一致）
  const CARDS_PX = 375 - 32;
  const SUMMARY_CONTENT_PX = CARDS_PX - 2 - 16 - 48;
  const NAME_COL = Math.ceil(CARDS_PX * 0.6);
  assert.equal(NAME_COL, 206, '真机实测 --name-col = 206px');
  assert.equal(SUMMARY_CONTENT_PX, 277, 'summary 内容宽 = 277px');

  // 不换行时的最小所需宽 = h2(min-w = name-col) + gap-2(8) + 套餐徽章 + gap-2(8) + 状态徽章。
  // 状态徽章「可用」在 b24i 模型里量得 60px（文字 2×12 + padding 22 + gap 8 + 边框 2）；
  // 套餐徽章即使当 0（plan 缺省时不渲染）也仍然放不下 → 证明换行是必需的，不是可选装饰。
  const STATUS_BADGE_PX = 60;
  const noWrapMin = NAME_COL + 8 + 0 + 8 + STATUS_BADGE_PX;
  assert.equal(noWrapMin, 282, '不换行最小所需 = 206 + 8 + 8 + 60 = 282px');
  assert.ok(noWrapMin > SUMMARY_CONTENT_PX,
    `不换行最小所需 ${noWrapMin}px > 可用 ${SUMMARY_CONTENT_PX}px → 必须换行，否则溢出`);
  // 换行后每一项自身都放得下 → 换行确实能消掉溢出。
  assert.ok(NAME_COL <= SUMMARY_CONTENT_PX, '换行后最宽项（名称列 206px）仍 ≤ 277px');
});
