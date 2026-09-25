// 测试用假 CC 上游：提供 /alpha/* 额度接口 + /v1/* 假的 OpenAI/Anthropic 响应。
// 支持被测试用例配置（某账号耗尽、记录收到的 authorization 等）。
// 直接 `node mocks/mock-cc-upstream.mjs` 也能起一个独立进程供手工验收。
import http from 'node:http';

const UA_EXPECTED = 'commandcode-cli/1.53.1';

// 允许的 behavior 开关白名单。之前直接 spread，拼错 key（如 failNext500）会静默失效，
// 测试假绿（本仓库实例：gateway.test.mjs 的 failNext500 从未生效）。
const BEHAVIOR_KEYS = new Set([
  'failNext5xx', 'quotaError', 'delayMs', 'rateLimitError', 'quotaErrorKeys', 'quotaErrorBody',
  'notFound404', 'authErrorStatus', 'authErrorBody', 'alphaDelayMs', 'abortAfterChunks',
  'delayBeforeBodyMs', 'bodyBytesSeen', 'immediate5xx', 'chunkDelayMs', 'firstDataAt',
  'usageBody', 'sseChunks', 'generateNdjson',
]);

// ── SPEC §4 标为「必须」的上游契约（真实 CC 上游 + Cloudflare 会拦）──────
//   1. 必须显式带 User-Agent，且不能是会被 CF 拦的默认库 UA（python-urllib / node / undici / go-http-client）；
//   2. 路径必须落在文档化的前缀上（/alpha/* 额度与推理、/v1/* 转发）；
//   3. 鉴权头必须是 `authorization: Bearer user_...`（或等价的 x-api-key）。
// 历史教训：UA_EXPECTED 原先只出现在一句 console.log 里、从不读 req.headers —— 于是
// 「网关漏带 UA」这类问题在 mock 上永远是假绿（同类边界见 test/proxy-403-not-auth.test.mjs 顶部的批注）。
// 现在违约就返回**明确的结构化契约错误**（type=mock_contract_error + 稳定 code），绝不静默通过。
const UA_BLOCKED = [
  /^python-urllib\//i,   // SPEC 点名的被拦 UA
  /^node$/i,              // Node http 默认 UA
  /^undici$/i,            // Node fetch 默认 UA
  /^go-http-client\//i,  // Go 默认 UA（同样没有浏览器签名）
];
const UA_SHAPE = /^[\x20-\x7e]{1,200}$/;   // 显式带且是可打印 ASCII（拒绝空值/控制字符）
// SPEC §4 实测「不带 UA 会被 Cloudflare 拦 403/1010」的是这些额度/推理接口：UA 强制。
const ALPHA_MANDATORY_UA = /^\/alpha\/(whoami|billing\/credits|billing\/subscriptions|usage\/summary|generate)(\?|$)/;
// 真内核（vendor/commandcode-proxy）用 fetch 上报的遥测端点。**发现**：它在这两个 POST 上
// 只设了 Content-Type / Authorization / x-command-code-version，**没设 User-Agent**，
// 于是走 undici 的默认 UA（node）。SPEC 要求显式带 UA，但 vendor 是上游镜像、本仓库不改，
// 所以这里只校验路径与鉴权头形态、不把 UA 当违约（这两个端点不是我们的调用链）。
const ALPHA_TELEMETRY = /^\/alpha\/(fingerprint\/record|lifecycle-events)(\?|$)/;
const V1_ENDPOINT = /^\/v1\/(chat\/completions|messages|responses|models)(\?|$)/;

/**
 * 校验一次请求是否符合 SPEC 的上游契约。
 * @returns {null | {code: string, message: string}} null = 通过；否则是契约错误（code 稳定，便于断言）。
 */
export function checkCcContract(req) {
  const url = String(req.url ?? '');
  const isAlpha = url.startsWith('/alpha/');
  const isV1 = url.startsWith('/v1/');
  if (!isAlpha && !isV1) return null;   // 其它路径本就按 404 处理，不算契约违约

  // UA 契约是 SPEC §4 针对 **CC 上游**定的（Cloudflare 会拦）。
  // mock 的 /v1/* 扮演的是 vendor 内核：网关→内核这一段不经过 Cloudflare，Node fetch
  // （探针）/ undici 这类默认 UA 在这里是合法的，故不校验。
  // /alpha/* 里只对上面 ALPHA_MANDATORY_UA 那些额度/推理接口强制（见常量处的说明）。
  if (isAlpha && ALPHA_MANDATORY_UA.test(url)) {
    const ua = req.headers['user-agent'];
    if (ua === undefined || String(ua).trim() === '') {
      return { code: 'UA_MISSING', message: '缺少 User-Agent（SPEC §4：必须显式带；实测不带会被 Cloudflare 拦成 403 Error 1010）' };
    }
    if (!UA_SHAPE.test(String(ua)) || UA_BLOCKED.some((re) => re.test(String(ua)))) {
      return { code: 'UA_BLOCKED', message: `User-Agent 形态不合法（会被 Cloudflare 拦）：${JSON.stringify(String(ua))}` };
    }
  }

  if (isAlpha && !ALPHA_MANDATORY_UA.test(url) && !ALPHA_TELEMETRY.test(url)) {
    return { code: 'PATH_UNKNOWN', message: `未文档化的 CC 接口路径：${url.split('?')[0]}（必须落在 /alpha/ 下的已知端点上）` };
  }
  if (isV1 && !V1_ENDPOINT.test(url)) {
    return { code: 'PATH_UNKNOWN', message: `未文档化的转发路径：${url.split('?')[0]}` };
  }

  const auth = String(req.headers.authorization ?? '');
  const xKey = String(req.headers['x-api-key'] ?? '');
  if (!/^Bearer\s+user_[\w-]+$/.test(auth) && !/^user_[\w-]+$/.test(xKey)) {
    return {
      code: 'AUTH_SHAPE',
      message: `鉴权头形态不符合契约（需要 authorization: Bearer user_... 或 x-api-key: user_...），实际：${JSON.stringify(auth || xKey)}`,
    };
  }
  return null;
}

/** 校验 behavior patch 里没有未知开关；有则抛错（绝不静默忽略）。 */
export function assertBehaviorKeys(patch) {
  for (const k of Object.keys(patch ?? {})) {
    if (!BEHAVIOR_KEYS.has(k)) {
      throw new Error(`未知的 mock behavior 开关: ${k}（拼错的 key 会静默失效，必须显式报错）`);
    }
  }
}

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

// /alpha/generate 的默认 NDJSON 事件流（形状照 vendor/commandcode-proxy/test/helpers.mjs）：
// 必须有 finish 事件且 outputTokens > 0，否则真内核会按「上游没走完」回 429/502。
const GENERATE_NDJSON = [
  { type: 'text-start' },
  { type: 'text-delta', text: '你好' },
  { type: 'text-delta', text: '，世界' },
  { type: 'text-end' },
  { type: 'finish-step', finishReason: 'stop', usage: { inputTokens: 9, outputTokens: 3 } },
  { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 9, outputTokens: 3, cachedInputTokens: 0 } },
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
  assertBehaviorKeys(opts.behavior);
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
    // 审查 A1：点名某些 key 的 /v1 请求回「额度类 429」（如 weekly limit），用于验证换号重试
    quotaErrorKeys: [],
    quotaErrorBody: '{"error":{"message":"You have reached your weekly limit","type":"quota_exceeded"}}',
    notFound404: false,         // 401/403：key 失效
    authErrorStatus: 0,         // 指定后按该状态码回鉴权错误（401/403）
    authErrorBody: null,        // 覆盖鉴权错误体（H1：模拟内核把上游 403 折叠成 401 + 模型错误文案）
    alphaDelayMs: 0,            // 仅 /alpha/* 接口延迟（后端-M2：额度刷新慢不得阻塞首字节）
    abortAfterChunks: 0,        // 流式：写 N 个 chunk 后直接 destroy 连接（模拟上游中途断）
    delayBeforeBodyMs: 0,       // 收到请求后先等再回响应体
    bodyBytesSeen: [],          // 每次 /v1 实收请求体字节数
    immediate5xx: 0,            // 不等 body 收完就秒回 503（复现「上游秒败 + 客户端还在发 body」）
    chunkDelayMs: 0,            // SSE 分块之间插入延迟（用于客户端中途掐断的用例）
    firstDataAt: null,          // /v1 首次收到**请求体字节**的时间戳（F11 断言用）
    ...(opts.behavior ?? {}),
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // 契约违约记录（测试断言用；403 之外还要能看到「收到过什么」）
  const contractErrors = [];
  // 真内核上报的遥测（见 ALPHA_TELEMETRY 处说明）
  const telemetry = [];
  /** 校验契约；违约就记一笔并回结构化 403，返回 true 表示请求已被拒。 */
  function enforceContract(req, res) {
    const violation = checkCcContract(req);
    if (!violation) return false;
    contractErrors.push({ ...violation, method: req.method, url: req.url, headers: req.headers });
    sendJSON(res, 403, {
      error: {
        message: `mock 契约违约：${violation.message}`,
        type: 'mock_contract_error',
        code: violation.code,
      },
    });
    return true;
  }

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
      if (enforceContract(req, res)) return undefined;
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

      // SPEC 的「必须」契约先校验：违约绝不静默通过（历史上这里从不看 UA，是假绿的源头）
      if (enforceContract(req, res)) return;

      if (behavior.delayMs) await sleep(behavior.delayMs);

      // ── 额度接口 ─────────────────────────────────────────
      if (req.url.startsWith('/alpha/')) {
        if (behavior.alphaDelayMs) await sleep(behavior.alphaDelayMs);
        const auth = req.headers.authorization ?? '';
        const key = auth.startsWith('Bearer ') ? auth.slice(7) : '';
        if (!key.startsWith('user_')) {
          return sendJSON(res, 401, { error: { message: 'invalid key' } });
        }
        const plan = plans.get(key);
        if (!plan) return sendJSON(res, 401, { error: { message: 'unknown key' } });
        if (plan.authInvalid) return sendJSON(res, 401, { error: { message: 'key revoked' } });

        const path = req.url.split('?')[0];
        // 真内核的遥测上报（fingerprint / lifecycle）：真 CC 会收，这里也给 200，
        // 否则内核每次启动都会在日志里刷 "Lifecycle event failed { status: 403 }" 的噪音。
        if (path === '/alpha/fingerprint/record' || path === '/alpha/lifecycle-events') {
          telemetry.push({ path, body: bodyText, headers: req.headers });
          return sendJSON(res, 200, { ok: true });
        }
        // 真实内核的推理入口：CC 回的是一行一个 JSON 事件（NDJSON），
        // vendor/commandcode-proxy 按行解析成 text-delta / finish 等事件再翻译。
        if (path === '/alpha/generate') {
          const lines = Array.isArray(behavior.generateNdjson) ? behavior.generateNdjson : GENERATE_NDJSON;
          res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-cache' });
          for (const line of lines) {
            res.write(`${typeof line === 'string' ? line : JSON.stringify(line)}\n`);
          }
          return res.end();
        }
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
        if (Array.isArray(behavior.quotaErrorKeys) && behavior.quotaErrorKeys.includes(v1Key)) {
          let body = { error: { message: 'You have reached your weekly limit', type: 'quota_exceeded' } };
          try { body = JSON.parse(behavior.quotaErrorBody); } catch { /* 用默认体 */ }
          return sendJSON(res, 429, body);
        }
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
          return sendJSON(res, behavior.authErrorStatus,
            behavior.authErrorBody ?? { error: { message: 'invalid api key', type: 'authentication_error' } });
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

  await new Promise((resolve) => server.listen(opts.port ?? 0, opts.host ?? '127.0.0.1', resolve));
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
      assertBehaviorKeys(patch);
      Object.assign(behavior, patch);
    },
    requestsTo(predicate) {
      return seen.filter(predicate);
    },
    contractErrors,   // 契约违约记录（{code, message, method, url, headers}）
    telemetry,        // 真内核的遥测上报（/alpha/fingerprint/record、/alpha/lifecycle-events）
    checkContract: (req) => checkCcContract(req),
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
  // 默认只绑回环（手工联调用）；容器里当上游时必须绑 0.0.0.0，
  // 否则同网容器（core）连不上（scripts/smoke.sh 就是这么用的）。
  const host = process.env.MOCK_HOST ?? '127.0.0.1';
  const mock = await startMockUpstream({ port, host });
  console.log(`[mock-cc-upstream] 假 CC 上游已监听 http://${host}:${port}`);
  console.log(`[mock-cc-upstream] 额度接口 /alpha/*（含 /alpha/generate NDJSON），转发接口 /v1/*`);
  console.log(`[mock-cc-upstream] 强制契约：UA 必须显式且非默认库 UA（期望形态 ${UA_EXPECTED}）、路径前缀、鉴权头 Bearer user_...`);
  console.log(`[mock-cc-upstream] 演示账号: ${[...Object.keys(DEFAULT_PLANS)].join(', ')}`);
}
