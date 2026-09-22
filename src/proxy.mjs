// 反代转发：流式透传 + 背压 + 上游失败换号重试（SPEC §7）
import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';
import { redact } from './log.mjs';
import { isQuotaError, isCreditsExhausted, quotaWindowHint } from './scheduler.mjs';

// 只把这些下游请求头转给上游；authorization / x-api-key 一律替换，绝不透传
const PASSTHROUGH_HEADERS = ['content-type', 'accept', 'x-session-id'];
// 上游响应头白名单
const FORWARD_RESPONSE_HEADERS = ['content-type', 'cache-control', 'retry-after', 'x-request-id'];
const UPSTREAM_UA = 'commandcode-cli/1.53.1';
const ERROR_BODY_CAP = 1024 * 1024;

/**
 * B11：透传伪账号统一归到固定桶，不按客户端自造的 key 建独立统计条目。
 *
 * 透传时 keyId 完全由客户端自选（任何 user_* 串），按它建统计会让 stats.byAccount
 * 随请求数线性增长 —— 进程内存、data/state.json、匿名可读的 /api/status 全被撑大。
 * 固定桶保证 statusView() 的输出大小只与池内账号数成正比。
 */
export const PASSTHROUGH_STATS_KEY = '__passthrough__';

/** 统计条目的键：透传伪账号 → 固定桶；真实账号 → keyId。 */
function statsKeyOf(acct) {
  if (!acct) return PASSTHROUGH_STATS_KEY;
  return acct.__passthrough ? PASSTHROUGH_STATS_KEY : acct.keyId;
}

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

/**
 * 流式把上游响应边收边转；下游写阻塞时暂停读上游，drain 再恢复。
 *
 * 必须区分「正常结束」与「提前关闭」：'end' 才是上游把响应完整发完；
 * 半路 'close'/'error'（上游重启、网络抖动、内核被 OOM kill）说明**响应被截断**。
 * 历史 bug：把 destroy() 触发的 'close' 也当成正常结束 → 网关把半截字节 res.end()
 * 收尾，分块传输「正常」结束，客户端看到完整的 200 SSE 但回答被静默截断。
 *
 * 返回的 Promise resolve(true) = 正常结束，resolve(false) = 提前中断（调用方负责收尾）。
 */
function pipeResponse(upstreamRes, res, { onChunk, log, secrets }) {
  return new Promise((resolve, reject) => {
    let done = false;
    let offAll = () => {};
    const finish = (ended, err) => {
      if (done) return;
      done = true;
      offAll();
      err ? reject(err) : resolve(ended);
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
    // 'end' = 上游把响应体完整发完（唯一的「成功」信号）
    const onEnd = () => finish(true);
    const onErr = (e) => {
      log?.warn?.(`上游响应中断: ${redact(e?.message ?? String(e), secrets)}`);
      finish(false, e);
    };
    // 'close' 兜底：被 destroy() 的流不会发 'end'，只发 'close'，
    // 不处理会让 await 永远挂着、在途计数泄漏；但它**不是**成功（ended=false）。
    const onClose = () => finish(false);
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
      // complete 也置真：流已经停了，后面的字节没人会再读，绝不能当成「还能重放完整 body」。
      state.complete = true;
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
      state.complete = true;   // 与 onData 同理：不许被当成可重放的完整 body
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
        // 关键：超限后既不缓冲也不重放，必须置 complete，
        // 否则重试分支会以为「已完整收到」而给上游发空体（用户拿到与请求无关的成功响应）。
        bodyState.complete = true;
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

export function createProxy({ config, scheduler, log, stats, secrets = [], refreshAccount, touchActivity, persistState } = {}) {
  const maxBodyBytes = config.maxBodyBytes ?? 20 * 1024 * 1024;
  // 客户端中止计数（F10）：不计入 errors，单独展示，保证错误率口径真实
  if (typeof stats.aborted !== 'number') stats.aborted = 0;
  // 在途请求上限（F18）：单进程内存有限，无上限时并发大上传会把容器打爆
  const maxInflight = Number(config.maxInflight) > 0 ? Number(config.maxInflight) : 8;
  let inflight = 0;
  const base = new URL(config.upstreamProxyUrl);
  const upstreamTimeoutMs = config.upstreamTimeoutMs ?? 300000;

  /**
   * 重试时挑一个不同的可用账号（B6）。
   *
   * 历史 bug：只按池内顺序取第一个可用账号（accounts.find），绕过 rank()/打分的并发分摊 ——
   * 池内顺序靠前、只剩 10% 额度的账号会被反复选中，而剩 100% 的被跳过，与「减少账号集中
   * 耗尽」的目标相反。改用与 select() 相同的打分/排序（scheduler.rank），排除当前账号取最高分。
   * 找不到时返回 null，保持调用方的 null 语义（单账号池不变成 502）。
   */
  function pickRetryAccount(prev) {
    const now = Date.now();
    const candidates = scheduler.accounts.filter((a) => a.keyId !== prev.keyId && scheduler.isAvailable(a, now));
    if (candidates.length === 0) return null;
    return scheduler.rank(candidates, now)[0] ?? null;
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
  async function forward({ req, res, account, pathname, search = '', initialChunks = [], bodyEnded = false, sessionId = null }) {
    // 客户端在转发前就断了：不占用账号、不计数，直接放弃
    if (req.destroyed && !req.readableEnded) {
      log?.warn?.('客户端在转发前已断开，放弃本次请求');
      return;
    }
    // 在途上限（F18）：每个在途请求都会驻留最多 maxBodyBytes 的重试缓冲，
    // 无上限时并发大上传会把网关容器（mem_limit 256m）打爆。
    if (inflight >= maxInflight) {
      log?.warn?.(`在途请求已达上限 ${maxInflight}，拒绝新请求`);
      res.setHeader('retry-after', '1');
      return sendJSON(res, 503, { error: { message: 'Gateway busy, retry later', type: 'overloaded' } });
    }
    inflight++;
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
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

    // 单独记某账号的一次尝试失败：换号重试时原账号的这次尝试也算它的错误，
    // 但**只计账号维度**，不进全局 total/errors —— 一个客户端请求只占一行统计。
    // 注意这里**不加 globalErrors**：全局 stats.errors 没为它加过，删账号时也不能从全局扣。
    // 显式把 globalErrors 落成数字（哪怕 0）：pruneState 才分得清「老版本留下的数据」
    // 与「新数据但确实没有全局贡献」，否则会退化成按 errors 全额扣（审查#15）。
    const bumpAccountError = (acct) => {
      const s = accountStatsOf(acct);
      s.errors++;
      s.globalErrors = Number.isFinite(s.globalErrors) ? s.globalErrors : 0;
    };

    const accountStatsOf = (acct) => stats.byAccount[statsKeyOf(acct)]
      ?? (stats.byAccount[statsKeyOf(acct)] = { requests: 0, errors: 0, tokens: 0, aborted: 0 });

    /**
     * 全局统计只记一次（一个客户端请求 == 一行）：err 为真才算错误，
     * 换号过程中的内部失败绝不能重复累加全局 errors（历史上会出现 errors > total）。
     */
    const bump = (err) => {
      try { touchActivity?.(); } catch { /* 活动标记失败不影响转发 */ }
      stats.total++;
      const s = accountStatsOf(account);
      s.requests++;
      if (err) {
        s.errors++;
        stats.errors++;
        // 审查#15：记下「这账号有多少错误计入了全局 stats.errors」。
        // pruneState 删账号时只扣这一部分 —— 换号重试产生的账号级错误（见 bumpAccountError）
        // 从没进过全局，按 s.errors 全额扣会把全局错误统计改错。
        s.globalErrors = (Number.isFinite(s.globalErrors) ? s.globalErrors : 0) + 1;
      }
      stats.totalTokens += tokens;
      s.tokens += tokens;
    };

    /**
     * 客户端主动中止（长回答被 Ctrl-C，很常见）既不是成功也不是上游错误：
     * 单独计数，不污染错误率（历史 bug：中止被当成成功，系统性低估错误率）。
     */
    const bumpAborted = () => {
      try { touchActivity?.(); } catch { /* 同上 */ }
      stats.total++;
      if (typeof stats.aborted !== 'number') stats.aborted = 0;
      stats.aborted++;
      const s = accountStatsOf(account);
      s.requests++;
      if (typeof s.aborted !== 'number') s.aborted = 0;
      s.aborted++;
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
          // 请求体的处置必须先于换号：
          //  - 客户端中途断了（bodyState.error === null）→ 重放只会发残缺 body，宁可 502
          //  - 超限（tooLarge）→ 明确 413，不能给上游发空体
          if (hasBody && bodyState && (bodyState.error || bodyState.tooLarge)) {
            const tooLarge = bodyState.tooLarge || bodyState.error?.code === 'BODY_TOO_LARGE';
            bump(true);
            bodyState.stop?.();
            if (tooLarge) {
              return sendJSON(res, 413, { error: { message: 'Payload too large', type: 'invalid_request_error' } });
            }
            return sendJSON(res, 502, { error: { message: 'Client aborted before request body was fully read', type: 'upstream_error' } });
          }
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
          } else if (bodyState?.complete && !bodyState?.tooLarge && !bodyState?.error) {
            upstreamReq.end(bodyState.bytes());
          } else {
            // 走到这里说明 body 没能完整拿到：绝不给上游发空体（那会让用户拿到与请求无关的「成功」）
            clientGone.signal.removeEventListener('abort', abortEarly);
            release();
            bodyState?.stop?.();
            bump(!!bodyState?.error);
            return sendJSON(res, 502, { error: { message: 'Upstream request failed', type: 'upstream_error' } });
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
          if (retryable && attempt === 0 && !res.headersSent && !current.__passthrough) {
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
        if (status >= 500 && attempt === 0 && !res.headersSent && !current.__passthrough) {
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
          if (isCreditsExhausted(status, text)) {
            // 余额不足是账号级状态（与 5h 窗口无关，钱不会自己回来）：
            // ① 标记后该账号立刻退出调度，面板显示「余额不足」而不是「可用」；
            // ② 未写出任何字节时换号重试 —— 否则轮到这种号就白给客户端一个 400。
            // 实测：主号 HTTP 400 insufficient credits，网关原来把它当普通 4xx 透传。
            scheduler.markCreditsExhausted(current);
            log?.warn?.(`账号「${current.name}」余额不足，已停止调度（充值或周期刷新后自动恢复）`);
            if (attempt === 0 && !res.headersSent && !current.__passthrough) {
              release();
              bodyState?.stop?.();
              if (hasBody && !bodyState?.complete) await drainRemaining(req, bodyState, maxBodyBytes).catch(() => {});
              attempt++;
              continue;
            }
          } else if (isQuotaError(status, text)) {
            // 只有明确额度语义（quota / windowLimits / 周期额度）才暂停；
            // 暂停到**实际耗尽窗口**的 resetAt（weekly 就按周窗口，不再一律扣 5h）
            const windowHint = quotaWindowHint(text);
            const wasPaused = scheduler.runtime(current).pausedUntil > Date.now();
            const until = scheduler.pauseForQuota(current, Date.now(), windowHint);
            // B9：暂停只存在内存时会丢（重启/崩溃后 state.json 里仍是旧状态，账号立刻
            // 重新参与调度、再撞一次同样的错，面板也看不到本次暂停原因）→ 触发一次落盘。
            // 只在状态**发生变化**时写（本来就在暂停中的重复错误不写盘），热路径不放大 IO。
            if (!wasPaused && !current.__passthrough) {
              try { persistState?.(); } catch { /* 落盘失败不影响响应 */ }
            }
            log?.warn?.(`账号「${current.name}」额度耗尽（${windowHint ?? '按最受限窗口'}），暂停到 ${new Date(until).toISOString()}`);
            scheduler.recordError(current, '额度耗尽');
            if (refreshAccount) await refreshAccount(current).catch(() => {});
            // 审查 A1：池里还有健康账号时不能让客户端白吃一个 429/402 —— 与「余额不足」
            // 同路径换号重试一次（必须先确认确实存在下一个可用账号，否则单账号池会变成 502）。
            // 严格条件：attempt===0 且未写出任何字节，绝不能在有字节已下发时重试。
            if (attempt === 0 && !res.headersSent && !current.__passthrough && pickRetryAccount(current)) {
              release();
              bodyState?.stop?.();
              if (hasBody && !bodyState?.complete) await drainRemaining(req, bodyState, maxBodyBytes).catch(() => {});
              attempt++;
              continue;
            }
          } else if (status === 429) {
            // 普通限流：只短暂冷却（默认 60s），绝不是 5 小时停用。
            // 历史 bug：`"Rate limit exceeded"` 命中了 /limit|exceeded/ → 账号被误判额度耗尽。
            const until = scheduler.markRateLimited(current);
            log?.warn?.(`账号「${current.name}」被上游限流，冷却到 ${new Date(until).toISOString()}`);
            scheduler.recordError(current, `上游 HTTP 429（限流，冷却 60 秒）`);
          } else {
            scheduler.recordError(current, `上游 HTTP ${status}`);
            // 401/403：key 被吊销/权限不对 → 立刻停止调度该账号，不再把 401 透传给客户端
            if (status === 401 || status === 403) {
              scheduler.markAuthInvalid(current, `上游 HTTP ${status}`);
              log?.warn?.(`账号「${current.name}」鉴权失效（HTTP ${status}），已停止调度`);
              if (refreshAccount) refreshAccount(current).catch(() => {});
            }
          }
          bump(true);
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
        res.writeHead(status, outHeaders);

        const abortUpstream = () => {
          upstreamRes.destroy();
          upstreamReq.destroy(Object.assign(new Error('客户端断开'), { code: 'CLIENT_ABORT' }));
        };
        clientGone.signal.removeEventListener('abort', abortEarly);
        clientGone.signal.addEventListener('abort', abortUpstream);
        if (clientGone.signal.aborted) abortUpstream();
        const completed = await pipeResponse(upstreamRes, res, {
          onChunk: (c) => { tokens = Math.max(tokens, extractTokens(c.toString('utf8'))); },
          log,
          secrets,
        }).catch(() => false);
        clientGone.signal.removeEventListener('abort', abortUpstream);

        if (!completed) {
          // 客户端主动中止：单独计数，既不算成功也不算上游失败（否则错误率被系统性低估）
          if (clientGone.signal.aborted) {
            scheduler.recordError(current, '客户端中止');
            release();
            bumpAborted();
            return;
          }
          // 上游把响应发了一半就断了：已写出的字节注定不完整 → res.destroy() 让下游
          // 立刻看到连接异常（绝不用 res.end() 把半截内容当完整 200 收尾）。
          scheduler.recordError(current, '上游响应中断');
          release();
          if (res.headersSent) {
            // 已经向客户端写出（可能只写出响应头）→ 必须让下游看到连接异常，
            // 否则半截内容会被当成一个「完整的 200」。
            try { res.destroy(); } catch { /* 忽略 */ }
          } else {
            sendJSON(res, 502, { error: { message: 'Upstream response interrupted', type: 'upstream_error' } });
          }
          bump(true);
          return;
        }

        if (!res.writableEnded && !res.destroyed) res.end();
        release();
        // 换号成功后把粘性指到真正服务本次请求的账号，否则同 session 的下个请求又粘回坏账号
        if (sessionId && attempt > 0) {
          try { scheduler.setAffinity(sessionId, current.keyId, Date.now()); } catch { /* 粘性失败不影响响应 */ }
        }
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
      inflight = Math.max(0, inflight - 1);
      req.off('aborted', onClientGone);
      res.off('close', onClientGone);
    }
  }

  return { forward, sendJSON, inflightCount: () => inflight, maxInflight };
}
