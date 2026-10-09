/**
 * MCP 探活的 stale-while-revalidate（src/lib/server/mcp-probe.ts）单测
 *
 * 背景：实测 main.log 1543 次 filterHealthyMcp，约 70% 全 miss——热 miss 里一半落在「距上次 5~30 分钟」，
 * 即用户回复的间隔天然比 5min TTL 长，每次回来都要同步等一轮探测（最慢那个 server 决定，上限 6s）。
 * 改成：ok 过了 TTL 但还在 30min 窗口内 → 先用旧结果、后台重探；等后台最多 300ms，
 * 连接被拒 / DNS 失败这类硬失败几乎秒回，当场采用并剔除，不会把已挂的 server 注入给 SDK。
 *
 * 钉死的语义（任一被顺手改坏都是「静默回归」）：
 * - fresh 不探；stale ok 不阻塞发送；fail 过期 / 超窗口 / 无缓存必须同步重探（沿用旧 fail 会把修好的服务继续剔掉）
 * - single-flight：并发的 filter / warm 对同一 server 只发一次探测
 * - invalidate（run 失败收口调）之后，在它之前发出的在飞探测结果不得回写缓存
 */
import type { McpServerConfig } from "@cursor/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  filterHealthyMcp,
  invalidateMcpProbeCache,
  warmMcpProbe,
} from "@/lib/server/mcp-probe";

const TTL = 5 * 60_000;
const STALE_WINDOW = 30 * 60_000;
const GRACE = 300;

/** 显式 type: http —— POST initialize 只发一次、不兜底 GET，探测次数可精确断言 */
const SERVERS: Record<string, McpServerConfig> = {
  a: { url: "http://mcp.test/a/mcp", type: "http" },
};

type Pending = {
  resolve: (r: Response) => void;
  reject: (e: unknown) => void;
};

/** 桩掉 fetch：每次调用挂起，由测试决定何时回什么（可精确模拟「慢探测」/「秒回失败」） */
const stubFetch = () => {
  const pending: Pending[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(
      () =>
        new Promise<Response>((resolve, reject) => {
          pending.push({ resolve, reject });
        }),
    ),
  );
  return pending;
};

const ok = () => new Response(null, { status: 200 });
const http = (status: number) => new Response(null, { status });
const refused = () =>
  Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
  });

/** 让已排队的微任务 / 0ms 定时器跑完（探测是 async 链、需要多轮） */
const settle = () => vi.advanceTimersByTimeAsync(0);

let pending: Pending[];
let logs: string[];

beforeEach(() => {
  vi.useFakeTimers();
  invalidateMcpProbeCache();
  pending = stubFetch();
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    logs.push(a.map(String).join(" "));
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** 真探一次把缓存填上（首次必同步探） */
const prime = async (answer: () => Response | Error = ok) => {
  const p = filterHealthyMcp(SERVERS);
  await settle();
  const a = answer();
  if (a instanceof Error) pending[pending.length - 1].reject(a);
  else pending[pending.length - 1].resolve(a);
  return p;
};

describe("fresh / miss", () => {
  it("无缓存 → 同步探测一次；TTL 内再调 → fresh，不再发探测", async () => {
    const first = await prime();
    expect(first.stats).toMatchObject({ total: 1, fresh: 0, stale: 0, probedSync: 1 });
    expect(Object.keys(first.servers)).toEqual(["a"]);
    expect(pending).toHaveLength(1);

    vi.advanceTimersByTime(TTL - 1000);
    const second = await filterHealthyMcp(SERVERS);
    expect(second.stats).toMatchObject({ fresh: 1, stale: 0, probedSync: 0, cacheHits: 1 });
    expect(pending).toHaveLength(1);
  });
});

describe("stale ok：先用旧结果、后台重探", () => {
  it("后台探测慢（超过 grace）→ 不阻塞：用旧 ok 返回，waitMs≈grace，不是探测耗时", async () => {
    await prime();
    vi.advanceTimersByTime(TTL + 1000);

    const t = pending.length;
    const p = filterHealthyMcp(SERVERS);
    await vi.advanceTimersByTimeAsync(GRACE + 10);
    const r = await p;

    expect(Object.keys(r.servers)).toEqual(["a"]);
    expect(r.dropped).toEqual([]);
    expect(r.stats).toMatchObject({ stale: 1, probedSync: 0, staleRefreshedInGrace: 0, cacheHits: 1 });
    expect(r.stats?.waitMs).toBeLessThan(1000);
    // 后台确实发起了重探
    expect(pending).toHaveLength(t + 1);
  });

  it("后台探测稍后回 fail → 缓存更新为 fail，下一次 filter 剔除", async () => {
    await prime();
    vi.advanceTimersByTime(TTL + 1000);
    const t = pending.length;
    const p = filterHealthyMcp(SERVERS);
    await vi.advanceTimersByTimeAsync(GRACE + 10);
    await p;

    pending[t].resolve(http(500));
    await settle();

    const next = await filterHealthyMcp(SERVERS);
    expect(next.dropped.map((d) => d.name)).toEqual(["a"]);
    expect(Object.keys(next.servers)).toEqual([]);
    // fail 刚写入、在 TTL 内 → fresh
    expect(next.stats?.fresh).toBe(1);
  });

  it("grace 内秒回硬失败（连接被拒）→ 当场采用并剔除，不把已挂的 server 注入", async () => {
    await prime();
    vi.advanceTimersByTime(TTL + 1000);
    const t = pending.length;

    const p = filterHealthyMcp(SERVERS);
    await settle(); // 让后台探测发出
    pending[t].reject(refused());
    const r = await p; // 不需要推进到 grace

    expect(r.dropped.map((d) => d.name)).toEqual(["a"]);
    expect(r.dropped[0].detail).toContain("ECONNREFUSED");
    expect(r.stats).toMatchObject({ stale: 1, staleRefreshedInGrace: 1 });
  });

  it("grace 内回 ok → 采用新结果并续期（再调 filter 是 fresh）", async () => {
    await prime();
    vi.advanceTimersByTime(TTL + 1000);
    const t = pending.length;

    const p = filterHealthyMcp(SERVERS);
    await settle();
    pending[t].resolve(ok());
    const r = await p;
    expect(r.stats).toMatchObject({ stale: 1, staleRefreshedInGrace: 1 });
    expect(Object.keys(r.servers)).toEqual(["a"]);

    const again = await filterHealthyMcp(SERVERS);
    expect(again.stats).toMatchObject({ fresh: 1, stale: 0 });
    expect(pending).toHaveLength(t + 1);
  });
});

describe("必须同步重探的情形", () => {
  it("fail 过期（哪怕仍在 30min 内）→ 同步重探：用户多半刚授权 / 刚修好，不能沿用旧 fail", async () => {
    await prime(() => http(401));
    vi.advanceTimersByTime(TTL + 1000);

    const t = pending.length;
    const p = filterHealthyMcp(SERVERS);
    await settle();
    expect(pending).toHaveLength(t + 1);
    pending[t].resolve(ok()); // 这次授权好了
    const r = await p;

    expect(r.stats).toMatchObject({ stale: 0, probedSync: 1 });
    expect(Object.keys(r.servers)).toEqual(["a"]);
  });

  it("ok 超出 stale 窗口 → 同步重探", async () => {
    await prime();
    vi.advanceTimersByTime(STALE_WINDOW + 1000);

    const t = pending.length;
    const p = filterHealthyMcp(SERVERS);
    await settle();
    pending[t].resolve(ok());
    const r = await p;
    expect(r.stats).toMatchObject({ stale: 0, probedSync: 1 });
  });
});

describe("single-flight", () => {
  it("并发的 filter / warm 对同一 stale server 只发一次探测", async () => {
    await prime();
    vi.advanceTimersByTime(TTL + 1000);
    const t = pending.length;

    const p1 = filterHealthyMcp(SERVERS);
    const p2 = filterHealthyMcp(SERVERS);
    const w = warmMcpProbe(SERVERS);
    await vi.advanceTimersByTimeAsync(GRACE + 10);
    await Promise.all([p1, p2]);

    expect(pending).toHaveLength(t + 1);
    pending[t].resolve(ok());
    const warmed = await w;
    expect(warmed.refreshed).toBe(1);
  });
});

describe("invalidate（run 失败收口）", () => {
  it("清缓存后，在它之前发出的在飞探测的结果不得回写缓存；之后 filter 必须真探", async () => {
    await prime();
    vi.advanceTimersByTime(TTL + 1000);
    const t = pending.length;

    const p = filterHealthyMcp(SERVERS);
    await vi.advanceTimersByTimeAsync(GRACE + 10);
    await p; // stale 命中，后台探测 pending[t] 还挂着

    invalidateMcpProbeCache();
    pending[t].resolve(ok()); // 旧探测此刻才回来——不能把它写回缓存
    await settle();

    const p2 = filterHealthyMcp(SERVERS);
    await settle();
    expect(pending).toHaveLength(t + 2); // 又发了新探测
    pending[t + 1].resolve(ok());
    const r2 = await p2;
    expect(r2.stats).toMatchObject({ probedSync: 1, fresh: 0, stale: 0 });
  });
});

describe("warmMcpProbe（回到窗口 / 聚焦输入框时的预热）", () => {
  it("fresh 的跳过、stale / 无缓存的后台刷新；预热完 filter 全 fresh 且不再发探测", async () => {
    // 无缓存 → 预热要探
    const w1 = warmMcpProbe(SERVERS);
    await settle();
    expect(pending).toHaveLength(1);
    pending[0].resolve(ok());
    expect(await w1).toMatchObject({ total: 1, refreshed: 1, skippedFresh: 0 });

    // 现在是 fresh → 预热跳过
    expect(await warmMcpProbe(SERVERS)).toMatchObject({ refreshed: 0, skippedFresh: 1 });
    expect(pending).toHaveLength(1);

    // 过了 TTL → stale，预热刷新
    vi.advanceTimersByTime(TTL + 1000);
    const w2 = warmMcpProbe(SERVERS);
    await settle();
    expect(pending).toHaveLength(2);
    pending[1].resolve(ok());
    expect(await w2).toMatchObject({ refreshed: 1, skippedFresh: 0 });

    const r = await filterHealthyMcp(SERVERS);
    expect(r.stats).toMatchObject({ fresh: 1, stale: 0, probedSync: 0 });
    expect(pending).toHaveLength(2);
  });

  it("预热不抛：探测失败只是把 fail 写进缓存", async () => {
    const w = warmMcpProbe(SERVERS);
    await settle();
    pending[0].reject(refused());
    await expect(w).resolves.toMatchObject({ total: 1, refreshed: 1 });
  });
});

describe("日志口径（分析脚本依赖前缀与前两个字段，只能往后追加）", () => {
  it("cacheHits 含 stale（都没同步等待）；probed 只含同步探测；追加 stale / graceHit / waitMs", async () => {
    await prime();
    vi.advanceTimersByTime(TTL + 1000);
    const p = filterHealthyMcp(SERVERS);
    await vi.advanceTimersByTimeAsync(GRACE + 10);
    await p;

    const line = logs.filter((l) => l.includes("[mcp-probe] filterHealthyMcp")).at(-1) ?? "";
    expect(line).toMatch(/^\[mcp-probe\] filterHealthyMcp cacheHits=1\/1 probed=0 /);
    expect(line).toMatch(/ stale=1 /);
    expect(line).toMatch(/ graceHit=0 /);
    expect(line).toMatch(/ waitMs=\d+$/);
  });
});
