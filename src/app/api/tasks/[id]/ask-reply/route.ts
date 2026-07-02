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
 * # 行为
 *
 * 1. 校验 task / askId / 没被答过 / pending 状态
 * 2. 逐题落盘各自的图、拼接 [ASK_USER_REPLY] 文本（每题答案下内联「本题附图：<basename>」做归属）
 * 3. submitAskReply 解 agent 的 ask_user、把全部图绝对路径汇总透传（文末自动拼 [ATTACHED_IMAGES]）
 * 4. 写 ask_user_reply 事件（meta 带 askId + answers + deferred + images 扁平数组给前端渲缩略图）+ publish SSE
 * 5. 切 runStatus = running
 */

import path from "node:path";

import type { AskUserAnswer, AskUserQuestion } from "@/lib/types";
import {
  appendEvent,
  getTask,
  setTaskRunStatus,
} from "@/lib/server/task-fs";
import { saveImageAttachments } from "@/lib/server/task-artifacts";
import type {
  ImageAttachmentInput,
  ImageAttachmentSaved,
} from "@/lib/server/task-artifacts";
import { hasPending, hasPendingToken, submitAskReply } from "@/lib/server/chat-pending";
import { publishTaskStreamEvent } from "@/lib/server/task-stream";
import {
  errorResponse,
  KEEPALIVE_RACE_RETRY_MS,
  parseAndValidateImages,
  sleep,
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
      "请按你判断的合理 default 推进、并把以下问题完整列入 artifact「§6 待澄清 / 不确定项」段、提示用户后续在「再聊聊」或上下文文档里补充。",
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
    sections.push("", `Q${idx + 1}: ${q.question}`, `A: ${ansText}`);
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

  // 本组 ask 的 token（runner 写 ask_user_request 时落进 meta）。用它把「agent 是否还在等」
  // 收窄到「还在等这组 ask」——防旧弹窗答案串进被顶替的新 pending（force-new-agent / 顶替 race）。
  // 极旧数据可能没 token：退回 task 级判定（与旧行为一致、不写兼容分支）。
  const expectedToken =
    typeof reqEvent.meta?.token === "string" ? reqEvent.meta.token : undefined;
  const checkPending = (): boolean =>
    expectedToken ? hasPendingToken(task.id, expectedToken) : hasPending(task.id);

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

  let pending = checkPending();
  if (!pending) {
    await sleep(KEEPALIVE_RACE_RETRY_MS);
    pending = checkPending();
  }

  if (!pending) {
    // 判定用最新状态：retry sleep 期间 runStatus 可能已变（agent 继续跑 / 停下等新问题）
    const fresh = (await getTask(id)) ?? task;

    // 这组 ask 已被顶替（task 还有别的活 pending）或 agent 还在跑——**不是僵尸、不能误杀任务**
    // （同事踩坑：答旧弹窗把还在跑的任务打成 error +「Agent 已断开」+ 关流）。
    // 只补一条作废标记把这条旧弹窗关掉、409 温和提示。
    if (hasPending(task.id) || fresh.runStatus === "running") {
      console.log(
        `[ask-reply] task=${task.id} askId=${askId} 提问已失效（被顶替 / agent 在跑、runStatus=${fresh.runStatus}）、作废旧弹窗`,
      );
      const info = await appendEvent(task.id, {
        kind: "info",
        actionId: reqEvent.actionId,
        text: "上一组提问已失效（AI 已继续工作）、本次回答未送达、无需再回答。",
        meta: { supersededAskId: askId },
      });
      if (info) publishTaskStreamEvent(task.id, { kind: "event", event: info });
      return errorResponse("这组提问已失效、AI 已继续工作，无需再回答", 409);
    }

    // 真僵尸：任务声称在等回复、内部却没有任何等待（进程重启 / agent 异常退出）——标 error 让用户重启
    if (fresh.runStatus === "awaiting_user") {
      console.warn(
        `[ask-reply] task=${task.id} askId=${askId} 僵尸态 runStatus=awaiting_user、当场标 error`,
      );
      const errorEvent = await appendEvent(task.id, {
        kind: "error",
        actionId: reqEvent.actionId,
        text: "Agent 已断开（进程重启或异常退出）、本次问答没送到。请点「推进」起新 agent。",
      });
      if (errorEvent) {
        publishTaskStreamEvent(task.id, { kind: "event", event: errorEvent });
      }
      const failedTask = await setTaskRunStatus(task.id, "error");
      if (failedTask) {
        publishTaskStreamEvent(task.id, { kind: "task", task: failedTask });
        publishTaskStreamEvent(task.id, {
          kind: "done",
          task: failedTask,
          ok: false,
        });
      }
      return errorResponse("agent 已断开、请点「推进」起新 agent", 410);
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
  // savedByQuestion 用于 replyText 内联标注归属；allSaved 扁平给前端缩略图；allAbsPaths 给 agent read。
  const savedByQuestion: Record<string, ImageAttachmentSaved[]> = {};
  const allSaved: ImageAttachmentSaved[] = [];
  for (const qid of Object.keys(validatedByQuestion)) {
    try {
      const saved = await saveImageAttachments(task.id, validatedByQuestion[qid]);
      savedByQuestion[qid] = saved;
      allSaved.push(...saved);
    } catch (err) {
      return errorResponse(
        `图片处理失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  const allAbsPaths = allSaved.map((s) => s.absPath);

  const replyText = buildReplyText(questions, answers, deferred, savedByQuestion);

  // 先 resolve 阻塞中的 agent（带 token 校验）——成功了才写「已答」事件 + publish。
  // 顺序很关键：旧版先写事件再 submit、submit 失败（pending 被顶替 / keepalive 切换）时
  // 用户已经在事件流看到「已答」、agent 却没收到 → 假已答。现在 submit 成功才落「已答」、
  // 失败直接 409、不写事件（此时图已落盘成孤儿、暂无清理 helper、概率低可接受）。
  const ok = submitAskReply(task.id, replyText, allAbsPaths, expectedToken);
  if (!ok) {
    return errorResponse(
      "agent 已不在等问答（可能并发处理 / keepalive 切换 / 等待已被顶替）、稍后重试",
      409,
    );
  }

  const actionId = reqEvent.actionId;
  const replyEvent = await appendEvent(task.id, {
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
  if (replyEvent) {
    publishTaskStreamEvent(task.id, { kind: "event", event: replyEvent });
  }

  const updated = await setTaskRunStatus(task.id, "running");
  if (updated) publishTaskStreamEvent(task.id, { kind: "task", task: updated });

  return new Response(
    JSON.stringify({ ok: true, task: updated ?? task }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
};
