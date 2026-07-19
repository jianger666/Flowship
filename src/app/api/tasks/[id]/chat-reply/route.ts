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
 *    - sendChatMessage（`agent.send` 续同一会话、新 run；text = skill 指引 + 原文）
 *    - 确定会送达后再写 user_reply 事件（text = 用户原文；对齐 ask-reply「先送达再落事件」）
 *    -（切模型 / 切 MCP 时懒重启：关旧会话、起新会话、这条消息作首条）
 *
 * 2. **无会话（首条 / agent 已关 / 服务重启过）**（自动启动）：
 *    - 校验 bootArgs → 写 user_reply → patch task.runStatus=running
 *    - fire-and-forget runChatSession(firstMessage=指引+原文) 起新会话
 *    - agent 起手 prompt 已含用户首条、直接回答、答完自然结束回复
 *
 * # 失败情况
 *
 * - task 不存在 → 404
 * - task.mode !== "chat" → 409（任务模式不走本路由、应走 advance）
 * - run 正在跑（agent 正在回）→ 202 入队（queued:true）；队满 → 409
 * - 模式 2 但缺 bootArgs → 400
 */

import type { ModelSelection } from "@cursor/sdk";

import {
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
  getChatRunRepoPaths,
  hasChatSession,
  isChatCompactInProgress,
  isChatQueueDraining,
  releaseChatRunClaim,
  resumeChatSession,
  runChatSession,
  sendChatMessage,
  waitForChatToStop,
} from "@/lib/server/chat-runner";
import {
  captureChatCheckpoint,
  persistCheckpointForReply,
  type CaptureCheckpointResult,
} from "@/lib/server/chat-checkpoint";
import {
  clearChatQueue,
  dequeueChatMessage,
  enqueueChatMessage,
  enqueueChatMessageFront,
  getChatQueueCount,
} from "@/lib/server/chat-queue";
import {
  getChatLifecycle,
  isChatRewindInProgress,
  isChatStartLeaseValid,
  releaseChatStart,
  tryReserveChatStart,
} from "@/lib/server/chat-gate";
import {
  PERSIST_FAIL_RETRY_MESSAGE,
  PERSIST_WARNING_DELIVERED,
  publishTaskStreamEvent,
  writeEventAndPublish,
  writeUserEventAndPublishStrict,
} from "@/lib/server/task-stream";
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

  // rewind 进行中：与 checkpoint 侧门闩闭合——破坏性恢复未完前拒收新消息
  if (isChatRewindInProgress(id)) {
    return errorResponse("正在回退到检查点、完成后再发", 409);
  }

  // T1：stop/DELETE 收尾窗口——禁止新消息（含入队），否则 202 后被 clearChatQueue 静默丢
  const lifecycle = getChatLifecycle(id);
  if (lifecycle === "stopping") {
    return errorResponse("正在停止对话、请稍后重发", 409);
  }
  if (lifecycle === "deleting") {
    return errorResponse("任务正在删除", 409);
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

  // 准备 user_reply 载荷——审查发现：旧逻辑先 append+publish 再 send，409「agent 正在回」
  // 时事件流已显示「已发送」。对齐 ask-reply：确定会送达后再落事件（events.jsonl
  // append-only 不可删、不能先写再回滚）。
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

  // Phase 3：绑定 workdir 的 chat 在 agent 开工前打 git tree 快照（失败不挡发消息）
  const tryCaptureCheckpoint = async (): Promise<CaptureCheckpointResult> => {
    if (!task.repoPaths || task.repoPaths.length === 0) {
      return { ok: false, repoSnapshots: [], elapsedMsByRepo: {}, warnings: [] };
    }
    const capture = await captureChatCheckpoint(task.repoPaths);
    if (capture.warnings.length > 0) {
      console.warn(
        `[chat-reply] checkpoint 部分失败 task=${task.id}:`,
        capture.warnings.join("; "),
      );
    }
    return capture;
  };

  // 确定会送达后才写 user_reply（send 续接成功 / 起新会话前各调一次）
  // checkpointed:true → 批 B 前端据此显示「回退到这里」
  // R29-4：用户原文走 strict——IO 失败抛错，不得吞成「成功但无气泡」
  const persistUserReply = async (checkpointed: boolean) => {
    const meta: Record<string, unknown> = { ...userReplyMeta };
    if (checkpointed) meta.checkpointed = true;
    return writeUserEventAndPublishStrict(task.id, {
      kind: "user_reply",
      text: text || fallbackText,
      meta: Object.keys(meta).length > 0 ? meta : undefined,
    });
  };

  /** 落 user_reply +（可选）rewind 点；快照须已在 agent 开工前打完 */
  const persistReplyAndCheckpoint = async (
    capture: CaptureCheckpointResult,
  ) => {
    const checkpointed = capture.ok;
    const replyEvent = await persistUserReply(checkpointed);
    if (replyEvent && checkpointed) {
      await persistCheckpointForReply(task.id, replyEvent.id, capture);
    }
    return replyEvent;
  };

  /** R31-1：队列优先启动路径复用「刚入队的当前条」itemId */
  let lastEnqueuedItemId: string | undefined;

  /**
   * R1：rewind 门闩下不得入队。入队是同步内存操作，检查与 enqueue 之间无 await 即原子；
   * rewind 占门闩后会复查 queueCount>0 并拒绝回退——两边交叉闭合。
   * 统一「检查门闩 → enqueue → 满则 409 → 202」消掉 5 处复制粘贴。
   */
  const enqueueOrReject = async (): Promise<Response> => {
    // 与 rewind 占门闩后复查 queueCount 交叉闭合：门闩已占则绝不入队
    //（否则 202 后 rewind 清队列，消息静默消失）
    if (isChatRewindInProgress(task.id)) {
      return errorResponse("正在回退到检查点、请稍后重发", 409);
    }
    // T1：与 rewind 同款交叉闭合——stop 收尾期间入队会在 clearChatQueue 时静默丢
    const life = getChatLifecycle(task.id);
    if (life === "stopping") {
      return errorResponse("正在停止对话、请稍后重发", 409);
    }
    if (life === "deleting") {
      return errorResponse("任务正在删除", 409);
    }
    const queued = enqueueChatMessage(task.id, {
      agentText: agentText || fallbackText,
      displayText: text || fallbackText,
      imageAbsPaths,
      savedImages,
      attachmentAbsPaths:
        attachmentAbsPaths.length > 0 ? attachmentAbsPaths : undefined,
      attachmentMetas:
        attachmentAbsPaths.length > 0 ? attachResult.metas : undefined,
      enqueuedAt: Date.now(),
    });
    if (!queued.ok) {
      return errorResponse("排队已满", 409);
    }
    // R31-1：记下当前条 itemId（队列优先启动路径稍后原样回给客户端）
    lastEnqueuedItemId = queued.itemId;
    const fresh = await getTask(task.id);
    return new Response(
      JSON.stringify({
        ok: true,
        queued: true,
        queuedCount: queued.queuedCount,
        // R31-1：稳定 itemId，前端 pending 对账用
        itemId: queued.itemId,
        task: fresh ?? task,
      }),
      { status: 202, headers: { "Content-Type": "application/json" } },
    );
  };

  // 首条消息派生标题：占位「对话 · 时间」被用户首条消息前 ~24 字覆盖（first-message-wins、
  // 对齐 codex / Cursor Agent Window）。放在启 agent 之前——这样后续 setTaskRunStatus
  // 读到的 meta 已是新标题、publish 的 task 一次带上新名、侧栏不闪旧占位。
  // （后落后：标题仍在 send / runChatSession 之前更新，与「写完 user_reply 再启 agent」等效。）
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

  // compact 进行中：一律入队（勿 send / 勿懒重启 / 勿起新会话），等 compact 完 flush
  if (isChatCompactInProgress(task.id)) {
    return enqueueOrReject();
  }

  // V0.11.1：内存没会话但有落盘锚点（服务重启 / 空闲回收后）→ 先 Agent.resume 接回、
  // 下面统一走「有会话」分支 send 续接、上下文不丢。resume 失败会清锚点、自然落到起新会话。
  // 复审 G1：本请求是预约赢家 → claimRun 认领首发，勿在通用 resume 里无条件 flush。
  // 复审 K1：claim 是实例化 token——保存 resume 返回的 instanceId，后续 owner send /
  // release 都必须带它精确匹配，防止越权操作 stop/forceClear 后换上来的新实例。
  let ownerInstanceId: number | null = null;
  if (
    !hasChatSession(task.id) &&
    task.sessionAgentId &&
    bootArgs?.apiKey &&
    isValidModel(bootArgs.model)
  ) {
    ownerInstanceId = await resumeChatSession(
      task,
      {
        apiKey: bootArgs.apiKey,
        model: bootArgs.model,
      },
      { claimRun: true },
    );
  }
  const resumedAsOwner = ownerInstanceId !== null;

  // 决定模式（V0.11）：有存活会话且没 run 在跑 → send 续接；否则 → 起新会话
  if (hasChatSession(task.id)) {
    // 切模型 / 切 MCP / 切 workdir 懒重启：用户可能在上轮答完后改了设置
    //（只存进 task、没动当前会话）。比对会话绑定快照 vs 现在的、任一变了就重开会话。
    const runModel = getChatRunModel(task.id);
    const runMcp = getChatRunDisabledMcp(task.id);
    const runRepos = getChatRunRepoPaths(task.id);
    const mcpUnchanged =
      runMcp === null || stringSetEquals(runMcp, task.disabledMcpServers ?? []);
    // 有序路径列表相等（顺序也算：cwd 取第一项、换序即换 cwd）
    const reposUnchanged =
      runRepos === null ||
      (runRepos.length === task.repoPaths.length &&
        runRepos.every((p, i) => p === task.repoPaths[i]));
    const canRestart = !!bootArgs?.apiKey && isValidModel(bootArgs.model);
    const unchanged =
      !runModel ||
      !canRestart ||
      (modelEquals(runModel, bootArgs!.model!) &&
        mcpUnchanged &&
        reposUnchanged);

    if (unchanged) {
      // P2 #8 + 复审 G1：队列非空或 drain 中 → 入队，勿在已排队消息前插队直接 send。
      // 例外：resume owner 是预约确定的先到者，必须先发自己这条——不得把自己排到
      // 并发输家后面（否则 A resume 后 flush B、A 见 draining 再入队 → 顺序 B→A 反转）。
      // 后续队列等 owner run 结束由统一 flush 排出，FIFO 恢复 A→B。
      if (
        !resumedAsOwner &&
        (getChatQueueCount(task.id) > 0 || isChatQueueDraining(task.id))
      ) {
        return enqueueOrReject();
      }
      // owner 场景 unchanged 必为 true：会话刚用本请求 bootArgs.model / 当前 task 设置建的。
      // try/catch：resume→send 之间任一 throw 必须释放认领；send 成功后勿释放（已是真 run）。
      let sentOk = false;
      try {
        // 快照必须在 agent.send 之前（send 后 consume 即可能改文件）
        const capture = await tryCaptureCheckpoint();
        // ownerInstanceId：owner 实例精确匹配才跳过 runActive 早退（K1）；
        // checkpoint 期间被 stop 摘除 / forceClear 换新实例 → send 内按
        // cancelled / owner_invalid 收敛（L2：取消是终态、绝不能当可重试故障）
        const sent = await sendChatMessage(
          task,
          agentText || fallbackText,
          imageAbsPaths,
          attachmentAbsPaths.length > 0 ? attachmentAbsPaths : undefined,
          ownerInstanceId !== null ? { ownerInstanceId } : undefined,
        );
        if (sent === "sent") {
          sentOk = true;
          // R29-4：send 后落盘——失败不能伪装未发送；带 persistWarning
          let persistWarning: string | undefined;
          try {
            const replyEvent = await persistReplyAndCheckpoint(capture);
            if (!replyEvent) {
              // ENOENT（任务已删）→ 原文未落盘，但消息已送达
              persistWarning = PERSIST_WARNING_DELIVERED;
              console.error(
                `[chat-reply] R29-4 已送达但持久化失败（ENOENT/未写）task=${task.id}`,
              );
            }
          } catch (persistErr) {
            console.error(
              `[chat-reply] R29-4 已送达但持久化失败 task=${task.id}:`,
              persistErr,
            );
            persistWarning = PERSIST_WARNING_DELIVERED;
          }
          const fresh = await getTask(task.id);
          return new Response(
            JSON.stringify({
              ok: true,
              task: fresh ?? task,
              autoStarted: false,
              ...(persistWarning ? { persistWarning } : {}),
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        // L2/K1：owner claim 在 checkpoint 窗口被用户 stop 摘除 → 明确 409 终止，
        // 绝不落到下面「起新会话」把这条消息重放出去（AI 在「已停止」后又启动）
        if (sent === "cancelled") {
          return errorResponse("对话已被停止、本条消息未发送，请重新发送", 409);
        }
        // L2：owner 实例被替换（懒重启 forceClear 等）→ 同样终止，
        // 不得把消息发给新实例、也不得入 mode 2 重放
        if (sent === "owner_invalid") {
          return errorResponse(
            "会话已被重启、本条消息未发送，请重新发送",
            409,
          );
        }
        // busy：run 在跑 / rewind / compact 门闩中 → P5.1 入队（202）；
        // owner 早退路径已在 sendChatMessage 内释放认领
        if (sent === "busy") {
          const queuedResp = await enqueueOrReject();
          // 复审（11 轮）：owner busy 时 release 发生在 enqueue 之前——若 release
          // 当时 queue=0（没调度 drain）、且门闩在 release→enqueue 之间解除，这条
          // 202 入队的消息会永久悬空（idle + 队列非空 + 无人 drain）。入队成功后
          // 幂等补一次 release：内部见 queue>0 且非 draining 会补调度 deferred drain。
          if (queuedResp.status === 202 && ownerInstanceId !== null) {
            releaseChatRunClaim(task.id, ownerInstanceId);
          }
          return queuedResp;
        }
        // no_session / send_failed：会话没了（send 抛错已 close / record 消失）
        // → 落到下面起新会话；防御复查：极端竞态下别处刚起了会话 / compact 则入队
        if (hasChatSession(task.id) || isChatCompactInProgress(task.id)) {
          return enqueueOrReject();
        }
      } catch (err) {
        // K1：release 必须带 claim 的 instanceId——实例已被替换时内部 no-op、不碰新实例
        if (!sentOk && ownerInstanceId !== null) {
          releaseChatRunClaim(task.id, ownerInstanceId);
        }
        throw err;
      }
    } else {
      // owner 理论上不会进懒重启（会话刚用本请求设置建的）；防御释放认领
      if (ownerInstanceId !== null) releaseChatRunClaim(task.id, ownerInstanceId);

      // V0.10.1：更新就位未重启 → 起新会话必挂死。懒重启会关掉还健康的旧会话、拦在关之前
      const pendingRestartMsg = await checkUpdatePendingRestart();
      if (pendingRestartMsg) return errorResponse(pendingRestartMsg, 409);

      // 模型 / MCP / workdir 变了 → 懒重启：关旧会话、起新会话（这条消息作首条）、
      // 历史靠 events.jsonl 续上（buildInitialPrompt 已给 agent eventsLogPath）
      cancelChatRun(task.id);
      const stopped = await waitForChatToStop(
        task.id,
        CHAT_RESTART_STOP_TIMEOUT_MS,
      );
      if (!stopped) {
        console.warn(
          `[chat-reply] task=${task.id} 懒重启：旧会话没在 ${CHAT_RESTART_STOP_TIMEOUT_MS}ms 内退、强清继续`,
        );
        forceClearChatRun(task.id);
      }
    }
  }

  // 模式 2：起新会话（首条 / 会话已关 / 懒重启后）
  // 校验 bootArgs——先于落事件，缺凭据不写假「已发送」
  if (!bootArgs?.apiKey || typeof bootArgs.apiKey !== "string") {
    return errorResponse("缺 bootArgs.apiKey、起新会话必传");
  }
  if (!isValidModel(bootArgs.model)) {
    return errorResponse("bootArgs.model 非法");
  }

  // 防重复启动：会话还在 / compact 中（send 失败但 run 在跑等 race）→ 同样入队
  if (hasChatSession(task.id) || isChatCompactInProgress(task.id)) {
    return enqueueOrReject();
  }

  // P1 #6 / S1：同步占「起新会话」lease。并发首条 / rewind 进行中 → 失败方入队，
  // 避免两个请求都过 hasChatSession===false 后各自 fire runChatSession、后者被吞。
  // token 供后续每个 await 后复查；stop/DELETE 的 cancelChatStart 会使 lease 失效。
  const startToken = tryReserveChatStart(task.id);
  if (startToken === null) {
    return enqueueOrReject();
  }

  // S1：lease 被 stop/DELETE 撤销 → 409（对齐 send 路径「对话已被停止」文案）
  const leaseAbortedResponse = (): Response =>
    errorResponse("对话已被停止或任务已删除、本条消息未发送，请重新发送", 409);

  // N3：agentStarted 标记「会话已可被 flush 消费」。runChatSession 同步 prologue
  // 即注册 runningChats，fire 后立刻置 true；finally 据此判断要不要清滞留队列。
  let agentStarted = false;
  // 复审（11 轮）：当前消息入队被拒（队满 / rewind 门闩 409）≠ 启动失败——
  // 此时队里已 202 的消息不能被 finally 补偿误清（语义是「本条进不去」而非「整队作废」），
  // 它们等下一个请求走 R3 队列优先启动消费。
  let skipQueueCompensation = false;
  try {
    // V0.10.1：更新就位未重启 → 起新 Run 必挂死、拦在标 running 之前
    const pendingRestartMsg = await checkUpdatePendingRestart();
    // S1：await 后复查 lease（stop/DELETE 可能发生在 pendingRestart 检查期间）
    if (!isChatStartLeaseValid(task.id, startToken)) {
      return leaseAbortedResponse();
    }
    if (pendingRestartMsg) return errorResponse(pendingRestartMsg, 409);

    // R3：队列优先启动——预约赢家失败后滞留 / 并发输家入队时，不得用当前消息插队作 firstMessage
    if (getChatQueueCount(task.id) > 0) {
      // 先把当前消息入队保序；队满 / rewind 门闩 → 409（finally 仍 release、但不清队）
      const enqueued = await enqueueOrReject();
      if (enqueued.status !== 202) {
        skipQueueCompensation = true;
        return enqueued;
      }

      const head = dequeueChatMessage(task.id);
      if (!head) {
        // 刚检查 count>0 并入队，理论上必有队首；抛出让 finally 清队告知
        throw new Error("队列优先启动：dequeue 得到空队首");
      }

      // N3-2：head 已出队；到 runChatSession 置 agentStarted 之前任一步抛错 / lease 失效，
      // 须塞回队首，否则已 202 的那条静默丢失、提示数量还少一条。
      let replyEventPersisted = false;
      /** S1：lease 失效时塞回队首再 409（与 catch 同口径） */
      const abortLeaseAndRequeue = (): Response => {
        if (replyEventPersisted) head.skipPersistEvent = true;
        enqueueChatMessageFront(task.id, head);
        return leaseAbortedResponse();
      };
      try {
        let firstMessageEventId: string | undefined;
        if (head.skipPersistEvent) {
          // 入队方已落过 user_reply：不落事件、不打 checkpoint，直接以其内容起会话
        } else {
          // 队首尚未落事件 → 先快照再按队首字段写 user_reply（形状对齐 persistUserReply）
          const capture = await tryCaptureCheckpoint();
          // S1：checkpoint 可能很慢——落 user_reply 之前必须复查，绝不为已删任务写气泡
          if (!isChatStartLeaseValid(task.id, startToken)) {
            return abortLeaseAndRequeue();
          }
          const meta: Record<string, unknown> = {};
          if (head.savedImages && head.savedImages.length > 0) {
            meta.images = head.savedImages;
          }
          if (head.attachmentMetas && head.attachmentMetas.length > 0) {
            meta.attachments = head.attachmentMetas;
          }
          if (capture.ok) meta.checkpointed = true;
          // R29-4：队列补给 user_reply——send/start 前 strict；失败 5xx、塞回队首、不起 session
          let replyEvent;
          try {
            replyEvent = await writeUserEventAndPublishStrict(task.id, {
              kind: "user_reply",
              text: head.displayText,
              meta: Object.keys(meta).length > 0 ? meta : undefined,
            });
          } catch (persistErr) {
            console.error(
              `[chat-reply] R29-4 队列补给落盘失败 task=${task.id}:`,
              persistErr,
            );
            enqueueChatMessageFront(task.id, head);
            return errorResponse(PERSIST_FAIL_RETRY_MESSAGE, 500);
          }
          if (!replyEvent) {
            // ENOENT：任务已删——塞回并按 lease 失效收敛（abort 内会 enqueueFront）
            return abortLeaseAndRequeue();
          }
          // user_reply 已落盘：后续若 setTaskRunStatus 等失败、塞回时须 skipPersistEvent，
          // 否则 flush 补给会再落一条重复气泡
          replyEventPersisted = true;
          if (capture.ok) {
            await persistCheckpointForReply(task.id, replyEvent.id, capture);
          }
          firstMessageEventId = replyEvent.id;
        }

        // S1：置 running / 起 session 前最后复查
        if (!isChatStartLeaseValid(task.id, startToken)) {
          return abortLeaseAndRequeue();
        }
        const runningTask = await setTaskRunStatus(task.id, "running");
        // meta 已删 → 不得用内存 stale task 启动
        if (!runningTask || !isChatStartLeaseValid(task.id, startToken)) {
          return abortLeaseAndRequeue();
        }
        publishTaskStreamEvent(task.id, { kind: "task", task: runningTask });

        // S1：fire 前最后一道 lease 校验
        if (!isChatStartLeaseValid(task.id, startToken)) {
          return abortLeaseAndRequeue();
        }
        void runChatSession({
          task: runningTask,
          apiKey: bootArgs.apiKey,
          model: bootArgs.model,
          firstMessage: {
            text: head.agentText,
            imagePaths: head.imageAbsPaths,
            attachmentPaths: head.attachmentAbsPaths,
          },
          firstMessageEventId,
          startToken,
        }).catch((err) => {
          console.error(
            `[chat-reply] runChatSession task=${task.id} failed:`,
            err,
          );
        });
        // 同步 prologue 已注册 runningChats，此后队列可由 flush 消费
        agentStarted = true;
      } catch (innerErr) {
        // 塞回前：若本分支已成功落过 user_reply，标记 skipPersistEvent 防重复气泡
        if (replyEventPersisted) {
          head.skipPersistEvent = true;
        }
        enqueueChatMessageFront(task.id, head);
        throw innerErr;
      }

      // 当前消息确实入队了 → 202 queued（与普通入队响应对齐）
      const fresh = await getTask(task.id);
      return new Response(
        JSON.stringify({
          ok: true,
          queued: true,
          queuedCount: getChatQueueCount(task.id),
          // R31-1：回传当前条 itemId（enqueueOrReject 时记下）
          itemId: lastEnqueuedItemId,
          task: fresh ?? task,
        }),
        { status: 202, headers: { "Content-Type": "application/json" } },
      );
    }

    // 确定会起新会话 → 先快照再落 user_reply（runner 要 firstMessageEventId 锚定本轮回答义务）
    const capture = await tryCaptureCheckpoint();
    // S1：checkpoint 窗口是 stop/DELETE 高频命中区——落 user_reply 前必须复查
    if (!isChatStartLeaseValid(task.id, startToken)) {
      return leaseAbortedResponse();
    }
    // R29-4：start 前落盘失败 → 5xx、不起 session
    let replyEvent;
    try {
      replyEvent = await persistReplyAndCheckpoint(capture);
    } catch (persistErr) {
      console.error(
        `[chat-reply] R29-4 起会话前落盘失败 task=${task.id}:`,
        persistErr,
      );
      return errorResponse(PERSIST_FAIL_RETRY_MESSAGE, 500);
    }
    if (!replyEvent) {
      // ENOENT：任务已删
      return leaseAbortedResponse();
    }

    // S1：置 running 前复查
    if (!isChatStartLeaseValid(task.id, startToken)) {
      return leaseAbortedResponse();
    }
    // 切 task.runStatus=running、fire-and-forget runChatSession
    const runningTask = await setTaskRunStatus(task.id, "running");
    // S1：meta 已删时 setTaskRunStatus 返 null——绝不能 `runningTask ?? task` 用 stale 启动
    if (!runningTask || !isChatStartLeaseValid(task.id, startToken)) {
      return leaseAbortedResponse();
    }
    publishTaskStreamEvent(task.id, { kind: "task", task: runningTask });

    // S1：runChatSession 前最后一道校验
    if (!isChatStartLeaseValid(task.id, startToken)) {
      return leaseAbortedResponse();
    }
    void runChatSession({
      task: runningTask,
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
      startToken,
    }).catch((err) => {
      console.error(`[chat-reply] runChatSession task=${task.id} failed:`, err);
    });
    agentStarted = true;

    const fresh = await getTask(task.id);
    return new Response(
      JSON.stringify({ ok: true, task: fresh ?? task, autoStarted: true }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  } finally {
    // 幂等：runChatSession 同步 prologue 已带 token release 过也无妨；
    // 兜的是中途 throw / early return（pendingRestart / lease 失效等）的预约泄漏
    releaseChatStart(task.id, startToken);

    // N3：补偿统一放 finally（覆盖 throw 与所有 early return，含 409 pendingRestart）。
    // 条件：会话没真正起来、队列非空、且尚无存活会话 → 否则滞留队列无人消费。
    // 顺序：先同步 clearChatQueue（不可被阻断），再 best-effort 落 info——
    // 复审 N3-3：补偿不能排在可失败的日志后面。
    if (
      !skipQueueCompensation &&
      !agentStarted &&
      getChatQueueCount(task.id) > 0 &&
      !hasChatSession(task.id)
    ) {
      const n = getChatQueueCount(task.id);
      clearChatQueue(task.id);
      try {
        // R29-1：清队系统通知写+publish 同链
        await writeEventAndPublish(task.id, {
          kind: "info",
          text: `会话未能启动，${n} 条排队消息未送达、请重新发送`,
        });
      } catch (logErr) {
        console.warn(
          `[chat-reply] 清队后写 info 失败 task=${task.id}:`,
          logErr,
        );
      }
    }
  }
};
