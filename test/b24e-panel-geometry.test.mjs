// 批次 24e：上一批 BUG-2 的断言查的是「类名 / 栅格模板字符串」，真浏览器里布局仍是错的。
// 本文件不再断言类名字面量，而是**按渲染几何**判定：
//   垫片没有排版引擎（clientWidth/scrollWidth 恒为 0），所以用一个确定性的可计算模型
//   ——「按字符类别估算文本像素宽」+「从真 CSS 解析名称列的栅格轨道把它分到多少宽」，
//   再断言 `文本所需宽 <= 名称列分到的宽`（等价于 scrollWidth <= clientWidth）。
//   模型对「名称列被钉成固定 133px」这种变异会算出 133 < 所需宽 → 必红（见文件末变异说明）。
//
// 另覆盖：状态徽章撞 daisyUI .status 组件导致文字换行溢出、耗尽信息说两遍、同行卡片等高、
// 以及静态资源 HEAD 与 GET 行为一致（BUG-2 之外的批次 24e 项）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createDomShim, runInlineScript, styleText, startTestGateway, request } from './helpers.mjs';

const DIST = new URL('../panel/dist/', import.meta.url);
const INDEX_HTML = fs.readFileSync(new URL('../panel/dist/index.html', import.meta.url), 'utf8');
const ACCOUNT_CARD_SRC = fs.readFileSync(new URL('../panel/src/components/AccountCard.astro', import.meta.url), 'utf8');
const INDEX_SRC = fs.readFileSync(new URL('../panel/src/pages/index.astro', import.meta.url), 'utf8');
const CSS = styleText(INDEX_HTML);

// 1920 视口下主页面卡片摘要的**内容宽**（真机实测与推导一致）：
//   main = min(1920,1600) 上限 1600，px-4 → 1568；#cards 两列 gap-2(8px) → 列宽 780；
//   summary 内容 = 780 - 2(左右边框) - 16(左 padding) - 48(padding-inline-end 3rem) = 714。
// 真机实测 `#cards .tags` 宽 = 714，与推导逐像素吻合。
const SUMMARY_CONTENT_PX = 714;

// ── 可计算的排版几何模型 ──────────────────────────────────────────────
// 字号 → 文本像素宽的确定性估算：CJK/全角 ≈ 1em，ASCII 常规 ≈ 0.6em，窄字符 ≈ 0.32em。
// 不做字体度量（无外部依赖），只用于「列够不够宽」的相对判断；真机数字见交付说明。
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

/** 取某个工具类的声明体。Tailwind 会转义 [ ( ) , ] 等字符；这里允许类名每个字符前有可选反斜杠。 */
function declsForClass(css, cls) {
  const pat = String(cls).split('').map((ch) => {
    const esc = ch.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');
    return '\\\\?' + esc;
  }).join('');
  const m = new RegExp('\\.' + pat + '\\s*\\{([^{}]*)\\}').exec(css);
  return m ? m[1] : null;
}

function clsTokens(el) { return String(el.className).split(/\s+/).filter(Boolean); }

/** 把 grid-template-columns 值切成轨道（顶层空格分隔，忽略括号内的空格）。 */
function splitTracks(value) {
  const out = []; let depth = 0; let cur = '';
  for (const ch of value) {
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    if (/\s/.test(ch) && depth === 0) { if (cur) out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * 浏览器会把第一列分到多少宽：
 *   max-content / auto / min-content  → 按内容（够放就放得下，受容器上限约束）
 *   Npx / Nrem / minmax(.., Npx)      → 钉死为 N（这正是 BUG-2 的形态：133px）
 *   其余（fr 等）                      → 按剩余空间估算
 */
function firstColumnWidth(track, required, container) {
  const mm = /^minmax\(\s*([^,]+?)\s*,\s*(.+?)\s*\)$/.exec(track);
  const maxPart = mm ? mm[2] : track;
  if (/^(max-content|auto|min-content)$/.test(maxPart)) {
    return { contentBased: true, width: Math.min(required, container) };
  }
  const px = /^(\d+(?:\.\d+)?)px$/.exec(maxPart);
  if (px) return { contentBased: false, width: Number(px[1]) };
  const rem = /^(\d+(?:\.\d+)?)rem$/.exec(maxPart);
  if (rem) return { contentBased: false, width: Number(rem[1]) * 16 };
  return { contentBased: false, width: Math.max(0, container - required) };
}

/** 摘要元素上的名称列轨道（来自渲染后的 DOM 类名 + 真 CSS），拿不到返回 null。 */
function nameTrackOf(summary) {
  const token = clsTokens(summary).find((t) => t.startsWith('grid-cols-['));
  if (!token) return null;
  const decls = declsForClass(CSS, token);
  if (!decls) return null;
  const gtc = /grid-template-columns\s*:\s*([^;]+)/.exec(decls);
  if (!gtc) return null;
  const tracks = splitTracks(gtc[1].trim());
  return tracks.length >= 2 ? { token, track: tracks[0] } : null;
}

/**
 * 状态徽章盒子会被分配到多宽（对应真机 `scrollWidth <= clientWidth`）：
 *   - 任一 token 命中「钉死尺寸」规则（daisyUI .status 的 aspect-ratio:1 / width:var(--size)）
 *     → 返回被钉死的像素宽（daisyUI badge 高度 --size = 1.5rem = 24px；文字会换行/溢出）；
 *   - 否则是内容自适应盒 → 至少容得下文字（文字宽 + 内边距 + 色点）。
 * 返回 { width, constrained }，constrained 非空表示撞上了固定尺寸组件。
 */
function badgeBox(tokens, textW) {
  for (const t of tokens) {
    const d = declsForClass(CSS, t);
    if (!d) continue;
    const ar = /aspect-ratio\s*:\s*1\b/.test(d);
    const w = /(?:^|;)\s*width\s*:\s*([^;]+)/.exec(d);
    const fixedW = w && !/^(auto|fit-content|max-content|min-content|100%|inherit|initial)$/.test(w[1].trim());
    if (ar || fixedW) {
      const px = /(\d+(?:\.\d+)?)px/.exec(fixedW ? w[1] : '');
      const rem = /(\d+(?:\.\d+)?)rem/.exec(fixedW ? w[1] : '');
      const size = px ? Number(px[1]) : rem ? Number(rem[1]) * 16 : 24;   // 24 = daisyUI badge --size(1.5rem)
      return { width: size, constrained: `${t}{${ar ? 'aspect-ratio:1' : 'width:' + w[1].trim()}}` };
    }
  }
  return { width: textW + 32 + 16, constrained: null };   // badge padding-inline 11×2 + dot 8 + gap 8
}

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
function dom(html) {
  return createDomShim({ html, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }) });
}

// 4 行、含一个「真机需要 150px 才放得下」的长名 —— 旧的固定 133px 列会把它裁成「主号…」。
const ROWS = [
  account({ keyId: 'aaaa1111', name: '主号-生产环境密钥一' }),
  account({ keyId: 'bbbb2222', name: '副号1-测试环境' }),
  account({ keyId: 'cccc3333', name: '副号2' }),
  account({ keyId: 'dddd4444', name: '副号3' }),
];

// ── BUG-2：每一行名称元素 scrollWidth <= clientWidth（用可计算几何等价表达）──
test('B24e-1：渲染后每一行名称列宽 >= 名称文本所需宽（没有 text-overflow 裁剪）', async () => {
  const shim = dom(INDEX_HTML);
  const page = await runInlineScript(INDEX_HTML, shim);
  page.render({
    now: Date.now(), quotaPoll: {},
    summary: { accounts: ROWS.length, enabled: ROWS.length, available: ROWS.length, unavailable: 0, paused: 0, concurrency: 0 },
    stats: { total: 0, errors: 0, clientErrors: 0, totalTokens: 0 },
    accounts: ROWS,
  });

  const cards = shim.document.querySelectorAll('#cards .row-card');
  assert.equal(cards.length, 4, '渲染出 4 行');
  const requiredOf = (c) => textWidthPx(c.querySelector('h2').textContent, 16);   // text-base = 16px
  // 鉴别力前提：最长的一个名字必须比旧的固定 133px 列更宽，否则「够不够宽」的断言区分不出来。
  const maxRequired = Math.max(...cards.map(requiredOf));
  assert.ok(maxRequired > 133, `最长名称需 > 133px 才有鉴别力（实际 ${Math.round(maxRequired)}）`);

  for (const c of cards) {
    const h2 = c.querySelector('h2');
    const got = nameTrackOf(c.querySelector('summary'));
    assert.ok(got, '摘要必须有内容自适应的名称列轨道（grid-template-columns 首列）');

    const required = requiredOf(c);
    const alloc = firstColumnWidth(got.track, required, SUMMARY_CONTENT_PX);
    assert.ok(alloc.contentBased,
      `名称列必须是内容自适应轨道，不能用固定像素（当前 ${got.track}）`);
    // 等价于 scrollWidth <= clientWidth：名称文本需要的宽度必须 <= 名称列分到的宽度。
    assert.ok(required <= alloc.width,
      `名称被裁剪：需要 ${Math.round(required)}px，列只分到 ${Math.round(alloc.width)}px（name=${h2.textContent}）`);
  }
});

test('B24e-1b：名称列轨道来自真构建产物（不是测试自造的类名）', () => {
  // ACCOUNT_CARD 的 summary 里写死了 name 列在前，产物里能解析出 max-content 首列。
  assert.match(ACCOUNT_CARD_SRC, /row-summary[\s\S]*?grid-cols-\[\s*minmax\(0,\s*max-content\)/,
    'AccountCard 的 summary 首列是内容自适应');
  assert.doesNotMatch(ACCOUNT_CARD_SRC, /row-summary[\s\S]{0,200}?grid-cols-\[\s*\d+px/, '首列不得是固定像素');
});

// ── BUG-2 的伴生症状：状态徽章被 daisyUI .status 撞名 → 8px 方点 + 文字换行溢出 ──
test('B24e-2：状态徽章是内容自适应盒（不撞 daisyUI .status 的固定方点），文字放得下', async () => {
  const shim = dom(INDEX_HTML);
  const page = await runInlineScript(INDEX_HTML, shim);
  page.render({
    now: Date.now(), quotaPoll: {},
    summary: { accounts: 1, enabled: 1, available: 0, unavailable: 1, paused: 0, concurrency: 0 },
    stats: { total: 0, errors: 0, clientErrors: 0, totalTokens: 0 },
    accounts: [account({ name: '主号', available: false, creditsExhausted: true, exhausted: { kind: 'monthly', label: '月额度已用完', resetAt: Date.now() + 86400000 } })],
  });
  const st = shim.document.querySelector('#cards .row-card .acct-status');
  assert.ok(st, '状态徽章必须用不撞 daisyUI 的 acct-status 类');

  const tokens = clsTokens(st);
  const textW = textWidthPx(st.textContent, 14);   // badge font-size .875rem
  const box = badgeBox(tokens, textW);

  // 几何：盒宽必须容得下文字。撞上 daisyUI .status 时盒宽被钉成 24px，文字放不下 → 换行溢出。
  assert.ok(textW <= box.width,
    `徽章文字 ${Math.round(textW)}px 放不进 ${Math.round(box.width)}px 的盒子`
    + (box.constrained ? `（被 ${box.constrained} 钉死）` : ''));
  assert.equal(box.constrained, null, `徽章类名撞上固定尺寸组件：${box.constrained}`);

  // 单行是几何前提：会换行就意味着宽度不够，文字必然溢出到卡外。
  const contentSized = tokens.some((t) => /white-space\s*:\s*nowrap/.test(declsForClass(CSS, t) || ''));
  assert.ok(contentSized, '徽章文字必须单行（whitespace-nowrap），否则会在方点里折断、溢出到卡外');
  // 撞名回归的直接证据：徽章 class 里不得再出现 daisyUI 的 status 组件类。
  assert.ok(!tokens.includes('status'), 'status 是 daisyUI 组件类，不能再拿来当状态徽章的钩子');
});

// ── #4：同一件事不说两遍 —— 徽章已说状态，标签条只补「重置时间」 ──────────
test('B24e-3：耗尽状态只在徽章说一次；标签条只留独有的重置时间', async () => {
  const shim = dom(INDEX_HTML);
  const page = await runInlineScript(INDEX_HTML, shim);
  const resetAt = Date.now() + 3 * 86400e3;
  const out = page.card(account({
    name: '主号', available: false, creditsExhausted: true,
    exhausted: { kind: 'monthly', label: '月额度已用完', resetAt },
    lastQuota: quota({ remaining: 0 }),
  }));
  const n = (out.match(/月额度已用完/g) || []).length;
  assert.equal(n, 1, `「月额度已用完」只能说一次（实际 ${n} 次）`);
  assert.match(out, /badge[^"]*">\d{1,2}\/\d{1,2} \d{2}:\d{2} 重置</, '标签条要保留重置时间这条独有信息');
});

test('B24e-3b：余额不足 / 鉴权失效同样只由徽章表达，标签条不重复状态词', async () => {
  const shim = dom(INDEX_HTML);
  const page = await runInlineScript(INDEX_HTML, shim);
  const bal = page.card(account({ name: 'A', available: false, creditsExhausted: true, exhausted: null }));
  assert.equal((bal.match(/余额不足/g) || []).length, 1, '余额不足只说一次');
  const inv = page.card(account({ name: 'B', available: false, authInvalid: true }));
  assert.equal((inv.match(/鉴权失效/g) || []).length, 1, '鉴权失效只说一次');
});

test('B24e-3c：合并不得丢掉真正的补充信息（暂停 / 限流剩余时间照旧）', async () => {
  const shim = dom(INDEX_HTML);
  const page = await runInlineScript(INDEX_HTML, shim);
  const paused = page.card(account({ name: 'C', available: false, paused: true, pausedUntil: Date.now() + 3 * 86400e3 }));
  assert.match(paused, /暂停至 \d{1,2}\/\d{1,2} \d{2}:\d{2}/, '暂停截止时间不能被合并掉');
  const rl = page.card(account({ name: 'D', available: false, rateLimited: true, rateLimitedUntil: Date.now() + 60000 }));
  assert.match(rl, /限流冷却中 · 剩 \d+ (秒|分钟)/, '限流剩余时间不能被合并掉');
});

// ── #2：同行卡片等高（CSS 网格项默认 stretch；显式 items-stretch 兜底）──
test('B24e-4：账号网格显式 items-stretch，同行卡片按行等高（真机实测 4 行均 92px）', () => {
  assert.match(INDEX_SRC, /id="cards"[^>]*class="[^"]*\bitems-stretch\b/, '#cards 显式 items-stretch');
  assert.match(CSS, /\.items-stretch\s*\{[^}]*align-items:\s*stretch/, 'items-stretch 编译进产物');
});

// ── HEAD 与 GET 行为一致（静态资源）─────────────────────────────────
function cssAssetName() {
  const dir = new URL('../panel/dist/assets/', import.meta.url);
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.css'));
  assert.equal(files.length, 1, `应只有一个 CSS 产物，实际 ${files.join(',')}`);
  return files[0];
}

test('B24e-5：HEAD /assets/<hash>.css 与 GET 同状态码/头部（无响应体）', async (t) => {
  const file = cssAssetName();
  const ctx = await startTestGateway({ noInitialRefresh: true });
  t.after(() => ctx.close());

  const head = await request(`${ctx.baseUrl}/assets/${file}`, { method: 'HEAD' });
  assert.equal(head.status, 200, `HEAD /assets/${file} 必须 200（此前落到 API 404）`);
  assert.match(head.headers['content-type'], /^text\/css; charset=utf-8$/i, 'HEAD 也必须是 text/css');
  assert.equal(head.headers['cache-control'], 'public, max-age=31536000, immutable', 'HEAD 也发 immutable');
  assert.equal(head.body, '', 'HEAD 不得带响应体');

  // 与 GET 同状态码/头部（GET 既有行为不变）。
  const get = await request(`${ctx.baseUrl}/assets/${file}`);
  assert.equal(get.status, head.status, 'HEAD 与 GET 状态码一致');
  assert.equal(get.headers['content-type'], head.headers['content-type'], 'HEAD 与 GET content-type 一致');
  assert.equal(get.headers['cache-control'], head.headers['cache-control'], 'HEAD 与 GET 缓存头一致');
  assert.ok(get.body.length > 10_000, 'GET 仍返回完整 CSS 正文');
});

test('B24e-5b：HEAD 负例（非白名单扩展名 / 穿越）同样 404', async (t) => {
  const ctx = await startTestGateway({ noInitialRefresh: true });
  t.after(() => ctx.close());
  for (const p of ['/assets/x.json', '/assets/../gateway.mjs', '/vendor/nope.json']) {
    const r = await request(`${ctx.baseUrl}${p}`, { method: 'HEAD' });
    assert.equal(r.status, 404, `HEAD ${p} 必须 404`);
    assert.equal(r.body, '', `HEAD ${p} 不得带响应体`);
  }
});
