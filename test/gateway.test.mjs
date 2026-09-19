// §8-3 网关集成：起真实 HTTP 服务，上游指向 mock
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startTestGateway, request, sleep } from './helpers.mjs';

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

test('/api/status 里不含任何完整 key，只有 keyId / keyPrefix', async (t) => {
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
  assert.equal(alpha.keyPrefix, 'user_test');           // sk? 先 9 字符
  assert.match(alpha.keyId, /^[0-9a-f]{8}$/);
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
  assert.match(res.body, /5 小时窗口/);
  assert.match(res.body, /本周窗口/);
  assert.match(res.body, /本月周期/);
  assert.match(res.body, /\/api\/status/);
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

test('402 额度耗尽 → 账号被暂停，后续请求换到另一个账号', async (t) => {
  const ctx = await startTestGateway({ behavior: { quotaError: true } });
  t.after(() => ctx.close());

  const first = await request(`${ctx.baseUrl}/v1/chat/completions`, {
    method: 'POST', headers: { authorization: `Bearer ${ctx.localKey}`, 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(first.status, 402);

  const status = JSON.parse((await request(`${ctx.baseUrl}/api/status`)).body);
  const paused = status.accounts.filter((a) => a.paused);
  assert.equal(paused.length, 1, '应恰好暂停一个账号');

  // 第二个请求必须落到另一个账号
  await request(`${ctx.baseUrl}/v1/chat/completions`, {
    method: 'POST', headers: { authorization: `Bearer ${ctx.localKey}`, 'content-type': 'application/json' }, body: '{}',
  });
  const forwarded = ctx.upstream.seen.filter((s) => s.url.startsWith('/v1/'));
  assert.notEqual(forwarded[0].headers.authorization, forwarded[1].headers.authorization);
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
  const ctx = await startTestGateway({ behavior: { failNext500: 0 } });
  t.after(() => ctx.close());

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
  assert.equal(typeof d.upstreamProxyUrl, 'string');
  assert.equal(typeof d.allowPassthrough, 'boolean');
  assert.equal(typeof d.now, 'number');

  // 账号卡片
  assert.ok(d.accounts.length > 0);
  for (const a of d.accounts) {
    assert.equal(typeof a.name, 'string');
    assert.match(a.keyId, /^[0-9a-f]{8}$/);
    assert.equal(typeof a.keyPrefix, 'string');
    assert.equal(a.keyPrefix.length, 9);
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
  assert.match((await request(`${ctx.baseUrl}/`)).body, /'\/api\/status'/);
});
