// 配置加载：config.json 默认值 + 环境变量覆盖
import fs from 'node:fs';
import path from 'node:path';

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
  sessionAffinityTtlMs: 1800000,
  // 登录尝试令牌桶（审查#3）：每来源每分钟最多多少次「真的要算 scrypt」的登录尝试，**不看用户名**。
  // 轮换用户名刷登录会被同一个桶挡住；用户名锁定（5 次连错）仍然单独生效。
  loginAttemptsPerMinute: 60,
  allowPassthrough: false,
  // 请求体上限（F18）：每个在途请求都会把 body tee 进内存供换号重放，
  // 20MB × 并发会直接吃掉容器 256m 的额度。收到 8MB，够放长 prompt。
  maxBodyBytes: 8 * 1024 * 1024,
  // 在途请求上限（F18）：对照内核的 CC_MAX_INFLIGHT=8
  maxInflight: 8,
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
  CREDITS_PROBE_ENABLED: ['creditsProbeEnabled', 'boolean'],
  CREDITS_PROBE_BELOW_USD: ['creditsProbeBelowUsd', 'number'],
  CREDITS_PROBE_BELOW_RATIO: ['creditsProbeBelowRatio', 'number'],
  CREDITS_PROBE_MODEL: ['creditsProbeModel', 'string'],
  CREDITS_PROBE_TIMEOUT_MS: ['creditsProbeTimeoutMs', 'number'],
  SESSION_AFFINITY_TTL_MS: ['sessionAffinityTtlMs', 'number'],
  LOGIN_ATTEMPTS_PER_MINUTE: ['loginAttemptsPerMinute', 'number'],
  MAX_BODY_BYTES: ['maxBodyBytes', 'number'],
  MAX_INFLIGHT: ['maxInflight', 'number'],
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
  return String(value);
}

/** 加载配置。configPath 为空 / 文件不存在时全部走默认值。 */
export function loadConfig(configPath = path.resolve('config.json'), env = process.env) {
  const cfg = { ...DEFAULTS };
  if (configPath && fs.existsSync(configPath)) {
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (e) {
      throw new Error(`config.json 解析失败: ${e.message}`);
    }
    for (const [k, v] of Object.entries(raw)) {
      if (v === undefined || v === null) continue;
      cfg[k] = v;
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
  return cfg;
}
