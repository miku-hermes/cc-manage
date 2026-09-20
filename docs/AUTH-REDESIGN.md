# 任务：把 cc-manage 的鉴权改成「后台账号密码登录」，并整理 key 管理

## 用户的原始反馈（要解决的问题）

> "我没看懂你这个面板为什么要本地 key？按我的想法不应该有登录后台的账号和密码，
> 然后的话添加 command code key 的事情不应该在后台吗？"

**当前设计的毛病**（要修掉）：

1. **概念混用**：让用户往面板里粘 `sk-cg-*` 客户端 key 才能看数据。
   这个 key 本来是**给程序调用 API 用的**（相当于 API token），
   而「打开后台页面」是**人**的操作，应该用**账号 + 密码**登录。
2. **Command Code key 的添加错位**：CC 上游 key 现在得手工改 `config/accounts.json`
   文件才能加（虽然上一版做了 `/api/admin/accounts` 接口，但入口是个需要先填
   `sk-cg-` 的表单，体验割裂）。
3. **前台面板也要 key 才能看**：不合理——公开看板不该要密钥。

## 目标设计

### 一、两套凭据，职责分清

| 凭据 | 谁用 | 存在哪 | 用途 |
|---|---|---|---|
| **后台账号 + 密码** | 人（浏览器登录） | `config/users.json` | 登录 `/admin` 后台 |
| **客户端 API key**（`sk-cg-*`） | 程序（curl / SDK） | `config/keys.json` | 调用 `/v1/*` 反代接口 |

**互不混用**：后台登录用 session cookie，不再用 `sk-cg-`；
`sk-cg-` 只管 API 调用，不进后台页面。

### 二、后台登录（`/admin`）

**首次使用**：`config/users.json` 不存在或为空时，访问 `/admin` 显示**初始化页**，
让用户设第一个管理员账号密码（setup 完成后此接口永久关闭，返回 403）。

**登录流程**：
```
GET  /admin            → 未登录：登录页；已登录：后台
POST /api/auth/login   → {username, password} → 设 session cookie（HttpOnly）
POST /api/auth/logout  → 清 cookie
GET  /api/auth/me      → 当前登录状态
```

**实现要求**：
- 密码**必须**用 `scrypt`（`node:crypto` 内置，零依赖）加盐哈希存储，
  **绝不存明文**。存储格式建议：`scrypt$N$r$p$<salt-b64>$<hash-b64>`
- 校验用 `timingSafeEqual`
- session 用**签名 cookie**（HMAC-SHA256，密钥由 `config/session-secret` 持久化，
  首次启动自动生成；别每次重启都签新的，否则用户被登出）
- session 有效期 7 天，cookie 属性 `HttpOnly; SameSite=Lax; Path=/`，
  **HTTPS 下**加 `Secure`（用 `req.headers['x-forwarded-proto'] === 'https'` 判断，
  因为前面有 1Panel openresty 反代）
- 登录失败**限速**：同 IP 连续失败 5 次 → 锁 5 分钟，返回 429
- `/api/admin/*` 全部改为**校验 session cookie**（不再要 `sk-cg-`），
  未登录返回 401

### 三、Command Code key 的管理放后台

`/admin` 后台里「账号管理」块要能**完整管理 CC 上游 key**：
- 新增：填「备注名」+「CC API key」（`user_...` 开头的文本框），
  提交后**不要回显 key**，列表里只显示 `keyId` / `keyPrefix` + 备注名
- 测试连通性按钮：调 CC 官方 `whoami` 验证 key 是否有效，显示结果
  （有效 → 显示登录名与套餐；无效 → 显示错误原因）
- 停用 / 启用、改备注、删除（删除要二次确认）
- 额度信息（5h/周/月进度条 + 余额）直接显示在账号行里

### 四、客户端 API key 管理（给程序用）

后台里单独一块「API 客户端 key」：
- 生成（服务端随机 `sk-cg-` + 32 字节，**只在生成时显示一次明文**，带复制按钮）
- 列表只显示 `keyId` / `keyPrefix` / 名称 / 创建时间
- 删除

### 五、前台面板（`/`）不再要 key

- `/` 展示面板 + `GET /api/status` **公开可读**（不鉴权）
  说明：面板只暴露账号名、keyId、keyPrefix、额度百分比——**没有完整 key**，
  与 komari 的公开探针面板同样的定位。
  ⚠️ 若要保留「隐私模式」开关：加环境变量 `PUBLIC_DASHBOARD=1`（默认 1 = 公开），
  设 0 时 `/api/status` 需要登录 session。
- 前台**去掉** key 输入框，改为右上角「登录后台」链接

---

## 兼容性 & 硬约束（别踩）

1. **现有 60 个测试必须全绿**。特别是 `test/gateway.test.mjs`：
   - 测试6：`GET /` 的 HTML 必须含 `cc-manage`、`5 小时窗口`、`本周窗口`、`本月周期`、`/api/status`
   - 测试32：`GET /` 的 HTML 必须含 `<input id="key" type="password">`、
     `Authorization:`…`Bearer`、`sessionStorage`、`apiFetch('/api/status')`、
     `apiFetch('/api/accounts/refresh')`
     ⚠️ **这条与新设计冲突**（前台不再要 key 输入框）。
     ➜ **允许修改这条测试**，但必须：① 在回复里明确说明改了哪条、为什么；
     ② 新测试要覆盖登录流程本身；③ 其余测试一条都不能动。
   - 测试27：`/api/status` 字段结构不变
2. **零外部依赖**：不许 npm 装包、不许 CDN。`scrypt`/`hmac`/`randomBytes` 全用 `node:crypto`
3. **凭据目录**：全部走 `config/`（已挂载可写，`1000:1000`）：
   - `config/accounts.json`  CC 账号池（已有）
   - `config/keys.json`     客户端 API key（已有）
   - `config/users.json`    **新增**：后台管理员账号
   - `config/session-secret` **新增**：cookie 签名密钥（0600）
4. **权限**：所有凭据文件写后 `chmod 0640`（session-secret 用 0600）
5. 单文件静态页，零依赖，中文界面
6. 设计语言沿用现有樱花主题（`public/index.html` / `public/admin.html` 里的 CSS 变量）

## 新增测试要求

`test/auth.test.mjs`（新文件）覆盖：
- 初始化流程：无 users.json → setup 可创建首个管理员；再调 setup → 403
- 登录成功设 cookie / 密码错误 401 / 连续 5 次失败 → 429
- 未登录访问 `/api/admin/*` → 401；登录后 → 200
- session cookie 被篡改 → 401
- 密码哈希：文件里不含明文密码，格式为 `scrypt$...`
- 前台 `/api/status` 公开可读（PUBLIC_DASHBOARD 默认）
- 生成客户端 key 只回显一次明文

## 交付

1. 改 `gateway.mjs`（登录/会话/setup + admin 接口改造）
2. 新增 `src/auth.mjs`（密码哈希、session 签名校验、限速）—— 保持模块化
3. 改 `public/admin.html`（登录页 + 初始化页 + 后台三块管理）
4. 改 `public/index.html`（去掉 key 输入框，加登录入口）
5. `npm test` 全绿（旧测试 + 新测试）
6. `git commit`（中文提交信息）

**不要**改 `vendor/`。除测试32外，**不要**修改现有测试用例。
