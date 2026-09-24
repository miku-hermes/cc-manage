// 批次 11：运维健壮性三项 —— 429 语义细化 / 亲和性让位 / 未捕获异常兜底
// 约定：这些用例在**改动前**的源码上必须变红（mutation check）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startTestGateway, request } from './helpers.mjs';
import {
  AFFINITY_YIELD_FLOOR,
  AFFINITY_YIELD_GAP,
  createScheduler,
  isRateLimitTimeout,
} from '../src/scheduler.mjs';
import { normalizeAccounts } from '../src/store.mjs';

const AUTH = (ctx) => ({ authorization: `Bearer ${ctx.localKey}`, 'content-type': 'application/json' });
const post = (ctx, path = '/v1/chat/completions', { headers = {}, body = '{}' } = {}) =>
  request(`${ctx.baseUrl}${path}`, { method: 'POST', headers: { ...AUTH(ctx), ...headers }, body });

// 上游实测的「超时被包装成 429」报文（2026-09-24 线上：副号1 被白冷却 60s）
const TIMEOUT_429 = '{"error":{"message":"Response timeout - request timed out","type":"rate_limit_error","input_tokens":0},"retry_after":5}';
// 真限流报文
const RATE_LIMIT_429 = '{"error":{"message":"Rate limit exceeded, retry later","type":"rate_limit"}}';

/** 只让某个 key 回 429（mock 的 quotaErrorKeys 是「按 key 指定 429 报文」的通用开关）。 */
const onlyAlpha429 = (body) => ({ quotaErrorKeys: ['user_test_alpha'], quotaErrorBody: body });
const acct = (ctx, key) => ctx.gateway.accounts.find((a) => a.key === key);

// ── 1~4：isRateLimitTimeout 的判据 ────────────────────────────────────
test('B11-1：429 + Response timeout → 判为超时型（不冷却）', () => {
  assert.equal(isRateLimitTimeout(429, TIMEOUT_429), true);
  assert.equal(isRateLimitTimeout(429, 'Response timeout - request timed out'), true);
  assert.equal(isRateLimitTimeout(429, '{"error":{"message":"响应超时"}}'), true);
  assert.equal(isRateLimitTimeout(429, 'upstream ETIMEDOUT'), true);
});

test('B11-2：429 + Rate limit exceeded → 判为真限流（要冷却）', () => {
  assert.equal(isRateLimitTimeout(429, '{"message":"Rate limit exceeded"}'), false);
  assert.equal(isRateLimitTimeout(429, RATE_LIMIT_429), false);
});

test('B11-3：只看 retry_after 字段不得判成超时（真限流也有它）', () => {
  assert.equal(isRateLimitTimeout(429, '{"retry_after":5}'), false);
  assert.equal(isRateLimitTimeout(429, '{"error":{"message":"too many requests"},"retry_after":5}'), false);
});

test('B11-4：只有 429 才判超时型（500/503 的超时不算）', () => {
  assert.equal(isRateLimitTimeout(500, 'timeout'), false);
  assert.equal(isRateLimitTimeout(503, 'Response timeout - request timed out'), false);
  assert.equal(isRateLimitTimeout(200, 'timeout'), false);
});

// ── 5：超时型 429 不冷却账号 ───────────────────────────────────────────
test('B11-5：超时型 429 不冷却账号（健康号不被白冷却 60s）', async (t) => {
  const ctx = await startTestGateway({
    accounts: [{ name: '账号A', key: 'user_test_alpha', enabled: true }],
    behavior: onlyAlpha429(TIMEOUT_429),
  });
  t.after(() => ctx.close());

  const res = await post(ctx);
  assert.equal(res.status, 429, '单账号池没有可换的号，429 原样透传');

  const rt = ctx.gateway.scheduler.runtime(acct(ctx, 'user_test_alpha'));
  assert.ok(!rt.rateLimitedUntil, '超时型 429 绝不能写 rateLimitedUntil（那是白冷却健康号）');
  assert.doesNotMatch(rt.lastError ?? '', /冷却 60 秒/, '不得记录「限流，冷却 60 秒」类文案');
  assert.match(rt.lastError ?? '', /响应超时/, '应如实记下「响应超时」');
});

// ── 6：超时型 429 也要换号（池里还有健康账号）─────────────────────────
test('B11-6：超时型 429 会换号重试 → 客户端拿到第二个健康账号的正常响应', async (t) => {
  const ctx = await startTestGateway({ behavior: onlyAlpha429(TIMEOUT_429) });
  t.after(() => ctx.close());

  const res = await post(ctx, '/v1/chat/completions', { body: JSON.stringify({ model: 'mock-model' }) });
  assert.equal(res.status, 200, `池里还有健康账号时不得让客户端吃 429，实际 ${res.status}: ${res.body.slice(0, 200)}`);
  assert.match(res.body, /\[DONE\]/, '第二个账号的正常响应必须完整透传');

  const calls = ctx.upstream.seen.filter((s) => s.url.startsWith('/v1/'));
  assert.equal(calls.filter((s) => String(s.headers.authorization ?? '').includes('user_test_alpha')).length, 1);
  assert.equal(calls.filter((s) => String(s.headers.authorization ?? '').includes('user_test_beta')).length, 1);
  assert.ok(!ctx.gateway.scheduler.runtime(acct(ctx, 'user_test_alpha')).rateLimitedUntil,
    '超时型 429 换号后，原账号仍不该被冷却');
});

// ── 7：真限流仍然冷却（60s 语义不变）─────────────────────────────────
test('B11-7：真限流（Rate limit exceeded）仍然写 60s 冷却，语义不变', async (t) => {
  const ctx = await startTestGateway({
    accounts: [{ name: '账号A', key: 'user_test_alpha', enabled: true }],
    behavior: onlyAlpha429(RATE_LIMIT_429),
  });
  t.after(() => ctx.close());

  const res = await post(ctx);
  assert.equal(res.status, 429);

  const rt = ctx.gateway.scheduler.runtime(acct(ctx, 'user_test_alpha'));
  assert.ok(rt.rateLimitedUntil, '真限流必须写 rateLimitedUntil');
  const cooldown = rt.rateLimitedUntil - Date.now();
  assert.ok(cooldown > 0 && cooldown <= 60_000, `冷却应在 60 秒内，实际 ${cooldown}ms`);
  assert.match(rt.lastError ?? '', /冷却 60 秒/, '真限流仍记录「冷却 60 秒」文案');
});

// ── 8：真限流也会换号 ─────────────────────────────────────────────────
test('B11-8：真限流也会换号重试 → 客户端拿到第二个健康账号的正常响应', async (t) => {
  const ctx = await startTestGateway({ behavior: onlyAlpha429(RATE_LIMIT_429) });
  t.after(() => ctx.close());

  const res = await post(ctx, '/v1/chat/completions', { body: JSON.stringify({ model: 'mock-model' }) });
  assert.equal(res.status, 200, `池里还有健康账号时不得让客户端吃 429，实际 ${res.status}: ${res.body.slice(0, 200)}`);
  assert.match(res.body, /\[DONE\]/);

  const rt = ctx.gateway.scheduler.runtime(acct(ctx, 'user_test_alpha'));
  assert.ok(rt.rateLimitedUntil, '被真限流的账号仍要被冷却（换号不等于放过它）');
});

// ── 9：没有别的可用账号时 429 仍然如实透传 ────────────────────────────
test('B11-9：单账号池遇到 429 → 原样透传 429（不得变成 502）', async (t) => {
  const ctx = await startTestGateway({
    accounts: [{ name: '账号A', key: 'user_test_alpha', enabled: true }],
    behavior: onlyAlpha429(TIMEOUT_429),
  });
  t.after(() => ctx.close());

  const res = await post(ctx);
  assert.equal(res.status, 429, `单账号池必须如实回 429，实际 ${res.status}: ${res.body.slice(0, 200)}`);
  assert.match(res.body, /Response timeout/i, '上游可操作文案必须保留');

  const calls = ctx.upstream.seen.filter((s) => s.url.startsWith('/v1/'));
  assert.equal(calls.length, 1, '没有可换的账号时不得重复打上游');
});

// ── 10~12：会话亲和性让位 ─────────────────────────────────────────────
function makeAccounts(list) {
  return normalizeAccounts(list);
}

function makeState() {
  return { accounts: {}, stats: { total: 0, errors: 0, totalTokens: 0, byAccount: {} } };
}

/** 只带 fiveHour（weekly 补一个完整的空窗口，避免「窗口缺失」被中性化）。 */
function quotaWith(fiveHour) {
  const w = (x) => (x ? { used: x.used, cap: x.cap, percent: x.cap ? (x.used / x.cap) * 100 : null, usedRatio: x.cap ? x.used / x.cap : null, resetAt: x.resetAt ?? null } : null);
  return { ok: true, fiveHour: w(fiveHour), weekly: w({ used: 0, cap: 100 }) };
}

test('B11-10：粘住账号剩余比过低 + 差距够大 → 会话让位给更充裕的账号', () => {
  const accounts = makeAccounts([
    { name: 'A', key: 'user_yield_a_xxxxxxx' },
    { name: 'B', key: 'user_yield_b_xxxxxxx' },
  ]);
  const s = createScheduler({ accounts, state: makeState() });
  s.recordQuota(accounts[0], quotaWith({ used: 90, cap: 100 }));  // A 剩 0.10
  s.recordQuota(accounts[1], quotaWith({ used: 10, cap: 100 }));  // B 剩 0.90
  const now = Date.now();
  s.setAffinity('sess-yield', accounts[0].keyId, now);            // 粘性钉在 A

  const { account } = s.select({ sessionId: 'sess-yield', now });
  assert.equal(account.name, 'B', 'A 只剩 10% 而 B 有 90% → 必须让位');
  assert.equal(s.getAffinity('sess-yield', now), accounts[1].keyId, '让位后粘性要重设到新账号');
});

test('B11-11：让位带滞回 —— 差距不足时绝不让位（防抖动）', () => {
  const accounts = makeAccounts([
    { name: 'A', key: 'user_hyst_a_xxxxxxx' },
    { name: 'B', key: 'user_hyst_b_xxxxxxx' },
  ]);
  const s = createScheduler({ accounts, state: makeState() });
  const now = Date.now();

  // ① A 剩 0.20（低于 FLOOR），B 剩 0.40 → 差距 0.20 < GAP → 保持粘性
  s.recordQuota(accounts[0], quotaWith({ used: 80, cap: 100 }));
  s.recordQuota(accounts[1], quotaWith({ used: 60, cap: 100 }));
  s.setAffinity('sess-hyst', accounts[0].keyId, now);
  assert.equal(s.select({ sessionId: 'sess-hyst', now }).account.name, 'A',
    '同样低于 FLOOR，但差距不足 GAP 时必须保持粘性（否则水位接近时会来回抖）');

  // ② B 涨到 0.60 → 差距 0.40 ≥ GAP → 让位
  s.recordQuota(accounts[1], quotaWith({ used: 40, cap: 100 }));
  assert.equal(s.select({ sessionId: 'sess-hyst', now }).account.name, 'B',
    '差距达到 GAP 后应让位');
});

test('B11-12：粘住账号已不可用 → 正常重挑，绝不因让位逻辑把它选回来', () => {
  const accounts = makeAccounts([
    { name: 'A', key: 'user_unavail_a_xxxx' },
    { name: 'B', key: 'user_unavail_b_xxxx' },
  ]);
  const s = createScheduler({ accounts, state: makeState() });
  const now = Date.now();
  s.recordQuota(accounts[0], quotaWith({ used: 100, cap: 100 })); // A 已耗尽 → 不可用
  s.recordQuota(accounts[1], quotaWith({ used: 50, cap: 100 }));
  s.setAffinity('sess-unavail', accounts[0].keyId, now);

  const { account } = s.select({ sessionId: 'sess-unavail', now });
  assert.notEqual(account.name, 'A', '不可用的粘住账号绝不能被选中');
  assert.equal(account.name, 'B');
  assert.equal(s.isAvailable(account, now), true, '选出来的账号必须是可用的');
  assert.equal(s.getAffinity('sess-unavail', now), accounts[1].keyId);

  // 让位路径不得绕过 isAvailable：A 可用但额度偏低 + 差距够大 → 让位给同样可用的 B
  s.recordQuota(accounts[0], quotaWith({ used: 90, cap: 100 }));  // A 剩 0.10（可用）
  s.recordQuota(accounts[1], quotaWith({ used: 10, cap: 100 }));
  s.setAffinity('sess-unavail', accounts[0].keyId, now);
  assert.equal(s.select({ sessionId: 'sess-unavail', now }).account.name, 'B');
});

// ── 13：进程级兜底处理器 ──────────────────────────────────────────────
test('B11-13：gateway.mjs 注册了 unhandledRejection / uncaughtException 兜底（含 log.error、退出与防重入）', () => {
  const src = fs.readFileSync(new URL('../gateway.mjs', import.meta.url), 'utf8');
  const mainAt = src.indexOf('if (isMain) {');
  assert.ok(mainAt > -1, '必须能定位到 gateway.mjs 的直接运行块');
  const main = src.slice(mainAt);

  assert.match(main, /process\.on\('unhandledRejection'/, '必须注册 unhandledRejection');
  assert.match(main, /process\.on\('uncaughtException'/, '必须注册 uncaughtException');

  const fatalAt = main.indexOf('const fatal = async');
  assert.ok(fatalAt > -1, '两个处理器必须共用同一个兜底处理体（fatal）');
  const fatal = main.slice(fatalAt);
  assert.match(fatal, /log\.error\(/, '处理器必须用 log.error 记录可诊断信息');
  assert.match(fatal, /reason\.message|err\.message|\.message/, '必须记录 message');
  assert.match(fatal, /\.stack/, '必须记录 stack');
  assert.match(fatal, /进程即将退出/, '必须有一行明确的「进程即将退出」标记');
  assert.match(fatal, /process\.exit\(1\)/, '必须走非零码退出，让容器拉起干净进程');
  assert.match(fatal, /if \(exiting\) return;/, '必须有防重入守卫');
  assert.match(fatal, /await stop\(\)/, '必须走已有的优雅关闭路径 stop()');
  assert.match(fatal, /try \{[\s\S]*\} catch \{/, '处理体必须包 try/catch（自身再抛也不能变成第二次未捕获）');
  assert.match(main, /let exiting = false/, '退出守卫必须在 SIGINT/SIGTERM 与两个兜底处理器之间共享');
  assert.match(main, /process\.on\('unhandledRejection',[^\n]*fatal\('unhandledRejection'/, 'unhandledRejection 必须接到 fatal');
  assert.match(main, /process\.on\('uncaughtException',[^\n]*fatal\('uncaughtException'/, 'uncaughtException 必须接到 fatal');
});

// ── 14：新增导出与带注释的阈值常量 ────────────────────────────────────
test('B11-14：scheduler.mjs 导出 isRateLimitTimeout 与带注释的让位阈值常量', () => {
  assert.equal(typeof isRateLimitTimeout, 'function', 'isRateLimitTimeout 必须导出');
  assert.equal(AFFINITY_YIELD_FLOOR, 0.25);
  assert.equal(AFFINITY_YIELD_GAP, 0.30);

  const src = fs.readFileSync(new URL('../src/scheduler.mjs', import.meta.url), 'utf8');
  const at = src.indexOf('export const AFFINITY_YIELD_FLOOR');
  assert.ok(at > -1, 'AFFINITY_YIELD_FLOOR 必须是导出常量');
  assert.ok(src.indexOf('export const AFFINITY_YIELD_GAP') > -1, 'AFFINITY_YIELD_GAP 必须是导出常量');
  const comment = src.slice(Math.max(0, at - 800), at);
  assert.match(comment, /粘性让位/, '阈值常量必须有注释说明');
  assert.match(comment, /FLOOR/, '注释要说明 FLOOR 的语义');
  assert.match(comment, /GAP/, '注释要说明 GAP 的语义');
});
