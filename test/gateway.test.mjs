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
  assert.match((await request(`${ctx.baseUrl}/`)).body, /'\/api\/status'/);
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
  assert.match(html, /apiFetch\('\/api\/status'\)/);
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

  // ④ 前台页面不得渲染 key 片段
  const html = (await request(`${ctx.baseUrl}/`)).body;
  assert.ok(!html.includes('keyPrefix'), '前台页面不得引用 keyPrefix');
  assert.ok(!html.includes('keyId'), '前台页面不得渲染 keyId');
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
  assert.match(html, /cadenceText\(d\.quotaPoll\)/, '频率文案必须取自后端 quotaPoll');
  assert.match(html, /function cadenceText/, '必须有 cadenceText 实现');
  assert.match(html, /function fmtEvery/, '必须有毫秒→人话的格式化函数');

  // 换一组间隔，后端下发的值必须跟着变（证明不是硬编码）
  const ctx2 = await startTestGateway({ config: { quotaPollIntervalMs: 120000, quotaActivePollIntervalMs: 30000 } });
  t.after(() => ctx2.close());
  const d2 = JSON.parse((await request(`${ctx2.baseUrl}/api/status`)).body);
  assert.equal(d2.quotaPoll.idleIntervalMs, 120000, '间隔换了，下发值也要换');
  assert.equal(d2.quotaPoll.activeIntervalMs, 30000);
});
