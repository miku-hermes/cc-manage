# 任务：重做 cc-manage 额度面板 UI（仿 komari-mikus 设计语言）

## 目标

`public/index.html` 目前是一个**深色（#0f1117）扁平列表**，没有任何设计感。请按
**komari-mikus 主题**的设计语言重做，做成正经的后台管理面板。

## 硬约束（测试会卡，必须满足）

现有 `test/gateway.test.mjs` 里有三条测试直接检查这个 HTML，**一条都不能破**：

1. **测试6**（GET / 骨架）：HTML 必须包含字面量 `cc-manage`、`5 小时窗口`、`本周窗口`、
   `本月周期`、`/api/status`
   ⚠️ 注意：`5 小时窗口` / `本周窗口` / `本月周期` 这三个是**进度条的标签文字**，
   必须原样出现在 HTML **源码**里（不能只在 JS 里拼字符串——测试是对源码做正则匹配）。
   现在的写法是 `bar('5 小时窗口', ...)` 内联在 JS 里，重构后请保持这些字符串字面量存在于源码。
2. **测试32**（面板 HTML）：
   - `<input id="key" type="password">`（属性顺序必须是 id 在前、type 在后，正则按此匹配）
   - 源码里必须能匹配到 `Authorization:` … `Bearer`（大小写不敏感）
   - 必须有 `sessionStorage`
   - 必须调用 `apiFetch('/api/status')` 和 `apiFetch('/api/accounts/refresh')`
   - **不能**出现裸 `fetch('/api/status')` 或 `fetch('/api/accounts/refresh')`
3. **测试27**（数据契约）：面板读的字段必须是 `/api/status` 真实提供的：
   - 顶部：`summary.{accounts,available,paused,concurrency}`、`stats.{total,errors,totalTokens}`、
     `upstreamProxyUrl`、`allowPassthrough`、`now`
   - 账号：`name`、`keyId`、`keyPrefix`、`enabled`、`available`、`concurrency`、`paused`、
     `authInvalid`、`lastQuota.{credits.{monthlyCredits,purchasedCredits,freeCredits},remaining}`、
     `lastQuota.{fiveHour,weekly,monthly}.{used,cap}`、`lastQuota.percent.{fiveHour,weekly,monthly}`、
     `lastQuota.usage.totalTokens`、`lastQuota.plan.planId`、`lastQuota.displayName`
   - **字段名一个都不能改**（后端不改）

## 设计语言（照抄 komari-mikus，从它 dist 里的 CSS 变量抄的）

**配色**（同时提供亮色+暗色，跟随系统 `prefers-color-scheme`，并给一个手动切换按钮）：

亮色（默认）：
```
--bg-primary:   #f8f6f9    页面底
--bg-secondary: #ffffff
--bg-tertiary:  #f0edf3
--bg-card:      #ffffff    卡片
--bg-card-hover:#faf8fc
--text-primary: #2d1b3d    深紫墨色（不是纯黑）
--text-secondary:#6b5a7d
--text-tertiary:#9b8aad
--border-color: #e8e0f0    发丝级淡紫描边
--border-light: #f0eaf5
--accent:       #e8668a    樱花粉（主强调色）
--accent-hover: #d44a72
--accent-light: #fce4ec
--success:      #4caf7d
--warning:      #f5a623
--danger:       #e74c5e
--info:         #5c9ced
```

暗色：
```
--bg-primary:   #1a1119
--bg-secondary: #221826
--bg-tertiary:  #2a1f2e
--bg-card:      #2a1f2e
--bg-card-hover:#332538
--text-primary: #e8e2ec
--text-secondary:#b8adc2
--text-tertiary:#8a8290
--border-color: #3a2d40
--border-light: #2f2434
--accent:       #f2a0b5
--accent-hover: #e8668a
--accent-light: #3d2430
--success:      #6ddba0
--warning:      #ffc266
--danger:       #ff8095
--info:         #7fb3f5
```

**结构（自上而下）**：

1. **顶部导航栏**（`.header`）：左 = 小圆 logo + 粗体站名 `cc-manage`；右 = 浮动工具簇
   - 搜索框（`.search-box`，圆角胶囊 + 放大镜 SVG，按账号名/keyId 实时过滤卡片）
   - 主题切换按钮（月亮/太阳 SVG 图标）
   - 刷新按钮
   - key 输入框（`id="key" type="password"`，放这里）+ 保存按钮
   - 整簇放在一个圆角、略亮的"抬起"容器里

2. **Hero 卡片**（`.hero`）：大圆角面板（radius 14px），左右分栏
   - 左：两行文字 —— 大号**问候语**（按时段变化：凌晨好/早上好/下午好/晚上好，粉色）+
     副标题「欢迎回来，网关运行中」
   - 右：右对齐 —— 日期、**超大号实时时钟**（粉色，每秒走动）、下方小字「累计 token xxx」
   ⚠️ 「累计 token」字样必须出现在源码里（可以用 `stats.totalTokens` 渲染）

3. **KPI 小卡行**：账号数 / 可用 / 暂停中 / 在途请求 / 总请求 / 错误数
   —— 圆角卡片，标签小字+数字加粗

4. **账号卡片网格**（`.grid`，`auto-fill minmax(340px,1fr)`）：
   每个账号一张卡：
   - 标题：账号名 + 显示名（`displayName`）
   - 副标题：`keyId · keyPrefix…`（等宽字体）
   - 大号数字：剩余额度（`remaining`）
   - 三个进度条：**5 小时窗口 / 本周窗口 / 本月周期**（
     用 `percent.fiveHour` 等；进度条颜色按占用率分级：<70% 绿、70-90% 黄、≥90% 红）
   - 底部标签：已启用/手动停用、可调度/不可用、暂停至 xx、鉴权失效、在途 n、套餐 xxx
   - 最近错误（有则显示，红色小字）
   - hover 时卡片轻微上浮 + 边框变粉

5. **页脚**：居中、小字、淡色

**视觉细节**：
- 所有圆角统一（卡片 12-14px、按钮/标签胶囊）
- **不要硬阴影**，用发丝描边（`--border-color`）+ 极淡阴影
- **背景加飘落的樱花花瓣动画**（纯 CSS/JS，绝对定位的粉色小花瓣，`@keyframes` 下落+
  左右摇摆+旋转，8-12 片即可，`pointer-events:none`，`prefers-reduced-motion` 时关闭）
- 大号数字用 `font-variant-numeric: tabular-nums`
- 移动端响应式：栅格自动降为单列，导航栏可换行

## 技术要求

- **零外部依赖**：不许引 CDN、不许引字体、不许 npm 装东西（整个项目零依赖是硬规矩）
- **纯静态单文件**：全部塞进 `public/index.html`（内联 `<style>` + `<script>`），
  不要新增文件（后端 `readPanel()` 只读这一个文件；若必须拆分请先说明）
- 保持现有的 key 管理逻辑：`sessionStorage`、`apiFetch`、401 提示、
  每 5 秒自动刷新、无 key 时显示提示而不是报错
- **XSS 安全**：所有来自 API 的字符串渲染前必须转义（现有 `esc()` 保留并用全）
- 中文界面

## 交付

1. 改好的 `public/index.html`
2. 跑 `npm test`，**60 个测试必须全绿**（改动只在 UI 层，理论上一条都不该破）
3. 如果为了让新 UI 通过而**必须**调整测试，先停下来在回复里说明原因，不要擅自改测试
4. 提交：`git add public/index.html && git commit -m "feat(ui): 重做额度面板，仿 komari-mikus 樱花主题（亮/暗双主题 + 响应式）"`
