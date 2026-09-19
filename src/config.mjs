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
  // 管理 API 是否也要求本地 key。默认 false：网关默认只监听 127.0.0.1，
  // 面板需要免密打开才能直接用。监听 0.0.0.0 时建议置 true。
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
