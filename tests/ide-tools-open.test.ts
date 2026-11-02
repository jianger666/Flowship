/**
 * ide-tools.openInIde：路径校验 / argv 形态 / Windows cmd.exe 元字符拒绝（P1：open-in-ide 缺绝对路径校验）。
 *
 * - 纯函数：`ideOpenPathRejectReason`（绝对路径 + 拒 `-` 开头）、`cmdScriptPathRejectReason`（cmd 元字符）、
 *   `buildIdeOpenArgs`（VS Code 系带 `--` 终止符；JetBrains / xed 不带——不确定支持，靠绝对路径兜底）。
 * - 行为：mock 掉 `node:child_process.spawn`，在 mac 上用「假 win32 + 临时 LOCALAPPDATA 里放一个假 IDE」
 *   模拟 Windows 探测（没有 Windows 真机，保守处理）：断言非法路径从未 spawn、合法路径的 argv 精确。
 */
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());
const execFileMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: spawnMock, execFile: execFileMock };
});

import {
  buildIdeOpenArgs,
  cmdScriptPathRejectReason,
  ideOpenPathRejectReason,
} from "@/lib/server/ide-tools";

/** 假子进程：spawn 返回后下一拍就「零码退出」，openInIde 不必等 1.5s 定时器 */
const makeChild = () => {
  const child = new EventEmitter() as EventEmitter & { unref: () => void };
  child.unref = () => {};
  setImmediate(() => child.emit("exit", 0));
  return child;
};

describe("ideOpenPathRejectReason：绝对路径 + 拒 - 开头", () => {
  it.each([
    "--install-extension=/tmp/x.vsix",
    "-n",
    "--line",
    "-/abs/looking",
  ])("拒绝 - 开头：%s", (p) => {
    expect(ideOpenPathRejectReason(p)).toMatch(/不能以 -/);
  });

  it.each(["a.ts", "./a.ts", "../a.ts", "proj/a.ts", "~/a.ts", "C:relative", ""])(
    "拒绝非绝对路径：%j",
    (p) => {
      expect(ideOpenPathRejectReason(p)).toBe("path 必须是绝对路径");
    },
  );

  it.each(["/Users/me/proj/A.java", "/", "C:\\Users\\me\\a.ts", "D:/proj/a.ts", "/tmp/my proj/a&b.ts"])(
    "放行绝对路径：%s",
    (p) => {
      expect(ideOpenPathRejectReason(p)).toBeNull();
    },
  );
});

describe("cmdScriptPathRejectReason：cmd.exe 元字符", () => {
  it.each([
    ["&", "C:\\a&calc\\x.java"],
    ["|", "C:\\a|b\\x.java"],
    ["^", "C:\\a^b\\x.java"],
    ["%", "C:\\%USERPROFILE%\\x.java"],
    ["<", "C:\\a<b\\x.java"],
    [">", "C:\\a>b\\x.java"],
    ['"', 'C:\\a"b\\x.java'],
    // 延迟变量展开（`cmd /v:on` 或注册表 DelayedExpansion=1）下 `!VAR!` 会被展开；保守起见含 `!` 一律拒
    ["!", "C:\\a!b\\x.java"],
    ["!VAR!（延迟展开）", "C:\\!USERPROFILE!\\x.java"],
    ["换行", "C:\\a\nb\\x.java"],
    ["回车", "C:\\a\rb\\x.java"],
  ])("含 %s → 拒绝并说明原因", (_name, p) => {
    expect(cmdScriptPathRejectReason(p)).toMatch(/cmd\.exe/);
  });

  it.each([
    "C:\\Program Files (x86)\\proj\\a.java",
    "C:\\Users\\me\\my proj\\a.java",
    "C:\\Users\\me\\it's\\a.java",
    "C:/Users/me/中文目录/a.java",
    "/Users/me/proj/a.java",
  ])("放行常见合法路径（含空格 / 括号 / 单引号 / 中文）：%s", (p) => {
    expect(cmdScriptPathRejectReason(p)).toBeNull();
  });
});

describe("buildIdeOpenArgs：各 IDE 的 argv 形态", () => {
  it.each(["cursor", "vscode", "windsurf", "trae"] as const)("%s（VS Code 系）：路径前带 -- 终止符", (ide) => {
    expect(buildIdeOpenArgs(ide, "/p/a.ts", 12)).toEqual(["-g", "--", "/p/a.ts:12"]);
    expect(buildIdeOpenArgs(ide, "/p")).toEqual(["-n", "--", "/p"]);
  });

  it.each(["idea", "webstorm", "pycharm", "goland", "phpstorm", "android-studio"] as const)(
    "%s（JetBrains）：不加 --（不确定启动器支持，靠绝对路径校验兜底）",
    (ide) => {
      expect(buildIdeOpenArgs(ide, "/p/a.ts", 12)).toEqual(["--line", "12", "/p/a.ts"]);
      expect(buildIdeOpenArgs(ide, "/p")).toEqual(["/p"]);
    },
  );

  it("xcode（xed）：不加 --", () => {
    expect(buildIdeOpenArgs("xcode", "/p/a.swift", 3)).toEqual(["--line", "3", "/p/a.swift"]);
    expect(buildIdeOpenArgs("xcode", "/p")).toEqual(["/p"]);
  });
});

describe("openInIde 行为（mock spawn；Windows 用假 platform + 临时目录模拟）", () => {
  let root: string;
  const saved = {
    platform: Object.getOwnPropertyDescriptor(process, "platform")!,
    LOCALAPPDATA: process.env.LOCALAPPDATA,
    ProgramFiles: process.env.ProgramFiles,
  };

  const touch = (...segs: string[]): string => {
    const p = path.join(root, ...segs);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, "", "utf-8");
    return p;
  };

  /** 每个用例新加载 ide-tools：它有 60s 探测缓存、且探测依赖当时的 env / platform */
  const loadFresh = async () => {
    vi.resetModules();
    return await import("@/lib/server/ide-tools");
  };

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "flowship-ide-tools-"));
    process.env.LOCALAPPDATA = path.join(root, "local");
    process.env.ProgramFiles = path.join(root, "pf");
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    spawnMock.mockReset();
    execFileMock.mockReset();
    spawnMock.mockImplementation(() => makeChild());
    // detectAll 会对**全部** IDE 并发探测：没装的走注册表 / where 兜底（promisify(execFile)）。
    // 假实现一律回调「找不到」，别让 Promise 悬着
    execFileMock.mockImplementation((...a: unknown[]) => {
      (a[a.length - 1] as (err: Error) => void)(new Error("not found"));
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", saved.platform);
    if (saved.LOCALAPPDATA === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = saved.LOCALAPPDATA;
    if (saved.ProgramFiles === undefined) delete process.env.ProgramFiles;
    else process.env.ProgramFiles = saved.ProgramFiles;
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  it("`--install-extension=…` / 相对路径：返回原因、不探测不 spawn（openInIde 自己也校验）", async () => {
    const { openInIde } = await loadFresh();
    for (const p of ["--install-extension=/tmp/x.vsix", "-n", "rel/a.ts", ""]) {
      const reason = await openInIde("cursor", p, 3);
      expect(typeof reason, p).toBe("string");
    }
    expect(spawnMock).not.toHaveBeenCalled();
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("Toolbox .cmd 脚本（cmd.exe /c）：路径含 & | ^ % 等 → 拒绝、从未 spawn", async () => {
    touch("local", "JetBrains", "Toolbox", "scripts", "idea.cmd");
    const { openInIde } = await loadFresh();
    for (const p of [
      "C:\\proj\\a&calc.exe\\x.java",
      "C:\\proj\\a|b\\x.java",
      "C:\\proj\\a^b\\x.java",
      "C:\\%USERPROFILE%\\x.java",
      "C:\\proj\\a>out\\x.java",
    ]) {
      const reason = await openInIde("idea", p, 3);
      expect(reason, p).toMatch(/cmd\.exe/);
    }
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("Toolbox .cmd 脚本：合法路径（含空格 / 括号）照常经 cmd.exe /c 拉起，JetBrains 不带 --", async () => {
    const script = touch("local", "JetBrains", "Toolbox", "scripts", "idea.cmd");
    const { openInIde } = await loadFresh();
    const p = "C:\\Program Files (x86)\\my proj\\A.java";
    expect(await openInIde("idea", p, 7)).toBeNull();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [cmd, args] = spawnMock.mock.calls[0]!;
    expect(cmd).toBe("cmd.exe");
    expect(args).toEqual(["/d", "/s", "/c", script, "--line", "7", p]);
  });

  it("直接 spawn 的 exe（不经 cmd.exe）：路径里的 & 是合法目录字符，不拦；VS Code 系带 --", async () => {
    const exe = touch("local", "Programs", "cursor", "Cursor.exe");
    const { openInIde } = await loadFresh();
    const p = "C:\\work\\a&b\\src\\main.ts";
    expect(await openInIde("cursor", p, 12)).toBeNull();
    expect(await openInIde("cursor", "C:\\work\\a&b")).toBeNull();
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(spawnMock.mock.calls[0]![0]).toBe(exe);
    expect(spawnMock.mock.calls[0]![1]).toEqual(["-g", "--", `${p}:12`]);
    expect(spawnMock.mock.calls[1]![1]).toEqual(["-n", "--", "C:\\work\\a&b"]);
  });
});
