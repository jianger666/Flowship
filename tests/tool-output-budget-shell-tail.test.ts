/**
 * 进模型预算：shell 超预算保留「开头 + 结尾」（R14 Q11-04）
 *
 * 构建 / 测试命令的失败原因几乎都在输出末尾。改前所有工具同口径「只留前 32KB」，
 * shell 的尾部报错被整段砍掉；改后 shell 用同一份落盘预览的 `truncateHeadTail`（头 8KB + 尾约 24KB），
 * 其余工具仍只留头部（不在本批范围、行为不变）。
 *
 * 纯函数 + `withModelBudget` 包装层，不起子进程（真 shell 的端到端在 shell-status-note.test.ts）。
 * DATA_DIR 钉到临时目录（与 tool-output-spill.test.ts 同构：静态 import 会提前冻结到真实数据目录）。
 */
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

process.env.FLOWSHIP_DATA_DIR = mkdtempSync(path.join(os.tmpdir(), "fe-budget-tail-"));

const {
  MODEL_OUTPUT_DEFAULT_BUDGET,
  SHELL_MODEL_HEAD_BYTES,
  truncateModelOutput,
  withModelBudget,
} = await import("../src/lib/server/tool-output-budget");

const bytes = (s: string): number => Buffer.byteLength(s, "utf-8");

/** 状态行 + 4000 行进度 + 末尾报错：总长约 100KB */
const longShellText = (): string =>
  [
    "（exit code 2）",
    ...Array.from({ length: 4000 }, (_, i) => `progress line number ${i + 1}`),
    "FATAL: boom at the very end",
  ].join("\n");

/** 指引后缀之前的主体 */
const bodyOf = (text: string): string => text.split("\n…(模型输入已截断")[0]!;

describe("truncateModelOutput · shell 头 + 尾", () => {
  it("预算内原样返回（shell 也一样）", () => {
    const r = truncateModelOutput("（exit code 1）\nsmall", "shell");
    expect(r.truncated).toBe(false);
    expect(r.text).toBe("（exit code 1）\nsmall");
  });

  it("超预算：第一行（状态行）仍在、最后一行（报错）仍在、中间被省略", () => {
    const r = truncateModelOutput(longShellText(), "shell");
    expect(r.truncated).toBe(true);
    expect(r.text.startsWith("（exit code 2）\n")).toBe(true);
    expect(r.text).toContain("progress line number 1\n");
    expect(r.text).toContain("FATAL: boom at the very end");
    expect(r.text).toMatch(/\n…\(省略 \d+ 字符\)…\n/);
    expect(r.text).not.toContain("progress line number 2000\n");
  });

  it("主体不超预算，尾部吃满开头之后的剩余配额（约 24KB，不是几百字节）", () => {
    const r = truncateModelOutput(longShellText(), "shell");
    const body = bodyOf(r.text);
    expect(bytes(body)).toBeLessThanOrEqual(MODEL_OUTPUT_DEFAULT_BUDGET);
    const marker = body.match(/\n…\(省略 \d+ 字符\)…\n/)!;
    const [head, tail] = body.split(marker[0]);
    // 开头吃满 8KB（不是只给几百字节 / 2KB），尾部拿到剩下的约 24KB
    expect(bytes(head!)).toBeGreaterThan(7 * 1024);
    expect(bytes(head!)).toBeLessThanOrEqual(SHELL_MODEL_HEAD_BYTES);
    expect(bytes(tail!)).toBeGreaterThan(20 * 1024);
  });

  it("开头字节数是 8KB（常量与导出一致）", () => {
    expect(SHELL_MODEL_HEAD_BYTES).toBe(8 * 1024);
  });

  it("指引后缀如实写「开头 8.0KB + 结尾」，不再写「前 N」（shell 给的不是前 N）", () => {
    const r = truncateModelOutput(longShellText(), "shell");
    expect(r.text).toContain("本次只给开头 8.0KB + 结尾，共 ");
    expect(r.text).not.toContain("本次只给前 ");
    expect(r.text).toMatch(/原文 \d+\.\dKB/);
  });

  it("有落盘路径 → 后缀给路径（V2）；无 → 老的缩小范围指引（V1）", () => {
    const withSpill = truncateModelOutput(longShellText(), "shell", undefined, "/tmp/x/tool-outputs/c1.txt");
    expect(withSpill.text).toContain("完整全文已落盘到 /tmp/x/tool-outputs/c1.txt");
    const noSpill = truncateModelOutput(longShellText(), "shell");
    expect(noSpill.text).toContain("shell→加 head/grep 缩小范围");
  });

  it("givenBytes 是最终文本的字节数（含后缀）", () => {
    const r = truncateModelOutput(longShellText(), "shell");
    expect(r.givenBytes).toBe(bytes(r.text));
    expect(r.originalBytes).toBe(bytes(longShellText()));
  });

  it("头、尾的切口落在多字节字符中间时不产生乱码（CJK + emoji，错开 0~3 字节对齐各试一遍）", () => {
    for (let pad = 0; pad < 4; pad++) {
      const filler = "构建失败😀日志行".repeat(8000); // ≈ 170KB，全是 3 / 4 字节字符
      const text = `${"a".repeat(pad)}${filler}尾部报错：完了`;
      const r = truncateModelOutput(text, "shell");
      expect(r.truncated).toBe(true);
      expect(r.text).not.toContain("\uFFFD");
      expect(r.text.endsWith(")")).toBe(true); // 指引后缀完整
      expect(bodyOf(r.text)).toContain("尾部报错：完了");
    }
  });

  it("预算小到放不下「头 + 标记 + 尾」时退化成只留头部，不崩、状态行仍在", () => {
    const r = truncateModelOutput(longShellText(), "shell", 4096);
    expect(r.truncated).toBe(true);
    expect(r.text.startsWith("（exit code 2）\n")).toBe(true);
  });
});

describe("truncateModelOutput · 其它工具仍只留头部（本批不动）", () => {
  const tailMarkerLine = "TAIL-ONLY-MARKER";
  const longText = `head-line\n${"x".repeat(100 * 1024)}\n${tailMarkerLine}`;

  it.each(["grep", "read", "task", "mcp__srv__tool", "unknown"])(
    "%s：尾部那行不在、用「本次只给前 N」口径",
    (tool) => {
      const r = truncateModelOutput(longText, tool);
      expect(r.truncated).toBe(true);
      expect(r.text).not.toContain(tailMarkerLine);
      expect(r.text).toContain("head-line");
      expect(r.text).toContain("本次只给前 ");
      expect(r.text).not.toContain("开头 8.0KB + 结尾");
      // 改前的内层后缀仍在（不在本批范围）
      expect(r.text).toMatch(/…\(truncated \d+ chars\)/);
    },
  );
});

describe("withModelBudget · shell 工具包装层", () => {
  const fakeShell = (text: string, extra: Array<{ type: string; text?: string }> = []) => ({
    name: "shell",
    execute: async () => ({
      content: [{ type: "text", text }, ...extra],
      details: { exitCode: 2 },
    }),
  });
  type Wrapped = {
    execute: (callId: string, params: unknown) => Promise<{
      content: Array<{ type: string; text?: string }>;
      details?: unknown;
    }>;
  };

  it("超预算的 shell 回包经包装后：状态行 + 结尾都在，details 原样保留，打一条预算日志", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const wrapped = withModelBudget(fakeShell(longShellText())) as unknown as Wrapped;
      const out = await wrapped.execute("c1", {});
      const text = out.content[0]!.text!;
      expect(text.startsWith("（exit code 2）\n")).toBe(true);
      expect(text).toContain("FATAL: boom at the very end");
      expect(out.details).toEqual({ exitCode: 2 });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toContain("tool=shell");
    } finally {
      warn.mockRestore();
    }
  });

  it("多 part：超预算的那个保留头尾，没超的与非 text part 原样", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const image = { type: "image", data: "AAAA" };
      const wrapped = withModelBudget(
        fakeShell(longShellText(), [{ type: "text", text: "small second part" }, image]),
      ) as unknown as Wrapped;
      const out = await wrapped.execute("c2", {});
      expect(out.content[0]!.text).toContain("FATAL: boom at the very end");
      expect(out.content[1]).toEqual({ type: "text", text: "small second part" });
      expect(out.content[2]).toEqual(image);
    } finally {
      warn.mockRestore();
    }
  });

  it("没超预算的 shell 回包原样（同一个对象引用，不拷贝）", async () => {
    const wrapped = withModelBudget(fakeShell("（exit code 1）\nsmall")) as unknown as Wrapped;
    const out = await wrapped.execute("c3", {});
    expect(out.content[0]!.text).toBe("（exit code 1）\nsmall");
  });
});
