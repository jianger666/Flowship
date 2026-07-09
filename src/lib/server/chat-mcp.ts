/**
 * Task action 模式专用的本地 HTTP MCP server
 *
 * 这个文件做的事情（V0.9.x 拆分、V0.11 wait 协议退役后）：
 * 1. 用官方 `@modelcontextprotocol/sdk` 起一个 stateful 的 HTTP MCP server
 * 2. 在它上面注册 `submit_work` / `ask_user` / `submit_mr` / `set_feishu_testers` / `set_plan_batches` 工具
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
  registerPendingAsk,
  runTaskAction,
  safeNotifyAskUserRequest,
  safeNotifyAwaiting,
  sessionTransports,
  type AskUserQuestion,
} from "./chat-pending";

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

// 旧「待命态」姿势（不带 action_id）兜底：告诉 agent 直接结束回复
const idleWaitText = (): string =>
  [
    "[NO_WAIT_NEEDED] 本系统不需要挂起等待：请直接结束本轮回复（正常结束 turn）。",
    "用户的下一步操作会作为新消息发给你、你会在同一会话里继续。",
  ].join("\n");

// ask_user 提交成功后的返回：弹窗已推给用户、结束回复等答案以新消息送达
const askSubmittedText = (askId: string): string =>
  [
    `[ASK_SUBMITTED] 问题组 ${askId} 已推送给用户（UI 弹窗）。`,
    "",
    "**请立即结束本轮回复（正常结束 turn）**——不要执行任何等待 / 轮询命令、不要再调本工具重复提问。",
    "用户答完后、答案会以 `[ASK_USER_REPLY]` 开头的**新消息**发给你（含每条 Q 的答案、或 `[ASK_USER_REPLY deferred]` 表示用户选了稍后再补充——按 default 推进并把未答项列进 artifact §6 待澄清）。",
  ].join("\n");

// ----------------- McpServer 构造 -----------------

const buildMcpServer = (): McpServer => {
  const srv = new McpServer({
    name: "ai-flow-task",
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
        "- **不要写完 artifact 只发 assistant_message 说「请你确认」就结束**——必须调本工具交卷",
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
        `[chat-mcp] submit_work 交卷 task_id=${task_id} message=${message ? `${message.trim().length}字` : "<无>"} action_id=${action_id ?? "<无>"} artifact_path=${artifact_path ?? "<none>"}`,
      );

      // 不带 action_id（chat 模式旧姿势 / 老 prompt 惯性「待命态」）→ 不需要任何等待、
      // 通知 runner 切 awaiting_user（有 notifier 才生效）、指示 agent 直接结束回复
      if (!action_id) {
        await safeNotifyAwaiting(task_id, {});
        return {
          content: [{ type: "text" as const, text: idleWaitText() }],
        };
      }

      // 交卷：通知 runner（后台跑 check + 切 awaiting_ack、见 task-runner awaitingNotifier）
      await safeNotifyAwaiting(task_id, {
        actionId: action_id,
        artifactPath: artifact_path,
      });

      return {
        content: [{ type: "text" as const, text: submittedText(action_id) }],
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
      title: "action 内打包提问（一次问完所有不确定项）",
      description: [
        "结构化 action（plan / build / review / ship / learn / dev）内 agent 遇到不确定项时、把当前轮想问的**全部打包**成 questions[]、推给用户 UI 弹窗。",
        "对标 Cursor `askFollowUpQuestion`：UI 出选项按钮 + 可选自由文本输入。",
        "",
        "## ⚠️ chat 模式（task.mode === 'chat'）禁用（V0.6.0.1 拍板）",
        "",
        "**本工具只用于 task 容器模式的 action**。chat（自由对话）有问题想确认时、直接在正文里问（markdown 列 A/B/C 选项也行）、说完结束回复等用户下一条消息。",
        "",
        "## 关键约束",
        "",
        "- **单次调用内**：把当前轮想问的问题**全部打包**到 questions[]、UI modal 一次答完——不要同一时刻调多次（一时刻只能有一组 pending、第二次会顶替第一次）",
        "- **整个 action 内无次数上限**：agent 按内容判断——「初稿打一次包问 → 用户答模糊 → read/grep 形成判断 → 再调一次给具体选项」是正常流程",
        "- **收敛标准**：所有问题都得到「明确的业务决策」（能直接落进 artifact 的）才交卷（submit_work）。判不准就再问、不要打 default 跳过",
        "- **只在确实有不确定项时调用**——没问题就跳过、直接交卷",
        "- **options 里不要手动塞「Other / 其他 / 其它 / 以上都不是 / 自定义」类的兜底选项**——`allow_text=true` 时 UI 会自动渲染「以上都不是 / 自定义回答…」按钮、你再加会重复",
        "",
        "## 何时调用",
        "",
        "- artifact 初稿写完、扫一遍发现有不确定 / 多选 / 歧义点：上下文冲突、口径不清、接口字段不明、技术路线 A/B",
        "- 用户上一轮答案模糊 /「你定 / 看代码再说」——read/grep 形成判断后、再调一次给具体业务选项让用户拍板",
        "- 产出审阅中用户消息含混（改类兜底）——调一次复述意图",
        "",
        "## 返回值（V0.11 非阻塞）",
        "",
        "- 立即返回 `[ASK_SUBMITTED]` = 弹窗已推送——**你应立即结束本轮回复（正常结束 turn）**、不要执行任何等待 / 轮询命令",
        "- 用户答完后、答案以**新消息**发给你（同一会话继续）、两种头：",
        "  - `[ASK_USER_REPLY]` + Q&A markdown：用户答了、解析每条 A、按内容推进（模糊 → 再调一次 ask_user 给具体选项）",
        "  - `[ASK_USER_REPLY deferred]` + 未答问题清单：**用户点了「稍后再补充」**——1）不再就这组 Q 重新提问 2）把这些 Q 完整列进 artifact「§6 待澄清」段、按你判断的合理 default 推进",
        "",
        "## 调用礼仪",
        "",
        "- 调用前 / 后不要在正文解释「我先问几个问题」之类、UI modal 会自动弹出来",
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

      // V0.11：登记 pendingAsk（新提问顶旧的、token 防旧弹窗答案串新提问）、立即返回「结束回复」
      const ask = registerPendingAsk(task_id, {
        askId,
        questions: normalized,
        actionId: action_id,
      });
      console.log(
        `[chat-mcp] ask_user 入参 task=${task_id} action_id=${action_id ?? "<none>"} askId=${askId} token=${ask.token} questions=${normalized.length}`,
      );

      // 通知 runner 写 ask_user_request 事件 + 切 runStatus = awaiting_user
      await safeNotifyAskUserRequest(task_id, {
        askId,
        token: ask.token,
        questions: normalized,
        actionId: action_id,
      });

      return {
        content: [{ type: "text" as const, text: askSubmittedText(askId) }],
      };
    },
  );

  // ----------------- submit_mr 工具（V0.6.1、ship action 专用、同步调 GitLab API）-----------------
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
// 但我们 submit_work 是长阻塞工具、必须跨请求保留 transport 生命周期。
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
      //   - submit_work / ask_user 都是立即返回 SHELL_WAIT_GUIDE、不走 SSE stream
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

