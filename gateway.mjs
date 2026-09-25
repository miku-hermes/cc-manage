// cc-manage 入口：HTTP 服务 + 路由（多账号反代 + 额度面板 API）
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, configWarnings } from './src/config.mjs';
import { createStore, CC_KEY_PREFIX, LOCAL_KEY_PREFIX } from './src/store.mjs';
import { createHistory, HISTORY_BUCKET_MS, HISTORY_TICK_MS } from './src/history.mjs';
import { createLogger, keyIdOf, keyPrefixOf, redact, sanitizeForLog } from './src/log.mjs';
import { fetchWhoami, fetchQuota } from './src/quota.mjs';
import { probeAccountCredits, shouldProbeCredits } from './src/credits-probe.mjs';
import {
  SESSION_COOKIE,
  clearCookieHeader,
  createLoginLimiter,
  createSessionSigner,
  hashPassword,
  loadOrCreateSecret,
  parseCookies,
  safeEqualText,
  ScryptQueueFullError,
  sessionCookieHeader,
  setScryptQueueMax,
  verifyPassword,
} from './src/auth.mjs';
import { createScheduler, quotaWindows } from './src/scheduler.mjs';
import { DEFAULT_TRUSTED_PROXY_CIDRS, isSecureRequest as isSecureRequestOf, resolveClientIp } from './src/client-ip.mjs';
import { createProxy } from './src/proxy.mjs';
import { createAdaptivePoller } from './src/poll.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PROXY_ROUTES = new Map([
  ['POST /v1/chat/completions', true],
  ['POST /v1/messages', true],
  ['POST /v1/responses', true],
  ['GET /v1/models', false],
]);

const SESSION_HEADER = 'x-session-id';
// 后台事件缓冲上限（环形，超出丢最旧的）
const EVENTS_MAX = 200;
const ADMIN_BODY_LIMIT = 64 * 1024;
// 后台登录失败限速：同**用户名**连续 5 次失败 → 锁定（首次 5 分钟，之后指数退避）。
// 只按用户名锁：反代后按来源（socket）分桶会让匿名者把全体管理员锁死（F14）。
const LOGIN_MAX_FAILS = 5;
const LOGIN_LOCK_MS = 5 * 60 * 1000;
const LOGIN_MAX_LOCK_MS = 60 * 60 * 1000;
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 200;
// B17-#7：单线程 scrypt(N=2^16) 实测均值 ≈656ms → 吞吐 ≈91 次/分钟。全局登录尝试上限按
// **实际吞吐**校准（不再用 per-source×10=600）：配置上限高于系统容量只会让请求在队列里
// 堆积、把合法登录排在积压后面。取 90（≈实测吞吐），队列深度上限（scryptMaxQueue）另做兜底。
const SCRYPT_THROUGHPUT_PER_MIN = 90;

/**
 * 全局登录尝试上限（B17-#7，纯函数）：显式配置优先；否则取 max(每来源上限, 实测吞吐)。
 * 导出供回归测试直接验证（与 BODY_PEEK_BYTES 同款做法）。
 * 历史行为是 `per-source × 10 = 600`，远高于单线程 scrypt 的实际容量 —— 配置上限大于系统
 * 容量只会把请求堆进队列，而不是「更快地拒绝」。
 */
export function globalLoginAttemptMax(config = {}) {
  const explicit = Number(config.loginGlobalAttemptsPerMinute);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const perSource = Number(config.loginAttemptsPerMinute) > 0 ? Number(config.loginAttemptsPerMinute) : 60;
  return Math.max(perSource, SCRYPT_THROUGHPUT_PER_MIN);
}

// 连通性测试结果只做展示，不必持久化太多次
const TEST_HISTORY_MAX = 20;
// 公开面板匿名触发的额度刷新最小间隔（毫秒）：按来源分桶
const PUBLIC_REFRESH_MIN_MS = 5000;
// 全局兜底间隔（毫秒）：任何匿名来源加起来也不能更频繁地打上游
const PUBLIC_REFRESH_GLOBAL_MIN_MS = 2000;
// 来源分桶表上限
const PUBLIC_REFRESH_MAX_SOURCES = 512;
// 全池无可用账号时的 503：取不到 resetAt 时给客户端的保守重试间隔（审查 A4）
const DEFAULT_POOL_RETRY_AFTER_MS = 60 * 1000;
// 自动「无可用账号 → 刷额度」的最小间隔：并发请求靠 refreshAll 的 refreshInFlight 去重，
// 串行请求靠这个冷却，绝不能让每个 503 都打一轮上游（审查 A4）。
const POOL_REFRESH_MIN_MS = 5000;

/** 带 HTTP 状态码的错误，后台接口统一用它转成响应。 */
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// 取 session id 只需 body 首块（F11）：读满这么多或 body 结束就立刻开始转发，
// 不再等整个 body 收完才建立上游连接（SPEC §7 要求流式透传）。
// 导出供回归测试直接验证 peek 的缓冲上限与监听器清理（审查#1）
export const BODY_PEEK_BYTES = 8192;
// 收到首块后最多再等这么久找 session id（毫秒），到点就放行开始转发。
const BODY_PEEK_IDLE_MS = 150;
// L5：peek 的**起始**超时 —— 连接建立后一直不发送 body 也不能无限占住 socket
// （armIdle 只在收到首块数据后才生效）。默认 10s，可经 config.bodyPeekStartMs/env 覆盖。
const BODY_PEEK_START_MS = 10000;
// docker stop 默认宽限期 10s，这里留一半余量给在途请求自然结束（F3）
const GRACEFUL_SHUTDOWN_MS = 5000;

/** 从下游 key 里取 session 标识：优先 x-session-id，其次 body 里的 conversation_id / user。 */
function peekSessionFromBody(chunks) {
  if (chunks.length === 0) return null;
  const text = Buffer.concat(chunks).slice(0, BODY_PEEK_BYTES).toString('utf8');
  const m1 = text.match(/"conversation_id"\s*:\s*"([^"]{1,200})"/);
  if (m1) return m1[1];
  const m2 = text.match(/"user"\s*:\s*"([^"]{1,200})"/);
  if (m2) return m2[1];
  return null;
}

export async function startGateway(overrides = {}) {
  // M1：loadConfig 会拒绝 config.json 里类型不合法的安全开关（直接抛错阻止启动）；
  // 未知键 / 无法解析的值收集成 warnings，这里在 logger 就绪后打出来，别静默吞掉。
  const loadedConfig = loadConfig(overrides.configPath ?? path.join(ROOT, 'config.json'), overrides.env ?? process.env);
  const config = { ...loadedConfig, ...(overrides.config ?? {}) };
  // B22：面板静态产物目录（HTML 走 readPanel/readAdmin，css/js 走 serveStatic）。
  // 仓库根 public/ 是构建产物（scripts/panel-build.sh 从 panel/dist 同步），不进 git；
  // overrides.publicDir 是测试注入点：指向一个没有 index.html 的目录即可复现「面板未构建」。
  const publicDir = overrides.publicDir ?? path.join(ROOT, 'public');
  // B17-#7：把 scrypt 串行队列的深度上限注入 auth 模块（模块级状态，进程内全局生效）。
  setScryptQueueMax(config.scryptMaxQueue);
  const log = createLogger({ level: config.logLevel, file: config.logFile });
  for (const w of configWarnings(loadedConfig)) log.warn?.(`配置告警：${w}`);
  // 可注入的墙钟：测试用可控 now 驱动探针 TTL / 退避，生产默认 Date.now。
  const nowFn = typeof overrides.now === 'function' ? overrides.now : () => Date.now();

  // ── 事件缓冲（后台「运行日志」）：内存环形，最多 EVENTS_MAX 条 ──
  const events = [];
  function note(level, message) {
    const text = log.redact(String(message ?? ''));
    log[level]?.(text);
    events.push({ at: Date.now(), level, message: text });
    while (events.length > EVENTS_MAX) events.shift();
  }

  const store = createStore({ rootDir: overrides.rootDir ?? ROOT, env: overrides.env ?? process.env, log });
  const accounts = store.loadAccounts();
  const localKeys = store.loadKeys();
  store.loadState(accounts);   // 传入当前账号池 → 自动清理已删账号的残留状态

  for (const a of accounts) log.registerSecret(a.key);
  for (const k of localKeys) log.registerSecret(k.key);
  const secrets = [...accounts.map((a) => a.key), ...localKeys.map((k) => k.key)];

  note('info', `已加载 ${accounts.length} 个 CC 账号、${localKeys.length} 个本地 key`);

  // B8：过期快照阈值 = 2 × 空闲轮询间隔（无轮询配置时回退 20 分钟，与 poolStaleAfterMs 同口径）。
  const snapshotStaleMs = 2 * (Number(config.quotaPollIntervalMs) > 0 ? Number(config.quotaPollIntervalMs) : 600000);
  const scheduler = createScheduler({ accounts, state: store.state, ttlMs: config.sessionAffinityTtlMs, snapshotStaleMs, log });
  const stats = store.state.stats;
  for (const a of accounts) stats.byAccount[a.keyId] ??= { requests: 0, errors: 0, tokens: 0 };

  // B13：历史趋势环形缓冲。state 已就绪，history 挂在 store.state.history 上（落盘即写它）。
  const history = createHistory({ state: store.state });

  // ── 后台鉴权（账号 + 密码 → 签名 cookie session）─────────
  // 与客户端 sk-cg- key 彻底分开：key 只用于 /v1/* API 调用，session 只用于后台页面。
  const secretFile = store.secretFile;
  const sessionSecret = loadOrCreateSecret(secretFile, { log });
  // 吊销记录落盘（F15）：否则重启后「已登出 / 已改密码」的 cookie 会复活（自包含 7 天 TTL）
  const sessions = createSessionSigner({
    secret: sessionSecret,
    storePath: path.join(store.configDir, 'revoked.json'),
    log,
  });
  const loginLimiter = createLoginLimiter({
    maxFails: LOGIN_MAX_FAILS,
    lockMs: LOGIN_LOCK_MS,
    maxLockMs: LOGIN_MAX_LOCK_MS,
    now: () => Date.now(),
    // 全局尝试预算（不分用户名）：轮换用户名刷登录也会被限速，不再无限触发 scrypt
    attemptMax: Number(config.loginAttemptsPerMinute) > 0 ? Number(config.loginAttemptsPerMinute) : 60,
    // H2：进程级全局桶（跨来源），伪造 XFF/轮换来源也绕不过；0 → 按实测吞吐校准（B17-#7）
    globalAttemptMax: globalLoginAttemptMax(config),
    attemptWindowMs: 60 * 1000,
  });
  let users = [];
  let setupInProgress = false;
  // 用户不存在时也做一次等价开销的哈希校验，避免用响应时间探测出「哪些用户名存在」。
  // hashPassword 是异步的，这里缓存的是 Promise（只算一次，之后各次失败登录 await 同一份）。
  let dummyHash = null;
  const dummyPasswordHash = () => {
    dummyHash ??= hashPassword(randomBytes(16).toString('hex'));
    return dummyHash;
  };

  /** users.json 是否加载失败（fail-closed 用）。加载失败绝不能当成「未初始化」。 */
  let usersLoadFailed = false;

  function loadUsersFromDisk() {
    try {
      users = store.loadUsers();
      usersLoadFailed = false;
    } catch (e) {
      // 损坏的 users.json 不能当成「未初始化」── 否则 setup 会重新开放，
      // 任意匿名者 POST /api/auth/setup 就能创建管理员并**整文件覆盖**掉真实管理员。
      // 这里必须 fail-closed：标记失败，让 isSetupRequired() 恒为 false，
      // 并让登录/初始化接口返回 503，等人来修文件。
      usersLoadFailed = true;
      users = [];
      log.error(`管理员列表加载失败（${store.usersFile}）：${e.message} —— 初始化接口已关闭，请修复该文件`);
    }
    return users;
  }
  loadUsersFromDisk();

  function usersView() {
    return users.map((u) => ({ username: u.username, createdAt: u.createdAt ?? null }));
  }

  function isSetupRequired() {
    // 加载失败时绝不报告「需要初始化」——那是可被利用的 fail-open。
    if (usersLoadFailed) return false;
    return users.length === 0;
  }

  function findUser(name) {
    const idx = users.findIndex((u) => safeEqualText(u.username, name));
    return idx < 0 ? null : users[idx];
  }

  /**
   * 限速用的来源 IP（审查 A5）。
   *
   * 历史问题：只看 socket → 反代（1Panel openresty）后面所有请求的 remoteAddress 都是代理地址，
   * 「每来源」令牌桶退化成**全局桶**，匿名者轮换用户名刷失败就能把管理员登录一并挡掉。
   * 现在：**仅当** socket 来源落在可信代理集合内才采信 `x-forwarded-for` / `x-real-ip`，
   * 否则忽略代理头回落 socket（防止伪造 XFF 绕过限速）。
   */
  const trustedProxyCidrs = Array.isArray(config.trustedProxyCidrs) && config.trustedProxyCidrs.length > 0
    ? config.trustedProxyCidrs
    : DEFAULT_TRUSTED_PROXY_CIDRS;

  function clientIp(req) {
    return resolveClientIp({ remoteAddress: req.socket?.remoteAddress, headers: req.headers }, trustedProxyCidrs);
  }

  /**
   * 安全响应头（F13）。两个页面的脚本与样式都是**内联**的单文件（无外部资源、
   * 无内联事件处理器），所以 CSP 里必须放行内联 script/style（'unsafe-inline'），
   * 否则 default-src 'self' 会把它们全禁掉 → 面板白屏。
   * 这里仍然收紧其余面：默认只允许同源、禁止被 iframe 嵌套、禁止插件对象、
   * 禁止 base 标签被改、表单只提交到同源。
   */
  const CONTENT_SECURITY_POLICY = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');

  /** 统一的响应头。在请求最前面挂上，HTML / JSON / 代理响应都覆盖到。 */
  function applySecurityHeaders(req, res) {
    res.setHeader('content-security-policy', CONTENT_SECURITY_POLICY);
    res.setHeader('x-frame-options', 'DENY');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    // 只有真的走 HTTPS 才发 HSTS（否则明文访问会被浏览器记成必须 HTTPS，把服务锁死）
    if (isSecureRequest(req)) {
      res.setHeader('strict-transport-security', 'max-age=31536000; includeSubDomains');
    }
    return res;
  }

  /**
   * HTTPS 判断：前面是 1Panel openresty 反代，看 x-forwarded-proto。
   * 口径与 clientIp() 一致（见 src/client-ip.mjs）：socket 来源不可信就无视这个头。
   */
  function isSecureRequest(req) {
    return isSecureRequestOf({ remoteAddress: req.socket?.remoteAddress, headers: req.headers }, trustedProxyCidrs);
  }

  /** 当前请求携带的原始 session token（没有则空串）。 */
  function sessionTokenOf(req) {
    return parseCookies(req.headers.cookie ?? '')[SESSION_COOKIE] ?? '';
  }

  /** 当前登录的管理员名（session cookie 无效/过期/已吊销/用户已删 → null）。 */
  function currentUser(req) {
    if (users.length === 0) return null;
    const payload = sessions.verify(sessionTokenOf(req));
    if (!payload) return null;
    return users.some((u) => safeEqualText(u.username, payload.u)) ? payload.u : null;
  }

  function setSession(res, username, secure) {
    res.setHeader('set-cookie', sessionCookieHeader(sessions.sign({ username }), { secure }));
  }

  function validateUsername(raw) {
    const username = String(raw ?? '').trim();
    if (!/^[A-Za-z0-9._@-]{1,64}$/.test(username)) {
      throw new HttpError(400, '用户名只能包含字母、数字与 . _ @ -，长度 1-64');
    }
    return username;
  }

  function validatePassword(raw) {
    const password = typeof raw === 'string' ? raw : '';
    if (password.length < PASSWORD_MIN) throw new HttpError(400, `密码长度至少 ${PASSWORD_MIN} 位`);
    if (password.length > PASSWORD_MAX) throw new HttpError(400, `密码长度不能超过 ${PASSWORD_MAX} 位`);
    return password;
  }

  function rateLimited(res, retryAfterMs) {
    const sec = Math.max(1, Math.ceil(retryAfterMs / 1000));
    res.setHeader('retry-after', String(sec));
    sendJSON(res, 429, {
      error: { message: `登录失败次数过多，账号已被锁定，请 ${sec} 秒后再试`, type: 'rate_limited' },
      retryAfterMs,
    });
  }

  /** /api/auth/*：初始化 / 登录 / 登出 / 当前登录状态。 */
  async function handleAuth(req, res, url) {
    const p = url.pathname;
    const secure = isSecureRequest(req);
    const ip = clientIp(req);

    if (req.method === 'GET' && p === '/api/auth/me') {
      const username = currentUser(req);
      const me = username ? users.find((u) => safeEqualText(u.username, username)) : null;
      return sendJSON(res, 200, {
        ok: true,
        authenticated: !!username,
        setupRequired: isSetupRequired(),
        user: me ? { username: me.username, createdAt: me.createdAt ?? null } : null,
      });
    }

    // 初始化：只有 users.json 不存在或为空时才可用，完成后永久关闭（403）
    if (req.method === 'POST' && p === '/api/auth/setup') {
      // fail-closed：users.json 损坏时绝不能重新开放初始化（否则匿名者可接管并覆盖管理员）
      if (usersLoadFailed) {
        throw new HttpError(503, '管理员列表读取失败，初始化接口已关闭；请修复 config/users.json 后重启');
      }
      if (!isSetupRequired()) throw new HttpError(403, '已完成初始化，初始化接口已永久关闭');
      if (!store.writable()) {
        throw new HttpError(403, '凭据以只读方式挂载，无法创建管理员；请改用可写的 config/ 目录');
      }
      if (setupInProgress) throw new HttpError(409, '初始化正在进行，请稍后重试');
      setupInProgress = true;
      try {
        const body = await readJSONBody(req);
        const username = validateUsername(body.username);
        const password = validatePassword(body.password);
        if (users.length > 0) throw new HttpError(403, '已完成初始化，初始化接口已永久关闭');
        users = store.saveUsers([{ username, passwordHash: await hashPassword(password), createdAt: Date.now() }]);
        note('info', `后台初始化完成：创建管理员「${sanitizeForLog(username)}」（${sanitizeForLog(ip)}）`);
        setSession(res, username, secure);
        return sendJSON(res, 201, { ok: true, user: { username } });
      } finally {
        setupInProgress = false;
      }
    }

    if (req.method === 'POST' && p === '/api/auth/login') {
      const body = await readJSONBody(req);
      const username = String(body.username ?? '').trim();
      const password = typeof body.password === 'string' ? body.password : '';

      // 锁定只按「用户名」判定：针对某个账号的连错只锁那个账号，
      // 反代后也不再有「匿名者锁死全体管理员」的单桶问题（来源只做统计/日志）。
      const gate = loginLimiter.check(ip, username);
      if (gate.locked) return rateLimited(res, gate.retryAfterMs);

      const user = findUser(username);
      const passwordOk = await verifyPassword(password, user ? user.passwordHash : await dummyPasswordHash());

      if (!user || !passwordOk) {
        const r = loginLimiter.fail(ip, username || null);
        // 审查 A6：username / ip 都是外部输入，先清洗再拼日志，防止换行伪造日志行 / ANSI 注入
        const safeUser = sanitizeForLog(username || '-');
        const safeIp = sanitizeForLog(ip);
        note('warn', r.locked
          ? `后台登录失败（针对「${safeUser}」，已锁定 ${Math.round((r.retryAfterMs ?? LOGIN_LOCK_MS) / 60000)} 分钟）：来自 ${safeIp}`
          : `后台登录失败：来自 ${safeIp}（用户名「${safeUser}」剩余 ${r.remaining} 次机会）`);
        if (r.locked) return rateLimited(res, r.retryAfterMs);
        return sendJSON(res, 401, { error: { message: '用户名或密码错误', type: 'auth_error' } });
      }

      loginLimiter.reset(ip, user.username);
      setSession(res, user.username, secure);
      note('info', `管理员「${sanitizeForLog(user.username)}」登录成功（${sanitizeForLog(ip)}）`);
      return sendJSON(res, 200, { ok: true, user: { username: user.username } });
    }

    if (req.method === 'POST' && p === '/api/auth/logout') {
      const revoked = sessions.revoke(sessionTokenOf(req));
      res.setHeader('set-cookie', clearCookieHeader({ secure }));
      note('info', `管理员退出登录（${sanitizeForLog(ip)}）${revoked ? '' : '（会话已过期）'}`);
      return sendJSON(res, 200, { ok: true });
    }

    throw new HttpError(404, '未知的鉴权接口');
  }

  // ── 额度查询与刷新 ──────────────────────────────────────
  /**
   * 余额见底时的主动探针。
   *
   * 必要性：对「余额不足」的识别原本是被动的 —— 只有真实请求撞上去才发现，
   * 于是账号明明已经不能用（实测主号余额 $0.098，任何模型都回 400
   * insufficient credits），面板却还写着「可用」，因为还没有请求轮到它。
   *
   * 只对「余额快见底」的账号探（内部记 probeState，正常账号一次都不打），
   * 命中即记标记并停止再探 —— 开销可忽略（每次 1 个输出 token）。
   *
   * B2：光靠「已标记」去重不够 —— 余额低于阈值但**仍可用**的账号（belowThreshold 的大套餐、
   * 余额低于 2% 周期的账号）会每轮都被探，活跃期 60s 一次 = 1440 次推理/天，全记在该账号
   * 账单上；探针自身失败（超时/套餐不含该模型/5xx/429）也会每轮重打。因此再加：
   *  - TTL（config.creditsProbeTtlMs，默认 10 分钟）：同一账号两次探针的最小间隔；
   *  - 失败指数退避（1×→2×→4× TTL…，封顶 config.creditsProbeFailBackoffMaxMs，默认 1 小时），
   *    探针成功/明确没钱后重置；
   *  - 「已判定余额不足 → 停止再探」的既有短路保留（见上面的 creditsExhaustedState）。
   */
  const probeState = new Map();   // keyId → { at, verdict, fails, nextAt }

  async function maybeProbeCredits(account, snapshot) {
    if (!config.creditsProbeEnabled) return null;
    // 已经标记过的不再探：等余额变多（充值/周期刷新）由 recordQuota 自动解除
    if (scheduler.creditsExhaustedState(account)) return null;
    // 已经因为窗口打满/暂停/鉴权失效而不可调度的账号不必探 —— 反正不会选它，
    // 探针是「我要用它之前的最后一道确认」，不是巡检。
    if (!scheduler.isAvailable(account)) return null;
    if (!shouldProbeCredits(snapshot, config.creditsProbeBelowUsd, config.creditsProbeBelowRatio)) return null;

    const now = nowFn();
    const prev = probeState.get(account.keyId);
    // TTL / 失败退避未到点 → 直接跳过，不打上游（探针是真花钱的推理请求）
    if (prev && Number.isFinite(prev.nextAt) && now < prev.nextAt) return null;

    const result = await probeAccountCredits(account.key, {
      baseUrl: config.upstreamProxyUrl,
      model: config.creditsProbeModel,
      timeoutMs: config.creditsProbeTimeoutMs,
      fetchImpl: overrides.fetchImpl,
    });

    const weighted = creditsProbeWeight(result);
    const fails = weighted.ok ? 0 : (prev?.fails ?? 0) + 1;
    const ttl = Number(config.creditsProbeTtlMs) > 0 ? Number(config.creditsProbeTtlMs) : 10 * 60 * 1000;
    const backoffMs = weighted.ok ? ttl : probeBackoffMs(fails, ttl, config.creditsProbeFailBackoffMaxMs);
    const verdict = weighted.insufficientCredits ? 'no-credits' : (weighted.ok ? 'ok' : 'unknown');
    probeState.set(account.keyId, { at: now, verdict, fails, nextAt: now + backoffMs });

    if (weighted.insufficientCredits) {
      scheduler.markCreditsExhausted(account, '余额不足（探针实测：上游拒付）');
      log.warn(`账号「${account.name}」探针实测余额不足（剩余 ${snapshot.remaining}），已停止调度`);
    } else if (!weighted.ok) {
      // 探针本身失败（超时/套餐不含该模型/5xx）：不据此改判定，只记一笔；
      // 下一次允许时间已按失败次数指数放大。
      log.debug?.(`账号「${account.name}」余额探针无结论（第 ${fails} 次，${Math.round(backoffMs / 1000)}s 后再探）: ${redact(result.error ?? '', secrets)}`);
    }
    return result;
  }

  /** B2：探针退避时长 = TTL × 2^(fails-1)，封顶 maxMs。 */
  function probeBackoffMs(fails, ttlMs, maxMs) {
    const cap = Number(maxMs) > 0 ? Number(maxMs) : 60 * 60 * 1000;
    return Math.min(cap, ttlMs * 2 ** Math.max(0, fails - 1));
  }

  /** 探针结果是否算「成功」（成功或明确没钱都重置退避）。 */
  function creditsProbeWeight(result) {
    return { ok: !!result?.ok || !!result?.insufficientCredits, insufficientCredits: !!result?.insufficientCredits };
  }

  // ── 单账号额度刷新去重（B1）──────────────────────────────
  // 一次请求撞额度错误就触发一轮 4 接口查询；并发时按在途数线性放大（8 并发 → 32 次上游调用）。
  // 按账号复用同一个在途 promise + 每账号最小刷新间隔，把放大压回 1~2 轮。
  const REFRESH_ACCOUNT_MIN_INTERVAL_MS = 5000;
  const accountRefreshInFlight = new Map();   // keyId → Promise
  const accountRefreshLastAt = new Map();     // keyId → 上次发起刷新的墙钟

  async function doRefreshAccount(account) {
    const snapshot = await fetchQuota(account.key, {
      baseUrl: config.ccApiBase,
      timeoutMs: config.quotaTimeoutMs,
      fetchImpl: overrides.fetchImpl,
      log,
    });
    scheduler.recordQuota(account, snapshot);
    if (!snapshot.ok) {
      const msg = redact(snapshot.error ?? '额度查询失败', secrets);
      log.warn(`账号「${account.name}」额度查询失败: ${msg}`);
    } else {
      await maybeProbeCredits(account, snapshot).catch((e) => {
        log.debug?.(`余额探针异常: ${e?.message ?? String(e)}`);
      });
    }
    return { account, snapshot };
  }

  /**
   * 单账号刷新入口（B1）：同账号已有在途刷新 → 复用同一个 promise；距上次刷新不足
   * REFRESH_ACCOUNT_MIN_INTERVAL_MS → 直接复用上一次结果（跳过本轮 4 个上游请求）。
   * force=true 用于轮询/手动刷新等「确实要拿最新值」的路径，跳过最小间隔但仍共享在途 promise。
   */
  function refreshAccount(account, { force = false } = {}) {
    const id = account?.keyId;
    if (!id) return doRefreshAccount(account);
    const inFlight = accountRefreshInFlight.get(id);
    if (inFlight) return inFlight;
    if (!force) {
      const last = accountRefreshLastAt.get(id);
      if (Number.isFinite(last) && nowFn() - last < REFRESH_ACCOUNT_MIN_INTERVAL_MS) {
        return Promise.resolve({
          account,
          snapshot: scheduler.runtime(account).lastQuota ?? null,
          skipped: true,
        });
      }
    }
    const tracked = doRefreshAccount(account).finally(() => {
      if (accountRefreshInFlight.get(id) === tracked) accountRefreshInFlight.delete(id);
    });
    tracked.catch(() => { /* 调用方各自 catch；这里只防未处理拒绝 */ });
    accountRefreshInFlight.set(id, tracked);
    accountRefreshLastAt.set(id, nowFn());
    return tracked;
  }

  // 进行中的一轮刷新（含手动点「刷新额度」触发的）：轮询据此跳过，避免叠起来
  let refreshInFlight = null;

  /**
   * 审查#5：进行中的刷新直接复用同一个 Promise —— 手动刷新 / 轮询 / 启动刷新
   * 全部走这一个入口。早先每次调用都新开一轮 doRefreshAll()，refreshInFlight 只挡住了
   * 轮询，手动连点就会叠加多轮全账号查询（每轮每账号 4 个上游请求）。
   */
  function refreshAll() {
    if (refreshInFlight) return refreshInFlight;
    const p = doRefreshAll().finally(() => { if (refreshInFlight === p) refreshInFlight = null; });
    refreshInFlight = p;
    return p;
  }

  async function doRefreshAll() {
    // 各账号互不影响：单个失败不会中断其它查询
    const results = await Promise.all(accounts.map((a) => refreshAccount(a, { force: true }).catch((e) => ({
      account: a,
      snapshot: { ok: false, error: redact(e?.message ?? String(e), secrets), authInvalid: false, fetchedAt: Date.now() },
    }))));
    store.saveState();
    return results;
  }

  // ── 额度轮询：自适应间隔（活跃 60s / 空闲 300s）─────────
  // 单个自调度 setTimeout：每轮跑完再根据「距上次代理活动多久」决定下一拍。
  const poller = createAdaptivePoller({
    idleIntervalMs: config.quotaPollIntervalMs,
    activeIntervalMs: config.quotaActivePollIntervalMs,
    activeWindowMs: config.quotaActiveWindowMs,
    run: refreshAll,
    onError: (e) => log.error(`额度轮询异常: ${e.message}`),
    isBusy: () => refreshInFlight !== null,
    log,
  });
  /** 代理请求后回调：标记「最近有活动」，让下一拍换成活跃间隔（60s）。 */
  function touchActivity() {
    poller.touch();
  }

  const proxy = createProxy({ config, scheduler, log, stats, secrets, refreshAccount, touchActivity, persistState: () => store.saveState() });

  // ── 后台定时器 ─────────────────────────────────────────
  let recheckTimer = null;
  let historyTimer = null;
  // 暂停复查互斥（F8）：单轮要串行查 N 个账号的上游额度，慢时远超间隔；
  // setInterval 不等待，前一轮没跑完就要跳过本轮，否则同一账号被重复查询、放大 CC API 压力。
  let recheckRunning = false;
  function runPausedRecheck() {
    if (recheckRunning) return false;
    recheckRunning = true;
    scheduler.recheckPaused({ fetchQuota: (a) => fetchQuota(a.key, { baseUrl: config.ccApiBase, timeoutMs: config.quotaTimeoutMs, fetchImpl: overrides.fetchImpl, log }) })
      .then(() => store.saveState())
      .catch((e) => log.error(`暂停复查异常: ${e.message}`))
      .finally(() => { recheckRunning = false; });
    return true;
  }
  if (!overrides.noTimers) {
    poller.start();
    if (config.pausedRecheckIntervalMs > 0) {
      recheckTimer = setInterval(runPausedRecheck, config.pausedRecheckIntervalMs);
      recheckTimer.unref?.();
    }
    // B13：周期采样历史趋势。只有真的定稿了一个样本才落盘，避免每分钟都写 state.json。
    historyTimer = setInterval(() => {
      const { rolled } = history.record({
        requests: stats.total,
        errors: stats.errors,
        tokens: stats.totalTokens,
        available: accounts.filter((a) => scheduler.isAvailable(a)).length,
        remaining: usableRemainingTotal(),
      });
      if (rolled) { try { store.saveState(); } catch { /* 落盘失败不影响服务 */ } }
    }, HISTORY_TICK_MS);
    historyTimer.unref?.();   // 不要因为这个定时器卡住退出
  }

  // ── 鉴权 ───────────────────────────────────────────────
  function extractKey(req) {
    const auth = req.headers.authorization ?? '';
    if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
    const xk = req.headers['x-api-key'];
    if (typeof xk === 'string' && xk) return xk.trim();
    return '';
  }

  // 两侧都先 sha256 成等长摘要再 timingSafeEqual，避免逐字符比较泄漏时序信息；
  // 长度/内容不同都走同一条比较路径（摘要等长，timingSafeEqual 不会因长度抛错）。
  function sha256(text) {
    return createHash('sha256').update(String(text ?? ''), 'utf8').digest();
  }

  function localKeyIndexOf(key) {
    const probe = sha256(key);
    return localKeys.findIndex((k) => timingSafeEqual(probe, sha256(k.key)));
  }

  function sendJSON(res, status, obj) {
    if (res.writableEnded || res.headersSent) return;
    const body = JSON.stringify(obj);
    // no-store：鉴权/后台/面板接口的响应都不该被任何缓存留存（F13）
    res.setHeader('cache-control', 'no-store');
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  }

  function authError(res) {
    sendJSON(res, 401, { error: { message: 'Invalid or missing API key. Provide Authorization: Bearer <key> or x-api-key.', type: 'auth_error' } });
  }

  /**
   * 后台/面板读取接口鉴权：只看签名 session cookie（不再接受 sk-cg- key）。
   * 未登录 → 401 + WWW-Authenticate: Cookie。
   */
  function requireSession(req, res) {
    const username = currentUser(req);
    if (username) return username;
    res.setHeader('www-authenticate', 'Cookie');
    sendJSON(res, 401, { error: { message: '需要登录后台（session 缺失或已过期）', type: 'auth_error' } });
    return null;
  }

  /** 前台面板是否公开可读（PUBLIC_DASHBOARD=1 默认公开；0 → 需登录 session）。 */
  function dashboardPublic() {
    return config.publicDashboard !== false && config.protectAdminApi !== true;
  }

  /**
   * 兼容旧的 PROTECT_ADMIN_API=1（该开关下面板接口仍接受本地 sk-cg- key，老部署不至于被踢下线）。
   * 新部署请改用 PUBLIC_DASHBOARD=0 + 后台登录 session。
   */
  function legacyKeyAllowed(req) {
    return config.protectAdminApi === true && localKeys.length > 0 && localKeyIndexOf(extractKey(req)) >= 0;
  }

  /** 面板读接口鉴权：公开 → 放行；隐私模式 → session 或（旧模式）本地 key。 */
  function requirePanelRead(req, res) {
    if (dashboardPublic()) return true;
    if (currentUser(req) || legacyKeyAllowed(req)) return true;
    return requireSession(req, res);
  }

  // ── 请求统计视图 ────────────────────────────────────────
  /**
   * 账号视图。`withKeyPrefix` 默认 false —— keyPrefix 是真实 key 的前 9 字符，
   * 公开面板（/api/status）不需要它，绝不该下发到浏览器。只有已登录的后台
   * （/api/admin/accounts）才带上，用于和上游站点对账。
   */
  // 月额度「算用完」的百分比：**只影响文案**，不影响调度判定（调度只看
  // 窗口打满 / 探针实测拒付）。官方 usage_exceeded 的首因就是「月度额度用完」。
  const MONTHLY_SPENT_PCT = 99;

  /**
   * 面板口径的「额度已用完」——把不同来源的耗尽归纳成一句话 + 恢复时间：
   *   ① 上游点名的滚动窗口（权威标记 exceeded）→ 周 / 5 小时额度已用完
   *   ② 探针实测上游拒付 + 月度确实花光      → 月额度已用完
   *   ③ 探针实测拒付但月度没花光            → 余额不足（不冒充额度用完）
   * @returns {{kind: string, label: string, resetAt: number|null}|null}
   */
  function exhaustedView(rt, q) {
    const win = q?.exceededWindow;
    if (win === 'weekly' || win === 'fiveHour') {
      const w = win === 'weekly' ? q.weekly : q.fiveHour;
      return {
        kind: 'window',
        window: win,
        label: win === 'weekly' ? '周额度已用完' : '5 小时额度已用完',
        resetAt: w?.resetAt ?? null,
      };
    }
    if (rt.creditsExhausted) {
      const pct = Number(q?.monthly?.percent);
      const spent = Number.isFinite(pct) && pct >= MONTHLY_SPENT_PCT;
      return spent
        ? { kind: 'monthly', label: '月额度已用完', resetAt: q?.monthly?.resetAt ?? null }
        : { kind: 'balance', label: '余额不足', resetAt: null };
    }
    return null;
  }

  /**
   * 面板口径的「这个账号还能用多少钱」——与前台 render-cards.js 的 usableRemaining 一一对应：
   *   - 没有快照 / remaining 非有限数 → null（从合计里排除，不当 0 低估池余额）；
   *   - 月额度用完 / 余额不足（上游实测付不了）→ 0；
   *   - 只是窗口排队（window）→ 真实余额（钱没死）。
   */
  function usableRemaining(account) {
    const rt = scheduler.runtime(account);
    const q = rt.lastQuota;
    if (!q || !Number.isFinite(q.remaining)) return null;
    const kind = exhaustedView(rt, q)?.kind;
    if (kind === 'monthly' || kind === 'balance') return 0;
    return q.remaining;
  }

  /** 可用余额合计（USD，2 位小数）：无快照账号排除在外，一个都没同步时记 0。 */
  function usableRemainingTotal() {
    let sum = 0;
    let synced = false;
    for (const a of accounts) {
      const v = usableRemaining(a);
      if (!Number.isFinite(v)) continue;
      sum += v;
      synced = true;
    }
    return synced ? Math.round(sum * 100) / 100 : 0;
  }

  function accountView(account, { withKeyPrefix = false, internal = false } = {}) {
    const rt = scheduler.runtime(account);
    const q = rt.lastQuota;
    const pct = (w) => (w && typeof w.percent === 'number' ? Math.round(w.percent * 10) / 10 : null);
    return {
      name: account.name,
      keyId: account.keyId,          // 只暴露 keyId，绝不返回完整 key
      ...(withKeyPrefix ? { keyPrefix: account.keyPrefix } : {}),
      enabled: account.enabled,
      available: scheduler.isAvailable(account),
      concurrency: rt.concurrency,
      pausedUntil: rt.pausedUntil,
      paused: !!(rt.pausedUntil && rt.pausedUntil > Date.now()),
      // M2：普通限流（429 非额度）的 60s 短冷却状态 —— 前端读 a.rateLimited 渲染，
      // 历史不下发导致被限流账号被画成红色「不可调度」。
      rateLimited: !!(rt.rateLimitedUntil && rt.rateLimitedUntil > Date.now()),
      rateLimitedUntil: rt.rateLimitedUntil ?? null,
      authInvalid: !!rt.authInvalid,
      // 上游明确说余额不足：面板要能把它和「暂停到 X」区分开（充值或周期刷新才恢复）
      creditsExhausted: !!rt.creditsExhausted,
      creditsExhaustedAt: rt.creditsExhausted?.at ?? null,
      // 统一口径的「额度已用完」（含恢复时间），与窗口耗尽同一类说法
      exhausted: exhaustedView(rt, q),
      // B12：/api/status 匿名可读，lastError / lastErrorAt 是上游报错原文（措辞、超时描述），
      // 只给已登录的后台；对外档用条件展开让这两个键**不存在**（不是 null）。
      ...(internal
        ? { lastError: rt.lastError ? redact(rt.lastError, secrets) : null, lastErrorAt: rt.lastErrorAt }
        : {}),
      lastQuota: q
        ? {
            ok: q.ok,
            // B12：displayName 是上游账号的真实身份（线上实测就是用户本人账号名）；
            // 公开面板不得下发，后台（internal）照旧全量。用条件展开保证键不存在。
            ...(internal ? { displayName: q.displayName } : {}),
            plan: q.plan,
            remaining: q.remaining,
            credits: q.credits,
            fiveHour: q.fiveHour,
            weekly: q.weekly,
            exceededWindow: q.exceededWindow ?? null,
            monthly: q.monthly,
            usage: q.usage,
            percent: { fiveHour: pct(q.fiveHour), weekly: pct(q.weekly), monthly: pct(q.monthly) },
            fetchedAt: q.fetchedAt,
          }
        : null,
    };
  }

  // internal 默认 false = 对外安全档：/api/status 匿名可读，只下发面板必需字段，
  // 摘掉上游身份（lastQuota.displayName）与内部错误原文（lastError / lastErrorAt）。
  function statusView({ internal = false } = {}) {
    const accounts_ = accounts.map((a) => accountView(a, { internal }));
    const availableCount = accounts.filter((a) => scheduler.isAvailable(a)).length;
    return {
      ok: true,
      now: Date.now(),
      allowPassthrough: config.allowPassthrough,
      // M1：匿名可读的 /api/status 不下发上游拓扑（内核地址如 http://core:3050、
      // 网关 host/port）。前端已不消费该字段，暴露只会帮攻击者画网络地图。
      summary: {
        accounts: accounts.length,
        enabled: accounts.filter((a) => a.enabled).length,
        available: availableCount,
        // 不可用 = 总数 - 可用：暂停/冷却只是部分口径，这个数才补齐「账号 3 / 可用 2」的缺口。
        unavailable: accounts.length - availableCount,
        // 注意：pausedUntil 在运行期状态（rt）上，不在账号对象本身。
        // 早期写成 a.pausedUntil（恒为 undefined）→「暂停中」永远显示 0。
        paused: accounts.filter((a) => {
          const rt = scheduler.runtime(a);
          return rt.pausedUntil && rt.pausedUntil > Date.now();
        }).length,
        concurrency: accounts.reduce((n, a) => n + (scheduler.runtime(a).concurrency || 0), 0),
      },
      stats: {
        total: stats.total,
        errors: stats.errors,
        // 客户端 4xx（模型名错 / 请求非法等）单独计，不污染「上游错误数」KPI。
        clientErrors: stats.clientErrors ?? 0,
        // 客户端主动中止（Ctrl-C 长回答）：单独口径，不计入 errors（F10）
        aborted: stats.aborted ?? 0,
        totalTokens: stats.totalTokens,
        byAccount: Object.fromEntries(Object.entries(stats.byAccount).map(([id, s]) => [id, { ...s }])),
      },
      accounts: accounts_,
      // 轮询配置：前端据此计算「快照过旧」阈值，避免把阈值写死在页面里
      quotaPoll: {
        idleIntervalMs: config.quotaPollIntervalMs,
        activeIntervalMs: config.quotaActivePollIntervalMs,
        activeWindowMs: config.quotaActiveWindowMs,
      },
    };
  }


  // ── 全池无可用账号时的自动刷新（审查 A4）─────────────────
  // 触发条件（二者其一）：池内存在账号的某个窗口 resetAt 已是过去时（窗口应已重置），
  // 或 lastQuota.fetchedAt 缺失 / 距现在超过 2 × idleIntervalMs（快照过旧）。
  function poolStaleAfterMs() {
    const idle = Number(config.quotaPollIntervalMs);
    return 2 * (idle > 0 ? idle : 600000);
  }

  function poolNeedsRefresh(now = Date.now()) {
    const staleAfter = poolStaleAfterMs();
    for (const a of accounts) {
      if (a.enabled === false) continue;
      const q = scheduler.runtime(a).lastQuota;
      if (!q) return true;                       // 从没拿到过快照 → 必须刷
      for (const w of quotaWindows(q)) {
        const reset = Number(w.resetAt);
        if (Number.isFinite(reset) && reset * 1000 <= now) return true;   // 窗口已过期
      }
      const fetchedAt = Number(q.fetchedAt);
      if (!Number.isFinite(fetchedAt) || now - fetchedAt > staleAfter) return true;  // 快照过旧
    }
    return false;
  }

  // 串行请求的冷却：refreshAll 只去重「并发」，连发 503 仍会一轮轮打上游。
  let lastAutoRefreshAt = 0;
  function canAutoRefreshPool(now = Date.now()) {
    if (now - lastAutoRefreshAt < POOL_REFRESH_MIN_MS) return false;
    lastAutoRefreshAt = now;
    return true;
  }

  /**
   * 503 的可重试提示：距最近一个「未来恢复时刻」的毫秒数，取不到给保守默认值。
   * L3：只统计可调度候选（enabled 且非 authInvalid/creditsExhausted）—— 被禁用账号的
   * +5 天 resetAt 会把 Retry-After 抬成天级。候选包含 pausedUntil（暂停账号最早恢复时刻）。
   */
  function retryAfterMsForPool(now = Date.now()) {
    let nearest = Infinity;
    for (const a of accounts) {
      if (a.enabled === false) continue;
      const rt = scheduler.runtime(a);
      if (rt.authInvalid || rt.creditsExhausted) continue;
      if (Number.isFinite(rt.pausedUntil) && rt.pausedUntil > now) nearest = Math.min(nearest, rt.pausedUntil);
      const q = rt.lastQuota;
      for (const w of quotaWindows(q)) {
        const reset = Number(w.resetAt);
        if (Number.isFinite(reset) && reset * 1000 > now) nearest = Math.min(nearest, reset * 1000);
      }
    }
    return Number.isFinite(nearest) ? nearest - now : DEFAULT_POOL_RETRY_AFTER_MS;
  }

  // ── 账号池 / 本地 key 热生效 ───────────────────────────
  /** 用最新的凭据列表原地更新账号池（proxy 持有的 scheduler 引用不变，无需重启）。 */
  function syncPool(list) {
    const byId = new Map(list.map((a) => [a.keyId, a]));
    for (let i = accounts.length - 1; i >= 0; i--) {
      if (!byId.has(accounts[i].keyId)) accounts.splice(i, 1);
    }
    for (let i = 0; i < list.length; i++) {
      const fresh = list[i];
      const idx = accounts.findIndex((a) => a.keyId === fresh.keyId);
      if (idx < 0) accounts.splice(i, 0, fresh);
      else accounts[idx] = fresh;
    }
    for (const a of accounts) {
      scheduler.runtime(a);
      stats.byAccount[a.keyId] ??= { requests: 0, errors: 0, tokens: 0 };
      log.registerSecret(a.key);
      if (!secrets.includes(a.key)) secrets.push(a.key);
    }
  }

  function syncKeys(list) {
    localKeys.length = 0;
    localKeys.push(...list);
    for (const k of localKeys) {
      log.registerSecret(k.key);
      if (!secrets.includes(k.key)) secrets.push(k.key);
    }
  }

  /** 重新读盘并热生效：账号池、本地 key、调度器状态、残留清理。 */
  function reloadNow() {
    const fresh = store.reload();
    syncPool(fresh.accounts);
    syncKeys(fresh.keys);
    const removed = store.pruneState(accounts);
    store.saveState();
    return { ...fresh, removed };
  }

  // ── 后台写接口 ─────────────────────────────────────────
  const NAME_MAX = 64;
  const ACCOUNT_KEY_MIN = 20;
  const ACCOUNT_KEY_MAX = 200;

  function requireWritable() {
    if (!store.writable()) {
      throw new HttpError(403, '凭据以只读方式挂载，无法修改；请改用 config/ 目录挂载');
    }
  }

  /**
   * 操作者标识：后台登录用户名 + 来源 IP（B17-#8）。
   *
   * 历史实现取 `req.socket.remoteAddress` —— 反代（1Panel openresty）之后它恒为代理地址，
   * 审计日志里所有人都是同一个 IP，出事后无法定位真人。改用 clientIp(req)（走
   * resolveClientIp 处理可信 XFF），与登录日志同一口径。不可信来源时 clientIp 自动回落 socket。
   */
  function actorOf(req) {
    return `user=${currentUser(req) ?? 'unknown'}@${clientIp(req)}`;
  }

  /**
   * 路径参数解码（B17-#4）：`decodeURIComponent('%')` 会抛 URIError，原样逃逸出路由就变成
   * 500「后台接口内部错误」。这里统一转成 400，并明确说明是路径参数的编码问题。
   */
  function safeDecodeURIComponent(raw) {
    try {
      return decodeURIComponent(raw);
    } catch {
      throw new HttpError(400, '路径参数编码非法：不是合法的 percent-encoding');
    }
  }

  // B17-#6：名称直接插值进 note()/日志，而 redact **不转义换行** —— 带 \n 的名字能在日志里
  // 伪造出一条「自带时间戳 / level」的独立行（日志伪造），带 ANSI 转义还能污染终端。
  // 同文件里用户名 / IP / sessionId 都走了 sanitizeForLog；这里对账号名与客户端 key 名
  // 统一**拒绝**控制字符（比转义更清晰，也不会有漏网的分支）。
  const NAME_CONTROL_RE = /[\u0000-\u001f\u007f]/;
  function cleanName(raw) {
    const name = String(raw ?? '').trim();
    if (!name) throw new HttpError(400, '名称不能为空');
    if (NAME_CONTROL_RE.test(name)) throw new HttpError(400, '名称不能包含控制字符（换行 / 制表符 / 其它 0x00-0x1f 与 0x7f）');
    if (name.length > NAME_MAX) throw new HttpError(400, `名称长度不能超过 ${NAME_MAX} 个字符`);
    return name;
  }

  function cleanAccountKey(raw) {
    const key = String(raw ?? '').trim();
    if (!key.startsWith(CC_KEY_PREFIX)) throw new HttpError(400, `账号 key 必须以 ${CC_KEY_PREFIX} 开头`);
    if (key.length < ACCOUNT_KEY_MIN || key.length > ACCOUNT_KEY_MAX) {
      throw new HttpError(400, `账号 key 长度必须在 ${ACCOUNT_KEY_MIN}-${ACCOUNT_KEY_MAX} 之间（当前 ${key.length}）`);
    }
    return key;
  }

  function credentialAccounts(list = accounts) {
    return list.map((a) => ({ name: a.name, key: a.key, enabled: a.enabled !== false }));
  }

  /**
   * B17-#1：账号池至少要保留一个**启用**账号，否则调度器无号可用、所有 /v1 请求 503。
   *
   * DELETE 与 PATCH（停用）共用这一条守卫，语义完全一致：变更后掉到 0 个启用账号 → 409，
   * 文案明确告诉操作者「请先启用其它账号」。历史 bug：DELETE 有守卫而 PATCH 没有，
   * 于是 `PATCH {enabled:false}` 能把最后一个可用账号停掉，绕过 DELETE 的保护。
   * @param {Array<{enabled:boolean}>} next 变更后的账号列表
   * @param {string} verb 动作（删除 / 停用），用于文案
   */
  function assertEnabledAccountRemains(next, verb) {
    if (next.some((a) => a.enabled !== false)) return;
    throw new HttpError(409, next.length === 0
      ? `不能${verb}最后一个账号：${verb}后账号池为空，所有请求都会失败`
      : `不能${verb}最后一个可用账号：${verb}后没有可调度的账号（请先启用其它账号）`);
  }

  function credentialKeys(list = localKeys) {
    return list.map((k) => (k.createdAt === null || k.createdAt === undefined
      ? { name: k.name, key: k.key }
      : { name: k.name, key: k.key, createdAt: k.createdAt }));
  }

  /** 对外账号视图：只有 keyId / keyPrefix，绝不含完整 key。 */
  function pubAccount(a) {
    const rt = scheduler.runtime(a);
    return {
      name: a.name,
      keyId: a.keyId,
      keyPrefix: a.keyPrefix,
      enabled: a.enabled !== false,
      available: scheduler.isAvailable(a),
      paused: !!(rt.pausedUntil && rt.pausedUntil > Date.now()),
      // M2：同 accountView，公开视图也必须下发 rateLimited（前端依赖）。
      rateLimited: !!(rt.rateLimitedUntil && rt.rateLimitedUntil > Date.now()),
      rateLimitedUntil: rt.rateLimitedUntil ?? null,
      authInvalid: !!rt.authInvalid,
      creditsExhausted: !!rt.creditsExhausted,
      creditsExhaustedAt: rt.creditsExhausted?.at ?? null,
      exhausted: exhaustedView(rt, rt.lastQuota),
    };
  }

  function pubKey(k) {
    return { name: k.name, keyId: k.keyId, keyPrefix: k.keyPrefix, createdAt: k.createdAt ?? null };
  }

  function readBody(req, limit = ADMIN_BODY_LIMIT) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      let done = false;
      const fail = (err) => {
        if (done) return;
        done = true;
        reject(err);
        req.destroy?.();
      };
      req.on('data', (c) => {
        if (done) return;
        chunks.push(c);
        size += c.length;
        if (size > limit) return fail(new HttpError(413, '请求体过大'));
      });
      req.once('end', () => {
        if (done) return;
        done = true;
        resolve(Buffer.concat(chunks).toString('utf8'));
      });
      req.once('error', (e) => fail(e));
    });
  }

  async function readJSONBody(req) {
    const text = (await readBody(req)).trim();
    if (!text) return {};
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      // 只回通用文案（F19）：JSON.parse 的 e.message 会把用户提交的原文回显出去
      // （实测 `SECRETBODY{{{` → `Unexpected token 'S', "SECRETBODY{{{"`）。
      throw new HttpError(400, '请求体不是合法 JSON');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new HttpError(400, '请求体必须是 JSON 对象');
    return parsed;
  }

  /** sk-cg- + 32 字节随机（base64url）。只在此处生成，明文只在响应里出现一次。 */
  function generateLocalKey() {
    return `${LOCAL_KEY_PREFIX}${randomBytes(32).toString('base64url')}`;
  }

  // 连通性测试历史（内存环形，只用于后台展示）
  const testHistory = [];
  // 匿名刷新节流（F20）：按来源分桶 + 全局硬限，避免单变量被一个来源长期占住、
  // 也避免攻击者稳定每 5 秒触发一轮全账号上游查询。
  const lastPublicRefreshBySource = new Map();
  let lastPublicRefreshAt = 0;

  function eventsView(url) {
    const level = url.searchParams.get('level');
    const limitRaw = Number(url.searchParams.get('limit'));
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, EVENTS_MAX) : EVENTS_MAX;
    const list = events.filter((e) => !level || e.level === level).slice(-limit).reverse();
    return { ok: true, total: events.length, events: list };
  }

  /** 后台接口路由。命中返回 true；错误一律抛 HttpError（调用方转响应），返回 false 表示交给通用路由。 */
  async function handleAdmin(req, res, url) {
    const { method } = req;
    const p = url.pathname;

    if (method === 'GET' && p === '/api/admin/session') {
      const username = currentUser(req);
      return sendJSON(res, 200, {
        ok: true,
        authenticated: !!username,
        setupRequired: isSetupRequired(),
        writable: store.writable(),
        users: usersView(),
        dashboardPublic: dashboardPublic(),
        user: username ? { username } : null,
      });
    }

    if (method === 'GET' && p === '/api/admin/events') {
      return sendJSON(res, 200, eventsView(url));
    }

    if (method === 'GET' && p === '/api/admin/keys') {
      return sendJSON(res, 200, { ok: true, keys: localKeys.map(pubKey) });
    }

    if (method === 'GET' && p === '/api/admin/accounts') {
      return sendJSON(res, 200, {
        ok: true,
        writable: store.writable(),
        // 用 accountView（含 lastQuota 额度快照）而不是 pubAccount（只有 8 个基础字段）：
        // 后台要展示 5h/周/月进度条与余额，用 pubAccount 会永远显示「尚未获取额度快照」。
        // accountView 内部已做脱敏（只出 keyId / keyPrefix，lastError 走 redact）。
        // B12：后台已登录鉴权，走全量档（internal: true）——displayName / lastError / lastErrorAt 照旧下发。
        accounts: accounts.map((a) => accountView(a, { withKeyPrefix: true, internal: true })),
        tests: testHistory.slice(0, TEST_HISTORY_MAX),
      });
    }

    const accountMatch = p.match(/^\/api\/admin\/accounts\/([^/]+)$/);
    const keyMatch = p.match(/^\/api\/admin\/keys\/([^/]+)$/);
    const userMatch = p.match(/^\/api\/admin\/users\/([^/]+)$/);

    // ── 后台管理员账号 ──────────────────────────────────
    if (method === 'GET' && p === '/api/admin/users') {
      return sendJSON(res, 200, { ok: true, users: usersView() });
    }

    if (method === 'POST' && p === '/api/admin/users') {
      requireWritable();
      const body = await readJSONBody(req);
      const username = validateUsername(body.username);
      const password = validatePassword(body.password);
      if (findUser(username)) throw new HttpError(400, `管理员「${username}」已存在`);
      users = store.saveUsers([...users, { username, passwordHash: await hashPassword(password), createdAt: Date.now() }]);
      note('info', `新增管理员「${username}」（${actorOf(req)}）`);
      return sendJSON(res, 201, { ok: true, users: usersView() });
    }

    if (method === 'PATCH' && userMatch) {
      requireWritable();
      const actor = currentUser(req);
      const username = safeDecodeURIComponent(userMatch[1]);
      const target = findUser(username);
      if (!target) throw new HttpError(404, '管理员不存在');
      const body = await readJSONBody(req);
      // 改**他人**密码必须先证明自己是当前这个管理员（F21）：
      // 否则任何一个被盗/低权限的管理员会话都能直接改掉别人的密码并顶替其身份。
      // 改自己的密码走原流程（能登录说明身份成立），保持向后兼容。
      if (actor && !safeEqualText(actor, username)) {
        const actorUser = findUser(actor);
        const confirm = typeof body.currentPassword === 'string' ? body.currentPassword : '';
        const ok = !!actorUser && confirm.length > 0
          && await verifyPassword(confirm, actorUser.passwordHash);
        if (!ok) {
          throw new HttpError(403, `修改他人（「${username}」）的密码需要提供当前管理员「${actor}」的密码`);
        }
      }
      const password = validatePassword(body.password);
      const newHash = await hashPassword(password);
      users = store.saveUsers(users.map((u) => (safeEqualText(u.username, username)
        ? { ...u, passwordHash: newHash }
        : u)));
      // 改密码 = 踢掉该管理员的所有旧会话（含自己之外的其它浏览器）
      const killed = sessions.revokeUser(username);
      note('info', `修改管理员「${username}」的密码（${actorOf(req)}）${killed ? `，已吊销 ${killed} 个会话` : ''}`);
      return sendJSON(res, 200, { ok: true, users: usersView() });
    }

    if (method === 'DELETE' && userMatch) {
      requireWritable();
      const username = safeDecodeURIComponent(userMatch[1]);
      const target = findUser(username);
      if (!target) throw new HttpError(404, '管理员不存在');
      if (users.length <= 1) throw new HttpError(409, '至少保留一个管理员：删掉最后一个后将无法登录后台');
      users = store.saveUsers(users.filter((u) => !safeEqualText(u.username, username)));
      sessions.revokeUser(username);
      note('info', `删除管理员「${username}」（${actorOf(req)}）`);
      return sendJSON(res, 200, { ok: true, users: usersView() });
    }

    if (method === 'POST' && p === '/api/admin/accounts') {
      requireWritable();
      const body = await readJSONBody(req);
      const name = cleanName(body.name);
      const key = cleanAccountKey(body.key);
      // 审查#11：enabled 只接受严格布尔（JSON 里的 true/false）。
      // 早先 `!== false` 会把字符串 "false" 当成启用（前端/脚本传错类型就被静默反转）。
      if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
        throw new HttpError(400, 'enabled 必须是布尔值（true/false）');
      }
      if (accounts.some((a) => a.key === key)) throw new HttpError(400, '账号 key 已存在，不能重复添加');
      store.saveAccounts([...credentialAccounts(), { name, key, enabled: body.enabled !== false }]);
      reloadNow();
      const created = accounts.find((a) => a.key === key);
      note('info', `新增账号「${name}」keyId=${created.keyId}（${actorOf(req)}）`);
      return sendJSON(res, 201, { ok: true, account: pubAccount(created) });
    }

    // 测试连通性：调 CC 官方 whoami 验证 key 是否有效（不改变账号状态）
    if (method === 'POST' && p === '/api/admin/accounts/test') {
      const body = await readJSONBody(req);
      const name = body.name === undefined ? null : cleanName(body.name);
      let key = typeof body.key === 'string' ? body.key.trim() : '';
      if (!key && body.keyId) {
        const target = accounts.find((a) => a.keyId === String(body.keyId));
        if (!target) throw new HttpError(404, '账号不存在');
        key = target.key;
      }
      if (!key) throw new HttpError(400, '请提供 key 或 keyId');
      const result = await fetchWhoami(key, {
        baseUrl: config.ccApiBase,
        timeoutMs: config.quotaTimeoutMs,
        fetchImpl: overrides.fetchImpl,
        log,
      });
      const view = { ...result, keyId: keyIdOf(key), keyPrefix: keyPrefixOf(key), checkedAt: Date.now(), name };
      // 明确的鉴权恢复路径（审查#3）：whoami 就是「上游鉴权类请求」，它成功 = 这把 key 的
      // 鉴权确认恢复。额度刷新（recordQuota）无权清 markAuthInvalid，只有这里能清。
      const poolAccount = accounts.find((a) => a.key === key) ?? null;
      if (result.ok && poolAccount) {
        scheduler.clearAuthInvalid(poolAccount);
        note('info', `连通性测试确认鉴权恢复：keyId=${view.keyId}（${actorOf(req)}）`);
      }
      testHistory.unshift(view);
      while (testHistory.length > TEST_HISTORY_MAX) testHistory.pop();
      note(result.ok
        ? `连通性测试通过：keyId=${view.keyId} 登录名=${result.displayName ?? result.userName ?? '-'}（${actorOf(req)}）`
        : `连通性测试失败：keyId=${view.keyId} ${redact(result.error ?? '', secrets)}（${actorOf(req)}）`);
      return sendJSON(res, 200, { ok: true, result: view });
    }

    if (method === 'PATCH' && accountMatch) {
      requireWritable();
      const id = safeDecodeURIComponent(accountMatch[1]);
      const target = accounts.find((a) => a.keyId === id);
      if (!target) throw new HttpError(404, '账号不存在');
      const body = await readJSONBody(req);
      if (body.name === undefined && body.enabled === undefined) throw new HttpError(400, '至少要提供 name 或 enabled');
      const name = body.name === undefined ? target.name : cleanName(body.name);
      // 审查#11：同上，严格布尔校验；非法类型直接 400，不许静默转换
      if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
        throw new HttpError(400, 'enabled 必须是布尔值（true/false）');
      }
      const enabled = body.enabled === undefined ? target.enabled !== false : body.enabled;
      const next = credentialAccounts().map((a) => (a.key === target.key ? { ...a, name, enabled } : a));
      // B17-#1：停用最后一个可用账号与删除它等价（调度器同样无号可用）→ 同一守卫、同一 409。
      // 只在明确要求停用时检查；enabled:true（或只改名）不受影响。
      if (body.enabled === false) assertEnabledAccountRemains(next, '停用');
      store.saveAccounts(next);
      reloadNow();
      // 手动启用 = 运维明确要求再用它：清掉「余额不足」标记，否则用户会困惑
      // 「我明明启用了，怎么还是不可用」。真没钱的话下一个请求会再标一次（无害）。
      if (body.enabled === true) {
        scheduler.clearCreditsExhausted(accounts.find((a) => a.keyId === id) ?? target);
      }
      const changed = [body.name !== undefined ? `名称→「${name}」` : null, body.enabled !== undefined ? `状态→${enabled ? '启用' : '停用'}` : null].filter(Boolean);
      note('info', `修改账号 keyId=${id}：${changed.join('、')}（${actorOf(req)}）`);
      return sendJSON(res, 200, { ok: true, account: pubAccount(accounts.find((a) => a.keyId === id)) });
    }

    if (method === 'DELETE' && accountMatch) {
      requireWritable();
      const id = safeDecodeURIComponent(accountMatch[1]);
      const target = accounts.find((a) => a.keyId === id);
      if (!target) throw new HttpError(404, '账号不存在');
      const remaining = credentialAccounts().filter((a) => a.key !== target.key);
      assertEnabledAccountRemains(remaining, '删除');
      store.saveAccounts(remaining);
      const { removed } = reloadNow();
      note('info', `删除账号「${target.name}」keyId=${id}（${actorOf(req)}）`);
      return sendJSON(res, 200, { ok: true, keyId: id, pruned: removed.accounts.length + removed.stats.length, accounts: accounts.map(pubAccount) });
    }

    if (method === 'POST' && p === '/api/admin/keys') {
      requireWritable();
      const body = await readJSONBody(req);
      const name = cleanName(body.name);
      if (body.key !== undefined) throw new HttpError(400, '客户端 key 由服务端生成，不接受传入明文');
      let key = generateLocalKey();
      while (localKeys.some((k) => k.key === key)) key = generateLocalKey();
      const createdAt = Date.now();
      store.saveKeys([...credentialKeys(), { name, key, createdAt }]);
      reloadNow();
      const created = localKeys.find((k) => k.key === key);
      // 日志/事件里只用 keyId/keyPrefix，明文绝不入库
      note('info', `生成客户端 key「${name}」keyId=${created.keyId} prefix=${created.keyPrefix}（${actorOf(req)}）`);
      return sendJSON(res, 201, {
        ok: true,
        key: pubKey(created),
        plaintext: key,
        warning: '此 key 只显示一次',
      });
    }

    if (method === 'DELETE' && keyMatch) {
      requireWritable();
      const id = safeDecodeURIComponent(keyMatch[1]);
      const target = localKeys.find((k) => k.keyId === id);
      if (!target) throw new HttpError(404, '客户端 key 不存在');
      store.saveKeys(credentialKeys().filter((k) => k.key !== target.key));
      reloadNow();
      note('info', `删除客户端 key「${target.name}」keyId=${id}（${actorOf(req)}）`);
      return sendJSON(res, 200, { ok: true, keyId: id, keys: localKeys.map(pubKey) });
    }

    throw new HttpError(404, '未知的后台接口');
  }

  // ── 上游就绪探测（readiness）：给 /ready 用 ──────────────────────────
  // /health 是 liveness（进程活着就 200），/ready 是 readiness（上游 core 可达、能真转发 /v1）。
  // 两者必须分开：core 崩溃 / OOM / 断网后网关进程照样活着（/health 依旧 200），
  // 但所有 /v1 都会失败 —— 只探 /health 的探活于是永远绿灯，Docker 不会重启、
  // 反代也不会摘流，症状就是「面板健康、全部请求失败」。
  const upstreamBase = new URL(config.upstreamProxyUrl);
  // 探测超时 2s：core 与网关在同一条 compose 网络（或同机 loopback）上，正常是毫秒级返回。
  // 2s 足够覆盖 GC / 负载抖动，又**小于** compose healthcheck 的 timeout(5s)，
  // 保证探针自己永远不会成为 healthcheck 超时的原因。这是硬上界：到点 destroy → 按不可达处理。
  const readyProbeTimeoutMs = Number(config.readyProbeTimeoutMs) > 0 ? Number(config.readyProbeTimeoutMs) : 2000;
  // 结果缓存 1s：healthcheck 本身 30s 一次，但 /ready 还会被外部监控 / 编排器高频拉取，
  // 而且探测失败时探活会重试 —— 没有缓存时一个 100ms 轮询的监控就能给 core 打出一堆无用连接。
  // 1s 既能把同秒内的并发与密集轮询折叠成一次探测（并发请求共用同一个 in-flight promise），
  // 又足够短：core 刚挂或刚恢复，最多 1s 后下一次探测就反映真实状态（远小于任何探活周期）。
  const READY_CACHE_MS = 1000;
  let readyCache = { at: 0, up: null };
  let readyInflight = null;

  /**
   * 探一次上游 core：任何 <500 的 HTTP 应答都算「可达」——core 的 /health 回 200 OK；
   * 上游换成别的实现时 404 也说明它在应答。5xx / 连接失败 / 超时一律算「不可达」。
   */
  function probeUpstreamOnce() {
    return new Promise((resolve) => {
      let settled = false;
      const done = (up) => { if (!settled) { settled = true; resolve(up); } };
      const client = upstreamBase.protocol === 'https:' ? https : http;
      let req;
      try {
        req = client.request(new URL('/health', upstreamBase), {
          method: 'GET',
          headers: { accept: '*/*', 'user-agent': 'cc-manage-readiness' },
        }, (res) => {
          res.resume();   // 丢掉响应体，但必须读干净才能等到 end
          res.on('end', () => done((res.statusCode ?? 0) < 500));
          res.on('error', () => done(false));
        });
      } catch (e) {
        log.warn?.(`就绪探测发不出请求（${upstreamBase.origin}）：${e.message}`);
        return done(false);
      }
      // 挂住不答的上游（accept 了连接但不回响应）必须被这个硬超时收掉
      req.setTimeout(readyProbeTimeoutMs, () => req.destroy(new Error('ready probe timeout')));
      req.on('error', () => done(false));
      req.end();
    });
  }

  /** 带 in-flight 合并 + 1s 结果缓存的就绪探测（并发的 /ready 只会打 core 一次）。 */
  async function upstreamReady() {
    if (readyCache.up !== null && Date.now() - readyCache.at < READY_CACHE_MS) return readyCache.up;
    if (!readyInflight) {
      readyInflight = probeUpstreamOnce()
        .then((up) => { readyCache = { at: Date.now(), up }; readyInflight = null; return up; })
        .catch(() => { readyInflight = null; return false; });
    }
    return readyInflight;
  }

  // ── 主 HTTP 服务 ───────────────────────────────────────
  /**
   * 安全解析请求 URL。
   *
   * 不能用 `new URL(req.url, \`http://${req.headers.host}\`)`：
   * 攻击者控制 Host 头（如 `Host: [`）或请求行时 `new URL` 会抛
   * `TypeError: ERR_INVALID_URL`，而这里在 async 处理器体内、位于各 try/catch
   * 之外，rejected promise 会让 Node 直接终止进程 —— 一个匿名请求即可打挂
   * 整个网关（含全部 /v1 代理流量）。故：base 用固定字面量，解析失败返回 null。
   */
  function parseUrl(req) {
    const raw = typeof req.url === 'string' && req.url.length > 0 ? req.url : '/';
    try {
      return new URL(raw, 'http://localhost');
    } catch {
      return null;
    }
  }

  const server = http.createServer(async (req, res) => {
    // 顶层兜底：任何未预期的异常都不允许逃逸出处理器（否则会打挂进程）
    try {
      await handleRequest(req, res);
    } catch (e) {
      log.error(`请求处理未捕获异常 ${req.method} ${req.url}: ${e && e.stack ? e.stack : e}`);
      if (!res.headersSent) {
        try { sendJSON(res, 500, { error: { message: '内部错误', type: 'internal_error' } }); } catch { /* 已断开 */ }
      } else {
        try { res.destroy(); } catch { /* 已断开 */ }
      }
    }
  });

  async function handleRequest(req, res) {
    applySecurityHeaders(req, res);
    const url = parseUrl(req);
    if (!url) {
      return sendJSON(res, 400, { error: { message: '非法请求 URL', type: 'bad_request' } });
    }
    const routeKey = `${req.method} ${url.pathname}`;
    const isProxyRoute = PROXY_ROUTES.has(routeKey);

    res.on('error', () => { /* 客户端断开导致的写错误，忽略 */ });

    // 鉴权接口（登录 / 登出 / 初始化 / 当前状态）
    if (url.pathname.startsWith('/api/auth/')) {
      try {
        return await handleAuth(req, res, url);
      } catch (e) {
        if (e instanceof HttpError) return sendJSON(res, e.status, { error: { message: e.message, type: 'auth_error' } });
        // B17-#7：scrypt 队列已满 → 503（服务器繁忙、稍后重试），不是 401、更不是 500。
        if (e instanceof ScryptQueueFullError || e?.code === 'SCRYPT_QUEUE_FULL') {
          log.warn(`鉴权接口被拒（scrypt 队列已满）：${e.message}`);
          res.setHeader('retry-after', '1');
          return sendJSON(res, 503, { error: { message: '服务器繁忙（密码校验队列已满），请稍后重试', type: 'overloaded' } });
        }
        // M2b：store 的只读挂载写入失败 → 明确 403（文案含「只读」），绝不 500
        if (e?.code === 'READONLY_FS') {
          return sendJSON(res, 403, { error: { message: '凭据以只读方式挂载，无法修改；请改用可写的 config/ 目录', type: 'auth_error' } });
        }
        log.error(`鉴权接口异常: ${e.message}`);
        return sendJSON(res, 500, { error: { message: '鉴权接口内部错误', type: 'auth_error' } });
      }
    }

    // 面板（根 public/ 是构建产物；未构建时 readPanel 返回 null → 503 可操作提示，不是裸 500）
    if (req.method === 'GET' && url.pathname === '/') {
      const html = readPanel();
      if (html === null) return sendPanelMissing(res);
      res.setHeader('cache-control', 'no-store');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'x-content-type-options': 'nosniff' });
      return res.end(html);
    }

    // 后台管理页（静态 HTML；数据接口在 /api/admin/*）
    if (req.method === 'GET' && (url.pathname === '/admin' || url.pathname === '/admin/')) {
      const html = readAdmin();
      if (html === null) return sendPanelMissing(res);
      res.setHeader('cache-control', 'no-store');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'x-content-type-options': 'nosniff' });
      return res.end(html);
    }

    // 图标：两页 HTML 已用内联 data-URI <link rel="icon">，这里再兜底 /favicon.ico，
    // 避免浏览器在 <link> 未被识别时直接请求该路径而吃一个 404。
    if (req.method === 'GET' && url.pathname === '/favicon.ico') {
      res.writeHead(204, { 'cache-control': 'public, max-age=86400' });
      return res.end();
    }

    // 面板静态资源：public 下的 css/js/vendor（同源，无构建）；CSP 头已由 applySecurityHeaders 统一加上。
    // B21：/vendor/ 放第三方前端库（ECharts），前端懒加载；只有命中真实文件才发长缓存（见 serveStatic）。
    if (req.method === 'GET' && (url.pathname.startsWith('/css/') || url.pathname.startsWith('/js/')
      || url.pathname.startsWith('/vendor/'))) {
      return serveStatic(res, url.pathname);
    }

    // liveness（无需 key）：只说明「网关进程活着」。
    // 语义与响应体**刻意保持不变**（既有部署脚本与契约依赖它）——它不代表能干活，
    // 只看这个会漏掉「core 挂了、进程还活着」这类故障。要看能不能干活请用 /ready。
    if (req.method === 'GET' && url.pathname === '/health') {
      return sendJSON(res, 200, { ok: true, accounts: accounts.length, available: scheduler.availableCount() });
    }

    // readiness（无需 key）：真探一次上游 core。可达 → 200；不可达/超时 → 503。
    // compose 的 healthcheck 探的就是这里，所以「绿灯」等于「core 可达、/v1 能跑」。
    if (req.method === 'GET' && url.pathname === '/ready') {
      const up = await upstreamReady();
      return sendJSON(res, up ? 200 : 503, {
        ok: up,
        upstream: up ? 'up' : 'down',
        accounts: accounts.length,
        available: scheduler.availableCount(),
      });
    }

    if (isProxyRoute) {
      const key = extractKey(req);
      if (!key) return authError(res);

      const isLocal = localKeyIndexOf(key) >= 0;
      const isPassthrough = !isLocal && config.allowPassthrough && key.startsWith(CC_KEY_PREFIX);

      if (!isLocal && !isPassthrough) {
        log.warn(`鉴权失败（不认识的 key: ${sanitizeForLog(keyPrefixOf(key))}***）来自 ${sanitizeForLog(req.socket.remoteAddress ?? '-')}`);
        return authError(res);
      }

      // 透传模式：直接原样转发，不做池调度
      if (isPassthrough) {
        log.info(`透传模式请求 ${url.pathname}（不做池调度）`);
        return proxy.forward({ req, res, account: { name: 'passthrough', key, keyId: keyIdOf(key), keyPrefix: keyPrefixOf(key), enabled: true, __passthrough: true }, pathname: url.pathname, search: url.search });
      }

      // 池调度：先 peek body 头部拿 session id
      const headerSession = req.headers[SESSION_HEADER];
      let initialChunks = [];
      let bodyEnded = false;
      let sessionId = typeof headerSession === 'string' && headerSession ? headerSession : null;

      if (!sessionId && req.method !== 'GET' && req.method !== 'HEAD') {
        const peeked = await peekBody(req, BODY_PEEK_BYTES, {
          match: (cs) => peekSessionFromBody(cs) !== null,
          startMs: config.bodyPeekStartMs,
        }).catch(() => ({ chunks: [], ended: false }));
        // L5：起始超时（连 body 都不发）→ 明确 408 并关连接，不再无限占住 socket。
        if (peeked.timedOut) {
          res.setHeader('connection', 'close');
          note('warn', `请求体起始超时（${config.bodyPeekStartMs}ms 未收到 body），已断开`);
          return sendJSON(res, 408, { error: { message: 'Request body timeout', type: 'request_timeout' } });
        }
        initialChunks = peeked.chunks;
        bodyEnded = peeked.ended;
        sessionId = peekSessionFromBody(initialChunks);
      }

      let { account, reason } = scheduler.select({ sessionId });
      if (!account) {
        // 审查 A4：全池不可用时不能干等下一拍空闲轮询（最长 600s 的全池 503）。
        // 若池里有窗口已过期 / 快照过旧的账号，立刻触发一轮额度刷新（refreshAll 自带
        // refreshInFlight 去重 + 冷却，绝不会每个请求都刷），刷完在本请求内重选。
        if (poolNeedsRefresh(Date.now()) && canAutoRefreshPool()) {
          log.warn(`无可用账号（${reason}），快照可能过期 → 触发一轮额度刷新`);
          await refreshAll().catch((e) => log.warn(`自动刷新额度失败: ${e.message}`));
          ({ account, reason } = scheduler.select({ sessionId }));
        }
      }
      if (!account) {
        log.warn(`无可用账号，拒绝 ${url.pathname}（${reason}）`);
        const retryAfterMs = retryAfterMsForPool(Date.now());
        res.setHeader('retry-after', String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
        return sendJSON(res, 503, {
          error: { message: 'No available account in pool', type: 'no_available_account' },
          retryAfterMs,
        });
      }
      log.info(`路由 ${url.pathname} → 账号「${account.name}」${sessionId ? `(session ${sanitizeForLog(sessionId)})` : ''}`);

      return proxy.forward({ req, res, account, pathname: url.pathname, search: url.search, initialChunks, bodyEnded, sessionId });
    }

    // 只读面板数据：默认公开（PUBLIC_DASHBOARD=1）；PUBLIC_DASHBOARD=0 时要求后台登录
    if (req.method === 'GET' && url.pathname === '/api/status') {
      if (!requirePanelRead(req, res)) return;
      return sendJSON(res, 200, statusView());
    }
    // B13：历史趋势（只读，与 /api/status 同档）。刻意不塞进 /api/status：
    // 那是 5 秒轮询的接口，不能把整个样本数组每次都带上。响应只含聚合数字，
    // 绝不含账号名 / keyId / displayName / lastError 等身份字段。
    if (req.method === 'GET' && url.pathname === '/api/history') {
      if (!requirePanelRead(req, res)) return;
      return sendJSON(res, 200, { ok: true, bucketMs: HISTORY_BUCKET_MS, tickMs: HISTORY_TICK_MS, samples: history.samples() });
    }
    if (req.method === 'GET' && url.pathname === '/api/accounts') {
      if (!requirePanelRead(req, res)) return;
      return sendJSON(res, 200, {
        ok: true,
        accounts: accounts.map((a) => ({ name: a.name, keyId: a.keyId, enabled: a.enabled })),
      });
    }
    if (req.method === 'POST' && url.pathname === '/api/accounts/refresh') {
      if (!requirePanelRead(req, res)) return;
      // 公开面板上的「刷新额度」按钮会走到这里：匿名调用做节流，避免被拿来当打 CC 的放大器
      if (!currentUser(req) && !legacyKeyAllowed(req)) {
        const now = Date.now();
        const src = clientIp(req);
        const lastForSrc = lastPublicRefreshBySource.get(src) ?? 0;
        const throttled = now - lastForSrc < PUBLIC_REFRESH_MIN_MS
          || now - lastPublicRefreshAt < PUBLIC_REFRESH_GLOBAL_MIN_MS;
        if (throttled) {
          return sendJSON(res, 200, { ok: true, throttled: true, ...statusView() });
        }
        lastPublicRefreshBySource.set(src, now);
        // 简单的表上限，防止伪造来源把 Map 撑爆
        if (lastPublicRefreshBySource.size > PUBLIC_REFRESH_MAX_SOURCES) {
          const oldest = lastPublicRefreshBySource.keys().next().value;
          lastPublicRefreshBySource.delete(oldest);
        }
        lastPublicRefreshAt = now;
      }
      await refreshAll();
      return sendJSON(res, 200, { ok: true, ...statusView() });
    }

    // 后台接口：/api/admin/*（session cookie 鉴权 + 写接口另校验可写）
    if (url.pathname.startsWith('/api/admin/')) {
      if (!requireSession(req, res)) return;
      try {
        await handleAdmin(req, res, url);
      } catch (e) {
        if (e instanceof HttpError) return sendJSON(res, e.status, { error: { message: e.message, type: 'admin_error' } });
        // B17-#7：改密码 / 建管理员同样要算 scrypt；队列满时明确 503，不裸抛 500。
        if (e instanceof ScryptQueueFullError || e?.code === 'SCRYPT_QUEUE_FULL') {
          log.warn(`后台接口被拒（scrypt 队列已满）：${e.message}`);
          res.setHeader('retry-after', '1');
          return sendJSON(res, 503, { error: { message: '服务器繁忙（密码校验队列已满），请稍后重试', type: 'overloaded' } });
        }
        // M2b：只读挂载下的写操作 → 403 且文案含「只读」，不裸抛 500
        if (e?.code === 'READONLY_FS') {
          return sendJSON(res, 403, { error: { message: '凭据以只读方式挂载，无法修改；请改用可写的 config/ 目录', type: 'admin_error' } });
        }
        log.error(`后台接口异常: ${e.message}`);
        return sendJSON(res, 500, { error: { message: '后台接口内部错误', type: 'admin_error' } });
      }
      return;
    }

    sendJSON(res, 404, { error: { message: 'Not found', type: 'not_found' } });
  }

  // 面板构建产物缺失（ENOENT）→ 返回 null，交给路由回 503 + 可操作提示；
  // 其它读错误（EACCES 等）原样抛 → 走原有兜底（真故障仍是 500）。只区分 ENOENT 这一种。
  // warn 去重：面板未构建期间不逐请求刷屏；一旦读到文件即复位，重新构建后可再提示一次。
  let panelMissingWarned = false;
  function readPanelFile(name) {
    const full = path.join(publicDir, name);
    try {
      const html = fs.readFileSync(full, 'utf8');
      panelMissingWarned = false;
      return html;
    } catch (e) {
      if (e?.code !== 'ENOENT') throw e;
      if (!panelMissingWarned) {
        panelMissingWarned = true;
        log.warn(`面板未构建：${full} 不存在（ENOENT）→ 请运行 \`bash scripts/panel-build.sh\``
          + '（或 `npm run panel:build`）生成面板产物后再刷新');
      }
      return null;
    }
  }

  function readPanel() {
    return readPanelFile('index.html');
  }

  function readAdmin() {
    return readPanelFile('admin.html');
  }

  // 面板未构建时的 503 页面：给人看的、能照着做的一句话（含确切命令）。
  const PANEL_MISSING_HTML = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1">'
    + '<title>面板未构建</title></head><body>'
    + '<h1>503 · 面板未构建</h1>'
    + '<p>面板未构建：请运行 <code>bash scripts/panel-build.sh</code>'
    + '（或 <code>npm run panel:build</code>）后刷新本页。</p>'
    + '<p>仓库根 <code>public/</code> 是 Astro 构建产物，不在 git 里；干净 checkout 需要先构建。</p>'
    + '</body></html>';

  function sendPanelMissing(res) {
    res.writeHead(503, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    return res.end(PANEL_MISSING_HTML);
  }

  // 静态资源 MIME：只放行面板用到的两种扩展名
  const STATIC_MIME = {
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
  };

  /**
   * 只读地吐 public/ 下的静态文件（面板的 css/js）。
   * 严格限制在 ROOT/public 内：拒绝 `..`、反斜杠、空字节与未知扩展名，
   * 解析后的绝对路径也必须仍在 public 内（防路径穿越）。宁 404 不吐越界文件。
   */
  function serveStatic(res, pathname) {
    const notFound = () => sendJSON(res, 404, { error: { message: 'Not found', type: 'not_found' } });
    const rel = String(pathname).replace(/^\/+/, '');
    if (!rel || rel.includes('..') || rel.includes('\\') || rel.includes('\0')) return notFound();
    const mime = STATIC_MIME[path.extname(rel).toLowerCase()];
    if (!mime) return notFound();
    const full = path.resolve(publicDir, rel);
    if (full !== publicDir && !full.startsWith(publicDir + path.sep)) return notFound();
    let stat;
    try { stat = fs.statSync(full); } catch { return notFound(); }
    if (!stat.isFile()) return notFound();
    // B21：public/vendor/ 下是第三方库（文件名内嵌版本号，如 echarts.min.js），
    // 命中真实文件才发长缓存 immutable；public/css、public/js 仍是 no-cache 原行为。
    // 升级库必须改文件名（或加版本参数），否则客户端会一直吃旧缓存。
    const immutable = rel.startsWith('vendor/');
    res.writeHead(200, {
      'content-type': mime,
      'x-content-type-options': 'nosniff',
      'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    return res.end(fs.readFileSync(full));
  }

  // 后端-M5：Node 默认 keepAliveTimeout=5s，反代 upstream keepalive 大于它会复用到
  // 后端已关的连接（POST 命中 EPIPE → 502）。抬到 65s，与上游内核同款；反代侧
  // keepalive_timeout 必须小于该值（见 README 部署节）。
  const keepAliveTimeoutMs = Number(config.keepAliveTimeoutMs) > 0 ? Number(config.keepAliveTimeoutMs) : 65000;
  server.keepAliveTimeout = keepAliveTimeoutMs;
  server.headersTimeout = Number(config.headersTimeoutMs) > keepAliveTimeoutMs
    ? Number(config.headersTimeoutMs)
    : keepAliveTimeoutMs + 1000;   // Node 要求 headersTimeout > keepAliveTimeout
  // B17-#2：显式设置 requestTimeout（不依赖 Node 的 300s 默认）。它是「收完整请求」的总时限，
  // 是我们的 bodyReadTimeoutMs 之外的第二道兜底（Node 那层不带统计/日志）。取值保证不小于
  // headersTimeout，且默认略大于 bodyReadTimeoutMs，让网关自己的 408 先生效。
  server.requestTimeout = Math.max(
    Number(config.requestTimeoutMs) > 0 ? Number(config.requestTimeoutMs) : 180000,
    server.headersTimeout + 1000,
  );
  // B17-#2：同时打开的连接数上限（Node 默认 Infinity）。慢连接 / 半开连接不能无限占 socket 表。
  const maxConnections = Number(config.maxConnections) > 0 ? Math.floor(Number(config.maxConnections)) : 512;
  server.maxConnections = Math.max(1, maxConnections);

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.gatewayPort, config.gatewayHost, resolve);
  });

  // 启动即刷一次额度，让面板/调度一开始就有快照（不阻塞启动，失败只记日志）
  if (!overrides.noInitialRefresh && accounts.length > 0) {
    refreshAll()
      .then((rs) => {
        const ok = rs.filter((r) => r.snapshot?.ok).length;
        note('info', `首次额度刷新完成：${ok}/${rs.length} 个账号成功`);
      })
      .catch((e) => log.warn(`首次额度刷新失败: ${e.message}`));
  }

  /**
   * 优雅关闭（F3）：
   *   1. 停止收新连接（server.close），等在途请求自然跑完 —— 流式 LLM 响应不该被拦腰掐断；
   *   2. 最多等 GRACEFUL_SHUTDOWN_MS（5s，远小于 docker stop 的 10s 宽限期），
   *      超时才 closeAllConnections() 强制收尾。
   * 历史 bug：第一步就 closeAllConnections()，docker stop 的宽限期形同虚设。
   */
  async function stop({ graceMs = GRACEFUL_SHUTDOWN_MS } = {}) {
    poller.stop();
    if (recheckTimer) clearInterval(recheckTimer);
    if (historyTimer) clearInterval(historyTimer);
    store.saveState();
    const closed = new Promise((r) => server.close(() => r()));
    const allClosed = new Promise((r) => server.once('close', () => r()));
    await Promise.race([allClosed, new Promise((r) => setTimeout(r, graceMs).unref?.())]);
    try { server.closeAllConnections?.(); } catch { /* 忽略 */ }
    await Promise.race([closed, new Promise((r) => setTimeout(r, 1000))]);
  }

  return {
    server, config, log, accounts, localKeys, store, scheduler, stats, history, refreshAll, statusView, stop, proxy,
    events, note, reloadNow, syncPool, handleAdmin, handleAuth, sessions, loginLimiter, currentUser,
    poller, touchActivity, runPausedRecheck,
    probeState,
    sessionTokenOf,
    get users() { return users; }, get testHistory() { return testHistory; }, usersView, isSetupRequired,
  };
}

/**
 * 预读请求体头部若干字节，并把已读片段原样返回（后续转发时先写出去）。
 *
 * F11：这里只为「取 session id」而 peek，绝不能等整个 body 收完才转发 ——
 * 历史实现读满 64KB 或等 body 结束才 resolve，慢速/大 body 客户端下上游连接与
 * 首字节被推迟到 body 发完之后（实测 800ms 一片时上游到 t≈2.4s 才收到数据）。
 *
 * 现在的结束条件（满足其一即放行）：
 *   1. 已读片段里找到 session id（最常见：JSON 头里就有 conversation_id）
 *   2. 读满 limit（8KB，够放 session id，也不至于驻留太多内存）
 *   3. body 结束
 *   4. 收到首块后 idleMs 内没有新的 session id 线索（兜底，不无限等）
 * 放行时总是先 pause()，由 pipingBody 接手并 resume()，保证不丢字节。
 */
export function peekBody(req, limit, { idleMs = BODY_PEEK_IDLE_MS, startMs = BODY_PEEK_START_MS, match = null } = {}) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let done = false;
    let idleTimer = null;
    let startTimer = null;
    let timedOut = false;
    const onEnd = () => finish(true);
    const onError = () => finish(false);
    const onAborted = () => finish(false);
    const onClose = () => finish(false);
    const cleanup = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = null;
      if (startTimer) clearTimeout(startTimer);
      startTimer = null;
      // 审查#1：放行时必须摘掉**全部**请求监听器（尤其 data）。
      // 早先只清 timer，data 监听器继续 chunks.push —— peek 已经放行了，chunks 却还在
      // 随整个请求体增长，与 pipingBody() 的重试缓冲各驻留一份完整 body（大上传直接翻倍内存）。
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('aborted', onAborted);
      req.off('close', onClose);
    };
    const finish = (ended) => {
      if (done) return;
      done = true;
      cleanup();
      req.pause();
      resolve({ chunks, ended, timedOut });
    };
    // L5：起始超时从 peek 开始就挂上，绝不等到收到首块数据。
    const armStart = () => {
      if (startTimer || done) return;
      startTimer = setTimeout(() => { timedOut = true; finish(false); }, startMs);
      startTimer.unref?.();
    };
    const armIdle = () => {
      if (idleTimer || done) return;
      idleTimer = setTimeout(() => finish(false), idleMs);
      idleTimer.unref?.();
    };
    const onData = (chunk) => {
      if (done) return;
      // 硬上限（审查#1）：缓冲到 limit 就停止收集并立刻放行，后面的字节交给 pipingBody。
      // 已收下的 chunk 整块保留（不做 subarray 截断），保证 peek 出去的字节能被原样重放给上游；
      // 代价是最多多读**一个** chunk，绝不会随请求体继续膨胀。
      if (size >= limit) return finish(false);
      chunks.push(chunk);
      size += chunk.length;
      if (match && match(chunks)) return finish(false);
      if (size >= limit) return finish(false);
      if (req.readableEnded) return finish(true);
      armIdle();
    };
    req.on('data', onData);
    req.once('end', onEnd);
    req.once('error', onError);
    req.once('aborted', onAborted);
    req.once('close', onClose);
    if (Number(startMs) > 0) armStart();
  });
}

// ── 直接运行 ────────────────────────────────────────────
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.join(ROOT, 'gateway.mjs');
if (isMain) {
  const { config, log, server, stop } = await startGateway();
  const addr = server.address();
  log.info(`cc-manage 网关已启动: http://${addr.address}:${addr.port}`);
  log.info(`上游内核: ${config.upstreamProxyUrl} | CC API: ${config.ccApiBase}`);
  // 防重入守卫：错误期间（或信号之后）连环触发时只走一次关闭/退出，
  // 否则会出现重复关闭、重复日志，甚至在 process.exit 之前又抛一次。
  let exiting = false;
  const shutdown = async (sig) => {
    if (exiting) return;
    exiting = true;
    log.info(`收到 ${sig}，正在退出…`);
    await stop().catch(() => {});
    process.exit(0);
  };
  /**
   * B11：进程级致命兜底（未捕获异常 / 未处理的 promise rejection）。
   *
   * Node 15+ 默认把未处理的 rejection 变成致命错误直接杀进程 —— 轮询/探针里漏一个 await，
   * 网关就静默死掉：restart: unless-stopped 虽然会拉起，但**在途请求全丢、日志里看不到原因**。
   * 本网关同时给自己的 LLM 流量供路，静默僵死比崩溃更糟：宁可快速重启，也不要在未知
   * （可能半初始化）状态下继续服务。
   *
   * 所以：记录可诊断信息（事件类型 / message / stack）→ 走**已有的**优雅关闭路径
   * （等 5s 让在途流式响应自然收尾，不拦腰掐断）→ 以非零码退出，让容器拉起一个干净进程。
   * 整个处理体包 try/catch：处理器自身再抛异常绝不能变成第二次未捕获。
   */
  const fatal = async (kind, reason) => {
    if (exiting) return;
    exiting = true;
    try {
      const message = reason instanceof Error ? (reason.message ?? String(reason)) : String(reason);
      const detail = reason instanceof Error ? (reason.stack ?? reason.message ?? String(reason)) : String(reason);
      log.error(`[${kind}] ${message}`);
      log.error(`[${kind}] 进程即将退出（优雅关闭后以非零码退出，交容器 restart: unless-stopped 拉起干净进程）\n${detail}`);
    } catch { /* 日志/取值失败也不能让处理器再抛 */ }
    try {
      await stop().catch(() => {});
    } catch { /* 关闭失败也照样退出，绝不能僵在这里 */ }
    process.exit(1);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => { void fatal('unhandledRejection', reason); });
  process.on('uncaughtException', (err) => { void fatal('uncaughtException', err); });
}
