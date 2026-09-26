// 批次 24g / 24h：账号列表收尾打磨 —— 全部按**渲染几何**判定，而不是按观感。
//   ① 套餐徽章列起点统一（B24h）：名称列逐行内容自适应 → 短名那行徽章左移 8-9px。
//      B24g 量出全表最长名称宽写进 #cards 的 --name-col、由 h2 的 min-width 兜住；B24h 再把徽章
//      从 h2 里移出、放进紧随名称的 .plan-slot —— 否则 min-width 只把 h2 的盒子撑宽，行内徽章仍
//      紧跟名称文字。现在徽章左边缘 = 统一名称列宽 + gap，四行同起点；名字本身仍内容自适应、不截断。
//   ② 「额度更新于 N 秒前」：字号提到旁词级（text-sm，不再是最小的 text-xs）、颜色用 AA 令牌
//      aux-text（--text-secondary）而不是 text-base-content/60 的 60% 透明；按令牌算合成色对比度。
//   ③ 首屏装得下 4 行（B24h 追加）：四行等高、第 4 行底部 ≤835px、页面无需滚动。
//
// 垫片没有排版引擎，所以与 test/b24e-panel-geometry.test.mjs 用同一套可计算模型：
//   - 文本像素宽：按字符类别估算（CJK≈1em / ASCII≈0.6em / 窄字符≈0.32em）；
//   - 水平位置：按 DOM 结构决定「谁在谁后面」——徽章在 h2 内 = 内联紧跟名称文字；是 h2 的兄弟
//     （.plan-slot）= 名称列宽 + gap；名称列宽按 h2 的 CSS（固定 width / min-width:var(--name-col)）解析；
//   - 纵向高度：从真 CSS 解析间距（--spacing 系工具类）、内边距、行高令牌（--text-*-line-height）；
//   - 颜色：从 daisyUI 主题令牌解析 oklch/hex，按 CSS color-mix 语义做 alpha 合成后算 WCAG 对比度。
// 模型已与真机 Chromium 实测逐项对齐（见交付说明里的前后数字）。
//
// 变异验证（改回旧形态即变红）：
//   ① 套餐徽章改回「紧跟名称文字」（append 到 h2）→ 结构分支取名称文字宽 → 四行落差 >1px → 红；
//   ② 名称列改成固定像素宽（w-[133px]）→ 最长名 154px 放不下 → 不裁切断言红；
//   ③ 颜色改回 text-base-content/60 → 浅色主题对比度 4.19 < 4.5 → 红；
//   ④ 把 summary 的 py-2 改回默认 1rem（或主壳 gap-2 改回 gap-4）→ 预算 > 800 → 红。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createDomShim, runInlineScript, styleText } from './helpers.mjs';

const INDEX_HTML = fs.readFileSync(new URL('../panel/dist/index.html', import.meta.url), 'utf8');
const CSS = styleText(INDEX_HTML);
const PANEL_CSS = fs.readFileSync(new URL('../panel/src/styles/panel.css', import.meta.url), 'utf8');
const ACCOUNT_CARD_SRC = fs.readFileSync(new URL('../panel/src/components/AccountCard.astro', import.meta.url), 'utf8');
const INDEX_SRC = fs.readFileSync(new URL('../panel/src/pages/index.astro', import.meta.url), 'utf8');
const HERO_CARD_SRC = fs.readFileSync(new URL('../panel/src/components/HeroCard.astro', import.meta.url), 'utf8');
const RENDER_CARDS_JS = fs.readFileSync(new URL('../panel/public/js/render-cards.js', import.meta.url), 'utf8');

// 1920 视口下主页面卡片摘要的内容宽（真机实测与推导一致，见 b24e）：
// main = min(1920,1600) → px-4 → 1568；#cards 两列 gap-2 → 780；summary 内容 = 780-2-16-48 = 714。
const SUMMARY_CONTENT_PX = 714;
// 目标：常见笔记本视口 1440×900，浏览器 chrome 吃掉约 100px → 可用高约 800px。
const TARGET_VIEWPORT_PX = 800;

// UI 重写后的卡片网格几何（1600 视口上限、4 列、卡片 padding 1rem）下，留给名称的可用宽：
//   列宽 ≈ 381.5 → 内容 349.5，再减状态点(8) + 头部 gap(8) + 状态药丸上限(≈122) ≈ 211px。
//   取整保守值 200：名称若被钉在 133px 这类固定窄列会立刻变红（最长名 > 133）。
const CARD_NAME_ALLOW_PX = 200;

// ── 文本像素宽模型（与 b24e 同一套）────────────────────────────────────
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

/** Tailwind 会转义 [ ( ) , . / 等字符；类名每个字符前允许有可选反斜杠。 */
function classPattern(cls) {
  return String(cls).split('').map((ch) => {
    const esc = ch.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');
    return '\\\\?' + esc;
  }).join('');
}
/** 某个类在产物里命中的全部规则体（含源序下标）—— daisyUI 组件类常有多条同选择器规则。 */
function classBodies(css, cls) {
  const re = new RegExp('\\.' + classPattern(cls) + '\\s*\\{([^{}]*)\\}', 'g');
  const out = []; let m;
  while ((m = re.exec(css))) out.push({ body: m[1], index: m.index });
  return out;
}
function lastBodyOf(css, cls) { const b = classBodies(css, cls); return b.length ? b[b.length - 1].body : null; }
function declsForClass(css, cls) { return lastBodyOf(css, cls); }
function clsTokens(el) { return String(el.className).split(/\s+/).filter(Boolean); }

/**
 * 元素上某属性的解析值：**按 CSS 源序**取最后一条生效声明（等价同优先级的层叠规则），
 * 而不是按 class 属性里的先后。daisyUI 组件（.navbar / .card-body / .stat）在前，
 * Tailwind 工具类（gap-2 / py-2 / p-4）在后 —— 正是真机层叠的结果。
 */
function declOfEl(css, el, prop) {
  const re = new RegExp('(?:^|;)\\s*' + prop.replace(/-/g, '\\-') + '\\s*:\\s*([^;]+)', 'g');
  let best = null; let bestIdx = -1;
  for (const t of clsTokens(el)) {
    let val = null; let valIdx = -1;
    for (const { body, index } of classBodies(css, t)) {
      re.lastIndex = 0; let m; let last = null;
      while ((m = re.exec(body))) last = m[1].trim();
      if (last !== null) { val = last; valIdx = index; }
    }
    if (val !== null && valIdx > bestIdx) { best = val; bestIdx = valIdx; }
  }
  return best;
}
function classFontSizeRem(css, cls) {
  const b = lastBodyOf(css, cls) || '';
  const m = /font-size:\s*([\d.]+)rem/.exec(b);
  return m ? parseFloat(m[1]) : null;
}
function spitTracks(value) {
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
/** summary 的名称列轨道（栅格首列）。 */
function nameTrackOf(summary) {
  const token = clsTokens(summary).find((t) => t.startsWith('grid-cols-['));
  if (!token) return null;
  const d = declsForClass(CSS, token);
  if (!d) return null;
  const gtc = /grid-template-columns\s*:\s*([^;]+)/.exec(d);
  if (!gtc) return null;
  const tracks = spitTracks(gtc[1].trim());
  return tracks.length >= 2 ? { token, track: tracks[0] } : null;
}
function trackIsContentBased(track) {
  const mm = /^minmax\(\s*([^,]+?)\s*,\s*(.+?)\s*\)$/.exec(track);
  const maxPart = mm ? mm[2] : track;
  return /^(max-content|auto|min-content)$/.test(maxPart);
}

// ── B24h：名称/套餐/状态/余额四列的水平几何（结构感知，垫片无排版引擎）──
/** h2（名称元素）分到的布局宽度：
    - 显式固定 width（w-[...]px）→ 就取该像素值（内容超了会被截断）；
    - min-width:var(--name-col)（B24g 统一列宽机制，变量已写入）→ max(统一列宽, 名称所需宽)；
    - 其余 → 名称所需宽（逐行内容自适应）。 */
function nameCellWidthPx(css, h2, tableCol, requiredPx) {
  const pxOf = (decl) => { const m = /^(\d+(?:\.\d+)?)px$/.exec(String(decl || '').trim()); return m ? parseFloat(m[1]) : null; };
  const widthDecl = declOfEl(css, h2, 'width');
  const minDecl = declOfEl(css, h2, 'min-width') || '';
  const wired = /var\(--name-col/.test(widthDecl || '') || /var\(--name-col/.test(minDecl);
  const fixedW = pxOf(widthDecl);
  if (fixedW != null) return fixedW;                                   // 固定宽：上限，超了裁
  if (wired && tableCol > 0) return Math.max(tableCol, requiredPx);    // min-width 是地板，不裁
  const fixedMin = pxOf(minDecl);
  if (fixedMin != null) return Math.max(fixedMin, requiredPx);
  return requiredPx;
}
/** .row-title 的 flex 间距（名称 / 套餐 / 状态相邻元素的 gap-2）。 */
function rowTitleGapPx(summary) {
  return spacingOf(CSS, spacingUnit(CSS), summary.querySelector('.row-title'), 'gap', 8);
}
/** 套餐徽章左边缘（相对 summary 内容左边界）：
    徽章在 h2 内 → 内联紧跟名称文字（= 名称文字宽，短名那行会左移）；
    徽章是 h2 的兄弟（.plan-slot，B24h 修法）→ = 名称列宽 + row-title gap。 */
function planPillLeftOffsetPx(card, requiredNamePx, tableCol) {
  const h2 = card.querySelector('h2');
  const pill = card.querySelector('.plan-pill');
  if (!pill) return null;
  if (h2.querySelector('.plan-pill')) return requiredNamePx;
  return nameCellWidthPx(CSS, h2, tableCol, requiredNamePx) + rowTitleGapPx(card.querySelector('summary'));
}
/** 状态徽章左边缘（相对 summary 内容左边界）：名称 → 套餐 → 状态 依次排列。 */
function statusLeftOffsetPx(card, requiredNamePx, tableCol) {
  const h2 = card.querySelector('h2');
  const pill = card.querySelector('.plan-pill');
  const gap = rowTitleGapPx(card.querySelector('summary'));
  if (h2.querySelector('.plan-pill')) {
    const inner = requiredNamePx;                                      // 名称 + 徽章同一内联盒
    return Math.max(nameCellWidthPx(CSS, h2, tableCol, inner), inner) + gap;
  }
  const nameW = nameCellWidthPx(CSS, h2, tableCol, requiredNamePx);
  const pillW = pill ? textWidthPx(pill.textContent, classFontSizeRem(CSS, 'badge') ?? 12) : 0;
  return nameW + gap + pillW + gap;
}
/** 余额数字右边缘（相对 summary 内容右边界）：row-meters 右对齐 → 0；
    若非右对齐则从左排（fresh + gap + balance）。 */
function balanceRightOffsetPx(card) {
  const meters = card.querySelector('.row-meters');
  if (clsTokens(meters).includes('justify-end')) return 0;
  const su = spacingUnit(CSS);
  const gap = spacingOf(CSS, su, meters, 'gap', 12);
  const fresh = card.querySelector('.card-fresh');
  const bal = card.querySelector('.usable-balance');
  const freshW = fresh ? textWidthPx(fresh.textContent, classFontSizeRem(CSS, 'text-sm') ?? 14) : 0;
  const balW = bal ? textWidthPx(bal.textContent, classFontSizeRem(CSS, 'text-lg') ?? 18) : 0;
  return freshW + gap + balW - SUMMARY_CONTENT_PX;
}
/** 单行高度（与 b24g aboveFoldBudget 同口径，但按行自己解析）。 */
function rowHeightPx(css, card) {
  const su = spacingUnit(css);
  const summary = card.querySelector('summary');
  const tags = card.querySelector('.tags');
  const summaryPad = paddingBlockOf(css, su, summary, 16);
  const row1 = Math.max(lineHeightOf(css, 'base'), lineHeightOf(css, 'lg'), sizeTokenPx(css, 'badge', 24));
  const tagsH = fixedHeightOf(css, su, tags, 'min-height', 24) + spacingOf(css, su, tags, 'margin-top', 0);
  return 2 + summaryPad * 2 + row1 + spacingOf(css, su, summary, 'row-gap', 4) + tagsH;
}

// ── 间距 / 行高解析（从真 CSS 的令牌与工具类）──────────────────────────
function spacingUnit(css) {
  const m = /--spacing:\s*([\d.]+)rem/.exec(css);
  return m ? parseFloat(m[1]) * 16 : 4;
}
function exprToPx(expr, su) {
  if (!expr) return null;
  let m = /calc\(\s*var\(--spacing\)\s*\*\s*([\d.]+)\s*\)/.exec(expr);
  if (m) return parseFloat(m[1]) * su;
  if (/var\(--spacing\)/.test(expr)) return su;
  m = /([\d.]+)rem/.exec(expr); if (m) return parseFloat(m[1]) * 16;
  m = /([\d.]+)px/.exec(expr); if (m) return parseFloat(m[1]);
  return null;
}
/** 元素在某个属性上的解析值：先按 prop 名查工具类，再退回 daisyUI 组件默认值。 */
function spacingOf(css, su, el, prop, fallback) {
  return exprToPx(declOfEl(css, el, prop), su) ?? fallback;
}
/** padding-block 认 padding-block（py-N）与 padding（p-N）。 */
function paddingBlockOf(css, su, el, fallback) {
  return spacingOf(css, su, el, 'padding-block', null)
    ?? spacingOf(css, su, el, 'padding', null)
    ?? fallback;
}
function paddingTopOf(css, su, el, fallback) {
  return spacingOf(css, su, el, 'padding-top', null) ?? paddingBlockOf(css, su, el, fallback);
}
/** `--text-<token>` + `--text-<token>--line-height`（calc(a/b) 或纯数）→ 行高像素。 */
function lineHeightOf(css, token) {
  const fs = new RegExp('--text-' + token + ':\\s*([\\d.]+)rem').exec(css);
  const lh = new RegExp('--text-' + token + '--line-height:\\s*([^;}]+)').exec(css);
  if (!fs) return null;
  const fsPx = parseFloat(fs[1]) * 16;
  if (!lh) return fsPx;
  const raw = lh[1].trim();
  const c = /calc\(\s*([\d.]+)\s*\/\s*([\d.]+)\s*\)/.exec(raw);
  const ratio = c ? parseFloat(c[1]) / parseFloat(c[2]) : parseFloat(raw);
  return Math.round(fsPx * ratio);
}
function fixedHeightOf(css, su, el, prop, fallback) {
  const expr = declOfEl(css, el, prop);
  if (expr) { const px = exprToPx(expr, su); if (px != null) return px; }
  return fallback;
}
/** daisyUI 组件默认尺寸：--size = calc(var(--size-x, .25rem) * N)。 */
function sizeTokenPx(css, cls, fallback) {
  const d = declsForClass(css, cls) || '';
  const m = /--size:\s*calc\(var\(--size-[a-z]+,\s*([\d.]+)rem\)\s*\*\s*([\d.]+)\s*\)/.exec(d);
  return m ? parseFloat(m[1]) * 16 * parseFloat(m[2]) : fallback;
}
/** 任意属性类（如 [--size:3.25rem]）里的声明值。 */
function arbitraryPropPx(css, el, prop, fallback) {
  const re = new RegExp('(?:^|;)\\s*' + prop.replace(/-/g, '\\-') + '\\s*:\\s*([^;]+)');
  let found = null; let foundIdx = -1;
  for (const t of clsTokens(el)) {
    for (const { body, index } of classBodies(css, t)) {
      const m = re.exec(body);
      if (m && index > foundIdx) { const px = exprToPx(m[1].trim(), spacingUnit(css)); if (px != null) { found = px; foundIdx = index; } }
    }
  }
  return found ?? fallback;
}

// ── 颜色 / 对比度（WCAG 2.x 相对亮度）──────────────────────────────────
function oklchToRgb(L, C, Hdeg) {
  const h = Hdeg * Math.PI / 180;
  const a = C * Math.cos(h); const b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3;
  const lin = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  ];
  return lin.map((c) => Math.min(255, Math.max(0, Math.round((c <= 0.0031308 ? 12.92 * c : 1.055 * Math.max(c, 0) ** (1 / 2.4) - 0.055) * 255))));
}
function parseColor(raw) {
  const s = String(raw).trim();
  let m = /^#([0-9a-f]{6})$/i.exec(s);
  if (m) { const v = m[1]; return { r: parseInt(v.slice(0, 2), 16), g: parseInt(v.slice(2, 4), 16), b: parseInt(v.slice(4, 6), 16), a: 1 }; }
  m = /^oklch\(\s*([\d.]+)%\s+([\d.]+)\s+([\d.]+)\s*\)$/i.exec(s);
  if (m) { const [r, g, b] = oklchToRgb(parseFloat(m[1]) / 100, parseFloat(m[2]), parseFloat(m[3])); return { r, g, b, a: 1 }; }
  throw new Error('无法解析颜色：' + s);
}
function withAlpha(c, a) { return { r: c.r, g: c.g, b: c.b, a }; }
function composite(fg, bg) {
  const a = fg.a === undefined ? 1 : fg.a;
  return { r: Math.round(fg.r * a + bg.r * (1 - a)), g: Math.round(fg.g * a + bg.g * (1 - a)), b: Math.round(fg.b * a + bg.b * (1 - a)), a: 1 };
}
function relLum(c) {
  const f = (v) => { const x = v / 255; return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
}
function contrastRatio(fg, bg) {
  const a = relLum(composite(fg, bg)); const b = relLum(bg);
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

// ── daisyUI / 运行时主题令牌（浅/深两套）───────────────────────────────
function themeBlock(css, name) {
  const i = css.indexOf('@plugin "daisyui/theme"');
  const parts = css.slice(i).split('@plugin "daisyui/theme"');
  for (const p of parts) if (new RegExp('name:\\s*"' + name + '"').test(p)) return p;
  return '';
}
function tokenOf(block, name) {
  const m = new RegExp('--' + name + ':\\s*([^;]+);').exec(block);
  return m ? m[1].trim() : null;
}
/** 每个主题下：卡片背景（base-100）与新鲜度文字实际颜色（合成到背景上）。 */
function themeColors(theme) {
  const block = themeBlock(PANEL_CSS, theme);
  const base100 = parseColor(tokenOf(block, 'color-base-100'));
  const baseContent = parseColor(tokenOf(block, 'color-base-content'));
  const runtime = theme === 'dark'
    ? /:root\[data-theme="dark"\]\s*\{([\s\S]*?)\}/.exec(PANEL_CSS)[1]
    : /:root\s*\{([\s\S]*?)\}/.exec(PANEL_CSS)[1];
  const secondary = parseColor(tokenOf(runtime, 'text-secondary'));
  return { base100, baseContent, secondary };
}
/** 元素有效文字色：带 /NN 透明度的 text-* 按 color-mix(...,NN%,transparent) 语义解析；否则 aux-text。 */
function freshTextColor(tokens, theme) {
  const t = themeColors(theme);
  const alphaTok = tokens.find((x) => /^text-[a-z-]+\/\d+$/.test(x));
  if (alphaTok) {
    const [name, pct] = alphaTok.replace(/^text-/, '').split('/');
    const raw = themeBlock(PANEL_CSS, theme);
    const base = parseColor(tokenOf(raw, 'color-' + name));
    return { color: withAlpha(base, Number(pct) / 100), source: alphaTok };
  }
  if (tokens.includes('aux-text')) return { color: t.secondary, source: 'aux-text' };
  return { color: t.baseContent, source: 'base-content' };
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

// 4 行，首行名字短一个字 —— 正是真机上徽章左边缘少 8-9px 的形态。
// 每行都带同样的套餐（渲染 .plan-pill），否则徽章不存在、水平几何断言无从谈起。
const plan = { planId: 'individual-go' };
const ROWS = [
  account({ keyId: 'aaaa1111', name: '主号-生产环境密钥一', lastQuota: quota({ plan }) }),
  account({ keyId: 'bbbb2222', name: '副号1-测试环境', lastQuota: quota({ plan }) }),
  account({ keyId: 'cccc3333', name: '副号2', lastQuota: quota({ plan }) }),
  account({ keyId: 'dddd4444', name: '副号3', lastQuota: quota({ plan }) }),
];

// ── ① 徽章列起点统一 ─────────────────────────────────────────────────
// B24h：套餐徽章不再内联在 h2 里，而是放进紧随名称的 .plan-slot；名称列仍内容自适应。
test('B24g-1/B24h：账号卡头部按内容排布（名称不裁断、套餐徽章有独立槽位），状态徽章等宽地板仍生效', async () => {
  const shim = dom(INDEX_HTML);
  const page = await runInlineScript(INDEX_HTML, shim);
  // 状态文案必须有落差（否则「等宽地板」断言没有鉴别力）：耗尽 / 可用 / 冷却 / 可用。
  page.render(status([
    account({ keyId: 'aaaa1111', name: '主号-生产环境密钥一', creditsExhausted: true, exhausted: { kind: 'monthly', label: '月额度已用完', resetAt: Date.now() + 86400000 } }),
    account({ keyId: 'bbbb2222', name: '副号1-测试环境' }),
    account({ keyId: 'cccc3333', name: '副号2', paused: true, pausedUntil: Date.now() + 60000 }),
    account({ keyId: 'dddd4444', name: '副号3' }),
  ]));

  const cards = shim.document.querySelectorAll('#cards .acct-card');
  assert.equal(cards.length, 4, '渲染出 4 张卡片');

  for (const c of cards) {
    assert.ok(c.querySelector('.acct-card-head h2.card-head'), '名称在卡片头部（card-head）');
    assert.ok(c.querySelector('.acct-card-head .plan-slot'), '套餐徽章有独立槽位（不内联进名称文字后）');
    assert.match(String(c.querySelector('h2').className), /\btruncate\b/, '名称带省略兜底，极窄时不撑破卡片');
  }

  // 名称文字必须放得进卡片留给名称的可用宽（卡片网格：每卡独立，不再有全表统一名称列）。
  const required = cards.map((c) => textWidthPx(c.querySelector('h2').textContent, 16));   // text-base = 16px
  assert.ok(Math.max(...required) > 133, `最长名称需 > 133px 才有鉴别力（实际 ${Math.round(Math.max(...required))}）`);
  assert.ok(Math.max(...required) <= CARD_NAME_ALLOW_PX,
    `最长名称 ${Math.round(Math.max(...required))}px 必须 ≤ 卡片名称可用宽 ${CARD_NAME_ALLOW_PX}px`);

  // 状态徽章等宽地板：syncStatusColumn 把「同表最宽状态盒」实测写入 --status-col，
  // 同排卡片的徽章因此左右边缘对齐（不再是一列，但同排等宽仍然成立）。
  const badges = cards.map((c) => c.querySelector('.acct-status'));
  assert.ok(badges.every(Boolean), '每张卡都要有状态徽章');
  const natural = badges.map((b) => textWidthPx(b.textContent, 14) + 22 + 2);
  assert.ok(Math.max(...natural) - Math.min(...natural) > 1,
    `状态文案自然宽必须有落差才有鉴别力（实际 ${natural.map((v) => Math.round(v)).join(', ')}）`);
  badges.forEach((b, i) => { b.scrollWidth = natural[i]; });
  assert.equal(typeof page.syncStatusColumn, 'function', 'render-cards.js 必须导出 syncStatusColumn（真机测量入口）');
  page.syncStatusColumn();
  const colRaw = shim.el('cards').style.getPropertyValue('--status-col');
  const col = parseFloat(colRaw);
  assert.ok(Number.isFinite(col) && col >= Math.max(...natural) - 1,
    `--status-col 必须容得下最宽状态徽章（实际 ${colRaw}，需要 ${Math.round(Math.max(...natural))}px）`);
});
test('B24h-1：卡片网格同行等高（grid stretch），且每张卡都有完整底部栏', async () => {
  const shim = dom(INDEX_HTML);
  const page = await runInlineScript(INDEX_HTML, shim);
  page.render(status(ROWS));

  const cards = shim.document.querySelectorAll('#cards .acct-card');
  assert.equal(cards.length, 4, '渲染出 4 张卡片');
  // 同行等高由网格拉伸承担（真机 rect 实测见 b25-narrow-overflow 的真浏览器几何断言）。
  assert.match(CSS, /\.acct-grid\{[^}]*align-items:stretch/, '网格显式 align-items:stretch');
  assert.match(INDEX_SRC, /id="cards"[^>]*\bitems-stretch\b/, '#cards 带 items-stretch 工具类');
  for (const card of cards) {
    assert.ok(card.querySelector('.acct-card-foot'), '每张卡都有底部栏（等高时底部信息落在同一基线）');
  }
  assert.equal(lineHeightOf(CSS, 'base'), 24, 'text-base 行高不变（没有为对齐而改行高）');
});
test('B24g-2：新鲜度文字不是最小字号，两主题对比度均 ≥4.5:1（按令牌计算）', async () => {
  const shim = dom(INDEX_HTML);
  const page = await runInlineScript(INDEX_HTML, shim);
  page.render(status([account({ paused: true, pausedUntil: Date.now() + 60000 })]));
  const fresh = shim.document.querySelector('#cards .card-fresh');
  assert.ok(fresh, '新鲜度行必须渲染出来');
  assert.match(fresh.className, /\btabular-nums\b/, '运行时重建的新鲜度类名必须含 tabular-nums');
  const resetBadge = shim.document.querySelector('#cards .tags .tag.badge');
  assert.ok(resetBadge, '重置徽章必须渲染出来');
  assert.match(resetBadge.className, /\btabular-nums\b/, '运行时重建的 tag badge 类名必须含 tabular-nums');
  // 防作弊：要么改回 opacity/透明度色，要么缩回最小字号，都得红。
  assert.ok(fresh.textContent.includes('额度更新于'), '文案语义不变（不回归）');

  const tokens = clsTokens(fresh);
  const textTok = tokens.find((t) => /^text-(xs|sm|base|lg|xl|2xl|4xl)$/.test(t));
  assert.ok(textTok, '新鲜度文字必须有明确字号工具类');
  const fsRem = new RegExp('--text-' + textTok.slice(5) + ':\\s*([\\d.]+)rem').exec(CSS);
  const fontPx = parseFloat(fsRem[1]) * 16;
  assert.ok(fontPx >= 14, `字号不得停留在页面最小的那档（text-xs=12px）：实际 ${fontPx}px`);

  const results = {};
  for (const theme of ['light', 'dark']) {
    const { color, source } = freshTextColor(tokens, theme);
    const bg = themeColors(theme).base100;
    results[theme] = { ratio: contrastRatio(color, bg), alpha: color.a, source };
  }
  assert.ok(results.light.ratio >= 4.5, `浅色主题对比度 ${results.light.ratio.toFixed(2)} < 4.5（源 ${results.light.source}）`);
  assert.ok(results.dark.ratio >= 4.5, `深色主题对比度 ${results.dark.ratio.toFixed(2)} < 4.5（源 ${results.dark.source}）`);
  // 不许靠 opacity / 透明度色弱化（对比度会随主题不可控）—— 有效颜色必须是纯色。
  assert.equal(results.light.alpha, 1, `不许用透明度弱化（${results.light.source} 的 alpha=${results.light.alpha}）`);
  assert.equal(results.dark.alpha, 1, `不许用透明度弱化（${results.dark.source} 的 alpha=${results.dark.alpha}）`);

  // 实现锚点：模板与脚本都得用 aux-text（AA 令牌），不得再叠加 text-base-content/NN。
  assert.match(ACCOUNT_CARD_SRC, /class="card-fresh[^"]*\baux-text\b[^"]*\btext-sm\b[^"]*"/, '模板：新鲜度 = aux-text + text-sm');
  assert.match(RENDER_CARDS_JS, /'card-fresh aux-text text-sm\b[^']*tabular-nums\b/, '脚本重建的新鲜度类名同样含 tabular-nums'),
  assert.doesNotMatch(ACCOUNT_CARD_SRC, /card-fresh[^"]*text-base-content\//, '不得再用 base-content/NN 的透明色');
});

// ── ③ 首屏装得下 4 行 ────────────────────────────────────────────────
/** 从真 CSS / 模板解析出的纵向预算（桌面单列，4 行账号卡 + 其上方所有区块）。
    模型与真机 Chromium 实测逐项对齐（1440×900：header 49 / hero 269 / kpis 86 / filters 32 /
    row 76 ×4 + gap 8 ×3 = 328 → lastRowBottom 792）。 */
function aboveFoldBudget(shim) {
  const css = CSS;
  const su = spacingUnit(css);
  const q = (sel) => shim.document.querySelector(sel);
  const main = q('main');
  const header = q('header');
  const heroCard = q('.hero-card');
  const heroBody = q('.hero-card .card-body');
  const kpis = q('#kpis');
  const filters = q('#filters');
  const cards = q('#cards');
  const summary = q('#cards summary');
  const tags = q('#cards .tags');

  const gapOf = (el, fallback) => spacingOf(css, su, el, 'gap', fallback);
  const rowGapOf = (el, fallback) => spacingOf(css, su, el, 'row-gap', fallback);

  // 头部：min-h-12（信息不减，只压高度）+ 下边框 1。
  const headerH = fixedHeightOf(css, su, header, 'min-height', 56) + 1;
  const mainTop = paddingTopOf(css, su, main, 16);
  const colGap = gapOf(main, 16);

  // Hero：卡片边框 + card-body 内边距 + 6 个子块 + 5 个行距。
  const heroPadTop = spacingOf(css, su, heroBody, 'padding-top', null);
  const heroPadBlock = heroPadTop ?? paddingBlockOf(css, su, heroBody, 24);
  const heroGap = gapOf(heroBody, 12);
  const lh = (tok) => lineHeightOf(css, tok);
  const gaugePx = arbitraryPropPx(css, q('#usage-gauge'), '--size', 80);
  const badgeH = sizeTokenPx(css, 'badge', 24);
  const btnH = sizeTokenPx(css, 'btn-sm', 32);
  const heroKids = [
    lh('xl'),                                                    // 问候语
    lh('4xl'),                                                   // 余额大字
    Math.max(gaugePx, lh('sm')),                                 // 圆环 + 构成明细
    Math.max(lh('sm'), badgeH),                                  // 网关状态行（含 badge）
    lh('xs'),                                                    // 元信息行
    1 + paddingTopOf(css, su, q('.hero-aside'), 12) + btnH,      // 分隔线 + 按钮行
  ].reduce((a, b) => a + b, 0);
  const heroH = 2 + heroPadBlock * 2 + heroKids + heroGap * 5;

  // KPI：stats 容器边框 + stat 纵向内边距 + 最高一张卡的 标题/数值/副文案 三行。
  const stat = q('#kpis .stat');
  const statPad = paddingBlockOf(css, su, stat, 16);
  const rootLh = parseFloat((/html[^{}]*\{[^}]*line-height:\s*([\d.]+)/.exec(css) || [])[1] || '1.5');
  const statTitleFs = classFontSizeRem(css, 'stat-title') ?? 0.75;
  const statContent = Math.max(...[...shim.document.querySelectorAll('#kpis .stat')].map((s) => {
    let h = 0;
    for (const kid of s.children) {
      const t = clsTokens(kid).find((x) => /^text-(xs|sm|base|lg|xl|2xl|4xl)$/.test(x));
      if (t) h += lineHeightOf(css, t.slice(5));
      else h += Math.round(statTitleFs * 16 * rootLh);   // .stat-title/.stat-desc：12px × 根行高
    }
    return h;
  }));
  const kpisH = 2 + statPad * 2 + statContent;

  // 筛选行：btn-sm 高度。
  const filtersH = sizeTokenPx(css, 'btn-sm', 32);

  // 账号行：details 边框 + collapse-title 纵向内边距 + 第一栅格行 + 行距 + 标签条（min-h-6 + mt-0.5）。
  const summaryPad = paddingBlockOf(css, su, summary, 16);
  const row1 = Math.max(lineHeightOf(css, 'base'), lineHeightOf(css, 'lg'), badgeH);
  const tagsH = fixedHeightOf(css, su, tags, 'min-height', 24) + spacingOf(css, su, tags, 'margin-top', 0);
  const rowH = 2 + summaryPad * 2 + row1 + rowGapOf(summary, 4) + tagsH;
  const cardsGap = gapOf(cards, 8);

  const rows = 4 * rowH + 3 * cardsGap;
  const above = headerH + mainTop + heroH + colGap + kpisH + colGap + filtersH + colGap;
  return { total: above + rows, above, rows, rowH, heroH, kpisH, filtersH, headerH };
}

test('B24g-3：4 张卡全在，卡片网格宽屏多列（不堆成单列长条），上方区块内边距在合理区间', async () => {
  const shim = dom(INDEX_HTML);
  const page = await runInlineScript(INDEX_HTML, shim);
  page.render(status(ROWS));

  assert.equal(shim.document.querySelectorAll('#cards .acct-card').length, 4, '4 张账号卡必须都在（不许靠删信息换高度）');
  // 上方区块（横幅 + 统计条）不吃掉整屏：横幅纵向内边距必须是「卡片级」而不是撑满一屏。
  const su = spacingUnit(CSS);
  const heroPad = paddingBlockOf(CSS, su, shim.document.querySelector('.hero-banner'), 0);
  assert.ok(heroPad > 0 && heroPad <= 48, `横幅纵向内边距必须在合理区间（实际 ${heroPad}px）`);
  // 网格列数随宽度递增：宽屏不得退化成单列长条（1/2/3/4 列）。
  assert.match(CSS, /@media\(min-width:640px\)\{\.acct-grid\{grid-template-columns:repeat\(2,/, '≥640px 两列');
  assert.match(CSS, /@media\(min-width:1200px\)\{\.acct-grid\{grid-template-columns:repeat\(3,/, '≥1200px 三列');
  assert.match(CSS, /@media\(min-width:1480px\)\{\.acct-grid\{grid-template-columns:repeat\(4,/, '≥1480px 四列');
  assert.equal(lineHeightOf(CSS, 'base'), 24, 'text-base 行高不变（字号没被缩小换高度）');
});