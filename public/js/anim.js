/* ── 动效工具：数字滚动 count-up（批次 10）─────────────────────────────
   全局函数声明，无 import/export；index.html / admin.html 在 utils 之后、
   render-*.js 之前引入（render-hero.js 的 render / paintKpi 依赖 setNumber）。

   关键契约：不能动画时必须同步写终值。测试的 DOM 垫片只定义了 document.hidden，
   没有 document.visibilityState（undefined），所以 canAnimate() 一律为 false，
   render() 返回后 textContent 必须已经是终值字符串。 */
function prefersReducedMotion() {
  try {
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch (_) { return false; }
}

/** 是否允许 rAF 数字动画：页面可见 + 系统未要求减少动态 + 环境有 rAF。 */
function canAnimate() {
  return typeof requestAnimationFrame === 'function'
    && typeof document !== 'undefined'
    && document.visibilityState === 'visible'
    && !prefersReducedMotion();
}

/* 把 el 的数字从 from 滚到 to；不能动画（或 to 非有限值）时同步写终值。
   fmt 与页面现有格式化函数同签名（money / num）。
   同一元素重入先取消上一个 rAF：句柄存 el.__animId。 */
function setNumber(el, from, to, fmt, dur) {
  if (!el) return;
  const animatable = canAnimate() && Number.isFinite(Number(to));
  if (el.__animId != null) {
    if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(el.__animId);
    el.__animId = null;
  }
  if (!animatable) {
    el.textContent = fmt(to);   // 不能动画：同步写终值（测试与 reduced-motion 走这条）
    return;
  }
  const start = Number.isFinite(Number(from)) ? Number(from) : 0;
  const end = Number(to);
  const span = end - start;
  const ms = Number.isFinite(dur) && dur > 0 ? dur : 0;
  const t0 = performance.now();
  const step = (now) => {
    const p = ms > 0 ? Math.min(1, (now - t0) / ms) : 1;
    if (p >= 1) {
      el.__animId = null;
      el.textContent = fmt(to);   // 结束精确落回终值
      return;
    }
    const eased = 1 - Math.pow(1 - p, 3);   // ease-out
    el.textContent = fmt(start + span * eased);
    el.__animId = requestAnimationFrame(step);
  };
  el.__animId = requestAnimationFrame(step);
}
