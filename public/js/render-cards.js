/* 进度条只报百分比，金额挪进 title —— 用户要求：上面显示"用了百分之多少"就够了，
   不要把具体数额（9.94 / 10.03）摆在脸上。
   opts.spent=true：上游/探针已证明这个窗口「用完」时直接画满。百分比是推算值，
   99.4% 这种"差一点"会让人以为还能用（实测剩 $0.098 连一次请求都付不起），
   所以满不满由证据说了算，不由这个数字说了算。 */
function bar(label, w, opts) {
  const has = w && typeof w === 'object';
  const spent = !!opts && opts.spent === true;
  const pct = spent ? 100 : (has && typeof w.percent === 'number' ? w.percent : null);
  const amounts = has && typeof w.used === 'number' && typeof w.cap === 'number'
    ? money(w.used) + ' / ' + money(w.cap) : null;
  const reset = has ? resetText(w, { zeroMeansIdle: label.indexOf('5 小时') === 0 }) : '';
  const empty = pct === null || pct <= 0;
  // 金额不再只藏在 title 里：触屏 / 键盘用户拿不到 title，同步给 aria-label。
  const amountText = amounts ? label + '：已用 ' + amounts : '';
  return '<div class="bar-group"' + (amountText ? ' title="' + esc(amountText) + '" aria-label="' + esc(amountText) + '"' : '') + '>'
    + '<div class="bar-head"><span class="bar-label">' + label + '</span>'
    + '<span class="bar-pct">' + pctText(pct) + '</span></div>'
    + '<div class="bar ' + cls(pct) + (empty ? ' is-empty' : '') + '"><i style="width:' + (pct === null ? 0 : Math.max(0, Math.min(100, pct))) + '%"></i></div>'
    + (reset ? '<div class="bar-reset">' + esc(reset) + '</div>' : '')
    + '</div>';
}

function accountStatus(a) {
  if (a.authInvalid) return { t: '鉴权失效', tone: 'bad', dot: 'invalid', schedulable: false };
  if (!a.enabled) return { t: '已停用', tone: 'warn', dot: 'paused', schedulable: false };
  // 额度耗尽统一口径：周/5 小时窗口用完、月额度用完，都说「已用完」而不是笼统的
  // 「不可调度」——用户要的正是这种可读性（副号1 = 周用完，主号 = 月用完）。
  // 判序：耗尽优先于「冷却中」。否则「周额度用完 + 冷却」会出现头部黄点「冷却中」、
  // 底部红标「周额度已用完」的同卡两色自相矛盾。
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

/** 额度新鲜度行：带 data-fetched-at，交给每秒的 tickFreshness() 重算。 */
function freshHTML(fetchedAt) {
  const t = Number(fetchedAt);
  const known = Number.isFinite(t) && t > 0;
  const f = freshness(known ? t : NaN);
  return '<div class="card-fresh aux-text' + (f.stale ? ' is-stale' : '') + '"'
    + (known ? ' data-fetched-at="' + t + '"' : '')
    + (f.stale ? ' title="' + esc(staleText()) + '"' : '')
    + '>' + esc(f.text) + '</div>';
}

/* 能用多少钱：额度已经用尽的账号（kind = monthly / balance）一律算 0 —— 规则见
   用户要求"他用不了的就是0"；window 只是排队，钱没死，照常返回真实余额。
   q == null（没有快照）返回 null：既不能在卡片上显示成 0.00（会和「尚未获取额度快照」
   矛盾），也不能在 hero 合计里被当成 0 累加（低估池余额）——由调用方单独处理。 */
function usableRemaining(a) {
  const q = a && a.lastQuota;
  if (!q || !Number.isFinite(q.remaining)) return null;   // 拿不到快照 → null，不计入合计
  const k = a.exhausted && a.exhausted.kind;
  if (k === 'monthly' || k === 'balance') return 0;       // 钱已经死了，上游实测付不了
  return q.remaining;                                     // 含 window：只是排队，钱没死
}

/** 名称右侧计划标签：从 plan.planId 派生（走 planLabel 友好名，不暴露原始 id）。 */
function planPill(q) {
  if (!q || !q.plan) return '';
  const label = planLabel(q.plan.planId);
  if (label === null || label === undefined || label === '') return '';
  return '<span class="plan-pill mono">' + esc(label) + '</span>';
}

/* 额度构成分段条：三段横向拼接，段宽 = 该段金额 / 三段之和（全 0 时为空条）。
   颜色：月度 = accent 粉 / 购买 = info 蓝 / 赠送 = success 绿。 */
function creditsBar(c) {
  const m = Number(c.monthlyCredits) || 0;
  const p = Number(c.purchasedCredits) || 0;
  const f = Number(c.freeCredits) || 0;
  const total = m + p + f;
  const w = (v) => (total > 0 ? +(v / total * 100).toFixed(4) : 0);
  const label = '额度构成：月度 ' + money(c.monthlyCredits) + ' · 购买 ' + money(c.purchasedCredits)
    + ' · 赠送 ' + money(c.freeCredits);
  return '<div class="credits-bar" role="img" aria-label="' + esc(label) + '" title="' + esc(label) + '">'
    + '<i class="seg-month" style="width:' + w(m) + '%"></i>'
    + '<i class="seg-buy" style="width:' + w(p) + '%"></i>'
    + '<i class="seg-gift" style="width:' + w(f) + '%"></i>'
    + '</div>';
}

/** 额度构成区块：标签 + 分段条 + 图例（无快照时只给「尚未获取额度快照」）。 */
function creditsBlock(q) {
  const c = q && q.credits ? q.credits : null;
  const legend = c
    ? '<div class="card-credits aux-text">月度 ' + money(c.monthlyCredits)
      + ' · 购买 ' + money(c.purchasedCredits) + ' · 赠送 ' + money(c.freeCredits) + '</div>'
    : '<div class="card-credits aux-text">尚未获取额度快照</div>';
  return '<div class="credits-block"><div class="credits-title">额度构成</div>'
    + (c ? creditsBar(c) : '') + legend + '</div>';
}

function card(a, wideLast = false, index = 0) {
  const ex = a.exhausted || null;   // 统一口径的「额度已用完」（含恢复时间）
  const q = a.lastQuota;
  const st = statusText(a);
  const cardCls = st.dot + (wideLast ? ' card-wide' : '');
  const tags = [];
  // 防御性：暂停/停用的账号绝不能同时标「可调度」。后端 isAvailable 已保证
  // （now 有默认值），但前端不该依赖单一数据源——历史 bug 就是这里露出矛盾的。
  const schedulable = a.available && a.enabled !== false && !a.paused && !a.rateLimited && !a.authInvalid;
  const stateBadge = (a.enabled ? '已启用' : '已停用') + ' · ' + (schedulable ? '可调度' : '不可用');
  tags.push('<span class="tag ' + (schedulable ? 'ok' : a.enabled ? 'bad' : 'warn') + '">' + stateBadge + '</span>');
  // 暂停可能到 7 天后，必须带日期；只给时分会被读成「今天」。
  if (a.paused) tags.push('<span class="tag warn">暂停至 ' + esc(shortDate(a.pausedUntil)) + '</span>');
  // 普通限流（429）是短冷却：给出「还剩多久」，而不是只写「冷却中」让人干等。
  if (a.rateLimited) {
    const left = Number(a.rateLimitedUntil) > Date.now() ? untilText(Number(a.rateLimitedUntil)) : '';
    tags.push('<span class="tag warn">限流冷却中' + (left ? ' · 剩 ' + esc(left) : '') + '</span>');
  }
  if (a.authInvalid) tags.push('<span class="tag bad">鉴权失效</span>');
  // 余额不足和「额度打满」不一样：5h 窗口等了会自己回来，钱不会 —— 说清楚要充值
  if (a.exhausted && a.exhausted.label) {
    // 带上恢复时间（窗口/月度都有）——比「需充值」有用得多，也不逼人花钱
    // resetAt 已过期说明窗口其实已经重置，写「已重置」而不是「过去时间 重置」。
    const exMs = toMs(a.exhausted.resetAt);
    const reset = Number.isFinite(exMs) && exMs > 0
      ? ' · ' + shortDate(exMs) + (exMs <= Date.now() ? ' 已重置' : ' 重置')
      : '';
    tags.push('<span class="tag bad">' + esc(a.exhausted.label + reset) + '</span>');
  } else if (a.creditsExhausted) {
    tags.push('<span class="tag bad">余额不足</span>');   // 兼容旧后端
  }

  // 头行：备注名（+ 上游显示名）+ 计划标签 + 状态胶囊。前台只显示备注名/显示名，
  // 不下发也不渲染 key 的任何片段（keyId 仅出现在底部 .tags 的 data-key-id 里做滚动回填）。
  const head = '<div class="card-head"><h2>' + esc(a.name)
    + (q && q.displayName ? '<span class="card-display">' + esc(q.displayName) + '</span>' : '')
    + planPill(q) + '</h2>'
    + '<span class="status is-' + esc(st.tone) + '"><span class="dot" aria-hidden="true"></span>' + esc(st.t) + '</span></div>';

  const body = '<div class="card-body">'
    + creditsBlock(q)
    + '<div class="card-money"><b>' + money(usableRemaining(a)) + '</b><small>剩余额度</small></div>'
    + '<div class="bars">'
    + bar('5 小时窗口', q && q.fiveHour, { spent: ex && ex.kind === 'window' && ex.window === 'fiveHour' })
    + bar('本周窗口', q && q.weekly, { spent: ex && ex.kind === 'window' && ex.window === 'weekly' })
    + bar('本月周期', q && q.monthly, { spent: ex && ex.kind === 'monthly' })
    + '</div>'
    + (q && q.usage ? '<div class="card-usage aux-text">本周期 token ' + esc(num(q.usage.totalTokens))
      + (q.usage.totalCost === undefined ? '' : ' · 花费 ' + money(q.usage.totalCost)) + '</div>' : '')
    + (q ? freshHTML(q.fetchedAt) : '')
    + '</div>';

  // style="--i:N"：卡在列表里的序号，只给 body.is-intro 入场 stagger 用
  return '<article class="card ' + cardCls + '" style="--i:' + index + '">'
    + head + body
    // data-key-id 让 renderCards 重建后能把每个账号标签条的原滚动位置回填（手机端 5s 刷新不跳回最左）
    + '<div class="tags" data-key-id="' + esc(a.keyId) + '">' + tags.join('') + '</div>'
    + '</article>';
}

function renderCards() {
  // 隐私模式（showPrivate 已把 state.data 置 null 并写下「请先登录后台」卡片）：
  // 搜索框 input 会走到这里，绝不能把那段提示覆盖成「账号池为空」。
  if (!state.data) return;
  const all = state.data.accounts;
  const f = state.filter.trim().toLowerCase();
  // 状态筛选与搜索叠加生效（先按状态筛，再按关键词筛）。
  const byView = all.filter(inViewFilter);
  const list = f
    ? byView.filter((a) => [a.name, a.lastQuota && a.lastQuota.displayName]
      .some((v) => String(v ?? '').toLowerCase().includes(f)))
    : byView;
  if (!list.length) {
    const msg = all.length
      ? (state.filter.trim() ? '没有匹配「' + esc(state.filter) + '」的账号。' : '该筛选下没有账号。')
      : '账号池为空。请在 accounts.json 里配置账号，或用 CC_ACCOUNTS 环境变量注入。';
    $('cards').innerHTML = '<div class="card empty">' + msg + '</div>';
    syncTagMasks();
    return;
  }
  // 手机端 .tags 是唯一横向滚动容器；innerHTML 整块重建会把 scrollLeft 归零，
  // 5s 轮询下用户永远读不到第 2/3 枚 pill（含重置时间）。按账号 data-key-id 记录后回填。
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
