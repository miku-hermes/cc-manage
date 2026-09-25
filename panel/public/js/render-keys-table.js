/* B24：客户端 key 表 —— 行结构在 admin.astro 的 <template id="tpl-key-row">，只克隆 + 填值。 */
function keyRow(k) {
  const node = cloneTemplate('tpl-key-row');
  if (!node) return '';
  const id = String(k.keyId ?? '');
  fillText(node, 'name', k.name);
  fillText(node, 'key-id', id);
  const kp = field(node, 'key-prefix');
  if (kp) kp.innerHTML = maskedKey(k.keyPrefix);
  fillText(node, 'created', k.createdAt ? timeText(k.createdAt) : '—');
  const del = field(node, 'btn-del');
  if (del) del.setAttribute('data-id', id);
  return outerRow(node);
}

function renderKeys() {
  const list = state.keys;
  $('key-count').textContent = list.length + ' 个';
  if (!list.length) {
    $('keys').innerHTML = emptyRow(5, '还没有客户端 key，点「生成新 key」创建');
    applyWritable(state.writable, state.readonlyReason);
    return;
  }
  $('keys').innerHTML = list.map(keyRow).join('');
  applyWritable(state.writable, state.readonlyReason);
}
