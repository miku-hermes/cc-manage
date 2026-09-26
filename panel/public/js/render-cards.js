/* 账号行渲染（B24：daisyUI collapse 行式，结构只在 AccountCard.astro 模板里存在一次）。
   克隆 <template id="tpl-account">，用 [data-f] 钩子 + textContent 填值（用户数据永不进 innerHTML）。
   状态只表达健康度；数据量交给窗口进度条；恒为 0 的字段（购买/赠送）直接省略。 */

/** 一个状态对象：与后台同源口径（可用/冷却/耗尽/鉴权失效）。 */
function accountStatus(a) {
  if (a.authInvalid) return { t: '鉴权失效', tone: 'bad', dot: 'invalid', schedulable: false };
  if (!a.enabled) return { t: '已停用', tone: 'warn', dot: 'paused', schedulable: false };
  if (a.exhausted && a.exhausted.label) return { t: a.exhausted.label, tone: 'bad', dot: 'invalid', schedulable: false };
  if (a.creditsExhausted) return { t: '余额不足', tone: 'bad', dot: 'invalid', schedulable: false };
  if (a.paused || a.rateLimited) return { t: '冷却中', tone: 'warn', dot: 'paused', schedulable: false };
  if (!a.available) return { t: '不可调度', tone: 'bad', dot: 'invalid', schedulable: false };
  return { t: '可用', tone: 'ok', dot: '', schedulable: true };
}
function statusText(a) { return accountStatus(a); }

function isExhaustedAccount(a) {
  return !!(a && (a.exhausted || a.creditsExhausted || a.authInvalid));
}

function inViewFilter(a) {
  switch (state.viewFilter) {
    case 'available': return accountStatus(a).schedulable;
    case 'cooldown': return !!(a.paused || a.rateLimited) && !isExhaustedAccount(a);
    case 'exhausted': return isExhaustedAccount(a);
    default: return true;
  }
}

function usableRemaining(a) {
  const q = a && a.lastQuota;
  if (!q || !Number.isFinite(q.remaining)) return null;
  const k = a.exhausted && a.exhausted.kind;
  if (k === 'monthly' || k === 'balance') return 0;
  return q.remaining;
}

/** daisyUI 状态色映射：健康度只用 ok/warn/crit 三档。 */
function toneBadge(tone) { return tone === 'bad' ? 'badge-error' : tone === 'warn' ? 'badge-warning' : 'badge-success'; }
function toneText(tone) { return tone === 'bad' ? 'text-error' : tone === 'warn' ? 'text-warning' : 'text-success'; }
function progressTone(p) { const v = Number(p); return Number.isFinite(v) && v >= 90 ? 'progress-error' : Number.isFinite(v) && v >= 70 ? 'progress-warning' : 'progress-success'; }

/* ── 模板克隆工具（无 HTML 字符串拼接）────────────────────────────── */
function clearChildren(el) { while (el && el.firstChild) el.removeChild(el.firstChild); }
function cloneTemplate(id) {
  const tpl = $(id);
  if (!tpl || !tpl.content || !tpl.content.firstElementChild) return null;
  return tpl.content.firstElementChild.cloneNode(true);
}
function field(root, name) { return root.querySelector('[data-f="' + name + '"]'); }
function fillText(root, name, text) { const el = field(root, name); if (el) el.textContent = text; return el; }
function dropField(root, name) { const el = field(root, name); if (el) el.remove(); }

/** 额度构成：只画非 0 的段（恒为 0 的购买/赠送不占位），图例同步省略。 */
function fillCredits(root, q) {
  const c = q && q.credits ? q.credits : null;
  const bar = field(root, 'credits-bar');
  if (!c) {
    if (bar) bar.remove();
    fillText(root, 'credits-legend', '尚未获取额度快照');
    return;
  }
  const parts = [
    ['seg-month', '月度', Number(c.monthlyCredits) || 0],
    ['seg-buy', '购买', Number(c.purchasedCredits) || 0],
    ['seg-gift', '赠送', Number(c.freeCredits) || 0],
  ];
  const shown = parts.filter(([, , v]) => v > 0);
  const total = shown.reduce((s, [, , v]) => s + v, 0);
  // 三段全 0：没有构成可画，去掉空条，只留一句真话（空态不撒谎，也不画假比例）。
  if (bar && !shown.length) {
    bar.remove();
    fillText(root, 'credits-legend', '额度构成待同步');
    return;
  }
  if (bar) {
    for (const [name, , v] of parts) {
      const el = field(bar, name);
      if (!el) continue;
      if (v <= 0) { el.remove(); continue; }
      el.style.width = (total > 0 ? +(v / total * 100).toFixed(4) : 0) + '%';
    }
    const label = '额度构成：' + shown.map(([, t, v]) => t + ' ' + money(v)).join(' · ');
    bar.setAttribute('aria-label', label);
    bar.setAttribute('title', label);
  }
  fillText(root, 'credits-legend', shown.map(([, t, v]) => t + ' ' + money(v)).join(' · '));
}

/** 单条窗口进度条（daisyUI progress）。没有快照的窗口整行不渲染（空闲不占位）。
    重置时间与窗口条同行、只说一次。 */
function fillBar(root, key, label, w, opts) {
  const group = field(root, 'bar-' + key);
  if (!group) return;
  const has = w && typeof w === 'object';
  if (!has) { group.remove(); return; }
  const spent = !!opts && opts.spent === true;
  const pct = spent ? 100 : (typeof w.percent === 'number' ? w.percent : null);
  // 金额收进 title / aria-label（正文只留百分比）。与旧口径一致：`label：已用 <used> / <cap>`。
  const amountText = Number.isFinite(Number(w.used)) && Number.isFinite(Number(w.cap))
    ? label + '：已用 ' + money(w.used) + ' / ' + money(w.cap) : '';
  group.setAttribute('role', 'group');
  if (amountText) { group.setAttribute('title', amountText); group.setAttribute('aria-label', amountText); }
  fillText(group, 'bar-' + key + '-pct', pctText(pct));
  const track = field(group, 'bar-' + key + '-track');
  if (track) {
    const empty = pct === null || pct <= 0;
    // h-1.5 = 6px：轨道与填充是同一个 progress 元素，永远同粗；0% 也保留完整空轨道。
    track.className = 'progress bar h-1.5 w-full ' + cls(pct) + ' ' + progressTone(pct) + (empty ? ' is-empty' : '');
    // 用 setAttribute 而不是 .value：DOM 垫片里 IDL 属性不反映到属性序列化，写属性两边都正确。
    track.setAttribute('max', '100');
    track.setAttribute('value', String(pct === null ? 0 : Math.max(0, Math.min(100, pct))));
  }
  const reset = resetText(w, { zeroMeansIdle: key === '5h' });
  const resetEl = field(group, 'bar-' + key + '-reset');
  if (resetEl) {
    if (reset) resetEl.textContent = reset;
    else resetEl.remove();
  }
  // 三个读数都没有（没百分比、没金额、没重置时间）→ 整个窗口没有信息量，不占一行。
  if (pct === null && !amountText && !reset) group.remove();
}

/** 额度新鲜度行（带 data-fetched-at，交给每秒的 tickFreshness() 重算）。 */
function fillFresh(root, q) {
  const el = field(root, 'card-fresh');
  if (!el) return;
  if (!q) { el.remove(); return; }
  const t = Number(q.fetchedAt);
  const known = Number.isFinite(t) && t > 0;
  const f = freshness(known ? t : NaN);
  el.className = 'card-fresh aux-text text-sm tabular-nums' + (f.stale ? ' is-stale' : '');
  if (known) el.setAttribute('data-fetched-at', String(t));
  if (f.stale) el.setAttribute('title', staleText());
  el.textContent = f.text;
}

/** 底部标签条：只放状态徽章**没说过的**补充信息，绝不重复状态词（同一件事不说两遍）。
    徽章已经表达「为什么不可用」（月/周额度已用完、余额不足、鉴权失效），
    这里只补徽章没有的独有信息 —— 耗尽后的「重置时间」；时间未知就不占位。 */
function fillTags(root, a) {
  const host = field(root, 'tags');
  if (!host) return;
  host.setAttribute('data-key-id', String(a.keyId ?? ''));
  clearChildren(host);
  const push = (cls, text) => {
    const span = document.createElement('span');
    span.className = 'tag badge badge-sm shrink-0 tabular-nums ' + cls;
    span.textContent = text;
    host.appendChild(span);
  };
  if (a.paused) push('badge-warning warn', '暂停至 ' + shortDate(a.pausedUntil));
  if (a.rateLimited) {
    const left = Number(a.rateLimitedUntil) > Date.now() ? untilText(Number(a.rateLimitedUntil)) : '';
    push('badge-warning warn', '限流冷却中' + (left ? ' · 剩 ' + left : ''));
  }
  // 时间信息是补充事实，不是第二次状态判定 —— 用中性色，别再加一枚红/橙徽章。
  if (a.exhausted && a.exhausted.label) {
    const exMs = toMs(a.exhausted.resetAt);
    if (Number.isFinite(exMs) && exMs > 0) {
      push('badge-ghost', shortDate(exMs) + (exMs <= Date.now() ? ' 已重置' : ' 重置'));
    }
  }
}

function fillHead(root, a) {
  const head = field(root, 'account-head');
  if (head) {
    clearChildren(head);
    head.appendChild(document.createTextNode(a.name || a.keyPrefix || shortId(a.keyId) || '未命名账号'));
  }
  // B24h：套餐徽章写进名称**后面**的独立槽位，而不是塞进 h2 —— 否则徽章内联在名称文字后，
  // 起点跟着名字长度走（短名那行左移几像素）。放进槽位后起点 = 统一名称列宽 + gap。
  const slot = field(root, 'plan-slot');
  if (slot) clearChildren(slot);
  const label = a.lastQuota && a.lastQuota.plan ? planLabel(a.lastQuota.plan.planId) : null;
  if (label && slot) {
    const pill = document.createElement('span');
    pill.className = 'plan-pill badge badge-ghost badge-sm font-mono';
    pill.textContent = label;
    slot.appendChild(pill);
  }
}

function fillStatus(root, st) {
  const status = field(root, 'account-status');
  if (!status) return;
  // B24i：min-w 把 --status-col（全表最宽状态徽章的实测盒宽）兜成地板 —— 四行状态列等宽，
  // 文案由 daisyUI badge 自带的 justify-content:center 在列内居中。
  status.className = 'acct-status badge shrink-0 whitespace-nowrap min-w-[var(--status-col,0px)] px-2.5 py-1 text-sm ' + toneBadge(st.tone) + ' is-' + st.tone;
  const dot = status.querySelector('.dot');
  for (const c of [...status.children]) if (c !== dot) status.removeChild(c);
  status.appendChild(document.createTextNode(st.t));
}

/** 一行账号：克隆模板 + 填值，返回序列化后的 HTML（结构零拼接）。 */
function card(a, wideLast = false, index = 0) {
  const node = cloneTemplate('tpl-account');
  if (!node) return '';
  const st = statusText(a);
  const ex = a.exhausted || null;
  const q = a.lastQuota;
  node.className = 'card row-card collapse collapse-arrow border border-base-300 bg-base-100 is-' + st.tone
    + (st.tone === 'bad' ? ' is-crit' : '') + (wideLast ? ' card-wide' : '');
  node.setAttribute('style', '--i:' + index);
  node.setAttribute('data-key-id', String(a.keyId ?? ''));
  const detailButton = field(node, 'detail-trigger');
  if (detailButton) {
    detailButton.setAttribute('aria-label', '查看 ' + (a.name || a.keyPrefix || shortId(a.keyId) || '未命名账号') + ' 详情');
    detailButton.setAttribute('data-focus-return', String(index));
  }

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
  // 内部钩子不留在产出 DOM 里。
  for (const el of node.querySelectorAll('[data-f]')) el.removeAttribute('data-f');
  return node.outerHTML;
}

/** B24g/B24h：名称列统一宽度 —— 逐行内容自适应会让「短名」那行的徽章起点左移几像素（真机 8-9px）。
    这里量出全表最长名称所需宽（h2 现在只含名称文字，徽章在旁边的 .plan-slot），写到 #cards 的
    --name-col；模板里 h2 用 min-w-[var(--name-col,0px)] 兜住这个宽度，于是每一行名称列等宽、紧随
    其后的 .plan-slot 徽章起点也等宽，而名字本身仍按内容自适应（不截死像素、不截断）。
    没有布局引擎（scrollWidth/rect 恒 0）时量不到值，保持逐行内容宽。 */
function syncNameColumn() {
  const host = $('cards');
  if (!host || !host.style || typeof host.style.setProperty !== 'function') return;
  const heads = host.querySelectorAll('.row-card h2');
  if (!heads.length) { host.style.setProperty('--name-col', '0px'); return; }
  host.style.setProperty('--name-col', '0px');       // 先归零：数据变短后名称列要能缩回去
  let max = 0;
  for (const h2 of heads) {
    const rect = typeof h2.getBoundingClientRect === 'function' ? h2.getBoundingClientRect() : null;
    max = Math.max(max, Number(h2.scrollWidth) || 0, rect ? Number(rect.width) || 0 : 0);
  }
  if (max <= 0) return;
  // 窄屏兜底：名称列最多占卡片 60%，否则超长名字会把卡片撑出横向滚动。
  const cap = (Number(host.clientWidth) || 0) * 0.6;
  host.style.setProperty('--name-col', Math.ceil(cap > 0 ? Math.min(max, cap) : max) + 'px');
}
window.syncNameColumn = syncNameColumn;

/** B24i：状态列统一宽度 —— 状态文案长短差很多（「月额度已用完」6 字 vs「可用」2 字），
    内容自适应时中间那列的右边缘会参差 40 多像素。这里量出全表**最宽状态徽章的盒宽**
    （getBoundingClientRect = border-box，min-width 也按 border-box 生效，不会因为 1px
    边框再差出 2px）写进 #cards 的 --status-col；模板用 min-w-[var(--status-col,0px)] 把
    这个宽度兜成地板：每行徽章等宽 → 左右边缘都对齐，文案完整不裁、不换行（min-width 只
    加地板，不封顶，最长文案天然放得下）。
    宽度是量出来的「本表最长状态文案所需宽」，不是写死的像素值。
    没有布局引擎（scrollWidth/rect 恒 0）时量不到值，保持内容自适应。 */
function syncStatusColumn() {
  const host = $('cards');
  if (!host || !host.style || typeof host.style.setProperty !== 'function') return;
  const badges = host.querySelectorAll('.row-card .acct-status');
  if (!badges.length) { host.style.setProperty('--status-col', '0px'); return; }
  host.style.setProperty('--status-col', '0px');     // 先归零：状态变短后列要能缩回去
  let max = 0;
  for (const b of badges) {
    const rect = typeof b.getBoundingClientRect === 'function' ? b.getBoundingClientRect() : null;
    max = Math.max(max, rect ? Number(rect.width) || 0 : 0, Number(b.scrollWidth) || 0);
  }
  if (max <= 0) return;
  host.style.setProperty('--status-col', Math.ceil(max) + 'px');
}
window.syncStatusColumn = syncStatusColumn;

function renderCards() {
  if (!state.data) return;
  if (document.querySelector && document.querySelector('#m-detail.open')) return;
  const all = state.data.accounts;
  const f = state.filter.trim().toLowerCase();
  const byView = all.filter(inViewFilter);
  const list = f ? byView.filter((a) => String(a.name ?? '').toLowerCase().includes(f)) : byView;
  if (!list.length) {
    const msg = all.length
      ? (state.filter.trim() ? '没有匹配「' + esc(state.filter) + '」的账号。' : '该筛选下没有账号。')
      : '账号池为空。请在 accounts.json 里配置账号，或用 CC_ACCOUNTS 环境变量注入。';
    $('cards').innerHTML = emptyCard(msg);
    syncNameColumn();
    syncStatusColumn();
    syncTagMasks();
    return;
  }
  const scrollOf = new Map();
  for (const el of document.querySelectorAll('#cards .tags[data-key-id]')) {
    scrollOf.set(el.getAttribute('data-key-id'), el.scrollLeft);
  }
  $('cards').innerHTML = list.map((a, i) => card(a, i === list.length - 1 && list.length % 2 === 1, i)).join('');
  syncNameColumn();
  syncStatusColumn();
  for (const el of document.querySelectorAll('#cards .tags[data-key-id]')) {
    const key = el.getAttribute('data-key-id');
    if (scrollOf.has(key)) el.scrollLeft = scrollOf.get(key);
  }
  syncTagMasks();
}
