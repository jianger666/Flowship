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
});
