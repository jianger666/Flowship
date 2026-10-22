/**
 * N1-01 / N1-04 / N1-15 回归：MR 收件箱扫描「部分失败」「缓存 TTL vs 轮询」「总 deadline」。
 *
 * 行为级：桩掉 meegle / gitlab / settings 调用，跑**真** scanner（getMrInbox / scanMrInbox）。
 * 由第四轮报告的 scanner-sim 收编（原断言「n2===0 / 全部新增」是缺陷现状，这里翻转成期望）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const sim = vi.hoisted(() => ({
  scheduleFail: false,
  nodeFailIds: new Set<string>(),
  commentFailIds: new Set<string>(),
  wiCount: 3,
  getMrCalls: 0,
  scheduleCalls: 0,
  /** 每次 meegle 调用「花掉」的假时间（配合 vi.setSystemTime 模拟慢 CLI） */
  meegleCostMs: 0,
  onMeegleCall: null as null | (() => void),
}));

vi.mock("@/lib/server/meegle-cli", () => {
  class MeegleError extends Error {
    kind: string;
    constructor(kind: string, m: string) {
      super(m);
      this.kind = kind;
    }
  }
  const cost = () => sim.onMeegleCall?.();
  return {
    MeegleError,
    fetchMyUserKey: async () => "u1",
    meegleAuthStatus: async () => ({ host: "project.example.com" }),
    fetchUserSchedule: async () => {
      sim.scheduleCalls++;
      cost();
      if (sim.scheduleFail) throw new Error("meegle 超时");
      return Array.from({ length: sim.wiCount }, (_, i) => ({
        id: `w${i}`,
        name: `story ${i}`,
      }));
    },
    fetchWorkitemNodes: async (id: string) => {
      cost();
      if (sim.nodeFailIds.has(id)) throw new Error("节点拉取超时");
      return [{ name: "测试", status: "doing" }];
    },
    fetchWorkitemComments: async (id: string) => {
      cost();
      if (sim.commentFailIds.has(id)) throw new Error("评论拉取超时");
      return [
        {
          id: `c${id}`,
          content: `MR https://gitlab.example.com/g/r/-/merge_requests/${id.slice(1)}1`,
          createdAtMs: 1000,
        },
      ];
    },
    queryWorkitemsByMql: async () => ({}),
  };
});
vi.mock("@/lib/server/settings-fs", () => ({
  readSettingsFile: async () => ({
    status: "ok",
    settings: { gitToken: "tok", repos: [{ path: "/x" }], userRole: "qa" },
  }),
}));
vi.mock("@/lib/server/submit-mr-guard", () => ({
  deriveHostFromRepo: async () => "gitlab.example.com",
}));
vi.mock("@/lib/server/trusted-git-host", () => ({
  assertTrustedGitHost: () => {},
}));
vi.mock("@/lib/server/gitlab-client", () => ({
  getMR: async () => {
    sim.getMrCalls++;
    return {
      ok: true,
      iid: 1,
      url: "",
      title: "t",
      description: "",
      state: "opened",
      sourceBranch: "a",
      targetBranch: "b",
      detailedMergeStatus: "mergeable",
      hasConflicts: false,
      mergeable: true,
    };
  },
  mergeMR: async () => ({ ok: true }),
}));

import {
  buildMrInboxPartialMessage,
  diffInboxUnreadForNotify,
  listUnreadInboxItems,
  MR_INBOX_CACHE_TTL_MS,
  MR_INBOX_POLL_INTERVAL_MS,
  MR_INBOX_SCAN_CLIENT_TIMEOUT_MS,
  MR_INBOX_SCAN_DEADLINE_MS,
} from "@/lib/mr-inbox";
import {
  createInboxScanTracker,
  decideInboxScanResult,
  describeScanFetchError,
  formatInboxScanNotice,
  planInboxNotify,
  resolvePartialScan,
} from "@/lib/mr-inbox-state";

type Scanner = typeof import("@/lib/server/mr-inbox-scanner");

const load = async (): Promise<Scanner> => {
  vi.resetModules();
  (globalThis as Record<string, unknown>)["__flowshipMrInbox__"] = undefined;
  return (await import("@/lib/server/mr-inbox-scanner")) as Scanner;
};

type OkResult = Extract<
  Awaited<ReturnType<Scanner["getMrInbox"]>>,
  { status: "ok" }
>;
const asOk = (r: { status: string }): OkResult => {
  expect(r.status).toBe("ok");
  return r as OkResult;
};

/** 复刻 hook 通知 effect 的「未读 key 集合」 */
const unreadKeys = (r: OkResult): Set<string> =>
  new Set(
    listUnreadInboxItems({
      pendingMr: r.pendingMr.map((x) => ({ ...x, seenAtMs: null })),
      myBugs: [],
      pendingRegression: [],
    }).map((i) => i.key),
  );

beforeEach(() => {
  sim.scheduleFail = false;
  sim.nodeFailIds.clear();
  sim.commentFailIds.clear();
  sim.wiCount = 3;
  sim.getMrCalls = 0;
  sim.scheduleCalls = 0;
  sim.meegleCostMs = 0;
  sim.onMeegleCall = null;
  vi.useRealTimers();
});

describe("N1-01：扫描中途单步失败 ≠ 成功", () => {
  it("排期拉取失败：返回 partial（不是空 ok），且不缓存——下一轮不会读到空表", async () => {
    const m = await load();
    const r1 = asOk(await m.getMrInbox({ refresh: true }));
    expect(r1.pendingMr).toHaveLength(3);
    expect(r1.partial).toBeUndefined();

    sim.scheduleFail = true;
    const r2 = asOk(await m.getMrInbox({ refresh: true }));
    expect(r2.partial).toBe(true);
    expect(r2.partialMessage).toContain("排期拉取失败");
    // N1-01 粒度：服务端不再偷换成旧缓存——返回本轮真实扫到的部分（这里是 0 条）+ 没扫到的范围，
    // 旧表由客户端持有（保留旧表 / 连续同类失败后合并展示）；旧缓存本身仍在，不被残表覆盖
    expect(r2.pendingMr).toHaveLength(0);
    expect(r2.incomplete?.kinds).toEqual(["schedule"]);
    expect(r2.incomplete?.scheduleProjectKeys?.length).toBe(1);

    // 恢复后：不会被缓存的空表挡住（refresh=false 也要真扫，因为 partial 没落缓存）
    sim.scheduleFail = false;
    sim.scheduleCalls = 0;
    const r3 = asOk(await m.getMrInbox());
    // r1 的缓存仍新鲜 → 命中缓存（旧完整表），而不是 partial 的残表
    expect(r3.partial).toBeUndefined();
    expect(r3.pendingMr).toHaveLength(3);
  });

  it("没有旧缓存时的 partial：返回已扫到的部分 + partial 标记，仍不落缓存", async () => {
    const m = await load();
    sim.commentFailIds.add("w1");
    const r1 = asOk(await m.getMrInbox());
    expect(r1.partial).toBe(true);
    expect(r1.pendingMr).toHaveLength(2); // w1 的 MR 本轮缺失
    expect(r1.partialMessage).toContain("w1");

    // 恢复后下一次普通请求必须真扫（没有缓存可命中）
    sim.commentFailIds.clear();
    sim.scheduleCalls = 0;
    const r2 = asOk(await m.getMrInbox());
    expect(sim.scheduleCalls).toBe(1);
    expect(r2.partial).toBeUndefined();
    expect(r2.pendingMr).toHaveLength(3);
  });

  it("节点拉取失败同样算 partial", async () => {
    const m = await load();
    sim.nodeFailIds.add("w0");
    const r = asOk(await m.getMrInbox({ refresh: true }));
    expect(r.partial).toBe(true);
    expect(r.partialMessage).toContain("节点拉取失败");
  });

  it("端到端：失败一轮 + 恢复一轮，客户端口径下不会重复『新增』通知", async () => {
    const m = await load();
    const r1 = asOk(await m.getMrInbox({ refresh: true }));
    let prevData: {
      status: string;
      pendingMr: { mrUrl: string }[];
      myBugs: { bugUrl: string }[];
      pendingRegression: { bugUrl: string }[];
      partial?: boolean;
    } = { ...r1, partial: undefined };
    // 客户端基线 = 第一轮完整结果
    let baseline = unreadKeys(r1);

    // 第二轮：排期失败（旧行为：status ok + 空表 → 基线被清空）
    sim.scheduleFail = true;
    const r2 = asOk(await m.getMrInbox({ refresh: true }));
    expect(r2.partial).toBe(true);
    const outcome = resolvePartialScan(prevData, { ...r2 }, r2.partialMessage ?? "");
    expect(outcome.data).toBe(prevData); // 保留旧表
    expect(outcome.scanError).toContain("排期拉取失败");
    prevData = outcome.data;
    // 旧表没变 → 通知 effect 不会重新计算基线
    expect(unreadKeys(prevData as unknown as OkResult)).toEqual(baseline);

    // 第三轮：恢复
    sim.scheduleFail = false;
    const r3 = asOk(await m.getMrInbox({ refresh: true }));
    expect(r3.partial).toBeUndefined();
    const d3 = diffInboxUnreadForNotify(baseline, [
      ...listUnreadInboxItems({
        pendingMr: r3.pendingMr.map((x) => ({ ...x, seenAtMs: null })),
        myBugs: [],
        pendingRegression: [],
      }),
    ]);
    expect(d3.notify).toBe(false);
    expect(d3.newItems).toHaveLength(0);
    baseline = unreadKeys(r3);
  });

  it("反例（旧树能用的情形仍能用）：全部成功 → 无 partial、正常缓存", async () => {
    const m = await load();
    const r1 = asOk(await m.getMrInbox());
    expect(r1.partial).toBeUndefined();
    expect(r1.partialMessage).toBeUndefined();
    sim.scheduleCalls = 0;
    const r2 = asOk(await m.getMrInbox());
    expect(sim.scheduleCalls).toBe(0); // 命中缓存
    expect(r2.pendingMr).toHaveLength(3);
  });
});

describe("resolvePartialScan（客户端纯函数）", () => {
  interface Shape {
    status: string;
    pendingMr: { mrUrl: string }[];
    myBugs: { bugUrl: string }[];
    pendingRegression: { bugUrl: string }[];
    partial?: boolean;
  }
  const ok = (n: number, extra: Partial<Shape> = {}): Shape => ({
    status: "ok",
    pendingMr: Array.from({ length: n }, (_, i) => ({ mrUrl: `u${i}` })),
    myBugs: [],
    pendingRegression: [],
    ...extra,
  });

  it("已有成功旧表：原样保留旧表 + 错误文案", () => {
    const prev = ok(3);
    const out = resolvePartialScan(prev, ok(0), "排期拉取失败");
    expect(out.data).toBe(prev);
    expect(out.scanError).toBe("排期拉取失败");
  });

  it("首拉没有旧表：展示已扫到的部分，但带 partial 标记（通知 effect 据此不建基线）", () => {
    const out = resolvePartialScan(null, ok(2), "");
    expect(out.data.pendingMr).toHaveLength(2);
    expect(out.data.partial).toBe(true);
    expect(out.scanError.length).toBeGreaterThan(0);
  });

  it("旧表本身是 partial（首拉残表）：被新一轮结果替换，而不是继续保留残表", () => {
    const prev = ok(1, { partial: true });
    const out = resolvePartialScan(prev, ok(2), "x");
    expect(out.data.pendingMr).toHaveLength(2);
  });

  it("旧表是降级态（error）：不保留", () => {
    const prev = { ...ok(0), status: "error" };
    const out = resolvePartialScan(prev, ok(2), "x");
    expect(out.data.pendingMr).toHaveLength(2);
  });
});

describe("N1-04：缓存 TTL 与轮询间隔", () => {
  it("不变量：TTL < 轮询间隔（否则扫描耗时 S>0 就会让每次轮询命中缓存）", () => {
    expect(MR_INBOX_CACHE_TTL_MS).toBeLessThan(MR_INBOX_POLL_INTERVAL_MS);
    // 余量要盖住服务端扫描总时限：任何没超时的扫描（耗时 S ≤ 总时限）都不会让下一次轮询命中缓存
    expect(MR_INBOX_POLL_INTERVAL_MS - MR_INBOX_CACHE_TTL_MS).toBeGreaterThanOrEqual(
      MR_INBOX_SCAN_DEADLINE_MS,
    );
  });

  it("行为：扫描耗时 35s 时，连续 4 个轮询周期每次都是真扫", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const m = await load();
    // 每次 meegle 调用花 5s 假时间（排期 1 + 节点 3 + 评论 3 = 7 次 ≈ 35s 扫描耗时）
    sim.onMeegleCall = () => {
      vi.setSystemTime(Date.now() + 5_000);
    };
    const t0 = Date.now();
    await m.getMrInbox(); // 首拉
    const scansAfterFirst = sim.scheduleCalls;
    expect(scansAfterFirst).toBe(1);
    const real: number[] = [];
    for (let k = 1; k <= 4; k++) {
      const before = sim.scheduleCalls;
      // 下一次轮询在「首次请求发起时刻」+ k * POLL（客户端 setInterval）
      vi.setSystemTime(t0 + k * MR_INBOX_POLL_INTERVAL_MS);
      await m.getMrInbox(); // 轮询：非 force
      real.push(sim.scheduleCalls - before);
    }
    expect(real).toEqual([1, 1, 1, 1]);
  });
});

describe("N1-15：服务端总 deadline + 客户端超时", () => {
  it("不变量：服务端总时限 < 客户端超时；时限 + 一次 CLI 超时(30s) 仍在客户端超时内", () => {
    expect(MR_INBOX_SCAN_DEADLINE_MS).toBeLessThan(MR_INBOX_SCAN_CLIENT_TIMEOUT_MS);
    expect(MR_INBOX_SCAN_DEADLINE_MS + 30_000).toBeLessThan(
      MR_INBOX_SCAN_CLIENT_TIMEOUT_MS,
    );
  });

  it("meegle 一个个卡 30s：超过总时限后停止继续扫，返回已扫到的部分 + partial", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    sim.wiCount = 20;
    sim.onMeegleCall = () => {
      vi.setSystemTime(Date.now() + 30_000); // 每次调用耗满 30s
    };
    const m = await load();
    const t0 = Date.now();
    const r = asOk(await m.getMrInbox({ refresh: true }));
    const elapsed = Date.now() - t0;
    expect(r.partial).toBe(true);
    expect(r.partialMessage).toContain("总时限");
    // 不会把 20 个工作项 × 2 次都串行跑完（≈1230s）；只跑到时限 + 至多一次在途调用
    expect(elapsed).toBeLessThan(MR_INBOX_SCAN_DEADLINE_MS + 30_000 + 1);
    // 超时的残表同样不缓存
    sim.onMeegleCall = null;
    sim.scheduleCalls = 0;
    const r2 = asOk(await m.getMrInbox());
    expect(sim.scheduleCalls).toBe(1);
    expect(r2.partial).toBeUndefined();
  });

  it("describeScanFetchError：超时 / 中止统一叫「扫描超时」，其它保留原文", () => {
    const timeout = new DOMException("signal timed out", "TimeoutError");
    const abort = new DOMException("aborted", "AbortError");
    expect(describeScanFetchError(timeout)).toBe("扫描超时");
    expect(describeScanFetchError(abort)).toBe("扫描超时");
    expect(describeScanFetchError(new Error("Failed to fetch"))).toBe(
      "Failed to fetch",
    );
    expect(describeScanFetchError("boom")).toBe("boom");
  });

  it("buildMrInboxPartialMessage：列前 3 条、超出标总数", () => {
    expect(buildMrInboxPartialMessage([])).toBe("");
    expect(buildMrInboxPartialMessage(["a"])).toContain("a");
    const many = buildMrInboxPartialMessage(["a", "b", "c", "d", "e"]);
    expect(many).toContain("a；b；c");
    expect(many).not.toContain("d");
    expect(many).toContain("5 处");
  });
});

describe("N1-01 粒度（端到端）：真 scanner 的永久性失败 → 真决策，列表不再冻结", () => {
  interface ClientData {
    status: string;
    pendingMr: Array<{
      mrUrl: string;
      workItemId: string;
      projectKey: string;
      workItemName: string;
      mr: { title: string } | null;
      seenAtMs: number | null;
    }>;
    myBugs: Array<{ bugUrl: string; projectKey: string; name: string; seenAtMs: number | null }>;
    pendingRegression: Array<{ bugUrl: string; projectKey: string; name: string; seenAtMs: number | null }>;
    scannedAt?: number;
    partial?: boolean;
  }
  const toClient = (r: OkResult): ClientData => ({
    status: "ok",
    pendingMr: r.pendingMr.map((x) => ({ ...x, seenAtMs: null })),
    myBugs: r.myBugs.map((x) => ({ ...x, seenAtMs: null })),
    pendingRegression: r.pendingRegression.map((x) => ({ ...x, seenAtMs: null })),
    scannedAt: r.scannedAt,
  });

  it("w1 评论永久拉不到：第 2 轮起合并展示，新增的 MR 能出现并通知；旧条目不被当新增；恢复后回到全量差分", async () => {
    const m = await load();
    let tracker = createInboxScanTracker();
    let current: ClientData | null = null;
    let keys: Set<string> | null = null;
    const notified: string[] = [];
    const round = async () => {
      const r = asOk(await m.getMrInbox({ refresh: true }));
      const d = decideInboxScanResult<ClientData>({
        prev: current,
        fresh: toClient(r),
        partial: r.partial === true,
        partialMessage: r.partialMessage,
        incomplete: r.incomplete,
        tracker,
      });
      tracker = d.tracker;
      if (d.data !== current) {
        current = d.data;
        const plan = planInboxNotify({ data: current, prevKeys: keys, windowFocused: false });
        keys = plan.nextKeys;
        if (plan.copy) notified.push(plan.copy.title);
      }
      return { r, d };
    };

    // 第 0 轮：完整（w0 w1 w2 → 3 条），建基线
    const first = await round();
    expect(first.d.notice).toBeNull();
    expect(current!.pendingMr).toHaveLength(3);

    // 之后 w1 评论永久失败；同时 w3 出现了新的待测 MR
    sim.commentFailIds.add("w1");
    sim.wiCount = 4;

    const r1 = await round(); // 第 1 轮：保留旧表
    expect(r1.r.partial).toBe(true);
    expect(r1.r.incomplete?.kinds).toEqual(["comments"]);
    expect(r1.r.incomplete?.workItemIds).toEqual(["w1"]);
    expect(r1.d.notice?.kind).toBe("kept-old");
    expect(current!.pendingMr).toHaveLength(3); // 冻结
    expect(notified).toHaveLength(0);

    const r2 = await round(); // 第 2 轮：合并
    expect(r2.d.notice?.kind).toBe("merged");
    expect(current!.pendingMr.map((x) => x.workItemId).sort()).toEqual(["w0", "w1", "w2", "w3"]);
    expect(notified).toHaveLength(1); // 只通知 w3 的新 MR
    const text = formatInboxScanNotice(r2.d.notice!);
    expect(text).toContain("已连续 2 轮");
    expect(text).toContain("列表停在");

    await round(); // 第 3 轮：不重复通知
    expect(notified).toHaveLength(1);
    expect(current!.pendingMr).toHaveLength(4);

    // 恢复
    sim.commentFailIds.clear();
    const ok = await round();
    expect(ok.r.partial).toBeUndefined();
    expect(ok.d.notice).toBeNull();
    expect(tracker.partialStreak).toBe(0);
    expect(current!.pendingMr).toHaveLength(4);
    expect(notified).toHaveLength(1); // 恢复也不重复
  });

  it("scanner 为各类失败产出正确的范围：排期 / 节点 / 评论 / 总时限", async () => {
    let m = await load();
    sim.scheduleFail = true;
    let r = asOk(await m.getMrInbox({ refresh: true }));
    expect(r.incomplete?.kinds).toEqual(["schedule"]);
    expect(r.incomplete?.scheduleProjectKeys).toHaveLength(1);
    expect(r.incomplete?.all).toBeUndefined();

    sim.scheduleFail = false;
    sim.nodeFailIds.add("w2");
    m = await load();
    r = asOk(await m.getMrInbox({ refresh: true }));
    expect(r.incomplete?.kinds).toEqual(["nodes"]);
    expect(r.incomplete?.workItemIds).toEqual(["w2"]);

    sim.nodeFailIds.clear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    sim.wiCount = 20;
    sim.onMeegleCall = () => vi.setSystemTime(Date.now() + 30_000);
    m = await load();
    r = asOk(await m.getMrInbox({ refresh: true }));
    expect(r.incomplete?.kinds).toContain("deadline");
    expect(r.incomplete?.all).toBe(true);
  });

  it("反例：完整扫描没有 incomplete 字段、行为不变", async () => {
    const m = await load();
    const r = asOk(await m.getMrInbox({ refresh: true }));
    expect(r.partial).toBeUndefined();
    expect(r.incomplete).toBeUndefined();
  });
});
