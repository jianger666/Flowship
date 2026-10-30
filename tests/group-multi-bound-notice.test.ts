/**
 * 「这个群同时绑了多个任务」写给属主的提示（B4-4 / Q12b-02）：src/lib/server/feishu-bridge/group-multi-bound-notice.ts
 *
 * 群消息只会进其中一个任务；受理方的事件流里留一条 info，让属主知道「我的群消息是被另一个任务占着」。
 *  - 文案：写清一共几个任务、这条进了本任务、怎么改（取消关联 / 换绑）；标题按码点截断；同伴多时折成「等另外 N 个」；
 *  - 节流：同一个群 × 受理任务 × 同伴组合 30 分钟一条；同伴变了、受理任务变了都是新情况；
 *  - 永不抛：写事件失败只 warn，不能打断入向链。
 * 外部依赖只有「写事件」，用 mock 记录。
 */
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const writeOwnedEventAndPublish = vi.hoisted(() =>
  vi.fn<(...args: unknown[]) => Promise<{ id: string } | null>>(async () => ({ id: "ev_owned" })),
);

vi.mock("@/lib/server/task-stream", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/task-stream")>();
  return { ...actual, writeOwnedEventAndPublish };
});

process.env.FLOWSHIP_DATA_DIR = path.join(os.tmpdir(), `group-multi-bound-notice-${Date.now()}`, "data");

const {
  MULTI_BOUND_NOTICE_WINDOW_MS,
  MULTI_BOUND_TITLES_SHOWN,
  MULTI_BOUND_TITLE_CLIP,
  __resetGroupMultiBoundNoticeForTest,
  describeMultiBound,
  noteGroupMultiBound,
} = await import("@/lib/server/feishu-bridge/group-multi-bound-notice");

const CHAT = "oc_shared";
const T0 = 1_800_000_000_000;

const tasks = (...ids: string[]) => ids.map((id) => ({ id, title: `任务 ${id}` }));

/** 写进事件流的 info 正文 */
const written = (): Array<{ taskId: string; text: string }> =>
  writeOwnedEventAndPublish.mock.calls.map((c) => ({
    taskId: String(c[0]),
    text: String((c[2] as { text: string }).text),
  }));

beforeEach(() => {
  __resetGroupMultiBoundNoticeForTest();
  writeOwnedEventAndPublish.mockClear();
  writeOwnedEventAndPublish.mockImplementation(async () => ({ id: "ev_owned" }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("describeMultiBound：文案", () => {
  it("两个任务：说清一共几个、同伴是谁、这条进了本任务、规则、怎么改", () => {
    expect(describeMultiBound("A", tasks("A", "B"))).toBe(
      "这个群同时绑定了 2 个任务（本任务和「任务 B」），群里的 @ 只会进其中一个——这条进了本任务" +
        "（优先选正在运行 / 等你回答的，同档选最近更新的）。想让群只对应一个任务，请到其它任务的「需求群」弹窗取消关联或换绑",
    );
  });

  it("同伴列表里不重复列本任务自己；顺序保持传入顺序", () => {
    const text = describeMultiBound("B", tasks("A", "B", "C"));
    expect(text).toContain("3 个任务（本任务和「任务 A」「任务 C」）");
    expect(text).not.toContain("「任务 B」");
  });

  it(`同伴超过 ${MULTI_BOUND_TITLES_SHOWN} 个：只列前 ${MULTI_BOUND_TITLES_SHOWN} 个，其余折成「等另外 N 个」`, () => {
    const ids = ["A", "B", "C", "D", "E", "F", "G"];
    const text = describeMultiBound("A", tasks(...ids));
    expect(text).toContain("7 个任务（本任务和「任务 B」「任务 C」「任务 D」「任务 E」等另外 2 个）");
    expect(text).not.toContain("「任务 F」");
  });

  it("恰好等于上限：不出现「等另外」", () => {
    const text = describeMultiBound("A", tasks("A", "B", "C", "D", "E"));
    expect(text).toContain("本任务和「任务 B」「任务 C」「任务 D」「任务 E」）");
    expect(text).not.toContain("等另外");
  });

  it("没标题的同伴回退显示 id", () => {
    const text = describeMultiBound("A", [
      { id: "A", title: "本任务" },
      { id: "t_untitled", title: "" },
    ]);
    expect(text).toContain("「t_untitled」");
  });

  it(`标题超过 ${MULTI_BOUND_TITLE_CLIP} 个字按码点截断加省略号，不切开 emoji`, () => {
    const long = `${"字".repeat(MULTI_BOUND_TITLE_CLIP - 1)}😀尾巴`;
    const text = describeMultiBound("A", [
      { id: "A", title: "本任务" },
      { id: "B", title: long },
    ]);
    expect(text).toContain(`「${"字".repeat(MULTI_BOUND_TITLE_CLIP - 1)}😀…」`);
    expect(text).not.toContain("尾巴");
    // 孤立代理项会让飞书 / 事件流乱码
    expect(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(text)).toBe(false);
  });

  it("恰好等于上限长度的标题原样显示", () => {
    const exact = "字".repeat(MULTI_BOUND_TITLE_CLIP);
    const text = describeMultiBound("A", [
      { id: "A", title: "本任务" },
      { id: "B", title: exact },
    ]);
    expect(text).toContain(`「${exact}」`);
  });
});

describe("noteGroupMultiBound：写事件与节流", () => {
  it("写一条 info 到受理任务的事件流（任何人的写入都放行：ownerCheck 恒真）", async () => {
    await noteGroupMultiBound("A", CHAT, tasks("A", "B"), T0);
    expect(writeOwnedEventAndPublish).toHaveBeenCalledTimes(1);
    const call = writeOwnedEventAndPublish.mock.calls[0]!;
    expect(call[0]).toBe("A");
    expect((call[1] as () => boolean)()).toBe(true);
    expect(call[2]).toMatchObject({ kind: "info" });
    expect(written()[0]!.text).toBe(describeMultiBound("A", tasks("A", "B")));
  });

  it("不足 2 个任务 / 没有受理任务 → 不写", async () => {
    await noteGroupMultiBound("A", CHAT, tasks("A"), T0);
    await noteGroupMultiBound("A", CHAT, [], T0);
    await noteGroupMultiBound("", CHAT, tasks("A", "B"), T0);
    expect(writeOwnedEventAndPublish).not.toHaveBeenCalled();
  });

  it("同一个群 × 受理任务 × 同伴组合：窗口内只写一条，窗口过了再写", async () => {
    await noteGroupMultiBound("A", CHAT, tasks("A", "B"), T0);
    await noteGroupMultiBound("A", CHAT, tasks("A", "B"), T0 + 1000);
    await noteGroupMultiBound("A", CHAT, tasks("A", "B"), T0 + MULTI_BOUND_NOTICE_WINDOW_MS - 1);
    expect(writeOwnedEventAndPublish).toHaveBeenCalledTimes(1);
    await noteGroupMultiBound("A", CHAT, tasks("A", "B"), T0 + MULTI_BOUND_NOTICE_WINDOW_MS);
    expect(writeOwnedEventAndPublish).toHaveBeenCalledTimes(2);
  });

  it("窗口就是 30 分钟：用字面量钉住数值、不跟着导出常量走（29 分钟内不再写，31 分钟后再写）", async () => {
    await noteGroupMultiBound("A", CHAT, tasks("A", "B"), T0);
    await noteGroupMultiBound("A", CHAT, tasks("A", "B"), T0 + 29 * 60_000);
    expect(writeOwnedEventAndPublish).toHaveBeenCalledTimes(1);
    await noteGroupMultiBound("A", CHAT, tasks("A", "B"), T0 + 31 * 60_000);
    expect(writeOwnedEventAndPublish).toHaveBeenCalledTimes(2);
  });

  it("同伴顺序不同不算新情况（按 id 排序后比较）", async () => {
    await noteGroupMultiBound("A", CHAT, tasks("A", "B", "C"), T0);
    await noteGroupMultiBound("A", CHAT, tasks("C", "A", "B"), T0 + 1000);
    expect(writeOwnedEventAndPublish).toHaveBeenCalledTimes(1);
  });

  it("同伴变了（又多绑了一个）→ 新情况，重新提示", async () => {
    await noteGroupMultiBound("A", CHAT, tasks("A", "B"), T0);
    await noteGroupMultiBound("A", CHAT, tasks("A", "B", "C"), T0 + 1000);
    expect(writeOwnedEventAndPublish).toHaveBeenCalledTimes(2);
    expect(written()[1]!.text).toContain("3 个任务");
  });

  it("受理任务变了（活着的换成了另一个）→ 各记各的，各写各的事件流", async () => {
    await noteGroupMultiBound("A", CHAT, tasks("A", "B"), T0);
    await noteGroupMultiBound("B", CHAT, tasks("A", "B"), T0 + 1000);
    expect(written().map((w) => w.taskId)).toEqual(["A", "B"]);
  });

  it("不同的群互不影响", async () => {
    await noteGroupMultiBound("A", CHAT, tasks("A", "B"), T0);
    await noteGroupMultiBound("A", "oc_another", tasks("A", "B"), T0 + 1000);
    expect(writeOwnedEventAndPublish).toHaveBeenCalledTimes(2);
  });

  it("写事件抛错 → 吞掉（只 warn）；这一组合仍算提示过，窗口内不重试刷屏", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    writeOwnedEventAndPublish.mockImplementationOnce(async () => {
      throw new Error("磁盘满了");
    });
    await expect(noteGroupMultiBound("A", CHAT, tasks("A", "B"), T0)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain("task=A");
    await noteGroupMultiBound("A", CHAT, tasks("A", "B"), T0 + 1000);
    expect(writeOwnedEventAndPublish).toHaveBeenCalledTimes(1);
  });

  it("节流表有条目上限：塞满后清理仍能继续提示新组合", async () => {
    for (let i = 0; i < 250; i += 1) {
      await noteGroupMultiBound("A", `oc_${i}`, tasks("A", "B"), T0 + i);
    }
    expect(writeOwnedEventAndPublish).toHaveBeenCalledTimes(250);
    // 表被清过之后，最早的组合又能提示一次，说明没有无限增长
    await noteGroupMultiBound("A", "oc_0", tasks("A", "B"), T0 + 300);
    expect(writeOwnedEventAndPublish).toHaveBeenCalledTimes(251);
  });
});
