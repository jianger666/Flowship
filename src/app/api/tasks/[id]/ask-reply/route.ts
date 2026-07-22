/**
 * POST /api/tasks/[id]/ask-reply（V0.6：phase → actionId、走 task-runner）
 *
 * V0.3.2 引入：一次 ask_user 调用 = 一组问题 questions[]、UI modal 一次性答完所有问题
 * V0.5.6 引入：deferred、用户可点「稍后再补充」、答案数组可空
 * V0.6 改造：所有 phase 字段改 actionId、publishChatStreamEvent → publishTaskStreamEvent
 *
 * # Body
 *
 * ```
 * {
 *   askId: string;
 *   answers: Array<{ questionId, answer, optionId? }>;
 *   deferred?: boolean;
 *   // V0.8.3：每道题各自绑各自的图（key=questionId）。图-only（不填文字只贴图）也算已答。
 *   imagesByQuestion?: Record<string, Array<{ data, mimeType, filename }>>;
 * }
 * ```
 *
 * # 行为（V0.11：wait 协议退役、send 送达）
 *
 * 1. 校验 task / askId / 没被答过 / pendingAsk 仍是这组问题（token 防旧弹窗答案串新提问）
 * 2. 逐题落盘各自的图、拼接 [ASK_USER_REPLY] 文本（每题答案下内联「本题附图：<basename>」做归属）
 * 3. `agent.send([ASK_USER_REPLY]…)` 续同一会话送达答案（deliverAskReply）
 * 4. 写 ask_user_reply 事件（meta 带 askId + answers + deferred + images 扁平数组给前端渲缩略图）+ publish SSE
 * 5. 响应里的 task 现读 getTask（不再迟到刷 running——deliver/consume 内部已有 owner 门控写）
 */

import path from "node:path";

import type { AskUserAnswer, AskUserQuestion } from "@/lib/types";
import {
  getTask,
  setTaskRunStatusIfRunOwner,
} from "@/lib/server/task-fs";
import { saveImageAttachments } from "@/lib/server/task-artifacts";
import type {
  ImageAttachmentInput,
  ImageAttachmentSaved,
} from "@/lib/server/task-artifacts";
import { clearPendingAsk, getPendingAsk } from "@/lib/server/chat-pending";
import {
  deliverAskReply,
  isTaskOpStale,
  resumeCurrentActionWithMessage,
  supersedePendingAsks,
  TASK_OP_STALE_HTTP_MESSAGE,
} from "@/lib/server/task-runner";
import {
  deliverChatAskReply,
  hasChatSession,
} from "@/lib/server/chat-runner";
import {
  agentSessions,
  getTaskOpGeneration,
  isTaskOpCurrent,
  PERSIST_FAIL_RETRY_MESSAGE,
  PERSIST_WARNING_DELIVERED,
  publishTaskStreamEvent,
  snapshotTaskOp,
  writeEventAndPublish,
  writeUserEventAndPublishStrict,
} from "@/lib/server/task-stream";
import { getChatLifecycle } from "@/lib/server/chat-gate";
import {
  errorResponse,
  parseAndValidateImages,
} from "@/lib/server/route-helpers";

interface Ctx {
  params: Promise<{ id: string }>;
}

interface AnswerPayload {
  questionId?: string;
  answer?: string;
  optionId?: string;
}

interface RawImagePayload {
  data?: string;
  mimeType?: string;
  filename?: string;
}

interface PostBody {
  askId?: string;
  answers?: AnswerPayload[];
  deferred?: boolean;
  imagesByQuestion?: Record<string, RawImagePayload[]>;
  // V0.11.1：会话恢复凭据（服务重启 / 空闲回收后答案靠它 Agent.resume 接回会话送达）
  bootArgs?: {
    apiKey?: string;
    model?: { id?: string; params?: Array<{ id: string; value: string }> };
    gitToken?: string;
  };
}

// 单题最多附 6 张图；全部题加起来最多 12 张（防一次答超多题各塞满图把 agent context 撑爆）
const MAX_IMAGES_PER_QUESTION = 6;
const MAX_IMAGES_TOTAL = 12;

export const runtime = "nodejs";

const extractQuestionsFromMeta = (
  meta: Record<string, unknown> | undefined,
): AskUserQuestion[] => {
  if (!meta || !Array.isArray(meta.questions)) return [];
  const out: AskUserQuestion[] = [];
  for (const item of meta.questions as unknown[]) {
    if (!item || typeof item !== "object") continue;
    const m = item as Record<string, unknown>;
    if (typeof m.id !== "string" || typeof m.question !== "string") continue;
    const options: AskUserQuestion["options"] = [];
    if (Array.isArray(m.options)) {
      for (const optRaw of m.options as unknown[]) {
        if (!optRaw || typeof optRaw !== "object") continue;
        const o = optRaw as Record<string, unknown>;
        if (typeof o.id === "string" && typeof o.label === "string") {
          options.push({ id: o.id, label: o.label });
        }
      }
    }
    out.push({
      id: m.id,
      question: m.question,
      options: options.length > 0 ? options : undefined,
      allowText: typeof m.allowText === "boolean" ? m.allowText : true,
    });
  }
  return out;
};

const buildReplyText = (
  questions: AskUserQuestion[],
  answers: AskUserAnswer[],
  deferred: boolean,
  // 每题落盘后的图（key=questionId）。某题有图就在它的 A 行下内联「本题附图：<basename>」、
  // 让 agent 把文末 [ATTACHED_IMAGES] 里的图按 basename 对回具体问题、不用猜归属。
  savedByQuestion: Record<string, ImageAttachmentSaved[]>,
): string => {
  if (deferred) {
    const sections: string[] = [
      "[ASK_USER_REPLY deferred]",
      "",
      "用户选择**稍后再补充**、未提供任何答案。",
      "请按你判断的合理 default 推进；若有文档产出、把以下问题列入「待澄清 / 不确定项」、对话场景则自行记住即可。",
      "**不要**再就这同一组问题重新调 ask_user——用户已明示稍后补、再问就是冒犯。",
      "",
      "未答问题清单：",
    ];
    questions.forEach((q, idx) => {
      sections.push("", `Q${idx + 1}: ${q.question}`);
    });
    return sections.join("\n");
  }
  const answerMap = new Map(answers.map((a) => [a.questionId, a]));
  const sections: string[] = ["[ASK_USER_REPLY]"];
  questions.forEach((q, idx) => {
    const a = answerMap.get(q.id);
    const imgs = savedByQuestion[q.id] ?? [];
    const rawText = a ? a.answer.trim() : "";
    // 图-only（只贴图没填字）兜底成「见本题附图」、纯没答兜「未回答」
    const ansText =
      rawText.length > 0 ? rawText : imgs.length > 0 ? "（见本题附图）" : "（未回答）";
    // 「答：」不用「A:」——自定义作答时 A: 会被误读成选项 A（用户实测指出）
    sections.push("", `Q${idx + 1}: ${q.question}`, `答：${ansText}`);
    if (imgs.length > 0) {
      const names = imgs.map((s) => path.basename(s.absPath)).join("、");
      sections.push(`   本题附图：${names}`);
    }
  });
  return sections.join("\n");
};

export const POST = async (req: Request, { params }: Ctx) => {
  const { id } = await params;

  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return errorResponse("body 不是合法 JSON");
  }

  const askId = (body.askId ?? "").trim();
  const rawAnswers = body.answers;
  const deferred = body.deferred === true;

  if (!askId) return errorResponse("askId 必填");
  if (!deferred) {
    if (!Array.isArray(rawAnswers) || rawAnswers.length === 0) {
      return errorResponse("answers 必填、至少一条");
    }
  }

  // 每题的原始图（key=questionId）。deferred 不带图；这里先做形状归一、真正的内容校验 / 落盘在拿到
  // questions 之后做（要按 questionId 白名单过滤、防客户端塞无关 key）。
  const rawImagesByQuestion: Record<string, RawImagePayload[]> =
    !deferred && body.imagesByQuestion && typeof body.imagesByQuestion === "object"
      ? body.imagesByQuestion
      : {};
  const hasRawImages = (qid: string): boolean =>
    Array.isArray(rawImagesByQuestion[qid]) &&
    rawImagesByQuestion[qid].length > 0;

  const answers: AskUserAnswer[] = [];
  if (Array.isArray(rawAnswers)) {
    for (const a of rawAnswers) {
      if (!a || typeof a.questionId !== "string" || typeof a.answer !== "string") {
        if (deferred) continue;
        return errorResponse("answers[].questionId / answer 类型不对");
      }
      const ans = a.answer.trim();
      // 图-only（只贴图不填字）也算已答：空文字 + 本题有图 → 放行、answer 存 ""、replyText 兜底成「见本题附图」
      if (ans.length === 0 && !hasRawImages(a.questionId)) {
        if (deferred) continue;
        return errorResponse(`questionId=${a.questionId} 的 answer 为空`);
      }
      answers.push({
        questionId: a.questionId,
        answer: ans,
        ...(a.optionId ? { optionId: a.optionId } : {}),
      });
    }
  }

  const task = await getTask(id);
  if (!task) return errorResponse("not_found", 404);

  // lifecycle 非 null（stopping/deleting/finalizing）一律拒送达 / 唤醒
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

  // 读完 task + lifecycle 闸后立刻同步取 admission——其后有存图 / 事件等长 await
  const opGen = getTaskOpGeneration(task.id);

  const reqEvent = [...task.events]
    .reverse()
    .find(
      (ev) =>
        ev.kind === "ask_user_request" &&
        typeof ev.meta?.askId === "string" &&
        ev.meta.askId === askId,
    );
  if (!reqEvent) {
    return errorResponse(`找不到 askId=${askId} 对应的提问事件`, 404);
  }
  const alreadyReplied = task.events.some(
    (ev) =>
      ev.kind === "ask_user_reply" &&
      typeof ev.meta?.askId === "string" &&
      ev.meta.askId === askId,
  );
  if (alreadyReplied) {
    return errorResponse(`askId=${askId} 已经回答过、不能重复提交`, 409);
  }

  const questions = extractQuestionsFromMeta(reqEvent.meta);
  if (questions.length === 0) {
    return errorResponse(`askId=${askId} 的 questions 元信息丢失、无法处理`, 500);
  }

  // 本组 ask 的 token（runner 写 ask_user_request 时落进 meta）。用它把「是否还在等」
  // 收窄到「还在等这组 ask」——防旧弹窗答案串进被顶替的新提问（force-new-agent / 顶替 race）。
  const expectedToken =
    typeof reqEvent.meta?.token === "string" ? reqEvent.meta.token : undefined;
  const checkPending = (): boolean => {
    const pendingAsk = getPendingAsk(task.id);
    if (!pendingAsk) return false;
    if (pendingAsk.askId !== askId) return false;
    if (expectedToken && pendingAsk.token !== expectedToken) return false;
    return true;
  };

  const questionIds = new Set(questions.map((q) => q.id));

  if (!deferred) {
    for (const qid of questionIds) {
      if (!answers.some((a) => a.questionId === qid)) {
        return errorResponse(`questionId=${qid} 缺答案、所有问题都必须答`);
      }
    }
  }

  // 逐题校验图（先不落盘）：只认属于本组 question 的 key、单题 ≤6、全部题合计 ≤12。
  // 校验过的内容暂存 validatedByQuestion、等确认 agent 还在等（pending）后再真写盘、避免僵尸态留孤儿文件。
  const validatedByQuestion: Record<string, ImageAttachmentInput[]> = {};
  let totalImages = 0;
  for (const qid of Object.keys(rawImagesByQuestion)) {
    if (!questionIds.has(qid)) continue; // 忽略不属于本组问题的 key
    const result = parseAndValidateImages(
      rawImagesByQuestion[qid],
      MAX_IMAGES_PER_QUESTION,
    );
    if (!result.ok) return result.errorResponse;
    if (result.images.length === 0) continue;
    totalImages += result.images.length;
    if (totalImages > MAX_IMAGES_TOTAL) {
      return errorResponse(
        `本次附图合计超过上限 ${MAX_IMAGES_TOTAL} 张、请精简`,
      );
    }
    validatedByQuestion[qid] = result.images;
  }

  const pending = checkPending();

  // 落盘图 + 拼 replyText：pending 命中 或 僵尸唤醒（pending 丢了但仍 awaiting）都要用。
  // 抽成闭包、避免两处复制；真正写盘仅在确认要接受这组答案时调用。
  const persistAnswerAssets = async (): Promise<
    | { ok: true; savedByQuestion: Record<string, ImageAttachmentSaved[]>; allSaved: ImageAttachmentSaved[]; allAbsPaths: string[]; replyText: string }
    | { ok: false; errorResponse: Response }
  > => {
    const savedByQuestion: Record<string, ImageAttachmentSaved[]> = {};
    const allSaved: ImageAttachmentSaved[] = [];
    for (const qid of Object.keys(validatedByQuestion)) {
      try {
        const saved = await saveImageAttachments(task.id, validatedByQuestion[qid]);
        savedByQuestion[qid] = saved;
        allSaved.push(...saved);
      } catch (err) {
        return {
          ok: false,
          errorResponse: errorResponse(
            `图片处理失败：${err instanceof Error ? err.message : String(err)}`,
          ),
        };
      }
    }
    return {
      ok: true,
      savedByQuestion,
      allSaved,
      allAbsPaths: allSaved.map((s) => s.absPath),
      replyText: buildReplyText(questions, answers, deferred, savedByQuestion),
    };
  };

  // 会话已死时的唤醒兜底（V0.14.x + 网断僵尸态）：落 ask_user_reply + 起新 agent 接手
  // chat / task 分叉：chat 走 deliverChatAskReply（绝不能 resumeCurrentActionWithMessage）
  const isChat = task.mode === "chat";
  const parseBootArgs = (): {
    apiKey?: string;
    model?: { id: string; params?: Array<{ id: string; value: string }> };
    gitToken?: string;
  } => ({
    apiKey: body.bootArgs?.apiKey?.trim() || undefined,
    model:
      body.bootArgs?.model && typeof body.bootArgs.model.id === "string"
        ? { id: body.bootArgs.model.id, params: body.bootArgs.model.params }
        : undefined,
    gitToken: body.bootArgs?.gitToken?.trim() || undefined,
  });

  const wakeWithAnswer = async (
    replyText: string,
    allSaved: ImageAttachmentSaved[],
    allAbsPaths: string[],
    reason: string,
  ): Promise<Response | null> => {
    // wake 前复查——stale 不得清 pending / 记「已答」
    if (isTaskOpStale(task.id, opGen)) {
      return errorResponse(TASK_OP_STALE_HTTP_MESSAGE, 409);
    }
    const boot = parseBootArgs();
    // task 唤醒需要 currentAction；chat 只要有 apiKey+model 就能起新会话
    if (isChat) {
      if (!boot.apiKey || !boot.model) return null;
    } else {
      const currentAction = task.actions.find((a) => a.id === task.currentActionId);
      if (!currentAction || !boot.apiKey || !boot.model) return null;
    }

    // 唤醒 = send/start 前落盘——先 strict 写用户回答，成功后再清 pending
    try {
      const wrote = await writeUserEventAndPublishStrict(task.id, {
        kind: "ask_user_reply",
        actionId: reqEvent.actionId,
        text: replyText,
        meta: {
          askId,
          answers,
          ...(deferred ? { deferred: true } : {}),
          ...(allSaved.length > 0 ? { images: allSaved } : {}),
        },
      });
      if (!wrote) {
        return errorResponse("not_found", 404);
      }
    } catch (persistErr) {
      console.error(
        `[ask-reply] 唤醒前落盘失败 task=${task.id}:`,
        persistErr,
      );
      return errorResponse(PERSIST_FAIL_RETRY_MESSAGE, 500);
    }
    clearPendingAsk(task.id);
    console.log(
      `[ask-reply] task=${task.id} askId=${askId} ${reason}、走唤醒兜底（${isChat ? "chat 新会话" : "新 agent"}接手、答案随消息带过去）`,
    );

    if (isChat) {
      void deliverChatAskReply(
        task,
        replyText,
        allAbsPaths.length > 0 ? allAbsPaths : undefined,
        boot,
      ).catch(async (err) => {
        console.error(`[ask-reply] chat=${task.id} 唤醒兜底失败：`, err);
        await writeEventAndPublish(task.id, {
          kind: "error",
          text: `答案已记录、但唤醒 AI 失败：${err instanceof Error ? err.message : String(err)}——在底部输入条说句话即可继续`,
        });
      });
    } else {
      void resumeCurrentActionWithMessage({
        task,
        userMessage: replyText,
        imagePaths: allAbsPaths.length > 0 ? allAbsPaths : undefined,
        apiKey: boot.apiKey!,
        fallbackModel: boot.model!,
        gitToken: boot.gitToken,
        opGen,
      }).catch(async (err) => {
        console.error(`[ask-reply] task=${task.id} 唤醒兜底失败：`, err);
        await writeEventAndPublish(task.id, {
          kind: "error",
          actionId: reqEvent.actionId,
          text: `答案已记录、但唤醒 AI 失败：${err instanceof Error ? err.message : String(err)}——在底部输入条说句话或重新「推进」即可继续`,
        });
      });
    }
    const fresh = await getTask(task.id);
    return new Response(JSON.stringify({ ok: true, task: fresh ?? task }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  if (!pending) {
    const fresh = (await getTask(id)) ?? task;

    // 这组 ask 已被顶替（task 有别的新提问在等）/ agent 还在跑 / **会话还活着**（V0.11：
    // 交卷后 run 自然结束、agent 空闲等用户是健康态）——都**不是僵尸、不能误杀任务**
    // （同事踩坑：答旧弹窗把还在跑的任务打成 error +「Agent 已断开」+ 关流）。
    // 只补一条作废标记把这条旧弹窗关掉、409 温和提示。
    // chat 看 runningChats、task 看 agentSessions。
    const sessionAlive = isChat
      ? hasChatSession(task.id)
      : agentSessions.has(task.id);
    if (
      getPendingAsk(task.id) ||
      fresh.runStatus === "running" ||
      sessionAlive
    ) {
      console.log(
        `[ask-reply] task=${task.id} askId=${askId} 提问已失效（被顶替 / agent 在跑、runStatus=${fresh.runStatus}）、作废旧弹窗`,
      );
      // 作废提示事件写+publish 同链
      await writeEventAndPublish(task.id, {
        kind: "info",
        actionId: reqEvent.actionId,
        text: "上一组提问已失效（AI 已继续工作）、本次回答未送达、无需再回答。",
        meta: { supersededAskId: askId },
      });
      return errorResponse("这组提问已失效、AI 已继续工作，无需再回答", 409);
    }

    // pending 内存丢了（进程重启 / 网断后 agent 异常退出）但任务仍 awaiting_user：
    // 旧逻辑当场 410 + 标 error → 答题卡 isStale「用输入条唤醒」+ 输入条因未了结 ask
    // 仍禁用 = 对锁死。有凭据则接受答案并唤醒；没凭据才作废提问 + 标 error 放行输入条。
    if (fresh.runStatus === "awaiting_user") {
      // 入场判定僵尸态处立刻 snapshot——B claim 后（写 running 前）本 observer
      // 即失效，闭包不再只靠 opGen（同 gen claim 看不见）。
      const zombieObserver = snapshotTaskOp(task.id);
      console.warn(
        `[ask-reply] task=${task.id} askId=${askId} 僵尸态 runStatus=awaiting_user（pending 已丢）、尝试唤醒兜底`,
      );
      const assets = await persistAnswerAssets();
      if (!assets.ok) return assets.errorResponse;
      const woken = await wakeWithAnswer(
        assets.replyText,
        assets.allSaved,
        assets.allAbsPaths,
        "僵尸态（pending 已丢）",
      );
      if (woken) return woken;

      // 收尾补漏：僵尸兜底前有多段 await（存图 / wake），期间 stop（bump gen）或
      // 别的入口把任务拉起（session 复活）都可能发生——裸写 error 会覆盖新 owner。
      // 门控 = observer 仍 current + 无存活会话 + expectedRunStatus 结构条件。
      // 必须先完成锁内条件写，再决定是否落「Agent 已断开」error 事件——否则后继
      // 已拉成 running 时 helper 返 null，事件流仍会永久留下假断开。
      const failedTask = await setTaskRunStatusIfRunOwner(
        task.id,
        "error",
        () =>
          isTaskOpCurrent(zombieObserver) &&
          !(isChat ? hasChatSession(task.id) : agentSessions.has(task.id)),
        undefined,
        "awaiting_user",
      );
      if (!failedTask) {
        // 后继已接管：本问答失效，不 supersede / 不 clear / 不写断开事件 / 不发 done
        // 写+publish 同链
        await writeEventAndPublish(task.id, {
          kind: "info",
          actionId: reqEvent.actionId,
          text: "上一组提问已失效（AI 已继续工作）、本次回答未送达、无需再回答。",
          meta: { supersededAskId: askId },
        });
        return errorResponse("这组提问已失效、AI 已继续工作，无需再回答", 409);
      }

      await supersedePendingAsks(task.id, "会话已失效");
      clearPendingAsk(task.id);
      // 断开审计事件写+publish 同链；task/done envelope 仍走 publishTaskStreamEvent
      await writeEventAndPublish(task.id, {
        kind: "error",
        actionId: reqEvent.actionId,
        text: isChat
          ? "Agent 已断开（进程重启或异常退出）、本次问答没送到。在底部输入条说句话即可继续。"
          : "Agent 已断开（进程重启或异常退出）、本次问答没送到。在底部输入条说句话即可唤醒，或重新「推进」。",
      });
      publishTaskStreamEvent(task.id, { kind: "task", task: failedTask });
      publishTaskStreamEvent(task.id, {
        kind: "done",
        task: failedTask,
        ok: false,
      });
      return errorResponse(
        isChat
          ? "agent 已断开——在底部输入条说句话即可继续"
          : "agent 已断开——在底部输入条说句话即可唤醒，或重新「推进」",
        410,
      );
    }
    return errorResponse(
      `agent 当前没在等问答（task.runStatus=${fresh.runStatus}）`,
      409,
    );
  }

  console.log(
    `[ask-reply] task=${task.id} askId=${askId} answers=${answers.length}/${questions.length} deferred=${deferred} imgQuestions=${Object.keys(validatedByQuestion).length}`,
  );

  // 确认 agent 还在等了、现在才真把图写盘（逐题落、按 questionId 归档）。
  const assets = await persistAnswerAssets();
  if (!assets.ok) return assets.errorResponse;
  const { allSaved, allAbsPaths, replyText } = assets;

  // 存图长 await 后复查
  if (isTaskOpStale(task.id, opGen)) {
    return errorResponse(TASK_OP_STALE_HTTP_MESSAGE, 409);
  }

  // V0.11：`agent.send` 送达答案——成功了才写「已答」事件 + publish（顺序关键：先送再落
  // 事件、失败不写、防「用户看到已答、agent 没收到」的假已答）。send 成功即清 pendingAsk。
  // chat → deliverChatAskReply（runningChats）；task → deliverAskReply（agentSessions）
  const boot = parseBootArgs();
  if (isChat) {
    const ok = await deliverChatAskReply(
      task,
      replyText,
      allAbsPaths.length > 0 ? allAbsPaths : undefined,
      boot,
    );
    if (!ok) {
      const woken = await wakeWithAnswer(
        replyText,
        allSaved,
        allAbsPaths,
        "会话已死",
      );
      if (woken) return woken;
      await supersedePendingAsks(task.id, "会话已失效");
      clearPendingAsk(task.id);
      return errorResponse(
        "没有可续接的 agent 会话（会话已失效）——在底部输入条说句话即可继续",
        409,
      );
    }
  } else {
    const deliverResult = await deliverAskReply(
      task,
      replyText,
      allAbsPaths.length > 0 ? allAbsPaths : undefined,
      reqEvent.actionId,
      boot,
      opGen,
    );
    // stale → 409，不清 pending、不记已答、不走 wake
    if (deliverResult === "stale" || isTaskOpStale(task.id, opGen)) {
      return errorResponse(TASK_OP_STALE_HTTP_MESSAGE, 409);
    }
    if (deliverResult !== "sent") {
      // V0.14.x（用户点名「AI 断开时提问没法提交」）：会话死不再丢答案 + 报错让用户
      // 手动推进——直接**唤醒新 agent**、把完整 Q&A 文本当最新指示带过去。
      const woken = await wakeWithAnswer(
        replyText,
        allSaved,
        allAbsPaths,
        "会话已死",
      );
      if (woken) return woken;
      // 没凭据（极端）：维持原作废 + 报错兜底
      await supersedePendingAsks(task.id, "会话已失效");
      clearPendingAsk(task.id);
      return errorResponse(
        "没有可续接的 agent 会话（会话已失效）——在底部输入条说句话或重新「推进」即可继续",
        409,
      );
    }
  }
  // 答案已送达 → 照常清 pending；落盘失败带 persistWarning，不伪装未发送
  clearPendingAsk(task.id);

  const actionId = reqEvent.actionId;
  let persistWarning: string | undefined;
  try {
    const wrote = await writeUserEventAndPublishStrict(task.id, {
      kind: "ask_user_reply",
      actionId,
      text: replyText,
      meta: {
        askId,
        answers,
        ...(deferred ? { deferred: true } : {}),
        // 扁平图数组、前端 extractUserReplyImages 读 meta.images 渲缩略图（同 user_reply 通道）
        ...(allSaved.length > 0 ? { images: allSaved } : {}),
      },
    });
    if (!wrote) {
      persistWarning = PERSIST_WARNING_DELIVERED;
      console.error(
        `[ask-reply] 已送达但持久化失败（ENOENT/未写）task=${task.id}`,
      );
    }
  } catch (persistErr) {
    console.error(
      `[ask-reply] 已送达但持久化失败 task=${task.id}:`,
      persistErr,
    );
    persistWarning = PERSIST_WARNING_DELIVERED;
  }

  // 删除迟到「幂等刷 running」——send 成功后本路由还有清 pending / 落事件等 await，
  // run 快速结束会先归位 awaiting_user/idle；再刷会把已结束 run 写回永久 running
  // （正常结束不 bump gen，旧闭包仍 true）。running 由 sendToTaskSessionBody 受理成功后
  // 在 consume 启动前 owner 门控写入（本路由不再碰）。
  const freshTask = (await getTask(task.id)) ?? task;

  return new Response(
    JSON.stringify({
      ok: true,
      task: freshTask,
      ...(persistWarning ? { persistWarning } : {}),
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
};
