/**
 * V4 用户侧主进程逻辑（electron-app/browser/user-features.mjs，契约 §14.3）：
 * 缩放步进与夹取 / 快捷键判定 / 右键菜单模板构造 / 「打开」扩展名白名单 / IPC 入口的可信校验与参数校验。
 * 全部是不依赖 electron 的纯逻辑 + 假 ipcMain / 假 tab；真 Electron 里的实际效果见 scripts/browser-e2e/v4-smoke.cjs。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  OPENABLE_EXTENSIONS,
  ZOOM_MAX_LEVEL,
  ZOOM_MIN_LEVEL,
  buildContextMenuTemplate,
  canOpenFile,
  classifyShortcut,
  clampZoomLevel,
  extensionOf,
  normalizeFindArgs,
  registerUserFeatures,
  stepZoomLevel,
  validDownloadId,
  validTaskId,
  validZoomAction,
  zoomLevelToPercent,
} from "../electron-app/browser/user-features.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");

describe("缩放：步进与夹取（−3…+5，步进 0.5）", () => {
  it("in / out 各走一步 0.5，reset 回 0", () => {
    expect(stepZoomLevel(0, "in")).toBe(0.5);
    expect(stepZoomLevel(0.5, "in")).toBe(1);
    expect(stepZoomLevel(0, "out")).toBe(-0.5);
    expect(stepZoomLevel(3.5, "reset")).toBe(0);
  });

  it("到头不动：上限 +5、下限 −3", () => {
    expect(stepZoomLevel(ZOOM_MAX_LEVEL, "in")).toBe(ZOOM_MAX_LEVEL);
    expect(stepZoomLevel(ZOOM_MIN_LEVEL, "out")).toBe(ZOOM_MIN_LEVEL);
    let l = 0;
    for (let i = 0; i < 50; i++) l = stepZoomLevel(l, "in");
    expect(l).toBe(5);
    for (let i = 0; i < 50; i++) l = stepZoomLevel(l, "out");
    expect(l).toBe(-3);
  });

  it("clampZoomLevel 吸附 0.5 网格并容忍脏值", () => {
    expect(clampZoomLevel(0.7)).toBe(0.5);
    expect(clampZoomLevel(9)).toBe(5);
    expect(clampZoomLevel(-9)).toBe(-3);
    expect(clampZoomLevel(Number.NaN)).toBe(0);
    expect(clampZoomLevel("1" as unknown as number)).toBe(0);
  });

  it("未知 action 不改 level", () => {
    expect(stepZoomLevel(1, "sideways")).toBe(1);
  });

  it("level → 百分比整数（1.2 ** level）", () => {
    expect(zoomLevelToPercent(0)).toBe(100);
    expect(zoomLevelToPercent(1)).toBe(120);
    expect(zoomLevelToPercent(-1)).toBe(83);
    expect(zoomLevelToPercent(5)).toBe(249);
    expect(zoomLevelToPercent(-3)).toBe(58);
  });
});

describe("快捷键判定（before-input-event 的 input）", () => {
  const kd = (key: string, extra: Record<string, boolean> = {}) => ({ type: "keyDown", key, ...extra });

  it("mac：Cmd + = / + / - / _ / 0 / F；Ctrl 不算", () => {
    expect(classifyShortcut(kd("=", { meta: true }), "darwin")).toEqual({ kind: "zoom", action: "in" });
    expect(classifyShortcut(kd("+", { meta: true, shift: true }), "darwin")).toEqual({ kind: "zoom", action: "in" });
    expect(classifyShortcut(kd("-", { meta: true }), "darwin")).toEqual({ kind: "zoom", action: "out" });
    expect(classifyShortcut(kd("_", { meta: true, shift: true }), "darwin")).toEqual({ kind: "zoom", action: "out" });
    expect(classifyShortcut(kd("0", { meta: true }), "darwin")).toEqual({ kind: "zoom", action: "reset" });
    expect(classifyShortcut(kd("f", { meta: true }), "darwin")).toEqual({ kind: "find" });
    expect(classifyShortcut(kd("=", { control: true }), "darwin")).toBeNull();
  });

  it("win / linux：Ctrl 才算，Cmd(meta) 不算", () => {
    expect(classifyShortcut(kd("=", { control: true }), "win32")).toEqual({ kind: "zoom", action: "in" });
    expect(classifyShortcut(kd("f", { control: true }), "linux")).toEqual({ kind: "find" });
    expect(classifyShortcut(kd("=", { meta: true }), "win32")).toBeNull();
  });

  it("刷新：Cmd/Ctrl+R = 普通刷新、加 Shift = 强刷（Shift 时 key 是大写 R）；平台修饰键规则同缩放", () => {
    expect(classifyShortcut(kd("r", { meta: true }), "darwin")).toEqual({ kind: "reload", force: false });
    expect(classifyShortcut(kd("R", { meta: true, shift: true }), "darwin")).toEqual({ kind: "reload", force: true });
    expect(classifyShortcut(kd("r", { meta: true, shift: true }), "darwin")).toEqual({ kind: "reload", force: true });
    expect(classifyShortcut(kd("r", { control: true }), "win32")).toEqual({ kind: "reload", force: false });
    expect(classifyShortcut(kd("R", { control: true, shift: true }), "linux")).toEqual({ kind: "reload", force: true });
    // 不是本平台的修饰键 / Cmd+Ctrl 同按 / 带 Alt / 没修饰键 / keyUp：不认
    expect(classifyShortcut(kd("r", { control: true }), "darwin")).toBeNull();
    expect(classifyShortcut(kd("r", { meta: true }), "win32")).toBeNull();
    expect(classifyShortcut(kd("r", { meta: true, control: true }), "darwin")).toBeNull();
    expect(classifyShortcut(kd("r", { meta: true, alt: true }), "darwin")).toBeNull();
    expect(classifyShortcut(kd("r"), "darwin")).toBeNull();
    expect(classifyShortcut({ type: "keyUp", key: "r", meta: true }, "darwin")).toBeNull();
  });

  it("没有修饰键 / 带 Alt / Cmd+Ctrl 同按 / keyUp / Shift+F / 无关键 一律不拦", () => {
    expect(classifyShortcut(kd("="), "darwin")).toBeNull();
    expect(classifyShortcut(kd("=", { meta: true, alt: true }), "darwin")).toBeNull();
    expect(classifyShortcut(kd("f", { meta: true, control: true }), "darwin")).toBeNull();
    expect(classifyShortcut({ type: "keyUp", key: "=", meta: true }, "darwin")).toBeNull();
    expect(classifyShortcut(kd("f", { meta: true, shift: true }), "darwin")).toBeNull();
    expect(classifyShortcut(kd("a", { meta: true }), "darwin")).toBeNull();
    expect(classifyShortcut(null, "darwin")).toBeNull();
  });
});

describe("「打开」扩展名白名单（打开 vs 仅显示，R1-23）", () => {
  // 原先是黑名单（契约 §14.3 的 18 项 + 27 项补充），开放式、总会漏。现在是白名单：不在名单里的一律只给「在文件夹中显示」。
  // R2-11：csv 已移出（Excel 公式注入），现在是 19 项
  const WHITELIST = "pdf png jpg jpeg gif webp txt json md log mp3 wav m4a mp4 webm mov docx xlsx pptx".split(" ");

  it("白名单恰好是约定的 19 项（增减都要有意识地改这里）", () => {
    expect([...OPENABLE_EXTENSIONS].sort()).toEqual([...WHITELIST].sort());
    expect(OPENABLE_EXTENSIONS.size).toBe(19);
  });

  it("R2-11：csv / tsv 等表格文本不能「打开」（Excel 会把页面决定的内容当公式执行），名单里恰好没有 csv", () => {
    expect(OPENABLE_EXTENSIONS.has("csv")).toBe(false);
    for (const n of ["data.csv", "DATA.CSV", "report.csv.", "report.csv ", "export.tsv", "a.pdf.csv", "a.csv:evil"]) {
      expect(canOpenFile(n), n).toBe(false);
    }
    // 其余文本类仍可打开：移出 csv 不能顺带误伤别的
    for (const n of ["notes.txt", "data.json", "readme.md", "server.log"]) expect(canOpenFile(n), n).toBe(true);
  });

  it("白名单里的扩展名可以打开：大小写不敏感、多段文件名取最后一段、Windows 末尾点 / 空格被忽略", () => {
    for (const e of WHITELIST) expect(canOpenFile(`report.${e}`), e).toBe(true);
    for (const n of ["a.PNG", "my.report.v2.docx", "DATA.XLSX", "notes.txt", "a.pdf.", "a.pdf ", "x.y.z.json"]) {
      expect(canOpenFile(n), n).toBe(true);
    }
  });

  it("契约 §14.3 原黑名单的 18 项 + 补充的 27 项：一个都不能打开（白名单天然覆盖）", () => {
    const contract = "exe msi bat cmd com scr ps1 sh command app dmg pkg jar vbs js jse wsf lnk".split(" ");
    const extra = "hta reg url pif vbe wsh wsc cpl inf msc msp mst ps1xml psm1 scpt scptd workflow terminal mpkg bash zsh ksh csh appref-ms gadget dll sys".split(" ");
    for (const e of [...contract, ...extra]) {
      expect(OPENABLE_EXTENSIONS.has(e), e).toBe(false);
      expect(canOpenFile(`x.${e}`), e).toBe(false);
    }
  });

  it("reviewer 点名的黑名单漏项（application / msix / appx / chm / scf / iso / py / html / svg / docm …）都不能打开", () => {
    const missed =
      "application msix appx msixbundle appxbundle chm scf library-ms settingcontent-ms rdp iso img vhd vhdx jnlp mobileconfig desktop deb rpm py pyw pl rb docm xlsm pptm xll html htm xhtml svg webloc diagcab swf php zip rar 7z".split(" ");
    for (const e of missed) expect(canOpenFile(`x.${e}`), e).toBe(false);
  });

  it("双扩展名 / 伪装：只看最后一段；Windows 末尾点 / 空格、NTFS 备用数据流写法都不能绕过", () => {
    for (const n of [
      "x.pdf.exe", "a.exe", "A.EXE", "setup.Msi", "run.sh", "evil.js", "a.exe.", "a.exe ", "a.exe. .", "tool.app", "x.dmg", "k.lnk",
      "invoice.pdf.html", "photo.png.svg", "doc.docx.docm",
      "a.pdf:evil.exe", // NTFS 备用数据流写法：最后一个点之后是 exe → 不在白名单
      "a.exe:pdf", // 扩展名取到「exe:pdf」，不在白名单（黑名单时代这种写法会被漏过）
      "report.pdf\u202Egpj.exe", // 右至左覆盖字符伪装：真实扩展名仍是 exe
    ]) {
      expect(canOpenFile(n), n).toBe(false);
    }
  });

  it("压缩包 / 不认识的类型 / 空扩展名：不能直接打开（只给在文件夹中显示）", () => {
    for (const n of ["pack.zip", "data.tar.gz", "unknown.xyz", "movie.mkv", "book.epub", "archive.7z"]) {
      expect(canOpenFile(n), n).toBe(false);
    }
  });

  it("没有扩展名（可能是 Unix 可执行文件）/ 隐藏文件 / 结尾是点：不给打开", () => {
    expect(canOpenFile("README")).toBe(false);
    expect(canOpenFile(".bashrc")).toBe(false);
    expect(canOpenFile("file.")).toBe(false);
    expect(canOpenFile("")).toBe(false);
  });

  it("extensionOf 只看最后一段文件名，不被路径里的点骗到", () => {
    expect(extensionOf("/tmp/a.b/c")).toBe("");
    expect(extensionOf("/tmp/a.b/c.TXT")).toBe("txt");
  });
});

describe("右键菜单模板构造（params → 模板）", () => {
  const base = { canGoBack: true, canGoForward: false, inspectEnabled: true };
  const calls: Array<[string, unknown[]]> = [];
  const actions = new Proxy({} as Record<string, (...a: unknown[]) => void>, {
    get: (_t, id: string) => (...a: unknown[]) => void calls.push([id, a]),
  });
  const ids = (t: Array<{ id?: string }>) => t.filter((i) => i.id).map((i) => i.id);

  it("普通页面空白处：全选 + 后退 / 前进 / 刷新 + 检查元素；后退可用、前进置灰", () => {
    const t = buildContextMenuTemplate({ x: 1, y: 2, isEditable: false, editFlags: {} }, { ...base, actions });
    expect(ids(t)).toEqual(["selectAll", "back", "forward", "reload", "inspect"]);
    expect(t.find((i) => i.id === "back")?.enabled).toBe(true);
    expect(t.find((i) => i.id === "forward")?.enabled).toBe(false);
    // 组之间有分隔线、不以分隔线开头或结尾
    expect(t[0]).not.toEqual({ type: "separator" });
    expect(t.at(-1)).not.toEqual({ type: "separator" });
    expect(t.filter((i: { type?: string }) => i.type === "separator").length).toBe(2);
  });

  it("选中文字：多一个「复制」", () => {
    const t = buildContextMenuTemplate(
      { selectionText: "你好", isEditable: false, editFlags: { canCopy: true } },
      { ...base, actions },
    );
    expect(ids(t)).toContain("copy");
  });

  it("链接：策略放行才给「在新标签页打开链接」，复制链接地址始终有；点击带上链接参数", () => {
    calls.length = 0;
    const ok = buildContextMenuTemplate(
      { linkURL: "https://example.com/a", editFlags: {} },
      { ...base, linkVerdict: { ok: true }, actions },
    );
    expect(ids(ok).slice(0, 2)).toEqual(["openLink", "copyLink"]);
    ok.find((i) => i.id === "openLink")!.click!();
    ok.find((i) => i.id === "copyLink")!.click!();
    expect(calls).toEqual([
      ["openLink", ["https://example.com/a"]],
      ["copyLink", ["https://example.com/a"]],
    ]);

    const blocked = buildContextMenuTemplate(
      { linkURL: "http://127.0.0.1:8876/x", editFlags: {} },
      { ...base, linkVerdict: { ok: false }, actions },
    );
    expect(ids(blocked)).not.toContain("openLink");
    expect(ids(blocked)).toContain("copyLink");
    // 没传 verdict（调用方漏了）也按「不放行」处理：宁可少一个菜单项
    const noVerdict = buildContextMenuTemplate({ linkURL: "https://e.com", editFlags: {} }, { ...base, actions });
    expect(ids(noVerdict)).not.toContain("openLink");
  });

  it("图片：复制图片（带坐标）+ 仅 http(s) 的「复制图片地址」；data: 不给", () => {
    calls.length = 0;
    const t = buildContextMenuTemplate(
      { x: 7, y: 8, mediaType: "image", srcURL: "https://e.com/a.png", editFlags: {} },
      { ...base, actions },
    );
    expect(ids(t)).toEqual(expect.arrayContaining(["copyImage", "copyImageUrl"]));
    t.find((i) => i.id === "copyImage")!.click!();
    expect(calls[0]).toEqual(["copyImage", [7, 8]]);
    const d = buildContextMenuTemplate(
      { mediaType: "image", srcURL: "data:image/png;base64,AAAA", editFlags: {} },
      { ...base, actions },
    );
    expect(ids(d)).toContain("copyImage");
    expect(ids(d)).not.toContain("copyImageUrl");
  });

  it("输入框：剪切 / 复制 / 粘贴 / 全选 按 editFlags 置灰，且不出后退 / 前进 / 刷新", () => {
    const t = buildContextMenuTemplate(
      { isEditable: true, editFlags: { canCut: false, canCopy: true, canPaste: true, canSelectAll: true } },
      { ...base, actions },
    );
    expect(ids(t)).toEqual(["cut", "copy", "paste", "selectAll", "inspect"]);
    expect(t.find((i) => i.id === "cut")?.enabled).toBe(false);
    expect(t.find((i) => i.id === "paste")?.enabled).toBe(true);
  });

  it("inspectEnabled=false 不出「检查元素」；检查元素点击带坐标", () => {
    const off = buildContextMenuTemplate({ editFlags: {} }, { ...base, inspectEnabled: false, actions });
    expect(ids(off)).not.toContain("inspect");
    calls.length = 0;
    const on = buildContextMenuTemplate({ x: 3, y: 4, editFlags: {} }, { ...base, actions });
    on.find((i) => i.id === "inspect")!.click!();
    expect(calls[0]).toEqual(["inspect", [3, 4]]);
  });

  it("params 缺失 / 脏数据不抛", () => {
    expect(() => buildContextMenuTemplate(undefined, { ...base, actions })).not.toThrow();
    expect(() => buildContextMenuTemplate({ linkURL: 5, srcURL: {}, mediaType: "image" }, { ...base, actions })).not.toThrow();
  });
});

describe("IPC 参数校验（纯函数）", () => {
  it("taskId / 下载 id / 缩放 action", () => {
    expect(validTaskId("t1")).toBe(true);
    expect(validTaskId("")).toBe(false);
    expect(validTaskId("x".repeat(201))).toBe(false);
    expect(validTaskId(5)).toBe(false);
    expect(validDownloadId(0)).toBe(true);
    expect(validDownloadId(12)).toBe(true);
    expect(validDownloadId(-1)).toBe(false);
    expect(validDownloadId(1.5)).toBe(false);
    expect(validDownloadId("1")).toBe(false);
    expect(validZoomAction("in")).toBe(true);
    expect(validZoomAction("reset")).toBe(true);
    expect(validZoomAction("IN")).toBe(false);
    expect(validZoomAction(1)).toBe(false);
  });

  it("find 参数：text 必须是字符串、截到 500；opts 只认三个布尔，其余丢弃", () => {
    expect(normalizeFindArgs(42, {})).toBeNull();
    expect(normalizeFindArgs({ evil: 1 }, {})).toBeNull();
    expect(normalizeFindArgs("a".repeat(900), {})!.text.length).toBe(500);
    expect(normalizeFindArgs("x", undefined)).toEqual({ text: "x", forward: true, findNext: false, matchCase: false });
    expect(normalizeFindArgs("x", { forward: false, findNext: true, matchCase: true, evil: "rm" } as never)).toEqual({
      text: "x",
      forward: false,
      findNext: true,
      matchCase: true,
    });
    // 非布尔真值不算：避免 "false" 字符串之类被当 true
    expect(normalizeFindArgs("x", { findNext: "yes", matchCase: 1 } as never)).toMatchObject({ findNext: false, matchCase: false });
  });
});

/** 假 ipcMain：记下所有注册，能按通道名直接调用 */
const makeIpc = () => {
  const handlers = new Map<string, (...a: unknown[]) => unknown>();
  const listeners = new Map<string, (...a: unknown[]) => unknown>();
  return {
    handlers,
    listeners,
    ipcMain: {
      handle: (n: string, f: (...a: unknown[]) => unknown) => void handlers.set(n, f),
      on: (n: string, f: (...a: unknown[]) => unknown) => void listeners.set(n, f),
      removeHandler: (n: string) => void handlers.delete(n),
      removeListener: (n: string) => void listeners.delete(n),
    },
  };
};

const makeWc = () => ({
  level: 0,
  getZoomLevel() {
    return this.level;
  },
  setZoomLevel: vi.fn(function (this: { level: number }, l: number) {
    this.level = l;
  }),
  findInPage: vi.fn(),
  stopFindInPage: vi.fn(),
  isDevToolsOpened: () => false,
  openDevTools: vi.fn(),
  reload: vi.fn(),
  reloadIgnoringCache: vi.fn(),
  on: vi.fn(),
});

const setup = (over: Record<string, unknown> = {}) => {
  const ipc = makeIpc();
  const wc = makeWc();
  const tab: Record<string, unknown> = { id: "t1", wc, hooks: {}, parentWindow: null };
  const downloads = new Map<number, unknown>();
  const session = {
    taskId: "task-1",
    destroyed: false,
    activeTab: tab,
    tabs: [tab],
    getDownload: (id: number) => downloads.get(id) ?? null,
    getState: () => ({ downloads: [] }),
  };
  const shell = { showItemInFolder: vi.fn(), openPath: vi.fn(async () => "") };
  const scheduleState = vi.fn();
  let trusted = true;
  const feats = registerUserFeatures({
    ipcMain: ipc.ipcMain,
    isTrustedIpcSender: () => trusted,
    getSession: (id: string) => (id === "task-1" ? session : undefined),
    findOwner: () => ({ session, tab }),
    isAppUrl: () => false,
    sendToRenderer: vi.fn(),
    scheduleState,
    shell,
    ...over,
  });
  return { ...ipc, wc, tab, session, shell, downloads, scheduleState, feats, setTrusted: (v: boolean) => (trusted = v) };
};

describe("registerUserFeatures：IPC 入口的可信校验与参数校验", () => {
  const EV = { senderFrame: { url: "x" } };
  const SEND = ["zoom", "find", "stopFind", "openDevTools", "answerDialog", "resetEmulation"].map((n) => `browser:${n}`);
  const INVOKE = ["revealDownload", "openDownload"].map((n) => `browser:${n}`);

  it("注册了全部通道；dispose 后全部撤掉", () => {
    const s = setup();
    for (const n of SEND) expect(s.listeners.has(n), n).toBe(true);
    for (const n of INVOKE) expect(s.handlers.has(n), n).toBe(true);
    s.feats.dispose();
    for (const n of SEND) expect(s.listeners.has(n), n).toBe(false);
    for (const n of INVOKE) expect(s.handlers.has(n), n).toBe(false);
  });

  it("不可信发送者：send 型静默丢弃（不产生任何副作用）、invoke 型 throw", async () => {
    const s = setup();
    s.setTrusted(false);
    s.listeners.get("browser:zoom")!(EV, "task-1", "in");
    s.listeners.get("browser:find")!(EV, "task-1", "abc", {});
    s.listeners.get("browser:openDevTools")!(EV, "task-1");
    s.listeners.get("browser:stopFind")!(EV, "task-1");
    const answer = vi.fn();
    s.tab.answerDialog = answer;
    s.listeners.get("browser:answerDialog")!(EV, "task-1", true);
    expect(s.wc.setZoomLevel).not.toHaveBeenCalled();
    expect(s.wc.findInPage).not.toHaveBeenCalled();
    expect(s.wc.openDevTools).not.toHaveBeenCalled();
    expect(s.wc.stopFindInPage).not.toHaveBeenCalled();
    expect(answer).not.toHaveBeenCalled();
    for (const n of INVOKE) await expect(s.handlers.get(n)!(EV, "task-1", 1)).rejects.toThrow("untrusted sender");
  });

  it("zoom：只认 in / out / reset，缩放落到当前激活 tab 并让面板刷新", () => {
    const s = setup();
    const z = s.listeners.get("browser:zoom")!;
    z(EV, "task-1", "in");
    z(EV, "task-1", "in");
    expect(s.wc.level).toBe(1);
    expect(s.scheduleState).toHaveBeenCalledWith("task-1");
    z(EV, "task-1", "bogus");
    z(EV, "task-1", 7);
    z(EV, "task-1", undefined);
    expect(s.wc.level).toBe(1);
    z(EV, "no-such-task", "in");
    z(EV, 123, "in");
    expect(s.wc.level).toBe(1);
    z(EV, "task-1", "reset");
    expect(s.wc.level).toBe(0);
    for (let i = 0; i < 30; i++) z(EV, "task-1", "in");
    expect(s.wc.level).toBe(5);
  });

  it("find / stopFind：非法参数忽略，空词等价 stopFind", () => {
    const s = setup();
    const f = s.listeners.get("browser:find")!;
    f(EV, "task-1", "hello", { forward: false, findNext: true, matchCase: true });
    expect(s.wc.findInPage).toHaveBeenCalledWith("hello", { forward: false, findNext: true, matchCase: true });
    s.wc.findInPage.mockClear();
    f(EV, "task-1", 42, {});
    f(EV, "nope", "x", {});
    f(EV, "task-1", { text: "x" }, {});
    expect(s.wc.findInPage).not.toHaveBeenCalled();
    f(EV, "task-1", "", {});
    expect(s.wc.stopFindInPage).toHaveBeenCalledWith("clearSelection");
    s.listeners.get("browser:stopFind")!(EV, "task-1");
    expect(s.wc.stopFindInPage).toHaveBeenCalledTimes(2);
  });

  it("openDevTools：detach 模式；devToolsEnabled=false 不开", () => {
    const s = setup();
    s.listeners.get("browser:openDevTools")!(EV, "task-1");
    expect(s.wc.openDevTools).toHaveBeenCalledWith({ mode: "detach" });
    const off = setup({ devToolsEnabled: false });
    off.listeners.get("browser:openDevTools")!(EV, "task-1");
    expect(off.wc.openDevTools).not.toHaveBeenCalled();
  });

  it("revealDownload：只按登记表 id 取路径；多传的路径参数被无视；找不到 / 文件已删 → ok:false", async () => {
    const s = setup();
    const file = path.join(ROOT, "package.json"); // 一个肯定存在的绝对路径
    s.downloads.set(1, { id: 1, fileName: "package.json", path: file, state: "completed" });
    const reveal = s.handlers.get("browser:revealDownload")!;
    expect(await reveal(EV, "task-1", 1, "/etc/passwd")).toEqual({ ok: true });
    expect(s.shell.showItemInFolder).toHaveBeenCalledWith(file);
    expect(s.shell.showItemInFolder).toHaveBeenCalledTimes(1);
    expect(await reveal(EV, "task-1", 2)).toMatchObject({ ok: false });
    expect(await reveal(EV, "task-1", "1")).toMatchObject({ ok: false });
    expect(await reveal(EV, "nope", 1)).toMatchObject({ ok: false });
    s.downloads.set(3, { id: 3, fileName: "gone.pdf", path: "/definitely/not/here.pdf", state: "completed" });
    expect(await reveal(EV, "task-1", 3)).toMatchObject({ ok: false });
    // 登记表里的路径不是绝对路径（脏数据）也拒绝
    s.downloads.set(4, { id: 4, fileName: "rel.pdf", path: "rel.pdf", state: "completed" });
    expect(await reveal(EV, "task-1", 4)).toMatchObject({ ok: false });
    expect(s.shell.showItemInFolder).toHaveBeenCalledTimes(1);
  });

  it("openDownload：白名单之外的扩展名 / 未完成 / 无扩展名一律不调 shell.openPath（主进程再校验一次）", async () => {
    const s = setup();
    const dir = ROOT;
    const put = (id: number, fileName: string, state = "completed") =>
      s.downloads.set(id, { id, fileName, path: path.join(dir, "package.json"), state });
    // 注意：路径文件真实存在，隔离「扩展名」这一个判据 —— 扩展名取自登记表 path 的 basename，所以用 path 带扩展名的真实文件来测
    const open = s.handlers.get("browser:openDownload")!;
    put(1, "x.pdf");
    expect(await open(EV, "task-1", 1)).toEqual({ ok: true });
    expect(s.shell.openPath).toHaveBeenCalledTimes(1);
    // 扩展名取 path 的 basename（不信 fileName）：path 是 .exe 就拒
    s.downloads.set(2, { id: 2, fileName: "innocent.pdf", path: path.join(dir, "setup.exe"), state: "completed" });
    expect(await open(EV, "task-1", 2)).toMatchObject({ ok: false });
    s.downloads.set(3, { id: 3, fileName: "a.txt", path: path.join(dir, "package.json"), state: "progressing" });
    expect(await open(EV, "task-1", 3)).toMatchObject({ ok: false });
    s.downloads.set(4, { id: 4, fileName: "README", path: path.join(dir, "README"), state: "completed" });
    expect(await open(EV, "task-1", 4)).toMatchObject({ ok: false });
    expect(s.shell.openPath).toHaveBeenCalledTimes(1);
    // R1-23：不在白名单的类型（原黑名单漏掉的 / 压缩包 / 带脚本的 svg / html）：拒绝并说明「只能在文件夹中显示」，不调 openPath
    let id = 10;
    for (const name of ["x.zip", "x.svg", "x.html", "x.docm", "x.py", "x.iso", "x.msix", "x.chm", "x.unknownext", "x.pdf:evil.exe"]) {
      s.downloads.set(id, { id, fileName: "innocent.pdf", path: path.join(dir, name), state: "completed" });
      const r = (await open(EV, "task-1", id)) as { ok: boolean; error?: string };
      expect(r, name).toMatchObject({ ok: false });
      expect(r.error, name).toMatch(/在文件夹中显示/);
      id += 1;
    }
    expect(s.shell.openPath).toHaveBeenCalledTimes(1);
  });

  it("openDownload：同一目录下白名单里的各类扩展名都能打开；reveal（在文件夹中显示）不受白名单影响", async () => {
    const s = setup();
    const open = s.handlers.get("browser:openDownload")!;
    const reveal = s.handlers.get("browser:revealDownload")!;
    // 处理器要求文件真实存在：用仓库里肯定存在的真实文件，一个在白名单（json / md），一个不在（yaml / mjs）
    const whitelisted = ["package.json", "README.md", "tsconfig.json"].map((n) => path.join(ROOT, n));
    let id = 1;
    for (const p of whitelisted) {
      s.downloads.set(id, { id, fileName: path.basename(p), path: p, state: "completed" });
      expect(await open(EV, "task-1", id), p).toEqual({ ok: true });
      id += 1;
    }
    expect(s.shell.openPath).toHaveBeenCalledTimes(whitelisted.length);
    // 白名单之外的真实文件：open 被拒，但 reveal 仍然可用（这正是「其余只允许在文件夹中显示」）
    const notWhitelisted = ["pnpm-lock.yaml", "next.config.mjs"].map((n) => path.join(ROOT, n));
    for (const p of notWhitelisted) {
      s.downloads.set(id, { id, fileName: path.basename(p), path: p, state: "completed" });
      expect(await open(EV, "task-1", id), p).toMatchObject({ ok: false });
      expect(await reveal(EV, "task-1", id), p).toEqual({ ok: true });
      expect(s.shell.showItemInFolder).toHaveBeenCalledWith(p);
      id += 1;
    }
    expect(s.shell.openPath).toHaveBeenCalledTimes(whitelisted.length);
    expect(s.shell.showItemInFolder).toHaveBeenCalledTimes(notWhitelisted.length);
  });

  it("openDownload：shell.openPath 返回错误串 → ok:false 带原因", async () => {
    const s = setup();
    s.shell.openPath.mockResolvedValueOnce("没有关联的应用");
    s.downloads.set(1, { id: 1, fileName: "package.json", path: path.join(ROOT, "package.json"), state: "completed" });
    expect(await s.handlers.get("browser:openDownload")!(EV, "task-1", 1)).toEqual({ ok: false, error: "没有关联的应用" });
  });

  it("下载登记表缺位时：回退用 getState().downloads 对账（与面板展示同源）", async () => {
    const s = setup();
    const file = path.join(ROOT, "package.json");
    delete (s.session as Record<string, unknown>).getDownload;
    (s.session as Record<string, unknown>).getState = () => ({
      downloads: [{ id: 9, fileName: "package.json", path: file, state: "completed" }],
    });
    expect(await s.handlers.get("browser:revealDownload")!(EV, "task-1", 9)).toEqual({ ok: true });
    expect(s.shell.showItemInFolder).toHaveBeenCalledWith(file);
  });

  it("answerDialog / resetEmulation：对 tab 方法做可选调用（V5 没落地就是空操作）；accept 只认 === true、promptText 只认字符串", () => {
    const s = setup();
    // 没有方法：不抛
    expect(() => s.listeners.get("browser:answerDialog")!(EV, "task-1", true, "x")).not.toThrow();
    expect(() => s.listeners.get("browser:resetEmulation")!(EV, "task-1")).not.toThrow();
    const answer = vi.fn();
    const reset = vi.fn();
    s.tab.answerDialog = answer;
    s.tab.resetEmulation = reset;
    s.listeners.get("browser:answerDialog")!(EV, "task-1", true, "hi");
    s.listeners.get("browser:answerDialog")!(EV, "task-1", "yes", 123);
    s.listeners.get("browser:answerDialog")!(EV, 5, true);
    s.listeners.get("browser:resetEmulation")!(EV, "task-1");
    expect(answer.mock.calls).toEqual([
      [true, "hi"],
      [false, undefined],
    ]);
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it("answerDialog 优先找有挂起对话框的 tab（可能不是激活 tab）", () => {
    const s = setup();
    const other = { id: "t2", pendingDialog: { type: "alert" }, answerDialog: vi.fn(), wc: makeWc() };
    s.session.tabs.push(other as never);
    s.tab.answerDialog = vi.fn();
    s.listeners.get("browser:answerDialog")!(EV, "task-1", true);
    expect(other.answerDialog).toHaveBeenCalledWith(true, undefined);
    expect(s.tab.answerDialog).not.toHaveBeenCalled();
  });
});

describe("源码契约：user-features.mjs 的 IPC 注册都过 isTrustedIpcSender 闸、不引入 electron", () => {
  const src = readFileSync(path.join(ROOT, "electron-app/browser/user-features.mjs"), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("两个注册 helper 的回调第一条语句都是 if (!isTrustedIpcSender(event…))", () => {
    const re = /ipcMain\.(handle|on)\(\s*name\s*,\s*(?:async\s*)?\(event[^)]*\)\s*=>\s*\{|const listener = \(event[^)]*\) => \{/g;
    const hits = [...code.matchAll(re)];
    expect(hits.length).toBe(2);
    for (const m of hits) {
      const head = code.slice(m.index! + m[0].length).replace(/^\s+/, "").slice(0, 80);
      expect(head).toMatch(/^if \(!isTrustedIpcSender\(event\)\)/);
    }
  });

  it("所有 on / handle 调用点传的都是 browser:* 字面量，且恰是契约 §14.3 的 8 个通道", () => {
    const names = [...code.matchAll(/(?<![.\w])(?:on|handle)\(\s*"(browser:\w+)"/g)].map((m) => m[1]).sort();
    expect(names).toEqual(
      [
        "browser:zoom",
        "browser:find",
        "browser:stopFind",
        "browser:openDevTools",
        "browser:revealDownload",
        "browser:openDownload",
        "browser:answerDialog",
        "browser:resetEmulation",
      ].sort(),
    );
  });

  it("不 import electron（Menu / shell / clipboard 全靠注入，保证可单测）；也不直接碰 ipcMain 以外的 IPC 面", () => {
    expect(code).not.toMatch(/from\s+["']electron["']/);
    expect(code).not.toMatch(/require\(["']electron["']\)/);
    expect(code).not.toMatch(/ipcRenderer/);
  });

  it("下载 reveal / open 不接受渲染进程传来的路径：handler 形参里没有 path / filePath", () => {
    const m = /handle\("browser:(?:revealDownload|openDownload)",\s*(?:async\s*)?\(([^)]*)\)/g;
    const params = [...code.matchAll(m)].map((x) => x[1]);
    expect(params.length).toBe(2);
    for (const p of params) expect(p).toBe("taskId, id");
  });
});

describe("index.mjs / main.js 的接线", () => {
  const indexSrc = readFileSync(path.join(ROOT, "electron-app/browser/index.mjs"), "utf8");
  const mainSrc = readFileSync(path.join(ROOT, "electron-app/main.js"), "utf8");

  it("index.mjs：registerIpc 末尾调一次 registerUserFeatures，tab 创建后 bindTab，destroy 时 dispose", () => {
    expect(indexSrc).toContain('import { registerUserFeatures } from "./user-features.mjs";');
    expect(indexSrc.match(/registerUserFeatures\(/g)?.length).toBe(1);
    expect(indexSrc).toContain("userFeatures?.bindTab(tab);");
    expect(indexSrc).toContain("userFeatures?.dispose();");
    // 把 Menu / clipboard / shell 传下去
    for (const k of ["Menu: deps.Menu", "clipboard: deps.clipboard", "shell: deps.shell"]) expect(indexSrc).toContain(k);
    // deps 文档注释同步
    expect(indexSrc).toMatch(/Menu\?: any, clipboard\?: any, shell\?: any/);
  });

  it("main.js：只多了 Menu / clipboard / shell 注入，clipboard 已从 electron 引入", () => {
    const at = mainSrc.indexOf("const browserManager = createBrowserManager(");
    const block = mainSrc.slice(at, mainSrc.indexOf("});", at));
    for (const k of ["Menu,", "clipboard,", "shell,"]) expect(block, k).toContain(k);
    const imp = mainSrc.slice(mainSrc.indexOf("import {\n  app,"), mainSrc.indexOf('} from "electron";'));
    expect(imp).toMatch(/\bclipboard,/);
    // main.js 仍不注册任何 browser:* IPC
    expect(mainSrc).not.toMatch(/ipcMain\.(on|handle|once)\("browser:/);
  });

  it("tab.mjs：TabInfo 带 zoom（百分比整数）", () => {
    const tabSrc = readFileSync(path.join(ROOT, "electron-app/browser/tab.mjs"), "utf8");
    // tab.mjs 现在是先 `let zoom = 100` 再在 try 里 `zoom = nav ? Math.round(1.2 ** …)`（主 agent 重构过），对 `zoom:` / `zoom =` 两种写法都认
    expect(tabSrc).toMatch(/zoom\s*[:=]\s*nav \? Math\.round\(1\.2 \*\* /);
  });
});

describe("bindTab：页面持有焦点时的 Cmd/Ctrl+R 只刷新这个页面（不能漏给应用菜单刷掉整个 Flowship）", () => {
  /** 调 bindTab 后取出挂到 wc 上的 before-input-event 处理函数 */
  const hookInput = (s: ReturnType<typeof setup>) => {
    s.feats.bindTab(s.tab);
    const call = s.wc.on.mock.calls.find((c) => c[0] === "before-input-event");
    expect(call, "必须在 wc 上挂 before-input-event").toBeTruthy();
    return call![1] as (event: { preventDefault: () => void }, input: Record<string, unknown>) => void;
  };
  const press = (
    handler: ReturnType<typeof hookInput>,
    input: Record<string, unknown>,
  ): { prevented: boolean } => {
    const event = { preventDefault: vi.fn() };
    handler(event, { type: "keyDown", ...input });
    return { prevented: event.preventDefault.mock.calls.length > 0 };
  };

  it("Cmd+R：刷新该 tab + preventDefault（按键被吃掉、菜单加速键不会再触发）", () => {
    const s = setup({ platform: "darwin" });
    const handler = hookInput(s);
    const r = press(handler, { key: "r", meta: true });
    expect(r.prevented).toBe(true);
    expect(s.wc.reload).toHaveBeenCalledTimes(1);
    expect(s.wc.reloadIgnoringCache).not.toHaveBeenCalled();
  });

  it("Cmd+Shift+R：强刷（忽略缓存），同样吃掉按键", () => {
    const s = setup({ platform: "darwin" });
    const handler = hookInput(s);
    const r = press(handler, { key: "R", meta: true, shift: true });
    expect(r.prevented).toBe(true);
    expect(s.wc.reloadIgnoringCache).toHaveBeenCalledTimes(1);
    expect(s.wc.reload).not.toHaveBeenCalled();
  });

  it("win / linux：Ctrl+R 同样只刷新页面", () => {
    const s = setup({ platform: "win32" });
    const handler = hookInput(s);
    expect(press(handler, { key: "r", control: true }).prevented).toBe(true);
    expect(s.wc.reload).toHaveBeenCalledTimes(1);
  });

  it("刷新不连带缩放 / 查找副作用；无关按键不吃、不刷新", () => {
    const s = setup({ platform: "darwin" });
    const handler = hookInput(s);
    press(handler, { key: "r", meta: true });
    expect(s.wc.setZoomLevel).not.toHaveBeenCalled();
    expect(s.wc.findInPage).not.toHaveBeenCalled();

    s.wc.reload.mockClear();
    expect(press(handler, { key: "r" }).prevented).toBe(false); // 没修饰键：页面自己的输入
    expect(press(handler, { key: "a", meta: true }).prevented).toBe(false);
    expect(press(handler, { key: "r", meta: true, alt: true }).prevented).toBe(false);
    expect(s.wc.reload).not.toHaveBeenCalled();
  });
});
