/**
 * Chat 模式专用的本地 HTTP MCP server
 *
 * 这个文件做的事情：
 * 1. 用官方 `@modelcontextprotocol/sdk` 起一个 stateless 的 HTTP MCP server
 * 2. 在它上面注册一个 `wait_for_user` 工具
 * 3. 维护进程内的 pendingMap：tool 调用时阻塞、由别处（chat-reply 路由）resolve
 * 4. 暴露一个 fetch-style 的 `handleChatMcpRequest`、给 Next.js App Router 直接调
 *
 * ## 为什么要这个东西
 *
 * Cursor SDK 的计费模型是「一个 Run 一次费用」（老 monthly 账号下、一次 send 算一次）。
 * 如果用户每发一句话都重启 agent / 调一次 send、那十轮对话十次扣费、又慢又费。
 *
 * 解决思路是 Cursor 自己 IDE 里同款：让 agent 在 run 内部循环「说一段 → 调
 * wait_for_user 工具阻塞 → 等用户消息 → 继续说」。整个对话从 SDK 视角看就是
 * 一次 Run、一次扣费。
 *
 * ## 为什么是 HTTP MCP 不是 stdio MCP
 *
 * Cursor SDK 的 local agent 是另开 process 跑的、它跟我们 web server 不在一个
 * 进程里。stdio MCP 要 spawn 子进程、共享内存的 pendingMap 拿不到；HTTP MCP
 * 跨进程跑得通、靠 localhost 连回来就行。
 *
 * ## 为什么 stateless mode
 *
 * 我们就一个 web server 进程、所有 chat 任务都进同一个 transport / pendingMap、
 * 不需要 MCP session 维持跨连接状态。每次工具调用按 task_id 索引 pendingMap、
 * 就够区分多个并发 chat 任务了。
 *
 * ## V0.3.5 保活机制：shell + curl long-poll 取代 MCP 轮转
 *
 * 旧版用 MCP wait_for_user 50s timer + keep_alive_a/b/c 轮转保活、5-6 分钟后
 * 必被 Cursor backend anti-loop 判定为循环、agent emit 文本块退 run。
 *
 * 新版：wait_for_user / ask_user 工具**立即返回 shell 引导**、教 agent 调
 * `shell` 工具 `curl -sN '<url>/api/tasks/:id/wait-ack?token=…'` 跟服务端建一条
 * 长 HTTP 连接。/wait-ack 路由 subscribeWaitAck 拿 pendingMap 里的 promise、
 * 服务端 chunked write 每 60 秒一次 `[KEEPALIVE ts=...]` 普通文本行、
 * 用户 ack/reply 时 resolve 这个 promise → 写一行结果 + 关连接 → curl 拿到 stdout →
 * agent 推进下一步。整段 SDK Run 没退出、单次 send 配额一直够用。
 *
 * 实证（scripts/test-shell-sleep.mjs）：SDK 的 shell 工具**不受 MCP 60s 硬超时**、
 * `sleep 300` (5 分钟) 都能跑完、且不踩 anti-loop（一次 wait = 一次 shell、
 * 不重复同工具名、agent 不轮询）。
 *
 * ## 不做的
 *
 * - 不做 MCP session id：stateless 就好、我们靠 task_id 自己管状态
 * - 不做并发去重：同一个 task 同时只允许一个 pending entry、新 wait_for_user 顶旧的
 * - 不做 dev hot reload 状态恢复：开发时模块重载会丢 pendingMap、能接受
 * - **不做断线自动重试**：连接断了 agent 自然退 run、用户在 UI 上点「继续监听」
 *   走 /resume-waiting：Agent.resume + send 引导 agent 重新调 wait_for_user
 *   （避免 agent 反复重试踩 anti-loop、且老套餐 resume 也要 +1 send 配额）
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";

// ----------------- 配置 -----------------

// wait-ack 长连接 keepalive 间隔：服务端在长连接里每隔这么久 write 一段
// `[KEEPALIVE ts=<ms>]\n` 普通文本行。双重作用：
//   1. 维持中间链路（nginx / ELB / 浏览器 proxy）connection、不被 idle 砍
//   2. 让 agent 通过 shell-output-delta 持续看到 stdout 有新行、防 Cursor 模型层
//      训练 bias 在「shell 静默几分钟」时主动 summarize 退出
//
// V0.3.5 实测（2026-05-14）：旧版用 `: keepalive` SSE 注释 + 4 分钟间隔、curl
// 静默吃下 stdout 没新行、agent 5 分钟内就触发上述 bias 退 run。换成 60 秒一次
// 普通文本行后稳。上下文成本可控：30 分钟 30 行、每行 ~25 字节、~750 字节。
const WAIT_ACK_KEEPALIVE_MS = 60 * 1000;

// ToolReturn：wait-ack 路由把它序列化成单行文本写给 curl、agent 在 shell 输出里读到
// V0.2 复用同一个 wait_for_user 工具支持两类调用语义（A 方案）：
//   - chat 模式：不传 phase 参数、resolve 时走 user_reply（文本 + 附件）
//   - workflow 模式：传 phase / artifact 参数、resolve 时走 phase_approve / phase_revise
export type ToolReturn = {
  // user_reply：chat 模式、真正的用户消息文本（agent 该接着处理）
  // phase_approve：workflow 模式、用户点了「通过」、agent 该进下一 phase
  // phase_revise：workflow 模式、用户点了「补意见再跑」、agent 该按 feedback 改产物再调一次
  // stale：被新一轮 wait_for_user 顶掉、agent 直接放弃这次返回即可
  // cancelled：任务被取消、agent 该结束 run
  kind:
    | "user_reply"
    | "phase_approve"
    | "phase_revise"
    | "stale"
    | "cancelled";
  text: string;
  // user_reply 携带的图片附件绝对路径列表（仅 kind === "user_reply" 用、其他为 undefined）
  // wait-ack 路由会把这些路径拼到 text 里、agent 用 SDK 内置 `read` 工具读看图
  imagePaths?: string[];
  // user_reply 携带的文件 / 目录附件绝对路径列表（仅 kind === "user_reply" 用）
  // wait-ack 路由会把这些路径拼到 text 里、agent 用 read / grep / glob 自己读
  attachmentPaths?: string[];
  // phase_revise 携带的修改意见文本（agent 根据这个改 artifact）
  feedback?: string;
};

// PendingEntry：一段「等用户 ack」的状态、由 wait_for_user / ask_user MCP 工具注册
// 由 wait-ack 路由订阅 result promise、由 submitXxx / cancelPending 解算 promise
interface PendingEntry {
  // 短 token、生成时同步写 tokenToTask 路由表
  token: string;
  // 进入等待的时间戳（毫秒）
  startedAt: number;
  // wait_for_user 时传入的 phase（workflow 任务）/ 空（chat 任务）
  phase?: string;
  // wait_for_user 时传入的 artifact 相对路径（仅 workflow 任务）
  artifact?: string;
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
// /api/tasks/[id]/chat-reply）会被打成不同 webpack chunk、`import` 同一个
// 模块拿到的实际是 **不同的 module 实例**、module-level 的 Map / Set 各跑各的
// 完全分裂。chat-runner 注的 logger、wait_for_user 这边查不到、就是踩这个坑。
//
// 解法：把所有进程级状态挂到 globalThis 上、所有 chunk 共享同一份。
// 生产 build（standalone）也挂、反正 server 进程只有一个、不会冲突。

// chat-mcp 通知 chat-runner「wait_for_user 进入等待」、用于切 task.status = awaiting_user
//
// 历史背景：以前这个 logger 是写 events.jsonl 的（kind=feedback_request / feedback_keepalive）
// 但用户在 2026-05-11 拍板：因为 wait_for_user 总是用户必须 reply 才推进、UI 上一个 loading 占位就够、
// agent 之前的 assistant_message 已经传达了"我说完了"、不再需要冗余的 feedback_request 事件卡片
// 所以这个回调退化成纯「事件信号」、不带文本、不再写 events.jsonl
//
// 仍保留 callback 抽象（不让 chat-mcp 直接 import patchPhase）：
// - 维持模块依赖方向 chat-runner / workflow-runner → chat-mcp（反过来会形成循环）
// - 让 runner 全权决定收到信号要做什么（patch status / publish / 写日志）
//
// V0.2 扩展：signal 加 phase / artifact、workflow-runner 据此 mark task 当前在等哪个 phase
//
// V0.3 ask_user 扩展：新增 ask_user_request kind、runner 负责写 events.jsonl 卡片 + 切 task.status
//   - 沿用 notifier 而不是让 chat-mcp 直接 import publishChatStreamEvent、避免循环依赖
//   - 同一 notifier 接口承担「事件查询保活」+「问答卡片渲染」两类信号、用 kind 区分
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
      phase?: string;
      artifact?: string;
    }
  | {
      // agent 调 ask_user MCP 工具时 chat-mcp 通过 notifier 给 runner 派发的信号
      // runner 收到后：写一条 ask_user_request 事件 + publish SSE + 切 task.status=awaiting_user
      kind: "ask_user_request";
      askId: string;
      token: string;
      questions: AskUserQuestion[];
      phase?: string;
    };

type AwaitingNotifier = (signal: AwaitingSignal) => Promise<void> | void;

interface ChatMcpGlobalState {
  pendingMap: Map<string, PendingEntry>;
  waitingTasks: Set<string>;
  awaitingNotifiers: Map<string, AwaitingNotifier>;
  sessionTransports: Map<string, WebStandardStreamableHTTPServerTransport>;
  // V0.3.5 仍保留：token → taskId 映射、wait-ack 路由验 token 合法性用
  // 生命周期：wait_for_user/ask_user MCP 工具调用时写、submitXxx/cancelPending 清
  tokenToTask: Map<string, string>;
}

// V6：2026-05-15 删 pendingFirstMessage（chat 自由化首条改进 prompt 注入、不走队列、详见 chat-runner buildInitialPrompt）
// V5：2026-05-15 加 pendingFirstMessage（已撤销）
// V4：2026-05-14 删 keepaliveCounters（旧 keep_alive_a/b/c 序号轮转、shell long-poll 后不需要）
// dev hot reload 不会清 globalThis、旧版字段名残留会让新代码拿到 undefined → TypeError
// → bump 版本后缀强制让 dev 重启时拿到全新 state（旧版 state 留在内存等 GC）
const GLOBAL_KEY = "__feAiFlowChatStateV6__";

const getGlobalState = (): ChatMcpGlobalState => {
  const g = globalThis as unknown as Record<string, ChatMcpGlobalState>;
  if (!g[GLOBAL_KEY]) {
    console.log("[chat-mcp] 初始化 globalThis 状态（首次）");
    g[GLOBAL_KEY] = {
      pendingMap: new Map(),
      waitingTasks: new Set(),
      awaitingNotifiers: new Map(),
      sessionTransports: new Map(),
      tokenToTask: new Map(),
    };
  }
  return g[GLOBAL_KEY];
};

// 进程级 pending 表：任务 id → pending entry
// 同一个 task 同时只允许一个 entry（新来的顶旧的）
const pendingMap = getGlobalState().pendingMap;

// 「这个 task 当前是否处在等待用户的状态」
// wait_for_user / ask_user MCP 工具进来时标 true、submitXxx / cancelPending 清
// 用途：UI 拉状态、runner 切 task.status = awaiting_user 时去重
const waitingTasks = getGlobalState().waitingTasks;

// token → taskId 路由表、wait-ack 路由验 token 合法性用
// 生命周期：registerPendingEntry 写、finalizeEntry 清
const tokenToTask = getGlobalState().tokenToTask;

// 生成短 token：8 字符 base36、足够防撞、又不浪费 context
// 不用 uuid 是因为更短、且模型只需要识别 / 透传、不需要 cryptographic strength
const newWaitToken = (): string =>
  Math.random().toString(36).slice(2, 10);

// 把 ToolReturn 序列化成 wait-ack 路由写出 curl 的文本（多行）
// 第一行是 `[KIND ...]` 标记（必）、后续是 body。agent 在 shell 输出里 grep 标记拿语义、按需读 body
//
// 历史：旧版返 MCP `{content: [{type:text, text}]}`、shell long-poll 后直接写文本到 stdout
export const formatToolReturnAsText = (result: ToolReturn): string => {
  if (result.kind === "phase_approve") {
    const lines = ["[PHASE_ACK approve]"];
    if (result.text && result.text.trim()) lines.push("", result.text);
    return lines.join("\n");
  }
  if (result.kind === "phase_revise") {
    const lines = ["[PHASE_ACK revise]"];
    const fb = (result.feedback ?? result.text ?? "").trim();
    if (fb) lines.push("", fb);
    return lines.join("\n");
  }
  if (result.kind === "user_reply") {
    const lines: string[] = ["[USER_REPLY]", "", result.text];
    if (result.imagePaths && result.imagePaths.length > 0) {
      lines.push(
        "",
        "[ATTACHED_IMAGES] 用户附了以下图片、请用 `read` 工具逐一读取（SDK 内置 `read` 会把图片转成 vision、你能直接看到图像内容）：",
        ...result.imagePaths.map((p, i) => `  ${i + 1}. ${p}`),
      );
    }
    if (result.attachmentPaths && result.attachmentPaths.length > 0) {
      lines.push(
        "",
        "[ATTACHED_PATHS] 用户附了以下文件 / 目录路径、按需用 `read` / `grep` / `glob` 读取（路径已是绝对路径、直接用）：",
        ...result.attachmentPaths.map((p, i) => `  ${i + 1}. ${p}`),
      );
    }
    return lines.join("\n");
  }
  if (result.kind === "cancelled") {
    return ["[CANCELLED]", "", result.text].join("\n");
  }
  // stale
  return ["[STALE]", "", result.text].join("\n");
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
// pendingMap 里残留的 resolved entry 不影响主流程：
//   - 新 wait_for_user 来时、registerPendingEntry 会立即清旧 entry（不等 grace）
//   - cancelPending / 其他清理路径也会走 forceCleanupEntry 立即清
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
  opts: { phase?: string; artifact?: string },
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
    phase: opts.phase,
    artifact: opts.artifact,
    result,
    resolveResult,
    resolved: false,
  };
  pendingMap.set(taskId, entry);
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
// chat-runner 启动 task 时注册一个 notifier、wait_for_user 进入"全新一段等待"时
// chat-mcp 调它一次、chat-runner 据此把 task.status 切到 awaiting_user 并 publish 给 SSE 订阅者。
//
// 按 task id 维度注册：同一时刻可以有多个 chat task 在跑、
// 各自 wait_for_user 调用按 task_id 路由到自己的 notifier、互不干扰。

const awaitingNotifiers = getGlobalState().awaitingNotifiers;

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

const safeNotifyAwaiting = async (
  taskId: string,
  opts: { phase?: string; artifact?: string } = {},
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
      phase: opts.phase,
      artifact: opts.artifact,
    });
    console.log(
      `[chat-mcp] safeNotifyAwaiting 成功 task=${taskId} phase=${opts.phase ?? "<none>"}`,
    );
  } catch (err) {
    console.error("[chat-mcp] awaiting notifier failed:", err);
  }
};

// V0.3 ask_user：派发问答信号给 runner、runner 写 events.jsonl + 切 status
// notifier 没注册时通知失败（理论不会发生、agent 调 ask_user 时 task 一定在 run）、
// 跟 awaiting_start 同款防御逻辑、不抛错只 warn
const safeNotifyAskUserRequest = async (
  taskId: string,
  args: {
    askId: string;
    token: string;
    questions: AskUserQuestion[];
    phase?: string;
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
      phase: args.phase,
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
// 这段文本是新方案的核心、决定 agent 行为质量。要素：
//   1. **明确告知 shell + curl 是唯一正确动作**、不允许 emit assistant_message
//   2. **解释 curl 输出的几种可能行**（[KEEPALIVE] / [PHASE_ACK] / [USER_REPLY] / [CANCELLED] / [STALE] / [INVALID_TOKEN]）
//   3. **断线不要重试**、自然 emit 一条简短文本结束 run、UI 会引导用户手动续接
//   4. **对用户透明**：不要在 assistant_message 里讲协议细节
const buildShellWaitGuidance = (
  taskId: string,
  token: string,
  opts: { phase?: string; artifact?: string; mode: "wait_for_user" | "ask_user" },
): string => {
  const baseUrl = getServerBaseUrl();
  const url = `${baseUrl}/api/tasks/${encodeURIComponent(taskId)}/wait-ack?token=${encodeURIComponent(token)}`;
  const contextLine =
    opts.mode === "ask_user"
      ? "等用户在 UI 弹窗里答完 ask_user 问题、curl 拿到 `[USER_REPLY]` 行带 markdown Q&A、解析每条答案接着工作。"
      : opts.phase
        ? `等用户对 phase=${opts.phase}（artifact=${opts.artifact ?? "<未指定>"}）点 approve / revise、curl 拿到 \`[PHASE_ACK approve]\` 或 \`[PHASE_ACK revise] <feedback>\` 接着推进。`
        : "等用户在 UI 输入下一条消息、curl 拿到 `[USER_REPLY]` 行（可能带 [ATTACHED_IMAGES] / [ATTACHED_PATHS] 段）。";
  return [
    `[SHELL_WAIT_GUIDE token=${token}]`,
    "",
    "## 下一步只许做一件事：调 `shell` 工具跑这条 curl",
    "",
    "```",
    `curl -sN --max-time 1800 "${url}"`,
    "```",
    "",
    "参数说明：",
    "  - `-s`：静默、不出进度条",
    "  - `-N`：不缓冲、服务端 chunked write 一来就立刻出 stdout",
    "  - `--max-time 1800`：单次最长 30 分钟（实际服务端每 60 秒发一次 `[KEEPALIVE ts=...]` 心跳行维持连接、用户操作时立刻给结果并断开）",
    "",
    "## stdout 解读规则（**必背、决定你下一步动作**）",
    "",
    "shell stdout 会按时序持续输出几种行：",
    "",
    "  - `[KEEPALIVE ts=<时间戳>]`：**60 秒一次的服务端心跳、忽略它**。它的唯一意义是告诉你「连接还活着、用户还没操作」。看到再多 KEEPALIVE 都是正常的、**绝对不要**因此 summarize 退出 / 调 read 检查 terminal / 重新调 wait_for_user / 调其他工具自救。",
    "  - `[PHASE_ACK approve]`：用户在 UI 点了「通过」、shell 命令立刻 exit 0、按 prompt 推进下一 phase",
    "  - `[PHASE_ACK revise] <feedback 文本>`：用户「补意见再跑」、按 feedback 改 artifact 后再调 wait_for_user",
    "  - `[USER_REPLY] <markdown Q&A 文本>`：chat 模式用户回复 / ask_user 答完、按内容推进",
    "  - `[CANCELLED]`：任务被取消、收尾结束 run",
    "  - `[STALE]` / `[INVALID_TOKEN]`：本 token 已失效、不要重试、自然结束 run",
    "",
    "## 钢铁纪律（5 分钟 / 10 分钟 / 20 分钟没新行 ≠ shell 卡住）",
    "",
    "shell + curl 可能要等用户 0 秒到 30 分钟、任何长度都正常。**等待期间你只看到 KEEPALIVE 行不断追加**、这是设计预期、不是 bug。",
    "",
    "**绝对禁止的动作**（看到 KEEPALIVE 累积时尤其要克制）：",
    "  - ❌ 调 read 读 cursor 内部 terminal 文件、查 shell 进程状态",
    "  - ❌ thinking 里冒「process is still running, I will summarize」/「the 5-minute block has ended」→ summarize 退 run",
    "  - ❌ 调任何其他工具自救、重新启 shell、重新 wait_for_user",
    "  - ❌ emit assistant_message 跟用户讲「我在等」「shell 在跑」之类",
    "",
    "**唯一合法动作**：什么也不做、继续等 shell 的下一段 stdout（要么 KEEPALIVE 要么 PHASE_ACK / USER_REPLY 等终态行）。",
    "",
    `## 这次 wait 的目的`,
    contextLine,
    "",
    "## 异常处理（重要！）",
    "",
    "如果 curl exit code 非 0（连接断 / 网络错 / 服务重启 / `--max-time` 到点）：",
    "",
    "  - **不要重新调 shell 重试** —— anti-loop 风险、且重试不能恢复连接",
    "  - **不要重新调 wait_for_user / ask_user** —— 会被服务端顶替成 stale",
    "  - **直接 emit 一条简短 assistant_message** 说「监听连接异常断开、请在 fe-ai-flow 看板点『继续监听』」，然后自然结束 run",
    "  - UI 已经监测到连接断、用户会手动点「继续监听」、后端会用 `Agent.resume()` 把你叫醒、你重新调 wait_for_user 即可",
    "",
    "## 调用礼仪",
    "",
    "  - 调 shell 前 / 中 / 后**不要** assistant_message 解释「我在等用户」「我在轮询」「协议细节」之类",
    "  - shell 拿到结果后**直接按结果行动**、不要复述「你刚才点了 approve」",
    "  - 对用户透明：他在 UI 上看 artifact + 点 ack、不需要看你描述协议",
  ].join("\n");
};

// ----------------- McpServer 构造 -----------------

const buildMcpServer = (): McpServer => {
  const srv = new McpServer({
    name: "fe-ai-flow-chat",
    version: "1.0.0",
  });

  srv.registerTool(
    "wait_for_user",
    {
      title: "发起一次等用户 ack 请求（立即返回 shell 引导）",
      description: [
        "fe-ai-flow 用这个工具发起一次「等用户」请求、本工具**立即返回一段 [SHELL_WAIT_GUIDE] 引导文本**、",
        "教你调 `shell` 工具用 curl 跟服务端 /api/tasks/:id/wait-ack 路由建长连接等结果。",
        "",
        "## 硬性规则（不遵守、fe-ai-flow runner 会把任务标 failed）",
        "",
        "- **workflow 模式：每个 phase 写完 artifact 后必须调一次本工具**、shell 拿到 `[PHASE_ACK approve]` 才能进下一 phase",
        "- **不调本工具 = phase 没完成**、fe-ai-flow 在 run 结束时硬检测、有 phase 状态不是 ack 一律标 failed",
        "- **不要写完 artifact 后只发 assistant_message 说「请你 approve」就退出 run**——这是实测最常见的错误模式",
        "- **本工具每个 phase 只调 1 次**——之后用 `shell` + curl 监听、不要重复调本工具",
        "",
        "## 两种用法（按任务类型选）",
        "",
        "### A. Chat 任务（不传 phase）",
        "  - 用法：`wait_for_user({ task_id })`",
        "  - 返回：`[SHELL_WAIT_GUIDE]`、按引导调 shell + curl 拿用户下一条消息",
        "",
        "### B. Workflow 任务（传 phase + artifact）",
        "  - 用法：`wait_for_user({ task_id, phase, artifact })`",
        "  - phase：刚完成的 phase id（plan / build）",
        "  - artifact：刚产出的 artifact 文件相对路径（如 'artifacts/01-plan.md'）",
        "  - 返回：`[SHELL_WAIT_GUIDE]`、按引导调 shell + curl 等用户 approve / revise",
        "",
        "## 调用礼仪",
        "  - 调用前 / 中 / 后都不要在 assistant_message 里讲本工具的存在、对用户透明",
        "  - workflow 模式：每完成一个 phase 调一次（不要每写一句就调、也不要写完了不调）",
        "  - chat 模式：每说完一段话调一次、之后监听走 shell + curl",
      ].join("\n"),
      inputSchema: {
        task_id: z.string().describe("任务 id（agent 启动时被告知）"),
        phase: z
          .string()
          .optional()
          .describe(
            "workflow 任务必传：刚完成的 phase id（如 'plan' / 'build'）。chat 任务留空。",
          ),
        artifact: z
          .string()
          .optional()
          .describe(
            "workflow 任务可选：刚产出的 artifact 文件相对 task 根的路径（如 'artifacts/01-plan.md'）。用于 UI 展示和审计。",
          ),
      },
    },
    async ({ task_id, phase, artifact }) => {
      console.log(
        `[chat-mcp] wait_for_user 入参 task_id=${task_id} phase=${phase ?? "<none>"} artifact=${artifact ?? "<none>"}`,
      );

      // V0.3.5：注册 pending entry（建 promise、写 pendingMap、生成 token）、立即返回 shell 引导
      // 旧 entry 由 registerPendingEntry 自动 stale 顶替（极少见、agent 通常一次 wait 走完）
      const entry = registerPendingEntry(task_id, { phase, artifact });

      // 仅当「之前不在等待」时才通知 runner 切 task.status = awaiting_user
      // （registerPendingEntry 顶替旧 entry 时 finalizeEntry 会清 waitingTasks、所以这里能再 add）
      if (!waitingTasks.has(task_id)) {
        waitingTasks.add(task_id);
        await safeNotifyAwaiting(task_id, { phase, artifact });
      }

      return {
        content: [
          {
            type: "text" as const,
            text: buildShellWaitGuidance(task_id, entry.token, {
              phase,
              artifact,
              mode: "wait_for_user",
            }),
          },
        ],
      };
    },
  );

  // ----------------- ask_user 工具（V0.3.2 一次打包多问题、modal 形态）-----------------
  //
  // 设计动机（用户拍板）：
  //   - 一次 phase 内只调一次 ask_user、把不确定项**全部打包**成 questions[] 数组
  //     一个一个调会让用户体验破碎（弹窗不断弹、答得累、对话节奏拖长）
  //   - UI 用 modal dialog 弹窗一次性展示所有问题、ABCD 字母前缀（对标 Cursor）
  //   - 答完所有问题再提交、batch 落到 contextDocs
  //
  // 返回值：拼接成 markdown 的 Q&A 文本、agent 直接读、不需要解析 JSON
  //   格式示例：
  //     [ASK_USER_REPLY]
  //     Q1: <问题1>
  //     A: <用户答1>
  //
  //     Q2: <问题2>
  //     A: <用户答2>
  //
  // V0.3.5 保活语义同 wait_for_user：立即返回 [SHELL_WAIT_GUIDE token=xxx]、
// agent 调 shell 工具跑 curl 长连接 /api/tasks/:id/wait-ack、stdout 一行解析结果。
// 复用 pendingMap：同一时刻一个 task 只能有一个 pending
  srv.registerTool(
    "ask_user",
    {
      title: "phase 内打包提问（一次问完所有不确定项）",
      description: [
        "phase 内 agent 遇到不确定项时、**一次性把所有问题打包**调用 ask_user、阻塞等用户在 UI 弹窗里答完所有问题。",
        "对标 Cursor `askFollowUpQuestion`：UI 出选项按钮 + 可选自由文本输入。",
        "",
        "## 关键约束（用户拍板）",
        "",
        "- **一次 phase 内最多调用 1 次 ask_user**——把所有问题打包进 questions[]、不要一个一个调",
        "- 同时调多次会让用户体验破碎（弹窗不断弹、要分多次答）",
        "- **只在确实有不确定项时调用**——没问题就跳过、直接 wait_for_user",
        "- **options 里不要手动塞「Other / 其他 / 其它 / 以上都不是 / 自定义」类的兜底选项**——`allow_text=true` 时 UI 会自动渲染「以上都不是 / 自定义回答…」按钮、你再加会重复",
        "",
        "## 何时调用",
        "",
        "- artifact 初稿写完、扫一遍发现有不确定 / 多选 / 歧义点：上下文冲突、口径不清、接口字段不明、技术路线 A/B",
        "- 把所有这些点收集成 questions[]、**一次性调** ask_user",
        "- 用户在弹窗里**所有问题答完才能继续**、答完 agent 拿到 Q&A 文本回到工作",
        "",
        "## 入参",
        "",
        "- `task_id`：任务 id（启动时被告知）",
        "- `phase`：当前所处 phase（plan / build）",
        "- `questions`：问题数组、每条结构：",
        "    - `id`：问题唯一标识、不要重复（如 `q1` / `q2` / `conflict_role`）",
        "    - `question`：问题正文、清晰可读、必要时带背景（≤ 200 字）",
        "    - `options`：可选项数组 `[{id, label}, ...]`、2-4 个具体**业务选项**、最多 6 个、**UI 自动加 A/B/C/D 字母前缀**",
        "      - **严禁** 在 options[] 里塞「其他 / Other / 自定义 / 自由文本说明 …」这类兜底项——UI 已经在选项列表底下统一渲染「以上都不是 / 自定义回答…」按钮、点了切到自由文本输入框、你只要列具体业务选项就行（重复塞了 UI 也不会触发文本框、只会变成「点了不能填」的死按钮）",
        "    - `allow_text`：保留默认 true。它只是控制 UI 是否渲染那个「以上都不是 / 自定义回答…」按钮、不要把它理解成「我要在 options 里加一个 Other 选项」",
        "",
        "## 返回值（V0.3.5 起：shell + curl long-poll）",
        "",
        "- 立即返回 `[SHELL_WAIT_GUIDE token=xxx]`、文本里附完整 curl 命令——调一次 `shell` 工具跑这条命令、长连接挂在 /api/tasks/:id/wait-ack",
        "- 用户在弹窗答完后、shell stdout 收到 `[ASK_USER_REPLY] ...` 开头的 markdown Q&A 文本、agent 解析答案接着工作",
        "- 其他可能 stdout 行：`[CANCELLED]`（用户取消任务）/ `[STALE]`（旧 token 被新 wait_for_user 顶替）/ `[INVALID_TOKEN]`",
        "- **不**要再调 keep_alive_a/b/c（V0.3.5 已删）、调一次 ask_user 即结束本工具调用、剩下全交给 shell long-poll",
        "",
        "## 调用礼仪",
        "",
        "- 调用前 / 后不要 assistant_message 解释「我先问几个问题」之类、UI modal 会自动弹出来",
        "- 答完后不要复述「你刚才选了 X」、直接按答案推进、写到 artifact 的「上下文冲突已通过 ask_user 澄清」段",
        "- 答案**只**写到 artifact（01-plan.md）、**不再**自动落 contextDocs——单一数据源、避免重复",
      ].join("\n"),
      inputSchema: {
        task_id: z.string().describe("任务 id"),
        phase: z
          .string()
          .optional()
          .describe("当前 phase id（plan / build）"),
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
          .describe("问题数组、一次打包所有不确定项、至少 1 条"),
      },
    },
    async ({ task_id, phase, questions }) => {
      const askId = `ask_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      // 归一化：清掉空白、补齐 allow_text 默认值
      // questions 已被 zod 校验过、min(1)、字段类型都对
      const normalized: AskUserQuestion[] = questions.map((q) => ({
        id: q.id,
        question: q.question.trim(),
        options: q.options,
        allowText: q.allow_text !== false,
      }));

      // V0.3.5：注册 pending entry（生成 token、建 promise）、立即返回 shell 引导
      const entry = registerPendingEntry(task_id, { phase });
      console.log(
        `[chat-mcp] ask_user 入参 task=${task_id} phase=${phase ?? "<none>"} askId=${askId} token=${entry.token} questions=${normalized.length}`,
      );

      // 通知 runner 写 ask_user_request 事件 + 切 status = awaiting_user
      await safeNotifyAskUserRequest(task_id, {
        askId,
        token: entry.token,
        questions: normalized,
        phase,
      });
      waitingTasks.add(task_id);

      return {
        content: [
          {
            type: "text" as const,
            text: buildShellWaitGuidance(task_id, entry.token, {
              phase,
              mode: "ask_user",
            }),
          },
        ],
      };
    },
  );

  return srv;
};

// ----------------- 旧 keep_alive_a/b/c 工具已删除（V0.3.5）-----------------
//
// 历史：V0.3-A 抗 Cursor anti-loop heuristic 用过 3 个轮转 tool 名 keep_alive_a/b/c、
// agent 调 wait_for_user 后被教按 [USER_AWAITING seq=X next=...] 轮转调对应 tool 续接。
// 实测踩坑（用户 2026-05-13）：跑 5-6 分钟必被 backend 判定 looping、agent emit 文本退 run。
//
// V0.3.5 新方案：shell + curl long-poll 完全取代轮转、参见文件顶部 doc 说明。
// 这段保留仅作历史说明、新代码不要再注册 keep_alive_* tool。

// ----------------- 模块级会话表（stateful 模式） -----------------

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
      //   - UI 事件流推送走 fe-ai-flow 自己的 /api/tasks/[id]/events 端点、不走 MCP push
      //   - 也就是 MCP GET SSE 通道空挂着、没数据要走
      //
      // 但空挂着的 GET 在 Next.js dev / 中间层（nginx / cloudflare）会被 idle 5 分钟超时砍、
      // SDK MCP client 检测到 transport 不健康 → 7-8 分钟后整个 run 标 error。
      // 实测（2026-05-14、用户 t_1778741802724_3nlhji 任务）：
      //   - POST wait_for_user 0.36s 返回 SHELL_WAIT_GUIDE
      //   - GET SSE 长连接 5 分 3 秒被断
      //   - 12 分 25 秒 run status=error、Cursor SDK dump 没具体 error message
      //
      // 修复：enableJsonResponse=true、彻底禁 SSE 流、所有响应都用纯 JSON over HTTP POST、
      // 没有长连接概念、没 5 分钟超时问题。
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

// ----------------- 给 chat-reply 路由用的内部 API -----------------

/**
 * 用户在 UI 输入了下一条消息、API 路由调这个、把消息塞给被阻塞的 agent。
 *
 * @param imagePaths      用户消息附带的图片绝对路径（已落盘）、可空。
 *   非空时 wait_for_user return 会拼 [ATTACHED_IMAGES] 段、agent 用 `read` 工具读它能看图
 * @param attachmentPaths 用户消息附带的文件 / 目录绝对路径（FsPickerDialog 选的）、可空。
 *   非空时 wait_for_user return 会拼 [ATTACHED_PATHS] 段、agent 按需 read / grep / glob
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
 *   Q2: 问题2
 *   A: 答案2
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
 * V0.2 workflow 模式：用户在 UI 点了「通过」或「补意见再跑」、API 路由调这个 ack 阻塞中的 agent。
 *
 * @param action   "approve" → agent 拿到 [PHASE_ACK approve] 进下一 phase
 *                 "revise"  → agent 拿到 [PHASE_ACK revise] + feedback、改 artifact 再调一次
 * @param feedback "revise" 时的用户意见文本、"approve" 时可空（也能传补充说明）
 *
 * 返回值同 submitUserMessage：
 *   - true：成功 resolve
 *   - false：当前没有 agent 在等待 ack
 */
export const submitPhaseAck = (
  taskId: string,
  action: "approve" | "revise",
  feedback?: string,
): boolean => {
  const entry = pendingMap.get(taskId);
  if (!entry) {
    console.warn(
      `[chat-mcp] submitPhaseAck 没找到 pending task=${taskId} action=${action}`,
    );
    return false;
  }
  finalizeEntry(taskId, entry, {
    kind: action === "approve" ? "phase_approve" : "phase_revise",
    text: feedback ?? "",
    feedback: feedback,
  });
  console.log(
    `[chat-mcp] submitPhaseAck 成功 task=${taskId} action=${action} feedback=${(feedback ?? "").slice(0, 60)}`,
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
  // 2) 清 notifier（waitingTasks 已在 cancelPending 里清）
  awaitingNotifiers.delete(taskId);
};

/**
 * UI 拉状态时用：当前是否有 agent 在等用户输入。
 */
export const hasPending = (taskId: string): boolean => pendingMap.has(taskId);

// ----------------- chat-runner 用的 endpoint URL helper -----------------

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
export const getServerBaseUrl = (): string => {
  const base = process.env.FE_AI_FLOW_BASE_URL;
  if (base && base.trim().length > 0) {
    return base.replace(/\/+$/, "");
  }
  const port = process.env.PORT && /^\d+$/.test(process.env.PORT)
    ? process.env.PORT
    : "8876";
  return `http://127.0.0.1:${port}`;
};
