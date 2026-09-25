const $ = (id) => document.getElementById(id);
// 主题相关（THEME_STORE / storedTheme / setTheme）统一在 js/theme.js，前后台共用。
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function timeText(ts) { const d = new Date(ts); return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('zh-CN', { hour12: false }); }
/** 日志时间列短格式 HH:MM:SS（完整时间进 title，窄屏不再挤爆正文）。 */
function shortTime(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '—';
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}
/** 上游 resetAt 是秒（< 1e12），统一成毫秒再格式化。 */
function toMs(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return NaN;
  return n < 1e12 ? n * 1000 : n;
}
/** 「9/26 23:21」短日期，与前台 shortDate 同格式。 */
function shortDate(ts) {
  const d = new Date(toMs(ts));
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}
function shortId(id) { return String(id ?? '').slice(0, 8); }
function maskedKey(prefix) {
  return '<span class="key-mask font-mono"><span class="key-prefix">' + esc(prefix) + '</span>'
    + '<span class="key-hidden" title="key 其余部分已遮蔽" aria-label="key 其余部分已遮蔽">••••</span></span>';
}
// null / undefined 表示「没有数」（如无额度快照）→ —，不要把 null 画成 0.00。
function money(n) { if (n === null || n === undefined || n === '') return '—'; const v = Number(n); return Number.isFinite(v) ? v.toFixed(2) : '—'; }
/* 能用多少钱：与前台 usableRemaining 唯一口径完全一致。 */
function usableRemaining(a) {
  const q = a && a.lastQuota;
  if (!q || !Number.isFinite(q.remaining)) return 0;
  const k = a.exhausted && a.exhausted.kind;
  if (k === 'monthly' || k === 'balance') return 0;
  return q.remaining;
}
/* 套餐 planId → 人看的名字。映射表见任务书；未知值原样返回，不猜、不吞。 */
function planLabel(planId) {
  if (planId === null || planId === undefined) return null;
  const id = String(planId);
  if (id === '') return '';
  if (id.indexOf('teams') === 0) return '团队版';
  const NAMES = {
    'individual-go': 'Go 个人版 · $10/月',
    'individual-goat': 'GOAT 个人版',
    'individual-pro': 'Pro 个人版',
    'individual-pro-v1': 'Pro 个人版',
    'individual-max': 'Max 个人版',
  };
  return NAMES[id] ?? id;
}
function pctText(p) { const v = Number(p); return (p === null || p === undefined || !Number.isFinite(v)) ? '—' : v.toFixed(1) + '%'; }

/* ── B24：模板克隆工具（渲染不再手拼 HTML 字符串）──────────────────────
   行结构统一定义在 admin.astro 的 <template> 里，这里只克隆 + 用 textContent 填值。 */
function cloneTemplate(id) {
  const tpl = document.getElementById(id);
  if (!tpl || !tpl.content || !tpl.content.firstElementChild) return null;
  return tpl.content.firstElementChild.cloneNode(true);
}
function field(root, name) { return root.querySelector('[data-f="' + name + '"]'); }
function fillText(root, name, text) { const el = field(root, name); if (el) el.textContent = text == null ? '' : text; return el; }
function dropField(root, name) { const el = field(root, name); if (el) el.remove(); }
/** 去掉内部钩子（data-f 不进产出 DOM）后序列化一行。 */
function outerRow(node) {
  for (const el of node.querySelectorAll('[data-f]')) el.removeAttribute('data-f');
  return node.outerHTML;
}
/** 空态行：colspan + 一句真话（空态不撒谎）。 */
function emptyRow(colspan, text) {
  const node = cloneTemplate('tpl-empty-row');
  if (!node) return '';
  const td = field(node, 'empty');
  if (td) { td.setAttribute('colspan', String(colspan)); td.textContent = text; }
  return outerRow(node);
}
/** 空态单行（运行日志用）：根节点本身就是那一行。 */
function emptyLine(text) {
  const node = cloneTemplate('tpl-empty-line');
  if (!node) return '';
  node.textContent = text;
  node.removeAttribute('data-f');
  return node.outerHTML;
}

function toast(text, bad) {
  const el = $('toast');
  el.textContent = text;
  el.className = 'toast toast-end z-50 show' + (bad ? ' bad' : '');
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.className = 'toast toast-end z-50' + (bad ? ' bad' : ''); }, 3200);
}
