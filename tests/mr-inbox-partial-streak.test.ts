/**
 * N1-01（粒度 + hook 接线缺口）：连续多轮同类部分失败后「合并展示」，通知基线只对本轮扫到的条目做差。
 *
 * 行为级：用**真**纯函数（decideInboxScanResult / planInboxNotify / mergePartialScan / formatInboxScanNotice）
 * 驱动一个与 hook 同口径的会话（scan → 落 data → 通知 effect），构造多轮 partial 序列，
 * 外加一条「真 scanner → 真决策」的端到端（见 mr-inbox-scan-partial.test.ts 的永久失败用例）。
 * hook 本身只调这些纯函数，源码契约测试守住「hook 没有自带一套决策」。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import type { MrInboxIncompleteScope } from "@/lib/mr-inbox";
import {
  createInboxNotifyBaseline,
  createInboxScanTracker,
  decideInboxScanResult,
  formatInboxScanNotice,
  INBOX_PARTIAL_MERGE_AFTER_ROUNDS,
  mergePartialScan,
  planInboxNotify,
  type InboxScanDecision,
  type InboxScanNotice,
} from "@/lib/mr-inbox-state";

interface E {
  mrUrl: string;
  workItemId: string;
  workItemName: string;
  projectKey: string;
  mr: { title: string } | null;
  seenAtMs: number | null;
}
interface B {
  bugUrl: string;
  name: string;
  projectKey: string;
  seenAtMs: number | null;
}
interface D {
  status: string;
  pendingMr: E[];
  myBugs: B[];
  pendingRegression: B[];
  message?: string;
  scannedAt?: number;
  partial?: boolean;
  /** 客户端私有：合并 / 残表标记（第六轮 P3-1） */
  incompleteScan?: boolean;
}

const mr = (n: number, wi: string, project = "P", seen: number | null = null): E => ({
  mrUrl: `https://gl/x/-/merge_requests/${n}`,
  workItemId: wi,
  workItemName: `story ${wi}`,
  projectKey: project,
  mr: { title: `MR-${n}` },
  seenAtMs: seen,
});
const bug = (n: number, project = "P"): B => ({
  bugUrl: `https://meegle/bug/${n}`,
  name: `bug ${n}`,
  projectKey: project,
  seenAtMs: null,
});
const data = (
  pendingMr: E[],
  extra: Partial<D> & { myBugs?: B[]; pendingRegression?: B[] } = {},
): D => ({
  status: "ok",
  pendingMr,
  myBugs: extra.myBugs ?? [],
  pendingRegression: extra.pendingRegression ?? [],
  scannedAt: extra.scannedAt ?? 1_000,
  ...(extra.partial ? { partial: true } : {}),
});

const scope = (s: Partial<MrInboxIncompleteScope>): MrInboxIncompleteScope => ({
  kinds: s.kinds ?? ["comments"],
  ...s,
});
/** 工作项 w1 评论永久拉不到 */
const w1Comments = scope({ kinds: ["comments"], workItemIds: ["w1"] });

/** 与 hook 同口径的会话：scanOnce 成功分支 → decideInboxScanResult；data 变了 → 通知 effect → planInboxNotify */
const createSession = () => {
  let tracker = createInboxScanTracker();
  let current: D | null = null;
  // 与 hook 同一个对象：基线 keys + 「基线是否建在不完整的表上」的往返都由真 createInboxNotifyBaseline 持有（第七轮）
  const baseline = createInboxNotifyBaseline();
  let notice: InboxScanNotice | null = null;
  const notifications: { title: string; body: string }[] = [];
  const settle = (next: D) => {
    current = next;
    const copy = baseline.settle(next, false);
    if (copy) notifications.push(copy);
  };
  return {
    scan(res: {
      fresh: D;
      partial?: boolean;
      message?: string;
      incomplete?: MrInboxIncompleteScope;
    }): InboxScanDecision<D> {
      const d = decideInboxScanResult<D>({
        prev: current,
        fresh: res.fresh,
        partial: res.partial === true,
        partialMessage: res.message,
        incomplete: res.incomplete,
        tracker,
      });
      tracker = d.tracker;
      notice = d.notice;
      // 与 React 一致：data 引用没变（保留旧表）不会重跑通知 effect
      if (d.data !== current) settle(d.data);
      return d;
    },
    get data() {
      return current;
    },
    get baseline() {
      return baseline.keys;
    },
    get baselineIncomplete() {
      return baseline.incomplete;
    },
    get notice() {
      return notice;
    },
    get tracker() {
      return tracker;
    },
    notifications,
  };
};

const urls = (d: D | null) => (d?.pendingMr ?? []).map((x) => x.mrUrl);

describe("N1-01：首拉就 partial（无旧表）——不建基线 / 恢复后不重复通知", () => {
  it("首拉 partial：展示残表但带 partial、不建基线、不通知；恢复完整后静默建基线（存量不是新增）", () => {
    const s = createSession();
    s.scan({
      fresh: data([mr(1, "w0"), mr(3, "w2")]),
      partial: true,
      message: "本轮扫描未完整（工作项 w1 评论拉取失败）",
      incomplete: w1Comments,
    });
    expect(s.data?.partial).toBe(true);
    expect(urls(s.data)).toHaveLength(2);
    expect(s.baseline).toBeNull();
    expect(s.notifications).toHaveLength(0);
    expect(s.notice?.kind).toBe("partial-only");

    // 恢复：完整结果比残表多出存量 mr(2)——不能被当作「新增」
    s.scan({ fresh: data([mr(1, "w0"), mr(2, "w1"), mr(3, "w2")], { scannedAt: 2_000 }) });
    expect(s.data?.partial).toBeUndefined();
    expect(s.notice).toBeNull();
    expect(s.baseline?.size).toBe(3);
    expect(s.notifications).toHaveLength(0);

    // 之后真的新增才通知（回到全量差分）
    s.scan({ fresh: data([mr(1, "w0"), mr(2, "w1"), mr(3, "w2"), mr(4, "w3")], { scannedAt: 3_000 }) });
    expect(s.notifications).toHaveLength(1);
    expect(s.notifications[0]!.title).toBe("MR-4");
  });

  it("planInboxNotify：带 partial 的数据直接清基线、不通知（hook 那一行的保护）", () => {
    const base = new Set(["a"]);
    const plan = planInboxNotify({
      data: data([mr(1, "w0"), mr(2, "w1")], { partial: true }),
      prevKeys: base,
      windowFocused: false,
    });
    expect(plan.nextKeys).toBeNull();
    expect(plan.copy).toBeNull();
  });

  it("反例：同样的数据去掉 partial → 正常做差并通知（旧树能用的情形仍能用）", () => {
    const plan = planInboxNotify({
      data: data([mr(1, "w0"), mr(2, "w1")]),
      prevKeys: new Set(["https://gl/x/-/merge_requests/1"]),
      windowFocused: false,
    });
    expect(plan.copy?.title).toBe("MR-2");
    expect(plan.nextKeys?.size).toBe(2);
  });

  it("无旧表连续同类失败 ≥2 轮：只对「已扫到的条目」静默建基线，之后新增能发通知（不再永远不发）", () => {
    const s = createSession();
    const failMsg = "本轮扫描未完整（工作项 w1 评论拉取失败）";
    // 第 1 轮：残表、无基线
    s.scan({ fresh: data([mr(1, "w0")]), partial: true, message: failMsg, incomplete: w1Comments });
    expect(s.baseline).toBeNull();
    // 第 2 轮：同类失败 → 不再带 partial，对已扫到的条目建基线（静默）
    const d2 = s.scan({ fresh: data([mr(1, "w0")]), partial: true, message: failMsg, incomplete: w1Comments });
    expect(d2.data.partial).toBeUndefined();
    expect(s.notice?.kind).toBe("partial-only");
    expect(s.notice?.rounds).toBe(2);
    expect(s.baseline).toEqual(new Set(["https://gl/x/-/merge_requests/1"]));
    expect(s.notifications).toHaveLength(0);
    // 第 3 轮：新扫到 mr(5) → 通知；mr(1) 不重复
    s.scan({ fresh: data([mr(1, "w0"), mr(5, "w4")]), partial: true, message: failMsg, incomplete: w1Comments });
    expect(s.notifications).toHaveLength(1);
    expect(s.notifications[0]!.title).toBe("MR-5");
  });
});

describe("N1-01：永久性失败 → 连续多轮后合并展示", () => {
  const old = () => data([mr(1, "w0"), mr(2, "w1"), mr(3, "w2")]);
  const failMsg = "本轮扫描未完整（工作项 w1 评论拉取失败）";

  /** 先有一份完整旧表 + 基线 */
  const withOldTable = () => {
    const s = createSession();
    s.scan({ fresh: old() });
    expect(s.baseline?.size).toBe(3);
    return s;
  };

  it("第 1 轮同类失败：仍保留旧表（引用不变、无通知）；第 2 轮起合并：新增条目出现并通知，w1 的旧条目沿用", () => {
    const s = withOldTable();
    const oldRef = s.data;

    // 第 1 轮：fresh 没有 w1 的 MR，但多了 w3 的新 MR(4)
    const fresh = () => data([mr(1, "w0"), mr(3, "w2"), mr(4, "w3")], { scannedAt: 2_000 });
    const d1 = s.scan({ fresh: fresh(), partial: true, message: failMsg, incomplete: w1Comments });
    expect(d1.data).toBe(oldRef); // 冻结在旧表
    expect(s.notice?.kind).toBe("kept-old");
    expect(s.notice?.rounds).toBe(1);
    expect(s.notifications).toHaveLength(0);
    expect(INBOX_PARTIAL_MERGE_AFTER_ROUNDS).toBe(2);

    // 第 2 轮：合并——新数据 + w1 的旧条目沿用
    const d2 = s.scan({ fresh: fresh(), partial: true, message: failMsg, incomplete: w1Comments });
    expect(d2.data).not.toBe(oldRef);
    expect(urls(s.data).sort()).toEqual(
      [1, 2, 3, 4].map((n) => `https://gl/x/-/merge_requests/${n}`),
    );
    expect(s.data?.partial).toBeUndefined();
    expect(s.notice?.kind).toBe("merged");
    expect(s.notice?.rounds).toBe(2);
    // 只对新条目通知；沿用的 mr(2) 不被当作新增
    expect(s.notifications.map((n) => n.title)).toEqual(["MR-4"]);

    // 第 3 轮：同样失败、没有新条目 → 不重复通知；再来一个新的 → 只通知新的
    s.scan({ fresh: fresh(), partial: true, message: failMsg, incomplete: w1Comments });
    expect(s.notifications).toHaveLength(1);
    s.scan({
      fresh: data([mr(1, "w0"), mr(3, "w2"), mr(4, "w3"), mr(6, "w5")], { scannedAt: 3_000 }),
      partial: true,
      message: failMsg,
      incomplete: w1Comments,
    });
    expect(s.notifications.map((n) => n.title)).toEqual(["MR-4", "MR-6"]);
    expect(urls(s.data)).toContain("https://gl/x/-/merge_requests/2"); // w1 的仍在
  });

  it("没扫到的旧条目不会因缺席被当成「消失」；范围之外本轮扫到却没出现的旧条目才真的丢掉", () => {
    const s = withOldTable();
    // 本轮 w2 的 MR(3) 已被合并（扫到了、没出现）；w1 失败（没扫到）
    const fresh = () => data([mr(1, "w0")], { scannedAt: 2_000 });
    s.scan({ fresh: fresh(), partial: true, message: failMsg, incomplete: w1Comments });
    s.scan({ fresh: fresh(), partial: true, message: failMsg, incomplete: w1Comments });
    expect(urls(s.data).sort()).toEqual([
      "https://gl/x/-/merge_requests/1",
      "https://gl/x/-/merge_requests/2", // w1 沿用
    ]);
    // 基线跟着当前表走：mr(3) 不在基线里，w1 的 mr(2) 仍在基线里
    expect(s.baseline).toEqual(
      new Set([
        "https://gl/x/-/merge_requests/1",
        "https://gl/x/-/merge_requests/2",
      ]),
    );
    expect(s.notifications).toHaveLength(0);
  });

  it("沿用的旧条目保留它在旧表里的已读状态（旧条目已读 → 不进未读集合、不通知）", () => {
    const s = createSession();
    s.scan({ fresh: data([mr(1, "w0"), mr(2, "w1", "P", 999)]) });
    const fresh = () => data([mr(1, "w0")], { scannedAt: 2_000 });
    s.scan({ fresh: fresh(), partial: true, message: failMsg, incomplete: w1Comments });
    s.scan({ fresh: fresh(), partial: true, message: failMsg, incomplete: w1Comments });
    expect(s.data?.pendingMr.find((x) => x.workItemId === "w1")?.seenAtMs).toBe(999);
    expect(s.baseline).toEqual(new Set(["https://gl/x/-/merge_requests/1"]));
    expect(s.notifications).toHaveLength(0);
  });

  it("恢复完整扫描后回到全量差分：数据 = 新结果、跟踪清零、错误条消失、不重复通知已见条目", () => {
    const s = withOldTable();
    const fresh = () => data([mr(1, "w0"), mr(3, "w2"), mr(4, "w3")], { scannedAt: 2_000 });
    s.scan({ fresh: fresh(), partial: true, message: failMsg, incomplete: w1Comments });
    s.scan({ fresh: fresh(), partial: true, message: failMsg, incomplete: w1Comments });
    expect(s.notifications.map((n) => n.title)).toEqual(["MR-4"]);

    // 恢复：w1 的 MR(2) 又扫到了、另外 mr(9) 是新的
    s.scan({
      fresh: data([mr(1, "w0"), mr(2, "w1"), mr(3, "w2"), mr(4, "w3"), mr(9, "w9")], {
        scannedAt: 5_000,
      }),
    });
    expect(s.notice).toBeNull();
    expect(s.tracker.partialStreak).toBe(0);
    expect(s.tracker.lastFullScanAt).toBe(5_000);
    expect(urls(s.data)).toHaveLength(5);
    // 只有 mr(9) 是新增；mr(2) / mr(4) 已在基线里
    expect(s.notifications.map((n) => n.title)).toEqual(["MR-4", "MR-9"]);

    // 恢复之后再 partial 又从第 1 轮重新计数（回到保留旧表）
    const ref = s.data;
    const d = s.scan({ fresh: data([mr(1, "w0")], { scannedAt: 6_000 }), partial: true, incomplete: w1Comments });
    expect(d.data).toBe(ref);
    expect(s.notice?.rounds).toBe(1);
  });

  it("换了一类失败：重新计数，仍保留旧表（不把偶发的不同失败攒成合并）", () => {
    const s = withOldTable();
    const ref = s.data;
    s.scan({
      fresh: data([mr(1, "w0")]),
      partial: true,
      incomplete: scope({ kinds: ["nodes"], workItemIds: ["w1"] }),
    });
    const d2 = s.scan({
      fresh: data([mr(1, "w0")]),
      partial: true,
      incomplete: scope({ kinds: ["schedule"], scheduleProjectKeys: ["P"] }),
    });
    expect(d2.data).toBe(ref);
    expect(s.notice?.kind).toBe("kept-old");
    expect(s.notice?.rounds).toBe(1);
    // 同类（schedule）再来一轮才合并
    s.scan({
      fresh: data([mr(1, "w0")]),
      partial: true,
      incomplete: scope({ kinds: ["schedule"], scheduleProjectKeys: ["P"] }),
    });
    expect(s.notice?.kind).toBe("merged");
  });

  it("整轮失败（网络）不改变连续计数语义：只有部分失败会累计，完整成功才清零", () => {
    const tr = createInboxScanTracker();
    const d = decideInboxScanResult<D>({
      prev: old(),
      fresh: data([mr(1, "w0")]),
      partial: true,
      incomplete: w1Comments,
      tracker: tr,
    });
    expect(d.tracker.partialStreak).toBe(1);
    const ok = decideInboxScanResult<D>({
      prev: d.data,
      fresh: data([mr(1, "w0")], { scannedAt: 7_000 }),
      partial: false,
      tracker: d.tracker,
    });
    expect(ok.tracker).toEqual({ partialStreak: 0, commonKinds: [], lastFullScanAt: 7_000 });
  });
});

describe("第六轮 P3-1 / 场景 B：不完整表上建的基线不可信——恢复完整扫描时静默重建，不把存量当「新增」", () => {
  const failMsg = "本轮扫描未完整（工作项 w1 评论拉取失败）";
  const failRound = (s: ReturnType<typeof createSession>, fresh: D) =>
    s.scan({ fresh, partial: true, message: failMsg, incomplete: w1Comments });

  it("首拉连续 ≥2 轮不完整、随后恢复：w1 范围里的存量一次都不当新增推送（旧：一次性误推一批）；之后真新增照常通知", () => {
    const s = createSession();
    failRound(s, data([mr(1, "w0")]));
    failRound(s, data([mr(1, "w0")]));
    // 第 2 轮合并展示、建了基线——但它是不完整表上的基线
    expect(s.baseline).toEqual(new Set(["https://gl/x/-/merge_requests/1"]));
    expect(s.baselineIncomplete).toBe(true);
    expect(s.data?.incompleteScan).toBe(true);
    // 恢复：w1 的存量 mr(2) / mr(3) 第一次被扫到——它们是存量、不是新增
    s.scan({ fresh: data([mr(1, "w0"), mr(2, "w1"), mr(3, "w1")]) });
    expect(s.notifications).toHaveLength(0);
    expect(s.baseline).toEqual(
      new Set(["https://gl/x/-/merge_requests/1", "https://gl/x/-/merge_requests/2", "https://gl/x/-/merge_requests/3"]),
    );
    expect(s.baselineIncomplete).toBe(false);
    expect(s.data?.incompleteScan).toBeUndefined();
    // 基线已恢复可信：下一轮真新增 mr(9) 照常通知，存量不重复
    s.scan({ fresh: data([mr(1, "w0"), mr(2, "w1"), mr(3, "w1"), mr(9, "w9")]) });
    expect(s.notifications.map((n) => n.title)).toEqual(["MR-9"]);
  });

  it("失败拖得更久（≥3 轮）再恢复：恢复那一轮同样静默", () => {
    const s = createSession();
    for (let i = 0; i < 4; i++) failRound(s, data([mr(1, "w0")]));
    expect(s.baselineIncomplete).toBe(true);
    s.scan({ fresh: data([mr(1, "w0"), mr(2, "w1")]) });
    expect(s.notifications).toHaveLength(0);
    expect(s.baselineIncomplete).toBe(false);
  });

  it("仍不完整期间：基线继续标「不可信」，但真新增照常通知（不退回「永远不发」）；恢复时才静默重建", () => {
    const s = createSession();
    failRound(s, data([mr(1, "w0")]));
    failRound(s, data([mr(1, "w0")]));
    failRound(s, data([mr(1, "w0"), mr(5, "w4")]));
    expect(s.notifications.map((n) => n.title)).toEqual(["MR-5"]);
    expect(s.baselineIncomplete).toBe(true);
    s.scan({ fresh: data([mr(1, "w0"), mr(5, "w4"), mr(2, "w1")]) });
    expect(s.notifications.map((n) => n.title)).toEqual(["MR-5"]); // mr(2) 是存量，没有再推
    expect(s.baselineIncomplete).toBe(false);
  });

  it("基线可信（建在完整扫描上）时不受影响：合并展示轮里的新增照常通知，恢复后存量不重复推、基线始终可信", () => {
    const s = createSession();
    s.scan({ fresh: data([mr(1, "w0"), mr(2, "w1")]) }); // 完整 → 可信基线
    expect(s.baselineIncomplete).toBe(false);
    failRound(s, data([mr(1, "w0")])); // 第 1 轮：保留旧表
    const d2 = failRound(s, data([mr(1, "w0"), mr(7, "w7")])); // 第 2 轮：合并（w1 的 mr(2) 沿用）
    expect(d2.data.incompleteScan).toBe(true);
    expect(s.notifications.map((n) => n.title)).toEqual(["MR-7"]);
    expect(s.baselineIncomplete).toBe(false); // 完整基线 + 合并表 = 仍可信
    s.scan({ fresh: data([mr(1, "w0"), mr(2, "w1"), mr(7, "w7")]) });
    expect(s.notifications.map((n) => n.title)).toEqual(["MR-7"]); // 恢复：mr(2) 不被当新增
    expect(s.baselineIncomplete).toBe(false);
  });

  it("planInboxNotify 直接：缺省 baselineIncomplete = false 与旧行为一致；不可信基线 + 完整数据 → 静默并恢复可信", () => {
    const full = data([mr(1, "w0"), mr(2, "w1")]);
    const prevKeys = new Set(["https://gl/x/-/merge_requests/1"]);
    // 旧口径（不传）：mr(2) 是新增 → 通知
    const legacy = planInboxNotify({ data: full, prevKeys, windowFocused: false });
    expect(legacy.copy?.title).toBe("MR-2");
    expect(legacy.baselineIncomplete).toBe(false);
    // 基线不可信：同一份完整数据静默重建
    const silent = planInboxNotify({ data: full, prevKeys, windowFocused: false, baselineIncomplete: true });
    expect(silent.copy).toBeNull();
    expect(silent.baselineIncomplete).toBe(false);
    expect(silent.nextKeys).toEqual(new Set(["https://gl/x/-/merge_requests/1", "https://gl/x/-/merge_requests/2"]));
    // data 为空：标记原样保留；降级态：清基线并复位标记
    expect(planInboxNotify({ data: null, prevKeys, windowFocused: false, baselineIncomplete: true }).baselineIncomplete).toBe(true);
    expect(
      planInboxNotify({ data: { ...full, status: "error" }, prevKeys, windowFocused: false, baselineIncomplete: true }),
    ).toEqual({ nextKeys: null, copy: null, baselineIncomplete: false });
  });
});

describe("第六轮 P4：保留的旧表本身就是不完整表 → 错误条不再谎称「上次完整结果」/「只含本轮」", () => {
  it("连续同类失败合并（无完整扫描史）后换了一类失败：保留旧表 → kept-partial 文案", () => {
    const s = createSession();
    const msg = "本轮扫描未完整";
    s.scan({ fresh: data([mr(1, "w0")]), partial: true, message: msg, incomplete: w1Comments });
    s.scan({ fresh: data([mr(1, "w0")]), partial: true, message: msg, incomplete: w1Comments });
    expect(s.notice?.kind).toBe("partial-only");
    const before = s.data;
    // 换了一类失败：streak 重置为 1 → 保留旧表（引用不变）
    s.scan({ fresh: data([mr(1, "w0")]), partial: true, message: msg, incomplete: scope({ kinds: ["nodes"], workItemIds: ["w2"] }) });
    expect(s.data).toBe(before);
    expect(s.notice?.kind).toBe("kept-partial");
    const text = formatInboxScanNotice(s.notice!);
    expect(text).toContain("上一轮的部分结果");
    expect(text).toContain("至今没有完整扫描成功过");
    expect(text).not.toContain("上次完整结果");
    expect(text).not.toContain("只含本轮已扫到的条目");
  });

  it("反例（旧行为不变）：有过完整扫描 → 仍是 kept-old；首拉残表 → 仍是 partial-only", () => {
    const s = createSession();
    s.scan({ fresh: data([mr(1, "w0")], { scannedAt: 5_000 }) });
    s.scan({ fresh: data([mr(1, "w0")]), partial: true, message: "x", incomplete: w1Comments });
    expect(s.notice?.kind).toBe("kept-old");
    const s2 = createSession();
    s2.scan({ fresh: data([mr(1, "w0")]), partial: true, message: "x", incomplete: w1Comments });
    expect(s2.notice?.kind).toBe("partial-only");
  });
});

describe("第七轮 R7-1：恢复轮静默重建的已接受代价（钉住，别被无意改掉）", () => {
  const failMsg = "本轮扫描未完整（工作项 w1 评论拉取失败）";
  it("恢复完整扫描那一轮：失败期间才冒出来的真新增也被一并静默（仍在未读里，只是少一次系统横幅）；下一轮的新增照常通知", () => {
    const s = createSession();
    s.scan({ fresh: data([mr(1, "w0")]), partial: true, message: failMsg, incomplete: w1Comments });
    s.scan({ fresh: data([mr(1, "w0")]), partial: true, message: failMsg, incomplete: w1Comments });
    // 恢复轮：mr(2) 是 w1 的存量，mr(10) 是失败期间新建的真新增——两者都没有横幅
    s.scan({ fresh: data([mr(1, "w0"), mr(2, "w1"), mr(10, "w9")]) });
    expect(s.notifications).toHaveLength(0);
    // 它们仍在列表（未读）里：只是没有系统通知
    expect(urls(s.data)).toEqual(expect.arrayContaining([
      "https://gl/x/-/merge_requests/2",
      "https://gl/x/-/merge_requests/10",
    ]));
    expect(s.baseline?.has("https://gl/x/-/merge_requests/10")).toBe(true);
    // 之后的新增照常通知
    s.scan({ fresh: data([mr(1, "w0"), mr(2, "w1"), mr(10, "w9"), mr(11, "w9")]) });
    expect(s.notifications.map((n) => n.title)).toEqual(["MR-11"]);
  });
});

describe("createInboxNotifyBaseline：基线 keys + 可信标记的往返（hook 只调 settle）", () => {
  const full = (...ms: E[]) => data(ms);
  const merged = (...ms: E[]) => ({ ...data(ms), incompleteScan: true });

  it("首轮完整数据只建基线；之后做差通知；前台只更新基线不通知", () => {
    const b = createInboxNotifyBaseline();
    expect(b.keys).toBeNull();
    expect(b.settle(full(mr(1, "w0")), false)).toBeNull();
    expect(b.keys).toEqual(new Set(["https://gl/x/-/merge_requests/1"]));
    expect(b.settle(full(mr(1, "w0"), mr(2, "w0")), true)).toBeNull(); // 前台：不发，但基线已更新
    expect(b.settle(full(mr(1, "w0"), mr(2, "w0")), false)).toBeNull(); // 已在基线里
    expect(b.settle(full(mr(1, "w0"), mr(2, "w0"), mr(3, "w0")), false)?.title).toBe("MR-3");
  });

  it("不可信基线往返：不完整表建基线 → incomplete=true → 完整数据静默并复位 → 之后正常通知", () => {
    const b = createInboxNotifyBaseline();
    expect(b.settle(merged(mr(1, "w0")), false)).toBeNull();
    expect(b.incomplete).toBe(true);
    expect(b.settle(merged(mr(1, "w0"), mr(5, "w4")), false)?.title).toBe("MR-5"); // 仍不完整：照常通知
    expect(b.incomplete).toBe(true);
    expect(b.settle(full(mr(1, "w0"), mr(5, "w4"), mr(2, "w1")), false)).toBeNull(); // 恢复：静默
    expect(b.incomplete).toBe(false);
    expect(b.settle(full(mr(1, "w0"), mr(5, "w4"), mr(2, "w1"), mr(9, "w9")), false)?.title).toBe("MR-9");
  });

  it("降级态清基线并复位标记；data 为空时原样保留", () => {
    const b = createInboxNotifyBaseline();
    b.settle(merged(mr(1, "w0")), false);
    expect(b.incomplete).toBe(true);
    b.settle(null, false);
    expect(b.keys).not.toBeNull();
    expect(b.incomplete).toBe(true);
    b.settle({ ...full(mr(1, "w0")), status: "error" }, false);
    expect(b.keys).toBeNull();
    expect(b.incomplete).toBe(false);
  });

  it("每个实例各自独立", () => {
    const a = createInboxNotifyBaseline();
    const b = createInboxNotifyBaseline();
    a.settle(full(mr(1, "w0")), false);
    expect(b.keys).toBeNull();
  });
});

describe("第七轮 R7-2：保留的旧表是「有完整史的合并表」→ kept-merged，不再谎称「上次完整结果」", () => {
  it("有完整扫描 → 同类失败合并 → 换一类失败（冻结合并表）：kept-merged 文案", () => {
    const s = createSession();
    s.scan({ fresh: data([mr(1, "w0"), mr(2, "w1")], { scannedAt: 8_000 }) }); // 完整
    s.scan({ fresh: data([mr(1, "w0")]), partial: true, message: "x", incomplete: w1Comments });
    s.scan({ fresh: data([mr(1, "w0")]), partial: true, message: "x", incomplete: w1Comments });
    expect(s.notice?.kind).toBe("merged");
    expect(s.data?.incompleteScan).toBe(true);
    const frozen = s.data;
    s.scan({ fresh: data([mr(1, "w0")]), partial: true, message: "x", incomplete: scope({ kinds: ["nodes"], workItemIds: ["w2"] }) });
    expect(s.data).toBe(frozen);
    expect(s.notice?.kind).toBe("kept-merged");
    const text = formatInboxScanNotice(s.notice!);
    expect(text).toContain("上一轮的合并结果");
    expect(text).toContain("可能不是最新");
    expect(text).not.toContain("上次完整结果");
    expect(text).not.toContain("至今没有完整扫描成功过");
    // 第八轮 P4-1：沿用的条目可能来自比「最近一次完整扫描」更新的中间合并批次——只说「更早的数据、最早可追溯到」，
    // 且写明的时间点必须是最近一次完整扫描的时间（8_000），不能说「就是那次的数据」
    const d = new Date(8_000);
    const clock = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    expect(text).toContain("沿用更早的数据");
    expect(text).toContain(`最早可追溯到 ${clock} 的完整扫描`);
    expect(text).not.toContain("完整扫描时的旧数据");
  });

  it("三种「保留旧表」各走各的 kind：完整旧表 kept-old / 有完整史的合并表 kept-merged / 无完整史的合并表 kept-partial", () => {
    const kindAfterFrozen = (withFull: boolean) => {
      const s = createSession();
      if (withFull) s.scan({ fresh: data([mr(1, "w0")], { scannedAt: 8_000 }) });
      return s;
    };
    // kept-old
    const a = kindAfterFrozen(true);
    a.scan({ fresh: data([mr(1, "w0")]), partial: true, message: "x", incomplete: w1Comments });
    expect(a.notice?.kind).toBe("kept-old");
    // kept-merged
    const b = kindAfterFrozen(true);
    for (let i = 0; i < 2; i++) b.scan({ fresh: data([mr(1, "w0")]), partial: true, message: "x", incomplete: w1Comments });
    b.scan({ fresh: data([mr(1, "w0")]), partial: true, message: "x", incomplete: scope({ kinds: ["nodes"] }) });
    expect(b.notice?.kind).toBe("kept-merged");
    // kept-partial
    const c = kindAfterFrozen(false);
    for (let i = 0; i < 2; i++) c.scan({ fresh: data([mr(1, "w0")]), partial: true, message: "x", incomplete: w1Comments });
    c.scan({ fresh: data([mr(1, "w0")]), partial: true, message: "x", incomplete: scope({ kinds: ["nodes"] }) });
    expect(c.notice?.kind).toBe("kept-partial");
  });
});

describe("mergePartialScan：按失败范围决定沿用哪些旧条目", () => {
  it("排期失败的空间：整个空间的旧 MR 沿用；别的空间扫到没出现的就是真没了", () => {
    const prev = data([mr(1, "w0", "P"), mr(2, "w1", "Q"), mr(3, "w2", "Q")]);
    const fresh = data([mr(3, "w2", "Q")]);
    const merged = mergePartialScan(
      prev,
      fresh,
      scope({ kinds: ["schedule"], scheduleProjectKeys: ["P"] }),
    );
    expect(urls(merged).sort()).toEqual([
      "https://gl/x/-/merge_requests/1", // P 排期失败 → 沿用
      "https://gl/x/-/merge_requests/3",
    ]); // Q 的 mr(2) 本轮扫到却没出现 → 丢
  });

  it("bug 组：各用各的失败空间（我的 BUG 失败不影响待回归组的真消失）", () => {
    const prev = data([], {
      myBugs: [bug(1, "P"), bug(2, "Q")],
      pendingRegression: [bug(3, "P")],
    });
    const fresh = data([], { myBugs: [bug(2, "Q")], pendingRegression: [] });
    const merged = mergePartialScan(
      prev,
      fresh,
      scope({ kinds: ["bugs"], myBugsProjectKeys: ["P"] }),
    );
    expect(merged.myBugs.map((b) => b.bugUrl).sort()).toEqual([
      "https://meegle/bug/1",
      "https://meegle/bug/2",
    ]);
    expect(merged.pendingRegression).toEqual([]); // 待回归的 P 空间查询成功、bug3 真没了
  });

  it("超总时限（all）/ 缺范围信息：所有没被新数据覆盖的旧条目都沿用；新数据同 key 时以新为准", () => {
    const stale = { ...mr(1, "w0"), mr: { title: "旧标题" } };
    const prev = data([stale, mr(2, "w1")]);
    const fresh = data([mr(1, "w0")]); // 标题 MR-1
    for (const sc of [scope({ kinds: ["deadline"], all: true }), undefined]) {
      const merged = mergePartialScan(prev, fresh, sc);
      expect(urls(merged)).toEqual([
        "https://gl/x/-/merge_requests/1",
        "https://gl/x/-/merge_requests/2",
      ]);
      expect(merged.pendingMr[0]!.mr?.title).toBe("MR-1");
    }
  });

  it("不改入参（纯函数）", () => {
    const prev = data([mr(1, "w0"), mr(2, "w1")]);
    const fresh = data([mr(1, "w0")]);
    const snap = JSON.stringify([prev, fresh]);
    mergePartialScan(prev, fresh, w1Comments);
    expect(JSON.stringify([prev, fresh])).toBe(snap);
  });
});

describe("面板错误条文案：按场景给准确措辞", () => {
  const clock = (ms: number) => {
    const d = new Date(ms);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  };
  const T = new Date(2026, 0, 2, 9, 5).getTime();

  it("保留旧表：写明「本轮未更新、仍是 HH:mm 的上次完整结果」", () => {
    const text = formatInboxScanNotice({
      kind: "kept-old",
      message: "本轮扫描未完整（工作项 w1 评论拉取失败）",
      staleSinceMs: T,
      rounds: 1,
      kinds: ["comments"],
    });
    expect(text).toContain("本轮未更新");
    expect(text).toContain(clock(T));
    expect(text).toContain("上次完整结果");
  });

  it("合并展示：写明连续轮数 + 失败类别 + 列表停在几点几分 + 以下为合并结果", () => {
    const text = formatInboxScanNotice({
      kind: "merged",
      message: "本轮扫描未完整（工作项 w1 评论拉取失败）",
      staleSinceMs: T,
      rounds: 3,
      kinds: ["comments"],
    });
    expect(text).toContain("已连续 3 轮");
    expect(text).toContain("工作项评论拉取");
    expect(text).toContain(`列表停在 ${clock(T)}`);
    expect(text).toContain("以下为合并结果");
    expect(text).not.toContain("下方为上次结果");
  });

  it("无旧表：不再说「下方为上次结果」，写明只含已扫到的条目 + 哪类失败", () => {
    const first = formatInboxScanNotice({
      kind: "partial-only",
      message: "本轮扫描未完整（空间 X 排期拉取失败）",
      staleSinceMs: null,
      rounds: 1,
      kinds: ["schedule"],
    });
    expect(first).toContain("没有上次完整结果可用");
    expect(first).toContain("只含本轮已扫到");
    expect(first).not.toContain("下方为上次结果");
    const multi = formatInboxScanNotice({
      kind: "partial-only",
      message: "本轮扫描未完整（空间 X 排期拉取失败）",
      staleSinceMs: null,
      rounds: 2,
      kinds: ["schedule"],
    });
    expect(multi).toContain("已连续 2 轮");
    expect(multi).toContain("空间排期拉取");
  });

  it("整轮失败（网络 / 非 2xx）：保持原措辞（旧树能用的情形不变）", () => {
    expect(
      formatInboxScanNotice({
        kind: "failed",
        message: "扫描超时",
        staleSinceMs: null,
        rounds: 0,
        kinds: [],
      }),
    ).toBe("最近一次扫描失败（下方为上次结果）：扫描超时");
  });

  it("决策产出的 notice 场景与 data 一致（有旧表 / 合并 / 无旧表各自对应）", () => {
    const s = createSession();
    s.scan({ fresh: data([mr(1, "w0")], { scannedAt: T }) });
    s.scan({ fresh: data([]), partial: true, incomplete: w1Comments });
    expect(s.notice?.kind).toBe("kept-old");
    expect(s.notice?.staleSinceMs).toBe(T);
    s.scan({ fresh: data([]), partial: true, incomplete: w1Comments });
    expect(s.notice?.kind).toBe("merged");
    expect(formatInboxScanNotice(s.notice!)).toContain(`列表停在 ${clock(T)}`);

    const none = createSession();
    none.scan({ fresh: data([]), partial: true, incomplete: w1Comments });
    expect(none.notice?.kind).toBe("partial-only");
  });
});

describe("planInboxNotify：其它保护（行为）", () => {
  it("降级态（非 ok）清基线；data 为空时基线原样保留", () => {
    expect(
      planInboxNotify({
        data: { ...data([]), status: "error" },
        prevKeys: new Set(["a"]),
        windowFocused: false,
      }).nextKeys,
    ).toBeNull();
    expect(
      planInboxNotify({ data: null, prevKeys: new Set(["a"]), windowFocused: false })
        .nextKeys,
    ).toEqual(new Set(["a"]));
  });

  it("窗口在前台：只更新基线、不发通知（下次不重复推）", () => {
    const plan = planInboxNotify({
      data: data([mr(1, "w0"), mr(2, "w1")]),
      prevKeys: new Set(["https://gl/x/-/merge_requests/1"]),
      windowFocused: true,
    });
    expect(plan.copy).toBeNull();
    expect(plan.nextKeys?.size).toBe(2);
  });

  it("首轮（无基线）完整数据：只建基线、不通知", () => {
    const plan = planInboxNotify({
      data: data([mr(1, "w0")]),
      prevKeys: null,
      windowFocused: false,
    });
    expect(plan.copy).toBeNull();
    expect(plan.nextKeys?.size).toBe(1);
  });
});

describe("hook / 面板接线契约（补充：行为已由上面的纯函数用例覆盖）", () => {
  const read = (rel: string) =>
    readFileSync(path.resolve(__dirname, "..", rel), "utf8");

  it("use-mr-inbox 只调纯函数决策，不自带 partial / diff 决策", () => {
    const src = read("src/hooks/use-mr-inbox.tsx");
    expect(src).toContain("decideInboxScanResult<MrInboxData>(");
    expect(src).toContain("createInboxNotifyBaseline");
    expect(src).not.toMatch(/if \(data\.partial\)/);
    expect(src).not.toContain("diffInboxUnreadForNotify");
    expect(src).not.toContain("resolvePartialScan");
    // 服务端的「没扫到范围」要透传给决策
    expect(src).toContain("incomplete: body.incomplete");
  });

  it("use-mr-inbox 的通知基线交给 createInboxNotifyBaseline 持有（往返行为见上方；hook 不自己持 keys / 标记）", () => {
    const src = read("src/hooks/use-mr-inbox.tsx").replace(/\s+/g, " ");
    // ⚠ 这是源码文本契约（项目没有 jsdom / testing-library，hook 没法行为测；状态机本身已抽到纯对象、上面有行为测试）。
    // 认「useState 初始化器」的两种等价写法——useMemo 可能被 React 丢缓存、会把基线清零；每次渲染新建（裸调用 / useRef(create())）同样不行
    expect(src).toMatch(
      /const \[notifyBaseline\] = useState\(\s*(?:\(\) => )?createInboxNotifyBaseline(?:\(\))?\s*\);/,
    );
    expect(src).not.toMatch(/useMemo\([\s\S]{0,60}createInboxNotifyBaseline/);
    expect(src).not.toMatch(/useRef\([\s\S]{0,20}createInboxNotifyBaseline/);
    expect(src).toContain("notifyBaseline.settle(");
    // 窗口前台判定（document.hasFocus）要传进 settle：前台只更新基线、不发横幅（第八轮 H4）
    expect(src).toMatch(/notifyBaseline\.settle\(\s*data,[\s\S]{0,200}document\.hasFocus\(\)/);
    // 不再有手工往返的 ref / 直接调 planInboxNotify
    expect(src).not.toContain("prevUnreadKeysRef");
    expect(src).not.toContain("baselineIncompleteRef");
    expect(src).not.toContain("planInboxNotify(");
  });

  it("use-mr-inbox 把数据原样交给决策函数、并原样执行结论（不改参 / 不吞结论）", () => {
    const src = read("src/hooks/use-mr-inbox.tsx").replace(/\s+/g, " ");
    // 通知 effect：data 原样传入（不能 `{ ...data, partial: false }` 绕过保护）、通知照结论发
    expect(src).toContain("const copy = notifyBaseline.settle( data,");
    expect(src).toContain("if (copy) sendTaskNotification(");
    // 扫描落 data：旧表取 dataRef、跟踪取 ref、partial 取响应、结论照写
    expect(src).toContain("prev: dataRef.current,");
    expect(src).toContain("partial: body.partial === true,");
    expect(src).toContain("tracker: scanTrackerRef.current,");
    expect(src).toContain("scanTrackerRef.current = decision.tracker;");
    expect(src).toContain("setScanNotice(decision.notice);");
    expect(src).toContain("setData(decision.data);");
  });

  it("面板用 formatInboxScanNotice 渲染，不再写死「下方为上次结果」", () => {
    const src = read("src/components/mr-inbox/mr-inbox-panel.tsx");
    expect(src).toContain("formatInboxScanNotice(scanNotice)");
    expect(src).not.toContain("最近一次扫描失败（下方为上次结果）");
  });

  it("route 把 incomplete 透传给客户端", () => {
    const src = read("src/app/api/mr-inbox/route.ts");
    expect(src).toContain("incomplete: result.incomplete");
  });
});
