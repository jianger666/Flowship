/**
 * Task action 模式专用的本地 HTTP MCP server
 *
 * 这个文件做的事情：
 * 1. 用官方 `@modelcontextprotocol/sdk` 起一个 stateful 的 HTTP MCP server
 * 2. 在它上面注册 `wait_for_user` / `ask_user` 工具
 * 3. 维护进程内的 pendingMap：tool 调用时阻塞、由别处（advance / ack route）resolve
 * 4. 暴露一个 fetch-style 的 `handleChatMcpRequest`、给 Next.js App Router 直接调
 *
 * ## V0.6 关键变化：单 SDK Run 永生 + action 历史模型
 *
 * task 启动后整段生命周期跑在一个 SDK Run 里。agent 永远不主动结束 Run、
 * 只有 server 端写明确终止信号（[TASK_DONE] / [TASK_ABANDONED] / [CANCELLED]）才退。
 *
 * 信号统一改成 action 维度：
 *   - `[ACTION_ACK approve]` / `[ACTION_ACK revise]`：ack 当前 action（替 V0.5 [PHASE_ACK *]）
 *   - `[NEXT_ACTION action_id=... type=... n=... artifact_path=...]`：用户在 UI 推进新 action
 *   - `[USER_REPLY]`：ask_user 答完 / chat 模式用户消息（chat 模式走独立 chat-runner、但复用同一 pendingMap / wait-ack 通路）
 *   - `[CANCELLED]` / `[STALE]` / `[INVALID_TOKEN]`：终态（沿用）
 *
 * agent 协议（详见 prompts/_super.md）：
 *   - 一个 action 完成（写完 artifact）→ wait_for_user({task_id, action_id, artifact_path}) 等 ACTION_ACK
 *   - ACTION_ACK approve → 立刻再调 wait_for_user({task_id}) （**不**带 action_id）等下一 action 指令
 *   - 收到 [NEXT_ACTION ...] → 解析头部 + 用户指令、执行对应 action prompt
 *   - 整段 Run 持续到 server 写 [TASK_DONE] / [TASK_ABANDONED] / [CANCELLED]
 *
 * ## V0.3.5 保活机制：shell + curl long-poll 取代 MCP 轮转（沿用至 V0.6）
 *
 * wait_for_user / ask_user 立即返回 shell 引导、agent 调 `shell` 工具跑
 * `curl -sN '<url>/api/tasks/:id/wait-ack?token=…'` 跟服务端建一条长 HTTP 连接。
 * /wait-ack 路由 subscribeWaitAck 拿 pendingMap 里的 promise、服务端 chunked write
 * 每 60 秒一次 `[KEEPALIVE ts=...]` 普通文本行、用户 ack/reply/advance 时 resolve
 * 这个 promise → 写一行结果 + 关连接 → curl 拿到 stdout → agent 推进下一步。
 *
 * ## 不做的
 *
 * - 不做 MCP session id 跨进程：本来 stateless 就够、但 wait_for_user 长阻塞必须 stateful 复用 transport
 * - 不做并发去重：同一个 task 同时只允许一个 pending entry、新 wait_for_user 顶旧的
 * - 不做 dev hot reload 状态恢复：开发时模块重载会丢 pendingMap、能接受
 * - **单条 curl 长链接（V0.7.18 起、简化自旧 while 重连）**：wait-ack 引导给的就是一条 `curl -sN`——本地回环连接稳定、
 *   不加 `--max-time`、不套 while 重连。服务端每 60 秒发 `[KEEPALIVE]` 维持（防 SDK shell idle-timeout 杀连接）、
 *   用户 ack 时 resolve → 写终态行 + 关流 → curl 自然 exit、agent 推进。旧 while/max-time 是早期对「连接会断」的过度防御、
 *   实测本地长连不会断、反而徒增 agent 把 curl 放后台 / 自己重连的误操作面（V0.7.17 踩过 composer 放后台导致 run 提前退）、故 V0.7.18 砍掉。
 *   （subscribeWaitAck 不消费 token、route abort 不清 pendingMap entry、所以 curl 万一意外断、同 token 再调一次能接上同一 entry。）
 * - **只有真失效才退 run**：[STALE]/[INVALID_TOKEN]（多为 dev hot reload / 服务重启丢 pendingMap）或 curl 异常 exit、
 *   agent 退 run、用户在 UI 手动「推进」起新 agent 接力（task 走 /advance→advanceTask、chat 走 /chat-reply→runChatSession、
 *   Agent.create + send、靠任务事件日志恢复上下文、不是 resume 原会话）
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import type { ActionType, PlanBatch } from "../types";
import {
  SIGNALS,
  buildNextActionHead,
  shellWaitGuideHead,
} from "../protocol-signals";
import {
  chatShellWaitGuideBody,
  shellCurlRunSection,
  waitDisciplineSection,
} from "./wait-protocol-prompt";

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
interface PendingEntry {
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
type AskUserOption = { id: string; label: string };
type AskUserQuestion = {
  id: string;
  question: string;
  options?: AskUserOption[];
  allowText: boolean;
};

type AwaitingSignal =
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

type ChatTaskActionResult =
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
}

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
const GLOBAL_KEY = "__feAiFlowChatStateV11__";

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
const unansweredRevises = getGlobalState().unansweredRevises;

// V0.7.20：chat 模式 task 集合（见 ChatMcpGlobalState 注释）
const chatModeTasks = getGlobalState().chatModeTasks;

/** chat-runner 启动 chat session 时调：标记此 task 走 chat 等待引导（精简、USER_REPLY 语境）。 */
export const markTaskAsChat = (taskId: string): void => {
  chatModeTasks.add(taskId);
};

/** chat session 结束 / task 清理时调：取消 chat 标记。 */
export const unmarkTaskAsChat = (taskId: string): void => {
  chatModeTasks.delete(taskId);
};

// 「这个 task 当前是否处在等待用户的状态」
// wait_for_user / ask_user MCP 工具进来时标 true、submitXxx / cancelPending 清
// 用途：UI 拉状态、runner 切 task.runStatus = awaiting_user 时去重
const waitingTasks = getGlobalState().waitingTasks;

// token → taskId 路由表、wait-ack 路由验 token 合法性用
// 生命周期：registerPendingEntry 写、finalizeEntry 清
const tokenToTask = getGlobalState().tokenToTask;

// 生成短 token：8 字符 base36、足够防撞、又不浪费 context
// 不用 uuid 是因为更短、且模型只需要识别 / 透传、不需要 cryptographic strength
const newWaitToken = (): string =>
  Math.random().toString(36).slice(2, 10);

// chat 模式每轮用户消息尾部固定拼的「recency 提醒」（V0.7.20）。
// 为什么放这里而不是只在起手 prompt 讲：起手注入一次、长对话里会被后面几十轮淹掉、composer-2.5
// 实测「理解协议但漏执行」——它自己都能准确诊断「回复完该挂等」、却在长上下文里忘了做。
// 把这条贴在**每一条用户回复的尾部**（agent 下一步就是回复用户、这是它最近读到的文本）、
// 用命令式 do-this 而非长篇 why（它不缺理解、缺的是「就在眼前的执行提醒」）。
// 用户在 UI 看不到 curl stdout、所以这句只给 agent、不污染用户视野。
const CHAT_REPLY_REMINDER =
  "（系统提醒，非用户所说）回答完上面这条后，立刻再调一次 `wait_for_user` 挂等下一条——这是本轮必须做的收尾动作，漏掉对话就断了。";

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
const registerPendingEntry = (
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
const runTaskAction = async (
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

const safeNotifyAwaiting = async (
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
const safeNotifyAskUserRequest = async (
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

// ----------------- shell 引导文本：教 agent 调 shell + curl wait-ack -----------------
//
// wait_for_user / ask_user MCP 工具 handler 立即返回这段文本、agent 看到 [SHELL_WAIT_GUIDE]
// 标记就该调 shell 工具执行 curl 命令、跟服务端 /api/tasks/:id/wait-ack 路由建长连接。
//
// V0.6 改造：context 文案改成 action 维度、新增 [NEXT_ACTION ...] 解读说明
const buildShellWaitGuidance = (
  taskId: string,
  token: string,
  opts: {
    actionId?: string;
    artifactPath?: string;
    mode: "wait_for_user" | "ask_user";
    // V0.6.31：未处理 revise 自动纠正命中时 true、引导文本头部加责令段
    reviseCorrection?: boolean;
  },
): string => {
  const baseUrl = getServerBaseUrl();
  const url = `${baseUrl}/api/tasks/${encodeURIComponent(taskId)}/wait-ack?token=${encodeURIComponent(token)}`;
  // V0.7.20：chat 模式走精简引导（USER_REPLY 语境、不夹 task 专属的 ACTION_ACK / NEXT_ACTION 信号）。
  // 完整等待纪律已在 chat 起手 prompt（chatWaitProtocolSection）讲过一次、这里只给 curl + 怎么读输出。
  if (chatModeTasks.has(taskId)) {
    return [shellWaitGuideHead(token), "", chatShellWaitGuideBody(url)].join("\n");
  }
  const contextLine =
    opts.mode === "ask_user"
      ? "等用户在 UI 弹窗里答完 ask_user 问题、curl 拿到 `[USER_REPLY]` 行带 markdown Q&A、解析每条答案接着工作。"
      : opts.actionId
        ? `等用户对 action=${opts.actionId}（artifact=${opts.artifactPath ?? "<未指定>"}）点 approve / revise、curl 拿到 \`[ACTION_ACK approve]\` 或 \`[ACTION_ACK revise] <feedback>\` 接着推进。`
        : "等用户在 UI 点「推进」选下一 action。curl 可能拿到：\n    - `[NEXT_ACTION action_id=... type=... n=... artifact_path=...]\\n\\n<用户指令>` → 解析头部 + 按对应 action prompt 执行";
  const correctionBlock = opts.reviseCorrection
    ? [
        "",
        "## 🚨 协议违规、已被服务端纠正（先读这段再跑 shell）",
        "",
        `你刚收到 action=${opts.actionId} 的 [ACTION_ACK revise] feedback、但**没做任何处理**就调了 wait_for_user 且没带 action_id。`,
        "服务端已强制把本次等待绑回该 action。**在跑下面的 shell 之前、你必须先补上欠用户的处理**（super-prompt §3 revise 二分类）：",
        "  - feedback 是纯疑问句（问类）→ 立刻 emit 一条 assistant_message 完整答疑、不动 artifact",
        "  - 其他（改类、含模糊兜底）→ 立刻调 ask_user 复述「我打算改 X、对吗？」、用户 ✅ 才动手",
        "处理完再跑 shell 等这个 action 的下一次 ack。下次记住：revise 处理完重新调 wait_for_user 时**必须带同一 action_id**。",
      ]
    : [];
  return [
    shellWaitGuideHead(token),
    ...correctionBlock,
    "",
    shellCurlRunSection(url),
    "",
    "## stdout 解读规则（决定你下一步动作、必背）",
    "",
    "shell stdout 按时序输出这些行、看到哪个按哪个走：",
    "",
    "  - `[KEEPALIVE ts=...]`：60 秒一次心跳、忽略它。",
    `  - \`[ACTION_ACK approve]\`：用户点了「通过」、curl exit。**不要结束 Run**、立刻再调 \`wait_for_user(task_id=${taskId})\`（不带 action_id）等下一 action 指令。**别 emit 总结**——用户在看板看 timeline 推进就够。`,
    "  - `[ACTION_ACK revise] <feedback>`：用户点了「再聊聊」、按 super-prompt §3 revise 二分类处理（问类 emit 答疑 / 改类 ask_user 复述后 edit）、完事再调 `wait_for_user(task_id, action_id, artifact_path)` 等同 action 下一次 ack。",
    "  - `[NEXT_ACTION action_id=... type=... n=... artifact_path=...]` + 空行 + `<用户指令>`：用户推进新 action、解析头部 + 指令、跳对应 action 执行。",
    "  - `[USER_REPLY] <markdown Q&A>`：ask_user 答完、按内容推进（chat 自由对话不走本工具）。",
    "  - `[TASK_DONE]` / `[TASK_ABANDONED]` / `[CANCELLED]`：收尾结束 Run。",
    "  - `[STALE]` / `[INVALID_TOKEN]`：本 token 失效、别重试、自然结束 Run。",
    "  - `[INTERNAL_ERROR]`：服务端内部错误、重调一次 `wait_for_user`（同参数）重建、连续 2 次仍 INTERNAL_ERROR 才结束 Run。",
    "",
    waitDisciplineSection(),
    "",
    "## 这次 wait 的目的",
    contextLine,
  ].join("\n");
};

// ----------------- McpServer 构造 -----------------

const buildMcpServer = (): McpServer => {
  const srv = new McpServer({
    name: "ai-flow-task",
    version: "1.0.0",
  });

  srv.registerTool(
    "wait_for_user",
    {
      title: "发起一次等用户 ack 请求（立即返回 shell 引导）",
      description: [
        "ai-flow 用这个工具发起一次「等用户」请求、本工具**立即返回一段 [SHELL_WAIT_GUIDE] 引导文本**、",
        "教你调 `shell` 工具用 curl 跟服务端 /api/tasks/:id/wait-ack 路由建长连接等结果。",
        "",
        "## 硬性规则（不遵守、ai-flow runner 会把任务标 failed）",
        "",
        "- **完成一个 action（写完 artifact）后必须调一次本工具**、shell 拿到 `[ACTION_ACK approve]` / `[ACTION_ACK revise]` 才能继续",
        "- **不调本工具 = action 没完成**、runner 在 run 结束时硬检测、有 action 状态不是 ack 一律标 failed",
        "- **不要写完 artifact 后只发 assistant_message 说「请你 approve」就退出 run**——实测最常见的错误模式",
        "- **绝对不要主动结束 Run**——只有服务端写 [TASK_DONE] / [TASK_ABANDONED] / [CANCELLED] 时 Run 才该结束",
        "",
        "## 两种用法（按所处阶段选）",
        "",
        "### A. action 内 ack（完成 action artifact 后）",
        "  - 用法：`wait_for_user({ task_id, action_id, artifact_path })`",
        "  - `action_id`：当前 action 的 id（agent 启动时 / [NEXT_ACTION ...] 头里传过的）",
        "  - `artifact_path`：刚产出的 artifact 相对路径（如 `actions/1-plan.md`）",
        "  - 返回：`[SHELL_WAIT_GUIDE]`、按引导调 shell + curl 等用户 approve / revise",
        "",
        "### B. 待命态（ack approve 完、等用户推进下一 action）",
        "  - 用法：`wait_for_user({ task_id })`（**不**传 action_id）",
        "  - 返回：`[SHELL_WAIT_GUIDE]`、curl 等用户在 UI 选下一 action、stdout 拿 `[NEXT_ACTION ...]` + 用户指令",
        "",
        "## 调用礼仪",
        "  - 调用前 / 中 / 后都不要在 assistant_message 里讲本工具的存在、对用户透明",
        "  - 每完成一个 action 调一次 A 路径（不要每写一句就调、也不要写完了不调）",
        "  - 拿到 [ACTION_ACK approve] 后立刻调 B 路径（不带 action_id）等下一 action 指令",
      ].join("\n"),
      inputSchema: {
        task_id: z.string().describe("任务 id（agent 启动时被告知）"),
        action_id: z
          .string()
          .optional()
          .describe(
            "完成一个 action 后必传：当前 action 的 id（agent 启动 / [NEXT_ACTION] 头里传过的）。等下一 action 指令时留空。",
          ),
        artifact_path: z
          .string()
          .optional()
          .describe(
            "完成 action 时可选：刚产出的 artifact 相对 task 根的路径（如 `actions/1-plan.md`）。用于 UI 展示和审计。",
          ),
      },
    },
    async ({ task_id, action_id, artifact_path }) => {
      console.log(
        `[chat-mcp] wait_for_user 入参 task_id=${task_id} action_id=${action_id ?? "<待命>"} artifact_path=${artifact_path ?? "<none>"}`,
      );

      // V0.6.31 自动纠正：上一次 ack 是 revise 且 agent 还没闭环（没带原 action_id 回来）时——
      //   - 不带 action_id（实测踩坑姿势：agent 收到 revise 什么都不干直接退待命）→ 强制按原 action
      //     注册 ack 态：UI 的 通过/再聊聊 按钮不丢、用户还能继续对话；返回文本责令 agent 补处理
      //   - 带原 action_id 回来（协议正确、答疑 / 弹窗已做）→ 标记闭环、正常放行
      let effectiveActionId = action_id;
      let effectiveArtifactPath = artifact_path;
      let reviseCorrection = false;
      const owed = unansweredRevises.get(task_id);
      if (owed) {
        if (!action_id) {
          effectiveActionId = owed.actionId;
          effectiveArtifactPath = owed.artifactPath;
          reviseCorrection = true;
          console.warn(
            `[chat-mcp] wait_for_user 自动纠正：task=${task_id} 有未处理 revise（action=${owed.actionId}）、agent 没带 action_id、强制回 ack 态`,
          );
        } else {
          // 带了 action_id（原 action 或新 action）都视为 agent 已在正轨、标记闭环
          unansweredRevises.delete(task_id);
        }
      }

      // V0.3.5：注册 pending entry（建 promise、写 pendingMap、生成 token）、立即返回 shell 引导
      // 旧 entry 由 registerPendingEntry 自动 stale 顶替（极少见、agent 通常一次 wait 走完）
      const entry = registerPendingEntry(task_id, {
        actionId: effectiveActionId,
        artifactPath: effectiveArtifactPath,
      });

      // 仅当「之前不在等待」时才通知 runner 切 task.runStatus = awaiting_user
      // （registerPendingEntry 顶替旧 entry 时 finalizeEntry 会清 waitingTasks、所以这里能再 add）
      // V0.6.19：若 registerPendingEntry 刚兑现了挂起的 NEXT_ACTION（entry 已 resolved）、
      // agent 马上要跑下一 action、不是真在等用户 → 跳过 awaiting_user notify、
      // 否则会把 advanceTask 刚设的 running 错切回 awaiting_user（build 全程显示成「等待用户」）。
      if (!entry.resolved && !waitingTasks.has(task_id)) {
        waitingTasks.add(task_id);
        await safeNotifyAwaiting(task_id, {
          actionId: effectiveActionId,
          artifactPath: effectiveArtifactPath,
        });
      }

      return {
        content: [
          {
            type: "text" as const,
            text: buildShellWaitGuidance(task_id, entry.token, {
              actionId: effectiveActionId,
              artifactPath: effectiveArtifactPath,
              mode: "wait_for_user",
              reviseCorrection,
            }),
          },
        ],
      };
    },
  );

  // ----------------- ask_user 工具（V0.3.2 一次打包多问题、modal 形态、V0.5.6 无上限）-----------------
  //
  // 设计动机（用户拍板）：
  //   - 单次调用：把当前 turn 想得到的不确定项**一次性打包**成 questions[]、UI modal 一次问完
  //   - V0.5.6 改：**没有「一个 action 最多 1 次」上限**——agent 按内容判断、按需多次调
  //     比如初稿打一次包问 → 用户答模糊 → read/grep 形成判断 → 再调一次给具体选项
  //     直到所有问题都收敛到明确决策（A 路径）才 wait_for_user
  //   - V0.5.6 加 defer：用户可在 UI 弹窗点「稍后再补充」、agent 拿 [ASK_USER_REPLY deferred]
  //     跳过这组 Q、按 default 推进、列进 artifact §6 待澄清
  //
  // 返回值：拼接成 markdown 的文本、agent 直接读、按头部协议分两种走法：
  //   - 用户答了：`[ASK_USER_REPLY]\nQ1: ...\nA: ...\n\nQ2: ...\nA: ...`
  //   - 用户点稍后再补充：`[ASK_USER_REPLY deferred]\n...\n未答问题清单：\nQ1: ...\nQ2: ...`
  //
  // V0.3.5 保活语义同 wait_for_user：立即返回 [SHELL_WAIT_GUIDE token=xxx]、
  // agent 调 shell 工具跑 curl 长连接 /api/tasks/:id/wait-ack、stdout 一行解析结果。
  // 复用 pendingMap：同一时刻一个 task 只能有一个 pending
  srv.registerTool(
    "ask_user",
    {
      title: "action 内打包提问（一次问完所有不确定项）",
      description: [
        "结构化 action（plan / build / review / ship / test / learn）内 agent 遇到不确定项时、把当前轮想问的**全部打包**成 questions[]、阻塞等用户在 UI 弹窗里答完整组。",
        "对标 Cursor `askFollowUpQuestion`：UI 出选项按钮 + 可选自由文本输入。",
        "",
        "## ⚠️ chat 模式（task.mode === 'chat'）禁用（V0.6.0.1 拍板）",
        "",
        "**本工具只用于 task 容器模式的 action（plan / build / review / ship / test / learn）**。chat（自由对话）任务跑在独立 chat-runner、prompt 里已禁用 ask_user——",
        "chat 模式有问题想跟用户确认时、**直接 emit 一段 assistant_message 问**就行（用 markdown 列清楚 A/B/C 选项也可以、但走文本不走弹窗）、然后正常 wait_for_user 等用户回。",
        "用户原话：「自由模式下不用提问、直接回答、自由模式就是 talk 而已」。",
        "",
        "## 关键约束（V0.5.6 重写：无次数上限、按内容收敛）",
        "",
        "- **单次调用内**：把当前轮想问的问题**全部打包**到 questions[]、UI modal 一次答完——不要同一时刻调多次（一时刻只能有一个 pending、第二次会顶替第一次）",
        "- **整个 action 内无次数上限**：agent 按内容判断——比如「初稿打一次包问 → 用户答模糊 → read/grep 形成判断 → 再调一次给具体选项」是正常流程",
        "- **收敛标准**：所有问题都得到「明确的业务决策」（即 A 路径——能直接落进 artifact 的）才能 wait_for_user。判不准就再问、不要打 default 跳过",
        "- **只在确实有不确定项时调用**——没问题就跳过、直接 wait_for_user",
        "- **options 里不要手动塞「Other / 其他 / 其它 / 以上都不是 / 自定义」类的兜底选项**——`allow_text=true` 时 UI 会自动渲染「以上都不是 / 自定义回答…」按钮、你再加会重复",
        "",
        "## 何时调用",
        "",
        "- artifact 初稿写完、扫一遍发现有不确定 / 多选 / 歧义点：上下文冲突、口径不清、接口字段不明、技术路线 A/B",
        "- 用户上一轮答案模糊 /「你定 / 看代码再说」——read/grep 形成判断后、再调一次给具体业务选项让用户拍板",
        "- revise 闭环里用户 feedback 含混（C 路径）——调一次复述意图",
        "- 把当前轮所有问题打包进 questions[]、一次问完",
        "",
        "## 入参",
        "",
        "- `task_id`：任务 id（启动时被告知）",
        "- `action_id`：当前所处 action 的 id（agent 启动 / [NEXT_ACTION] 头里传过的）",
        "- `questions`：问题数组、每条结构：",
        "    - `id`：问题唯一标识、不要重复（如 `q1` / `q2` / `conflict_role`）",
        "    - `question`：问题正文、清晰可读、必要时带背景（≤ 200 字）",
        "    - `options`：可选项数组 `[{id, label}, ...]`、2-4 个具体**业务选项**、最多 6 个、**UI 自动加 A/B/C/D 字母前缀**",
        "      - **严禁** 在 options[] 里塞「其他 / Other / 自定义 / 自由文本说明 …」这类兜底项",
        "    - `allow_text`：保留默认 true。它只是控制 UI 是否渲染那个「以上都不是 / 自定义回答…」按钮、不要把它理解成「我要在 options 里加一个 Other 选项」",
        "",
        "## 返回值（V0.3.5 起：shell + curl long-poll、V0.5.6 加 deferred）",
        "",
        "- 立即返回 `[SHELL_WAIT_GUIDE token=xxx]`、文本里附完整 curl 命令——调一次 `shell` 工具跑这条命令、长连接挂在 /api/tasks/:id/wait-ack",
        "- 用户在弹窗答完后、shell stdout 可能拿到两类头：",
        "  - `[ASK_USER_REPLY]` + Q&A markdown：用户答了、解析每条 A、按 A/B/C/D 分级处理（A 直接落 artifact；C 模糊 → 再调一次 ask_user 给具体选项）",
        "  - `[ASK_USER_REPLY deferred]` + 未答问题清单：**用户点了「稍后再补充」**——你必须 1）不再就这组 Q 重新调 ask_user 2）把这些 Q 完整列进 artifact「§6 待澄清」段、按你判断的合理 default 推进 3）继续 wait_for_user",
        "- 其他可能 stdout 行：`[CANCELLED]`（用户取消任务）/ `[STALE]`（旧 token 被新 wait_for_user 顶替）/ `[INVALID_TOKEN]`",
        "",
        "## 调用礼仪",
        "",
        "- 调用前 / 后不要 assistant_message 解释「我先问几个问题」「我再问一次」之类、UI modal 会自动弹出来",
        "- 答完后不要复述「你刚才选了 X」、直接按答案推进、在 artifact 正文（§1 / §3 / §4 等结论引用处）就地加 `> ✅ ask_user 已确认：用户选 X` 内联备注",
        "- 答案**只**写到 artifact、**不再**自动落 contextDocs——单一数据源、避免重复",
      ].join("\n"),
      inputSchema: {
        task_id: z.string().describe("任务 id"),
        action_id: z
          .string()
          .optional()
          .describe("当前 action id（plan / build / review / ship / test / learn）"),
        questions: z
          .array(
            z.object({
              id: z
                .string()
                .describe("问题唯一标识、不要重复（如 q1 / q2 / conflict_role）"),
              question: z.string().describe("问题正文、UI 顶部显示"),
              options: z
                .array(
                  z.object({
                    id: z.string().describe("选项标识、提交时随答案带回"),
                    label: z.string().describe("选项展示文本（UI 自动加 A/B/C/D 前缀）"),
                  }),
                )
                .optional()
                .describe(
                  "可选项数组、2-4 个最常见、最多 6 个。**不要在这里塞 Other / 其他 / 其它 / 以上都不是 / 自定义 类的兜底项**——allow_text=true 时 UI 会自动加一个「以上都不是 / 自定义回答…」按钮、你再加会重复。",
                ),
              allow_text: z
                .boolean()
                .optional()
                .describe(
                  "是否在选项底下渲染「以上都不是 / 自定义回答…」按钮、默认 true。注意：不要把这个字段理解成「在 options[] 里加一个 Other 选项」、UI 兜底入口完全由 UI 渲染、你只要列具体业务选项",
                ),
            }),
          )
          .min(1)
          .describe("问题数组、当前轮所有不确定项打包进来、至少 1 条"),
      },
    },
    async ({ task_id, action_id, questions }) => {
      const askId = `ask_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      // 归一化：清掉空白、补齐 allow_text 默认值
      const normalized: AskUserQuestion[] = questions.map((q) => ({
        id: q.id,
        question: q.question.trim(),
        options: q.options,
        allowText: q.allow_text !== false,
      }));

      // V0.3.5：注册 pending entry（生成 token、建 promise）、立即返回 shell 引导
      const entry = registerPendingEntry(task_id, { actionId: action_id });
      console.log(
        `[chat-mcp] ask_user 入参 task=${task_id} action_id=${action_id ?? "<none>"} askId=${askId} token=${entry.token} questions=${normalized.length}`,
      );

      // 通知 runner 写 ask_user_request 事件 + 切 runStatus = awaiting_user
      await safeNotifyAskUserRequest(task_id, {
        askId,
        token: entry.token,
        questions: normalized,
        actionId: action_id,
      });
      waitingTasks.add(task_id);

      return {
        content: [
          {
            type: "text" as const,
            text: buildShellWaitGuidance(task_id, entry.token, {
              actionId: action_id,
              mode: "ask_user",
            }),
          },
        ],
      };
    },
  );

  // ----------------- submit_mr 工具（V0.6.1、ship action 专用、同步调 GitLab API）-----------------
  //
  // 这是「同步 RPC 工具」、跟 wait_for_user / ask_user 的「长阻塞 + shell long-poll」完全不同：
  //   - 不需要等用户操作、纯 server-side 调 GitLab REST API、立即返回结果
  //   - 不需要写 shell + curl 引导、agent 拿到 MCP 结果就接着推进
  //   - 不需要 token / pendingMap：每次调用 server 自己访问 GitLab 即可
  //
  // 调用前置条件（agent 自己保证、server 不校验）：
  //   - branch 已 push 到 origin（不然 GitLab 创 MR 会报 source_branch 不存在）
  //   - last_commit_hash 是 push 后的最新 commit hash（用 `git rev-parse HEAD` 拿）
  srv.registerTool(
    "submit_mr",
    {
      title: "提交 GitLab MR（ship action 专用、server 同步调 REST API）",
      description: [
        "ship action 跑通后、调本工具让 server 端用 GitLab REST API 创 MR。",
        "",
        "## 调用前置（agent 自己保证）",
        "",
        "1. `git push origin <branch>` 已成功（不然 GitLab 创 MR 会报 source_branch 不存在）",
        "2. 用 `git rev-parse HEAD` 拿当前最新 commit hash、作为 `last_commit_hash` 入参",
        "3. 用 `git config --get remote.origin.url` 拿 GitLab project path（如 `wkid/crm-web`）",
        "",
        "## 再次 ship 幂等（重要）",
        "",
        "同一仓再次 ship（累计 commit / 解冲突后重跑）直接再调本工具即可、server 会自动复用现有 open MR（不会重复建、不会报「已存在」）——你只管 push 新 commit + 调本工具、MR 自动跟踪。",
        "",
        "## 多仓 task：每仓调一次本工具",
        "",
        "ship action 内部如果 task 涉及多个仓、对每个仓独立 `cd` + `git push` + 本工具调用、每仓拿一条 MR。",
        "如果某仓没改动（`git diff` 为空）、跳过该仓不调本工具、在 artifact 里说明「<仓名> 本次无改动、跳过 push + MR」。",
        "",
        "## 返回值",
        "",
        "成功：`{ ok: true, data: { mr_url, mr_iid, mr_version, has_conflicts, merge_status, merge_undetermined } }`",
        "  - `mr_url`：MR 网页 URL、直接给用户点开",
        "  - `mr_iid`：GitLab project 内 MR 编号（用户看到的 !N、不是全局 ID）",
        "  - `mr_version`：本仓累计 push 次数（首次=1、之后每次 ship ++、用于在 MR description 里标 `v2 / v3` 等）",
        "  - `has_conflicts`：**重点**——本 MR 跟 `test` 有没有冲突、`true` = 合不了、按下方铁律处理",
        "  - `merge_status`：GitLab detailed_merge_status 原值（mergeable / conflict / checking ...）、审计用",
        "  - `merge_undetermined`：GitLab 还在异步算可合性、本次没查准（保守当无冲突、可在 artifact 注明待人工复核）",
        "",
        "## ⚠️ has_conflicts=true 时（铁律、按 ship prompt §3.5/§3.6 走）",
        "",
        "1. **绝不**把 `test` `merge` / `rebase` / `pull` 进 **feature** 分支、也不 force push feature/测试分支——feature 本体永远干净",
        "2. **先不**发飞书评论——飞书 @ 评论只在「所有仓 MR 都无冲突」时才发、不能把合不了的 MR 甩给测试人员",
        "3. 调 `ask_user` 问用户「AI 智能解 / 自己解」：",
        "   - 选 **AI 解** → 按 §3.6：另建一次性 `<feature>__conflict` 分支（基于 test）、把 feature 合进去解冲突、`push -f` 后用 `__conflict` 当 source_branch 再调本工具（server 会自动关掉被取代的旧 MR）。仅这条 `__conflict` 分支上的 merge / force push 是铁律豁免、feature 全程不动",
        "   - 选 **自己解** → 等用户解完回复、重跑 ship",
        "",
        "失败：`{ ok: false, error: \"<人类可读错误>\" }`",
        "  - 常见错误：token 失效 / project 不存在 / branch 不存在（push 没成功）、agent 把错误内容简短告诉用户即可、不要自己重试",
        "",
        "## 调用礼仪",
        "",
        "- 调用前不发 assistant_message「我要提测了」之类、对用户透明",
        "- 调用后拿到 `mr_url` 直接落到 artifact、ack 时用户能看到 MR 链接",
      ].join("\n"),
      inputSchema: {
        task_id: z.string().describe("任务 id"),
        action_id: z.string().describe("当前 ship action 的 id"),
        repo_path: z
          .string()
          .describe(
            "本地仓库绝对路径（如 `/Users/clj/Documents/crm-web`、agent 从 `pwd` 取、用于 server 端区分多仓的 sideEffects）",
          ),
        project_path: z
          .string()
          .describe(
            "GitLab project path（如 `wkid/crm-web`、从 `git config --get remote.origin.url` 解析、不含 host）",
          ),
        source_branch: z
          .string()
          .describe("MR 源分支（task.gitBranches 里这仓对应的 branch name）"),
        target_branch: z
          .string()
          .describe(
            "MR 目标分支 = 该仓的测试分支（见 super prompt「## 仓库分支配置」段、没配则 `test`）、不要探 origin/HEAD 拿 master/main",
          ),
        title: z.string().describe("MR 标题（建议格式：`[role] <task.title>`）"),
        description: z
          .string()
          .describe(
            "MR 描述（建议含飞书 story 链接 / plan artifact 摘要 / 多次 ship 时标注 v2 / v3）",
          ),
        last_commit_hash: z
          .string()
          .describe("当前 branch 最新 commit hash（`git rev-parse HEAD`）"),
      },
    },
    async ({
      task_id,
      action_id,
      repo_path,
      project_path,
      source_branch,
      target_branch,
      title,
      description,
      last_commit_hash,
    }) => {
      console.log(
        `[chat-mcp] submit_mr task=${task_id} action=${action_id} repo=${repo_path} project=${project_path} src=${source_branch}→${target_branch}`,
      );
      const result = await runTaskAction(task_id, {
        kind: "submit_mr",
        actionId: action_id,
        repoPath: repo_path,
        projectPath: project_path,
        sourceBranch: source_branch,
        targetBranch: target_branch,
        title,
        description,
        lastCommitHash: last_commit_hash,
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      };
    },
  );

  // ----------------- set_feishu_testers 工具（V0.6.1、ship action 用）-----------------
  //
  // 把探测 / 用户填的飞书测试人员 user_key 列表持久化到 task.feishuTesterUserKeys。
  // 同 task 后续 ship 不再探测 / 不再问用户、agent 直接读 task 里的字段拼飞书评论。
  //
  // 2026-06-12 起从 lark_user_id 切到 user_key（官方 MCP add_comment 改按 user_key 校验、
  // lark_user_id 报 cross tenant）、describe 必须跟 action-ship.md §2/§4 保持一致。
  //
  // 空数组 = 显式记忆「没测试人 / 用户选了跳过 @」、跟 undefined 区分。
  srv.registerTool(
    "set_feishu_testers",
    {
      title: "持久化飞书 story 测试人员 user_key 列表（ship action 用）",
      description: [
        "把当前 task 关联的飞书 story 测试人员 user_key 列表写到 task.feishuTesterUserKeys。",
        "",
        "## 什么时候调",
        "",
        "首次 ship action 内、按以下顺序探测：",
        "  1. 调飞书 MCP 的 `get_workitem_brief` 抓「测试」角色的 role_members、`member.key` 就是 user_key（纯数字、直接用）",
        "  2. 探到任意人 → 调本工具持久化 / 探不到 → 调 ask_user 让用户填用户名 + `search_user_info` 取 user_key 字段后用本工具落库",
        "",
        "同 task 后续 ship action 直接读 `task.feishuTesterUserKeys`、**不再调本工具 / 不再探测 / 不再问用户**。",
        "",
        "## 入参",
        "",
        "- `action_id`：当前 ship action 的 id",
        "- `user_keys`：飞书项目 user_key 数组（纯数字、**不是** lark_user_id）、可以空（= 显式记忆「这个 task 没测试人 / 跳过 @」）",
        "",
        "## 返回值",
        "",
        "- 成功：`{ ok: true }`",
        "- 失败：`{ ok: false, error: \"...\" }`（一般是 task 没在跑了）",
      ].join("\n"),
      inputSchema: {
        task_id: z.string().describe("任务 id"),
        action_id: z
          .string()
          .describe("当前 ship action 的 id（让「已记忆测试人员」事件挂到该 action、跟 submit_mr 对齐）"),
        user_keys: z
          .array(z.string())
          .describe(
            "飞书项目 user_key 数组（纯数字、不是 lark_user_id）、可以为空数组（= 记忆「跳过 @ 测试人员」）",
          ),
      },
    },
    async ({ task_id, action_id, user_keys }) => {
      console.log(
        `[chat-mcp] set_feishu_testers task=${task_id} action=${action_id} userKeys=${user_keys.length}`,
      );
      const result = await runTaskAction(task_id, {
        kind: "set_feishu_testers",
        actionId: action_id,
        userKeys: user_keys,
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      };
    },
  );

  // ----------------- set_plan_batches 工具（V0.6.23、plan action 用）-----------------
  //
  // plan agent 把大需求拆成「批次」（可独立 build/review 的功能块）后调本工具上报、
  // 落到该 plan action 的 planBatches。build 推进时用户按批次勾选、进度从 action 历史推导。
  //
  // 不靠解析 markdown：跟 submit_mr / set_feishu_testers 同套路、结构化上报最可靠。
  srv.registerTool(
    "set_plan_batches",
    {
      title: "上报 plan 拆出的批次（大需求分批 build 用）",
      description: [
        "把当前 plan 拆出的「批次」结构化上报、落到该 plan action。",
        "调本工具即可——批次表由系统自动渲染在 plan 下方、**不用在 artifact 里写批次表**。",
        "",
        "## 什么时候调",
        "",
        "plan action 内、写完方案 artifact 后——**仅当本需求够大、一次 build 跑不稳妥时**才调：",
        "  - 把 plan §5 的 task 归并成若干「可独立交付的功能块」= 批次",
        "  - 每批标一个测试策略（见下）、列出含哪些 task",
        "  - 小需求（一次 build 能稳妥做完）**不要调本工具**、保持单批老流程",
        "",
        "## 批次怎么分",
        "",
        "  - 按「可独立验证」切：接口层 / 数据转换 / 列表页 / 表单页 / 联调 等",
        "  - 有依赖的排前面（数组顺序 = 建议 build 顺序）",
        "  - 单批控制在「一个新 agent 一口气能稳妥做完」的量级（别太大、违背分批初衷）",
        "",
        "## 测试策略（test_strategy、自适应不强制）",
        "",
        "  - `tdd`：逻辑密集批（数据转换 / 工具函数 / 接口逻辑）→ 先写测试看红、再实现到绿",
        "  - `after`：一般业务批 → 实现完补关键路径测试",
        "  - `none`：纯样式 / 文案 / 配置批 → 免测",
        "",
        "## 入参",
        "",
        "  - `action_id`：当前 plan action 的 id",
        "  - `batches`：批次数组、每项 { id, title, test_strategy, task_refs }",
        "",
        "## 返回值",
        "",
        "  - 成功：`{ ok: true }` / 失败：`{ ok: false, error: \"...\" }`（一般是 task 没在跑了）",
      ].join("\n"),
      inputSchema: {
        task_id: z.string().describe("任务 id"),
        action_id: z.string().describe("当前 plan action 的 id"),
        batches: z
          .array(
            z.object({
              id: z.string().describe("批次 id、plan 内唯一、建议 b1 / b2 / b3"),
              title: z
                .string()
                .describe("一句话功能块标题、如「接口层 + 数据转换」"),
              test_strategy: z
                .enum(["tdd", "after", "none"])
                .describe(
                  "测试策略：tdd=先写测试 / after=实现后测试 / none=免测",
                ),
              task_refs: z
                .array(z.string())
                .describe('这批含 plan §5 哪些 task、如 ["Task 1","Task 2"]'),
            }),
          )
          .describe("批次清单、数组顺序 = 建议 build 顺序（有依赖的排前面）"),
      },
    },
    async ({ task_id, action_id, batches }) => {
      console.log(
        `[chat-mcp] set_plan_batches task=${task_id} action=${action_id} batches=${batches.length}`,
      );
      const result = await runTaskAction(task_id, {
        kind: "set_plan_batches",
        actionId: action_id,
        batches: batches.map((b) => ({
          id: b.id,
          title: b.title,
          testStrategy: b.test_strategy,
          taskRefs: b.task_refs,
        })),
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      };
    },
  );

  return srv;
};

// ----------------- 模块级会话表（stateful 模式） -----------------
//
// stateless 模式 SDK 会硬拒「跨请求复用 transport」、
// 但我们 wait_for_user 是长阻塞工具、必须跨请求保留 transport 生命周期。
// 所以走 stateful：客户端 init 拿 sessionId、后续请求带 sessionId 复用 transport。
//
// 这张表存「sessionId → transport」、由 transport 自己的 onsessioninitialized
// / onsessionclosed 回调维护。

const sessionTransports = getGlobalState().sessionTransports;

const buildSessionTransport =
  (): WebStandardStreamableHTTPServerTransport => {
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      // V0.3.5 关键修复：禁 SSE GET 流通道、只用 POST JSON-RPC（短连接 sync request）
      //
      // 背景：MCP StreamableHTTP transport 默认 client 启 transport 后会建一条 GET SSE
      // 长连接接 server push notification。但我们业务上：
      //   - wait_for_user / ask_user 都是立即返回 SHELL_WAIT_GUIDE、不走 SSE stream
      //   - UI 事件流推送走 ai-flow 自己的 /api/tasks/[id]/events 端点、不走 MCP push
      //
      // 空挂着的 GET 在 Next.js dev / 中间层会被 idle 5 分钟超时砍、
      // SDK MCP client 检测到 transport 不健康 → 7-8 分钟后整个 run 标 error。
      //
      // 修复：enableJsonResponse=true、彻底禁 SSE 流、所有响应都用纯 JSON over HTTP POST
      enableJsonResponse: true,
      onsessioninitialized: (id) => {
        sessionTransports.set(id, transport);
      },
      onsessionclosed: (id) => {
        sessionTransports.delete(id);
      },
    });
    const server = buildMcpServer();
    void server.connect(transport).catch((err) => {
      console.error("[chat-mcp] server.connect failed:", err);
    });
    return transport;
  };

// ----------------- 路由层用的 fetch handler -----------------

/**
 * Next.js App Router 的 GET/POST/DELETE 直接调这个、
 * 我们按 mcp-session-id header 路由到对应 transport：
 *   - POST + 没 sessionId + 是 initialize 请求 → 新建 transport + 新 session
 *   - 任何方法 + 有 sessionId 且能查到 → 复用 transport
 *   - 其他情况 → 400
 */
export const handleChatMcpRequest = async (req: Request): Promise<Response> => {
  const sessionId = req.headers.get("mcp-session-id");
  console.log(
    `[chat-mcp] handleChatMcpRequest method=${req.method} sessionId=${sessionId ?? "<none>"} 已有 transport ${sessionTransports.size} 个`,
  );

  if (sessionId) {
    const existing = sessionTransports.get(sessionId);
    if (existing) {
      return existing.handleRequest(req);
    }
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32000, message: `Unknown session: ${sessionId}` },
        id: null,
      }),
      { status: 404, headers: { "Content-Type": "application/json" } },
    );
  }

  // 没 sessionId：必须是 initialize POST、否则拒
  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Bad Request: 没 mcp-session-id 且不是 initialize POST",
        },
        id: null,
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  // 把 body 解出来判断是不是 initialize、再交给 transport（用 parsedBody 避免重复消费）
  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32700, message: "Parse error" },
        id: null,
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  if (!isInitializeRequest(parsed)) {
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message:
            "Bad Request: 没 mcp-session-id、首条请求必须是 initialize",
        },
        id: null,
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const transport = buildSessionTransport();
  return transport.handleRequest(req, { parsedBody: parsed });
};

// ----------------- 给 route 用的内部 API -----------------

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
 * 返回：true=成功 resolve、false=当前没有 pending（race / 任务已退出）
 */
export const submitAskReply = (
  taskId: string,
  replyText: string,
): boolean => {
  const entry = pendingMap.get(taskId);
  if (!entry) {
    console.warn(
      `[chat-mcp] submitAskReply 没找到 pending task=${taskId}`,
    );
    return false;
  }
  finalizeEntry(taskId, entry, {
    kind: "user_reply",
    text: replyText,
  });
  console.log(
    `[chat-mcp] submitAskReply 成功 task=${taskId} reply=${replyText.slice(0, 80)}`,
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
      ? "Task 已合入 main、整个 task 结束、请收尾并结束 run（用户之后可能另起 learn action 沉淀经验、那会是新指令、现在直接收尾）。"
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

// ----------------- task-runner 用的 endpoint URL helper -----------------

/**
 * 推算给 Cursor SDK Agent 用的 chat-tool MCP endpoint URL。
 *
 * 优先级：
 *   1. 显式 env：FE_AI_FLOW_CHAT_MCP_URL
 *   2. 普通 env：FE_AI_FLOW_BASE_URL（拼上 /api/mcp/chat-tool）
 *   3. PORT（Next.js 启动时一般会注入）
 *   4. 兜底 8876（项目固定端口）
 *
 * 注意：必须用 127.0.0.1、agent process 里走的不是浏览器、走的是 node fetch。
 */
export const getChatMcpUrl = (): string => {
  const explicit = process.env.FE_AI_FLOW_CHAT_MCP_URL;
  if (explicit && explicit.trim().length > 0) return explicit.trim();

  const base = process.env.FE_AI_FLOW_BASE_URL;
  if (base && base.trim().length > 0) {
    return `${base.replace(/\/+$/, "")}/api/mcp/chat-tool`;
  }

  const port = process.env.PORT && /^\d+$/.test(process.env.PORT)
    ? process.env.PORT
    : "8876";
  return `http://127.0.0.1:${port}/api/mcp/chat-tool`;
};

/**
 * 给 buildShellWaitGuidance 用：推算 web server 的 base URL、agent 拼成 /wait-ack URL 让 shell curl
 *
 * 优先级跟 getChatMcpUrl 对齐、避免两套配置：
 *   1. FE_AI_FLOW_BASE_URL（拼协议+域名、外网可达）
 *   2. PORT（Next.js dev/prod 都注入）
 *   3. 8876 兜底
 *
 * 注意：必须 agent 本机能访问到的 URL。本机跑 dev 一般 127.0.0.1:8876、
 * agent 跑在 cloud / 容器时要靠 FE_AI_FLOW_BASE_URL 显式注入。
 */
const getServerBaseUrl = (): string => {
  const base = process.env.FE_AI_FLOW_BASE_URL;
  if (base && base.trim().length > 0) {
    return base.replace(/\/+$/, "");
  }
  const port = process.env.PORT && /^\d+$/.test(process.env.PORT)
    ? process.env.PORT
    : "8876";
  return `http://127.0.0.1:${port}`;
};
