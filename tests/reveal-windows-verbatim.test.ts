/**
 * Windows「在文件管理器中显示」点了没定位到文件：explorer 的 `/select,"…"` 必须原样进命令行。
 *
 * 现象（同事反馈）：AI 回的本地 html 路径，左键能在浏览器打开，右键「在文件管理器中显示」却没选中文件
 * （打开的是默认文件夹）。路径本身没问题（同一个 absolute 左键走 rundll32 是通的），差别在 spawn 的参数：
 * Node 在 Windows 上会把含双引号的 argv 重新加引号，`/select,"C:\a\b.html"` 变成 `"/select,\"C:\a\b.html\""`，
 * explorer 不认这种转义。修法：spawn 带 `windowsVerbatimArguments: true`，命令行原样是 `explorer.exe /select,"C:\a\b.html"`。
 *
 * 局限：这里只能钉「我们把什么交给了 spawn」；Node 在真 Windows 上的重新加引号、explorer 的真实解析行为
 * 没法在 mac / linux 上复现，修复是否在真机上生效需要 Windows 上手点一次。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() =>
  vi.fn((..._args: unknown[]) => ({ // eslint-disable-line @typescript-eslint/no-unused-vars
    on(ev: string, cb: (code: number) => void) {
      if (ev === "exit") setTimeout(() => cb(0), 0);
      return this;
    },
    unref() {},
  })),
);
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: spawnMock };
});

const platformRef = vi.hoisted(() => ({ value: "win32" as NodeJS.Platform }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const platform = () => platformRef.value;
  return { ...actual, platform, default: { ...actual, platform } };
});

import { POST as openPath } from "@/app/api/system/open-path/route";
import { POST as reveal } from "@/app/api/system/reveal-in-folder/route";
import { buildOpenPathPlan, buildRevealInFolderSpec } from "@/lib/local-file-os";

const post = (url: string, body: unknown) =>
  new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const REPORTED =
  "C:/Users/wukong123/AppData/Roaming/fe-ai-flow/data/tasks/t_1793772719725_kfywaw/workspace/quick-pass-code-source-analysis.html";
const REPORTED_WIN =
  "C:\\Users\\wukong123\\AppData\\Roaming\\fe-ai-flow\\data\\tasks\\t_1793772719725_kfywaw\\workspace\\quick-pass-code-source-analysis.html";

const spawnCall = () => {
  const call = spawnMock.mock.calls[0] as
    | [string, string[], { windowsVerbatimArguments?: boolean; env?: NodeJS.ProcessEnv }]
    | undefined;
  return call;
};

beforeEach(() => {
  spawnMock.mockClear();
  platformRef.value = "win32";
});

describe("纯函数：buildRevealInFolderSpec 只在 Windows 带 verbatim", () => {
  it("win32：explorer + 单个 /select,\"…\" 参数 + windowsVerbatimArguments", () => {
    expect(buildRevealInFolderSpec(REPORTED, "win32")).toEqual({
      command: "explorer.exe",
      args: [`/select,"${REPORTED_WIN}"`],
      ignoreNonZeroExit: true,
      windowsVerbatimArguments: true,
    });
  });

  it("darwin / linux 不带这个选项（没有这个问题，也不该多出选项）", () => {
    expect(buildRevealInFolderSpec("/tmp/a b.html", "darwin")).not.toHaveProperty("windowsVerbatimArguments");
    expect(buildRevealInFolderSpec("/tmp/a b.html", "linux")).not.toHaveProperty("windowsVerbatimArguments");
  });

  it("危险扩展名降级成 reveal 时用的也是同一份（带 verbatim）；普通打开（rundll32）不带", () => {
    const danger = buildOpenPathPlan("C:\\x\\run.bat", "win32");
    expect(danger.kind).toBe("reveal");
    if (danger.kind === "reveal") expect(danger.spec.windowsVerbatimArguments).toBe(true);
    const normal = buildOpenPathPlan("C:\\x\\a.html", "win32");
    expect(normal.kind).toBe("open");
    if (normal.kind === "open") expect(normal.spec).not.toHaveProperty("windowsVerbatimArguments");
  });
});

describe("reveal-in-folder 路由：把 verbatim 交给 spawn", () => {
  it("同事反馈的那条路径（正斜杠形态）：反斜杠化、引号原样、verbatim 为真", async () => {
    const res = await reveal(post("http://127.0.0.1/x", { path: REPORTED }));
    expect(res.status).toBe(200);
    const [command, args, opts] = spawnCall()!;
    expect(command).toBe("explorer.exe");
    expect(args).toEqual([`/select,"${REPORTED_WIN}"`]);
    expect(opts.windowsVerbatimArguments).toBe(true);
    // 既有约束不丢：env 仍是剔过宿主变量的那份
    expect(opts.env).toBeDefined();
  });

  it("反斜杠形态、含空格的路径同样 verbatim", async () => {
    const res = await reveal(post("http://127.0.0.1/x", { path: "D:\\My Files\\报告 v2.html" }));
    expect(res.status).toBe(200);
    const [, args, opts] = spawnCall()!;
    expect(args).toEqual(['/select,"D:\\My Files\\报告 v2.html"']);
    expect(opts.windowsVerbatimArguments).toBe(true);
  });

  it("macOS：open -R，spawn 选项里没有 windowsVerbatimArguments", async () => {
    platformRef.value = "darwin";
    const res = await reveal(post("http://127.0.0.1/x", { path: "/tmp/a.html" }));
    expect(res.status).toBe(200);
    const [command, args, opts] = spawnCall()!;
    expect(command).toBe("open");
    expect(args).toEqual(["-R", "/tmp/a.html"]);
    expect(opts).not.toHaveProperty("windowsVerbatimArguments");
  });

  it("含双引号的路径仍然 400、不 spawn（verbatim 下引号会直接破坏命令行，这道拦截不能丢）", async () => {
    const res = await reveal(post("http://127.0.0.1/x", { path: 'C:\\a"b\\c.html' }));
    expect(res.status).toBe(400);
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

describe("open-path 路由", () => {
  it("危险文件降级为「在文件管理器中显示」：同样 verbatim", async () => {
    const res = await openPath(post("http://127.0.0.1/x", { path: "C:\\Users\\me\\Downloads\\run.bat" }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { revealed?: boolean }).revealed).toBe(true);
    const [command, args, opts] = spawnCall()!;
    expect(command).toBe("explorer.exe");
    expect(args).toEqual(['/select,"C:\\Users\\me\\Downloads\\run.bat"']);
    expect(opts.windowsVerbatimArguments).toBe(true);
  });

  it("普通打开（左键在浏览器打开 html 走的就是这条）：rundll32，不带 verbatim，行为不变", async () => {
    const res = await openPath(post("http://127.0.0.1/x", { path: REPORTED }));
    expect(res.status).toBe(200);
    const [command, args, opts] = spawnCall()!;
    expect(command).toBe("rundll32.exe");
    expect(args).toEqual(["url.dll,FileProtocolHandler", REPORTED_WIN]);
    expect(opts).not.toHaveProperty("windowsVerbatimArguments");
  });
});
