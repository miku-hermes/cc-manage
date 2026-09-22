// 回归：上游 403（模型名错/套餐不含）被内核折叠成 401 后，网关不得误判为「鉴权失效」
// → 有效副号被停调、整池 503（2026-09-22 线上事故）。
//
// 关键前提（H1）：vendor/commandcode-proxy 的 CC_STATUS_MAP 把上游 403 折叠成
//   401 + type:"authentication_error" + message `Model/provider not recognized: ...`
//   / `MODEL_NOT_IN_PLAN: ... available in ... plans`
// 也就是说**生产里网关看不到 403**，只在 401 分支就能收到这两类文案。因此 fixture 必须
// 模拟「内核折叠后」的形态（401 + authentication_error + 模型错误文案），而不是上游原始 403
// —— 旧的 403 fixture 走的是生产不可达的 403 分支，是假绿。
//
// 真·key 失效是 401 `Invalid 'Authorization' header or token` / `invalid api key` / revoked。
//
// 约定：这些用例在**未修复**的源码上必须变红（mutation check）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import { startGateway } from '../gateway.mjs';
import { allocPort, makeTmpDir, writeAccountFiles, request, closeServer } from './helpers.mjs';

const ACCOUNTS = [
  { name: '主号', key: 'user_test_alpha' },
  { name: '副号1', key: 'user_test_beta' },
];
const KEYS = [{ name: '测试客户端', key: 'sk-cg-testkey123' }];

const json = (res, status, body) => {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
};

/** 最小可注入上游：/v1/* 按指定 status + body 回复；/alpha/* 一律正常（副号 key 有效）。 */
async function startUpstream({ status, body }) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      const path = req.url.split('?')[0];
      if (path.startsWith('/alpha/')) {
        const nowSec = Math.floor(Date.now() / 1000);
        if (path === '/alpha/whoami') return json(res, 200, { org: { login: 'mock-org', id: 'org-1' }, user: { userName: 'mock-user', keyName: 'mock-key' } });
        if (path === '/alpha/billing/credits') {
          return json(res, 200, {
            credits: { monthlyCredits: 10_000, purchasedCredits: 0, freeCredits: 0 },
            windowLimits: {
              limited: true, exceeded: null,
              fiveHour: { used: 0, cap: 100, resetAt: nowSec + 3600, exceeded: false },
              weekly: { used: 0, cap: 500, resetAt: nowSec + 86400, exceeded: false },
            },
          });
        }
        if (path === '/alpha/billing/subscriptions') return json(res, 200, { data: { currentPeriodStart: new Date(nowSec * 1000).toISOString() } });
        if (path === '/alpha/usage/summary') return json(res, 200, { totalCost: 0, totalCount: 5, totalTokens: 100 });
        return json(res, 404, { error: { message: 'not found' } });
      }
      const text = typeof body === 'string' ? body : JSON.stringify(body);
      res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
      res.end(text);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    server,
    url: `http://127.0.0.1:${server.address().port}`,
    seen,
    close: () => closeServer(server),
  };
}

/** 起一个网关 + 指定「内核折叠后」行为的自定义上游。 */
async function startCtx({ status, body }) {
  const dir = makeTmpDir();
  writeAccountFiles(dir, { accounts: ACCOUNTS, keys: KEYS });
  const upstream = await startUpstream({ status, body });
  const port = await allocPort();
  const gw = await startGateway({
    rootDir: dir,
    noTimers: true,
    noInitialRefresh: true,
    env: { ...process.env, CC_ACCOUNTS: '', ASSET_NO: '1' },
    config: {
      gatewayPort: port,
      gatewayHost: '127.0.0.1',
      upstreamProxyUrl: upstream.url,
      ccApiBase: upstream.url,
      quotaTimeoutMs: 5000,
      allowPassthrough: false,
      logLevel: 'silent',
    },
  });
  return {
    dir,
    baseUrl: `http://127.0.0.1:${port}`,
    localKey: KEYS[0].key,
    upstream,
    gateway: gw,
    async close() {
      await gw.stop().catch(() => {});
      await upstream.close().catch(() => {});
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }
    },
  };
}

const post = (ctx, body = { model: 'mock-model' }) =>
  request(`${ctx.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ctx.localKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const statusView = async (ctx) => JSON.parse((await request(`${ctx.baseUrl}/api/status`)).body);

// ── a. 内核折叠后的 401（模型名错/套餐不含）不得停调账号 ─────────────────────
test('403-not-auth#a：内核折叠 403→401（MODEL_NOT_IN_PLAN）不停调账号，401 原样透传', async (t) => {
  const ctx = await startCtx({
    status: 401,
    body: { error: { message: 'MODEL_NOT_IN_PLAN: claude-opus-4-1 available in GOAT and above plans', type: 'authentication_error' } },
  });
  t.after(() => ctx.close());

  const res = await post(ctx);
  assert.equal(res.status, 401, '内核折叠后的状态码 401 必须原样透传');
  assert.match(res.body, /MODEL_NOT_IN_PLAN/, '上游报文原样透传');

  const view = await statusView(ctx);
  for (const acct of view.accounts) {
    assert.equal(acct.authInvalid, false, `模型/套餐限制绝不能让账号「${acct.name}」变成 authInvalid`);
    assert.equal(acct.available, true, `401（模型/套餐限制）后账号「${acct.name}」必须仍可调度`);
  }
  assert.equal(view.summary.available, 2, '与 key 有效性无关，两个账号都得留在池里');
});

test('403-not-auth#a2：内核折叠后的 401 报文含 key，也走脱敏口径后再透传', async (t) => {
  const ctx = await startCtx({
    status: 401,
    body: { error: { message: `Model/provider not recognized: anthropic:deepseek-v4.1-falsh (key ${ACCOUNTS[0].key})`, type: 'authentication_error' } },
  });
  t.after(() => ctx.close());

  const res = await post(ctx);
  assert.equal(res.status, 401);
  assert.match(res.body, /Model\/provider not recognized/, '上游错误摘要原样透传');
  for (const a of ACCOUNTS) {
    assert.ok(!res.body.includes(a.key), `响应里绝不能出现明文账号 key（${a.key}）`);
  }
  const view = await statusView(ctx);
  assert.equal(view.summary.available, 2, '模型名错误不得停调任何账号');
});

// ── b. 真·无效 key（Invalid 'Authorization' header）仍停调 ──────────────────
test('403-not-auth#b：真·无效 key（401 Invalid Authorization header）仍标记 authInvalid 并停止调度', async (t) => {
  const ctx = await startCtx({
    status: 401,
    body: { error: { message: "Invalid 'Authorization' header or token", type: 'authentication_error' } },
  });
  t.after(() => ctx.close());

  const res = await post(ctx);
  assert.equal(res.status, 401, '401 状态码仍原样透传');

  const view = await statusView(ctx);
  const invalid = view.accounts.find((a) => a.authInvalid);
  assert.ok(invalid, '真鉴权失效必须标记 authInvalid');
  assert.equal(invalid.available, false, '鉴权失效的账号必须立刻退出调度');
  assert.match(invalid.lastError ?? '', /401/, '原因文案必须能看出是 401');
  assert.equal(view.summary.available, 1, '一个账号失效后池里只剩一个可用');
});

test('403-not-auth#b2：invalid api key / revoked 文案同样按鉴权失效处理', async (t) => {
  for (const message of ['invalid api key', 'this key has been revoked']) {
    const ctx = await startCtx({ status: 401, body: { error: { message, type: 'authentication_error' } } });
    try {
      await post(ctx);
      const view = await statusView(ctx);
      assert.ok(view.accounts.some((a) => a.authInvalid), `「${message}」必须停调`);
    } finally {
      await ctx.close();
    }
  }
});

// ── c. 面板可见性：模型错误 401 的 lastError 不能像是「鉴权失效」 ─────────────
test('403-not-auth#c：模型/套餐 401 的 lastError 不得含「鉴权失效」', async (t) => {
  const ctx = await startCtx({
    status: 401,
    body: { error: { message: 'Model/provider not recognized: anthropic:deepseek-v4.1-falsh', type: 'authentication_error' } },
  });
  t.after(() => ctx.close());

  await post(ctx);
  const view = await statusView(ctx);
  const acct = ctx.gateway.accounts.find((a) => a.name === '主号');
  const row = view.accounts.find((a) => a.keyId === acct.keyId);
  assert.equal(row.authInvalid, false);
  assert.ok(row.lastError, '必须给账号写 lastError（面板要能看到这次错误）');
  assert.match(row.lastError, /模型|套餐/, '面板要能看出这是模型/套餐限制');
  assert.doesNotMatch(row.lastError, /鉴权失效/, '不得提「鉴权失效」');
});

// ── d. 无法归类的 401 保守处理：只记错误、不停调（宁可少停一个也不误杀） ──────
test('403-not-auth#d：无法归类的 401 → 保守不停调', async (t) => {
  const ctx = await startCtx({ status: 401, body: { error: { message: 'something weird happened', type: 'authentication_error' } } });
  t.after(() => ctx.close());

  const res = await post(ctx);
  assert.equal(res.status, 401);
  const view = await statusView(ctx);
  assert.equal(view.accounts.some((a) => a.authInvalid), false, '认不出的 401 不得误杀账号');
  assert.equal(view.summary.available, 2);
});
