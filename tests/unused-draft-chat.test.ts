import { describe, expect, it } from "vitest";

import {
  findUnusedDraftChat,
  isUnusedDraftChat,
  pickChatLanding,
} from "@/lib/task-display";

const draft = (over: {
  id: string;
  title?: string;
  updatedAt?: number;
  repoPaths?: string[];
  sessionAgentId?: string;
  repoStatus?: string;
  archived?: boolean;
  mode?: "chat" | "task";
}) => ({
  mode: (over.mode ?? "chat") as "chat" | "task",
  title: over.title ?? "对话 · 08/27 15:00",
  repoStatus: over.repoStatus ?? "developing",
  sessionAgentId: over.sessionAgentId,
  updatedAt: over.updatedAt ?? 1,
  repoPaths: over.repoPaths,
  archived: over.archived,
  id: over.id,
});

describe("unused draft chat", () => {
  it("占位标题、没会话锚点才算空草稿", () => {
    expect(isUnusedDraftChat(draft({ id: "a" }))).toBe(true);
    expect(
      isUnusedDraftChat(draft({ id: "b", title: "帮我看看这段代码" })),
    ).toBe(false);
    expect(
      isUnusedDraftChat(draft({ id: "c", sessionAgentId: "sess-1" })),
    ).toBe(false);
    expect(
      isUnusedDraftChat(draft({ id: "d", repoStatus: "abandoned" })),
    ).toBe(false);
    expect(isUnusedDraftChat(draft({ id: "e", mode: "task" }))).toBe(false);
  });

  it("新建优先复用同目录空草稿，没有同目录就用最近那条空的", () => {
    const tasks = [
      draft({ id: "old-home", updatedAt: 10, repoPaths: [] }),
      draft({
        id: "crm",
        updatedAt: 20,
        repoPaths: ["/Users/me/crm-web"],
      }),
      draft({ id: "newer-home", updatedAt: 30, repoPaths: [] }),
    ];
    expect(findUnusedDraftChat(tasks, [])?.id).toBe("newer-home");
    expect(findUnusedDraftChat(tasks, ["/Users/me/crm-web/"])?.id).toBe("crm");
    expect(findUnusedDraftChat(tasks, ["/Users/me/other"])?.id).toBe(
      "newer-home",
    );
    expect(findUnusedDraftChat([], [])).toBeUndefined();
  });

  it("已归档的空草稿不复用（侧栏看不到它，复用 = 点新建却不在列表）", () => {
    expect(isUnusedDraftChat(draft({ id: "a", archived: true }))).toBe(false);
    const tasks = [
      draft({ id: "archived-crm", updatedAt: 99, repoPaths: ["/Users/me/crm-web"], archived: true }),
      draft({ id: "live-home", updatedAt: 1, repoPaths: [] }),
    ];
    // 同目录只有归档草稿 → 不选它，退回最近的未归档空草稿
    expect(findUnusedDraftChat(tasks, ["/Users/me/crm-web"])?.id).toBe("live-home");
    // 只剩归档草稿 → 没有可复用的，交给调用方新建
    expect(findUnusedDraftChat([tasks[0]], ["/Users/me/crm-web"])).toBeUndefined();
  });
});

describe("pickChatLanding（/chats 落点）", () => {
  const chat = (id: string, updatedAt: number, archived?: boolean, mode: "chat" | "task" = "chat") => ({
    id,
    mode,
    updatedAt,
    archived,
  });

  it("优先最后浏览的那条", () => {
    const tasks = [chat("a", 10), chat("b", 20)];
    expect(pickChatLanding(tasks, "a")?.id).toBe("a");
  });

  it("没记录 / 记录的已不在 → 最近活跃", () => {
    const tasks = [chat("a", 10), chat("b", 20)];
    expect(pickChatLanding(tasks, null)?.id).toBe("b");
    expect(pickChatLanding(tasks, "gone")?.id).toBe("b");
  });

  it("最后浏览的已归档 → 不落回它（归档当前对话后别停在侧栏里没有的对话上）", () => {
    const tasks = [chat("a", 10), chat("b", 20, true)];
    expect(pickChatLanding(tasks, "b")?.id).toBe("a");
  });

  it("task 模式不算对话；全归档 / 没对话 → undefined（页面显示空态）", () => {
    expect(pickChatLanding([chat("t", 5, false, "task")], null)).toBeUndefined();
    expect(pickChatLanding([chat("a", 10, true)], "a")).toBeUndefined();
    expect(pickChatLanding([], null)).toBeUndefined();
  });
});
