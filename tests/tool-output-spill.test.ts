/**
 * tool-output-budget V2（超预算全量落盘 + 模型拿路径分页读）单测：
 * 落盘内容精确 / 后缀给路径可读 / V1 降级 / UI 复用同一份全文不覆盖。
 *
 * DATA_DIR 须在动态 import 前钉死（与 tool-result-persist.test.ts 同构）——
 * 静态 import 会提前冻结 DATA_DIR 到真实数据目录，测试会写脏真实任务目录。
 */
import { mkdtempSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-tool-output-spill-"));
process.env.FLOWSHIP_DATA_DIR = TMP_ROOT;

const {
  MODEL_OUTPUT_DEFAULT_BUDGET,
  truncateModelOutput,
  withModelBudget,
} = await import("../src/lib/server/tool-output-budget");
const {
  buildToolResultMeta,
  modelSpillPathForResult,
  TOOL_RESULT_OUTPUT_LIMIT,
} = await import("../src/lib/server/tool-result-persist");
const {
  createReadToolDefinition,
} = await import("@earendil-works/pi-coding-agent");

const utf8Bytes = (s: string): number => Buffer.byteLength(s, "utf8");
const spillFile = (taskId: string, callId: string): string =>
  path.join(TMP_ROOT, "tasks", taskId, "tool-outputs", `${callId}.txt`);

/**
 * 形如 pi ToolDefinition 的假工具（execute 首参是 toolCallId）。
 * 假 execute 本体不关心参数、保持零参（仓库 eslint 对 `_` 前缀仍告警未使用）；
 * 调用侧经 asBudgetTool 转成双参签名再传 callId。
 */
type BudgetToolCall = {
  execute: (callId: string, params: unknown) => Promise<unknown>;
};
const asBudgetTool = (def: {
  name: string;
  execute: (...args: never[]) => Promise<unknown>;
}) => def as unknown as BudgetToolCall;
const fakeTextTool = (name: string, text: string, details: unknown = undefined) => ({
  name,
  execute: async () => ({
    content: [{ type: "text", text }],
    details,
  }),
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("V2 落盘：withModelBudget + taskId", () => {
  it("超预算 → 全文精确落盘，后缀给绝对路径 + read/grep 指引", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const full = `FULLMARKER-${"y".repeat(1000)}\n`.repeat(120); // ~120KB
      expect(utf8Bytes(full)).toBeGreaterThan(MODEL_OUTPUT_DEFAULT_BUDGET);
      const def = fakeTextTool("shell", full, { exitCode: 0 });
      const out = (await asBudgetTool(withModelBudget(def, {
        taskId: "task-v2-spill",
      })).execute("call_v2_1", {})) as {
        content: { type: string; text: string }[];
        details: { exitCode: number };
      };
      // 模型侧：预览 + 落盘路径
      const shown = out.content[0]!.text;
      expect(shown).toContain("模型输入已截断");
      expect(shown).toContain("完整全文已落盘到");
      expect(shown).toContain("read offset/limit");
      expect(shown).toContain("grep");
      expect(shown).toContain(spillFile("task-v2-spill", "call_v2_1"));
      expect(out.details).toEqual({ exitCode: 0 });
      // 盘上：精确全文（AI 按路径能拿回一模一样的内容）
      const onDisk = await fs.readFile(
        spillFile("task-v2-spill", "call_v2_1"),
        "utf-8",
      );
      expect(onDisk).toBe(full);
      // 日志带落盘路径，可 grep
      expect(String(warn.mock.calls[0])).toContain("[tool-budget]");
      expect(String(warn.mock.calls[0])).toContain("落盘=");
    } finally {
      warn.mockRestore();
    }
  });

  it("无 taskId → V1 后缀（缩小范围重取），不写盘", async () => {
    const big = "y".repeat(100 * 1024);
    const def = fakeTextTool("shell", big);
    const out = (await asBudgetTool(withModelBudget(def)).execute("call_v2_nospill", {})) as {
      content: { type: string; text: string }[];
    };
    // shell 的 V1 指引是专属版（shell→加 head/grep…），断言它且不断言通用版
    expect(out.content[0]!.text).toContain("shell→");
    expect(out.content[0]!.text).toContain("缩小范围");
    expect(out.content[0]!.text).not.toContain("已落盘到");
    await expect(
      fs.access(spillFile("task-v2-spill", "call_v2_nospill")),
    ).rejects.toThrow();
  });

  it("落盘失败 → 降级 V1 后缀，不炸工具执行", async () => {
    vi.spyOn(fs, "writeFile").mockRejectedValueOnce(new Error("ENOSPC"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const big = "z".repeat(100 * 1024);
      const def = fakeTextTool("shell", big);
      const out = (await asBudgetTool(withModelBudget(def, {
        taskId: "task-v2-fail",
      })).execute("call_v2_fail", {})) as {
        content: { type: string; text: string }[];
      };
      expect(out.content[0]!.text).toContain("模型输入已截断");
      expect(out.content[0]!.text).toContain("shell→");
      expect(out.content[0]!.text).not.toContain("已落盘到");
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("不足预算 → 原样放行、不写盘（read 64KB 口径不变）", async () => {
    const s50k = "a".repeat(50 * 1024);
    const def = fakeTextTool("read", s50k);
    const out = (await asBudgetTool(withModelBudget(def, {
      taskId: "task-v2-read",
    })).execute("call_v2_read", {})) as {
      content: { type: string; text: string }[];
    };
    expect(out.content[0]!.text).toBe(s50k);
    await expect(
      fs.access(spillFile("task-v2-read", "call_v2_read")),
    ).rejects.toThrow();
  });

  it("filePrefix 给子 agent 内层用：文件名隔离", async () => {
    const big = "q".repeat(100 * 1024);
    const def = fakeTextTool("task", big);
    await asBudgetTool(withModelBudget(def, {
      taskId: "task-v2-sub",
      filePrefix: "sub-",
    })).execute("call_v2_sub", {});
    const onDisk = await fs.readFile(
      spillFile("task-v2-sub", "sub-call_v2_sub"),
      "utf-8",
    );
    expect(onDisk).toBe(big);
  });
});

describe("truncateModelOutput 第 4 参数", () => {
  it("有落盘路径 → 后缀指引读盘；无 → 老缩小指引", () => {
    const big = "x".repeat(100 * 1024);
    const v2 = truncateModelOutput(big, "shell", 32 * 1024, "/abs/tool-outputs/c.txt");
    expect(v2.text).toContain("完整全文已落盘到 /abs/tool-outputs/c.txt");
    expect(v2.text).toContain("read offset/limit");
    const v1 = truncateModelOutput(big, "shell");
    expect(v1.text).toContain("shell→");
    expect(v1.text).not.toContain("已落盘到");
    // 未知工具走通用版缩小指引
    const v1generic = truncateModelOutput(big, "some-mcp-tool");
    expect(v1generic.text).toContain("缩小参数范围重取");
  });
});

describe("UI 复用：buildToolResultMeta 不覆盖落盘全文", () => {
  it("有落盘 → 8KB 预览取自真实全文，fullPath 指向同一文件", async () => {
    const full = `UIMARKER-${"w".repeat(500)}\n`.repeat(300); // ~150KB
    const taskId = "task-v2-ui";
    const callId = "call_v2_ui";
    const def = fakeTextTool("shell", full, { exitCode: 0 });
    const toolOut = (await asBudgetTool(withModelBudget(def, { taskId })).execute(
      callId,
      {},
    )) as { content: { type: string; text: string }[]; details: unknown };

    const meta = await buildToolResultMeta({
      taskId,
      callId,
      rawName: "shell",
      args: {},
      result: toolOut,
      msgStatus: "completed",
    });
    // UI 预览 8KB 内、内容来自真实全文（不是 stringify 后的 JSON）
    expect(meta.truncated).toBe(true);
    expect(meta.fullPath).toBe(`tool-outputs/${callId}.txt`);
    expect(utf8Bytes(meta.output)).toBeLessThanOrEqual(TOOL_RESULT_OUTPUT_LIMIT);
    expect(meta.output.startsWith("UIMARKER-")).toBe(true);
    // 盘上全文完好无损（没被 32KB 截断版覆盖）
    const onDisk = await fs.readFile(spillFile(taskId, callId), "utf-8");
    expect(onDisk).toBe(full);
  });

  it("P1：MCP 桥接形状（_toolCallId, params）→ V2 照常触发，且 MCP 收到的是 params", async () => {
    // 锁定 custom-agent-backend.bridgeUserMcpServers 的包法：
    // execute 首参是 pi 传的 callId（工具只透传第二参给 MCP server）。
    // 若将来桥接改成一参 (params)，这里会失败，提醒补取 callId 的第二个取法。
    const seenByMcp: unknown[] = [];
    const mcpCall = async (params: Record<string, unknown>) => {
      seenByMcp.push(params);
      return { content: [{ type: "text", text: `R-${"m".repeat(100 * 1024)}` }] };
    };
    const def = {
      name: "mcp__insights__get_ledger",
      description: "MCP 工具",
      parameters: {},
      execute: async (_toolCallId: string, params: unknown) => {
        const r = await mcpCall(params as Record<string, unknown>);
        return { content: r.content, details: undefined };
      },
    };
    const out = (await asBudgetTool(
      withModelBudget(def, { taskId: "task-v2-mcp" }),
    ).execute("call_v2_mcp", { requirementCode: "REQ-1" })) as {
      content: { type: string; text: string }[];
    };
    // MCP server 收到的是业务 params，不是 callId
    expect(seenByMcp).toEqual([{ requirementCode: "REQ-1" }]);
    // V2 触发：落盘 + 后缀给路径
    expect(out.content[0]!.text).toContain("完整全文已落盘到");
    const onDisk = await fs.readFile(
      spillFile("task-v2-mcp", "call_v2_mcp"),
      "utf-8",
    );
    expect(onDisk.startsWith("R-")).toBe(true);
    expect(utf8Bytes(onDisk)).toBeGreaterThan(MODEL_OUTPUT_DEFAULT_BUDGET);
  });

  it("P2-1：真 read 工具能按落盘绝对路径 + offset/limit 读全（cwd 之外）", async () => {
    // 200 行行号文件：超 32KB 触发落盘，行号让分页可精确断言
    const lines = Array.from(
      { length: 200 },
      (_, i) => `LINE-${String(i + 1).padStart(3, "0")}-${"p".repeat(200)}`,
    );
    const full = `${lines.join("\n")}\n`;
    expect(utf8Bytes(full)).toBeGreaterThan(MODEL_OUTPUT_DEFAULT_BUDGET);
    const taskId = "task-v2-e2e";
    const callId = "call_v2_e2e";
    await asBudgetTool(
      withModelBudget(fakeTextTool("shell", full), { taskId }),
    ).execute(callId, {});
    const abs = spillFile(taskId, callId);
    // cwd 故意指到别处（还不存在都行）：证明 read 不做 cwd 沙箱、绝对路径直达
    const foreignCwd = path.join(TMP_ROOT, "some-other-cwd");
    const readDef = createReadToolDefinition(foreignCwd) as unknown as {
      execute: (
        callId: string,
        args: { path: string; offset?: number; limit?: number },
      ) => Promise<{ content: { type: string; text: string }[] }>;
    };
    const page1 = await readDef.execute("r1", { path: abs, limit: 10 });
    const t1 = page1.content[0]!.text;
    expect(t1).toContain("LINE-001-");
    expect(t1).toContain("LINE-010-");
    expect(t1).not.toContain("LINE-011-");
    expect(t1).toContain("offset=11");
    const page2 = await readDef.execute("r2", {
      path: abs,
      offset: 11,
      limit: 10,
    });
    const t2 = page2.content[0]!.text;
    expect(t2).toContain("LINE-011-");
    expect(t2).toContain("LINE-020-");
  });

  it("P2-2：同一引用直连落盘路径（meta fast path），陌生对象无映射", async () => {
    const full = `W-${"k".repeat(100 * 1024)}`;
    const taskId = "task-v2-link";
    const callId = "call_v2_link";
    const toolOut = (await asBudgetTool(
      withModelBudget(fakeTextTool("shell", full), { taskId }),
    ).execute(callId, {})) as { content: unknown[] };
    // 同一引用 → 映射命中，meta 不靠长度猜
    expect(modelSpillPathForResult(toolOut)).toBe(spillFile(taskId, callId));
    expect(modelSpillPathForResult({ content: [] })).toBeUndefined();
    expect(modelSpillPathForResult(null)).toBeUndefined();
    // 同一引用进 meta → 预览来自全文
    const meta = await buildToolResultMeta({
      taskId,
      callId,
      rawName: "shell",
      args: {},
      result: toolOut,
      msgStatus: "completed",
    });
    expect(meta.truncated).toBe(true);
    expect(meta.fullPath).toBe(`tool-outputs/${callId}.txt`);
    expect(meta.output.startsWith("W-")).toBe(true);
  });

  it("无落盘（Cursor 路径）→ 老行为：截断版当全文 persist", async () => {
    const full = `CURSORMARKER-${"v".repeat(100)}\n`.repeat(200); // ~20KB（超 8KB、未超 32KB）
    expect(utf8Bytes(full)).toBeGreaterThan(TOOL_RESULT_OUTPUT_LIMIT);
    const meta = await buildToolResultMeta({
      taskId: "task-v2-cursor",
      callId: "call_v2_cursor",
      rawName: "shell",
      args: {},
      result: { content: [{ type: "text", text: full }], details: undefined },
      msgStatus: "completed",
    });
    expect(meta.truncated).toBe(true);
    expect(meta.fullPath).toBe("tool-outputs/call_v2_cursor.txt");
  });
});
