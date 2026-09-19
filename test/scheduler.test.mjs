// §8-2 调度：打分 / 粘性 / 冷却 / 自动暂停恢复
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createScheduler, isQuotaError, remainingRatio } from '../src/scheduler.mjs';
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

test('暂停没有 resetAt 时默认 now + 5 小时', () => {
  const accounts = makeAccounts([{ name: 'A', key: 'user_pause_b_xxxxxxx' }]);
  const s = createScheduler({ accounts, state: makeState() });
  const now = Date.now();
  s.recordQuota(accounts[0], quotaWith({ used: 100, cap: 100 }));
  assert.equal(s.pauseForQuota(accounts[0], now), now + 5 * 3600 * 1000);
});
