/**
 * POST /api/tasks/[id]/ask-reply（V0.3.2 一次打包问题、modal 形态）
 *
 * V0.3.2 改造（用户拍板）：
 *   - 一次 ask_user 调用 = 一组问题 questions[]
 *   - UI modal 弹窗一次性答完所有问题、提交时 body 携带 answers[]
 *   - 拼接成 markdown Q&A 文本传给 agent、batch 落 contextDocs
 *
 * Body: { askId: string; answers: Array<{ questionId, answer, optionId? }> }
 *   - askId：对应 ask_user_request 事件的 askId
 *   - answers：每条问题的回答、跟 ask_user_request meta.questions 一一对应
 *
 * 行为：
 *   1. 校验 task / askId / 没被答过 / pending 状态
 *   2. 拼接 [ASK_USER_REPLY] markdown Q&A 文本
 *   3. submitAskReply(taskId, replyText) resolve agent
 *   4. 写 ask_user_reply 事件、meta 带 askId + answers + text 是拼接结果
 *
 * V0.3.3 改造（用户拍板：砍数据冗余）：
 *   - Q&A 不再单独 addContextDoc——之前每条 Q&A 写一条 contextDoc title=`Q: 问题`
 *     导致 ContextDocsPanel 被撑爆、且和 phase 1 artifact 的「上下文冲突已通过 ask_user 澄清」段重复
 *   - 现在单一数据源 = 01-plan.md artifact（agent 在 phase 1 prompt 教导下整理 Q&A 进 artifact）
 *   - 后续 phase 查重不再看 contextDocs、改 read 01-plan.md（V0.3.4 起 context 合进 plan）
 */

import type { AskUserAnswer, AskUserQuestion } from "@/lib/types";
import {
  appendEvent,
  getTask,
  patchPhase,
} from "@/lib/server/task-fs";
import {
  hasPending,
  submitAskReply,
} from "@/lib/server/chat-mcp";
import { publishChatStreamEvent } from "@/lib/server/chat-runner";

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
}

const errorResponse = (message: string, status = 400) =>
  new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });

export const runtime = "nodejs";

// keepalive race 兜底（跟 chat-reply / phase-ack 同款）
const KEEPALIVE_RACE_RETRY_MS = 200;
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// 解析 ask_user_request 事件 meta、抠出 questions 数组
// meta 不规整时返 []、上层会拒错
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
      allowText:
        typeof m.allowText === "boolean" ? m.allowText : true,
    });
  }
  return out;
};

// 把每条 Q&A 拼成 markdown 给 agent
// 加 [ASK_USER_REPLY] 头部、agent prompt 教它认这个头
const buildReplyText = (
  questions: AskUserQuestion[],
  answers: AskUserAnswer[],
): string => {
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

  if (!askId) return errorResponse("askId 必填");
  if (!Array.isArray(rawAnswers) || rawAnswers.length === 0) {
    return errorResponse("answers 必填、至少一条");
  }
  const answers: AskUserAnswer[] = [];
  for (const a of rawAnswers) {
    if (!a || typeof a.questionId !== "string" || typeof a.answer !== "string") {
      return errorResponse("answers[].questionId / answer 类型不对");
    }
    const ans = a.answer.trim();
    if (ans.length === 0) {
      return errorResponse(`questionId=${a.questionId} 的 answer 为空`);
    }
    answers.push({
      questionId: a.questionId,
      answer: ans,
      ...(a.optionId ? { optionId: a.optionId } : {}),
    });
  }

  const task = await getTask(id);
  if (!task) return errorResponse("not_found", 404);

  // 找 askId 对应的 ask_user_request 事件
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

  // 校验 answers 覆盖所有 question（每条都得有）
  // 用户在 modal 里答完才提交、缺哪条说明前端 bug、拒
  const questionIds = new Set(questions.map((q) => q.id));
  for (const qid of questionIds) {
    if (!answers.some((a) => a.questionId === qid)) {
      return errorResponse(`questionId=${qid} 缺答案、所有问题都必须答`);
    }
  }

  // hasPending 检测 + race 兜底
  let pending = hasPending(task.id);
  if (!pending) {
    await sleep(KEEPALIVE_RACE_RETRY_MS);
    pending = hasPending(task.id);
  }

  if (!pending) {
    if (task.status === "awaiting_user" || task.status === "running") {
      console.warn(
        `[ask-reply] task=${task.id} askId=${askId} 僵尸态 status=${task.status}、当场标 failed`,
      );
      const errorTask = await appendEvent(task.id, {
        kind: "error",
        text: "Agent 已断开（进程重启或异常退出）、本次问答没送到。请重启该任务。",
      });
      if (errorTask) {
        const lastEvent = errorTask.events[errorTask.events.length - 1];
        if (lastEvent) {
          publishChatStreamEvent(task.id, { kind: "event", event: lastEvent });
        }
      }
      const failedTask = await patchPhase(task.id, { taskStatus: "failed" });
      if (failedTask) {
        publishChatStreamEvent(task.id, { kind: "task", task: failedTask });
        publishChatStreamEvent(task.id, {
          kind: "done",
          task: failedTask,
          ok: false,
        });
      }
      return errorResponse("agent 已断开、请重启任务", 410);
    }
    return errorResponse(
      `agent 当前没在等问答（task.status=${task.status}）`,
      409,
    );
  }

  console.log(
    `[ask-reply] task=${task.id} askId=${askId} answers=${answers.length}/${questions.length}`,
  );

  // 拼好 reply text、agent 看到 [ASK_USER_REPLY] 头解析
  const replyText = buildReplyText(questions, answers);

  // 1) 写 ask_user_reply 事件（用户视角先看到自己的答案落事件流）
  // text 用拼好的 replyText（也可以只放精简版、但拼好的能直接当回放看）
  const phase = reqEvent.phase;
  const replyTask = await appendEvent(task.id, {
    kind: "ask_user_reply",
    phase,
    text: replyText,
    meta: {
      askId,
      answers,
    },
  });
  if (replyTask) {
    const lastEvent = replyTask.events[replyTask.events.length - 1];
    if (lastEvent) {
      publishChatStreamEvent(task.id, { kind: "event", event: lastEvent });
    }
  }

  // 2) resolve agent 的 ask_user
  const ok = submitAskReply(task.id, replyText);
  if (!ok) {
    return errorResponse(
      "agent 已不在等问答（可能并发处理 / keepalive 切换）、稍后重试",
      409,
    );
  }

  // 3) 切 running
  const updated = await patchPhase(task.id, { taskStatus: "running" });
  if (updated) publishChatStreamEvent(task.id, { kind: "task", task: updated });

  // V0.3.3：Q&A 不再单独 addContextDoc——agent 在 phase 1 prompt 教导下会把答案整理进
  // 01-plan.md 的「上下文冲突已通过 ask_user 澄清」段、单一数据源、UI 面板不再被 Q 撑爆

  return new Response(
    JSON.stringify({ ok: true, task: updated ?? task }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
};
