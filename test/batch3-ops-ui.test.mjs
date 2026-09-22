// G3：shortId 前缀碰撞 —— 后台列表按钮必须按完整 keyId 定位对象。
// 只读 public/admin.html，用既有 DOM 垫片跑内联脚本（零外部依赖、不开端口）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createDomShim, runInlineScript, sleep } from './helpers.mjs';

const ADMIN_HTML = fs.readFileSync(new URL('../public/admin.html', import.meta.url), 'utf8');

// 前 8 字符完全相同、后面不同 —— shortId() 无法区分这两个 keyId。
const SHARED_PREFIX = '8f3a1c2d';
const ACCT_A = { keyId: `${SHARED_PREFIX}-0000-4aaa-8000-00000000000a`, name: '账号甲', enabled: true };
const ACCT_B = { keyId: `${SHARED_PREFIX}-1111-4bbb-8000-00000000000b`, name: '账号乙', enabled: false };
const KEY_A = { keyId: `${SHARED_PREFIX}-aaaa-4ccc-8000-00000000000c`, name: 'key 甲' };
const KEY_B = { keyId: `${SHARED_PREFIX}-bbbb-4ddd-8000-00000000000d`, name: 'key 乙' };

function account(i, keyId, name, enabled) {
  return {
    keyId, keyPrefix: 'user_2XyP', name, enabled, available: enabled,
    creditsExhausted: false, exhausted: null, concurrency: 0, paused: false, pausedUntil: null,
    rateLimited: false, authInvalid: false, lastError: null, lastQuota: null, ...i,
  };
}

async function newPage() {
  const calls = [];
  const confirms = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method ?? 'GET', body: opts.body ?? null });
    const payload = String(url).includes('/api/admin/keys')
      ? { ok: true, keys: [KEY_A, KEY_B] }
      : { ok: true, accounts: [account({}, ACCT_A.keyId, ACCT_A.name, true), account({}, ACCT_B.keyId, ACCT_B.name, false)] };
    return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) };
  };
  const shim = createDomShim({ html: ADMIN_HTML, fetchImpl });
  shim.window.confirm = (msg) => { confirms.push(String(msg)); return true; };
  const page = await runInlineScript(ADMIN_HTML, shim);
  return { shim, page, calls, confirms };
}

/** 模拟点击表格里某个按钮（handler 只用到 e.target.closest + data-* 属性）。 */
function clickRow(shim, containerId, id, act) {
  shim.el(containerId).dispatchEvent({
    type: 'click',
    target: { closest: () => ({ getAttribute: (name) => (name === 'data-id' ? id : act) }) },
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

test('G3：keyId 前 8 字符相同的两个账号，停用操作只作用到目标账号', async () => {
  const { shim, page, calls } = await newPage();
  const seeded = account({}, ACCT_A.keyId, ACCT_A.name, true);
  const target = account({}, ACCT_B.keyId, ACCT_B.name, false);
  vm.runInContext(`state.accounts = ${JSON.stringify([seeded, target])}; renderAccounts();`, page);
  // 页面上「账号乙」是停用状态 → 按钮文案是「启用」，点它应当提示「账号已启用」。
  const html = shim.el('accounts').innerHTML;
  assert.match(html, /data-act="toggle" data-id="8f3a1c2d-1111-4bbb-8000-00000000000b"/, '按钮必须带完整 keyId');

  clickRow(shim, 'accounts', ACCT_B.keyId, 'toggle');
  assert.ok(await waitFor(() => calls.some((c) => c.method === 'PATCH')), '应当发出 PATCH');
  const patch = calls.find((c) => c.method === 'PATCH');
  assert.ok(patch.url.endsWith(`/api/admin/accounts/${ACCT_B.keyId}`), `PATCH 目标必须是账号乙，实际 ${patch.url}`);

  assert.ok(await waitFor(() => shim.el('toast').textContent), '应当有提示');
  assert.equal(shim.el('toast').textContent, '账号已启用',
    '提示必须按**账号乙**（停用中）算：按短 id 匹配会错拿账号甲，提示成「账号已停用」');
});

test('G3：keyId 前 8 字符相同的两个客户端 key，删除确认只提到目标 key', async () => {
  const { shim, page, calls, confirms } = await newPage();
  vm.runInContext(`state.keys = ${JSON.stringify([KEY_A, KEY_B])}; renderKeys();`, page);
  clickRow(shim, 'keys', KEY_B.keyId, 'delkey');
  assert.ok(await waitFor(() => calls.some((c) => c.method === 'DELETE')), '应当发出 DELETE');
  const del = calls.find((c) => c.method === 'DELETE');
  assert.ok(del.url.endsWith(`/api/admin/keys/${KEY_B.keyId}`), `DELETE 目标必须是 key 乙，实际 ${del.url}`);
  assert.ok(confirms.length > 0, '删除必须二次确认');
  assert.match(confirms[0], /key 乙/, `确认文案必须提到目标 key 名，实际：${confirms[0]}`);
  assert.doesNotMatch(confirms[0], /key 甲/, '不得提到被短 id 误匹配的另一个 key');
});
