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
 *   skills?: Array<{ name, absPath }>; // skill 引用；指引只进 agent、不进 user_reply
 *   // task 处于 idle / completed / error 时、用户发消息会同时触发「自动启 agent」、需要 SDK 启动参数
 *   bootArgs?: { apiKey, model };
 * }
 * ```
 *
 * # 路由职责（V0.11：wait 协议退役、两种模式）
 *
 * 1. **有存活会话（agent 在、无 run 在跑）**（正常对话循环）：
 *    - 写 user_reply 事件（text = 用户原文）
 *    - sendChatMessage（`agent.send` 续同一会话、新 run；text = skill 指引 + 原文）
 *    -（切模型 / 切 MCP 时懒重启：关旧会话、起新会话、这条消息作首条）
 *
 * 2. **无会话（首条 / agent 已关 / 服务重启过）**（自动启动）：
 *    - 写 user_reply 事件（用户立刻看到自己的话 = 原文）
 *    - patch task.runStatus=running
 *    - fire-and-forget runChatSession(firstMessage=指引+原文) 起新会话
 *    - agent 起手 prompt 已含用户首条、直接回答、答完自然结束回复
 *
 * # 失败情况
 *
 * - task 不存在 → 404
 * - task.mode !== "chat" → 409（任务模式不走本路由、应走 advance）
 * - run 正在跑（agent 正在回）→ 409
 * - 模式 2 但缺 bootArgs → 400
 */

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
  cancelChatRun,
  forceClearChatRun,
  getChatRunDisabledMcp,
  getChatRunModel,
  hasChatSession,
  resumeChatSession,
  runChatSession,
  sendChatMessage,
  waitForChatToStop,
} from "@/lib/server/chat-runner";
import { publishTaskStreamEvent } from "@/lib/server/task-stream";
import { checkUpdatePendingRestart } from "@/lib/server/update-pending";
import { buildSkillDirective } from "@/lib/protocol-signals";
import {
  errorResponse,
  isValidModel,
  modelEquals,
  parseAndValidateAttachments,
  parseAndValidateImages,
  parseAndValidateSkills,
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
  skills?: Array<{ name?: string; absPath?: string }>;
  bootArgs?: {
    apiKey?: string;
    model?: ModelSelection;
  };
}

const MAX_IMAGES_PER_REPLY = 6;
const MAX_ATTACHMENTS_PER_REPLY = 10;
const MAX_SKILLS_PER_REPLY = 8;
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

  // 校验 attachments：必须绝对路径、必须存在（helper 跟 question 路由共用）
  const attachResult = await parseAndValidateAttachments(
    body.attachments,
    MAX_ATTACHMENTS_PER_REPLY,
  );
  if (!attachResult.ok) return attachResult.errorResponse;
  const attachmentAbsPaths = attachResult.paths;

  // skill 引用：指引只拼进 agent 消息、事件气泡存用户原文
  const skillsResult = parseAndValidateSkills(body.skills, MAX_SKILLS_PER_REPLY);
  if (!skillsResult.ok) return skillsResult.errorResponse;
  const skills = skillsResult.skills;

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
    // 前端 extractUserReplyAttachments 读的是 meta.attachments（对象数组、带 absPath/isDir）——
    // 老代码写 attachmentPaths（string[]）导致路径 chips 在事件流一直不显示（v1.1.x Bugbot 揪出）
    userReplyMeta.attachments = attachResult.metas;
  }
  const fallbackText =
    text.length === 0 && (imageAbsPaths || attachmentAbsPaths.length > 0)
      ? "(用户附了图片 / 文件)"
      : "";
  // 事件 = 用户原文；agent = skill 指引 + 原文（与 ATTACHED_* 一样不进气泡）
  const agentText = buildSkillDirective(skills) + text;
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

  // V0.11.1：内存没会话但有落盘锚点（服务重启 / 空闲回收后）→ 先 Agent.resume 接回、
  // 下面统一走「有会话」分支 send 续接、上下文不丢。resume 失败会清锚点、自然落到起新会话。
  if (
    !hasChatSession(task.id) &&
    task.sessionAgentId &&
    bootArgs?.apiKey &&
    isValidModel(bootArgs.model)
  ) {
    await resumeChatSession(task, {
      apiKey: bootArgs.apiKey,
      model: bootArgs.model,
    });
  }

  // 决定模式（V0.11）：有存活会话且没 run 在跑 → send 续接；否则 → 起新会话
  if (hasChatSession(task.id)) {
    // 切模型 / 切 MCP 懒重启：用户可能在上轮答完后切了模型 / 改了 MCP 开关
    //（只存进 task.model / task.disabledMcpServers、没动当前会话）。
    // 比对「会话绑定的模型 + MCP 黑名单」vs「现在的」、任一变了就重开会话、都没变就 send 续接。
    const runModel = getChatRunModel(task.id);
    const runMcp = getChatRunDisabledMcp(task.id);
    const mcpUnchanged =
      runMcp === null || stringSetEquals(runMcp, task.disabledMcpServers ?? []);
    const canRestart = !!bootArgs?.apiKey && isValidModel(bootArgs.model);
    const unchanged =
      !runModel ||
      !canRestart ||
      (modelEquals(runModel, bootArgs!.model!) && mcpUnchanged);

    if (unchanged) {
      // send 续接同一会话（agent 正在回时返 false → 409 让用户等说完）
      const sent = await sendChatMessage(
        task,
        agentText || fallbackText,
        imageAbsPaths,
        attachmentAbsPaths.length > 0 ? attachmentAbsPaths : undefined,
      );
      if (sent) {
        const fresh = await getTask(task.id);
        return new Response(
          JSON.stringify({ ok: true, task: fresh ?? task, autoStarted: false }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      // send 失败两种情况：run 在跑（agent 正在回）→ 409；会话坏了（已被 close）→ 落到下面起新会话
      if (hasChatSession(task.id)) {
        return errorResponse("agent 正在回、等它说完一段再发", 409);
      }
    } else {
      // V0.10.1：更新就位未重启 → 起新会话必挂死。懒重启会关掉还健康的旧会话、拦在关之前
      const pendingRestartMsg = await checkUpdatePendingRestart();
      if (pendingRestartMsg) return errorResponse(pendingRestartMsg, 409);

      // 模型 或 MCP 变了 → 懒重启：关旧会话、起新会话（这条消息作首条）、
      // 历史靠 events.jsonl 续上（buildInitialPrompt 已给 agent eventsLogPath）
      cancelChatRun(task.id);
      const stopped = await waitForChatToStop(
        task.id,
        CHAT_RESTART_STOP_TIMEOUT_MS,
      );
      if (!stopped) {
        console.warn(
          `[chat-reply] task=${task.id} 切模型重启：旧会话没在 ${CHAT_RESTART_STOP_TIMEOUT_MS}ms 内退、强清继续`,
        );
        forceClearChatRun(task.id);
      }
    }
  }

  // 模式 2：起新会话（首条 / 会话已关 / 懒重启后）
  // 校验 bootArgs
  if (!bootArgs?.apiKey || typeof bootArgs.apiKey !== "string") {
    return errorResponse("缺 bootArgs.apiKey、起新会话必传");
  }
  if (!isValidModel(bootArgs.model)) {
    return errorResponse("bootArgs.model 非法");
  }

  // 防重复启动：会话还在（send 失败但 run 在跑等 race）→ 409
  if (hasChatSession(task.id)) {
    return errorResponse("Chat agent 已经在跑、不需要重启", 409);
  }

  // V0.10.1：更新就位未重启 → 起新 Run 必挂死、拦在标 running 之前
  const pendingRestartMsg = await checkUpdatePendingRestart();
  if (pendingRestartMsg) return errorResponse(pendingRestartMsg, 409);

  // 切 task.runStatus=running、fire-and-forget runChatSession
  const runningTask = await setTaskRunStatus(task.id, "running");
  if (runningTask)
    publishTaskStreamEvent(task.id, { kind: "task", task: runningTask });

  void runChatSession({
    task: runningTask ?? task,
    apiKey: bootArgs.apiKey,
    model: bootArgs.model,
    firstMessage: {
      text: agentText,
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
