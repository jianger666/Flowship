import { describe, expect, it } from "vitest";

import {
  countDiffStats,
  isEphemeralToolOutputDelta,
  isTodoTool,
  isVerbGroupMember,
  mergeToolDisplayEvents,
  parseTaskToolArgs,
  parseTodoToolArgs,
  parseToolArgsJson,
  parseUnifiedDiff,
  todoListSummary,
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

  it("同 callId 多条 tool_call 去重：args 取更长、id/ts 留第一条并配对 result", () => {
    // 历史双写：SDK 对同一 call 发两次 running，落盘成两条 tool_call
    const shortArgs = JSON.stringify({ description: "扫代码" });
    const longArgs = JSON.stringify({
      description: "扫代码找 bug",
      prompt: "请完整排查 auth 相关路径",
      model: "fast",
    });
    const call1 = ev({
      id: "tc_first",
      kind: "tool_call",
      text: "调用 task",
      ts: 10,
      meta: { callId: "dup1", name: "task", args: shortArgs },
    });
    const call2 = ev({
      id: "tc_second",
      kind: "tool_call",
      text: "调用 task",
      ts: 11,
      meta: { callId: "dup1", name: "task", args: longArgs },
    });
    const result = ev({
      id: "tr1",
      kind: "tool_result",
      text: "工具完成 task",
      ts: 20,
      meta: {
        callId: "dup1",
        name: "task",
        status: "success",
        output: "## 结论\n已修好",
      },
    });
    const out = mergeToolDisplayEvents([call1, call2, result]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      kind: "__tool_block__",
      id: "tc_first",
      callId: "dup1",
      name: "task",
      status: "success",
      args: longArgs,
    });
    // ts 用第一条 tool_call 的 id 锚定位置；配对后 result 的 ts 覆盖（与单条配对一致）
    expect((out[0] as ToolBlock).ts).toBe(20);
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

describe("parseUnifiedDiff", () => {
  it("标准 diff：剥 ---/+++ 头、递推行号、剥 +/- 前缀", () => {
    const diff = [
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@ -7,5 +7,5 @@ function demo() {",
      "   keep",
      "-  old",
      "+  new",
      "   tail",
    ].join("\n");

    const lines = parseUnifiedDiff(diff);
    expect(lines.some((l) => l.text.includes("---") || l.text.includes("+++"))).toBe(
      false,
    );
    expect(lines[0]).toEqual({ kind: "hunk", text: "" });
    expect(lines[1]).toEqual({
      kind: "context",
      oldLine: 7,
      newLine: 7,
      text: "  keep",
    });
    expect(lines[2]).toEqual({ kind: "del", oldLine: 8, text: "  old" });
    expect(lines[3]).toEqual({ kind: "add", newLine: 8, text: "  new" });
    expect(lines[4]).toEqual({
      kind: "context",
      oldLine: 9,
      newLine: 9,
      text: "  tail",
    });
  });

  it("多 hunk：第二个 hunk 行号从新起点重置", () => {
    const diff = [
      "diff --git a/a.ts b/a.ts",
      "index 111..222 100644",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1,3 +1,3 @@",
      " a",
      "-b",
      "+B",
      "@@ -20,2 +20,3 @@",
      " x",
      "+y",
    ].join("\n");

    const lines = parseUnifiedDiff(diff);
    const hunks = lines.filter((l) => l.kind === "hunk");
    expect(hunks).toHaveLength(2);

    const secondHunkIdx = lines.findIndex(
      (l, i) => l.kind === "hunk" && i > 0,
    );
    expect(lines[secondHunkIdx + 1]).toEqual({
      kind: "context",
      oldLine: 20,
      newLine: 20,
      text: "x",
    });
    expect(lines[secondHunkIdx + 2]).toEqual({
      kind: "add",
      newLine: 21,
      text: "y",
    });
  });

  it("截断残行 / 空输入容错", () => {
    expect(parseUnifiedDiff("")).toEqual([]);
    expect(parseUnifiedDiff("@@ -1,2 +1,2 @@")).toEqual([
      { kind: "hunk", text: "" },
    ]);

    // 残缺 @@ 与无前缀残行：当 context、行号缺省
    const truncated = parseUnifiedDiff(
      ["@@ broken hunk header", "\\ No newline at end of file", "orphan"].join(
        "\n",
      ),
    );
    expect(truncated[0]).toEqual({ kind: "hunk", text: "" });
    expect(truncated[1]).toEqual({
      kind: "context",
      text: "\\ No newline at end of file",
    });
    expect(truncated[2]).toEqual({ kind: "context", text: "orphan" });
    expect(truncated[1].oldLine).toBeUndefined();
    expect(truncated[2].newLine).toBeUndefined();
  });
});

describe("parseTodoToolArgs / updateTodos 合并", () => {
  it("isTodoTool 识别 updateTodos / update_todos / todo_write 变体", () => {
    expect(isTodoTool("updateTodos")).toBe(true);
    expect(isTodoTool("Update_Todos")).toBe(true);
    expect(isTodoTool("todo_write")).toBe(true);
    expect(isTodoTool("TodoWrite")).toBe(true);
    expect(isTodoTool("shell")).toBe(false);
    expect(isVerbGroupMember("updateTodos")).toBe(false);
  });

  it("完整 JSON 解析 todos + 非法 status 当 pending", () => {
    const args = JSON.stringify({
      todos: [
        { content: "A", status: "completed" },
        { content: "B", status: "weird" },
        { status: "in_progress" },
      ],
      merge: true,
    });
    expect(parseTodoToolArgs(args)).toEqual([
      { content: "A", status: "completed" },
      { content: "B", status: "pending" },
      { content: "", status: "in_progress" },
    ]);
  });

  it("截断 JSON 尽量抠完整条目", () => {
    // 第三条 content 未闭合 → 只保留前两条完整对象
    const partial =
      '{"todos":[{"content":"一","status":"completed"},{"content":"二","status":"pending"},{"content":"三未闭合';
    const got = parseTodoToolArgs(partial);
    expect(got).toEqual([
      { content: "一", status: "completed" },
      { content: "二", status: "pending" },
    ]);
  });

  it("抠不出条目返 null", () => {
    expect(parseTodoToolArgs("")).toBeNull();
    expect(parseTodoToolArgs("{}")).toBeNull();
    expect(parseTodoToolArgs('{"todos":[')).toBeNull();
  });

  it("todoListSummary 与默认展开", () => {
    expect(
      todoListSummary([
        { content: "a", status: "completed" },
        { content: "b", status: "pending" },
        { content: "c", status: "completed" },
      ]),
    ).toBe("3 项 · 2 完成");
    expect(toolBlockDefaultCollapsed("updateTodos")).toBe(false);
    expect(
      toolBlockSummary(
        block({
          name: "updateTodos",
          args: JSON.stringify({
            todos: [
              { content: "x", status: "completed" },
              { content: "y", status: "pending" },
            ],
          }),
        }),
      ),
    ).toBe("2 项 · 1 完成");
  });

  it("连续三连 updateTodos + assistant 隔开的第四条 → 保留最新第三条 + 第四条", () => {
    const mkTodo = (
      id: string,
      callId: string,
      label: string,
      ts: number,
    ): TaskEvent =>
      ev({
        id,
        kind: "tool_call",
        text: "调用 updateTodos",
        ts,
        meta: {
          callId,
          name: "updateTodos",
          args: JSON.stringify({
            todos: [{ content: label, status: "pending" }],
            merge: true,
          }),
        },
      });

    const out = mergeToolDisplayEvents([
      mkTodo("t1", "c1", "v1", 1),
      mkTodo("t2", "c2", "v2", 2),
      mkTodo("t3", "c3", "v3", 3),
      ev({
        id: "a1",
        kind: "assistant_message",
        text: "中间旁白",
        ts: 4,
      }),
      mkTodo("t4", "c4", "v4", 5),
    ]);

    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({
      kind: "__tool_block__",
      id: "t3",
      callId: "c3",
      name: "updateTodos",
    });
    expect((out[0] as ToolBlock).args).toContain("v3");
    expect(out[1]).toMatchObject({ kind: "assistant_message", text: "中间旁白" });
    expect(out[2]).toMatchObject({
      kind: "__tool_block__",
      id: "t4",
      callId: "c4",
    });
    expect((out[2] as ToolBlock).args).toContain("v4");
  });
});
