# cc-manage

Command Code 多账号反代网关：在协议内核 [`vendor/commandcode-proxy/`](vendor/commandcode-proxy/)（默认 `127.0.0.1:3050`）**前面**加一层账号池调度。

客户端只需要一把本地 key（`sk-cg-...`），网关按**剩余额度 / 在途请求**自动挑一个 Command Code 账号，把请求反代给内核并流式透传响应；同时轮询各账号额度、耗尽自动暂停、到点自动恢复，并提供一个只看额度的网页面板。

- **零外部依赖**：只用 Node 内置模块，`package.json` 里没有 `dependencies`。
- **Node 22+ / ESM**：所有文件都是 `.mjs`。
- **密钥不外泄**：日志、API、面板一律只出现 `keyId`（key 的 sha256 前 8 位）与 `keyPrefix`（前 9 个字符），完整 key 永不落日志、永不出现在响应里。

## 目录

```
gateway.mjs                 入口：HTTP 服务 + 路由（反代 + 面板 API）
src/config.mjs              配置加载（config.json + 环境变量覆盖）
src/store.mjs               账号池 / 本地 key / 运行期状态的持久化（JSON 原子写）
src/quota.mjs               Command Code 额度查询
src/scheduler.mjs           账号选择：打分 + 粘性 + 冷却 + 自动暂停/恢复
src/proxy.mjs               反代转发（流式透传 + 背压 + 失败换号重试）
src/log.mjs                 日志 + 脱敏
public/index.html           额度面板（纯 HTML + 内联 CSS/JS）
mocks/mock-cc-upstream.mjs  测试/演示用假 CC 上游
test/                       node:test 测试（离线可跑）
```

## 部署

```bash
# 1. 起协议内核（它负责把 OpenAI/Anthropic 协议翻译成 Command Code 上游协议）
cd vendor/commandcode-proxy && npm start        # 监听 127.0.0.1:3050

# 2. 起网关
cd ../.. && cp accounts.example.json accounts.json   # 填真实 CC key
cp config.example.json config.json                   # 按需改端口/上游地址
npm start                                            # 监听 127.0.0.1:3051
```

默认只监听 `127.0.0.1`。若确实要对外暴露，请务必同时设置 `gatewayHost=0.0.0.0` 与 `protectAdminApi=true`。

### 配置 `config.json`

字段全部可选，缺省值如下：

```json
{
  "gatewayPort": 3051,
  "gatewayHost": "127.0.0.1",
  "upstreamProxyUrl": "http://127.0.0.1:3050",
  "ccApiBase": "https://api.commandcode.ai",
  "quotaPollIntervalMs": 300000,
  "pausedRecheckIntervalMs": 60000,
  "quotaTimeoutMs": 15000,
  "sessionAffinityTtlMs": 1800000,
  "allowPassthrough": false,
  "protectAdminApi": false,
  "maxBodyBytes": 20971520,
  "logLevel": "info",
  "logFile": ""
}
```

环境变量覆盖：`GATEWAY_PORT` `GATEWAY_HOST` `UPSTREAM_PROXY_URL` `CC_API_BASE` `QUOTA_POLL_INTERVAL_MS` `PAUSED_RECHECK_INTERVAL_MS` `QUOTA_TIMEOUT_MS` `SESSION_AFFINITY_TTL_MS` `MAX_BODY_BYTES` `ALLOW_PASSTHROUGH` `PROTECT_ADMIN_API` `LOG_FILE` `LOG_LEVEL`。

### 账号池 `accounts.json`

```json
{ "accounts": [ { "name": "主号", "key": "user_xxxxxxxx", "enabled": true } ] }
```

- `key` 必须以 `user_` 开头，否则启动直接报错。
- 也可以用环境变量 `CC_ACCOUNTS` 传 JSON 数组（优先级高于文件）。
- 运行期状态（在途数、暂停时间、额度快照、最近错误）写在 `data/state.json`，**不**回写 `accounts.json`。

### 本地 key `keys.json`

```json
{ "keys": [ { "name": "我的客户端", "key": "sk-cg-xxxxxxxx" } ] }
```

必须以 `sk-cg-` 开头。鉴权来源：`Authorization: Bearer <k>` 或 `x-api-key: <k>`。

`allowPassthrough=true` 时，直接以 `user_` 开头的 key 也会被接受，此时**不做池调度**，原样透传给内核。

## 接口

反代（需要本地 key，`/health` 除外）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/v1/chat/completions` | 转发，`authorization` 替换成选中账号的 CC key |
| POST | `/v1/messages` | 同上（Anthropic 协议） |
| POST | `/v1/responses` | 同上（Responses API） |
| GET | `/v1/models` | 转发给内核 |

管理：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | `{ ok, accounts, available }`，无需 key |
| GET | `/api/status` | 账号池全量状态 + 请求统计 |
| GET | `/api/accounts` | 只读账号列表（无 key 明文） |
| POST | `/api/accounts/refresh` | 立刻刷新所有账号额度并返回新快照 |
| GET | `/` | 额度面板 |

```bash
curl 127.0.0.1:3051/health
curl 127.0.0.1:3051/api/status | python3 -m json.tool
curl -X POST 127.0.0.1:3051/api/accounts/refresh
curl -N -X POST 127.0.0.1:3051/v1/chat/completions \
  -H "authorization: Bearer sk-cg-localdevkey001" \
  -H "content-type: application/json" \
  -d '{"model":"claude-sonnet-4-5","stream":true,"messages":[{"role":"user","content":"hi"}]}'
```

## 调度规则

1. 过滤 `enabled=false`、`pausedUntil` 未到期、`authInvalid`、5h 窗口已打满的账号。
2. 候选按 `score = remainingRatio / (1 + 在途数)` 降序，`remainingRatio = 1 - used/cap`（5h 优先，无 5h 用周窗口，都没有算 1.0）。
3. 同分按 `accounts.json` 中的顺序稳定排序，绝不随机。
4. **粘性路由**：请求带 `x-session-id` 头，或 body 里有 `conversation_id` / `user` 字段时，同一 session 优先复用上次的账号（TTL 30 分钟，最多 2000 条，LRU 淘汰）；原账号不可用则改选并更新粘性表。
5. **自动暂停**：上游返回 402，或 429 且 body 含 `quota` / `limit` / `exceeded` → 暂停到 5h 窗口的 `resetAt`（没有则 now + 5h），并立刻触发一次额度刷新。
6. **自动恢复**：后台默认每 60s 复查到期账号，确认 `used < cap` 才恢复。**手动 `enabled=false` 的账号永不自动恢复。**

## 转发细节

- 流式透传：`http.request` 拿到上游响应后边收边转，不整体缓冲；下游写阻塞时暂停读上游，`drain` 后恢复。
- 请求头白名单：`content-type` `accept` `x-session-id`，`user-agent` 一律改写为 `commandcode-cli/1.53.1`；下游的 `authorization` / `x-api-key` **绝不**透传，一定替换成选中账号的 CC key。
- 请求体流式转发，超过 `maxBodyBytes`（默认 20MB）返回 413。
- 客户端断开立刻 abort 上游。
- 上游 5xx / 超时 / 连接错误，且**尚未向客户端写出任何字节**时，换一个账号重试一次（最多一次）；已开始写响应一律不重试。
- 上游 4xx（含 401）原样透传状态码，body 里可能出现的 key 会被脱敏。

## 面板

浏览器打开 `http://127.0.0.1:3051/`：每个账号一张卡片，显示可辨识前缀（`keyId · keyPrefix`）、剩余额度、5h / 周 / 月进度条、在途数、暂停与鉴权状态、最近错误；顶部是账号数 / 可用数 / 暂停数 / 在途数 / 总请求 / 错误数 / 累计 token，并提供「立即刷新额度」按钮。

## 测试与自测

```bash
npm test          # node:test，全部离线可跑，不打真实网络
```

手工联调（不碰真实 Command Code）：

```bash
node mocks/mock-cc-upstream.mjs &        # 假上游，默认 3099
# 用一份指向 mock 的配置起网关
node -e "import('./gateway.mjs').then(m=>m.startGateway({configPath:'config.local.json'}))" &
curl 127.0.0.1:3051/health
```

`config.local.json` 只需把 `upstreamProxyUrl` / `ccApiBase` 指向 `http://127.0.0.1:3099`。

## 坑

- **必须显式带 User-Agent**：查询 Command Code 的 `/alpha/*` 接口时，不带 UA（或 Python-urllib 默认 UA）会被 Cloudflare 拦成 `403 Error 1010`。本项目的 `quota.mjs` 固定用 `commandcode-cli/1.53.1`。
- **内核默认监听 `0.0.0.0:3050`**：生产上建议把内核也改成只监听回环，只让网关对外。
- `data/state.json` 含账号运行期状态，已在 `.gitignore` 里，别提交。
- `resetAt` 可能是秒、毫秒或 ISO 字符串，已统一归一化成秒；写新代码时别假设它是某一种。
- 月度百分比没有官方 cap 字段，是用「本周期花费 / (花费 + 剩余额度)」推算的（见 `src/quota.mjs` 里的 TODO）。
