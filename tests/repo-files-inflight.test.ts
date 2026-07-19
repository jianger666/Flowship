/**
 * getRepoFileIndex：in-flight 去重 + TTL 缓存
 *
 * 回归 P2 #10：首次扫描未完成时并发调用不得翻倍扫盘。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getRepoFileIndex } from "../src/lib/server/repo-files";

const CACHE_KEY = "__flowshipRepoFilesCacheV2__";

const clearCache = (): void => {
  const g = globalThis as unknown as Record<string, unknown>;
  delete g[CACHE_KEY];
};

describe("getRepoFileIndex in-flight / TTL", () => {
  let tmpRoot: string;
  let readdirSpy: ReturnType<typeof vi.spyOn> | undefined;

  beforeEach(async () => {
    clearCache();
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "fe-repo-files-"));
    await fs.writeFile(path.join(tmpRoot, "a.ts"), "export {};\n", "utf-8");
    await fs.mkdir(path.join(tmpRoot, "src"));
    await fs.writeFile(path.join(tmpRoot, "src", "b.ts"), "export {};\n", "utf-8");
  });

  afterEach(async () => {
    readdirSpy?.mockRestore();
    readdirSpy = undefined;
    clearCache();
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("并发两次调用复用同一扫描，readdir 次数与单次一致", async () => {
    readdirSpy = vi.spyOn(fs, "readdir");
    const [a, b] = await Promise.all([
      getRepoFileIndex(tmpRoot),
      getRepoFileIndex(tmpRoot),
    ]);
    const concurrentReads = readdirSpy.mock.calls.length;
    expect(a).toEqual(b);
    expect(a.some((e) => e.path === "a.ts")).toBe(true);

    clearCache();
    readdirSpy.mockClear();
    await getRepoFileIndex(tmpRoot);
    const singleReads = readdirSpy.mock.calls.length;
    expect(concurrentReads).toBe(singleReads);
  });

  it("TTL 内第三次调用命中缓存，不再 readdir", async () => {
    readdirSpy = vi.spyOn(fs, "readdir");
    await getRepoFileIndex(tmpRoot);
    const afterFirst = readdirSpy.mock.calls.length;
    expect(afterFirst).toBeGreaterThan(0);

    readdirSpy.mockClear();
    const cached = await getRepoFileIndex(tmpRoot);
    expect(readdirSpy.mock.calls.length).toBe(0);
    expect(cached.some((e) => e.path === "a.ts")).toBe(true);
  });
});
