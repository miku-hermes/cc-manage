// 批次 42：系统设置「保存即生效（免重启）」逐字段实测 + 去掉公开面板常驻提示。
//
// 背景：PATCH /api/admin/settings 落盘成功后必须把新值同步进运行中的配置对象；
// 被模块在构造时读进闭包的字段（请求日志器 / 额度轮询调度器）必须走 setter 才能真热更新。
// 本文件全程**不重启进程**，逐字段对比「保存前 → 保存后」的可观测行为：
//   - publicDashboard        → 匿名 GET /api/status 200 → 保存 false 后立刻 401
//   - requestLogEnabled      → 保存 false 后 /v1 请求不再新增日志行，切回 true 恢复
//   - requestLogRetentionDays→ 保存 1 天后，立即清理超期旧文件（保留近期文件）
//   - requestLogMaxMb        → 保存 1MB 后，超限文件的下一次写入被丢弃（dropped++）
//   - quotaPollIntervalMs    → 调度器空闲间隔立即改为新值
//   - quotaActivePollIntervalMs → 调度器活跃间隔立即改为新值
//
// 约束：JSON 响应体一律 JSON.parse 后断字段；用 DOM 垫片，不依赖浏览器。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { startTestGateway, request, makeTmpDir, sleep, createDomShim, runInlineScript } from './helpers.mjs';

const ADMIN_HTML = fs.readFileSync(new URL('../panel/dist/admin.html', import.meta.url), 'utf8');
const APP_ADMIN_JS = fs.readFileSync(new URL('../panel/public/js/app-admin.js', import.meta.url), 'utf8');
const USER = { username: 'admin', password: 'hunter2-secret' };
const KEYS = [
  'requestLogEnabled', 'requestLogRetentionDays', 'requestLogMaxMb',
  'publicDashboard', 'quotaPollIntervalMs', 'quotaActivePollIntervalMs',
];
const jsonRes = (v, status = 200) => ({ ok: status < 400, status, json: async () => v });

function setCookieOf(res, name = 'cc_session') {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const found = list.find((c) => c.startsWith(`${name}=`));
  return found ? found.split(';')[0] : '';
}
const dayName = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.jsonl`;
const lineCount = (p) => { try { return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).length; } catch { return 0; } };
const readCfg = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

/** 起一个真实网关 + 临时 config.json / 请求日志目录，并完成后台 setup，返回签名 session cookie。 */
async function bootSettings({ config = {}, noTimers = true, prefillTodayBytes = 0 } = {}) {
  const dir = makeTmpDir();
  const logDir = path.join(dir, 'reqlog');
  fs.mkdirSync(logDir, { recursive: true });
  const configPath = path.join(dir, 'config.json');
  const base = {
    quotaPollIntervalMs: 600000,
    quotaActivePollIntervalMs: 60000,
    requestLogEnabled: true,
    requestLogRetentionDays: 7,
    requestLogMaxMb: 32,
    publicDashboard: true,
    logLevel: 'silent',
    requestLogDir: logDir,
    ...config,
  };
  fs.writeFileSync(configPath, JSON.stringify(base, null, 2) + '\n');
  // 写入发生在启动前，让记录器的 fileBytes 从「已经很大的文件」起算（maxMb 用例需要）。
  if (prefillTodayBytes > 0) {
    fs.writeFileSync(path.join(logDir, dayName()), JSON.stringify({ t: 1, pad: 'x'.repeat(prefillTodayBytes) }) + '\n');
  }
  const ctx = await startTestGateway({
    rootDir: dir, configPath, noTimers, noInitialRefresh: true,
    config: { requestLogDir: logDir, logLevel: 'silent' },
  });
  const setup = await request(`${ctx.baseUrl}/api/auth/setup`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(USER),
  });
  assert.equal(setup.status, 201, `后台 setup 失败：${setup.status} ${setup.body}`);
  return { ctx, dir, logDir, configPath, cookie: setCookieOf(setup) };
}
const patch = (ctx, cookie, body) => request(`${ctx.baseUrl}/api/admin/settings`, {
  method: 'PATCH', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body),
});
const getSettings = async (ctx, cookie) => JSON.parse((await request(`${ctx.baseUrl}/api/admin/settings`, { headers: { cookie } })).body).settings;
const anonStatus = (ctx) => request(`${ctx.baseUrl}/api/status`);
const v1 = (ctx) => request(`${ctx.baseUrl}/v1/chat/completions`, {
  method: 'POST', headers: { authorization: `Bearer ${ctx.localKey}`, 'content-type': 'application/json' }, body: '{}',
});
const logDropped = async (ctx, cookie) => JSON.parse((await request(`${ctx.baseUrl}/api/admin/logs`, { headers: { cookie } })).body).stats.dropped;

// ── 1：publicDashboard 保存后立即生效（核心诉求）────────────────────────
test('B42-1：publicDashboard=false 保存后匿名 /api/status 立刻 401（同进程，不重启）', async (t) => {
  const { ctx, cookie, configPath } = await bootSettings();
  t.after(() => ctx.close());

  assert.equal((await anonStatus(ctx)).status, 200, '保存前：公开面板匿名可读');
  const res = await patch(ctx, cookie, { publicDashboard: false });
  assert.equal(res.status, 200, `PATCH 应成功：${res.body}`);
  assert.equal((await anonStatus(ctx)).status, 401, '保存后同一进程：立即要求鉴权（无需重启）');
  assert.equal(ctx.gateway.config.publicDashboard, false, '内存值已同步');
  assert.equal(readCfg(configPath).publicDashboard, false, 'config.json 已同步');
  assert.equal((await getSettings(ctx, cookie)).publicDashboard, false, 'GET 读到的也是新值');

  // 切回 true 同样立即生效（证明不是单向生效）。
  assert.equal((await patch(ctx, cookie, { publicDashboard: true })).status, 200);
  assert.equal((await anonStatus(ctx)).status, 200, '保存 true 后立即恢复匿名可读');
});

// ── 2：保存后内存值 == config.json 的值（6 项白名单逐项）───────────────
test('B42-2：PATCH 成功后，6 项白名单的内存值逐项等于 config.json 的值', async (t) => {
  const { ctx, cookie, configPath } = await bootSettings();
  t.after(() => ctx.close());

  const want = {
    requestLogEnabled: false, requestLogRetentionDays: 3, requestLogMaxMb: 8,
    publicDashboard: false, quotaPollIntervalMs: 12345, quotaActivePollIntervalMs: 54321,
  };
  assert.equal((await patch(ctx, cookie, want)).status, 200);
  const disk = readCfg(configPath);
  for (const key of KEYS) {
    assert.equal(ctx.gateway.config[key], want[key], `运行中内存值 ${key} 未同步`);
    assert.equal(disk[key], want[key], `config.json ${key} 未落盘`);
  }
  assert.deepEqual(await getSettings(ctx, cookie), want, 'GET /api/admin/settings 读的就是新内存值');
});

// ── 3：requestLogEnabled 热开关（真发 /v1 请求数日志行）────────────────
test('B42-3：requestLogEnabled=false 保存后 /v1 请求立即不再新增日志行', async (t) => {
  const { ctx, cookie, logDir } = await bootSettings();
  t.after(() => ctx.close());
  const file = path.join(logDir, dayName());

  await v1(ctx); await sleep(200);
  assert.equal(lineCount(file), 1, '启用时一次 /v1 写一行日志');
  assert.equal((await patch(ctx, cookie, { requestLogEnabled: false })).status, 200);
  await v1(ctx); await sleep(200);
  assert.equal(lineCount(file), 1, '保存关闭后：同一进程内不再新增日志行');
  assert.equal((await patch(ctx, cookie, { requestLogEnabled: true })).status, 200);
  await v1(ctx); await sleep(200);
  assert.equal(lineCount(file), 2, '保存开启后立即恢复写入');
});

// ── 4：requestLogRetentionDays 保存后立即按新保留期清理 ────────────────
test('B42-4：requestLogRetentionDays 保存后立即清理超期旧文件（保留近期）', async (t) => {
  const { ctx, cookie, logDir } = await bootSettings();
  t.after(() => ctx.close());
  const oldFile = path.join(logDir, '2001-01-01.jsonl');
  const recentFile = path.join(logDir, dayName());
  fs.writeFileSync(oldFile, '{"t":1}\n');
  fs.writeFileSync(recentFile, '{"t":2}\n');
  assert.ok(fs.existsSync(oldFile), '构造前置入旧文件');

  assert.equal((await patch(ctx, cookie, { requestLogRetentionDays: 1 })).status, 200);
  assert.ok(!fs.existsSync(oldFile), '保存 1 天后：超期旧文件立即被清理');
  assert.ok(fs.existsSync(recentFile), '近期文件必须保留');
  assert.equal(ctx.gateway.config.requestLogRetentionDays, 1, '内存值已同步');
});

// ── 5：requestLogMaxMb 保存后立即按新上限丢弃超限写入 ──────────────────
test('B42-5：requestLogMaxMb 保存为 1 后，超限写入被立即丢弃（dropped++）', async (t) => {
  const { ctx, cookie, logDir } = await bootSettings({ prefillTodayBytes: 1_100_000 });
  t.after(() => ctx.close());
  const file = path.join(logDir, dayName());

  await v1(ctx); await sleep(200);
  assert.equal(lineCount(file), 2, '32MB 上限下：正常写入');
  assert.equal((await patch(ctx, cookie, { requestLogMaxMb: 1 })).status, 200);
  await v1(ctx); await sleep(200);
  assert.equal(lineCount(file), 2, '保存 1MB 上限后：超限写入被丢弃，文件不再增长');
  assert.ok((await logDropped(ctx, cookie)) >= 1, 'dropped 计数增加');
  assert.equal(ctx.gateway.config.requestLogMaxMb, 1, '内存值已同步');
});

// ── 6：轮询间隔保存后立即被调度器采用 ──────────────────────────────────
test('B42-6：额度轮询空闲/活跃间隔保存后立即被调度器采用（免重启）', async (t) => {
  const { ctx, cookie } = await bootSettings({ noTimers: false });
  t.after(() => ctx.close());

  assert.equal(ctx.gateway.poller.scheduledDelayMs, 600000, '初始：空闲间隔 600000');
  ctx.gateway.touchActivity();
  assert.equal(ctx.gateway.poller.scheduledDelayMs, 60000, '有活动后：切到活跃间隔 60000');

  assert.equal((await patch(ctx, cookie, { quotaPollIntervalMs: 12345, quotaActivePollIntervalMs: 54321 })).status, 200);
  assert.deepEqual(
    [ctx.gateway.config.quotaPollIntervalMs, ctx.gateway.config.quotaActivePollIntervalMs],
    [12345, 54321], '内存值已同步');
  assert.equal(ctx.gateway.poller.scheduledDelayMs, 54321, '活跃态下：同一进程内立即按新活跃间隔重排');
  assert.equal(ctx.gateway.poller.nextDelayMs(), 54321, '调度器读到的活跃间隔是新值');
});

// ── 7：去掉公开面板常驻提示，但设置开关仍反映当前状态 ──────────────────
test('B42-7：后台不再显示 PUBLIC_DASHBOARD 常驻提示；设置开关仍反映当前状态', async (t) => {
  const fetchImpl = async (url) => {
    if (url === '/api/auth/me') return jsonRes({ authenticated: true, user: { username: 'admin' } });
    if (url === '/api/admin/session') return jsonRes({ authenticated: true, users: [], dashboardPublic: true, writable: true });
    if (url === '/api/admin/settings') {
      return jsonRes({ ok: true, settings: {
        requestLogEnabled: true, requestLogRetentionDays: 7, requestLogMaxMb: 32,
        publicDashboard: true, quotaPollIntervalMs: 600000, quotaActivePollIntervalMs: 60000,
      } });
    }
    return jsonRes({});
  };
  const shim = createDomShim({ html: ADMIN_HTML, fetchImpl, localStorageData: {} });
  const page = await runInlineScript(ADMIN_HTML, shim);
  vm.runInContext('state.auth = { authenticated: true, user: { username: "admin" } };', page);

  await page.loadUsers();          // dashboardPublic=true 时也必须不显示提示
  assert.match(shim.el('public-note').className, /\bhidden\b/, '提示元素始终隐藏：不再显示常驻横幅');
  assert.ok(!/后重启/.test(shim.el('public-note').textContent), '不再教用户改 config.json 后重启');
  assert.ok(!/如需隐藏，请设 PUBLIC_DASHBOARD=0 后重启/.test(APP_ADMIN_JS), '老文案已从源码删除');

  await page.loadSettings();       // 当前状态改由设置页开关反映
  assert.equal(shim.el('set-publicDashboard').checked, true, '开关勾选 = 当前公开');
  assert.equal(shim.document.querySelector('[data-current="publicDashboard"]').textContent, '开');
});
