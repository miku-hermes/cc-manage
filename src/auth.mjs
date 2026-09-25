// 鉴权原语（零外部依赖）：scrypt 密码哈希、HMAC-SHA256 签名 cookie session、登录失败限速
//
// 两套凭据职责分清：
//   - 后台管理员：账号 + 密码（scrypt 加盐哈希存 config/users.json）→ session cookie
//   - 客户端 API key：sk-cg-*（config/keys.json）→ 只用于 /v1/* 反代调用
import fs from 'node:fs';
import path from 'node:path';
import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
// 复用 store 的原子写（tmp + fsync + rename + fsync 目录）：吊销记录绝不能被半截写坏
import { atomicWrite } from './store.mjs';

export const SESSION_COOKIE = 'cc_session';
// session 有效期 7 天（别每次重启都换密钥，否则用户被登出）
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// scrypt 参数：N=2^16、r=8 → 64MB 内存 / ~200ms，向 OWASP 现行建议（N≥2^15~2^17）靠拢。
// 1.9GB 小机器上登录不是高频操作，这点开销可以接受。
const SCRYPT_N = 1 << 16;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;
const SCRYPT_SALT_BYTES = 16;
/**
 * 校验时只接受**白名单固定档位**的 N/r/p。
 *
 * 历史 bug：上限写的是 N ≤ 2^20、r ≤ 32 并从被校验的字符串本身取参数，
 * 于是被投毒的 users.json（N=2^20, r=32）会请求 4 GiB 内存并长时间阻塞事件循环
 * → 容器 mem_limit 256m 下直接 OOM/重启。
 */
const SCRYPT_N_ALLOWED = new Set([1 << 14, 1 << 15, 1 << 16]);
const SCRYPT_R_ALLOWED = new Set([8]);
const SCRYPT_P_ALLOWED = new Set([1]);
// 白名单里最大的内存占用（用于防御性上限断言）
const SCRYPT_MAX_MEM = 256 * (1 << 16) * 8;

function b64(buf) {
  return Buffer.from(buf).toString('base64');
}

/**
 * scrypt 一律走 **异步 + 串行队列**：
 *  - 早先的 scryptSync 每次登录把事件循环卡死 200ms+，轮换用户名刷登录就能让整个网关
 *    （含所有反代流量）一起卡顿 —— 这是审查#3 的核心问题，必须改成不阻塞；
 *  - 只丢给异步 scrypt 还不够：N 个并发登录就是 N 个 64MB 的派生任务，256m 容体会被打爆。
 * 队列保证同一时刻只算一个 scrypt（CPU / 内存都有硬上限），事件循环全程可调度。
 *
 * B17-#7：队列**必须有深度上限**。限速只保证「进入 scrypt 的次数有界」，但单次
 * scrypt(N=2^16) 实测 ≈656ms（单线程吞吐 ≈91 次/分钟），60/分钟的每来源上限意味着
 * 2~3 个来源就能堆出上百个排队任务：内存（每个排队请求 + 事件循环延迟）线性上涨，
 * 而合法管理员登录会被 FIFO 排在积压后面。超限**不排队**，直接抛 SCRYPT_QUEUE_FULL
 * （调用方转 503「服务器繁忙，稍后重试」）。
 */
const SCRYPT_QUEUE_DEFAULT_MAX = 8;
/** 队列深度上限（含正在执行的一次）。可用 SCRYPT_MAX_QUEUE env / config 覆盖。 */
let scryptQueueMax = (() => {
  const raw = Number(process.env.SCRYPT_MAX_QUEUE);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : SCRYPT_QUEUE_DEFAULT_MAX;
})();
/** 覆盖队列深度上限（gateway 启动时用 config.scryptMaxQueue 注入；非法值忽略）。 */
export function setScryptQueueMax(n) {
  const v = Number(n);
  if (Number.isFinite(v) && v > 0) scryptQueueMax = Math.floor(v);
}
/** 诊断用：当前排队情况（测试断言队列有界）。 */
export function scryptQueueStats() {
  return { pending: scryptPending, max: scryptQueueMax };
}

/** 队列已满：不排队，直接让调用方回 503（服务器繁忙）。 */
export class ScryptQueueFullError extends Error {
  constructor() {
    super('密码校验队列已满（服务器繁忙），请稍后重试');
    this.name = 'ScryptQueueFullError';
    this.code = 'SCRYPT_QUEUE_FULL';
    this.status = 503;
  }
}

let scryptQueue = Promise.resolve();
let scryptPending = 0;   // 在跑 + 排队中的任务数
function scryptAsync(password, salt, keylen, opts) {
  if (scryptPending >= scryptQueueMax) return Promise.reject(new ScryptQueueFullError());
  scryptPending += 1;
  const task = () => new Promise((resolve, reject) => {
    scrypt(String(password), salt, keylen, opts, (err, derived) => (err ? reject(err) : resolve(derived)));
  });
  const run = scryptQueue.then(task, task);   // 前一个无论成败，这一个照跑
  scryptQueue = run.then(() => undefined, () => undefined);
  return run.finally(() => { scryptPending -= 1; });
}

/**
 * 生成密码哈希：`scrypt$N$r$p$<salt-b64>$<hash-b64>`。绝不存明文。
 * **异步**（返回 Promise，调用方必须 await）：绝不在事件循环里同步算哈希。
 * @param {string} password
 * @param {{ N?: number, r?: number, p?: number, keylen?: number, salt?: Buffer }} [opts]
 * @returns {Promise<string>}
 */
export async function hashPassword(password, opts = {}) {
  const N = opts.N ?? SCRYPT_N;
  const r = opts.r ?? SCRYPT_R;
  const p = opts.p ?? SCRYPT_P;
  const keylen = opts.keylen ?? SCRYPT_KEYLEN;
  const salt = opts.salt ?? randomBytes(SCRYPT_SALT_BYTES);
  const hash = await scryptAsync(password, salt, keylen, { N, r, p, maxmem: SCRYPT_MAX_MEM });
  return `scrypt$${N}$${r}$${p}$${b64(salt)}$${b64(hash)}`;
}

/**
 * 校验密码（异步）。参数非法 / 哈希损坏一律返回 false，不抛错。
 * 白名单校验是纯字符串比较（廉价）：恶意 N/r/p 连 scrypt 队列都进不去。
 * @returns {Promise<boolean>}
 */
export async function verifyPassword(password, stored) {
  if (typeof password !== 'string' || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  // 白名单：不在固定档位里的参数一律拒绝，绝不按攻击者给的 N/r/p 去分配内存
  if (!SCRYPT_N_ALLOWED.has(N) || !SCRYPT_R_ALLOWED.has(r) || !SCRYPT_P_ALLOWED.has(p)) return false;
  // 防御性二次确认：实际需要的内存必须落在白名单允许的上限内
  if (256 * N * r > SCRYPT_MAX_MEM) return false;
  const salt = Buffer.from(parts[4], 'base64');
  const expected = Buffer.from(parts[5], 'base64');
  if (salt.length === 0 || expected.length === 0) return false;
  let actual;
  try {
    actual = await scryptAsync(password, salt, expected.length, { N, r, p, maxmem: SCRYPT_MAX_MEM });
  } catch (e) {
    // B17-#7：队列满不是「密码错」——必须让调用方看到 503，否则会被记成一次失败登录。
    if (e?.code === 'SCRYPT_QUEUE_FULL') throw e;
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** 定长时间字符串比较（先 sha256 成等长摘要，长度不同也不会抛错）。 */
export function safeEqualText(a, b) {
  const ha = createHash('sha256').update(String(a ?? ''), 'utf8').digest();
  const hb = createHash('sha256').update(String(b ?? ''), 'utf8').digest();
  return timingSafeEqual(ha, hb);
}

/**
 * 读取（不存在则生成）cookie 签名密钥。文件权限 0600。
 * 落盘失败时降级为临时密钥（重启后需要重新登录），只 warn 不阻塞启动。
 */
export function loadOrCreateSecret(file, { log = null, bytes = 32 } = {}) {
  try {
    if (fs.existsSync(file)) {
      const raw = fs.readFileSync(file, 'utf8').trim();
      if (raw.length >= 32) return raw;
      log?.warn?.(`session 密钥文件过短或损坏，已重新生成（已有登录会失效）：${file}`);
    }
    const secret = randomBytes(bytes).toString('hex');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, `${secret}\n`, { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
    fs.chmodSync(file, 0o600);
    return secret;
  } catch (e) {
    log?.warn?.(`session 密钥无法持久化（${file}：${e.message}），本次运行使用临时密钥，重启后需重新登录`);
    return randomBytes(bytes).toString('hex');
  }
}

/** 解析 Cookie 头。坏值忽略，绝不抛错。 */
export function parseCookies(header) {
  const out = {};
  if (typeof header !== 'string' || !header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    const raw = part.slice(i + 1).trim();
    try {
      out[k] = decodeURIComponent(raw);
    } catch {
      out[k] = raw;
    }
  }
  return out;
}

/**
 * 签名 session（HMAC-SHA256）。token = base64url(payload) + '.' + base64url(hmac)。
 * payload: { u: 用户名, sid: 会话随机 id, iat, exp, sv }
 *
 * 吊销有两条路：
 *  1. sid 黑名单 —— 退出登录只吊销**这一个**会话；
 *  2. 按用户的会话版本号 `sv` —— 改密码 / 删管理员时 +1，该用户所有旧 token 立刻失效。
 *
 * 两者都会**持久化**到磁盘（storePath）：内存吊销表在重启后就没了，
 * 而 cookie 是自包含的 7 天 TTL，于是「已登出 / 已改密码」的 token 重启后会复活。
 * 落盘失败只 warn 并退回纯内存语义，绝不阻塞启动。
 */
export function createSessionSigner({ secret, ttlMs = SESSION_TTL_MS, now = () => Date.now(), storePath = null, log = null } = {}) {
  if (!secret) throw new Error('session 签名密钥缺失');
  const key = Buffer.from(String(secret), 'utf8');
  const mac = (data) => createHmac('sha256', key).update(data).digest();
  const revoked = new Map();              // sid → 该会话的 exp（过期即可遗忘）
  const byUser = new Map();               // username → Map<sid, exp>，改密码时整批吊销
  const versions = new Map();             // username → 会话版本号 sv

  /**
   * 吊销记录不可读时的 **fail-closed 语义**（审查#12）：
   *
   * 我们已经不知道哪些 sid 被吊销过、哪些用户改过密码。若照旧「损坏就忽略」，
   * 已登出 / 已改密的 cookie 会在重启后复活（签名是自包含的 7 天 TTL）。
   * 选定的语义：
   *   - **拒绝损坏被发现之前签发的一切 token**（连同重启也拒绝 —— corruptBefore 落盘）；
   *   - 放行损坏之后新签发的会话 —— 后台不会被锁死，也不需要人工删文件；
   *   - 宁可让几个有效会话重新登录，也绝不让已吊销会话复活。
   */
  let rejectIssuedBefore = 0;
  function poisonStore(reason) {
    const t = now();
    rejectIssuedBefore = Math.max(rejectIssuedBefore, t);
    log?.error?.(`会话吊销记录不可读（${reason}）：已 fail-closed，拒绝 ${new Date(t).toISOString()} 之前签发的所有会话`);
    persist();   // 把 corruptBefore 落盘，重启后继续保持「旧 token 一律拒绝」
  }

  function load() {
    if (!storePath) return;
    if (!fs.existsSync(storePath)) return;
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(storePath, 'utf8'));
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('顶层不是对象');
    } catch (e) {
      poisonStore(e.message);
      return;
    }
    const t = now();
    if (Number.isFinite(raw.corruptBefore) && raw.corruptBefore > 0) {
      rejectIssuedBefore = Math.max(rejectIssuedBefore, raw.corruptBefore);
    }
    // sids / versions 的值形状非法同样按「不可读」处理：挑着信就可能漏掉一条吊销 → 复活
    try {
      const sids = raw.sids ?? {};
      const vers = raw.versions ?? {};
      if (!sids || typeof sids !== 'object' || Array.isArray(sids)) throw new Error('sids 结构非法');
      if (!vers || typeof vers !== 'object' || Array.isArray(vers)) throw new Error('versions 结构非法');
      for (const [sid, exp] of Object.entries(sids)) {
        if (!Number.isFinite(exp)) throw new Error(`sids[${sid}] 不是有效时间戳`);
        if (exp > t) revoked.set(sid, exp);
      }
      for (const [u, v] of Object.entries(vers)) {
        if (!Number.isInteger(v) || v < 0) throw new Error(`versions[${u}] 不是整数`);
        if (v > 0) versions.set(u, v);
      }
    } catch (e) {
      poisonStore(e.message);
    }
  }

  /** 原子写（复用 store.atomicWrite：tmp + fsync + rename + fsync 目录），掉电不会留半截文件。 */
  function persist() {
    if (!storePath) return;
    try {
      const sids = {};
      for (const [sid, exp] of revoked) sids[sid] = exp;
      const rawVersions = {};
      for (const [u, v] of versions) rawVersions[u] = v;
      const payload = { sids, versions: rawVersions };
      if (rejectIssuedBefore > 0) payload.corruptBefore = rejectIssuedBefore;
      atomicWrite(storePath, `${JSON.stringify(payload, null, 2)}
`, { log, mode: 0o600 });
    } catch (e) {
      log?.warn?.(`会话吊销记录无法持久化（${e.message}），本次运行的吊销在重启后会失效`);
    }
  }

  function prune() {
    const t = now();
    for (const [sid, exp] of revoked) if (exp <= t) revoked.delete(sid);
    for (const [u, set] of byUser) {
      for (const [sid, exp] of set) if (exp <= t) set.delete(sid);
      if (set.size === 0) byUser.delete(u);
    }
  }

  /** 该用户当前还有效的会话数（测试与诊断用）。 */
  function liveSessionCount(username) {
    const set = byUser.get(String(username));
    if (!set) return 0;
    const t = now();
    let n = 0;
    for (const [, exp] of set) if (exp > t) n++;
    return n;
  }

  load();

  function sign({ username }) {
    // 签发时顺手清理过期条目：否则长时间运行 + 反复登录会把 byUser 撑成无界增长
    prune();
    const sid = randomBytes(12).toString('base64url');
    const exp = now() + ttlMs;
    const body = { u: String(username), sid, iat: now(), exp, sv: versions.get(String(username)) ?? 0 };
    const data = Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
    let set = byUser.get(body.u);
    if (!set) { set = new Map(); byUser.set(body.u, set); }
    set.set(sid, exp);
    return `${data}.${mac(data).toString('base64url')}`;
  }

  /** 校验 token：签名不对 / 过期 / 结构损坏 / 已吊销 / 版本过期 → null */
  function verify(token) {
    if (typeof token !== 'string' || token.length === 0) return null;
    const i = token.lastIndexOf('.');
    if (i <= 0 || i === token.length - 1) return null;
    const data = token.slice(0, i);
    const sig = token.slice(i + 1);
    const expected = mac(data);
    const got = Buffer.from(sig, 'base64url');
    if (got.length !== expected.length || !timingSafeEqual(got, expected)) return null;
    let payload;
    try {
      payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
    } catch {
      return null;
    }
    if (!payload || typeof payload !== 'object') return null;
    if (typeof payload.u !== 'string' || !payload.u) return null;
    if (typeof payload.exp !== 'number' || payload.exp <= now()) return null;
    if (payload.sid && revoked.has(payload.sid)) return null;
    // 吊销记录曾损坏（fail-closed）：损坏之前签发的 token 无法自证未被吊销，一律拒绝
    if (rejectIssuedBefore > 0 && (!Number.isFinite(payload.iat) || payload.iat < rejectIssuedBefore)) return null;
    // 会话版本：改密码 / 删用户后旧 token 一律作废（重启后依然作废）
    if ((payload.sv ?? 0) !== (versions.get(payload.u) ?? 0)) return null;
    return payload;
  }

  return {
    sign,
    verify,
    ttlMs,
    storePath,
    liveSessionCount,
    /** 退出登录：立即吊销这一个会话。 */
    revoke(token) {
      const payload = verify(token);
      if (!payload?.sid) return false;
      revoked.set(payload.sid, payload.exp);
      byUser.get(payload.u)?.delete(payload.sid);
      prune();
      persist();
      return true;
    },
    /** 改密码 / 删管理员：吊销该用户全部会话（版本号 +1，重启后依然有效）。 */
    revokeUser(username) {
      const name = String(username);
      const n = liveSessionCount(name);
      versions.set(name, (versions.get(name) ?? 0) + 1);
      for (const sid of byUser.get(name)?.keys() ?? []) revoked.set(sid, now() + ttlMs);
      byUser.delete(name);
      prune();
      persist();
      return n;
    },
  };
}

export function sessionCookieHeader(token, { maxAgeMs = SESSION_TTL_MS, secure = false } = {}) {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.max(0, Math.floor(maxAgeMs / 1000))}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearCookieHeader({ secure = false } = {}) {
  const parts = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

/**
 * 登录失败限速。
 *
 * 反代（openresty）后面**所有**请求的 remoteAddress 都是代理地址，早先按 socket 地址
 * 分桶 = 全公网共用一个桶：任意匿名者发 5 次错密码就能把管理员锁在门外（F14）。
 *
 * 现在的口径：
 *  - **用户名维度**会锁定：针对某个账号的连续失败只锁那个账号；
 *    其它用户名（含不存在的）失败再多也不会锁住真实管理员；
 *  - 锁定时间指数退避：lockMs * 2^(连续锁定轮次-1)，上限 maxLockMs；
 *  - 来源（socket 地址）只做统计与日志，**不参与锁定** —— 否则反代后的单一 socket
 *    桶又能被匿名者用来把全体管理员锁死，等于没修；
 *  - 仍然**不信任 X-Forwarded-For**（调用方只传 socket 地址），伪造头无法绕过限速；
 *  - 另有**不分用户名的全局登录令牌桶**（审查#3）：每次「真的要算一次 scrypt」的尝试都从
 *    来源桶里扣一个令牌（每来源每分钟 attemptMax 次，与用户名无关）—— 轮换用户名刷登录
 *    同样会被限速，不能再无限触发哈希计算。用户被锁时不扣令牌（那次根本不跑哈希）。
 *
 * 锁定的用户名在锁定期内直接 429（连 scrypt 都不跑），所以刷锁定名不会吃 CPU。
 */
export function createLoginLimiter({
  maxFails = 5,
  lockMs = 5 * 60 * 1000,
  maxLockMs = 60 * 60 * 1000,
  now = () => Date.now(),
  maxEntries = 2048,
  // 全局尝试预算（审查#3）：每个来源每分钟 attemptMax 次登录尝试，**不看用户名**。
  // 默认 60/min 与「同 IP 连错 5 次锁账号」的 F14 口径兼容（合法管理员远用不满）。
  attemptMax = 60,
  attemptWindowMs = 60 * 1000,
  // H2：**进程级全局桶** —— 任何来源构造（伪造 XFF / 轮换来源）都绕不过的每分钟总尝试上限。
  // 量级参照 attemptMax×10：正常运维远用不满，攻击者换多少来源也炸不出无限次 scrypt。
  globalAttemptMax = attemptMax * 10,
} = {}) {
  const users = new Map();     // username → { count, lockedUntil, at, round }
  // source → { failures, at, tokens, tokensAt }：失败统计 + 尝试令牌桶（复用一张有界的表）
  const sources = new Map();
  // 全局令牌桶（H2）：与来源无关，先扣它再扣来源桶，保证总量有硬上限。
  const globalMax = Number(globalAttemptMax) > 0 ? Number(globalAttemptMax) : Math.max(1, attemptMax * 10);
  const globalBucket = { tokens: globalMax, tokensAt: now() };

  /** 硬上限：表永远不会无界增长（locked 条目也要能淘汰）。 */
  function prune() {
    const t = now();
    for (const [k, s] of users) {
      const lockExpired = !s.lockedUntil || s.lockedUntil <= t;
      if (lockExpired && t - (s.at ?? 0) > lockMs) users.delete(k);
    }
    while (users.size > maxEntries) users.delete(users.keys().next().value);
    for (const [k, s] of sources) {
      if (t - (s.at ?? 0) > lockMs) sources.delete(k);
    }
    while (sources.size > maxEntries) sources.delete(sources.keys().next().value);
  }

  /** 从一个令牌桶里按时间线性补充并扣一个令牌；不足返回还需等多久。 */
  function consumeToken(bucket, max) {
    const t = now();
    const rate = max / attemptWindowMs;             // 个/毫秒
    bucket.tokens = Math.min(max, (Number.isFinite(bucket.tokens) ? bucket.tokens : max) + Math.max(0, t - (bucket.tokensAt ?? t)) * rate);
    bucket.tokensAt = t;
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { ok: true };
    }
    return { ok: false, retryAfterMs: Math.max(1, Math.ceil((1 - bucket.tokens) / rate)) };
  }

  /**
   * 从「全局桶 + 来源桶」各取一个「登录尝试」令牌。
   * 不足则返回还需等多久 —— 这一层**与用户名无关**，轮换用户名/伪造来源都绕不过去。
   */
  function takeAttemptToken(source) {
    const g = consumeToken(globalBucket, globalMax);
    if (!g.ok) return { allowed: false, retryAfterMs: g.retryAfterMs, scope: 'global' };
    const t = now();
    const rate = attemptMax / attemptWindowMs;      // 个/毫秒
    const s = sources.get(source) ?? { failures: 0, at: t, tokens: attemptMax, tokensAt: t };
    s.tokens = Math.min(attemptMax, (Number.isFinite(s.tokens) ? s.tokens : attemptMax) + Math.max(0, t - (s.tokensAt ?? t)) * rate);
    s.tokensAt = t;
    s.at = t;
    sources.set(source, s);
    if (s.tokens >= 1) {
      s.tokens -= 1;
      return { allowed: true };
    }
    return { allowed: false, retryAfterMs: Math.max(1, Math.ceil((1 - s.tokens) / rate)), scope: 'source' };
  }

  function backoffMs(round) {
    return Math.min(maxLockMs, lockMs * 2 ** Math.max(0, round - 1));
  }

  return {
    maxFails,
    /**
     * 是否放行这一次登录尝试；返回 retryAfterMs 供 Retry-After 用。
     * 顺序：用户名锁 → 全局尝试令牌桶（真正要跑 scrypt 的尝试都要扣令牌）。
     */
    check(source = '-', username = null) {
      const t = now();
      if (username) {
        const s = users.get(String(username));
        if (s) {
          if (s.lockedUntil && s.lockedUntil > t) return { locked: true, retryAfterMs: s.lockedUntil - t, scope: 'user' };
          if (s.lockedUntil) { s.lockedUntil = 0; s.count = 0; s.at = t; }
        }
      }
      const gate = takeAttemptToken(source);
      if (!gate.allowed) return { locked: true, retryAfterMs: gate.retryAfterMs, scope: gate.scope ?? 'source' };
      return { locked: false };
    },
    /** 记一次失败（按用户名计锁；来源只计数）。 */
    fail(source = '-', username = null) {
      const t = now();
      const src = sources.get(source) ?? { failures: 0, at: t, tokens: attemptMax, tokensAt: t };
      src.failures = (src.failures ?? 0) + 1;
      src.at = t;
      sources.set(source, src);
      if (!username) { prune(); return { locked: false, remaining: maxFails }; }

      const key = String(username);
      const prev = users.get(key) ?? { count: 0, lockedUntil: 0, at: t, round: 0 };
      const s = { count: prev.count + 1, lockedUntil: 0, at: t, round: prev.round ?? 0 };
      if (s.count >= maxFails) {
        s.round += 1;
        s.lockedUntil = t + backoffMs(s.round);
        s.count = 0;
        users.set(key, s);
        prune();
        return { locked: true, retryAfterMs: s.lockedUntil - t, scope: 'user' };
      }
      users.set(key, s);
      prune();
      return { locked: false, remaining: maxFails - s.count };
    },
    /** 登录成功 → 只清掉该用户名的失败计数（来源统计保留，供排查）。 */
    reset(_source, username = null) {
      if (username) users.delete(String(username));
      return undefined;
    },
    /** 诊断用：表大小（测试断言内存不会无界增长）。 */
    size() {
      return { users: users.size, sources: sources.size };
    },
  };
}
