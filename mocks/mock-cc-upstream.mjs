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
 * 启动 mock 上游。
 * @returns {Promise<{server, port, url, seen, setPlan, setBehavior, close}>}
 */
export async function startMockUpstream(opts = {}) {
  // 传入的 plans 覆盖默认设定（默认设定里含 §9 面板演示账号与测试账号）
  const plans = new Map(Object.entries({ ...DEFAULT_PLANS, ...(opts.plans ?? {}) }));
  const seen = []; // 每个请求的 { method, url, headers, body }
  const behavior = { failNext5xx: 0, quotaError: false, delayMs: 0, ...(opts.behavior ?? {}) };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const bodyText = Buffer.concat(chunks).toString('utf8');
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: bodyText });

      if (behavior.delayMs) await new Promise((r) => setTimeout(r, behavior.delayMs));

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
              fiveHour: { used: plan.fiveHour?.used ?? 0, cap: plan.fiveHour?.cap ?? 100, resetAt: plan.fiveHour?.resetAt ?? nowSec + 3600 },
              weekly: { used: plan.weekly?.used ?? 0, cap: plan.weekly?.cap ?? 500, resetAt: plan.weekly?.resetAt ?? nowSec + 86400 },
            },
          });
        }
        if (path === '/alpha/billing/subscriptions') {
          return sendJSON(res, 200, {
            data: { planId: plan.planId ?? 'mock-plan', status: 'active', currentPeriodStart: '2026-09-01T00:00:00Z', currentPeriodEnd: '2026-10-01T00:00:00Z' },
          });
        }
        if (path === '/alpha/usage/summary') {
          return sendJSON(res, 200, { totalCost: plan.totalCost ?? 0, totalCount: plan.totalCount ?? 5, totalTokens: plan.totalTokens ?? 100 });
        }
        return sendJSON(res, 404, { error: { message: 'not found' } });
      }

      // ── 转发接口 ─────────────────────────────────────────
      if (req.url.startsWith('/v1/')) {
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
        // 默认：3 个 SSE chunk + [DONE]
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        for (const c of SSE_CHUNKS) res.write(`data: ${JSON.stringify(c)}\n\n`);
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
      plans.set(key, { ...(plans.get(key) ?? {}), ...plan });
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
