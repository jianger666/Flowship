/**
 * 工具块「路径可点跳 IDE」+ verb group 文案分类的纯函数契约
 *
 * 覆盖三件事：
 *  1. 从工具块抽文件路径（哪些工具算「指向单个文件」）
 *  2. 相对 / 绝对判定 + 跟 cwd 拼绝对路径（拼不出 = 渲染层退化纯文本）
 *  3. verb group 按成员实际动作分类计数（原来一律「读取了 N 个文件」是错的）
 */

import { describe, expect, it } from "vitest";

import { resolveIdeTarget } from "../src/lib/path-utils";
import {
  classifyVerbTool,
  toolBlockFilePath,
  toolDetailPathSegment,
  toolPathNeedsBaseDir,
  verbGroupLabel,
  type ToolBlock,
  type ToolVerbGroup,
} from "../src/lib/tool-display";
import type { ToolResultEventMeta } from "../src/lib/types";

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

const result = (
  partial: Partial<ToolResultEventMeta>,
): ToolResultEventMeta =>
  ({
    callId: "c1",
    name: "edit",
    status: "success",
    output: "",
    ...partial,
  }) as ToolResultEventMeta;

const group = (members: ToolBlock[]): ToolVerbGroup => ({
  kind: "__tool_verb_group__",
  id: "verb_1",
  members,
  ts: 1,
});

describe("toolBlockFilePath：工具块指向哪个文件", () => {
  it("edit / write 优先用 result.filePath（服务端落盘时带的绝对路径）", () => {
    expect(
      toolBlockFilePath(
        block({
          name: "edit",
          args: '{"path":"src/a.ts"}',
          result: result({ filePath: "/repo/src/a.ts" }),
        }),
      ),
    ).toBe("/repo/src/a.ts");
  });

  it("read 没有 result.filePath 时从 args 抽 path 类字段", () => {
    expect(
      toolBlockFilePath(block({ name: "read", args: '{"path":"src/a.ts"}' })),
    ).toBe("src/a.ts");
    expect(
      toolBlockFilePath(
        block({ name: "write", args: '{"target_file":"src/b.ts"}' }),
      ),
    ).toBe("src/b.ts");
  });

  it("shell / 子代理 / 待办：不指向单个文件、返 null", () => {
    expect(
      toolBlockFilePath(block({ name: "shell", args: '{"command":"ls src"}' })),
    ).toBeNull();
    expect(
      toolBlockFilePath(
        block({ name: "task", args: '{"description":"跑个子代理"}' }),
      ),
    ).toBeNull();
    expect(
      toolBlockFilePath(
        block({ name: "updateTodos", args: '{"todos":[{"content":"x"}]}' }),
      ),
    ).toBeNull();
  });

  it("grep / glob / list 的 path 是目录、不给链接（跳过去会换掉 IDE 工作区）", () => {
    expect(
      toolBlockFilePath(
        block({ name: "grep", args: '{"pattern":"foo","path":"/repo/src"}' }),
      ),
    ).toBeNull();
    expect(
      toolBlockFilePath(
        block({ name: "list_dir", args: '{"path":"/repo/src"}' }),
      ),
    ).toBeNull();
  });

  it("args 非 JSON / 无路径字段 → null", () => {
    expect(toolBlockFilePath(block({ name: "read", args: "乱码" }))).toBeNull();
    expect(toolBlockFilePath(block({ name: "read" }))).toBeNull();
  });
});

describe("toolDetailPathSegment：展开区 detail 行里可点的那一段", () => {
  it("detail 就是路径（read）", () => {
    expect(toolDetailPathSegment("/repo/src/a.ts", "/repo/src/a.ts")).toBe(
      "/repo/src/a.ts",
    );
  });

  it("detail 是「路径 +N/−M」（edit）→ 只有路径段可点", () => {
    expect(
      toolDetailPathSegment("/repo/src/a.ts +3/−1", "/repo/src/a.ts"),
    ).toBe("/repo/src/a.ts");
  });

  it("超长路径被摘要截断成前缀 + … → 仍认成路径段（链接指向全路径）", () => {
    const long = `/repo/${"seg/".repeat(40)}index.tsx`;
    const clipped = `${long.slice(0, 120)}…`;
    expect(toolDetailPathSegment(clipped, long)).toBe(clipped);
  });

  it("shell 命令 / 无路径 → null（整行走纯文本）", () => {
    expect(toolDetailPathSegment("$ pnpm test", "/repo/src/a.ts")).toBeNull();
    expect(toolDetailPathSegment("$ pnpm test", null)).toBeNull();
    expect(toolDetailPathSegment(null, "/repo/src/a.ts")).toBeNull();
  });
});

describe("toolPathNeedsBaseDir：要不要去查 task cwd", () => {
  it("绝对路径直接能跳、不用查", () => {
    expect(toolPathNeedsBaseDir("/repo/src/a.ts")).toBe(false);
    expect(toolPathNeedsBaseDir("D:\\repo\\src\\a.ts")).toBe(false);
    expect(toolPathNeedsBaseDir("D:/repo/src/a.ts")).toBe(false);
  });

  it("相对路径要拼 cwd", () => {
    expect(toolPathNeedsBaseDir("src/a.ts")).toBe(true);
    expect(toolPathNeedsBaseDir("./src/a.ts")).toBe(true);
  });

  it("url / 空串：给什么 cwd 都跳不了、不必查", () => {
    expect(toolPathNeedsBaseDir("https://x.com/a.ts")).toBe(false);
    expect(toolPathNeedsBaseDir("cursor://file/a.ts")).toBe(false);
    expect(toolPathNeedsBaseDir("")).toBe(false);
  });
});

describe("路径拼接与退化判定（resolveIdeTarget 在工具块语境下的契约）", () => {
  it("相对路径 + cwd → 拼成绝对路径", () => {
    expect(resolveIdeTarget("src/a.ts", "/repo")).toEqual({
      absolute: "/repo/src/a.ts",
      line: undefined,
    });
    expect(resolveIdeTarget("./src/a.ts", "/repo/")).toEqual({
      absolute: "/repo/src/a.ts",
      line: undefined,
    });
  });

  it("相对路径 + 没 cwd → null（渲染层退化纯文本、不给点了没反应的链接）", () => {
    expect(resolveIdeTarget("src/a.ts", undefined)).toBeNull();
  });

  it("绝对路径忽略 cwd；url 一律 null", () => {
    expect(resolveIdeTarget("/repo/src/a.ts", "/other")).toEqual({
      absolute: "/repo/src/a.ts",
      line: undefined,
    });
    expect(resolveIdeTarget("https://x.com/a.ts", "/repo")).toBeNull();
  });

  it("diff 行号走 `path:line` 后缀、拆出起始行", () => {
    expect(resolveIdeTarget("src/a.ts:42", "/repo")).toEqual({
      absolute: "/repo/src/a.ts",
      line: 42,
    });
    expect(resolveIdeTarget("/repo/src/a.ts:42")).toEqual({
      absolute: "/repo/src/a.ts",
      line: 42,
    });
  });
});

describe("classifyVerbTool：成员动作分类", () => {
  it("读文件类", () => {
    expect(classifyVerbTool("read")).toBe("read");
    expect(classifyVerbTool("read_file")).toBe("read");
    expect(classifyVerbTool("Read")).toBe("read");
  });

  it("搜索类（grep / glob / semantic search）", () => {
    expect(classifyVerbTool("grep")).toBe("search");
    expect(classifyVerbTool("glob")).toBe("search");
    expect(classifyVerbTool("codebase_search")).toBe("search");
  });

  it("列目录类", () => {
    expect(classifyVerbTool("ls")).toBe("list");
    expect(classifyVerbTool("list_dir")).toBe("list");
  });

  it("联网类优先于 search（web_search 名字里也有 search）", () => {
    expect(classifyVerbTool("web_search")).toBe("web");
    expect(classifyVerbTool("web_fetch")).toBe("web");
  });
});

describe("verbGroupLabel：按实际动作分类计数", () => {
  it("全是搜索时不再谎报「读取了 N 个文件」", () => {
    const label = verbGroupLabel(
      group([
        block({ name: "grep", id: "1" }),
        block({ name: "grep", id: "2" }),
        block({ name: "glob", id: "3" }),
      ]),
    );
    expect(label).toBe("搜索了 3 次…");
  });

  it("混合成员按类拼接、顺序固定（读 → 搜 → 列 → 联网）", () => {
    expect(
      verbGroupLabel(
        group([
          block({ name: "grep", id: "1" }),
          block({ name: "read", id: "2" }),
          block({ name: "read", id: "3" }),
          block({ name: "list_dir", id: "4" }),
          block({ name: "web_search", id: "5" }),
        ]),
      ),
    ).toBe("读取了 2 个文件 · 搜索了 1 次 · 列了 1 个目录 · 联网查了 1 次…");
  });

  it("有失败成员时带失败数、不带省略号", () => {
    expect(
      verbGroupLabel(
        group([
          block({ name: "read", id: "1" }),
          block({ name: "read", id: "2", status: "error" }),
        ]),
      ),
    ).toBe("读取了 2 个文件（1 失败）");
  });
});
