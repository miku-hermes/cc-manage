// 配置加载：config.json 默认值 + 环境变量覆盖
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_TRUSTED_PROXY_CIDRS } from './client-ip.mjs';

export const DEFAULTS = {
  gatewayPort: 3051,
  gatewayHost: '127.0.0.1',
  upstreamProxyUrl: 'http://127.0.0.1:3050',
  ccApiBase: 'https://api.commandcode.ai',
  // 额度轮询：空闲间隔（<=0 → 完全关闭轮询）
  quotaPollIntervalMs: 600000,
  // 活跃间隔：最近 quotaActiveWindowMs 内有代理请求时改用这个间隔（<=0 → 退化为纯空闲间隔）
  quotaActivePollIntervalMs: 60000,
  // 判定「正在被使用」的时间窗
  quotaActiveWindowMs: 300000,
  pausedRecheckIntervalMs: 60000,
  quotaTimeoutMs: 15000,
  // 转到上游的请求超时（proxy.mjs 读取；缺省 5 分钟）。此前只在 proxy.mjs 里有 ?? 300000 兜底，
  // DEFAULTS / ENV_MAP 都没有它 —— 改了不生效也不报错，这里补齐。
  upstreamTimeoutMs: 300000,
  // 余额见底时的主动探针：余额低于 creditsProbeBelowUsd（或上游 belowThreshold=true）
  // 就打一发 max_tokens=1 的最小推理，用上游的回答判定账号还能不能用。
  // 阈值只决定「什么时候去问」，不决定结论 —— 上游的余额规则不公开，自己拍阈值会误判。
  // 不满足条件时一次都不打，命中后立刻记标记，因此开销可忽略。
  creditsProbeEnabled: true,
  creditsProbeBelowUsd: 1.0,
  // 或低于「本周期额度」的这个比例（官方 Go $10 / Max 20× $300，固定金额不够用）
  creditsProbeBelowRatio: 0.02,
  creditsProbeModel: 'deepseek/deepseek-v4-flash',
  creditsProbeTimeoutMs: 20000,
  // 探针 TTL（B2）：同一账号两次探针的最小间隔。低于阈值但**仍可用**的账号
  // （大套餐 belowThreshold、余额低于 2% 周期）原本每轮都重探，活跃期 60s 一次 = 1440 次推理/天，
  // 全记在该账号账单上；正常账号一次都不打的短路保留。
  creditsProbeTtlMs: 10 * 60 * 1000,
  // 探针自身失败（超时/套餐不含该模型/5xx/429）时的指数退避上限（B2）：1×→2×→4× TTL…
  creditsProbeFailBackoffMaxMs: 60 * 60 * 1000,
  sessionAffinityTtlMs: 1800000,
  // 登录尝试令牌桶（审查#3）：每来源每分钟最多多少次「真的要算 scrypt」的登录尝试，**不看用户名**。
  // 轮换用户名刷登录会被同一个桶挡住；用户名锁定（5 次连错）仍然单独生效。
  loginAttemptsPerMinute: 60,
  // H2：进程级全局登录尝试上限（每分钟）。任何来源构造都绕不过；0 = 用 loginAttemptsPerMinute×10。
  loginGlobalAttemptsPerMinute: 0,
  // 可信反代来源（审查 A5）：只有 TCP 来源落在这些网段内才采信 x-forwarded-for /
  // x-real-ip，按真实客户端分桶限速；否则忽略代理头，回落 socket 地址（防伪造）。
  trustedProxyCidrs: [...DEFAULT_TRUSTED_PROXY_CIDRS],
  allowPassthrough: false,
  // 请求体上限（F18）：每个在途请求都会把 body tee 进内存供换号重放，
  // 20MB × 并发会直接吃掉容器 256m 的额度。收到 8MB，够放长 prompt。
  maxBodyBytes: 8 * 1024 * 1024,
  // 在途请求上限（F18）：对照内核的 CC_MAX_INFLIGHT=8
  maxInflight: 8,
  // 后端-M5：网关自身 keep-alive/headers 超时。Node 默认 5s，反代（openresty）upstream
  // keepalive 大于它时会复用到后端已关的连接 → POST EPIPE → 502。抬到 65s（内核同款）。
  keepAliveTimeoutMs: 65000,
  headersTimeoutMs: 66000,
  // L5：peekBody 等待**首块 body 数据**的起始超时。慢速/挂起连接不能无限占住 socket。
  bodyPeekStartMs: 10000,
  // 前台只读面板（/ 与 /api/status）是否公开。默认 1 = 公开（只暴露账号名/keyId/keyPrefix/额度百分比，
  // 没有完整 key）；设 0 → 需要后台登录 session 才能看。
  publicDashboard: true,
  // 已废弃：旧版「面板接口是否要求本地 key」。为兼容老部署保留，
  // 置 true 时面板读接口接受 sk-cg- key，等价于关闭公开面板；新部署请用 PUBLIC_DASHBOARD=0。
  protectAdminApi: false,
  logLevel: 'info',
  logFile: '',
};

const ENV_MAP = {
  GATEWAY_PORT: ['gatewayPort', 'number'],
  GATEWAY_HOST: ['gatewayHost', 'string'],
  UPSTREAM_PROXY_URL: ['upstreamProxyUrl', 'string'],
  CC_API_BASE: ['ccApiBase', 'string'],
  QUOTA_POLL_INTERVAL_MS: ['quotaPollIntervalMs', 'number'],
  QUOTA_ACTIVE_POLL_INTERVAL_MS: ['quotaActivePollIntervalMs', 'number'],
  QUOTA_ACTIVE_WINDOW_MS: ['quotaActiveWindowMs', 'number'],
  PAUSED_RECHECK_INTERVAL_MS: ['pausedRecheckIntervalMs', 'number'],
  QUOTA_TIMEOUT_MS: ['quotaTimeoutMs', 'number'],
  UPSTREAM_TIMEOUT_MS: ['upstreamTimeoutMs', 'number'],
  CREDITS_PROBE_ENABLED: ['creditsProbeEnabled', 'boolean'],
  CREDITS_PROBE_BELOW_USD: ['creditsProbeBelowUsd', 'number'],
  CREDITS_PROBE_BELOW_RATIO: ['creditsProbeBelowRatio', 'number'],
  CREDITS_PROBE_MODEL: ['creditsProbeModel', 'string'],
  CREDITS_PROBE_TIMEOUT_MS: ['creditsProbeTimeoutMs', 'number'],
  CREDITS_PROBE_TTL_MS: ['creditsProbeTtlMs', 'number'],
  CREDITS_PROBE_FAIL_BACKOFF_MAX_MS: ['creditsProbeFailBackoffMaxMs', 'number'],
  SESSION_AFFINITY_TTL_MS: ['sessionAffinityTtlMs', 'number'],
  LOGIN_ATTEMPTS_PER_MINUTE: ['loginAttemptsPerMinute', 'number'],
  LOGIN_GLOBAL_ATTEMPTS_PER_MINUTE: ['loginGlobalAttemptsPerMinute', 'number'],
  TRUSTED_PROXY_CIDRS: ['trustedProxyCidrs', 'list'],
  MAX_BODY_BYTES: ['maxBodyBytes', 'number'],
  MAX_INFLIGHT: ['maxInflight', 'number'],
  KEEPALIVE_TIMEOUT_MS: ['keepAliveTimeoutMs', 'number'],
  HEADERS_TIMEOUT_MS: ['headersTimeoutMs', 'number'],
  BODY_PEEK_START_MS: ['bodyPeekStartMs', 'number'],
  ALLOW_PASSTHROUGH: ['allowPassthrough', 'boolean'],
  PUBLIC_DASHBOARD: ['publicDashboard', 'boolean'],
  PROTECT_ADMIN_API: ['protectAdminApi', 'boolean'],
  LOG_FILE: ['logFile', 'string'],
  LOG_LEVEL: ['logLevel', 'string'],
};

function coerce(value, type) {
  if (type === 'number') {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  if (type === 'boolean') {
    return value === '1' || value === 'true' || value === 'yes' || value === 'on';
  }
  if (type === 'list') {
    return String(value).split(',').map((x) => x.trim()).filter(Boolean);
  }
  return String(value);
}

/** field → 期望类型（复用 ENV_MAP 的类型信息，env 与 config.json 走同一套规则）。 */
const FIELD_TYPE = Object.fromEntries(Object.values(ENV_MAP).map(([field, type]) => [field, type]));
/** DEFAULTS 里出现的合法配置键；不在其中且出现在 config.json 的键一律 warn 并忽略。 */
const KNOWN_FIELDS = new Set(Object.keys(DEFAULTS));

/**
 * 安全开关（M1）：这些键在 config.json 里给错类型会被**静默绕过** ——
 * gateway 用严格比较（`config.publicDashboard !== false`）判定，字符串 "false" 不等于布尔 false，
 * 于是以为关了面板其实还开着。这里对它们做严格校验：只接受布尔或可无歧义解析的布尔字面量，
 * 其余（数字 / 对象 / 数组 / 无法识别的字符串）直接拒绝启动。
 */
const SECURITY_BOOL_FIELDS = new Set(['publicDashboard', 'protectAdminApi', 'allowPassthrough', 'creditsProbeEnabled']);
const BOOL_LITERALS = new Set(['1', '0', 'true', 'false', 'yes', 'no', 'on', 'off']);

/**
 * config.json 的取值归一（M1）：与 env 路径同一套类型规则（boolean/number/string/list），
 * 让 `"false"`（字符串）也能解析成布尔 false。返回 undefined 表示「类型不匹配 / 无法解析」，
 * 由调用方决定是拒绝启动（安全开关）还是 warn + 忽略（普通键）。
 */
function coerceConfigValue(value, type) {
  // 字符串输入直接复用 env 的 coerce()，保证两条路径行为完全一致。
  if (typeof value === 'string') {
    if (type === 'boolean') {
      const v = value.trim().toLowerCase();
      if (!BOOL_LITERALS.has(v)) return undefined;
      return coerce(v, 'boolean');
    }
    return coerce(value, type);
  }
  if (type === 'boolean') return typeof value === 'boolean' ? value : undefined;
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  if (type === 'list') {
    if (!Array.isArray(value)) return undefined;
    return value.map((x) => String(x).trim()).filter(Boolean);
  }
  // string：只接受标量，对象/数组明确拒绝（避免 [object Object] 混进配置）。
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

/** 报错/告警里的人类可读类型描述。 */
function describeValue(value) {
  if (Array.isArray(value)) return `array(${JSON.stringify(value)})`;
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'string' || t === 'number' || t === 'boolean') return `${t}(${JSON.stringify(value)})`;
  return t;
}

// 挂 warnings 的弱表：不往 cfg 上塞可枚举字段（否则会被 `{ ...cfg }` 带进运行期配置）。
const CONFIG_WARNINGS = new WeakMap();

/** 取 loadConfig() 收集到的 config.json 告警（未知键 / 无法解析的值），供启动时打印。 */
export function configWarnings(cfg) {
  return CONFIG_WARNINGS.get(cfg) ?? [];
}

/**
 * 加载配置。configPath 为空 / 文件不存在时全部走默认值。
 *
 * M1：config.json 的值不再**原样**塞进 cfg —— 复用 ENV_MAP 的类型信息做归一，
 * 与 env 路径同一套规则（boolean/number/string/list）。否则 `"publicDashboard": "false"`
 * 这种字符串会因 `!== false` 的严格比较让安全开关「以为关了其实没关」。
 *  - 未知键（拼错的键）收集成 warn 列表（configWarnings()），绝不静默并进 cfg；
 *  - 安全开关（publicDashboard / protectAdminApi / allowPassthrough / creditsProbeEnabled）
 *    收到非布尔且无法无歧义解析的值 → 直接抛错拒绝启动；
 *  - 普通键类型不匹配 → warn + 保持默认值。
 * opts.log 提供时，告警同时即时打印。
 */
export function loadConfig(configPath = path.resolve('config.json'), env = process.env, opts = {}) {
  const cfg = { ...DEFAULTS };
  const warnings = [];
  const warn = (msg) => {
    warnings.push(msg);
    opts?.log?.warn?.(msg);
  };
  if (configPath && fs.existsSync(configPath)) {
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (e) {
      throw new Error(`config.json 解析失败: ${e.message}`);
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('config.json 顶层必须是对象（JSON object），当前不是');
    }
    for (const [k, v] of Object.entries(raw)) {
      if (v === undefined || v === null) continue;
      if (!KNOWN_FIELDS.has(k)) {
        warn(`config.json 含未知配置键 "${k}"（已忽略）；请检查拼写，合法键见 config.example.json`);
        continue;
      }
      const type = FIELD_TYPE[k] ?? 'string';
      const coerced = coerceConfigValue(v, type);
      if (coerced === undefined) {
        const desc = describeValue(v);
        if (SECURITY_BOOL_FIELDS.has(k)) {
          throw new Error(
            `config.json 的 "${k}" 类型不合法：期望 boolean（true/false，或可识别的 "true"/"false"/"1"/"0"），`
            + `收到 ${desc}。安全开关不接受非布尔值 —— 否则会被静默绕过。`,
          );
        }
        warn(`config.json 的 "${k}" 无法按 ${type} 解析（收到 ${desc}），已忽略并保持默认值`);
        continue;
      }
      cfg[k] = coerced;
    }
  }
  for (const [envKey, [field, type]] of Object.entries(ENV_MAP)) {
    const raw = env[envKey];
    if (raw === undefined || raw === '') continue;
    const v = coerce(raw, type);
    if (v !== undefined) cfg[field] = v;
  }
  cfg.upstreamProxyUrl = String(cfg.upstreamProxyUrl).replace(/\/+$/, '');
  cfg.ccApiBase = String(cfg.ccApiBase).replace(/\/+$/, '');
  CONFIG_WARNINGS.set(cfg, warnings);
  return cfg;
}
