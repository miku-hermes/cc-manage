// 余额见底时的「主动探针」：打一发 1 token 的最小推理，用上游的回答定论。
//
// 为什么需要它：网关对「余额不足」的识别是**被动**的 —— 只有真实请求撞上去
// 才会发现。于是出现用户看到的现象：账号其实已经不能用了（实测主号余额
// $0.098，任何模型都回 400 insufficient credits），面板却还写着「可用」，
// 因为还没有请求轮到它。
//
// 为什么不直接比阈值：上游的「够不够用」规则不公开（实测 $0.098 付不起一个
// max_tokens=16 的请求，而该账号平均每请求只花 $0.0016，所以不是简单的
// 「余额 > 本次花费」）。任何我们自己拍的阈值都可能误判。探针把判定权交回
// 上游：阈值只决定**什么时候去问**，不决定结论。
import { isCreditsExhausted } from './scheduler.mjs';

export const DEFAULT_PROBE_MODEL = 'deepseek/deepseek-v4-flash';

/**
 * 探一发最小推理，判断账号还有没有钱。
 * 永不抛错。只有收到上游明确的余额不足才算「没钱」；其它错误（套餐不含该模型、
 * 5xx、超时）一律返回 ok:false + 原因，**绝不据此判定账号没钱**。
 *
 * @param {string} key 账号 key
 * @param {{ baseUrl: string, model?: string, timeoutMs?: number, fetchImpl?: Function }} opts
 *        baseUrl 指向 commandcode-proxy 内核（它负责 CC 线上协议转译）
 * @returns {Promise<{ ok: boolean, insufficientCredits: boolean, status?: number, error?: string, model?: string }>}
 */
export async function probeAccountCredits(key, opts = {}) {
  const baseUrl = String(opts.baseUrl ?? '').replace(/\/+$/, '');
  if (!baseUrl) return { ok: false, insufficientCredits: false, error: '未配置探测地址' };
  const model = opts.model || DEFAULT_PROBE_MODEL;
  const timeoutMs = opts.timeoutMs ?? 20000;
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (timer.unref) timer.unref();
  try {
    const res = await doFetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        stream: false,
        max_tokens: 1,                     // 只花 1 个输出 token：判定成本可以忽略
        messages: [{ role: 'user', content: 'ping' }],
      }),
      signal: controller.signal,
    });
    const text = await res.text().catch(() => '');
    if (isCreditsExhausted(res.status, text)) {
      return { ok: false, insufficientCredits: true, status: res.status, model, error: '上游报余额不足' };
    }
    if (res.status >= 200 && res.status < 300) return { ok: true, insufficientCredits: false, status: res.status, model };
    return { ok: false, insufficientCredits: false, status: res.status, model, error: `HTTP ${res.status}` };
  } catch (e) {
    const aborted = e?.name === 'AbortError' || e?.code === 'ABORT_ERR';
    return { ok: false, insufficientCredits: false, error: aborted ? `探测超时（>${timeoutMs}ms）` : (e?.message ?? String(e)) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 该不该给这个账号做探针？—— 只看「余额是不是快见底了」。
 * belowThreshold（官方标记）为真时一定探；否则余额低于 floor 时探。
 * 注意：这里判的是「要不要去问」，不是「能不能用」。
 */
export function shouldProbeCredits(snapshot, floorUsd) {
  if (!snapshot?.ok) return false;
  if (snapshot.belowThreshold === true) return true;
  const remaining = Number(snapshot.remaining);
  const floor = Number(floorUsd);
  if (!Number.isFinite(remaining) || !Number.isFinite(floor) || floor <= 0) return false;
  return remaining < floor;
}
