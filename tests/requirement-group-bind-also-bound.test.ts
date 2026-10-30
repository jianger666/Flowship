/**
 * 手动绑群：绑完告诉用户「这个群上还有别的任务」（B4-4 / Q12b-02 的绑定部分）
 * 路由：src/app/api/tasks/[id]/requirement-group/bind/route.ts
 *
 * 一个群可以同时被多个任务绑（拆分任务、重开任务都会遇到），群里的 @ 却只会进其中一个。
 * 原来 bind 只比本任务自己的关联，没有任何跨任务查重，两个任务的界面都显示「已绑定」。
 * 现在 POST 成功时多带一个 `alsoBoundBy: [{ id, title }]`（这个群上**别的**任务，本地关联、未归档 / 未合并 / 未放弃），
 * 弹窗据此提示；不拦绑定（绑多个是合法用法）。
 *
 * 查重只是增强信息：读任务列表失败当没有，绝不能让一次已经落盘的绑定变成失败。
 * 绑定本身（飞书校验 / 落盘）用 mock 顶替，真正的判断逻辑在 group-task-binding.test.ts。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const CHAT = "oc_shared";
const STORY = "https://project.feishu.cn/space/story/detail/10001";

const mocks = vi.hoisted(() => ({
  getTask: vi.fn(),
  listTasks: vi.fn(),
  setTaskGroupAssociation: vi.fn(),
  bindExistingRequirementGroup: vi.fn(),
  clearTaskGroupAssociation: vi.fn(),
}));

vi.mock("@/lib/server/task-fs", () => ({
  getTask: mocks.getTask,
  listTasks: mocks.listTasks,
  setTaskGroupAssociation: mocks.setTaskGroupAssociation,
}));

vi.mock("@/lib/server/feishu-group", () => {
  class FeishuGroupError extends Error {
    code: string;
    botLabel?: string;
    chatId?: string;
    chatName?: string;
    constructor(code: string, message: string, extra: { botLabel?: string; chatId?: string; chatName?: string } = {}) {
      super(message);
      this.code = code;
      Object.assign(this, extra);
    }
  }
  return {
    FeishuGroupError,
    bindExistingRequirementGroup: mocks.bindExistingRequirementGroup,
    clearTaskGroupAssociation: mocks.clearTaskGroupAssociation,
  };
});

const { POST } = await import("@/app/api/tasks/[id]/requirement-group/bind/route");
const { FeishuGroupError } = await import("@/lib/server/feishu-group");

type SummarySpec = {
  id: string;
  title?: string;
  updatedAt?: number;
  chat?: string;
  story?: boolean;
  archived?: boolean;
  repoStatus?: string;
};

const summary = (s: SummarySpec) => ({
  id: s.id,
  title: s.title ?? `任务 ${s.id}`,
  updatedAt: s.updatedAt ?? 1000,
  repoStatus: s.repoStatus ?? "developing",
  ...(s.story === false ? {} : { feishuStoryUrl: STORY }),
  ...(s.chat ? { feishuGroupChatId: s.chat } : {}),
  ...(s.archived ? { archived: true } : {}),
});

const post = async (id = "self") => {
  const res = await POST(
    new Request(`http://localhost/api/tasks/${id}/requirement-group/bind`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId: CHAT }),
    }),
    { params: Promise.resolve({ id }) },
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

beforeEach(() => {
  mocks.getTask.mockReset();
  mocks.listTasks.mockReset();
  mocks.setTaskGroupAssociation.mockReset();
  mocks.bindExistingRequirementGroup.mockReset();
  mocks.clearTaskGroupAssociation.mockReset();
  mocks.getTask.mockImplementation(async (id: string) => ({ id, title: `任务 ${id}`, feishuStoryUrl: STORY, events: [], actions: [] }));
  mocks.bindExistingRequirementGroup.mockResolvedValue({
    chatId: CHAT,
    chatName: "需求群",
    overwritten: false,
  });
  mocks.listTasks.mockResolvedValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("绑定成功：alsoBoundBy", () => {
  it("没有别的任务绑这个群 → 响应里不带 alsoBoundBy（旧客户端 / 旧测试看到的形态不变）", async () => {
    mocks.listTasks.mockResolvedValue([summary({ id: "self", chat: CHAT }), summary({ id: "x", chat: "oc_other" })]);
    const { status, body } = await post();
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, chatId: CHAT, chatName: "需求群", overwritten: false });
    expect("alsoBoundBy" in body).toBe(false);
  });

  it("别的任务本地关联了同一个群 → 带上它们的 id + 标题，按最近更新倒序，不含本任务", async () => {
    mocks.listTasks.mockResolvedValue([
      summary({ id: "self", chat: CHAT, updatedAt: 9000 }),
      summary({ id: "older", title: "旧任务", chat: CHAT, updatedAt: 100 }),
      summary({ id: "newer", title: "新任务", chat: CHAT, updatedAt: 5000 }),
    ]);
    const { status, body } = await post();
    expect(status).toBe(200);
    expect(body.alsoBoundBy).toEqual([
      { id: "newer", title: "新任务" },
      { id: "older", title: "旧任务" },
    ]);
  });

  it("归档 / 已合并 / 已放弃 / 别的群 / 只靠项目群默认的任务都不算", async () => {
    mocks.listTasks.mockResolvedValue([
      summary({ id: "self", chat: CHAT }),
      summary({ id: "arch", chat: CHAT, archived: true }),
      summary({ id: "mrg", chat: CHAT, repoStatus: "merged" }),
      summary({ id: "abd", chat: CHAT, repoStatus: "abandoned" }),
      summary({ id: "other", chat: "oc_other" }),
      summary({ id: "pd" }),
    ]);
    const { body } = await post();
    expect("alsoBoundBy" in body).toBe(false);
  });

  it("同群任务很多时最多带 20 个（防响应被异常数据撑大），保留最近更新的", async () => {
    mocks.listTasks.mockResolvedValue([
      summary({ id: "self", chat: CHAT }),
      ...Array.from({ length: 25 }, (_, i) => summary({ id: `t${i}`, chat: CHAT, updatedAt: 1000 + i })),
    ]);
    const { body } = await post();
    const list = body.alsoBoundBy as Array<{ id: string }>;
    expect(list).toHaveLength(20);
    expect(list[0]!.id).toBe("t24");
    expect(list[19]!.id).toBe("t5");
  });

  it("查重用的是绑定后的群 id（bind 返回的 chatId），不是请求里原样的文本", async () => {
    mocks.bindExistingRequirementGroup.mockResolvedValue({ chatId: "oc_normalized", overwritten: true, previousChatId: "oc_old" });
    mocks.listTasks.mockResolvedValue([
      summary({ id: "self", chat: "oc_normalized" }),
      summary({ id: "peer", chat: "oc_normalized" }),
      summary({ id: "raw", chat: CHAT }),
    ]);
    const { body } = await post();
    expect(body).toMatchObject({ chatId: "oc_normalized", overwritten: true, previousChatId: "oc_old" });
    expect(body.alsoBoundBy).toEqual([{ id: "peer", title: "任务 peer" }]);
  });
});

describe("查重失败不影响绑定", () => {
  it("读任务列表抛错 → 绑定照常成功（200），没有 alsoBoundBy，只 warn", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.listTasks.mockRejectedValue(new Error("任务目录读不出来"));
    const { status, body } = await post();
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, chatId: CHAT });
    expect("alsoBoundBy" in body).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain("不影响绑定");
  });
});

describe("绑定失败时不查重", () => {
  it("机器人不在群里（409）→ 不读任务列表、不带 alsoBoundBy", async () => {
    mocks.bindExistingRequirementGroup.mockRejectedValue(
      new FeishuGroupError("bot_not_in_group", "机器人还不在目标群", { botLabel: "Flowship", chatId: CHAT }),
    );
    const { status, body } = await post();
    expect(status).toBe(409);
    expect(body).toMatchObject({ code: "bot_not_in_group", botLabel: "Flowship", chatId: CHAT });
    expect(mocks.listTasks).not.toHaveBeenCalled();
    expect("alsoBoundBy" in body).toBe(false);
  });
});
