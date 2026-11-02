/**
 * open-path 的可执行扩展名黑名单补齐（server 安全审计）
 *
 * 黑名单是「ShellExecute / LaunchServices 会当成执行」的扩展名；命中的文件降级为「在文件管理器中显示」、绝不运行。
 * 补的是原先缺的：
 * - Windows：脚本语言关联（py / pyw / pl / rb / php …）、PowerShell 旧扩展（psc1 / ps2 …）、chm / rdp / jnlp / xbap …
 * - macOS：dmg / mobileconfig / applescript / service / wflow / shortcut
 * 第 2 轮复审再补：
 * - Windows：启用宏的 Office（docm / xlsm / pptm …）、theme 系、iso / vhd / vhdx、iqy / slk、sh / bash（仅 Windows 侧）
 * - macOS：plugin / bundle / xpc
 * 第 4 轮再补：macOS 其它磁盘映像 iso / cdr / sparseimage / sparsebundle / img / smi（与 dmg 同由 DiskImageMounter 打开 = 挂载）
 * - Linux 上 .sh 不进黑名单（用户常想打开看内容），macOS 的 sh / bash 本来就在
 * 已有的（ps1xml / hta / wsf / msc / cpl / scf / url / lnk / reg / jar；pkg / app / command / terminal / workflow / webloc）
 * 一并钉住，防止以后被顺手删掉。大小写不敏感；双扩展名（`a.pdf.exe`）以最后一个为准。
 */
import { describe, expect, it } from "vitest";

import { buildOpenPathPlan } from "../src/lib/local-file-os";

const WIN_NEW = [
  "py", "pyw", "pyc", "pyz", "pyzw", "pl", "rb", "php", "ahk",
  "chm", "rdp", "xbap", "jnlp", "shs", "shb", "wsc",
  "psc1", "psc2", "ps2", "ps2xml", "msh", "msh1", "msh2", "mshxml", "msh1xml", "msh2xml",
  "ade", "adp", "mde",
  // 第 2 轮
  "docm", "xlsm", "pptm", "dotm", "xltm", "potm", "ppam", "xlam", "sldm", "iqy", "slk",
  "theme", "themepack", "deskthemepack", "iso", "vhd", "vhdx", "sh", "bash",
];
const WIN_EXISTING = [
  "exe", "bat", "cmd", "com", "scr", "pif", "lnk", "url", "hta", "msi", "ps1", "ps1xml", "vbs", "js",
  "wsf", "reg", "jar", "cpl", "msc", "scf", "inf", "dll",
];
const MAC_NEW = [
  "dmg", "mobileconfig", "applescript", "service", "wflow", "shortcut", "plugin", "bundle", "xpc",
  // 第 4 轮：磁盘映像
  "iso", "cdr", "sparseimage", "sparsebundle", "img", "smi",
];
const MAC_EXISTING = [
  "app", "command", "terminal", "workflow", "pkg", "mpkg", "webloc", "inetloc", "fileloc", "sh", "scpt", "jar",
];

describe("Windows：可执行 / 脚本 / 快捷方式扩展名一律降级为 reveal", () => {
  it.each([...WIN_NEW, ...WIN_EXISTING])(".%s → reveal（不 open）", (ext) => {
    const plan = buildOpenPathPlan(`C:\\Users\\me\\Downloads\\file.${ext}`, "win32");
    expect(plan.kind).toBe("reveal");
    if (plan.kind === "reveal") {
      expect(plan.spec.command).toBe("explorer.exe");
      expect(plan.notice).toContain(`.${ext}`);
    }
  });

  it("大小写不敏感：.PY / .Rdp / .ChM / .DOCM / .Xlsm / .ISO / .VHDX / .Theme / .SH", () => {
    for (const name of ["a.PY", "b.Rdp", "c.ChM", "d.PHP", "e.PsC1", "f.DOCM", "g.Xlsm", "h.PPTM", "i.ISO", "j.VhDx", "k.Theme", "l.IQY", "m.SLK", "n.SH", "o.Bash"]) {
      expect(buildOpenPathPlan(`C:\\x\\${name}`, "win32").kind, name).toBe("reveal");
    }
  });

  it("双扩展名以最后一个为准：a.pdf.exe / a.txt.py / a.docx.chm → reveal；a.py.pdf → 正常 open", () => {
    expect(buildOpenPathPlan("C:\\x\\a.pdf.exe", "win32").kind).toBe("reveal");
    expect(buildOpenPathPlan("C:\\x\\a.txt.py", "win32").kind).toBe("reveal");
    expect(buildOpenPathPlan("C:\\x\\a.docx.chm", "win32").kind).toBe("reveal");
    // 第 2 轮新增扩展名的双扩展名：迷惑性文档名 + 宏 / 映像 / 脚本后缀
    for (const name of ["report.pdf.docm", "budget.xlsx.xlsm", "deck.pptx.pptm", "photo.jpg.iso", "disk.img.vhdx", "run.txt.sh", "x.md.theme"]) {
      expect(buildOpenPathPlan(`C:\\x\\${name}`, "win32").kind, name).toBe("reveal");
    }
    for (const name of ["a.docm.pdf", "b.iso.txt", "c.sh.md", "d.theme.png"]) {
      expect(buildOpenPathPlan(`C:\\x\\${name}`, "win32").kind, name).toBe("open");
    }
    expect(buildOpenPathPlan("C:\\x\\a.py.pdf", "win32").kind).toBe("open");
    expect(buildOpenPathPlan("C:\\x\\readme.rdp.txt", "win32").kind).toBe("open");
  });

  it("尾部空格 / 点 / ::$DATA 技巧对新增扩展名同样生效", () => {
    for (const name of ["a.py. ", "b.rdp  ", "c.chm::$DATA", "d.php:stream", "e.docm. ", "f.iso::$DATA", "g.sh "]) {
      expect(buildOpenPathPlan(`C:\\x\\${name}`, "win32").kind, name).toBe("reveal");
    }
  });

  it("不误伤：文档 / 图片 / 代码文本类照常 open", () => {
    for (const name of ["a.pdf", "b.md", "c.txt", "d.png", "e.ts", "f.json", "g.docx", "pyproject.toml", "py", "h.xlsx", "i.pptx", "j.dotx", "k.img", "l.shtml", "m.vhdx.md", "isolate.txt", "docm"]) {
      expect(buildOpenPathPlan(`C:\\x\\${name}`, "win32").kind, name).toBe("open");
    }
  });
});

describe("macOS：dmg / mobileconfig 等降级为 reveal", () => {
  it.each([...MAC_NEW, ...MAC_EXISTING])(".%s → reveal（open -R）", (ext) => {
    const plan = buildOpenPathPlan(`/Users/me/Downloads/file.${ext}`, "darwin");
    expect(plan.kind).toBe("reveal");
    if (plan.kind === "reveal") {
      expect(plan.spec).toEqual({
        command: "open",
        args: ["-R", `/Users/me/Downloads/file.${ext}`],
      });
    }
  });

  it("大小写不敏感 + 双扩展名：Setup.DMG / a.pdf.dmg / Profile.MobileConfig → reveal；a.dmg.pdf → open", () => {
    expect(buildOpenPathPlan("/x/Setup.DMG", "darwin").kind).toBe("reveal");
    expect(buildOpenPathPlan("/x/a.pdf.dmg", "darwin").kind).toBe("reveal");
    expect(buildOpenPathPlan("/x/Profile.MobileConfig", "darwin").kind).toBe("reveal");
    expect(buildOpenPathPlan("/x/a.dmg.pdf", "darwin").kind).toBe("open");
  });

  it("plugin / bundle / xpc：大小写不敏感 + 双扩展名；a.bundle.txt → open", () => {
    expect(buildOpenPathPlan("/x/Foo.PLUGIN", "darwin").kind).toBe("reveal");
    expect(buildOpenPathPlan("/x/a.pdf.bundle", "darwin").kind).toBe("reveal");
    expect(buildOpenPathPlan("/x/svc.XPC", "darwin").kind).toBe("reveal");
    expect(buildOpenPathPlan("/x/a.bundle.txt", "darwin").kind).toBe("open");
    expect(buildOpenPathPlan("/x/plugin", "darwin").kind).toBe("open"); // 无扩展名的文件名
  });

  it("磁盘映像：大小写不敏感 + 双扩展名 + 无扩展名不误伤（Ubuntu.ISO / backup.SparseImage / a.pdf.cdr / x.sparsebundle → reveal）", () => {
    for (const name of ["Ubuntu.ISO", "backup.SparseImage", "a.pdf.cdr", "x.sparsebundle", "Vault.SPARSEBUNDLE", "disk.Img", "setup.SMI"]) {
      expect(buildOpenPathPlan(`/x/${name}`, "darwin").kind, name).toBe("reveal");
    }
    // 迷惑性双扩展名：最后一个才算
    for (const name of ["a.iso.txt", "b.cdr.md", "c.sparseimage.png", "d.img.pdf"]) {
      expect(buildOpenPathPlan(`/x/${name}`, "darwin").kind, name).toBe("open");
    }
    // 没有扩展名 / 只是名字里带这些词
    for (const name of ["iso", "cdr", "isolate.txt", "image.png", "sparse-notes.md", "imgur-links.txt", "smile.png"]) {
      expect(buildOpenPathPlan(`/x/${name}`, "darwin").kind, name).toBe("open");
    }
  });

  it("磁盘映像在目录里的位置不影响判定；降级成 open -R（只在 Finder 里显示）", () => {
    const plan = buildOpenPathPlan("/Users/me/Downloads/macOS Installer.iso", "darwin");
    expect(plan.kind).toBe("reveal");
    if (plan.kind === "reveal") {
      expect(plan.spec).toEqual({ command: "open", args: ["-R", "/Users/me/Downloads/macOS Installer.iso"] });
    }
  });

  it("不误伤：普通文档照常 open", () => {
    for (const name of ["a.pdf", "b.md", "c.png", "d.txt", "e.docm", "g.theme", "h.vhdx"]) {
      // docm / theme / vhdx 是 Windows 侧的黑名单，macOS 上不动（iso 现在 macOS 也拦，见上）
      expect(buildOpenPathPlan(`/x/${name}`, "darwin").kind, name).toBe("open");
    }
  });
});

describe("Linux：本轮不新增（.sh 常被用户想打开看内容）", () => {
  it(".sh / .docm / .iso 仍正常 open；原有 desktop / appimage 仍 reveal", () => {
    for (const name of ["a.sh", "b.docm", "c.iso", "d.plugin"]) {
      expect(buildOpenPathPlan(`/home/me/${name}`, "linux").kind, name).toBe("open");
    }
    for (const name of ["a.desktop", "b.AppImage", "c.run"]) {
      expect(buildOpenPathPlan(`/home/me/${name}`, "linux").kind, name).toBe("reveal");
    }
  });
});
