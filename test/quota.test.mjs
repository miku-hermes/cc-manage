// §8-1 额度查询：注入假 fetch，离线可跑
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchQuota, normalizeResetAt, parseWindow, CC_USER_AGENT } from '../src/quota.mjs';

/** 造一个按路径返回预设响应的假 fetch，同时记录请求供断言。 */
function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, opts) => {
    const u = new URL(url);
    calls.push({ path: u.pathname, search: u.search, headers: opts?.headers ?? {} });
    const handler = routes[u.pathname];
    if (!handler) return jsonRes(404, { error: 'not found' });
    const r = typeof handler === 'function' ? handler(u) : handler;
    if (r && r.__status) return jsonRes(r.__status, r.body);
    return jsonRes(200, r);
  };
  impl.calls = calls;
  return impl;
}

function jsonRes(status, obj) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return obj; },
    async text() { return JSON.stringify(obj); },
  };
}

const HAPPY = {
  '/alpha/whoami': { org: { login: 'acme', id: 'org-42' }, user: { userName: '张三', keyName: 'my-key' } },
  '/alpha/billing/credits': {
    credits: { monthlyCredits: 30, purchasedCredits: 12.5, freeCredits: 7.5 },
    windowLimits: {
      fiveHour: { used: 25, cap: 100, resetAt: 1700000000 },
      weekly: { used: 150, cap: 500, resetAt: 1700000000000 },
    },
  },
  '/alpha/billing/subscriptions': { data: { planId: 'pro', status: 'active', currentPeriodStart: '2026-09-01T00:00:00Z', currentPeriodEnd: 1800000000 } },
  '/alpha/usage/summary': { totalCost: 20, totalCount: 9, totalTokens: 4321 },
};

test('正确解析 whoami / 余额 / 5h 与周百分比', async () => {
  const ff = fakeFetch(HAPPY);
  const snap = await fetchQuota('user_abcdefghijkl', { baseUrl: 'https://api.commandcode.ai', fetchImpl: ff });

  assert.equal(snap.ok, true);
  assert.equal(snap.authInvalid, false);
  assert.equal(snap.orgId, 'org-42');
  assert.equal(snap.displayName, 'acme');       // org.login 优先
  assert.equal(snap.keyName, 'my-key');
  assert.equal(snap.remaining, 50);             // 30 + 12.5 + 7.5
  assert.deepEqual(snap.credits, { monthlyCredits: 30, purchasedCredits: 12.5, freeCredits: 7.5, remaining: 50 });
  assert.equal(snap.fiveHour.percent, 25);
  assert.equal(snap.weekly.percent, 30);
  assert.equal(snap.fiveHour.resetAt, 1700000000);
  assert.equal(snap.weekly.resetAt, 1700000000); // 毫秒 → 秒
  assert.equal(snap.usage.totalTokens, 4321);
  assert.equal(snap.plan.planId, 'pro');

  // 请求头必须显式带 UA + Bearer；usage 要带上 since
  for (const c of ff.calls) {
    assert.equal(c.headers['user-agent'], CC_USER_AGENT);
    assert.equal(c.headers.authorization, 'Bearer user_abcdefghijkl');
  }
  const usageCall = ff.calls.find((c) => c.path === '/alpha/usage/summary');
  assert.match(usageCall.search, /since=/);
  assert.match(usageCall.search, /orgId=org-42/);
});

test('缺字段不炸，仍然返回可用快照', async () => {
  const ff = fakeFetch({
    '/alpha/whoami': { org: { id: 'org-min' } },       // 没有 login
    '/alpha/billing/credits': {},                       // 全空
    '/alpha/billing/subscriptions': {},
    '/alpha/usage/summary': {},
  });
  const snap = await fetchQuota('user_minimal_xxxx', { fetchImpl: ff });
  assert.equal(snap.ok, true);
  assert.equal(snap.orgId, 'org-min');
  assert.equal(snap.displayName, null);
  assert.equal(snap.remaining, 0);
  assert.equal(snap.fiveHour, null);
  assert.equal(snap.weekly, null);
  assert.equal(snap.usage.totalTokens, 0);
});

test('whoami 缺少 org.id 视为查询失败', async () => {
  const ff = fakeFetch({ '/alpha/whoami': { org: {} } });
  const snap = await fetchQuota('user_noorg_xxxxxx', { fetchImpl: ff });
  assert.equal(snap.ok, false);
  assert.match(snap.error, /org\.id/);
});

test('org 为 null：仍解析成功，orgId 为 undefined，后续接口不带 orgId', async () => {
  const ff = fakeFetch({
    '/alpha/whoami': {
      success: true,
      user: { id: 'u-1', name: '主号', email: 'a@b.c', userName: 'demo-user' },
      org: null,
    },
    '/alpha/billing/credits': {
      credits: { monthlyCredits: 10, purchasedCredits: 5, freeCredits: 2.5 },
      windowLimits: { fiveHour: { used: 5, cap: 50 }, weekly: { used: 20, cap: 200 } },
    },
    '/alpha/billing/subscriptions': { data: { planId: 'pro', status: 'active', currentPeriodStart: '2026-09-01T00:00:00Z', currentPeriodEnd: 1800000000 } },
    '/alpha/usage/summary': { totalCost: 3, totalCount: 2, totalTokens: 999 },
  });
  const snap = await fetchQuota('user_orgnull_xxxxx', { fetchImpl: ff });

  assert.equal(snap.ok, true);
  assert.equal(snap.authInvalid, false);
  assert.equal(snap.orgId, undefined);          // org 缺失 → 不设 orgId
  assert.equal(snap.displayName, 'demo-user'); // 回退到 user.userName
  assert.equal(snap.remaining, 17.5);
  assert.equal(snap.fiveHour.percent, 10);
  assert.equal(snap.plan.planId, 'pro');
  assert.equal(snap.usage.totalTokens, 999);

  // 三个额度接口都必须被调用，且都不带 orgId 参数
  const paths = ff.calls.map((c) => c.path);
  assert.deepEqual(paths, ['/alpha/whoami', '/alpha/billing/credits', '/alpha/billing/subscriptions', '/alpha/usage/summary']);
  for (const c of ff.calls.slice(1)) {
    assert.ok(!c.search.includes('orgId'), `${c.path} 不应带 orgId: ${c.search}`);
  }
  // since 仍然照常带上
  assert.match(ff.calls.find((c) => c.path === '/alpha/usage/summary').search, /since=/);
});

test('org 有 id：三个额度接口仍带上 orgId', async () => {
  const ff = fakeFetch({
    '/alpha/whoami': { org: { id: 'org-99', login: 'acme' }, user: { userName: 'someone' } },
    '/alpha/billing/credits': {},
    '/alpha/billing/subscriptions': { data: { currentPeriodStart: '2026-09-01T00:00:00Z' } },
    '/alpha/usage/summary': {},
  });
  const snap = await fetchQuota('user_withorg_xxxx', { fetchImpl: ff });

  assert.equal(snap.ok, true);
  assert.equal(snap.orgId, 'org-99');
  assert.equal(snap.displayName, 'acme'); // 有 org 时 org.login 优先
  for (const c of ff.calls.slice(1)) {
    assert.match(c.search, /orgId=org-99/, `${c.path} 应带 orgId`);
  }
});

test('401 → authInvalid；403 也算', async () => {
  for (const status of [401, 403]) {
    const ff = fakeFetch({ '/alpha/whoami': { __status: status, body: { error: 'bad key user_supersecretvalue' } } });
    const snap = await fetchQuota('user_supersecretvalue', { fetchImpl: ff });
    assert.equal(snap.ok, false);
    assert.equal(snap.authInvalid, true, `HTTP ${status} 应标记 authInvalid`);
    assert.ok(!snap.error.includes('user_supersecretvalue'), '错误信息必须脱敏 key');
  }
});

test('500 → 查询失败但不算 authInvalid', async () => {
  const ff = fakeFetch({ '/alpha/whoami': { __status: 500, body: { error: 'boom' } } });
  const snap = await fetchQuota('user_boom_xxxxxxxxx', { fetchImpl: ff });
  assert.equal(snap.ok, false);
  assert.equal(snap.authInvalid, false);
});

test('resetAt 三种格式归一化正确', () => {
  assert.equal(normalizeResetAt(1700000000), 1700000000);                 // 秒级数字原样
  assert.equal(normalizeResetAt(1700000000000), 1700000000);              // 毫秒级 → /1000
  assert.equal(normalizeResetAt('1700000000'), 1700000000);               // 字符串数字
  assert.equal(normalizeResetAt('2026-09-01T00:00:00Z'), Math.floor(Date.parse('2026-09-01T00:00:00Z') / 1000)); // ISO
  assert.equal(normalizeResetAt(null), null);
  assert.equal(normalizeResetAt(undefined), null);
  assert.equal(normalizeResetAt('不是时间'), null);
});

test('parseWindow：cap 缺失时百分比为 null，不崩', () => {
  assert.deepEqual(parseWindow(null), null);
  assert.deepEqual(parseWindow({}), null);
  const w = parseWindow({ used: 5 });
  assert.equal(w.used, 5);
  assert.equal(w.cap, 0);
  assert.equal(w.percent, null);
  assert.equal(parseWindow({ used: 10, cap: 40 }).percent, 25);
  // 超额时百分比封顶 100，但 usedRatio 保持原值供调度判断
  assert.equal(parseWindow({ used: 50, cap: 40 }).percent, 100);
  assert.equal(parseWindow({ used: 50, cap: 40 }).usedRatio, 1.25);
});

test('超时（AbortError）被归一成查询失败', async () => {
  const impl = async () => {
    const e = new Error('aborted');
    e.name = 'AbortError';
    throw e;
  };
  const snap = await fetchQuota('user_timeout_xxxxxx', { fetchImpl: impl, timeoutMs: 10 });
  assert.equal(snap.ok, false);
  assert.equal(snap.authInvalid, false);
  assert.match(snap.error, /超时/);
});
