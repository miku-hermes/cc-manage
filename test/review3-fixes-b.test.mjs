// 第三轮审计遗留批次 B（B1–B12）的回归测试。
// 每条都先确认修复前是红的：并发额度刷新放大 / 探针每轮重打 / 缺字段窗口拿满分 /
// 上游点名超限不生效 / 5 hour 措辞不一致 / 换号不看打分 / 时钟回拨 / 过期快照 /
// 暂停不落盘 / 兼容分支走不到 / 透传统计撑大 / 无时区 ISO 被本地时区解释。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startTestGateway, request } from './helpers.mjs';
import {
  createScheduler,
  isQuotaError,
  isSnapshotStale,
  remainingRatio,
  quotaWindowHint,
} from '../src/scheduler.mjs';
import { normalizeAccounts } from '../src/store.mjs';
import { shouldProbeCredits } from '../src/credits-probe.mjs';
import { normalizeResetAt } from '../src/quota.mjs';
import { createAdaptivePoller } from '../src/poll.mjs';

const AUTH = (ctx, key = ctx.localKey) => ({ authorization: `Bearer ${key}`, 'content-type': 'application/json' });
const post = (ctx, p, { key = ctx.localKey, headers = {}, body = '{}' } = {}) =>
  request(`${ctx.baseUrl}${p}`, { method: 'POST', headers: { ...AUTH(ctx, key), ...headers }, body });

function makeState() {
  return { accounts: {}, stats: { total: 0, errors: 0, totalTokens: 0, byAccount: {} } };
}
const makeAccounts = (list) => normalizeAccounts(list);
// 完整窗口：used/cap 都齐全（构造时带上 parseWindow 会带出的 hasUsed/hasCap）
const w = (used, cap, extra = {}) => ({ used, cap, percent: (used / cap) * 100, usedRatio: used / cap, resetAt: null, exceeded: false, hasUsed: true, hasCap: true, ...extra });

// ── B1：撞额度错误时同一账号的并发刷新只跑一轮 ────────────────────────
test('B1：8 并发撞额度错误 → 额度接口调用被按账号去重（≤ 8 次，而非 8×4）', async (t) => {
  const ctx = await startTestGateway({
    // 用 mock 里有完整额度契约的 key：4 个接口都会真的被打，才能量出放大倍数
    accounts: [{ name: '单号', key: 'user_test_alpha', enabled: true }],
    behavior: { quotaError: true, delayMs: 400 },   // 让 8 个请求的响应集中在同一时刻
  });
  t.after(() => ctx.close());

  // 单账号池：不换号，每个请求都会走 refreshAccount(current)
  await Promise.all(Array.from({ length: 8 }, () => post(ctx, '/v1/chat/completions', {
    body: JSON.stringify({ model: 'mock-model', stream: false, messages: [{ role: 'user', content: 'hi' }] }),
  })));

  const v1 = ctx.upstream.seen.filter((s) => s.url.startsWith('/v1/'));
  const alpha = ctx.upstream.seen.filter((s) => s.url.startsWith('/alpha/'));
  assert.equal(v1.length, 8, `8 个请求都该打到上游，实际 ${v1.length}`);
  assert.ok(alpha.length <= 8,
    `同账号刷新必须去重：额度接口调用应 ≤ 8（1~2 轮），实际 ${alpha.length}（修复前 32）`);
});

// ── B2：探针 TTL + 失败指数退避 ──────────────────────────────────────
test('B2：TTL 内连续 5 轮 refreshAll 只探 1 次', async (t) => {
  const ctx = await startTestGateway({
    plans: { user_test_alpha: { monthlyCredits: 0.5, purchasedCredits: 0, freeCredits: 0, totalCost: 4 } },
  });
  t.after(() => ctx.close());

  for (let i = 0; i < 5; i++) await ctx.gateway.refreshAll();

  const probes = ctx.upstream.seen.filter((s) => s.url === '/v1/chat/completions');
  assert.equal(probes.length, 1, `TTL 内不得重复探，实际 ${probes.length}`);
});

test('B2：探针连续失败 3 次 → 下次允许时间按指数退避放大（≥ 2 × TTL）', async (t) => {
  let fakeNow = Date.now();
  const ctx = await startTestGateway({
    now: () => fakeNow,
    behavior: { notFound404: true },   // 探针请求一律 404（套餐不含模型/上游故障类失败）
    plans: { user_test_alpha: { monthlyCredits: 0.5, purchasedCredits: 0, freeCredits: 0, totalCost: 4 } },
  });
  t.after(() => ctx.close());

  const keyId = ctx.gateway.accounts.find((a) => a.name === '账号A').keyId;
  const TTL = 10 * 60 * 1000;

  await ctx.gateway.refreshAll();
  const s1 = ctx.gateway.probeState.get(keyId);
  assert.equal(s1.fails, 1, '第 1 次探针失败要记失败次数');
  assert.equal(s1.nextAt - s1.at, TTL, '首次失败先退避 1× TTL');

  fakeNow = s1.nextAt;                 // 到点
  await ctx.gateway.refreshAll();
  const s2 = ctx.gateway.probeState.get(keyId);
  assert.equal(s2.fails, 2);

  fakeNow = s2.nextAt;                 // 到点
  await ctx.gateway.refreshAll();
  const s3 = ctx.gateway.probeState.get(keyId);
  assert.equal(s3.fails, 3);
  assert.ok(s3.nextAt - s3.at >= 2 * TTL,
    `第 3 次失败后下次允许时间应 ≥ 2×TTL，实际 ${(s3.nextAt - s3.at) / 60000} 分钟`);

  const probes = ctx.upstream.seen.filter((s) => s.url === '/v1/chat/completions');
  assert.equal(probes.length, 3, '退避期内不得重打，实际探针 ' + probes.length + ' 次');
});

// ── B3：窗口字段缺失不得被算成 100% ─────────────────────────────────
test('B3：cap 缺失的 used=99 窗口 → ratio ≤ 0.5，select 选数据完整且更健康的账号', () => {
  const accounts = makeAccounts([
    { name: '缺字段', key: 'user_b3_broken_xxxxx' },
    { name: '健康', key: 'user_b3_healthy_xxxx' },
  ]);
  const s = createScheduler({ accounts, state: makeState() });
  const now = Date.now();
  // A：5h 只有 used=99（cap 缺失）；周窗口完整且空着
  const qA = { ok: true, fetchedAt: now, fiveHour: { used: 99, cap: undefined, usedRatio: null }, weekly: w(0, 100) };
  // B：5h 用了 30%，剩 0.7
  const qB = { ok: true, fetchedAt: now, fiveHour: w(30, 100), weekly: w(0, 100) };
  s.recordQuota(accounts[0], qA);
  s.recordQuota(accounts[1], qB);

  assert.ok(remainingRatio(qA) <= 0.5, `缺 cap 的窗口不能算成满分，实际 ${remainingRatio(qA)}`);
  assert.ok(s.remainingRatio(accounts[0], now) <= 0.5);
  assert.equal(s.select({ now }).account.name, '健康', '修复前缺字段账号 ratio=1.0 会被优先选中');
});

test('B3：used 缺失 {cap:100} → ratio 不得为 1.0（≤ 0.5）', () => {
  const now = Date.now();
  const q = { ok: true, fetchedAt: now, fiveHour: { cap: 100, used: undefined, usedRatio: null }, weekly: w(0, 100) };
  assert.ok(remainingRatio(q) <= 0.5, `used 缺失不能默认剩 100%，实际 ${remainingRatio(q)}`);
});

test('B3：全部窗口数据完整时 ratio / select 行为不回归', () => {
  const accounts = makeAccounts([
    { name: 'A', key: 'user_b3_reg_a_xxxxxx' },
    { name: 'B', key: 'user_b3_reg_b_xxxxxx' },
  ]);
  const s = createScheduler({ accounts, state: makeState() });
  const now = Date.now();
  const qA = { ok: true, fetchedAt: now, fiveHour: w(10, 100), weekly: w(10, 100) };
  const qB = { ok: true, fetchedAt: now, fiveHour: w(40, 100), weekly: w(40, 100) };
  assert.equal(remainingRatio(qA), 0.9);
  s.recordQuota(accounts[0], qA);
  s.recordQuota(accounts[1], qB);
  assert.equal(s.select({ now }).account.name, 'A', '完整数据时仍按剩余额度打分');
});

// ── B4：上游点名的 exceededWindow 必须参与可用性判定 ────────────────
test('B4：exceededWindow 点名 fiveHour 但对象缺失 → 不可用、不被选中', () => {
  const accounts = makeAccounts([
    { name: '被点名', key: 'user_b4_named_xxxxxx' },
    { name: '健康', key: 'user_b4_ok_xxxxxxxxx' },
  ]);
  const s = createScheduler({ accounts, state: makeState() });
  const now = Date.now();
  s.recordQuota(accounts[0], {
    ok: true, fetchedAt: now,
    fiveHour: null,                       // 上游省略了被点名的窗口对象
    weekly: w(0, 100),
    exceededWindow: 'fiveHour',
  });
  s.recordQuota(accounts[1], { ok: true, fetchedAt: now, fiveHour: w(10, 100), weekly: w(10, 100) });

  assert.equal(s.isAvailable(accounts[0], now), false, '上游点名的窗口超限必须判不可用');
  assert.equal(s.select({ now }).account.name, '健康', '不能把流量打到已知超限的账号');
});

test('B4：exceededWindow 点名 weekly 且对象存在 → 行为与现在一致（不回归）', () => {
  const accounts = makeAccounts([
    { name: '周满', key: 'user_b4_weekly_xxxxx' },
    { name: '健康', key: 'user_b4_weekly_ok_xx' },
  ]);
  const s = createScheduler({ accounts, state: makeState() });
  const now = Date.now();
  s.recordQuota(accounts[0], {
    ok: true, fetchedAt: now,
    fiveHour: w(0, 100),
    weekly: w(6, 6, { exceeded: true }),
    exceededWindow: 'weekly',
  });
  s.recordQuota(accounts[1], { ok: true, fetchedAt: now, fiveHour: w(10, 100), weekly: w(10, 100) });
  assert.equal(s.isAvailable(accounts[0], now), false);
  assert.equal(s.select({ now }).account.name, '健康');
});

// ── B5：429 措辞分类与本仓库自己的窗口点名口径对齐 ───────────────────
test('B5：5 hour / five-hour 写法必须被判成额度耗尽（与 quotaWindowHint 同口径）', () => {
  assert.equal(isQuotaError(429, '5 hour limit reached'), true);
  assert.equal(isQuotaError(429, 'five-hour window limit reached'), true);
  assert.equal(isQuotaError(429, 'You have exceeded your 5 hour window limit'), true);
  assert.equal(isQuotaError(429, '5h limit reached'), true);
  assert.equal(quotaWindowHint('5 hour limit reached'), 'fiveHour');
  assert.equal(quotaWindowHint('five-hour window limit reached'), 'fiveHour');

  // 明确不是额度语义的措辞不得被误判；既有断言不回归
  assert.equal(isQuotaError(429, 'hourly request limit'), false);
  assert.equal(isQuotaError(429, 'Rate limit exceeded, retry later'), false);
  assert.equal(isQuotaError(429, '{"error":{"type":"rate_limit"}}'), false);
  assert.equal(isQuotaError(429, 'Concurrency limit reached'), false);
});

// ── B6：重试换号必须按打分挑，而不是池内顺序第一个 ───────────────────
test('B6：三账号 ratio=[1,0.1,1]，A 回 503 → 重试落到高分账号（不是顺序上的 B）', async (t) => {
  const ctx = await startTestGateway({
    accounts: [
      { name: 'A', key: 'user_b6_a_xxxxxxxxxx', enabled: true },
      { name: 'B', key: 'user_b6_b_xxxxxxxxxx', enabled: true },
      { name: 'C', key: 'user_b6_c_xxxxxxxxxx', enabled: true },
    ],
    plans: {
      user_b6_a_xxxxxxxxxx: { monthlyCredits: 50, totalCost: 1, fiveHour: { used: 0, cap: 100 }, weekly: { used: 0, cap: 100 } },
      user_b6_b_xxxxxxxxxx: { monthlyCredits: 50, totalCost: 1, fiveHour: { used: 90, cap: 100 }, weekly: { used: 0, cap: 100 } },
      user_b6_c_xxxxxxxxxx: { monthlyCredits: 50, totalCost: 1, fiveHour: { used: 0, cap: 100 }, weekly: { used: 0, cap: 100 } },
    },
    behavior: { failNext5xx: 1 },
  });
  t.after(() => ctx.close());

  await ctx.gateway.refreshAll();
  const res = await post(ctx, '/v1/chat/completions', {
    body: JSON.stringify({ model: 'mock-model', stream: false, messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(res.status, 200, `首次 503 后应换号成功，实际 ${res.status}: ${res.body.slice(0, 200)}`);

  const v1 = ctx.upstream.seen.filter((s) => s.url.startsWith('/v1/'));
  assert.equal(v1.length, 2);
  assert.match(v1[0].headers.authorization, /user_b6_a_xxxxxxxxxx$/);
  assert.match(v1[1].headers.authorization, /user_b6_c_xxxxxxxxxx$/,
    '重试应按打分选 ratio=1 的 C，而不是池内顺序第一个且只剩 10% 的 B');
});

test('B6：没有其它可用账号时返回 502（单账号池 null 语义不回归）', async (t) => {
  const ctx = await startTestGateway({
    accounts: [{ name: '独苗', key: 'user_b6_solo_xxxxxxx', enabled: true }],
    behavior: { failNext5xx: 1 },
  });
  t.after(() => ctx.close());

  const res = await post(ctx, '/v1/chat/completions', {
    body: JSON.stringify({ model: 'mock-model', stream: false, messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(res.status, 502, '无其它可用账号时 pickRetryAccount 返回 null → 502（不会伪装成成功）');
});

// ── B7：时钟回拨不得让活跃判定长期为真 ───────────────────────────────
test('B7：墙钟回拨 1 小时 → isActive 不长期为真，nextDelayMs 回到空闲间隔', () => {
  let wall = 1_000_000_000;
  let mono = 5_000;
  const p = createAdaptivePoller({
    idleIntervalMs: 300000,
    activeIntervalMs: 60000,
    activeWindowMs: 300000,
    run: () => {},
    now: () => wall,
    monoNow: () => mono,
    setTimer: () => 0,
    clearTimer: () => {},
  });
  assert.equal(p.isActive(), false, '没有活动 → 空闲');

  p.touch();                               // 记录活动：mono=5000
  assert.equal(p.isActive(), true);

  mono += 6 * 60 * 1000;                   // 单调时钟推进 6 分钟 → 已出 5 分钟活跃窗
  wall -= 60 * 60 * 1000;                  // 同时墙钟回拨 1 小时（旧实现会恒活跃）
  assert.equal(p.isActive(), false, '墙钟回拨不得让活跃判定恒真');
  assert.equal(p.nextDelayMs(), 300000, '应回到空闲间隔（而非 60s 活跃间隔）');
});

test('B7：正常活动仍判活跃（不回归）；老持久化缺单调基准按不活跃处理', () => {
  let mono = 1000;
  const p = createAdaptivePoller({
    idleIntervalMs: 300000, activeIntervalMs: 60000, activeWindowMs: 300000,
    run: () => {}, now: () => 1_000_000, monoNow: () => mono, setTimer: () => 0, clearTimer: () => {},
  });
  p.touch();
  assert.equal(p.isActive(), true);
  assert.equal(p.nextDelayMs(), 60000);
  mono += 4 * 60 * 1000;
  assert.equal(p.isActive(), true, '仍在 5 分钟活跃窗内');
  mono += 2 * 60 * 1000;
  assert.equal(p.isActive(), false, '超过活跃窗后判空闲');

  // 老 state 只存了墙钟：没有单调基准 → 按不活跃，绝不拿墙钟差喂 isActive
  p.restoreActivity({ lastActivityAt: Date.now() });
  assert.equal(p.lastActivityMonoAt, null);
  assert.equal(p.isActive(), false, '缺失单调基准必须按不活跃处理');
});

// ── B8：过期快照不得抢流量 ───────────────────────────────────────────
test('B8：A 快照 24 小时前（ratio 0.9）、B 新鲜（0.6）→ select 选 B', () => {
  const accounts = makeAccounts([
    { name: '旧快照', key: 'user_b8_stale_xxxxxxx' },
    { name: '新鲜', key: 'user_b8_fresh_xxxxxxx' },
  ]);
  const s = createScheduler({ accounts, state: makeState() });
  const now = Date.now();
  s.recordQuota(accounts[0], { ok: true, fetchedAt: now - 24 * 3600 * 1000, fiveHour: w(10, 100), weekly: w(10, 100) });
  s.recordQuota(accounts[1], { ok: true, fetchedAt: now, fiveHour: w(40, 100), weekly: w(40, 100) });
  assert.equal(s.select({ now }).account.name, '新鲜', '过期快照 ratio 降为中性 0.5，不得抢过新鲜账号');
});

test('B8：isSnapshotStale 判据 + 都新鲜时行为不回归', () => {
  const now = Date.now();
  assert.equal(isSnapshotStale(null, now), true, '没快照 → 过期');
  assert.equal(isSnapshotStale({ ok: true }, now), true, 'fetchedAt 缺失 → 过期');
  assert.equal(isSnapshotStale({ fetchedAt: 'x' }, now), true, '非有限数 → 过期');
  assert.equal(isSnapshotStale({ fetchedAt: now }, now), false);
  assert.equal(isSnapshotStale({ fetchedAt: now - 25 * 60 * 1000 }, now), true, '超过默认 20 分钟 → 过期');
  assert.equal(isSnapshotStale({ fetchedAt: now - 1000 }, now, 100), true, '调用方传入阈值生效');

  const accounts = makeAccounts([
    { name: 'A', key: 'user_b8_a_xxxxxxxxxxx' },
    { name: 'B', key: 'user_b8_b_xxxxxxxxxxx' },
  ]);
  const s = createScheduler({ accounts, state: makeState() });
  s.recordQuota(accounts[0], { ok: true, fetchedAt: now, fiveHour: w(10, 100), weekly: w(10, 100) });
  s.recordQuota(accounts[1], { ok: true, fetchedAt: now, fiveHour: w(40, 100), weekly: w(40, 100) });
  assert.equal(s.select({ now }).account.name, 'A', '都新鲜时仍按剩余额度打分');
});

// ── B9：代理路径的额度暂停要落盘（且只在状态变化时写）───────────────
test('B9：撞额度耗尽 → data/state.json 里该账号 pausedUntil 非 null', async (t) => {
  const ctx = await startTestGateway({
    accounts: [{ name: '单号', key: 'user_b9_persist_xxxx', enabled: true }],
    behavior: { quotaError: true },
  });
  t.after(() => ctx.close());

  const res = await post(ctx, '/v1/chat/completions', {
    body: JSON.stringify({ model: 'mock-model', stream: false, messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(res.status, 402);

  const keyId = ctx.gateway.accounts[0].keyId;
  const onDisk = JSON.parse(fs.readFileSync(ctx.gateway.store.stateFile, 'utf8'));
  assert.ok(onDisk.accounts[keyId], '账号运行期状态必须落盘');
  assert.ok(onDisk.accounts[keyId].pausedUntil > 0,
    `额度暂停必须写进 state.json（重启不丢），实际 ${onDisk.accounts[keyId].pausedUntil}`);
});

test('B9：连续多次撞同一错误不产生重复写盘（写入次数有界）', async (t) => {
  const ctx = await startTestGateway({
    accounts: [{ name: '单号', key: 'user_b9_writes_xxxxx', enabled: true }],
    behavior: { quotaError: true, delayMs: 300 },
  });
  t.after(() => ctx.close());

  let writes = 0;
  const orig = ctx.gateway.store.saveState.bind(ctx.gateway.store);
  ctx.gateway.store.saveState = () => { writes++; return orig(); };

  await Promise.all(Array.from({ length: 8 }, () => post(ctx, '/v1/chat/completions', {
    body: JSON.stringify({ model: 'mock-model', stream: false, messages: [{ role: 'user', content: 'hi' }] }),
  })));

  assert.ok(writes >= 1, '首次暂停必须落盘');
  assert.ok(writes <= 2, `同一账号的连续额度错误只该写 1 次（有界），实际 ${writes} 次`);
});

// ── B10：belowThreshold 的「顶层兼容老快照」分支 ─────────────────────
test('B10：credits 对象存在就只看它；不存在才回退顶层 belowThreshold', () => {
  // 老快照：没有 credits 对象，顶层 belowThreshold 必须生效
  assert.equal(shouldProbeCredits({ ok: true, remaining: 50, belowThreshold: true }, 1.0), true);
  // credits 存在且为 false → 以 credits 为准，不能被顶层 true 覆盖
  assert.equal(shouldProbeCredits({ ok: true, remaining: 50, credits: { belowThreshold: false }, belowThreshold: true }, 1.0), false);
  // credits 存在但缺 belowThreshold 字段 → 只看 credits，不回退顶层（修复前 `??` 会回退 → true）
  assert.equal(shouldProbeCredits({ ok: true, remaining: 50, credits: {}, belowThreshold: true }, 1.0), false,
    'credits 对象存在时不得回退顶层 belowThreshold');
  // credits 存在且为 true → 生效
  assert.equal(shouldProbeCredits({ ok: true, remaining: 50, credits: { belowThreshold: true }, belowThreshold: false }, 1.0), true);
});

// ── B11：透传统计按固定桶聚合，条目数不随客户端 key 数增长 ───────────
test('B11：200 个不同自造 key 透传 → stats.byAccount 条目数有界、/api/status 体积稳定', async (t) => {
  const ctx = await startTestGateway({ config: { allowPassthrough: true } });
  t.after(() => ctx.close());

  const send = (i) => post(ctx, '/v1/chat/completions', {
    key: `user_evil_${String(i).padStart(4, '0')}`,
    body: JSON.stringify({ model: 'mock-model', stream: false, messages: [{ role: 'user', content: 'hi' }] }),
  });

  for (let i = 0; i < 10; i++) await send(i);
  const small = JSON.parse((await request(`${ctx.baseUrl}/api/status`)).body);

  for (let i = 10; i < 200; i++) await send(i);
  const big = JSON.parse((await request(`${ctx.baseUrl}/api/status`)).body);

  const limit = ctx.gateway.accounts.length + 2;
  assert.ok(Object.keys(big.stats.byAccount).length <= limit,
    `byAccount 条目必须与池内账号数成正比（≤ ${limit}），实际 ${Object.keys(big.stats.byAccount).length}`);
  assert.ok(Object.keys(big.stats.byAccount).includes('__passthrough__'), '透传统一归固定桶');
  assert.ok(JSON.stringify(big).length <= JSON.stringify(small).length * 2 + 200,
    '/api/status 响应体不得随历史 key 数线性增长');
});

// ── B12：无时区 ISO 的 resetAt 按 UTC 解释 ──────────────────────────
test('B12：无时区 ISO 字符串按 UTC 解释（与时区无关）', () => {
  assert.equal(normalizeResetAt('2026-09-22T12:00:00') * 1000, Date.UTC(2026, 8, 22, 12, 0, 0));
  // 带时区的字符串行为不变
  assert.equal(normalizeResetAt('2026-09-22T12:00:00Z') * 1000, Date.UTC(2026, 8, 22, 12, 0, 0));
  assert.equal(normalizeResetAt('2026-09-22T20:00:00+08:00') * 1000, Date.UTC(2026, 8, 22, 12, 0, 0));
  assert.equal(normalizeResetAt('2026-09-22T20:00:00+0800') * 1000, Date.UTC(2026, 8, 22, 12, 0, 0));
});

test('B12：同一无时区字符串在 TZ=UTC 与 TZ=Asia/Shanghai 下解析结果相同', () => {
  const quotaUrl = new URL('../src/quota.mjs', import.meta.url).href;
  const script = `import(${JSON.stringify(quotaUrl)}).then(m=>process.stdout.write(String(m.normalizeResetAt('2026-09-22T12:00:00'))))`;
  const runInTz = (tz) => execFileSync(process.execPath, ['-e', script], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, TZ: tz },
    encoding: 'utf8',
  }).trim();
  const utc = runInTz('UTC');
  const shanghai = runInTz('Asia/Shanghai');
  assert.equal(utc, shanghai, `跨时区必须一致（UTC=${utc}, Asia/Shanghai=${shanghai}）`);
  assert.equal(Number(utc) * 1000, Date.UTC(2026, 8, 22, 12, 0, 0));
});
