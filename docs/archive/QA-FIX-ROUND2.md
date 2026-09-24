# 质检修复任务书（第二轮）

针对 4 路并行审计的**已复现**发现逐条修复。每条都带真实复现证据，不是推测。

**硬约束**：107 个测试必须全绿（`npm test`，当前 107/107）。零外部依赖。
**不要装任何 npm 包**（尤其不要 playwright）。不改 `vendor/`。每条都要加回归测试。

---

## P0 · 可用性（服务会挂 / 数据会丢）

### F1. `data/state.json` 损坏 → 网关永远起不来（crash-loop）
`src/store.mjs:43-49`（`readJSON` 解析失败直接 throw）+ `store.mjs:274-292`（`loadState`）
+ `gateway.mjs` 中 `store.loadState(accounts)` 在 `server.listen` 之前。

state.json 只是额度快照/统计的**缓存**，内容全丢也不该致命。但一行解析失败就让
`startGateway()` 抛异常 → 配合 compose `restart: unless-stopped` 进入死循环，
整个服务（含反代入口）下线，必须人工删文件才能恢复。

**已复现**：
```
[0 字节（断电后典型形态）] ❌ 启动失败: state.json 解析失败: Unexpected end of JSON input
[截断 JSON]                ❌ 启动失败: state.json 解析失败: Expected property name...
[垃圾字节]                 ❌ 启动失败: state.json 解析失败: Unexpected token '\u0000'
```
**修**：`loadState` 对 state.json 用「损坏即丢弃 + warn + 重写默认值」，绝不阻塞启动。
同时给 `atomicWrite`（`store.mjs:23-41`）补 `fsync(fd)` + rename 后 fsync 目录
——现在全程无 fsync，ext4 延迟分配下掉电产生 0 字节文件正是上面第一种形态。

### F2. 上游响应流中途断开 → 客户端收到 200 + 截断内容，统计还记成功
`src/proxy.mjs:92-98`（`onClose = () => finish()` 把 `destroy()` 的 close 当正常结束）
+ `proxy.mjs:431-433`（`res.end()` + `bump(false)`）

上游中途断开（上游重启/网络抖动/内核被 OOM kill）时网关把已收到的半截字节 `res.end()`
收尾 → 分块传输"正常"结束 → 客户端看到**完整的 200 SSE**，回答被静默截断且无任何错误信号。
被 vendor 的内核自己反而有测试明确要求「不能谎报成功」，网关这一层把该语义吞掉了。

**已复现**：
```
[warn] 上游响应中断: aborted
客户端: status=200  body="data: partial-1\n\n"  aborted=false
统计: total=1 errors=0 | 账号 lastError 均为 null
```
**修**：区分「`end` 到达」与「`close/error` 提前到达」；后者视为失败 ——
尚未向客户端写出字节则按现有逻辑重试/502；已写出字节则 `res.destroy()`
让下游看到连接异常，并计入 `stats.errors`。

### F3. 优雅关闭立刻掐断在途请求
`gateway.mjs` 的 `stop()` 第一件事是 `server.closeAllConnections()`，无条件强制关闭
**所有**活动连接（含正在流式返回的 LLM 响应）。`docker stop` 的 10s 宽限期形同虚设。

**修**：`server.close()`（停止收新连接）→ 等在途完成，或用 5s 计时器兜底后再
`closeAllConnections()`。不要在第一步就清连接。

---

## P1 · 正确性

### F4. 429（普通限流）被当成额度耗尽 → 账号被停 5 小时
`src/scheduler.mjs:23-27`（`isQuotaError`：429 + `/quota|limit|exceeded/i` 匹配**整个 body**）
+ `src/proxy.mjs:388-392`（命中即 `pauseForQuota`）+ `scheduler.mjs:149-155`（无 resetAt → `now+5h`）

`"Rate limit exceeded"` 这种普通限流措辞、甚至 `type:"rate_limit"` 这个字段名都含 `limit`
→ 一次瞬时限流就把账号判定为「5 小时额度耗尽」。多账号池会把流量全压到其它账号，
单账号池直接变 503。**注意：这可能就是线上「副号被暂停到 03:39」的真正原因。**

**已复现**（上游返回 `429 {"error":{"message":"Rate limit exceeded, retry later","type":"rate_limit"}}`）：
```
客户端 status=429 | 账号A available=false paused=true pausedUntil=+5h
```
**修**：429 只在 body 明确出现额度语义（`quota` / `windowLimits` / `quota_exceeded`）时
才暂停；其余 429 按「可重试的限流」处理（记错误 + 透传或短暂冷却，而非 5h 停用）。

### F5. 换号重试时请求体被丢成空体，并且绕过了 413
`src/proxy.mjs:177-202`（`drainRemaining` 超限分支只置 `tooLarge`，**不置 `complete`**）
+ `proxy.mjs:334-338`（重试分支：`bodyState.complete` 为假就 `upstreamReq.end()` 发空体）
+ `proxy.mjs:351-355`（`tooLarge` 只在 attempt 0 的 `!upstreamRes` 分支判 413）

上游在请求体没传完时就失败（秒回 5xx）时，网关会先排空下游剩余 body 以便重放；
一旦超 `maxBodyBytes`，`complete` 仍是 false → **第 2 个账号收到空请求体**，
且因为不再检查 `tooLarge`，客户端也拿不到 413。用户发 20 万字节 prompt，
上游收到 0 字节并正常回 200 → 用户拿到与请求无关的「成功」响应。

**已复现**（`maxBodyBytes=100000`，客户端分片发 200000B，上游第 1 次秒回 503）：
```
客户端 status=200
上游两次实收字节: [66000, 0]   ← 第 2 次收到 0 字节
```
**修**：`drainRemaining` 超限时置 `tooLarge`；重试前判 `tooLarge → 413`；
重试分支在 `!bodyState?.complete` 时不要发空体，直接 502/413。

### F6. 换号重试成功后 `sessionAffinity` 仍指向旧账号 → 粘性失效
`src/proxy.mjs:286-294`（`account = next`）+ `:209-213`（`pickRetryAccount` 不写 affinity）
+ `scheduler.mjs:58-67`（`setAffinity` 只有 `select()` 会调）

第 1 个账号 5xx 后换到 B 并成功返回，但 affinity 仍记录 A → 同 session 的下个请求
又粘回 A。带工具调用/多轮历史的会话等于账号与上下文随机跳号。

**已复现**：
```
第 1 次: c3d41fec -> b95ab2ee（真正服务的是后者）
第 2 次选中: c3d41fec   ❌ 粘性仍是旧账号
```
**修**：换号成功后 `scheduler.setAffinity(sessionId, current.keyId, now)`（把 sessionId 传进 forward）。

### F7. `sessionAffinity` 命中不刷新 TTL，淘汰也不是注释所称的 LRU
`src/scheduler.mjs:39`（注释自称「插入顺序 = LRU，命中时 delete+set 移到末尾」）
+ `:46-56`（`getAffinity` 命中只读、不更新 `at`、不动位次）+ `:63-66`（按插入顺序淘汰）

① TTL 从建立时刻起算 → 30 分钟持续活跃的会话仍会中途掉亲和性；
② 上限淘汰按插入顺序 → **最热（刚被命中）的条目最先被淘汰**，与注释和 SPEC 都不符。

**已复现**：
```
命中不刷新时间戳 → t=400 时已未命中
上限 3：刚被命中的 s1 被淘汰，s2 仍在
```
**修**：`getAffinity` 命中时 `delete + set` 回写并更新 `at`（实现注释所述的 LRU）。

### F8. `recheckPaused` 定时器无互斥 → 额度查询被放大
`gateway.mjs` 的 `setInterval(recheckPaused)`（轮询器有 `isBusy` 保护，它没有）
+ `scheduler.mjs:170-196`

对 N 个账号串行 4 次上游调用，慢时单轮远超间隔；`setInterval` 不等待，
前一轮未完成时后续 tick 会对同一账号重复查询 → 放大 CC API 压力并触发对方限流。

**已复现**（间隔 150ms、单账号单轮各 600ms）：3 秒内上游被调用 **55 次**（下界约 8 次）。
**修**：加与轮询器同款的 `running` 守卫。

### F9. 上游 401/403 不置 `authInvalid`，失效账号会一直被调度
`src/proxy.mjs:384-395`（4xx 分支只 `recordError`）+ `scheduler.mjs:78-86,140-145`
（`authInvalid` 只能由额度轮询写）

账号 key 被吊销时，反代路径的 401 只写 `lastError`，账号仍 `available=true` 被继续选中、
把 401 透传给客户端 —— 池里有健康账号也不用。要等额度轮询（空闲 600s）才纠正，
存在最长 ~10 分钟窗口。

**已复现**：`账号A available=true authInvalid=false lastError="上游 HTTP 401"`，`summary.available=2`
**修**：4xx 分支里对 401/403 标记 `authInvalid`（并顺带触发一次额度刷新）。

### F10. 统计口径不自洽
`src/proxy.mjs:357-358` / `377-378`（换号时 `bumpAccountError` + 最终 `bump(true)`）
+ `:433`（中止路径 `bump(false)`）

① 换号失败 + 最终成功 → 面板出现 `errors(2) > 总请求数(1)`；
② 客户端主动中止（长回答被 Ctrl-C，很常见）被算作**成功**请求，错误率被系统性低估。

**已复现**：超时换号 → `total=1 errors=2`；客户端中止 → `total=1 errors=0`（记为成功）。
**修**：一个请求只计一次结果；换号内部失败只记账号维度；中止单独计数（如 `aborted`）。

### F11. 请求体先被 peek 缓冲，body 未结束前不建立上游连接
`gateway.mjs` 的 `peekBody`（读满 64KB 或等 body 结束才 resolve）+ `proxy.mjs:112-174`
（`pipingBody` 同时把 body tee 进 `state.chunks` 供重试）

SPEC §7 要求「流式透传」，实际是「先收满 64KB/等 body 结束再开始转发」。
小 body 无感知，慢速/大 body 客户端下上游连接与首字节被推迟到 body 发完之后。
叠加 tee 后每个在途请求最多驻留 `maxBodyBytes`（默认 20MB）在内存里，
而网关容器 `mem_limit: 256m` + `--max-old-space-size=192`，**并发大上传有 OOM 风险**。

**已复现**（客户端分片 800ms 间隔发 1KB body）：t=500ms 上游收到请求数 = 0；
上游首次收到数据在 t=2403ms（≈ body 发完时刻）。
**修**：取 session id 只需首块（4-8KB），取到就立刻转发；或给 tee 设独立的更小上限。

### F12. 崩溃残留的 `*.tmp-*` 文件永不清理
`src/store.mjs:25,34`（临时文件名 `file.tmp-<pid>-<ts>`，只在 catch 里删）
**已复现**：预置残留 tmp 后启动 → `data/` 里 `state.json.tmp-999-1700000000000` 仍在。
**修**：启动时清理同目录下匹配 `*.tmp-*` 的陈旧文件。

---

## P2 · 安全加固

### F13. 缺失全部安全响应头
`gateway.mjs` 的 `/` 与 `/admin` 只设 `x-content-type-options: nosniff`；
全仓库无 CSP / X-Frame-Options / HSTS / Referrer-Policy。

**已复现**：`GET /` → 200，headers 只有 `{"xcto":"nosniff"}`。
**修**：统一加
`Content-Security-Policy: default-src 'self'; frame-ancestors 'none'`、
`X-Frame-Options: DENY`、`Referrer-Policy: no-referrer`、`Strict-Transport-Security`；
管理端 JSON 响应加 `Cache-Control: no-store`。

⚠️ 加 CSP 前先确认两个 HTML 没有内联 `<script>` 之外的资源需求
（现在是单文件内联脚本，`default-src 'self'` 会**禁止内联脚本** → 面板会白屏！）。
若页面有内联 `<script>`，必须用 `'unsafe-inline'` 或改 nonce/hash。
**务必实测两个页面加完 CSP 后仍能正常渲染和取数**，别只看响应头。

### F14. 登录限速按 socket 地址分桶：反代后全局单桶
`gateway.mjs` 的 `clientIp` 只取 `req.socket.remoteAddress`；部署是 openresty 反代
→ 所有公网客户端共用同一地址 → **任意匿名者对 `/api/auth/login` 发 5 次错密码，
就能把管理员锁在门外 5 分钟**（用正确密码也是 429）；每 5 分钟重发即可无限期拒绝。

**已复现**：锁定后正确密码 → `429 {"message":"登录失败次数过多…","retryAfterMs":299997}`。
**修**：改为**按用户名 + 全局**计数并加指数退避；至少不要让反代后的单一 socket 桶
能被匿名者用来锁死管理员。注意保持「不信任可伪造的 XFF」这条现有正确行为
（已实测换 XFF 无法绕过限速，这点是对的，别改坏）。

### F15. 会话撤销表只在内存 → 重启后已失效 token 复活
`src/auth.mjs:119-127`（自包含 cookie + 内存 `revoked`/`byUser`），TTL 7 天。

登出或被改密码踢掉的 cookie，只要网关重启过（部署/升级/崩溃重启 —— F? 的 DoS 让
任何人都能触发重启！）就重新有效，最长可再用 7 天。

**已复现**：logout 后同进程内重放旧 cookie → 401；SIGKILL 重启后重放同一 cookie → **200**。
**修**：把撤销信息持久化到 `config/`（或按用户的 `sv` 版本号），或登出/改密码时轮换
`session-secret`。

### F16. scrypt 参数偏低 + 校验时完全信任 stored 里的 N/r/p
`src/auth.mjs:14-21`（N=16384/r=8/p=1）+ `:43-62`（从字符串解析 N/r/p，上限
`N ≤ 2^20`、`r ≤ 32`，`maxmem = 256*N*r`）

(a) 16 MiB / ~57ms 低于 OWASP 现行建议（N=2^17）；
(b) 参数取自被校验的字符串本身 → `N=2^20, r=32` 会请求 4 GiB 并长时间阻塞事件循环
（容器 `mem_limit: 256m` → OOM/重启）。

**已复现**：`N=262144,r=8` → 1101ms 事件循环阻塞；`N=1048576,r=32` → 请求 4 GiB。
**修**：N 提到 2^16~2^17（同步调大 `maxmem`）；校验前把 N/r/p 限制在**白名单固定档位**。

### F17. 会话表 / 限速表内存清理不完整
`src/auth.mjs:126-127`（`byUser`）+ `:129-132`（`prune` 只管 `revoked`）
+ `:218-224`（限速表 `prune` 只在非 locked 分支调用且**跳过 locked 项**）

**已复现**：为 admin 签发 5000 个已过期 token 后 `revokeUser` → 仍返回 5000（无 TTL 清理）；
600 个不同源地址全部 locked → 表内条目全部留存。
**修**：`sign()` 时清理过期 sid；`prune()` 在 locked 分支也调用并给 `hits` 加硬上限。

### F18. 网关无并发上限 + 请求体全量驻留内存
`proxy.mjs` 的 tee 上限 `maxBodyBytes=20MB`；对照 core 有 `CC_MAX_INFLIGHT=8`，
**gateway 没有任何在途请求上限**。
**修**：加在途上限（4~8）+ 把 `maxBodyBytes` 收到 4~8MB，或让 tee 缓冲只在重试窗口内存留。
（本机 1.9GB 内存、swap 已用 1.46GB，这是真实隐患。）

### F19. 请求体 JSON 解析错误会回显请求体内容
`gateway.mjs` 的 `请求体不是合法 JSON: ${e.message}` —— e.message 里带用户提交的原文
（实测：提交 `SECRETBODY{{{` → 响应回显 `Unexpected token 'S', "SECRETBODY{{{"`）。
**修**：只回通用文案。

### F20. 匿名可 `POST /api/accounts/refresh`，节流是全局单变量
`gateway.mjs` 的节流用 `lastPublicRefreshAt` 单变量 → 攻击者可稳定每 5 秒触发一轮
全账号上游查询（放大对 CC API 的调用），并顺带把节流位长期占住。
**修**：至少让节流按来源分桶，或给该接口加更严格的限制。

### F21. 任一管理员可无二次确认重置他人密码
`gateway.mjs` 的 `PATCH /api/admin/users/:username` 只要 `password`，不校验旧口令。
**已复现**：admin 直接 PATCH victim 密码 → 200；用新密码登录 victim → 200；
admin 自己的 cookie 仍有效（改他人密码不会踢掉攻击者）。
**修**：改**他人**密码需当前管理员重新输入自己的口令。

---

## P3 · 部署（配 compose / Dockerfile / CI，别在容器里装东西）

### F22. `.dockerignore` 未覆盖 `config/`
现有 `.dockerignore` 有 `accounts.json`/`keys.json`/`config.local.json`，
但**缺 `config/`、`users.json`、`session-secret`**。

当前 Dockerfile 只 COPY 必要文件所以镜像层干净（已用 `docker image history` 证实
无 config、无 .git），但一旦有人改成 `COPY . .`，含密码哈希的 users.json 与
cookie 签名密钥会直接进镜像并推到 **PUBLIC** 的 GHCR。
**修**：`.dockerignore` 补 `config/`、`users.json`、`session-secret`、`docker-compose*.yml`。

### F23. `.gitignore` 用非锚定文件名模式
`accounts.json`/`keys.json`/`users.json`/`session-secret` 裸模式确实覆盖了 config/ 下这 4 个
（`git check-ignore` 已验证命中），但 `config/` 目录本身无规则 →
`config/state.json`、`*.bak` 等新文件不会被忽略。
**修**：补 `config/` 规则（保留 `!config/*.example.json`）与 `*.bak`。

### F24. 内核容器以 root 运行
`vendor/commandcode-proxy/Dockerfile` 无 `USER` 指令 —— ⚠️ **但这是 vendor 目录，
按约定不要改它**。改为在 `docker-compose.yml` 里给 core 服务加
`user: "1000:1000"`（或 node）、`cap_drop: [ALL]`、`security_opt: [no-new-privileges:true]`，
并确认 core 仍能正常启动监听 3050（要实测）。

### F25. compose 缺日志轮转 / CPU 限制
两容器 `LogConfig={"Type":"json-file","Config":{}}`，无上限；宿主无 `/etc/docker/daemon.json`。
**修**：给两个 service 加 `logging: {driver: json-file, options: {max-size: "10m", max-file: "3"}}`。

---

## 交付要求

1. **`npm test` 必须全绿**（当前 107）。每条修复都要有对应回归测试。
2. 修完后 `docker compose build gateway && docker compose up -d --force-recreate gateway`，
   并用 curl 实测：面板 200 + `/api/status` 200 + 畸形 Host 不再打挂 + CSP 已生效且页面能渲染。
3. **不要装任何 npm 包，不要用 playwright**（用户明令 docker-only、零依赖）。
   验证一律用 curl + node 脚本。
4. **改动不要回显任何真实密钥**。
5. `git commit`，中文提交信息。提交信息里逐条列「修了什么 + 证据」。

**优先级**：F1/F2/F3（可用性）> F4/F5/F6（正确性）> F13/F14/F15（安全）
> 其余。若时间不够，按此顺序做，并在回复里说明哪些没做完。