// 批次 2：需要真实网关/上游的后端回归（UI 中-2 的后端字段、低-9、低-13）。
// 约定：这些用例在未修复的源码上必须变红（mutation check）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestGateway, request } from './helpers.mjs';

const AUTH = (ctx) => ({ authorization: `Bearer ${ctx.localKey}`, 'content-type': 'application/json' });
const statusView = async (ctx) => JSON.parse((await request(`${ctx.baseUrl}/api/status`)).body);

// ── 14：summary 新增「不可用」，缺口可解释 ─────────────────────────
test('B2-14：summary.unavailable 存在且 available + unavailable === accounts', async (t) => {
  const ctx = await startTestGateway({ behavior: { rateLimitError: true } });
  t.after(() => ctx.close());

  // 一次请求触发普通限流 → 该账号进入 60s 冷却，available 掉 1
  const res = await request(`${ctx.baseUrl}/v1/chat/completions`, { method: 'POST', headers: AUTH(ctx), body: '{}' });
  assert.equal(res.status, 429);

  const s = await statusView(ctx);
  assert.equal(typeof s.summary.unavailable, 'number', 'summary 必须有 unavailable');
  assert.equal(s.summary.available + s.summary.unavailable, s.summary.accounts,
    `可用 ${s.summary.available} + 不可用 ${s.summary.unavailable} 必须等于账号数 ${s.summary.accounts}`);
  assert.equal(s.summary.unavailable, 1, '被限流的账号应计入不可用');
});

// ── 18：客户端 4xx 单独计 clientErrors，不污染「上游错误数」──────────
test('B2-18：上游 403（模型名错）透传 → clientErrors+1 且 stats.errors 不变', async (t) => {
  const ctx = await startTestGateway({
    behavior: {
      authErrorStatus: 403,
      authErrorBody: { error: { message: 'Model/provider not recognized: anthropic:bogus', type: 'model_error' } },
    },
  });
  t.after(() => ctx.close());

  const res = await request(`${ctx.baseUrl}/v1/chat/completions`, { method: 'POST', headers: AUTH(ctx), body: '{}' });
  assert.equal(res.status, 403, '原样透传 403');

  const s = await statusView(ctx);
  assert.equal(s.stats.clientErrors, 1, '客户端 4xx 计入 clientErrors');
  assert.equal(s.stats.errors, 0, '不得计入「上游错误数」KPI（errors）');
  assert.equal(s.stats.total, 1, '一个客户端请求只占一行');
});

// 对照：真·额度/鉴权错误仍计入 errors（口径没有被改坏）
test('B2-18 对照：400 insufficient credits 仍计入 stats.errors', async (t) => {
  const ctx = await startTestGateway({
    accounts: [{ name: '账号A', key: 'user_test_alpha', enabled: true }],
    plans: { user_test_alpha: { creditsExhausted: true } },
  });
  t.after(() => ctx.close());

  const res = await request(`${ctx.baseUrl}/v1/chat/completions`, { method: 'POST', headers: AUTH(ctx), body: '{}' });
  assert.equal(res.status, 400);
  const s = await statusView(ctx);
  assert.equal(s.stats.errors, 1, '账号级额度错误仍算上游错误');
  assert.equal(s.stats.clientErrors, 0);
});
