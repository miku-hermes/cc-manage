# cc-manage 前端 UI 现代化 · 重构规划书

> 日期：2026-09-23 ｜ 状态：待批准 ｜ 执行方式：全部代码改动交 Codex CLI，Miku 负责 brief / 验收 / 部署
> 用户要求：**组件化 + 现代化**（单 HTML 不好管，明确要求重构）；**浅色主题**（2026-09-23 定调：不要求深色，浅色现代化）

## 0. 结论（30 秒版）

不引入任何框架/构建/npm 依赖（零依赖单文件部署是 cc-manage 的架构灵魂，测试体系也绑在上面），
「现代化」= **文件结构组件化（CSS/JS 拆模块文件）+ 设计令牌体系 + 玻璃拟态视觉 + 微动效 + 事件委托**。
两页入口路径 `/`、`/admin` 不变，`public/` 仍是静态文件、仍直接 COPY 进镜像。分 3 批，每批独立验收+回滚镜像。

## 1. 现状盘点（已验证）

| 项 | 现状 |
|---|---|
| 前端文件 | `public/index.html`（1087 行，前台额度面板）+ `public/admin.html`（1519 行，登录门+后台管理），均单文件自包含：内联 CSS + 内联 JS，无框架无构建 |
| 测试 | `node --test test/*.test.mjs`，当前 **340 条全绿**；其中 UI 契约测试 ~34 条：`batch2-ui`（21）+ `review3-fixes-b-ui`（8）+ `batch3-ops-ui`（2）+ `mobile-tags`（1）+ `gateway.test.mjs` 内少量 |
| 部署 | Dockerfile `COPY public/ ./public/`；`/`、`/admin` 两个路由 `fs.readFileSync` 直接吐 HTML；网关同时在供 Hermes 自己的 LLM 流量 |
| CSP | `script-src 'self' 'unsafe-inline'`、`style-src 'self' 'unsafe-inline'`、`connect-src 'self'` 等 → **禁止任何外部 CDN / Google Fonts**，所有资源同源 |

### 1.1 测试硬约束（重构不能碰的契约，已逐条核对）

1. **脚本提取**：`runInlineScript` 用正则 `/<script>([\s\S]*?)<\/script>/g` 只匹配**无属性** `<script>`，
   按文档顺序在**同一 vm context** 执行 → 多个普通 `<script>` 块是安全拆分单位；`<script type="module">` 不可用（会被跳过且测试直接 fail）。
2. **全局 API 面**：`state.accounts` / `state.keys` 属性 + `renderAccounts()` / `renderKeys()` 函数必须保持
   在测试 vm 全局可访问（`vm.runInContext('state.accounts=...; renderAccounts();')` 直接调用）。
3. **CSS 契约**（测试对 HTML 内 `<style>` 文本做正则/花括号解析）：
   - B2-13：两页都有按 `data-theme` 分派的 `color-scheme`（原生控件配色）——**这条留在 HTML 内联 `<style>`**（语义上也该在）；
   - B2-11：≤820px 运行日志正文可换行；B2-12：≤820px 触控目标 ≥34px；
   - mobile-tags：≤640px `.tags { flex-wrap: nowrap; overflow-x: auto }` + `.tags .tag { flex: 0 0 auto }`，桌面端 `.tags { flex-wrap: wrap }`。
4. **文案契约**：「限流冷却中」「周额度已用完」「月度 X · 购买 Y · 赠送 Z」「运行中」「请先登录后台」等
   断言文案逐字保留；登出/401 清空 DOM+state 行为不变。
5. **helper 升级**：`createDomShim`/style 提取工具改为「HTML 内联 `<style>` + `<link rel=stylesheet href=...>` 文件文本合并」，
   **现有断言逐条不动**（改的是数据源，不是断言）。

### 1.2 后端小改

`gateway.mjs` 目前只 serve `/`、`/admin` 两个 HTML。需**新增 `public/*` 静态文件路由**（css/js 子路径），
含路径穿越防护 + 正确 MIME（.css/.js）+ 复用现有 CSP 头。这是 3 批里唯一的后端改动，放批次 1。

## 2. 架构设计

### 2.1 目标文件布局

```
public/
├── index.html          # 壳：head 引 <link>，body 结构，<style> 只留 color-scheme+主题基础，
│                       #   多个 <script src="js/*.js">（无 type 属性）按依赖顺序加载
├── admin.html          # 同上
├── css/
│   ├── tokens.css      # 设计令牌：浅色主题（:root；data-theme 机制保留但本期只定义浅色，
│   │                   #   B2-13 的 color-scheme 契约块原样留在 HTML 内联 style）
│   ├── base.css        # reset、排版、栅格、滚动条、focus-visible
│   ├── components.css  # 卡片/按钮/标签/pill/弹框/toast/骨架屏 等原子组件
│   ├── dashboard.css   # 前台：hero、kpi、账号卡、标签条
│   └── admin.css       # 后台：登录门、表格、表单、日志
└── js/
    ├── utils.js        # esc()/fmt 数字/时间（resetAt 秒 vs fetchedAt 毫秒）/toast
    ├── api.js          # fetch 封装（/api/status、/api/admin/*、错误态）
    ├── state.js        # 全局 state（保持 window.state）+ 订阅/notify
    ├── render-*.js     # 组件渲染函数（每个组件一个文件，renderXxx() 挂全局）
    └── app.js          # 启动：init、事件委托绑定、轮询、主题切换
```

### 2.2 组件与状态

- **组件 = 独立渲染函数 + 独立 CSS 命名空间**（`card-*`、`kpi-*`、`gate-*`、`panel-*` BEM 风格）。
  每个 render 组件自包含：输入 state 切片 → 输出 DOM 字符串 → 事件走**事件委托**（容器级监听，不再散落 addEventListener）。
- **state.js**：保持单一全局 `state`（测试依赖），新增最小订阅机制 `state.on(slice, fn)`；
  `renderAccounts()` / `renderKeys()` 保留为顶层函数（测试直接调）。
- 组件清单：
  - 前台：`hero`（问候/余额/健康/时钟）、`kpis`、`account-cards`（卡片+额度条+tags 条）、`modal`、`theme-toggle`、`search`
  - 后台：`login-gate`（登录/首次初始化）、`accounts-table`、`keys-table`、`users-form`、`logs`（轮询+generation 守卫）、`toast`
- 通用：`skeleton` 加载态、`toast` 反馈（替代部分 alert）、focus-visible 环、Esc 关弹框+焦点归还（已有，保留）。

### 2.3 设计方向（浅色现代化，用户已定调：不要求深色）

- **主题**：单一浅色主题。`data-theme` 切换机制保留（B2-13 契约要求），但本期只定义浅色令牌，
  不做深色主题（令牌结构留好，后续要加再说）。
- **视觉**：现代浅色仪表盘 —— 浅灰蓝页面底（`#f4f6fb`）+ 纯白卡片 + 1px 浅边框（`#e6eaf2`）+
  分层柔和阴影（soft/lift 两级）；玻璃拟态**克制使用**（仅 sticky 头部/弹框用半透明白 `rgba(255,255,255,.7)` +
  `backdrop-filter: blur(16px)`，卡片主体用纯白+阴影，保证性能）。
- **色彩**：保留现有粉紫品牌主色（`#e8668a` 系）作为 accent（品牌延续）；
  语义色 success/warning/danger/info 加深一档适配浅底（白底上用深绿 `#15803d`、深琥珀 `#b45309`、深红 `#dc2626` 量级），
  状态胶囊改为浅底深字（如在线=浅绿底深绿字）。
- **令牌**：沿用现有变量名（`--surface-0/1/2`、`--text-primary/secondary/tertiary`、`--accent*`、`--success/warning/danger/info`
  及 `-ink/-light` 变体、`--fs-*`、`--lh-*`、`--radius-*`、`--shadow-*`、`--gutter`、`--card-pad`）保证兼容；
  新增 `--glass-*`、`--elev-*`、动效令牌 `--dur-150/250/400` + `--ease-out`。
- **无障碍（继承现有红线）**：正文/小字对比 ≥4.5:1（浅色主题下一组）、触控目标 ≥34px（≤820px）、
  `prefers-reduced-motion` 时动效全关。
- **断点契约保留**：640px（标签条单行横滚+mask 状态类）、820px（日志换行+触控高度）两条 media 规则原样进 `dashboard.css`/`admin.css`。

## 3. 批次计划（每批 = 1 个 Codex brief + 独立验收 + 回滚镜像）

### 批次 1：结构拆分（行为零变化）

**做什么**
- 抽出 `css/tokens.css` + `css/base.css` + 现有组件样式 → `components.css`/`dashboard.css`/`admin.css`；
  HTML 内 `<style>` 只保留 `color-scheme`/`data-theme` 基础块（B2-13 契约）。
- 内联 JS 按依赖顺序拆 `js/*.js`（utils → api → state → render-* → app），多个 `<script src>` 无 type 属性。
- `gateway.mjs` 新增 `public/*` 静态路由（路径穿越防护、MIME、CSP 头复用）。
- 升级 `test/helpers.mjs` style 提取支持 `<link>` 合并读取（断言不动）。
- 新增少量回归：静态路由 200/MIME、路径穿越 404、`js/state.js` 存在且含 `renderAccounts`。

**验收**：340 条测试全绿 + 新增全绿；mutation check（还原 index.html 旧单文件 → 新测试红）；
camofox 截图对比（DOM 行为一致）；冒烟容器 → 部署 → 容器内 md5 核对 → commit+tag。

### 批次 2：设计系统现代化（视觉升级，结构不动）

**做什么**
- `tokens.css` 浅色令牌全量梳理：玻璃令牌、阴影分层、动效令牌；字阶/间距节奏优化（不做深色主题）。
- `components.css`：按钮（主/次/危险/图标，hover/active/focus/disabled 全态）、卡片（玻璃+lift）、
  pill、标签、弹框、toast、骨架屏统一视觉。
- `dashboard.css`：hero 区（问候/余额/时钟）排版层级升级；KPI 卡；账号卡额度条（月度/购买/赠送构成条视觉）。
- `admin.css`：登录门卡片、表格行悬停/斑马、表单 focus 态、日志区。
- 动效：列表/卡片 150ms 过渡、弹框 250ms 缩放淡入，`prefers-reduced-motion` 降级。

**验收**：全部既有 UI 契约测试不动且全绿；camofox 浅色主题下 前台/后台 × 桌面/390px 手机 共 4 张截图人工验收；
对比度自查（浅色 4.5:1）；冒烟 → 部署 → 核对 → commit+tag。

### 批次 3：JS 组件化（结构不变，代码重组）

**做什么**
- 前台 JS 拆 `render-hero.js` / `render-kpis.js` / `render-accounts.js` / `render-tags.js` / `modal.js` / `theme.js` / `app.js`；
  后台拆 `login-gate.js` / `render-accounts-table.js` / `render-keys-table.js` / `users.js` / `logs.js` / `app-admin.js`。
- 事件委托：卡片操作（停用/启用/刷新额度/连通性测试）、表格行按钮、弹窗全部容器级监听。
- 保留：`state.accounts/keys` + `renderAccounts()` / `renderKeys()` 全局函数；
  登出/401 清 DOM+state（含 keyPrefix 不落 DOM）；日志 generation 守卫；keyId 前 8 位碰撞时操作只作用目标账号（G3 契约）。
- toast 组件替换散落的 alert/提示；skeleton 首屏加载态。

**验收**：340+ 条全绿（重点 B2-1/B2-5/B2-7/B2-8/G3 系列）；mutation check（还原旧 JS → 新测试红）；
camofox 完整交互走查（登录→表格操作→弹窗→登出）；冒烟 → 部署 → 核对 → commit+tag。

### 全局禁止项（每批 brief 都写）

- 不许 `git commit/push`、不许任何 docker 操作（Miku 做部署）
- 不许新增 npm 依赖 / 不许改 package.json / 不许构建工具
- 不许外部 CDN / 字体 / 图片资源（CSP 锁死）
- 不许顺手重构无关代码、不许改 API 路径与响应结构
- 断言文案逐字保留（1.1-4 清单）

## 4. Codex 提示词（三批，直接可用）

### 4.0 公共前缀（每批开头都带）

```
工作目录 /root/projects/cc-manage（git 仓库，工作树应干净，先 git status 确认）。
【环境】本机没有 apply_patch 工具，改文件用 python3 字符串替换或整文件重写。
【禁止】git commit/push；任何 docker 命令；npm install / 新增依赖 / 改 package.json；
任何外部 CDN/字体/图片资源（CSP 只允许同源）；重构与本任务无关的代码。
【完成标准】跑 `node --test test/*.test.mjs` 全量并贴出输出摘要；
新增测试必须是「未修复必红」的回归（做完后 git stash 你的源码改动、单跑新测试确认变红、再 git stash pop 恢复，贴出红/绿两次输出）。
【风格】保持现有代码风格与中文注释；改动最小化。
```

### 4.1 批次 1 brief

```
<公共前缀>
【任务】把 public/index.html / public/admin.html 从「单文件自包含」拆成「HTML 壳 + 外部 css/js 文件」，行为零变化。
1) CSS：抽出 css/tokens.css（:root 与暗色全部设计令牌）、css/base.css（reset/排版/栅格）、
   css/components.css（通用组件）、css/dashboard.css（前台布局：hero/kpi/卡片/tags，含 640px 与 820px media 块）、
   css/admin.css（后台：登录门/表格/表单/日志，含相关 media 块）。
   HTML 的 <style> 内联只保留：color-scheme 基础 + [data-theme=light]/[data-theme=dark] 的 color-scheme 分派
   （测试 B2-13 直接读 HTML 文本断言它）。
   两页用 <link rel="stylesheet" href="css/..."> 引全部 css 文件。
2) JS：把内联 <script> 按依赖顺序拆成 js/utils.js、js/api.js、js/state.js、js/render-*.js、js/app.js，
   HTML 用多个 <script src="js/...">（注意：不能带 type 属性！测试正则只匹配无属性 <script> 标签，
   外部文件的内容测试不执行，但 HTML 内联 <script> 至少要保留一个用于测试的引导块——
   把启动逻辑放 js/app.js 的同时，在 HTML 末尾保留一个无属性内联 <script> 暴露 window.state 与 renderAccounts/renderKeys
   （或从已加载脚本重导出），保证 vm 上下文里 state.accounts / state.keys / renderAccounts() / renderKeys() 可访问）。
   加载顺序必须保证依赖：utils → api → state → render-* → app。
3) gateway.mjs：新增 GET /css/* 与 /js/*（或直接 public/* 前缀）静态文件路由：
   限制在 ROOT/public 内（防路径穿越，.. 与绝对路径 404）、按扩展名给 MIME（.css→text/css; .js→text/javascript; charset=utf-8）、
   复用现有 CSP 响应头逻辑。不改任何现有路由行为。
4) 测试适配：test/helpers.mjs 的 style 提取（被 mobile-tags/batch2-ui 等使用）改为
   「HTML 内联 <style> 文本 + 所有 <link rel=stylesheet> 指向的 public/*.css 文件文本合并」，
   现有断言一条都不许改。
5) 新增回归测试 test/ui-structure.test.mjs：
   a) GET /css/tokens.css 与 /js/state.js 返回 200 且 MIME 正确；
   b) GET /css/../gateway.mjs 等穿越路径 404；
   c) public/index.html 与 admin.html 内联 <style> 含 data-theme 的 color-scheme 分派（原 B2-13 语义在拆分后仍成立）；
   d) 两页 <script src> 顺序 utils 先于 state、state 先于 app。
【禁止改动断言】batch2-ui / review3-fixes-b-ui / batch3-ops-ui / mobile-tags 的断言文本。
【交付】变更清单（文件级）+ 全量测试输出 + 新测试 mutation 自证（红/绿两次）。
```

### 4.2 批次 2 brief

```
<公共前缀>
【任务】设计系统现代化：只改 css/（tokens.css / base.css / components.css / dashboard.css / admin.css）与
HTML 中纯视觉的 class 结构，不改任何 JS 逻辑、不改 id、不改断言涉及的文案与 class 选择器语义。
【设计令牌】tokens.css 浅色主题全量梳理（不做深色主题）：
- 保留现有全部变量名（--surface-0/1/2、--border、--text-primary/secondary/tertiary、--accent*、--success/warning/danger/info
  及 -ink/-light 变体、--fs-*、--lh-*、--radius-*、--shadow-*、--gutter、--card-pad、--header-h），
  色值按浅色现代风重调（页面底浅灰蓝 #f4f6fb 量级、卡片纯白、边框极浅）；
- 语义色加深一档适配白底（深绿/深琥珀/深红量级），保证 4.5:1 对比度；
- 新增：--glass-bg（rgba(255,255,255,.7) 量级，仅用于 sticky 头部/弹框）、--glass-blur: 16px、--glass-border、
  --elev-1/--elev-2（柔和分层阴影）、--dur-150: 150ms、--dur-250: 250ms、--ease-out: cubic-bezier(.22,.61,.36,1)。
【组件规范】components.css：
- 按钮四态（hover/active/focus-visible/disabled），触控高度 ≥34px（≤820px 断言 B2-12 必须仍过）；
- 卡片：主体纯白 + 1px 浅边框 + --elev-1 柔和阴影（hover 时 --elev-2 + 微上浮 1-2px，150ms）；
  玻璃拟态仅用于 sticky 头部与弹框（background: var(--glass-bg); backdrop-filter: blur(var(--glass-blur));）；
- pill/标签、弹框（250ms 缩放淡入）、toast、骨架屏（shimmer）统一。
【前台】dashboard.css：hero 区层级（问候 fs-hero、余额主数字、meta 小字节奏）、KPI 卡、
账号卡额度构成条（月度/购买/赠送 三段色条，颜色沿用 --info/--accent/--success 系）。
【后台】admin.css：登录门居中卡片（玻璃+品牌感）、表格（行 hover 高亮、悬停态不跳行）、表单 focus 环、日志区（≤820px 换行断言 B2-11 必须仍过）。
【动效】统一 150/250ms + --ease-out；:root 下加
@media (prefers-reduced-motion: reduce) { * { transition-duration: 0.01ms !important; animation-duration: 0.01ms !important; } }
【硬约束】① 640px 标签条契约（flex-wrap: nowrap + overflow-x: auto + .tag flex:0 0 auto，桌面 wrap）原样保留在 dashboard.css；
② 所有断言文案、id、class 名不动；③ 对比度自查：正文/小字 ≥4.5:1（浅色主题），在交付里列出自查结果。
【新增测试】test/ui-tokens.test.mjs：tokens.css 含 --glass-bg/--dur-250；dashboard.css 640px 块契约（同 mobile-tags 断言，读合并 css）；
components.css 含 prefers-reduced-motion 块。
【交付】变更清单 + 全量测试输出 + 新测试 mutation 自证。
```

### 4.3 批次 3 brief

```
<公共前缀>
【任务】JS 组件化重构：只动 public/js/ 与 HTML 中 <script> 引导块，DOM id / 断言文案 / 行为契约全部不变。
【拆分】前台：js/render-hero.js（greeting/balance/health/clock/tokens）、js/render-kpis.js、js/render-accounts.js
（卡片重建+tags scrollLeft 按 keyId 回填，B2-5）、js/render-tags.js、js/modal.js（Esc 关闭+焦点归还，B2-15）、
js/theme.js（data-theme 切换+localStorage）、js/app.js（init+轮询+事件委托）。
后台：js/login-gate.js（登录/初始化/401 清 state 与四个敏感容器，B2-1）、js/render-accounts-table.js、
js/render-keys-table.js、js/users.js（只读模式置灰 B2-20）、js/logs.js（轮询 generation 守卫 B2-7）、js/app-admin.js。
【状态】state.js 保持 window.state 单例与现有字段；renderAccounts()/renderKeys() 保留为顶层可全局调用函数
（测试 vm.runInContext 直接调）；可选加最小订阅（state.on/notify）但不得改变现有调用路径。
【事件委托】所有卡片/表格行/弹窗交互改为容器级 addEventListener + data 属性定位目标；
keyId 前 8 位相同时操作必须只作用目标账号（G3 契约，不得回退）。
【行为红线】① 登出/401 清空一次性 key/粘贴 key/密码框/弹窗，keyPrefix 不落 DOM；
② 公开前台 hero 不渲染内网 host/port（B2-8）；③ 隐私模式搜索不覆盖登录提示（B2-19）；
④ 日志慢响应不得覆盖新筛选结果（generation 守卫）；⑤ 快照过旧提示按实际阈值算分钟（B2-5）。
【新增测试】test/ui-components.test.mjs（≥6 条，覆盖：事件委托后停用只作用目标、Esc 焦点归还、
登出清容器、generation 守卫、只读置灰、theme 切换持久化），全部未修复必红。
【交付】变更清单（文件级+函数级）+ 全量测试输出 + 新测试 mutation 自证（红/绿两次）。
```

## 5. 我的验收与部署流程（每批固定动作）

1. `git status --short` + `git diff --stat` + 全量 `node --test test/*.test.mjs`
2. **mutation check**：`git stash push -- <源码>` → 单跑新测试**必须红** → `git stash pop`（先 `git diff > /tmp/backup-N.patch`）
3. Codex 改过的既有断言逐条审（三判据：核心约束还在？只是收到真语义边界？新增更具体正面断言补偿？）
4. camofox 浏览器实测（真实 DOM）：批次 1 行为对比、批次 2 浅色主题 4 张截图（前台/后台 × 桌面/390px）、批次 3 交互走查
5. 留回滚镜像 `docker tag ...:rollback-<commit>` → `docker compose build gateway` → 冒烟容器（3099，权限 1000:1000，
   显式生产 env，**不做 401/403 实验**）→ 上线（background 脚本 + 40s 健康轮询 + 失败自动回滚）
6. 容器内 md5sum 与仓库逐文件核对 + 公网 cc.mikus.ink 200
7. commit + push + GitHub Actions 全绿

**注意**：Codex 跑的时候它自己走这个网关 → **绝不在 Codex 运行期间重启网关容器**；三批的部署都安排在 Codex 退出之后。

## 6. 风险与回滚

| 风险 | 应对 |
|---|---|
| 测试 vm 契约比想象中脆（多 script 顺序/全局污染） | 批次 1 只做拆分不做任何逻辑改动，340 条全绿才进批次 2 |
| 玻璃拟态在低性能设备 backdrop-filter 卡顿 | 已收敛：blur 仅用于 sticky 头部/弹框，卡片主体纯白无 blur；`prefers-reduced-motion` 兜底；验收看 390px 手机视图 |
| 断言文案被「优化」掉 | brief 里逐条列文案红线 + 我逐条 diff 审 |
| 静态路由引入路径穿越 | 批次 1 专门回归（穿越 404）+ 现有路由零改动 diff 审 |
| 每批都有回滚镜像 | `cc-manage-gateway:rollback-<commit>`，一键 `docker tag rollback latest` + up |

## 7. 待你拍板

1. ~~视觉方向~~ ✅ 已定：**浅色现代化**，保留粉紫品牌主色，玻璃拟态克制使用（头部/弹框）。
2. **预览**：我先生成一个静态 HTML 预览（`/tmp/cc-ui-preview.html`，浅色，含前台/后台两屏 mock 数据），
   你看了点头再让 Codex 开工。
3. 批次顺序按 1→2→3 串行（每批上线验证后再开下一批），预计每批 Codex 30~90 分钟 + 我的验收部署 20 分钟。
