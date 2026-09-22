// 真实来源 IP 解析（零外部依赖，只用 node:net）
//
// 背景（审查 A5）：反代（1Panel openresty）后面所有请求的 TCP 来源都是代理地址。
// 若限速只按 socket 地址分桶，「每来源」令牌桶就退化成**全局桶** —— 匿名者轮换用户名
// 刷失败即可把全体管理员的登录一起挡在门外。
//
// 策略：**仅当** socket 来源属于配置的可信代理集合时，才采信代理头；否则一律回落
// socket 地址。这样既能按真实客户端分桶，又不会被伪造的 X-Forwarded-For 绕过限速。
import net from 'node:net';

/** 默认可信来源：回环 + 私网 / 容器网段（docker bridge、1Panel 反代都在其中）。 */
export const DEFAULT_TRUSTED_PROXY_CIDRS = [
  '127.0.0.0/8',
  '::1/128',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  'fc00::/7',
  'fe80::/10',
];

/**
 * 归一化一个 IP：去方括号 / zone，IPv4-mapped IPv6（::ffff:1.2.3.4）还原成 IPv4。
 * 不是合法 IP 返回 null。
 */
export function normalizeIp(raw) {
  let s = String(raw ?? '').trim();
  if (!s) return null;
  if (s.startsWith('[')) {
    const end = s.indexOf(']');
    if (end > 0) s = s.slice(1, end);
  }
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  if (s.startsWith('::ffff:')) {
    const rest = s.slice('::ffff:'.length);
    if (net.isIP(rest) === 4) return rest;
  }
  return net.isIP(s) ? s : null;
}

/** IP → 字节数组（IPv4 4 字节 / IPv6 16 字节）；非法返回 null。 */
function ipBytes(ip) {
  const version = net.isIP(ip);
  if (version === 4) return ip.split('.').map((n) => Number(n));
  if (version !== 6) return null;

  const [headStr, tailStr] = ip.includes('::') ? ip.split('::') : [ip, null];
  const parseGroups = (str) => {
    if (!str) return [];
    const out = [];
    for (const part of str.split(':')) {
      if (part.includes('.')) {
        const v4 = part.split('.').map((n) => Number(n));
        out.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]);
      } else {
        out.push(parseInt(part || '0', 16));
      }
    }
    return out;
  };
  const head = parseGroups(headStr);
  const tail = parseGroups(tailStr ?? '');
  let groups;
  if (tailStr === null) {
    groups = head;
  } else {
    const missing = 8 - head.length - tail.length;
    if (missing < 0) return null;
    groups = [...head, ...Array(missing).fill(0), ...tail];
  }
  if (groups.length !== 8 || groups.some((g) => !Number.isFinite(g) || g < 0 || g > 0xffff)) return null;
  const out = [];
  for (const g of groups) out.push((g >> 8) & 0xff, g & 0xff);
  return out;
}

/** ip 是否落在 cidr 内（cidr 允许裸 IP，表示只匹配该主机）。 */
export function ipInCidr(ip, cidr) {
  const addr = normalizeIp(ip);
  if (!addr) return false;
  const spec = String(cidr ?? '').trim();
  if (!spec) return false;
  const slash = spec.indexOf('/');
  const netIp = normalizeIp(slash >= 0 ? spec.slice(0, slash) : spec);
  if (!netIp) return false;
  const a = ipBytes(addr);
  const b = ipBytes(netIp);
  if (!a || !b || a.length !== b.length) return false;
  const maxBits = a.length * 8;
  let bits = maxBits;
  if (slash >= 0) {
    const p = Number(spec.slice(slash + 1));
    if (!Number.isFinite(p) || p < 0) return false;
    bits = Math.min(maxBits, Math.floor(p));
  }
  for (let i = 0; i < a.length; i++) {
    const remain = bits - i * 8;
    if (remain <= 0) break;
    const mask = remain >= 8 ? 0xff : (0xff << (8 - remain)) & 0xff;
    if ((a[i] & mask) !== (b[i] & mask)) return false;
  }
  return true;
}

/** 来源 IP 是否属于可信代理集合。 */
export function isTrustedProxy(ip, cidrs = DEFAULT_TRUSTED_PROXY_CIDRS) {
  const list = Array.isArray(cidrs) && cidrs.length > 0 ? cidrs : DEFAULT_TRUSTED_PROXY_CIDRS;
  return list.some((c) => ipInCidr(ip, c));
}

/**
 * 解析请求的真实来源 IP。
 * - 来源不可信 → 忽略一切代理头，回落 socket 地址（防伪造）。
 * - 来源可信 → 取 `x-forwarded-for` 最左有效项（IPv6 映射形式归一化），否则 `x-real-ip`,
 *   都拿不到再回落 socket。
 * @param {{ remoteAddress?: string, headers?: object }} req
 * @param {string[]} trustedCidrs
 */
export function resolveClientIp(req, trustedCidrs = DEFAULT_TRUSTED_PROXY_CIDRS) {
  const remote = req?.remoteAddress;
  const socketIp = normalizeIp(remote) ?? (remote ? String(remote) : '-');
  if (!isTrustedProxy(socketIp, trustedCidrs)) return socketIp;

  const headers = req?.headers ?? {};
  const xffRaw = headers['x-forwarded-for'];
  const xff = Array.isArray(xffRaw) ? xffRaw.join(',') : xffRaw;
  if (typeof xff === 'string' && xff) {
    for (const part of xff.split(',')) {
      const ip = normalizeIp(part);
      if (ip) return ip;
    }
  }

  const xriRaw = headers['x-real-ip'];
  const xri = Array.isArray(xriRaw) ? xriRaw[0] : xriRaw;
  if (typeof xri === 'string' && xri.trim()) {
    const ip = normalizeIp(xri);
    if (ip) return ip;
  }
  return socketIp;
}
