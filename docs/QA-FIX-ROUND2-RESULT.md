# 第二轮质检修复结果

按 `QA-FIX-ROUND2.md` 的优先级逐条修复。回归测试从 109 增至 **165**，`npm test` 全绿。

| 编号 | 结论 | 主要改动 | 回归测试 |
| --- | --- | --- | --- |
| F1 | 修 | `loadState` 对 `state.json` 损坏改为「丢弃 + warn + 重建」；`atomicWrite` 补 `fsync(fd)` + rename 后 `fsyncDir` | `test/store.test.mjs`（0 字节 / 截断 / 垃圾字节三种形态） |
| F2 | 修 | `pipeResponse` 区分 `end`（成功）与 `close/error`（截断）；截断时已写出字节 → `res.destroy()`，未写出 → 502，并计入 `stats.errors` | `test/proxy-fixes.test.mjs` F2 两条 |
| F3 | 修 | `stop()` 改为 `server.close()` → 最多等 5s → 兜底 `closeAllConnections()` | `test/security-fixes.test.mjs` F3 两条 |
| F4 | 修 | `isQuotaError` 只认明确额度语义；普通 429 走 `rateLimitedUntil`（60s 冷却），不写 `pausedUntil` | `test/scheduler.test.mjs` F4 三条、`test/proxy-fixes.test.mjs` F4 四条 |
| F5 | 修 | `drainRemaining` / `pipingBody` 超限时置 `complete`；重试前判 `tooLarge → 413`；无法完整拿到 body 时不再发空体 | `test/proxy-fixes.test.mjs` F5 三条 |
| F6 | 修 | `forward()` 接收 `sessionId`，换号成功后 `setAffinity` 指向真正服务的账号 | `test/proxy-fixes.test.mjs` F6 |
| F7 | 修 | `getAffinity` 命中时 `delete + set` 回写并刷新 `at`（真 LRU + TTL 续期） | `test/scheduler.test.mjs` F7 两条 |
| F8 | 修 | `runPausedRecheck()` 加 `recheckRunning` 守卫，与轮询器同款 | `test/security-fixes.test.mjs` F8 两条 |
| F9 | 修 | 上游 401/403 → `markAuthInvalid` + 触发一次额度刷新 | `test/proxy-fixes.test.mjs` F9 两条（401/403） |
| F10 | 修 | 全局统计一个请求只记一次；换号内部失败只记账号维度；客户端中止单独计 `stats.aborted` | `test/proxy-fixes.test.mjs` F10 两条、`test/store.test.mjs` F10 |
| F11 | 修 | `peekBody` 改为「拿到 session id / 读满 8KB / body 结束 / 首块后 150ms」四选一即放行 | `test/proxy-fixes.test.mjs` F11 |
| F12 | 修 | `loadState` 启动时清理同目录 `*.tmp-*` 残留 | `test/store.test.mjs` F12 |
| F13 | 修 | 统一安全响应头（CSP / X-Frame-Options / Referrer-Policy / 条件 HSTS）+ JSON `no-store`；CSP 放行内联脚本/样式 | `test/security-fixes.test.mjs` F13 三条（用 Node DOM 垫片真跑内联脚本验证渲染与取数） |
| F14 | 修 | 登录限速改为**按用户名**锁定 + 指数退避；来源只统计不锁定；继续不信任 XFF | `test/security-fixes.test.mjs` F14 三条 |
| F15 | 修 | 会话吊销（sid 黑名单 + 每用户会话版本号 `sv`）持久化到 `config/revoked.json` | `test/security-fixes.test.mjs` F15 三条（含跨重启端到端） |
| F16 | 修 | 默认 N 提到 2^16；校验只接受白名单档位 N∈{2^14,2^15,2^16} / r=8 / p=1，拒绝时廉价返回 | `test/security-fixes.test.mjs` F16 三条、`test/auth.test.mjs` |
| F17 | 修 | `sign()` 清理过期 sid；限速表给 locked 项也做清理并加硬上限 | `test/security-fixes.test.mjs` F17、`test/scheduler.test.mjs` F17 |
| F18 | 修 | 新增 `maxInflight`（默认 8，超出 503 + Retry-After）；`maxBodyBytes` 收到 8MB | `test/proxy-fixes.test.mjs` F18 两条、`test/deploy.test.mjs` |
| F19 | 修 | 畸形 JSON 只回通用文案，不再回显请求体 | `test/security-fixes.test.mjs` F19 |
| F20 | 修 | 匿名刷新节流按来源分桶 + 全局兜底间隔 + 表上限 | `test/security-fixes.test.mjs` F20 两条 |
| F21 | 修 | 改**他人**密码需当前管理员重新输入自己的口令；改自己保持向后兼容 | `test/security-fixes.test.mjs` F21 两条、`test/auth.test.mjs` |
| F22 | 修 | `.dockerignore` 补 `config/`、`users.json`、`session-secret`、`revoked.json`、`docker-compose*.yml` | `test/deploy.test.mjs` |
| F23 | 修 | `.gitignore` 改 `config/*` + `!config/*.example.json`，补 `*.bak` | `test/deploy.test.mjs` |
| F24 | 修 | compose 给 core / gateway 加 `user: "1000:1000"`、`cap_drop: [ALL]`、`no-new-privileges:true`（已实测 core 正常监听 3050） | `test/deploy.test.mjs` |
| F25 | 修 | 两个 service 加 `logging: json-file / 10m / 3` | `test/deploy.test.mjs` |

## 已被改写的旧测试

- `test/auth.test.mjs`「管理员管理：新增 / 改密码 / 删除」：原先断言「admin 直接 PATCH 他人密码 → 200」，
  那正是 F21 的漏洞行为，已改为断言 403（并补上带正确口令 → 200 的正向路径）。
