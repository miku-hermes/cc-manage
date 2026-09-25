// 日志 + 脱敏工具（零外部依赖）
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

// key → 对外标识：keyId = sha256 前 8 位十六进制；keyPrefix = 前 9 个字符
export function keyIdOf(key) {
  return createHash('sha256').update(String(key), 'utf8').digest('hex').slice(0, 8);
}

export function keyPrefixOf(key) {
  return String(key).slice(0, 9);
}

// 展示用掩码：保留可辨识前缀，其余打掉
export function maskSecret(secret) {
  const s = String(secret ?? '');
  if (s.length <= 9) return '***';
  return `${s.slice(0, 9)}***`;
}

// 兜底正则（**日志档**，宽松）：任何看起来像完整 CC key / 本地 key 的串都被掩码。
// 注意长度阈值 —— keyPrefix（上游 key 前缀后 4 位、sk-cg- 后 3 位）不会被误伤。
const LOOSE_KEY_RE = new RegExp(`(?:sk-cg-[A-Za-z0-9._-]{8,}|${['user', '_'].join('')}[A-Za-z0-9._-]{9,})`, 'g');

/**
 * 严格兜底（**响应体档**）：只抓「真实形态」的 key —— `user_` 后 ≥24 位、且两侧是
 * 引号 / 空白 / 行首行尾。B17-#5：宽松档会把正常的错误文案当 key 改写
 * （`user_message_length_exceeded` → `user_mess***`），而这段文本是要**回给客户端**的，
 * 改写后用户看不懂；真实 key 是 40+ 位随机串，在 JSON 里两边一定有引号。
 * `sk-cg-` 是本项目自己的 key 前缀，正常文案不会出现，长度阈值保持原样。
 */
const STRICT_SK_RE = /sk-cg-[A-Za-z0-9._-]{8,}/g;
const STRICT_USER_KEY_RE = /(^|["'\s(,=:])(user_[A-Za-z0-9._-]{24,})(?=["'\s),:}\]]|$)/g;

/** 已知密钥的精确替换（日志档 / 响应体档共用）。 */
function replaceKnownSecrets(text, secrets) {
  let out = text;
  for (const s of secrets) {
    if (typeof s === 'string' && s.length >= 8) out = out.split(s).join(maskSecret(s));
  }
  return out;
}

/**
 * 脱敏（**响应体档**，严格）：先按已知密钥做精确替换，再用严格形态的兜底正则
 * 兜住漏网的真 key。**绝不改写**正常文案（见 STRICT_USER_KEY_RE 注释）。
 * 回给客户端的 body（src/proxy.mjs）必须走这个。
 * @param {unknown} input 任意值
 * @param {string[]} secrets 已知完整密钥
 */
export function redact(input, secrets = []) {
  if (input === null || input === undefined) return input;
  let text = typeof input === 'string' ? input : String(input);
  text = replaceKnownSecrets(text, secrets);
  text = text.replace(STRICT_SK_RE, (m) => maskSecret(m));
  return text.replace(STRICT_USER_KEY_RE, (_m, pre, key) => `${pre}${maskSecret(key)}`);
}

/**
 * 脱敏（**日志档**，宽松）：兜底正则保持历史行为，宁可多掩码也不让 key 进日志。
 * 只用于写日志/事件，不用于回给客户端的响应体。
 * @param {unknown} input 任意值
 * @param {string[]} secrets 已知完整密钥
 */
export function redactForLog(input, secrets = []) {
  if (input === null || input === undefined) return input;
  let text = typeof input === 'string' ? input : String(input);
  return replaceKnownSecrets(text, secrets).replace(LOOSE_KEY_RE, (m) => maskSecret(m));
}

/**
 * 日志注入防护：外部输入（登录用户名、session id、来源 IP…）在拼进日志行之前必须清洗。
 *
 * 攻击者用 `\n` 可以在日志里伪造出一条「自带时间戳与 level」的独立行（日志伪造），
 * 用 ANSI 转义序列还能污染终端。这里把 `\r` `\n` `\t` 与 0x00-0x1f / 0x7f 全部转成
 * 可见转义（`\n` → `\\n`），并按清洗后的可见长度截断到 maxLen 字符（超出补 `…`）。
 *
 * 只清洗**外部输入片段**，不改动日志既有的时间戳 / level / 格式。
 * @param {unknown} value 外部输入
 * @param {number} maxLen 截断长度（字符数，含省略号）
 */
export function sanitizeForLog(value, maxLen = 80) {
  const text = String(value ?? '');
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (code < 0x20 || code === 0x7f) out += `\\x${code.toString(16).padStart(2, '0')}`;
    else out += ch;
  }
  const limit = Number.isFinite(Number(maxLen)) && Number(maxLen) > 0 ? Math.floor(Number(maxLen)) : 80;
  return out.length > limit ? `${out.slice(0, limit - 1)}…` : out;
}

export function createLogger({ level = 'info', file = '' } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;
  const secrets = [];
  let stream = null;
  if (file) {
    try {
      fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
      stream = fs.createWriteStream(path.resolve(file), { flags: 'a' });
      stream.on('error', () => { stream = null; });
    } catch {
      stream = null;
    }
  }

  const emit = (lvl, msg, meta) => {
    if (LEVELS[lvl] < threshold) return;
    const line = `${new Date().toISOString()} [${lvl}] ${redactForLog(msg, secrets)}`;
    let out = line;
    if (meta !== undefined) {
      let m;
      try {
        m = typeof meta === 'string' ? meta : JSON.stringify(meta);
      } catch {
        m = String(meta);
      }
      out = `${line} ${redactForLog(m, secrets)}`;
    }
    process.stdout.write(out + '\n');
    if (stream) stream.write(out + '\n');
  };

  return {
    level,
    registerSecret(secret) {
      if (typeof secret === 'string' && secret.length >= 8 && !secrets.includes(secret)) secrets.push(secret);
    },
    // 日志档（宽松）：note()/events 也走它，保持历史掩码强度
    redact: (text) => redactForLog(text, secrets),
    debug: (msg, meta) => emit('debug', msg, meta),
    info: (msg, meta) => emit('info', msg, meta),
    warn: (msg, meta) => emit('warn', msg, meta),
    error: (msg, meta) => emit('error', msg, meta),
  };
}
