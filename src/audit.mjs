import fs from 'node:fs';
import path from 'node:path';

// 审计台账录制器：把后台管理员写操作留成结构化记录（谁 / 何时 / 从哪 / 对什么 / 改了什么）。
// 与 src/usage.mjs 的 createUsageRecorder 同款做法：内存环形 tail 供只读 API 即时查，
// 磁盘按天 JSONL 供事后追溯；写盘串行化、单文件超限即丢、任何 fs 错误都降级不抛。

const number = (value) => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
/** 控制字符（换行 / 制表符 / 0x00-0x1f 与 0x7f）：进台账前一律剥掉，防伪造台账行。 */
const CONTROL_RE = /[\u0000-\u001f\u007f]/g;
const cleanText = (value, max = 512) => (typeof value === 'string'
  ? value.replace(CONTROL_RE, '').slice(0, max)
  : (value == null ? null : String(value).replace(CONTROL_RE, '').slice(0, max)));

function dayName(time) {
  const date = new Date(time);
  const y = date.getFullYear();
  return `audit-${y}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}.jsonl`;
}

/** detail 必须是 JSON 安全的普通对象或数组（§A：字段名列表天生是数组）；否则归一为 null。 */
function cleanDetail(detail) {
  if (!detail || typeof detail !== 'object') return null;
  try { return JSON.parse(JSON.stringify(detail)); } catch { return null; }
}

export function createAuditLog(opts = {}) {
  const dir = path.resolve(opts.dir ?? 'data/audit');
  const retainDays = number(opts.retainDays ?? 30);
  const maxFileBytes = number(opts.maxFileBytes ?? 4 * 1024 * 1024);
  const memoryTail = Math.max(0, number(opts.memoryTail ?? 500));
  let queue = Promise.resolve();
  let written = 0, dropped = 0, degraded = false, warned = false, dirReady = false;
  const fileBytes = new Map();
  const tail = [];
  const actionsSeen = new Set();
  const warn = () => { if (!warned) { warned = true; opts.log?.warn?.('审计台账写入失败，已降级（只保留内存记录）'); } };

  const cleanup = () => {
    if (!retainDays) return;
    let files;
    try { files = fs.readdirSync(dir); } catch { return; }
    const cutoff = Date.now() - retainDays * 86400000;
    for (const file of files) {
      const m = /^audit-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(file);
      if (!m) continue;
      const stamp = Date.parse(`${m[1]}T00:00:00`);
      if (Number.isFinite(stamp) && stamp < cutoff) { try { fs.unlinkSync(path.join(dir, file)); } catch {} }
    }
  };
  cleanup();
  let timer = opts.noTimers === true ? null : setInterval(cleanup, 86400000);
  timer?.unref?.();

  /** 白名单归一：只保留 t / actor / action / target / detail / ip 六个字段。 */
  function normalize(entry) {
    const t = Number.isFinite(Number(entry?.t)) ? Math.max(0, Number(entry.t)) : Date.now();
    return {
      t,
      actor: cleanText(entry?.actor ?? null, 200),
      action: cleanText(entry?.action ?? null, 120),
      target: cleanText(entry?.target ?? null, 200),
      detail: cleanDetail(entry?.detail),
      ip: cleanText(entry?.ip ?? null, 64),
    };
  }

  function record(entry) {
    const safe = normalize(entry);
    if (safe.action) actionsSeen.add(safe.action);
    tail.push(safe);
    while (tail.length > memoryTail) tail.shift();
    queue = queue.then(async () => {
      try {
        if (!dirReady) { fs.mkdirSync(dir, { recursive: true }); dirReady = true; }
        const file = path.join(dir, dayName(safe.t));
        if (!fileBytes.has(file)) fileBytes.set(file, fs.existsSync(file) ? fs.statSync(file).size : 0);
        const line = `${JSON.stringify(safe)}\n`;
        const length = Buffer.byteLength(line);
        if (fileBytes.get(file) + length > maxFileBytes) { dropped++; return; }
        await fs.promises.appendFile(file, line);
        fileBytes.set(file, fileBytes.get(file) + length);
        written++;
      } catch {
        dropped++; degraded = true; warn();
      }
    }).catch(() => { dropped++; degraded = true; warn(); });
    return queue;
  }

  const hay = (e) => [e.actor, e.action, e.target, e.detail == null ? '' : JSON.stringify(e.detail)]
    .map((v) => String(v ?? '')).join('\u0000').toLowerCase();

  return {
    record,
    /** 只读内存 tail（不读盘）：过滤后倒序（最新在前）。 */
    list({ limit = 100, offset = 0, action, actor, q } = {}) {
      const size = Math.min(500, Math.max(1, Number.isFinite(Number(limit)) ? Number(limit) : 100));
      const start = number(offset);
      const query = String(q ?? '').toLowerCase();
      const matched = tail.filter((e) => {
        if (action && e.action !== action) return false;
        if (actor && e.actor !== actor) return false;
        if (query && !hay(e).includes(query)) return false;
        return true;
      });
      matched.reverse();
      return { total: matched.length, items: matched.slice(start, start + size) };
    },
    /** 本次运行见过的 action 去重数组（前端筛选用）。 */
    actions() { return [...actionsSeen]; },
    stats() {
      let files = 0;
      try { files = fs.readdirSync(dir).filter((f) => /^audit-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).length; } catch {}
      return { written, dropped, degraded, files };
    },
    async close() { if (timer) { clearInterval(timer); timer = null; } await queue; },
  };
}
