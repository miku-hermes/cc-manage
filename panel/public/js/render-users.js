/* B24：管理员表 —— 行结构在 admin.astro 的 <template id="tpl-user-row">，只克隆 + 填值。 */
function userRow(u) {
  const node = cloneTemplate('tpl-user-row');
  if (!node) return '';
  const name = String(u.username ?? '');
  fillText(node, 'name', name);
  fillText(node, 'created', u.createdAt ? timeText(u.createdAt) : '—');
  const isSelf = state.auth && state.auth.user && state.auth.user.username === u.username;
  const self = field(node, 'self');
  if (self) { if (isSelf) self.textContent = ' 当前登录'; else self.remove(); }
  const pass = field(node, 'btn-pass');
  if (pass) pass.setAttribute('data-name', name);
  const del = field(node, 'btn-del');
  if (del) {
    // 至少保留一个管理员：只剩一个时按钮置灰，并摘掉 data-act/data-name（不可用即不可点）。
    if (state.users.length > 1) {
      del.setAttribute('data-name', name);
    } else {
      del.removeAttribute('data-act');
      del.disabled = true;
      del.setAttribute('disabled', '');   // 属性 + 属性双写：innerHTML 重建后仍是禁用态
      del.setAttribute('title', '至少保留一个管理员');
    }
  }
  return outerRow(node);
}

function renderUsers() {
  const list = state.users;
  $('user-count').textContent = list.length + ' 个';
  if (!list.length) {
    $('users').innerHTML = emptyRow(3, '还没有管理员');
    applyWritable(state.writable, state.readonlyReason);
    return;
  }
  $('users').innerHTML = list.map(userRow).join('');
  applyWritable(state.writable, state.readonlyReason);
}
