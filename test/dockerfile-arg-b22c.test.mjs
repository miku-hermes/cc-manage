// B22c：多阶段 Dockerfile 的 ARG 作用域防回归。
//
// 背景（实测）：Docker 的 ARG 只对「声明所在阶段」以及「该阶段之后的 FROM」生效；声明在
// 某个 FROM **之后**的 ARG 属于该阶段，**不能被任何 FROM 行使用**。B22 把单阶段改成
// 两阶段后，`ARG BASE_IMAGE` 被放在构建阶段（第一个 FROM）之后，于是运行阶段的
// `FROM ${BASE_IMAGE}` 取到空值 —— 构建直接失败：
//   WARN: InvalidDefaultArgInFrom ... / UndefinedArgInFrom
//   failed to solve: base name (${BASE_IMAGE}) should not be blank
// 单阶段时它恰好在唯一的 FROM 之前，所以一直没暴露。
//
// 本文件钉住结构规则：**每一个被 `FROM ${VAR}` 用到的 ARG，都必须在第一个 FROM 之前
// 声明且带默认值**（全局作用域）。这样以后无论加多少构建阶段，运行阶段的 FROM 都不会
// 再取到空变量。
// 变异验证：把 `ARG BASE_IMAGE=node:22-alpine` 挪回第二个 FROM 之前 → 本文件第 1 条变红。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/** 1-based 行号。 */
function fromLines(src) {
  const out = [];
  src.split('\n').forEach((line, i) => {
    if (/^\s*FROM\s/i.test(line)) out.push({ line: i + 1, text: line });
  });
  return out;
}

function testDockerfileArgScope(relPath) {
  const src = read(relPath);
  const lines = src.split('\n');

  const froms = fromLines(src);
  assert.ok(froms.length > 0, `${relPath} 必须有 FROM`);

  // 第一个 FROM 的行号（1-based）。全局 ARG 必须声明在它之前。
  const firstFromLine = froms[0].line;
  const preFrom = lines.slice(0, firstFromLine - 1).join('\n');

  // 收集所有 `FROM ${VAR}` / `FROM $VAR` 用到的变量名（含行号，便于报错定位）。
  const used = [];
  froms.forEach(({ line, text }) => {
    const m = text.match(/^\s*FROM\s+\$\{?(\w+)\}?/i);
    if (m) used.push({ name: m[1], line });
  });
  // 至少一个 FROM 用变量：否则断言会「空跑报绿」，比红了还危险。
  assert.ok(used.length > 0, `${relPath} 至少应有一个 FROM 使用变量（否则本断言形同虚设）`);

  for (const { name, line } of used) {
    // 必须存在 `ARG <name>=<非空默认值>`，且位于第一个 FROM 之前。
    const decl = preFrom.match(new RegExp(`^\\s*ARG\\s+${name}=(\\S+)`, 'm'));
    assert.ok(
      decl,
      `Dockerfile 结构错误：第 ${line} 行的 FROM 用到 \${${name}}，但 ${relPath} 在第一个 FROM`
      + `（第 ${firstFromLine} 行）之前没有 \`ARG ${name}=<default>\` 声明。`
      + ' ARG 必须在第一个 FROM 之前声明，否则多阶段下 FROM 取到空值（'
      + 'base name should not be blank），构建直接失败。',
    );
  }
}

test('B22c：被 FROM 使用的 ARG 必须声明在第一个 FROM 之前（多阶段下否则 FROM 取到空值）', () => {
  testDockerfileArgScope('Dockerfile');
});

test('B22c：运行阶段仍是可注入的 ${BASE_IMAGE}，构建阶段固定 node:22-slim', () => {
  const df = read('Dockerfile');
  const froms = fromLines(df).map((f) => f.text.trim());
  assert.ok(froms[0].includes('node:22-slim') && /AS\s+panel-build/i.test(froms[0]),
    `第一个 FROM 必须固定构建阶段 node:22-slim AS panel-build，实际：${froms[0]}`);
  assert.equal(froms[1], 'FROM ${BASE_IMAGE}',
    `运行阶段必须用 \${BASE_IMAGE}（可注入 digest），实际：${froms[1]}`);
  // 运行阶段仍是 alpine：注入 digest 的缺省就是 node:22-alpine（见上一行全局 ARG）。
  assert.match(df, /^ARG BASE_IMAGE=node:22-alpine$/m,
    'BASE_IMAGE 缺省必须仍是 node:22-alpine，保证本地直接可构建且运行阶段是 alpine');
});
