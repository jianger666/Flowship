/**
 * persistTruncatedOutput：写盘失败不带 fullPath；截断总长 ≤ limit（UTF-8 字节）
 *
 * 回归 P2 #11：落盘失败仍 truncated=true 但无 fullPath，避免前端出必 404 按钮。
 * 回归 S7：判限 / 截断按 UTF-8 字节，落在 code point 边界。
 * DATA_DIR 须在动态 import 前钉死（与 delete-task-tombstone 同构）。
 */
import { mkdtempSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-tool-result-persist-"));
process.env.FLOWSHIP_DATA_DIR = TMP_ROOT;

const {
  persistTruncatedOutput,
  sanitizeCallIdForPath,
  TOOL_RESULT_OUTPUT_LIMIT,
  TOOL_RESULT_DIFF_LIMIT,
  truncateToLimit,
  UNKNOWN_CALL_ID_FALLBACK,
} = await import("../src/lib/server/tool-result-persist");

const utf8Bytes = (s: string): number => Buffer.byteLength(s, "utf8");

afterEach(() => {
  vi.restoreAllMocks();
});

describe("persistTruncatedOutput", () => {
  it("写盘失败 → truncated 且无 fullPath", async () => {
    vi.spyOn(fs, "writeFile").mockRejectedValueOnce(new Error("ENOSPC"));
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const full = "x".repeat(TOOL_RESULT_OUTPUT_LIMIT + 100);
    const result = await persistTruncatedOutput("task-p2-11", "call_1", full);

    expect(result.truncated).toBe(true);
    expect(result.fullPath).toBeUndefined();
    expect(result.output.length).toBeLessThan(full.length);
    expect(utf8Bytes(result.output)).toBeLessThanOrEqual(TOOL_RESULT_OUTPUT_LIMIT);
  });

  it("写盘成功 → truncated + fullPath，且 output 总字节 ≤ limit", async () => {
    const full = "y".repeat(TOOL_RESULT_OUTPUT_LIMIT + 50);
    const result = await persistTruncatedOutput("task-p2-11-ok", "call_ok", full);

    expect(result.truncated).toBe(true);
    expect(result.fullPath).toMatch(/^tool-outputs\/.+\.txt$/);
    expect(result.output.length).toBeLessThan(full.length);
    expect(utf8Bytes(result.output)).toBeLessThanOrEqual(TOOL_RESULT_OUTPUT_LIMIT);
  });

  it("中文超 8KB UTF-8 → 截断落盘（不再按 string.length 漏判）", async () => {
    // 8192 个汉字 ≈ 24KB UTF-8，旧实现会当成未超限
    const full = "中".repeat(TOOL_RESULT_OUTPUT_LIMIT);
    expect(full.length).toBeLessThanOrEqual(TOOL_RESULT_OUTPUT_LIMIT);
    expect(utf8Bytes(full)).toBeGreaterThan(TOOL_RESULT_OUTPUT_LIMIT);

    const result = await persistTruncatedOutput("task-s7-zh", "call_zh", full);
    expect(result.truncated).toBe(true);
    expect(result.fullPath).toBeDefined();
    expect(utf8Bytes(result.output)).toBeLessThanOrEqual(TOOL_RESULT_OUTPUT_LIMIT);
    expect(result.output).not.toContain("\uFFFD");
  });
});

describe("truncateToLimit", () => {
  it("ASCII：含后缀总字节不超过 limit（output / diff 契约）", () => {
    const over = "z".repeat(TOOL_RESULT_OUTPUT_LIMIT + 200);
    const out = truncateToLimit(over, TOOL_RESULT_OUTPUT_LIMIT);
    expect(utf8Bytes(out)).toBeLessThanOrEqual(TOOL_RESULT_OUTPUT_LIMIT);
    expect(out).toMatch(/…\(truncated \d+ chars\)$/);
    // ASCII 1 字符 = 1 字节：正文保留量与旧语义同阶（后缀占配额）
    expect(out.startsWith("z")).toBe(true);

    const overDiff = "d".repeat(TOOL_RESULT_DIFF_LIMIT + 80);
    const diff = truncateToLimit(overDiff, TOOL_RESULT_DIFF_LIMIT);
    expect(utf8Bytes(diff)).toBeLessThanOrEqual(TOOL_RESULT_DIFF_LIMIT);
  });

  it("中文超限：按 UTF-8 字节截断且无乱码", () => {
    const over = "测".repeat(4000); // 每字 3 字节 → 12KB
    const out = truncateToLimit(over, TOOL_RESULT_OUTPUT_LIMIT);
    expect(utf8Bytes(out)).toBeLessThanOrEqual(TOOL_RESULT_OUTPUT_LIMIT);
    expect(out).toMatch(/…\(truncated \d+ chars\)$/);
    expect(out).not.toContain("\uFFFD");
    // 截断落在字符边界：去掉后缀后每个码点仍是「测」
    const body = out.replace(/…\(truncated \d+ chars\)$/, "");
    expect([...body].every((ch) => ch === "测")).toBe(true);
  });

  it("emoji（surrogate pair）边界：不切半、无 U+FFFD", () => {
    // 😀 = U+1F600，UTF-16 两码元，UTF-8 4 字节
    const over = "😀".repeat(3000); // 12KB
    const out = truncateToLimit(over, TOOL_RESULT_OUTPUT_LIMIT);
    expect(utf8Bytes(out)).toBeLessThanOrEqual(TOOL_RESULT_OUTPUT_LIMIT);
    expect(out).not.toContain("\uFFFD");
    const body = out.replace(/…\(truncated \d+ chars\)$/, "");
    expect([...body].every((ch) => ch === "😀")).toBe(true);
    // 无孤立 surrogate
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(body)).toBe(
      false,
    );
  });

  it("后缀计入 UTF-8 字节预算", () => {
    const limit = 64;
    const over = "a".repeat(200);
    const out = truncateToLimit(over, limit);
    expect(utf8Bytes(out)).toBeLessThanOrEqual(limit);
    expect(out).toMatch(/…\(truncated \d+ chars\)$/);
    const suffixMatch = out.match(/…\(truncated \d+ chars\)$/);
    expect(suffixMatch).not.toBeNull();
    const suffixBytes = utf8Bytes(suffixMatch![0]);
    const bodyBytes = utf8Bytes(out.slice(0, out.length - suffixMatch![0].length));
    expect(bodyBytes + suffixBytes).toBe(utf8Bytes(out));
    expect(bodyBytes + suffixBytes).toBeLessThanOrEqual(limit);
    // 正文未吃满整个 limit（后缀占了配额）
    expect(bodyBytes).toBeLessThan(limit);
  });

  it("未超限原样返回", () => {
    const s = "hello 世界 😀";
    expect(truncateToLimit(s, TOOL_RESULT_OUTPUT_LIMIT)).toBe(s);
  });
});

describe("sanitizeCallIdForPath", () => {
  it("空 callId 固定回退 call_unknown（写读一致）", () => {
    expect(sanitizeCallIdForPath("")).toBe(UNKNOWN_CALL_ID_FALLBACK);
    expect(sanitizeCallIdForPath("call_abc")).toBe("call_abc");
    // 两次空串同一回退（旧实现 Date.now 写读不一致）
    expect(sanitizeCallIdForPath("")).toBe(sanitizeCallIdForPath(""));
  });
});
