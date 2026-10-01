import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractUsage, createUsageCollector, createUsageRecorder } from '../src/usage.mjs';

test('extractUsage reads OpenAI, Anthropic, and total-only payloads', () => {
  assert.deepEqual(extractUsage('{"usage":{"prompt_tokens":12,"completion_tokens":5,"total_tokens":17}}'), { tokensIn: 12, tokensOut: 5 });
  assert.deepEqual(extractUsage('{"usage":{"input_tokens":23,"output_tokens":8}}'), { tokensIn: 23, tokensOut: 8 });
  assert.deepEqual(extractUsage('{"usage":{"total_tokens":31}}'), { tokensIn: 0, tokensOut: 31 });
});

test('collector retains tail and returns zero for missing usage', () => {
  const collector = createUsageCollector({ maxBytes: 80 });
  collector.feed('x'.repeat(40)); collector.feed('y'.repeat(40)); collector.feed('data: {"usage":{"prompt_tokens":4,"completion_tokens":6}}');
  assert.deepEqual(collector.finish(), { tokensIn: 4, tokensOut: 6 });
  assert.deepEqual(createUsageCollector().finish(), { tokensIn: 0, tokensOut: 0 });
});

test('recorder serializes, filters, pages, degrades, and enforces file limit', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-'));
  const recorder = createUsageRecorder({ dir, noTimers: true });
  for (let i = 0; i < 3; i++) await recorder.record({ t: 1000 + i, dur: i, keyId: i === 0 ? 'a' : 'b', keyName: 'Key', model: 'm', path: '/v1/chat', status: i === 2 ? 500 : 200, error: i === 2 ? 'failure' : null });
  const page = await recorder.recent({ limit: 2 });
  assert.equal(page.items[0].t, 1002); assert.equal(page.items[1].t, 1001); assert.equal(page.hasMore, true);
  assert.equal((await recorder.recent({ keyId: 'a' })).items.length, 1);
  assert.equal((await recorder.recent({ status: 'error' })).items.length, 1);
  assert.equal((await recorder.recent({ q: 'CHAT' })).items.length, 3);
  assert.equal((await recorder.recent({ offset: 2 })).items.length, 1);
  await recorder.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('disabled recorder writes nothing; file path degrades without throwing', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-'));
  const disabled = createUsageRecorder({ dir: path.join(root, 'off'), enabled: false, noTimers: true });
  await disabled.record({ t: 1 }); assert.equal(fs.existsSync(path.join(root, 'off')), false);
  fs.writeFileSync(path.join(root, 'not-dir'), 'x');
  const recorder = createUsageRecorder({ dir: path.join(root, 'not-dir'), noTimers: true });
  await assert.doesNotReject(recorder.record({ t: 100, path: '/x', status: 200 }));
  assert.equal(recorder.stats().degraded, true); assert.equal((await recorder.recent()).items.length, 1);
  await recorder.close(); fs.rmSync(root, { recursive: true, force: true });
});

test('recorder stops after maxFileBytes and aggregates buckets', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-'));
  const recorder = createUsageRecorder({ dir, maxFileBytes: 200, retentionDays: 0, noTimers: true });
  for (let i = 0; i < 4; i++) await recorder.record({ t: Date.now() + i * 3600000, path: '/x', status: 200, keyId: i % 2 ? 'b' : 'a', model: i % 2 ? 'n' : 'm', tokensIn: 2, tokensOut: 3 });
  assert.ok(recorder.stats().dropped > 0);
  const summary = await recorder.summary({ sinceMs: Date.now() - 86400000 });
  assert.ok(summary.totals.requests > 0); assert.ok(summary.series.every((item, i, all) => !i || item.t >= all[i - 1].t));
  await recorder.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('gateway records real request context without exposing client key', async (t) => {
  const { startTestGateway, request } = await import('./helpers.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-gateway-'));
  const ctx = await startTestGateway({ rootDir: root, behavior: { sseChunks: [{ id: 'usage-test', usage: { prompt_tokens: 17, completion_tokens: 9 } }] }, config: { requestLogDir: path.join(root, 'logs'), protectAdminApi: true } });
  t.after(async () => { await ctx.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const setup = await request(`${ctx.baseUrl}/api/auth/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'TestPass123' }) });
  const cookie = setup.headers['set-cookie'].map((value) => value.split(';')[0]).join('; ');
  const clientKey = ctx.localKey;
  const result = await request(`${ctx.baseUrl}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${clientKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'mock-model', messages: [], stream: true }) });
  assert.equal(result.status, 200);
  const logs = await request(`${ctx.baseUrl}/api/admin/logs`, { headers: { cookie } });
  assert.equal(logs.status, 200, logs.body);
  const items = JSON.parse(logs.body).items;
  assert.equal(items.length, 1);
  for (const field of ['model', 'status', 'path', 'keyId', 'keyName', 'accountKeyId', 'accountName', 'ip', 'dur']) assert.ok(items[0][field] !== null && items[0][field] !== '', `${field} must be populated`);
  assert.equal(items[0].model, 'mock-model'); assert.equal(items[0].status, 200); assert.equal(items[0].path, '/v1/chat/completions');
  assert.equal(items[0].keyName, '测试客户端'); assert.equal(items[0].stream, true); assert.equal(items[0].tokensIn, 17); assert.equal(items[0].tokensOut, 9); assert.ok(!logs.body.includes(clientKey));
  const disk = fs.readFileSync(path.join(root, 'logs', `${new Date(items[0].t).getFullYear()}-${String(new Date(items[0].t).getMonth() + 1).padStart(2, '0')}-${String(new Date(items[0].t).getDate()).padStart(2, '0')}.jsonl`), 'utf8');
  assert.ok(!disk.includes(clientKey));
  assert.equal((await request(`${ctx.baseUrl}/api/admin/logs`)).status, 401);
  assert.equal((await request(`${ctx.baseUrl}/api/admin/usage`)).status, 401);
});

test('recent stops reading newest-first once requested page is available', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-scan-'));
  const today = new Date();
  const recentName = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}.jsonl`;
  const oldDate = new Date(today.getTime() - 86400000);
  const oldName = `${oldDate.getFullYear()}-${String(oldDate.getMonth() + 1).padStart(2, '0')}-${String(oldDate.getDate()).padStart(2, '0')}.jsonl`;
  const entry = { t: Date.now(), path: '/x', status: 200 };
  fs.writeFileSync(path.join(dir, recentName), `${JSON.stringify(entry)}\n`);
  fs.writeFileSync(path.join(dir, oldName), `${JSON.stringify({ ...entry, t: entry.t - 86400000 })}\n`);
  const recorder = createUsageRecorder({ dir, retentionDays: 0, noTimers: true });
  assert.equal((await recorder.recent({ limit: 1 })).items.length, 1);
  assert.ok(recorder.stats().scannedFiles <= 1);
  await recorder.close(); fs.rmSync(dir, { recursive: true, force: true });
});


test('gateway records upstream 5xx reason without exposing client key', async (t) => {
  const { startTestGateway, request } = await import('./helpers.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-5xx-'));
  const ctx = await startTestGateway({ rootDir: root, config: { requestLogDir: path.join(root, 'logs'), protectAdminApi: true } });
  ctx.upstream.setBehavior({ failNext5xx: 20 });
  t.after(async () => { await ctx.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const setup = await request(`${ctx.baseUrl}/api/auth/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'TestPass123' }) });
  const cookie = setup.headers['set-cookie'].map((value) => value.split(';')[0]).join('; ');
  await request(`${ctx.baseUrl}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${ctx.localKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'mock-model', messages: [] }) });
  const logs = await request(`${ctx.baseUrl}/api/admin/logs`, { headers: { cookie } });
  const item = JSON.parse(logs.body).items[0];
  assert.ok(item.status >= 500);
  assert.ok(item.error && /上游|503|502|mock upstream/i.test(item.error), `unexpected error: ${item.error}`);
  assert.ok(!logs.body.includes(ctx.localKey));
  const filename = `${new Date(item.t).getFullYear()}-${String(new Date(item.t).getMonth() + 1).padStart(2, '0')}-${String(new Date(item.t).getDate()).padStart(2, '0')}.jsonl`;
  assert.ok(!fs.readFileSync(path.join(root, 'logs', filename), 'utf8').includes(ctx.localKey));
});

test('admin usage aggregates each key, model, and ascending time bucket', async (t) => {
  const { startTestGateway, request } = await import('./helpers.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-summary-'));
  const logDir = path.join(root, 'logs');
  const recorder = createUsageRecorder({ dir: logDir, noTimers: true });
  const hour = 3600000, now = Date.now(), first = Math.floor((now - hour * 2) / hour) * hour, second = first + hour;
  const records = [
    { t: first + 100, status: 200, keyId: 'k1', keyName: 'one', model: 'm1', tokensIn: 2, tokensOut: 3 },
    { t: first + 200, status: 500, keyId: 'k2', keyName: 'two', model: 'm2', tokensIn: 5, tokensOut: 7 },
    { t: second + 100, status: 200, keyId: 'k1', keyName: 'one', model: 'm2', tokensIn: 11, tokensOut: 13 },
    { t: second + 200, status: 200, keyId: 'k2', keyName: 'two', model: 'm1', tokensIn: 17, tokensOut: 19 },
  ];
  for (const record of records) await recorder.record({ path: '/v1/chat/completions', ...record });
  await recorder.close();
  const ctx = await startTestGateway({ rootDir: root, config: { requestLogDir: logDir, protectAdminApi: true } });
  t.after(async () => { await ctx.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const setup = await request(`${ctx.baseUrl}/api/auth/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'TestPass123' }) });
  const cookie = setup.headers['set-cookie'].map((value) => value.split(';')[0]).join('; ');
  const response = await request(`${ctx.baseUrl}/api/admin/usage?range=24h`, { headers: { cookie } });
  const summary = JSON.parse(response.body);
  assert.equal(response.status, 200);
  assert.deepEqual({ requests: summary.totals.requests, errors: summary.totals.errors, tokensIn: summary.totals.tokensIn, tokensOut: summary.totals.tokensOut }, { requests: 4, errors: 1, tokensIn: 35, tokensOut: 42 });
  const keyView = summary.byKey.map(({ keyId, requests, tokensIn, tokensOut }) => ({ keyId, requests, tokensIn, tokensOut })).sort((a, b) => a.keyId.localeCompare(b.keyId));
  assert.deepEqual(keyView, [{ keyId: 'k1', requests: 2, tokensIn: 13, tokensOut: 16 }, { keyId: 'k2', requests: 2, tokensIn: 22, tokensOut: 26 }]);
  const modelView = summary.byModel.map(({ model, requests, tokensIn, tokensOut }) => ({ model, requests, tokensIn, tokensOut })).sort((a, b) => a.model.localeCompare(b.model));
  assert.deepEqual(modelView, [{ model: 'm1', requests: 2, tokensIn: 19, tokensOut: 22 }, { model: 'm2', requests: 2, tokensIn: 16, tokensOut: 20 }]);
  assert.deepEqual(summary.series.map(({ t, requests, tokensIn, tokensOut }) => ({ t, requests, tokensIn, tokensOut })), [
    { t: first, requests: 2, tokensIn: 7, tokensOut: 10 }, { t: second, requests: 2, tokensIn: 28, tokensOut: 32 },
  ]);
});

test('admin log limit is capped and invalid usage range is rejected', async (t) => {
  const { startTestGateway, request } = await import('./helpers.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-bounds-'));
  const ctx = await startTestGateway({ rootDir: root, config: { requestLogDir: path.join(root, 'logs'), protectAdminApi: true } });
  t.after(async () => { await ctx.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const setup = await request(`${ctx.baseUrl}/api/auth/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'TestPass123' }) });
  const cookie = setup.headers['set-cookie'].map((value) => value.split(';')[0]).join('; ');
  const logs = await request(`${ctx.baseUrl}/api/admin/logs?limit=9999`, { headers: { cookie } });
  assert.equal(logs.status, 200); assert.ok(JSON.parse(logs.body).items.length <= 500);
  const usage = await request(`${ctx.baseUrl}/api/admin/usage?range=bogus`, { headers: { cookie } });
  assert.equal(usage.status, 400);
});

test('recorder removes expired date files and preserves other files', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-retention-'));
  const today = new Date();
  const name = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}.jsonl`;
  const oldOne = new Date(today.getTime() - 3 * 86400000), oldTwo = new Date(today.getTime() - 2 * 86400000);
  const files = [name(oldOne), name(oldTwo), name(today), 'not-a-date.jsonl'];
  for (const file of files) fs.writeFileSync(path.join(dir, file), '{}\n');
  const recorder = createUsageRecorder({ dir, retentionDays: 1, noTimers: true });
  assert.equal(fs.existsSync(path.join(dir, name(oldOne))), false);
  assert.equal(fs.existsSync(path.join(dir, name(oldTwo))), false);
  assert.equal(fs.existsSync(path.join(dir, name(today))), true);
  assert.equal(fs.existsSync(path.join(dir, 'not-a-date.jsonl')), true);
  await recorder.close(); fs.rmSync(dir, { recursive: true, force: true });
});
