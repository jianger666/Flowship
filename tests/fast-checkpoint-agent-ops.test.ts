/**
 * FastCheckpoints.agentStats / prefetchAgent 单测（观测与预热用的两个只读钩子）
 *
 * 钉死的语义：
 * - 只读：不改文件、不改索引、不抢写队列——预热 / 观测不能改变 store 的行为
 * - agentStats 在索引未就绪时返回 null（不触发加载）
 * - prefetchAgent 只读最靠后的几个 blob、总量封顶；任何故障都吞掉
 * - 与写并发时数据不损坏（预读不与追加互相干扰）
 */
import fs from "node:fs";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { FastCheckpoints } from "@/lib/server/fast-checkpoint-store";

import {
  A,
  allBlobsOk,
  blobData,
  cleanupTmps,
  faultyFs,
  fileOf,
  loadSdk,
  mkFast,
  mkTmp,
  seed,
  type Sdk,
} from "./helpers/fast-store-helpers";

let sdk: Sdk;
beforeAll(async () => {
  sdk = await loadSdk();
});
afterEach(() => cleanupTmps());

describe("agentStats", () => {
  it("索引未就绪 → null（观测不触发加载）", () => {
    const dir = mkTmp();
    const cp = mkFast(dir, sdk);
    expect(cp.agentStats(A)).toBeNull();
  });

  it("按 agent 统计 blob 数与字节数；别的 agent 不计入", async () => {
    const dir = mkTmp();
    const cp = mkFast(dir, sdk);
    await seed(cp, 5, "agent-a");
    await seed(cp, 3, "agent-b");
    await cp.warmUp();
    const a = cp.agentStats("agent-a")!;
    const b = cp.agentStats("agent-b")!;
    expect(a.blobs).toBe(5);
    expect(b.blobs).toBe(3);
    expect(a.bytes).toBeGreaterThan(0);
    expect(cp.agentStats("agent-none")).toEqual({ blobs: 0, bytes: 0 });
    // 总量一致：两个 agent 的字节数之和 ≈ 文件里所有行的 body 总长（不含换行）
    expect(a.bytes + b.bytes).toBeLessThanOrEqual(cp.getStats().bytes);
  });

  it("是纯读：不改文件内容、不改 blob 计数", async () => {
    const dir = mkTmp();
    const cp = mkFast(dir, sdk);
    await seed(cp, 4);
    await cp.warmUp();
    const before = fs.readFileSync(fileOf(dir));
    const statsBefore = cp.getStats();
    cp.agentStats(A);
    cp.agentStats(A);
    expect(Buffer.compare(fs.readFileSync(fileOf(dir)), before)).toBe(0);
    expect(cp.getStats()).toEqual(statsBefore);
  });
});

describe("prefetchAgent", () => {
  it("只读最靠后（最近追加）的 maxBlobs 个，默认 3 个", async () => {
    const dir = mkTmp();
    const cp = mkFast(dir, sdk);
    await seed(cp, 10);
    await cp.warmUp();
    const r = await cp.prefetchAgent(A);
    expect(r.blobs).toBe(3);
    expect(r.bytes).toBeGreaterThan(0);
    const r2 = await cp.prefetchAgent(A, { maxBlobs: 5 });
    expect(r2.blobs).toBe(5);
  });

  it("总量封顶：maxBytes 到了就停，不会为了凑 blob 数超额读", async () => {
    const dir = mkTmp();
    const cp = mkFast(dir, sdk);
    // 每个 blob 约 200KB
    for (let i = 0; i < 6; i++) {
      await cp.create({ agentId: A, blobId: `big${i}`, data: Buffer.alloc(200_000, i + 1) });
    }
    await cp.warmUp();
    const r = await cp.prefetchAgent(A, { maxBlobs: 6, maxBytes: 450_000 });
    expect(r.blobs).toBeLessThan(6);
    expect(r.bytes).toBeLessThanOrEqual(450_000 * 1.5); // 单个 blob 的 base64 行比原始数据大 ~33%
    expect(r.blobs).toBeGreaterThanOrEqual(1);
  });

  it("没有该 agent / 空 store → {0,0}，不抛", async () => {
    const dir = mkTmp();
    const cp = mkFast(dir, sdk);
    expect(await cp.prefetchAgent("nobody")).toEqual({ blobs: 0, bytes: 0 });
    await seed(cp, 2);
    expect(await cp.prefetchAgent("nobody")).toEqual({ blobs: 0, bytes: 0 });
  });

  it("读文件出故障（open 抛 EIO）→ 吞掉返回 {0,0}，不抛、不影响后续正常读", async () => {
    const dir = mkTmp();
    let fail = false;
    const { fs: fx } = faultyFs({
      open: (_file, flags) => (fail && flags === "r" ? { code: "EIO" } : null),
    });
    const cp = mkFast(dir, sdk, { fs: fx, budgetMs: 50, sleep: async () => undefined });
    await seed(cp, 4);
    await cp.warmUp();
    fail = true;
    await expect(cp.prefetchAgent(A)).resolves.toEqual({ blobs: 0, bytes: 0 });
    fail = false;
    expect(await allBlobsOk(cp, 4)).toBe(true);
  });

  it("不改文件：预读前后字节完全一致、索引计数不变", async () => {
    const dir = mkTmp();
    const cp = mkFast(dir, sdk);
    await seed(cp, 6);
    await cp.warmUp();
    const before = fs.readFileSync(fileOf(dir));
    const statsBefore = cp.getStats();
    await cp.prefetchAgent(A);
    expect(Buffer.compare(fs.readFileSync(fileOf(dir)), before)).toBe(0);
    expect(cp.getStats().blobs).toBe(statsBefore.blobs);
    expect(cp.getStats().bytes).toBe(statsBefore.bytes);
  });

  it("与追加并发：预读不损坏数据，之后所有 blob（含并发写入的）都能读到", async () => {
    const dir = mkTmp();
    const cp = mkFast(dir, sdk);
    await seed(cp, 20);
    await cp.warmUp();
    const writes = (async () => {
      for (let i = 20; i < 40; i++) {
        await cp.create({ agentId: A, blobId: `b${i}`, data: blobData(i) });
      }
    })();
    const prefetches = Promise.all(Array.from({ length: 15 }, () => cp.prefetchAgent(A, { maxBlobs: 4 })));
    await Promise.all([writes, prefetches]);
    expect(await allBlobsOk(cp, 40)).toBe(true);
    // 且 SDK 原实现的 reader 读同一目录也一致（文件格式没被预读搞坏）
    const sdkReader = new sdk.JsonlLocalAgentStore(dir).checkpoints;
    expect(await allBlobsOk(sdkReader, 40)).toBe(true);
  });

  it("类型：返回值就是 FastCheckpoints 的方法（公共面没被破坏）", () => {
    expect(typeof FastCheckpoints.prototype.prefetchAgent).toBe("function");
    expect(typeof FastCheckpoints.prototype.agentStats).toBe("function");
  });
});
