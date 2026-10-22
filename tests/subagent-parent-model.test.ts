/**
 * 父会话模型登记（子代理卡片徽标用）：模块本身 + 从 facade 到事件落盘的接线契约。
 *
 * 为什么要有接线契约：徽标要显示「沿用」的实际模型，靠的是 facade 登记 → runner 取出 → handler 改写
 * 这一整条链；任何一环被改掉（比如有人新增一个 consume 入口、忘了传），测试全绿但徽标悄悄退回 `inherit`。
 * 这里按源码断言每一环都在。
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  getSubagentDisplayLookup,
  getSubagentParentModel,
  setSubagentDisplayLookup,
  setSubagentParentModel,
} from "@/lib/server/subagent-parent-model";

const src = (rel: string): string =>
  readFileSync(path.join(process.cwd(), rel), "utf8");

describe("subagent-parent-model", () => {
  it("登记 / 读取；没登记的、非对象的 → undefined", () => {
    const agent = {};
    setSubagentParentModel(agent, { id: "m", params: [{ id: "effort", value: "low" }] });
    expect(getSubagentParentModel(agent)).toEqual({
      id: "m",
      params: [{ id: "effort", value: "low" }],
    });
    expect(getSubagentParentModel({})).toBeUndefined();
    for (const v of [undefined, null, "str", 1, true]) {
      expect(getSubagentParentModel(v)).toBeUndefined();
    }
  });

  it("登记 undefined 也合法（父会话没显式选模型）：读出来是 undefined，不抛", () => {
    const agent = {};
    setSubagentParentModel(agent, undefined);
    expect(getSubagentParentModel(agent)).toBeUndefined();
  });

  it("表挂在 globalThis 上：模块被重复加载（Next 多个 chunk / HMR）也读得到别的副本登记的", async () => {
    const agent = {};
    setSubagentParentModel(agent, { id: "from-first-copy" });
    vi.resetModules();
    const second = await import("@/lib/server/subagent-parent-model");
    expect(second.getSubagentParentModel(agent)).toEqual({ id: "from-first-copy" });
  });

  it("键是对象本身（WeakMap）：换一个对象读不到，不按内容 / id 误命中", () => {
    const a = { agentId: "same" };
    const b = { agentId: "same" };
    setSubagentParentModel(a, { id: "m" });
    expect(getSubagentParentModel(b)).toBeUndefined();
  });
});

describe("subagent-parent-model · 查表函数（默认档 / resume 子代理模型）", () => {
  it("登记 / 读取；没登记的、非对象的 → undefined", () => {
    const agent = {};
    const lookup = { defaultEffortOf: () => "high" };
    setSubagentDisplayLookup(agent, lookup);
    expect(getSubagentDisplayLookup(agent)).toBe(lookup);
    expect(getSubagentDisplayLookup({})).toBeUndefined();
    for (const v of [undefined, null, "str", 1, true]) {
      expect(getSubagentDisplayLookup(v)).toBeUndefined();
    }
  });

  it("与父模型表互不干扰：只登记父模型读不到查表函数，反之亦然", () => {
    const a = {};
    setSubagentParentModel(a, { id: "m" });
    expect(getSubagentDisplayLookup(a)).toBeUndefined();
    const b = {};
    setSubagentDisplayLookup(b, {});
    expect(getSubagentParentModel(b)).toBeUndefined();
  });

  it("表挂在 globalThis 上：模块被重复加载也读得到别的副本登记的", async () => {
    const agent = {};
    const lookup = { resumedChildOf: () => ({ model: "m" }) };
    setSubagentDisplayLookup(agent, lookup);
    vi.resetModules();
    const second = await import("@/lib/server/subagent-parent-model");
    expect(second.getSubagentDisplayLookup(agent)).toBe(lookup);
  });

  it("键是对象本身（WeakMap）：换一个对象读不到", () => {
    const a = { agentId: "same" };
    const b = { agentId: "same" };
    setSubagentDisplayLookup(a, {});
    expect(getSubagentDisplayLookup(b)).toBeUndefined();
  });
});

describe("接线契约：facade 登记 → runner 取 → handler 改写", () => {
  it("cursor-subagent.attach 把父模型登记在返回给调用方的（被包装的）对象上", () => {
    const code = src("src/lib/server/cursor-subagent.ts");
    expect(code).toMatch(/setSubagentParentModel\(\s*wrapped\s*,\s*deps\.parentModel\s*\)/);
  });

  it("cursor-subagent.attach 把查表函数（默认档 / resume 子代理模型）也登记在同一个对象上", () => {
    const code = src("src/lib/server/cursor-subagent.ts");
    expect(code).toMatch(
      /setSubagentDisplayLookup\(\s*wrapped\s*,\s*\{\s*defaultEffortOf\s*,\s*resumedChildOf\s*\}\s*\)/,
    );
  });

  it("task-runner / chat-runner 的流消费 ctx 都带 subagentParentModel（取自各自持有的 agent）", () => {
    const task = src("src/lib/server/task-runner.ts");
    expect(task).toMatch(/subagentParentModel:\s*getSubagentParentModel\(agent\)/);
    const chat = src("src/lib/server/chat-runner.ts");
    expect(chat).toMatch(/subagentParentModel:\s*getSubagentParentModel\(rec\?\.agent\)/);
    expect(task).toMatch(
      /subagentDisplayLookup:\s*getSubagentDisplayLookup\(agent\)/,
    );
    expect(chat).toMatch(
      /subagentDisplayLookup:\s*getSubagentDisplayLookup\(rec\?\.agent\)/,
    );
    for (const code of [task, chat]) {
      expect(code).toMatch(
        /import \{\s*getSubagentDisplayLookup,\s*getSubagentParentModel,?\s*\} from "\.\/subagent-parent-model"/,
      );
    }
  });

  it("handler 改写 subagent 卡片时把 ctx 上的父模型交给 toSubagentDisplayCall", () => {
    const code = src("src/lib/server/sdk-message-handler.ts");
    expect(code).toMatch(
      /toSubagentDisplayCall\(\s*rawMsg\s*,\s*\{\s*parentModel:\s*assistantCtx\.subagentParentModel/,
    );
    // 查表函数（默认档 / resume 子代理模型）也要展开进同一个 ctx，否则这两类卡片悄悄退回无徽标
    expect(code).toMatch(
      /parentModel:\s*assistantCtx\.subagentParentModel,\s*\.\.\.assistantCtx\.subagentDisplayLookup/,
    );
  });

  it("runner 只从无依赖的小模块取，不从 agent-backend / cursor-subagent 取（runner 测试普遍 mock 掉 agent-backend）", () => {
    for (const rel of ["src/lib/server/task-runner.ts", "src/lib/server/chat-runner.ts"]) {
      const code = src(rel);
      expect(code).not.toMatch(/getSubagentParentModel[^;]*from "\.\/agent-backend"/);
      expect(code).not.toMatch(/getSubagentParentModel[^;]*from "\.\/cursor-subagent"/);
      expect(code).not.toMatch(/getSubagentDisplayLookup[^;]*from "\.\/agent-backend"/);
      expect(code).not.toMatch(/getSubagentDisplayLookup[^;]*from "\.\/cursor-subagent"/);
    }
  });
});
