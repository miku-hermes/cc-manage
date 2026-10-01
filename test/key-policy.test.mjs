// 客户端 key 治理（§1 数据模型 / §2 请求执行 / §3 API / §4 密钥页 UI）契约测试。
// 口径：key 生命周期（备注 / 过期 / 启停 / 额度 / 并发 / 速率）与后台密钥页的可视化 / 可操作性。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { startTestGateway, request, createDomShim, runInlineScript, waitFor, makeTmpDir } from './helpers.mjs';

// 每个用例一个隔离的请求日志目录：额度用量是从请求日志聚合的，若指向仓库根 data/reqlog，
// 历史（同明文 key 派生出同 keyId）会污染聚合结果 → 定向测试变 flake。这里显式注入绝对路径。
function isolatedGateway(opts = {}) {
  const dir = makeTmpDir();
  return startTestGateway({
    ...opts,
    rootDir: dir,
    config: { requestLogDir: path.join(dir, 'reqlog'), ...(opts.config || {}) },
  });
}

const ADMIN_HTML = fs.readFileSync(new URL('../panel/src/pages/admin.astro', import.meta.url), 'utf8');

// 长度足够、且互不相同的本地 key 明文。
const K_DISABLED = 'sk-cg-disabled00000000000000000000';
const K_EXPIRED = 'sk-cg-expired000000000000000000000';
const K_QUOTA5H = 'sk-cg-quota5h000000000000000000000';
const K_QUOTADAY = 'sk-cg-quotaday00000000000000000000';
const K_QUOTAWEEK = 'sk-cg-quotaweek0000000000000000000';
const K_CONC = 'sk-cg-concurrent000000000000000000';
const K_RATE = 'sk-cg-rate00000000000000000000000';
const K_LEGACY = 'sk-cg-legacy000000000000000000000';
const K_PATCH = 'sk-cg-patch0000000000000000000000';

function cookieOf(res) {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const found = list.find((c) => c && c.startsWith('cc_session='));
  return found ? found.split(';')[0] : '';
}

async function setupAdmin(ctx) {
  const res = await request(`${ctx.baseUrl}/api/auth/setup`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'hunter2-secret' }),
  });
  assert.equal(res.status, 201, `setup 应成功：${res.status} ${res.body}`);
  return cookieOf(res);
}

const adminHeaders = (cookie) => ({ cookie, 'content-type': 'application/json' });

function callV1(ctx, key, body = '{}') {
  return request(`${ctx.baseUrl}/v1/chat/completions`, {
    method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body,
  });
}

function errOf(res) {
  try { return JSON.parse(res.body).error?.message ?? ''; } catch { return ''; }
}

async function listKeys(ctx, cookie) {
  const res = await request(`${ctx.baseUrl}/api/admin/keys`, { headers: { cookie } });
  assert.equal(res.status, 200, `GET keys 必须 200：${res.status} ${res.body}`);
  return JSON.parse(res.body).keys;
}

const usageBody = { usage: { prompt_tokens: 10, completion_tokens: 0 } };

// ── §2：停用 / 过期 ─────────────────────────────────────────────────
test('治理#1：已停用的 key → 403（点名「已停用」），且请求不落到上游', async (t) => {
  const ctx = await isolatedGateway({
    noInitialRefresh: true,
    keys: [{ name: '停用中', key: K_DISABLED, enabled: false }],
  });
  t.after(() => ctx.close());
  const res = await callV1(ctx, K_DISABLED);
  assert.equal(res.status, 403, `停用 key 必须 403，实际 ${res.status}: ${res.body}`);
  assert.match(errOf(res), /已停用/, `403 文案必须点名「已停用」：${res.body}`);
  assert.equal(ctx.upstream.seen.length, 0, '被拒绝的请求不得到达上游');
});

test('治理#2：已过期的 key → 401（点名「已过期」），且请求不落到上游', async (t) => {
  const ctx = await isolatedGateway({
    noInitialRefresh: true,
    keys: [{ name: '过期了', key: K_EXPIRED, expiresAt: 1000 }],
  });
  t.after(() => ctx.close());
  const res = await callV1(ctx, K_EXPIRED);
  assert.equal(res.status, 401, `过期 key 必须 401，实际 ${res.status}: ${res.body}`);
  assert.match(errOf(res), /已过期/, `401 文案必须点名「已过期」：${res.body}`);
  assert.equal(ctx.upstream.seen.length, 0, '被拒绝的请求不得到达上游');
});

// ── §2：三种额度窗口 ────────────────────────────────────────────────
for (const [label, key, quota, winLabel] of [
  ['5 小时', K_QUOTA5H, { fiveHour: 5 }, '5 小时'],
  ['日', K_QUOTADAY, { daily: 5 }, '日'],
  ['周', K_QUOTAWEEK, { weekly: 5 }, '周'],
]) {
  test(`治理#3-${label}：超出「${label}」token 额度 → 429 且点名窗口`, async (t) => {
    const ctx = await isolatedGateway({
      noInitialRefresh: true,
      keys: [{ name: `额度-${label}`, key, quota }],
      behavior: { usageBody },
    });
    t.after(() => ctx.close());
    const first = await callV1(ctx, key);
    assert.equal(first.status, 200, `首次请求应放行（尚未超额）：${first.status} ${first.body}`);
    const second = await callV1(ctx, key);
    assert.equal(second.status, 429, `超额后必须 429，实际 ${second.status}: ${second.body}`);
    const msg = errOf(second);
    assert.match(msg, /额度/, `429 文案必须说明是额度超限：${msg}`);
    assert.match(msg, new RegExp(winLabel), `429 文案必须点名窗口「${winLabel}」：${msg}`);
    // 首次放行 1 次；第二次被拒不得再打上游。
    assert.equal(ctx.upstream.seen.filter((s) => s.url.startsWith('/v1/')).length, 1, '被拒绝的请求不得到达上游');
  });
}

// ── §2：并发 ────────────────────────────────────────────────────────
test('治理#4：超过 maxConcurrent → 429（说明并发超限）；结束后名额回收', async (t) => {
  const ctx = await isolatedGateway({
    noInitialRefresh: true,
    keys: [{ name: '并发', key: K_CONC, maxConcurrent: 1 }],
    behavior: { chunkDelayMs: 200 },
  });
  t.after(() => ctx.close());
  const pending = callV1(ctx, K_CONC);
  await waitFor(() => ctx.upstream.seen.length >= 1, { label: '首个请求到达上游' });
  const denied = await callV1(ctx, K_CONC);
  assert.equal(denied.status, 429, `并发超限必须 429，实际 ${denied.status}: ${denied.body}`);
  assert.match(errOf(denied), /并发/, `429 文案必须说明并发超限：${denied.body}`);
  const first = await pending;
  assert.equal(first.status, 200, `首个请求应正常完成：${first.status} ${first.body}`);
  // 首个请求结束后名额应回收 → 再发一次能通过。
  const again = await callV1(ctx, K_CONC);
  assert.equal(again.status, 200, `名额未回收会导致永久 429：${again.status} ${again.body}`);
});

// ── §2：速率 ────────────────────────────────────────────────────────
test('治理#5：超过 ratePerMin → 429（说明速率超限），首次放行', async (t) => {
  const ctx = await isolatedGateway({
    noInitialRefresh: true,
    keys: [{ name: '速率', key: K_RATE, ratePerMin: 1 }],
  });
  t.after(() => ctx.close());
  const first = await callV1(ctx, K_RATE);
  assert.equal(first.status, 200, `首次请求应放行：${first.status} ${first.body}`);
  const second = await callV1(ctx, K_RATE);
  assert.equal(second.status, 429, `超过速率上限必须 429，实际 ${second.status}: ${second.body}`);
  assert.match(errOf(second), /速率/, `429 文案必须说明速率超限：${second.body}`);
  assert.equal(ctx.upstream.seen.filter((s) => s.url.startsWith('/v1/')).length, 1, '被拒绝的请求不得到达上游');
});

// ── §2：拒绝也走日志路径 ────────────────────────────────────────────
test('治理#6：拒绝请求写事件 + 请求日志（状态码如实）', async (t) => {
  const ctx = await isolatedGateway({
    noInitialRefresh: true,
    keys: [{ name: '停用中', key: K_DISABLED, enabled: false }],
  });
  t.after(() => ctx.close());
  const cookie = await setupAdmin(ctx);
  await callV1(ctx, K_DISABLED);
  const logs = await request(`${ctx.baseUrl}/api/admin/logs?limit=50`, { headers: { cookie } });
  assert.equal(logs.status, 200, logs.body);
  const items = JSON.parse(logs.body).items || [];
  const row = items.find((it) => it.status === 403);
  assert.ok(row, `拒绝请求必须有一条 403 请求日志：${logs.body}`);
  const events = await request(`${ctx.baseUrl}/api/admin/events?limit=50`, { headers: { cookie } });
  const evs = JSON.parse(events.body).events || JSON.parse(events.body).items || [];
  assert.ok(evs.some((e) => /停用/.test(String(e.message))), `拒绝必须写一条事件日志：${events.body}`);
});

// ── §1：后向兼容 + 不重写文件 ───────────────────────────────────────
test('治理#7：老格式 {name,key} 照常加载；请求后 keys.json 逐字节不变', async (t) => {
  const ctx = await isolatedGateway({
    noInitialRefresh: true,
    keys: [{ name: '老客户端', key: K_LEGACY }],
  });
  t.after(() => ctx.close());
  const before = fs.readFileSync(`${ctx.dir}/keys.json`);
  const cookie = await setupAdmin(ctx);
  const keys = await listKeys(ctx, cookie);
  const legacy = keys.find((k) => k.name === '老客户端');
  assert.ok(legacy, `老格式 key 必须能加载：${JSON.stringify(keys)}`);
  assert.equal(legacy.enabled, true, '默认缺省 enabled=true');
  assert.equal(legacy.note, '', '缺省 note 内存补空串，不落盘');
  assert.equal(legacy.quota, null, '缺省 quota=null');
  assert.equal(legacy.state, 'active', '缺省派生态为 active');
  const ok = await callV1(ctx, K_LEGACY);
  assert.equal(ok.status, 200, `老格式 key 必须仍可调用：${ok.status} ${ok.body}`);
  const after = fs.readFileSync(`${ctx.dir}/keys.json`);
  assert.deepEqual(after, before, '加载 / 调用不得改写 keys.json（逐字节）');
});

// ── §3：GET 派生状态 + 脱敏 ─────────────────────────────────────────
test('治理#8：GET /api/admin/keys 派生态正确、含用量、绝不含完整 key', async (t) => {
  const ctx = await isolatedGateway({
    noInitialRefresh: true,
    keys: [
      { name: '正常', key: K_LEGACY, note: '日常' },
      { name: '停用', key: K_DISABLED, enabled: false },
      { name: '过期', key: K_EXPIRED, expiresAt: 1000 },
      { name: '超额', key: K_QUOTA5H, quota: { fiveHour: 5 } },
    ],
    behavior: { usageBody },
  });
  t.after(() => ctx.close());
  const cookie = await setupAdmin(ctx);
  await callV1(ctx, K_QUOTA5H);      // 产生 10 token 用量（> 5）
  const keys = await listKeys(ctx, cookie);
  const byName = Object.fromEntries(keys.map((k) => [k.name, k]));
  assert.equal(byName['正常'].state, 'active');
  assert.equal(byName['正常'].note, '日常');
  assert.equal(byName['停用'].state, 'disabled');
  assert.equal(byName['过期'].state, 'expired');
  assert.equal(byName['超额'].state, 'quota_exceeded');
  assert.equal(byName['超额'].used.fiveHour, 10, '已用 token 必须来自请求日志聚合');
  assert.equal(byName['超额'].quota.fiveHour, 5);
  // 脱敏：任何字段值都不得等于完整 key（结构化判定，不用子串）。
  for (const k of keys) {
    for (const v of Object.values(k)) assert.notEqual(v, K_LEGACY);
    assert.equal(k.key, undefined, '不得下发 key 字段');
    assert.equal(k.plaintext, undefined, '不得下发 plaintext 字段');
  }
});

// ── §3：PATCH 严格校验 + 局部更新 ───────────────────────────────────
test('治理#9：PATCH 严格校验（类型 / 负数 / 超长 note / 未知字段 → 400）', async (t) => {
  const ctx = await isolatedGateway({
    noInitialRefresh: true,
    keys: [{ name: '补丁', key: K_PATCH, note: '旧', maxConcurrent: 3 }],
  });
  t.after(() => ctx.close());
  const cookie = await setupAdmin(ctx);
  const id = (await listKeys(ctx, cookie))[0].keyId;
  const patch = (body) => request(`${ctx.baseUrl}/api/admin/keys/${id}`, {
    method: 'PATCH', headers: adminHeaders(cookie), body: JSON.stringify(body),
  });

  assert.equal((await patch({ maxConcurrent: 'many' })).status, 400, '类型错 → 400');
  assert.equal((await patch({ ratePerMin: -1 })).status, 400, '负数 → 400');
  assert.equal((await patch({ note: 'x'.repeat(65) })).status, 400, '超长 note → 400');
  assert.equal((await patch({ nope: 1 })).status, 400, '未知字段 → 400');
  assert.equal((await patch({ quota: { hourly: 5 } })).status, 400, '未知额度窗口 → 400');
  assert.equal((await patch({ expiresAt: 'tomorrow' })).status, 400, '类型错的过期时间 → 400');

  // 局部更新：只改 note，其它字段不动。
  const okRes = await patch({ note: '新备注' });
  assert.equal(okRes.status, 200, `合法 PATCH 应 200：${okRes.status} ${okRes.body}`);
  const after = (await listKeys(ctx, cookie))[0];
  assert.equal(after.note, '新备注');
  assert.equal(after.maxConcurrent, 3, '未提供的字段不得被改动');
  assert.equal(after.enabled, true);
});

// ── §3：POST 支持治理字段 ───────────────────────────────────────────
test('治理#10：POST /api/admin/keys 支持治理字段，且响应不含完整 key', async (t) => {
  const ctx = await isolatedGateway({ noInitialRefresh: true, keys: [{ name: '占位', key: K_LEGACY }] });
  t.after(() => ctx.close());
  const cookie = await setupAdmin(ctx);
  const res = await request(`${ctx.baseUrl}/api/admin/keys`, {
    method: 'POST', headers: adminHeaders(cookie),
    body: JSON.stringify({
      name: '带策略', note: '备注A', expiresAt: 4102444800000,
      quota: { fiveHour: 100, daily: 200, weekly: 300 }, maxConcurrent: 2, ratePerMin: 10,
    }),
  });
  assert.equal(res.status, 201, `创建应成功：${res.status} ${res.body}`);
  const created = JSON.parse(res.body);
  assert.equal(created.key.note, '备注A');
  assert.equal(created.key.maxConcurrent, 2);
  assert.equal(created.key.ratePerMin, 10);
  assert.equal(created.key.quota.fiveHour, 100);
  const full = await listKeys(ctx, cookie);
  const row = full.find((k) => k.name === '带策略');
  assert.equal(row.ratePerMin, 10, '治理字段必须持久化并回读一致');
  assert.equal(row.note, '备注A');
  // 响应中不得出现明文（结构化：明文只在 plaintext 字段，且列表接口绝无）。
  const id = created.key.keyId;
  const listedRaw = full.find((k) => k.keyId === id);
  assert.equal(listedRaw.plaintext, undefined);
  assert.equal(listedRaw.key, undefined);
});

// ── §4：密钥页 UI DOM 契约 ──────────────────────────────────────────
test('治理#11：密钥页有 状态/用量/过期时间/备注 列 + 启停开关 + 编辑弹窗 + 转义 + keyId 只在属性', async () => {
  const KEY_ID = 'deadbeef-cafe-4bad-8000-000000000001';
  const shim = createDomShim({ html: ADMIN_HTML, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ keys: [] }) }) });
  const page = await runInlineScript(ADMIN_HTML, shim);
  const rows = [
    { keyId: KEY_ID, keyPrefix: 'sk-cg-2XyP', name: '前端组', state: 'quota_exceeded', enabled: true, expiresAt: 4102444800000, note: '<img src=x onerror=alert(1)>', used: { fiveHour: 9, daily: 9, weekly: 9 }, quota: { fiveHour: 5 } },
    { keyId: 'deadbeef-cafe-4bad-8000-000000000002', keyPrefix: 'sk-cg-3ZzQ', name: '已停用', state: 'disabled', enabled: false, expiresAt: null, note: '', used: { fiveHour: 0, daily: 0, weekly: 0 }, quota: null },
  ];
  vm.runInContext(`state.keys = ${JSON.stringify(rows)}; renderKeys();`, page);
  const html = shim.el('keys').innerHTML;

  for (const col of ['状态', '用量', '过期时间', '备注']) {
    assert.match(html, new RegExp(`data-label="${col}"`), `密钥页必须有「${col}」列`);
  }
  assert.match(html, /data-act="toggle"/, '必须有启停开关');
  assert.match(html, /data-act="edit"/, '必须有编辑入口');
  assert.match(html, /data-act="delkey"/, '必须保住既有删除入口');
  assert.match(html, new RegExp(`data-key-id="${KEY_ID}"`), 'keyId 必须写进行级 data-key-id 属性');
  assert.match(html, /已超限/, '超限状态必须有文字');
  assert.match(html, /5 小时 9 \/ 5 token/, '用量列必须显示 本窗口已用/上限');
  assert.match(html, /不限/, '未设上限必须显示「不限」');
  // 转义：备注里的标签不得成为真标签。
  assert.ok(!html.includes('<img src=x'), '备注必须转义，不得注入 HTML');
  assert.match(html, /&lt;img src=x/, '备注应以实体形式呈现');
  // keyId 不得出现在可见文本里（只在属性中）。
  assert.ok(!shim.el('keys').textContent.includes(KEY_ID), 'keyId 不得渲染为可见文本');

  // 编辑弹窗：字段齐全。
  for (const id of ['ke-note', 'ke-expires', 'ke-quota-5h', 'ke-quota-day', 'ke-quota-week', 'ke-maxconc', 'ke-ratemin', 'ke-submit']) {
    assert.ok(shim.document.getElementById(id), `编辑弹窗必须包含 #${id}`);
  }
});

// ── §4：启停失败回滚 ────────────────────────────────────────────────
test('治理#12：启停开关 PATCH enabled；失败时回滚 UI 状态并提示', async (t) => {
  const KEY_ID = 'beadbeef-cafe-4bad-8000-000000000003';
  const calls = [];
  const row = { keyId: KEY_ID, keyPrefix: 'sk-cg-2XyP', name: '开关', state: 'active', enabled: true, expiresAt: null, note: '', used: { fiveHour: 0, daily: 0, weekly: 0 }, quota: null };
  // GET keys 也回这条（后台启动时的 loadKeys 会重新拉一次，别把种子数据冲掉）。
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method ?? 'GET', body: opts.body ?? null });
    if (String(url).includes('/api/admin/keys') && opts.method === 'PATCH') {
      return { ok: false, status: 500, json: async () => ({ error: { message: '爆炸' } }), text: async () => '{"error":{"message":"爆炸"}}' };
    }
    // 后台启动的 loadAll() 会再拉一次 keys；这里让它失败，避免「服务端真相」（enabled=true）
    // 在 PATCH 失败后把乐观态覆盖掉 —— 否则「回滚」与「刷新回 true」无法区分，断言会变空。
    if (String(url).includes('/api/admin/keys')) {
      return { ok: false, status: 500, json: async () => ({ error: { message: '不可用' } }), text: async () => '{"error":{"message":"不可用"}}' };
    }
    // 必须让 /api/auth/me 判定为已登录，否则 boot() → showGate() 会清空 state.keys。
    if (String(url).includes('/api/auth/me')) {
      return { ok: true, status: 200, json: async () => ({ authenticated: true, writable: true }), text: async () => '{"authenticated":true}' };
    }
    return { ok: true, status: 200, json: async () => ({ accounts: [], users: [], events: [], keys: [], dashboardPublic: true }), text: async () => '{}' };
  };
  const shim = createDomShim({ html: ADMIN_HTML, fetchImpl });
  const page = await runInlineScript(ADMIN_HTML, shim);
  vm.runInContext(`state.keys = ${JSON.stringify([row])}; renderKeys();`, page);
  await waitFor(() => shim.el('keys').innerHTML.includes('data-act="toggle"'), { label: '启停按钮就位' });
  assert.match(shim.el('keys').innerHTML, /data-act="toggle"/, '启停按钮存在');

  // 直接调用容器的点击处理器（模拟点击「停用」）。
  shim.el('keys').dispatchEvent({
    type: 'click',
    target: { closest: () => ({ disabled: false, getAttribute: (n) => (n === 'data-act' ? 'toggle' : KEY_ID) }) },
  });
  assert.ok(await waitFor(() => calls.some((c) => c.method === 'PATCH')), '应发出 PATCH');
  const patch = calls.find((c) => c.method === 'PATCH');
  assert.ok(patch.url.endsWith(`/api/admin/keys/${KEY_ID}`), `PATCH 目标必须是该 key：${patch.url}`);
  assert.deepEqual(JSON.parse(patch.body), { enabled: false }, '启停体只应含 enabled');
  // 失败 → 回滚：state 里 enabled 必须恢复 true。
  await waitFor(() => shim.el('toast').textContent.length > 0);
  const restored = vm.runInContext('state.keys[0].enabled', page);
  assert.equal(restored, true, 'PATCH 失败必须回滚 UI 状态（enabled 复原）');
});
