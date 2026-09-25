// ── HTTP：凭证是 HttpOnly session cookie，JS 完全不接触密码/token ──────
async function apiJSON(path, { method = 'GET', body } = {}) {
  const opts = { method, headers: {} };
  if (body !== undefined) { opts.headers['content-type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const r = await fetch(path, opts);
  let data = null;
  try { data = await r.json(); } catch { /* 非 JSON 响应 */ }
  if (!r.ok) {
    // /api/auth/* 的 401 是「密码错」而不是「会话失效」，不要把人踢回登录页
    if (r.status === 401 && !path.startsWith('/api/auth/')) showGate('login');
    const err = new Error((data && data.error && data.error.message) || ('HTTP ' + r.status));
    err.status = r.status;
    err.retryAfterMs = data && data.retryAfterMs;
    throw err;
  }
  return data;
}
