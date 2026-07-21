/**
 * chat 用户消息注入（从 chat-reply route 抽出）
 *
 * HTTP 路由与飞书桥接 router 共用同一套逻辑，保证行为零漂移。
 * main R29~R42 message-operation 协议的完整实现在此；route 仅薄壳。
 *
 * `userReplyMetaExtra` 供桥接写入 `meta.source: "feishu"` 等标记：
 *   - persistUserReply 合并进 user_reply.meta
 *   - enqueue 条目携带 extraMeta（flush / 队列优先补给落盘时再合并）
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
  isChatQueueDraining,
  isChatRunActive,
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
  beginChatQueueInFlight,
  claimMessageOperation,
  dequeueChatMessage,
  endChatQueueInFlight,
  enqueueChatMessage,
  enqueueChatMessageFront,
  failQueuedItems,
  fingerprintFromMessagePayload,
  getChatQueueCount,
  getChatQueueGeneration,
  getMessageOperation,
  isMessageOperationTerminal,
  markMessagePersisted,
  settleMessageFailed,
  settleMessageHandedOff,
  type MessageOpHandle,
} from "@/lib/server/chat-queue";
import { failpoint } from "@/lib/server/failpoints";
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


export interface ChatInjectBody {
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
  /**
   * 客户端预生成的 queue itemId；服务端优先采用（无则退回发号）。
   * 消除「202 晚到、终态已到」时前端尚无 id 可记的窗口。
   */
  clientItemId?: string;
  /**
   * 客户端已算好的 payload 指纹（与共享 FNV 算法一致）。
   * 优先信任；缺失时 server 用同一函数兜底自算。
   */
  payloadFingerprint?: string;
}

export interface ChatInjectOptions {
  /** 合并进 user_reply.meta（如飞书来源标记 / feishuMessageId） */
  userReplyMetaExtra?: Record<string, unknown>;
}

const MAX_IMAGES_PER_REPLY = 6;
const MAX_ATTACHMENTS_PER_REPLY = 10;
const MAX_SKILLS_PER_REPLY = 8;
// 切模型懒重启：cancel 旧 Run 后等它真退的上限（对齐 task-runner force-new 的 5s）、超时强清继续
const CHAT_RESTART_STOP_TIMEOUT_MS = 5000;


/**
 * 注入一条 chat 用户消息。返回值形态与原 chat-reply HTTP 响应一致（便于 route 原样透传）。
 * `userReplyMetaExtra` 供桥接写入 meta.source / feishuMessageId 等标记。
 */
export const handleChatReplyInject = async (
  id: string,
  body: unknown,
  options: ChatInjectOptions = {},
): Promise<Response> => {
  const parsed = (body ?? {}) as ChatInjectBody;

  const text = parsed.text?.trim() ?? "";

  // 校验 images
  const imagesResult = parseAndValidateImages(
    parsed.images,
    MAX_IMAGES_PER_REPLY,
  );
  if (!imagesResult.ok) return imagesResult.errorResponse;
  const images = imagesResult.images;

  // 校验 attachments：必须绝对路径、必须存在（helper 跟 question 路由共用）
  const attachResult = await parseAndValidateAttachments(
    parsed.attachments,
    MAX_ATTACHMENTS_PER_REPLY,
  );
  if (!attachResult.ok) return attachResult.errorResponse;
  const attachmentAbsPaths = attachResult.paths;

  // skill 引用：指引只拼进 agent 消息、事件气泡存用户原文
  const skillsResult = parseAndValidateSkills(parsed.skills, MAX_SKILLS_PER_REPLY);
  if (!skillsResult.ok) return skillsResult.errorResponse;
  const skills = skillsResult.skills;

  // 客户端预生成 itemId（可选；无则服务端兜底发号）
  const clientItemId =
    typeof parsed.clientItemId === "string" && parsed.clientItemId.trim()
      ? parsed.clientItemId.trim()
      : undefined;

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

  // stop/DELETE 收尾窗口——禁止新消息（含入队），否则 202 后被 clearChatQueue 静默丢
  const lifecycle = getChatLifecycle(id);
  if (lifecycle === "stopping") {
    return errorResponse("正在停止对话、请稍后重发", 409);
  }
  if (lifecycle === "deleting") {
    return errorResponse("任务正在删除", 409);
  }

  // 同步原子 claim——必须在 saveImageAttachments / checkpoint / send 之前。
  // 赢家拿唯一 handle；route 外层 try/finally 只认 transfer / settle / release。
  const payloadFingerprint = clientItemId
    ? typeof parsed.payloadFingerprint === "string" &&
      parsed.payloadFingerprint.trim()
      ? parsed.payloadFingerprint.trim()
      : fingerprintFromMessagePayload({
          text,
          images,
          attachmentPaths: attachmentAbsPaths,
          skills,
        })
    : "";
  /** 本请求 claim 赢家 handle（失败者早退、无 handle） */
  let opHandle: MessageOpHandle | null = null;
  if (clientItemId) {
    const claim = claimMessageOperation(id, clientItemId, payloadFingerprint);
    if (claim.status === "payload_mismatch") {
      // 结构化 409，供 client 区分「队满」与 payload 冲突
      return new Response(
        JSON.stringify({
          ok: false,
          error: "payloadMismatch：同 clientItemId 已受理其它内容，请生成新 id 重发",
          payloadMismatch: true,
          itemId: clientItemId,
        }),
        { status: 409, headers: { "Content-Type": "application/json" } },
      );
    }
    if (claim.status === "active") {
      const freshActive = await getTask(id);
      return new Response(
        JSON.stringify({
          ok: true,
          queued: true,
          queuedCount: claim.queuedCount,
          itemId: clientItemId,
          alreadyAccepted: true,
          phase: claim.phase,
          task: freshActive ?? task,
        }),
        { status: 202, headers: { "Content-Type": "application/json" } },
      );
    }
    if (claim.status === "settled") {
      const freshSettled = await getTask(id);
      return new Response(
        JSON.stringify({
          ok: true,
          settled: true,
          itemId: clientItemId,
          outcome: claim.outcome,
          task: freshSettled ?? task,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    opHandle = claim.handle;
  }

  // claim 之后全部业务包进 try/finally——任何 4xx/5xx/throw 不得留下幽灵 accepting
  try {
  // 测试可在 claim 后、附件落盘前挂起——并发同 id 第二个应已在 claim 被挡
  await failpoint("chatReply.afterClaim");

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
      // 挂到 handle；transfer 前提前失败会回滚本批文件
      opHandle?.stageAttachments(imageAbsPaths);
    } catch (err) {
      // 附件落盘失败 → finally release（允许同 id 重试）
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
  // 用户原文走 strict——IO 失败抛错，不得吞成「成功但无气泡」
  // direct 路径也写 meta.queueItemId（与 queued 同字段、前端 id 对账）
  const persistUserReply = async (checkpointed: boolean) => {
    // userReplyMetaExtra（飞书 source / feishuMessageId）并进 meta——直连与起会话路径共用
    const meta: Record<string, unknown> = {
      ...userReplyMeta,
      ...(options.userReplyMetaExtra ?? {}),
    };
    if (checkpointed) meta.checkpointed = true;
    if (clientItemId) meta.queueItemId = clientItemId;
    return writeUserEventAndPublishStrict(task.id, {
      kind: "user_reply",
      // 纯附件消息气泡不放占位文案（2026-07-20 用户拍板）——缩略图/chip 本身就是内容
      text,
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

  /** 队列优先启动路径复用「刚入队的当前条」itemId */
  let lastEnqueuedItemId: string | undefined;

  /**
   * rewind 门闩下不得入队。入队是同步内存操作，检查与 enqueue 之间无 await 即原子；
   * rewind 占门闩后会复查 queueCount>0 并拒绝回退——两边交叉闭合。
   * 统一「检查门闩 → enqueue → 满则 409 → 202」消掉 5 处复制粘贴。
   */
  const enqueueOrReject = async (): Promise<Response> => {
    // 与 rewind 占门闩后复查 queueCount 交叉闭合：门闩已占则绝不入队
    //（否则 202 后 rewind 清队列，消息静默消失）
    // 软拒绝不手动 release——外层 finally 统一 release accepting
    if (isChatRewindInProgress(task.id)) {
      return errorResponse("正在回退到检查点、请稍后重发", 409);
    }
    // 与 rewind 同款交叉闭合——stop 收尾期间入队会在 clearChatQueue 时静默丢
    const life = getChatLifecycle(task.id);
    if (life === "stopping") {
      return errorResponse("正在停止对话、请稍后重发", 409);
    }
    if (life === "deleting") {
      return errorResponse("任务正在删除", 409);
    }
    const queued = enqueueChatMessage(task.id, {
      // 优先用客户端预生成 id（兼容无 clientItemId 的旧入口 / task 侧）
      itemId: clientItemId,
      agentText: agentText || fallbackText,
      // 排队气泡同样不放占位文案（缩略图/chip 就是内容）
      displayText: text,
      imageAbsPaths,
      savedImages,
      attachmentAbsPaths:
        attachmentAbsPaths.length > 0 ? attachmentAbsPaths : undefined,
      attachmentMetas:
        attachmentAbsPaths.length > 0 ? attachResult.metas : undefined,
      enqueuedAt: Date.now(),
      // 来源标记跟着队列走：flush / 队列优先补给落 user_reply 时合并进 meta
      extraMeta:
        options.userReplyMetaExtra &&
        Object.keys(options.userReplyMetaExtra).length > 0
          ? options.userReplyMetaExtra
          : undefined,
    });
    if (!queued.ok) {
      // 同 id 已在 recentSettled → 终态 JSON（禁止再 append）
      if (queued.reason === "already_settled") {
        const freshSettled = await getTask(task.id);
        return new Response(
          JSON.stringify({
            ok: true,
            settled: true,
            itemId: queued.itemId,
            outcome: queued.outcome,
            task: freshSettled ?? task,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      // 队满：finally 释放 claim + 回滚 staged，允许稍后同 id 重试
      return errorResponse("排队已满", 409);
    }
    // 记下当前条 itemId（队列优先启动路径稍后原样回给客户端）
    lastEnqueuedItemId = queued.itemId;
    // 入队成功 → transfer 给 queue（finally 不再 release）
    opHandle?.transfer();
    // 幂等命中（已 active）→ 直接同语义 202，不再挂 afterEnqueue
    if (!queued.alreadyAccepted) {
      // 测试可在入队后、202 返回前挂起（模拟 getTask/网络慢于 stop 终态）
      await failpoint("chatReply.afterEnqueue");
    }
    const fresh = await getTask(task.id);
    return new Response(
      JSON.stringify({
        ok: true,
        queued: true,
        queuedCount: queued.queuedCount,
        // 稳定 itemId，前端 pending 对账用
        itemId: queued.itemId,
        // 同 id 重试命中 active 时标 alreadyAccepted（与新受理区分）
        ...(queued.alreadyAccepted ? { alreadyAccepted: true } : {}),
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
  const bootArgs = parsed.bootArgs;

  // V0.11.1：内存没会话但有落盘锚点（服务重启 / 空闲回收后）→ 先 Agent.resume 接回、
  // 下面统一走「有会话」分支 send 续接、上下文不丢。resume 失败会清锚点、自然落到起新会话。
  // 本请求是预约赢家 → claimRun 认领首发，勿在通用 resume 里无条件 flush。
  // claim 是实例化 token——保存 resume 返回的 instanceId，后续 owner send /
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
      // 队列非空或 drain 中 → 入队，勿在已排队消息前插队直接 send。
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
        // ownerInstanceId：owner 实例精确匹配才跳过 runActive 早退；
        // checkpoint 期间被 stop 摘除 / forceClear 换新实例 → send 内按
        // cancelled / owner_invalid 收敛（取消是终态、绝不能当可重试故障）
        const sent = await sendChatMessage(
          task,
          agentText || fallbackText,
          imageAbsPaths,
          attachmentAbsPaths.length > 0 ? attachmentAbsPaths : undefined,
          ownerInstanceId !== null ? { ownerInstanceId } : undefined,
        );
        if (sent === "sent") {
          sentOk = true;
          // send===sent 即 handedOff（agent 已接管）；落盘失败仍算已送达
          if (clientItemId) {
            settleMessageHandedOff(task.id, clientItemId);
          }
          // send 后落盘——失败不能伪装未发送；带 persistWarning
          let persistWarning: string | undefined;
          try {
            const replyEvent = await persistReplyAndCheckpoint(capture);
            if (replyEvent && clientItemId) {
              // 已 handedOff；markPersisted 对终态 no-op，保留调用语义清晰
              markMessagePersisted(task.id, clientItemId);
            }
            if (!replyEvent) {
              // ENOENT（任务已删）→ 原文未落盘，但消息已送达
              persistWarning = PERSIST_WARNING_DELIVERED;
              console.error(
                `[chat-reply] 已送达但持久化失败（ENOENT/未写）task=${task.id}`,
              );
            }
          } catch (persistErr) {
            console.error(
              `[chat-reply] 已送达但持久化失败 task=${task.id}:`,
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
              // direct 也回 itemId，便于 client 对账 / 同 id 重试命中 settled
              ...(clientItemId ? { itemId: clientItemId, settled: true, outcome: "delivered" } : {}),
              ...(persistWarning ? { persistWarning } : {}),
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        // owner claim 在 checkpoint 窗口被用户 stop 摘除 → 明确 409 终止，
        // 绝不落到下面「起新会话」把这条消息重放出去（AI 在「已停止」后又启动）
        // finally 释放 accepting
        if (sent === "cancelled") {
          return errorResponse("对话已被停止、本条消息未发送，请重新发送", 409);
        }
        // owner 实例被替换（懒重启 forceClear 等）→ 同样终止，
        // 不得把消息发给新实例、也不得入 mode 2 重放
        if (sent === "owner_invalid") {
          return errorResponse(
            "会话已被重启、本条消息未发送，请重新发送",
            409,
          );
        }
        // busy：run 在跑 / rewind 门闩中 → P5.1 入队（202）；
        // owner 早退路径已在 sendChatMessage 内释放认领
        if (sent === "busy") {
          const queuedResp = await enqueueOrReject();
          // owner busy 时 release 发生在 enqueue 之前——若 release
          // 当时 queue=0（没调度 drain）、且门闩在 release→enqueue 之间解除，这条
          // 202 入队的消息会永久悬空（idle + 队列非空 + 无人 drain）。入队成功后
          // 幂等补一次 release：内部见 queue>0 且非 draining 会补调度 deferred drain。
          if (queuedResp.status === 202 && ownerInstanceId !== null) {
            releaseChatRunClaim(task.id, ownerInstanceId);
          }
          return queuedResp;
        }
        // no_session / send_failed：会话没了（send 抛错已 close / record 消失）
        // → 落到下面起新会话；防御复查：极端竞态下别处刚起了会话则入队
        if (hasChatSession(task.id)) {
          return enqueueOrReject();
        }
      } catch (err) {
        // release 必须带 claim 的 instanceId——实例已被替换时内部 no-op、不碰新实例
        // message op 由外层 finally 统一 release（堵住 rethrow 幽灵 accepting）
        if (!sentOk && ownerInstanceId !== null) {
          releaseChatRunClaim(task.id, ownerInstanceId);
        }
        throw err;
      }
    } else {
      // owner 理论上不会进懒重启（会话刚用本请求设置建的）；防御释放认领
      if (ownerInstanceId !== null) releaseChatRunClaim(task.id, ownerInstanceId);

      // V0.10.1：更新就位未重启 → 起新会话必挂死。懒重启会关掉还健康的旧会话、拦在关之前
      // 409 走外层 finally release（堵住原 claimedThisRequest 漏口）
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
  // 400 由外层 finally release
  if (!bootArgs?.apiKey || typeof bootArgs.apiKey !== "string") {
    return errorResponse("缺 bootArgs.apiKey、起新会话必传");
  }
  if (!isValidModel(bootArgs.model)) {
    return errorResponse("bootArgs.model 非法");
  }

  // 防重复启动：会话还在（send 失败但 run 在跑等 race）→ 同样入队
  if (hasChatSession(task.id)) {
    return enqueueOrReject();
  }

  // 同步占「起新会话」lease。并发首条 / rewind 进行中 → 失败方入队，
  // 避免两个请求都过 hasChatSession===false 后各自 fire runChatSession、后者被吞。
  // token 供后续每个 await 后复查；stop/DELETE 的 cancelChatStart 会使 lease 失效。
  const startToken = tryReserveChatStart(task.id);
  if (startToken === null) {
    return enqueueOrReject();
  }

  // lease 被 stop/DELETE 撤销 → 409（对齐 send 路径「对话已被停止」文案）
  const leaseAbortedResponse = (): Response =>
    errorResponse("对话已被停止或任务已删除、本条消息未发送，请重新发送", 409);

  // agentStarted 标记「会话已可被 flush 消费」。runChatSession 同步 prologue
  // 即注册 runningChats，fire 后立刻置 true；finally 据此判断要不要清滞留队列。
  let agentStarted = false;
  // 当前消息入队被拒（队满 / rewind 门闩 409）≠ 启动失败——
  // 此时队里已 202 的消息不能被 finally 补偿误清（语义是「本条进不去」而非「整队作废」），
  // 它们等下一个请求走 队列优先启动消费。
  let skipQueueCompensation = false;
  try {
    // V0.10.1：更新就位未重启 → 起新 Run 必挂死、拦在标 running 之前
    const pendingRestartMsg = await checkUpdatePendingRestart();
    // await 后复查 lease（stop/DELETE 可能发生在 pendingRestart 检查期间）
    // 未 transfer 前由外层 finally release
    if (!isChatStartLeaseValid(task.id, startToken)) {
      return leaseAbortedResponse();
    }
    if (pendingRestartMsg) {
      return errorResponse(pendingRestartMsg, 409);
    }

    // 队列优先启动——预约赢家失败后滞留 / 并发输家入队时，不得用当前消息插队作 firstMessage
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

      // dequeue 后立即登记 in-flight——checkpoint/落盘/启动全程 active
      beginChatQueueInFlight(task.id, head.itemId);
      const genAtDequeue = getChatQueueGeneration(task.id);

      // head 已出队；抛错 / lease 失效须塞回，但 generation 变了
      // 或已真终态（handedOff/failed）不得复活。persisted 非终态 → 允许 skipPersist 重排。
      let replyEventPersisted = false;
      const requeueHeadIfSameGen = (): void => {
        if (getChatQueueGeneration(task.id) !== genAtDequeue) {
          // 已被 stop/DELETE 等 sink 清掉——只收尾 in-flight，禁止 enqueueFront 复活
          endChatQueueInFlight(task.id);
          return;
        }
        // 仅真终态拒绝重排（不再用 recentSettled delivered 误挡 persisted）
        if (isMessageOperationTerminal(task.id, head.itemId)) {
          endChatQueueInFlight(task.id);
          return;
        }
        if (replyEventPersisted) head.skipPersistEvent = true;
        enqueueChatMessageFront(task.id, head);
        endChatQueueInFlight(task.id);
      };
      /** lease 失效时塞回队首再 409（与 catch 同口径） */
      const abortLeaseAndRequeue = (): Response => {
        requeueHeadIfSameGen();
        return leaseAbortedResponse();
      };
      /**
       * persisted 后无法重排时提交明确 failed（UI 未送达），禁止留下 delivered 假账。
       */
      const failHeadIfPersistedOrRequeue = (): void => {
        if (replyEventPersisted && getChatQueueGeneration(task.id) !== genAtDequeue) {
          // generation 已变 = sink 已处理；若尚未终态则补 failed
          if (!isMessageOperationTerminal(task.id, head.itemId)) {
            settleMessageFailed(task.id, head.itemId, "stopped");
          }
          endChatQueueInFlight(task.id);
          return;
        }
        requeueHeadIfSameGen();
      };
      try {
        let firstMessageEventId: string | undefined;
        if (head.skipPersistEvent) {
          // 入队方已落过 user_reply：不落事件、不打 checkpoint，直接以其内容起会话
          // 仍是 persisted，handoff 成功后才 settle delivered
          markMessagePersisted(task.id, head.itemId);
          replyEventPersisted = true;
          await failpoint("chatReply.afterQueuePriorityPersist");
        } else {
          // 队首尚未落事件 → 先快照再按队首字段写 user_reply（形状对齐 persistUserReply）
          const capture = await tryCaptureCheckpoint();
          // 测试可在 checkpoint 后挂起——此时 queue_state 必须仍含 head id
          await failpoint("chatReply.afterQueuePriorityCheckpoint");
          // checkpoint 可能很慢——落 user_reply 之前必须复查，绝不为已删任务写气泡
          if (!isChatStartLeaseValid(task.id, startToken)) {
            return abortLeaseAndRequeue();
          }
          // head.extraMeta（飞书 source 等）浅合并——与 flushChatQueue 补给同口径
          const meta: Record<string, unknown> = { ...(head.extraMeta ?? {}) };
          if (head.savedImages && head.savedImages.length > 0) {
            meta.images = head.savedImages;
          }
          if (head.attachmentMetas && head.attachmentMetas.length > 0) {
            meta.attachments = head.attachmentMetas;
          }
          if (capture.ok) meta.checkpointed = true;
          // queue-priority head 落盘必须带 queueItemId——两 tab 同文案时按 id 对账、互不清错
          meta.queueItemId = head.itemId;
          // 队列补给 user_reply——send/start 前 strict；失败 5xx、塞回队首、不起 session
          let replyEvent;
          try {
            replyEvent = await writeUserEventAndPublishStrict(task.id, {
              kind: "user_reply",
              text: head.displayText,
              meta,
            });
          } catch (persistErr) {
            console.error(
              `[chat-reply] 队列补给落盘失败 task=${task.id}:`,
              persistErr,
            );
            requeueHeadIfSameGen();
            return errorResponse(PERSIST_FAIL_RETRY_MESSAGE, 500);
          }
          if (!replyEvent) {
            // ENOENT：任务已删——塞回并按 lease 失效收敛（abort 内会 enqueueFront）
            return abortLeaseAndRequeue();
          }
          // user_reply 落盘 → persisted（非终态）；handoff 前可 skipPersist 重排
          replyEventPersisted = true;
          markMessagePersisted(task.id, head.itemId);
          if (capture.ok) {
            await persistCheckpointForReply(task.id, replyEvent.id, capture);
          }
          firstMessageEventId = replyEvent.id;
          // 测试可在 persisted 后、handoff 前挂起（注入 stop/DELETE）
          await failpoint("chatReply.afterQueuePriorityPersist");
        }

        // 置 running / 起 session 前最后复查
        if (!isChatStartLeaseValid(task.id, startToken)) {
          failHeadIfPersistedOrRequeue();
          return leaseAbortedResponse();
        }
        const runningTask = await setTaskRunStatus(task.id, "running");
        // meta 已删 → 不得用内存 stale task 启动
        if (!runningTask || !isChatStartLeaseValid(task.id, startToken)) {
          failHeadIfPersistedOrRequeue();
          return leaseAbortedResponse();
        }
        publishTaskStreamEvent(task.id, { kind: "task", task: runningTask });

        // fire 前最后一道 lease 校验
        if (!isChatStartLeaseValid(task.id, startToken)) {
          failHeadIfPersistedOrRequeue();
          return leaseAbortedResponse();
        }
        // fire runner；handedOff 仅由 runner 在 agent.send resolve 后提交
        const sessionPromise = runChatSession({
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
          clientItemId: head.itemId,
        });
        sessionPromise.catch((err) => {
          console.error(
            `[chat-reply] runChatSession task=${task.id} failed:`,
            err,
          );
        });
        // 让出 microtask：跑完同步 prologue（占位 starting / lease_cancelled / already_running）
        await Promise.resolve();
        if (isMessageOperationTerminal(task.id, head.itemId)) {
          // runner 已 settle failed（lease 等）→ 收尾 in-flight，不伪造 delivered
          endChatQueueInFlight(task.id);
          return leaseAbortedResponse();
        }
        if (isChatRunActive(task.id)) {
          // starting 占位已挂 → transfer 给 runner（非 handedOff）
          agentStarted = true;
          endChatQueueInFlight(task.id);
        } else {
          // lease_cancelled 且未 settle（无 clientItemId 等）→ 重排
          failHeadIfPersistedOrRequeue();
          return leaseAbortedResponse();
        }
      } catch (innerErr) {
        // 塞回前：若本分支已成功落过 user_reply，标记 skipPersistEvent 防重复气泡
        failHeadIfPersistedOrRequeue();
        throw innerErr;
      }

      // 当前消息确实入队了 → 202 queued（与普通入队响应对齐）
      const fresh = await getTask(task.id);
      return new Response(
        JSON.stringify({
          ok: true,
          queued: true,
          queuedCount: getChatQueueCount(task.id),
          // 回传当前条 itemId（enqueueOrReject 时记下）
          itemId: lastEnqueuedItemId,
          task: fresh ?? task,
        }),
        { status: 202, headers: { "Content-Type": "application/json" } },
      );
    }

    // 确定会起新会话 → 先快照再落 user_reply（runner 要 firstMessageEventId 锚定本轮回答义务）
    const capture = await tryCaptureCheckpoint();
    // checkpoint 窗口是 stop/DELETE 高频命中区——落 user_reply 前必须复查
    if (!isChatStartLeaseValid(task.id, startToken)) {
      return leaseAbortedResponse();
    }
    // start 前落盘失败 → 5xx、不起 session（finally release）
    let replyEvent;
    try {
      replyEvent = await persistReplyAndCheckpoint(capture);
    } catch (persistErr) {
      console.error(
        `[chat-reply] 起会话前落盘失败 task=${task.id}:`,
        persistErr,
      );
      return errorResponse(PERSIST_FAIL_RETRY_MESSAGE, 500);
    }
    if (!replyEvent) {
      // ENOENT：任务已删
      return leaseAbortedResponse();
    }
    // firstMessage 落盘 → persisted（非终态）
    if (clientItemId) {
      markMessagePersisted(task.id, clientItemId);
    }

    // 置 running 前复查
    if (!isChatStartLeaseValid(task.id, startToken)) {
      // 已有气泡但未 handoff → 明确 failed，禁止静默丢失
      if (clientItemId) {
        settleMessageFailed(task.id, clientItemId, "stopped");
      }
      return leaseAbortedResponse();
    }
    // 切 task.runStatus=running、fire-and-forget runChatSession
    const runningTask = await setTaskRunStatus(task.id, "running");
    // meta 已删时 setTaskRunStatus 返 null——绝不能 `runningTask ?? task` 用 stale 启动
    if (!runningTask || !isChatStartLeaseValid(task.id, startToken)) {
      if (clientItemId) {
        settleMessageFailed(task.id, clientItemId, "stopped");
      }
      return leaseAbortedResponse();
    }
    publishTaskStreamEvent(task.id, { kind: "task", task: runningTask });

    // runChatSession 前最后一道校验
    if (!isChatStartLeaseValid(task.id, startToken)) {
      if (clientItemId) {
        settleMessageFailed(task.id, clientItemId, "stopped");
      }
      return leaseAbortedResponse();
    }
    const sessionPromise = runChatSession({
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
      // operation 交给 runner；send resolve 后才 handedOff
      clientItemId,
    });
    sessionPromise.catch((err) => {
      console.error(`[chat-reply] runChatSession task=${task.id} failed:`, err);
    });
    // 同步 prologue 后 transfer；禁止占位即 delivered 200
    await Promise.resolve();
    if (clientItemId && isMessageOperationTerminal(task.id, clientItemId)) {
      // runner 已 settle failed
      return leaseAbortedResponse();
    }
    if (!isChatRunActive(task.id)) {
      if (clientItemId && !isMessageOperationTerminal(task.id, clientItemId)) {
        settleMessageFailed(task.id, clientItemId, "startup_failed");
      }
      return leaseAbortedResponse();
    }
    // starting 占位已挂 → transfer 给 runner；HTTP 返 persisted 202
    opHandle?.transfer();
    agentStarted = true;

    const fresh = await getTask(task.id);
    const phase =
      (clientItemId
        ? getMessageOperation(task.id, clientItemId)?.phase
        : undefined) ?? "persisted";
    return new Response(
      JSON.stringify({
        ok: true,
        task: fresh ?? task,
        autoStarted: true,
        // 不伪造 delivered；client 等 handedOff / recentSettled
        ...(clientItemId
          ? { itemId: clientItemId, phase, accepting: phase === "accepting" }
          : {}),
      }),
      { status: 202, headers: { "Content-Type": "application/json" } },
    );
  } finally {
    // 幂等：runChatSession 同步 prologue 已带 token release 过也无妨；
    // 兜的是中途 throw / early return（pendingRestart / lease 失效等）的预约泄漏
    releaseChatStart(task.id, startToken);

    // 补偿统一放 finally（覆盖 throw 与所有 early return，含 409 pendingRestart）。
    // 条件：会话没真正起来、队列非空、且尚无存活会话 → 否则滞留队列无人消费。
    // 先同步 failQueuedItems（唯一 sink、不可被阻断），再 best-effort 落 info——
    // 补偿不能排在可失败的日志后面。
    if (
      !skipQueueCompensation &&
      !agentStarted &&
      getChatQueueCount(task.id) > 0 &&
      !hasChatSession(task.id)
    ) {
      const failedIds = failQueuedItems(task.id, {
        reason: "startup_failed",
      });
      const n = failedIds.length;
      if (n > 0) {
        try {
          // 清队系统通知写+publish 同链
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
  }
  } finally {
    // MessageOperation handle 统一出口（transfer / terminal / release+staged 回滚）
    opHandle?.finalize();
  }
};
