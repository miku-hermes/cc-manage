// 批次 40：请求日志 model 漏记修复的回归。
//
// 背景：gateway 只 peek 请求体头部 8KB 取 model；当 "model" 排在长 system prompt /
// 长 messages 之后（>8KB）时被记成 null，后台「用量统计」出现误导性的「(未知)」分组。
// 现在在 proxy 既有的 body tee 流上做有界增量扫描（找到即停，上限 = maxBodyBytes），
// 并且无 model 的接口（GET /v1/models）不再进按模型分组。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createModelBodyScanner } from '../src/proxy.mjs';

// ── 扫描器单测：跨 chunk 边界 / 位置很靠后 / 有界上限 ──────────────────
test('B40-0a：扫描器能命中跨 chunk 边界、以及 100KB 之后的 "model"', () => {
  const scanner = createModelBodyScanner({ maxBytes: 8 * 1024 * 1024 });
  // 键值本身被切成两半（模拟 TCP 分片），也必须命中。
  scanner.push(Buffer.from('{"messages":[],"mod'));
  scanner.push(Buffer.from('el":"split-model","stream":true}'));
  assert.equal(scanner.model, 'split-model');

  const far = createModelBodyScanner({ maxBytes: 8 * 1024 * 1024 });
  const filler = 'x'.repeat(120 * 1024);
  far.push(Buffer.from(`{"messages":[{"role":"system","content":"${filler}"}],`));
  far.push(Buffer.from('"model":"late-model","stream":true}'));
  assert.equal(far.model, 'late-model', '8KB 之后的 model 必须被扫描到');
});

test('B40-0b：扫描有明确上限（超过 maxBytes 的 model 不再扫描，返回 null）', () => {
  const scanner = createModelBodyScanner({ maxBytes: 64 });
  scanner.push(Buffer.from(`{"messages":"${'y'.repeat(200)}"`));
  scanner.push(Buffer.from(',"model":"too-late"}'));
  assert.equal(scanner.model, null, '超出扫描上限后不得无界缓冲/扫描');
  assert.equal(scanner.done, true);
  assert.ok(scanner.scanned <= 300, '扫描只累加到上限附近，不得无界增长');
});

// ── 端到端：长 body 里靠后的 model 必须进请求日志，且既有字段不回归 ──
test('B40-1：model 位于 100KB+ messages 之后，请求日志仍记对 model（其余字段不回归）', async (t) => {
  const { startTestGateway, request } = await import('./helpers.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'model-log-late-'));
  const ctx = await startTestGateway({
    rootDir: root,
    behavior: { sseChunks: [{ id: 'late-model-test', usage: { prompt_tokens: 41, completion_tokens: 7 } }] },
    config: { requestLogDir: path.join(root, 'logs'), protectAdminApi: true },
  });
  t.after(async () => { await ctx.close(); fs.rmSync(root, { recursive: true, force: true }); });

  const setup = await request(`${ctx.baseUrl}/api/auth/setup`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'TestPass123' }),
  });
  const cookie = setup.headers['set-cookie'].map((value) => value.split(';')[0]).join('; ');

  // "model" 故意排在 120KB 的 system message 之后 —— 远在 gateway 的 8KB peek 之外。
  const filler = 'x'.repeat(120 * 1024);
  const payload = JSON.stringify({ messages: [{ role: 'system', content: filler }], model: 'late-model-name', stream: true });
  const res = await request(`${ctx.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ctx.localKey}`, 'content-type': 'application/json', accept: 'text/event-stream' },
    body: payload,
  });
  assert.equal(res.status, 200);

  const logs = JSON.parse((await request(`${ctx.baseUrl}/api/admin/logs`, { headers: { cookie } })).body);
  const entry = logs.items.find((item) => item.path === '/v1/chat/completions');
  assert.ok(entry, '必须有 /v1/chat/completions 的请求日志');
  assert.equal(entry.model, 'late-model-name', '8KB 之后才出现的 model 也必须被记录');
  // 既有字段不回归。
  assert.equal(entry.status, 200);
  assert.equal(entry.stream, true);
  assert.equal(entry.keyName, '测试客户端');
  assert.equal(entry.tokensIn, 41);
  assert.equal(entry.tokensOut, 7);
  assert.ok(typeof entry.dur === 'number' && entry.dur >= 0, 'dur 必须仍是数字');
  assert.ok(entry.accountName && entry.accountKeyId, 'account 信息必须仍被记录');
  assert.ok(entry.t && entry.path && entry.ip, 't / path / ip 必须仍被记录');
});

// ── 端到端：GET /v1/models 不进「未知」模型分组 ──────────────────────
test('B40-2：GET /v1/models 不进按模型分组，不会出现「(未知)」', async (t) => {
  const { startTestGateway, request } = await import('./helpers.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'model-log-models-'));
  const ctx = await startTestGateway({
    rootDir: root,
    behavior: { sseChunks: [{ id: 'x', usage: { prompt_tokens: 3, completion_tokens: 1 } }] },
    config: { requestLogDir: path.join(root, 'logs'), protectAdminApi: true },
  });
  t.after(async () => { await ctx.close(); fs.rmSync(root, { recursive: true, force: true }); });

  const setup = await request(`${ctx.baseUrl}/api/auth/setup`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'TestPass123' }),
  });
  const cookie = setup.headers['set-cookie'].map((value) => value.split(';')[0]).join('; ');

  const models = await request(`${ctx.baseUrl}/v1/models`, { headers: { authorization: `Bearer ${ctx.localKey}` } });
  assert.equal(models.status, 200);
  const chat = await request(`${ctx.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ctx.localKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'grouped-model', messages: [] }),
  });
  assert.equal(chat.status, 200);

  const summary = JSON.parse((await request(`${ctx.baseUrl}/api/admin/usage?range=24h`, { headers: { cookie } })).body);
  assert.equal(summary.totals.requests, 2, '/v1/models 与 chat 都应计入总请求数');
  assert.ok(!summary.byModel.some((g) => g.model === '(未知)'), '不得出现「(未知)」分组');
  assert.ok(!summary.byModel.some((g) => g.model === null || g.model === '' || g.model === undefined), '无 model 的请求不得进按模型分组');
  assert.deepEqual(
    summary.byModel.map((g) => g.model),
    ['grouped-model'],
    '按模型分组只应含真正有 model 的请求',
  );
});
