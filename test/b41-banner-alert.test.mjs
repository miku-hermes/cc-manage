// 批次 41：后台「注意栏」配色（浅底 + 深色字 + 左侧强调条）。
//
// 背景（用户反馈「好丑」）：panel.css 原先没有 .banner 规则，带 banner 类的提示条全部落到
// daisyUI 的实心 `alert alert-warning` / `alert alert-error` 上 —— 棕黄实心底横跨整页，
// 在樱花浅色主题上非常突兀。
//
// 本文件分两层：
//   ① 静态：不依赖浏览器，直接解析 panel/src/styles/panel.css —— 规则必须在所有 @layer 之外，
//      底色/字色必须走主题令牌；并计算浅/深两套主题下的对比度（≥ 4.5:1）。
//   ② 浏览器：用真实 Chromium 的 computed style 复核「规则在、效果也在」（daisyUI 的层叠很
//      容易把写在 layer 里的覆盖顶掉，静态解析看不出来）。无 Playwright 环境只登记一条 skip。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CSS = fs.readFileSync(path.join(ROOT, 'panel/src/styles/panel.css'), 'utf8');

// ── 颜色工具 ───────────────────────────────────────────────────────────
const hexRgb = (hex) => {
  const h = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
};
const luminance = (rgb) => {
  const lin = rgb.map((v) => v / 255).map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return lin[0] * 0.2126 + lin[1] * 0.7152 + lin[2] * 0.0722;
};
const contrast = (fg, bg) => {
  const a = luminance(fg);
  const b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
};
const parseCssRgb = (s) => {
  const m = String(s).match(/rgba?\(([^)]+)\)/);
  assert.ok(m, `需要 rgb/rgba 计算值，实得：${s}`);
  return m[1].split(',').slice(0, 3).map((x) => Math.round(Number(x.trim())));
};

/** 去掉 CSS 注释（注释里出现的「@layer」字样不能被当成真正的 at-rule）。 */
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** 去掉所有 @layer 块（含嵌套花括号），返回「layer 之外」的文本。 */
function outsideLayers(css) {
  const src = stripComments(css);
  let out = '';
  let i = 0;
  for (;;) {
    const at = src.indexOf('@layer', i);
    if (at < 0) { out += src.slice(i); return out; }
    out += src.slice(i, at);
    const open = src.indexOf('{', at);
    assert.ok(open > -1, '@layer 必须带花括号块');
    let depth = 0;
    let j = open;
    for (; j < src.length; j += 1) {
      if (src[j] === '{') depth += 1;
      else if (src[j] === '}') { depth -= 1; if (depth === 0) break; }
    }
    i = j + 1;
  }
}

/** 取某主题 :root 块里的一个颜色令牌（#rrggbb）。 */
function token(css, theme, name) {
  const block = theme === 'dark'
    ? css.match(/:root\[data-theme="dark"\]\s*\{([^}]*)\}/)?.[1]
    : css.match(/:root\s*\{([^}]*)\}/)?.[1];
  assert.ok(block, `${theme} 主题令牌块必须存在`);
  const hex = block.match(new RegExp(`${name}:\\s*(#[0-9a-f]{6})`, 'i'))?.[1];
  assert.ok(hex, `${theme} 主题必须定义 ${name}`);
  return hex;
}

/** 取 layer 之外某条选择器的声明体。 */
function outsideRule(css, selector) {
  const outside = outsideLayers(css);
  const m = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(outside);
  assert.ok(m, `${selector} 必须定义在 @layer 之外（否则会被 daisyUI utilities 层顶掉）`);
  return m[1];
}

test('B41-1：注意栏规则在 @layer 之外，且用主题令牌的浅底/深字 + 左侧强调条', () => {
  for (const sel of ['.banner.alert', '.banner.alert-warning', '.banner.alert-error']) {
    outsideRule(CSS, sel);
  }

  const warn = outsideRule(CSS, '.banner.alert-warning');
  assert.match(warn, /background:\s*var\(--warning-light\)/, 'warning 底色必须取 --warning-light（不是 daisyUI 实心 warning）');
  assert.match(warn, /color:\s*var\(--warning-ink\)/, 'warning 字色必须取主题令牌 --warning-ink');
  assert.match(warn, /border-left:\s*3px\s+solid\s+var\(--warning\)/, 'warning 左侧 3px 强调条');

  const err = outsideRule(CSS, '.banner.alert-error');
  assert.match(err, /background:\s*var\(--danger-light\)/, 'error 底色必须取 --danger-light');
  assert.match(err, /color:\s*var\(--accent-ink\)/, 'error 字色必须取 --accent-ink');
  assert.match(err, /border-left:\s*3px\s+solid\s+var\(--danger\)/, 'error 左侧 3px 强调条');

  const base = outsideRule(CSS, '.banner.alert');
  assert.match(base, /border-radius:\s*10px/, '注意栏圆角 10px');

  // 语义区分：warning 与 error 的底色在浅/深两套主题下都不能相同。
  for (const theme of ['light', 'dark']) {
    const w = token(CSS, theme, '--warning-light');
    const e = token(CSS, theme, '--danger-light');
    assert.notEqual(w, e, `${theme} 主题 warning 与 error 底色必须不同`);
  }
});

test('B41-2：浅/深两套主题下注意栏文字对底色的对比度 ≥ 4.5:1', () => {
  for (const theme of ['light', 'dark']) {
    const wBg = hexRgb(token(CSS, theme, '--warning-light'));
    const wInk = hexRgb(token(CSS, theme, '--warning-ink'));
    const eBg = hexRgb(token(CSS, theme, '--danger-light'));
    const eInk = hexRgb(token(CSS, theme, '--accent-ink'));
    const wc = contrast(wInk, wBg);
    const ec = contrast(eInk, eBg);
    assert.ok(wc >= 4.5, `${theme} 主题 warning 对比度 ${wc.toFixed(2)}:1 < 4.5:1`);
    assert.ok(ec >= 4.5, `${theme} 主题 error 对比度 ${ec.toFixed(2)}:1 < 4.5:1`);
  }
});

// ── 浏览器复核（无 Playwright 只登记一条 skip）─────────────────────────
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
function builtCss() {
  const dir = path.join(ROOT, 'panel/dist/assets');
  const file = fs.readdirSync(dir).find((f) => f.endsWith('.css'));
  return file ? fs.readFileSync(path.join(dir, file), 'utf8') : null;
}

async function runBrowserAssertions() {
  const mod = await import(findPlaywright());
  const playwright = mod.default ?? mod;
  const css = builtCss();
  assert.ok(css, 'panel/dist/assets 下必须有已构建的 CSS（先跑 scripts/panel-build.sh）');

  // 每次测量前按主题重建页面，避免 View Transition / 缓存干扰 computed style。
  const measure = async (browser, theme) => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.setContent(`<!doctype html><html${theme === 'dark' ? ' data-theme="dark"' : ''}><head><style>${css}</style></head>
<body><div class="banner alert alert-warning" id="w">需关注：有 2 个账号不可用；近 24 小时错误率 19.1%（12,140 次请求）。</div>
<div class="banner alert alert-error" id="e">请求日志写入失败</div></body></html>`);
    const data = await page.evaluate(() => {
      const read = (id) => {
        const el = document.getElementById(id);
        const cs = getComputedStyle(el);
        return { bg: cs.backgroundColor, color: cs.color, leftW: cs.borderLeftWidth };
      };
      return { warning: read('w'), error: read('e') };
    });
    await page.close();
    return data;
  };

  const browser = await playwright.chromium.launch();
  try {
    for (const theme of ['light', 'dark']) {
      const { warning, error } = await measure(browser, theme);
      const wBg = parseCssRgb(warning.bg);
      const wInk = parseCssRgb(warning.color);
      const eBg = parseCssRgb(error.bg);
      const eInk = parseCssRgb(error.color);

      // 计算背景必须落在主题令牌 --warning-light / --danger-light 上，而不是 daisyUI 的实心色。
      assert.deepEqual(wBg, hexRgb(token(CSS, theme, '--warning-light')),
        `${theme}：warning 计算背景必须是 --warning-light（不是 daisyUI 实心 warning）`);
      assert.deepEqual(eBg, hexRgb(token(CSS, theme, '--danger-light')),
        `${theme}：error 计算背景必须是 --danger-light`);
      assert.notDeepEqual(wBg, eBg, `${theme}：warning 与 error 背景不得相同`);

      const wc = contrast(wInk, wBg);
      const ec = contrast(eInk, eBg);
      assert.ok(wc >= 4.5, `${theme}：warning 实测对比度 ${wc.toFixed(2)}:1 < 4.5:1`);
      assert.ok(ec >= 4.5, `${theme}：error 实测对比度 ${ec.toFixed(2)}:1 < 4.5:1`);
      assert.equal(warning.leftW, '3px', `${theme}：warning 左侧强调条 3px`);
      assert.equal(error.leftW, '3px', `${theme}：error 左侧强调条 3px`);
    }
  } finally {
    await browser.close();
  }
}

if (findPlaywright()) {
  test('B41-3：真实 Chromium 下注意栏计算背景/文字色与对比度达标（浅/深两主题）', runBrowserAssertions);
} else {
  test('B41-3：无 Playwright 环境仅登记跳过（真实断言不注册）', (t) => {
    t.skip('本机无 Playwright（后台注意栏配色实测）');
  });
}
