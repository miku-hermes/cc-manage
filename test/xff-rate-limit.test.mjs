// H2 回归：XFF 来源解析改为「数代理 hop」+ 进程级全局登录桶。
//
// 历史漏洞：取 XFF 最左项时，客户端自填 `X-Forwarded-For: 10.88.0.9, 2.2.2.2`
// 就能把自己伪装成可信内网地址 —— 换任意 XFF 前缀 = 换满桶，登录限速（scrypt）被绕过。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveClientIp, DEFAULT_TRUSTED_PROXY_CIDRS } from '../src/client-ip.mjs';
import { startTestGateway, request } from './helpers.mjs';

const ADMIN = { username: 'admin', password: 'hunter2-secret' };

// ── 单元：resolveClientIp 的 hop 计数语义（无需网络）──────────────────
test('H2：可信 socket + 客户端伪造可信前缀 → 取最右的非可信地址（追加项）', () => {
  assert.equal(resolveClientIp({ remoteAddress: '127.0.0.1', headers: { 'x-forwarded-for': '10.88.0.9, 2.2.2.2' } }), '2.2.2.2');
  // 客户端在左侧塞任意内网地址都改不了答案
  assert.equal(resolveClientIp({ remoteAddress: '127.0.0.1', headers: { 'x-forwarded-for': '10.0.0.1, 172.16.9.9, 2.2.2.2' } }), '2.2.2.2');
  // 反代追加在右侧；客户端在右侧再塞可信地址也无效（右起第一个非可信仍是 2.2.2.2 左边那个）
  assert.equal(resolveClientIp({ remoteAddress: '127.0.0.1', headers: { 'x-forwarded-for': '2.2.2.2, 10.0.0.9' } }), '2.2.2.2');
});

test('H2：XFF 全落在可信网段 → 回落 x-real-ip，再回落 socket', () => {
  assert.equal(resolveClientIp({ remoteAddress: '127.0.0.1', headers: { 'x-forwarded-for': '10.1.2.3', 'x-real-ip': '8.8.8.8' } }), '8.8.8.8');
  assert.equal(resolveClientIp({ remoteAddress: '127.0.0.1', headers: { 'x-forwarded-for': '10.1.2.3' } }), '127.0.0.1');
});

test('H2：不可信 socket → 完全忽略代理头', () => {
  assert.equal(resolveClientIp({ remoteAddress: '203.0.113.7', headers: { 'x-forwarded-for': '2.2.2.2', 'x-real-ip': '3.3.3.3' } }), '203.0.113.7');
});

test('H2：非法 XFF 项跳过、IPv6 映射归一化', () => {
  assert.equal(resolveClientIp({ remoteAddress: '127.0.0.1', headers: { 'x-forwarded-for': 'garbage, ::ffff:4.4.4.4' } }), '4.4.4.4');
  assert.ok(DEFAULT_TRUSTED_PROXY_CIDRS.includes('10.0.0.0/8'));
});

// ── 集成：限速分桶 ───────────────────────────────────────────────────
async function setup(ctx) {
  const res = await request(`${ctx.baseUrl}/api/auth/setup`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(ADMIN),
  });
  assert.equal(res.status, 201, `setup 失败：${res.status} ${res.body}`);
}
const login = (ctx, { username, xff }) => request(`${ctx.baseUrl}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(xff ? { 'x-forwarded-for': xff } : {}) },
  body: JSON.stringify({ username, password: 'wrong-pass-1234' }),
});

test('H2：可信来源轮换「可信网段」XFF → 共用同一来源桶，第 attemptMax+1 次 429', async (t) => {
  const ctx = await startTestGateway({ config: { loginAttemptsPerMinute: 3 } });
  t.after(() => ctx.close());
  await setup(ctx);

  // 每次换一个 10.x 前缀（都在默认可信网段内 → 解析时被跳过 → 都算 socket 来源）
  for (let i = 0; i < 3; i++) {
    const r = await login(ctx, { username: `rot${i}`, xff: `10.88.0.${i + 1}` });
    assert.equal(r.status, 401, `第 ${i + 1} 次应是 401，实际 ${r.status}: ${r.body}`);
  }
  const blocked = await login(ctx, { username: 'rot9', xff: '10.88.0.99' });
  assert.equal(blocked.status, 429, '轮换可信前缀不能换桶，必须共用来源桶');
});

test('H2：客户端自带可信 XFF 前缀 + 反代追加真实 IP → 按追加项计数', async (t) => {
  const ctx = await startTestGateway({ config: { loginAttemptsPerMinute: 3 } });
  t.after(() => ctx.close());
  await setup(ctx);

  for (let i = 0; i < 3; i++) {
    // 前缀每次不同（伪造），但反代追加的真实来源恒为 2.2.2.2
    const r = await login(ctx, { username: `pre${i}`, xff: `10.88.${i}.9, 2.2.2.2` });
    assert.equal(r.status, 401, `第 ${i + 1} 次应是 401，实际 ${r.status}: ${r.body}`);
  }
  const blocked = await login(ctx, { username: 'pre9', xff: '10.200.0.1, 2.2.2.2' });
  assert.equal(blocked.status, 429, '前缀随便换，追加的真实 IP 决定来源桶');
});

test('H2：进程级全局桶超限 → 429（换任意来源也绕不过）', async (t) => {
  const ctx = await startTestGateway({ config: { loginAttemptsPerMinute: 60, loginGlobalAttemptsPerMinute: 3 } });
  t.after(() => ctx.close());
  await setup(ctx);

  for (let i = 0; i < 3; i++) {
    const r = await login(ctx, { username: `g${i}`, xff: `1.1.1.${i + 1}` });
    assert.equal(r.status, 401, `第 ${i + 1} 次应是 401，实际 ${r.status}: ${r.body}`);
  }
  const blocked = await login(ctx, { username: 'g9', xff: '2.2.2.2' });
  assert.equal(blocked.status, 429, '全局桶超限必须 429，与来源/用户名无关');
});
