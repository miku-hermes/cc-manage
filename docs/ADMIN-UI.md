# 任务：给 cc-manage 加「后台管理页」+ 可写凭据（仿 komari 的 admin 后台）

## 背景

现在只有一个**只读展示面板**（`public/index.html`，已按 komari-mikus 樱花主题重做）。
后端只有三个只读接口：

```
GET  /api/status             状态
GET  /api/accounts           账号列表
POST /api/accounts/refresh   触发额度刷新
```

**缺一个真正的后台管理页**：能增删账号、改备注、启停账号、管理客户端 key、看运行日志。

用户已拍板：**做成可写，后台用本地 key 鉴权**（接受它暴露在公网 `https://cc.mikus.ink`）。

---

## 已实测的硬约束（重要，别踩）

我实测过两个坑，方案已定：

1. **单文件 bind mount 无法 rename** —— 容器内 `mv tmp accounts.json` 报 `Resource busy`，
   原地写报 `Read-only file system`（挂载是 `:ro`）。
   ➜ **解决**：凭据改成**目录挂载**。宿主 `./config/` → 容器 `/app/config`（可写），
   里面放 `accounts.json` + `keys.json`。目录挂载里 rename 实测 OK。

2. **写文件必须保持权限** —— 实测普通写入会把文件冲成 `644 root:root`。
   容器里跑的是 uid 1000（node），宿主要求 `1000:1000 / 640`。
   ➜ **解决**：写完后显式 `fs.chmodSync(file, 0o640)`。
   （宿主目录本身 `chown 1000:1000`，所以 owner 天然正确。）

---

## 要实现的功能

### A. 存储层改造（`src/store.mjs`）

**路径优先级**（向后兼容，别破坏现有单文件挂载的用户）：
```
accounts:  /app/config/accounts.json  存在就用它（可写）
           否则回落 ./accounts.json    （旧的只读方式，仍能读）
keys:      同逻辑
state.json 不变（已在可写的 data/ 卷里）
```

新增导出：
- `saveAccounts(list)` / `saveKeys(list)`
- `reload()` —— 重新读盘（用于后台改完后热生效）
- `writable()` —— 返回布尔，表示当前是否可写（单文件只读挂载时为 false）

**原子写**（沿用现有 `.tmp-<pid>-<ts>` + rename 套路），但：
- 写前对临时文件 `chmod 0640`
- rename 后对目标文件再 `chmod 0640`
- 失败时返回明确的错误（不要静默降级吞掉）

### B. 写接口（`gateway.mjs`）

全部要求**本地 key 鉴权**（复用现有 `PROTECT_ADMIN_API` + `localKeyIndexOf` 那套），
放在 `/api/admin/` 前缀下，与只读接口分开：

| 方法 | 路径 | 作用 |
|---|---|---|
| POST | `/api/admin/accounts` | 新增账号 `{name, key, enabled?}` |
| PATCH | `/api/admin/accounts/:keyId` | 改 `name` / `enabled` |
| DELETE | `/api/admin/accounts/:keyId` | 删账号 |
| POST | `/api/admin/keys` | 新增客户端 key `{name}`（**服务端生成** `sk-cg-` + 32 字节随机，只返回一次明文） |
| DELETE | `/api/admin/keys/:keyId` | 删客户端 key |
| GET | `/api/admin/events` | 最近事件（内存环形缓冲，最多 200 条） |

**校验规则**（不合法返回 400 + 中文错误信息）：
- 账号 `key` 必须以 `user_` 开头、长度 20-200、不能与现有账号重复
- 名称非空、长度 ≤ 64
- 客户端 key 由服务端生成（不接受用户传入明文）
- 不能删除最后一个可用账号（否则返回 409 并说明）

**热生效**：任何写操作成功后，自动 `reload()` 并刷新调度器账号池，
**不需要重启容器**。删除账号时要调用现有 `pruneState()` 清理残留状态。

**安全**：
- 所有响应**绝不**返回完整 key（只给 `keyId`/`keyPrefix`）
- 生成客户端 key 的那一次响应例外（必须返回明文，否则用户拿不到），
  但要在响应里带 `warning: "此 key 只显示一次"`，且日志里脱敏
- 写操作要记进事件缓冲（谁在什么时候加了/删了什么，key 用 keyId 表示）

**只读模式**：若 `writable()` 为 false（旧的单文件只读挂载），
所有写接口返回 **403** + 中文提示「凭据以只读方式挂载，无法修改；
请改用 config/ 目录挂载」。

### C. 后台页面（新增 `public/admin.html`）

在 `/admin` 提供（`gateway.mjs` 里加路由，读 `public/admin.html`，带 `nosniff`）。

**设计语言**：与前台面板一致（komari-mikus 樱花主题）——
沿用 `public/index.html` 里那套 CSS 变量（亮/暗双主题 + `data-theme` 切换 +
`prefers-color-scheme` 兜底），圆角卡片、发丝描边、粉色强调色 `#e8668a`。
**不要**再飘花瓣（后台求效率，静止即可）。

**布局**：
1. 顶部导航栏（同前台风格）：`cc-manage · 后台` + 返回前台链接 + 主题切换 +
   本地 key 输入框（`id="key" type="password"`）+ 保存按钮
2. **账号管理表**：每行 = 账号名 / keyId / keyPrefix / 状态（可用/暂停/鉴权失效）/
   操作按钮（启用停用、改备注、删除）
   - 顶部「+ 新增账号」按钮 → 弹窗填 `name` + `key`（textarea，提交后清空）
   - 删除要二次确认
3. **客户端 key 管理表**：名称 / keyId / keyPrefix / 创建时间 / 删除
   - 「+ 生成新 key」→ 生成后**用醒目样式展示一次性明文** + 复制按钮 +
     「我只在此显示一次」提示
4. **运行日志/事件**：最近 200 条的列表（时间 + 级别 + 消息），可按级别过滤

**技术要求**：
- 零外部依赖（不许 CDN/字体/npm），单文件
- 所有 API 数据渲染前必须转义（XSS）
- 沿用前台那套：`sessionStorage` 存 key、`apiFetch` 包装（带 `Authorization: Bearer`）
- 401 时给出友好提示；只读模式（403）时把所有写按钮置灰并显示原因
- 中文界面

---

## 硬约束：现有测试不能破

`test/gateway.test.mjs` 现有 **60 个测试必须全绿**。特别注意：

- **测试6**：`GET /` 返回的 HTML 必须含 `cc-manage`、`5 小时窗口`、`本周窗口`、`本月周期`、`/api/status`
- **测试32**：`GET /` 的 HTML 必须含 `<input id="key" type="password">`、`Authorization:`…`Bearer`、
  `sessionStorage`、`apiFetch('/api/status')`、`apiFetch('/api/accounts/refresh')`
  —— **这些是前台 `index.html` 的约束，别把前台改坏**
- **测试27**：`/api/status` 的字段结构不能改

**新增测试**（`test/store.test.mjs` 或新文件）覆盖：
- 账号增/改/删 + 热生效
- 重复 key 被拒、非法前缀被拒、空名称被拒
- 删最后一个账号被拒（409）
- 客户端 key 生成只在响应里出现一次、之后列表接口不再含明文
- 只读模式（单文件挂载）下写接口返回 403
- `/admin` 页面能打开且带 nosniff

---

## 交付

1. 改好的 `src/store.mjs`、`gateway.mjs`、新增 `public/admin.html`
2. `docker-compose.override.yml` 补上 `./config:/app/config` 目录挂载
3. **凭据迁移**：把现有 `accounts.json` / `keys.json` **移动**到 `config/` 目录
   （内容不变，保持 `1000:1000 / 640`），并更新 `.gitignore` 忽略 `config/`
4. `npm test` 全绿（60 旧的 + 新增）
5. 完成后 `git commit`，提交信息用中文说明这次加了什么

**不要**改 `vendor/`（MIT 上游内核，只读）。
**不要**为了过测试而修改或删除现有测试用例——如果确实需要调，先停下来在回复里说明原因。
