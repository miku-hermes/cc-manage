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

// 兜底正则：任何看起来像完整 CC key / 本地 key 的串都被掩码。
// 注意长度阈值 —— keyPrefix（上游 key 前缀后 4 位、sk-cg- 后 3 位）不会被误伤。
const LOOSE_KEY_RE = new RegExp(`(?:sk-cg-[A-Za-z0-9._-]{8,}|${['user', '_'].join('')}[A-Za-z0-9._-]{9,})`, 'g');

/**
 * 脱敏：先按已知密钥做精确替换，再用兜底正则兜住任何漏网的 key。
 * @param {unknown} input 任意值
 * @param {string[]} secrets 已知完整密钥
 */
export function redact(input, secrets = []) {
  if (input === null || input === undefined) return input;
  let text = typeof input === 'string' ? input : String(input);
  for (const s of secrets) {
    if (typeof s === 'string' && s.length >= 8) text = text.split(s).join(maskSecret(s));
  }
  return text.replace(LOOSE_KEY_RE, (m) => maskSecret(m));
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
    const line = `${new Date().toISOString()} [${lvl}] ${redact(msg, secrets)}`;
    let out = line;
    if (meta !== undefined) {
      let m;
      try {
        m = typeof meta === 'string' ? meta : JSON.stringify(meta);
      } catch {
        m = String(meta);
      }
      out = `${line} ${redact(m, secrets)}`;
    }
    process.stdout.write(out + '\n');
    if (stream) stream.write(out + '\n');
  };

  return {
    level,
    registerSecret(secret) {
      if (typeof secret === 'string' && secret.length >= 8 && !secrets.includes(secret)) secrets.push(secret);
    },
    redact: (text) => redact(text, secrets),
    debug: (msg, meta) => emit('debug', msg, meta),
    info: (msg, meta) => emit('info', msg, meta),
    warn: (msg, meta) => emit('warn', msg, meta),
    error: (msg, meta) => emit('error', msg, meta),
  };
}
