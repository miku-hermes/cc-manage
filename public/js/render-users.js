function renderUsers() {
  const list = state.users;
  $('user-count').textContent = list.length + ' 个';
  if (!list.length) {
    $('users').innerHTML = '<tr><td colspan="3" class="empty">还没有管理员</td></tr>';
    applyWritable(state.writable, state.readonlyReason);
    return;
  }
  $('users').innerHTML = list.map((u) => {
    const name = esc(u.username);
    const isSelf = state.auth && state.auth.user && state.auth.user.username === u.username;
    return '<tr>'
      + '<td data-label="用户名"><div class="cell-name">' + name + (isSelf ? ' <span class="tag info">当前登录</span>' : '') + '</div></td>'
      + '<td data-label="创建时间" class="cell-sub">' + esc(u.createdAt ? timeText(u.createdAt) : '—') + '</td>'
      + '<td data-label="操作" class="actions">'
      + '<button class="btn outline" type="button" data-act="pass" data-name="' + name + '">改密码</button>'
      + (list.length > 1
        ? '<button class="btn danger" type="button" data-act="deluser" data-name="' + name + '">删除</button>'
        : '<button class="btn danger" type="button" disabled title="至少保留一个管理员">删除</button>')
      + '</td></tr>';
  }).join('');
  applyWritable(state.writable, state.readonlyReason);
}
