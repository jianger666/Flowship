/**
 * task 模式用户消息注入（从 /api/tasks/[id]/question route 抽出）
 *
 * 与 chat-inject 同款分工：HTTP 路由（任务页输入条）与飞书桥接（需求群回流）
 * 共用同一套逻辑、保证行为零漂移；route 只剩薄壳。
 *
 * V0.13.x 用户拍板「别这么多分支」：原「再聊聊（revise）/ 问一问（question）」两条通道
 * 合一——任何输入条消息都走这里、`agent.send([USER_MESSAGE]…)`、AI 自主二分类
 *（疑问就答 / 要改就改）。服务端只做状态机内务：
 * - 当前产出在等审阅（awaiting_ack）→ 先 snapshot artifact 版本、消息附「处理完重新交卷」
 *   上下文、action 回 running（原 revise 的状态机语义、对 AI 是同一条消息模板）
 * - 其他时刻 → 插话语义（不推进任务链）、回答完 consumeSessionRun 按最后 action 状态归位
 *
 * 传输分流（对用户透明）：会话活着 send；会话断 + action 停半路（含 awaiting_ack）唤醒
 * 新 agent 原地续（显式换模型用新模型跑）；会话断 + 已完结起一次性临时 agent。
 *
 * `userReplyMetaExtra` 供桥接写入 `meta.source: "feishu_group"` 等标记；
 * `restrictToQuestion` 供需求群回流把**非属主**的消息锁进只答疑通道（见选项注释）。
 *
 * 有未答提问时发消息 = **隐式跳过**那组提问（`ask-skip`）：入口同步认领、送达后提交
 *（作废事件 + 飞书卡片终态）、没送出去回滚。发给 agent 的正文前面会多一句跳过上下文。
 */

import {
  getTask,
  patchActionAndRunStatusIfOpFresh,
  setTaskRunStatusIfRunOwner,
} from "@/lib/server/task-fs";
import {
  saveImageAttachments,
  snapshotActionArtifact,
} from "@/lib/server/task-artifacts";
import { beginAskSkip, type AskSkipHandle } from "@/lib/server/ask-skip";
import { startRestrictedGroupQuestion } from "@/lib/server/restricted-question";
import {
  deliverTaskQuestion,
  isTaskOpStale,
  resumeCurrentActionWithMessage,
  startOneShotQuestion,
  TASK_OP_STALE_HTTP_MESSAGE,
} from "@/lib/server/task-runner";
import {
  agentSessions,
  getTaskOpGeneration,
  PERSIST_FAIL_RETRY_MESSAGE,
  PERSIST_WARNING_DELIVERED,
  publishTaskStreamEvent,
  runningTasks,
  waitForTaskToStop,
  writeEventAndPublish,
  writeUserEventAndPublishStrict,
} from "@/lib/server/task-stream";
import { getChatLifecycle } from "@/lib/server/chat-gate";
import { buildSkillDirective } from "@/lib/protocol-signals";
import {
  errorResponse,
  parseAndValidateAttachments,
  parseAndValidateImages,
  parseAndValidateSkills,
} from "@/lib/server/route-helpers";

export interface TaskQuestionBody {
  text?: string;
  images?: Array<{ data?: string; mimeType?: string; filename?: string }>;
  /** 文件 / 目录绝对路径（原生 picker 选的、v1.1.x 任务输入条也能附） */
  attachments?: string[];
  /** skill 引用：指引只进 agent、不进 user_reply 气泡 */
  skills?: Array<{ name?: string; absPath?: string }>;
  bootArgs?: {
    apiKey?: string;
    model?: { id?: string; params?: Array<{ id: string; value: string }> };
    gitToken?: string;
  };
  /**
   * 用户显式选的模型：传了 = 不续会话（会话模型锁死换不了）、
   * 走唤醒（新 agent 用新模型跑）或一次性临时 agent。
   */
  forceModel?: { id?: string; params?: Array<{ id: string; value: string }> };
}

export interface TaskQuestionInjectOptions {
  /** 合并进 user_reply.meta（如需求群来源标记 / 提问人姓名） */
  userReplyMetaExtra?: Record<string, unknown>;
  /**
   * 只答疑模式：需求群里**非任务所有者**发来的消息走这条（写操作只允许本人）。
   * 四处硬拦，不靠 prompt 自觉：
   * - **绝不复用活会话**：活着的 agent 带完整 playbook + chat-tool MCP + 文件 / shell
   *   权限，`agent.send` 进去等于把全权限交给群里任何人（action 刚跑完 awaiting_ack
   *   时会话常在，恰好也是播报刚发群、同事最可能回话的时刻）
   * - 不带 ackContext：不 snapshot 产物、不把 awaiting_ack 的 action 打回 running
   *   （即不触发原 revise 语义的「改完重新交卷」）
   * - **绝不**唤醒（resume）当前 action 的全权限 agent
   * - 一律落到 `restricted-question.startRestrictedGroupQuestion` 这条**旁路**：只读
   *   prompt（禁改文件 / 禁副作用命令、不给一句放行措辞）、且与 task 运行状态机完全
   *   解耦——不写 runStatus、不占 runningTasks、不动 action，因此能与属主的活会话
   *   并行跑，也不会让顶栏「停止」键冒出来误伤审阅中的产物
   * 代价是不复用会话上下文——与「会话已断」那条路径同款语义（旁路 agent 会读任务历史）。
   * 属主本人不设限——他在群里和在 app 输入条里是同一个人。
   */
  restrictToQuestion?: boolean;
  /**
   * 只答疑模式下这轮回群登记的 token（群入向 `rememberGroupReply` 给的 runTag）。
   * 原样透传给旁路 run 当事件 `origin`——群出向据此只把这段回答投给这条登记。
   * 不传也能跑（旁路自生成一次性 token），但那样这轮回答就找不到登记、回不了群。
   */
  restrictedRunTag?: string;
}

const MAX_IMAGES = 6;
const MAX_ATTACHMENTS = 10;
// skill 上限走 protocol-signals 的 MAX_SKILL_REFS（客户端截断同源）——见 parseAndValidateSkills 默认值

/**
 * 注入一条 task 模式用户消息。返回值形态与原 question HTTP 响应一致（route 原样透传）。
 *
 * 外层只做一件事：**没送出去就把跳过认领放回**。内部有十几个 4xx / 5xx 出口，
 * 逐个补回滚必漏——统一收在这里（commit 是幂等的，已提交时 rollback 自动 no-op）。
 */
export const handleTaskQuestionInject = async (
  id: string,
  rawBody: unknown,
  options: TaskQuestionInjectOptions = {},
): Promise<Response> => {
  // 认领句柄由内部创建、外层只负责兜底回滚（用容器传出来，避免把 return 值搞复杂）
  const skipRef: { handle: AskSkipHandle | null } = { handle: null };
  try {
    return await runTaskQuestionInject(id, rawBody, options, skipRef);
  } finally {
    skipRef.handle?.rollback();
  }
};

const runTaskQuestionInject = async (
  id: string,
  rawBody: unknown,
  options: TaskQuestionInjectOptions,
  skipRef: { handle: AskSkipHandle | null },
): Promise<Response> => {
  const body = (rawBody ?? {}) as TaskQuestionBody;
  // 只答疑（群里非属主）：下面三处按它剪掉写路径——活会话送达 / ackContext / resume 唤醒
  const questionOnly = options.restrictToQuestion === true;

  const text = (body.text ?? "").trim();
  const imagesResult = parseAndValidateImages(body.images, MAX_IMAGES);
  if (!imagesResult.ok) return imagesResult.errorResponse;
  const images = imagesResult.images;
  const attachResult = await parseAndValidateAttachments(
    body.attachments,
    MAX_ATTACHMENTS,
  );
  if (!attachResult.ok) return attachResult.errorResponse;
  const attachmentPaths = attachResult.paths;
  const skillsResult = parseAndValidateSkills(body.skills);
  if (!skillsResult.ok) return skillsResult.errorResponse;
  const skills = skillsResult.skills;
  if (!text && images.length === 0 && attachmentPaths.length === 0) {
    return errorResponse("text / images / attachments 至少一项非空");
  }

  let task = await getTask(id);
  if (!task) return errorResponse("not_found", 404);

  // lifecycle 非 null（stopping/deleting/finalizing）一律拒发送 / 唤醒
  {
    const life = getChatLifecycle(id);
    if (life !== null) {
      const msg =
        life === "deleting"
          ? "任务正在删除"
          : life === "finalizing"
            ? "正在终结、请稍后再试"
            : "正在停止、请稍后再试";
      return errorResponse(msg, 409);
    }
  }

  // 读完 task + lifecycle 闸后立刻同步取 admission——其后有存图 / 等 drain /
  // supersede 等长 await，再取会被 stop bump 后的新值冒充新意图
  const opGen = getTaskOpGeneration(task.id);

  if (task.mode === "chat") {
    return errorResponse("chat 对话直接在输入框发消息即可", 409);
  }
  // 有 pendingAsk 也不硬拦输入条：用户可绕过答题卡直接说话，那组提问按「隐式跳过」
  // 收口（见下方 beginAskSkip）。旧逻辑「先回答上方提问」在网断 / 会话死后把输入条
  // 和答题卡对锁——只能重新推进（同事反馈）。

  // run 还在跑：真·干活中 → 409；已交卷（awaiting_ack）但收尾旁白未完 → 等收敛再发。
  // 窗口期：submit_work 后 action 已 awaiting_ack、UI 放开输入框，但 runningTasks /
  // runStatus 仍真几秒~几十秒——用户一说话必撞旧 409。
  if (runningTasks.has(task.id) || task.runStatus === "running") {
    const currentActionId = task.currentActionId;
    const currentWhileRunning = task.actions.find(
      (a) => a.id === currentActionId,
    );
    if (currentWhileRunning?.status === "awaiting_ack") {
      const stopped = await waitForTaskToStop(task.id, 20_000);
      if (!stopped) {
        return errorResponse("agent 正在跑、等它说完这轮再问", 409);
      }
      const fresh = await getTask(id);
      if (!fresh) return errorResponse("not_found", 404);
      // 等待期间用户可能点了「推进」起了新 action / 新 run：
      // 世界已变、这条消息的语境失效——再校验一次、不满足就让用户重发
      const freshCurrent = fresh.actions.find(
        (a) => a.id === fresh.currentActionId,
      );
      if (
        runningTasks.has(fresh.id) ||
        fresh.runStatus === "running" ||
        freshCurrent?.id !== currentActionId ||
        freshCurrent?.status !== "awaiting_ack"
      ) {
        return errorResponse("任务状态刚变化（可能已推进）、请重新发送", 409);
      }
      task = fresh;
    } else {
      return errorResponse("agent 正在跑、等它说完这轮再问", 409);
    }
  }

  // 图先落盘（给 agent read 的绝对路径 + 事件缩略图 meta）
  let imageAbsPaths: string[] | undefined;
  let savedImages: Awaited<ReturnType<typeof saveImageAttachments>> | undefined;
  if (images.length > 0) {
    try {
      savedImages = await saveImageAttachments(task.id, images);
      imageAbsPaths = savedImages.map((s) => s.absPath);
    } catch (err) {
      return errorResponse(
        `图片处理失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // 长 await（存图）后复查——stop 期间不得继续 fallback / 写 running
  if (isTaskOpStale(task.id, opGen)) {
    return errorResponse(TASK_OP_STALE_HTTP_MESSAGE, 409);
  }

  const apiKey = body.bootArgs?.apiKey?.trim() || undefined;
  const model =
    body.bootArgs?.model && typeof body.bootArgs.model.id === "string"
      ? { id: body.bootArgs.model.id, params: body.bootArgs.model.params }
      : undefined;
  const forceModel =
    body.forceModel && typeof body.forceModel.id === "string"
      ? { id: body.forceModel.id, params: body.forceModel.params }
      : undefined;
  const fallbackModel = forceModel ?? model;

  // 审查发现：awaiting_ack 时先 snapshot、再因缺 bootArgs 400 → 审阅产物版本被白白污染。
  // 校验提到 snapshot 前：能送达（内存有会话且未 forceModel）或有唤醒凭据；不过直接 400。
  // questionOnly 恒不送达（见选项注释）→ 必须有起一次性 agent 的凭据，否则这里就 400。
  const canDeliver = !questionOnly && !forceModel && agentSessions.has(task.id);
  const hasWakeCreds = !!apiKey && !!fallbackModel;
  if (!canDeliver && !hasWakeCreds) {
    return errorResponse("缺 bootArgs（apiKey / model）、agent 起不来", 400);
  }

  // 当前产出在等审阅（awaiting_ack）= 原「再聊聊」场景：先 snapshot artifact 版本
  //（用户可能要求改、保留改前版本）、消息附「处理完重新交卷」上下文。
  // questionOnly 直接当没有 ack 上下文——非属主的一句话不该改产物、更不该重交卷
  const ackAction = questionOnly
    ? undefined
    : task.actions.find(
        (a) => a.id === task.currentActionId && a.status === "awaiting_ack",
      );
  const ackContext = ackAction
    ? { actionId: ackAction.id, artifactPath: ackAction.artifactPath ?? undefined }
    : undefined;
  if (ackAction?.artifactPath) {
    await snapshotActionArtifact(task.id, ackAction.id).catch((err) => {
      console.warn(
        `[question] snapshotActionArtifact 失败 task=${task.id}（吞错继续）：`,
        err,
      );
    });
  }

  // snapshot 长 await 后再查
  if (isTaskOpStale(task.id, opGen)) {
    return errorResponse(TASK_OP_STALE_HTTP_MESSAGE, 409);
  }

  // 有待答提问时用户直接说话 = **隐式跳过**这组提问。
  // 认领必须同步、且赶在下面任何 await 之前——它是与「答题」互斥的那一步
  //（谁先摘到 pendingAsk 谁说了算，见 ask-skip 文件头）。
  // 群里**非属主**的消息不给跳过资格：属主的提问不该被别人一句话作废。
  const askSkip = questionOnly ? null : beginAskSkip(task);
  if (askSkip?.claimed) skipRef.handle = askSkip;
  // 事件用用户原文；发给 agent 的带跳过上下文 + skill 指引（三条分流共用）
  const agentText =
    (askSkip?.hint ?? "") + buildSkillDirective(skills) + text;

  // 用户显式选了模型 → 不续会话（会话模型锁死换不了）；
  // questionOnly（群里非属主）→ 同样不碰活会话：那是属主的全权限 agent（见选项注释）；
  // 否则先送达存活会话（同 ask-reply 顺序约定：送不到不写事件、防假已发）、接不回走下面分流
  // 两种「不送达」都视为无会话续接意图（走下方分流），不是 stale
  const deliverResult =
    forceModel || questionOnly
      ? ("no_session" as const)
      : await deliverTaskQuestion(
          task,
          agentText,
          imageAbsPaths,
          { apiKey, model },
          ackContext,
          attachmentPaths.length > 0 ? attachmentPaths : undefined,
          opGen,
        );

  // stale → 409，绝不 fallback one-shot、不写事件、不写 running
  if (deliverResult === "stale" || isTaskOpStale(task.id, opGen)) {
    return errorResponse(TASK_OP_STALE_HTTP_MESSAGE, 409);
  }
  const sent = deliverResult === "sent";

  // 会话接不回时的分流（V0.11.9 用户拍板「输入条覆盖旧重启、不多一条 action 链」）：
  // - 当前 action 停在半路（error / cancelled / 僵死 running）→ **唤醒模式**：
  //   起新 agent 原地续同一个 action、用户消息当最新指示。
  //   V0.13.x 修：显式换模型**不再**排除唤醒——唤醒起的本来就是新 agent、直接用新模型跑。
  //   （用户实测踩坑：停掉 fable5 换 grok 说「帮我删掉单测」、被锁进只读答疑 agent、
  //   AI 反复回「我在答疑模式动不了文件」——用户换模型的意图是换个模型继续干活、不是问问题）
  // - 其他（action 已完结 / 没 action）→ 一次性 agent（属主：疑问就答、小改动可动手）
  // questionOnly 不给唤醒：那会起一个能改代码 / 能交卷的新 agent，
  // 非属主的消息只配落到下面那条只读旁路（restricted-question）
  const currentAction = task.actions.find((a) => a.id === task.currentActionId);
  const canResume =
    !questionOnly &&
    !sent &&
    !!currentAction &&
    (currentAction.status === "error" ||
      currentAction.status === "cancelled" ||
      currentAction.status === "running" ||
      // awaiting_ack + 会话断（或显式换模型）：唤醒新 agent 处理这条意见并重新交卷
      currentAction.status === "awaiting_ack");
  const useOneShot = !sent && !canResume;
  // 前置校验已拦「无会话且无凭据」；这里兜底会话在校验后死去的 race
  if (!sent && (!apiKey || !fallbackModel)) {
    return errorResponse("缺 bootArgs（apiKey / model）、agent 起不来", 400);
  }

  console.log(
    `[question] task=${task.id} text=${text.slice(0, 60)} images=${images.length} mode=${sent ? "send" : canResume ? "resume" : "oneshot"}`,
  );

  // 写事件 / supersede / 置 running 前最后复查（含 useOneShot 窗口）
  if (isTaskOpStale(task.id, opGen)) {
    return errorResponse(TASK_OP_STALE_HTTP_MESSAGE, 409);
  }

  // 用户绕开答题卡直接在输入条说话 = 那组提问就此跳过（send：agent 收到新消息就继续了；
  // oneshot：旧会话已死、答案永远送不到）。不落跳过标记的话卡片永远挂着（用户实测：
  // 答题卡 + 顶部「AI 在等你回答」悬浮条一直在、推进按钮还被按住）。
  // 提交点紧贴真实副作用：**确认送达之后**才写事件 / 置飞书卡片终态。
  // send 前（oneshot）须等用户原文落盘成功再提交；canResume 在下面它自己的分支里提交
  if (sent) {
    await askSkip?.commit();
  }

  // commit 是 await——后再查一次再写「已送达」事件
  if (isTaskOpStale(task.id, opGen)) {
    return errorResponse(TASK_OP_STALE_HTTP_MESSAGE, 409);
  }

  // 用户原文 strict 落盘
  // - sent（send 后）：失败 → 200 + persistWarning，不伪装未发送
  // - !sent（resume/oneshot、start 前）：失败 → 5xx、不继续、不清 pending
  let persistWarning: string | undefined;
  try {
    const wrote = await writeUserEventAndPublishStrict(task.id, {
      kind: "user_reply",
      actionId: task.currentActionId ?? undefined,
      text: text || "(用户附了图片 / 文件提问)",
      meta: {
        kind: "question",
        ...(savedImages && savedImages.length > 0 ? { images: savedImages } : {}),
        // 前端 extractUserReplyAttachments 读 meta.attachments（对象数组）渲染路径 chips
        ...(attachmentPaths.length > 0
          ? { attachments: attachResult.metas }
          : {}),
        // 桥接来源标记（需求群回流带 source / 提问人）——放最后、允许覆盖上面的展示字段
        ...(options.userReplyMetaExtra ?? {}),
      },
    });
    if (!wrote) {
      if (sent) {
        persistWarning = PERSIST_WARNING_DELIVERED;
        console.error(
          `[question] 已送达但持久化失败（ENOENT/未写）task=${task.id}`,
        );
      } else {
        return errorResponse("not_found", 404);
      }
    }
  } catch (persistErr) {
    if (sent) {
      console.error(
        `[question] 已送达但持久化失败 task=${task.id}:`,
        persistErr,
      );
      persistWarning = PERSIST_WARNING_DELIVERED;
    } else {
      console.error(
        `[question] start 前落盘失败 task=${task.id}:`,
        persistErr,
      );
      return errorResponse(PERSIST_FAIL_RETRY_MESSAGE, 500);
    }
  }

  // oneshot：落盘成功后再落跳过（失败路径不得提交、登记要能放回）
  if (!sent && useOneShot) {
    await askSkip?.commit();
  }

  // send 成功且产出在等审阅：action 回 running（agent 处理完会重新交卷回 awaiting_ack）——
  // 原 revise 的状态机语义、防「artifact 在改、UI 还显示等审阅」
  if (sent && ackContext) {
    // 锁内 op-fresh + 结构条件事务——一次写 action+runStatus，杜绝
    //「patchAction await → stop 写 idle → setTaskRunStatus 又盖回 running」；
    // 并挡同 epoch 并发 advance（不 bump gen）已把 A 标 completed / current 推到 B 后旧 Q 抢回。
    const running = await patchActionAndRunStatusIfOpFresh(
      task.id,
      ackContext.actionId,
      "running",
      "running",
      () => !isTaskOpStale(task.id, opGen),
      {
        // ack 入场时的指针与状态；advance 自动通过后二者都会变
        currentActionId: ackContext.actionId,
        actionStatus: "awaiting_ack",
      },
    );
    if (running) {
      publishTaskStreamEvent(task.id, { kind: "task", task: running });
      const a = running.actions.find((x) => x.id === ackContext.actionId);
      if (a) publishTaskStreamEvent(task.id, { kind: "action", action: a });
    }
    // 返 null = 已 stale（stop 已接管）——消息已送达 run，task 状态归 stop；仍 200
    const fresh = await getTask(task.id);
    return new Response(
      JSON.stringify({
        ok: true,
        task: fresh ?? task,
        ...(persistWarning ? { persistWarning } : {}),
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  // send 成功且无需改 ack 状态——直接 200（勿落入下方 one-shot 写 running）
  if (sent) {
    const fresh = await getTask(task.id);
    return new Response(
      JSON.stringify({
        ok: true,
        task: fresh ?? task,
        ...(persistWarning ? { persistWarning } : {}),
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  if (canResume) {
    if (isTaskOpStale(task.id, opGen)) {
      return errorResponse(TASK_OP_STALE_HTTP_MESSAGE, 409);
    }
    // 唤醒也是「消息已被受理」——先落跳过标记再起新 agent。
    // 顺序不能反：resumeCurrentActionWithMessage 内部会 supersedePendingAsks，
    // 它先跑就把这条 ask 标成中性「失效」了，UI 里显示的就不是「已跳过」；
    // 而它拿回的「未答问题」还会让新 agent 断点续传原样重问——正是用户要跳过的那组
    await askSkip?.commit();
    // 受理即可见：唤醒 fire-and-forget 前先落进度，避免「接口 200 后长时间无动静」
    await writeEventAndPublish(task.id, {
      kind: "info",
      actionId: task.currentActionId ?? undefined,
      text: "正在唤醒当前阶段…",
    });
    // 唤醒模式自己管状态（patch action running + runStatus + 事件）；失败标 error 有内部兜底
    void resumeCurrentActionWithMessage({
      task,
      userMessage: agentText,
      imagePaths: imageAbsPaths,
      attachmentPaths: attachmentPaths.length > 0 ? attachmentPaths : undefined,
      apiKey: apiKey!,
      fallbackModel: fallbackModel!,
      // 用户显式换的模型：唤醒的新 agent 直接用它跑（V0.13.x、不再锁进只读答疑）
      forceModel,
      gitToken: body.bootArgs?.gitToken?.trim() || undefined,
      opGen,
    }).catch(async (err) => {
      console.error(`[question] task=${task.id} 唤醒当前 action 失败：`, err);
      // 唤醒失败审计事件写+publish 同链（best-effort 吞错）
      await writeEventAndPublish(task.id, {
        kind: "error",
        text: `唤醒当前阶段失败：${err instanceof Error ? err.message : String(err)}`,
      });
    });
    const fresh = await getTask(task.id);
    return new Response(JSON.stringify({ ok: true, task: fresh ?? task }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  // 受限答疑（群里非属主）与 task 运行状态机**完全解耦**、单独一条旁路：
  // 不写 runStatus、不占 runningTasks、不进 action 状态机（见 restricted-question.ts 文件头）。
  // questionOnly 走到这里必然是 one-shot 分支（上面 sent / canResume 都恒 false）。
  //
  // 仍留一道入场 stale 闸：stop / DELETE 在飞时别再起 agent（这是**准入**、不是运行态耦合）；
  // 409 让群入向按 token 回滚回群登记并回一句失败，比起了个跑在删除中目录里的 agent 好。
  if (questionOnly) {
    if (isTaskOpStale(task.id, opGen)) {
      return errorResponse(TASK_OP_STALE_HTTP_MESSAGE, 409);
    }
    // 受理即可见：fire-and-forget 前先落进度，避免「接口 200 后长时间无动静」
    await writeEventAndPublish(task.id, {
      kind: "info",
      actionId: task.currentActionId ?? undefined,
      text: "正在启动只读答疑 agent（群里非任务所有者的提问）…",
    });
    startRestrictedGroupQuestion({
      task,
      text: agentText,
      imagePaths: imageAbsPaths,
      attachmentPaths: attachmentPaths.length > 0 ? attachmentPaths : undefined,
      creds: { apiKey: apiKey!, model: fallbackModel! },
      // 事件身份：这轮回答只投给群侧这条登记（属主 run 的事件进不来、反之亦然）
      runTag: options.restrictedRunTag,
    });
    return new Response(JSON.stringify({ ok: true, task }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  // one-shot「先写 running 再 start」窗口——写 running 前最后复查
  if (isTaskOpStale(task.id, opGen)) {
    return errorResponse(TASK_OP_STALE_HTTP_MESSAGE, 409);
  }

  // 裸 setTaskRunStatus → terminal-aware 条件事务。
  // expectedRunStatus = 判定 one-shot 时看到的等待位（idle/awaiting_user/error…）；
  // isOwner = gen 未 stale + lifecycle 空；终态由 setTaskRunStatusIfRunOwner 内拒。
  const expectedWaitingStatus = task.runStatus;
  const updated = await setTaskRunStatusIfRunOwner(
    task.id,
    "running",
    () =>
      !isTaskOpStale(task.id, opGen) && getChatLifecycle(task.id) === null,
    undefined,
    expectedWaitingStatus,
  );
  if (!updated) {
    return errorResponse(TASK_OP_STALE_HTTP_MESSAGE, 409);
  }
  publishTaskStreamEvent(task.id, { kind: "task", task: updated });

  if (useOneShot) {
    // 受理即可见：oneshot 启动前先落进度
    await writeEventAndPublish(task.id, {
      kind: "info",
      actionId: task.currentActionId ?? undefined,
      text: "正在启动答疑 agent…",
    });
    startOneShotQuestion(
      task,
      agentText,
      imageAbsPaths,
      { apiKey: apiKey!, model: fallbackModel! },
      attachmentPaths.length > 0 ? attachmentPaths : undefined,
      opGen,
    );
  }

  return new Response(JSON.stringify({ ok: true, task: updated }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};
