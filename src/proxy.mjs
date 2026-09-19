// 反代转发：流式透传 + 背压 + 上游失败换号重试（SPEC §7）
import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';
import { redact } from './log.mjs';
import { isQuotaError } from './scheduler.mjs';

// 只把这些下游请求头转给上游；authorization / x-api-key 一律替换，绝不透传
const PASSTHROUGH_HEADERS = ['content-type', 'accept', 'x-session-id'];
// 上游响应头白名单
const FORWARD_RESPONSE_HEADERS = ['content-type', 'cache-control', 'retry-after', 'x-request-id'];
const UPSTREAM_UA = 'commandcode-cli/1.53.1';
const ERROR_BODY_CAP = 1024 * 1024;

function clientFor(url) {
  return url.protocol === 'https:' ? https : http;
}

/** 读完整响应体（仅用于错误路径，便于脱敏后回给客户端）。 */
function readBody(stream, cap = ERROR_BODY_CAP) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    const done = () => resolve(Buffer.concat(chunks));
    stream.on('data', (c) => {
      if (size < cap) {
        chunks.push(c);
        size += c.length;
      }
    });
    stream.on('end', done);
    stream.on('close', done);
    stream.on('error', done);
  });
}

// 从流式片段里粗粒度提取 token 用量（finish 事件的 totalUsage）。
// 上游字段命名不统一：既有驼峰 totalTokens/outputTokens，也有下划线 total_tokens/output_tokens。
const TOTAL_TOKEN_RE = /"(?:totalTokens|total_tokens)"\s*:\s*(\d+)/g;
const OUTPUT_TOKEN_RE = /"(?:outputTokens|output_tokens)"\s*:\s*(\d+)/g;
const PROMPT_TOKEN_RE = /"(?:promptTokens|prompt_tokens)"\s*:\s*(\d+)/g;
const COMPLETION_TOKEN_RE = /"(?:completionTokens|completion_tokens)"\s*:\s*(\d+)/g;

function maxMatched(re, text) {
  let max = 0;
  let m;
  re.lastIndex = 0;
  while ((m = re.exec(text)) !== null) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max;
}

/**
 * 单块文本里的 token 数：优先 total，其次 output，最后用 prompt + completion 求和兜底。
 * 流式分块里 total 是累加值，调用方对多次提取结果取最大值即为最终值。
 */
export function extractTokens(text) {
  const total = maxMatched(TOTAL_TOKEN_RE, text);
  if (total > 0) return total;
  const output = maxMatched(OUTPUT_TOKEN_RE, text);
  if (output > 0) return output;
  return maxMatched(PROMPT_TOKEN_RE, text) + maxMatched(COMPLETION_TOKEN_RE, text);
}

/** 流式把上游响应边收边转；下游写阻塞时暂停读上游，drain 再恢复。 */
function pipeResponse(upstreamRes, res, { onChunk, log, secrets }) {
  return new Promise((resolve, reject) => {
    let done = false;
    let offAll = () => {};
    const finish = (err) => {
      if (done) return;
      done = true;
      offAll();
      err ? reject(err) : resolve();
    };
    const onData = (chunk) => {
      try {
        onChunk?.(chunk);
      } catch { /* 统计失败不影响转发 */ }
      if (!res.write(chunk)) {
        upstreamRes.pause();
        res.once('drain', () => upstreamRes.resume());
      }
    };
    const onEnd = () => finish();
    const onErr = (e) => {
      log?.warn?.(`上游响应中断: ${redact(e?.message ?? String(e), secrets)}`);
      finish(e);
    };
    // 'close' 兜底：被 destroy() 的流不会发 'end'，只发 'close'，
    // 不处理会让 await 永远挂着、在途计数泄漏。
    const onClose = () => finish();
    upstreamRes.on('data', onData);
    upstreamRes.on('end', onEnd);
    upstreamRes.on('error', onErr);
    upstreamRes.on('close', onClose);
    offAll = () => {
      upstreamRes.off('data', onData);
      upstreamRes.off('end', onEnd);
      upstreamRes.off('error', onErr);
      upstreamRes.off('close', onClose);
    };
  });
}

/**
 * 把下游请求体边流式转发给 upstreamReq、边 tee 进内存（受 maxBodyBytes 限制）。
 * 返回 { buffer, complete }：complete=false 表示中途因响应到达/出错而中止。
 */
function pipingBody(req, upstreamReq, maxBodyBytes, initialChunks = [], alreadyEnded = false) {
  const state = { chunks: [], size: 0, complete: false, tooLarge: false, error: null };
  state.stop = () => {
    req.off('data', onData);
    req.off('end', onEnd);
    req.off('error', onError);
  };
  function onData(chunk) {
    state.size += chunk.length;
    if (state.size > maxBodyBytes) {
      state.tooLarge = true;
      state.error = Object.assign(new Error(`请求体超过上限 ${maxBodyBytes} 字节`), { code: 'BODY_TOO_LARGE' });
      state.stop();
      upstreamReq.destroy(state.error);
      return;
    }
    state.chunks.push(chunk);
    if (!upstreamReq.write(chunk)) {
      req.pause();
      upstreamReq.once('drain', () => req.resume());
    }
  }
  function onEnd() {
    state.complete = true;
    state.stop();
    upstreamReq.end();
  }
  function onError(e) {
    state.error = e;
    state.stop();
  }
  // 预读的头部片段（网关为了从 body 里取 session id 而 peek 的部分）先写出去
  for (const c of initialChunks) {
    state.size += c.length;
    if (state.size > maxBodyBytes) {
      state.tooLarge = true;
      state.error = Object.assign(new Error(`请求体超过上限 ${maxBodyBytes} 字节`), { code: 'BODY_TOO_LARGE' });
      upstreamReq.destroy(state.error);
      state.bytes = () => Buffer.concat(state.chunks);
      return state;
    }
    state.chunks.push(c);
    upstreamReq.write(c);
  }
  // 请求体已经读完（或被客户端中途掐断）→ 立刻结束上游请求，绝不能让上游干等
  if (alreadyEnded || req.readableEnded || req.destroyed) {
    state.complete = true;
    upstreamReq.end();
    state.bytes = () => Buffer.concat(state.chunks);
    return state;
  }
  req.on('data', onData);
  req.on('end', onEnd);
  req.on('error', onError);
  req.once('aborted', () => {
    state.stop();
    upstreamReq.end();
  });
  // 网关可能为了取 session id 而 pause 过请求流，这里显式恢复
  req.resume();
  state.bytes = () => Buffer.concat(state.chunks);
  return state;
}

/** 上游已响应/已放弃时，把下游剩余请求体排空进 buffer（为重试重放做准备）。 */
function drainRemaining(req, bodyState, maxBodyBytes) {
  return new Promise((resolve) => {
    const onData = (chunk) => {
      bodyState.size += chunk.length;
      if (bodyState.size > maxBodyBytes) {
        bodyState.tooLarge = true;
        req.off('data', onData);
        req.resume();
        resolve();
        return;
      }
      bodyState.chunks.push(chunk);
    };
    req.on('data', onData);
    req.once('end', () => {
      req.off('data', onData);
      bodyState.complete = true;
      resolve();
    });
    req.once('error', () => {
      req.off('data', onData);
      resolve();
    });
    setTimeout(resolve, 1000).unref?.();
  });
}

export function createProxy({ config, scheduler, log, stats, secrets = [], refreshAccount } = {}) {
  const maxBodyBytes = config.maxBodyBytes ?? 20 * 1024 * 1024;
  const base = new URL(config.upstreamProxyUrl);
  const upstreamTimeoutMs = config.upstreamTimeoutMs ?? 300000;

  /** 重试时挑一个不同的可用账号 */
  function pickRetryAccount(prev) {
    const now = Date.now();
    return scheduler.accounts.find((a) => a.keyId !== prev.keyId && scheduler.isAvailable(a, now)) ?? null;
  }

  function sendJSON(res, status, obj) {
    if (res.writableEnded || res.headersSent) return;
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(obj));
  }

  /**
   * 转发一次请求（含最多一次换号重试）。
   * @param {{req, res, account, pathname, search}} opts
   */
  async function forward({ req, res, account, pathname, search = '', initialChunks = [], bodyEnded = false }) {
    // 客户端在转发前就断了：不占用账号、不计数，直接放弃
    if (req.destroyed && !req.readableEnded) {
      log?.warn?.('客户端在转发前已断开，放弃本次请求');
      return;
    }
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
    let wroteBytes = false;
    let acquired = false;
    let tokens = 0;

    const acquire = () => {
      if (!acquired) {
        acquired = true;
        scheduler.acquire(account);
      }
    };
    const release = () => {
      if (acquired) {
        acquired = false;
        scheduler.release(account);
      }
    };

    // 单独记某账号的一次失败（换号重试时，原账号的那次尝试也要算进它的错误数）
    const bumpAccountError = (acct) => {
      const s = stats.byAccount[acct.keyId] ?? (stats.byAccount[acct.keyId] = { requests: 0, errors: 0, tokens: 0 });
      s.errors++;
      stats.errors++;
    };

    const bump = (err) => {
      stats.total++;
      const s = stats.byAccount[account.keyId] ?? (stats.byAccount[account.keyId] = { requests: 0, errors: 0, tokens: 0 });
      s.requests++;
      if (err) {
        s.errors++;
        stats.errors++;
      }
      stats.totalTokens += tokens;
      s.tokens += tokens;
    };

    const clientGone = new AbortController();
    const onClientGone = () => clientGone.abort();
    req.once('aborted', onClientGone);
    res.once('close', onClientGone);

    let attempt = 0;
    let bodyState = hasBody
      ? null
      : { chunks: [], size: 0, complete: true, tooLarge: false, error: null, bytes: () => Buffer.alloc(0) };

    try {
      // 循环：attempt 0 用选中账号；失败且未写出字节时 attempt 1 换号
      while (true) {
        let current = account;
        if (attempt > 0) {
          const next = pickRetryAccount(account);
          if (!next) {
            bump(true);
            log?.error?.('无可用账号可重试');
            return sendJSON(res, 502, { error: { message: 'No available account', type: 'upstream_error' } });
          }
          log?.warn?.(`上游失败，换号重试: ${account.name} → ${next.name}`);
          current = next;
          account = next;
        }

        acquire();
        const target = new URL(base.href);
        target.pathname = pathname;
        target.search = search;

        const headers = { authorization: `Bearer ${current.key}`, 'user-agent': UPSTREAM_UA };
        for (const h of PASSTHROUGH_HEADERS) {
          const v = req.headers[h];
          if (v !== undefined) headers[h] = Array.isArray(v) ? v.join(', ') : v;
        }
        headers['user-agent'] = UPSTREAM_UA;
        if (!headers.accept) headers.accept = 'application/json';

        const upstreamReq = clientFor(target).request(target, { method: req.method, headers });

        // 客户端断开 → 立刻 abort 上游（连接阶段就挂上，不能等响应头）
        const abortEarly = () => upstreamReq.destroy(Object.assign(new Error('客户端断开'), { code: 'CLIENT_ABORT' }));
        clientGone.signal.addEventListener('abort', abortEarly);

        let upstreamRes = null;
        let connError = null;
        const responseP = new Promise((resolve) => {
          let settled = false;
          const settle = (r) => { if (!settled) { settled = true; resolve(r); } };
          upstreamReq.once('response', (r) => { upstreamRes = r; settle(r); });
          upstreamReq.once('error', (e) => { connError = e; settle(null); });
          // destroy() 不一定触发 'error'，用 'close' 兜底，否则这里会永久挂住
          upstreamReq.once('close', () => settle(upstreamRes ?? null));
          upstreamReq.setTimeout(upstreamTimeoutMs, () => {
            upstreamReq.destroy(Object.assign(new Error('上游超时'), { code: 'UPSTREAM_TIMEOUT' }));
          });
        });

        // 请求体：首次流式 tee；重试时用 buffer 重放
        if (hasBody) {
          if (attempt === 0) {
            bodyState = pipingBody(req, upstreamReq, maxBodyBytes, initialChunks, bodyEnded);
          } else if (bodyState?.complete) {
            upstreamReq.end(bodyState.bytes());
          } else {
            upstreamReq.end();
          }
        } else {
          upstreamReq.end();
        }

        upstreamRes = await responseP;

        // 连接层失败
        if (!upstreamRes) {
          clientGone.signal.removeEventListener('abort', abortEarly);
          release();
          const code = connError?.code;
          const retryable = code !== 'BODY_TOO_LARGE' && !clientGone.signal.aborted;
          if (code === 'BODY_TOO_LARGE' || bodyState?.tooLarge) {
            bump(true);
            bodyState?.stop?.();
            return sendJSON(res, 413, { error: { message: 'Payload too large', type: 'invalid_request_error' } });
          }
          scheduler.recordError(current, connError?.message ?? String(connError));
          if (retryable && attempt === 0 && !wroteBytes && !current.__passthrough) {
            bumpAccountError(current);
            bodyState?.stop?.();
            if (hasBody && !bodyState?.complete) await drainRemaining(req, bodyState, maxBodyBytes).catch(() => {});
            attempt++;
            continue;
          }
          bump(true);
          return sendJSON(res, 502, { error: { message: 'Upstream request failed', type: 'upstream_error' } });
        }

        const status = upstreamRes.statusCode ?? 502;

        // 5xx：未向客户端写字节则可换号一次
        if (status >= 500 && attempt === 0 && !wroteBytes && !current.__passthrough) {
          clientGone.signal.removeEventListener('abort', abortEarly);
          await readBody(upstreamRes);
          release();
          bodyState?.stop?.();
          if (hasBody && !bodyState?.complete) await drainRemaining(req, bodyState, maxBodyBytes).catch(() => {});
          scheduler.recordError(current, `上游 HTTP ${status}`);
          bumpAccountError(current);
          attempt++;
          continue;
        }

        // 4xx / 额度类错误：缓冲 body、脱敏后原样回传状态码
        if (status >= 400) {
          clientGone.signal.removeEventListener('abort', abortEarly);
          const buf = await readBody(upstreamRes);
          const text = buf.toString('utf8');
          if (isQuotaError(status, text)) {
            const until = scheduler.pauseForQuota(current);
            log?.warn?.(`账号「${current.name}」额度耗尽，暂停到 ${new Date(until).toISOString()}`);
            scheduler.recordError(current, '额度耗尽');
            if (refreshAccount) await refreshAccount(current).catch(() => {});
          } else {
            scheduler.recordError(current, `上游 HTTP ${status}`);
          }
          bump(true);
          wroteBytes = true;
          release();
          res.writeHead(status, { 'content-type': upstreamRes.headers['content-type'] ?? 'application/json' });
          res.end(redact(text, secrets));
          return;
        }

        // 正常路径：流式透传（绝不整体缓冲）
        const outHeaders = {};
        for (const h of FORWARD_RESPONSE_HEADERS) {
          if (upstreamRes.headers[h] !== undefined) outHeaders[h] = upstreamRes.headers[h];
        }
        if (!outHeaders['content-type']) outHeaders['content-type'] = 'application/octet-stream';
        wroteBytes = true;
        res.writeHead(status, outHeaders);

        const abortUpstream = () => {
          upstreamRes.destroy();
          upstreamReq.destroy(Object.assign(new Error('客户端断开'), { code: 'CLIENT_ABORT' }));
        };
        clientGone.signal.removeEventListener('abort', abortEarly);
        clientGone.signal.addEventListener('abort', abortUpstream);
        if (clientGone.signal.aborted) abortUpstream();
        try {
          await pipeResponse(upstreamRes, res, {
            onChunk: (c) => { tokens = Math.max(tokens, extractTokens(c.toString('utf8'))); },
            log,
            secrets,
          });
        } catch {
          /* 上游中断：下面统一收尾 */
        } finally {
          clientGone.signal.removeEventListener('abort', abortUpstream);
        }
        if (!res.writableEnded && !res.destroyed) res.end();
        release();
        bump(false);
        return;
      }
    } catch (e) {
      scheduler.recordError(account, e?.message ?? String(e));
      bump(true);
      log?.error?.(`转发异常: ${redact(e?.message ?? String(e), secrets)}`);
      sendJSON(res, 502, { error: { message: 'Gateway error', type: 'upstream_error' } });
    } finally {
      release();
      req.off('aborted', onClientGone);
      res.off('close', onClientGone);
    }
  }

  return { forward, sendJSON };
}
