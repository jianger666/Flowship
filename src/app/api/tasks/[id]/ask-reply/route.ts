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
 * }
 * ```
 *
 * # 行为
 *
 * 1. 校验 task / askId / 没被答过 / pending 状态
 * 2. 拼接 [ASK_USER_REPLY] 或 [ASK_USER_REPLY deferred] markdown 文本
 * 3. submitAskReply 解 agent 的 ask_user
 * 4. 写 ask_user_reply 事件（meta 带 askId + answers + deferred）+ publish SSE
 * 5. 切 runStatus = running
 */

import type { AskUserAnswer, AskUserQuestion } from "@/lib/types";
import { appendEvent, getTask, setTaskRunStatus } from "@/lib/server/task-fs";
import { hasPending, submitAskReply } from "@/lib/server/chat-mcp";
import { publishTaskStreamEvent } from "@/lib/server/task-runner";
import {
  errorResponse,
  KEEPALIVE_RACE_RETRY_MS,
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

interface PostBody {
  askId?: string;
  answers?: AnswerPayload[];
  deferred?: boolean;
}

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
    const ansText = a ? a.answer : "（未回答）";
    sections.push("", `Q${idx + 1}: ${q.question}`, `A: ${ansText}`);
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
  const answers: AskUserAnswer[] = [];
  if (Array.isArray(rawAnswers)) {
    for (const a of rawAnswers) {
      if (!a || typeof a.questionId !== "string" || typeof a.answer !== "string") {
        if (deferred) continue;
        return errorResponse("answers[].questionId / answer 类型不对");
      }
      const ans = a.answer.trim();
      if (ans.length === 0) {
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

  if (!deferred) {
    const questionIds = new Set(questions.map((q) => q.id));
    for (const qid of questionIds) {
      if (!answers.some((a) => a.questionId === qid)) {
        return errorResponse(`questionId=${qid} 缺答案、所有问题都必须答`);
      }
    }
  }

  let pending = hasPending(task.id);
  if (!pending) {
    await sleep(KEEPALIVE_RACE_RETRY_MS);
    pending = hasPending(task.id);
  }

  if (!pending) {
    if (task.runStatus === "awaiting_user" || task.runStatus === "running") {
      console.warn(
        `[ask-reply] task=${task.id} askId=${askId} 僵尸态 runStatus=${task.runStatus}、当场标 error`,
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
      `agent 当前没在等问答（task.runStatus=${task.runStatus}）`,
      409,
    );
  }

  console.log(
    `[ask-reply] task=${task.id} askId=${askId} answers=${answers.length}/${questions.length} deferred=${deferred}`,
  );

  const replyText = buildReplyText(questions, answers, deferred);

  const actionId = reqEvent.actionId;
  const replyEvent = await appendEvent(task.id, {
    kind: "ask_user_reply",
    actionId,
    text: replyText,
    meta: {
      askId,
      answers,
      ...(deferred ? { deferred: true } : {}),
    },
  });
  if (replyEvent) {
    publishTaskStreamEvent(task.id, { kind: "event", event: replyEvent });
  }

  const ok = submitAskReply(task.id, replyText);
  if (!ok) {
    return errorResponse(
      "agent 已不在等问答（可能并发处理 / keepalive 切换）、稍后重试",
      409,
    );
  }

  const updated = await setTaskRunStatus(task.id, "running");
  if (updated) publishTaskStreamEvent(task.id, { kind: "task", task: updated });

  return new Response(
    JSON.stringify({ ok: true, task: updated ?? task }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
};
