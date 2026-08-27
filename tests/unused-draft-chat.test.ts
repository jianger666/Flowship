import { describe, expect, it } from "vitest";

import {
  findUnusedDraftChat,
  isUnusedDraftChat,
} from "@/lib/task-display";

const draft = (over: {
  id: string;
  title?: string;
  updatedAt?: number;
  repoPaths?: string[];
  sessionAgentId?: string;
  repoStatus?: string;
  mode?: "chat" | "task";
}) => ({
  mode: (over.mode ?? "chat") as "chat" | "task",
  title: over.title ?? "对话 · 08/27 15:00",
  repoStatus: over.repoStatus ?? "developing",
  sessionAgentId: over.sessionAgentId,
  updatedAt: over.updatedAt ?? 1,
  repoPaths: over.repoPaths,
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
});
