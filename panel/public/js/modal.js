// ── 弹窗：打开 / 关闭 + 背景 inert + Tab 焦点陷阱 + Esc 焦点归还（B2-15 / B19）
let modalFocusReturn = null;
let modalFocusReturnKey = null;

// 打开弹窗前给「背景」（body 里除 .modal 外的所有元素）加 inert，
// 记下每个元素原本是否已有 inert，关闭时逐一还原。键盘 / 辅助技术都进不到背景。
const MODAL_INERT_PREV = new Map();
function modalBackgrounds() {
  const body = document.body;
  if (!body || !body.children) return [];
  const out = [];
  const push = (el) => {
    if (!el || el.nodeType !== 1) return;
    if (el.classList && el.classList.contains('modal')) return;
    // 容器里若装着弹窗（页壳 .page-shell / 后台抽屉 .drawer-content 都是），不能整块 inert：
    // inert 是可继承的，整块加下去会把弹窗一起冻住（焦点也进不去）。展开成子元素，弹窗自身仍被跳过。
    if (el.querySelector && el.querySelector('.modal')) {
      for (const inner of el.children) push(inner);
      return;
    }
    if (!out.includes(el)) out.push(el);
  };
  for (const child of body.children) push(child);
  // B24：抽屉布局把 #admin-head / #admin-main 放进了 .drawer-content，不再是 body 直接子节点；
  // 但它们仍是要 inert 的背景区，显式补上（inert 可叠加，重复设置无害）。
  for (const id of ['admin-head', 'admin-main']) push($(id));
  return out;
}
function setBackgroundInert(on) {
  if (on) {
    for (const el of modalBackgrounds()) {
      if (!MODAL_INERT_PREV.has(el)) MODAL_INERT_PREV.set(el, el.hasAttribute('inert'));
      el.setAttribute('inert', '');
    }
    return;
  }
  for (const [el, had] of MODAL_INERT_PREV) {
    if (had) el.setAttribute('inert', '');
    else el.removeAttribute('inert');
  }
  MODAL_INERT_PREV.clear();
}

/** 只把「真的可聚焦」的元素算进 Tab 循环：不依赖布局尺寸（测试垫片里恒为 0）。 */
function isFocusable(el) {
  if (!el || el.nodeType !== 1) return false;
  const tag = String(el.tagName || '').toLowerCase();
  const native = tag === 'a' || tag === 'button' || tag === 'input' || tag === 'select' || tag === 'textarea';
  const ti = el.getAttribute ? el.getAttribute('tabindex') : null;
  if (!native && ti === null) return false;
  if (el.disabled) return false;
  if (ti === '-1') return false;
  if (el.hidden) return false;
  if (tag === 'input' && el.getAttribute && el.getAttribute('type') === 'hidden') return false;
  if (el.closest && el.closest('.hidden, [hidden]')) return false;
  return true;
}
function dialogOf(modalEl) {
  if (!modalEl) return null;
  return (modalEl.querySelector && modalEl.querySelector('.dialog')) || modalEl;
}
function focusableIn(root) {
  if (!root || !root.querySelectorAll) return [];
  // 用 '*' 取全部后代再过滤：顺序严格按文档顺序（垫片的逗号选择器会按分组返回，不可依赖）。
  return Array.from(root.querySelectorAll('*')).filter(isFocusable);
}

function openModal(id) {
  // 打开前记下焦点，关闭时归还 —— 键盘 / 屏幕阅读器用户不会丢上下文。
  modalFocusReturn = document.activeElement && document.activeElement.focus ? document.activeElement : null;
  modalFocusReturnKey = modalFocusReturn && modalFocusReturn.getAttribute ? modalFocusReturn.getAttribute('data-focus-return') : null;
  const modal = $(id);
  modal.classList.add('open', 'modal-open');
  // aria-modal="true" 不能只是声明：把焦点移进弹窗（caller 可再聚焦到具体字段）。
  //
  // 顺序很关键：必须「先把焦点移进弹窗，再给背景加 inert」。
  // 反过来的话，浏览器发现 activeElement 落进了刚变 inert 的背景子树，会把它踢出去（回到 body），
  // 而这一步发生在我们 focus() 之后 → 正好盖掉弹窗内的焦点（实测 activeElement 停在 BODY）。
  // 先 focus 的话，加 inert 时 activeElement 已在弹窗里（弹窗不在背景区），不会被踢。
  const dialog = dialogOf(modal);
  const focusables = focusableIn(dialog);
  if (focusables.length && !(modal.contains && modal.contains(document.activeElement))) focusables[0].focus();
  setBackgroundInert(true);
}

/* 关闭弹窗后把焦点还回去：原节点还在就直接用；被轮询重建换掉了，就按 data-focus-return
   找替补 —— 同一标识在卡片视图与表格视图各有一份，只有一个是可见的，优先还给可见的那个
   （否则焦点会落到 display:none 的节点上，等于没还）。 */
function focusReturnTarget() {
  if (modalFocusReturn && modalFocusReturn.focus && modalFocusReturn.isConnected !== false) return modalFocusReturn;
  if (!modalFocusReturnKey) return null;
  const all = Array.from(document.querySelectorAll('[data-focus-return]'))
    .filter((el) => el.getAttribute('data-focus-return') === modalFocusReturnKey);
  return all.filter((el) => el.offsetParent !== null)[0] || all[0] || null;
}

function closeModal(id) {
  const modal = $(id);
  if (modal) modal.classList.remove('open', 'modal-open');
  if (document.querySelectorAll('.modal.open').length) return;   // 还有别的弹窗开着
  setBackgroundInert(false);
  const back = focusReturnTarget();
  if (back && back.focus) back.focus();
  modalFocusReturn = null;
  modalFocusReturnKey = null;
}

/** 一次性关掉全部弹窗并还原背景 inert（登出 / session 失效用，不归还焦点）。 */
function resetModalState() {
  for (const m of document.querySelectorAll('.modal')) m.classList.remove('open', 'modal-open');
  setBackgroundInert(false);
  modalFocusReturn = null;
  modalFocusReturnKey = null;
}

// Esc 关闭当前打开的弹窗（并归还焦点）
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const open = document.querySelectorAll('.modal.open');
  if (!open.length) return;
  for (const m of open) m.classList.remove('open', 'modal-open');
  setBackgroundInert(false);
  const back = focusReturnTarget();
  if (back && back.focus) back.focus();
  modalFocusReturn = null;
  modalFocusReturnKey = null;
});

// Tab / Shift+Tab 在打开的弹窗内循环（首尾回绕），焦点绝不走出 aria-modal。
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Tab') return;
  const open = document.querySelectorAll('.modal.open');
  if (!open.length) return;
  const active = document.activeElement;
  let dialog = null;
  for (const m of open) {
    if (m.contains && active && m.contains(active)) { dialog = dialogOf(m); break; }
  }
  if (!dialog) dialog = dialogOf(open[open.length - 1]);
  const focusables = focusableIn(dialog);
  if (!focusables.length) return;
  const idx = focusables.indexOf(active);
  const last = focusables.length - 1;
  if (e.shiftKey) {
    if (idx <= 0) { if (e.preventDefault) e.preventDefault(); focusables[last].focus(); }
  } else if (idx === last || idx === -1) {
    if (e.preventDefault) e.preventDefault();
    focusables[0].focus();
  }
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
  if (t && t.classList && t.classList.contains('modal')) closeModal(t.id);
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
