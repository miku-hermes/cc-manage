// cc-manage 入口：HTTP 服务 + 路由（多账号反代 + 额度面板 API）
import http from 'node:http';
import fs from 'node:fs';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './src/config.mjs';
import { createStore, CC_KEY_PREFIX, LOCAL_KEY_PREFIX } from './src/store.mjs';
import { createLogger, keyIdOf, keyPrefixOf, redact } from './src/log.mjs';
import { fetchQuota } from './src/quota.mjs';
import { createScheduler } from './src/scheduler.mjs';
import { createProxy } from './src/proxy.mjs';

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

/** 带 HTTP 状态码的错误，后台接口统一用它转成响应。 */
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const BODY_PEEK_BYTES = 65536;

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
  const config = { ...loadConfig(overrides.configPath ?? path.join(ROOT, 'config.json'), overrides.env ?? process.env), ...(overrides.config ?? {}) };
  const log = createLogger({ level: config.logLevel, file: config.logFile });

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

  const scheduler = createScheduler({ accounts, state: store.state, ttlMs: config.sessionAffinityTtlMs, log });
  const stats = store.state.stats;
  for (const a of accounts) stats.byAccount[a.keyId] ??= { requests: 0, errors: 0, tokens: 0 };

  // ── 额度查询与刷新 ──────────────────────────────────────
  async function refreshAccount(account) {
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
    }
    return { account, snapshot };
  }

  async function refreshAll() {
    // 各账号互不影响：单个失败不会中断其它查询
    const results = await Promise.all(accounts.map((a) => refreshAccount(a).catch((e) => ({
      account: a,
      snapshot: { ok: false, error: redact(e?.message ?? String(e), secrets), authInvalid: false, fetchedAt: Date.now() },
    }))));
    store.saveState();
    return results;
  }

  const proxy = createProxy({ config, scheduler, log, stats, secrets, refreshAccount });

  // ── 后台定时器 ─────────────────────────────────────────
  let pollTimer = null;
  let recheckTimer = null;
  if (!overrides.noTimers) {
    if (config.quotaPollIntervalMs > 0) {
      pollTimer = setInterval(() => { refreshAll().catch((e) => log.error(`额度轮询异常: ${e.message}`)); }, config.quotaPollIntervalMs);
      pollTimer.unref?.();
    }
    if (config.pausedRecheckIntervalMs > 0) {
      recheckTimer = setInterval(() => {
        scheduler.recheckPaused({ fetchQuota: (a) => fetchQuota(a.key, { baseUrl: config.ccApiBase, timeoutMs: config.quotaTimeoutMs, fetchImpl: overrides.fetchImpl, log }) })
          .then(() => store.saveState())
          .catch((e) => log.error(`暂停复查异常: ${e.message}`));
      }, config.pausedRecheckIntervalMs);
      recheckTimer.unref?.();
    }
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
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  }

  function authError(res) {
    sendJSON(res, 401, { error: { message: 'Invalid or missing API key. Provide Authorization: Bearer <key> or x-api-key.', type: 'auth_error' } });
  }

  /** 管理/后台接口鉴权：PROTECT_ADMIN_API=1 且配置了本地 key 时必须带正确 key。 */
  function requireLocalKey(req, res) {
    if (config.protectAdminApi && localKeys.length > 0 && localKeyIndexOf(extractKey(req)) < 0) {
      authError(res);
      return false;
    }
    return true;
  }

  // ── 请求统计视图 ────────────────────────────────────────
  function accountView(account) {
    const rt = scheduler.runtime(account);
    const q = rt.lastQuota;
    const pct = (w) => (w && typeof w.percent === 'number' ? Math.round(w.percent * 10) / 10 : null);
    return {
      name: account.name,
      keyId: account.keyId,          // 只暴露 keyId / keyPrefix，绝不返回完整 key
      keyPrefix: account.keyPrefix,
      enabled: account.enabled,
      available: scheduler.isAvailable(account),
      concurrency: rt.concurrency,
      pausedUntil: rt.pausedUntil,
      paused: !!(rt.pausedUntil && rt.pausedUntil > Date.now()),
      authInvalid: !!rt.authInvalid,
      lastError: rt.lastError ? redact(rt.lastError, secrets) : null,
      lastErrorAt: rt.lastErrorAt,
      lastQuota: q
        ? {
            ok: q.ok,
            displayName: q.displayName,
            plan: q.plan,
            remaining: q.remaining,
            credits: q.credits,
            fiveHour: q.fiveHour,
            weekly: q.weekly,
            monthly: q.monthly,
            usage: q.usage,
            percent: { fiveHour: pct(q.fiveHour), weekly: pct(q.weekly), monthly: pct(q.monthly) },
            fetchedAt: q.fetchedAt,
          }
        : null,
    };
  }

  function statusView() {
    const accounts_ = accounts.map(accountView);
    return {
      ok: true,
      now: Date.now(),
      upstreamProxyUrl: config.upstreamProxyUrl,
      allowPassthrough: config.allowPassthrough,
      gateway: { host: config.gatewayHost, port: config.gatewayPort },
      summary: {
        accounts: accounts.length,
        enabled: accounts.filter((a) => a.enabled).length,
        available: accounts.filter((a) => scheduler.isAvailable(a)).length,
        paused: accounts.filter((a) => a.pausedUntil && a.pausedUntil > Date.now()).length,
        concurrency: accounts.reduce((n, a) => n + (scheduler.runtime(a).concurrency || 0), 0),
      },
      stats: {
        total: stats.total,
        errors: stats.errors,
        totalTokens: stats.totalTokens,
        byAccount: Object.fromEntries(Object.entries(stats.byAccount).map(([id, s]) => [id, { ...s }])),
      },
      accounts: accounts_,
    };
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

  /** 操作者标识：用本地 key 的 keyId 表示，绝不回显 key 本身。 */
  function actorOf(req) {
    const idx = localKeyIndexOf(extractKey(req));
    const id = idx >= 0 ? localKeys[idx].keyId : 'unknown';
    return `keyId=${id}@${req.socket?.remoteAddress ?? '-'}`;
  }

  function cleanName(raw) {
    const name = String(raw ?? '').trim();
    if (!name) throw new HttpError(400, '名称不能为空');
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
      authInvalid: !!rt.authInvalid,
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
    } catch (e) {
      throw new HttpError(400, `请求体不是合法 JSON: ${e.message}`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new HttpError(400, '请求体必须是 JSON 对象');
    return parsed;
  }

  /** sk-cg- + 32 字节随机（base64url）。只在此处生成，明文只在响应里出现一次。 */
  function generateLocalKey() {
    return `${LOCAL_KEY_PREFIX}${randomBytes(32).toString('base64url')}`;
  }

  function eventsView(url) {
    const level = url.searchParams.get('level');
    const limitRaw = Number(url.searchParams.get('limit'));
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, EVENTS_MAX) : EVENTS_MAX;
    const list = events.filter((e) => !level || e.level === level).slice(-limit).reverse();
    return { ok: true, total: events.length, events: list };
  }

  /** 后台接口路由。命中返回 true；错误一律抛 HttpError，由调用方转成响应。 */
  async function handleAdmin(req, res, url) {
    const { method } = req;
    const p = url.pathname;

    if (method === 'GET' && p === '/api/admin/events') {
      return sendJSON(res, 200, eventsView(url));
    }

    if (method === 'GET' && p === '/api/admin/keys') {
      return sendJSON(res, 200, { ok: true, keys: localKeys.map(pubKey) });
    }

    if (method === 'GET' && p === '/api/admin/accounts') {
      return sendJSON(res, 200, { ok: true, writable: store.writable(), accounts: accounts.map(pubAccount) });
    }

    const accountMatch = p.match(/^\/api\/admin\/accounts\/([^/]+)$/);
    const keyMatch = p.match(/^\/api\/admin\/keys\/([^/]+)$/);

    if (method === 'POST' && p === '/api/admin/accounts') {
      requireWritable();
      const body = await readJSONBody(req);
      const name = cleanName(body.name);
      const key = cleanAccountKey(body.key);
      if (accounts.some((a) => a.key === key)) throw new HttpError(400, '账号 key 已存在，不能重复添加');
      store.saveAccounts([...credentialAccounts(), { name, key, enabled: body.enabled !== false }]);
      reloadNow();
      const created = accounts.find((a) => a.key === key);
      note('info', `新增账号「${name}」keyId=${created.keyId}（${actorOf(req)}）`);
      return sendJSON(res, 201, { ok: true, account: pubAccount(created) });
    }

    if (method === 'PATCH' && accountMatch) {
      requireWritable();
      const id = decodeURIComponent(accountMatch[1]);
      const target = accounts.find((a) => a.keyId === id);
      if (!target) throw new HttpError(404, '账号不存在');
      const body = await readJSONBody(req);
      if (body.name === undefined && body.enabled === undefined) throw new HttpError(400, '至少要提供 name 或 enabled');
      const name = body.name === undefined ? target.name : cleanName(body.name);
      const enabled = body.enabled === undefined ? target.enabled !== false : !!body.enabled;
      const next = credentialAccounts().map((a) => (a.key === target.key ? { ...a, name, enabled } : a));
      store.saveAccounts(next);
      reloadNow();
      const changed = [body.name !== undefined ? `名称→「${name}」` : null, body.enabled !== undefined ? `状态→${enabled ? '启用' : '停用'}` : null].filter(Boolean);
      note('info', `修改账号 keyId=${id}：${changed.join('、')}（${actorOf(req)}）`);
      return sendJSON(res, 200, { ok: true, account: pubAccount(accounts.find((a) => a.keyId === id)) });
    }

    if (method === 'DELETE' && accountMatch) {
      requireWritable();
      const id = decodeURIComponent(accountMatch[1]);
      const target = accounts.find((a) => a.keyId === id);
      if (!target) throw new HttpError(404, '账号不存在');
      const remaining = credentialAccounts().filter((a) => a.key !== target.key);
      const enabledLeft = remaining.filter((a) => a.enabled !== false).length;
      if (enabledLeft === 0) {
        throw new HttpError(409, remaining.length === 0
          ? '不能删除最后一个账号：删除后账号池为空，所有请求都会失败'
          : '不能删除最后一个可用账号：删除后没有可调度的账号（请先启用其它账号）');
      }
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
      const id = decodeURIComponent(keyMatch[1]);
      const target = localKeys.find((k) => k.keyId === id);
      if (!target) throw new HttpError(404, '客户端 key 不存在');
      store.saveKeys(credentialKeys().filter((k) => k.key !== target.key));
      reloadNow();
      note('info', `删除客户端 key「${target.name}」keyId=${id}（${actorOf(req)}）`);
      return sendJSON(res, 200, { ok: true, keyId: id, keys: localKeys.map(pubKey) });
    }

    throw new HttpError(404, '未知的后台接口');
  }

  // ── 主 HTTP 服务 ───────────────────────────────────────
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    const routeKey = `${req.method} ${url.pathname}`;
    const isProxyRoute = PROXY_ROUTES.has(routeKey);

    res.on('error', () => { /* 客户端断开导致的写错误，忽略 */ });

    // 面板
    if (req.method === 'GET' && url.pathname === '/') {
      const html = readPanel();
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'x-content-type-options': 'nosniff' });
      return res.end(html);
    }

    // 后台管理页（静态 HTML；数据接口在 /api/admin/*）
    if (req.method === 'GET' && (url.pathname === '/admin' || url.pathname === '/admin/')) {
      const html = readAdmin();
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'x-content-type-options': 'nosniff' });
      return res.end(html);
    }

    // 健康检查（无需 key）
    if (req.method === 'GET' && url.pathname === '/health') {
      return sendJSON(res, 200, { ok: true, accounts: accounts.length, available: scheduler.availableCount() });
    }

    if (isProxyRoute) {
      const key = extractKey(req);
      if (!key) return authError(res);

      const isLocal = localKeyIndexOf(key) >= 0;
      const isPassthrough = !isLocal && config.allowPassthrough && key.startsWith(CC_KEY_PREFIX);

      if (!isLocal && !isPassthrough) {
        log.warn(`鉴权失败（不认识的 key: ${keyPrefixOf(key)}***）来自 ${req.socket.remoteAddress}`);
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
        const peeked = await peekBody(req, BODY_PEEK_BYTES).catch(() => ({ chunks: [], ended: false }));
        initialChunks = peeked.chunks;
        bodyEnded = peeked.ended;
        sessionId = peekSessionFromBody(initialChunks);
      }

      const { account, reason } = scheduler.select({ sessionId });
      if (!account) {
        log.warn(`无可用账号，拒绝 ${url.pathname}（${reason}）`);
        return sendJSON(res, 503, { error: { message: 'No available account in pool', type: 'no_available_account' } });
      }
      log.info(`路由 ${url.pathname} → 账号「${account.name}」${sessionId ? `(session ${sessionId})` : ''}`);

      return proxy.forward({ req, res, account, pathname: url.pathname, search: url.search, initialChunks, bodyEnded });
    }

    // 管理 API（本地即可访问；若配置了本地 key 则也需鉴权）
    if (req.method === 'GET' && url.pathname === '/api/status') {
      if (!requireLocalKey(req, res)) return;
      return sendJSON(res, 200, statusView());
    }
    if (req.method === 'GET' && url.pathname === '/api/accounts') {
      if (!requireLocalKey(req, res)) return;
      return sendJSON(res, 200, {
        ok: true,
        accounts: accounts.map((a) => ({ name: a.name, keyId: a.keyId, keyPrefix: a.keyPrefix, enabled: a.enabled })),
      });
    }
    if (req.method === 'POST' && url.pathname === '/api/accounts/refresh') {
      if (!requireLocalKey(req, res)) return;
      await refreshAll();
      return sendJSON(res, 200, { ok: true, ...statusView() });
    }

    // 后台写接口：/api/admin/*（本地 key 鉴权 + 可写校验）
    if (url.pathname.startsWith('/api/admin/')) {
      if (!requireLocalKey(req, res)) return;
      try {
        await handleAdmin(req, res, url);
      } catch (e) {
        if (e instanceof HttpError) return sendJSON(res, e.status, { error: { message: e.message, type: 'admin_error' } });
        log.error(`后台接口异常: ${e.message}`);
        return sendJSON(res, 500, { error: { message: '后台接口内部错误', type: 'admin_error' } });
      }
      return;
    }

    sendJSON(res, 404, { error: { message: 'Not found', type: 'not_found' } });
  });

  function readPanel() {
    return fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  }

  function readAdmin() {
    return fs.readFileSync(path.join(ROOT, 'public', 'admin.html'), 'utf8');
  }

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

  async function stop() {
    if (pollTimer) clearInterval(pollTimer);
    if (recheckTimer) clearInterval(recheckTimer);
    store.saveState();
    try { server.closeAllConnections?.(); } catch { /* 忽略 */ }
    await new Promise((r) => server.close(r));
  }

  return { server, config, log, accounts, localKeys, store, scheduler, stats, refreshAll, statusView, stop, proxy, events, note, reloadNow, syncPool, handleAdmin };
}

/** 预读请求体头部若干字节，并把已读片段原样返回（后续转发时先写出去）。 */
function peekBody(req, limit) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = (ended) => {
      if (done) return;
      done = true;
      resolve({ chunks, ended });
    };
    const onData = (chunk) => {
      // 整块收下（不做 subarray 截断），保证 peek 出去的字节能被原样重放给上游。
      // 代价是最多多读一个 chunk，超出 limit 的部分无关紧要。
      chunks.push(chunk);
      size += chunk.length;
      if (size >= limit) {
        req.pause();
        return finish(false);
      }
      if (req.readableEnded) return finish(true);
    };
    req.on('data', onData);
    req.once('end', () => finish(true));
    req.once('error', () => finish(false));
    req.once('aborted', () => finish(false));
    req.once('close', () => finish(false));
  });
}

// ── 直接运行 ────────────────────────────────────────────
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.join(ROOT, 'gateway.mjs');
if (isMain) {
  const { config, log, server, stop } = await startGateway();
  const addr = server.address();
  log.info(`cc-manage 网关已启动: http://${addr.address}:${addr.port}`);
  log.info(`上游内核: ${config.upstreamProxyUrl} | CC API: ${config.ccApiBase}`);
  const shutdown = async (sig) => {
    log.info(`收到 ${sig}，正在退出…`);
    await stop().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
