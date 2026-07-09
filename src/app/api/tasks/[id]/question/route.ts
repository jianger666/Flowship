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
 * Body: { text, images?, bootArgs?: { apiKey, model }, forceModel? }
 */

import { appendEvent, getTask, patchAction, setTaskRunStatus } from "@/lib/server/task-fs";
import {
  saveImageAttachments,
  snapshotActionArtifact,
} from "@/lib/server/task-artifacts";
import { clearPendingAsk, getPendingAsk } from "@/lib/server/chat-pending";
import {
  deliverTaskQuestion,
  resumeCurrentActionWithMessage,
  startOneShotQuestion,
  supersedePendingAsks,
} from "@/lib/server/task-runner";
import { publishTaskStreamEvent, runningTasks } from "@/lib/server/task-stream";
import {
  errorResponse,
  parseAndValidateImages,
} from "@/lib/server/route-helpers";

interface Ctx {
  params: Promise<{ id: string }>;
}

interface PostBody {
  text?: string;
  images?: Array<{ data?: string; mimeType?: string; filename?: string }>;
  bootArgs?: {
    apiKey?: string;
    model?: { id?: string; params?: Array<{ id: string; value: string }> };
    gitHost?: string;
    gitToken?: string;
  };
  /**
   * 用户在输入条显式选的模型：传了 = 不续会话（会话模型锁死换不了）、
   * 走唤醒（新 agent 用新模型跑）或一次性临时 agent。
   */
  forceModel?: { id?: string; params?: Array<{ id: string; value: string }> };
}

const MAX_IMAGES = 6;

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
  if (!text && images.length === 0) {
    return errorResponse("text / images 至少一项非空");
  }

  const task = await getTask(id);
  if (!task) return errorResponse("not_found", 404);
  if (task.mode === "chat") {
    return errorResponse("chat 对话直接在输入框发消息即可", 409);
  }
  if (runningTasks.has(task.id) || task.runStatus === "running") {
    return errorResponse("agent 正在跑、等它说完这轮再问", 409);
  }
  // ask 弹窗还在等答案时把用户往弹窗引——但当前 action 已停在半路（agent 报错 / 被停、
  // 弹窗其实已经没人接了）时不拦：放行走唤醒模式、悬着的问题会随断点续传重新问到
  const haltedAction = task.actions.find(
    (a) =>
      a.id === task.currentActionId &&
      (a.status === "error" || a.status === "cancelled"),
  );
  if (getPendingAsk(task.id) && !haltedAction) {
    return errorResponse("AI 正在弹窗等你回答、先答完弹窗里的问题", 409);
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

  const apiKey = body.bootArgs?.apiKey?.trim() || undefined;
  const model =
    body.bootArgs?.model && typeof body.bootArgs.model.id === "string"
      ? { id: body.bootArgs.model.id, params: body.bootArgs.model.params }
      : undefined;
  const forceModel =
    body.forceModel && typeof body.forceModel.id === "string"
      ? { id: body.forceModel.id, params: body.forceModel.params }
      : undefined;

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

  // 用户显式选了模型 → 不续会话（会话模型锁死换不了）；
  // 否则先送达存活会话（同 ask-reply 顺序约定：送不到不写事件、防假已发）、接不回走下面分流
  const sent = forceModel
    ? false
    : await deliverTaskQuestion(
        task,
        text,
        imageAbsPaths,
        { apiKey, model },
        ackContext,
      );

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
  const fallbackModel = forceModel ?? model;
  if (!sent && (!apiKey || !fallbackModel)) {
    return errorResponse("缺 bootArgs（apiKey / model）、agent 起不来", 400);
  }

  console.log(
    `[question] task=${task.id} text=${text.slice(0, 60)} images=${images.length} mode=${sent ? "send" : canResume ? "resume" : "oneshot"}`,
  );

  // 用户绕开 ask 弹窗直接在输入条说话 = 旧弹窗事实作废（send：agent 收到新消息就继续了；
  // oneshot：旧会话已死、答案永远送不到）。不作废的话弹窗永远挂着（用户实测卡死、再答 409）。
  // canResume 分支不用管——resumeCurrentActionWithMessage 内部已 supersede。
  if (sent || useOneShot) {
    await supersedePendingAsks(task.id, "用户已在输入条继续对话");
    clearPendingAsk(task.id);
  }

  const questionEvent = await appendEvent(task.id, {
    kind: "user_reply",
    actionId: task.currentActionId ?? undefined,
    text: text || "(用户附了图片提问)",
    meta: {
      kind: "question",
      ...(savedImages && savedImages.length > 0 ? { images: savedImages } : {}),
    },
  });
  if (questionEvent) {
    publishTaskStreamEvent(task.id, { kind: "event", event: questionEvent });
  }

  // send 成功且产出在等审阅：action 回 running（agent 处理完会重新交卷回 awaiting_ack）——
  // 原 revise 的状态机语义、防「artifact 在改、UI 还显示等审阅」
  if (sent && ackContext) {
    const patched = await patchAction(task.id, ackContext.actionId, {
      status: "running",
    });
    if (patched) {
      publishTaskStreamEvent(task.id, { kind: "task", task: patched });
      const a = patched.actions.find((x) => x.id === ackContext.actionId);
      if (a) publishTaskStreamEvent(task.id, { kind: "action", action: a });
    }
    const running = await setTaskRunStatus(task.id, "running", ackContext.actionId);
    if (running) publishTaskStreamEvent(task.id, { kind: "task", task: running });
    const fresh = await getTask(task.id);
    return new Response(JSON.stringify({ ok: true, task: fresh ?? task }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (canResume) {
    // 唤醒模式自己管状态（patch action running + runStatus + 事件）；失败标 error 有内部兜底
    void resumeCurrentActionWithMessage({
      task,
      userMessage: text,
      imagePaths: imageAbsPaths,
      apiKey: apiKey!,
      fallbackModel: fallbackModel!,
      // 用户显式换的模型：唤醒的新 agent 直接用它跑（V0.13.x、不再锁进只读答疑）
      forceModel,
      gitHost: body.bootArgs?.gitHost?.trim() || undefined,
      gitToken: body.bootArgs?.gitToken?.trim() || undefined,
    }).catch(async (err) => {
      console.error(`[question] task=${task.id} 唤醒当前 action 失败：`, err);
      const ev = await appendEvent(task.id, {
        kind: "error",
        text: `唤醒当前阶段失败：${err instanceof Error ? err.message : String(err)}`,
      });
      if (ev) publishTaskStreamEvent(task.id, { kind: "event", event: ev });
    });
    const fresh = await getTask(task.id);
    return new Response(JSON.stringify({ ok: true, task: fresh ?? task }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  // 回答期间 runStatus=running（保留 currentActionId、进度不动）；
  // 答完 consumeSessionRun / startOneShotQuestion 按最后 action 状态归位
  const updated = await setTaskRunStatus(task.id, "running");
  if (updated) publishTaskStreamEvent(task.id, { kind: "task", task: updated });

  if (useOneShot) {
    startOneShotQuestion(task, text, imageAbsPaths, {
      apiKey: apiKey!,
      model: fallbackModel!,
    });
  }

  return new Response(JSON.stringify({ ok: true, task: updated ?? task }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};
