/** Windows NSIS 自动更新的进程清理 + 快捷方式 + 自定义目录契约。 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { BYTES_PER_MB, MIN_TEMP_FREE_MB } from "../electron-app/disk-space.mjs";
import { findInstallerAbort } from "../electron-app/win-update-guard.mjs";

const read = (relativePath: string): string =>
  readFileSync(path.resolve(import.meta.dirname, "..", relativePath), "utf8");

const installer = read("packaging/installer.nsh");
const main = read("electron-app/main.js");
const guard = read("electron-app/win-update-guard.mjs");

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
    // 失败弹框的文案在 win-update-guard.mjs（纯函数、有单测），壳里只负责取数据、弹框
    expect(main).toContain("buildUpdateFailedMessage");
    expect(guard).toContain("上次更新没有装上");
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

  it("日志只含 ASCII 且路径只记盘符：FileWrite 按系统 ANSI 代码页（简中 = GBK）落盘、读取端按 UTF-8 解码，中文用户名路径必乱码", () => {
    // 合并前评审 #4：原先的测试只校验模板字面量，而日志里写了 $INSTDIR / $TEMP，运行时的值保证不了
    const messages = [...installer.matchAll(/!insertmacro flowshipLog "([^"]*)"/g)].map(
      (m) => m[1],
    );
    // init / ABORT / WARN / DECLINED / CONTINUE / done
    expect(messages.length).toBeGreaterThanOrEqual(6);
    for (const msg of messages) {
      expect(msg, `日志文案含非 ASCII：${msg}`).toMatch(/^[\x20-\x7e]*$/);
      // 变量白名单：版本 / 阈值常量 / $0-$9 寄存器；其余（$INSTDIR $TEMP $APPDATA …）一律可能带中文路径
      // MODE = flowshipForceCleanOld 的宏参数（编译期字面量 "broken" / "failed"，不是运行时变量）
      for (const v of msg.matchAll(/\$\{(\w+)\}|\$(\w+)/g)) {
        const name = (v[1] ?? v[2]) as string;
        const ok =
          name === "VERSION" ||
          name === "FLOWSHIP_MIN_TEMP_FREE_MB" ||
          name === "MODE" ||
          /^[0-9]$/.test(name);
        expect(ok, `日志 "${msg}" 引用了 $${name}：可能是含中文的完整路径`).toBe(true);
      }
    }
    // 寄存器里放的只是盘符（前 2 个字符，如 "E:"），完整路径由 UTF-8 的 main.log 提供
    const init = nsisCode(macroBody("customInit"));
    const install = nsisCode(macroBody("customInstall"));
    expect(init).toContain("StrCpy $4 $INSTDIR 2");
    expect(init).toContain("StrCpy $5 $TEMP 2");
    expect(init).toContain("instDrive=$4 tempDrive=$5");
    expect(install).toContain("StrCpy $4 $INSTDIR 2");
    expect(install).toContain("instDrive=$4");
  });

  it("init 行在 customInit、done 行在 customInstall（done 带总耗时 / 标记结果，才能区分「没装完」和「装完了」）", () => {
    const init = macroBody("customInit");
    const install = macroBody("customInstall");
    expect(init).toContain('!insertmacro flowshipLog "init v${VERSION}');
    expect(init).toContain("tempFreeMB=");
    expect(init).toContain("instDrive=");
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

  it("预检（自动更新）：量 %TEMP% 所在盘、低于阈值静默 Abort；量不到（?）放行", () => {
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
    // 这个守卫块里恰好一个 Abort 与一条 ABORT 日志（手动安装的弹框 / 取消在下面单独测）
    const autoEnd = body.indexOf("${endIf}", guard);
    const autoBlock = body.slice(guard, autoEnd);
    expect(autoBlock.match(/\bAbort\b/g)).toHaveLength(1);
    expect(autoBlock).toContain('flowshipLog "ABORT v${VERSION}');
    // 自动更新是静默的：这个块里绝不能有 MessageBox（没界面、会把更新卡死在对话框上）
    expect(autoBlock).not.toContain("MessageBox");
  });

  it("预检（手动安装）：量到且不够才弹框、默认「否」；静默 / 自动更新 / 量不到都不弹；选「是」继续、选「否」Abort 且旧版本没动", () => {
    // 合并前评审 #2：installSection.nsh 无条件调用 uninstallOldVersion，手动覆盖安装同样会先搬走旧文件，
    // 而安装向导不会告诉用户是空间的问题——只会在装到一半时看到失败页
    const body = nsisCode(macroBody("customInit"));
    const guard = body.indexOf(
      '${ifNot} ${isUpdated}\n  ${andIfNot} ${Silent}\n  ${andIf} $2 != "?"\n  ${andIf} $2 < ${FLOWSHIP_MIN_TEMP_FREE_MB}',
    );
    expect(guard, "手动预检条件应为 !isUpdated && !Silent && 已知 && 低于阈值").toBeGreaterThanOrEqual(0);
    const end = body.indexOf("${endIf}", guard);
    const block = body.slice(guard, end);

    // 全 customInit 只有一个 MessageBox，且就在这个守卫块里
    expect(body.match(/MessageBox/g)).toHaveLength(1);
    const mb = block.match(/MessageBox (\S+) "([^"]*)" \/SD IDYES IDYES (\w+)/);
    expect(mb, '应为 `MessageBox <flags> "文案" /SD IDYES IDYES <label>`').not.toBeNull();
    const [, flags, text, label] = mb as RegExpMatchArray;
    // 是 / 否按钮 + 警告图标 + 默认「否」（回车 / 空格 = 取消）
    expect(flags.split("|").sort()).toEqual(["MB_DEFBUTTON2", "MB_ICONEXCLAMATION", "MB_YESNO"]);
    // 文案：盘符 $5、剩余 MB $2、阈值取常量（不写死）、给出可执行的建议
    expect(text).toContain("$5");
    expect(text).toContain("$2");
    expect(text).toContain("${FLOWSHIP_MIN_TEMP_FREE_MB}");
    expect(text).toContain("清理");
    expect(text).not.toMatch(/\b800\b/);

    // 顺序：WARN 日志 → 弹框 → DECLINED 日志 → 出栈 → Abort → 标签 → CONTINUE 日志
    const warn = block.indexOf('flowshipLog "WARN v${VERSION}');
    const box = block.indexOf("MessageBox");
    const declined = block.indexOf('flowshipLog "DECLINED v${VERSION}');
    const abort = block.search(/^\s*Abort\s*$/m);
    const labelAt = block.indexOf(`${label}:`);
    const cont = block.indexOf('flowshipLog "CONTINUE v${VERSION}');
    for (const [name, i] of Object.entries({ warn, box, declined, abort, labelAt, cont })) {
      expect(i, `手动预检块缺少 ${name}`).toBeGreaterThanOrEqual(0);
    }
    expect(box).toBeGreaterThan(warn);
    expect(declined).toBeGreaterThan(box);
    expect(abort).toBeGreaterThan(declined);
    // 选「是」跳过 Abort：标签必须在 Abort【之后】，否则选「是」也会退出（或 Abort 形同虚设）
    expect(labelAt).toBeGreaterThan(abort);
    expect(cont).toBeGreaterThan(labelAt);
    expect(block.match(/\bAbort\b/g)).toHaveLength(1);
  });

  it("预检的栈纪律：customInit 进栈 4 个寄存器、每条退出路径（含两个 Abort）都按 LIFO 出栈", () => {
    const body = nsisCode(macroBody("customInit"));
    expect(body.match(/^\s*Push \$[2-5]$/gm)).toHaveLength(4);
    // 两个 Abort 前都是 Pop $5 / $4 / $3 / $2；加上正常出口一份，共 3 份 × 4 次
    expect(body.match(/Pop \$5\n\s*Pop \$4\n\s*Pop \$3\n\s*Pop \$2\n\s*Abort/g)).toHaveLength(2);
    // Int64Op 的结果出栈（`Pop $2` 取除法结果）不是寄存器还原，先剔掉再数
    const restores = body.replace(/System::Int64Op \$1 \/ \d+\n\s*Pop \$2/, "");
    expect(restores.match(/^\s*Pop \$[2-5]$/gm)).toHaveLength(12);
    expect(body.match(/\bAbort\b/g)).toHaveLength(2);
    // customInstall 同样对称（新增 $4）
    const install = nsisCode(macroBody("customInstall"));
    expect(install.match(/^\s*Push \$\d$/gm)).toHaveLength(5);
    expect(install.match(/^\s*Pop \$\d$/gm)).toHaveLength(5);
  });

  it("预检在任何破坏性操作之前：弹框与每个 Abort 都早于 customInit 里的 taskkill；旧卸载器在安装段才跑（.onInit 的 Abort = 旧版本原样保留）", () => {
    const body = nsisCode(macroBody("customInit"));
    const kill = body.indexOf("nsExec::Exec 'taskkill");
    expect(kill).toBeGreaterThanOrEqual(0);
    const aborts = [...body.matchAll(/^\s*Abort\s*$/gm)].map((m) => m.index as number);
    expect(aborts).toHaveLength(2);
    for (const a of aborts) expect(kill).toBeGreaterThan(a);
    expect(kill).toBeGreaterThan(body.indexOf("MessageBox"));
    // 安装目录归一化在日志 / 预检之前（日志里记的盘符是归一化后的真实目录）
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

  it("单位换算：NSIS 把字节除以 1048576 得 MB，与 JS 侧 BYTES_PER_MB 同源（错一位 = 几乎所有人被拦 / 预检形同虚设）", () => {
    // 合并前评审：这一处原先零测试保护——改成 `/ 1073741824`（GB）或 `/ 1024`（KB）测试仍全绿
    const body = nsisCode(macroBody("customInit"));
    const divisor = body.match(/System::Int64Op \$1 \/ (\d+)/)?.[1];
    expect(divisor, "未找到 `System::Int64Op $1 / <除数>`").toBeDefined();
    expect(Number(divisor)).toBe(BYTES_PER_MB);
    // 结果必须落进 $2（后面的日志与阈值比较都读它）
    const op = body.indexOf("System::Int64Op $1 /");
    expect(body.slice(op, op + 80)).toContain("Pop $2");
    // 量的是「调用者可用空间」（第一个输出寄存器 $1），不是总容量 / 总空闲
    expect(body).toContain('GetDiskFreeSpaceEx(t "$TEMP", *l .r1, *l .r2, *l .r3)');
  });

  it("耗时起点：customInit 记下 GetTickCount、customInstall 用它求差并换成秒（漏赋值 elapsedSec 会是垃圾值）", () => {
    const init = nsisCode(macroBody("customInit"));
    const install = nsisCode(macroBody("customInstall"));
    const tick = init.indexOf("GetTickCount()i.r0");
    const assign = init.indexOf("StrCpy $flowshipInitTick $0");
    expect(tick).toBeGreaterThanOrEqual(0);
    // 先取 tick、再赋给 $flowshipInitTick（反过来赋的是上一条指令留下的旧值）
    expect(assign).toBeGreaterThan(tick);
    expect(install).toContain("GetTickCount()i.r3");
    expect(install).toContain("IntOp $3 $3 - $flowshipInitTick");
    // 毫秒 → 秒
    expect(install).toContain("IntOp $3 $3 / 1000");
  });

  it("主进程：electron-updater 日志接进 main.log、拉起安装器前记磁盘现场、墓碑弹框指向 installer.log", () => {
    expect(main).toContain("winAutoUpdater.logger = {");
    expect(main).toContain("[electron-updater] ERROR");
    expect(main).toContain("[updater] win quitAndInstall(silent)");
    const logIdx = main.indexOf("[updater] win quitAndInstall(silent)");
    const installIdx = main.indexOf("winAutoUpdater.quitAndInstall(true, true)");
    expect(logIdx).toBeGreaterThanOrEqual(0);
    expect(installIdx).toBeGreaterThan(logIdx);
  });

  it("主进程预检：在标记门禁之后、通知与 quitting = true 之前；不够只弹框返回——不开发布页、不置 quitting、不写墓碑", () => {
    // 合并前评审 #2：存量用户被安装器静默 Abort 后「App 消失」，新客户端要在退出之前就把人拦在原地
    const start = main.indexOf("const installWinUpdate = async");
    const end = main.indexOf("winAutoUpdater.quitAndInstall(true, true)");
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const fn = main.slice(start, end);
    const markerGate = fn.indexOf("hasSilentUpdateMarker(exeDir");
    const spaceGate = fn.indexOf("checkUpdateTempSpace(os.tmpdir(), statfsSync)");
    const notify = fn.indexOf("new Notification(");
    // 匹配语句本身（行首缩进 + 分号结尾）；注释里提到「quitting = true」不能算
    const quit = fn.search(/^\s*quitting = true;/m);
    const tombstone = fn.indexOf("WIN_UPDATE_ATTEMPT_FILE");
    expect(markerGate).toBeGreaterThanOrEqual(0);
    expect(spaceGate).toBeGreaterThan(markerGate);
    expect(notify).toBeGreaterThan(spaceGate); // 先量、再打「正在安装更新」的预防针
    expect(quit).toBeGreaterThan(notify);
    expect(tombstone).toBeGreaterThan(quit);
    const gate = fn.slice(spaceGate, notify);
    expect(gate).toContain("if (!tmpSpace.enough)");
    expect(gate).toContain('setUpdateState({ phase: "available"');
    expect(gate).toContain("dialog.showErrorBox(");
    expect(gate).toContain("return;");
    // 手动装同样要这些空间：不把人送去发布页；拒绝时 app 必须继续活着
    expect(gate).not.toContain("RELEASE_LATEST_URL");
    expect(gate).not.toContain("quitting");
  });

  it("阈值单一来源：JS 常量与 NSIS define 对账；弹框读常量、不再各写一个「800MB」", () => {
    // 合并前评审小项：弹框里的 800MB 与 NSIS 的 FLOWSHIP_MIN_TEMP_FREE_MB 是两处硬编码，包体增长要靠人肉同步
    const nsis = Number(installer.match(/!define FLOWSHIP_MIN_TEMP_FREE_MB (\d+)/)?.[1] ?? Number.NaN);
    expect(MIN_TEMP_FREE_MB).toBe(nsis);
    expect(main).toContain("minTempFreeMB: MIN_TEMP_FREE_MB");
    expect(main).not.toMatch(/\b800\s*MB/i);
    expect(guard).not.toMatch(/\b800\s*MB/i);
  });

  it("ABORT 日志行与主进程解析器对账：用安装器源码里的真实模板渲染出日志行，findInstallerAbort 必须读回数字", () => {
    // 写入端（NSIS）与读取端（findInstallerAbort）各改各的最容易悄悄脱节：手写一行样例只能证明解析器自洽，
    // 这里从 installer.nsh 取 flowshipLog 的落盘模板和 ABORT 文案模板，渲染后喂给解析器。
    const fileWrite = macroBody("flowshipLog").match(/FileWrite \$R8 "([^"]*)"/)?.[1];
    const abortTpl = installer.match(/!insertmacro flowshipLog "(ABORT [^"]*)"/)?.[1];
    expect(fileWrite, "flowshipLog 里应有 FileWrite $R8 \"…\"").toBeDefined();
    expect(abortTpl, "customInit 里应有 ABORT 日志行").toBeDefined();
    const render = (tpl: string, vars: Record<string, string>): string =>
      tpl
        .replace(/\$\\r/g, "\r")
        .replace(/\$\\n/g, "\n")
        .replace(/\$\{(\w+)\}|\$(\w+)/g, (_m, a: string | undefined, b: string | undefined) => {
          const name = (a ?? b) as string;
          return name in vars ? vars[name] : `<<未绑定 ${name}>>`;
        });
    const msg = render(abortTpl as string, {
      VERSION: "1.9.31",
      "2": "512",
      FLOWSHIP_MIN_TEMP_FREE_MB: String(MIN_TEMP_FREE_MB),
    });
    const line = render(fileWrite as string, { R7: "1760000000", MSG: msg });
    expect(line).not.toContain("<<未绑定");
    expect(findInstallerAbort(line, "1.9.31")).toEqual({ freeMB: 512, minMB: MIN_TEMP_FREE_MB });
  });

  it("墓碑弹框读 installer.log 找预检拦截记录；文案由 buildUpdateFailedMessage 决定，只在 offerReleasePage 时才开发布页", () => {
    const start = main.indexOf('} else if (outcome === "failed") {');
    expect(start).toBeGreaterThanOrEqual(0);
    const end = main.indexOf("墓碑核销异常", start);
    expect(end).toBeGreaterThan(start);
    const block = main.slice(start, end);
    const read = block.indexOf('"installer.log"');
    const build = block.indexOf("buildUpdateFailedMessage({");
    const find = block.indexOf("findInstallerAbort(installerLogText, want)");
    const show = block.indexOf("dialog.showErrorBox(failedMsg.title, failedMsg.body)");
    const open = block.indexOf("if (failedMsg.offerReleasePage) void shell.openExternal(RELEASE_LATEST_URL)");
    for (const [name, i] of Object.entries({ read, build, find, show, open })) {
      expect(i, `墓碑弹框缺少 ${name}`).toBeGreaterThanOrEqual(0);
    }
    // 先读日志 → 把解析结果作为 abort 实参传给文案构造 → 弹框 → 按 offerReleasePage 决定是否开发布页
    expect(build).toBeGreaterThan(read);
    expect(find).toBeGreaterThan(build);
    expect(find).toBeLessThan(block.indexOf("});", build));
    expect(show).toBeGreaterThan(find);
    expect(open).toBeGreaterThan(show);
    // 不能再无条件开发布页（有 ABORT 时让人去手动装 = 往同样缺空间的路上送）
    expect(block.match(/openExternal\(RELEASE_LATEST_URL\)/g)).toHaveLength(1);
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

describe("Windows 更新包 manifest 验签接线（R9-01、fail-closed）", () => {
  // installWinUpdate 的函数体：从声明到 quitAndInstall
  const installStart = main.indexOf("const installWinUpdate = async");
  const installEnd = main.indexOf("winAutoUpdater.quitAndInstall(true, true)");
  const installFn = main.slice(installStart, installEnd);
  // update-downloaded 事件处理器：到下一个 error 监听之前
  const evStart = main.indexOf('winAutoUpdater.on("update-downloaded"');
  const evEnd = main.indexOf('winAutoUpdater.on("error"', evStart);
  const evHandler = main.slice(evStart, evEnd);
  // 统一拒绝处置函数
  const rejStart = main.indexOf("const rejectUnverifiedWinUpdate = async");
  const rejFn = main.slice(rejStart, main.indexOf("\n};", rejStart));

  it("installWinUpdate：安装前验签，位于门禁之后、置 quitting / 通知 / 墓碑 / quitAndInstall 之前", () => {
    expect(installStart).toBeGreaterThanOrEqual(0);
    expect(installEnd).toBeGreaterThan(installStart);
    const markerGate = installFn.indexOf("hasSilentUpdateMarker(exeDir");
    const verify = installFn.indexOf("await verifyWinPendingInstaller(pendingInstaller)");
    const spaceGate = installFn.indexOf("checkUpdateTempSpace(os.tmpdir(), statfsSync)");
    const notify = installFn.indexOf("new Notification(");
    const quit = installFn.search(/^\s*quitting = true;/m);
    const tombstone = installFn.indexOf("WIN_UPDATE_ATTEMPT_FILE");
    for (const [name, i] of Object.entries({ markerGate, verify, spaceGate, notify, quit, tombstone })) {
      expect(i, `installWinUpdate 缺少 ${name}`).toBeGreaterThanOrEqual(0);
    }
    expect(verify).toBeGreaterThan(markerGate);
    expect(verify).toBeLessThan(spaceGate);
    expect(verify).toBeLessThan(notify);
    expect(verify).toBeLessThan(quit);
    expect(verify).toBeLessThan(tombstone);
  });

  it("installWinUpdate：验签失败 = 统一拒绝处置后 return，不置 quitting、不进 quitAndInstall", () => {
    const verify = installFn.indexOf("await verifyWinPendingInstaller(pendingInstaller)");
    const spaceGate = installFn.indexOf("checkUpdateTempSpace(os.tmpdir(), statfsSync)");
    // 验签门禁本体：从验签调用到下一道门禁（磁盘空间预检）之前
    const rejectBranch = installFn.slice(verify, spaceGate);
    expect(rejectBranch).toContain("} catch (err) {");
    expect(rejectBranch).toContain("await rejectUnverifiedWinUpdate({");
    expect(rejectBranch).toMatch(/return;\s*\}/);
    // 拒绝分支里不能出现置位语句（注释提到不算）
    expect(rejectBranch).not.toMatch(/^\s*quitting = true;/m);
    expect(rejectBranch).not.toContain("quitAndInstall");
    // installWinUpdate 自己不再弹框 / 开页（统一收口在 rejectUnverifiedWinUpdate、避免连弹两次）
    expect(rejectBranch).not.toContain("dialog.showErrorBox");
    expect(rejectBranch).not.toContain("openExternal");
  });

  it("rejectUnverifiedWinUpdate：删缓存 exe → 回 available 带错误 → 弹一次框 + 开发布页；永不置 quitting", () => {
    expect(rejStart).toBeGreaterThanOrEqual(0);
    const rm = rejFn.indexOf("await fs.rm(file, { force: true })");
    const state = rejFn.indexOf('setUpdateState({ phase: "available"');
    const box = rejFn.indexOf("dialog.showErrorBox(");
    const open = rejFn.indexOf("void shell.openExternal(RELEASE_LATEST_URL)");
    for (const [name, i] of Object.entries({ rm, state, box, open })) {
      expect(i, `rejectUnverifiedWinUpdate 缺少 ${name}`).toBeGreaterThanOrEqual(0);
    }
    expect(rm).toBeLessThan(state);
    expect(state).toBeLessThan(box);
    expect(box).toBeLessThan(open);
    expect(rejFn.match(/dialog\.showErrorBox\(/g)).toHaveLength(1);
    expect(rejFn).toContain("winPendingInstaller = null");
    expect(rejFn).not.toMatch(/^\s*quitting = true;/m);
    // R6-5：error 文案取纯函数 buildVerifyRejectionNotice 的 stateError（= reason；mac 的 downloadAndStageMacUpdate 同一来源）
    expect(rejFn).toContain("error: notice.stateError");
  });

  it("update-downloaded：先验签再置 ready；验签期间保持 downloading；失败回 available 不进 ready", () => {
    // M3-05：「验签 → 通过则置 ready」抽成 verifyAndMarkWinReady，update-downloaded 事件与点徽标重验共用，
    // 约束不变、只是挪了位置：事件里只负责置 downloading「忙」态并交给共用函数，ready 只能出现在共用函数的验签成功之后
    expect(evStart).toBeGreaterThanOrEqual(0);
    expect(evEnd).toBeGreaterThan(evStart);
    const hold = evHandler.indexOf('setUpdateState({ phase: "downloading"');
    const mark = evHandler.indexOf("verifyAndMarkWinReady({");
    for (const [name, i] of Object.entries({ hold, mark })) {
      expect(i, `update-downloaded 缺少 ${name}`).toBeGreaterThanOrEqual(0);
    }
    expect(hold).toBeLessThan(mark);
    // 事件处理自己既不能验签也不能置 ready（绕过共用函数 = 绕过 fail-closed 次序）
    expect(evHandler).not.toContain("verifyWinPendingInstaller(");
    expect(evHandler).not.toContain('phase: "ready"');

    const markStart = main.indexOf("const verifyAndMarkWinReady = async");
    expect(markStart).toBeGreaterThanOrEqual(0);
    const markFn = main.slice(markStart, main.indexOf("\n};", markStart));
    const verify = markFn.indexOf("await verifyWinPendingInstaller(pending)");
    const reject = markFn.indexOf("await rejectUnverifiedWinUpdate({");
    const ready = markFn.indexOf('setUpdateState({ phase: "ready"');
    for (const [name, i] of Object.entries({ verify, reject, ready })) {
      expect(i, `verifyAndMarkWinReady 缺少 ${name}`).toBeGreaterThanOrEqual(0);
    }
    expect(verify).toBeLessThan(ready);
    // 失败分支在置 ready 之前就 return 了：ready 只出现这一次、且只在验签成功之后
    expect(reject).toBeLessThan(ready);
    expect(markFn.slice(reject, ready)).toContain("return false;");
    expect(markFn.match(/phase: "ready"/g)).toHaveLength(1);
    // 只在没被别处改动时置 ready（验签期间被 error 事件打回 available 就别凭空冒出 ready）
    expect(markFn).toContain('if (updateState.phase === "downloading") {');
    // 共用函数里不能无条件置 ready
    expect(markFn.slice(0, verify)).not.toContain('phase: "ready"');
  });

  it("manifest 查找键取自 latest.yml（pickWinInstallerAssetName），不取 downloadedFile 的本地文件名", () => {
    expect(evHandler).toContain("assetName: pickWinInstallerAssetName(info)");
    expect(evHandler).not.toMatch(/basename\(\s*info/);
    expect(evHandler).toContain("file: info?.downloadedFile");
    // 版本号不可信：必须三段数字才会被拿去拼 manifest URL。
    // F1-02：门禁本体（file / assetName → 版本号 → 库登记交叉校验 → 验签）已抽到 win-pending-verify.mjs，
    // 行为由 update-manifest-win-pending.test.ts 真调用覆盖；这里只守「壳里仍委托给它、并把验签实现注入进去」
    // + 模块里的关键字面没被删（grep 只是补充，不再是唯一的保障）
    const verifyFn = main.slice(
      main.indexOf("const verifyWinPendingInstaller = async"),
      main.indexOf("const rejectUnverifiedWinUpdate = async"),
    );
    expect(main).toContain('from "./win-pending-verify.mjs"');
    expect(verifyFn).toContain("await verifyWinPendingInstallerWith(pending, {");
    expect(verifyFn).toContain("verifyDownloadedUpdate,");
    expect(verifyFn).toContain("sameWinPath,");
    expect(verifyFn).toContain("winAutoUpdater?.downloadedUpdateHelper?.file");
    const gate = read("electron-app/win-pending-verify.mjs");
    expect(gate).toContain("/^\\d+\\.\\d+\\.\\d+$/");
    expect(gate).toContain("await verifyDownloadedUpdate(pending.version, pending.file, pending.assetName)");
  });

  it("installUpdateNow：等事件里的验签出结果、验签失败（phase ≠ ready）不再进安装；安装 await 持锁防双击并发", () => {
    const start = main.indexOf("const installUpdateNow = async");
    const end = main.indexOf("const fetchLatestVersion = async");
    const fn = main.slice(start, end);
    const reset = fn.indexOf("winDownloadedVerifyTask = null;");
    const download = fn.indexOf("await updater.downloadUpdate()");
    const waitVerify = fn.indexOf("await winDownloadedVerifyTask;");
    const notReady = fn.indexOf('if (updateState.phase !== "ready") {');
    const install = fn.indexOf("await runInstallWinUpdate(updateReadyVersion);", notReady);
    for (const [name, i] of Object.entries({ reset, download, waitVerify, notReady, install })) {
      expect(i, `installUpdateNow 缺少 ${name}`).toBeGreaterThanOrEqual(0);
    }
    expect(reset).toBeLessThan(download);
    expect(download).toBeLessThan(waitVerify);
    expect(waitVerify).toBeLessThan(notReady);
    expect(notReady).toBeLessThan(install);
    // ready 态直接装的分支也是 await（持有 installInFlight 锁）、没有 fire-and-forget 的 installWinUpdate 调用
    expect(fn.match(/await runInstallWinUpdate\(updateReadyVersion\)/g)).toHaveLength(2);
    expect(fn).not.toMatch(/^\s*installWinUpdate\(/m);
    // 保留原有「下载中 / 安装中忽略」
    expect(fn).toContain('updateState.phase === "downloading" || updateState.phase === "installing"');
  });

  it("兼容性在注释里写清：旧壳不验签行为不变；新壳对缺 manifest / 缺 exe 条目一律拒绝", () => {
    const note = main.slice(
      main.indexOf("// ---------- Windows 更新包验签（R9-01"),
      main.indexOf("let winPendingInstaller"),
    );
    expect(note).toContain("旧壳");
    expect(note).toContain("行为不变");
    expect(note).toContain("没有 manifest / manifest 里没有 exe 条目");
    expect(note).toContain("一律拒绝自动安装");
  });
});
