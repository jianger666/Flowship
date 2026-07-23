/**
 * Task action 模式专用的本地 HTTP MCP server
 *
 * 这个文件做的事情（V0.9.x 拆分、V0.11 wait 协议退役后）：
 * 1. 用官方 `@modelcontextprotocol/sdk` 起一个 stateful 的 HTTP MCP server
 * 2. 在它上面注册 `submit_work` / `ask_user` / `submit_mr` / `set_feishu_testers` / `set_plan_batches` / `create_custom_action` 工具
 * 3. 工具 handler 调 chat-pending 的 registerPendingAsk / runTaskAction / safeNotifyXxx
 * 4. 暴露一个 fetch-style 的 `handleChatMcpRequest`、给 Next.js App Router 直接调
 *
 * ## V0.11 模型：create + 多轮 send、run 自然结束（wait 协议退役）
 *
 * - `submit_work` = **交卷**（非阻塞）：通知 runner 跑后置 check + 切 awaiting_ack、
 *   返回「结束本轮回复」——agent 正常结束 turn、run 自然 finished 是**正常路径**
 * - `ask_user` = **弹窗**（非阻塞）：登记 pendingAsk + 通知 runner 写事件、返回「结束本轮回复」
 * - 用户的一切后续操作（再聊聊 / 推进 / ask 答案 / chat 消息）由 server 端
 *   `agent.send(buildAgentMessage(...))` 以新消息送达、agent 在同一会话（同 Agent 实例）继续：
 *   - `[ACTION_ACK revise] <feedback>`：用户点「再聊聊」
 *   - `[NEXT_ACTION action_id=... type=... n=... artifact_path=...]` + 指令：推进（续用会话）
 *   - `[USER_REPLY]` / `[ASK_USER_REPLY]`：chat 消息 / ask 答案
 * - approve（通过）纯服务端落状态、终态（合入/放弃）直接 cancel 活 run + 关会话——都不再发信号
 *
 * 旧「单 Run 永生 + shell curl 长轮询 wait-ack」机制（V0.3.5~V0.10）已删、见 git 历史。
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import {
  CALLER_MISMATCH_ERROR,
  cancelPendingIf,
  matchExpectedCallerToken,
  registerPendingAsk,
  runTaskAction,
  safeNotifyAskUserRequest,
  safeNotifyAwaiting,
  sessionTransports,
  type AskUserQuestion,
  type NotifyAwaitingResult,
} from "./chat-pending";

/** notify 未送达时工具返回（反登记后、非 ASK_SUBMITTED） */
const ASK_NOTIFY_FAILED_TEXT = "任务已被接管/通知失败、请重试";
import { createCustomAction } from "./custom-action-fs";
import { getAppSkillsDir } from "./skills-loader";
import { promises as fs } from "node:fs";
import path from "node:path";

/** caller 不匹配时的 MCP 工具返回（无副作用） */
const callerMismatchContent = () => ({
  content: [{ type: "text" as const, text: CALLER_MISMATCH_ERROR }],
});

// ----------------- 工具返回文本（V0.11：非阻塞、指示 agent 结束本轮回复） -----------------

// submit_work 交卷成功后的返回：明确「结束回复、别等待」——这是 run 自然结束的正常出口
const submittedText = (actionId: string): string =>
  [
    `[SUBMITTED] action=${actionId} 已交卷、系统正在后台跑质量检查、用户会收到通知。`,
    "",
    "**你这一轮的工作已全部完成、请立即结束本轮回复（正常结束 turn）。**",
    "- 不要执行任何等待 / 轮询命令（curl / sleep / watch 都不要）、不要再调本工具",
    "- 不要输出总结（用户在看板看 timeline 就够）",
    "- 用户的决定（通过 / 再聊聊 / 推进下一步）之后会作为**新消息**发给你、你会在同一会话里继续",
  ].join("\n");

/**
 * 把 safeNotifyAwaiting 结果映射为 submit_work 工具文案。
 * 导出供 ownership-r30 断言「stale/busy 不是 submitted」。
 */
export const mapSubmitWorkNotifyToToolText = (
  notifyResult: NotifyAwaitingResult,
  actionId: string,
): string => {
  if (notifyResult.status === "error") {
    return `交卷未受理：${notifyResult.message}`;
  }
  if (notifyResult.status === "busy") {
    return `交卷未受理：${notifyResult.message}`;
  }
  if (notifyResult.status === "stale") {
    return "该 action 已结束/已被后续操作取代、请结束本轮回复";
  }
  if (notifyResult.status === "mismatch") {
    return CALLER_MISMATCH_ERROR;
  }
  if (notifyResult.status === "no_notifier") {
    return "交卷未受理：任务当前没有活跃会话桥（可能已被停止/接管）、请结束本轮回复";
  }
  // accepted | delivered
  return submittedText(actionId);
};

// 旧「待命态」姿势（不带 action_id）兜底：告诉 agent 直接结束回复
const idleWaitText = (): string =>
  [
    "[NO_WAIT_NEEDED] 本系统不需要挂起等待：请直接结束本轮回复（正常结束 turn）。",
    "用户的下一步操作会作为新消息发给你、你会在同一会话里继续。",
  ].join("\n");

// ask_user 提交成功后的返回：答题卡已推、结束回复等答案以新消息送达
const askSubmittedText = (askId: string): string =>
  [
    `[ASK_SUBMITTED] 问题组 ${askId} 已推送给用户（UI 答题卡）。`,
    "",
    "**请立即结束本轮回复（正常结束 turn）**——不要执行任何等待 / 轮询命令、不要再调本工具重复提问、**不要再输出任何总结 / 补充段落**（提问本身就是本轮收尾）。",
    "用户答完后、答案会以 `[ASK_USER_REPLY]` 开头的**新消息**发给你（或 `[ASK_USER_REPLY deferred]` = 稍后再补充 → 按 default 推进、未答项自行记住即可）。",
  ].join("\n");

// ----------------- McpServer 构造 -----------------

/**
 * @param callerToken 本 MCP session 在 initialize 时从 URL ?caller= 捕获的身份。
 *   每个 Agent.create/resume 拿独立 URL → 独立 MCP session → 闭包里的 token 不变；
 *   工具执行前与 chat-pending 注册表的 expectedCallerToken 核对。
 */
const buildMcpServer = (callerToken: string | undefined): McpServer => {
  const srv = new McpServer({
    name: "flowship-task",
    version: "1.0.0",
  });

  // V0.11.9 改名：wait_for_user → submit_work（语义早就是「交卷」不是「等待」、名字跟上）。
  // 抽出 config / handler 供双注册：旧名保留一版作 alias（升级前启动的会话 in-context prompt
  // 还教的旧名、断代会让在跑任务交不了卷）、下个大版本删。
  const submitWorkConfig = {
      title: "交卷：宣告当前 action 完成（非阻塞、调完就结束本轮回复）",
      description: [
        "Task 模式（action 容器）专用：完成一个 action（写完 artifact）后调本工具**交卷**。",
        "系统会在后台跑质量检查、然后通知用户来审。**本工具立即返回、不会阻塞**。",
        "",
        "## 硬性规则",
        "",
        "- **完成一个 action（写完 artifact）后必须调一次本工具**——不调 = action 没完成、runner 会把任务标 failed",
        "- **不要写完 artifact 只输出一句「请你确认」的回复就结束**——必须调本工具交卷",
        "- **调完本工具后、立即结束本轮回复（正常结束 turn）**——不要执行任何等待 / 轮询命令（curl / sleep / watch 都不要）",
        "- 用户的决定（通过 / 再聊聊 / 推进下一步）会作为**新消息**发给你、你在同一会话里继续",
        "",
        "## 用法",
        "",
        "`submit_work({ task_id, action_id, artifact_path })`",
        "  - `action_id`：当前 action 的 id（agent 启动时 / [NEXT_ACTION ...] 头里传过的）",
        "  - `artifact_path`：刚产出的 artifact 相对路径（如 `actions/1-plan.md`）",
        "",
        "## 调用礼仪",
        "  - 每完成一个 action 调一次（不要每写一句就调、也不要写完了不调）",
        "  - 调用前 / 后都不要在正文里讲本工具的存在、对用户透明",
        "  - Chat 模式（自由对话）**不需要**调本工具——直接把回复正文输出、说完自然结束回复即可",
      ].join("\n"),
      inputSchema: {
        task_id: z.string().describe("任务 id（agent 启动时被告知）"),
        message: z
          .string()
          .optional()
          .describe("可选：这一轮工作的一句话概括（审计用、不展示给用户）"),
        action_id: z
          .string()
          .optional()
          .describe(
            "完成一个 action 后必传：当前 action 的 id（agent 启动 / [NEXT_ACTION] 头里传过的）。",
          ),
        artifact_path: z
          .string()
          .optional()
          .describe(
            "完成 action 时可选：刚产出的 artifact 相对 task 根的路径（如 `actions/1-plan.md`）。用于 UI 展示和审计。",
          ),
      },
    };
  const submitWorkHandler = async ({
    task_id,
    message,
    action_id,
    artifact_path,
  }: {
    task_id: string;
    message?: string;
    action_id?: string;
    artifact_path?: string;
  }) => {
      console.log(
        `[chat-mcp] submit_work 交卷 task_id=${task_id} message=${message ? `${message.trim().length}字` : "<无>"} action_id=${action_id ?? "<无>"} artifact_path=${artifact_path ?? "<none>"} caller=${callerToken ?? "<none>"}`,
      );

      // 副作用前核对 caller——旧 agent 迟到交卷不得启后继的 postCheck
      if (!matchExpectedCallerToken(task_id, callerToken)) {
        return callerMismatchContent();
      }

      // 不带 action_id（chat 模式旧姿势 / 老 prompt 惯性「待命态」）→ 不需要任何等待、
      // 通知 runner 切 awaiting_user（有 notifier 才生效）、指示 agent 直接结束回复
      // 消费 outcome——mismatch/stale/error/busy 不得再报 idle 成功文案；
      // no_notifier 保留成功（chat / 无桥待命是常态，agent 只需结束 turn）
      if (!action_id) {
        const idleNotify = await safeNotifyAwaiting(task_id, { callerToken });
        if (idleNotify.status === "mismatch") {
          return callerMismatchContent();
        }
        if (
          idleNotify.status === "stale" ||
          idleNotify.status === "busy" ||
          idleNotify.status === "error"
        ) {
          return {
            content: [
              {
                type: "text" as const,
                text: mapSubmitWorkNotifyToToolText(idleNotify, "<idle>"),
              },
            ],
          };
        }
        // accepted | no_notifier | delivered
        return {
          content: [{ type: "text" as const, text: idleWaitText() }],
        };
      }

      // 交卷：通知 runner（后台跑 check + 切 awaiting_ack、见 task-runner awaitingNotifier）
      const notifyResult = await safeNotifyAwaiting(task_id, {
        actionId: action_id,
        artifactPath: artifact_path,
        callerToken,
      });
      // 只有 accepted/delivered 才报「已交卷」；stale/busy 走 mapSubmitWorkNotifyToToolText
      if (notifyResult.status === "mismatch") {
        return callerMismatchContent();
      }
      return {
        content: [
          {
            type: "text" as const,
            text: mapSubmitWorkNotifyToToolText(notifyResult, action_id),
          },
        ],
      };
    };

  srv.registerTool("submit_work", submitWorkConfig, submitWorkHandler);
  // 旧名 alias（仅为升级前启动的在跑会话兜底、新 prompt 全部教 submit_work、下版本删）
  srv.registerTool(
    "wait_for_user",
    {
      ...submitWorkConfig,
      title: "（旧名、= submit_work）交卷：宣告当前 action 完成",
      description:
        "本工具已改名 `submit_work`、行为完全一致——这是旧名 alias、仅供升级前启动的会话使用；能用 submit_work 就用它。",
    },
    submitWorkHandler,
  );

  // ----------------- ask_user 工具（V0.3.2 一次打包多问题、modal 形态、V0.11 非阻塞）-----------------
  //
  // 设计动机（用户拍板）：
  //   - 单次调用：把当前 turn 想得到的不确定项**一次性打包**成 questions[]、UI modal 一次问完
  //   - V0.5.6 改：**没有「一个 action 最多 1 次」上限**——agent 按内容判断、按需多次调
  //   - V0.5.6 加 defer：用户可在 UI 弹窗点「稍后再补充」、agent 拿 [ASK_USER_REPLY deferred]
  //     跳过这组 Q、按 default 推进、列进 artifact §6 待澄清
  //
  // V0.11 非阻塞语义：调用 = 弹窗推给用户 + 登记 pendingAsk、立即返回「结束本轮回复」；
  // 用户答完后答案以 `[ASK_USER_REPLY]` 开头的新消息（agent.send）送达、agent 同会话继续。
  srv.registerTool(
    "ask_user",
    {
      title: "打包提问（一次问完所有不确定项）",
      description: [
        "遇到不确定 / 要用户选择时、把当前轮想问的**全部打包**成 questions[]、推 UI 答题卡。task / chat 都可用。",
        "对标 Cursor `askFollowUpQuestion`：选项按钮 + 可选自由文本。",
        "",
        "## 约束",
        "",
        "- **单次调用**：当前轮问题全部进 questions[]——同一时刻只能有一组 pending、再调会顶替旧的",
        "- **可多次**：上一轮答模糊 → 形成判断后再问一轮给具体选项，正常",
        "- **只在确实有不确定项时调**——没问题就跳过",
        "- **options 不要塞 Other / 其他 / 以上都不是**——`allow_text=true` 时 UI 自动加「自定义」、你再加会重复",
        "- **背景说明 / 前情提要放进 question 字段**（答题卡里展示）——不要另写一段正文当「铺垫」",
        "",
        "## 返回值（非阻塞）",
        "",
        "- `[ASK_SUBMITTED]` = 答题卡已推——**立即结束本轮回复**、别等 / 别轮询、**不要再输出任何总结段落**（提问本身就是本轮收尾）",
        "- 用户答完以新消息送达：`[ASK_USER_REPLY]` Q&A、或 `[ASK_USER_REPLY deferred]`（稍后再补 → 按 default 推进、别再问同组）",
        "",
        "## 礼仪",
        "",
        "- 调前别在正文预告「我先问几个问题」——答题卡自己会出",
        "- **调用本工具后直接结束回复、不要再输出任何总结 / 补充段落**（否则会把答题卡顶上去）",
        "- 答完别复述「你选了 X」、直接按答案推进",
      ].join("\n"),
      inputSchema: {
        task_id: z.string().describe("任务 id"),
        action_id: z
          .string()
          .optional()
          .describe("当前 action id（task 模式可选；chat 无 action、可不传）"),
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
                  "可选项、数量不限（常见 2-6 个；候选确实多就列全、别自行截断）。不要塞 Other / 其他 / 以上都不是——allow_text 时 UI 自动加。",
                ),
              allow_text: z
                .boolean()
                .optional()
                .describe(
                  "是否渲染「自定义回答」入口、默认 true（不是往 options 里加 Other）",
                ),
            }),
          )
          .min(1)
          .describe("问题数组、当前轮不确定项打包、至少 1 条"),
      },
    },
    async ({ task_id, action_id, questions }) => {
      // 必须在 registerPendingAsk 之前核对——验收点名旧实现先登记再验主
      if (!matchExpectedCallerToken(task_id, callerToken)) {
        return callerMismatchContent();
      }
      const askId = `ask_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      // 归一化：清掉空白、补齐 allow_text 默认值
      const normalized: AskUserQuestion[] = questions.map((q) => ({
        id: q.id,
        question: q.question.trim(),
        options: q.options,
        allowText: q.allow_text !== false,
      }));

      // V0.11：登记 pendingAsk（新提问顶旧的、token 防旧弹窗答案串新提问）、立即返回「结束回复」
      const ask = registerPendingAsk(task_id, {
        askId,
        questions: normalized,
        actionId: action_id,
      });
      console.log(
        `[chat-mcp] ask_user 入参 task=${task_id} action_id=${action_id ?? "<none>"} askId=${askId} token=${ask.token} questions=${normalized.length} caller=${callerToken ?? "<none>"}`,
      );

      // 通知 runner 写 ask_user_request 事件 + 切 runStatus = awaiting_user
      // 只有 accepted 才报 ASK_SUBMITTED；stale/busy/mismatch 反登记 + 错误文案
      const askNotify = await safeNotifyAskUserRequest(task_id, {
        askId,
        token: ask.token,
        questions: normalized,
        actionId: action_id,
        callerToken,
      });
      if (askNotify.status !== "accepted") {
        // notifier stale 内部已 cancelPendingIf；此处再调幂等，覆盖 mismatch/no_notifier/error
        cancelPendingIf(task_id, askId);
        if (askNotify.status === "mismatch") {
          return callerMismatchContent();
        }
        return {
          content: [{ type: "text" as const, text: ASK_NOTIFY_FAILED_TEXT }],
        };
      }

      return {
        content: [{ type: "text" as const, text: askSubmittedText(askId) }],
      };
    },
  );

  // ----------------- submit_mr 工具（V0.6.1、ship / 改bug 等提测建 MR、同步调 GitLab API）-----------------
  //
  // 这是「同步 RPC 工具」、跟 submit_work / ask_user 的「长阻塞 + shell long-poll」完全不同：
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
      title:
        "提交 GitLab MR（ship / 改bug 等提测建 MR、dev 联调、custom 自定义 action；server 同步调 REST API）",
      description: [
        "ship / 改bug 等 action 提测建 MR（→该仓测试分支）、dev 联调提 PR（→该仓 dev 分支）、其它 custom action（→target 由该 action 的 playbook 决定）跑通后、调本工具让 server 端用 GitLab REST API 创 MR。",
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
        "- 调用前不输出「我要提测了」之类的回复文本、对用户透明",
        "- 调用后拿到 `mr_url` 直接落到 artifact、ack 时用户能看到 MR 链接",
      ].join("\n"),
      inputSchema: {
        task_id: z.string().describe("任务 id"),
        action_id: z
          .string()
          .describe("当前 ship / 改bug（custom）/ dev / 其它 custom action 的 id"),
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
            "MR 目标分支（见 super prompt「## 仓库分支配置」段、不要探 origin/HEAD）：ship / 改bug 等提测填该仓测试分支（没配则 `test`）；dev 联调填该仓 dev 分支；其它 custom 按本 action 的 playbook + 指令决定（不限分支、分支名可参考「仓库分支配置」段）。",
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
        `[chat-mcp] submit_mr task=${task_id} action=${action_id} repo=${repo_path} project=${project_path} src=${source_branch}→${target_branch} caller=${callerToken ?? "<none>"}`,
      );
      // runTaskAction 入口核 caller——拒则不进 handler、不调 GitLab createMR
      const result = await runTaskAction(
        task_id,
        {
          kind: "submit_mr",
          actionId: action_id,
          repoPath: repo_path,
          projectPath: project_path,
          sourceBranch: source_branch,
          targetBranch: target_branch,
          title,
          description,
          lastCommitHash: last_commit_hash,
        },
        callerToken,
      );
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
  // 2026-06-12 起从 lark_user_id 切到 user_key（飞书评论 mention 按 user_key 校验、
  // lark_user_id 报 cross tenant）、describe 必须跟 action-ship.md §2/§4 保持一致。
  // V0.12+ 探测主路径 = 内置 meegle CLI（workitem get / user search）、不再走飞书项目 MCP。
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
        "  1. 用内置 meegle CLI：`url decode` → `workitem get` 抓「测试」角色的 role_members、`member.key` 就是 user_key（纯数字、直接用）",
        "  2. 探到任意人 → 调本工具持久化 / 探不到 → 调 ask_user 让用户填用户名 + `meegle user search` 取 user_key 字段后用本工具落库",
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
        `[chat-mcp] set_feishu_testers task=${task_id} action=${action_id} userKeys=${user_keys.length} caller=${callerToken ?? "<none>"}`,
      );
      const result = await runTaskAction(
        task_id,
        {
          kind: "set_feishu_testers",
          actionId: action_id,
          userKeys: user_keys,
        },
        callerToken,
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      };
    },
  );

  // ----------------- create_custom_action 工具（对话创建 action、全局语义不绑 task）-----------------
  //
  // 自定义 action = skill 挂载壳：AI 先把纯方法论 SKILL.md 写进自管 skills，再调本工具挂壳。
  // 产出要求走 output 参数（壳参数）、不要写进 SKILL.md——skill 可拆卸复用。
  //
  // 不需要 task_id：定义存 dataRoot()/custom-actions、跟具体 task 无关。
  srv.registerTool(
    "create_custom_action",
    {
      title: "挂载自定义 Action（skill 已写好后调用）",
      description: [
        "把已写好的主 skill 挂成自定义 Action（推进面板里的一个动作按钮）。",
        "",
        "## 调用顺序（必须）",
        "",
        "1. **先**把纯方法论 `SKILL.md` 写进自管 skills 目录（目录名用简短中文或 kebab-case 英文 = skill 名）",
        "2. **再**调本工具挂壳——`skill` 参数传刚写好的 skill 名",
        "3. **产出要求**写进本工具的 `output` 参数、**不要**写进 SKILL.md（skill 是可拆卸方法论、壳才带产出约束）",
        "",
        "## 什么时候调",
        "",
        "- 用户要「建一个推进动作 / action」、且主 skill 的 SKILL.md 已经落盘",
        "- 对话创建流程里、写完 skill 后的最后一步",
        "",
        "## 什么时候不调",
        "",
        "- 主 skill 还没写好 / 写到一半 → 先写完再调；本工具会校验 skill 是否存在、查无返回错误",
        "- 只要沉淀可复用方法论、不需要出现在推进面板 → 只写 skill、别挂壳",
        "",
        "## 入参 / 返回",
        "",
        "- `label`：推进按钮显示名（必填）",
        "- `skill`：主 skill 名（必填、须已存在）",
        "- `output`：本 action 的产出要求（可选、多行）",
        "- `placeholder`：推进输入框提示（可选）",
        "- 成功返回已创建的 action id + label；失败返回错误说明（如 skill 不存在）",
      ].join("\n"),
      inputSchema: {
        label: z
          .string()
          .min(1)
          .describe("推进面板按钮上显示的动作名（如「性能审计」）"),
        skill: z
          .string()
          .min(1)
          .describe(
            "主 skill 名（须已写入自管 skills 目录；先写 SKILL.md 再调本工具）",
          ),
        output: z
          .string()
          .optional()
          .describe(
            "本 action 的产出要求（多行可）；属壳参数、不要写进 SKILL.md",
          ),
        placeholder: z
          .string()
          .optional()
          .describe("推进弹窗输入框的提示文案（可选）"),
      },
    },
    async ({ label, skill, output, placeholder }) => {
      const labelTrimmed = label.trim();
      // 防写出 label 空串僵尸目录（空白 / 纯空格）
      if (!labelTrimmed) {
        return {
          content: [
            {
              type: "text" as const,
              text: "label 不能为空（trim 后须有实质内容）",
            },
          ],
        };
      }
      // 查无此自管 skill → 返回错误文本让 AI 先建 skill（不抛、MCP 工具约定用 content 回传）
      const skillName = skill.trim();
      const appDir = path.join(getAppSkillsDir(), skillName);
      const appExists = await fs.stat(appDir).then(
        (st) => st.isDirectory(),
        () => false,
      );
      if (!appExists) {
        return {
          content: [
            {
              type: "text" as const,
              text: `主 skill「${skillName}」不在自管目录。请先把 SKILL.md 写进自管 skills（目录名=${skillName}），再调本工具挂壳。`,
            },
          ],
        };
      }
      try {
        const action = await createCustomAction({
          label: labelTrimmed,
          skill: skillName,
          output: output?.trim() || undefined,
          placeholder: placeholder?.trim() || undefined,
        });
        console.log(
          `[chat-mcp] create_custom_action id=${action.id} skill=${action.skill}`,
        );
        return {
          content: [
            {
              type: "text" as const,
              text: `已挂载自定义 Action：id=${action.id}、label=${action.label}、skill=${action.skill}。请告诉用户去能力页 Action tab 查看 / 排序 / 显隐。`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `挂载失败：${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
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
        `[chat-mcp] set_plan_batches task=${task_id} action=${action_id} batches=${batches.length} caller=${callerToken ?? "<none>"}`,
      );
      const result = await runTaskAction(
        task_id,
        {
          kind: "set_plan_batches",
          actionId: action_id,
          batches: batches.map((b) => ({
            id: b.id,
            title: b.title,
            testStrategy: b.test_strategy,
            taskRefs: b.task_refs,
          })),
        },
        callerToken,
      );
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
// 但我们 submit_work 是长阻塞工具、必须跨请求保留 transport 生命周期。
// 所以走 stateful：客户端 init 拿 sessionId、后续请求带 sessionId 复用 transport。
//
// 「sessionId → transport」表本体在 chat-pending 的 globalThis 状态里（拆文件不拆状态）、
// 由 transport 自己的 onsessioninitialized / onsessionclosed 回调维护。

/**
 * @param callerToken initialize 请求 URL 的 ?caller=；捕获进 MCP server 闭包、
 *   本 session 后续工具调用都带同一身份（Agent.create 每次新建 MCP session、URL 不同即 session 不同）。
 */
const buildSessionTransport = (
  callerToken: string | undefined,
): WebStandardStreamableHTTPServerTransport => {
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      // V0.3.5 关键修复：禁 SSE GET 流通道、只用 POST JSON-RPC（短连接 sync request）
      //
      // 背景：MCP StreamableHTTP transport 默认 client 启 transport 后会建一条 GET SSE
      // 长连接接 server push notification。但我们业务上：
      //   - submit_work / ask_user 都是立即返回 SHELL_WAIT_GUIDE、不走 SSE stream
      //   - UI 事件流推送走 Flowship 自己的 /api/tasks/[id]/events 端点、不走 MCP push
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
    const server = buildMcpServer(callerToken);
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
  // 从 URL query 提 caller（Agent.create 时 inline mcpServers URL 带 ?caller=）
  let callerFromUrl: string | undefined;
  try {
    const u = new URL(req.url);
    const c = u.searchParams.get("caller");
    if (c && c.trim().length > 0) callerFromUrl = c.trim();
  } catch {
    /* noop */
  }
  console.log(
    `[chat-mcp] handleChatMcpRequest method=${req.method} sessionId=${sessionId ?? "<none>"} caller=${callerFromUrl ?? "<none>"} 已有 transport ${sessionTransports.size} 个`,
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

  // initialize 时把 caller 冻进 transport/server 闭包——后续同 session 工具调用复用
  const transport = buildSessionTransport(callerFromUrl);
  return transport.handleRequest(req, { parsedBody: parsed });
};

// ----------------- task-runner 用的 endpoint URL helper -----------------

/**
 * 推算给 Cursor SDK Agent 用的 chat-tool MCP endpoint URL。
 * 优先级：FLOWSHIP_CHAT_MCP_URL → FLOWSHIP_BASE_URL → PORT → 8876；必须 127.0.0.1。
 * @param callerToken agent 实例身份，拼到 `?caller=`——每个 Agent.create/resume
 *   拿独一无二的 URL → SDK 新建独立 MCP session（无老 session 复用问题）。
 */
export const getChatMcpUrl = (callerToken?: string): string => {
  let base: string;
  const explicit = process.env.FLOWSHIP_CHAT_MCP_URL;
  if (explicit && explicit.trim().length > 0) {
    base = explicit.trim();
  } else {
    const envBase = process.env.FLOWSHIP_BASE_URL;
    if (envBase && envBase.trim().length > 0) {
      base = `${envBase.replace(/\/+$/, "")}/api/mcp/chat-tool`;
    } else {
      const port =
        process.env.PORT && /^\d+$/.test(process.env.PORT)
          ? process.env.PORT
          : "8876";
      base = `http://127.0.0.1:${port}/api/mcp/chat-tool`;
    }
  }
  if (!callerToken) return base;
  try {
    const u = new URL(base);
    u.searchParams.set("caller", callerToken);
    return u.toString();
  } catch {
    const sep = base.includes("?") ? "&" : "?";
    return `${base}${sep}caller=${encodeURIComponent(callerToken)}`;
  }
};

/**
 * 测试用：走真实 submit_work 分派（含无 action_id 待命分支的 outcome 消费）。
 * 与生产工具 handler 同口径；不必起 HTTP MCP server。
 */
export const dispatchSubmitWorkForTest = async (args: {
  taskId: string;
  callerToken: string | undefined;
  actionId?: string;
  artifactPath?: string;
}): Promise<{ text: string }> => {
  if (!matchExpectedCallerToken(args.taskId, args.callerToken)) {
    return { text: CALLER_MISMATCH_ERROR };
  }
  if (!args.actionId) {
    const idleNotify = await safeNotifyAwaiting(args.taskId, {
      callerToken: args.callerToken,
    });
    if (idleNotify.status === "mismatch") {
      return { text: CALLER_MISMATCH_ERROR };
    }
    if (
      idleNotify.status === "stale" ||
      idleNotify.status === "busy" ||
      idleNotify.status === "error"
    ) {
      return {
        text: mapSubmitWorkNotifyToToolText(idleNotify, "<idle>"),
      };
    }
    return { text: idleWaitText() };
  }
  const notifyResult = await safeNotifyAwaiting(args.taskId, {
    actionId: args.actionId,
    artifactPath: args.artifactPath,
    callerToken: args.callerToken,
  });
  if (notifyResult.status === "mismatch") {
    return { text: CALLER_MISMATCH_ERROR };
  }
  return {
    text: mapSubmitWorkNotifyToToolText(notifyResult, args.actionId),
  };
};

/**
 * 测试用：走真实 ask_user 分派路径（核对 caller → 才 registerPendingAsk）。
 * 不必起 HTTP MCP server；生产路径是工具 handler 内联同款逻辑。
 */
export const dispatchAskUserForTest = async (args: {
  taskId: string;
  callerToken: string | undefined;
  actionId?: string;
  questions: AskUserQuestion[];
}): Promise<{ ok: true; askId: string } | { ok: false; error: string }> => {
  if (!matchExpectedCallerToken(args.taskId, args.callerToken)) {
    return { ok: false, error: CALLER_MISMATCH_ERROR };
  }
  const askId = `ask_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const ask = registerPendingAsk(args.taskId, {
    askId,
    questions: args.questions,
    actionId: args.actionId,
  });
  // 与生产 ask_user 工具同口径——只有 accepted 才成功
  const askNotify = await safeNotifyAskUserRequest(args.taskId, {
    askId,
    token: ask.token,
    questions: args.questions,
    actionId: args.actionId,
    callerToken: args.callerToken,
  });
  if (askNotify.status !== "accepted") {
    cancelPendingIf(args.taskId, askId);
    if (askNotify.status === "mismatch") {
      return { ok: false, error: CALLER_MISMATCH_ERROR };
    }
    return { ok: false, error: ASK_NOTIFY_FAILED_TEXT };
  }
  return { ok: true, askId };
};

