/**
 * 增强包 E2 · A7：evaluate 授权（契约 §15.2 S2）。
 *
 * 以前 `browser_evaluate`（以及后续 `browser_debug` 里能执行脚本的动作）只看设置里的总闸 `evaluateEnabled`：没开直接 `DISABLED`，
 * AI 只能放弃。现在改成「没开就请用户当场授权」：
 *
 *   config.evaluateEnabled === true        → 直接放行（总闸开着就是用户的长期授权）
 *   本任务已被批准（会话级标记）             → 放行
 *   否则弹 `evaluate` 提示（PromptHub，120 秒无人处理按拒绝）：
 *     task   仅本任务：写会话标记，之后本任务内放行（用户可撤销 / 总闸被关时自动失效，见 revokeEvaluateApproval）
 *     always 永久开启：**不写会话标记**，只发 `settings_set` 事件让 server 把设置置 true（server 侧只认白名单键值，见 settings-events.ts）；
 *            之后免审批只认实时总闸；事件发不出去 / 5 秒后总闸仍没开 → 写系统活动日志告诉用户「永久授权没保存」（R6-04）
 *     deny / 超时 / 取消 → 抛 BrowserError("DENIED")
 *
 * 为什么放进独立的纯模块：`debug` 工具（其它子 agent）要复用同一套授权；纯函数 + 注入的 session 形状，不依赖 Electron，可单测真值表。
 *
 * 安全点：
 *  - 提示里只放表达式的前 200 字（经 cleanPromptText：折叠空白、剥格式字符），让用户看清「AI 想跑什么」；
 *  - 批准是**会话级**的：随会话销毁而失效（任务关闭浏览器 / 重开都要重新批准），不落盘；
 *  - 同一会话里并发多个 evaluate 共用同一张审批卡（不会弹出一堆），只有「所有等待者都被取消」才取消这张卡；
 *  - `always` 的写设置动作不在这里做：这里只 `emitEvent`，真正落盘由 server 校验白名单后执行（主进程不直接碰 config.json）。
 */
import { cleanPromptText } from "./prompts.mjs";
import { BrowserError } from "./server-channel.mjs";
import { redactAndClip } from "./text-redact.mjs";

/** 会话里存审批状态的 ext 键（`session.getExt(key, factory)`） */
export const EVALUATE_APPROVAL_EXT = "evaluate-approval";
/** 审批卡的等待上限：2 分钟（比 PromptHub 默认的 60 秒长：用户要读完代码再决定） */
export const EVALUATE_PROMPT_TIMEOUT_MS = 120_000;
/** 提示里最多展示表达式的多少字符 */
export const EVALUATE_SUMMARY_MAX = 200;
/** `always` 时发给 server 的设置事件（server 侧白名单里也是这一对键值） */
export const EVALUATE_SETTINGS_KEY = "browserEvaluateEnabled";

/** 表达式 → 提示里展示的摘要（折叠空白、剥格式字符、限 200 字） */
export const summarizeExpression = (expression) => cleanPromptText(expression, EVALUATE_SUMMARY_MAX);

const stateOf = (session) => session.getExt(EVALUATE_APPROVAL_EXT, () => ({ approved: false, inflight: null }));

/** 本会话是否已被批准执行页面脚本（只看会话标记，不看总闸） */
export const isEvaluateApproved = (session) => stateOf(session).approved === true;

/**
 * 当下是否已获授权（R6-31）：总闸开着，或本会话已被「仅本任务」批准。**不弹卡、无副作用**——给「批准过的东西要不要继续生效」做二次判定用
 * （比如可执行 mock 规则在 fulfill 前重判；创建时过的那道审批不等于之后一直有效）。
 */
export const isEvaluateAuthorized = (session) => session.host?.isEvaluateEnabled?.() === true || isEvaluateApproved(session);

/**
 * 登记「批准被撤销时要联动清理的东西」（R6-31）：审批只在「创建」那一刻查一次的能力（可执行 mock 规则……）靠它在撤销时一并收回。
 * 回调 `fn({ reason, had })` 由 {@link revokeEvaluateApproval} 同步触发（可返回 Promise，rejection 只记日志）；返回取消登记函数。
 * `reason`：`"revoke"`（用户撤销批准）/ `"gate-off"`（设置里的总闸开→关）；`had`：撤销前会话是否处于「仅本任务」批准状态。
 */
export const onEvaluateRevoked = (session, fn) => {
  const st = stateOf(session);
  if (!st.revokeHooks) st.revokeHooks = new Set();
  st.revokeHooks.add(fn);
  return () => st.revokeHooks?.delete(fn);
};

/**
 * 撤销本会话的「仅本任务」批准（用户在面板点「撤销批准」/ 总闸被关 / 任务结束时调用）。返回之前是否处于已批准状态。
 * 之后的 evaluate 重新弹审批卡；已在等待中的审批卡不受影响。
 * R6-31：同时触发 {@link onEvaluateRevoked} 登记的联动清理（**不管之前有没有会话批准**：总闸开着时创建的可执行 mock 也要在总闸关掉时收回）。
 * @param {any} session
 * @param {{ reason?: "revoke" | "gate-off" }} [opts]
 */
export const revokeEvaluateApproval = (session, { reason = "revoke" } = {}) => {
  const st = stateOf(session);
  const had = st.approved === true;
  st.approved = false;
  for (const fn of [...(st.revokeHooks ?? [])]) {
    try {
      const r = fn({ reason, had });
      if (r && typeof r.catch === "function") r.catch((err) => session.log?.(`[browser] 撤销批准的联动清理失败：${err?.message || err}`));
    } catch (err) {
      session.log?.(`[browser] 撤销批准的联动清理失败：${err?.message || err}`);
    }
  }
  return had;
};

/** always 之后多久核对「总闸真的变成 true 了」：server 写设置 → 推回 config 通常几十毫秒，5 秒还没变就当没保存成功 */
export const EVALUATE_ALWAYS_VERIFY_MS = 5000;

/** 永久授权没保存成功：不能静默——审批卡已经说了「永久」，用户却以为设置里开了。写一条系统活动日志（面板时间线可见） */
const warnAlwaysNotSaved = (session, why) => {
  session.log?.(`[browser] evaluate 永久授权没有保存：${why}`);
  try {
    session.activityLog?.addSystem({
      kind: "select",
      tabId: session.activeTabId ?? "",
      url: "",
      summary: `「永久允许执行页面脚本」没有保存成功（${why}）：之后 AI 执行脚本仍会逐次询问，可到 设置 → 内置浏览器 手动开启`,
    });
    session.host?.onChange?.(session.taskId);
  } catch (err) {
    session.log?.(`[browser] evaluate 永久授权失败提示的活动日志写入失败：${err?.message || err}`);
  }
};

/** 发 settings_set 并核对结果（事件发不出去 / 超时总闸仍没开 → warnAlwaysNotSaved）。不 throw、不阻塞本次 evaluate */
const announceAlways = (session, verifyMs) => {
  let sent = false;
  try {
    sent = session.host?.emitEvent?.("settings_set", session.taskId, { key: EVALUATE_SETTINGS_KEY, value: true }) !== false;
  } catch (err) {
    // 事件发不出去只影响「永久」这一半：本次 evaluate 已经批准了，不能让它拖垮这次调用
    session.log?.(`[browser] evaluate 永久授权的设置事件发送失败：${err?.message || err}`);
    sent = false;
  }
  if (!sent) {
    warnAlwaysNotSaved(session, "与 server 的通道不可用");
    return;
  }
  const t = setTimeout(
    () => {
      if (session.destroyed || session.host?.isEvaluateEnabled?.() === true) return;
      warnAlwaysNotSaved(session, "设置写入失败或被拒绝");
    },
    Number.isFinite(verifyMs) && verifyMs >= 0 ? verifyMs : EVALUATE_ALWAYS_VERIFY_MS,
  );
  t.unref?.();
};

const abortError = (signal) => signal?.reason ?? new BrowserError("CANCELLED", "操作已取消");

/**
 * 确保「执行页面脚本」已获授权；没有授权就弹审批卡等用户决定。
 *
 * @param {{
 *   taskId?: string,
 *   host?: { isEvaluateEnabled?: () => boolean, emitEvent?: (name: string, taskId: string, data: object) => unknown },
 *   prompts: { request: (spec: object) => Promise<{ action: string, timedOut?: boolean, cancelled?: boolean }> },
 *   getExt: (key: string, factory: () => any) => any,
 *   log?: (msg: string) => void,
 * }} session  BrowserSession（或同形状的假对象）
 * @param {{ summary?: string, signal?: AbortSignal, tabId?: string, host?: string, timeoutMs?: number, alwaysVerifyMs?: number }} [opts]  alwaysVerifyMs 仅测试用（缩短「永久授权是否保存」的核对延时）
 * @returns {Promise<{ via: "config" | "task" | "prompt-task" | "prompt-always" }>}
 * @throws {BrowserError} DENIED（用户拒绝 / 超时 / 取消）、或 signal 的 reason（等待期间任务被停止）
 */
export const ensureEvaluateApproval = async (session, { summary = "", signal, tabId, host, timeoutMs = EVALUATE_PROMPT_TIMEOUT_MS, alwaysVerifyMs } = {}) => {
  if (session.host?.isEvaluateEnabled?.() === true) return { via: "config" };
  const st = stateOf(session);
  if (st.approved === true) return { via: "task" };
  if (signal?.aborted) throw abortError(signal);

  // 同一会话里并发的多次 evaluate 共用一张审批卡
  let flight = st.inflight;
  if (!flight) {
    const controller = new AbortController();
    flight = { waiters: 0, controller, promise: null };
    flight.promise = (async () => {
      const r = await session.prompts.request({
        kind: "evaluate",
        ...(tabId ? { tabId } : {}),
        ...(host ? { host } : {}),
        detail: { summary: summarizeExpression(summary) },
        timeoutMs,
        signal: controller.signal,
      });
      if (r?.action === "task") {
        // 「仅本任务」：本会话之后的脚本不再询问（审批卡文案要写明这一点）；随会话销毁 / 用户撤销 / 总闸被关而失效
        st.approved = true;
        return { via: "prompt-task" };
      }
      if (r?.action === "always") {
        // R6-04：「永久」**不置会话标记**——免审批只认实时总闸（config.evaluateEnabled）。以前 always 也置 st.approved，
        // 用户事后在设置里把总闸关掉，本会话仍然免审批。真正的「永久」由 server 写设置后推回 config 来体现。
        announceAlways(session, alwaysVerifyMs);
        return { via: "prompt-always" };
      }
      // R6-19：授权卡的名额是 evaluate 自己的保留位；真满了说明有别的授权请求还挂着，别误报成「无人处理」
      if (r?.overflow) throw new BrowserError("DENIED", "浏览器面板上还有未处理的 browser_evaluate 授权请求，这次请求已按拒绝处理；请让用户先处理面板上的提示后再试");
      if (r?.timedOut) throw new BrowserError("DENIED", "用户没有在 2 分钟内处理 browser_evaluate 的授权请求，已按拒绝处理");
      if (r?.cancelled) throw new BrowserError("DENIED", "browser_evaluate 的授权请求被取消（任务被停止、页面已关闭或会话已结束）");
      throw new BrowserError("DENIED", "用户拒绝了执行页面脚本（browser_evaluate）");
    })().finally(() => {
      if (st.inflight === flight) st.inflight = null;
    });
    // 没有等待者时（全部被取消）这条 promise 的拒绝没人接：挂一个空 catch 防止 unhandled rejection
    flight.promise.catch(() => {});
    st.inflight = flight;
  }

  flight.waiters += 1;
  const release = () => {
    flight.waiters -= 1;
    // 所有等待者都走了：没人在等这张卡，撤掉它（用户面板上不留一张作废的审批卡）
    if (flight.waiters <= 0) flight.controller.abort();
  };
  if (!signal) {
    try {
      return await flight.promise;
    } finally {
      flight.waiters -= 1;
    }
  }
  return new Promise((resolve, reject) => {
    let done = false;
    const onAbort = () => {
      if (done) return;
      done = true;
      release();
      reject(abortError(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    flight.promise.then(
      (v) => {
        if (done) return;
        done = true;
        signal.removeEventListener("abort", onAbort);
        flight.waiters -= 1;
        resolve(v);
      },
      (e) => {
        if (done) return;
        done = true;
        signal.removeEventListener("abort", onAbort);
        flight.waiters -= 1;
        reject(e);
      },
    );
  });
};

// ───────────────────────── R6-04：批准之后的可见性与接管 ─────────────────────────

/** 活动日志里每次 evaluate 的批准方式（用户据此在时间线上区分「我批准过」还是「总闸本来就开着」） */
const VIA_LABEL = Object.freeze({
  config: "免审批·总闸已开",
  task: "本任务已批准",
  "prompt-task": "本次批准·仅本任务",
  "prompt-always": "本次批准·永久开启",
});
/** 活动日志单条上限 160 字（activity-log 的 SUMMARY_MAX）：前缀占 ~35 字，表达式摘要取前 100 字，留住「共 N 字」不被截掉 */
export const EVALUATE_LOG_HEAD_MAX = 100;

/** 一次 evaluate 在活动日志里的一句话：批准方式 + 表达式长度 + 脱敏后的表达式开头（先脱敏后截断，折叠空白、剥格式字符） */
export const describeEvaluateForLog = (expression, via) => {
  const raw = String(expression ?? "");
  const head = cleanPromptText(redactAndClip(raw, EVALUATE_LOG_HEAD_MAX * 4).text, EVALUATE_LOG_HEAD_MAX);
  return `执行了页面脚本（${VIA_LABEL[via] ?? "已批准"}，共 ${raw.length} 字）：${head}`;
};

const takeoverError = (session, afterRun) =>
  afterRun
    ? new BrowserError("USER_TOOK_OVER", "脚本执行期间用户接管了浏览器，结果已丢弃（可能包含用户刚输入的内容）。请不要继续操作：结束本轮、或用 ask_user 问用户；用户交还后先 browser_snapshot 看现状")
    : new BrowserError(
        "USER_CONTROL",
        session.ask
          ? "用户正在按你的请求操作浏览器，请等待用户点「完成 / 放弃」后再继续（不要重复操作）"
          : "用户正在接管浏览器，AI 的动作被拒绝。请结束本轮、或调用 ask_user_to_act 请用户协助，等用户点「交还给 AI」后再继续",
      );

/** 用户接管中就抛 USER_CONTROL（与 runAction 的校验同口径同文案）；弹审批卡之前和批准之后各查一次 */
export const assertEvaluateNotUserControlled = (session) => {
  if (session.controller === "user") throw takeoverError(session, false);
};

/**
 * 批准之后真正执行 evaluate（R6-04）：
 *  ① 接管检查（执行前）：用户接管 / ask_user_to_act 进行中 → USER_CONTROL，不执行；
 *  ② 每次执行写一条 AI 活动日志（脱敏后的表达式前 100 字 + 长度 + 批准方式）——「仅本任务」之后的脚本不再弹卡，时间线上必须看得见；
 *  ③ 执行期间挂进 `session.inflight`：用户点「接管」会像打断其它动作一样打断它（USER_TOOK_OVER）；
 *  ④ 接管检查（执行后）：期间用户接管了就丢弃结果（脚本可能读到了用户刚输入的内容）。
 * @param {any} session
 * @param {{ evaluate: (expression: string) => Promise<any>, id?: string, url?: string }} tab
 * @param {{ expression: string, via: string, signal?: AbortSignal, abortable: (p: Promise<any>, s?: AbortSignal) => Promise<any> }} o
 */
export const runApprovedEvaluate = async (session, tab, { expression, via, signal, abortable }) => {
  assertEvaluateNotUserControlled(session);
  try {
    session.activityLog?.addAI({ kind: "select", tabId: tab.id ?? "", url: tab.url ?? "", summary: describeEvaluateForLog(expression, via) });
    session.host?.onChange?.(session.taskId);
  } catch (err) {
    session.log?.(`[browser] evaluate 的活动日志写入失败：${err?.message || err}`);
  }
  const ctl = new AbortController();
  const onReqAbort = () => ctl.abort(signal.reason);
  if (signal?.aborted) onReqAbort();
  else signal?.addEventListener("abort", onReqAbort, { once: true });
  session.inflight?.add(ctl);
  try {
    const result = await abortable(tab.evaluate(expression), ctl.signal);
    if (session.controller === "user") throw takeoverError(session, true);
    return result;
  } finally {
    session.inflight?.delete(ctl);
    signal?.removeEventListener("abort", onReqAbort);
  }
};
