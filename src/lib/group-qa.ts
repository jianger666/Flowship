/**
 * 群问答 tab 的聚合逻辑（纯函数）：问题事件 + 轮次汇总事件 → 一轮一行。
 *
 * 配对键（按可靠度）：
 * 1. meta.restrictedRunTag（问题） == meta.groupQaSummary.runTag（汇总）——精确配对；
 * 2. meta.feishuMessageId（问题） == groupQaSummary.questionMessageId——no_pending
 *    竞态落回旁路时问题事件没有 runTag，靠群消息 id 兜底；
 * 3. 历史数据（老代码没写 runTag 也没写汇总）：temporal 配对——问题之后、
 *    下一个 user_reply 之前的 assistant_message 全归它。属主并发聊时会串台，
 *    打 legacy 标诚实展示，仅供参考。
 *
 * 问无答（有问没配到答）：30 分钟内算“回答中”，更早的 static 展示为“未收到回答”
 * （多半是强关 / 崩溃打断的那轮）。
 */

import type { TaskEvent } from "@/lib/types";

/** 汇总事件 meta.groupQaSummary 的形状（flush 时写，见 group-outbound） */
export interface GroupQaSummaryMeta {
  runTag: string;
  askerOpenId: string;
  askerName: string;
  questionMessageId?: string;
  answer: string;
  ok: boolean;
}

/** 群问答一轮：列表一行 + 展开详情 */
export interface GroupQaRound {
  /** runTag；历史数据用 `legacy-<问题事件id>` */
  key: string;
  /** 问题时间（列表倒序用） */
  ts: number;
  askerName: string;
  askerOpenId: string;
  /** 去噪后的提问正文（展示用，原事件不动） */
  questionText: string;
  /** 回答全文（没有就是 ""，看 answering/ok 区分“跑着呢”还是“没收到”） */
  answerText: string;
  ok: boolean;
  answering: boolean;
  legacy: boolean;
}

/** 有问无答多久还算“回答中” */
export const GROUP_QA_ANSWERING_RECENT_MS = 30 * 60 * 1000;

const metaOf = (ev: TaskEvent): Record<string, unknown> =>
  (ev.meta ?? {}) as Record<string, unknown>;

const strOf = (v: unknown): string => (typeof v === "string" ? v : "");

/**
 * 非属主群问题（带配对键 restrictedRunTag 的才进 tab；属主群消息、
 * 历史问题（无 runTag）走 legacy 配对）。
 */
export const isGroupQaQuestionEvent = (ev: TaskEvent): boolean => {
  if (ev.kind !== "user_reply") return false;
  const meta = metaOf(ev);
  return (
    meta.source === "feishu_group" && strOf(meta.restrictedRunTag) !== ""
  );
};

/** 轮次汇总事件（flush 时写一行，列表 + 配对的数据源） */
export const isGroupQaSummaryEvent = (ev: TaskEvent): boolean => {
  if (ev.kind !== "info") return false;
  const s = metaOf(ev).groupQaSummary;
  return typeof s === "object" && s !== null;
};

export const readGroupQaSummary = (ev: TaskEvent): GroupQaSummaryMeta | null => {
  if (!isGroupQaSummaryEvent(ev)) return null;
  const s = metaOf(ev).groupQaSummary as Record<string, unknown>;
  const runTag = strOf(s.runTag);
  if (!runTag) return null;
  return {
    runTag,
    askerOpenId: strOf(s.askerOpenId),
    askerName: strOf(s.askerName),
    questionMessageId:
      strOf(s.questionMessageId) || undefined,
    answer: strOf(s.answer),
    ok: s.ok !== false,
  };
};

/** 群问题事件（新老都有；新的有 runTag，老的走 legacy 配对） */
const isGroupQuestionEventAny = (ev: TaskEvent): boolean =>
  ev.kind === "user_reply" && metaOf(ev).source === "feishu_group";

/**
 * 提问正文去噪（展示用）：剥 [群消息·来自…] 前缀与飞书原生 <at> 标签残留。
 * 有名字的 @ 留个 @Name（知道还圈了谁），空名字的整段丢掉。
 * 前缀只认 [群消息 开头——`[Bug] xxx` 这类正常内容不许吃（review P2-5）。
 */
export const cleanGroupQuestionText = (text: string): string =>
  text
    .replace(/<at user_id="[^"]*">([^<]*)<\/at>/g, (_, name: string) =>
      name.trim() ? `@${name.trim()}` : "",
    )
    .replace(/^\[群消息[^\]\n]*\](——[^\n]*)?\n?/, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();

/** 汇总事件入参（flush 组装，UI 只读消费） */
export interface GroupQaSummaryInput {
  runTag: string;
  askerOpenId: string;
  askerName: string;
  questionMessageId?: string;
  answer: string;
  ok: boolean;
}

/**
 * 轮次汇总事件（info）：问题事件（meta.restrictedRunTag）←→ 本事件
 *（meta.groupQaSummary.runTag）的配对键，失败轮也记（ok=false）。
 */
export const buildGroupQaSummaryEvent = (input: GroupQaSummaryInput) => {
  const name = input.askerName || "群成员";
  return {
    kind: "info" as const,
    text: `群问答 · ${name}：${oneLineAnswer(input.answer) || "（空回答）"}`,
    meta: {
      groupQaSummary: {
        runTag: input.runTag,
        askerOpenId: input.askerOpenId,
        askerName: name,
        ...(input.questionMessageId
          ? { questionMessageId: input.questionMessageId }
          : {}),
        answer: input.answer,
        ok: input.ok,
      },
    },
  };
};

/** 一行回答：首个非空行，压空白，120 字封顶 */
export const oneLineAnswer = (text: string): string => {
  const line =
    text
      .split("\n")
      .map((s) => s.replace(/\s+/g, " ").trim())
      .find(Boolean) ?? "";
  return line.length > 120 ? `${line.slice(0, 120)}…` : line;
};

/** 列表时间：MM-DD HH:mm（普通 formatTs 只有 HH:mm，跨天轮次不够用） */
export const formatGroupQaTs = (ts: number): string => {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

export const collectGroupQaRounds = (
  events: TaskEvent[],
  now: number = Date.now(),
): GroupQaRound[] => {
  const rounds: GroupQaRound[] = [];
  const byRunTag = new Map<string, { q?: TaskEvent; s?: TaskEvent }>();
  const ensure = (k: string) => {
    let e = byRunTag.get(k);
    if (!e) {
      e = {};
      byRunTag.set(k, e);
    }
    return e;
  };
  // 第一遍：精确配对（runTag / 群消息 id）
  const summaries: Array<{ ev: TaskEvent; s: GroupQaSummaryMeta }> = [];
  for (const ev of events) {
    if (isGroupQaSummaryEvent(ev)) {
      const s = readGroupQaSummary(ev);
      if (s) {
        summaries.push({ ev, s });
        ensure(s.runTag).s = ev;
      }
    } else if (isGroupQaQuestionEvent(ev)) {
      ensure(strOf(metaOf(ev).restrictedRunTag)).q = ev;
    }
  }
  // 配对记账：runTag → 问题事件（undefined = 汇总落单）。后面出轮次只读账，
  // 不再各自判定——判定函数读“活表”会被删键影响（review 六轮-4 踩过），账是静态快照。
  const pairedBySummary = new Map<string, TaskEvent | undefined>();
  const pairedQuestions = new Set<TaskEvent>();
  const pairOne = (s: GroupQaSummaryMeta, q: TaskEvent | undefined) => {
    if (q) pairedQuestions.add(q);
    pairedBySummary.set(s.runTag, q);
  };
  // 第一轮：runTag 精确配对
  const pendingFallback: GroupQaSummaryMeta[] = [];
  const findByRunTag = (
    s: GroupQaSummaryMeta,
  ): TaskEvent | undefined => byRunTag.get(s.runTag)?.q;
  for (const { s } of summaries) {
    const q = findByRunTag(s);
    if (q) pairOne(s, q);
    else pendingFallback.push(s);
  }
  // 第二轮：群消息 id 兜底（no_pending 落回旁路时问题没 runTag）。
  // 反查表建在精确配对之后、只含未配对问题——顺序一改也不脆（review 五轮-5）。
  const byFeishuMessageId = new Map<string, TaskEvent>();
  for (const ev of events) {
    if (isGroupQuestionEventAny(ev) && !pairedQuestions.has(ev)) {
      const mid = strOf(metaOf(ev).feishuMessageId);
      if (mid && !byFeishuMessageId.has(mid)) byFeishuMessageId.set(mid, ev);
    }
  }
  for (const s of pendingFallback) {
    // 中间这轮只为先占位：runTag 配对的问题先进账，反查表建表时自动排除它们。
    const q =
      s.questionMessageId !== undefined
        ? byFeishuMessageId.get(s.questionMessageId)
        : undefined;
    pairOne(s, q);
    // 配对成功就从表里删：两个汇总撞同一个群消息 id（重试/双写）时，后到的不再复用
    // 同一个问题（review 六轮-4）
    if (q && s.questionMessageId) byFeishuMessageId.delete(s.questionMessageId);
  }
  for (const { ev: sev, s } of summaries) {
    const q = pairedBySummary.get(s.runTag);
    const qMeta = q ? metaOf(q) : null;
    rounds.push({
      key: s.runTag,
      // 问题被裁掉 / 只剩汇总时回退汇总自己的时间，别沉底（review P1-3）
      ts: q?.ts ?? sev.ts,
      askerName:
        strOf(s.askerName) ||
        (qMeta ? strOf(qMeta.groupSender) : "") ||
        "群成员",
      askerOpenId:
        strOf(s.askerOpenId) || (qMeta ? strOf(qMeta.groupSenderOpenId) : ""),
      questionText: q ? cleanGroupQuestionText(strOf(q.text)) : "",
      answerText: strOf(s.answer),
      ok: s.ok !== false,
      answering: false,
      legacy: false,
    });
  }
  // 有问无答（新代码也会有：强关 / 崩溃打断的那轮）
  for (const [, { q }] of byRunTag) {
    if (q && !pairedQuestions.has(q)) {
      rounds.push({
        key: `open-${q.id}`,
        ts: q.ts,
        askerName: strOf(metaOf(q).groupSender) || "群成员",
        askerOpenId: strOf(metaOf(q).groupSenderOpenId),
        questionText: cleanGroupQuestionText(strOf(q.text)),
        answerText: "",
        ok: false,
        answering: now - q.ts < GROUP_QA_ANSWERING_RECENT_MS,
        legacy: false,
      });
      pairedQuestions.add(q);
    }
  }
  // 第二遍：历史数据 temporal 配对（老代码无 runTag、无汇总）
  let openLegacy: TaskEvent | null = null;
  const legacyAnswers = new Map<TaskEvent, string[]>();
  const flushLegacy = () => {
    if (!openLegacy) return;
    const answers = legacyAnswers.get(openLegacy) ?? [];
    rounds.push({
      key: `legacy-${openLegacy.id}`,
      ts: openLegacy.ts,
      askerName: strOf(metaOf(openLegacy).groupSender) || "群成员",
      askerOpenId: strOf(metaOf(openLegacy).groupSenderOpenId),
      questionText: cleanGroupQuestionText(strOf(openLegacy.text)),
      answerText: answers.join("\n\n"),
      ok: answers.length > 0,
      answering:
        answers.length === 0 &&
        now - openLegacy.ts < GROUP_QA_ANSWERING_RECENT_MS,
      legacy: true,
    });
    openLegacy = null;
  };
  for (const ev of events) {
    if (isGroupQuestionEventAny(ev) && !isGroupQaQuestionEvent(ev)) {
      if (pairedQuestions.has(ev)) continue;
      flushLegacy();
      openLegacy = ev;
      legacyAnswers.set(ev, []);
    } else if (ev.kind === "user_reply") {
      flushLegacy();
    } else if (ev.kind === "assistant_message" && openLegacy) {
      const t = strOf(ev.text).trim();
      if (t) legacyAnswers.get(openLegacy)?.push(t);
    }
  }
  flushLegacy();
  rounds.sort((a, b) => b.ts - a.ts);
  return rounds;
};
