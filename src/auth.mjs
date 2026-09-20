// 鉴权原语（零外部依赖）：scrypt 密码哈希、HMAC-SHA256 签名 cookie session、登录失败限速
//
// 两套凭据职责分清：
//   - 后台管理员：账号 + 密码（scrypt 加盐哈希存 config/users.json）→ session cookie
//   - 客户端 API key：sk-cg-*（config/keys.json）→ 只用于 /v1/* 反代调用
import fs from 'node:fs';
import path from 'node:path';
import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

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
 * 生成密码哈希：`scrypt$N$r$p$<salt-b64>$<hash-b64>`。绝不存明文。
 * @param {string} password
 * @param {{ N?: number, r?: number, p?: number, keylen?: number, salt?: Buffer }} [opts]
 */
export function hashPassword(password, opts = {}) {
  const N = opts.N ?? SCRYPT_N;
  const r = opts.r ?? SCRYPT_R;
  const p = opts.p ?? SCRYPT_P;
  const keylen = opts.keylen ?? SCRYPT_KEYLEN;
  const salt = opts.salt ?? randomBytes(SCRYPT_SALT_BYTES);
  const hash = scryptSync(String(password), salt, keylen, { N, r, p, maxmem: SCRYPT_MAX_MEM });
  return `scrypt$${N}$${r}$${p}$${b64(salt)}$${b64(hash)}`;
}

/** 校验密码。参数非法 / 哈希损坏一律返回 false，不抛错。 */
export function verifyPassword(password, stored) {
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
    actual = scryptSync(password, salt, expected.length, { N, r, p, maxmem: SCRYPT_MAX_MEM });
  } catch {
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

  function load() {
    if (!storePath) return;
    try {
      if (!fs.existsSync(storePath)) return;
      const raw = JSON.parse(fs.readFileSync(storePath, 'utf8'));
      const t = now();
      for (const [sid, exp] of Object.entries(raw?.sids ?? {})) {
        if (Number.isFinite(exp) && exp > t) revoked.set(sid, exp);
      }
      for (const [u, v] of Object.entries(raw?.versions ?? {})) {
        if (Number.isInteger(v) && v > 0) versions.set(u, v);
      }
    } catch (e) {
      log?.warn?.(`会话吊销记录损坏，已忽略（${e.message}）`);
    }
  }

  function persist() {
    if (!storePath) return;
    try {
      const sids = {};
      for (const [sid, exp] of revoked) sids[sid] = exp;
      const rawVersions = {};
      for (const [u, v] of versions) rawVersions[u] = v;
      const tmp = `${storePath}.tmp-${process.pid}-${Date.now()}`;
      fs.mkdirSync(path.dirname(storePath), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify({ sids, versions: rawVersions }, null, 2), { mode: 0o600 });
      fs.chmodSync(tmp, 0o600);
      fs.renameSync(tmp, storePath);
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
 *  - **只有「用户名」维度会锁定**：针对某个账号的连续失败只锁那个账号；
 *    其它用户名（含不存在的）失败再多也不会锁住真实管理员；
 *  - 锁定时间指数退避：lockMs * 2^(连续锁定轮次-1)，上限 maxLockMs；
 *  - 来源（socket 地址）只做统计与日志，**不参与锁定** —— 否则反代后的单一 socket
 *    桶又能被匿名者用来把全体管理员锁死，等于没修；
 *  - 仍然**不信任 X-Forwarded-For**（调用方只传 socket 地址），伪造头无法绕过限速。
 *
 * 锁定的用户名在锁定期内直接 429（连 scrypt 都不跑），所以刷锁定名不会吃 CPU。
 */
export function createLoginLimiter({
  maxFails = 5,
  lockMs = 5 * 60 * 1000,
  maxLockMs = 60 * 60 * 1000,
  now = () => Date.now(),
  maxEntries = 2048,
} = {}) {
  const users = new Map();     // username → { count, lockedUntil, at, round }
  const sources = new Map();   // source   → { failures, at }（只统计，不锁定）

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

  function backoffMs(round) {
    return Math.min(maxLockMs, lockMs * 2 ** Math.max(0, round - 1));
  }

  return {
    maxFails,
    /** 是否处于锁定状态；返回 retryAfterMs 供 Retry-After 用。 */
    check(_source, username = null) {
      if (!username) return { locked: false };
      const s = users.get(String(username));
      if (!s) return { locked: false };
      if (s.lockedUntil && s.lockedUntil > now()) return { locked: true, retryAfterMs: s.lockedUntil - now(), scope: 'user' };
      if (s.lockedUntil) { s.lockedUntil = 0; s.count = 0; s.at = now(); }
      return { locked: false };
    },
    /** 记一次失败（按用户名计锁；来源只计数）。 */
    fail(source = '-', username = null) {
      const t = now();
      const src = sources.get(source) ?? { failures: 0, at: t };
      sources.set(source, { failures: src.failures + 1, at: t });
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
