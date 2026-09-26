/* B24：后台账号表 —— 行结构只在 admin.astro 的 <template id="tpl-account-row"> 里出现一次，
   这里只做「克隆 + 用 [data-f] 填值」，不再手拼 HTML 字符串。
   语义与旧实现一致：状态徽章 = 健康度（ok/warn/crit），额度条 = 数据量；两者互不混用。 */

function accountStatus(a) {
  if (a.authInvalid) return { t: '鉴权失效', tone: 'bad', dot: 'invalid', schedulable: false };
  if (!a.enabled) return { t: '已停用', tone: 'warn', dot: 'paused', schedulable: false };
  // 额度耗尽统一口径：周/5 小时窗口用完、月额度用完，都说「已用完」而不是笼统的
  // 「不可调度」——用户要的正是这种可读性（副号1 = 周用完，主号 = 月用完）。
  // 判序与前台一致：耗尽优先于「冷却中」，避免同卡两色。
  if (a.exhausted && a.exhausted.label) return { t: a.exhausted.label, tone: 'bad', dot: 'invalid', schedulable: false };
  if (a.creditsExhausted) return { t: '余额不足', tone: 'bad', dot: 'invalid', schedulable: false };
  if (a.paused || a.rateLimited) return { t: '冷却中', tone: 'warn', dot: 'paused', schedulable: false };
  if (!a.available) return { t: '不可调度', tone: 'bad', dot: 'invalid', schedulable: false };
  return { t: '可用', tone: 'ok', dot: '', schedulable: true };
}
function badgeOf(tone) { return tone === 'bad' ? 'badge-error' : tone === 'warn' ? 'badge-warning' : tone === 'info' ? 'badge-info' : 'badge-success'; }

/** 状态徽章（+ 有耗尽窗口时的恢复时间）。只表达健康度，不表达数据量。 */
function fillStatus(root, a) {
  const st = accountStatus(a);
  const availability = st.schedulable ? '可调度' : '不可用';
  let label = st.t === '不可调度' ? '额度不可用' : st.t;
  // 「额度不可用」是额度语义；普通限流（429 短冷却）单独说清楚，别混进额度问题。
  if (label === '冷却中' && a.rateLimited) label = '限流冷却中';
  const el = field(root, 'status');
  if (!el) return;
  el.className = 'tag badge badge-sm ' + badgeOf(st.tone) + ' ' + st.tone;
  el.setAttribute('data-account-status', st.dot || 'ok');
  el.textContent = st.schedulable ? '可用 · 可调度' : label + ' · ' + availability;
  // 状态列补上耗尽窗口的恢复时间（周/月都有 resetAt），比只写一个标签有用。
  const exMs = a.exhausted ? toMs(a.exhausted.resetAt) : NaN;
  const reset = field(root, 'status-reset');
  if (!reset) return;
  if (Number.isFinite(exMs) && exMs > 0) reset.textContent = shortDate(exMs) + (exMs <= Date.now() ? ' 已重置' : ' 重置');
  else reset.remove();
}

/** 状态徽章 HTML（cloned from the row template —— 旧调用点/测试仍按「取一段 HTML」用它）。 */
function statusTag(a) {
  const node = cloneTemplate('tpl-account-row');
  if (!node) return '';
  fillStatus(node, a);
  const cell = field(node, 'status-cell');
  return cell ? outerRow(cell) : '';
}

/* ── 额度条（与前台 bar() 同口径）────────────────────────────────────
   上游/探针已证明这个窗口用完时直接画满 —— 99.4% 这种「差一点」会和紧挨着的
   「月额度已用完」状态标签自相矛盾。色调只由阈值决定（≥90 红 / ≥70 琥珀）。 */
function quotaTone(pct) {
  if (pct !== null && pct >= 90) return 'bad progress-error';
  if (pct !== null && pct >= 70) return 'warn progress-warning';
  return 'progress-success';
}
/* 窗口槽位 → 可访问名里的窗口说法（B25 D：读屏要能知道是哪个账号的哪个窗口）。 */
const QUOTA_WINDOW_LABEL = { 'bar-5h': '5 小时窗口', 'bar-week': '本周窗口', 'bar-month': '本月周期' };

function fillQuotaBar(root, slot, w, opts) {
  const bar = field(root, slot);
  if (!bar) return;
  const spent = !!opts && opts.spent === true;
  const pct = spent ? 100 : (w && typeof w.percent === 'number' ? w.percent : null);
  const track = field(bar, slot + '-track');
  if (track) {
    track.className = 'progress qbar-track h-1.5 ' + quotaTone(pct);
    // 垫片/真实 DOM 都要求用 setAttribute 同步 value（属性序列化才看得到）。
    // D：value 取到 1 位小数，产物里不再出现 64.98198366666666 这类裸浮点。
    const clamped = Math.max(0, Math.min(100, pct === null ? 0 : Number(pct)));
    const rounded = Math.round(clamped * 10) / 10;
    track.setAttribute('value', String(rounded));
    // D：可访问名（哪个账号的哪个窗口）+ 格式化后的 aria-valuetext（与可视百分比逐字符一致）。
    const nameEl = field(root, 'name');
    const who = nameEl && nameEl.textContent ? nameEl.textContent : '该账号';
    const windowLabel = QUOTA_WINDOW_LABEL[slot] || '额度窗口';
    track.setAttribute('aria-label', who + ' · ' + windowLabel + '额度使用');
    track.setAttribute('aria-valuetext', pctText(pct));
  }
  fillText(bar, slot + '-pct', pctText(pct));
  // resetAt 是秒：补一句「重置 M/D HH:MM」，光有百分比看不出窗口什么时候回来。
  const abs = w ? shortDate(w.resetAt) : '';
  const reset = field(bar, slot + '-reset');
  if (reset) { if (abs) reset.textContent = '重置 ' + abs; else reset.remove(); }
}

/** 单条额度条 HTML（复用行模板的「月」槽位并改写标签 —— 旧调用点/测试仍按「取一段 HTML」用它）。 */
function quotaBar(label, w, opts) {
  const node = cloneTemplate('tpl-account-row');
  if (!node) return '';
  fillQuotaBar(node, 'bar-month', w, opts);
  const bar = field(node, 'bar-month');
  fillText(bar, 'bar-month-label', label);
  return bar ? outerRow(bar) : '';
}

/** 余额行：余额结论 + 套餐/备注名。 */
function fillQuotaMeta(root, a, q, ex) {
  const raw = Number.isFinite(q.remaining) ? q.remaining : null;
  const dead = ex && (ex.kind === 'monthly' || ex.kind === 'balance');
  const balanceTitle = raw === null ? '账面余额未知' : '账面 ' + money(raw)
    + (dead ? ' · ' + (a.exhausted.label || '额度已用完') + '，不可用' : '');
  const bal = field(root, 'usable-balance');
  if (bal) { bal.textContent = money(usableRemaining(a)); bal.setAttribute('title', balanceTitle); }
  const plan = field(root, 'quota-plan');
  if (plan) {
    plan.textContent = (q.plan && q.plan.planId ? ' · 套餐 ' + planLabel(q.plan.planId) : '')
      + (q.displayName ? ' · ' + q.displayName : '');
  }
}

/** 额度构成：恒为 0 的段不占位（与前台卡片同一约束）。 */
function fillCredits(root, q) {
  const el = field(root, 'credits');
  if (!el) return;
  if (!q.credits) { el.remove(); return; }
  const parts = [
    ['月度', Number(q.credits.monthlyCredits) || 0],
    ['购买', Number(q.credits.purchasedCredits) || 0],
    ['赠送', Number(q.credits.freeCredits) || 0],
  ].filter(([, v]) => v > 0);
  if (!parts.length) { el.remove(); return; }
  el.textContent = parts.map(([t, v]) => t + ' ' + money(v)).join(' · ');
}

/** 连通性测试结论（有则显示，无则整块移除）。 */
function fillTestNote(root, a) {
  const el = field(root, 'test-note');
  if (!el) return;
  const test = testResults.get(a.keyId);
  if (!test) { el.remove(); return; }
  el.className = 'test-note text-xs ' + (test.ok ? 'ok text-success' : 'bad text-error');
  const who = test.result.displayName || test.result.userName || '-';
  el.textContent = (test.ok
    ? '✓ whoami 通过：' + who + (test.result.keyName ? '（key ' + test.result.keyName + '）' : '')
    : '✗ ' + (test.result.error || '测试失败'))
    + ' · ' + timeText(test.at);
}

/** 一行账号：克隆模板 + 填值，返回序列化 HTML（结构零拼接）。 */
function accountRow(a) {
  const node = cloneTemplate('tpl-account-row');
  if (!node) return '';
  const id = String(a.keyId ?? '');
  const q = a.lastQuota || null;
  const ex = a.exhausted || null;

  fillText(node, 'name', a.name || a.keyPrefix || shortId(a.keyId) || '未命名账号');
  fillTestNote(node, a);
  fillText(node, 'key-id', id);
  const kp = field(node, 'key-prefix');
  if (kp) kp.innerHTML = maskedKey(a.keyPrefix);
  fillStatus(node, a);

  const errored = field(node, 'error');
  if (q) {
    fillQuotaBar(node, 'bar-5h', q.fiveHour, { spent: !!ex && ex.kind === 'window' && ex.window === 'fiveHour' });
    fillQuotaBar(node, 'bar-week', q.weekly, { spent: !!ex && ex.kind === 'window' && ex.window === 'weekly' });
    fillQuotaBar(node, 'bar-month', q.monthly, { spent: !!ex && ex.kind === 'monthly' });
    fillQuotaMeta(node, a, q, ex);
    fillCredits(node, q);
    if (errored) {
      // 口径：lastQuota 只来自「成功快照」；有快照时 lastError 是「最近一次」错误，照实说。
      if (a.lastError) errored.textContent = '最近错误：' + a.lastError;
      else errored.remove();
    }
  } else {
    // 没有快照 = 从未同步成功：把真实 lastError 显示出来，别只留一个红 ⚠。
    for (const slot of ['bar-5h', 'bar-week', 'bar-month', 'quota-meta', 'credits']) dropField(node, slot);
    if (errored) errored.textContent = a.lastError ? '额度未同步：' + a.lastError : '尚未获取额度快照';
  }

  const btnDetail = field(node, 'btn-detail');
  if (btnDetail) { btnDetail.setAttribute('data-focus-return', 'account-detail-' + id); btnDetail.setAttribute('data-id', id); btnDetail.setAttribute('aria-label', '查看 ' + (a.name || a.keyPrefix || '未命名账号') + ' 详情'); }
  const btnTest = field(node, 'btn-test');
  if (btnTest) btnTest.setAttribute('data-id', id);
  const btnToggle = field(node, 'btn-toggle');
  if (btnToggle) {
    btnToggle.setAttribute('data-id', id);
    btnToggle.className = 'btn btn-xs ' + (a.enabled ? 'btn-warning' : 'btn-outline');
    btnToggle.textContent = a.enabled ? '停用' : '启用';
  }
  const btnRename = field(node, 'btn-rename');
  if (btnRename) btnRename.setAttribute('data-id', id);
  const btnDel = field(node, 'btn-del');
  if (btnDel) btnDel.setAttribute('data-id', id);

  return outerRow(node);
}

// ── CC 账号（含额度 + 连通性测试）────────────────────────────────────
function renderAccounts() {
  const list = state.accounts;
  $('acc-count').textContent = list.length + ' 个';
  if (!list.length) {
    $('accounts').innerHTML = emptyRow(5, '还没有账号，点右上角「新增 CC key」添加');
    applyWritable(state.writable, state.readonlyReason);
    return;
  }
  $('accounts').innerHTML = list.map(accountRow).join('');
  applyWritable(state.writable, state.readonlyReason);
}
