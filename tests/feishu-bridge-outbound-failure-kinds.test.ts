/**
 * outbound：按失败类别给用户说清「为什么 / 后果 / 去哪看」（R14 B4-3 · Q12a-07）
 *
 * B1 只会说「飞书卡片连续 N 次更新失败」。可有几类失败是「再试也不会好」的——卡片没了、没权限、内容超限、
 * 流式被飞书关掉重开也没用——光丢一个飞书错误码，用户既看不懂、也不知道这一轮飞书里最终会是什么样。
 * 这里钉住：熔断当场的 info（onBreakerOpen）、收尾没同步的 info（health.lastError）、终稿被截断的 info（health.truncated），
 * 按类别各说各的；限流 / 瞬时 / 未知仍是 B1 原措辞。文案整句钉死——用户读的就是这句话。
 *
 * mock card-stream 工厂 + 事件源，不碰真实 lark-cli。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getTask = vi.hoisted(() =>
  vi.fn(async (id: string) => ({
    id,
    title: "测对话",
    mode: "chat" as const,
    model: { id: "grok-4" },
  })),
);

const writeEventAndPublish = vi.hoisted(() =>
  vi.fn(async (taskId: string, ev: { kind: string; text?: string }) => ({
    id: `ev_${ev.kind}_${Date.now()}`,
    kind: ev.kind,
    text: ev.text ?? "",
    createdAt: Date.now(),
    taskId,
  })),
);

vi.mock("@/lib/server/task-fs", () => ({ getTask }));

vi.mock("@/lib/server/task-stream", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/task-stream")>();
  return { ...actual, writeEventAndPublish };
});

vi.mock("@/lib/server/feishu-bridge/bridge-config", () => ({
  isFeishuChatBridgeEnabled: vi.fn(async () => true),
  getBridgeDataDir: async () => "/tmp/feishu-bridge-kinds-test",
  isBridgeTestInstance: () => true,
  isFeishuBridgeKeepAwakeEnabled: async () => true,
  isFeishuBridgeStreamingEnabled: vi.fn(async () => true),
}));

const getPendingAsk = vi.hoisted(() => vi.fn(() => null));
vi.mock("@/lib/server/chat-pending", () => ({ getPendingAsk }));

const okHealth = vi.hoisted(
  () =>
    (over: Record<string, unknown> = {}) => ({
      failCount: 0,
      consecutiveFails: 0,
      breakerOpen: false,
      breakerEverOpened: false,
      finalizeOk: true as boolean | undefined,
      lastError: undefined as unknown,
      ...over,
    }),
);

type CardMock = {
  start: ReturnType<typeof vi.fn>;
  pushProcess: ReturnType<typeof vi.fn>;
  pushAnswer: ReturnType<typeof vi.fn>;
  setHeaderStatus: ReturnType<typeof vi.fn>;
  appendAskUser: ReturnType<typeof vi.fn>;
  appendRetryButton: ReturnType<typeof vi.fn>;
  finalize: ReturnType<typeof vi.fn>;
  getFailCount: () => number;
  getHealth: () => ReturnType<typeof okHealth>;
  getIds: () => { messageId?: string; cardId?: string };
};

const cardFactory = vi.hoisted(() => {
  const cards: CardMock[] = [];
  const create = vi.fn();
  return { cards, create };
});

const sendTextMessage = vi.hoisted(() =>
  vi.fn(async () => ({ chat_id: "oc_x", message_id: "om_text" })) as unknown as ReturnType<
    typeof vi.fn<(openId: string, text: string) => Promise<{ chat_id: string; message_id: string }>>
  >,
);
const uploadImage = vi.hoisted(() => vi.fn(async (p: string) => `img_key_for_${p}`));
const getBotAppInfo = vi.hoisted(() =>
  vi.fn(async () => ({ appId: "cli_x", ownerOpenId: "ou_owner" })),
);

const {
  ensureFeishuOutboundRegistered,
  __resetFeishuOutboundForTest,
  __setCreateCardStreamForTest,
  __setUploadImageForTest,
  __setSendTextMessageForTest,
  __setGetBotAppInfoForTest,
  __setBridgeEnabledForTest,
} = await import("@/lib/server/feishu-bridge/outbound");
const { publishTaskStreamEvent } = await import("@/lib/server/task-stream");
const { LarkApiError } = await import("@/lib/server/feishu-bridge/types");

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
  await Promise.resolve();
};

const makeCard = (health: Record<string, unknown>): CardMock => ({
  start: vi.fn(async () => undefined),
  pushProcess: vi.fn(),
  pushAnswer: vi.fn(),
  setHeaderStatus: vi.fn(),
  appendAskUser: vi.fn(async () => undefined),
  appendRetryButton: vi.fn(async () => undefined),
  finalize: vi.fn(async () => undefined),
  getFailCount: () => 0,
  getHealth: () => okHealth(health),
  getIds: () => ({ messageId: "om_h", cardId: "card_h" }),
});

/** 用「getHealth 可控」的假卡跑一轮 user_reply → delta → done */
const runTurnWithHealth = async (taskId: string, health: Record<string, unknown>): Promise<CardMock> => {
  cardFactory.create.mockImplementationOnce(() => {
    const card = makeCard(health);
    cardFactory.cards.push(card);
    return card;
  });
  publishTaskStreamEvent(taskId, {
    kind: "event",
    event: { id: `ev_u_${taskId}`, ts: Date.now(), kind: "user_reply" as never, text: "问" },
  });
  publishTaskStreamEvent(taskId, { kind: "assistant_delta", text: "答" });
  await flush();
  publishTaskStreamEvent(taskId, {
    kind: "done",
    ok: true,
    task: { id: taskId, title: "测对话", mode: "chat", runStatus: "awaiting_user" } as never,
  });
  await flush();
  return cardFactory.cards.at(-1)!;
};

type BreakerInfo = {
  consecutiveFails: number;
  retryInMs: number;
  error: unknown;
  fatalKind?: string;
};

/** 起一轮（只到建卡），再用 createCardStream 收到的 onBreakerOpen 回调模拟「熔断打开」 */
const openBreaker = async (taskId: string, info: BreakerInfo): Promise<string[]> => {
  cardFactory.create.mockImplementationOnce(() => {
    const card = makeCard({});
    cardFactory.cards.push(card);
    return card;
  });
  publishTaskStreamEvent(taskId, {
    kind: "event",
    event: { id: `ev_u_${taskId}`, ts: Date.now(), kind: "user_reply" as never, text: "问" },
  });
  publishTaskStreamEvent(taskId, { kind: "assistant_delta", text: "答" });
  await flush();
  const createOpts = (
    cardFactory.create.mock.calls.at(-1) as unknown as [string, { onBreakerOpen?: (i: BreakerInfo) => void }]
  )[1];
  expect(typeof createOpts.onBreakerOpen).toBe("function");
  createOpts.onBreakerOpen!(info);
  await flush();
  return infoTexts();
};

const infoTexts = (): string[] =>
  writeEventAndPublish.mock.calls.filter(([, ev]) => ev.kind === "info").map(([, ev]) => ev.text ?? "");
const lastPing = (): string => String(sendTextMessage.mock.calls.at(-1)?.[1] ?? "");

beforeEach(() => {
  __resetFeishuOutboundForTest();
  cardFactory.cards.length = 0;
  cardFactory.create.mockReset();
  getTask.mockClear();
  writeEventAndPublish.mockClear();
  uploadImage.mockClear();
  sendTextMessage.mockClear();
  getBotAppInfo.mockClear();
  getPendingAsk.mockClear();
  getPendingAsk.mockReturnValue(null);
  __setCreateCardStreamForTest(cardFactory.create as unknown as Parameters<typeof __setCreateCardStreamForTest>[0]);
  __setUploadImageForTest(uploadImage);
  __setSendTextMessageForTest(sendTextMessage);
  __setGetBotAppInfoForTest(getBotAppInfo);
  __setBridgeEnabledForTest(true);
  ensureFeishuOutboundRegistered();
});

afterEach(() => {
  __resetFeishuOutboundForTest();
});

// ---- 错误样例 ----
const GONE = (): InstanceType<typeof LarkApiError> =>
  new LarkApiError("The card entity does not exist", { code: 200740 });
const AUTH_URL = "https://open.feishu.cn/app/cli_x/auth?q=cardkit:card:write";
const AUTH = (consoleUrl?: string): InstanceType<typeof LarkApiError> =>
  new LarkApiError("Access denied", { code: 99991672, consoleUrl });
const TOO_LONG = (): InstanceType<typeof LarkApiError> =>
  new LarkApiError("Card content exceeds limit.", { code: 200860 });
const CLOSED = (): InstanceType<typeof LarkApiError> =>
  new LarkApiError("Card streaming closed", { code: 300309 });
const RATE = (): InstanceType<typeof LarkApiError> =>
  new LarkApiError("rate limited", { code: 99991400 });

const HINT_GONE = "卡片已不存在（被删除，或超过飞书卡片实体 14 天的有效期）";
const HINT_AUTH = "机器人没有权限操作这张卡片，请到飞书开放平台检查应用权限";
const HINT_TOO_LONG = "内容超过飞书卡片的大小上限";

describe("熔断打开当场的 info（onBreakerOpen）：致命故障按类别说清后果，普通熔断沿用 B1 措辞", () => {
  it("没有 fatalKind（普通 3 连败熔断）：B1 原句不变", async () => {
    const infos = await openBreaker("t_ob_default", { consecutiveFails: 3, retryInMs: 2000, error: RATE() });
    expect(infos).toEqual([
      "飞书卡片连续 3 次更新失败（rate limited（飞书 99991400）），已暂停实时推送；回复结束时会再整卡同步一次",
    ]);
  });

  it("gone：卡片已不存在 + 本轮不再同步 + 去 Flowship 看；不再说「连续 N 次」「会再整卡同步一次」", async () => {
    const infos = await openBreaker("t_ob_gone", {
      consecutiveFails: 0,
      retryInMs: 0,
      error: GONE(),
      fatalKind: "gone",
    });
    expect(infos).toEqual([
      `飞书卡片无法继续更新（The card entity does not exist（飞书 200740）；${HINT_GONE}），本轮不再同步到飞书，请在 Flowship 查看回复`,
    ]);
    expect(infos[0]).not.toContain("连续");
    expect(infos[0]).not.toContain("再整卡同步");
  });

  it("auth：说明机器人没权限 + 带权限引导链接", async () => {
    const infos = await openBreaker("t_ob_auth", {
      consecutiveFails: 0,
      retryInMs: 0,
      error: AUTH(AUTH_URL),
      fatalKind: "auth",
    });
    expect(infos).toEqual([
      `飞书卡片无法继续更新（Access denied（飞书 99991672）；${HINT_AUTH}：${AUTH_URL}），本轮不再同步到飞书，请在 Flowship 查看回复`,
    ]);
  });

  it("auth 没有引导链接：不留「：」尾巴", async () => {
    const infos = await openBreaker("t_ob_auth_nourl", {
      consecutiveFails: 0,
      retryInMs: 0,
      error: AUTH(),
      fatalKind: "auth",
    });
    expect(infos[0]).toContain(`；${HINT_AUTH}），本轮不再同步到飞书`);
    expect(infos[0]).not.toContain("http");
  });

  it("auth 的引导链接 ≤ 200 字照带；超过 200 字不带（截断的链接点不开，也防 info 被撑爆）", async () => {
    const at200 = `https://open.feishu.cn/${"a".repeat(200 - "https://open.feishu.cn/".length)}`;
    expect(at200.length).toBe(200);
    const ok = await openBreaker("t_ob_auth_200", {
      consecutiveFails: 0,
      retryInMs: 0,
      error: AUTH(at200),
      fatalKind: "auth",
    });
    expect(ok[0]).toContain(at200);

    writeEventAndPublish.mockClear();
    const at201 = `${at200}a`;
    const dropped = await openBreaker("t_ob_auth_201", {
      consecutiveFails: 0,
      retryInMs: 0,
      error: AUTH(at201),
      fatalKind: "auth",
    });
    expect(dropped[0]).not.toContain("https://");
    expect(dropped[0]).toContain(`；${HINT_AUTH}），本轮不再同步到飞书`);
  });

  it("auth 但错误不是 LarkApiError（没有链接可带）：照常出文案", async () => {
    const infos = await openBreaker("t_ob_auth_native", {
      consecutiveFails: 0,
      retryInMs: 0,
      error: new Error("denied"),
      fatalKind: "auth",
    });
    expect(infos[0]).toContain(`denied；${HINT_AUTH}），本轮不再同步到飞书`);
  });

  it("too_long：内容超出上限 + 回复结束时发截断版 + 完整回复在 Flowship", async () => {
    const infos = await openBreaker("t_ob_toolong", {
      consecutiveFails: 0,
      retryInMs: 0,
      error: TOO_LONG(),
      fatalKind: "too_long",
    });
    expect(infos).toEqual([
      "飞书卡片内容超出大小上限（Card content exceeds limit.（飞书 200860）），已暂停实时推送；回复结束时会发送截断版，完整回复请在 Flowship 查看",
    ]);
  });

  it("stream_closed：流式被飞书关掉、多次重新打开仍失败 + 回复结束时会再整卡同步一次", async () => {
    const infos = await openBreaker("t_ob_closed", {
      consecutiveFails: 0,
      retryInMs: 0,
      error: CLOSED(),
      fatalKind: "stream_closed",
    });
    expect(infos).toEqual([
      "飞书把卡片的流式更新关掉了（Card streaming closed（飞书 300309）），多次重新打开仍失败，已暂停实时推送；回复结束时会再整卡同步一次",
    ]);
  });

  it("不认识的 fatalKind 字符串：退回 B1 原句（防御：新增类别没配文案时不会出空 / 乱句）", async () => {
    const infos = await openBreaker("t_ob_unknown_kind", {
      consecutiveFails: 4,
      retryInMs: 0,
      error: RATE(),
      fatalKind: "rate_limit",
    });
    expect(infos[0]).toContain("飞书卡片连续 4 次更新失败");
  });

  it("文案按 fatalKind 来（卡片流已经定了性），不在这里重新分类错误", async () => {
    const infos = await openBreaker("t_ob_trust_kind", {
      consecutiveFails: 0,
      retryInMs: 0,
      error: RATE(), // 错误本身是限流码
      fatalKind: "gone",
    });
    expect(infos[0]).toContain(HINT_GONE);
  });

  it("原因里的整卡 --data / 超长 message 只留一行摘要（≤ 160 字）：致命文案同样不刷屏", async () => {
    const BIG = "整卡正文标记";
    const huge = new LarkApiError(`Command failed: lark-cli api PUT /x --data ${BIG}${"字".repeat(30_000)}`, {
      code: 200860,
    });
    const infos = await openBreaker("t_ob_huge", {
      consecutiveFails: 0,
      retryInMs: 0,
      error: huge,
      fatalKind: "too_long",
    });
    expect(infos[0]!.length).toBeLessThanOrEqual(400);
    expect(infos[0]).not.toContain("字".repeat(200));
  });
});

describe("收尾没同步的 info：失败类别明确的补一句原因", () => {
  it("卡片不存在 → 带「卡片已不存在…」", async () => {
    await runTurnWithHealth("t_un_gone", { finalizeOk: false, lastError: GONE() });
    expect(infoTexts()).toEqual([
      `飞书卡片没能同步完整回复（The card entity does not exist（飞书 200740）；${HINT_GONE}），请在 Flowship 查看本轮回复`,
    ]);
    expect(lastPing()).toContain("没能同步");
  });

  it("没权限 → 带「机器人没有权限…」和引导链接", async () => {
    await runTurnWithHealth("t_un_auth", { finalizeOk: false, lastError: AUTH(AUTH_URL) });
    expect(infoTexts()).toEqual([
      `飞书卡片没能同步完整回复（Access denied（飞书 99991672）；${HINT_AUTH}：${AUTH_URL}），请在 Flowship 查看本轮回复`,
    ]);
  });

  it("内容超限（含 Windows 命令行超长的 ARGV_TOO_LONG 码）→ 带「内容超过飞书卡片的大小上限」", async () => {
    await runTurnWithHealth("t_un_toolong", { finalizeOk: false, lastError: TOO_LONG() });
    expect(infoTexts()[0]).toContain(`；${HINT_TOO_LONG}），请在 Flowship 查看本轮回复`);

    writeEventAndPublish.mockClear();
    await runTurnWithHealth("t_un_argv", {
      finalizeOk: false,
      lastError: new LarkApiError("命令行过长", { code: "ARGV_TOO_LONG" }),
    });
    expect(infoTexts()[0]).toContain(HINT_TOO_LONG);
  });

  it("错误不是 LarkApiError、只有文案能认（The card entity does not exist）→ 照样补原因", async () => {
    await runTurnWithHealth("t_un_native", {
      finalizeOk: false,
      lastError: new Error("The card entity does not exist"),
    });
    expect(infoTexts()[0]).toContain(HINT_GONE);
  });

  it.each([
    ["限流", RATE],
    ["流式被关", CLOSED],
    ["序号冲突", () => new LarkApiError("sequence number compare failed", { code: 300317 })],
    ["断网", () => new Error("read ECONNRESET")],
    ["未知", () => new Error("boom")],
  ])("%s → 没有额外的原因句（B1 原措辞）", async (_label, make) => {
    const err = make();
    await runTurnWithHealth(`t_un_plain_${_label}`, { finalizeOk: false, lastError: err });
    const infos = infoTexts();
    expect(infos).toHaveLength(1);
    expect(infos[0]).toMatch(/^飞书卡片没能同步完整回复（[^；]*），请在 Flowship 查看本轮回复$/);
  });

  it("没有失败原因（undefined）→ 仍是「原因未知」，不补句", async () => {
    await runTurnWithHealth("t_un_noreason", { finalizeOk: false, lastError: undefined });
    expect(infoTexts()).toEqual(["飞书卡片没能同步完整回复（原因未知），请在 Flowship 查看本轮回复"]);
  });
});

describe("终稿被截断（health.truncated）：飞书里是截断版，要明说完整回复在哪", () => {
  const TRUNCATED_INFO =
    "飞书卡片放不下完整回复（超过飞书卡片的大小上限），卡片里是截断版；完整回复请在 Flowship 查看";

  it("终稿落成 + truncated → 恰好一条截断 info；追发仍是「已完成」（内容确实到了卡片）", async () => {
    await runTurnWithHealth("t_tr_ok", { finalizeOk: true, truncated: true });
    expect(infoTexts()).toEqual([TRUNCATED_INFO]);
    expect(sendTextMessage).toHaveBeenCalledTimes(1);
    expect(lastPing()).toContain("已完成");
    expect(lastPing()).not.toContain("没能同步");
  });

  it("没有 truncated → 不写任何 info", async () => {
    await runTurnWithHealth("t_tr_none", { finalizeOk: true });
    expect(infoTexts()).toEqual([]);
  });

  it("truncated 但终稿没落成 → 只有「没能同步」那一条（互斥，不重复提示）", async () => {
    await runTurnWithHealth("t_tr_unsynced", { finalizeOk: false, truncated: true, lastError: TOO_LONG() });
    const infos = infoTexts();
    expect(infos).toHaveLength(1);
    expect(infos[0]).toContain("没能同步完整回复");
    expect(infos[0]).not.toContain("截断版");
  });

  it("truncated 但熔断此刻仍开着（算没同步）→ 同样只有「没能同步」那一条", async () => {
    await runTurnWithHealth("t_tr_breaker", {
      finalizeOk: true,
      breakerOpen: true,
      truncated: true,
      lastError: TOO_LONG(),
    });
    const infos = infoTexts();
    expect(infos).toHaveLength(1);
    expect(infos[0]).toContain("没能同步完整回复");
  });

  it("写截断 info 自己失败：吞掉、不抛，追发照常发出", async () => {
    writeEventAndPublish.mockRejectedValueOnce(new Error("disk full"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await runTurnWithHealth("t_tr_writefail", { finalizeOk: true, truncated: true });
    expect(sendTextMessage).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("写截断提示 info 失败"))).toBe(true);
    warn.mockRestore();
  });
});
