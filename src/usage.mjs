import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const number = (value) => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;

export function extractUsage(text) {
  const source = String(text ?? '');
  const find = (names) => {
    for (const name of names) {
      const match = source.match(new RegExp(`"${name}"\\s*:\\s*(\\d+)`, 'g'));
      if (match) {
        const values = match.map((item) => Number(item.match(/(\d+)$/)?.[1] ?? 0));
        if (values.length) return Math.max(...values);
      }
    }
    return 0;
  };
  let tokensIn = find(['prompt_tokens', 'input_tokens', 'promptTokens', 'inputTokens']);
  let tokensOut = find(['completion_tokens', 'output_tokens', 'completionTokens', 'outputTokens']);
  const total = find(['total_tokens', 'totalTokens']);
  if (!tokensIn && !tokensOut && total) tokensOut = total;
  return { tokensIn, tokensOut };
}

export function createUsageCollector({ maxBytes = 32768 } = {}) {
  let tail = Buffer.alloc(0);
  return {
    feed(text) {
      const next = Buffer.concat([tail, Buffer.from(String(text ?? ''))]);
      tail = next.subarray(Math.max(0, next.length - Math.max(0, maxBytes)));
    },
    finish() { return extractUsage(tail.toString('utf8')); },
  };
}

function dayName(time) {
  const date = new Date(time);
  const y = date.getFullYear();
  return `${y}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}.jsonl`;
}

export function createUsageRecorder(opts = {}) {
  const dir = path.resolve(opts.dir ?? 'data/reqlog');
  const enabled = opts.enabled !== false;
  const retentionDays = number(opts.retentionDays ?? 7);
  const maxFileBytes = number(opts.maxFileBytes ?? 32 * 1024 * 1024);
  const memoryTail = Math.max(0, number(opts.memoryTail ?? 500));
  let queue = Promise.resolve();
  let written = 0, dropped = 0, bytes = 0, scannedFiles = 0, degraded = false, warned = false, dirReady = false;
  const fileBytes = new Map();
  const tail = [];
  const warn = () => { if (!warned) { warned = true; opts.log?.warn?.('请求日志写入失败，已降级为内存缓冲'); } };
  const cleanup = () => {
    if (!retentionDays) return;
    let files;
    try { files = fs.readdirSync(dir); } catch { return; }
    const cutoff = Date.now() - retentionDays * 86400000;
    for (const file of files) {
      if (!/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(file)) continue;
      const stamp = Date.parse(`${file.slice(0, 10)}T00:00:00`);
      if (Number.isFinite(stamp) && stamp < cutoff) { try { fs.unlinkSync(path.join(dir, file)); } catch {} }
    }
  };
  if (enabled) cleanup();
  const timer = enabled && opts.noTimers !== true ? setInterval(cleanup, 86400000) : null;
  timer?.unref?.();
  function record(entry) {
    if (!enabled) return Promise.resolve();
    const safe = { t: number(entry?.t ?? Date.now()), dur: number(entry?.dur), keyId: entry?.keyId ?? null, keyName: entry?.keyName ?? null, accountKeyId: entry?.accountKeyId ?? null, accountName: entry?.accountName ?? null, model: entry?.model ?? null, path: entry?.path ?? null, status: number(entry?.status), stream: !!entry?.stream, tokensIn: number(entry?.tokensIn), tokensOut: number(entry?.tokensOut), ip: entry?.ip ?? null, error: entry?.error ?? null };
    tail.push(safe); if (tail.length > memoryTail) tail.shift();
    queue = queue.then(async () => {
      try {
        if (!dirReady) { fs.mkdirSync(dir, { recursive: true }); dirReady = true; }
        const file = path.join(dir, dayName(safe.t));
        if (!fileBytes.has(file)) fileBytes.set(file, fs.existsSync(file) ? fs.statSync(file).size : 0);
        const line = `${JSON.stringify(safe)}\n`;
        const length = Buffer.byteLength(line);
        if (fileBytes.get(file) + length > maxFileBytes) { dropped++; return; }
        await fs.promises.appendFile(file, line);
        fileBytes.set(file, fileBytes.get(file) + length); written++; bytes += length;
      } catch {
        dropped++; degraded = true; warn();
      }
    }).catch(() => { dropped++; degraded = true; warn(); });
    return queue;
  }
  function fileNames() { try { return fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort().reverse(); } catch { return []; } }
  async function* readEntries(sinceMs = 0) {
    for (const name of fileNames()) {
      const day = Date.parse(`${name.slice(0, 10)}T23:59:59.999`);
      if (Number.isFinite(day) && day < sinceMs) break;
      scannedFiles++;
      try {
        const input = fs.createReadStream(path.join(dir, name), { encoding: 'utf8' });
        const lines = readline.createInterface({ input, crlfDelay: Infinity });
        for await (const line of lines) { try { const item = JSON.parse(line); if (number(item.t) >= sinceMs) yield item; } catch {} }
      } catch {}
    }
  }
  const identity = (e) => `${e.t}\0${e.path}\0${e.status}`;
  return {
    record,
    async recent({ limit = 100, offset = 0, keyId, status, model, q } = {}) {
      await queue;
      const start = Math.max(0, number(offset)), size = Math.min(500, number(limit)), needed = start + size;
      const query = String(q ?? '').toLowerCase(), matched = [], seen = new Set();
      const accepts = (e) => (!keyId || e.keyId === keyId) && (!model || String(e.model ?? '').toLowerCase().includes(String(model).toLowerCase())) && (!status || (status === 'error' ? e.status >= 400 || e.error : !(e.status >= 400 || e.error))) && (!query || ['model', 'keyName', 'accountName', 'path'].some((k) => String(e[k] ?? '').toLowerCase().includes(query)));
      for await (const e of readEntries()) { seen.add(identity(e)); if (accepts(e)) matched.push(e); if (matched.length >= needed) break; }
      for (const e of [...tail].reverse()) if (!seen.has(identity(e)) && accepts(e)) matched.push(e);
      matched.sort((a, b) => number(b.t) - number(a.t));
      return { items: matched.slice(start, start + size), hasMore: matched.length > start + size };
    },
    /**
     * 按 key 聚合多个**滚动窗口**内的 token 总数（5h / 日 / 周额度判定用）。
     * 只从既有的请求日志（文件 + 内存 tail）读一次，不新造计数器存储。
     * @param {{now?: number, windows?: number[]}} opts windows = 各窗口时长（毫秒），
     *   返回 Map<keyId, number[]>（与 windows 顺序一一对应）。
     */
    async keyTokenWindows({ now = Date.now(), windows = [] } = {}) {
      await queue;
      const durations = windows.map((w) => number(w)).filter((w) => w > 0);
      const map = new Map();
      if (durations.length === 0) return map;
      const sinceMs = now - Math.max(...durations);
      const seen = new Set();
      const add = (e) => {
        const id = identity(e);
        if (seen.has(id)) return;
        seen.add(id);
        const t = number(e.t);
        if (t < sinceMs) return;
        const key = e.keyId ?? '';
        let row = map.get(key);
        if (!row) { row = new Array(durations.length).fill(0); map.set(key, row); }
        const tokens = number(e.tokensIn) + number(e.tokensOut);
        for (let i = 0; i < durations.length; i += 1) if (t >= now - durations[i]) row[i] += tokens;
      };
      for await (const e of readEntries(sinceMs)) add(e);
      for (const e of tail) add(e);
      return map;
    },
    async summary({ sinceMs = 0, bucketMs = 3600000 } = {}) {
      await queue;
      const totals = { requests: 0, errors: 0, tokensIn: 0, tokensOut: 0, durAvg: 0 };
      const groups = { byKey: new Map(), byModel: new Map(), byAccount: new Map(), series: new Map() };
      const seen = new Set();
      const aggregate = (e) => {
        if (seen.has(identity(e))) return; seen.add(identity(e));
        totals.requests++; const error = e.status >= 400 || !!e.error; if (error) totals.errors++;
        totals.tokensIn += number(e.tokensIn); totals.tokensOut += number(e.tokensOut); totals.durAvg += number(e.dur);
        const add = (map, key, base, withTokens = true) => { const g = map.get(key) ?? { ...base, requests: 0, errors: 0, tokensIn: 0, tokensOut: 0 }; g.requests++; if (error) g.errors++; if (withTokens) { g.tokensIn += number(e.tokensIn); g.tokensOut += number(e.tokensOut); } map.set(key, g); };
        add(groups.byKey, e.keyId ?? '', { keyId: e.keyId ?? null, keyName: e.keyName ?? null });
        add(groups.byModel, e.model ?? '(未知)', { model: e.model ?? '(未知)' });
        add(groups.byAccount, e.accountKeyId ?? '', { accountKeyId: e.accountKeyId ?? null, accountName: e.accountName ?? null }, false);
        const bucket = Math.floor(number(e.t) / bucketMs) * bucketMs; add(groups.series, bucket, { t: bucket });
      };
      for await (const e of readEntries(sinceMs)) aggregate(e);
      for (const e of tail) if (number(e.t) >= sinceMs) aggregate(e);
      totals.durAvg = totals.requests ? totals.durAvg / totals.requests : 0;
      const sort = (map) => [...map.values()].sort((a, b) => b.requests - a.requests);
      return { totals, byKey: sort(groups.byKey), byModel: sort(groups.byModel), byAccount: sort(groups.byAccount), series: [...groups.series.values()].sort((a, b) => a.t - b.t) };
    },
    stats() { return { written, dropped, bytes, scannedFiles, files: (() => { try { return fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).length; } catch { return 0; } })(), degraded }; },
    async close() { if (timer) clearInterval(timer); await queue; },
  };
}
