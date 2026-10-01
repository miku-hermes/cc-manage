/* B24：客户端 key 表 —— 行结构在 admin.astro 的 <template id="tpl-key-row">，只克隆 + 填值。
   §4：新增 状态 / 用量 / 过期时间 / 备注 四列；keyId 只写进 data-key-id 属性，不进文本。 */
const KEY_STATE_TEXT = { active: '启用', disabled: '已停用', expired: '已过期', quota_exceeded: '已超限' };
const KEY_STATE_DOT = {
  active: 'bg-success',
  disabled: 'bg-base-content/30',
  expired: 'bg-error',
  quota_exceeded: 'bg-warning',
};
const KEY_QUOTA_WINDOWS = [
  { key: 'fiveHour', label: '5 小时' },
  { key: 'daily', label: '日' },
  { key: 'weekly', label: '周' },
];

/* 用量列：优先展示「有配置上限」的最紧窗口；一个都没配就按 5 小时窗口显示「不限」。 */
function keyUsageText(k) {
  const used = k.used || {};
  const quota = k.quota || {};
  for (const w of KEY_QUOTA_WINDOWS) {
    const cap = quota[w.key];
    if (Number.isFinite(cap)) {
      return w.label + ' ' + (Number(used[w.key]) || 0) + ' / ' + cap + ' token';
    }
  }
  return '5 小时 ' + (Number(used.fiveHour) || 0) + ' / 不限';
}

function keyRow(k) {
  const node = cloneTemplate('tpl-key-row');
  if (!node) return '';
  const id = String(k.keyId ?? '');
  const state = KEY_STATE_TEXT[k.state] ? k.state : 'active';
  node.setAttribute('data-key-id', id);
  fillText(node, 'name', k.name);
  const kp = field(node, 'key-prefix');
  if (kp) kp.innerHTML = maskedKey(k.keyPrefix);
  const dot = field(node, 'state-dot');
  if (dot) dot.className = 'status-dot inline-block size-2 shrink-0 rounded-full ' + (KEY_STATE_DOT[state] || '');
  fillText(node, 'state-text', KEY_STATE_TEXT[state]);
  fillText(node, 'usage', keyUsageText(k));
  fillText(node, 'expires', Number.isFinite(k.expiresAt) ? timeText(k.expiresAt) : '—');
  fillText(node, 'note', k.note ? k.note : '—');
  const btnToggle = field(node, 'btn-toggle');
  if (btnToggle) {
    btnToggle.setAttribute('data-id', id);
    btnToggle.className = 'btn btn-xs ' + (k.enabled === false ? 'btn-outline' : 'btn-warning');
    btnToggle.textContent = k.enabled === false ? '启用' : '停用';
    btnToggle.setAttribute('aria-label', (k.enabled === false ? '启用 ' : '停用 ') + (k.name || '未命名'));
  }
  const btnEdit = field(node, 'btn-edit');
  if (btnEdit) btnEdit.setAttribute('data-id', id);
  const del = field(node, 'btn-del');
  if (del) del.setAttribute('data-id', id);
  return outerRow(node);
}

function renderKeys() {
  const list = state.keys;
  $('key-count').textContent = list.length + ' 个';
  if (!list.length) {
    $('keys').innerHTML = emptyRow(7, '还没有客户端 key，点「生成新 key」创建');
    applyWritable(state.writable, state.readonlyReason);
    return;
  }
  $('keys').innerHTML = list.map(keyRow).join('');
  applyWritable(state.writable, state.readonlyReason);
}
