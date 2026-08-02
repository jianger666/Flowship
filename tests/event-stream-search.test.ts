/**
 * 事件流内联搜索纯函数单测
 */
import { describe, expect, it } from "vitest";

import {
  eventTextsMatchQuery,
  extractSearchableTextsFromEvent,
  findRenderIndexForEventId,
  normalizeEventStreamSearchQuery,
  searchEventStreamRenderOccurrences,
  searchEventStreamOccurrences,
  searchTaskEvents,
  stabilizeSearchSelection,
  stepSearchHitIndex,
} from "@/lib/event-stream-search";
import type { TaskEvent } from "@/lib/types";

const ev = (
  partial: Partial<TaskEvent> & Pick<TaskEvent, "id" | "kind" | "text">,
): TaskEvent =>
  ({
    ts: 1,
    actionId: "a1",
    meta: {},
    ...partial,
  }) as TaskEvent;

describe("normalizeEventStreamSearchQuery", () => {
  it("trim + 小写", () => {
    expect(normalizeEventStreamSearchQuery("  Foo  ")).toBe("foo");
  });

  it("空白视为空查询", () => {
    expect(normalizeEventStreamSearchQuery("   ")).toBe("");
  });
});

describe("extractSearchableTextsFromEvent", () => {
  it("只索引 AI 回复正文", () => {
    const texts = extractSearchableTextsFromEvent(
      ev({ id: "1", kind: "assistant_message", text: "Hello World" }),
    );
    expect(texts.join(" ")).toContain("Hello World");
    expect(eventTextsMatchQuery(texts, "world")).toBe(true);
    expect(
      extractSearchableTextsFromEvent(
        ev({ id: "user", kind: "user_reply", text: "Hello from user" }),
      ),
    ).toEqual([]);
    expect(
      extractSearchableTextsFromEvent(
        ev({ id: "thinking", kind: "thinking", text: "Hello in thought" }),
      ),
    ).toEqual([]);
  });

  it("不索引 tool_call / tool_result（渲染为 ToolBlock）", () => {
    expect(
      extractSearchableTextsFromEvent(
        ev({
          id: "2",
          kind: "tool_call",
          text: "读取文件",
          meta: {
            name: "read",
            args: '{"path":"/src/app/page.tsx"}',
          },
        }),
      ),
    ).toEqual([]);
    expect(
      extractSearchableTextsFromEvent(
        ev({
          id: "3",
          kind: "tool_result",
          text: "done",
          meta: { output: "secret MR path", name: "read" },
        }),
      ),
    ).toEqual([]);
  });

  it("不索引过程和状态正文", () => {
    expect(
      extractSearchableTextsFromEvent(
        ev({ id: "3", kind: "action_start", text: "开始 Build 阶段" }),
      ),
    ).toEqual([]);
  });

  it("空查询不产生命中", () => {
    expect(
      searchTaskEvents(
        [ev({ id: "1", kind: "error", text: "boom" })],
        "   ",
      ),
    ).toEqual([]);
  });
});

describe("searchEventStreamOccurrences", () => {
  const events = [
    ev({ id: "e1", kind: "user_reply", text: "first MR message" }),
    ev({ id: "e2", kind: "assistant_message", text: "second MR reply" }),
    ev({ id: "e3", kind: "error", text: "something failed" }),
  ];

  it("按 occurrence 计数", () => {
    const occ = searchEventStreamOccurrences(events, "mr");
    expect(occ).toHaveLength(1);
    expect(occ[0]?.globalIndex).toBe(0);
  });

  it("同一事件多 occurrence", () => {
    const occ = searchEventStreamOccurrences(
      [ev({ id: "e1", kind: "assistant_message", text: "MR and MR" })],
      "mr",
    );
    expect(occ).toHaveLength(2);
    expect(occ.every((o) => o.ownerId === "e1")).toBe(true);
  });
  it("extras 使用 extra0 字段", () => {
    const occ = searchEventStreamOccurrences([], "MR", [
      { id: "__streaming__", texts: ["MR chunk"] },
    ]);
    expect(occ).toHaveLength(1);
    expect(occ[0]).toMatchObject({
      ownerId: "__streaming__",
      field: "extra0",
    });
  });

  it("assistant_message 链接 URL 含 MR、可见标题不含 → 0 结果", () => {
    const occ = searchEventStreamOccurrences(
      [ev({ id: "e1", kind: "assistant_message", text: "[标题](https://x/MR)" })],
      "MR",
    );
    expect(occ).toHaveLength(0);
  });

  it("assistant_message 可见标题含 MR → 1 结果且 offset 正确", () => {
    const occ = searchEventStreamOccurrences(
      [ev({ id: "e1", kind: "assistant_message", text: "[MR 标题](https://x/no)" })],
      "MR",
    );
    expect(occ).toHaveLength(1);
    expect(occ[0]).toMatchObject({
      ownerId: "e1",
      field: "body",
      start: 0,
      end: 2,
    });
  });

  it("streaming markdown extra 同样排除 URL 内 MR", () => {
    const urlOnly = searchEventStreamOccurrences([], "MR", [
      {
        id: "__streaming__",
        texts: ["[标题](https://x/MR)"],
        markdown: true,
      },
    ]);
    expect(urlOnly).toHaveLength(0);

    const titleHit = searchEventStreamOccurrences([], "MR", [
      {
        id: "__streaming__",
        texts: ["[MR 标题](https://x/no)"],
        markdown: true,
      },
    ]);
    expect(titleHit).toHaveLength(1);
    expect(titleHit[0]).toMatchObject({
      ownerId: "__streaming__",
      field: "extra0",
      start: 0,
      end: 2,
    });
  });
});

describe("searchEventStreamRenderOccurrences", () => {
  it("不索引合并后的思考过程", () => {
    const occurrences = searchEventStreamRenderOccurrences(
      [
        {
          id: "group-1",
          kind: "__work_group__",
          members: [
            {
              id: "thinking-1",
              kind: "thinking",
              text: "first fragment\nsecond target fragment",
            },
          ],
        },
      ],
      "target",
    );

    expect(occurrences).toHaveLength(0);
  });

  it("只索引正在生成的 AI 回复，不索引待发送用户消息", () => {
    const occurrences = searchEventStreamRenderOccurrences(
      [
        { id: "pending-1", kind: "__pending_local__", text: "queued target" },
        { id: "__streaming__", kind: "__streaming__", text: "live target" },
      ],
      "target",
    );
    expect(occurrences.map((item) => item.ownerId)).toEqual(["__streaming__"]);
  });
});

describe("searchTaskEvents", () => {
  const events = [
    ev({ id: "e1", kind: "user_reply", text: "first message" }),
    ev({ id: "e2", kind: "assistant_message", text: "second reply" }),
    ev({ id: "e3", kind: "error", text: "something failed" }),
  ];

  it("按时间序返回命中 id", () => {
    expect(searchTaskEvents(events, "message").map((id) => id)).toEqual([]);
    expect(searchTaskEvents(events, "reply").map((id) => id)).toEqual(["e2"]);
    expect(searchTaskEvents(events, "failed").map((id) => id)).toEqual([]);
  });

  it("支持 extras（流式占位）", () => {
    expect(
      searchTaskEvents(events, "streaming", [
        { id: "__streaming__", texts: ["streaming chunk"] },
      ]),
    ).toEqual(["__streaming__"]);
  });
});

describe("stepSearchHitIndex", () => {
  it("next / prev 循环", () => {
    expect(stepSearchHitIndex(0, 3, "next")).toBe(1);
    expect(stepSearchHitIndex(2, 3, "next")).toBe(0);
    expect(stepSearchHitIndex(0, 3, "prev")).toBe(2);
  });

  it("无命中返回 -1", () => {
    expect(stepSearchHitIndex(-1, 0, "next")).toBe(-1);
  });
});

describe("stabilizeSearchSelection", () => {
  it("新事件到达仍保持同一 eventId", () => {
    const hits = ["a", "b", "c"];
    expect(stabilizeSearchSelection("b", hits, 0)).toEqual({
      index: 1,
      eventId: "b",
    });
  });

  it("原选中消失则钳制下标", () => {
    expect(stabilizeSearchSelection("gone", ["x", "y"], 5)).toEqual({
      index: 0,
      eventId: "x",
    });
  });
});

describe("findRenderIndexForEventId", () => {
  it("工作过程组内成员映射到组行", () => {
    const idx = findRenderIndexForEventId(
      [
        { id: "u1", kind: "user_reply" },
        {
          id: "g1",
          kind: "__work_group__",
          members: [{ id: "t1" }, { id: "t2" }],
        },
      ],
      "t2",
    );
    expect(idx).toBe(1);
  });
});
