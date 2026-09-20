// 测试公共工具：临时目录、起网关、起 mock 上游
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMockUpstream } from '../mocks/mock-cc-upstream.mjs';
import { startGateway } from '../gateway.mjs';

/** 取一个当前空闲端口（先 listen 0 再释放）。 */
export async function allocPort() {
  return await new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** 建一个隔离的临时工作目录（accounts.json / keys.json / data/ 都在里面）。 */
export function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cc-manage-test-'));
}

export function writeAccountFiles(dir, { accounts, keys }) {
  fs.writeFileSync(path.join(dir, 'accounts.json'), JSON.stringify({ accounts }, null, 2));
  fs.writeFileSync(path.join(dir, 'keys.json'), JSON.stringify({ keys }, null, 2));
}

export async function closeServer(server, timeoutMs = 3000) {
  if (!server || !server.listening) return;
  try { server.closeAllConnections?.(); } catch { /* 忽略 */ }
  await Promise.race([new Promise((r) => server.close(r)), new Promise((r) => setTimeout(r, timeoutMs))]);
  try { server.closeAllConnections?.(); } catch { /* 忽略 */ }
}

/** 起一个真实网关，上游指向 mock。返回 ctx，测试结束务必 await ctx.close()。 */
export async function startTestGateway({ accounts, keys, config = {}, plans, behavior, rootDir, noTimers = true } = {}) {
  const dir = rootDir ?? makeTmpDir();
  const defaultAccounts = accounts ?? [
    { name: '账号A', key: 'user_test_alpha', enabled: true },
    { name: '账号B', key: 'user_test_beta', enabled: true },
  ];
  const defaultKeys = keys ?? [{ name: '测试客户端', key: 'sk-cg-testkey123' }];
  writeAccountFiles(dir, { accounts: defaultAccounts, keys: defaultKeys });

  const upstream = await startMockUpstream({ plans, behavior });
  const port = await allocPort();

  const gw = await startGateway({
    rootDir: dir,
    noTimers,
    noInitialRefresh: true,
    env: { ...process.env, CC_ACCOUNTS: '', ASSET_NO: '1' },
    config: {
      gatewayPort: port,
      gatewayHost: '127.0.0.1',
      upstreamProxyUrl: upstream.url,
      ccApiBase: upstream.url,
      quotaTimeoutMs: 5000,
      allowPassthrough: false,
      logLevel: 'silent',
      ...config,
    },
  });

  return {
    dir,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    upstream,
    gateway: gw,
    localKey: defaultKeys[0].key,
    async close() {
      await gw.stop().catch(() => {});
      await upstream.close().catch(() => {});
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }
    },
  };
}

/** 简单 HTTP 请求（零依赖）。 */
export function request(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request(u, { method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body !== undefined) req.end(body);
    else req.end();
  });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
