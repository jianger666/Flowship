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
  buildInlineToolResultMeta,
  buildToolResultMeta,
  isFlowshipOwnToolName,
  persistTruncatedOutput,
  resolveToolResultStatus,
  sanitizeCallIdForPath,
  SHELL_PREVIEW_HEAD_BYTES,
  TOOL_RESULT_OUTPUT_LIMIT,
  TOOL_RESULT_DIFF_LIMIT,
  truncateHeadTail,
  truncateToLimit,
  UNKNOWN_CALL_ID_FALLBACK,
} = await import("../src/lib/server/tool-result-persist");

const { countDiffStats } = await import("../src/lib/tool-display");
const { taskDir } = await import("../src/lib/server/task-fs-core");
const { spillModelFullOutput } = await import("../src/lib/server/tool-result-persist");

const utf8Bytes = (s: string): number => Buffer.byteLength(s, "utf8");

/** 模拟「任务存在」：建任务目录（writeToolOutputAtomic 不再替不存在的任务建目录，D4b-02） */
const mkTaskDir = async (id: string): Promise<void> => {
  await fs.mkdir(taskDir(id), { recursive: true });
};
const pathExists = (p: string): Promise<boolean> =>
  fs.stat(p).then(
    () => true,
    () => false,
  );

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
    await mkTaskDir("task-p2-11-ok");
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

    await mkTaskDir("task-s7-zh");
    const result = await persistTruncatedOutput("task-s7-zh", "call_zh", full);
    expect(result.truncated).toBe(true);
    expect(result.fullPath).toBeDefined();
    expect(utf8Bytes(result.output)).toBeLessThanOrEqual(TOOL_RESULT_OUTPUT_LIMIT);
    expect(result.output).not.toContain("\uFFFD");
  });
});

describe("D4b-02：任务目录不存在（= 任务已被删）时，迟到的落盘不能把它复活", () => {
  it("persistTruncatedOutput：目录缺失 → 降级为截断展示（无 fullPath），taskDir / tool-outputs 都不被创建", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const id = "task-d4b02-gone";
    expect(await pathExists(taskDir(id))).toBe(false);

    const full = "x".repeat(TOOL_RESULT_OUTPUT_LIMIT + 100);
    const r = await persistTruncatedOutput(id, "call_late", full);

    expect(r.truncated).toBe(true);
    expect(r.fullPath).toBeUndefined();
    expect(utf8Bytes(r.output)).toBeLessThanOrEqual(TOOL_RESULT_OUTPUT_LIMIT);
    expect(await pathExists(taskDir(id))).toBe(false);
  });

  it("spillModelFullOutput：目录缺失 → null（调用方降级 V1 后缀），不创建任何目录", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const id = "task-d4b02-spill-gone";

    const r = await spillModelFullOutput(id, "call_spill", "y".repeat(100_000));

    expect(r).toBeNull();
    expect(await pathExists(taskDir(id))).toBe(false);
  });

  it("任务目录存在：首次建 tool-outputs/ 并落盘；第二次（目录已存在，EEXIST）照常落盘", async () => {
    const id = "task-d4b02-alive";
    await mkTaskDir(id);
    const full = "z".repeat(TOOL_RESULT_OUTPUT_LIMIT + 100);

    const a = await persistTruncatedOutput(id, "call_a", full);
    const b = await persistTruncatedOutput(id, "call_b", full);

    expect(a.fullPath).toMatch(/^tool-outputs\/.+\.txt$/);
    expect(b.fullPath).toMatch(/^tool-outputs\/.+\.txt$/);
    expect(await fs.readFile(path.join(taskDir(id), a.fullPath!), "utf-8")).toBe(full);
    expect(await fs.readFile(path.join(taskDir(id), b.fullPath!), "utf-8")).toBe(full);
  });

  it("任务在落盘前一刻被删（目录曾存在）：不复活 taskDir", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const id = "task-d4b02-race";
    await mkTaskDir(id);
    // 先让 tool-outputs/ 建出来，再整目录删掉，模拟 DELETE 与迟到落盘交错
    await persistTruncatedOutput(id, "call_first", "w".repeat(TOOL_RESULT_OUTPUT_LIMIT + 10));
    await fs.rm(taskDir(id), { recursive: true, force: true });

    const r = await persistTruncatedOutput(id, "call_after_delete", "w".repeat(TOOL_RESULT_OUTPUT_LIMIT + 10));

    expect(r.fullPath).toBeUndefined();
    expect(await pathExists(taskDir(id))).toBe(false);
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

/**
 * U3a-06：shell 预览「头 2KB + …(省略 N 字符)… + 尾 6KB」。
 * 测试 / 构建的报错几乎都在输出尾部，旧实现只取头 8KB，用户看到的全是进度噪声。
 */
describe("truncateHeadTail（shell 预览：头 + 省略标记 + 尾）", () => {
  const OMIT_RE = /\n…\(省略 (\d+) 字符\)…\n/;

  /** 把输出拆成 head / omitted / tail，并校验「字符账」对得上原文长度 */
  const split = (out: string, original: string) => {
    const m = out.match(OMIT_RE);
    expect(m, "输出里要有省略标记").not.toBeNull();
    const head = out.slice(0, m!.index!);
    const tail = out.slice(m!.index! + m![0].length);
    // 头 + 省略 + 尾 = 原文长度（N 是被省略的 UTF-16 码元数）
    expect(head.length + Number(m![1]) + tail.length).toBe(original.length);
    expect(original.startsWith(head)).toBe(true);
    expect(original.endsWith(tail)).toBe(true);
    return { head, tail, omitted: Number(m![1]) };
  };

  it("未超限原样返回", () => {
    const s = "build ok\n".repeat(10);
    expect(truncateHeadTail(s, TOOL_RESULT_OUTPUT_LIMIT)).toBe(s);
  });

  it("ASCII：头 2KB + 标记 + 尾约 6KB，总字节 ≤ 8KB，尾部报错行保留", () => {
    const noise = Array.from({ length: 2000 }, (_, i) => `progress ${i}`).join("\n");
    const full = `${noise}\nFAIL tests/a.test.ts\nError: boom at line 42\n`;
    const out = truncateHeadTail(full, TOOL_RESULT_OUTPUT_LIMIT);

    expect(utf8Bytes(out)).toBeLessThanOrEqual(TOOL_RESULT_OUTPUT_LIMIT);
    const { head, tail } = split(out, full);
    expect(utf8Bytes(head)).toBe(SHELL_PREVIEW_HEAD_BYTES);
    // 尾 ≈ 6KB（标记占的几十字节从尾部配额里扣）
    expect(utf8Bytes(tail)).toBeGreaterThan(6 * 1024 - 64);
    expect(utf8Bytes(tail)).toBeLessThanOrEqual(6 * 1024);
    expect(out.startsWith("progress 0\n")).toBe(true);
    expect(out.endsWith("Error: boom at line 42\n")).toBe(true);
  });

  it("中文（3 字节）：头尾切口都落在字符边界，无 U+FFFD", () => {
    const full = "测".repeat(5000); // 15KB
    const out = truncateHeadTail(full, TOOL_RESULT_OUTPUT_LIMIT);
    expect(utf8Bytes(out)).toBeLessThanOrEqual(TOOL_RESULT_OUTPUT_LIMIT);
    expect(out).not.toContain("\uFFFD");
    const { head, tail } = split(out, full);
    expect([...head].every((ch) => ch === "测")).toBe(true);
    expect([...tail].every((ch) => ch === "测")).toBe(true);
    // 2048 不是 3 的倍数 → 头只能取到 682 个字（2046 字节），不能切开第 683 个字
    expect(utf8Bytes(head)).toBe(2046);
  });

  it("emoji（4 字节 surrogate pair）：头尾切口在任意错位下都不切半、无孤立 surrogate", () => {
    // 前缀 0~3 个 ASCII 把 4 字节字符的对齐方式轮一遍，头 / 尾两个切口都要覆盖
    for (let pad = 0; pad < 4; pad++) {
      const full = `${"a".repeat(pad)}${"😀".repeat(4000)}${"b".repeat(pad)}`; // ~16KB
      const out = truncateHeadTail(full, TOOL_RESULT_OUTPUT_LIMIT);
      expect(utf8Bytes(out), `pad=${pad}`).toBeLessThanOrEqual(TOOL_RESULT_OUTPUT_LIMIT);
      expect(out, `pad=${pad}`).not.toContain("\uFFFD");
      const { head, tail } = split(out, full);
      const lone =
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
      expect(lone.test(head), `head pad=${pad}`).toBe(false);
      expect(lone.test(tail), `tail pad=${pad}`).toBe(false);
    }
  });

  it("中英混排 + 换行：Buffer 往返无损（逐字节验证没有半个字符）", () => {
    const line = "构建失败 ✗ error TS2322: 类型“string”不能赋给“number”。\n";
    const full = line.repeat(400);
    const out = truncateHeadTail(full, TOOL_RESULT_OUTPUT_LIMIT);
    expect(Buffer.from(out, "utf8").toString("utf8")).toBe(out);
    expect(out).not.toContain("\uFFFD");
    split(out, full);
  });

  it("limit 太小放不下「头 + 标记 + 尾」→ 退化成头部截断（仍 ≤ limit、带 truncated 后缀）", () => {
    const full = "x".repeat(5000);
    const out = truncateHeadTail(full, 1024);
    expect(utf8Bytes(out)).toBeLessThanOrEqual(1024);
    expect(out).toMatch(/…\(truncated \d+ chars\)$/);
    expect(OMIT_RE.test(out)).toBe(false);
  });
});

describe("shell 预览接入（persistTruncatedOutput / buildToolResultMeta）", () => {
  const noise = Array.from({ length: 3000 }, (_, i) => `step ${i} ok`).join("\n");
  const full = `${noise}\n✗ 3 tests failed\nAssertionError: expected 1 to be 2\n`;

  it("persistTruncatedOutput 默认（非 shell）仍只取头部——read / grep 等行为不变", async () => {
    const r = await persistTruncatedOutput("task-u3a06-head", "c_head", full);
    expect(r.truncated).toBe(true);
    expect(r.output.startsWith("step 0 ok")).toBe(true);
    expect(r.output).not.toContain("AssertionError");
    expect(r.output).toMatch(/…\(truncated \d+ chars\)$/);
  });

  it("persistTruncatedOutput head-tail：尾部报错进预览，全量照常落盘", async () => {
    await mkTaskDir("task-u3a06-ht");
    const r = await persistTruncatedOutput(
      "task-u3a06-ht",
      "c_ht",
      full,
      TOOL_RESULT_OUTPUT_LIMIT,
      "head-tail",
    );
    expect(r.truncated).toBe(true);
    expect(r.fullPath).toMatch(/^tool-outputs\/.+\.txt$/);
    expect(utf8Bytes(r.output)).toBeLessThanOrEqual(TOOL_RESULT_OUTPUT_LIMIT);
    expect(r.output.startsWith("step 0 ok")).toBe(true);
    expect(r.output.endsWith("AssertionError: expected 1 to be 2\n")).toBe(true);
    expect(r.output).toMatch(/…\(省略 \d+ 字符\)…/);
  });

  it("buildToolResultMeta：shell 预览带尾部；read 同样大的输出仍是头部", async () => {
    const shellMeta = await buildToolResultMeta({
      taskId: "task-u3a06-meta",
      callId: "c_shell",
      rawName: "shell",
      msgStatus: "completed",
      result: { status: "success", value: { stdout: full, stderr: "", exitCode: 1 } },
    });
    expect(shellMeta.truncated).toBe(true);
    expect(shellMeta.exitCode).toBe(1);
    expect(shellMeta.output.endsWith("AssertionError: expected 1 to be 2\n")).toBe(true);
    expect(utf8Bytes(shellMeta.output)).toBeLessThanOrEqual(TOOL_RESULT_OUTPUT_LIMIT);

    const readMeta = await buildToolResultMeta({
      taskId: "task-u3a06-meta",
      callId: "c_read",
      rawName: "read",
      msgStatus: "completed",
      result: { status: "success", value: { content: full } },
    });
    expect(readMeta.truncated).toBe(true);
    expect(readMeta.output).not.toContain("AssertionError");
    expect(readMeta.output).toMatch(/…\(truncated \d+ chars\)$/);
  });

  it("buildInlineToolResultMeta（子代理纯内存版）：shell 同样头 + 尾", () => {
    const meta = buildInlineToolResultMeta({
      callId: "c_inline",
      rawName: "shell",
      msgStatus: "completed",
      result: { status: "success", value: { stdout: full, stderr: "" } },
    });
    expect(meta.truncated).toBe(true);
    expect(meta.fullPath).toBeUndefined();
    expect(meta.output.endsWith("AssertionError: expected 1 to be 2\n")).toBe(true);
    expect(utf8Bytes(meta.output)).toBeLessThanOrEqual(TOOL_RESULT_OUTPUT_LIMIT);
  });
});

describe("sanitizeCallIdForPath", () => {
  it("空 callId 固定回退 call_unknown（写读一致）", () => {
    expect(sanitizeCallIdForPath("")).toBe(UNKNOWN_CALL_ID_FALLBACK);
    expect(sanitizeCallIdForPath("call_abc")).toBe("call_abc");
    // 两次空串同一回退（旧实现 Date.now 写读不一致）
    expect(sanitizeCallIdForPath("")).toBe(sanitizeCallIdForPath(""));
  });

  it("子代理 callId 内嵌换行 → 换成下划线（与 tool-output API 读盘一致）", () => {
    const raw =
      "call-2db24248-f3ac-4b60-898b-341cc901ac7a-5\nfc_cfbdbf80-a56a-9c71-a13b-eb5c6f722724_5";
    expect(sanitizeCallIdForPath(raw)).toBe(
      "call-2db24248-f3ac-4b60-898b-341cc901ac7a-5_fc_cfbdbf80-a56a-9c71-a13b-eb5c6f722724_5",
    );
  });
});

/**
 * V4-02：自定义提供方（pi）的 edit 结果没有 Cursor 的 `{status, value:{diffString}}` 信封，
 * 而是 `{ content:[{type:"text",text}], details:{ diff, patch, firstChangedLine } }`
 * （node_modules/@earendil-works/pi-coding-agent/dist/core/tools/edit.js 的返回值）。
 * 其中 `patch` 是 unified diff（`diff` 包 createTwoFilesPatch，FILE_HEADERS_ONLY）、
 * `diff` 是带行号的展示串（` 1 a` / `-2 b`），前者才是前端 parseUnifiedDiff / countDiffStats 吃的格式。
 * 下面的 PI_PATCH 是用 pi 自己的 generateUnifiedPatch 实跑出来的真实输出，不是手编的。
 */
describe("V4-02：pi edit 的 details.patch → meta.diff", () => {
  const PI_PATCH =
    "--- src/a.ts\n+++ src/a.ts\n@@ -1,4 +1,5 @@\n a\n-b\n+B\n c\n d\n+e\n";
  const PI_DISPLAY_DIFF = " 1 a\n-2 b\n+2 B\n 3 c\n 4 d\n+5 e";
  const piEditResult = (details: unknown) => ({
    content: [
      { type: "text", text: "Successfully replaced 1 block(s) in src/a.ts." },
    ],
    details,
  });

  it("details.patch 是字符串 → 当 diff，+/- 统计可算（修前 diff 恒为 undefined）", () => {
    const meta = buildInlineToolResultMeta({
      callId: "c_pi_edit",
      rawName: "edit",
      msgStatus: "completed",
      args: { path: "src/a.ts", edits: [{ oldText: "b", newText: "B" }] },
      result: piEditResult({
        diff: PI_DISPLAY_DIFF,
        patch: PI_PATCH,
        firstChangedLine: 2,
      }),
    });
    expect(meta.diff).toBe(PI_PATCH);
    expect(meta.filePath).toBe("src/a.ts");
    expect(countDiffStats(meta.diff ?? "")).toEqual({ added: 2, removed: 1 });
    // 输出文本照旧取 pi 的那句话，不受 diff 影响
    expect(meta.output).toBe("Successfully replaced 1 block(s) in src/a.ts.");
  });

  it("只有行号展示串 details.diff、没有 patch → 不当 unified diff 用（渲染会错位）", () => {
    const meta = buildInlineToolResultMeta({
      callId: "c_pi_edit2",
      rawName: "edit",
      msgStatus: "completed",
      args: { path: "src/a.ts" },
      result: piEditResult({ diff: PI_DISPLAY_DIFF, firstChangedLine: 2 }),
    });
    expect(meta.diff).toBeUndefined();
  });

  it("patch 不是字符串（脏数据）→ 无 diff、不抛", () => {
    const meta = buildInlineToolResultMeta({
      callId: "c_pi_edit3",
      rawName: "edit",
      msgStatus: "completed",
      args: { path: "src/a.ts" },
      result: piEditResult({ patch: { not: "a string" } }),
    });
    expect(meta.diff).toBeUndefined();
  });

  it("超 16KB 的 patch 照旧截断并标 diffTruncated", () => {
    const big = `--- a\n+++ a\n@@ -1 +1 @@\n${"+x".repeat(TOOL_RESULT_DIFF_LIMIT)}\n`;
    const meta = buildInlineToolResultMeta({
      callId: "c_pi_edit4",
      rawName: "edit",
      msgStatus: "completed",
      args: { path: "a" },
      result: piEditResult({ patch: big }),
    });
    expect(meta.diffTruncated).toBe(true);
    expect(utf8Bytes(meta.diff ?? "")).toBeLessThanOrEqual(TOOL_RESULT_DIFF_LIMIT);
  });

  it("write 不吃 details.patch（write 本来就没有 diff）", () => {
    const meta = buildInlineToolResultMeta({
      callId: "c_pi_write",
      rawName: "write",
      msgStatus: "completed",
      args: { path: "src/a.ts" },
      result: piEditResult({ patch: PI_PATCH }),
    });
    expect(meta.diff).toBeUndefined();
  });

  it("Cursor 形状 value.diffString 不回归；两种形状并存时 Cursor 的优先", () => {
    const cursor = buildInlineToolResultMeta({
      callId: "c_cursor_edit",
      rawName: "edit",
      msgStatus: "completed",
      args: { path: "src/a.ts" },
      result: {
        status: "success",
        value: { path: "src/a.ts", diffString: "--- a\n+++ b\n-x\n+y\n" },
      },
    });
    expect(cursor.diff).toBe("--- a\n+++ b\n-x\n+y\n");

    const both = buildInlineToolResultMeta({
      callId: "c_both",
      rawName: "edit",
      msgStatus: "completed",
      args: { path: "src/a.ts" },
      result: {
        status: "success",
        value: { diffString: "FROM_VALUE" },
        details: { patch: "FROM_DETAILS" },
      },
    });
    expect(both.diff).toBe("FROM_VALUE");
  });
});

/**
 * V4-03：成败判定不能只认 Cursor 形状。
 *  - pi 的 `ev.isError` 只在 execute 抛错时为真；MCP 桥返回 `details:{isError:true}` 是「正常返回」；
 *  - Flowship 自有工具大量 `text(JSON.stringify({ok:false,…}))` 也是正常返回。
 * 误判代价不对称：把 shell 里碰巧输出 `{"ok":false}` 的成功命令标红，比漏标更糟——所以只对自有工具判。
 */
describe("V4-03：resolveToolResultStatus 认 pi / 自有工具的失败形状", () => {
  const piText = (text: string, details?: unknown) => ({
    content: [{ type: "text", text }],
    details,
  });
  const cursorMcpText = (text: string, isError = false) => ({
    status: "success",
    value: { content: [{ text: { text } }], isError },
  });
  const failJson = JSON.stringify({ ok: false, error: "任务不存在" });

  it("details.isError === true（pi 的 MCP 桥）→ error，不要求是 MCP 名", () => {
    expect(
      resolveToolResultStatus(
        "completed",
        "mcp:feishu:add_comment",
        piText("boom", { isError: true }),
      ),
    ).toBe("error");
    expect(
      resolveToolResultStatus("completed", "some_tool", piText("x", { isError: true })),
    ).toBe("error");
    // 只认严格的 true
    expect(
      resolveToolResultStatus("completed", "mcp:a:b", piText("x", { isError: "true" })),
    ).toBe("success");
    expect(
      resolveToolResultStatus("completed", "mcp:a:b", piText("x", { isError: false })),
    ).toBe("success");
  });

  it("自有工具正文是 {ok:false,…} 的 JSON → error（pi 形状 / Cursor MCP 形状都认）", () => {
    expect(resolveToolResultStatus("completed", "submit_mr", piText(failJson))).toBe(
      "error",
    );
    expect(
      resolveToolResultStatus(
        "completed",
        "mcp:custom-user-tools:share_to_group",
        cursorMcpText(failJson),
      ),
    ).toBe("error");
    // 旧会话的合成 server 名
    expect(
      resolveToolResultStatus(
        "completed",
        "mcp:flowshipChat:submit_mr",
        cursorMcpText(failJson),
      ),
    ).toBe("error");
    // 前后有空白 / 换行也认
    expect(
      resolveToolResultStatus("completed", "submit_mr", piText(`\n  ${failJson}\n`)),
    ).toBe("error");
  });

  it("自有工具 ok:true / 非 JSON 文案 / 半截 JSON / ok 不是布尔 false → success", () => {
    const ok = JSON.stringify({ ok: true, hint: "x" });
    expect(resolveToolResultStatus("completed", "submit_mr", piText(ok))).toBe("success");
    expect(
      resolveToolResultStatus(
        "completed",
        "submit_work",
        piText('[SUBMITTED] action=a1 已交卷，说明里有 "ok":false 字样'),
      ),
    ).toBe("success");
    expect(
      resolveToolResultStatus("completed", "submit_mr", piText('{"ok":false,"error":"断')),
    ).toBe("success");
    expect(
      resolveToolResultStatus("completed", "submit_mr", piText('{"ok":"false"}')),
    ).toBe("success");
    expect(resolveToolResultStatus("completed", "submit_mr", piText('{"ok":0}'))).toBe(
      "success",
    );
    // 数组 / 标量 JSON 不是自有工具的失败形状
    expect(resolveToolResultStatus("completed", "submit_mr", piText("[false]"))).toBe(
      "success",
    );
  });

  it("非自有工具（shell / read / 第三方 MCP）的输出碰巧是 {ok:false} → 仍是 success", () => {
    // shell 里 `curl … | jq` / `cat result.json` 输出一个 {"ok":false}：命令本身成功
    expect(resolveToolResultStatus("completed", "shell", piText(failJson))).toBe("success");
    expect(
      resolveToolResultStatus("completed", "shell", {
        status: "success",
        value: { stdout: failJson, stderr: "", exitCode: 0 },
      }),
    ).toBe("success");
    expect(resolveToolResultStatus("completed", "read", piText(failJson))).toBe("success");
    expect(
      resolveToolResultStatus("completed", "mcp:feishu:send", cursorMcpText(failJson)),
    ).toBe("success");
    // 同名前缀不算自有（custom-user-tools-evil 不是保留 server）
    expect(
      resolveToolResultStatus(
        "completed",
        "mcp:custom-user-tools-x:submit_mr",
        cursorMcpText(failJson),
      ),
    ).toBe("success");
  });

  it("旧判定不回归：msgStatus=error / env.status=error / MCP value.isError", () => {
    expect(resolveToolResultStatus("error", "shell", undefined)).toBe("error");
    expect(
      resolveToolResultStatus("completed", "shell", { status: "error", error: "x" }),
    ).toBe("error");
    expect(
      resolveToolResultStatus("completed", "mcp:a:b", cursorMcpText("x", true)),
    ).toBe("error");
    expect(resolveToolResultStatus("completed", "shell", undefined)).toBe("success");
  });

  it("端到端：buildInlineToolResultMeta 给自有工具的业务失败打 error", () => {
    const meta = buildInlineToolResultMeta({
      callId: "c_own_fail",
      rawName: "submit_mr",
      msgStatus: "completed",
      args: {},
      result: piText(failJson),
    });
    expect(meta.status).toBe("error");
    expect(meta.output).toBe(failJson);
  });

  it("契约：flowShipTools 里每个工具名都被 isFlowshipOwnToolName 认得（加新工具不补名单会让它的失败亮绿）", async () => {
    const { flowShipTools } = await import("../src/lib/server/flowship-tools");
    expect(flowShipTools.length).toBeGreaterThan(5);
    for (const t of flowShipTools) {
      expect(isFlowshipOwnToolName(t.name), t.name).toBe(true);
      expect(isFlowshipOwnToolName(`mcp:custom-user-tools:${t.name}`), t.name).toBe(true);
    }
    // 内置工具不是
    for (const n of ["shell", "read", "write", "edit", "grep", "glob", "task", "mcp:feishu:x"]) {
      expect(isFlowshipOwnToolName(n), n).toBe(false);
    }
  });
});
