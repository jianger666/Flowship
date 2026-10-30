/**
 * 群 → 任务反查：一个群绑了多个任务时挑谁受理（B4-4 / Q12b-02 的路由部分）
 *
 * 原来：扫描时谁的 updatedAt 最新就进谁，缓存 10 分钟；用户在 A 里干活（bump A）后群消息串到 A，
 * 两个任务的界面都显示「已绑定」。现在：同群有多个任务时，正在运行 / 等用户回答的优先，同档仍取 updatedAt 最新；
 * 同群任务一起返回（给属主留提示用）；多任务共绑时命中缓存缩到 1 分钟（谁在忙会变）。
 *
 * 同伴只在「读它不用打网络」的范围里找（本地关联了这个群的任务）：回流链每条群消息都走路由，不为凑同伴多打 meegle——
 * 用调用计数钉住这一点。外部依赖全用假的（listTasks / getTask / getBoundGroupChatId）。
 */
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Task, TaskSummary } from "@/lib/types";

process.env.FLOWSHIP_DATA_DIR = path.join(
  os.tmpdir(),
  `group-route-multi-bound-${Date.now()}`,
  "data",
);

const {
  __resetGroupChatCacheForTest,
  __setGroupRouteDepsForTest,
  resolveGroupRoute,
  resolveTaskIdByGroupChat,
} = await import("@/lib/server/feishu-bridge/group-route");

const CHAT = "oc_shared";
const STORY = "https://project.feishu.cn/space/story/detail/10001";
const T0 = new Date("2026-10-25T08:00:00Z").getTime();

type Spec = {
  id: string;
  updatedAt: number;
  /** 本地关联的群（undefined = 只靠工作项链接 / 项目群默认） */
  local?: string;
  /** getBoundGroupChatId 对它返回什么（缺省 = 本地关联，没有本地关联就是 CHAT 即项目群默认） */
  bound?: string | null;
  runStatus?: TaskSummary["runStatus"];
  hasPendingAsk?: boolean;
  archived?: boolean;
};

let specs: Spec[] = [];
let listTasks: ReturnType<typeof vi.fn>;
let getBound: ReturnType<typeof vi.fn>;

const summaryOf = (s: Spec): TaskSummary =>
  ({
    id: s.id,
    title: `任务 ${s.id}`,
    mode: "task",
    repoStatus: "developing",
    runStatus: s.runStatus ?? "idle",
    updatedAt: s.updatedAt,
    createdAt: s.updatedAt,
    repoPaths: ["/tmp/repo"],
    currentActionId: null,
    mrs: [],
    actionCount: 0,
    feishuStoryUrl: STORY,
    ...(s.local ? { feishuGroupChatId: s.local } : {}),
    ...(s.hasPendingAsk ? { hasPendingAsk: true } : {}),
    ...(s.archived ? { archived: true } : {}),
  }) as TaskSummary;

const boundOf = (id: string): string | null => {
  const s = specs.find((x) => x.id === id);
  if (!s) return null;
  if (s.bound !== undefined) return s.bound;
  return s.local ?? CHAT;
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  __resetGroupChatCacheForTest();
  specs = [];
  listTasks = vi.fn(async () => specs.map(summaryOf));
  getBound = vi.fn(async (t: { id: string }) => boundOf(t.id));
  __setGroupRouteDepsForTest({
    listTasks,
    getTask: async (id: string) => {
      const s = specs.find((x) => x.id === id);
      return s ? ({ ...summaryOf(s), events: [], actions: [] } as unknown as Task) : null;
    },
    getBoundGroupChatId: getBound,
  } as never);
});

afterEach(() => {
  __setGroupRouteDepsForTest(null);
  __resetGroupChatCacheForTest();
  vi.useRealTimers();
});

const boundCallsFor = (id: string): number =>
  getBound.mock.calls.filter((c) => (c[0] as { id: string }).id === id).length;

describe("单个任务绑这个群：行为不变", () => {
  it("返回它，coBound 为空", async () => {
    specs = [{ id: "A", updatedAt: T0, local: CHAT }];
    expect(await resolveGroupRoute(CHAT)).toEqual({ taskId: "A", coBound: [] });
  });

  it("没有任务绑这个群 → null（照旧）", async () => {
    specs = [{ id: "A", updatedAt: T0, local: "oc_other" }];
    expect(await resolveGroupRoute(CHAT)).toBeNull();
    expect(await resolveTaskIdByGroupChat(CHAT)).toBeNull();
  });

  it("空 chatId → null，不扫描", async () => {
    expect(await resolveGroupRoute("")).toBeNull();
    expect(listTasks).not.toHaveBeenCalled();
  });

  it("命中缓存 10 分钟：期间不重新列任务；过了才重扫", async () => {
    specs = [{ id: "A", updatedAt: T0, local: CHAT }];
    await resolveGroupRoute(CHAT);
    vi.setSystemTime(T0 + 9 * 60_000);
    await resolveGroupRoute(CHAT);
    expect(listTasks).toHaveBeenCalledTimes(1);
    vi.setSystemTime(T0 + 10 * 60_000 + 1);
    await resolveGroupRoute(CHAT);
    expect(listTasks).toHaveBeenCalledTimes(2);
  });
});

describe("同一个群绑了多个任务：活着的优先，同档取最近更新", () => {
  it("两个都空闲 → 仍是 updatedAt 最新的（与原来的口径一致），coBound 带上两个", async () => {
    specs = [
      { id: "old", updatedAt: T0 - 5000, local: CHAT },
      { id: "new", updatedAt: T0, local: CHAT },
    ];
    const route = await resolveGroupRoute(CHAT);
    expect(route?.taskId).toBe("new");
    expect(route?.coBound.map((t) => t.id)).toEqual(["new", "old"]);
    expect(route?.coBound[0]).toEqual({ id: "new", title: "任务 new" });
  });

  it("较旧的那个有待回答的提问 → 群消息进它，而不是 updatedAt 最新的空闲任务", async () => {
    specs = [
      { id: "old", updatedAt: T0 - 5000, local: CHAT, hasPendingAsk: true },
      { id: "new", updatedAt: T0, local: CHAT },
    ];
    expect((await resolveGroupRoute(CHAT))?.taskId).toBe("old");
  });

  it("较旧的那个正在运行 / 等用户回答 → 同样进它", async () => {
    for (const runStatus of ["running", "awaiting_user"] as const) {
      __resetGroupChatCacheForTest();
      specs = [
        { id: "old", updatedAt: T0 - 5000, local: CHAT, runStatus },
        { id: "new", updatedAt: T0, local: CHAT },
      ];
      expect((await resolveGroupRoute(CHAT))?.taskId, runStatus).toBe("old");
    }
  });

  it("两个都活着 → 其中最近更新的", async () => {
    specs = [
      { id: "old", updatedAt: T0 - 5000, local: CHAT, runStatus: "running" },
      { id: "new", updatedAt: T0, local: CHAT, runStatus: "running" },
    ];
    expect((await resolveGroupRoute(CHAT))?.taskId).toBe("new");
  });

  it("resolveTaskIdByGroupChat 与 resolveGroupRoute 挑的是同一个", async () => {
    specs = [
      { id: "old", updatedAt: T0 - 5000, local: CHAT, runStatus: "running" },
      { id: "new", updatedAt: T0, local: CHAT },
    ];
    expect(await resolveTaskIdByGroupChat(CHAT)).toBe("old");
  });

  it("归档的同伴不参与（它退出了群回流）", async () => {
    specs = [
      { id: "new", updatedAt: T0, local: CHAT },
      { id: "arch", updatedAt: T0 - 1000, local: CHAT, runStatus: "running", archived: true },
    ];
    expect(await resolveGroupRoute(CHAT)).toEqual({ taskId: "new", coBound: [] });
  });

  it("这个群的同伴不会影响别的群：别的群的任务不进 coBound", async () => {
    specs = [
      { id: "A", updatedAt: T0, local: CHAT },
      { id: "B", updatedAt: T0 - 1000, local: "oc_other", runStatus: "running" },
    ];
    expect(await resolveGroupRoute(CHAT)).toEqual({ taskId: "A", coBound: [] });
  });
});

describe("找同伴不额外打网络：只看本地关联了这个群的任务", () => {
  it("较新的只靠项目群默认、较旧的本地关联且在跑 → 找得到它，挑它", async () => {
    specs = [
      { id: "pd", updatedAt: T0, bound: CHAT }, // 无本地关联，群来自项目群默认
      { id: "loc", updatedAt: T0 - 1000, local: CHAT, runStatus: "running" },
    ];
    const route = await resolveGroupRoute(CHAT);
    expect(route?.taskId).toBe("loc");
    expect(route?.coBound.map((t) => t.id)).toEqual(["pd", "loc"]);
  });

  it("较新的本地关联、较旧的只靠项目群默认（哪怕它在跑）→ 不会为它去读绑定：已知缺口", async () => {
    specs = [
      { id: "loc", updatedAt: T0, local: CHAT },
      { id: "pd", updatedAt: T0 - 1000, bound: CHAT, runStatus: "running" },
    ];
    const route = await resolveGroupRoute(CHAT);
    expect(route).toEqual({ taskId: "loc", coBound: [] });
    // 命中之后的没有本地关联的候选一次绑定读取都没有（读它要打 meegle）
    expect(boundCallsFor("pd")).toBe(0);
  });

  it("命中的是第 1 个时，后面本地关联的候选各读一次（零 IO 路径），没本地关联的不读", async () => {
    specs = [
      { id: "first", updatedAt: T0, local: CHAT },
      { id: "p1", updatedAt: T0 - 1, local: "oc_other" },
      { id: "p2", updatedAt: T0 - 2, bound: "oc_whatever" },
      { id: "p3", updatedAt: T0 - 3, local: CHAT },
    ];
    await resolveGroupRoute(CHAT);
    expect(boundCallsFor("first")).toBe(1);
    expect(boundCallsFor("p1")).toBe(1);
    expect(boundCallsFor("p2")).toBe(0);
    expect(boundCallsFor("p3")).toBe(1);
  });

  it("同伴的绑定读取抛错 → 当没有这个同伴，主路径照常返回", async () => {
    specs = [
      { id: "first", updatedAt: T0, local: CHAT },
      { id: "flaky", updatedAt: T0 - 1, local: CHAT, runStatus: "running" },
    ];
    getBound.mockImplementation(async (t: { id: string }) => {
      if (t.id === "flaky") throw new Error("磁盘抖了一下");
      return boundOf(t.id);
    });
    expect(await resolveGroupRoute(CHAT)).toEqual({ taskId: "first", coBound: [] });
  });
});

describe("缓存：多任务共绑时缩到 1 分钟，单任务仍是 10 分钟", () => {
  const twoTasks = (): Spec[] => [
    { id: "A", updatedAt: T0, local: CHAT },
    { id: "B", updatedAt: T0 - 1000, local: CHAT },
  ];

  it("1 分钟内不重扫；超过 1 分钟重扫，并按此刻谁在忙重新挑", async () => {
    specs = twoTasks();
    expect((await resolveGroupRoute(CHAT))?.taskId).toBe("A");
    // B 开始跑了，但缓存期内还是沿用上一次的挑选
    specs = [
      { id: "A", updatedAt: T0, local: CHAT },
      { id: "B", updatedAt: T0 - 1000, local: CHAT, runStatus: "running" },
    ];
    vi.setSystemTime(T0 + 59_000);
    expect((await resolveGroupRoute(CHAT))?.taskId).toBe("A");
    expect(listTasks).toHaveBeenCalledTimes(1);
    vi.setSystemTime(T0 + 61_000);
    const route = await resolveGroupRoute(CHAT);
    expect(listTasks).toHaveBeenCalledTimes(2);
    expect(route?.taskId).toBe("B");
  });

  it("缓存期内命中也带着同伴列表（给属主留提示用）", async () => {
    specs = twoTasks();
    await resolveGroupRoute(CHAT);
    vi.setSystemTime(T0 + 30_000);
    const again = await resolveGroupRoute(CHAT);
    expect(again?.coBound.map((t) => t.id)).toEqual(["A", "B"]);
    expect(listTasks).toHaveBeenCalledTimes(1);
  });

  it("命中缓存时仍校验受理任务还绑着这个群：被换绑走了就重新扫描", async () => {
    specs = twoTasks();
    expect((await resolveGroupRoute(CHAT))?.taskId).toBe("A");
    specs = [
      { id: "A", updatedAt: T0, local: "oc_moved" },
      { id: "B", updatedAt: T0 - 1000, local: CHAT },
    ];
    vi.setSystemTime(T0 + 10_000);
    expect(await resolveGroupRoute(CHAT)).toEqual({ taskId: "B", coBound: [] });
    expect(listTasks).toHaveBeenCalledTimes(2);
  });

  it("多任务共绑变回单任务后，缓存回到 10 分钟口径", async () => {
    specs = twoTasks();
    await resolveGroupRoute(CHAT);
    specs = [{ id: "A", updatedAt: T0, local: CHAT }];
    vi.setSystemTime(T0 + 61_000);
    expect(await resolveGroupRoute(CHAT)).toEqual({ taskId: "A", coBound: [] });
    expect(listTasks).toHaveBeenCalledTimes(2);
    vi.setSystemTime(T0 + 61_000 + 9 * 60_000);
    await resolveGroupRoute(CHAT);
    expect(listTasks).toHaveBeenCalledTimes(2);
  });
});

// 复用文件里已有的 specs / listTasks / CHAT / T0 / resolveGroupRoute / resolveTaskIdByGroupChat

describe("缓存存的是「挑出来的」那个，而不是扫描时第一个命中的", () => {
  it("较旧的那个有待回答的提问：首条进它；缓存期内再来一条仍进它（同伴列表也在，且没有重扫）", async () => {
    specs = [
      { id: "A", updatedAt: T0, local: CHAT }, // updatedAt 最新、空闲
      { id: "B", updatedAt: T0 - 1000, local: CHAT, hasPendingAsk: true }, // 较旧、在等用户回答
    ];
    expect((await resolveGroupRoute(CHAT))?.taskId).toBe("B");
    vi.setSystemTime(T0 + 30_000);
    const again = await resolveGroupRoute(CHAT);
    expect(again?.taskId).toBe("B");
    expect(again?.coBound.map((t) => t.id)).toEqual(["A", "B"]);
    expect(listTasks).toHaveBeenCalledTimes(1);
    // resolveTaskIdByGroupChat 走同一份缓存，同样是 B
    expect(await resolveTaskIdByGroupChat(CHAT)).toBe("B");
  });

  it("三个任务共绑：第一个空闲、后两个都在忙 → 进后两个里更新的那个（同伴按 updatedAt 倒序，第一个活着的就是最近的）", async () => {
    specs = [
      { id: "A", updatedAt: T0, local: CHAT }, // 最新、空闲
      { id: "B", updatedAt: T0 - 1000, local: CHAT, runStatus: "running" },
      { id: "C", updatedAt: T0 - 2000, local: CHAT, runStatus: "running" }, // 更旧
    ];
    expect((await resolveGroupRoute(CHAT))?.taskId).toBe("B");
  });
});
