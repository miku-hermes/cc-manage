# cc-manage 规格说明（给 Codex 的实现任务书）

> 本文件是**任务书**。请严格按此实现，不要自由发挥架构。
> 参考实现（功能对标）：
> - `https://github.com/MAXeaglet/commandcode-proxy` —— 协议内核，已 vendor 到 `vendor/commandcode-proxy/`（MIT）
> - `https://github.com/hong-zhijun/command-go-manage` —— 多账号池 + 额度调度 + 面板（目标是同等能力，但要更小、零依赖）

---

## 0. 一句话目标

在 `vendor/commandcode-proxy/`（协议内核，跑在 3050）**前面**加一层**多账号反代网关**（跑在 3051）：
客户端只拿一把本地 key，网关按**剩余额度 / 在途请求**自动挑一个 Command Code 账号，
把请求反代给内核（内核再翻译成 CC 上游协议），同时轮询各账号额度、耗尽自动暂停、到点自动恢复，
并提供一个只看额度的网页面板。

## 1. 硬性约束

1. **零外部依赖**：只用 Node 内置模块（`node:http` `node:https` `node:fs` `node:crypto` `node:path` `node:test`）。不许引入 npm 包。
2. **Node 22 + ESM**（`"type": "module"`）。所有文件用 `.mjs`。
3. **不许修改 `vendor/commandcode-proxy/` 下任何文件**（那是上游内核，保持原样；我们只调用它）。
4. **密钥永不落日志、永不出现在 API 响应里**：对外只暴露 `keyId`（= `key` 的 sha256 前 8 位十六进制）和 `keyPrefix`（前 9 个字符）。
5. **默认只监听 `127.0.0.1`**（可配置）。
6. 中文注释、中文日志。代码风格：简洁、无冗余抽象。

## 2. 目录结构（必须照此建）

```
/root/projects/cc-manage/
├── package.json              # name: cc-manage, type: module, scripts: start / dev / test
├── config.json               # 运行时配置（见 §6）
├── config.example.json       # 配置模板
├── accounts.example.json     # 账号池模板
├── README.md                 # 中文使用说明（部署、配置、接口、面板、坑）
├── gateway.mjs               # 入口：HTTP 服务 + 路由（反代 + 面板 API）
├── src/
│   ├── config.mjs            # 配置加载（config.json + 环境变量覆盖）
│   ├── store.mjs             # 账号池/本地 key/额度快照 的持久化（JSON 文件，原子写）
│   ├── quota.mjs             # Command Code 额度查询（契约见 §4）
│   ├── scheduler.mjs         # 账号选择：打分 + 粘性 + 冷却 + 自动暂停/恢复
│   ├── proxy.mjs             # 反代转发（含 SSE 流式边收边转、背压、上游失败换号重试）
│   └── log.mjs               # 日志 + 脱敏工具
├── panel/                    # Astro 面板工程（源码 src/pages/*.astro + public/css|js）
│   └── src/pages/index.astro # 额度面板（构建为运行镜像里的 public/index.html）
├── mocks/
│   └── mock-cc-upstream.mjs  # 测试用假 CC 上游（见 §8）
└── test/
    ├── quota.test.mjs
    ├── scheduler.test.mjs
    ├── gateway.test.mjs
    └── helpers.mjs
```

## 3. 账号池

`accounts.json` 结构：

```json
{
  "accounts": [
    { "name": "主号", "key": "user_xxxxxxxx", "enabled": true }
  ]
}
```

- `key` 必须以 `user_` 开头（校验，不符则启动时报错）。
- 运行期状态（不写回 accounts.json，另存 `data/state.json`）：`concurrency`（在途数）、`pausedUntil`（毫秒时间戳或 null）、`lastQuota`（额度快照）、`lastError`、`lastErrorAt`。
- 支持从环境变量 `CC_ACCOUNTS` 读 JSON 数组（优先级高于文件）。

## 4. Command Code 额度查询（已实测契约，照抄）

base = `https://api.commandcode.ai`（可用 `CC_API_BASE` 覆盖），全部 `GET`。

**请求头（关键）**：
```
accept: application/json
authorization: Bearer <key>
user-agent: commandcode-cli/1.53.1
```
> ⚠️ **必须显式带 User-Agent**。实测：不带（或 Python-urllib 默认 UA）会被 Cloudflare 拦成
> `403 Error 1010: Access denied — blocked based on your browser's signature`。
> 带 `commandcode-cli/1.53.1` 或任意 curl/浏览器 UA 都放行。

**调用顺序与响应形状**（均已实测，路径存在、鉴权门有效）：

1. `GET /alpha/whoami`
   → `{ org: { login, id }, user: { userName|name, keyName|displayName } }`
   取 `orgId = org.id`，展示名 = `org.login || user.userName || user.name`。
   ⚠️ 实测真实账号 `org` 为 `null`（无 `org.id`）：此时 `orgId` 可选（后续接口省略该参数），
   账号标识回退到 `user.userName || user.name`；只要有用户标识即视为解析成功。
2. `GET /alpha/billing/credits?orgId=<orgId>`（无 orgId 时省略该参数，接口照样返回数据）
   → `{ credits: { monthlyCredits, purchasedCredits, freeCredits },
        windowLimits: { fiveHour: { used, cap, resetAt }, weekly: { used, cap, resetAt } } }`
   剩余 = 三项相加；`resetAt` 可能是秒级数字、毫秒级数字或 ISO 字符串，统一归一化成秒（>=1e12 视为毫秒 → /1000）。
3. `GET /alpha/billing/subscriptions?orgId=<orgId>`（同上可省略）
   → `{ data: { planId, status, currentPeriodStart, currentPeriodEnd } }`
4. `GET /alpha/usage/summary?orgId=<orgId>&since=<currentPeriodStart>`（无 orgId 时用 `?since=...`）
   → `{ totalCost, totalCount, totalTokens }`

**错误处理**：401/403 → 该账号标记 `authInvalid`（面板显示红色，但不自动删除）；
单个账号查询失败**不能**影响其他账号；超时 15s；同一账号的 4 个请求共用一个超时预算（AbortController）。
错误信息里如果包含 key，必须脱敏。

## 5. 调度（核心）

选账号算法，按顺序：

1. 过滤 `enabled === false`
2. 过滤 `pausedUntil > now`（额度耗尽暂停中）或 `authInvalid`
3. 过滤 5 小时窗口 `used >= cap`（以最近一次额度快照为准）
4. 剩余候选按分数降序：`score = remainingRatio / (1 + inflight)`，
   其中 `remainingRatio = 1 - used/cap`（取 5h 窗口；无 5h 数据时用周窗口；都没有则算 1.0）
5. 同分时按账号在 accounts.json 中的顺序稳定排序（不许随机）

**粘性路由**：请求里带 `x-session-id` 头（或请求体里的 `conversation_id` / `user` 字段）时，
把该 session 之前用过的账号优先复用（表 `sessionAffinity`，TTL 30 分钟，最多 2000 条，LRU 淘汰）。
命中但该账号不可用时，重新挑并把 affinity 更新到新账号。

**自动暂停/恢复**：
- 上游返回**额度耗尽**类错误（HTTP 402，或 429 且 body 含明确额度语义 `quota`/`quota_exceeded`/`windowLimits`/`credits`/`weekly|monthly limit`）→ `pausedUntil = 5h 窗口的 resetAt`（无则 now + 5h），并立刻触发一次额度刷新。
- 普通限流（429 但不是额度耗尽）→ 只置 `rateLimitedUntil = now + 60s`，账号短暂退出选择后自动恢复；**不得**写 `pausedUntil`。
- 上游 401/403 → 标记 `authInvalid`，立刻停止调度该账号。
- 一个后台定时器（默认 60s）检查 `pausedUntil` 已到期的账号 → 重新查一次额度，确认 `used < cap` 才恢复。
- 手动停用（`enabled=false`）**永远**不自动恢复。

**在途计数**：进入转发前 +1，响应结束（含出错/客户端断开）finally 里 -1。

## 6. 配置

`config.json`（字段全部可选，缺省用下面默认值）：

```json
{
  "gatewayPort": 3051,
  "gatewayHost": "127.0.0.1",
  "upstreamProxyUrl": "http://127.0.0.1:3050",
  "ccApiBase": "https://api.commandcode.ai",
  "quotaPollIntervalMs": 600000,
  "quotaActivePollIntervalMs": 60000,
  "quotaActiveWindowMs": 300000,
  "pausedRecheckIntervalMs": 60000,
  "quotaTimeoutMs": 15000,
  "sessionAffinityTtlMs": 1800000,
  "allowPassthrough": false,
  "logLevel": "info",
  "logFile": ""
}
```

环境变量覆盖（与字段一一对应）：`GATEWAY_PORT` `GATEWAY_HOST` `UPSTREAM_PROXY_URL` `CC_API_BASE`
`QUOTA_POLL_INTERVAL_MS` `QUOTA_ACTIVE_POLL_INTERVAL_MS` `QUOTA_ACTIVE_WINDOW_MS` `ALLOW_PASSTHROUGH` `LOG_FILE` `LOG_LEVEL`。

本地 key 文件 `keys.json`：
```json
{ "keys": [ { "name": "我的客户端", "key": "sk-cg-xxxxxxxx" } ] }
```
本地 key 必须以 `sk-cg-` 开头；`allowPassthrough=true` 时还接受直接以 `user_` 开头的 key（此时不做池调度，原样透传）。
鉴权来源：`Authorization: Bearer <k>` 或 `x-api-key: <k>`。

## 7. HTTP 接口（网关自己）

反代（需要本地 key，除 `/health`）：
- `POST /v1/chat/completions` → 转发，替换 `authorization` 为选中账号的 CC key
- `POST /v1/messages` → 同上
- `POST /v1/responses` → 同上
- `GET /v1/models` → 转发给内核

本地管理 API：
- `GET /health` → `{ ok: true, accounts: n, available: m }`
- `GET /api/status` → 账号池全量状态（含额度快照、5h/周/月百分比、在途数、暂停状态）+ 请求统计（总请求、按账号、错误数、累计 token）
- `POST /api/accounts/refresh` → 立刻刷新所有账号额度并返回新快照
- `GET /api/accounts` → 只读账号列表（无 key 明文）
- `GET /` → 面板 HTML

**转发规则（重点）**：
- 必须**流式透传**：用 `http.request` 拿上游响应后 `pipe` 给下游；绝不允许把整个响应缓冲进内存。
  下游写阻塞（`res.write()` 返回 false）时要暂停读上游（背压），`drain` 再 `resume`。
- 请求头白名单转发：`content-type` `accept` `user-agent`（改写为 `commandcode-cli/1.53.1`）`x-session-id`；
  **不要**把下游的 `authorization`/`x-api-key` 透传给上游（必须替换）。
- 请求体：流式透传（`req.pipe(upstreamReq)`），设 `maxBodyBytes`（默认 8MB），超限返回 413；在途请求上限 `maxInflight`（默认 8）超出返回 503。
- 客户端断开（`req.on('aborted')` / `res.on('close')`）→ 立刻 abort 上游请求。
- **失败换号重试**：仅当上游返回 5xx/超时/连接错误，**且还没有向客户端写出任何字节**时，
  才换一个账号重试一次（最多一次）。已开始写响应则一律不重试。
- 上游 4xx（含 401）原样透传状态码和 body，但**不**把上游 body 里可能含的 key 回给客户端。

## 8. 测试（必须全绿：`npm test`）

用 `node:test` + `node:assert`，全部**离线可跑**（不许打真实网络）。`mocks/mock-cc-upstream.mjs` 提供：
- `/alpha/*` 额度接口的假响应（可被测试用例配置成"某账号已耗尽"）
- `/v1/*` 假的 OpenAI/Anthropic 响应（含一个会吐 3 个 SSE chunk 的流式用例）

必须覆盖：
1. `quota.test.mjs`：注入假 fetch → 正确解析出 whoami/余额/5h/周百分比；缺字段不炸；401 → `authInvalid`；resetAt 三种格式归一化正确。
2. `scheduler.test.mjs`：剩余额度高的被选中；耗尽的被跳过；`pausedUntil` 未到期的被跳过；到点且额度恢复 → 自动恢复；手动 `enabled=false` 不恢复；粘性路由命中同账号；粘性账号不可用时改选。
3. `gateway.test.mjs`（起真实 HTTP 服务，上游指向 mock）：
   - 无 key → 401；错误 `sk-cg-` key → 401；正确 key → 200
   - 转发时上游收到的是**池内账号的 CC key**，不是客户端的 `sk-cg-` key（mock 记录收到的 authorization 供断言）
   - SSE 流式：mock 发 3 个 chunk，客户端能按序收到 3 个 `data:` 事件 + `[DONE]`
   - `/api/status` 响应里**不含**任何完整 key（断言 body 里没有 `user_` 完整串、只有 keyId/keyPrefix）
   - `/health` 在无 key 时也能访问
   - 413：超过 maxBodyBytes 被拒

## 9. 验收标准（我会亲自跑）

1. `npm test` 全绿，输出贴出来。
2. `node mocks/mock-cc-upstream.mjs` + `node gateway.mjs` 能起，`curl 127.0.0.1:3051/health` 返回 ok。
3. 面板 `GET /` 能打开，显示账号卡片 + 5h/周/月进度条 + 余额（数据来自 mock）。
4. `git status` 干净（除新增文件外不许改动 `vendor/`）。
5. 无 npm 依赖：`package.json` 里不允许有 `dependencies`。

## 10. 不许做的事

- 不许编造 Command Code 的接口/字段（一切以 §4 契约为准，拿不准就留 TODO 注释问我）。
- 不许引入任何第三方包或 CDN。
- 不许在日志/面板/API 里输出完整 key。
- 不许修改 `vendor/commandcode-proxy/`。
- 不许把 `data/`（含密钥状态）提交进 git —— 加 `.gitignore`。
