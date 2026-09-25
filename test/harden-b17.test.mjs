// 批次 17：后端加固（8 项 medium，全部来自只读审计）
// 约定：每条用例在**未修复**的源码上必须变红（mutation check），修复后全绿。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { startTestGateway, request, sleep } from './helpers.mjs';
import { createProxy } from '../src/proxy.mjs';
import { redact, redactForLog } from '../src/log.mjs';
import { DEFAULTS, loadConfig } from '../src/config.mjs';
import { scryptQueueStats } from '../src/auth.mjs';
import { globalLoginAttemptMax } from '../gateway.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const README = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');

const AUTH = (ctx) => ({ authorization: `Bearer ${ctx.localKey}`, 'content-type': 'application/json' });

/** 初始化后台管理员并返回 session cookie。 */
async function setupAdmin(ctx, user = 'admin', pass = 'hunter2-secret') {
  const res = await request(`${ctx.baseUrl}/api/auth/setup`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: user, password: pass }),
  });
  assert.equal(res.status, 201, `setup 应成功，实际 ${res.status}: ${res.body}`);
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const cookie = (list.find((c) => c.startsWith('cc_session=')) ?? '').split(';')[0];
  assert.ok(cookie, 'setup 应下发 session cookie');
  return cookie;
}

const adminHeaders = (cookie) => ({ cookie, 'content-type': 'application/json' });
const acctList = async (ctx, cookie) => JSON.parse((await request(`${ctx.baseUrl}/api/admin/accounts`, { headers: { cookie } })).body).accounts;

// ── 1：PATCH 不能停用「最后一个可用账号」（与 DELETE 同一守卫）────────────

test('B17-1①：两个启用账号 → PATCH 停用其一 → 200', async (t) => {
  const ctx = await startTestGateway();
  t.after(() => ctx.close());
  const cookie = await setupAdmin(ctx);
  const accounts = await acctList(ctx, cookie);

  const res = await request(`${ctx.baseUrl}/api/admin/accounts/${accounts[0].keyId}`, {
    method: 'PATCH', headers: adminHeaders(cookie), body: JSON.stringify({ enabled: false }),
  });
  assert.equal(res.status, 200, `还有另一个启用账号，停用应成功：${res.body}`);
  assert.equal(JSON.parse(res.body).account.enabled, false);
});

test('B17-1②：唯一启用账号 → PATCH 停用 → 409 且账号未被改动', async (t) => {
  const ctx = await startTestGateway();
  t.after(() => ctx.close());
  const cookie = await setupAdmin(ctx);
  const accounts = await acctList(ctx, cookie);

  // 先停掉 A，只剩 B 一个启用账号
  assert.equal((await request(`${ctx.baseUrl}/api/admin/accounts/${accounts[0].keyId}`, {
    method: 'PATCH', headers: adminHeaders(cookie), body: JSON.stringify({ enabled: false }),
  })).status, 200);

  const res = await request(`${ctx.baseUrl}/api/admin/accounts/${accounts[1].keyId}`, {
    method: 'PATCH', headers: adminHeaders(cookie), body: JSON.stringify({ enabled: false }),
  });
  assert.equal(res.status, 409, `停用最后一个可用账号必须 409，实际 ${res.status}: ${res.body}`);
  assert.match(res.body, /不能停用最后一个可用账号/, '文案要与 DELETE 对齐并说明先启用其它账号');
  assert.match(res.body, /请先启用其它账号/);

  const after = (await acctList(ctx, cookie)).find((a) => a.keyId === accounts[1].keyId);
  assert.equal(after.enabled, true, '被拒后账号状态绝不能被改动');
});

test('B17-1③：PATCH enabled:true 不受该守卫影响', async (t) => {
  const ctx = await startTestGateway();
  t.after(() => ctx.close());
  const cookie = await setupAdmin(ctx);
  const accounts = await acctList(ctx, cookie);

  // 停到只剩 0 个启用账号是不可能的（守卫挡住），所以先停一个，再启用回来
  await request(`${ctx.baseUrl}/api/admin/accounts/${accounts[0].keyId}`, {
    method: 'PATCH', headers: adminHeaders(cookie), body: JSON.stringify({ enabled: false }),
  });
  const res = await request(`${ctx.baseUrl}/api/admin/accounts/${accounts[0].keyId}`, {
    method: 'PATCH', headers: adminHeaders(cookie), body: JSON.stringify({ enabled: true }),
  });
  assert.equal(res.status, 200, `启用方向不受守卫影响：${res.body}`);
  assert.equal(JSON.parse(res.body).account.enabled, true);
});

test('B17-1④：DELETE 既有守卫行为不回归', async (t) => {
  const ctx = await startTestGateway();
  t.after(() => ctx.close());
  const cookie = await setupAdmin(ctx);
  const accounts = await acctList(ctx, cookie);

  // 先停 A → 只剩 B 启用 → 删 B 必须 409（与修复前一致）
  await request(`${ctx.baseUrl}/api/admin/accounts/${accounts[0].keyId}`, {
    method: 'PATCH', headers: adminHeaders(cookie), body: JSON.stringify({ enabled: false }),
  });
  const blocked = await request(`${ctx.baseUrl}/api/admin/accounts/${accounts[1].keyId}`, {
    method: 'DELETE', headers: { cookie },
  });
  assert.equal(blocked.status, 409, `删最后一个可用账号必须 409，实际 ${blocked.status}`);
  assert.match(blocked.body, /不能删除最后一个可用账号/);

  // 两个都启用时删一个 → 200
  await request(`${ctx.baseUrl}/api/admin/accounts/${accounts[1].keyId}`, {
    method: 'PATCH', headers: adminHeaders(cookie), body: JSON.stringify({ enabled: true }),
  });
  const ok = await request(`${ctx.baseUrl}/api/admin/accounts/${accounts[0].keyId}`, {
    method: 'DELETE', headers: { cookie },
  });
  assert.equal(ok.status, 200, `还有可用账号时应能删除：${ok.body}`);
});

// ── 2：请求体读超时（首块后停住不再无限占用在途名额）───────────────────

/** 低层 socket 交换：发 head（+可选 body），由 predicate 决定何时算拿到响应。 */
function rawExchange(port, { head, body = '', after, predicate, timeoutMs = 6000 }) {
  return new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1');
    let buf = '';
    let settled = false;
    let timer = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ sock, raw: buf });
    };
    sock.on('connect', () => {
      sock.write(head);
      if (body) sock.write(body);
      after?.(sock);
    });
    sock.on('data', (c) => {
      buf += c.toString('utf8');
      if (predicate && predicate(buf)) finish();
    });
    sock.on('close', finish);
    sock.on('end', finish);
    sock.on('error', finish);   // 超时后网关会断开 → ECONNRESET 也算拿到响应（buf 已收）
    timer = setTimeout(finish, timeoutMs);
    timer.unref?.();
  });
}

const slowHead = (ctx, contentLength = 100000) => 'POST /v1/chat/completions HTTP/1.1\r\n'
  + 'Host: 127.0.0.1\r\n'
  + `Authorization: Bearer ${ctx.localKey}\r\n`
  + 'Content-Type: application/json\r\n'
  + `Content-Length: ${contentLength}\r\n\r\n`;

test('B17-2①：慢速发体超过期限 → 中止转发并返回 408（可读错误体）', async (t) => {
  const ctx = await startTestGateway({ config: { bodyReadTimeoutMs: 400, bodyPeekStartMs: 200 } });
  t.after(() => ctx.close());

  // 发 1 字节后停住：修复前会永久占住此连接（首块之后的读没有超时）
  const { sock, raw } = await rawExchange(ctx.port, {
    head: slowHead(ctx), body: '{',
    predicate: (b) => b.includes('408 Request Timeout'),
  });
  t.after(() => sock.destroy());

  assert.match(raw, /^HTTP\/1\.1 408 Request Timeout/, `应回 408，实际：${raw.slice(0, 120)}`);
  assert.match(raw, /Request body timeout/, '408 必须带客户端可读的错误体');
  assert.match(raw, /request_timeout/);
  assert.match(raw, /connection: close/i, '超时后应断开连接（不再复用挂着半截 body 的 socket）');
});

test('B17-2②：正常快速请求不受读超时影响', async (t) => {
  const ctx = await startTestGateway({ config: { bodyReadTimeoutMs: 400 } });
  t.after(() => ctx.close());

  const res = await request(`${ctx.baseUrl}/v1/chat/completions`, {
    method: 'POST', headers: AUTH(ctx), body: JSON.stringify({ model: 'mock-model', stream: true }),
  });
  assert.equal(res.status, 200, `快速请求必须照常成功：${res.status}`);
  assert.match(res.body, /\[DONE\]/);
});

test('B17-2③：期限内的慢请求仍能成功（不是一刀切拒绝）', async (t) => {
  const ctx = await startTestGateway({ config: { bodyReadTimeoutMs: 1500, bodyPeekStartMs: 200 } });
  t.after(() => ctx.close());

  const payload = JSON.stringify({ model: 'mock-model', stream: true, messages: [{ role: 'user', content: 'hi' }] });
  const parts = [payload.slice(0, 10), payload.slice(10, 30), payload.slice(30)];
  const { sock, raw } = await rawExchange(ctx.port, {
    head: slowHead(ctx, Buffer.byteLength(payload)),
    body: parts[0],
    after: async (s) => {
      for (const p of parts.slice(1)) { await sleep(80); s.write(p); }
    },
    predicate: (b) => b.includes('[DONE]'),
  });
  t.after(() => sock.destroy());

  assert.match(raw, /^HTTP\/1\.1 200 OK/, `期限内的慢请求应成功，实际：${raw.slice(0, 120)}`);
});

test('B17-2④：超时后 in-flight 名额被释放（后续请求正常通过）', async (t) => {
  const ctx = await startTestGateway({ config: { bodyReadTimeoutMs: 400, bodyPeekStartMs: 200, maxInflight: 8 } });
  t.after(() => ctx.close());

  const { sock, raw } = await rawExchange(ctx.port, {
    head: slowHead(ctx), body: '{',
    predicate: (b) => b.includes('408 Request Timeout'),
  });
  sock.destroy();
  assert.match(raw, /408 Request Timeout/);
  await sleep(50);
  assert.equal(ctx.gateway.proxy.inflightCount(), 0, '超时响应返回后在途计数必须归零');

  const ok = await request(`${ctx.baseUrl}/v1/chat/completions`, {
    method: 'POST', headers: AUTH(ctx), body: JSON.stringify({ model: 'mock-model', stream: true }),
  });
  assert.equal(ok.status, 200, '名额释放后后续请求应正常通过');
});

test('B17-2⑤：bodyReadTimeoutMs / requestTimeoutMs / maxConnections 进 DEFAULTS+ENV_MAP，并真的挂到 server 上', async (t) => {
  assert.equal(DEFAULTS.bodyReadTimeoutMs, 120000);
  assert.equal(DEFAULTS.requestTimeoutMs, 180000);
  assert.equal(DEFAULTS.maxConnections, 512);
  const cfg = loadConfig('/nonexistent/config.json', {
    BODY_READ_TIMEOUT_MS: '1111', REQUEST_TIMEOUT_MS: '2222', MAX_CONNECTIONS: '33',
  });
  assert.equal(cfg.bodyReadTimeoutMs, 1111);
  assert.equal(cfg.requestTimeoutMs, 2222);
  assert.equal(cfg.maxConnections, 33);

  const ctx = await startTestGateway({ config: { requestTimeoutMs: 1234, maxConnections: 7 } });
  t.after(() => ctx.close());
  assert.equal(ctx.gateway.server.maxConnections, 7, 'maxConnections 必须真的设到 server 上');
  assert.ok(ctx.gateway.server.requestTimeout >= 1000, 'requestTimeout 必须显式设置');
  assert.notEqual(ctx.gateway.server.requestTimeout, 300000, '不得沿用 Node 默认的 300s');
  // 不能小于 headersTimeout，否则 Node 会在握手阶段就先断开
  assert.ok(ctx.gateway.server.requestTimeout > ctx.gateway.server.headersTimeout);
  for (const key of ['BODY_READ_TIMEOUT_MS', 'REQUEST_TIMEOUT_MS', 'MAX_CONNECTIONS']) {
    assert.ok(README.includes(key), `README 配置表必须列出 ${key}`);
  }
});

// ── 3：4xx/5xx 终态路径必须排空客户端残体（resume）─────────────────────────
//
// 说明（批次 17b 修正）：本条**不是**在测 bodyState.stop() —— tee 在到达终态分支前
// 已由 563-569 行（「4xx/5xx 归一路径」，5xx 走 554 行）停掉过；终态分支里那处 stop() 只是
// 冗余保险。真正被测的增量是紧随其后的 req.resume()：终态（不重试）后把客户端剩余请求体
// 排空，而不是让它停在暂停态挂在 socket 上。变异验证：删掉这两行本条必须变红。

test('B17-3：上游在请求体收完前回 4xx → 终态路径排空客户端残体（resume，而非停在暂停态）', async (t) => {
  // 自建上游：拿到请求头就立刻回 400，绝不读 body（复现「客户端还在传，上游已回终态」）
  const upstream = http.createServer((req, res) => {
    req.resume();
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'boom' } }));
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  t.after(() => { upstream.closeAllConnections?.(); upstream.close(); });

  const acct = { name: 'A', key: 'user_test_alpha', keyId: 'k-b17-3', enabled: true };
  const scheduler = {
    accounts: [acct], acquire() {}, release() {}, recordError() {},
    isAvailable: () => true, rank: (list) => list, runtime: () => ({}),
  };
  const log = { warn() {}, error() {}, info() {}, debug() {} };
  const stats = { total: 0, errors: 0, totalTokens: 0, aborted: 0, byAccount: {} };
  const proxy = createProxy({
    config: { upstreamProxyUrl: `http://127.0.0.1:${upstream.address().port}`, maxBodyBytes: 1 << 20, maxInflight: 8, bodyReadTimeoutMs: 60000 },
    scheduler, log, stats, secrets: [],
  });

  const res = new EventEmitter();
  res.headersSent = false; res.writableEnded = false; res.destroyed = false;
  res.setHeader = () => {};
  res.writeHead = (status) => { res.status = status; res.headersSent = true; };
  res.end = (body) => { res._body = body; res.writableEnded = true; res.emit('finish'); };

  const req = new PassThrough();
  req.method = 'POST';
  req.headers = { 'content-type': 'application/json' };

  const pending = proxy.forward({ req, res, account: acct, pathname: '/v1/chat/completions', search: '' });
  req.write('{"model":"mock-model"');   // 只发一部分：请求体尚未收完
  // 构造「残体停在暂停态」的前置条件：bodyState.stop() 只 off('data')，并不会把已在
  // flowing 的流切回 paused（实测 off('data') 后 readableFlowing 仍为 true）。真实场景里
  // 上游早回 4xx 时客户端流可能正处暂停/背压态；只有 resume() 才能把它重新排空。
  req.pause();
  await pending;

  assert.equal(res.status, 400, '上游 400 应原样透传');
  assert.equal(req.listenerCount('data'), 0, '终态响应后 body tee 必须已停止（否则字节会继续被 push 进 chunks）');
  // 关键增量：resume() 把残体排空 → 流回到 flowing；只 off('data') 会停在暂停态。
  assert.equal(req.readableFlowing, true, '终态后必须 resume() 排空残体，不能停在暂停态（暂停态下残体会挂在 socket 上）');
  // 再灌一段：flowing 状态下字节被丢弃（readableLength 保持 0），暂停态则会堆进内部缓冲。
  req.write('x'.repeat(10000));
  await sleep(10);
  assert.equal(req.readableLength, 0, '残体必须被排空（readableLength 应为 0，而非堆在暂停的流里）');
  assert.equal(req.listenerCount('data'), 0);
  assert.equal(proxy.inflightCount(), 0, '终态返回后在途名额必须释放');
  req.destroy();
});

// ── 4：畸形路径参数 → 400（不是 500）────────────────────────────────────

test('B17-4：PATCH /api/admin/accounts/% → 400（不是 500），响应体不含堆栈', async (t) => {
  const ctx = await startTestGateway();
  t.after(() => ctx.close());
  const cookie = await setupAdmin(ctx);

  const res = await request(`${ctx.baseUrl}/api/admin/accounts/%`, {
    method: 'PATCH', headers: adminHeaders(cookie), body: JSON.stringify({ enabled: true }),
  });
  assert.equal(res.status, 400, `畸形路径参数必须 400，实际 ${res.status}: ${res.body}`);
  assert.match(res.body, /路径参数编码非法/);
  assert.doesNotMatch(res.body, /URIError|at Object\.|at .*\.mjs:\d+/, '响应体绝不能带堆栈');

  // 同一个辅助函数在其它三处路径参数上同样生效
  for (const [method, url] of [
    ['PATCH', '/api/admin/users/%'], ['DELETE', '/api/admin/users/%'],
    ['DELETE', '/api/admin/accounts/%'], ['DELETE', '/api/admin/keys/%'],
  ]) {
    const r = await request(`${ctx.baseUrl}${url}`, { method, headers: adminHeaders(cookie), body: method === 'PATCH' ? '{}' : undefined });
    assert.equal(r.status, 400, `${method} ${url} 应 400，实际 ${r.status}`);
  }
});

// ── 5：响应体脱敏只做严格兜底，不改写正常文案 ────────────────────────────

test('B17-5①：redact 不改写正常文案（长度超限等真实报错）', () => {
  assert.equal(redact('user_message_length_exceeded'), 'user_message_length_exceeded');
  assert.equal(redact('...user_context_window_exceeded'), '...user_context_window_exceeded');
  assert.equal(
    redact('input too long for model user_context_window_exceeded'),
    'input too long for model user_context_window_exceeded',
  );
});

test('B17-5②：真实形态的假 key（user_ + 24 位以上）仍被掩码', () => {
  const fake = `user_${'A1b2C3d4E5f6G7h8I9j0K1l2m3n4'}`;   // 28 位随机串
  assert.ok(fake.length - 'user_'.length >= 24);
  const masked = redact(`{"authorization":"Bearer ${fake}"}`);
  assert.ok(!masked.includes(fake), `真 key 必须被掩码：${masked}`);
  assert.match(masked, /user_A1b2\*\*\*/);
  // 裸串（行首行尾）同样被抓
  assert.ok(!redact(fake).includes(fake));
  // sk-cg- 本地 key 一样掩码
  assert.ok(!redact('sk-cg-testkey1234567890').includes('testkey1234567890'));
});

test('B17-5③：已知密钥仍被精确替换；日志档保留宽松兜底', () => {
  const known = 'user_abcdefghijklmnopqrstuvwxyz0123456789';
  const out = redact(`failed with ${known} here`, [known]);
  assert.ok(!out.includes(known), '已知密钥必须被精确替换');
  assert.match(out, /user_abcd\*\*\*/);
  // 日志档（宽松）保持历史强度：短前缀的类 key 也会被掩码
  assert.equal(redactForLog('user_message_length_exceeded'), 'user_mess***');
});

// ── 6：名称里的控制字符必须被拒绝 ───────────────────────────────────────

test('B17-6①：新建账号名含 \\n → 400', async (t) => {
  const ctx = await startTestGateway();
  t.after(() => ctx.close());
  const cookie = await setupAdmin(ctx);

  const res = await request(`${ctx.baseUrl}/api/admin/accounts`, {
    method: 'POST', headers: adminHeaders(cookie),
    body: JSON.stringify({ name: 'evil\n2026-09-25 [warn] 伪造日志行', key: 'user_ctrl_nl_aaaaaaaa' }),
  });
  assert.equal(res.status, 400, `含换行的名称必须 400，实际 ${res.status}: ${res.body}`);
  assert.match(res.body, /控制字符/);
});

test('B17-6②：生成客户端 key 时名称含 \\t → 400', async (t) => {
  const ctx = await startTestGateway();
  t.after(() => ctx.close());
  const cookie = await setupAdmin(ctx);

  const res = await request(`${ctx.baseUrl}/api/admin/keys`, {
    method: 'POST', headers: adminHeaders(cookie), body: JSON.stringify({ name: 'key\tname' }),
  });
  assert.equal(res.status, 400, `含制表符的 key 名必须 400，实际 ${res.status}: ${res.body}`);
  assert.match(res.body, /控制字符/);
});

test('B17-6③：正常中文/英文/数字/空格名可用，且事件流里没有被换行拆出的第二行', async (t) => {
  const ctx = await startTestGateway();
  t.after(() => ctx.close());
  const cookie = await setupAdmin(ctx);

  const name = '正式 账号 2026 abc';
  const res = await request(`${ctx.baseUrl}/api/admin/accounts`, {
    method: 'POST', headers: adminHeaders(cookie), body: JSON.stringify({ name, key: 'user_ctrl_ok_aaaaaaaa' }),
  });
  assert.equal(res.status, 201, `正常名称必须可用，实际 ${res.status}: ${res.body}`);

  const hits = ctx.gateway.events.filter((e) => String(e.message).includes(name));
  assert.ok(hits.length >= 1, '创建动作必须进事件流（审计）');
  for (const e of hits) {
    assert.ok(!String(e.message).includes('\n'), `事件消息里不得出现换行（日志注入）：${JSON.stringify(e.message)}`);
  }
});

// ── 7：scrypt 队列有上界 + 全局登录限速按吞吐校准 ─────────────────────────

test('B17-7①：并发灌入登录 → 超出队列上限的请求得到 503（不排队）', async (t) => {
  const ctx = await startTestGateway({
    config: { scryptMaxQueue: 2, loginAttemptsPerMinute: 600, loginGlobalAttemptsPerMinute: 600 },
  });
  t.after(() => ctx.close());
  await setupAdmin(ctx);

  const login = (i) => request(`${ctx.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': `9.9.9.${i}` },
    body: JSON.stringify({ username: 'admin', password: `wrong-pass-${i}` }),
  });
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => login(i)));
  const byCode = results.reduce((m, r) => ({ ...m, [r.status]: (m[r.status] ?? 0) + 1 }), {});

  const rejected = results.filter((r) => r.status === 503);
  assert.ok(rejected.length > 0, `超限必须被拒（503），实际分布 ${JSON.stringify(byCode)}`);
  assert.match(rejected[0].body, /服务器繁忙/);
  assert.equal(rejected[0].headers['retry-after'], '1', '503 必须带 Retry-After');
  for (const r of results) assert.ok([401, 429, 503].includes(r.status), `意外的状态码 ${r.status}: ${r.body}`);

  // ② 队列有界：同时在跑/排队的 hash 不超过 scryptMaxQueue，因此真正算完的请求数也有上界
  const computed = results.filter((r) => r.status === 401).length;
  assert.ok(computed <= 2, `完成的 hash 数不得超过队列上限 2，实际 ${computed}`);
});

test('B17-7②：拒绝不做无用功 —— 拒绝数 + 完成数守恒，队列最终清空', async (t) => {
  const ctx = await startTestGateway({
    config: { scryptMaxQueue: 1, loginAttemptsPerMinute: 600, loginGlobalAttemptsPerMinute: 600 },
  });
  t.after(() => ctx.close());
  await setupAdmin(ctx);

  const t0 = Date.now();
  const results = await Promise.all(Array.from({ length: 10 }, (_, i) => request(`${ctx.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': `7.7.7.${i}` },
    body: JSON.stringify({ username: 'admin', password: `nope-${i}` }),
  })));
  const elapsed = Date.now() - t0;
  assert.equal(results.length, 10);
  assert.ok(results.some((r) => r.status === 503), '队列深度 1 时必然有请求被拒');
  // 有界 → 不会被 FIFO 无限拖长（修复前是「全部排队、串行算完」）
  assert.ok(elapsed < 10000, `有界队列必须快速返回，实际 ${elapsed}ms`);
  assert.equal(scryptQueueStats().pending, 0, '请求处理完后队列必须清空');
});

test('B17-7③：正常单次登录不回归', async (t) => {
  const ctx = await startTestGateway({ config: { scryptMaxQueue: 8 } });
  t.after(() => ctx.close());
  await setupAdmin(ctx);

  const ok = await request(`${ctx.baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'hunter2-secret' }),
  });
  assert.equal(ok.status, 200, `正常登录必须成功：${ok.status} ${ok.body}`);
  assert.match(ok.headers['set-cookie'].toString(), /cc_session=/);
});

test('B17-7④：全局登录上限按实测吞吐校准（不再 per-source×10）', async (t) => {
  // 实测单线程 scrypt(N=2^16) 吞吐 ≈91 次/分钟 → 自动档取 90，而不是 60×10=600
  assert.equal(DEFAULTS.loginGlobalAttemptsPerMinute, 0, '0 = 自动档语义保留');
  assert.equal(globalLoginAttemptMax({}), 90, '自动档必须按吞吐校准，不得是 600');
  assert.equal(globalLoginAttemptMax({ loginAttemptsPerMinute: 60 }), 90);
  assert.equal(globalLoginAttemptMax({ loginGlobalAttemptsPerMinute: 3 }), 3, '显式配置优先');
  assert.equal(globalLoginAttemptMax({ loginAttemptsPerMinute: 200 }), 200, '每来源上限更高时取更高者');
});

// ── 8：审计日志的操作者 IP 取 XFF（与登录日志同口径）────────────────────

test('B17-8：可信来源的 X-Forwarded-For → 审计日志里是客户端 IP，不是 socket 地址', async (t) => {
  const ctx = await startTestGateway();
  t.after(() => ctx.close());
  const cookie = await setupAdmin(ctx);

  const res = await request(`${ctx.baseUrl}/api/admin/keys`, {
    method: 'POST', headers: { ...adminHeaders(cookie), 'x-forwarded-for': '2.2.2.2' },
    body: JSON.stringify({ name: 'xff-审计' }),
  });
  assert.equal(res.status, 201, `创建 key 应成功：${res.body}`);

  const audit = ctx.gateway.events.filter((e) => String(e.message).includes('xff-审计'));
  assert.ok(audit.length >= 1, '审计事件必须存在');
  const line = audit[audit.length - 1].message;
  assert.match(line, /user=admin@2\.2\.2\.2/, `审计行应带 XFF 客户端 IP：${line}`);
  assert.ok(!line.includes('127.0.0.1'), `审计行不得出现 socket 地址：${line}`);
});
