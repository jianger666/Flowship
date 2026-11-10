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
