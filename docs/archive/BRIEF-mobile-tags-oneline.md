# 增量任务书：手机端标签条改「一行」（不再折行）

> 与 `SPEC.md` 等权。**只做下面这一处改动 + 一条回归测试**，不要重写已验收代码。

## 现象与根因（下面数字都是真实测量，不是估计）

- 线上 `https://cc.mikus.ink/` 的账号卡片底部标签条：
  `public/index.html` 约 438 行 → `.tags { margin-top: 14px; display: flex; justify-content: flex-end; gap: 6px; flex-wrap: wrap; }`
- 单张卡三枚 pill 的实测宽度：`已启用 · 不可用` = **98px**，`月额度已用完 · 10/11 04:41 重置` = **181px**，`套餐 Go 个人版 · $10/月` = **140px**
  → 合计 419px，加 2×6px 间距 = **431px**
- 手机端卡片内容宽 = 视口 − 2×`--gutter`(16) − 2×`--card-pad`(16)；**360px 视口 → 296px**
- 真实浏览器实测（296px 容器）：**当前 CSS → rows=2、标签条高 57px**（折成两行，与用户手机截图一致）；
  改成 nowrap + `overflow-x:auto` 后 → **rows=1、高 26px、scrollWidth=431 > clientWidth=296**（单行 + 可横向滑，pill 宽度不变 98/181/140）
- 结论：`flex-wrap: wrap` + 右对齐在窄屏必然折行。用户要求「标签不要回车，要一行」。

## 要改什么（只动 `public/index.html`）

在**已存在的** `@media (max-width: 640px)` 块内（该块目前设置 `--gutter` / `--card-pad`，约 451 行）新增：

```css
    /* 标签条：窄屏强制单行 + 横向滚动（pill 不换行、不压缩） */
    .tags {
      flex-wrap: nowrap; justify-content: flex-start;
      min-width: 0; max-width: 100%;
      overflow-x: auto; overflow-y: hidden;
      -webkit-overflow-scrolling: touch; overscroll-behavior-x: contain;
    }
    .tags .tag { flex: 0 0 auto; }
```

- **作用域必须是 ≤640px 媒体查询**：>640px 的卡片内容宽 ≥577px > 431px，本来就不折行，桌面观感（标签右对齐）必须保持不变。
- **不要隐藏滚动条、不要加渐变/mask 遮罩**：被裁掉一半的第三枚 pill 就是「可横滑」的提示（可发现性优先）。
- 不要改 `.tag` 基础样式（字号/内边距/颜色/圆角）、不要动 `.tags` 桌面端的 `justify-content: flex-end`。
- 不要引入 JS 改造，不要新增结构。

## 硬约束

- 只动 `public/index.html`（+ 一条测试文件）。**不碰** `src/`、`gateway.mjs`、`vendor/`、`admin.html`（已确认后台页没有 `.tags` 标签条，无需处理）。
- 不 commit、不 push（Miku 负责提交与上线）。

## 验收（先红后绿，贴真实输出）

1. **先写回归测试**（`test/review-group-b.test.mjs` 追加，或新建 `test/mobile-tags.test.mjs`；沿用现有 DOM shim 风格，只读 `public/index.html` 文本）：断言
   ① 在 `@media (max-width: 640px)` 块内存在作用于 `.tags` 的规则，且同时含 `flex-wrap: nowrap` 与 `overflow-x: auto`；
   ② 存在 `.tags .tag` 的 `flex: 0 0 auto`；
   ③ 桌面端基础 `.tags` 规则仍是 `flex-wrap: wrap`（防止改错作用域，把桌面也一起改了）。
   先跑一次证明它**红**（当前代码没有这些规则），把失败输出贴回来。
2. 再改 CSS，重跑该测试 → **绿**。
3. `npm test` 全量：期望 **238 全绿**（237 + 新增；若拆成多条就报实际条数）。
4. 贴 `git diff --stat` 与关键 hunk（前后各 3 行上下文）。
5. 说明：布局真相由 Miku 在真实浏览器里量（296px 容器 已量好 before/after），测试只负责钉住 CSS 契约不被回退。
