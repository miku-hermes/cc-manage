/* 审计日志页：只读展示管理员写操作台账（GET /api/admin/audit）。
   渲染走 <template id="tpl-audit-row"> 克隆 + textContent 填值（与 admin-logs.js 同一套做法），
   所有进 DOM 的动态文本一律 textContent / 节点 API，绝不手拼未转义的 innerHTML。
   取数时机与 admin-logs.js 相同：进审计页才拉，首屏不新增请求。 */
const AUDIT_LIMIT = 100;
const AUDIT_EMPTY_TEXT = '暂无审计记录';
const AUDIT_ALL_TEXT = '全部操作';

/** 详情：null/undefined → 「—」；对象 → 「键=值 · 键=值」人读文本；数组元素用「、」连接。 */
function auditDetailText(detail) {
  if (detail === null || detail === undefined) return '—';
  if (typeof detail !== 'object') return String(detail);
  const parts = [];
  for (const key of Object.keys(detail)) {
    const val = detail[key];
    let text;
    if (val === null || val === undefined) text = '';
    else if (Array.isArray(val)) text = val.map((v) => (v !== null && typeof v === 'object') ? JSON.stringify(v) : String(v)).join('、');
    else if (typeof val === 'object') text = JSON.stringify(val);
    else text = String(val);
    parts.push(key + '=' + text);
  }
  return parts.length ? parts.join(' · ') : '—';
}

/** 读取筛选条当前条件（每次请求实时读，避免与 DOM 脱节）。 */
function auditFilters() {
  const action = $('audit-action');
  const q = $('audit-q');
  return {
    action: action && action.value ? String(action.value).trim() : '',
    q: q && q.value ? String(q.value).trim() : '',
  };
}

function auditQuery(filters) {
  const parts = ['limit=' + AUDIT_LIMIT];
  if (filters.action) parts.push('action=' + encodeURIComponent(filters.action));
  if (filters.q) parts.push('q=' + encodeURIComponent(filters.q));
  return '/api/admin/audit?' + parts.join('&');
}

/** 一行审计记录 → <tr> 节点（克隆模板 + textContent，不拼 HTML 字符串）。 */
function auditRow(item) {
  const node = cloneTemplate('tpl-audit-row');
  if (!node) return null;
  fillText(node, 'time', logTime(item.t));
  fillText(node, 'actor', item.actor || '—');
  fillText(node, 'action', item.action || '—');
  fillText(node, 'target', item.target || '—');
  fillText(node, 'detail', auditDetailText(item.detail));
  fillText(node, 'ip', item.ip || '—');
  for (const el of node.querySelectorAll('[data-f]')) el.removeAttribute('data-f');
  return node;
}

/** 空态行 → <tr> 节点（复用 tpl-empty-row，colspan 改 6）。 */
function auditEmptyRow() {
  const node = cloneTemplate('tpl-empty-row');
  if (!node) return null;
  const td = field(node, 'empty');
  if (td) { td.setAttribute('colspan', '6'); td.textContent = AUDIT_EMPTY_TEXT; }
  for (const el of node.querySelectorAll('[data-f]')) el.removeAttribute('data-f');
  return node;
}

/** 下拉选项来自接口 actions，保留当前选中项；选项一律 createElement/textContent。 */
function renderAuditActions(actions) {
  const sel = $('audit-action');
  if (!sel) return;
  const current = sel.value;
  const frag = document.createDocumentFragment();
  const all = document.createElement('option');
  all.value = '';
  all.textContent = AUDIT_ALL_TEXT;
  frag.appendChild(all);
  for (const action of actions) {
    const opt = document.createElement('option');
    opt.value = String(action);
    opt.textContent = String(action);
    frag.appendChild(opt);
  }
  sel.replaceChildren(frag);
  sel.value = actions.includes(current) ? current : '';
}

/** 降级提示只在 stats.degraded === true 时可见（用 Tailwind hidden 开关，不写 CSS display）。 */
function renderAuditDegraded(stats) {
  const el = $('audit-degraded');
  if (!el) return;
  el.classList.toggle('hidden', !(stats && stats.degraded === true));
}

function renderAudit(data) {
  const items = Array.isArray(data && data.items) ? data.items : [];
  const actions = Array.isArray(data && data.actions) ? data.actions.map(String) : [];
  const count = $('audit-count');
  if (count) count.textContent = items.length + ' 条';
  renderAuditActions(actions);
  const body = $('audit-body');
  if (body) {
    const rows = items.map(auditRow).filter(Boolean);
    const empty = auditEmptyRow();
    body.replaceChildren(...(rows.length ? rows : (empty ? [empty] : [])));
  }
  renderAuditDegraded(data && data.stats);
}

let auditGeneration = 0;
async function loadAudit() {
  const generation = ++auditGeneration;
  const data = await apiJSON(auditQuery(auditFilters()));
  if (generation !== auditGeneration) return;   // 过期响应直接丢弃（同 loadLogs 的守卫）
  renderAudit(data);
}

/** 筛选条件变化 / 刷新按钮：重新取数（当前筛选）。 */
function reloadAudit() { return loadAudit(); }
