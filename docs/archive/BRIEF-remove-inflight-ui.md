# 增量任务书：前台面板去除「在途」展示

> 与 `SPEC.md` 等权。**不得重写已验收的代码**，只做下面这一处删除 + 同步收尾。

## 目标

`public/index.html` 的前台只读面板里**不再出现任何「在途」字样与在途数字**。

后端 `concurrency` 字段与调度打分（`score = remainingRatio / (1 + concurrency)`）**保持原样一行不动**——有测试依赖它，用户要的是「界面上别显示」，不是「取消这个能力」。

## 必改点（全部在 `public/index.html`）

1. **删掉第 4 张 KPI 卡整块**：`<div class="kpi" id="kpi-box-concurrency">` 到其闭合 `</div>`（含折线 svg 与 `<span>在途请求</span>`）。
   删后 KPI 行剩 5 张，顺序不变：账号数 / 可用 / 暂停中 / 总请求 / 错误数。
2. **账号卡片的 tags**：删掉 `tags.push('<span class="tag info">在途 ' + esc(num(a.concurrency)) + '</span>');` 整行（旁边其它 tag 不动）。
3. **顶部 health pill 文案**：`'可用 X / Y · 在途 N'` → 只保留 `'可用 X / Y'`（`num(s.available)` / `num(s.accounts)` 的写法不变）。
4. **收尾引用**，漏一个就会 `$() === null` 报错：
   - `render()` 里的 `paintKpi('kpi-box-concurrency', 'kpi-concurrency', s.concurrency, { kind: 'accent' });` 整行删除；
   - `clearKpis()` 两个 id 数组里去掉 `kpi-concurrency` 与 `kpi-box-concurrency`；
   - CSS 注释里「在途>0 粉」的措辞同步改掉，别留下指向已删元素的注释。

## 硬约束

- 只动 `public/index.html`。**不要动** `src/`、`gateway.mjs`、`test/` 里的后端断言、`vendor/`。
- 不顺手改其它文案/颜色/类名/无障碍属性；不重构不相关函数。
- 后端 `/api/status` 的 `summary.concurrency` 与账号对象的 `concurrency` 必须原样保留。
- 不 commit、不 push（Miku 负责提交与上线）。

## 验收（你自己跑，把真实输出贴回来，不要转述）

1. `npm test` → 期望 **237 全绿**。若某条测试引用了被删元素，**改测试而不是恢复元素**，并在汇报里点名改了哪条、为什么。
2. `grep -n '在途' public/index.html` → **无输出**；`grep -n 'kpi-concurrency' public/index.html` → **无输出**。
3. 渲染冒烟：复用 `test/helpers.mjs` 的 DOM shim 跑一次 `render()`（可临时写个 `node -e` / 临时脚本，跑完删掉），确认渲染无异常、`#kpi-total` `#kpi-errors` 等仍能取到值、控制台无 `null` 相关报错。
4. 贴出 `git diff --stat` 与关键 hunk（前后各 3 行上下文即可）。
