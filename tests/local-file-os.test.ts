import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildOpenPathPlan,
  buildOpenUrlSpec,
  buildRevealInFolderSpec,
  isWindowsUncPath,
  toWindowsExplorerPath,
} from "@/lib/local-file-os";

describe("toWindowsExplorerPath", () => {
  it("把正斜杠换成反斜杠（避免 explorer 把 / 当 switch）", () => {
    expect(
      toWindowsExplorerPath(
        "D:/repositories/git/wukong/cp-notification/wk-doc/repo-design.md",
      ),
    ).toBe(
      "D:\\repositories\\git\\wukong\\cp-notification\\wk-doc\\repo-design.md",
    );
  });

  it("已是反斜杠则保持不变", () => {
    expect(toWindowsExplorerPath("C:\\foo\\bar.txt")).toBe("C:\\foo\\bar.txt");
  });
});

describe("buildRevealInFolderSpec", () => {
  it("macOS 用 open -R", () => {
    expect(buildRevealInFolderSpec("/tmp/a.txt", "darwin")).toEqual({
      command: "open",
      args: ["-R", "/tmp/a.txt"],
    });
  });

  it("Windows 用 explorer /select，并规范化正斜杠路径", () => {
    expect(
      buildRevealInFolderSpec("D:/repositories/git/foo/bar.txt", "win32"),
    ).toEqual({
      command: "explorer.exe",
      args: ['/select,"D:\\repositories\\git\\foo\\bar.txt"'],
      ignoreNonZeroExit: true,
    });
  });

  it("Windows 反斜杠路径同样加引号", () => {
    expect(buildRevealInFolderSpec("C:\\foo\\bar.txt", "win32")).toEqual({
      command: "explorer.exe",
      args: ['/select,"C:\\foo\\bar.txt"'],
      ignoreNonZeroExit: true,
    });
  });
});

describe("buildOpenPathPlan：正常文件照常打开", () => {
  it("macOS 用 open", () => {
    expect(buildOpenPathPlan("/tmp/a.txt", "darwin")).toEqual({
      kind: "open",
      spec: { command: "open", args: ["/tmp/a.txt"] },
    });
  });

  it("Windows 用 rundll32 FileProtocolHandler（不经 cmd），并规范化正斜杠", () => {
    expect(buildOpenPathPlan("D:/foo/bar.txt", "win32")).toEqual({
      kind: "open",
      spec: {
        command: "rundll32.exe",
        args: ["url.dll,FileProtocolHandler", "D:\\foo\\bar.txt"],
      },
    });
  });

  it("Windows 路径含 cmd 元字符（& | ^ %）时原样作为单个 argv、不经 shell", () => {
    const plan = buildOpenPathPlan("D:/docs/A&B & calc | x ^ %PATH%.md", "win32");
    expect(plan.kind).toBe("open");
    if (plan.kind !== "open") return;
    expect(plan.spec.command).not.toMatch(/cmd/i);
    expect(plan.spec.args).not.toContain("/c");
    expect(plan.spec.args).toEqual([
      "url.dll,FileProtocolHandler",
      "D:\\docs\\A&B & calc | x ^ %PATH%.md",
    ]);
  });

  it("Linux 用 xdg-open", () => {
    expect(buildOpenPathPlan("/tmp/a.txt", "linux")).toEqual({
      kind: "open",
      spec: { command: "xdg-open", args: ["/tmp/a.txt"] },
    });
  });

  it("无扩展名 / 普通文档扩展名 / 目录都正常打开（含名字里带 .exe 但真实扩展名安全的）", () => {
    for (const p of [
      "C:\\work\\task-dir",
      "C:\\work\\notes.md",
      "C:\\work\\report.docx",
      "C:\\work\\readme.exe.txt",
      "C:\\work\\v1.2\\LICENSE",
    ]) {
      expect(buildOpenPathPlan(p, "win32").kind).toBe("open");
    }
    expect(buildOpenPathPlan("/Users/a/Docs/x.md", "darwin").kind).toBe("open");
    expect(buildOpenPathPlan("/Users/a/Docs/dir.d/x", "darwin").kind).toBe("open");
  });
});

describe("buildOpenPathPlan：危险类型降级为「在文件管理器中显示」、绝不执行", () => {
  const WIN_DANGEROUS = [
    "bat", "cmd", "lnk", "exe", "ps1", "vbs", "js", "msi", "scr", "com", "pif", "hta", "url", "reg", "jar",
  ];

  it.each(WIN_DANGEROUS)("Windows .%s 降级为 explorer /select", (ext) => {
    const p = `C:\\Users\\a\\evil.${ext}`;
    const plan = buildOpenPathPlan(p, "win32");
    expect(plan.kind).toBe("reveal");
    if (plan.kind !== "reveal") return;
    expect(plan.spec).toEqual(buildRevealInFolderSpec(p, "win32"));
    expect(plan.spec.command).toBe("explorer.exe");
    expect(plan.spec.command).not.toMatch(/rundll32/i);
    expect(plan.notice).toContain(`.${ext}`);
  });

  it("Windows 扩展名大小写不敏感", () => {
    for (const p of ["C:\\a\\EVIL.BAT", "C:\\a\\x.ExE", "C:/a/Run.Ps1"]) {
      expect(buildOpenPathPlan(p, "win32").kind).toBe("reveal");
    }
  });

  it("Windows 路径技巧：尾部空格 / 点、::$DATA、备用数据流、盘符相对、`\\.` 尾段、`..` 段", () => {
    for (const p of [
      "C:\\a\\evil.bat ",
      "C:\\a\\evil.bat.",
      "C:\\a\\evil.bat. . ",
      "C:\\a\\evil.exe::$DATA",
      "C:\\a\\evil.exe:Zone.Identifier",
      "C:evil.cmd",
      "C:\\a\\evil.exe\\.",
      "C:\\a\\evil.exe\\",
      "C:\\a\\b\\..\\evil.vbs",
      "C:\\a\\evil.lnk\\. ",
    ]) {
      expect(buildOpenPathPlan(p, "win32").kind, p).toBe("reveal");
    }
  });

  it("Windows UNC / 设备命名空间路径直接拒绝（不 open 也不 reveal），带可读错误", () => {
    for (const p of [
      "\\\\attacker\\share\\a.txt",
      "//attacker/share/a.txt",
      "\\/attacker/share/a.txt",
      "\\\\?\\UNC\\attacker\\share\\a.txt",
      "\\\\.\\C:\\a.txt",
      "\\\\attacker\\share\\evil.exe",
    ]) {
      const plan = buildOpenPathPlan(p, "win32");
      expect(plan.kind, p).toBe("reject");
      if (plan.kind === "reject") expect(plan.error).toMatch(/UNC|网络共享/);
    }
  });

  it("Windows 路径含双引号拒绝（防破坏 explorer /select 的单 argv）", () => {
    expect(buildOpenPathPlan('C:\\a" /e,\\\\host\\s\\x.txt', "win32").kind).toBe("reject");
  });

  it("isWindowsUncPath", () => {
    expect(isWindowsUncPath("\\\\h\\s")).toBe(true);
    expect(isWindowsUncPath("//h/s")).toBe(true);
    expect(isWindowsUncPath("C:\\h\\s")).toBe(false);
    expect(isWindowsUncPath("/tmp/a")).toBe(false);
  });

  it.each(["app", "command", "terminal", "workflow", "pkg"])(
    "macOS .%s 降级为 open -R",
    (ext) => {
      const p = `/Users/a/Downloads/Thing.${ext}`;
      const plan = buildOpenPathPlan(p, "darwin");
      expect(plan).toMatchObject({
        kind: "reveal",
        spec: { command: "open", args: ["-R", p] },
      });
    },
  );

  it("macOS：大小写不敏感、尾部斜杠、.app 包内部文件都不被 open", () => {
    expect(buildOpenPathPlan("/Applications/Foo.APP", "darwin").kind).toBe("reveal");
    expect(buildOpenPathPlan("/Applications/Foo.app/", "darwin").kind).toBe("reveal");
    expect(buildOpenPathPlan("/Applications/Foo.app/Contents/MacOS/Foo", "darwin").kind).toBe(
      "reveal",
    );
  });

  it("Linux .desktop / AppImage 降级为打开父目录（不执行文件本身）", () => {
    const plan = buildOpenPathPlan("/home/a/x/evil.desktop", "linux");
    expect(plan).toMatchObject({
      kind: "reveal",
      spec: { command: "xdg-open", args: ["/home/a/x"] },
    });
    expect(buildOpenPathPlan("/home/a/Tool.AppImage", "linux").kind).toBe("reveal");
  });

  it("posix 上 //host/share 只是普通路径、不按 UNC 拒绝", () => {
    expect(buildOpenPathPlan("//tmp/a.txt", "darwin").kind).toBe("open");
    expect(buildOpenPathPlan("//tmp/a.txt", "linux").kind).toBe("open");
  });
});

describe("buildOpenUrlSpec", () => {
  const feishuUrl =
    "https://accounts.feishu.cn/oauth/v1/device/verify?user_code=ABCD-1234&client_id=cli_x&state=a%26b";

  it("Windows：带 & 的 URL 原样进 rundll32 单个 argv、不经 cmd（不被 & 截断）", () => {
    const spec = buildOpenUrlSpec(feishuUrl, "win32");
    expect(spec).toEqual({
      command: "rundll32.exe",
      args: ["url.dll,FileProtocolHandler", feishuUrl],
    });
    // 完整保留 & 之后的 query
    expect(spec?.args[1]).toContain("&client_id=cli_x&state=a%26b");
    expect(spec?.command).not.toMatch(/cmd/i);
    expect(spec?.args).not.toContain("start");
  });

  it("macOS / Linux：open / xdg-open + 规范化后的 URL", () => {
    expect(buildOpenUrlSpec(feishuUrl, "darwin")).toEqual({
      command: "open",
      args: [feishuUrl],
    });
    expect(buildOpenUrlSpec(feishuUrl, "linux")).toEqual({
      command: "xdg-open",
      args: [feishuUrl],
    });
  });

  it("http 也放行", () => {
    expect(buildOpenUrlSpec("http://localhost:8876/x?a=1&b=2", "linux")).toEqual({
      command: "xdg-open",
      args: ["http://localhost:8876/x?a=1&b=2"],
    });
  });

  it("非 http(s) 协议 / 非法字符串一律拒绝（返 null）", () => {
    for (const bad of [
      "file:///C:/Windows/System32/calc.exe",
      "javascript:alert(1)",
      "ms-msdt:/id PCWDiagnostic",
      "cursor://file/etc/passwd",
      "calc.exe",
      "--help",
      "x&calc",
      "",
      "   ",
    ]) {
      for (const platform of ["win32", "darwin", "linux"] as const) {
        expect(buildOpenUrlSpec(bad, platform)).toBeNull();
      }
    }
  });

  it("URL 里的引号 / 空格被规范化编码、不会带着裸引号进 argv", () => {
    const spec = buildOpenUrlSpec('https://a.feishu.cn/x?q="hi there"&r=1', "win32");
    expect(spec).not.toBeNull();
    expect(spec?.args[1]).not.toContain('"');
    expect(spec?.args[1]).not.toContain(" ");
    expect(spec?.args[1]).toContain("&r=1");
  });
});

describe("源码契约：打开外链 / 文件不再经 cmd /c start", () => {
  it.each(["src/lib/server/feishu-cli.ts", "src/lib/local-file-os.ts"])(
    "%s 不含 cmd /c start 拼接",
    (file) => {
      const src = readFileSync(path.resolve(file), "utf8");
      expect(src).not.toMatch(/["']\/c["']\s*,\s*["']start["']/);
    },
  );
});
