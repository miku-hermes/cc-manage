// 账号选择：打分 + 粘性 + 冷却 + 自动暂停/恢复（SPEC §5）
const HOUR_MS = 3600 * 1000;
const FIVE_HOUR_MS = 5 * HOUR_MS;
// 普通限流（rate limit）的冷却时间：只让账号短暂退出选择，不再暂停 5 小时。
const RATE_LIMIT_COOLDOWN_MS = 60 * 1000;

/**
 * 所有能用的额度窗口（5h、周）。任何一个打满，账号就不可用。
 *
 * 历史 bug：早期只取「5h 优先、其次周」，于是当 5h 是空的而**周额度已打满**时
 * 二者都看不见 —— 账号既被判定「可用」，又因 5h 剩余 100% 拿到最高分被优先选中，
 * 于是每次路由都先撞一次 429 再 failover。
 */
export function quotaWindows(quota) {
  const out = [];
  for (const w of [quota?.fiveHour, quota?.weekly]) {
    if (w && typeof w.usedRatio === 'number') out.push(w);
  }
  return out;
}

/** 取最受限的窗口（剩余比例最小的那个）。都没有则 null。 */
export function ratioWindow(quota) {
  const ws = quotaWindows(quota);
  if (ws.length === 0) return null;
  let worst = ws[0];
  for (const w of ws.slice(1)) {
    if (ratioOf(w) < ratioOf(worst)) worst = w;
  }
  return worst;
}

/** 单个窗口的剩余比例：1 - used/cap；cap 无效按 1.0。 */
function ratioOf(w) {
  const used = Number(w.used) || 0;
  const cap = Number(w.cap) || 0;
  if (!(cap > 0)) return 1.0;
  return Math.max(0, 1 - used / cap);
}

/** remainingRatio = 最受限窗口的剩余比例；无数据算 1.0。 */
export function remainingRatio(quota) {
  const w = ratioWindow(quota);
  if (!w) return 1.0;
  return ratioOf(w);
}

/**
 * 429 里「普通限流」与「额度耗尽」的判别。
 *
 * 历史 bug：早先只要 429 body 里出现 /quota|limit|exceeded/ 就判成额度耗尽 ——
 * `"Rate limit exceeded"` 这种普通限流措辞、甚至 `"type":"rate_limit"` 这个**字段名**
 * 都含 limit/exceeded，于是一次瞬时限流就把账号暂停 5 小时（线上副号被莫名停用的根因）。
 *
 * 现在只有明确指向「额度窗口/额度用量」的措辞才算额度耗尽：quota / quota_exceeded /
 * windowLimits / credit(s) / <周期> limit|window（weekly limit reached 这种仍是额度语义）。
 * 裸的 "rate limit" / "too many requests" / "rate_limit" 字段一律不算。
 */
const QUOTA_HINT_RE = /quota|window_?limits?|credits?|(?:weekly|monthly|daily|hourly|usage|plan|subscription|account)[\s_-]*(?:limit|window|quota|exhaust)/i;

/** 上游是否报了「额度耗尽」。402 一律算；429 需 body 里明确出现额度语义。 */
export function isQuotaError(status, bodyText = '') {
  if (status === 402) return true;
  if (status !== 429) return false;
  return QUOTA_HINT_RE.test(String(bodyText));
}

/**
 * 上游报「余额不足」的判别。实测真实措辞（HTTP **400**，不是 402）：
 * `{"error":{"message":"You have insufficient credits to make this request.
 *   Please purchase more credits to continue using the service.","code":"BAD_REQUEST"}}`
 *
 * 为什么必须单独判：这是**账号级**状态 —— 和 5 小时窗口无关，暂停到 resetAt
 * 毫无用处（钱不会自己回来），只有充值或周期刷新才可能恢复。
 * 历史 bug：isQuotaError 只认 402 和 429+关键词，400 的余额不足被当成普通
 * 4xx，账号继续被标「可用」并参与调度，每次轮到它就给客户端一个 400 ——
 * 用户看到的现象是「某个号莫名其妙不能用」，面板上却写着「可用」。
 *
 * 只认余额语义的关键词，不认 rate limit：`insufficient credits` /
 * `not enough credits` / `insufficient_balance` / 「余额不足」。
 */
const CREDITS_HINT_RE = /insufficient[\s_-]*credits?|not enough credits?|insufficient[\s_-]*(?:balance|funds)|credit balance|余额不足/i;

export function isCreditsExhausted(status, bodyText = '') {
  if (!(status >= 400 && status < 500)) return false;
  return CREDITS_HINT_RE.test(String(bodyText));
}

export function createScheduler({ accounts = [], state, ttlMs = 1800000, maxAffinity = 2000, log } = {}) {
  // 运行期状态：state.accounts[keyId]
  const runtime = (account) => {
    if (!state.accounts[account.keyId]) {
      state.accounts[account.keyId] = {
        concurrency: 0, pausedUntil: null, lastQuota: null, lastError: null, lastErrorAt: null,
        // 普通限流（429 但非额度耗尽）的短冷却，绝不变成 5 小时停用
        rateLimitedUntil: null,
        // 上游明确说「余额不足」：账号级状态，{ at, remaining }
        creditsExhausted: null,
      };
    }
    return state.accounts[account.keyId];
  };
  for (const a of accounts) runtime(a);

  // sessionAffinity: Map 保持插入顺序 = LRU（命中时 delete + set 移到末尾并刷新 at）
  const affinity = new Map();

  function affinityKey(sessionId) {
    return String(sessionId);
  }

  /**
   * 取 session 的粘性账号。
   *
   * 命中时必须 delete + set 回写并更新 at：TTL 从**最后一次命中**起算（持续活跃的会话
   * 不中途掉粘性），同时把该条目移到 Map 末尾（插入顺序 = LRU，上限淘汰时先淘汰最冷的）。
   * 早先只读不写：TTL 从建立时刻起算 → 30 分钟活跃会话掉亲和性；
   * 且上限淘汰按插入顺序 → 刚被命中的最热条目反而先被淘汰，与注释/SPEC 都不符。
   */
  function getAffinity(sessionId, now) {
    if (!sessionId) return null;
    const key = affinityKey(sessionId);
    const entry = affinity.get(key);
    if (!entry) return null;
    if (now - entry.at > ttlMs) {
      affinity.delete(key);
      return null;
    }
    // 移到 Map 末尾（插入顺序 = LRU）。只有一个条目时无需搬动。
    if (affinity.size > 1) {
      affinity.delete(key);
      affinity.set(key, entry);
    }
    entry.at = now;
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

  /**
   * 硬性可用性：enabled、未暂停、未鉴权失效、5h 未打满。
   *
   * now 默认取当前时间：面板读接口（/api/status、/api/admin/accounts）只关心
   * 「此刻」的可用性，调用时不必显式传参。若省掉这个默认值，调用方漏传时会变成
   * `rt.pausedUntil > undefined` 比较（恒为 false），暂停判断被静默跳过，
   * 导致暂停中的账号仍被算作可调度（前台会同时渲染「可调度」和「暂停至」两个矛盾徽标）。
   * 注意语义：显式传 0（falsy 但有效）不会触发默认值，只有 undefined 才会。
   */
  function isAvailable(account, now = Date.now()) {
    if (account.enabled === false) return false;
    const rt = runtime(account);
    if (rt.pausedUntil && rt.pausedUntil > now) return false;
    if (rt.rateLimitedUntil && rt.rateLimitedUntil > now) return false;
    if (rt.authInvalid) return false;
    if (rt.creditsExhausted) return false;
    const q = rt.lastQuota;
    // 任一窗口超限即不可用：只看 5h 会让「周额度已打满」的账号被继续调度。
    // 两个条件都要：上游的 exceeded 是权威标记（实测副号 weekly = true），
    // used>=cap 是它的兜底（老数据/上游漏标时不至于放行）。
    for (const w of quotaWindows(q)) {
      if (w.exceeded === true) return false;
      if (w.cap > 0 && w.used >= w.cap) return false;
    }
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
      rt.rateLimitedUntil = null;
      // 余额不足的自动解除：只看「剩余额度**变多**了」= 充值到账或周期刷新。
      // 不能只看 remaining > 0 —— 实测主号 remaining=$0.098 仍然付不起最小请求，
      // 那样会立刻解除标记再撞一次 400。额度只降不升就说明还没充值，继续停用。
      const flag = rt.creditsExhausted;
      if (flag) {
        const now = Number(snapshot.remaining);
        const before = flag.remaining;
        const recovered = before === null || before === undefined
          ? Number.isFinite(now) && now > 0        // 之前没数据可对比：只能看有没有余额
          : Number.isFinite(now) && now > Number(before);
        if (recovered) {
          rt.creditsExhausted = null;
          log?.info?.(`账号「${account.name}」余额已到账（剩余 ${now}），恢复调度`);
        } else {
          // 仍被标记：把原因和**原始**时间还原（不是现在 —— 面板要显示的是
          // 「什么时候发现它没钱的」，不是「上次刷新时刻」）。
          // 老版本的持久化标记没有 message 字段，用兜底文案，别让面板说不出话。
          rt.lastError = flag.message || '余额不足（需充值或等周期刷新）';
          rt.lastErrorAt = flag.at ?? null;
        }
      }
    } else if (snapshot) {
      rt.authInvalid = !!snapshot.authInvalid;
      rt.lastError = snapshot.error ?? '额度查询失败';
      rt.lastErrorAt = Date.now();
      rt.lastQuota = rt.lastQuota ?? null;
    }
  }

  /**
   * 普通限流（429 非额度类）：只把账号短暂移出选择（默认 60s），
   * 绝不写成 pausedUntil（那会变成 5 小时停用，多账号池被压垮、单账号池直接 503）。
   */
  function markRateLimited(account, now = Date.now(), cooldownMs = RATE_LIMIT_COOLDOWN_MS) {
    const rt = runtime(account);
    rt.rateLimitedUntil = now + cooldownMs;
    return rt.rateLimitedUntil;
  }

  /** 上游 401/403：账号 key 失效，立刻停止调度它（不再等到额度轮询才纠正）。 */
  function markAuthInvalid(account, message = null, now = Date.now()) {
    const rt = runtime(account);
    rt.authInvalid = true;
    if (message !== null) recordError(account, message, now);
    return rt.authInvalid;
  }

  /**
   * 上游明确「余额不足」：标记账号级停用（不写 pausedUntil）。
   * 记下当时的 remaining 作为对比基线，充值后 recordQuota 会自动解除。
   */
  function markCreditsExhausted(account, message = '余额不足（上游：insufficient credits）', now = Date.now()) {
    const rt = runtime(account);
    // 原因存进标记里：运行时状态会持久化到 state.json，重启后 recordQuota 会把
    // lastError 清掉，若不还原，面板就会只剩「余额不足」而说不出为什么。
    rt.creditsExhausted = { at: now, remaining: rt.lastQuota?.remaining ?? null, message: String(message).slice(0, 300) };
    recordError(account, message, now);
    return rt.creditsExhausted;
  }

  /** 手动/外部解除余额不足标记（运维干预用）。 */
  function clearCreditsExhausted(account) {
    const rt = runtime(account);
    const had = rt.creditsExhausted;
    rt.creditsExhausted = null;
    return had;
  }

  /** 面板用：{ at, remaining } 或 null。 */
  function creditsExhaustedState(account) {
    return runtime(account).creditsExhausted ?? null;
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
    markRateLimited,
    markAuthInvalid,
    markCreditsExhausted,
    clearCreditsExhausted,
    creditsExhaustedState,
    pauseForQuota,
    availableCount,
    activeCount,
    recheckPaused,
    getAffinity,
    setAffinity,
    affinitySize: () => affinity.size,
  };
}
