// B15：堵住测试临时目录泄漏 —— 登记表 / 进程退出兜底清理的行为与源码约束。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeTmpDir, cleanupTestResources, sweepTmpDirs } from './helpers.mjs';

const HELPERS_SRC = fs.readFileSync(new URL('./helpers.mjs', import.meta.url), 'utf8');

test('B15-1：makeTmpDir() 建的目录在磁盘上真实存在', () => {
  const dir = makeTmpDir();
  assert.ok(dir.startsWith(os.tmpdir()), '临时目录应落在 os.tmpdir() 下');
  assert.ok(fs.existsSync(dir), 'makeTmpDir() 返回后目录必须已经在磁盘上');
});

test('B15-2：sweepTmpDirs() 删掉登记的目录，且幂等（连调两次不抛）', () => {
  const a = makeTmpDir();
  const b = makeTmpDir();
  fs.writeFileSync(path.join(a, 'a.txt'), 'a');
  fs.writeFileSync(path.join(b, 'b.txt'), 'b');
  assert.ok(fs.existsSync(a) && fs.existsSync(b), '前提：两个目录都建好了');

  sweepTmpDirs();
  assert.ok(!fs.existsSync(a), 'sweep 后目录 a 必须消失');
  assert.ok(!fs.existsSync(b), 'sweep 后目录 b 必须消失');
  assert.doesNotThrow(() => sweepTmpDirs(), '第二次 sweep 必须幂等、不抛');
});

test('B15-3：cleanupTestResources({ dir }) 删目录；随后 sweep 不因残留登记项而抛', async () => {
  const dir = makeTmpDir();
  await cleanupTestResources({ dir });
  assert.ok(!fs.existsSync(dir), 'cleanupTestResources 默认必须删掉目录');
  assert.doesNotThrow(() => sweepTmpDirs(), '登记表里留着已删目录时 sweep 也必须幂等、不抛');
});

test('B15-4：keepDir 注销登记项，兜底 sweep 不误删调用方目录', async () => {
  const dir = makeTmpDir();
  fs.writeFileSync(path.join(dir, 'keep.txt'), 'x');
  try {
    await cleanupTestResources({ dir, keepDir: true });
    assert.ok(fs.existsSync(dir), 'keepDir 后目录必须仍然存在');
    sweepTmpDirs();
    assert.ok(fs.existsSync(dir), 'keepDir 已注销登记项，退出兜底不得删它');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("B15-5：helpers.mjs 用守卫标志保证 process.on('exit') 只注册一次（源码断言）", () => {
  assert.match(HELPERS_SRC, /if\s*\(\s*![a-zA-Z]*[Ss]weepRegistered\s*\)/,
    '必须有 sweepRegistered 守卫，避免同一进程里重复注册 exit 监听');
  assert.match(HELPERS_SRC, /process\.on\(\s*['"]exit['"]\s*,/,
    "必须注册 process.on('exit', ...) 兜底清理");
});

test('B15-6：makeTmpDir() 把新建目录登记进兜底表（源码断言 .add(）', () => {
  const m = /export function makeTmpDir\(\)\s*\{([\s\S]*?)\n\}/.exec(HELPERS_SRC);
  assert.ok(m, 'helpers.mjs 必须导出 makeTmpDir()');
  assert.match(m[1], /\.add\(/, 'makeTmpDir() 函数体必须把新建目录 .add( 进登记表');
});
