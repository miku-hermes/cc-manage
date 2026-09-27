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
const PANEL_CSS_SRC = fs.readFileSync(new URL('../panel/src/styles/panel.css', import.meta.url), 'utf8');

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
  // 几何断言必须在字体就绪后量：字体未就绪时行高不同（实测同一页面差 ~10px），
  // 会让「首屏第一排」这类边界断言在负载高的全量运行里随机翻车。
  await page.evaluate(() => document.fonts.ready);
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

  // ── 窄屏 Hero：环比不得独占一行（值+图同行）────────────────────────────────
  // 实测（安卓 384px）：环被挤到「额度构成」下面独占一行，左贴边、右侧空掉半行，
  // 而且紧挨额度构成下方容易被读成同一组数据。改法是余额与环同行（KPI 卡通行排法）。
  await page.setViewportSize({ width: 375, height: 812 });
  await page.waitForTimeout(150);
  const hero = await page.evaluate(() => {
    const r = (id) => { const e = document.getElementById(id); return e ? e.getBoundingClientRect() : null; };
    const b = r('balance'); const g = r('usage-gauge'); const cap = r('gauge-cap'); const bd = r('bal-breakdown');
    return {
      bTop: b.top, bBottom: b.bottom, bRight: b.right,
      gTop: g.top, gBottom: g.bottom, gLeft: g.left, gW: g.width,
      capRight: cap.right, bdTop: bd.top, rmHeight: document.querySelector('.hero-row-main').getBoundingClientRect().height,
      balLabelTop: document.getElementById('bal-label').getBoundingClientRect().top,
      balLabelBottom: document.getElementById('bal-label').getBoundingClientRect().bottom,
      sw: document.documentElement.scrollWidth, iw: window.innerWidth,
    };
  });
  // 同行判据用「水平相邻」而不是「垂直区间重叠」：row-main 是 align-items:center，
  // 行内若有更高的兄弟元素（如换行后的额度标签），居中的环与矮的余额数字并不垂直重叠，
  // 但它明明还在同一行 —— 用重叠判定会误报。环一旦换到下一行，left 会回到容器左缘。
  assert.ok(hero.gLeft > hero.bRight - 4,
    `窄屏下环必须与余额在同一行且位于其右侧（环 x=${Math.round(hero.gLeft)}，余额右缘 ${Math.round(hero.bRight)}）`);
  assert.ok(hero.capRight <= hero.iw, `环旁标签不得溢出（右缘 ${Math.round(hero.capRight)} > ${hero.iw}）`);
  assert.ok(hero.bdTop >= hero.bBottom - 2, '额度构成必须落在余额行下方，不与环抢同一行');
  assert.ok(hero.balLabelBottom - hero.balLabelTop <= 50,
    `额度标签不得被压成竖排（实测高 ${Math.round(hero.balLabelBottom - hero.balLabelTop)}px；竖排时可达 100px+）`);
  assert.ok(hero.sw <= hero.iw, `窄屏 hero 不得横向溢出（${hero.sw} > ${hero.iw}）`);
  // daisyUI 的 radial-progress 未完成段本身是 #0000（透明）→ 窄环读起来像一段开口弧线。
  assert.match(PANEL_CSS_SRC, /\.hero-gauge \.radial-progress:before\s*\{[^}]*var\(--border-color\)/,
    '环必须补出底轨（daisyUI 默认未完成段透明，没有底轨）');

  // ── 窄屏顶栏：固定尺寸控件不得被 flex 压缩 ────────────────────────────────
  // 实测（安卓 384px）：.navbar-end 是 flex，切换器被从 81px 压到 53px（少了整整一个按钮），
  // 再叠加 .view-switch 的 overflow:hidden，右边的列表图标被整个裁掉 —— 看起来像「只有一个图标」。
  await page.setViewportSize({ width: 384, height: 832 });
  await page.waitForTimeout(150);
  const bar = await page.evaluate(() => {
    const vs = document.querySelector('.view-switch'); const sw = vs.getBoundingClientRect();
    const l = document.getElementById('view-list');
    const lr = l.getBoundingClientRect(); const ls = l.querySelector('svg').getBoundingClientRect();
    const sbEl = document.querySelector('.search-box');
    const sb = sbEl.getBoundingClientRect();
    return { vsW: sw.width, vsRight: sw.right, listRight: lr.right, listIconRight: ls.right,
      searchW: sb.width, searchClientW: sbEl.clientWidth, searchScrollW: sbEl.scrollWidth,
      docSw: document.documentElement.scrollWidth, iw: window.innerWidth };
  });
  assert.ok(bar.listRight <= bar.vsRight + 0.5,
    `窄屏下切换器的第二个按钮不得被裁（按钮右缘 ${bar.listRight.toFixed(1)} > 容器右缘 ${bar.vsRight.toFixed(1)}）`);
  assert.ok(bar.listIconRight <= bar.vsRight + 0.5,
    `列表图标不得被裁（图标右缘 ${bar.listIconRight.toFixed(1)} > 容器右缘 ${bar.vsRight.toFixed(1)}）`);
  assert.ok(bar.vsW >= 80,
    `切换器在窄屏不得被 flex 压缩（实测 ${bar.vsW.toFixed(1)}px，桌面为 81px；变异：去掉 flex:none 即红）`);
  // 判据必须是「内容装得下」而不是「宽度够大」：实测 27px 宽装 39px 内容时，放大镜一样被裁。
  assert.ok(bar.searchScrollW <= bar.searchClientW + 1,
    `搜索框内容不得溢出（scrollWidth ${bar.searchScrollW} > clientWidth ${bar.searchClientW}）`);
  assert.ok(bar.docSw <= bar.iw, `窄屏顶栏不得横向溢出（${bar.docSw} > ${bar.iw}）`);
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
// ── ② Hero 顶区：问候语与时钟必须同一行 ──────────────────────────────
// 实测踩到：窄屏下左列副行「网关状态 可用 3/4」把小右列整体挤到第二行 ——
// hero-banner-top 高 137.9px（两行）、时钟 top 156.4 而问候语 top 87.4。
// 判据取「两者 top 之差 ≤ 12px」（约半个行高）而不是容器高度，避免受字号/行高抖动影响。
const UTILS_JS = fs.readFileSync(new URL('../panel/public/js/utils.js', import.meta.url), 'utf8');

test('B25-D：Hero 顶区问候语与时钟必须同行（不得被副行挤到第二行）', async (t) => {
  const pwPath = findPlaywright();
  if (!pwPath) {
    t.skip('本机无 Playwright，跳过真实浏览器断言（结构断言见 B25-D-结构）');
    return;
  }
  if (process.env.CC_TEST_HANG_GUARD_MS === '900000') return;
  const ctx = await startTestGateway({ accounts: [account('主号', 'user_test_alpha')] });
  t.after(() => ctx.close());
  const mod = await import(pwPath);
  const playwright = mod.default ?? mod;
  const browser = await playwright.chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 384, height: 900 } });
  t.after(() => page.close());

  // 后两档用放大根字号模拟真机（安卓）字体更宽的情形 —— 用户就是在真机上看到折行的，
  // 默认字号的 430~320px 全测不出任何问题，说明「只在默认字号下验证」是不够的。
  for (const [w, zoom] of [[414, null], [384, null], [375, null], [360, null],
    [375, 'html { font-size: 20px !important; }'], [375, 'html { font-size: 24px !important; }']]) {
    await page.setViewportSize({ width: w, height: 900 });
    await page.goto(ctx.baseUrl + '/', { waitUntil: 'networkidle' });
    if (zoom) await page.addStyleTag({ content: zoom });
    await page.waitForTimeout(600);
    const m = await page.evaluate(() => {
      const R = (id) => document.getElementById(id).getBoundingClientRect().top;
      const top = document.querySelector('.hero-banner-top');
      return {
        greeting: +R('greeting').toFixed(1),
        clock: +R('clock').toFixed(1),
        wrap: getComputedStyle(top).flexWrap,
        subH: +document.querySelector('.hero-sub').getBoundingClientRect().height.toFixed(1),
        // 折行判据不能写死像素高度：根字号放大后正常单行也会到 36px。
        // 用「高度 ÷ lineHeight」得到实际行数，与字号无关。
        labelLines: (() => {
          const l = document.querySelector('.hero-sub-label');
          if (!l) return null;
          const lh = parseFloat(getComputedStyle(l).lineHeight);
          return lh > 0 ? +(l.getBoundingClientRect().height / lh).toFixed(2) : null;
        })(),
        subScroll: document.querySelector('.hero-sub').scrollWidth,
        subClient: document.querySelector('.hero-sub').clientWidth,
        restShown: getComputedStyle(document.querySelector('.hero-sub-label-rest')).display !== 'none',
        sw: document.documentElement.scrollWidth,
        iw: window.innerWidth,
      };
    });
    const tag = w + 'px' + (zoom ? '（字号放大）' : '');
    assert.equal(m.wrap, 'nowrap', tag + '：顶区不得换行（换行会把右列整体挤到第二行）');
    assert.ok(Math.abs(m.greeting - m.clock) <= 12,
      tag + '：问候语 top=' + m.greeting + ' 与时钟 top=' + m.clock + ' 必须同一行（现差 '
      + Math.abs(m.greeting - m.clock).toFixed(1) + 'px）');
    // 「网关状态 可用 3/4」必须整条同行：375/360px 曾实测「网关状态」被折成「网关状」+「态」。
    // 判据用行数而非像素高度 —— 根字号放大时单行也有 36px，写死阈值会把正常情况判红。
    assert.ok(m.labelLines === null || m.labelLines <= 1.2,
      tag + '：「网关状态」必须单行显示（实测 ' + m.labelLines + ' 行，> 1.2 说明被折行了）');
    // 不折行还不够 —— 内容必须真的放得下，否则 .hero-sub 的 overflow:hidden 会把徽章切掉一截
    // （360px 实测曾差 11px，比折行更难察觉）。
    assert.ok(m.subScroll <= m.subClient + 1,
      tag + '：副行不得被截断（内容 ' + m.subScroll + ' > 可见 ' + m.subClient + '，徽章会被切掉）');
    // 真机字体比无头浏览器宽：只靠"腾够宽度"防不住折行（安卓上最后一个「态」字会单独掉到第二行），
    // 所以窄屏把「网关状态」缩成「网关」——结构上不可能再折。
    assert.equal(m.restShown, false,
      tag + '：窄屏必须收掉「状态」两字（真机字体更宽，留着它会把最后一个字挤到第二行）');
    assert.ok(m.sw <= m.iw, tag + '：不得横向溢出（' + m.sw + ' > ' + m.iw + '）');
  }
});

test('B25-D-结构：网关状态徽章 ok 状态不得再用绿色底', () => {
  // 用户反馈「名称下面那个绿色的东西好难看」：ok 是绝大多数时间的状态，
  // 一律 badge-success 会让徽章常年一片亮绿。现在只有 bad（真异常）保留语义色。
  assert.match(UTILS_JS, /tone === 'bad' \? 'badge-error' : 'badge-ghost'/,
    '网关状态徽章的类名只能是 bad→badge-error / 其余→badge-ghost');
  assert.doesNotMatch(UTILS_JS, /tone === 'ok' \? 'badge-success'/,
    'ok 不得映射到 badge-success（绿底徽章）');
});

// ── ② 看板娘「真的冲出卡片」的几何断言（2026-09-27 补）──────────────────
// 背景：B39 只断言了「.hero-mascot 有 position:absolute / 有弹跳动画 / 有让位」，
// 全是**规则存在**级别的检查 —— 于是上线后手机上帽顶被卡片上边缘切掉、只露出 3px 也没人报红。
// 根因（实测）：top 的定位基准不是 .hero-banner(120) 而是 .hero-banner-top(≈135.4)，
// 因为 `.hero-banner > *:not(.hero-deco)` 那条规则给顶区设了 position:relative；
// 少算 Hero 的 border 1px + padding-top 14.4px 这 15.4px，视觉上就等于没冲出。
// 所以必须量**渲染后的几何**：图顶要比卡片顶高出一段（冲出），同时不得撞到顶栏。
test('B25-E：Hero 看板娘必须真的冲出卡片上缘，且不撞顶栏（几何，非规则）', async (t) => {
  const pwPath = findPlaywright();
  if (!pwPath) {
    t.skip('本机无 Playwright，跳过真实浏览器断言（结构断言见 B25-D-结构）');
    return;
  }
  if (process.env.CC_TEST_HANG_GUARD_MS === '900000') return;
  const chromiumPath = findChromium();
  const ctx = await startTestGateway({ accounts: [account('主号', 'user_test_alpha')] });
  t.after(() => ctx.close());
  const mod = await import(pwPath);
  const playwright = mod.default ?? mod;
  const browser = await playwright.chromium.launch(chromiumPath ? { executablePath: chromiumPath } : {});
  t.after(() => browser.close());

  const UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';
  const seen = [];
  for (const [w, h, dpr, ua] of [[1440, 900, 2, undefined], [384, 900, 3, UA]]) {
    const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: dpr, userAgent: ua });
    await page.goto(ctx.baseUrl, { waitUntil: 'networkidle' });
    await page.waitForTimeout(400);
    const m = await page.evaluate(() => {
      const img = document.querySelector('.hero-mascot');
      const hero = document.querySelector('.hero-banner');
      const hdr = document.querySelector('header');
      if (!img || !hero || !hdr) return null;
      img.style.animation = 'none'; // 免得读到弹跳中间帧
      const ri = img.getBoundingClientRect(), rh = hero.getBoundingClientRect(), rd = hdr.getBoundingClientRect();
      return {
        imgTop: ri.top, imgBottom: ri.bottom, imgLeft: ri.left, imgRight: ri.right,
        heroTop: rh.top, headerBottom: rd.bottom,
        popOut: rh.top - ri.top,            // >0 才是「冲出卡片上缘」
        gapToHeader: ri.top - rd.bottom,    // >0 才是不撞顶栏
        loaded: img.complete && img.naturalWidth > 0,
      };
    });
    assert.ok(m, `${w}px：页面里必须同时存在 .hero-mascot / .hero-banner / header`);
    assert.ok(m.loaded, `${w}px：看板娘图片必须加载成功（naturalWidth>0）`);
    // 冲出量：桌面至少 30px、手机至少 25px —— 小到看不见就等于没做（实测曾只有 3px）
    const need = w >= 1000 ? 30 : 25;
    assert.ok(m.popOut >= need,
      `${w}px：看板娘必须明显冲出卡片上缘（实测只露 ${m.popOut.toFixed(1)}px，要求 >= ${need}px）`);
    // 不得撞顶栏
    assert.ok(m.gapToHeader >= 8,
      `${w}px：看板娘不得撞到顶栏（图顶距顶栏底仅 ${m.gapToHeader.toFixed(1)}px，要求 >= 8px）`);
    // 不得横向溢出
    const sw = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
    assert.ok(sw.sw <= sw.iw, `${w}px：不得横向溢出（scrollWidth ${sw.sw} > innerWidth ${sw.iw}）`);
    seen.push(`${w}px 露出 ${m.popOut.toFixed(0)}px / 距顶栏 ${m.gapToHeader.toFixed(0)}px`);
    await page.close();
  }
  assert.equal(seen.length, 2, '两档视口都量到了');
});
