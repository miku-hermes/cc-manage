const $ = (id) => document.getElementById(id);
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function num(n) { const v = Number(n); return Number.isFinite(v) ? v.toLocaleString('zh-CN') : '0'; }
// null / undefined / 空串都表示「没有数」，一律显示 —（Number(null)===0 会把「无快照」画成 0.00）。
function money(n) { if (n === null || n === undefined || n === '') return '—'; const v = Number(n); return Number.isFinite(v) ? v.toFixed(2) : '—'; }
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
function cls(p) { const v = Number(p); if (p === null || p === undefined || !Number.isFinite(v)) return 's-ok'; return v >= 90 ? 's-bad' : v >= 70 ? 's-warn' : 's-ok'; }
function timeText(ts) { const d = new Date(ts); return Number.isNaN(d.getTime()) ? '—' : d.toLocaleTimeString('zh-CN'); }

/* ── 额度快照新鲜度 ────────────────────────────────────────────────
   fetchedAt 是后端已经有的字段；这里只做本地相对时间换算，不额外发请求。
   阈值不写死：由后端 /api/status 的 quotaPoll.idleIntervalMs 决定（2 倍空闲间隔），
   这样把空闲间隔从 5 分钟调到 10 分钟也不会误报「过旧」。 */
const DEFAULT_STALE_MS = 20 * 60 * 1000;   // 拿不到配置时的兜底：2 × 10 分钟
let staleMs = DEFAULT_STALE_MS;
/** 按后端轮询配置更新阈值；非正数视为「轮询已关闭」，此时永不判过旧。 */
function setStaleFrom(status) {
  const idle = Number(status?.quotaPoll?.idleIntervalMs);
  staleMs = Number.isFinite(idle) && idle > 0 ? idle * 2 : Infinity;
}
/** 「快照过旧」的提示文案：阈值由后端配置算出，文案也必须跟着算，不能写死。 */
function staleText() {
  if (!Number.isFinite(staleMs) || staleMs <= 0) return '额度快照已超过较长时间未更新';
  const min = staleMs / 60000;
  const n = Number.isInteger(min) ? String(min) : min.toFixed(1);
  return min >= 1 ? '额度快照已超过 ' + n + ' 分钟未更新' : '额度快照已超过 ' + Math.round(staleMs / 1000) + ' 秒未更新';
}
function relText(ts, at = Date.now()) {
  const t = Number(ts);
  if (!Number.isFinite(t) || t <= 0) return null;
  const sec = Math.max(0, Math.round((at - t) / 1000));
  if (sec < 5) return '刚刚';
  if (sec < 60) return sec + ' 秒前';
  const min = Math.floor(sec / 60);
  if (min < 60) return min + ' 分钟前';
  const hour = Math.floor(min / 60);
  if (hour < 24) return hour + ' 小时前';
  return Math.floor(hour / 24) + ' 天前';
}

/**
 * 上游的 resetAt 是**秒**（后端 normalizeResetAt 归一化成秒），而页面其他
 * 时间戳（fetchedAt / pausedUntil）是**毫秒**。这里统一成毫秒再格式化：
 * 不去后端改是因为「秒」是写进契约的单位，页面自己适配更安全。
 * 小于 1e12 视为秒 —— 与后端 normalizeResetAt 同口径。
 */
function toMs(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return NaN;
  return n < 1e12 ? n * 1000 : n;
}

/** 距今还有多久（向前看）。用于「还有 5 天 22 小时重置」。 */
function untilText(ts, at = Date.now()) {
  const t = Number(ts);
  if (!Number.isFinite(t) || t <= 0) return null;
  let sec = Math.round((t - at) / 1000);
  if (sec <= 0) return '即将重置';
  if (sec < 60) return sec + ' 秒';
  const min = Math.floor(sec / 60);
  if (min < 60) return min + ' 分钟';
  const hour = Math.floor(min / 60);
  if (hour < 24) return hour + ' 小时 ' + (min % 60) + ' 分';
  const day = Math.floor(hour / 24);
  return day + ' 天 ' + (hour % 24) + ' 小时';
}

/** 「9/26 23:21」这种短日期，用于和倒计时并列显示。 */
function shortDate(ts) {
  const d = new Date(toMs(ts));
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

/**
 * 窗口重置文案。
 * resetAt 是上游给的真实时间戳：5h/周来自 windowLimits，月来自 currentPeriodEnd。
 * 5h 窗口在「还没开始用」时上游返回 0 —— 那不代表马上重置，而是首次调用后才起算，
 * 所以这里要单独说清楚，不能显示成「即将重置」。
 */
function resetText(w, { zeroMeansIdle = false } = {}) {
  const ts = toMs(w && w.resetAt);
  if (!Number.isFinite(ts) || ts <= 0) {
    return zeroMeansIdle ? '空闲中 · 首次使用后 5 小时重置' : '';
  }
  const abs = shortDate(ts);
  // 时间戳已是过去 → 窗口其实已经重置（上游快照没跟上）。不能再拼「（还有 即将重置）」，
  // 那会变成「重置于 9/22 19:51（还有 即将重置）」这种病句。
  if (ts <= Date.now()) return '重置于 ' + abs + ' · 窗口已重置，等待额度刷新';
  const until = untilText(ts);
  if (!until) return '';
  return '重置于 ' + abs + '（还有 ' + until + '）';
}
/** 把毫秒写成「1 分钟」这种话。 */
function fmtEvery(ms) {
  const s = Math.round(Number(ms) / 1000);
  if (!Number.isFinite(s) || s <= 0) return '';
  if (s < 60) return s + ' 秒';
  const m = s / 60;
  if (m < 60) return (Number.isInteger(m) ? m : m.toFixed(1)) + ' 分钟';
  const h = m / 60;
  return (Number.isInteger(h) ? h : h.toFixed(1)) + ' 小时';
}

/**
 * 额度刷新频率文案。由后端 /api/status 的 quotaPoll 驱动，不在页面里写死 ——
 * 有请求时用活跃间隔（更快），闲着时用空闲间隔。
 */
function cadenceText(p) {
  const idle = Number(p && p.idleIntervalMs);
  const active = Number(p && p.activeIntervalMs);
  const idleTxt = idle > 0 ? fmtEvery(idle) : '';
  const activeTxt = active > 0 ? fmtEvery(active) : '';
  if (!idleTxt && !activeTxt) return '';
  if (activeTxt && idleTxt && activeTxt !== idleTxt) {
    return '额度自动刷新：有请求时每 ' + activeTxt + '、空闲时每 ' + idleTxt;
  }
  return '额度自动刷新：每 ' + (activeTxt || idleTxt);
}

/** 该账号额度快照的展示文案 + 是否过旧（> 2 倍空闲间隔）。 */
function freshness(ts) {
  const t = Number(ts);
  if (!Number.isFinite(t) || t <= 0) return { text: '额度尚未同步', stale: false };
  const age = Date.now() - t;
  if (age >= staleMs) return { text: '额度更新于 ' + timeText(t), stale: true, age };
  return { text: '额度更新于 ' + relText(t), stale: false, age };
}
