// 历史趋势环形缓冲：近 24 小时的请求 / 错误 / token 增量 + 可用账号数 / 可用余额快照。
//
// 采集口径（与 store 的 state.stats 对接）：
//   - requests / errors / tokens 是**累计计数器**（stats.total / stats.errors / stats.totalTokens），
//     每次 record() 与上一次做差，把**增量**累加到当前桶；
//   - available / remaining 是**当次快照值**，直接覆盖当前桶。
//
// 为什么要有「首次调用只建基线」：网关重启后 stats 会从落盘值恢复，但进程刚起来时
// 那次 record 不能把「启动前累积的所有请求」一次性记成一个爆发点。因此第一次 record
// 只记基线、增量为 0；计数器回退（stats 归零）时增量按 0 处理，绝不出现负数。
//
// 样本字段名刻意压短（每次落盘都要写整个数组）：
//   t = 桶起始 ms；r = 桶内请求增量；e = 桶内错误增量；k = 桶内 token 增量；
//   a = 样本时可用账号数；m = 样本时可用余额合计（USD，保留 2 位小数）。

export const HISTORY_BUCKET_MS = 5 * 60 * 1000;   // 5 分钟一个样本
export const HISTORY_MAX_SAMPLES = 288;           // 288 × 5min = 24 小时
export const HISTORY_TICK_MS = 60 * 1000;         // 采样节奏

const SAMPLE_FIELDS = ['t', 'r', 'e', 'k', 'a', 'm'];

/** 空历史：初始化 / 坏形状回退都用它，每次返回新对象。 */
export function blankHistory() {
  return { samples: [], last: null };
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * 规范化单个样本：必须是对象，且 t/r/e/k/a/m 六个字段都是有限数字，
 * 任一缺失或非法 → 整条丢弃（返回 null），绝不把半条脏数据塞进数组。
 */
function normalizeSample(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  for (const field of SAMPLE_FIELDS) {
    const n = Number(raw[field]);
    if (!Number.isFinite(n)) return null;
    out[field] = n;
  }
  return out;
}

/**
 * 把任意来源（老 state.json / 手改文件 / 垃圾数据）的 history 规范化。
 * 坏形状一律丢弃 → blankHistory()，**绝不抛** —— state.json 只是可丢弃缓存，
 * 读它绝不能阻塞网关启动。
 */
export function normalizeHistory(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return blankHistory();
  if (!Array.isArray(raw.samples)) return blankHistory();
  const samples = [];
  for (const item of raw.samples) {
    const sample = normalizeSample(item);
    if (sample) samples.push(sample);
  }
  // 超限的历史（手改 / 旧版本）只保留最新的一段，长度不超过环形上限。
  return { samples: samples.slice(-HISTORY_MAX_SAMPLES), last: null };
}

/**
 * 创建历史缓冲。
 * @param {{state?: object, now?: () => number}} [opts]
 *   state 是 store 的 state 对象，history 会挂在 state.history 上（落盘即读它）。
 *   now 可注入，便于测试驱动跨桶 / 定稿。
 */
export function createHistory({ state, now = Date.now } = {}) {
  const host = (state && typeof state === 'object') ? state : {};
  let hist = normalizeHistory(host.history);
  host.history = hist;

  let last = null;        // 上一次 record 的累计计数器快照
  let current = null;     // 当前尚未定稿的桶

  /** 从 state.history（可能来自老 state.json，字段缺失 / 形状不对）恢复；坏的整条丢弃。 */
  function load() {
    hist = normalizeHistory(host.history);
    host.history = hist;
    last = null;
    current = null;
    return hist;
  }

  /**
   * 记录一次采样。
   * @param {{requests?: number, errors?: number, tokens?: number, available?: number, remaining?: number}} input
   * @returns {{rolled: boolean}} rolled = 本次是否把一个桶定稿进 samples（供调用方决定落盘）。
   */
  function record(input = {}) {
    const bucketStart = Math.floor(now() / HISTORY_BUCKET_MS) * HISTORY_BUCKET_MS;
    const counters = {
      requests: num(input.requests),
      errors: num(input.errors),
      tokens: num(input.tokens),
    };

    // 增量：首次调用（没有 last）建基线，记 0；计数器回退（重启归零）也记 0。
    function delta(cur, prev) {
      if (last === null) return 0;
      const d = cur - prev;
      return d > 0 ? d : 0;
    }
    const dReq = delta(counters.requests, num(last?.requests));
    const dErr = delta(counters.errors, num(last?.errors));
    const dTok = delta(counters.tokens, num(last?.tokens));

    const avail = num(input.available);
    const remaining = Math.round(num(input.remaining) * 100) / 100;

    let rolled = false;
    if (current === null || current.t !== bucketStart) {
      if (current !== null) {
        hist.samples.push(current);   // 上一桶定稿
        while (hist.samples.length > HISTORY_MAX_SAMPLES) hist.samples.shift();
        rolled = true;
      }
      current = { t: bucketStart, r: dReq, e: dErr, k: dTok, a: avail, m: remaining };
    } else {
      current.r += dReq;
      current.e += dErr;
      current.k += dTok;
      current.a = avail;
      current.m = remaining;
    }

    last = counters;
    return { rolled };
  }

  /** 样本数组的**深拷贝**：调用方改不动内部状态。 */
  function samples() {
    return hist.samples.map((s) => ({ ...s }));
  }

  /** 可直接塞进 state.json 的形状。 */
  function toJSON() {
    return { samples: hist.samples.map((s) => ({ ...s })) };
  }

  return { record, samples, toJSON, load, recover: load };
}
