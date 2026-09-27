# brief: 窄屏「网关」标签跑到卡片外（≤639px）

## 0. 执行纪律（先读这一段）
- 每一轮回复都必须包含真实的工具调用；**不要**只打印「我将会…」「现在开始…」然后停下。
- 不要中途停下来问确认；不要申请权限。跑完编辑 + 自查 + 构建 + 测试再退出。
- 结束语必须给出：改了哪个文件哪一行、`npm run panel:build` 的结果、`npm test` 前后计数、你实际跑过的命令原文。

## 1. 环境提示（省你一轮摸索）
- 本环境**没有** `apply_patch` 工具（那是个不存在的命令，调用会 `command not found`）。
  改文件请用 `python3` 精确字符串替换、`sed -i`、或 `cat > file` 整文件重写。
- 不要去装任何依赖、不要跑 `npm i` / `npm ci`（`panel/node_modules` 已存在）。
- **不要碰浏览器/headless chromium**：像素级几何由 Hermes 侧核验，不在你的验收范围。

## 2. 缺陷（用户 2026-09-27 手机截图指出）
手机上「网关」两个字跑到**白色卡片外面**，落在粉色页面背景上（截图里标签一半在卡片左边缘外）。

## 3. 已实测的精确数字（Hermes 侧，playwright 真机视口渲染）
视口 320 / 360 / 384 / 390 / 403 / 430 / 470 / 639（DPR 3~3.5，安卓 UA）全部一致：

| 量 | 值 (CSS px) |
|---|---|
| `.hero-banner` 左边缘 | 16 |
| `.hero-banner` padding-left | 20 → 内容列左沿 **36** |
| 卡片内普通数字（如「11.48」）盒左沿 | 37 |
| `.hero-sub-label`（「网关」）盒左沿 | **4** ← 比卡片左边缘还左 12px |
| `#health`（可用 2/4 徽章）盒左沿 | 32.8（在卡片内 ✓） |
| `.hero-mascot` 盒左沿 | 5（看板娘出卡片 11px，这是刻意的） |

640px 及以上档正常（`.hero-sub-label` 左沿 141，在卡片内）。

## 4. 根因
`panel/src/styles/panel.css` 第 545–555 行，`@media (max-width: 639px)` 里：

```css
.hero-mascot { ... left: -32px; }        /* 看板娘图片框左沿 → 5，已在卡片外 */
.hero-ident { padding-left: 72px; }
.hero-sub { margin-left: -105px; }       /* ← 元凶：把副行对齐到「图片框左沿」 */
```

负 margin 的对齐基准是看板娘**图片框**左沿，而图片框本身就已经在卡片外 11px，
所以「对齐图片框」= 必然跑出卡片。实测：问候语 x ≈ 109（36 + 72），109 − 105 = **4**。
（这是上一个提交 `8ef8037` 引入的。）

## 5. 要做的改动（只改这一条声明）
把 `@media (max-width: 639px)` 里的 `.hero-sub { margin-left: -105px; }` 改成 **`margin-left: -73px;`**，
即把标签盒左沿从 4 挪到 36 = 卡片内容列左沿（16 + 20）。

- 目的：标签整体留在卡片内，同时仍在看板娘正下方（看板娘横跨 x 5–103），保留 L 形关系。
- **不要**改其它任何规则：`.hero-sub { margin-top: 26px }`、`.hero-sub-label-rest { display:none }`、
  `nowrap`、`#health` 的收窄规则、以及 ≥640px 档（`.hero-ident`/`.hero-sub` 的基础规则）全部保持原样。
- 不要引入新的定位方式（不要改 absolute/transform），不要新增变量。

## 6. 验收（自己跑完再退出）
1. 改完 `panel/src/styles/panel.css` 后立即 `git diff --stat`，确认只有这一个文件、只有这一行变化。
2. `npm run panel:build` 必须成功（它会 astro build + 同步到仓库根 `public/`）。
3. 构建产物里确认新值已生效，例如：
   `grep -o "hero-sub{[^}]*margin-left:-73px" public/assets/*.css`（若已压缩，接受等价匹配；
   用你实际跑通的命令原文写进结论）。
4. 回归：`npm test`
   - **先**在改动前跑一次记录基线计数（`# tests / # pass / # fail / # skip`），改完再跑一次，
     两次必须 `fail 0` 且 pass 数不减少。
   - 注意：`npm test` 会先跑 panel 构建，耗时几分钟，正常。
   - 若出现「panel 未构建 / 503」类失败，先 `npm run panel:build` 再重跑。
5. **不要** `git commit`、**不要** `git push`、**不要**动 docker、不要碰 `vendor/`、`config/`、`.env`。

## 7. 边界
- 只允许改：`panel/src/styles/panel.css`、以及（如确实需要）在 `docs/` 下留一条改动说明。
- 其它文件一律不动。提交由 Hermes 复核后完成，像素级核验也由 Hermes 做。
