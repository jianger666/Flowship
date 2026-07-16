/**
 * shell-boost：守卫探测 / 顶插文本 / 目标清单 / Agent shell 类型 /
 * PowerShell Profile 探测注入（临时目录 mock home）
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  PS_SHELL_BOOST_MARKER,
  SHELL_BOOST_MARKER,
  buildShellBoostBlock,
  detectAgentShellKind,
  formatBackupDate,
  hasShellBoost,
  injectShellBoostContent,
  injectShellBoostFile,
  listShellBoostTargets,
  probeShellBoostFile,
} from "@/lib/server/shell-boost";

describe("hasShellBoost / injectShellBoostContent (posix)", () => {
  it("空内容 / 普通 rc → 未含守卫", () => {
    expect(hasShellBoost("")).toBe(false);
    expect(hasShellBoost("export PATH=/usr/local/bin:$PATH\n")).toBe(false);
  });

  it("含 COMPOSER_NO_INTERACTION → 已含守卫", () => {
    expect(hasShellBoost(buildShellBoostBlock())).toBe(true);
    expect(
      hasShellBoost('[[ "$COMPOSER_NO_INTERACTION" == "1" ]] && return\n'),
    ).toBe(true);
  });

  it("顶插：守卫块在最前，且幂等", () => {
    const original = "# my rc\nexport FOO=1\n";
    const once = injectShellBoostContent(original);
    expect(once.startsWith(buildShellBoostBlock())).toBe(true);
    expect(once).toContain(SHELL_BOOST_MARKER);
    expect(once.endsWith(original)).toBe(true);
    // 再注入一次内容不变
    expect(injectShellBoostContent(once)).toBe(once);
  });
});

describe("hasShellBoost / injectShellBoostContent (powershell)", () => {
  it("普通 Profile → 未含守卫；含 CURSOR_AGENT → 已含", () => {
    expect(hasShellBoost("Import-Module posh-git\n", "powershell")).toBe(
      false,
    );
    expect(hasShellBoost(buildShellBoostBlock("powershell"), "powershell")).toBe(
      true,
    );
    expect(
      hasShellBoost('if ($env:CURSOR_AGENT -eq "1") { return }\n', "powershell"),
    ).toBe(true);
  });

  it("方言互不误判：posix 特征不算 powershell 已优化", () => {
    expect(hasShellBoost(buildShellBoostBlock("posix"), "powershell")).toBe(
      false,
    );
    expect(hasShellBoost(buildShellBoostBlock("powershell"), "posix")).toBe(
      false,
    );
  });

  it("顶插：PowerShell 守卫在最前，且幂等", () => {
    const original = "# oh-my-posh\nImport-Module PSReadLine\n";
    const once = injectShellBoostContent(original, "powershell");
    expect(once.startsWith(buildShellBoostBlock("powershell"))).toBe(true);
    expect(once).toContain(PS_SHELL_BOOST_MARKER);
    expect(once.endsWith(original)).toBe(true);
    expect(injectShellBoostContent(once, "powershell")).toBe(once);
  });
});

describe("listShellBoostTargets", () => {
  it("darwin/linux 列 .zshrc + .bashrc + .bash_profile", () => {
    const home = "/Users/demo";
    expect(listShellBoostTargets("darwin", home).map((t) => t.path)).toEqual([
      "~/.zshrc",
      "~/.bashrc",
      "~/.bash_profile",
    ]);
    expect(listShellBoostTargets("linux", home).map((t) => t.path)).toEqual([
      "~/.zshrc",
      "~/.bashrc",
      "~/.bash_profile",
    ]);
    expect(
      listShellBoostTargets("darwin", home).every((t) => t.kind === "posix"),
    ).toBe(true);
  });

  it("win32 列 Git Bash rc + 四条 PowerShell Profile（含 OneDrive）", () => {
    const home = "C:\\Users\\demo";
    const targets = listShellBoostTargets("win32", home);
    expect(targets.map((t) => t.path)).toEqual([
      "~/.bashrc",
      "~/.bash_profile",
      "~/Documents/PowerShell/Microsoft.PowerShell_profile.ps1",
      "~/Documents/WindowsPowerShell/Microsoft.PowerShell_profile.ps1",
      "~/OneDrive/Documents/PowerShell/Microsoft.PowerShell_profile.ps1",
      "~/OneDrive/Documents/WindowsPowerShell/Microsoft.PowerShell_profile.ps1",
    ]);
    expect(targets.filter((t) => t.kind === "posix")).toHaveLength(2);
    expect(targets.filter((t) => t.kind === "powershell")).toHaveLength(4);
    // absPath 落在 mock home 下
    expect(
      targets.every((t) => t.absPath.startsWith(home) || t.absPath.includes("demo")),
    ).toBe(true);
  });
});

describe("detectAgentShellKind", () => {
  it("win32：无 Git Bash 迹象 → PowerShell", () => {
    expect(detectAgentShellKind("win32", {})).toBe("PowerShell");
    expect(detectAgentShellKind("win32", { SHELL: "C:\\Windows\\System32\\cmd.exe" })).toBe(
      "PowerShell",
    );
  });

  it("win32：MSYSTEM 或 Git Bash SHELL → Git Bash", () => {
    expect(detectAgentShellKind("win32", { MSYSTEM: "MINGW64" })).toBe(
      "Git Bash",
    );
    expect(
      detectAgentShellKind("win32", {
        SHELL: "C:\\Program Files\\Git\\bin\\bash.exe",
      }),
    ).toBe("Git Bash");
  });

  it("darwin/linux：按 SHELL 识别，darwin 缺省 zsh", () => {
    expect(detectAgentShellKind("darwin", { SHELL: "/bin/zsh" })).toBe("zsh");
    expect(detectAgentShellKind("linux", { SHELL: "/bin/bash" })).toBe("bash");
    expect(detectAgentShellKind("darwin", {})).toBe("zsh");
    expect(detectAgentShellKind("linux", {})).toBe("bash");
  });
});

describe("formatBackupDate", () => {
  it("格式化为 YYYYMMDD（用本地 Date 构造，避免 UTC 串跨日）", () => {
    // month 0-indexed：6 = July
    expect(formatBackupDate(new Date(2026, 6, 15))).toBe("20260715");
  });
});

describe("PowerShell profile 探测 / 注入（临时目录）", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })),
    );
  });

  const makeTempHome = async (): Promise<string> => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fe-shell-boost-"));
    dirs.push(dir);
    return dir;
  };

  it("文件不存在 → probe exists=false；inject → missing（不创建）", async () => {
    const home = await makeTempHome();
    const abs = path.join(
      home,
      "Documents",
      "PowerShell",
      "Microsoft.PowerShell_profile.ps1",
    );
    const display = "~/Documents/PowerShell/Microsoft.PowerShell_profile.ps1";
    const probed = await probeShellBoostFile(abs, display, "powershell");
    expect(probed).toEqual({ path: display, exists: false, boosted: false });
    const injected = await injectShellBoostFile(abs, display, "powershell");
    expect(injected.action).toBe("missing");
    await expect(fs.access(abs)).rejects.toThrow();
  });

  it("存在未优化 → inject 顶插 + 备份；再 inject → already（幂等）", async () => {
    const home = await makeTempHome();
    const abs = path.join(
      home,
      "Documents",
      "PowerShell",
      "Microsoft.PowerShell_profile.ps1",
    );
    await fs.mkdir(path.dirname(abs), { recursive: true });
    const original = "Import-Module posh-git\n";
    await fs.writeFile(abs, original, "utf-8");
    const display = "~/Documents/PowerShell/Microsoft.PowerShell_profile.ps1";
    const now = new Date(2026, 6, 16);

    const before = await probeShellBoostFile(abs, display, "powershell");
    expect(before).toEqual({ path: display, exists: true, boosted: false });

    const first = await injectShellBoostFile(abs, display, "powershell", now);
    expect(first.action).toBe("injected");
    const afterContent = await fs.readFile(abs, "utf-8");
    expect(afterContent.startsWith(buildShellBoostBlock("powershell"))).toBe(
      true,
    );
    expect(afterContent.endsWith(original)).toBe(true);
    // 当日备份存在且内容是注入前原文
    const bak = await fs.readFile(`${abs}.bak-20260716`, "utf-8");
    expect(bak).toBe(original);

    const after = await probeShellBoostFile(abs, display, "powershell");
    expect(after.boosted).toBe(true);

    const second = await injectShellBoostFile(abs, display, "powershell", now);
    expect(second.action).toBe("already");
    // 幂等：内容不变
    expect(await fs.readFile(abs, "utf-8")).toBe(afterContent);
  });
});
