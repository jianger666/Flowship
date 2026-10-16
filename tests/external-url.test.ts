/**
 * 外链 / 导航协议白名单（electron-app/external-url.mjs）+ will-navigate 接线契约
 *
 * 为什么要测：will-navigate 以前对非站内 URL 直接 shell.openExternal(url)，页面（或被注入的内容）
 * 一次同 frame 导航就能让系统去处理 file: / smb: / 任意自定义协议。
 * 这里用 accept / reject 表把绕过手法钉死，并用 main.js 源码契约保证「放行判定」真的挡在 openExternal 前面。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  isIdeDeepLink,
  isSafeExternalUrl,
  isSafeMailtoUrl,
  isSameAppOrigin,
} from "../electron-app/external-url.mjs";
import { buildIdeLink } from "@/lib/path-utils";
import { JUMP_IDE_USES_PROTOCOL, type JumpIde } from "@/lib/types";

const main = readFileSync(path.resolve(import.meta.dirname, "..", "electron-app/main.js"), "utf8");

describe("isSafeExternalUrl：通用外链白名单（setWindowOpenHandler / IPC / will-navigate 共用）", () => {
  const accept: Array<[string, string]> = [
    ["https 外链", "https://github.com/jianger666/Flowship/releases/latest"],
    ["http 外链", "http://example.com/a?b=1#c"],
    ["站内 http（交给 isAppUrl 判站内、这里只是合法 http）", "http://127.0.0.1:8876/tasks/1"],
    ["协议大小写不敏感（与旧 /i 正则语义一致）", "HTTPS://GitHub.com/x"],
    ["混合大小写协议", "HtTp://example.com/"],
    ["macOS 系统设置深链", "x-apple.systempreferences:com.apple.Notifications-Settings.extension"],
    ["Windows 系统设置深链", "ms-settings:notifications"],
    ["系统设置深链大小写", "MS-SETTINGS:notifications"],
    // userinfo 形态在这里只是「一个普通的外部 http 链接」：它只会交给系统浏览器、不会在应用窗口里加载，
    // 所以放行；「是否站内」由 isSameAppOrigin 按 origin 判（见下方 describe）
    ["带 userinfo 的外部链接（只开系统浏览器）", "http://127.0.0.1:8876@evil.example/"],
  ];
  it.each(accept)("放行：%s", (_name, url) => {
    expect(isSafeExternalUrl(url)).toBe(true);
  });

  const reject: Array<[string, unknown]> = [
    ["非字符串 undefined", undefined],
    ["非字符串 null", null],
    ["非字符串 number", 42],
    ["非字符串 对象", { toString: () => "https://x.com" }],
    ["空串", ""],
    ["javascript:", "javascript:alert(1)"],
    ["JavaScript: 大小写", "JaVaScRiPt:alert(1)"],
    ["java\\nscript:（换行拆词、URL 解析会剥掉）", "java\nscript:alert(1)"],
    ["java\\tscript:（tab 拆词）", "java\tscript:alert(1)"],
    ["java\\r\\nscript:", "java\r\nscript:alert(1)"],
    ["前导空格 + javascript:", " javascript:alert(1)"],
    ["前导空格 + https（解析后合法、原串不合法）", " https://example.com/"],
    ["前导换行 + https", "\nhttps://example.com/"],
    ["前导 NUL + https", "\u0000https://example.com/"],
    ["前导 NBSP + https", "\u00a0https://example.com/"],
    ["尾部空格", "https://example.com/ "],
    ["url 内部夹空格", "https://exam ple.com/"],
    ["url 内部夹 tab（解析会剥掉）", "https://exam\tple.com/"],
    ["bidi 覆盖字符", "https://example.com/\u202egpj.exe"],
    ["零宽字符", "https://exam\u200bple.com/"],
    ["file:///", "file:///etc/passwd"],
    ["FILE: 大小写", "FILE:///C:/Windows/System32/calc.exe"],
    ["file: 无斜杠", "file:/etc/passwd"],
    ["data:", "data:text/html,<script>alert(1)</script>"],
    ["blob:", "blob:https://example.com/uuid"],
    ["vbscript:", "vbscript:msgbox(1)"],
    ["smb://", "smb://evil.example/share/x"],
    ["SMB 大小写", "SMB://evil.example/share/x"],
    ["UNC 反斜杠", "\\\\evil.example\\share\\x"],
    ["ftp:", "ftp://example.com/x"],
    ["ws:", "ws://example.com/"],
    ["mailto:（通用白名单不放行；只在 will-navigate 经 isSafeMailtoUrl 放行）", "mailto:a@example.com"],
    ["tel:", "tel:+10000000000"],
    ["about:", "about:blank"],
    ["chrome://", "chrome://settings"],
    ["IDE 协议不在通用白名单里（只有 will-navigate 单独放行）", "cursor://file/Users/me/a.ts"],
    ["idea://", "idea://open?file=/Users/me/a.ts"],
    ["自定义协议处理器", "ms-msdt:/id PCWDiagnostic /skip force /param \"IT_RebrowseForFile=?\""],
    ["协议名只是前缀 ms-settings-x:", "ms-settings-evil:notifications"],
    ["缺冒号的协议名", "ms-settings"],
    ["https 缺 //（解析会规整成合法 URL）", "https:example.com/"],
    ["https 反斜杠（解析会规整成 //）", "https:\\\\example.com\\x"],
    ["https 单斜杠", "https:/example.com/"],
    ["https 空 host", "https:///x"],
    ["只有协议", "https://"],
    ["协议相对 URL", "//example.com/x"],
    ["相对路径", "/tasks/1"],
    ["x-apple 前缀伪装（无冒号）", "x-apple.systempreferencesevil"],
  ];
  it.each(reject)("拒绝：%s", (_name, url) => {
    expect(isSafeExternalUrl(url)).toBe(false);
  });
});

describe("isIdeDeepLink：前端真实生成的 IDE deep link（仅 will-navigate 放行）", () => {
  const accept: Array<[string, string]> = [
    ["cursor 文件", "cursor://file/Users/me/proj/src/a.ts"],
    ["cursor 文件 + 行号", "cursor://file/Users/me/proj/src/a.ts:42"],
    ["vscode 文件 + 行号", "vscode://file/Users/me/proj/src/a.ts:7"],
    ["Windows 盘符路径（: 不 encode）", "cursor://file/D:/IdeaProjects/app/src/a.ts:7"],
    ["Windows 盘符 + 小写盘符", "vscode://file/c:/myfile.txt"],
    ["中文 / 空格已 encode", "cursor://file/Users/me/%E9%A1%B9%E7%9B%AE%20x/%E4%B8%AD%E6%96%87.ts:3"],
    ["括号 / 感叹号 / 波浪线（encodeURIComponent 不 encode）", "cursor://file/Users/me/a(1)!~/b'.ts"],
    ["工作区目录 + 新窗口参数", "cursor://file/Users/me/proj?windowId=_blank"],
    ["Windows 工作区目录 + 新窗口参数", "vscode://file/D:/work/proj?windowId=_blank"],
    ["目录带一个尾斜杠", "cursor://file/Users/me/proj/"],
  ];
  it.each(accept)("放行：%s", (_name, url) => {
    expect(isIdeDeepLink(url)).toBe(true);
  });

  const reject: Array<[string, unknown]> = [
    ["非字符串", undefined],
    ["空串", ""],
    ["host 不是 file（攻击者 host）", "cursor://evil-host/Users/me/a.ts"],
    ["host 大小写 FILE（前端恒为小写）", "cursor://FILE/Users/me/a.ts"],
    ["host 前缀伪装 file.evil", "cursor://file.evil/Users/me/a.ts"],
    ["userinfo 把 file 变成用户名", "cursor://file@evil-host/Users/me/a.ts"],
    ["user:pass@file", "cursor://user:pw@file/Users/me/a.ts"],
    ["带端口", "cursor://file:8080/Users/me/a.ts"],
    ["scheme 大写（前端恒为小写）", "CURSOR://file/Users/me/a.ts"],
    ["scheme 混合大小写", "VsCode://file/Users/me/a.ts"],
    ["前导空格", " cursor://file/Users/me/a.ts"],
    ["前导换行", "\ncursor://file/Users/me/a.ts"],
    ["cur\\nsor 拆词", "cur\nsor://file/Users/me/a.ts"],
    ["路径内空格（前端会 encode 成 %20）", "cursor://file/Users/me/a b.ts"],
    ["路径内换行", "cursor://file/Users/me/a\n.ts"],
    ["UNC（// 开头 = SMB / NTLM 外泄）", "cursor://file//evil-host/share/a.ts"],
    ["UNC 三斜杠", "cursor://file///evil-host/share/a.ts"],
    ["路径中间空段", "cursor://file/Users//me/a.ts"],
    ["目录穿越 ..", "cursor://file/Users/me/../../etc/passwd"],
    ["目录穿越 %2e%2e", "cursor://file/Users/me/%2e%2e/%2E%2E/etc/passwd"],
    ["单点段", "cursor://file/Users/./me/a.ts"],
    ["编码斜杠 %2F", "cursor://file/Users/me%2F..%2Fetc/a.ts"],
    ["编码反斜杠 %5C", "cursor://file/Users/me%5C..%5Cetc/a.ts"],
    ["编码 NUL %00", "cursor://file/Users/me/a.ts%00.png"],
    ["非法百分号编码", "cursor://file/Users/me/%zz.ts"],
    ["原始反斜杠", "cursor://file/Users\\me\\a.ts"],
    ["根目录 / 无路径", "cursor://file/"],
    ["无路径", "cursor://file"],
    ["仅盘符", "vscode://file/D:"],
    ["仅盘符 + 斜杠", "vscode://file/D:/"],
    ["未 encode 的冒号（非盘符非行号）", "cursor://file/Users/me/a:b/c.ts"],
    ["行号后面再跟列号", "cursor://file/Users/me/a.ts:12:5"],
    ["行号非数字", "cursor://file/Users/me/a.ts:abc"],
    ["行号过长", "cursor://file/Users/me/a.ts:123456789"],
    ["额外 query", "cursor://file/Users/me/proj?command=evil"],
    ["windowId 值不是 _blank", "cursor://file/Users/me/proj?windowId=1"],
    ["windowId 后追加参数", "cursor://file/Users/me/proj?windowId=_blank&x=1"],
    ["fragment", "cursor://file/Users/me/a.ts#L10"],
    ["VS Code 的 git clone handler（真实攻击面）", "vscode://vscode.git/clone?url=https://evil.example/r.git"],
    ["Cursor 的提示词 deep link", "cursor://anysphere.cursor-deeplink/prompt?text=rm%20-rf"],
    ["MCP 安装 deep link", "cursor://anysphere.cursor-deeplink/mcp/install?name=x&config=e30="],
    ["前端不会走协议的 JetBrains idea://", "idea://open?file=/Users/me/a.ts"],
    ["webstorm://", "webstorm://open?file=/Users/me/a.ts"],
    ["vscode-insiders://", "vscode-insiders://file/Users/me/a.ts"],
    ["windsurf://（前端走后端拉起、不走协议）", "windsurf://file/Users/me/a.ts"],
    ["file:///", "file:///etc/passwd"],
    ["smb://", "smb://evil-host/share"],
    ["javascript:", "javascript:alert(1)"],
    ["https 冒充 host=file", "https://file/Users/me/a.ts"],
    ["超长（> 8192）", `cursor://file/${"a".repeat(9000)}`],
  ];
  it.each(reject)("拒绝：%s", (_name, url) => {
    expect(isIdeDeepLink(url)).toBe(false);
  });

  it("IDE 协议只给 will-navigate：通用白名单不放行 cursor / vscode", () => {
    expect(isSafeExternalUrl("cursor://file/Users/me/a.ts")).toBe(false);
    expect(isSafeExternalUrl("vscode://file/Users/me/a.ts")).toBe(false);
  });

  // 契约：前端 buildIdeLink 生成的每一种形态都必须被放行——否则 IDE 跳转会被安全收紧悄悄打断
  // （用户点了没反应、很难排查）；反过来前端若改了 URL 形态，这里会第一时间变红
  describe("前端 buildIdeLink 的真实产物必须放行", () => {
    const protocolIdes = (Object.keys(JUMP_IDE_USES_PROTOCOL) as JumpIde[]).filter(
      (ide) => JUMP_IDE_USES_PROTOCOL[ide],
    );

    it("走协议的 IDE 恰好是 cursor / vscode（白名单只需覆盖这两个）", () => {
      expect(protocolIdes.sort()).toEqual(["cursor", "vscode"]);
    });

    const inputs: Array<[string, string, string | undefined]> = [
      ["POSIX 绝对路径", "/Users/me/proj/src/a.ts", undefined],
      ["带行号", "/Users/me/proj/src/a.ts:42", undefined],
      ["带行号范围（取首段起始行）", "/Users/me/proj/src/a.ts:42-50", undefined],
      ["Windows 盘符路径（反斜杠）", "D:\\IdeaProjects\\app\\src\\a.ts:7", undefined],
      ["Windows 盘符路径（正斜杠）", "c:/myfile.txt", undefined],
      ["中文 + 空格", "/Users/me/我的 项目/需求 文档.md", undefined],
      ["特殊字符 # % & + , ; = @ $ [ ]", "/Users/me/a#b%c&d+e,f;g=h@i$j[k]/x.ts", undefined],
      ["引号 / 括号", "/Users/me/it's (1)/a!.ts", undefined],
      ["相对路径 + baseDir", "src/a.ts:3", "/Users/me/proj"],
      ["相对路径 + Windows baseDir", "src/a.ts", "D:\\work\\proj"],
      ["baseDir 带尾斜杠", "src/a.ts", "/Users/me/proj/"],
    ];
    for (const ide of ["cursor", "vscode"] as const) {
      it.each(inputs)(`${ide}：%s`, (_name, pathLike, baseDir) => {
        const href = buildIdeLink(pathLike, baseDir, ide);
        expect(href, "buildIdeLink 应能生成链接").not.toBeNull();
        expect(isIdeDeepLink(href as string), href as string).toBe(true);
        // 开工作区目录用的新窗口形态
        const win = buildIdeLink(pathLike, baseDir, ide, { newWindow: true });
        expect(isIdeDeepLink(win as string), win as string).toBe(true);
      });
    }
  });
});

describe("isSafeMailtoUrl：mailto 只放行「收件人 + subject/body/cc/bcc」的严格形态（仅 will-navigate）", () => {
  const accept: Array<[string, string]> = [
    ["单个收件人", "mailto:a@example.com"],
    ["协议大小写不敏感", "MAILTO:a@example.com"],
    ["多个收件人", "mailto:a@example.com,b@example.org"],
    ["加号 / 点 / 连字符 local part", "mailto:first.last+tag@sub-domain.example.co.uk"],
    ["%2B 编码的加号", "mailto:a%2Bb@example.com"],
    ["subject 带空格（%20）", "mailto:a@example.com?subject=Hello%20World"],
    ["subject 中文（已 encode）", "mailto:a@example.com?subject=%E4%BD%A0%E5%A5%BD"],
    ["subject 中文（没 encode、agent 常这么写）", "mailto:a@example.com?subject=你好"],
    ["body 带 CRLF 换行", "mailto:a@example.com?body=line1%0D%0Aline2"],
    ["body 带 tab", "mailto:a@example.com?body=a%09b"],
    ["cc + bcc", "mailto:a@example.com?cc=b@example.com&bcc=c@example.com,d@example.com"],
    ["四个键都有", "mailto:a@example.com?subject=s&body=b&cc=b@example.com&bcc=c@example.com"],
    ["键大小写不敏感", "mailto:a@example.com?SUBJECT=x"],
    ["空 subject", "mailto:a@example.com?subject="],
  ];
  it.each(accept)("放行：%s", (_name, url) => {
    expect(isSafeMailtoUrl(url)).toBe(true);
  });

  const reject: Array<[string, unknown]> = [
    ["非字符串 undefined", undefined],
    ["非字符串 null", null],
    ["非字符串 数字", 42],
    ["空串", ""],
    ["只有协议", "mailto:"],
    ["没有收件人（只有 query）", "mailto:?subject=hi"],
    ["前导空格", " mailto:a@example.com"],
    ["前导换行", "\nmailto:a@example.com"],
    ["前导 NUL", "\u0000mailto:a@example.com"],
    ["前导 NBSP", "\u00a0mailto:a@example.com"],
    ["尾部空格", "mailto:a@example.com "],
    ["原串里夹空格", "mailto:a@example.com?subject=hello world"],
    ["原串里夹 CRLF（头注入）", "mailto:a@example.com\r\nBcc:evil@example.com"],
    ["原串里夹 tab", "mailto:a@example.\tcom"],
    ["原串里夹 bidi 覆盖字符", "mailto:a@example.com?subject=\u202egpj"],
    ["原串里夹零宽字符", "mailto:a@exam\u200bple.com"],
    ["subject 里编码的 CRLF + Bcc 头注入", "mailto:a@example.com?subject=hi%0D%0ABcc:evil@example.com"],
    ["subject 里编码的换行", "mailto:a@example.com?subject=a%0Ab"],
    ["subject 里编码的 NUL", "mailto:a@example.com?subject=a%00b"],
    ["body 里编码的 NUL", "mailto:a@example.com?body=a%00b"],
    ["body 里编码的 ESC", "mailto:a@example.com?body=a%1Bb"],
    ["body 里编码的 C1 控制符", "mailto:a@example.com?body=a%C2%85b"],
    ["body 里编码的 bidi 覆盖", "mailto:a@example.com?body=%E2%80%AEgpj"],
    ["附件参数 attach（本地文件）", "mailto:a@example.com?attach=C:%5Csecret.txt"],
    ["附件参数 attachment（file:）", "mailto:a@example.com?attachment=file%3A%2F%2F%2Fetc%2Fpasswd"],
    ["附件参数 attach（UNC / NTLM 外泄）", "mailto:a@example.com?attach=%5C%5Cevil.example%5Cshare%5Cx"],
    ["附件参数夹在合法参数之间", "mailto:a@example.com?subject=s&attach=x&body=b"],
    ["未知键 from", "mailto:a@example.com?from=b@example.com"],
    ["未知键 x-自定义头", "mailto:a@example.com?x-foo=1"],
    ["未知键 in-reply-to", "mailto:a@example.com?in-reply-to=%3Cx%40y%3E"],
    ["键被百分号编码伪装", "mailto:a@example.com?%73ubject=x"],
    ["重复键", "mailto:a@example.com?subject=a&subject=b"],
    ["无等号的键", "mailto:a@example.com?subject"],
    ["空键", "mailto:a@example.com?=x"],
    ["尾随 &（空 pair）", "mailto:a@example.com?subject=x&"],
    ["只有问号", "mailto:a@example.com?"],
    ["fragment（紧跟收件人）", "mailto:a@example.com#frag"],
    ["fragment（在 query 之后；不拦的话会被当成 subject 的一部分）", "mailto:a@example.com?subject=x#frag"],
    ["非法百分号编码", "mailto:a@example.com?subject=%zz"],
    ["cc 为空", "mailto:a@example.com?cc="],
    ["cc 里有非法地址", "mailto:a@example.com?cc=not-an-email"],
    ["bcc 里夹分号", "mailto:a@example.com?bcc=b@example.com;c@example.com"],
    ["地址缺 @", "mailto:not-an-email"],
    ["地址缺域名", "mailto:a@"],
    ["地址缺 local", "mailto:@example.com"],
    ["域名没有点", "mailto:a@localhost"],
    ["两个 @", "mailto:a@b@example.com"],
    ["%40 解码出第二个 @", "mailto:a%40b@example.com"],
    ["收件人里编码的换行", "mailto:a@example.com%0Ab@example.com"],
    ["收件人里编码的逗号（先解码再切会把一个地址变成两个合法地址）", "mailto:a@example.com%2Cb@example.org"],
    ["cc 里编码的逗号（同上）", "mailto:a@example.com?cc=b@example.com%2Cc@example.org"],
    ["收件人列表尾随逗号", "mailto:a@example.com,"],
    ["收件人列表首逗号", "mailto:,a@example.com"],
    ["分号分隔（Outlook 习惯、非 RFC 6068）", "mailto:a@example.com;b@example.com"],
    ["带引号的显示名", 'mailto:"a b"@example.com'],
    ["尖括号显示名", "mailto:A<a@example.com>"],
    ["反斜杠", "mailto:a@example.com\\x"],
    ["mailto:// 形态", "mailto://a@example.com"],
    ["域名里夹下划线 / 其它符号", "mailto:a@exa_mple.com"],
    ["IDN 域名（保守不放）", "mailto:a@例子.com"],
    ["超长（> 2048）", `mailto:a@example.com?body=${"a".repeat(3000)}`],
    ["https（不是 mailto）", "https://example.com/"],
    ["tel:", "tel:+10000000000"],
    ["sms:", "sms:+10000000000"],
    ["facetime:", "facetime:a@example.com"],
    ["javascript:", "javascript:alert(1)"],
    ["file:", "file:///etc/passwd"],
    ["smb:", "smb://evil.example/share"],
    ["协议名只是前缀 mailto-x:", "mailto-x:a@example.com"],
    ["相对路径", "/tasks/1"],
  ];
  it.each(reject)("拒绝：%s", (_name, url) => {
    expect(isSafeMailtoUrl(url)).toBe(false);
  });

  it("恰好 2048 字符放行、2049 拒绝（长度上限是闭区间）", () => {
    const head = "mailto:a@example.com?body=";
    expect(isSafeMailtoUrl(head + "a".repeat(2048 - head.length))).toBe(true);
    expect(isSafeMailtoUrl(head + "a".repeat(2049 - head.length))).toBe(false);
  });

  it("通用白名单 / IDE 判定不因此放行 mailto（mailto 只给 will-navigate）", () => {
    expect(isSafeExternalUrl("mailto:a@example.com")).toBe(false);
    expect(isIdeDeepLink("mailto:a@example.com")).toBe(false);
    // 反过来：mailto 判定对 http(s) / IDE deep link 一律不放行，三个判定互不串味
    expect(isSafeMailtoUrl("https://example.com/")).toBe(false);
    expect(isSafeMailtoUrl("cursor://file/Users/me/a.ts")).toBe(false);
  });
});

describe("isSameAppOrigin：站内判定必须按 origin 精确比对", () => {
  const origin = { host: "127.0.0.1", port: 8876 };
  it.each([
    "http://127.0.0.1:8876/",
    "http://127.0.0.1:8876/tasks/1?x=1#y",
    "http://127.0.0.1:8876",
  ])("站内：%s", (url) => {
    expect(isSameAppOrigin(url, origin)).toBe(true);
  });
  it.each([
    ["userinfo 伪装（startsWith 前缀绕过）", "http://127.0.0.1:8876@evil.example/"],
    ["端口前缀 88760", "http://127.0.0.1:88760/"],
    ["host 后缀伪装", "http://127.0.0.1:8876.attacker.example/"],
    ["https", "https://127.0.0.1:8876/"],
    ["localhost", "http://localhost:8876/"],
    ["缺端口", "http://127.0.0.1/"],
    ["别的端口", "http://127.0.0.1:8877/"],
    ["非 URL", "not a url"],
    ["空串", ""],
    ["cursor 协议", "cursor://file/Users/me/a.ts"],
  ])("非站内：%s", (_name, url) => {
    expect(isSameAppOrigin(url, origin)).toBe(false);
  });
});

describe("main.js 接线契约：放行判定必须挡在 shell.openExternal 前面", () => {
  // 取 will-navigate 处理器源码（到下一个顶层 `  });` 为止）
  const handlerStart = main.indexOf('mainWindow.webContents.on("will-navigate"');
  const handler = main.slice(handlerStart, main.indexOf("\n  });", handlerStart));

  it("will-navigate 处理器存在，且 app-update:// 兜底、站内放行仍在", () => {
    expect(handlerStart).toBeGreaterThanOrEqual(0);
    expect(handler).toContain('url.startsWith("app-update://")');
    expect(handler).toContain("void installUpdateNow()");
    expect(handler).toContain("if (isAppUrl(url)) return;");
  });

  it("站外导航一律先 preventDefault、再判白名单；openExternal 只出现在白名单分支内", () => {
    const siteGate = handler.indexOf("if (isAppUrl(url)) return;");
    const prevent = handler.indexOf("e.preventDefault();", siteGate);
    const gate = handler.indexOf(
      "if (isSafeExternalUrl(url) || isIdeDeepLink(url) || isSafeMailtoUrl(url)) {",
    );
    const open = handler.indexOf("shell.openExternal(url)");
    expect(prevent).toBeGreaterThan(siteGate);
    expect(gate).toBeGreaterThan(prevent);
    expect(open).toBeGreaterThan(gate);
    // 处理器里 openExternal 恰好一处（不能在白名单外还留一个无条件调用）
    expect(handler.match(/shell\.openExternal\(/g)).toHaveLength(1);
    // 白名单分支放行后立刻 return，后面的拒绝日志不会被执行到
    const afterOpen = handler.slice(open);
    expect(afterOpen.indexOf("return;")).toBeGreaterThanOrEqual(0);
    expect(afterOpen.indexOf("return;")).toBeLessThan(afterOpen.indexOf("拒绝非白名单 URL"));
  });

  it("拒绝时只记一行截断日志（不打整串 URL、不打开）", () => {
    expect(handler).toContain("拒绝非白名单 URL");
    expect(handler).toContain("String(url).slice(0, 80)");
  });

  it("setWindowOpenHandler / IPC open-external 仍只用通用白名单（IDE deep link / mailto 不走这两条路）", () => {
    const wo = main.indexOf("setWindowOpenHandler(");
    const woBlock = main.slice(wo, main.indexOf("\n  });", wo));
    expect(woBlock).toContain("isSafeExternalUrl(url)");
    expect(woBlock).not.toContain("isIdeDeepLink");
    expect(woBlock).not.toContain("isSafeMailtoUrl");
    const ipc = main.indexOf('ipcMain.on("open-external"');
    const ipcBlock = main.slice(ipc, main.indexOf("\n});", ipc));
    expect(ipcBlock).toContain("isSafeExternalUrl(url)");
    expect(ipcBlock).not.toContain("isIdeDeepLink");
    expect(ipcBlock).not.toContain("isSafeMailtoUrl");
  });

  it("壳里不再有前缀正则版白名单，判定统一来自 external-url.mjs", () => {
    expect(main).not.toContain("OPEN_EXTERNAL_ALLOWED");
    expect(main).toContain('from "./external-url.mjs"');
    expect(main).toContain("isSameAppOrigin(url, { host: HOST, port: PORT })");
  });

  it("前端没有 window.open / IPC 去开 IDE 协议（保证 isIdeDeepLink 只需放在 will-navigate）", () => {
    // IDE 协议由 getIdeAnchorProps → <a href> / window.location.assign 同 frame 导航产生
    const ideOpen = readFileSync(path.resolve(import.meta.dirname, "..", "src/lib/ide-open.ts"), "utf8");
    expect(ideOpen).not.toMatch(/window\.open|openExternal/);
  });
});

describe("will-navigate 处理器真实执行（切出 main.js 源码、注入真实白名单函数）", () => {
  // 第五轮审查「外链拦截」：will-navigate 由「一律放行」改成白名单后，页面里 `<a href="mailto:…">`
  // 同 frame 导航被静默拦下（点了没反应、日志也只有一行）。这里不 grep 字符串，而是把处理器本体切出来真跑，
  // 钉死「mailto 经 shell.openExternal 打开、其它协议仍拦截、http(s) / IDE deep link / 站内行为不变」。
  const start = main.indexOf('mainWindow.webContents.on("will-navigate"');
  const src = main.slice(start, main.indexOf("\n  });", start) + "\n  });".length);

  const setup = () => {
    let handler: (e: { preventDefault: () => void }, url: string) => void = () => undefined;
    const mainWindow = {
      webContents: {
        on: (_event: string, h: typeof handler) => {
          handler = h;
        },
      },
    };
    // 形参只用来让 mock.calls 带上 [string] 的类型（断言里要取 calls[i][0]）
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const shell = { openExternal: vi.fn(async (_url: string) => undefined) };
    const log = vi.fn();
    const installUpdateNow = vi.fn();
    new Function(
      "mainWindow",
      "isAppUrl",
      "isSafeExternalUrl",
      "isIdeDeepLink",
      "isSafeMailtoUrl",
      "shell",
      "log",
      "installUpdateNow",
      src,
    )(
      mainWindow,
      (u: string) => isSameAppOrigin(u, { host: "127.0.0.1", port: 8876 }),
      isSafeExternalUrl,
      isIdeDeepLink,
      isSafeMailtoUrl,
      shell,
      log,
      installUpdateNow,
    );
    const navigate = (url: string) => {
      const e = { preventDefault: vi.fn() };
      handler(e, url);
      return e;
    };
    return { navigate, shell, log, installUpdateNow };
  };

  it.each([
    "mailto:a@example.com",
    "mailto:a@example.com?subject=%E5%8F%8D%E9%A6%88&body=hi",
    "MAILTO:a.b+c@example.co.uk,d@example.org?cc=e@example.com",
  ])("合法 mailto：先拦下导航、再交 shell.openExternal 原样打开（%s）", (url) => {
    const s = setup();
    const e = s.navigate(url);
    expect(e.preventDefault).toHaveBeenCalledTimes(1); // 主窗不能被带走
    expect(s.shell.openExternal).toHaveBeenCalledTimes(1);
    expect(s.shell.openExternal).toHaveBeenCalledWith(url);
    expect(s.log.mock.calls.some((c) => String(c[0]).includes("拒绝非白名单"))).toBe(false);
  });

  it.each([
    ["mailto 带附件参数（attach 能让邮件客户端读本地文件 / UNC）", "mailto:a@example.com?attach=C:%5Csecret.txt"],
    ["mailto 带 attachment 参数", "mailto:a@example.com?attachment=file%3A%2F%2F%2Fetc%2Fpasswd"],
    ["mailto 主题里夹 CRLF 头注入", "mailto:a@example.com?subject=x%0D%0ABcc:evil@example.com"],
    ["mailto 超长", `mailto:a@example.com?body=${"a".repeat(3000)}`],
    ["tel:", "tel:+10000000000"],
    ["sms:", "sms:+10000000000"],
    ["file:", "file:///etc/passwd"],
    ["javascript:", "javascript:alert(1)"],
    ["smb:", "smb://evil.example/share"],
    ["自定义协议处理器", 'ms-msdt:/id PCWDiagnostic /skip force /param "IT_RebrowseForFile=?"'],
    ["IDE 非 file host 的 deep link", "vscode://vscode.git/clone?url=https://evil.example/r.git"],
  ])("其它协议 / 不合格 mailto 仍拦截：%s（拦下导航、不打开、记一行日志）", (_name, url) => {
    const s = setup();
    const e = s.navigate(url);
    expect(e.preventDefault).toHaveBeenCalledTimes(1);
    expect(s.shell.openExternal).not.toHaveBeenCalled();
    expect(s.log).toHaveBeenCalledTimes(1);
    expect(String(s.log.mock.calls[0]![0])).toContain("拒绝非白名单 URL");
  });

  it.each([
    "https://github.com/jianger666/Flowship/releases/latest",
    "http://example.com/a?b=1",
    "ms-settings:notifications",
    "cursor://file/Users/me/proj/src/a.ts:42",
  ])("既有放行不变：%s", (url) => {
    const s = setup();
    const e = s.navigate(url);
    expect(e.preventDefault).toHaveBeenCalledTimes(1);
    expect(s.shell.openExternal).toHaveBeenCalledWith(url);
  });

  it("站内导航不拦；app-update:// 仍由壳自己消费", () => {
    const s = setup();
    const inApp = s.navigate("http://127.0.0.1:8876/tasks/1");
    expect(inApp.preventDefault).not.toHaveBeenCalled();
    expect(s.shell.openExternal).not.toHaveBeenCalled();

    const upd = s.navigate("app-update://install");
    expect(upd.preventDefault).toHaveBeenCalledTimes(1);
    expect(s.installUpdateNow).toHaveBeenCalledTimes(1);
    expect(s.shell.openExternal).not.toHaveBeenCalled();
  });
});
