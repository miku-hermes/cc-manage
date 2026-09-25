// 测试公共工具：临时目录、起网关、起 mock 上游
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMockUpstream } from '../mocks/mock-cc-upstream.mjs';
import { startGateway } from '../gateway.mjs';

// ── 挂起保护（对齐 vendor/commandcode-proxy/test/helpers.mjs）──────────
// node --test 的子进程只要还有活着的 server/socket 就不会退出：套件看起来「跑完了」
// 却一直挂着。这里用 unref 的定时器兜底：到点强制退出并说明原因；正常退出时
// unref 不阻止进程结束。用 CC_TEST_HANG_GUARD_MS 可在测试里缩短（见 batch3-ops.test.mjs）。
//
// B20：预算不再对所有文件一刀切 120s——大文件（gateway.test.mjs 68 个用例、每个都起
// 真实网关与 mock）在 8 并发下整体耗时远超小文件，固定 120s 会把「跑得慢」误报成
// 「疑似 server/socket 未关闭」，而报错里连是哪个文件都看不出来。现在：
//   1) 默认预算 = 200s 与「用例数 × 3s」取大（文件级预算按文件规模配置）；
//   2) 报错信息带上当前测试文件路径，配合 node --test 的 --test-timeout（用例级上限，
//      见 package.json）能直接定位到卡住的是哪个文件、哪个用例。
const SELF_FILE = new URL(import.meta.url).pathname;
let selfTestCount = 0;
try {
  const selfSrc = fs.readFileSync(SELF_FILE, 'utf8');
  selfTestCount = (selfSrc.match(/(?:^|\n)[ \t]*test\s*\(/g) ?? []).length;
} catch { /* 读不到就按 0 算，回落 120s 下限 */ }
const rawGuardMs = Number(process.env.CC_TEST_HANG_GUARD_MS);
// 非正数/非法值一律回落默认值：空串或拼错会算出 0/NaN，setTimeout 会立刻触发并假红。
// 预算下限 200s > package.json 的 --test-timeout=150s：卡住的用例由 runner 先报出
// （node --test 的超时信息给的是被测文件），这条守卫只在「用例都跑完了、进程却因残留
// handle 不退」时兜底，不会抢先把「跑得慢」误报成「疑似 socket 未关闭」。
const HANG_GUARD_DEFAULT_MS = Math.max(200000, selfTestCount * 3000);
const HANG_GUARD_MS = Number.isFinite(rawGuardMs) && rawGuardMs > 0 ? rawGuardMs : HANG_GUARD_DEFAULT_MS;
const hangGuard = setTimeout(() => {
  let active = '';
  try { active = process.getActiveResourcesInfo().join(','); } catch { /* 取不到就算了 */ }
  console.error(`[test] ${HANG_GUARD_MS}ms 内进程没有退出：疑似有 server/socket 未关闭`
    + `（文件 ${SELF_FILE}，共 ${selfTestCount} 个用例；当前活跃句柄：${active || '未知'}。`
    + '先看 node --test 的 --test-timeout 报出的文件名/用例名，再检查每个测试是否都在'
    + ' t.after / finally 里 await close()）。强制退出。');
  process.exit(1);
}, HANG_GUARD_MS);
hangGuard.unref?.();

/** 取一个当前空闲端口（先 listen 0 再释放）。 */
export async function allocPort({ attempts = 3 } = {}) {
  return retryOnPortConflict(() => new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  }), attempts);
}

/**
 * bind 冲突（EADDRINUSE）重试包装。
 *
 * listen(0)→close() 到调用方真正 bind 之间有一个空窗，端口可能被别的进程（并行跑的
 * 另一个测试文件、或上一次没退干净的进程）抢走；重试比直接让整个套件闪红更结实。
 * 其它错误（EACCES/EPERM…）不重试，立刻抛。
 */
export async function retryOnPortConflict(alloc, attempts = 3) {
  const tries = Number.isInteger(attempts) && attempts > 0 ? attempts : 1;
  let lastError;
  for (let i = 0; i < tries; i += 1) {
    try {
      return await alloc();
    } catch (e) {
      lastError = e;
      if (e?.code !== 'EADDRINUSE') throw e;
      if (i < tries - 1) await sleep(50 * (i + 1));
    }
  }
  throw lastError;
}

// ── 临时目录登记 + 进程退出兜底清理 ──────────────────────────────────
// 背景：node --test 的每个测试文件是独立进程，漏掉的 cc-manage-test-* 目录会一直
// 攒在 /tmp。这里在 makeTmpDir() 时登记，进程退出时统一兜底删除，防止将来再犯。
const tmpDirs = new Set();
let sweepRegistered = false;

// 只注册一次 exit 监听（守卫标志），避免同一进程里重复挂监听。
if (!sweepRegistered) {
  sweepRegistered = true;
  process.on('exit', () => sweepTmpDirs());
}

/**
 * 兜底清理：删掉登记表里所有临时目录。
 * 幂等：可重复调用、不抛；单个目录失败只忽略，不影响其它目录；对已不在磁盘上的
 * 目录用 force 直接 no-op（删除后又被在途回调「复活」的目录正好靠这一步收掉）。
 */
export function sweepTmpDirs() {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 单个失败忽略 */ }
  }
  tmpDirs.clear();
}

/**
 * 收掉测试资源。失败路径与正常收尾共用：起网关失败时必须把已经起来的 mock server
 * 与临时目录一起回收，否则 node --test 子进程会挂着不退出（假挂起，CI 只能等到超时）。
 * 任何一步失败都不影响其它步骤，也不掩盖原始错误。
 */
export async function cleanupTestResources({ gateway, upstream, dir, keepDir = false } = {}) {
  await gateway?.stop?.().catch(() => {});
  await upstream?.close?.().catch(() => {});
  if (!dir) return;
  if (keepDir) {
    // keepDir：这次不删，目录交给调用方 → 必须注销登记项，退出兜底不得误删。
    tmpDirs.delete(dir);
    return;
  }
  // 普通收尾：删目录但**保留**登记项。网关在途异步回调可能在删除后又把
  // data/state.json 写回来（实测泄漏根因），保留登记才能在退出兜底时收掉复活目录；
  // sweepTmpDirs 对「已删的登记项」是幂等的（force 不抛）。
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }
}

/** 建一个隔离的临时工作目录（accounts.json / keys.json / data/ 都在里面）。 */
export function makeTmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-manage-test-'));
  tmpDirs.add(dir);
  return dir;
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
export async function startTestGateway({
  accounts, keys, config = {}, plans, behavior, rootDir, noTimers = true, now,
  // B22：面板产物目录注入点（默认仓库根 public/）。测试传一个没有 index.html 的目录即可
  // 复现「面板未构建」→ GET / 必须 503，而不是裸 500。
  publicDir,
  // B20：默认对齐生产 —— 生产启动走的是 `if (!overrides.noInitialRefresh && accounts.length > 0)`
  // （gateway.mjs 启动即刷一次额度）。这里原先写死 noInitialRefresh: true，于是「启动即刷」
  // 这条容器每次启动都会走的路径在整套测试里从未被跑过。默认值改为 false 后它会在每个
  // startTestGateway 用例里真的跑起来；不需要这轮刷新的用例必须**显式**传 true（显式化，
  // 不是关闭覆盖）。相关用例见 test/gateway.test.mjs 的「启动即刷额度」三条。
  noInitialRefresh = false,
  // 依赖注入点：让「启动失败时的回收」能在不起任何 server 的情况下被单测（batch3-ops.test.mjs）。
  deps = {},
} = {}) {
  const launchUpstream = deps.startUpstream ?? startMockUpstream;
  const launchGateway = deps.startGateway ?? startGateway;
  const pickPort = deps.allocPort ?? allocPort;
  const dir = rootDir ?? makeTmpDir();
  const defaultAccounts = accounts ?? [
    { name: '账号A', key: 'user_test_alpha', enabled: true },
    { name: '账号B', key: 'user_test_beta', enabled: true },
  ];
  const defaultKeys = keys ?? [{ name: '测试客户端', key: 'sk-cg-testkey123' }];

  let upstream = null;
  let gw = null;
  let port = null;
  try {
    writeAccountFiles(dir, { accounts: defaultAccounts, keys: defaultKeys });
    upstream = await launchUpstream({ plans, behavior });

    // B18：端口竞争的重试必须落在**真正 bind 的那一步** —— 也就是下面 launchGateway →
    // gateway.mjs 的 server.listen。allocPort() 只是 listen(0) 探一下空闲端口再关掉，
    // 它和后面那次真正的 listen 之间存在空窗：并行跑的另一个测试文件、或上一次没退干净
    // 的进程都可能在这段空窗里把端口抢走，于是 EADDRINUSE 落在 launchGateway 上而**不是**
    // allocPort 上（把重试包在 allocPort 里等于没保护）。所以「取端口 + 起网关」整体交给
    // retryOnPortConflict：只有 EADDRINUSE 才换端口重试，最多 3 次。
    gw = await retryOnPortConflict(async () => {
      const picked = await pickPort();
      port = picked;
      return launchGateway({
        rootDir: dir,
        noTimers,
        noInitialRefresh,
        now,
        publicDir,
        env: { ...process.env, CC_ACCOUNTS: '', ASSET_NO: '1' },
        config: {
          gatewayPort: picked,
          gatewayHost: '127.0.0.1',
          upstreamProxyUrl: upstream.url,
          ccApiBase: upstream.url,
          quotaTimeoutMs: 5000,
          allowPassthrough: false,
          logLevel: 'silent',
          ...config,
        },
      });
    }, 3);

    // B20：默认对齐生产 → 「启动即刷额度」真的跑。这里把它**等到跑完**再返回，避免调用方
    // 与在途首刷竞争：首刷的 recordQuota 会清掉刚写入的 lastError、会消费探针 TTL、
    // 也会让随后第一次 gw.refreshAll() 复用首轮的 in-flight promise（于是「手动刷新」其实
    // 没刷）。startGateway 返回后的这一次续体是同步执行的，而首刷的 fetch 还停在 I/O 上，
    // 所以这次 gw.refreshAll() 一定复用启动轮的那个 promise，不会多打一轮。
    // 不需要这轮刷新的用例显式传 noInitialRefresh: true（见带该参数的用例注释）。
    if (!noInitialRefresh && defaultAccounts.length > 0 && typeof gw?.refreshAll === 'function') {
      await gw.refreshAll();
    }
  } catch (e) {
    // 起网关失败也要把 mock server / 临时目录收掉（rootDir 是调用方给的就不能删）。
    await cleanupTestResources({ gateway: gw, upstream, dir, keepDir: !!rootDir });
    throw e;
  }

  return {
    dir,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    upstream,
    gateway: gw,
    localKey: defaultKeys[0].key,
    async close() {
      // 保持原语义：close() 一定删掉工作目录（rootDir 由调用方 makeTmpDir() 给出，也一起清）。
      await cleanupTestResources({ gateway: gw, upstream, dir });
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
 * 条件轮询助手（B20）：等 predicate 成立再返回，而不是 sleep 一个「大概够了」的固定时长。
 *
 * 背景：一批用例用「固定 sleep + 很小余量」做时序同步（例如配置轮询 30ms、睡 150ms），
 * 在 8 并发 / 2 核的 CI 上墙钟被拉长时窗口会被压缩 → 偶发红；反过来，sleep 太短又会
 * 在「竞态其实还没发生」时假绿。waitFor 两个方向都堵住：条件成立立刻返回（不浪费墙钟），
 * 超时则抛出带 label 的清晰错误（而不是一条含义不明的断言失败）。
 *
 * predicate 可以是同步或异步；抛错的 predicate 视为「条件不成立」，最后一次错误会写进
 * 超时消息里便于定位。返回 predicate 的第一次 truthy 结果。
 */
export async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 20, label = 'waitFor' } = {}) {
  const timeout = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0 ? Number(timeoutMs) : 5000;
  const interval = Number.isFinite(Number(intervalMs)) && Number(intervalMs) > 0 ? Number(intervalMs) : 20;
  const deadline = Date.now() + timeout;
  let polls = 0;
  let lastError = null;
  for (;;) {
    polls += 1;
    let value;
    try {
      value = await predicate();
    } catch (e) {
      lastError = e;
      value = undefined;
    }
    if (value) return value;
    if (Date.now() >= deadline) {
      throw new Error(`${label}：${timeout}ms 内条件始终不成立（轮询 ${polls} 次）`
        + (lastError ? `；最后一次 predicate 抛错：${lastError.message}` : ''));
    }
    await sleep(Math.min(interval, Math.max(1, deadline - Date.now())));
  }
}

/**
 * 在 Node 里跑页面内联脚本的极简 DOM 垫片（零依赖、无浏览器）。
 *
 * 用途：验证「响应头里的 CSP 允许内联脚本」和「页面脚本本身能跑通渲染」这两件
 * 光看响应头看不出来的事（QA-F13 明确要求别只看 header）。
 * 只实现两个页面真正用到的 API：getElementById / querySelectorAll / classList /
 * innerHTML / textContent / style / dataset / appendChild / 事件绑定 / fetch / matchMedia。
 */
export function createDomShim({ html, fetchImpl, localStorageData = {} }) {
  const store = new Map(Object.entries(localStorageData));
  // HTML 里的空元素（不会闭合，解析时不能压栈）
  const VOID_TAGS = new Set([
    'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
    'param', 'source', 'track', 'wbr',
  ]);
  let documentRef = null;

  function makeEl(tag = '') {
    const classes = new Set();
    const attrs = new Map();
    const handlers = {};
    let innerHTMLValue = '';
    let ownText = '';
    let textOverride = null;

    const el = {
      tagName: String(tag).toLowerCase(),
      nodeType: 1,
      id: '',
      ownerDocument: null,
      parent: null,
      children: [],
      value: '',
      title: '',
      disabled: false,
      checked: false,
      hidden: false,
      selected: false,
      scrollLeft: 0,
      scrollWidth: 0,
      offsetWidth: 0,
      style: {},
      dataset: {},
      _handlers: handlers,
      _focusCount: 0,
      classList: {
        add: (...cs) => cs.forEach((c) => classes.add(c)),
        remove: (...cs) => cs.forEach((c) => classes.delete(c)),
        contains: (c) => classes.has(c),
        toggle: (c) => (classes.has(c) ? (classes.delete(c), false) : (classes.add(c), true)),
      },
      setAttribute(k, v) {
        const key = String(k);
        const val = String(v);
        if (key === 'id') { this.id = val; attrs.set('id', val); return; }
        if (key === 'class') {
          classes.clear();
          val.split(/\s+/).filter(Boolean).forEach((c) => classes.add(c));
          attrs.set('class', val);
          return;
        }
        attrs.set(key, val);
        if (key.startsWith('data-')) {
          const camel = key.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
          this.dataset[camel] = val;
        }
      },
      getAttribute(k) {
        const key = String(k);
        if (key === 'class') return this.className || null;
        if (key === 'id') return this.id || null;
        return attrs.has(key) ? attrs.get(key) : null;
      },
      hasAttribute(k) {
        const key = String(k);
        if (key === 'class') return classes.size > 0;
        if (key === 'id') return !!this.id;
        return attrs.has(key);
      },
      removeAttribute(k) {
        const key = String(k);
        attrs.delete(key);
        if (key === 'class') classes.clear();
        if (key === 'id') this.id = '';
      },
      appendChild(c) {
        if (c.parent) {
          const i = c.parent.children.indexOf(c);
          if (i >= 0) c.parent.children.splice(i, 1);
        }
        c.parent = this;
        this.children.push(c);
        return c;
      },
      removeChild(c) {
        const i = this.children.indexOf(c);
        if (i >= 0) this.children.splice(i, 1);
        c.parent = null;
        return c;
      },
      _appendText(t) { if (textOverride !== null) textOverride = null; ownText += String(t); },
      addEventListener(type, fn) { (handlers[type] ??= []).push(fn); },
      removeEventListener(type, fn) {
        if (handlers[type]) handlers[type] = handlers[type].filter((f) => f !== fn);
      },
      dispatchEvent(ev) { for (const fn of handlers[ev.type] ?? []) fn(ev); return true; },
      focus() { this._focusCount++; if (documentRef) documentRef.activeElement = this; },
      blur() {},
      click() {
        for (const fn of handlers.click ?? []) {
          fn({ target: this, currentTarget: this, preventDefault() {}, stopPropagation() {} });
        }
      },
      closest(sel) {
        let n = this;
        while (n) { if (n.matches && n.matches(sel)) return n; n = n.parent; }
        return null;
      },
      contains(n) { let p = n; while (p) { if (p === this) return true; p = p.parent; } return false; },
      getBoundingClientRect: () => ({ width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 }),
      get childNodes() { return this.children; },
      get firstChild() { return this.children[0] ?? null; },
      get firstElementChild() { return this.children.find((c) => c.nodeType === 1) ?? null; },
    };

    Object.defineProperty(el, 'className', {
      get: () => [...classes].join(' '),
      set: (v) => {
        classes.clear();
        String(v).split(/\s+/).filter(Boolean).forEach((c) => classes.add(c));
      },
      enumerable: true, configurable: true,
    });
    Object.defineProperty(el, 'innerHTML', {
      get: () => innerHTMLValue,
      set: (v) => {
        innerHTMLValue = String(v);
        textOverride = null;
        ownText = '';
        for (const c of el.children) c.parent = null;
        el.children = [];
        for (const c of parseFragment(innerHTMLValue)) el.appendChild(c);
      },
      enumerable: true, configurable: true,
    });
    Object.defineProperty(el, 'textContent', {
      get: () => {
        if (textOverride !== null) return textOverride;
        let out = ownText;
        for (const c of el.children) out += c.textContent;
        return out;
      },
      set: (v) => {
        textOverride = String(v);
        ownText = '';
        for (const c of el.children) c.parent = null;
        el.children = [];
        innerHTMLValue = '';
      },
      enumerable: true, configurable: true,
    });
    el.querySelectorAll = (sel) => {
      const out = [];
      const seen = new Set();
      for (const group of parseSelector(sel)) {
        walk(el.children, (node) => {
          if (!seen.has(node) && matchesSelector(node, group)) { seen.add(node); out.push(node); }
        });
      }
      return out;
    };
    el.querySelector = (sel) => el.querySelectorAll(sel)[0] ?? null;
    el.matches = (sel) => parseSelector(sel).some((group) => matchesSelector(el, group));
    return el;
  }

  function walk(nodes, fn) {
    for (const n of nodes) {
      // 只遍历元素节点：文本节点（nodeType 3）等不能进选择器匹配。
      if (n.nodeType !== 1) continue;
      fn(n);
      walk(n.children, fn);
    }
  }

  function applyAttrs(el, str) {
    const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
    let m;
    while ((m = re.exec(str))) {
      const val = m[2] ?? m[3] ?? m[4] ?? '';
      el.setAttribute(m[1].toLowerCase(), val);
    }
  }

  // 极简 HTML 片段解析：只建「元素 + 属性 + 文本」三层够用的树，够选择器遍历即可。
  function parseFragment(text) {
    const holder = makeEl('#fragment');
    const stack = [holder];
    const top = () => stack[stack.length - 1];
    let i = 0;
    while (i < text.length) {
      const lt = text.indexOf('<', i);
      if (lt < 0) { top()._appendText(text.slice(i)); break; }
      if (lt > i) top()._appendText(text.slice(i, lt));
      if (text.startsWith('<!--', lt)) {
        const e = text.indexOf('-->', lt + 4);
        i = e < 0 ? text.length : e + 3;
        continue;
      }
      if (text[lt + 1] === '!' || text[lt + 1] === '?') {
        const e = text.indexOf('>', lt);
        i = e < 0 ? text.length : e + 1;
        continue;
      }
      const m = /^<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/.exec(text.slice(lt));
      if (!m) { top()._appendText('<'); i = lt + 1; continue; }
      const full = m[0];
      const closing = m[1];
      const tag = m[2].toLowerCase();
      const attrStr = m[3];
      const selfClose = m[4];
      i = lt + full.length;
      if (closing) {
        for (let k = stack.length - 1; k >= 1; k--) {
          if (stack[k].tagName === tag) { stack.length = k; break; }
        }
        continue;
      }
      const el = makeEl(tag);
      applyAttrs(el, attrStr);
      top().appendChild(el);
      if (tag === 'script' || tag === 'style') {
        const re = new RegExp('</' + tag + '\\s*>', 'i');
        const cm = re.exec(text.slice(i));
        i = cm ? i + cm.index + cm[0].length : text.length;
        continue;
      }
      if (!selfClose && !VOID_TAGS.has(tag)) stack.push(el);
    }
    return holder.children.slice();
  }

  function parseCompound(compound) {
    const tests = [];
    let i = 0;
    while (i < compound.length) {
      const ch = compound[i];
      if (ch === '#') {
        let j = i + 1;
        while (j < compound.length && /[\w-]/.test(compound[j])) j++;
        tests.push(['id', compound.slice(i + 1, j)]);
        i = j;
      } else if (ch === '.') {
        let j = i + 1;
        while (j < compound.length && /[\w-]/.test(compound[j])) j++;
        tests.push(['class', compound.slice(i + 1, j)]);
        i = j;
      } else if (ch === '[') {
        const j = compound.indexOf(']', i);
        const inner = compound.slice(i + 1, j < 0 ? compound.length : j);
        const mm = /^([\w-]+)\s*(?:([~^$*|]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\]]*)))?$/.exec(inner.trim());
        if (mm) tests.push(['attr', mm[1].toLowerCase(), mm[2], mm[3] ?? mm[4] ?? mm[5] ?? null]);
        i = j < 0 ? compound.length : j + 1;
      } else if (ch === '*') {
        tests.push(['any']);
        i++;
      } else {
        let j = i;
        while (j < compound.length && /[a-zA-Z0-9-]/.test(compound[j])) j++;
        if (j === i) i++;
        else { tests.push(['tag', compound.slice(i, j).toLowerCase()]); i = j; }
      }
    }
    return tests;
  }

  function parseSelector(sel) {
    return String(sel).split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((group) => group.split(/\s+/).filter(Boolean).map(parseCompound).filter((c) => c.length));
  }

  function matchesCompound(el, tests) {
    for (const [kind, a, op, b] of tests) {
      if (kind === 'id') { if (el.id !== a) return false; }
      else if (kind === 'class') { if (!el.classList.contains(a)) return false; }
      else if (kind === 'tag') { if (el.tagName !== a) return false; }
      else if (kind === 'attr') {
        const v = el.getAttribute(a);
        if (v === null) return false;
        if (op) {
          const s = String(v);
          const t = b ?? '';
          if (op === '=' && s !== t) return false;
          if (op === '^=' && !s.startsWith(t)) return false;
          if (op === '$=' && !s.endsWith(t)) return false;
          if (op === '*=' && !s.includes(t)) return false;
          if (op === '~=' && !s.split(/\s+/).includes(t)) return false;
        }
      }
    }
    return true;
  }

  function matchesSelector(el, group) {
    // 顶层兜底：querySelectorAll('*') 之类的通配选择器绝不能命中文本节点。
    if (!el || el.nodeType !== 1) return false;
    let idx = group.length - 1;
    if (!matchesCompound(el, group[idx])) return false;
    idx--;
    let node = el.parent;
    while (idx >= 0 && node) {
      if (matchesCompound(node, group[idx])) idx--;
      node = node.parent;
    }
    return idx < 0;
  }

  const domRoot = makeEl('#document');
  for (const c of parseFragment(html)) domRoot.appendChild(c);
  function findById(id) {
    let found = null;
    walk(domRoot.children, (n) => { if (!found && n.id === id) found = n; });
    return found;
  }
  function findTag(tag) {
    let found = null;
    walk(domRoot.children, (n) => { if (!found && n.tagName === tag) found = n; });
    return found;
  }

  const documentElement = findTag('html') ?? makeEl('html');
  const body = findTag('body') ?? makeEl('body');
  // 垫片自己合成的 html/body 只给 document.documentElement / document.body 兜底，
  // 不是页面真实解析出来的节点：标记 _scaffold 后 document.querySelectorAll 不再统计它们。
  if (!documentElement.parent) { documentElement._scaffold = true; domRoot.appendChild(documentElement); }
  if (!body.parent) { body._scaffold = true; documentElement.appendChild(body); }

  const docHandlers = {};
  const document = {
    hidden: false,
    readyState: 'complete',
    activeElement: body,
    documentElement,
    body,
    _handlers: docHandlers,
    getElementById: (id) => findById(String(id)),
    querySelectorAll: (sel) => {
      const out = [];
      const seen = new Set();
      for (const group of parseSelector(sel)) {
        walk(domRoot.children, (n) => {
          if (n._scaffold) return;
          if (!seen.has(n) && matchesSelector(n, group)) { seen.add(n); out.push(n); }
        });
      }
      return out;
    },
    querySelector: (sel) => document.querySelectorAll(sel)[0] ?? null,
    createElement: (tag) => makeEl(String(tag).toLowerCase()),
    createTextNode: (t) => {
      const text = String(t);
      return { nodeType: 3, nodeName: '#text', data: text, nodeValue: text, textContent: text, parent: null, children: [] };
    },
    createRange: () => ({ selectNodeContents() {} }),
    addEventListener: (type, fn) => { (docHandlers[type] ??= []).push(fn); },
    removeEventListener: (type, fn) => {
      if (docHandlers[type]) docHandlers[type] = docHandlers[type].filter((f) => f !== fn);
    },
    dispatchEvent: (ev) => { for (const fn of docHandlers[ev.type] ?? []) fn(ev); return true; },
  };
  documentRef = document;
  walk(domRoot.children, (el) => { el.ownerDocument = document; });

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

// ── 页面资源：B22 后源码在 panel/public/css、panel/public/js ─────────────────
// 测试的「源码数据源」= HTML 内联文本 + 外链文件文本；断言本身一条不动。
const PUBLIC_DIR = new URL('../panel/public/', import.meta.url);

function attrOf(tag, name) {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return m ? (m[1] ?? m[2] ?? m[3]) : null;
}

function isExternal(ref) {
  return /^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith('//');
}

/** 页面里的内联 <style> 文本（按文档顺序拼接）。 */
export function inlineStyleText(html) {
  return [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join('\n');
}

/** <link rel="stylesheet" href="..."> 指向的 panel/public/*.css 文件文本（按文档顺序）。 */
export function linkedStyleText(html) {
  const out = [];
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    if (!/\brel\s*=\s*("stylesheet"|'stylesheet'|stylesheet)/i.test(tag)) continue;
    const href = attrOf(tag, 'href');
    if (!href || isExternal(href)) continue;
    try { out.push(fs.readFileSync(new URL(href, PUBLIC_DIR), 'utf8')); } catch { /* 缺失文件跳过 */ }
  }
  return out.join('\n');
}

/**
 * 合并后的页面样式数据源：HTML 内联 <style> + 所有外链样式表。
 * B22 后样式在 panel/public/css/*.css；用它替换旧的「只取内联」实现，
 * 断言的正则/花括号解析完全不变。
 */
export function styleText(html) {
  return inlineStyleText(html) + '\n' + linkedStyleText(html);
}

/** 脚本源码数据源：HTML 文本 + 所有外链 js 文件（供「源码里必须有 X」类断言用）。 */
export function pageSource(html) {
  const out = [html];
  for (const m of html.matchAll(/<script\b[^>]*>/gi)) {
    const src = attrOf(m[0], 'src');
    if (!src || isExternal(src)) continue;
    try { out.push(fs.readFileSync(new URL(src, PUBLIC_DIR), 'utf8')); } catch { /* 缺失文件跳过 */ }
  }
  return out.join('\n');
}

/** 取页面脚本（外链 + 内联，按文档顺序）。 */
function collectScripts(html) {
  const out = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    const src = attrOf(m[1] || '', 'src');
    if (src) out.push({ src: isExternal(src) ? null : src });
    else out.push({ code: m[2] });
  }
  return out;
}

/** 用 DOM 垫片执行页面脚本：外链 js 先按文档顺序跑，HTML 内联引导块随后跑，同一个 vm context。 */
export async function runInlineScript(html, shim) {
  const { default: vm } = await import('node:vm');
  const scripts = collectScripts(html);
  assertAtLeastOne(scripts.filter((s) => s.code !== undefined));
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
  for (const s of scripts) {
    if (s.code !== undefined) {
      vm.runInContext(s.code, context, { filename: 'inline-script.js' });
    } else if (s.src) {
      const file = new URL(s.src, PUBLIC_DIR);
      vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: String(file) });
    }
  }
  return context;
}

function assertAtLeastOne(scripts) {
  if (scripts.length === 0) throw new Error('页面里没有内联 <script>：CSP 相关测试的前提不成立');
}
