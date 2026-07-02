/**
 * Task action 模式专用的本地 HTTP MCP server
 *
 * 这个文件做的事情（V0.9.x 拆分后、等待状态机本体在 chat-pending.ts）：
 * 1. 用官方 `@modelcontextprotocol/sdk` 起一个 stateful 的 HTTP MCP server
 * 2. 在它上面注册 `wait_for_user` / `ask_user` / `submit_mr` / `set_feishu_testers` / `set_plan_batches` 工具
 * 3. 工具 handler 调 chat-pending 的 registerPendingEntry / runTaskAction 等（pendingMap 状态在那边）
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

import type { TaskEvent } from "../types";
import { shellWaitGuideHead } from "../protocol-signals";
import {
  chatShellWaitGuideBody,
  shellCurlRunSection,
  waitDisciplineSection,
} from "./wait-protocol-prompt";
import { readRecentEvents } from "./task-fs-core";
import {
  PREMATURE_CHAT_WAIT_EVENT_LIMIT,
  classifyPrematureChatWait,
} from "./premature-chat-wait";
import {
  chatModeTasks,
  prematureWaitRejects,
  registerPendingEntry,
  runTaskAction,
  safeNotifyAskUserRequest,
  safeNotifyAwaiting,
  sessionTransports,
  unansweredRevises,
  waitingTasks,
  type AskUserQuestion,
} from "./chat-pending";

// ----------------- chat premature wait 兜底（跟 wait_for_user handler 强耦合、留本文件） -----------------

// 连续拒绝上限：超过就放行（宁可让对话继续、也不让模型死循环烧 token）。
// 2 = 给模型「拒一次→补正文」的机会、第二次还不补就别拦了（极少数模型真不配合）。
const PREMATURE_WAIT_REJECT_CAP = 2;

// 兜底 A 拒绝时返回给 agent 的纠正文本（不给 curl / 不注册 pending entry——
// 没有可挂等的 token、模型唯一出路就是把正文直接输出、再调 wait_for_user）。
// M/C'：只在「message 空 + 用户在等回答 + 也没 stream 出正文」时才触发。
const PREMATURE_WAIT_REJECT_TEXT = [
  "[ANSWER_FIRST] 你还没把回答交付给用户就想挂等——本次 wait_for_user 不予受理。",
  "（用户看得到你直接输出的正文、但你这轮一个字的正文都没输出、用户那边一片空白。）",
  "把本轮的答案 / 可用分段**直接输出**给用户（成品本身、不是「我这就写」的计划）、再调 `wait_for_user`（message 填一句话概括）。",
].join("\n");

/**
 * 兜底 A 检测的 IO 包装：读最近事件喂给纯判定 classifyPrematureChatWait（见同名独立模块）。
 * limit=0 读全量事件：chat 每轮 wait_for_user 才跑一次、events.jsonl 通常也就几百到几千行，
 * 不值得为这点 IO 冒「长首轮把 runStart / firstMessage 挤出窗口」导致 fail-open 的风险。
 * 读不到 / 解析异常一律 fail-open（返 false 不拦）——兜底逻辑不能反过来卡死正常对话。
 */
const isPrematureChatWaitOnce = async (taskId: string): Promise<boolean> => {
  let events: TaskEvent[];
  try {
    events = await readRecentEvents(taskId, PREMATURE_CHAT_WAIT_EVENT_LIMIT);
  } catch {
    return false;
  }
  return classifyPrematureChatWait(events);
};

const detectPrematureChatWait = async (taskId: string): Promise<boolean> => {
  // 第一次判不 premature → 直接放行
  if (!(await isPrematureChatWaitOnce(taskId))) return false;
  // 判 premature 时再给 250ms 复核：防「正文刚发出、flush 的 assistant_message 事件还没落盘」
  // 的竞态把合法回答误判成 premature（wait_for_user 的 MCP 调用和事件落盘是并发的）。
  await new Promise((resolve) => setTimeout(resolve, 250));
  return await isPrematureChatWaitOnce(taskId);
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
        "## 调用前提（按你所处模式自检）",
        "",
        "- **Chat 模式（自由对话、形如 `wait_for_user({ task_id, message })`）**：把回复**正文直接输出**给用户（正常说话、会实时流式显示）；`message` 参数只填**这一轮回复的一句话概括**（给历史 / 标题用、不是完整正文）。本轮已收到用户消息时、先把正文输出出来、再调本工具（message 填概括）；无用户消息（起手等第一句）时可不带 message 直接调。",
        "- **Task 模式（action 容器）**：写完 artifact 就是交付、按下方 A / B 用法调本工具等 ack——**不必**带 message（artifact 已是交付物、见下方「调用礼仪」）。",
        "",
        "> 下方「硬性规则 / 两种用法 / 调用礼仪」只适用于 **Task 模式**；**Chat 模式**只需守住上面那条「正文直接输出、message 填概括、再 wait」、与 action / artifact / approve / runner failed 无关、别把 task 待命态规则套到 chat 上。",
        "",
        "## 硬性规则（task 模式、不遵守 ai-flow runner 会把任务标 failed）",
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
        message: z
          .string()
          .optional()
          .describe(
            "【Chat 模式：填这一轮回复的一句话概括】给历史记录 / 标题用、不是完整正文——回复正文请直接输出给用户（会实时流式显示）。Task 模式 / chat 起手等第一句时不用传。",
          ),
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
    async ({ task_id, message, action_id, artifact_path }) => {
      console.log(
        `[chat-mcp] wait_for_user 入参 task_id=${task_id} message=${message ? `${message.trim().length}字` : "<无>"} action_id=${action_id ?? "<待命>"} artifact_path=${artifact_path ?? "<none>"}`,
      );

      // M/C'（text-delta + 概括）：chat 回复正文走「直接输出」（text-delta、case "assistant" 流式展示）、
      // message 只填一句话概括、纯做「逼 composer 先产出正文再挂等」的钩子、不展示给用户
      //（task 模式 wait 是 action 内 ack、artifact 已落 = 已交付、语义不同、不掺）。
      // 仅 chat + 待命态（不带 action_id）走这套：
      //   - message 非空（概括）= composer 声明本轮已回复 → 清拒绝计数、放行挂等（概括不展示、正文已 text-delta 流式展示）
      //   - message 空 → 兜底 A（读 events 判定）：只有「用户在等回答 + 本轮也没 stream 出任何正文」才拦
      //     （premature）。两个合法空场景不误拦：① chat 起手无首条 = 无 obligation = 放行；
      //     ② agent 把正文走了 text-delta = hasAnswered = 不拦（M/C' 正常路径、正文已流式展示）。
      if (chatModeTasks.has(task_id) && !action_id) {
        const chatMsg = (message ?? "").trim();
        if (chatMsg.length > 0) {
          if ((prematureWaitRejects.get(task_id) ?? 0) > 0) {
            prematureWaitRejects.delete(task_id);
          }
        } else {
          const rejected = prematureWaitRejects.get(task_id) ?? 0;
          if (
            rejected < PREMATURE_WAIT_REJECT_CAP &&
            (await detectPrematureChatWait(task_id))
          ) {
            prematureWaitRejects.set(task_id, rejected + 1);
            console.warn(
              `[chat-mcp] wait_for_user 兜底拦截 premature wait：task=${task_id} 第 ${rejected + 1} 次（上限 ${PREMATURE_WAIT_REJECT_CAP}）`,
            );
            return {
              content: [
                { type: "text" as const, text: PREMATURE_WAIT_REJECT_TEXT },
              ],
            };
          }
          // 正常放行（或已达上限放弃拦截）→ 清计数、下一轮从头算
          if (rejected > 0) prematureWaitRejects.delete(task_id);
        }
      }

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
        "结构化 action（plan / build / review / ship / learn / dev）内 agent 遇到不确定项时、把当前轮想问的**全部打包**成 questions[]、阻塞等用户在 UI 弹窗里答完整组。",
        "对标 Cursor `askFollowUpQuestion`：UI 出选项按钮 + 可选自由文本输入。",
        "",
        "## ⚠️ chat 模式（task.mode === 'chat'）禁用（V0.6.0.1 拍板）",
        "",
        "**本工具只用于 task 容器模式的 action（plan / build / review / ship / learn / dev）**。chat（自由对话）任务跑在独立 chat-runner、prompt 里已禁用 ask_user——",
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
          .describe("当前 action id（plan / build / review / ship / learn / dev）"),
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
      title: "提交 GitLab MR（ship 提测 / dev 联调 / custom 自定义 action 用、server 同步调 REST API）",
      description: [
        "ship（提测→该仓测试分支）/ dev 联调提 PR（→该仓 dev 分支）/ custom 自定义 action（→target 由该 action 的 playbook 决定）跑通后、调本工具让 server 端用 GitLab REST API 创 MR。",
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
        "  - `has_conflicts`：**重点**——本 MR 跟目标分支有没有冲突、`true` = 合不了、按下方铁律处理",
        "  - `merge_status`：GitLab detailed_merge_status 原值（mergeable / conflict / checking ...）、审计用",
        "  - `merge_undetermined`：GitLab 还在异步算可合性、本次没查准（保守当无冲突、可在 artifact 注明待人工复核）",
        "",
        "## ⚠️ has_conflicts=true 时（铁律、按 ship prompt §3.5/§3.6 走）",
        "",
        "1. **绝不**把目标分支 `merge` / `rebase` / `pull` 进 **feature** 分支、也不 force push feature/目标分支——feature 本体永远干净",
        "2. **先不**发飞书评论——飞书 @ 评论只在「所有仓 MR 都无冲突」时才发、不能把合不了的 MR 甩给测试人员",
        "3. 调 `ask_user` 问用户「AI 智能解 / 自己解」：",
        "   - 选 **AI 解** → 按 ship §3.6 / dev prompt 同款：另建一次性 `<feature>__conflict` 分支（基于目标分支）、把 feature 合进去解冲突、`push -f` 后用 `__conflict` 当 source_branch 再调本工具（server 会自动关掉被取代的旧 MR）。仅这条 `__conflict` 分支上的 merge / force push 是铁律豁免、feature 全程不动",
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
        action_id: z.string().describe("当前 ship / dev / custom action 的 id"),
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
            "MR 目标分支（见 super prompt「## 仓库分支配置」段、不要探 origin/HEAD）：ship 提测填该仓测试分支（没配则 `test`）；dev 联调填该仓 dev 分支；custom 自定义 action 按本 action 的 playbook + 指令决定提哪个分支（不限分支、分支名可参考「仓库分支配置」段）。",
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
        "## 重跑 plan / 补需求时",
        "",
        "如果 NEXT_ACTION 里出现 `[REPLAN_MODE append]`：",
        "  - 本次 plan 是补充需求，只上报**新增 / 补充批次 delta**",
        "  - 不要把旧 plan 已有批次重复塞进 batches；旧批次和已完成进度由系统从 action 历史派生",
        "  - 如果新增需求仍然不大到需要分批，可以不调本工具，但用户在 build 选择里会看到本次 plan 未纳入结构化批次",
        "",
        "如果 NEXT_ACTION 里出现 `[REPLAN_MODE rebuild]`：",
        "  - 本次 plan 是重建后续方案，可以上报新的后续批次集合",
        "  - 系统会派生地替代此前仍未完成的旧批次；已完成批次保留历史",
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

// ----------------- 会话表（stateful 模式） -----------------
//
// stateless 模式 SDK 会硬拒「跨请求复用 transport」、
// 但我们 wait_for_user 是长阻塞工具、必须跨请求保留 transport 生命周期。
// 所以走 stateful：客户端 init 拿 sessionId、后续请求带 sessionId 复用 transport。
//
// 「sessionId → transport」表本体在 chat-pending 的 globalThis 状态里（拆文件不拆状态）、
// 由 transport 自己的 onsessioninitialized / onsessionclosed 回调维护。

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
