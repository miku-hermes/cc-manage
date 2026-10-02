// 管理员操作审计台账（§A createAuditLog + §B 写操作接线 + §C 只读 API）契约测试。
//
// 口径：每个管理员写操作成功后在内存 tail 与磁盘 JSONL 各留一条结构化记录（谁 / 何时 / 从哪 /
// 对什么 / 改了什么）；失败不阻断业务、写盘失败降级、台账绝不含任何密钥明文。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startTestGateway, request, makeTmpDir } from './helpers.mjs';
import { createAuditLog } from '../src/audit.mjs';

const USER = { username: 'admin', password: 'hunter2-secret' };
const DAY_RE = /^audit-\d{4}-\d{2}-\d{2}\.jsonl$/;

function cookieOf(res) {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const found = list.find((c) => c && c.startsWith('cc_session='));
  return found ? found.split(';')[0] : '';
}

/** 起一个真实网关 + 临时 config.json / 请求日志目录（审计目录与 reqlog 同级），返回签名 cookie。 */
async function bootAudit({ config = {} } = {}) {
  const dir = makeTmpDir();
  const logDir = path.join(dir, 'reqlog');
  fs.mkdirSync(logDir, { recursive: true });
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    quotaPollIntervalMs: 600000,
    quotaActivePollIntervalMs: 60000,
    requestLogEnabled: true,
    requestLogRetentionDays: 7,
    requestLogMaxMb: 32,
    publicDashboard: true,
    logLevel: 'silent',
    requestLogDir: logDir,
    ...config,
  }, null, 2) + '\n');
  const ctx = await startTestGateway({
    rootDir: dir, configPath, noTimers: true, noInitialRefresh: true,
    config: { requestLogDir: logDir, logLevel: 'silent' },
  });
  const setup = await request(`${ctx.baseUrl}/api/auth/setup`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(USER),
  });
  assert.equal(setup.status, 201, `后台 setup 失败：${setup.status} ${setup.body}`);
  return { ctx, dir, logDir, auditDir: path.join(dir, 'audit'), cookie: cookieOf(setup) };
}

async function auditJson(ctx, cookie, qs = '') {
  const res = await request(`${ctx.baseUrl}/api/admin/audit${qs}`, { headers: cookie ? { cookie } : {} });
  let json = null;
  try { json = JSON.parse(res.body); } catch { /* 保留 null，交给断言报错 */ }
  return { status: res.status, json, body: res.body };
}

const post = (ctx, cookie, p, body) => request(`${ctx.baseUrl}${p}`, {
  method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const del = (ctx, cookie, p) => request(`${ctx.baseUrl}${p}`, { method: 'DELETE', headers: { cookie } });

// ── 1：settings.update 记键名数组、不记新值 ────────────────────────────
test('审计#1：settings.update 记被改键名数组、actor 含管理员，且不记新值原文', async (t) => {
  const { ctx, cookie } = await bootAudit();
  t.after(() => ctx.close());
  const res = await request(`${ctx.baseUrl}/api/admin/settings`, {
    method: 'PATCH', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ quotaPollIntervalMs: 3141592, quotaActivePollIntervalMs: 3500000 }),
  });
  assert.equal(res.status, 200, res.body);
  const { status, json } = await auditJson(ctx, cookie, '?action=settings.update');
  assert.equal(status, 200);
  const entry = json.items.find((e) => e.action === 'settings.update');
  assert.ok(entry, '必须有 settings.update 记录');
  assert.match(entry.actor, /admin/, 'actor 必须含管理员用户名');
  assert.deepEqual(entry.detail.keys, ['quotaPollIntervalMs', 'quotaActivePollIntervalMs']);
  const all = JSON.stringify(json.items);
  assert.doesNotMatch(all, /3141592/, '审计不得出现新值 3141592');
  assert.doesNotMatch(all, /3500000/, '审计不得出现新值 3500000');
});

// ── 2：key.create 只记 keyId/keyPrefix，明文 key 绝不入审计 ─────────────
test('审计#2：key.create 记 keyId/keyPrefix，返回的明文 key 不在审计里', async (t) => {
  const { ctx, cookie } = await bootAudit();
  t.after(() => ctx.close());
  const res = await post(ctx, cookie, '/api/admin/keys', { name: '审计客户端' });
  assert.equal(res.status, 201, res.body);
  const { plaintext } = JSON.parse(res.body);
  assert.ok(plaintext && plaintext.startsWith('sk-cg-'), '应返回一次性明文 key');
  const { json } = await auditJson(ctx, cookie, '?action=key.create');
  const entry = json.items.find((e) => e.action === 'key.create');
  assert.ok(entry, '必须有 key.create 记录');
  assert.equal(entry.target, '审计客户端');
  assert.equal(typeof entry.detail.keyPrefix, 'string');
  assert.ok(entry.detail.keyId, 'detail.keyId 必须在');
  const all = JSON.stringify(json.items);
  assert.doesNotMatch(all, new RegExp(plaintext.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), '明文 key 不得入审计');
  assert.doesNotMatch(all, /passwordHash|scrypt\$|session-secret/);
});

// ── 3：account.update 字段名数组（§A 数组修正生效）+ account.delete 目标为账号名 ──
test('审计#3：account.update 的 detail.keys 非空数组，account.delete 的 target 为账号名', async (t) => {
  const { ctx, cookie } = await bootAudit();
  t.after(() => ctx.close());
  const listRes = await request(`${ctx.baseUrl}/api/admin/accounts`, { headers: { cookie } });
  const accounts = JSON.parse(listRes.body).accounts;
  const target = accounts.find((a) => a.name === '账号B');
  assert.ok(target, '默认账号B应存在');

  const patchRes = await request(`${ctx.baseUrl}/api/admin/accounts/${target.keyId}`, {
    method: 'PATCH', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ name: '账号B-已改名' }),
  });
  assert.equal(patchRes.status, 200, patchRes.body);
  const { json } = await auditJson(ctx, cookie);
  const upd = json.items.find((e) => e.action === 'account.update');
  assert.ok(upd, '必须有 account.update 记录');
  assert.ok(Array.isArray(upd.detail.keys) && upd.detail.keys.length > 0, 'detail.keys 必须是非空数组（数组修正生效）');
  assert.deepEqual(upd.detail.keys, ['name']);
  assert.equal(upd.target, '账号B-已改名');

  const delRes = await del(ctx, cookie, `/api/admin/accounts/${target.keyId}`);
  assert.equal(delRes.status, 200, delRes.body);
  const { json: j2 } = await auditJson(ctx, cookie, '?action=account.delete');
  const removed = j2.items.find((e) => e.action === 'account.delete');
  assert.ok(removed, '必须有 account.delete 记录');
  assert.equal(removed.target, '账号B-已改名', 'target 必须是账号名');
  assert.equal(removed.detail.keyId, target.keyId);
});

// ── 4：未鉴权 401 ─────────────────────────────────────────────────────
test('审计#4：未鉴权 GET /api/admin/audit → 401', async (t) => {
  const { ctx } = await bootAudit();
  t.after(() => ctx.close());
  const res = await request(`${ctx.baseUrl}/api/admin/audit`);
  assert.equal(res.status, 401, res.body);
});

// ── 5：limit 上限 / limit=1 / total 为过滤后总数 ──────────────────────
test('审计#5：limit=9999 不报错且 ≤500，limit=1 只回 1 条，total 是过滤后总数', async (t) => {
  const { ctx, cookie } = await bootAudit();
  t.after(() => ctx.close());
  for (const username of ['auditfive1', 'auditfive2', 'auditfive3']) {
    const r = await post(ctx, cookie, '/api/admin/users', { username, password: 'hunter2-secret' });
    assert.equal(r.status, 201, r.body);
  }
  const big = await auditJson(ctx, cookie, '?limit=9999');
  assert.equal(big.status, 200);
  assert.ok(big.json.items.length <= 500, `items.length=${big.json.items.length} 应 ≤ 500`);
  assert.ok(big.json.items.length >= 3);
  assert.ok(Array.isArray(big.json.actions), 'actions 应是数组');

  const one = await auditJson(ctx, cookie, '?limit=1');
  assert.equal(one.status, 200);
  assert.equal(one.json.items.length, 1);

  const filtered = await auditJson(ctx, cookie, '?action=admin.create&limit=500');
  assert.equal(filtered.json.total, 3, 'total 应为过滤后（admin.create）总数');
  assert.equal(filtered.json.items.length, 3);
});

// ── 6：action / q 过滤（大小写不敏感） ────────────────────────────────
test('审计#6：?action= 与 ?q= 过滤，q 大小写不敏感', async (t) => {
  const { ctx, cookie } = await bootAudit();
  t.after(() => ctx.close());
  const r = await post(ctx, cookie, '/api/admin/users', { username: 'FilterCaseUser', password: 'hunter2-secret' });
  assert.equal(r.status, 201, r.body);
  const s = await request(`${ctx.baseUrl}/api/admin/settings`, {
    method: 'PATCH', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ requestLogRetentionDays: 5 }),
  });
  assert.equal(s.status, 200, s.body);

  const byAction = await auditJson(ctx, cookie, '?action=admin.create');
  assert.ok(byAction.json.items.length >= 1);
  assert.ok(byAction.json.items.every((e) => e.action === 'admin.create'), 'action 过滤必须严格相等');

  const byQ = await auditJson(ctx, cookie, '?q=filtercaseuser');
  assert.ok(byQ.json.items.length >= 1, 'q 应大小写不敏感命中 FilterCaseUser');
  assert.ok(byQ.json.items.some((e) => e.target === 'FilterCaseUser'));
});

// ── 7：降级（目录不可建）不 reject、不杀进程 ──────────────────────────
test('审计#7：普通文件当父目录 → record resolve、degraded=true、dropped≥1、进程不死', async () => {
  const tmpFile = path.join(makeTmpDir(), 'plain-file.txt');
  fs.writeFileSync(tmpFile, 'x');
  const auditLog = createAuditLog({ dir: `${tmpFile}/audit`, log: null });
  await auditLog.record({ actor: 'user=x@1.2.3.4', action: 'degraded.test', target: null, detail: null });
  const stats = auditLog.stats();
  assert.equal(stats.degraded, true, '必须降级');
  assert.ok(stats.dropped >= 1, '必须有丢弃计数');
  assert.equal(typeof process.pid, 'number', '进程仍存活');
});

// ── 8：单文件字节上限 ─────────────────────────────────────────────────
test('审计#8：maxFileBytes=200 连写多条 → dropped>0 且文件字节数 ≤200', async () => {
  const dir = path.join(makeTmpDir(), 'audit');
  const auditLog = createAuditLog({ dir, maxFileBytes: 200, log: null });
  for (let i = 0; i < 10; i++) {
    await auditLog.record({ actor: 'user=a@1.2.3.4', action: 'limit.test', target: `t${i}`, detail: null });
  }
  assert.ok(auditLog.stats().dropped > 0, '必须出现丢弃');
  const files = fs.readdirSync(dir).filter((f) => DAY_RE.test(f));
  assert.equal(files.length, 1);
  const size = fs.statSync(path.join(dir, files[0])).size;
  assert.ok(size <= 200, `文件字节数 ${size} 应 ≤ 200`);
});

// ── 9：保留期清理 ─────────────────────────────────────────────────────
test('审计#9：retainDays=30 → 40 天前文件被删、最近一天文件保留', async () => {
  const dir = path.join(makeTmpDir(), 'audit');
  fs.mkdirSync(dir, { recursive: true });
  const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const oldName = `audit-${fmt(new Date(Date.now() - 40 * 86400000))}.jsonl`;
  const recentName = `audit-${fmt(new Date(Date.now() - 1 * 86400000))}.jsonl`;
  fs.writeFileSync(path.join(dir, oldName), '{}\n');
  fs.writeFileSync(path.join(dir, recentName), '{}\n');
  createAuditLog({ dir, retainDays: 30, log: null });
  assert.equal(fs.existsSync(path.join(dir, oldName)), false, '40 天前文件应被清理');
  assert.equal(fs.existsSync(path.join(dir, recentName)), true, '最近一天文件必须保留');
});

// ── 10：白名单归一 + 控制字符清理（不产生伪造行） ─────────────────────
test('审计#10：只保留 6 个白名单字段、控制字符被清理、台账文件只有一行', async () => {
  const dir = path.join(makeTmpDir(), 'audit');
  const auditLog = createAuditLog({ dir, log: null });
  await auditLog.record({ actor: 'bad\nactor', action: 'norm.action', target: 't', extra: 'x', detail: { a: 1 } });
  const { items } = auditLog.list();
  assert.equal(items.length, 1);
  assert.deepEqual(Object.keys(items[0]).sort(), ['action', 'actor', 'detail', 'ip', 't', 'target']);
  assert.ok(!('extra' in items[0]), '白名单外的 extra 不得出现');
  assert.equal(items[0].actor, 'badactor', 'actor 控制字符必须被清理');
  assert.deepEqual(items[0].detail, { a: 1 });
  const files = fs.readdirSync(dir).filter((f) => DAY_RE.test(f));
  const text = fs.readFileSync(path.join(dir, files[0]), 'utf8');
  assert.equal(text.split('\n').filter(Boolean).length, 1, '台账文件必须只有一行');
  assert.ok(!text.includes('bad\nactor'), '台账里不得出现裸换行伪造第二行');
});

// ── 12：detail 允许数组（字段名列表的直传形态）与对象都保留 ─────────────
// M1 变异实测教训：所有现有调用点都把数组包在 `{ keys: [...] }` 里，
// 于是 cleanDetail 的「数组也保留」分支不被任何断言覆盖 → 补一条直传数组的断言盯住它。
test('审计#12：detail 传数组与传对象都必须原样保留（别把数组归一成 null）', async () => {
  const dir = path.join(makeTmpDir(), 'audit');
  const auditLog = createAuditLog({ dir, log: null });
  await auditLog.record({ actor: 'user=a@1.2.3.4', action: 'detail.array', target: 't', detail: ['name', 'enabled'] });
  await auditLog.record({ actor: 'user=a@1.2.3.4', action: 'detail.object', target: 't', detail: { keys: ['name'] } });
  const { items } = auditLog.list();
  const arr = items.find((e) => e.action === 'detail.array');
  const obj = items.find((e) => e.action === 'detail.object');
  assert.deepEqual(arr.detail, ['name', 'enabled'], '数组形态的 detail 必须保留（不是 null）');
  assert.deepEqual(obj.detail, { keys: ['name'] }, '对象形态照旧保留');
});

// ── 11：负例 —— 台账不含密码哈希 / scrypt / session secret ─────────────
test('审计#11：台账 JSON 不含 passwordHash / scrypt$ / session-secret', async (t) => {
  const { ctx, cookie } = await bootAudit();
  t.after(() => ctx.close());
  const r = await post(ctx, cookie, '/api/admin/keys', { name: '负例客户端' });
  assert.equal(r.status, 201, r.body);
  const { json } = await auditJson(ctx, cookie, '?limit=500');
  const all = JSON.stringify(json.items);
  assert.doesNotMatch(all, /passwordHash/);
  assert.doesNotMatch(all, /scrypt\$/);
  assert.doesNotMatch(all, /session-secret/);
});
