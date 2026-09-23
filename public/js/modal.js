// ── 弹窗：打开 / 关闭 + Esc 焦点归还（B2-15）──────────────────────────
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
// [data-close] 关闭按钮：document 级委托，按目标属性定位要关的弹窗。
document.addEventListener('click', (e) => {
  const t = e.target;
  const btn = t && t.closest ? t.closest('[data-close]') : null;
  if (btn) closeModal(btn.getAttribute('data-close'));
});
// 点遮罩（.modal 自身，而非 .dialog 内部）关闭：同样是 document 级委托。
document.addEventListener('mousedown', (e) => {
  const t = e.target;
  if (t && t.classList && t.classList.contains('modal')) t.classList.remove('open');
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
