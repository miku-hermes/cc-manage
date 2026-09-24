#!/usr/bin/env node
// 零依赖 lint：只用 node: 内置模块（child_process / fs / path / url）。
// 四类检查：
//   1. 语法        —— node --check <file>，非 0 退出即失败（抓没被测试 import 的文件里的语法错误）。
//   2. debugger    —— 源码里不得出现 debugger 语句。
//   3. .only(      —— 测试文件里不得出现 .only( 调用（会静默跳过其余用例）。
//   4. console.log(—— src/ 与 gateway.mjs 必须走 createLogger，不得直接 console.log。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXCLUDE_DIRS = new Set(['vendor', 'node_modules', '.git', 'data', 'config']);
const EXTENSIONS = ['.mjs', '.js'];

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name), out);
    } else if (entry.isFile() && EXTENSIONS.includes(path.extname(entry.name))) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

const files = walk(ROOT, []).sort();
const violations = [];

function rel(abs) {
  return path.relative(ROOT, abs).split(path.sep).join('/');
}

// 整行注释（// 或块注释续行 *）跳过：只用于 .only / console.log 这类文本检查，避免误判文案。
function isCommentLine(line) {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

for (const abs of files) {
  const name = rel(abs);
  const text = fs.readFileSync(abs, 'utf8');
  const lines = text.split(/\r?\n/);

  // 1) 语法
  const check = spawnSync(process.execPath, ['--check', abs], { encoding: 'utf8' });
  if (check.status !== 0) {
    const detail = (check.stderr || '').match(/^\s*\w*Error:.*$/m)?.[0].trim()
      ?? (check.stderr || '').trim().split(/\r?\n/).filter(Boolean).pop()
      ?? 'syntax error';
    violations.push({ file: name, line: 1, message: `语法错误：${detail}` });
    continue; // 语法都过不了，后续文本检查没有意义
  }

  const isTest = name.startsWith('test/');
  const isSrcCore = name.startsWith('src/') || name === 'gateway.mjs';

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (isCommentLine(line)) continue;

    // 2) debugger：只认语句形态（行首/分号/花括号之后，且后随可选分号到行尾），
    //    避免把字符串/正则里出现的单词误判成语句。
    if (/(?:^|[;{}]\s*|\s)debugger\s*;?\s*$/.test(line)) {
      violations.push({ file: name, line: i + 1, message: '禁止 debugger 语句' });
    }
    // 3) .only(
    if (isTest && /\.only\(/.test(line)) {
      violations.push({ file: name, line: i + 1, message: '测试里禁止 .only( 调用' });
    }
    // 4) console.log(
    if (isSrcCore && /console\.log\(/.test(line)) {
      violations.push({ file: name, line: i + 1, message: 'src/ 与 gateway.mjs 禁止 console.log(，请走 createLogger' });
    }
  }
}

if (violations.length > 0) {
  for (const v of violations) console.error(`${v.file}:${v.line}  ${v.message}`);
  console.error(`lint 失败：${violations.length} 处问题（共检查 ${files.length} 个文件）`);
  process.exit(1);
}

console.log(`lint ok：检查 ${files.length} 个文件，0 处问题（语法 / debugger / .only / console.log）`);
