// 持久化：账号池(accounts.json) / 本地 key(keys.json) / 运行期状态(data/state.json)
// 一切写入走「临时文件 + rename」原子写。
import fs from 'node:fs';
import path from 'node:path';
import { keyIdOf, keyPrefixOf, maskSecret } from './log.mjs';

const LOCAL_KEY_PREFIX = 'sk-cg-';
const CC_KEY_PREFIX = 'user_';

function atomicWrite(file, data) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, data, 'utf8');
  fs.renameSync(tmp, file);
}

function readJSON(file, fallback = null) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`${path.basename(file)} 解析失败: ${e.message}`);
  }
}

/** 校验并规范化账号数组。key 必须以 user_ 开头。 */
export function normalizeAccounts(list) {
  if (!Array.isArray(list)) throw new Error('accounts 必须是数组');
  const out = [];
  const seen = new Set();
  for (const item of list) {
    if (!item || typeof item !== 'object') throw new Error('账号条目必须是对象');
    const key = String(item.key ?? '').trim();
    if (!key.startsWith(CC_KEY_PREFIX)) {
      throw new Error(`账号「${item.name ?? '未命名'}」的 key 必须以 ${CC_KEY_PREFIX} 开头（当前为 ${maskSecret(key)}）`);
    }
    if (seen.has(key)) throw new Error(`账号 key 重复: ${maskSecret(key)}`);
    seen.add(key);
    out.push({
      name: String(item.name ?? '').trim() || `账号-${out.length + 1}`,
      key,
      enabled: item.enabled !== false,
      keyId: keyIdOf(key),
      keyPrefix: keyPrefixOf(key),
    });
  }
  return out;
}

export function normalizeKeys(list) {
  if (!Array.isArray(list)) throw new Error('keys 必须是数组');
  const out = [];
  const seen = new Set();
  for (const item of list) {
    if (!item || typeof item !== 'object') throw new Error('本地 key 条目必须是对象');
    const key = String(item.key ?? '').trim();
    if (!key.startsWith(LOCAL_KEY_PREFIX)) {
      throw new Error(`本地 key 必须以 ${LOCAL_KEY_PREFIX} 开头（当前为 ${maskSecret(key)}）`);
    }
    if (seen.has(key)) throw new Error(`本地 key 重复: ${maskSecret(key)}`);
    seen.add(key);
    out.push({ name: String(item.name ?? '').trim() || `客户端-${out.length + 1}`, key, keyId: keyIdOf(key), keyPrefix: keyPrefixOf(key) });
  }
  return out;
}

export function createStore({ rootDir = process.cwd(), env = process.env } = {}) {
  const accountsFile = path.join(rootDir, 'accounts.json');
  const keysFile = path.join(rootDir, 'keys.json');
  const stateFile = path.join(rootDir, 'data', 'state.json');

  const state = { accounts: {}, stats: { total: 0, errors: 0, totalTokens: 0, byAccount: {} } };

  function loadAccounts() {
    if (env.CC_ACCOUNTS) {
      let parsed;
      try {
        parsed = JSON.parse(env.CC_ACCOUNTS);
      } catch (e) {
        throw new Error(`CC_ACCOUNTS 解析失败: ${e.message}`);
      }
      const list = Array.isArray(parsed) ? parsed : parsed?.accounts;
      return normalizeAccounts(list ?? []);
    }
    const raw = readJSON(accountsFile, { accounts: [] });
    return normalizeAccounts(raw?.accounts ?? raw ?? []);
  }

  function loadKeys() {
    const raw = readJSON(keysFile, { keys: [] });
    return normalizeKeys(raw?.keys ?? raw ?? []);
  }

  // 运行期状态：账号 keyId → { concurrency, pausedUntil, lastQuota, lastError, lastErrorAt }
  function blankRuntime() {
    return { concurrency: 0, pausedUntil: null, lastQuota: null, lastError: null, lastErrorAt: null };
  }

  function loadState() {
    const raw = readJSON(stateFile, null);
    if (raw && typeof raw === 'object') {
      if (raw.accounts && typeof raw.accounts === 'object') {
        for (const [id, rt] of Object.entries(raw.accounts)) state.accounts[id] = { ...blankRuntime(), ...rt, concurrency: 0 };
      }
      if (raw.stats && typeof raw.stats === 'object') {
        state.stats = { total: 0, errors: 0, totalTokens: 0, byAccount: {}, ...raw.stats };
      }
    }
    return state;
  }

  function saveState() {
    // concurrency 是在途计数，重启后必然为 0，不落盘，避免崩溃后残留。
    const accounts = {};
    for (const [id, rt] of Object.entries(state.accounts)) {
      accounts[id] = { ...rt, concurrency: 0 };
    }
    atomicWrite(stateFile, JSON.stringify({ accounts, stats: state.stats }, null, 2));
  }

  return {
    rootDir,
    accountsFile,
    keysFile,
    stateFile,
    state,
    loadAccounts,
    loadKeys,
    loadState,
    saveState,
    runtimeFor(keyId) {
      if (!state.accounts[keyId]) state.accounts[keyId] = blankRuntime();
      return state.accounts[keyId];
    },
  };
}

export { LOCAL_KEY_PREFIX, CC_KEY_PREFIX };
