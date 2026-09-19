// 持久化：账号池(accounts.json) / 本地 key(keys.json) / 运行期状态(data/state.json)
// 一切写入走「临时文件 + rename」原子写。
import fs from 'node:fs';
import path from 'node:path';
import { keyIdOf, keyPrefixOf, maskSecret } from './log.mjs';

const LOCAL_KEY_PREFIX = 'sk-cg-';
// CC 上游 key 的固定前缀，用字面量拼接，避免在源码/镜像里出现完整形态的密钥样例串。
const CC_KEY_PREFIX = ['user', '_'].join('');

// data/ 不可写（只读挂载 / SELinux / 宿主权限不对）时降级：打一条 warn 后转纯内存，不刷屏、不阻塞。
let persistenceDisabled = false;

function atomicWrite(file, data, log) {
  const dir = path.dirname(file);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, data, 'utf8');
    fs.renameSync(tmp, file);
  } catch (e) {
    if (!persistenceDisabled) {
      persistenceDisabled = true;
      log?.warn?.(`运行期状态无法持久化（${path.basename(file)} 写入失败：${e.message}），已降级为纯内存模式继续运行`);
    }
  }
}

function readJSON(file, fallback = null) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`${path.basename(file)} 解析失败: ${e.message}`);
  }
}

/** 校验并规范化账号数组。key 必须以 CC 上游前缀开头。 */
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

export function createStore({ rootDir = process.cwd(), env = process.env, log = null } = {}) {
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

  /**
   * 清理已从 accounts.json 删掉的账号残留：state.accounts 与 stats.byAccount 里
   * 凡是不在当前账号池 keyId 集合中的条目一律删除，并把它们的请求数从全局合计里扣掉，
   * 保证 byAccount 之和与 total/errors/totalTokens 仍然自洽。返回被清理的 keyId。
   */
  function pruneState(accounts = []) {
    const alive = new Set(accounts.map((a) => a.keyId));
    const removed = { accounts: [], stats: [] };
    for (const id of Object.keys(state.accounts)) {
      if (!alive.has(id)) {
        delete state.accounts[id];
        removed.accounts.push(id);
      }
    }
    const byAccount = state.stats?.byAccount ?? {};
    for (const id of Object.keys(byAccount)) {
      if (alive.has(id)) continue;
      const s = byAccount[id] ?? {};
      state.stats.total = Math.max(0, (state.stats.total ?? 0) - (s.requests ?? 0));
      state.stats.errors = Math.max(0, (state.stats.errors ?? 0) - (s.errors ?? 0));
      state.stats.totalTokens = Math.max(0, (state.stats.totalTokens ?? 0) - (s.tokens ?? 0));
      delete byAccount[id];
      removed.stats.push(id);
    }
    return removed;
  }

  /**
   * 加载运行期状态。传入当前账号数组时，顺带清理已删账号的残留并落盘。
   * @param {Array<{keyId: string}>|null} accounts 当前账号池（可选）
   */
  function loadState(accounts = null) {
    const raw = readJSON(stateFile, null);
    if (raw && typeof raw === 'object') {
      if (raw.accounts && typeof raw.accounts === 'object') {
        for (const [id, rt] of Object.entries(raw.accounts)) state.accounts[id] = { ...blankRuntime(), ...rt, concurrency: 0 };
      }
      if (raw.stats && typeof raw.stats === 'object') {
        state.stats = { total: 0, errors: 0, totalTokens: 0, byAccount: {}, ...raw.stats };
      }
    }
    if (Array.isArray(accounts)) {
      const removed = pruneState(accounts);
      if (removed.accounts.length > 0 || removed.stats.length > 0) {
        log?.info?.(`清理已删除账号的残留状态: ${[...new Set([...removed.accounts, ...removed.stats])].join(', ')}`);
        saveState();
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
    atomicWrite(stateFile, JSON.stringify({ accounts, stats: state.stats }, null, 2), log);
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
    pruneState,
    saveState,
    runtimeFor(keyId) {
      if (!state.accounts[keyId]) state.accounts[keyId] = blankRuntime();
      return state.accounts[keyId];
    },
  };
}

export { LOCAL_KEY_PREFIX, CC_KEY_PREFIX };
