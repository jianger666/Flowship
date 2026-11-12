/**
 * 会话管理页「清理缓存」的文案与判定（纯逻辑）。
 * 钉两件事：① 确认框把「清什么 / 不清什么 / 后果」说清；② toast 只说实际做了的事，在忙跳过的如实说。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildCachesCleanedToast,
  buildCachesConfirmDescription,
  buildNothingToCleanMessage,
  formatCacheBytes,
  isNothingToClean,
  type CachesCleanupResult,
  type CachesSummary,
} from "@/lib/cache-cleanup-text";

const summary = (over: Partial<CachesSummary> = {}): CachesSummary => ({
  archivedHolders: 0,
  archivedPiBytes: 0,
  orphanFiles: 0,
  orphanBytes: 0,
  orphanSkipped: false,
  ...over,
});

const result = (over: Partial<CachesCleanupResult> = {}): CachesCleanupResult => ({
  ok: true,
  released: 0,
  skippedBusy: 0,
  skippedKept: 0,
  piBytesFreed: 0,
  orphanFilesDeleted: 0,
  orphanBytesFreed: 0,
  orphanSkipped: false,
  gcTriggered: false,
  ...over,
});

describe("formatCacheBytes", () => {
  it.each([
    [0, "0 B"],
    [1023, "1023 B"],
    [1024, "1 KB"],
    [5 * 1024 * 1024, "5.0 MB"],
    [716 * 1024 * 1024, "716.0 MB"],
    [2.65 * 1024 * 1024 * 1024, "2.65 GB"],
  ])("%d → %s", (n, text) => {
    expect(formatCacheBytes(n)).toBe(text);
  });
});

describe("isNothingToClean", () => {
  it("两类都为 0 才算没东西；只有孤儿 / 只有已归档都算有", () => {
    expect(isNothingToClean(summary())).toBe(true);
    expect(isNothingToClean(summary({ archivedHolders: 1 }))).toBe(false);
    expect(isNothingToClean(summary({ orphanFiles: 3 }))).toBe(false);
  });

  it("孤儿读不出（orphanSkipped）本身不算「有东西」", () => {
    expect(isNothingToClean(summary({ orphanSkipped: true }))).toBe(true);
  });
});

describe("buildNothingToCleanMessage：区分「确实没有」与「这类没法判断」（R15-16）", () => {
  it("确实没有：说没有需要清理的缓存", () => {
    expect(buildNothingToCleanMessage(summary())).toBe("没有需要清理的缓存");
  });

  it("孤儿读不出：不能说成「没有」，要说明有一类这次没法判断", () => {
    const t = buildNothingToCleanMessage(summary({ orphanSkipped: true }));
    expect(t).not.toBe("没有需要清理的缓存");
    expect(t).toContain("没引用的对话文件这次不动");
    expect(t).toContain("并不是确认没有");
  });
});

describe("buildCachesConfirmDescription", () => {
  it("两类都有：各自说数量（和大小），并交代不受影响的东西与后果", () => {
    const t = buildCachesConfirmDescription(
      summary({ archivedHolders: 182, archivedPiBytes: 254 * 1024 * 1024, orphanFiles: 496, orphanBytes: 716 * 1024 * 1024 }),
    );
    expect(t).toContain("182 个已归档的会话还占着对话缓存");
    expect(t).toContain("会话文件约 254.0 MB");
    expect(t).toContain("496 个没有任何会话引用的对话文件（约 716.0 MB）");
    expect(t).toContain("会话内容、事件记录和代码都不受影响");
    expect(t).toContain("从事件记录重新接上对话");
    expect(t).toContain("不一定立刻变小");
  });

  it("只有已归档：不提孤儿文件；Cursor 会话量不出大小就不编造会话文件体积", () => {
    const t = buildCachesConfirmDescription(summary({ archivedHolders: 3 }));
    expect(t).toContain("3 个已归档的会话还占着对话缓存");
    expect(t).not.toContain("会话文件约");
    expect(t).not.toContain("没有任何会话引用");
  });

  it("活名单读不出时如实说孤儿这类这次不动", () => {
    const t = buildCachesConfirmDescription(summary({ archivedHolders: 1, orphanSkipped: true }));
    expect(t).toContain("没引用的对话文件这次不动");
  });
});

describe("buildCachesCleanedToast", () => {
  it("放掉了会话缓存 + 删了孤儿文件：各说各的数字", () => {
    const t = buildCachesCleanedToast(
      result({
        released: 12,
        piBytesFreed: 10 * 1024 * 1024,
        orphanFilesDeleted: 496,
        orphanBytesFreed: 716 * 1024 * 1024,
      }),
    );
    expect(t).toBe("已放掉 12 个已归档会话的缓存（释放 10.0 MB）、删除 496 个无引用的对话文件（716.0 MB）");
  });

  it("没有释放字节（Cursor 会话）就不写「释放 0 B」", () => {
    expect(buildCachesCleanedToast(result({ released: 5 }))).toBe("已放掉 5 个已归档会话的缓存");
  });

  it("在忙跳过的如实说（busy + kept 合计）", () => {
    expect(buildCachesCleanedToast(result({ released: 1, skippedBusy: 2, skippedKept: 1 }))).toBe(
      "已放掉 1 个已归档会话的缓存、3 个会话正忙或刚被接管、这次没动",
    );
  });

  it("什么都没做：不谎报", () => {
    expect(buildCachesCleanedToast(result())).toBe("没有需要清理的缓存");
  });

  it("什么都没做、但孤儿那类没法判断：不说「没有」，如实说这类没动", () => {
    const t = buildCachesCleanedToast(result({ orphanSkipped: true }));
    expect(t).not.toBe("没有需要清理的缓存");
    expect(t).toContain("没引用的对话文件这次不动");
  });

  it("做了点事、同时孤儿没法判断：在结尾补一句，别让人以为孤儿已检查过", () => {
    expect(buildCachesCleanedToast(result({ released: 2, orphanSkipped: true }))).toBe(
      "已放掉 2 个已归档会话的缓存、有会话的数据读不出来，没引用的对话文件这次不动",
    );
  });
});

describe("老任务保留的说明（评审 R16-03）", () => {
  it("清理完的 toast：保留了几个老任务要如实说，并解释原因", () => {
    const t = buildCachesCleanedToast(result({ released: 2, skippedLegacy: 3 }));
    expect(t).toContain("已放掉 2 个已归档会话的缓存");
    expect(t).toContain("3 个较早创建的会话没有记录提供方");
    expect(t).toContain("已保留");
  });

  it("只有老任务被保留、其它什么都没做：不能说成「没有需要清理的缓存」就完事（用户会不知道有保留）", () => {
    const t = buildCachesCleanedToast(result({ skippedLegacy: 2 }));
    expect(t).not.toBe("没有需要清理的缓存");
    expect(t).toContain("2 个较早创建的会话没有记录提供方");
  });

  it("没东西可清 + 有保留：提示里带上保留数；没有保留时文案不变", () => {
    expect(buildNothingToCleanMessage(summary({ legacyKept: 4 }))).toContain("另有 4 个较早创建的会话");
    expect(buildNothingToCleanMessage(summary())).toBe("没有需要清理的缓存");
    expect(buildNothingToCleanMessage(summary({ legacyKept: 0 }))).toBe("没有需要清理的缓存");
  });

  it("确认框：有保留时在结尾补一句；legacyKept 不计入「将清理」的数量", () => {
    const t = buildCachesConfirmDescription(summary({ archivedHolders: 5, legacyKept: 2 }));
    expect(t).toContain("5 个已归档的会话");
    expect(t).toContain("另有 2 个较早创建的会话没有记录提供方");
    expect(buildCachesConfirmDescription(summary({ archivedHolders: 5 }))).not.toContain("较早创建");
  });

  it("legacyKept 不影响「有没有东西可清」的判定（它们本来就不清）", () => {
    expect(isNothingToClean(summary({ legacyKept: 9 }))).toBe(true);
  });

  it("孤儿没法判断 + 有保留：两句话都在，用同一对括号", () => {
    const t = buildCachesConfirmDescription(summary({ archivedHolders: 1, orphanSkipped: true, legacyKept: 1 }));
    expect(t).toContain("没引用的对话文件这次不动");
    expect(t).toContain("较早创建的会话");
  });
});

describe("会话页接线（源码契约）", () => {
  it("「没东西可清」的提示走 buildNothingToCleanMessage，页面里不再写死「没有需要清理的缓存」", () => {
    const src = readFileSync(path.join(__dirname, "..", "src", "app", "sessions", "page.tsx"), "utf8");
    expect(src).toMatch(/toast\.info\(buildNothingToCleanMessage\(summary\)\)/);
    expect(src).not.toContain("没有需要清理的缓存");
  });
});
