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
function statusTag(a) {
  const st = accountStatus(a);
  const availability = st.schedulable ? '可调度' : '不可用';
  let label = st.t === '不可调度' ? '额度不可用' : st.t;
  // 「额度不可用」是额度语义；普通限流（429 短冷却）单独说清楚，别混进额度问题。
  if (label === '冷却中' && a.rateLimited) label = '限流冷却中';
  // 状态列补上耗尽窗口的恢复时间（周/月都有 resetAt），比只写一个标签有用。
  const exMs = a.exhausted ? toMs(a.exhausted.resetAt) : NaN;
  const resetNote = Number.isFinite(exMs) && exMs > 0
    ? '<span class="cell-sub">' + esc(shortDate(exMs) + (exMs <= Date.now() ? ' 已重置' : ' 重置')) + '</span>'
    : '';
  return '<span class="tag ' + st.tone + '" data-account-status="' + (st.dot || 'ok') + '">'
    + esc(st.schedulable ? '可用 · 可调度' : label + ' · ' + availability) + '</span>' + resetNote;
}

// ── CC 账号（含额度 + 连通性测试）────────────────────────────────────
function quotaBar(label, w, opts) {
  // 与前台 bar() 同口径：上游/探针已证明这个窗口用完时直接画满 —— 99.4% 这种
  // 「差一点」会和紧挨着的「月额度已用完」状态标签自相矛盾。
  const spent = !!opts && opts.spent === true;
  const pct = spent ? 100 : (w && typeof w.percent === 'number' ? w.percent : null);
  const cls = pct === null ? '' : pct >= 90 ? 'bad' : pct >= 70 ? 'warn' : '';
  // resetAt 是秒：补一行「重置 M/D HH:MM」，光有百分比看不出窗口什么时候回来。
  const abs = w ? shortDate(w.resetAt) : '';
  const reset = abs ? '<div class="qbar-reset">重置 ' + esc(abs) + '</div>' : '';
  return '<div class="qbar"><span class="qbar-label">' + label + '</span>'
    + '<span class="qbar-track ' + cls + '"><i style="width:' + (pct === null ? 0 : Math.max(0, Math.min(100, pct))) + '%"></i></span>'
    + '<span class="qbar-pct">' + pctText(pct) + '</span></div>' + reset;
}

function renderAccounts() {
  const list = state.accounts;
  $('acc-count').textContent = list.length + ' 个';
  if (!list.length) {
    $('accounts').innerHTML = '<tr><td colspan="5" class="empty">还没有账号，点右上角「新增 CC key」添加</td></tr>';
    applyWritable(state.writable, state.readonlyReason);
    return;
  }
  $('accounts').innerHTML = list.map((a) => {
    const id = esc(a.keyId);
    const q = a.lastQuota;
    const ex = a.exhausted || null;
    const usable = usableRemaining(a);
    const raw = q && Number.isFinite(q.remaining) ? q.remaining : null;
    const dead = ex && (ex.kind === 'monthly' || ex.kind === 'balance');
    const balanceTitle = raw === null ? '账面余额未知' : '账面 ' + money(raw)
      + (dead ? ' · ' + esc(a.exhausted.label || '额度已用完') + '，不可用' : '');
    // 额度构成（月度/购买/赠送）——数据后端早就有，只是之前没渲染。
    const credits = q && q.credits
      ? '<div class="cell-sub aux-text">月度 ' + money(q.credits.monthlyCredits)
        + ' · 购买 ' + money(q.credits.purchasedCredits)
        + ' · 赠送 ' + money(q.credits.freeCredits) + '</div>'
      : '';
    // 口径：lastQuota 只来自「成功快照」，没有 q 就是从未同步成功；
    // 此时把真实 lastError（HTTP 401 / 超时）显示出来，别只留一个红 ⚠。
    // 不再用 q.ok 判断（生产不可达）。
    const quota = q
      ? quotaBar('5h', q.fiveHour, { spent: !!ex && ex.kind === 'window' && ex.window === 'fiveHour' })
        + quotaBar('周', q.weekly, { spent: !!ex && ex.kind === 'window' && ex.window === 'weekly' })
        + quotaBar('月', q.monthly, { spent: !!ex && ex.kind === 'monthly' })
        + '<div class="cell-sub aux-text">余额 <span class="usable-balance" title="' + balanceTitle + '">' + money(usable) + '</span>'
        + (q.plan && q.plan.planId ? ' · 套餐 ' + esc(planLabel(q.plan.planId)) : '')
        + (q.displayName ? ' · ' + esc(q.displayName) : '') + '</div>'
        + credits
        + (a.lastError ? '<div class="cell-error">最近错误：' + esc(a.lastError) + '</div>' : '')
      : '<div class="cell-error">' + (a.lastError ? '额度未同步：' + esc(a.lastError) : '尚未获取额度快照') + '</div>';
    const test = testResults.get(a.keyId);
    const testNote = test
      ? '<div class="test-note ' + (test.ok ? 'ok' : 'bad') + '">'
        + (test.ok
          ? '✓ whoami 通过：' + esc(test.result.displayName || test.result.userName || '-')
            + (test.result.keyName ? '（key ' + esc(test.result.keyName) + '）' : '')
          : '✗ ' + esc(test.result.error || '测试失败'))
        + ' · ' + esc(timeText(test.at)) + '</div>'
      : '';
    return '<tr>'
      + '<td data-label="备注名"><div class="cell-name">' + esc(a.name) + '</div>' + testNote + '</td>'
      + '<td data-label="keyId / keyPrefix" class="mono cell-sub">' + id + '<br>' + maskedKey(a.keyPrefix) + '</td>'
      + '<td data-label="额度" class="cell-quota">' + quota + '</td>'
      + '<td data-label="状态">' + statusTag(a) + '</td>'
      + '<td data-label="操作" class="actions">'
      + '<button class="btn outline" type="button" data-act="test" data-id="' + id + '">测试连通性</button>'
      + '<button class="btn ' + (a.enabled ? 'warning' : 'outline') + '" type="button" data-act="toggle" data-id="' + id + '">' + (a.enabled ? '停用' : '启用') + '</button>'
      + '<button class="btn outline" type="button" data-act="rename" data-id="' + id + '">改备注</button>'
      + '<button class="btn danger" type="button" data-act="del" data-id="' + id + '">删除</button>'
      + '</td></tr>';
  }).join('');
  applyWritable(state.writable, state.readonlyReason);
}
