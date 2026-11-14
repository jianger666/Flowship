/**
 * 路径 3：用户在浏览器面板点「交还给 AI」→ 主进程发 `evt handback { note, entries }` → 这里把它注入该任务。
 *
 * # 走哪条注入通道
 * 与定时到点同款：chat 走 `handleChatReplyInject`、task 走 `handleTaskQuestionInject`，带 `scheduledTrigger: true`。
 * 白拿的既有语义：会话被回收先恢复再送、AI 正在跑时不并发（见下面的重试）、事件落盘 + 推流。
 * 之所以借 `scheduledTrigger`（而不是当普通用户消息）：交还不是「用户回答了某个提问」——
 * ① 不认领 askSkip（用户还没答的 ask_user 不该被「交还浏览器」顶掉）；
 * ② 不 snapshot 产物 / 不把 awaiting_ack 的 action 打回 running；
 * ③ 不唤醒已停止 / 出错 / 等审阅的阶段（会话没了走一次性 agent）。
 *
 * # 气泡 vs 给 AI 的话
 * - 气泡（user_reply.text）只放用户自己写的话；没写就放一句「已把浏览器交还给 AI」；
 * - 操作摘要走 `agentContext`（只给 agent、不进气泡）——摘要是机器生成的、可能很长，不该冒充用户说的话。
 *
 * # 安全：交还消息不算「用户又说话了」
 * `meta.source = "browser"`，**不在** advance-chain 的 USER_OWN_SOURCES 白名单（只认无 source 与 feishu）里：
 * 不会触发「登记后用户又插话 → 取消自动推进」的判定（那走 isUserOwnWordsEvent）——用户在浏览器里点点点、
 * 或页面诱导用户点「交还」，都不是「用户又说话了」。白名单本身不动；tests/browser-handback.test.ts 钉死这点。
 * 用户亲手写的 note 同样按 browser 来源标。
 *
 * # 为什么动态 import 重模块
 * 本文件由 feishu-bridge/bootstrap 的锚点加载（它的模块图本来就含 @cursor/sdk）；但单测只想验证逻辑，
 * 所以 chat-inject / task-question-inject / schedule-service 在默认依赖里按需 import，测试注入假依赖即可。
 */

import { randomUUID } from "node:crypto";

import { formatUserActivity } from "./activity";
import { getBrowserBridge } from "./bridge";
import type { BrowserActivityEntry } from "./types";

export const HANDBACK_SOURCE = "browser";
/** 用户没写话时气泡里的文字 */
export const HANDBACK_DEFAULT_TEXT = "（已把浏览器交还给 AI）";
const NOTE_MAX_CHARS = 2000;
/** 会话暂时送不进（AI 正在跑 / 有未答提问）时的重试节奏与上限：10 分钟后放弃并告知用户 */
export const HANDBACK_RETRY_MS = 5000;
export const HANDBACK_RETRY_MAX = 120;

export interface HandbackPayload {
  note: string;
  entries: BrowserActivityEntry[];
}

export type HandbackOutcome =
  | { kind: "delivered" }
  | { kind: "retry"; reason: string }
  | { kind: "failed"; reason: string; permanent?: boolean };

/** 注入通道的最小抽象（默认实现见 {@link defaultHandbackDeps}；测试注入假的） */
export interface HandbackDeps {
  /** 一次尝试送进会话；返回分类后的结果 */
  deliver: (input: {
    taskId: string;
    /** 气泡文字 */
    text: string;
    /** 只给 agent 的上下文（操作摘要） */
    agentContext: string;
    /** 跨重试稳定的幂等键 */
    clientItemId: string;
    meta: Record<string, unknown>;
  }) => Promise<HandbackOutcome>;
  /** 最终没送进去时，给用户一条可见提示 */
  notifyFailure: (taskId: string, text: string) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** 宽松解析主进程 evt 的 data：note 截断、entries 只留结构合格的 user/system 条目 */
export const parseHandbackData = (data: unknown): HandbackPayload => {
  const d = isRecord(data) ? data : {};
  const noteRaw = typeof d.note === "string" ? d.note.trim() : "";
  const entries: BrowserActivityEntry[] = [];
  if (Array.isArray(d.entries)) {
    for (const e of d.entries) {
      if (!isRecord(e)) continue;
      if (typeof e.summary !== "string" || !e.summary) continue;
      if (e.actor !== "user" && e.actor !== "system") continue;
      entries.push({
        id: typeof e.id === "number" ? e.id : entries.length,
        ts: typeof e.ts === "number" ? e.ts : 0,
        actor: e.actor,
        kind: typeof e.kind === "string" ? e.kind : "unknown",
        tabId: typeof e.tabId === "string" ? e.tabId : undefined,
        url: typeof e.url === "string" ? e.url : undefined,
        summary: e.summary,
      });
    }
  }
  return {
    note: noteRaw.length > NOTE_MAX_CHARS ? `${noteRaw.slice(0, NOTE_MAX_CHARS)}…` : noteRaw,
    entries,
  };
};

/** 给 agent 的上下文：操作摘要（页面文字已按不可信包装）；没有操作也要说清「控制权回来了」 */
export const buildHandbackAgentContext = (payload: HandbackPayload): string => {
  if (payload.entries.length === 0) {
    return "[浏览器·用户交还了操作权] 用户没有在浏览器里做额外的操作。浏览器现在由你控制，需要时先 browser_snapshot 看当前页面。";
  }
  return formatUserActivity(payload.entries, {
    header: "[浏览器·用户交还了操作权] 用户刚才在浏览器里做了：",
    hint: "浏览器现在由你控制，先 browser_snapshot 看当前页面再继续。",
  });
};

/**
 * 处理一次交还。送不进（暂时）按固定间隔重试，直到成功 / 永久失败 / 超过上限；
 * 永久失败或放弃时写一条提示，免得用户以为 AI 已经收到。永不抛。
 */
export const deliverBrowserHandback = async (
  taskId: string,
  data: unknown,
  deps: HandbackDeps,
): Promise<HandbackOutcome> => {
  const payload = parseHandbackData(data);
  const text = payload.note || HANDBACK_DEFAULT_TEXT;
  const agentContext = buildHandbackAgentContext(payload);
  const clientItemId = `browser-handback-${randomUUID()}`;
  const meta: Record<string, unknown> = {
    source: HANDBACK_SOURCE,
    subkind: "handback",
    browserEntryCount: payload.entries.length,
  };

  let last: HandbackOutcome = { kind: "failed", reason: "未尝试" };
  for (let attempt = 0; attempt < HANDBACK_RETRY_MAX; attempt += 1) {
    try {
      last = await deps.deliver({ taskId, text, agentContext, clientItemId, meta });
    } catch (err) {
      last = { kind: "failed", reason: err instanceof Error ? err.message : String(err) };
    }
    if (last.kind === "delivered") return last;
    if (last.kind === "failed") break;
    await deps.sleep(HANDBACK_RETRY_MS);
  }
  // 走到这里 last 必然是 retry（超过重试上限）或 failed；用 in 判断是为了不依赖 TS 对循环内赋值的收窄结果
  const reason = "reason" in last ? last.reason : "";
  console.warn(`[browser-handback] 交还没能送进会话 task=${taskId}：${reason}`);
  try {
    await deps.notifyFailure(
      taskId,
      `你把浏览器交还给 AI 了，但这条消息没能送进会话：${reason}。需要的话直接在输入框告诉 AI 一声。`,
    );
  } catch {
    // 提示写不进去（任务已删等）就算了
  }
  return last;
};

/** 默认依赖：真实注入通道（按需 import，避免本文件在被测试直接 import 时拖进 @cursor/sdk） */
export const defaultHandbackDeps: HandbackDeps = {
  deliver: async ({ taskId, text, agentContext, clientItemId, meta }) => {
    const [{ getTaskMeta }, { getPendingAsk }, scheduleService, runner] = await Promise.all([
      import("../task-fs"),
      import("../chat-pending"),
      import("../schedule-service"),
      import("../schedule-runner"),
    ]);
    const task = await getTaskMeta(taskId);
    if (!task) return { kind: "failed", reason: "会话已不存在", permanent: true };
    if (task.archived) return { kind: "failed", reason: "会话已归档", permanent: true };
    if (task.repoStatus === "merged" || task.repoStatus === "abandoned") {
      return { kind: "failed", reason: `任务已${task.repoStatus === "merged" ? "合入" : "放弃"}`, permanent: true };
    }
    // 有用户还没答的提问：和定时同口径，不去打断，等答完再送
    if (getPendingAsk(taskId) || task.pendingAskId) {
      return { kind: "retry", reason: "有未答的提问，等你答完再送" };
    }
    const boot = await scheduleService.loadBootArgs(task);
    if (!boot) return { kind: "failed", reason: "缺少 API Key 或模型，请先在设置页配置" };
    if ("danglingProvider" in boot) return { kind: "failed", reason: boot.danglingProvider };

    const body = { text, bootArgs: boot, clientItemId };
    const options = { userReplyMetaExtra: meta, scheduledTrigger: true, agentContext };
    const res =
      task.mode === "chat"
        ? await (await import("../chat-inject")).handleChatReplyInject(taskId, body, options)
        : await (await import("../task-question-inject")).handleTaskQuestionInject(taskId, body, options);
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    return runner.classifyInjectResponse(res.status, json);
  },
  notifyFailure: async (taskId, text) => {
    const { writeEventAndPublish } = await import("../task-stream");
    await writeEventAndPublish(taskId, {
      kind: "info",
      text,
      meta: { source: HANDBACK_SOURCE, subkind: "handback_failed" },
    });
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

const REGISTERED_KEY = "__flowshipBrowserHandbackRegisteredV1__";

/**
 * 挂上 `evt handback` 处理器（幂等，globalThis 守护）。
 * 由飞书桥接 bootstrap 的锚点调用——instrumentation 不能加载这条重链（见 instrumentation-node 注释）。
 * 处理器注册前到达的 handback 会被 bridge 短暂缓存、注册后补发。
 */
export const ensureBrowserHandbackRegistered = (): void => {
  const g = globalThis as unknown as Record<string, boolean | undefined>;
  if (g[REGISTERED_KEY]) return;
  const bridge = getBrowserBridge();
  // 没有桥（无 IPC 通道）：不标记已注册，之后（比如测试里换了 override）还能再挂
  if (!bridge) return;
  g[REGISTERED_KEY] = true;
  bridge.onEvent("handback", ({ taskId, data }) => {
    void deliverBrowserHandback(taskId, data, defaultHandbackDeps);
  });
};

/** 仅测试：清注册标记 */
export const __resetBrowserHandbackForTest = (): void => {
  delete (globalThis as unknown as Record<string, boolean | undefined>)[REGISTERED_KEY];
};
