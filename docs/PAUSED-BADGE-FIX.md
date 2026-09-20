# 任务：修复「暂停账号仍显示可调度」的 bug + KPI 图标语义

## 用户反馈

> 账号 暂停，那些符号，有问题你自己搜索合适的

用户看到账号卡上**同时出现「可调度」和「暂停至 03:39:05」两个自相矛盾的徽标**。

---

## 🔴 Bug 1（根因，必须修）：`isAvailable` 漏传 `now` 导致暂停判断失效

### 证据（已实测）

```js
// src/scheduler.mjs:70
function isAvailable(account, now) {
  if (account.enabled === false) return false;
  const rt = runtime(account);
  if (rt.pausedUntil && rt.pausedUntil > now) return false;   // ← 依赖 now
  ...
}
```

**三处调用漏传 `now`**：
```
gateway.mjs:407   available: scheduler.isAvailable(account),          ← undefined
gateway.mjs:443   available: accounts.filter((a) => scheduler.isAvailable(a)).length,   ← undefined
gateway.mjs:554   available: scheduler.isAvailable(a),                ← undefined
```

**对比调度器内部（正确）**：
```
src/scheduler.mjs:101   if (hit && isAvailable(hit, now)) return { account: hit };
src/scheduler.mjs:103   const candidates = accounts.filter((a) => isAvailable(a, now));
src/scheduler.mjs:150   return accounts.filter((a) => isAvailable(a, now)).length;
```

**运行时实测**（node 脚本，账号 `pausedUntil = now + 1h`）：
```
isAvailable(账号)       → true    ❌  pausedUntil > undefined === false，暂停被跳过
isAvailable(账号, now)  → false   ✅
rt.pausedUntil > undefined → false
```

### 影响面

1. `/api/status` 的 `summary.available` 数字偏大（把暂停账号算成可用）
2. `/api/status` 的每个 `account.available` 字段错误 → **前台卡片同时渲染出
   「可调度」（tag ok）和「暂停至 XX:XX」（tag warn）两个矛盾徽标**
3. `/api/admin/accounts`（走 `accountView`）的 `available` 同样错误

### 修复方案（选一，推荐 A）

**A. 让 `isAvailable` 的 `now` 有默认值**（最小改动 + 消除整类隐患）：
```js
function isAvailable(account, now = Date.now()) {
```

**B. 修所有调用点**，显式传 `Date.now()`。

⚠️ 选 A 时注意：`isAvailable(account, 0)` 这种显式传 0 的语义要保持（0 是 falsy 但有意义），
用默认参数语法 `now = Date.now()` 天然正确（只有 `undefined` 才触发默认值）。

**同时检查同一文件里其它「第二个参数可选的时间参数」是否有同类问题**
（如 `isQuotaError`、`pauseForQuota`、`remainingRatio`、`recheckPaused({now})` 等），
凡是拿 `now` 跟时间戳比较的，都要确认调用方传了值或函数有默认值。

### 顺带修 UI 矛盾（防御性）

即使后端修好了，前端 `statusText()` / `card()` 也应保证**不会渲染矛盾徽标**：
```
public/index.html:613  if (!a.enabled) return { t: '已停用', dot: 'paused' };
public/index.html:614  if (a.paused) return { t: '暂停中', dot: 'paused' };
public/index.html:615  if (!a.available) return { t: '不可调度', dot: 'invalid' };
```
`card()` 里 `tags` 的「可调度 / 不可用」应改为**先判断 `a.paused`**：
`paused` 或 `!enabled` 时不得输出「可调度」标签。给这一层加注释说明是防御性的
（后端已保证，但前端不该依赖单一数据源正确）。

---

## 🟡 Bug 2：KPI 图标语义不匹配（用户说的「符号有问题」）

用户明确要求「你自己搜索合适的」。当前 6 个内联 SVG（`public/index.html:510-530`）：

| 位置 | 当前图标 | 标签 | 问题 |
|---|---|---|---|
| 510 | 单人像 | 账号数 | ✅ 合适 |
| 514 | 对勾 | 可用 | ✅ 合适 |
| 518 | 两条竖线（pause） | 暂停中 | ✅ 合适 |
| 522 | **闪电** | 在途请求 | ❌ 闪电=速度/触发，不是"进行中的请求" |
| 526 | 柱状图 | 总请求 | 🟡 弱：像"数据统计"，不像"总请求数" |
| 530 | **警告三角(!)** | 错误数 | 🟡 语义是"警告"不是"错误" |

### 要求

请**先搜索「常见 dashboard KPI 图标语义惯例」**（Lucide / Feather / Heroicons /
Material Symbols 的命名与用法），再据此换成合适的图标，并**采用 24×24 viewBox、
`stroke="currentColor"`、`stroke-width` 1.8-2** 的统一风格（与现有图标一致，
不要引入外部依赖或图标字体）。

建议方向（请自行核对后定稿）：
- **在途请求** → `activity`（心跳折线）或 `arrow-right-circle` / `loader`（进行中）
- **总请求** → `list` / `files` / `layers`（数量堆积）或 `git-commit-horizontal`
- **错误数** → `x-circle`（明确"错误"）或 `alert-circle`（若坚持圆形容器）

**不要改标签文字，只换图标 path**。换完在回复里说明每个图标来自哪个图标库的哪个名字。

---

## 硬约束

1. **104 个测试必须全绿**（`npm test`）。`gateway.test.mjs` 有多处断言
   `available` 字段和 `summary.available`，改 `isAvailable` 后这些测试**可能反而应该变**
   —— 若某条测试因为「原来把暂停账号算成可用」而失败，说明它锁的是错误行为，
   **先停下来在回复里说明是哪条、为什么**，再改。
2. **必须新增回归测试**：造一个 `pausedUntil` 在未来的账号，断言
   `/api/status` 的 `account.available === false` 且 `summary.available` 不包含它。
   （仅靠现有测试可能覆盖不到这个漏传 `now` 的路径。）
3. 零外部依赖、单文件 HTML、不改 `vendor/`
4. `docker compose build gateway && docker compose up -d --force-recreate gateway` 重建验证
5. **不要装任何 npm 包、不要用 playwright**（用 curl + node 量数据）
6. `git commit`（中文提交信息）

## 验证要求（把证据写进回复）

```
① 造假：把某账号 pausedUntil 设为未来 → /api/status 的 available 必须是 false
② 前台卡片不再同时出现「可调度」和「暂停至」
③ summary.paused 与 summary.available 不再自相矛盾（paused 的账号不能计入 available）
④ 截图或 DOM 证据：KPI 六个图标换新后的样子
⑤ npm test 全绿数字
```
