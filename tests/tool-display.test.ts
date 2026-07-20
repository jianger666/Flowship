import { describe, expect, it } from "vitest";

import {
  countDiffStats,
  isEphemeralToolOutputDelta,
  isVerbGroupMember,
  mergeToolDisplayEvents,
  parseTaskToolArgs,
  parseToolArgsJson,
  toolBlockDefaultCollapsed,
  toolBlockExpandedArgsPreview,
  toolBlockSummary,
  type ToolBlock,
  type ToolVerbGroup,
  verbGroupLabel,
} from "../src/lib/tool-display";
import type { TaskEvent } from "../src/lib/types";

const ev = (
  partial: Partial<TaskEvent> & Pick<TaskEvent, "id" | "kind" | "text">,
): TaskEvent => ({
  ts: 1,
  ...partial,
});

const block = (
  partial: Partial<ToolBlock> & Pick<ToolBlock, "name">,
): ToolBlock => ({
  kind: "__tool_block__",
  id: "b1",
  callId: "c1",
  status: "success",
  text: "调用",
  ts: 1,
  ...partial,
});

describe("tool-display merge / GB 折叠规则", () => {
  it("过滤 ephemeral tool_output_delta", () => {
    const delta = ev({
      id: "ephemeral_tod_c1_1",
      kind: "tool_output_delta",
      text: "",
      meta: { callId: "c1", chunk: "hi" },
    });
    expect(isEphemeralToolOutputDelta(delta)).toBe(true);
    expect(mergeToolDisplayEvents([delta])).toEqual([]);
  });

  it("同 callId 的 tool_call + tool_result 合并成一块", () => {
    const call = ev({
      id: "a",
      kind: "tool_call",
      text: "调用 shell",
      meta: { callId: "c1", name: "shell", args: "ls" },
    });
    const result = ev({
      id: "b",
      kind: "tool_result",
      text: "工具完成 shell",
      ts: 2,
      meta: {
        callId: "c1",
        name: "shell",
        status: "success",
        output: "ok",
        exitCode: 0,
      },
    });
    const out = mergeToolDisplayEvents([call, result]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      kind: "__tool_block__",
      callId: "c1",
      name: "shell",
      status: "success",
    });
  });

  it("连续 read/grep 收成 verb group", () => {
    const mk = (id: string, callId: string, name: string): TaskEvent[] => [
      ev({
        id: `${id}_c`,
        kind: "tool_call",
        text: `调用 ${name}`,
        meta: { callId, name },
      }),
      ev({
        id: `${id}_r`,
        kind: "tool_result",
        text: `完成 ${name}`,
        meta: {
          callId,
          name,
          status: "success",
          output: "x",
        },
      }),
    ];
    const events = [
      ...mk("1", "c1", "read"),
      ...mk("2", "c2", "grep"),
      ...mk("3", "c3", "shell"),
    ];
    const out = mergeToolDisplayEvents(events);
    expect(out).toHaveLength(2);
    expect(out[0]?.kind).toBe("__tool_verb_group__");
    const group = out[0] as ToolVerbGroup;
    expect(group.members).toHaveLength(2);
    expect(verbGroupLabel(group)).toContain("读取了 2 个文件");
    expect(out[1]).toMatchObject({ kind: "__tool_block__", name: "shell" });
  });

  it("isVerbGroupMember 排除 shell/edit/mcp", () => {
    expect(isVerbGroupMember("read")).toBe(true);
    expect(isVerbGroupMember("grep")).toBe(true);
    expect(isVerbGroupMember("shell")).toBe(false);
    expect(isVerbGroupMember("edit")).toBe(false);
    expect(isVerbGroupMember("mcp:feishu:x")).toBe(false);
  });

  it("shell 默认折叠、edit 默认展开", () => {
    expect(toolBlockDefaultCollapsed("shell")).toBe(true);
    expect(toolBlockDefaultCollapsed("read")).toBe(true);
    expect(toolBlockDefaultCollapsed("edit")).toBe(false);
  });

  it("countDiffStats 数 +/−", () => {
    const diff = [
      "--- a/f",
      "+++ b/f",
      "@@ -1,2 +1,3 @@",
      " ctx",
      "-old",
      "+new",
      "+new2",
    ].join("\n");
    expect(countDiffStats(diff)).toEqual({ added: 2, removed: 1 });
  });
});

describe("toolBlockSummary 人类可读解析", () => {
  it("shell 从 args.command 解析，不 dump JSON", () => {
    const args = JSON.stringify({
      command: "ls -la ... && wc -l ...",
      working_directory: "/tmp",
    });
    const s = toolBlockSummary(
      block({ name: "shell", args, text: `调用 shell:${args}` }),
    );
    expect(s.startsWith("$ ls -la")).toBe(true);
    expect(s.includes("{")).toBe(false);
  });

  it("read 显示路径", () => {
    const args = JSON.stringify({ path: "src/lib/foo.ts" });
    expect(toolBlockSummary(block({ name: "read", args }))).toBe(
      "src/lib/foo.ts",
    );
  });

  it("grep 显示 pattern + path", () => {
    const args = JSON.stringify({
      pattern: "toolBlock",
      path: "src/lib",
    });
    expect(toolBlockSummary(block({ name: "grep", args }))).toBe(
      "/toolBlock/ src/lib",
    );
  });

  it("edit 显示 filePath +N/−M", () => {
    const diff = ["--- a/f", "+++ b/f", "-a", "+b", "+c"].join("\n");
    const s = toolBlockSummary(
      block({
        name: "edit",
        args: JSON.stringify({ path: "a.ts", old: "x".repeat(200) }),
        result: {
          callId: "c1",
          name: "edit",
          status: "success",
          output: "",
          filePath: "src/a.ts",
          diff,
        },
      }),
    );
    expect(s).toBe("src/a.ts +2/−1");
    expect(s.includes("{")).toBe(false);
  });

  it("args 截断后缀仍可 parse；纯 JSON 兜底不 dump", () => {
    const raw = JSON.stringify({ command: "echo hi" });
    const truncated = `${raw.slice(0, 10)}…(truncated 99 chars)`;
    expect(parseToolArgsJson(raw)).toEqual({ command: "echo hi" });
    const parsed = parseToolArgsJson(truncated);
    if (!parsed) {
      const s = toolBlockSummary(block({ name: "shell", args: truncated }));
      expect(s.includes('"command"')).toBe(false);
    }
  });

  it("非 JSON args 且不像对象字面量时保留原文截断", () => {
    expect(
      toolBlockSummary(block({ name: "unknown", args: "plain text cmd" })),
    ).toBe("plain text cmd");
  });
});

describe("parseTaskToolArgs", () => {
  it("完整 JSON 字符串解析 description + prompt", () => {
    const args = JSON.stringify({
      description: "修登录态",
      prompt: "请排查 auth cookie\n第二行",
      model: "fast",
    });
    expect(parseTaskToolArgs(args)).toEqual({
      description: "修登录态",
      prompt: "请排查 auth cookie\n第二行",
      model: "fast",
    });
  });

  it("接受已解析对象", () => {
    expect(
      parseTaskToolArgs({
        description: "读代码",
        prompt: "扫 src/",
      }),
    ).toEqual({ description: "读代码", prompt: "扫 src/", model: null });
  });

  it("残缺流式 JSON 前缀安全抠字段", () => {
    const partial =
      '{"description":"调研库","prompt":"去 github 找找有什么库、我们直接';
    const got = parseTaskToolArgs(partial);
    expect(got).not.toBeNull();
    expect(got?.description).toBe("调研库");
    expect(got?.prompt?.startsWith("去 github")).toBe(true);
  });

  it("只有 description 的残缺前缀也可", () => {
    expect(parseTaskToolArgs('{"description":"半成品任务"')).toEqual({
      description: "半成品任务",
      prompt: null,
      model: null,
    });
  });

  it("完全无法解析时返 null", () => {
    expect(parseTaskToolArgs("")).toBeNull();
    expect(parseTaskToolArgs(undefined)).toBeNull();
    expect(parseTaskToolArgs("{")).toBeNull();
    expect(parseTaskToolArgs('{"foo":1}')).toBeNull();
  });

  it("非 task 形态 args（无 description/prompt）返 null", () => {
    expect(
      parseTaskToolArgs(JSON.stringify({ command: "ls -la", path: "/tmp" })),
    ).toBeNull();
  });
});

describe("toolBlockExpandedArgsPreview", () => {
  it("task 工具展示 description + prompt 前几行", () => {
    const preview = toolBlockExpandedArgsPreview(
      block({
        name: "task",
        status: "running",
        args: JSON.stringify({
          description: "子代理修 bug",
          prompt: "第一行\n第二行\n第三行\n第四行不该出现",
        }),
      }),
    );
    expect(preview).toContain("子代理修 bug");
    expect(preview).toContain("第一行");
    expect(preview).toContain("第三行");
    expect(preview?.includes("第四行")).toBe(false);
  });

  it("无 detailLine 时截断 args JSON 单行兜底", () => {
    const args = JSON.stringify({ weird_field: "x".repeat(80) });
    // text 含 { 且等于 summary → detailLine 返 null，走 args 截断
    const preview = toolBlockExpandedArgsPreview(
      block({
        name: "obscure_tool",
        args,
        text: `调用 obscure_tool:${args}`,
      }),
    );
    expect(preview).toBeTruthy();
    expect(preview!.includes("weird_field")).toBe(true);
    expect(preview!.endsWith("…") || preview!.length <= 160).toBe(true);
  });
});
