/**
 * perf-journal（src/lib/server/perf-journal.ts）单测
 *
 * 钉死的语义：
 * - 与 timing-log 的本质区别：轮转保留、不截断（长期数据能留住）
 * - 并发 append 顺序 = 调用顺序；轮转不会和写入交错、不会产生半行
 * - 写失败 / 超大记录都不影响调用方
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createJournal } from "@/lib/server/perf-journal";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "fe-perf-journal-"));
  vi.spyOn(console, "debug").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

const lines = (file: string): Record<string, unknown>[] =>
  readFileSync(path.join(dir, file), "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);

describe("追加", () => {
  it("每条一行合法 JSON、自动补 ts、调用方给的 ts 不被覆盖", async () => {
    const j = createJournal({ dir });
    await j.append("a.jsonl", { n: 1 });
    await j.append("a.jsonl", { n: 2, ts: "2026-01-01T00:00:00.000Z" });
    const rows = lines("a.jsonl");
    expect(rows.map((r) => r.n)).toEqual([1, 2]);
    expect(typeof rows[0].ts).toBe("string");
    expect(rows[1].ts).toBe("2026-01-01T00:00:00.000Z");
  });

  it("并发 append 的落盘顺序 = 调用顺序", async () => {
    const j = createJournal({ dir });
    await Promise.all(Array.from({ length: 60 }, (_, i) => j.append("a.jsonl", { n: i })));
    expect(lines("a.jsonl").map((r) => r.n)).toEqual(Array.from({ length: 60 }, (_, i) => i));
  });
});

describe("轮转（不截断）", () => {
  it("超过 maxBytes 就轮转；保留 keep 个文件；留下的是最近的、连续的、每行完整", async () => {
    const j = createJournal({ dir, maxBytes: 400, keep: 3 });
    const total = 40;
    for (let i = 0; i < total; i++) await j.append("a.jsonl", { n: i, pad: "x".repeat(20) });

    const files = readdirSync(dir).filter((f) => f.startsWith("a.jsonl")).sort();
    expect(files).toEqual(["a.jsonl", "a.jsonl.1", "a.jsonl.2"]);

    // 从最老到最新拼起来：n 必须是以 total-1 结尾的连续递增序列、没有半行
    const all = [
      ...lines("a.jsonl.2"),
      ...lines("a.jsonl.1"),
      ...lines("a.jsonl"),
    ].map((r) => r.n as number);
    expect(all.at(-1)).toBe(total - 1);
    for (let i = 1; i < all.length; i++) expect(all[i]).toBe(all[i - 1] + 1);
    // 确实丢了最老的（受 keep 约束）、但没丢到只剩一点点
    expect(all.length).toBeLessThan(total);
    expect(all.length).toBeGreaterThan(10);
  });

  it("每个文件都不超过 maxBytes", async () => {
    const j = createJournal({ dir, maxBytes: 500, keep: 4 });
    for (let i = 0; i < 50; i++) await j.append("a.jsonl", { n: i, pad: "y".repeat(30) });
    for (const f of readdirSync(dir)) {
      expect(readFileSync(path.join(dir, f)).length).toBeLessThanOrEqual(500);
    }
  });

  it("keep=1：轮转 = 清空当前文件（只留最新的）", async () => {
    const j = createJournal({ dir, maxBytes: 200, keep: 1 });
    for (let i = 0; i < 20; i++) await j.append("a.jsonl", { n: i, pad: "z".repeat(40) });
    expect(readdirSync(dir)).toEqual(["a.jsonl"]);
    expect(lines("a.jsonl").at(-1)?.n).toBe(19);
  });

  it("不同文件各自轮转、互不影响", async () => {
    const j = createJournal({ dir, maxBytes: 300, keep: 2 });
    for (let i = 0; i < 15; i++) await j.append("a.jsonl", { n: i, pad: "p".repeat(30) });
    await j.append("b.jsonl", { n: 1 });
    expect(readdirSync(dir).filter((f) => f.startsWith("b.jsonl"))).toEqual(["b.jsonl"]);
  });
});

describe("故障与边界：绝不影响调用方", () => {
  it("目录不可创建（路径被一个文件占了）→ append 不抛、resolve", async () => {
    const blocker = path.join(dir, "blocker");
    writeFileSync(blocker, "x");
    const j = createJournal({ dir: path.join(blocker, "sub") });
    await expect(j.append("a.jsonl", { n: 1 })).resolves.toBeUndefined();
    // 失败后链还活着：后面的写入不受影响
    const j2 = createJournal({ dir });
    await expect(j2.append("ok.jsonl", { n: 1 })).resolves.toBeUndefined();
    expect(lines("ok.jsonl")).toHaveLength(1);
  });

  it("单条超大 → 降级为只留标识的合法 JSON，不撑爆日志", async () => {
    const j = createJournal({ dir });
    await j.append("a.jsonl", { taskId: "t1", huge: "h".repeat(100_000) });
    const [row] = lines("a.jsonl");
    expect(row.truncated).toBe(true);
    expect(row.taskId).toBe("t1");
    expect(row.keys).toContain("huge");
    expect(JSON.stringify(row).length).toBeLessThan(2000);
  });

  it("flush 等到已排队的写入全部落盘", async () => {
    const j = createJournal({ dir });
    for (let i = 0; i < 10; i++) void j.append("a.jsonl", { n: i });
    await j.flush();
    expect(lines("a.jsonl")).toHaveLength(10);
  });
});
