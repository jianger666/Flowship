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
 *
 * 2026-10-14 群协作 v2：汇总事件新增可选字段（askerIsBot / noReply / needsOwner / mentioned /
 * startedAt / durationMs，契约见 server/feishu-bridge/group-contract.ts 末尾），旧数据没有、
 * 一律向后兼容；答疑旁路 run 的每条过程事件带 meta.groupRun = runTag，归「群问答」tab 的
 * 「查看过程」，主事件流默认隐藏（见 event-stream-hidden）。
 * 前端不 import server 目录（无先例），所以 groupRun 的 key 在这里自己写一份。
 */

import type { TaskEvent } from "@/lib/types";

/**
 * 答疑旁路 run 过程事件的 meta key：值 = 该轮 runTag。
 * 与 group-contract.ts 的 GROUP_RUN_META_KEY 保持一致（前端不 import server 目录，故自留一份）。
 */
export const GROUP_RUN_META_KEY = "groupRun";

/**
 * 2026-10-14 新增的可选字段（服务端 flush 时写；旧数据没有，读出时缺 / 类型不对都当没有）。
 * 与 group-contract.ts 的 GroupQaSummaryExtra 保持一致。
 */
export interface GroupQaSummaryExtraMeta {
  /** 提问人是机器人（UI 打「机器人」徽标） */
  askerIsBot?: boolean;
  /** 这轮 agent 选择了 NO_REPLY（群里没发任何东西；answer 里存 agent 原话供审计） */
  noReply?: boolean;
  /** agent 标记的「需属主确认」说明（UI 顶部醒目提示） */
  needsOwner?: string;
  /** 最终真 @ 了谁（名字列表） */
  mentioned?: string[];
  /** 本轮开始时间（ms） */
  startedAt?: number;
  /** 本轮用时（ms） */
  durationMs?: number;
}

/** 汇总事件 meta.groupQaSummary 的形状（flush 时写，见 group-outbound） */
export interface GroupQaSummaryMeta extends GroupQaSummaryExtraMeta {
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
  /** 提问人是机器人（汇总缺值时兜底看问题事件的 groupSenderIsBot；老数据 undefined） */
  askerIsBot?: boolean;
  /** agent 选择了不回复（老数据 undefined，UI 只认 === true） */
  noReply?: boolean;
  /** 需属主确认的说明（非空才有；老数据 undefined） */
  needsOwner?: string;
  /** 最终真 @ 了谁（名字；老数据 undefined） */
  mentioned?: string[];
  startedAt?: number;
  durationMs?: number;
}

/** 有问无答多久还算“回答中” */
export const GROUP_QA_ANSWERING_RECENT_MS = 30 * 60 * 1000;

const metaOf = (ev: TaskEvent): Record<string, unknown> =>
  (ev.meta ?? {}) as Record<string, unknown>;

const strOf = (v: unknown): string => (typeof v === "string" ? v : "");

/** 新增可选字段的容错读法：缺 / 类型不对一律当没有（返 undefined） */
const boolOpt = (v: unknown): boolean | undefined =>
  typeof v === "boolean" ? v : undefined;
const nonEmptyStrOpt = (v: unknown): string | undefined => {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t || undefined;
};
const msOpt = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
/** 名字列表：滤掉非字符串 / 空串；整体不是数组或滤完为空 = 没有 */
const nameListOpt = (v: unknown): string[] | undefined => {
  if (!Array.isArray(v)) return undefined;
  const out = v
    .filter((x): x is string => typeof x === "string")
    .map((x) => x.trim())
    .filter(Boolean);
  return out.length > 0 ? out : undefined;
};

/** 把可选字段收成「只带有值的 key」，写盘 / 读出共用，避免到处是 `undefined` 键 */
const compactExtra = (e: GroupQaSummaryExtraMeta): GroupQaSummaryExtraMeta => {
  const out: GroupQaSummaryExtraMeta = {};
  if (e.askerIsBot !== undefined) out.askerIsBot = e.askerIsBot;
  if (e.noReply !== undefined) out.noReply = e.noReply;
  if (e.needsOwner !== undefined) out.needsOwner = e.needsOwner;
  if (e.mentioned !== undefined) out.mentioned = e.mentioned;
  if (e.startedAt !== undefined) out.startedAt = e.startedAt;
  if (e.durationMs !== undefined) out.durationMs = e.durationMs;
  return out;
};

const readExtra = (s: Record<string, unknown>): GroupQaSummaryExtraMeta =>
  compactExtra({
    askerIsBot: boolOpt(s.askerIsBot),
    noReply: boolOpt(s.noReply),
    needsOwner: nonEmptyStrOpt(s.needsOwner),
    mentioned: nameListOpt(s.mentioned),
    startedAt: msOpt(s.startedAt),
    durationMs: msOpt(s.durationMs),
  });

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
    ...readExtra(s),
  };
};

/** 群问题事件（新老都有；新的有 runTag，老的走 legacy 配对） */
const isGroupQuestionEventAny = (ev: TaskEvent): boolean =>
  ev.kind === "user_reply" && metaOf(ev).source === "feishu_group";

/**
 * 提问正文去噪（展示用）：剥 [群消息·来自…] 前缀、全角关联回执前缀与飞书原生 <at> 标签残留。
 * 有名字的 @ 留个 @Name（知道还圈了谁），空名字的整段丢掉。
 * 前缀只认 [群消息 / ［群里托办事项 开头——`[Bug] xxx` 这类正常内容不许吃（review P2-5）。
 * 全角这行必须剥：readonly 关联轮进 tab，首行不能是内部指令（提示词外泄）。
 * 配行不配括号：about 是自由文本、里面可能有 `］`，配到第一个括号就收会剩半截指令；前缀恒占首行，行尾即边界。
 */
export const cleanGroupQuestionText = (text: string): string =>
  text
    .replace(/<at user_id="[^"]*">([^<]*)<\/at>/g, (_, name: string) =>
      name.trim() ? `@${name.trim()}` : "",
    )
    .replace(/^［群里托办事项[^\n]*\n?/, "")
    .replace(/^\[群消息[^\]\n]*\](——[^\n]*)?\n?/, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();

/** 汇总事件入参（flush 组装，UI 只读消费）；可选字段见 {@link GroupQaSummaryExtraMeta} */
export interface GroupQaSummaryInput extends GroupQaSummaryExtraMeta {
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
  // noReply：answer 里存的是 agent 原话（如 NO_REPLY），摘要行不能把它当回答念出来
  const summary =
    input.noReply === true
      ? "（已读、无需回复）"
      : oneLineAnswer(input.answer) || "（空回答）";
  return {
    kind: "info" as const,
    text: `群问答 · ${name}：${summary}`,
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
        // 写盘同样过一遍校验：入参类型不对（JS 调用方 / 服务端传了脏值）不落盘，读出端就不必猜
        ...readExtra(input as unknown as Record<string, unknown>),
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

/**
 * 不进 tab 配对的问题事件：推进占格 / 关联回执喂会话（都没 runTag，进 temporal 就是幻影轮）。
 * legacy 第二遍与兜底反查表共用这一个，保持一致（防御性对齐：哪天汇总链路一改，
 * 兜底也不会把汇总配到占格/回执问题上）。主流程显隐不受影响。
 */
const isQaExcludedQuestion = (ev: TaskEvent): boolean => {
  const m = metaOf(ev);
  return (
    m.advancePreempted === true ||
    m.correlatedAnswer === true ||
    typeof m.correlatedAnswer === "string"
  );
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
      // 脏问题不进兜底表（和 legacy 同一个谓词，见 isQaExcludedQuestion）
      if (isQaExcludedQuestion(ev)) continue;
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
      questionText: q ? cleanGroupQuestionText(strOf(q.text)) : "（未知问题）",
      answerText: strOf(s.answer),
      ok: s.ok !== false,
      answering: false,
      legacy: false,
      // 新字段透传；askerIsBot 汇总没写时兜底看问题事件（服务端若在入向事件上标了 groupSenderIsBot）
      ...compactExtra({
        askerIsBot:
          s.askerIsBot ?? (qMeta ? boolOpt(qMeta.groupSenderIsBot) : undefined),
        noReply: s.noReply,
        needsOwner: s.needsOwner,
        mentioned: s.mentioned,
        startedAt: s.startedAt,
        durationMs: s.durationMs,
      }),
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
        ...compactExtra({ askerIsBot: boolOpt(metaOf(q).groupSenderIsBot) }),
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
      ...compactExtra({
        askerIsBot: boolOpt(metaOf(openLegacy).groupSenderIsBot),
      }),
    });
    openLegacy = null;
  };
  for (const ev of events) {
    if (isGroupQuestionEventAny(ev) && !isGroupQaQuestionEvent(ev)) {
      if (pairedQuestions.has(ev)) continue;
      // 推进占格 / 关联回执喂会话都不进 temporal 配对：它们没 runTag，
      // 放任 temporal 会把属主会话的只言片语 scooped 当答案、造幻影历史轮
      // （advancePreempted=review 九轮-3；correlatedAnswer=本轮补齐）。
      // 主流程里它们照常展示，只是不进 tab。
      // 注：pendingAskAnswer 标记已退役（ask-inject 不再写）——收口靠 kind === "ask_user_reply"，
      // 任何答复都是边界，不要再找这个标记。
      if (isQaExcludedQuestion(ev)) {
        flushLegacy();
        continue;
      }
      flushLegacy();
      openLegacy = ev;
      legacyAnswers.set(ev, []);
    } else if (ev.kind === "user_reply" || ev.kind === "ask_user_reply") {
      // ask_user_reply 也是边界：pendingAsk 答复（群代答/属主自答）之后的主会话只言片语，
      // 不许再 scooped 进之前未收口的历史问题。
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

/** 「待你决定」的时间窗：超过这么久的待确认不再顶在 tab 顶部（没有「已处理」状态可记，不设窗会永远吵） */
export const GROUP_QA_NEEDS_OWNER_RECENT_MS = 24 * 60 * 60 * 1000;

/**
 * 需要属主拍板的轮次：needsOwner 非空、且在时间窗内（默认 24h），按问题时间从新到旧。
 * 纯函数、不改入参；tab 顶部「待你决定」区与标签上的红点都吃它。
 * 第二参数可选（不破坏契约签名）：测试注入 now / 调窗口。
 */
export const pickRoundsNeedingOwner = (
  rounds: GroupQaRound[],
  opts?: { now?: number; maxAgeMs?: number },
): GroupQaRound[] => {
  const now = opts?.now ?? Date.now();
  const maxAge = opts?.maxAgeMs ?? GROUP_QA_NEEDS_OWNER_RECENT_MS;
  return rounds
    .filter(
      (r) =>
        typeof r.needsOwner === "string" &&
        r.needsOwner.trim() !== "" &&
        now - r.ts <= maxAge,
    )
    .sort((a, b) => b.ts - a.ts);
};

// ----------------- 答疑 run 的过程事件（「查看过程」折叠块的数据源） -----------------

/** 事件属于哪一轮答疑旁路 run（meta.groupRun 非空字符串）；不是则 "" */
export const groupRunTagOf = (ev: TaskEvent): string => {
  const v = metaOf(ev)[GROUP_RUN_META_KEY];
  return typeof v === "string" ? v.trim() : "";
};

/** 「查看过程」最多列几条（超出显示「还有 n 条」） */
export const GROUP_RUN_STEPS_LIMIT = 30;

export interface GroupRunStep {
  id: string;
  ts: number;
  /** reply = agent 旁白 / 回复；tool = 工具调用；error = 失败 */
  kind: "reply" | "tool" | "error";
  /** kind=tool 时的工具名 */
  tool?: string;
  /** reply / error：首行文本；tool：参数摘要（可能为空串） */
  text: string;
}

const clipLine = (s: string, max: number): string => {
  const line = s.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
};

/** 参数里最能说明「它在干嘛」的字段，按优先级挑第一个字符串 */
const TOOL_ARG_KEYS = [
  "command",
  "cmd",
  "path",
  "file_path",
  "filePath",
  "pattern",
  "query",
  "url",
  "description",
] as const;

/**
 * 工具调用的参数摘要：args 是（可能被截断的）JSON 字符串。
 * 先按常见字段挑一个；解析不了 / 没有这些字段就把原串压成一行。
 */
export const summarizeGroupRunToolArgs = (args: unknown): string => {
  if (typeof args !== "string" || !args.trim()) return "";
  // 落盘截断后缀形如 …(truncated 123 chars)，剥了才 parse 得动
  const cleaned = args.replace(/…\(truncated \d+ chars\)$/, "").trim();
  try {
    const v: unknown = JSON.parse(cleaned);
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const o = v as Record<string, unknown>;
      for (const k of TOOL_ARG_KEYS) {
        const x = o[k];
        if (typeof x === "string" && x.trim()) return clipLine(x, 100);
      }
    }
  } catch {
    // 非 JSON（截断 / 脏数据）→ 走兜底
  }
  return clipLine(cleaned, 100);
};

/**
 * 某一轮答疑 run 的过程精简列表：assistant_message（首行）/ tool_call（工具名 + 参数摘要）/ error。
 * thinking / tool_result / info 不列——「查看过程」是让属主快速扫一眼它干了啥，不是回放。
 * 按事件落盘顺序；`steps` 最多 limit 条，`total` 是真实总数（调用方用 total - steps.length 显示「还有 n 条」）。
 */
export const collectGroupRunSteps = (
  events: readonly TaskEvent[],
  runTag: string,
  limit: number = GROUP_RUN_STEPS_LIMIT,
): { steps: GroupRunStep[]; total: number } => {
  const all: GroupRunStep[] = [];
  if (!runTag) return { steps: all, total: 0 };
  for (const ev of events) {
    if (groupRunTagOf(ev) !== runTag) continue;
    if (ev.kind === "assistant_message") {
      const text = clipLine(
        strOf(ev.text).split("\n").find((l) => l.trim()) ?? "",
        160,
      );
      if (text) all.push({ id: ev.id, ts: ev.ts, kind: "reply", text });
    } else if (ev.kind === "tool_call") {
      const m = metaOf(ev);
      const tool = strOf(m.name) || "tool";
      all.push({
        id: ev.id,
        ts: ev.ts,
        kind: "tool",
        tool,
        text: summarizeGroupRunToolArgs(m.args),
      });
    } else if (ev.kind === "error") {
      all.push({
        id: ev.id,
        ts: ev.ts,
        kind: "error",
        text:
          clipLine(strOf(ev.text).split("\n").find((l) => l.trim()) ?? "", 160) ||
          "出错了",
      });
    }
  }
  return { steps: all.slice(0, Math.max(0, limit)), total: all.length };
};
