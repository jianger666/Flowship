/**
 * R7-12-B2：`components/browser/open-in-builtin.ts`（把 `lib/builtin-open` 的注入依赖接到 window / 设置 / 面板桥 / toast 的胶水）的运行时行为。
 *
 * 决策与流程本身在 lib/builtin-open（有大量单测）；这里钉住「接线」——用真模块、mock 掉叶子依赖（设置 / 面板桥 / 系统打开 / toast）、
 * stub `window`。对应 reviewer 的存活变异：openInBuiltin 不带 newTab、`serve.call(bridge)` 丢 this、系统打开失败被吞、桥 / 任务 / serve 就绪判断失效、
 * 站内地址预判失效（app 恒 null / port 恒空）、notify 的 error / info 对调、设置不归一化。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  settings: { linkOpenMode: undefined as unknown },
  taskId: "task-1" as string | null,
  requestOpenInActiveBrowser: vi.fn(),
  requestOpenLocalPath: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock("sonner", () => ({ toast: h.toast }));
vi.mock("@/lib/local-store", () => ({ getSettings: () => h.settings }));
vi.mock("@/lib/local-file-open", () => ({ requestOpenLocalPath: (...a: unknown[]) => h.requestOpenLocalPath(...a) }));
vi.mock("@/components/browser/browser-panel-bridge", () => ({
  getActiveBrowserTaskId: () => h.taskId,
  requestOpenInActiveBrowser: (...a: unknown[]) => h.requestOpenInActiveBrowser(...a),
}));

import { openHttpInBuiltin, openHttpInSystem, openLocalHtmlInBuiltin, readLinkOpenMode } from "@/components/browser/open-in-builtin";

type Win = {
  __browser?: unknown;
  __shell?: unknown;
  location?: { hostname: string; port: string };
  open?: ReturnType<typeof vi.fn>;
};
const setWindow = (w: Win = {}) => {
  const win = { location: { hostname: "flowship.local", port: "8876" }, open: vi.fn(), ...w };
  vi.stubGlobal("window", win);
  return win;
};
const bridge = (over: Record<string, unknown> = {}) => ({ newTab: vi.fn(), ...over });

const HTTP = "https://example.com/docs";
const HTML = "/Users/me/site/index.html";

beforeEach(() => {
  h.settings.linkOpenMode = undefined;
  h.taskId = "task-1";
  h.requestOpenInActiveBrowser.mockReset().mockReturnValue(true);
  h.requestOpenLocalPath.mockReset().mockResolvedValue(undefined);
  for (const f of Object.values(h.toast)) f.mockReset();
  vi.unstubAllGlobals();
});

describe("readLinkOpenMode：设置值归一化", () => {
  it.each([
    [undefined, "builtin"],
    ["builtin", "builtin"],
    ["system", "system"],
    ["weird", "builtin"],
    ["SYSTEM", "builtin"],
    [42, "builtin"],
    [null, "builtin"],
  ])("settings.linkOpenMode = %j → %s（只认显式 'system'，脏值默认内置）", (raw, expected) => {
    h.settings.linkOpenMode = raw;
    expect(readLinkOpenMode()).toBe(expected);
  });
});

describe("openHttpInBuiltin：环境就绪判断与新标签意图", () => {
  it("一切就绪 → builtin，并且以 { newTab: true } 请求当前任务的浏览器面板（不是覆盖当前标签）", () => {
    setWindow({ __browser: bridge() });
    expect(openHttpInBuiltin(HTTP)).toBe("builtin");
    expect(h.requestOpenInActiveBrowser).toHaveBeenCalledTimes(1);
    expect(h.requestOpenInActiveBrowser).toHaveBeenCalledWith(HTTP, { newTab: true });
  });

  it.each([
    ["没有 window.__browser（网页版 / 非 Electron）", undefined],
    ["__browser 存在但没有 newTab（壳太旧）", {}],
    ["newTab 不是函数", { newTab: "yes" }],
  ])("%s → system，不请求面板", (_n, b) => {
    setWindow({ __browser: b });
    expect(openHttpInBuiltin(HTTP)).toBe("system");
    expect(h.requestOpenInActiveBrowser).not.toHaveBeenCalled();
  });

  it("window 整个不存在（SSR / node）→ system，不抛", () => {
    vi.stubGlobal("window", undefined);
    expect(openHttpInBuiltin(HTTP)).toBe("system");
    expect(h.requestOpenInActiveBrowser).not.toHaveBeenCalled();
  });

  it("当前页面没有任务上下文 → system", () => {
    setWindow({ __browser: bridge() });
    h.taskId = null;
    expect(openHttpInBuiltin(HTTP)).toBe("system");
    expect(h.requestOpenInActiveBrowser).not.toHaveBeenCalled();
  });

  it("设置 = 系统 → system；设置 = 脏值 → 按默认内置", () => {
    setWindow({ __browser: bridge() });
    h.settings.linkOpenMode = "system";
    expect(openHttpInBuiltin(HTTP)).toBe("system");
    h.settings.linkOpenMode = "weird";
    expect(openHttpInBuiltin(HTTP)).toBe("builtin");
  });

  it("forceBuiltin：无视「系统」设置；授权类链接也不再悄悄回退（explicit）；不带 forceBuiltin 时授权链接回退系统", () => {
    setWindow({ __browser: bridge() });
    const AUTH = "https://sso.corp.example.com/login";
    expect(openHttpInBuiltin(AUTH)).toBe("system");
    h.settings.linkOpenMode = "system";
    expect(openHttpInBuiltin(HTTP, { forceBuiltin: true })).toBe("builtin");
    expect(openHttpInBuiltin(AUTH, { forceBuiltin: true })).toBe("builtin");
    expect(openHttpInBuiltin(HTTP, { forceBuiltin: false })).toBe("system"); // 只有严格的 true 才强制
  });

  it("站内地址（和当前页面同端口 + 回环 / 同主机名）→ system，不请求面板；换个端口 → builtin（app 取自 window.location 的主机名与端口）", () => {
    setWindow({ __browser: bridge(), location: { hostname: "flowship.local", port: "8876" } });
    expect(openHttpInBuiltin("http://flowship.local:8876/tasks/1")).toBe("system");
    expect(h.requestOpenInActiveBrowser).not.toHaveBeenCalled();
    expect(openHttpInBuiltin("http://flowship.local:3000/")).toBe("builtin");
    expect(h.requestOpenInActiveBrowser).toHaveBeenCalledTimes(1);
    // 主机不同、端口相同也不算站内
    expect(openHttpInBuiltin("http://other.example.com:8876/")).toBe("builtin");
  });

  it("决策时有任务、真发请求时面板已经没人接单（requestOpenInActiveBrowser 返回 false）→ 当作 system，别吞掉点击", () => {
    setWindow({ __browser: bridge() });
    h.requestOpenInActiveBrowser.mockReturnValue(false);
    expect(openHttpInBuiltin(HTTP)).toBe("system");
  });
});

describe("openLocalHtmlInBuiltin：本地 HTML", () => {
  const served = { ok: true as const, url: "http://abc.localhost:1234/index.html", scope: "dir" as const };

  it("serveLocalHtml 是以 window.__browser 为 this 调用的（丢了 this 在真桥上会抛）；成功 → 以 newTab 打开返回的地址", async () => {
    const seen: unknown[] = []; // 用数组收（直接 `x = this` 会被 no-this-alias 拦）
    const b = bridge({
      serveLocalHtml: vi.fn(function (this: unknown, p: string) {
        seen.push(this);
        expect(p).toBe(HTML);
        if (this !== b) throw new Error("this 丢了");
        return Promise.resolve(served);
      }),
    });
    setWindow({ __browser: b });
    expect(await openLocalHtmlInBuiltin(HTML)).toBe("builtin");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(b);
    expect(h.requestOpenInActiveBrowser).toHaveBeenCalledWith(served.url, { newTab: true });
    expect(h.requestOpenLocalPath).not.toHaveBeenCalled();
    expect(h.toast.info).not.toHaveBeenCalled();
    expect(h.toast.error).not.toHaveBeenCalled();
  });

  it("范围过宽（scope: file）→ 仍在内置浏览器打开，并用 toast.info 说明（不是 error）", async () => {
    setWindow({ __browser: bridge({ serveLocalHtml: vi.fn().mockResolvedValue({ ...served, scope: "file" }) }) });
    expect(await openLocalHtmlInBuiltin(HTML)).toBe("builtin");
    expect(h.toast.info).toHaveBeenCalledTimes(1);
    expect(h.toast.error).not.toHaveBeenCalled();
  });

  it("桥没有 serveLocalHtml → 不调它、直接系统打开（回退）；不弹「不支持」的提示", async () => {
    setWindow({ __browser: bridge() });
    expect(await openLocalHtmlInBuiltin(HTML)).toBe("system");
    expect(h.requestOpenLocalPath).toHaveBeenCalledWith(HTML);
    expect(h.requestOpenInActiveBrowser).not.toHaveBeenCalled();
    expect(h.toast.info).not.toHaveBeenCalled();
    expect(h.toast.error).not.toHaveBeenCalled();
  });

  it("没有 window.__browser / 没有任务 → 系统打开", async () => {
    setWindow({});
    expect(await openLocalHtmlInBuiltin(HTML)).toBe("system");
    setWindow({ __browser: bridge({ serveLocalHtml: vi.fn().mockResolvedValue(served) }) });
    h.taskId = null;
    expect(await openLocalHtmlInBuiltin(HTML)).toBe("system");
    expect(h.requestOpenLocalPath).toHaveBeenCalledTimes(2);
    expect(h.requestOpenInActiveBrowser).not.toHaveBeenCalled();
  });

  it("登记失败（{ ok:false }）→ toast.info（中性说明，不是 error）+ 回退系统默认应用", async () => {
    setWindow({ __browser: bridge({ serveLocalHtml: vi.fn().mockResolvedValue({ ok: false, error: "文件太大" }) }) });
    expect(await openLocalHtmlInBuiltin(HTML)).toBe("system");
    expect(h.toast.info).toHaveBeenCalledTimes(1);
    expect(String(h.toast.info.mock.calls[0]![0])).toContain("文件太大");
    expect(h.toast.error).not.toHaveBeenCalled();
    expect(h.requestOpenLocalPath).toHaveBeenCalledWith(HTML);
  });

  it("serveLocalHtml 抛错 → 同样回退系统打开（不外泄异常）", async () => {
    setWindow({ __browser: bridge({ serveLocalHtml: vi.fn().mockRejectedValue(new Error("ipc-boom")) }) });
    expect(await openLocalHtmlInBuiltin(HTML)).toBe("system");
    expect(String(h.toast.info.mock.calls[0]![0])).toContain("ipc-boom");
    expect(h.requestOpenLocalPath).toHaveBeenCalledWith(HTML);
  });

  it("系统打开本身失败 → 错误冒泡给调用方（由 LocalFileLink 去 toast），不能被吞", async () => {
    setWindow({});
    h.requestOpenLocalPath.mockRejectedValue(new Error("sys-open-failed"));
    await expect(openLocalHtmlInBuiltin(HTML)).rejects.toThrow("sys-open-failed");
    expect(h.requestOpenLocalPath).toHaveBeenCalledWith(HTML);
  });

  it("forceBuiltin：设置 = 系统时仍走内置", async () => {
    setWindow({ __browser: bridge({ serveLocalHtml: vi.fn().mockResolvedValue(served) }) });
    h.settings.linkOpenMode = "system";
    expect(await openLocalHtmlInBuiltin(HTML)).toBe("system");
    expect(await openLocalHtmlInBuiltin(HTML, { forceBuiltin: true })).toBe("builtin");
  });
});

describe("openHttpInSystem", () => {
  it("有壳的 openExternal → 用它（不再 window.open）", () => {
    const openExternal = vi.fn();
    const win = setWindow({ __shell: { openExternal } });
    openHttpInSystem(HTTP);
    expect(openExternal).toHaveBeenCalledWith(HTTP);
    expect(win.open).not.toHaveBeenCalled();
  });

  it("没有壳 / openExternal 不是函数 → window.open(url, '_blank', 'noopener,noreferrer')", () => {
    for (const shell of [undefined, {}, { openExternal: "x" }]) {
      const win = setWindow({ __shell: shell });
      openHttpInSystem(HTTP);
      expect(win.open).toHaveBeenCalledTimes(1);
      expect(win.open).toHaveBeenCalledWith(HTTP, "_blank", "noopener,noreferrer");
    }
  });
});
