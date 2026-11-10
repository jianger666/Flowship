/**
 * 滚动增强的纯逻辑（E2·P5a / C3）：参数规整 + until_stable 驱动循环。
 * 无 Electron / CDP 依赖：页面读写、时钟、取消检查全由调用方注入，单测用假时钟驱动，不必真等。
 */

export const UNTIL_STABLE_MAX_STEPS = 30;
export const UNTIL_STABLE_DEFAULT_STEPS = 10;
export const UNTIL_STABLE_MAX_STEP_TIMEOUT_MS = 5000;
export const UNTIL_STABLE_DEFAULT_STEP_TIMEOUT_MS = 3000;
/**
 * until_stable 的**总时长**硬上限（R6-17）：max_steps(30) × step_timeout_ms(5000) 理论上能跑 150s，远超 server 侧 bridge 的 60s 超时——
 * server 超时后主进程还在滚、占着动作队列和面板锁。总时限 ≤ 45s，给 bridge 超时（55s）留出收尾余量。
 */
export const UNTIL_STABLE_MAX_TOTAL_MS = 45_000;
export const UNTIL_STABLE_MIN_TOTAL_MS = 1000;
/** 连续多少轮「滚到底后高度没再增长」算稳定 */
export const STABLE_ROUNDS = 2;
const POLL_MS = 100;

/** 总时限夹到 [UNTIL_STABLE_MIN_TOTAL_MS, UNTIL_STABLE_MAX_TOTAL_MS]；非有限数 → 上限 */
export const clampTotalMs = (v) => (Number.isFinite(v) ? Math.min(UNTIL_STABLE_MAX_TOTAL_MS, Math.max(UNTIL_STABLE_MIN_TOTAL_MS, Math.round(v))) : UNTIL_STABLE_MAX_TOTAL_MS);

/**
 * scroll op 的参数规整。h = index.mjs 的 OP_HELPERS。
 * 三种模式互斥：
 *  ① 滚动（direction / amount，可带 ref 指定滚动容器）——既有行为；
 *  ② scrollIntoView（必须有 ref，把元素滚到视口中央）；
 *  ③ untilStable（无限滚动辅助，只作用于页面主滚动区）。
 */
export const normalizeScrollArgs = (args, h) => {
  const { bad, isObj } = h;
  const ref = h.optStr(args, "ref", 20);
  const direction = h.optEnum(args, "direction", ["up", "down", "left", "right", "top", "bottom"], undefined);
  const amount = h.optNum(args, "amount", { min: 0, max: 100_000, dflt: undefined });
  const scrollIntoView = h.optBool(args, "scrollIntoView", false);

  let untilStable;
  const raw = args.untilStable;
  if (raw !== undefined && raw !== null && raw !== false) {
    if (raw !== true && !isObj(raw)) throw bad("until_stable 必须是 true 或 {max_steps, step_timeout_ms} 对象");
    const o = raw === true ? {} : raw;
    const num = (key, label, min, max, dflt) => {
      const v = o[key];
      if (v === undefined || v === null) return dflt;
      if (typeof v !== "number" || !Number.isFinite(v) || !Number.isInteger(v)) throw bad(`until_stable.${label} 必须是整数`);
      if (v < min || v > max) throw bad(`until_stable.${label} 必须在 ${min}–${max} 之间，收到 ${v}`);
      return v;
    };
    untilStable = {
      maxSteps: num("maxSteps", "max_steps", 1, UNTIL_STABLE_MAX_STEPS, UNTIL_STABLE_DEFAULT_STEPS),
      stepTimeoutMs: num("stepTimeoutMs", "step_timeout_ms", 100, UNTIL_STABLE_MAX_STEP_TIMEOUT_MS, UNTIL_STABLE_DEFAULT_STEP_TIMEOUT_MS),
    };
    // 总时限（可选）：夹到 [1000, 45000]，不报错——模型写 120000 的本意是「尽量多等」，夹到上限即可；没给就用上限（runUntilStable 兜底）
    if (o.timeoutMs !== undefined && o.timeoutMs !== null) {
      if (typeof o.timeoutMs !== "number" || !Number.isFinite(o.timeoutMs)) throw bad("until_stable.timeout_ms 必须是数字（毫秒）");
      untilStable.timeoutMs = clampTotalMs(o.timeoutMs);
    }
  }

  if (untilStable && scrollIntoView) throw bad("until_stable 与 scroll_into_view 互斥，请二选一");
  if (untilStable && (direction || amount !== undefined)) {
    throw bad("until_stable 会自己反复滚到底，不能再带 direction / amount；只想滚一次请去掉 until_stable");
  }
  if (untilStable && ref) throw bad("until_stable 只作用于页面主滚动区，不能与 ref 同用；要滚某个容器请用 ref + direction");
  if (scrollIntoView) {
    if (!ref) throw bad("scroll_into_view 需要 ref（先 browser_snapshot 取得）");
    if (direction || amount !== undefined) throw bad("scroll_into_view 是把元素滚到视口中央，不能再带 direction / amount");
  }

  return {
    ...(ref ? { ref } : {}),
    ...(direction ? { direction } : {}),
    ...(amount !== undefined ? { amount } : {}),
    ...(scrollIntoView ? { scrollIntoView: true } : {}),
    ...(untilStable ? { untilStable } : {}),
  };
};

/**
 * until_stable 的驱动循环：滚到底 → 在 stepTimeoutMs 内轮询高度是否增长 → 连续 STABLE_ROUNDS 轮没增长就停；到 maxSteps 也停。
 * 不会无限循环：每步等待有上限、总步数有上限；每次轮询前后都过 check()（用户接管 / 取消 / 会话销毁时它会抛）。
 *
 * @param {object} io
 * @param {() => Promise<{ scrollHeight: number, scrollTop: number, clientHeight: number }>} io.measure 只读度量
 * @param {() => Promise<{ scrollHeight: number, scrollTop: number, clientHeight: number }>} io.scrollToBottom 滚到底并返回度量
 * @param {(ms: number) => Promise<void>} io.sleep 可被 signal 打断的 sleep
 * @param {() => number} io.now
 * @param {() => void} io.check 被打断时抛错
 * @param {{ maxSteps: number, stepTimeoutMs: number, timeoutMs?: number }} opts  timeoutMs = 总时限（夹到 ≤45s，缺省 45s），到点以 reason "timeout" 收尾
 */
export const runUntilStable = async (io, { maxSteps, stepTimeoutMs, timeoutMs }) => {
  const started = io.now();
  // 总时限（R6-17）：每一步的等待截止时间也不能越过它，所以无论 max_steps × step_timeout_ms 多大，总时长都 ≤ 上限
  const totalDeadline = started + clampTotalMs(timeoutMs ?? UNTIL_STABLE_MAX_TOTAL_MS);
  let m = await io.measure();
  const heightBefore = m.scrollHeight;
  let steps = 0;
  let quiet = 0;
  let reason = "max_steps";
  while (steps < maxSteps) {
    io.check();
    if (io.now() >= totalDeadline) {
      reason = "timeout";
      break;
    }
    steps += 1;
    m = await io.scrollToBottom();
    const base = m.scrollHeight;
    let grew = false;
    const deadline = Math.min(io.now() + stepTimeoutMs, totalDeadline);
    while (io.now() < deadline) {
      await io.sleep(Math.max(1, Math.min(POLL_MS, deadline - io.now())));
      io.check();
      m = await io.measure();
      if (m.scrollHeight > base) {
        grew = true;
        break;
      }
    }
    quiet = grew ? 0 : quiet + 1;
    if (quiet >= STABLE_ROUNDS) {
      reason = "stable";
      break;
    }
    // 总时限到了而页面还没稳定：如实说是超时（别冒充 max_steps，模型据此决定要不要再滚一次）
    if (io.now() >= totalDeadline) {
      reason = "timeout";
      break;
    }
  }
  return {
    steps,
    heightBefore,
    heightAfter: m.scrollHeight,
    atBottom: m.scrollTop + m.clientHeight >= m.scrollHeight - 2,
    reason,
    elapsedMs: Math.max(0, io.now() - started),
  };
};

/**
 * 页内表达式（主世界只做滚动与读几何，不留任何痕迹）：选「主滚动区」——window 能滚就用 window，
 * 否则取视口中心处最近的可滚动祖先（SPA / 聊天界面的内部滚动容器）。`doScroll` 为 true 时先滚到底。
 * 返回 { scrollHeight, scrollTop, clientHeight, where }。
 */
export const UNTIL_STABLE_EXPR = (doScroll) => `(function () {
  var de = document.documentElement;
  var scrollable = function (e) {
    var s = getComputedStyle(e);
    return /(auto|scroll|overlay)/.test(s.overflowY) && e.scrollHeight > e.clientHeight + 1;
  };
  var pageH = Math.max(de.scrollHeight, document.body ? document.body.scrollHeight : 0);
  if (pageH > window.innerHeight + 1) {
    if (${doScroll ? "true" : "false"}) window.scrollTo({ left: window.scrollX, top: pageH, behavior: 'instant' });
    return { scrollHeight: Math.max(de.scrollHeight, document.body ? document.body.scrollHeight : 0), scrollTop: window.scrollY, clientHeight: window.innerHeight, where: 'page' };
  }
  var el = document.elementFromPoint(Math.floor(innerWidth / 2), Math.floor(innerHeight / 2));
  while (el && el !== document.body && el !== de && !scrollable(el)) el = el.parentElement;
  if (!el || el === document.body || el === de) return { scrollHeight: pageH, scrollTop: window.scrollY, clientHeight: window.innerHeight, where: 'page' };
  if (${doScroll ? "true" : "false"}) el.scrollTo({ top: el.scrollHeight, behavior: 'instant' });
  return { scrollHeight: el.scrollHeight, scrollTop: el.scrollTop, clientHeight: el.clientHeight, where: 'container' };
})()`;
