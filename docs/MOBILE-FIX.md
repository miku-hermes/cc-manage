# 任务：修复手机端布局（前台 index.html + 后台 admin.html）

## 实测证据（DOM 几何测量，非肉眼判断）

用 320 / 375 / 414px 三种视口实测两个页面，确认的问题：

### 🔴 问题 1（最严重）：后台表格在手机上「操作」列不可达

```
视口 320px → .table-wrap 宽 282px，但 <table> 宽 750px（scrollWidth 750）
视口 375px → .table-wrap 宽 337px，<table> 宽 750px
视口 414px → .table-wrap 宽 376px，<table> 宽 750px

列的可见性（相对 .table-wrap 的视口）：
  CC 账号表：备注名 ✓ | keyId/keyPrefix ✓ | 额度 ✗ | 状态 ✗ | 操作 ✗
  API key 表：名称 ✓ | keyId ✓ | keyPrefix ✓ | 创建时间 ✓ | 操作 ✗
  管理员表：用户名 ✓ | 创建时间 ✓ | 操作 ✗(414px 时 ✓)
```

**后果**：手机上要横向拖拽才能看到并点击「删除 / 停用 / 改备注 / 测试连通性」按钮，
而且没有任何提示表明可以横拖。这是**功能性缺陷**，不只是不美观。

**表格为什么这么宽**：`.cell-quota { min-width: 220px }` + `td.actions { white-space: nowrap }`
+ 5 列 × 内容宽度。`.table-wrap { overflow-x: auto }` 只是让它能滚，没解决可达性。

### 🟡 问题 2：前台 KPI 在 320px 塌成一行一个

```
320px 视口 → .kpis 每个卡片宽 284px → 6 个卡片各占一行（6 行，非常长）
375px 视口 → 卡片宽 165px → 2 列 3 行（可接受）
414px 视口 → 卡片宽 184px → 2 列 3 行（可接受）
```
原因：`.kpis { grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)) }`，
320px 减掉 `--gutter` 16×2 = 288px 可用宽，`minmax(150px,1fr)` 理论上能放 1 列，
实际因 gap 10px 算出只能 1 列 → 6 行。

### 🟡 问题 3：前台工具栏在 320px 换行

```
320px → .tools 高 80px（换行 2 行）；.search-box 宽 240px、.admin-link 宽 276px 各自占一行
375px → .tools 高 36px（一行）
```

---

## 修复要求

### 一、后台表格：手机上改成「卡片式列表」（最高优先级）

**目标**：手机上不横拖，所有信息 + 操作按钮都能直接看到和点击。

**方案**：在 `@media (max-width: 820px)` 断点内，把表格从「表格布局」改为「每行一张卡片」：

```css
@media (max-width: 820px) {
  /* 表格转卡片：隐藏表头，每个 <tr> 变成一张卡 */
  thead { display: none; }
  table, tbody, tr, td { display: block; width: 100%; }
  tr {
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 12px 14px;
    margin-bottom: 10px;
    background: var(--surface-1);
  }
  td { border: 0; height: auto; padding: 0; }
  /* 每个单元格：左侧小标签 + 右侧内容 */
  td::before {
    content: attr(data-label);       /* ← 需要给每个 td 加 data-label 属性 */
    display: block;
    font-size: var(--fs-xs);
    color: var(--text-secondary);
    margin-bottom: 2px;
  }
  td + td { margin-top: 10px; }
  /* 操作列：按钮横排、右对齐、可换行 */
  td.actions { white-space: normal; text-align: left; margin-top: 12px;
               display: flex; flex-wrap: wrap; gap: 6px; }
  td.actions::before { display: none; }   /* 操作列不用标签 */
  td.actions .btn { height: 34px; margin-left: 0; }   /* 触控目标 ≥34px */
  .cell-quota { min-width: 0; }           /* 关键：解除 220px 最小宽度 */
}
```

**必须同步改 HTML**：给每个 `<td>` 加 `data-label="列名"`（表格是靠 JS 渲染的，
找到生成 `<td>` 的模板字符串，把列名写进 data-label）。
- CC 账号表：`备注名 / keyId / 额度 / 状态 / 操作`
- API key 表：`名称 / keyId / keyPrefix / 创建时间 / 操作`
- 管理员表：`用户名 / 创建时间 / 操作`

**验收标准**：
- 375px 下 `table` 的 `scrollWidth <= tableWrap.clientWidth`（不再横滚）
- 「删除」按钮在 375px 下 `getBoundingClientRect().right <= 375`
- 按钮高度 ≥ 34px（手指可点）

### 二、前台 KPI：窄屏固定 2 列

```css
@media (max-width: 640px) {
  .kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); }  /* 固定 2 列，不塌成 1 列 */
}
```
**验收**：320px 下 KPI 是 **3 行 × 2 列**（不是 6 行 × 1 列）。

### 三、前台工具栏：320px 不换行或优雅换行

**目标**：`--gutter` 在 375px 已降到 16px；320px 下：
- 让 `.search-box` 可以收缩（`min-width: 0; flex: 1 1 auto`）
- 主题按钮保持 36px 不变
- 「登录后台」按钮在 320px 时**只显示图标**（隐藏文字），或整体允许换行但
  换行后按钮仍占满宽度、高度 ≥36px，不要出现 80px 高的杂乱两行

**验收**：320px 下 `.tools` 高度 ≤ 40px（一行），或换行后布局整齐、无元素被压扁。

### 四、顺带检查（低优先级，若时间允许）

- 触控目标：所有按钮在手机断点下高度 ≥ 34px（现在表格里的按钮 28px 偏小）
- 后台「已登录 admin / 退出登录」区域在 375px 下是否换行合理
- 长文本（内核 URL `http://core:3050`、keyId）确保 `word-break` 合理，不撑破容器

---

## 硬约束

1. **103 个测试必须全绿**（`npm test`）。测试里有断言检查前台 HTML 结构
   （如 `/apiFetch('\/api\/status')/`、`href="/admin"`、不含 `id="key"` 等），
   修改 HTML 时别破坏这些。若某条断言确实必须改，**先停下来在回复里说明**。
2. **零外部依赖**、单文件 HTML（内联 style/script）、图标用内联 SVG
3. **不改后端**（`gateway.mjs` / `src/*`）—— 纯前端布局任务
4. 亮/暗双主题、`prefers-reduced-motion` 都要正常
5. 用 Docker 重建验证：`docker compose build gateway && docker compose up -d --force-recreate gateway`
6. **不要安装任何 npm 包**（上次装了 playwright，不允许），
   **不要用 playwright/chromium 截图** —— 需要验证就用 `curl` + `node` 脚本量 DOM
7. `git commit`（中文提交信息）

## 验证要求（请自己实测并把证据写进回复）

用 node 起一个静态服务器或直接用现成的 `npm test` harness，在 320/375/414px 下量：

```
① 后台三张表的 scrollWidth vs tableWrap.clientWidth（应不再横滚）
② 「删除」按钮的 right 边界（应 ≤ 视口宽）
③ 前台 KPI 在 320px 的列数（应为 2）
④ 前台 .tools 在 320px 的高度（应 ≤ 40px）
```
