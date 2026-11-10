/**
 * server ⇄ 主进程 的 Node ipc 通道（契约 §4）：协议收发与分发，纯逻辑、不 import electron。
 *
 * 可注入假 proc：只要有 `send(msg, cb?)` / `on("message" | "exit" | "disconnect", fn)` 即可，
 * 所以单测不需要真起子进程；真 proc 来自 main.js 里 spawn(...,{ stdio:[…,"ipc"] }) 的返回值。
 *
 * 同时放在这里的 `BrowserError` / 错误码：它们是 §4.2 协议的一部分，session / tab / actions 都要抛，
 * 放协议模块里避免它们互相 import 成环。
 */

/** §4.2 错误码全集（顺序即契约顺序，测试按它对账） */
export const BROWSER_ERROR_CODES = Object.freeze([
  "NO_SESSION",
  "USER_CONTROL",
  "USER_TOOK_OVER",
  "URL_BLOCKED",
  "REF_STALE",
  "REF_NOT_FOUND",
  "NOT_INTERACTABLE",
  "TIMEOUT",
  "NAV_FAILED",
  "TAB_NOT_FOUND",
  "CANCELLED",
  "DISABLED",
  "BAD_ARGS",
  "INTERNAL",
  // 增强包 E2（契约 §15）：设置里关着的能力 / 用户拒绝了审批或提示 / 当前环境做不到
  "ACCESS_DISABLED",
  "DENIED",
  "UNSUPPORTED",
]);

/** 带协议错误码的异常：分发层把它原样转成 `res ok:false`，其余异常一律折成 INTERNAL */
export class BrowserError extends Error {
  /**
   * @param {string} code BROWSER_ERROR_CODES 之一
   * @param {string} message 中文、写成「模型 / 用户能照着自修复」的话
   */
  constructor(code, message) {
    super(message);
    this.name = "BrowserError";
    this.code = code;
  }
}

/** 任何值 → 协议错误对象。非 BrowserError 的异常统一 INTERNAL，且不把栈 / 页面内容带出去 */
export const toErrorPayload = (err) => {
  if (err instanceof BrowserError) return { code: err.code, message: err.message };
  const msg = typeof err?.message === "string" ? err.message : String(err);
  return { code: "INTERNAL", message: `浏览器内部错误：${msg.slice(0, 300)}` };
};

const PROTOCOL_VERSION = 1;
const CAPABILITIES = Object.freeze(["browser.v1"]);

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * @param {{
 *   proc: { send?: Function, on: Function, off?: Function, removeListener?: Function, connected?: boolean },
 *   dispatch: (op: string, args: object, ctx: { taskId: string, signal: AbortSignal }) => Promise<unknown>,
 *   platform?: string,
 *   onConfig?: (cfg: { recordInputValues?: boolean, evaluateEnabled?: boolean }) => void,
 *   onCancel?: (taskId: string) => void,
 *   log?: (msg: string) => void,
 * }} deps
 */
export const createServerChannel = ({
  proc,
  dispatch,
  platform = process.platform,
  onConfig,
  onCancel,
  log = () => {},
}) => {
  let closed = false;
  /** id → { taskId, controller }：挂起中的请求（取消 / 断线时按它统一 abort） */
  const pending = new Map();

  /** 真正调 proc.send；失败时把异常带回去（调用方据此决定要不要降级），不抛 */
  const rawSend = (msg) => {
    if (closed) return { sent: false };
    // proc.connected === false：通道已断（server 退出 / 断线），send 会抛 ERR_IPC_CHANNEL_CLOSED
    if (proc.connected === false || typeof proc.send !== "function") return { sent: false };
    try {
      // 默认的 json 序列化发生在 proc.send 同步段内：result 含 BigInt / 循环引用时这里会抛 TypeError
      proc.send({ v: PROTOCOL_VERSION, ...msg }, (err) => {
        if (err) log(`[browser-channel] 发送失败 kind=${msg.kind}：${err.message}`);
      });
      return { sent: true };
    } catch (err) {
      log(`[browser-channel] 发送异常 kind=${msg.kind}：${err?.message || err}`);
      return { sent: false, err };
    }
  };

  const send = (msg) => {
    const first = rawSend(msg);
    if (first.sent) return true;
    // R1-31：成功响应发不出去（几乎都是 result 不可序列化）时 server 永远收不到这个 id 的 res，只能干等到超时。
    // 降级成 ok:false 的 res（只含字符串，必定可序列化）让它立刻拿到可读的原因；通道真的断了则这次也会失败，照旧返回 false。
    if (first.err && msg.kind === "res" && msg.ok === true) {
      const reason = String(first.err?.message || first.err).slice(0, 120);
      return rawSend({
        kind: "res",
        id: msg.id,
        ok: false,
        error: {
          code: "INTERNAL",
          message: `浏览器内部错误：操作的结果无法序列化后回传（${reason}）。操作本身可能已经执行，请先 browser_snapshot 确认页面当前状态，再决定是否重试`,
        },
      }).sent;
    }
    return false;
  };

  const respondOk = (id, result) => send({ kind: "res", id, ok: true, result: result === undefined ? null : result });
  const respondErr = (id, err) => send({ kind: "res", id, ok: false, error: toErrorPayload(err) });

  const handleReq = (msg) => {
    const { id, taskId, op } = msg;
    const args = msg.args === undefined ? {} : msg.args;
    // 形状不对的请求：能回就回 BAD_ARGS（id 合法时），否则只能丢
    if (typeof id !== "number" || !Number.isFinite(id)) {
      log("[browser-channel] 丢弃 req：id 不是数字");
      return;
    }
    // R1-31：id 仍在途时一律静默丢弃（只记日志），**必须排在形状校验之前**。
    // 回 res 的话 server 侧按 id 对账，会把这条响应当成在途请求的结果、真实结果随后到达时已无人认领。
    if (pending.has(id)) {
      log(`[browser-channel] 丢弃 req：id=${id} 仍在处理中（重复 id），不回包以免冲掉在途请求的结果`);
      return;
    }
    if (typeof taskId !== "string" || taskId === "" || taskId.length > 200 || typeof op !== "string" || !isObject(args)) {
      respondErr(id, new BrowserError("BAD_ARGS", "请求格式错误：需要 taskId(string)、op(string)、args(object)"));
      return;
    }
    const controller = new AbortController();
    pending.set(id, { taskId, controller });
    // 用 async 包一层：dispatch 同步抛错也走统一的错误转换，「主进程对单个 req 不得抛出到顶层」
    void (async () => dispatch(op, args, { taskId, signal: controller.signal }))()
      .then(
        (result) => respondOk(id, result),
        (err) => respondErr(id, err),
      )
      .finally(() => pending.delete(id));
  };

  const abortTask = (taskId, reason) => {
    for (const entry of pending.values()) {
      if (entry.taskId === taskId && !entry.controller.signal.aborted) entry.controller.abort(reason);
    }
  };

  /** R6-17：只中止某一个在途请求（server 本地超时时发 `cancel{id}`）；taskId 必须对得上，免得别的任务的请求被误杀 */
  const abortRequest = (id, taskId, reason) => {
    const entry = pending.get(id);
    if (entry && entry.taskId === taskId && !entry.controller.signal.aborted) entry.controller.abort(reason);
  };

  const handleMessage = (msg) => {
    if (closed) return;
    if (!isObject(msg) || msg.v !== PROTOCOL_VERSION || typeof msg.kind !== "string") {
      log("[browser-channel] 忽略不认识的消息（缺 v:1 / kind）");
      return;
    }
    try {
      switch (msg.kind) {
        case "hello":
          send({ kind: "hello-ack", platform, capabilities: [...CAPABILITIES] });
          return;
        case "config":
          if (isObject(msg)) {
            const cfg = {};
            if (typeof msg.recordInputValues === "boolean") cfg.recordInputValues = msg.recordInputValues;
            if (typeof msg.evaluateEnabled === "boolean") cfg.evaluateEnabled = msg.evaluateEnabled;
            // 增强包 E2（契约 §15）：布尔项只认 boolean；maxTabs 只认 5–60 的整数；缺省 = 不改（沿用主进程默认）
            for (const k of ["storageAccess", "pagePermissions", "trustLoopbackCerts", "networkBodyRead"]) {
              if (typeof msg[k] === "boolean") cfg[k] = msg[k];
            }
            if (Number.isInteger(msg.maxTabs) && msg.maxTabs >= 5 && msg.maxTabs <= 60) cfg.maxTabs = msg.maxTabs;
            onConfig?.(cfg);
          }
          return;
        case "req":
          handleReq(msg);
          return;
        case "cancel":
          if (typeof msg.taskId === "string" && msg.taskId) {
            // R6-40：任务级取消只认**显式不带 `id` 键**的报文（bridge.ts 的 `cancel(taskId)` / signal abort 正是这样发的）。
            // 带了 `id` 键就必须是有限整数 = 单请求取消；`"1"` / `null`（JSON 会把 NaN / Infinity 序列化成 null）/ `1.5` / 对象……一律忽略并记日志，
            // 绝不降级成任务级取消——畸形 / 版本错位的一条报文不能中止整个任务的浏览器动作（也不能清掉同任务的 wait / ask 挂起态）。
            if (Object.hasOwn(msg, "id")) {
              if (Number.isInteger(msg.id)) {
                // 单请求取消（server 本地超时）：只中止它；不调 onCancel（那是「整个任务被停」的语义：会清掉同任务的 wait / ask 挂起态）
                abortRequest(msg.id, msg.taskId, new BrowserError("CANCELLED", "浏览器操作在 server 侧已超时，主进程已取消它"));
              } else {
                log(`[browser-channel] 忽略 cancel：id 存在但不是有限整数（${msg.id === null ? "null" : typeof msg.id}），不降级成任务级取消`);
              }
              return;
            }
            abortTask(msg.taskId, new BrowserError("CANCELLED", "AI 本轮已被停止，等待中的浏览器操作已取消"));
            onCancel?.(msg.taskId);
          }
          return;
        default:
          log(`[browser-channel] 忽略未知 kind=${msg.kind}`);
      }
    } catch (err) {
      // 分发层任何意外都不能冒到 process 'message' 的回调之外
      log(`[browser-channel] 处理消息异常 kind=${msg.kind}：${err?.message || err}`);
    }
  };

  const close = () => {
    if (closed) return;
    // 先 abort 再标记 closed：挂起的 wait_for / ask_user_to_act 要以 CANCELLED 收尾（释放会话状态），
    // 只是回包发不出去了（对端已没了）
    for (const entry of pending.values()) {
      if (!entry.controller.signal.aborted) {
        entry.controller.abort(new BrowserError("CANCELLED", "与 server 的通道已断开，等待中的浏览器操作已取消"));
      }
    }
    closed = true;
    pending.clear();
    detach();
  };

  const onMessage = (m) => handleMessage(m);
  const onGone = () => close();
  const detach = () => {
    const off = (ev, fn) => (proc.off ?? proc.removeListener)?.call(proc, ev, fn);
    off("message", onMessage);
    off("exit", onGone);
    off("disconnect", onGone);
  };

  proc.on("message", onMessage);
  proc.on("exit", onGone);
  proc.on("disconnect", onGone);

  return {
    /** 单测直接喂消息用；生产里由 proc 'message' 驱动 */
    handleMessage,
    /** main → server 的事件（handback / session_closed）。通道已断返回 false，调用方只记日志、不重试 */
    sendEvent: (name, taskId, data) => send({ kind: "evt", name, taskId, data: data ?? {} }),
    close,
    isClosed: () => closed,
    pendingCount: () => pending.size,
  };
};
