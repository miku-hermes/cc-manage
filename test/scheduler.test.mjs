// §8-2 调度：打分 / 粘性 / 冷却 / 自动暂停恢复
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createScheduler, isQuotaError, remainingRatio, ratioWindow } from '../src/scheduler.mjs';
import { createLoginLimiter } from '../src/auth.mjs';
import { normalizeAccounts } from '../src/store.mjs';

function makeAccounts(list) {
  return normalizeAccounts(list);
}

function makeState() {
  return { accounts: {}, stats: { total: 0, errors: 0, totalTokens: 0, byAccount: {} } };
}

function quotaWith(fiveHour, weekly) {
  const w = (x) => (x ? { used: x.used, cap: x.cap, percent: x.cap ? (x.used / x.cap) * 100 : null, usedRatio: x.cap ? x.used / x.cap : null, resetAt: x.resetAt ?? null } : null);
  return { ok: true, fiveHour: w(fiveHour), weekly: w(weekly) };
}

test('剩余额度高的被选中', () => {
  const accounts = makeAccounts([
    { name: '低额度', key: 'user_low_aaaaaaaaaa' },
    { name: '高额度', key: 'user_high_bbbbbbbbb' },
  ]);
  const s = createScheduler({ accounts, state: makeState() });
  s.recordQuota(accounts[0], quotaWith({ used: 90, cap: 100 }));
  s.recordQuota(accounts[1], quotaWith({ used: 10, cap: 100 }));
  const { account } = s.select();
  assert.equal(account.name, '高额度');
});

test('5h 打满的账号被跳过', () => {
  const accounts = makeAccounts([
    { name: '已耗尽', key: 'user_used_aaaaaaaaa' },
    { name: '还有额度', key: 'user_free_bbbbbbbbb' },
  ]);
  const s = createScheduler({ accounts, state: makeState() });
  s.recordQuota(accounts[0], quotaWith({ used: 100, cap: 100 }));
  s.recordQuota(accounts[1], quotaWith({ used: 99, cap: 100 }));
  const { account } = s.select();
  assert.equal(account.name, '还有额度');
});

test('在途数会影响打分：同额度时在途少的优先', () => {
  const accounts = makeAccounts([
    { name: '忙', key: 'user_busy_aaaaaaaaa' },
    { name: '闲', key: 'user_idle_bbbbbbbbb' },
  ]);
  const s = createScheduler({ accounts, state: makeState() });
  s.recordQuota(accounts[0], quotaWith({ used: 50, cap: 100 }));
  s.recordQuota(accounts[1], quotaWith({ used: 50, cap: 100 }));
  s.acquire(accounts[0]);
  s.acquire(accounts[0]);
  const { account } = s.select();
  assert.equal(account.name, '闲');
  s.release(accounts[0]);
  s.release(accounts[0]);
  assert.equal(s.runtime(accounts[0]).concurrency, 0);
});

test('同分时按 accounts.json 里的顺序稳定排序', () => {
  const accounts = makeAccounts([
    { name: '第一', key: 'user_first_aaaaaaaa' },
    { name: '第二', key: 'user_second_bbbbbbb' },
    { name: '第三', key: 'user_third_cccccccc' },
  ]);
  const s = createScheduler({ accounts, state: makeState() });
  for (const a of accounts) s.recordQuota(a, quotaWith({ used: 50, cap: 100 }));
  for (let i = 0; i < 10; i++) {
    assert.equal(s.select().account.name, '第一', '必须稳定选第一个，不许随机');
  }
});

test('pausedUntil 未到期的账号被跳过', () => {
  const accounts = makeAccounts([
    { name: '暂停中', key: 'user_paused_aaaaaaa' },
    { name: '正常', key: 'user_normal_bbbbbbb' },
  ]);
  const s = createScheduler({ accounts, state: makeState() });
  s.recordQuota(accounts[0], quotaWith({ used: 10, cap: 100 }));
  s.recordQuota(accounts[1], quotaWith({ used: 90, cap: 100 }));
  const now = Date.now();
  s.runtime(accounts[0]).pausedUntil = now + 60000;
  assert.equal(s.select({ now }).account.name, '正常');
});

test('到点且额度恢复 → 自动恢复；额度仍满 → 继续暂停', async () => {
  const accounts = makeAccounts([{ name: 'A', key: 'user_autoresume_xxx' }]);
  const s = createScheduler({ accounts, state: makeState() });
  const now = Date.now();
  s.recordQuota(accounts[0], quotaWith({ used: 100, cap: 100 }));
  s.runtime(accounts[0]).pausedUntil = now - 1000; // 已经到点

  // 第一次复查：额度仍然打满 → 不恢复，并把暂停顺延
  await s.recheckPaused({ fetchQuota: async () => quotaWith({ used: 100, cap: 100 }), now });
  const resize = s.runtime(accounts[0]).pausedUntil;
  assert.equal(resize > now, true, '额度没恢复就该继续暂停');
  assert.equal(s.isAvailable(accounts[0], now), false);

  // 第二次复查：到了新的复查时点，额度已恢复 → 自动恢复
  await s.recheckPaused({ fetchQuota: async () => quotaWith({ used: 3, cap: 100 }), now: resize });
  assert.equal(s.runtime(accounts[0]).pausedUntil, null);
  assert.equal(s.isAvailable(accounts[0], resize), true);
});

test('手动 enabled=false 永不自动恢复', async () => {
  const accounts = makeAccounts([{ name: '手停', key: 'user_manual_aaaaaaa', enabled: false }]);
  const s = createScheduler({ accounts, state: makeState() });
  const now = Date.now();
  s.runtime(accounts[0]).pausedUntil = now - 1000;
  const recovered = await s.recheckPaused({ fetchQuota: async () => quotaWith({ used: 0, cap: 100 }), now });
  assert.deepEqual(recovered, [], '手动停用的账号不该出现在恢复列表里');
  assert.equal(s.runtime(accounts[0]).pausedUntil, now - 1000, '手动停用的账号连额度都不该去查，状态原样保留');
  assert.equal(s.isAvailable(accounts[0], now), false);
});

test('粘性路由命中同账号', () => {
  const accounts = makeAccounts([
    { name: 'A', key: 'user_sticky_a_xxxxxx' },
    { name: 'B', key: 'user_sticky_b_xxxxxx' },
  ]);
  const s = createScheduler({ accounts, state: makeState() });
  s.recordQuota(accounts[0], quotaWith({ used: 20, cap: 100 }));
  s.recordQuota(accounts[1], quotaWith({ used: 20, cap: 100 }));

  const first = s.select({ sessionId: 'sess-1' }).account;
  // 换了新 session 才可能选到别人；同 session 必须复用
  for (let i = 0; i < 5; i++) {
    assert.equal(s.select({ sessionId: 'sess-1' }).account.keyId, first.keyId);
  }
});

test('粘性命中但账号不可用 → 改选并更新 affinity', () => {
  const accounts = makeAccounts([
    { name: 'A', key: 'user_aff_a_xxxxxxxx' },
    { name: 'B', key: 'user_aff_b_xxxxxxxx' },
  ]);
  const s = createScheduler({ accounts, state: makeState() });
  s.recordQuota(accounts[0], quotaWith({ used: 90, cap: 100 }));
  s.recordQuota(accounts[1], quotaWith({ used: 90, cap: 100 }));

  const first = s.select({ sessionId: 'sess-2' }).account; // A 更闲
  assert.equal(first.name, 'A');

  // A 被暂停 → 该 session 应改选 B，且 affinity 更新到 B
  s.runtime(accounts[0]).pausedUntil = Date.now() + 60000;
  const second = s.select({ sessionId: 'sess-2' }).account;
  assert.equal(second.name, 'B');
  assert.equal(s.getAffinity('sess-2', Date.now()), second.keyId);
});

test('affinity TTL 过期后重新按额度挑', () => {
  const accounts = makeAccounts([
    { name: 'A', key: 'user_ttl_a_xxxxxxxxx' },
    { name: 'B', key: 'user_ttl_b_xxxxxxxxx' },
  ]);
  const s = createScheduler({ accounts, state: makeState(), ttlMs: 1000 });
  s.recordQuota(accounts[0], quotaWith({ used: 10, cap: 100 })); // A 更闲
  s.recordQuota(accounts[1], quotaWith({ used: 90, cap: 100 }));
  const t0 = Date.now();
  assert.equal(s.select({ sessionId: 'sess-ttl', now: t0 }).account.name, 'A');

  // 把 B 的额度调好，过了 TTL 后再选 → 重新按额度打分
  s.recordQuota(accounts[1], quotaWith({ used: 1, cap: 100 }));
  const late = t0 + 5000;
  assert.equal(s.select({ sessionId: 'sess-ttl', now: late }).account.name, 'B');
});

test('affinity LRU 上限淘汰最旧条目', () => {
  const accounts = makeAccounts([{ name: 'A', key: 'user_lru_a_xxxxxxxxx' }]);
  const s = createScheduler({ accounts, state: makeState(), maxAffinity: 3, ttlMs: 600000 });
  const now = Date.now();
  for (const id of ['s1', 's2', 's3', 's4']) s.select({ sessionId: id, now });
  assert.equal(s.affinitySize(), 3);
  assert.equal(s.getAffinity('s1', now), null, '最旧的 s1 应被淘汰');
  assert.ok(s.getAffinity('s4', now), '最新的 s4 应在表内');
});

test('authInvalid 账号被跳过', () => {
  const accounts = makeAccounts([
    { name: '坏key', key: 'user_bad_aaaaaaaaaa' },
    { name: '好key', key: 'user_good_bbbbbbbbb' },
  ]);
  const s = createScheduler({ accounts, state: makeState() });
  s.recordQuota(accounts[0], { ok: false, authInvalid: true, error: 'HTTP 401' });
  s.recordQuota(accounts[1], quotaWith({ used: 50, cap: 100 }));
  assert.equal(s.select().account.name, '好key');
});

test('全部不可用时返回 null 且带原因', () => {
  const accounts = makeAccounts([{ name: 'A', key: 'user_none_a_xxxxxxxx' }]);
  const s = createScheduler({ accounts, state: makeState() });
  s.recordQuota(accounts[0], quotaWith({ used: 100, cap: 100 }));
  const r = s.select();
  assert.equal(r.account, null);
  assert.equal(r.reason, 'no_available_account');
});

test('isQuotaError / remainingRatio / pauseForQuota 行为', () => {
  assert.equal(isQuotaError(402, ''), true);
  assert.equal(isQuotaError(429, '{"error":{"message":"quota exceeded"}}'), true);
  assert.equal(isQuotaError(429, '{"error":{"message":"weekly limit reached"}}'), true);
  assert.equal(isQuotaError(429, '{"error":{"message":"too many requests"}}'), false);
  assert.equal(isQuotaError(500, 'quota'), false);

  assert.equal(remainingRatio(null), 1.0);
  assert.equal(remainingRatio(quotaWith({ used: 30, cap: 100 })), 0.7);
  assert.equal(remainingRatio(quotaWith(null, { used: 50, cap: 100 })), 0.5);

  const accounts = makeAccounts([{ name: 'A', key: 'user_pause_a_xxxxxxx' }]);
  const s = createScheduler({ accounts, state: makeState() });
  const now = Date.now();
  s.recordQuota(accounts[0], quotaWith({ used: 100, cap: 100, resetAt: Math.floor((now + 3600_000) / 1000) }));
  const until = s.pauseForQuota(accounts[0], now);
  assert.equal(until, Math.floor((now + 3600_000) / 1000) * 1000, '应暂停到 5h 窗口的 resetAt');
});

// ── 回归：周额度打满的账号不得被当成可用，也不得拿高分 ──────────────
// 历史 bug：早期只看 5h 窗口，于是「5h 空着 + 周额度 100%」的账号既被判可用、
// 又因 5h 剩余 100% 拿到最高分被优先选中 → 每次路由先撞一次 429 再 failover。
test('周额度打满：isAvailable 必须为 false，remainingRatio 必须为 0', () => {
  const now = Date.now();
  const reset = Math.floor((now + 40 * 3600_000) / 1000);   // 40 小时后才重置

  // 5h 全新（0/3），周额度打满（6/6）
  const exhaustedWeekly = quotaWith({ used: 0, cap: 3 }, { used: 6, cap: 6, resetAt: reset });
  assert.equal(remainingRatio(exhaustedWeekly), 0,
    '周额度打满时 remainingRatio 必须是 0（不能因为 5h 空着就返回 1.0）');
  assert.equal(ratioWindow(exhaustedWeekly).used, 6, '应取最受限的窗口（周）');

  const accounts = makeAccounts([
    { name: '周满', key: 'user_weekly_full_xxxx' },
    { name: '健康', key: 'user_healthy_xxxxxx' },
  ]);
  const s = createScheduler({ accounts, state: makeState() });
  s.recordQuota(accounts[0], exhaustedWeekly);
  s.recordQuota(accounts[1], quotaWith({ used: 1, cap: 3 }, { used: 1, cap: 6, resetAt: reset }));

  assert.equal(s.isAvailable(accounts[0]), false, '周额度打满的账号不得判为可用');
  assert.equal(s.isAvailable(accounts[1]), true);

  // 选择时必须挑健康的那个 —— 不能再出现「优先选中周满账号」
  const picked = s.select({ now });
  assert.equal(picked.account.name, '健康', '必须跳过周额度打满的账号');

  // 5h 打满、周健康 → 同样不可用（两个方向都要成立）
  const exhausted5h = quotaWith({ used: 3, cap: 3 }, { used: 1, cap: 6, resetAt: reset });
  assert.equal(remainingRatio(exhausted5h), 0);
  s.recordQuota(accounts[1], exhausted5h);
  assert.equal(s.isAvailable(accounts[1]), false, '5h 打满同样不得可用');
});

test('暂停没有 resetAt 时默认 now + 5 小时', () => {
  const accounts = makeAccounts([{ name: 'A', key: 'user_pause_b_xxxxxxx' }]);
  const s = createScheduler({ accounts, state: makeState() });
  const now = Date.now();
  s.recordQuota(accounts[0], quotaWith({ used: 100, cap: 100 }));
  assert.equal(s.pauseForQuota(accounts[0], now), now + 5 * 3600 * 1000);
});

// ── F4：429 普通限流 ≠ 额度耗尽（线上账号被莫名停用 5 小时的根因）──────
test('F4：isQuotaError 只在明确额度语义时成立，普通限流一律不算', () => {
  // 额度语义 → 算
  assert.equal(isQuotaError(402, ''), true);
  assert.equal(isQuotaError(429, '{"error":{"message":"quota exceeded","type":"quota_exceeded"}}'), true);
  assert.equal(isQuotaError(429, '{"error":{"message":"You have exhausted your weekly limit"}}'), true);
  assert.equal(isQuotaError(429, '{"error":{"message":"windowLimits exceeded"}}'), true);
  assert.equal(isQuotaError(429, '{"error":{"message":"monthly quota reached"}}'), true);
  assert.equal(isQuotaError(429, '{"error":{"message":"insufficient credits"}}'), true);

  // 普通限流 → 不算（历史 bug：这些全被当成额度耗尽，账号被停 5 小时）
  assert.equal(isQuotaError(429, '{"error":{"message":"Rate limit exceeded, retry later","type":"rate_limit"}}'), false,
    '「Rate limit exceeded」是普通限流，绝不能被判成额度耗尽');
  assert.equal(isQuotaError(429, '{"error":{"message":"too many requests"}}'), false);
  assert.equal(isQuotaError(429, '{"error":{"type":"rate_limit"}}'), false,
    '只有 type 字段名含 limit 时也不算额度耗尽');
  assert.equal(isQuotaError(429, '{"error":{"message":"request limit exceeded, slow down"}}'), false);
  assert.equal(isQuotaError(429, ''), false);
  assert.equal(isQuotaError(429, '{"error":{"message":"Concurrency limit reached"}}'), false);
  assert.equal(isQuotaError(500, 'quota'), false);
});

test('F4：普通限流只做短冷却，绝不产生 5 小时暂停；额度耗尽才暂停', () => {
  const accounts = makeAccounts([
    { name: 'A', key: 'user_rl_a_aaaaaaaa' },
    { name: 'B', key: 'user_rl_b_bbbbbbbb' },
  ]);
  const s = createScheduler({ accounts, state: makeState() });
  const now = Date.now();

  // 普通限流：冷却 60s，且**不得**写 pausedUntil
  const until = s.markRateLimited(accounts[0], now);
  assert.equal(until, now + 60_000, '普通限流只冷却 60 秒');
  const rt = s.runtime(accounts[0]);
  assert.equal(rt.pausedUntil, null, '普通限流绝不能写 pausedUntil（那就是 5 小时停用）');
  assert.equal(s.isAvailable(accounts[0], now), false, '冷却期内不可调度');
  assert.equal(s.isAvailable(accounts[0], until + 1), true, '60 秒后立刻恢复可调度');

  // 冷却期内会被跳过 → 换到另一个账号
  assert.equal(s.select({ now }).account.name, 'B');
  // 冷却结束后又能被选中（额度更好）
  s.recordQuota(accounts[0], quotaWith({ used: 1, cap: 100 }));
  s.recordQuota(accounts[1], quotaWith({ used: 90, cap: 100 }));
  assert.equal(s.select({ now: until + 1 }).account.name, 'A');

  // 对照：额度耗尽才允许 5 小时停用
  const paused = s.pauseForQuota(accounts[1], now);
  assert.equal(paused, now + 5 * 3600 * 1000);
  assert.equal(s.runtime(accounts[1]).pausedUntil, paused);
});

test('F4：额度快照成功后清掉限流冷却（不必干等 60 秒）', () => {
  const accounts = makeAccounts([{ name: 'A', key: 'user_rl_clear_xxxx' }]);
  const s = createScheduler({ accounts, state: makeState() });
  const now = Date.now();
  s.markRateLimited(accounts[0], now);
  assert.equal(s.isAvailable(accounts[0], now), false);
  s.recordQuota(accounts[0], quotaWith({ used: 1, cap: 100 }));
  assert.equal(s.runtime(accounts[0]).rateLimitedUntil, null);
  assert.equal(s.isAvailable(accounts[0], now), true);
});

// ── F7：sessionAffinity 命中要刷新 TTL，淘汰必须是 LRU ───────────────
test('F7：连续命中的会话在 30 分钟后仍保持粘性（TTL 从最后一次命中起算）', () => {
  const accounts = makeAccounts([
    { name: 'A', key: 'user_lru_a_aaaaaaaa' },
    { name: 'B', key: 'user_lru_b_bbbbbbbb' },
  ]);
  const ttl = 1800_000;
  const s = createScheduler({ accounts, state: makeState(), ttlMs: ttl });
  for (const a of accounts) s.recordQuota(a, quotaWith({ used: 10, cap: 100 }));

  s.setAffinity('sess', accounts[0].keyId, 0);
  // 每 400ms 命中一次，持续到 4000ms（远超 TTL=1800）
  for (let t = 400; t <= 4000; t += 400) {
    assert.equal(s.getAffinity('sess', t), accounts[0].keyId, `t=${t} 仍应命中（持续活跃不掉粘性）`);
  }
  // 真正闲置超过 TTL 才过期
  assert.equal(s.getAffinity('sess', 4000 + ttl + 1), null);
});

test('F7：上限淘汰按 LRU —— 刚被命中的最热条目必须留下', () => {
  const accounts = makeAccounts([
    { name: 'A', key: 'user_lru2_a_aaaaaaa' },
    { name: 'B', key: 'user_lru2_b_bbbbbbb' },
  ]);
  const s = createScheduler({ accounts, state: makeState(), ttlMs: 1_000_000, maxAffinity: 3 });
  const k = accounts[0].keyId;
  s.setAffinity('s1', k, 0);
  s.setAffinity('s2', k, 0);
  s.setAffinity('s3', k, 0);
  // 命中 s1 → 它变成最热（移到末尾），此时插入 s4 应淘汰 s2
  assert.equal(s.getAffinity('s1', 1), k);
  s.setAffinity('s4', k, 1);
  assert.equal(s.affinitySize(), 3);
  assert.equal(s.getAffinity('s1', 2), k, '刚被命中的 s1 绝不能被淘汰');
  assert.equal(s.getAffinity('s4', 2), k);
  assert.equal(s.getAffinity('s2', 2), null, '最冷的 s2 才是该被淘汰的那个');
});

// ── F17：限速表内存清理 ─────────────────────────────────────────────
test('F17：限速表给 locked 项也做清理，且硬上限兜底', () => {
  let t = 1_000_000;
  const lim = createLoginLimiter({ maxFails: 1, lockMs: 1000, now: () => t, maxEntries: 50 });
  for (let i = 0; i < 600; i++) lim.fail(`10.0.0.${i}`, `user-${i}`);
  // 硬上限兜底：绝不无界增长
  assert.ok(lim.size().users <= 50, `users 表必须受硬上限约束，实际 ${lim.size().users}`);
  assert.ok(lim.size().sources <= 50, `sources 表必须受硬上限约束，实际 ${lim.size().sources}`);
  // 时间推进后 locked 项也要被清掉（历史 bug：prune 跳过 locked 项 → 全表留存）
  t += 10 * 60 * 1000;
  lim.fail('fresh-source', 'fresh-user');
  assert.ok(lim.size().users <= 50, '过期（含 locked）条目必须被清理');
});
