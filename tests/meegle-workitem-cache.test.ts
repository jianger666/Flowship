/**
 * fetchWorkitemDetail 进程内缓存：TTL 过期重拉 / 手动失效 / 换账号清空 / 失败不缓存
 *
 * 不真跑 meegle CLI：mock 掉串行队列（runMeegle 的唯一出口），数它被调了几次。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { enqueueMeegle } = vi.hoisted(() => ({
  enqueueMeegle: vi.fn<(run: () => Promise<unknown>) => Promise<unknown>>(),
}));

vi.mock("@/lib/server/meegle-queue", () => ({ enqueueMeegle }));
// feishu-cli 只借 meegleBin / 注册失效回调——桩掉，免得拉进整条 CLI 依赖
vi.mock("@/lib/server/feishu-cli", () => ({
  meegleBin: () => "/nonexistent/meegle",
  registerMeegleIdentityCacheInvalidator: () => undefined,
}));

const {
  fetchWorkitemDetail,
  invalidateMeegleIdentityCaches,
  invalidateWorkitemDetailCache,
  WORKITEM_DETAIL_TTL_MS,
} = await import("@/lib/server/meegle-cli");

/** 每次 CLI 调用返回不同的 name，方便区分「读的是缓存还是新拉的」 */
let seq = 0;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-13T10:00:00Z"));
  seq = 0;
  enqueueMeegle.mockReset();
  enqueueMeegle.mockImplementation(async () => {
    seq += 1;
    return { data: { name: `v${seq}` } };
  });
  invalidateWorkitemDetailCache();
});

afterEach(() => {
  invalidateWorkitemDetailCache();
  vi.useRealTimers();
});

describe("fetchWorkitemDetail 缓存", () => {
  it("TTL 内重复读命中缓存、不再打 CLI", async () => {
    expect((await fetchWorkitemDetail("1001", "p")).name).toBe("v1");
    vi.advanceTimersByTime(WORKITEM_DETAIL_TTL_MS - 1);
    expect((await fetchWorkitemDetail("1001", "p")).name).toBe("v1");
    expect(enqueueMeegle).toHaveBeenCalledTimes(1);
  });

  it("超过 TTL 后重新拉取（不再永不过期）", async () => {
    expect((await fetchWorkitemDetail("1001", "p")).name).toBe("v1");
    vi.advanceTimersByTime(WORKITEM_DETAIL_TTL_MS + 1);
    expect((await fetchWorkitemDetail("1001", "p")).name).toBe("v2");
    expect(enqueueMeegle).toHaveBeenCalledTimes(2);
    // 新值重新计时
    vi.advanceTimersByTime(WORKITEM_DETAIL_TTL_MS - 1);
    expect((await fetchWorkitemDetail("1001", "p")).name).toBe("v2");
    expect(enqueueMeegle).toHaveBeenCalledTimes(2);
  });

  it("手动失效：指定 id（+空间）只清对应条目，其余照旧", async () => {
    await fetchWorkitemDetail("1001", "p");
    await fetchWorkitemDetail("1002", "p");
    expect(enqueueMeegle).toHaveBeenCalledTimes(2);

    invalidateWorkitemDetailCache("1001", "p");
    expect((await fetchWorkitemDetail("1001", "p")).name).toBe("v3");
    // 1002 没被动
    expect((await fetchWorkitemDetail("1002", "p")).name).toBe("v2");
    expect(enqueueMeegle).toHaveBeenCalledTimes(3);
  });

  it("手动失效：只给 id 不给空间 → 该 id 在所有空间下都清", async () => {
    await fetchWorkitemDetail("1001", "p1");
    await fetchWorkitemDetail("1001", "p2");
    await fetchWorkitemDetail("1001");
    await fetchWorkitemDetail("1002", "p1");
    expect(enqueueMeegle).toHaveBeenCalledTimes(4);

    invalidateWorkitemDetailCache("1001");
    await fetchWorkitemDetail("1001", "p1");
    await fetchWorkitemDetail("1001", "p2");
    await fetchWorkitemDetail("1001");
    expect(enqueueMeegle).toHaveBeenCalledTimes(7);
    // 1002 不受影响
    await fetchWorkitemDetail("1002", "p1");
    expect(enqueueMeegle).toHaveBeenCalledTimes(7);
  });

  it("不传参 = 全清；换账号（invalidateMeegleIdentityCaches）也会清", async () => {
    await fetchWorkitemDetail("1001", "p");
    invalidateWorkitemDetailCache();
    await fetchWorkitemDetail("1001", "p");
    expect(enqueueMeegle).toHaveBeenCalledTimes(2);

    invalidateMeegleIdentityCaches();
    await fetchWorkitemDetail("1001", "p");
    expect(enqueueMeegle).toHaveBeenCalledTimes(3);
  });

  it("CLI 抛错不缓存：下一次读照常重试", async () => {
    enqueueMeegle.mockRejectedValueOnce(new Error("meegle down"));
    await expect(fetchWorkitemDetail("1001", "p")).rejects.toThrow(
      "meegle down",
    );
    expect((await fetchWorkitemDetail("1001", "p")).name).toBe("v1");
    expect(enqueueMeegle).toHaveBeenCalledTimes(2);
  });
});
