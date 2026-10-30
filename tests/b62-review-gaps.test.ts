import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { validateMcpServerConfig } from "@/lib/mcp-config";

const read = (rel: string): string => readFileSync(join(process.cwd(), rel), "utf8");

describe("validateMcpServerConfig 补洞", () => {
  it("env 写成数组 → 拒绝（和 headers 是数组同口径）", () => {
    expect(validateMcpServerConfig({ command: "x", env: [] })).toContain("env");
  });

  it("组合：一个字段坏、另一个字段合法 → 仍然拒绝（不被合法字段短路）", () => {
    expect(
      validateMcpServerConfig({ url: "https://x", headers: "a", auth: { CLIENT_ID: "id" } }),
    ).toContain("headers");
    expect(validateMcpServerConfig({ command: "x", args: "a", env: { A: "1" } })).toContain("args");
  });

  it("刻意放行的边界：auth.CLIENT_ID 空串、type 空串（只拦类型错，不拦「值没填」）", () => {
    expect(validateMcpServerConfig({ url: "https://x", auth: { CLIENT_ID: "" } })).toBeNull();
    expect(validateMcpServerConfig({ type: "", command: "x" })).toBeNull();
  });

  it("原因文案不带 command 的原值（读取层会把它写进日志）", () => {
    const secret = "LEAKME_cmd";
    for (const cfg of [{ command: 424242 }, { command: [secret] }, { command: { token: secret } }]) {
      const reason = validateMcpServerConfig(cfg) ?? "";
      expect(reason, `应该拒绝：${JSON.stringify(cfg)}`).not.toBe("");
      expect(reason).not.toContain("424242");
      expect(reason).not.toContain(secret);
    }
  });
});

describe("飞书集成卡片：失败分支的 return / finally（源码契约）", () => {
  const src = read("src/components/settings/feishu-cli-card.tsx");
  const slice = (from: string, to: string): string => {
    const a = src.indexOf(from);
    const b = src.indexOf(to, a + from.length);
    expect(a, `找不到 ${from}`).toBeGreaterThan(-1);
    expect(b, `找不到 ${to}`).toBeGreaterThan(a);
    return src.slice(a, b);
  };

  it("安装：失败分支里没有提前 return，失败后也会走到 void refresh()", () => {
    const install = slice("const handleInstall", "const handleLogin");
    const failed = install.indexOf("!r.ok");
    const already = install.indexOf("r.data.started === false");
    expect(failed).toBeGreaterThan(-1);
    expect(already).toBeGreaterThan(failed);
    expect(install.slice(failed, already)).not.toMatch(/\breturn\b/);
  });

  it("安装：finally 里复位 busy（否则失败 / 抛错后按钮一直是忙）", () => {
    const install = slice("const handleInstall", "const handleLogin");
    expect(install).toMatch(/finally\s*\{\s*setBusy\(false\);\s*\}/);
  });

  it("登录 / 卸载：弹完失败 toast 立刻 return，不再接着弹成功提示", () => {
    const login = slice("const handleLogin", "const handleUninstall");
    expect(login).toMatch(/toast\.error\(`登录发起失败：\$\{r\.message\}`\);\s*return;/);
    const uninstall = slice("const handleUninstall", "const handlePickSpace");
    expect(uninstall).toMatch(/toast\.error\(`卸载失败：\$\{r\.message\}`\);\s*return;/);
  });
});
