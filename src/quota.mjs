// Command Code 额度查询（契约见 SPEC §4，全部 GET）
import { redact } from './log.mjs';

export const CC_USER_AGENT = 'commandcode-cli/1.53.1';

/**
 * B12：把「无时区」的 ISO 日期时间按 **UTC** 补全，保证同一字符串在不同 TZ 的容器里
 * 解析出同一个时间戳。SPEC 只说 resetAt 可能是秒级数字 / 毫秒级数字 / ISO 字符串，
 * 没约定必须带时区；若不补，`2026-09-22T12:00:00` 会被 `Date.parse` 按**本机时区**
 * 解释（Asia/Shanghai 上整体偏移 8 小时），窗口重置时间随之错位。
 *
 * - 带 `Z`/`z` 或 `±HH:MM` / `±HHMM` 偏移的：时区已明确，原样返回；
 * - 只有日期（`YYYY-MM-DD`）：ES 规范本身就按 UTC 解释，原样返回；
 * - 日期 + 时间但无时区：补 `Z` 按 UTC 解释。
 */
function isoWithUtcFallback(value) {
  const s = String(value).trim();
  if (/(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(s)) return s;
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(s)) return `${s.replace(' ', 'T')}Z`;
  return s;
}

/**
 * resetAt 归一化成秒：>=1e12 视为毫秒 → /1000；ISO 字符串 → 秒；其余按秒。
 * 无时区的 ISO 日期时间按 UTC 解释（B12）。无法解析时返回 null。
 */
export function normalizeResetAt(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value >= 1e12 ? Math.floor(value / 1000) : Math.floor(value);
  }
  if (typeof value === 'string') {
    const asNum = Number(value);
    if (Number.isFinite(asNum)) return normalizeResetAt(asNum);
    const ms = Date.parse(isoWithUtcFallback(value));
    if (Number.isFinite(ms)) return Math.floor(ms / 1000);
  }
  return null;
}

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * 解析 whoami 里的账号标识。实测真实账号的 org 为 null（没有 org.id），
 * 此时 orgId 置为 undefined（查询时省略该参数），展示名回退到 user.userName || user.name。
 * 有 org.id 时照常带上。只要拿到 org.id 或 user 标识即视为解析成功。
 * @returns {{ orgId: string|undefined, displayName: string|null, userName: string|null, identified: boolean }}
 */
export function parseIdentity(whoami) {
  const orgId = whoami?.org?.id ?? undefined;
  const userName = whoami?.user?.userName || whoami?.user?.name || null;
  const displayName = whoami?.org?.login || userName;
  return { orgId, displayName, userName, identified: Boolean(orgId || userName) };
}

/** 从 windowLimits 里的一个窗口算 used/cap/百分比 */
export function parseWindow(w) {
  if (!w || typeof w !== 'object') return null;
  const hasUsed = w.used !== undefined && w.used !== null;
  const hasCap = w.cap !== undefined && w.cap !== null;
  // 审查#7：只带 exceeded=true（没有 used/cap）的窗口也要保留 —— 上游的权威超限标记
  // 不能因为缺 cap 就被解析层丢掉，否则下游永远不会因为它而停用账号。
  const exceeded = w.exceeded === true;
  if (!hasUsed && !hasCap && !exceeded) return null;
  const used = num(w.used, 0);
  const cap = num(w.cap, 0);
  const ratio = cap > 0 ? used / cap : null;
  return {
    used,
    cap,
    percent: ratio === null ? null : Math.max(0, Math.min(100, ratio * 100)),
    usedRatio: ratio === null ? null : ratio,
    resetAt: normalizeResetAt(w.resetAt),
    // 上游自带的「这个窗口超了」标记 —— 比我们自己用 used>=cap 反推更权威
    // （实测副号 weekly used=6.003>cap=6 时上游给 exceeded=true）。
    exceeded,
    // B3：数据完整性标记。used 缺失会被 num() 补成 0、cap 缺失会是 0，
    // 单看归一化后的值分不清「真的是 0」还是「上游没给」—— 下游需要据此判断
    // 该窗口能不能用来判定额度是否充足，故显式带出。
    hasUsed,
    hasCap,
  };
}

/** 把 4 个接口的原始响应拼成一份额度快照 */
export function parseSnapshot({ whoami, credits, subscriptions, usage }) {
  const { orgId, displayName } = parseIdentity(whoami);
  const keyName = whoami?.user?.keyName || whoami?.user?.displayName || null;

  const c = credits?.credits ?? {};
  const monthlyCredits = num(c.monthlyCredits, 0);
  // 官方字段：低余额标记。creditThreshold 是账号上配置的阈值（0 = 未配置/关闭），
  // belowThreshold 是上游据此算出的「已低于阈值」。社区实现（codex-router）直接用它
  // 当「这个账号还能不能用」的判据（available: credits?.belowThreshold !== true）。
  // 实测本机两个账号 creditThreshold=0 → belowThreshold=false，即默认不启用；
  // 所以它只能作为**加分信号**，不能当唯一依据（主号余额 $0.098 时它仍然是 false）。
  const belowThreshold = c.belowThreshold === true;
  const creditThreshold = Number.isFinite(Number(c.creditThreshold)) ? Number(c.creditThreshold) : null;
  const purchasedCredits = num(c.purchasedCredits, 0);
  const freeCredits = num(c.freeCredits, 0);
  const remaining = monthlyCredits + purchasedCredits + freeCredits;

  const fiveHour = parseWindow(credits?.windowLimits?.fiveHour);
  const weekly = parseWindow(credits?.windowLimits?.weekly);
  // 顶层的 exceeded 是**窗口名**（实测副号 = "weekly"），null 表示上游没有窗口超限。
  // 注意：它不覆盖「钱不够」——主号余额 $0.098 时这里仍是 null。
  const exceededWindow = typeof credits?.windowLimits?.exceeded === 'string' && credits.windowLimits.exceeded
    ? credits.windowLimits.exceeded
    : null;

  const sub = subscriptions?.data ?? null;
  const totalCost = num(usage?.totalCost, 0);
  const totalCount = num(usage?.totalCount, 0);
  const totalTokens = num(usage?.totalTokens, 0);

  // 月窗口：CC 未提供月度 windowLimits。以「本周期花费 totalCost / (花费 + 剩余额度)」
  // 作为月度占用率 —— 契约里没有月度 cap 字段，此处为推算。TODO(问作者): 若 CC 后续
  // 提供 /alpha/billing/... 的月度 cap，应改用官方字段。
  // 月窗口：上游不提供月度 windowLimits，只能用「本周期花费 totalCost / (花费 + 剩余额度)」推算。
  // 分母四舍五入到整数：官方额度本身就是整数（Go $10、GOAT $70、Max $300…），推算出的
  // 10.034 属于假精度 —— 面板写「9.94 / 10.03」会让人以为还剩 0.09 能用，而实测那点余额
  // 连一次请求都付不起。取整后与官方口径一致；不影响调度判定（调度只看 5h/周窗口）。
  const monthlyCap = Math.max(1, Math.round(totalCost + remaining));
  const monthly = monthlyCap > 0
    ? { used: totalCost, cap: monthlyCap, percent: Math.max(0, Math.min(100, (totalCost / monthlyCap) * 100)), usedRatio: totalCost / monthlyCap, resetAt: normalizeResetAt(sub?.currentPeriodEnd) }
    : null;

  return {
    ok: true,
    authInvalid: false,
    orgId,
    displayName,
    keyName,
    credits: { monthlyCredits, purchasedCredits, freeCredits, remaining, belowThreshold, creditThreshold },
    remaining,
    fiveHour,
    weekly,
    exceededWindow,
    monthly,
    plan: sub ? { planId: sub.planId ?? null, status: sub.status ?? null } : null,
    periodStart: sub?.currentPeriodStart ?? null,
    periodEnd: sub?.currentPeriodEnd ?? null,
    usage: { totalCost, totalCount, totalTokens },
    fetchedAt: Date.now(),
  };
}

/**
 * 探测一个 CC key 是否有效：只打 whoami，不做池调度、不落任何状态。
 * 后台「测试连通性」按钮用。永不抛错，失败以 { ok:false, error } 返回。
 * @param {string} key CC 上游 key
 * @param {{ baseUrl?: string, timeoutMs?: number, fetchImpl?: Function, log?: object }} opts
 */
export async function fetchWhoami(key, opts = {}) {
  const baseUrl = String(opts.baseUrl ?? 'https://api.commandcode.ai').replace(/\/+$/, '');
  const timeoutMs = opts.timeoutMs ?? 15000;
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (timer.unref) timer.unref();
  try {
    const res = await doFetch(`${baseUrl}/alpha/whoami`, {
      method: 'GET',
      headers: { accept: 'application/json', authorization: `Bearer ${key}`, 'user-agent': CC_USER_AGENT },
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ok: false, status: res.status, error: `HTTP ${res.status}: ${redactMessage(body, key).slice(0, 200)}` };
    }
    const whoami = await res.json().catch(() => null);
    const { orgId, displayName, userName, identified } = parseIdentity(whoami);
    if (!identified) return { ok: false, error: 'whoami 响应缺少用户标识（org.id / user.userName / user.name）' };
    return {
      ok: true,
      orgId: orgId ?? null,
      displayName,
      userName,
      login: whoami?.org?.login ?? null,
      keyName: whoami?.user?.keyName ?? whoami?.user?.displayName ?? null,
    };
  } catch (e) {
    const aborted = e?.name === 'AbortError' || e?.code === 'ABORT_ERR';
    return { ok: false, error: aborted ? `whoami 超时（>${timeoutMs}ms）` : redactMessage(e?.message ?? String(e), key) };
  } finally {
    clearTimeout(timer);
  }
}

function redactMessage(text, key) {
  return redact(String(text ?? '').slice(0, 300), [key]);
}

/**
 * 查询一个账号的额度。4 个请求共用一个超时预算（AbortController）。
 * @param {string} key CC key
 * @param {{ baseUrl?: string, timeoutMs?: number, fetchImpl?: Function, now?: () => number, log?: object }} opts
 */
export async function fetchQuota(key, opts = {}) {
  const baseUrl = String(opts.baseUrl ?? 'https://api.commandcode.ai').replace(/\/+$/, '');
  const timeoutMs = opts.timeoutMs ?? 15000;
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  const now = opts.now ?? (() => Date.now());
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (timer.unref) timer.unref();

  const get = async (pathname) => {
    const res = await doFetch(`${baseUrl}${pathname}`, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${key}`,
        'user-agent': CC_USER_AGENT,
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const err = new Error(`HTTP ${res.status}: ${redactMessage(body, key)}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  };

  try {
    const whoami = await get('/alpha/whoami');
    // org 可能为 null（实测真实账号如此），此时省略 orgId 参数，其余三个接口照样可用。
    const { orgId, identified } = parseIdentity(whoami);
    if (!identified) throw new Error('whoami 响应缺少用户标识（org.id / user.userName / user.name）');
    const q = orgId ? `?orgId=${encodeURIComponent(orgId)}` : '';
    const credits = await get(`/alpha/billing/credits${q}`);
    const subscriptions = await get(`/alpha/billing/subscriptions${q}`);
    const since = subscriptions?.data?.currentPeriodStart;
    const sep = q ? '&' : '?';
    const usage = await get(`/alpha/usage/summary${q}${since ? `${sep}since=${encodeURIComponent(since)}` : ''}`);
    return parseSnapshot({ whoami, credits, subscriptions, usage });
  } catch (e) {
    const aborted = e?.name === 'AbortError' || e?.code === 'ABORT_ERR';
    const status = e?.status;
    return {
      ok: false,
      authInvalid: status === 401 || status === 403,
      error: aborted ? `额度查询超时（>${timeoutMs}ms）` : redactMessage(e?.message ?? String(e), key),
      fetchedAt: now(),
    };
  } finally {
    clearTimeout(timer);
  }
}
