// ── 登录 / 初始化页 ─────────────────────────────────────────────────
/* 会话失效 / 登出：账号 keyPrefix、客户端 key、管理员、运行日志都不能留在 DOM 里。
   共享终端下 session 过期或点过「退出登录」后，F12 / 页面另存仍能读到这些内容。 */
/* 登出 / session 失效时必须清空的**输入**类敏感字段。
   清单必须覆盖所有会写残留信息的元素（b19 守护测试会扫描 app-admin.js / modal.js 的赋值目标）。 */
const SENSITIVE_VALUE_IDS = [
  'a-key', 'a-name',           // CC key 明文 + 备注名
  'u-name', 'u-pass',          // 新管理员用户名 / 密码
  'p-pass', 'p-current',       // 新密码 / 当前管理员密码
  'r-name', 'k-name',          // 改备注输入 / 客户端名称
  'ke-note', 'ke-expires', 'ke-quota-5h', 'ke-quota-day', 'ke-quota-week',
  'ke-maxconc', 'ke-ratemin',  // 客户端 key 治理编辑弹窗（备注 / 过期 / 额度 / 并发 / 速率）
];
/* 登出 / session 失效时必须清空的**文本**类字段：
   备注名 + keyId 片段（#r-sub）、管理员名（#p-sub）、一次性明文 key、报错原文。 */
const SENSITIVE_TEXT_IDS = [
  'r-sub', 'p-sub',
  'm-detail-title', 'm-detail-display', 'm-detail-error', 'm-detail-error-at',
  'm-detail-test-result', 'm-detail-events',
  'a-err', 'r-err', 'u-err', 'p-err', 'k-err', 'k-warn', 'k-plain',
  'ke-err', 'ke-sub',          // 治理编辑弹窗的报错 / 客户端名标题
];

function clearSensitiveData() {
  state.accounts = [];
  state.keys = [];
  state.users = [];
  state.events = [];
  // 请求日志页同样含客户端名 / 账号名 / 模型等业务数据，登出后不能留在 DOM 里。
  state.logs = [];
  state.logsHasMore = false;
  state.logsStats = { written: 0, dropped: 0, degraded: false };
  testResults.clear();
  for (const id of ['accounts', 'keys', 'users', 'events', 'logs']) $(id).innerHTML = '';
  for (const id of ['acc-count', 'key-count', 'user-count', 'event-count', 'logs-count']) $(id).textContent = '—';
  const dropped = $('logs-dropped');
  if (dropped) dropped.className = 'banner alert alert-error hidden';
  if (typeof renderLogsKeyOptions === 'function') renderLogsKeyOptions();   // 重建「全部客户端」占位
  const sideWho = $('side-who');
  if (sideWho) sideWho.textContent = '';
  // 弹窗里的一次性明文 key / 粘贴过的 CC key / 管理员密码框都不能留在 DOM 里：
  // 共享终端下「生成 key 后退出」或「弹窗开着时 session 401」会把这些内容暴露出去。
  // 同时复位 .modal.open（z-index 50 的遮罩会盖在登录页上，肉眼可见）并还原背景 inert。
  resetNewKeyModal();                       // 清 #k-plain / #k-name，复位 #k-form / #k-result
  for (const id of SENSITIVE_VALUE_IDS) { const el = $(id); if (el) el.value = ''; }
  for (const id of SENSITIVE_TEXT_IDS) { const el = $(id); if (el) el.textContent = ''; }
  resetModalState();
  renameTarget = null;
  passTarget = null;
  $('who').innerHTML = '';
}

function showGate(mode, me) {
  clearSensitiveData();
  state.mode = mode;
  document.body.className = 'gate';
  $('boot-loading').style.display = 'none';
  $('gate-head').style.display = '';
  $('gate-main').style.display = '';
  $('admin-head').style.display = 'none';
  $('admin-main').style.display = 'none';
  $('gate-err').className = 'gate-err alert alert-error hidden text-sm';
  const setup = mode === 'setup';
  $('gate-title').textContent = setup ? '初始化后台' : '登录后台';
  $('gate-sub').innerHTML = setup
    ? '还没有管理员账号（config/users.json 不存在或为空）。<br>设置第一个管理员后，初始化接口将永久关闭。'
    : '后台用账号 + 密码登录；<span class="mono">sk-cg-</span> 客户端 key 只管 API 调用，不能登录后台。';
  $('gate-pass2-field').style.display = setup ? '' : 'none';
  $('gate-submit').textContent = setup ? '创建管理员并登录' : '登录';
  $('gate-user').value = '';
  $('gate-pass').value = '';
  $('gate-pass2').value = '';
  $('gate-user').focus();
}

function showAdmin() {
  document.body.className = '';
  $('boot-loading').style.display = 'none';
  $('gate-head').style.display = 'none';
  $('gate-main').style.display = 'none';
  $('admin-head').style.display = '';
  $('admin-main').style.display = '';
  const u = state.auth && state.auth.user;
  $('who').innerHTML = u ? '已登录 <b>' + esc(u.username) + '</b>' : '';
  const sideWho = $('side-who');           // 侧边栏底部「当前管理员」
  if (sideWho) sideWho.textContent = u ? u.username : '';
}

function gateError(message) {
  const el = $('gate-err');
  el.textContent = message;
  el.className = 'gate-err alert alert-error text-sm';
}
function showLoadError(e) {
  const message = (e && e.message) || '未知错误';
  $('load-error-text').textContent = '数据加载失败：' + message + '，可点击「重试」恢复。';
  $('load-error').className = 'banner load-error alert alert-error';
}
function clearLoadError() {
  $('load-error-text').textContent = '';
  $('load-error').className = 'banner load-error alert alert-error hidden';
}
// ── 只读模式：把所有写按钮置灰并说明原因 ──────────────────────────────
function applyWritable(writable, reason) {
  state.writable = writable !== false;
  const locked = !state.writable;
  for (const id of ['add-account', 'add-key', 'k-submit', 'a-submit', 'r-submit', 'add-user', 'u-submit', 'p-submit']) {
    const el = $(id);
    if (el) { el.disabled = locked; el.title = locked ? (reason || '当前为只读模式') : ''; }
  }
  for (const btn of document.querySelectorAll('#accounts .actions button, #keys .actions button, #users .actions button')) {
    if (btn.getAttribute('data-act') === 'test') continue;   // 连通性测试是只读操作
    btn.disabled = locked;
  }
  $('readonly').textContent = locked ? (reason || '凭据以只读方式挂载，无法修改；请改用 config/ 目录挂载') : '';
  $('readonly').className = 'readonly text-sm ' + (locked ? 'warn text-warning' : 'hidden');
}
