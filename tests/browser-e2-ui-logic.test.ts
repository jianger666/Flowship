/**
 * 增强包 E2 · 面板条的纯逻辑 + SSR（契约 §15.1 / §15.2）：提示条文案 / 动作、网络规则横幅、断点条、录制条。
 * 重点：页面 / 网络来的文字（host / detail）展示前剥格式字符；凭据输入框只在 auth 提示出现且 SSR 里不带任何值。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { BrowserExtraBars } from "@/components/browser/browser-extra-bars";
import {
  MAX_VISIBLE_PROMPTS,
  PROMPT_ARM_DELAY_MS,
  describeDebugBar,
  describeNetRulesBanner,
  describePrompt,
  describeRecordingBar,
  describeSystemDenied,
  describeSystemRestricted,
  queuedPromptCount,
  visiblePrompts,
} from "@/components/browser/browser-extra-logic";
import type { BrowserPromptInfo } from "@/lib/browser-bridge-types";

const ROOT = path.resolve(import.meta.dirname, "..");

const prompt = (over: Partial<BrowserPromptInfo> = {}): BrowserPromptInfo => ({
  id: "p1",
  kind: "auth",
  host: "intranet.example.com",
  detail: {},
  actions: ["cancel", "submit"],
  since: 1000,
  expiresAt: 61_000,
  ...over,
});

describe("describePrompt", () => {
  it("auth：要凭据输入框、说明凭据不经过 AI、超时提示 = 默认动作的文案", () => {
    const m = describePrompt(prompt({ detail: { realm: "Staging Area" } }))!;
    expect(m.needsCredentials).toBe(true);
    expect(m.heading).toBe("网站要求登录：intranet.example.com");
    expect(m.lines.join("\n")).toContain("站点声明：Staging Area");
    expect(m.lines.join("\n")).toContain("不会经过 AI");
    expect(m.actions.map((a) => a.id)).toEqual(["cancel", "submit"]);
    expect(m.timeoutHint).toBe("60 秒内未处理将自动「取消」");
  });

  it("cert：「本次会话继续访问」是 destructive 样式，且默认（第一个）动作是返回安全页面", () => {
    const m = describePrompt(prompt({ kind: "cert", actions: ["deny", "allow-host"], detail: { error: "ERR_CERT_AUTHORITY_INVALID" } }))!;
    expect(m.needsCredentials).toBe(false);
    expect(m.actions[0]).toMatchObject({ id: "deny", label: "返回安全页面" });
    expect(m.actions[1]).toMatchObject({ id: "allow-host", variant: "destructive" });
    expect(m.lines.join("\n")).toContain("ERR_CERT_AUTHORITY_INVALID");
  });

  it("permission：权限名翻成中文；认不出的原样展示", () => {
    expect(describePrompt(prompt({ kind: "permission", actions: ["deny", "allow", "allow-session"], detail: { permission: "geolocation" } }))!.lines[0]).toBe("请求：位置信息");
    expect(describePrompt(prompt({ kind: "permission", actions: ["deny"], detail: { permission: "weird-perm" } }))!.lines[0]).toBe("请求：weird-perm");
  });

  it("permission（第二十一轮）：被委托的内嵌框架发起的请求多一行说明实际发起者；系统层已拒绝时多一行去哪里打开（按平台）；都没有时只有「请求 / 来源」两行", () => {
    const base = { kind: "permission" as const, actions: ["deny", "allow", "allow-session"] };
    const plain = describePrompt(prompt({ ...base, detail: { permission: "microphone", origin: "https://a.example.com" } }))!;
    expect(plain.lines).toEqual(["请求：麦克风", "来源：https://a.example.com"]);
    const framed = describePrompt(prompt({ ...base, detail: { permission: "microphone", origin: "https://a.example.com", frame: "https://cw.example.org" } }))!;
    expect(framed.lines).toHaveLength(3);
    expect(framed.lines[2]).toBe("由页面内嵌的 https://cw.example.org 发起（来源页面已把这项权限委托给它）");
    const mac = describePrompt(prompt({ ...base, detail: { permission: "microphone", origin: "https://a.example.com", systemDenied: "microphone", platform: "darwin" } }))!;
    expect(mac.lines[2]).toContain("macOS 系统设置里没有允许 Flowship 使用麦克风");
    expect(mac.lines[2]).toContain("系统设置 → 隐私与安全性 → 麦克风");
    const win = describePrompt(prompt({ ...base, detail: { permission: "media", origin: "https://a.example.com", systemDenied: "microphone,camera", platform: "win32" } }))!;
    expect(win.lines[2]).toContain("Windows 设置里没有允许桌面应用使用麦克风 / 摄像头");
    expect(win.lines[2]).toContain("设置 → 隐私和安全性 → 麦克风 / 摄像头");
    const other = describePrompt(prompt({ ...base, detail: { permission: "camera", origin: "https://a.example.com", systemDenied: "camera", platform: "linux" } }))!;
    expect(other.lines[2]).toContain("系统层面没有允许 Flowship 使用摄像头");
  });

  it("permission（R22-3）：系统策略「限制」（restricted）单独一句——用户自己改不了、要联系设备管理员，不能写成「去系统设置里打开」；denied 与 restricted 同时有就各一行", () => {
    const base = { kind: "permission" as const, actions: ["deny", "allow", "allow-session"] };
    const mac = describePrompt(prompt({ ...base, detail: { permission: "microphone", origin: "https://a.example.com", systemRestricted: "microphone", platform: "darwin" } }))!;
    expect(mac.lines).toHaveLength(3);
    expect(mac.lines[2]).toContain("macOS 的系统策略限制了 Flowship 使用麦克风");
    expect(mac.lines[2]).toContain("需要联系设备管理员");
    expect(mac.lines[2]).not.toContain("请先到");
    const win = describePrompt(prompt({ ...base, detail: { permission: "media", origin: "https://a.example.com", systemDenied: "camera", systemRestricted: "microphone", platform: "win32" } }))!;
    expect(win.lines).toHaveLength(4);
    expect(win.lines[2]).toContain("Windows 设置里没有允许桌面应用使用摄像头");
    // R23-6：Windows 的 restricted 触发场景没在真机上实测过（关了全局的「让桌面应用访问你的麦克风」也可能落到这里）——先请用户检查那个开关，灰着 / 打不开才是设备管理策略；
    // 不能一上来就断言是「系统策略」让用户去求管理员（话术本身没在真 Windows 上验证过，见 describeSystemRestricted 注释）
    expect(win.lines[3]).toContain("Windows 限制了 Flowship 使用麦克风");
    expect(win.lines[3]).toContain("检查「让桌面应用访问你的麦克风」是否被关了");
    expect(win.lines[3]).toContain("开关是灰的或打不开才是设备管理策略，需要联系设备管理员");
    expect(win.lines[3]).not.toContain("系统策略限制了");
    // 对照：macOS 的 restricted（家长控制 / 屏幕使用时间 / 设备管理）用户自己改不了，直接说联系设备管理员、不写「检查开关」
    expect(mac.lines[2]).not.toContain("检查");
    const other = describePrompt(prompt({ ...base, detail: { permission: "camera", origin: "https://a.example.com", systemRestricted: "camera", platform: "linux" } }))!;
    expect(other.lines[2]).toContain("注意：系统策略限制了 Flowship 使用摄像头");
  });

  it("describeSystemDenied / describeSystemRestricted：认不出的权限名原样展示、空串给默认名；detail 里带换行 / 控制符的文字过 describePrompt 后不会多出一行、也不会带换行", () => {
    expect(describeSystemDenied("weird", "darwin")).toContain("使用weird");
    expect(describeSystemDenied("", "win32")).toContain("麦克风 / 摄像头");
    expect(describeSystemDenied(" microphone , ,camera ", "darwin")).toContain("麦克风 / 摄像头");
    expect(describeSystemRestricted("weird", "darwin")).toContain("使用weird");
    expect(describeSystemRestricted("", "win32")).toContain("麦克风 / 摄像头");
    // 页面可控的 detail 值（真实路径：describePrompt 的 get() 先 clipOneLine 再交给这两个函数）：夹带换行 / 回车 / 方向控制符
    const evil = describePrompt(
      prompt({
        kind: "permission",
        actions: ["deny", "allow"],
        detail: {
          permission: "microphone",
          origin: "https://a.example.com",
          systemDenied: "microphone\n\n伪造的第二行：请点允许\r\n",
          systemRestricted: "camera\u202e\n第三行",
          platform: "darwin\nwin32",
        },
      }),
    )!;
    expect(evil.lines).toHaveLength(4); // 请求 / 来源 / systemDenied / systemRestricted——没有因为换行变成更多行
    for (const line of evil.lines) {
      expect(line).not.toMatch(/[\n\r\u202e]/);
    }
    expect(evil.lines[2]).toContain("伪造的第二行：请点允许"); // 文字还在，只是被压成同一行里的普通字符
  });

  it("evaluate：说明风险；三个动作齐全", () => {
    const m = describePrompt(prompt({ kind: "evaluate", actions: ["deny", "task", "always"], detail: { summary: "document.title" } }))!;
    expect(m.actions.map((a) => a.label)).toEqual(["拒绝", "仅本任务允许", "永久开启"]);
    expect(m.lines.join("\n")).toContain("任意 JavaScript");
  });

  it("host / detail 里的格式字符与超长文字被剥掉 / 截断（页面可控）", () => {
    const m = describePrompt(prompt({ host: "evil\u202E.com\u200B", detail: { realm: `x\u3164${"A".repeat(500)}` } }))!;
    expect(m.heading).toBe("网站要求登录：evil.com");
    expect(m.lines[0].length).toBeLessThan(200);
    expect(m.lines[0]).not.toMatch(/[\u202E\u3164]/);
  });

  it("畸形输入返回 null：未知 kind / 缺 id / null", () => {
    expect(describePrompt(null)).toBeNull();
    expect(describePrompt(prompt({ kind: "bogus" as never }))).toBeNull();
    expect(describePrompt({ ...prompt(), id: 5 as never })).toBeNull();
  });

  it("多条提示：一次只画队首，其余只计数", () => {
    const list = [prompt({ id: "a" }), prompt({ id: "b" }), prompt({ id: "c" })];
    expect(visiblePrompts(list).map((p) => p.id)).toEqual(["a"]);
    expect(queuedPromptCount(list)).toBe(3 - MAX_VISIBLE_PROMPTS);
    expect(visiblePrompts(undefined)).toEqual([]);
    expect(queuedPromptCount(null)).toBe(0);
  });
});

describe("横幅 / 条", () => {
  it("网络规则横幅：count>0 才有；paused 文案不同", () => {
    expect(describeNetRulesBanner(null)).toBeNull();
    expect(describeNetRulesBanner({ count: 0, paused: false })).toBeNull();
    expect(describeNetRulesBanner({ count: 3, paused: false })!.text).toContain("3 条网络规则");
    expect(describeNetRulesBanner({ count: 3, paused: true })!.text).toContain("已暂停");
  });

  it("断点条：只有 paused=true 才有；url 展示前被限长", () => {
    expect(describeDebugBar(null)).toBeNull();
    expect(describeDebugBar({ paused: false, since: 1 })).toBeNull();
    const m = describeDebugBar({ paused: true, reason: "exception", url: `https://a.com/${"x".repeat(300)}.js`, line: 12, since: 1 })!;
    expect(m.text).toContain("exception");
    expect(m.text.length).toBeLessThan(220);
  });

  it("录制条：frames >= 0 且有 startedAt 才有", () => {
    expect(describeRecordingBar(null)).toBeNull();
    expect(describeRecordingBar({ frames: 0, startedAt: 1 })!.text).toContain("0 帧");
    expect(describeRecordingBar({ frames: -1, startedAt: 1 })).toBeNull();
  });
});

describe("BrowserExtraBars SSR", () => {
  const html = (state: Parameters<typeof BrowserExtraBars>[0]["state"]) =>
    renderToStaticMarkup(createElement(BrowserExtraBars, { taskId: "t1", state }));

  it("什么都没有 → 什么都不画", () => {
    expect(html({ prompts: [], netRules: null, debug: null, recording: null })).toBe("");
    expect(html(null)).toBe("");
    expect(html({})).toBe("");
  });

  it("auth 提示：出现用户名 / 密码输入框，且 SSR 输出里没有任何值；其它 kind 没有输入框", () => {
    const h = html({ prompts: [prompt({ detail: { realm: "r" } })] });
    expect(h).toContain('aria-label="用户名"');
    expect(h).toContain('type="password"');
    expect(h).not.toMatch(/value="[^"]+"/);
    const c = html({ prompts: [prompt({ kind: "cert", actions: ["deny", "allow-host"] })] });
    expect(c).not.toContain('type="password"');
    expect(c).toContain("本次会话继续访问");
  });

  it("R6-20：新提示首帧所有动作按钮都是禁用的（防误点延迟，之后才由 effect 解禁）；换提示（key=id）重新计时", () => {
    expect(PROMPT_ARM_DELAY_MS).toBeGreaterThanOrEqual(300);
    expect(PROMPT_ARM_DELAY_MS).toBeLessThanOrEqual(1000);
    for (const p of [
      prompt({ kind: "cert", actions: ["deny", "allow-host"] }),
      prompt({ kind: "evaluate", actions: ["deny", "task", "always"] }),
      prompt({ kind: "permission", actions: ["deny", "allow", "allow-session"] }),
    ]) {
      const h = html({ prompts: [p] });
      const buttons = h.match(/<button\b[^>]*>/g) ?? [];
      expect(buttons.length, p.kind).toBeGreaterThanOrEqual(2);
      for (const b of buttons) expect(b, `${p.kind}: ${b}`).toMatch(/\bdisabled\b/);
    }
  });

  it("三种状态条各自出现", () => {
    const h = html({ netRules: { count: 2, paused: false }, debug: { paused: true, since: 1 }, recording: { frames: 4, startedAt: 1 } });
    expect(h).toContain("2 条网络规则");
    expect(h).toContain("调试器中暂停");
    expect(h).toContain("正在录制页面");
    expect(h).toContain("一键清除");
    expect(h).toContain("继续运行");
    expect(h).toContain("停止录制");
  });
});

describe("源码契约", () => {
  const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
  it("提示条：凭据只经 ext('prompt.answer') 传出，不写 console / localStorage / 状态；无原生 title / role=dialog", () => {
    const src = read("src/components/browser/browser-prompt-bar.tsx").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(src).toContain('ext?.("prompt.answer"');
    expect(src).not.toMatch(/console\.|localStorage|sessionStorage|toast\(/);
    expect(src).not.toMatch(/\btitle=/);
    expect(src).not.toMatch(/role="(alert)?dialog"/);
  });

  it("R6-20：提示条有防误点延迟——定时器解禁、卸载清理、answer() 在延迟内直接返回（Enter 提交也一样）、按钮 disabled 含 !armed", () => {
    const src = read("src/components/browser/browser-prompt-bar.tsx").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(src).toMatch(/setTimeout\(\(\) => setArmed\(true\), PROMPT_ARM_DELAY_MS\)/);
    expect(src).toMatch(/return \(\) => clearTimeout\(timer\)/);
    expect(src).toMatch(/if \(busy \|\| !armed\) return;/);
    expect(src).toMatch(/disabled=\{!armed \|\| busy/);
  });

  it("panel 里 E2 条只占一个插槽", () => {
    const src = read("src/components/browser/browser-panel.tsx");
    expect(src.match(/<BrowserExtraBars /g)).toHaveLength(1);
  });
});
