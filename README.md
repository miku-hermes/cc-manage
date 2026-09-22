# cc-manage

Command Code 多账号反代网关：在协议内核 [`vendor/commandcode-proxy/`](vendor/commandcode-proxy/)（默认 `127.0.0.1:3050`）**前面**加一层账号池调度。

**两套凭据职责分清**：

| 凭据 | 谁用 | 存在哪 | 用途 |
| --- | --- | --- | --- |
| **后台账号 + 密码** | 人（浏览器登录） | `config/users.json` | 登录 `/admin` 后台 |

> 登出 / 改密码的吊销记录持久化在 `config/revoked.json`（0600）。早期只在内存里，重启后旧 cookie 会复活。 |
| **客户端 API key**（`sk-cg-…`） | 程序（curl / SDK） | `config/keys.json` | 调用 `/v1/*` 反代接口 |

程序侧只需要一把客户端 key（`sk-cg-...`），网关按**剩余额度 / 在途请求**自动挑一个 Command Code 账号，把请求反代给内核并流式透传响应；同时轮询各账号额度、耗尽自动暂停、到点自动恢复。`/` 是**公开只读**看板（不暴露完整 key），`/admin` 用账号密码登录后管理 CC key、客户端 key 与管理员。

- **零外部依赖**：只用 Node 内置模块，`package.json` 里没有 `dependencies`。
- **Node 22+ / ESM**：所有文件都是 `.mjs`。
- **密钥不外泄**：日志、API、面板一律只出现 `keyId`（key 的 sha256 前 8 位）与 `keyPrefix`（前 9 个字符），完整 key 永不落日志、永不出现在响应里。

## 目录

```
gateway.mjs                 入口：HTTP 服务 + 路由（反代 + 面板 API）
src/config.mjs              配置加载（config.json + 环境变量覆盖）
src/store.mjs               账号池 / 客户端 key / 管理员 / 运行期状态的持久化（JSON 原子写）
src/auth.mjs                scrypt 密码哈希 + HMAC 签名 cookie session + 登录限速
src/quota.mjs               Command Code 额度查询
src/scheduler.mjs           账号选择：打分 + 粘性 + 冷却 + 自动暂停/恢复
src/proxy.mjs               反代转发（流式透传 + 背压 + 失败换号重试）
src/log.mjs                 日志 + 脱敏
public/index.html           公开只读额度面板（纯 HTML + 内联 CSS/JS）
public/admin.html           后台：登录/初始化 + CC key / 客户端 key / 管理员管理
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

默认只监听 `127.0.0.1`。对外暴露时后台走账号密码登录（首次访问 `/admin` 初始化），面板默认公开只读；
若要连面板也藏起来，设 `PUBLIC_DASHBOARD=0`（此时 `/api/status` 需要登录 session）。

**反向代理（1Panel / openresty / nginx）注意**：网关自身 `keepAliveTimeout` 默认 65s
（`KEEPALIVE_TIMEOUT_MS` 可调），反代侧的 upstream `keepalive_timeout` **必须小于**该值
（建议 60s 及以下）。否则反代会复用一条后端已关闭的连接，POST 请求写过去就是 EPIPE，
客户端偶发 502。另外反代应把真实来源写进 `X-Real-IP`（用 `$remote_addr` 覆盖），
网关在 `X-Forwarded-For` 里**从右往左**取第一个非可信地址，客户端伪造的左侧前缀无效。

### Docker 部署（一键起网关 + 协议内核）

`docker compose` 会同时拉起两个服务：`gateway`（本仓库，宿主只映射 `127.0.0.1:3051`）与 `core`（`vendor/commandcode-proxy`，**不映射宿主端口**）。宿主上的客户端只跟 `gateway` 说话。

网络与权限：`core:3050` 没有鉴权（拿到任意有效 CC key 就能用），所以它只挂在 `core-net`（`internal: true`）上，**只有 `gateway` 能访问它**；`core` 自己出网走一条只有它挂的 `core-egress`（内核要直连 CC 上游）。两个服务都是只读根文件系统（`read_only: true` + `tmpfs: /tmp`），可写的只有 `gateway` 的 `/app/config`（bind）与 `/app/data`（命名卷）。

```bash
# 1. 前置准备：可写目录挂载（容器 uid 1000）
mkdir -p config && chown 1000:1000 config
#   config/accounts.json 不填也行 —— 首次打开 /admin 登录后台，在「CC 账号管理」里加
#   config/keys.json 留空即可 —— 后台「API 客户端 key」里点生成
#   config/users.json / config/session-secret 首次启动自动创建（0640 / 0600）

# 2. 可选调参
cp .env.example .env

# 3. 构建 + 后台启动
docker compose up -d --build
```

健康检查：

```bash
docker compose ps                          # 期望 core / gateway 两行都是 healthy
curl -s 127.0.0.1:3051/health              # {"ok":true,"accounts":N,"available":M}
```

调用示例（key 用 `keys.json` 里那把）：

```bash
curl -s -X POST 127.0.0.1:3051/v1/chat/completions \
  -H "authorization: Bearer sk-cg-xxxxxxxx" \
  -H "content-type: application/json" \
  -d '{"model":"claude-sonnet-4-5","messages":[{"role":"user","content":"hi"}]}'

# 流式
curl -N -X POST 127.0.0.1:3051/v1/chat/completions \
  -H "authorization: Bearer sk-cg-xxxxxxxx" \
  -H "content-type: application/json" \
  -d '{"model":"claude-sonnet-4-5","stream":true,"messages":[{"role":"user","content":"hi"}]}'
```

面板与后台：

- `http://127.0.0.1:3051/` —— **公开只读**看板（账号名 / keyId / keyPrefix / 额度百分比，没有完整 key）。
- `http://127.0.0.1:3051/admin` —— 后台。首次打开是**初始化页**，设第一个管理员（用户名 + 至少 8 位密码）；
  初始化完成后该接口永久返回 403。之后用同一页登录，session 存 HttpOnly cookie（7 天）。
  后台里可以：新增/停用/改备注/删除 CC 上游 key、**测试连通性**（调 CC `whoami`，显示登录名与套餐或错误原因）、
  生成/删除客户端 `sk-cg-` key（明文只显示一次）、增删管理员。

**密钥安全**：`config/` 目录挂载进容器（可写，`0640`；`session-secret` 是 `0600`），镜像内 `/app` 不含任何密钥文件。
后台改完即时热生效，不需要重启。

**为什么 `core` 不对外映射**：内核本身不做账号池，暴露出去等于绕过网关直接用一个 key（还丢掉了选号、额度暂停、面板），所以刻意只让 `gateway` 容器访问。
**公网访问**：宿主只绑 `127.0.0.1:3051`，需要公网时请自己在前面放一个 nginx（不在本 compose 内）。

日志与排障：

```bash
docker compose logs -f gateway     # 网关日志（已脱敏，只有 keyId/keyPrefix）
docker compose logs -f core        # 内核日志
docker compose down                # 清理（不要加 -v，除非你确实想删数据卷）
```

**排障**：想看公开面板是否被关掉、或后台是否要求登录：

```bash
cd /root/projects/cc-manage
curl -s -o /dev/null -w '%{http_code}\n' 127.0.0.1:3051/api/status        # 默认 200（公开只读）；PUBLIC_DASHBOARD=0 时 401
curl -s -o /dev/null -w '%{http_code}\n' 127.0.0.1:3051/api/admin/accounts # 未登录必须 401
curl -s 127.0.0.1:3051/api/auth/me | python3 -m json.tool                  # setupRequired / authenticated
```

常见坑：端口被占用（改 `.env` 里的 `GATEWAY_BIND_PORT`）；`core` 未 healthy 时 `gateway` 会一直等
（`docker compose ps` 看到 `core` 不是 healthy 就先看它的日志）；登录 429 → 同 IP 连续失败 5 次会锁 5 分钟；
401 但客户端 key 明明是对的 → 确认没有多余空格/换行。

**已删账号的残留会自动清理**：`data/state.json` 里 `accounts` 与 `stats.byAccount` 中以 keyId 为键的条目，凡是**不在当前 `accounts.json` 里**的，网关启动加载状态时会一并删除（被删账号的请求数 / 错误数 / token 数也从全局合计里扣掉，保证 `byAccount` 之和与 `total*` 自洽），并立即落盘，避免删号后统计与状态一直残留。

**自测链路（不填真 key 也能验证）**：用 `accounts.json` 里的假 `user_` key 时，网关启动那一刻的额度轮询会从 CC 拿到 401，于是按 SPEC §5 把这些账号标记为 `authInvalid` 并跳过，打反代会得到 `503 no_available_account`（这是**预期**行为，不是故障）。想验证「请求真的转发到了内核、且 key 被替换」，把额度轮询指到一个不可达地址即可（内核仍用自己所带的 `apiBase` 打真实 CC）：

```bash
CC_API_BASE=http://127.0.0.1:9 docker compose up -d --force-recreate gateway
curl -s -o /dev/null -w '%{http_code}\n' -X POST 127.0.0.1:3051/v1/chat/completions \
  -H "authorization: Bearer sk-cg-xxxxxxxx" -H "content-type: application/json" \
  -d '{"model":"deepseek/deepseek-v4-flash","messages":[{"role":"user","content":"hi"}]}'   # 期望 401
docker compose logs --tail 20 core   # 能看到请求到达 + 被替换成池内账号的 key（user_dem…）
docker compose up -d --force-recreate gateway   # 恢复默认
```

**内存提示**：本机 2GB，已用四重封顶 —— `mem_limit`（core 512m / gateway 384m）+ `CC_MAX_BODY_MB`（默认 20）+ `CC_MAX_INFLIGHT`（默认 8）+ 网关自己的 `maxBodyBytes`（默认 8MB）/ `maxInflight`（默认 8）。公网/高并发还要另加 nginx 侧的连接数限制。

### 配置 `config.json`

字段全部可选，缺省值如下：

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
  "publicDashboard": true,
  "maxBodyBytes": 8388608,
  "maxInflight": 8,
  "logLevel": "info",
  "logFile": ""
}
```

- 额度轮询是**自适应**的：最近 `quotaActiveWindowMs`（默认 5 分钟）内有代理请求 → 用 `quotaActivePollIntervalMs`（默认 60 秒）同步 CC；一直空闲 → 退回 `quotaPollIntervalMs`（默认 600 秒）。实现是**单个自调度 `setTimeout`**，每轮跑完再决定下一次延迟；上一轮没跑完则跳过本轮。`quotaPollIntervalMs: 0` 表示**完全关闭**轮询（`quotaActivePollIntervalMs: 0` 则退化为纯空闲间隔）。
- `publicDashboard`（`PUBLIC_DASHBOARD`）：`1`（默认）让 `/` 与 `/api/status` 公开只读；`0` 则要求后台登录 session。
- 已废弃的 `protectAdminApi`（`PROTECT_ADMIN_API`）：旧版「面板接口要 `sk-cg-` key」开关，仅为老部署兼容保留；新部署请用 `PUBLIC_DASHBOARD=0`。

环境变量覆盖：`MAX_INFLIGHT` `GATEWAY_PORT` `GATEWAY_HOST` `UPSTREAM_PROXY_URL` `CC_API_BASE` `QUOTA_POLL_INTERVAL_MS` `QUOTA_ACTIVE_POLL_INTERVAL_MS` `QUOTA_ACTIVE_WINDOW_MS` `PAUSED_RECHECK_INTERVAL_MS` `QUOTA_TIMEOUT_MS` `SESSION_AFFINITY_TTL_MS` `MAX_BODY_BYTES` `ALLOW_PASSTHROUGH` `PUBLIC_DASHBOARD` `LOG_FILE` `LOG_LEVEL`。

### 账号池 `accounts.json`

```json
{ "accounts": [ { "name": "主号", "key": "user_xxxxxxxx", "enabled": true } ] }
```

- `key` 必须以 `user_` 开头，否则启动直接报错。
- 也可以用环境变量 `CC_ACCOUNTS` 传 JSON 数组（优先级高于文件）。
- 运行期状态（在途数、暂停时间、额度快照、最近错误）写在 `data/state.json`，**不**回写 `accounts.json`。

### 客户端 API key `keys.json`

```json
{ "keys": [ { "name": "我的客户端", "key": "sk-cg-xxxxxxxx" } ] }
```

必须以 `sk-cg-` 开头。鉴权来源：`Authorization: Bearer <k>` 或 `x-api-key: <k>`。
**只用于 `/v1/*` 反代调用**，不能登录后台（后台走账号密码）。推荐在后台「API 客户端 key」里点生成。

### 后台管理员 `users.json` 与签名密钥 `session-secret`

```json
{ "users": [ { "username": "admin", "passwordHash": "scrypt$16384$8$1$<salt-b64>$<hash-b64>" } ] }
```

- 密码用 `node:crypto` 的 **scrypt** 加盐哈希，**绝不存明文**；校验走 `timingSafeEqual`。
- `session-secret` 首次启动自动生成（32 字节随机，`0600`），cookie 用 **HMAC-SHA256** 签名；
  密钥持久化就不会每次重启把用户登出。
- 文件都可删：`users.json` 删掉后重新打开 `/admin` 会再次进入初始化流程。

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
| GET | `/api/status` | 账号池全量状态 + 请求统计（默认公开只读） |
| GET | `/api/accounts` | 只读账号列表（无 key 明文） |
| POST | `/api/accounts/refresh` | 立刻刷新所有账号额度并返回新快照（匿名调用 5s 节流） |
| GET | `/` | 公开只读额度面板 |

后台鉴权（session cookie）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/admin` | 未登录显示登录页；`users.json` 为空时显示初始化页 |
| POST | `/api/auth/setup` | 创建第一个管理员；完成后永久 403 |
| POST | `/api/auth/login` | `{username, password}` → 设 session cookie；失败 5 次锁 5 分钟（429） |
| POST | `/api/auth/logout` | 清 cookie 并吊销该会话 |
| GET | `/api/auth/me` | `{ authenticated, setupRequired, user }` |
| GET | `/api/admin/session` | 当前管理员 / 管理员列表 / 可写状态（需登录） |
| GET | `/api/admin/accounts` | CC 账号列表 + 额度 + 连通性测试历史（需登录） |
| POST | `/api/admin/accounts` | 新增 CC key（`{name, key}`） |
| POST | `/api/admin/accounts/test` | 调 CC `whoami` 测连通性（`{keyId}` 或 `{key}`） |
| PATCH/DELETE | `/api/admin/accounts/{keyId}` | 改备注 / 启停 / 删除 |
| GET/POST | `/api/admin/keys` | 列出 / 生成客户端 key（生成的明文只回一次） |
| DELETE | `/api/admin/keys/{keyId}` | 删除客户端 key |
| GET/POST/PATCH/DELETE | `/api/admin/users[/{username}]` | 管理员增删改密（不能删掉最后一个） |
| GET | `/api/admin/events` | 运行日志（`?level=&limit=`） |

`/api/admin/*` 全部要求登录 session（`sk-cg-` key 无效），未登录返回 401。

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
5. **额度耗尽才暂停**：上游 402，或 429 且 body 有**明确额度语义**（`quota` / `quota_exceeded` / `windowLimits` / `insufficient credits` / `weekly|monthly limit` 等）→ 暂停到 5h 窗口的 `resetAt`（没有则 now + 5h），并立刻触发一次额度刷新。
   普通限流（`429` + `Rate limit exceeded` / `too many requests` / `type:"rate_limit"`）**只冷却 60 秒**，绝不会把账号停用 5 小时。
6. **鉴权失效立刻停调度**：上游 401（key 吊销/无效，报文如 `Invalid 'Authorization' header or token`）→ 标记 `authInvalid`，不再把该账号选进池（早期要等额度轮询才发现，最长 ~10 分钟窗口）。**403 不算鉴权失效**：它的语义是「模型名不存在 / 套餐不含该模型」（`Model/provider not recognized` / `MODEL_NOT_IN_PLAN`），只记 `lastError` 并把 403 原样透传，绝不停调账号。
6. **自动恢复**：后台默认每 60s 复查到期账号，确认 `used < cap` 才恢复。**手动 `enabled=false` 的账号永不自动恢复。**

## 转发细节

- 流式透传：`http.request` 拿到上游响应后边收边转，不整体缓冲；下游写阻塞时暂停读上游，`drain` 后恢复。
- 请求头白名单：`content-type` `accept` `x-session-id`，`user-agent` 一律改写为 `commandcode-cli/1.53.1`；下游的 `authorization` / `x-api-key` **绝不**透传，一定替换成选中账号的 CC key。
- 请求体流式转发，超过 `maxBodyBytes`（默认 8MB）返回 413。
- 在途请求上限 `maxInflight`（默认 8），超出返回 `503` + `Retry-After`。
- 上游把响应发到一半就断流时，网关**不会** `res.end()` 把半截内容伪装成完整的 200 —— 已写出的按连接异常 `res.destroy()` 中止，未写出的按 502，并计入 `stats.errors`。
- 客户端断开立刻 abort 上游。
- 上游 5xx / 超时 / 连接错误，且**尚未向客户端写出任何字节**时，换一个账号重试一次（最多一次）；已开始写响应一律不重试。
- 上游 4xx（含 401）原样透传状态码，body 里可能出现的 key 会被脱敏。

## 面板

浏览器打开 `http://127.0.0.1:3051/`：每个账号一张卡片，显示可辨识前缀（`keyId · keyPrefix`）、剩余额度、5h / 周 / 月进度条、在途数、暂停与鉴权状态、最近错误；顶部是账号数 / 可用数 / 暂停数 / 在途数 / 总请求 / 错误数 / 累计 token，并提供「立即刷新额度」按钮。

**面板需要填 key**：`PROTECT_ADMIN_API=1`（默认）时 `/api/*` 要鉴权，所以右上角有一个 `type=password` 的 key 输入框——把 `keys.json` 里的 `sk-cg-…` 粘进去点「保存」，值只存在浏览器 `sessionStorage`（关标签页即失效，不落盘、不写 cookie），之后面板所有请求（含「立即刷新额度」）都会自动带上 `Authorization: Bearer <key>`。没填 key 时面板只显示一条提示，不会每 5 秒刷一堆 401 报错。key 只留在本机浏览器里，服务端不回显、不记录。

面板响应固定带 `X-Content-Type-Options: nosniff`。

## 测试与自测

```bash
npm test          # node:test：本仓库测试 + vendor/commandcode-proxy 内核测试，离线可跑、不打真实网络
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

## 镜像与私有部署

CI 会把两个镜像推到 GitHub Container Registry：

```
ghcr.io/<owner>/cc-manage-gateway:latest
ghcr.io/<owner>/cc-manage-core:latest
```

用镜像跑（不需要本仓库源码，只要 `accounts.json` + `keys.json` 两个文件）：

```bash
./scripts/run-from-ghcr.sh          # OWNER= VERSION= 可覆盖
```

脚本会把 `config/` 与 `data/` 建好并 `chown 1000:1000`（容器以 uid 1000 运行；写不进去时 store 会降级成纯内存、重启即丢 state），
容器同样带 `--user 1000:1000 --cap-drop ALL --security-opt no-new-privileges:true --read-only --tmpfs /tmp` 与日志轮转。
`chown` 失败（非 root 调用）只会警告、不阻断启动 —— 但容器内 uid 1000 写不进去时，后台会因凭据目录不可写而拒绝初始化，请先在宿主上手改权限。

### 自动构建（GHCR）

工作流在 `.github/workflows/docker-publish.yml`，推送即生效：

- 推 `master`/`main` 或打 `v*` 标签 → 先跑 `npm test`（本仓库测试 + `vendor/commandcode-proxy` 内核自带测试，两个目录都跑），通过后构建并推送两个镜像
- 构建时把 `node:22-alpine` 解析成 digest 传 `--build-arg BASE_IMAGE=...@sha256:...`，并传 `REVISION=$(git rev-parse HEAD)` 打成 OCI 标签
- 镜像：`ghcr.io/miku-hermes/cc-manage-gateway` 与 `ghcr.io/miku-hermes/cc-manage-core`
- 标签：`latest`（默认分支）、分支名、`v1.2.3` / `1.2`（打 tag 时）、`sha-<短哈希>`
- PR 只构建不推送；构建缓存走 GitHub Actions cache

> GHCR 包继承仓库可见性。换机器拉取需先 `docker login ghcr.io -u <用户名>`（PAT 勾 `read:packages`）。
