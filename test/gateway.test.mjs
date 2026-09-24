// §8-3 网关集成：起真实 HTTP 服务，上游指向 mock
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import vm from 'node:vm';
import { startTestGateway, request, sleep, createDomShim, runInlineScript, pageSource } from './helpers.mjs';

test('鉴权：无 key → 401，错的 sk-cg- key → 401，正确 key → 200', async (t) => {
  const ctx = await startTestGateway();
  t.after(() => ctx.close());

  const noKey = await request(`${ctx.baseUrl}/v1/chat/completions`, { method: 'POST', body: '{}' });
  assert.equal(noKey.status, 401);

  const wrongKey = await request(`${ctx.baseUrl}/v1/chat/completions`, {
    method: 'POST', headers: { authorization: 'Bearer sk-cg-wrongkey000' }, body: '{}',
  });
  assert.equal(wrongKey.status, 401);

  const ok = await request(`${ctx.baseUrl}/v1/chat/completions`, {
    method: 'POST', headers: { authorization: `Bearer ${ctx.localKey}`, 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(ok.status, 200);

  // x-api-key 也应当被接受（Anthropic SDK 风格）
  const viaXApiKey = await request(`${ctx.baseUrl}/v1/chat/completions`, {
    method: 'POST', headers: { 'x-api-key': ctx.localKey, 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(viaXApiKey.status, 200);
});

test('转发时上游收到的是池内 CC key，而不是客户端的 sk-cg- key', async (t) => {
  const ctx = await startTestGateway();
  t.after(() => ctx.close());

  const res = await request(`${ctx.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ctx.localKey}`, 'content-type': 'application/json', 'x-api-key': ctx.localKey },
    body: JSON.stringify({ model: 'mock-model', messages: [] }),
  });
  assert.equal(res.status, 200);

  const forwarded = ctx.upstream.seen.filter((s) => s.url.startsWith('/v1/'));
  assert.equal(forwarded.length, 1);
  const got = forwarded[0].headers.authorization;
  assert.match(got, /^Bearer user_/, '上游 authorization 必须是池内 CC key');
  assert.ok(!got.includes('sk-cg-'), '绝不能把本地 key 透传给上游');
  assert.ok(['Bearer user_test_alpha', 'Bearer user_test_beta'].includes(got), `实际收到 ${got}`);
  // user-agent 必须被改写成 CLI UA（Cloudflare 会拦其它 UA）
  assert.equal(forwarded[0].headers['user-agent'], 'commandcode-cli/1.53.1');
  // body 也要完整转发
  assert.match(forwarded[0].body, /mock-model/);
});

test('SSE 流式：客户端按序收到 3 个 data: 事件 + [DONE]', async (t) => {
  const ctx = await startTestGateway();
  t.after(() => ctx.close());

  const res = await request(`${ctx.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ctx.localKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ stream: true }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'text/event-stream');

  const events = res.body.split('\n\n').filter((s) => s.startsWith('data: '));
  assert.equal(events.length, 4, `应有 3 个 chunk + 1 个 [DONE]，实际 ${events.length}`);
  assert.ok(events[0].includes('你好'));
  assert.ok(events[1].includes('，世界'));
  assert.equal(events[3], 'data: [DONE]');
  // 归属正确：mock 只收到一次 /v1 请求
  assert.equal(ctx.upstream.seen.filter((s) => s.url.startsWith('/v1/')).length, 1);
});

test('/api/status 里不含任何 key 片段（连 keyPrefix 都不下发）', async (t) => {
  const ctx = await startTestGateway();
  t.after(() => ctx.close());

  await ctx.gateway.refreshAll();
  const res = await request(`${ctx.baseUrl}/api/status`);
  assert.equal(res.status, 200);

  const body = res.body;
  // 完整 key 绝不能出现
  assert.ok(!body.includes('user_test_alpha'), '不得出现完整账号 key');
  assert.ok(!body.includes('user_test_beta'), '不得出现完整账号 key');
  assert.ok(!body.includes(ctx.localKey), '不得出现本地 key');
  assert.ok(!/user_[A-Za-z0-9_-]{9,}/.test(body), '不得出现任何完整 user_ key');

  const data = JSON.parse(body);
  const alpha = data.accounts.find((a) => a.name === '账号A');
  assert.ok(alpha, '应包含账号A');
  // 公开面板只给备注名/额度，不下发 key 的任何片段（keyPrefix 是真实 key 前 9 字符）
  assert.equal(alpha.keyPrefix, undefined, '公开视图不得下发 keyPrefix');
  assert.equal(alpha.key, undefined, '公开视图不得下发 key');
  assert.ok(!body.includes('user_test'), '响应体里不得出现 key 前缀');
  assert.match(alpha.keyId, /^[A-Za-z0-9]{8}$/);
  assert.equal(alpha.lastQuota.ok, true);
  assert.equal(alpha.lastQuota.remaining, 55);          // 42.5 + 10 + 2.5
  assert.equal(alpha.key, undefined, 'status 里不允许有 key 字段');

  // 统计口径
  assert.equal(typeof data.stats.total, 'number');
  assert.equal(data.summary.accounts, 2);
});

test('/health 无 key 也能访问，且返回 ok / accounts / available', async (t) => {
  const ctx = await startTestGateway();
  t.after(() => ctx.close());

  const res = await request(`${ctx.baseUrl}/health`);
  assert.equal(res.status, 200);
  const data = JSON.parse(res.body);
  assert.equal(data.ok, true);
  assert.equal(data.accounts, 2);
  assert.equal(data.available, 2);
});

test('GET / 能打开面板，含账号卡片与 5h/周/月进度条骨架', async (t) => {
  const ctx = await startTestGateway();
  t.after(() => ctx.close());

  const res = await request(`${ctx.baseUrl}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /text\/html/);
  assert.match(res.body, /cc-manage/);
  assert.match(pageSource(res.body), /5 小时窗口/);
  assert.match(pageSource(res.body), /本周窗口/);
  assert.match(pageSource(res.body), /本月周期/);
  assert.match(pageSource(res.body), /\/api\/status/);
});

test('413：请求体超过 maxBodyBytes 被拒', async (t) => {
  const ctx = await startTestGateway({ config: { maxBodyBytes: 2048 } });
  t.after(() => ctx.close());

  const huge = 'x'.repeat(8192);
  const res = await request(`${ctx.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ctx.localKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'mock', padding: huge }),
  });
  assert.equal(res.status, 413);
});

test('上游 5xx 且未写出字节时换号重试一次', async (t) => {
  const ctx = await startTestGateway({ behavior: { failNext5xx: 1 } });
  t.after(() => ctx.close());

  const res = await request(`${ctx.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ctx.localKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'mock-model' }),
  });
  assert.equal(res.status, 200, '首次 503 后应换号重试成功');

  const forwarded = ctx.upstream.seen.filter((s) => s.url.startsWith('/v1/'));
  assert.equal(forwarded.length, 2, '应当正好重试一次');
  assert.notEqual(forwarded[0].headers.authorization, forwarded[1].headers.authorization, '重试要换一个账号');
  // 重试时 body 必须完整重放（不能因为已流过就变空）
  assert.match(forwarded[1].body, /mock-model/, '重试请求体需完整重放');
});

test('上游 4xx 原样透传状态码，且 body 里的 key 被脱敏', async (t) => {
  const ctx = await startTestGateway({ behavior: { quotaError: true } });
  t.after(() => ctx.close());

  const res = await request(`${ctx.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ctx.localKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'mock-model' }),
  });
  assert.equal(res.status, 402);
  assert.ok(!res.body.includes('user_test_'), '上游 body 里若含 key 必须脱敏');
});

test('402 额度耗尽 → 换号重试（两个账号都被证实耗尽）', async (t) => {
  const ctx = await startTestGateway({ behavior: { quotaError: true } });
  t.after(() => ctx.close());

  const first = await request(`${ctx.baseUrl}/v1/chat/completions`, {
    method: 'POST', headers: { authorization: `Bearer ${ctx.localKey}`, 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(first.status, 402);

  // 审查 A1：首个账号 402 后会在同一请求内换号重试，客户端不该白吃这个错误；
  // mock 的额度错误是全局的，因此第二个账号也被证实耗尽并暂停。
  const forwarded = ctx.upstream.seen.filter((s) => s.url.startsWith('/v1/'));
  assert.equal(forwarded.length, 2, '应换号重试一次');
  assert.notEqual(forwarded[0].headers.authorization, forwarded[1].headers.authorization);

  const status = JSON.parse((await request(`${ctx.baseUrl}/api/status`)).body);
  const paused = status.accounts.filter((a) => a.paused);
  assert.equal(paused.length, 2, '两个账号都真耗尽，都应暂停');
});

test('GET /v1/models 被转发给内核', async (t) => {
  const ctx = await startTestGateway();
  t.after(() => ctx.close());

  const res = await request(`${ctx.baseUrl}/v1/models`, { headers: { authorization: `Bearer ${ctx.localKey}` } });
  assert.equal(res.status, 200);
  assert.match(res.body, /mock-model/);
  assert.equal(ctx.upstream.seen.filter((s) => s.url.startsWith('/v1/models')).length, 1);
});

test('/api/accounts 只读列表不含明文 key；/api/accounts/refresh 返回新快照', async (t) => {
  const ctx = await startTestGateway();
  t.after(() => ctx.close());

  const list = await request(`${ctx.baseUrl}/api/accounts`);
  assert.equal(list.status, 200);
  assert.ok(!list.body.includes('user_test_alpha'));
  const parsed = JSON.parse(list.body);
  assert.equal(parsed.accounts.length, 2);
  for (const a of parsed.accounts) {
    assert.equal(a.key, undefined);
    assert.match(a.keyId, /^[0-9a-f]{8}$/);
  }

  const refreshed = await request(`${ctx.baseUrl}/api/accounts/refresh`, { method: 'POST' });
  assert.equal(refreshed.status, 200);
  const data = JSON.parse(refreshed.body);
  assert.equal(data.ok, true);
  assert.ok(data.accounts.every((a) => a.lastQuota && a.lastQuota.ok), '刷新后每个账号都该有额度快照');
});

test('粘性路由：带 x-session-id 时复用同一账号', async (t) => {
  const ctx = await startTestGateway();
  t.after(() => ctx.close());

  const send = (sessionId) => request(`${ctx.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ctx.localKey}`, 'content-type': 'application/json', 'x-session-id': sessionId },
    body: '{}',
  });
  for (let i = 0; i < 3; i++) await send('sess-sticky-1');
  const forwarded = ctx.upstream.seen.filter((s) => s.url.startsWith('/v1/'));
  assert.equal(forwarded.length, 3);
  const keys = new Set(forwarded.map((f) => f.headers.authorization));
  assert.equal(keys.size, 1, '同一 session 的请求必须全部落在同一账号');
});

test('body 里的 conversation_id 也能驱动粘性路由', async (t) => {
  const ctx = await startTestGateway();
  t.after(() => ctx.close());

  const send = () => request(`${ctx.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ctx.localKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ conversation_id: 'conv-xyz', model: 'mock-model' }),
  });
  for (let i = 0; i < 3; i++) await send();
  const keys = new Set(ctx.upstream.seen.filter((s) => s.url.startsWith('/v1/')).map((f) => f.headers.authorization));
  assert.equal(keys.size, 1, '同一 conversation_id 必须落在同一账号');
  assert.ok(ctx.upstream.seen.filter((s) => s.url.startsWith('/v1/')).every((f) => f.body.includes('conv-xyz')), 'peek 过的 body 必须完整转发给上游');
});

test('5h 打满的账号不会被选中', async (t) => {
  const ctx = await startTestGateway({
    plans: { 'user_test_gamma': { fiveHour: { used: 100, cap: 100 }, weekly: { used: 100, cap: 500 } } },
    accounts: [
      { name: '满号', key: 'user_test_gamma', enabled: true },
      { name: '空号', key: 'user_test_alpha', enabled: true },
    ],
  });
  t.after(() => ctx.close());

  await ctx.gateway.refreshAll();
  const res = await request(`${ctx.baseUrl}/v1/chat/completions`, {
    method: 'POST', headers: { authorization: `Bearer ${ctx.localKey}`, 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(res.status, 200);
  const forwarded = ctx.upstream.seen.filter((s) => s.url.startsWith('/v1/'));
  assert.equal(forwarded[0].headers.authorization, 'Bearer user_test_alpha', '不能选中已打满的账号');
});

test('allowPassthrough=true 时 user_ 开头的 key 直接原样透传', async (t) => {
  const ctx = await startTestGateway({ config: { allowPassthrough: true } });
  t.after(() => ctx.close());

  const key = 'user_direct_passthrough_key';
  const res = await request(`${ctx.baseUrl}/v1/chat/completions`, {
    method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(res.status, 200);
  const forwarded = ctx.upstream.seen.filter((s) => s.url.startsWith('/v1/'));
  assert.equal(forwarded[0].headers.authorization, `Bearer ${key}`, '透传模式下应原样使用客户端给的 key');
});

test('allowPassthrough=false（默认）时 user_ key 不生效', async (t) => {
  const ctx = await startTestGateway();
  t.after(() => ctx.close());

  const res = await request(`${ctx.baseUrl}/v1/chat/completions`, {
    method: 'POST', headers: { authorization: 'Bearer user_some_direct_key' }, body: '{}',
  });
  assert.equal(res.status, 401);
});

test('客户端中途断开 → 上游请求被 abort（不会留下泄漏的在途计数）', async (t) => {
  const ctx = await startTestGateway({ behavior: { delayMs: 300 } });
  t.after(() => ctx.close());

  await new Promise((resolve) => {
    const req = http.request(`${ctx.baseUrl}/v1/chat/completions`, {
      method: 'POST', headers: { authorization: `Bearer ${ctx.localKey}`, 'content-type': 'application/json' },
    });
    req.on('error', () => resolve());
    req.write('{"model":"mock"}');
    setTimeout(() => { req.destroy(); resolve(); }, 80);
  });
  await sleep(400);

  const status = JSON.parse((await request(`${ctx.baseUrl}/api/status`)).body);
  assert.equal(status.summary.concurrency, 0, '断开后所有在途计数必须归零');
});

test('不存在的路径 → 404', async (t) => {
  const ctx = await startTestGateway();
  t.after(() => ctx.close());
  const res = await request(`${ctx.baseUrl}/nope`);
  assert.equal(res.status, 404);
});

test('账号池为空时 /health 仍可用，业务请求返回 503', async (t) => {
  const ctx = await startTestGateway({ accounts: [] });
  t.after(() => ctx.close());

  const health = await request(`${ctx.baseUrl}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(JSON.parse(health.body), { ok: true, accounts: 0, available: 0 });

  const res = await request(`${ctx.baseUrl}/v1/chat/completions`, {
    method: 'POST', headers: { authorization: `Bearer ${ctx.localKey}`, 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(res.status, 503);
});

test('超过 64KB 的请求体被完整转发（peek 不能截断 body）', async (t) => {
  const ctx = await startTestGateway();
  t.after(() => ctx.close());

  const marker = 'TAIL-MARKER-9f8e7d6c';
  const padding = 'y'.repeat(200 * 1024);           // 远大于 peek 的 64KB 上限
  const payload = JSON.stringify({ model: 'mock-model', padding, conversation_id: 'conv-big', tail: marker });

  const res = await request(`${ctx.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ctx.localKey}`, 'content-type': 'application/json' },
    body: payload,
  });
  assert.equal(res.status, 200);

  const forwarded = ctx.upstream.seen.filter((s) => s.url.startsWith('/v1/'));
  assert.equal(forwarded.length, 1);
  assert.equal(forwarded[0].body, payload, '上游收到的请求体必须与客户端发出的完全一致');
  assert.match(forwarded[0].body, /TAIL-MARKER-9f8e7d6c/);
});

test('并发请求会按在途数分散到不同账号', async (t) => {
  const ctx = await startTestGateway({ behavior: { delayMs: 120 } });
  t.after(() => ctx.close());

  const one = request(`${ctx.baseUrl}/v1/chat/completions`, {
    method: 'POST', headers: { authorization: `Bearer ${ctx.localKey}`, 'content-type': 'application/json' }, body: '{}',
  });
  await sleep(40);
  const two = request(`${ctx.baseUrl}/v1/chat/completions`, {
    method: 'POST', headers: { authorization: `Bearer ${ctx.localKey}`, 'content-type': 'application/json' }, body: '{}',
  });
  await Promise.all([one, two]);

  const used = new Set(ctx.upstream.seen.filter((s) => s.url.startsWith('/v1/')).map((f) => f.headers.authorization));
  assert.equal(used.size, 2, '在途数低的账号应被优先选中，两个并发请求应落到两个账号');

  const status = JSON.parse((await request(`${ctx.baseUrl}/api/status`)).body);
  assert.equal(status.summary.concurrency, 0, '请求结束后在途数必须归零');
  assert.equal(status.stats.total, 2);
});

test('错误统计：上游 5xx 且无可重试账号时计入 errors', async (t) => {
  // 单账号池 + 上游持续 503 → 换号无门，最终 502
  const solo = await startTestGateway({
    accounts: [{ name: '独苗', key: 'user_test_alpha' }],
    behavior: { failNext5xx: 99 },
  });
  t.after(() => solo.close());

  const res = await request(`${solo.baseUrl}/v1/chat/completions`, {
    method: 'POST', headers: { authorization: `Bearer ${solo.localKey}`, 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(res.status, 502);

  const status = JSON.parse((await request(`${solo.baseUrl}/api/status`)).body);
  assert.ok(status.stats.errors >= 1, '失败请求必须计入错误数');
});

test('请求头白名单：脱敏后转发，且下游 authorization 一定被替换掉', async (t) => {
  const ctx = await startTestGateway();
  t.after(() => ctx.close());

  await request(`${ctx.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${ctx.localKey}`,
      'x-api-key': ctx.localKey,          // 也必须被丢掉
      'content-type': 'application/json',
      accept: 'text/event-stream',
      'x-session-id': 'sess-headers',
      'user-agent': 'my-custom-client/1.0',
      'x-extra-secret': 'should-not-be-forwarded',
      cookie: 'session=private',
    },
    body: '{}',
  });

  const f = ctx.upstream.seen.find((s) => s.url.startsWith('/v1/'));
  assert.equal(f.headers.authorization.startsWith('Bearer user_'), true);
  assert.equal(f.headers['x-api-key'], undefined, 'x-api-key 不得透传');
  assert.equal(f.headers['x-extra-secret'], undefined);
  assert.equal(f.headers.cookie, undefined);
  assert.equal(f.headers['user-agent'], 'commandcode-cli/1.53.1', 'UA 必须被改写');
  assert.equal(f.headers.accept, 'text/event-stream');
  assert.equal(f.headers['x-session-id'], 'sess-headers');
  assert.equal(f.headers['content-type'], 'application/json');
});

test('未知本地 key 前缀（既非 sk-cg- 也非 user_）→ 401', async (t) => {
  const ctx = await startTestGateway({ config: { allowPassthrough: true } });
  t.after(() => ctx.close());

  const res = await request(`${ctx.baseUrl}/v1/chat/completions`, {
    method: 'POST', headers: { authorization: 'Bearer some-random-key' }, body: '{}',
  });
  assert.equal(res.status, 401, '透传模式只放行 user_ 开头的 key');
});

test('大 body（>64KB）遇到 5xx 换号重试时，body 仍能完整重放', async (t) => {
  const ctx = await startTestGateway({ behavior: { failNext5xx: 1 } });
  t.after(() => ctx.close());

  const marker = 'BIG-BODY-TAIL-c3b2a1';
  const payload = JSON.stringify({ model: 'mock-model', padding: 'z'.repeat(200 * 1024), tail: marker });
  const res = await request(`${ctx.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ctx.localKey}`, 'content-type': 'application/json' },
    body: payload,
  });
  assert.equal(res.status, 200);

  const forwarded = ctx.upstream.seen.filter((s) => s.url.startsWith('/v1/'));
  assert.equal(forwarded.length, 2, '第一次 503 后应重试一次');
  assert.equal(forwarded[0].body, payload, '第一次转发 body 要完整');
  assert.equal(forwarded[1].body, payload, '重试时 body 必须完整重放（含 64KB 之后的尾部）');
});

test('面板数据契约：/api/status 提供 index.html 读取的全部字段', async (t) => {
  const ctx = await startTestGateway();
  t.after(() => ctx.close());
  await ctx.gateway.refreshAll();

  const d = JSON.parse((await request(`${ctx.baseUrl}/api/status`)).body);

  // 顶部统计卡片
  for (const k of ['accounts', 'available', 'paused', 'concurrency']) {
    assert.equal(typeof d.summary[k], 'number', `summary.${k} 必须是数字`);
  }
  for (const k of ['total', 'errors', 'totalTokens']) {
    assert.equal(typeof d.stats[k], 'number', `stats.${k} 必须是数字`);
  }
  // M1：匿名 /api/status 不再下发上游拓扑（内核地址 / 网关 host:port）
  assert.equal(d.upstreamProxyUrl, undefined, '不得下发上游内核地址');
  assert.equal(d.gateway, undefined, '不得下发网关 host/port');
  assert.equal(typeof d.allowPassthrough, 'boolean');
  assert.equal(typeof d.now, 'number');

  // 账号卡片
  assert.ok(d.accounts.length > 0);
  for (const a of d.accounts) {
    assert.equal(typeof a.name, 'string');
    assert.match(a.keyId, /^[0-9a-f]{8}$/);
    assert.equal(a.keyPrefix, undefined, '公开视图不得下发 keyPrefix（真实 key 前 9 字符）');
    assert.equal(typeof a.enabled, 'boolean');
    assert.equal(typeof a.available, 'boolean');
    assert.equal(typeof a.concurrency, 'number');
    assert.equal(typeof a.paused, 'boolean');
    assert.equal(typeof a.authInvalid, 'boolean');

    const q = a.lastQuota;
    assert.ok(q, '刷新后必须有额度快照');
    for (const k of ['monthlyCredits', 'purchasedCredits', 'freeCredits', 'remaining']) {
      assert.equal(typeof q.credits[k], 'number', `lastQuota.credits.${k} 必须是数字`);
    }
    assert.equal(typeof q.remaining, 'number');
    for (const w of ['fiveHour', 'weekly', 'monthly']) {
      assert.ok(q[w], `缺少 ${w} 窗口（面板要画进度条）`);
      assert.equal(typeof q[w].used, 'number');
      assert.equal(typeof q[w].cap, 'number');
      assert.equal(typeof q.percent[w], 'number', `percent.${w} 必须是数字供进度条使用`);
    }
    assert.equal(typeof q.usage.totalTokens, 'number');
  }

  // 面板 HTML 就是从这个接口取数的
  assert.match(pageSource((await request(`${ctx.baseUrl}/`)).body), /'\/api\/status'/);
});

test('面板新鲜度：/api/status 的每个额度快照都带可解析的 fetchedAt', async (t) => {
  const ctx = await startTestGateway();
  t.after(() => ctx.close());
  const before = Date.now();
  await ctx.gateway.refreshAll();
  const after = Date.now();

  const d = JSON.parse((await request(`${ctx.baseUrl}/api/status`)).body);
  assert.ok(d.accounts.length > 0);
  for (const a of d.accounts) {
    assert.equal(typeof a.lastQuota.fetchedAt, 'number', '前台靠 fetchedAt 算「xx 秒前」');
    assert.ok(a.lastQuota.fetchedAt >= before && a.lastQuota.fetchedAt <= after,
      'fetchedAt 应是本次刷新的时间戳（毫秒）');
  }
});

test('/api/status 暴露 quotaPoll 配置，供前端推导「过旧」阈值（避免阈值写死）', async (t) => {
  const ctx = await startTestGateway({
    config: { quotaPollIntervalMs: 600000, quotaActivePollIntervalMs: 60000, quotaActiveWindowMs: 300000 },
  });
  t.after(() => ctx.close());

  const d = JSON.parse((await request(`${ctx.baseUrl}/api/status`)).body);
  assert.ok(d.quotaPoll, '/api/status 必须带 quotaPoll，否则前端只能写死阈值');
  assert.equal(d.quotaPoll.idleIntervalMs, 600000, '空闲间隔要如实暴露');
  assert.equal(d.quotaPoll.activeIntervalMs, 60000);
  assert.equal(d.quotaPoll.activeWindowMs, 300000);
  // 前端算的阈值 = 2 倍空闲间隔；这里只锁契约，不锁页面实现
  assert.ok(d.quotaPoll.idleIntervalMs * 2 > d.quotaPoll.activeWindowMs,
    '2 倍空闲间隔应大于活跃窗，否则空闲态快照会被误判为过旧');
});

test('自适应轮询：活跃用 60s、空闲用 300s，且代理请求会 touchActivity', async (t) => {
  const ctx = await startTestGateway({ config: { quotaPollIntervalMs: 300000, quotaActivePollIntervalMs: 60000, quotaActiveWindowMs: 300000 } });
  t.after(() => ctx.close());

  const p = ctx.gateway.poller;
  assert.equal(p.enabled, true);
  assert.equal(p.isActive(), false, '还没有请求 → 空闲');
  assert.equal(p.nextDelayMs(), 300000, '空闲间隔 = quotaPollIntervalMs');

  // 一次真实代理请求 → 记录活动
  const res = await request(`${ctx.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ctx.localKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'mock-model' }),
  });
  assert.equal(res.status, 200);
  assert.equal(p.isActive(), true, '刚有代理请求 → 活跃');
  assert.equal(p.nextDelayMs(), 60000, '活跃间隔 = quotaActivePollIntervalMs');
});

test('手动刷新进行中时轮询跳过本轮（同一份 refreshAll 不叠加）', async (t) => {
  const ctx = await startTestGateway({
    behavior: { delayMs: 120 },   // 让一轮刷新慢到能撞上下一拍
    config: { quotaPollIntervalMs: 30, quotaTimeoutMs: 5000 },
    noTimers: false,
  });
  t.after(() => ctx.close());

  const p = ctx.gateway.poller;
  const slow = ctx.gateway.refreshAll();       // 模拟手动刷新（约 120ms）
  await sleep(150);                            // 期间轮询应该已经到点好几次
  assert.ok(p.stats.skips >= 1, `手动刷新进行中轮询应跳过，实际 skips=${p.stats.skips}`);
  await slow;
  const before = p.stats.runs;
  await sleep(120);
  assert.ok(p.stats.runs > before, '手动刷新结束后轮询恢复运行');
  p.stop();
});

test('自适应轮询：quotaPollIntervalMs=0 仍然完全关闭（配置默认值兼容老配置）', async (t) => {
  const ctx = await startTestGateway({ config: { quotaPollIntervalMs: 0 } });
  t.after(() => ctx.close());
  assert.equal(ctx.gateway.poller.enabled, false, '0 → 不排任何定时器');
});

/** 轮询是「单个自调度 setTimeout」：真的会按间隔触发 refreshAll（端到端）。 */
test('自适应轮询：定时器真的按间隔触发 refreshAll，stop() 后停止', async (t) => {
  const ctx = await startTestGateway({
    config: { quotaPollIntervalMs: 40, quotaActivePollIntervalMs: 20, quotaActiveWindowMs: 300000 },
    noTimers: false,
  });
  t.after(() => ctx.close());

  const p = ctx.gateway.poller;
  assert.equal(p.enabled, true);
  // 等待预算要留足余量：每轮要打 4 个上游接口，机器高负载（CI/并行任务）时
  // 调度会被拖慢。轮询自身是「跳过重叠轮次」语义（skip-on-overlap），
  // 所以等得久不会多跑出预期外的轮数，只会让 runs 单调增长到至少 2。
  await sleep(400);
  assert.ok(p.stats.runs >= 2, `定时器应至少触发 2 轮，实际 ${p.stats.runs}`);
  const polls = ctx.upstream.requestsTo((r) => r.url.startsWith('/alpha/')).length;
  assert.ok(polls >= 4, `每轮每个账号 4 个接口，应真的打到了上游，实际 ${polls}`);

  ctx.gateway.poller.stop();
  const after = p.stats.runs;
  await sleep(200);
  assert.equal(p.stats.runs, after, 'stop() 之后不能再触发');
});

test('配置默认值：新增的自适应字段有默认值，缺失也不会炸', async (t) => {
  const { loadConfig, DEFAULTS } = await import('../src/config.mjs');
  assert.equal(DEFAULTS.quotaActivePollIntervalMs, 60000);
  assert.equal(DEFAULTS.quotaActiveWindowMs, 300000);
  assert.equal(DEFAULTS.quotaPollIntervalMs, 600000);
  // 空 env + 不存在的 configPath → 全默认
  const cfg = loadConfig('/nonexistent/config.json', {});
  assert.equal(cfg.quotaActivePollIntervalMs, 60000);
  assert.equal(cfg.quotaActiveWindowMs, 300000);
  // 老配置（只有 quotaPollIntervalMs）也能跑
  const ctx = await startTestGateway({ config: { quotaPollIntervalMs: 120000 } });
  t.after(() => ctx.close());
  assert.equal(ctx.gateway.poller.enabled, true);
  assert.equal(ctx.gateway.poller.nextDelayMs(), 120000);
});

// ── token 统计（Bug 1）──────────────────────────────────────────────
test('token 统计：非流式响应里的 total_tokens（下划线）被计入 stats', async (t) => {
  const ctx = await startTestGateway({
    behavior: { usageBody: { usage: { prompt_tokens: 33, completion_tokens: 60, total_tokens: 93 } } },
  });
  t.after(() => ctx.close());

  const res = await request(`${ctx.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ctx.localKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'mock-model' }),
  });
  assert.equal(res.status, 200);

  const status = JSON.parse((await request(`${ctx.baseUrl}/api/status`)).body);
  assert.equal(status.stats.totalTokens, 93, 'total_tokens 必须被统计进来');
  assert.equal(status.stats.total, 1);
  const acct = Object.values(status.stats.byAccount).find((s) => s.requests === 1);
  assert.equal(acct.tokens, 93, '按账号也应累计 token');
});

test('token 统计：流式多分块的累加 total 取最终值（不是相加）', async (t) => {
  const ctx = await startTestGateway({
    behavior: {
      sseChunks: [
        { id: 'c', choices: [{ delta: { content: 'a' } }] },
        { id: 'c', choices: [{ delta: { content: 'b' } }], usage: { total_tokens: 40 } },
        { id: 'c', choices: [{ delta: {}, finish_reason: 'stop' }], usage: { total_tokens: 93 } },
      ],
    },
  });
  t.after(() => ctx.close());

  const res = await request(`${ctx.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ctx.localKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ stream: true }),
  });
  assert.equal(res.status, 200);

  const status = JSON.parse((await request(`${ctx.baseUrl}/api/status`)).body);
  assert.equal(status.stats.totalTokens, 93, '分块累加值取最大（最终值）');
});

test('token 统计：只有 prompt/completion 时求和兜底（驼峰与下划线都认）', async (t) => {
  const ctx = await startTestGateway({
    behavior: { usageBody: { usage: { prompt_tokens: 33, completion_tokens: 60 } } },
  });
  t.after(() => ctx.close());

  await request(`${ctx.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ctx.localKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'mock-model' }),
  });
  let status = JSON.parse((await request(`${ctx.baseUrl}/api/status`)).body);
  assert.equal(status.stats.totalTokens, 93, '33 + 60 = 93');

  // 再来一次驼峰 outputTokens 的响应，应当累加而不是覆盖
  ctx.upstream.setBehavior({ usageBody: { usage: { outputTokens: 7 } } });
  await request(`${ctx.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ctx.localKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'mock-model' }),
  });
  status = JSON.parse((await request(`${ctx.baseUrl}/api/status`)).body);
  assert.equal(status.stats.totalTokens, 100, '第二次的 outputTokens=7 应累加');
});

// ── 管理 API 鉴权（Bug 2 的接口侧）──────────────────────────────────
test('PROTECT_ADMIN_API=1：/api/status 无 key → 401，带本地 key → 200', async (t) => {
  const ctx = await startTestGateway({ config: { protectAdminApi: true } });
  t.after(() => ctx.close());

  const noKey = await request(`${ctx.baseUrl}/api/status`);
  assert.equal(noKey.status, 401, '无 key 必须 401');

  const badKey = await request(`${ctx.baseUrl}/api/status`, { headers: { authorization: 'Bearer sk-cg-totallywrong' } });
  assert.equal(badKey.status, 401, '错 key 必须 401');

  const ok = await request(`${ctx.baseUrl}/api/status`, { headers: { authorization: `Bearer ${ctx.localKey}` } });
  assert.equal(ok.status, 200, '正确 key 必须 200');
  assert.equal(JSON.parse(ok.body).ok, true);

  // 刷新额度接口同样受保护
  assert.equal((await request(`${ctx.baseUrl}/api/accounts/refresh`, { method: 'POST' })).status, 401);
  assert.equal((await request(`${ctx.baseUrl}/api/accounts/refresh`, {
    method: 'POST', headers: { authorization: `Bearer ${ctx.localKey}` },
  })).status, 200);
});

// ── 面板 HTML 契约（Bug 2 / 鉴权重设计）──────────────────────────────
// 测试32 已按 AUTH-REDESIGN.md 改写：前台面板不再要 key（公开只读），
// 改为「无 key 输入框 + 登录后台入口，且取数不携带任何凭证」。
// 后台登录流程本身由 test/auth.test.mjs 覆盖。
test('面板 HTML：公开只读（无 key 输入框 + 登录后台入口）', async (t) => {
  const ctx = await startTestGateway();
  t.after(() => ctx.close());

  const res = await request(`${ctx.baseUrl}/`);
  assert.equal(res.status, 200);
  assert.equal(res.headers['x-content-type-options'], 'nosniff', '面板响应必须带 nosniff');

  const html = res.body;
  // 前台不应该再有 key 输入框，也不该把任何凭证存进 sessionStorage
  assert.doesNotMatch(html, /<input[^>]*id="key"/, '前台不再有 key 输入框');
  assert.doesNotMatch(html, /sessionStorage/, '前台不再把 key 放进 sessionStorage');
  // 右上角改为「登录后台」入口
  assert.match(html, /href="\/admin"/, '前台必须有登录后台入口');
  // 取数走公开 fetch（不携带 Authorization）
  assert.match(pageSource(html), /apiFetch\('\/api\/status'\)/);
  // 额度由后端自适应轮询自动刷新（活跃 60s / 空闲 600s），前台不再提供手动刷新按钮
  assert.doesNotMatch(html, /apiFetch\('\/api\/accounts\/refresh'/,
    '前台不应再有手动刷新按钮——额度由自适应轮询自动同步');
  assert.doesNotMatch(html, /id="refresh"/, '手动刷新按钮已移除');
  assert.ok(!html.includes('Authoriz' + 'ation'), '前台不得再带 Authorization 头');
});

// ── 回归：暂停账号不得被算作可调度 ──────────────────────────────────
// 历史 bug：scheduler.isAvailable(account, now) 依赖 now，而 gateway.mjs 三处调用
// 都漏传 → `pausedUntil > undefined` 恒 false → 暂停判断被静默跳过，
// 前台卡片同时渲染出「可调度」和「暂停至 XX:XX」两个矛盾徽标。
test('暂停中的账号：available 必须为 false，且不计入 summary.available', async (t) => {
  const ctx = await startTestGateway();
  t.after(() => ctx.close());

  // 直接改运行期状态：把「账号A」暂停到 1 小时后
  const target = ctx.gateway.accounts.find((a) => a.name === '账号A');
  const rt = ctx.gateway.scheduler.runtime(target);
  rt.pausedUntil = Date.now() + 3600_000;

  // ① 直接调 isAvailable（不传 now）——这是 gateway 的调用方式，必须也返回 false
  assert.equal(ctx.gateway.scheduler.isAvailable(target), false,
    'isAvailable 漏传 now 时必须仍能识别暂停（now 要有默认值）');
  assert.equal(ctx.gateway.scheduler.isAvailable(target, Date.now()), false, '显式传 now 同样为 false');

  // ② /api/status 的账号视图
  const d = JSON.parse((await request(`${ctx.baseUrl}/api/status`)).body);
  const a = d.accounts.find((x) => x.name === '账号A');
  assert.equal(a.available, false, '暂停账号的 available 必须是 false');
  assert.equal(a.paused, true, '暂停账号的 paused 必须是 true');

  // ③ 汇总数字不得自相矛盾：暂停的账号不能计入 available
  assert.equal(d.summary.paused, 1, 'summary.paused 应为 1');
  assert.equal(d.summary.available, d.summary.accounts - 1,
    'summary.available 不得包含已暂停的账号');

  // ④ 后台视图（accountView）同样要正确
  const { ctx: actx, cookie } = await setupAdminCtxHelper();
  t.after(() => actx.close());
  const art = actx.gateway.scheduler.runtime(actx.gateway.accounts.find((x) => x.name === '账号A'));
  art.pausedUntil = Date.now() + 3600_000;
  const admin = JSON.parse((await request(`${actx.baseUrl}/api/admin/accounts`, { headers: { cookie } })).body);
  const aa = admin.accounts.find((x) => x.name === '账号A');
  assert.equal(aa.available, false, '后台视图的 available 也必须识别暂停');
});

/** 起一个带管理员登录态的网关（后台接口需要 session）。 */
async function setupAdminCtxHelper() {
  const ctx = await startTestGateway();
  const setup = await request(`${ctx.baseUrl}/api/auth/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'TestPass123' }),
  });
  assert.equal(setup.status, 201, '首次初始化管理员返回 201 Created');
  const cookie = (setup.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');
  return { ctx, cookie };
}

// ── 回归：keyPrefix 只给已登录的后台，公开面板一律不给 ────────────
test('keyPrefix 只在已登录的后台视图出现，公开接口与前台页面都不得出现', async (t) => {
  const { ctx, cookie } = await setupAdminCtxHelper();
  t.after(() => ctx.close());

  // ① 公开 /api/status：不给
  const pub = JSON.parse((await request(`${ctx.baseUrl}/api/status`)).body);
  assert.equal(pub.accounts[0].keyPrefix, undefined, '公开视图不得有 keyPrefix');

  // ② 公开 /api/accounts：不给
  const pubList = JSON.parse((await request(`${ctx.baseUrl}/api/accounts`)).body);
  assert.equal(pubList.accounts[0].keyPrefix, undefined, '公开列表不得有 keyPrefix');

  // ③ 已登录的 /api/admin/accounts：要给（后台靠它和上游对账）
  const admin = JSON.parse((await request(`${ctx.baseUrl}/api/admin/accounts`, { headers: { cookie } })).body);
  assert.equal(typeof admin.accounts[0].keyPrefix, 'string', '后台视图应保留 keyPrefix');
  assert.equal(admin.accounts[0].keyPrefix.length, 9);

  // ④ 前台页面不得渲染 key 内容/前缀（keyPrefix）；keyId 只是内部标识，
  //    仅允许出现在 data-key-id 属性里（批次 2 用它做卡片滚动位置回填）。
  const html = (await request(`${ctx.baseUrl}/`)).body;
  assert.ok(!html.includes('keyPrefix'), '前台页面不得引用 keyPrefix');
  const withoutDataKeyId = html.replace(/data-key-id="[^"]*"/g, '');
  assert.ok(!withoutDataKeyId.includes('keyId'),
    'keyId 只允许出现在 data-key-id 属性中，不得以其它形式渲染到前台');
});

// ── 回归：畸形 Host / 请求行不得打挂进程（匿名远程 DoS）────────────
// 历史 bug：`new URL(req.url, \`http://${req.headers.host}\`)` 在 async 处理器
// 体内、各 try/catch 之外，攻击者发 `Host: [` 即抛 ERR_INVALID_URL，
// rejected promise 让 Node 直接终止进程 → 一次匿名请求打挂整个网关。
test('畸形 Host 头不得打挂网关（未认证远程 DoS 回归）', async (t) => {
  const ctx = await startTestGateway();
  t.after(() => ctx.close());

  const before = await request(`${ctx.baseUrl}/health`);
  assert.equal(before.status, 200);

  // 逐个发畸形请求，每个都必须「不致命」
  const { connect } = await import('node:net');
  const port = new URL(ctx.baseUrl).port;
  const malformed = [
    'GET /health HTTP/1.1\r\nHost: [\r\n\r\n',
    'GET /health HTTP/1.1\r\nHost: \r\n\r\n',
    'GET /health HTTP/1.1\r\nHost: a b\r\n\r\n',
    'GET http://[ HTTP/1.1\r\nHost: localhost\r\n\r\n',
  ];
  for (const raw of malformed) {
    await new Promise((resolve) => {
      const s = connect(Number(port), '127.0.0.1');
      s.on('connect', () => { s.write(raw); setTimeout(() => { s.destroy(); resolve(); }, 150); });
      s.on('error', () => resolve());
    });
  }

  // 关键断言：进程还活着，服务仍可响应
  const after = await request(`${ctx.baseUrl}/health`);
  assert.equal(after.status, 200, '畸形 Host 之后服务必须仍然可用（进程未被终止）');
});

// ── 回归：损坏的 users.json 不得让初始化接口重新开放 ──────────────
// 历史 bug：loadUsersFromDisk 吞掉解析异常后 users 仍为 []，isSetupRequired()
// 于是为真 → 任意匿名者可 POST /api/auth/setup 覆盖掉真实管理员。
test('users.json 损坏时必须 fail-closed，不得重开初始化接口', async (t) => {
  const { writeFileSync, readFileSync, mkdirSync } = await import('node:fs');
  const path = await import('node:path');
  const ctx = await startTestGateway();
  t.after(() => ctx.close());

  const setup = await request(`${ctx.baseUrl}/api/auth/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'realadmin', password: 'RealPass123' }),
  });
  assert.equal(setup.status, 201);

  // 模拟损坏（写盘中断 / 手工编辑出错）
  const usersPath = path.join(ctx.dir, 'config', 'users.json');
  assert.ok(readFileSync(usersPath, 'utf8').length > 0, '初始化后 users.json 应存在');
  writeFileSync(usersPath, '{"users":[{"username":"realadmin","passwordHash":');

  // 重新起一个实例读这个损坏的目录
  const ctx2 = await startTestGateway({ rootDir: ctx.dir });
  t.after(() => ctx2.close());
  const me = JSON.parse((await request(`${ctx2.baseUrl}/api/auth/me`)).body);
  assert.equal(me.setupRequired, false, '损坏的 users.json 不能被当成「未初始化」');

  const atk = await request(`${ctx2.baseUrl}/api/auth/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'attacker', password: 'Attack12345' }),
  });
  assert.notEqual(atk.status, 201, '匿名者不得通过 setup 接管管理员');
});

// ── 前台必须把「额度多久刷一次」写出来，且文案跟随后端配置 ──────────
// 用户要求：刷新频率要显示在页面上。频率必须由 /api/status 的 quotaPoll 驱动，
// 不能在页面里写死 —— 否则改了后端间隔页面就说谎。
test('前台显示额度刷新频率，且文案由后端 quotaPoll 决定（不写死）', async (t) => {
  // 用一组「一眼能认出」的间隔，验证页面真的照它渲染
  const ctx = await startTestGateway({
    config: { quotaPollIntervalMs: 900000, quotaActivePollIntervalMs: 45000, quotaActiveWindowMs: 300000 },
  });
  t.after(() => ctx.close());

  const html = (await request(`${ctx.baseUrl}/`)).body;
  assert.match(html, /id="cadence"/, '前台必须有刷新频率的容器');

  const d = JSON.parse((await request(`${ctx.baseUrl}/api/status`)).body);
  assert.equal(d.quotaPoll.idleIntervalMs, 900000);
  assert.equal(d.quotaPoll.activeIntervalMs, 45000);

  // 页面脚本里必须从 quotaPoll 取，而不是写死数字
  assert.match(pageSource(html), /cadenceText\(d\.quotaPoll\)/, '频率文案必须取自后端 quotaPoll');
  assert.match(pageSource(html), /function cadenceText/, '必须有 cadenceText 实现');
  assert.match(pageSource(html), /function fmtEvery/, '必须有毫秒→人话的格式化函数');

  // 换一组间隔，后端下发的值必须跟着变（证明不是硬编码）
  const ctx2 = await startTestGateway({ config: { quotaPollIntervalMs: 120000, quotaActivePollIntervalMs: 30000 } });
  t.after(() => ctx2.close());
  const d2 = JSON.parse((await request(`${ctx2.baseUrl}/api/status`)).body);
  assert.equal(d2.quotaPoll.idleIntervalMs, 120000, '间隔换了，下发值也要换');
  assert.equal(d2.quotaPoll.activeIntervalMs, 30000);
});

// ── 每个额度窗口「什么时候重置」（用户要求）─────────────────────────────
// 用户问：「每 5 个小时是多久刷新？周的周期、每月的呢？」——页面要显示每个窗口
// 还有多久重置。三个 resetAt 必须来自上游真实数据（5h/周来自 windowLimits，
// 月来自 subscriptions.currentPeriodEnd），页面只做换算，不得编造时间。
test('三个额度窗口的 resetAt 由上游原样透传，页面才有得显示', async (t) => {
  const now = Date.now();
  const fiveReset = Math.floor((now + 2 * 3600_000) / 1000);    // 2 小时后
  const weekReset = Math.floor((now + 5 * 86400_000) / 1000);   // 5 天后
  const monthReset = Math.floor((now + 20 * 86400_000) / 1000); // 20 天后

  const ctx = await startTestGateway({
    plans: {
      user_test_alpha: {
        fiveHour: { used: 1.5, cap: 3, resetAt: fiveReset },
        weekly: { used: 3, cap: 6, resetAt: weekReset },
        currentPeriodEnd: new Date(monthReset * 1000).toISOString(),
      },
    },
  });
  t.after(() => ctx.close());

  await ctx.gateway.refreshAll();
  const d = JSON.parse((await request(`${ctx.baseUrl}/api/status`)).body);
  const q = d.accounts.find((a) => a.name === '账号A').lastQuota;
  assert.ok(q && q.ok, '应有额度快照');
  assert.equal(q.fiveHour.resetAt, fiveReset, '5h 窗口 resetAt 必须原样透传');
  assert.equal(q.weekly.resetAt, weekReset, '周窗口 resetAt 必须原样透传');
  assert.equal(q.monthly.resetAt, monthReset, '月窗口 resetAt 必须取自 currentPeriodEnd（ISO→秒）');

  // 换一组数字，下发值必须跟着变（证明不是写死的）
  ctx.upstream.setPlan('user_test_alpha', { fiveHour: { used: 2, cap: 3, resetAt: fiveReset + 60 } });
  await ctx.gateway.refreshAll();
  const d2 = JSON.parse((await request(`${ctx.baseUrl}/api/status`)).body);
  assert.equal(d2.accounts.find((a) => a.name === '账号A').lastQuota.fiveHour.resetAt, fiveReset + 60,
    '上游换了 resetAt，下发的也要换');

  // 页面必须具备渲染能力（容器 + 两个换算函数）
  const html = (await request(`${ctx.baseUrl}/`)).body;
  assert.match(pageSource(html), /function resetText/, '必须有「重置于 …」的渲染函数');
  assert.match(pageSource(html), /function untilText/, '必须有「还有多久」的换算');
  assert.match(pageSource(html), /class="bar-reset"/, '进度条下面要有重置时间的容器');
  assert.match(pageSource(html), /resetText\(w, \{ zeroMeansIdle/, '5h 窗口要按「空闲」语义特殊处理');
});

test('重置时间文案：未来 / 空闲 / 已过期 / 没有数据，四种边界都要说实话', async (t) => {
  const ctx = await startTestGateway();
  t.after(() => ctx.close());
  const html = (await request(`${ctx.baseUrl}/`)).body;

  // 真跑页面内联脚本（DOM 垫片 + 真接口），再直接调页面里的换算函数
  const shim = createDomShim({
    html,
    fetchImpl: async (url, opts = {}) => {
      const r = await request(`${ctx.baseUrl}${url}`, { method: opts?.method ?? 'GET', headers: opts?.headers ?? {}, body: opts?.body });
      return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => JSON.parse(r.body) };
    },
  });
  const page = await runInlineScript(html, shim);
  assert.equal(typeof page.resetText, 'function', '页面里应能取到 resetText');

  const now = Date.now();
  const at = (sec) => Math.floor((now + sec * 1000) / 1000);

  // 5h：2 小时后 → 具体时间 + 还有多久，两个都要给
  // 取值刻意避开整点（+30s）：页面脚本加载要几百毫秒，掐在整点上会算出
  // 「1 小时 59 分」——那是测试的时间敏感，不是功能错。
  const five = page.resetText({ resetAt: at(2 * 3600 + 30) }, { zeroMeansIdle: true });
  assert.match(five, /^重置于 \d+\/\d+ \d{2}:\d{2}（还有 2 小时 0 分）$/, `5h 文案不对: ${five}`);

  // 周：5 天后 → 用「天」，不要写成 120 小时
  const week = page.resetText({ resetAt: at(5 * 86400 + 60) });
  assert.match(week, /还有 5 天 0 小时/, `周文案不对: ${week}`);
  assert.doesNotMatch(week, /120 小时/, '超过一天不要写成小时');

  // 月：20 天后
  assert.match(page.resetText({ resetAt: at(20 * 86400 + 60) }), /还有 20 天 0 小时/);

  // resetAt=0 = 上游「还没开始用」，不是「马上重置」——这两种说法不能混
  const idle = page.resetText({ resetAt: 0 }, { zeroMeansIdle: true });
  assert.match(idle, /空闲中/, `空闲文案不对: ${idle}`);
  assert.doesNotMatch(idle, /即将重置/, '空闲不等于即将重置');

  // 文案里的绝对时间必须真的是未来（防止秒/毫秒换算又写错）
  const abs = /重置于 (\d+)\/(\d+) (\d{2}):(\d{2})/.exec(five);
  assert.ok(abs, `文案里应含具体时间: ${five}`);
  const y = new Date().getFullYear();
  let absMs = new Date(y, Number(abs[1]) - 1, Number(abs[2]), Number(abs[3]), Number(abs[4])).getTime();
  // 跨年（12/31 加两小时就是次年）时上面按今年拼会差一年，先归一到最近的一次
  const want = now + 2 * 3600_000 + 30_000;
  if (Math.abs(absMs - want) > 180 * 86400_000) absMs += absMs > want ? -365 * 86400_000 : 365 * 86400_000;
  assert.ok(Math.abs(absMs - want) < 600_000,
    `文案里的时刻应≈2 小时后，实际 ${new Date(absMs).toISOString()}`);

  // 已过期 → 说明窗口已重置，不能拼出「（还有 即将重置）」病句
  const expired = page.resetText({ resetAt: at(-60) });
  assert.match(expired, /窗口已重置/);
  assert.doesNotMatch(expired, /还有 即将重置/, '过期时间戳不得出现「还有 即将重置」');

  // 上游不给 resetAt（老数据）→ 宁可什么都不显示，也不编一个假时间
  assert.equal(page.resetText({}), '', '没有 resetAt 时不得显示任何时间');
  assert.equal(page.resetText(null), '');
  assert.equal(page.resetText({ resetAt: 'not-a-date' }), '');
});

// ── 回归：账号「余额不足」不得让客户端吃 400 ──────────────────────────
// 实测线上：主号（月 99%、余额 $0.098）对任何推理请求回 HTTP 400
// "You have insufficient credits"。网关原来把 400 当普通 4xx 原样透传，且账号
// 仍被标「可用」——用户看到的就是「这个号莫名其妙不能用，面板却写着可用」。
// 正确行为：标记该账号退出调度 + 未写出字节时换号重试。
test('余额不足的账号：换号重试给客户端正常响应，且它自己退出调度', async (t) => {
  const ctx = await startTestGateway({
    plans: { user_test_alpha: { creditsExhausted: true } },   // 账号A 穷了
  });
  t.after(() => ctx.close());

  const res = await request(`${ctx.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ctx.localKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'mock-model', stream: false, messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(res.status, 200, `应换号重试成 200，实际 ${res.status}: ${res.body.slice(0, 200)}`);

  // 真的换号了：两次 /v1 请求，第二次用的是账号B 的 key
  const v1 = ctx.upstream.seen.filter((s) => s.url.startsWith('/v1/'));
  assert.equal(v1.length, 2, `应发出 2 次上游请求（先撞穷号再换），实际 ${v1.length}`);
  assert.match(v1[0].headers.authorization, /user_test_alpha$/, '第一次应打穷号');
  assert.match(v1[1].headers.authorization, /user_test_beta$/, '第二次应换健康号');
  assert.ok(!res.body.includes('insufficient credits'), '客户端不该看到上游的余额不足报错');

  // 面板视角：穷号要显示不可用 + 原因，且不是「暂停到 X」
  // B12：lastError 不再随匿名 /api/status 下发，本用例改读内部全量视图（断言不变）。
  const d = ctx.gateway.statusView({ internal: true });
  const alpha = d.accounts.find((a) => a.name === '账号A');
  const beta = d.accounts.find((a) => a.name === '账号B');
  assert.equal(alpha.creditsExhausted, true, '穷号要带 creditsExhausted 标记');
  assert.equal(alpha.available, false, '穷号必须不可调度');
  assert.match(alpha.lastError, /额度已用完/, `面板要给出原因，实际: ${alpha.lastError}`);
  assert.equal(alpha.paused, false, '余额不足不是 5h 暂停，不能显示「暂停至 X」');
  assert.equal(beta.available, true, '健康号不受影响');
  assert.equal(beta.creditsExhausted, false);

  // 穷号不再被选中：再发一次，只打健康号
  ctx.upstream.seen.length = 0;
  const res2 = await request(`${ctx.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ctx.localKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'mock-model', stream: false, messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(res2.status, 200);
  const v1b = ctx.upstream.seen.filter((s) => s.url.startsWith('/v1/'));
  assert.equal(v1b.length, 1, '被标记后应直接命中健康号，不再撞穷号');
  assert.match(v1b[0].headers.authorization, /user_test_beta$/);
});

test('全部账号都余额不足：如实把上游错误回给客户端，不伪装成功', async (t) => {
  const ctx = await startTestGateway({
    plans: {
      user_test_alpha: { creditsExhausted: true },
      user_test_beta: { creditsExhausted: true },
    },
  });
  t.after(() => ctx.close());

  const res = await request(`${ctx.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ctx.localKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'mock-model', stream: false, messages: [{ role: 'user', content: 'hi' }] }),
  });
  // 第一次 400 → 标记 A 并重试 → B 也 400 → attempt 用尽，如实回传
  assert.ok(res.status >= 400, `都穷时应回错误，实际 ${res.status}`);
  assert.match(res.body, /insufficient credits|no_available_account|No available account/i,
    `错误要说明原因，实际: ${res.body.slice(0, 200)}`);

  const d = JSON.parse((await request(`${ctx.baseUrl}/api/status`)).body);
  assert.ok(d.accounts.every((a) => a.creditsExhausted === true), '两个号都该被标记');
  assert.equal(d.summary.available, 0, '/health 与面板口径应显示可用 0');
});

test('面板：额度用尽的账号必须渲染成「额度已用完 + 重置时间」，不能显示「可调度」', async (t) => {
  const ctx = await startTestGateway();
  t.after(() => ctx.close());
  const html = (await request(`${ctx.baseUrl}/`)).body;
  const shim = createDomShim({ html, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }) });
  const page = await runInlineScript(html, shim);
  assert.equal(typeof page.card, 'function', '页面里应能取到 card()');

  const quota = (remaining) => ({ ok: true, displayName: 'x', plan: null, remaining, credits: {},
    fiveHour: { used: 0, cap: 3, percent: 0, usedRatio: 0, resetAt: 0 }, weekly: null, monthly: null,
    usage: {}, percent: { fiveHour: 0, weekly: null, monthly: null }, fetchedAt: Date.now() });

  const periodEndSec = Math.floor(Date.parse('2026-10-11T11:41:14.000Z') / 1000);
  const broke = page.card({ name: '穷号', keyId: 'aaaaaaaa', enabled: true, available: false,
    creditsExhausted: true, creditsExhaustedAt: Date.now(), concurrency: 0, paused: false,
    pausedUntil: null, authInvalid: false, lastError: '上游拒付：额度已用完（insufficient credits）',
    exhausted: { kind: 'monthly', label: '月额度已用完', resetAt: periodEndSec },
    lastQuota: quota(0.098) });
  assert.match(broke, /月额度已用完/, '要说清是「月」额度用完（与副号1 的「周额度已用完」同一类说法）');
  assert.match(broke, /重置/, '要给恢复时间');
  assert.doesNotMatch(broke, /需充值/, '不往充值上引导');
  assert.doesNotMatch(broke, /可调度/, '绝不能再显示「可调度」');
  assert.doesNotMatch(broke, /暂停至/, '额度用完不是 5h 暂停，不该出现「暂停至 X」');

  const healthy = page.card({ name: '健康', keyId: 'bbbbbbbb', enabled: true, available: true,
    creditsExhausted: false, creditsExhaustedAt: null, exhausted: null, concurrency: 0, paused: false,
    pausedUntil: null, authInvalid: false, lastError: null, lastQuota: quota(9.9) });
  assert.match(healthy, /可调度/);
  assert.doesNotMatch(healthy, /余额不足|额度已用完/, '健康账号不该被误标');
});

// ── 面板口径：「额度已用完」要分得清种类 + 带上恢复时间 ────────────────
// 用户要求：主号的状态要和副号1 归成同一类说法 —— 副号1 = 周额度用完，
// 主号 = 月额度用完，都要能一眼看出「什么东西用完了、什么时候回来」，
// 而不是笼统的「不可调度」或往充值上引导。
test('额度已用完的三种口径：周窗口 / 月额度 / 其他余额不足，各自带恢复时间', async (t) => {
  const periodEnd = '2026-10-11T11:41:14.000Z';               // 主号线上真实周期结束
  const periodEndSec = Math.floor(Date.parse(periodEnd) / 1000);
  const weekReset = Math.floor((Date.now() + 25 * 3600_000) / 1000);

  // ① 主号那种：上游对推理拒付（探针）+ 月度确实花光
  const ctx = await startTestGateway({
    plans: {
      user_test_alpha: {
        creditsExhausted: true, monthlyCredits: 0.098, purchasedCredits: 0, freeCredits: 0,
        totalCost: 9.936, currentPeriodEnd: periodEnd,
      },
      // ② 副号那种：上游点名周窗口超了
      user_test_beta: { exceeded: 'weekly', weekly: { used: 6.003, cap: 6, resetAt: weekReset, exceeded: true } },
    },
  });
  t.after(() => ctx.close());
  await ctx.gateway.refreshAll();

  const d = JSON.parse((await request(`${ctx.baseUrl}/api/status`)).body);
  const alpha = d.accounts.find((a) => a.name === '账号A');
  const beta = d.accounts.find((a) => a.name === '账号B');

  // 主号 = 月额度已用完，恢复时间 = 订阅周期结束
  assert.equal(alpha.exhausted?.kind, 'monthly', `主号应归为「月额度用完」，实际 ${JSON.stringify(alpha.exhausted)}`);
  assert.equal(alpha.exhausted.label, '月额度已用完');
  assert.equal(alpha.exhausted.resetAt, periodEndSec, '恢复时间必须取自 currentPeriodEnd');
  assert.equal(alpha.available, false);

  // 副号 = 周额度已用完，恢复时间 = 该窗口 resetAt
  assert.equal(beta.exhausted?.kind, 'window');
  assert.equal(beta.exhausted.window, 'weekly');
  assert.equal(beta.exhausted.label, '周额度已用完');
  assert.equal(beta.exhausted.resetAt, weekReset);
  assert.equal(beta.available, false);

  // 面板：状态词直接写「已用完」+ 标签带重置日期，且不再出现「需充值」这种引导
  const shim = createDomShim({ html: (await request(`${ctx.baseUrl}/`)).body, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }) });
  const page = await runInlineScript((await request(`${ctx.baseUrl}/`)).body, shim);
  assert.equal(page.statusText(alpha).t, '月额度已用完');
  assert.equal(page.statusText(beta).t, '周额度已用完');
  const cardA = page.card(alpha);
  const cardB = page.card(beta);
  assert.match(cardA, /月额度已用完/, '卡片状态词要说清是「月」额度');
  assert.match(cardA, /重置/, '要给恢复时间');
  assert.match(cardB, /周额度已用完/);
  assert.doesNotMatch(cardA, /需充值/, '不往充值上引导（用户明确要求）');
  assert.doesNotMatch(cardA, /可调度/, '不能再显示可调度');
});

test('探针拒付但月度没花光：只能说「余额不足」，不许冒充「月额度已用完」', async (t) => {
  const ctx = await startTestGateway({
    plans: {
      // 余额低到会触发探针（$0.5），但月度才用 88.9%（<99%）→ 不能说是「月度用完」
      user_test_alpha: { creditsExhausted: true, monthlyCredits: 0.5, purchasedCredits: 0, freeCredits: 0, totalCost: 4 },
    },
  });
  t.after(() => ctx.close());
  await ctx.gateway.refreshAll();

  const d = JSON.parse((await request(`${ctx.baseUrl}/api/status`)).body);
  const alpha = d.accounts.find((a) => a.name === '账号A');
  assert.equal(alpha.exhausted?.kind, 'balance', '没花光就不能说是月度用完');
  assert.equal(alpha.exhausted.label, '余额不足');
  assert.equal(alpha.exhausted.resetAt, null, '没有周期可等就不要编一个恢复时间');
  assert.equal(alpha.available, false);
});

test('健康账号：exhausted 必须是 null（不能凭空标一个「用完」）', async (t) => {
  const ctx = await startTestGateway();
  t.after(() => ctx.close());
  await ctx.gateway.refreshAll();
  const d = JSON.parse((await request(`${ctx.baseUrl}/api/status`)).body);
  for (const a of d.accounts) assert.equal(a.exhausted, null, `${a.name} 不该被标额度用完`);
  assert.equal(d.accounts.find((x) => x.name === '账号A').available, true);
});

// ── 进度条口径：只报百分比 + 被证明「用完」就画满 ─────────────────────
test('进度条只报百分比（金额收进 title），被证明用完的窗口直接画满', async (t) => {
  // 页面要从真实服务上取（runInlineScript 需要内联 <script>）
  const ctx = await startTestGateway();
  t.after(() => ctx.close());
  const html = (await request(`${ctx.baseUrl}/`)).body;
  const shim = createDomShim({ html, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }) });
  const page = await runInlineScript(html, shim);

  const w = (used, cap, percent) => ({ used, cap, percent, usedRatio: percent / 100, resetAt: 0 });
  const q = {
    ok: true, displayName: 'x', plan: null, remaining: 0.098, credits: {},
    fiveHour: w(0, 3, 0), weekly: w(3.9, 6, 65), monthly: w(9.936, 10, 99.4),
    usage: {}, percent: {}, fetchedAt: Date.now(),
  };
  const base = { enabled: true, concurrency: 0, paused: false, pausedUntil: null, authInvalid: false, lastError: null, lastQuota: q };

  // ① 主号：探针证明月额度用完 → 分母是整数 10，进度条画满 100%
  const spent = page.card({ ...base, name: '主号', keyId: 'aaaaaaaa', available: false,
    creditsExhausted: true, exhausted: { kind: 'monthly', label: '月额度已用完', resetAt: 0 } });
  assert.match(spent, /title="本月周期：已用 9\.94 \/ 10\.00"/, '金额收进 title，且分母是整数 10 而不是 10.03');
  assert.doesNotMatch(spent, /bar-num/, '进度条行不再摆具体金额');
  assert.match(spent, /本月周期<\/span><span class="bar-pct">100\.0%<\/span>/, '用完就该显示 100%');
  assert.match(spent, /<div class="bar s-bad"><i style="width:100%"><\/i><\/div>/, '用完要画满，不能停在 99.4% 像还剩一点');
  assert.match(spent, /本周窗口<\/span><span class="bar-pct">65\.0%<\/span>/, '别的窗口不受影响');
  assert.ok(!/10\.03/.test(spent), '页面上不该再出现 10.03 这种推算分母');

  // ② 副号：上游点名周窗口超限 → 周窗口画满，月度按推算显示
  const weekly = page.card({ ...base, name: '副号', keyId: 'bbbbbbbb', available: false,
    creditsExhausted: false, exhausted: { kind: 'window', window: 'weekly', label: '周额度已用完', resetAt: 0 } });
  assert.match(weekly, /本周窗口<\/span><span class="bar-pct">100\.0%<\/span>/);
  assert.match(weekly, /本月周期<\/span><span class="bar-pct">99\.4%<\/span>/, '没被证明用完的窗口老实显示推算值');

  // ③ 健康账号：只有百分比，没有金额行
  const ok = page.card({ ...base, name: '副号2', keyId: 'cccccccc', available: true,
    creditsExhausted: false, exhausted: null,
    lastQuota: { ...q, remaining: 9.73, monthly: w(0.2, 10, 2) } });
  assert.doesNotMatch(ok, /bar-num/);
  assert.match(ok, /本月周期<\/span><span class="bar-pct">2\.0%<\/span>/);
  assert.match(ok, /可调度/);
});

// ── 用不了的钱就是 0（usableRemaining 唯一口径）─────────────────────
test('额度已用完的账号卡片显示 0.00，window 卡住的钱照常显示', async (t) => {
  const ctx = await startTestGateway();
  t.after(() => ctx.close());
  const html = (await request(`${ctx.baseUrl}/`)).body;
  const shim = createDomShim({ html, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }) });
  const page = await runInlineScript(html, shim);

  const q = (remaining) => ({ ok: true, displayName: 'x', plan: null, remaining, credits: { monthlyCredits: remaining, purchasedCredits: 0, freeCredits: 0 },
    fiveHour: { used: 0, cap: 3, percent: 0, usedRatio: 0, resetAt: 0 },
    weekly: { used: 3.9, cap: 6, percent: 65, usedRatio: 0.65, resetAt: 0 },
    monthly: { used: 9.936, cap: 10, percent: 99.4, usedRatio: 0.994, resetAt: 0 },
    usage: {}, percent: {}, fetchedAt: Date.now() });
  const base = { enabled: true, concurrency: 0, paused: false, pausedUntil: null, authInvalid: false, lastError: null };

  // ① 主号：周期额度用完 + 账上还剩 0.098 → 用不了的钱算 0，卡片显示 0.00
  const spent = page.card({ ...base, name: '主号', keyId: 'aaaaaaaa', available: false, creditsExhausted: true,
    exhausted: { kind: 'monthly', label: '月额度已用完', resetAt: 0 }, lastQuota: q(0.098) });
  assert.match(spent, /<b>0\.00<\/b><small>剩余额度<\/small>/,
    '用不了的钱就是 0：卡片必须显示 0.00，不能与「月额度已用完」打脸');
  assert.doesNotMatch(spent, /<b>0\.10<\/b><small>剩余额度<\/small>/,
    '死账号的零头不许再出现在「剩余额度」结论数字上');
  assert.match(spent, /月度 0\.10 · 购买 0\.00 · 赠送 0\.00/,
    'B2-3：额度构成明细各显真实值，不随剩余额度被门控成 0.00');
  assert.doesNotMatch(spent, /不可支付|money-note/, '不再需要「不可支付」标签');
  assert.doesNotMatch(spent, /title="周期额度已用完/, '不再需要悬停解释');

  // ② 窗口超限但钱还能用（副号）→ 照常显示真实余额，不许算成 0
  const weekly = page.card({ ...base, name: '副号', keyId: 'dddddddd', available: false, creditsExhausted: false,
    exhausted: { kind: 'window', window: 'weekly', label: '周额度已用完', resetAt: 0 }, lastQuota: q(4) });
  assert.match(weekly, /<b>4\.00<\/b><small>剩余额度<\/small>/,
    '周窗口超限只是排队，钱没坏，必须显示 4.00');
});

test('usableRemaining 规则：monthly/balance 算 0，window 照常，无快照为 null', async (t) => {
  const ctx = await startTestGateway();
  t.after(() => ctx.close());
  const html = (await request(`${ctx.baseUrl}/`)).body;
  const shim = createDomShim({ html, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }) });
  const page = await runInlineScript(html, shim);

  const acc = (remaining, exhausted) => ({ lastQuota: { ok: true, remaining }, exhausted });
  assert.equal(page.usableRemaining(acc(0.098, { kind: 'monthly' })), 0, 'monthly 死账号 → 0');
  assert.equal(page.usableRemaining(acc(0.5, { kind: 'balance' })), 0, 'balance 死账号 → 0');
  assert.equal(page.usableRemaining(acc(4.00, { kind: 'window', window: 'weekly' })), 4.00, 'window 只是排队 → 真实余额');
  assert.equal(page.usableRemaining(acc(9.62, null)), 9.62, '没 exhausted → 真实余额');
  assert.equal(page.usableRemaining({ lastQuota: null, exhausted: null }), null, '拿不到快照 → null（不计入合计、卡片显示 —），不产生 NaN');
});

test('顶部与卡片用同一个 usableRemaining：死账号两处都体现为 0', async (t) => {
  const ctx = await startTestGateway();
  t.after(() => ctx.close());
  const html = (await request(`${ctx.baseUrl}/`)).body;
  const shim = createDomShim({ html, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }) });
  const page = await runInlineScript(html, shim);

  const dead = {
    enabled: true, concurrency: 0, paused: false, pausedUntil: null, authInvalid: false, lastError: null,
    name: '主号', keyId: 'aaaaaaaa', available: false, creditsExhausted: true,
    exhausted: { kind: 'monthly', label: '月额度已用完', resetAt: 0 },
    lastQuota: { ok: true, remaining: 0.098 },
  };
  const cardOut = page.card(dead);
  assert.match(cardOut, /<b>0\.00<\/b><small>剩余额度<\/small>/, '卡片用 usableRemaining：dead → 0.00');

  const d = {
    summary: { accounts: 1, available: 0, paused: 0, concurrency: 0 },
    stats: { total: 0, errors: 0, totalTokens: 0 },
    accounts: [dead],
    now: Date.now(),
  };
  page.render(d);
  assert.equal(page.document.getElementById('balance').textContent, '0.00',
    '顶部也走 usableRemaining：同一个 dead 账号在顶部体现为 0');
});

// ── 顶部「剩余额度」：用不了的钱就是 0，window 卡住的钱照常计入 ─────
test('顶部余额：主号死余额算 0，周窗口卡住的钱照常算（13.62）', async (t) => {
  const ctx = await startTestGateway();
  t.after(() => ctx.close());
  const html = (await request(`${ctx.baseUrl}/`)).body;
  const shim = createDomShim({ html, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }) });
  const page = await runInlineScript(html, shim);

  const acc = (remaining, exhausted) => ({
    enabled: true, concurrency: 0, paused: false, pausedUntil: null, authInvalid: false, lastError: null,
    exhausted, lastQuota: { ok: true, remaining },
  });
  const d = {
    summary: { accounts: 3, available: 1, paused: 0, concurrency: 0 },
    stats: { total: 0, errors: 0, totalTokens: 0 },
    accounts: [
      acc(9.62, null),
      acc(0.098, { kind: 'monthly', label: '月额度已用完', resetAt: 0 }),
      acc(4.00, { kind: 'window', window: 'weekly', label: '周额度已用完', resetAt: 0 }),
    ],
    now: Date.now(),
  };

  page.render(d);
  assert.equal(page.document.getElementById('balance').textContent, '13.62',
    '9.62 + 0.098(死→0) + 4.00(窗口) = 13.62');
  const htmlOut = page.document.getElementById('cards').innerHTML;
  assert.doesNotMatch(htmlOut, /已扣除|死余额/, '页面里不再出现「已扣除」「死余额」');
  assert.doesNotMatch(html, /id="bal-dead"/, 'bal-dead 节点已删除');
});

test('顶部余额：周窗口卡住的账号不许扣（available=false 也不扣）', async (t) => {
  const ctx = await startTestGateway();
  t.after(() => ctx.close());
  const html = (await request(`${ctx.baseUrl}/`)).body;
  const shim = createDomShim({ html, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }) });
  const page = await runInlineScript(html, shim);

  const acc = (remaining, available, exhausted) => ({
    enabled: true, concurrency: 0, paused: false, pausedUntil: null, authInvalid: false, lastError: null,
    available, exhausted, lastQuota: { ok: true, remaining },
  });
  const d = {
    summary: { accounts: 1, available: 0, paused: 0, concurrency: 0 },
    stats: { total: 0, errors: 0, totalTokens: 0 },
    accounts: [
      acc(4.00, false, { kind: 'window', window: 'weekly', label: '周额度已用完', resetAt: 0 }),
    ],
    now: Date.now(),
  };

  page.render(d);
  assert.equal(page.document.getElementById('balance').textContent, '4.00',
    '窗口卡住只是排队，钱要全额计入，不能因为 available=false 就扣');
  assert.doesNotMatch(html, /id="bal-dead"/, 'bal-dead 节点已删除');
});

test('顶部余额：多个 balance 死账号的余额全算 0，正常账号照常计入', async (t) => {
  const ctx = await startTestGateway();
  t.after(() => ctx.close());
  const html = (await request(`${ctx.baseUrl}/`)).body;
  const shim = createDomShim({ html, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }) });
  const page = await runInlineScript(html, shim);

  const acc = (remaining, exhausted) => ({
    enabled: true, concurrency: 0, paused: false, pausedUntil: null, authInvalid: false, lastError: null,
    exhausted, lastQuota: { ok: true, remaining },
  });
  const d = {
    summary: { accounts: 3, available: 1, paused: 0, concurrency: 0 },
    stats: { total: 0, errors: 0, totalTokens: 0 },
    accounts: [
      acc(1.5, { kind: 'balance', label: '余额不足', resetAt: null }),
      acc(0.5, { kind: 'balance', label: '余额不足', resetAt: null }),
      acc(2.0, null),
    ],
    now: Date.now(),
  };

  page.render(d);
  assert.equal(page.document.getElementById('balance').textContent, '2.00',
    '2.0 + 1.5(死→0) + 0.5(死→0) = 2.00');
  assert.doesNotMatch(html, /id="bal-dead"/, 'bal-dead 节点已删除');
});

test('顶部余额：没有死账号时全额计入', async (t) => {
  const ctx = await startTestGateway();
  t.after(() => ctx.close());
  const html = (await request(`${ctx.baseUrl}/`)).body;
  const shim = createDomShim({ html, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }) });
  const page = await runInlineScript(html, shim);

  const acc = (remaining, exhausted) => ({
    enabled: true, concurrency: 0, paused: false, pausedUntil: null, authInvalid: false, lastError: null,
    exhausted, lastQuota: { ok: true, remaining },
  });
  const d = {
    summary: { accounts: 2, available: 2, paused: 0, concurrency: 0 },
    stats: { total: 0, errors: 0, totalTokens: 0 },
    accounts: [acc(9.62, null), acc(4.00, null)],
    now: Date.now(),
  };

  page.render(d);
  assert.equal(page.document.getElementById('balance').textContent, '13.62', '全正常 → 全额');
  assert.doesNotMatch(html, /id="bal-dead"/, 'bal-dead 节点已删除');
});

test('顶部余额：拿不到快照的账号不计入合计（显示 —），不产生 NaN', async (t) => {
  const ctx = await startTestGateway();
  t.after(() => ctx.close());
  const html = (await request(`${ctx.baseUrl}/`)).body;
  const shim = createDomShim({ html, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }) });
  const page = await runInlineScript(html, shim);

  const d = {
    summary: { accounts: 2, available: 1, paused: 0, concurrency: 0 },
    stats: { total: 0, errors: 0, totalTokens: 0 },
    accounts: [
      { enabled: true, concurrency: 0, paused: false, pausedUntil: null, authInvalid: false, lastError: null,
        exhausted: null, lastQuota: null },
      { enabled: true, concurrency: 0, paused: false, pausedUntil: null, authInvalid: false, lastError: null,
        exhausted: { kind: 'balance', label: '余额不足', resetAt: null }, lastQuota: null },
    ],
    now: Date.now(),
  };

  page.render(d);
  assert.equal(page.document.getElementById('balance').textContent, '—',
    '两个账号都没有快照：合计应为 —（不是 0.00，也不能是 NaN）');
  assert.match(page.document.getElementById('bal-label').textContent, /含 2 个未同步账号/,
    '要注明有几个账号没同步');
  assert.doesNotMatch(html, /id="bal-dead"/, 'bal-dead 节点已删除');
});

// ── 最近错误：从前台卡片挪到后台，公开面板不再暴露 ─────────────────────
// 用户要求：公开面板的账号卡片不显示「最近错误」，这条信息只在后台账号行里给出。
test('前台卡片：不再显示最近错误，状态词/标签照旧', async (t) => {
  const ctx = await startTestGateway();
  t.after(() => ctx.close());
  const html = (await request(`${ctx.baseUrl}/`)).body;
  const shim = createDomShim({ html, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }) });
  const page = await runInlineScript(html, shim);
  assert.equal(typeof page.card, 'function', '页面里应能取到 card()');

  const periodEndSec = Math.floor(Date.parse('2026-10-11T11:41:14.000Z') / 1000);
  const out = page.card({ name: '穷号', keyId: 'aaaaaaaa', enabled: true, available: false,
    creditsExhausted: true, creditsExhaustedAt: Date.now(), concurrency: 0, paused: false,
    pausedUntil: null, authInvalid: false, lastError: '上游拒付：额度已用完（insufficient credits）',
    exhausted: { kind: 'monthly', label: '月额度已用完', resetAt: periodEndSec },
    lastQuota: null });
  assert.match(out, /月额度已用完/, '状态词照旧');
  assert.match(out, /不可用/, '标签照旧');
  assert.doesNotMatch(out, /最近错误/, '卡片不再渲染最近错误');
  assert.doesNotMatch(out, /class="err"/, '也不应出现 .err 元素');
});

test('后台：快照正常的账号行要显示最近错误（并转义）', async (t) => {
  const ctx = await startTestGateway();
  t.after(() => ctx.close());
  const adminHtml = (await request(`${ctx.baseUrl}/admin`)).body;
  const shim = createDomShim({ html: adminHtml, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }) });
  const page = await runInlineScript(adminHtml, shim);
  assert.equal(typeof page.renderAccounts, 'function', '后台页面里应能取到 renderAccounts');

  // state 是页面顶层 const，不挂在 vm 上下文字面量上；在同一 context 里注数据并直接调渲染函数
  vm.runInContext(`
    state.accounts = [{
      keyId: 'abcdef12', name: '甲', enabled: true, paused: false, authInvalid: false,
      lastError: '上游拒付 <b>balance</b>',
      lastQuota: { ok: true, remaining: 9.9, plan: null, displayName: 'x',
        fiveHour: null, weekly: null, monthly: null, usage: {}, percent: {}, fetchedAt: Date.now() },
    }];
    renderAccounts();
  `, page);

  const out = shim.el('accounts').innerHTML;
  assert.match(out, /最近错误：上游拒付 &lt;b&gt;balance&lt;\/b&gt;/, '快照正常的行要带最近错误且转义');
  assert.doesNotMatch(out, /<b>balance<\/b>/, '不得输出未转义的错误文本');
});

test('后台：快照查询失败时只显示一次错误，不重复出现最近错误', async (t) => {
  const ctx = await startTestGateway();
  t.after(() => ctx.close());
  const adminHtml = (await request(`${ctx.baseUrl}/admin`)).body;
  const shim = createDomShim({ html: adminHtml, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }) });
  const page = await runInlineScript(adminHtml, shim);

  vm.runInContext(`
    state.accounts = [{
      keyId: 'abcdef12', name: '乙', enabled: true, paused: false, authInvalid: false,
      lastError: '上游拒付',
      lastQuota: null,
    }];
    renderAccounts();
  `, page);

  const out = shim.el('accounts').innerHTML;
  assert.match(out, /额度未同步：上游拒付/, '从未同步成功时要把真实原因显示出来');
  assert.equal((out.match(/额度未同步/g) || []).length, 1, '额度未同步只出现一次');
  assert.doesNotMatch(out, /最近错误：/, '不重复显示最近错误');
});

// ── 套餐 planId → 友好名称 ──────────────────────────────────────────────
// 用户要求：面板上别再显示 individual-go 这种官方原始 planId。
// 只改显示层，数据源仍是后端已有的 plan.planId；未知 planId 原样显示。
test('套餐名：planLabel 映射表逐条正确', async (t) => {
  const ctx = await startTestGateway();
  t.after(() => ctx.close());
  const html = (await request(`${ctx.baseUrl}/`)).body;
  const shim = createDomShim({ html, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }) });
  const page = await runInlineScript(html, shim);
  assert.equal(typeof page.planLabel, 'function', '页面里应能取到 planLabel()');

  assert.equal(page.planLabel('individual-go'), 'Go 个人版 · $10/月');
  assert.equal(page.planLabel('individual-goat'), 'GOAT 个人版');
  assert.equal(page.planLabel('individual-pro'), 'Pro 个人版');
  assert.equal(page.planLabel('individual-pro-v1'), 'Pro 个人版');
  assert.equal(page.planLabel('individual-max'), 'Max 个人版');
  assert.equal(page.planLabel('teams-pro'), '团队版');
});

test('套餐名：未知值原样返回，空值不抛异常', async (t) => {
  const ctx = await startTestGateway();
  t.after(() => ctx.close());
  const html = (await request(`${ctx.baseUrl}/`)).body;
  const shim = createDomShim({ html, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }) });
  const page = await runInlineScript(html, shim);

  assert.equal(page.planLabel('individual-xyz'), 'individual-xyz', '未知 planId 绝不吞掉');
  assert.equal(page.planLabel('teams'), '团队版', '以 teams 开头的都算团队版');

  for (const empty of [null, undefined, '']) {
    let out;
    assert.doesNotThrow(() => { out = page.planLabel(empty); }, `planLabel(${String(empty)}) 不得抛异常`);
    assert.ok(out === '' || out === null || out === undefined, `空值返回空，实得 ${JSON.stringify(out)}`);
    assert.doesNotMatch(String(out ?? ''), /未知套餐/, '不得显示中文兜底文案');
  }
});

test('前台卡片：套餐标签显示友好名，不再出现原始 planId', async (t) => {
  const ctx = await startTestGateway();
  t.after(() => ctx.close());
  const html = (await request(`${ctx.baseUrl}/`)).body;
  const shim = createDomShim({ html, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }) });
  const page = await runInlineScript(html, shim);
  assert.equal(typeof page.card, 'function', '页面里应能取到 card()');

  const out = page.card({ name: '主号', keyId: 'aaaaaaaa', enabled: true, available: true,
    concurrency: 0, paused: false, pausedUntil: null, authInvalid: false, lastError: null,
    exhausted: null, lastQuota: { ok: true, plan: { planId: 'individual-go' }, fetchedAt: Date.now() } });
  assert.match(out, /Go 个人版 · \$10\/月/, '卡片要出现友好套餐名');
  assert.doesNotMatch(out, /individual-go/, '不得再出现原始 planId');
});

test('后台：套餐行显示友好名', async (t) => {
  const ctx = await startTestGateway();
  t.after(() => ctx.close());
  const adminHtml = (await request(`${ctx.baseUrl}/admin`)).body;
  const shim = createDomShim({ html: adminHtml, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }) });
  const page = await runInlineScript(adminHtml, shim);
  assert.equal(typeof page.renderAccounts, 'function', '后台页面里应能取到 renderAccounts');

  vm.runInContext(`
    state.accounts = [{
      keyId: 'abcdef12', name: '甲', enabled: true, paused: false, authInvalid: false,
      lastError: null,
      lastQuota: { ok: true, remaining: 9.9, plan: { planId: 'individual-go' }, displayName: 'x',
        fiveHour: null, weekly: null, monthly: null, usage: {}, percent: {}, fetchedAt: Date.now() },
    }];
    renderAccounts();
  `, page);

  const out = shim.el('accounts').innerHTML;
  assert.match(out, /套餐 Go 个人版 · \$10\/月/, '后台行要显示友好套餐名');
  assert.doesNotMatch(out, /individual-go/, '不得再出现原始 planId');
});
