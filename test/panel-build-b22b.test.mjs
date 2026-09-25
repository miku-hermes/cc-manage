// B22b：根 public/ 已定为**构建产物**（由 panel/dist 同步，不进 git）。这里钉住三件事：
//   1) 面板缺失（干净 checkout 没跑构建）→ GET /、/admin 回 503 + 可照做的提示，不是裸 500；
//   2) 面板存在 → GET / 的响应体与构建产物 panel/dist/index.html **逐字节**一致；
//   3) 面板故障不放大：/health、/api/status 照常 200；缺失只记一条 warn（warn 级、不刷屏）。
// 变异验证：把 gateway.mjs 的 ENOENT 分支改回直接 readFileSync（抛异常）→ 本文件第 1 条变红。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTestGateway, request, makeTmpDir, waitFor } from './helpers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST_INDEX = path.join(ROOT, 'panel', 'dist', 'index.html');

/** 一个「没有 index.html 的面板目录」= 干净 checkout 还没跑 panel-build 的等价形态。 */
function emptyPanelDir() {
  const dir = makeTmpDir();
  const publicDir = path.join(dir, 'public');
  fs.mkdirSync(publicDir, { recursive: true });
  return { dir, publicDir };
}

test('B22b-1：面板未构建 → GET / 回 503 + 可操作提示（不是裸 500），且不拖垮 /health、/api/status', async (t) => {
  const { dir, publicDir } = emptyPanelDir();
  const ctx = await startTestGateway({ publicDir, config: { publicDashboard: true }, noInitialRefresh: true });
  t.after(async () => { await ctx.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  const page = await request(`${ctx.baseUrl}/`);
  assert.equal(page.status, 503, `面板缺失时 GET / 必须 503（不是裸 500），实际 ${page.status}`);
  assert.equal(page.headers['content-type'], 'text/html; charset=utf-8', '必须回可读的 HTML 提示，不是 JSON 错误');
  assert.match(page.body, /panel-build\.sh/, '503 页面必须给出可照做的命令（含 panel-build.sh）');

  // 后台页走 readAdmin：缺 admin.html 同样 503
  const admin = await request(`${ctx.baseUrl}/admin`);
  assert.equal(admin.status, 503, '面板缺失时 GET /admin 也必须 503（不是 500）');
  assert.match(admin.body, /panel-build\.sh/, '/admin 的 503 也要给可操作提示');

  // 面板故障绝不能放大成整体不可用
  const health = await request(`${ctx.baseUrl}/health`);
  assert.equal(health.status, 200, '/health 与面板无关，面板缺失时必须仍 200');
  const status = await request(`${ctx.baseUrl}/api/status`);
  assert.equal(status.status, 200, '/api/status 与面板无关，面板缺失时必须仍 200');
});

test('B22b-2：面板已构建 → GET / 逐字节等于 panel/dist/index.html（证明 public/ 就是构建产物）', async (t) => {
  assert.ok(fs.existsSync(DIST_INDEX),
    '先跑 `bash scripts/panel-build.sh`：panel/dist/index.html 是构建产物，测试在「已构建」状态下运行');
  const ctx = await startTestGateway({ config: { publicDashboard: true }, noInitialRefresh: true });
  t.after(() => ctx.close());

  const page = await request(`${ctx.baseUrl}/`);
  assert.equal(page.status, 200, `面板已构建时 GET / 必须 200，实际 ${page.status}`);
  const served = Buffer.from(page.body, 'utf8');
  const built = fs.readFileSync(DIST_INDEX);
  assert.ok(served.equals(built),
    `GET / 的字节必须与构建产物逐字节一致（served ${served.length}B vs panel/dist ${built.length}B）`);
});

test('B22b-3：面板缺失只记一条 warn 级日志（不逐请求刷屏、不用 error 级）', async (t) => {
  const { dir, publicDir } = emptyPanelDir();
  const logFile = path.join(dir, 'gateway.log');
  const ctx = await startTestGateway({
    publicDir, config: { logLevel: 'warn', logFile }, noInitialRefresh: true,
  });
  t.after(async () => { await ctx.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  // 连打 3 次，验证「靠守卫去重」而不是每请求一条。
  for (let i = 0; i < 3; i += 1) {
    assert.equal((await request(`${ctx.baseUrl}/`)).status, 503);
  }
  await waitFor(
    () => fs.existsSync(logFile) && fs.readFileSync(logFile, 'utf8').includes('面板未构建'),
    { label: 'panel-missing-warn 落盘' },
  );

  const warns = fs.readFileSync(logFile, 'utf8').split('\n').filter((l) => l.includes('面板未构建'));
  assert.equal(warns.length, 1, `面板缺失期间只允许一条 warn（3 次请求实际 ${warns.length} 条 → 会刷屏）`);
  assert.match(warns[0], /\[warn\]/, '必须是 warn 级');
  assert.doesNotMatch(warns[0], /\[error\]/, '面板未构建不是真故障，不得用 error 级');
});
