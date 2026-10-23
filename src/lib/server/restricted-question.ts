/**
 * 需求群「非属主答疑」——独立的旁路通道（提示词讲规矩 + 身份隔离 + 事件流审计，不做执行层限制）
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
 * 5. prompt 由 buildRestrictedPrompt 组装（buildReadonlyUserMessage 打底用户话术 + 任务背景 +
 *    旁路公司环境脱敏声明），「# 边界」段永远排在最后。
 *    工具走两端默认全开（honor-system，内部用）；身份隔离（无 callerToken）+ 提示词 # 边界讲规矩，两边同一套话术。
 *    ⚠️ honor-system = 没有执行层边界：属主 OS 用户能读的凭据（config.json 里的 PAT / apiKey / 公司环境密码、
 *    ~/.ssh 等）它都够得着；pi provider 也只摘 PAT 的环境变量、不阻止读文件，Cursor provider 下连环境变量都摘不掉——
 *    只适合只有可信同事的内部群（详见下面 startRestrictedGroupQuestion 里的注释）。
 *    有 `groupContext` 时再多拼三段上下文（群里有谁 / 任务状态快照 / 群里最近聊天）+ 回复规矩，
 *    段落格式化见 feishu-bridge/group-answer-context.ts；拉取整体硬超时 3 秒、失败降级为空，不拖慢起 agent。
 *    答疑 agent 每个问题都是全新的、没有记忆——这些就是它对「群里刚发生了什么」的全部认知。
 * 6. **本 run publish 的每条 envelope 都带 `origin` = 本轮 runTag**（回群登记 token）。
 *    这是与属主 run 并行时不错投的唯一依据：群出向只把 origin 对得上的 delta / done
 *    投给对应登记。别在这条链上新增「不带 origin 的 publish」。
 *    origin 同时让 `writeOwnedEventAndPublish` 把事件落盘打上 `meta.groupRun`（UI 据此折叠整轮），
 *    所以本 run 写的**每一类**事件（thinking / assistant_message / tool_call / tool_result / info / error）
 *    都必须带 origin——漏一类，那类事件就会漏到属主的主事件流里。
 */

import { Agent, resolveProviderIdForCreate } from "./agent-backend";

import type { ModelSelection } from "@cursor/sdk";

import type { Task } from "@/lib/types";

import { buildReadonlyUserMessage, getPendingAsk } from "./chat-pending";
import {
  buildTaskStateSnapshot,
  formatRecentChatSection,
  formatRosterSection,
} from "./feishu-bridge/group-answer-context";
import { finalizeSideRunBackgroundShells } from "./finalize-open-tools";
import { createRunPerfTracker } from "./run-perf";
import { summarizeRunFailure } from "./sdk-error";
import {
  SDK_CREATE_RESUME_TIMEOUT_MS,
  SDK_SEND_TIMEOUT_MS,
  withSdkDeadline,
} from "./sdk-deadline";
import {
  flushAssistantSegment,
  flushThinkingBuffer,
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
  /**
   * 群上下文（可选）：有它才给答疑 agent 拼「群里都有谁 / 任务状态快照 / 群里最近聊天 / 回复规矩」，
   * 没有（老调用方 / 单测）时 prompt 与旧版完全一致。
   * chatId 缺失的调用方就别传——没有群就无从拉 roster / 历史。
   */
  groupContext?: RestrictedGroupContext;
}

/** 本轮提问所在的群 + 提问人（来自群入向 meta：groupChatId / groupSender* / feishuMessageId） */
export interface RestrictedGroupContext {
  chatId: string;
  requester: { openId: string; name: string; isBot: boolean };
  /** 本轮问题自己的 message_id——最近聊天里要排除它（它已单独放在「# 对方的话」里） */
  questionMessageId?: string;
}

/** 群上下文各段的内容（已格式化的中文行）；某段为空数组 = 该段省略 */
interface GroupPromptSections {
  roster: string[];
  state: string[];
  chat: string[];
  /** `buildGroupReplyRules` 的输出 */
  replyRules: string[];
}

/**
 * 拉群上下文每一项的硬超时。整组是 Promise.all 同时起跑，所以**整体**最多也就等这么久——
 * 上下文是锦上添花，绝不能拖慢起 agent、更不能让答疑起不来。
 */
export const GROUP_CONTEXT_TIMEOUT_MS = 3000;

/** 跑 fn，超时 / 抛错都降级成 fallback；计时器必清（不留悬挂 timer） */
const softTimeout = async <T>(
  fn: () => Promise<T> | T,
  fallback: T,
  ms: number = GROUP_CONTEXT_TIMEOUT_MS,
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve()
        .then(fn)
        .catch(() => fallback),
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

/** 只在第一次调用时才真 import，之后复用同一个 promise */
const lazyImport = <T>(load: () => Promise<T>): (() => Promise<T>) => {
  let p: Promise<T> | undefined;
  return () => (p ??= load());
};

/**
 * 并行拉 roster / 最近聊天 / 属主身份 / 自己的身份 / 出问登记 / 排队数，格式化成 prompt 各段。
 *
 * 契约：**永不抛错、整体最多等 {@link GROUP_CONTEXT_TIMEOUT_MS}**；任何一项拿不到只是那一段变少。
 * feishu-bridge 的模块一律动态 import——restricted-question 是 task 链的基础模块，
 * 不让它在加载期静态连上飞书桥（避免成环，也不拖累与群无关的调用方 / 单测）。
 */
const loadGroupPromptSections = async (
  task: Task,
  gc: RestrictedGroupContext,
): Promise<GroupPromptSections> => {
  // 每个模块只 import 一次、各项共用同一个 promise（别让并行的 8 项各自重复动态 import 同一模块）
  const rosterMod = lazyImport(() => import("./feishu-bridge/group-roster"));
  const larkMod = lazyImport(() => import("./feishu-bridge/lark-api"));
  const [roster, history, identity, selfOpenId, selfName, waiting, queued, rules] =
    await Promise.all([
      softTimeout(async () => (await rosterMod()).fetchGroupRoster(gc.chatId), null),
      softTimeout(
        async () => (await rosterMod()).fetchRecentGroupMessages(gc.chatId, 15),
        [],
      ),
      softTimeout(async () => (await larkMod()).getLarkLocalIdentity(), null),
      softTimeout(async () => (await larkMod()).getBotOpenId(), null),
      softTimeout(async () => (await larkMod()).getBotDisplayName(), null),
      // 任务此刻在等群里谁回话（出问登记）；名字先用 roster / learned 查，查不到下面再兜底
      softTimeout(async () => {
        const reg = await import("./feishu-bridge/group-outbound-registry");
        const lookup = (await rosterMod()).lookupGroupMemberName;
        return reg
          .listLiveOutboundQuestions(task.id)
          .filter((e) => !e.chatId || e.chatId === gc.chatId)
          .map((e) => ({
            target: e.target,
            name: lookup(gc.chatId, e.target) ?? "",
            about: e.about,
            expiresAt: e.createdAt + e.ttlMs,
          }));
      }, []),
      softTimeout(async () => {
        const m = await import("./feishu-bridge/group-shared");
        return m.groupQuestionQueueLength(task.id);
      }, 0),
      softTimeout(async () => {
        const m = await import("./feishu-bridge/group-reply-protocol");
        return m.buildGroupReplyRules({ requesterIsBot: gc.requester.isBot });
      }, [] as string[]),
    ]);

  const members = roster?.members ?? [];
  const nameOf = (openId: string): string | undefined =>
    members.find((m) => m.openId === openId)?.name || undefined;

  // 属主 = 本机登录的飞书用户；名字 CLI 没给就用 roster 里的
  const ownerName = identity?.userName || (identity ? nameOf(identity.openId) : "");
  const owner =
    identity && ownerName
      ? { openId: identity.openId, name: ownerName }
      : undefined;

  // 当前正在等的那条提问：内存里的 pendingAsk，不读盘（events.jsonl 动辄上万行）
  const pendingAsk = getPendingAsk(task.id);
  const pendingAskText = pendingAsk
    ? pendingAsk.questions.map((q) => q.question).join("；")
    : undefined;

  return {
    roster: formatRosterSection({
      members,
      selfOpenId: selfOpenId ?? undefined,
      selfName: selfName ?? undefined,
      owner,
      requester: gc.requester,
    }),
    state: buildTaskStateSnapshot(task, {
      pendingAskText,
      waitingFor: waiting.map((w) => ({
        // 名字 roster 里也查不到就退回 id，至少让 agent 知道「在等某个具体对象」
        name: w.name || nameOf(w.target) || w.target,
        about: w.about,
        expiresAt: w.expiresAt,
      })),
      queuedGroupQuestions: queued,
      ownerName: owner?.name,
    }),
    chat: formatRecentChatSection(history, {
      excludeMessageId: gc.questionMessageId,
      resolveName: nameOf,
      selfOpenId: selfOpenId ?? undefined,
      selfName: selfName ?? undefined,
    }),
    replyRules: rules,
  };
};

/**
 * 受限 prompt（纯函数、好读好审）。
 *
 * 旁路政策（极简两行）：三条红线，工具默认全开，规矩只写提示词。线上分支以设置页配置为准。
 * 版式上「# 边界」**必须是最后一段**——模型对末段指令最敏感。
 * `tests/restricted-group-question.test.ts` 钉住这条版式。
 */
const buildRestrictedPrompt = (args: {
  taskId: string;
  title: string;
  cwd: string;
  askedText: string;
  /** 公司环境声明（无配置时为空串）；查数据用，不含任何密码 */
  companyEnvSection?: string;
  /** 群上下文各段；缺省 = 旧版 prompt（老调用方 / 单测） */
  groupSections?: GroupPromptSections;
}): string => {
  const g = args.groupSections;
  const section = (heading: string, body: string[]): string[] =>
    body.length > 0 ? [heading, ...body, ""] : [];
  return [
    g
      ? `你是任务「${args.title}」的宿主（任务属主）在需求群里的分身，群里一位非任务所有者说了句话，你只负责回答。`
      : `你是任务「${args.title}」的答疑助手。需求群里一位非任务所有者说了句话、你只负责回答。`,
    "",
    // 群上下文三段（顺序：谁在群里 → 任务现状 → 刚聊了什么）；缺的段整段省略
    ...(g
      ? [
          ...section("# 你是谁、群里有谁", g.roster),
          ...section(
            "# 任务当前状态（快照；要细节再去读下面的文件）",
            g.state,
          ),
          ...section("# 群里最近的聊天（旧→新）", g.chat),
        ]
      : []),
    "# 任务背景（按需查、先查再答）",
    `- 任务事件日志（完整历史）：${getEventsLogPath(args.taskId)}`,
    `- 产出文档目录（方案 / 实现 / 复核等 artifact）：${getActionsDir(args.taskId)}`,
    `- 工作目录：${args.cwd}`,
    ...(args.companyEnvSection?.trim()
      ? ["", args.companyEnvSection.trim()]
      : []),
    "",
    "# 对方的话",
    args.askedText,
    "",
    // 回复协议（NO_REPLY / @ 规则 / 需属主确认标记）；排在「边界」之前——边界必须是最后一段
    ...(g ? section("# 回复规矩", g.replyRules) : []),
    "# 边界",
    "- 非属主答疑，三条红线：不改任何文件；部署、发布、上线与线上分支先找属主确认；其余都可以干",
    "- 答完自然结束回复",
    ...(g
      ? [
          "- 需要属主拍板的事不要替他答应，用「回复规矩」里的「需属主确认」标记转给他",
        ]
      : []),
  ].join("\n");
};

/**
 * 起一个旁路答疑 agent 回答群里非属主的一句话（提示词讲规矩 + 身份隔离 + 事件流审计）。
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

      // 任务绑定的自定义提供方已被删除：直接拒（不起 agent、不准备工作区），不静默落回 Cursor——
      // 群里的上下文 / 代码会跟着出域（第四轮 Q2-02）。原因经 settle 落成 error 事件 + done(ok=false)，群里会收到「没跑成功」
      let bypassProviderId: string;
      try {
        bypassProviderId = await resolveProviderIdForCreate(task);
      } catch (err) {
        await settle(
          false,
          `群答疑没启动：${err instanceof Error ? err.message : String(err)}`,
        );
        return;
      }

      // 群上下文（roster / 最近聊天 / 身份）与准备工作区 / 建会话**并行**拉：整体硬超时 3 秒、
      // 失败降级为空、永不抛错——不拖慢起 agent。没有 groupContext 的老调用方不拉
      const groupSectionsPromise: Promise<GroupPromptSections | undefined> =
        input.groupContext
          ? loadGroupPromptSections(task, input.groupContext).catch(
              () => undefined,
            )
          : Promise.resolve(undefined);
      await writeOwnedEventAndPublish(
        task.id,
        alive,
        {
          kind: "info",
          text: "群答疑：正在准备工作区…",
          meta: { subkind: "boot" },
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
          text: "群答疑：正在启动答疑 agent…",
        },
        origin,
      );
      // 旁路 honor-system（内部用，防君子不防小人）：工具走两端默认全开，不接执行层白名单；
      // 公司环境同样全量同步——含密码的 company-env.json 会进旁路上下文，事件流和模型厂商都看得到，
      // 这是“全开”必须付的代价。唯一保留的是身份隔离：不传 callerToken，
      // submit_work / submit_mr 等系统工具无身份可用（否则旁路能关掉属主的 action，这是正确性问题，
      // 不是安全选项）；ask_user 同样不可用（群里没人能答它的提问）。审计靠事件流。
      //
      // ⚠️ 「全开」的代价不止公司环境密码（N3-01，老实写清楚，别误以为这里有边界）：
      // 旁路 agent 以属主的 OS 用户身份跑工具全开的 shell / read，凡属主能读的它都够得着——
      //   - config.json：GitLab PAT（gitToken）、Cursor / 自定义 provider 的 apiKey、公司环境密码；
      //   - GitLab PAT 的环境变量 FLOWSHIP_GITLAB_TOKEN：pi provider 下环境变量已摘掉（下面 omitGitToken；
      //     只摘变量、不阻止读文件——pi 的 read 照样能读上面的 config.json），
      //     **Cursor provider 下摘不掉**——SDK 的本地 agent shell 原样继承 server 的 process.env，
      //     没有 env 选项，又不能临时删进程全局 env（会把属主并行会话弄坏）；群里任何能 @ 机器人的人
      //     让它 `printenv` 就能拿到 PAT；
      //   - ~/.ssh、~/.aws、浏览器 / 其它工具的凭据文件等一切属主 OS 用户能读的东西。
      // omitGitToken 只是收掉「最显眼」的一条路、不是边界；config.json 之类照样读得到。
      // Cursor 默认路径的这条无身份旁路沿用同一局限；已拍板**不**用 `disallowedTools` / `local.customTools`
      // 换掉内置 shell（Cursor 的 read 同样能读 config.json、没形成真边界；换 shell 还会影响工具块展示、有回归风险），
      // 详见 git-token-env.ts 头部。
      // 所以**旁路只适合只有可信同事的内部群**；把机器人拉进有外部人员 / 不可信成员的群 = 把属主的凭据交出去。
      const { syncCompanyEnvFileFromSettings, loadCompanyEnvBriefSection } =
        await import("./company-env-fs");
      await syncCompanyEnvFileFromSettings();
      const companyEnvSection = await loadCompanyEnvBriefSection();
      if (!alive()) {
        await settle(false, "群答疑已取消");
        return;
      }

      agent = await withSdkDeadline(
        Agent.create({
          apiKey: creds.apiKey,
          model: creds.model,
          // 自定义 provider（opencode 等）必须带上，否则 facade 按默认 cursor 建、拿自定义 key 去调 Cursor 会 401
          providerId: bypassProviderId,
          // 旁路不做执行层限制：两端都走默认全开工具集（Cursor 标准工具集 / pi 全量编码工具），
          // 规矩只写在提示词 # 边界里。身份照旧隔离（见上），审计靠事件流。
          // 有 task 上下文：read 超 64KB 照样落盘给路径
          taskId: task.id,
          // settingSources:[] 同正式会话——不加载 .cursor/、全部 fe 自管注入。
          // 不传 callerToken：系统工具（交卷 / 提问 / 提 MR）按无身份处理，推进本来就走不了任务链。
          local: { cwd, settingSources: [] },
          // pi provider：shell 与子代理 bash 摘掉 FLOWSHIP_GITLAB_TOKEN（N3-01）。必须显式传、
          // 不能靠「无 callerToken」推断——属主 one-shot 同样无 callerToken、却该保留 token。
          // 只摘环境变量、不阻止读文件；Cursor provider 下是空操作（SDK 继承 server env、摘不掉，见上方注释与 git-token-env.ts）。
          // tests/restricted-group-question.test.ts 钉住这里必须传 true。
          omitGitToken: true,
        }),
        SDK_CREATE_RESUME_TIMEOUT_MS,
        "Agent.create(restricted-question)",
      );
      if (!alive()) {
        await settle(false, "群答疑已取消");
        return;
      }

      // 群上下文早在 Agent.create 之前就已并行起跑——这里只是收结果（最多再等到 3 秒硬超时那一刻）
      const groupSections = await groupSectionsPromise;
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
        companyEnvSection,
        groupSections,
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
            createSdkSummaryDeltaPublisher(task.id, alive, origin),
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
        `[restricted-question] task=${task.id} 群答疑 agent 已起 agentId=${agent.agentId}`,
      );

      // 流式消费——只翻译成事件流，不碰 action / runStatus / 会话表
      const assistantCtx: AssistantBufferCtx = {
        buffer: "",
        // 统一结算；带 origin = 旁路答疑：不碰属主主链的实时快照（见 flushAssistantSegment）
        flush: () => flushAssistantSegment(task.id, assistantCtx, alive, origin),
      };
      for await (const msg of run.stream()) {
        await handleSdkMessage(task.id, msg, assistantCtx, alive, origin);
      }
      await flushThinkingBuffer(
        task.id,
        assistantCtx,
        alive,
        origin,
      );
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
      // 这一轮旁路 run 起的后台 shell 在此收尾（停追踪 + 补 ended）：旁路 run 没有属主 run 的 finalize，
      // 不收的话追踪会轮询到进程退出、「群问答」里的转圈也永远不停。fire-and-forget、内部吞错。
      void finalizeSideRunBackgroundShells(task.id, origin, alive);
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
