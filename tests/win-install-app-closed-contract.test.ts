/**
 * 「安装前确认 App 已退出」（flowshipEnsureAppClosed / flowshipAppRunningProbe）的契约。
 * 行为：有界面的手动安装，用户点「安装」那一刻先查 Flowship.exe 在不在跑（不管是有窗口的真没退、
 * 还是没有窗口的隐形孤儿 server）；没有 → 不提示；有 → 弹框说明「安装需要先退出」，点「确定」才杀并等它退出，
 * 点「取消」退出安装、什么都没动。
 * 说明：NSIS 断言是字符串级契约——能防回退 / 防顺序写反 / 防「没问就杀」，不能证明 Windows 上的运行时行为；
 * 运行时以 installer.log 里的 `appclose` 行为准（step=prompt / declined / stuck / aborted / done）。
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

/** 去掉整行注释后的 NSIS 代码（注释里提到的 taskkill 等字样不算）。 */
const nsisCode = (body: string): string =>
  body
    .split("\n")
    .filter((line) => !/^\s*;/.test(line))
    .join("\n");

// 官方模板目录：CI 找不到直接 throw；本地找不到则下面对账用例显式 skip（不再静默 return）
const templateDir = findAppBuilderTemplateDir();

describe("flowshipAppRunningProbe：怎么判断「在不在跑」", () => {
  const body = nsisCode(macroBody("flowshipAppRunningProbe"));

  it("按镜像名精确匹配 Flowship.exe（findstr 锚定行首的带引号 CSV 首列）；不会误中 Uninstall Flowship.exe", () => {
    expect(body).toContain(
      'nsExec::Exec `"$SYSDIR\\cmd.exe" /C tasklist /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" /FO CSV /NH | "$SYSDIR\\findstr.exe" /B /I /C:"\\"${APP_EXECUTABLE_FILENAME}\\""`',
    );
  });

  it("不加 USERNAME 过滤（只写 %USERNAME% 可能永远匹配不到 → 查漏 = 该问的不问）", () => {
    expect(body).not.toContain("USERNAME");
  });

  it("退出码映射：0（findstr 找到）= 在跑 → 1；1（没找到）= 不在 → 0；其它（cmd / tasklist 起不来）= ? 没法确认", () => {
    expect(body).toMatch(
      /Pop \$0\n\s*\$\{if\} \$0 == "0"\n\s*StrCpy \$0 "1"\n\s*\$\{elseIf\} \$0 == "1"\n\s*StrCpy \$0 "0"\n\s*\$\{else\}\n\s*StrCpy \$0 "\?"\n\s*\$\{endIf\}/,
    );
  });

  it.skipIf(!templateDir)("对账官方 FIND_PROCESS 的 tasklist 分支：命令形态仍在（官方用的过滤写法见注释里为什么不照搬；找不到 electron-builder 官方 NSIS 模板时本地 skip）", () => {
    const util = readFileSync(path.join(templateDir!, "include", "allowOnlyOneInstallerInstance.nsh"), "utf8");
    expect(util).toContain("tasklist");
    expect(util).toContain('findstr.exe" /B /I /C:');
  });
});

describe("flowshipEnsureAppClosed：先问、点确定才杀", () => {
  const body = nsisCode(macroBody("flowshipEnsureAppClosed"));

  it("自带 Push/Pop $0-$2；$1 = 是否已问过，入口置 0", () => {
    expect(body.match(/^\s*Push \$\d$/gm)?.map((s) => s.trim())).toEqual(["Push $0", "Push $1", "Push $2"]);
    expect(body.trimEnd().endsWith("Pop $2\n  Pop $1\n  Pop $0")).toBe(true);
    expect(body.indexOf('StrCpy $1 "0"')).toBeLessThan(body.indexOf("flowshipAppCloseCheck:"));
  });

  it("没在跑（$0 != 1）直接去收尾；在跑才分「第一次问」/「杀完还在」两条路", () => {
    expect(body).toMatch(
      /flowshipAppCloseCheck:\n\s*!insertmacro flowshipAppRunningProbe\n\s*StrCmp \$0 "1" 0 flowshipAppCloseDone\n\s*StrCmp \$1 "0" flowshipAppCloseAsk flowshipAppCloseRetryAsk/,
    );
  });

  it("第一次：弹「确定 / 取消」框；只有点确定才跳到杀进程，取消 = 写日志 + Quit（什么都没杀）", () => {
    const ask = body.indexOf("flowshipAppCloseAsk:");
    const box = body.indexOf("MessageBox MB_OKCANCEL", ask);
    expect(ask).toBeGreaterThanOrEqual(0);
    expect(box).toBeGreaterThan(ask);
    const boxLine = body.slice(box, body.indexOf("\n", box));
    expect(boxLine).toMatch(/\/SD IDOK IDOK flowshipAppCloseKill$/);
    // 弹框文案要让人明白：为什么要退、点确定会发生什么、取消会发生什么
    expect(boxLine).toContain("安装前需要先退出");
    expect(boxLine).toContain("点「确定」将关闭");
    expect(boxLine).toContain("点「取消」退出安装");
    expect(boxLine).toContain("任务数据保存在磁盘上、不会丢失");
    // 弹框之后紧跟的就是「取消」分支：记日志 + Quit
    const after = body.slice(body.indexOf("\n", box));
    expect(after).toMatch(/^\n\s*!insertmacro flowshipLog "appclose v\$\{VERSION\} step=declined"\n\s*Quit\n/);
  });

  it("杀进程只能经由「点确定」或「重试」两个跳转到达：杀进程标签紧跟在 Quit 之后（不会顺序落进去）", () => {
    expect(body).toMatch(/Quit\n\s*flowshipAppCloseRetryAsk:/);
    expect(body).toMatch(/Quit\n\s*flowshipAppCloseKill:/);
    // 整个宏里只有一处 taskkill、且在 Kill 标签之后
    expect(body.match(/taskkill/g)).toHaveLength(1);
    expect(body.indexOf("taskkill")).toBeGreaterThan(body.indexOf("flowshipAppCloseKill:"));
    // 在弹框之前绝不杀
    expect(body.indexOf("taskkill")).toBeGreaterThan(body.indexOf("MessageBox MB_OKCANCEL"));
  });

  it("杀的方式与之前手动安装一致：taskkill /F /T /IM（整棵树，清隐形孤儿 server）", () => {
    expect(body).toContain(`nsExec::Exec 'taskkill /F /T /IM "\${APP_EXECUTABLE_FILENAME}"'`);
  });

  it("杀完等它真退出：每 500ms 复查、最多 10 轮（≈5s）；不再在跑 / 超时都回到复查点", () => {
    expect(body).toMatch(
      /flowshipAppCloseWait:\n\s*Sleep 500\n\s*!insertmacro flowshipAppRunningProbe\n\s*StrCmp \$0 "1" 0 flowshipAppCloseCheck\n\s*IntOp \$2 \$2 \+ 1\n\s*IntCmp \$2 10 flowshipAppCloseCheck flowshipAppCloseWait flowshipAppCloseCheck/,
    );
    expect(body.indexOf("StrCpy $2 0")).toBeGreaterThan(body.indexOf("flowshipAppCloseKill:"));
    expect(body.indexOf("StrCpy $2 0")).toBeLessThan(body.indexOf("flowshipAppCloseWait:"));
  });

  it("杀完还在：弹「中止 / 重试 / 忽略」——重试再杀一轮；忽略继续安装（多用户同机的口子）；中止 = 写日志 + Quit", () => {
    const stuck = body.indexOf("flowshipAppCloseRetryAsk:");
    const box = body.indexOf("MessageBox MB_ABORTRETRYIGNORE", stuck);
    expect(box).toBeGreaterThan(stuck);
    const boxLine = body.slice(box, body.indexOf("\n", box));
    expect(boxLine).toMatch(/\/SD IDIGNORE IDRETRY flowshipAppCloseKill IDIGNORE flowshipAppCloseDone$/);
    expect(boxLine).toContain("无法关闭");
    expect(boxLine).toContain("管理员身份");
    const after = body.slice(body.indexOf("\n", box));
    expect(after).toMatch(/^\n\s*!insertmacro flowshipLog "appclose v\$\{VERSION\} step=aborted"\n\s*Quit\n/);
  });

  it("日志只在弹过框时写（没问过 = 正常安装，不加噪音）：prompt / declined / stuck / aborted / done，全是 ASCII，不带路径", () => {
    const logs = body.match(/flowshipLog "[^"\n]*"/g) ?? [];
    expect(logs).toEqual([
      'flowshipLog "appclose v${VERSION} step=prompt"',
      'flowshipLog "appclose v${VERSION} step=declined"',
      'flowshipLog "appclose v${VERSION} step=stuck"',
      'flowshipLog "appclose v${VERSION} step=aborted"',
      'flowshipLog "appclose v${VERSION} step=done running=$0"',
    ]);
    expect(body).toMatch(/flowshipAppCloseDone:\n\s*StrCmp \$1 "1" 0 flowshipAppCloseEnd\n\s*!insertmacro flowshipLog "appclose v\$\{VERSION\} step=done running=\$0"\n\s*flowshipAppCloseEnd:\n\s*Pop \$2/);
  });

  it("所有跳转标签都有定义、且每个标签只定义一次（宏只展开一处 → 不会重复定义）", () => {
    const labels = [...body.matchAll(/^\s*(flowshipAppClose\w+):/gm)].map((m) => m[1]);
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels.sort()).toEqual([
      "flowshipAppCloseAsk",
      "flowshipAppCloseCheck",
      "flowshipAppCloseDone",
      "flowshipAppCloseEnd",
      "flowshipAppCloseKill",
      "flowshipAppCloseRetryAsk",
      "flowshipAppCloseWait",
    ]);
    const used = new Set([...body.matchAll(/\b(flowshipAppClose\w+)\b(?!:)/g)].map((m) => m[1]));
    for (const l of labels) expect(used.has(l), `${l} 应被跳转引用`).toBe(true);
    for (const u of used) expect(labels.includes(u), `${u} 应有定义`).toBe(true);
  });
});

describe("接线：只在有界面的手动安装、点「安装」那一刻", () => {
  it("全文件只在 begin 页里展开一次（固定标签 → 展开两次编译就红）", () => {
    const all = nsisCode(installer).match(/!insertmacro flowshipEnsureAppClosed/g) ?? [];
    expect(all).toHaveLength(1);
    expect(nsisCode(macroBody("customPageAfterChangeDir"))).toContain("!insertmacro flowshipEnsureAppClosed");
  });

  it("begin 页里：入栈之后、begin 计时之前，且早于文件系统实测 / TEMP 重定向 / 旧安装自愈（先确认 App 退出再动别的）", () => {
    const page = nsisCode(macroBody("customPageAfterChangeDir"));
    const call = page.indexOf("!insertmacro flowshipEnsureAppClosed");
    expect(call).toBeGreaterThan(page.indexOf("Push $2"));
    expect(call).toBeLessThan(page.indexOf("GetTickCount()i.r0"));
    expect(call).toBeLessThan(page.indexOf('!insertmacro flowshipLog "begin v'));
    expect(call).toBeLessThan(page.indexOf("!insertmacro flowshipFsProbe"));
    expect(call).toBeLessThan(page.indexOf("!insertmacro flowshipTmpRedirect"));
    expect(call).toBeLessThan(page.indexOf("!insertmacro flowshipForceCleanOld"));
  });

  it("customInit：有界面的手动安装不再提前杀进程；只有无界面（/S）的手动安装才直接杀；更新路径仍然不杀", () => {
    const init = nsisCode(macroBody("customInit"));
    const updated = init.indexOf("${if} ${isUpdated}");
    const elseIdx = init.indexOf("${else}", updated);
    const kill = init.indexOf("nsExec::Exec 'taskkill");
    expect(updated).toBeGreaterThanOrEqual(0);
    expect(kill).toBeGreaterThan(elseIdx);
    // 整个 customInit 只有一处真正执行 taskkill（DetailPrint 文案里提到的不算），且被 ${if} ${Silent} 直接包着
    expect(init.match(/nsExec::Exec 'taskkill/g)).toHaveLength(1);
    expect(init.slice(elseIdx, kill)).toMatch(/\$\{else\}\n\s*\$\{if\} \$\{Silent\}\n\s*$/);
    // 更新分支里不执行 taskkill
    expect(init.slice(updated, elseIdx)).not.toContain("nsExec::Exec 'taskkill");
  });

  it("customInit 里没有任何弹框式杀进程（用户还没点「安装」，不能碰他正在用的 App）", () => {
    const init = nsisCode(macroBody("customInit"));
    expect(init).not.toContain("flowshipEnsureAppClosed");
    expect(init).not.toContain("flowshipAppRunningProbe");
  });
});
