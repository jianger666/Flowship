/** Windows NSIS 自动更新的进程清理 + 快捷方式 + 自定义目录契约。 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const read = (relativePath: string): string =>
  readFileSync(path.resolve(import.meta.dirname, "..", relativePath), "utf8");

const installer = read("packaging/installer.nsh");
const main = read("electron-app/main.js");

const macroBody = (name: string): string => {
  const match = installer.match(
    new RegExp(`!macro ${name}\\n([\\s\\S]*?)\\n!macroend`),
  );
  expect(match, `${name} 应存在`).not.toBeNull();
  return match?.[1] ?? "";
};

describe("Windows 自动更新安装器不会被 Flowship 自己杀掉", () => {
  it.each(["customInit", "customUnInit"])(
    "%s：更新路径 taskkill 不带 /T，手动安装才带 /T",
    (name) => {
      const body = macroBody(name);
      const updated = body.indexOf("${if} ${isUpdated}");
      const noTree = body.indexOf('taskkill /F /IM "Flowship.exe"');
      const withTree = body.indexOf('taskkill /F /T /IM "Flowship.exe"');

      expect(updated).toBeGreaterThanOrEqual(0);
      expect(noTree).toBeGreaterThan(updated);
      expect(withTree).toBeGreaterThan(noTree);
      expect(body).toContain("${else}");
    },
  );

  it("自更新装完强制重建桌面 / 开始菜单快捷方式", () => {
    const body = macroBody("customInstall");
    expect(body).toContain("${if} ${isUpdated}");
    expect(body).toContain('CreateShortCut "$newDesktopLink" "$appExe"');
    expect(body).toContain('CreateShortCut "$newStartMenuLink" "$appExe"');
  });

  it("仍以静默安装并强制拉起新版本，退出时按 server PID 精确清理；退出不再自动装", () => {
    expect(main).toContain("winAutoUpdater.quitAndInstall(true, true)");
    expect(main).toContain("winAutoUpdater.autoInstallOnAppQuit = false");
    expect(main).toContain(
      'execFileSync("taskkill", ["/PID", String(serverProc.pid), "/T", "/F"]',
    );
    expect(main).not.toContain("promptWinInstall");
  });
});

describe("Windows 自定义安装目录（E 盘含空格）静默更新不删完装不上", () => {
  it("主进程经 resolveWinInstallDirForUpdater 决议 /D=（短路径优先），并打日志", () => {
    expect(main).toContain('from "./win-install-dir.mjs"');
    expect(main).toContain("resolveWinInstallDirForUpdater");
    expect(main).toContain("winAutoUpdater.installDirectory = resolved.dir");
    expect(main).toContain("win 安装目录");
  });

  it("customInit 先剥 $INSTDIR 首尾引号与尾部分隔符，再 taskkill", () => {
    const body = macroBody("customInit");
    // 去引号逻辑必须在 taskkill 之前（$INSTDIR 非法时后者 PowerShell 路径检查也会挂）
    const dequote = body.indexOf("StrCpy $0 $INSTDIR 1");
    const kill = body.indexOf('taskkill /F /IM "Flowship.exe"');
    expect(dequote).toBeGreaterThanOrEqual(0);
    expect(kill).toBeGreaterThan(dequote);
    expect(body).toContain("StrCpy $INSTDIR $INSTDIR");
    expect(body).toContain("$INSTDIR");
  });
});
