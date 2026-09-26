// 批次 19：前端（可访问性 + 真 bug + 确证死代码清理）的回归测试。
// 只读 panel/** 源码 + 复用既有 DOM 垫片跑页面脚本（零依赖、无浏览器）。
// 垫片里 getBoundingClientRect 恒为 0，因此断言只用「DOM 结构与事件」，不依赖布局尺寸。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createDomShim, runInlineScript, sleep, startTestGateway, request } from './helpers.mjs';

const INDEX_HTML = fs.readFileSync(new URL('../panel/dist/index.html', import.meta.url), 'utf8');
const TREND_HTML = fs.readFileSync(new URL('../panel/dist/trend.html', import.meta.url), 'utf8');
const ADMIN_HTML = fs.readFileSync(new URL('../panel/dist/admin.html', import.meta.url), 'utf8');
const APP_JS = fs.readFileSync(new URL('../panel/public/js/app.js', import.meta.url), 'utf8');
const APP_ADMIN_JS = fs.readFileSync(new URL('../panel/public/js/app-admin.js', import.meta.url), 'utf8');
const MODAL_JS = fs.readFileSync(new URL('../panel/public/js/modal.js', import.meta.url), 'utf8');
const RENDER_GATE_JS = fs.readFileSync(new URL('../panel/public/js/render-gate.js', import.meta.url), 'utf8');
const ADMIN_STATE_JS = fs.readFileSync(new URL('../panel/public/js/admin-state.js', import.meta.url), 'utf8');
// B24：手写 CSS 已删除，样式源码只剩 panel/src/styles/panel.css。
const PANEL_CSS = fs.readFileSync(new URL('../panel/src/styles/panel.css', import.meta.url), 'utf8');

const delay = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(fn, ms = 1000) {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (fn()) return true;
    await sleep(5);
  }
  return fn();
}
const json = (v, status = 200) => ({ ok: status < 400, status, json: async () => v });
function dom(html, fetchImpl, localStorageData) {
  return createDomShim({
    html,
    fetchImpl: fetchImpl ?? (async () => json({})),
    localStorageData: localStorageData ?? {},
  });
}

// ── 数据 fixture（与 /api/status、/api/admin/accounts 的真实形状一致）──
function quota(overrides = {}) {
  return {
    ok: true, displayName: '显示名', plan: null, remaining: 9.9,
    credits: { monthlyCredits: 2, purchasedCredits: 1, freeCredits: 0.5 },
    fiveHour: { used: 0, cap: 3, percent: 0, resetAt: 0 },
    weekly: { used: 0, cap: 6, percent: 0, resetAt: 0 },
    monthly: { used: 0, cap: 10, percent: 0, resetAt: 0 },
    usage: { totalTokens: 12, totalCost: 1 }, fetchedAt: Date.now(), ...overrides,
  };
}
function account(overrides = {}) {
  return {
    keyId: '12345678', name: '测试号', enabled: true, available: true,
    creditsExhausted: false, exhausted: null, paused: false, pausedUntil: null,
    rateLimited: false, rateLimitedUntil: null, authInvalid: false, lastError: null,
    lastQuota: quota(), ...overrides,
  };
}
function statusData(accounts) {
  return {
    now: Date.now(), quotaPoll: {},
    summary: { accounts: accounts.length, enabled: accounts.length, available: accounts.length, unavailable: 0, paused: 0 },
    stats: { total: 0, errors: 0, clientErrors: 0, totalTokens: 0 },
    accounts,
  };
}
function indexFetch(extra = {}) {
  return async (url, opts) => {
    if (extra[url]) return extra[url](opts);
    if (url === '/api/status') return json(statusData([]));
    if (url === '/api/history') return json({ bucketMs: 5 * 60 * 1000, samples: [] });
    return json({});
  };
}
function adminFetch(extra = {}) {
  return async (url, opts) => {
    if (extra[url]) return extra[url](opts);
    if (url === '/api/auth/me') return json({ authenticated: true, user: { username: 'admin' } });
    if (url === '/api/admin/session') return json({ users: [], dashboardPublic: false, writable: true });
    if (url === '/api/admin/keys') return json({ keys: [] });
    if (url === '/api/admin/events') return json({ events: [] });
    if (url.startsWith('/api/admin/accounts')) return json({ accounts: [], tests: [], writable: true });
    return json({});
  };
}
async function adminPage(fetchImpl) {
  const shim = dom(ADMIN_HTML, fetchImpl ?? adminFetch());
  const page = await runInlineScript(ADMIN_HTML, shim);
  return { shim, page };
}

// ── 1：弹窗焦点陷阱 + 背景 inert ─────────────────────────────────────
test('B19-1①：打开弹窗后 #admin-head / #admin-main 带 inert（aria-modal 不再是声明）', async () => {
  const { shim, page } = await adminPage();
  vm.runInContext("openModal('m-account');", page);
  assert.equal(shim.el('admin-head').hasAttribute('inert'), true, '后台头部必须 inert');
  assert.equal(shim.el('admin-main').hasAttribute('inert'), true, '后台主区必须 inert');
});

test('B19-1②：关闭弹窗后 inert 移除且原值还原', async () => {
  const { shim, page } = await adminPage();
  shim.el('admin-main').setAttribute('inert', '');        // 原本已有 inert → 关闭时必须保留
  vm.runInContext("openModal('m-account');", page);
  shim.document.dispatchEvent({ type: 'keydown', key: 'Escape' });
  assert.equal(shim.el('admin-head').hasAttribute('inert'), false, '原值 false → 还原为无 inert');
  assert.equal(shim.el('admin-main').hasAttribute('inert'), true, '原值 true → 关闭后保留 inert');
});

test('B19-1③：dialog 内最后一个可聚焦元素 Tab → 焦点回到第一个（循环）', async () => {
  const { shim, page } = await adminPage();
  vm.runInContext("openModal('m-account');", page);
  const focusables = page.focusableIn(shim.el('m-account').querySelector('.dialog'));
  assert.ok(focusables.length >= 2, '弹窗内至少两个可聚焦元素');
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  last.focus();
  shim.document.dispatchEvent({ type: 'keydown', key: 'Tab', shiftKey: false, preventDefault() {} });
  assert.equal(shim.document.activeElement, first, '从末尾 Tab 必须回绕到首个');
});

test('B19-1④：从第一个可聚焦元素 Shift+Tab → 焦点到最后一个', async () => {
  const { shim, page } = await adminPage();
  vm.runInContext("openModal('m-account');", page);
  const focusables = page.focusableIn(shim.el('m-account').querySelector('.dialog'));
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  first.focus();
  shim.document.dispatchEvent({ type: 'keydown', key: 'Tab', shiftKey: true, preventDefault() {} });
  assert.equal(shim.document.activeElement, last, '从首个 Shift+Tab 必须回绕到末尾');
});

test('B19-1⑤：焦点在弹窗外时 Tab 也拉回弹窗内（不外泄到背景）', async () => {
  const { shim, page } = await adminPage();
  vm.runInContext("openModal('m-account');", page);
  shim.el('admin-head').focus();                          // 模拟焦点跑到背景
  shim.document.dispatchEvent({ type: 'keydown', key: 'Tab', shiftKey: false, preventDefault() {} });
  assert.ok(shim.el('m-account').contains(shim.document.activeElement), '焦点必须落回弹窗内');
});

// ── 2：弹窗 <form> / submit 提交 ─────────────────────────────────────
test('B19-2①：5 个弹窗各有 form，且 form 内包含对应提交按钮；登录门密码字段也在 form 内', () => {
  const shim = dom(ADMIN_HTML);
  const pairs = [
    ['m-account', 'a-submit'], ['m-rename', 'r-submit'], ['m-user', 'u-submit'],
    ['m-pass', 'p-submit'], ['m-newkey', 'k-submit'],
  ];
  for (const [modalId, submitId] of pairs) {
    const form = shim.el(modalId).querySelector('form');
    assert.ok(form, `#${modalId} 内必须有 <form>`);
    assert.ok(form.querySelector('#' + submitId), `#${submitId} 必须在 #${modalId} 的 form 内`);
  }
  for (const id of ['gate-user', 'gate-pass', 'gate-pass2']) {
    assert.ok(shim.el(id).closest('form'), `登录门 #${id} 必须在 <form> 内（密码管理器 / Chrome 不再告警）`);
  }
});

test('B19-2②：派发 submit 事件 → 原有提交逻辑被触发（真的发出 POST 请求）', async () => {
  const calls = [];
  const { shim, page } = await adminPage(async (url, opts) => {
    calls.push({ url, opts });
    if (url === '/api/auth/me') return json({ authenticated: true, user: { username: 'admin' } });
    if (url === '/api/admin/session') return json({ users: [], dashboardPublic: false, writable: true });
    if (url === '/api/admin/keys') return json({ keys: [] });
    if (url === '/api/admin/events') return json({ events: [] });
    if (url === '/api/admin/accounts' && (!opts || opts.method !== 'POST')) return json({ accounts: [], tests: [], writable: true });
    if (url === '/api/admin/accounts' && opts && opts.method === 'POST') return json({ ok: true });
    return json({});
  });
  vm.runInContext("openModal('m-account'); $('a-name').value='新号'; $('a-key').value='user_x';", page);
  const form = shim.el('m-account').querySelector('form');
  form.dispatchEvent({ type: 'submit', preventDefault() {} });
  await waitFor(() => calls.some((c) => c.url === '/api/admin/accounts' && c.opts && c.opts.method === 'POST'));
  assert.ok(calls.some((c) => c.url === '/api/admin/accounts' && c.opts && c.opts.method === 'POST'), 'submit 必须发起 POST /api/admin/accounts');
  await waitFor(() => !shim.el('m-account').classList.contains('open'));
  assert.equal(shim.el('m-account').classList.contains('open'), false, '提交成功后关闭弹窗');
});

test('B19-2③：登录门 Enter 行为不回归（keydown Enter → 发起登录）', async () => {
  let login = 0;
  const shim = dom(ADMIN_HTML, async (url) => {
    if (url === '/api/auth/me') return json({ authenticated: false, setupRequired: false });
    if (url === '/api/auth/login') { login += 1; return json({ ok: true }); }
    return json({});
  });
  const page = await runInlineScript(ADMIN_HTML, shim);
  await delay(10);
  vm.runInContext("$('gate-user').value='admin'; $('gate-pass').value='pw123456';", page);
  shim.el('gate-pass').dispatchEvent({ type: 'keydown', key: 'Enter' });
  await waitFor(() => login > 0);
  assert.equal(login, 1, '登录门 Enter 必须触发一次登录请求');
});

// ── 3：公开面板搜索控件在无障碍树里只出现一次 ────────────────────────
test('B19-3①：.search-box 不再是 role=button / 不再有 tabindex；#search 仍是可聚焦 input', async () => {
  const shim = dom(INDEX_HTML, indexFetch());
  await runInlineScript(INDEX_HTML, shim);
  const box = shim.el('search').parent;
  assert.equal(box.getAttribute('role'), null, '.search-box 不得再有 role="button"');
  assert.equal(box.getAttribute('tabindex'), null, '.search-box 不得再有 tabindex');
  assert.equal(shim.el('search').tagName, 'input', '#search 仍是 input');
  shim.el('search').focus();
  assert.equal(shim.document.activeElement, shim.el('search'), '#search 可聚焦');
});

test('B19-3②：搜索输入仍触发过滤（行为不回归）', async () => {
  const shim = dom(INDEX_HTML, indexFetch());
  const page = await runInlineScript(INDEX_HTML, shim);
  page.render(statusData([account({ keyId: '甲' , name: '账号甲' }), account({ keyId: '乙', name: '账号乙' })]));
  assert.ok(shim.el('cards').innerHTML.includes('账号甲'), '初始渲染两张卡');
  shim.el('search').value = '甲';
  shim.document.dispatchEvent({ type: 'input', target: shim.el('search') });
  assert.ok(shim.el('cards').innerHTML.includes('账号甲'), '命中项保留');
  assert.ok(!shim.el('cards').innerHTML.includes('账号乙'), '未命中项被过滤');
});

// ── 4：登出敏感残留清理 ──────────────────────────────────────────────
test('B19-4①：写满 #r-sub / #p-sub / #a-name → clearSensitiveData 后全部为空', async () => {
  const { shim, page } = await adminPage();
  vm.runInContext("$('r-sub').textContent='账号「甲」（keyId aaaa1111）'; $('p-sub').textContent='为管理员「admin」设置新密码'; $('a-name').value='测试';", page);
  page.clearSensitiveData();
  assert.equal(shim.el('r-sub').textContent, '', '#r-sub 备注名 + keyId 必须清空');
  assert.equal(shim.el('p-sub').textContent, '', '#p-sub 管理员名必须清空');
  assert.equal(shim.el('a-name').value, '', '#a-name 输入必须复位');
});

test('B19-4②：守护 —— app-admin/modal 里 textContent/value 的赋值目标都在清理清单内', () => {
  const extractIds = (src, name) => {
    const m = new RegExp('const ' + name + ' = \\[([\\s\\S]*?)\\];').exec(src);
    assert.ok(m, `render-gate.js 必须有 ${name}`);
    return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  };
  const covered = new Set([
    ...extractIds(RENDER_GATE_JS, 'SENSITIVE_VALUE_IDS'),
    ...extractIds(RENDER_GATE_JS, 'SENSITIVE_TEXT_IDS'),
  ]);
  const src = APP_ADMIN_JS + '\n' + MODAL_JS;
  const targets = new Set();
  const re = /\$\('([^']+)'\)\s*\.(?:textContent|value)\s*=/g;
  let m;
  while ((m = re.exec(src))) targets.add(m[1]);
  assert.ok(targets.size > 0, '应扫描到赋值目标');
  for (const id of targets) {
    assert.ok(covered.has(id), `$${id} 会被写入，必须加入 clearSensitiveData 清理清单`);
  }
});

// ── 5：公开面板 aria-live ────────────────────────────────────────────
test('B19-5①：首页存在 live 区域（#health role=status aria-live=polite）', async () => {
  assert.match(INDEX_HTML, /id="health"[^>]*aria-live="polite"/, '静态 HTML 里就有 live 区域');
  const shim = dom(INDEX_HTML, indexFetch());
  await runInlineScript(INDEX_HTML, shim);
  assert.ok(shim.document.querySelectorAll('[aria-live]').length >= 1, '运行时存在 [aria-live]');
});

test('B19-5②：加载失败改用 role=alert', async () => {
  const shim = dom(INDEX_HTML, async () => { throw new Error('boom'); });
  await runInlineScript(INDEX_HTML, shim);
  await waitFor(() => shim.el('health').getAttribute('role') === 'alert');
  assert.equal(shim.el('health').getAttribute('role'), 'alert', '失败态必须是 role=alert');
  assert.match(shim.el('health').textContent, /加载失败/, '失败文案仍写入 #health');
});

test('B19-5③：轮询值不变时不重复写 live 区域', async () => {
  const shim = dom(INDEX_HTML, indexFetch());
  const page = await runInlineScript(INDEX_HTML, shim);
  const data = statusData([account()]);
  page.render(data);
  const health = shim.el('health');
  let writes = 0;
  let val = health.textContent;
  Object.defineProperty(health, 'textContent', {
    configurable: true,
    get: () => val,
    set: (v) => { writes += 1; val = String(v); },
  });
  page.render(data);                                  // 同一份数据：文案没变
  assert.equal(writes, 0, '文案不变时不得重写 live 区域（否则 5s 轮询刷爆读屏）');
});

// ── 6：刷新额度按钮 ─────────────────────────────────────────────────
test('B19-6①：点击「刷新额度」→ 发出 POST /api/accounts/refresh', async () => {
  const shim = dom(INDEX_HTML, indexFetch({
    '/api/accounts/refresh': () => json({ ...statusData([account()]), throttled: false }),
  }));
  await runInlineScript(INDEX_HTML, shim);
  assert.ok(shim.el('refresh-quota'), 'hero 区必须有刷新额度按钮');
  shim.document.dispatchEvent({ type: 'click', target: shim.el('refresh-quota') });
  await waitFor(() => shim.calls.some((c) => c.url === '/api/accounts/refresh'));
  assert.ok(
    shim.calls.some((c) => c.url === '/api/accounts/refresh' && c.opts && c.opts.method === 'POST'),
    '必须是 POST /api/accounts/refresh',
  );
});

test('B19-6②：throttled:true 的响应 → 提示「刚刷新过，请稍候」', async () => {
  const shim = dom(INDEX_HTML, indexFetch({
    '/api/accounts/refresh': () => json({ ...statusData([]), throttled: true }),
  }));
  await runInlineScript(INDEX_HTML, shim);
  shim.document.dispatchEvent({ type: 'click', target: shim.el('refresh-quota') });
  await waitFor(() => /刚刷新过/.test(shim.el('keyhint').textContent));
  assert.match(shim.el('keyhint').textContent, /刚刷新过，请稍候/, 'throttled 必须给出提示');
});

test('B19-6③：请求进行中按钮禁用（防连点）', async () => {
  let resolveRefresh = null;
  const shim = dom(INDEX_HTML, async (url) => {
    if (url === '/api/status') return json(statusData([]));
    if (url === '/api/history') return json({ samples: [] });
    if (url === '/api/accounts/refresh') {
      return new Promise((res) => { resolveRefresh = () => res(json({ ...statusData([]), throttled: false })); });
    }
    return json({});
  });
  await runInlineScript(INDEX_HTML, shim);
  shim.document.dispatchEvent({ type: 'click', target: shim.el('refresh-quota') });
  assert.equal(shim.el('refresh-quota').disabled, true, '请求进行中必须禁用');
  resolveRefresh();
  await waitFor(() => shim.el('refresh-quota').disabled === false);
  assert.equal(shim.el('refresh-quota').disabled, false, '请求结束后恢复可用');
});

// ── 7：缺 name 的账号标题兜底 ────────────────────────────────────────
test('B19-7：缺 name 的账号标题非空且可识别（前台卡片 + 后台表格）', async () => {
  const shim = dom(INDEX_HTML, indexFetch());
  const page = await runInlineScript(INDEX_HTML, shim);
  page.render(statusData([account({ keyId: 'dddd1234eeee', name: undefined, lastQuota: null })]));
  // B24：卡片标题是 <h2 class="card-head …">（带类名/属性），选择器放宽为 <h2[^>]*>；行为断言不变。
  const h2 = /<h2[^>]*>([^<]*)<\/h2>/.exec(shim.el('cards').innerHTML);
  assert.ok(h2 && h2[1].trim(), '卡片标题不得为空');
  assert.match(h2[1], /dddd1234/, '缺 name 时用 keyId 前 8 位识别');

  const admin = await adminPage(async (url) => {
    if (url === '/api/auth/me') return json({ authenticated: true, user: { username: 'admin' } });
    if (url === '/api/admin/session') return json({ users: [], dashboardPublic: false, writable: true });
    if (url === '/api/admin/keys') return json({ keys: [] });
    if (url === '/api/admin/events') return json({ events: [] });
    if (url.startsWith('/api/admin/accounts')) return json({ accounts: [account({ keyId: 'dddd1234eeee', name: undefined, lastQuota: null })], tests: [], writable: true });
    return json({});
  });
  await waitFor(() => admin.shim.el('accounts').innerHTML.includes('dddd1234'));
  // B24：备注名单元格 class 里同时有 Tailwind 工具类（cell-name font-medium），选择器放宽。
  const row = /<div class="cell-name[^"]*">([^<]*)<\/div>/.exec(admin.shim.el('accounts').innerHTML);
  assert.ok(row && row[1].trim(), '后台表格备注名列不得为空');
  assert.match(row[1], /dddd1234/);
});

// ── 8：整数指标动画中间帧不得出现小数 ────────────────────────────────
test('B19-8：数字滚动中间帧不含小数点；终值格式不变', async () => {
  const shim = dom(INDEX_HTML, indexFetch());
  const page = await runInlineScript(INDEX_HTML, shim);
  shim.document.visibilityState = 'visible';                 // 让 canAnimate() 为真
  const frames = [];
  page.requestAnimationFrame = (fn) => { frames.push(fn); return frames.length; };
  page.cancelAnimationFrame = () => {};
  page.performance = { now: () => 0 };
  const el = shim.document.createElement('b');
  page.setNumber(el, 0, 981, page.num, 1000);
  assert.ok(frames.length >= 1, 'rAF 路径应排队一帧');
  frames.shift()(250);                                       // 25% 进度 → 中间值带小数
  assert.ok(!el.textContent.includes('.'), `中间帧不得含小数点：${el.textContent}`);
  assert.equal(page.num(981.482), '981', 'num() 必须整数格式化');

  shim.document.visibilityState = 'hidden';                  // 关掉动画：同步写终值
  page.setNumber(el, 0, 4, page.money, 700);
  assert.equal(el.textContent, '4.00', 'money 终值仍是两位小数（格式不变）');
});

// ── 9：确证死代码守护（类名 / 令牌不再出现在 panel/）────────────────
test('B19-9：删掉的类名 / 令牌不再出现在 CSS 与 HTML/JS 里', () => {
  // B22：两页 HTML 的源码在 panel/src/pages（.astro），其余资源在 panel/public。
  const files = [
    '../panel/src/pages/index.astro', '../panel/src/pages/admin.astro',
    '../panel/src/styles/panel.css',
    'js/utils.js', 'js/anim.js', 'js/api.js', 'js/state.js', 'js/theme.js', 'js/render-hero.js',
    'js/render-cards.js', 'js/render-trend.js', 'js/app.js', 'js/admin-utils.js', 'js/admin-api.js',
    'js/admin-state.js', 'js/login-gate.js', 'js/render-gate.js', 'js/render-users.js',
    'js/render-accounts-table.js', 'js/render-keys-table.js', 'js/logs.js', 'js/modal.js', 'js/app-admin.js',
  ];
  const all = files.map((f) => fs.readFileSync(new URL(
    f.startsWith('../') ? f : '../panel/public/' + f, import.meta.url), 'utf8')).join('\n');
  // B24 说明：'skeleton' 从死代码清单移除 —— 它不再是旧实现残留，而是 daisyUI 的加载占位组件
  // （admin 的 #boot-loading 用了 skeleton）。旧实现残留类名其余各项仍在清单里。
  for (const needle of ['skeleton-shimmer', 'card-display', 'test-note.pending', 'lv-info', '--shadow-soft', '--shadow-lift']) {
    assert.ok(!all.includes(needle), `确证死代码不得再出现：${needle}`);
  }
  assert.ok(!/^\.btn\s*\{/m.test(PANEL_CSS), 'panel.css 不再自己定义 .btn（交给 daisyUI）');
  assert.ok(!/\.btn:disabled/.test(PANEL_CSS), 'panel.css 不再覆盖 .btn:disabled');
  assert.ok(!/\bvw\b/.test(APP_JS), 'app.js 不再声明未使用的局部变量 vw');
  assert.ok(!/tests:\s*\[\]/.test(ADMIN_STATE_JS), 'admin-state.js 不再有 state.tests');
});

// ── 10：其余小项 ────────────────────────────────────────────────────
// 原来查：tokens.css 里 --scrim 浅 rgba(23,35,59,.38) / 深 rgba(0,0,0,.55)，components.css 的 .modal 用 var(--scrim)。
// 现在查：panel.css 里同一对 --scrim 值，且 daisyUI modal 的 .modal-backdrop 用 var(--scrim)。
//         等价性：遮罩仍是「浅色黑色遮罩 / 深色更黑」两套值，仍由同一令牌驱动。
test('B19-10a：--scrim 令牌（浅/深）与 .modal-backdrop 使用 var(--scrim)', () => {
  assert.match(PANEL_CSS, /--scrim:\s*rgba\(0,\s*0,\s*0,\s*\.4\)/, '浅色 scrim');
  assert.match(PANEL_CSS, /:root\[data-theme="dark"\][\s\S]*--scrim:\s*rgba\(0,\s*0,\s*0,\s*\.6\)/, '暗色 scrim');
  assert.match(PANEL_CSS, /\.modal-backdrop\s*\{[^}]*background:\s*var\(--scrim\)/, '.modal-backdrop 用 --scrim');
});

test('B19-10b：无手动选择时跟随系统主题变化（matchMedia change）', async () => {
  let listener = null;
  let systemDark = false;
  const shim = dom(INDEX_HTML, indexFetch());
  shim.window.matchMedia = (q) => ({
    matches: q.includes('prefers-color-scheme: dark') ? systemDark : false,
    addEventListener: (type, fn) => { if (type === 'change') listener = fn; },
    addListener: (fn) => { listener = fn; },
  });
  const page = await runInlineScript(INDEX_HTML, shim);
  assert.equal(typeof listener, 'function', '必须监听系统主题变化');
  systemDark = true;
  listener();
  assert.equal(shim.document.documentElement.getAttribute('data-theme'), 'dark', '系统切暗色 → 同步 data-theme');

  page.setTheme('light');                                   // 手动选择后系统变化不再改写
  listener();
  assert.equal(shim.document.documentElement.getAttribute('data-theme'), 'light', '手动选择优先于系统');
});

test('B19-10c：balanceTitle 整体转义（title 属性不泄漏原始引号）', async () => {
  const { shim } = await adminPage(async (url) => {
    if (url === '/api/auth/me') return json({ authenticated: true, user: { username: 'admin' } });
    if (url === '/api/admin/session') return json({ users: [], dashboardPublic: false, writable: true });
    if (url === '/api/admin/keys') return json({ keys: [] });
    if (url === '/api/admin/events') return json({ events: [] });
    if (url.startsWith('/api/admin/accounts')) {
      return json({
        accounts: [account({ keyId: 'kkkk9999', name: '坏', lastQuota: { remaining: 0 }, exhausted: { kind: 'balance', label: '坏" onmouseover="x' } })],
        tests: [], writable: true,
      });
    }
    return json({});
  });
  await waitFor(() => shim.el('accounts').innerHTML.includes('usable-balance'));
  const html = shim.el('accounts').innerHTML;
  const m = /<span class="usable-balance[^"]*" title="([^"]*)"/.exec(html);
  assert.ok(m, '存在 usable-balance 的 title');
  assert.ok(!html.includes('onmouseover="x"'), '原始引号不得拼进属性（未转义）');
  assert.match(m[1], /&quot;/, '引号必须被转义为 &quot;');
});

test('B19-10d：两页有内联 SVG favicon 与 meta description；/favicon.ico 不再 404', async (t) => {
  for (const [name, html] of [['index', INDEX_HTML], ['admin', ADMIN_HTML]]) {
    assert.match(html, /<link rel="icon" href="data:image\/svg\+xml,/, `${name} 必须内联 favicon`);
    assert.match(html, /<meta name="description" content="[^"]+">/, `${name} 必须有 description`);
  }
  const ctx = await startTestGateway();
  t.after(() => ctx.close());
  const r = await request(`${ctx.baseUrl}/favicon.ico`);
  assert.notEqual(r.status, 404, '/favicon.ico 不得再 404');
});

test('B19-10e：趋势标题阈值用 bucketMs 推出的 capacity（12 个样本不再撤「数据收集中」）', async () => {
  // B23：趋势图移到 /trend；用趋势页产物验证（主面板不再加载 render-trend.js）。
  const shim = dom(TREND_HTML, indexFetch());
  const page = await runInlineScript(TREND_HTML, shim);
  const samples = (n) => Array.from({ length: n }, (_, i) => ({ r: i, e: 0, m: 1 }));
  page.renderTrend({ bucketMs: 5 * 60 * 1000, samples: samples(12) });   // capacity = 288
  assert.match(shim.el('trend').innerHTML, /近 24 小时趋势（数据收集中）/, '只攒到 12 个样本（约 1 小时）仍要说明收集中');
  page.renderTrend({ bucketMs: 5 * 60 * 1000, samples: samples(288) });
  assert.ok(!shim.el('trend').innerHTML.includes('数据收集中'), '攒满 24 小时窗口才撤掉「收集中」');
});

// ── 11：dashboardPublic 用起来 + 端点调用面守护 ───────────────────────
test('B19-11①：后台据 dashboardPublic 提示「公开面板对外可见」', async () => {
  const { shim } = await adminPage(adminFetch({
    '/api/admin/session': () => json({ users: [], dashboardPublic: true, writable: true }),
  }));
  await waitFor(() => /公开面板对外可见/.test(shim.el('public-note').textContent));
  assert.match(shim.el('public-note').className, /\bwarn\b/, '用 warn 横幅提示');
  assert.match(shim.el('public-note').textContent, /PUBLIC_DASHBOARD=0/, '给出关闭方法');

  const hidden = await adminPage(adminFetch({
    '/api/admin/session': () => json({ users: [], dashboardPublic: false, writable: true }),
  }));
  await waitFor(() => hidden.shim.el('public-note').className.includes('hidden'));
  assert.match(hidden.shim.el('public-note').className, /\bhidden\b/, '隐私模式隐藏提示');
});

test('B19-11②：前端不再调用 GET /api/accounts 与 GET /api/admin/users（源码守护）', () => {
  const src = [
    APP_JS, APP_ADMIN_JS, MODAL_JS, RENDER_GATE_JS, ADMIN_STATE_JS,
    fs.readFileSync(new URL('../panel/public/js/utils.js', import.meta.url), 'utf8'),
    fs.readFileSync(new URL('../panel/public/js/api.js', import.meta.url), 'utf8'),
    fs.readFileSync(new URL('../panel/public/js/render-hero.js', import.meta.url), 'utf8'),
    fs.readFileSync(new URL('../panel/public/js/render-cards.js', import.meta.url), 'utf8'),
    fs.readFileSync(new URL('../panel/public/js/render-trend.js', import.meta.url), 'utf8'),
    fs.readFileSync(new URL('../panel/public/js/logs.js', import.meta.url), 'utf8'),
  ].join('\n');
  assert.ok(!/['"]\/api\/accounts['"]/.test(src), '不得直接调用 GET /api/accounts（只用 /api/accounts/refresh）');
  assert.ok(/\/api\/accounts\/refresh/.test(src), '刷新额度必须走 /api/accounts/refresh');
  assert.ok(!/apiJSON\('\/api\/admin\/users'\)/.test(src), '不得裸调 GET /api/admin/users');
});
