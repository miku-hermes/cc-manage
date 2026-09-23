// 批次 3：JS 组件化 + 事件委托的回归测试。
// 只读 public/*.html（外链 js 按文档顺序在 vm 里执行），用既有 DOM 垫片跑真实事件，
// 不联网、不起服务。约定：这些用例在未修复（仍用 $('x').onclick 直绑）的源码上必须变红。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createDomShim, runInlineScript, sleep } from './helpers.mjs';

const INDEX_HTML = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const ADMIN_HTML = fs.readFileSync(new URL('../public/admin.html', import.meta.url), 'utf8');
const delay = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

function dom(html, fetchImpl, opts = {}) {
  return createDomShim({
    html,
    fetchImpl: fetchImpl ?? (async () => ({ ok: true, status: 200, json: async () => ({}) })),
    localStorageData: opts.localStorageData ?? {},
  });
}

async function waitFor(fn, ms = 1000) {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (fn()) return true;
    await sleep(5);
  }
  return fn();
}

// 前 8 字符完全相同、后面不同 —— shortId() 无法区分这两个 keyId（G3 契约）。
const SHARED_PREFIX = '8f3a1c2d';
const ACCT_A = { keyId: `${SHARED_PREFIX}-0000-4aaa-8000-00000000000a`, name: '账号甲' };
const ACCT_B = { keyId: `${SHARED_PREFIX}-1111-4bbb-8000-00000000000b`, name: '账号乙' };

function account(keyId, name, enabled) {
  return {
    keyId, keyPrefix: 'user_2XyP', name, enabled, available: enabled,
    creditsExhausted: false, exhausted: null, concurrency: 0, paused: false, pausedUntil: null,
    rateLimited: false, authInvalid: false, lastError: null, lastQuota: null,
  };
}

// 后台页面：账号甲（启用中）+ 账号乙（已停用），keyId 前 8 位相同。
async function accountsPage() {
  const calls = [];
  const store = [account(ACCT_A.keyId, ACCT_A.name, true), account(ACCT_B.keyId, ACCT_B.name, false)];
  const fetchImpl = async (url, opts = {}) => {
    const u = String(url);
    const method = opts.method ?? 'GET';
    calls.push({ url: u, method, body: opts.body ?? null });
    if (u === '/api/auth/me') return { ok: true, status: 200, json: async () => ({ authenticated: false }) };
    if (method === 'PATCH') {
      const id = decodeURIComponent(u.split('/').pop());
      const body = JSON.parse(opts.body);
      const i = store.findIndex((a) => a.keyId === id);
      if (i >= 0) store[i] = { ...store[i], ...body };
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    if (u.startsWith('/api/admin/keys')) return { ok: true, status: 200, json: async () => ({ keys: [] }) };
    if (u.startsWith('/api/admin/session')) return { ok: true, status: 200, json: async () => ({ users: [] }) };
    if (u.startsWith('/api/admin/events')) return { ok: true, status: 200, json: async () => ({ events: [] }) };
    return { ok: true, status: 200, json: async () => ({ accounts: store, tests: [], writable: true }) };
  };
  const shim = dom(ADMIN_HTML, fetchImpl);
  shim.window.confirm = () => true;
  const page = await runInlineScript(ADMIN_HTML, shim);
  await delay(0);   // 等 boot() 的 /api/auth/me → showGate 落地后再铺数据
  vm.runInContext(`state.accounts = ${JSON.stringify(store)}; renderAccounts();`, page);
  return { shim, page, calls, store };
}

function toggleOf(shim, keyId) {
  return shim.el('accounts').querySelectorAll('button[data-act="toggle"]')
    .find((b) => b.getAttribute('data-id') === keyId);
}

// ── 1：账号表按钮走 #accounts 容器级委托，且只作用完整 keyId 的目标 ────
test('UI-1：#accounts 容器委托生效，G3 下只作用目标账号；只读时按钮不可触发', async () => {
  const { shim, page, calls, store } = await accountsPage();
  const target = toggleOf(shim, ACCT_B.keyId);
  assert.ok(target, '必须找到账号乙的 toggle 按钮');
  assert.equal(target.textContent, '启用', '账号乙已停用 → 按钮应显示「启用」');

  // 在容器上派发 click（真实委托路径），目标为账号乙的按钮。
  shim.el('accounts').dispatchEvent({ type: 'click', target });
  assert.ok(await waitFor(() => calls.some((c) => c.method === 'PATCH')), '委托点击必须发出 PATCH');

  const patch = calls.find((c) => c.method === 'PATCH');
  assert.ok(patch.url.endsWith(`/api/admin/accounts/${ACCT_B.keyId}`),
    `PATCH 必须命中账号乙的完整 keyId，实际 ${patch.url}`);
  assert.deepEqual(JSON.parse(patch.body), { enabled: true }, '按目标账号（停用中）取反为启用');
  assert.equal(calls.filter((c) => c.method === 'PATCH').length, 1, '一次点击只能发一次 PATCH');

  assert.ok(await waitFor(() => shim.el('toast').textContent === '账号已启用'),
    '提示必须按目标账号算（前缀误匹配会错拿账号甲，提示成「账号已停用」）');
  assert.ok(await waitFor(() => store.find((a) => a.keyId === ACCT_A.keyId).enabled === true),
    '账号甲状态不得变化');
  const after = JSON.parse(JSON.stringify(vm.runInContext('state.accounts', page)));
  assert.equal(after.find((a) => a.keyId === ACCT_B.keyId).enabled, true, '账号乙确实被启用');
  assert.equal(after.find((a) => a.keyId === ACCT_A.keyId).enabled, true, '账号甲仍是原状态');

  // 只读：写按钮置灰，且委托点击不能再触发写请求。
  vm.runInContext('state.writable = false; renderAccounts();', page);
  const disabledToggle = toggleOf(shim, ACCT_B.keyId);
  assert.equal(disabledToggle.disabled, true, '只读时 toggle 必须 disabled');
  const before = calls.filter((c) => c.method === 'PATCH').length;
  shim.el('accounts').dispatchEvent({ type: 'click', target: disabledToggle });
  await delay(0);
  assert.equal(calls.filter((c) => c.method === 'PATCH').length, before, '只读置灰的按钮不得触发写操作');
});

// ── 2：openModal 记录触发焦点，Esc 关闭后焦点归还 ─────────────────────
test('UI-2：弹窗入口走委托打开，记录触发元素；Esc 关闭后焦点归还', async () => {
  const shim = dom(ADMIN_HTML);
  const page = await runInlineScript(ADMIN_HTML, shim);
  const trigger = shim.el('add-account');
  trigger.focus();
  // 弹窗入口「新增 CC key」走 document 级委托，测试也按委托路径派发。
  shim.document.dispatchEvent({ type: 'click', target: trigger });
  assert.equal(shim.el('m-account').classList.contains('open'), true, '委托点击应打开弹窗');
  assert.equal(shim.document.activeElement, shim.el('a-name'), '打开后焦点进入弹窗首个输入框');

  shim.document.dispatchEvent({ type: 'keydown', key: 'Escape' });
  assert.equal(shim.el('m-account').classList.contains('open'), false, 'Esc 必须关闭弹窗');
  assert.equal(shim.document.activeElement, trigger, '关闭后焦点归还触发元素');
});

// ── 3：登出（委托触发）清空一次性 key / 粘贴 key / 密码框 / 弹窗 ──────
test('UI-3：委托触发 logout 清空敏感容器，DOM 文本不含 keyPrefix', async () => {
  const shim = dom(ADMIN_HTML, async (url) => {
    if (url === '/api/auth/me') return { ok: true, status: 200, json: async () => ({ authenticated: true, user: { username: 'admin' } }) };
    if (url === '/api/auth/logout') return { ok: true, status: 200, json: async () => ({ ok: true }) };
    if (url.startsWith('/api/admin/keys')) return { ok: true, status: 200, json: async () => ({ plaintext: 'sk-cg-PLAINTEXT-SECRET', warning: '' }) };
    if (url.startsWith('/api/admin/accounts')) return { ok: true, status: 200, json: async () => ({ accounts: [account('abcdef12', '账号', true)], tests: [], writable: true }) };
    return { ok: true, status: 200, json: async () => ({}) };
  });
  const page = await runInlineScript(ADMIN_HTML, shim);
  await delay(0);

  // 制造敏感内容：一次性明文 key + 粘贴的 CC key + 两个密码框 + 打开的弹窗。
  shim.document.dispatchEvent({ type: 'click', target: shim.el('add-key') });
  await shim.el('k-submit').onclick();
  assert.match(shim.el('k-plain').textContent, /sk-cg-PLAINTEXT-SECRET/, '生成后应有一次性明文');
  vm.runInContext(`$('a-key').value = 'user_secret_key';
    $('u-pass').value = 'pw-u'; $('p-pass').value = 'pw-p'; openModal('m-pass');`, page);
  assert.ok(shim.el('accounts').innerHTML.includes('user_2XyP'), '登出前 keyPrefix 确实在 DOM 里');
  assert.ok(shim.document.querySelectorAll('.modal.open').length >= 1, '登出前确有弹窗打开');

  shim.document.dispatchEvent({ type: 'click', target: shim.el('logout') });
  await waitFor(() => shim.el('k-plain').textContent === '');

  assert.equal(shim.el('k-plain').textContent, '', '#k-plain 一次性明文必须清空');
  for (const id of ['a-key', 'u-pass', 'p-pass']) {
    assert.equal(shim.el(id).value, '', `#${id} 必须清空`);
  }
  assert.equal(shim.document.querySelectorAll('.modal.open').length, 0, '不得留弹窗在打开状态');
  assert.doesNotMatch(shim.document.body.textContent, /user_2XyP/, 'DOM 文本里不得再含 keyPrefix');
});

// ── 4：切筛选走委托，且慢日志响应不得覆盖新筛选结果（generation 守卫）──
test('UI-4：委托切换 #level 后，慢日志响应不得覆盖新筛选结果', async () => {
  const pending = [];
  const shim = dom(ADMIN_HTML, (url) => {
    if (url === '/api/auth/me') return Promise.resolve({ ok: true, status: 200, json: async () => ({ authenticated: false }) });
    return new Promise((resolve) => pending.push({ url: String(url), resolve }));
  });
  const page = await runInlineScript(ADMIN_HTML, shim);
  await delay(0);

  const first = vm.runInContext("state.level = ''; loadEvents()", page);   // 旧的全量请求（慢）
  // 通过 document 级 change 委托切换筛选 → 发起新的 error 请求
  shim.el('level').value = 'error';
  shim.document.dispatchEvent({ type: 'change', target: shim.el('level') });
  await delay(0);
  assert.equal(vm.runInContext('state.level', page), 'error', '委托的 change 必须更新筛选状态');
  assert.equal(pending.length, 2, '两个请求都在途');
  assert.equal(pending[1].url, '/api/admin/events?level=error');

  pending[1].resolve({ ok: true, status: 200, json: async () => ({ events: [{ level: 'error', at: 1, message: '新筛选结果' }] }) });
  await delay(0);
  assert.equal(shim.el('event-count').textContent, '1 条');
  assert.match(shim.el('events').innerHTML, /新筛选结果/);

  // 先发起的慢请求后返回 → 必须被 generation 守卫丢弃
  pending[0].resolve({ ok: true, status: 200, json: async () => ({ events: [{ level: 'info', at: 2, message: '旧全量结果' }] }) });
  await first;
  await delay(0);
  assert.equal(shim.el('event-count').textContent, '1 条', '旧响应不得改写条数');
  assert.match(shim.el('events').innerHTML, /新筛选结果/);
  assert.doesNotMatch(shim.el('events').innerHTML, /旧全量结果/);
});

// ── 5：只读置灰 —— 新增 / 编辑 / 删除按钮不可触发 ─────────────────────
test('UI-5：只读时新增/编辑/删除按钮 disabled，委托点击不发写请求', async () => {
  const { shim, page, calls } = await accountsPage();
  vm.runInContext("state.writable = false; state.readonlyReason = '只读'; renderAccounts();", page);

  const writeBtns = shim.el('accounts').querySelectorAll('button[data-act]')
    .filter((b) => b.getAttribute('data-act') !== 'test');
  assert.ok(writeBtns.length >= 2, '应至少渲染出启停 / 改备注 / 删除按钮');
  for (const b of writeBtns) assert.equal(b.disabled, true, `只读时 ${b.getAttribute('data-act')} 按钮必须 disabled`);
  assert.equal(shim.el('add-account').disabled, true, '只读时「新增 CC key」必须 disabled');

  const before = calls.filter((c) => c.method === 'PATCH').length;
  shim.el('accounts').dispatchEvent({ type: 'click', target: writeBtns.find((b) => b.getAttribute('data-act') === 'toggle') });
  await delay(0);
  assert.equal(calls.filter((c) => c.method === 'PATCH').length, before, '置灰按钮的委托点击不得触发写请求');
});

// ── 6：主题按钮委托切换并持久化 ──────────────────────────────────────
test('UI-6：委托点击主题按钮翻转 data-theme 并写入 localStorage', async () => {
  const shim = dom(INDEX_HTML, async () => ({
    ok: true, status: 200,
    json: async () => ({ now: Date.now(), quotaPoll: {}, summary: {}, stats: {}, accounts: [] }),
  }));
  await runInlineScript(INDEX_HTML, shim);
  assert.equal(shim.document.documentElement.getAttribute('data-theme'), null, '初始未手动设置主题');

  shim.document.dispatchEvent({ type: 'click', target: shim.el('theme') });
  assert.equal(shim.document.documentElement.getAttribute('data-theme'), 'dark', '点击后切到 dark');
  assert.equal(shim.store.get('cc-manage-theme'), 'dark', '选择必须持久化');

  shim.document.dispatchEvent({ type: 'click', target: shim.el('theme') });
  assert.equal(shim.document.documentElement.getAttribute('data-theme'), 'light', '再点切回 light');
  assert.equal(shim.store.get('cc-manage-theme'), 'light', '持久化值同步更新');
});
