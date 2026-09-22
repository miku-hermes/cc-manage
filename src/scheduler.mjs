// 账号选择：打分 + 粘性 + 冷却 + 自动暂停/恢复（SPEC §5）
// 历史常量 FIVE_HOUR_MS（5h）已随审查 A2 移除：额度暂停只在拿到**未来** resetAt 时按它停，
// 否则退避 60 秒，不再有一律盲停 5 小时的兜底。
// 普通限流（rate limit）的冷却时间：只让账号短暂退出选择，不再暂停 5 小时。
const RATE_LIMIT_COOLDOWN_MS = 60 * 1000;
// 额度耗尽但**拿不到有效 resetAt** 时的兜底复查间隔（审查 A2）：
// 窗口恰好刚重置 / 上游没给 resetAt 时，绝不能盲停 5 小时，只退避 60 秒等下一轮复查。
export const QUOTA_RETRY_BACKOFF_MS = 60 * 1000;
// 额度接口连续失败时的指数退避上限与 fail-open 阈值（审查 A3）：
// 查询失败不能按「窗口耗尽」顺延 5 小时，否则上游额度接口故障 = 账号永久停用。
export const QUOTA_RECHECK_MAX_BACKOFF_MS = 15 * 60 * 1000;
export const QUOTA_RECHECK_FAIL_OPEN_AT = 5;

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
    // 审查#7：缺有效 cap 的窗口 usedRatio=null，早先直接被这里过滤掉 ——
    // 于是上游**明确**的 exceeded=true 反而不参与可用性判断。判定条件：
    // 有 usedRatio（可算比例）**或** 上游点了 exceeded（权威超限标记）。
    if (w && (typeof w.usedRatio === 'number' || w.exceeded === true)) out.push(w);
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

/** 单个窗口的剩余比例：1 - used/cap；cap 无效按 1.0（但上游点了 exceeded 就是 0）。 */
function ratioOf(w) {
  if (w?.exceeded === true) return 0.0;   // 权威超限标记 = 一滴不剩，哪怕 cap 缺失
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
  const blankRuntime = () => ({
    concurrency: 0, pausedUntil: null, lastQuota: null, lastError: null, lastErrorAt: null,
    // 普通限流（429 但非额度耗尽）的短冷却，绝不变成 5 小时停用
    rateLimitedUntil: null,
    // 上游明确说「余额不足」：账号级状态，{ at, remaining, message }
    creditsExhausted: null,
    // 鉴权失效：状态 + 原因 + 发现时间（额度刷新不得撤销，见 recordQuota）
    authInvalid: false, authInvalidReason: null, authInvalidAt: null,
    // 额度复查连续失败次数（审查 A3）：用于指数退避与 fail-open
    quotaRecheckFails: 0,
  });

  /** 账号是否还在池子里（热删除后即为 false）。 */
  const isLive = (account) => !!account && accounts.some((a) => a.keyId === account.keyId);

  /**
   * 取运行期状态（审查#6）。
   *
   * 账号已从池子里删掉（或本来就不在池里，如透传伪账号）→ 返回一份**游离**的空状态对象：
   * 读路径照常不炸，写路径写进这份一次性对象对持久化状态等价于 no-op。于是删除账号后
   * 迟到的额度刷新 / 代理回调不会再调用 runtime() 把已删 keyId 重建回来并被 saveState() 落盘。
   */
  const runtime = (account) => {
    const id = account?.keyId;
    if (!id || !isLive(account)) return blankRuntime();
    if (!state.accounts[id]) state.accounts[id] = blankRuntime();
    return state.accounts[id];
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
    // 已删除 / 不在池里的账号（含透传伪账号）不参与调度（审查#6）
    if (!isLive(account)) return false;
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
      rt.rateLimitedUntil = null;
      // 审查#3：**绝不**在这里动 authInvalid。额度查询成功不代表出错的那条鉴权路径恢复了，
      // 失败更不能把它重置成 false —— 两者都会让 markAuthInvalid() 的停用被下一轮额度
      // 刷新悄悄撤销。恢复只走明确路径：clearAuthInvalid()（上游鉴权类请求成功时调用）。
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
          rt.lastError = flag.message || '额度已用完（等周期刷新）';
          rt.lastErrorAt = flag.at ?? null;
        }
      }
      // 鉴权失效同理：状态与原因都保留，面板还要能说出「为什么停用」
      if (rt.authInvalid) {
        rt.lastError = rt.authInvalidReason || '账号鉴权失效（已停止调度）';
        rt.lastErrorAt = rt.authInvalidAt ?? null;
      }
    } else if (snapshot) {
      // 只有上游明确报鉴权错误才置位；不许把已有的 markAuthInvalid 重置回 false
      if (snapshot.authInvalid) {
        rt.authInvalid = true;
        rt.authInvalidReason = String(snapshot.error ?? '账号鉴权失效').slice(0, 300);
        rt.authInvalidAt = rt.authInvalidAt ?? Date.now();
      }
      rt.lastError = snapshot.error ?? '额度查询失败';
      rt.lastErrorAt = Date.now();
      rt.lastQuota = rt.lastQuota ?? null;
      if (rt.authInvalid) {
        rt.lastError = rt.authInvalidReason || '账号鉴权失效（已停止调度）';
        rt.lastErrorAt = rt.authInvalidAt ?? null;
      }
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
    rt.authInvalidReason = message !== null
      ? String(message).slice(0, 300)
      : (rt.authInvalidReason ?? '账号鉴权失效');
    rt.authInvalidAt = rt.authInvalidAt ?? now;
    if (message !== null) recordError(account, message, now);
    return rt.authInvalid;
  }

  /**
   * 明确的鉴权恢复路径（审查#3）：**上游鉴权类请求成功**（whoami 连通性测试）后由调用方
   * 显式调用。额度刷新（recordQuota）无权清这个标记 —— 它证明不了出错的那条路径恢复了。
   */
  function clearAuthInvalid(account) {
    const rt = runtime(account);
    const had = rt.authInvalid;
    const reason = rt.authInvalidReason;
    rt.authInvalid = false;
    rt.authInvalidReason = null;
    rt.authInvalidAt = null;
    if (had && reason && rt.lastError === reason) {
      rt.lastError = null;
      rt.lastErrorAt = null;
    }
    return had;
  }

  /**
   * 上游明确「余额不足」：标记账号级停用（不写 pausedUntil）。
   * 记下当时的 remaining 作为对比基线，充值后 recordQuota 会自动解除。
   */
  function markCreditsExhausted(account, message = '上游拒付：额度已用完（insufficient credits）', now = Date.now()) {
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

  /**
   * 挑「实际耗尽的窗口」（审查#4）：调用方点名（402/429 报文里的措辞）> 上游点名的
   * exceededWindow > 已经超限的窗口里最受限的那个 > 最受限窗口。
   */
  function exhaustedWindowOf(quota, hint = null) {
    const known = ['fiveHour', 'weekly'];
    if (known.includes(hint) && quota?.[hint]) return hint;
    if (known.includes(quota?.exceededWindow) && quota[quota.exceededWindow]) return quota.exceededWindow;
    const exhausted = known.filter((k) => {
      const w = quota?.[k];
      return w && (w.exceeded === true || (Number(w.cap) > 0 && Number(w.used) >= Number(w.cap)));
    });
    const pool = exhausted.length > 0 ? exhausted : known.filter((k) => quota?.[k]);
    if (pool.length === 0) return null;
    let worst = pool[0];
    for (const k of pool.slice(1)) if (ratioOf(quota[k]) < ratioOf(quota[worst])) worst = k;
    return worst;
  }

  /**
   * 额度耗尽 → 暂停到**实际耗尽窗口**的 resetAt（审查#4）。
   * 历史 bug①：永远按 fiveHour.resetAt 算，weekly 耗尽时暂停/复查时间跟着 5h 窗口走。
   * 历史 bug②（审查 A2）：resetAt 缺失 / 已过期时兜底 `now + 5h`，于是「窗口恰好刚重置」
   *   或上游没给 resetAt 的账号被白停 5 小时。现在只在 resetAt 是**未来的有限数值**时
   *   才暂停到该时刻，否则只退避 QUOTA_RETRY_BACKOFF_MS（60 秒）等下一轮复查。
   */
  function pauseForQuota(account, now = Date.now(), windowHint = null) {
    const rt = runtime(account);
    const key = exhaustedWindowOf(rt.lastQuota, windowHint);
    const w = key ? rt.lastQuota?.[key] : null;
    const reset = Number(w?.resetAt);
    const until = Number.isFinite(reset) && reset * 1000 > now
      ? reset * 1000
      : now + QUOTA_RETRY_BACKOFF_MS;
    rt.pausedUntil = until;
    return until;
  }

  /** 额度接口连续失败第 fails 次时的退避时长：60s → 120s → 240s → 480s…封顶 15 分钟。 */
  function quotaFetchBackoffMs(fails) {
    return Math.min(QUOTA_RECHECK_MAX_BACKOFF_MS, QUOTA_RETRY_BACKOFF_MS * 2 ** Math.max(0, fails - 1));
  }

  function availableCount(now = Date.now()) {
    return accounts.filter((a) => isAvailable(a, now)).length;
  }

  function activeCount() {
    return accounts.filter((a) => a.enabled !== false).length;
  }

  /**
   * 到点复查：pausedUntil 已过期的账号重新查额度；确认所有窗口都未耗尽才恢复。
   * 手动 enabled=false 的账号永不自动恢复。
   *
   * 审查 A3：必须把「拿不到快照（查询失败）」与「拿到快照但确实未恢复」分开 ——
   * 额度接口超时/被拦时 `snapshot.ok` 恒为 false，若按「未恢复」顺延 5 小时，
   * 账号就再也回不来了（每轮复查都顺延 → 永久停用）。现在：
   *  - 查询失败 → 60s/120s/240s… 指数退避（封顶 15 分钟），并累计失败次数；
   *  - 连续失败达 5 次 → fail-open：撤销 pausedUntil，按旧快照重新参与调度
   *    （宁可撞一次上游，也不要永久停服）；
   *  - 查询成功但未恢复 → 按 A2 规则（真实 resetAt，无则 60s 短退避）重算；
   *  - 查询成功 → 失败计数清零。
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

      // ── 查询失败：指数退避 + fail-open，绝不顺延大窗口 ──
      if (!snapshot?.ok) {
        const fails = (rt.quotaRecheckFails ?? 0) + 1;
        rt.quotaRecheckFails = fails;
        if (fails >= QUOTA_RECHECK_FAIL_OPEN_AT) {
          rt.pausedUntil = null;
          rt.quotaRecheckFails = 0;
          recovered.push(account.keyId);
          logger?.warn?.(`账号「${account.name}」额度复查连续失败 ${fails} 次，恢复调度（按旧快照评估）`);
          continue;
        }
        const backoff = quotaFetchBackoffMs(fails);
        rt.pausedUntil = now + backoff;
        logger?.info?.(`账号「${account.name}」额度复查失败（第 ${fails} 次），${Math.round(backoff / 1000)} 秒后重试`);
        continue;
      }

      rt.quotaRecheckFails = 0;
      const q = rt.lastQuota;
      // 审查#4：恢复判定要看**所有**窗口（含 exceeded 标记）：只看 fiveHour 会让
      // weekly 仍耗尽的账号被提前恢复，然后又撞一次上游 429。
      const recovered_ok = quotaWindows(q).every(
        (w) => w.exceeded !== true && !(Number(w.cap) > 0 && Number(w.used) >= Number(w.cap)),
      );
      if (recovered_ok) {
        rt.pausedUntil = null;
        recovered.push(account.keyId);
        logger?.info?.(`账号「${account.name}」额度已恢复，重新启用`);
      } else {
        // 复查后仍未恢复：按真实 resetAt 顺延（无 resetAt 则 60s 短退避），避免每轮都打上游
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
    clearAuthInvalid,
    isLive,
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
