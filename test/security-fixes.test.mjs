// 第二轮质检修复的回归测试：F3 / F8 / F13 / F14 / F15 / F16 / F17 / F19 / F20 / F21
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { startTestGateway, request, sleep } from './helpers.mjs';
import {
  createSessionSigner,
  createLoginLimiter,
  hashPassword,
  parseCookies,
  verifyPassword,
} from '../src/auth.mjs';
import { loadConfig } from '../src/config.mjs';

const USER = { name: 'admin', pass: 'hunter2-secret' };

function setCookieOf(res, name = 'cc_session') {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const found = list.find((c) => c.startsWith(`${name}=`));
  return found ? found.split(';')[0] : '';
}

async function setupGateway(opts = {}) {
  const ctx = await startTestGateway(opts);
  const res = await request(`${ctx.baseUrl}/api/auth/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: USER.name, password: USER.pass }),
  });
  assert.equal(res.status, 201, `setup 失败：${res.status} ${res.body}`);
  return { ctx, cookie: setCookieOf(res) };
}

// ── F3：优雅关闭不得立刻掐断在途请求 ────────────────────────────────
test('F3：stop() 等待在途的流式响应跑完，不再第一步就 closeAllConnections', async (t) => {
  const ctx = await startTestGateway({ behavior: { chunkDelayMs: 150 } });
  t.after(() => ctx.close());

  let body = '';
  let closedAt = 0;
  const done = new Promise((resolve) => {
    const req = http.request(`${ctx.baseUrl}/v1/chat/completions`, {
      method: 'POST', headers: { authorization: `Bearer ${ctx.localKey}`, 'content-type': 'application/json' },
    }, (res) => {
      res.on('data', (c) => { body += c.toString('utf8'); });
      res.on('end', () => { closedAt = Date.now(); resolve('end'); });
      res.on('close', () => { closedAt = Date.now(); resolve('close'); });
    });
    req.on('error', () => resolve('error'));
    req.end('{"stream":true}');
  });

  await sleep(120);                    // 第一个分片已到达，后面还有 2 个
  const stopAt = Date.now();
  await ctx.gateway.stop();

  const outcome = await done;
  assert.equal(outcome, 'end', `在途请求必须正常结束，实际 ${outcome}`);
  assert.ok(body.includes('[DONE]'), '在途的流式响应必须完整收完（含 [DONE]），不能被掐断');
  assert.ok(!body.includes('aborted'));
  assert.equal(ctx.gateway.server.listening, false, '关闭后不再监听');
});

test('F3：stop() 不会为「等到超时」而久等（无在途连接时立即返回）', async (t) => {
  const ctx = await startTestGateway();
  t.after(() => ctx.close());
  const t0 = Date.now();
  await ctx.gateway.stop();
  assert.ok(Date.now() - t0 < 1500, `无在途连接时 stop 应立刻返回，实际 ${Date.now() - t0}ms`);
});

// ── F8：recheckPaused 定时器必须有互斥 ──────────────────────────────
test('F8：上一轮暂停复查未跑完时，下一拍直接跳过（不放大额度查询）', async (t) => {
  const ctx = await startTestGateway({
    accounts: [
      { name: 'A', key: 'user_recheck_a_xxxx' },
      { name: 'B', key: 'user_recheck_b_xxxx' },
    ],
    noTimers: true,
  });
  t.after(() => ctx.close());

  const gw = ctx.gateway;
  // 两个账号都「到点待复查」，每次查询慢 300ms
  for (const a of gw.accounts) {
    gw.scheduler.runtime(a).pausedUntil = Date.now() - 1000;
  }
  let calls = 0;
  const original = gw.scheduler.recheckPaused;
  gw.scheduler.recheckPaused = async (opts = {}) => {
    calls++;
    return original.call(gw.scheduler, {
      ...opts,
      fetchQuota: async (a) => { await sleep(300); return opts.fetchQuota(a); },
    });
  };

  // 间隔 100ms，单轮 ≈600ms：没有互斥时 600ms 内会叠 6 轮
  const timer = setInterval(() => gw.runPausedRecheck(), 100);
  await sleep(700);
  clearInterval(timer);
  await sleep(400);

  assert.equal(calls, 1, `一轮没跑完就不能再开一轮，实际 ${calls} 轮`);
});

test('F8：runPausedRecheck 返回 false 表示本轮被跳过', async (t) => {
  const ctx = await startTestGateway({ noTimers: true });
  t.after(() => ctx.close());
  const gw = ctx.gateway;
  assert.equal(gw.runPausedRecheck(), true, '第一次应真的跑');
  assert.equal(gw.runPausedRecheck(), false, '上一次还在跑时必须跳过');
  await sleep(400);
  assert.equal(gw.runPausedRecheck(), true, '跑完后应能再次启动');
});

// ── F13：安全响应头 + CSP 不破坏页面（真跑内联脚本）────────────────
test('F13：/ 与 /admin 带全套安全响应头，管理员 JSON 接口 no-store', async (t) => {
  const { ctx, cookie } = await setupGateway();
  t.after(() => ctx.close());

  for (const p of ['/', '/admin']) {
    const res = await request(`${ctx.baseUrl}${p}`);
    assert.equal(res.status, 200, `${p} 应 200`);
    const csp = res.headers['content-security-policy'];
    assert.ok(csp, `${p} 必须有 CSP`);
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /object-src 'none'/);
    assert.equal(res.headers['x-frame-options'], 'DENY');
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['referrer-policy'], 'no-referrer');
    assert.equal(res.headers['cache-control'], 'no-store');
    // 明文（无 x-forwarded-proto）不发 HSTS，否则会把 HTTP 访问锁死
    assert.equal(res.headers['strict-transport-security'], undefined);
  }

  // 反代走 HTTPS 时才发 HSTS
  const httpsRes = await request(`${ctx.baseUrl}/`, { headers: { 'x-forwarded-proto': 'https' } });
  assert.match(httpsRes.headers['strict-transport-security'] ?? '', /max-age=\d+/);

  // 管理端 JSON：不允许被缓存
  for (const p of ['/api/admin/session', '/api/admin/accounts']) {
    const res = await request(`${ctx.baseUrl}${p}`, { headers: { cookie } });
    assert.equal(res.status, 200);
    assert.equal(res.headers['cache-control'], 'no-store', `${p} 必须 no-store`);
    assert.match(res.headers['content-security-policy'], /default-src 'self'/);
  }
});

test('F13：CSP 允许内联脚本 —— 面板真跑一遍内联脚本并渲染出账号数据', async (t) => {
  const ctx = await startTestGateway();
  t.after(() => ctx.close());
  await ctx.gateway.refreshAll();

  const html = (await request(`${ctx.baseUrl}/`)).body;
  const shim = await loadDomShim(html, ctx, {});
  await runInline(html, shim);
  await sleep(120);

  assert.match(shim.el('health').textContent, /可用 2 \/ 2/, '面板必须真的取到数并渲染 KPI');
  assert.equal(shim.el('kpi-accounts').textContent, '2');
  assert.ok(shim.el('cards').innerHTML.includes('账号A'), '账号卡片必须渲染出来');
  assert.ok(shim.el('cards').innerHTML.includes('5 小时窗口'), '进度条骨架必须渲染出来');

  // 页面确实是内联脚本（CSP 必须放行，否则白屏）
  const csp = (await request(`${ctx.baseUrl}/`)).headers['content-security-policy'];
  assert.match(csp, /script-src[^;]*'unsafe-inline'/, "script-src 必须含 'unsafe-inline'（页面用的是内联 <script>）");
  assert.match(csp, /style-src[^;]*'unsafe-inline'/, "style-src 必须含 'unsafe-inline'（页面用的是内联 <style>）");
});

test('F13：CSP 允许内联脚本 —— /admin 登录后也真跑一遍并渲染账号表', async (t) => {
  const { ctx, cookie } = await setupGateway();
  t.after(() => ctx.close());
  await ctx.gateway.refreshAll();

  const html = (await request(`${ctx.baseUrl}/admin`)).body;
  const shim = await loadDomShim(html, ctx, { cookie });
  await runInline(html, shim);
  await sleep(250);

  assert.equal(shim.document.body.className, '', '登录后必须切到后台视图（不是登录页）');
  assert.equal(shim.el('acc-count').textContent, '2 个');
  assert.ok(shim.el('accounts').innerHTML.includes('账号A'), '账号表格必须渲染出来');
  assert.match(shim.el('who').innerHTML, /admin/);
});

// ── F14：登录限速不得被匿名者用来锁死管理员 ─────────────────────────
test('F14：匿名者用别的用户名刷失败，锁不住真实管理员（反代单桶 DoS）', async (t) => {
  const { ctx } = await setupGateway();
  t.after(() => ctx.close());

  // 反代后所有请求共用同一 socket 地址；攻击者连发 30 次错密码（用户名各不相同）
  for (let i = 0; i < 30; i++) {
    const r = await request(`${ctx.baseUrl}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: `ghost-${i}`, password: 'wrong-password' }),
    });
    assert.equal(r.status, 401, `不存在的用户名的失败不该把别人锁住（第 ${i + 1} 次返回 ${r.status}）`);
  }

  // 真实管理员用正确密码登录必须成功（历史 bug：这里会 429）
  const ok = await request(`${ctx.baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: USER.name, password: USER.pass }),
  });
  assert.equal(ok.status, 200, `管理员必须能登录，实际 ${ok.status} ${ok.body}`);

  // 攻击者照样刷不动真管理员：连续 5 次针对 admin 的错密码 → 锁 admin
  const results = [];
  for (let i = 0; i < 5; i++) {
    results.push((await request(`${ctx.baseUrl}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: USER.name, password: 'wrong-password' }),
    })).status);
  }
  assert.equal(results[4], 429, '针对同一账号的连续失败仍必须被锁定（防护不能丢）');
  const locked = await request(`${ctx.baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: USER.name, password: USER.pass }),
  });
  assert.equal(locked.status, 429, '锁定期内即使密码正确也 429');
  assert.ok(Number(locked.headers['retry-after']) > 0, '429 必须带 Retry-After');
});

test('F14：X-Forwarded-For 依旧不被信任（不能靠伪造头绕过限速）', async (t) => {
  const { ctx } = await setupGateway();
  t.after(() => ctx.close());

  const login = (xff) => request(`${ctx.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': xff },
    body: JSON.stringify({ username: USER.name, password: 'wrong-password' }),
  });

  for (let i = 0; i < 4; i++) assert.equal((await login(`10.0.0.${i}`)).status, 401);
  const fifth = await login('203.0.113.9');
  assert.equal(fifth.status, 429, '换 XFF 不能绕过限速（该行为必须保持不变）');
});

test('F14：锁定时长指数退避且有上限', async () => {
  let t0 = 1_000_000;
  const lim = createLoginLimiter({ maxFails: 2, lockMs: 1000, maxLockMs: 4000, now: () => t0 });
  assert.equal(lim.fail('-', 'u').locked, false);
  const first = lim.fail('-', 'u');
  assert.equal(first.locked, true);
  assert.equal(first.retryAfterMs, 1000, '第一次锁 1s');
  // 锁定到期后再连错 → 退避翻倍
  t0 += 2000;
  assert.equal(lim.fail('-', 'u').locked, false);
  const second = lim.fail('-', 'u');
  assert.equal(second.retryAfterMs, 2000, '第二轮锁 2s');
  t0 += 3000;
  assert.equal(lim.fail('-', 'u').locked, false);
  const third = lim.fail('-', 'u');
  assert.equal(third.retryAfterMs, 4000, '第三轮锁 4s');
  t0 += 5000;
  assert.equal(lim.fail('-', 'u').locked, false);
  const fourth = lim.fail('-', 'u');
  assert.equal(fourth.retryAfterMs, 4000, '之后封顶在 maxLockMs');
});

// ── F15：会话撤销必须持久化，重启后失效的 token 不能复活 ─────────────
test('F15：登出后重启（同一签名密钥 + 同一吊销文件）→ 旧 token 依旧无效', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-rev-'));
  try {
    const file = path.join(dir, 'revoked.json');
    const secret = 'k'.repeat(64);
    const s1 = createSessionSigner({ secret, storePath: file });
    const token = s1.sign({ username: 'admin' });
    assert.ok(s1.verify(token), '签发后应有效');
    s1.revoke(token);
    assert.equal(s1.verify(token), null, '登出后立刻失效');

    // 模拟重启：新实例、同一密钥、同一吊销文件
    const s2 = createSessionSigner({ secret, storePath: file });
    assert.equal(s2.verify(token), null, '重启后旧 token 不能复活');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('F15：改密码后重启 → 旧会话依旧无效（会话版本号落盘）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-rev-'));
  try {
    const file = path.join(dir, 'revoked.json');
    const secret = 'k'.repeat(64);
    const s1 = createSessionSigner({ secret, storePath: file });
    const old = s1.sign({ username: 'admin' });
    s1.revokeUser('admin');
    assert.equal(s1.verify(old), null);

    const s2 = createSessionSigner({ secret, storePath: file });
    assert.equal(s2.verify(old), null, '重启后改密码的吊销仍然有效');
    const fresh = s2.sign({ username: 'admin' });
    assert.ok(s2.verify(fresh), '换版本后新签发的 token 必须有效');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('F15：登出 / 改密码在真实网关里跨重启依然失效（端到端）', async (t) => {
  const { ctx, cookie } = await setupGateway();
  t.after(() => ctx.close());

  assert.equal((await request(`${ctx.baseUrl}/api/admin/accounts`, { headers: { cookie } })).status, 200);
  const out = await request(`${ctx.baseUrl}/api/auth/logout`, { method: 'POST', headers: { cookie } });
  assert.equal(out.status, 200);
  assert.equal((await request(`${ctx.baseUrl}/api/admin/accounts`, { headers: { cookie } })).status, 401);

  // 重启：同一 rootDir（含 config/revoked.json）+ 同一 session-secret
  await ctx.gateway.stop();
  const restarted = await startTestGateway({
    rootDir: ctx.dir,
    config: { upstreamProxyUrl: ctx.upstream.url, ccApiBase: ctx.upstream.url },
  });
  t.after(() => restarted.close());
  const after = await request(`${restarted.baseUrl}/api/admin/accounts`, { headers: { cookie } });
  assert.equal(after.status, 401, '重启后已登出的 cookie 绝不能复活');
});

// ── F16：scrypt 参数与白名单 ─────────────────────────────────────────
test('F16：新哈希用更高成本参数（N≥2^15），且旧档位仍可校验', () => {
  const fresh = hashPassword('hunter2-secret');
  const N = Number(fresh.split('$')[1]);
  assert.ok(N >= 1 << 15, `N 必须提到 2^15 以上，实际 ${N}`);
  assert.ok(verifyPassword('hunter2-secret', fresh));

  // 旧部署里 N=2^14 的哈希必须仍能登录（兼容性）
  const legacy = hashPassword('hunter2-secret', { N: 1 << 14, r: 8, p: 1 });
  assert.ok(verifyPassword('hunter2-secret', legacy), '旧的 N=16384 哈希必须继续可用');
  const legacy15 = hashPassword('hunter2-secret', { N: 1 << 15 });
  assert.ok(verifyPassword('hunter2-secret', legacy15));
});

test('F16：被投毒的 users.json（超大 N/r/p）一律拒绝，绝不按它分配内存', () => {
  const salt = Buffer.alloc(16, 1).toString('base64');
  const hash = Buffer.alloc(64, 2).toString('base64');
  const poison = [
    `scrypt$1048576$32$1$${salt}$${hash}`,   // 4 GiB 内存
    `scrypt$1048576$8$1$${salt}$${hash}`,    // 1 GiB
    `scrypt$16384$32$1$${salt}$${hash}`,     // r 不在白名单
    `scrypt$16384$8$2$${salt}$${hash}`,      // p 不在白名单
    `scrypt$1024$8$1$${salt}$${hash}`,       // N 太小
    `scrypt$262144$8$1$${salt}$${hash}`,     // 档位不在白名单（会阻塞事件循环）
  ];
  for (const stored of poison) {
    const t0 = Date.now();
    assert.equal(verifyPassword('hunter2-secret', stored), false, `必须拒绝 ${stored.slice(0, 24)}…`);
    assert.ok(Date.now() - t0 < 500, `拒绝必须是廉价的，不能真的去算（耗时 ${Date.now() - t0}ms）`);
  }
});

test('F16：正常档位的白名单参数校验仍然通过', () => {
  const stored = hashPassword('pw-12345678', { N: 1 << 16, r: 8, p: 1 });
  assert.ok(verifyPassword('pw-12345678', stored));
  assert.ok(!verifyPassword('wrong-password', stored));
});

// ── F17：会话表 / 限速表不无界增长 ───────────────────────────────────
test('F17：为同一用户签发大量过期会话后，表不会无界增长', () => {
  let t = 1_000_000;
  const signer = createSessionSigner({ secret: 'k'.repeat(64), ttlMs: 1000, now: () => t });
  for (let i = 0; i < 5000; i++) signer.sign({ username: 'admin' });
  t += 60_000;   // 全部过期
  assert.equal(signer.liveSessionCount('admin'), 0, '全部过期后不该还有「有效」会话');
  signer.sign({ username: 'admin' });   // sign() 里应顺手清理过期 sid
  assert.equal(signer.liveSessionCount('admin'), 1,
    `过期 sid 必须被清掉，只剩刚签发的这一个，实际 ${signer.liveSessionCount('admin')}`);
  // revokeUser 返回「仍然有效」的会话数（历史 bug：把 5000 个已过期 sid 全算进去）
  assert.equal(signer.revokeUser('admin'), 1, 'revokeUser 只该报告 1 个有效会话');
});

// ── F19：JSON 解析错误不得回显请求体 ─────────────────────────────────
test('F19：畸形 JSON 只回通用文案，绝不回显请求体内容', async (t) => {
  const { ctx, cookie } = await setupGateway();
  t.after(() => ctx.close());

  const secret = 'SECRETBODY{{{';
  for (const [p, opts] of [
    ['/api/auth/login', {}],
    ['/api/admin/accounts', { cookie }],
  ]) {
    const res = await request(`${ctx.baseUrl}${p}`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...opts }, body: secret,
    });
    assert.equal(res.status, 400, `${p} 应 400`);
    assert.ok(!res.body.includes('SECRETBODY'), `响应绝不能回显请求体：${res.body}`);
    assert.ok(!/Unexpected token|JSON\.parse|position \d+/i.test(res.body), `不该泄漏解析器内部信息：${res.body}`);
    assert.match(JSON.parse(res.body).error.message, /不是合法 JSON/);
  }
});

// ── F20：匿名刷新节流按来源分桶 + 全局硬限 ───────────────────────────
test('F20：匿名刷新节流不再是一个全局单变量（分来源 + 全局兜底）', async (t) => {
  const ctx = await startTestGateway();
  t.after(() => ctx.close());

  const first = await request(`${ctx.baseUrl}/api/accounts/refresh`, { method: 'POST' });
  assert.equal(first.status, 200);
  assert.equal(JSON.parse(first.body).throttled, undefined, '第一次应真的刷新');

  const second = await request(`${ctx.baseUrl}/api/accounts/refresh`, { method: 'POST' });
  assert.equal(second.status, 200);
  assert.equal(JSON.parse(second.body).throttled, true, '同来源紧接着再刷应被节流');

  // 节流状态按来源分桶，不是一个全局单变量；另有全局兜底间隔
  const src = fs.readFileSync(new URL('../gateway.mjs', import.meta.url), 'utf8');
  assert.match(src, /lastPublicRefreshBySource/, '节流必须按来源分桶（历史 bug：单个全局变量）');
  const globalMin = Number((src.match(/const PUBLIC_REFRESH_GLOBAL_MIN_MS = (\d+)/) ?? [])[1]);
  assert.ok(globalMin >= 1000, `必须有全局兜底间隔，实际 ${globalMin}`);
});

test('F20：匿名刷新不会让上游被无限放大（节流后不再打上游）', async (t) => {
  const ctx = await startTestGateway();
  t.after(() => ctx.close());

  const quotaCalls = () => ctx.upstream.seen.filter((s) => s.url.startsWith('/alpha/')).length;

  await request(`${ctx.baseUrl}/api/accounts/refresh`, { method: 'POST' });
  const afterFirst = quotaCalls();
  assert.ok(afterFirst > 0, '第一次刷新应真的查上游额度');

  for (let i = 0; i < 10; i++) await request(`${ctx.baseUrl}/api/accounts/refresh`, { method: 'POST' });
  assert.equal(quotaCalls(), afterFirst, '节流期内连续刷新不得再打上游');
});

// ── F21：改他人密码必须二次确认 ─────────────────────────────────────
test('F21：改他人密码必须先验证当前管理员自己的口令', async (t) => {
  const { ctx, cookie } = await setupGateway();
  t.after(() => ctx.close());

  const add = await request(`${ctx.baseUrl}/api/admin/users`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ username: 'victim', password: 'victim-original-pw' }),
  });
  assert.equal(add.status, 201, add.body);

  // 直接改：必须 403
  const direct = await request(`${ctx.baseUrl}/api/admin/users/victim`, {
    method: 'PATCH', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ password: 'attacker-chosen-pw' }),
  });
  assert.equal(direct.status, 403, `无二次确认必须 403，实际 ${direct.status}`);
  assert.equal((await request(`${ctx.baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'victim', password: 'attacker-chosen-pw' }),
  })).status, 401, '被拒的改密绝不能生效');

  // 口令错：也必须 403
  const wrong = await request(`${ctx.baseUrl}/api/admin/users/victim`, {
    method: 'PATCH', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ password: 'attacker-chosen-pw', currentPassword: 'nope' }),
  });
  assert.equal(wrong.status, 403);

  // 正确口令：允许
  const ok = await request(`${ctx.baseUrl}/api/admin/users/victim`, {
    method: 'PATCH', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ password: 'new-victim-pw-123', currentPassword: USER.pass }),
  });
  assert.equal(ok.status, 200, ok.body);
  assert.equal((await request(`${ctx.baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'victim', password: 'new-victim-pw-123' }),
  })).status, 200);
});

test('F21：改自己的密码不需要二次确认（保持向后兼容）', async (t) => {
  const { ctx, cookie } = await setupGateway();
  t.after(() => ctx.close());
  const res = await request(`${ctx.baseUrl}/api/admin/users/${USER.name}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ password: 'my-own-new-password' }),
  });
  assert.equal(res.status, 200, res.body);
  assert.equal((await request(`${ctx.baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: USER.name, password: 'my-own-new-password' }),
  })).status, 200);
});

// ── 辅助（放在末尾避免顶部 import 噪音）──────────────────────────────
async function loadDomShim(html, ctx, { cookie }) {
  const { createDomShim } = await import('./helpers.mjs');
  return createDomShim({
    html,
    fetchImpl: async (url, opts = {}) => {
      const headers = { ...(opts?.headers ?? {}), ...(cookie ? { cookie } : {}) };
      const r = await request(`${ctx.baseUrl}${url}`, {
        method: opts?.method ?? 'GET',
        headers,
        body: opts?.body,
      });
      return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => JSON.parse(r.body) };
    },
  });
}

async function runInline(html, shim) {
  const { runInlineScript } = await import('./helpers.mjs');
  return runInlineScript(html, shim);
}
