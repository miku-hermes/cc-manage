// A 组代码审查回归（审查#1~#15 的后端部分）：每条 bug 至少一个回归测试。
// 约定：这些用例在**未修复**的源码上必须全部失败（mutation check），修复后全绿。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { startTestGateway, request, sleep, makeTmpDir } from './helpers.mjs';
import { createLoginLimiter, createSessionSigner, hashPassword, verifyPassword } from '../src/auth.mjs';
import { createScheduler, remainingRatio } from '../src/scheduler.mjs';
import { parseWindow } from '../src/quota.mjs';
import { createStore } from '../src/store.mjs';
import { keyIdOf } from '../src/log.mjs';

const tick = () => new Promise((r) => setImmediate(r));
const makeState = () => ({ accounts: {}, stats: { total: 0, errors: 0, totalTokens: 0, byAccount: {} } });

/** 初始化后台管理员并返回 session cookie（每个用例独立网关）。 */
async function setupAdmin(ctx, user = 'admin', pass = 'hunter2-secret') {
  const res = await request(`${ctx.baseUrl}/api/auth/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: user, password: pass }),
  });
  assert.equal(res.status, 201, `setup 应成功，实际 ${res.status}: ${res.body}`);
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const cookie = (list.find((c) => c.startsWith('cc_session=')) ?? '').split(';')[0];
  assert.ok(cookie, 'setup 应下发 session cookie');
  return cookie;
}

function postV1(ctx, body = { model: 'mock-model' }) {
  return request(`${ctx.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ctx.localKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ── 审查#1：peekBody 放行后仍挂着 data 监听器，chunks 随整个请求体膨胀 ──────────
test('回归#1a：peekBody 放行后摘掉全部请求监听器，peek 缓冲不再随请求体增长', async () => {
  const { peekBody, BODY_PEEK_BYTES } = await import('../gateway.mjs');
  const req = new PassThrough();
  const done = peekBody(req, BODY_PEEK_BYTES, { match: (cs) => cs.length >= 1, idleMs: 5000 });
  req.write(Buffer.alloc(1024, 0x61));
  const peeked = await done;
  const kept = Buffer.concat(peeked.chunks).length;
  assert.equal(req.listenerCount('data'), 0, '放行时必须移除 data 监听器');
  assert.equal(req.listenerCount('end'), 0, 'end/error/aborted/close 也要摘干净');

  for (let i = 0; i < 8; i++) req.write(Buffer.alloc(1024, 0x62));
  await tick();
  assert.equal(Buffer.concat(peeked.chunks).length, kept, '放行后不得继续把请求体缓冲进 peek 的 chunks');
});

test('回归#1b：peek 缓冲到 BODY_PEEK_BYTES 即停止收集（硬上限）', async () => {
  const { peekBody, BODY_PEEK_BYTES } = await import('../gateway.mjs');
  const req = new PassThrough();
  const done = peekBody(req, BODY_PEEK_BYTES, { match: () => false, idleMs: 5000 });
  const quarter = Math.ceil(BODY_PEEK_BYTES / 4);
  for (let i = 0; i < 4; i++) {
    req.write(Buffer.alloc(quarter, 0x61));
    await tick();
  }
  const peeked = await done;
  const kept = Buffer.concat(peeked.chunks).length;
  assert.ok(kept <= BODY_PEEK_BYTES + quarter, `peek 缓冲必须封顶（最多超出一个 chunk），实际 ${kept}`);

  for (let i = 0; i < 8; i++) req.write(Buffer.alloc(quarter, 0x62));
  await tick();
  assert.equal(Buffer.concat(peeked.chunks).length, kept, '到上限后必须停止收集');
});

// ── 审查#3（限速半）：轮换用户名绕过用户名锁，无限触发 scrypt ──────────────
test('回归#2a：登录尝试令牌桶不分用户名 —— 轮换用户名一样被限速', () => {
  let t = 1_000_000;
  const lim = createLoginLimiter({ attemptMax: 3, attemptWindowMs: 60_000, now: () => t });
  const results = [];
  for (let i = 0; i < 4; i++) results.push(lim.check('10.0.0.1', `ghost-${i}`));
  assert.deepEqual(results.map((r) => r.locked), [false, false, false, true], '每来源每分钟 3 次尝试，第 4 次必须挡下');
  assert.equal(results[3].scope, 'source', '这是不分用户名的来源级预算');
  assert.ok(results[3].retryAfterMs > 0, '要能给出 Retry-After');

  assert.equal(lim.check('10.0.0.2', 'someone').locked, false, '换个来源有独立预算');
  t += 60_000;
  assert.equal(lim.check('10.0.0.1', 'ghost-again').locked, false, '时间推进后令牌补回来');
});

test('回归#2b：密码哈希改异步串行队列，调用瞬间不得阻塞事件循环', async () => {
  const hashed = hashPassword('review-group-a');
  assert.equal(typeof hashed?.then, 'function', 'hashPassword 必须返回 Promise（异步）');

  // 事件循环必须照常跑：定时器先于哈希完成触发。
  // 若实现是「同步 scrypt + 外面包一层 async」，hash 的 then 回调会抢在 timer 前面 → 断言失败。
  const order = [];
  const work = hashed.then(() => order.push('hash'));
  await new Promise((r) => setTimeout(r, 0));
  order.push('timer');
  await work;
  assert.deepEqual(order, ['timer', 'hash'], '哈希排队期间事件循环必须可调度（timer 先到）');

  const checking = verifyPassword('x', 'not-a-hash');
  assert.equal(typeof checking?.then, 'function', 'verifyPassword 也必须异步');
  assert.equal(await checking, false);

  // 串行队列不得吞掉并发任务（低档位，快）
  const stored = await hashPassword('pw-queue-check', { N: 1 << 14 });
  const [ok, bad] = await Promise.all([
    verifyPassword('pw-queue-check', stored),
    verifyPassword('pw-wrong', stored),
  ]);
  assert.deepEqual([ok, bad], [true, false], '串行队列里的并发任务都要算完且算对');
});

test('回归#2c：登录接口轮换用户名刷尝试次数 → 全局限速 429（不再无限跑 scrypt）', async (t) => {
  const ctx = await startTestGateway({ config: { loginAttemptsPerMinute: 3 } });
  t.after(() => ctx.close());

  const statuses = [];
  for (let i = 0; i < 4; i++) {
    const r = await request(`${ctx.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: `rotating-${i}`, password: 'wrong-password' }),
    });
    statuses.push(r.status);
    if (i === 3) {
      assert.ok(Number(r.headers['retry-after']) > 0, '全局限速必须带 Retry-After');
    }
  }
  assert.deepEqual(statuses, [401, 401, 401, 429], '用户名各不相同也必须被全局尝试预算限速');
});

// ── 审查#3（鉴权失效半）：额度刷新会把 markAuthInvalid 的停用撤销 ─────────────
test('回归#3a：recordQuota 不得撤销 markAuthInvalid（成功/失败都保留状态与原因）', () => {
  const accounts = [{ name: 'A', key: 'user_authkeep_aaaaaa', enabled: true, keyId: 'k-authkeep', keyPrefix: 'user_auth' }];
  const s = createScheduler({ accounts, state: makeState() });
  const at = Date.now();
  s.markAuthInvalid(accounts[0], '上游 HTTP 401', at);
  assert.equal(s.isAvailable(accounts[0]), false);

  s.recordQuota(accounts[0], { ok: true, remaining: 9, fiveHour: { used: 1, cap: 3, usedRatio: 1 / 3 } });
  let rt = s.runtime(accounts[0]);
  assert.equal(rt.authInvalid, true, '额度查询成功不得清掉鉴权失效');
  assert.match(rt.lastError, /401/, '原因必须保留');
  assert.equal(rt.lastErrorAt, at, '原因时间要还原成「发现失效」的时刻');
  assert.equal(s.isAvailable(accounts[0]), false, '额度刷新不得让它重新可调度');

  s.recordQuota(accounts[0], { ok: false, error: '额度查询超时', authInvalid: false });
  rt = s.runtime(accounts[0]);
  assert.equal(rt.authInvalid, true, '查询失败更不得把它重置成 false');
  assert.match(rt.lastError, /401/);

  s.clearAuthInvalid(accounts[0]);
  assert.equal(s.runtime(accounts[0]).authInvalid, false);
  assert.equal(s.isAvailable(accounts[0]), true, '明确的鉴权恢复后才重新可调度');
});

test('回归#3b：上游鉴权类请求（whoami 连通性测试）成功后才清除鉴权失效', async (t) => {
  const ctx = await startTestGateway();
  t.after(() => ctx.close());
  const cookie = await setupAdmin(ctx);
  const acct = ctx.gateway.accounts[0];
  ctx.gateway.scheduler.markAuthInvalid(acct, '上游 HTTP 401');
  assert.equal(ctx.gateway.scheduler.isAvailable(acct), false);

  const res = await request(`${ctx.baseUrl}/api/admin/accounts/test`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ keyId: acct.keyId }),
  });
  assert.equal(res.status, 200, `whoami 应成功，实际 ${res.status}: ${res.body}`);
  assert.equal(JSON.parse(res.body).result.ok, true);
  assert.equal(ctx.gateway.scheduler.runtime(acct).authInvalid, false, 'whoami（鉴权类请求）成功 = 鉴权恢复');
  assert.equal(ctx.gateway.scheduler.isAvailable(acct), true);
});

// ── 审查#4：暂停/复查永远按 fiveHour.resetAt 算 ─────────────────────────────
test('回归#4a：额度耗尽按实际耗尽窗口（weekly）的 resetAt 暂停', () => {
  const accounts = [{ name: 'A', key: 'user_weekly_ex_aaaaa', enabled: true, keyId: 'k-weekly-ex', keyPrefix: 'user_weekl' }];
  const s = createScheduler({ accounts, state: makeState() });
  const now = Date.now();
  const fiveHourAt = Math.floor((now + 3600_000) / 1000);
  const weeklyAt = Math.floor((now + 40 * 3600_000) / 1000);
  s.recordQuota(accounts[0], {
    ok: true,
    fiveHour: { used: 0, cap: 3, percent: 0, usedRatio: 0, resetAt: fiveHourAt, exceeded: false },
    weekly: { used: 6, cap: 6, percent: 100, usedRatio: 1, resetAt: weeklyAt, exceeded: true },
    exceededWindow: 'weekly',
  });
  assert.equal(s.pauseForQuota(accounts[0], now), weeklyAt * 1000, '必须按 weekly.resetAt 暂停');
});

// 审查 A2：兜底不再是 now+5h，而是 60 秒短退避（到期重查）；重点仍是**绝不**退回 fiveHour.resetAt
test('回归#4b：耗尽窗口缺 resetAt 时走短退避，绝不退回 fiveHour.resetAt', () => {
  const accounts = [{ name: 'A', key: 'user_weekly_noreset', enabled: true, keyId: 'k-weekly-noreset', keyPrefix: 'user_weekl' }];
  const s = createScheduler({ accounts, state: makeState() });
  const now = Date.now();
  const fiveHourAt = Math.floor((now + 3600_000) / 1000);
  s.recordQuota(accounts[0], {
    ok: true,
    fiveHour: { used: 0, cap: 3, percent: 0, usedRatio: 0, resetAt: fiveHourAt },
    weekly: { used: 6, cap: 6, percent: 100, usedRatio: 1, resetAt: 0, exceeded: true },
  });
  // proxy 从 "weekly limit reached" 措辞里认出窗口，作为提示传进来
  assert.equal(
    s.pauseForQuota(accounts[0], now, 'weekly'),
    now + 60_000,
    'weekly 缺 resetAt → 退避 60 秒（到期重查并顺延），不是 fiveHour.resetAt',
  );
});

test('回归#4c：暂停复查看所有窗口 —— weekly 仍耗尽不得恢复', async () => {
  const accounts = [{ name: 'A', key: 'user_recheck_weekly', enabled: true, keyId: 'k-recheck-weekly', keyPrefix: 'user_rech' }];
  const s = createScheduler({ accounts, state: makeState() });
  const now = Date.now();
  s.runtime(accounts[0]).pausedUntil = now - 1000;
  const weeklyAt = Math.floor((now + 40 * 3600_000) / 1000);
  await s.recheckPaused({
    now,
    fetchQuota: async () => ({
      ok: true,
      fiveHour: { used: 0, cap: 3, percent: 0, usedRatio: 0, resetAt: Math.floor((now + 3600_000) / 1000) },
      weekly: { used: 6, cap: 6, percent: 100, usedRatio: 1, resetAt: weeklyAt, exceeded: true },
      exceededWindow: 'weekly',
    }),
  });
  assert.ok((s.runtime(accounts[0]).pausedUntil ?? 0) > now, 'weekly 仍耗尽必须继续暂停');
  assert.equal(s.isAvailable(accounts[0], now), false);
});

// ── 审查#5：refreshAll 不复用进行中的 Promise ───────────────────────────────
test('回归#5：并发 refreshAll 复用同一个 Promise，不叠加全账号查询', async (t) => {
  const ctx = await startTestGateway({
    behavior: { delayMs: 100 },
    // B20：本用例断言「一轮 = 2 账号 × 4 接口 = 8 次 /alpha 调用」；启动即刷会先打掉 8 次，
    // 计数直接翻倍。显式关掉启动刷新，让计数只覆盖本用例自己发起的这一轮。
    noInitialRefresh: true,
  });
  t.after(() => ctx.close());

  const p1 = ctx.gateway.refreshAll();
  const p2 = ctx.gateway.refreshAll();
  assert.equal(p1, p2, '进行中的刷新必须返回同一个 Promise');
  await Promise.all([p1, p2]);

  const polls = ctx.upstream.seen.filter((s) => s.url.startsWith('/alpha/')).length;
  assert.equal(polls, 8, `一轮 = 2 账号 × 4 接口，不能翻倍，实际 ${polls}`);
});

// ── 审查#6：删除账号后迟到回调重建已删 keyId 的状态并落盘 ────────────────────
test('回归#6a：release/recordQuota 对已删除账号是 no-op，不重建状态', () => {
  const accounts = [{ name: 'A', key: 'user_deleted_late_aa', enabled: true, keyId: 'k-deleted-late', keyPrefix: 'user_dele' }];
  const state = makeState();
  const s = createScheduler({ accounts, state });
  const gone = accounts[0];
  s.acquire(gone);
  accounts.splice(0, 1);            // 热删除（syncPool 的效果）
  delete state.accounts[gone.keyId]; // pruneState 的效果

  s.release(gone);
  s.recordQuota(gone, { ok: true, remaining: 1, fiveHour: { used: 0, cap: 3, usedRatio: 0 } });
  s.recordError(gone, '迟到的代理回调');
  assert.ok(!(gone.keyId in state.accounts), '已删账号的迟到回调不得重建 state.accounts 条目');
  assert.equal(s.isAvailable(gone), false, '已删账号不再可调度');
});

test('回归#6b：删除账号后未完成的额度刷新不得把已删 keyId 持久化回去', async (t) => {
  const ctx = await startTestGateway({ behavior: { delayMs: 150 } });
  t.after(() => ctx.close());
  const gone = ctx.gateway.accounts.find((a) => a.name === '账号A');
  assert.ok(gone);

  const inflight = ctx.gateway.refreshAll();   // 一轮慢刷新（每接口 150ms）
  await sleep(30);
  // 与 DELETE /api/admin/accounts 同一条热生效路径：改凭据 + reloadNow()（内含 pruneState）
  fs.writeFileSync(ctx.gateway.store.accountsFile, JSON.stringify({
    accounts: [{ name: '账号B', key: 'user_test_beta', enabled: true }],
  }, null, 2));
  ctx.gateway.reloadNow();
  assert.ok(!(gone.keyId in ctx.gateway.store.state.accounts), '删除时残留已清掉');

  await inflight;
  const ids = Object.keys(ctx.gateway.store.state.accounts);
  assert.ok(!ids.includes(gone.keyId), `已删账号的运行期状态不得被回调重建，实际 ${ids}`);
  const onDisk = JSON.parse(fs.readFileSync(ctx.gateway.store.stateFile, 'utf8'));
  assert.ok(!(gone.keyId in onDisk.accounts), '已删账号不得被 saveState() 持久化回去');
});

// ── 审查#7：缺有效 cap 的窗口被过滤掉，exceeded=true 不参与可用性判断 ──────────
test('回归#7a：parseWindow 保留只带 exceeded=true 的窗口（缺 cap 不丢权威标记）', () => {
  const w = parseWindow({ exceeded: true });
  assert.ok(w, '只带 exceeded=true 的窗口不能被解析层丢掉');
  assert.equal(w.exceeded, true);
  assert.equal(w.usedRatio, null);
  assert.equal(remainingRatio({ fiveHour: w }), 0, 'exceeded 窗口按剩余 0 参与判定/打分');
});

test('回归#7b：缺有效 cap 但 exceeded=true 的窗口必须让账号不可用', () => {
  const accounts = [{ name: 'A', key: 'user_exceeded_nocap', enabled: true, keyId: 'k-exceeded-nocap', keyPrefix: 'user_exce' }];
  const s = createScheduler({ accounts, state: makeState() });
  s.recordQuota(accounts[0], {
    ok: true,
    fiveHour: { used: 0, cap: 3, percent: 0, usedRatio: 0 },
    weekly: { used: 0, cap: 0, percent: null, usedRatio: null, exceeded: true },
  });
  assert.equal(s.isAvailable(accounts[0]), false, '上游明确 exceeded=true 就必须停用（不依赖 usedRatio）');
  assert.equal(s.select().account, null);
});

// ── 审查#12：revoked.json 写入无原子性、损坏即忽略 → 已吊销 token 复活 ─────────
test('回归#9：revoked.json 损坏时 fail-closed —— 拒绝旧 token、放行新会话且跨重启不复活', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-review-rev-'));
  try {
    const file = path.join(dir, 'revoked.json');
    const secret = 'k'.repeat(64);
    const t1 = 1_000_000;
    const s1 = createSessionSigner({ secret, storePath: file, now: () => t1 });
    const old = s1.sign({ username: 'admin' });
    assert.ok(s1.verify(old));

    fs.writeFileSync(file, '{"sids": {"trunc');   // 模拟掉电 / 非原子写留下的半截文件
    const t2 = 2_000_000;
    const s2 = createSessionSigner({ secret, storePath: file, now: () => t2 });
    assert.equal(s2.verify(old), null, '吊销记录不可读必须 fail-closed：损坏前签发的 token 一律拒绝');

    const fresh = s2.sign({ username: 'admin' });
    assert.ok(s2.verify(fresh), '损坏之后新签发的会话必须可用（后台不被锁死）');
    assert.ok(!fs.readdirSync(dir).some((n) => n.includes('.tmp-')), '原子写不得留临时文件');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600, '吊销记录按凭据文件写 0600');

    const s3 = createSessionSigner({ secret, storePath: file, now: () => t2 + 1 });
    assert.equal(s3.verify(old), null, '重启后也不得复活（corruptBefore 已落盘）');
    assert.ok(s3.verify(fresh), '损坏后签发的新会话跨重启仍有效');
    const persisted = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(persisted.corruptBefore, t2, 'corruptBefore（fail-closed 水位）必须落盘');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── 审查#13：stats.byAccount 脏数据让启动 / /api/status 直接炸 ─────────────────
test('回归#10a：loadState 把 stats/byAccount 规范化为对象，非法值丢弃', () => {
  const dirtyList = [
    { total: '9', errors: null, totalTokens: 'x', byAccount: null },
    { total: 1, errors: 2, totalTokens: 3, byAccount: 'junk' },
    { total: 1, errors: 2, totalTokens: 3, byAccount: ['array'] },
    { total: 1, errors: 2, totalTokens: 3, byAccount: { good: { requests: '4', errors: 0, tokens: 5 }, bad: 'str', arr: [], nil: null } },
  ];
  for (const stats of dirtyList) {
    const dir = makeTmpDir();
    try {
      fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'data', 'state.json'), JSON.stringify({ accounts: {}, stats }));
      const store = createStore({ rootDir: dir });
      assert.doesNotThrow(() => store.loadState(), `脏 stats 不得抛错: ${JSON.stringify(stats)}`);
      assert.equal(typeof store.state.stats, 'object');
      assert.ok(store.state.stats.byAccount && typeof store.state.stats.byAccount === 'object' && !Array.isArray(store.state.stats.byAccount));
      assert.doesNotThrow(() => Object.entries(store.state.stats.byAccount), 'Object.entries 必须安全');
      assert.equal(Number.isFinite(store.state.stats.total), true, '计数字段必须是有限数字');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  // 非法条目丢弃、合法条目保留并把计数规范化成数字
  const dir = makeTmpDir();
  try {
    fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'data', 'state.json'), JSON.stringify({
      accounts: {},
      stats: { total: '7', errors: '1', totalTokens: '9', byAccount: { good: { requests: '4', errors: '1', tokens: '5' }, bad: 'str' } },
    }));
    const store = createStore({ rootDir: dir });
    store.loadState();
    assert.equal(store.state.stats.total, 7);
    assert.equal(store.state.stats.errors, 1);
    assert.deepEqual(Object.keys(store.state.stats.byAccount), ['good'], '非法条目要丢弃');
    assert.deepEqual(store.state.stats.byAccount.good, { requests: 4, errors: 1, tokens: 5 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('回归#10b：stats.byAccount=null 的 state.json 不得让网关启动即炸，/api/status 正常', async (t) => {
  const dir = makeTmpDir();
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'data', 'state.json'), JSON.stringify({
    accounts: {},
    stats: { total: 3, errors: 'x', totalTokens: 5, byAccount: null },
  }));

  const ctx = await startTestGateway({ rootDir: dir });
  t.after(() => ctx.close());
  const res = await request(`${ctx.baseUrl}/api/status`);
  assert.equal(res.status, 200, '脏 state.json 不得影响 /api/status');
  const d = JSON.parse(res.body);
  assert.equal(d.stats.errors, 0, '非法计数丢弃为 0，不许是 NaN/字符串');
  assert.ok(Object.values(d.stats.byAccount).every((s) => s && typeof s === 'object'), 'byAccount 必须是对象表');
});

// ── 审查#14：enabled 用 !! / !== false，字符串 "false" 被当启用 ────────────────
test('回归#11：enabled 只接受严格布尔，"false"/1 等非法类型一律 400', async (t) => {
  const ctx = await startTestGateway();
  t.after(() => ctx.close());
  const cookie = await setupAdmin(ctx);
  const headers = { cookie, 'content-type': 'application/json' };

  for (const bad of ['false', 'true', 1, 0, null]) {
    const res = await request(`${ctx.baseUrl}/api/admin/accounts`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: '严格布尔', key: 'user_strict_bool_aaaaaa', enabled: bad }),
    });
    assert.equal(res.status, 400, `enabled=${JSON.stringify(bad)} 必须 400，实际 ${res.status}`);
  }

  const ok = await request(`${ctx.baseUrl}/api/admin/accounts`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: '严格布尔', key: 'user_strict_bool_aaaaaa', enabled: false }),
  });
  assert.equal(ok.status, 201);
  const keyId = JSON.parse(ok.body).account.keyId;
  assert.equal(JSON.parse(ok.body).account.enabled, false, '严格 false 必须真的停用');

  const patch = await request(`${ctx.baseUrl}/api/admin/accounts/${keyId}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ enabled: 'false' }),
  });
  assert.equal(patch.status, 400, 'PATCH 侧同样只收严格布尔');
});

// ── 审查#15：换号重试的账号级错误没进全局 errors，prune 却按账号错误数扣全局 ────
test('回归#12a：换号重试的账号级错误不进全局 errors，删账号时只扣它的全局贡献', async (t) => {
  const ctx = await startTestGateway();
  t.after(() => ctx.close());
  const acctA = ctx.gateway.accounts.find((a) => a.name === '账号A');
  const acctB = ctx.gateway.accounts.find((a) => a.name === '账号B');

  // 请求 1：A 挂 503 → 换 B 成功。A 记一次「只算账号维度」的错误
  ctx.upstream.setBehavior({ failNext5xx: 1 });
  assert.equal((await postV1(ctx)).status, 200);
  // 请求 2：A、B 都挂 → 最终失败计入全局 errors 一次（记在 B 头上）
  ctx.upstream.setBehavior({ failNext5xx: 2 });
  assert.ok((await postV1(ctx)).status >= 400);

  assert.equal(ctx.gateway.stats.total, 2);
  assert.equal(ctx.gateway.stats.errors, 1);
  assert.equal(ctx.gateway.stats.byAccount[acctA.keyId].errors, 2, 'A 有两次账号级错误');
  assert.equal(ctx.gateway.stats.byAccount[acctA.keyId].globalErrors ?? 0, 0, 'A 的错误都没进全局');
  assert.equal(ctx.gateway.stats.byAccount[acctB.keyId].globalErrors ?? 0, 1, 'B 的错误进过全局 1 次');

  // 删掉 A → pruneState 扣 A 的贡献：全局 errors 必须保持 1（不能被改成 0）
  fs.writeFileSync(ctx.gateway.store.accountsFile, JSON.stringify({
    accounts: [{ name: '账号B', key: 'user_test_beta', enabled: true }],
  }, null, 2));
  ctx.gateway.reloadNow();
  assert.equal(ctx.gateway.stats.errors, 1, '只扣「计入过全局」的错误贡献');
  assert.equal(ctx.gateway.stats.total, 2);
  assert.ok(!(acctA.keyId in ctx.gateway.stats.byAccount));
});

test('回归#12b：pruneState 只扣可从全局扣减的错误贡献（旧数据按 errors 全额扣）', () => {
  const dir = makeTmpDir();
  try {
    fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'data', 'state.json'), JSON.stringify({
      accounts: {},
      stats: {
        total: 10, errors: 10, totalTokens: 0,
        byAccount: {
          // 新口径：3 个错误里只有 1 个进过全局（另外 2 个是换号重试的账号级错误）
          dead_new: { requests: 2, errors: 3, tokens: 0, globalErrors: 1 },
          // 旧数据没有 globalErrors 字段 → 退化为旧口径（errors 全额扣）
          dead_legacy: { requests: 1, errors: 2, tokens: 0 },
        },
      },
    }));
    const store = createStore({ rootDir: dir });
    store.loadState();
    store.pruneState([]);
    assert.equal(store.state.stats.errors, 7, '10 - 1（计入全局）- 2（旧数据全扣）= 7');
    assert.equal(store.state.stats.total, 7);
    assert.deepEqual(store.state.stats.byAccount, {});
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
