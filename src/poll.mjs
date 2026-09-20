// 自适应额度轮询：单个「自调度 setTimeout」+ 活动追踪（见 docs/ADAPTIVE-REFRESH.md）
//
// 设计要点：
// - 只有一个可变量定时器。每次触发后重新计算下一次延迟，避免两个 setInterval 打架。
// - 延迟由「距上次活动多久」决定：活跃窗内 → activeIntervalMs（默认 60s），否则 → idleIntervalMs（默认 300s）。
// - idleIntervalMs <= 0 → 完全不排定时器（保留原有「设 0 关闭轮询」的语义）。
//   activeIntervalMs <= 0 → 退化为纯空闲间隔。
// - 上一轮 run() 还没跑完时，本轮直接跳过，不叠加；isBusy() 还能把「手动刷新正占着」
//   这类外部进行中的刷新也算进来。
// - 定时器 unref()，不阻止进程退出。

/**
 * @param {{
 *   idleIntervalMs?: number, activeIntervalMs?: number, activeWindowMs?: number,
 *   run: () => any,
 *   now?: () => number, setTimer?: (fn: Function, ms: number) => any, clearTimer?: (h: any) => void,
 *   onError?: (e: Error) => void, isBusy?: () => boolean, log?: object,
 * }} opts
 */
export function createAdaptivePoller({
  idleIntervalMs = 600000,
  activeIntervalMs = 60000,
  activeWindowMs = 300000,
  run,
  now = () => Date.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (h) => clearTimeout(h),
  onError = null,
  isBusy = null,
  log = null,
} = {}) {
  const idle = Number(idleIntervalMs) > 0 ? Number(idleIntervalMs) : 0;
  const active = Number(activeIntervalMs) > 0 ? Number(activeIntervalMs) : 0;
  const windowMs = Math.max(0, Number(activeWindowMs) || 0);

  let timer = null;
  let armedAt = 0;
  let armedDelay = 0;
  let running = false;
  let stopped = true;
  let lastActivityAt = null;
  const stats = { runs: 0, skips: 0, errors: 0 };

  /** idleIntervalMs <= 0 → 轮询完全关闭。 */
  const enabled = () => idle > 0;

  /** 距上次活动是否落在活跃窗内（从未有过活动 → 视为空闲）。 */
  function isActive(at = now()) {
    return active > 0 && lastActivityAt !== null && at - lastActivityAt <= windowMs;
  }

  /** 下一次该等多久：活跃 → activeIntervalMs，否则 → idleIntervalMs。 */
  function nextDelayMs(at = now()) {
    return isActive(at) ? active : idle;
  }

  function clear() {
    if (timer !== null) clearTimer(timer);
    timer = null;
    armedAt = 0;
    armedDelay = 0;
  }

  function arm(rearmIfArmed = false) {
    if (stopped || !enabled()) return;
    if (timer !== null && !rearmIfArmed) return;   // 已有下一拍在排队 → 不动它
    clear();
    armedDelay = nextDelayMs();
    armedAt = now();
    timer = setTimer(() => {
      timer = null;
      armedAt = 0;
      armedDelay = 0;
      tick();
    }, armedDelay);
    timer?.unref?.();
  }

  function tick() {
    if (stopped) return;
    if (running || isBusy?.()) {
      // 上一轮还没跑完（例如手动刷新正占着）→ 跳过本轮，别叠起来；只把下一拍排上
      stats.skips++;
      log?.warn?.('上一轮额度刷新尚未完成，跳过本轮');
      arm();
      return;
    }
    running = true;
    stats.runs++;
    // 先按当前活动情况排上「下一拍的决策点」：这样即使本轮跑得比间隔还久，
    // 到点也会正常触发出上面的「跳过」分支，而不是让定时器空转一整轮。
    arm();
    Promise.resolve()
      .then(run)
      .catch((e) => {
        stats.errors++;
        onError?.(e);
      })
      .finally(() => {
        running = false;
        // 预排的那拍若已被消费（说明本轮超时 → 已计入 skip），就补排；否则按最新活动重排。
        arm(true);
      });
  }

  /**
   * 记录一次代理活动（有请求说明正在被使用）。
   * 若当前排的是更晚的空闲间隔，提前改排到活跃间隔；已经是活跃间隔则不动，
   * 避免持续有流量时把定时器无限往后推。
   */
  function touch(at = now()) {
    lastActivityAt = at;
    if (stopped || !enabled() || running || timer === null) return;
    // 仅在「当前排的是更晚的空闲间隔」时提前改排，避免持续流量把定时器往后推
    if (active > 0 && armedDelay > active && armedAt + armedDelay > at + active) arm(true);
  }

  function start() {
    stopped = false;
    arm();
  }

  function stop() {
    stopped = true;
    clear();
  }

  return {
    start,
    stop,
    touch,
    isActive,
    nextDelayMs,
    stats,
    get enabled() { return enabled(); },
    get running() { return running; },
    get lastActivityAt() { return lastActivityAt; },
    get scheduledDelayMs() { return armedDelay; },
  };
}
