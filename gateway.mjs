// cc-manage 入口：HTTP 服务 + 路由（多账号反代 + 额度面板 API）
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './src/config.mjs';
import { createStore, CC_KEY_PREFIX } from './src/store.mjs';
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

  const store = createStore({ rootDir: overrides.rootDir ?? ROOT, env: overrides.env ?? process.env, log });
  const accounts = store.loadAccounts();
  const localKeys = store.loadKeys();
  store.loadState();

  for (const a of accounts) log.registerSecret(a.key);
  for (const k of localKeys) log.registerSecret(k.key);
  const secrets = [...accounts.map((a) => a.key), ...localKeys.map((k) => k.key)];

  log.info(`已加载 ${accounts.length} 个 CC 账号、${localKeys.length} 个本地 key`);

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

  function localKeyIndexOf(key) {
    return localKeys.findIndex((k) => k.key === key);
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

  // ── 主 HTTP 服务 ───────────────────────────────────────
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    const routeKey = `${req.method} ${url.pathname}`;
    const isProxyRoute = PROXY_ROUTES.has(routeKey);

    res.on('error', () => { /* 客户端断开导致的写错误，忽略 */ });

    // 面板
    if (req.method === 'GET' && url.pathname === '/') {
      const html = readPanel();
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
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
      if (config.protectAdminApi && localKeys.length > 0 && localKeyIndexOf(extractKey(req)) < 0) return authError(res);
      return sendJSON(res, 200, statusView());
    }
    if (req.method === 'GET' && url.pathname === '/api/accounts') {
      if (config.protectAdminApi && localKeys.length > 0 && localKeyIndexOf(extractKey(req)) < 0) return authError(res);
      return sendJSON(res, 200, {
        ok: true,
        accounts: accounts.map((a) => ({ name: a.name, keyId: a.keyId, keyPrefix: a.keyPrefix, enabled: a.enabled })),
      });
    }
    if (req.method === 'POST' && url.pathname === '/api/accounts/refresh') {
      if (config.protectAdminApi && localKeys.length > 0 && localKeyIndexOf(extractKey(req)) < 0) return authError(res);
      await refreshAll();
      return sendJSON(res, 200, { ok: true, ...statusView() });
    }

    sendJSON(res, 404, { error: { message: 'Not found', type: 'not_found' } });
  });

  function readPanel() {
    return fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
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
        log.info(`首次额度刷新完成：${ok}/${rs.length} 个账号成功`);
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

  return { server, config, log, accounts, localKeys, store, scheduler, stats, refreshAll, statusView, stop, proxy };
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
