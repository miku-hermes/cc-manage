// 批次 2：前端 / UI（panel/src/pages/*.astro 为主）的回归测试。
// 只读页面文件，用既有 DOM 垫片跑内联脚本，零依赖、不联网。
// 约定：这些用例在未修复的源码上必须变红（mutation check）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createDomShim, runInlineScript, styleText } from './helpers.mjs';

const INDEX_HTML = fs.readFileSync(new URL('../panel/dist/index.html', import.meta.url), 'utf8');
// B24：admin 的样式/结构断言要在构建产物上做（.astro 源码含 frontmatter，取不到内联 <style>）。
const ADMIN_HTML = fs.readFileSync(new URL('../panel/dist/admin.html', import.meta.url), 'utf8');
const delay = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

function dom(html, fetchImpl) {
  return createDomShim({ html, fetchImpl: fetchImpl ?? (async () => ({ ok: true, status: 200, json: async () => ({}) })) });
}

function quota(remaining = 9.9, overrides = {}) {
  return {
    ok: true, displayName: '显示名', plan: null, remaining,
    credits: { monthlyCredits: 2, purchasedCredits: 1, freeCredits: 0.5 },
    fiveHour: { used: 0, cap: 3, percent: 0, usedRatio: 0, resetAt: 0 },
    weekly: { used: 0, cap: 6, percent: 0, usedRatio: 0, resetAt: 0 },
    monthly: { used: 0, cap: 10, percent: 0, usedRatio: 0, resetAt: 0 },
    usage: { totalTokens: 12, totalCost: 1 }, percent: {}, fetchedAt: Date.now(),
    ...overrides,
  };
}

function account(overrides = {}) {
  return {
    keyId: '12345678', keyPrefix: 'user_2XyP', name: '测试号', enabled: true, available: true,
    creditsExhausted: false, exhausted: null, concurrency: 0, paused: false, pausedUntil: null,
    rateLimited: false, rateLimitedUntil: null, authInvalid: false, lastError: null, lastQuota: quota(),
    ...overrides,
  };
}

function adminAccounts(page, accounts) {
  vm.runInContext(`state.accounts = ${JSON.stringify(accounts)}; renderAccounts();`, page);
}

// ── 静态 CSS 工具（styleText：内联 <style> + 外链 css 合并，见 helpers.mjs）──
function braceBlock(css, start) {
  const open = css.indexOf('{', start);
  assert.ok(open >= 0, '找到 {');
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  throw new Error('花括号不配平');
}
function mediaBlocks(css, query) {
  const blocks = [];
  const re = /@media[^{]*\{/g;
  let m;
  while ((m = re.exec(css))) {
    const header = m[0].slice(0, -1).replace(/\s+/g, ' ').trim();
    if (header.includes(query)) blocks.push(braceBlock(css, m.index));
  }
  return blocks;
}

// ── 1：登出 / 401 弹窗级敏感数据残留 ────────────────────────────────
test('B2-1：登出清空一次性 key / 粘贴的 CC key / 密码框并关掉所有弹窗', async () => {
  const shim = dom(ADMIN_HTML, async (url) => {
    if (url === '/api/auth/me') return { ok: true, status: 200, json: async () => ({ authenticated: true, user: { username: 'admin' } }) };
    if (url === '/api/admin/keys') return { ok: true, status: 200, json: async () => ({ plaintext: 'sk-cg-PLAINTEXT-SECRET', warning: '' }) };
    if (url === '/api/auth/logout') return { ok: true, status: 200, json: async () => ({ ok: true }) };
    if (url.startsWith('/api/admin/accounts')) return { ok: true, status: 200, json: async () => ({ accounts: [], tests: [], writable: true }) };
    return { ok: true, status: 200, json: async () => ({}) };
  });
  const page = await runInlineScript(ADMIN_HTML, shim);

  // 生成 key：mock 回明文 → #k-plain 非空、弹窗 open
  // 批次 3 后 #add-key 走 document 级事件委托，测试也按委托路径派发。
  shim.document.dispatchEvent({ type: 'click', target: shim.el('add-key') });
  assert.equal(shim.el('m-newkey').classList.contains('open'), true, '打开生成弹窗后应有 .open');
  await shim.el('k-submit').onclick();
  assert.match(shim.el('k-plain').textContent, /sk-cg-PLAINTEXT-SECRET/, '生成后 #k-plain 应有明文');

  // 同时塞满其它敏感输入 + 多开几个弹窗
  vm.runInContext(`$('a-key').value = 'user_secret_key';
    $('u-pass').value = 'pass-1'; $('p-pass').value = 'pass-2'; $('p-current').value = 'pass-3';
    $('r-name').value = 'secret-name'; $('k-name').value = 'client-name';
    openModal('m-account'); openModal('m-pass');`, page);
  assert.ok(shim.document.querySelectorAll('.modal.open').length >= 1, '登出前确有弹窗打开');

  // 批次 3 后 #logout 走 document 级事件委托。
  shim.document.dispatchEvent({ type: 'click', target: shim.el('logout') });
  await delay(0);

  assert.equal(shim.el('k-plain').textContent, '', '#k-plain 明文必须清空');
  assert.equal(shim.el('k-result').classList.contains('hidden'), true, '#k-result 复位为隐藏');
  assert.equal(shim.el('k-form').classList.contains('hidden'), false, '#k-form 复位为显示');
  for (const id of ['a-key', 'u-pass', 'p-pass', 'p-current', 'r-name', 'k-name']) {
    assert.equal(shim.el(id).value, '', `#${id} 必须清空`);
  }
  assert.equal(vm.runInContext('renameTarget === null && passTarget === null', page), true, 'renameTarget/passTarget 归零');
  assert.equal(shim.document.querySelectorAll('.modal.open').length, 0, '不得有弹窗留在打开状态（否则盖住登录页）');
});

test('B2-1：弹窗开着时 session 401 掉落，同样清空并关弹窗', async () => {
  const shim = dom(ADMIN_HTML, async (url) => {
    if (url === '/api/auth/me') return { ok: true, status: 200, json: async () => ({ authenticated: true, user: { username: 'admin' } }) };
    if (url.startsWith('/api/admin/accounts')) return { ok: false, status: 401, json: async () => ({ error: { message: 'unauthorized' } }) };
    return { ok: true, status: 200, json: async () => ({}) };
  });
  const page = await runInlineScript(ADMIN_HTML, shim);
  await delay(0);

  shim.document.dispatchEvent({ type: 'click', target: shim.el('add-key') });
  vm.runInContext(`$('k-plain').textContent = 'sk-cg-LEAKED';
    $('a-key').value = 'user_leak'; $('u-pass').value = 'pw'; $('p-pass').value = 'pw'; $('p-current').value = 'pw';
    $('r-name').value = 'leak'; $('k-name').value = 'leak'; openModal('m-account');`, page);
  assert.match(shim.el('k-plain').textContent, /LEAKED/);

  await assert.rejects(() => page.loadAccounts(), /unauthorized/);

  assert.equal(shim.el('k-plain').textContent, '', '401 掉落也要清 #k-plain');
  assert.equal(shim.el('a-key').value, '', '401 掉落也要清粘贴的 CC key');
  assert.equal(shim.document.querySelectorAll('.modal.open').length, 0, '401 掉落不得留弹窗');
});

// ── 2：rateLimited 冷却文案 ────────────────────────────────────────
test('B2-2：rateLimited 前台 statusText 冷却中 warn，且卡片显示冷却剩余时间', async () => {
  const shim = dom(INDEX_HTML);
  const page = await runInlineScript(INDEX_HTML, shim);
  const a = account({ available: false, rateLimited: true, rateLimitedUntil: Date.now() + 60000, exhausted: null });

  const st = page.statusText(a);
  assert.equal(st.t, '冷却中');
  assert.equal(st.tone, 'warn');
  const out = page.card(a);
  assert.match(out, /冷却中/);
  assert.match(out, /限流冷却中 · 剩 \d+ (秒|分钟)/, '前端要显示冷却剩余时间');
});

test('B2-2：后台 statusTag 对 rateLimited 不套「额度不可用」，显示「限流冷却中」', async () => {
  const shim = dom(ADMIN_HTML);
  const page = await runInlineScript(ADMIN_HTML, shim);
  const a = account({ available: false, rateLimited: true, rateLimitedUntil: Date.now() + 60000, exhausted: null });
  const html = page.statusTag(a);
  assert.doesNotMatch(html, /额度不可用/, '限流冷却不是额度语义');
  assert.match(html, /限流冷却中/);
});

// ── 3：状态判序（耗尽优先于冷却）───────────────────────────────────
test('B2-3：周额度用完 + 冷却 → 状态取「周额度已用完」，卡片不含「冷却中」', async () => {
  const frontShim = dom(INDEX_HTML);
  const front = await runInlineScript(INDEX_HTML, frontShim);
  const adminShim = dom(ADMIN_HTML);
  const admin = await runInlineScript(ADMIN_HTML, adminShim);

  const resetAt = Math.floor((Date.now() + 3 * 86400e3) / 1000);
  const a = account({
    available: false, paused: true, pausedUntil: Date.now() + 3 * 86400e3,
    exhausted: { kind: 'window', window: 'weekly', label: '周额度已用完', resetAt },
  });

  const st = front.statusText(a);
  assert.equal(st.t, '周额度已用完', '耗尽必须优先于冷却');
  assert.equal(st.dot, 'invalid', '耗尽点用 invalid 色');
  const out = front.card(a);
  assert.match(out, /周额度已用完/);
  assert.doesNotMatch(out, /冷却中/, '同卡不得再出现「冷却中」');

  const dh = admin.statusTag(a);
  assert.match(dh, /周额度已用完/);
  assert.doesNotMatch(dh, /冷却中/);
});

// ── 4：后台补 reset 时间与额度构成 ────────────────────────────────
test('B2-4：后台额度列渲染重置时间与月度/购买/赠送', async () => {
  const shim = dom(ADMIN_HTML);
  const page = await runInlineScript(ADMIN_HTML, shim);
  const nowSec = Math.floor(Date.now() / 1000);
  const q = quota(9.9, {
    fiveHour: { used: 1, cap: 3, percent: 33, resetAt: nowSec + 3600 },
    weekly: { used: 1, cap: 6, percent: 17, resetAt: nowSec + 86400 },
  });
  adminAccounts(page, [account({ lastQuota: q })]);

  const out = shim.el('accounts').innerHTML;
  assert.match(out, /重置 \d{1,2}\/\d{1,2} \d{2}:\d{2}/, '要有「重置 M/D HH:MM」');
  assert.match(out, /月度 2\.00 · 购买 1\.00 · 赠送 0\.50/, '要有月度/购买/赠送三项');
});

test('B2-4：后台状态列补 exhausted.resetAt', async () => {
  const shim = dom(ADMIN_HTML);
  const page = await runInlineScript(ADMIN_HTML, shim);
  const resetAt = Math.floor((Date.now() + 2 * 86400e3) / 1000);
  adminAccounts(page, [account({ available: false, exhausted: { kind: 'window', window: 'weekly', label: '周额度已用完', resetAt } })]);
  const out = shim.el('accounts').innerHTML;
  assert.match(out, /周额度已用完/);
  assert.match(out, /\d{1,2}\/\d{1,2} \d{2}:\d{2} 重置/, '状态列的时间格式为 M/D HH:MM 重置');
});

// ── 5：手机端滚动位置不被 5s 刷新清空 ─────────────────────────────
test('B2-5：renderCards 重建后按 keyId 回填每个账号 .tags 的 scrollLeft', async () => {
  const shim = dom(INDEX_HTML);
  const page = await runInlineScript(INDEX_HTML, shim);
  const d = {
    now: Date.now(), quotaPoll: {},
    summary: { accounts: 2, available: 2, paused: 0, unavailable: 0, concurrency: 0 },
    stats: { total: 0, errors: 0, clientErrors: 0, totalTokens: 0 },
    accounts: [account({ keyId: 'aaaa1111', name: '甲' }), account({ keyId: 'bbbb2222', name: '乙' })],
  };
  page.render(d);
  const before = shim.document.querySelectorAll('#cards .tags[data-key-id]');
  assert.equal(before.length, 2, '每个账号要带 data-key-id 的 .tags');
  before[0].scrollLeft = 100;

  page.render(d);   // 5s 刷新：同样的数据再渲染一次

  const after = shim.document.querySelectorAll('#cards .tags[data-key-id]');
  assert.equal(after.length, 2);
  assert.equal(after[0].scrollLeft, 100, 'scrollLeft 必须被回填，不能每 5s 归零');
});

// ── 6：暂停至跨天要带日期 ──────────────────────────────────────────
test('B2-6：暂停至显示 M/D HH:MM，而不是裸 HH:MM:SS', async () => {
  const shim = dom(INDEX_HTML);
  const page = await runInlineScript(INDEX_HTML, shim);
  const out = page.card(account({ available: false, paused: true, pausedUntil: Date.now() + 3 * 86400e3 }));
  assert.match(out, /暂停至 \d{1,2}\/\d{1,2} \d{2}:\d{2}/);
  assert.doesNotMatch(out, /暂停至 \d{2}:\d{2}:\d{2}/, '不得再只给时分秒（会被读成今天）');
});

// ── 7：过期 resetAt 不出现「（还有 即将重置）」病句 ────────────────
test('B2-7：过期 resetAt 不再拼出「还有 即将重置」', async () => {
  const shim = dom(INDEX_HTML);
  const page = await runInlineScript(INDEX_HTML, shim);
  const past = Math.floor((Date.now() - 120000) / 1000);
  const txt = page.resetText({ resetAt: past });
  assert.doesNotMatch(txt, /还有 即将重置/);
  assert.match(txt, /窗口已重置/);

  const out = page.card(account({ exhausted: { kind: 'window', window: 'weekly', label: '周额度已用完', resetAt: past } }));
  assert.doesNotMatch(out, /还有 即将重置/);
  assert.match(out, /周额度已用完/);
});

// ── 8：无快照不显示 0.00，也不计入 hero 合计 ──────────────────────
test('B2-8：无快照账号卡片显示 —，hero 合计排除并注明未同步数', async () => {
  const shim = dom(INDEX_HTML);
  const page = await runInlineScript(INDEX_HTML, shim);
  const withQ = account({ keyId: 'aaaa1111', lastQuota: quota(4) });
  const noQ = account({ keyId: 'bbbb2222', name: '无快照', lastQuota: null });

  assert.equal(page.usableRemaining(noQ), null, '无快照 → null，不当 0');
  const out = page.card(noQ);
  // B24：余额是 <b class="usable-balance …">；标签「剩余额度」已上移到 Hero 大数字旁，不重复。
  assert.doesNotMatch(out, /class="usable-balance[^"]*">0\.00</, '卡片不得显示 0.00');
  assert.match(out, /<b class="usable-balance[^"]*">—<\/b>/, '无快照余额显示 —（不是 0.00）');

  page.render({
    now: Date.now(), quotaPoll: {},
    summary: { accounts: 2, available: 2, paused: 0, unavailable: 0, concurrency: 0 },
    stats: { total: 0, errors: 0, clientErrors: 0, totalTokens: 0 },
    accounts: [withQ, noQ],
  });
  assert.equal(shim.el('balance').textContent, '4.00', '未同步账号不参与合计');
  assert.match(shim.el('bal-label').textContent, /含 1 个未同步账号/);
});

// ── 9：hero 前缀不再写死「网关运行中」──────────────────────────────
test('B2-9：加载失败 / 隐私模式下 hero 段落不含「运行中」', async () => {
  assert.doesNotMatch(INDEX_HTML, /网关运行中/, '静态前缀不得写死「网关运行中」');
  const shim = dom(INDEX_HTML, async (url) => (url === '/api/status'
    ? { ok: false, status: 500, json: async () => ({}) }
    : { ok: true, status: 200, json: async () => ({}) }));
  const page = await runInlineScript(INDEX_HTML, shim);
  await page.load();
  assert.match(shim.el('health').textContent, /加载失败：HTTP 500/);
  assert.doesNotMatch(shim.document.querySelector('.hero-sub').textContent, /运行中/);

  page.showPrivate();
  assert.doesNotMatch(shim.document.querySelector('.hero-sub').textContent, /运行中/);
});

// ── 10：lastQuota=null 要显示 lastError ────────────────────────────
test('B2-10：后台 lastQuota=null + lastError → 显示真实原因', async () => {
  const shim = dom(ADMIN_HTML);
  const page = await runInlineScript(ADMIN_HTML, shim);
  adminAccounts(page, [account({ lastQuota: null, lastError: 'HTTP 401' })]);
  const out = shim.el('accounts').innerHTML;
  assert.match(out, /额度未同步：HTTP 401/);
  assert.doesNotMatch(out, /尚未获取额度快照/, '有 lastError 就不能只说「尚未获取」');
});

// ── 11 / 12：手机端运行日志 + 触控目标 ────────────────────────────
// B24 改写：事件行改用 Tailwind 工具类，且行结构由 admin.astro 的 <template id="tpl-event"> 承载
//（logs.js 只做克隆 + 填值，不再手拼 HTML）。
// 原来查：admin.css 里 `.event{flex-wrap:wrap}` 与 `.event-msg{flex…}`，外加 logs.js 的类名字符串；
// 现在查同一行为的两个来源：构建页面里的模板类名（ADMIN_HTML） + 构建 CSS（≤820px 块 flex-basis:100%）。
// 等价性：类名一字未改、断点行为一致，只是从「JS 源码里的字符串」变成了「页面模板里的标记」。严格度不变。
test('B2-11：≤820px 运行日志正文可换行，不再被挤到 ~80px', () => {
  const css = styleText(ADMIN_HTML).replace(/\/\*[\s\S]*?\*\//g, '');
  const mobile = mediaBlocks(css, 'not all and (min-width:820px)').join('\n')
    || mediaBlocks(css, 'max-width: 820px').join('\n');
  assert.ok(mobile, '存在 ≤820px 断点块');
  assert.match(mobile, /flex-basis:\s*100%/, '窄屏日志正文独占一行（basis-full）');
  assert.match(ADMIN_HTML, /class="event flex flex-wrap items-center gap-2"/, '窄屏 .event 要允许换行');
  assert.match(ADMIN_HTML, /class="event-msg min-w-0 flex-1 max-\[820px\]:basis-full"/, '窄屏 .event-msg 要独占一行');
});

// B24 改写：触控高度改用 Tailwind `max-[820px]:min-h-9`（36px，--spacing:.25rem）。
// 原来查：admin.css ≤820px 块里 `.load-error .btn, .filter-select { height: ≥34px }`；
// 现在查：两个控件都带 min-h-9 工具类，且构建 CSS 的 ≤820px 块里确实产出 min-height ≥34px。
test('B2-12：≤820px 加载重试按钮 / 级别下拉触控高度 ≥34px', () => {
  const css = styleText(ADMIN_HTML).replace(/\/\*[\s\S]*?\*\//g, '');
  const mobile = mediaBlocks(css, 'not all and (min-width:820px)').join('\n')
    || mediaBlocks(css, 'max-width: 820px').join('\n');
  const m = /min-height:\s*calc\(var\(--spacing\)\s*\*\s*([\d.]+)\)/.exec(mobile);
  assert.ok(m, '窄屏块内要有触控高度覆盖（min-h-*）');
  const px = Number(m[1]) * 4;   // --spacing = .25rem = 4px
  assert.ok(px >= 34, `高度必须 ≥34px，实得 ${px}`);
  assert.match(ADMIN_HTML, /id="load-retry"/, '重试按钮存在');
  assert.match(ADMIN_HTML, /max-\[820px\]:min-h-9[^>]*id="load-retry"|id="load-retry"[^>]*max-\[820px\]:min-h-9/, '重试按钮带窄屏触控高度');
  assert.match(ADMIN_HTML, /id="level"[^>]*class="select[^"]*max-\[820px\]:min-h-9[^"]*"/, '级别下拉带窄屏触控高度');
});

// ── 13：手动主题切换更新 color-scheme ─────────────────────────────
test('B2-13：两页都有按 data-theme 分派的 color-scheme', () => {
  for (const [name, html] of [['index', INDEX_HTML], ['admin', ADMIN_HTML]]) {
    const css = styleText(html);
    assert.match(css, /:root\[data-theme="light"\]\s*\{[^}]*color-scheme:\s*light/, `${name} 亮色 color-scheme`);
    assert.match(css, /:root\[data-theme="dark"\]\s*\{[^}]*color-scheme:\s*dark/, `${name} 暗色 color-scheme`);
  }
});

// ── 14（前端，B23 改写）：账号口径合并到 Hero，KPI 不再重复列账号卡 ──
test('B2-14：账号口径只在 Hero（可用 N / M），KPI 侧不再有账号卡', async () => {
  const shim = dom(INDEX_HTML);
  const page = await runInlineScript(INDEX_HTML, shim);
  page.render({
    now: Date.now(), quotaPoll: {},
    summary: { accounts: 3, available: 2, paused: 0, unavailable: 1, concurrency: 0 },
    stats: { total: 0, errors: 0, clientErrors: 0, totalTokens: 0 },
    accounts: [account(), account({ keyId: 'aaaa1111' }), account({ keyId: 'bbbb2222' })],
  });
  assert.equal(shim.el('health').textContent, '可用 2 / 3', '「可用 3/4」是唯一账号口径表达');
  for (const id of ['kpi-box-accounts', 'kpi-box-available', 'kpi-box-unavailable']) {
    assert.equal(shim.el(id), null, `${id} 必须删除（与 Hero 重复的派生卡）`);
  }
});

// ── 15：弹窗可访问性 ──────────────────────────────────────────────
test('B2-15：Esc 关闭弹窗并把焦点还给触发元素；主区有隐藏 h1', async () => {
  const shim = dom(ADMIN_HTML);
  const page = await runInlineScript(ADMIN_HTML, shim);
  const btn = shim.el('add-account');
  btn.focus();
  vm.runInContext("openModal('m-account');", page);
  assert.equal(shim.el('m-account').classList.contains('open'), true);

  shim.document.dispatchEvent({ type: 'keydown', key: 'Escape' });
  assert.equal(shim.el('m-account').classList.contains('open'), false, 'Esc 必须关闭弹窗');
  assert.equal(shim.document.activeElement, btn, '关闭后焦点归还触发元素');

  assert.match(ADMIN_HTML, /<h1 class="sr-only">后台管理<\/h1>/);
  assert.match(styleText(ADMIN_HTML), /\.sr-only\s*\{/);
});

// ── 16：进度条金额进 aria-label ───────────────────────────────────
test('B2-16：.bar-group 带 aria-label（同 title 文案）', async () => {
  const shim = dom(INDEX_HTML);
  const page = await runInlineScript(INDEX_HTML, shim);
  // B23：进度条不再由 JS 拼字符串，改从账号卡模板克隆 → 用卡片序列化结果取 bar-group。
  const out = page.card(account({
    lastQuota: quota(9.9, { weekly: { used: 1, cap: 2, percent: 50, resetAt: 0 } }),
  }));
  // 断言改成「属性顺序无关、逐属性核对同一个起始标签」：HTML 属性顺序没有语义，
  // 旧正则把 class→title→aria-label→> 的书写顺序钉死，任何在中间插入属性的合法改动
  // （如本批次为让 aria-label 真正进无障碍树而补的 role="group"）都会被误判为失败 ——
  // 那是测试在断言实现细节而非行为。新写法不依赖顺序，且仍要求 class / title /
  // aria-label / role 四项同时落在同一个 .bar-group 标签内，因此是更强而非更弱的断言。
  // B24：bar-group 现在同时挂 Tailwind 工具类（class="bar-group space-y-1"），选择器放宽为前缀匹配。
  const groups = (out.match(/<div class="bar-group[^"]*"[^>]*>/g) || []).filter((g) => g.includes('本周窗口'));
  assert.equal(groups.length, 1, '恰好一个「本周窗口」.bar-group 起始标签');
  const tag = groups[0];
  assert.match(tag, /class="bar-group[^"]*"/, '保留 bar-group 类');
  assert.match(tag, /title="本周窗口：已用 1\.00 \/ 2\.00"/, '金额进 title（鼠标悬停可见）');
  assert.match(tag, /aria-label="本周窗口：已用 1\.00 \/ 2\.00"/, '金额同步进 aria-label（触屏/键盘可达）');
  assert.match(tag, /role="group"/, 'aria-label 需要 role 才进无障碍树（role=generic 禁止 aria-label）');
});

// ── 17：标签条渐隐由状态类控制 ────────────────────────────────────
// B24 改写：渐隐遮罩改由 Tailwind @utility（mask-fade-x / mask-fade-x-none）+ 状态变体承担。
// 原来查：components.css ≤640px 块里 `.tags.…at-end { mask-image:none }`；现在查同一行为来自
//   构建 CSS 的 ≤640px 块（is-scrollable 加遮罩 / at-end 撤遮罩）。选择器不再钉死 .tags 链，更稳。
test('B2-17：≤640px 标签条 mask 由 .is-scrollable/.at-end 状态类控制', () => {
  const css = styleText(INDEX_HTML).replace(/\/\*[\s\S]*?\*\//g, '');
  const mobile = mediaBlocks(css, 'max-width: 640px').join('\n')
    || mediaBlocks(css, '40rem').join('\n');
  assert.ok(mobile, '存在 ≤640px 断点块');
  assert.match(mobile, /at-end[^{]*\{[^}]*mask-image:\s*none/, '滚到底要撤掉渐隐');
  assert.match(mobile, /is-scrollable[^{]*\{[^}]*mask-image:\s*linear-gradient/, '溢出时给渐隐遮罩');
  assert.match(INDEX_HTML, /classList\.toggle\('is-scrollable'/, 'JS 要维护 is-scrollable');
  assert.match(INDEX_HTML, /classList\.toggle\('at-end'/, 'JS 要维护 at-end');
});

// ── 18（前端）：KPI 口径 ──────────────────────────────────────────
test('B2-18：前台「上游错误数」只显示 stats.errors（客户端 4xx 另计）', async () => {
  const shim = dom(INDEX_HTML);
  const page = await runInlineScript(INDEX_HTML, shim);
  page.render({
    now: Date.now(), quotaPoll: {},
    summary: { accounts: 1, available: 1, paused: 0, unavailable: 0, concurrency: 0 },
    stats: { total: 5, errors: 1, clientErrors: 4, totalTokens: 0 },
    accounts: [account()],
  });
  assert.equal(shim.el('kpi-errors').textContent, '1');
  // 标签文案在 render-hero.js 的 KPI 定义里（结构在 KpiCard.astro）。
  const heroJs = fs.readFileSync(new URL('../panel/public/js/render-hero.js', import.meta.url), 'utf8');
  assert.match(heroJs, /label: '上游错误数'/);
});

// ── 19：隐私模式下搜索不覆盖登录提示 ─────────────────────────────
test('B2-19：隐私模式搜索不会把「请先登录后台」覆盖成「账号池为空」', async () => {
  const shim = dom(INDEX_HTML, async (url) => (url === '/api/status'
    ? { ok: false, status: 401, json: async () => ({}) }
    : { ok: true, status: 200, json: async () => ({}) }));
  const page = await runInlineScript(INDEX_HTML, shim);
  await page.load();
  assert.match(shim.el('cards').innerHTML, /请先/, '401 → 隐私模式提示');

  shim.el('search').value = 'abc';
  shim.document.dispatchEvent({ type: 'input', target: shim.el('search') });
  assert.match(shim.el('cards').innerHTML, /请先/, '搜索后提示仍在');
  assert.doesNotMatch(shim.el('cards').innerHTML, /账号池为空/);
});

// ── 20 / 21：只读模式 users 置灰 + 垫片选择器 ────────────────────
test('B2-20：只读模式下 users 表按钮被置灰（两个分支都 applyWritable）', async () => {
  const shim = dom(ADMIN_HTML);
  const page = await runInlineScript(ADMIN_HTML, shim);
  vm.runInContext(`state.writable = false; state.readonlyReason = '只读';
    state.users = [{ username: 'a', createdAt: 1 }, { username: 'b', createdAt: 2 }]; renderUsers();`, page);
  const btns = shim.document.querySelectorAll('#users .actions button');
  assert.ok(btns.length >= 1, '垫片必须能匹配 #users .actions button');
  for (const b of btns) assert.equal(b.disabled, true, '只读时 users 操作按钮必须 disabled');

  vm.runInContext("state.users = []; renderUsers();", page);
  assert.equal(shim.el('add-user').disabled, true, '空表分支也要 applyWritable');
});

test('B2-21：垫片最小选择器匹配可用，getElementById 不再现造节点', async () => {
  const shim = dom(ADMIN_HTML);
  const page = await runInlineScript(ADMIN_HTML, shim);
  assert.equal(shim.document.getElementById('no-such-id-xyz'), null, '不存在的 id 不得现造节点');
  assert.ok(shim.document.querySelectorAll('.modal').length >= 4, '.cls 选择器要能命中');
  assert.ok(shim.document.querySelectorAll('#accounts .actions button').length === 0, '组合选择器要在空表时得 0');
  vm.runInContext("state.accounts = [" + JSON.stringify(account()) + "]; renderAccounts();", page);
  assert.ok(shim.document.querySelectorAll('#accounts .actions button').length >= 1, '#id .cls tag 组合要命中');
});

// ── 19（B24 新增交互）：账号行折叠展开必须同步 aria-expanded ──────────
// 新交互是把卡片做成 daisyUI collapse（原生 <details>）：默认摘要、点行展开明细。
// 原生 <details> 只暴露 open 状态，读屏用户需要 aria-expanded；模板初始 false，展开/收起由
// index.astro 的 document 级 toggle 监听同步。这条守护保证该 a11y 契约不丢。
test('B24-1：账号行 <details> 展开/收起同步 summary 的 aria-expanded', async () => {
  const shim = dom(INDEX_HTML);
  const page = await runInlineScript(INDEX_HTML, shim);
  page.render({
    now: Date.now(), quotaPoll: {},
    summary: { accounts: 1, available: 1, paused: 0, unavailable: 0, concurrency: 0 },
    stats: { total: 0, errors: 0, clientErrors: 0, totalTokens: 0 },
    accounts: [account()],
  });
  const details = shim.el('cards').querySelector('details');
  assert.ok(details, '账号行是 <details> 折叠（默认摘要 + 点开明细）');
  const summary = details.querySelector('summary');
  assert.ok(summary, '<details> 有 <summary>');
  assert.equal(summary.getAttribute('aria-expanded'), 'false', '默认收起：aria-expanded=false');

  // 浏览器展开 <details> 会置 open 并派发 toggle；这里模拟同一路径。
  details.setAttribute('open', '');
  shim.document.dispatchEvent({ type: 'toggle', target: details });
  assert.equal(summary.getAttribute('aria-expanded'), 'true', '展开后 aria-expanded=true');

  details.removeAttribute('open');
  shim.document.dispatchEvent({ type: 'toggle', target: details });
  assert.equal(summary.getAttribute('aria-expanded'), 'false', '收起后回到 false');
});
