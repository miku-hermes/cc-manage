// §8-4 余额见底探针：命中即标记，正常账号不误伤
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probeAccountCredits, shouldProbeCredits } from '../src/credits-probe.mjs';
import { startTestGateway, request } from './helpers.mjs';
import { startMockUpstream } from '../mocks/mock-cc-upstream.mjs';

// ── 单元：什么时候值得去问上游 ────────────────────────────────────────
test('shouldProbeCredits：官方 belowThreshold 为真必探；余额低于阈值才探；正常账号一次都不探', () => {
  // 官方标记（creditThreshold 在账号上配过才会为真）
  assert.equal(shouldProbeCredits({ ok: true, remaining: 50, belowThreshold: true }, 1.0), true);

  // 余额见底：主号线上就是这个样子（$0.098）
  assert.equal(shouldProbeCredits({ ok: true, remaining: 0.098, belowThreshold: false }, 1.0), true);
  assert.equal(shouldProbeCredits({ ok: true, remaining: 0.999, belowThreshold: false }, 1.0), true);

  // 正常账号：绝不能去打扰上游（每次探针都是真花钱的请求）
  assert.equal(shouldProbeCredits({ ok: true, remaining: 9.9, belowThreshold: false }, 1.0), false);
  assert.equal(shouldProbeCredits({ ok: true, remaining: 1.0, belowThreshold: false }, 1.0), false, '恰好等于阈值不算见底');

  // 边界：没有快照 / 查询失败 / 开关关掉（floor<=0）
  assert.equal(shouldProbeCredits(null, 1.0), false);
  assert.equal(shouldProbeCredits({ ok: false, remaining: 0 }, 1.0), false);
  assert.equal(shouldProbeCredits({ ok: true, remaining: 0.01 }, 0), false);
  assert.equal(shouldProbeCredits({ ok: true, remaining: 0.01 }, -1), false);
});

test('shouldProbeCredits：固定金额之外，还要按「本周期额度的比例」兜（套餐额度差 30 倍）', () => {
  const grant = (spend, remaining) => ({ ok: true, remaining, monthly: { used: spend, cap: spend + remaining } });

  // Max 20× 那种大套餐：剩 $5 远高于 $1 的固定阈值，但相对 $300 额度只剩 1.7%
  assert.equal(shouldProbeCredits(grant(295, 5), 1.0, 0.02), true, '大套餐要按比例兜住');
  // 同一个 $5 放在 Go（$10 额度）上：剩 50%，不该打扰上游
  assert.equal(shouldProbeCredits(grant(5, 5), 1.0, 0.02), false);

  // 固定金额这条仍然管用（Go 剩 $0.5）
  assert.equal(shouldProbeCredits(grant(9.5, 0.5), 1.0, 0.02), true);
  // 主号线上原样：剩 $0.098 / 额度 $10
  assert.equal(shouldProbeCredits(grant(9.936, 0.098), 1.0, 0.02), true);

  // 没有月度额度可比（缺 monthly）→ 只用固定金额，不能因此漏探或乱探
  assert.equal(shouldProbeCredits({ ok: true, remaining: 0.5 }, 1.0, 0.02), true);
  assert.equal(shouldProbeCredits({ ok: true, remaining: 50 }, 1.0, 0.02), false);
  // 比例阈值关掉（0）→ 退回固定金额
  assert.equal(shouldProbeCredits(grant(295, 5), 1.0, 0), false);
});

// ── 单元：探针结论只能来自上游，不能瞎判 ──────────────────────────────
test('probeAccountCredits：只有上游明确的余额不足才算没钱，其它错误一律不改判定', async (t) => {
  // 穷账号：mock 按账号返回真实的 400 insufficient credits 措辞
  const poor = await startMockUpstream({ plans: { user_poor_aa: { creditsExhausted: true } } });
  t.after(() => poor.close());
  const bad = await probeAccountCredits('user_poor_aa', { baseUrl: poor.url, model: 'mock-model' });
  assert.equal(bad.insufficientCredits, true, '400 + insufficient credits 必须判为没钱');
  assert.equal(bad.ok, false);
  assert.equal(bad.status, 400);

  // 健康账号：探针必须成功，且不得误判没钱
  const rich = await startMockUpstream();
  t.after(() => rich.close());
  const good = await probeAccountCredits('user_demo_alpha', { baseUrl: rich.url, model: 'mock-model' });
  assert.equal(good.ok, true, '200 应判为有钱');
  assert.equal(good.insufficientCredits, false);

  // 其它错误不能当「没钱」：套餐不含模型 / 5xx / 地址不通
  const planErr = await probeAccountCredits('user_demo_alpha', {
    baseUrl: rich.url, model: 'mock-model',
    fetchImpl: async () => ({ status: 401, text: async () => '{"error":{"code":"MODEL_NOT_IN_PLAN"}}' }),
  });
  assert.equal(planErr.insufficientCredits, false, '套餐不含 ≠ 没钱');
  assert.equal(planErr.ok, false);

  const boom = await probeAccountCredits('user_demo_alpha', {
    baseUrl: rich.url,
    fetchImpl: async () => ({ status: 503, text: async () => 'upstream busy' }),
  });
  assert.equal(boom.insufficientCredits, false, '5xx ≠ 没钱');
  assert.equal(boom.error, 'HTTP 503');

  const dead = await probeAccountCredits('user_demo_alpha', {
    baseUrl: rich.url,
    fetchImpl: async () => { throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }); },
  });
  assert.equal(dead.insufficientCredits, false);
  assert.match(dead.error, /ECONNREFUSED/);
});

// ── 集成：这才是用户遇到的问题 —— 还没有任何真实请求轮到它，面板就该知道 ──
test('余额见底的账号：刷新额度时就该被标成不可用，不必等真实请求撞上去', async (t) => {
  const ctx = await startTestGateway({
    plans: {
      // 主号线上原样：余额 $0.098、上游对任何推理都回 400 insufficient credits
      user_test_alpha: { creditsExhausted: true, monthlyCredits: 0.098, purchasedCredits: 0, freeCredits: 0, totalCost: 9.94 },
    },
  });
  t.after(() => ctx.close());

  // 只刷新额度，**不发任何推理请求**
  await ctx.gateway.refreshAll();

  const d = JSON.parse((await request(`${ctx.baseUrl}/api/status`)).body);
  const alpha = d.accounts.find((a) => a.name === '账号A');
  assert.equal(alpha.creditsExhausted, true, '刷新后就该标上余额不足（用户投诉的位置）');
  assert.equal(alpha.available, false, '不能再显示为可调度');
  assert.match(alpha.lastError, /余额不足/);
  assert.equal(d.summary.available, 1, '健康号仍可用');
  assert.equal(d.accounts.find((a) => a.name === '账号B').creditsExhausted, false, '余额正常的不许被误伤');

  // 探针只打了一发（1 个输出 token），不是每轮都打
  const v1 = ctx.upstream.seen.filter((s) => s.url.startsWith('/v1/'));
  assert.equal(v1.length, 1, `余额见底时只该探一次，实际 ${v1.length}`);

  // 再刷一轮：已标记 → 不再重复探
  await ctx.gateway.refreshAll();
  assert.equal(ctx.upstream.seen.filter((s) => s.url.startsWith('/v1/')).length, 1, '已标记后不得反复探');
});

test('余额正常但低于阈值 + 上游可用：探针成功 → 不标记，账号照常可用', async (t) => {
  const ctx = await startTestGateway({
    plans: { user_test_alpha: { monthlyCredits: 0.5, purchasedCredits: 0, freeCredits: 0, totalCost: 4 } },
  });
  t.after(() => ctx.close());

  await ctx.gateway.refreshAll();
  const d = JSON.parse((await request(`${ctx.baseUrl}/api/status`)).body);
  const alpha = d.accounts.find((a) => a.name === '账号A');
  assert.equal(alpha.creditsExhausted, false, '探针成功就不能标记');
  assert.equal(alpha.available, true, '余额还能用就照常调度');

  const v1 = ctx.upstream.seen.filter((s) => s.url.startsWith('/v1/'));
  assert.equal(v1.length, 1, '低于阈值会探一次');
  assert.equal(v1[0].headers.authorization, 'Bearer user_test_alpha', '探针必须用该账号自己的 key');
});

test('探针开关关掉时：一次都不打上游，标记也不产生', async (t) => {
  const ctx = await startTestGateway({
    config: { creditsProbeEnabled: false },
    plans: { user_test_alpha: { creditsExhausted: true, monthlyCredits: 0.05, totalCost: 9.9 } },
  });
  t.after(() => ctx.close());

  await ctx.gateway.refreshAll();
  assert.equal(ctx.upstream.seen.filter((s) => s.url.startsWith('/v1/')).length, 0, '关掉就不该打任何推理请求');
  const d = JSON.parse((await request(`${ctx.baseUrl}/api/status`)).body);
  assert.equal(d.accounts.find((a) => a.name === '账号A').creditsExhausted, false);
});
