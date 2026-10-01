// 「系统设置」页（§2）+ 未登录外壳隐藏（§1）回归测试。
//
// 覆盖：
//  - GET 只回 6 个白名单字段的当前生效值；
//  - PATCH 合法值真的落盘（读回 config.json 断言），其余键逐字节不变 + .bak 备份；
//  - 400 分支：类型错 / 越界 / 未知字段 / 非对象 body；
//  - 写盘失败 → 500 且内存值保持不变（不出现「内存改了、盘没写」）；
//  - 未登录访问两端点 → 401；
//  - 设置页 DOM 契约：6 个控件 + 保存按钮 + 失败回滚；
//  - 未登录态外壳隐藏（调 showGate/showAdmin 真行为，不是字符串断言）。
//
// 约束：所有 JSON 响应体都 JSON.parse 后断字段，绝不用子串 includes()（历史 flake）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { startTestGateway, request, makeTmpDir, createDomShim, runInlineScript } from './helpers.mjs';

const ADMIN_HTML = fs.readFileSync(new URL('../panel/dist/admin.html', import.meta.url), 'utf8');
const USER = { name: 'admin', pass: 'hunter2-secret' };
const KEYS = [
  'requestLogEnabled', 'requestLogRetentionDays', 'requestLogMaxMb',
  'publicDashboard', 'quotaPollIntervalMs', 'quotaActivePollIntervalMs',
];

function setCookieOf(res, name = 'cc_session') {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const found = list.find((c) => c.startsWith(`${name}=`));
  return found ? found.split(';')[0] : '';
}

/** config.json 的基线内容：白名单 6 项 + 一批「不许被碰」的键（顺序/格式都固定）。 */
function baseConfig(extra = {}) {
  return {
    gatewayPort: 3051,
    quotaPollIntervalMs: 600000,
    quotaActivePollIntervalMs: 60000,
    quotaActiveWindowMs: 300000,
    requestLogEnabled: true,
    requestLogRetentionDays: 7,
    requestLogMaxMb: 32,
    publicDashboard: true,
    allowPassthrough: false,
    logLevel: 'info',
    ...extra,
  };
}

async function settingsGateway({ config = baseConfig(), setup = true } = {}) {
  const dir = makeTmpDir();
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  const ctx = await startTestGateway({ rootDir: dir, configPath, noInitialRefresh: true });
  let cookie = '';
  if (setup) {
    const res = await request(`${ctx.baseUrl}/api/auth/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: USER.name, password: USER.pass }),
    });
    assert.equal(res.status, 201, `setup 失败：${res.status} ${res.body}`);
    cookie = setCookieOf(res);
  }
  return { ctx, cookie, configPath, dir };
}

const H = (cookie) => ({ 'content-type': 'application/json', cookie });
const getSettings = (baseUrl, cookie) => request(`${baseUrl}/api/admin/settings`, { headers: { cookie } });
const patchSettings = (baseUrl, cookie, body) => request(`${baseUrl}/api/admin/settings`, {
  method: 'PATCH', headers: H(cookie), body: typeof body === 'string' ? body : JSON.stringify(body),
});

// ── 1：GET 白名单 + PATCH 落盘 ─────────────────────────────────────────
test('设置#1：GET 只回 6 个白名单字段的当前生效值（JSON.parse 后逐字段断言）', async (t) => {
  const { ctx, cookie } = await settingsGateway({ config: baseConfig({ publicDashboard: false, requestLogMaxMb: 64 }) });
  t.after(() => ctx.close());

  const res = await getSettings(ctx.baseUrl, cookie);
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.deepEqual(Object.keys(body.settings).sort(), [...KEYS].sort(), '只回白名单 6 项，不多不少');
  assert.equal(body.settings.publicDashboard, false);
  assert.equal(body.settings.requestLogMaxMb, 64);
  assert.equal(body.settings.requestLogEnabled, true);
  assert.equal(body.settings.requestLogRetentionDays, 7);
  assert.equal(body.settings.quotaPollIntervalMs, 600000);
  assert.equal(body.settings.quotaActivePollIntervalMs, 60000);
});

test('设置#2：PATCH 合法值落盘，其余键逐字节不变 + 写前留 .bak', async (t) => {
  const { ctx, cookie, configPath } = await settingsGateway();
  t.after(() => ctx.close());
  const before = fs.readFileSync(configPath, 'utf8');

  const res = await patchSettings(ctx.baseUrl, cookie, { publicDashboard: false, requestLogRetentionDays: 30 });
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.settings.publicDashboard, false);
  assert.equal(body.settings.requestLogRetentionDays, 30);

  const after = fs.readFileSync(configPath, 'utf8');
  // 逐字节：除被改的两个值 token 外，一个字节都不许动（顺序 / 缩进 / 其余键全保留）。
  const expected = before
    .replace('"publicDashboard": true', '"publicDashboard": false')
    .replace('"requestLogRetentionDays": 7', '"requestLogRetentionDays": 30');
  assert.notEqual(after, before, '确实写盘了');
  assert.equal(after, expected, '除白名单两个 token 外其余内容逐字节不变');

  // 读回 config.json 断言真的落盘。
  const disk = JSON.parse(after);
  assert.equal(disk.publicDashboard, false);
  assert.equal(disk.requestLogRetentionDays, 30);
  assert.equal(disk.requestLogMaxMb, 32, '未提交的键保持原值');
  assert.equal(disk.gatewayPort, 3051, '非白名单键原样保留');

  // 写前备份：.bak 就是写盘前的内容。
  assert.equal(fs.readFileSync(`${configPath}.bak`, 'utf8'), before, '.bak 是写盘前的内容');

  // 当前生效值立刻同步（GET 回新值）。
  const after2 = JSON.parse((await getSettings(ctx.baseUrl, cookie)).body);
  assert.equal(after2.settings.publicDashboard, false);
  assert.equal(after2.settings.requestLogRetentionDays, 30);
});

test('设置#3：连续两次相同 PATCH 都 200 且第二次不再改动文件（幂等）', async (t) => {
  const { ctx, cookie, configPath } = await settingsGateway();
  t.after(() => ctx.close());

  const first = await patchSettings(ctx.baseUrl, cookie, { requestLogMaxMb: 128 });
  assert.equal(first.status, 200);
  const afterFirst = fs.readFileSync(configPath, 'utf8');

  const second = await patchSettings(ctx.baseUrl, cookie, { requestLogMaxMb: 128 });
  assert.equal(second.status, 200);
  assert.equal(JSON.parse(second.body).settings.requestLogMaxMb, 128);
  assert.equal(fs.readFileSync(configPath, 'utf8'), afterFirst, '重放同一 PATCH 不改动文件');
});

// ── 2：400 分支 ───────────────────────────────────────────────────────
test('设置#4：类型错 / 越界 / 未知字段 / 非对象 body → 400，且不落盘', async (t) => {
  const { ctx, cookie, configPath } = await settingsGateway();
  t.after(() => ctx.close());
  const before = fs.readFileSync(configPath, 'utf8');

  const cases = [
    [{ publicDashboard: 'yes' }, '布尔项给字符串'],
    [{ requestLogEnabled: 1 }, '布尔项给数字'],
    [{ quotaPollIntervalMs: '60000' }, '整数项给字符串'],
    [{ requestLogRetentionDays: 1.5 }, '整数项给小数'],
    [{ requestLogRetentionDays: 0 }, '下界外'],
    [{ requestLogRetentionDays: 366 }, '上界外'],
    [{ requestLogRetentionDays: -1 }, '负数'],
    [{ requestLogMaxMb: 0 }, '单文件上限 0'],
    [{ requestLogMaxMb: 1025 }, '单文件上限越界'],
    [{ quotaPollIntervalMs: 4999 }, '轮询下界外'],
    [{ quotaActivePollIntervalMs: 3600001 }, '活跃轮询上界外'],
    [{ nope: 1 }, '未知字段'],
    [{ publicDashboard: true, alsoUnknown: {} }, '合法字段 + 未知字段'],
    ['[1,2,3]', '数组 body'],
    ['"just a string"', '字符串 body'],
  ];
  for (const [payload, label] of cases) {
    const res = await patchSettings(ctx.baseUrl, cookie, payload);
    assert.equal(res.status, 400, `${label} 必须 400（实得 ${res.status}：${res.body}）`);
    const body = JSON.parse(res.body);
    assert.ok(body.error && typeof body.error.message === 'string' && body.error.message.length > 0, `${label} 必须带可读原因`);
  }
  assert.equal(fs.readFileSync(configPath, 'utf8'), before, '任何 400 都不许写盘');
});

// ── 3：写盘失败 → 内存值不变 ──────────────────────────────────────────
test('设置#5：写盘失败 → 500，内存值保持不变（不出现假成功）', async (t) => {
  const { ctx, cookie, configPath } = await settingsGateway();
  t.after(() => ctx.close());
  const before = fs.readFileSync(configPath, 'utf8');

  // 让写 .bak 的那一步必然失败：把 config.json.bak 建成目录（root 也绕不过 EISDIR）。
  fs.mkdirSync(`${configPath}.bak`);

  const res = await patchSettings(ctx.baseUrl, cookie, { publicDashboard: false, requestLogRetentionDays: 99 });
  assert.equal(res.status, 500, `写盘失败必须 500（实得 ${res.status}：${res.body}）`);
  const body = JSON.parse(res.body);
  assert.equal(body.error.type, 'admin_error');

  // 盘没写、内存也没改 —— GET 仍回旧值。
  assert.equal(fs.readFileSync(configPath, 'utf8'), before, '写盘失败后 config.json 原样不变');
  const view = JSON.parse((await getSettings(ctx.baseUrl, cookie)).body);
  assert.equal(view.settings.publicDashboard, true, '内存值不变');
  assert.equal(view.settings.requestLogRetentionDays, 7, '内存值不变');

  // 修好写入条件后，同样的 PATCH 应能成功（证明前面只是写盘失败，不是逻辑被写死）。
  fs.rmdirSync(`${configPath}.bak`);
  const retry = await patchSettings(ctx.baseUrl, cookie, { publicDashboard: false, requestLogRetentionDays: 99 });
  assert.equal(retry.status, 200);
  assert.equal(JSON.parse(retry.body).settings.publicDashboard, false);
});

// ── 4：未登录 → 401 ───────────────────────────────────────────────────
test('设置#6：未登录访问 GET / PATCH /api/admin/settings → 401', async (t) => {
  const { ctx } = await settingsGateway({ setup: false });
  t.after(() => ctx.close());

  const get = await request(`${ctx.baseUrl}/api/admin/settings`);
  assert.equal(get.status, 401);
  const patch = await patchSettings(ctx.baseUrl, '', { publicDashboard: false });
  assert.equal(patch.status, 401, `未登录 PATCH 必须 401（实得 ${patch.status}）`);
  // 未登录时也不许落盘。
  assert.equal(JSON.parse(fs.readFileSync(path.join(ctx.dir, 'config.json'), 'utf8')).publicDashboard, true);
});

// ── 5：设置页 DOM 契约（真行为：填值 / 保存 / 失败回滚）────────────────
const jsonRes = (v, status = 200) => ({ ok: status < 400, status, json: async () => v });

/** 已登录的后台页面，/api/admin/settings 由内存对象驱动；可切换成失败。 */
async function settingsPage() {
  const current = {
    requestLogEnabled: true, requestLogRetentionDays: 7, requestLogMaxMb: 32,
    publicDashboard: true, quotaPollIntervalMs: 600000, quotaActivePollIntervalMs: 60000,
  };
  const stateBox = { mode: 'ok' };
  const fetchImpl = async (url, opts) => {
    if (url === '/api/auth/me') return jsonRes({ authenticated: true, user: { username: 'admin' } });
    if (url === '/api/admin/session') return jsonRes({ authenticated: true, users: [], dashboardPublic: false, writable: true });
    if (url === '/api/admin/settings') {
      if ((opts?.method ?? 'GET') === 'PATCH') {
        if (stateBox.mode === 'fail') return jsonRes({ error: { message: '配置写入失败，内存值保持不变' } }, 500);
        Object.assign(current, JSON.parse(opts.body));
      }
      return jsonRes({ ok: true, settings: { ...current } });
    }
    if (url.startsWith('/api/admin/')) return jsonRes({});
    return jsonRes({});
  };
  const shim = createDomShim({ html: ADMIN_HTML, fetchImpl, localStorageData: {} });
  const page = await runInlineScript(ADMIN_HTML, shim);
  vm.runInContext('state.auth = { authenticated: true, user: { username: "admin" } };', page);
  return { shim, page, current, stateBox };
}

test('设置#7：设置页有 6 个控件 + 保存按钮，只覆盖白名单 key', () => {
  const controls = [...ADMIN_HTML.matchAll(/data-setting="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual([...controls].sort(), [...KEYS].sort(), 'data-setting 恰好是 6 个白名单键');
  assert.match(ADMIN_HTML, /id="settings-save"/, '存在保存按钮');
  assert.match(ADMIN_HTML, /id="page-settings"/, '存在设置页容器');
  assert.ok(ADMIN_HTML.includes('data-nav="settings"'), '侧边栏有「系统设置」菜单项');
  // 白名单外的 key 不得成为可编辑控件。
  for (const forbidden of ['gatewayPort', 'logLevel', 'allowPassthrough', 'quotaActiveWindowMs', 'maxBodyBytes']) {
    assert.ok(!ADMIN_HTML.includes(`data-setting="${forbidden}"`), `不得出现白名单外的可编辑项 ${forbidden}`);
  }
});

test('设置#8：loadSettings 把当前值填进控件与「当前值」列', async () => {
  const { shim, page, current } = await settingsPage();
  await page.loadSettings();
  assert.equal(shim.el('set-requestLogEnabled').checked, true, '布尔项按当前值勾选');
  assert.equal(shim.el('set-publicDashboard').checked, true);
  assert.equal(shim.el('set-requestLogMaxMb').value, '32', '数字项写入 value');
  assert.equal(shim.el('set-quotaPollIntervalMs').value, '600000');
  assert.equal(shim.document.querySelector('[data-current="requestLogEnabled"]').textContent, '开');
  assert.equal(shim.document.querySelector('[data-current="requestLogMaxMb"]').textContent, '32');
  assert.equal(current.publicDashboard, true);
});

test('设置#9：保存成功 → 提示已保存并刷新当前值', async () => {
  const { shim, page, current } = await settingsPage();
  await page.loadSettings();
  shim.el('set-quotaPollIntervalMs').value = '120000';
  shim.el('set-publicDashboard').checked = false;
  await page.saveSettings();

  assert.equal(current.quotaPollIntervalMs, 120000, 'PATCH 真发出去了');
  assert.equal(current.publicDashboard, false);
  assert.equal(shim.el('settings-status').textContent, '已保存');
  assert.equal(shim.document.querySelector('[data-current="quotaPollIntervalMs"]').textContent, '120000');
  assert.equal(shim.document.querySelector('[data-current="publicDashboard"]').textContent, '关');
});

test('设置#10：保存失败 → 显示后端原因且控件回滚到保存前的值', async () => {
  const { shim, page, stateBox } = await settingsPage();
  await page.loadSettings();
  const baseMax = shim.el('set-requestLogMaxMb').value;     // '32'
  const baseChecked = shim.el('set-requestLogEnabled').checked; // true

  shim.el('set-requestLogMaxMb').value = '999';
  shim.el('set-requestLogEnabled').checked = !baseChecked;
  stateBox.mode = 'fail';
  await page.saveSettings();

  assert.equal(shim.el('settings-status').textContent, '', '失败时不留「已保存」');
  const err = shim.el('settings-err').textContent;
  assert.ok(err.includes('保存失败'), `错误区要显示失败：${err}`);
  assert.ok(err.includes('配置写入失败，内存值保持不变'), '显示后端返回的原因');
  assert.ok(!shim.el('settings-err').classList.contains('hidden'), '错误横幅必须可见');
  assert.equal(shim.el('set-requestLogMaxMb').value, baseMax, '数字控件回滚');
  assert.equal(shim.el('set-requestLogEnabled').checked, baseChecked, '开关控件回滚');
  assert.equal(shim.document.querySelector('[data-current="requestLogMaxMb"]').textContent, '32', '当前值列也回滚');
});

// ── 6：未登录外壳隐藏（§1，真行为 + 真 CSS）───────────────────────────
test('设置#11：showGate 隐藏后台外壳，showAdmin 恢复（真行为，不是字符串）', async () => {
  const shim = createDomShim({ html: ADMIN_HTML, fetchImpl: async () => jsonRes({}), localStorageData: {} });
  const page = await runInlineScript(ADMIN_HTML, shim);
  const shell = () => shim.el('admin-shell');

  assert.ok(shell(), '外壳容器 #admin-shell 仍在产出 HTML 里（DOM 不许删）');
  assert.ok(shim.el('admin-nav'), '#admin-nav 仍在');
  for (const id of ['page-accounts', 'page-keys', 'page-users', 'page-events', 'page-logs', 'page-usage', 'page-settings']) {
    assert.ok(shim.el(id), `${id} 仍在`);
  }

  vm.runInContext('showAdmin();', page);
  assert.equal(shell().classList.contains('shell-hidden'), false, '已登录：外壳不带隐藏类');
  assert.equal(shim.el('gate-main').style.display, 'none', '已登录：登录门隐藏');

  vm.runInContext('showGate("login", { authenticated: false });', page);
  assert.equal(shell().classList.contains('shell-hidden'), true, '未登录：外壳带隐藏类（display:none）');
  assert.equal(shim.document.body.className, 'gate', '未登录：body.gate 兜底');
  assert.equal(shim.el('gate-main').style.display, '', '未登录：登录门可见');

  vm.runInContext('showAdmin();', page);
  assert.equal(shell().classList.contains('shell-hidden'), false, '重新登录：外壳恢复');
  assert.equal(shim.document.body.className, '', 'body 类复位');
});

test('设置#12：隐藏外壳的 CSS 落在可命中 .drawer 的层级（display:none）', () => {
  // 构建产物里的 CSS：断言隐藏规则真的存在且是 display:none（不依赖 @layer 特异性）。
  const distDir = new URL('../panel/dist/assets/', import.meta.url);
  const cssFiles = fs.readdirSync(distDir).filter((f) => f.endsWith('.css'));
  const all = cssFiles.map((f) => fs.readFileSync(new URL(f, distDir), 'utf8')).join('\n');
  assert.match(all, /#admin-shell\.shell-hidden\s*\{[^}]*display:\s*none/, '存在 #admin-shell.shell-hidden → display:none');
  assert.match(all, /body\.gate #admin-shell,[^}]*display:\s*none/, 'body.gate 兜底规则也在');
});
