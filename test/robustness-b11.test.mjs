// 批次 11：运维健壮性三项 —— 429 语义细化 / 亲和性让位 / 未捕获异常兜底
// 约定：这些用例在**改动前**的源码上必须变红（mutation check）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { startTestGateway, request, waitFor, allocPort, makeTmpDir } from './helpers.mjs';
import { startMockUpstream } from '../mocks/mock-cc-upstream.mjs';
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

// ── 13：进程级兜底处理器（B20：源码文本断言 → 真·行为测试）──────────────
/**
 * 原实现读 gateway.mjs 源码连续做 12 次 assert.match（process.on('unhandledRejection'…），
 * 从未真正触发过一次未处理的 rejection：处理器接错了、fatal 里少一句 process.exit(1)、
 * 或者在 process.exit 之前没 await stop()，正则照样全绿。
 *
 * 现在起一个**真的 gateway 进程**（把 gateway.mjs 复制进临时目录当 ROOT，src/ 软链回仓库，
 * 加载的是同一份源码），注入未处理的 rejection，端到端断言：
 *   1) 退出码 1（非零，交容器 restart: unless-stopped 拉起）；
 *   2) 输出里有事件类型 / 原始 message / 堆栈；
 *   3) 退出发生在 stop() **之后** —— 用一个在途代理请求做探针：stop() 会等它自然跑完
 *      （server.close 等连接关闭），所以「客户端拿到完整 200」+「退出时间明显晚于 fatal
 *      日志时间戳」两条同时成立，才说明退出前真的走了优雅关闭，而不是直接 process.exit。
 */
const CAN_SPAWN_NODE = (() => {
  try { return spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' }).error == null; } catch { return false; }
})();

/**
 * 原实现读 gateway.mjs 源码连续做 13 次 assert.match（process.on('unhandledRejection'…），
 * 从未真正触发过一次进程级错误：处理器接错了、fatal 里少一句 process.exit(1)、或者在
 * process.exit 之前没 await stop()，正则照样全绿。现在起一个**真的 gateway 进程**（把
 * gateway.mjs 复制进临时目录当 ROOT，src/ 软链回仓库，加载的是同一份源码），等一个在途
 * 代理请求真的打到上游后注入进程级错误，端到端断言：
 *   1) 退出码 1（非零，交容器 restart: unless-stopped 拉起）；
 *   2) 输出里有事件类型 / 原始 message / 堆栈；
 *   3) 退出发生在 stop() **之后** —— 用「客户端拿到完整 200」+「退出时刻明显晚于 fatal
 *      日志时刻」两条同时成立来证明：直接 process.exit(1) 会把在途连接拦腰掐断。
 * 两条注册入口（unhandledRejection / uncaughtException）共用同一个 fatal，故各跑一遍。
 */
async function exerciseFatalPath({ injectorBody, expectTag, expectMessage }) {
  const dir = makeTmpDir();
  // gateway.mjs 的 ROOT 由自身路径决定（config/ 与 data/ 都落在同一目录）→ 复制进临时目录，
  // 测试就不必往仓库根写 data/ 与 config/；src/ 软链回仓库，加载的是同一份源码。
  fs.copyFileSync(new URL('../gateway.mjs', import.meta.url), path.join(dir, 'gateway.mjs'));
  fs.symlinkSync(new URL('../src/', import.meta.url).pathname, path.join(dir, 'src'), 'dir');
  fs.writeFileSync(path.join(dir, 'accounts.json'),
    JSON.stringify({ accounts: [{ name: 'A', key: 'user_test_alpha', enabled: true }] }));
  fs.writeFileSync(path.join(dir, 'keys.json'),
    JSON.stringify({ keys: [{ name: 'c', key: 'sk-cg-testkey123' }] }));

  // 注入器：等标记文件出现后，在定时器回调里制造进程级错误（boom 只是个具名帧，便于断言堆栈）。
  const marker = path.join(dir, 'trigger');
  const injector = path.join(dir, 'inject.mjs');
  fs.writeFileSync(injector, `
import fs from 'node:fs';
const marker = process.env.B20_TRIGGER_FILE;
function boom() { ${injectorBody} }
const iv = setInterval(() => {
  if (marker && fs.existsSync(marker)) { clearInterval(iv); boom(); }
}, 10);
`);

  const upstream = await startMockUpstream({ behavior: { delayMs: 500 } });
  const port = await allocPort();
  const child = spawn(process.execPath, ['--import', injector, path.join(dir, 'gateway.mjs')], {
    cwd: dir,
    env: {
      ...process.env,
      GATEWAY_HOST: '127.0.0.1',
      GATEWAY_PORT: String(port),
      UPSTREAM_PROXY_URL: upstream.url,
      CC_API_BASE: upstream.url,
      LOG_LEVEL: 'info',
      B20_TRIGGER_FILE: marker,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { out += c; });
  const closed = new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal, at: Date.now() })));

  try {
    await waitFor(() => /已启动/.test(out) || /Error:/.test(out), {
      timeoutMs: 20000, intervalMs: 20, label: '子进程 gateway 应启动成功',
    });
    assert.match(out, /已启动/, `子进程必须真的启动，实际输出：${out.slice(0, 600)}`);

    // 在途请求：上游要 ~500ms 才回完。stop() 必须等它跑完（这也是「退出发生在 stop() 之后」
    // 的探针：直接 process.exit(1) 会把这条连接掐断，客户端拿不到完整 200）。
    const inflight = request(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer sk-cg-testkey123', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'mock-model' }),
    });
    // 先等网关真的收到并转发了这个请求再注入：否则它可能还躺在 accept 队列里，
    // stop() 的 server.close() 会连队列一起 RST，测出来变成 ECONNRESET 而不是「优雅关闭」。
    await waitFor(() => upstream.requestsTo((r) => r.url.startsWith('/v1/')).length > 0, {
      timeoutMs: 5000, intervalMs: 5, label: '网关应收到并转发这个在途请求',
    });
    fs.writeFileSync(marker, 'go');

    const res = await inflight;
    const resolvedAt = Date.now();
    assert.equal(res.status, 200, 'stop() 必须等完在途请求，不能拦腰掐断');
    assert.match(res.body, /mock/, '在途请求必须拿到完整响应体');

    const { code, signal, at: exitAt } = await closed;
    assert.equal(signal, null, '必须是正常退出（process.exit），不是被信号杀掉');
    assert.equal(code, 1, '兜底路径必须以非零码退出');

    assert.ok(out.includes(expectTag), `必须记下事件类型 ${expectTag}，实际输出尾部：${out.slice(-800)}`);
    assert.ok(out.includes(expectMessage), `必须记下原始错误 message，实际输出尾部：${out.slice(-800)}`);
    assert.match(out, /进程即将退出/, '必须有明确的「进程即将退出」标记');
    assert.match(out, /at boom \(/, '必须记下堆栈（含抛出点）');
    assert.equal((out.match(/进程即将退出/g) ?? []).length, 1,
      '兜底处理体必须防重入（exiting 守卫）：一次运行只允许记一条「进程即将退出」');

    const fatalLine = out.split('\n').find((l) => l.includes('进程即将退出'));
    const fatalTs = Date.parse(fatalLine.slice(0, fatalLine.indexOf(' ')));
    assert.ok(Number.isFinite(fatalTs), `必须能从日志时间戳解析出 fatal 时刻：${fatalLine}`);
    assert.ok(resolvedAt > fatalTs, '在途请求必须在 fatal 之后才跑完（证明 stop() 真的等了在途响应）');
    assert.ok(exitAt - fatalTs >= 200,
      `退出必须发生在 stop() 之后：fatal→exit 只有 ${exitAt - fatalTs}ms，而在途请求要 ~500ms`);
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    await upstream.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('B11-13：进程级兜底真的走行为——先优雅停止、再以退出码 1 退出（rejection 与 exception）', async (t) => {
  if (!CAN_SPAWN_NODE) return t.skip('环境禁止 spawn 子进程（沙箱 seccomp EPERM）');

  // ① 未处理的 rejection（process.on('unhandledRejection') 注册入口）
  await exerciseFatalPath({
    injectorBody: "void Promise.reject(new Error('B20 injected unhandled rejection'));",
    expectTag: '[unhandledRejection]',
    expectMessage: 'B20 injected unhandled rejection',
  });

  // ② 未捕获的异常（process.on('uncaughtException') 注册入口，共用同一个 fatal 处理体）
  await exerciseFatalPath({
    injectorBody: "throw new Error('B20 injected uncaught exception');",
    expectTag: '[uncaughtException]',
    expectMessage: 'B20 injected uncaught exception',
  });
});

// ── 14：新增导出与带注释的阈值常量 ────────────────────────────────────
test('B11-14：scheduler.mjs 导出的让位阈值常量（读运行时值，不从源码正则抠）', () => {
  // B20：断言注释文字（「粘性让位」/FLOOR/GAP 必须出现在注释里）没有意义，已删除；
  // 「常量必须是导出的」由上面的 import 直接保证（导入失败整个文件就红了），
  // 也不再从源码里 indexOf('export const …')。真正有意义的是**取值**：
  assert.equal(typeof isRateLimitTimeout, 'function', 'isRateLimitTimeout 必须导出');
  assert.equal(AFFINITY_YIELD_FLOOR, 0.25);
  assert.equal(AFFINITY_YIELD_GAP, 0.30);
});
