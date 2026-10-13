/**
 * 旧版本移除提速（旧卸载器的 TEMP 临时指到旧安装目录所在盘）的契约。
 * 说明：NSIS 断言是字符串级契约——能防回退 / 防顺序写反，不能证明 Windows 上的运行时行为；
 * 运行时以 installer.log 里的 `tmpredirect` / `tmprestore` 两行 + `uninstSec` 为准（见 docs RCA §10.5）。
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

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

/** 在 pnpm 布局里找 app-builder-lib 的 NSIS 模板目录（找不到就跳过对账、不让测试在精简环境里红）。 */
function findAppBuilderTemplateDir(): string | null {
  const pnpmDir = path.join(root, "node_modules", ".pnpm");
  if (!existsSync(pnpmDir)) return null;
  const hit = readdirSync(pnpmDir).find((n) => n.startsWith("app-builder-lib@"));
  if (!hit) return null;
  const dir = path.join(pnpmDir, hit, "node_modules", "app-builder-lib", "templates", "nsis");
  return existsSync(dir) ? dir : null;
}

describe("临时目录重定向：变量与常量", () => {
  it("三个新变量与其他阶段变量同在 !ifndef BUILD_UNINSTALLER 块内（卸载器 pass 声明了没人用 → -WX 下整包打不出来）", () => {
    const guardStart = installer.indexOf("!ifndef BUILD_UNINSTALLER");
    const guardEnd = installer.indexOf("!endif", guardStart);
    const block = installer.slice(guardStart, guardEnd);
    for (const v of ["flowshipTmpDir", "flowshipOrigTemp", "flowshipOrigTmp"]) {
      expect(block, `Var ${v}`).toContain(`Var ${v}`);
    }
  });

  it("目录名是固定常量（清理时按它整目录删，所以只能装我们自己放进去的东西）", () => {
    expect(installer).toContain('!define FLOWSHIP_TMP_DIRNAME ".flowship-tmp"');
  });
});

describe("flowshipTmpRedirect：什么时候改、怎么改", () => {
  const body = nsisCode(macroBody("flowshipTmpRedirect"));

  it("只在覆盖安装时改（flowshipPrev == 1）；全新安装 / 已经改过（幂等）都不动", () => {
    expect(body).toContain('StrCpy $3 "fresh-install"');
    expect(body).toContain('${if} $flowshipTmpDir != ""');
    expect(body).toContain('StrCpy $3 "already"');
    expect(body).toContain('${elseIf} $flowshipPrev == "1"');
  });

  it("用旧安装目录（注册表 InstallLocation）而不是向导里新选的 $INSTDIR：旧卸载器搬的是旧目录里的文件", () => {
    expect(body).toContain('ReadRegStr $0 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" "InstallLocation"');
    expect(body).not.toContain("$INSTDIR");
  });

  it("只处理「X:\\…」盘符路径（第 2 个字符是冒号）；UNC / 取不到一律不改；容忍被引号包起来的旧值", () => {
    expect(body).toContain('${if} $4 == \'"\'');
    expect(body).toMatch(/StrCpy \$4 \$0 1 1\n\s*\$\{if\} \$4 != ":"\n\s*StrCpy \$3 "not-drive-path"/);
    expect(body).toContain("StrCpy $1 $0 2");
  });

  it("与当前 %TEMP% 同盘就不改（装在 C: 的人什么都不动）", () => {
    expect(body).toContain("StrCpy $2 $TEMP 2");
    expect(body).toMatch(/\$\{if\} \$1 == \$2\n\s*StrCpy \$3 "same-drive"/);
  });

  it("先建目录、再真写一个文件验证可写，全部通过才改环境变量（写不进去会让旧卸载器连临时文件都建不出来）", () => {
    const mkdir = body.indexOf('CreateDirectory "$1\\${FLOWSHIP_TMP_DIRNAME}"');
    const write = body.indexOf('FileOpen $4 "$1\\${FLOWSHIP_TMP_DIRNAME}\\.w" w');
    const del = body.indexOf('Delete "$1\\${FLOWSHIP_TMP_DIRNAME}\\.w"');
    const setTemp = body.indexOf('SetEnvironmentVariable(t "TEMP"');
    const setTmp = body.indexOf('SetEnvironmentVariable(t "TMP"');
    expect(mkdir).toBeGreaterThanOrEqual(0);
    expect(write).toBeGreaterThan(mkdir);
    expect(del).toBeGreaterThan(write);
    expect(setTemp).toBeGreaterThan(del);
    expect(setTmp).toBeGreaterThan(del);
    // 两个失败分支各有日志原因；写不进去时把刚建的空目录收掉（非递归）
    expect(body).toContain('StrCpy $3 "mkdir-failed"');
    expect(body).toMatch(/StrCpy \$3 "write-failed"\n\s*RMDir "\$1\\\$\{FLOWSHIP_TMP_DIRNAME\}"/);
  });

  it("TEMP 和 TMP 都要改（GetTempPath 先看 TMP 再看 TEMP），且改之前先存原值（还原用）", () => {
    const readTemp = body.indexOf('ReadEnvStr $flowshipOrigTemp "TEMP"');
    const readTmp = body.indexOf('ReadEnvStr $flowshipOrigTmp "TMP"');
    const setTemp = body.indexOf('SetEnvironmentVariable(t "TEMP"');
    expect(readTemp).toBeGreaterThanOrEqual(0);
    expect(readTmp).toBeGreaterThanOrEqual(0);
    expect(readTemp).toBeLessThan(setTemp);
    expect(readTmp).toBeLessThan(setTemp);
    expect(body).toContain('StrCpy $flowshipTmpDir "$1\\${FLOWSHIP_TMP_DIRNAME}"');
    expect(body).toContain('System::Call \'kernel32::SetEnvironmentVariable(t "TEMP", t "$flowshipTmpDir")\'');
    expect(body).toContain('System::Call \'kernel32::SetEnvironmentVariable(t "TMP", t "$flowshipTmpDir")\'');
  });

  it("flowshipTmpDir 只在「全部验证通过」之后才被赋值（不会出现「变量记着、环境变量没改」或反过来）", () => {
    const assigns = body.match(/StrCpy \$flowshipTmpDir /g) ?? [];
    expect(assigns).toHaveLength(1);
    expect(body.indexOf("StrCpy $flowshipTmpDir")).toBeGreaterThan(body.indexOf('Delete "$1\\${FLOWSHIP_TMP_DIRNAME}\\.w"'));
  });

  it("这个宏里不递归删任何东西（递归删只允许出现在 restore 里、且只删我们自己的固定目录）", () => {
    expect(body).not.toMatch(/RMDir\s+\/r/);
  });

  it("日志只记盘符与原因，不记路径（FileWrite 按 ANSI 落盘，中文路径会乱码）", () => {
    expect(body).toContain('!insertmacro flowshipLog "tmpredirect v${VERSION} result=$3 tempDrive=$2 oldDrive=$1"');
    expect(body).not.toMatch(/flowshipLog "[^"]*\$0/);
  });

  it("栈纪律：5 进 5 出、LIFO（$0-$4 全程保护）", () => {
    expect(body.match(/^\s*Push \$\d$/gm)).toHaveLength(5);
    expect(body).toMatch(/Pop \$4\n\s*Pop \$3\n\s*Pop \$2\n\s*Pop \$1\n\s*Pop \$0$/);
  });
});

describe("flowshipTmpRestore：还原环境变量 + 清理目录", () => {
  const body = nsisCode(macroBody("flowshipTmpRestore"));

  it("没改过（flowshipTmpDir 为空）就什么都不做；做完把它清空（不重复还原）", () => {
    expect(body.trimStart().startsWith('${if} $flowshipTmpDir != ""')).toBe(true);
    expect(body).toContain('StrCpy $flowshipTmpDir ""');
  });

  it("TEMP / TMP 都还原成原值；原值本来是空（没定义）就删掉（p 0 = NULL），不留一个空值", () => {
    expect(body).toContain('SetEnvironmentVariable(t "TEMP", p 0)');
    expect(body).toContain('SetEnvironmentVariable(t "TMP", p 0)');
    expect(body).toContain('SetEnvironmentVariable(t "TEMP", t "$flowshipOrigTemp")');
    expect(body).toContain('SetEnvironmentVariable(t "TMP", t "$flowshipOrigTmp")');
  });

  it("先还原环境变量、再删目录（环境变量还指着目录时不能先把它删了）", () => {
    const restoreTmp = body.indexOf('SetEnvironmentVariable(t "TMP", t "$flowshipOrigTmp")');
    const rmdir = body.indexOf("RMDir /r");
    expect(restoreTmp).toBeGreaterThanOrEqual(0);
    expect(rmdir).toBeGreaterThan(restoreTmp);
  });

  it("只有旧卸载器正常退出（拉起成功 且 退出码 0）才整目录删；失败时保留（里面可能是旧文件的唯一副本）", () => {
    expect(body).toMatch(
      /\$\{if\} \$\{LAUNCHFAILED\} == "0"\n\s*\$\{andIf\} \$\{CODE\} == 0\n\s*RMDir \/r "\$flowshipTmpDir"/,
    );
    expect(body).toContain('StrCpy $0 "kept"');
    expect(body).toContain('StrCpy $0 "removed"');
    // 整个安装脚本里的递归删除只有这一处、且对象只能是我们自己的目录变量
    const all = nsisCode(installer).match(/RMDir\s+\/r[^\n]*/g) ?? [];
    expect(all).toEqual(['RMDir /r "$flowshipTmpDir"']);
  });

  it("不碰 $R0（旧卸载器退出码，后面要用）；只用 $0 做临时变量并保护；日志宏会改错误标志所以收尾 ClearErrors", () => {
    expect(body).not.toMatch(/\$R0\s*$/m);
    expect(body.match(/^\s*Push \$\d$/gm)).toEqual([expect.stringContaining("$0")]);
    expect(body).toMatch(/Pop \$0\n\s*\$\{endIf\}$/);
    expect(body).toContain('!insertmacro flowshipLog "tmprestore v${VERSION} dir=$0"');
    expect(body.indexOf("ClearErrors")).toBeLessThan(body.indexOf("flowshipLog"));
  });
});

describe("接线：谁在什么时候调用", () => {
  it("customInit：只在静默安装（含自动更新）里调用，且在所有 Abort 分支之后（不会出现「改了环境变量却退出」）", () => {
    const init = nsisCode(macroBody("customInit"));
    const call = init.indexOf("!insertmacro flowshipTmpRedirect");
    expect(call).toBeGreaterThanOrEqual(0);
    expect(init.match(/!insertmacro flowshipTmpRedirect/g)).toHaveLength(1);
    // 紧贴在 ${if} ${Silent} 里
    expect(init.slice(Math.max(0, call - 40), call)).toMatch(/\$\{if\} \$\{Silent\}\n\s*$/);
    expect(call).toBeGreaterThan(init.lastIndexOf("Abort"));
    expect(call).toBeGreaterThan(init.indexOf("taskkill"));
  });

  it("手动安装：在 begin 页（用户点「安装」那一刻）里调用，在 tick 重取之后、出栈之前", () => {
    const page = nsisCode(macroBody("customPageAfterChangeDir"));
    const call = page.indexOf("!insertmacro flowshipTmpRedirect");
    expect(call).toBeGreaterThanOrEqual(0);
    expect(page.match(/!insertmacro flowshipTmpRedirect/g)).toHaveLength(1);
    expect(call).toBeGreaterThan(page.indexOf('!insertmacro flowshipFsProbe "tmp"'));
    expect(call).toBeLessThan(page.indexOf("Pop $2"));
  });

  it("customUnInstallCheck：错误标志存进 $1 之后、任何可能 Quit / Return 的分支之前还原；参数是 $1 与 $R0", () => {
    const body = nsisCode(macroBody("customUnInstallCheck"));
    const saveFlag = body.indexOf('StrCpy $1 "1"');
    const restore = body.indexOf("!insertmacro flowshipTmpRestore $1 $R0");
    const tick = body.indexOf("GetTickCount()i.r0");
    const firstReturn = body.indexOf("Return");
    const quit = body.indexOf("Quit");
    expect(saveFlag).toBeGreaterThanOrEqual(0);
    expect(restore).toBeGreaterThan(saveFlag);
    expect(restore).toBeLessThan(tick);
    expect(restore).toBeLessThan(firstReturn);
    expect(restore).toBeLessThan(quit);
  });

  it("restore 不在任何其它地方被调用（只有官方「旧卸载器退出后」这一个必经点）", () => {
    const all = nsisCode(installer).match(/!insertmacro flowshipTmpRestore[^\n]*/g) ?? [];
    expect(all).toEqual(["!insertmacro flowshipTmpRestore $1 $R0"]);
  });
});

describe("对账官方模板：我们依赖的行为还在", () => {
  const dir = findAppBuilderTemplateDir();

  it("旧卸载器用 ExecWait 拉起（CreateProcess 继承当前进程环境块）、没有自带环境变量参数", () => {
    if (!dir) return;
    const util = readFileSync(path.join(dir, "include", "installUtil.nsh"), "utf8");
    expect(util).toMatch(/ExecWait '"\$uninstallerFileNameTemp" \/S \/KEEP_APP_DATA \$0 _\?=\$installationDir' \$R0/);
    // 旧卸载器要搬的是注册表里的 InstallLocation（旧目录），不是新选的 $INSTDIR
    expect(util).toContain('readReg $installationDir "$rootKey" "${INSTALL_REGISTRY_KEY}" InstallLocation');
  });

  it("安装段里：旧卸载器 → handleUninstallResult 紧挨着（我们的还原挂在后者的 customUnInstallCheck 里）", () => {
    if (!dir) return;
    const section = readFileSync(path.join(dir, "installSection.nsh"), "utf8");
    expect(section).toMatch(/!insertmacro uninstallOldVersion SHELL_CONTEXT\n!insertmacro handleUninstallResult SHELL_CONTEXT/);
  });

  it("旧卸载器搬文件的目标是 $PLUGINSDIR\\old-install（在它自己进程的 %TEMP% 下）——这是整个提速的依据", () => {
    if (!dir) return;
    const un = readFileSync(path.join(dir, "uninstaller.nsh"), "utf8");
    expect(un).toContain('Rename "$INSTDIR$R0\\$R2" "$PLUGINSDIR\\old-install$R0\\$R2"');
  });
});
