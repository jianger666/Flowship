/**
 * 内置浏览器桥 `window.__browser`（electron-app/preload.cjs）契约测试（docs/BROWSER-AUTOMATION.md §5 / §8.2）。
 *
 * 读源码字面钉住（preload 在 sandbox 里跑、依赖 electron，不能直接 import 进 vitest）：
 * - BrowserBridge 的 20 个方法一个不少，每个方法对应的 IPC 通道名 / 收发方式与 §8.2 一致
 *   （高频 setBounds 与无返回值的动作走 send；有返回值的走 invoke；onState / onPicked 走 on + 返回取消订阅函数）
 * - 只在主窗口暴露：preload.cjs 只被主窗 createWindow 引用一次；浏览器 view（electron-app/browser/*.mjs）一律不设 preload
 * - 不动其它已有桥
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

const preload = read("electron-app/preload.cjs");
const mainSrc = read("electron-app/main.js");
const doc = read("docs/BROWSER-AUTOMATION.md");

/** __browser 桥的源码块：从 exposeInMainWorld("__browser" 到下一个 exposeInMainWorld（或文件尾） */
const bridgeBlock = (() => {
  const start = preload.indexOf('contextBridge.exposeInMainWorld("__browser", {');
  expect(start, "preload.cjs 里应有 __browser 桥").toBeGreaterThan(0);
  const next = preload.indexOf("contextBridge.exposeInMainWorld(", start + 10);
  return preload.slice(start, next === -1 ? undefined : next);
})();

/** 方法 → [收发方式, 通道名]（契约 §5 BrowserBridge 与 §8.2 通道名一一对应） */
const METHODS: Record<string, ["send" | "invoke", string]> = {
  attach: ["invoke", "browser:attach"],
  setBounds: ["send", "browser:setBounds"], // 高频：不等返回
  detach: ["send", "browser:detach"],
  setCovered: ["invoke", "browser:setCovered"],
  navigate: ["invoke", "browser:navigate"],
  back: ["send", "browser:back"],
  forward: ["send", "browser:forward"],
  reload: ["send", "browser:reload"],
  stop: ["send", "browser:stop"],
  newTab: ["invoke", "browser:newTab"],
  selectTab: ["send", "browser:selectTab"],
  closeTab: ["send", "browser:closeTab"],
  takeover: ["send", "browser:takeover"],
  handback: ["send", "browser:handback"],
  answerAsk: ["send", "browser:answerAsk"],
  startPick: ["send", "browser:startPick"],
  cancelPick: ["send", "browser:cancelPick"],
  getState: ["invoke", "browser:getState"],
  clearBrowsingData: ["invoke", "browser:clearBrowsingData"],
};
const PUSH_METHODS: Record<string, string> = { onState: "browser:state", onPicked: "browser:picked" };

/** V4 用户侧新增（契约 §14.3；实现在 electron-app/browser/user-features.mjs）：请求类 / 推送类 */
const V4_METHODS: Record<string, ["send" | "invoke", string]> = {
  zoom: ["send", "browser:zoom"],
  find: ["send", "browser:find"],
  stopFind: ["send", "browser:stopFind"],
  openDevTools: ["send", "browser:openDevTools"],
  revealDownload: ["invoke", "browser:revealDownload"], // 有返回值：{ ok, error? }
  openDownload: ["invoke", "browser:openDownload"],
  answerDialog: ["send", "browser:answerDialog"],
  resetEmulation: ["send", "browser:resetEmulation"],
};
/** 增强包 E2（契约 §15.1）：通用扩展通道，主进程按名字白名单分发（名字未登记会 reject） */
const E2_METHODS: Record<string, ["send" | "invoke", string]> = {
  ext: ["invoke", "browser:ext"],
};
/** R7：本地 HTML 默认走内置浏览器（实现在 electron-app/browser/local-html-server.mjs；不在契约 §8.2 / §14.3 的清单里） */
const R7_METHODS: Record<string, ["send" | "invoke", string]> = {
  serveLocalHtml: ["invoke", "browser:serveLocalHtml"],
};
/** V4 推送：onFound 的 payload 是单个对象 { taskId, activeMatchOrdinal, matches }；onFindRequested 的 payload 是 taskId */
const V4_PUSH: Record<string, { channel: string; listener: string }> = {
  onFound: { channel: "browser:found", listener: "const listener = (_event, found) => callback(found);" },
  onFindRequested: { channel: "browser:findRequested", listener: "const listener = (_event, taskId) => callback(taskId);" },
};

describe("preload.cjs：window.__browser 方法与通道", () => {
  it("暴露名恰为 __browser，且只暴露一次", () => {
    expect(preload.match(/exposeInMainWorld\("__browser"/g)?.length).toBe(1);
  });

  it("契约 §5 BrowserBridge 的方法齐全（19 个请求方法 + onState / onPicked）", () => {
    const declared = [
      ...(doc.match(/interface BrowserBridge \{[\s\S]*?\n\}/)?.[0] ?? "").matchAll(/(?:^|[\s;])(\w+)\(/gm),
    ].map((m) => m[1]);
    // 契约里列出的方法名（去重）必须都在 preload 里
    const expectedNames = new Set([...Object.keys(METHODS), ...Object.keys(PUSH_METHODS)]);
    for (const name of expectedNames) expect(bridgeBlock, name).toMatch(new RegExp(`\\b${name}:\\s*\\(`));
    // 反过来：契约里每个方法（排除 onState/onPicked 的回调签名噪声）都被覆盖
    for (const name of declared) {
      if (["cb", "taskId"].includes(name)) continue;
      expect(expectedNames.has(name), `契约方法 ${name} 没被本测试 / preload 覆盖`).toBe(true);
    }
    expect(expectedNames.size).toBe(21);
  });

  for (const [name, [kind, channel]] of Object.entries(METHODS)) {
    it(`${name}：ipcRenderer.${kind}("${channel}", …)`, () => {
      const re = new RegExp(`\\b${name}:\\s*\\([^)]*\\)\\s*=>\\s*ipcRenderer\\.(send|invoke)\\("(browser:\\w+)"`);
      const m = re.exec(bridgeBlock);
      expect(m, `${name} 应是单行 arrow 直接调 ipcRenderer.send/invoke`).not.toBeNull();
      expect(m![1]).toBe(kind);
      expect(m![2]).toBe(channel);
    });
  }

  for (const [name, channel] of Object.entries(PUSH_METHODS)) {
    it(`${name}：ipcRenderer.on("${channel}") 订阅 + 返回取消订阅函数（removeListener 同一个 listener）`, () => {
      const start = bridgeBlock.indexOf(`${name}: (callback) => {`);
      expect(start, `${name} 应是 (callback) => { … }`).toBeGreaterThan(0);
      const body = bridgeBlock.slice(start, bridgeBlock.indexOf("\n  },", start));
      expect(body).toContain(`ipcRenderer.on("${channel}", listener);`);
      expect(body).toContain(`return () => ipcRenderer.removeListener("${channel}", listener);`);
      // 主进程推的是 (event, taskId, payload)：listener 要丢掉 event、把 taskId 与 payload 原样交给回调
      expect(body).toMatch(/const listener = \(_event, taskId, \w+\) => callback\(taskId, \w+\);/);
    });
  }

  it("setBounds 是 send、不是 invoke（高频、不等返回）；有返回值的方法才用 invoke", () => {
    expect(bridgeBlock).toMatch(/setBounds:[^\n]*ipcRenderer\.send\("browser:setBounds"/);
    expect(bridgeBlock).not.toMatch(/ipcRenderer\.invoke\("browser:setBounds"/);
  });

  it("通道名集合与契约 §8.2 的「IPC 通道名」清单完全一致（请求 18 条 + 推送 2 条）", () => {
    const line = doc.split("\n").find((l) => l.includes("**IPC 通道名**"));
    expect(line, "契约 §8.2 应有「IPC 通道名」条目").toBeTruthy();
    const docChannels = new Set([...line!.matchAll(/`(browser:\w+)`/g)].map((m) => m[1]));
    // V4 的通道不在 §8.2 那一行里（它们在 §14.3），单独列清单；preload 里的通道 = §8.2 清单 ∪ V4 清单，不许多也不许少
    const v4Channels = [...Object.values(V4_METHODS).map(([, c]) => c), ...Object.values(V4_PUSH).map((p) => p.channel)];
    const preloadChannels = new Set([...bridgeBlock.matchAll(/"(browser:\w+)"/g)].map((m) => m[1]));
    const e2Channels = Object.values(E2_METHODS).map(([, c]) => c);
    const r7Channels = Object.values(R7_METHODS).map(([, c]) => c);
    expect([...preloadChannels].sort()).toEqual([...docChannels, ...v4Channels, ...e2Channels, ...r7Channels].sort());
    expect(docChannels.size).toBe(Object.keys(METHODS).length + Object.keys(PUSH_METHODS).length);
    expect(v4Channels.length).toBe(10);
  });

  it("bridge 里不出现 ipcRenderer 以外的能力（不 require 别的模块、不暴露 ipcRenderer 本身）", () => {
    expect(bridgeBlock).not.toMatch(/require\(/);
    expect(bridgeBlock).not.toMatch(/:\s*ipcRenderer\s*[,}]/);
    expect(bridgeBlock).not.toMatch(/\bremote\b/);
  });
});

describe("preload.cjs：V4 用户侧新增方法（契约 §14.3）", () => {
  for (const [name, [kind, channel]] of Object.entries(V4_METHODS)) {
    it(`${name}：ipcRenderer.${kind}("${channel}", …)`, () => {
      const re = new RegExp(`\\b${name}:\\s*\\([^)]*\\)\\s*=>\\s*ipcRenderer\\.(send|invoke)\\("(browser:\\w+)"`);
      const m = re.exec(bridgeBlock);
      expect(m, `${name} 应是单行 arrow 直接调 ipcRenderer.send/invoke`).not.toBeNull();
      expect(m![1]).toBe(kind);
      expect(m![2]).toBe(channel);
    });
  }

  for (const [name, { channel, listener }] of Object.entries(V4_PUSH)) {
    it(`${name}：ipcRenderer.on("${channel}") 订阅 + 返回取消订阅函数`, () => {
      const start = bridgeBlock.indexOf(`${name}: (callback) => {`);
      expect(start, `${name} 应是 (callback) => { … }`).toBeGreaterThan(0);
      const body = bridgeBlock.slice(start, bridgeBlock.indexOf("\n  },", start));
      expect(body).toContain(`ipcRenderer.on("${channel}", listener);`);
      expect(body).toContain(`return () => ipcRenderer.removeListener("${channel}", listener);`);
      expect(body).toContain(listener);
    });
  }

  it("下载只传 (taskId, id)：preload 的 revealDownload / openDownload 不带路径参数", () => {
    expect(bridgeBlock).toMatch(/revealDownload: \(taskId, id\) =>/);
    expect(bridgeBlock).toMatch(/openDownload: \(taskId, id\) =>/);
  });

  it("window.__browser 的类型声明里有 V4 方法（可选方法：老壳没有时 UI 要容忍）", () => {
    const types = read("src/lib/browser-bridge-types.ts");
    for (const name of [...Object.keys(V4_METHODS), ...Object.keys(V4_PUSH)]) {
      expect(types, name).toMatch(new RegExp(`\\b${name}\\?\\(`));
    }
  });
});

describe("preload.cjs：增强包 E2 的通用扩展通道（契约 §15.1）", () => {
  for (const [name, [kind, channel]] of Object.entries(E2_METHODS)) {
    it(`${name}：ipcRenderer.${kind}("${channel}", name, taskId, ...args)`, () => {
      const re = new RegExp(`\\b${name}:\\s*\\(name, taskId, \\.\\.\\.args\\)\\s*=>\\s*ipcRenderer\\.(send|invoke)\\("(browser:\\w+)", name, taskId, \\.\\.\\.args\\)`);
      const m = re.exec(bridgeBlock);
      expect(m, `${name} 应是单行 arrow 直接转发 (name, taskId, ...args)`).not.toBeNull();
      expect(m![1]).toBe(kind);
      expect(m![2]).toBe(channel);
    });
  }

  it("window.__browser 的类型声明里有 ext（可选方法：老壳没有时 UI 要容忍）", () => {
    expect(read("src/lib/browser-bridge-types.ts")).toMatch(/\bext\?\(name: string, taskId: string/);
  });
});

describe("preload.cjs：R7 本地 HTML 通道", () => {
  for (const [name, [kind, channel]] of Object.entries(R7_METHODS)) {
    it(`${name}：ipcRenderer.${kind}("${channel}", absPath)，只转发一个路径参数`, () => {
      const re = new RegExp(`\\b${name}:\\s*\\(absPath\\)\\s*=>\\s*ipcRenderer\\.(send|invoke)\\("(browser:\\w+)", absPath\\)`);
      const m = re.exec(bridgeBlock);
      expect(m, `${name} 应是单行 arrow 直接转发 (absPath)`).not.toBeNull();
      expect(m![1]).toBe(kind);
      expect(m![2]).toBe(channel);
    });
  }

  it("window.__browser 的类型声明里有 serveLocalHtml（可选方法：老壳没有时 UI 要容忍）+ 结果类型", () => {
    const types = read("src/lib/browser-bridge-types.ts");
    expect(types).toMatch(/\bserveLocalHtml\?\(absPath: string\): Promise<ServeLocalHtmlResult>/);
    expect(types).toMatch(/ServeLocalHtmlResult =\s*\|?\s*\{ ok: true; url: string; scope: "dir" \| "file" \}\s*\|\s*\{ ok: false; error: string \}/);
  });
});

describe("不动其它已有桥", () => {
  it("原有 8 个桥一个不少", () => {
    for (const name of [
      "__nativePicker",
      "__appUpdater",
      "__notify",
      "__deepLink",
      "__closeConfirm",
      "__autoLaunch",
      "__menuBarIcon",
      "__shell",
    ]) {
      expect(preload, name).toContain(`contextBridge.exposeInMainWorld("${name}", {`);
    }
  });
});

describe("只在主窗口暴露", () => {
  it("main.js 里 preload.cjs 只被引用一次，且在主窗 createWindow 里（splash / 其它窗口都没有）", () => {
    const refs = [...mainSrc.matchAll(/preload\s*:\s*path\.join\(__dirname,\s*"preload\.cjs"\)/g)];
    expect(refs.length).toBe(1);
    const start = mainSrc.indexOf("const createWindow = async () => {");
    expect(start).toBeGreaterThan(0);
    const end = mainSrc.indexOf("\n};", start);
    expect(refs[0]!.index).toBeGreaterThan(start);
    expect(refs[0]!.index).toBeLessThan(end);
    expect(mainSrc.slice(start, refs[0]!.index)).toContain("mainWindow = new BrowserWindow({");
    // 整个 main.js 里没有 `preload.cjs` 的别的写法
    expect(mainSrc.match(/preload\.cjs/g)?.length).toBe(1);
  });

  it("浏览器 view / 停车场窗口（electron-app/browser/*.mjs）不设 preload：页面碰不到 window.__browser", () => {
    const dir = path.join(ROOT, "electron-app/browser");
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".mjs"))) {
      const src = readFileSync(path.join(dir, f), "utf8");
      // 去掉注释再查，避免「不设 preload」这样的说明文字误报
      const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      expect(code, `${f} 不应给 webPreferences 设 preload`).not.toMatch(/\bpreload\s*:/);
      expect(code, `${f} 不应引用 preload.cjs`).not.toContain("preload.cjs");
    }
  });
});
