/**
 * 旧安装自愈（flowshipForceCleanOld）的契约。
 * 背景：有同事的机器上「装 / 更新必报 Flowship 无法关闭」、点重试永远过不去，只能手动跑清理脚本
 * （结束进程 + 删安装目录 + 删卸载注册表项）。安装器自己兜底：
 *   broken —— 覆盖安装前发现「注册表有卸载记录、旧目录里主程序已经没了」→ 清掉，官方旧卸载器整段跳过；
 *   failed —— 旧卸载器退出码非 0 且 App 没在跑 → 强清旧目录、当作移除成功继续装。
 * 说明：NSIS 断言是字符串级契约——能防回退 / 防顺序写反 / 防校验被删，不能证明 Windows 上的运行时行为；
 * 运行时以 installer.log 里的 `heal` 行为准（result=cleaned / partial / healthy / app-running …）。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { findAppBuilderTemplateDir } from "./helpers/app-builder-nsis-template";

const root = path.resolve(import.meta.dirname, "..");
const installer = readFileSync(path.join(root, "packaging/installer.nsh"), "utf8");

const macroBody = (name: string): string => {
  const match = installer.match(
    new RegExp(`!macro ${name}(?:[ \\t][^\\n]*)?\\n([\\s\\S]*?)\\n!macroend`),
  );
  expect(match, `${name} 应存在`).not.toBeNull();
  return match?.[1] ?? "";
};

/** 去掉整行注释后的 NSIS 代码（注释里提到的 RMDir /r 等字样不算）。 */
const nsisCode = (body: string): string =>
  body
    .split("\n")
    .filter((line) => !/^\s*;/.test(line))
    .join("\n");

// 官方模板目录：CI 找不到直接 throw；本地找不到则下面对账用例显式 skip（不再静默 return）
const templateDir = findAppBuilderTemplateDir();

describe("flowshipForceCleanOld：变量与寄存器纪律", () => {
  it("结果变量与其他阶段变量同在 !ifndef BUILD_UNINSTALLER 块内（卸载器 pass 声明了没人用 → -WX 下整包打不出来）", () => {
    const guardStart = installer.indexOf("!ifndef BUILD_UNINSTALLER");
    const guardEnd = installer.indexOf("!endif", guardStart);
    expect(installer.slice(guardStart, guardEnd)).toContain("Var flowshipHealed");
  });

  it("自带 Push/Pop 保护 $0-$4（调用点不需要保护寄存器），结尾 ClearErrors 在日志之前", () => {
    const body = nsisCode(macroBody("flowshipForceCleanOld"));
    expect(body.match(/^\s*Push \$\d$/gm)?.map((s) => s.trim())).toEqual([
      "Push $0",
      "Push $1",
      "Push $2",
      "Push $3",
      "Push $4",
    ]);
    expect(body.trimEnd().endsWith("Pop $4\n  Pop $3\n  Pop $2\n  Pop $1\n  Pop $0")).toBe(true);
    expect(body.lastIndexOf("ClearErrors")).toBeLessThan(body.indexOf("!insertmacro flowshipLog"));
  });

  it("日志只记 ASCII 与盘符（FileWrite 按 ANSI 落盘，路径含中文会乱码）", () => {
    const body = nsisCode(macroBody("flowshipForceCleanOld"));
    const logLine = '!insertmacro flowshipLog "heal v${VERSION} mode=${MODE} result=$2 oldDrive=$1"';
    expect(body).toContain(logLine);
    // $1 先被赋成路径前 2 个字符（盘符）再写日志；整个宏只写这一行日志，里面没有 $0（完整路径）
    expect(body.indexOf("StrCpy $1 $0 2\n")).toBeLessThan(body.indexOf(logLine));
    expect(body.match(/flowshipLog[^\n]*/g)).toEqual([`flowshipLog "heal v\${VERSION} mode=\${MODE} result=$2 oldDrive=$1"`]);
  });
});

describe("flowshipForceCleanOld：安全校验（删之前）", () => {
  const body = nsisCode(macroBody("flowshipForceCleanOld"));
  const rmdir = body.indexOf('RMDir /r "$0"');

  it("整个宏里只有一处递归删除，对象是解析出来的旧安装目录 $0", () => {
    expect(body.match(/RMDir\s+\/r[^\n]*/g)).toEqual(['RMDir /r "$0"']);
    expect(rmdir).toBeGreaterThan(0);
  });

  it("只处理「X:\\…」盘符路径：第 2 个字符是冒号、第 3 个是反斜杠；UNC / 取不到一律不删", () => {
    const drive = body.indexOf('StrCpy $2 "not-drive-path"');
    expect(drive).toBeGreaterThanOrEqual(0);
    expect(drive).toBeLessThan(rmdir);
    expect(body).toContain("StrCpy $1 $0 1 1");
    expect(body).toContain("StrCpy $4 $0 1 2");
    expect(body).toContain('${if} $1 != ":"');
    expect(body).toContain('${orIf} $4 != "\\"');
    expect(body).toContain('StrCpy $2 "no-location"');
  });

  it("目录名必须恰好是 APP_FILENAME（取末尾 N 个字符比对）；不是就不删", () => {
    const suffix = body.indexOf('${if} $1 != "\\${APP_FILENAME}"');
    expect(suffix).toBeGreaterThanOrEqual(0);
    expect(body).toContain('StrLen $4 "\\${APP_FILENAME}"');
    expect(body).toContain("IntOp $4 0 - $4");
    expect(body).toContain('StrCpy $1 $0 "" $4');
    expect(body).toContain('StrCpy $2 "not-app-dir"');
    expect(suffix).toBeLessThan(rmdir);
  });

  it("只有校验全过（$2 仍是 ok）才进清理分支；清理前先把当前目录挪出旧目录", () => {
    const gate = body.lastIndexOf('${if} $2 == "ok"');
    expect(gate).toBeGreaterThan(0);
    expect(gate).toBeLessThan(rmdir);
    const outPath = body.indexOf("SetOutPath $TEMP");
    expect(outPath).toBeGreaterThan(gate);
    expect(outPath).toBeLessThan(rmdir);
  });

  it("主程序确认已经没了才删卸载注册表项并置 flowshipHealed=1；没删干净（exe-still-there）不动注册表", () => {
    const exeCheck = body.indexOf('${if} ${FileExists} "$0\\${APP_EXECUTABLE_FILENAME}"', rmdir);
    const stillThere = body.indexOf('StrCpy $2 "exe-still-there"');
    const delKey = body.indexOf('DeleteRegKey SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}"');
    const healed = body.indexOf('StrCpy $flowshipHealed "1"');
    expect(exeCheck).toBeGreaterThan(rmdir);
    expect(stillThere).toBeGreaterThan(exeCheck);
    // else 分支才删注册表：位置在 exe-still-there 之后
    expect(delKey).toBeGreaterThan(stillThere);
    expect(healed).toBeGreaterThan(delKey);
    // 入口先置 0（任何提前退出分支都不会残留上一次的 1）
    expect(body.indexOf('StrCpy $flowshipHealed "0"')).toBeLessThan(body.indexOf('StrCpy $2 "ok"'));
    expect(body.match(/StrCpy \$flowshipHealed "1"/g)).toHaveLength(1);
  });

  it("目录解析与官方 uninstallOldVersion 同口径：InstallLocation → 没有就取卸载器路径的父目录", () => {
    expect(body).toContain('ReadRegStr $0 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" "InstallLocation"');
    expect(body).toContain('ReadRegStr $3 SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" "UninstallString"');
    expect(body).toMatch(/\$\{if\} \$0 == ""\n\s*\$\{andIf\} \$3 != ""/);
    // 不碰向导里用户新选的 $INSTDIR（要清的是旧目录）
    expect(body).not.toContain("$INSTDIR");
  });
});

describe("flowshipForceCleanOld：两种触发条件", () => {
  const body = nsisCode(macroBody("flowshipForceCleanOld"));

  it("broken：需要有卸载记录；旧目录里主程序还在 = 能用的安装，不碰（healthy）", () => {
    expect(body).toContain('StrCpy $2 "no-uninstall-record"');
    expect(body).toMatch(/\$\{if\} "\$\{MODE\}" == "broken"\n\s*\$\{if\} \$\{FileExists\} "\$0\\\$\{APP_EXECUTABLE_FILENAME\}"\n\s*StrCpy \$2 "healthy"/);
  });

  it("failed：先确认 App 没在跑（tasklist 精确匹配）；0 = 在跑、1 = 没有、其它 = 没法确认，后两种之外都不删", () => {
    expect(body).toContain("nsExec::Exec `\"$SYSDIR\\cmd.exe\" /C tasklist /FI \"IMAGENAME eq ${APP_EXECUTABLE_FILENAME}\" /FO CSV /NH");
    expect(body).toContain('"$SYSDIR\\findstr.exe" /B /I /C:"\\"${APP_EXECUTABLE_FILENAME}\\""');
    expect(body).toMatch(/Pop \$4\n\s*\$\{if\} \$4 == "0"\n\s*StrCpy \$2 "app-running"\n\s*\$\{elseIf\} \$4 != "1"\n\s*StrCpy \$2 "process-check-failed"/);
    // 不用 taskkill：自愈绝不杀进程（更新路径的安装器是 Flowship.exe 的子进程，按名杀会误杀自己）
    expect(body).not.toContain("taskkill");
  });

  it.skipIf(!templateDir)("对账官方 FIND_PROCESS 的 tasklist 分支：我们照搬的命令形态仍在（找不到官方 NSIS 模板时本地 skip）", () => {
    const util = readFileSync(path.join(templateDir!, "include", "allowOnlyOneInstallerInstance.nsh"), "utf8");
    expect(util).toContain("tasklist /FI");
    expect(util).toContain('findstr.exe" /B /I /C:');
  });
});

describe("对账官方模板：自愈依赖的行为还在", () => {
  it.skipIf(!templateDir)("官方 uninstallOldVersion 读不到 UninstallString 就整段跳过（broken 清注册表项后不再调旧卸载器的依据）", () => {
    const util = readFileSync(path.join(templateDir!, "include", "installUtil.nsh"), "utf8");
    const fn = util.slice(util.indexOf("Function uninstallOldVersion"));
    expect(fn).toMatch(/readReg \$uninstallString "\$rootKey" "\$\{UNINSTALL_REGISTRY_KEY\}" UninstallString\n\s*\$\{if\} \$uninstallString == ""/);
    expect(fn).toContain("UNINSTALL_REGISTRY_KEY_2");
    // 目录口径：InstallLocation，没有就取卸载器路径的父目录
    expect(fn).toContain('readReg $installationDir "$rootKey" "${INSTALL_REGISTRY_KEY}" InstallLocation');
    expect(fn).toContain("Call GetFileParent");
  });

  it.skipIf(!templateDir)("官方「5 次重试用尽」弹框之后 Return 回到 handleUninstallResult → 我们的 customUnInstallCheck（failed 的接入点）", () => {
    const util = readFileSync(path.join(templateDir!, "include", "installUtil.nsh"), "utf8");
    expect(util).toMatch(/\$\{if\} \$R5 > 5\n\s*MessageBox MB_RETRYCANCEL\|MB_ICONEXCLAMATION "\$\(appCannotBeClosed\)" \/SD IDCANCEL IDRETRY OneMoreAttempt\n\s*Return/);
    const section = readFileSync(path.join(templateDir!, "installSection.nsh"), "utf8");
    expect(section).toMatch(/!insertmacro uninstallOldVersion SHELL_CONTEXT\n!insertmacro handleUninstallResult SHELL_CONTEXT/);
  });
});

describe("接线：三处调用，位置与模式固定", () => {
  it("全文件只有 3 处调用：customInit(broken) / begin 页(broken) / customUnInstallCheck(failed)", () => {
    const all = nsisCode(installer).match(/!insertmacro flowshipForceCleanOld[^\n]*/g) ?? [];
    // 只锁数量与模式（文件里的先后顺序不是契约）：broken ×2（begin 页 / customInit）、failed ×1（customUnInstallCheck）
    expect([...all].sort()).toEqual([
      '!insertmacro flowshipForceCleanOld "broken"',
      '!insertmacro flowshipForceCleanOld "broken"',
      '!insertmacro flowshipForceCleanOld "failed"',
    ]);
    expect(nsisCode(macroBody("customUnInstallCheck"))).toContain('!insertmacro flowshipForceCleanOld "failed"');
    expect(nsisCode(macroBody("customInit"))).toContain('!insertmacro flowshipForceCleanOld "broken"');
    expect(nsisCode(macroBody("customPageAfterChangeDir"))).toContain('!insertmacro flowshipForceCleanOld "broken"');
  });

  it("customInit：只在静默安装里、紧跟 TEMP 重定向之后，且在所有 Abort 与 taskkill 之后（预检不过要退出时旧安装一个字节不动）", () => {
    const init = nsisCode(macroBody("customInit"));
    const call = init.indexOf('!insertmacro flowshipForceCleanOld "broken"');
    expect(call).toBeGreaterThanOrEqual(0);
    expect(call).toBeGreaterThan(init.indexOf("!insertmacro flowshipTmpRedirect"));
    expect(call).toBeGreaterThan(init.lastIndexOf("Abort"));
    expect(call).toBeGreaterThan(init.indexOf("taskkill"));
    // 同一个 ${if} ${Silent} 块里（两次调用之间没有 endIf）
    const between = init.slice(init.indexOf("!insertmacro flowshipTmpRedirect"), call);
    expect(between).not.toContain("${endIf}");
  });

  it("手动安装：在 begin 页（用户点「安装」那一刻）里，TEMP 重定向之后、出栈之前", () => {
    const page = nsisCode(macroBody("customPageAfterChangeDir"));
    const call = page.indexOf('!insertmacro flowshipForceCleanOld "broken"');
    expect(call).toBeGreaterThanOrEqual(0);
    expect(call).toBeGreaterThan(page.indexOf("!insertmacro flowshipTmpRedirect"));
    expect(call).toBeLessThan(page.indexOf("Pop $2"));
  });

  it("customUnInstallCheck：真实退出码先存进 $2；仅「拉起来了 且 退出码非 0」才自愈；成功才把 $R0 置 0；都在 TEMP 还原之前", () => {
    const body = nsisCode(macroBody("customUnInstallCheck"));
    const saveFlag = body.indexOf('StrCpy $1 "1"');
    const saveCode = body.indexOf("StrCpy $2 $R0");
    const gate = body.indexOf('${if} $1 == "0"\n  ${andIf} $R0 != 0');
    const call = body.indexOf('!insertmacro flowshipForceCleanOld "failed"');
    const healedGate = body.indexOf('${if} $flowshipHealed == "1"');
    const zero = body.indexOf("StrCpy $R0 0");
    const restore = body.indexOf("!insertmacro flowshipTmpRestore $1 $R0");
    const log = body.indexOf('!insertmacro flowshipLog "uninstalled');
    expect(saveFlag).toBeGreaterThanOrEqual(0);
    expect(saveCode).toBeGreaterThan(saveFlag);
    expect(gate).toBeGreaterThan(saveCode);
    expect(call).toBeGreaterThan(gate);
    expect(healedGate).toBeGreaterThan(call);
    expect(zero).toBeGreaterThan(healedGate);
    expect(restore).toBeGreaterThan(zero);
    expect(log).toBeGreaterThan(restore);
    // $R0 只在 flowshipHealed 分支里被改写，且只改这一处
    expect(body.match(/StrCpy \$R0 /g)).toHaveLength(1);
    // 日志记的是存下来的真实退出码（$2），不是被改写后的 $R0
    expect(body).toContain('code=$2"');
    // $2 在存完之后到日志之前不再被覆盖
    const between = body.slice(saveCode + 1, log);
    expect(between).not.toMatch(/StrCpy \$2 /);
  });

  it("自愈没成功（flowshipHealed 保持 0）时，官方原行为原样保留：弹框 + SetErrorLevel 2 + Quit", () => {
    const body = nsisCode(macroBody("customUnInstallCheck"));
    const after = body.slice(body.indexOf("!insertmacro flowshipTmpRestore"));
    expect(after).toContain('MessageBox MB_OK|MB_ICONEXCLAMATION "$(uninstallFailed): $R0"');
    expect(after).toContain("SetErrorLevel 2");
    expect(after).toContain("Quit");
  });
});
