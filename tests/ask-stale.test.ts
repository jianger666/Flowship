/**
 * 飞书 ask 卡「作废」语义（M5-03）
 *
 * 核实结论：
 * (b) 取消 / 顶替 / 停止 / 重启 / 过期这些路径**从不置卡**。它们都经 `supersedePendingAsks`
 *     写一条 `info` 作废标记（`meta.supersededAskId`），但只有「答」（card-action / ask-inject /
 *     ask-reply 路由）和「跳过」（ask-skip）两类了结会调 settleAskCards——
 *     取消 / 顶替 / 停止的卡原样挂着、按钮还能点。作废标记经 `writeEventAndPublish` 会 fanout
 *     到全局 task 流 tap，飞书桥接本来就订着这个 tap（group-outbound），所以**不用碰
 *     chat-pending / runner**：在 tap 里认出作废标记、调同一个收口点即可。
 * (c) 点旧卡的反馈文案：群卡无条件说「这个问题已经有人回答了」，取消 / 顶替 / 重启 / 跳过 / 过期
 *     时这句话是错的。真相在事件流里（答 = ask_user_reply、跳过 / 过期 / 作废 = 标记事件），
 *     按它分流文案；拿不准（登记丢了、事件还没落盘）就说中性的「已失效」。
 *
 * 全部 mock 飞书调用，不依赖真实网络。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TMP = path.join(os.tmpdir(), `ask-stale-${Date.now()}`);
process.env.FLOWSHIP_DATA_DIR = path.join(TMP, "data");

const {
  batchUpdateCard,
  sendInteractiveCardToChat,
  sendMarkdownCardToChat,
} = vi.hoisted(() => ({
  batchUpdateCard: vi.fn<
    (cardId: string, actions: unknown[], seq: number) => Promise<void>
  >(async () => undefined),
  sendInteractiveCardToChat: vi.fn(),
  sendMarkdownCardToChat: vi.fn(),
}));

vi.mock("@/lib/server/feishu-bridge/lark-api", () => ({
  batchUpdateCard,
  sendInteractiveCardToChat,
  sendMarkdownCardToChat,
}));

const {
  ASK_CARD_ANSWERED_HINT,
  ASK_CARD_EXPIRED_HINT,
  ASK_CARD_SKIPPED_HINT,
  ASK_CARD_VOID_HINT,
  __resetAskCardSettleForTest,
  settleAskCards,
} = await import("@/lib/server/feishu-bridge/ask-card-settle");
const {
  classifyStaleAsk,
  parseAskVoidMarker,
  resolveStaleAskReason,
  settleAskCardsOnVoidMarker,
  staleAskButtonText,
  staleAskReplyText,
} = await import("@/lib/server/feishu-bridge/ask-stale");
const { __setCardMapMaxForTest, rememberAskCard } = await import(
  "@/lib/server/feishu-bridge/card-map"
);
const {
  __resetGroupOutboundForTest,
  __setGroupOutboundDepsForTest,
  ensureFeishuGroupOutboundRegistered,
  handleGroupOutboundEvent,
} = await import("@/lib/server/feishu-bridge/group-outbound");
const { publish } = await import("@/lib/server/task-stream");

const TASK_ID = "task-1";
const ASK_ID = "ask-1";
const QUESTIONS = [
  {
    id: "q1",
    question: "选哪个方案",
    allowText: true,
    options: [
      { id: "opt_a", label: "方案 A" },
      { id: "opt_b", label: "方案 B" },
    ],
  },
];

type Ev = {
  id: string;
  ts: number;
  kind: string;
  text: string;
  meta?: Record<string, unknown>;
};
let evSeq = 0;
const ev = (kind: string, meta?: Record<string, unknown>, text = ""): Ev => ({
  id: `e${++evSeq}`,
  ts: Date.now(),
  kind,
  text,
  ...(meta ? { meta } : {}),
});

const requestEvent = (askId = ASK_ID): Ev =>
  ev("ask_user_request", { askId, token: "tok", questions: QUESTIONS });
const replyEvent = (askId = ASK_ID): Ev =>
  ev("ask_user_reply", { askId, source: "feishu" });
const voidMarker = (askId = ASK_ID): Ev =>
  ev("info", { supersededAskId: askId }, "上一组提问因用户停止失效、无需再回答。");
const skipMarker = (askId = ASK_ID): Ev =>
  ev("info", { supersededAskId: askId, askSkipped: true });
const expireMarker = (askId = ASK_ID): Ev =>
  ev("info", { supersededAskId: askId, askExpired: true });

const seedTwoCards = async (): Promise<void> => {
  for (const [messageId, cardId, routeTaskId] of [
    ["om_p2p", "card_p2p", TASK_ID],
    ["om_group", "card_group", ""],
  ] as const) {
    await rememberAskCard({
      messageId,
      cardId,
      routeTaskId,
      askTaskId: TASK_ID,
      askId: ASK_ID,
    });
  }
};

const patchedJson = (): string => JSON.stringify(batchUpdateCard.mock.calls);
const loadTaskWith =
  (events: Ev[]) =>
  async (): Promise<{ events: Ev[] } | null> => ({ events });

beforeEach(async () => {
  vi.clearAllMocks();
  await fs.rm(TMP, { recursive: true, force: true });
  await fs.mkdir(path.join(TMP, "data"), { recursive: true });
  __setCardMapMaxForTest(20);
  __resetAskCardSettleForTest();
});

afterEach(async () => {
  __resetGroupOutboundForTest();
  __setGroupOutboundDepsForTest(null);
  __setCardMapMaxForTest(null);
  __resetAskCardSettleForTest();
  await fs.rm(TMP, { recursive: true, force: true });
});

describe("classifyStaleAsk：按事件流真相分流点旧卡的原因", () => {
  it("有 ask_user_reply → answered（只有这种才允许说「已经有人回答了」）", () => {
    expect(
      classifyStaleAsk([requestEvent(), replyEvent()] as never, ASK_ID, null),
    ).toBe("answered");
  });

  it("跳过标记 → skipped；过期标记 → expired；普通作废标记 → voided", () => {
    expect(
      classifyStaleAsk([requestEvent(), skipMarker()] as never, ASK_ID, null),
    ).toBe("skipped");
    expect(
      classifyStaleAsk([requestEvent(), expireMarker()] as never, ASK_ID, null),
    ).toBe("expired");
    expect(
      classifyStaleAsk([requestEvent(), voidMarker()] as never, ASK_ID, null),
    ).toBe("voided");
  });

  it("没有任何了结证据：槽位里是别的 askId（被新提问顶替）→ voided；槽位空 → unknown", () => {
    const events = [requestEvent()] as never;
    expect(classifyStaleAsk(events, ASK_ID, "ask-2")).toBe("voided");
    expect(classifyStaleAsk(events, ASK_ID, null)).toBe("unknown");
    expect(classifyStaleAsk(events, ASK_ID, undefined)).toBe("unknown");
  });

  it("别的 ask 的标记不串到这一组", () => {
    expect(
      classifyStaleAsk(
        [requestEvent(), replyEvent("ask-OTHER"), skipMarker("ask-OTHER")] as never,
        ASK_ID,
        null,
      ),
    ).toBe("unknown");
  });

  it("已回答优先于「槽位是别的 askId」（答完后 agent 马上抛了新提问是常态）", () => {
    expect(
      classifyStaleAsk([requestEvent(), replyEvent()] as never, ASK_ID, "ask-2"),
    ).toBe("answered");
  });
});

describe("文案：只有真「已回答」才说「已经有人回答了」", () => {
  it("群文案：非 answered 的每一种都不含「有人回答」", () => {
    expect(staleAskReplyText("answered", "group")).toContain("已经有人回答了");
    for (const r of ["skipped", "expired", "voided", "unknown"] as const) {
      const t = staleAskReplyText(r, "group");
      expect(t, r).not.toContain("有人回答");
      expect(t, r).toMatch(/已(失效|跳过|过期)/);
    }
  });

  it("私聊文案：unknown 沿用原来的中性说法；answered / skipped / expired / voided 各自准确", () => {
    expect(staleAskReplyText("unknown", "owner")).toContain("已失效或已回答");
    expect(staleAskReplyText("answered", "owner")).toContain("已回答");
    expect(staleAskReplyText("skipped", "owner")).toContain("已跳过");
    expect(staleAskReplyText("expired", "owner")).toContain("已过期");
    expect(staleAskReplyText("voided", "owner")).toContain("已失效");
  });

  it("按钮替换文案与原因一致；unknown 沿用原文案", () => {
    expect(staleAskButtonText("unknown")).toBe("⚠️ 该问题已失效或已回答");
    expect(staleAskButtonText("answered")).toContain("已回答");
    expect(staleAskButtonText("skipped")).toContain("已跳过");
    expect(staleAskButtonText("expired")).toContain("已过期");
    expect(staleAskButtonText("voided")).toContain("已失效");
  });
});

describe("resolveStaleAskReason：读不到 task 一律降级成 unknown、绝不抛", () => {
  it("loadTask 抛错 / 返回 null → unknown", async () => {
    expect(
      await resolveStaleAskReason(
        async () => {
          throw new Error("磁盘炸了");
        },
        TASK_ID,
        ASK_ID,
        null,
      ),
    ).toBe("unknown");
    expect(
      await resolveStaleAskReason(async () => null, TASK_ID, ASK_ID, null),
    ).toBe("unknown");
  });

  it("读得到 → 按事件分流", async () => {
    expect(
      await resolveStaleAskReason(
        loadTaskWith([requestEvent(), replyEvent()]) as never,
        TASK_ID,
        ASK_ID,
        null,
      ),
    ).toBe("answered");
  });
});

describe("parseAskVoidMarker", () => {
  it("只认 info + supersededAskId；跳过 / 过期 / 其余各归各类", () => {
    expect(parseAskVoidMarker(voidMarker() as never)).toEqual({
      askId: ASK_ID,
      kind: "voided",
    });
    expect(parseAskVoidMarker(skipMarker() as never)?.kind).toBe("skipped");
    expect(parseAskVoidMarker(expireMarker() as never)?.kind).toBe("expired");
    expect(parseAskVoidMarker(ev("info", { foo: 1 }) as never)).toBeNull();
    expect(
      parseAskVoidMarker(ev("assistant_message", { supersededAskId: "x" }) as never),
    ).toBeNull();
    expect(parseAskVoidMarker(ev("info") as never)).toBeNull();
  });
});

describe("settleAskCardsOnVoidMarker：取消 / 顶替 / 停止 / 过期 / 跳过 → 两张卡一起置终态", () => {
  it("普通作废标记 → 私聊卡 + 群卡都置成「已失效」、删按钮、不冒充「已回答」", async () => {
    await seedTwoCards();
    const n = await settleAskCardsOnVoidMarker(
      TASK_ID,
      voidMarker() as never,
      loadTaskWith([requestEvent(), voidMarker()]) as never,
    );
    expect(n).toBe(2);
    expect([...new Set(batchUpdateCard.mock.calls.map((c) => c[0]))].sort()).toEqual(
      ["card_group", "card_p2p"],
    );
    const json = patchedJson();
    expect(json).toContain("delete_elements");
    expect(json).toContain(ASK_CARD_VOID_HINT);
    expect(json).toContain("已失效");
    expect(json).not.toContain(ASK_CARD_ANSWERED_HINT);
    expect(json).not.toContain("已回答");
  });

  it("过期标记 → 「已过期」文案", async () => {
    await seedTwoCards();
    await settleAskCardsOnVoidMarker(
      TASK_ID,
      expireMarker() as never,
      loadTaskWith([requestEvent(), expireMarker()]) as never,
    );
    expect(patchedJson()).toContain(ASK_CARD_EXPIRED_HINT);
    expect(patchedJson()).toContain("已过期");
  });

  it("跳过标记 → 与 ask-skip 自己置态同一份文案；两条链谁先到都幂等（只 patch 一轮）", async () => {
    await seedTwoCards();
    const first = await settleAskCardsOnVoidMarker(
      TASK_ID,
      skipMarker() as never,
      loadTaskWith([requestEvent(), skipMarker()]) as never,
    );
    expect(first).toBe(2);
    expect(patchedJson()).toContain(ASK_CARD_SKIPPED_HINT);
    batchUpdateCard.mockClear();
    // ask-skip 随后自己也来置态 → 占坑已被占、直接跳过
    expect(
      await settleAskCards({
        taskId: TASK_ID,
        askId: ASK_ID,
        questions: QUESTIONS,
        fallbackNote: "（已跳过：用户在 Flowship 里继续了对话）",
        hintNote: ASK_CARD_SKIPPED_HINT,
      }),
    ).toBe(0);
    expect(batchUpdateCard).not.toHaveBeenCalled();
  });

  it("已被答题链置过态（先到先得）→ 作废标记不覆盖「已回答」", async () => {
    await seedTwoCards();
    await settleAskCards({
      taskId: TASK_ID,
      askId: ASK_ID,
      questions: QUESTIONS,
      noteByQuestion: { q1: "已选择：方案 A" },
      fallbackNote: "（未回答）",
      hintNote: ASK_CARD_ANSWERED_HINT,
    });
    batchUpdateCard.mockClear();
    expect(
      await settleAskCardsOnVoidMarker(
        TASK_ID,
        voidMarker() as never,
        loadTaskWith([requestEvent(), voidMarker()]) as never,
      ),
    ).toBe(0);
    expect(batchUpdateCard).not.toHaveBeenCalled();
  });

  it("非作废标记 / 找不到 ask_user_request / 读 task 失败 → 什么都不做、不抛", async () => {
    await seedTwoCards();
    expect(
      await settleAskCardsOnVoidMarker(
        TASK_ID,
        ev("info", { foo: 1 }) as never,
        loadTaskWith([requestEvent()]) as never,
      ),
    ).toBe(0);
    expect(
      await settleAskCardsOnVoidMarker(
        TASK_ID,
        voidMarker() as never,
        loadTaskWith([]) as never,
      ),
    ).toBe(0);
    expect(
      await settleAskCardsOnVoidMarker(
        TASK_ID,
        voidMarker() as never,
        (async () => {
          throw new Error("读盘失败");
        }) as never,
      ),
    ).toBe(0);
    expect(batchUpdateCard).not.toHaveBeenCalled();
  });

  it("多题卡同样走统一收口：不对不存在的按钮发 delete（M5-01 在这条链上也成立）", async () => {
    const multi = [
      QUESTIONS[0]!,
      { id: "q2", question: "要不要缓存", allowText: true, options: [{ id: "y", label: "要" }] },
    ];
    await seedTwoCards();
    await settleAskCardsOnVoidMarker(
      TASK_ID,
      voidMarker() as never,
      loadTaskWith([
        ev("ask_user_request", { askId: ASK_ID, token: "t", questions: multi }),
        voidMarker(),
      ]) as never,
    );
    expect(patchedJson()).not.toContain("delete_elements");
    expect(patchedJson()).toContain("已失效");
  });
});

describe("接线：作废标记经全局 task 流 tap 到达飞书桥接 → 置卡", () => {
  const depsFor = (events: Ev[], enabled = true) =>
    __setGroupOutboundDepsForTest({
      getTask: (async () => ({ id: TASK_ID, events })) as never,
      isBridgeEnabled: async () => enabled,
    });

  it("handleGroupOutboundEvent 收到作废标记 → 置卡（没有群回流登记也照常处理）", async () => {
    await seedTwoCards();
    depsFor([requestEvent(), voidMarker()]);
    await handleGroupOutboundEvent(TASK_ID, {
      kind: "event",
      event: voidMarker(),
    } as never);
    expect(batchUpdateCard).toHaveBeenCalledTimes(2);
    expect(patchedJson()).toContain(ASK_CARD_VOID_HINT);
  });

  it("桥接总开关关着 → 不动卡", async () => {
    await seedTwoCards();
    depsFor([requestEvent(), voidMarker()], false);
    await handleGroupOutboundEvent(TASK_ID, {
      kind: "event",
      event: voidMarker(),
    } as never);
    expect(batchUpdateCard).not.toHaveBeenCalled();
  });

  it("普通 info 事件（无作废标记）→ 不动卡", async () => {
    await seedTwoCards();
    depsFor([requestEvent()]);
    await handleGroupOutboundEvent(TASK_ID, {
      kind: "event",
      event: ev("info", { foo: 1 }, "随便一条提示"),
    } as never);
    expect(batchUpdateCard).not.toHaveBeenCalled();
  });

  it("端到端：publish 一条作废标记 → 已注册的全局 tap 把它交给置卡逻辑", async () => {
    await seedTwoCards();
    depsFor([requestEvent(), voidMarker()]);
    ensureFeishuGroupOutboundRegistered();
    publish(TASK_ID, { kind: "event", event: voidMarker() } as never);
    await vi.waitFor(() => expect(batchUpdateCard).toHaveBeenCalledTimes(2));
    expect(patchedJson()).toContain(ASK_CARD_VOID_HINT);
  });
});
