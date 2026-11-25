/**
 * 用户侧「新建无痕标签页」流程（面板「更多」菜单）
 *
 * AI 侧早有 `browser_tabs new incognito:true`，用户这头此前没有入口。流程函数的依赖全部注入，这里用假的 open / onError 直接测行为；
 * 组件接线用源码契约守（主进程通道的行为见 tests/browser-e2-p2-incognito.test.ts「用户侧 browser:newIncognitoTab」）。
 * 最要紧的一条：老壳没有 `newIncognitoTab` 时**不画入口、绝不退化成 newTab**——那会悄悄开出持久标签，用户以为无痕、登录态却写进持久档案。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { INCOGNITO_TAB_HINT } from "@/components/browser/browser-status";
import {
  canOpenIncognitoTab,
  OPEN_INCOGNITO_FALLBACK_ERROR,
  runOpenIncognitoTab,
  type IncognitoTabDeps,
} from "@/components/browser/incognito-flow";
import type { NewIncognitoTabResult } from "@/lib/browser-bridge-types";

describe("canOpenIncognitoTab：桥上有 newIncognitoTab 函数才画入口", () => {
  it("有函数 → true", () => {
    expect(canOpenIncognitoTab({ newIncognitoTab: async () => ({ ok: true, tabId: "t1" }) })).toBe(true);
  });

  it.each([
    ["没有桥（网页版 / SSR）", undefined],
    ["null", null],
    ["老壳：桥在但没有这个方法", {}],
    ["不是函数", { newIncognitoTab: "yes" } as never],
  ])("%s → false", (_name, bridge) => {
    expect(canOpenIncognitoTab(bridge as never)).toBe(false);
  });
});

describe("runOpenIncognitoTab", () => {
  const make = (open: IncognitoTabDeps["open"]) => {
    const onError = vi.fn();
    return { deps: { open, onError } satisfies IncognitoTabDeps, onError };
  };

  it("成功 → true，不报错", async () => {
    const { deps, onError } = make(async () => ({ ok: true, tabId: "t3" }));
    await expect(runOpenIncognitoTab(deps)).resolves.toBe(true);
    expect(onError).not.toHaveBeenCalled();
  });

  it("主进程返回 { ok:false, error }（标签页已达上限 / 地址被拒…）→ 原样把 error 交给 onError，返回 false", async () => {
    const { deps, onError } = make(async () => ({ ok: false, error: "标签页已达上限（20 个）：请先关闭不再需要的标签页" }));
    await expect(runOpenIncognitoTab(deps)).resolves.toBe(false);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith("标签页已达上限（20 个）：请先关闭不再需要的标签页");
  });

  it("error 为空白 / 缺失 → 兜底文案（不弹空 toast）", async () => {
    for (const res of [{ ok: false, error: "   " }, { ok: false }, { ok: false, error: 42 }]) {
      const { deps, onError } = make(async () => res as unknown as NewIncognitoTabResult);
      await expect(runOpenIncognitoTab(deps), JSON.stringify(res)).resolves.toBe(false);
      expect(onError, JSON.stringify(res)).toHaveBeenCalledWith(OPEN_INCOGNITO_FALLBACK_ERROR);
    }
  });

  it("IPC 本身 reject（壳异常 / 不可信发送者）→ 落到 onError、不向上抛（调用方是点击处理器）", async () => {
    const { deps, onError } = make(async () => {
      throw new Error("untrusted sender");
    });
    await expect(runOpenIncognitoTab(deps)).resolves.toBe(false);
    expect(onError).toHaveBeenCalledWith(`${OPEN_INCOGNITO_FALLBACK_ERROR}：untrusted sender`);
  });

  it("open 同步抛错 / 抛出非 Error 值 → 同样落到 onError", async () => {
    const sync = make(() => {
      throw new Error("sync boom");
    });
    await expect(runOpenIncognitoTab(sync.deps)).resolves.toBe(false);
    expect(sync.onError).toHaveBeenCalledWith(`${OPEN_INCOGNITO_FALLBACK_ERROR}：sync boom`);

    const weird = make(() => Promise.reject("字符串错误"));
    await expect(runOpenIncognitoTab(weird.deps)).resolves.toBe(false);
    expect(weird.onError).toHaveBeenCalledWith(`${OPEN_INCOGNITO_FALLBACK_ERROR}：字符串错误`);
  });

  it("没有桥（open 返回 undefined）/ 返回值形状不对 → 兜底文案，返回 false", async () => {
    for (const res of [undefined, null, "ok", 7, {}, { ok: "yes" }]) {
      const { deps, onError } = make(() => res as never);
      await expect(runOpenIncognitoTab(deps), String(res)).resolves.toBe(false);
      expect(onError, String(res)).toHaveBeenCalledWith(OPEN_INCOGNITO_FALLBACK_ERROR);
    }
  });

  it("open 只调一次（不重试：重试会多开一个无痕标签）", async () => {
    const open = vi.fn(async () => ({ ok: false as const, error: "x" }));
    await runOpenIncognitoTab({ open, onError: vi.fn() });
    expect(open).toHaveBeenCalledTimes(1);
  });
});

describe("接线（源码契约）", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  it("面板「更多」菜单：入口只在桥上有 newIncognitoTab 时才画，经 runOpenIncognitoTab 调桥的 newIncognitoTab，失败 toast", () => {
    const panel = strip(read("src/components/browser/browser-panel.tsx"));
    expect(panel).toMatch(/const canIncognito = canOpenIncognitoTab\(bridgeCaps\)/);
    expect(panel).toMatch(/open: \(\) => window\.__browser\?\.newIncognitoTab\?\.\(taskId\)/);
    expect(panel).toMatch(/onError: \(msg\) => toast\.error\(msg\)/);
    const gate = panel.indexOf("{canIncognito && (");
    const label = panel.indexOf("新建无痕标签页");
    expect(gate, "入口应包在 {canIncognito && (…)} 里").toBeGreaterThan(0);
    expect(label, "菜单项文案应在 canIncognito 闸之内").toBeGreaterThan(gate);
    expect(label - gate, "文案应紧跟在闸后面（同一个菜单项）").toBeLessThan(400);
  });

  it("绝不退化成 newTab：面板里没有「用 newTab 开无痕」的路径", () => {
    const panel = strip(read("src/components/browser/browser-panel.tsx"));
    expect(panel).not.toMatch(/newTab\([^)]*incognito/i);
    expect(panel).not.toMatch(/incognito[^;\n]*newTab\(/i);
    // 唯一的 newTab 调用点仍是 + 按钮与「在新标签打开」，都没带无痕语义
    for (const m of panel.matchAll(/\bnewTab\(([^)]*)\)/g)) expect(m[1], m[0]).not.toMatch(/incognito|true/i);
  });

  it("flow 模块不依赖 React / window（纯逻辑，可在 node 里测）", () => {
    const flow = strip(read("src/components/browser/incognito-flow.ts"));
    expect(flow).not.toMatch(/from "react"|\bwindow\b|document\./);
  });

  it("无痕标签的提示里有实话：同一会话里 AI 仍能看到并操作它（无痕 = 隔离登录环境，不是对 AI 保密）", () => {
    expect(INCOGNITO_TAB_HINT).toContain("AI 仍可看到并操作它");
    expect(INCOGNITO_TAB_HINT).toContain("不共享登录态");
    expect(INCOGNITO_TAB_HINT).toContain("关闭即销毁");
  });
});
