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
