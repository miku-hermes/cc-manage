/* 账号卡片渲染（B23：结构只在 AccountCard.astro 模板里存在一次）。
   本文件不再手拼卡片的 HTML 字符串：克隆 <template id="tpl-account">，
   用 [data-f] 钩子 + textContent / createTextNode 填值（用户数据永不进 innerHTML），
   最后用 node.outerHTML 序列化回 #cards（保持既有 DOM 结果与既有断言）。
   进度条金额进 title / aria-label（触屏 / 键盘可达，role=group 才让 aria-label 生效）。 */

/** 一个状态对象：与后台同源口径（可用/冷却/耗尽/鉴权失效）。 */
function accountStatus(a) {
  if (a.authInvalid) return { t: '鉴权失效', tone: 'bad', dot: 'invalid', schedulable: false };
  if (!a.enabled) return { t: '已停用', tone: 'warn', dot: 'paused', schedulable: false };
  // 耗尽优先于「冷却中」：否则「周额度用完 + 冷却」会出现头部黄点 + 底部红标的同卡两色矛盾。
  if (a.exhausted && a.exhausted.label) return { t: a.exhausted.label, tone: 'bad', dot: 'invalid', schedulable: false };
  if (a.creditsExhausted) return { t: '余额不足', tone: 'bad', dot: 'invalid', schedulable: false };
  if (a.paused || a.rateLimited) return { t: '冷却中', tone: 'warn', dot: 'paused', schedulable: false };
  if (!a.available) return { t: '不可调度', tone: 'bad', dot: 'invalid', schedulable: false };
  return { t: '可用', tone: 'ok', dot: '', schedulable: true };
}
function statusText(a) { return accountStatus(a); }

/** 「耗尽」统一口径（筛选计数与 accountStatus 同源，不另立标准）。 */
function isExhaustedAccount(a) {
  return !!(a && (a.exhausted || a.creditsExhausted || a.authInvalid));
}

/** 状态筛选：与搜索叠加生效；'all' 不筛。 */
function inViewFilter(a) {
  switch (state.viewFilter) {
    case 'available': return accountStatus(a).schedulable;
    case 'cooldown': return !!(a.paused || a.rateLimited) && !isExhaustedAccount(a);
    case 'exhausted': return isExhaustedAccount(a);
    default: return true;
  }
}

/* 能用多少钱：额度已经用尽的账号（kind = monthly / balance）一律算 0；window 只是排队。
   q == null（没有快照）返回 null：既不能在卡片上显示成 0.00，也不能在 hero 合计里当 0 累加。 */
function usableRemaining(a) {
  const q = a && a.lastQuota;
  if (!q || !Number.isFinite(q.remaining)) return null;
  const k = a.exhausted && a.exhausted.kind;
  if (k === 'monthly' || k === 'balance') return 0;
  return q.remaining;
}

/* ── 模板克隆工具（无任何 HTML 字符串拼接）──────────────────────────── */
function clearChildren(el) { while (el && el.firstChild) el.removeChild(el.firstChild); }

/** 克隆一个 <template> 的首个元素子节点；模板缺失返回 null（防御性）。 */
function cloneTemplate(id) {
  const tpl = $(id);
  if (!tpl || !tpl.content || !tpl.content.firstElementChild) return null;
  return tpl.content.firstElementChild.cloneNode(true);
}
function field(root, name) { return root.querySelector('[data-f="' + name + '"]'); }
function fillText(root, name, text) {
  const el = field(root, name);
  if (el) el.textContent = text;
  return el;
}
function dropField(root, name) {
  const el = field(root, name);
  if (el) el.remove();
}

/** 额度构成：分段条宽度 / 数值明细都由真实 credits 算出。 */
function fillCredits(root, q) {
  const c = q && q.credits ? q.credits : null;
  if (!c) {
    // 无快照：保留「尚未获取额度快照」这句真话，但不画假分段条（去掉 credits-bar）。
    const bar = field(root, 'credits-bar');
    if (bar) bar.remove();
    fillText(root, 'credits-legend', '尚未获取额度快照');
    return;
  }
  const m = Number(c.monthlyCredits) || 0;
  const p = Number(c.purchasedCredits) || 0;
  const f = Number(c.freeCredits) || 0;
  const total = m + p + f;
  const w = (v) => (total > 0 ? +(v / total * 100).toFixed(4) : 0);
  const bar = field(root, 'credits-bar');
  if (bar) {
    const label = '额度构成：月度 ' + money(c.monthlyCredits) + ' · 购买 ' + money(c.purchasedCredits)
      + ' · 赠送 ' + money(c.freeCredits);
    bar.setAttribute('aria-label', label);
    bar.setAttribute('title', label);
    const seg = (name, v) => { const el = field(bar, name); if (el) el.style.width = w(v) + '%'; };
    seg('seg-month', m);
    seg('seg-buy', p);
    seg('seg-gift', f);
  }
  fillText(root, 'credits-legend', '月度 ' + money(c.monthlyCredits) + ' · 购买 ' + money(c.purchasedCredits)
    + ' · 赠送 ' + money(c.freeCredits));
}

/** 单条额度窗口进度条：百分比进正文，金额进 title / aria-label。 */
function fillBar(root, key, label, w, opts) {
  const group = field(root, 'bar-' + key);
  if (!group) return;
  const has = w && typeof w === 'object';
  const spent = !!opts && opts.spent === true;
  const pct = spent ? 100 : (has && typeof w.percent === 'number' ? w.percent : null);
  const amounts = has && typeof w.used === 'number' && typeof w.cap === 'number'
    ? money(w.used) + ' / ' + money(w.cap) : null;
  const reset = has ? resetText(w, { zeroMeansIdle: label.indexOf('5 小时') === 0 }) : '';
  const empty = pct === null || pct <= 0;
  const amountText = amounts ? label + '：已用 ' + amounts : '';
  group.className = 'bar-group';
  group.setAttribute('role', 'group');   // aria-label 必须挂在有 role 的元素上才进无障碍树
  if (amountText) {
    group.setAttribute('title', amountText);
    group.setAttribute('aria-label', amountText);
  }
  fillText(group, 'bar-' + key + '-pct', pctText(pct));
  const track = field(group, 'bar-' + key + '-track');
  if (track) {
    track.className = 'bar ' + cls(pct) + (empty ? ' is-empty' : '');
    const fill = field(track, 'bar-' + key + '-fill');
    if (fill) fill.style.width = (pct === null ? 0 : Math.max(0, Math.min(100, pct))) + '%';
  }
  const resetEl = field(group, 'bar-' + key + '-reset');
  if (resetEl) {
    if (reset) resetEl.textContent = reset;
    else resetEl.remove();
  }
}

/** 额度新鲜度行：带 data-fetched-at，交给每秒的 tickFreshness() 重算。 */
function fillFresh(root, q) {
  const el = field(root, 'card-fresh');
  if (!el) return;
  if (!q) { el.remove(); return; }
  const t = Number(q.fetchedAt);
  const known = Number.isFinite(t) && t > 0;
  const f = freshness(known ? t : NaN);
  el.className = 'card-fresh aux-text' + (f.stale ? ' is-stale' : '');
  if (known) el.setAttribute('data-fetched-at', String(t));
  if (f.stale) el.setAttribute('title', staleText());
  el.textContent = f.text;
}

/** 底部标签条：每个 tag 由 createElement + textContent 生成（无 HTML 字符串）。 */
function fillTags(root, a) {
  const host = field(root, 'tags');
  if (!host) return;
  host.setAttribute('data-key-id', String(a.keyId ?? ''));
  clearChildren(host);
  const push = (tone, text) => {
    const span = document.createElement('span');
    span.className = 'tag ' + tone;
    span.textContent = text;
    host.appendChild(span);
  };
  const schedulable = a.available && a.enabled !== false && !a.paused && !a.rateLimited && !a.authInvalid;
  push(schedulable ? 'ok' : a.enabled ? 'bad' : 'warn',
    (a.enabled ? '已启用' : '已停用') + ' · ' + (schedulable ? '可调度' : '不可用'));
  if (a.paused) push('warn', '暂停至 ' + shortDate(a.pausedUntil));
  if (a.rateLimited) {
    const left = Number(a.rateLimitedUntil) > Date.now() ? untilText(Number(a.rateLimitedUntil)) : '';
    push('warn', '限流冷却中' + (left ? ' · 剩 ' + left : ''));
  }
  if (a.authInvalid) push('bad', '鉴权失效');
  if (a.exhausted && a.exhausted.label) {
    const exMs = toMs(a.exhausted.resetAt);
    const reset = Number.isFinite(exMs) && exMs > 0
      ? ' · ' + shortDate(exMs) + (exMs <= Date.now() ? ' 已重置' : ' 重置')
      : '';
    push('bad', a.exhausted.label + reset);
  } else if (a.creditsExhausted) {
    push('bad', '余额不足');
  }
}

function fillHead(root, a) {
  const head = field(root, 'account-head');
  if (!head) return;
  clearChildren(head);
  head.appendChild(document.createTextNode(a.name || a.keyPrefix || shortId(a.keyId) || '未命名账号'));
  const label = a.lastQuota && a.lastQuota.plan ? planLabel(a.lastQuota.plan.planId) : null;
  if (label) {
    const pill = document.createElement('span');
    pill.className = 'plan-pill mono';
    pill.textContent = label;
    head.appendChild(pill);
  }
}

function fillStatus(root, st) {
  const status = field(root, 'account-status');
  if (!status) return;
  status.className = 'status is-' + st.tone;
  const dot = status.querySelector('.dot');
  for (const c of [...status.children]) if (c !== dot) status.removeChild(c);
  status.appendChild(document.createTextNode(st.t));
}

/** 一张账号卡片：克隆模板 + 填值，返回序列化后的 HTML（结构零拼接）。 */
function card(a, wideLast = false, index = 0) {
  const node = cloneTemplate('tpl-account');
  if (!node) return '';
  const st = statusText(a);
  const ex = a.exhausted || null;
  const q = a.lastQuota;
  node.className = 'card' + (st.dot ? ' ' + st.dot : '') + (wideLast ? ' card-wide' : '');
  node.setAttribute('style', '--i:' + index);

  fillHead(node, a);
  fillStatus(node, st);
  fillCredits(node, q);
  fillText(node, 'usable-balance', money(usableRemaining(a)));
  fillBar(node, '5h', '5 小时窗口', q && q.fiveHour, { spent: ex && ex.kind === 'window' && ex.window === 'fiveHour' });
  fillBar(node, 'week', '本周窗口', q && q.weekly, { spent: ex && ex.kind === 'window' && ex.window === 'weekly' });
  fillBar(node, 'month', '本月周期', q && q.monthly, { spent: ex && ex.kind === 'monthly' });
  if (q && q.usage) {
    fillText(node, 'card-usage', '本周期 token ' + num(q.usage.totalTokens)
      + (q.usage.totalCost === undefined ? '' : ' · 花费 ' + money(q.usage.totalCost)));
  } else {
    dropField(node, 'card-usage');
  }
  fillFresh(node, q);
  fillTags(node, a);
  return node.outerHTML;
}

function renderCards() {
  // 隐私模式（showPrivate 已把 state.data 置 null 并写下「请先登录后台」卡片）：
  // 搜索框 input 会走到这里，绝不能把那段提示覆盖成「账号池为空」。
  if (!state.data) return;
  const all = state.data.accounts;
  const f = state.filter.trim().toLowerCase();
  const byView = all.filter(inViewFilter);
  const list = f ? byView.filter((a) => String(a.name ?? '').toLowerCase().includes(f)) : byView;
  if (!list.length) {
    const msg = all.length
      ? (state.filter.trim() ? '没有匹配「' + esc(state.filter) + '」的账号。' : '该筛选下没有账号。')
      : '账号池为空。请在 accounts.json 里配置账号，或用 CC_ACCOUNTS 环境变量注入。';
    $('cards').innerHTML = emptyCard(msg);
    syncTagMasks();
    return;
  }
  // 手机端 .tags 是唯一横向滚动容器；整块重建会把 scrollLeft 归零，按 data-key-id 记录后回填。
  const scrollOf = new Map();
  for (const el of document.querySelectorAll('#cards .tags[data-key-id]')) {
    scrollOf.set(el.getAttribute('data-key-id'), el.scrollLeft);
  }
  $('cards').innerHTML = list.map((a, i) => card(a, i === list.length - 1 && list.length % 2 === 1, i)).join('');
  for (const el of document.querySelectorAll('#cards .tags[data-key-id]')) {
    const key = el.getAttribute('data-key-id');
    if (scrollOf.has(key)) el.scrollLeft = scrollOf.get(key);
  }
  syncTagMasks();
}
