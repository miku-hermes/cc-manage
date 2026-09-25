# 面板前端迁移到 Astro + Tailwind（B22–B25）

## 为什么

用户 2026-09-25 语音反馈两点：

1. **图表不该占着主页面** —— 主页面要简洁，图表单独一页；
2. **「你写了好多重复的元素」** —— 实测确认：`index.html` 里 KPI 卡结构出现 **37 处**，
   `render-hero.js` 又用 JS 拼了 **15 处**（同一套东西两套写法）；账号卡片模板散在
   `app.js` / `render-cards.js` / `render-hero.js` **3 个文件**里。前端合计 **4,514 行 / 18 文件**。

用户选定的方向：**类似 Tailwind CSS 和 Astro**。

## 可行性（已 spike 验证，2026-09-25）

在 Docker 里用 `--memory=1000m`（模拟本机仅剩 ~1GB 可用内存）跑最小 Astro + Tailwind 5/4 工程：

- `npm install` 成功，`node_modules` **205M**
- `astro build` 成功，1.68s，1 page
- 产物 `dist/index.html` (16K) + `dist/assets/index.<hash>.css` (8,428 字节)
- **确认 Tailwind 真的编译了**（CSS 里含 `grid-cols-3` / `rounded-xl` / slate 色）、组件已展开、
  **产物里 0 个 JS 文件**（Astro 默认零 JS）
- **1000m 内存上限下无 OOM**
- 总耗时 57s（大头是拉镜像 + npm install）

现状：`Dockerfile` 是**单阶段**，基础镜像 `node:22-alpine`，`COPY public/ ./public/`。
→ 需改多阶段：构建阶段用 `node:22-slim`（musl 下原生依赖风险高，Debian 已验证），
运行阶段**保持 alpine 不变**，只 `COPY --from` 静态产物。

## 目标结构

```
panel/                      ← Astro 工程（提交进仓库）
  package.json / package-lock.json / astro.config.mjs
  public/                   ← 逐字复制进产物（保持 URL 不变）
    js/*.js                 ← 现有 JS 模块原样放这儿，服务路径仍是 /js/*.js
    vendor/echarts.min.js
    favicon.ico
  src/
    layouts/Base.astro
    components/*.astro      ← KPI 卡 / 额度条 / 账号卡 / 头部 / 主题开关…
    pages/{index,trend,admin}.astro
    styles/global.css       ← @import "tailwindcss" + @theme 映射既有令牌
  dist/                     ← 构建产物（gitignore）
```

运行镜像里 `panel/dist/` → `/app/public/`，**`gateway.mjs` 的路由一行不用改**。

### 两个必须记住的细节

- `astro.config.mjs` 里设 **`build.format: 'file'`** —— 产物出 `index.html` / `admin.html` / `trend.html`，
  与 gateway 现有的 `/`、`/admin` 显式路由匹配；默认的目录格式（`admin/index.html`）会带来
  尾斜杠与重定向问题。
- `npm ci` 需要 **提交 `panel/package-lock.json`**，否则构建不可复现。

## 分步（每步独立可验证、可上线）

### B22 —— 管道先行，零视觉变化

建 `panel/` 工程 + 多阶段 Dockerfile；**现有 `index.html` / `admin.html` 原样搬成 `.astro` 页面**，
现有 CSS / JS **先原样搬进 `panel/public/`**，不换 Tailwind。

**验收判据：部署后页面与现在逐像素级一致**（同样的 DOM 结构、同样的类名、同样的 CSS 文件），
只证明「构建管道可用、产物路径不变、gateway 不用改」。

- 测试路径机械替换：`public/<x>` → `panel/public/<x>`（源码类）；
  断言产物行为的测试指向构建产物或保持不变。
- **必须**：`.gitignore` 加 `panel/node_modules/`、`panel/dist/`、repo 根的 `public/`
  （迁移完成后 `public/` 是构建产物，不再是源码）。
- 本批次**不动任何样式、不删任何重复** —— 混在一起就分不清故障来自管道还是样式。
- 根 `public/` 是**构建产物**（由 `panel/dist/` 同步而来，`git rm --cached` 脱离跟踪、`.gitignore` 忽略），
  **测试前必须先构建**：`bash scripts/panel-build.sh`（或 `npm run panel:build`）。面板缺失时
  `GET /`、`GET /admin` 回 503 可操作提示（含构建命令），`/health`、`/api/*` 照常 —— 不裸抛 500。

### B23 —— 组件化去重

- 抽出 `KpiCard` / `CreditsBar` / `AccountCard` / `SiteHeader` / `ThemeToggle` 等 Astro 组件。
- JS 里那三处卡片模板改用 Astro 生成的 **`<template>`** 克隆，不再拼 HTML 字符串。
- 判据：同一段结构**只存在一处**（组件里）；`grep` 重复计数清零；现有行为断言全绿。

### B24 —— 主页面拆分

- 图表移入独立页 `/trend`（`src/pages/trend.astro` + 现有 `render-trend.js`）。
- 主页面做减法：只留余额概览 + 必要的概览信息 + 两个入口。
- 判据：主页面不再加载 `render-trend.js` / `vendor/echarts.min.js`（懒加载只在 `/trend` 发生）。

### B25 —— Tailwind + 现代 CSS

- 既有语义令牌（`tokens.css` 的 `--surface-*` / `--text-*` / 图表令牌）映射进 Tailwind `@theme`，
  **保留浅/暗两套**；不硬编码 hex。
- 主页面用现代 CSS 重做观感：容器查询、`:has()`、视图过渡（`@view-transition`）等。
- 判据：实拍对比 + 既有 a11y/令牌断言全绿。

## 红线（跨批次不变）

- `/api/*` 契约、脱敏口径、登录门控、`/health` 与 `/ready` 语义**一律不动**
- 空态不撒谎 / 零值不拿最重视觉权重 / 错误全 0 不画序列
- 图表库仍是 vendored 全量构建 + 懒加载（见 `panel-conventions.md`）
- 深浅两套主题令牌齐全；图表令牌不叠 `opacity`
