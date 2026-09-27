# brief: 账号卡片按 komari 探针卡布局重排 + 内容瘦身（含「额度刷新」行）

## 0. 执行纪律（先读）
- 每轮回复必须带真实工具调用；不要只打印计划就停；不要中途停下问确认。
- 结束语必须给出：改了哪些文件、`npm run panel:build` 结果、`npm test` 前后计数、你实际跑的命令原文。

## 1. 环境提示
- 本环境**没有** `apply_patch`。改文件用 `python3` 精确替换 / `sed -i` / 整文件重写。
- 不要装依赖（`panel/node_modules` 已存在）；不要跑 `npm i`/`npm ci`；不要碰浏览器/headless chromium。
- 认证/构建基线：HEAD 应为 `3c8411e`，工作树干净（除本 brief 文件）。

## 2. 目标形态（参考 komari 探针卡：komari-web/src/components/Node.tsx + UsageBar.tsx）
用户要「抄 komari 的卡片布局」并瘦身。目标结构（手机优先，403px）：

```
┌───────────────────────────────────────────────┐
│ 主号   Go 个人版 · $10/月            [● 月额度已用完] │  ← 头部：名称(粗体) + 套餐(灰小字) …… 右：状态药丸（**没有可见的详情按钮**，整卡可点 → §4bis）
│ ─────────────────────────────────────────── │  ← 细分隔线
│ 5 小时窗口                              2.9%  │  ← 标签(灰) 左 / 百分比(中粗) 右
│ ▓░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  │  ← 8px 圆角条（≥80% 红 / ≥60% 橙 / 否则绿）
│ 9/27 23:13 重置 · 还有 4 小时 27 分          │  ← 条下小灰字：额度重置时间（见 §4）
│ 本周窗口                               70.8%  │
│ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░░░░░░░░░░░░░░░░  │
│ 9/29 22:08 重置 · 还有 1 天 2 小时           │
│ 本月周期                               42.4%  │
│ ▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░░░░░░░░░░░░░░░░░░░  │
│ 10/11 04:41 重置 · 还有 14 天                │
│ ─────────────────────────────────────────── │
│ 剩余余额                                 $5.75 │  ← 保留 <b class="usable-balance">
│ 本周期                334,575,606 token · 花费 $4.24 │
│ [标签条 tags]                                  │  ← 底部栏只留 tags（测试要求）
└───────────────────────────────────────────────┘
```

## 3. 内容删减（用户已确认）
卡片上**删除**以下四项，全部已在「详情弹窗」里有对应内容（**Hermes 已核实，不必再找**）：
- 弹窗「额度构成」= `panel/src/components/AccountDetailModal.astro:8`（`#m-detail-credits` + `#m-detail-credit-label`）
- 弹窗「窗口明细」每格含 `已用 / 上限（百分比）` 与 `重置 M/D HH:MM` = `panel/public/js/detail.js:18`、`:19-20`
1. 每条进度条右侧同行的「重置于 9/27 23:13（还有 4 小时 27 分）」→ 从百分比同行**移走**，改为**条下方一行小灰字倒计时**「X 后重置额度」（见 §4）。百分比同行只留百分比。
2. `.card-fresh`（「额度更新于 54 秒前」）→ 卡片上不再显示（元素保留、`hidden` 置真即可，不要删元素，测试按它存在断言）。
3. 整块 `.credits-block`（粉色「额度构成」条 + 「月度 X.XX」）→ 从卡片移除（弹窗里已有「额度构成」）。
4. `.card-usage` 里重复的「10/11 04:41 重置」尾巴 → 去掉，只留「<token> token · 花费 $X.XX」。

## 4. 进度条下方「额度重置时间」（用户明确要的就是这个）
> 用户两轮确认：要的是**额度重置时间**（上游额度什么时候重置），不是轮询刷新节奏。这是本轮核心诉求，**绝不能从卡片上删掉**。

- 每条进度条下面加一行小灰字（11px、次级灰、`tabular-nums`），内容＝**该窗口的重置时间 + 还有多久**，用现有的 `.bar-reset`（`data-f="bar-5h-reset"` / `bar-week-reset` / `bar-month-reset`）承载，JS 继续往它里面写值：
  - 有 `resetAt` 且在将来：`9/27 23:13 重置 · 还有 4 小时 27 分`、`9/29 22:08 重置 · 还有 1 天 2 小时`、`10/11 04:41 重置 · 还有 14 天`
    - 绝对时间格式：`M/D HH:MM`（24 小时制，与 `detail.js:20` 的 `toLocaleString('zh-CN', {month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false})` 同口径）。
    - 剩余时长格式：≥1 天用 `X 天 Y 小时`（`Y` 为 0 时省略）；<1 天用 `X 小时 Y 分`（`Y` 为 0 时省略）；不足 1 小时用 `X 分钟`。
  - 已过期（`resetAt` 在过去）：显示 `等待重置`（不要显示负时长）。
  - 窗口未开始/无用量且无 `resetAt`：显示 `空闲中`。
  - 完全没有该窗口数据：整行不渲染（不要 `—`、不要 `0`）。
- 数据来源：`/api/status` 各账号的 `quota.fiveHour/weekly/monthly.resetAt`（秒级时间戳，`detail.js` 已在用同一字段，可参考它取数方式）。
- 三条窗口**都要**显示绝对重置时间（用户明确要的就是这个），不是只有本月。
- **不要**在卡片上新增「刷新间隔 / 额度刷新」这类轮询节奏行（那是我上一版理解错的内容，已作废）。

## 4bis. 整卡点击打开详情（用户最新要求，**覆盖前面关于可见「详情」按钮的写法**）
> 用户原话：「把详情按钮去除，然后点击卡片就能立即到图表和详情」。

- **不再渲染可见的「详情」按钮**（图标与「详情」两个字都不显示）。
- 改为：**点击卡片任意位置 → 直接打开该账号的详情弹窗**（弹窗里就是图表与各项明细，弹窗组件与逻辑保持不变，不要另造页面）。
- 实现要点（保持可访问性与既有测试契约）：
  - `.acct-card` 加 `position: relative` 与 `cursor: pointer`。
  - `.detail-trigger` **保留为真实 `<button>`**，但用 stretched-button 手法铺满整张卡：`position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0;`（保留 `data-f="detail-trigger"`、`aria-haspopup="dialog"`、`aria-label="查看 <账号名> 详情"`，键盘 Tab 依然能聚焦并回车打开）。
  - 键盘焦点反馈画在卡片上：`.acct-card:has(.detail-trigger:focus-visible)` 或 `.acct-card:focus-within` 给卡片加可见焦点环/描边（不要只把焦点环画在透明按钮上，那样用户看不见）。
  - 卡片 hover 反馈沿用现有 `transition-[box-shadow,transform,background-color]`（阴影/微微上浮即可），让「整卡可点」有感知。
  - 覆盖层不能吞掉卡片内本该可交互的元素（`[data-f="tags"]` 目前是只读标签，无链接/按钮；如果里面出现 `<a>`/`<button>`，那两个元素要 `position: relative; z-index: 1` 浮在覆盖层之上）。
- 视觉上卡片看起来跟 §2 的图一致，只是头部右侧少了那个按钮。


保留类名与结构钩子（可以改样式与位置，但不能改名/删除）：
`.acct-card`、`.acct-card-head`、`h2.card-head`（含 `truncate`）、`.plan-slot[data-f=plan-slot]`、
`.usable-balance[data-f=usable-balance]`（**无快照时显示 `—` 不得显示 `0.00`**）、
`.acct-card-bars`、`.bar-group[data-f=bar-5h|bar-week|bar-month]`、`.bar-label`、`.bar-pct`、`.bar-reset`、
`.acct-card-foot`（内含 `[data-f=tags]` 且带 `min-h-6`）、`.detail-trigger`（`aria-haspopup="dialog"`、
`aria-label` 仍是 `查看 <账号名> 详情`）、`.card-fresh`、`.card-usage`、`StatusPill`、`CreditsBar` 组件文件。
- 源码里必须继续出现字面量 `5 小时窗口`、`本周窗口`、`本月周期`（`test/gateway.test.mjs` 测试6 做正则匹配）。
- `.bar-label` 的 `white-space: nowrap; flex: none` 必须保留（上一批刚修好的折行问题）。
- 视觉风格仍走现有 daisyUI/theme token（`--text-secondary`、`--border-light`、`bg-base-100` 等），不要引入新依赖、不要内联第三方 CSS。

## 6. 允许修改的测试（只允许这些，且必须等强度重写，不得删除或放宽）
仅当断言编码的是「旧排版」时可改：
- `test/review3-fixes-b-ui.test.mjs`、`test/b24g-panel-polish.test.mjs`、`test/review-group-b.test.mjs`、`test/tabular-numbers.test.mjs` 里针对 `.card-fresh` 文案的断言 → 改成断言新语义（刷新节奏文案，且缺失时隐藏）。
- `test/gateway.test.mjs`、`test/tabular-numbers.test.mjs` 里针对 `.card-usage` 尾巴「重置」的断言 → 改成断言只含 `token` 与 `花费`。
- `test/detail-modal.test.mjs` / `test/batch2-ui.test.mjs` 里若断言详情按钮位于 `.acct-card-foot` 内 → 允许改为「位于卡片内且保留 `.detail-trigger` 契约」。
- 若有断言要求卡片上出现**可见的**「详情」文案/按钮（`/>详情</`、按钮可见性、图标存在）→ 允许改为等强度的「整卡即触发器」断言：`.detail-trigger` 仍是 `button`、带 `aria-haspopup="dialog"` 与 `aria-label="查看 X 详情"`、且铺满整卡（`position:absolute; inset:0` / 不可见），并断言卡片有 `cursor: pointer`。
- 若断言 `.credits-block` 在卡片内 → 改为断言它**不在**卡片内、且弹窗内仍有「额度构成」。
其余测试一律不得改动；任何一条测试不得被删除或跳过（skip 数只能保持或减少）。

## 7. 验收（自己跑完再退出）
1. `git status --short` 只应出现本 brief + `panel/`、`test/` 下与上述相关的文件。
2. `npm run panel:build` 成功。
3. `npm test`：改动前先跑一次记录基线（`# tests / # pass / # fail / # skip`，含 vendor 子套件），改完再跑，两次 `fail 0`、pass 不减、skip 不增。
   - 已知环境抖动：`test/batch3-ops.test.mjs` 的 hang-guard 子进程偶发 `spawnSync ETIMEDOUT`，复跑即过，不算回归。
4. 结论里附：改了哪些文件、build 结果、两次计数、命令原文、以及「弹窗里确实有 额度构成/重置时间」的确认方式（读了哪个文件/哪行）。

## 7bis. 收尾：把上一轮遗留的 3 条失败测试按新结构等强度修好（Hermes 授权）
上一轮结束后仍有 3 条失败，都是「编码旧排版」的断言，现授权修好（**只准改这 3 条，其余一律不动**）：

1. `test/batch2-ui.test.mjs` 的 `B2-7：过期 resetAt 不再拼出「还有 即将重置」`
   —— **不要改测试**，改源码：过期 `resetAt`（在过去）时输出文案改为 **`窗口已重置`**（我 brief 里原先写的「等待重置」作废；`窗口已重置` 与该测试及既有语义一致）。`test/batch2-ui.test.mjs` 里这条断言保持原样。
2. `test/visual-b4.test.mjs` 的 `B4-3：额度构成分段条三段宽度按金额占比（月度/购买/赠送）`
   —— 卡片上已无构成条，断言改为**指向详情弹窗的构成条**：用同一份 `credits:{monthlyCredits:2,purchasedCredits:1,freeCredits:1}` 驱动弹窗渲染（`panel/public/js/detail.js:56-60` 的逻辑），断言 `#m-detail-credits` 内仍有 `<i class="seg-month…" style="width:50%">` / `seg-buy 25%` / `seg-gift 25%`；三段全 0 时断言**没有** `seg-*` 子节点且 `#m-detail-credit-label` 文案为 `额度构成无数据`（等强度：比例数值与兜底文案都必须照旧断言，不许放宽或改成「存在即可」）。
3. `test/visual-b4.test.mjs` 的 `B4-4：无 lastQuota 快照的账号构成区块显示兜底文案，无假分段条`
   —— 卡片部分改为断言弹窗侧：无快照时 `#m-detail-credit-label` = `额度构成无数据`、`#m-detail-credits` 无 `seg-*` 子节点；`bal-breakdown`（Hero 侧）那半段断言保持不动。

附带清理（仅当确认无引用时）：`panel/public/js/render-cards.js` 里为已删除的 `.credits-block` 填值的死代码（`credits-bar` / `credits-legend` 那段）可以删掉；如果任何测试仍引用这些字段，就保留函数并让它早退，不要制造新的失败。

## 7ter. 收尾②：前台卡片标签条去掉重复的「重置」徽章（用户要求「去除」）
- `panel/public/js/render-cards.js` 的 `fillTags()` 里，`exhausted` 分支（约 :120-125）会往标签条推一枚 `badge-ghost`「M/D HH:MM 重置」——现在卡片上每条进度条下方已有「重置时间」行，属重复，**从前台卡上移除这枚徽章**。
- **只动前台卡**：`panel/public/js/render-accounts-table.js` 里后台表格的重置时间渲染（:35、:80-83）必须保持原样（`B2-3` / `B2-4` 两条断言测的是后台）。
- 信息不能丢：账号耗尽状态仍由状态药丸（「月额度已用完」）+ 本月周期条下的重置时间行表达，`fillTags` 里 `paused` / `rateLimited` 两枚徽章保持不动。
- 若某条测试因此变红，只允许**等强度重写**：改成「前台卡标签条里不含重置徽章」的负向断言，不许删除测试或放宽为「存在即可」。
- ⚠️ **定位标签条必须用 class，不能用 `data-f`**：`card()` 在返回前会把所有 `[data-f]` 属性删掉（内部钩子不留在产出 DOM 里），所以 `/<div[^>]*data-f="tags"[^>]*>(.*?)<\/div>/s` 会匹配到空串 → `doesNotMatch('', /重置/)` 恒为真 = **假绿**。要用 `/<div[^>]*class="[^"]*\btags\b[^"]*"[^>]*>(.*?)<\/div>/s`（或在产出 HTML 上按 class 找）。
- **必须做变异检查并贴出两次输出**：`git stash push -- panel/public/js/render-cards.js`（徽章会回来）→ 跑这两条用例**必须变红**；`git stash pop` → 再跑**必须变绿**。不红就说明断言是空转的装饰，必须修到能红。
- 改完跑 `npm run panel:build` + `npm test`（`# fail 0`）+ `npm --prefix vendor/commandcode-proxy test`，给前后计数与命令原文。

## 7quater. 状态标签去底色、变小（用户要求：「右上角的可用/不可用标签太大了，能不能去除背景」）
- 目标形态：卡片右上角的状态从「实底药丸」改成 **色点 + 文字**：
  - 去掉底色/边框/内边距（`background: transparent; border: 0; padding: 0`），不再有大色块；
  - 字号降到 **0.75rem（12px）**、字重 600；文字用 tone 色（`is-ok`→`--success`、`is-warn`→`--warning`、`is-bad`→`--danger`），色点（`.dot`）保留；
  - 卡片内右对齐（`justify-content: flex-end`），使短文案（「可用」）也贴着卡片右边缘，不留空色块痕迹。
- **契约不许动**：HTML 仍须匹配 `<span class="acct-status badge[^"]*is-ok">` 这类既有断言；`.acct-status` / `.dot` / `is-ok|is-warn|is-bad` 类名、`min-w-[var(--status-col,0px)]` 等宽地板与 `syncStatusColumn()` 全部保留（不许钉死像素宽）。
- 作用域只限**卡片网格**（`.acct-card .acct-status`）；表格视图行（`.acct-table`）与后台页面不要动。
- 允许等强度修改的测试：`test/detail-modal.test.mjs:82` 的 `assert.ok(parseFloat(after.statusFont) > parseFloat(before.statusFont))`——它靠「页面状态字号 > 内联 12px」成立，字号降到 12px 后会假红。改成与最终字号有明显差距的内联值（例如 18px）或改为断言内边距差异，**保持原意**（状态徽章尺寸参与卡片几何：改尺寸会改变卡片高度），不许删掉这条。
- 其余测试若因此变红，同样只许等强度重写。改完跑 `npm run panel:build` + `npm test`（`# fail 0`）+ vendor 套件，给前后计数与命令原文。

## 7quinquies. 状态标签：让样式真正生效 + 头部换行时也要贴右（Hermes 线上实测发现的遗漏）
上一轮 §7quater 只改了 panel.css，**线上实测没生效**，而且暴露第二个缺陷。实测证据（cc.mikus.ink，改后仍如此）：
- 卡片状态标签 computed：`background: oklch(0.61 0.12 155)`（绿底还在）、`padding: 4px 10px`、`font-size: 14px`、`justify-content: center` → 说明 panel.css 的 `.acct-card-head .acct-status` 规则**被 Tailwind 工具类/ daisyUI `badge-success` 压过**（层序问题，特异性再高也没用）。
- 头部换行缺陷：卡片宽 269.5px（vw1485，4 列）与 297px（vw640）时 `.acct-card-head` 折成两行（headH 67.9 而非 35.9），`.acct-card-actions`（状态标签）掉到第二行**左端**（与卡片右边距 130–158px）——「右上角的状态」在这两档根本不在右上角。

要做：
1. **样式生效**：运行时 className（`panel/public/js/render-cards.js:145`）去掉与视觉冲突的工具类 `px-2.5 py-1 text-sm`，视觉由 panel.css 的卡片作用域规则统一给；对 `background / border / padding / font-size` 用 `!important`（或等效的层序/选择器手段，前提是——线上 computed 必须是 `background-color: rgba(0,0,0,0)`、`padding: 0px`、`font-size: 12px`）。**契约不许动**：HTML 仍须匹配 `<span class="acct-status badge[^"]*is-ok">`；`.dot`、`is-*`、`min-w-[var(--status-col,0px)]`、`syncStatusColumn()` 全部保留。
2. **换行也贴右**：`.acct-card-actions` 加 `margin-left: auto`（头部 `justify-content: space-between; flex-wrap: wrap` 保持不动），使状态标签在「同行」或「被换到第二行」两种情况下都靠卡片右边缘。
3. **补一条真机断言（这次漏检的根因）**：`test/detail-modal.test.mjs` 用的是真 chromium + 构建产物，请在那里加一节断言（同文件，用现有 page）：
   - `.acct-card .acct-status` 的 computed `background-color` 为透明（`rgba(0, 0, 0, 0)`）、`padding` 为 `0px`、`font-size` ≤ 12.5px；
   - 同一个卡片上，状态标签右边缘与卡片右边缘的距离 ≤ 24px（375px 视口），且与标题同一行（`Math.abs(identityTop - actionsTop) < 2`）。
   断言必须在**改前**能红（Leaving 上面两条改动前它是红的），改后变绿。
4. 跑 `npm run panel:build` + `npm test`（`# fail 0`）+ vendor 套件；并在结论里贴出构建产物里该规则的原文（`grep -o '\.acct-card-head \.acct-status{[^}]*}' public/assets/*.css`）作为「样式确实编译进去了」的证据。

## 8. 边界
- 不要 `git commit` / `git push` / 不要动 docker / 不要碰 `vendor/`、`config/`、`.env`。
- 像素级与视口级核验（320/360/390/403/430px 卡片高度、折行、出框、重叠）由 Hermes 做，你不用跑浏览器。
