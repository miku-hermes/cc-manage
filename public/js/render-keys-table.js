function renderKeys() {
  const list = state.keys;
  $('key-count').textContent = list.length + ' 个';
  if (!list.length) {
    $('keys').innerHTML = '<tr><td colspan="5" class="empty">还没有客户端 key，点「生成新 key」创建</td></tr>';
    applyWritable(state.writable, state.readonlyReason);
    return;
  }
  $('keys').innerHTML = list.map((k) => {
    const id = esc(k.keyId);
    return '<tr>'
      + '<td data-label="名称"><div class="cell-name">' + esc(k.name) + '</div></td>'
      + '<td data-label="keyId" class="mono cell-sub">' + id + '</td>'
      + '<td data-label="keyPrefix" class="mono cell-sub">' + maskedKey(k.keyPrefix) + '</td>'
      + '<td data-label="创建时间" class="cell-sub">' + esc(k.createdAt ? timeText(k.createdAt) : '—') + '</td>'
      + '<td data-label="操作" class="actions"><button class="btn danger" type="button" data-act="delkey" data-id="' + id + '">删除</button></td>'
      + '</tr>';
  }).join('');
  applyWritable(state.writable, state.readonlyReason);
}
