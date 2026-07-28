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
import { extractAskQuestions, isAskSkipped } from "@/lib/ask-pending";
import {
  clearPendingAsk,
  getPendingAsk,
  restorePendingAskIf,
  takePendingAskIf,
  wasAskTakenRecently,
  type PendingAsk,
} from "@/lib/server/chat-pending";
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
import { buildSkillDirective } from "@/lib/protocol-signals";
import {
  errorResponse,
  parseAndValidateImages,
  parseAndValidateSkills,
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
  // v1.1.x：答题框 `/` 引用到的 skill（各题合并去重后一份）。
  // 指引只拼进发给 agent 的文本、不进 ask_user_reply 事件（气泡存用户原答案）
  skills?: Array<{ name?: string; absPath?: string }>;
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
// skill 上限走 protocol-signals 的 MAX_SKILL_REFS（客户端截断同源）——见 parseAndValidateSkills 默认值

export const runtime = "nodejs";

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

/**
 * 认领到的 pendingAsk 放在容器里传给内部实现——外层 catch 据此在**抛错**时把登记放回。
 * （逐个出口补回滚只覆盖得了「我们自己 return 的那些」，deliver / 落盘真抛出来时
 * 登记就没了、用户回不去答题。）
 */
interface AskClaimRef {
  taken: PendingAsk | null;
}

export const POST = async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const claimRef: AskClaimRef = { taken: null };
  try {
    return await handleAskReply(req, id, claimRef);
  } catch (err) {
    // 抛到这里 = 答案没送达（也没写「已答」事件）：登记原样放回
    if (claimRef.taken) restorePendingAskIf(id, claimRef.taken);
    throw err;
  }
};

const handleAskReply = async (
  req: Request,
  id: string,
  claimRef: AskClaimRef,
): Promise<Response> => {
  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return errorResponse("body 不是合法 JSON");
  }

  const askId = (body.askId ?? "").trim();
  const rawAnswers = body.answers;
  const deferred = body.deferred === true;

  // deferred 是「跳过这组问题」、没有正文也就无所谓 skill 指引
  const skillsResult = parseAndValidateSkills(
    deferred ? undefined : body.skills,
  );
  if (!skillsResult.ok) return skillsResult.errorResponse;
  const skillDirective = buildSkillDirective(skillsResult.skills);

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
  // 用户已经用「直接发新消息」跳过了这组提问（ask-skip 写的作废事件）——
  // 答案不能再送达（agent 那边已经按新消息继续了），温和拒绝、不走下面的僵尸唤醒
  if (isAskSkipped(task.events, askId)) {
    return errorResponse("这组提问已跳过（你发了新消息）、无需再回答", 409);
  }

  const questions = extractAskQuestions(reqEvent.meta);
  if (questions.length === 0) {
    return errorResponse(`askId=${askId} 的 questions 元信息丢失、无法处理`, 500);
  }

  // 本组 ask 的 token（runner 写 ask_user_request 时落进 meta）。用它把「是否还在等」
  // 收窄到「还在等这组 ask」——防旧弹窗答案串进被顶替的新提问（force-new-agent / 顶替 race）。
  const expectedToken =
    typeof reqEvent.meta?.token === "string" ? reqEvent.meta.token : undefined;
  /**
   * 本次认领到的登记（在下面 `claimPending()` 处**同步原子摘走**）。
   *
   * 为什么不是原来的「先 peek、送达后再 clear」：peek 到送达之间隔着存图 / send 两段
   * await，用户此刻在输入条发新消息就会被 `ask-skip` 摘走同一组 ask——于是 agent 同时
   * 收到「这组问题的答案」和「上一组提问用户跳过了」两条矛盾指令。改成摘走之后，
   * 答与跳只有一个拿得到登记、另一个自然让路（仲裁者只有 pendingAsks 一个）。
   *
   * 代价：中途没送出去必须**放回**（{@link giveBackPending}），否则用户回不去答题。
   */
  /** 摘走登记（同步、无 await）；返回「这组 ask 还在等」 */
  const claimPending = (): boolean => {
    claimRef.taken = takePendingAskIf(task.id, askId, expectedToken);
    return claimRef.taken !== null;
  };
  /**
   * 本次没把答案送出去 → 原样放回（槽位已被新提问占住就不放，绝不盖掉新的）。
   * 放完清掉 claimRef——外层 catch 不该再放第二次。
   */
  const giveBackPending = (): void => {
    if (!claimRef.taken) return;
    restorePendingAskIf(task.id, claimRef.taken);
    claimRef.taken = null;
  };
  /** 答案确实送达了 → 交出所有权，外层 catch 不许再把它放回来（那会让用户重复答） */
  const keepPendingClaimed = (): void => {
    claimRef.taken = null;
  };

  /**
   * 在 app 里答完 → 把飞书那边同一组 ask 的卡片（需求群答题卡 / p2p 流式卡）也置成终态。
   *
   * 这是 HANDOFF 记的那笔欠账：终态 patch 原来只写在「**从这张卡点按钮**」的分支里，
   * 从 app 答完两边卡片都不置态、群里看着还像待答。收口点就一个（ask-card-settle），
   * 谁了结的谁调一次。
   *
   * 动态 import：route 不该把 feishu-bridge 那张图静态挂上；整段吞异常——
   * 答案已经送达了，卡片没刷成功不该让接口报错。
   */
  const settleAnsweredCards = async (): Promise<void> => {
    if (questions.length === 0) return;
    try {
      const { ASK_CARD_ANSWERED_HINT, settleAskCards } = await import(
        "@/lib/server/feishu-bridge/ask-card-settle"
      );
      const noteByQuestion: Record<string, string> = {};
      if (!deferred) {
        for (const a of answers) {
          const text = a.answer.trim();
          if (!text) continue;
          noteByQuestion[a.questionId] =
            `已回答：${text.length > 120 ? `${text.slice(0, 119)}…` : text}`;
        }
      }
      await settleAskCards({
        taskId: task.id,
        askId,
        questions,
        noteByQuestion,
        fallbackNote: deferred ? "（用户选择稍后再补充）" : "已在 Flowship 里回答",
        hintNote: ASK_CARD_ANSWERED_HINT,
      });
    } catch (err) {
      console.warn(
        `[ask-reply] 置飞书卡片终态失败 task=${task.id} ask=${askId}:`,
        err instanceof Error ? err.message : err,
      );
    }
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

  const pending = claimPending();

  // 落盘图 + 拼 replyText：pending 命中 或 僵尸唤醒（pending 丢了但仍 awaiting）都要用。
  // 抽成闭包、避免两处复制；真正写盘仅在确认要接受这组答案时调用。
  const persistAnswerAssets = async (): Promise<
    | {
        ok: true;
        savedByQuestion: Record<string, ImageAttachmentSaved[]>;
        allSaved: ImageAttachmentSaved[];
        allAbsPaths: string[];
        /** 写进 ask_user_reply 事件的用户原文（气泡看到的就是它） */
        replyText: string;
        /** 真正 send 给 agent 的文本 = skill 指引 + 原文 */
        agentText: string;
      }
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
    const replyText = buildReplyText(
      questions,
      answers,
      deferred,
      savedByQuestion,
    );
    return {
      ok: true,
      savedByQuestion,
      allSaved,
      allAbsPaths: allSaved.map((s) => s.absPath),
      replyText,
      agentText: skillDirective + replyText,
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
    // 事件气泡存原文、送 agent 的带 skill 指引（两者只在有 `/` 引用时不同）
    replyText: string,
    agentText: string,
    allSaved: ImageAttachmentSaved[],
    allAbsPaths: string[],
    reason: string,
  ): Promise<Response | null> => {
    // wake 前复查——stale 不得清 pending / 记「已答」
    if (isTaskOpStale(task.id, opGen)) {
      giveBackPending();
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
        giveBackPending();
        return errorResponse("not_found", 404);
      }
    } catch (persistErr) {
      console.error(
        `[ask-reply] 唤醒前落盘失败 task=${task.id}:`,
        persistErr,
      );
      // 答案没落盘就没唤醒 = 这次没答成，登记放回（契约：wake 前失败不清 pending）
      giveBackPending();
      return errorResponse(PERSIST_FAIL_RETRY_MESSAGE, 500);
    }
    // 这里不再 clearPendingAsk：本组登记在入口 claimPending 就摘走了，
    // 此刻槽位里若有东西那是**新一组**提问——裸清会把它一起抹掉。
    // 答案已落盘 + 即将交给新 agent → 所有权交出去，后面再抛也不许放回
    keepPendingClaimed();
    console.log(
      `[ask-reply] task=${task.id} askId=${askId} ${reason}、走唤醒兜底（${isChat ? "chat 新会话" : "新 agent"}接手、答案随消息带过去）`,
    );
    /**
     * 唤醒失败的引导事件。**自己吞掉写盘异常**——它挂在 fire-and-forget 链的最后一环，
     * 抛出去没人接，Node 默认策略下 unhandled rejection 可能直接带崩整个服务进程。
     */
    const noteWakeFailure = async (text: string): Promise<void> => {
      try {
        await writeEventAndPublish(task.id, {
          kind: "error",
          // chat 没有 action 维度，只有 task 模式把事件挂回提问所属 action
          ...(isChat ? {} : { actionId: reqEvent.actionId }),
          text,
        });
      } catch (err) {
        console.error(
          `[ask-reply] task=${task.id} 连唤醒失败事件都没写下去：`,
          err,
        );
      }
    };

    // 飞书答题卡置终态排在**投递成功之后**（同主路径的顺序约定）：这两条都是
    // fire-and-forget，提前置态时一旦唤醒失败，卡片上写着「已回答」而 agent 根本没收到。
    // 失败路径一律不置态、只落错误事件引导用户用输入条恢复。
    if (isChat) {
      void deliverChatAskReply(
        task,
        agentText,
        allAbsPaths.length > 0 ? allAbsPaths : undefined,
        boot,
      )
        .then(async (ok) => {
          if (ok) {
            await settleAnsweredCards();
            return;
          }
          // 返 false = 会话没接回来（rewind 窗口 / 被停 / run 在跑）：同样是没送到
          await noteWakeFailure(
            "答案已记录、但唤醒 AI 失败（会话没接回来）——在底部输入条说句话即可继续",
          );
        })
        .catch(async (err) => {
          console.error(`[ask-reply] chat=${task.id} 唤醒兜底失败：`, err);
          await noteWakeFailure(
            `答案已记录、但唤醒 AI 失败：${err instanceof Error ? err.message : String(err)}——在底部输入条说句话即可继续`,
          );
        });
    } else {
      void resumeCurrentActionWithMessage({
        task,
        userMessage: agentText,
        imagePaths: allAbsPaths.length > 0 ? allAbsPaths : undefined,
        apiKey: boot.apiKey!,
        fallbackModel: boot.model!,
        gitToken: boot.gitToken,
        opGen,
      })
        .then(async () => {
          await settleAnsweredCards();
        })
        .catch(async (err) => {
          console.error(`[ask-reply] task=${task.id} 唤醒兜底失败：`, err);
          await noteWakeFailure(
            `答案已记录、但唤醒 AI 失败：${err instanceof Error ? err.message : String(err)}——在底部输入条说句话或重新「推进」即可继续`,
          );
        });
    }
    const fresh = await getTask(task.id);
    return new Response(JSON.stringify({ ok: true, task: fresh ?? task }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  if (!pending) {
    // 登记为空的第一种可能：另一条链（跳过 / 飞书答题）**刚把它原子摘走、正在投递**。
    // 这一条必须挡在下面两个子分支之前——它们各自都会替那条链下结论：
    // 「已失效」分支写作废事件（跳过链随后 rollback 放回登记的话，事件流里那条假作废会让
    // 答题卡直接消失、用户再也答不了；commit 成功则同一 ask 落两条 supersede 事件），
    // 「僵尸」分支更狠、直接唤醒新 agent 把答案送过去（agent 同时收到答案和跳过两条矛盾指令）。
    // 收口是那条链自己的事，这里只温和拒绝、**一个事件都不写**。
    // takenAsks 是内存态、重启后天然为空，正好把「链在飞」和真孤儿区分开。
    if (wasAskTakenRecently(task.id, askId)) {
      console.warn(
        `[ask-reply] task=${task.id} askId=${askId} 另一条链正在了结这组提问、本次回答不投递`,
      );
      // 文案保持中性：takenAsks 不记谁摘的——双击提交时第二个请求的用户并没发过新消息
      return errorResponse("这组提问正在被处理、无需再回答", 409);
    }

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
      // 走到这里 = 登记为空且**没有任何链在飞**（入口的 wasAskTakenRecently 已经放行）：
      // 真孤儿（进程重启 / 网断后 agent 异常退出），可以接管这组答案。
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
        assets.agentText,
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
  if (!assets.ok) {
    // 存图失败 = 这次没答成，把登记放回让用户能重来
    giveBackPending();
    return assets.errorResponse;
  }
  const { allSaved, allAbsPaths, replyText, agentText } = assets;

  // 存图长 await 后复查
  if (isTaskOpStale(task.id, opGen)) {
    giveBackPending();
    return errorResponse(TASK_OP_STALE_HTTP_MESSAGE, 409);
  }

  // V0.11：`agent.send` 送达答案——成功了才写「已答」事件 + publish（顺序关键：先送再落
  // 事件、失败不写、防「用户看到已答、agent 没收到」的假已答）。send 成功即清 pendingAsk。
  // chat → deliverChatAskReply（runningChats）；task → deliverAskReply（agentSessions）
  const boot = parseBootArgs();
  if (isChat) {
    const ok = await deliverChatAskReply(
      task,
      agentText,
      allAbsPaths.length > 0 ? allAbsPaths : undefined,
      boot,
    );
    if (!ok) {
      const woken = await wakeWithAnswer(
        replyText,
        agentText,
        allSaved,
        allAbsPaths,
        "会话已死",
      );
      if (woken) return woken;
      // 会话彻底没了、也唤不醒 → 这组提问就此作废（**不放回**登记：放回等于让用户
      // 对着一个送不到的会话反复答）。clearPendingAsk 不再调——本组早在入口摘走了
      keepPendingClaimed();
      await supersedePendingAsks(task.id, "会话已失效");
      return errorResponse(
        "没有可续接的 agent 会话（会话已失效）——在底部输入条说句话即可继续",
        409,
      );
    }
  } else {
    const deliverResult = await deliverAskReply(
      task,
      agentText,
      allAbsPaths.length > 0 ? allAbsPaths : undefined,
      reqEvent.actionId,
      boot,
      opGen,
    );
    // stale → 409，登记放回、不记已答、不走 wake
    if (deliverResult === "stale" || isTaskOpStale(task.id, opGen)) {
      giveBackPending();
      return errorResponse(TASK_OP_STALE_HTTP_MESSAGE, 409);
    }
    if (deliverResult !== "sent") {
      // V0.14.x（用户点名「AI 断开时提问没法提交」）：会话死不再丢答案 + 报错让用户
      // 手动推进——直接**唤醒新 agent**、把完整 Q&A 文本当最新指示带过去。
      const woken = await wakeWithAnswer(
        replyText,
        agentText,
        allSaved,
        allAbsPaths,
        "会话已死",
      );
      if (woken) return woken;
      // 没凭据（极端）：维持原作废 + 报错兜底（同 chat 分支，登记不放回、也不裸清）
      keepPendingClaimed();
      await supersedePendingAsks(task.id, "会话已失效");
      return errorResponse(
        "没有可续接的 agent 会话（会话已失效）——在底部输入条说句话或重新「推进」即可继续",
        409,
      );
    }
  }
  // 答案已送达（登记在入口就摘走了、无需再清）→ 交出所有权，后面再抛也不许放回
  keepPendingClaimed();

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

  // 飞书那边的答题卡置终态——排在「已答」事件落盘**之后**：置态是锦上添花，
  // 不能让两次 lark 往返拖住用户看到自己那条回答（内部吞异常、绝不抛）
  await settleAnsweredCards();

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
