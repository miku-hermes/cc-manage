// 批次 4：前台视觉重做（mockup 现代卡片风）的回归测试。
// 全部走 renderCards/render 全链路 + 真实 /api/status 数据形状的 fixture，
// 零外部依赖、不联网。DOM 结构变更处的断言都对应新的等价行为。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createDomShim, runInlineScript } from './helpers.mjs';

const INDEX_HTML = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

function dom(html, fetchImpl) {
  return createDomShim({ html, fetchImpl: fetchImpl ?? (async () => ({ ok: true, status: 200, json: async () => ({}) })) });
}

function quota(overrides = {}) {
  return {
    ok: true, displayName: '显示名', plan: null, remaining: 9.9,
    credits: { monthlyCredits: 2, purchasedCredits: 1, freeCredits: 0.5 },
    fiveHour: { used: 0, cap: 3, percent: 0, resetAt: 0 },
    weekly: { used: 0, cap: 6, percent: 0, resetAt: 0 },
    monthly: { used: 0, cap: 10, percent: 0, resetAt: 0 },
    usage: { totalTokens: 12, totalCost: 1 }, fetchedAt: Date.now(),
    ...overrides,
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

async function boot() {
  const shim = dom(INDEX_HTML);
  const page = await runInlineScript(INDEX_HTML, shim);
  return { shim, page };
}

function status(accounts, extra = {}) {
  return {
    now: Date.now(), quotaPoll: {},
    summary: {
      accounts: accounts.length, enabled: accounts.length, available: accounts.length,
      unavailable: 0, paused: 0, concurrency: 0, ...(extra.summary || {}),
    },
    stats: { total: 0, errors: 0, clientErrors: 0, totalTokens: 0, ...(extra.stats || {}) },
    accounts, ...(extra.top || {}),
  };
}

// ── ① 构成明细聚合：两个账号的 credits 三项分别求和 ──────────────────
test('B4-1：Hero 构成明细对两账号的月度/购买/赠送分别求和（真实 credits）', async () => {
  const { shim, page } = await boot();
  const a = account({ keyId: 'aaaa1111', lastQuota: quota({ credits: { monthlyCredits: 2, purchasedCredits: 1, freeCredits: 0.5 } }) });
  const b = account({ keyId: 'bbbb2222', lastQuota: quota({ credits: { monthlyCredits: 3, purchasedCredits: 2, freeCredits: 1.5 } }) });
  page.render(status([a, b]));
  assert.equal(shim.el('bal-breakdown').textContent,
    '月度 $5.00 · 购买 $3.00 · 赠送 $2.00 · 本月已用 0.0%',
    '2+3 / 1+2 / 0.5+1.5 三项求和，金额带 $ 前缀');
});

// ── ② Y% 是 Σused/Σcap 的加权值，不是各账号百分比的简单平均 ──────────
test('B4-2：本月已用百分比按 Σused/Σcap 加权（只算 cap>0）', async () => {
  const { shim, page } = await boot();
  // 账号 A：1/2 = 50%；账号 B：1/8 = 12.5% → 加权 2/10 = 20.0%（简单平均会是 31.3%）
  const a = account({ keyId: 'aaaa1111', lastQuota: quota({ monthly: { used: 1, cap: 2, percent: 50, resetAt: 0 } }) });
  const b = account({ keyId: 'bbbb2222', lastQuota: quota({ monthly: { used: 1, cap: 8, percent: 12.5, resetAt: 0 } }) });
  page.render(status([a, b]));
  const text = shim.el('bal-breakdown').textContent;
  assert.match(text, /本月已用 20\.0%/);
  assert.doesNotMatch(text, /31\.3%/, '不得用简单平均');
  // cap 为 0 的账号不参与分母：加进来也不改变结果
  const c = account({ keyId: 'cccc3333', lastQuota: quota({ monthly: { used: 99, cap: 0, percent: 0, resetAt: 0 } }) });
  page.render(status([a, b, c]));
  assert.match(shim.el('bal-breakdown').textContent, /本月已用 20\.0%/);
});

// ── ③ 分段进度条三段宽度 = 各段金额 / 三段之和 ───────────────────────
test('B4-3：额度构成分段条三段宽度按金额占比（月度/购买/赠送）', async () => {
  const { shim, page } = await boot();
  const out = page.card(account({ lastQuota: quota({ credits: { monthlyCredits: 2, purchasedCredits: 1, freeCredits: 1 } }) }));
  assert.match(out, /class="credits-bar"/, '要有分段条容器');
  assert.match(out, /<i class="seg-month" style="width:50%"><\/i>/, '月度 2/4 = 50%');
  assert.match(out, /<i class="seg-buy" style="width:25%"><\/i>/, '购买 1/4 = 25%');
  assert.match(out, /<i class="seg-gift" style="width:25%"><\/i>/, '赠送 1/4 = 25%');
  // 三段全 0 → 空条（宽度都为 0，不画假比例）
  const empty = page.card(account({ lastQuota: quota({ credits: { monthlyCredits: 0, purchasedCredits: 0, freeCredits: 0 } }) }));
  assert.match(empty, /<i class="seg-month" style="width:0%"><\/i>/);
  assert.match(empty, /<i class="seg-buy" style="width:0%"><\/i>/);
  assert.match(empty, /<i class="seg-gift" style="width:0%"><\/i>/);
});

// ── ④ 无快照账号：构成区块显示「尚未获取额度快照」，不出分段条 ──────────
test('B4-4：无 lastQuota 快照的账号构成区块显示兜底文案，无假分段条', async () => {
  const { shim, page } = await boot();
  const out = page.card(account({ name: '无快照号', lastQuota: null }));
  assert.match(out, /class="card-credits aux-text">尚未获取额度快照</);
  assert.doesNotMatch(out, /class="credits-bar"/, '没有快照就不该画构成条');
  // Hero 明细：全部账号都无快照 → 整行兜底
  page.render(status([account({ keyId: 'aaaa1111', lastQuota: null })]));
  assert.equal(shim.el('bal-breakdown').textContent, '尚未获取额度快照');
});

// ── ⑤ 计划标签从 plan.planId 派生（走友好名，不暴露原始 id）───────────
test('B4-5：名称右侧计划标签渲染 plan.planId 派生的套餐名', async () => {
  const { shim, page } = await boot();
  const out = page.card(account({ lastQuota: quota({ plan: { planId: 'individual-go' } }) }));
  assert.match(out, /<span class="plan-pill mono">Go 个人版 · \$10\/月<\/span>/, '计划标签要渲染套餐名');
  assert.doesNotMatch(out, /individual-go/, '不暴露原始 planId（沿用既有隐私/可读性契约）');
  // 未知 planId 原样透出；没有 plan 就不渲染标签
  assert.match(page.card(account({ lastQuota: quota({ plan: { planId: 'individual-xyz' } }) })), /plan-pill mono">individual-xyz</);
  assert.doesNotMatch(page.card(account({ lastQuota: quota({ plan: null }) })), /plan-pill/);
});

// ── ⑥ 状态胶囊 tone 类名：ok/warn/bad ────────────────────────────────
test('B4-6：状态胶囊按 accountStatus.tone 输出 is-ok / is-warn / is-bad', async () => {
  const { shim, page } = await boot();
  const okOut = page.card(account({ available: true }));
  assert.match(okOut, /<span class="status is-ok"><span class="dot" aria-hidden="true"><\/span>可用<\/span>/);

  const pausedOut = page.card(account({ available: false, paused: true, pausedUntil: Date.now() + 3600e3 }));
  assert.match(pausedOut, /class="status is-warn"/, '冷却中 = 琥珀');

  const deadOut = page.card(account({ available: false, exhausted: { kind: 'monthly', label: '月额度已用完', resetAt: 0 } }));
  assert.match(deadOut, /class="status is-bad"/, '耗尽 = 红');
  assert.match(deadOut, /<span class="status is-bad">[\s\S]*月额度已用完<\/span>/, '胶囊里是 accountStatus 的 t');
});

// ── ⑦ 筛选条计数 + 点击「耗尽」后只剩耗尽账号（document 委托）────────
test('B4-7：筛选条计数真实，点击「耗尽」走 document 委托只留耗尽账号', async () => {
  const { shim, page } = await boot();
  const live = account({ keyId: 'aaaa1111', name: '可用号' });
  const dead = account({ keyId: 'bbbb2222', name: '耗尽号', available: false, exhausted: { kind: 'monthly', label: '月额度已用完', resetAt: 0 } });
  const cool = account({ keyId: 'cccc3333', name: '冷却号', available: false, paused: true, pausedUntil: Date.now() + 3600e3 });
  page.render(status([live, dead, cool]));

  const btnOf = (key) => shim.el('filters').querySelectorAll('button').find((b) => b.getAttribute('data-filter') === key);
  assert.deepEqual(shim.el('filters').querySelectorAll('button').map((b) => b.textContent),
    ['全部 3', '可用 1', '冷却 1', '耗尽 1'], '计数来自真实账号');
  assert.equal(btnOf('all').getAttribute('aria-pressed'), 'true', '默认全部 active');

  shim.document.dispatchEvent({ type: 'click', target: btnOf('exhausted') });   // 真实委托路径

  // 渲染会重建按钮节点，重新查询后再断言 active 态
  assert.equal(btnOf('exhausted').getAttribute('aria-pressed'), 'true', '点击后该按钮 aria-pressed=true');
  assert.equal(btnOf('all').getAttribute('aria-pressed'), 'false', '旧的「全部」撤销 active');
  const cards = shim.el('cards').innerHTML;
  assert.match(cards, /耗尽号/);
  assert.doesNotMatch(cards, /可用号|冷却号/, '非耗尽账号被筛掉');
});

// ── ⑧ 状态筛选与搜索叠加生效 ────────────────────────────────────────
test('B4-8：状态筛选与搜索叠加，先筛状态再筛关键词', async () => {
  const { shim, page } = await boot();
  const d1 = account({ keyId: 'aaaa1111', name: '耗尽甲', available: false, exhausted: { kind: 'monthly', label: '月额度已用完', resetAt: 0 } });
  const d2 = account({ keyId: 'bbbb2222', name: '耗尽乙', available: false, creditsExhausted: true, exhausted: null });
  const live = account({ keyId: 'cccc3333', name: '可用甲' });
  page.render(status([d1, d2, live]));

  shim.el('search').value = '甲';
  shim.document.dispatchEvent({ type: 'input', target: shim.el('search') });
  assert.match(shim.el('cards').innerHTML, /耗尽甲/);
  assert.match(shim.el('cards').innerHTML, /可用甲/, '还没点筛选时搜索同时命中两个「甲」');

  const btnOf = (key) => shim.el('filters').querySelectorAll('button').find((b) => b.getAttribute('data-filter') === key);
  shim.document.dispatchEvent({ type: 'click', target: btnOf('exhausted') });

  let cards = shim.el('cards').innerHTML;
  assert.match(cards, /耗尽甲/, '筛选+搜索交集命中耗尽甲');
  assert.doesNotMatch(cards, /可用甲/, '可用甲被状态筛掉');
  assert.doesNotMatch(cards, /耗尽乙/, '耗尽乙不匹配关键词');

  // 换个关键词：仍是「耗尽」筛选下，只剩耗尽乙
  shim.el('search').value = '乙';
  shim.document.dispatchEvent({ type: 'input', target: shim.el('search') });
  cards = shim.el('cards').innerHTML;
  assert.match(cards, /耗尽乙/);
  assert.doesNotMatch(cards, /耗尽甲/);

  // 叠加后无匹配 → 走现有 empty 卡逻辑，不白屏
  shim.el('search').value = '不存在';
  shim.document.dispatchEvent({ type: 'input', target: shim.el('search') });
  assert.match(shim.el('cards').innerHTML, /card empty/);
});

// ── ⑨ 全部账号都没有 cap → 明细行兜底文案（不显示 NaN/0%）────────────
test('B4-9：所有账号都没有 cap 时明细行给兜底文案，不出现 NaN', async () => {
  const { shim, page } = await boot();
  const a = account({ keyId: 'aaaa1111', lastQuota: quota({ credits: { monthlyCredits: 1, purchasedCredits: 0, freeCredits: 0 }, monthly: { used: 5, cap: 0, percent: 0, resetAt: 0 } }) });
  page.render(status([a]));
  const text = shim.el('bal-breakdown').textContent;
  assert.match(text, /月度 \$1\.00 · 购买 \$0\.00 · 赠送 \$0\.00/);
  assert.match(text, /本月用量待同步/, '无 cap 时给兜底文案');
  assert.doesNotMatch(text, /NaN|undefined|%/, '不得出现 NaN / 伪百分比');
});

// ── 附加：KPI sub 小字全部来自真实数据 ──────────────────────────────
test('B4-10：KPI 卡 sub 小字填充真实 summary/stats 字段', async () => {
  const { shim, page } = await boot();
  page.render(status([account()], {
    summary: { accounts: 5, enabled: 4, available: 3, unavailable: 2, paused: 1, concurrency: 0 },
    stats: { total: 20, errors: 1, clientErrors: 7, totalTokens: 1234 },
  }));
  assert.equal(shim.el('kpi-sub-accounts').textContent, '启用 4');
  assert.equal(shim.el('kpi-sub-available').textContent, '不可用 2');
  assert.equal(shim.el('kpi-sub-paused').textContent, '含冷却');
  assert.equal(shim.el('kpi-sub-unavailable').textContent, '暂停+耗尽');
  assert.equal(shim.el('kpi-sub-total').textContent, 'token 1,234');
  assert.equal(shim.el('kpi-sub-errors').textContent, '客户端错误 7');
});

// ── 附加：隐私红线 —— 卡片不渲染 keyId / keyPrefix，keyId 只在 data-key-id ──
test('B4-11：前台卡片不渲染 keyId/keyPrefix 文本（keyId 仅存于 data-key-id 属性）', async () => {
  const { shim, page } = await boot();
  const out = page.card(account({ keyId: 'secret-key-id-abcdef', keyPrefix: 'user_2XyP' }));
  const withoutAttr = out.replace(/data-key-id="[^"]*"/g, '');
  assert.doesNotMatch(withoutAttr, /secret-key-id-abcdef/, 'keyId 不得以其它形式出现在卡片里');
  assert.doesNotMatch(out, /user_2XyP/, 'keyPrefix 一律不渲染');
  assert.match(out, /data-key-id="secret-key-id-abcdef"/, 'data-key-id 钩子保留（滚动回填依赖）');
  assert.ok(shim.el('filters'), '#filters 容器存在于 HTML');
});
