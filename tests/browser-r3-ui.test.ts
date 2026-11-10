/**
 * R3-09：前端三个小项。
 *  ① 页面对话框条标注来源（「example.com 的页面提示框」）；
 *  ② 系统通知正文与状态条同口径剥格式 / 控制字符，主进程 parseNotifyPayload 再剥一遍（纵深防御）；
 *  ③ TabFavicon 的 failed 状态不能跨 favicon 地址残留（key 跟着 favicon 走）。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { safeOriginPath } from "../electron-app/browser/tab.mjs";
import { parseNotifyPayload } from "../electron-app/notify-target.mjs";
import { clipOneLine as statusClip, stripFormatChars as statusStrip } from "@/components/browser/browser-status";
import { DIALOG_HOST_SHOW_MAX, describeDialogBar, dialogSourceHost, shortHost } from "@/components/browser/browser-user-logic";
import type { DialogInfo } from "@/lib/browser-bridge-types";
import { BROWSER_ASK_BODY_MAX, planBrowserAskNotification } from "@/lib/browser-ask-notify";
import { clipOneLine, stripFormatChars } from "@/lib/one-line";

const read = (rel: string): string => readFileSync(path.join(process.cwd(), rel), "utf8");

const d = (over: Partial<DialogInfo> = {}): DialogInfo => ({
  type: "alert",
  message: "m",
  url: "https://example.com/a/b?x=1#h",
  since: 1,
  ...over,
});

describe("R3-09 ① 对话框条来源标注", () => {
  it("标题 = 来源主机 + 页面 + 类型：example.com 的页面提示框 / 确认框 / 输入框 / 离开确认", () => {
    expect(describeDialogBar(d())!.heading).toBe("example.com 的页面提示框");
    expect(describeDialogBar(d({ type: "confirm" }))!.heading).toBe("example.com 的页面确认框");
    expect(describeDialogBar(d({ type: "prompt" }))!.heading).toBe("example.com 的页面输入框");
    expect(describeDialogBar(d({ type: "beforeunload" }))!.heading).toBe("example.com 的页面离开确认");
    expect(describeDialogBar(d())!.sourceHost).toBe("example.com");
    // 原有字段不受影响
    expect(describeDialogBar(d({ type: "confirm" }))).toMatchObject({ typeLabel: "确认框", showCancel: true });
  });

  it("只取 host：端口保留；userinfo / 路径 / query 不进标题；IDN 转 punycode（只含 ASCII，不会借同形字冒充）", () => {
    expect(dialogSourceHost("http://localhost:3000/x")).toBe("localhost:3000");
    expect(dialogSourceHost("https://user:secret@evil.test/p?token=abc")).toBe("evil.test");
    const idn = dialogSourceHost("https://аpple.com/"); // 首字母是西里尔 а
    expect(idn.startsWith("xn--")).toBe(true);
    expect(/^[\x20-\x7e]*$/.test(idn)).toBe(true);
    expect(describeDialogBar(d({ url: "https://user:secret@evil.test/p" }))!.heading).not.toContain("secret");
  });

  it("拿不到来源（空 / 非字符串 / 非法 URL）：退回「页面…」，不炸", () => {
    for (const url of ["", "not a url", undefined as never, null as never, 5 as never]) {
      const m = describeDialogBar(d({ url }));
      expect(m, String(url)).not.toBeNull();
      expect(m!.heading, String(url)).toBe("页面提示框");
      expect(m!.sourceHost, String(url)).toBe("");
      expect(m!.headingFull, String(url)).toBe("页面提示框");
    }
  });

  // R4 复审 R3-09 ①：主进程下发的 dialog.url 是 safeOriginPath 的真实输出，不是原始 URL——测试必须喂它
  it("喂主进程 safeOriginPath 的真实输出：about / data / javascript / blob 等没有主机的协议一律退回「页面…」，不再把片段当主机", () => {
    for (const raw of [
      "about:blank",
      "about:srcdoc",
      "data:text/html,<h1>hi</h1>",
      "data:text/html;base64,PGgxPmhpPC9oMT4=",
      "javascript:alert(1)",
      "blob:https://evil.com/0f8c9a2e-1111-2222-3333-444455556666",
      "blob:null/abcd",
      "file:///Users/me/page.html",
      "ftp://files.example.com/a",
      "chrome-extension://abcdefg/popup.html",
    ]) {
      const url = safeOriginPath(raw);
      const m = describeDialogBar(d({ url }))!;
      expect(m.sourceHost, `${raw} → ${url}`).toBe("");
      expect(m.heading, `${raw} → ${url}`).toBe("页面提示框");
    }
    // 对照：http(s) 的真实输出带主机（query / hash / userinfo 已被 safeOriginPath 去掉）
    for (const [raw, host] of [
      ["https://example.com/a/b?x=1#h", "example.com"],
      ["http://localhost:3000/x", "localhost:3000"],
      ["https://user:secret@evil.test/p?token=abc", "evil.test"],
    ] as const) {
      const url = safeOriginPath(raw);
      expect(describeDialogBar(d({ url }))!.sourceHost, `${raw} → ${url}`).toBe(host);
    }
  });

  it("safeOriginPath 本身：data: / javascript: 只留协议（载荷不外传）、blob: 只留内层 origin、about: 原样、http(s) 去掉 query / hash / userinfo", () => {
    expect(safeOriginPath("data:text/html,<script>secret</script>")).toBe("data:");
    expect(safeOriginPath("javascript:alert(document.cookie)")).toBe("javascript:");
    expect(safeOriginPath("blob:https://evil.com/uuid")).toBe("blob:https://evil.com");
    expect(safeOriginPath("blob:null/uuid")).toBe("blob:");
    expect(safeOriginPath("about:blank")).toBe("about:blank");
    expect(safeOriginPath("https://a.com/p/q?token=1#frag")).toBe("https://a.com/p/q");
    expect(safeOriginPath("https://user:pw@a.com/p")).toBe("https://a.com/p");
    expect(safeOriginPath("not a url")).toBe("not a url");
    expect(safeOriginPath(`https://a.com/${"x".repeat(1000)}`).length).toBe(400);
    expect(safeOriginPath(`about:${"x".repeat(500)}`).length).toBe(100); // about: 路径限 100（R4-04 变异补强）
    expect(safeOriginPath(`blob:https://evil.com/${"x".repeat(500)}`)).toBe("blob:https://evil.com");
  });

  it("窄面板：超长主机标题保尾不保头（主域名在末尾），完整来源进 headingFull / Tooltip", () => {
    const host = "accounts.google.com.session-verify.example";
    const m = describeDialogBar(d({ url: `https://${host}/login` }))!;
    expect(host.length).toBeGreaterThan(DIALOG_HOST_SHOW_MAX);
    expect(m.heading).toBe(`…${host.slice(host.length - (DIALOG_HOST_SHOW_MAX - 1))} 的页面提示框`);
    expect(m.heading).toContain("session-verify.example");
    expect(m.heading).not.toContain("accounts.google.com.s");
    expect(m.headingFull).toBe(`${host} 的页面提示框`);
    expect(m.sourceHost).toBe(host);
    // 短主机不动
    expect(shortHost("example.com")).toBe("example.com");
    expect(shortHost("a".repeat(DIALOG_HOST_SHOW_MAX))).toBe("a".repeat(DIALOG_HOST_SHOW_MAX));
    expect(shortHost("a".repeat(DIALOG_HOST_SHOW_MAX + 1)).length).toBe(DIALOG_HOST_SHOW_MAX);
  });

  it("超长主机名限长（≤ 60 字符 + …），标题仍是单行", () => {
    const m = describeDialogBar(d({ url: `https://${"a".repeat(200)}.com/` }))!;
    expect(m.sourceHost.length).toBeLessThanOrEqual(61);
    expect(m.heading).not.toMatch(/[\r\n]/);
  });

  it("组件接线：条上渲染的是 model.heading（含来源），不是裸的 typeLabel", () => {
    const src = read("src/components/browser/browser-dialog-bar.tsx");
    expect(src).toContain("{model.heading}");
    expect(src).not.toContain("{model.typeLabel}");
    // 完整来源走 Tooltip（项目约定不用原生 title=），不是只靠 CSS 截断
    expect(src).toMatch(/<Tooltip\s+content=\{model\.headingFull\}/);
  });
});

describe("R3-09 ② 系统通知正文：与状态条同口径剥格式字符 + 主进程再剥一遍", () => {
  const snap = (message: string) => ({ taskId: "T1", askRequest: { message, since: 1 } });
  const plan = (message: string) =>
    planBrowserAskNotification({ state: snap(message), notified: new Map(), title: "任务", hasFocus: false, activeTaskId: null });

  it("RLO / 零宽 / BOM / tag 字符 / 换行：通知正文里一个都不剩（旧版只折叠空白）", () => {
    const body = plan("请点\u202E击\u200B确\u200D认\uFEFF\u{E0041}\n\n按钮\u0007")!.body ?? "";
    expect(body).toBe("AI 请你在浏览器里操作一下：请点击确认 按钮"); // 换行折成一个空格，其余不可见字符全剥
    expect(/[\p{Cc}\p{Cf}]/u.test(body)).toBe(false);
  });

  it("长度仍按 BROWSER_ASK_BODY_MAX 截断；剥完为空 → 不带冒号的兜底文案", () => {
    const body = plan("字".repeat(500))!.body;
    expect(body).toBe(`AI 请你在浏览器里操作一下：${"字".repeat(BROWSER_ASK_BODY_MAX)}…`);
    expect(plan("\u200B\u202E\uFEFF  ")!.body).toBe("AI 请你在浏览器里操作一下");
  });

  it("clipOneLine / stripFormatChars 挪到 @/lib/one-line 后，browser-status 的再导出与它是同一个函数（现有引用不变）", () => {
    expect(statusClip).toBe(clipOneLine);
    expect(statusStrip).toBe(stripFormatChars);
    expect(clipOneLine("a\u202Eb\n c", 10)).toBe("ab c");
  });

  // R4 复审 R3-09 ②：展示层口径补齐 Default_Ignorable / Variation_Selector（U+3164 等韩文填充符不是 Cf，但渲染成空白）
  it("stripFormatChars / clipOneLine：U+3164 / FFA0 / 115F / 1160 / 034F / 17B4–5 / VS1 / VS16 / VS17 一个不剩；普通文字与常见符号不动", () => {
    const hidden = ["\u3164", "\uFFA0", "\u115F", "\u1160", "\u034F", "\u17B4", "\u17B5", "\uFE00", "\uFE0F", "\u{E0100}", "\u180E", "\u2060", "\u00AD"];
    for (const ch of hidden) {
      expect(stripFormatChars(`a${ch}b`), JSON.stringify(ch)).toBe("ab");
      expect(clipOneLine(`x${ch}.exe`), JSON.stringify(ch)).toBe("x.exe");
    }
    // 文件名场景：真实后缀被一串填充符挤出可见区的欺骗
    const spoof = `report.pdf${"\u3164".repeat(80)}.exe`;
    expect(stripFormatChars(spoof)).toBe("report.pdf.exe");
    // 对照：普通文字 / 中文 / 常见符号 / 空格不被误剥
    for (const ok of ["report.pdf", "报告 2026.docx", "a-b_c (1).txt", "résumé.pdf", "50% off ¥100 €5 ©", "😀 ok"]) {
      expect(stripFormatChars(ok), ok).toBe(ok);
    }
  });

  it("下载文件名展示（browser-status 的 displayFilename）同样吃到新口径", () => {
    expect(statusStrip(`x.pdf${"\u3164".repeat(20)}.exe`)).toBe("x.pdf.exe");
  });

  it("主进程 parseNotifyPayload 同口径：title / body 里的 U+3164 / VS16 / U+034F 也剥掉", () => {
    const r = parseNotifyPayload({ title: "任\u3164务\uFE0F", body: "x\u034Fy\uFFA0z" });
    expect(r.title).toBe("任务");
    expect(r.body).toBe("xyz");
    // 通知正文（渲染进程这一层）
    const plan = planBrowserAskNotification({ state: { taskId: "T1", askRequest: { message: "点\u3164\u3164击", since: 1 } }, notified: new Map(), title: "任务", hasFocus: false, activeTaskId: null });
    expect(plan!.body).toBe("AI 请你在浏览器里操作一下：点击");
  });

  it("两处正则手抄一份（主进程不能 import src）：源码里的字符类必须一致", () => {
    const a = /replace\((\/\[[^\n]*?\]\/gu), ""\)/.exec(read("src/lib/one-line.ts"))?.[1];
    const b = /replace\((\/\[\\p\{Cc\}[^\n]*?\]\/gu), ""\)/.exec(read("electron-app/notify-target.mjs"))?.[1];
    expect(a).toBeTruthy();
    expect(b).toBe(a);
  });

  it("主进程 parseNotifyPayload：body / title 再剥一次 Cc / Cf（发送方没剥也不漏），空标题回退 Flowship，长度上限不变", () => {
    const r = parseNotifyPayload({ title: "任\u202E务\u200B", body: "x\u200By\nz\u0007\u{E0041}", taskId: "t_1" });
    expect(r.title).toBe("任务");
    expect(r.body).toBe("xy z");
    expect(parseNotifyPayload({ title: "\u200B\u202E", body: "b" }).title).toBe("Flowship");
    expect(parseNotifyPayload({ title: "t".repeat(200), body: "b".repeat(500) })).toMatchObject({ title: "t".repeat(80), body: "b".repeat(200) });
    // 非字符串仍按旧规则
    expect(parseNotifyPayload({ title: 5, body: {} })).toMatchObject({ title: "Flowship", body: "" });
  });
});

describe("R3-09 ③ TabFavicon 的 failed 状态不跨 favicon 地址残留", () => {
  it("TabFavicon 的 key 跟着 tab.favicon：换地址 = 重新挂载 = failed 复位", () => {
    const src = read("src/components/browser/browser-panel.tsx");
    expect(src).toMatch(/<TabFavicon\s+key=\{tab\.favicon \?\? ""\}\s+tab=\{tab\}\s*\/>/);
    // failed 状态仍在组件内部（key 重置的前提）
    expect(src).toContain("const [failed, setFailed] = useState(false);");
  });
});
