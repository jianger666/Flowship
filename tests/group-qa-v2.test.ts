/**
 * 群协作 v2 对 group-qa 的扩展：
 * - 汇总事件新增可选字段（askerIsBot / noReply / needsOwner / mentioned / startedAt / durationMs）
 *   的写入 / 读出 / 容错 / 向后兼容；
 * - 聚合透传到 GroupQaRound；pickRoundsNeedingOwner；
 * - 「查看过程」的数据源 collectGroupRunSteps（meta.groupRun 归属 + 精简 + 30 条封顶）。
 *
 * 契约见 server/feishu-bridge/group-contract.ts 末尾「落盘事件的 meta 约定」。
 */
import { describe, expect, it } from "vitest";

import {
  buildGroupQaSummaryEvent,
  collectGroupQaRounds,
  collectGroupRunSteps,
  GROUP_QA_ANSWERING_RECENT_MS,
  GROUP_QA_NEEDS_OWNER_RECENT_MS,
  GROUP_RUN_META_KEY,
  GROUP_RUN_STEPS_LIMIT,
  groupRunTagOf,
  pickRoundsNeedingOwner,
  readGroupQaSummary,
  summarizeGroupRunToolArgs,
  type GroupQaRound,
} from "@/lib/group-qa";
import type { TaskEvent } from "@/lib/types";

let seq = 0;
const ev = (
  over: Partial<TaskEvent> & { kind: TaskEvent["kind"] },
): TaskEvent => ({ id: `v2_${seq++}`, ts: 1_000_000, text: "", ...over });

const NOW = 2_000_000_000_000;

const base = {
  runTag: "tok1",
  askerOpenId: "ou_bot",
  askerName: "安若流年",
  answer: "好的",
  ok: true,
};

/** 把 buildGroupQaSummaryEvent 的产物落成 TaskEvent（模拟落盘再读回） */
const asEvent = (input: Parameters<typeof buildGroupQaSummaryEvent>[0]) => {
  const b = buildGroupQaSummaryEvent(input);
  return ev({ kind: b.kind, text: b.text, meta: b.meta });
};

describe("契约常量", () => {
  it("groupRun 的 meta key 与 group-contract 一致", () => {
    expect(GROUP_RUN_META_KEY).toBe("groupRun");
  });
});

describe("buildGroupQaSummaryEvent：新字段写入", () => {
  it("六个新字段按契约落到 meta.groupQaSummary", () => {
    const e = buildGroupQaSummaryEvent({
      ...base,
      askerIsBot: true,
      noReply: false,
      needsOwner: "要不要发布",
      mentioned: ["张三", "安若流年"],
      startedAt: 1_700_000_000_000,
      durationMs: 72_000,
    });
    expect(e.meta.groupQaSummary).toMatchObject({
      askerIsBot: true,
      noReply: false,
      needsOwner: "要不要发布",
      mentioned: ["张三", "安若流年"],
      startedAt: 1_700_000_000_000,
      durationMs: 72_000,
    });
  });

  it("旧调用（不带新字段）的产物里没有这些 key，旧字段不变", () => {
    const e = buildGroupQaSummaryEvent(base);
    const s = e.meta.groupQaSummary as Record<string, unknown>;
    for (const k of [
      "askerIsBot",
      "noReply",
      "needsOwner",
      "mentioned",
      "startedAt",
      "durationMs",
    ]) {
      expect(k in s, k).toBe(false);
    }
    expect(s).toMatchObject({ runTag: "tok1", answer: "好的", ok: true });
  });

  it("noReply 时摘要行写「已读、无需回复」，不把 agent 原话（NO_REPLY）念出来", () => {
    const e = buildGroupQaSummaryEvent({
      ...base,
      answer: "NO_REPLY",
      noReply: true,
    });
    expect(e.text).toBe("群问答 · 安若流年：（已读、无需回复）");
    // 原话照样存着供审计
    expect((e.meta.groupQaSummary as { answer: string }).answer).toBe(
      "NO_REPLY",
    );
  });

  it("noReply=false / 缺省仍用回答首行", () => {
    expect(buildGroupQaSummaryEvent({ ...base, noReply: false }).text).toBe(
      "群问答 · 安若流年：好的",
    );
    expect(buildGroupQaSummaryEvent(base).text).toBe("群问答 · 安若流年：好的");
  });

  it("脏入参不落盘：类型不对 / 空串 / 空数组 / 负数都当没有", () => {
    const e = buildGroupQaSummaryEvent({
      ...base,
      askerIsBot: "yes" as unknown as boolean,
      needsOwner: "   ",
      mentioned: [] as string[],
      startedAt: -1,
      durationMs: Number.NaN,
    });
    expect(Object.keys(e.meta.groupQaSummary).sort()).toEqual(
      ["answer", "askerName", "askerOpenId", "ok", "runTag"].sort(),
    );
  });
});

describe("readGroupQaSummary：新字段读出与容错", () => {
  it("写入再读出：往返一致", () => {
    const s = readGroupQaSummary(
      asEvent({
        ...base,
        askerIsBot: true,
        noReply: true,
        needsOwner: "要属主拍板",
        mentioned: ["李四"],
        startedAt: 5,
        durationMs: 1234,
      }),
    );
    expect(s).toMatchObject({
      runTag: "tok1",
      askerIsBot: true,
      noReply: true,
      needsOwner: "要属主拍板",
      mentioned: ["李四"],
      startedAt: 5,
      durationMs: 1234,
    });
  });

  it("旧数据（没有新字段）读出时新字段都是 undefined", () => {
    const s = readGroupQaSummary(
      ev({
        kind: "info",
        meta: {
          groupQaSummary: {
            runTag: "old",
            askerOpenId: "ou",
            askerName: "老李",
            answer: "x",
            ok: true,
          },
        },
      }),
    );
    expect(s).not.toBeNull();
    expect(s?.askerIsBot).toBeUndefined();
    expect(s?.noReply).toBeUndefined();
    expect(s?.needsOwner).toBeUndefined();
    expect(s?.mentioned).toBeUndefined();
    expect(s?.startedAt).toBeUndefined();
    expect(s?.durationMs).toBeUndefined();
  });

  it("类型不对的新字段当没有，不影响旧字段与别的新字段", () => {
    const s = readGroupQaSummary(
      ev({
        kind: "info",
        meta: {
          groupQaSummary: {
            runTag: "dirty",
            askerOpenId: "ou",
            askerName: "脏",
            answer: "a",
            ok: true,
            askerIsBot: "true",
            noReply: 1,
            needsOwner: 42,
            mentioned: "张三",
            startedAt: "123",
            durationMs: 800,
          },
        },
      }),
    );
    expect(s?.askerIsBot).toBeUndefined();
    expect(s?.noReply).toBeUndefined();
    expect(s?.needsOwner).toBeUndefined();
    expect(s?.mentioned).toBeUndefined();
    expect(s?.startedAt).toBeUndefined();
    expect(s?.durationMs).toBe(800);
    expect(s?.answer).toBe("a");
  });

  it("mentioned 数组里混了非字符串 / 空串：只留有效名字；全无效 = 没有", () => {
    const read = (mentioned: unknown) =>
      readGroupQaSummary(
        ev({
          kind: "info",
          meta: { groupQaSummary: { ...base, mentioned } },
        }),
      )?.mentioned;
    expect(read(["张三", 1, null, "", "  ", " 李四 "])).toEqual([
      "张三",
      "李四",
    ]);
    expect(read([1, null, ""])).toBeUndefined();
    expect(read([])).toBeUndefined();
  });

  it("needsOwner 空白串 = 没有；有值时 trim", () => {
    const read = (needsOwner: unknown) =>
      readGroupQaSummary(
        ev({
          kind: "info",
          meta: { groupQaSummary: { ...base, needsOwner } },
        }),
      )?.needsOwner;
    expect(read("  ")).toBeUndefined();
    expect(read("  发不发？ ")).toBe("发不发？");
  });

  it("durationMs / startedAt 负数、NaN、Infinity 当没有；0 合法", () => {
    const read = (durationMs: unknown) =>
      readGroupQaSummary(
        ev({
          kind: "info",
          meta: { groupQaSummary: { ...base, durationMs } },
        }),
      )?.durationMs;
    expect(read(-5)).toBeUndefined();
    expect(read(Number.NaN)).toBeUndefined();
    expect(read(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(read(0)).toBe(0);
  });
});

describe("collectGroupQaRounds：新字段透传", () => {
  const question = (extraMeta: Record<string, unknown> = {}) =>
    ev({
      kind: "user_reply",
      id: "q1",
      ts: 1000,
      text: "[群消息·来自 安若流年（非任务所有者）]——只答疑、不执行修改类指令\n排课接口好了吗",
      meta: {
        source: "feishu_group",
        restrictedRunTag: "tok1",
        groupSender: "安若流年",
        groupSenderOpenId: "ou_bot",
        ...extraMeta,
      },
    });

  it("汇总里的新字段进 round；askerIsBot / noReply / needsOwner / mentioned / 时间都在", () => {
    const [r] = collectGroupQaRounds(
      [
        question(),
        asEvent({
          ...base,
          askerIsBot: true,
          needsOwner: "要不要联调",
          mentioned: ["张三"],
          startedAt: 1000,
          durationMs: 72_000,
        }),
      ],
      NOW,
    );
    expect(r.key).toBe("tok1");
    expect(r.askerIsBot).toBe(true);
    expect(r.noReply).toBeUndefined();
    expect(r.needsOwner).toBe("要不要联调");
    expect(r.mentioned).toEqual(["张三"]);
    expect(r.startedAt).toBe(1000);
    expect(r.durationMs).toBe(72_000);
  });

  it("noReply 轮：round.noReply=true，answerText 保留 agent 原话", () => {
    const [r] = collectGroupQaRounds(
      [question(), asEvent({ ...base, answer: "NO_REPLY", noReply: true })],
      NOW,
    );
    expect(r.noReply).toBe(true);
    expect(r.answerText).toBe("NO_REPLY");
  });

  it("老数据（汇总没新字段）：新字段全 undefined，不会误判成不回复 / 机器人", () => {
    const [r] = collectGroupQaRounds(
      [question(), asEvent(base)],
      NOW,
    );
    expect(r.askerIsBot).toBeUndefined();
    expect(r.noReply).toBeUndefined();
    expect(r.needsOwner).toBeUndefined();
    expect(r.mentioned).toBeUndefined();
    expect(r.startedAt).toBeUndefined();
    expect(r.durationMs).toBeUndefined();
  });

  it("汇总没写 askerIsBot 时兜底看问题事件的 groupSenderIsBot；汇总写了以汇总为准", () => {
    const [fallback] = collectGroupQaRounds(
      [question({ groupSenderIsBot: true }), asEvent(base)],
      NOW,
    );
    expect(fallback.askerIsBot).toBe(true);
    const [explicit] = collectGroupQaRounds(
      [
        question({ groupSenderIsBot: true }),
        asEvent({ ...base, askerIsBot: false }),
      ],
      NOW,
    );
    expect(explicit.askerIsBot).toBe(false);
  });

  it("有问无答的轮次也能带上问题事件上的 groupSenderIsBot", () => {
    const [r] = collectGroupQaRounds(
      [question({ groupSenderIsBot: true })],
      1000 + 60_000, // 问题后 1 分钟：还算「回答中」
    );
    expect(r.answering).toBe(true);
    expect(r.askerIsBot).toBe(true);
  });
});

describe("pickRoundsNeedingOwner", () => {
  const round = (over: Partial<GroupQaRound>): GroupQaRound => ({
    key: "k",
    ts: NOW - 1000,
    askerName: "A",
    askerOpenId: "ou",
    questionText: "",
    answerText: "",
    ok: true,
    answering: false,
    legacy: false,
    ...over,
  });

  it("只留 needsOwner 非空的，按时间从新到旧", () => {
    const rounds = [
      round({ key: "a", ts: NOW - 3000, needsOwner: "甲" }),
      round({ key: "b", ts: NOW - 2000 }),
      round({ key: "c", ts: NOW - 1000, needsOwner: "丙" }),
      round({ key: "d", ts: NOW - 500, needsOwner: "   " }),
      round({ key: "e", ts: NOW - 100, needsOwner: "" }),
    ];
    expect(pickRoundsNeedingOwner(rounds, { now: NOW }).map((r) => r.key)).toEqual(
      ["c", "a"],
    );
  });

  it("超出时间窗（默认 24h）的不再顶在 tab 顶部；窗口可调", () => {
    const old = round({
      key: "old",
      ts: NOW - GROUP_QA_NEEDS_OWNER_RECENT_MS - 1,
      needsOwner: "旧",
    });
    const edge = round({
      key: "edge",
      ts: NOW - GROUP_QA_NEEDS_OWNER_RECENT_MS,
      needsOwner: "边界",
    });
    expect(pickRoundsNeedingOwner([old, edge], { now: NOW }).map((r) => r.key)).toEqual(
      ["edge"],
    );
    expect(
      pickRoundsNeedingOwner([old, edge], { now: NOW, maxAgeMs: Infinity }).map(
        (r) => r.key,
      ),
    ).toEqual(["edge", "old"]);
  });

  it("空输入 / 无待决定 → 空数组；不改入参顺序", () => {
    expect(pickRoundsNeedingOwner([], { now: NOW })).toEqual([]);
    const rounds = [
      round({ key: "x", ts: NOW - 2000, needsOwner: "x" }),
      round({ key: "y", ts: NOW - 1000, needsOwner: "y" }),
    ];
    pickRoundsNeedingOwner(rounds, { now: NOW });
    expect(rounds.map((r) => r.key)).toEqual(["x", "y"]);
    expect(
      pickRoundsNeedingOwner([round({ key: "z" })], { now: NOW }),
    ).toEqual([]);
  });

  it("不传 opts 用当前时间（刚发生的算近）", () => {
    const r = round({ key: "now", ts: Date.now() - 1000, needsOwner: "n" });
    expect(pickRoundsNeedingOwner([r]).map((x) => x.key)).toEqual(["now"]);
  });
});

describe("groupRunTagOf", () => {
  it("非空字符串才算；其余一律空串", () => {
    expect(groupRunTagOf(ev({ kind: "info", meta: { groupRun: "tok1" } }))).toBe(
      "tok1",
    );
    expect(groupRunTagOf(ev({ kind: "info", meta: { groupRun: "  " } }))).toBe("");
    expect(groupRunTagOf(ev({ kind: "info", meta: { groupRun: 3 } }))).toBe("");
    expect(groupRunTagOf(ev({ kind: "info" }))).toBe("");
  });
});

describe("summarizeGroupRunToolArgs", () => {
  it("按常见字段挑摘要（command 优先）", () => {
    expect(
      summarizeGroupRunToolArgs(JSON.stringify({ command: "ls src", path: "/a" })),
    ).toBe("ls src");
    expect(summarizeGroupRunToolArgs(JSON.stringify({ path: "/a/b.ts" }))).toBe(
      "/a/b.ts",
    );
    expect(summarizeGroupRunToolArgs(JSON.stringify({ query: "排课" }))).toBe(
      "排课",
    );
  });

  it("没有常见字段 / 非 JSON / 截断后缀：压成一行兜底；超长截断", () => {
    expect(summarizeGroupRunToolArgs(JSON.stringify({ foo: 1 }))).toBe('{"foo":1}');
    expect(summarizeGroupRunToolArgs("not json\nline2")).toBe("not json line2");
    expect(
      summarizeGroupRunToolArgs(
        `${JSON.stringify({ command: "echo hi" })}…(truncated 50 chars)`,
      ),
    ).toBe("echo hi");
    const long = summarizeGroupRunToolArgs(JSON.stringify({ command: "x".repeat(300) }));
    expect(long.length).toBe(101);
    expect(long.endsWith("…")).toBe(true);
  });

  it("缺 / 空 / 非字符串 = 空串", () => {
    expect(summarizeGroupRunToolArgs(undefined)).toBe("");
    expect(summarizeGroupRunToolArgs("  ")).toBe("");
    expect(summarizeGroupRunToolArgs({ command: "ls" })).toBe("");
  });
});

describe("collectGroupRunSteps（查看过程）", () => {
  const run = (
    kind: TaskEvent["kind"],
    tag: string,
    extra: { text?: string; meta?: Record<string, unknown> } = {},
  ) =>
    ev({
      kind,
      text: extra.text ?? "",
      meta: { groupRun: tag, ...(extra.meta ?? {}) },
    });

  it("只挑 meta.groupRun === runTag 的；thinking / tool_result / info 不列；顺序 = 落盘顺序", () => {
    const events: TaskEvent[] = [
      ev({ kind: "assistant_message", text: "属主自己的话" }),
      run("thinking", "tok1", { text: "想一想" }),
      run("assistant_message", "tok1", { text: "先查一下\n第二行" }),
      run("tool_call", "tok1", {
        meta: { name: "Shell", args: JSON.stringify({ command: "ls" }) },
      }),
      run("tool_result", "tok1", { text: "a.ts" }),
      run("info", "tok1", { text: "杂项" }),
      run("assistant_message", "tok2", { text: "别的轮" }),
      run("error", "tok1", { text: "超时\n堆栈…" }),
    ];
    const { steps, total } = collectGroupRunSteps(events, "tok1");
    expect(total).toBe(3);
    expect(steps.map((s) => [s.kind, s.tool, s.text])).toEqual([
      ["reply", undefined, "先查一下"],
      ["tool", "Shell", "ls"],
      ["error", undefined, "超时"],
    ]);
  });

  it("空白旁白不列；tool_call 缺 name 兜底「tool」、缺 args 摘要为空串", () => {
    const { steps, total } = collectGroupRunSteps(
      [
        run("assistant_message", "t", { text: "  \n " }),
        run("tool_call", "t", { meta: {} }),
      ],
      "t",
    );
    expect(total).toBe(1);
    expect(steps[0]).toMatchObject({ kind: "tool", tool: "tool", text: "" });
  });

  it("最多 30 条，total 是真实总数（UI 用 total - steps.length 显示「还有 n 条」）", () => {
    const events = Array.from({ length: 45 }, (_, i) =>
      run("tool_call", "big", { meta: { name: `T${i}` } }),
    );
    const { steps, total } = collectGroupRunSteps(events, "big");
    expect(GROUP_RUN_STEPS_LIMIT).toBe(30);
    expect(steps).toHaveLength(30);
    expect(total).toBe(45);
    expect(steps[0].tool).toBe("T0");
    expect(steps[29].tool).toBe("T29");
  });

  it("limit 可调；runTag 为空 / 没有匹配事件 → 空", () => {
    const events = [run("tool_call", "a", { meta: { name: "X" } })];
    expect(collectGroupRunSteps(events, "a", 0)).toEqual({ steps: [], total: 1 });
    expect(collectGroupRunSteps(events, "")).toEqual({ steps: [], total: 0 });
    expect(collectGroupRunSteps(events, "zzz")).toEqual({ steps: [], total: 0 });
    expect(collectGroupRunSteps([], "a")).toEqual({ steps: [], total: 0 });
  });
});

// G4-01：有问无答轮次的 round.key 必须就是 runTag——卡片「查看过程」拿 round.key 当 runTag 过滤
// meta.groupRun，key 一旦是别的形状（曾是 `open-<事件id>`）就永远匹配不上。
// 用真实形态的事件序列：问题 = group-route 写的 user_reply（meta.restrictedRunTag）、
// 过程事件 = 旁路 run 经 writeOwnedEventAndPublish 落盘（meta.groupRun = 同一个 runTag）。
describe("有问无答轮次的「查看过程」（G4-01）", () => {
  const RUN = "grp_tok_open_1";
  const question = (id: string, ts: number, runTag: string) =>
    ev({
      kind: "user_reply",
      id,
      ts,
      text: '[群消息·来自 李四（非任务所有者）]——只答疑\n<at user_id="ou_bot"></at> 埋点查了吗',
      meta: {
        source: "feishu_group",
        feishuMessageId: `om_${id}`,
        groupChatId: "oc_x",
        groupSender: "李四",
        groupSenderOpenId: "ou_li",
        restrictedRunTag: runTag,
      },
    });
  const proc = (
    id: string,
    ts: number,
    kind: TaskEvent["kind"],
    runTag: string,
    text: string,
    meta: Record<string, unknown> = {},
  ) => ev({ kind, id, ts, text, meta: { groupRun: runTag, ...meta } });
  /** 一轮旁路 run 的过程：旁白 + 一次 Shell 调用（含 tool_result 与 thinking 这两类不列的） */
  const processOf = (runTag: string, t0: number): TaskEvent[] => [
    proc(`${runTag}_th`, t0 + 1, "thinking", runTag, "想一想"),
    proc(`${runTag}_a1`, t0 + 2, "assistant_message", runTag, "我先查一下埋点"),
    proc(`${runTag}_tc`, t0 + 3, "tool_call", runTag, "调用 Shell:ls", {
      callId: "c1",
      name: "Shell",
      args: JSON.stringify({ command: "ls src" }),
    }),
    proc(`${runTag}_tr`, t0 + 4, "tool_result", runTag, "a.ts", { callId: "c1" }),
  ];

  it("进行中（近 30 分钟、没汇总）：用 round.key 能取到过程步骤", () => {
    const t0 = NOW - 60_000;
    const events = [question("q1", t0, RUN), ...processOf(RUN, t0)];
    const rounds = collectGroupQaRounds(events, NOW);
    expect(rounds).toHaveLength(1);
    expect(rounds[0]).toMatchObject({ answering: true, legacy: false });
    const { steps, total } = collectGroupRunSteps(events, rounds[0]!.key);
    expect(total).toBe(2);
    expect(steps.map((s) => [s.kind, s.tool, s.text])).toEqual([
      ["reply", undefined, "我先查一下埋点"],
      ["tool", "Shell", "ls src"],
    ]);
  });

  it("被打断 / 汇总缺失（陈旧、没汇总）：同样能看到过程", () => {
    const t0 = NOW - GROUP_QA_ANSWERING_RECENT_MS - 5_000;
    const events = [question("q2", t0, RUN), ...processOf(RUN, t0)];
    const rounds = collectGroupQaRounds(events, NOW);
    expect(rounds[0]).toMatchObject({ answering: false, ok: false, answerText: "" });
    expect(collectGroupRunSteps(events, rounds[0]!.key).total).toBe(2);
  });

  it("汇总落地后 key 不变：同一轮从「回答中」到「已答」展开状态 / DOM id 不丢", () => {
    const t0 = NOW - 60_000;
    const open = [question("q3", t0, RUN), ...processOf(RUN, t0)];
    const before = collectGroupQaRounds(open, NOW);
    const after = collectGroupQaRounds(
      [
        ...open,
        asEvent({
          runTag: RUN,
          askerOpenId: "ou_li",
          askerName: "李四",
          answer: "查了，都上报了",
          ok: true,
        }),
      ],
      NOW,
    );
    expect(after).toHaveLength(1);
    expect(after[0]!.key).toBe(before[0]!.key);
    expect(collectGroupRunSteps(open, after[0]!.key).total).toBe(2);
  });

  it("多轮并存：每轮 key 各自等于自己的 runTag，过程互不串", () => {
    const t0 = NOW - 120_000;
    const events = [
      question("qa", t0, "tokA"),
      ...processOf("tokA", t0),
      question("qb", t0 + 10_000, "tokB"),
      proc("tokB_a1", t0 + 10_001, "assistant_message", "tokB", "B 的旁白"),
    ];
    const rounds = collectGroupQaRounds(events, NOW);
    expect(rounds.map((r) => r.key).sort()).toEqual(["tokA", "tokB"]);
    expect(collectGroupRunSteps(events, "tokA").total).toBe(2);
    const b = rounds.find((r) => r.key === "tokB")!;
    expect(collectGroupRunSteps(events, b.key).steps.map((s) => s.text)).toEqual([
      "B 的旁白",
    ]);
  });
});
