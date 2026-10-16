/**
 * feishu-cli 登录时「自动打开授权 URL」的行为（经 startLogin 真实走一遍抓 URL → spawn opener）。
 * 回归点：Windows 上不能再经 `cmd /c start`——飞书授权链接 query 必带 `&`，cmd 会把它当命令分隔符截断。
 * 必须是 `rundll32.exe url.dll,FileProtocolHandler <整条 URL 单个 argv>`。
 */
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type SpawnCall = { command: string; args: string[] };
const spawnCalls: SpawnCall[] = [];
let loginChild: (EventEmitter & { stdout: EventEmitter; stderr: EventEmitter }) | null =
  null;

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: vi.fn((command: string, args: string[]) => {
      spawnCalls.push({ command, args: [...args] });
      const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        unref: () => {},
        kill: () => true,
      });
      // 第一个 spawn 是 lark-cli 登录进程本身；之后的是 opener（不需要事件）
      if (!loginChild) loginChild = child;
      return child;
    }),
  };
});

import { buildOpenUrlSpec } from "@/lib/local-file-os";
import { isTrustedFeishuAuthUrl, startLogin } from "@/lib/server/feishu-cli";

const realPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
const setPlatform = (p: NodeJS.Platform) =>
  Object.defineProperty(process, "platform", { value: p, configurable: true });

const AUTH_URL =
  "https://accounts.feishu.cn/oauth/v1/device/verify?user_code=ABCD-1234&app_id=cli_x&state=a%20b";

/** 触发一次登录并让 CLI「打印」一行 stdout，返回之后 spawn 的 opener 调用 */
const loginAndPrint = async (line: string): Promise<SpawnCall[]> => {
  const res = await startLogin("lark-cli");
  expect(res.ok).toBe(true);
  expect(spawnCalls).toHaveLength(1); // 登录进程本身
  loginChild!.stdout.emit("data", Buffer.from(`${line}\n`));
  return spawnCalls.slice(1);
};

beforeEach(() => {
  spawnCalls.length = 0;
  loginChild = null;
  // 登录状态是 globalThis 上的 Map：上一用例的 running=true 会让 startLogin 直接拒绝
  (globalThis as { __feishuCliLogins?: Map<string, unknown> }).__feishuCliLogins =
    new Map();
});

afterEach(() => {
  Object.defineProperty(process, "platform", realPlatform);
});

describe("feishu-cli 打开授权 URL（win32）", () => {
  it("rundll32.exe + 完整 URL 作为单个 argv 原样传入，不经 cmd / start", async () => {
    setPlatform("win32");
    const opens = await loginAndPrint(`请在浏览器打开：${AUTH_URL}`);

    expect(opens).toHaveLength(1);
    const { command, args } = opens[0]!;
    expect(command).toBe("rundll32.exe");
    expect(args).toHaveLength(2);
    expect(args[0]).toBe("url.dll,FileProtocolHandler");
    // `&` 与整条 query 必须在同一个 argv 里、未被截断 / 拆分
    expect(args[1]).toBe(new URL(AUTH_URL).href);
    expect(args[1]).toContain("&app_id=cli_x&state=");
    // 任何 argv 都不是 cmd / start
    const flat = [command, ...args].join(" ").toLowerCase();
    expect(flat).not.toMatch(/\bcmd(\.exe)?\b/);
    expect(args).not.toContain("start");
    expect(args).not.toContain("/c");
  });

  it("非飞书域的 https URL 只记录、不 spawn opener", async () => {
    setPlatform("win32");
    const opens = await loginAndPrint("go https://evil.example.com/phish?a=1&b=2");
    expect(opens).toHaveLength(0);
  });
});

describe("授权 URL 校验：非 http(s) / 非可信域被拒", () => {
  it("buildOpenUrlSpec 拒绝非 http(s) 协议（win32 同样返回 null、不会走到 rundll32）", () => {
    for (const bad of [
      "file:///C:/Windows/System32/calc.exe",
      "javascript:alert(1)",
      "ms-msdt:/id PCWDiagnostic",
      "not a url",
    ]) {
      expect(buildOpenUrlSpec(bad, "win32")).toBeNull();
    }
  });

  it("buildOpenUrlSpec(win32) 对 http(s) 给出 rundll32 单 argv", () => {
    const spec = buildOpenUrlSpec(AUTH_URL, "win32");
    expect(spec?.command).toBe("rundll32.exe");
    expect(spec?.args).toEqual(["url.dll,FileProtocolHandler", new URL(AUTH_URL).href]);
  });

  it("isTrustedFeishuAuthUrl 拒绝 http / 非飞书域 / 伪造子串域名", () => {
    expect(isTrustedFeishuAuthUrl(AUTH_URL)).toBe(true);
    expect(isTrustedFeishuAuthUrl("http://accounts.feishu.cn/x")).toBe(false);
    expect(isTrustedFeishuAuthUrl("https://feishu.cn.evil.com/x")).toBe(false);
    expect(isTrustedFeishuAuthUrl("file:///etc/passwd")).toBe(false);
  });
});
