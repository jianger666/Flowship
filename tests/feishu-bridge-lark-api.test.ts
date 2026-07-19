/**
 * lark-api：错误归一化（permission_violations / console_url）+ 队列串行
 */
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  __resetLarkBinCacheForTest,
  __setLarkExecForTest,
  larkApi,
  normalizeLarkError,
  runLark,
  uploadImage,
} from "@/lib/server/feishu-bridge/lark-api";
import { LarkApiError } from "@/lib/server/feishu-bridge/types";

afterEach(() => {
  __setLarkExecForTest(null);
  __resetLarkBinCacheForTest();
});

describe("normalizeLarkError", () => {
  it("从 stdout JSON 抽出 permission_violations + console_url", () => {
    const err = normalizeLarkError({
      message: "Command failed",
      stdout: JSON.stringify({
        ok: false,
        error: {
          code: 99991672,
          message: "Access denied",
          permission_violations: [{ subject: "cardkit:card:write" }],
          console_url: "https://open.feishu.cn/app/cli_xxx/auth?q=cardkit:card:write",
        },
      }),
      stderr: "",
    });
    expect(err).toBeInstanceOf(LarkApiError);
    expect(err.message).toBe("Access denied");
    expect(err.code).toBe(99991672);
    expect(err.permissionViolations).toEqual([
      { subject: "cardkit:card:write" },
    ]);
    expect(err.consoleUrl).toContain("open.feishu.cn");
  });

  it("超时 killed → 明确超时文案", () => {
    const err = normalizeLarkError({
      message: "killed",
      killed: true,
      code: null,
    });
    expect(err.message).toMatch(/超时/);
  });
});

describe("runLark / larkApi（mock exec）", () => {
  it("ok:false 抛 LarkApiError 且带权限字段", async () => {
    __setLarkExecForTest(async () => ({
      stdout: JSON.stringify({
        ok: false,
        error: {
          message: "no scope",
          permission_violations: ["im:message:send_as_bot"],
          console_url: "https://open.feishu.cn/app/x/auth",
        },
      }),
      stderr: "",
    }));
    await expect(runLark(["auth", "status"])).rejects.toMatchObject({
      name: "LarkApiError",
      message: "no scope",
      consoleUrl: "https://open.feishu.cn/app/x/auth",
    });
  });

  it("larkApi 拼 METHOD/path/--data", async () => {
    const calls: string[][] = [];
    __setLarkExecForTest(async (_bin, args) => {
      calls.push(args);
      return {
        stdout: JSON.stringify({ ok: true, data: { card_id: "c1" } }),
        stderr: "",
      };
    });
    const rec = await larkApi("POST", "/open-apis/cardkit/v1/cards", {
      data: { type: "card_json", data: "{}" },
    });
    expect(rec.data).toEqual({ card_id: "c1" });
    expect(calls[0]?.slice(0, 3)).toEqual([
      "api",
      "POST",
      "/open-apis/cardkit/v1/cards",
    ]);
    expect(calls[0]).toContain("--as");
    expect(calls[0]).toContain("bot");
    expect(calls[0]).toContain("--json");
  });

  it("串行队列：后调用等前调用结束", async () => {
    const order: number[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let n = 0;
    __setLarkExecForTest(async () => {
      const id = ++n;
      if (id === 1) await gate;
      order.push(id);
      return { stdout: JSON.stringify({ ok: true, data: { id } }), stderr: "" };
    });
    const p1 = runLark(["a"]);
    const p2 = runLark(["b"]);
    // 尚未 release：order 应仍空或只有准备中
    await vi.waitFor(() => expect(n).toBe(1));
    expect(order).toEqual([]);
    release();
    await Promise.all([p1, p2]);
    expect(order).toEqual([1, 2]);
  });
});

describe("uploadImage", () => {
  it("绝对路径 → cwd=dirname + --file image=<basename>（lark-cli 拒绝对路径）", async () => {
    const abs = "/tmp/feishu-upload-fixture/att_demo.png";
    const calls: Array<{
      args: string[];
      cwd?: string;
    }> = [];
    __setLarkExecForTest(async (_bin, args, opts) => {
      calls.push({ args, cwd: opts.cwd });
      return {
        stdout: JSON.stringify({
          ok: true,
          data: { image_key: "img_v3_test_key" },
        }),
        stderr: "",
      };
    });
    const key = await uploadImage(abs);
    expect(key).toBe("img_v3_test_key");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.cwd).toBe(path.dirname(abs));
    expect(calls[0]?.args).toContain("--file");
    expect(calls[0]?.args).toContain("image=att_demo.png");
    // 绝不能把绝对路径塞进 --file
    expect(calls[0]?.args.some((a) => a.includes("/tmp/"))).toBe(false);
  });
});
