/**
 * Q10-03 回归：MR 收件箱扫描后半段（逐 MR 拉详情 / 逐 bug 拉评论补 MR）的并发上限 + 总时限。
 *
 * 以前：getMR 对全部候选 `Promise.all`（mock 复跑并发峰值 60），逐 bug 拉评论也一口气塞满 meegle 的串行队列；
 * 这两段完全不看总 deadline——deadline 设 800ms 实际跑了 2578ms 且 `partial=false`。
 *
 * 行为级：桩掉 meegle / gitlab / settings，跑**真** scanner（getMrInbox）与真并发池。
 * 「卡住」用手动放行的挂起请求模拟（而不是睡很久再量毫秒）：能返回本身就证明没等在途请求，机器再忙也不抖。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sim = vi.hoisted(() => ({
  /** 覆盖 MR_INBOX_SCAN_DEADLINE_MS（下面 mock 的 getter 读它） */
  deadlineMs: 50_000,
  /** 待测 story 评论里的 MR 数 */
  mrCount: 0,
  /** 待回归 bug 数 */
  bugCount: 0,
  gitToken: "tok",

  /** getMR：第 n 次调用起（n > gateAfter）挂起、直到 gates 被放行；Infinity = 从不挂起 */
  getMrGateAfter: Number.POSITIVE_INFINITY,
  getMrDelayMs: 0,
  mrCalls: 0,
  mrInFlight: 0,
  mrPeak: 0,

  /** 逐 bug 拉评论：同上（story 的评论不计入） */
  bugCommentGateAfter: Number.POSITIVE_INFINITY,
  bugCommentDelayMs: 0,
  bugCommentCalls: 0,
  bugCommentInFlight: 0,
  bugCommentPeak: 0,

  /** story 评论拉取时回调（配合 vi.setSystemTime 模拟「前半段拖过总时限」） */
  onStoryComment: null as null | (() => void),
  gates: [] as Array<() => void>,
}));

vi.mock("@/lib/mr-inbox", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/mr-inbox")>()),
  get MR_INBOX_SCAN_DEADLINE_MS() {
    return sim.deadlineMs;
  },
}));

vi.mock("@/lib/server/meegle-cli", () => {
  class MeegleError extends Error {
    kind: string;
    constructor(kind: string, m: string) {
      super(m);
      this.kind = kind;
    }
  }
  const wait = async (ms: number) => {
    if (ms > 0) await new Promise<void>((r) => setTimeout(r, ms));
  };
  return {
    MeegleError,
    fetchMyUserKey: async () => "u1",
    meegleAuthStatus: async () => ({ host: "project.example.com" }),
    fetchUserSchedule: async () => [{ id: "w0", name: "story" }],
    fetchWorkitemNodes: async () => [{ name: "测试", status: "doing" }],
    fetchWorkitemComments: async (id: string) => {
      if (id === "w0") {
        sim.onStoryComment?.();
        return [
          {
            id: "c-story",
            content: Array.from(
              { length: sim.mrCount },
              (_, i) => `https://gitlab.example.com/g/r/-/merge_requests/${i + 1}`,
            ).join(" "),
            createdAtMs: 1000,
          },
        ];
      }
      const n = ++sim.bugCommentCalls;
      sim.bugCommentInFlight += 1;
      sim.bugCommentPeak = Math.max(sim.bugCommentPeak, sim.bugCommentInFlight);
      try {
        if (n > sim.bugCommentGateAfter) {
          await new Promise<void>((resolve) => sim.gates.push(resolve));
        } else {
          await wait(sim.bugCommentDelayMs);
        }
      } finally {
        sim.bugCommentInFlight -= 1;
      }
      return [
        {
          id: `c-${id}`,
          content: `请合 https://gitlab.example.com/g/r/-/merge_requests/${1000 + Number(id)}`,
          createdAtMs: 2000,
        },
      ];
    },
    queryWorkitemsByMql: async (_projectKey: string, mql: string) => {
      // 只有「报告人」查询（待回归）有 bug；「经办人」（我的 BUG）空
      if (!mql.includes("`__报告人`")) return {};
      const rows = Array.from({ length: sim.bugCount }, (_, i) =>
        bugRow(i + 1, `bug ${i + 1}`, "RESOLVED"),
      );
      return { data: { g: rows } };
    },
  };
});

/** 真实 CLI 形状（value 按 value_type 包一层同名壳）的一条 bug 行 */
function bugRow(id: number, name: string, status: string) {
  return {
    moql_field_list: [
      { key: "name", name: "名称", value: { string_value: name }, value_type: "string_value" },
      { key: "work_item_id", name: "工作项id", value: { long_value: id }, value_type: "long_value" },
      {
        key: "work_item_status",
        name: "状态",
        value: { key_label_value_list: [{ key: status, label: status }] },
        value_type: "key_label_value_list",
      },
    ],
  };
}

vi.mock("@/lib/server/settings-fs", () => ({
  readSettingsFile: async () => ({
    status: "ok",
    settings: { gitToken: sim.gitToken, repos: [{ path: "/x" }], userRole: "qa" },
  }),
}));
vi.mock("@/lib/server/submit-mr-guard", () => ({
  deriveHostFromRepo: async () => "gitlab.example.com",
}));
vi.mock("@/lib/server/trusted-git-host", () => ({
  assertTrustedGitHost: () => {},
}));
vi.mock("@/lib/server/gitlab-client", () => ({
  getMR: async ({ iid }: { iid: number }) => {
    const n = ++sim.mrCalls;
    sim.mrInFlight += 1;
    sim.mrPeak = Math.max(sim.mrPeak, sim.mrInFlight);
    try {
      if (n > sim.getMrGateAfter) {
        await new Promise<void>((resolve) => sim.gates.push(resolve));
      } else if (sim.getMrDelayMs > 0) {
        await new Promise<void>((r) => setTimeout(r, sim.getMrDelayMs));
      }
    } finally {
      sim.mrInFlight -= 1;
    }
    return {
      ok: true,
      iid,
      url: `https://gitlab.example.com/g/r/-/merge_requests/${iid}`,
      title: `mr ${iid}`,
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

import { MR_INBOX_FETCH_CONCURRENCY } from "@/lib/mr-inbox";

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

/**
 * 真实时钟：ms 内没落定就失败并说清原因——比等 vitest 的 5 秒超时好：
 * vitest 的超时在 JSON / 部分 reporter 里只剩一个占位栈（Error: STACK_TRACE_ERROR），看不出是谁卡住了。
 */
const settled = async <T>(p: Promise<T>, what: string, ms = 4000): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stuck = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${what}：${ms}ms 内没有返回（在等不该等的东西：定时器 / 在途任务）`)),
      ms,
    );
  });
  try {
    return await Promise.race([p, stuck]);
  } finally {
    clearTimeout(timer);
  }
};

/**
 * 假时钟下（setTimeout 被接管，上面的兜底不可用）：不推进时间、只让出足够多轮微任务，看 promise 是否已落定。
 * 「在等定时器才肯返回」的实现会得到 false。
 */
const settlesWithoutTime = async (p: Promise<unknown>): Promise<boolean> => {
  let done = false;
  p.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );
  for (let i = 0; i < 3000; i += 1) await Promise.resolve();
  return done;
};

const LIMIT = MR_INBOX_FETCH_CONCURRENCY;

beforeEach(() => {
  sim.deadlineMs = 50_000;
  sim.mrCount = 0;
  sim.bugCount = 0;
  sim.gitToken = "tok";
  sim.getMrGateAfter = Number.POSITIVE_INFINITY;
  sim.getMrDelayMs = 0;
  sim.mrCalls = 0;
  sim.mrInFlight = 0;
  sim.mrPeak = 0;
  sim.bugCommentGateAfter = Number.POSITIVE_INFINITY;
  sim.bugCommentDelayMs = 0;
  sim.bugCommentCalls = 0;
  sim.bugCommentInFlight = 0;
  sim.bugCommentPeak = 0;
  sim.onStoryComment = null;
  sim.gates.length = 0;
  vi.useRealTimers();
});

afterEach(() => {
  // 放行还挂着的请求，别让它们悬到下一个用例
  sim.gates.splice(0).forEach((open) => open());
  vi.useRealTimers();
});

describe("Q10-03：后半段并发上限", () => {
  it("上限是个正整数（不是 0 / Infinity，否则下面的峰值断言就没意义）", () => {
    expect(Number.isInteger(LIMIT)).toBe(true);
    expect(LIMIT).toBeGreaterThan(1);
    expect(LIMIT).toBeLessThan(10);
  });

  it("逐 MR 拉详情：并发峰值恰好等于上限，30 个全部处理，完整扫描不带 partial", async () => {
    sim.mrCount = 30;
    sim.getMrDelayMs = 15;
    const m = await load();
    const r = asOk(await settled(m.getMrInbox({ refresh: true }), "getMrInbox"));
    expect(sim.mrPeak).toBe(LIMIT);
    expect(sim.mrCalls).toBe(30);
    expect(r.pendingMr).toHaveLength(30);
    expect(r.pendingMr.every((it) => it.mr !== null)).toBe(true);
    expect(r.partial).toBeUndefined();
    expect(r.incomplete).toBeUndefined();
  });

  it("待回归逐 bug 拉评论补 MR：评论并发峰值恰好等于上限，20 个 bug 都补上 MR", async () => {
    sim.bugCount = 20;
    sim.bugCommentDelayMs = 15;
    const m = await load();
    const r = asOk(await settled(m.getMrInbox({ refresh: true }), "getMrInbox"));
    expect(sim.bugCommentPeak).toBe(LIMIT);
    expect(sim.bugCommentCalls).toBe(20);
    expect(sim.mrPeak).toBeLessThanOrEqual(LIMIT);
    expect(r.pendingRegression).toHaveLength(20);
    expect(r.pendingRegression.every((b) => b.mr)).toBe(true);
    expect(r.partial).toBeUndefined();
  });

  it("没配 gitToken：只剩纯链接、不发任何 GitLab 请求（行为不变）", async () => {
    sim.gitToken = "";
    sim.mrCount = 5;
    const m = await load();
    const r = asOk(await settled(m.getMrInbox({ refresh: true }), "getMrInbox"));
    expect(sim.mrCalls).toBe(0);
    expect(r.pendingMr).toHaveLength(5);
    expect(r.pendingMr.every((it) => it.mr === null)).toBe(true);
  });
});

describe("Q10-03：总时限覆盖后半段", () => {
  it("逐 MR 拉详情卡住：到点放手——返回已拿到的 4 个，在途的不等，标 partial + incomplete.all", async () => {
    sim.mrCount = 40;
    sim.getMrGateAfter = LIMIT; // 前 LIMIT 次立刻返回，之后全部挂起（模拟 GitLab 卡住）
    sim.deadlineMs = 600;
    const m = await load();
    const r = asOk(await settled(m.getMrInbox({ refresh: true }), "getMrInbox"));
    // 能走到这里本身就是证据：挂起的在途请求永远不会自己完成，等它们就会挂到测试超时
    expect(r.partial).toBe(true);
    expect(r.partialMessage).toContain("总时限");
    expect(r.incomplete?.kinds).toContain("deadline");
    expect(r.incomplete?.all).toBe(true);
    expect(r.pendingMr).toHaveLength(LIMIT);
    // 没轮到的不输出成「纯链接」：客户端合并时新数据优先，纯链接会盖掉旧表里带详情的同一条
    expect(r.pendingMr.every((it) => it.mr !== null)).toBe(true);
    // 4 个跑完、接着领的 4 个在途；其余没发过请求
    expect(sim.mrCalls).toBe(LIMIT * 2);
    expect(sim.mrInFlight).toBe(LIMIT);
  });

  it("放手之后：在途请求这时才完成，也不会再发新请求", async () => {
    sim.mrCount = 40;
    sim.getMrGateAfter = LIMIT;
    sim.deadlineMs = 600;
    const m = await load();
    asOk(await settled(m.getMrInbox({ refresh: true }), "getMrInbox"));
    const callsAtReturn = sim.mrCalls;
    expect(sim.mrInFlight).toBe(LIMIT);

    sim.gates.splice(0).forEach((open) => open());
    await new Promise<void>((r) => setTimeout(r, 80));

    expect(sim.mrCalls).toBe(callsAtReturn);
    expect(sim.mrInFlight).toBe(0);
  });

  it("待回归补 MR 卡住：到点放手——bug 一个不少，补到的带 MR、没补到的原样保留（不丢条目）", async () => {
    sim.bugCount = 20;
    sim.bugCommentGateAfter = LIMIT;
    sim.deadlineMs = 600;
    const m = await load();
    const r = asOk(await settled(m.getMrInbox({ refresh: true }), "getMrInbox"));
    expect(r.partial).toBe(true);
    expect(r.incomplete?.kinds).toContain("deadline");
    expect(r.incomplete?.all).toBe(true);
    expect(r.pendingRegression).toHaveLength(20);
    // 没补到的不能变成空洞 / undefined（否则下面的 filter 解引用会直接抛 TypeError，而不是给出可读的断言失败）
    expect(r.pendingRegression.every((b) => b !== undefined)).toBe(true);
    expect(r.pendingRegression.filter((b) => b.mr)).toHaveLength(LIMIT);
    // 没补到的：bug 本身（来自 MQL）原样，没有关联 MR 的字段
    const untouched = r.pendingRegression.filter((b) => !b.mr);
    expect(untouched).toHaveLength(20 - LIMIT);
    expect(untouched.every((b) => !("mrUrl" in b))).toBe(true);
    expect(sim.bugCommentCalls).toBe(LIMIT * 2);
    expect(sim.bugCommentInFlight).toBe(LIMIT);
  });

  it("前半段刚好拖过总时限：后半段一个请求都不发（领任务前先问时钟，不靠定时器）", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    sim.mrCount = 10;
    sim.deadlineMs = 1000;
    sim.onStoryComment = () => vi.setSystemTime(Date.now() + 5_000); // 评论拉取「花了」5 秒
    const m = await load();
    const pending = m.getMrInbox({ refresh: true });
    // 假时钟不推进时间：已经过了总时限，后半段不发请求、也不等定时器，应当直接落定
    expect(await settlesWithoutTime(pending), "已超总时限却没有立刻返回（在等定时器？）").toBe(true);
    const r = asOk(await pending);
    expect(r.partial).toBe(true);
    expect(r.incomplete?.kinds).toContain("deadline");
    expect(r.incomplete?.all).toBe(true);
    expect(sim.mrCalls).toBe(0);
    expect(r.pendingMr).toHaveLength(0);
  });

  it("超时的残表不缓存：下一轮非强制扫描照样真扫", async () => {
    sim.mrCount = 40;
    sim.getMrGateAfter = LIMIT;
    sim.deadlineMs = 600;
    const m = await load();
    const r1 = asOk(await settled(m.getMrInbox({ refresh: true }), "getMrInbox"));
    expect(r1.partial).toBe(true);
    sim.gates.splice(0).forEach((open) => open());

    // 恢复：不再卡住、不再缩短总时限；refresh=false 也要重新扫（partial 没落缓存）
    sim.getMrGateAfter = Number.POSITIVE_INFINITY;
    sim.deadlineMs = 50_000;
    sim.mrCalls = 0;
    const r2 = asOk(await settled(m.getMrInbox(), "getMrInbox"));
    expect(r2.partial).toBeUndefined();
    expect(r2.pendingMr).toHaveLength(40);
    expect(sim.mrCalls).toBe(40);
  });

  it("时钟先越线、放手的定时器后到点：「超过总时限」只记一条（两条路径共用同一个幂等标记）", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    sim.mrCount = 40;
    sim.getMrGateAfter = LIMIT;
    sim.deadlineMs = 1000;
    const m = await load();
    const pending = m.getMrInbox({ refresh: true });
    // 假时钟下没有定时器参与，排空微任务即可走到「4 个跑完、接着领的 4 个挂在门闩上」
    for (let i = 0; i < 5000 && sim.mrInFlight < LIMIT; i += 1) await Promise.resolve();
    expect(sim.mrInFlight).toBe(LIMIT);
    expect(sim.mrCalls).toBe(LIMIT * 2);

    // ① 时钟越过总时限（放手用的定时器还排着、没到点）；放行一个在途请求——
    //    它的车道回到循环顶端、领新任务前先问时钟，这一路第一次记下「超时」
    vi.setSystemTime(Date.now() + 5_000);
    sim.gates.shift()?.();
    for (let i = 0; i < 200; i += 1) await Promise.resolve();
    // ② 定时器到点：另外 3 个仍挂着 → 放手，这一路第二次想记「超时」，必须被幂等挡住
    await vi.advanceTimersByTimeAsync(2_000);

    expect(await settlesWithoutTime(pending), "放手的定时器到点后扫描没有落定").toBe(true);
    const r = asOk(await pending);
    expect(r.partial).toBe(true);
    expect(r.partialMessage).toBe("本轮扫描未完整（超过扫描总时限、仅返回已扫到的部分）");
    expect(r.incomplete?.kinds).toContain("deadline");
  });
});
