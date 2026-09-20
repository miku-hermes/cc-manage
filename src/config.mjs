// 配置加载：config.json 默认值 + 环境变量覆盖
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULTS = {
  gatewayPort: 3051,
  gatewayHost: '127.0.0.1',
  upstreamProxyUrl: 'http://127.0.0.1:3050',
  ccApiBase: 'https://api.commandcode.ai',
  quotaPollIntervalMs: 300000,
  pausedRecheckIntervalMs: 60000,
  quotaTimeoutMs: 15000,
  sessionAffinityTtlMs: 1800000,
  allowPassthrough: false,
  maxBodyBytes: 20 * 1024 * 1024,
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
  PAUSED_RECHECK_INTERVAL_MS: ['pausedRecheckIntervalMs', 'number'],
  QUOTA_TIMEOUT_MS: ['quotaTimeoutMs', 'number'],
  SESSION_AFFINITY_TTL_MS: ['sessionAffinityTtlMs', 'number'],
  MAX_BODY_BYTES: ['maxBodyBytes', 'number'],
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
