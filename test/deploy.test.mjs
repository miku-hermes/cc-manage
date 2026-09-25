// F22 / F23 / F24 / F25：部署配置的回归测试（纯静态检查，不跑 docker）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// B18：线上形态由 docker-compose.override.yml 决定（GHCR 镜像 / 1panel-network 别名 /
// external network）。只读 base 文件等于对真实拓扑零覆盖，所以 override 也读进来。
const OVERRIDE = read('docker-compose.override.yml');

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

/** 取某个 service 的 healthcheck 子块（healthcheck 通常是 service 的最后一个 key，所以按
 *  缩进收子键，而不是靠「下一个同级 key」定界）。 */
function healthcheckBlock(text, name) {
  const m = serviceBlock(text, name).match(/^ {4}healthcheck:\n((?: {6}\S.*\n?)*)/m);
  assert.ok(m, `${name} 必须有 healthcheck`);
  return m[1];
}

/**
 * base + override 合并后的有效配置（`docker compose config --format json`）。
 * 本机没有 docker / 不允许 spawn 时返回 null，由调用方显式 skip ——
 * CI（ubuntu-latest 自带 docker compose）一定会跑到。
 */
function mergedComposeConfig() {
  try {
    const out = execFileSync('docker', [
      'compose', '-f', 'docker-compose.yml', '-f', 'docker-compose.override.yml',
      'config', '--format', 'json',
    ], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return JSON.parse(out);
  } catch {
    return null;
  }
}

// ── F22：.dockerignore 必须覆盖所有真实凭据 ──────────────────────────
test('F22：.dockerignore 覆盖 config/ 与全部凭据文件名', () => {
  for (const pattern of ['config/', 'users.json', 'session-secret', 'accounts.json', 'keys.json', 'docker-compose*.yml']) {
    assert.ok(dockerignore.includes(pattern), `.dockerignore 必须包含 ${pattern}`);
  }
});

// ── B21b：.dockerignore 不能把面板的 ECharts 一起排掉 ─────────────────
test('B21b：.dockerignore 用根锚定 /vendor，不得有裸 vendor 误伤 panel/public/vendor', () => {
  // Docker 的 .dockerignore 语义：不含斜杠的模式匹配任意层级。裸 `vendor` 会同时命中
  // 仓库根的 vendor/（后端内核，应排除）与 panel/public/vendor/（ECharts，必须保留），
  // 结果 gateway 镜像里没有图表库 → 线上趋势图退化成文本摘要。
  assert.ok(dockerignore.includes('/vendor'),
    '.dockerignore 必须用根锚定的 /vendor 只排仓库根的后端内核');
  assert.ok(!dockerignore.includes('vendor'),
    '不得出现无斜杠 vendor —— 它匹配任意层级，会把 panel/public/vendor/echarts.min.js 一起排掉');
  assert.deepEqual(dockerignore.filter((p) => p.replace(/^\.\//, '') === 'vendor'), [],
    '任何裸 vendor 行都会误伤 panel/public/vendor/');
  assert.ok(fs.existsSync(path.join(ROOT, 'panel/public/vendor/echarts.min.js')),
    'panel/public/vendor/echarts.min.js 必须存在，否则镜像里无库可发');
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

// ── B18-1：liveness / readiness 分工（gateway 探 /ready，core 探内核自己的 /health）──
test('B18-1：gateway 的 healthcheck 指向 /ready（readiness），不是 /health', () => {
  const hc = healthcheckBlock(read('docker-compose.yml'), 'gateway');
  assert.match(hc, /127\.0\.0\.1:3051\/ready/, 'gateway 必须探 /ready —— 只探 /health 时 core 挂了容器仍报 healthy');
  assert.doesNotMatch(hc, /3051\/health/, '不能再用 liveness 端点当探活判据');

  const num = (key) => Number((hc.match(new RegExp(`^\\s+${key}:\\s*(\\d+)s?\\s*$`, 'm')) ?? [])[1]);
  assert.ok(num('start_period') >= 30, `start_period 要给足（避免启动瞬间抖动误判），实际 ${num('start_period')}s`);
  assert.ok(num('retries') >= 3, `retries 要给足，实际 ${num('retries')}`);
  // 探针自身的硬超时是 2s（gateway.mjs），healthcheck 的 timeout 必须比它大，
  // 否则所有失败都会表现为「healthcheck 超时」，看不出是网关还是上游的问题。
  assert.ok(num('timeout') > 2, `healthcheck timeout 必须大于网关内部 2s 探测上界，实际 ${num('timeout')}s`);
  const gatewaySrc = read('gateway.mjs');
  assert.match(gatewaySrc, /readyProbeTimeoutMs[\s\S]{0,120}2000/, '探测超时上界必须是 2s（写死可见）');
});

test('B18-1：core 的 healthcheck 探的是 vendor 内核真实存在的 /health', () => {
  const hc = healthcheckBlock(read('docker-compose.yml'), 'core');
  assert.match(hc, /127\.0\.0\.1:3050\/health/);
  // vendor 内核（上游镜像，本仓库不改）只实现 /health 与 /：给它写 /ready 会让 core 永远
  // unhealthy → gateway（depends_on service_healthy）永远起不来。这里把「只能探 /health」
  // 这条事实钉在 vendor 路由上，避免以后有人照着 gateway 抄一行 /ready 过去。
  const vendor = read('vendor/commandcode-proxy/proxy.mjs');
  assert.match(vendor, /url\.pathname === '\/health'/, 'vendor 内核必须有 /health 路由');
  assert.doesNotMatch(vendor, /'\/ready'/, 'vendor 内核没有 /ready —— core 的探活不能指向它');
});

// ── B18-4：override 决定真实生产拓扑，断言必须覆盖它 ────────────────────
test('B18-4：override 里两个服务都是 GHCR 镜像，gateway 带 1panel-network 别名', () => {
  const core = serviceBlock(OVERRIDE, 'core');
  const gateway = serviceBlock(OVERRIDE, 'gateway');
  assert.match(core, /^\s+image:\s*ghcr\.io\/\S+\/cc-manage-core:\S+$/m, 'core 必须用 GHCR 镜像');
  assert.match(gateway, /^\s+image:\s*ghcr\.io\/\S+\/cc-manage-gateway:\S+$/m, 'gateway 必须用 GHCR 镜像');
  assert.match(gateway, /^\s+1panel-network:\s*$/m, 'gateway 必须挂 1panel-network（openresty 反代入口）');
  assert.match(gateway, /aliases:\s*\n\s*-\s*cc-manage-gateway\s*$/m, '别名必须是 cc-manage-gateway');
  const net = uncommented(OVERRIDE).match(/^networks:\n([\s\S]*)$/m);
  assert.ok(net, 'override 必须有顶层 networks');
  assert.match(net[1], /^  1panel-network:\n(?:    .*\n)*?    external: true\s*$/m, '1panel-network 必须是 external');
});

test('B18-4：base 的回环端口 / depends_on / restart / mem_limit（结构断言）', () => {
  const compose = read('docker-compose.yml');
  const core = serviceBlock(compose, 'core');
  const gateway = serviceBlock(compose, 'gateway');

  assert.match(core, /^\s+restart:\s*unless-stopped\s*$/m, 'core 必须 restart: unless-stopped');
  assert.match(gateway, /^\s+restart:\s*unless-stopped\s*$/m, 'gateway 必须 restart: unless-stopped');

  assert.match(gateway, /^\s+depends_on:\n\s+core:\n\s+condition:\s*service_healthy\s*$/m,
    'gateway 必须等 core 健康（depends_on: service_healthy）');

  // core 的内存上限（vendor 内核按 20MB body × 8 in-flight 估算）
  const coreMem = core.match(/^\s+mem_limit:\s*(\d+)([mMgG])\s*$/m);
  assert.ok(coreMem, 'core 必须有 mem_limit');
  assert.equal(Number(coreMem[1]) * (/g/i.test(coreMem[2]) ? 1024 ** 3 : 1024 ** 2), 512 * 1024 * 1024);

  // 端口只能绑宿主回环，且只有一条映射 —— 任何 0.0.0.0 / 裸 3051:3051 都是对外暴露
  const ports = gateway.match(/^\s+ports:\n((?:\s+-\s+.*\n)+)/m);
  assert.ok(ports, 'gateway 必须有 ports 段');
  assert.match(ports[1], /127\.0\.0\.1:\$\{GATEWAY_BIND_PORT:-3051\}:3051/, '必须绑 127.0.0.1:<port>:3051');
  assert.doesNotMatch(ports[1], /0\.0\.0\.0/, '绝不能绑 0.0.0.0');
  assert.equal((ports[1].match(/^\s+-\s/gm) ?? []).length, 1, '只允许一条端口映射（多一条就可能对外）');
});

test('B18-4：base+override 合并后的有效配置（docker compose config）', (t) => {
  const cfg = mergedComposeConfig();
  if (!cfg) return t.skip('本机没有可用的 docker compose（CI 的 smoke job 一定会跑到这条）');
  const { core, gateway } = cfg.services;

  assert.equal(gateway.restart, 'unless-stopped');
  assert.equal(core.restart, 'unless-stopped');
  assert.equal(gateway.depends_on.core.condition, 'service_healthy');
  assert.equal(core.mem_limit, String(512 * 1024 * 1024), 'core 的 mem_limit 必须原样活到合并结果里');

  assert.ok(gateway.healthcheck, 'gateway 的 healthcheck 不能被 override 弄丢');
  assert.ok(gateway.healthcheck.test.join(' ').includes('3051/ready'), '合并后 gateway 必须仍探 /ready');
  assert.ok(core.healthcheck.test.join(' ').includes('3050/health'));

  assert.equal(gateway.ports.length, 1, '只允许一条端口映射');
  assert.equal(gateway.ports[0].host_ip, '127.0.0.1', '端口只能绑宿主回环');
  assert.equal(Number(gateway.ports[0].target), 3051);
  assert.equal(gateway.ports[0].mode, 'ingress');

  assert.match(gateway.image, /cc-manage-gateway:latest$/, 'override 的 GHCR 镜像必须活到合并结果里');
  assert.match(core.image, /cc-manage-core:latest$/);
  assert.deepEqual(gateway.networks['1panel-network'].aliases, ['cc-manage-gateway'],
    'gateway 必须带着 cc-manage-gateway 别名挂进 1panel-network');
  assert.equal(cfg.networks['1panel-network'].external, true);
  assert.equal(cfg.networks['core-net'].internal, true, 'core-net 必须仍是 internal');
});
