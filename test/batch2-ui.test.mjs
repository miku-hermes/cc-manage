// 批次 2：前端 / UI（public/*.html 为主）的回归测试。
// 只读页面文件，用既有 DOM 垫片跑内联脚本，零依赖、不联网。
// 约定：这些用例在未修复的源码上必须变红（mutation check）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createDomShim, runInlineScript, styleText } from './helpers.mjs';

const INDEX_HTML = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const ADMIN_HTML = fs.readFileSync(new URL('../public/admin.html', import.meta.url), 'utf8');
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
  vm.runInContext("$('add-key').onclick();", page);
  assert.equal(shim.el('m-newkey').classList.contains('open'), true, '打开生成弹窗后应有 .open');
  await shim.el('k-submit').onclick();
  assert.match(shim.el('k-plain').textContent, /sk-cg-PLAINTEXT-SECRET/, '生成后 #k-plain 应有明文');

  // 同时塞满其它敏感输入 + 多开几个弹窗
  vm.runInContext(`$('a-key').value = 'user_secret_key';
    $('u-pass').value = 'pass-1'; $('p-pass').value = 'pass-2'; $('p-current').value = 'pass-3';
    $('r-name').value = 'secret-name'; $('k-name').value = 'client-name';
    openModal('m-account'); openModal('m-pass');`, page);
  assert.ok(shim.document.querySelectorAll('.modal.open').length >= 1, '登出前确有弹窗打开');

  await shim.el('logout').onclick();

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

  vm.runInContext(`$('add-key').onclick(); $('k-plain').textContent = 'sk-cg-LEAKED';
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
  assert.doesNotMatch(out, /<b>0\.00<\/b>/, '卡片不得显示 0.00');
  assert.match(out, /<b>—<\/b><small>剩余额度<\/small>/);

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
test('B2-11：≤820px 运行日志正文可换行，不再被挤到 ~80px', () => {
  const css = styleText(ADMIN_HTML).replace(/\/\*[\s\S]*?\*\//g, '');
  const mobile = mediaBlocks(css, 'max-width: 820px').join('\n');
  assert.ok(mobile, '存在 @media (max-width: 820px) 块');
  assert.match(mobile, /\.event\s*\{[^}]*flex-wrap:\s*wrap/, '窄屏 .event 要允许换行');
  assert.match(mobile, /\.event-msg\s*\{[^}]*flex/, '窄屏 .event-msg 要独占一行');
});

test('B2-12：≤820px .load-error .btn / .filter-select 触控高度 ≥34px', () => {
  const css = styleText(ADMIN_HTML).replace(/\/\*[\s\S]*?\*\//g, '');
  const mobile = mediaBlocks(css, 'max-width: 820px').join('\n');
  const m = /\.load-error \.btn\s*,\s*\.filter-select\s*\{([^}]*)\}/.exec(mobile);
  assert.ok(m, '窄屏块内要有这两个选择器的高度覆盖');
  const hm = /height:\s*(\d+)px/.exec(m[1]);
  assert.ok(hm && Number(hm[1]) >= 34, `高度必须 ≥34px，实得 ${hm && hm[1]}`);
});

// ── 13：手动主题切换更新 color-scheme ─────────────────────────────
test('B2-13：两页都有按 data-theme 分派的 color-scheme', () => {
  for (const [name, html] of [['index', INDEX_HTML], ['admin', ADMIN_HTML]]) {
    const css = styleText(html);
    assert.match(css, /:root\[data-theme="light"\]\s*\{[^}]*color-scheme:\s*light/, `${name} 亮色 color-scheme`);
    assert.match(css, /:root\[data-theme="dark"\]\s*\{[^}]*color-scheme:\s*dark/, `${name} 暗色 color-scheme`);
  }
});

// ── 14（前端）：新增「不可用」KPI ─────────────────────────────────
test('B2-14：前台「不可用」KPI 显示 summary.unavailable', async () => {
  const shim = dom(INDEX_HTML);
  const page = await runInlineScript(INDEX_HTML, shim);
  page.render({
    now: Date.now(), quotaPoll: {},
    summary: { accounts: 3, available: 2, paused: 0, unavailable: 1, concurrency: 0 },
    stats: { total: 0, errors: 0, clientErrors: 0, totalTokens: 0 },
    accounts: [account(), account({ keyId: 'aaaa1111' }), account({ keyId: 'bbbb2222' })],
  });
  assert.equal(shim.el('kpi-unavailable').textContent, '1');
  assert.match(INDEX_HTML, /id="kpi-box-unavailable"/);
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
  const out = page.bar('本周窗口', { used: 1, cap: 2, percent: 50, resetAt: 0 }, {});
  assert.match(out, /<div class="bar-group" title="本周窗口：已用 1\.00 \/ 2\.00" aria-label="本周窗口：已用 1\.00 \/ 2\.00">/);
});

// ── 17：标签条渐隐由状态类控制 ────────────────────────────────────
test('B2-17：≤640px 标签条 mask 由 .is-scrollable/.at-end 状态类控制', () => {
  const css = styleText(INDEX_HTML).replace(/\/\*[\s\S]*?\*\//g, '');
  const mobile = mediaBlocks(css, 'max-width: 640px').join('\n');
  assert.match(mobile, /\.tags[^{]*at-end[^{]*\{[^}]*mask-image:\s*none/, '滚到底要撤掉渐隐');
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
  assert.match(INDEX_HTML, /上游错误数/);
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
  shim.el('search').dispatchEvent({ type: 'input', target: shim.el('search') });
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
