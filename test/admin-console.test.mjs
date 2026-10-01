// 侧边栏多页控制台：静态壳结构 + hash 路由真行为 + 请求日志页渲染。
// 只读 panel/dist/admin.html + 复用既有 DOM 垫片跑页面脚本（零依赖、无浏览器）。
// 注意：本文件不启动网关、不断言任何 JSON 响应体（避免「时间戳恰好命中」的历史 flake）；
//      所有「接真实数据」都通过「请求 URL + 渲染后的 DOM」来断言。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createDomShim, runInlineScript, sleep } from './helpers.mjs';

const ADMIN_HTML = fs.readFileSync(new URL('../panel/dist/admin.html', import.meta.url), 'utf8');

// ── 被测试钉死的钩子清单（与任务书一致：一个都不许删/改名）──────────────
const HOOK_IDS = [
  'gate-main', 'gate-user', 'gate-pass', 'gate-pass2', 'boot-loading', 'admin-head', 'admin-main',
  'who', 'logout', 'theme', 'public-note', 'readonly', 'load-error', 'load-error-text', 'load-retry',
  'sec-accounts', 'accounts', 'acc-count', 'add-account', 'sec-keys', 'keys', 'add-key',
  'k-form', 'k-name', 'k-plain', 'k-result', 'k-submit',
  'add-user', 'users', 'u-pass', 'u-submit', 'p-sub', 'p-current', 'p-current-field', 'p-pass',
  'p-submit', 'p-err', 'r-name', 'r-err', 'r-sub', 'r-submit',
  'm-account', 'm-pass', 'm-newkey', 'm-rename', 'm-user', 'a-name', 'a-key', 'a-submit',
  'events', 'event-count', 'level', 'tpl-event', 'toast',
];
const PAGE_IDS = ['page-accounts', 'page-keys', 'page-users', 'page-events', 'page-logs'];

const json = (v, status = 200) => ({ ok: status < 400, status, json: async () => v });
async function waitFor(fn, ms = 1000) {
  const started = Date.now();
  while (Date.now() - started < ms) { if (fn()) return true; await sleep(5); }
  return fn();
}
function dom(html, fetchImpl) {
  return createDomShim({ html, fetchImpl: fetchImpl ?? (async () => json({})), localStorageData: {} });
}

/** 已登录的后台页面：/api/auth/me 返回已认证，其余后台接口给空数据。 */
function adminFetch(extra = {}) {
  return async (url, opts) => {
    if (extra[url]) return extra[url](opts);
    if (url === '/api/auth/me') return json({ authenticated: true, user: { username: 'admin' } });
    if (url === '/api/admin/session') return json({ users: [], dashboardPublic: false, writable: true });
    if (url === '/api/admin/keys') return json({ keys: [] });
    if (url.startsWith('/api/admin/events')) return json({ events: [] });
    if (url.startsWith('/api/admin/accounts')) return json({ accounts: [], tests: [], writable: true });
    if (url.startsWith('/api/admin/logs')) return json({ ok: true, enabled: true, items: [], hasMore: false, stats: { written: 0, dropped: 0, degraded: false } });
    return json({});
  };
}

/** 跑一遍后台脚本，并把 window.addEventListener 的监听收集起来（垫片默认是 no-op）。 */
async function consolePage(fetchImpl) {
  const shim = dom(ADMIN_HTML, fetchImpl);
  const listeners = {};
  shim.window.addEventListener = (type, fn) => { (listeners[type] ??= []).push(fn); };
  const page = await runInlineScript(ADMIN_HTML, shim);
  return { shim, page, listeners };
}

// ── 1：外壳与页面容器 ────────────────────────────────────────────────
test('控制台#1：admin.html 有固定侧边栏容器与 5 个页面容器', () => {
  assert.match(ADMIN_HTML, /class="admin-sidebar\b/, '存在侧边栏容器 .admin-sidebar');
  assert.match(ADMIN_HTML, /class="drawer-side z-30"/, '侧边栏在 .drawer-side 里（<1024px 收成抽屉）');
  assert.match(ADMIN_HTML, /class="drawer lg:drawer-open"/, '外层仍是 .drawer.lg:drawer-open（≥1024px 固定显示）');
  assert.match(ADMIN_HTML, /<input id="admin-drawer" type="checkbox" class="drawer-toggle">/, '保留 #admin-drawer 复选框机制');
  assert.match(ADMIN_HTML, /class="admin-sidebar[^"]*\bw-56\b/, '侧边栏约 224px（w-56 = 14rem）');
  assert.match(ADMIN_HTML, /class="[^"]*\badmin-nav\b[^"]*" id="admin-nav"/, '菜单容器 #admin-nav');

  for (const id of PAGE_IDS) {
    assert.match(ADMIN_HTML, new RegExp('class="admin-page" id="' + id + '"'), `缺少页面容器 ${id}`);
  }
  const pageCount = (ADMIN_HTML.match(/class="admin-page"/g) ?? []).length;
  const hasUsage = ADMIN_HTML.includes('id="page-usage"');
  assert.equal(pageCount, PAGE_IDS.length + (hasUsage ? 1 : 0),
    `页面容器数 = 5 个必需页${hasUsage ? ' + 1 个可选用量统计页' : ''}（实得 ${pageCount}）`);
  // 5 个页面容器都在 #admin-main 里面（切页只动它们的显隐，不换壳）。
  const mainStart = ADMIN_HTML.indexOf('id="admin-main"');
  const mainEnd = ADMIN_HTML.indexOf('</main>', mainStart);
  const main = ADMIN_HTML.slice(mainStart, mainEnd);
  for (const id of PAGE_IDS) assert.ok(main.includes('id="' + id + '"'), `${id} 必须在 #admin-main 内`);
  for (const id of ['sec-accounts', 'sec-keys', 'sec-users', 'sec-events']) {
    assert.ok(main.includes('id="' + id + '"'), `既有区块 ${id} 必须原样搬进页面容器`);
  }
  assert.match(ADMIN_HTML, /id="admin-head"[\s\S]*?id="who"[\s\S]*?id="logout"/, '#admin-head 保留 #who / #logout');
  assert.match(ADMIN_HTML, /id="admin-head"[\s\S]*?id="theme"/, '#admin-head 保留 #theme');
  assert.match(ADMIN_HTML, /id="admin-head"[\s\S]*?href="\/"/, '#admin-head 保留返回前台链接');
});

test('控制台#2：钩子清单里的每个 id 都还在 admin.html 里（缺一个就红）', () => {
  const missing = HOOK_IDS.filter((id) => !ADMIN_HTML.includes('id="' + id + '"'));
  assert.deepEqual(missing, [], `以下钩子 id 缺失：${missing.join(', ')}`);
});

test('控制台#3：菜单 5 项与 hash 路由一一对应', () => {
  for (const r of ['accounts', 'keys', 'users', 'events', 'logs']) {
    assert.match(ADMIN_HTML, new RegExp('href="#/' + r + '" data-nav="' + r + '"'), `菜单缺少 #/${r}`);
  }
});

// ── 2：请求日志页的筛选控件与表格骨架 ────────────────────────────────
test('控制台#4：请求日志页有筛选条与 8 列表格骨架', () => {
  const start = ADMIN_HTML.indexOf('id="page-logs"');
  const end = ADMIN_HTML.indexOf('id="page-usage"');
  const logs = ADMIN_HTML.slice(start, end);
  assert.match(logs, /<select id="logs-key"/, '客户端下拉');
  assert.match(logs, /<select id="logs-status"/, '状态下拉');
  assert.match(logs, /<input id="logs-model"/, '模型输入');
  assert.match(logs, /<input id="logs-q"/, '关键字输入');
  assert.match(logs, /<button id="logs-refresh"/, '刷新按钮');
  assert.match(logs, /<tbody id="logs"><\/tbody>/, '日志表体 #logs');
  assert.match(logs, /id="logs-more"[^>]*class="[^"]*hidden/, '「加载更多」默认隐藏');
  assert.match(logs, /id="logs-dropped"/, '丢弃提示位');
  const heads = [...logs.matchAll(/<th>([^<]*)<\/th>/g)].map((m) => m[1]);
  assert.equal(heads.length, 8, `表头应有 8 列，实得 ${heads.length}：${heads.join('/')}`);
  for (const col of ['时间', '客户端', '账号', '模型', '状态', '耗时', '入 token', '出 token']) {
    assert.ok(heads.includes(col), `表头缺少「${col}」`);
  }
  for (const id of ['tpl-log-row', 'tpl-log-empty']) {
    assert.match(ADMIN_HTML, new RegExp('<template id="' + id + '">'), `缺少模板 ${id}`);
  }
});

// ── 3：切页脚本被引入 + hashchange 真行为 ────────────────────────────
test('控制台#5：引入切页脚本，且 hashchange 监听真的注册了', async () => {
  assert.match(ADMIN_HTML, /<script src="js\/admin-console\.js"><\/script>/, '引入 js/admin-console.js');
  const { page, listeners } = await consolePage();
  assert.equal(typeof page.applyAdminHash, 'function', 'applyAdminHash 是页面全局');
  assert.ok((listeners.hashchange ?? []).length >= 1, 'admin-console.js 必须注册 hashchange 监听');
});

test('控制台#6：默认页是 #/overview，其余页面隐藏', async () => {
  const { shim, page } = await consolePage();
  assert.equal(page.adminRouteOf(''), 'overview', '空 hash 回落默认页 overview');
  assert.equal(page.adminRouteOf('#/nope'), 'overview', '未知 hash 回落默认页 overview');
  assert.equal(shim.el('page-overview').style.display, '', '默认页可见');
  for (const id of ['page-accounts', 'page-keys', 'page-users', 'page-events', 'page-logs', 'page-usage']) {
    assert.equal(shim.el(id).style.display, 'none', `${id} 非当前页必须隐藏`);
    assert.equal(shim.el(id).getAttribute('aria-hidden'), 'true', `${id} aria-hidden=true`);
  }
  assert.equal(shim.el('page-overview').getAttribute('aria-hidden'), 'false', '当前页 aria-hidden=false');
});

test('控制台#7：hashchange 切到 #/logs 时日志页可见（真行为，不只是字符串）', async () => {
  const { shim, page, listeners } = await consolePage();
  shim.window.location.hash = '#/logs';
  for (const fn of listeners.hashchange ?? []) fn();      // 模拟浏览器派发 hashchange

  assert.equal(page.adminRouteOf(shim.window.location.hash), 'logs', '解析出 logs');
  assert.equal(shim.el('page-logs').style.display, '', '日志页可见');
  assert.equal(shim.el('page-logs').getAttribute('aria-hidden'), 'false', '日志页 aria-hidden=false');
  assert.equal(shim.el('page-accounts').style.display, 'none', '原页面隐藏');
  const nav = shim.document.querySelectorAll('#admin-nav [data-nav]');
  const active = nav.filter((a) => a.getAttribute('aria-current') === 'page').map((a) => a.getAttribute('data-nav'));
  assert.deepEqual(active, ['logs'], '只有 #/logs 菜单项标为当前页');

  // 未知 hash 再切回去 → 回落默认页（本次起默认页是概览）。
  shim.window.location.hash = '#/does-not-exist';
  page.applyAdminHash();
  assert.equal(shim.el('page-overview').style.display, '', '未知 hash 回落 #/overview');
  assert.equal(shim.el('page-logs').style.display, 'none', '日志页重新隐藏');
});

// ── 4：请求日志页渲染（真实字段 → DOM）──────────────────────────────
test('控制台#8：日志行按「时间/客户端/账号/模型/状态/耗时/token」渲染，数字可读', async () => {
  const { shim, page } = await consolePage();
  vm.runInContext(`state.logs = [{
    t: new Date(2026, 0, 2, 3, 4, 5).getTime(), keyName: '客户端A', keyId: 'k1',
    accountName: '主号', model: 'claude-3', status: 200, dur: 1240,
    tokensIn: 12345, tokensOut: 6789, error: null,
  }]; state.logsHasMore = false; state.logsEnabled = true; state.logsStats = { written: 1, dropped: 0, degraded: false };`, page);
  page.renderLogs();

  const out = shim.el('logs').innerHTML;
  assert.match(out, /2026-01-02 03:04:05/, '时间列是 YYYY-MM-DD HH:mm:ss（本地时区）');
  assert.ok(out.includes('客户端A'), '客户端列显示 keyName');
  assert.ok(out.includes('主号'), '账号列显示 accountName');
  assert.ok(out.includes('claude-3'), '模型列');
  assert.match(out, /1\.24s/, '耗时 1240ms → 1.24s');
  assert.ok(out.includes('12,345'), '入 token 千分位');
  assert.ok(out.includes('6,789'), '出 token 千分位');
  assert.ok(out.includes('200'), '状态列显示状态码');
  assert.match(out, /bg-success/, '成功用语义绿点');
  assert.ok(!shim.el('logs-more').classList.contains('hidden'), 'hasMore=false 时…');
  assert.equal(shim.el('logs-count').textContent, '1 条', '条数正确');
});

test('控制台#8b：hasMore=true 显示「加载更多」，≥400 用语义红点', async () => {
  const { shim, page } = await consolePage();
  vm.runInContext(`state.logs = [{ t: Date.now(), keyName: 'x', accountName: 'y', model: 'm', status: 503, dur: 20, tokensIn: 0, tokensOut: 0, error: '上游 503' }];
    state.logsHasMore = true; state.logsEnabled = true; state.logsStats = { written: 2, dropped: 0, degraded: false };`, page);
  page.renderLogs();
  const out = shim.el('logs').innerHTML;
  assert.match(out, /bg-error/, '≥400 用语义红点');
  assert.ok(out.includes('503'), '显示状态码 503');
  assert.ok(!shim.el('logs-more').classList.contains('hidden'), 'hasMore=true 时按钮可见');
});

test('控制台#9：空态 / 关闭态 / 丢弃告警都给出真话（不静默）', async () => {
  const { shim, page } = await consolePage();

  vm.runInContext("state.logs = []; state.logsEnabled = true; state.logsStats = { written: 0, dropped: 0, degraded: false };", page);
  page.renderLogs();
  assert.ok(shim.el('logs').innerHTML.includes('暂无请求日志'), '空态文案');
  assert.ok(shim.el('logs-dropped').classList.contains('hidden'), '无丢弃时不显示告警');

  vm.runInContext("state.logsEnabled = false;", page);
  page.renderLogs();
  assert.ok(shim.el('logs').innerHTML.includes('请求日志已关闭（REQUEST_LOG_ENABLED=0）'), '关闭态文案');

  vm.runInContext("state.logsEnabled = true; state.logsStats = { written: 5, dropped: 3, degraded: true };", page);
  page.renderLogs();
  assert.ok(shim.el('logs-dropped').textContent.includes('3'), '丢条数写进告警');
  assert.ok(!shim.el('logs-dropped').classList.contains('hidden'), 'dropped>0 必须显示告警，不许静默');
});

// ── 5：请求构造与真实取数路径 ────────────────────────────────────────
test('控制台#10：logsQuery 按筛选条件拼出带 limit/offset 的查询', async () => {
  const { page } = await consolePage();
  const url = page.logsQuery({ keyId: 'k1', status: 'error', model: 'gpt', q: '你好' }, 50);
  assert.equal(url,
    '/api/admin/logs?limit=50&offset=50&keyId=k1&status=error&model=gpt&q=%E4%BD%A0%E5%A5%BD',
    '筛选条件与分页参数都要编码进查询串');
  assert.equal(page.logsQuery({}, 0), '/api/admin/logs?limit=50&offset=0', '无条件时只带分页');
});

test('控制台#11：进 #/logs 页会打真实接口，并把返回条目渲染进表格', async () => {
  const fetched = [];
  const { shim, page, listeners } = await consolePage(adminFetch({
    '/api/admin/logs?limit=50&offset=0': () => {
      fetched.push('/api/admin/logs?limit=50&offset=0');
      return json({ ok: true, enabled: true, hasMore: true, stats: { written: 9, dropped: 0, degraded: false },
        items: [{ t: new Date(2026, 5, 1, 12, 0, 0).getTime(), keyName: '真实客户端', accountName: '真实账号', model: 'claude-opus', status: 200, dur: 500, tokensIn: 7, tokensOut: 11, error: null }] });
    },
  }));

  // 切到日志页：hashchange → applyAdminHash → 切页回调触发首次取数（与真机一致）。
  shim.window.location.hash = '#/logs';
  for (const fn of listeners.hashchange ?? []) fn();
  await waitFor(() => shim.el('logs').innerHTML.includes('真实客户端'), 1000);

  assert.ok(fetched.length >= 1, '进日志页会拉 /api/admin/logs');
  assert.match(fetched[0], /^\/api\/admin\/logs\?limit=50&offset=0$/, '首屏 offset=0');

  const out = shim.el('logs').innerHTML;
  assert.ok(out.includes('真实客户端'), '真实条目已渲染');
  assert.ok(out.includes('真实账号'), '账号名已渲染');
  assert.ok(out.includes('2026-06-01 12:00:00'), '时间已格式化');
  assert.equal(shim.el('logs-count').textContent, '1 条', '条数来自真实响应');
});

// ── 6：自动刷新不新增第二个定时器 ────────────────────────────────────
test('控制台#12：运行日志与请求日志共用同一个 10s 定时器（不新增节奏）', () => {
  const src = fs.readFileSync(new URL('../panel/public/js/app-admin.js', import.meta.url), 'utf8');
  const timers = src.match(/setInterval\(/g) ?? [];
  assert.equal(timers.length, 1, `app-admin.js 只应有 1 个 setInterval（实得 ${timers.length}）`);
  assert.match(src, /adminPageVisible\('logs'\)/, '同一定时器里按当前页决定刷请求日志');
  assert.match(src, /adminPageVisible\('events'\)/, '同一定时器里按当前页决定刷运行日志');
});

// ── 7：用量统计页（§3 骨架，含懒加载 ECharts）────────────────────────
test('控制台#13：用量统计页懒加载 ECharts，画请求/token 两条线且 y 轴零基准', async () => {
  assert.match(ADMIN_HTML, /id="page-usage"/, '存在用量统计页容器');
  assert.match(ADMIN_HTML, /id="usage-chart"/, '存在图表容器');
  assert.match(ADMIN_HTML, /id="usage-kpis"/, '存在 KPI 区');
  for (const r of ['24h', '7d', '30d']) {
    assert.match(ADMIN_HTML, new RegExp('data-range="' + r + '"'), `缺少范围切换 ${r}`);
  }
  const { shim, page, listeners } = await consolePage(adminFetch({
    '/api/admin/usage?range=24h&bucket=1h': () => json({
      ok: true, totals: { requests: 3, errors: 1, tokensIn: 100, tokensOut: 200, durAvg: 5 },
      byKey: [{ keyId: 'k1', keyName: '客户端A', requests: 3, errors: 1, tokensIn: 100, tokensOut: 200 }],
      byModel: [{ model: 'claude', requests: 3, errors: 1, tokensIn: 100, tokensOut: 200 }],
      byAccount: [{ accountKeyId: 'a1', accountName: '主号', requests: 3, errors: 1 }],
      series: [{ t: new Date(2026, 0, 1, 0, 0, 0).getTime(), requests: 3, errors: 1, tokensIn: 100, tokensOut: 200 }],
    }),
  }));
  shim.window.location.hash = '#/usage';
  for (const fn of listeners.hashchange ?? []) fn();
  await waitFor(() => shim.el('usage-kpis').innerHTML.length > 0, 1000);

  assert.ok(shim.el('usage-kpis').innerHTML.includes('请求'), 'KPI 含请求');
  assert.ok(shim.el('usage-kpis').innerHTML.includes('token 入'), 'KPI 含 token 入');
  assert.ok(shim.el('usage-tables').innerHTML.includes('客户端A'), '按客户端表有真实数据');

  // y 轴零基准 + 请求 / token 两条线（在 ECharts 注入前先验配置，不依赖渲染库）。
  const opt = page.usageOption([{ t: 0, requests: 3, tokensIn: 100, tokensOut: 200 }]);
  assert.equal(opt.yAxis.min, 0, 'y 轴必须零基准');
  const names = opt.series.map((x) => x.name).join(',');
  assert.equal(names, '请求,token', '只画请求与 token 两条线');

  // 懒加载：只有真正进用量页/调用 ensureUsageECharts 才往 body 插 vendor/echarts.min.js。
  const injected = (host) => host.document.querySelectorAll('script')
    .some((x) => String(x.src).includes('vendor/echarts.min.js'));
  const fresh = await consolePage();
  assert.equal(injected(fresh.shim), false, '未进页面时不加载 ECharts');
  void fresh.page.ensureUsageECharts();
  const tag = fresh.shim.document.querySelectorAll('script')
    .find((x) => String(x.src).includes('vendor/echarts.min.js'));
  assert.ok(tag, '进页面后懒加载 ECharts（只在此刻插 <script>）');
  assert.match(String(tag.src), /^vendor\/echarts\.min\.js\?v=[\w.-]+$/, '指向 vendored 构建（带缓存版本号）');
});

// ── 8：登出必须清掉请求日志页里的业务数据 ────────────────────────────
test('控制台#14：clearSensitiveData 清空 #logs / #logs-count / 丢弃告警 / #side-who', async () => {
  const { shim, page } = await consolePage();
  vm.runInContext(`state.logs = [{ t: Date.now(), keyName: '千万别留', accountName: '账号', model: 'm', status: 200, dur: 1, tokensIn: 1, tokensOut: 1 }];
    state.logsStats = { written: 1, dropped: 2, degraded: true }; renderLogs();
    $('side-who').textContent = 'admin';`, page);
  assert.ok(shim.el('logs').innerHTML.includes('千万别留'), '前置：日志已渲染');
  assert.ok(!shim.el('logs-dropped').classList.contains('hidden'), '前置：丢弃告警已显示');

  page.clearSensitiveData();

  assert.equal(shim.el('logs').innerHTML, '', '登出后日志表体必须清空');
  assert.equal(shim.el('logs-count').textContent, '—', '登出后条数复位');
  assert.ok(shim.el('logs-dropped').classList.contains('hidden'), '登出后丢弃告警复位');
  assert.equal(shim.el('side-who').textContent, '', '登出后侧边栏管理员名必须清空');
  assert.equal(shim.document.querySelectorAll('#logs-key option').length, 1, '客户端下拉重建后只剩「全部客户端」占位');
});

// ── 9：客户端下拉来自 /api/admin/keys + 分页 / 筛选回第一页 ──────────
test('控制台#15：客户端下拉的选项来自 /api/admin/keys（keyId + 名称）', async () => {
  const { shim } = await consolePage(adminFetch({
    '/api/admin/keys': () => json({ keys: [
      { keyId: 'key-aaaa', keyPrefix: 'sk-cg-a', name: '前端组' },
      { keyId: 'key-bbbb', keyPrefix: 'sk-cg-b', name: '脚本' },
    ] }),
  }));
  await waitFor(() => shim.el('logs-key').querySelectorAll('option').length === 3, 1000);
  const opts = shim.el('logs-key').querySelectorAll('option');
  assert.equal(opts.length, 3, '「全部客户端」+ 2 个真实客户端');
  assert.equal(opts[0].getAttribute('value'), '', '首项是「全部客户端」占位');
  assert.equal(opts[1].getAttribute('value'), 'key-aaaa', '选项 value 是 keyId');
  assert.equal(opts[1].textContent, '前端组', '选项文本是名称');
  assert.equal(opts[2].getAttribute('value'), 'key-bbbb');
});

test('控制台#16：改客户端下拉 → 回到第一页（offset=0）并带上 keyId 筛选', async () => {
  const { shim, page } = await consolePage(adminFetch({
    '/api/admin/keys': () => json({ keys: [{ keyId: 'key-aaaa', keyPrefix: 'sk', name: '前端组' }] }),
  }));
  vm.runInContext("seen = []; apiJSON = async (url) => { seen.push(url); return { ok: true, enabled: true, hasMore: false, stats: { written: 0, dropped: 0, degraded: false }, items: [] }; };", page);

  shim.el('logs-key').value = 'key-aaaa';
  shim.document.dispatchEvent({ type: 'change', target: shim.el('logs-key') });
  await waitFor(() => vm.runInContext('seen.length', page) > 0, 500);

  assert.equal(vm.runInContext('seen[0]', page), '/api/admin/logs?limit=50&offset=0&keyId=key-aaaa',
    '第一次筛选从 offset=0 开始，并编码 keyId');
});

test('控制台#17：点「加载更多」用已加载条数作 offset 追加下一页', async () => {
  const { shim, page } = await consolePage();
  vm.runInContext(`state.logs = [{ t: 1 }]; state.logsHasMore = true; state.logsEnabled = true;
    state.logsStats = { written: 1, dropped: 0, degraded: false }; renderLogs();
    seen = []; apiJSON = async (url) => { seen.push(url);
      return { ok: true, enabled: true, hasMore: false, stats: { written: 0, dropped: 0, degraded: false }, items: [{ t: 2 }] }; };`, page);

  shim.document.dispatchEvent({ type: 'click', target: shim.el('logs-more') });
  await waitFor(() => vm.runInContext('seen.length', page) > 0, 500);

  assert.equal(vm.runInContext('seen[0]', page), '/api/admin/logs?limit=50&offset=1', '追加页按已加载条数取 offset');
  assert.equal(shim.el('logs-count').textContent, '2 条', '追加后条数为两页之和');
});

// ── 10：侧边栏底部「退出登录」真的登出（不只存在于 HTML）──────────────
test('控制台#18：点侧边栏退出项发起 POST /api/auth/logout 并回登录页', async () => {
  const calls = [];
  const { shim } = await consolePage(async (url, opts) => {
    calls.push({ url, method: (opts && opts.method) || 'GET' });
    if (url === '/api/auth/me') return json({ authenticated: true, user: { username: 'admin' } });
    if (url === '/api/auth/logout') return json({ ok: true });
    if (url === '/api/admin/session') return json({ users: [], dashboardPublic: false, writable: true });
    if (url === '/api/admin/keys') return json({ keys: [] });
    if (url.startsWith('/api/admin/events')) return json({ events: [] });
    return json({ accounts: [], tests: [], writable: true });
  });
  shim.document.dispatchEvent({ type: 'click', target: shim.el('side-logout') });
  await waitFor(() => shim.el('gate-main').style.display === '', 1000);

  assert.ok(calls.some((c) => c.url === '/api/auth/logout' && c.method === 'POST'), '退出必须打 POST /api/auth/logout');
  assert.equal(shim.el('admin-head').style.display, 'none', '退出后顶栏隐藏');
  assert.equal(shim.el('gate-main').style.display, '', '退出后回登录页');
});
