#!/usr/bin/env node
// 零依赖 lint：只用 node: 内置模块（child_process / fs / path / url）。
// 四类检查：
//   1. 语法        —— node --check <file>，非 0 退出即失败（抓没被测试 import 的文件里的语法错误）。
//                     B20：vendor/ 也纳入（部署出去的 core 内核同样是我们的产物，语法错了要在
//                     CI 里红，而不是等容器起不来）。
//   2. debugger    —— 源码里不得出现 debugger 语句。
//   3. .only(      —— 测试文件里不得出现 .only( 调用（会静默跳过其余用例）。B20：改为对
//                     整个文件文本用 /\b(?:test|it|describe)\s*\.only\s*\(/ 扫描，跨行/带空格
//                     的形态（test\n.only(、test.only (）也拦得住；逐行正则会漏掉这些。
//   4. console.log(—— src/、gateway.mjs 与 panel/public/js/** 必须走 createLogger / 页面自己的
//                     日志策略，不得直接 console.log（B20 补上面板脚本：它直接决定线上页面的
//                     控制台行为）。vendor/ 是别人的代码，跳过这一条。
//
// B20：walk() 还要有**下界断言** —— 目录改名 / 被整体排除时 walk 会「空跑却报绿」，
// 那种绿比红更危险（lint 形同虚设）。检查文件数低于 MIN_FILES 直接失败。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// vendor 不再整体排除：它的 .mjs/.js 也要过语法检查（见文件头第 1 条）。
// B22：面板源码整体迁进 panel/（自动纳入 walk）；但 panel/node_modules 与面板构建产物
// （panel/dist、Astro 生成的 panel/.astro 类型）不是源码，按目录名排除，避免 lint
// 去检查生成物 / 第三方依赖。
const EXCLUDE_DIRS = new Set(['node_modules', '.git', 'data', 'config', 'dist', '.astro']);
const EXTENSIONS = ['.mjs', '.js'];
// 检查文件数的下界：当前仓库 ~80 个（含 vendor 4 个）。目录改名/被排除时 walk() 会返回
// 远小于它的集合，这时必须失败而不是打印「lint ok」。
const MIN_FILES = 60;

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

if (files.length < MIN_FILES) {
  console.error(`lint 失败：只走到 ${files.length} 个待检查文件（下界 ${MIN_FILES}）——`
    + '目录结构变了或 EXCLUDE_DIRS/walk() 被改坏，lint 不能「空跑报绿」。');
  process.exit(1);
}

// 整行注释（// 或块注释续行 *）跳过：只用于 .only / console.log 这类文本检查，避免误判文案。
function isCommentLine(line) {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

// .only( 的整文件扫描（跨行也能命中）。命中后要定位到行做「整行注释跳过」，
// 否则一句「别写 test.only(」的注释会把 lint 自己判红。
const ONLY_RE = /\b(?:test|it|describe)\s*\.only\s*\(/g;

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
  const isPublicJs = name.startsWith('panel/public/js/');   // B20：面板脚本也在线上跑，同样不许留调试输出（B22 迁进 panel/）

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (isCommentLine(line)) continue;

    // 2) debugger：只认语句形态（行首/分号/花括号之后，且后随可选分号到行尾），
    //    避免把字符串/正则里出现的单词误判成语句。
    if (/(?:^|[;{}]\s*|\s)debugger\s*;?\s*$/.test(line)) {
      violations.push({ file: name, line: i + 1, message: '禁止 debugger 语句' });
    }
    // 4) console.log(
    if ((isSrcCore || isPublicJs) && /console\.log\(/.test(line)) {
      const where = isSrcCore ? 'src/ 与 gateway.mjs' : 'panel/public/js/ 面板脚本';
      violations.push({ file: name, line: i + 1, message: `${where}禁止 console.log(，请走 createLogger / 页面统一的日志策略` });
    }
  }

  // 3) .only(：整文件扫描（跨行/任意空白形态），命中行若是注释则跳过。
  if (isTest) {
    ONLY_RE.lastIndex = 0;
    let m;
    while ((m = ONLY_RE.exec(text))) {
      const lineNo = text.slice(0, m.index).split('\n').length;
      if (isCommentLine(lines[lineNo - 1] ?? '')) continue;
      violations.push({ file: name, line: lineNo, message: '测试里禁止 .only( 调用（会静默跳过其余用例）' });
    }
  }
}

if (violations.length > 0) {
  for (const v of violations) console.error(`${v.file}:${v.line}  ${v.message}`);
  console.error(`lint 失败：${violations.length} 处问题（共检查 ${files.length} 个文件）`);
  process.exit(1);
}

console.log(`lint ok：检查 ${files.length} 个文件（含 vendor 语法），0 处问题（语法 / debugger / .only / console.log）`);
