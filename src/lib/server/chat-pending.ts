/**
 * Pending 等待状态 + 信号 API（V0.9.x 从 chat-mcp.ts 拆出、纯搬家零逻辑变更）
 *
 * 职责（wait_for_user / ask_user 的「等用户」状态机、routes / runner 的信号入口）：
 *   - ToolReturn / PendingEntry / AwaitingSignal / ChatTaskAction 等协议类型
 *   - 进程全局状态（pendingMap / tokenToTask / waitingTasks / ... 挂 globalThis）
 *   - pending entry 生命周期（register / finalize / subscribe / grace 清理）
 *   - formatToolReturnAsText（ToolReturn → wait-ack stdout 文本）
 *   - notifier / task action handler 注册表（runner ↔ chat-mcp 的回调桥）
 *   - submitXxx 信号 API（routes 调、resolve 阻塞中的 agent）
 *
 * 依赖方向（保证无环）：只依赖 types / protocol-signals / wait-protocol-prompt、
 * 不 import chat-mcp / chat-mcp-tools / task-runner。
 */

import type { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import type { ActionType, PlanBatch } from "../types";
import { SIGNALS, buildNextActionHead } from "../protocol-signals";
import { replyThenWaitReminder } from "./wait-protocol-prompt";

// ----------------- 配置 -----------------

// wait-ack 长连接 keepalive 间隔：服务端在长连接里每隔这么久 write 一段
// `[KEEPALIVE ts=<ms>]\n` 普通文本行。双重作用：
//   1. 维持中间链路（nginx / ELB / 浏览器 proxy）connection、不被 idle 砍
//   2. 让 agent 通过 shell-output-delta 持续看到 stdout 有新行、防 Cursor 模型层
//      训练 bias 在「shell 静默几分钟」时主动 summarize 退出
const WAIT_ACK_KEEPALIVE_MS = 60 * 1000;

// ToolReturn：wait-ack 路由把它序列化成单行文本写给 curl、agent 在 shell 输出里读到
// V0.6 信号重命名：
//   - phase_approve/phase_revise → action_approve/action_revise（信号名 ACTION_ACK *）
//   - 新增 next_action：用户在 UI 推进新 action 时 advance 路由调、wait-ack stdout 写
//     `[NEXT_ACTION action_id=... type=... n=... artifact_path=...]\n\n<用户指令>`
export type ToolReturn = {
  // user_reply：chat 模式 / ask_user 答完、真正的用户消息文本
  // action_approve：用户在 UI 点了「通过」、agent 该立刻再调 wait_for_user 等下一 action
  // action_revise：用户点了「再聊聊」（V0.5.2 文案、协议名沿用 revise）
  //   V0.5.10 起按 feedback 是否纯疑问句分 2 类：问类 → event-stream 答疑、改类 → 先弹 ask_user 复述再 edit、详见 super-prompt §3 revise 解读
  // next_action：用户在 UI 推进新 action、agent 解析头部 + 用户指令、跳到对应 action prompt
  //   仅当 agent 上一步是 wait_for_user({task_id}) 不带 action_id 时（即等下一 action 指令时）才会拿到
  // stale：被新一轮 wait_for_user 顶掉、agent 直接放弃这次返回即可
  // cancelled：任务被取消、agent 该结束 run
  kind:
    | "user_reply"
    | "action_approve"
    | "action_revise"
    | "next_action"
    | "task_terminate"
    | "stale"
    | "cancelled";
  text: string;
  // V0.6 task_terminate 用：done = merged / abandoned = abandoned
  // wait-ack stdout 写 [TASK_DONE] 或 [TASK_ABANDONED]、agent 拿到立刻收尾结束 Run
  terminateKind?: "done" | "abandoned";
  // user_reply / action_revise 携带的图片附件绝对路径列表
  // wait-ack 路由会把这些路径拼到 text 里、agent 用 SDK 内置 `read` 工具读看图
  imagePaths?: string[];
  // user_reply 携带的文件 / 目录附件绝对路径列表（仅 kind === "user_reply" 用）
  // wait-ack 路由会把这些路径拼到 text 里、agent 用 read / grep / glob 自己读
  attachmentPaths?: string[];
  // action_revise 携带的修改意见文本（agent 根据这个改 artifact）
  feedback?: string;
  // V0.6 next_action：用户在 UI 选的下一 action 的元数据
  // agent 拿到后解析 `[NEXT_ACTION action_id=xxx type=plan n=2 artifact_path=actions/2-plan.md]` 头、
  // 后面跟用户自由指令（推进 dialog 输入框里的文本 + 附件路径）
  nextActionId?: string;
  nextActionType?: ActionType;
  nextN?: number;
  nextArtifactPath?: string;
};

// PendingEntry：一段「等用户 ack」的状态、由 wait_for_user / ask_user MCP 工具注册
// 由 wait-ack 路由订阅 result promise、由 submitXxx / cancelPending 解算 promise
export interface PendingEntry {
  // 短 token、生成时同步写 tokenToTask 路由表
  token: string;
  // 进入等待的时间戳（毫秒）
  startedAt: number;
  // wait_for_user 时传入的 action_id（agent 完成一个 action 后等 ACTION_ACK 时传）
  // 不传：等下一 action 指令的「待命态」、收到的 ToolReturn 必是 next_action / cancelled / stale
  actionId?: string;
  // wait_for_user 时传入的 artifact 相对路径（仅 action_id 传时）
  artifactPath?: string;
  // 结果 promise：wait-ack 路由 await 它、submitXxx 调 resolveResult 解算
  // resolve 后整个 entry 还会留在 pendingMap 一小段时间（防 race）、最终被 finalize 清
  result: Promise<ToolReturn>;
  // 内部用：resolve 上面的 result promise、submitXxx / cancelPending 调
  resolveResult: (value: ToolReturn) => void;
  // 标记结果是否已 resolved、防止 wait-ack 路由把 stale write 写在 ack 写之后
  resolved: boolean;
}

// ----------------- 进程全局状态（挂 globalThis） -----------------
//
// Next.js dev mode 下、不同 Route Handler（/api/mcp/chat-tool 跟
// /api/tasks/[id]/...）会被打成不同 webpack chunk、`import` 同一个
// 模块拿到的实际是 **不同的 module 实例**、module-level 的 Map / Set 各跑各的
// 完全分裂。task-runner 注的 logger、wait_for_user 这边查不到、就是踩这个坑。
//
// 解法：把所有进程级状态挂到 globalThis 上、所有 chunk 共享同一份。
// 生产 build（standalone）也挂、反正 server 进程只有一个、不会冲突。

// chat-mcp 通知 task-runner「wait_for_user 进入等待」、用于切 task.runStatus = awaiting_user
//
// V0.6 改造：signal 字段 phase/artifact 改为 actionId/artifactPath、跟 V0.6 schema 对齐
//
// 历史背景：以前这个 logger 是写 events.jsonl 的（kind=feedback_request / feedback_keepalive）
// 但用户在 2026-05-11 拍板：因为 wait_for_user 总是用户必须 reply 才推进、UI 上一个 loading 占位就够、
// agent 之前的 assistant_message 已经传达了"我说完了"、不再需要冗余的 feedback_request 事件卡片
// 所以这个回调退化成纯「事件信号」、不带文本、不再写 events.jsonl
//
// 仍保留 callback 抽象（不让 chat-mcp 直接 import task-runner 内部方法）：
// - 维持模块依赖方向 task-runner → chat-mcp（反过来会形成循环）
// - 让 runner 全权决定收到信号要做什么（patch status / publish / 写日志）
//
// V0.3 ask_user 扩展：新增 ask_user_request kind、runner 负责写 events.jsonl 卡片 + 切 task.runStatus
//
// V0.3.2 改造（用户拍板）：
//   - 一次 ask_user 调用 = 一组问题 questions[]（不再一次一问、避免反复弹窗 + 拉长对话节奏）
//   - UI 用 modal dialog 而不是 inline 卡片、ABCD 字母前缀
//   - 跟 AskUserQuestion / AskUserAnswer 类型定义保持一致（types.ts）
export type AskUserOption = { id: string; label: string };
export type AskUserQuestion = {
  id: string;
  question: string;
  options?: AskUserOption[];
  allowText: boolean;
};

export type AwaitingSignal =
  | {
      kind: "awaiting_start";
      // V0.6：传 action_id（agent 正在 ack 该 action）或不传（agent 在等下一 action 指令）
      actionId?: string;
      artifactPath?: string;
    }
  | {
      // agent 调 ask_user MCP 工具时 chat-mcp 通过 notifier 给 runner 派发的信号
      // runner 收到后：写一条 ask_user_request 事件 + publish SSE + 切 task.runStatus=awaiting_user
      kind: "ask_user_request";
      askId: string;
      token: string;
      questions: AskUserQuestion[];
      actionId?: string;
    };

export type AwaitingNotifier = (signal: AwaitingSignal) => Promise<void> | void;

// ----------------- V0.6.1 ship action 用：task-scoped action handler -----------------
//
// 跟 awaitingNotifier 同款模式：runner 在启动 task 时按 taskId 注册一个 handler、
// chat-mcp 里 submit_mr / set_feishu_testers MCP 工具拿到调用时、查表找到 handler 执行。
//
// 为什么不让 chat-mcp 直接 import gitlab-client / task-fs：
//   - 维持模块依赖方向 task-runner → chat-mcp（反过来会形成循环）
//   - 让 runner 全权决定 handler 内部行为（读 settings、调 gitlab-client、写 task.mrs[]）
//   - chat-mcp 只负责 MCP transport + 工具路由、不知道 GitLab / 飞书 / task-fs 怎么工作
//
// 这套 handler 跟 awaitingNotifier 的本质区别：
//   - awaitingNotifier 是「单向事件通知」（runner 用来更新 task 状态）、没返回值
//   - taskActionHandler 是「同步 RPC」（agent 调 MCP 工具拿结果）、有结构化返回值

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

interface ChatMcpGlobalState {
  pendingMap: Map<string, PendingEntry>;
  waitingTasks: Set<string>;
  awaitingNotifiers: Map<string, AwaitingNotifier>;
  // V0.6.1：runner 注册的 task-scoped action handler（submit_mr / set_feishu_testers）
  taskActionHandlers: Map<string, ChatTaskActionHandler>;
  sessionTransports: Map<string, WebStandardStreamableHTTPServerTransport>;
  // V0.3.5 仍保留：token → taskId 映射、wait-ack 路由验 token 合法性用
  // 生命周期：wait_for_user/ask_user MCP 工具调用时写、submitXxx/cancelPending 清
  tokenToTask: Map<string, string>;
  // V0.6.19：approve 后秒推下一 action 撞 grace 窗口时、NEXT_ACTION 暂存这里、
  // 等 agent 重新进「待命态」(registerPendingEntry actionId 空) 再兑现、防 race 丢指令
  pendingNextActions: Map<string, ToolReturn>;
  // V0.6.31：「未处理 revise」标记——用户点「再聊聊」后 agent 还欠一次处理（问类答疑 / 改类弹窗）
  // 实测踩坑：agent 收到 [ACTION_ACK revise] 后什么都不干、直接调 wait_for_user 不带 action_id
  // → 服务端误入待命态、pendingAck 被清、UI 只剩「推进」、用户没法再聊聊。
  // 有此标记时 wait_for_user 不带 action_id → 自动纠正回原 action 的 ack 态 + 返回文本责令补处理。
  unansweredRevises: Map<string, { actionId: string; artifactPath?: string }>;
  // V0.7.20：chat 模式 task 集合。chat-runner 启动时 mark、结束时 unmark。
  // buildShellWaitGuidance 据此给 chat 一份「USER_REPLY 语境」的精简引导、
  // 不让 chat agent 看到一堆 task 专属信号（ACTION_ACK / NEXT_ACTION）而困惑。
  chatModeTasks: Set<string>;
  // V0.8.x：chat「没发正文就想挂等」的连续拒绝计数（兜底 A、防死循环）。
  // wait_for_user handler 检测到 premature wait（这一轮做了工具调用但没把答案写成正文）时 ++、
  // 正常放行 / finalize 时清 0；达到上限就放行（宁可让对话继续、不死循环烧 token）。
  prematureWaitRejects: Map<string, number>;
}

// V12：2026-06-16 加 prematureWaitRejects（chat「没发正文就挂等」兜底拦截的连续拒绝计数、防死循环）
// V11：2026-06-14 V0.7.20 加 chatModeTasks（chat 模式 task 集合、buildShellWaitGuidance 据此给 chat 专属精简引导）
// V10：2026-06-10 V0.6.31 加 unansweredRevises（revise 后 agent 跳过处理直入待命态的自动纠正）
// V9：2026-06-05 V0.6.19 加 pendingNextActions（approve 后秒推 action 的 grace race 修复、挂起队列）
// V8：2026-05-28 V0.6.1 加 taskActionHandlers（submit_mr / set_feishu_testers）
// V7：2026-05-27 V0.6 字段重命名（phase → actionId / artifact → artifactPath / 新增 next_action kind）
// V6：2026-05-15 删 pendingFirstMessage（chat 自由化首条改进 prompt 注入、不走队列）
// V5：2026-05-15 加 pendingFirstMessage（已撤销）
// V4：2026-05-14 删 keepaliveCounters（旧 keep_alive_a/b/c 序号轮转、shell long-poll 后不需要）
// dev hot reload 不会清 globalThis、旧版字段名残留会让新代码拿到 undefined → TypeError
// → bump 版本后缀强制让 dev 重启时拿到全新 state（旧版 state 留在内存等 GC）
const GLOBAL_KEY = "__feAiFlowChatStateV12__";

const getGlobalState = (): ChatMcpGlobalState => {
  const g = globalThis as unknown as Record<string, ChatMcpGlobalState>;
  if (!g[GLOBAL_KEY]) {
    console.log("[chat-mcp] 初始化 globalThis 状态（首次）");
    g[GLOBAL_KEY] = {
      pendingMap: new Map(),
      waitingTasks: new Set(),
      awaitingNotifiers: new Map(),
      taskActionHandlers: new Map(),
      sessionTransports: new Map(),
      tokenToTask: new Map(),
      pendingNextActions: new Map(),
      unansweredRevises: new Map(),
      chatModeTasks: new Set(),
      prematureWaitRejects: new Map(),
    };
  }
  return g[GLOBAL_KEY];
};

// 进程级 pending 表：任务 id → pending entry
// 同一个 task 同时只允许一个 entry（新来的顶旧的）
const pendingMap = getGlobalState().pendingMap;

// V0.6.19：挂起的 NEXT_ACTION 队列（approve 后秒推 action 撞 grace race 的暂存、见 submitNextAction / registerPendingEntry）
const pendingNextActions = getGlobalState().pendingNextActions;

// V0.6.31：未处理 revise 标记（见 ChatMcpGlobalState 注释、wait_for_user handler 消费）
export const unansweredRevises = getGlobalState().unansweredRevises;

// V0.7.20：chat 模式 task 集合（见 ChatMcpGlobalState 注释）
export const chatModeTasks = getGlobalState().chatModeTasks;

// V0.8.x 兜底 A：chat「没发正文就挂等」连续拒绝计数（见 ChatMcpGlobalState 注释 + detectPrematureChatWait）
export const prematureWaitRejects = getGlobalState().prematureWaitRejects;

// MCP session 表（sessionId → transport）：chat-mcp.ts 的 handleChatMcpRequest 用、
// 状态本体仍挂同一个 globalThis 对象（拆文件不拆状态）
export const sessionTransports = getGlobalState().sessionTransports;

/** chat-runner 启动 chat session 时调：标记此 task 走 chat 等待引导（精简、USER_REPLY 语境）。 */
export const markTaskAsChat = (taskId: string): void => {
  chatModeTasks.add(taskId);
  // 新 session 起手清掉上次残留的 premature 拒绝计数（防上次 run 留下的计数误伤本轮）
  prematureWaitRejects.delete(taskId);
};

/** chat session 结束 / task 清理时调：取消 chat 标记。 */
export const unmarkTaskAsChat = (taskId: string): void => {
  chatModeTasks.delete(taskId);
};

// 「这个 task 当前是否处在等待用户的状态」
// wait_for_user / ask_user MCP 工具进来时标 true、submitXxx / cancelPending 清
// 用途：UI 拉状态、runner 切 task.runStatus = awaiting_user 时去重
export const waitingTasks = getGlobalState().waitingTasks;

// token → taskId 路由表、wait-ack 路由验 token 合法性用
// 生命周期：registerPendingEntry 写、finalizeEntry 清
const tokenToTask = getGlobalState().tokenToTask;

// 生成短 token：8 字符 base36、足够防撞、又不浪费 context
// 不用 uuid 是因为更短、且模型只需要识别 / 透传、不需要 cryptographic strength
const newWaitToken = (): string =>
  Math.random().toString(36).slice(2, 10);

// chat「续接对话」路径每轮用户消息尾部固定拼的 recency 提醒——内容走 replyThenWaitReminder()
// 单一源（和 chat-runner 起手 / 懒重启路径字符级一致、见 wait-protocol-prompt.ts）。
// 为什么续接路径要再拼一次（起手已讲过）：长对话里起手那段会被后面几十轮淹掉、composer-2.5
// 实测「理解协议但漏执行」（V0.7.21 线上 money看板 连追 4 次才吐链接、V0.8.3 composer-2.5 把
// 「我先写 X」计划宣告误当正文、文章一字没写就挂等）——它不缺理解、缺「就在眼前的执行提醒」。
// 加「系统提醒、非用户所说」前缀：这句拼在用户回复尾部、得跟用户真正说的话区分开。
const CHAT_REPLY_REMINDER = `（系统提醒、非用户所说）${replyThenWaitReminder()}`;

// 把 ToolReturn 序列化成 wait-ack 路由写出 curl 的文本（多行）
// 第一行是 `[KIND ...]` 标记（必）、后续是 body。agent 在 shell 输出里 grep 标记拿语义、按需读 body
//
// 历史：旧版返 MCP `{content: [{type:text, text}]}`、shell long-poll 后直接写文本到 stdout
// taskId（可选）：传了且该 task 处于 chat 模式时、在 user_reply 尾部拼 CHAT_REPLY_REMINDER。
export const formatToolReturnAsText = (
  result: ToolReturn,
  taskId?: string,
): string => {
  if (result.kind === "action_approve") {
    const lines: string[] = [SIGNALS.ACTION_ACK_APPROVE];
    if (result.text && result.text.trim()) lines.push("", result.text);
    return lines.join("\n");
  }
  if (result.kind === "action_revise") {
    const lines: string[] = [SIGNALS.ACTION_ACK_REVISE];
    const fb = (result.feedback ?? result.text ?? "").trim();
    if (fb) lines.push("", fb);
    if (result.imagePaths && result.imagePaths.length > 0) {
      lines.push(
        "",
        `${SIGNALS.ATTACHED_IMAGES} 用户附了以下图片说明本次反馈、请用 \`read\` 工具逐一读取（SDK 内置 \`read\` 会把图片转成 vision、你能直接看到图像内容）：`,
        ...result.imagePaths.map((p, i) => `  ${i + 1}. ${p}`),
      );
    }
    return lines.join("\n");
  }
  if (result.kind === "next_action") {
    // V0.6 新增信号：用户在 UI 推进新 action
    // 头部参数齐全、agent 可解析后调用对应 action prompt
    const head = buildNextActionHead({
      actionId: result.nextActionId,
      actionType: result.nextActionType,
      n: result.nextN,
      artifactPath: result.nextArtifactPath,
    });
    const lines: string[] = [head];
    if (result.text && result.text.trim()) lines.push("", result.text);
    if (result.imagePaths && result.imagePaths.length > 0) {
      lines.push(
        "",
        `${SIGNALS.ATTACHED_IMAGES} 用户附了以下图片说明本次推进、请用 \`read\` 工具逐一读取：`,
        ...result.imagePaths.map((p, i) => `  ${i + 1}. ${p}`),
      );
    }
    if (result.attachmentPaths && result.attachmentPaths.length > 0) {
      lines.push(
        "",
        `${SIGNALS.ATTACHED_PATHS} 用户附了以下文件 / 目录路径、按需用 \`read\` / \`grep\` / \`glob\` 读取：`,
        ...result.attachmentPaths.map((p, i) => `  ${i + 1}. ${p}`),
      );
    }
    return lines.join("\n");
  }
  if (result.kind === "user_reply") {
    const lines: string[] = [SIGNALS.USER_REPLY, "", result.text];
    if (result.imagePaths && result.imagePaths.length > 0) {
      lines.push(
        "",
        `${SIGNALS.ATTACHED_IMAGES} 用户附了以下图片、请用 \`read\` 工具逐一读取（SDK 内置 \`read\` 会把图片转成 vision、你能直接看到图像内容）：`,
        ...result.imagePaths.map((p, i) => `  ${i + 1}. ${p}`),
      );
    }
    if (result.attachmentPaths && result.attachmentPaths.length > 0) {
      lines.push(
        "",
        `${SIGNALS.ATTACHED_PATHS} 用户附了以下文件 / 目录路径、按需用 \`read\` / \`grep\` / \`glob\` 读取（路径已是绝对路径、直接用）：`,
        ...result.attachmentPaths.map((p, i) => `  ${i + 1}. ${p}`),
      );
    }
    // chat 模式：每轮用户回复尾部固定补一句「回完记得再挂等」（recency 兜底、防长上下文漏执行）。
    // task 模式不掺（它的 wait_for_user / ask_user 是 action 内确认、语义不同）。
    if (taskId && chatModeTasks.has(taskId)) {
      lines.push("", CHAT_REPLY_REMINDER);
    }
    return lines.join("\n");
  }
  if (result.kind === "task_terminate") {
    const head =
      result.terminateKind === "done"
        ? SIGNALS.TASK_DONE
        : SIGNALS.TASK_ABANDONED;
    return [head, "", result.text].join("\n");
  }
  if (result.kind === "cancelled") {
    return [SIGNALS.CANCELLED, "", result.text].join("\n");
  }
  // stale
  return [SIGNALS.STALE, "", result.text].join("\n");
};

// 解算一个 entry 的 result promise、保留 grace 60 秒后才清 pendingMap / tokenToTask
//
// V0.3.5 race 修复：原版立刻清 token/entry 会触发严重 race——
//   1. agent 调 ask_user → 工具返回 SHELL_WAIT_GUIDE、agent 这边还要几秒才发起 shell + curl
//   2. 用户在 UI 早已看到弹窗、提交答案瞬间调 submitAskReply → finalizeEntry 立刻清
//   3. 几秒后 agent 的 curl 才到 wait-ack 路由、token 在 tokenToTask 里没了 → 返回 [INVALID_TOKEN]
//   4. agent 看到 INVALID_TOKEN、按 prompt 规则自然结束 run（实际错过了用户的 reply）
//
// 解法：finalizeEntry 只 resolve promise、不立刻清状态、设 60 秒延迟清。
// 这样晚到的 curl 还能 subscribeWaitAck 拿到 entry、await 已 resolved 的 promise 立即拿结果。
const GRACE_CLEANUP_MS = 60 * 1000;

const forceCleanupEntry = (taskId: string, entry: PendingEntry): void => {
  if (pendingMap.get(taskId) === entry) {
    pendingMap.delete(taskId);
  }
  tokenToTask.delete(entry.token);
  waitingTasks.delete(taskId);
};

const finalizeEntry = (
  taskId: string,
  entry: PendingEntry,
  value: ToolReturn,
): void => {
  if (entry.resolved) return;
  entry.resolved = true;
  entry.resolveResult(value);
  // grace window：60 秒内晚到的 curl 还能 subscribe 拿到已 resolved 的 promise
  // 60 秒后才真正清状态
  setTimeout(() => {
    forceCleanupEntry(taskId, entry);
  }, GRACE_CLEANUP_MS);
};

// 注册一段「等用户 ack」的 pending entry：建 promise + 写 pendingMap / tokenToTask
//
// MCP 工具（wait_for_user / ask_user）handler 内部调一次、立即返回 shell 引导文本、不 await result
// wait-ack 路由订阅这个 entry 的 result promise、submitXxx 调 resolveResult 解算
export const registerPendingEntry = (
  taskId: string,
  opts: { actionId?: string; artifactPath?: string },
): PendingEntry => {
  // 顶替场景：agent 反常地又调 wait_for_user（新 token）、旧 entry 直接清掉
  // 注意：旧 entry 可能是 resolved 状态（处于 grace window）、也可能是 pending 状态
  //   - resolved：grace 期内、新 wait 进来意味着 agent 没 subscribe 上、grace 没意义、立即清
  //   - pending：发个 stale 结果让 wait-ack 客户端断开、再立即清
  const old = pendingMap.get(taskId);
  if (old) {
    console.warn(
      `[chat-mcp] registerPendingEntry: task=${taskId} 已有旧 entry token=${old.token} resolved=${old.resolved}、立即清`,
    );
    if (!old.resolved) {
      // 给一个 stale 结果让等待中的 wait-ack 路由立刻关流
      old.resolved = true;
      old.resolveResult({
        kind: "stale",
        text: "上一个 wait_for_user 被新调用顶掉、本次 wait-ack 长连接将关闭、agent 该按新引导调 shell。",
      });
    }
    forceCleanupEntry(taskId, old);
  }
  const token = newWaitToken();
  tokenToTask.set(token, taskId);

  let resolveResult: (value: ToolReturn) => void = () => {};
  const result = new Promise<ToolReturn>((resolve) => {
    resolveResult = resolve;
  });
  const entry: PendingEntry = {
    token,
    startedAt: Date.now(),
    actionId: opts.actionId,
    artifactPath: opts.artifactPath,
    result,
    resolveResult,
    resolved: false,
  };
  pendingMap.set(taskId, entry);
  // V0.6.19：兑现挂起的 NEXT_ACTION。
  // 仅「待命态」(actionId 空、即 agent ack 完正等下一 action 指令) 才兑现——等某 action ack 态
  // (actionId 有值) 不该被 NEXT_ACTION 顶。
  // 场景：用户 ack 后秒推下一 action 时 NEXT_ACTION 撞 grace 入了队、现在 agent 真正进待命态、立即交付。
  if (!opts.actionId) {
    const queued = pendingNextActions.get(taskId);
    if (queued) {
      pendingNextActions.delete(taskId);
      console.log(
        `[chat-mcp] registerPendingEntry: task=${taskId} 兑现挂起的 NEXT_ACTION（type=${queued.nextActionType} n=${queued.nextN}）`,
      );
      finalizeEntry(taskId, entry, queued);
    }
  }
  return entry;
};

// 给 wait-ack 路由用：按 token 找 entry、订阅 result promise
//
// 返回 null：token 不在 tokenToTask 表里（已被消费 / 从未存在）→ 路由立刻给 [INVALID_TOKEN]
// 返回 entry：路由 await entry.result 拿到 ToolReturn 再写出去
export const subscribeWaitAck = (
  taskId: string,
  token: string,
): PendingEntry | null => {
  const expectedTaskId = tokenToTask.get(token);
  if (!expectedTaskId || expectedTaskId !== taskId) {
    console.warn(
      `[chat-mcp] subscribeWaitAck 校验失败：token=${token} 期望 task=${expectedTaskId ?? "<none>"} 实际 task=${taskId}`,
    );
    return null;
  }
  const entry = pendingMap.get(taskId);
  if (!entry || entry.token !== token) {
    // race：token 被新 wait_for_user 顶替（极少见、agent 通常一次 wait 走完）
    console.warn(
      `[chat-mcp] subscribeWaitAck: task=${taskId} pendingMap entry 不匹配（pending.token=${entry?.token ?? "<none>"} 请求.token=${token}）`,
    );
    return null;
  }
  // entry.resolved=true 说明用户答得比 agent 调 curl 快、entry 处于 grace window
  // wait-ack 路由 await entry.result 会立刻拿到已 resolved 的值、瞬间写结果 + 关流
  if (entry.resolved) {
    console.log(
      `[chat-mcp] subscribeWaitAck: task=${taskId} token=${token} entry 已 resolved（grace window）、curl 一连就拿到结果`,
    );
  }
  return entry;
};

// 服务端 chunked keepalive 间隔毫秒：wait-ack 路由用、出口直接 import 这个常量
export const getWaitAckKeepaliveMs = (): number => WAIT_ACK_KEEPALIVE_MS;

// ----------------- awaiting notifier（按 task id 注册） -----------------
//
// task-runner 启动 task 时注册一个 notifier、wait_for_user 进入"全新一段等待"时
// chat-mcp 调它一次、task-runner 据此把 task.runStatus 切到 awaiting_user 并 publish 给 SSE 订阅者。
//
// 按 task id 维度注册：同一时刻可以有多个 task 在跑、
// 各自 wait_for_user 调用按 task_id 路由到自己的 notifier、互不干扰。

const awaitingNotifiers = getGlobalState().awaitingNotifiers;
const taskActionHandlers = getGlobalState().taskActionHandlers;

/**
 * 给某个 task 注册（或取消注册）"等待用户"通知器。
 *
 * 调用方负责处理 notifier 内部所有异常、不要让异常冒到工具调用里、
 * 否则 agent 会以为工具失败。
 *
 * @param taskId 目标 task id
 * @param notifier 传 null 表示取消注册
 */
export const setChatAwaitingNotifier = (
  taskId: string,
  notifier: AwaitingNotifier | null,
): void => {
  if (notifier) {
    awaitingNotifiers.set(taskId, notifier);
    console.log(
      `[chat-mcp] setChatAwaitingNotifier 注册 task=${taskId} 当前 ${awaitingNotifiers.size} 个`,
    );
  } else {
    awaitingNotifiers.delete(taskId);
    console.log(
      `[chat-mcp] setChatAwaitingNotifier 注销 task=${taskId} 剩余 ${awaitingNotifiers.size} 个`,
    );
  }
};

/**
 * V0.6.1：给 task 注册（或注销）task-scoped action handler（submit_mr / set_feishu_testers）
 *
 * 调用时机：task-runner 启动 task 时注册一次、task 结束（cleanupChatTaskState）时注销
 *
 * @param taskId 目标 task id
 * @param handler 传 null 表示注销
 */
export const setChatTaskActionHandler = (
  taskId: string,
  handler: ChatTaskActionHandler | null,
): void => {
  if (handler) {
    taskActionHandlers.set(taskId, handler);
    console.log(
      `[chat-mcp] setChatTaskActionHandler 注册 task=${taskId} 当前 ${taskActionHandlers.size} 个`,
    );
  } else {
    taskActionHandlers.delete(taskId);
    console.log(
      `[chat-mcp] setChatTaskActionHandler 注销 task=${taskId} 剩余 ${taskActionHandlers.size} 个`,
    );
  }
};

/**
 * V0.6.1 race fix：conditional unset——只在「当前注册的就是 expected 这个实例」时才注销。
 *
 * 为什么需要：force-new-agent 时若旧 SDK Run cancel 卡 >5s、forceClearStaleRunnerState 先清
 * runningTasks、新 agent 接着 setChatTaskActionHandler(newHandler) 注册、旧 agent 迟到的 finally
 * 若无条件 delete(taskId) 会把 newHandler 误清、导致新 agent 调 submit_mr 拿不到 handler、ship 挂住。
 * 改成「比对实例引用」：旧 finally 发现表里已是 newHandler（!== oldHandler）就不动、保住新 handler。
 */
export const unsetChatTaskActionHandlerIf = (
  taskId: string,
  expected: ChatTaskActionHandler,
): void => {
  if (taskActionHandlers.get(taskId) === expected) {
    taskActionHandlers.delete(taskId);
    console.log(
      `[chat-mcp] unsetChatTaskActionHandlerIf 注销 task=${taskId}（命中自身实例）剩余 ${taskActionHandlers.size} 个`,
    );
  } else {
    console.log(
      `[chat-mcp] unsetChatTaskActionHandlerIf 跳过 task=${taskId}（已被新实例覆盖、保留新 handler）`,
    );
  }
};

/** 同 unsetChatTaskActionHandlerIf、对 awaitingNotifier 做 conditional unset（V0.5 沿用的同款 race 一并修） */
export const unsetChatAwaitingNotifierIf = (
  taskId: string,
  expected: AwaitingNotifier,
): void => {
  if (awaitingNotifiers.get(taskId) === expected) {
    awaitingNotifiers.delete(taskId);
    console.log(
      `[chat-mcp] unsetChatAwaitingNotifierIf 注销 task=${taskId}（命中自身实例）剩余 ${awaitingNotifiers.size} 个`,
    );
  } else {
    console.log(
      `[chat-mcp] unsetChatAwaitingNotifierIf 跳过 task=${taskId}（已被新实例覆盖、保留新 notifier）`,
    );
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
    // 调试用：notifier 找不到时喊一嗓子、避免静默
    console.warn(
      `[chat-mcp] safeNotifyAwaiting: 没找到 task=${taskId} 的 notifier（已注册 ${awaitingNotifiers.size} 个：${Array.from(
        awaitingNotifiers.keys(),
      ).join(",")}）`,
    );
    return;
  }
  try {
    await notifier({
      kind: "awaiting_start",
      actionId: opts.actionId,
      artifactPath: opts.artifactPath,
    });
    console.log(
      `[chat-mcp] safeNotifyAwaiting 成功 task=${taskId} actionId=${opts.actionId ?? "<待命>"}`,
    );
  } catch (err) {
    console.error("[chat-mcp] awaiting notifier failed:", err);
  }
};

// V0.3 ask_user：派发问答信号给 runner、runner 写 events.jsonl + 切 runStatus
// notifier 没注册时通知失败（理论不会发生、agent 调 ask_user 时 task 一定在 run）、
// 跟 awaiting_start 同款防御逻辑、不抛错只 warn
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
    console.log(
      `[chat-mcp] safeNotifyAskUserRequest 成功 task=${taskId} askId=${args.askId} questions=${args.questions.length}`,
    );
  } catch (err) {
    console.error("[chat-mcp] ask_user_request notifier failed:", err);
  }
};

// ----------------- routes / runner 用的信号 API -----------------

/**
 * chat 模式 task：用户在 ChatView 输入框写了一条消息、API 路由（/chat-reply）调这个、把消息塞给被阻塞的 agent。
 *
 * 触发条件：task.mode === "chat" 且 agent 在 wait_for_user(task_id) 上等
 *
 * @param imagePaths      用户消息附带的图片绝对路径（已落盘）、可空
 * @param attachmentPaths 用户消息附带的文件 / 目录绝对路径（原生 picker 选的）、可空
 *
 * 返回值：
 *   - true：成功 resolve、agent 会拿到这段文本
 *   - false：当前没有 agent 在等待输入（task 没启动 / 已结束 / 状态不一致）
 */
export const submitUserMessage = (
  taskId: string,
  text: string,
  imagePaths?: string[],
  attachmentPaths?: string[],
): boolean => {
  const entry = pendingMap.get(taskId);
  if (!entry) {
    console.warn(
      `[chat-mcp] submitUserMessage 没找到 pending task=${taskId}（pending 共 ${pendingMap.size} 个：${Array.from(pendingMap.keys()).join(",")}）`,
    );
    return false;
  }
  finalizeEntry(taskId, entry, {
    kind: "user_reply",
    text,
    imagePaths: imagePaths && imagePaths.length > 0 ? imagePaths : undefined,
    attachmentPaths:
      attachmentPaths && attachmentPaths.length > 0
        ? attachmentPaths
        : undefined,
  });
  console.log(
    `[chat-mcp] submitUserMessage 成功 task=${taskId} text=${text.slice(0, 60)}${
      imagePaths && imagePaths.length > 0 ? ` images=${imagePaths.length}` : ""
    }${
      attachmentPaths && attachmentPaths.length > 0
        ? ` paths=${attachmentPaths.length}`
        : ""
    }`,
  );
  return true;
};

/**
 * V0.3.2 ask_user：用户在 modal 里答完所有问题、API 路由调这个 resolve 阻塞中的 agent。
 *
 * 设计：返回值走 user_reply kind、文本是拼接好的 [ASK_USER_REPLY] markdown Q&A 块
 * agent 看到 [ASK_USER_REPLY] 头知道是 ask_user 答案、解析里面的 Q1/Q2 拿每条答案
 *
 * 入参 replyText：调用方（ask-reply 路由）已经拼好的最终文本、形如：
 *   [ASK_USER_REPLY]
 *   Q1: 问题1
 *   A: 答案1
 *
 * @param imagePaths V0.8.3：用户在某些 question 的回答里附了图、这里传全部图的绝对路径
 *                   （扁平、跨所有 question 汇总）。走 user_reply kind、formatToolReturnAsText
 *                   会在文末拼标准 [ATTACHED_IMAGES] 段、agent 用 read 看图。哪张图属哪个
 *                   question 由 replyText 里每题内联的「本题附图：<basename>」标注（route 拼）兜住。
 * @param expectedToken V0.8.3：本组 ask 在 ask_user_request 事件 meta 里记的 token。传了就做
 *                   token 级校验——必须等于当前 pending entry 的 token、否则拒掉（返 false）。
 *                   防「旧 ask 弹窗答案串进被顶替的新 pending」race（pending 只到 task 级、
 *                   force-new-agent / 顶替时新 entry 换了 token、旧弹窗答案不该送进新等待）。
 *
 * 返回：true=成功 resolve、false=当前没有 pending、或 token 不匹配（race / 任务已退出 / 被顶替）
 */
export const submitAskReply = (
  taskId: string,
  replyText: string,
  imagePaths?: string[],
  expectedToken?: string,
): boolean => {
  const entry = pendingMap.get(taskId);
  if (!entry) {
    console.warn(
      `[chat-mcp] submitAskReply 没找到 pending task=${taskId}`,
    );
    return false;
  }
  if (expectedToken && entry.token !== expectedToken) {
    console.warn(
      `[chat-mcp] submitAskReply token 不匹配 task=${taskId} expected=${expectedToken} actual=${entry.token}、拒绝（当前等待已不是这组 ask、被顶替 / force-new-agent）`,
    );
    return false;
  }
  finalizeEntry(taskId, entry, {
    kind: "user_reply",
    text: replyText,
    imagePaths: imagePaths && imagePaths.length > 0 ? imagePaths : undefined,
  });
  console.log(
    `[chat-mcp] submitAskReply 成功 task=${taskId} reply=${replyText.slice(0, 80)}${
      imagePaths && imagePaths.length > 0 ? ` images=${imagePaths.length}` : ""
    }`,
  );
  return true;
};

/**
 * V0.6 action ack：用户在 UI 点了「通过」或「再聊聊」、API 路由调这个 ack 阻塞中的 agent。
 *
 * @param actionId 要 ack 的 action id——**必须**等于 agent 当前 wait_for_user 时传的 action_id
 *                 （pending.actionId）。P0-1 修复：以前只按 taskId 取 pending、不比对 actionId、
 *                 旧 tab / 并发推进 / ask_user 进行中时会把 ack 信号发给错误的 pending。
 * @param action   "approve" → agent 拿到 [ACTION_ACK approve]、立刻再 wait_for_user(待命态) 等下一 action
 *                 "revise"  → agent 拿到 [ACTION_ACK revise] + feedback、改 artifact 再调一次 wait_for_user
 * @param feedback "revise" 时的用户意见文本、"approve" 时可空（也能传补充说明）
 * @param imagePaths revise 可携带图片附件、agent 先 read 图再 ask_user 复述
 *                   approve 不接受 imagePaths（语义上没必要、强校验交给路由层）
 *
 * 返回值：
 *   - { ok: true }：成功 resolve
 *   - { ok: false, reason }：pending 不存在 / 是待命态 / 在等别的 action / 已被消费、reason 给上层报错
 */
export const submitActionAck = (
  taskId: string,
  actionId: string,
  action: "approve" | "revise",
  feedback?: string,
  imagePaths?: string[],
): { ok: true } | { ok: false; reason: string } => {
  const entry = pendingMap.get(taskId);
  if (!entry) {
    console.warn(
      `[chat-mcp] submitActionAck 没找到 pending task=${taskId} action=${action}`,
    );
    return { ok: false, reason: "当前没有 agent 在等 ack（pending 不存在）" };
  }
  // P0-1 绑定校验：ack 只能落到「agent 正在等 ack 的那个 action」上、否则一律拒——
  //   - entry.actionId 空 = 待命态（等 NEXT_ACTION 推进）、根本不是在等 action ack
  //   - entry.actionId !== actionId = agent 在等别的 action 的 ack（旧标签页 / 并发推进）
  //   - entry.resolved = grace 残留、agent 已消费这次结果、不该再 ack
  if (!entry.actionId) {
    return {
      ok: false,
      reason: "agent 当前在待命态（等推进下一 action）、不是在等某个 action 的 ack",
    };
  }
  if (entry.actionId !== actionId) {
    return {
      ok: false,
      reason: `agent 正在等 action ${entry.actionId} 的 ack、不是 ${actionId}（可能旧标签页 / 并发推进、请刷新后重试）`,
    };
  }
  if (entry.resolved) {
    return { ok: false, reason: "本次 ack 已被处理（重复提交 / grace 残留）" };
  }
  // V0.6.31 未处理 revise 标记：revise 置位（agent 欠一次处理）、approve 清除（用户翻篇）
  if (action === "revise") {
    unansweredRevises.set(taskId, {
      actionId,
      artifactPath: entry.artifactPath,
    });
  } else {
    unansweredRevises.delete(taskId);
  }
  finalizeEntry(taskId, entry, {
    kind: action === "approve" ? "action_approve" : "action_revise",
    text: feedback ?? "",
    feedback: feedback,
    imagePaths: action === "revise" ? imagePaths : undefined,
  });
  console.log(
    `[chat-mcp] submitActionAck 成功 task=${taskId} actionId=${actionId} action=${action} feedback=${(feedback ?? "").slice(0, 60)} imagePaths=${imagePaths?.length ?? 0}`,
  );
  return { ok: true };
};

/**
 * V0.6 next action：用户在 UI 点了「推进」选了下一 action、API 路由（/advance）调这个
 * 把 [NEXT_ACTION ...] + 用户指令塞给阻塞中的 agent（agent 正在「待命态」wait_for_user(task_id)）
 *
 * @param nextAction 新建的 action 元数据（runner 已写到 task.actions、ID/n/artifactPath 已定）
 * @param userPrompt 用户在推进 dialog 输入框里写的自由文本
 * @param imagePaths / attachmentPaths 推进 dialog 附的图 / 路径
 *
 * 返回：true=成功 resolve、false=task 没在等待
 */
export const submitNextAction = (
  taskId: string,
  nextAction: {
    actionId: string;
    type: ActionType;
    n: number;
    artifactPath: string;
  },
  userPrompt: string,
  imagePaths?: string[],
  attachmentPaths?: string[],
): boolean => {
  const payload: ToolReturn = {
    kind: "next_action",
    text: userPrompt,
    nextActionId: nextAction.actionId,
    nextActionType: nextAction.type,
    nextN: nextAction.n,
    nextArtifactPath: nextAction.artifactPath,
    imagePaths: imagePaths && imagePaths.length > 0 ? imagePaths : undefined,
    attachmentPaths:
      attachmentPaths && attachmentPaths.length > 0 ? attachmentPaths : undefined,
  };
  // V0.6.31：用户主动推进新 action = 对旧 action 的 revise 已翻篇、清未处理标记
  unansweredRevises.delete(taskId);
  const entry = pendingMap.get(taskId);
  // 1) fresh 待命态 entry（存在且未 resolved）→ 直接交付
  if (entry && !entry.resolved) {
    finalizeEntry(taskId, entry, payload);
    console.log(
      `[chat-mcp] submitNextAction 直达 task=${taskId} actionId=${nextAction.actionId} type=${nextAction.type} n=${nextAction.n}`,
    );
    return true;
  }
  // 2) entry 存在但已 resolved = 上一个 ack 后的 60s grace 残留：agent 还活着、刚 ack 完正要重新
  //    进待命态（race：用户 ack 后秒推下一 action）→ 入队、等 registerPendingEntry 进待命态时兑现。
  //    直接 finalizeEntry 会撞 `if(entry.resolved) return` 被静默吞掉（这就是 V0.6.19 修的 race）。
  if (entry && entry.resolved) {
    pendingNextActions.set(taskId, payload);
    console.log(
      `[chat-mcp] submitNextAction 入队 task=${taskId} actionId=${nextAction.actionId} type=${nextAction.type} n=${nextAction.n}（entry 处于 grace 期已 resolved、等 agent 进待命态兑现）`,
    );
    return true;
  }
  // 3) entry 完全不存在 = agent 不在（已死 / 未启动）→ 返回 false、让 advanceTask 降级 force-new-agent。
  //    **不能入队**：没有活 agent 会来兑现、入队 = 永久卡住（保留原降级自愈逻辑）。
  console.warn(
    `[chat-mcp] submitNextAction 没找到 pending task=${taskId} type=${nextAction.type}、agent 不在、返回 false 让上层降级 force-new`,
  );
  return false;
};

/**
 * V0.6 finalizeTask：用户在 ack dialog 选「task 合入」/「abandon」、API 路由调这个、
 * 让 agent 拿到 [TASK_DONE] / [TASK_ABANDONED] 后收尾结束 Run。
 *
 * @param kind "done" → 合入 main、agent 拿 [TASK_DONE] 退出
 *             "abandoned" → 不要这个 task 了、agent 拿 [TASK_ABANDONED] 退出
 * @param message 可选：附加文本（agent 看到的提示语、给收尾留痕用）
 *
 * 返回值：
 *   - true：成功 resolve、agent 会拿到终态信号
 *   - false：没有 pending（task 没在跑、调用方应直接 patch repoStatus + 写 event）
 */
export const submitTaskTerminate = (
  taskId: string,
  kind: "done" | "abandoned",
  message?: string,
): boolean => {
  const entry = pendingMap.get(taskId);
  if (!entry) {
    console.warn(
      `[chat-mcp] submitTaskTerminate 没找到 pending task=${taskId} kind=${kind}`,
    );
    return false;
  }
  const defaultMessage =
    kind === "done"
      ? "Task 已合入 main、整个 task 结束、请收尾并结束 run。"
      : "Task 已被用户 abandon、整个 task 结束、请收尾并结束 run。";
  finalizeEntry(taskId, entry, {
    kind: "task_terminate",
    terminateKind: kind,
    text: message ?? defaultMessage,
  });
  console.log(
    `[chat-mcp] submitTaskTerminate 成功 task=${taskId} kind=${kind}`,
  );
  return true;
};

/**
 * 任务被关闭 / 取消时调、放掉所有 pending、不让 agent 永久挂着。
 *
 * 返回是否真的有 pending 被取消、调用方据此决定要不要写事件。
 */
export const cancelPending = (taskId: string): boolean => {
  // 任务取消时也清等待标记、避免下一次启动 task 时第一次调用被误判为旧 entry race
  waitingTasks.delete(taskId);
  // V0.6.19：连同清挂起的 NEXT_ACTION、避免 task 取消后队列残留泄漏 / 下次复用串味
  pendingNextActions.delete(taskId);
  // V0.6.31：连同清未处理 revise 标记（task 取消 / 重启 action 后旧标记不该影响新 run）
  unansweredRevises.delete(taskId);
  const entry = pendingMap.get(taskId);
  if (!entry) return false;
  finalizeEntry(taskId, entry, {
    kind: "cancelled",
    text: "任务已被用户取消、请收尾并结束 run。",
  });
  return true;
};

/**
 * 任务被永久删除时调、清进程级状态、避免内存泄漏。
 *
 * 跟 cancelPending 区别：cancel 是「当前 wait 取消、agent 该结束 run」、
 * cleanup 是「这个 task 不存在了、把所有跟它相关的状态都干掉」。
 */
export const cleanupChatTaskState = (taskId: string): void => {
  // 1) 如果还有 pending、先 resolve cancelled 让 agent 退出（finalizeEntry 已清 token / waitingTasks）
  cancelPending(taskId);
  // 2) 清 notifier / task action handler（waitingTasks 已在 cancelPending 里清）
  awaitingNotifiers.delete(taskId);
  taskActionHandlers.delete(taskId);
  // 3) 清 chat 模式标记（V0.7.20）
  chatModeTasks.delete(taskId);
};

/**
 * UI 拉状态时用：当前是否有 agent 在等用户输入。
 */
export const hasPending = (taskId: string): boolean => pendingMap.has(taskId);

/**
 * 比 hasPending 更精确：当前 pending 是否正好是 token 对应的那一段等待。
 * ask-reply route 预检用——把「agent 是否还在等」从 task 级收窄到「还在等这组 ask」、
 * 防旧弹窗对着被顶替的新 pending 误判 still-waiting（与 submitAskReply 的 token 校验配套）。
 */
export const hasPendingToken = (taskId: string, token: string): boolean => {
  const entry = pendingMap.get(taskId);
  return !!entry && entry.token === token;
};
