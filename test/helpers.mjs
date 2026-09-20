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

/**
 * 在 Node 里跑页面内联脚本的极简 DOM 垫片（零依赖、无浏览器）。
 *
 * 用途：验证「响应头里的 CSP 允许内联脚本」和「页面脚本本身能跑通渲染」这两件
 * 光看响应头看不出来的事（QA-F13 明确要求别只看 header）。
 * 只实现两个页面真正用到的 API：getElementById / querySelectorAll / classList /
 * innerHTML / textContent / style / dataset / appendChild / 事件绑定 / fetch / matchMedia。
 */
export function createDomShim({ html, fetchImpl, localStorageData = {} }) {
  const ids = new Set();
  for (const m of html.matchAll(/\bid="([^"]+)"/g)) ids.add(m[1]);
  const nodes = new Map();
  const store = new Map(Object.entries(localStorageData));

  function makeEl(id = '') {
    const classes = new Set();
    const el = {
      id,
      ownerDocument: null,
      innerHTML: '',
      textContent: '',
      value: '',
      title: '',
      disabled: false,
      checked: false,
      hidden: false,
      style: {},
      dataset: {},
      children: [],
      _handlers: {},
      className: '',
      classList: {
        add: (...cs) => cs.forEach((c) => classes.add(c)),
        remove: (...cs) => cs.forEach((c) => classes.delete(c)),
        contains: (c) => classes.has(c),
        toggle: (c) => (classes.has(c) ? classes.delete(c) : classes.add(c)),
      },
      setAttribute(k, v) { this[k] = v; },
      getAttribute(k) { return this[k] ?? null; },
      removeAttribute(k) { delete this[k]; },
      appendChild(c) { this.children.push(c); return c; },
      addEventListener(type, fn) { (this._handlers[type] ??= []).push(fn); },
      removeEventListener() {},
      focus() {},
      click() { for (const fn of this._handlers.click ?? []) fn({}); },
      querySelectorAll: () => [],
      closest: () => null,
      getBoundingClientRect: () => ({ width: 0, height: 0, top: 0, left: 0 }),
    };
    return el;
  }

  for (const id of ids) nodes.set(id, makeEl(id));
  const documentElement = makeEl('html');
  const body = makeEl('body');

  const document = {
    hidden: false,
    documentElement,
    body,
    getElementById: (id) => {
      if (!nodes.has(id)) nodes.set(id, makeEl(id));
      return nodes.get(id);
    },
    querySelectorAll: () => [],
    querySelector: () => null,
    createElement: (tag) => makeEl(tag),
    addEventListener: () => {},
    readyState: 'complete',
  };

  const calls = [];
  const fetch = async (url, opts) => {
    calls.push({ url: String(url), opts: opts ?? null });
    return fetchImpl(String(url), opts);
  };

  const window = {
    document,
    innerWidth: 1440,
    matchMedia: () => ({ matches: false, addEventListener: () => {}, addListener: () => {} }),
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    addEventListener: () => {},
    location: { href: 'http://127.0.0.1/', hash: '', pathname: '/' },
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval: () => {},
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
  };

  return {
    window,
    document,
    fetch,
    calls,
    el: (id) => document.getElementById(id),
    store,
  };
}

/** 用 DOM 垫片执行页面的内联脚本（取的正是 `default-src 'self'` 会禁掉的那段）。 */
export async function runInlineScript(html, shim) {
  const { default: vm } = await import('node:vm');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assertAtLeastOne(scripts);
  const context = vm.createContext({
    ...shim.window,
    window: shim.window,
    document: shim.document,
    fetch: shim.fetch,
    console,
    Date,
    Number,
    String,
    Math,
    JSON,
    Object,
    Array,
    Map,
    Set,
    Promise,
    Error,
    RegExp,
    Boolean,
    Intl,
    isNaN,
    parseInt,
    parseFloat,
    encodeURIComponent,
    decodeURIComponent,
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval: () => {},
    localStorage: shim.window.localStorage,
  });
  for (const code of scripts) vm.runInContext(code, context, { filename: 'inline-script.js' });
  return context;
}

function assertAtLeastOne(scripts) {
  if (scripts.length === 0) throw new Error('页面里没有内联 <script>：CSP 相关测试的前提不成立');
}
