$('gate-submit').onclick = async () => {
  const username = $('gate-user').value.trim();
  const password = $('gate-pass').value;
  const setup = state.mode === 'setup';
  if (!username) return gateError('请输入用户名');
  if (!password) return gateError('请输入密码');
  if (setup && password !== $('gate-pass2').value) return gateError('两次输入的密码不一致');
  if (setup && password.length < 8) return gateError('密码长度至少 8 位');
  $('gate-submit').disabled = true;
  try {
    await apiJSON(setup ? '/api/auth/setup' : '/api/auth/login', { method: 'POST', body: { username, password } });
    $('gate-pass').value = '';
    $('gate-pass2').value = '';
    await boot();
    toast(setup ? '初始化完成，已登录' : '登录成功');
  } catch (e) {
    gateError(e.message || '登录失败');
  } finally {
    $('gate-submit').disabled = false;
  }
};
for (const id of ['gate-user', 'gate-pass', 'gate-pass2']) {
  $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') $('gate-submit').click(); });
}

$('logout').onclick = async () => {
  try { await apiJSON('/api/auth/logout', { method: 'POST' }); } catch { /* 忽略 */ }
  state.auth = null;
  showGate('login');
  toast('已退出登录');
};
// ── 加载 ────────────────────────────────────────────────────────────
async function loadAccounts() {
  const data = await apiJSON('/api/admin/accounts');
  state.accounts = data.accounts || [];
  for (const t of data.tests || []) {
    if (!t.keyId) continue;
    const prev = testResults.get(t.keyId);
    if (!prev || prev.at <= t.checkedAt) testResults.set(t.keyId, { ok: !!t.ok, result: t, at: t.checkedAt });
  }
  state.readonlyReason = '凭据以只读方式挂载，无法修改；请改用 config/ 目录挂载';
  renderAccounts();
  applyWritable(data.writable !== false, state.readonlyReason);
}

async function loadKeys() {
  const data = await apiJSON('/api/admin/keys');
  state.keys = data.keys || [];
  renderKeys();
}

async function loadUsers() {
  const data = await apiJSON('/api/admin/session');
  state.users = data.users || [];
  renderUsers();
}
async function loadAll() {
  try {
    await loadAccounts();
    $('autherr').className = 'banner hidden';
    await Promise.all([loadKeys(), loadUsers(), loadEvents()]);
    clearLoadError();
    return true;
  } catch (e) {
    if (!e || e.status !== 401) showLoadError(e);
    return false;
  }
}
// ── 弹窗 ────────────────────────────────────────────────────────────
let modalFocusReturn = null;
function openModal(id) {
  // 打开前记下焦点，关闭时归还 —— 键盘 / 屏幕阅读器用户不会丢上下文。
  modalFocusReturn = document.activeElement && document.activeElement.focus ? document.activeElement : null;
  $(id).classList.add('open');
}
function closeModal(id) {
  $(id).classList.remove('open');
  if (modalFocusReturn && modalFocusReturn.focus) modalFocusReturn.focus();
  modalFocusReturn = null;
}
// Esc 关闭当前打开的弹窗（并归还焦点）
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const open = document.querySelectorAll('.modal.open');
  if (!open.length) return;
  for (const m of open) m.classList.remove('open');
  if (modalFocusReturn && modalFocusReturn.focus) modalFocusReturn.focus();
  modalFocusReturn = null;
});

/**
 * 打开「修改密码」弹窗。
 * 改**他人**密码时后端要求带上当前管理员密码（scrypt 校验）；改自己不需要。
 * 因此改他人必须显示并校验 #p-current，改自己则隐藏（视为没有该字段）。
 */
function openPassModal(name) {
  passTarget = name;
  const me = state.auth && state.auth.user ? state.auth.user.username : null;
  const isSelf = !!me && me === name;
  $('p-sub').textContent = '为管理员「' + name + '」设置新密码（scrypt 加盐哈希存储）';
  $('p-pass').value = '';
  $('p-current').value = '';
  $('p-err').textContent = '';
  if (isSelf) $('p-current-field').classList.add('hidden');
  else $('p-current-field').classList.remove('hidden');
  openModal('m-pass');
  $('p-pass').focus();
}
for (const el of document.querySelectorAll('[data-close]')) {
  el.onclick = () => closeModal(el.getAttribute('data-close'));
}
for (const el of document.querySelectorAll('.modal')) {
  el.addEventListener('mousedown', (e) => { if (e.target === el) el.classList.remove('open'); });
}

async function guard(fn) {
  try { await fn(); }
  catch (e) {
    if (e.status === 401) return;              // showGate 已在 apiJSON 里触发
    if (e.status === 403) { applyWritable(false, e.message); toast(e.message, true); return; }
    toast(e.message || '操作失败', true);
  }
}

// ── CC 账号操作 ─────────────────────────────────────────────────────
$('add-account').onclick = () => { $('a-err').textContent = ''; openModal('m-account'); $('a-name').focus(); };
$('a-submit').onclick = () => guard(async () => {
  $('a-err').textContent = '';
  const name = $('a-name').value.trim();
  const key = $('a-key').value.trim();
  try {
    await apiJSON('/api/admin/accounts', { method: 'POST', body: { name, key } });
  } catch (e) { $('a-err').textContent = e.message; return; }
  $('a-name').value = '';
  $('a-key').value = '';          // 提交后清空，绝不回显
  closeModal('m-account');
  toast('账号已新增并热生效');
  await loadAccounts();
});

$('accounts').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = btn.getAttribute('data-id');
  // 必须比完整 keyId：shortId（前 8 字符）相同时会把操作作用到另一个账号上。
  const account = state.accounts.find((a) => String(a.keyId) === String(id));
  if (!account) return;
  const act = btn.getAttribute('data-act');

  if (act === 'test') {
    return guard(async () => {
      btn.disabled = true;
      btn.textContent = '测试中…';
      try {
        const data = await apiJSON('/api/admin/accounts/test', { method: 'POST', body: { keyId: id } });
        testResults.set(account.keyId, { ok: !!(data.result && data.result.ok), result: data.result || {}, at: Date.now() });
        renderAccounts();
        toast(data.result && data.result.ok ? '连通性正常：key 有效' : '连通性失败：' + ((data.result && data.result.error) || '未知原因'), !(data.result && data.result.ok));
      } finally {
        btn.disabled = false;
        btn.textContent = '测试连通性';
      }
    });
  }

  if (act === 'toggle') {
    return guard(async () => {
      await apiJSON('/api/admin/accounts/' + encodeURIComponent(id), { method: 'PATCH', body: { enabled: !account.enabled } });
      toast(account.enabled ? '账号已停用' : '账号已启用');
      await loadAccounts();
    });
  }

  if (act === 'rename') {
    renameTarget = id;
    $('r-sub').textContent = '账号「' + account.name + '」（keyId ' + shortId(id) + '）';
    $('r-name').value = account.name;
    $('r-err').textContent = '';
    openModal('m-rename');
    $('r-name').focus();
    return;
  }

  if (act === 'del') {
    if (!confirm('确定要删除账号「' + account.name + '」吗？\nkeyId ' + shortId(id) + '，该操作不可撤销。')) return;
    return guard(async () => {
      await apiJSON('/api/admin/accounts/' + encodeURIComponent(id), { method: 'DELETE' });
      testResults.delete(account.keyId);
      toast('账号已删除');
      await loadAccounts();
    });
  }
});

$('r-submit').onclick = () => guard(async () => {
  $('r-err').textContent = '';
  const name = $('r-name').value.trim();
  try {
    await apiJSON('/api/admin/accounts/' + encodeURIComponent(renameTarget), { method: 'PATCH', body: { name } });
  } catch (e) { $('r-err').textContent = e.message; return; }
  closeModal('m-rename');
  toast('备注已更新');
  await loadAccounts();
});

// ── 客户端 key 操作 ─────────────────────────────────────────────────
function resetNewKeyModal() {
  $('k-form').classList.remove('hidden');
  $('k-result').classList.add('hidden');
  $('k-err').textContent = '';
  $('k-warn').textContent = '';
  $('k-name').value = '';
  $('k-plain').textContent = '';
  $('k-submit').disabled = !state.writable;
  $('k-submit').classList.remove('hidden');
}
$('add-key').onclick = () => { resetNewKeyModal(); openModal('m-newkey'); $('k-name').focus(); };

$('k-submit').onclick = () => guard(async () => {
  $('k-err').textContent = '';
  const name = $('k-name').value.trim();
  let data;
  try {
    data = await apiJSON('/api/admin/keys', { method: 'POST', body: { name } });
  } catch (e) { $('k-err').textContent = e.message; return; }
  $('k-form').classList.add('hidden');
  $('k-result').classList.remove('hidden');
  $('k-submit').classList.add('hidden');
  $('k-plain').textContent = data.plaintext;
  $('k-warn').textContent = (data.warning || '此 key 只显示一次') + '，关闭后无法再次查看。';
  await loadKeys();
});

$('k-copy').onclick = async () => {
  const text = $('k-plain').textContent;
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制到剪贴板');
  } catch {
    const range = document.createRange();
    range.selectNodeContents($('k-plain'));
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    toast('已选中，请按 Ctrl/Cmd+C 复制');
  }
};

$('keys').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act="delkey"]');
  if (!btn) return;
  const id = btn.getAttribute('data-id');
  // 同上：只比前 8 字符会误删/误判另一个 keyId 相同的客户端 key。
  const k = state.keys.find((x) => String(x.keyId) === String(id));
  if (!k) return;
  if (!confirm('确定要删除客户端 key「' + k.name + '」吗？\n删除后该客户端会立刻 401。')) return;
  return guard(async () => {
    await apiJSON('/api/admin/keys/' + encodeURIComponent(id), { method: 'DELETE' });
    toast('客户端 key 已删除');
    await loadKeys();
  });
});

// ── 管理员操作 ──────────────────────────────────────────────────────
$('add-user').onclick = () => { $('u-err').textContent = ''; $('u-name').value = ''; $('u-pass').value = ''; openModal('m-user'); $('u-name').focus(); };
$('u-submit').onclick = () => guard(async () => {
  $('u-err').textContent = '';
  const username = $('u-name').value.trim();
  const password = $('u-pass').value;
  try {
    await apiJSON('/api/admin/users', { method: 'POST', body: { username, password } });
  } catch (e) { $('u-err').textContent = e.message; return; }
  closeModal('m-user');
  toast('管理员已创建');
  await loadUsers();
});

$('users').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn || btn.disabled) return;
  const name = btn.getAttribute('data-name');
  const act = btn.getAttribute('data-act');

  if (act === 'pass') {
    openPassModal(name);
    return;
  }

  if (act === 'deluser') {
    if (!confirm('确定要删除管理员「' + name + '」吗？\n删除后该账号无法登录后台。')) return;
    return guard(async () => {
      await apiJSON('/api/admin/users/' + encodeURIComponent(name), { method: 'DELETE' });
      toast('管理员已删除');
      await loadUsers();
    });
  }
});

$('p-submit').onclick = () => guard(async () => {
  $('p-err').textContent = '';
  const password = $('p-pass').value;
  if (!password) { $('p-err').textContent = '请输入新密码'; return; }
  const me = state.auth && state.auth.user ? state.auth.user.username : null;
  const isSelf = !!me && me === passTarget;
  const body = { password };
  if (!isSelf) {
    const currentPassword = $('p-current').value;
    if (!currentPassword) { $('p-err').textContent = '修改他人密码需要提供当前管理员密码'; return; }
    body.currentPassword = currentPassword;
  }
  try {
    await apiJSON('/api/admin/users/' + encodeURIComponent(passTarget), { method: 'PATCH', body });
  } catch (e) { $('p-err').textContent = e.message; return; }
  closeModal('m-pass');
  toast('密码已更新');
});

// ── 事件过滤 ────────────────────────────────────────────────────────
$('level').onchange = (e) => { state.level = e.target.value; loadEvents().catch((err) => toast(err.message, true)); };
$('reload-events').onclick = () => loadEvents().catch((err) => toast(err.message, true));
// ── 主题 ────────────────────────────────────────────────────────────
function storedTheme() {
  try { return localStorage.getItem(THEME_STORE) || ''; } catch { return ''; }
}
function prefersDark() { return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches); }
function currentTheme() { return document.documentElement.getAttribute('data-theme') || (prefersDark() ? 'dark' : 'light'); }
function setTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  try { localStorage.setItem(THEME_STORE, t); } catch { /* 忽略 */ }
}
$('theme').onclick = () => setTheme(currentTheme() === 'dark' ? 'light' : 'dark');
$('theme-gate').onclick = () => setTheme(currentTheme() === 'dark' ? 'light' : 'dark');

// ── 启动：先问 /api/auth/me 决定「初始化 / 登录 / 后台」─────────────
async function boot() {
  let me;
  try {
    const r = await fetch('/api/auth/me');
    me = await r.json();
  } catch (e) {
    showGate('login');
    gateError('无法连接服务：' + e.message);
    return;
  }
  state.auth = me;
  if (!me.authenticated) return showGate(me.setupRequired ? 'setup' : 'login');
  showAdmin();
  try {
    await loadAll();
  } catch (e) {
    showLoadError(e);   // loadAll 正常会自吞；这里兜底保证 boot 也绝不漏 rejection
  }
  if (!me.setupRequired && me.user && me.user.username) $('who').innerHTML = '已登录 <b>' + esc(me.user.username) + '</b>';
}

$('load-retry').onclick = () => boot().catch(showLoadError);

/** 启动：恢复主题 + 问 /api/auth/me + 运行日志轮询（原来的顶层启动语句）。 */
function start() {
  const savedTheme = storedTheme();
  if (savedTheme) document.documentElement.setAttribute('data-theme', savedTheme);
  boot().catch(showLoadError);
  setInterval(() => {
    if (!document.hidden && document.body.className !== 'gate') loadEvents().catch(() => {});
  }, 10000);
}
