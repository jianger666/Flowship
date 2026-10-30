/**
 * R14 Q11b-06：Cursor SDK 自有工具（`buildSdkCustomTools`）的 `execute` 兜底。
 *
 * 改前 `execute` 直接 `await t.handler(args, …)`：handler 抛错（各 handler 里的 `getTask` 都在 try 之外；
 * `args` 为 undefined / null 时 `args.task_id` 直接 TypeError）就把异常原样抛给 SDK——抛错后怎么呈现取决于
 * SDK 内部（读不到），模型拿不到一句可自修复的话；而 pi 桥与 `subagent` 工具都把异常转成「文本 + isError」，
 * 两条后端口径不一。改后：捕获 → `{ content:[「工具 X 执行失败：原因」], isError:true }`；`args` 为空按 `{}` 处理。
 *
 * 用往 `flowShipTools` 里临时塞一个假工具的办法注入抛错的 handler（真 `buildSdkCustomTools`）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildSdkCustomTools,
  flowShipTools,
  type FlowshipToolDef,
} from "@/lib/server/flowship-tools";

const FAKE = "r14_fake_tool";

let fake: FlowshipToolDef;
let handler: ReturnType<typeof vi.fn>;
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  handler = vi.fn();
  fake = {
    name: FAKE,
    label: "假工具",
    description: "测试用",
    parameters: { type: "object", properties: {} },
    handler: handler as unknown as FlowshipToolDef["handler"],
  };
  flowShipTools.push(fake);
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  const i = flowShipTools.indexOf(fake);
  if (i >= 0) flowShipTools.splice(i, 1);
  vi.restoreAllMocks();
});

const exec = (args: unknown, ctx: unknown = {}) => {
  const tool = buildSdkCustomTools("caller_x", { taskId: "t_1", waitScope: "scope_1" })[FAKE]!;
  return tool.execute(args as never, ctx as never);
};

describe("SDK customTool execute 兜底", () => {
  it("handler 抛 Error → 回「工具 X 执行失败：原因」+ isError（改前：异常原样抛给 SDK）", async () => {
    handler.mockRejectedValue(new Error("读盘失败 EIO"));
    const r = await exec({ task_id: "t_1" });
    expect(r).toEqual({
      content: [{ type: "text", text: `工具 ${FAKE} 执行失败：读盘失败 EIO` }],
      isError: true,
    });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain(FAKE);
  });

  it("handler 同步抛错（不是 reject）同样兜住", async () => {
    handler.mockImplementation(() => {
      throw new TypeError("Cannot read properties of undefined (reading 'x')");
    });
    const r = (await exec({})) as { isError?: boolean; content: Array<{ text: string }> };
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toContain("Cannot read properties of undefined");
  });

  it("handler 抛的不是 Error（字符串）→ 用 String(err)", async () => {
    handler.mockRejectedValue("纯字符串失败");
    const r = (await exec({})) as { content: Array<{ text: string }> };
    expect(r.content[0]?.text).toBe(`工具 ${FAKE} 执行失败：纯字符串失败`);
  });

  it("args 为 undefined / null → 按 {} 交给 handler（不在入口就 TypeError）", async () => {
    handler.mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
    for (const args of [undefined, null]) {
      handler.mockClear();
      const r = await exec(args);
      expect(r).toEqual({ content: [{ type: "text", text: "ok" }] });
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0]?.[0]).toEqual({});
    }
  });

  it("对照：正常返回原样转出（没有多余的 isError 字段）；callerToken 与 ctx（taskId / scope）照传", async () => {
    handler.mockResolvedValue({ content: [{ type: "text", text: "做完了" }] });
    const r = await exec({ task_id: "t_1", x: 1 });
    expect(r).toEqual({ content: [{ type: "text", text: "做完了" }] });
    expect(Object.keys(r as object)).toEqual(["content"]);
    expect(handler).toHaveBeenCalledWith({ task_id: "t_1", x: 1 }, "caller_x", { taskId: "t_1", scope: "scope_1" });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("兜底只管 execute：每个真工具都有 execute，覆盖全部平台工具名（对照）", () => {
    const tools = buildSdkCustomTools("caller_x");
    for (const t of flowShipTools) expect(typeof tools[t.name]?.execute).toBe("function");
  });

  it("真工具：入参缺项不抛——`args` 为 {} 时 submit_work 回文本（身份校验不过）而不是异常", async () => {
    const tools = buildSdkCustomTools("caller_x");
    const r = (await tools.submit_work!.execute({} as never, {} as never)) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };
    expect(typeof r.content[0]?.text).toBe("string");
    expect(r.isError).toBeUndefined();
  });
});
