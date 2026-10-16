/**
 * ask 卡置态 ↔ 真实卡片 JSON 的 element_id 对账（N7-b）
 *
 * 审查指控：`ask-card-settle` 只引用群卡提示行 `md_gask_hint`，私聊流式卡的提示行
 * 是 `md_ask_hint`——私聊卡答完后提示行不会更新。
 *
 * 这里**不靠读代码猜**：两张卡都用生产的真实构造路径产出——
 * - 私聊卡：`createCardStream().appendAskUser()` 真实走 buildAskElements、真实写 card-map；
 * - 群卡：`sendAskCardToGroup()` 真实走 buildGroupAskCardJson、真实写 card-map（路由判据空串）；
 * 然后跑真实 `settleAskCards`，把它发出的 batch_update actions **逐条落到对应那张卡的元素表上**，
 * 断言：每个 action 的目标 id 都真的存在于那张卡（飞书对不存在的 element_id 行为不可靠，
 * 不能指望它「静默忽略」）、按钮删净、问题区带终态说明、提示行换成了终态文案。
 *
 * 全部 mock 飞书调用（lark-api）——不真发消息。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TMP = path.join(os.tmpdir(), `ask-settle-contract-${Date.now()}`);
process.env.FLOWSHIP_DATA_DIR = path.join(TMP, "data");

const {
  batchUpdateCard,
  createCardEntity,
  sendCardMessage,
  updateCardEntity,
  patchCardSettings,
  updateCardElementContent,
  getBotAppInfo,
  sendInteractiveCardToChat,
} = vi.hoisted(() => {
  type AnyFn = (...args: never[]) => unknown;
  return {
    batchUpdateCard: vi.fn<AnyFn>(async () => undefined),
    createCardEntity: vi.fn<AnyFn>(async () => ({ card_id: "card_p2p" })),
    sendCardMessage: vi.fn<AnyFn>(async () => ({
      chat_id: "oc_p2p",
      message_id: "om_p2p",
    })),
    updateCardEntity: vi.fn<AnyFn>(async () => undefined),
    patchCardSettings: vi.fn<AnyFn>(async () => undefined),
    updateCardElementContent: vi.fn<AnyFn>(async () => undefined),
    getBotAppInfo: vi.fn<AnyFn>(async () => ({
      appId: "cli_test",
      ownerOpenId: "ou_test",
    })),
    sendInteractiveCardToChat: vi.fn<AnyFn>(),
  };
});

vi.mock("@/lib/server/feishu-bridge/lark-api", () => ({
  batchUpdateCard,
  createCardEntity,
  sendCardMessage,
  updateCardEntity,
  patchCardSettings,
  updateCardElementContent,
  getBotAppInfo,
  sendInteractiveCardToChat,
  sendPostMarkdownToChat: vi.fn(),
  sendTextMessageToChat: vi.fn(),
}));

const {
  askRenderedOptionElementIds,
  createCardStream,
  __setCardStreamTimersForTest,
} = await import("@/lib/server/feishu-bridge/card-stream");
const { sendAskCardToGroup, __setGroupOutboundDepsForTest } = await import(
  "@/lib/server/feishu-bridge/group-outbound"
);
const {
  settleAskCards,
  ASK_CARD_ANSWERED_HINT,
  __setAskSettleRetryForTest,
} = await import("@/lib/server/feishu-bridge/ask-card-settle");
const { LarkApiError } = await import("@/lib/server/feishu-bridge/types");
const { __resetAskCardSettleForTest } = await import(
  "@/lib/server/feishu-bridge/ask-settle-state"
);
const { __setCardMapMaxForTest } = await import(
  "@/lib/server/feishu-bridge/card-map"
);

const TASK_ID = "task-1";
const ASK_ID = "ask-1";
const GROUP_CHAT = "oc_req_group";
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

type Question = {
  id: string;
  question: string;
  allowText: boolean;
  options?: Array<{ id: string; label: string }>;
};

type El = {
  tag?: string;
  element_id?: string;
  content?: string;
  [k: string]: unknown;
};
type Action = {
  action: string;
  params: {
    element_id?: string;
    element_ids?: string[];
    element?: El;
    elements?: El[];
  };
};

/** 真实产出的两张卡：cardId → 它此刻的元素表（深拷贝、之后只被 applyActions 改） */
const cards = new Map<string, El[]>();

/** 把一次 batch_update 的 actions 落到元素表上，返回「目标不存在」的 id 清单 */
const applyActions = (elements: El[], actions: Action[]): string[] => {
  const missing: string[] = [];
  for (const a of actions) {
    if (a.action === "delete_elements") {
      for (const id of a.params.element_ids ?? []) {
        const i = elements.findIndex((e) => e.element_id === id);
        if (i < 0) missing.push(id);
        else elements.splice(i, 1);
      }
    } else if (a.action === "update_element") {
      const id = a.params.element_id!;
      const i = elements.findIndex((e) => e.element_id === id);
      if (i < 0) missing.push(id);
      else elements[i] = { ...a.params.element! };
    }
  }
  return missing;
};

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** 造出私聊流式卡：卡上有 ask 区块 + card-map 里有 (task, ask) 索引 */
const seedP2pCard = async (questions: Question[] = QUESTIONS): Promise<void> => {
  const stream = createCardStream(TASK_ID, { title: "聊", openId: "ou_test" });
  await stream.start();
  batchUpdateCard.mockClear();
  await stream.appendAskUser({ askId: ASK_ID, questions });
  const call = batchUpdateCard.mock.calls[0] as unknown as [string, Action[]];
  cards.set(call[0], clone(call[1][0]!.params.elements!));
  batchUpdateCard.mockClear();
};

/** 造出群答题卡：走真实 sendAskCardToGroup（真实构造器 + 真实 card-map 登记） */
const seedGroupCard = async (questions: Question[] = QUESTIONS): Promise<void> => {
  sendInteractiveCardToChat.mockImplementationOnce((async (
    _chatId: string,
    card: { body: { elements: El[] } },
  ) => {
    cards.set("card_group", clone(card.body.elements));
    return { chat_id: GROUP_CHAT, message_id: "om_group", card_id: "card_group" };
  }) as never);
  __setGroupOutboundDepsForTest({
    getBoundGroupChatId: async () => GROUP_CHAT,
    resolveSenderName: async () => "张三",
    sendAskCard: sendInteractiveCardToChat as never,
  });
  await sendAskCardToGroup(
    { id: TASK_ID, title: "登录优化" } as never,
    ASK_ID,
    questions,
  );
};

const settle = (questions: Question[] = QUESTIONS): Promise<number> =>
  settleAskCards({
    taskId: TASK_ID,
    askId: ASK_ID,
    questions,
    noteByQuestion: { q1: "已选择：方案 A" },
    fallbackNote: "（未回答）",
    hintNote: ASK_CARD_ANSWERED_HINT,
  });

/** 每张卡上被 settle 发出的 actions（按 cardId 分组） */
const patchesByCard = (): Map<string, Action[]> => {
  const m = new Map<string, Action[]>();
  for (const c of batchUpdateCard.mock.calls as unknown as Array<
    [string, Action[]]
  >) {
    m.set(c[0], [...(m.get(c[0]) ?? []), ...c[1]]);
  }
  return m;
};

beforeEach(async () => {
  vi.clearAllMocks();
  await fs.rm(TMP, { recursive: true, force: true });
  await fs.mkdir(path.join(TMP, "data"), { recursive: true });
  cards.clear();
  __setCardMapMaxForTest(20);
  __resetAskCardSettleForTest();
  __setCardStreamTimersForTest((cb) => {
    cb();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  });
});

afterEach(async () => {
  __setGroupOutboundDepsForTest(null);
  __setCardStreamTimersForTest(null);
  __setCardMapMaxForTest(null);
  __resetAskCardSettleForTest();
  await fs.rm(TMP, { recursive: true, force: true });
});

describe("settle 的 patch 目标 ↔ 真实卡片元素表", () => {
  it("两种卡的提示行 element_id 确实不同（对账前提：不是同一个 id）", async () => {
    await seedP2pCard();
    await seedGroupCard();
    const hintIds = (id: string): string[] =>
      (cards.get(id) ?? [])
        .map((e) => e.element_id ?? "")
        .filter((x) => /hint/.test(x));
    expect(hintIds("card_p2p")).toEqual(["md_ask_hint"]);
    expect(hintIds("card_group")).toEqual(["md_gask_hint"]);
  });

  it("私聊卡：每个 patch 目标都存在于该卡、按钮删净、问题区带说明、提示行换成终态文案", async () => {
    await seedP2pCard();
    expect(await settle()).toBe(1);

    const actions = patchesByCard().get("card_p2p")!;
    const els = cards.get("card_p2p")!;
    const missing = applyActions(els, actions);
    // 飞书对不存在的 element_id 行为不可靠（整批报错 / 静默忽略都有可能），
    // 所以 settle 不许往私聊卡发群卡的提示行 id
    expect(missing).toEqual([]);

    expect(els.some((e) => e.tag === "button")).toBe(false);
    expect(
      els.some(
        (e) =>
          e.content?.includes("**选哪个方案**") &&
          e.content.includes("已选择：方案 A"),
      ),
    ).toBe(true);
    const hint = els.find((e) => e.element_id === "md_ask_hint");
    expect(hint?.content).toBe(ASK_CARD_ANSWERED_HINT);
    // 原来的「没有合适选项？直接回复消息作答」不再残留
    expect(JSON.stringify(els)).not.toContain("没有合适选项");
  });

  it("群卡：同样每个 patch 目标都存在、提示行换成终态文案", async () => {
    await seedGroupCard();
    expect(await settle()).toBe(1);

    const actions = patchesByCard().get("card_group")!;
    const els = cards.get("card_group")!;
    expect(applyActions(els, actions)).toEqual([]);

    expect(els.some((e) => e.tag === "button")).toBe(false);
    expect(els.find((e) => e.element_id === "md_gask_hint")?.content).toBe(
      ASK_CARD_ANSWERED_HINT,
    );
    expect(JSON.stringify(els)).not.toContain("直接回复文字作答");
  });

  it("同一组 ask 同时挂在私聊卡 + 群卡：两张卡各按自己的 id 置态、互不串", async () => {
    await seedP2pCard();
    await seedGroupCard();
    expect(await settle()).toBe(2);

    const by = patchesByCard();
    expect([...by.keys()].sort()).toEqual(["card_group", "card_p2p"]);
    for (const [cardId, hintId] of [
      ["card_p2p", "md_ask_hint"],
      ["card_group", "md_gask_hint"],
    ] as const) {
      const els = cards.get(cardId)!;
      expect(applyActions(els, by.get(cardId)!), cardId).toEqual([]);
      expect(els.find((e) => e.element_id === hintId)?.content, cardId).toBe(
        ASK_CARD_ANSWERED_HINT,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// M5-01：多题卡不渲染选项按钮，结算却曾对这些不存在的按钮 id 发 delete_elements。
// 代码注释自己说「飞书对不存在的 element_id 行为不可靠、可能整批报错」——整批报错的话
// 这张卡的问题区 / 提示行也跟着没换成终态、卡片永远停在「等待回答」。
//
// 契约：结算发出的 id 集合 ⊆ 构造器**真实产出**的 id 集合。全部对真实构造器产物断言
//（私聊走 createCardStream().appendAskUser、群走 sendAskCardToGroup），不靠读代码猜。
// ---------------------------------------------------------------------------

const MULTI_QUESTIONS: Question[] = [
  {
    id: "q1",
    question: "选哪个方案",
    allowText: true,
    options: [
      { id: "opt_a", label: "方案 A" },
      { id: "opt_b", label: "方案 B" },
    ],
  },
  {
    id: "q2",
    question: "要不要加缓存",
    allowText: true,
    options: [
      { id: "opt_y", label: "要" },
      { id: "opt_n", label: "不要" },
    ],
  },
];

const MATRIX_CASES: Array<{ name: string; questions: Question[] }> = [
  { name: "单题带选项", questions: QUESTIONS },
  { name: "多题都带选项", questions: MULTI_QUESTIONS },
  {
    name: "单题无选项（纯文字题）",
    questions: [{ id: "q1", question: "你怎么看", allowText: true }],
  },
  {
    name: "多题仅部分带选项",
    questions: [
      MULTI_QUESTIONS[0]!,
      { id: "q2", question: "补充说明", allowText: true },
    ],
  },
];

const KINDS: Array<{
  kind: string;
  cardId: string;
  hintId: string;
  seed: (qs: Question[]) => Promise<void>;
}> = [
  { kind: "私聊流式卡", cardId: "card_p2p", hintId: "md_ask_hint", seed: seedP2pCard },
  { kind: "群答题卡", cardId: "card_group", hintId: "md_gask_hint", seed: seedGroupCard },
];

const idsOf = (els: El[], tag?: string): string[] =>
  els
    .filter((e) => (tag ? e.tag === tag : true))
    .map((e) => e.element_id ?? "");

const deletedIds = (actions: Action[]): string[] =>
  actions
    .filter((a) => a.action === "delete_elements")
    .flatMap((a) => a.params.element_ids ?? []);

describe("M5-01 结算的 element_id 集合 ⊆ 构造器真实产出（单题/多题 × 私聊/群）", () => {
  for (const { name, questions } of MATRIX_CASES) {
    for (const { kind, cardId, hintId, seed } of KINDS) {
      it(`${kind} · ${name}：结算不对不存在的元素发 delete / update，且终态收干净`, async () => {
        await seed(questions);
        const initial = clone(cards.get(cardId)!);
        const initialIds = new Set(idsOf(initial));
        // 构造器产物自己的按钮 id 集合（真实出卡路径的事实）
        const realButtonIds = idsOf(initial, "button");

        expect(await settle(questions)).toBe(1);
        const actions = patchesByCard().get(cardId)!;

        // 1) 所有被删 id 都真实存在于这张卡上（⊆ 构造器产物）
        for (const id of deletedIds(actions)) {
          expect(initialIds.has(id), `delete 了卡上不存在的 ${id}`).toBe(true);
        }
        // 2) 整批落到元素表上：没有任何 delete / update 的目标缺失
        const els = clone(initial);
        expect(applyActions(els, actions)).toEqual([]);
        // 3) 删净：卡上真实有的按钮一个不剩
        expect(els.some((e) => e.tag === "button")).toBe(false);
        // 4) 删除集合恰好等于真实按钮集合（不多删、不漏删）
        expect([...deletedIds(actions)].sort()).toEqual([...realButtonIds].sort());
        // 5) 问题区带终态说明、提示行换成终态文案
        for (const q of questions) {
          expect(
            els.some(
              (e) =>
                e.content?.startsWith(`**${q.question}**`) &&
                e.content.includes(q.id === "q1" ? "已选择：方案 A" : "（未回答）"),
            ),
            q.id,
          ).toBe(true);
        }
        expect(els.find((e) => e.element_id === hintId)?.content).toBe(
          ASK_CARD_ANSWERED_HINT,
        );
      });
    }
  }

  it("多题卡（带选项）真实产物里没有任何按钮——结算因此不能发 delete_elements", async () => {
    await seedP2pCard(MULTI_QUESTIONS);
    await seedGroupCard(MULTI_QUESTIONS);
    expect(idsOf(cards.get("card_p2p")!, "button")).toEqual([]);
    expect(idsOf(cards.get("card_group")!, "button")).toEqual([]);

    expect(await settle(MULTI_QUESTIONS)).toBe(2);
    for (const [cardId, actions] of patchesByCard()) {
      expect(deletedIds(actions), cardId).toEqual([]);
    }
  });

  // 唯一来源：结算按这个纯函数推导「可删元素」，它必须与两个真实构造器产出的按钮 id 完全一致
  for (const { name, questions } of MATRIX_CASES) {
    for (const { kind, cardId, seed } of KINDS) {
      it(`askRenderedOptionElementIds ≡ ${kind}真实按钮 id · ${name}`, async () => {
        await seed(questions);
        const real = idsOf(cards.get(cardId)!, "button").sort();
        expect(askRenderedOptionElementIds(ASK_ID, questions).sort()).toEqual(
          real,
        );
      });
    }
  }
});

// ---------------------------------------------------------------------------
// M5-02 补强：重试必须「在最坏语义下也收敛」。
//
// 飞书 batch_update 的真实语义（是否原子、遇错是否中止）**没有证据**，这里故意取对重试最不利
// 的一档来钉死顺序契约：按序执行、非原子、遇到目标不存在即中止，已执行的 action 保留。
// 在这一档下，请求中途断线（前几个 action 已生效、响应丢了）后：
// - 若 delete_elements 排在 update_element 前：delete 已生效 → 重试时 delete 目标不在 → 整批被拒、
//   后面的 update（问题区说明 / 提示行）永远补不上——卡片没按钮、却还写着「等待回答」；
// - 若 update 全排在 delete 前：已生效的 update 重做是幂等的、delete 在重试里补齐，必收敛。
// 若飞书其实是原子的，两种顺序都收敛，所以「update 在前」是不依赖真实语义的纵深防御。
// ---------------------------------------------------------------------------

/**
 * 最坏语义的 batch_update 模拟：按序、非原子、目标缺失即中止（返回错误），已执行的保留。
 * @param limit 最多执行几个 action（模拟「请求发到一半连接断了」）；省略 = 全部执行
 */
const applyInOrder = (
  elements: El[],
  actions: Action[],
  limit = Number.POSITIVE_INFINITY,
): Error | null => {
  for (const [i, a] of actions.entries()) {
    if (i >= limit) return null;
    const targets =
      a.action === "delete_elements"
        ? (a.params.element_ids ?? [])
        : [a.params.element_id ?? ""];
    for (const id of targets) {
      const idx = elements.findIndex((e) => e.element_id === id);
      if (idx < 0) {
        return new LarkApiError(`element ${id} not found`, { code: 99992402 });
      }
      if (a.action === "delete_elements") elements.splice(idx, 1);
      else elements[idx] = { ...a.params.element! };
    }
  }
  return null;
};

describe("M5-02 重试收敛：结算 patch 中途断线（部分生效）后重试仍补成终态", () => {
  let scheduled: Array<() => void> = [];

  beforeEach(() => {
    scheduled = [];
    __setAskSettleRetryForTest({
      schedule: (cb) => {
        scheduled.push(cb);
      },
    });
  });

  afterEach(() => {
    __setAskSettleRetryForTest(null);
    batchUpdateCard.mockReset();
    batchUpdateCard.mockImplementation((async () => undefined) as never);
  });

  for (const { kind, cardId, hintId, seed } of KINDS) {
    it(`${kind}：update_element 全部排在 delete_elements 之前（状态文案优先落地）`, async () => {
      await seed(QUESTIONS);
      expect(await settle(QUESTIONS)).toBe(1);
      const kinds = patchesByCard()
        .get(cardId)!
        .map((a) => a.action);
      expect(kinds).toContain("delete_elements");
      expect(kinds.indexOf("delete_elements")).toBeGreaterThan(
        kinds.lastIndexOf("update_element"),
      );
    });

    // cut = 首次请求里「已生效的 action 数」；0 = 啥都没生效、≥ 总数 = 全生效只是响应丢了
    for (const cut of [0, 1, 2, 3]) {
      for (const { name, questions } of MATRIX_CASES.slice(0, 2)) {
        it(`${kind} · ${name}：首次请求生效前 ${cut} 个 action 后断线 → 重试收敛到完整终态`, async () => {
          await seed(questions);
          let calls = 0;
          batchUpdateCard.mockImplementation((async (
            id: string,
            actions: Action[],
          ) => {
            calls += 1;
            const els = cards.get(id)!;
            if (calls === 1) {
              // 请求发出、前 cut 个 action 已被飞书执行，随后连接被掐、响应没回来
              applyInOrder(els, actions, cut);
              throw new LarkApiError(
                "API call failed: Post ...batch_update: EOF",
                {},
              );
            }
            const err = applyInOrder(els, actions);
            if (err) throw err;
          }) as never);

          // 首轮没成功（返回 0）、调用方不被阻塞；后台排了一次重试
          expect(await settle(questions)).toBe(0);
          expect(scheduled).toHaveLength(1);
          scheduled.shift()!();
          await new Promise((r) => setTimeout(r, 0));

          // 终态完整：按钮删净、每题带终态说明、提示行换成终态文案
          const els = cards.get(cardId)!;
          expect(els.some((e) => e.tag === "button")).toBe(false);
          for (const q of questions) {
            expect(
              els.some(
                (e) =>
                  e.content?.startsWith(`**${q.question}**`) &&
                  e.content.includes(
                    q.id === "q1" ? "已选择：方案 A" : "（未回答）",
                  ),
              ),
              q.id,
            ).toBe(true);
          }
          expect(els.find((e) => e.element_id === hintId)?.content).toBe(
            ASK_CARD_ANSWERED_HINT,
          );
        });
      }
    }
  }
});
