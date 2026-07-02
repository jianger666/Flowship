/**
 * POST /api/tasks/[id]/chat-reply
 *
 * V0.6.0.1 重新引入、对齐 V0.5 自由对话体验。仅 chat 模式 task（task.mode === "chat"）走本路由。
 *
 * # Body
 *
 * ```
 * {
 *   text?: string;                    // 用户消息文本（可空、但 images / attachments 至少一个）
 *   images?: Array<{ data, mimeType, filename }>;
 *   attachments?: string[];           // 文件 / 目录绝对路径（原生 picker 选的）
 *   // task 处于 idle / completed / error 时、用户发消息会同时触发「自动启 agent」、需要 SDK 启动参数
 *   bootArgs?: { apiKey, model };
 * }
 * ```
 *
 * # 路由职责（两种模式）
 *
 * 1. **awaiting_user + hasPending=true**（正常对话循环）：
 *    - 写 user_reply 事件
 *    - submitUserMessage（resolve wait_for_user）
 *    - patch task.runStatus=running
 *
 * 2. **idle / error / 上一轮 completed + 无 pending**（自动启动）：
 *    - 写 user_reply 事件（用户立刻看到自己的话）
 *    - patch task.runStatus=running
 *    - fire-and-forget runChatSession(firstMessage=text) 启 agent
 *    - agent 起手 prompt 已含用户首条、直接回答、答完调 wait_for_user 进等待
 *
 * # 失败情况
 *
 * - task 不存在 → 404
 * - task.mode !== "chat" → 409（任务模式不走本路由、应走 advance）
 * - 模式 2 但缺 bootArgs → 400
 * - hasPending=false 且 runStatus=awaiting_user/running → 410（僵尸态、当场标 error）
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import type { ModelSelection } from "@cursor/sdk";

import {
  appendEvent,
  getTask,
  setTaskRunStatus,
  updateTaskFields,
} from "@/lib/server/task-fs";
import { saveImageAttachments } from "@/lib/server/task-artifacts";
import {
  deriveChatTitleFromMessage,
  isPlaceholderChatTitle,
} from "@/lib/task-display";
import {
  hasPending,
  submitUserMessage,
} from "@/lib/server/chat-pending";
import {
  cancelChatRun,
  forceClearChatRun,
  getChatRunDisabledMcp,
  getChatRunModel,
  isChatRunning,
  runChatSession,
  waitForChatToStop,
} from "@/lib/server/chat-runner";
import { publishTaskStreamEvent } from "@/lib/server/task-stream";
import {
  errorResponse,
  isValidModel,
  KEEPALIVE_RACE_RETRY_MS,
  modelEquals,
  parseAndValidateImages,
  sleep,
  stringSetEquals,
} from "@/lib/server/route-helpers";

interface Ctx {
  params: Promise<{ id: string }>;
}

interface PostBody {
  text?: string;
  images?: Array<{
    data?: string;
    mimeType?: string;
    filename?: string;
  }>;
  attachments?: string[];
  bootArgs?: {
    apiKey?: string;
    model?: ModelSelection;
  };
}

const MAX_IMAGES_PER_REPLY = 6;
const MAX_ATTACHMENTS_PER_REPLY = 10;
// 切模型懒重启：cancel 旧 Run 后等它真退的上限（对齐 task-runner force-new 的 5s）、超时强清继续
const CHAT_RESTART_STOP_TIMEOUT_MS = 5000;

export const runtime = "nodejs";

export const POST = async (req: Request, { params }: Ctx) => {
  const { id } = await params;

  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return errorResponse("body 不是合法 JSON");
  }

  const text = body.text?.trim() ?? "";

  // 校验 images
  const imagesResult = parseAndValidateImages(
    body.images,
    MAX_IMAGES_PER_REPLY,
  );
  if (!imagesResult.ok) return imagesResult.errorResponse;
  const images = imagesResult.images;

  // 校验 attachments：必须绝对路径、必须存在
  const rawAttachments = Array.isArray(body.attachments) ? body.attachments : [];
  if (rawAttachments.length > MAX_ATTACHMENTS_PER_REPLY) {
    return errorResponse(
      `单次最多附 ${MAX_ATTACHMENTS_PER_REPLY} 条路径（你传了 ${rawAttachments.length}）`,
    );
  }
  const attachmentAbsPaths: string[] = [];
  for (const raw of rawAttachments) {
    if (typeof raw !== "string" || !raw.trim()) {
      return errorResponse("attachments 必须是非空字符串数组");
    }
    const abs = path.resolve(raw.trim());
    if (!path.isAbsolute(abs)) {
      return errorResponse(`attachments 必须是绝对路径：${raw}`);
    }
    try {
      await fs.stat(abs);
      attachmentAbsPaths.push(abs);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return errorResponse(`attachments 路径不存在：${raw}`);
      }
      if (code === "EACCES") {
        return errorResponse(`attachments 无权限读取：${raw}`);
      }
      return errorResponse(
        `attachments stat 失败：${(err as Error).message}`,
      );
    }
  }

  // 必须 text / images / attachments 至少一项
  if (
    text.length === 0 &&
    images.length === 0 &&
    attachmentAbsPaths.length === 0
  ) {
    return errorResponse("text / images / attachments 至少一项非空");
  }

  const task = await getTask(id);
  if (!task) return errorResponse("not_found", 404);

  if (task.mode !== "chat") {
    return errorResponse(
      `task.mode=${task.mode ?? "task"} 不是 chat、本路由仅服务 chat 模式、任务模式请走 /advance`,
      409,
    );
  }

  // 落盘图片：
  // - imageAbsPaths：给 agent prompt / submitUserMessage 用（只要绝对路径）
  // - savedImages：完整 meta（absPath/relPath/mimeType/bytes/filename）、写进事件给前端渲染缩略图
  let imageAbsPaths: string[] | undefined;
  let savedImages:
    | Awaited<ReturnType<typeof saveImageAttachments>>
    | undefined;
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

  // 写 user_reply 事件（用户立刻在 event-stream 看到自己的话）
  // 图片存 meta.images（完整对象数组）——前端 extractUserReplyImages 读的是 meta.images、
  // 不是 imagePaths（string[]）；写错字段会导致附图在事件流里不显示（V0.6.12 修）。
  const userReplyMeta: Record<string, unknown> = {};
  if (savedImages && savedImages.length > 0) {
    userReplyMeta.images = savedImages;
  }
  if (attachmentAbsPaths.length > 0) {
    userReplyMeta.attachmentPaths = attachmentAbsPaths;
  }
  const fallbackText =
    text.length === 0 && (imageAbsPaths || attachmentAbsPaths.length > 0)
      ? "(用户附了图片 / 文件)"
      : "";
  const replyEvent = await appendEvent(task.id, {
    kind: "user_reply",
    text: text || fallbackText,
    meta:
      Object.keys(userReplyMeta).length > 0 ? userReplyMeta : undefined,
  });
  if (replyEvent) {
    publishTaskStreamEvent(task.id, { kind: "event", event: replyEvent });
  }

  // 首条消息派生标题：占位「对话 · 时间」被用户首条消息前 ~24 字覆盖（first-message-wins、
  // 对齐 codex / Cursor Agent Window）。放在写完 user_reply、启 agent 之前——这样后续
  // setTaskRunStatus 读到的 meta 已是新标题、publish 的 task 一次带上新名、侧栏不闪旧占位。
  if (text && isPlaceholderChatTitle(task.title)) {
    const derived = deriveChatTitleFromMessage(text);
    if (derived) {
      const renamed = await updateTaskFields(task.id, { title: derived });
      if (renamed) {
        publishTaskStreamEvent(task.id, { kind: "task", task: renamed });
        task.title = derived;
      }
    }
  }

  // bootArgs（apiKey + model）前端永远附带——模式 1 懒重启换模型、模式 2 自动启动都要用、
  // 提到模式判断前声明（原在模式 2 处、模式 1 引用会 TDZ 报错）
  const bootArgs = body.bootArgs;

  // 决定模式：awaiting_user + hasPending → 正常推进；否则 → 自动启 agent
  // race 兜底：刚切到 awaiting_user 但 hasPending 还没注册、KEEPALIVE_RACE_RETRY_MS 内 retry 一次
  let pending = hasPending(task.id);
  if (!pending && task.runStatus === "awaiting_user") {
    await sleep(KEEPALIVE_RACE_RETRY_MS);
    pending = hasPending(task.id);
  }

  if (pending && task.runStatus === "awaiting_user") {
    // 切模型 / 切 MCP 懒重启：用户可能在上轮答完后切了模型 / 调了参数 / 改了 MCP 开关
    //（只存进 task.model / task.disabledMcpServers、没动当前 Run）。
    // 比对「当前 Run 绑定的 模型 + MCP 黑名单」vs「现在的」、任一变了就重启、都没变就续接。
    const runModel = getChatRunModel(task.id);
    // 当前 Run 绑定的 MCP 黑名单快照 vs 现在 task 的（task 是上面 getTask 读的最新值、PATCH 已生效）。
    // runMcp === null = 没活 Run 可比（pending 时理论不会、防御性当作没变、走续接）。
    const runMcp = getChatRunDisabledMcp(task.id);
    const mcpUnchanged =
      runMcp === null || stringSetEquals(runMcp, task.disabledMcpServers ?? []);
    // 续接条件：没绑定模型可比 / 缺起新 Run 的 apiKey+model /（模型没变 且 MCP 没变）→ 同 Run 续接、省计费
    if (
      !runModel ||
      !bootArgs?.apiKey ||
      !isValidModel(bootArgs.model) ||
      (modelEquals(runModel, bootArgs.model) && mcpUnchanged)
    ) {
      submitUserMessage(task.id, text, imageAbsPaths, attachmentAbsPaths);
      const runningTask = await setTaskRunStatus(task.id, "running");
      if (runningTask)
        publishTaskStreamEvent(task.id, { kind: "task", task: runningTask });
      const fresh = await getTask(task.id);
      return new Response(
        JSON.stringify({ ok: true, task: fresh ?? task, autoStarted: false }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // 模型 或 MCP 变了 → 懒重启：取消旧 Run、等它真退（超时强清）、用新模型 + 新 MCP 集合起新 Run
    //（这条消息作首条）、历史靠 events.jsonl 续上（跟「服务重启后再聊」同一条恢复路径、
    // buildInitialPrompt 已给 agent eventsLogPath；新 Run 内 filterDisabledMcp 读 task 最新黑名单）
    cancelChatRun(task.id);
    const stopped = await waitForChatToStop(
      task.id,
      CHAT_RESTART_STOP_TIMEOUT_MS,
    );
    if (!stopped) {
      console.warn(
        `[chat-reply] task=${task.id} 切模型重启：旧 Run 没在 ${CHAT_RESTART_STOP_TIMEOUT_MS}ms 内退、强清继续`,
      );
      forceClearChatRun(task.id);
    }
    const runningTask = await setTaskRunStatus(task.id, "running");
    if (runningTask)
      publishTaskStreamEvent(task.id, { kind: "task", task: runningTask });
    void runChatSession({
      task: runningTask ?? task,
      apiKey: bootArgs.apiKey,
      model: bootArgs.model,
      firstMessage: {
        text,
        imagePaths: imageAbsPaths,
        attachmentPaths:
          attachmentAbsPaths.length > 0 ? attachmentAbsPaths : undefined,
      },
      firstMessageEventId: replyEvent?.id,
    }).catch((err) => {
      console.error(
        `[chat-reply] 切模型重启 runChatSession task=${task.id} failed:`,
        err,
      );
    });
    const fresh = await getTask(task.id);
    return new Response(
      JSON.stringify({ ok: true, task: fresh ?? task, autoStarted: true }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }

  // agent 进程其实还活着（runningChats 有）但没 pending = 它正在说话（running 态本来就没 pending）
  // → 不是僵尸、绝不标 error、让用户等它这段说完。前端正常会拦 running、这里兜 SSE 滞后导致
  //   前端拿过期 runStatus 发消息的 race（否则会把正在跑的 agent 误杀成 error）
  if (!pending && isChatRunning(task.id)) {
    return errorResponse("agent 正在回、等它说完一段再发", 409);
  }

  // 模式 2：自动启 agent（终态发消息）
  // 进程已经没了（runningChats 无）但 meta 状态停在 awaiting_user/running
  //   = agent 异常退出 / 服务重启、状态没收尾 → 真僵尸、当场标 error、引导用户再发一条重启
  if (
    !pending &&
    (task.runStatus === "awaiting_user" || task.runStatus === "running")
  ) {
    console.warn(
      `[chat-reply] task=${task.id} 僵尸态 runStatus=${task.runStatus}（进程已不在）、当场标 error`,
    );
    const errorTask = await setTaskRunStatus(task.id, "error");
    if (errorTask)
      publishTaskStreamEvent(task.id, { kind: "task", task: errorTask });
    return errorResponse(
      "Chat agent 已断开（进程重启或异常退出）、再发一条消息即可重启新一轮对话",
      410,
    );
  }

  // 校验 bootArgs（声明已提到模式判断前）
  if (!bootArgs?.apiKey || typeof bootArgs.apiKey !== "string") {
    return errorResponse("缺 bootArgs.apiKey、终态发消息触发自动启动必传");
  }
  if (!isValidModel(bootArgs.model)) {
    return errorResponse("bootArgs.model 非法");
  }

  // 防重复启动：agent 还在跑（理论不该走到这、防御性）
  if (isChatRunning(task.id)) {
    return errorResponse("Chat agent 已经在跑、不需要重启", 409);
  }

  // 切 task.runStatus=running、fire-and-forget runChatSession
  const runningTask = await setTaskRunStatus(task.id, "running");
  if (runningTask)
    publishTaskStreamEvent(task.id, { kind: "task", task: runningTask });

  void runChatSession({
    task: runningTask ?? task,
    apiKey: bootArgs.apiKey,
    model: bootArgs.model,
    firstMessage: {
      text,
      imagePaths: imageAbsPaths,
      attachmentPaths:
        attachmentAbsPaths.length > 0 ? attachmentAbsPaths : undefined,
    },
    // 首条消息的 user_reply 事件 id（上面刚写）传给 runner、写进「Chat 任务启动」meta、
    // 兜底 A 据此精确定位本轮回答义务、不靠位置巧合
    firstMessageEventId: replyEvent?.id,
  }).catch((err) => {
    console.error(`[chat-reply] runChatSession task=${task.id} failed:`, err);
  });

  const fresh = await getTask(task.id);
  return new Response(
    JSON.stringify({ ok: true, task: fresh ?? task, autoStarted: true }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
};
