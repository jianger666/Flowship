/**
 * 增强包 E2 · B5 调试器 op `debug`（契约 §15.2 S6）：断点 / pause_on_exception / 单步 / 作用域变量 / resume。
 *
 * # 与 sources 共用 Debugger 域（debugger-hub.mjs，引用计数）
 * 本模块在 tab 首次被 AI 用到 `debug` 时 `acquire("debug")`，之后常驻到 tab 销毁（断点要一直有效）；**绝不直接 `Debugger.disable`**
 * ——`sources` 释放它自己的引用不会动断点，tab 销毁时本模块 `release` 才可能让 hub 真正 disable。
 * 没被 acquire 的 tab 里页面的 `debugger;` 本来就不暂停，所以不会为此提前 acquire。
 *
 * # 暂停期间页面主线程被冻结（死锁风险点）
 * 暂停时渲染进程停在断点上：`Input.dispatchMouseEvent` / `Page.captureScreenshot` / DOM 读取都等不到响应，会一直挂住。三层处理：
 *  1. **入口闸门**：`index.mjs` 的 dispatchOp 在分发前调 {@link debugPauseGate}——tab 暂停中且 op 不在 {@link PAUSE_ALLOWED_OPS} 里，
 *     立刻抛 `TIMEOUT`「页面被调试器暂停（位置），请用 browser_debug resume / step_* 继续」，不进队列、不发 CDP；
 *  2. **在途竞速**：`session.runAction` 里（仿 §14.1 的对话框竞速）——动作进行中页面被断下（点击触发了断点），与动作竞速，
 *     暂停先到就让动作以同一个错误提前结束，队列再等原 promise 收尾（有上限，resume 后它自然结束）；
 *  3. **debug 自己不走 runAction 队列**：`debug` 的所有 action 直接发 CDP，不排队、不切「AI 操作中」。
 *     所以即使队列里还有一个「等暂停结束才能收尾」的动作，`resume` 也能立刻执行——这是避免死锁的关键。
 * 兜底：暂停满 {@link PAUSE_AUTO_RESUME_MS}（120s）自动 resume 并写活动日志；用户接管开始时若处于暂停不自动 resume（用户可能在看），但兜底照常。
 *
 * # 安全
 *  - `set_breakpoint{condition}`（条件在页面里执行）与 `scope`（读运行时内存）都走 P3 的 `ensureEvaluateApproval`（同一道审批，不另写一套）；
 *  - 作用域变量：只展开 local / closure / block，global 不展开；凭据名变量一律 `[已隐藏]`；其余值先脱敏后截断（debug-policy.mjs）；
 *  - 状态里的 `debug:{paused,reason,url,line,since}` 不含任何变量值，url 已脱敏，reason 是固定枚举；
 *  - 用户接管时 AI 的 debug 动作 `USER_CONTROL`（`status` / `list_breakpoints` 只读，放行）；
 *  - 活动日志只写位置 / 条数，「带条件」不写表达式内容。
 */
import { BrowserError } from "../server-channel.mjs";
import { getDebuggerHub, onHubCreated } from "../debugger-hub.mjs";
import { ensureEvaluateApproval } from "../evaluate-approval.mjs";
import { redactUrlSecrets } from "../net-detail.mjs";
import { redactAndClip, redactSensitiveText } from "../text-redact.mjs";
import {
  DEBUG_ACTIONS,
  debugAllowedUnderController,
  livePause,
  MAX_BREAKPOINTS,
  normalizePauseReason,
  PAUSE_AUTO_RESUME_MS,
  PAUSE_GATE_STALE_MS,
  PAUSE_ON_EXCEPTION_STATES,
  pauseGateMessage,
  pickScopes,
  PAUSE_REASON_LABEL,
  SCOPE_DEPTH_MAX,
  SCOPE_MAX_VARS_DEFAULT,
  SCOPE_MAX_VARS_LIMIT,
  scopeVariable,
  STEP_ACTIONS,
  STEP_WAIT_MS,
  validateBreakpointArgs,
  validateBreakpointId,
} from "../debug-policy.mjs";

export const OPS = Object.freeze(["debug"]);

const HUB_OWNER = "debug";
const STATE_KEY = "debug-state";
/** resume / step 之后等「又暂停了」的静默窗口：窗口内没有新的 paused 就认为页面在继续运行 */
const SETTLE_QUIET_MS = 300;

const clip = (s, n) => (typeof s === "string" && s.length > n ? `${s.slice(0, n)}…` : String(s ?? ""));

export const normalize = (op, args, h) => {
  switch (op) {
    case "debug": {
      const action = h.reqEnum(args, "action", DEBUG_ACTIONS);
      const o = { action };
      switch (action) {
        case "set_breakpoint":
          try {
            Object.assign(o, validateBreakpointArgs({ url: args.url, urlRegex: args.urlRegex, line: args.line, column: args.column, condition: args.condition }));
          } catch (err) {
            throw h.bad(String(err?.message ?? err));
          }
          break;
        case "remove_breakpoint":
          try {
            o.id = validateBreakpointId(args.id);
          } catch (err) {
            throw h.bad(String(err?.message ?? err));
          }
          break;
        case "pause_on_exception":
          o.state = h.reqEnum(args, "state", PAUSE_ON_EXCEPTION_STATES);
          break;
        case "scope":
          o.frame = h.optNum(args, "frame", { min: 0, max: 49, dflt: 0 });
          o.depth = h.optNum(args, "depth", { min: 1, max: SCOPE_DEPTH_MAX, dflt: 1 });
          o.maxVars = h.optNum(args, "maxVars", { min: 1, max: SCOPE_MAX_VARS_LIMIT, dflt: SCOPE_MAX_VARS_DEFAULT });
          break;
        default:
          break;
      }
      return h.withTab(args, o);
    }
    default:
      throw h.bad(`未实现的浏览器操作：${String(op).slice(0, 40)}`);
  }
};

/**
 * 暂停闸门（index.mjs 的 dispatchOp 在分发前调；单测直接喂假 session）。
 * 放行返回 undefined；tab 暂停中且 op 需要页面主线程 → 抛 TIMEOUT。tab 不存在时不报（交给 op 自己报 TAB_NOT_FOUND）。
 * @param {{ getTab: (id?: string) => any }} session
 * @param {string} op
 * @param {{ tabId?: string }} [args]
 */
export const debugPauseGate = (session, op, args) => {
  let tab;
  try {
    tab = session.getTab(args?.tabId);
  } catch {
    return;
  }
  // R6-09 兜底超时：暂停超过 PAUSE_GATE_STALE_MS 仍未被任何清理路径清掉 → 视为失效、放行（并写一条系统日志），避免 tab 被永久锁死
  const msg = pauseGateMessage(
    op,
    livePause(tab, {
      staleMs: PAUSE_GATE_STALE_MS,
      onStale: (p) => {
        try {
          session.activityLog?.addSystem?.({ kind: "select", tabId: tab.id, url: tab.url, summary: `调试器暂停状态已过期（超过 ${Math.round(PAUSE_GATE_STALE_MS / 1000)} 秒仍未恢复，${p?.url ? clip(p.url, 80) : "未知位置"}），已强制清除、不再拦截操作` });
        } catch {
          /* 日志失败不影响放行 */
        }
      },
    }),
  );
  if (msg) throw new BrowserError("TIMEOUT", msg);
};

/** 错误文本进日志 / 返回给 AI 前：脱敏 + 限长 */
const safeErr = (err, n = 100) => clip(redactSensitiveText(String(err?.message ?? err ?? "未知错误")).replace(/[\r\n]+/g, " "), n);

/**
 * R6-38：CDP 在页面并没有暂停时，对 `Debugger.resume / stepOver / stepInto / stepOut` 的固定回复（V8：`Can only perform operation while paused.`）。
 * 它不是「会话坏了」：并发的两个 resume（面板「继续运行」+ AI 的 resume、AI resume + 120s 兜底）里，第二个必然收到它——页面其实已经在跑了。
 * 只认 V8 的固定句子与字面「not paused」；超时（「浏览器内部命令超时…」）/ TAB_NOT_FOUND 等真失败不会命中，照旧走 forceRecover。
 */
export const isNotPausedError = (err) => /can only perform operation while paused|not paused/i.test(String(err?.message ?? err ?? ""));

/** tab 级私有状态（`tab.getExt`；销毁时 `dispose`：resume + 清断点 + 释放 hub） */
const createTabState = (tab, deps) => {
  const st = {
    /** @type {Map<string, { id: string, url?: string, urlRegex?: string, line: number, column?: number, conditional: boolean, locations: any[] }>} */
    breakpoints: new Map(),
    seq: 0,
    pauseOnExceptions: "none",
    hub: null,
    acquired: false,
    acquiring: null,
    stepping: false,
    offHub: null,
    offLost: null,
    timer: null,
    disposed: false,
    session: null,
    dispose() {
      if (st.disposed) return;
      st.disposed = true;
      if (st.timer) deps.clearTimeoutFn(st.timer);
      st.timer = null;
      st.offLost?.();
      st.offLost = null;
      const hub = st.hub;
      const wasPaused = Boolean(tab.debugPause);
      // R6-09：tab 关闭时暂停态也要清并留痕（此前只静默置空）
      if (wasPaused) deps.onDisposedWhilePaused?.(st.session, tab);
      const acquired = st.acquired;
      const ids = [...st.breakpoints.values()].map((b) => b.cdpId);
      st.breakpoints.clear();
      tab.debugPause = null;
      st.offHub?.();
      st.offHub = null;
      st.hub = null;
      // 尽力而为：tab 已销毁时 send 会 reject（TAB_NOT_FOUND），全部吞掉；顺序 = 先 resume（别把页面留在冻结态）→ 清断点 → 释放 hub
      void (async () => {
        if (wasPaused) await tab.send("Debugger.resume", {}, hub?.getPaused?.()?.sessionId ?? null).catch(() => {});
        for (const id of ids) await tab.send("Debugger.removeBreakpoint", { breakpointId: id }).catch(() => {});
        if (acquired) await hub?.release?.(HUB_OWNER)?.catch?.(() => {});
      })();
    },
  };
  return st;
};

/**
 * @param {object} deps  index.mjs 的 createExtraHandlers 依赖（契约 §15.1）；测试可注入 `setTimeoutFn / clearTimeoutFn / now / debugAutoResumeMs`
 */
export const createHandlers = (deps) => {
  const { requireSession, abortable, scheduleState } = deps;
  const setTimeoutFn = deps.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = deps.clearTimeoutFn ?? clearTimeout;
  const nowFn = typeof deps.now === "function" ? deps.now : Date.now;
  // 兜底时长：e2e 经 createBrowserManager 的 deps.debugAutoResumeMs 缩短；生产不传 → 120s
  const autoResumeMs = (() => {
    const v = deps.debugAutoResumeMs ?? deps.electron?.debugAutoResumeMs;
    return Number.isFinite(v) && v > 0 ? v : PAUSE_AUTO_RESUME_MS;
  })();
  const isAppUrl = (u) => {
    try {
      return deps.electron?.isAppUrl?.(u) === true;
    } catch {
      return false;
    }
  };
  const hostLabelOf = (u) => {
    try {
      return typeof deps.hostLabel === "function" ? deps.hostLabel(u) : undefined;
    } catch {
      return undefined;
    }
  };
  const schedule = (taskId) => {
    try {
      scheduleState?.(taskId);
    } catch {
      /* 状态推送失败不影响结果 */
    }
  };
  const logAI = (session, tab, summary) => {
    try {
      session.activityLog.addAI({ kind: "select", tabId: tab.id, url: tab.url, summary });
    } catch (err) {
      deps.log?.(`[browser] debug 活动日志写入失败：${err?.message || err}`);
    }
  };
  const logSystem = (session, tab, summary) => {
    try {
      session.activityLog.addSystem({ kind: "select", tabId: tab.id, url: tab.url, summary });
    } catch (err) {
      deps.log?.(`[browser] debug 活动日志写入失败：${err?.message || err}`);
    }
  };

  const stateOf = (session, tab) => {
    const st = tab.getExt(STATE_KEY, () =>
      createTabState(tab, {
        clearTimeoutFn,
        // 销毁时 session 可能已经 destroy（activityLog 仍可写；写失败 logSystem 自己吞）
        onDisposedWhilePaused: (s, t) => {
          if (s) logSystem(s, t, "标签页关闭时调试器仍处于暂停，暂停状态已清除");
        },
      }),
    );
    st.session = session;
    return st;
  };
  const peekState = (tab) => tab.ext?.get?.(STATE_KEY) ?? null;

  /** 暂停现场 → 对外的位置描述（url 已脱敏；函数名来自页面，只在 op 结果里出现，server 侧不可信包装） */
  const describePause = (hub, p, stepping) => {
    const f = p.callFrames?.[0];
    const loc = f?.location;
    const script = loc ? hub.getScript(loc.scriptId, p.sessionId) : null;
    const rawUrl = script?.url || (typeof f?.url === "string" ? f.url : "");
    return {
      reason: normalizePauseReason(p.reason, p.hitBreakpoints, { stepping }),
      url: rawUrl ? clip(redactUrlSecrets(rawUrl), 300) : "",
      line: Number.isInteger(loc?.lineNumber) ? loc.lineNumber + 1 : undefined,
      column: Number.isInteger(loc?.columnNumber) ? loc.columnNumber + 1 : undefined,
      functionName: clip(String(f?.functionName ?? "").replace(/[\r\n]+/g, " "), 80),
      hitBreakpoints: (p.hitBreakpoints ?? []).filter((x) => typeof x === "string").slice(0, 10),
      since: p.since ?? nowFn(),
    };
  };

  /**
   * R6-09：暂停态「再也等不到 Debugger.resumed」时的统一清理（崩溃 / 换进程导航 / debugger detach / 兜底 resume 失败 / tab 关闭）：
   * 清 tab.debugPause + 兜底定时器 + hub 里的暂停现场 + 单步标记，写一条系统活动日志（只含固定原因文案与已脱敏的位置），推送状态。
   * 没有暂停时什么都不做、不写日志（navigate 事件天天发）。返回是否真的清掉了暂停。
   */
  const clearPauseState = (session, tab, st, why) => {
    if (st.timer) clearTimeoutFn(st.timer);
    st.timer = null;
    st.stepping = false;
    const had = tab.debugPause;
    try {
      st.hub?.clearPaused?.();
    } catch {
      /* 假 hub 没有该方法 */
    }
    if (!had) return false;
    tab.debugPause = null;
    const where = had.url ? `，${clip(had.url, 100)}${had.line ? `:${had.line}` : ""}` : "";
    logSystem(session, tab, `调试器暂停状态已清除（${why}${where}）`);
    schedule(session.taskId);
    return true;
  };

  /**
   * R6-09：resume 失败后的强制恢复——**先**同步清状态（闸门立刻解锁，不被后面的 CDP 超时拖住），再尽力 `Debugger.disable`
   * （V8 在 disable 时会让暂停中的脚本继续运行；断点随之清空），最后补一次 `Debugger.enable` 让 hub / sources 的订阅继续可用。
   * 每条 CDP 命令 3 秒短超时、全部吞错。返回 `{ disabled, message }`，message 是给用户 / AI 看的可读句子（错误文本已脱敏限长）。
   */
  const forceRecover = async (session, tab, st, err) => {
    clearPauseState(session, tab, st, "resume 失败，已强制清除");
    const ids = typeof tab.cdpSessionIds === "function" ? tab.cdpSessionIds() : [null];
    const quick = (method, sid) => tab.send(method, {}, sid, 3000).then(() => true, () => false);
    const results = await Promise.all(ids.map((sid) => quick("Debugger.disable", sid)));
    const disabled = results[0] === true;
    if (disabled) {
      st.breakpoints.clear(); // Debugger.disable 会丢掉全部断点，列表跟着清，别让 AI 以为还在
      // R6-38：V8 的 Debugger.disable 同时把「异常时暂停」重置成 none（`Debugger.enable` 不会恢复）——显示状态跟着归零，别让 list_breakpoints / status 还写着 all
      st.pauseOnExceptions = "none";
      await Promise.all(ids.map((sid) => quick("Debugger.enable", sid)));
    }
    logSystem(session, tab, `调试器 resume 失败（${safeErr(err, 80)}），已强制清除暂停状态${disabled ? "并重置调试器（断点已清空、异常时暂停已关闭）" : "；关闭调试器也失败，页面可能仍无响应"}`);
    const message = `继续运行失败（${safeErr(err)}）：已强制清除暂停状态${disabled ? "，并关闭 / 重置了调试器（断点已清空、异常时暂停已关闭，需要时重新 set_breakpoint / pause_on_exception）" : "；尝试关闭调试器也未成功"}。若页面仍无响应，请用 browser_tabs 关闭该标签页后重新 new 一个`;
    return { disabled, message };
  };

  /**
   * R6-38：resume / step 命令收到「页面并没有暂停」（{@link isNotPausedError}）——良性竞态（并发的另一个 resume 已经让页面继续、或这次暂停刚好结束），不是会话失效。
   * **不走 forceRecover**（它会 `Debugger.disable` 清掉全部断点 + 异常暂停设置）；只在镜像仍指着「同一次暂停」时把它清掉
   * （镜像已经被新的暂停覆盖 / 已被 `Debugger.resumed` 清掉就别动）。返回 true = 已按良性处理，调用方当成功（幂等）。
   */
  const handleNotPaused = (session, tab, st, err, observedPause) => {
    if (!isNotPausedError(err)) return false;
    if (observedPause && tab.debugPause === observedPause) clearPauseState(session, tab, st, "页面已不在暂停状态");
    return true;
  };

  /** 兜底：暂停满 autoResumeMs 自动 resume */
  const armTimer = (session, tab, st) => {
    if (st.timer) clearTimeoutFn(st.timer);
    st.timer = setTimeoutFn(() => {
      st.timer = null;
      const cur = livePause(tab);
      if (st.disposed || !cur) return;
      const where = cur.url ? `${cur.url}${cur.line ? `:${cur.line}` : ""}` : "未知位置";
      logSystem(session, tab, `页面被调试器暂停超过 ${Math.round(autoResumeMs / 1000)} 秒，已自动继续运行（${clip(where, 120)}）`);
      void (async () => {
        try {
          await tab.send("Debugger.resume", {}, st.hub?.getPaused?.()?.sessionId ?? null);
        } catch (err) {
          // R6-38：页面其实已经不在暂停了（别的路径刚 resume 过）→ 良性，只清镜像，不 forceRecover（会清空断点）
          if (handleNotPaused(session, tab, st, err, cur)) return;
          deps.log?.(`[browser] 调试器暂停自动 resume 失败：${err?.message || err}`);
          // R6-09：兜底 resume 也失败（会话已失效 / 目标已死）→ 不能让 tab.debugPause 一直挂着把入口闸门锁死：强制清 + 尝试 Debugger.disable
          await forceRecover(session, tab, st, err);
        }
      })();
    }, autoResumeMs);
    // 定时器不应阻止进程退出
    st.timer?.unref?.();
  };

  /** hub 事件：维护 tab.debugPause / 兜底定时器 / 状态推送 */
  const onHubEvent = (session, tab, st) => (method) => {
    if (st.disposed) return;
    if (method === "Debugger.paused") {
      const p = st.hub?.getPaused?.();
      if (!p) return;
      tab.debugPause = describePause(st.hub, p, st.stepping === true);
      st.stepping = false;
      armTimer(session, tab, st);
      logSystem(session, tab, `页面被调试器暂停（${PAUSE_REASON_LABEL[tab.debugPause.reason] ?? "其它"}${tab.debugPause.url ? `，${clip(tab.debugPause.url, 100)}${tab.debugPause.line ? `:${tab.debugPause.line}` : ""}` : ""}）`);
      schedule(session.taskId);
    } else if (method === "Debugger.resumed") {
      if (st.timer) clearTimeoutFn(st.timer);
      st.timer = null;
      if (tab.debugPause) {
        tab.debugPause = null;
        schedule(session.taskId);
      }
    }
  };

  /** 把本 tab 的暂停跟踪挂到 hub 上（幂等）：hub 一诞生就挂（见 onHubCreated），不依赖 AI 用过 debug */
  const attach = (session, tab, st, hub) => {
    if (st.hub || st.disposed) return;
    st.hub = hub;
    st.offHub = hub.on(onHubEvent(session, tab, st));
    // R6-09：崩溃 / 换进程导航 / debugger detach 都不会再来 Debugger.resumed——据此强制清暂停态（假 tab 没有该订阅点就跳过）
    st.offLost =
      tab.addContextLostHook?.((reason) => {
        if (st.disposed) return;
        clearPauseState(session, tab, st, { crash: "页面进程崩溃", navigate: "页面已导航到新文档", detach: "调试连接已断开" }[reason] ?? "页面上下文已失效");
      }) ?? null;
  };

  // 页面的 `debugger;` 只要有人（如只用 sources 的 AI）enable 了 Debugger 域就会冻住页面：跟踪必须在 hub 创建时就挂上
  onHubCreated((tab, hub) => {
    const session = (deps.sessions?.() ?? []).find((s) => Array.isArray(s.tabs) && s.tabs.includes(tab));
    if (session) attach(session, tab, stateOf(session, tab), hub);
  });

  /** 首次使用 debug 时 acquire hub（之后常驻到 tab 销毁，断点要一直有效）。并发调用共用同一次 acquire；失败回滚、下次重试 */
  const ensureActive = async (session, tab, st) => {
    const hub = getDebuggerHub(tab, { log: deps.log });
    attach(session, tab, st, hub);
    if (st.acquired) return hub;
    if (!st.acquiring) {
      st.acquiring = hub
        .acquire(HUB_OWNER)
        .then(() => {
          st.acquired = true;
        })
        .catch((err) => {
          st.acquiring = null;
          throw new BrowserError("INTERNAL", `无法启用调试器：${clip(String(err?.message ?? err), 120)}`);
        });
    }
    await st.acquiring;
    return hub;
  };

  /** 等 resume / step 的结果：先订阅再发命令；新的 paused → "paused"；resumed 之后静默 SETTLE_QUIET_MS 无 paused → "running"；超时 → "timeout" */
  const settleAfter = (hub) => {
    let finish = () => {};
    const done = new Promise((resolve) => {
      let quiet = null;
      let finished = false;
      let timer = null;
      let off = () => {};
      finish = (v) => {
        if (finished) return;
        finished = true;
        off();
        if (timer) clearTimeoutFn(timer);
        if (quiet) clearTimeoutFn(quiet);
        resolve(v);
      };
      off = hub.on((method) => {
        if (method === "Debugger.paused") finish("paused");
        else if (method === "Debugger.resumed") {
          if (quiet) clearTimeoutFn(quiet);
          quiet = setTimeoutFn(() => finish("running"), SETTLE_QUIET_MS);
        }
      });
      timer = setTimeoutFn(() => finish("timeout"), STEP_WAIT_MS);
    });
    return { done, cancel: () => finish("cancelled") };
  };

  const pauseView = (tab) => {
    const p = livePause(tab);
    if (!p) return { paused: false };
    return {
      paused: true,
      reason: p.reason,
      ...(p.url ? { url: p.url } : {}),
      ...(p.line !== undefined ? { line: p.line } : {}),
      ...(p.column !== undefined ? { column: p.column } : {}),
      ...(p.functionName ? { functionName: p.functionName } : {}),
      pausedForMs: Math.max(0, nowFn() - p.since),
    };
  };

  const approve = async (session, tab, summary, signal) => {
    await ensureEvaluateApproval(session, {
      summary,
      signal,
      tabId: tab.id,
      host: hostLabelOf(tab.url),
      ...(Number.isFinite(deps.electron?.evaluatePromptTimeoutMs) && deps.electron.evaluatePromptTimeoutMs > 0 ? { timeoutMs: deps.electron.evaluatePromptTimeoutMs } : {}),
    });
  };

  // ── actions ──

  const setBreakpoint = async (session, tab, st, a, signal) => {
    if (a.url !== undefined && isAppUrl(a.url)) throw new BrowserError("URL_BLOCKED", "不能在本应用自身的脚本上设置断点");
    if (st.breakpoints.size >= MAX_BREAKPOINTS) {
      throw new BrowserError("BAD_ARGS", `每个标签页最多 ${MAX_BREAKPOINTS} 个断点：先用 list_breakpoints 查看，再 remove_breakpoint 删掉不用的`);
    }
    // 条件在页面里执行 → 先过 evaluate 审批（与 browser_evaluate 同一道；被拒就根本不碰 CDP）
    if (a.condition !== undefined) await approve(session, tab, `[调试器·条件断点] ${a.condition}`, signal);
    const hub = await abortable(ensureActive(session, tab, st), signal);
    const params = {
      lineNumber: a.line - 1,
      ...(a.column !== undefined ? { columnNumber: a.column - 1 } : {}),
      ...(a.condition !== undefined ? { condition: a.condition } : {}),
      ...(a.url !== undefined ? { url: a.url } : { urlRegex: a.urlRegex }),
    };
    let r;
    try {
      r = await abortable(tab.send("Debugger.setBreakpointByUrl", params), signal);
    } catch (err) {
      if (err instanceof BrowserError) throw err;
      throw new BrowserError("BAD_ARGS", `设置断点失败：${clip(String(err?.message ?? err), 160)}（该位置可能已有断点，或 url / 行号不对）`);
    }
    const cdpId = typeof r?.breakpointId === "string" ? r.breakpointId : "";
    if (!cdpId) throw new BrowserError("INTERNAL", "调试器没有返回断点 id");
    // CDP 的断点 id 形如 `1:5:0:<脚本完整 url>`——带着 url 里的 query 令牌，不能出站：对外用自己的短 id（bp1 / bp2…），cdpId 只留在主进程
    const id = `bp${++st.seq}`;
    const locations = (Array.isArray(r.locations) ? r.locations : []).slice(0, 5).map((l) => {
      const s = hub.getScript(l.scriptId);
      return {
        ...(s?.url ? { url: clip(redactUrlSecrets(s.url), 300) } : {}),
        line: Number.isInteger(l.lineNumber) ? l.lineNumber + 1 : undefined,
        column: Number.isInteger(l.columnNumber) ? l.columnNumber + 1 : undefined,
      };
    });
    const entry = { id, cdpId, ...(a.url !== undefined ? { url: clip(redactUrlSecrets(a.url), 300) } : { urlRegex: clip(redactSensitiveText(a.urlRegex), 100) }), line: a.line, ...(a.column !== undefined ? { column: a.column } : {}), conditional: a.condition !== undefined, locations };
    st.breakpoints.set(id, entry);
    logAI(session, tab, `设置了断点 ${clip(entry.url ?? `/${entry.urlRegex}/`, 80)}:${a.line}${entry.conditional ? "（带条件）" : ""}`);
    return { action: "set_breakpoint", breakpoint: bpView(entry), bound: locations.length > 0, count: st.breakpoints.size, limit: MAX_BREAKPOINTS };
  };

  /** 对外的断点视图：去掉主进程内部的 cdpId */
  const bpView = (entry) => {
    const { cdpId, ...rest } = entry;
    void cdpId;
    return rest;
  };

  const removeBreakpoint = async (session, tab, st, a, signal) => {
    const entry = st.breakpoints.get(a.id);
    if (!entry) throw new BrowserError("BAD_ARGS", "没有这个断点 id（只能删除 browser_debug 自己设置的断点；先 list_breakpoints 查看）");
    st.breakpoints.delete(a.id);
    try {
      await abortable(tab.send("Debugger.removeBreakpoint", { breakpointId: entry.cdpId }), signal);
    } catch (err) {
      deps.log?.(`[browser] removeBreakpoint 失败（已从列表移除）：${err?.message || err}`);
    }
    logAI(session, tab, `删除了断点 ${clip(entry.url ?? `/${entry.urlRegex}/`, 80)}:${entry.line}`);
    return { action: "remove_breakpoint", removed: a.id, count: st.breakpoints.size };
  };

  const listBreakpoints = (st) => ({
    action: "list_breakpoints",
    breakpoints: [...st.breakpoints.values()].map(bpView),
    count: st.breakpoints.size,
    limit: MAX_BREAKPOINTS,
    pauseOnExceptions: st.pauseOnExceptions,
  });

  const pauseOnException = async (session, tab, st, a, signal) => {
    await abortable(ensureActive(session, tab, st), signal);
    await abortable(tab.send("Debugger.setPauseOnExceptions", { state: a.state }), signal);
    st.pauseOnExceptions = a.state;
    logAI(session, tab, a.state === "none" ? "关闭了异常时暂停" : `设置了遇到${a.state === "all" ? "所有" : "未捕获"}异常时暂停`);
    return { action: "pause_on_exception", state: a.state };
  };

  const status = (tab, st) => {
    const p = livePause(tab);
    const byCdp = new Map([...(st?.breakpoints.values() ?? [])].map((b) => [b.cdpId, b]));
    const hit = p ? p.hitBreakpoints.map((cid) => byCdp.get(cid)).filter(Boolean).map((b) => ({ id: b.id, line: b.line, ...(b.url ? { url: b.url } : {}) })) : [];
    // 异常描述来自页面（可能含栈 / 凭据）：先脱敏后截断，server 侧仍是不可信包装
    const exc = p?.reason === "exception" ? st?.hub?.getPaused?.()?.data : undefined;
    const excText = typeof exc?.description === "string" ? redactAndClip(exc.description.split("\n")[0], 300).text : undefined;
    return {
      action: "status",
      ...pauseView(tab),
      ...(hit.length > 0 ? { hitBreakpoints: hit } : {}),
      ...(excText ? { exception: excText } : {}),
      ...(p ? { autoResumeSeconds: Math.round(autoResumeMs / 1000) } : {}),
      breakpointCount: st?.breakpoints.size ?? 0,
      pauseOnExceptions: st?.pauseOnExceptions ?? "none",
      debuggerActive: Boolean(st?.hub),
    };
  };

  /** step_* / resume：必须在暂停中（resume 幂等）；发命令 → 等新的暂停位置 */
  const stepOrResume = async (session, tab, st, a, signal) => {
    const hub = st?.hub;
    const observed = livePause(tab); // 这次命令针对的那一次暂停（R6-38：命令失败时据此判断镜像是不是还指着它）
    if (!observed || !hub) {
      if (a.action === "resume") return { action: "resume", paused: false, note: "页面当前没有暂停，无需继续" };
      throw new BrowserError("BAD_ARGS", `页面当前没有被调试器暂停，不能 ${a.action}（先 set_breakpoint 并触发，或用 status 查看）`);
    }
    const method = { step_over: "Debugger.stepOver", step_into: "Debugger.stepInto", step_out: "Debugger.stepOut", resume: "Debugger.resume" }[a.action];
    const sessionId = hub.getPaused()?.sessionId ?? null;
    const settle = settleAfter(hub);
    let outcome;
    // 单步落点的 CDP reason 也是 other：先标记「正在单步」，paused 事件到来时据此归为 step
    st.stepping = a.action !== "resume";
    // R6-09：命令本身失败（会话失效 / 目标已死 / CDP 超时）≠ 被取消：失败后暂停态不会再被 Debugger.resumed 清掉——强制清 + 尝试 disable，报错写清楚
    let sendFailure = null;
    try {
      await abortable(
        tab.send(method, {}, sessionId).catch((err) => {
          sendFailure = err;
          throw err;
        }),
        signal,
      );
      outcome = await abortable(settle.done, signal);
    } catch (err) {
      settle.cancel();
      st.stepping = false;
      if (sendFailure && !signal?.aborted) {
        // R6-38：「页面并没有暂停」是并发 resume 的良性结果——resume 幂等成功；step 与入口的「未暂停」同口径报 BAD_ARGS。都不 forceRecover（会清空全部断点）
        if (handleNotPaused(session, tab, st, sendFailure, observed)) {
          schedule(session.taskId);
          // 期间页面又在新位置暂停了（镜像已被新暂停覆盖）：照实说，别告诉 AI「没暂停」
          const now = pauseView(tab);
          if (a.action === "resume") {
            return { action: "resume", ...now, note: now.paused ? "上一次暂停刚被另一个请求恢复，页面又在新的位置暂停了：用 status 查看" : "页面当前没有暂停（可能刚被另一个继续运行请求恢复），无需继续" };
          }
          throw new BrowserError(
            "BAD_ARGS",
            now.paused ? `上一次暂停刚被另一个请求恢复，页面又在新的位置暂停了，这次 ${a.action} 没有执行（用 status 查看后再决定）` : `页面当前没有被调试器暂停（可能刚被另一个继续运行请求恢复），不能 ${a.action}（用 status 查看）`,
          );
        }
        const rec = await forceRecover(session, tab, st, sendFailure);
        schedule(session.taskId);
        throw new BrowserError("INTERNAL", rec.message);
      }
      throw err;
    }
    st.stepping = false;
    const summary = { step_over: "单步跳过", step_into: "单步进入", step_out: "单步跳出", resume: "继续运行" }[a.action];
    logAI(session, tab, summary);
    schedule(session.taskId);
    return {
      action: a.action,
      ...pauseView(tab),
      ...(outcome === "timeout" ? { note: "等待新的暂停位置超时（5 秒）：页面可能仍在运行，用 status 查看" } : {}),
    };
  };

  const scope = async (session, tab, st, a, signal) => {
    const hub = st?.hub;
    const paused = hub?.getPaused?.();
    if (!livePause(tab) || !paused) throw new BrowserError("BAD_ARGS", "页面当前没有被调试器暂停，没有作用域可读（先 set_breakpoint 并触发，或用 status 查看）");
    const frame = paused.callFrames?.[a.frame];
    if (!frame) throw new BrowserError("BAD_ARGS", `没有第 ${a.frame} 帧（当前调用栈共 ${paused.callFrames?.length ?? 0} 帧，frame 从 0 起）`);
    // 读运行时内存：与 browser_evaluate 同一道审批
    await approve(session, tab, `[调试器·读取暂停帧变量] 第 ${a.frame} 帧 ${clip(String(frame.functionName ?? ""), 60)} 的局部 / 闭包变量`, signal);
    if (!livePause(tab)) throw new BrowserError("TIMEOUT", "等待授权期间页面已继续运行（暂停已结束），变量不可读了；需要的话重新触发断点");
    const sessionId = paused.sessionId ?? null;
    const picked = pickScopes(frame.scopeChain, a.depth);
    let budget = a.maxVars;
    let omitted = 0;
    let hiddenCount = 0;
    const scopes = [];
    for (const sc of picked) {
      let props = [];
      try {
        const r = await abortable(tab.send("Runtime.getProperties", { objectId: sc.object.objectId, ownProperties: true, generatePreview: false }, sessionId), signal);
        props = Array.isArray(r?.result) ? r.result : [];
      } catch (err) {
        if (err instanceof BrowserError) throw err;
        scopes.push({ type: sc.type, ...(sc.name ? { name: sc.name } : {}), vars: [], error: "读取失败（暂停可能已结束）" });
        continue;
      }
      const vars = [];
      for (const prop of props) {
        if (typeof prop?.name !== "string") continue;
        if (budget <= 0) {
          omitted += 1;
          continue;
        }
        budget -= 1;
        // 访问器（getter / setter）不执行：执行 getter 等于在页面里跑代码
        const v = scopeVariable(prop.name, prop.value ?? { type: "undefined" }, { redact: redactSensitiveText });
        if (!prop.value && (prop.get || prop.set)) v.value = "(访问器，未执行)";
        if (v.hidden) hiddenCount += 1;
        vars.push(v);
      }
      scopes.push({ type: sc.type, ...(sc.name ? { name: sc.name } : {}), vars });
    }
    logAI(session, tab, `读取了暂停帧变量（第 ${a.frame} 帧，${scopes.reduce((n, s) => n + s.vars.length, 0)} 个，凭据名变量已隐藏）`);
    return {
      action: "scope",
      frame: a.frame,
      ...(frame.functionName ? { functionName: clip(String(frame.functionName).replace(/[\r\n]+/g, " "), 80) } : {}),
      scopes,
      hiddenCount,
      ...(omitted > 0 ? { omitted } : {}),
      note: "只展开 local / closure / block 作用域（global 不展开）；对象只给类型，不递归；凭据名的变量值一律隐藏",
    };
  };

  /** 用户在面板点「继续运行」：接管期间也可用（不是 AI 动作），不要求审批；对该会话所有暂停中的 tab 发 resume */
  deps.registerExt?.("debug.resume", async (session) => {
    let n = 0;
    /** R6-09：resume 失败的 tab 数与给用户看的原因（面板只显示这句话，不含页面内容） */
    let failed = 0;
    let error;
    for (const tab of session.tabs ?? []) {
      const st = peekState(tab);
      const observed = livePause(tab);
      if (!observed || !st?.hub) continue;
      try {
        await tab.send("Debugger.resume", {}, st.hub.getPaused()?.sessionId ?? null);
        n += 1;
      } catch (err) {
        // R6-38：页面其实已经在运行（并发的 AI resume 先到）→ 用户要的结果已达成，算成功，不 forceRecover（会清空断点）
        if (handleNotPaused(session, tab, st, err, observed)) {
          n += 1;
          continue;
        }
        deps.log?.(`[browser] 用户 resume 失败：${err?.message || err}`);
        // 失败不能把 tab 留在「暂停」里（用户点的这个按钮是唯一出口，它自己也失败就死锁了）：强制清 + 尝试 Debugger.disable，并告诉用户
        failed += 1;
        error = (await forceRecover(session, tab, st, err)).message;
      }
    }
    if (n > 0) {
      try {
        session.activityLog.addSystem({ kind: "select", tabId: session.activeTabId ?? "", url: session.activeTab?.url ?? "", summary: "用户在面板上点了「继续运行」，页面已恢复" });
      } catch {
        /* 日志失败不影响 resume */
      }
    }
    return { resumed: n, ...(failed > 0 ? { failed, error } : {}) };
  });

  // 状态贡献者 debug:{paused,reason,url,line,since}：不含任何变量值；没有暂停时不贡献（保持默认 null，面板条不显示）
  deps.addStateContributor?.((session) => {
    const tab = (session.tabs ?? []).find((t) => livePause(t));
    if (!tab) return {};
    const p = tab.debugPause;
    return { debug: { paused: true, reason: p.reason, url: p.url, line: p.line, since: p.since } };
  });

  return {
    debug: async (taskId, a, signal) => {
      const session = requireSession(taskId);
      const tab = session.getTab(a.tabId);
      if (!debugAllowedUnderController(a.action, session.controller)) {
        throw new BrowserError("USER_CONTROL", "用户正在接管浏览器，AI 的调试动作被拒绝（只有 status / list_breakpoints 可读）。请等用户交还控制权；用户可能正在查看暂停现场，不要替他 resume");
      }
      const st = stateOf(session, tab);
      switch (a.action) {
        case "status":
          return { tabId: tab.id, ...status(tab, st) };
        case "list_breakpoints":
          return { tabId: tab.id, ...listBreakpoints(st) };
        case "set_breakpoint":
          return { tabId: tab.id, ...(await setBreakpoint(session, tab, st, a, signal)) };
        case "remove_breakpoint":
          return { tabId: tab.id, ...(await removeBreakpoint(session, tab, st, a, signal)) };
        case "pause_on_exception":
          return { tabId: tab.id, ...(await pauseOnException(session, tab, st, a, signal)) };
        case "scope":
          return { tabId: tab.id, ...(await scope(session, tab, st, a, signal)) };
        default:
          if (STEP_ACTIONS.includes(a.action)) return { tabId: tab.id, ...(await stepOrResume(session, tab, st, a, signal)) };
          throw new BrowserError("BAD_ARGS", `未知的 debug 动作：${String(a.action).slice(0, 20)}`);
      }
    },
  };
};
