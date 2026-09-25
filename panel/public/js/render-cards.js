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
  el.className = 'card-fresh aux-text text-xs text-base-content/60' + (f.stale ? ' is-stale' : '');
  if (known) el.setAttribute('data-fetched-at', String(t));
  if (f.stale) el.setAttribute('title', staleText());
  el.textContent = f.text;
}

/** 底部标签条：只放状态徽章没说过的补充信息（暂停/限流/耗尽），不重复「可用」。 */
function fillTags(root, a) {
  const host = field(root, 'tags');
  if (!host) return;
  host.setAttribute('data-key-id', String(a.keyId ?? ''));
  clearChildren(host);
  const push = (tone, text) => {
    const span = document.createElement('span');
    span.className = 'tag badge badge-sm shrink-0 ' + toneBadge(tone) + ' ' + tone;
    span.textContent = text;
    host.appendChild(span);
  };
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
    pill.className = 'plan-pill badge badge-ghost badge-sm font-mono';
    pill.textContent = label;
    head.appendChild(pill);
  }
}

function fillStatus(root, st) {
  const status = field(root, 'account-status');
  if (!status) return;
  status.className = 'status badge ' + toneBadge(st.tone) + ' is-' + st.tone;
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

function renderCards() {
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
