// 审查批次 A（7 条已确认缺陷）的回归测试：A1–A7
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { startTestGateway, request, makeTmpDir, createDomShim, runInlineScript } from './helpers.mjs';
import { createScheduler, QUOTA_RETRY_BACKOFF_MS } from '../src/scheduler.mjs';
import { sanitizeForLog } from '../src/log.mjs';
import { normalizeAccounts } from '../src/store.mjs';

const AUTH = (ctx) => ({ authorization: `Bearer ${ctx.localKey}`, 'content-type': 'application/json' });
const post = (ctx, p, { headers = {}, body = '{}' } = {}) =>
  request(`${ctx.baseUrl}${p}`, { method: 'POST', headers: { ...AUTH(ctx), ...headers }, body });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeState() {
  return { accounts: {}, stats: { total: 0, errors: 0, totalTokens: 0, byAccount: {} } };
}
const makeAccounts = (list) => normalizeAccounts(list);

function quotaWith(fiveHour, weekly, extra = {}) {
  const w = (x) => (x ? {
    used: x.used, cap: x.cap, percent: x.cap ? (x.used / x.cap) * 100 : null,
    usedRatio: x.cap ? x.used / x.cap : null, resetAt: x.resetAt ?? null, exceeded: x.exceeded === true,
  } : null);
  return { ok: true, fetchedAt: Date.now(), fiveHour: w(fiveHour), weekly: w(weekly), ...extra };
}

// ── A2：pauseForQuota 不再盲停 5 小时 ────────────────────────────────
test('A2：resetAt 无效 / 缺失 / lastQuota 为空 → 只退避 60 秒', () => {
  const now = Date.now();

  // ① resetAt 恰好等于当前（不是未来）→ 不能停到过去/此刻，退避 60s
  const a = makeAccounts([{ name: '等于当前', key: 'user_a2_equal_xxxxxx' }]);
  const s1 = createScheduler({ accounts: a, state: makeState() });
  s1.recordQuota(a[0], quotaWith({ used: 100, cap: 100, resetAt: Math.floor(now / 1000) }));
  assert.equal(s1.pauseForQuota(a[0], now) - now, QUOTA_RETRY_BACKOFF_MS);

  // ② resetAt 缺失
  const b = makeAccounts([{ name: '缺 resetAt', key: 'user_a2_missing_xxxx' }]);
  const s2 = createScheduler({ accounts: b, state: makeState() });
  s2.recordQuota(b[0], quotaWith({ used: 100, cap: 100 }));
  assert.equal(s2.pauseForQuota(b[0], now) - now, QUOTA_RETRY_BACKOFF_MS);

  // ③ lastQuota 为 null
  const c = makeAccounts([{ name: '无快照', key: 'user_a2_null_xxxxxxx' }]);
  const s3 = createScheduler({ accounts: c, state: makeState() });
  assert.equal(s3.pauseForQuota(c[0], now) - now, QUOTA_RETRY_BACKOFF_MS);
});

test('A2：未来 resetAt 仍精确暂停到该时刻（不回归）', () => {
  const now = Date.now();
  const resetAt = Math.floor((now + 2 * 3600_000) / 1000);
  const accounts = makeAccounts([{ name: 'A', key: 'user_a2_future_xxxxx' }]);
  const s = createScheduler({ accounts, state: makeState() });
  s.recordQuota(accounts[0], quotaWith({ used: 100, cap: 100, resetAt }));
  assert.equal(s.pauseForQuota(accounts[0], now), resetAt * 1000);
});

// ── A3：额度接口故障不得让账号永久不可用 ─────────────────────────────
test('A3：额度接口连续失败 → 60/120/240s 指数退避（不是 3 × 5 小时）', async () => {
  const accounts = makeAccounts([{ name: 'A', key: 'user_a3_backoff_xxxx' }]);
  const s = createScheduler({ accounts, state: makeState() });
  s.recordQuota(accounts[0], quotaWith({ used: 90, cap: 100 }));
  let now = Date.now();
  s.runtime(accounts[0]).pausedUntil = now - 1;
  const failOnce = async (expectedMs) => {
    await s.recheckPaused({ fetchQuota: async () => { throw new Error('额度接口超时'); }, now });
    const until = s.runtime(accounts[0]).pausedUntil;
    assert.equal(until - now, expectedMs, `本次退避应为 ${expectedMs}ms，实际 ${until - now}ms`);
    now = until;
  };
  await failOnce(60_000);
  await failOnce(120_000);
  await failOnce(240_000);
  assert.equal(s.runtime(accounts[0]).quotaRecheckFails, 3, '连续失败次数要被记录');
});

test('A3：连续失败 5 次后 fail-open，账号重新可用', async () => {
  const accounts = makeAccounts([{ name: 'A', key: 'user_a3_failopen_xxx' }]);
  const s = createScheduler({ accounts, state: makeState() });
  s.recordQuota(accounts[0], quotaWith({ used: 1, cap: 100 }));   // 旧快照健康
  let now = Date.now();
  s.runtime(accounts[0]).pausedUntil = now - 1;
  for (let i = 0; i < 5; i++) {
    await s.recheckPaused({ fetchQuota: async () => { throw new Error('upstream down'); }, now });
    now = (s.runtime(accounts[0]).pausedUntil ?? now) + 1;
  }
  assert.equal(s.runtime(accounts[0]).pausedUntil, null, '第 5 次失败必须撤销暂停');
  assert.equal(s.runtime(accounts[0]).quotaRecheckFails, 0, 'fail-open 后计数清零');
  assert.equal(s.isAvailable(accounts[0], now), true, 'fail-open 后必须重新参与调度');
});

test('A3：查询成功但窗口仍耗尽 → 按真实 resetAt 暂停，且失败计数清零', async () => {
  const accounts = makeAccounts([{ name: 'A', key: 'user_a3_still_xxxxxx' }]);
  const s = createScheduler({ accounts, state: makeState() });
  const now = Date.now();
  const resetAt = Math.floor((now + 3600_000) / 1000);
  s.recordQuota(accounts[0], quotaWith({ used: 50, cap: 100 }));
  s.runtime(accounts[0]).pausedUntil = now - 1;

  await s.recheckPaused({ fetchQuota: async () => { throw new Error('第一次超时'); }, now });
  assert.equal(s.runtime(accounts[0]).quotaRecheckFails, 1);

  const afterFail = s.runtime(accounts[0]).pausedUntil;
  await s.recheckPaused({ fetchQuota: async () => quotaWith({ used: 100, cap: 100, resetAt }), now: afterFail });
  assert.equal(s.runtime(accounts[0]).quotaRecheckFails, 0, '查询成功必须清零失败计数');
  assert.equal(s.runtime(accounts[0]).pausedUntil, resetAt * 1000, '未恢复时按真实 resetAt 顺延');
});

// ── A1：额度类 429/402 也要换号重试 ──────────────────────────────────
test('A1：账号 A 额度 429、账号 B 健康 → 客户端拿到 200，A/B 各打一次上游', async (t) => {
  const ctx = await startTestGateway({ behavior: { quotaErrorKeys: ['user_test_alpha'] } });
  t.after(() => ctx.close());

  const res = await post(ctx, '/v1/chat/completions', { body: JSON.stringify({ model: 'mock-model' }) });
  assert.equal(res.status, 200, `应换号成功拿到 200，实际 ${res.status}: ${res.body.slice(0, 200)}`);

  const calls = ctx.upstream.seen.filter((s) => s.url.startsWith('/v1/'));
  const alpha = calls.filter((s) => String(s.headers.authorization ?? '').includes('user_test_alpha'));
  const beta = calls.filter((s) => String(s.headers.authorization ?? '').includes('user_test_beta'));
  assert.equal(alpha.length, 1, '额度耗尽的账号只应被调用一次');
  assert.equal(beta.length, 1, '健康账号应被调用一次完成重试');
});

test('A1：单账号池同场景仍如实回 429（不变成 502、不无限重试）', async (t) => {
  const ctx = await startTestGateway({
    accounts: [{ name: '账号A', key: 'user_test_alpha', enabled: true }],
    behavior: { quotaErrorKeys: ['user_test_alpha'] },
  });
  t.after(() => ctx.close());

  const res = await post(ctx, '/v1/chat/completions', { body: JSON.stringify({ model: 'mock-model' }) });
  assert.equal(res.status, 429, `单账号池应如实回 429，实际 ${res.status}: ${res.body.slice(0, 200)}`);
  assert.match(res.body, /weekly limit|quota/i, 'body 应保留上游额度错误措辞');

  const calls = ctx.upstream.seen.filter((s) => s.url.startsWith('/v1/'));
  assert.equal(calls.length, 1, '没有可换的账号时不得重复打上游');
});

// ── A4：窗口重置后的恢复触发器 ───────────────────────────────────────
test('A4：窗口 resetAt 已过期 + 刷新后恢复 → 首个请求直接 200（并只刷一轮）', async (t) => {
  const ctx = await startTestGateway();
  t.after(() => ctx.close());

  // 前置：池内两个账号的快照都「窗口已过期 + 已耗尽」→ 全池不可用
  const nowSec = Math.floor(Date.now() / 1000);
  for (const a of ctx.gateway.accounts) {
    ctx.gateway.scheduler.recordQuota(a, {
      ok: true, fetchedAt: Date.now(),
      fiveHour: { used: 100, cap: 100, usedRatio: 1, resetAt: nowSec - 30, exceeded: true },
      weekly: { used: 1, cap: 500, usedRatio: 0.002, resetAt: nowSec + 86400 },
    });
  }
  assert.equal(ctx.gateway.scheduler.availableCount(), 0, '前置：全池不可用');
  const before = ctx.upstream.seen.filter((s) => s.url.startsWith('/alpha/whoami')).length;

  const res = await post(ctx, '/v1/chat/completions', { body: JSON.stringify({ model: 'mock-model' }) });
  assert.equal(res.status, 200, `应刷新后在同一请求内转发成功，实际 ${res.status}: ${res.body.slice(0, 200)}`);

  const after = ctx.upstream.seen.filter((s) => s.url.startsWith('/alpha/whoami')).length;
  assert.equal(after - before, 2, '一轮刷新 = 每账号一次 whoami（refreshInFlight 去重，不能刷两轮）');
});

test('A4：确实无账号可恢复 → 503 带 retry-after 头与 retryAfterMs', async (t) => {
  const ctx = await startTestGateway();
  t.after(() => ctx.close());
  for (const a of ctx.gateway.accounts) ctx.gateway.scheduler.markAuthInvalid(a, '上游 HTTP 401');

  const res = await post(ctx, '/v1/chat/completions');
  assert.equal(res.status, 503, `仍不可用时必须 503，实际 ${res.status}`);
  assert.ok(Number(res.headers['retry-after']) >= 1, '503 必须带 retry-after（秒）');
  const data = JSON.parse(res.body);
  assert.equal(data.error?.type, 'no_available_account');
  assert.ok(Number(data.retryAfterMs) > 0, 'body 必须带 retryAfterMs');
});

// ── A5：登录限流不再退化为全局桶 ─────────────────────────────────────
const ADMIN = { username: 'admin', password: 'hunter2-secret' };

async function setupAdmin(ctx) {
  const res = await request(`${ctx.baseUrl}/api/auth/setup`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(ADMIN),
  });
  assert.equal(res.status, 201, `setup 应成功，实际 ${res.status}: ${res.body}`);
}

function loginReq(ctx, { username, password, xff, xri } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (xff) headers['x-forwarded-for'] = xff;
  if (xri) headers['x-real-ip'] = xri;
  return request(`${ctx.baseUrl}/api/auth/login`, {
    method: 'POST', headers, body: JSON.stringify({ username, password }),
  });
}

test('A5：可信来源的两个 XFF 各自独立计数，一个刷满不影响另一个登录', async (t) => {
  const ctx = await startTestGateway({ config: { loginAttemptsPerMinute: 3 } });
  t.after(() => ctx.close());
  await setupAdmin(ctx);

  for (let i = 0; i < 3; i++) {
    const r = await loginReq(ctx, { username: `attacker${i}`, password: 'wrong-pass-1234', xff: '1.1.1.1' });
    assert.equal(r.status, 401, `第 ${i + 1} 次失败应 401，实际 ${r.status}: ${r.body}`);
  }
  const blocked = await loginReq(ctx, { username: 'attacker9', password: 'wrong-pass-1234', xff: '1.1.1.1' });
  assert.equal(blocked.status, 429, '刷满后同一来源必须被限速');

  const ok = await loginReq(ctx, { ...ADMIN, xff: '2.2.2.2' });
  assert.equal(ok.status, 200, `另一个来源不应被牵连，实际 ${ok.status}: ${ok.body}`);
});

test('A5：不可信来源伪造 X-Forwarded-For 无效，仍按 socket 地址计数', async (t) => {
  // 只信任 10.0.0.0/8 → 测试用的回环来源不可信
  const ctx = await startTestGateway({
    config: { loginAttemptsPerMinute: 3, trustedProxyCidrs: ['10.0.0.0/8'] },
  });
  t.after(() => ctx.close());
  await setupAdmin(ctx);

  for (let i = 0; i < 3; i++) {
    const r = await loginReq(ctx, { username: `spoof${i}`, password: 'wrong-pass-1234', xff: `9.9.9.${i + 1}` });
    assert.equal(r.status, 401, `第 ${i + 1} 次失败应 401（若采信伪造 XFF，每个假 IP 各有独立桶）`);
  }
  const blocked = await loginReq(ctx, { username: 'spoof9', password: 'wrong-pass-1234', xff: '9.9.9.99' });
  assert.equal(blocked.status, 429, '伪造 XFF 必须被忽略，仍按 socket 桶限速');
});

test('A5：匿名者刷空自己的桶后，另一 IP 的管理员正确密码仍能登录（回归）', async (t) => {
  const ctx = await startTestGateway({ config: { loginAttemptsPerMinute: 5 } });
  t.after(() => ctx.close());
  await setupAdmin(ctx);

  for (let i = 0; i < 5; i++) {
    const r = await loginReq(ctx, { username: `rot${i}`, password: 'wrong-pass-1234', xff: '9.9.9.9' });
    assert.equal(r.status, 401);
  }
  assert.equal((await loginReq(ctx, { username: 'rot9', password: 'wrong-pass-1234', xff: '9.9.9.9' })).status, 429,
    '攻击者来源已被刷空');

  const ok = await loginReq(ctx, { ...ADMIN, xff: '8.8.8.8' });
  assert.equal(ok.status, 200, `另一 IP 的管理员必须能登录，实际 ${ok.status}: ${ok.body}`);
});

// ── A6：日志注入 ─────────────────────────────────────────────────────
test('A6：sanitizeForLog 转义控制字符并截断到 80 字符', () => {
  assert.equal(sanitizeForLog('a\nb\tc\rd'), 'a\\nb\\tc\\rd');
  assert.equal(sanitizeForLog('\x1b[31mred'), '\\x1b[31mred', 'ANSI 转义必须可见化');
  assert.equal(sanitizeForLog('x'.repeat(200)).length, 80, '超长输入截断到 80 字符');
  assert.ok(sanitizeForLog('x'.repeat(200)).endsWith('…'), '截断要有省略号');
  assert.equal(sanitizeForLog(null), '');
  assert.equal(sanitizeForLog('正常用户'), '正常用户', '正常输入不受影响');
});

async function readLogUntil(file, needle, timeoutMs = 2000) {
  const start = Date.now();
  for (;;) {
    const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    if (text.includes(needle) || Date.now() - start > timeoutMs) return text;
    await sleep(20);
  }
}

test('A6：登录用户名里的换行不能伪造日志行', async (t) => {
  const dir = makeTmpDir();
  const logFile = path.join(dir, 'gateway.log');
  const ctx = await startTestGateway({ rootDir: dir, config: { logLevel: 'warn', logFile } });
  t.after(() => ctx.close());

  const evil = 'ghost\n2026-01-01T00:00:00.000Z [error] FORGED';
  const res = await loginReq(ctx, { username: evil, password: 'wrong-password-123' });
  assert.equal(res.status, 401);

  const text = await readLogUntil(logFile, 'ghost');
  assert.ok(text.includes('ghost\\n2026-01-01T00:00:00.000Z [error] FORGED'),
    `换行必须被转义成 \\n，实际日志: ${text}`);
  assert.ok(!text.includes('\n2026-01-01T00:00:00.000Z [error] FORGED'),
    '绝不能出现换行后跟伪造内容的独立日志行');
});

// ── A7：后台「改他人密码」必须带上当前管理员密码 ─────────────────────
const ADMIN_HTML = fs.readFileSync(new URL('../public/admin.html', import.meta.url), 'utf8');

test('A7：修改密码弹窗存在 #p-current 输入框', () => {
  assert.match(ADMIN_HTML, /id="p-current"/, '弹窗必须存在当前管理员密码输入框');
  assert.match(ADMIN_HTML, /id="p-current-field"/, '输入框需要可隐藏的容器');
});

test('A7：改他人密码 PATCH body 含 password + currentPassword；改自己不含', async () => {
  const okJson = async () => ({
    ok: true, status: 200,
    json: async () => ({
      ok: true, authenticated: true, setupRequired: false, user: { username: 'admin' },
      users: [], keys: [], accounts: [], events: [], tests: [], writable: true,
    }),
  });
  const shim = createDomShim({
    html: ADMIN_HTML,
    fetchImpl: async (_url, _opts) => await okJson(),
  });
  const page = await runInlineScript(ADMIN_HTML, shim);
  vm.runInContext("state.auth = { user: { username: 'admin' } };", page);

  // 改他人：显示当前密码框，body 必须同时带两个字段
  vm.runInContext("openPassModal('other'); $('p-pass').value = 'new-password-1'; $('p-current').value = 'admin-pass-1';", page);
  assert.equal(shim.el('p-current-field').classList.contains('hidden'), false, '改他人时必须显示当前密码框');
  await shim.el('p-submit').onclick();

  const patch = shim.calls.find((c) => c.opts?.method === 'PATCH' && c.url.includes('/api/admin/users/other'));
  assert.ok(patch, '必须发出针对 other 的 PATCH 请求');
  const body = JSON.parse(patch.opts.body);
  assert.equal(body.password, 'new-password-1');
  assert.equal(body.currentPassword, 'admin-pass-1', '改他人必须带上当前管理员密码');

  // 改自己：隐藏当前密码框，body 只带 password
  vm.runInContext("openPassModal('admin'); $('p-pass').value = 'self-password-1';", page);
  assert.equal(shim.el('p-current-field').classList.contains('hidden'), true, '改自己时必须隐藏当前密码框');
  await shim.el('p-submit').onclick();

  const selfPatch = shim.calls.find((c) => c.opts?.method === 'PATCH' && c.url.includes('/api/admin/users/admin'));
  assert.ok(selfPatch, '必须发出针对自己的 PATCH 请求');
  const selfBody = JSON.parse(selfPatch.opts.body);
  assert.equal(selfBody.password, 'self-password-1');
  assert.equal('currentPassword' in selfBody, false, '改自己不得提交 currentPassword');
});

test('A7：改他人时当前密码为空 → 不提交请求，错误写进 #p-err', async () => {
  const shim = createDomShim({
    html: ADMIN_HTML,
    fetchImpl: async () => ({
      ok: true, status: 200,
      json: async () => ({ ok: true, authenticated: true, user: { username: 'admin' }, users: [], keys: [], accounts: [], events: [], tests: [], writable: true }),
    }),
  });
  const page = await runInlineScript(ADMIN_HTML, shim);
  vm.runInContext("state.auth = { user: { username: 'admin' } };", page);
  vm.runInContext("openPassModal('other'); $('p-pass').value = 'new-password-1'; $('p-current').value = '';", page);
  await shim.el('p-submit').onclick();

  assert.equal(shim.calls.filter((c) => c.opts?.method === 'PATCH').length, 0, '缺当前密码时不得发请求');
  assert.match(shim.el('p-err').textContent, /当前管理员密码/, '错误文案要写进 #p-err');
});
