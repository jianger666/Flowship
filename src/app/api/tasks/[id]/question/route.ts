/**
 * POST /api/tasks/[id]/question——任务内「问一问」（V0.11.9）
 *
 * 用户痛点：想就任务问点问题、以前必须推进一个具体 action 再嘱咐「只回答别改代码」。
 * 本路由把纯提问 `agent.send([USER_QUESTION]…)` 给存活会话（消息内联「只答不动手、
 * 答完自然结束」约束）、不新建 action、不动任务进度：
 * - 回答期间 runStatus=running（UI 显示 agent 在说话）
 * - 回答完 run 自然结束、consumeSessionRun 按最后 action 状态归位
 *   （awaiting_ack → awaiting_user、completed → idle）
 *
 * Body: { text: string, images?: [{data,mimeType,filename}], bootArgs?: { apiKey, model } }
 *
 * 拒绝情况：
 * - task 不存在 → 404；chat 模式 → 409（chat 本来就能随便聊）
 * - agent 正在跑 → 409（等它说完）
 * - ask 弹窗在等答案 → 409（先答弹窗、别两条通道打架）
 * - 无会话且 resume 不了 → 409（提问需要有上下文的 agent、提示推进 / 重启阶段）
 */

import { appendEvent, getTask, setTaskRunStatus } from "@/lib/server/task-fs";
import { saveImageAttachments } from "@/lib/server/task-artifacts";
import { getPendingAsk } from "@/lib/server/chat-pending";
import {
  deliverTaskQuestion,
  startOneShotQuestion,
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
  };
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
  if (getPendingAsk(task.id)) {
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

  // 先送达再落事件（同 ask-reply 顺序约定：送不到就不写、防「用户看到已发出、agent 没收到」）
  const sent = await deliverTaskQuestion(task, text, imageAbsPaths, {
    apiKey,
    model,
  });
  // 会话接不回（agent 报错过 / 停过 / 隔了几天早没了）→ 一次性答疑 agent 兜底
  //（带任务事件日志 / artifact 上下文、只读答疑、不影响任务状态；见 startOneShotQuestion）
  const useFallback = !sent;
  if (useFallback && (!apiKey || !model)) {
    return errorResponse("缺 bootArgs（apiKey / model）、答疑 agent 起不来", 400);
  }

  console.log(
    `[question] task=${task.id} text=${text.slice(0, 60)} images=${images.length} fallback=${useFallback}`,
  );

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

  // 回答期间 runStatus=running（保留 currentActionId、进度不动）；
  // 答完 consumeSessionRun / startOneShotQuestion 按最后 action 状态归位
  const updated = await setTaskRunStatus(task.id, "running");
  if (updated) publishTaskStreamEvent(task.id, { kind: "task", task: updated });

  if (useFallback) {
    startOneShotQuestion(task, text, imageAbsPaths, {
      apiKey: apiKey!,
      model: model!,
    });
  }

  return new Response(JSON.stringify({ ok: true, task: updated ?? task }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};
