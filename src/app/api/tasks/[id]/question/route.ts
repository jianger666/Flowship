/**
 * POST /api/tasks/[id]/question——任务页输入条的统一消息通道（V0.13.x）
 *
 * V0.13.x 用户拍板「别这么多分支」：原「再聊聊（revise）/ 问一问（question）」两条客户端
 * 通道合一——任何输入条消息都走这里、`agent.send([USER_MESSAGE]…)`、AI 自主二分类
 *（疑问就答 / 要改就改）。服务端只做状态机内务：
 * - 当前产出在等审阅（awaiting_ack）→ 先 snapshot artifact 版本、消息附「处理完重新交卷」
 *   上下文、action 回 running（原 revise 的状态机语义、对 AI 是同一条消息模板）
 * - 其他时刻 → 插话语义（不推进任务链）、回答完 consumeSessionRun 按最后 action 状态归位
 *
 * 传输分流（对用户透明）：会话活着 send；会话断 + action 停半路（含 awaiting_ack）唤醒
 * 新 agent 原地续（显式换模型用新模型跑）；会话断 + 已完结起一次性临时 agent。
 *
 * Body: { text, images?, attachments?, skills?, bootArgs?: { apiKey, model }, forceModel? }
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
import { clearPendingAsk, getPendingAsk } from "@/lib/server/chat-pending";
import {
  deliverTaskQuestion,
  isTaskOpStale,
  resumeCurrentActionWithMessage,
  startOneShotQuestion,
  supersedePendingAsks,
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

interface Ctx {
  params: Promise<{ id: string }>;
}

interface PostBody {
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
   * 用户在输入条显式选的模型：传了 = 不续会话（会话模型锁死换不了）、
   * 走唤醒（新 agent 用新模型跑）或一次性临时 agent。
   */
  forceModel?: { id?: string; params?: Array<{ id: string; value: string }> };
}

const MAX_IMAGES = 6;
const MAX_ATTACHMENTS = 10;
const MAX_SKILLS = 8;

export const runtime = "nodejs";

export const POST = async (req: Request, { params }: Ctx) => {
  const { id } = await params;

  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return errorResponse("body 不是合法 JSON");
  }

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
  const skillsResult = parseAndValidateSkills(body.skills, MAX_SKILLS);
  if (!skillsResult.ok) return skillsResult.errorResponse;
  const skills = skillsResult.skills;
  if (!text && images.length === 0 && attachmentPaths.length === 0) {
    return errorResponse("text / images / attachments 至少一项非空");
  }

  let task = await getTask(id);
  if (!task) return errorResponse("not_found", 404);

  // U1 / R24-5a：lifecycle 非 null（stopping/deleting/finalizing）一律拒发送 / 唤醒
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

  // W2：读完 task + lifecycle 闸后立刻同步取 admission——其后有存图 / 等 drain /
  // supersede 等长 await，再取会被 stop bump 后的新值冒充新意图
  const opGen = getTaskOpGeneration(task.id);

  if (task.mode === "chat") {
    return errorResponse("chat 对话直接在输入框发消息即可", 409);
  }
  // 有 pendingAsk 也不再硬拦输入条：用户可绕过答题卡直接说话（下方 sent/oneshot
  // 会 supersede；canResume 唤醒内部也会 supersede）。旧逻辑「先回答上方提问」在
  // 网断 / 会话死后把输入条和答题卡对锁——只能重新推进（同事反馈）。

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
      // 等待期间用户可能点了「推进」起了新 action / 新 run（蓝军 P1）：
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

  // X1：长 await（存图）后复查——stop 期间不得继续 fallback / 写 running
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
  const canDeliver = !forceModel && agentSessions.has(task.id);
  const hasWakeCreds = !!apiKey && !!fallbackModel;
  if (!canDeliver && !hasWakeCreds) {
    return errorResponse("缺 bootArgs（apiKey / model）、agent 起不来", 400);
  }

  // 当前产出在等审阅（awaiting_ack）= 原「再聊聊」场景：先 snapshot artifact 版本
  //（用户可能要求改、保留改前版本）、消息附「处理完重新交卷」上下文
  const ackAction = task.actions.find(
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

  // X1：snapshot 长 await 后再查
  if (isTaskOpStale(task.id, opGen)) {
    return errorResponse(TASK_OP_STALE_HTTP_MESSAGE, 409);
  }

  // 有待答提问时用户直接说话 = 跳过提问（下方会作废）——给 agent 显式提示、
  // 别把未答的问题悄悄吞掉：信息仍必要就结合新消息重新提问（用户拍板的护栏）
  const skippedAskHint = getPendingAsk(task.id)
    ? "（提示：你此前的提问未被用户回答、已作废——若其中信息仍然必要、结合下面的消息重新提问）\n"
    : "";
  // 事件用用户原文；发给 agent 的带 skill 指引（三条分流共用）
  const agentText = skippedAskHint + buildSkillDirective(skills) + text;

  // 用户显式选了模型 → 不续会话（会话模型锁死换不了）；
  // 否则先送达存活会话（同 ask-reply 顺序约定：送不到不写事件、防假已发）、接不回走下面分流
  // X1：forceModel 视为无会话续接意图（走下方分流），不是 stale
  const deliverResult = forceModel
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

  // X1：stale → 409，绝不 fallback one-shot、不写事件、不写 running
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
  // - 其他（action 已完结 / 没 action）→ 一次性答疑 agent（只答不动手）
  const currentAction = task.actions.find((a) => a.id === task.currentActionId);
  const canResume =
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

  // X1：写事件 / supersede / 置 running 前最后复查（含 useOneShot 窗口）
  if (isTaskOpStale(task.id, opGen)) {
    return errorResponse(TASK_OP_STALE_HTTP_MESSAGE, 409);
  }

  // 用户绕开 ask 弹窗直接在输入条说话 = 旧弹窗事实作废（send：agent 收到新消息就继续了；
  // oneshot：旧会话已死、答案永远送不到）。不作废的话弹窗永远挂着（用户实测卡死、再答 409）。
  // canResume 分支不用管——resumeCurrentActionWithMessage 内部已 supersede。
  // R29-4：send 后可先清 pending；send 前（oneshot）须等用户原文落盘成功再清
  if (sent) {
    await supersedePendingAsks(task.id, "用户已在输入条继续对话");
    clearPendingAsk(task.id);
  }

  // X1：supersede 是 await——后再查一次再写「已送达」事件
  if (isTaskOpStale(task.id, opGen)) {
    return errorResponse(TASK_OP_STALE_HTTP_MESSAGE, 409);
  }

  // R29-4：用户原文 strict 落盘
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
      },
    });
    if (!wrote) {
      if (sent) {
        persistWarning = PERSIST_WARNING_DELIVERED;
        console.error(
          `[question] R29-4 已送达但持久化失败（ENOENT/未写）task=${task.id}`,
        );
      } else {
        return errorResponse("not_found", 404);
      }
    }
  } catch (persistErr) {
    if (sent) {
      console.error(
        `[question] R29-4 已送达但持久化失败 task=${task.id}:`,
        persistErr,
      );
      persistWarning = PERSIST_WARNING_DELIVERED;
    } else {
      console.error(
        `[question] R29-4 start 前落盘失败 task=${task.id}:`,
        persistErr,
      );
      return errorResponse(PERSIST_FAIL_RETRY_MESSAGE, 500);
    }
  }

  // oneshot：落盘成功后再作废旧 ask（R29-4：失败路径不得清 pending）
  if (!sent && useOneShot) {
    await supersedePendingAsks(task.id, "用户已在输入条继续对话");
    clearPendingAsk(task.id);
  }

  // send 成功且产出在等审阅：action 回 running（agent 处理完会重新交卷回 awaiting_ack）——
  // 原 revise 的状态机语义、防「artifact 在改、UI 还显示等审阅」
  if (sent && ackContext) {
    // R18-1 / R19-1：锁内 op-fresh + 结构条件事务——一次写 action+runStatus，杜绝
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
      // R29-1：唤醒失败审计事件写+publish 同链（best-effort 吞错）
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

  // X1：one-shot「先写 running 再 start」窗口——写 running 前最后复查
  if (isTaskOpStale(task.id, opGen)) {
    return errorResponse(TASK_OP_STALE_HTTP_MESSAGE, 409);
  }

  // R25-2：裸 setTaskRunStatus → terminal-aware 条件事务。
  // expectedRunStatus = route 判定 one-shot 时看到的等待位（idle/awaiting_user/error…）；
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
