// 批次 12：公开面板脱敏回归。
// 背景：PUBLIC_DASHBOARD=1 下 /api/status 匿名可读，历史上下发了
//   ① lastQuota.displayName —— 上游账号真实身份（线上实测就是用户本人账号名）
//   ② lastError / lastErrorAt —— 内部错误原文（上游报错措辞、超时描述）
// 本文件断言：对外档摘掉这两类（键不存在，不是 null），后台全量档照旧，
// 且绝不删过头（面板必需字段仍在）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startTestGateway, request } from './helpers.mjs';

const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

/** 起一个带管理员登录态的网关（后台接口需要 session）。 */
async function setupAdminCtx(opts = {}) {
  const ctx = await startTestGateway(opts);
  const setup = await request(`${ctx.baseUrl}/api/auth/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'TestPass123' }),
  });
  assert.equal(setup.status, 201, '首次初始化管理员返回 201 Created');
  const cookie = (setup.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');
  return { ctx, cookie };
}

test('B12-1：/api/status 账号对象与 lastQuota 都不含 displayName 键（上游快照确实带该值）', async (t) => {
  const ctx = await startTestGateway();
  t.after(() => ctx.close());
  await ctx.gateway.refreshAll();

  // 造数据自检：上游快照里确实带了真实身份，否则这条测不出东西。
  const rtAlpha = ctx.gateway.scheduler.runtime(ctx.gateway.accounts.find((a) => a.name === '账号A'));
  assert.equal(rtAlpha.lastQuota.displayName, '测试账号A', '前提：运行期快照必须带上游 displayName');

  const data = JSON.parse((await request(`${ctx.baseUrl}/api/status`)).body);
  assert.equal(data.accounts.length, 2);
  for (const a of data.accounts) {
    assert.ok(!has(a, 'displayName'), '账号对象不得含 displayName 键');
    assert.ok(a.lastQuota, '公开面板仍要有额度快照');
    assert.ok(!has(a.lastQuota, 'displayName'), 'lastQuota 不得含 displayName 键（键必须不存在）');
  }
});

test('B12-2：/api/status 不含 lastError / lastErrorAt 键（即使运行期确有错误）', async (t) => {
  // 让账号A 的额度查询真失败（mock 对 /alpha/* 回 401）→ 运行期写下 lastError。
  const ctx = await startTestGateway({ plans: { user_test_alpha: { authInvalid: true } } });
  t.after(() => ctx.close());
  await ctx.gateway.refreshAll();

  const rt = ctx.gateway.scheduler.runtime(ctx.gateway.accounts.find((a) => a.name === '账号A'));
  assert.ok(rt.lastError, '前提：运行期确实记录了内部错误原文');

  const data = JSON.parse((await request(`${ctx.baseUrl}/api/status`)).body);
  const alpha = data.accounts.find((a) => a.name === '账号A');
  assert.ok(alpha, '应包含账号A');
  assert.ok(!has(alpha, 'lastError'), '公开档不得含 lastError 键（键必须不存在）');
  assert.ok(!has(alpha, 'lastErrorAt'), '公开档不得含 lastErrorAt 键（键必须不存在）');
});

test('B12-3：整个 /api/status 响应体里不出现上游 displayName 字符串', async (t) => {
  const ctx = await startTestGateway();
  t.after(() => ctx.close());
  await ctx.gateway.refreshAll();

  const body = (await request(`${ctx.baseUrl}/api/status`)).body;
  assert.ok(!body.includes('测试账号A'), '响应体不得出现上游账号A身份');
  assert.ok(!body.includes('测试账号B'), '响应体不得出现上游账号B身份');
});

test('B12-4：公开档不能删过头 —— 面板必需字段仍在', async (t) => {
  const ctx = await startTestGateway();
  t.after(() => ctx.close());
  await ctx.gateway.refreshAll();

  const data = JSON.parse((await request(`${ctx.baseUrl}/api/status`)).body);
  assert.equal(data.accounts.length, 2);
  for (const a of data.accounts) {
    for (const k of ['name', 'keyId', 'enabled', 'available', 'rateLimited', 'paused', 'exhausted']) {
      assert.ok(has(a, k), `公开档必须保留账号字段 ${k}`);
    }
    for (const k of ['ok', 'plan', 'remaining', 'credits', 'fiveHour', 'weekly', 'monthly', 'percent', 'fetchedAt']) {
      assert.ok(has(a.lastQuota, k), `公开档必须保留 lastQuota.${k}`);
    }
  }
});

test('B12-5：后台 /api/admin/accounts 仍全量（displayName / lastError / lastErrorAt / keyPrefix）', async (t) => {
  const { ctx, cookie } = await setupAdminCtx({ plans: { user_test_alpha: { authInvalid: true } } });
  t.after(() => ctx.close());
  await ctx.gateway.refreshAll();

  const admin = JSON.parse((await request(`${ctx.baseUrl}/api/admin/accounts`, { headers: { cookie } })).body);
  const accA = admin.accounts.find((a) => a.name === '账号A');   // 有真实错误
  const accB = admin.accounts.find((a) => a.name === '账号B');   // 健康、有快照

  // keyPrefix：后台照旧下发
  assert.equal(typeof accA.keyPrefix, 'string', '后台应保留 keyPrefix');
  assert.equal(accA.keyPrefix.length, 9);

  // 内部错误原文：后台照旧下发（键存在 + 真值）
  assert.ok(has(accA, 'lastError'), '后台必须有 lastError 键');
  assert.equal(typeof accA.lastError, 'string', '后台 lastError 应是错误原文');
  assert.ok(has(accA, 'lastErrorAt'), '后台必须有 lastErrorAt 键');
  assert.ok(Number.isFinite(accA.lastErrorAt), '后台 lastErrorAt 应是时间戳');

  // 上游身份：后台照旧下发
  assert.ok(accB.lastQuota, '健康账号应有快照');
  assert.ok(has(accB.lastQuota, 'displayName'), '后台 lastQuota 必须保留 displayName 键');
  assert.equal(accB.lastQuota.displayName, '测试账号B', '后台 displayName 应是上游身份值');

  // 健康账号同样保留（值可为 null，但键要在）
  assert.ok(has(accB, 'lastError'), '后台健康账号也要有 lastError 键');
  assert.ok(has(accB, 'lastErrorAt'), '后台健康账号也要有 lastErrorAt 键');
});

test('B12-6：/api/status 仍不含任何 key 片段（既有不变量不回归）', async (t) => {
  const ctx = await startTestGateway();
  t.after(() => ctx.close());
  await ctx.gateway.refreshAll();

  const body = (await request(`${ctx.baseUrl}/api/status`)).body;
  assert.ok(!body.includes('user_test_alpha'), '不得出现完整账号 key');
  assert.ok(!body.includes('user_test_beta'), '不得出现完整账号 key');
  assert.ok(!body.includes(ctx.localKey), '不得出现本地 key');
  assert.ok(!/user_[A-Za-z0-9_-]{9,}/.test(body), '不得出现任何完整 user_ key');
  assert.ok(!body.includes('user_test'), '响应体里不得出现 key 前缀');

  const data = JSON.parse(body);
  for (const a of data.accounts) {
    assert.equal(a.keyPrefix, undefined, '公开视图不得下发 keyPrefix');
    assert.equal(a.key, undefined, '公开视图不得下发 key');
  }
});

test('B12-7：前台 render-cards.js 去掉 displayName / card-display 引用，搜索只按备注名', async (t) => {
  const src = fs.readFileSync(new URL('../public/js/render-cards.js', import.meta.url), 'utf8');
  assert.ok(!src.includes('card-display'), '不得再引用 .card-display');
  assert.ok(!src.includes('displayName'), '不得再引用 displayName');
  assert.ok(!/lastQuota[\s\S]{0,40}displayName/.test(src), '不得按 lastQuota.displayName 搜索');
  // 搜索过滤只按用户备注名匹配（状态筛选与搜索的叠加语义留在 byView 上不变）
  assert.match(src, /byView\.filter\(\(a\) => String\(a\.name/, '搜索应只按 a.name 匹配');
});
