/** Windows NSIS 自动更新的进程清理 + 快捷方式 + 自定义目录契约。 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const read = (relativePath: string): string =>
  readFileSync(path.resolve(import.meta.dirname, "..", relativePath), "utf8");

const installer = read("packaging/installer.nsh");
const main = read("electron-app/main.js");

const macroBody = (name: string): string => {
  // 宏名后允许带参数列表（如 `!macro flowshipLog MSG`）
  const match = installer.match(
    new RegExp(`!macro ${name}(?:[ \\t][^\\n]*)?\\n([\\s\\S]*?)\\n!macroend`),
  );
  expect(match, `${name} 应存在`).not.toBeNull();
  return match?.[1] ?? "";
};

/** 去掉整行注释（; 开头）：注释里常提到 Abort / taskkill 做 rationale，不能当指令算 */
const nsisCode = (body: string): string =>
  body
    .split("\n")
    .filter((line) => !/^\s*;/.test(line))
    .join("\n");

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

  it("customInstall 落新安装器标记（静默门禁的另一半）：手动安装 / 自动更新都写、且只在 $appExe 存在时写", () => {
    const body = macroBody("customInstall");
    expect(body).toContain(".silent-update-ok");
    expect(body).toContain("FileWrite");
    const marker = body.indexOf("FileWrite $0");
    const updatedBranch = body.indexOf("${if} ${isUpdated}");
    expect(marker).toBeGreaterThanOrEqual(0);
    expect(updatedBranch).toBeGreaterThanOrEqual(0);
    // v1.9.30 死锁修复：标记必须写在 isUpdated 分支【之外】。
    // 之前只在自动更新分支里写，而大多数 Windows 用户是手动装的、从不走那条路径，
    // 门禁（需要标记）永远拒绝他们，「手动更新一次」装完还是没标记 = 更新永远是手动。
    expect(marker).toBeLessThan(updatedBranch);
    // 标记必须在 $appExe 存在分支里：半截安装（exe 没落地）不落标记，
    // 否则下次门禁被半截目录骗过、直接静默往坏目录里装
    const exeGuard = body.indexOf('${if} ${FileExists} "$appExe"');
    expect(exeGuard).toBeGreaterThanOrEqual(0);
    expect(exeGuard).toBeLessThan(marker);
    // 守卫到标记之间不能夹 isUpdated（否则等于又把标记收回自动更新专属）
    expect(body.slice(exeGuard, marker)).not.toContain("isUpdated");
  });
});

describe("Windows 安装诊断日志 + 静默更新预检（v1.9.30）", () => {
  it("flowshipLog 追加写 %APPDATA%\\fe-ai-flow\\logs\\installer.log（与 main.log 同目录）、写失败静默", () => {
    const body = macroBody("flowshipLog");
    expect(body).toContain('ReadEnvStr $R9 "APPDATA"');
    expect(body).toContain('"$R9\\fe-ai-flow\\logs\\installer.log" a');
    expect(body).toContain("FileSeek $R8 0 END");
    // 目录建不出来 / 文件打不开：只清错误位、不 Abort、不 MessageBox（日志绝不能影响安装本身）
    expect(body).toContain("ClearErrors");
    expect(body).not.toMatch(/\bAbort\b|MessageBox/);
    // 全程保护调用方寄存器（customInit / customInstall 里的 $0-$3 不能被冲掉）
    expect(body.match(/Push \$R[789]/g)).toHaveLength(3);
    expect(body.match(/Pop \$R[789]/g)).toHaveLength(3);
  });

  it("日志内容只含 ASCII：Unicode 安装器的 FileWrite 按系统 ANSI 代码页落盘、中文会乱码", () => {
    const messages = [...installer.matchAll(/!insertmacro flowshipLog "([^"]*)"/g)].map(
      (m) => m[1],
    );
    expect(messages.length).toBeGreaterThanOrEqual(3);
    for (const msg of messages) {
      expect(msg, `日志文案含非 ASCII：${msg}`).toMatch(/^[\x20-\x7e]*$/);
    }
  });

  it("init 行在 customInit、done 行在 customInstall（done 带总耗时 / 标记结果，才能区分「没装完」和「装完了」）", () => {
    const init = macroBody("customInit");
    const install = macroBody("customInstall");
    expect(init).toContain('!insertmacro flowshipLog "init v${VERSION}');
    expect(init).toContain("tempFreeMB=");
    expect(install).toContain('!insertmacro flowshipLog "done v${VERSION}');
    expect(install).toContain("elapsedSec=$3");
    expect(install).toContain("marker=$1");
  });

  it("Var flowshipInitTick 只在安装器 pass 里声明（卸载器 pass 声明了没人用 → -WX 下 warning 变 error、整包打不出来）", () => {
    const decl = installer.indexOf("Var flowshipInitTick");
    expect(decl).toBeGreaterThanOrEqual(0);
    const guard = installer.lastIndexOf("!ifndef BUILD_UNINSTALLER", decl);
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(installer.slice(guard, decl)).not.toContain("!endif");
  });

  it("预检：仅自动更新、量 %TEMP% 所在盘、低于阈值 Abort；量不到（?）放行", () => {
    const body = nsisCode(macroBody("customInit"));
    expect(body).toContain('GetDiskFreeSpaceEx(t "$TEMP"');
    // 未知空间的默认值必须在 GetDiskFreeSpaceEx 之后赋（调用的输出寄存器会覆盖 $2）
    const call = body.indexOf("GetDiskFreeSpaceEx");
    const unknownDefault = body.indexOf('StrCpy $2 "?"');
    expect(unknownDefault).toBeGreaterThan(call);
    // 条件三连：自动更新 + 量到了 + 低于阈值
    const guard = body.indexOf("${if} ${isUpdated}\n  ${andIf} $2 != \"?\"");
    expect(guard, "预检条件应为 isUpdated && 已知 && 低于阈值").toBeGreaterThanOrEqual(0);
    const below = body.indexOf("${andIf} $2 < ${FLOWSHIP_MIN_TEMP_FREE_MB}", guard);
    expect(below).toBeGreaterThan(guard);
    // 恰好一个 Abort、且在上面这个守卫里；手动安装路径不 Abort（人在屏幕前、不靠退出来保护）
    expect(body.match(/\bAbort\b/g)).toHaveLength(1);
    expect(body.indexOf("Abort")).toBeGreaterThan(below);
    expect(body.slice(guard, body.indexOf("Abort"))).toContain('flowshipLog "ABORT v${VERSION}');
  });

  it("预检在任何破坏性操作之前：早于 customInit 里的 taskkill；旧卸载器在安装段才跑（.onInit 的 Abort = 旧版本原样保留）", () => {
    const body = nsisCode(macroBody("customInit"));
    const abort = body.search(/^\s*Abort\s*$/m);
    const kill = body.indexOf("nsExec::Exec 'taskkill");
    expect(abort).toBeGreaterThanOrEqual(0);
    expect(kill).toBeGreaterThan(abort);
    // 安装目录归一化在日志 / 预检之前（日志里记的 instdir 是归一化后的真实目录）
    expect(body.lastIndexOf("StrCpy $INSTDIR $INSTDIR $1 0")).toBeLessThan(
      body.indexOf("!insertmacro flowshipLog"),
    );
  });

  it("阈值覆盖实测峰值：118MB 7z 载荷 + 447MB 解压临时目录 ≈ 565MB 压在 %TEMP% 所在盘", () => {
    const threshold = Number(
      installer.match(/!define FLOWSHIP_MIN_TEMP_FREE_MB (\d+)/)?.[1] ?? Number.NaN,
    );
    expect(threshold).toBeGreaterThanOrEqual(118 + 447);
    // 也别设成吓人的大数（会把空间其实够的人误拦成「永远手动更新」）
    expect(threshold).toBeLessThanOrEqual(2048);
  });

  it("主进程：electron-updater 日志接进 main.log、拉起安装器前记磁盘现场、墓碑弹框指向 installer.log", () => {
    expect(main).toContain("winAutoUpdater.logger = {");
    expect(main).toContain("[electron-updater] ERROR");
    expect(main).toContain("[updater] win quitAndInstall(silent)");
    const logIdx = main.indexOf("[updater] win quitAndInstall(silent)");
    const installIdx = main.indexOf("winAutoUpdater.quitAndInstall(true, true)");
    expect(logIdx).toBeGreaterThanOrEqual(0);
    expect(installIdx).toBeGreaterThan(logIdx);
    const tombstone = main.indexOf("上次更新没有装上");
    expect(tombstone).toBeGreaterThanOrEqual(0);
    expect(main.slice(tombstone, tombstone + 600)).toContain("installer.log");
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
