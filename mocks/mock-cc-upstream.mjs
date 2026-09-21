// 测试用假 CC 上游：提供 /alpha/* 额度接口 + /v1/* 假的 OpenAI/Anthropic 响应。
// 支持被测试用例配置（某账号耗尽、记录收到的 authorization 等）。
// 直接 `node mocks/mock-cc-upstream.mjs` 也能起一个独立进程供手工验收。
import http from 'node:http';

const UA_EXPECTED = 'commandcode-cli/1.53.1';

// key → 该 key 的额度设定
// exhausted: true 表示 5h 窗口已打满
const DEFAULT_PLANS = {
  'user_demo_alpha': { name: '演示账号A', monthlyCredits: 42.5, purchasedCredits: 10, freeCredits: 2.5, fiveHour: { used: 12, cap: 100 }, weekly: { used: 40, cap: 500 }, totalCost: 7.5, totalTokens: 12000 },
  'user_demo_beta': { name: '演示账号B', monthlyCredits: 8, purchasedCredits: 0, freeCredits: 0, fiveHour: { used: 88, cap: 100 }, weekly: { used: 480, cap: 500 }, totalCost: 1.2, totalTokens: 3000 },
  'user_demo_gamma': { name: '演示账号C', monthlyCredits: 0, purchasedCredits: 0, freeCredits: 0, fiveHour: { used: 100, cap: 100 }, weekly: { used: 500, cap: 500 }, totalCost: 9.9, totalTokens: 4000 },
  // 测试用账号（与 test/helpers.mjs 的默认账号对应）
  'user_test_alpha': { name: '测试账号A', monthlyCredits: 42.5, purchasedCredits: 10, freeCredits: 2.5, fiveHour: { used: 12, cap: 100 }, weekly: { used: 40, cap: 500 }, totalCost: 7.5, totalTokens: 12000 },
  'user_test_beta': { name: '测试账号B', monthlyCredits: 8, purchasedCredits: 0, freeCredits: 0, fiveHour: { used: 88, cap: 100 }, weekly: { used: 480, cap: 500 }, totalCost: 1.2, totalTokens: 3000 },
};

const SSE_CHUNKS = [
  { id: 'chatcmpl-mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: '你好' } }] },
  { id: 'chatcmpl-mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: '，世界' } }] },
  { id: 'chatcmpl-mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { total_tokens: 12 } },
];

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

/**
 * 把一个 plan 覆盖合并到基础设定上：顶层深合并一层，fiveHour / weekly 再合并一层。
 * 必须是深合并 —— 浅合并下「只改 5h 窗口」的用例会把该账号的 monthlyCredits /
 * totalCost 一并抹掉，而月窗口是 totalCost + remaining 推算的，会直接变 null。
 */
function mergePlan(base, override) {
  const out = { ...base, ...override };
  for (const w of ['fiveHour', 'weekly']) {
    if (base[w] || override[w]) out[w] = { ...(base[w] ?? {}), ...(override[w] ?? {}) };
  }
  return out;
}

/**
 * 启动 mock 上游。
 * @returns {Promise<{server, port, url, seen, setPlan, setBehavior, close}>}
 */
export async function startMockUpstream(opts = {}) {
  // 传入的 plans 覆盖默认设定（默认设定里含 §9 面板演示账号与测试账号）
  const plans = new Map(Object.entries(DEFAULT_PLANS));
  for (const [key, override] of Object.entries(opts.plans ?? {})) {
    plans.set(key, mergePlan(plans.get(key) ?? {}, override));
  }
  const seen = []; // 每个请求的 { method, url, headers, body }
  const behavior = {
    failNext5xx: 0, quotaError: false, delayMs: 0,
    // 测试用开关（默认全关，不影响既有用例）
    rateLimitError: false,      // 429 普通限流
    notFound404: false,         // 401/403：key 失效
    authErrorStatus: 0,         // 指定后按该状态码回鉴权错误（401/403）
    abortAfterChunks: 0,        // 流式：写 N 个 chunk 后直接 destroy 连接（模拟上游中途断）
    delayBeforeBodyMs: 0,       // 收到请求后先等再回响应体
    bodyBytesSeen: [],          // 每次 /v1 实收请求体字节数
    immediate5xx: 0,            // 不等 body 收完就秒回 503（复现「上游秒败 + 客户端还在发 body」）
    chunkDelayMs: 0,            // SSE 分块之间插入延迟（用于客户端中途掐断的用例）
    firstDataAt: null,          // /v1 首次收到**请求体字节**的时间戳（F11 断言用）
    ...(opts.behavior ?? {}),
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const server = http.createServer((req, res) => {
    const chunks = [];
    let received = 0;
    const isV1 = () => req.url.startsWith('/v1/');
    // 秒回失败：连 body 都不等（复现「上游第 1 次秒回 5xx，客户端还在慢慢发 body」）
    if (behavior.immediate5xx > 0 && isV1()) {
      behavior.immediate5xx--;
      req.on('data', (c) => { received += c.length; });
      req.on('end', () => {});
      req.resume();
      if (behavior.firstDataAt === null) behavior.firstDataAt = Date.now();
      // 不往 bodyBytesSeen 里塞：这里根本没收 body，塞 0 会与「上游实收字节」的语义混淆
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: '' });
      return sendJSON(res, 503, { error: { message: 'mock upstream busy' } });
    }
    req.on('data', (c) => {
      received += c.length;
      // F11：记录上游**首次收到请求体字节**的时刻。网关若等 body 收完才连接/转发，
      // 这个时刻会≈客户端把 body 发完的时刻。
      if (behavior.firstDataAt === null && isV1()) behavior.firstDataAt = Date.now();
      chunks.push(c);
    });
    req.on('end', async () => {
      const bodyText = Buffer.concat(chunks).toString('utf8');
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: bodyText });

      if (behavior.delayMs) await sleep(behavior.delayMs);

      // ── 额度接口 ─────────────────────────────────────────
      if (req.url.startsWith('/alpha/')) {
        const auth = req.headers.authorization ?? '';
        const key = auth.startsWith('Bearer ') ? auth.slice(7) : '';
        if (!key.startsWith('user_')) {
          return sendJSON(res, 401, { error: { message: 'invalid key' } });
        }
        const plan = plans.get(key);
        if (!plan) return sendJSON(res, 401, { error: { message: 'unknown key' } });
        if (plan.authInvalid) return sendJSON(res, 401, { error: { message: 'key revoked' } });

        const path = req.url.split('?')[0];
        if (path === '/alpha/whoami') {
          return sendJSON(res, 200, {
            org: { login: plan.name ?? 'mock-org', id: `org-${key.slice(5, 10)}` },
            user: { userName: plan.name ?? 'mock-user', keyName: 'mock-key' },
          });
        }
        if (path === '/alpha/billing/credits') {
          const nowSec = Math.floor(Date.now() / 1000);
          return sendJSON(res, 200, {
            credits: {
              monthlyCredits: plan.monthlyCredits ?? 0,
              purchasedCredits: plan.purchasedCredits ?? 0,
              freeCredits: plan.freeCredits ?? 0,
            },
            windowLimits: {
              limited: true,
              // 上游的权威「哪个窗口超了」标记（实测真实报文里是窗口名字符串）
              exceeded: plan.exceeded ?? null,
              fiveHour: {
                used: plan.fiveHour?.used ?? 0, cap: plan.fiveHour?.cap ?? 100,
                resetAt: plan.fiveHour?.resetAt ?? nowSec + 3600,
                exceeded: plan.fiveHour?.exceeded === true,
              },
              weekly: {
                used: plan.weekly?.used ?? 0, cap: plan.weekly?.cap ?? 500,
                resetAt: plan.weekly?.resetAt ?? nowSec + 86400,
                exceeded: plan.weekly?.exceeded === true,
              },
            },
          });
        }
        if (path === '/alpha/billing/subscriptions') {
          return sendJSON(res, 200, {
            data: {
              planId: plan.planId ?? 'mock-plan', status: 'active',
              // 周期起止可由 plans 覆盖（默认值保持原样），供「月窗口重置时间」用例固定时间点
              currentPeriodStart: plan.currentPeriodStart ?? '2026-09-01T00:00:00Z',
              currentPeriodEnd: plan.currentPeriodEnd ?? '2026-10-01T00:00:00Z',
            },
          });
        }
        if (path === '/alpha/usage/summary') {
          return sendJSON(res, 200, { totalCost: plan.totalCost ?? 0, totalCount: plan.totalCount ?? 5, totalTokens: plan.totalTokens ?? 100 });
        }
        return sendJSON(res, 404, { error: { message: 'not found' } });
      }

      // ── 转发接口 ─────────────────────────────────────────
      if (req.url.startsWith('/v1/')) {
        behavior.bodyBytesSeen.push(received);
        // 按账号模拟「余额不足」：真实上游是 HTTP 400 + 这段措辞（不是 402、不是 429）
        const v1Auth = req.headers.authorization ?? '';
        const v1Key = v1Auth.startsWith('Bearer ') ? v1Auth.slice(7) : (req.headers['x-api-key'] ?? '');
        const v1Plan = v1Key ? plans.get(v1Key) : null;
        if (v1Plan?.creditsExhausted) {
          return sendJSON(res, 400, {
            error: {
              message: 'You have insufficient credits to make this request. Please purchase more credits to continue using the service.',
              type: 'invalid_request_error',
              code: 'BAD_REQUEST',
            },
          });
        }
        if (behavior.authErrorStatus) {
          return sendJSON(res, behavior.authErrorStatus, { error: { message: 'invalid api key', type: 'authentication_error' } });
        }
        if (behavior.notFound404) {
          return sendJSON(res, 404, { error: { message: 'unknown key', type: 'not_found' } });
        }
        if (behavior.rateLimitError) {
          return sendJSON(res, 429, { error: { message: 'Rate limit exceeded, retry later', type: 'rate_limit' } });
        }
        if (behavior.failNext5xx > 0) {
          behavior.failNext5xx--;
          return sendJSON(res, 503, { error: { message: 'mock upstream busy' } });
        }
        if (behavior.quotaError) {
          return sendJSON(res, 402, { error: { message: 'monthly quota exceeded', type: 'quota_exceeded' } });
        }
        if (req.url.includes('/v1/models')) {
          return sendJSON(res, 200, { object: 'list', data: [{ id: 'mock-model', object: 'model' }] });
        }
        // 可配置的用量响应（供 token 统计用例）：usageBody → 非流式 JSON；sseChunks → 自定义流式分块
        if (behavior.usageBody) {
          const body = JSON.stringify(behavior.usageBody);
          res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
          return res.end(body);
        }
        if (Array.isArray(behavior.sseChunks)) {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
          for (const c of behavior.sseChunks) {
            res.write(`data: ${JSON.stringify(c)}\n\n`);
            if (behavior.chunkDelayMs) await sleep(behavior.chunkDelayMs);
          }
          res.write('data: [DONE]\n\n');
          return res.end();
        }
        if (behavior.abortAfterChunks > 0) {
          // 模拟上游中途断开（重启 / 网络抖动 / 内核被 OOM kill）：
          // 只写出前 N 个 chunk 就 destroy，不发 [DONE]、不 end()
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
          for (let i = 0; i < behavior.abortAfterChunks; i++) {
            res.write(`data: ${JSON.stringify({ id: 'chatcmpl-mock', choices: [{ index: 0, delta: { content: `partial-${i + 1}` } }] })}\n\n`);
          }
          setTimeout(() => { try { res.destroy(); } catch { /* 忽略 */ } }, 10);
          return undefined;
        }
        // 默认：3 个 SSE chunk + [DONE]
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        for (const c of SSE_CHUNKS) {
          res.write(`data: ${JSON.stringify(c)}\n\n`);
          if (behavior.chunkDelayMs) await sleep(behavior.chunkDelayMs);
        }
        res.write('data: [DONE]\n\n');
        return res.end();
      }

      sendJSON(res, 404, { error: { message: 'not found' } });
    });
  });

  await new Promise((resolve) => server.listen(opts.port ?? 0, '127.0.0.1', resolve));
  const port = server.address().port;

  return {
    server,
    port,
    url: `http://127.0.0.1:${port}`,
    seen,
    behavior,
    setPlan(key, plan) {
      plans.set(key, mergePlan(plans.get(key) ?? {}, plan));
    },
    setBehavior(patch) {
      Object.assign(behavior, patch);
    },
    requestsTo(predicate) {
      return seen.filter(predicate);
    },
    async close() {
      try { server.closeAllConnections?.(); } catch {}
      await new Promise((r) => server.close(r));
    },
  };
}

// 直接运行时起一个独立 mock 服务（供 §9 手工验收）
const isMain = process.argv[1] && process.argv[1].endsWith('mock-cc-upstream.mjs');
if (isMain) {
  const port = Number(process.env.MOCK_PORT ?? 3099);
  const mock = await startMockUpstream({ port });
  console.log(`[mock-cc-upstream] 假 CC 上游已监听 http://127.0.0.1:${port}`);
  console.log(`[mock-cc-upstream] 额度接口 /alpha/*，转发接口 /v1/*，UA 期望 ${UA_EXPECTED}`);
  console.log(`[mock-cc-upstream] 演示账号: ${[...Object.keys(DEFAULT_PLANS)].join(', ')}`);
}
