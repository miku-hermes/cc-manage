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
export async function startTestGateway({ accounts, keys, config = {}, plans, behavior, rootDir, noTimers = true, now } = {}) {
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
    now,
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
