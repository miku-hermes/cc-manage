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
  if (!document.getElementById("m-detail")?.classList.contains("modal-open")) renderAccounts();
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
  state.dashboardPublic = data.dashboardPublic !== false;
  renderUsers();
  renderPublicNote();
}

/* 公开面板可见性提示：dashboardPublic=true 时任何访客都能看到账号数与额度快照，
   对「安全开关有没有关严」是个有价值的提醒；false（隐私模式）则隐藏提示。 */
function renderPublicNote() {
  const el = $('public-note');
  if (!el) return;
  if (state.dashboardPublic) {
    el.textContent = '当前公开面板对外可见（PUBLIC_DASHBOARD=1）：任何访客都能看到账号数量与额度快照。如需隐藏，请设 PUBLIC_DASHBOARD=0 后重启。';
    el.className = 'banner warn alert alert-warning';
  } else {
    el.textContent = '';
    el.className = 'banner warn alert alert-warning hidden';
  }
}
async function loadAll() {
  try {
    await loadAccounts();
    $('autherr').className = 'banner alert alert-error hidden';
    await Promise.all([loadKeys(), loadUsers(), loadEvents()]);
    clearLoadError();
    return true;
  } catch (e) {
    if (!e || e.status !== 401) showLoadError(e);
    return false;
  }
}

async function guard(fn) {
  try { await fn(); }
  catch (e) {
    if (e.status === 401) return;              // showGate 已在 apiJSON 里触发
    if (e.status === 403) { applyWritable(false, e.message); toast(e.message, true); return; }
    toast(e.message || '操作失败', true);
  }
}

// ── CC 账号：新增弹窗入口 + 表单提交（提交按钮保留 onclick，行为不变）──
function openAccountModal() { $('a-err').textContent = ''; openModal('m-account'); $('a-name').focus(); }
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

// ── CC 账号表：按钮走 #accounts 容器级委托，data-act / data-id 定位目标 ──
$('accounts').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn || btn.disabled) return;   // 只读置灰的按钮不得触发任何写操作
  const id = btn.getAttribute('data-id');
  // 必须比完整 keyId：shortId（前 8 字符）相同时会把操作作用到另一个账号上。
  const account = state.accounts.find((a) => String(a.keyId) === String(id));
  if (!account) return;
  const act = btn.getAttribute('data-act');

  if (act === 'detail') {
    const title = account.name || account.keyPrefix || '账号详情';
    fillAccountDetailBase(account);
    $('m-detail-test-result').textContent = '';
    $('m-detail-events').replaceChildren();
    openModal('m-detail', btn);
    apiJSON('/api/admin/events?limit=200').then((data) => {
      const matches = (data.events || []).filter((event) => String(event.message || '').includes(title) || String(event.message || '').includes(id));
      const list = $('m-detail-events');
      if (!matches.length) { const item = document.createElement('li'); item.textContent = '暂无相关日志'; list.appendChild(item); return; }
      for (const event of matches) { const item = document.createElement('li'); item.textContent = event.at + ' · ' + event.level + ' · ' + event.message; list.appendChild(item); }
    }).catch((error) => { $('m-detail-events').textContent = error.message; });
    $('m-detail-test').onclick = async (event) => {
      const button = event.currentTarget; button.disabled = true; button.textContent = '测试中…'; $('m-detail-test-result').textContent = '测试中…';
      try { const result = await apiJSON('/api/admin/accounts/test', { method:'POST', body:{ keyId:id } }); $('m-detail-test-result').textContent = result.result?.ok ? '连通性正常' : (result.result?.error || '测试失败'); }
      catch (error) { $('m-detail-test-result').textContent = error.message; }
      finally { button.disabled = false; button.textContent = '测试连通性'; }
    };
    return;
  }

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

// ── 改备注表单提交（提交按钮保留 onclick）────────────────────────────
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
function openNewKeyModal() { resetNewKeyModal(); openModal('m-newkey'); $('k-name').focus(); }

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

async function copyPlainKey() {
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
}

// ── 客户端 key 表：删除按钮走 #keys 容器级委托 ────────────────────────
$('keys').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act="delkey"]');
  if (!btn || btn.disabled) return;
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
function openUserModal() { $('u-err').textContent = ''; $('u-name').value = ''; $('u-pass').value = ''; openModal('m-user'); $('u-name').focus(); }
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

// ── 管理员表：改密码 / 删除走 #users 容器级委托 ────────────────────────
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

// ── 弹窗表单：Enter 提交 → submit 事件（按钮的 onclick 原样保留）──────
// 原生点击 <button type="submit"> 会先触发出 click（onclick 逻辑）再触发出 submit；
// 在 form 的 click 上 preventDefault，取消原生提交，避免同一个动作跑两遍。
const MODAL_FORMS = [
  ['m-account', 'a-submit'],
  ['m-rename', 'r-submit'],
  ['m-user', 'u-submit'],
  ['m-pass', 'p-submit'],
  ['m-newkey', 'k-submit'],
];
for (const [modalFormId, submitId] of MODAL_FORMS) {
  const modal = $(modalFormId);
  const form = modal && modal.querySelector('form');
  if (!form) continue;
  form.addEventListener('click', (e) => {
    const t = e && e.target;
    const btn = t && t.closest ? t.closest('button[type="submit"]') : null;
    if (btn && e.preventDefault) e.preventDefault();
  });
  form.addEventListener('submit', (e) => {
    if (e && e.preventDefault) e.preventDefault();
    const btn = $(submitId);
    if (btn && typeof btn.onclick === 'function') btn.onclick();
  });
}

// ── 工具条 / 弹窗入口 / 主题：document 级事件委托 ─────────────────────
// 不再逐个 $('x').onclick 直绑；用 data 属性 / 目标 id 定位，行为不变。
document.addEventListener('click', (e) => {
  const t = e.target;
  const closest = (sel) => (t && t.closest ? t.closest(sel) : null);
  if (closest('#add-account')) return openAccountModal();
  if (closest('#add-key')) return openNewKeyModal();
  if (closest('#add-user')) return openUserModal();
  if (closest('#k-copy')) return copyPlainKey();
  if (closest('#reload-events')) return loadEvents().catch((err) => toast(err.message, true));
  if (closest('#load-retry')) { boot().catch(showLoadError); return; }
  if (closest('#theme, #theme-gate')) setTheme(currentTheme() === 'dark' ? 'light' : 'dark');
});

// ── 事件过滤（#level）：change 走 document 级委托 ─────────────────────
document.addEventListener('change', (e) => {
  const t = e.target;
  if (!t || t.id !== 'level') return;
  state.level = t.value;
  loadEvents().catch((err) => toast(err.message, true));
});

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

/** 启动：恢复主题 + 问 /api/auth/me + 运行日志轮询（原来的顶层启动语句）。 */
function start() {
  const savedTheme = storedTheme();
  if (savedTheme) document.documentElement.setAttribute('data-theme', savedTheme);
  watchSystemTheme();                        // 未手动选择时跟随系统主题变化
  boot().catch(showLoadError);
  setInterval(() => {
    if (!document.hidden && document.body.className !== 'gate') loadEvents().catch(() => {});
  }, 10000);
}
