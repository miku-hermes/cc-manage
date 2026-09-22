// 批次3：运维/部署基建的行为回归（M3 run-from-ghcr.sh 参数、L2 测试基建健壮性）。
// 不跑 docker、不连网。需要 spawn 子进程的断言在禁止 spawn 的沙箱里显式 skip，
// 但同一条问题始终有一条不需要 spawn 的静态断言兜底（见文件顶部说明）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  cleanupTestResources,
  makeTmpDir,
  retryOnPortConflict,
  startTestGateway,
} from './helpers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts/run-from-ghcr.sh');
const SCRIPT_TEXT = fs.readFileSync(SCRIPT, 'utf8');

/** 环境是否允许 spawn 子进程（受限沙箱会 EPERM）：不允许时相关断言 skip 而不是假红。 */
function canSpawn(cmd, args) {
  try {
    return spawnSync(cmd, args ?? ['-c', 'exit 0'], { encoding: 'utf8' }).error == null;
  } catch {
    return false;
  }
}
const CAN_SPAWN_BASH = canSpawn('bash', ['-c', 'exit 0']);
const CAN_SPAWN_NODE = canSpawn(process.execPath, ['-e', '']);

/** source 脚本里的参数构造函数，把数组逐项打印出来（每行一项，保持参数边界）。 */
function runArgs(fn, arrayName, { env = {} } = {}) {
  const shell = `set -euo pipefail
source ${JSON.stringify(SCRIPT)}
${fn}
for a in "\${${arrayName}[@]}"; do printf '%s\\n' "$a"; done`;
  const out = execFileSync('bash', ['-c', shell], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ...env } });
  return out.split('\n').filter((l) => l !== '');
}

/** 断言 args 里存在 `--flag value` 这样一对相邻参数。 */
function hasPair(args, flag, value) {
  return args.some((a, i) => a === flag && args[i + 1] === value);
}

// ── M3：run-from-ghcr.sh 的 docker run 必须带全套权限/日志收紧项 ────────
// 静态断言（始终跑）：参数必须写在 args 数组里、且数组真的被 docker run 用上。
test('M3：run-from-ghcr.sh 的 docker run 参数含 user/cap-drop/security-opt/read-only/tmpfs/log-opt', () => {
  for (const flag of ['--user 1000:1000', '--cap-drop ALL', '--security-opt no-new-privileges:true',
    '--read-only', '--tmpfs /tmp', '--log-opt max-size=10m', '--log-opt max-file=3']) {
    assert.ok(SCRIPT_TEXT.includes(flag), `docker run 参数必须包含 \`${flag}\``);
  }
  // 挂 config：不挂的话容器重建后 /app/config 为空，匿名者可 POST /api/auth/setup 抢管理员
  assert.match(SCRIPT_TEXT, /-v "\$CONFIG_DIR:\/app\/config"/, '必须把 config 目录挂进 /app/config');
  assert.match(SCRIPT_TEXT, /chown 1000:1000/, 'data/config 目录必须 chown 给容器内的 uid 1000');
  // 定义完必须真的用上，否则加固是摆设
  assert.match(SCRIPT_TEXT, /docker run "\$\{CORE_RUN_ARGS\[@\]\}"/);
  assert.match(SCRIPT_TEXT, /docker run "\$\{GATEWAY_RUN_ARGS\[@\]\}"/);
});

test('M3：source 后按数组逐项断言 gateway 参数（含 -v config / -v data）', (t) => {
  if (!CAN_SPAWN_BASH) return t.skip('环境禁止 spawn 子进程（沙箱 seccomp EPERM）');
  const args = runArgs('fill_gateway_run_args', 'GATEWAY_RUN_ARGS');

  assert.ok(hasPair(args, '--user', '1000:1000'), '必须 --user 1000:1000（vendor 镜像没有 USER，不指定就是 root）');
  assert.ok(hasPair(args, '--cap-drop', 'ALL'), '必须 --cap-drop ALL');
  assert.ok(hasPair(args, '--security-opt', 'no-new-privileges:true'), '必须 no-new-privileges');
  assert.ok(args.includes('--read-only'), '必须 --read-only');
  assert.ok(hasPair(args, '--tmpfs', '/tmp'), '--read-only 下必须给可写 /tmp');
  assert.ok(hasPair(args, '--log-opt', 'max-size=10m') && hasPair(args, '--log-opt', 'max-file=3'),
    '必须配 json-file 日志轮转（max-size + max-file）');
  assert.ok(args.some((a, i) => a === '-v' && /\/config:\/app\/config$/.test(args[i + 1] ?? '')),
    `必须 -v <pwd>/config:/app/config，实际：${args.filter((a) => a.includes(':/app/')).join(' ')}`);
  assert.ok(args.some((a, i) => a === '-v' && /\/data:\/app\/data$/.test(args[i + 1] ?? '')),
    '必须挂 data 目录（store 落盘）');
});

test('M3：source 后按数组逐项断言 core 参数（同样收紧）', (t) => {
  if (!CAN_SPAWN_BASH) return t.skip('环境禁止 spawn 子进程（沙箱 seccomp EPERM）');
  const args = runArgs('fill_core_run_args', 'CORE_RUN_ARGS');
  assert.ok(hasPair(args, '--user', '1000:1000'), 'core 必须 --user 1000:1000');
  assert.ok(hasPair(args, '--cap-drop', 'ALL'));
  assert.ok(hasPair(args, '--security-opt', 'no-new-privileges:true'));
  assert.ok(args.includes('--read-only'));
  assert.ok(hasPair(args, '--tmpfs', '/tmp'));
  assert.ok(hasPair(args, '--log-opt', 'max-size=10m'));
});

test('M3：CONFIG_DIR / DATA_DIR 可覆盖（source 后生效）', (t) => {
  if (!CAN_SPAWN_BASH) return t.skip('环境禁止 spawn 子进程（沙箱 seccomp EPERM）');
  const args = runArgs('fill_gateway_run_args', 'GATEWAY_RUN_ARGS', {
    env: { CONFIG_DIR: '/srv/cc-config', DATA_DIR: '/srv/cc-data' },
  });
  assert.ok(args.includes('/srv/cc-config:/app/config'));
  assert.ok(args.includes('/srv/cc-data:/app/data'));
});

test('M3：ensure_container_owner 会建目录，chown 失败时警告并继续（不中断启动）', (t) => {
  if (!CAN_SPAWN_BASH) return t.skip('环境禁止 spawn 子进程（沙箱 seccomp EPERM）');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-batch3-chown-'));
  const target = path.join(base, 'config');
  const shell = `set -euo pipefail
source ${JSON.stringify(SCRIPT)}
ensure_container_owner ${JSON.stringify(target)} "单测"
echo "still-running"`;
  const res = spawnSync('bash', ['-c', shell], { encoding: 'utf8', cwd: ROOT });
  assert.equal(res.status, 0, `chown 失败不该中断脚本，stderr=${res.stderr}`);
  assert.ok(fs.existsSync(target), '目录必须被创建');
  assert.match(res.stdout, /still-running/, 'chown 失败后仍要继续执行');
  fs.rmSync(base, { recursive: true, force: true });
});

// ── L2：allocPort 竞态重试 ────────────────────────────────────────────
test('L2：retryOnPortConflict 对 EADDRINUSE 重试，第 3 次成功', async () => {
  let calls = 0;
  const port = await retryOnPortConflict(async () => {
    calls += 1;
    if (calls < 3) { const e = new Error('address in use'); e.code = 'EADDRINUSE'; throw e; }
    return 41234;
  }, 3);
  assert.equal(port, 41234);
  assert.equal(calls, 3, '必须真的重试到成功为止');
});

test('L2：retryOnPortConflict 不重试其它错误，且重试用尽后抛最后一个错误', async () => {
  let calls = 0;
  await assert.rejects(retryOnPortConflict(async () => {
    calls += 1;
    const e = new Error('not permitted'); e.code = 'EPERM'; throw e;
  }, 3), /not permitted/);
  assert.equal(calls, 1, '非端口冲突不该浪费重试');

  let attempts = 0;
  await assert.rejects(retryOnPortConflict(async () => {
    attempts += 1;
    const e = new Error(`busy ${attempts}`); e.code = 'EADDRINUSE'; throw e;
  }, 3), /busy 3/);
  assert.equal(attempts, 3, '重试上限必须是 3 次');
});

// ── L2：启动失败的回收 ───────────────────────────────────────────────
test('L2：startTestGateway 启动失败时关掉 mock server 且不留临时目录', async () => {
  const marker = 'user_batch3_marker';
  let mockClosed = false;
  const fakeUpstream = { url: 'http://127.0.0.1:1', close: async () => { mockClosed = true; } };
  const tmpPrefix = 'cc-manage-test-';
  const before = new Set(fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith(tmpPrefix)));

  await assert.rejects(startTestGateway({
    accounts: [{ name: '标记账号', key: marker, enabled: true }],
    keys: [{ name: '标记客户端', key: 'sk-cg-marker' }],
    deps: {
      startUpstream: async () => fakeUpstream,
      startGateway: async () => { throw new Error('模拟起网关失败'); },
      allocPort: async () => 41235,
    },
  }), /模拟起网关失败/);

  assert.equal(mockClosed, true, '失败路径必须 close() mock server，否则 node --test 子进程挂着不退出');
  const leaked = fs.readdirSync(os.tmpdir())
    .filter((d) => d.startsWith(tmpPrefix) && !before.has(d))
    .filter((d) => {
      try { return fs.readFileSync(path.join(os.tmpdir(), d, 'accounts.json'), 'utf8').includes(marker); } catch { return false; }
    });
  assert.deepEqual(leaked, [], `失败路径必须删掉自己建的临时目录，泄漏：${leaked.join(',')}`);
});

test('L2：cleanupTestResources 忽略关闭异常，keepDir 时不删调用方给的目录', async () => {
  const dir = makeTmpDir();
  fs.writeFileSync(path.join(dir, 'keep.txt'), 'x');
  await cleanupTestResources({
    gateway: { stop: async () => { throw new Error('stop 失败'); } },
    upstream: { close: async () => { throw new Error('close 失败'); } },
    dir,
    keepDir: true,
  });
  assert.ok(fs.existsSync(dir), '调用方给的目录不该被删');
  await cleanupTestResources({ dir });
  assert.ok(!fs.existsSync(dir), '默认要删掉自己建的目录');
});

// ── L2：挂起保护 ─────────────────────────────────────────────────────
test('L2：泄漏 handle 的测试进程会被 hang guard 强制退出并说明原因', (t) => {
  if (!CAN_SPAWN_NODE) return t.skip('环境禁止 spawn 子进程（沙箱 seccomp EPERM）');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-batch3-hang-'));
  const fixture = path.join(dir, 'leak.test.mjs');
  // 直接跑这个文件（不套一层 node --test —— 父进程会把子进程 stderr 吞掉）。
  fs.writeFileSync(fixture, `
import { test } from 'node:test';
import ${JSON.stringify(pathToFileURL(path.join(ROOT, 'test/helpers.mjs')).href)};
test('故意泄漏一个 handle', () => { setInterval(() => {}, 1000); });
`);
  const res = spawnSync(process.execPath, [fixture], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 10000,
    env: { ...process.env, CC_TEST_HANG_GUARD_MS: '300' },
  });
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(res.error, undefined, '没有 hang guard 时子进程会永远挂着（只能等到 spawn 超时）');
  assert.equal(res.status, 1, '有未关闭的 handle 时必须失败退出（exit 1），而不是假绿');
  assert.match(res.stderr ?? '', /疑似有 server\/socket 未关闭/, `必须打印挂起原因，实际 stderr=${res.stderr}`);
});
