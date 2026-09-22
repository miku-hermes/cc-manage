// 第二轮质检修复的回归测试：F2 / F4 / F5 / F6 / F9 / F10 / F11 / F18
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startTestGateway, request, sleep } from './helpers.mjs';

const AUTH = (ctx) => ({ authorization: `Bearer ${ctx.localKey}`, 'content-type': 'application/json' });
/** POST 到代理路由（request() 默认是 GET，漏写 method 会落到 404 路由）。 */
const post = (ctx, path, { headers = {}, body = '{}' } = {}) =>
  request(`${ctx.baseUrl}${path}`, { method: 'POST', headers: { ...AUTH(ctx), ...headers }, body });

/** 发一个请求但把响应字节当成「流」来读，用来观察连接是否异常中止。 */
function rawRequest(url, { method = 'POST', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, (res) => {
      const chunks = [];
      let aborted = false;
      res.on('data', (c) => chunks.push(c));
      res.on('aborted', () => { aborted = true; });
      res.on('error', () => { aborted = true; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8'), aborted: false }));
      res.on('close', () => {
        if (!res.complete) resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8'), aborted: true });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.end(body);
    else req.end();
  });
}

// ── F2：上游响应流中途断开 → 绝不能给客户端一个「完整的 200」──────────
test('F2：上游流中途断开 → 下游连接异常中止，且统计计入错误（不谎报成功）', async (t) => {
  const ctx = await startTestGateway({ behavior: { abortAfterChunks: 1 } });
  t.after(() => ctx.close());

  const res = await rawRequest(`${ctx.baseUrl}/v1/chat/completions`, {
    headers: AUTH(ctx), body: JSON.stringify({ stream: true }),
  });

  assert.equal(res.aborted, true, '上游断流时下游必须看到连接异常（绝不能是「完整的 200」）');
  assert.ok(res.body.includes('partial-1'), '已收到的分片仍然透传出去（不丢数据）');
  assert.ok(!res.body.includes('[DONE]'), '不该出现任何「正常结束」标志');

  await sleep(50);
  const status = JSON.parse((await request(`${ctx.baseUrl}/api/status`)).body);
  assert.equal(status.stats.errors, 1, '上游中断必须计入 stats.errors');
  assert.equal(status.stats.total, 1, '一个请求只占一行统计');
  const acct = status.accounts.find((a) => a.lastError);
  assert.ok(acct, '必须给账号写上 lastError');
  assert.match(acct.lastError, /响应中断/);
});

test('F2：上游正常发完（含 [DONE]）→ 仍是正常的 200，且不计错误', async (t) => {
  const ctx = await startTestGateway();
  t.after(() => ctx.close());

  const res = await post(ctx, '/v1/chat/completions', { body: JSON.stringify({ stream: true }) });
  assert.equal(res.status, 200);
  assert.ok(res.body.includes('[DONE]'));

  const status = JSON.parse((await request(`${ctx.baseUrl}/api/status`)).body);
  assert.equal(status.stats.errors, 0);
  assert.equal(status.stats.total, 1);
  assert.equal(status.summary.concurrency, 0);
});

// ── F4：线上事故复现 —— 429 普通限流不得让账号停 5 小时 ────────────────
test('F4：429「Rate limit exceeded」不再把账号暂停 5 小时（线上被误停的根因）', async (t) => {
  const ctx = await startTestGateway({ behavior: { rateLimitError: true } });
  t.after(() => ctx.close());

  const res = await post(ctx, '/v1/chat/completions', { body: JSON.stringify({ model: 'mock-model' }) });
  assert.equal(res.status, 429, '限流状态码原样透传给客户端');

  const status = JSON.parse((await request(`${ctx.baseUrl}/api/status`)).body);
  for (const a of status.accounts) {
    assert.equal(a.paused, false, `账号「${a.name}」绝不能被判成额度耗尽（paused）`);
    assert.equal(a.pausedUntil, null, `账号「${a.name}」不得有 pausedUntil`);
  }
  assert.equal(status.summary.paused, 0, 'summary.paused 必须为 0');

  const acct = status.accounts.find((a) => a.lastError);
  assert.match(acct.lastError, /限流/, '错误文案要说明是限流而非额度耗尽');
});

test('F4：普通限流只冷却 60 秒，之后账号自动回到可调度', async (t) => {
  const ctx = await startTestGateway({ behavior: { rateLimitError: true } });
  t.after(() => ctx.close());

  await post(ctx, '/v1/chat/completions');
  const rt = ctx.gateway.scheduler.runtime(ctx.gateway.accounts[0]);
  assert.ok(rt.rateLimitedUntil, '应写入短冷却时间戳');
  const cooldown = rt.rateLimitedUntil - Date.now();
  assert.ok(cooldown > 0 && cooldown <= 60_000, `冷却应在 60 秒内，实际 ${cooldown}ms`);
  assert.equal(rt.pausedUntil, null, '不得写 5 小时暂停');
});

test('F4：额度耗尽（429 明确额度语义）仍应暂停账号 —— 别把该停的漏掉', async (t) => {
  const ctx = await startTestGateway();
  t.after(() => ctx.close());
  ctx.upstream.setBehavior({ rateLimitError: false, quotaError: true });

  const res = await post(ctx, '/v1/chat/completions');
  assert.equal(res.status, 402);

  const status = JSON.parse((await request(`${ctx.baseUrl}/api/status`)).body);
  // 审查 A1：首个账号额度耗尽后会换号重试一次；mock 的额度错误是全局的，
  // 于是第二个账号也被证实耗尽并暂停 —— 两个都该停，不能漏。
  assert.equal(status.summary.paused, 2, '真额度耗尽的两个账号都必须被暂停');
  assert.ok(status.accounts.every((a) => a.paused && a.pausedUntil));
});

test('F4：429 + quota_exceeded 措辞 → 按额度耗尽暂停', async (t) => {
  const ctx = await startTestGateway();
  t.after(() => ctx.close());
  // 直接改 mock：回 429 + 明确额度语义
  ctx.upstream.server.removeAllListeners('request');
  const http2 = await import('node:http');
  ctx.upstream.server.on('request', (req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      const body = JSON.stringify({ error: { message: 'you have exceeded your quota', type: 'quota_exceeded' } });
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end(body);
    });
  });

  const res = await post(ctx, '/v1/chat/completions');
  assert.equal(res.status, 429);
  const status = JSON.parse((await request(`${ctx.baseUrl}/api/status`)).body);
  // 审查 A1：429 额度语义同样触发换号重试 → 两个账号都被上游证实耗尽
  assert.equal(status.summary.paused, 2, '明确额度语义的 429 必须暂停（换号后两个都被证实）');
});

// ── F5：换号重试不得把请求体丢成空体 / 不得绕过 413 ──────────────────
test('F5：客户端分片发超大 body + 上游秒回 503 → 客户端拿到 413，上游绝不收到空体', async (t) => {
  const ctx = await startTestGateway({
    config: { maxBodyBytes: 100_000 },
    behavior: { immediate5xx: 1 },
  });
  t.after(() => ctx.close());

  const total = 200_000;
  const res = await new Promise((resolve) => {
    const req = http.request(`${ctx.baseUrl}/v1/chat/completions`, {
      method: 'POST', headers: { authorization: `Bearer ${ctx.localKey}`, 'content-type': 'application/json' },
    }, (r) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => resolve({ status: r.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      r.on('close', () => resolve({ status: r.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', () => resolve({ status: 0, body: '' }));
    // 分片发：先发头，再慢慢把 body 推过去（上游会在超限前排空失败）
    req.write('{"model":"mock","padding":"');
    let sent = 0;
    const timer = setInterval(() => {
      if (sent >= total) {
        clearInterval(timer);
        req.end('"}');
        return;
      }
      sent += 10_000;
      req.write('x'.repeat(10_000));
    }, 5);
  });

  assert.equal(res.status, 413, `必须明确 413，实际 ${res.status}`);
  // 历史 bug：超限后 bodyState.complete 仍为假 → 第 2 个账号收到 0 字节的空体，
  // 客户端还拿到 200（与请求无关的「成功」）。现在必须 413 且绝不重放空体。
  const attempts = ctx.upstream.seen.filter((s) => s.url.startsWith('/v1/'));
  assert.equal(attempts.length, 1, `超限时不该再换号重放，实际调用 ${attempts.length} 次`);
  assert.deepEqual(ctx.upstream.behavior.bodyBytesSeen, [],
    `上游绝不能收到空体，实际 ${JSON.stringify(ctx.upstream.behavior.bodyBytesSeen)}`);
});

test('F5：超限时 drainRemaining 会置 complete（不再被当成可重放的完整 body）', async (t) => {
  const ctx = await startTestGateway({ config: { maxBodyBytes: 1024 } });
  t.after(() => ctx.close());

  const payload = JSON.stringify({ model: 'mock', padding: 'x'.repeat(5000) });
  const res = await post(ctx, '/v1/chat/completions', { body: payload });
  assert.equal(res.status, 413);
  const status = JSON.parse((await request(`${ctx.baseUrl}/api/status`)).body);
  assert.equal(status.stats.errors <= status.stats.total, true, 'errors 不得超过 total');
});

// ── F6：换号成功后 sessionAffinity 必须指到真正服务的账号 ─────────────
test('F6：换号重试成功后 affinity 指向新账号，下个同 session 请求粘到同一个', async (t) => {
  const ctx = await startTestGateway({ behavior: { failNext5xx: 1 } });
  t.after(() => ctx.close());

  const session = 'sess-failover-1';
  const first = await post(ctx, '/v1/chat/completions', {
    headers: { 'x-session-id': session },
    body: JSON.stringify({ model: 'mock-model' }),
  });
  assert.equal(first.status, 200, '首次 503 后应换号成功');

  const forwarded = ctx.upstream.seen.filter((s) => s.url.startsWith('/v1/'));
  assert.equal(forwarded.length, 2);
  const serving = forwarded[1].headers.authorization;   // 真正服务本次请求的账号
  const affinityKey = ctx.gateway.accounts.find((a) => `Bearer ${a.key}` === serving).keyId;
  assert.equal(ctx.gateway.scheduler.getAffinity(session, Date.now()), affinityKey,
    '换号成功后 affinity 必须指向真正服务的账号（历史 bug：仍指旧账号）');

  // 第二个同 session 请求应粘到同一个账号
  await post(ctx, '/v1/chat/completions', {
    headers: { 'x-session-id': session },
    body: JSON.stringify({ model: 'mock-model' }),
  });
  const forwarded2 = ctx.upstream.seen.filter((s) => s.url.startsWith('/v1/'));
  assert.equal(forwarded2[2].headers.authorization, serving, '同 session 的后续请求必须粘在同一账号');
});

// ── F9：上游 401/403 → 立刻停调度该账号，不再透传 401 ─────────────────
for (const status of [401, 403]) {
  test(`F9：上游 ${status} → 账号标记 authInvalid 并换到健康账号`, async (t) => {
    const ctx = await startTestGateway({ behavior: { authErrorStatus: status } });
    t.after(() => ctx.close());

    const res = await post(ctx, '/v1/chat/completions');
    assert.equal(res.status, status, '状态码原样透传（不伪装成 200/500）');

    const view = JSON.parse((await request(`${ctx.baseUrl}/api/status`)).body);
    assert.equal(view.summary.available, 1, `失效账号必须立刻变成不可调度，实际 available=${view.summary.available}`);
    const invalid = view.accounts.find((a) => a.authInvalid);
    assert.ok(invalid, '必须标记 authInvalid');
    assert.equal(invalid.available, false);
  });
}

// ── F10：统计口径自洽（一个请求只算一次；中止单独计数）────────────────
test('F10：换号失败 + 最终成功 → errors 不得超过 total（历史：total=1 errors=2）', async (t) => {
  const ctx = await startTestGateway({ behavior: { failNext5xx: 1 } });
  t.after(() => ctx.close());

  const res = await post(ctx, '/v1/chat/completions');
  assert.equal(res.status, 200);

  const s = JSON.parse((await request(`${ctx.baseUrl}/api/status`)).body).stats;
  assert.equal(s.total, 1, '一个客户端请求只占一行');
  assert.equal(s.errors, 0, '最终成功就不该记全局错误（换号内部失败只记账号维度）');
  const sumAcctErrors = Object.values(s.byAccount).reduce((n, a) => n + (a.errors ?? 0), 0);
  assert.ok(sumAcctErrors >= 1, '原本失败的那个账号仍要记一次账号级错误');
});

test('F10：客户端主动中止 → 计入 aborted 而不是被算成成功', async (t) => {
  const ctx = await startTestGateway({ behavior: { chunkDelayMs: 200 } });
  t.after(() => ctx.close());

  await new Promise((resolve) => {
    const req = http.request(`${ctx.baseUrl}/v1/chat/completions`, {
      method: 'POST', headers: AUTH(ctx),
    }, (res) => {
      // 首字节一到就掐断（模拟长回答被 Ctrl-C）
      res.on('data', () => { req.destroy(); resolve(); });
      res.on('end', resolve);
    });
    req.on('error', () => resolve());
    req.end('{"model":"mock"}');
    setTimeout(resolve, 1500);
  });
  await sleep(300);

  const stats = JSON.parse((await request(`${ctx.baseUrl}/api/status`)).body).stats;
  assert.equal(stats.total, 1);
  assert.equal(stats.errors, 0, '客户端 Ctrl-C 不是上游错误');
  assert.equal(stats.aborted, 1, '中止必须单独计数（历史 bug：被记成成功）');
});

// ── F11：慢速 body 也要尽早建立上游连接 ───────────────────────────────
test('F11：慢速分片 body —— 上游在 body 发完之前就收到数据（不再等整个 body）', async (t) => {
  const ctx = await startTestGateway();
  t.after(() => ctx.close());

  const startedAt = Date.now();
  await new Promise((resolve) => {
    const req = http.request(`${ctx.baseUrl}/v1/chat/completions`, {
      method: 'POST', headers: AUTH(ctx),
    }, (res) => { res.on('data', () => {}); res.on('end', resolve); res.on('close', resolve); });
    req.on('error', resolve);
    req.write('{"model":"mock","conversation_id":"conv-slow-11","padding":"');
    let n = 0;
    const timer = setInterval(() => {
      n += 1;
      if (n >= 5) { clearInterval(timer); req.end('"}'); return; }
      req.write('y'.repeat(1024));
    }, 300);
  });

  // 上游首次收到数据的时间必须显著早于 body 发完（约 5×300 = 1500ms）
  const firstSeenTs = ctx.upstream.behavior.firstDataAt ?? null;
  const elapsed = Date.now() - startedAt;
  assert.ok(firstSeenTs !== null, '上游应收到请求');
  const firstSeenDelay = firstSeenTs - startedAt;
  assert.ok(firstSeenDelay < elapsed - 300,
    `上游首字节应在 body 发完之前到达（首字节 ${firstSeenDelay}ms，整体 ${elapsed}ms）`);
});

// ── F18：在途上限 ────────────────────────────────────────────────────
test('F18：超过在途上限的请求被拒（503 + Retry-After），不会把内存打爆', async (t) => {
  const ctx = await startTestGateway({ config: { maxInflight: 2 }, behavior: { delayMs: 400 } });
  t.after(() => ctx.close());

  const fire = () => post(ctx, '/v1/chat/completions');
  const two = [fire(), fire()];
  await sleep(80);
  const third = await fire();
  assert.equal(third.status, 503, '超出在途上限必须 503');
  assert.equal(third.headers['retry-after'], '1');
  assert.equal(JSON.parse(third.body).error.type, 'overloaded');
  await Promise.all(two);

  // 释放后又能正常处理
  await sleep(150);
  assert.equal((await fire()).status, 200, '在途数回落后应恢复正常');
});

test('F18：默认 maxBodyBytes 收到 8MB，maxInflight 默认 8', async (t) => {
  const ctx = await startTestGateway();
  t.after(() => ctx.close());
  assert.equal(ctx.gateway.config.maxBodyBytes, 8 * 1024 * 1024);
  assert.equal(ctx.gateway.config.maxInflight, 8);
  assert.equal(ctx.gateway.proxy.maxInflight, 8);
});

test('F5：未超限时换号重试仍然完整重放请求体（别把修复做过头）', async (t) => {
  const ctx = await startTestGateway({ config: { maxBodyBytes: 200_000 }, behavior: { failNext5xx: 1 } });
  t.after(() => ctx.close());

  const payload = JSON.stringify({ model: 'mock-model', padding: 'z'.repeat(50_000) });
  const res = await post(ctx, '/v1/chat/completions', { body: payload });
  assert.equal(res.status, 200, '首次 503 后应换号成功');

  const forwarded = ctx.upstream.seen.filter((s) => s.url.startsWith('/v1/'));
  assert.equal(forwarded.length, 2);
  assert.equal(forwarded[1].body, payload, '重放给第 2 个账号的 body 必须与客户端发出的一致');
});
