// F22 / F23 / F24 / F25：部署配置的回归测试（纯静态检查，不跑 docker）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const dockerignore = read('.dockerignore').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
const gitignore = read('.gitignore').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));

/**
 * 去掉 YAML 注释（整行 + 行内）后再做结构断言：注释里提到某个键不算配置。
 * 例如 gateway 块的注释里会解释 core-net，不剥掉就会把「注释提到」当成「配了」。
 */
function uncommented(text) {
  return text
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .map((l) => l.replace(/\s+#.*$/, ''))
    .join('\n');
}

/** 取 compose 里某个 service 的缩进块（到下一个顶层 key / 下一个 service 为止）。 */
function serviceBlock(text, name) {
  const src = uncommented(text);
  const m = src.match(new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  \\S|^\\S)`, 'm'));
  assert.ok(m, `compose 里找不到 service ${name}`);
  return m[1];
}

// ── F22：.dockerignore 必须覆盖所有真实凭据 ──────────────────────────
test('F22：.dockerignore 覆盖 config/ 与全部凭据文件名', () => {
  for (const pattern of ['config/', 'users.json', 'session-secret', 'accounts.json', 'keys.json', 'docker-compose*.yml']) {
    assert.ok(dockerignore.includes(pattern), `.dockerignore 必须包含 ${pattern}`);
  }
});

test('F22：编译产物里不含挂载目录之外的凭据（Dockerfile 不 COPY .）', () => {
  const dockerfile = read('Dockerfile');
  assert.doesNotMatch(dockerfile, /^\s*COPY\s+\.\s+\./m, 'Dockerfile 绝不能 COPY . .');
  for (const f of ['config/', 'test/', 'mocks/', '.git']) {
    assert.ok(!new RegExp(`^COPY\\s+${f.replace(/[.\\/]/g, (c) => `\\${c}`)}`, 'm').test(dockerfile),
      `Dockerfile 不该 COPY ${f}`);
  }
});

// ── F23：.gitignore 覆盖整个凭据目录 ─────────────────────────────────
test('F23：.gitignore 忽略 config/ 全部内容，但保留 *.example.json', () => {
  assert.ok(gitignore.includes('config/*'), '必须有 config/* 规则（config/ 会让 ! 反选失效）');
  assert.ok(gitignore.includes('!config/*.example.json'), '必须保留示例文件');
  assert.ok(gitignore.includes('*.bak'), '必须忽略 *.bak');
  // 目录规则不能是裸 config/ —— 那会让后续反选规则失效
  assert.ok(!gitignore.includes('config/'), '不该用 config/（! 反选在目录整体忽略时不生效）');
});

// ── F24：core 容器不能以 root 跑 ────────────────────────────────────
test('F24：compose 给 core/gateway 都加了非 root 用户与权限收紧', () => {
  const compose = read('docker-compose.yml');
  for (const svc of ['core', 'gateway']) {
    const block = compose.slice(compose.indexOf(`  ${svc}:`));
    const next = block.indexOf('\n  gateway:', 1);
    const body = svc === 'core' && next > 0 ? block.slice(0, next) : block;
    assert.match(body, /cap_drop:\s*\[ALL\]/, `${svc} 必须 cap_drop: [ALL]`);
    assert.match(body, /no-new-privileges:true/, `${svc} 必须 no-new-privileges:true`);
  }
  // core 显式指定非 root uid（vendor 镜像没有 USER 指令，只能在编排层收紧）
  const coreBlock = compose.slice(compose.indexOf('  core:'), compose.indexOf('  gateway:'));
  assert.match(coreBlock, /user:\s*"1000:1000"/, 'core 必须显式指定非 root 用户');
});

// ── F25：日志轮转 ───────────────────────────────────────────────────
test('F25：两个 service 都配了 json-file 日志轮转', () => {
  const compose = read('docker-compose.yml');
  const blocks = compose.split(/\n(?=  \w+:)/);
  for (const name of ['core', 'gateway']) {
    const body = blocks.find((b) => b.startsWith(`  ${name}:`));
    assert.ok(body, `找不到 service ${name}`);
    assert.match(body, /logging:/, `${name} 必须配 logging`);
    assert.match(body, /driver:\s*json-file/, `${name} 日志驱动必须是 json-file`);
    assert.match(body, /max-size:\s*"10m"/, `${name} 必须有 max-size`);
    assert.match(body, /max-file:\s*"3"/, `${name} 必须有 max-file`);
  }
});

// ── F18：默认配置收敛 ───────────────────────────────────────────────
test('F18：默认 maxBodyBytes 收到 8MB 且 maxInflight 有值', () => {
  const cfg = JSON.parse(read('config.example.json'));
  assert.equal(cfg.maxBodyBytes, 8 * 1024 * 1024);
  assert.ok(cfg.maxInflight >= 4 && cfg.maxInflight <= 8, `maxInflight 应在 4~8，实际 ${cfg.maxInflight}`);
});

// ── M5：core 的网络隔离 ─────────────────────────────────────────────
test('M5：core 只挂在 internal 网络上，同网容器无法绕过网关直连 core:3050', () => {
  const compose = read('docker-compose.yml');
  const core = serviceBlock(compose, 'core');
  const gateway = serviceBlock(compose, 'gateway');

  // core-net 必须是 internal：没有出网路由，也不接受别的容器挂载
  const netDecl = uncommented(compose).match(/^networks:\n([\s\S]*)$/m);
  assert.ok(netDecl, 'compose 必须有顶层 networks 声明');
  assert.match(netDecl[1], /^  core-net:\n(?:    .*\n)*?    internal: true\s*$/m, 'core-net 必须 internal: true');

  assert.match(core, /^\s+core-net:\s*$/m, 'core 必须挂在 core-net 上（gateway 从这里访问它）');
  assert.match(gateway, /^\s+core-net:\s*$/m, 'gateway 必须挂在 core-net 上');
  assert.doesNotMatch(core, /1panel-network/, 'core 绝不能挂到反代外网（1panel-network）上');

  // core 要直连 CC 上游 → 它还需要一条出网路径；这条网络只能 core 自己挂，
  // 否则「同网容器可绕过网关直连 core」的问题会在另一条网络上原样复现。
  assert.match(core, /^\s+core-egress:\s*$/m, 'core 需要一条出网网络（CC 上游）');
  assert.doesNotMatch(gateway, /core-egress/, 'core-egress 只能 core 自己挂（不引入同网邻居）');
});

// ── tests-L4：compose 的只读根文件系统 ──────────────────────────────
test('tests-L4：core/gateway 都 read_only: true 且给了可写 /tmp', () => {
  const compose = read('docker-compose.yml');
  for (const name of ['core', 'gateway']) {
    const body = serviceBlock(compose, name);
    assert.match(body, /^\s+read_only:\s*true\s*$/m, `${name} 必须 read_only: true`);
    assert.match(body, /^\s+tmpfs:\s*\n\s+-\s*\/tmp\s*$/m, `${name} 必须 tmpfs: ["/tmp"]（read_only 下 node 需要可写 /tmp）`);
  }
  // gateway 的可写数据必须来自卷/bind，不然 read_only 会把 store 写坏
  const gateway = serviceBlock(compose, 'gateway');
  assert.match(gateway, /cc-manage-data:\/app\/data/, 'gateway 的 /app/data 必须来自命名卷');
  assert.match(gateway, /\.\/config:\/app\/config/, 'gateway 的 /app/config 必须来自 bind');
});

// ── tests-L6：网关内存预算 ──────────────────────────────────────────
test('tests-L6：gateway mem_limit ≥ 384m（192MB 堆 + 8×8MB 堆外 Buffer + 余量）', () => {
  const gateway = serviceBlock(read('docker-compose.yml'), 'gateway');
  const m = gateway.match(/^\s+mem_limit:\s*(\d+)([mMgG])\s*$/m);
  assert.ok(m, 'gateway 必须有 mem_limit');
  const bytes = Number(m[1]) * (/g/i.test(m[2]) ? 1024 ** 3 : 1024 ** 2);
  assert.ok(bytes >= 384 * 1024 * 1024, `gateway mem_limit 至少 384m（192MB 堆 + 64MB 堆外 Buffer + 余量），实际 ${m[0]}`);

  // 算式要写进注释，避免以后又被无脑调回 256m
  for (const f of ['docker-compose.yml', '.env.example']) {
    const text = read(f);
    assert.match(text, /max-old-space-size=192/, `${f} 必须写明 192MB 堆的口径`);
    assert.match(text, /64MB/, `${f} 必须写明 8MB×8 的堆外 Buffer 口径`);
  }
});

// ── M4：CI 必须跑 vendor 内核自带测试 ───────────────────────────────
test('M4：CI 与 npm test 都覆盖 vendor 内核自带测试', () => {
  const pkg = JSON.parse(read('package.json'));
  // 要求同一条命令里同时出现 node --test、并发标志、测试目录；
  // 断言的是「真执行的命令」，不是注释里凑出来的字面量。
  assert.match(
    pkg.scripts.test,
    /node --test[^\n]*--test-concurrency=\d+[^\n]*test\/\*\.test\.mjs/,
    'npm test 必须真跑带并发的 node --test test/*.test.mjs',
  );
  assert.match(pkg.scripts.test, /--test-concurrency=\d+/, 'npm test 必须带 --test-concurrency（并发保护）');
  assert.match(pkg.scripts.test, /npm --prefix vendor\/commandcode-proxy test/, 'npm test 必须连带跑内核测试');

  // 只把 run: 行抓出来断言：对整份文件匹配会被注释骗过。
  const ci = read('.github/workflows/docker-publish.yml');
  const runLines = [...ci.matchAll(/^\s*run:\s*(.+)$/gm)].map((m) => m[1]).join('\n');
  assert.ok(runLines.length > 0, '工作流里必须存在 run: 行');
  assert.match(
    runLines,
    /node --test[^\n]*--test-concurrency=\d+[^\n]*test\/\*\.test\.mjs/,
    'CI 的 run: 行必须真跑带并发的 node --test test/*.test.mjs',
  );
  assert.match(runLines, /npm --prefix vendor\/commandcode-proxy test/, 'CI 的 run: 行必须单独跑内核测试目录（内核镜像就是部署出去的那个）');
  assert.match(runLines, /npm run lint/, 'CI 的 run: 行必须真的调用 npm run lint（不能只写在注释里）');

  // 两个内核测试文件必须还在（否则「跑了」只是空跑）
  for (const f of ['test/stream-end.test.mjs', 'test/connection-lifecycle.test.mjs']) {
    assert.ok(fs.existsSync(path.join(ROOT, 'vendor/commandcode-proxy', f)), `缺 ${f}`);
  }
});

// ── L5：基础镜像 digest + OCI revision ──────────────────────────────
test('L5：两个 Dockerfile 都支持注入 BASE_IMAGE digest 并打 revision 标签', () => {
  for (const f of ['Dockerfile', 'vendor/commandcode-proxy/Dockerfile']) {
    const df = read(f);
    assert.match(df, /^ARG BASE_IMAGE=\S+$/m, `${f} 必须声明 ARG BASE_IMAGE（CI 注入 digest）`);
    assert.match(df, /^FROM \$\{BASE_IMAGE\}$/m, `${f} 的 FROM 必须用 ${'${BASE_IMAGE}'}`);
    assert.match(df, /^ARG REVISION=/m, `${f} 必须声明 ARG REVISION`);
    assert.match(df, /^LABEL org\.opencontainers\.image\.revision="\$\{REVISION\}"/m, `${f} 必须打 OCI revision 标签`);
  }

  const ci = read('.github/workflows/docker-publish.yml');
  assert.match(ci, /imagetools inspect node:22-alpine/, 'CI 里解析基础镜像 digest（不凭空写死 sha256）');
  assert.match(ci, /BASE_IMAGE=\$\{\{\s*steps\.base\.outputs\.image\s*\}\}/, 'CI 要把解析出的 digest 传给构建');
  assert.match(ci, /REVISION=\$\{\{\s*github\.sha\s*\}\}/, 'CI 要把 revision 传给构建');
});
