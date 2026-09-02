/**
 * Cursor SDK 系统工具走 local.customTools（不再注入 HTTP flowshipChat）。
 */
import { describe, expect, it } from "vitest";

import {
  FLOWSHIP_SDK_CUSTOM_TOOLS_SERVER,
  buildSdkCustomTools,
  flowShipTools,
  withFlowshipSdkCustomTools,
} from "@/lib/server/flowship-tools";

describe("buildSdkCustomTools", () => {
  it("覆盖全部平台工具名，且 schema 是 JSON object", () => {
    const tools = buildSdkCustomTools("caller_test");
    expect(Object.keys(tools).sort()).toEqual(
      flowShipTools.map((t) => t.name).sort(),
    );
    expect(tools.ask_user?.description).toContain("curl");
    expect(tools.submit_work?.inputSchema).toMatchObject({ type: "object" });
    expect(typeof tools.ask_user?.execute).toBe("function");
  });

  it("无 callerToken 不挂 customTools；已有的不覆盖", () => {
    expect(withFlowshipSdkCustomTools({ cwd: "/tmp" }, undefined)).toEqual({
      cwd: "/tmp",
    });
    const existing = { cwd: "/tmp", customTools: { keep: { execute: async () => "" } } };
    expect(withFlowshipSdkCustomTools(existing, "tok")).toBe(existing);
    const attached = withFlowshipSdkCustomTools({ cwd: "/tmp" }, "tok") as {
      cwd: string;
      customTools?: Record<string, { execute?: unknown }>;
    };
    expect(attached.customTools?.ask_user).toBeDefined();
  });

  it("合成 MCP 名是 custom-user-tools", () => {
    expect(FLOWSHIP_SDK_CUSTOM_TOOLS_SERVER).toBe("custom-user-tools");
  });

  it("notify_group_testers 与 share_to_group 职责分开", () => {
    const names = flowShipTools.map((t) => t.name);
    expect(names).toContain("notify_group_testers");
    expect(names).toContain("share_to_group");
    const notify = flowShipTools.find((t) => t.name === "notify_group_testers");
    const share = flowShipTools.find((t) => t.name === "share_to_group");
    expect(notify?.description).toContain("不要用 share_to_group 代替");
    expect(share?.description).toContain("notify_group_testers");
  });

  it("notify_group_testers caller 不对 → 忽略", async () => {
    const notify = flowShipTools.find((t) => t.name === "notify_group_testers");
    const result = await notify!.handler(
      { task_id: "task-x", action_id: "act-1" },
      "not-the-owner",
    );
    expect(result.content[0]?.text).toContain("接管");
  });
});
