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

  it("自更新装完强制重建桌面 / 开始菜单快捷方式（文件没落地时不乱指）", () => {
    const body = macroBody("customInstall");
    expect(body).toContain("${if} ${isUpdated}");
    expect(body).toContain('CreateShortCut "$newDesktopLink" "$appExe"');
    expect(body).toContain('CreateShortCut "$newStartMenuLink" "$appExe"');
    // v1.9.13：$appExe 不存在时跳过重建（半截安装不把快捷方式指向空路径）
    expect(body).toContain('${if} ${FileExists} "$appExe"');
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

describe("Windows 不再传 /D=（注册表路径为准，引号 bug 类别消失）", () => {
  it("主进程不设 installDirectory、不决议 /D=，凭新安装器标记才敢静默", () => {
    expect(main).toContain('from "./win-update-guard.mjs"');
    expect(main).toContain("hasSilentUpdateMarker");
    expect(main).not.toContain("installDirectory =");
    expect(main).not.toContain("resolveWinInstallDirForUpdater");
  });

  it("无标记（旧版本装的）拒绝静默、走手动过渡，拒绝时不置 quitting", () => {
    expect(main).toContain("需要手动更新一次");
    const gate = main.indexOf("hasSilentUpdateMarker(exeDir");
    const quitting = main.indexOf("quitting = true", gate);
    const install = main.indexOf("quitAndInstall(true, true)", gate);
    expect(gate).toBeGreaterThanOrEqual(0);
    expect(quitting).toBeGreaterThan(gate);
    expect(install).toBeGreaterThan(quitting);
  });

  it("quitAndInstall 前写墓碑、启动时核销（无声消失变可见失败）", () => {
    expect(main).toContain("WIN_UPDATE_ATTEMPT_FILE");
    expect(main).toContain("buildWinUpdateAttempt");
    expect(main).toContain("classifyWinUpdateAttempt");
    expect(main).toContain("上次更新没有装上");
  });

  it("customInstall 落新安装器标记（静默门禁的另一半）", () => {
    const body = macroBody("customInstall");
    expect(body).toContain(".silent-update-ok");
    expect(body).toContain("FileWrite");
    // 标记必须在 $appExe 存在分支里：半截安装（exe 没落地）不落标记，
    // 否则下次门禁被半截目录骗过、直接静默往坏目录里装
    const exeGuard = body.indexOf('${if} ${FileExists} "$appExe"');
    const skipElse = body.indexOf('DetailPrint "skip shortcut rewrite');
    const marker = body.indexOf("FileWrite $0");
    expect(exeGuard).toBeGreaterThanOrEqual(0);
    expect(marker).toBeGreaterThan(exeGuard);
    expect(marker).toBeLessThan(skipElse);
  });
});

describe("Windows 更新路径安装器不杀进程（误杀安装器 = 人没了）", () => {
  it.each(["customInit", "customUnInit"])(
    "%s：更新路径无 taskkill（主进程按 PID 自清），手动才带 /T",
    (name) => {
      const body = macroBody(name);
      const updated = body.indexOf("${if} ${isUpdated}");
      const elseIdx = body.indexOf("${else}", updated);
      expect(updated).toBeGreaterThanOrEqual(0);
      expect(elseIdx).toBeGreaterThan(updated);
      // 更新分支：绝不执行 taskkill（注释里提一句 rationale 不算）
      expect(body.slice(updated, elseIdx)).not.toContain("nsExec::Exec 'taskkill");
      // 手动分支：保留 /T 清隐形孤儿 server（安装器非 Flowship 子进程，安全）
      expect(body.slice(elseIdx)).toContain('taskkill /F /T /IM "Flowship.exe"');
    },
  );
});

describe("Windows 静默更新 Temp 兜底（v1.9.13、D 盘用户更新完人没了）", () => {
  it("主进程拒绝往 Temp/old-install 里装：先验目录、拒绝时不置 quitting", () => {
    expect(main).toContain("isUnsafeWinInstallDir");
    expect(main).toContain("拒绝静默更新");
    // 拒绝路径走手动下载，不进 quitAndInstall；放行后才 quitting=true
    const guard = main.indexOf("isUnsafeWinInstallDir(exeDir)");
    const quitting = main.indexOf("quitting = true", guard);
    const install = main.indexOf("quitAndInstall(true, true)", guard);
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(quitting).toBeGreaterThan(guard);
    expect(install).toBeGreaterThan(quitting);
  });

  it("静默安装前发系统通知打预防针（黑屏几分钟别杀进程）", () => {
    expect(main).toContain("正在安装更新");
  });
});
