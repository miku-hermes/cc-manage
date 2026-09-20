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

// scrypt 参数：128*N*r = 16MB 内存，约几十毫秒，登录场景够用且不至于拖垮小机器
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;
const SCRYPT_SALT_BYTES = 16;
// 校验时拒绝离谱参数（users.json 被改坏/被投毒时不至于把内存打爆）
const SCRYPT_MAX_N = 1 << 20;

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
  const hash = scryptSync(String(password), salt, keylen, { N, r, p, maxmem: 256 * N * r });
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
  if (N < 2 || N > SCRYPT_MAX_N || r < 1 || r > 32 || p < 1 || p > 16) return false;
  const salt = Buffer.from(parts[4], 'base64');
  const expected = Buffer.from(parts[5], 'base64');
  if (salt.length === 0 || expected.length === 0) return false;
  let actual;
  try {
    actual = scryptSync(password, salt, expected.length, { N, r, p, maxmem: 256 * N * r });
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
 * payload: { u: 用户名, sid: 会话随机 id, iat, exp }
 *
 * cookie 是自包含的（无服务端 session 表），但额外维护一份**内存吊销表**：
 * 退出登录 / 改密码后旧 token 立刻失效（重启会丢吊销表，最坏情况退回纯 TTL 语义）。
 */
export function createSessionSigner({ secret, ttlMs = SESSION_TTL_MS, now = () => Date.now() } = {}) {
  if (!secret) throw new Error('session 签名密钥缺失');
  const key = Buffer.from(String(secret), 'utf8');
  const mac = (data) => createHmac('sha256', key).update(data).digest();
  const revoked = new Map();              // sid → 该会话的 exp（过期即可遗忘）
  const byUser = new Map();               // username → Set<sid>，改密码/删用户时整批吊销

  function prune() {
    const t = now();
    for (const [sid, exp] of revoked) if (exp <= t) revoked.delete(sid);
  }

  function sign({ username }) {
    const sid = randomBytes(12).toString('base64url');
    const body = { u: String(username), sid, iat: now(), exp: now() + ttlMs };
    const data = Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
    let set = byUser.get(body.u);
    if (!set) { set = new Set(); byUser.set(body.u, set); }
    set.add(sid);
    return `${data}.${mac(data).toString('base64url')}`;
  }

  /** 校验 token：签名不对 / 过期 / 结构损坏 / 已吊销 → null */
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
    return payload;
  }

  return {
    sign,
    verify,
    ttlMs,
    /** 退出登录：立即吊销这一个会话。 */
    revoke(token) {
      const payload = verify(token);
      if (!payload?.sid) return false;
      revoked.set(payload.sid, payload.exp);
      byUser.get(payload.u)?.delete(payload.sid);
      prune();
      return true;
    },
    /** 改密码 / 删管理员：吊销该用户全部会话。 */
    revokeUser(username) {
      const set = byUser.get(String(username));
      if (!set) return 0;
      let n = 0;
      for (const sid of set) { revoked.set(sid, now() + ttlMs); n++; }
      byUser.delete(String(username));
      prune();
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
 * 登录失败限速：同一个 IP 连续失败 maxFails 次 → 锁 lockMs。
 * 第 maxFails 次失败直接返回 locked=true（调用方回 429）。
 */
export function createLoginLimiter({ maxFails = 5, lockMs = 5 * 60 * 1000, now = () => Date.now() } = {}) {
  const hits = new Map(); // ip → { count, lockedUntil }

  function prune() {
    if (hits.size <= 512) return;
    const t = now();
    for (const [k, s] of hits) {
      if (!s.lockedUntil && t - (s.at ?? 0) > lockMs) hits.delete(k);
    }
  }

  return {
    /** 是否处于锁定状态；返回 retryAfterMs 供 Retry-After 用 */
    check(ip) {
      const s = hits.get(ip);
      if (!s) return { locked: false };
      if (s.lockedUntil && s.lockedUntil > now()) return { locked: true, retryAfterMs: s.lockedUntil - now() };
      if (s.lockedUntil) hits.delete(ip);
      return { locked: false };
    },
    /** 记一次失败；达到阈值则上锁并返回 locked=true */
    fail(ip) {
      const prev = hits.get(ip) ?? { count: 0, lockedUntil: 0, at: now() };
      const s = { count: prev.count + 1, lockedUntil: 0, at: now() };
      if (s.count >= maxFails) {
        s.lockedUntil = now() + lockMs;
        s.count = 0;
        hits.set(ip, s);
        return { locked: true, retryAfterMs: lockMs };
      }
      hits.set(ip, s);
      prune();
      return { locked: false, remaining: maxFails - s.count };
    },
    /** 登录成功 → 清零 */
    reset(ip) {
      hits.delete(ip);
    },
  };
}
