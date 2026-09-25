// 批次 24f：smoke.sh「读到上一轮残留 body」自伤的回归守护。
//
// 背景：scripts/smoke.sh 曾让 http_code 把响应体写进**共享的** $WORK/body，于是
// 「这一句刚取回 /js/state.js 的文本 → 下一句在同一个文件里 grep 首页 HTML 的
// /assets/*.css」必然失败。CI 连着红两次都被误判成「镜像里没有静态资源」，实际是
// 脚本自己读错了文件。
//
// 这里用**静态解析**钉死这类写法：把脚本按 `echo "==> <标题>"` 切成「检查块」，
// 要求块内每个被读取的 *.body 文件，都必须在这个块里**先被 fetch 过**
// （fetch_into "<file>"）。跨检查复用残留文件 ⇒ 变红；脚本里存在可隐式复用的
// 共享 body 变量（$WORK/body）⇒ 变红。
//
// 为什么不会误报 / 不会空跑报绿：
//   1) 规则只针对 `.body` 结尾的响应体文件，且只在同一个 `==> ` 块内要求「先取后读」；
//      同一个文件在块内被读多次没问题（取一次、读多次是正常的）。
//   2) 解析依赖两个脚本自身的稳定约定：检查块以 `echo "==> ` 开头、取 body 必须走
//      `fetch_into "<file>"`。两者都在下面的下界断言里兜底：解析出的块数 / body 文件数
//      少于阈值、或关键文件缺失，测试直接失败 —— 解析失灵绝不会静默变绿。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const SMOKE_REL = 'scripts/smoke.sh';
const SMOKE_SRC = read(SMOKE_REL);

// 检查块的开头：脚本每个检查前都打印 `==> <标题>`（有分支的构建段也是这个形态）。
const BLOCK_START_RE = /^\s*echo\s+"==>/;
// 「取 body」的写法：fetch_into "<file>"（http_code 只接受显式输出文件，同样是写）。
const WRITE_RE = /\b(?:fetch_into|http_code)\s+"(\$WORK\/(?:body|[A-Za-z0-9_.-]+\.body))"/g;
// 响应体文件：只认 *.body，避免把 config/、data/ 这些目录也卷进来。
const BODY_FILE_RE = /\$WORK\/(?:body|[A-Za-z0-9_.-]+\.body)\b/g;
// 裸的共享 body（B24f 前的写法）：$WORK/body，后面不能再跟文件名字符。
const SHARED_BODY_RE = /\$WORK\/body(?![A-Za-z0-9_.-])/g;

const isComment = (line) => /^\s*#/.test(line);

/**
 * 解析一份 smoke.sh 源码：
 *  - violations：块内「读了本块没取过的 *.body」的位置（= 复用残留文件的 bug）。
 *  - sharedBody：非注释代码里出现的裸 $WORK/body（= 隐式共享变量还在）。
 *  - blocks / bodyFiles：给下界断言用的解析结果。
 */
export function analyzeSmoke(src) {
  const violations = [];
  const sharedBody = [];
  const blocks = [];
  const bodyFiles = new Set();
  let block = null;
  src.split('\n').forEach((text, idx) => {
    const line = idx + 1;
    if (!isComment(text)) {
      for (const _ of text.matchAll(SHARED_BODY_RE)) sharedBody.push({ line, text: text.trim() });
    }
    if (BLOCK_START_RE.test(text)) {
      block = { title: text.trim(), start: line, fetched: new Set(), lines: [] };
      blocks.push(block);
      return;
    }
    if (!block) return;
    block.lines.push({ line, text });
    const written = new Set([...text.matchAll(WRITE_RE)].map((m) => m[1]));
    if (isComment(text)) return;
    for (const file of text.match(BODY_FILE_RE) ?? []) {
      bodyFiles.add(file);
      if (written.has(file)) continue;
      // 写出现在这一行、读出现在同一行是允许的；只有「没写过就读」才是 bug。
      if (!block.fetched.has(file)) {
        violations.push({ line, file, title: block.title, text: text.trim() });
      }
    }
    for (const f of written) block.fetched.add(f);
  });
  return { violations, sharedBody, blocks, bodyFiles };
}

const parsed = analyzeSmoke(SMOKE_SRC);

// ── 1：解析下界（解析失灵必须报红，而不是「零违规」的空绿）──────────────
test('B24f-1：smoke.sh 可被解析出足够多的检查块与 body 文件', () => {
  assert.ok(parsed.blocks.length >= 10, `检查块数应 >= 10，实际 ${parsed.blocks.length}（解析边界可能失效）`);
  assert.ok(parsed.bodyFiles.size >= 6, `body 文件数应 >= 6，实际 ${parsed.bodyFiles.size}`);
  for (const f of ['$WORK/health.body', '$WORK/ready.body', '$WORK/index.body',
    '$WORK/state.body', '$WORK/home-css.body', '$WORK/css.body', '$WORK/v1.body']) {
    assert.ok(parsed.bodyFiles.has(f), `应存在 ${f}（检查被删/改名了？）`);
  }
});

// ── 2：不存在隐式共享的 body 变量 ────────────────────────────────────
test('B24f-2：smoke.sh 的非注释代码里没有裸 $WORK/body', () => {
  assert.deepEqual(parsed.sharedBody, [],
    `共享 body 变量会让后面的检查读到上一轮残留：\n${parsed.sharedBody.map((v) => `${v.line}: ${v.text}`).join('\n')}`);
});

// ── 3：每个 *.body 都在自己的检查块里先取后读 ─────────────────────────
test('B24f-3：每个 body 文件在同一检查块内先 fetch 后读取', () => {
  assert.deepEqual(parsed.violations, [],
    `发现「读了本块没取过的 body」= 复用残留文件：\n${parsed.violations.map((v) => `${v.line} (${v.title}): ${v.text}`).join('\n')}`);
});

// ── 4：CSS 路径必须从「刚取到的首页 HTML」提取，且提取前断言是 HTML ──────
test('B24f-4：提取 /assets/*.css 前，同一块内先取首页并断言是 HTML', () => {
  const block = parsed.blocks.find((b) => b.title.includes('/assets/*.css'));
  assert.ok(block, '应存在「GET /js/state.js 与首页外链 /assets/*.css」检查块');
  const grepLine = block.lines.find((l) => /grep\s+-o\s+'\/assets\//.test(l.text) && !isComment(l.text));
  assert.ok(grepLine, '该块应从 HTML 里 grep /assets/*.css');
  const file = grepLine.text.match(BODY_FILE_RE)?.[0];
  assert.ok(file, 'grep 的目标应是某个 *.body 文件');
  assert.ok(block.fetched.has(file), `grep 的 ${file} 必须先在本块内 fetch_into（不能跨检查复用）`);
  const guard = block.lines.find((l) => l.text.includes('assert_html') && l.text.includes(file) && !isComment(l.text));
  assert.ok(guard, `grep 之前应先对 ${file} 调 assert_html（读错文件时要直说「期望 HTML」）`);
  assert.ok(guard.line < grepLine.line, 'assert_html 必须排在 grep 之前');
});

// ── 5：HTTP 段里的每条 fail 都带文件路径 / 字节数 / 开头片段 ─────────────
test('B24f-5：HTTP 断言段的 fail 信息都带 body_info（路径 + 字节数 + 开头）', () => {
  const section = SMOKE_SRC.slice(SMOKE_SRC.indexOf('# ── 7：HTTP 断言'));
  assert.ok(section.length > 0, '应能定位到「7：HTTP 断言」段（边界丢失即失败）');
  const fails = section.split('\n').filter((l) => /\bfail\s+"/.test(l) && !isComment(l));
  assert.ok(fails.length >= 8, `该段应有 >= 8 条 fail，实际 ${fails.length}`);
  for (const line of fails) {
    assert.match(line, /body_info/, `fail 信息里要带所检查文件的路径/字节数/开头片段：${line.trim()}`);
  }
});

// ── 6：变异验证（把 bug 改回去，分析器必须变红）────────────────────────
// 变异 A：跨检查复用（正是本次的真 bug：拿 state.js 的 body 去当首页 HTML）。
export const MUTATION_CROSS_BLOCK = [
  'echo "==> GET /（面板骨架）"',
  'code="$(fetch_into "$WORK/index.body" "$BASE/")"',
  'grep -q "cc-manage" "$WORK/index.body" || fail "缺少骨架标记"',
  'echo "==> GET /js/state.js 与首页外链 /assets/*.css"',
  'code="$(fetch_into "$WORK/state.body" "$BASE/js/state.js")"',
  `css_path="$(grep -o '/assets/[^"]*\\.css' "$WORK/index.body" | head -n 1 || true)"`,
  '',
].join('\n');

// 变异 B：把共享 body 变量加回来（http_code 隐式写 $WORK/body）。
const MUTATION_SHARED_BODY = [
  'echo "==> GET /health（liveness）"',
  'code="$(http_code "$BASE/health")"',
  'assert_json "$WORK/body" "/health"',
  '',
].join('\n');

test('B24f-6：把「跨检查复用残留 body」改回去，分析器必须报红', () => {
  const r = analyzeSmoke(MUTATION_CROSS_BLOCK);
  assert.ok(r.violations.some((v) => v.file === '$WORK/index.body'),
    '变异后必须报出「读了本块没取过的 $WORK/index.body」');
});

test('B24f-7：把隐式共享 body 变量加回来，分析器必须报红', () => {
  const r = analyzeSmoke(MUTATION_SHARED_BODY);
  assert.ok(r.sharedBody.length > 0, '变异后必须报出裸 $WORK/body');
  assert.ok(r.violations.length > 0, '依赖共享 body 的读取也必须算违规');
});

test('B24f-8：修好的写法（同块先取后读、可重复读）不误报', () => {
  const ok = [
    'echo "==> POST /v1"',
    'code="$(fetch_into "$WORK/v1.body" -X POST "$BASE/v1/chat/completions")"',
    'assert_json "$WORK/v1.body" "/v1"',
    'grep -q "choices" "$WORK/v1.body" || fail "不像补全"',
    '',
  ].join('\n');
  const r = analyzeSmoke(ok);
  assert.deepEqual(r.violations, [], '取一次读多次是正常写法，不得误报');
  assert.deepEqual(r.sharedBody, [], '不得误报共享 body');
});
