// 后台「概览」仪表盘（默认首页）：只读 panel/dist/admin.html + 既有 DOM 垫片跑页面脚本。
// 注意：本文件不启动网关、**不断言任何 JSON 响应体子串**（本项目有「时间戳末位恰好命中」的历史
//      flake）；所有「接了真实数据」都靠「请求 URL + 渲染后的 DOM」来断言。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createDomShim, runInlineScript, sleep } from './helpers.mjs';

const ADMIN_HTML = fs.readFileSync(new URL('../panel/dist/admin.html', import.meta.url), 'utf8');

const USAGE_URL = '/api/admin/usage?range=24h&bucket=1h';
const STATUS_URL = '/api/status';
const LOGS_URL = '/api/admin/logs?limit=10';

const json = (v, status = 200) => ({ ok: status < 400, status, json: async () => v });
async function waitFor(fn, ms = 1500) {
  const started = Date.now();
  while (Date.now() - started < ms) { if (fn()) return true; await sleep(5); }
  return fn();
}

/** 已登录后台 + 概览三个接口的可控返回；同时记录请求过的 URL。 */
function overviewFetch({ usage = { totals: {} }, status = { summary: {}, accounts: [] }, logs = { items: [], stats: {} } } = {}) {
  const calls = [];
  const impl = async (url) => {
    const u = String(url);
    calls.push(u);
    if (u === '/api/auth/me') return json({ authenticated: true, user: { username: 'admin' } });
    if (u === '/api/admin/session') return json({ users: [], dashboardPublic: false, writable: true });
    if (u === '/api/admin/keys') return json({ keys: [] });
    if (u.startsWith('/api/admin/events')) return json({ events: [] });
    if (u.startsWith('/api/admin/accounts')) return json({ accounts: [], tests: [], writable: true });
    if (u === USAGE_URL) return json({ ok: true, ...usage });
    if (u === STATUS_URL) return json({ ok: true, ...status });
    if (u === LOGS_URL) return json({ ok: true, enabled: true, hasMore: false, ...logs });
    if (u === '/ready') return json({ ok: true, upstream: 'up' });
    return json({});
  };
  return { impl, calls };
}

async function overviewPage(fetchImpl) {
  const shim = createDomShim({ html: ADMIN_HTML, fetchImpl: fetchImpl ?? (async () => json({})), localStorageData: {} });
  const listeners = {};
  shim.window.addEventListener = (type, fn) => { (listeners[type] ??= []).push(fn); };
  const page = await runInlineScript(ADMIN_HTML, shim);
  return { shim, page, listeners };
}

function account(name, { available = true, pct5h = 10, pctWeek = 20, remaining = 5 } = {}) {
  return {
    keyId: name + '-id', name, enabled: true, available,
    creditsExhausted: false, exhausted: available ? null : { kind: 'weekly', label: '周额度已用完' },
    paused: false, rateLimited: false, authInvalid: false,
    lastQuota: { plan: null, remaining, fiveHour: {}, weekly: {}, percent: { fiveHour: pct5h, weekly: pctWeek, monthly: 0 }, fetchedAt: 0 },
  };
}

// ── 1：概览容器 + 默认页 + #/accounts 可切 ───────────────────────────
test('概览#1：#page-overview 存在且是默认可见页，#/accounts 仍可切换', async () => {
  const { shim, page, listeners } = await overviewPage();
  assert.ok(shim.el('page-overview'), '存在 #page-overview 容器');
  assert.equal(page.adminRouteOf(''), 'overview', '空 hash 默认 overview');
  assert.equal(page.adminRouteOf('#/unknown'), 'overview', '未知 hash 默认 overview');
  assert.equal(shim.el('page-overview').style.display, '', '概览默认可见');
  assert.equal(shim.el('page-overview').getAttribute('aria-hidden'), 'false', '概览 aria-hidden=false');
  for (const id of ['page-accounts', 'page-keys', 'page-users', 'page-events', 'page-logs', 'page-usage']) {
    assert.equal(shim.el(id).style.display, 'none', `${id} 默认隐藏`);
  }

  shim.window.location.hash = '#/accounts';
  for (const fn of listeners.hashchange ?? []) fn();
  assert.equal(shim.el('page-accounts').style.display, '', '切到 #/accounts 后账号页可见');
  assert.equal(shim.el('page-overview').style.display, 'none', '概览随之隐藏');
});

// ── 2：四张 KPI 卡，数字来自接口（请求 URL + 渲染后的文本）──────────
test('概览#2：四张 KPI 卡的数字来自 /api/admin/usage 与 /api/status', async () => {
  const { impl, calls } = overviewFetch({
    usage: { totals: { requests: 1234, errors: 7, tokensIn: 1000, tokensOut: 2345 } },
    status: { summary: { accounts: 3, available: 2, unavailable: 1 }, accounts: [] },
  });
  const { shim } = await overviewPage(impl);
  await waitFor(() => shim.el('overview-requests').textContent === '1,234');

  for (const id of ['overview-requests', 'overview-error-rate', 'overview-tokens', 'overview-accounts-available']) {
    assert.ok(shim.el(id), `缺少 KPI 节点 ${id}`);
  }
  assert.ok(calls.includes(USAGE_URL), `必须请求 ${USAGE_URL}（实得：${calls.join(', ')}）`);
  assert.ok(calls.includes(STATUS_URL), `必须请求 ${STATUS_URL}`);
  assert.ok(calls.includes(LOGS_URL), `必须请求 ${LOGS_URL}`);

  assert.equal(shim.el('overview-requests').textContent, '1,234', '今日请求 = totals.requests（千分位）');
  assert.equal(shim.el('overview-error-rate').textContent, '0.6%', '错误率 = errors/requests，保留 1 位');
  assert.equal(shim.el('overview-tokens').textContent, '3,345', 'token = tokensIn + tokensOut（千分位）');
  assert.equal(shim.el('overview-accounts-available').textContent, '2 / 3', '可用账号 = available / accounts');
});

test('概览#2b：requests=0 时错误率显示 —（不出现 NaN / Infinity）', async () => {
  const { impl } = overviewFetch({
    usage: { totals: { requests: 0, errors: 0, tokensIn: 0, tokensOut: 0 } },
    status: { summary: { accounts: 0, available: 0, unavailable: 0 }, accounts: [] },
  });
  const { shim } = await overviewPage(impl);
  await waitFor(() => shim.el('overview-requests').textContent === '0');
  assert.equal(shim.el('overview-error-rate').textContent, '—', '零请求不能除零');
  for (const id of ['overview-requests', 'overview-error-rate', 'overview-tokens', 'overview-accounts-available']) {
    assert.ok(!String(shim.el(id).textContent).includes('NaN'), `${id} 不得出现 NaN`);
  }
});

// ── 3：账号池概览行 = 接口账号数；整行链到 #/accounts ───────────────
test('概览#3：账号池概览行数 = 接口返回的账号数，行整块链到 #/accounts', async () => {
  const accounts = [
    account('主号', { available: true }),
    account('副号1', { available: false }),
    account('副号2', { available: true }),
  ];
  const { impl } = overviewFetch({ status: { summary: { accounts: 3, available: 2, unavailable: 1 }, accounts } });
  const { shim } = await overviewPage(impl);
  await waitFor(() => shim.document.querySelectorAll('#overview-accounts a').length === 3);

  const rows = shim.document.querySelectorAll('#overview-accounts a');
  assert.equal(rows.length, accounts.length, '行数必须等于接口返回的账号数');
  assert.equal(rows[0].getAttribute('href'), '#/accounts', '整行点击跳账号池页');
  assert.ok(rows[0].textContent.includes('主号'), '账号名已渲染');
  assert.ok(rows[1].textContent.includes('副号1'), '第二个账号名已渲染');

  // 状态色点：可用=success，不可用=error（只读语义，不渲染匿名视图没有的 displayName/lastError）。
  const dots = rows.map((r) => r.querySelectorAll('.status-dot')[0].className);
  assert.match(dots[0], /bg-success/, '可用账号用语义绿点');
  assert.match(dots[1], /bg-error/, '不可用账号用语义红点');
  assert.ok(!rows[0].textContent.includes('undefined'), '未知字段不得渲染成 undefined');

  // 5h / 周两个百分比条：value 来自接口 percent（取 1 位小数）。
  const bar = rows[0].querySelectorAll('progress')[0];
  assert.equal(bar.getAttribute('value'), '10', '5h 条 value 来自接口');
  assert.equal(rows[0].querySelectorAll('progress').length, 2, '每行 5h/周两个条');
});

// ── 4：最近请求行 = 返回条数（含空态分支）────────────────────────────
test('概览#4：最近请求行数 = 返回条数；空态显示「暂无请求日志」', async () => {
  const items = [
    { t: new Date(2026, 0, 2, 3, 4, 5).getTime(), keyName: '客户端A', keyId: 'k1', model: 'claude-3', status: 200, dur: 1240 },
    { t: new Date(2026, 0, 2, 3, 5, 6).getTime(), keyName: '客户端B', keyId: 'k2', model: 'gpt', status: 503, dur: 20, error: '上游 503' },
  ];
  const { impl } = overviewFetch({ logs: { items, stats: { written: 2, dropped: 0, degraded: false } } });
  const { shim } = await overviewPage(impl);
  await waitFor(() => shim.document.querySelectorAll('#overview-logs tr.overview-log').length === 2);

  const rows = shim.document.querySelectorAll('#overview-logs tr.overview-log');
  assert.equal(rows.length, items.length, '行数 = 接口返回条数');
  const out = shim.el('overview-logs').innerHTML;
  assert.ok(out.includes('03:04:05'), '时间列是 HH:mm:ss');
  assert.ok(out.includes('客户端A'), '客户端列');
  assert.ok(out.includes('claude-3'), '模型列');
  assert.ok(out.includes('1.24s'), '耗时列');
  assert.match(out, /bg-success/, '成功用语义绿点');
  assert.match(out, /bg-error/, '≥400 用语义红点');

  // 空态分支。
  const empty = overviewFetch({ logs: { items: [], stats: { written: 0, dropped: 0, degraded: false } } });
  const { shim: shim2 } = await overviewPage(empty.impl);
  await waitFor(() => shim2.el('overview-logs').innerHTML.length > 0);
  assert.equal(shim2.document.querySelectorAll('#overview-logs tr.overview-log').length, 0, '空态没有数据行');
  assert.ok(shim2.el('overview-logs').innerHTML.includes('暂无请求日志'), '空态给真话');
});

// ── 5：异常提示条（至少两条分支）─────────────────────────────────────
test('概览#5：有异常 → 醒目提示；无异常 → 「一切正常」', async () => {
  // 分支一：有账号不可用。
  const bad = overviewFetch({
    usage: { totals: { requests: 100, errors: 1, tokensIn: 0, tokensOut: 0 } },
    status: { summary: { accounts: 2, available: 1, unavailable: 1 }, accounts: [account('主号'), account('副号', { available: false })] },
    logs: { items: [], stats: { written: 3, dropped: 0, degraded: false } },
  });
  const { shim } = await overviewPage(bad.impl);
  await waitFor(() => shim.el('overview-alert').textContent.includes('不可用'));
  assert.ok(shim.el('overview-alert').classList.contains('alert-warning'), '异常时是醒目告警样式');
  assert.ok(shim.el('overview-alert').textContent.includes('1 个账号不可用'), '说清是哪个条件命中');

  // 分支二：一切正常。
  const ok = overviewFetch({
    usage: { totals: { requests: 100, errors: 1, tokensIn: 0, tokensOut: 0 } },
    status: { summary: { accounts: 2, available: 2, unavailable: 0 }, accounts: [account('主号'), account('副号')] },
    logs: { items: [], stats: { written: 3, dropped: 0, degraded: false } },
  });
  const { shim: shim2 } = await overviewPage(ok.impl);
  await waitFor(() => shim2.el('overview-alert').textContent === '一切正常');
  assert.equal(shim2.el('overview-alert').textContent, '一切正常', '无异常给中性一行');
  assert.ok(!shim2.el('overview-alert').classList.contains('alert-warning'), '无异常不带告警样式');

  // 分支三：24h 错误率 > 5% 且请求数 ≥ 20（样本足够才报）。
  const highErr = overviewFetch({
    usage: { totals: { requests: 100, errors: 10, tokensIn: 0, tokensOut: 0 } },
    status: { summary: { accounts: 1, available: 1, unavailable: 0 }, accounts: [account('主号')] },
    logs: { items: [], stats: { written: 1, dropped: 0, degraded: true } },
  });
  const { shim: shim3 } = await overviewPage(highErr.impl);
  await waitFor(() => shim3.el('overview-alert').textContent.includes('错误率'));
  assert.ok(shim3.el('overview-alert').textContent.includes('10.0%'), '错误率写进提示');

  // 分支四：请求日志被降级 / 丢弃。
  const dropped = overviewFetch({
    usage: { totals: { requests: 100, errors: 1, tokensIn: 0, tokensOut: 0 } },
    status: { summary: { accounts: 1, available: 1, unavailable: 0 }, accounts: [account('主号')] },
    logs: { items: [], stats: { written: 3, dropped: 4, degraded: false } },
  });
  const { shim: shim4 } = await overviewPage(dropped.impl);
  await waitFor(() => shim4.el('overview-alert').textContent.includes('丢弃'));
  assert.ok(shim4.el('overview-alert').textContent.includes('4'), '丢弃条数写进提示');
});

// ── 6：小样本不误报（错误率高但请求数 < 20）──────────────────────────
test('概览#6：请求数 < 20 时即使错误率高也不报异常', async () => {
  const { impl } = overviewFetch({
    usage: { totals: { requests: 5, errors: 5, tokensIn: 0, tokensOut: 0 } },
    status: { summary: { accounts: 1, available: 1, unavailable: 0 }, accounts: [account('主号')] },
    logs: { items: [], stats: { written: 1, dropped: 0, degraded: false } },
  });
  const { shim } = await overviewPage(impl);
  await waitFor(() => shim.el('overview-alert').textContent === '一切正常');
  assert.equal(shim.el('overview-alert').textContent, '一切正常', '样本太小不乱报');
});

// ── 7：跟随既有轮询节奏，不新增第二个定时器 ─────────────────────────
test('概览#7：概览复用 app-admin.js 的唯一 10s 定时器，不自带定时器', async () => {
  const appSrc = fs.readFileSync(new URL('../panel/public/js/app-admin.js', import.meta.url), 'utf8');
  assert.equal((appSrc.match(/setInterval\(/g) ?? []).length, 1, 'app-admin.js 只应有 1 个 setInterval');
  assert.match(appSrc, /adminPageVisible\('overview'\)/, '同一定时器里按当前页决定刷概览');

  const overviewSrc = fs.readFileSync(new URL('../panel/public/js/admin-overview.js', import.meta.url), 'utf8');
  assert.equal((overviewSrc.match(/setInterval\(/g) ?? []).length, 0, '概览脚本不得自带第二个定时器');

  // 切页钩子也走既有 onAdminPageChange（不是新监听）。
  const { shim, page, listeners } = await overviewPage();
  assert.equal(typeof page.loadOverview, 'function', 'loadOverview 是页面全局');
  void shim; void listeners;
});
