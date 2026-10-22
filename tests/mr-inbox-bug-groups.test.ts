/**
 * 第六轮 P4（MN-11 / MN-14）：补两条「变异存活」的测试缺口。
 *
 * MN-11：服务端 bug 双组分流——「我的 BUG」= 经办人是我 + 待修状态；「待回归」= 报告人是我 + RESOLVED。
 *   两组互换（经办人 ↔ 报告人）时旧测试全绿。这里桩掉 meegle / gitlab / settings，跑**真** scanner，
 *   让 MQL 桩按「经办人 / 报告人」返回不同的 bug，断言：各组拿到的是各自那一批、MQL 的状态白名单与角色字段配对正确、
 *   失败范围记在各自的 project key 集合里（一组失败不影响另一组）。
 * MN-14：整轮失败（`failScan`）**不**重置「连续部分失败」跟踪——
 *   部分失败 → 网络整轮失败 → 部分失败，连续计数应当接上（而不是被整轮失败清零，永远攒不到合并展示）。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sim = vi.hoisted(() => ({
  /** 每次 bug MQL 调用：拿到 MQL 文本，返回响应或抛错 */
  onMql: null as null | ((mql: string) => unknown),
  mqls: [] as string[],
  role: undefined as string | undefined,
}));

vi.mock("@/lib/server/meegle-cli", () => {
  class MeegleError extends Error {
    kind: string;
    constructor(kind: string, m: string) {
      super(m);
      this.kind = kind;
    }
  }
  return {
    MeegleError,
    fetchMyUserKey: async () => "u1",
    meegleAuthStatus: async () => ({ host: "project.example.com" }),
    fetchUserSchedule: async () => [],
    fetchWorkitemNodes: async () => [],
    fetchWorkitemComments: async () => [],
    queryWorkitemsByMql: async (_projectKey: string, mql: string) => {
      sim.mqls.push(mql);
      if (!sim.onMql) return {};
      return sim.onMql(mql);
    },
  };
});
vi.mock("@/lib/server/settings-fs", () => ({
  readSettingsFile: async () => ({
    status: "ok",
    settings: { gitToken: "", repos: [{ path: "/x" }], userRole: sim.role },
  }),
}));
vi.mock("@/lib/server/submit-mr-guard", () => ({
  deriveHostFromRepo: async () => "gitlab.example.com",
}));
vi.mock("@/lib/server/trusted-git-host", () => ({
  assertTrustedGitHost: () => {},
}));
vi.mock("@/lib/server/gitlab-client", () => ({
  getMR: async () => ({ ok: false, error: "unused" }),
  mergeMR: async () => ({ ok: true }),
}));

import {
  createInboxScanTracker,
  decideInboxScanResult,
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

/** 真实 CLI 形状（value 按 value_type 包一层同名壳）的一条 bug 行 */
const bugRow = (id: number, name: string, status: string) => ({
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
});
const resp = (...rows: ReturnType<typeof bugRow>[]) => ({ data: { g: rows } });

const isAssigneeMql = (mql: string) => mql.includes("`__经办人`");
const isReporterMql = (mql: string) => mql.includes("`__报告人`");

beforeEach(() => {
  sim.onMql = null;
  sim.mqls = [];
  sim.role = undefined; // 未设角色 = 三组全扫
});

describe("MN-11：服务端 bug 双组分流（经办人 → 我的 BUG；报告人 → 待回归）", () => {
  it("两组各拿各自那一批：经办人查询的 OPEN / IN PROGRESS 进「我的 BUG」，报告人查询的 RESOLVED 进「待回归」，互不串", async () => {
    sim.onMql = (mql) => {
      if (isAssigneeMql(mql)) return resp(bugRow(101, "我要修的 A", "OPEN"), bugRow(102, "我要修的 B", "IN PROGRESS"));
      if (isReporterMql(mql)) return resp(bugRow(201, "我报的待回归", "RESOLVED"));
      return {};
    };
    const m = await load();
    const r = asOk(await m.getMrInbox({ refresh: true }));
    expect(r.myBugs.map((b) => b.workItemId).sort()).toEqual(["101", "102"]);
    expect(r.pendingRegression.map((b) => b.workItemId)).toEqual(["201"]);
  });

  it("MQL 的角色字段与状态白名单配对正确，且用显式 <id:user_key>", async () => {
    sim.onMql = () => ({});
    const m = await load();
    asOk(await m.getMrInbox({ refresh: true }));
    const assignee = sim.mqls.filter(isAssigneeMql);
    const reporter = sim.mqls.filter(isReporterMql);
    expect(assignee).toHaveLength(1);
    expect(reporter).toHaveLength(1);
    // 经办人：待修三态，不含 RESOLVED
    for (const label of ["OPEN", "IN PROGRESS", "REOPENED"]) expect(assignee[0]).toContain(`'${label}'`);
    expect(assignee[0]).not.toContain("'RESOLVED'");
    // 报告人：只有 RESOLVED
    expect(reporter[0]).toContain("'RESOLVED'");
    for (const label of ["OPEN", "IN PROGRESS", "REOPENED"]) expect(reporter[0]).not.toContain(`'${label}'`);
    for (const q of [...assignee, ...reporter]) expect(q).toContain("'<id:u1>'");
  });

  it("状态不在本组白名单的行被本组丢掉（经办人查询里混进 RESOLVED 不进「我的 BUG」）", async () => {
    sim.onMql = (mql) =>
      isAssigneeMql(mql) ? resp(bugRow(101, "待修", "OPEN"), bugRow(103, "已解决不该出现", "RESOLVED")) : {};
    const m = await load();
    const r = asOk(await m.getMrInbox({ refresh: true }));
    expect(r.myBugs.map((b) => b.workItemId)).toEqual(["101"]);
    expect(r.pendingRegression).toEqual([]);
  });

  it("失败范围各记各的：经办人查询失败 → myBugsProjectKeys；报告人查询失败 → pendingRegressionProjectKeys；另一组照常扫到", async () => {
    sim.onMql = (mql) => {
      if (isAssigneeMql(mql)) throw new Error("meegle 超时");
      return resp(bugRow(201, "待回归", "RESOLVED"));
    };
    let m = await load();
    let r = asOk(await m.getMrInbox({ refresh: true }));
    expect(r.incomplete?.kinds).toContain("bugs");
    expect(r.incomplete?.myBugsProjectKeys).toHaveLength(1);
    expect(r.incomplete?.pendingRegressionProjectKeys).toEqual([]);
    expect(r.pendingRegression.map((b) => b.workItemId)).toEqual(["201"]);

    sim.onMql = (mql) => {
      if (isReporterMql(mql)) throw new Error("meegle 超时");
      return resp(bugRow(101, "待修", "OPEN"));
    };
    m = await load();
    r = asOk(await m.getMrInbox({ refresh: true }));
    expect(r.incomplete?.myBugsProjectKeys).toEqual([]);
    expect(r.incomplete?.pendingRegressionProjectKeys).toHaveLength(1);
    expect(r.myBugs.map((b) => b.workItemId)).toEqual(["101"]);
  });

  it("按角色可见组：fe / be 只扫「我的 BUG」（只发经办人查询）；qa 只扫「待回归」（只发报告人查询）", async () => {
    sim.onMql = () => ({});
    sim.role = "fe";
    let m = await load();
    asOk(await m.getMrInbox({ refresh: true }));
    expect(sim.mqls.some(isAssigneeMql)).toBe(true);
    expect(sim.mqls.some(isReporterMql)).toBe(false);

    sim.mqls = [];
    sim.role = "qa";
    m = await load();
    asOk(await m.getMrInbox({ refresh: true }));
    expect(sim.mqls.some(isAssigneeMql)).toBe(false);
    expect(sim.mqls.some(isReporterMql)).toBe(true);
  });
});

describe("MN-14：整轮失败（failScan）不重置「连续部分失败」跟踪", () => {
  type D = {
    status: string;
    pendingMr: { mrUrl: string; workItemId: string; projectKey: string; seenAtMs: number | null }[];
    myBugs: { bugUrl: string; projectKey: string; seenAtMs: number | null }[];
    pendingRegression: { bugUrl: string; projectKey: string; seenAtMs: number | null }[];
    scannedAt?: number;
    partial?: boolean;
  };
  const d = (scannedAt = 1_000): D => ({
    status: "ok",
    pendingMr: [{ mrUrl: "https://gl/x/-/merge_requests/1", workItemId: "w0", projectKey: "P", seenAtMs: null }],
    myBugs: [],
    pendingRegression: [],
    scannedAt,
  });
  const w1 = { kinds: ["comments" as const], workItemIds: ["w1"] };

  it("部分失败 → （整轮失败：failScan 不碰 tracker）→ 部分失败：连续计数接上，第 2 轮就合并展示", () => {
    let tracker = createInboxScanTracker();
    const r1 = decideInboxScanResult<D>({ prev: null, fresh: d(), partial: true, incomplete: w1, tracker });
    tracker = r1.tracker;
    expect(tracker.partialStreak).toBe(1);
    // 中间一轮整轮失败：hook 的 failScan 不改 tracker（见下方契约）→ tracker 原样带到下一轮
    const r2 = decideInboxScanResult<D>({ prev: r1.data, fresh: d(), partial: true, incomplete: w1, tracker });
    expect(r2.tracker.partialStreak).toBe(2);
    expect(r2.notice?.kind).toBe("partial-only");
  });

  it("契约：use-mr-inbox 的 failScan 只读 tracker（lastFullScanAt），不重置 / 不写回", () => {
    const src = readFileSync(path.resolve(__dirname, "..", "src/hooks/use-mr-inbox.tsx"), "utf8");
    const start = src.indexOf("const failScan = useCallback(");
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf("}, []);", start));
    expect(body).toContain("scanTrackerRef.current.lastFullScanAt");
    expect(body).not.toMatch(/scanTrackerRef\.current\s*=/);
    expect(body).not.toContain("createInboxScanTracker");
  });
});
