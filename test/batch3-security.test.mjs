// tests-ops#3：x-forwarded-proto 只该在「socket 来源可信」时被采信。
// 匿名请求自己带 X-Forwarded-Proto: https 不该换来 HSTS / Secure cookie。
// 纯函数部分任何环境都能跑；端到端部分在禁止 listen 的沙箱里显式 skip。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allocPort, request, startTestGateway } from './helpers.mjs';
import { isSecureRequest } from '../src/client-ip.mjs';

const USER = { username: 'admin', password: 'hunter2-secret' };
const TRUSTED = ['127.0.0.0/8'];

function sessionCookie(res) {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return list.find((c) => c.startsWith('cc_session=')) ?? '';
}

// ── 纯函数：与 client-ip.mjs / resolveClientIp 同口径 ──────────────────
test('x-forwarded-proto：socket 不在可信代理里时一律不采信', () => {
  const https = { 'x-forwarded-proto': 'https' };
  assert.equal(isSecureRequest({ remoteAddress: '203.0.113.7', headers: https }, TRUSTED), false,
    '匿名来源带 X-Forwarded-Proto: https 不得被当成 HTTPS');
  assert.equal(isSecureRequest({ remoteAddress: '203.0.113.7', headers: https }), false,
    '默认可信集合（回环/私网）也不包含公网来源');
  assert.equal(isSecureRequest({ remoteAddress: undefined, headers: https }, TRUSTED), false, '拿不到 socket 地址时不采信');
});

test('x-forwarded-proto：可信代理来源才采信，语义与之前一致', () => {
  const req = (proto, remoteAddress = '127.0.0.1') => ({ remoteAddress, headers: proto === undefined ? {} : { 'x-forwarded-proto': proto } });
  assert.equal(isSecureRequest(req('https'), TRUSTED), true, '反代（可信）说 https → 采信');
  assert.equal(isSecureRequest(req('https, http'), TRUSTED), true, '多值取第一个');
  assert.equal(isSecureRequest(req('HTTPS '), TRUSTED), true, '大小写/空白容错');
  assert.equal(isSecureRequest(req('http'), TRUSTED), false, '明文不发 HSTS（否则把 HTTP 访问锁死）');
  assert.equal(isSecureRequest(req(undefined), TRUSTED), false, '没有这个头 → false');
  assert.equal(isSecureRequest(req('https', '::ffff:127.0.0.1'), TRUSTED), true, 'IPv4-mapped 回环仍算可信');
  assert.equal(isSecureRequest({ remoteAddress: '127.0.0.1', headers: { 'x-forwarded-proto': ['https'] } }, TRUSTED), true,
    '重复头（数组）取第一个');
});

// ── 端到端：响应头 / cookie ────────────────────────────────────────────
async function listenAllowed() {
  try { await allocPort(); return true; } catch { return false; }
}

test('端到端：不可信来源带 X-Forwarded-Proto: https → 不发 HSTS、cookie 不带 Secure', async (t) => {
  if (!(await listenAllowed())) return t.skip('环境禁止 listen（沙箱 seccomp）');
  // 把可信集合收窄到私网：测试请求来自 127.0.0.1，于是它「不可信」。
  const ctx = await startTestGateway({ config: { trustedProxyCidrs: ['10.0.0.0/8'] } });
  t.after(() => ctx.close());

  const page = await request(`${ctx.baseUrl}/`, { headers: { 'x-forwarded-proto': 'https' } });
  assert.equal(page.status, 200);
  assert.equal(page.headers['strict-transport-security'], undefined, '不可信来源的 x-forwarded-proto 不得换来 HSTS');

  const setup = await request(`${ctx.baseUrl}/api/auth/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-proto': 'https' },
    body: JSON.stringify(USER),
  });
  assert.equal(setup.status, 201);
  const cookie = sessionCookie(setup);
  assert.match(cookie, /HttpOnly/, '正常 cookie 属性不受影响');
  assert.doesNotMatch(cookie, /Secure/, '不可信来源不得让 cookie 变 Secure');
});

test('端到端：可信反代（默认 127.0.0.0/8）带 X-Forwarded-Proto: https → 照旧发 HSTS + Secure', async (t) => {
  if (!(await listenAllowed())) return t.skip('环境禁止 listen（沙箱 seccomp）');
  const ctx = await startTestGateway();   // 默认 trustedProxyCidrs 含 127.0.0.0/8
  t.after(() => ctx.close());

  const page = await request(`${ctx.baseUrl}/`, { headers: { 'x-forwarded-proto': 'https' } });
  assert.match(page.headers['strict-transport-security'] ?? '', /max-age=\d+/, '反代场景不能回归（否则线上 HTTPS 判断失效）');

  const setup = await request(`${ctx.baseUrl}/api/auth/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-proto': 'https' },
    body: JSON.stringify(USER),
  });
  assert.equal(setup.status, 201);
  assert.match(sessionCookie(setup), /Secure/);
});
