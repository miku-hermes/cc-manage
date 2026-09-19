# cc-manage Docker 封装规格（SPEC.md 的补充任务书）

> 本文件是**增量任务书**，与 `SPEC.md` 同权。已有代码（`gateway.mjs` / `src/*` / `public/` / `test/`）已经验收通过
> （`npm test` 50/50 全绿，反代/流式/脱敏/面板均实测通过），**不要推倒重写，只做本文件要求的增量**。

---

## 0. 目标

让整套链路（网关 + 协议内核）**一键 docker compose 起**，并且**密钥永不进镜像**。

```
                ┌─────────────────────── docker compose ───────────────────────┐
客户端 ──────►  │  gateway 容器 (3051)  ──►  core 容器 (3050)  ──►  CC 上游      │
                │  ↑选号/额度/面板           ↑协议翻译（vendor 内核）             │
                └──────────────────────────────────────────────────────────────┘
                    宿主只映射 127.0.0.1:3051，core 不对外映射
```

## 1. 交付物

1. `Dockerfile`（网关镜像，构建上下文 = 仓库根）
2. `docker-compose.yml`（两个服务：`core` + `gateway`）
3. `.dockerignore`（仓库根，必须排除密钥）
4. `.env.example`（compose 用的可调项）
5. `keys.example.json`（本地 key 模板，新增）
6. `README.md` 增加「Docker 部署」章节
7. `src/store.mjs` 一处健壮性小改（见 §4）
8. `.gitignore` 补上 `data/`、`.env`（若已有则跳过）

## 2. `Dockerfile`（网关镜像）

```dockerfile
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
# 只 COPY 运行必需的，禁止 `COPY . .`
COPY package.json gateway.mjs ./
COPY src/ ./src/
COPY public/ ./public/
RUN mkdir -p /app/data && chown -R node:node /app
USER node
EXPOSE 3051
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q --spider http://127.0.0.1:3051/health || exit 1
CMD ["node", "gateway.mjs"]
```

硬性要求：
- **绝对不许**把 `accounts.json` / `keys.json` / `config.local.json` / `data/` 复制进镜像。
- 不许把 `vendor/`、`test/`、`mocks/` 复制进网关镜像。
- 以 `node` 用户（非 root）运行。

## 3. `docker-compose.yml`

顶层写 `name: cc-manage`；**不要写 `version:` 字段**（compose v2+ 已废弃）。

```yaml
name: cc-manage

services:
  core:
    build: ./vendor/commandcode-proxy
    environment:
      PORT: "3050"
      HOST: "0.0.0.0"
      CC_MAX_BODY_MB: "${CC_MAX_BODY_MB:-20}"     # 2GB 小机器必须压小，见内核 README 内存章节
      CC_MAX_INFLIGHT: "${CC_MAX_INFLIGHT:-8}"
      NODE_OPTIONS: "--max-old-space-size=384"
    # 刻意不映射宿主端口：core 只允许网关容器访问
    mem_limit: 512m
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "wget", "-q", "--spider", "http://127.0.0.1:3050/health"]
      interval: 30s
      timeout: 3s
      retries: 3
      start_period: 10s

  gateway:
    build: .
    depends_on:
      core:
        condition: service_healthy
    ports:
      - "127.0.0.1:${GATEWAY_BIND_PORT:-3051}:3051"   # 只绑宿主回环，默认不对外
    environment:
      GATEWAY_HOST: "0.0.0.0"          # 容器内必须监听 0.0.0.0，宿主侧已限制为 127.0.0.1
      GATEWAY_PORT: "3051"
      UPSTREAM_PROXY_URL: "http://core:3050"
      CC_API_BASE: "${CC_API_BASE:-https://api.commandcode.ai}"
      PROTECT_ADMIN_API: "${PROTECT_ADMIN_API:-1}"     # 容器内绑 0.0.0.0，默认开启保护
      QUOTA_POLL_INTERVAL_MS: "${QUOTA_POLL_INTERVAL_MS:-300000}"
      LOG_LEVEL: "${LOG_LEVEL:-info}"
      NODE_OPTIONS: "--max-old-space-size=192"
    volumes:
      - ./accounts.json:/app/accounts.json:ro          # 只读挂载，密钥不进镜像
      - ./keys.json:/app/keys.json:ro
      - cc-manage-data:/app/data                       # 命名卷，避免宿主目录权限坑
    mem_limit: 256m
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "wget", "-q", "--spider", "http://127.0.0.1:3051/health"]
      interval: 30s
      timeout: 3s
      retries: 3
      start_period: 10s

volumes:
  cc-manage-data:
```

说明（要写进 README）：
- `core` **不映射宿主端口**是刻意设计：内核本身不做账号池，暴露出去等于绕过网关直接用一个 key。
- 宿主只绑 `127.0.0.1:3051`，公网访问需要你自己在前面再放一个 nginx（README 里给一句提示即可，不用展开）。
- `PROTECT_ADMIN_API=1` 时面板/管理 API 也要带 `sk-cg-` key；如果你只在宿主本机用、想要面板免密，
  用环境变量覆盖 `PROTECT_ADMIN_API=0` 并在 README 里写明风险（同机其他用户可读）。

## 4. `src/store.mjs` 健壮性小改

`data/` 目录不可写时（例如挂载成只读）：**打一条 warn 日志并降级为纯内存模式继续运行，不许启动失败**。
（只读挂载、SELinux、宿主权限不对都可能触发；网关的额度状态是可重建的，不该因此拒绝启动。）

改完必须保证 `npm test` 仍然 50/50 全绿。

## 5. `.dockerignore`（仓库根）

至少要排除（防止密钥/无关文件进构建上下文）：

```
.git
.gitignore
node_modules
data
test
spec   # 若有
mocks
vendor
SPEC.md
DOCKER.md
*.log
.env
accounts.json
keys.json
config.local.json
```

> 注意：`vendor/` 必须排除——网关镜像不需要内核源码，它的构建上下文是 `./vendor/commandcode-proxy` 独立一份。

## 6. `.env.example`

```
# 宿主侧监听端口（仅绑 127.0.0.1）
GATEWAY_BIND_PORT=3051
# 上游地址
CC_API_BASE=https://api.commandcode.ai
# 管理 API 是否要求本地 key（1=要求；只在 127.0.0.1 自用时可设 0）
PROTECT_ADMIN_API=1
# 额度轮询间隔（毫秒）
QUOTA_POLL_INTERVAL_MS=300000
# 内核限流（小内存机器必调）
CC_MAX_BODY_MB=20
CC_MAX_INFLIGHT=8
LOG_LEVEL=info
```

## 7. `keys.example.json`

```json
{
  "keys": [
    { "name": "替换成你的客户端名", "key": "sk-cg-请改成你自己的随机串" }
  ]
}
```

## 8. README「Docker 部署」章节必须包含

1. 前置准备：`cp accounts.example.json accounts.json` 填真 key；`cp keys.example.json keys.json` 造本地 key（给出 `openssl rand -hex 24` 之类生成命令）。
2. `cp .env.example .env`（可选调参）。
3. `docker compose up -d --build`。
4. 健康检查：`docker compose ps`（期望两行 healthy）+ `curl -s 127.0.0.1:3051/health`。
5. 调用示例：带 `Authorization: Bearer sk-cg-xxx` 打 `/v1/chat/completions`（流式给一条 `curl -N`）。
6. 面板：`http://127.0.0.1:3051/`（带 key 访问的说明；`PROTECT_ADMIN_API=0` 时免密）。
7. **密钥安全说明**：key 只通过只读 bind mount 进容器，镜像内 `/app` 不含任何密钥文件；换 key 只需改宿主文件后 `docker compose restart gateway`。
8. 日志与排障：`docker compose logs -f gateway` / `core`；常见坑（端口占用、`core` 未 healthy 时 gateway 会等）。
9. 内存提示：本机 2GB，已通过 `mem_limit` + `CC_MAX_BODY_MB` + `CC_MAX_INFLIGHT` 三重封顶；公网/高并发要另加 nginx 限制。

## 9. 验收（我会亲手跑，请你自己先跑一遍并把真实输出贴回来）

1. `docker compose config -q` 无报错。
2. `docker compose build` 两个镜像都构建成功。
3. `docker compose up -d` 后 `docker compose ps` 两个服务都是 `healthy`。
4. `curl -s 127.0.0.1:3051/health` 返回 `{"ok":true,...}`。
5. 带 `sk-cg-` key（`keys.json` 里那把）打 `POST /v1/chat/completions`，用 `accounts.json` 里的假 `user_` key →
   期望链路真的打到 CC 上游并返回 **401**（证明 core 收到了转发的请求且鉴权被替换），
   同时 `docker compose logs core` 能看到该请求到达。
6. **密钥不进镜像**验证：
   `docker run --rm --entrypoint sh <gateway镜像名> -c 'ls -a /app; grep -rIl "user_" /app 2>/dev/null || echo NO_KEY_LEAK'`
   → 必须输出 `NO_KEY_LEAK`，且 `/app` 下**没有** `accounts.json` / `keys.json` / `config.local.json`。
7. `docker compose down` 清理干净（**不要**用 `down -v`，除非你明确想删数据卷）。
8. 报告两个镜像的 `docker images` 大小。

## 10. 不许做的事

- 不许把密钥或 `data/` 打进任何镜像层。
- 不许给 `core` 映射宿主端口（要保持内部访问）。
- 不许引入任何 npm 依赖。
- 不许修改 `vendor/commandcode-proxy/` 下的文件（它的 `Dockerfile` 直接复用）。
- 不许改动已有测试的期望值来"让测试变绿"。
- 不许引入 nginx/其他第三方容器进这个 compose（网关自身够用，公网反代交给用户自己）。
