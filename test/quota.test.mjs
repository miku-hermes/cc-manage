// §8-1 额度查询：注入假 fetch，离线可跑
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchQuota, normalizeResetAt, parseWindow, CC_USER_AGENT } from '../src/quota.mjs';
import { remainingRatio } from '../src/scheduler.mjs';

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
  assert.deepEqual(snap.credits, {
    monthlyCredits: 30, purchasedCredits: 12.5, freeCredits: 7.5, remaining: 50,
    // 官方低余额字段：没配阈值时 threshold=0、belowThreshold=false
    belowThreshold: false, creditThreshold: null,
  });
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

test('官方窗口超限标记：exceeded（逐窗口布尔）+ exceeded（顶层窗口名）如实解析', async () => {
  // 线上原样：副号 weekly 6.003/6 → 顶层 exceeded="weekly"、weekly.exceeded=true；
  // 主号什么都正常时顶层是 null。这是上游的**权威**判据，比我们反推更可信。
  const ff = fakeFetch({
    ...HAPPY,
    '/alpha/billing/credits': {
      credits: { monthlyCredits: 4, purchasedCredits: 0, freeCredits: 0, belowThreshold: false, creditThreshold: 0 },
      windowLimits: {
        limited: true, exceeded: 'weekly',
        fiveHour: { used: 0, cap: 3, resetAt: 0, exceeded: false },
        weekly: { used: 6.0031816596, cap: 6, resetAt: 1700000000000, exceeded: true },
      },
    },
  });
  const snap = await fetchQuota('user_exceeded_xxxxx', { fetchImpl: ff });
  assert.equal(snap.exceededWindow, 'weekly', '顶层 exceeded 是窗口名');
  assert.equal(snap.weekly.exceeded, true);
  assert.equal(snap.fiveHour.exceeded, false);
  assert.equal(snap.weekly.resetAt, 1700000000, '毫秒 resetAt 仍要归一到秒');

  // 上游没有窗口超限时：exceededWindow 必须是 null，不能把 null 当成某个窗口名
  const ff2 = fakeFetch({
    ...HAPPY,
    '/alpha/billing/credits': {
      credits: { monthlyCredits: 9, purchasedCredits: 0, freeCredits: 0 },
      windowLimits: { limited: true, exceeded: null, fiveHour: { used: 0, cap: 3 }, weekly: { used: 1, cap: 6 } },
    },
  });
  const snap2 = await fetchQuota('user_ok_yyyyyyyyy', { fetchImpl: ff2 });
  assert.equal(snap2.exceededWindow, null);
  assert.equal(snap2.weekly.exceeded, false, '缺字段时按未超限处理');
});

test('官方低余额字段：belowThreshold / creditThreshold 如实解析（社区实现用它判「能不能用」）', async () => {
  // 形状来自线上真实报文：credits:{belowThreshold, creditThreshold, monthlyCredits, ...}
  // codex-router（3.8k★）直接拿 belowThreshold 当可用性判据：
  //   available: credits?.belowThreshold !== true
  // 实测本机两个账号 creditThreshold=0（未配置）→ belowThreshold=false，
  // 所以网关只把它当**加分信号**：为真时必定主动探一次余额。
  const ff = fakeFetch({
    ...HAPPY,
    '/alpha/billing/credits': {
      credits: { belowThreshold: true, creditThreshold: 0.5, monthlyCredits: 0.3, purchasedCredits: 0, freeCredits: 0 },
      windowLimits: { fiveHour: { used: 0, cap: 3 }, weekly: { used: 0, cap: 6 } },
    },
  });
  const snap = await fetchQuota('user_lowbal_xxxxx', { fetchImpl: ff });
  assert.equal(snap.credits.belowThreshold, true, '官方标记必须原样带出');
  assert.equal(snap.credits.creditThreshold, 0.5);
  assert.equal(snap.remaining, 0.3);

  // 只有字符串 'true' / 非布尔值等垃圾输入时不得误判为真
  const ff2 = fakeFetch({
    ...HAPPY,
    '/alpha/billing/credits': { credits: { belowThreshold: 'yes', creditThreshold: 'nope', monthlyCredits: 5 } },
  });
  const snap2 = await fetchQuota('user_lowbal_yyyyy', { fetchImpl: ff2 });
  assert.equal(snap2.credits.belowThreshold, false, "只认严格的布尔 true");
  assert.equal(snap2.credits.creditThreshold, null, '非数字阈值置 null');
});

test('缺字段不炸，仍然返回可用快照', async () => {
  const warns = [];
  const ff = fakeFetch({
    '/alpha/whoami': { org: { id: 'org-min' } },       // 没有 login
    '/alpha/billing/credits': {},                       // 全空
    '/alpha/billing/subscriptions': {},
    '/alpha/usage/summary': {},
  });
  const snap = await fetchQuota('user_minimal_xxxx', { fetchImpl: ff, log: { warn: (m) => warns.push(m) } });
  assert.equal(snap.ok, true);
  assert.equal(snap.orgId, 'org-min');
  assert.equal(snap.displayName, null);
  assert.equal(snap.remaining, 0);
  assert.equal(snap.fiveHour, null);
  assert.equal(snap.weekly, null);
  assert.equal(snap.usage.totalTokens, 0);
  // M4：ok 但两个判定窗口都缺 → 中性打分 + 一条 warn（不能静默当成满分账号）
  assert.equal(remainingRatio(snap), 0.5);
  assert.ok(warns.some((w) => /windowLimits|窗口/.test(w)), `必须 warn 窗口缺失，实际 ${JSON.stringify(warns)}`);
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

test('#3：401 → authInvalid；403 不再算（403 = 模型/套餐限制，与 key 有效性无关）', async () => {
  const ff401 = fakeFetch({ '/alpha/whoami': { __status: 401, body: { error: 'bad key user_supersecretvalue' } } });
  const snap401 = await fetchQuota('user_supersecretvalue', { fetchImpl: ff401 });
  assert.equal(snap401.ok, false);
  assert.equal(snap401.authInvalid, true, '401 才是鉴权失效');
  assert.ok(!snap401.error.includes('user_supersecretvalue'), '错误信息必须脱敏 key');

  const ff403 = fakeFetch({ '/alpha/whoami': { __status: 403, body: { error: 'MODEL_NOT_IN_PLAN' } } });
  const snap403 = await fetchQuota('user_supersecretvalue', { fetchImpl: ff403 });
  assert.equal(snap403.ok, false);
  assert.equal(snap403.authInvalid, false, '403 不得标记 authInvalid（否则额度轮询会误停有效账号）');
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

test('月度分母取整：推算出的 10.034 要变成整数 10（假精度会让人以为还剩钱能用）', async () => {
  // 主号线上真值：花 9.936、剩 0.098 → 推算分母 10.034。面板写「9.94 / 10.03」
  // 看着像还剩 0.09 可用，而实测那点余额连一次请求都付不起。
  const ff = fakeFetch({
    ...HAPPY,
    '/alpha/billing/credits': { credits: { monthlyCredits: 0.098, purchasedCredits: 0, freeCredits: 0 } },
    '/alpha/billing/subscriptions': { data: { planId: 'individual-go', status: 'active', currentPeriodEnd: '2026-10-11T11:41:14Z' } },
    '/alpha/usage/summary': { totalCost: 9.936, totalCount: 6000, totalTokens: 737095478 },
  });
  const snap = await fetchQuota('user_abcdefghijkl', { baseUrl: 'https://api.commandcode.ai', fetchImpl: ff });

  assert.equal(snap.monthly.cap, 10, `分母该是整数 10，实际 ${snap.monthly.cap}`);
  assert.equal(Number.isInteger(snap.monthly.cap), true, '分母必须是整数（官方额度口径）');
  assert.ok(snap.monthly.percent > 99, `取整后仍要 >= 99，否则「月额度已用完」判据失效: ${snap.monthly.percent}`);
  assert.equal(snap.monthly.used, 9.936, '花了多少是事实，不许改');
  assert.equal(snap.monthly.resetAt, Math.floor(Date.parse('2026-10-11T11:41:14Z') / 1000));
});
