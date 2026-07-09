/**
 * Agent ↔ server 信号桥 + ask 弹窗登记（V0.11 大幅瘦身）
 *
 * V0.11 背景：wait 协议退役（「单 Run 永生 + shell curl 长轮询」→「create + 多轮 send」）。
 * 原来这里是 submit_work / ask_user 的完整等待状态机（pendingMap / token / grace /
 * keepalive / submitXxx 信号 API、~1000 行）；新模型下 agent 说完自然结束 run、用户操作
 * 经 `agent.send()` 以新消息送达、不再有「阻塞等待」可 resolve。本文件只剩三块：
 *
 *   1. **pendingAsks**：ask_user 弹窗登记表（taskId → 当前未答的一组问题 + token）——
 *      ask-reply 路由校验「答案对应的还是当前这组问题」用（防旧弹窗答案串新提问）
 *   2. **notifier / task action handler 注册表**：runner ↔ chat-mcp 的回调桥（方向不变：
 *      task-runner → chat-mcp、chat-mcp 不反向 import runner）
 *   3. **buildAgentMessage**：用户操作 → 发给 agent 的消息文本（[NEXT_ACTION] / [USER_MESSAGE]
 *      revise] / [USER_REPLY] 头 + 附件段）——原 formatToolReturnAsText 的瘦身版、信号
 *      字面量与 prompts 的约定由 tests/protocol-signals.test.ts 守护
 *
 * 依赖方向（保证无环）：只依赖 types / protocol-signals、不 import chat-mcp / task-runner。
 */

import type { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import type { ActionType, PlanBatch } from "../types";
import { SIGNALS, buildNextActionHead } from "../protocol-signals";

// ----------------- 类型 -----------------

export type AskUserOption = { id: string; label: string };
export type AskUserQuestion = {
  id: string;
  question: string;
  options?: AskUserOption[];
  allowText: boolean;
};

// ask_user 弹窗登记：一个 task 同时最多一组未答问题（新提问顶旧的、旧弹窗答案按 token 拒）
export interface PendingAsk {
  askId: string;
  // 短 token：ask_user_request 事件 meta 里带给前端、答题时带回校验（防旧弹窗答案串新提问）
  token: string;
  questions: AskUserQuestion[];
  actionId?: string;
  createdAt: number;
}

export type AwaitingSignal =
  | {
      // agent 调 submit_work 交卷（V0.11 起非阻塞）：runner 据此跑后置 check + 切 awaiting_ack；
      // 不带 actionId 的调用（旧「待命态」姿势）只切 runStatus=awaiting_user
      kind: "awaiting_start";
      actionId?: string;
      artifactPath?: string;
    }
  | {
      // agent 调 ask_user：runner 写 ask_user_request 事件 + 切 runStatus=awaiting_user
      kind: "ask_user_request";
      askId: string;
      token: string;
      questions: AskUserQuestion[];
      actionId?: string;
    };

export type AwaitingNotifier = (signal: AwaitingSignal) => Promise<void> | void;

// task-scoped「同步 RPC」action（submit_mr / set_feishu_testers / set_plan_batches）——
// chat-mcp 工具收到调用后查表找 runner 注册的 handler 执行、拿结构化返回值
export type ChatTaskAction =
  | {
      kind: "submit_mr";
      actionId: string;
      /** 本地仓库绝对路径、agent 从 shell `pwd` 取（用于 server 端 sideEffects 落档时区分仓） */
      repoPath: string;
      /** GitLab project path（如 `wkid/crm-web`、从 remote.origin.url 解析） */
      projectPath: string;
      sourceBranch: string;
      targetBranch: string;
      title: string;
      description: string;
      lastCommitHash: string;
    }
  | {
      kind: "set_feishu_testers";
      /** 当前 ship action 的 id（让「已记忆测试人员」info 事件挂到该 action、跟 submit_mr 对齐） */
      actionId: string;
      /** 飞书项目 user_key 列表（空数组 = 显式记忆「没测试人 / 跳过 @」） */
      userKeys: string[];
    }
  | {
      kind: "set_plan_batches";
      /** 当前 plan action 的 id（批次落到这个 action 的 planBatches 字段） */
      actionId: string;
      /** plan 拆出的批次清单（数组顺序 = 建议 build 顺序） */
      batches: PlanBatch[];
    };

export type ChatTaskActionResult =
  | { ok: true; data?: Record<string, unknown> }
  | { ok: false; error: string };

export type ChatTaskActionHandler = (
  action: ChatTaskAction,
) => Promise<ChatTaskActionResult>;

// ----------------- 进程全局状态（挂 globalThis） -----------------
//
// Next.js dev 下不同 Route Handler 是不同 webpack chunk、module-level Map 各持一份
// 完全分裂（V0.3.3 实测踩过）——所有进程级状态挂 globalThis、所有 chunk 共享同一份。

interface ChatMcpGlobalState {
  // taskId → 当前未答的一组 ask_user 问题（新提问顶旧的）
  pendingAsks: Map<string, PendingAsk>;
  awaitingNotifiers: Map<string, AwaitingNotifier>;
  taskActionHandlers: Map<string, ChatTaskActionHandler>;
  sessionTransports: Map<string, WebStandardStreamableHTTPServerTransport>;
}

// V13：2026-07-07 V0.11 wait 协议退役——删 pendingMap / tokenToTask / waitingTasks /
//      pendingNextActions / unansweredRevises / chatModeTasks / prematureWaitRejects、
//      新增 pendingAsks（ask 弹窗登记）。bump 强制 dev hot reload 拿全新 state。
// V12 及更早见 git 历史（wait 协议时代的状态机字段）。
const GLOBAL_KEY = "__feAiFlowChatStateV13__";

const getGlobalState = (): ChatMcpGlobalState => {
  const g = globalThis as unknown as Record<string, ChatMcpGlobalState>;
  if (!g[GLOBAL_KEY]) {
    console.log("[chat-mcp] 初始化 globalThis 状态（首次）");
    g[GLOBAL_KEY] = {
      pendingAsks: new Map(),
      awaitingNotifiers: new Map(),
      taskActionHandlers: new Map(),
      sessionTransports: new Map(),
    };
  }
  return g[GLOBAL_KEY];
};

const pendingAsks = getGlobalState().pendingAsks;
const awaitingNotifiers = getGlobalState().awaitingNotifiers;
const taskActionHandlers = getGlobalState().taskActionHandlers;

// MCP session 表（sessionId → transport）：chat-mcp.ts handleChatMcpRequest 用
export const sessionTransports = getGlobalState().sessionTransports;

// ----------------- pendingAsks（ask 弹窗登记） -----------------

// 短 token：8 字符 base36、够防撞、不浪费 context（模型只透传、不需要 crypto 强度）
const newAskToken = (): string => Math.random().toString(36).slice(2, 10);

/** ask_user 工具 handler 调：登记一组新提问（顶掉旧的、旧弹窗答案会因 token 不符被拒） */
export const registerPendingAsk = (
  taskId: string,
  opts: { askId: string; questions: AskUserQuestion[]; actionId?: string },
): PendingAsk => {
  const ask: PendingAsk = {
    askId: opts.askId,
    token: newAskToken(),
    questions: opts.questions,
    actionId: opts.actionId,
    createdAt: Date.now(),
  };
  pendingAsks.set(taskId, ask);
  return ask;
};

/** 当前未答的一组 ask（没有返 null）——ask-reply 路由校验 / UI 状态判断用 */
export const getPendingAsk = (taskId: string): PendingAsk | null =>
  pendingAsks.get(taskId) ?? null;

/** 答完 / 作废时清登记 */
export const clearPendingAsk = (taskId: string): void => {
  pendingAsks.delete(taskId);
};

/**
 * 停止 / 重启 / 删除 task 时调：清掉未答的 ask 登记。
 * @returns 是否真的清了（调用方据此决定要不要写「已作废」事件）
 */
export const cancelPending = (taskId: string): boolean =>
  pendingAsks.delete(taskId);

/** 任务被永久删除时调：清掉所有跟它相关的进程级状态 */
export const cleanupChatTaskState = (taskId: string): void => {
  pendingAsks.delete(taskId);
  awaitingNotifiers.delete(taskId);
  taskActionHandlers.delete(taskId);
};

// ----------------- notifier / handler 注册表（runner ↔ chat-mcp 桥） -----------------

export const setChatAwaitingNotifier = (
  taskId: string,
  notifier: AwaitingNotifier | null,
): void => {
  if (notifier) {
    awaitingNotifiers.set(taskId, notifier);
  } else {
    awaitingNotifiers.delete(taskId);
  }
};

export const setChatTaskActionHandler = (
  taskId: string,
  handler: ChatTaskActionHandler | null,
): void => {
  if (handler) {
    taskActionHandlers.set(taskId, handler);
  } else {
    taskActionHandlers.delete(taskId);
  }
};

/**
 * conditional unset：只在「当前注册的就是 expected 这个实例」时才注销（V0.6.1 race fix 沿用）。
 * 换新 agent 时旧会话迟到的清理不能误清新会话刚注册的 handler / notifier。
 */
export const unsetChatTaskActionHandlerIf = (
  taskId: string,
  expected: ChatTaskActionHandler,
): void => {
  if (taskActionHandlers.get(taskId) === expected) {
    taskActionHandlers.delete(taskId);
  }
};

/** 同 unsetChatTaskActionHandlerIf、对 awaitingNotifier 做 conditional unset */
export const unsetChatAwaitingNotifierIf = (
  taskId: string,
  expected: AwaitingNotifier,
): void => {
  if (awaitingNotifiers.get(taskId) === expected) {
    awaitingNotifiers.delete(taskId);
  }
};

// 跑 task-scoped action handler、序列化结果给 MCP 工具返
export const runTaskAction = async (
  taskId: string,
  action: ChatTaskAction,
): Promise<ChatTaskActionResult> => {
  const handler = taskActionHandlers.get(taskId);
  if (!handler) {
    return {
      ok: false,
      error: `task=${taskId} 没注册 handler（task 没在跑 / 已结束、不应该调本工具）`,
    };
  }
  try {
    return await handler(action);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `handler 抛错：${msg}` };
  }
};

export const safeNotifyAwaiting = async (
  taskId: string,
  opts: { actionId?: string; artifactPath?: string } = {},
): Promise<void> => {
  const notifier = awaitingNotifiers.get(taskId);
  if (!notifier) {
    console.warn(
      `[chat-mcp] safeNotifyAwaiting: 没找到 task=${taskId} 的 notifier（已注册 ${awaitingNotifiers.size} 个）`,
    );
    return;
  }
  try {
    await notifier({
      kind: "awaiting_start",
      actionId: opts.actionId,
      artifactPath: opts.artifactPath,
    });
  } catch (err) {
    console.error("[chat-mcp] awaiting notifier failed:", err);
  }
};

export const safeNotifyAskUserRequest = async (
  taskId: string,
  args: {
    askId: string;
    token: string;
    questions: AskUserQuestion[];
    actionId?: string;
  },
): Promise<void> => {
  const notifier = awaitingNotifiers.get(taskId);
  if (!notifier) {
    console.warn(
      `[chat-mcp] safeNotifyAskUserRequest: 没找到 task=${taskId} 的 notifier（已注册 ${awaitingNotifiers.size} 个）`,
    );
    return;
  }
  try {
    await notifier({
      kind: "ask_user_request",
      askId: args.askId,
      token: args.token,
      questions: args.questions,
      actionId: args.actionId,
    });
  } catch (err) {
    console.error("[chat-mcp] ask_user_request notifier failed:", err);
  }
};

// ----------------- buildAgentMessage：用户操作 → agent.send 的消息文本 -----------------

/**
 * 用户操作载荷（V0.11：原 wait 协议 ToolReturn 的瘦身版；
 * V0.13.x：action_revise 并入 user_message——「再聊聊 / 问一问」统一成一条消息语义、
 * AI 自主二分类；approve / 终态不需要通知 agent）
 */
export type AgentMessage = {
  // user_reply：chat 消息 / ask_user 答案（[ASK_USER_REPLY] Q&A 块由 route 拼好传入）
  // next_action：用户在 UI 推进新 action（续用会话时）
  // user_message：任务页输入条的任何消息（V0.13.x 统一语义）——AI 自主判断问 / 改
  kind: "user_reply" | "next_action" | "user_message";
  text: string;
  // 图片附件绝对路径（拼 [ATTACHED_IMAGES] 段、agent 用 read 工具看图）
  imagePaths?: string[];
  // 文件 / 目录附件绝对路径（拼 [ATTACHED_PATHS] 段）
  attachmentPaths?: string[];
  // user_message：当前有产出在等审阅时的上下文（服务端附加、要求处理完重新交卷）
  ackContext?: { actionId: string; artifactPath?: string };
  // next_action 的元数据（拼 [NEXT_ACTION ...] 头）
  nextActionId?: string;
  nextActionType?: ActionType;
  nextN?: number;
  nextArtifactPath?: string;
};

/**
 * 把用户操作序列化成发给 agent 的消息文本（`agent.send(text)`）。
 * 头部信号字面量（[NEXT_ACTION] / [USER_MESSAGE] / [USER_REPLY]…）与 prompts 的
 * 解读约定一致、由 tests/protocol-signals.test.ts 守护。
 */
export const buildAgentMessage = (msg: AgentMessage): string => {
  const attachmentSections = (m: AgentMessage): string[] => {
    const lines: string[] = [];
    if (m.imagePaths && m.imagePaths.length > 0) {
      lines.push(
        "",
        `${SIGNALS.ATTACHED_IMAGES} 用户附了以下图片、请用 \`read\` 工具逐一读取（SDK 内置 \`read\` 会把图片转成 vision、你能直接看到图像内容）：`,
        ...m.imagePaths.map((p, i) => `  ${i + 1}. ${p}`),
      );
    }
    if (m.attachmentPaths && m.attachmentPaths.length > 0) {
      lines.push(
        "",
        `${SIGNALS.ATTACHED_PATHS} 用户附了以下文件 / 目录路径、按需用 \`read\` / \`grep\` / \`glob\` 读取（路径已是绝对路径、直接用）：`,
        ...m.attachmentPaths.map((p, i) => `  ${i + 1}. ${p}`),
      );
    }
    return lines;
  };

  if (msg.kind === "next_action") {
    const head = buildNextActionHead({
      actionId: msg.nextActionId,
      actionType: msg.nextActionType,
      n: msg.nextN,
      artifactPath: msg.nextArtifactPath,
    });
    const lines: string[] = [head];
    if (msg.text && msg.text.trim()) lines.push("", msg.text);
    lines.push(...attachmentSections(msg));
    return lines.join("\n");
  }
  if (msg.kind === "user_message") {
    // V0.13.x 统一消息（用户拍板「别这么多分支、AI 自主判断」）：行为约束内联在消息里
    //（比只靠 prompt 教稳）。有产出在等审阅时附上下文、要求处理完重新交卷（原 revise 语义）。
    const lines: string[] = [
      SIGNALS.USER_MESSAGE,
      "",
      msg.text,
      ...attachmentSections(msg),
      "",
    ];
    if (msg.ackContext) {
      // 「〈产出审阅中〉」字面量必须保留——_super.md 教 agent 的判卷闸门就是这个词
      //（审计揪过：文案与 prompt 字面对不上、agent 可能漏交卷）
      lines.push(
        `〈产出审阅中〉你有一份产出正在等用户审阅（action_id=${msg.ackContext.actionId}${msg.ackContext.artifactPath ? `、artifact=${msg.ackContext.artifactPath}` : ""}）。先判断这条消息的性质：**纯疑问**就直接回答、别把问题当成改动指令；**修改意见**才动 artifact / 代码（模糊的先 ask_user 复述确认）。无论问还是改、处理完都要调 submit_work（同 action_id）重新交卷、然后结束回复。`,
      );
    } else {
      lines.push(
        "（这是任务过程中用户的插话、不是推进指令。先判断性质：**纯疑问**就直接回答、别把问题当成改动指令；**修改要求**才动手改（改完说明改了什么）。不要调 submit_work / submit_mr 推进任务链——进度停在原地、等用户自己推进。处理完自然结束本轮回复。）",
      );
    }
    return lines.join("\n");
  }
  // user_reply
  const lines: string[] = [SIGNALS.USER_REPLY, "", msg.text];
  lines.push(...attachmentSections(msg));
  return lines.join("\n");
};
