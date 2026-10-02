// 后台「审计日志」页（第 2/2 轮 · 前端）：静态壳结构 + 路由表 + 渲染脚本安全性的纯逻辑断言。
//
// 只读构建产物 public/admin.html 与前端源码；不启动浏览器、不连网关、不断言任何 JSON 响应体
// （与同目录 admin-console / admin-overview 一致，避免「时间戳恰好命中」的历史 flake）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const ADMIN_HTML = fs.readFileSync(new URL('../public/admin.html', import.meta.url), 'utf8');
const CONSOLE_SRC = fs.readFileSync(new URL('../panel/public/js/admin-console.js', import.meta.url), 'utf8');
const AUDIT_SRC = fs.readFileSync(new URL('../panel/public/js/admin-audit.js', import.meta.url), 'utf8');

/** 截取某个页面容器（从 id 出现处到下一个 .admin-page 容器之前）。 */
function sectionOf(pageId) {
  const from = ADMIN_HTML.indexOf('id="' + pageId + '"');
  assert.ok(from > -1, '缺少页面容器 ' + pageId);
  const next = ADMIN_HTML.indexOf('<section class="admin-page', from);
  return ADMIN_HTML.slice(from, next > -1 ? next : undefined);
}

/** 解析 ADMIN_ROUTES 的项（字符串字面量）。 */
function adminRoutes() {
  const m = CONSOLE_SRC.match(/const ADMIN_ROUTES = \[([^\]]*)\]/);
  assert.ok(m, 'admin-console.js 必须定义 ADMIN_ROUTES');
  return (m[1].match(/'[a-z]+'/g) ?? []).map((s) => s.slice(1, -1));
}

// ── 1：审计页静态结构 ─────────────────────────────────────────────────
test('审计页#1：admin.html 有 #page-audit 容器 / 导航项 / 6 列表头 / 空态 / 降级提示初始隐藏', () => {
  const audit = sectionOf('page-audit');

  assert.match(ADMIN_HTML, /href="#\/audit" data-nav="audit"/, '侧边栏必须有 #/audit 导航项');

  const heads = [...audit.matchAll(/<th>([^<]*)<\/th>/g)].map((m) => m[1]);
  assert.deepEqual(heads, ['时间', '操作者', '操作', '对象', '详情', 'IP'], `审计表头应为 6 列，实得 ${heads.join('/')}`);

  assert.match(audit, /id="audit-body"/, '表体容器必须是 #audit-body');
  assert.match(audit, /<tbody id="audit-body">[\s\S]*?暂无审计记录[\s\S]*?<\/tbody>/,
    '空态「暂无审计记录」必须写在 tbody 里（发请求之前就有，不是空白）');

  const degradedTags = audit.match(/<div[^>]*id="audit-degraded"[^>]*>/g) ?? [];
  assert.equal(degradedTags.length, 1, '必须有且只有一个 id="audit-degraded" 的降级提示元素');
  assert.ok(/\bhidden\b/.test(degradedTags[0]), '降级提示初始必须带 hidden，正常态不可见');

  assert.match(ADMIN_HTML, /<template id="tpl-audit-row">/, '缺少行模板 tpl-audit-row');
});

// ── 2：路由表 ─────────────────────────────────────────────────────────
test('审计页#2：ADMIN_ROUTES 含 audit（在 events 前）且默认路由仍是 overview', () => {
  const routes = adminRoutes();
  assert.ok(routes.includes('audit'), 'ADMIN_ROUTES 必须含 audit');
  assert.ok(routes.indexOf('audit') < routes.indexOf('events'), 'audit 应排在 events 之前');
  assert.match(CONSOLE_SRC, /const ADMIN_DEFAULT_ROUTE = 'overview';/, '默认路由必须仍是 overview');
});

// ── 3：渲染脚本不得手拼未转义的 innerHTML ──────────────────────────────
test('审计页#3：admin-audit.js 非空且不出现 innerHTML 赋值（动态文本走 textContent）', () => {
  assert.ok(AUDIT_SRC.length > 0, 'admin-audit.js 不能为空');

  const unescapedInnerHtml = /\.innerHTML\s*=/;
  // 负例自检：这个检测式必须真的能抓到未转义拼接，否则下面那条就是「永远绿」的假断言。
  assert.equal(unescapedInnerHtml.test("el.innerHTML = '<b>' + name + '</b>'"), true,
    '检测式必须能识别未转义的 innerHTML 拼接');
  assert.ok(!unescapedInnerHtml.test(AUDIT_SRC),
    'admin-audit.js 不得出现 innerHTML 赋值（来自服务端的 actor/target/detail 一律 textContent）');
});

// ── 4：侧边栏项数与路由表项数一一对应 ──────────────────────────────────
test('审计页#4：侧边栏 #admin-nav 项数 == ADMIN_ROUTES 项数', () => {
  const navStart = ADMIN_HTML.indexOf('id="admin-nav"');
  assert.ok(navStart > -1, '缺少 #admin-nav 容器');
  const navEnd = ADMIN_HTML.indexOf('</ul>', navStart);
  const nav = ADMIN_HTML.slice(navStart, navEnd > -1 ? navEnd : undefined);
  const navCount = (nav.match(/data-nav="/g) ?? []).length;
  const routeCount = adminRoutes().length;
  assert.ok(navCount > 0 && routeCount > 0, `两侧都不能为空（nav=${navCount}, routes=${routeCount}）`);
  assert.equal(navCount, routeCount, `侧边栏项数(${navCount}) 必须等于 ADMIN_ROUTES 项数(${routeCount})，加页别漏改一侧`);
});
