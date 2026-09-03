/**
 * 飞书对话遥控器（chats-panel）：纯卡片构建 / 列表过滤 / 切换建切 / 搜索消费。
 * 全部 mock 外部调用——禁止真调飞书 / 真读写 tasks。
 */
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { TaskSummary } from "@/lib/types";

process.env.FLOWSHIP_DATA_DIR = path.join(
  os.tmpdir(),
  `feishu-chats-panel-${Date.now()}`,
  "data",
);

const {
  __setChatsPanelDepsForTest,
  buildAllModelsCard,
  buildChatListCard,
  buildChatsPanelCard,
  buildModelCard,
  buildRepoListCard,
  checkPanelModelId,
  consumeChatSearchText,
  createPanelChat,
  dedupInflight,
  fmtPanelTime,
  handleChatsCardAction,
  isAllowedPanelRepo,
  listPanelChats,
  modelQuickOptions,
  repoTailOf,
  repoTailsLabel,
  searchPanelChats,
  setPanelChatModel,
  shortModelLabel,
  showChatListCard,
  showModelCard,
  switchPanelChat,
} = await import("@/lib/server/feishu-bridge/chats-panel");

afterEach(() => {
  __setChatsPanelDepsForTest(null);
});

const summary = (over: Record<string, unknown> = {}): TaskSummary =>
  ({
    id: "t1",
    title: "登录优化",
    mode: "chat",
    repoPaths: ["/repo/crm-web"],
    model: { id: "m-a" },
    runStatus: "idle",
    updatedAt: 100,
    ...over,
  }) as unknown as TaskSummary;

const cardText = (card: Record<string, unknown>): string =>
  JSON.stringify(card);

const elementIds = (card: Record<string, unknown>): string[] => {
  const body = (card.body ?? {}) as { elements?: Array<{ element_id?: unknown }> };
  return (body.elements ?? []).map((e) => String(e.element_id ?? ""));
};

describe("纯小工具", () => {
  it("repoTailOf：取首仓尾巴、空退未绑仓库", () => {
    expect(repoTailOf(["/a/b/crm-web"])).toBe("crm-web");
    expect(repoTailOf(["/a/b/crm-web/"])).toBe("crm-web");
    expect(repoTailOf([])).toBe("未绑仓库");
    expect(repoTailOf(undefined)).toBe("未绑仓库");
  });

  it("repoTailsLabel：多仓全列、去重、空退未绑仓库", () => {
    expect(repoTailsLabel(["/a/crm-web", "/b/pay"])).toBe("crm-web、pay");
    expect(repoTailsLabel(["/a/crm-web", "/b/crm-web"])).toBe("crm-web");
    expect(repoTailsLabel([])).toBe("未绑仓库");
  });

  it("fmtPanelTime：MM-DD HH:mm，缺省空串", () => {
    expect(fmtPanelTime(undefined)).toBe("");
    expect(fmtPanelTime(new Date(2026, 8, 3, 9, 5).getTime())).toBe("09-03 09:05");
  });

  it("shortModelLabel：20 字内原样、超了缩后缀、还超截断", () => {
    expect(shortModelLabel("m-a")).toBe("m-a");
    expect(shortModelLabel("muse-spark-1.3-contributor")).toBe("muse-spark-1.3（C）");
    const long = shortModelLabel(`x-${"y".repeat(40)}`);
    expect(long.length).toBeLessThanOrEqual(20);
  });
});

describe("遥控器主卡", () => {
  it("有当前对话：三按钮 + 当前行", () => {
    const card = buildChatsPanelCard(
      { id: "t1", title: "登录优化", repoTail: "crm-web", modelId: "m-a" },
      3,
    );
    const s = cardText(card);
    expect(s).toContain("正在聊");
    expect(s).toContain("登录优化");
    expect(s).toContain("换对话");
    expect(s).toContain("新对话");
    expect(s).toContain("换模型");
  });

  it("无当前对话：不放换模型、主按钮是新对话", () => {
    const card = buildChatsPanelCard(null, 2);
    const s = cardText(card);
    expect(s).toContain("新对话");
    expect(s).not.toContain("换模型");
    expect(s).toContain("2");
  });

  it("所有 element_id 合法", () => {
    for (const card of [
      buildChatsPanelCard({ id: "t1", title: "t", repoTail: "r", modelId: "m" }, 1),
      buildChatsPanelCard(null, 0),
    ]) {
      for (const id of elementIds(card)) {
        expect(id).toMatch(/^[A-Za-z][A-Za-z0-9_]{0,19}$/);
      }
      expect(new Set(elementIds(card)).size).toBe(elementIds(card).length);
    }
  });
});

describe("对话列表卡", () => {
  const row = (over: Record<string, unknown> = {}) => ({
    id: "t1",
    title: "登录优化",
    repoTail: "crm-web",
    modelId: "m-a",
    timeText: "09-03 09:05",
    archived: false,
    ...over,
  });

  it("行渲染 + 当前标记 + 归档标记", () => {
    const card = buildChatListCard({
      rows: [
        row(),
        row({ id: "t2", title: "旧需求", archived: true }),
      ],
      page: 0,
      totalPages: 1,
      total: 2,
      currentId: "t1",
    });
    const s = cardText(card);
    expect(s).toContain("← 当前");
    expect(s).toContain("（归档）");
    expect(s).toContain("切回去");
    expect(s).toContain("切过去");
  });

  it("翻页按钮只在有页可翻时出现", () => {
    const first = buildChatListCard({ rows: [row()], page: 0, totalPages: 3, total: 18 });
    expect(cardText(first)).toContain("下一页");
    expect(cardText(first)).not.toContain("上一页");
    const last = buildChatListCard({ rows: [row()], page: 2, totalPages: 3, total: 18 });
    expect(cardText(last)).toContain("上一页");
    expect(cardText(last)).not.toContain("下一页");
  });

  it("空列表：给提示 + 不翻页", () => {
    const card = buildChatListCard({ rows: [], page: 0, totalPages: 1, total: 0 });
    expect(cardText(card)).toContain("没有对话");
  });
});

describe("仓库卡与模型卡", () => {
  it("仓库卡：purpose 决定去向", () => {
    const forSwitch = buildRepoListCard({
      repos: [{ path: "/a/b", tail: "b", count: 2 }],
      page: 0,
      totalPages: 1,
      purpose: "switch",
    });
    expect(cardText(forSwitch)).toContain("按仓库找对话");
    expect(cardText(forSwitch)).toContain("全部对话");
    const forNew = buildRepoListCard({
      repos: [{ path: "/a/b", tail: "b", count: 0 }],
      page: 0,
      totalPages: 1,
      purpose: "new",
    });
    expect(cardText(forNew)).toContain("新对话选仓库");
    expect(cardText(forNew)).toContain("跳过选仓直接建");
  });

  it("模型卡：默认/星标快捷 + 全部模型 + 回遥控器", () => {
    const card = buildModelCard({
      currentModelId: "m-a",
      providerLabel: "Cursor",
      quick: [
        { id: "m-a", tag: "默认" },
        { id: "m-b", tag: "星标" },
      ],
      ctx: { taskId: "t1" },
    });
    const s = cardText(card);
    expect(s).toContain("默认");
    expect(s).toContain("星标");
    expect(s).toContain("全部模型");
    expect(s).toContain("回遥控器");
  });

  it("全量模型卡：当前打 ✓ + 翻页", () => {
    const card = buildAllModelsCard({
      models: [
        { id: "m-a", display: "M A" },
        { id: "m-b", display: "M B" },
      ],
      page: 0,
      totalPages: 2,
      total: 10,
      currentModelId: "m-b",
      ctx: { taskId: "t1" },
    });
    const s = cardText(card);
    expect(s).toContain("✓");
    expect(s).toContain("下一页");
  });
});

describe("modelQuickOptions", () => {
  it("默认 + 星标去重保序", () => {
    expect(
      modelQuickOptions({ defaultModelId: "m-a", starredIds: ["m-a", "m-b"] }),
    ).toEqual([
      { id: "m-a", tag: "默认" },
      { id: "m-b", tag: "星标" },
    ]);
    expect(modelQuickOptions({ defaultModelId: "", starredIds: [] })).toEqual([]);
  });
});

describe("列表与搜索", () => {
  const stubTasks = (tasks: TaskSummary[]) => {
    __setChatsPanelDepsForTest({
      listTasks: async () => tasks,
      getEndedChatTaskIds: async () => ["t9"],
    });
  };

  it("只看 chat、归档默认藏、按更新倒序", async () => {
    stubTasks([
      summary({ id: "t1", updatedAt: 100 }),
      summary({ id: "t2", mode: "plan", updatedAt: 999 }),
      summary({ id: "t9", updatedAt: 500 }),
    ]);
    const rows = await listPanelChats();
    expect(rows.map((r) => r.id)).toEqual(["t1"]);
    const withArch = await listPanelChats({ includeArchived: true });
    expect(withArch.map((r) => r.id)).toEqual(["t9", "t1"]);
    expect(withArch[0]!.archived).toBe(true);
  });

  it("按仓筛：完整 path 精确匹配、空串只看未绑", async () => {
    stubTasks([
      summary({ id: "t1", repoPaths: ["/repo/a"] }),
      summary({ id: "t2", repoPaths: [] }),
    ]);
    expect((await listPanelChats({ repo: "/repo/a" })).map((r) => r.id)).toEqual(["t1"]);
    expect((await listPanelChats({ repo: "" })).map((r) => r.id)).toEqual(["t2"]);
  });

  it("搜索：标题/仓库/模型都行、归档也搜、最多 6 条（恰一页、不翻页）", async () => {
    stubTasks([
      summary({ id: "t1", title: "登录优化", repoPaths: ["/repo/crm-web"], model: { id: "m-a" } }),
      summary({ id: "t2", title: "支付", repoPaths: ["/repo/pay"], model: { id: "m-b" } }),
      ...Array.from({ length: 8 }, (_, i) =>
        summary({ id: `g${i}`, title: `登录优化${i}`, repoPaths: ["/repo/other"], updatedAt: 50 - i }),
      ),
    ]);
    expect((await searchPanelChats("crm")).map((r) => r.id)).toEqual(["t1"]);
    expect((await searchPanelChats("M-B")).map((r) => r.id)).toEqual(["t2"]);
    expect(await searchPanelChats("  ")).toEqual([]);
    expect(await searchPanelChats("不存在")).toEqual([]);
    // 10 条命中只回前 6（第二页不存在，也就没有串味的下一页）
    expect(await searchPanelChats("登录")).toHaveLength(6);
  });
});

describe("切换与新建", () => {
  it("switch：命中即切 + 复活归档", async () => {
    const setCurrentChatTaskId = vi.fn(async () => undefined);
    const removeEndedChatTaskId = vi.fn(async () => undefined);
    __setChatsPanelDepsForTest({
      listTasks: async () => [summary({ id: "t9", title: "旧需求" })],
      setCurrentChatTaskId,
      removeEndedChatTaskId,
    });
    const r = await switchPanelChat("t9");
    expect(r).toEqual({ ok: true, title: "旧需求" });
    expect(removeEndedChatTaskId).toHaveBeenCalledWith("t9");
    expect(setCurrentChatTaskId).toHaveBeenCalledWith("t9");
  });

  it("switch：不在了 / 非 chat 都拒", async () => {
    __setChatsPanelDepsForTest({
      listTasks: async () => [summary({ id: "t1", mode: "plan" })],
    });
    expect(await switchPanelChat("nope")).toEqual({
      ok: false,
      error: "这个对话不在了，重新选一个",
    });
    expect(await switchPanelChat("t1")).toEqual({
      ok: false,
      error: "这个对话不在了，重新选一个",
    });
  });

  it("create：仓库 + 模型透传、无模型跟默认、刷指针", async () => {
    const createTask = vi.fn(async (input: Record<string, unknown>) => ({
      id: "nt",
      title: input.title,
    }));
    const setCurrentChatTaskId = vi.fn(async () => undefined);
    const prewarm = vi.fn();
    __setChatsPanelDepsForTest({
      createTask: createTask as never,
      setCurrentChatTaskId,
      prewarm,
      readSettingsFile: async () =>
        ({
          status: "ok",
          settings: {
            apiKey: "k",
            defaultModel: { id: "m-def" },
            provider: "cursor",
            repos: [],
            starredModels: {},
          },
        }) as never,
    });
    const r = await createPanelChat({ repoPath: "/repo/a", modelId: "m-x" });
    expect(r.ok).toBe(true);
    expect(createTask).toHaveBeenCalledTimes(1);
    const input = createTask.mock.calls[0]![0] as Record<string, unknown>;
    expect(input).toMatchObject({
      mode: "chat",
      repoPaths: ["/repo/a"],
      model: { id: "m-x" },
      provider: "cursor",
    });
    expect(setCurrentChatTaskId).toHaveBeenCalledWith("nt");
    expect(prewarm).toHaveBeenCalledWith("nt");
  });

  it("create：没默认模型 / 没凭据都拒", async () => {
    __setChatsPanelDepsForTest({
      readSettingsFile: async () =>
        ({
          status: "ok",
          settings: { apiKey: "k", defaultModel: { id: "" }, provider: "cursor", repos: [] },
        }) as never,
    });
    expect((await createPanelChat({})).ok).toBe(false);
    __setChatsPanelDepsForTest({
      readSettingsFile: async () =>
        ({
          status: "ok",
          settings: { apiKey: "", defaultModel: { id: "m" }, provider: "cursor", repos: [] },
        }) as never,
    });
    expect(await createPanelChat({})).toEqual({
      ok: false,
      error: "缺少 API Key 或模型凭据，请先在设置页配置",
    });
  });
});

describe("换模型", () => {
  it("跑步中拒绝、不在的拒绝", async () => {
    const setTaskModel = vi.fn();
    __setChatsPanelDepsForTest({
      getTask: async () =>
        ({ id: "t1", mode: "chat", runStatus: "running" }) as never,
      setTaskModel: setTaskModel as never,
    });
    expect(await setPanelChatModel("t1", "m-b")).toEqual({
      ok: false,
      error: "这轮还没跑完，等跑完再切（切模型下一轮才生效）",
    });
    expect(setTaskModel).not.toHaveBeenCalled();
    __setChatsPanelDepsForTest({
      getTask: async () => null,
      setTaskModel: setTaskModel as never,
    });
    expect((await setPanelChatModel("t1", "m-b")).ok).toBe(false);
  });

  it("空闲即切、thinking 档沿用旧的", async () => {
    const setTaskModel = vi.fn(async () => ({ id: "t1" }));
    __setChatsPanelDepsForTest({
      getTask: async () =>
        ({
          id: "t1",
          mode: "chat",
          runStatus: "idle",
          title: "登录优化",
          model: { id: "m-a", params: [{ id: "thinking", value: "high" }] },
        }) as never,
      setTaskModel: setTaskModel as never,
    });
    expect(await setPanelChatModel("t1", "m-b")).toEqual({ ok: true, title: "登录优化" });
    expect(setTaskModel).toHaveBeenCalledWith("t1", {
      id: "m-b",
      params: [{ id: "thinking", value: "high" }],
    });
  });
});

describe("回调与搜索消费", () => {
  it("switch 回执：切过去 + 直接说话", async () => {
    const sendOwnerText = vi.fn(async () => undefined);
    __setChatsPanelDepsForTest({
      listTasks: async () => [summary({ id: "t1", title: "登录优化" })],
      setCurrentChatTaskId: async () => undefined,
      removeEndedChatTaskId: async () => undefined,
      sendOwnerText,
    });
    await handleChatsCardAction({ kind: "chats", op: "switch", taskId: "t1" });
    expect(sendOwnerText).toHaveBeenCalledWith("已切到「登录优化」，直接说话即聊");
  });

  it("search_hint：置 flag + 教用户发关键词", async () => {
    const sendOwnerText = vi.fn(async () => undefined);
    const setAwaitingChatSearch = vi.fn(async () => undefined);
    __setChatsPanelDepsForTest({ sendOwnerText, setAwaitingChatSearch });
    await handleChatsCardAction({ kind: "chats", op: "search_hint" });
    expect(setAwaitingChatSearch).toHaveBeenCalled();
    expect(sendOwnerText).toHaveBeenCalledWith(expect.stringContaining("关键词"));
  });

  it("model_set forNew：直接建对话", async () => {
    const sendOwnerText = vi.fn(async () => undefined);
    __setChatsPanelDepsForTest({
      sendOwnerText,
      setCurrentChatTaskId: async () => undefined,
      prewarm: () => {},
      listTasks: async () => [],
      fetchAllModels: async () => [{ id: "m-x", displayName: "M X" }],
      createTask: (async (input: Record<string, unknown>) => ({
        id: "nt",
        title: input.title ?? "新对话",
      })) as never,
      readSettingsFile: async () =>
        ({
          status: "ok",
          settings: {
            apiKey: "k",
            defaultModel: { id: "m-def" },
            provider: "cursor",
            repos: [{ path: "/repo/a" }],
            starredModels: {},
          },
        }) as never,
    });
    await handleChatsCardAction({
      kind: "chats",
      op: "model_set",
      forNew: true,
      repo: "/repo/a",
      modelId: "m-x",
    });
    expect(sendOwnerText).toHaveBeenCalledWith(expect.stringContaining("已建"));
  });

  it("未知 op：回未知、不抛", async () => {
    const sendOwnerText = vi.fn(async () => undefined);
    __setChatsPanelDepsForTest({ sendOwnerText });
    await handleChatsCardAction({ kind: "chats", op: "nope" } as never);
    expect(sendOwnerText).toHaveBeenCalledWith(expect.stringContaining("还不认识"));
  });

  it("consume：flag 没置不消费；置了 + 关键词出卡；空消息不消费且不烧 flag", async () => {
    let gotCard: unknown;
    const sendOwnerCard = vi.fn(async (card: unknown) => {
      gotCard = card;
      return { message_id: "om", card_id: "c" };
    });
    const sendOwnerText = vi.fn(async () => undefined);
    __setChatsPanelDepsForTest({
      takeAwaitingChatSearch: async () => false,
      sendOwnerCard,
      sendOwnerText,
    });
    expect(await consumeChatSearchText("登录")).toBe(false);
    expect(sendOwnerCard).not.toHaveBeenCalled();

    __setChatsPanelDepsForTest({
      takeAwaitingChatSearch: async () => true,
      listTasks: async () => [summary({ id: "t1", title: "登录优化" })],
      getEndedChatTaskIds: async () => [],
      getCurrentChatTaskId: async () => "",
      sendOwnerCard,
      sendOwnerText,
    });
    expect(await consumeChatSearchText("登录")).toBe(true);
    expect(sendOwnerCard).toHaveBeenCalledTimes(1);
    expect(cardText(gotCard as Record<string, unknown>)).toContain("登录优化");

    const takeForEmpty = vi.fn(async () => true);
    __setChatsPanelDepsForTest({
      takeAwaitingChatSearch: takeForEmpty,
      sendOwnerCard,
      sendOwnerText,
    });
    expect(await consumeChatSearchText("   ")).toBe(false);
    // 空文本连 take 都不调：intent 留给后面
    expect(takeForEmpty).not.toHaveBeenCalled();
  });

  it("consume：带图/附件不消费（flag 保留给下一条纯文本）", async () => {
    const takeAwaitingChatSearch = vi.fn(async () => true);
    const sendOwnerCard = vi.fn(async () => ({ message_id: "om", card_id: "c" }));
    const sendOwnerText = vi.fn(async () => undefined);
    __setChatsPanelDepsForTest({
      takeAwaitingChatSearch,
      sendOwnerCard,
      sendOwnerText,
    });
    expect(await consumeChatSearchText("关键词", { hasAttachments: true })).toBe(false);
    // 连 take 都没调：flag 原样保留
    expect(takeAwaitingChatSearch).not.toHaveBeenCalled();
    expect(sendOwnerCard).not.toHaveBeenCalled();
    expect(sendOwnerText).not.toHaveBeenCalled();
  });

  it("peek：无锁读 flag（router 热路径 fast-path）", async () => {
    const bridgeState = await import("@/lib/server/feishu-bridge/bridge-state");
    await bridgeState.setAwaitingChatSearch();
    expect(await bridgeState.peekAwaitingChatSearch()).toBe(true);
    expect(await bridgeState.takeAwaitingChatSearch()).toBe(true);
    expect(await bridgeState.peekAwaitingChatSearch()).toBe(false);
  });

  it("consume：超长关键词截到 50 字再回显（不出怪卡）", async () => {
    const sendOwnerCard = vi.fn(async () => ({ message_id: "om", card_id: "c" }));
    let echo = "";
    const sendOwnerText = vi.fn(async (text: string) => {
      echo = text;
      return undefined;
    });
    __setChatsPanelDepsForTest({
      takeAwaitingChatSearch: async () => true,
      listTasks: async () => [summary({ id: "t1", title: "登录优化" })],
      getEndedChatTaskIds: async () => [],
      getCurrentChatTaskId: async () => "",
      sendOwnerCard,
      sendOwnerText,
    });
    const paste = `登录优化${"x".repeat(60)}`;
    expect(await consumeChatSearchText(paste)).toBe(true);
    // 截后 50 字含一串 x，短标题含不下 → 无结果，只回显截后串
    expect(sendOwnerCard).not.toHaveBeenCalled();
    expect(sendOwnerText).toHaveBeenCalledTimes(1);
    expect(echo).toContain(paste.slice(0, 50));
    expect(echo).not.toContain(paste);
  });

  it("showChatListCard：翻页切片 + 当前标记", async () => {
    let gotCard: unknown;
    const sendOwnerCard = vi.fn(async (card: unknown) => {
      gotCard = card;
      return { message_id: "om", card_id: "c" };
    });
    const tasks = Array.from({ length: 8 }, (_, i) =>
      summary({ id: `t${i}`, title: `对话${i}`, updatedAt: 100 - i }),
    );
    __setChatsPanelDepsForTest({
      listTasks: async () => tasks,
      getEndedChatTaskIds: async () => [],
      getCurrentChatTaskId: async () => "t7",
      sendOwnerCard,
    });
    await showChatListCard({ page: 1 });
    const s = cardText(gotCard as Record<string, unknown>);
    expect(s).toContain("对话7");
    expect(s).toContain("上一页");
  });

  it("搜按钮写明范围：搜标题/仓库/模型", async () => {
    let gotCard: unknown;
    const sendOwnerCard = vi.fn(async (card: unknown) => {
      gotCard = card;
      return { message_id: "om", card_id: "c" };
    });
    __setChatsPanelDepsForTest({
      listTasks: async () => [summary({ id: "t1" })],
      getEndedChatTaskIds: async () => [],
      getCurrentChatTaskId: async () => "t1",
      sendOwnerCard,
    });
    await showChatListCard({});
    expect(cardText(gotCard as Record<string, unknown>)).toContain("搜标题/仓库/模型");
  });

  it("dedupInflight：并发同 key 只跑一次、落定后下次重跑、拒绝也清 key", async () => {
    const m = new Map<string, Promise<string>>();
    const gate = (() => {
      let release!: () => void;
      const p = new Promise<void>((r) => {
        release = r;
      });
      return { p, release };
    })();
    const run = vi.fn(async () => {
      await gate.p;
      return "v";
    });
    const [a, b] = [dedupInflight(m, "k", run), dedupInflight(m, "k", run)];
    gate.release();
    await expect(a).resolves.toBe("v");
    await expect(b).resolves.toBe("v");
    expect(run).toHaveBeenCalledTimes(1);
    await expect(dedupInflight(m, "k", run)).resolves.toBe("v");
    expect(run).toHaveBeenCalledTimes(2);

    const m2 = new Map<string, Promise<string>>();
    const fail = vi.fn(async () => {
      throw new Error("boom");
    });
    await expect(dedupInflight(m2, "k", fail)).rejects.toThrow("boom");
    expect(m2.has("k")).toBe(false);
  });
});

describe("P0：按仓筛选翻页不断链", () => {
  const buttonValues = (card: Record<string, unknown>): Record<string, unknown>[] => {
    const body = (card.body ?? {}) as { elements?: Array<Record<string, unknown>> };
    return (body.elements ?? [])
      .filter((e) => e.tag === "button")
      .map((e) => {
        const behaviors = e.behaviors as Array<{ value?: unknown }>;
        return (behaviors?.[0]?.value ?? {}) as Record<string, unknown>;
      });
  };

  it("筛选卡的下一页/归档按钮回填完整 path，不是尾巴", async () => {
    let gotCard: unknown;
    const sendOwnerCard = vi.fn(async (card: unknown) => {
      gotCard = card;
      return { message_id: "om", card_id: "c" };
    });
    __setChatsPanelDepsForTest({
      listTasks: async () =>
        Array.from({ length: 8 }, (_, i) =>
          summary({ id: `t${i}`, title: `对话${i}`, repoPaths: ["/x/crm-web"], updatedAt: 100 - i }),
        ),
      getEndedChatTaskIds: async () => [],
      getCurrentChatTaskId: async () => "",
      sendOwnerCard,
    });
    await showChatListCard({ repo: "/x/crm-web", page: 0 });
    const values = buttonValues(gotCard as Record<string, unknown>);
    const next = values.find((v) => v.op === "list" && v.page === 1);
    // 回填完整 path：下一页按它筛还能命中
    expect(next).toMatchObject({ repo: "/x/crm-web" });
    const arch = values.find((v) => v.op === "list" && v.archived === true);
    expect(arch).toMatchObject({ repo: "/x/crm-web" });
    // 拿回填值真走一遍第二页：不断链
    await showChatListCard({ repo: next!.repo as string, page: next!.page as number });
    const s2 = cardText(gotCard as Record<string, unknown>);
    expect(s2).toContain("对话6");
    expect(s2).toContain("对话7");
  });
});

describe("语义层校验", () => {
  const settingsOf = (settings: Record<string, unknown>) => ({
    readSettingsFile: async () => ({ status: "ok", settings }) as never,
  });

  it("checkPanelModelId：快捷命中不拉目录、目录命中过、 miss 拒、拉失败指重试", async () => {
    const fetchAllModels = vi.fn(async () => [{ id: "m-all", displayName: "M" }]);
    __setChatsPanelDepsForTest({
      ...settingsOf({
        apiKey: "k",
        defaultModel: { id: "m-def" },
        provider: "cursor",
        repos: [],
        starredModels: {},
      }),
      fetchAllModels,
    });
    expect(await checkPanelModelId("m-def", "cursor")).toEqual({ ok: true });
    expect(fetchAllModels).not.toHaveBeenCalled();
    expect(await checkPanelModelId("m-all", "cursor")).toEqual({ ok: true });
    expect(fetchAllModels).toHaveBeenCalledTimes(1);
    expect(await checkPanelModelId("m-nope", "cursor")).toEqual({
      ok: false,
      error: "这个模型不在可选列表里，重新选一个",
    });
    expect(await checkPanelModelId("  ", "cursor")).toEqual({
      ok: false,
      error: "模型 id 非法，重新选一个",
    });
    __setChatsPanelDepsForTest({
      ...settingsOf({
        apiKey: "k",
        defaultModel: { id: "m-def" },
        provider: "cursor",
        repos: [],
        starredModels: {},
      }),
      fetchAllModels: async () => {
        throw new Error("boom");
      },
    });
    expect(await checkPanelModelId("m-all", "cursor")).toEqual({
      ok: false,
      error: "模型列表拉取失败，稍后再试",
    });
  });

  it("isAllowedPanelRepo：空=不绑永远行、设置/已有绑定行、未知/穿越不行", async () => {
    __setChatsPanelDepsForTest({
      ...settingsOf({ provider: "cursor", repos: [{ path: "/repo/a" }] }),
      listTasks: async () => [summary({ id: "t1", repoPaths: ["/repo/b"] })],
    });
    expect(await isAllowedPanelRepo("")).toBe(true);
    expect(await isAllowedPanelRepo("/repo/a")).toBe(true);
    expect(await isAllowedPanelRepo("/repo/b")).toBe(true);
    expect(await isAllowedPanelRepo("/repo/evil")).toBe(false);
    expect(await isAllowedPanelRepo("/repo/../evil")).toBe(false);
  });

  it("handler：伪造 model_set 进不了 setTaskModel", async () => {
    const sendOwnerText = vi.fn(async () => undefined);
    const setTaskModel = vi.fn(async () => ({}));
    __setChatsPanelDepsForTest({
      ...settingsOf({
        apiKey: "k",
        defaultModel: { id: "m-def" },
        provider: "cursor",
        repos: [],
        starredModels: {},
      }),
      fetchAllModels: async () => [{ id: "m-def", displayName: "M" }],
      getTask: (async (id: string) =>
        ({ id, mode: "chat", runStatus: "idle", provider: "cursor" }) as never) as never,
      setTaskModel: setTaskModel as never,
      sendOwnerText,
    });
    await handleChatsCardAction({ kind: "chats", op: "model_set", taskId: "t1", modelId: "m-evil" });
    expect(setTaskModel).not.toHaveBeenCalled();
    expect(sendOwnerText).toHaveBeenCalledWith("这个模型不在可选列表里，重新选一个");
  });

  it("handler：伪造 create 仓库被拒", async () => {
    const sendOwnerText = vi.fn(async () => undefined);
    const createTask = vi.fn();
    __setChatsPanelDepsForTest({
      ...settingsOf({ provider: "cursor", repos: [] }),
      listTasks: async () => [],
      createTask: createTask as never,
      sendOwnerText,
    });
    await handleChatsCardAction({ kind: "chats", op: "create", repo: "/nope/x" });
    expect(createTask).not.toHaveBeenCalled();
    expect(sendOwnerText).toHaveBeenCalledWith("这个仓库不在可选范围里，重新选一个");
  });

  it("showModelCard：对话自带提供方（空串按 cursor）也拿对候选", async () => {
    let gotCard: unknown;
    const sendOwnerCard = vi.fn(async (card: unknown) => {
      gotCard = card;
      return { message_id: "om", card_id: "c" };
    });
    __setChatsPanelDepsForTest({
      getTask: (async (id: string) =>
        ({
          id,
          mode: "chat",
          runStatus: "idle",
          provider: "",
          model: { id: "m-cur" },
        }) as never) as never,
      ...settingsOf({
        apiKey: "k",
        defaultModel: { id: "m-def" },
        provider: "cursor",
        repos: [],
        starredModels: { cursor: ["m-star"] },
      }),
      sendOwnerCard,
    });
    await showModelCard({ taskId: "t1" });
    const s = cardText(gotCard as Record<string, unknown>);
    // provider 空串 = cursor：星标照出
    expect(s).toContain("星标");
  });

  it("showModelCard：对话的提供方已被删 → 指去电脑设置页", async () => {
    const sendOwnerText = vi.fn(async () => undefined);
    const sendOwnerCard = vi.fn(async () => ({ message_id: "om", card_id: "c" }));
    __setChatsPanelDepsForTest({
      getTask: (async (id: string) =>
        ({
          id,
          mode: "chat",
          runStatus: "idle",
          provider: "gone-1",
          model: { id: "m-cur" },
        }) as never) as never,
      ...settingsOf({
        apiKey: "k",
        defaultModel: { id: "m-def" },
        provider: "cursor",
        repos: [],
        starredModels: {},
      }),
      sendOwnerText,
      sendOwnerCard,
    });
    await showModelCard({ taskId: "t1" });
    expect(sendOwnerText).toHaveBeenCalledWith("这个对话的提供方已经没了，去电脑设置页看看");
    expect(sendOwnerCard).not.toHaveBeenCalled();
  });
});
