// ── 登录门（gate）：登录 / 初始化提交 + Enter + 退出登录 ──────────────
// B2-1 契约：登出（以及 apiJSON 见到的 401）必须清掉一次性 key / 粘贴的 CC key /
// 密码框 / 弹窗，keyPrefix 不再留在 DOM —— 由 showGate → clearSensitiveData 保证。
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

/** 退出登录：清会话 + 回登录页（敏感 DOM 由 showGate → clearSensitiveData 负责）。 */
async function logout() {
  try { await apiJSON('/api/auth/logout', { method: 'POST' }); } catch { /* 忽略 */ }
  state.auth = null;
  showGate('login');
  toast('已退出登录');
}
// 退出按钮走事件委托：监听挂在 document，用 closest('#logout') 定位目标。
document.addEventListener('click', (e) => {
  const t = e.target;
  if (t && t.closest && t.closest('#logout')) logout().catch(() => {});
});
