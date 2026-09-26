// B 组前端回归：只读 panel/src/pages/{index,admin}.astro，不依赖后端。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createDomShim, runInlineScript, styleText } from './helpers.mjs';

const INDEX_HTML = fs.readFileSync(new URL('../panel/dist/index.html', import.meta.url), 'utf8');
// B24：admin 的内联样式只在构建产物里（.astro 源码无 <style>）；运行时行为两个来源都可用。
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
    rateLimited: false, authInvalid: false, lastError: null, lastQuota: quota(),
    ...overrides,
  };
}

function adminAccounts(page, accounts) {
  vm.runInContext(`state.accounts = ${JSON.stringify(accounts)}; renderAccounts();`, page);
}

// ── bug 1：初始化取数失败必须显示可恢复错误条，boot/loadAll 不漏 rejection ──
test('回归#2：boot/loadAll 取数失败显示可恢复错误条且不产生 unhandled rejection', async () => {
  const unhandled = [];
  const onUnhandled = (e) => unhandled.push(e);
  process.on('unhandledRejection', onUnhandled);
  try {
    const shim = dom(ADMIN_HTML, async (url) => {
      if (url === '/api/auth/me') {
        return { ok: true, status: 200, json: async () => ({ authenticated: true, user: { username: 'admin' } }) };
      }
      throw new Error('初始化取数失败');
    });
    const page = await runInlineScript(ADMIN_HTML, shim);
    await delay(25);
    assert.match(shim.el('load-error').className, /load-error/);
    assert.doesNotMatch(shim.el('load-error').className, /hidden/);
    assert.doesNotMatch(shim.el('load-error-text').className, /hidden/);
    assert.ok(shim.el('load-retry'));
    assert.equal(await page.loadAll(), false, 'loadAll 应吸收 rejection 并返回 false');
    await delay(25);
    assert.deepEqual(unhandled, [], 'boot/loadAll 不得留下未处理 Promise rejection');
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
  }
});

// ── bug 2：后台状态和前台共用同一纯函数，耗尽/限流不得显示绿色可用 ──
test('回归#10：statusTag 读取 exhausted/creditsExhausted/available/rateLimited 并与前台同口径', async () => {
  const shim = dom(ADMIN_HTML);
  const admin = await runInlineScript(ADMIN_HTML, shim);
  const frontShim = dom(INDEX_HTML);
  const front = await runInlineScript(INDEX_HTML, frontShim);

  const cases = [
    account({ available: false, exhausted: { kind: 'monthly', label: '月额度已用完', resetAt: 0 } }),
    account({ available: false, creditsExhausted: true, exhausted: null }),
    account({ available: false, rateLimited: true, exhausted: null }),
    account({ available: true, exhausted: null }),
  ];
  assert.equal(typeof admin.accountStatus, 'function');
  assert.equal(typeof front.accountStatus, 'function');
  for (const a of cases) assert.deepEqual(JSON.parse(JSON.stringify(admin.accountStatus(a))), JSON.parse(JSON.stringify(front.accountStatus(a))));
  adminAccounts(admin, cases);
  const out = shim.el('accounts').innerHTML;
  // B24：徽章 = daisyUI badge + 语义色（badge-error/warning/success）+ 原 tone 钩子类，选择器放宽为
  // 「class 里含该 tone」；文案与 data-account-status 断言一字未改。
  assert.match(out, /class="tag badge[^"]*\bbad\b[^"]*"[^>]*data-account-status="invalid"[^>]*>月额度已用完 · 不可用/);
  assert.match(out, /data-account-status="invalid"[^>]*>余额不足 · 不可用/);
  // 普通限流（rateLimited）后台单独说「限流冷却中」，不混进「额度不可用」
  assert.match(out, /class="tag badge[^"]*\bwarn\b[^"]*"[^>]*data-account-status="paused"[^>]*>限流冷却中 · 不可用/);
  assert.match(out, /class="tag badge[^"]*\bok\b[^"]*"[^>]*data-account-status="ok"[^>]*>可用 · 可调度/);
  assert.doesNotMatch(out, /class="tag[^"]*\bok\b[^"]*"[^>]*>可用<\/span>/, '耗尽/限流账号不得单独显示绿色可用');
});

// ── bug 3：后台余额复用 usableRemaining，账面值只进 title ──
test('回归#11：后台额度显示 usableRemaining，monthly/balance 死余额为 0 且账面值仅在 title', async () => {
  const shim = dom(ADMIN_HTML);
  const page = await runInlineScript(ADMIN_HTML, shim);
  const dead = account({ available: false, exhausted: { kind: 'monthly', label: '月额度已用完', resetAt: 0 }, lastQuota: quota(0.098) });
  const windowBlocked = account({ available: false, exhausted: { kind: 'window', window: 'weekly', label: '周额度已用完', resetAt: 0 }, lastQuota: quota(4) });
  adminAccounts(page, [dead, windowBlocked]);
  const out = shim.el('accounts').innerHTML;
  assert.match(out, /class="usable-balance" title="账面 0\.10 · 月额度已用完，不可用">0\.00<\/span>/);
  assert.match(out, /class="usable-balance" title="账面 4\.00">4\.00<\/span>/, 'window 只是排队，照实显示余额');
  assert.doesNotMatch(out, /余额 0\.10/, '死余额不得直接以可见余额出现');
  assert.equal(page.usableRemaining(dead), 0);
  assert.equal(page.usableRemaining(windowBlocked), 4);
});

// ── bug 4：定时 load() 有请求代次，旧响应不得覆盖新响应 ──
test('回归#16：前台 load() 用 generation 丢弃慢旧响应', async () => {
  const pending = [];
  const shim = dom(INDEX_HTML, (url) => {
    assert.equal(url, '/api/status');
    return new Promise((resolve) => pending.push(resolve));
  });
  const page = await runInlineScript(INDEX_HTML, shim);
  assert.equal(pending.length, 1, '页面启动应发起第一次 load');
  const second = page.load();
  await delay(0);
  assert.equal(pending.length, 2, '第二次 load 应独立发起请求');
  pending[1]({ ok: true, status: 200, json: async () => ({ now: 2, summary: { accounts: 99, available: 1, paused: 0, concurrency: 0 }, stats: { total: 99, errors: 0, clientErrors: 0, totalTokens: 0 }, accounts: [] }) });
  await second;
  assert.equal(shim.el('kpi-total').textContent, '99');
  pending[0]({ ok: true, status: 200, json: async () => ({ now: 1, summary: { accounts: 11, available: 1, paused: 0, concurrency: 0 }, stats: { total: 11, errors: 0, clientErrors: 0, totalTokens: 0 }, accounts: [] }) });
  await delay(0);
  assert.equal(shim.el('kpi-total').textContent, '99', '过期的旧响应必须直接丢弃');
});

// ── UI 5：危险/警示/中性操作按钮语义统一 ──
test('视觉#5：删除红描边、停用琥珀警示，三个表格按钮语义统一', async () => {
  const shim = dom(ADMIN_HTML);
  const page = await runInlineScript(ADMIN_HTML, shim);
  adminAccounts(page, [account({ enabled: true })]);
  vm.runInContext(`state.keys = [{ keyId: 'abcdef12', keyPrefix: 'sk-cg-2XyP', name: '客户端' }]; renderKeys();
    state.users = [{ username: 'a', createdAt: Date.now() }, { username: 'b', createdAt: Date.now() }]; renderUsers();`, page);
  const accounts = shim.el('accounts').innerHTML;
  const keys = shim.el('keys').innerHTML;
  const users = shim.el('users').innerHTML;
  // B24：三个按钮改用 daisyUI 语义变体（btn-warning / btn-outline / btn-error），不再自绘 .btn.danger。
  // 等价性：仍是「停用=琥珀警示、测试=中性描边、删除=红」，且语义令牌确实由构建 CSS 提供。
  const css = styleText(ADMIN_HTML);
  assert.match(css, /\.btn-error\{[^}]*--color-error/, '删除用 daisyUI error 语义（红）');
  assert.match(css, /\.btn-warning\{[^}]*--color-warning/, '停用用 daisyUI warning 语义（琥珀）');
  assert.match(accounts, /class="btn btn-xs btn-warning"[^>]*data-act="toggle"[^>]*>停用/);
  assert.match(accounts, /class="btn btn-outline btn-xs"[^>]*data-act="test"[^>]*>测试连通性/);
  assert.match(accounts, /class="btn btn-error btn-xs"[^>]*data-act="del"[^>]*>删除/);
  assert.match(keys, /class="btn btn-error btn-xs"[^>]*data-act="delkey"[^>]*>删除/);
  assert.match(users, /class="btn btn-error btn-xs"[^>]*data-act="deluser"[^>]*>删除/);
});

// ── UI 6：最近错误不再是套餐同档小灰字 ──
test('视觉#6：最近错误/查询失败用 cell-error 琥珀红色强调并带前缀', async () => {
  const shim = dom(ADMIN_HTML);
  const page = await runInlineScript(ADMIN_HTML, shim);
  adminAccounts(page, [account({ lastError: '上游拒付', lastQuota: quota(1) }), account({ lastQuota: null, lastError: '探针失败' })]);
  const out = shim.el('accounts').innerHTML;
  // B24：cell-error 仍带 text-error，并新增「⚠ 」前缀（Tailwind @utility，不再是手写 ::before 规则）。
  assert.match(out, /class="cell-error[^"]*">最近错误：上游拒付/);
  assert.match(out, /class="cell-error[^"]*">额度未同步：探针失败/);
  assert.match(styleText(ADMIN_HTML), /\.cell-error:before\{content:"⚠ "\}|\\.cell-error::before\{content:"⚠ "\}/);
});

// ── UI 7：0% 进度条不是 2px 细线 ──
test('视觉#7：0% 进度条保留完整 6px 空轨道，填充条与轨道同粗', async () => {
  const shim = dom(INDEX_HTML);
  const page = await runInlineScript(INDEX_HTML, shim);
  // B23：进度条从账号卡模板克隆；用一张 5h 0% 的卡取 .bar 轨道。
  const empty = page.card(account({
    lastQuota: quota(9.9, { fiveHour: { used: 0, cap: 3, percent: 0, usedRatio: 0, resetAt: 0 } }),
  }));
  // B24：进度条改 daisyUI <progress>（单元素 → 轨道与填充天然同粗）；h-1.5 = 6px，0% 也保留空轨道。
  assert.match(empty, /<progress class="progress bar h-1\.5 w-full[^"]*"[^>]*max="100" value="0"><\/progress>/,
    '0% 仍是完整 6px 轨道（不是 2px 细线）');
  assert.match(styleText(INDEX_HTML), /\.h-1\\\.5\{height:calc\(var\(--spacing\) \* 1\.5\)\}/, 'h-1.5 = 6px');
});

// ── UI 8：启用/不可用合并为一个清晰主徽章 ──
test('视觉#8：卡片状态徽章合并层级，不可用不再是暗灰低对比次徽章', async () => {
  const shim = dom(INDEX_HTML);
  const page = await runInlineScript(INDEX_HTML, shim);
  const out = page.card(account({ available: false, exhausted: { kind: 'monthly', label: '月额度已用完', resetAt: 0 } }));
  // B24e：只有一个状态徽章（summary 里的 .acct-status badge badge-error is-bad，类名避开 daisyUI 的 .status 组件），不再并排「已启用」次徽章。
  assert.match(out, /class="acct-status badge[^"]*badge-error is-bad"/, '状态徽章 = daisyUI 语义色 badge-error + tone 钩子 is-bad');
  assert.doesNotMatch(out, /已启用/, '不再并排两个语义冲突徽章');
  assert.match(styleText(INDEX_HTML), /\.badge-error\{--badge-color:var\(--color-error\)/, '错误态用 AA 语义色，不再是暗灰低对比');
});

// ── UI 9：辅助小灰字与浅灰徽章文字达到 AA 对比度 ──
test('视觉#9：额度/更新时间/内核辅助文字统一 aux-text，小字与徽章使用 AA 语义色', async () => {
  const shim = dom(INDEX_HTML);
  const page = await runInlineScript(INDEX_HTML, shim);
  const out = page.card(account({ lastQuota: quota(9.9) }));
  assert.match(INDEX_HTML, /class="hero-meta aux-text[^"]*"/);
  assert.match(out, /class="card-credits aux-text[^"]*"/);
  assert.match(out, /class="card-fresh aux-text/);
  // B24：aux-text 改由 Tailwind @utility 提供颜色（同一 --text-secondary 令牌，选择器语法变了）。
  assert.match(styleText(INDEX_HTML), /\.aux-text\{color:var\(--text-secondary\)\}/);
  // 令牌值语义不变（AA 小字）；徽章色改用 daisyUI 语义令牌（warning→--color-warning / error→--color-error）。
  assert.match(styleText(INDEX_HTML), /--text-secondary:\s*#4d5666/);
  assert.match(styleText(INDEX_HTML), /--text-tertiary:\s*#6a7386/);
  assert.match(styleText(INDEX_HTML), /\.badge-warning\{--badge-color:var\(--color-warning\)/);
  assert.match(styleText(INDEX_HTML), /\.badge-error\{--badge-color:var\(--color-error\)/);
});

// ── UI 10：3 张卡最后一张跨整行，4 张恢复 2×2 ──
test('视觉#10：三卡时最后一张 card-wide 跨整行，四卡时恢复两列', async () => {
  const shim = dom(INDEX_HTML);
  const page = await runInlineScript(INDEX_HTML, shim);
  const make = (n) => ({ summary: { accounts: n, available: n, paused: 0, concurrency: 0 }, stats: { total: 0, errors: 0, totalTokens: 0 }, now: Date.now(), quotaPoll: {}, accounts: Array.from({ length: n }, (_, i) => account({ name: '账号' + i, keyId: String(i).padStart(8, '0') })) });
  page.render(make(3));
  assert.equal((shim.el('cards').innerHTML.match(/class="card[^\"]*card-wide/g) || []).length, 1);
  page.render(make(4));
  assert.equal((shim.el('cards').innerHTML.match(/class="card[^\"]*card-wide/g) || []).length, 0);
  // B24/B24d：账号区是容器查询网格 —— 窄屏单列（每行跨满整宽，等价于旧的整行式列表），
  // 超宽屏（2xl）两列，避免 1600px 页壳下出现超长单行。card-wide 仍由 render-cards.js 作为
  // 奇数尾行钩子输出。@container 让行内明细按容器宽度自适应（而非视口断点）。
  assert.match(INDEX_HTML, /class="@container accounts grid grid-cols-1 gap-2 2xl:grid-cols-2[^"]*"/,
    '账号区是容器查询网格（窄屏单列 / 超宽两列）');
  assert.match(styleText(INDEX_HTML), /container-type:\s*inline-size/, '@container 产出容器查询上下文');
});

// ── UI 11：key 前缀明确遮蔽，keyId 仍完整 ──
test('视觉#11：keyPrefix 改为可读前缀 + 明确 •••• 遮蔽尾巴，keyId 不截断', async () => {
  const shim = dom(ADMIN_HTML);
  const page = await runInlineScript(ADMIN_HTML, shim);
  adminAccounts(page, [account()]);
  vm.runInContext(`state.keys = [{ keyId: 'abcdef12', keyPrefix: 'sk-cg-2XyP', name: '客户端' }]; renderKeys();`, page);
  const accounts = shim.el('accounts').innerHTML;
  const keys = shim.el('keys').innerHTML;
  for (const out of [accounts, keys]) {
    assert.match(out, /class="key-mask[^"]*"/);
    assert.match(out, /class="key-prefix"/);
    assert.match(out, /class="key-hidden"[^>]*>••••<\/span>/);
    assert.doesNotMatch(out, /2XyP…/);
  }
  assert.match(accounts, /12345678/);
  assert.match(keys, /abcdef12/);
});
