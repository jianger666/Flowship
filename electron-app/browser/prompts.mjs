/**
 * 「等待用户处理」的提示登记表（契约 §15.1）：每个浏览器会话一份。
 *
 * 用途：HTTP 认证（auth）/ 证书错误（cert）/ 页面权限（permission）/ evaluate 授权（evaluate）/ 客户端证书（clientcert）。
 * 共同点：事件来自页面或网络、要由**用户**在面板里决定、AI 不能代答，且超时必须有兜底（默认取消 / 拒绝）。
 *
 * 安全约束（红线 4 / 5）：
 *  - `list()` 只含展示字段（host / detail 里的短字符串）。凭据（auth 的用户名密码）只在 `answer()` 的参数里经过一次，
 *    直接交给 `request()` 的等待者，**不落状态、不进日志、不进活动日志、不给 AI**；
 *  - `detail` 的值来自页面 / 网络（realm、证书主题、权限名……），一律剥格式字符、限长后才进状态；
 *  - 同时挂起的提示数按 kind 分桶封顶（{@link PROMPT_KIND_LIMITS}），超出的直接按默认动作结束（带 `overflow: true`，不是 `timedOut`），免得页面刷提示；
 *  - 每个提示都有超时（调用方给，缺省 {@link DEFAULT_PROMPT_TIMEOUT_MS}），到点按 `defaultAction` 结束；`signal` 中止同样按默认动作结束。
 *
 * 纯模块：时钟与定时器可注入，单测不依赖真实时间。
 */

/**
 * 同一会话同时挂起的提示上限——**按 kind 分桶**（R6-19）。
 * 为什么不用一个全局上限：页面可以用 geolocation / notifications / midi / sensors × 多个 tab 刷满全局名额，
 * 让紧随其后的 evaluate / auth / cert 提示立刻走默认动作（对审批流的拒绝服务，还会被误报成「无人处理」）。
 * 分桶后页面能触发的 permission 桶最多占 4 个，其余各 kind 的名额是它们自己的保留位，互不挤占。
 */
export const PROMPT_KIND_LIMITS = Object.freeze({ permission: 4, auth: 3, cert: 3, evaluate: 2, clientcert: 2 });
/** 所有桶之和：会话里理论上最多同时挂起的提示数 */
export const MAX_PENDING_PROMPTS = Object.values(PROMPT_KIND_LIMITS).reduce((a, b) => a + b, 0);
/** 缺省超时：60 秒无人处理就取消（契约 A3） */
export const DEFAULT_PROMPT_TIMEOUT_MS = 60_000;

/**
 * R6-19：overflow 日志限速窗口。名额满（overflow）**不进拒绝冷却**（名额空出后同一主机仍要能被询问），
 * 所以页面在桶满期间每请求一次就会触发一次 overflow——决策照旧（立即按默认动作拒绝），但**日志**必须限速：
 * 活动日志是 500 条的环形缓冲，300 次请求写 300 条「提示太多」会把真实的用户 / 系统条目全部挤掉（AI 的 handback 也就读不到了）。
 * 限速只作用于「写日志」，不参与任何放行 / 拒绝决策。
 */
export const OVERFLOW_LOG_WINDOW_MS = 60_000;
/** 限速表的 key 上限（key 是提示的 kind，天然只有几个；封顶只是防御） */
const OVERFLOW_THROTTLE_MAX_KEYS = 32;

/**
 * overflow 日志限速器（每个会话每类提示一份，时钟可注入）：同一 key 在窗口内只放行第一条日志，其余只计数；
 * 窗口过后的下一次 overflow 放行，并把「上一条之后被吞掉的次数」带出去，写进那条日志里。
 * @param {{ now?: () => number, windowMs?: number }} [opts]
 */
export const createOverflowLogThrottle = ({ now = Date.now, windowMs = OVERFLOW_LOG_WINDOW_MS } = {}) => {
  /** @type {Map<string, { at: number, suppressed: number }>} */
  const slots = new Map();
  return {
    /** @returns {{ log: boolean, suppressed: number }} log=false：这次只计数、不要写日志；suppressed：这条日志之前被吞掉的次数 */
    take(key) {
      const k = String(key);
      const t = now();
      const slot = slots.get(k);
      // 时钟倒退（t < slot.at）按「窗口已过」处理，免得系统改时间后日志被永久吞掉
      if (slot && t >= slot.at && t - slot.at < windowMs) {
        slot.suppressed += 1;
        return { log: false, suppressed: 0 };
      }
      if (!slot && slots.size >= OVERFLOW_THROTTLE_MAX_KEYS) slots.clear();
      slots.set(k, { at: t, suppressed: 0 });
      return { log: true, suppressed: slot?.suppressed ?? 0 };
    },
    reset() {
      slots.clear();
    },
  };
};

/** 日志里带上「之前被吞掉的次数」的尾巴（0 次 = 空串） */
export const overflowSuppressedNote = (suppressed) =>
  Number.isFinite(suppressed) && suppressed > 0 ? `（上一条之后另有 ${Math.floor(suppressed)} 次同类请求同样按默认处理，未逐条记录）` : "";
/** detail 最多这么多个键、每个值最多这么多字符 */
const DETAIL_MAX_KEYS = 12;
const DETAIL_VALUE_MAX = 200;
const HOST_MAX = 120;

/** 每种提示允许的动作（回答里的 `action` 必须在其中；第一个是**默认动作**，超时 / 中止 / 溢出时用它） */
export const PROMPT_ACTIONS = Object.freeze({
  auth: Object.freeze(["cancel", "submit"]),
  cert: Object.freeze(["deny", "allow-host"]),
  permission: Object.freeze(["deny", "allow", "allow-session"]),
  evaluate: Object.freeze(["deny", "task", "always"]),
  clientcert: Object.freeze(["decline", "select"]),
});

export const PROMPT_KINDS = Object.freeze(Object.keys(PROMPT_ACTIONS));

const FORMAT_CHARS_RE = /[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}\p{Variation_Selector}\u{E0000}-\u{E007F}]/gu;

/** 页面 / 网络来的短文本 → 展示用：剥格式字符、折叠空白、限长 */
export const cleanPromptText = (value, max = DETAIL_VALUE_MAX) => {
  const flat = String(value ?? "")
    .replace(/\s+/g, " ")
    .replace(FORMAT_CHARS_RE, "")
    .trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
};

const cleanDetail = (detail) => {
  const out = {};
  if (!detail || typeof detail !== "object") return out;
  let n = 0;
  for (const [k, v] of Object.entries(detail)) {
    if (n >= DETAIL_MAX_KEYS) break;
    const key = cleanPromptText(k, 40);
    if (!key) continue;
    out[key] = cleanPromptText(v);
    n += 1;
  }
  return out;
};

/**
 * @param {{
 *   now?: () => number,
 *   setTimeoutFn?: typeof setTimeout,
 *   clearTimeoutFn?: typeof clearTimeout,
 *   onChange?: () => void,
 *   log?: (msg: string) => void,
 * }} [deps]
 */
export const createPromptHub = (deps = {}) => {
  const now = deps.now ?? Date.now;
  const setT = deps.setTimeoutFn ?? setTimeout;
  const clearT = deps.clearTimeoutFn ?? clearTimeout;
  const onChange = deps.onChange ?? (() => {});
  const log = deps.log ?? (() => {});
  /** R6-19：桶满时的进程日志也要限速（页面循环请求不能把主进程日志刷爆）；只管日志，不影响 overflow 的决策 */
  const overflowLog = createOverflowLogThrottle({ now });

  /** @type {Map<string, { info: any, resolve: (v: any) => void, timer: any, abortOff: (() => void) | null, validate: ((d: any) => any) | null }>} */
  const pending = new Map();
  let seq = 0;
  let disposed = false;

  const settle = (entry, decision) => {
    if (!pending.delete(entry.info.id)) return false;
    if (entry.timer !== null) clearT(entry.timer);
    entry.abortOff?.();
    try {
      entry.resolve(decision);
    } finally {
      onChange();
    }
    return true;
  };

  /**
   * 登记一个提示并等用户回答。返回 `{ action, ...payload, timedOut?, cancelled?, overflow? }`；永远不 reject（超时 / 中止 / 销毁 / 溢出都按默认动作 resolve），
   * 调用方只需要看 `action`。
   * @param {{
   *   kind: keyof typeof PROMPT_ACTIONS,
   *   tabId?: string,
   *   host?: string,
   *   detail?: Record<string, unknown>,
   *   timeoutMs?: number,
   *   signal?: AbortSignal,
   *   validate?: (decision: any) => any,
   * }} spec  validate：对回答的 payload 做校验 / 规整（返回规整后的对象；抛错 = 回答无效、提示保持挂起）
   */
  const request = (spec) => {
    const actions = PROMPT_ACTIONS[spec?.kind];
    if (!actions) return Promise.resolve({ action: "deny", cancelled: true });
    const defaultAction = actions[0];
    if (disposed) return Promise.resolve({ action: defaultAction, cancelled: true });
    const kindLimit = PROMPT_KIND_LIMITS[spec.kind] ?? 2;
    let sameKind = 0;
    for (const e of pending.values()) if (e.info.kind === spec.kind) sameKind += 1;
    if (sameKind >= kindLimit) {
      const slot = overflowLog.take(spec.kind);
      if (slot.log) log(`[browser:prompt] ${spec.kind} 类挂起的提示已达上限（${kindLimit}），按默认动作处理${overflowSuppressedNote(slot.suppressed)}`);
      // overflow ≠ timedOut：上层据此说「提示太多、已按默认拒绝」，不要误写成「无人处理」
      return Promise.resolve({ action: defaultAction, overflow: true });
    }
    const timeoutMs = Number.isFinite(spec.timeoutMs) && spec.timeoutMs > 0 ? spec.timeoutMs : DEFAULT_PROMPT_TIMEOUT_MS;
    const since = now();
    seq += 1;
    const info = {
      id: `p${seq}`,
      kind: spec.kind,
      ...(spec.tabId ? { tabId: String(spec.tabId) } : {}),
      host: cleanPromptText(spec.host ?? "", HOST_MAX),
      detail: cleanDetail(spec.detail),
      actions: [...actions],
      since,
      expiresAt: since + timeoutMs,
    };
    return new Promise((resolve) => {
      const entry = { info, resolve, timer: null, abortOff: null, validate: typeof spec.validate === "function" ? spec.validate : null };
      entry.timer = setT(() => {
        entry.timer = null;
        settle(entry, { action: defaultAction, timedOut: true });
      }, timeoutMs);
      entry.timer?.unref?.();
      const signal = spec.signal;
      if (signal) {
        const onAbort = () => settle(entry, { action: defaultAction, cancelled: true });
        if (signal.aborted) {
          // 同步中止：不进入挂起表
          clearT(entry.timer);
          entry.timer = null;
          resolve({ action: defaultAction, cancelled: true });
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
        entry.abortOff = () => signal.removeEventListener("abort", onAbort);
      }
      pending.set(info.id, entry);
      onChange();
    });
  };

  /**
   * 用户的回答（来自 IPC `prompt.answer`）。id 不存在 / 动作不在允许集合里 / 校验不过 → 返回 false 且提示保持挂起。
   * decision 里除 `action` 外的字段（如 auth 的 username / password）原样交给等待者，本模块不保存、不记录。
   */
  const answer = (id, decision) => {
    const entry = pending.get(String(id));
    if (!entry) return false;
    if (!decision || typeof decision !== "object" || typeof decision.action !== "string") return false;
    if (!entry.info.actions.includes(decision.action)) return false;
    let payload = decision;
    if (entry.validate) {
      try {
        payload = entry.validate(decision);
      } catch {
        return false;
      }
    }
    return settle(entry, { ...payload, action: decision.action });
  };

  /** 展示用列表（按挂起顺序）；不含任何回答内容 */
  const list = () => [...pending.values()].map((e) => ({ ...e.info, detail: { ...e.info.detail }, actions: [...e.info.actions] }));

  /** 当前挂起的某类提示（供 AI 结果里写「已请用户处理」；只给 kind / host / tabId / id） */
  const hints = (kind) =>
    [...pending.values()]
      .filter((e) => !kind || e.info.kind === kind)
      .map((e) => ({ id: e.info.id, kind: e.info.kind, host: e.info.host, ...(e.info.tabId ? { tabId: e.info.tabId } : {}) }));

  const size = () => pending.size;

  /** 取消某个提示（按默认动作结束） */
  const cancel = (id) => {
    const entry = pending.get(String(id));
    if (!entry) return false;
    return settle(entry, { action: entry.info.actions[0], cancelled: true });
  };

  /** 取消符合条件的全部提示（如 tab 关闭 / 导航离开：该 tab 上挂着的认证 / 证书 / 权限提示作废） */
  const cancelWhere = (pred) => {
    let n = 0;
    for (const entry of [...pending.values()]) {
      let hit = false;
      try {
        hit = pred(entry.info) === true;
      } catch {
        hit = false;
      }
      if (hit && settle(entry, { action: entry.info.actions[0], cancelled: true })) n += 1;
    }
    return n;
  };

  /** 会话销毁：全部按默认动作结束，之后的 request 一律立即按默认动作结束 */
  const dispose = () => {
    disposed = true;
    for (const entry of [...pending.values()]) settle(entry, { action: entry.info.actions[0], cancelled: true });
  };

  return { request, answer, list, hints, size, cancel, cancelWhere, dispose };
};
