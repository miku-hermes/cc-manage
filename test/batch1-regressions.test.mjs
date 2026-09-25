// 批次 1（核心安全与正确性）后端回归：
//   M6 / 后端-M1 / 后端-M2 / 后端-M5 / M2 / L3 / L2 / M1 / L5
// 约定：这些用例在未修复的源码上必须变红（mutation check）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { startTestGateway, request } from './helpers.mjs';

const AUTH = (ctx) => ({ authorization: `Bearer ${ctx.localKey}`, 'content-type': 'application/json' });
const post = (ctx, body = { model: 'mock-model' }) =>
  request(`${ctx.baseUrl}/v1/chat/completions`, { method: 'POST', headers: AUTH(ctx), body: JSON.stringify(body) });
const statusView = async (ctx) => JSON.parse((await request(`${ctx.baseUrl}/api/status`)).body);
const byName = (ctx, name) => ctx.gateway.accounts.find((a) => a.name === name);

// ── M1：匿名 /api/status 不得泄露上游拓扑 ─────────────────────────────
//
// 上游拓扑 = 内核主机名（core）+ 内核端口（3050）。它只会以「主机名字符串 / 端口号 /
// 承载二者的字段名」的形态出现，所以按 **JSON 结构**逐字段判定，而不是对原始报文做子串
// 匹配 —— 旧写法 `!body.includes('3050')` 会被 now / lastQuota.fetchedAt 这类毫秒时间戳
// 的末四位恰好为 3050 伪命中（实测 ~19/20000）。
const CORE_HOST = 'core';
const CORE_PORT = '3050';
// 字段名黑名单（小写比较）：这些名字本身就在描述上游地址/端口，出现即泄漏（哪怕值是 null）。
const TOPOLOGY_KEYS = new Set([
  'upstreamproxyurl', 'gateway', 'upstreambaseurl', 'coreurl', 'corehost', 'coreport', 'proxyurl',
]);
// 只有「独立 token」形态的 core / 3050 才算泄漏：core 前后不能是标识符字符，3050 前后不能是数字。
// 时间戳是 13 位且必然作为 number 处理（走下面的数值分支），不会被字符串 token 命中。
const hostTokenRe = new RegExp(`(^|[^\\w.-])${CORE_HOST}([^\\w-]|$)`);
const portTokenRe = new RegExp(`(^|[^\\d])${CORE_PORT}([^\\d]|$)`);

/**
 * 递归遍历已解析的 JSON，收集所有上游拓扑泄漏点。数字只在**恰好等于端口号**时才可疑 ——
 * 毫秒时间戳是 13 位（~1.7e12），永不等于 3050，这正是新写法对时间戳免疫的根本原因。
 * @returns {{hits: string[], visited: number}} hits 空 = 干净；visited 用于防止「空遍历假绿」。
 */
function scanTopology(value, path = '$', acc = { hits: [], visited: 0 }) {
  acc.visited += 1;
  if (Array.isArray(value)) {
    value.forEach((v, i) => scanTopology(v, `${path}[${i}]`, acc));
  } else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (TOPOLOGY_KEYS.has(k.toLowerCase())) acc.hits.push(`${path}.${k}（禁用字段名）`);
      scanTopology(v, `${path}.${k}`, acc);
    }
  } else if (typeof value === 'string') {
    if (hostTokenRe.test(value)) acc.hits.push(`${path}=${JSON.stringify(value)}（含内核主机名 ${CORE_HOST}）`);
    if (portTokenRe.test(value)) acc.hits.push(`${path}=${JSON.stringify(value)}（含内核端口 ${CORE_PORT}）`);
  } else if (typeof value === 'number' && value === Number(CORE_PORT)) {
    acc.hits.push(`${path}=${value}（数值等于内核端口 ${CORE_PORT}）`);
  }
  return acc;
}

test('M1：匿名 GET /api/status 不含 upstreamProxyUrl / gateway / core / 3050', async (t) => {
  const ctx = await startTestGateway({
    config: { upstreamProxyUrl: 'http://core:3050' },
    noInitialRefresh: true,
  });
  t.after(() => ctx.close());

  const res = await request(`${ctx.baseUrl}/api/status`);
  assert.equal(res.status, 200);
  const d = JSON.parse(res.body);

  // 顶层两个历史泄漏点的强断言（键必须不存在，不能是 null）。
  assert.equal(d.upstreamProxyUrl, undefined);
  assert.equal(d.gateway, undefined);

  // 全树的语义检查：任何字段名/字符串/端口号形态的拓扑泄漏都要抓住。
  const { hits, visited } = scanTopology(d);
  assert.ok(visited >= 30, `拓扑检查只遍历了 ${visited} 个 JSON 节点，walk 可能坏了（不能靠空遍历假绿）`);
  assert.deepEqual(hits, [], `匿名 /api/status 泄漏了上游拓扑：\n${hits.join('\n')}`);
});

// ── 后端-M5：keep-alive 时序抬到 65s（反代复用已关连接 → POST EPIPE 502）──
test('后端-M5：keepAliveTimeout > 60s 且 headersTimeout > keepAliveTimeout', async (t) => {
  const ctx = await startTestGateway();
  t.after(() => ctx.close());
  assert.ok(ctx.gateway.server.keepAliveTimeout > 60000,
    `keepAliveTimeout 必须 > 60s，实际 ${ctx.gateway.server.keepAliveTimeout}`);
  assert.ok(ctx.gateway.server.headersTimeout > ctx.gateway.server.keepAliveTimeout,
    'headersTimeout 必须大于 keepAliveTimeout（Node 要求）');
});

// ── M2：/api/status 下发 rateLimited ──────────────────────────────────
test('M2：普通限流（429 非额度）后 /api/status 账号 rateLimited=true', async (t) => {
  const ctx = await startTestGateway({ behavior: { rateLimitError: true } });
  t.after(() => ctx.close());

  const res = await post(ctx);
  assert.equal(res.status, 429);
  const view = await statusView(ctx);
  const limited = view.accounts.filter((a) => a.rateLimited === true);
  assert.equal(limited.length, 1, `必须有且只有一个账号被标限流，实际 ${limited.length}`);
  assert.equal(typeof limited[0].rateLimitedUntil, 'number');
  assert.equal(limited[0].available, false, '限流冷却中的账号不可调度');
});

// ── M6：单账号池 + 400 insufficient credits → 400 原样透传（不得变 502）──
test('M6：单账号池 400 insufficient credits → 400 原样透传 + errors=1', async (t) => {
  const ctx = await startTestGateway({
    accounts: [{ name: '账号A', key: 'user_test_alpha', enabled: true }],
    plans: { 'user_test_alpha': { creditsExhausted: true } },
  });
  t.after(() => ctx.close());

  const res = await post(ctx);
  assert.equal(res.status, 400, `必须原样透传 400，实际 ${res.status}: ${res.body.slice(0, 200)}`);
  assert.match(res.body, /insufficient credits/i, '上游可操作文案必须保留');

  const view = await statusView(ctx);
  assert.equal(view.stats.total, 1);
  assert.equal(view.stats.errors, 1);
  assert.equal(view.accounts[0].creditsExhausted, true);
});

// ── L2：creditsExhausted 状态变化时落盘 ───────────────────────────────
test('L2：触发 400 insufficient credits → state.json 落盘含该 keyId 的 creditsExhausted', async (t) => {
  const ctx = await startTestGateway({
    accounts: [{ name: '账号A', key: 'user_test_alpha', enabled: true }],
    plans: { 'user_test_alpha': { creditsExhausted: true } },
    // B20：本用例断言落盘的 creditsExhausted.remaining 是 null（即「撞 400 时还没有快照」）；
    // 启动即刷会先把 lastQuota 填上，remaining 于是变成 55。显式关掉启动刷新保留原前置。
    noInitialRefresh: true,
  });
  t.after(() => ctx.close());

  await post(ctx);
  const keyId = ctx.gateway.accounts[0].keyId;
  const fs = await import('node:fs');
  const onDisk = JSON.parse(fs.readFileSync(ctx.gateway.store.stateFile, 'utf8'));
  assert.ok(onDisk.accounts[keyId], '状态变化后必须落盘该账号');
  assert.ok(onDisk.accounts[keyId].creditsExhausted, 'state.json 必须包含 creditsExhausted 标记');
  assert.equal(onDisk.accounts[keyId].creditsExhausted.remaining ?? null, null);
});

// ── 后端-M1：重放分支 body 不完整 → 502 记错误，不谎报成功 ────────────
test('后端-M1：慢客户端 + 上游秒回 5xx → 重放失败 502 且 errors=1', async (t) => {
  const ctx = await startTestGateway({ behavior: { immediate5xx: 1 } });
  t.after(() => ctx.close());

  const payload = JSON.stringify({ model: 'mock', padding: 'x'.repeat(20_000) });
  const res = await new Promise((resolve) => {
    const req = http.request(`${ctx.baseUrl}/v1/chat/completions`, { method: 'POST', headers: AUTH(ctx) }, (r) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => resolve({ status: r.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      r.on('close', () => resolve({ status: r.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', () => resolve({ status: 0, body: '' }));
    // 先发一半 body，1.5s 后才发完：drainRemaining 1s 超时 → 重放分支发现不完整
    req.write(payload.slice(0, Math.floor(payload.length / 2)));
    setTimeout(() => req.end(payload.slice(Math.floor(payload.length / 2))), 1500);
  });

  assert.equal(res.status, 502, `body 不完整必须 502，实际 ${res.status}`);
  const view = await statusView(ctx);
  assert.equal(view.stats.total, 1, '一个客户端请求只占一行');
  assert.equal(view.stats.errors, 1, '重放失败必须计错误（历史：bodyState.error=null → 谎报成功）');
});

// ── 后端-M2：额度错误不得 await 慢刷新阻塞首字节 ─────────────────────
test('后端-M2：额度错误时慢刷新不阻塞响应（<1s）且仍换号重试', async (t) => {
  const ctx = await startTestGateway({
    behavior: { quotaErrorKeys: ['user_test_alpha'], alphaDelayMs: 1000 },
  });
  t.after(() => ctx.close());

  const t0 = Date.now();
  const res = await post(ctx);
  const dt = Date.now() - t0;
  assert.equal(res.status, 200, `应换号成功，实际 ${res.status}: ${res.body.slice(0, 200)}`);
  assert.ok(dt < 1000, `不得等额度刷新（4×1s）跑完才回首字节，实际 ${dt}ms`);
});

// ── L3：503 Retry-After 只统计可调度候选 ─────────────────────────────
test('L3：禁用账号 +5d resetAt 不参与 Retry-After，暂停 60s 的账号决定重试间隔', async (t) => {
  const ctx = await startTestGateway();
  t.after(() => ctx.close());
  const far = Math.floor(Date.now() / 1000) + 5 * 86400;
  const w = (u, c) => ({ used: u, cap: c, usedRatio: u / c, resetAt: far });
  const a = byName(ctx, '账号A');
  const b = byName(ctx, '账号B');
  a.enabled = false;
  ctx.gateway.scheduler.recordQuota(a, { ok: true, fetchedAt: Date.now(), fiveHour: w(1, 100), weekly: w(1, 100) });
  ctx.gateway.scheduler.recordQuota(b, { ok: true, fetchedAt: Date.now(), fiveHour: w(1, 100), weekly: w(1, 100) });
  ctx.gateway.scheduler.runtime(b).pausedUntil = Date.now() + 60_000;

  const res = await post(ctx);
  assert.equal(res.status, 503, `无可用账号应 503，实际 ${res.status}`);
  const ms = JSON.parse(res.body).retryAfterMs;
  assert.ok(ms > 0 && ms <= 5 * 60 * 1000, `Retry-After 应为分钟级，实际 ${ms}ms`);
  assert.ok(Number(res.headers['retry-after']) <= 300, `retry-after 头应为分钟级，实际 ${res.headers['retry-after']}s`);
});

// ── L5：peekBody 起始超时 —— 挂起连接不能无限占 socket ───────────────
test('L5：连上但一直不发 body → 起始超时后 408/断开（不再无限挂起）', async (t) => {
  const ctx = await startTestGateway({ config: { bodyPeekStartMs: 300 } });
  t.after(() => ctx.close());

  const result = await new Promise((resolve) => {
    const sock = net.connect(ctx.port, '127.0.0.1', () => {
      sock.write(`POST /v1/chat/completions HTTP/1.1\r\n`
        + 'Host: 127.0.0.1\r\n'
        + `Authorization: Bearer ${ctx.localKey}\r\n`
        + 'Content-Type: application/json\r\n'
        + 'Content-Length: 100\r\n\r\n');   // 声明 100 字节 body，但一个字节都不发
    });
    let data = '';
    sock.on('data', (c) => { data += c.toString('utf8'); });
    const done = (closed) => { try { sock.destroy(); } catch { /* 忽略 */ } resolve({ closed, data }); };
    sock.on('close', () => done(true));
    sock.on('error', () => done(true));
    setTimeout(() => done(false), 3000);
  });

  assert.ok(result.data.includes('408') || result.closed,
    `起始超时后必须 408 或断开，实际 data=${JSON.stringify(result.data.slice(0, 80))} closed=${result.closed}`);
});
