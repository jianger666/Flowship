/**
 * 需求群「非属主受限答疑」——独立的只读旁路通道
 *
 * # 为什么单独一个模块（双模型交叉 review 连报同族 P0 后的架构级收敛）
 *
 * 群里**非任务所有者**说的话只配得到一个答案，它**不是这个 task 的一次 action run**。
 * 之前它复用 `startOneShotQuestion`、于是被整套 task 运行状态机裹进去：调用方先把
 * `runStatus` 写成 `running`、one-shot 再登记 `runningTasks`、收尾还要把 runStatus
 * 归位……三个 P0 全长在这条错误的耦合上：
 *
 * - 顶栏「停止」键只看 `runStatus === "running"` → 群答疑一起跑就冒出来，而它走的是
 *   `stopTaskAgent` 核弹路径（running / awaiting_ack 的 action 一律标 cancelled + 关属主
 *   会话）——用户点一下，审阅中的 plan/review 被标取消、属主活会话被关
 * - 早退 / 启动失败要回滚的东西太多（runStatus + runningTasks + done），逐条补漏补不完
 * - 复用属主消息封装 → prompt 里同时出现「禁止改」和「修改要求才动手改」
 *
 * # 本模块的契约（改代码前先读这段）
 *
 * 1. **不写 `task.runStatus`**——一个字节都不写。UI 因此不显示「运行中」、停止键不出现、
 *    stopTask 的核弹路径也波及不到它。
 * 2. **不占 `runningTasks` / 不进 `agentSessions` / 不动任何 action**——与属主会话完全
 *    并行、互不感知（交卷后属主会话是刻意保留的，而那恰是产物刚播报进群、同事最可能
 *    回话的窗口；老实现在这里静默让位 = 群里没回音）。
 * 3. 唯一登记是 task-stream 的 {@link registerRestrictedQuestion} 轻量表，只服务两件事：
 *    终态（DELETE / finalize）叫停、群入向串行。
 * 4. **唯一收口 `settle(ok, errorText?)`**：幂等、任何出口（成功 / 失败 / 取消 / 兜底）
 *    都只经它发一次 `done`。群出向 tap 收到 done 才会回群并摘掉回群登记——
 *    漏发一次，那条登记就一直挂着、直到 TTL 过期（群里永久无答）。
 * 5. prompt 走 {@link buildReadonlyUserMessage}（无行为尾巴），硬约束段永远排在最后。
 * 6. **本 run publish 的每条 envelope 都带 `origin` = 本轮 runTag**（回群登记 token）。
 *    这是与属主 run 并行时不错投的唯一依据：群出向只把 origin 对得上的 delta / done
 *    投给对应登记。别在这条链上新增「不带 origin 的 publish」。
 */

import { Agent } from "./agent-backend";
import type { ModelSelection } from "@cursor/sdk";

import type { Task } from "@/lib/types";

import { buildReadonlyUserMessage } from "./chat-pending";
import { createRunPerfTracker } from "./run-perf";
import { summarizeRunFailure } from "./sdk-error";
import {
  SDK_CREATE_RESUME_TIMEOUT_MS,
  SDK_SEND_TIMEOUT_MS,
  withSdkDeadline,
} from "./sdk-deadline";
import {
  handleSdkMessage,
  type AssistantBufferCtx,
} from "./sdk-message-handler";
import {
  composeOnDelta,
  createSdkSummaryDeltaPublisher,
  createShellOutputDeltaPublisher,
} from "./shell-output-bridge";
import { getTask, readTaskRepoStatusFresh } from "./task-fs";
import { getActionsDir, getEventsLogPath } from "./task-fs-core";
import { ensureWorkspaceReady } from "./task-runner";
import {
  publishTaskStreamEvent,
  registerRestrictedQuestion,
  unregisterRestrictedQuestion,
  writeOwnedEventAndPublish,
  type RestrictedQuestionRun,
} from "./task-stream";
import { getTaskCwd, WorktreeLeaseLostError } from "./task-worktrees";

type AgentInstance = Awaited<ReturnType<typeof Agent.create>>;

export interface RestrictedQuestionInput {
  /** 入场快照（本通道不重读、也不写回） */
  task: Task;
  /** 群成员的话（已带 `[群消息·来自 X（非任务所有者）]` 抬头 + skill 指引） */
  text: string;
  imagePaths?: string[];
  attachmentPaths?: string[];
  creds: { apiKey: string; model: ModelSelection };
  /**
   * 本轮回群登记的 token（群入向 `rememberGroupReply` 返回的 runTag）。
   * 本 run publish 的每条 envelope 都带上它当 `origin`——群出向据此只把这段回答
   * 投给这条登记（属主 run 的 delta / done 一个字都进不来，反之亦然）。
   * 缺省时自生成一个一次性 token：**旁路事件必须永远带 origin**，
   * 否则会被当成属主主链、错投进属主那条登记。
   */
  runTag?: string;
}

/**
 * 受限 prompt（纯函数、好读好审）。
 *
 * 版式上「# 边界（硬约束…）」**必须是最后一段**——模型对末段指令最敏感，而且
 * 一旦后面还跟着别的段落（比如属主版消息封装那条「修改要求才动手改」），
 * 只读招牌当场作废。`tests/restricted-group-question.test.ts` 钉住这条版式。
 */
const buildRestrictedPrompt = (args: {
  taskId: string;
  title: string;
  cwd: string;
  askedText: string;
}): string =>
  [
    `你是任务「${args.title}」的**只读答疑**助手。需求群里一位非任务所有者说了句话、你只负责回答。`,
    "",
    "# 任务背景（按需 read / grep、先查再答）",
    `- 任务事件日志（完整历史）：${getEventsLogPath(args.taskId)}`,
    `- 产出文档目录（方案 / 实现 / 复核等 artifact）：${getActionsDir(args.taskId)}`,
    `- 工作目录：${args.cwd}`,
    "",
    "# 对方的话",
    args.askedText,
    "",
    "# 边界（硬约束、不得自行放宽）",
    "- **只答疑**：禁止新建 / 修改 / 删除任何文件，禁止 git 提交、推分支、提 MR",
    "- 只允许只读命令（read / grep / ls / git log 这类）；任何有副作用的命令（安装依赖、跑构建、改配置、调写接口）一律不执行",
    "- 对方要求改代码 / 改产物 / 推进任务 → 不动手，说明结论与建议、并告诉他这需要任务所有者在 Flowship 里操作",
    "- 答完自然结束回复",
  ].join("\n");

/**
 * 起一个受限（只读）答疑 agent 回答群里非属主的一句话。
 *
 * fire-and-forget：调用方（`task-question-inject`）写完用户消息事件后直接调、不 await。
 * 无论成功失败都会发一条 `done`（见文件头契约 4），调用方不需要也不应该自己收尾。
 */
export const startRestrictedGroupQuestion = (
  input: RestrictedQuestionInput,
): void => {
  const { task, creds } = input;
  // 本 run 的事件身份：调用方给了就用（= 回群登记的 token），没给自生成一个，
  // 保证旁路事件**永不**以「属主主链」的面目出现（见 RestrictedQuestionInput.runTag）
  const origin =
    input.runTag?.trim() ||
    `rq-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  // cancelled 同时是事件落盘 lease：终态收尾（DELETE / finalize）置位后不再写盘
  const record: RestrictedQuestionRun = {
    cancelled: false,
    cancel: () => {
      /* send 拿到 run 后替换成真 cancel */
    },
  };
  registerRestrictedQuestion(task.id, record);
  const alive = (): boolean => !record.cancelled;

  const execute = async (): Promise<void> => {
    let agent: AgentInstance | null = null;
    /**
     * 唯一收口——幂等、只发一次 done。
     *
     * `done` **无条件 publish**（不挂 lease）：群出向 tap 靠它回群 + 摘掉回群登记，
     * 任务被删掉时同样得让群里那位同事收到一句「这轮没跑成功」、别把登记留给下一轮。
     * error 事件反过来走 lease——任务都删了就别再往盘上写。
     */
    let settled = false;
    const settle = async (ok: boolean, errorText?: string): Promise<void> => {
      if (settled) return;
      settled = true;
      if (errorText) {
        // 内部已吞错（ENOENT / 失主都返 null）
        await writeOwnedEventAndPublish(
          task.id,
          alive,
          {
            kind: "error",
            text: errorText,
          },
          origin,
        );
      }
      // 读快照只为让 done 带上最新 task；读挂了也必须把 done 发出去，
      // 否则群侧登记永久挂死（publish 本身不抛、按 subscriber 逐个吞）
      const fresh = await getTask(task.id).catch(() => null);
      // origin 必带：群出向只 flush runTag 对得上的那条登记——
      // 漏了这个 token，这轮回答就会去 flush 属主的登记（错投），
      // 而同事那条永远等不到自己的 done（群里永久无答）
      publishTaskStreamEvent(task.id, {
        kind: "done",
        task: fresh ?? task,
        ok,
        origin,
      });
    };

    try {
      // 盘上已终态 → worktree 多半已清，起 agent 只会指向不存在的目录
      const repoStatus = await readTaskRepoStatusFresh(task.id);
      if (repoStatus === "merged" || repoStatus === "abandoned") {
        await settle(
          false,
          `群答疑没启动：任务已${repoStatus === "merged" ? "合入" : "放弃"}`,
        );
        return;
      }

      await writeOwnedEventAndPublish(
        task.id,
        alive,
        {
          kind: "info",
          text: "群答疑：正在准备工作区…",
        },
        origin,
      );
      // 纯答疑：只保证 cwd 目录在，跳过依赖拷贝（不挡首包）
      await ensureWorkspaceReady(task, alive, { skipDepClone: true });

      const cwd = getTaskCwd(task);
      await writeOwnedEventAndPublish(
        task.id,
        alive,
        {
          kind: "info",
          text: "群答疑：正在启动只读 agent…",
        },
        origin,
      );
      // 刻意不同步 company-env.json：本通道不注入环境能力声明、也不挂 skill，
      // 群里非属主没有理由拿到公司环境凭据
      if (!alive()) {
        await settle(false, "群答疑已取消");
        return;
      }

      agent = await withSdkDeadline(
        Agent.create({
          apiKey: creds.apiKey,
          model: creds.model,
          // settingSources:[] 同正式会话——不加载 .cursor/、全部 fe 自管注入。
          // 刻意不传 mcpServers：chat-tool（交卷 / 提问 / 提 MR）与用户 MCP 一个都不给。
          local: { cwd, settingSources: [] },
        }),
        SDK_CREATE_RESUME_TIMEOUT_MS,
        "Agent.create(restricted-question)",
      );
      if (!alive()) {
        await settle(false, "群答疑已取消");
        return;
      }

      const prompt = buildRestrictedPrompt({
        taskId: task.id,
        title: task.title,
        cwd,
        askedText: buildReadonlyUserMessage({
          text: input.text,
          imagePaths: input.imagePaths,
          attachmentPaths: input.attachmentPaths,
        }),
      });
      const perf = createRunPerfTracker({
        taskId: task.id,
        agentId: agent.agentId,
        runKind: "question",
        promptBytes: Buffer.byteLength(prompt, "utf-8"),
      });
      const run = await withSdkDeadline(
        agent.send(prompt, {
          onDelta: composeOnDelta(
            perf.onDelta,
            createShellOutputDeltaPublisher(task.id, alive),
            createSdkSummaryDeltaPublisher(task.id, alive),
          ),
          onStep: perf.onStep,
        }),
        SDK_SEND_TIMEOUT_MS,
        "agent.send(restricted-question)",
      );
      perf.attachRun(run);
      record.cancel = () => {
        void run.cancel().catch(() => {
          /* noop */
        });
      };
      if (!alive()) {
        record.cancel();
        await settle(false, "群答疑已取消");
        return;
      }
      console.log(
        `[restricted-question] task=${task.id} 只读答疑 agent 已起 agentId=${agent.agentId}`,
      );

      // 流式消费——只翻译成事件流，不碰 action / runStatus / 会话表
      const assistantCtx: AssistantBufferCtx = {
        buffer: "",
        flush: async () => {
          const trimmed = assistantCtx.buffer.trim();
          assistantCtx.buffer = "";
          if (trimmed.length === 0) return;
          await writeOwnedEventAndPublish(
            task.id,
            alive,
            {
              kind: "assistant_message",
              text: trimmed,
            },
            origin,
          );
        },
      };
      for await (const msg of run.stream()) {
        await handleSdkMessage(task.id, msg, assistantCtx, alive, origin);
      }
      await assistantCtx.flush();

      const result = await run.wait();
      // cancelled 也算「跑过一轮」：说了多少算多少、群里照发（别报成失败吓人）
      if (result.status === "finished" || result.status === "cancelled") {
        await settle(true);
        return;
      }
      throw new Error(`群答疑 run status=${result.status}`);
    } catch (err) {
      if (err instanceof WorktreeLeaseLostError) {
        await settle(false, "群答疑没启动：工作区已被其它任务接管");
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[restricted-question] task=${task.id} 群答疑失败：`, err);
      await settle(false, `群答疑失败：${summarizeRunFailure(message, err).text}`);
    } finally {
      // 兜底：上面任何分支若漏了 settle，群侧登记就永久挂死——这里补最后一次
      await settle(false, "群答疑异常中止");
      try {
        agent?.close();
      } catch {
        /* noop */
      }
      unregisterRestrictedQuestion(task.id, record);
    }
  };

  // fire-and-forget：收口链自身再抛就只能吞了（否则是 unhandled rejection 崩进程）
  void execute().catch((err) => {
    console.error(
      `[restricted-question] task=${task.id} 收口链异常（已吞）：`,
      err,
    );
  });
};
