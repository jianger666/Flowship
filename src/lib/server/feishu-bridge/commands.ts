/**
 * 飞书侧命令词全套（决策 #13 / #17 / #21 + 矩阵命令行）
 *
 * /help /list /status /new /stop /compact /history
 * 回执一律 sendTextMessage(owner)；文案一句话 / 简洁列表。
 */

import { handleChatReplyInject } from "@/lib/server/chat-inject";
import {
  compactChatSession,
  CompactChatError,
} from "@/lib/server/chat-runner";
import { stopTaskAgent } from "@/lib/server/stop-task";
import { getTask } from "@/lib/server/task-fs";
import type { Task, TaskEvent, TaskSummary } from "@/lib/types";

import { findTaskByMessageId } from "./card-map";
import { getBridgeRuntimeStatus } from "./inbound";
import { getBotAppInfo, sendTextMessage } from "./lark-api";
import {
  createChatTaskForBridge,
  listActiveChatTasks,
  loadBridgeBootContext,
  registerBridgeCommand,
  type BridgeCommandContext,
  type BridgeCommandHandler,
  resolveReplyAnchorIds,
  sendTaskBoundText,
} from "./router";

/** 与设置页欢迎语一致的静态清单 */
const HELP_TEXT =
  "命令：/stop /compact /new /list /history /status /help";

const HISTORY_TEXT_MAX = 200;
const HISTORY_DEFAULT_ROUNDS = 3;

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
  listActiveChatTasks: typeof listActiveChatTasks;
  getBridgeRuntimeStatus: typeof getBridgeRuntimeStatus;
  findTaskByMessageId: typeof findTaskByMessageId;
  createChatTaskForBridge: typeof createChatTaskForBridge;
  loadBridgeBootContext: typeof loadBridgeBootContext;
  handleChatReplyInject: typeof handleChatReplyInject;
  getTask: typeof getTask;
  stopTaskAgent: typeof stopTaskAgent;
  compactChatSession: typeof compactChatSession;
  /** 回复锚定解析（事件缺 root/parent 时 REST 反查）——与 router 注入侧同源 */
  resolveReplyAnchorIds: typeof resolveReplyAnchorIds;
  /** task 绑定类回执（记 card-map、回复它可锚定）——与 router 同源 */
  sendTaskBoundText: typeof sendTaskBoundText;
};

let deps: CommandsDeps = {
  getBotAppInfo,
  sendTextMessage,
  listActiveChatTasks,
  getBridgeRuntimeStatus,
  findTaskByMessageId,
  createChatTaskForBridge,
  loadBridgeBootContext,
  handleChatReplyInject,
  getTask,
  stopTaskAgent,
  compactChatSession,
  resolveReplyAnchorIds,
  sendTaskBoundText,
};

/** 单测替换；传 null 恢复 */
export const __setCommandsDepsForTest = (
  partial: Partial<CommandsDeps> | null,
): void => {
  if (!partial) {
    deps = {
      getBotAppInfo,
      sendTextMessage,
      listActiveChatTasks,
      getBridgeRuntimeStatus,
      findTaskByMessageId,
      createChatTaskForBridge,
      loadBridgeBootContext,
      handleChatReplyInject,
      getTask,
      stopTaskAgent,
      compactChatSession,
      resolveReplyAnchorIds,
      sendTaskBoundText,
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

/** runStatus → 中文（/list） */
const RUN_STATUS_ZH: Record<string, string> = {
  running: "跑步中",
  awaiting_user: "等你回复",
  idle: "空闲",
  error: "出错",
};

/** bridge overall → 中文（/status） */
const OVERALL_ZH: Record<string, string> = {
  running: "运行中",
  partial: "部分可用",
  conflict: "冲突",
  stopped: "已停止",
  error: "出错",
};

const zhRunStatus = (s: string): string => RUN_STATUS_ZH[s] ?? s;
const zhOverall = (s: string): string => OVERALL_ZH[s] ?? s;

// ----------------- 定位目标 chat（与 router 注入语义对齐） -----------------

export type ResolveTargetResult =
  | { ok: true; task: TaskSummary }
  | { ok: false; message: string };

/** Task → 列表摘要（命令定位用，不暴露 events） */
const taskToSummary = (full: Task): TaskSummary => {
  const { events, actions, ...rest } = full;
  void events;
  return {
    ...rest,
    actionCount: actions?.length ?? 0,
  };
};

/**
 * 回复锚定 root_id → 活跃唯一 → 多个提示 / 零个提示。
 * router 里同款逻辑是内联的；命令侧抽 helper 复用 card-map + listActive。
 */
export const resolveCommandTargetTask = async (
  msg: BridgeCommandContext["msg"],
): Promise<ResolveTargetResult> => {
  // 与注入侧同源的锚定解析：事件流 NDJSON 不带 root/parent（实证见 router），
  // 缺失时 REST 反查——否则「回复卡片发命令」永远 miss
  for (const anchorId of await deps.resolveReplyAnchorIds(msg)) {
    const hit = await deps.findTaskByMessageId(anchorId);
    if (hit) {
      const full = await deps.getTask(hit.taskId);
      if (full) return { ok: true, task: taskToSummary(full) };
    }
  }

  const active = await deps.listActiveChatTasks();
  if (active.length === 1) return { ok: true, task: active[0]! };
  if (active.length === 0) {
    return { ok: false, message: "没有进行中的对话" };
  }
  const lines = active.map((t, i) => `${i + 1}. ${t.title || t.id}`);
  return {
    ok: false,
    message: `有 ${active.length} 个进行中的对话，请回复对应卡片再执行命令：\n${lines.join("\n")}`,
  };
};

// ----------------- /history 摘要 -----------------

const truncate = (s: string, max: number): string => {
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max)}…`;
};

/**
 * 一轮 = user_reply 起，到下一条 user_reply 前的最后一条 assistant_message。
 * 取最近 n 轮。
 */
export const buildHistoryRounds = (
  events: TaskEvent[],
  n: number,
): Array<{ user: string; assistant: string }> => {
  const rounds: Array<{ user: string; assistant: string }> = [];
  let cur: { user: string; assistant: string } | null = null;
  for (const e of events) {
    if (e.kind === "user_reply") {
      if (cur) rounds.push(cur);
      cur = { user: e.text || "", assistant: "" };
    } else if (e.kind === "assistant_message" && cur) {
      cur.assistant = e.text || "";
    }
  }
  if (cur) rounds.push(cur);
  const take = Math.max(1, n);
  return rounds.slice(-take);
};

const formatHistory = (
  rounds: Array<{ user: string; assistant: string }>,
): string => {
  if (rounds.length === 0) return "暂无对话记录";
  return rounds
    .map((r, i) => {
      const u = truncate(r.user || "（空）", HISTORY_TEXT_MAX);
      const a = truncate(r.assistant || "（尚未回复）", HISTORY_TEXT_MAX);
      return `${i + 1}. 你：${u}\n   AI：${a}`;
    })
    .join("\n");
};

// ----------------- 各命令 -----------------

const cmdHelp: BridgeCommandHandler = async () => {
  await replyOwner(HELP_TEXT);
  return "handled";
};

const cmdList: BridgeCommandHandler = async () => {
  const active = await deps.listActiveChatTasks();
  if (active.length === 0) {
    await replyOwner("没有进行中的对话");
    return "handled";
  }
  const lines = active.map(
    (t, i) => `${i + 1}. ${t.title || t.id}（${zhRunStatus(t.runStatus)}）`,
  );
  await replyOwner(lines.join("\n"));
  return "handled";
};

const cmdStatus: BridgeCommandHandler = async () => {
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

const cmdNew: BridgeCommandHandler = async (ctx) => {
  const first = ctx.args.trim();
  const title = first
    ? first.length > 20
      ? `${first.slice(0, 20)}…`
      : first
    : `飞书对话 ${new Date().toLocaleString("zh-CN")}`;

  const created = await deps.createChatTaskForBridge(title);
  if ("error" in created) {
    await replyOwner(`命令执行失败：${created.error}`);
    return "handled_failed";
  }

  if (!first) {
    await deps.sendTaskBoundText(
      created.taskId,
      `已开新对话：${created.title}，直接发消息开聊`,
    );
    return "handled";
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

const cmdStop: BridgeCommandHandler = async (ctx) => {
  const target = await resolveCommandTargetTask(ctx.msg);
  if (!target.ok) {
    await replyOwner(target.message);
    return "handled";
  }
  const full = await deps.getTask(target.task.id);
  if (!full) {
    await replyOwner("命令执行失败：任务不存在");
    return "handled_failed";
  }
  await deps.stopTaskAgent(full as Task);
  await replyOwner(`已停止：${target.task.title || target.task.id}`);
  return "handled";
};

const cmdCompact: BridgeCommandHandler = async (ctx) => {
  const target = await resolveCommandTargetTask(ctx.msg);
  if (!target.ok) {
    await replyOwner(target.message);
    return "handled";
  }
  try {
    await deps.compactChatSession(target.task.id);
    await replyOwner(`已压缩：${target.task.title || target.task.id}`);
  } catch (err) {
    if (err instanceof CompactChatError) {
      await replyOwner(`命令执行失败：${err.message}`);
      return "handled_failed";
    }
    throw err;
  }
  return "handled";
};

const cmdHistory: BridgeCommandHandler = async (ctx) => {
  const target = await resolveCommandTargetTask(ctx.msg);
  if (!target.ok) {
    await replyOwner(target.message);
    return "handled";
  }
  let n = HISTORY_DEFAULT_ROUNDS;
  if (ctx.args.trim()) {
    const parsed = Number.parseInt(ctx.args.trim(), 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
      await replyOwner("命令执行失败：/history 参数应为正整数");
      return "handled_failed";
    }
    n = Math.min(parsed, 20);
  }
  const full = await deps.getTask(target.task.id);
  if (!full) {
    await replyOwner("命令执行失败：任务不存在");
    return "handled_failed";
  }
  const rounds = buildHistoryRounds(full.events ?? [], n);
  await replyOwner(formatHistory(rounds));
  return "handled";
};

const COMMANDS: Array<[string, BridgeCommandHandler]> = [
  ["help", cmdHelp],
  ["list", cmdList],
  ["status", cmdStatus],
  ["new", cmdNew],
  ["stop", cmdStop],
  ["compact", cmdCompact],
  ["history", cmdHistory],
];

/** 注册七个命令（globalThis 幂等）；启动链由主线调 */
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
