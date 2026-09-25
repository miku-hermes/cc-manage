// 批次18：运维/CI 三条 high 的行为回归 —— readiness 探针 / mock 强制契约 / 真内核集成。
//
// ①【high】/health 不探上游 → core 挂了容器仍报 healthy：
//    /health 保持 liveness 语义与响应体**完全不变**；新增 /ready 真探上游 core
//    （2s 硬超时 + 1s 结果缓存，取值理由见 gateway.mjs 里的注释）。
// ③【high】网关与真实 vendor 内核之间零集成测试；mock 连 SPEC 标「必须」的
//    User-Agent 契约都不校验：
//    mock 现在对 /alpha/* 强制校验 UA / 路径前缀 / 鉴权头形态，违约回结构化契约错误；
//    另有两条**真 vendor 内核**在链路上的集成测试（mock CC → 真内核 → 网关，
//    非流式 + 流式各一条）。内核起不来时明确 skip 并打印原因，绝不删测试。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startMockUpstream } from '../mocks/mock-cc-upstream.mjs';
import { startProxy } from '../vendor/commandcode-proxy/test/helpers.mjs';
import { allocPort, request, sleep, startTestGateway } from './helpers.mjs';

/**
 * 可控假上游（扮演 core）：同一条测试里切换「可达 / 5xx / 直接断连 / 挂住不答」。
 * 刻意不写「关掉真 mock 再在同一端口拉起来」——那要靠端口复用撞运气，并行跑必闪红。
 */
async function startControllableCore() {
  const state = { mode: 'ok' };
  const openSockets = new Set();
  const server = http.createServer((req, res) => {
    if (state.mode === 'hang') { openSockets.add(req.socket); return; }   // 不写响应，一直挂着
    if (state.mode === 'drop') { req.socket.destroy(); return; }         // core 崩溃：连接被重置
    if (state.mode === 'error') { res.writeHead(503, { 'content-type': 'text/plain' }); return res.end('down'); }
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end('OK');
  });
  const port = await allocPort();
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    state,
    async close() {
      for (const s of openSockets) { try { s.destroy(); } catch { /* 忽略 */ } }
      try { server.closeAllConnections?.(); } catch { /* 忽略 */ }
      await new Promise((r) => server.close(r));
    },
  };
}

/** 起一个网关，上游指向给定 url（不起 mock 上游）。 */
function gatewayWithUpstream(url) {
  return startTestGateway({
    deps: { startUpstream: async () => ({ url, close: async () => {} }) },
    config: {},
  });
}

/**
 * 真链路：mock CC 上游 → **真 vendor 内核**（spawn，动态端口）→ 网关。
 * 环境起不来内核时不抛错，返回 { skip: 原因 } 交给调用方 t.skip()。
 */
async function startRealChain() {
  let mock;
  let proxy;
  try {
    mock = await startMockUpstream();
    proxy = await startProxy({ upstreamPort: mock.port });
  } catch (e) {
    try { await proxy?.kill?.(); } catch { /* 忽略 */ }
    try { await mock?.close?.(); } catch { /* 忽略 */ }
    return { skip: `真 vendor 内核在本环境无法启动：${String(e?.message ?? e).split('\n')[0]}` };
  }
  let ctx;
  try {
    ctx = await startTestGateway({
      deps: { startUpstream: async () => ({ url: proxy.base, close: async () => {} }) },
      config: { ccApiBase: mock.url },
    });
  } catch (e) {
    try { await proxy.kill(); } catch { /* 忽略 */ }
    try { await mock.close(); } catch { /* 忽略 */ }
    throw e;
  }
  return {
    mock,
    proxy,
    ctx,
    async close() {
      await ctx.close().catch(() => {});
      await proxy.kill().catch(() => {});
      await mock.close().catch(() => {});
    },
  };
}

const chatBody = (extra = {}) => JSON.stringify({
  model: 'mock-model', stream: false, messages: [{ role: 'user', content: 'hi' }], ...extra,
});

// ── ① /ready：可达 / 不可达 / 恢复 / 挂住不答 ──────────────────────────

test('B18-/ready：上游可达 → 200 且 upstream=up', async (t) => {
  const ctx = await startTestGateway();          // 真 mock 上游（/health 回 404，也算「在应答」）
  t.after(() => ctx.close());

  const res = await request(`${ctx.baseUrl}/ready`);
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.upstream, 'up');
  assert.equal(body.accounts, 2, '/ready 也要给面板口径（accounts/available）');
  assert.equal(body.available, 2);
});

test('B18-/ready：上游指向死端口 → 503 且 upstream=down', async (t) => {
  const ctx = await gatewayWithUpstream('http://127.0.0.1:1');   // 无人监听
  t.after(() => ctx.close());

  const res = await request(`${ctx.baseUrl}/ready`);
  assert.equal(res.status, 503);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, false);
  assert.equal(body.upstream, 'down');
  assert.equal(body.accounts, 2, '503 也要保持响应体形状一致');
});

test('B18-/ready：上游 5xx / 断连 → 503，恢复后回到 200', async (t) => {
  const core = await startControllableCore();
  t.after(() => core.close());
  const ctx = await gatewayWithUpstream(core.url);
  t.after(() => ctx.close());

  let res = await request(`${ctx.baseUrl}/ready`);
  assert.equal(res.status, 200, '上游正常时要 200');

  // 1) core 进程活着但已不健康（5xx）→ 必须 503
  core.state.mode = 'error';
  await sleep(1100);                              // 跨过 1s 结果缓存
  res = await request(`${ctx.baseUrl}/ready`);
  assert.equal(res.status, 503, 'core 回 5xx 时必须判为不可达');
  assert.equal(JSON.parse(res.body).upstream, 'down');

  // 2) 断连（core 崩溃/OOM kill 的形态）→ 同样 503
  core.state.mode = 'drop';
  await sleep(1100);
  res = await request(`${ctx.baseUrl}/ready`);
  assert.equal(res.status, 503, '连接被重置时必须判为不可达');
  assert.equal(JSON.parse(res.body).upstream, 'down');

  // 3) 恢复 → 回到 200（缓存不能让状态永远卡在 down）
  core.state.mode = 'ok';
  await sleep(1100);
  res = await request(`${ctx.baseUrl}/ready`);
  assert.equal(res.status, 200, 'core 恢复后必须回到 200');
  assert.equal(JSON.parse(res.body).upstream, 'up');
});

test('B18-/ready：上游挂住不答 → 在有限时间内 503，不无限等', async (t) => {
  const core = await startControllableCore();
  core.state.mode = 'hang';                       // accept 了连接但永不回响应
  t.after(() => core.close());
  const ctx = await gatewayWithUpstream(core.url);
  t.after(() => ctx.close());

  const started = Date.now();
  const res = await request(`${ctx.baseUrl}/ready`);
  const elapsed = Date.now() - started;
  assert.equal(res.status, 503, '挂住不答必须按不可达处理');
  assert.equal(JSON.parse(res.body).upstream, 'down');
  assert.ok(elapsed >= 1500, `必须真的等到探测超时（默认 2s），实际 ${elapsed}ms —— 太快说明根本没探上游`);
  assert.ok(elapsed < 4000, `探测必须有硬上界（默认 2s），实际 ${elapsed}ms`);
});

test('B18-/health：liveness 语义与响应体不变，且刻意不探上游', async (t) => {
  // 上游是死端口：/health 仍必须 200（liveness），/ready 必须 503（readiness）——
  // 两者分离正是本次修复的核心，任何「把 /health 也改成探上游」的改动都会让这条红。
  const ctx = await gatewayWithUpstream('http://127.0.0.1:1');
  t.after(() => ctx.close());

  const health = await request(`${ctx.baseUrl}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(JSON.parse(health.body), { ok: true, accounts: 2, available: 2 });

  assert.equal((await request(`${ctx.baseUrl}/ready`)).status, 503);
});

// ── ③ mock 强制 SPEC 契约（UA / 路径前缀 / 鉴权头形态）────────────────

test('B18-mock：/alpha 请求缺 User-Agent → 明确的契约错误（不再静默放行）', async (t) => {
  const mock = await startMockUpstream();
  t.after(() => mock.close());

  // Node 的 http.request 默认不加 User-Agent —— 正好复现「漏带 UA」。
  const res = await request(`${mock.url}/alpha/whoami`, { headers: { authorization: 'Bearer user_test_alpha' } });
  assert.equal(res.status, 403, '违约必须是非 2xx 的明确错误，不能静默通过');
  const body = JSON.parse(res.body);
  assert.equal(body.error.type, 'mock_contract_error');
  assert.equal(body.error.code, 'UA_MISSING');
  assert.equal(mock.contractErrors.length, 1);
  assert.equal(mock.contractErrors[0].code, 'UA_MISSING');

  // 带上 UA 的同一条请求必须正常通过（证明拦的是 UA 而不是别的）
  const ok = await request(`${mock.url}/alpha/whoami`, {
    headers: { authorization: 'Bearer user_test_alpha', 'user-agent': 'commandcode-cli/1.53.1' },
  });
  assert.equal(ok.status, 200);
  assert.equal(mock.contractErrors.length, 1, '合规请求不能再记违约');
});

test('B18-mock：被 CF 拦的默认库 UA / 鉴权头形态错 / 未文档化路径 → 各自报码', async (t) => {
  const mock = await startMockUpstream();
  t.after(() => mock.close());

  const check = async (path, headers) => {
    const res = await request(`${mock.url}${path}`, { headers });
    assert.equal(res.status, 403, `${path} 应回 403 契约错误`);
    return JSON.parse(res.body).error;
  };

  // SPEC §4 点名的 python-urllib 默认 UA（Cloudflare 会拦成 403/1010）
  assert.equal((await check('/alpha/whoami', {
    authorization: 'Bearer user_test_alpha', 'user-agent': 'python-urllib/3.11',
  })).code, 'UA_BLOCKED');

  // 鉴权头形态：不是 Bearer user_...（sk-cg- 是网关本地 key，绝不能透传给 CC）
  assert.equal((await check('/alpha/billing/credits', {
    authorization: 'Bearer sk-cg-leaked', 'user-agent': 'commandcode-cli/1.53.1',
  })).code, 'AUTH_SHAPE');

  // 路径前缀：/alpha 下未文档化的端点
  assert.equal((await check('/alpha/not-a-real-endpoint', {
    authorization: 'Bearer user_test_alpha', 'user-agent': 'commandcode-cli/1.53.1',
  })).code, 'PATH_UNKNOWN');

  assert.equal(mock.contractErrors.length, 3, '三次违约都要被记下来');
});

test('B18-mock：真实网关的 /alpha 与 /v1 流量零契约违约', async (t) => {
  const ctx = await startTestGateway();
  t.after(() => ctx.close());

  await ctx.gateway.refreshAll();                 // /alpha/*（quota.mjs 的额度查询）
  const res = await request(`${ctx.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ctx.localKey}`, 'content-type': 'application/json' },
    body: chatBody(),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(ctx.upstream.contractErrors, [],
    `生产代码自己发的请求不该违约，实际：${JSON.stringify(ctx.upstream.contractErrors)}`);
});

// ── ③ 真 vendor 内核在链路上（非流式 / 流式）─────────────────────────

test('B18-集成：mock CC → 真内核 → 网关，非流式往返 + usage 透传', async (t) => {
  const chain = await startRealChain();
  if (chain.skip) {
    console.error(`[ops-b18] ${chain.skip}`);
    return t.skip(chain.skip);
  }
  try {
    const res = await request(`${chain.ctx.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${chain.ctx.localKey}`, 'content-type': 'application/json' },
      body: chatBody(),
    });
    assert.equal(res.status, 200, `真内核链路必须能跑通，实际 ${res.status} ${res.body.slice(0, 200)}`);
    const json = JSON.parse(res.body);
    assert.equal(json.object, 'chat.completion');
    assert.match(json.choices[0].message.content, /你好，世界/, '内容必须从 CC NDJSON 一路翻译到 OpenAI JSON');
    assert.equal(json.usage.prompt_tokens, 9, 'usage 必须透传（prompt）');
    assert.equal(json.usage.completion_tokens, 3, 'usage 必须透传（completion）');
    assert.equal(json.usage.total_tokens, 12, 'usage 必须透传（total）');
    assert.ok(chain.ctx.gateway.stats.totalTokens >= 12,
      `令牌统计也要吃到这次用量，实际 ${chain.ctx.gateway.stats.totalTokens}`);

    // 真内核对 CC 的请求必须符合 SPEC 契约（显式 UA + Bearer 账号 key）
    const gen = chain.mock.requestsTo((r) => r.url === '/alpha/generate');
    assert.equal(gen.length, 1, '真内核应当只对 CC 打一次 /alpha/generate');
    assert.equal(gen[0].headers.authorization, 'Bearer user_test_alpha');
    assert.ok(gen[0].headers['user-agent'], 'SPEC 要求必须显式带 UA');
    assert.deepEqual(chain.mock.contractErrors, [], '真内核的请求也不得违约');
  } finally {
    await chain.close();
  }
});

test('B18-集成：mock CC → 真内核 → 网关，流式往返（SSE 多个 chunk）', async (t) => {
  const chain = await startRealChain();
  if (chain.skip) {
    console.error(`[ops-b18] ${chain.skip}`);
    return t.skip(chain.skip);
  }
  try {
    const res = await request(`${chain.ctx.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${chain.ctx.localKey}`, 'content-type': 'application/json' },
      body: chatBody({ stream: true }),
    });
    assert.equal(res.status, 200, `真内核流式链路必须能跑通，实际 ${res.status} ${res.body.slice(0, 200)}`);
    assert.equal(res.headers['content-type'], 'text/event-stream');

    const events = res.body.split('\n\n').filter((s) => s.startsWith('data: '));
    assert.ok(events.length > 2, `SSE 必须分成多个 chunk（不是一次性吐出），实际 ${events.length}`);
    assert.ok(events.some((e) => e.includes('你好')), '内容必须逐块透传');
    assert.equal(events[events.length - 1], 'data: [DONE]', '流必须以 [DONE] 正常收尾');
    assert.equal(chain.mock.requestsTo((r) => r.url === '/alpha/generate').length, 1);
  } finally {
    await chain.close();
  }
});
