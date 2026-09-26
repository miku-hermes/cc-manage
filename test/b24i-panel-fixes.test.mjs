// 批次 24i：收尾三条小瑕疵 —— 全部按**渲染几何 / 渲染结果**判定，不按观感。
//   ① 状态列宽度不一 → 中间那列右边缘参差：`.acct-status` 内容自适应，「月额度已用完」(6 字 116px)
//      与「可用」(2 字 60px) 右边缘差 42px。修法：syncStatusColumn 量出**全表最宽状态徽章**的
//      border-box 宽写进 #cards 的 --status-col，模板用 min-w-[var(--status-col,0px)] 兜成地板
//      （medal 是地板不是上限：最长文案天然放得下、不裁不换行），daisyUI badge 自带
//      justify-content:center → 文案在列内居中，四行左右边缘都对齐。
//   ② 环内数字是否居中：**先用真机 Chromium 量，再决定改不改**。实测（1920×1080，
//      --size:3.25rem=52px）环容器中心 (219,180)、数字文本节点中心 (219,179.5) →
//      水平偏差 0.00px / 垂直偏差 0.50px，本来就在 1px 以内 ⇒ 观感为误报，**未改代码**。
//      这里守的是「居中机制」不被破坏（daisyUI radial-progress 的 place-content:center +
//      无内边距/位移/尺寸覆盖），而不是重算一遍浏览器。
//   ③ 同一件事两个口径：环内 Math.round → 「63%」，旁词 pctText → 「62.6%」。修法：新增
//      heroPctText 作为 Hero **唯一**百分比口径，环内读数与旁词共用同一个字符串。
//
// 垫片没有排版引擎（rect 恒 0），所以 ① 用与 b24e/b24g 同一套可计算模型：
//   - 文本像素宽按字符类别估算（CJK≈1em / ASCII≈0.6em / 窄字符≈0.32em）；
//   - 徽章 border-box 宽 = 文字宽 + 2×padding-inline(11) + gap(8) + 2×border(1)，
//     与真机实测逐项吻合（可用 60 / 月额度已用完 116 / 已停用 74）；测试把
//     `badge.scrollWidth` 设成这个 border-box 宽，等价真机 getBoundingClientRect().width。
//
// 变异验证（改回旧形态即变红）：
//   ① 去掉 min-w-[var(--status-col…)] → 四行右边缘极差 42px > 1px → 红（见 B24i-1 的
//      「鉴别力」断言，直接用同一模型算出旧形态的极差）；
//   ② 给环元素加 padding/margin/translate → B24i-2 的「无位移声明」断言红；
//   ③ 环内改回 pct + '%'（取整）或旁词改回 pctText 以外的写法 → 两处字符串不等 → 红
//      （B24i-3 的鉴别力断言证明 62.6 与取整后的 63 可区分）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createDomShim, runInlineScript, styleText } from './helpers.mjs';

const INDEX_HTML = fs.readFileSync(new URL('../panel/dist/index.html', import.meta.url), 'utf8');
const CSS = styleText(INDEX_HTML);
const STATUS_PILL_SRC = fs.readFileSync(new URL('../panel/src/components/StatusPill.astro', import.meta.url), 'utf8');
const HERO_SRC = fs.readFileSync(new URL('../panel/src/components/HeroCard.astro', import.meta.url), 'utf8');
const RENDER_CARDS_JS = fs.readFileSync(new URL('../panel/public/js/render-cards.js', import.meta.url), 'utf8');
const RENDER_HERO_JS = fs.readFileSync(new URL('../panel/public/js/render-hero.js', import.meta.url), 'utf8');

// 1920 视口两列布局：main px-4 → 1568，#cards 两列 gap-2 → 列宽 780，
// summary 内容宽 = 780 - 2(边框) - 16(左 padding) - 48(padding-inline-end 3rem) = 714。
const SUMMARY_CONTENT_PX = 714;

// ── 文本像素宽模型（与 b24e / b24g 同一套）────────────────────────────
function textWidthPx(text, fontPx) {
  let em = 0;
  for (const ch of String(text)) {
    const c = ch.codePointAt(0);
    if (c >= 0x2e80) em += 1.0;                       // CJK / 全角
    else if ("iIl1.,:;!|'`".includes(ch)) em += 0.32; // 窄字符
    else if (ch === ' ') em += 0.34;
    else em += 0.6;                                    // ASCII 常规
  }
  return em * fontPx;
}

/** Tailwind 会转义 [ ( ) , . / 等字符；类名每个字符前允许有可选反斜杠。 */
function classPattern(cls) {
  return String(cls).split('').map((ch) => {
    const esc = ch.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');
    return '\\\\?' + esc;
  }).join('');
}
/** 某个类在产物里命中的全部规则体（含源序下标）。 */
function classBodies(css, cls) {
  const re = new RegExp('\\.' + classPattern(cls) + '\\s*\\{([^{}]*)\\}', 'g');
  const out = []; let m;
  while ((m = re.exec(css))) out.push({ body: m[1], index: m.index });
  return out;
}
function lastBodyOf(css, cls) { const b = classBodies(css, cls); return b.length ? b[b.length - 1].body : null; }
function clsTokens(el) { return String(el.className).split(/\s+/).filter(Boolean); }

/**
 * 元素上一个属性的**按 CSS 源序**解析值（同优先级的层叠结果），而不是 class 属性里的先后。
 * daisyUI 组件类在前、Tailwind 工具类在后 —— 正是真机层叠的结果。
 */
function declForTokens(css, tokens, prop) {
  const re = new RegExp('(?:^|;)\\s*' + prop.replace(/-/g, '\\-') + '\\s*:\\s*([^;]+)', 'g');
  let best = null; let bestIdx = -1;
  for (const t of tokens) {
    for (const { body, index } of classBodies(css, t)) {
      re.lastIndex = 0; let m; let last = null;
      while ((m = re.exec(body))) last = m[1].trim();
      if (last !== null && index > bestIdx) { best = last; bestIdx = index; }
    }
  }
  return best;
}
function declOfEl(css, el, prop) { return declForTokens(css, clsTokens(el), prop); }

// ── daisyUI badge 的盒模型（从真 CSS 解析，不写死）─────────────────────
/** --border 令牌（daisyUI 主题，1px）。 */
function borderPx(css) {
  const m = /--border:\s*([\d.]+)px/.exec(css);
  assert.ok(m, 'daisyUI 主题必须给出 --border');
  return parseFloat(m[1]);
}
/** daisyUI 组件尺寸令牌：--size = calc(var(--size-selector, .25rem) * N)。 */
function sizeTokenPx(css, cls, fallbackN) {
  const decl = lastBodyOf(css, cls) || '';
  const m = /--size:\s*calc\(var\(--size-selector,\s*([\d.]+)rem\)\s*\*\s*([\d.]+)\s*\)/.exec(decl);
  assert.ok(m, `${cls} 必须有 --size:calc(var(--size-selector,…)*N)`);
  return parseFloat(m[1]) * 16 * parseFloat(m[2] || fallbackN);
}
const BADGE_SIZE_PX = sizeTokenPx(CSS, 'badge', 6);      // 1.5rem = 24px
const BADGE_FONT_PX = (() => {
  const m = /font-size:\s*([\d.]+)rem/.exec(lastBodyOf(CSS, 'badge') || '');
  assert.ok(m, '.badge 必须给出 font-size');
  return parseFloat(m[1]) * 16;                          // .875rem = 14px
})();
const BADGE_PAD_X = (() => {
  const decl = lastBodyOf(CSS, 'badge') || '';
  assert.match(decl, /padding-inline:\s*calc\(var\(--size\)\s*\/\s*2\s*-\s*var\(--border\)\)/,
    '徽章横向内边距必须还是 --size/2 - border');
  return BADGE_SIZE_PX / 2 - borderPx(CSS);             // 11px
})();
const BADGE_GAP = (() => {
  const m = /gap:\s*([\d.]+)rem/.exec(lastBodyOf(CSS, 'badge') || '');
  assert.ok(m, '.badge 必须给出 gap');
  return parseFloat(m[1]) * 16;                          // .5rem = 8px（色点与文字之间）
})();
/** 内容自适应时状态徽章的 border-box 宽（色点当前是 0 宽占位，只占 gap）。 */
function badgeNaturalWidthPx(text) {
  return Math.ceil(textWidthPx(text, BADGE_FONT_PX)) + BADGE_PAD_X * 2 + BADGE_GAP + borderPx(CSS) * 2;
}
/** 徽章最终盒宽：min-width:var(--status-col…) 是地板，自然宽是被地板兜住的落值。 */
function badgeFinalWidthPx(badge, tableCol, naturalPx) {
  const minDecl = declOfEl(CSS, badge, 'min-width') || '';
  const wired = /var\(--status-col/.test(minDecl);
  return wired && Number.isFinite(tableCol) ? Math.max(tableCol, naturalPx) : naturalPx;
}
/** .row-title 的水平间距（gap-2 → calc(var(--spacing)*2) = 8px）。 */
function rowTitleGapPx(summary) {
  const d = declOfEl(CSS, summary.querySelector('.row-title'), 'gap') || '';
  const m = /calc\(var\(--spacing\)\s*\*\s*([\d.]+)\)/.exec(d);
  const sp = Number((/--spacing:\s*([\d.]+)rem/.exec(CSS) || [])[1] || 0.25);
  return m ? sp * 16 * Number(m[1]) : 8;
}
function spread(xs) { return Math.max(...xs) - Math.min(...xs); }

// ── 数据 ──────────────────────────────────────────────────────────────
function quota(overrides = {}) {
  return {
    ok: true, displayName: '显示名', plan: null, remaining: 9.9,
    credits: { monthlyCredits: 2, purchasedCredits: 1, freeCredits: 0.5 },
    fiveHour: { used: 0, cap: 3, percent: 0, resetAt: 0 },
    weekly: { used: 0, cap: 6, percent: 0, resetAt: 0 },
    monthly: { used: 0, cap: 10, percent: 0, resetAt: 0 },
    usage: { totalTokens: 12, totalCost: 1 }, fetchedAt: Date.now(),
    ...overrides,
  };
}
function account(overrides = {}) {
  return {
    keyId: '12345678', name: '测试号', enabled: true, available: true,
    creditsExhausted: false, exhausted: null, paused: false, pausedUntil: null,
    rateLimited: false, rateLimitedUntil: null, authInvalid: false, lastError: null,
    lastQuota: quota(), ...overrides,
  };
}
function status(accounts) {
  return {
    now: Date.now(), quotaPoll: {},
    summary: { accounts: accounts.length, enabled: accounts.length, available: accounts.length, unavailable: 0, paused: 0, concurrency: 0 },
    stats: { total: 0, errors: 0, clientErrors: 0, totalTokens: 0 },
    accounts,
  };
}
function dom(html) {
  return createDomShim({ html, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }) });
}
async function boot() {
  const shim = dom(INDEX_HTML);
  const page = await runInlineScript(INDEX_HTML, shim);
  return { shim, page };
}

// 四行、四种状态文案（6 字 / 2 字 / 3 字 / 3 字），每行同一个套餐 —— 两列布局下
// 第一列 = 第 1、3 行，第二列 = 第 2、4 行（跨列比较无意义，只在同一列内比）。
const plan = { planId: 'individual-go' };
const ROWS = [
  account({ keyId: 'aaaa1111', name: '主号-生产环境密钥一', available: false, creditsExhausted: true, exhausted: { kind: 'monthly', label: '月额度已用完', resetAt: Date.now() + 3 * 86400e3 }, lastQuota: quota({ plan }) }),
  account({ keyId: 'bbbb2222', name: '副号1-测试环境', lastQuota: quota({ plan }) }),
  account({ keyId: 'cccc3333', name: '副号2', enabled: false, available: false, lastQuota: quota({ plan }) }),
  account({ keyId: 'dddd4444', name: '副号3', available: false, paused: true, pausedUntil: Date.now() + 3 * 86400e3, lastQuota: quota({ plan }) }),
];

// ── ① 状态列统一宽度：同一列内左右边缘极差 ≤1px，且文案不裁 ──────────────
test('B24i-1：四行状态徽章同一列内左右边缘极差 ≤1px（按真 CSS 的 min-width 地板算）', async () => {
  const { shim, page } = await boot();
  page.render(status(ROWS));

  const cards = shim.document.querySelectorAll('#cards .row-card');
  assert.equal(cards.length, 4, '渲染出 4 行');
  const container = shim.el('cards');
  container.clientWidth = SUMMARY_CONTENT_PX;

  // 垫片没有排版引擎：把 h2 的 scrollWidth 设成名称文字所需宽（真机 syncNameColumn 读的量）。
  const nameRequired = cards.map((c) => textWidthPx(c.querySelector('h2').textContent, 16));
  cards.forEach((c, i) => { c.querySelector('h2').scrollWidth = nameRequired[i]; });
  assert.equal(typeof page.syncNameColumn, 'function', 'render-cards.js 必须导出 syncNameColumn');
  page.syncNameColumn();
  const nameCol = parseFloat(container.style.getPropertyValue('--name-col'));
  assert.ok(Number.isFinite(nameCol) && nameCol > 0, `--name-col 必须是实测像素值（实际 ${container.style.getPropertyValue('--name-col')}）`);

  // 状态徽章的自然（内容自适应）border-box 宽 —— 等价真机 getBoundingClientRect().width。
  const badges = cards.map((c) => c.querySelector('.acct-status'));
  badges.forEach((b) => { assert.ok(b, '每行都要有状态徽章'); });
  const natural = badges.map((b) => badgeNaturalWidthPx(b.textContent));
  // 鉴别力前提：最长/最短状态文案的自然宽必须差 >1px，否则「对齐」断言区分不出来。
  assert.ok(spread(natural) > 1,
    `状态文案自然宽必须有落差才有鉴别力（实际 ${natural.join(', ')}）`);
  badges.forEach((b, i) => { b.scrollWidth = natural[i]; });

  assert.equal(typeof page.syncStatusColumn, 'function', 'render-cards.js 必须导出 syncStatusColumn（真机测量入口）');
  page.syncStatusColumn();
  const tableCol = parseFloat(container.style.getPropertyValue('--status-col'));
  assert.ok(Number.isFinite(tableCol) && tableCol > 0,
    `--status-col 必须是实测像素值（实际 ${container.style.getPropertyValue('--status-col')}）`);
  // 宽度是「本表最长状态文案所需宽」：容得下最长文案（不裁字、不换行）。
  assert.ok(tableCol >= Math.max(...natural) - 1,
    `状态列必须容得下最长状态文案：列 ${tableCol}px < 需要 ${Math.max(...natural)}px`);

  // 每行最终盒宽 + 左边缘（名称列 → 套餐徽章 → 状态徽章，依次排列）。
  const gap = rowTitleGapPx(cards[0].querySelector('summary'));
  const pillW = textWidthPx(cards[0].querySelector('.plan-pill').textContent, BADGE_FONT_PX);
  const left = cards.map((c, i) => nameCol + gap + pillW + gap);
  const finalW = badges.map((b, i) => badgeFinalWidthPx(b, tableCol, natural[i]));
  const right = finalW.map((w, i) => left[i] + w);

  // 同一列内比较（两列布局：列 1 = 第 1/3 行，列 2 = 第 2/4 行）。
  for (const [name, col] of [['列 1', [0, 2]], ['列 2', [1, 3]]]) {
    const L = col.map((i) => left[i]); const R = col.map((i) => right[i]);
    assert.ok(spread(L) <= 1, `${name} 状态徽章左边缘极差 ${spread(L).toFixed(1)}px > 1px：${L.map((v) => v.toFixed(1)).join(', ')}`);
    assert.ok(spread(R) <= 1, `${name} 状态徽章右边缘极差 ${spread(R).toFixed(1)}px > 1px：${R.map((v) => v.toFixed(1)).join(', ')}`);
  }

  // 鉴别力 / 变异验证：同一模型下，去掉统一列宽（= 内容自适应）→ 右边缘必然参差。
  const revertedRight = natural.map((w, i) => left[i] + w);
  assert.ok(spread(revertedRight) > 1,
    `鉴别力：改回内容自适应后右边缘必须参差（实际极差 ${spread(revertedRight).toFixed(1)}px）`);
});

test('B24i-1b：等宽机制是「min-width 地板 + 居中」，不是钉死像素或裁字', async () => {
  const { shim, page } = await boot();
  page.render(status(ROWS));
  const badge = shim.document.querySelector('#cards .acct-status');

  // 源码锚点：模板与运行时都挂 min-w-[var(--status-col…)]；测量写入 --status-col。
  assert.match(STATUS_PILL_SRC, /min-w-\[var\(--status-col/, 'StatusPill 模板必须有 min-w-[var(--status-col…)]');
  assert.match(RENDER_CARDS_JS, /min-w-\[var\(--status-col/, 'fillStatus 运行时类名必须带同一地板');
  assert.match(RENDER_CARDS_JS, /syncStatusColumn/, 'render-cards.js 必须有 syncStatusColumn');
  assert.match(RENDER_CARDS_JS, /--status-col/, 'syncStatusColumn 必须把测量值写进 --status-col');
  assert.match(RENDER_CARDS_JS, /getBoundingClientRect/, '测量必须走 border-box（getBoundingClientRect）');
  assert.match(CSS, /min-width:\s*var\(--status-col,\s*0px\)/, '产物里必须编译出 min-width:var(--status-col,0px)');
  // 产物里不得有把状态列钉死的像素宽（min-width 只兜地板，不封顶）。
  assert.doesNotMatch(STATUS_PILL_SRC, /acct-status[^"]*w-\[\d+px\]/, '状态徽章不得钉死像素宽');

  // 几何：徽章的 min-width 声明是内容自适应之外的**地板**；文字仍单行不折。
  assert.match(declOfEl(CSS, badge, 'min-width') || '', /var\(--status-col/);
  const nowrap = clsTokens(badge).some((t) => /white-space:\s*nowrap/.test(lastBodyOf(CSS, t) || ''));
  assert.ok(nowrap, '状态文案必须单行（whitespace-nowrap），等宽不靠折行实现');
  // daisyUI badge 自带 justify-content:center —— 文案在列内居中。
  assert.match(lastBodyOf(CSS, 'badge') || '', /justify-content:\s*center/);
  assert.match(declOfEl(CSS, badge, 'width') || 'fit-content', /^fit-content$/,
    '徽章宽度仍是 fit-content（min-width 只是地板，不改成固定 width）');
});

// ── ② 环内数字居中：真机实测偏差 ≤1px（误报，未改代码）──────────────────
test('B24i-2：环内数字居中机制完好（真机实测水平 0.00px / 垂直 0.50px，无需改代码）', () => {
  // 真机 Chromium（1920×1080，--size:3.25rem=52px）实测：
  //   环容器 #usage-gauge 中心 (219.00, 180.00)；数字文本节点（Range 量）中心 (219.00, 179.50)
  //   → 水平偏差 0.00px、垂直偏差 0.50px，两者均 ≤1px ⇒ 本来就居中，观感为误报。
  const gauge = /<span id="usage-gauge"[^>]*>([^<]*)<\/span>/.exec(INDEX_HTML);
  assert.ok(gauge, '产物里必须有 #usage-gauge');
  assert.equal(gauge[1].trim(), '0.0%', '环内占位读数与运行时口径一致（一位小数）');

  // 居中由 daisyUI radial-progress 提供：inline-grid + place-content:center + content-box。
  assert.match(CSS, /\.radial-progress\s*\{[^}]*display:\s*inline-grid/);
  assert.match(CSS, /\.radial-progress\s*\{[^}]*place-content:\s*center/);
  assert.match(CSS, /\.radial-progress\s*\{[^}]*box-sizing:\s*content-box/);
  assert.match(CSS, /\.radial-progress\s*\{[^}]*width:\s*var\(--size\)/);
  assert.match(CSS, /\.radial-progress\s*\{[^}]*height:\s*var\(--size\)/);

  // 环元素自身不得带任何内边距 / 外边距 / 位移 / 尺寸覆盖 —— 那才会把数字推出中心。
  const gaugeTag = /<span id="usage-gauge"[^>]*>/.exec(INDEX_HTML)[0];
  const tokens = /class="([^"]*)"/.exec(gaugeTag)[1].split(/\s+/).filter(Boolean);
  assert.ok(tokens.includes('radial-progress'), '环元素必须用 daisyUI 的 radial-progress 组件类');
  for (const prop of ['padding', 'padding-inline', 'padding-block', 'padding-top', 'padding-left',
    'inset', 'translate', 'margin', 'margin-left', 'margin-right', 'mx', 'px', 'py', 'translate-x', 'translate-y']) {
    const v = declForTokens(CSS, tokens, prop);
    assert.equal(v, null, `${prop} 会把环内数字推出中心（当前 ${v}）`);
  }
  // 尺寸是正方形（--size 同时给 width/height），改 size 不会只改一边。
  assert.ok(tokens.some((t) => /^\[--size:[\d.]+rem\]$/.test(t)), '环尺寸走 [--size:…] 任意属性类');
});

// ── ③ 百分比统一口径：环内与旁词逐字符相同 ─────────────────────────────
/** 只有 1 个账号计入分母：used 62.6 / cap 100 → 62.6%（真机实测环内 = 旁词 = 62.6%）。 */
function percentFixture() {
  return [
    account({ keyId: 'aaaa1111', name: '主号', lastQuota: quota({ monthly: { used: 62.6, cap: 100, percent: 62.6, resetAt: 0 } }) }),
    account({ keyId: 'bbbb2222', name: '副号1', lastQuota: quota({ monthly: { used: 0, cap: 0, percent: 0, resetAt: 0 } }) }),
  ];
}
function gaugeAndBreakdown(shim) {
  const gaugeText = shim.el('usage-gauge').textContent;
  const breakdown = shim.el('bal-breakdown').textContent;
  return { gaugeText, breakdownText: breakdown, aria: shim.el('usage-gauge').getAttribute('aria-label') };
}

test('P1：产物卡片使用粉紫柔影令牌', () => {
  assert.match(CSS, /box-shadow:\s*var\(--shadow-card\)/);
  assert.match(CSS, /--shadow-card:0 2px 8px #2d1b3d0d/);
});

test('B24i-3：环内呈现百分比，旁文说明用量与额度且不重复百分比', async () => {
  const { shim, page } = await boot();
  page.render(status(percentFixture()));
  const got = gaugeAndBreakdown(shim);
  assert.equal(got.gaugeText, '62.6%', '进度环承担百分比语义');
  assert.match(got.breakdownText, /^本月已用 · /, '旁文说明用量及额度构成');
  assert.doesNotMatch(got.breakdownText, /%/, '旁文不重复百分比');
  assert.equal(got.aria, '本月额度已用 62.6%', 'aria-label 用同一个口径');
  // 鉴别力 / 变异验证：旧的取整写法（Math.round → 63%）与旁词可区分 ⇒ 改回去必红。
  assert.notEqual(got.gaugeText, Math.round(62.6) + '%', '鉴别力：62.6 与取整后的 63 必须可区分');
});

test('B24i-3b：两处共用同一个格式化函数；边界值也一致（≥99.95 → 100%，无 cap → —）', async () => {
  assert.match(RENDER_HERO_JS, /function heroPctText\(/, 'render-hero.js 必须有唯一的百分比口径函数');
  // 百分比只由环使用；breakdown 不应再次格式化百分比。
  assert.ok((RENDER_HERO_JS.match(/heroPctText\(/g) || []).length >= 2,
    'heroPctText 必须供环内百分比使用');
  // 不得再有「取整 + '%'」这种第二种写法。
  assert.doesNotMatch(RENDER_HERO_JS, /gauge\.textContent\s*=\s*pct\s*\+\s*'%'/, '环内不得再自行取整拼串');

  const { shim, page } = await boot();
  // 99.96% → 一处进位成「100%」，另一处必须一样（否则又会 100.0% vs 100% 打架）。
  page.render(status([account({ keyId: 'aaaa1111', lastQuota: quota({ monthly: { used: 99.96, cap: 100, percent: 99.96, resetAt: 0 } }) })]));
  let got = gaugeAndBreakdown(shim);
  assert.equal(got.gaugeText, '100%', `边界值环内（实际 ${got.gaugeText}）`);
  assert.match(got.breakdownText, /^本月已用 · /);
  assert.doesNotMatch(got.breakdownText, /%/);
  // 超过 100% 也夹到同一处（环画不出更多，旁词不谎报）。
  page.render(status([account({ keyId: 'aaaa1111', lastQuota: quota({ monthly: { used: 120, cap: 100, percent: 120, resetAt: 0 } }) })]));
  got = gaugeAndBreakdown(shim);
  assert.doesNotMatch(got.breakdownText, /%/, '超过 100% 旁文仍不重复');
  assert.equal(got.gaugeText, '100%');
  // 没有 cap：环内「—」、旁词兜底文案（不出现伪百分比）。
  page.render(status([account({ keyId: 'aaaa1111', lastQuota: quota({ monthly: { used: 5, cap: 0, percent: 0, resetAt: 0 } }) })]));
  assert.equal(shim.el('usage-gauge').textContent, '—');
  assert.match(shim.el('bal-breakdown').textContent, /本月用量待同步/);
});
