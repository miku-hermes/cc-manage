// 持久化：账号池(accounts.json) / 本地 key(keys.json) / 运行期状态(data/state.json)
// 凭据优先走 config/ 目录挂载（可写，原子写 + chmod 0640），并保留旧单文件只读回落。
import fs from 'node:fs';
import path from 'node:path';
import { keyIdOf, keyPrefixOf, maskSecret } from './log.mjs';
import { blankHistory, normalizeHistory } from './history.mjs';

const LOCAL_KEY_PREFIX = 'sk-cg-';
// CC 上游 key 的固定前缀，用字面量拼接，避免在源码/镜像里出现完整形态的密钥样例串。
const CC_KEY_PREFIX = ['user', '_'].join('');
// 凭据文件权限：宿主侧要求 1000:1000 / 640（容器里是 uid 1000，宿主目录已 chown 1000:1000）。
const CREDENTIAL_MODE = 0o640;
// 凭据目录挂载点（相对 rootDir）
const CREDENTIAL_DIR = 'config';

/**
 * B11：透传伪账号在 stats.byAccount 里的固定桶（与 src/proxy.mjs 共用同一常量）。
 * 它不是池内账号，但**必须**躲过 pruneState 的「已删账号清理」，否则删任意一个真实
 * 账号都会顺手把这桶的透传统计扣掉（实测 total 10→7）。
 */
export const PASSTHROUGH_STATS_KEY = '__passthrough__';

// data/ 不可写（只读挂载 / SELinux / 宿主权限不对）时降级：打一条 warn 后转纯内存，不刷屏、不阻塞。
let persistenceDisabled = false;

/** 打开目录并 fsync（Linux 上 rename 的持久性依赖父目录 fsync）。失败不致命。 */
function fsyncDir(dir) {
  let fd = -1;
  try {
    fd = fs.openSync(dir, 'r');
    fs.fsyncSync(fd);
  } catch { /* 某些文件系统/平台不支持目录 fsync，忽略 */ } finally {
    if (fd >= 0) { try { fs.closeSync(fd); } catch { /* 忽略 */ } }
  }
}

/**
 * 原子写：临时文件 + fsync + rename + fsync 目录。
 * 全程 fsync 是必须的：ext4 默认延迟分配，掉电时只 rename 不 fsync 会留下 0 字节文件
 * （历史上正是这种文件让 loadState 抛错、网关 crash-loop）。
 * mode > 0 视为凭据文件：写前 chmod 临时文件、rename 后再 chmod 目标文件，
 * 且失败直接抛错（不静默降级），由调用方转成明确的 HTTP 错误。
 */
// 导出供 auth.mjs 复用：吊销记录同样必须原子写（tmp + fsync + rename + fsync 目录）
export function atomicWrite(file, data, { log = null, mode = 0 } = {}) {
  const dir = path.dirname(file);
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.mkdirSync(dir, { recursive: true });
    let fd = -1;
    try {
      fd = fs.openSync(tmp, 'w', mode || 0o600);
      fs.writeFileSync(fd, data, 'utf8');
      fs.fsyncSync(fd);   // 先把数据落到盘，再 rename
    } finally {
      if (fd >= 0) fs.closeSync(fd);
    }
    if (mode) fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, file);
    fsyncDir(dir);
    // 显式再 chmod 一次：不同文件系统/实现可能把权限冲成 644。
    if (mode) fs.chmodSync(file, mode);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* 忽略 */ }
    if (mode) {
      // M2b：只读挂载/权限不足时，凭据写失败必须是明确的 403 语义（只读），
      // 不能裸抛 → 被上层统一转成 500（面板只显示「内部错误」，运维查不到原因）。
      const readonly = e && (e.code === 'EROFS' || e.code === 'EACCES' || e.code === 'EPERM');
      const err = new Error(readonly
        ? `${path.basename(file)} 只读挂载（${e.code}），无法写入`
        : `${path.basename(file)} 写入失败: ${e.message}`);
      if (readonly) err.code = 'READONLY_FS';
      throw err;
    }
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

/**
 * 读「可丢弃」的缓存文件（state.json）：损坏 / 不存在 → 返回 fallback 且不抛错。
 * state.json 只是额度快照与统计缓存，丢一行都必须能照常启动。
 */
function readJSONSafe(file, fallback = null) {
  try {
    if (!fs.existsSync(file)) return { value: fallback, corrupt: false };
    const text = fs.readFileSync(file, 'utf8');
    return { value: JSON.parse(text), corrupt: false };
  } catch {
    return { value: fallback, corrupt: true };
  }
}

/** 清理崩溃残留的 `<file>.tmp-<pid>-<ts>` 临时文件（同目录、同前缀）。 */
function cleanupStaleTmp(dir, baseName) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  const removed = [];
  const prefix = `${baseName}.tmp-`;
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    try {
      fs.rmSync(path.join(dir, name), { force: true });
      removed.push(name);
    } catch { /* 忽略：删不掉不影响启动 */ }
  }
  return removed;
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function canWriteDir(dir) {
  try { fs.accessSync(dir, fs.constants.W_OK | fs.constants.X_OK); return true; } catch { return false; }
}

/**
 * M2b：某个凭据路径能否被原子写替换。
 * 只查 config/ 目录会把「legacy 单文件（如 ./accounts.json）挂成只读」判成可写 ——
 * resolveCredentialPath 会优先回落到那个只读文件，写接口于是 500。
 * 正确判据：父目录可写可执行（建 tmp / rename）+ 目标文件已存在时本身可写
 * （只读挂载/filesystem 的 W_OK 会返回 EROFS/EACCES）。
 */
function canReplacePath(file) {
  if (!canWriteDir(path.dirname(file))) return false;
  try {
    if (!fs.existsSync(file)) return true;          // 新文件：目录可写即可
    if (!fs.statSync(file).isFile()) return false;  // 目录/设备等不当作凭据文件
    fs.accessSync(file, fs.constants.W_OK);
    return true;
  } catch { return false; }
}

/**
 * 凭据文件路径优先级：
 *   config/<name> 存在 → 用它（可写）
 *   ./<name> 存在      → 旧的单文件方式（只读回落）
 *   都不存在           → 有 config/ 目录就往里写，否则维持旧路径
 */
function resolveCredentialPath(rootDir, name) {
  const configDir = path.join(rootDir, CREDENTIAL_DIR);
  const configPath = path.join(configDir, name);
  if (fs.existsSync(configPath)) return configPath;
  const legacyPath = path.join(rootDir, name);
  if (fs.existsSync(legacyPath)) return legacyPath;
  return isDir(configDir) ? configPath : legacyPath;
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
    out.push({
      name: String(item.name ?? '').trim() || `客户端-${out.length + 1}`,
      key,
      keyId: keyIdOf(key),
      keyPrefix: keyPrefixOf(key),
      createdAt: Number.isFinite(item.createdAt) ? item.createdAt : null,
    });
  }
  return out;
}

const USERNAME_RE = /^[A-Za-z0-9._@-]{1,64}$/;

/** 校验并规范化后台管理员列表。密码只存 scrypt 哈希，绝不接受/保留明文。 */
export function normalizeUsers(list) {
  if (!Array.isArray(list)) throw new Error('users 必须是数组');
  const out = [];
  const seen = new Set();
  for (const item of list) {
    if (!item || typeof item !== 'object') throw new Error('管理员条目必须是对象');
    const username = String(item.username ?? '').trim();
    if (!USERNAME_RE.test(username)) {
      throw new Error(`管理员用户名不合法（只允许字母数字与 . _ @ -，1-64 字符）：${JSON.stringify(username)}`);
    }
    if (seen.has(username)) throw new Error(`管理员用户名重复: ${username}`);
    const passwordHash = String(item.passwordHash ?? '').trim();
    if (!passwordHash.startsWith('scrypt$')) throw new Error(`管理员「${username}」的 passwordHash 必须是 scrypt$ 开头（不接受明文密码）`);
    seen.add(username);
    out.push({
      username,
      passwordHash,
      createdAt: Number.isFinite(item.createdAt) ? item.createdAt : null,
    });
  }
  return out;
}

export function createStore({ rootDir = process.cwd(), env = process.env, log = null } = {}) {
  const configDir = path.join(rootDir, CREDENTIAL_DIR);
  const stateFile = path.join(rootDir, 'data', 'state.json');

  /** 每次调用重新解析，保证迁移/重建 config/ 后无需重启即可生效。 */
  function currentPaths() {
    return {
      accountsFile: resolveCredentialPath(rootDir, 'accounts.json'),
      keysFile: resolveCredentialPath(rootDir, 'keys.json'),
      usersFile: resolveCredentialPath(rootDir, 'users.json'),
      secretFile: path.join(configDir, 'session-secret'),
    };
  }

  /**
   * 当前是否可写：按**实际解析出的**凭据文件路径逐个判断（父目录可写 + 文件可替换）。
   * 只查 config/ 会在 legacy 只读单文件回落时误报 true，写接口随即 500。
   */
  function writable() {
    if (env.CC_ACCOUNTS) return false;   // 账号池来自环境变量，落盘不会生效
    const p = currentPaths();
    return canReplacePath(p.accountsFile) && canReplacePath(p.keysFile) && canReplacePath(p.usersFile);
  }

  // pool：上次落盘时账号池的 keyId 列表。用于 B4 —— 若某 keyId 现在出现、但上次落盘
  // 时并不在池中，说明它是「删掉旧账号后重新加回来的同 keyId 新账号」，runtime 标记必须
  // 清空，绝不能继承旧账号的 authInvalid / pausedUntil。老 state.json 没有该字段 → null，
  // 此时不做该判定（保守，避免升级后误清真实账号的标记）。
  const state = { accounts: {}, stats: { total: 0, errors: 0, totalTokens: 0, byAccount: {} }, pool: null, history: blankHistory() };
  // loadState 里是否已经落过盘（损坏重建 / 残留清理）—— 供测试断言用，不进任何响应体
  let persistAfterLoad = false;

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
    const raw = readJSON(currentPaths().accountsFile, { accounts: [] });
    return normalizeAccounts(raw?.accounts ?? raw ?? []);
  }

  function loadKeys() {
    const raw = readJSON(currentPaths().keysFile, { keys: [] });
    return normalizeKeys(raw?.keys ?? raw ?? []);
  }

  /**
   * 后台管理员。文件不存在 / 内容为空 → 空数组（首次访问 /admin 走 setup 初始化）。
   * 内容损坏则抛错：宁可拒绝登录，也不能悄悄把管理员当成「未初始化」重新开放 setup。
   */
  function loadUsers() {
    const file = currentPaths().usersFile;
    const raw = readJSON(file, { users: [] });
    return normalizeUsers(raw?.users ?? raw ?? []);
  }

  function saveUsers(list) {
    const normalized = normalizeUsers(list);
    const payload = {
      users: normalized.map((u) => (u.createdAt === null
        ? { username: u.username, passwordHash: u.passwordHash }
        : { username: u.username, passwordHash: u.passwordHash, createdAt: u.createdAt })),
    };
    atomicWrite(currentPaths().usersFile, `${JSON.stringify(payload, null, 2)}\n`, { log, mode: CREDENTIAL_MODE });
    return normalized;
  }

  /** 凭据落盘：只写规范字段（派生出来的 keyId / keyPrefix 不入盘）。 */
  function saveAccounts(list) {
    const normalized = normalizeAccounts(list);
    const payload = { accounts: normalized.map((a) => ({ name: a.name, key: a.key, enabled: a.enabled })) };
    atomicWrite(currentPaths().accountsFile, `${JSON.stringify(payload, null, 2)}\n`, { log, mode: CREDENTIAL_MODE });
    return normalized;
  }

  function saveKeys(list) {
    const normalized = normalizeKeys(list);
    const payload = {
      keys: normalized.map((k) => (k.createdAt === null
        ? { name: k.name, key: k.key }
        : { name: k.name, key: k.key, createdAt: k.createdAt })),
    };
    atomicWrite(currentPaths().keysFile, `${JSON.stringify(payload, null, 2)}\n`, { log, mode: CREDENTIAL_MODE });
    return normalized;
  }

  /** 重新读盘（后台改完后热生效用）。返回规范化后的账号池与本地 key。 */
  function reload() {
    return { accounts: loadAccounts(), keys: loadKeys() };
  }

  // 运行期状态：账号 keyId → { concurrency, pausedUntil, lastQuota, lastError, lastErrorAt, rateLimitedUntil }
  function blankRuntime() {
    return {
      concurrency: 0, pausedUntil: null, lastQuota: null, lastError: null, lastErrorAt: null,
      // 普通限流的短冷却（F4）。旧 state.json 没有这个字段 → undefined，按「未限流」处理。
      rateLimitedUntil: null,
    };
  }

  /** 计数字段归一成有限数字，脏值（'9' / null / 'x' / NaN）不当场把算术变成 NaN。 */
  function normCount(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }

  /**
   * 规范化 stats（审查#13）：stats / byAccount 必须是普通对象，条目必须是对象。
   * null / 字符串 / 数组 / 条目不是对象 → 丢弃并退回默认值，绝不让 Object.entries() 在
   * 启动或 /api/status 里抛错。aborted / globalErrors 是可选计数，只在原本存在时保留。
   */
  function normalizeStats(rawStats) {
    const out = { total: 0, errors: 0, totalTokens: 0, byAccount: {} };
    if (!rawStats || typeof rawStats !== 'object' || Array.isArray(rawStats)) return out;
    out.total = normCount(rawStats.total);
    out.errors = normCount(rawStats.errors);
    out.totalTokens = normCount(rawStats.totalTokens);
    if (rawStats.aborted !== undefined) out.aborted = normCount(rawStats.aborted);
    if (rawStats.clientErrors !== undefined) out.clientErrors = normCount(rawStats.clientErrors);
    const rawBy = rawStats.byAccount;
    if (rawBy && typeof rawBy === 'object' && !Array.isArray(rawBy)) {
      for (const [id, s] of Object.entries(rawBy)) {
        if (!s || typeof s !== 'object' || Array.isArray(s)) continue;   // 非法条目直接丢
        const e = { ...s, requests: normCount(s.requests), errors: normCount(s.errors), tokens: normCount(s.tokens) };
        if (s.aborted !== undefined) e.aborted = normCount(s.aborted);
        if (s.globalErrors !== undefined) e.globalErrors = normCount(s.globalErrors);
        out.byAccount[id] = e;
      }
    }
    return out;
  }

  /**
   * 清理已从 accounts.json 删掉的账号残留：state.accounts 与 stats.byAccount 里
   * 凡是不在当前账号池 keyId 集合中的条目一律删除，并把它们的请求数从全局合计里扣掉，
   * 保证 byAccount 之和与 total/errors/totalTokens 仍然自洽。返回被清理的 keyId。
   */
  function pruneState(accounts = []) {
    const alive = new Set(accounts.map((a) => a.keyId));
    const removed = { accounts: [], stats: [] };
    // B4：上次落盘时不在池中的 keyId → 新出现的账号，清掉可能继承来的 runtime 标记。
    const prevPool = Array.isArray(state.pool) ? new Set(state.pool) : null;
    if (prevPool) {
      for (const id of alive) {
        if (!prevPool.has(id) && state.accounts[id]) {
          delete state.accounts[id];
          removed.accounts.push(id);
        }
      }
    }
    // B5：透传固定桶不是池内账号，不能被当作「已删账号」清掉并倒扣全局统计。
    alive.add(PASSTHROUGH_STATS_KEY);
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
      // 审查#15：byAccount.errors 里还包含「换号重试的账号级错误」（proxy.bumpAccountError），
      // 那部分从来没进过全局 stats.errors。只扣「计入全局」的贡献（globalErrors）；
      // 旧 state.json 没有这个字段 → 退化为旧口径（errors 全额扣）。
      const globalErrors = Number.isFinite(s.globalErrors) ? s.globalErrors : (s.errors ?? 0);
      state.stats.errors = Math.max(0, (state.stats.errors ?? 0) - globalErrors);
      state.stats.totalTokens = Math.max(0, (state.stats.totalTokens ?? 0) - (s.tokens ?? 0));
      // 中止计数（F10）同样要扣掉，否则删账号后 byAccount 之和与全局 aborted 对不上
      state.stats.aborted = Math.max(0, (state.stats.aborted ?? 0) - (s.aborted ?? 0));
      delete byAccount[id];
      removed.stats.push(id);
    }
    state.pool = accounts.map((a) => a.keyId);
    return removed;
  }

  /**
   * 加载运行期状态。传入当前账号数组时，顺带清理已删账号的残留并落盘。
   * @param {Array<{keyId: string}>|null} accounts 当前账号池（可选）
   */
  function loadState(accounts = null) {
    const dataDir = path.dirname(stateFile);
    // 崩溃残留的临时文件（atomicWrite 只在 catch 里删）在启动时顺手清掉，避免 data/ 越积越多。
    const staleTmp = cleanupStaleTmp(dataDir, path.basename(stateFile));
    if (staleTmp.length > 0) log?.warn?.(`清理了 ${staleTmp.length} 个残留的临时状态文件（${staleTmp.join(', ')}）`);
    const { value: raw, corrupt } = readJSONSafe(stateFile, null);
    // 缓存损坏（0 字节 / 截断 / 垃圾字节）绝不能阻塞启动：丢弃 + warn + 立刻写回默认值。
    if (corrupt) {
      log?.warn?.(`state.json 已损坏（${path.basename(stateFile)}），已丢弃并重建为默认值，不影响启动`);
      try { saveState(); } catch { /* 落盘失败也不能阻塞启动 */ }
      persistAfterLoad = true;
      return state;
    }
    if (raw && typeof raw.accounts === 'object' && raw.accounts !== null && !Array.isArray(raw.accounts)) {
      for (const [id, rt] of Object.entries(raw.accounts)) {
        if (!rt || typeof rt !== 'object' || Array.isArray(rt)) continue;   // 脏条目丢弃，不炸启动
        state.accounts[id] = { ...blankRuntime(), ...rt, concurrency: 0 };
      }
    }
    // stats / byAccount 必须规范化成对象（审查#13）：null / 字符串会让 Object.entries() 直接抛错
    state.stats = normalizeStats(raw?.stats);
    // B13：历史趋势。坏形状（老 state.json 没有该字段 / 手改成垃圾）一律退化成空历史。
    // 只在内存里规范化 —— 绝不在这里落盘，否则「账号全在册」的加载路径会多写一次
    // state.json，破坏 store.test.mjs 的逐字节不变量。
    state.history = normalizeHistory(raw?.history);
    // B4：先恢复「上次落盘时的池成员」再 prune —— pruneState 据此识别新出现的 keyId。
    state.pool = Array.isArray(raw?.pool) ? raw.pool.map(String) : null;
    if (Array.isArray(accounts)) {
      const removed = pruneState(accounts);
      if (removed.accounts.length > 0 || removed.stats.length > 0) {
        log?.info?.(`清理已删除账号的残留状态: ${[...new Set([...removed.accounts, ...removed.stats])].join(', ')}`);
        saveState();
        persistAfterLoad = true;
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
    // pool 一并落盘：下次加载据此识别「删掉又加回来的同 keyId 新账号」（B4）。
    const pool = Array.isArray(state.pool) ? state.pool : [];
    atomicWrite(stateFile, JSON.stringify({ accounts, stats: state.stats, pool, history: state.history }, null, 2), { log });
  }

  return {
    rootDir,
    configDir,
    get accountsFile() { return currentPaths().accountsFile; },
    get keysFile() { return currentPaths().keysFile; },
    get usersFile() { return currentPaths().usersFile; },
    get secretFile() { return currentPaths().secretFile; },
    stateFile,
    state,
    writable,
    /** 上次 loadState 是否已把状态写回磁盘（损坏重建 / 清理残留）。 */
    get persistedAfterLoad() { return persistAfterLoad; },
    reload,
    saveAccounts,
    saveKeys,
    saveUsers,
    loadAccounts,
    loadKeys,
    loadUsers,
    loadState,
    pruneState,
    saveState,
    runtimeFor(keyId) {
      if (!state.accounts[keyId]) state.accounts[keyId] = blankRuntime();
      return state.accounts[keyId];
    },
  };
}

export { LOCAL_KEY_PREFIX, CC_KEY_PREFIX, CREDENTIAL_MODE, CREDENTIAL_DIR };
