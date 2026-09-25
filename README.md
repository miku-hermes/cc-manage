# cc-manage

Command Code 多账号反代网关：在协议内核 [`vendor/commandcode-proxy/`](vendor/commandcode-proxy/)（默认 `127.0.0.1:3050`）**前面**加一层账号池调度。

**两套凭据职责分清**：

| 凭据 | 谁用 | 存在哪 | 用途 |
| --- | --- | --- | --- |
| **后台账号 + 密码** | 人（浏览器登录） | `config/users.json` | 登录 `/admin` 后台 |

> 登出 / 改密码的吊销记录持久化在 `config/revoked.json`（0600）。早期只在内存里，重启后旧 cookie 会复活。 |
| **客户端 API key**（`sk-cg-…`） | 程序（curl / SDK） | `config/keys.json` | 调用 `/v1/*` 反代接口 |

程序侧只需要一把客户端 key（`sk-cg-...`），网关按**剩余额度 / 在途请求**自动挑一个 Command Code 账号，把请求反代给内核并流式透传响应；同时轮询各账号额度、耗尽自动暂停、到点自动恢复。`/` 是**公开只读**看板（不暴露完整 key），`/admin` 用账号密码登录后管理 CC key、客户端 key 与管理员。

- **后端零构建依赖**：只用 Node 内置模块，`package.json` 里没有 `dependencies`，克隆下来直接 `node gateway.mjs`。前端面板由 `panel/`（Astro 构建管道）产出静态 HTML，使用 ECharts 6.1.0 绘制「近 24 小时趋势」图（vendored 在 `panel/public/vendor/`，懒加载，见下）。
- **Node 22+ / ESM**：所有文件都是 `.mjs`。
- **密钥不外泄**：日志与已登录的后台 API 只出现 `keyId`（key 的 sha256 前 8 位）与 `keyPrefix`（前 9 个字符），完整 key 永不落日志、永不出现在响应里；匿名可读的公开面板连 `keyId` / `keyPrefix` 都不下发。

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
panel/                      Astro 面板工程（源码：src/pages/*.astro + public/css|js；构建产物：dist/ → 运行镜像的 public/）
panel/src/pages/index.astro 公开只读额度面板（构建为 public/index.html）
panel/src/pages/admin.astro 后台：登录/初始化 + CC key / 客户端 key / 管理员管理（构建为 public/admin.html）
panel/public/vendor/echarts.min.js 前端绘图库 ECharts 6.1.0（全量构建，Apache-2.0；懒加载，署名见 panel/public/vendor/README.md）
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

### 静态资源缓存与前端库升级

面板的 `panel/public/css`、`panel/public/js`（构建后服务在 `/css`、`/js`）沿用 `cache-control: no-cache`（改动即时生效）；`panel/public/vendor/` 下的
第三方库（文件名内嵌版本号）发 `public, max-age=31536000, immutable` 长缓存，避免 1.07MB 的 ECharts
每次都被重下。**升级库时必须改文件名或加版本参数**（如同名覆盖，老客户端会一直吃旧缓存），
详见 `panel/public/vendor/README.md`。

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

健康检查（liveness / readiness 是两个不同的东西，别混用）：

```bash
docker compose ps                          # 期望 core / gateway 两行都是 healthy
curl -s 127.0.0.1:3051/health              # {"ok":true,"accounts":N,"available":M}   ← liveness
curl -s 127.0.0.1:3051/ready               # {"ok":true,"upstream":"up",...}          ← readiness
```

- **`/health`（liveness）**：只说明「网关进程活着」。它**不探上游**，所以 core 崩溃 / OOM /
  断网时它照样 200。适合给「进程还在吗」这类存活告警用，**不适合**当「服务可用」的判据。
- **`/ready`（readiness）**：会真探一次 core（`UPSTREAM_PROXY_URL` 的 `/health`，2s 硬超时，
  结果缓存 1s 以免被高频轮询打爆 core）。core 可达 → `200 {"ok":true,"upstream":"up"}`；
  不可达 / 超时 → `503 {"ok":false,"upstream":"down"}`。
  **监控告警、反代摘流、以及「服务能不能用」的判断都看它。**
  compose 里两个容器的 healthcheck 分工：gateway 探 `/ready`（它是唯一知道 core 死活的角色），
  core 探自己的 `/health`（内核没有下游依赖，本仓库不改 vendor）。

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

- `http://127.0.0.1:3051/` —— **公开只读**看板（账号备注名 / keyId / 额度百分比与统计；`keyPrefix` 与完整 key 都不下发）。
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

**内存提示**：本机 2GB，已用四重封顶 —— `mem_limit`（core 512m / gateway 384m）+ `CC_MAX_BODY_MB`（默认 20）+ `CC_MAX_INFLIGHT`（默认 8）+ 网关自己的 `maxBodyBytes`（默认 8MB）/ `maxInflight`（默认 8）/ `maxConnections`（默认 512，慢连接上限）。公网/高并发还要另加 nginx 侧的连接数限制。

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
  "upstreamTimeoutMs": 300000,
  "sessionAffinityTtlMs": 1800000,
  "allowPassthrough": false,
  "publicDashboard": true,
  "maxBodyBytes": 8388608,
  "maxInflight": 8,
  "bodyReadTimeoutMs": 120000,
  "requestTimeoutMs": 180000,
  "maxConnections": 512,
  "scryptMaxQueue": 8,
  "logLevel": "info",
  "logFile": ""
}
```

**类型校验（M1）**：`config.json` 的取值不再原样塞进配置 —— 与环境变量走**同一套类型规则**
（boolean / number / string / list），所以写字符串 `"false"` 也会解析成布尔 `false`
（`"1"/"0"/"true"/"false"/"yes"/"no"/"on"/"off"` 均可；数字/数组字面量按对应类型解析）。

- **未知键**（拼错的键，如 `quoatPollIntervalMs`）会产生告警并在启动时打印，**不会**静默并入配置。
- **安全开关**（`publicDashboard` / `allowPassthrough` / `creditsProbeEnabled`）
  在 `config.json` 里给成**非布尔且无法无歧义解析**的值（数字、对象、数组、无法识别的字符串）时
  **直接拒绝启动**并报出「哪个键 / 期望什么类型 / 收到什么」，杜绝「以为关了其实没关」。
  因为网关对它们的判定是严格比较（如 `config.publicDashboard !== false`），字符串 `"false"`
  不等于布尔 `false` 会让开关被静默绕过。

- 额度轮询是**自适应**的：最近 `quotaActiveWindowMs`（默认 5 分钟）内有代理请求 → 用 `quotaActivePollIntervalMs`（默认 60 秒）同步 CC；一直空闲 → 退回 `quotaPollIntervalMs`（默认 600 秒）。实现是**单个自调度 `setTimeout`**，每轮跑完再决定下一次延迟；上一轮没跑完则跳过本轮。`quotaPollIntervalMs: 0` 表示**完全关闭**轮询（`quotaActivePollIntervalMs: 0` 则退化为纯空闲间隔）。
- `publicDashboard`（`PUBLIC_DASHBOARD`）：`1`（默认）让 `/` 与 `/api/status` 公开只读；`0` 则要求后台登录 session。
- 面板可见性只有 `PUBLIC_DASHBOARD` 一个开关：旧版那套「面板接口再要一个本地 `sk-cg-` key」的做法已彻底移除 —— 前台既没有 key 输入框，也不把任何凭证写进浏览器存储（`sessionStorage` / `localStorage` / cookie 都没有）。
- `upstreamTimeoutMs`（`UPSTREAM_TIMEOUT_MS`，默认 300000）：转到上游的请求超时（`src/proxy.mjs` 读取）。
- `bodyReadTimeoutMs`（`BODY_READ_TIMEOUT_MS`，默认 120000）：**整个请求体**的最坏读取期限。`bodyPeekStartMs`
  只管「首块之前」；客户端发 1 字节后停住时，这个期限到点会中止转发、回 **408** 并断开连接，同时释放在途名额
  （否则默认 `maxInflight=8` 的 8 个连接就能让 `/v1` 全线长时间 503）。120s ≈ 8MB 上限下 67KB/s 的最低上传速度。
- `requestTimeoutMs`（`REQUEST_TIMEOUT_MS`，默认 180000）：Node HTTP server 的 `requestTimeout`
  （收完整请求的总时限，Node 默认 300s）。显式设置且略大于 `bodyReadTimeoutMs`，让网关自己带统计/日志的
  408 先生效；实际生效值不会小于 `headersTimeout`。
- `maxConnections`（`MAX_CONNECTIONS`，默认 512）：Node HTTP server 的并发连接上限（Node 默认无限），
  防止慢连接把 socket 表打满。
- `scryptMaxQueue`（`SCRYPT_MAX_QUEUE`，默认 8）：scrypt 串行队列的深度上限（含正在执行的一次）。
  单线程 scrypt(N=2^16) 实测 ≈656ms（吞吐 ≈91 次/分钟），队列必须在深处拒绝而不是无限排队 ——
  超限**不排队**，直接回 **503**（`服务器繁忙`，附 `Retry-After`），避免合法管理员登录被 FIFO 阻塞。
  相应地把全局登录尝试上限（`LOGIN_GLOBAL_ATTEMPTS_PER_MINUTE` 未设置时）从历史的 `每来源×10=600`
  校准到 **90**（≈实测吞吐）。

环境变量覆盖：`MAX_INFLIGHT` `MAX_BODY_BYTES` `BODY_READ_TIMEOUT_MS` `REQUEST_TIMEOUT_MS` `MAX_CONNECTIONS` `SCRYPT_MAX_QUEUE` `GATEWAY_PORT` `GATEWAY_HOST` `UPSTREAM_PROXY_URL` `CC_API_BASE` `QUOTA_POLL_INTERVAL_MS` `QUOTA_ACTIVE_POLL_INTERVAL_MS` `QUOTA_ACTIVE_WINDOW_MS` `PAUSED_RECHECK_INTERVAL_MS` `QUOTA_TIMEOUT_MS` `UPSTREAM_TIMEOUT_MS` `SESSION_AFFINITY_TTL_MS` `MAX_BODY_BYTES` `ALLOW_PASSTHROUGH` `PUBLIC_DASHBOARD` `LOG_FILE` `LOG_LEVEL`。

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
| GET | `/health` | liveness：`{ ok, accounts, available }`，无需 key；**不探上游** |
| GET | `/ready` | readiness：探上游 core，可达 200 `{ ok, upstream:"up", … }`，不可达 503 `{ ok:false, upstream:"down" }` |
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
- 请求体读取有整体期限 `bodyReadTimeoutMs`（默认 120s）：客户端发到一半停住 → 中止转发并返回 **408**
  （`Request body timeout`，`connection: close`），不会永久占住 socket 与在途名额。
- 上游提前回 4xx/5xx（终态）时立刻停止请求体 tee 并丢弃剩余 body，内存不再随客户端上传增长。
- 在途请求上限 `maxInflight`（默认 8），超出返回 `503` + `Retry-After`。
- 上游把响应发到一半就断流时，网关**不会** `res.end()` 把半截内容伪装成完整的 200 —— 已写出的按连接异常 `res.destroy()` 中止，未写出的按 502，并计入 `stats.errors`。
- 客户端断开立刻 abort 上游。
- 上游 5xx / 超时 / 连接错误，且**尚未向客户端写出任何字节**时，换一个账号重试一次（最多一次）；已开始写响应一律不重试。
- 上游 4xx（含 401）原样透传状态码，body 里可能出现的 key 会被脱敏。

## 面板

浏览器打开 `http://127.0.0.1:3051/`：每个账号一张卡片，显示备注名、剩余额度、5h / 周 / 月进度条、暂停 / 限流 / 鉴权状态；顶部是账号数 / 可用数 / 暂停数 / 不可用数 / 总请求 / 错误数 / 累计 token，并提供「刷新额度」按钮（走公开的 `POST /api/accounts/refresh`，匿名可点、有节流）。前台卡片**不显示 key 的任何片段**（`keyId` / `keyPrefix` 都不渲染），`keyId · keyPrefix` 只在登录后的 `/admin` 账号表出现。

**面板默认公开只读，但只公开一个只读状态接口**：`PUBLIC_DASHBOARD=1`（默认）时 `/` 与 `/api/status` 无需任何凭证。公开的内容只有账号备注名、`keyId`（sha256 前 8 位）、额度百分比 / 剩余量 / 用量、暂停 / 限流 / 鉴权状态、请求与 token 统计；**不公开**完整 key、`keyPrefix`（真实 key 前 9 字符）、上游账号身份（`lastQuota.displayName`）、`lastError` / `lastErrorAt` 原文 —— 这些键在 `/api/status` 的公开视图里**不存在**（连键名都没有，不是 null），只有登录后的 `/api/admin/*` 才看全量。

要改配置、加账号、看运行日志，走 `/admin` 的账号密码登录（首次访问 `/admin` 初始化管理员）。`/api/admin/*` 一律要求登录 session，`sk-cg-` key 在那里无效；`/v1/*` 仍然只认 `keys.json` 里的 `sk-cg-` key。

**前台没有 key 输入框**，也不把任何凭证存进浏览器（没有 `sessionStorage` / `localStorage` / cookie）：公开面板的每个请求都只读、且不带任何 Authorization。额度由后端自适应轮询自动同步（活跃 60s / 空闲 600s），页面上那个「刷新额度」按钮只是手动催一次，走公开的 `POST /api/accounts/refresh`（匿名调用按来源 + 全局节流；它只是催一次后端轮询，本身不需要任何凭证）。若连只读面板也不想公开，设 `PUBLIC_DASHBOARD=0`（此时 `/` 与 `/api/status` 都要求登录后台）。

面板响应固定带 `X-Content-Type-Options: nosniff`。

## 测试与自测

```bash
npm run lint      # 零依赖静态检查（只用 node: 内置模块：node --check 语法 / debugger / .only( / console.log）
npm test          # node:test：本仓库测试（--test-concurrency=8 并发）+ vendor/commandcode-proxy 内核测试，离线可跑、不打真实网络
```

> **前端源码在 `panel/`（Astro 工程）**：仓库根的 `public/` 是 `panel/dist/` 同步出来的**构建产物，不进 git**。
> 改了 `panel/` 之后要先跑 `bash scripts/panel-build.sh`（或 `npm run panel:build`）把产物同步到 `public/`，**再**跑测试；
> 干净 checkout 下没构建时，网关的 `GET /` 会回 **503「面板未构建」**（`/health`、`/api/*` 不受影响），而不是裸 500。

手工联调（不碰真实 Command Code）：

```bash
node mocks/mock-cc-upstream.mjs &        # 假上游，默认 3099
# 用一份指向 mock 的配置起网关
node -e "import('./gateway.mjs').then(m=>m.startGateway({configPath:'config.local.json'}))" &
curl 127.0.0.1:3051/health
curl 127.0.0.1:3051/ready
```

`config.local.json` 只需把 `upstreamProxyUrl` / `ccApiBase` 指向 `http://127.0.0.1:3099`。

容器级冒烟（真起容器，验证 CMD/EXPOSE/HEALTHCHECK/面板骨架与一次真实 /v1 往返）：

```bash
bash scripts/smoke.sh                     # 需要本机有 docker；CI 的 smoke job 就是跑它
```

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

- 推 `master`/`main` 或打 `v*` 标签 → 先跑 `npm run lint`，再跑 `npm test`（本仓库测试 + `vendor/commandcode-proxy` 内核自带测试，两个目录都跑），通过后构建并推送两个镜像
- 构建时把 `node:22-alpine` 解析成 digest 传 `--build-arg BASE_IMAGE=...@sha256:...`，并传 `REVISION=$(git rev-parse HEAD)` 打成 OCI 标签
- 镜像：`ghcr.io/miku-hermes/cc-manage-gateway` 与 `ghcr.io/miku-hermes/cc-manage-core`
- 标签：`latest`（默认分支）、分支名、`v1.2.3` / `1.2`（打 tag 时）、`sha-<短哈希>`
- PR 只构建不推送；构建缓存走 GitHub Actions cache

> GHCR 包继承仓库可见性。换机器拉取需先 `docker login ghcr.io -u <用户名>`（PAT 勾 `read:packages`）。
