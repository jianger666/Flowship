/**
 * D1 tool-output-budget 单测：
 * 不足预算原样过 / 超预算截断+缩小指引 / 中文不拦腰砍 /
 * read 64KB 与 shell 32KB / wrapper 只动 text part。
 */
import { describe, expect, it, vi } from "vitest";

import {
  MODEL_OUTPUT_DEFAULT_BUDGET,
  MODEL_OUTPUT_READ_BUDGET,
  truncateModelOutput,
  withModelBudget,
} from "@/lib/server/tool-output-budget";

describe("truncateModelOutput", () => {
  it("不足预算原样过", () => {
    const r = truncateModelOutput("hello", "shell");
    expect(r.truncated).toBe(false);
    expect(r.text).toBe("hello");
  });

  it("shell 超预算截断+后缀有缩小指引", () => {
    const big = `line\n`.repeat(20000);
    const r = truncateModelOutput(big, "shell");
    expect(r.truncated).toBe(true);
    expect(r.originalBytes).toBeGreaterThan(MODEL_OUTPUT_DEFAULT_BUDGET);
    expect(r.text).toContain("模型输入已截断");
    expect(r.text).toContain("shell→");
    expect(r.text).toContain("head/grep");
  });

  it("grep 后缀指引对版", () => {
    const big = "x".repeat(100 * 1024);
    const r = truncateModelOutput(big, "grep");
    expect(r.truncated).toBe(true);
    expect(r.text).toContain("grep→");
    expect(r.text).toContain("缩小 pattern/path");
  });

  it("中文不被拦腰砍", () => {
    const big = "中".repeat(30000);
    const r = truncateModelOutput(big, "shell", 32 * 1024);
    expect(r.truncated).toBe(true);
    // 尾部不允许出现半个 UTF-8 字符（U+FFFD）
    expect(r.text).not.toContain("�");
    // 主体（含落盘风后缀）不超预算太多（指引后缀挂配额外、<1KB）
    expect(Buffer.byteLength(r.text, "utf-8")).toBeLessThan(33 * 1024 + 1024);
  });

  it("read 64KB、shell 32KB 各一个 case", () => {
    const s50k = "a".repeat(50 * 1024);
    expect(truncateModelOutput(s50k, "read").truncated).toBe(false);
    expect(truncateModelOutput(s50k, "shell").truncated).toBe(true);
    expect(MODEL_OUTPUT_READ_BUDGET).toBe(64 * 1024);
    expect(MODEL_OUTPUT_DEFAULT_BUDGET).toBe(32 * 1024);
  });
});

describe("withModelBudget", () => {
  it("超限 text 被截、details 保留、打 warn", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const def = {
        name: "shell",
        execute: async () => ({
          content: [{ type: "text", text: "y".repeat(100 * 1024) }],
          details: { exitCode: 0 },
        }),
      };
      const wrapped = withModelBudget(def);
      const out = (await wrapped.execute()) as {
        content: { type: string; text: string }[];
        details: { exitCode: number };
      };
      expect(out.details).toEqual({ exitCode: 0 });
      expect(out.content[0].text).toContain("模型输入已截断");
      expect(warn).toHaveBeenCalledOnce();
      expect(String(warn.mock.calls[0])).toContain("[tool-budget]");
      expect(String(warn.mock.calls[0])).toContain("tool=shell");
    } finally {
      warn.mockRestore();
    }
  });

  it("不足预算不打 warn、image part 原样", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const img = { type: "image", data: "z".repeat(200 * 1024) };
      const def = {
        name: "read",
        execute: async () => ({
          content: [{ type: "text", text: "short" }, img],
          details: undefined,
        }),
      };
      const out = (await withModelBudget(def).execute()) as {
        content: unknown[];
      };
      expect(out.content[1]).toBe(img);
      expect(out.content[0]).toEqual({ type: "text", text: "short" });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("形状未知直接放行", async () => {
    const def = { name: "x", execute: async () => "plain-string" };
    const out = await withModelBudget(def).execute();
    expect(out).toBe("plain-string");
  });
});
