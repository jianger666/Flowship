/**
 * /api/system/feishu-cli 的 cancel-login 分发（R14 B6-6 · Q6-01）。
 *
 * 直接调 POST handler，把 `@/lib/server/feishu-cli` 整个换成假的：这里只验分发、参数校验和状态码；
 * 取消本身的行为（信号 / 超时 / 卸载联动）在 feishu-cli-login-cancel.test.ts 里用真实模块验。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  cancelLogin: vi.fn(),
  startLogin: vi.fn(),
  startInstall: vi.fn(),
}));

vi.mock("@/lib/server/feishu-cli", () => ({
  cancelLogin: m.cancelLogin,
  getFeishuCliStatus: vi.fn(async () => ({})),
  getInstallState: vi.fn(() => ({ running: false, log: [] })),
  getLoginState: vi.fn(() => null),
  startInstall: m.startInstall,
  startLogin: m.startLogin,
  uninstallFeishuTools: vi.fn(async () => {}),
}));

import { POST } from "@/app/api/system/feishu-cli/route";

const post = (body: unknown) =>
  POST(
    new Request("http://localhost/api/system/feishu-cli", {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );

beforeEach(() => {
  m.cancelLogin.mockReset();
  m.startLogin.mockReset();
  m.startInstall.mockReset();
});

describe("POST { action: 'cancel-login' }", () => {
  it.each(["lark-cli", "meegle"] as const)("%s：转给 cancelLogin，回 200 { ok, cancelled }", async (tool) => {
    m.cancelLogin.mockResolvedValue({ cancelled: true });
    const res = await post({ action: "cancel-login", tool });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, cancelled: true });
    expect(m.cancelLogin).toHaveBeenCalledTimes(1);
    expect(m.cancelLogin).toHaveBeenCalledWith(tool);
  });

  it("没有登录在跑（幂等）：cancelled: false 原样透传，仍是 200", async () => {
    m.cancelLogin.mockResolvedValue({ cancelled: false });
    const res = await post({ action: "cancel-login", tool: "lark-cli" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, cancelled: false });
  });

  it.each([undefined, "", "evil", "LARK-CLI", "meegle ", 123, null])(
    "tool 缺失 / 非法（%j）→ 400，不调 cancelLogin",
    async (tool) => {
      const res = await post({ action: "cancel-login", tool });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("tool 必须是 lark-cli 或 meegle");
      expect(m.cancelLogin).not.toHaveBeenCalled();
    },
  );
});

describe("其余分发不受影响（回归）", () => {
  it("未知 action → 400「未知 action」，不碰 cancelLogin", async () => {
    const res = await post({ action: "cancel", tool: "lark-cli" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("未知 action");
    expect(m.cancelLogin).not.toHaveBeenCalled();
  });

  it("body 不是合法 JSON → 400", async () => {
    const res = await post("{not json");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("body 不是合法 JSON");
  });

  it("login：成功 200；失败 409 且 error 原文；参数原样传给 startLogin", async () => {
    m.startLogin.mockResolvedValue({ ok: true });
    const ok = await post({ action: "login", tool: "meegle", meegleHost: "project.example.com" });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true });
    expect(m.startLogin).toHaveBeenCalledWith("meegle", { meegleHost: "project.example.com" });

    m.startLogin.mockResolvedValue({ ok: false, error: "登录流程已在进行中" });
    const busy = await post({ action: "login", tool: "lark-cli" });
    expect(busy.status).toBe(409);
    expect((await busy.json()).error).toBe("登录流程已在进行中");
  });

  it("login：tool 非法 → 400，不调 startLogin", async () => {
    const res = await post({ action: "login", tool: "evil" });
    expect(res.status).toBe(400);
    expect(m.startLogin).not.toHaveBeenCalled();
  });

  it("install：started 原样透传", async () => {
    m.startInstall.mockReturnValue(true);
    const res = await post({ action: "install" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, started: true });
  });
});
