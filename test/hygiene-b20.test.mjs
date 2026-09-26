// 批次 20：测试卫生守护 —— 配置漂移 + skip 可见性。
//
// 只读仓库文本 + 真跑一次全量测试；不联网、不起服务、不 spawn 业务进程（只 spawn 测试跑者）。
// 本文件**不** import test/helpers.mjs：它要 spawn 一整套测试，需要把子进程的文件级挂起
// 预算放大（默认按文件规模的 ~120s 起步不够），所以直接在 spawn 的 env 里传，避免 ESM
// 静态 import 先于模块体执行、env 来不及设置的坑。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// ── B20-1：文档 / 部署文件里的「环境变量名」不得漂移 ─────────────────────
//
// 背景（本批审计发现）：README / DOCKER.md / run-from-ghcr.sh 一直在教一套**已经被测试断言
// 删除的旧流程**（`PROTECT_ADMIN_API` + 面板右上角填 key + sessionStorage 存凭证），而
//   test/auth.test.mjs  断言前台不再有 key 输入框、不再用 sessionStorage/localStorage 存凭证；
//   test/gateway.test.mjs 断言手动刷新按钮与 /api/accounts/refresh 调用已移除。
// 文档与实现各说各话，用户照着文档做必然踩空。这条守护用「文档里出现的环境变量名必须真的
// 存在于 src/config.mjs 的 ENV_MAP，且不得是已废弃项」把这类漂移钉死。
const DOC_FILES = ['README.md', 'DOCKER.md', '.env.example', 'docker-compose.yml', 'scripts/run-from-ghcr.sh'];

// 已废弃（文档里不得再出现）：src/config.mjs 的 DEFAULTS 注释里明确标了「已废弃」的旧开关。
const DEPRECATED_ENV = new Set(['PROTECT_ADMIN_API']);

// 文档里出现、但**不是网关配置环境变量**的全大写 token。每条都必须写清为什么不算配置漂移：
// 要么是部署编排层 / vendor 内核 / 脚本自己的变量，要么是代码示例里的字面量。
const DOC_NON_CONFIG_TOKENS = new Map([
  ['GATEWAY_BIND_PORT', 'docker compose / .env 的宿主侧端口变量（compose 插值用，不进网关进程）'],
  ['CC_MAX_BODY_MB', 'vendor 内核 commandcode-proxy 自己的限流变量'],
  ['CC_MAX_INFLIGHT', 'vendor 内核 commandcode-proxy 自己的限流变量'],
  ['CC_ACCOUNTS', 'store 层从 env 读账号池的入口（src/store.mjs），不在 ENV_MAP 里'],
  ['NODE_OPTIONS', 'Node 运行时变量'],
  ['NODE_ENV', 'Node 运行时变量'],
  ['BASE_IMAGE', 'Dockerfile 构建参数'],
  ['CONFIG_DIR', 'run-from-ghcr.sh 的脚本内变量'],
  ['DATA_DIR', 'run-from-ghcr.sh 的脚本内变量'],
  ['CORE_IMAGE', 'run-from-ghcr.sh 的脚本内变量'],
  ['GATEWAY_IMAGE', 'run-from-ghcr.sh 的脚本内变量'],
  ['COMMON_RUN_ARGS', 'run-from-ghcr.sh 的脚本内数组'],
  ['CORE_RUN_ARGS', 'run-from-ghcr.sh 的脚本内数组'],
  ['GATEWAY_RUN_ARGS', 'run-from-ghcr.sh 的脚本内数组'],
  ['BASH_SOURCE', 'bash 内建变量'],
  ['NO_KEY_LEAK', 'DOCKER.md 验收命令里的字符串字面量（不是变量）'],
  ['MODEL_NOT_IN_PLAN', '上游错误码字面量（README 里的报文示例）'],
]);

/** 从 src/config.mjs 里取出 ENV_MAP 的全部键（它就是「env 名 → 配置字段」的映射表）。 */
function parseEnvMapKeys(src) {
  const start = src.indexOf('const ENV_MAP = {');
  assert.ok(start > -1, 'src/config.mjs 必须有 ENV_MAP 映射表');
  const end = src.indexOf('\n};', start);
  assert.ok(end > start, 'ENV_MAP 必须以 }\n; 收尾（解析边界）');
  const block = src.slice(start, end);
  return [...block.matchAll(/^\s{2}([A-Z][A-Z0-9_]+)\s*:\s*\[/gm)].map((m) => m[1]);
}

/** ENV 名 → 配置字段名（camelCase）：用于把解析结果与运行期导出的 DEFAULTS 对齐校验。 */
const camelize = (envKey) => envKey.toLowerCase().replace(/_([a-z0-9])/g, (_m, c) => c.toUpperCase());
// 少数 env 名与字段名不是机械 camelCase（KEEPALIVE → keepAlive 的大小写差异），显式列出。
const ENV_FIELD_ALIASES = new Map([['KEEPALIVE_TIMEOUT_MS', 'keepAliveTimeoutMs']]);
const fieldOf = (envKey) => ENV_FIELD_ALIASES.get(envKey) ?? camelize(envKey);

test('B20-1：文档里的环境变量名必须存在于 src/config.mjs 的 ENV_MAP，且不得是已废弃项', async () => {
  const envKeys = parseEnvMapKeys(read('src/config.mjs'));
  assert.ok(envKeys.length >= 30, `ENV_MAP 解析异常：只拿到 ${envKeys.length} 个键`);

  // 用运行期导出的 DEFAULTS 反向校验解析结果：ENV_MAP 的每个字段都必须真的存在于 DEFAULTS。
  const { DEFAULTS } = await import('../src/config.mjs');
  for (const key of envKeys) {
    assert.ok(fieldOf(key) in DEFAULTS,
      `ENV_MAP 的 ${key} 没有对应的 DEFAULTS 字段（${fieldOf(key)}）—— 映射表/解析方式变了，请同步本测试`);
  }

  const TOKEN_RE = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g;
  const seen = new Map();       // token → 出现在哪个文件
  const unknown = [];
  for (const file of DOC_FILES) {
    const text = read(file);
    for (const m of text.matchAll(TOKEN_RE)) {
      const token = m[0];
      if (!seen.has(token)) seen.set(token, file);
      if (DEPRECATED_ENV.has(token)) {
        unknown.push(`${file}: 已废弃的 ${token}（旧 key 输入方案已从实现里删除，文档必须统一到 PUBLIC_DASHBOARD）`);
      } else if (envKeys.includes(token) || DOC_NON_CONFIG_TOKENS.has(token)) {
        continue;
      } else {
        unknown.push(`${file}: ${token} 不在 src/config.mjs 的 ENV_MAP 里`
          + '（新增配置请先加映射表；不是网关配置请加进本文件的 DOC_NON_CONFIG_TOKENS 白名单并写明原因）');
      }
    }
  }
  assert.deepEqual(unknown, [], `文档出现配置漂移：\n${unknown.join('\n')}`);

  // 反向下界：正常文档里必然出现足够多的真实网关配置项，否则说明提取正则/文件列表坏了。
  const gatewayNames = [...seen.keys()].filter((t) => envKeys.includes(t));
  assert.ok(gatewayNames.length >= 15,
    `文档里只识别出 ${gatewayNames.length} 个网关环境变量名，提取逻辑可能已失效`);
  assert.ok(![...seen.keys()].some((t) => DEPRECATED_ENV.has(t)), '已废弃项不得再出现');
});

// ── B20-2：skip 必须可见（数量不超过显式白名单）──────────────────────────
//
// node:test 里 skip 算通过，于是「关键失败路径被静默降级为绿」永远不会有人发现：
// batch3-ops.test.mjs 里「逐项断言 docker run 参数」「chown 失败不中断启动」「挂起守卫真的
// exit 1」、batch3-security.test.mjs 的 HSTS/Secure cookie 端到端、store.test.mjs 的只读目录
// 用例，都可能整条不跑而套件照样全绿。
// 这条守护**解析全量测试输出**，把 skip 逐条比对白名单（每条写清为什么必须跳过）。
const ALLOWED_SKIPS = [
  {
    reason: 'B20_SCAN!=1',
    max: 1,
    why: 'B20-2 自身的本地门控：未设置 B20_SCAN=1 时它主动 t.skip（不带 env 的本地迭代不跑嵌套全量，'
      + '把套件墙钟从 ~1m30s 拉回 ~40s 量级）；CI 的 test job 显式设 B20_SCAN=1，所以这条守护在 CI 必然真跑。'
      + '该 skip 只出现在顶层输出里（B20-2 扫描的子进程显式排除了 hygiene-b20 自身，不会递归），'
      + '登记在此是为了让白名单自洽：白名单只做上限校验，CI 模式下本条 0 命中也不会报错。',
  },
  {
    reason: 'root 用户绕过文件权限位',
    max: 1,
    why: 'store.test.mjs M2b：用 chmod 555 模拟只读目录，root 会绕过 DAC 权限检查（accessSync W_OK 仍为 true），'
      + '该路径物理上只在非 root 环境可测。CI 容器可以以非 root 跑这一条。',
  },
  {
    reason: '环境禁止 spawn 子进程',
    max: 6,
    why: 'batch3-ops（5 条）+ robustness-b11 B11-13（1 条）：受限沙箱 seccomp 会 EPERM，无法 spawn bash/node。'
      + '能 spawn 的环境（CI、开发机）必须全部真跑，`CAN_SPAWN_*` 为真时不会 skip。',
  },
  {
    reason: '环境禁止 listen',
    max: 2,
    why: 'batch3-security（2 条）：沙箱禁止 listen 时起不了真实 server，HSTS / Secure cookie 端到端断言无法进行。',
  },
  {
    reason: '本机没有可用的 docker compose',
    max: 1,
    why: 'deploy.test.mjs：需要本机装了 docker compose；CI 的 smoke job 覆盖这条路径。',
  },
  {
    reason: '本机无 Playwright（首页详情）',
    max: 1,
    why: 'detail-modal.test.mjs 的真实弹窗与窄屏几何断言需要 Playwright + Chromium；'
      + '不依赖浏览器的 detailWindow 固定输入/输出与无数据断言仍在任何环境运行。',
  },
  {
    reason: '本机无 Playwright',
    max: 1,
    why: 'b25-narrow-overflow.test.mjs 的真机断言需要 Playwright + Chromium，CI runner 未安装，故必须跳过。'
      + '这不构成静默降级：无浏览器的结构 + 计算模型断言（B25-C-结构）在任何环境都真跑；它断言 max-sm:flex-wrap 在位，'
      + '并用文本宽模型证明不换行最小所需 282px > 可用 277px，对换行机制被去掉具有变异敏感性。'
      + '本机有 Playwright 时该断言真跑：node --test test/b25-narrow-overflow.test.mjs 实测 2 tests / 2 pass / 0 skipped，'
      + '真实 Chromium 在 375/414px 逐路由断言通过。',
  },
  {
    reason: '真 vendor 内核在本环境无法启动',
    max: 2,
    why: 'ops-b18（2 条）：需要 vendor/commandcode-proxy 内核能在本机起来（含依赖与端口）；'
      + '起不来时只跳过「真内核链路」这两条，其余断言仍在。',
  },
];
const SKIP_BUDGET = ALLOWED_SKIPS.reduce((n, w) => n + w.max, 0);

test('B20-2：全量测试的 skip 数量与原因都必须在显式白名单内（skip 不得悄悄变绿）',
  { timeout: 300000 },
  (t) => {
    // 这条守护要在测试里再跑一遍**全量**（实测把套件墙钟从 ~40s 拉到 ~1m30s）。工程上真正需要
    // 「全量绿」的判定点是 CI，本地迭代要求快，所以默认跳过——但**绝不静默变绿**：显式 t.skip 并
    // 打印原因，让人看到它被跳过了、以及为什么；CI 的 test job 设 B20_SCAN=1 时必然真跑。
    if (process.env.B20_SCAN !== '1') {
      t.skip('B20_SCAN!=1：skip 白名单守护仅在 CI 执行（本地保持套件快速）');
      return;
    }
    const files = fs.readdirSync(path.join(ROOT, 'test'))
      .filter((f) => f.endsWith('.test.mjs') && f !== 'hygiene-b20.test.mjs')   // 防止递归
      .map((f) => path.join('test', f));
    assert.ok(files.length >= 40, `只找到 ${files.length} 个测试文件，别把 recursion 排除写成漏跑`);

    const r = spawnSync(
      process.execPath,
      ['--test', '--test-timeout=150000', '--test-concurrency=8', '--test-reporter=tap', ...files],
      {
        cwd: ROOT,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        timeout: 280000,
        // 子进程是完整的一套测试：文件级挂起预算放大（每个测试文件自己的 --test-timeout 仍在兜用例级）。
        // 必须删掉 NODE_TEST_CONTEXT：否则嵌套的 `node --test` 会以为自己是某个父 runner 的子测试
        // 进程，直接不跑任何文件（表现为秒退、输出里没有 `# tests`）。
        env: (() => {
          const env = { ...process.env, CC_TEST_HANG_GUARD_MS: '900000' };
          delete env.NODE_TEST_CONTEXT;
          return env;
        })(),
      },
    );
    assert.equal(r.error, undefined, `全量测试跑不完（${r.error?.message ?? 'spawn 失败'}）`);
    const out = `${r.stdout}${r.stderr}`;
    assert.equal(r.status, 0, `全量测试必须全绿，退出码 ${r.status}；tail:\n${out.slice(-2000)}`);

    const testsLine = /# tests (\d+)/.exec(out);
    assert.ok(testsLine, '输出里必须有 `# tests N` 汇总行');
    assert.ok(Number(testsLine[1]) >= 520, `只跑到 ${testsLine[1]} 个测试，明显不是全量（walk/glob 坏了？）`);

    const skippedLine = /# skipped (\d+)/.exec(out);
    assert.ok(skippedLine, '输出里必须有 `# skipped N` 汇总行');
    const skipLines = out.split('\n').filter((l) => /^ok \d+ - .* # SKIP/.test(l));
    assert.equal(Number(skippedLine[1]), skipLines.length, '`# skipped` 汇总与逐条 SKIP 行数必须一致');
    assert.ok(skipLines.length <= SKIP_BUDGET,
      `skip 数量 ${skipLines.length} 超过白名单预算 ${SKIP_BUDGET}：${skipLines.join('\n')}`);

    const counts = new Map();
    for (const line of skipLines) {
      const reason = line.split('# SKIP')[1].trim();
      const entry = ALLOWED_SKIPS.find((w) => reason.includes(w.reason));
      assert.ok(entry,
        `出现了未登记的 skip：「${reason}」\n`
        + '（skip 在 node:test 里算通过 —— 新增 skip 必须在本文件 ALLOWED_SKIPS 里写清「为什么这个必须跳过」，'
        + '否则关键失败路径会静默降级为绿）');
      counts.set(entry.reason, (counts.get(entry.reason) ?? 0) + 1);
    }
    for (const [reason, n] of counts) {
      const entry = ALLOWED_SKIPS.find((w) => w.reason === reason);
      assert.ok(n <= entry.max, `「${reason}」skip 了 ${n} 条，超过白名单 max=${entry.max}`);
    }
  });
