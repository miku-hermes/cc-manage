# brief: 账号卡片「窗口/周期」标签被挤成两行（≤639px 手机档）

## 0. 执行纪律（先读这段）
- 每轮回复必须带真实工具调用；不要只打印「我将会…」然后停下；不要中途停下来问确认。
- 结束语必须给出：改了哪个文件哪一行、`npm run panel:build` 结果、`npm test` 前后计数、你跑过的命令原文。

## 1. 环境提示（省你一轮摸索）
- 本环境**没有** `apply_patch`（不存在的命令）。改文件用 `python3` 精确字符串替换 / `sed -i` / 整文件重写。
- 不要装依赖（`panel/node_modules` 已存在），不要跑 `npm i` / `npm ci`。
- 不要碰浏览器 / headless chromium；像素级与视口级核验由 Hermes 做。

## 2. 缺陷（Hermes 侧真机视口实测，403×950 @DPR3）
账号卡片里三行进度条的左侧标签被挤成两行，末字独占第二行：

| 视觉呈现 | 实测 |
|---|---|
| 「5 小时窗 / 口」 | `.bar-label` 高 **36px** = 2 行（line-height 18px） |
| 「本周窗 / 口」 | 同上 |
| 「本月周 / 期」 | 同上 |

- 4 张账号卡里 **3 张**的标签全部折行（第 1 张卡的 5 小时/本周两行侥幸未折）。
- 标签列可用宽度只剩 **44–58px**，而「5 小时窗口」需要 ~60px、「本月周期」需 ~48px。
- 对照：`white-space: normal`（没有 nowrap），说明就是被压窄后换行。

## 3. 根因
`panel/src/styles/panel.css`（账号卡片区，约 417–419 行）：

```css
.bar-head { display: flex; align-items: baseline; justify-content: space-between; gap: .5rem; font-size: .75rem; }
.bar-tail { display: flex; align-items: baseline; gap: .4rem; min-width: 0; }
.bar-label { color: var(--text-secondary); }
```

`.bar-tail`（右侧「43.0% 重置于 9/27 23:13（还有 4 小时 27 分）」）有 `min-width: 0` 可以收缩换行，
但 `.bar-label` 既没 `flex: none` 也没 `nowrap`，于是**它也被压缩** → 四字标签变 44px → 硬折行。

## 4. 要做的改动
只加两条声明（保持其它规则不动）：

```css
.bar-label { color: var(--text-secondary); white-space: nowrap; flex: none; }
```

- 意图：标签按内容宽度占位、永不折行；剩余宽度交给 `.bar-tail`，让它在卡内自行换行。
- **不要**改 `.bar-head` / `.bar-tail` 的其它属性，不要动 `<639px` 以外的规则，不要改渲染逻辑
  （`5 小时窗口` 等字符串必须继续是源码字面量 —— `test/gateway.test.mjs` 测试6 对源码做正则匹配）。

## 5. 验收（自己跑完再退出）
1. `git diff --stat`：只应有 `panel/src/styles/panel.css` 一个文件、1 处改动。
2. `npm run panel:build` 成功，产物同步到仓库根 `public/`。
3. `npm test`：改动前先跑一次记录基线（`# tests / # pass / # fail / # skip`），改完再跑，两次 `fail 0` 且 pass 不减少。
   （已知：`npm test` 会先构建面板，耗时数分钟；`test/batch3-ops.test.mjs` 的 hang-guard 子进程偶发
   `spawnSync ETIMEDOUT`，属环境抖动，复跑即过，不算你的回归。）
4. 结论里附上你实际跑的命令原文与两次计数。

## 6. 边界
- 只允许改 `panel/src/styles/panel.css`（如需说明可在 `docs/` 留一条）。
- 不要 `git commit` / `git push` / 不要动 docker / 不要碰 `vendor/`、`config/`、`.env`。

## 7. Hermes 侧复核口径（供参考，不用你跑）
320 / 360 / 390 / 403 / 430px 视口下：4 张卡 × 3 个 `.bar-label` 的 `getBoundingClientRect().height` 必须 = 18px（1 行），
`document.documentElement.scrollWidth == innerWidth`（无横向溢出），标签不出卡片。
