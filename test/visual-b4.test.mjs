// 批次 4：前台视觉重做（mockup 现代卡片风）的回归测试。
// 全部走 renderCards/render 全链路 + 真实 /api/status 数据形状的 fixture，
// 零外部依赖、不联网。DOM 结构变更处的断言都对应新的等价行为。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createDomShim, runInlineScript, styleText } from './helpers.mjs';

const INDEX_HTML = fs.readFileSync(new URL('../panel/dist/index.html', import.meta.url), 'utf8');

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
    '本月已用 0.0% · 月度 $5.00 · 购买 $3.00 · 赠送 $2.00',
    '已用率在前（口径写清），2+3 / 1+2 / 0.5+1.5 三项求和');
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
  // B24：分段条挂 daisyUI/Tailwind 类，段仍按金额占比；选择器放宽为前缀，比例数值不变。
  const out = page.card(account({ lastQuota: quota({ credits: { monthlyCredits: 2, purchasedCredits: 1, freeCredits: 1 } }) }));
  assert.match(out, /class="credits-bar[^"]*"/, '要有分段条容器');
  assert.match(out, /<i class="seg-month[^"]*" style="width:50%"><\/i>/, '月度 2/4 = 50%');
  assert.match(out, /<i class="seg-buy[^"]*" style="width:25%"><\/i>/, '购买 1/4 = 25%');
  assert.match(out, /<i class="seg-gift[^"]*" style="width:25%"><\/i>/, '赠送 1/4 = 25%');
  // B24 设计约束 4：三段全 0 → 不画假比例，空条整个移除，只留一句真话。
  const empty = page.card(account({ lastQuota: quota({ credits: { monthlyCredits: 0, purchasedCredits: 0, freeCredits: 0 } }) }));
  assert.doesNotMatch(empty, /credits-bar/, '三段全 0 不再画空条（恒为 0 不占位）');
  assert.match(empty, /额度构成待同步/, '空态给真话，不撒谎');
});

// ── ④ 无快照账号：构成区块显示「尚未获取额度快照」，不出分段条 ──────────
test('B4-4：无 lastQuota 快照的账号构成区块显示兜底文案，无假分段条', async () => {
  const { shim, page } = await boot();
  const out = page.card(account({ name: '无快照号', lastQuota: null }));
  assert.match(out, /class="card-credits aux-text[^"]*">尚未获取额度快照</);
  assert.doesNotMatch(out, /credits-bar/, '没有快照就不该画构成条');
  // Hero 明细：全部账号都无快照 → 整行兜底
  page.render(status([account({ keyId: 'aaaa1111', lastQuota: null })]));
  assert.equal(shim.el('bal-breakdown').textContent, '尚未获取额度快照');
});

// ── ⑤ 计划标签从 plan.planId 派生（走友好名，不暴露原始 id）───────────
test('B4-5：名称右侧计划标签渲染 plan.planId 派生的套餐名', async () => {
  const { shim, page } = await boot();
  const out = page.card(account({ lastQuota: quota({ plan: { planId: 'individual-go' } }) }));
  assert.match(out, /<span class="plan-pill[^"]*">Go 个人版 · \$10\/月<\/span>/, '计划标签要渲染套餐名');
  assert.doesNotMatch(out, /individual-go/, '不暴露原始 planId（沿用既有隐私/可读性契约）');
  // 未知 planId 原样透出；没有 plan 就不渲染标签
  assert.match(page.card(account({ lastQuota: quota({ plan: { planId: 'individual-xyz' } }) })), /plan-pill[^"]*">individual-xyz</);
  assert.doesNotMatch(page.card(account({ lastQuota: quota({ plan: null }) })), /plan-pill/);
});

// ── ⑥ 状态胶囊 tone 类名：ok/warn/bad ────────────────────────────────
test('B4-6：状态胶囊按 accountStatus.tone 输出 is-ok / is-warn / is-bad', async () => {
  const { shim, page } = await boot();
  // B24：胶囊 = daisyUI badge + 语义色 + 原 tone 钩子（status badge badge-success is-ok …），
  // 选择器放宽为「class 里含 is-*」；文案与 tone 分类断言不变。
  const okOut = page.card(account({ available: true }));
  assert.match(okOut, /<span class="status badge[^"]*is-ok"><span class="dot" aria-hidden="true"><\/span>可用<\/span>/);

  const pausedOut = page.card(account({ available: false, paused: true, pausedUntil: Date.now() + 3600e3 }));
  assert.match(pausedOut, /class="status badge[^"]*is-warn"/, '冷却中 = 琥珀');

  const deadOut = page.card(account({ available: false, exhausted: { kind: 'monthly', label: '月额度已用完', resetAt: 0 } }));
  assert.match(deadOut, /class="status badge[^"]*is-bad"/, '耗尽 = 红');
  assert.match(deadOut, /<span class="status badge[^"]*is-bad">[\s\S]*月额度已用完<\/span>/, '胶囊里是 accountStatus 的 t');
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
  // B24 设计约束 4：购买/赠送恒为 0 → 不占位；非 0 的月度仍是真实值。
  assert.match(text, /月度 \$1\.00/);
  assert.doesNotMatch(text, /购买 \$0\.00|赠送 \$0\.00/, '恒为 0 的构成段不出现');
  assert.match(text, /本月用量待同步/, '无 cap 时给兜底文案');
  assert.doesNotMatch(text, /NaN|undefined|%/, '不得出现 NaN / 伪百分比');
});

// ── 附加：KPI 卡由模板克隆，零值卡不出现（B23 减法）──────────────────
test('B4-10：KPI 卡按模板渲染；账号口径只在 Hero；零值卡不占槽位', async () => {
  const { shim, page } = await boot();
  page.render(status([account()], {
    summary: { accounts: 5, enabled: 4, available: 3, unavailable: 2, paused: 1, concurrency: 0 },
    stats: { total: 20, errors: 1, clientErrors: 7, totalTokens: 1234 },
  }));
  // 账号口径（账号数 / 可用 / 不可用）统一在 Hero 的「网关状态 可用 3 / 5」
  assert.equal(shim.el('health').textContent, '可用 3 / 5');
  assert.ok(!shim.el('kpi-accounts') && !shim.el('kpi-available') && !shim.el('kpi-unavailable'),
    'KPI 侧不再重复列账号口径的四张卡');
  assert.equal(shim.el('kpi-total').textContent, '20');
  assert.equal(shim.el('kpi-sub-errors').textContent, '客户端错误 7');
  assert.equal(shim.el('kpi-sub-paused').textContent, '含冷却');
  assert.ok(!shim.el('kpi-sub-total'), '总请求卡不再有 token 副文案（与 Hero 累计 token 重复）');
  assert.equal(shim.el('tokens').textContent, '1,234');

  page.render(status([account()], {
    summary: { accounts: 5, enabled: 4, available: 3, unavailable: 2, paused: 0, concurrency: 0 },
    stats: { total: 5, errors: 0, clientErrors: 0, totalTokens: 10 },
  }));
  assert.equal(shim.el('kpi-paused'), null, '暂停中 0 → 该卡不出现（而不是显示 0）');
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

// ── 批次 5（B23/B24 改写）：KPI 卡结构唯一化 + 语义图标 ──────────────
// B24：手写 dashboard.css 已删除；KPI 卡改由 daisyUI stat + Tailwind 工具类承载。
const KPI_COMPONENT = fs.readFileSync(new URL('../panel/src/components/KpiCard.astro', import.meta.url), 'utf8');

/** 取模板里 KpiCard 的 HTML 块（结构唯一来源）。 */
function kpiTemplateHtml() {
  const m = /<template id="tpl-kpi">([\s\S]*?)<\/template>/.exec(INDEX_HTML);
  assert.ok(m, 'index 里必须有 <template id="tpl-kpi">');
  return m[1];
}

// B24 改写：图标改由 @lucide/astro 组件渲染，路径数据不再写在源码里（也不可能手写）。
// 原来查：KpiCard.astro 里的内联 <path d="…">；现在查：源码 import 的 Lucide 组件名 + 构建产物里
// 对应图标 svg 的 lucide-* 类名（证明真的用对了图标，比字符串匹配更贴最终 DOM）。
test('B5-1：KPI 结构只存在一处：kpi-head(图标+标签) → 大数字 → sub，且无 kpi-body', () => {
  const html = kpiTemplateHtml();
  assert.doesNotMatch(html, /kpi-body/, '旧 .kpi-body 包裹层必须删除');
  const order = [...html.matchAll(/kpi-head|<b[^>]*data-f="kpi-value"|class="kpi-sub[^"]*"/g)].map((m) => m[0]);
  assert.equal(order.length, 3, 'head / 大数字 / sub 各出现一次');
  assert.match(order[0], /kpi-head/);
  assert.match(order[1], /data-f="kpi-value"/);
  assert.match(order[2], /kpi-sub/);
  assert.match(KPI_COMPONENT, /class="kpi-head[^"]*"/);
  assert.equal((KPI_COMPONENT.match(/\bkpi-head\b/g) || []).length, 1, 'KpiCard.astro 里 kpi-head 只出现一次');
});

test('B5-2：总请求卡用 Lucide activity 脉搏线图标', () => {
  assert.match(KPI_COMPONENT, /import\s*\{[^}]*\bActivity\b[^}]*\}\s*from\s*'@lucide\/astro'/, 'activity 来自 Lucide');
  assert.match(KPI_COMPONENT, /<Activity\s+data-f="kpi-icon-total"/, '总请求 = activity');
  assert.match(kpiTemplateHtml(), /class="lucide lucide-activity"[^>]*data-f="kpi-icon-total"/, '渲染出 activity 图标');
  assert.doesNotMatch(KPI_COMPONENT, /<svg/, '不再手写 <svg>');
});

test('B5-3：上游错误卡用 Lucide triangle-alert 三角感叹图标', () => {
  assert.match(KPI_COMPONENT, /import\s*\{[^}]*\bTriangleAlert\b[^}]*\}\s*from\s*'@lucide\/astro'/, 'triangle-alert 来自 Lucide');
  assert.match(KPI_COMPONENT, /<TriangleAlert\s+data-f="kpi-icon-errors"/, '上游错误 = 三角感叹');
  assert.match(kpiTemplateHtml(), /class="lucide lucide-triangle-alert\b[^"]*"[^>]*data-f="kpi-icon-errors"/, '渲染出 triangle-alert');
});

test('B5-4：暂停中卡用 Lucide pause 双竖条图标', () => {
  assert.match(KPI_COMPONENT, /import\s*\{[^}]*\bPause\b[^}]*\}\s*from\s*'@lucide\/astro'/, 'pause 来自 Lucide');
  assert.match(KPI_COMPONENT, /<Pause\s+data-f="kpi-icon-paused"/, '暂停中 = 双竖条');
  assert.match(kpiTemplateHtml(), /class="lucide lucide-pause"[^>]*data-f="kpi-icon-paused"/, '渲染出 pause');
  assert.doesNotMatch(KPI_COMPONENT, /<svg/, '不再手写 <svg>');
});

// B24 改写：原来查 dashboard.css 的 `.kpi{flex-direction:column}` 与 `.kpi-head{display:flex;align-items:center}`。
// 现在查：KPI 卡走 daisyUI stat（单列 inline-grid → 竖排），kpi-head 自带 flex items-center 工具类，
// 且构建 CSS 里确实产出这两条声明。等价性：仍是「卡片竖排 + 标题行横向居中并排」。
test('B5-5：KPI 竖排（daisyUI stat），kpi-head 横向并排（flex items-center）', () => {
  assert.match(KPI_COMPONENT, /class="kpi-head stat-title flex items-center/, 'kpi-head 横向并排');
  assert.match(KPI_COMPONENT, /class="kpi stat bg-base-100"/, 'KPI 卡走 daisyUI stat');
  const css = styleText(INDEX_HTML);
  assert.match(css, /\.stat\{[^}]*grid-template-columns:repeat\(1,\s*1fr\)/, 'stat 单列（竖排）');
  assert.match(css, /\.flex\{display:flex\}/, 'flex 工具类存在');
  assert.match(css, /\.items-center\{align-items:center\}/, 'items-center 工具类存在');
});
