// 账号选择：打分 + 粘性 + 冷却 + 自动暂停/恢复（SPEC §5）
const HOUR_MS = 3600 * 1000;
const FIVE_HOUR_MS = 5 * HOUR_MS;

/** 取用于打分的窗口：5h 优先，其次周窗口，都没有则视为无限额。 */
export function ratioWindow(quota) {
  if (quota?.fiveHour && typeof quota.fiveHour.usedRatio === 'number') return quota.fiveHour;
  if (quota?.weekly && typeof quota.weekly.usedRatio === 'number') return quota.weekly;
  return null;
}

/** remainingRatio = 1 - used/cap；无数据算 1.0。 */
export function remainingRatio(quota) {
  const w = ratioWindow(quota);
  if (!w) return 1.0;
  const used = Number(w.used) || 0;
  const cap = Number(w.cap) || 0;
  if (!(cap > 0)) return 1.0;
  return Math.max(0, 1 - used / cap);
}

/** 上游是否报了「额度耗尽」。402 一律算；429 需 body 里含关键字。 */
export function isQuotaError(status, bodyText = '') {
  if (status === 402) return true;
  if (status !== 429) return false;
  return /quota|limit|exceeded/i.test(String(bodyText));
}

export function createScheduler({ accounts = [], state, ttlMs = 1800000, maxAffinity = 2000, log } = {}) {
  // 运行期状态：state.accounts[keyId]
  const runtime = (account) => {
    if (!state.accounts[account.keyId]) {
      state.accounts[account.keyId] = { concurrency: 0, pausedUntil: null, lastQuota: null, lastError: null, lastErrorAt: null };
    }
    return state.accounts[account.keyId];
  };
  for (const a of accounts) runtime(a);

  // sessionAffinity: Map 保持插入顺序 = LRU（命中时 delete + set 移到末尾）
  const affinity = new Map();

  function affinityKey(sessionId) {
    return String(sessionId);
  }

  function getAffinity(sessionId, now) {
    if (!sessionId) return null;
    const key = affinityKey(sessionId);
    const entry = affinity.get(key);
    if (!entry) return null;
    if (now - entry.at > ttlMs) {
      affinity.delete(key);
      return null;
    }
    return entry.keyId;
  }

  function setAffinity(sessionId, keyId, now) {
    if (!sessionId) return;
    const key = affinityKey(sessionId);
    if (affinity.has(key)) affinity.delete(key);
    affinity.set(key, { keyId, at: now });
    while (affinity.size > maxAffinity) {
      const oldest = affinity.keys().next().value;
      affinity.delete(oldest);
    }
  }

  /** 硬性可用性：enabled、未暂停、未鉴权失效、5h 未打满 */
  function isAvailable(account, now) {
    if (account.enabled === false) return false;
    const rt = runtime(account);
    if (rt.pausedUntil && rt.pausedUntil > now) return false;
    if (rt.authInvalid) return false;
    const q = rt.lastQuota;
    if (q?.fiveHour && q.fiveHour.cap > 0 && q.fiveHour.used >= q.fiveHour.cap) return false;
    return true;
  }

  function score(account) {
    const rt = runtime(account);
    return remainingRatio(rt.lastQuota) / (1 + (rt.concurrency || 0));
  }

  /** 排序候选：分数降序，同分按 accounts 数组顺序（稳定）。 */
  function rank(candidates) {
    return candidates
      .map((account, index) => ({ account, index, score: score(account) }))
      .sort((a, b) => (b.score - a.score) || (a.index - b.index))
      .map((x) => x.account);
  }

  /**
   * 选一个账号。sessionId 命中且该账号仍可用 → 直接复用（粘性）。
   * @returns {{account: object|null, reason?: string}}
   */
  function select({ sessionId = null, now = Date.now() } = {}) {
    const stickyId = getAffinity(sessionId, now);
    if (stickyId) {
      const hit = accounts.find((a) => a.keyId === stickyId);
      if (hit && isAvailable(hit, now)) return { account: hit };
    }
    const candidates = accounts.filter((a) => isAvailable(a, now));
    if (candidates.length === 0) return { account: null, reason: 'no_available_account' };
    const picked = rank(candidates)[0];
    setAffinity(sessionId, picked.keyId, now);
    return { account: picked };
  }

  function acquire(account) {
    runtime(account).concurrency = (runtime(account).concurrency || 0) + 1;
  }

  function release(account) {
    const rt = runtime(account);
    rt.concurrency = Math.max(0, (rt.concurrency || 0) - 1);
  }

  function recordError(account, message, now = Date.now()) {
    const rt = runtime(account);
    rt.lastError = String(message ?? '').slice(0, 300);
    rt.lastErrorAt = now;
  }

  function recordQuota(account, snapshot) {
    const rt = runtime(account);
    if (snapshot?.ok) {
      rt.lastQuota = snapshot;
      rt.lastError = null;
      rt.lastErrorAt = null;
      rt.authInvalid = false;
    } else if (snapshot) {
      rt.authInvalid = !!snapshot.authInvalid;
      rt.lastError = snapshot.error ?? '额度查询失败';
      rt.lastErrorAt = Date.now();
      rt.lastQuota = rt.lastQuota ?? null;
    }
  }

  /** 额度耗尽 → 暂停到 5h resetAt（无则 now+5h）。 */
  function pauseForQuota(account, now = Date.now()) {
    const rt = runtime(account);
    const reset = rt.lastQuota?.fiveHour?.resetAt ?? null;
    const until = reset && reset * 1000 > now ? reset * 1000 : now + FIVE_HOUR_MS;
    rt.pausedUntil = until;
    return until;
  }

  function availableCount(now = Date.now()) {
    return accounts.filter((a) => isAvailable(a, now)).length;
  }

  function activeCount() {
    return accounts.filter((a) => a.enabled !== false).length;
  }

  /**
   * 到点复查：pausedUntil 已过期的账号重新查额度；确认 fiveHour.used < cap 才恢复。
   * 手动 enabled=false 的账号永不自动恢复。
   * @returns {string[]} 恢复的账号 keyId 列表
   */
  async function recheckPaused({ fetchQuota, now = Date.now(), log: logger = log } = {}) {
    const recovered = [];
    for (const account of accounts) {
      if (account.enabled === false) continue;
      const rt = runtime(account);
      if (!rt.pausedUntil || rt.pausedUntil > now) continue;
      let snapshot;
      try {
        snapshot = await fetchQuota(account);
      } catch (e) {
        snapshot = { ok: false, error: e?.message ?? String(e) };
      }
      recordQuota(account, snapshot);
      const q = rt.lastQuota;
      const recovered_ok = snapshot?.ok && (!q?.fiveHour || q.fiveHour.cap <= 0 || q.fiveHour.used < q.fiveHour.cap);
      if (recovered_ok) {
        rt.pausedUntil = null;
        recovered.push(account.keyId);
        logger?.info?.(`账号「${account.name}」额度已恢复，重新启用`);
      } else {
        // 复查后仍未恢复：把暂停顺延到下一个 5h resetAt（无则 now+5h），避免每轮都打上游
        pauseForQuota(account, now);
        logger?.info?.(`账号「${account.name}」复查仍未恢复，继续暂停`);
      }
    }
    return recovered;
  }

  return {
    accounts,
    state,
    runtime,
    isAvailable,
    remainingRatio: (account) => remainingRatio(runtime(account).lastQuota),
    score,
    select,
    acquire,
    release,
    recordError,
    recordQuota,
    pauseForQuota,
    availableCount,
    activeCount,
    recheckPaused,
    getAffinity,
    setAffinity,
    affinitySize: () => affinity.size,
  };
}
