// 第三轮审计遗留批次 B2：前端 8 条（B2-1 … B2-8）的回归测试。
// 只读 public/index.html / public/admin.html，零外部依赖，用既有 DOM 垫片跑内联脚本。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createDomShim, runInlineScript, styleText } from './helpers.mjs';

const INDEX_HTML = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const ADMIN_HTML = fs.readFileSync(new URL('../public/admin.html', import.meta.url), 'utf8');
const delay = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

function dom(html, fetchImpl) {
  return createDomShim({ html, fetchImpl: fetchImpl ?? (async () => ({ ok: true, status: 200, json: async () => ({}) })) });
}

function quota(remaining = 9.9, overrides = {}) {
  return {
    ok: true, displayName: '显示名', plan: null, remaining,
    credits: { monthlyCredits: 2, purchasedCredits: 1, freeCredits: 0.5 },
    fiveHour: { used: 0, cap: 3, percent: 0, usedRatio: 0, resetAt: 0 },
    weekly: { used: 0, cap: 6, percent: 0, usedRatio: 0, resetAt: 0 },
    monthly: { used: 0, cap: 10, percent: 0, usedRatio: 0, resetAt: 0 },
    usage: { totalTokens: 12, totalCost: 1 }, percent: {}, fetchedAt: Date.now(),
    ...overrides,
  };
}

function account(overrides = {}) {
  return {
    keyId: '12345678', keyPrefix: 'user_2XyP', name: '测试号', enabled: true, available: true,
    creditsExhausted: false, exhausted: null, concurrency: 0, paused: false, pausedUntil: null,
    rateLimited: false, authInvalid: false, lastError: null, lastQuota: quota(),
    ...overrides,
  };
}

function adminAccounts(page, accounts) {
  vm.runInContext(`state.accounts = ${JSON.stringify(accounts)}; renderAccounts();`, page);
}

function readState(page, expr) {
  return JSON.parse(JSON.stringify(vm.runInContext(expr, page)));
}

// 预填「共享终端下不该残留」的敏感数据并渲染
function seedSensitive(page) {
  vm.runInContext(`state.auth = { user: { username: 'admin' } };
    state.accounts = [${JSON.stringify(account())}];
    state.keys = [{ keyId: 'abcdef12', keyPrefix: 'sk-cg-2XyP', name: '客户端' }];
    state.users = [{ username: 'admin', createdAt: 1 }];
    state.events = [{ level: 'error', at: 1, message: '敏感运行日志' }];
    renderAccounts(); renderKeys(); renderUsers(); renderEvents();`, page);
}

function assertCleared(shim, page) {
  for (const id of ['accounts', 'keys', 'users', 'events']) {
    assert.equal(shim.el(id).innerHTML, '', `#${id} 必须被清空`);
  }
  assert.deepEqual(readState(page, 'state.accounts'), []);
  assert.deepEqual(readState(page, 'state.keys'), []);
  assert.deepEqual(readState(page, 'state.users'), []);
  assert.deepEqual(readState(page, 'state.events'), []);
}

// ── B2-1：会话失效 / 登出必须清数据，不能只切显示 ────────────────────
test('B2-1：退出登录清空敏感 state 与四个容器（keyPrefix 不再留在 DOM）', async () => {
  const shim = dom(ADMIN_HTML, async (url) => {
    if (url === '/api/auth/me') return { ok: true, status: 200, json: async () => ({ authenticated: false }) };
    if (url === '/api/auth/logout') return { ok: true, status: 200, json: async () => ({ ok: true }) };
    return { ok: true, status: 200, json: async () => ({}) };
  });
  const page = await runInlineScript(ADMIN_HTML, shim);
  seedSensitive(page);
  assert.match(shim.el('accounts').innerHTML, /user_2XyP/, '登出前 keyPrefix 确实在 DOM 里');
  assert.match(shim.el('events').innerHTML, /敏感运行日志/);

  // 批次 3 后 #logout 走 document 级事件委托。
  shim.document.dispatchEvent({ type: 'click', target: shim.el('logout') });
  await new Promise((r) => setTimeout(r, 0));

  assertCleared(shim, page);
  assert.equal(shim.document.body.className, 'gate', '登出后回到登录界面');
});

test('B2-1：后端返回 401（会话失效）同样清空敏感 state 与容器', async () => {
  const shim = dom(ADMIN_HTML, async (url) => {
    if (url === '/api/auth/me') return { ok: true, status: 200, json: async () => ({ authenticated: false }) };
    if (url.startsWith('/api/admin/')) {
      return { ok: false, status: 401, json: async () => ({ error: { message: 'unauthorized' } }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  });
  const page = await runInlineScript(ADMIN_HTML, shim);
  seedSensitive(page);
  assert.match(shim.el('accounts').innerHTML, /user_2XyP/);

  await assert.rejects(() => page.loadAccounts(), /unauthorized/);

  assertCleared(shim, page);
  assert.equal(shim.document.body.className, 'gate', '401 后回到登录界面');
});

// ── B2-2：后台额度条「已用完 → 100%」覆盖 ───────────────────────────
test('B2-2：后台额度条对已用完的窗口画满 100%，未耗尽仍显示真实百分比', async () => {
  const shim = dom(ADMIN_HTML);
  const page = await runInlineScript(ADMIN_HTML, shim);
  const spentAcct = account({
    available: false, exhausted: { kind: 'monthly', label: '月额度已用完', resetAt: 0 },
    lastQuota: quota(0.098, { monthly: { used: 9.936, cap: 10, percent: 99.36, usedRatio: 0.9936, resetAt: 0 } }),
  });
  const healthy = account({
    lastQuota: quota(9.9, { monthly: { used: 4, cap: 10, percent: 40, usedRatio: 0.4, resetAt: 0 } }),
  });
  adminAccounts(page, [spentAcct, healthy]);
  const out = shim.el('accounts').innerHTML;

  assert.match(out, /月额度已用完 · 不可用/, '状态标签仍说已用完');
  assert.match(out, /class="qbar-pct">100\.0%<\/span>/, '已用完的月额度条必须画满 100%');
  assert.doesNotMatch(out, /99\.4%/, '不得再出现与状态标签自相矛盾的 99.4%');
  assert.match(out, /class="qbar-pct">40\.0%<\/span>/, '未耗尽的账号仍显示真实百分比（不回归）');

  assert.match(page.quotaBar('月', { percent: 99.36 }, { spent: true }), /100\.0%/, 'spent 覆盖直接生效');
  assert.match(page.quotaBar('月', { percent: 99.36 }), /99\.4%/, '没有 spent 时保持真实值');
});

// ── B2-3：额度构成明细各显真实值，不被 usableRemaining 门控 ─────────
test('B2-3：额度构成明细各显真实值，不被 usableRemaining 门控成 0.00', async () => {
  const shim = dom(INDEX_HTML);
  const page = await runInlineScript(INDEX_HTML, shim);
  const dead = account({
    available: false, exhausted: { kind: 'monthly', label: '月额度已用完', resetAt: 0 },
    lastQuota: quota(0, { credits: { monthlyCredits: 0.098, purchasedCredits: 1.5, freeCredits: 0 } }),
  });
  const out = page.card(dead);
  assert.match(out, /月度 0\.10 · 购买 1\.50 · 赠送 0\.00/, '构成明细必须是真实数值');
  assert.doesNotMatch(out, /月度 0\.00/, '独立构成字段不得被门控成 0');
  assert.match(out, /<b>0\.00<\/b><small>剩余额度<\/small>/, '剩余额度结论仍按「用不了算 0」');

  const ok = page.card(account({ lastQuota: quota(9.9, { credits: { monthlyCredits: 2, purchasedCredits: 1, freeCredits: 0.5 } }) }));
  assert.match(ok, /月度 2\.00 · 购买 1\.00 · 赠送 0\.50/, '正常账号构成不回归');
});

// ── B2-4：状态文案 st.t 必须转义 ────────────────────────────────────
test('B2-4：状态文案 st.t 走 esc()，label 里的 HTML 不落进 innerHTML', async () => {
  const shim = dom(INDEX_HTML);
  const page = await runInlineScript(INDEX_HTML, shim);
  const evil = account({
    available: false,
    exhausted: { kind: 'monthly', label: '<img src=x onerror=alert(1)>', resetAt: 0 },
  });
  const out = page.card(evil);
  assert.doesNotMatch(out, /<img/, '不得出现裸 <img 标签');
  assert.match(out, /&lt;img src=x onerror=alert\(1\)&gt;/, '必须转义成 HTML 实体');

  const ok = page.card(account({ available: false, exhausted: { kind: 'monthly', label: '月额度已用完', resetAt: 0 } }));
  // 批次 4 把 .status 改成带 tone 类的状态胶囊（class="status is-bad"），选择器放宽为前缀匹配；
  // 语义不变：状态文案仍转义后落在 .status 里、仍带 aria-hidden 的 dot。
  assert.match(ok, /<span class="status[^"]*"><span class="dot" aria-hidden="true"><\/span>月额度已用完<\/span>/,
    '正常 label 渲染结果不变（不回归）');
});

// ── B2-5：快照过旧提示按实际阈值动态生成 ────────────────────────────
test('B2-5：快照过旧提示按实际阈值算出分钟数，不再写死 10 分钟', async () => {
  const shim = dom(INDEX_HTML);
  const page = await runInlineScript(INDEX_HTML, shim);
  const stale = Date.now() - 30 * 60 * 1000;

  page.setStaleFrom({ quotaPoll: { idleIntervalMs: 600000 } });   // → 20 分钟
  const a20 = page.freshHTML(stale);
  assert.match(a20, /title="额度快照已超过 20 分钟未更新"/, '阈值 20 分钟 → 文案 20 分钟');
  assert.doesNotMatch(a20, /10 分钟/, '不得再出现写死的 10 分钟');

  page.setStaleFrom({ quotaPoll: { idleIntervalMs: 300000 } });   // → 10 分钟
  const a10 = page.freshHTML(stale);
  assert.match(a10, /title="额度快照已超过 10 分钟未更新"/, '改配置后文案随之为 10 分钟，证明是算出来的');

  assert.doesNotMatch(INDEX_HTML, /已超过 10 分钟未更新/, '静态源码里不得再有写死的 10 分钟文案');
});

// ── B2-6：窄屏标签条的可滑动提示（纯 CSS 静态断言）──────────────────
// styleText：内联 <style> + 外链 css 合并（见 helpers.mjs）
function braceBlock(css, start) {
  const open = css.indexOf('{', start);
  assert.ok(open >= 0, '找到 {');
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  throw new Error('花括号不配平');
}
function mediaBlocks(css, query) {
  const blocks = [];
  const re = /@media[^{]*\{/g;
  let m;
  while ((m = re.exec(css))) {
    const header = m[0].slice(0, -1).replace(/\s+/g, ' ').trim();
    if (header.includes(query)) blocks.push(braceBlock(css, m.index));
  }
  return blocks;
}

test('B2-6：≤640px 标签条有可滑动提示（渐隐遮罩 + 极窄滚动条）', () => {
  const css = styleText(INDEX_HTML).replace(/\/\*[\s\S]*?\*\//g, '');
  const mobile = mediaBlocks(css, 'max-width: 640px').join('\n');
  assert.ok(mobile, '存在 @media (max-width: 640px) 块');
  assert.match(mobile, /mask-image:\s*linear-gradient/, '窄屏标签条要有右侧渐隐遮罩');
  assert.match(mobile, /-webkit-mask-image:\s*linear-gradient/, '同时给 webkit 前缀（Safari）');
  assert.match(mobile, /\.tags::-webkit-scrollbar\s*\{[^}]*height:\s*4px/, '还要有极窄滚动条样式');
  assert.match(mobile, /\.tags\s*\{[^}]*flex-wrap:\s*nowrap/, '窄屏仍是单行横向滚动（既有契约不回归）');
});

// ── B2-7：日志轮询 / 手动筛选的 generation 竞态守卫 ─────────────────
test('B2-7：慢的旧日志响应不得覆盖新的筛选结果（generation 守卫）', async () => {
  const pending = [];
  const shim = dom(ADMIN_HTML, (url) => {
    if (url === '/api/auth/me') return Promise.resolve({ ok: true, status: 200, json: async () => ({ authenticated: false }) });
    return new Promise((resolve) => pending.push({ url, resolve }));
  });
  const page = await runInlineScript(ADMIN_HTML, shim);
  await delay(0);

  vm.runInContext("state.level = '';", page);
  const first = page.loadEvents();
  vm.runInContext("state.level = 'error';", page);
  const second = page.loadEvents();
  await delay(0);
  assert.equal(pending.length, 2, '两个请求都在途');
  assert.equal(pending[0].url, '/api/admin/events');
  assert.equal(pending[1].url, '/api/admin/events?level=error');

  // 后发起的 error 请求先返回
  pending[1].resolve({ ok: true, status: 200, json: async () => ({ events: [{ level: 'error', at: 1, message: '新筛选结果' }] }) });
  await second;
  assert.equal(shim.el('event-count').textContent, '1 条');
  assert.match(shim.el('events').innerHTML, /新筛选结果/);

  // 先前发起的全量慢请求后返回 → 必须被丢弃
  pending[0].resolve({ ok: true, status: 200, json: async () => ({ events: [
    { level: 'info', at: 2, message: '旧全量结果A' },
    { level: 'info', at: 3, message: '旧全量结果B' },
  ] }) });
  await first;
  await delay(0);

  assert.equal(shim.el('event-count').textContent, '1 条', '旧响应不得改写条数');
  assert.match(shim.el('events').innerHTML, /新筛选结果/);
  assert.doesNotMatch(shim.el('events').innerHTML, /旧全量结果/);
  assert.deepEqual(readState(page, 'state.events'), [{ level: 'error', at: 1, message: '新筛选结果' }]);
});

// ── B2-8：公开前台不再渲染内网上游地址 ──────────────────────────────
test('B2-8：公开前台 Hero 区不再渲染内网上游 host/port', async () => {
  const shim = dom(INDEX_HTML);
  const page = await runInlineScript(INDEX_HTML, shim);
  const d = {
    now: Date.now(), allowPassthrough: false, upstreamProxyUrl: 'http://core:3050',
    summary: { accounts: 2, available: 2, paused: 0, concurrency: 0 },
    stats: { total: 0, errors: 0, totalTokens: 0 }, quotaPoll: {}, accounts: [],
  };
  page.render(d);

  const up = shim.el('upstream').textContent;
  assert.doesNotMatch(up, /core|3050|https?:\/\//i, '匿名访客看不到内网 host/port');
  assert.doesNotMatch(INDEX_HTML, /d\.upstreamProxyUrl/, '源码不再把该字段插进 DOM');

  // 对照：其余 hero 区信息不回归
  assert.equal(shim.el('health').textContent, '可用 2 / 2');
  assert.match(shim.el('updated').textContent, /^更新于 /);
  assert.equal(shim.el('tokens').textContent, '0');
});
