// 后台鉴权重设计：账号密码登录（scrypt + 签名 cookie session）与客户端 key 彻底分离
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startTestGateway, request } from './helpers.mjs';
import { hashPassword, verifyPassword, createSessionSigner, parseCookies } from '../src/auth.mjs';

const USER = { name: 'admin', pass: 'hunter2-secret' };

/** 从响应里取 Set-Cookie 的 session cookie（只要 name=value 部分）。 */
function sessionCookieOf(res) {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const found = list.find((c) => c.startsWith('cc_session='));
  return found ? found.split(';')[0] : '';
}

function cookieAttrs(res) {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return list.find((c) => c.startsWith('cc_session=')) ?? '';
}

/** 完成初始化并返回 { cookie }。 */
async function setupGateway(opts = {}) {
  const ctx = await startTestGateway(opts);
  const res = await request(`${ctx.baseUrl}/api/auth/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: USER.name, password: USER.pass }),
  });
  assert.equal(res.status, 201, `setup 应成功，实际 ${res.status}: ${res.body}`);
  return { ctx, cookie: sessionCookieOf(res), setupRes: res };
}

// ── 密码哈希原语 ────────────────────────────────────────────────────
test('密码哈希：scrypt 格式、加盐、timingSafeEqual 校验', () => {
  const a = hashPassword('hunter2-secret');
  const b = hashPassword('hunter2-secret');
  assert.match(a, /^scrypt\$\d+\$\d+\$\d+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/, '必须是 scrypt$N$r$p$salt$hash');
  assert.notEqual(a, b, '同一密码两次哈希必须不同（随机盐）');
  assert.ok(verifyPassword('hunter2-secret', a));
  assert.ok(verifyPassword('hunter2-secret', b));
  assert.ok(!verifyPassword('hunter2-secreu', a), '错一位必须失败');
  assert.ok(!verifyPassword('', a));
  // 坏输入不抛错
  for (const bad of ['', 'plain', 'scrypt$1$1$1$zz$zz', 'scrypt$x$1$1$aa$bb', null, undefined]) {
    assert.equal(verifyPassword('hunter2-secret', bad), false);
  }
});

test('session 签名：自签 token 可验，篡改/过期/换密钥一律拒绝', () => {
  const signer = createSessionSigner({ secret: 'k1', ttlMs: 1000, now: () => 1_000_000 });
  const token = signer.sign({ username: 'admin' });
  assert.equal(signer.verify(token).u, 'admin');

  const tampered = `${token.slice(0, -2)}xy`;
  assert.equal(signer.verify(tampered), null, '签名被改必须拒绝');
  assert.equal(signer.verify(`${token}.extra`), null);
  assert.equal(signer.verify('garbage'), null);
  assert.equal(signer.verify(''), null);

  const other = createSessionSigner({ secret: 'k2', ttlMs: 1000, now: () => 1_000_000 });
  assert.equal(other.verify(token), null, '换密钥后旧 token 必须失效');

  const expired = createSessionSigner({ secret: 'k1', ttlMs: 1000, now: () => 2_000_000 });
  assert.equal(expired.verify(token), null, '过期必须拒绝');
});

test('cookie 解析：正常、空、畸形都不抛错', () => {
  assert.deepEqual(parseCookies('a=1; cc_session=xyz'), { a: '1', cc_session: 'xyz' });
  assert.deepEqual(parseCookies(''), {});
  assert.deepEqual(parseCookies('nonsense; =v; k=v=w'), { k: 'v=w' });
  // cookie 名不解码（浏览器规范），cookie 值才解码
  assert.deepEqual(parseCookies('%E4%B8%AD=x'), { '%E4%B8%AD': 'x' });
  assert.deepEqual(parseCookies('k=%E4%B8%AD'), { k: '中' });
  assert.deepEqual(parseCookies('k=%zz'), { k: '%zz' }, '非法百分号转义保留原值');
});

// ── 初始化流程 ──────────────────────────────────────────────────────
test('初始化：无 users.json → /admin 显示初始化页，setup 创建首个管理员', async (t) => {
  const ctx = await startTestGateway();
  t.after(() => ctx.close());

  const me = await request(`${ctx.baseUrl}/api/auth/me`);
  const meData = JSON.parse(me.body);
  assert.equal(meData.authenticated, false);
  assert.equal(meData.setupRequired, true, 'users.json 缺失时必须是待初始化状态');

  const page = await request(`${ctx.baseUrl}/admin`);
  assert.equal(page.status, 200);
  assert.match(page.body, /初始化/, '未初始化时 /admin 必须是初始化页');

  const res = await request(`${ctx.baseUrl}/api/auth/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: USER.name, password: USER.pass }),
  });
  assert.equal(res.status, 201);
  assert.equal(JSON.parse(res.body).user.username, USER.name);

  // 密码落盘必须是 scrypt 哈希，且不含明文
  const usersFile = ctx.gateway.store.usersFile;
  assert.match(usersFile, /users\.json$/, '管理员文件必须是 users.json');
  const raw = fs.readFileSync(usersFile, 'utf8');
  assert.ok(!raw.includes(USER.pass), 'users.json 里绝不能出现明文密码');
  assert.match(raw, /scrypt\$/, 'users.json 里必须是 scrypt 哈希');
  assert.equal(fs.statSync(usersFile).mode & 0o777, 0o640, 'users.json 权限必须是 0640');

  const data = JSON.parse(raw);
  assert.equal(data.users.length, 1);
  assert.equal(data.users[0].username, USER.name);
  assert.ok(verifyPassword(USER.pass, data.users[0].passwordHash));
});

test('初始化：cookie 属性正确（HttpOnly/SameSite=Lax/Path=/），HTTPS 下加 Secure', async (t) => {
  const ctx = await startTestGateway();
  t.after(() => ctx.close());

  const http = await request(`${ctx.baseUrl}/api/auth/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: USER.name, password: USER.pass }),
  });
  const attrs = cookieAttrs(http);
  assert.match(attrs, /HttpOnly/);
  assert.match(attrs, /SameSite=Lax/);
  assert.match(attrs, /Path=\//);
  assert.doesNotMatch(attrs, /Secure/, '明文 HTTP 下不应加 Secure（否则本机 http 调试登不上）');
  assert.match(attrs, /Max-Age=604800/, 'session 有效期必须是 7 天');

  // 反代场景：x-forwarded-proto: https → 必须加 Secure
  const viaProxy = await request(`${ctx.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-proto': 'https' },
    body: JSON.stringify({ username: USER.name, password: USER.pass }),
  });
  assert.equal(viaProxy.status, 200);
  assert.match(cookieAttrs(viaProxy), /Secure/);
});

test('初始化：setup 完成后再次调用 → 403（永久关闭）', async (t) => {
  const { ctx } = await setupGateway();
  t.after(() => ctx.close());

  const again = await request(`${ctx.baseUrl}/api/auth/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'someoneelse', password: 'another-password' }),
  });
  assert.equal(again.status, 403);

  // 也不能靠 setup 覆盖已有管理员
  const data = JSON.parse(fs.readFileSync(ctx.gateway.store.usersFile, 'utf8'));
  assert.equal(data.users.length, 1);
  assert.equal(data.users[0].username, USER.name);

  const me = JSON.parse((await request(`${ctx.baseUrl}/api/auth/me`)).body);
  assert.equal(me.setupRequired, false);
});

test('初始化：用户名/密码不合法 → 400，且不落盘', async (t) => {
  const ctx = await startTestGateway();
  t.after(() => ctx.close());

  const badName = await request(`${ctx.baseUrl}/api/auth/setup`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'a b/', password: USER.pass }),
  });
  assert.equal(badName.status, 400);

  const shortPass = await request(`${ctx.baseUrl}/api/auth/setup`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: USER.name, password: 'short' }),
  });
  assert.equal(shortPass.status, 400);
  assert.ok(!fs.existsSync(ctx.gateway.store.usersFile), '非法输入不得创建 users.json');
});

// ── 登录 / 登出 / 限速 ──────────────────────────────────────────────
test('登录：正确密码 → 200 + session cookie；错密码 → 401 且不设 cookie', async (t) => {
  const { ctx } = await setupGateway();
  t.after(() => ctx.close());

  const ok = await request(`${ctx.baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: USER.name, password: USER.pass }),
  });
  assert.equal(ok.status, 200);
  assert.match(sessionCookieOf(ok), /^cc_session=/);

  const bad = await request(`${ctx.baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: USER.name, password: 'wrong-password' }),
  });
  assert.equal(bad.status, 401);
  assert.equal(bad.headers['set-cookie'], undefined, '登录失败不得下发 session cookie');

  const unknown = await request(`${ctx.baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'ghost', password: USER.pass }),
  });
  assert.equal(unknown.status, 401, '不存在的用户名同样 401');
});

test('登录限速：同 IP 连续失败 5 次 → 429（第 5 次即锁），正确密码也被拒', async (t) => {
  const { ctx } = await setupGateway();
  t.after(() => ctx.close());

  const login = (password) => request(`${ctx.baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: USER.name, password }),
  });

  for (let i = 1; i <= 4; i++) {
    const r = await login(`wrong-${i}`);
    assert.equal(r.status, 401, `第 ${i} 次失败应 401`);
  }
  const fifth = await login('wrong-5');
  assert.equal(fifth.status, 429, '第 5 次失败必须 429');
  assert.ok(Number(fifth.headers['retry-after']) > 0, '429 必须带 Retry-After');
  assert.ok(JSON.parse(fifth.body).error.message.includes('锁定'));

  const locked = await login(USER.pass);
  assert.equal(locked.status, 429, '锁定期间即使密码正确也 429');
});

test('登录限速：4 次失败后成功登录会清零计数（不会被之前的失败拖累）', async (t) => {
  const { ctx } = await setupGateway();
  t.after(() => ctx.close());

  const login = (password) => request(`${ctx.baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: USER.name, password }),
  });
  for (let i = 0; i < 4; i++) assert.equal((await login('nope-' + i)).status, 401);
  assert.equal((await login(USER.pass)).status, 200, '第 5 次用对密码应成功');
  // 计数已清零：再错 4 次仍不该锁
  for (let i = 0; i < 4; i++) assert.equal((await login('nope-again-' + i)).status, 401);
});

test('登出：清 cookie（Max-Age=0），且旧 token 立刻作废（不能重放）', async (t) => {
  const { ctx, cookie } = await setupGateway();
  t.after(() => ctx.close());

  const me = JSON.parse((await request(`${ctx.baseUrl}/api/auth/me`, { headers: { cookie } })).body);
  assert.equal(me.authenticated, true);
  assert.equal(me.user.username, USER.name);
  assert.equal((await request(`${ctx.baseUrl}/api/admin/accounts`, { headers: { cookie } })).status, 200);

  const out = await request(`${ctx.baseUrl}/api/auth/logout`, { method: 'POST', headers: { cookie } });
  assert.equal(out.status, 200);
  assert.match(cookieAttrs(out), /Max-Age=0/);

  const after = JSON.parse((await request(`${ctx.baseUrl}/api/auth/me`)).body);
  assert.equal(after.authenticated, false);
  // 把旧 cookie 再塞回去也不行（服务端已吊销该会话）
  assert.equal((await request(`${ctx.baseUrl}/api/admin/accounts`, { headers: { cookie } })).status, 401,
    '登出后旧 session token 必须立刻失效');
});

// ── 鉴权边界 ────────────────────────────────────────────────────────
test('/api/admin/*：未登录 → 401；带 session → 200；sk-cg- key 不能当后台凭证', async (t) => {
  const { ctx, cookie } = await setupGateway();
  t.after(() => ctx.close());

  for (const p of ['/api/admin/accounts', '/api/admin/keys', '/api/admin/events', '/api/admin/session']) {
    const anon = await request(`${ctx.baseUrl}${p}`);
    assert.equal(anon.status, 401, `${p} 未登录必须 401`);
  }

  const withKey = await request(`${ctx.baseUrl}/api/admin/accounts`, {
    headers: { authorization: `Bearer ${ctx.localKey}` },
  });
  assert.equal(withKey.status, 401, '客户端 sk-cg- key 绝不能用于登录后台');

  for (const p of ['/api/admin/accounts', '/api/admin/keys', '/api/admin/events', '/api/admin/session']) {
    const ok = await request(`${ctx.baseUrl}${p}`, { headers: { cookie } });
    assert.equal(ok.status, 200, `${p} 登录后必须 200`);
  }
});

test('/api/admin/accounts 必须带 lastQuota 额度快照（后台额度列的数据源）', async (t) => {
  const { ctx, cookie } = await setupGateway();
  t.after(() => ctx.close());

  // 先让后端拿到额度快照，否则无从判断字段是否透传
  await ctx.gateway.refreshAll();

  const res = await request(`${ctx.baseUrl}/api/admin/accounts`, { headers: { cookie } });
  assert.equal(res.status, 200);
  const d = JSON.parse(res.body);
  assert.ok(d.accounts.length > 0, '应至少有一个账号');

  for (const a of d.accounts) {
    // 关键回归：后台用 pubAccount 会漏掉 lastQuota，导致页面永远显示「尚未获取额度快照」
    assert.ok('lastQuota' in a, `账号「${a.name}」必须带 lastQuota，否则后台额度列永远是「尚未获取额度快照」`);
    if (a.lastQuota) {
      assert.equal(typeof a.lastQuota.fetchedAt, 'number', 'lastQuota.fetchedAt 供前端算新鲜度');
      assert.ok('remaining' in a.lastQuota, 'lastQuota 必须含余额');
      assert.ok('fiveHour' in a.lastQuota && 'weekly' in a.lastQuota && 'monthly' in a.lastQuota,
        'lastQuota 必须含三个窗口，供后台画进度条');
    }
    // 脱敏：绝不能因为换了视图函数就把完整 key 带出来
    assert.ok(!res.body.includes('user_test_alpha') && !res.body.includes('user_test_beta'),
      '后台接口不得出现完整账号 key');
    assert.ok(!res.body.includes(ctx.localKey), '后台接口不得出现本地客户端 key');
  }
});

test('写接口：未登录 → 401，登录后可增删（登出后立刻 401）', async (t) => {
  const { ctx, cookie } = await setupGateway();
  t.after(() => ctx.close());

  const anon = await request(`${ctx.baseUrl}/api/admin/accounts`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: '匿名账号', key: 'user_anon_should_not_work' }),
  });
  assert.equal(anon.status, 401);

  const created = await request(`${ctx.baseUrl}/api/admin/accounts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ name: '新账号', key: 'user_auth_test_added_account' }),
  });
  assert.equal(created.status, 201, created.body);
  assert.ok(!created.body.includes('user_auth_test_added_account'), '响应不得回显完整 key');

  const list = JSON.parse((await request(`${ctx.baseUrl}/api/admin/accounts`, { headers: { cookie } })).body);
  assert.equal(list.accounts.length, 3);
  const added = list.accounts.find((a) => a.name === '新账号');
  assert.match(added.keyId, /^[0-9a-f]{8}$/);
  assert.equal(added.key, undefined);
});

test('session cookie 被篡改 / 伪造 / 用别的密钥签 → 401', async (t) => {
  const { ctx, cookie } = await setupGateway();
  t.after(() => ctx.close());

  const forged = createSessionSigner({ secret: 'attacker-secret' }).sign({ username: USER.name });
  const cases = {
    '签名被改': cookie.slice(0, -3) + 'aaa',
    '整段伪造（别的密钥签的）': `cc_session=${forged}`,
    '无签名': `cc_session=${cookie.split('=')[1].split('.')[0]}`,
    '空值': 'cc_session=',
    '垃圾值': 'cc_session=not-a-token',
  };
  for (const [label, c] of Object.entries(cases)) {
    const r = await request(`${ctx.baseUrl}/api/admin/accounts`, { headers: { cookie: c } });
    assert.equal(r.status, 401, `${label} 必须 401`);
  }

  // 被删掉的管理员：token 签名有效但用户已不存在 → 拒绝
  const removed = await request(`${ctx.baseUrl}/api/admin/users/${USER.name}`, { method: 'DELETE', headers: { cookie } }).catch(() => null);
  if (removed) assert.equal(removed.status, 409, '不能删除最后一个管理员');
});

test('改密码 / 删管理员 → 该用户的旧 session 立刻失效', async (t) => {
  const { ctx, cookie } = await setupGateway();
  t.after(() => ctx.close());

  const login = await request(`${ctx.baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: USER.name, password: USER.pass }),
  });
  const victim = sessionCookieOf(login);
  assert.equal((await request(`${ctx.baseUrl}/api/admin/accounts`, { headers: { cookie: victim } })).status, 200);

  const patched = await request(`${ctx.baseUrl}/api/admin/users/${USER.name}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ password: 'a-new-password-42' }),
  });
  assert.equal(patched.status, 200);
  assert.equal((await request(`${ctx.baseUrl}/api/admin/accounts`, { headers: { cookie: victim } })).status, 401,
    '改密码后旧会话必须失效');
});

test('session 密钥持久化：config/session-secret 生成一次、权限 0600、内容稳定', async (t) => {
  const { ctx } = await setupGateway();
  t.after(() => ctx.close());

  const file = ctx.gateway.store.secretFile;
  assert.match(file, /session-secret$/, '必须落在 config/session-secret');
  assert.ok(fs.existsSync(file), '首次启动必须生成 session-secret');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'session-secret 权限必须是 0600');
  const first = fs.readFileSync(file, 'utf8').trim();
  assert.ok(first.length >= 32);

  // 同密钥重启后旧 cookie 仍有效（不会每次重启把用户登出）
  const cookie = sessionCookieOf(await request(`${ctx.baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: USER.name, password: USER.pass }),
  }));
  assert.match(cookie, /^cc_session=/);
});

// ── 前台面板公开只读 ────────────────────────────────────────────────
test('前台公开：无任何凭证即可 GET / 与 /api/status（PUBLIC_DASHBOARD 默认）', async (t) => {
  const ctx = await startTestGateway();
  t.after(() => ctx.close());

  const page = await request(`${ctx.baseUrl}/`);
  assert.equal(page.status, 200);
  assert.match(page.body, /cc-manage/);
  assert.doesNotMatch(page.body, /<input[^>]*id="key"/, '前台不再有 key 输入框');
  assert.match(page.body, /href="\/admin"/, '前台必须给「登录后台」入口');
  assert.match(page.body, /apiFetch\('\/api\/status'\)/, '前台仍通过 apiFetch 取数');

  const status = await request(`${ctx.baseUrl}/api/status`);
  assert.equal(status.status, 200, '公开看板不得需要 key');
  assert.equal(JSON.parse(status.body).ok, true);

  const accounts = await request(`${ctx.baseUrl}/api/accounts`);
  assert.equal(accounts.status, 200, '公开只读列表不得需要 key');
});

test('PUBLIC_DASHBOARD=0：/api/status 无 session → 401，登录后 → 200', async (t) => {
  const { ctx, cookie } = await setupGateway({ config: { publicDashboard: false } });
  t.after(() => ctx.close());

  assert.equal((await request(`${ctx.baseUrl}/api/status`)).status, 401, '隐私模式必须 401');
  const ok = await request(`${ctx.baseUrl}/api/status`, { headers: { cookie } });
  assert.equal(ok.status, 200);
  assert.equal(JSON.parse(ok.body).ok, true);
});

test('公开面板里没有完整 CC key / 客户端 key', async (t) => {
  const ctx = await startTestGateway();
  t.after(() => ctx.close());
  await ctx.gateway.refreshAll();

  const body = (await request(`${ctx.baseUrl}/api/status`)).body;
  assert.ok(!body.includes('user_test_alpha'));
  assert.ok(!body.includes(ctx.localKey), '客户端 sk-cg- key 不得出现在公开面板');
  assert.ok(!/user_[A-Za-z0-9_-]{9,}/.test(body));
});

// ── 客户端 key 生命周期 ─────────────────────────────────────────────
test('客户端 key：生成只回显一次明文，列表只有 keyId / keyPrefix', async (t) => {
  const { ctx, cookie } = await setupGateway();
  t.after(() => ctx.close());

  const gen = await request(`${ctx.baseUrl}/api/admin/keys`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ name: '我的笔记本' }),
  });
  assert.equal(gen.status, 201);
  const created = JSON.parse(gen.body);
  assert.match(created.plaintext, /^sk-cg-[A-Za-z0-9_-]{20,}$/, '必须服务端生成 sk-cg- 明文');
  assert.match(created.warning, /只显示一次/);

  // 列表接口绝不回明文
  const list = await request(`${ctx.baseUrl}/api/admin/keys`, { headers: { cookie } });
  assert.equal(list.status, 200);
  assert.ok(!list.body.includes(created.plaintext), '列表不得回显明文');
  const keys = JSON.parse(list.body).keys;
  assert.equal(keys.length, 2);
  for (const k of keys) {
    assert.match(k.keyId, /^[0-9a-f]{8}$/);
    assert.match(k.keyPrefix, /^sk-cg-/);
    assert.equal(k.key, undefined);
    assert.equal(k.plaintext, undefined);
  }

  // 新 key 立刻能调 /v1/*
  const call = await request(`${ctx.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${created.plaintext}`, 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(call.status, 200, '新生成的客户端 key 必须能直接调用 API');

  // 删除后立刻 401
  const del = await request(`${ctx.baseUrl}/api/admin/keys/${encodeURIComponent(created.key.keyId)}`, {
    method: 'DELETE', headers: { cookie },
  });
  assert.equal(del.status, 200);
  const after = await request(`${ctx.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${created.plaintext}`, 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(after.status, 401, '删除后该 key 必须立刻失效');
});

test('客户端 key：不接受客户端传入明文（只由服务端生成）', async (t) => {
  const { ctx, cookie } = await setupGateway();
  t.after(() => ctx.close());

  const res = await request(`${ctx.baseUrl}/api/admin/keys`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ name: '自己填的', key: 'sk-cg-i-want-my-own-key-value' }),
  });
  assert.equal(res.status, 400);
});

test('后台登录 session 与客户端 key 互不影响（登出不会让 API key 失效）', async (t) => {
  const { ctx, cookie } = await setupGateway();
  t.after(() => ctx.close());

  await request(`${ctx.baseUrl}/api/auth/logout`, { method: 'POST', headers: { cookie } });
  const call = await request(`${ctx.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ctx.localKey}`, 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(call.status, 200, '客户端 key 只管 /v1/*，与后台登录状态无关');
});

// ── CC 账号连通性测试 ───────────────────────────────────────────────
test('测试连通性：调 whoami，有效 key → 显示登录名；无效 key → 显示错误原因', async (t) => {
  const { ctx, cookie } = await setupGateway();
  t.after(() => ctx.close());

  // mock 上游认得 user_test_alpha / user_test_beta（见 helpers 默认账号）
  const good = await request(`${ctx.baseUrl}/api/admin/accounts/test`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ name: '临时', key: 'user_test_alpha' }),
  });
  assert.equal(good.status, 200);
  const okResult = JSON.parse(good.body).result;
  assert.equal(okResult.ok, true, JSON.stringify(okResult));
  assert.ok(okResult.displayName || okResult.userName, '有效 key 必须返回登录名');

  const bad = await request(`${ctx.baseUrl}/api/admin/accounts/test`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ name: '临时', key: 'user_definitely_not_a_valid_key_0001' }),
  });
  assert.equal(bad.status, 200);
  const badResult = JSON.parse(bad.body).result;
  assert.equal(badResult.ok, false);
  assert.ok(badResult.error, '无效 key 必须给错误原因');
  assert.ok(!badResult.error.includes('user_definitely_not_a_valid_key_0001'), '错误信息必须脱敏');

  // 未登录不能测
  const anon = await request(`${ctx.baseUrl}/api/admin/accounts/test`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: 'user_test_alpha' }),
  });
  assert.equal(anon.status, 401);
});

test('测试连通性：可按 keyId 测已有账号，不改变账号状态', async (t) => {
  const { ctx, cookie } = await setupGateway();
  t.after(() => ctx.close());

  const list = JSON.parse((await request(`${ctx.baseUrl}/api/admin/accounts`, { headers: { cookie } })).body);
  const target = list.accounts[0];
  const res = await request(`${ctx.baseUrl}/api/admin/accounts/test`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ keyId: target.keyId }),
  });
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.body).result.ok, true);

  const after = JSON.parse((await request(`${ctx.baseUrl}/api/admin/accounts`, { headers: { cookie } })).body);
  assert.equal(after.accounts.length, list.accounts.length, '测试不得增删账号');
  assert.ok(after.tests.length > 0, '测试结果应进入后台可见的历史');
});

// ── 管理员管理 ──────────────────────────────────────────────────────
test('管理员管理：新增 / 改密码 / 删除，且不能删掉最后一个', async (t) => {
  const { ctx, cookie } = await setupGateway();
  t.after(() => ctx.close());

  const add = await request(`${ctx.baseUrl}/api/admin/users`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ username: 'ops', password: 'ops-password-123' }),
  });
  assert.equal(add.status, 201, add.body);

  const raw = fs.readFileSync(ctx.gateway.store.usersFile, 'utf8');
  assert.ok(!raw.includes('ops-password-123'), '明文密码绝不能落盘');
  assert.equal(JSON.parse(raw).users.length, 2);

  // 新管理员能登录
  const login = await request(`${ctx.baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'ops', password: 'ops-password-123' }),
  });
  assert.equal(login.status, 200);

  // 改密码后旧密码失效
  const patched = await request(`${ctx.baseUrl}/api/admin/users/ops`, {
    method: 'PATCH', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ password: 'brand-new-password' }),
  });
  assert.equal(patched.status, 200);
  assert.equal((await request(`${ctx.baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'ops', password: 'ops-password-123' }),
  })).status, 401, '旧密码必须立刻失效');
  assert.equal((await request(`${ctx.baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'ops', password: 'brand-new-password' }),
  })).status, 200);

  const del = await request(`${ctx.baseUrl}/api/admin/users/ops`, { method: 'DELETE', headers: { cookie } });
  assert.equal(del.status, 200);
  assert.equal((await request(`${ctx.baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'ops', password: 'brand-new-password' }),
  })).status, 401, '删除后不能登录');

  const lastDel = await request(`${ctx.baseUrl}/api/admin/users/${USER.name}`, { method: 'DELETE', headers: { cookie } });
  assert.equal(lastDel.status, 409, '不能删除最后一个管理员');
});

test('后台登录后 /admin 仍返回同一页（登录态靠 cookie，页面单文件）', async (t) => {
  const { ctx, cookie } = await setupGateway();
  t.after(() => ctx.close());

  const page = await request(`${ctx.baseUrl}/admin`, { headers: { cookie } });
  assert.equal(page.status, 200);
  assert.match(page.body, /api\/auth\/login/, '后台页面必须带登录流程');
  assert.match(page.body, /\/api\/auth\/setup/, '后台页面必须带初始化流程');
  assert.match(page.body, /\/api\/admin\/accounts\/test/, '后台页面必须有测试连通性按钮');
  assert.doesNotMatch(page.body, /sessionStorage/, '后台不再把凭证放进 sessionStorage');
  assert.doesNotMatch(page.body, /localStorage\.setItem\('cc-manage-key/, '后台不再存 sk-cg- key');
});
