/**
 * 安装阶段计时（begin / uninstalled / phases）+ 首次启动预读接线的契约。
 * 说明：NSIS / main.js 的断言是字符串级契约——能防回退，不能证明 Windows 上的运行时行为。
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");
const read = (rel: string): string => readFileSync(path.join(root, rel), "utf8");

const installer = read("packaging/installer.nsh");
const main = read("electron-app/main.js");

const macroBody = (name: string): string => {
  const match = installer.match(
    new RegExp(`!macro ${name}(?:[ \\t][^\\n]*)?\\n([\\s\\S]*?)\\n!macroend`),
  );
  expect(match, `${name} 应存在`).not.toBeNull();
  return match?.[1] ?? "";
};

const nsisCode = (body: string): string =>
  body
    .split("\n")
    .filter((line) => !/^\s*;/.test(line))
    .join("\n");

describe("安装阶段计时：时间点变量", () => {
  it("三个新变量与 flowshipInitTick 同在 !ifndef BUILD_UNINSTALLER 块内（卸载器 pass 声明了没人用 → -WX 下整包打不出来）", () => {
    const guardStart = installer.indexOf("!ifndef BUILD_UNINSTALLER");
    const guardEnd = installer.indexOf("!endif", guardStart);
    expect(guardStart).toBeGreaterThanOrEqual(0);
    const block = installer.slice(guardStart, guardEnd);
    for (const v of [
      "flowshipInitTick",
      "flowshipBeginTick",
      "flowshipProbeTick",
      "flowshipUninstTick",
      "flowshipPrev",
      "flowshipPrevVer",
    ]) {
      expect(block, `Var ${v}`).toContain(`Var ${v}`);
    }
  });

  it("customInit：begin / probe / uninst 起点都先等于启动时刻（静默安装没有向导页，差值 0）；prev 默认 0、读 InstallLocation 才置 1", () => {
    const init = nsisCode(macroBody("customInit"));
    const tick = init.indexOf("GetTickCount()i.r0");
    const initAssign = init.indexOf("StrCpy $flowshipInitTick $0");
    const beginAssign = init.indexOf("StrCpy $flowshipBeginTick $0");
    const probeAssign = init.indexOf("StrCpy $flowshipProbeTick $0");
    const uninstAssign = init.indexOf("StrCpy $flowshipUninstTick $0");
    expect(tick).toBeGreaterThanOrEqual(0);
    expect(initAssign).toBeGreaterThan(tick);
    // 必须在 $0 被 ReadRegStr 覆盖之前赋值
    const readReg = init.indexOf('ReadRegStr $0 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" "InstallLocation"');
    expect(readReg).toBeGreaterThan(beginAssign);
    expect(beginAssign).toBeGreaterThan(initAssign);
    expect(probeAssign).toBeGreaterThan(initAssign);
    expect(uninstAssign).toBeGreaterThan(initAssign);
    expect(readReg).toBeGreaterThan(probeAssign);
    expect(readReg).toBeGreaterThan(uninstAssign);
    expect(init).toContain('StrCpy $flowshipPrev "0"');
    expect(init.indexOf('StrCpy $flowshipPrev "0"')).toBeLessThan(readReg);
    expect(init).toMatch(/\$\{if\} \$0 != ""\n\s*StrCpy \$flowshipPrev "1"/);
  });

  it("customInit：旧版本号读 DisplayVersion（取不到记 -、截 24 字符），在 InstallLocation 之后、Push $2 之前（不动现有栈布局）", () => {
    const init = nsisCode(macroBody("customInit"));
    const readVer = init.indexOf('ReadRegStr $0 SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" "DisplayVersion"');
    expect(readVer).toBeGreaterThan(init.indexOf('"InstallLocation"'));
    expect(readVer).toBeLessThan(init.indexOf("Push $2"));
    expect(init).toMatch(/\$\{if\} \$0 == ""\n\s*StrCpy \$0 "-"\n\s*\$\{endIf\}\n\s*StrCpy \$flowshipPrevVer \$0 24/);
  });
});

describe("begin：点「安装」离开向导的时间点", () => {
  const body = nsisCode(macroBody("customPageAfterChangeDir"));

  it("用官方扩展点 customPageAfterChangeDir 插一个永远不显示的页（creator 里 Abort = 跳过）", () => {
    expect(body).toContain("Function flowshipBeginPage");
    expect(body).toContain("Page custom flowshipBeginPage");
    // Function 定义在 Page 声明之前；Abort 必须在 FunctionEnd 之前（否则页会真的弹出来）
    expect(body.indexOf("Function flowshipBeginPage")).toBeLessThan(body.indexOf("Page custom flowshipBeginPage"));
    expect(body.indexOf("\n    Abort")).toBeGreaterThan(body.indexOf("Function flowshipBeginPage"));
    expect(body.indexOf("\n    Abort")).toBeLessThan(body.indexOf("FunctionEnd"));
  });

  it("记 begin 时间点、把 probe / uninst 起点对齐到 begin（钩子万一没被调用，对应秒数也是 0 而不是负数）、写 begin 日志行（带旧版本号）", () => {
    expect(body).toContain("StrCpy $flowshipBeginTick $0");
    expect(body).toContain("StrCpy $flowshipUninstTick $0");
    expect(body).toContain("IntOp $1 $0 - $flowshipInitTick");
    expect(body).toContain("IntOp $1 $1 / 1000");
    expect(body).toContain("StrCpy $2 $flowshipPrevVer");
    expect(body).toContain('!insertmacro flowshipLog "begin v${VERSION} waitSec=$1 prevVer=$2"');
  });

  it("begin 日志先写、文件系统实测后做（begin 是「用户点安装」的时间点，不能把实测耗时算进 waitSec）", () => {
    const beginLog = body.indexOf('!insertmacro flowshipLog "begin v');
    const probeInst = body.indexOf('!insertmacro flowshipFsProbe "inst" "$INSTDIR"');
    const probeTmp = body.indexOf('!insertmacro flowshipFsProbe "tmp" "$PLUGINSDIR"');
    expect(beginLog).toBeGreaterThanOrEqual(0);
    expect(probeInst).toBeGreaterThan(beginLog);
    expect(probeTmp).toBeGreaterThan(probeInst);
  });

  it("实测结束后重取 tick 赋给 probe / uninst 起点：probeSec 单独成段，不混进 waitSec 也不混进 uninstSec", () => {
    const probeTmp = body.indexOf('!insertmacro flowshipFsProbe "tmp"');
    const tailTick = body.indexOf("GetTickCount()i.r0", probeTmp);
    const probeAssign = body.indexOf("StrCpy $flowshipProbeTick $0", tailTick);
    const uninstAssign = body.indexOf("StrCpy $flowshipUninstTick $0", tailTick);
    expect(tailTick).toBeGreaterThan(probeTmp);
    expect(probeAssign).toBeGreaterThan(tailTick);
    expect(uninstAssign).toBeGreaterThan(tailTick);
    // 离开函数（Abort）之前完成
    expect(Math.max(probeAssign, uninstAssign)).toBeLessThan(body.indexOf("\n    Abort"));
  });

  it("栈纪律：进 3 个寄存器、Abort 之前按 LIFO 出栈", () => {
    expect(body.match(/^\s*Push \$\d$/gm)).toHaveLength(3);
    expect(body).toMatch(/Pop \$2\n\s*Pop \$1\n\s*Pop \$0\n\s*Abort/);
  });

  it("它必须在 MUI 的 instfiles 页之前被声明（模板在 MUI_PAGE_INSTFILES 之前展开 customPageAfterChangeDir）", () => {
    const dir = findAppBuilderTemplateDir();
    if (!dir) return;
    const tpl = readFileSync(path.join(dir, "assistedInstaller.nsh"), "utf8");
    const hook = tpl.indexOf("!insertmacro customPageAfterChangeDir");
    const instfiles = tpl.indexOf("!insertmacro MUI_PAGE_INSTFILES");
    expect(hook).toBeGreaterThanOrEqual(0);
    expect(instfiles).toBeGreaterThan(hook);
  });
});

/** 在 pnpm 布局里找 app-builder-lib 的 NSIS 模板目录（找不到就跳过对账、不让测试在精简环境里红）。 */
function findAppBuilderTemplateDir(): string | null {
  const pnpmDir = path.join(root, "node_modules", ".pnpm");
  if (!existsSync(pnpmDir)) return null;
  const hit = readdirSync(pnpmDir).find((n) => n.startsWith("app-builder-lib@"));
  if (!hit) return null;
  const dir = path.join(pnpmDir, hit, "node_modules", "app-builder-lib", "templates", "nsis");
  return existsSync(dir) ? dir : null;
}

describe("uninstalled：customUnInstallCheck 复刻官方默认分支（定义它会让官方默认的错误处理整段被跳过）", () => {
  const body = nsisCode(macroBody("customUnInstallCheck"));

  it("旧卸载器拉不起来 / 退出码非 0 的处理与官方默认分支逐句一致（语句级）", () => {
    expect(body).toContain("DetailPrint `Uninstall was not successful. Not able to launch uninstaller!`");
    expect(body).toContain("${if} $R0 != 0");
    expect(body).toContain('MessageBox MB_OK|MB_ICONEXCLAMATION "$(uninstallFailed): $R0"');
    expect(body).toContain("DetailPrint `Uninstall was not successful. Uninstaller error code: $R0.`");
    expect(body).toContain("SetErrorLevel 2");
    expect(body).toContain("Quit");
  });

  it("对账官方模板：默认分支里这些关键语句仍然存在（electron-builder 升级改了默认行为时这里要红、提醒同步）", () => {
    const dir = findAppBuilderTemplateDir();
    if (!dir) return;
    const util = readFileSync(path.join(dir, "include", "installUtil.nsh"), "utf8");
    const fn = util.slice(util.indexOf("Function handleUninstallResult"), util.indexOf("FunctionEnd", util.indexOf("Function handleUninstallResult")));
    for (const stmt of [
      "IfErrors 0 +3",
      "DetailPrint `Uninstall was not successful. Not able to launch uninstaller!`",
      "${if} $R0 != 0",
      'MessageBox MB_OK|MB_ICONEXCLAMATION "$(uninstallFailed): $R0"',
      "DetailPrint `Uninstall was not successful. Uninstaller error code: $R0.`",
      "SetErrorLevel 2",
      "Quit",
    ]) {
      expect(fn, `官方默认分支应含：${stmt}`).toContain(stmt);
    }
    // 官方在定义了钩子时「只执行钩子然后 Return」——这正是必须复刻的原因
    expect(fn).toMatch(/!insertmacro customUnInstallCheck\n\s*Return/);
  });

  it("先把「没拉起来」的错误标志存进 $1，再写日志（日志宏会 ClearErrors，顺序反了就永远看不到错误）", () => {
    const save = body.indexOf("IfErrors 0 +2");
    const log = body.indexOf('!insertmacro flowshipLog "uninstalled');
    expect(save).toBeGreaterThanOrEqual(0);
    expect(body.slice(save, save + 60)).toContain('StrCpy $1 "1"');
    expect(log).toBeGreaterThan(save);
    // 错误标志的初值在 IfErrors 之前
    expect(body.indexOf('StrCpy $1 "0"')).toBeLessThan(save);
  });

  it("记 uninst 时间点：先取 tick 赋给 $flowshipUninstTick，再减 probe（实测结束点）换成秒，日志含退出码", () => {
    const tick = body.indexOf("GetTickCount()i.r0");
    const assign = body.indexOf("StrCpy $flowshipUninstTick $0");
    expect(assign).toBeGreaterThan(tick);
    expect(body).toContain("IntOp $0 $0 - $flowshipProbeTick");
    expect(body).not.toContain("IntOp $0 $0 - $flowshipBeginTick");
    expect(body).toContain("IntOp $0 $0 / 1000");
    expect(body).toContain('!insertmacro flowshipLog "uninstalled v${VERSION} uninstSec=$0 launchFailed=$1 code=$2"');
  });

  it("栈纪律：进 3 个寄存器；「拉不起来」的 Return 之前出栈、正常出口出栈（Quit 路径进程直接退出无需还原）", () => {
    expect(body.match(/^\s*Push \$\d$/gm)).toHaveLength(3);
    expect(body).toMatch(/Pop \$2\n\s*Pop \$1\n\s*Pop \$0\n\s*Return/);
    expect(body.match(/Pop \$2\n\s*Pop \$1\n\s*Pop \$0/g)).toHaveLength(2);
    expect(body.trimEnd().endsWith("Pop $0")).toBe(true);
  });
});

describe("phases：文件落盘后的阶段汇总", () => {
  const body = nsisCode(macroBody("flowshipLogPhases"));

  it("四段首尾相接 = begin-init（向导停留）/ probe-begin（文件系统实测）/ uninst-probe（旧版移除）/ now-uninst（解压落盘），都换成秒", () => {
    expect(body).toContain("GetTickCount()i.r3");
    expect(body).toContain("IntOp $0 $flowshipBeginTick - $flowshipInitTick");
    expect(body).toContain("IntOp $4 $flowshipProbeTick - $flowshipBeginTick");
    expect(body).toContain("IntOp $1 $flowshipUninstTick - $flowshipProbeTick");
    expect(body).toContain("IntOp $2 $3 - $flowshipUninstTick");
    expect(body.match(/IntOp \$[0124] \$[0124] \/ 1000/g)).toHaveLength(4);
    // $3 先拿来存 now 做减法，之后才被 prev 覆盖
    expect(body.indexOf("IntOp $2 $3 - $flowshipUninstTick")).toBeLessThan(body.indexOf("StrCpy $3 $flowshipPrev"));
    expect(body).toContain(
      '!insertmacro flowshipLog "phases v${VERSION} prev=$3 waitSec=$0 probeSec=$4 uninstSec=$1 extractSec=$2"',
    );
  });

  it("自带寄存器保护（5 进 5 出、LIFO），由 customInstall 在 done 行之后调用", () => {
    expect(body.match(/^\s*Push \$\d$/gm)).toHaveLength(5);
    expect(body).toMatch(/Pop \$4\n\s*Pop \$3\n\s*Pop \$2\n\s*Pop \$1\n\s*Pop \$0$/);
    const install = nsisCode(macroBody("customInstall"));
    expect(install.indexOf("!insertmacro flowshipLogPhases")).toBeGreaterThan(
      install.indexOf('!insertmacro flowshipLog "done v${VERSION}'),
    );
  });
});

describe("fsprobe：安装前的小文件创建 / 删除实测", () => {
  const body = nsisCode(macroBody("flowshipFsProbe"));

  it("在 DIR\\.fsprobe 里建小文件（扩展名 .js：杀软常按扩展名决定扫不扫）、用完整批删除并 RMDir", () => {
    expect(body).toContain('CreateDirectory "${DIR}\\.fsprobe"');
    expect(body).toContain('FileOpen $2 "${DIR}\\.fsprobe\\p$1.js" w');
    expect(body).toContain("FileWrite $2");
    expect(body).toContain("FileClose $2");
    expect(body).toContain('Delete "${DIR}\\.fsprobe\\*.*"');
    expect(body).toContain('RMDir "${DIR}\\.fsprobe"');
    // 先删文件再 RMDir（RMDir 不带 /r、目录非空会静默失败）
    expect(body.indexOf("Delete ")).toBeLessThan(body.indexOf("RMDir "));
    // 绝不 /r 递归删：DIR 是用户选的安装目录，递归删一旦路径算错后果不可逆
    expect(body).not.toMatch(/RMDir\s+\/r/);
  });

  it("有上限：文件数与耗时「先到先停」，上限是 define 常量（慢机器上不能把安装前的等待再拉长一截）", () => {
    expect(installer).toMatch(/!define FLOWSHIP_PROBE_MAX_FILES (\d+)/);
    expect(installer).toMatch(/!define FLOWSHIP_PROBE_MAX_MS (\d+)/);
    const files = Number(installer.match(/!define FLOWSHIP_PROBE_MAX_FILES (\d+)/)?.[1]);
    const ms = Number(installer.match(/!define FLOWSHIP_PROBE_MAX_MS (\d+)/)?.[1]);
    expect(files).toBeLessThanOrEqual(100);
    expect(ms).toBeLessThanOrEqual(2000);
    expect(body).toContain("${If} $1 >= ${FLOWSHIP_PROBE_MAX_FILES}");
    expect(body).toContain("${OrIf} $3 >= ${FLOWSHIP_PROBE_MAX_MS}");
    // 两个上限都落在循环里的 Break 上
    const loopStart = body.indexOf("${Do}");
    const loopEnd = body.indexOf("${Loop}");
    expect(body.indexOf("${FLOWSHIP_PROBE_MAX_MS}")).toBeGreaterThan(loopStart);
    expect(body.indexOf("${FLOWSHIP_PROBE_MAX_MS}")).toBeLessThan(loopEnd);
  });

  it("建不出文件（没权限 / 路径非法）→ err=1 并跳出循环，不死循环、不中断安装", () => {
    expect(body).toMatch(/FileOpen \$2 [^\n]+\n\s*\$\{If\} \$\{Errors\}\n\s*StrCpy \$5 "1"\n\s*\$\{Break\}/);
    expect(body).toContain('StrCpy $5 "0"');
  });

  it("剩余空间：GetDiskFreeSpaceEx 的 $1/$2/$3 输出会被覆盖，默认值 ? 必须在调用之后再赋（与 init 同一个坑）", () => {
    const call = body.indexOf('GetDiskFreeSpaceEx(t "${DIR}", *l .r1, *l .r2, *l .r3) i .r0');
    const dflt = body.indexOf('StrCpy $4 "?"');
    expect(call).toBeGreaterThanOrEqual(0);
    expect(dflt).toBeGreaterThan(call);
  });

  it("循环结束后统一重取 tick 算建文件总耗时（中途 Break 时 $3 不是最新值）、删除另算一段", () => {
    const loopEnd = body.indexOf("${Loop}");
    const refresh = body.indexOf("GetTickCount()i.r3", loopEnd);
    expect(refresh).toBeGreaterThan(loopEnd);
    expect(body.indexOf("IntOp $3 $3 - $0", refresh)).toBeGreaterThan(refresh);
    const delTick = body.indexOf("GetTickCount()i.r0", refresh);
    expect(delTick).toBeGreaterThan(refresh);
    expect(delTick).toBeLessThan(body.indexOf("Delete "));
    expect(body.indexOf("IntOp $2 $2 - $0")).toBeGreaterThan(body.indexOf("Delete "));
  });

  it("日志只含 $0-$9 / VERSION（路径一律不进日志）；7 进 7 出 LIFO；参数 TAG 存进 $6 而不是直接拼进日志文案", () => {
    expect(body).toContain('!insertmacro flowshipLog "fsprobe $6 v${VERSION} files=$1 createMs=$3 delMs=$2 freeMB=$4 err=$5"');
    expect(body).toContain('StrCpy $6 "${TAG}"');
    expect(body.match(/^\s*Push \$\d$/gm)).toHaveLength(7);
    expect(body).toMatch(/Pop \$6\n\s*Pop \$5\n\s*Pop \$4\n\s*Pop \$3\n\s*Pop \$2\n\s*Pop \$1\n\s*Pop \$0$/);
  });

  it("只在手动安装的 begin 页里调用：customInit / customInstall / customUnInstallCheck 不跑实测（静默安装与自动更新路径不变）", () => {
    for (const name of ["customInit", "customInstall", "customUnInstallCheck", "flowshipLogPhases"]) {
      expect(nsisCode(macroBody(name)), name).not.toContain("flowshipFsProbe");
    }
    expect(nsisCode(macroBody("customPageAfterChangeDir")).match(/!insertmacro flowshipFsProbe/g)).toHaveLength(2);
  });

  it("探测临时目录用 $PLUGINSDIR（%TEMP% 下、安装载荷落盘的同一块盘），安装目录用 $INSTDIR（用户最终选定的）", () => {
    const page = nsisCode(macroBody("customPageAfterChangeDir"));
    expect(page).toContain('!insertmacro flowshipFsProbe "inst" "$INSTDIR"');
    expect(page).toContain('!insertmacro flowshipFsProbe "tmp" "$PLUGINSDIR"');
  });
});

describe("首次启动预读：main.js 接线", () => {
  it("从 ./boot-prefetch.mjs 引入；清单读 serverDir 下的 boot-manifest.json", () => {
    expect(main).toContain('from "./boot-prefetch.mjs"');
    for (const name of ["BOOT_MANIFEST_FILENAME", "formatPrefetchSummary", "parseBootManifest", "runPrefetch", "shouldPrefetch"]) {
      expect(main, name).toContain(name);
    }
    expect(main).toContain("path.join(serverDir, BOOT_MANIFEST_FILENAME)");
  });

  it("门禁走 shouldPrefetch（平台 / 首次启动 / 环境变量），不在 main.js 里另写一套条件", () => {
    expect(main).toMatch(/shouldPrefetch\(\{\s*platform: process\.platform,\s*firstBoot,\s*env: process\.env,?\s*\}\)/);
  });

  it("fire-and-forget：void 异步块、不 await 预读；整体 try/catch 只记日志（预读绝不能挡启动）", () => {
    const start = main.indexOf("shouldPrefetch({");
    const block = main.slice(start, main.indexOf("// mac 自定义应用菜单", start));
    expect(block).toContain("void (async () => {");
    expect(block).toMatch(/catch \(err\) \{\s*log\(`\[main\] prefetch 异常（忽略）/);
    expect(block).not.toMatch(/^\s*await runPrefetch/m);
    expect(block).toContain("没有可用的启动清单");
    // 未启用时也留一行日志，事后能分清「没跑」和「跑了没记」
    expect(block).toContain("[main] prefetch 未启用（");
  });

  it("firstBoot 只算一次、在 startServer() 之前（预读与超时选择复用同一个值）", () => {
    const decls = main.match(/const firstBoot = isFirstBoot\(\);/g) ?? [];
    expect(decls).toHaveLength(1);
    const declAt = main.indexOf("const firstBoot = isFirstBoot();");
    const prefetchAt = main.indexOf("shouldPrefetch({");
    const startServerCall = main.lastIndexOf("    startServer();");
    expect(declAt).toBeLessThan(prefetchAt);
    expect(prefetchAt).toBeLessThan(startServerCall);
    expect(main).toContain("pickBootTimeoutMs(firstBoot)");
  });

  it("reveal 日志带「距主进程启动」秒数（把点图标到窗口可用拆开）", () => {
    expect(main).toContain("距主进程启动 ${process.uptime().toFixed(1)}s");
  });
});

describe("清单生成脚本没有接进发版链（先在真机验证预读收益再接）", () => {
  it("release.yml / assemble 脚本都不引用 gen-boot-manifest", () => {
    expect(read(".github/workflows/release.yml")).not.toContain("gen-boot-manifest");
    expect(read("scripts/assemble-electron-server.mjs")).not.toContain("gen-boot-manifest");
    expect(read("scripts/electron-after-pack.mjs")).not.toContain("gen-boot-manifest");
  });
});
