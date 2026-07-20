/**
 * 飞书侧命令词全套（决策 #13 / #17 / #21 + 矩阵命令行）
 *
 * /help（控制面板卡）/new /stop（直发 = 清理卡、回复锚定 = 停运行）/status
 * （/history /compact /list 已砍——使用频率极低、清理入口并进 /stop 卡、2026-07-20 用户拍板）
 * 文本回执走 sendTextMessage(owner)；清理卡 / 面板卡走 sendInteractiveCard。
 */

import { handleChatReplyInject } from "@/lib/server/chat-inject";
import { stopTaskAgent } from "@/lib/server/stop-task";
import { getTask } from "@/lib/server/task-fs";

import { getCurrentChatTaskId } from "./bridge-state";
import { findTaskByMessageId, rememberCardMessage } from "./card-map";
import {
  buildCleanupCardJson,
  buildHelpPanelCardJson,
} from "./control-cards";
import { getBridgeRuntimeStatus } from "./inbound";
import {
  getBotAppInfo,
  sendInteractiveCard,
  sendTextMessage,
} from "./lark-api";
import {
  createChatTaskForBridge,
  listActiveChatTasks,
  loadBridgeBootContext,
  registerBridgeCommand,
  type BridgeCommandHandler,
  resolveReplyAnchorIds,
  reviveChatByAnchor,
  sendTaskBoundText,
} from "./router";

/**
 * 命令清单文本版（控制面板卡正文；欢迎语只指到 /help、不重复整段）。
 * T8 用户点名：逐行带一句说明。
 */
const HELP_TEXT = [
  "/new [消息] — 开新对话（可带首条消息）",
  "/stop — 弹对话清理卡（结束不要的对话）",
  "/status — 桥接运行状态",
  "/help — 本面板",
].join("\n");

const REG_KEY = "__flowshipFeishuBridgeCommandsV1__";

type CommandsGlobal = { registered: boolean };

const getReg = (): CommandsGlobal => {
  const g = globalThis as unknown as Record<string, CommandsGlobal | undefined>;
  if (!g[REG_KEY]) g[REG_KEY] = { registered: false };
  return g[REG_KEY]!;
};

// ----------------- 可注入依赖（单测 mock） -----------------

type CommandsDeps = {
  getBotAppInfo: typeof getBotAppInfo;
  sendTextMessage: typeof sendTextMessage;
  sendInteractiveCard: typeof sendInteractiveCard;
  listActiveChatTasks: typeof listActiveChatTasks;
  getBridgeRuntimeStatus: typeof getBridgeRuntimeStatus;
  findTaskByMessageId: typeof findTaskByMessageId;
  /** 清理卡出卡后记 card-map（taskId 空串、仅供 card-action 反查 cardId patch） */
  rememberCardMessage: typeof rememberCardMessage;
  createChatTaskForBridge: typeof createChatTaskForBridge;
  loadBridgeBootContext: typeof loadBridgeBootContext;
  handleChatReplyInject: typeof handleChatReplyInject;
  getTask: typeof getTask;
  stopTaskAgent: typeof stopTaskAgent;
  /** 回复锚定解析（事件缺 root/parent 时 REST 反查）——与 router 注入侧同源 */
  resolveReplyAnchorIds: typeof resolveReplyAnchorIds;
  /** task 绑定类回执（记 card-map、回复它可锚定）——与 router 同源 */
  sendTaskBoundText: typeof sendTaskBoundText;
  /** 锚定命中的复活 + 指针切换——与 router 同源 */
  reviveChatByAnchor: typeof reviveChatByAnchor;
  getCurrentChatTaskId: typeof getCurrentChatTaskId;
};

let deps: CommandsDeps = {
  getBotAppInfo,
  sendTextMessage,
  sendInteractiveCard,
  listActiveChatTasks,
  getBridgeRuntimeStatus,
  findTaskByMessageId,
  rememberCardMessage,
  createChatTaskForBridge,
  loadBridgeBootContext,
  handleChatReplyInject,
  getTask,
  stopTaskAgent,
  resolveReplyAnchorIds,
  sendTaskBoundText,
  reviveChatByAnchor,
  getCurrentChatTaskId,
};

/** 单测替换；传 null 恢复 */
export const __setCommandsDepsForTest = (
  partial: Partial<CommandsDeps> | null,
): void => {
  if (!partial) {
    deps = {
      getBotAppInfo,
      sendTextMessage,
      sendInteractiveCard,
      listActiveChatTasks,
      getBridgeRuntimeStatus,
      findTaskByMessageId,
      rememberCardMessage,
      createChatTaskForBridge,
      loadBridgeBootContext,
      handleChatReplyInject,
      getTask,
      stopTaskAgent,
      resolveReplyAnchorIds,
      sendTaskBoundText,
      reviveChatByAnchor,
      getCurrentChatTaskId,
    };
    return;
  }
  deps = { ...deps, ...partial };
};

const replyOwner = async (text: string): Promise<void> => {
  const info = await deps.getBotAppInfo();
  await deps.sendTextMessage(info.ownerOpenId, text);
};

const withCommandError = (
  handler: BridgeCommandHandler,
): BridgeCommandHandler => {
  return async (ctx) => {
    try {
      return await handler(ctx);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      try {
        await replyOwner(`命令执行失败：${reason}`);
      } catch {
        // 回执本身失败不再抛
      }
      // R1-9：异常吞掉后回 handled_failed，避免 reactions 误点 ✅
      return "handled_failed";
    }
  };
};

/** bridge overall → 中文（/status） */
const OVERALL_ZH: Record<string, string> = {
  running: "运行中",
  partial: "部分可用",
  conflict: "冲突",
  stopped: "已停止",
  error: "出错",
};

const zhOverall = (s: string): string => OVERALL_ZH[s] ?? s;

// ----------------- 共用执行流程（命令词与面板按钮共用） -----------------

/**
 * /new 无参 = 面板「开新对话」：新建 chat（createChatTaskForBridge 内已把指针切过去）+ 回执。
 */
export const execNewChatNoArgs = async (): Promise<
  "handled" | "handled_failed"
> => {
  const title = `飞书对话 ${new Date().toLocaleString("zh-CN")}`;
  const created = await deps.createChatTaskForBridge(title);
  if ("error" in created) {
    await replyOwner(`命令执行失败：${created.error}`);
    return "handled_failed";
  }
  await deps.sendTaskBoundText(
    created.taskId,
    `已开新对话：${created.title}，直接发消息开聊`,
  );
  return "handled";
};

/**
 * 直发 /stop = 面板「清理对话」：发对话清理卡（每行「结束」+ 底部「全部结束」）。
 * 没有进行中对话时回文本。
 */
export const execCleanupCard = async (): Promise<"handled"> => {
  const active = await deps.listActiveChatTasks();
  if (active.length === 0) {
    await replyOwner("没有进行中的对话");
    return "handled";
  }
  let currentId = "";
  try {
    currentId = await deps.getCurrentChatTaskId();
  } catch {
    // 读指针失败 → 不标「当前」、卡片仍可用
  }
  const info = await deps.getBotAppInfo();
  const sent = await deps.sendInteractiveCard(
    info.ownerOpenId,
    buildCleanupCardJson(active, currentId),
  );
  // taskId 空串 = 不参与回复锚定路由；只为 card-action 按 messageId 反查 cardId 做 patch
  try {
    await deps.rememberCardMessage({
      messageId: sent.message_id,
      cardId: sent.card_id,
      taskId: "",
      createdAt: Date.now(),
    });
  } catch (err) {
    // 记录失败只影响按钮点击后的卡片 patch（结束动作本身仍会执行）——降级 warn
    console.warn(
      "[feishu-bridge/commands] 清理卡记 card-map 失败:",
      err instanceof Error ? err.message : err,
    );
  }
  return "handled";
};

/** /status = 面板「桥接状态」：状态文本回执 */
export const execStatusText = async (): Promise<"handled"> => {
  const st = deps.getBridgeRuntimeStatus();
  const lines = [
    `桥接：${zhOverall(st.overall)}${st.enabled ? "" : "（开关关）"}`,
    `主机：${st.hostname}`,
    `防睡眠：${st.keepAwake ? "开" : "关"}`,
    ...st.consumers.map((c) => `· ${c.eventKey}：${c.status}`),
  ];
  if (st.lastError) lines.push(`最近错误：${st.lastError}`);
  await replyOwner(lines.join("\n"));
  return "handled";
};

// ----------------- 各命令 -----------------

/** /help → 控制面板卡（命令说明 + 开新对话 / 清理对话 / 桥接状态三颗快捷按钮） */
const cmdHelp: BridgeCommandHandler = async () => {
  const info = await deps.getBotAppInfo();
  // 面板卡不需要 patch 终态、也无路由意义——不记 card-map
  await deps.sendInteractiveCard(
    info.ownerOpenId,
    buildHelpPanelCardJson(HELP_TEXT),
  );
  return "handled";
};

const cmdStatus: BridgeCommandHandler = async () => execStatusText();

const cmdNew: BridgeCommandHandler = async (ctx) => {
  const first = ctx.args.trim();
  if (!first) return execNewChatNoArgs();

  const title = first.length > 20 ? `${first.slice(0, 20)}…` : first;
  const created = await deps.createChatTaskForBridge(title);
  if ("error" in created) {
    await replyOwner(`命令执行失败：${created.error}`);
    return "handled_failed";
  }

  const boot = await deps.loadBridgeBootContext();
  if (!boot) {
    await deps.sendTaskBoundText(
      created.taskId,
      `已开新对话：${created.title}，但缺少 API Key/模型，首条未注入`,
    );
    return "handled_failed";
  }

  const resp = await deps.handleChatReplyInject(
    created.taskId,
    {
      text: first,
      bootArgs: { apiKey: boot.apiKey, model: boot.model },
    },
    { userReplyMetaExtra: { source: "feishu" } },
  );
  if (!resp.ok) {
    let err = `HTTP ${resp.status}`;
    try {
      const data = (await resp.json()) as { error?: string };
      if (typeof data.error === "string" && data.error) err = data.error;
    } catch {
      // ignore
    }
    await deps.sendTaskBoundText(
      created.taskId,
      `已开新对话：${created.title}，首条注入失败：${err}`,
    );
    return "handled_failed";
  }
  await deps.sendTaskBoundText(created.taskId, `已开新对话：${created.title}`);
  return "handled";
};

/**
 * /stop 单语义（2026-07-20 用户二次拍板：锚定「停运行」分支砍掉、不留双语义）：
 * 无论直发还是回复卡片，一律出对话清理卡；清理卡的「结束」本身会先停运行。
 */
const cmdStop: BridgeCommandHandler = async () => execCleanupCard();

const COMMANDS: Array<[string, BridgeCommandHandler]> = [
  ["help", cmdHelp],
  ["status", cmdStatus],
  ["new", cmdNew],
  ["stop", cmdStop],
];

/** 注册四个命令（globalThis 幂等）；启动链由主线调 */
export const ensureBridgeCommandsRegistered = (): void => {
  const reg = getReg();
  if (reg.registered) return;
  for (const [name, handler] of COMMANDS) {
    registerBridgeCommand(name, withCommandError(handler));
  }
  reg.registered = true;
};

/** 单测重置注册标记（命令表本身由 router.__clearBridgeCommandsForTest 清） */
export const __resetCommandsRegisteredForTest = (): void => {
  getReg().registered = false;
};
