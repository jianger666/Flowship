/**
 * 壳崩溃处置的编排（R14 B2-4b / Q15-04 + Q15-03）：切 `electron-app/main.js` 里真实的 `onServerExit` / `onRenderProcessGone`
 * （连同 `askCrashChoice` / `openDirLogged` / `listFreshNodeReports` 等）函数体**真实执行**，注入 dialog / shell / app / startServer 等替身。
 * 决策与文案是 shell-crash.mjs 的纯函数（tests/shell-crash.test.ts 单测）；这里测的是 main.js 里把它们接起来的那一层：
 *   I.   onServerExit：忽略（用户退出 / 旧进程）、启动就崩 → 弹窗、稳定运行后崩 → 自动重启一次并刷新页面、重启没恢复 / 已重启过 → 弹窗、
 *        弹窗只弹一次（并发）、按钮分派（打开日志目录 / 崩溃报告目录 / 退出）、日志里带 (code, signal)
 *   II.  onRenderProcessGone：主窗崩溃 → 刷新、正常关窗 → 只记日志、小窗不消耗配额、反复崩溃 → 提示（重新加载 / 日志目录 / 退出）
 *   III. 源码契约：exit 回调收 (code, signal) 且带 .catch、不再有 `code ?? "?"` 与旧的单按钮弹窗、
 *        进程级事件只用 uncaughtExceptionMonitor（不装 uncaughtException / unhandledRejection 处理器——不吞致命错误）、报告目录单一来源
 *   IV.  启动期崩溃后不再叠一个「启动超时」弹窗（B2-4b 终审 P3-4）：whenReady 回调里的分支没法切片，走源码文本契约 + 变异自检
 *   V.   崩溃弹窗本身出错（窗口已销毁 / 文案构造抛错）也照样 app.quit()（B2-4b 终审 P3-8，P3-4 带来的小洞）：行为测试在 I 组，这里钉 try / catch / finally 的源码形状 + 变异自检
 * 终审 P3 随补丁 / 本批并入 I 组：弹窗参数（默认按钮 = 关闭 = 退出、不挂父窗）、readdir 列到而 stat 时已被轮转删掉的报告只跳过它、
 * 自动重启后等就绪用默认超时、再次崩溃的提示带「已自动重启过一次」（P3-5）、重启成功后刷新页面抛错不算重启失败（P3-7）、
 * 崩溃弹窗 / 文案构造抛错照样退出（P3-8）。
 * ⚠ 全部是「切函数体 + 替身」：没有在真实 Electron 里让 server 被 kill -9、没有真的看过弹窗。
 */
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import * as crash from "../electron-app/shell-crash.mjs";
import { instantiateMany, mainDecls, mainSrc, sliceMainFn } from "./helpers/main-slice";

const FNS = [
  "nodeReportsDir",
  "shellLogsDir",
  "listFreshNodeReports",
  "askCrashChoice",
  "openDirLogged",
  "onServerExit",
  "onRenderProcessGone",
];
const PRELUDE = mainDecls(
  "serverProc",
  "quitting",
  "mainWindow",
  "serverAutoRestarts",
  "serverCrashPrompted",
  "renderReloadTimes",
  "renderGiveUpPrompted",
);

const USER_DATA = "/u/userData";
const LOGS_DIR = `${USER_DATA}/logs`;
const REPORTS_DIR = `${USER_DATA}/data/diagnostics/node-reports`;

interface Api {
  onServerExit: (a: { proc: unknown; startedAt: number; code: number | null; signal: string | null }) => Promise<void>;
  onRenderProcessGone: (wc: unknown, details: Record<string, unknown> | undefined) => Promise<void>;
  get: () => {
    serverProc: unknown;
    quitting: boolean;
    mainWindow: unknown;
    serverAutoRestarts: number;
    serverCrashPrompted: boolean;
    renderReloadTimes: number[];
    renderGiveUpPrompted: boolean;
  };
  set: (p: Record<string, unknown>) => void;
}

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

interface WorldOpts {
  /** 用户依次点哪个按钮（没预设 = 点最后一个「退出」） */
  choices?: string[];
  ready?: () => Promise<boolean>;
  startThrows?: boolean;
  reportFiles?: Array<{ name: string; mtimeMs: number }>;
  /** readdir 列得到、但 stat 时已经不在的文件名（刚被轮转删掉） */
  ghostNames?: string[];
  reportsDirThrows?: boolean;
  openPathResult?: () => Promise<string>;
  /** 自动重启成功后 webContents.reload() 抛错（窗口已销毁等） */
  reloadThrows?: boolean;
  /** 崩溃弹窗本身抛错（dialog.showMessageBox reject：窗口已销毁 / Electron 内部错误） */
  dialogThrows?: boolean;
  /** 构造崩溃提示文案抛错（buildServerCrashNotice 抛） */
  noticeThrows?: boolean;
}

const makeWorld = (o: WorldOpts = {}) => {
  const logs: string[] = [];
  const proc1 = { pid: 1, name: "server-1" };
  const proc2 = { pid: 2, name: "server-2" };
  const choices = [...(o.choices ?? [])];
  const dialog = {
    showMessageBox: vi.fn(async (opts: { buttons: string[] }) => {
      if (o.dialogThrows) throw new Error("Object has been destroyed");
      const want = choices.shift();
      const idx = want === undefined ? opts.buttons.length - 1 : opts.buttons.indexOf(want);
      if (idx < 0) throw new Error(`测试脚本里想点的按钮不在弹窗里：${want}（弹窗按钮：${opts.buttons.join(" / ")}）`);
      return { response: idx };
    }),
  };
  const shell = { openPath: vi.fn(o.openPathResult ?? (async () => "")) };
  const app = { quit: vi.fn(), getPath: vi.fn((k: string) => (k === "userData" ? USER_DATA : `/u/${k}`)) };
  const reload = vi.fn(() => {
    if (o.reloadThrows) throw new Error("Object has been destroyed");
  });
  const mainWin = { isDestroyed: () => false, webContents: { reload } };
  const startServer = vi.fn(() => {
    if (o.startThrows) throw new Error("spawn failed");
    api.set({ serverProc: proc2 });
  });
  const waitForReady = vi.fn(o.ready ?? (async () => true));
  const deps = {
    log: (m: string) => logs.push(m),
    dialog,
    shell,
    app,
    path,
    readdirSync: vi.fn((dir: string) => {
      if (o.reportsDirThrows) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      expect(dir).toBe(REPORTS_DIR);
      return [...(o.ghostNames ?? []), ...(o.reportFiles ?? []).map((f) => f.name)];
    }),
    statSync: vi.fn((file: string) => {
      const f = (o.reportFiles ?? []).find((x) => file.endsWith(`/${x.name}`));
      if (!f) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return { mtimeMs: f.mtimeMs };
    }),
    startServer,
    waitForReady,
    BUTTON_OPEN_LOGS: crash.BUTTON_OPEN_LOGS,
    BUTTON_OPEN_REPORTS: crash.BUTTON_OPEN_REPORTS,
    BUTTON_RELOAD: crash.BUTTON_RELOAD,
    buildRenderGoneNotice: crash.buildRenderGoneNotice,
    buildServerCrashNotice: o.noticeThrows
      ? () => {
          throw new Error("notice boom");
        }
      : crash.buildServerCrashNotice,
    decideRenderGone: crash.decideRenderGone,
    decideServerExit: crash.decideServerExit,
    describeExit: crash.describeExit,
    describeRenderGone: crash.describeRenderGone,
    pickFreshReports: crash.pickFreshReports,
  };
  const api: Api = instantiateMany<Api>(
    FNS,
    deps,
    PRELUDE,
    `return {
      onServerExit, onRenderProcessGone,
      get: () => ({ serverProc, quitting, mainWindow, serverAutoRestarts, serverCrashPrompted, renderReloadTimes, renderGiveUpPrompted }),
      set: (p) => {
        if ("serverProc" in p) serverProc = p.serverProc;
        if ("quitting" in p) quitting = p.quitting;
        if ("mainWindow" in p) mainWindow = p.mainWindow;
        if ("serverAutoRestarts" in p) serverAutoRestarts = p.serverAutoRestarts;
        if ("renderReloadTimes" in p) renderReloadTimes = p.renderReloadTimes;
      },
    };`,
  );
  api.set({ serverProc: proc1, mainWindow: mainWin });
  return { api, logs, dialog, shell, app, reload, mainWin, startServer, waitForReady, proc1, proc2, deps };
};

const MIN = 60_000;
const crashed = (w: ReturnType<typeof makeWorld>, over: Partial<Parameters<Api["onServerExit"]>[0]> = {}) =>
  w.api.onServerExit({ proc: w.proc1, startedAt: Date.now() - 5_000, code: null, signal: "SIGKILL", ...over });
const dialogOpts = (w: ReturnType<typeof makeWorld>, n = 0) =>
  w.dialog.showMessageBox.mock.calls[n]![0] as unknown as { title: string; detail: string; buttons: string[]; type: string };

describe("I. onServerExit", () => {
  it("用户主动退出（quitting）：不是崩溃——serverProc 照常清掉，不弹窗、不重启、不 quit", async () => {
    const w = makeWorld();
    w.api.set({ quitting: true });
    await crashed(w, { startedAt: Date.now() - 10 * MIN, code: 0, signal: null });
    expect(w.dialog.showMessageBox).not.toHaveBeenCalled();
    expect(w.startServer).not.toHaveBeenCalled();
    expect(w.app.quit).not.toHaveBeenCalled();
    expect(w.api.get().serverProc).toBeNull();
    expect(w.logs.join("\n")).toContain("quitting=true");
  });

  it("旧进程迟来的 exit（serverProc 已被新进程接管）：不动 serverProc、不弹窗、不重启（世代守卫）", async () => {
    const w = makeWorld();
    w.api.set({ serverProc: w.proc2 });
    await crashed(w, { startedAt: Date.now() - 10 * MIN }); // proc1 的 exit
    expect(w.api.get().serverProc).toBe(w.proc2);
    expect(w.dialog.showMessageBox).not.toHaveBeenCalled();
    expect(w.startServer).not.toHaveBeenCalled();
    expect(w.logs.join("\n")).toContain("stale=true");
  });

  it("启动就崩（运行 5s）：不重启，弹窗；正文带 (code, signal)、按钮「打开日志目录 / 退出」；点退出 → app.quit", async () => {
    const w = makeWorld();
    await crashed(w);
    expect(w.startServer).not.toHaveBeenCalled();
    expect(w.dialog.showMessageBox).toHaveBeenCalledTimes(1);
    const d = dialogOpts(w);
    expect(d.type).toBe("error");
    expect(d.title).toBe("服务异常退出");
    expect(d.detail).toContain("code=null signal=SIGKILL");
    expect(d.detail).toContain("内存");
    expect(d.detail).not.toContain("已自动重启过一次"); // 没自动重启过：不能说重启过
    expect(d.buttons).toEqual([crash.BUTTON_OPEN_LOGS, crash.BUTTON_QUIT]);
    expect(w.app.quit).toHaveBeenCalledTimes(1);
    expect(w.api.get().serverProc).toBeNull();
  });

  it("弹窗参数：type=error、默认按钮与「关掉对话框」都落在最后一个（退出）、不挂父窗（崩溃后主窗没有意义）", async () => {
    const w = makeWorld();
    await crashed(w);
    expect(w.dialog.showMessageBox).toHaveBeenCalledTimes(1);
    const call = w.dialog.showMessageBox.mock.calls[0]!;
    expect(call).toHaveLength(1); // 只有选项对象：没有父窗参数
    const d = call[0] as unknown as { buttons: string[]; defaultId: number; cancelId: number; type: string; noLink: boolean };
    const last = d.buttons.length - 1;
    expect(d).toMatchObject({ type: "error", noLink: true, defaultId: last, cancelId: last });
    expect(d.buttons[last]).toBe(crash.BUTTON_QUIT);
  });

  it("崩溃弹窗本身出错（showMessageBox 抛）：onServerExit 不抛、记一行日志、照样 app.quit()；「只弹一次」的闸不因出错松开（B2-4b 终审 P3-8）", async () => {
    // 启动期崩溃时 whenReady 不再叠「启动超时」弹窗（P3-4）——这里要是不退出，应用就会没窗口、没提示地悬着
    const w = makeWorld({ dialogThrows: true });
    await expect(crashed(w)).resolves.toBeUndefined();
    expect(w.dialog.showMessageBox).toHaveBeenCalledTimes(1);
    expect(w.app.quit).toHaveBeenCalledTimes(1);
    expect(w.logs.join("\n")).toContain("server 崩溃提示出错、直接退出：Object has been destroyed");
    expect(w.api.get().serverCrashPrompted).toBe(true);
  });

  it("构造崩溃提示文案抛错（buildServerCrashNotice 抛）：同样记日志并退出，不弹窗", async () => {
    const w = makeWorld({ noticeThrows: true });
    await expect(crashed(w)).resolves.toBeUndefined();
    expect(w.dialog.showMessageBox).not.toHaveBeenCalled();
    expect(w.app.quit).toHaveBeenCalledTimes(1);
    expect(w.logs.join("\n")).toContain("server 崩溃提示出错、直接退出：notice boom");
  });

  it("自动重启没恢复后的崩溃弹窗也出错：走的是同一条路径，照样退出（只退一次）", async () => {
    const w = makeWorld({ dialogThrows: true, ready: async () => false });
    await crashed(w, { startedAt: Date.now() - 5 * MIN });
    expect(w.startServer).toHaveBeenCalledTimes(1);
    expect(w.dialog.showMessageBox).toHaveBeenCalledTimes(1);
    expect(w.app.quit).toHaveBeenCalledTimes(1);
  });

  it("目录里有个文件刚被轮转删掉（readdir 列到、stat 时已不在）：只跳过它，其它新鲜报告照常列出", async () => {
    const w = makeWorld({ reportFiles: [{ name: "report-new.json", mtimeMs: Date.now() }], ghostNames: ["report-gone.json"] });
    await crashed(w);
    expect(dialogOpts(w).buttons).toEqual([crash.BUTTON_OPEN_LOGS, crash.BUTTON_OPEN_REPORTS, crash.BUTTON_QUIT]);
  });

  it("日志里带 (code, signal) 与运行时长，不再是常量 `code=?`", async () => {
    const w = makeWorld();
    await crashed(w);
    const line = w.logs.find((l) => l.includes("server 退出"))!;
    expect(line).toMatch(/server 退出 code=null signal=SIGKILL uptime=\d+s quitting=false stale=false/);
    expect(line).not.toContain("code=?");
  });

  it("稳定运行 ≥ 60s 后崩溃：自动重启一次、等就绪、刷新页面；不弹窗、不退出", async () => {
    const w = makeWorld();
    await crashed(w, { startedAt: Date.now() - 10 * MIN });
    expect(w.startServer).toHaveBeenCalledTimes(1);
    expect(w.waitForReady).toHaveBeenCalledTimes(1);
    expect(w.waitForReady).toHaveBeenCalledWith(); // 不传参 = 用常规启动超时（写死个很短的值，重启还没起来就判失败）
    expect(w.reload).toHaveBeenCalledTimes(1);
    expect(w.dialog.showMessageBox).not.toHaveBeenCalled();
    expect(w.app.quit).not.toHaveBeenCalled();
    expect(w.api.get().serverAutoRestarts).toBe(1);
    expect(w.logs.join("\n")).toContain("自动重启成功");
  });

  it("整个 App 进程里只重启一次：第二次稳定运行后崩溃 → 弹窗，不再重启", async () => {
    const w = makeWorld();
    await crashed(w, { startedAt: Date.now() - 10 * MIN });
    expect(w.startServer).toHaveBeenCalledTimes(1);
    await w.api.onServerExit({ proc: w.proc2, startedAt: Date.now() - 10 * MIN, code: 1, signal: null });
    expect(w.startServer).toHaveBeenCalledTimes(1);
    expect(w.dialog.showMessageBox).toHaveBeenCalledTimes(1);
    expect(dialogOpts(w).detail).toContain("code=1 signal=null");
    // 第一次重启其实成功了、之后又崩：正文也要带「已自动重启过一次」，用户才知道不是头一回（B2-4b 终审 P3-5：restartFailed 是局部变量，以前这里不带）
    expect(dialogOpts(w).detail).toContain("已自动重启过一次");
  });

  it("自动重启成功后刷新页面抛错（窗口已销毁等）：server 已经恢复，不算「重启失败」——不弹窗、不退出、不抛，日志记一行（B2-4b 终审 P3-7）", async () => {
    const w = makeWorld({ reloadThrows: true });
    await expect(crashed(w, { startedAt: Date.now() - 10 * MIN })).resolves.toBeUndefined();
    expect(w.reload).toHaveBeenCalledTimes(1);
    expect(w.dialog.showMessageBox).not.toHaveBeenCalled();
    expect(w.app.quit).not.toHaveBeenCalled();
    expect(w.api.get().serverCrashPrompted).toBe(false);
    expect(w.logs.join("\n")).toContain("自动重启后刷新页面失败（忽略）：Object has been destroyed");
  });

  it("重启后一直没就绪：弹窗，正文说明「已自动重启过一次」；不刷新页面", async () => {
    const w = makeWorld({ ready: async () => false });
    await crashed(w, { startedAt: Date.now() - 10 * MIN });
    expect(w.reload).not.toHaveBeenCalled();
    expect(w.dialog.showMessageBox).toHaveBeenCalledTimes(1);
    expect(dialogOpts(w).detail).toContain("已自动重启过一次");
    expect(w.app.quit).toHaveBeenCalledTimes(1);
  });

  it("重启时 startServer 抛错：不抛出，弹窗说明重启没恢复", async () => {
    const w = makeWorld({ startThrows: true });
    await expect(crashed(w, { startedAt: Date.now() - 10 * MIN })).resolves.toBeUndefined();
    expect(w.dialog.showMessageBox).toHaveBeenCalledTimes(1);
    expect(dialogOpts(w).detail).toContain("已自动重启过一次");
    expect(w.logs.join("\n")).toContain("自动重启失败：spawn failed");
  });

  it("等重启就绪期间用户退出了：不弹窗、不刷新页面", async () => {
    const w = makeWorld({
      ready: async () => {
        w.api.set({ quitting: true });
        return true;
      },
    });
    await crashed(w, { startedAt: Date.now() - 10 * MIN });
    expect(w.dialog.showMessageBox).not.toHaveBeenCalled();
    expect(w.reload).not.toHaveBeenCalled();
  });

  it("自动重启期间新 server 又崩：只弹一次窗（第一次重启的 waitForReady 超时后不再重复弹）", async () => {
    let release!: (v: boolean) => void;
    const w = makeWorld({ ready: () => new Promise<boolean>((r) => (release = r)) });
    const first = crashed(w, { startedAt: Date.now() - 10 * MIN });
    await tick();
    expect(w.startServer).toHaveBeenCalledTimes(1); // startServer 替身已把 serverProc 换成 proc2
    await w.api.onServerExit({ proc: w.proc2, startedAt: Date.now() - 2_000, code: 1, signal: null });
    expect(w.dialog.showMessageBox).toHaveBeenCalledTimes(1);
    release(false);
    await first;
    expect(w.dialog.showMessageBox).toHaveBeenCalledTimes(1);
    expect(w.app.quit).toHaveBeenCalledTimes(1);
  });

  it("点「打开日志目录」：打开 userData/logs，然后退出", async () => {
    const w = makeWorld({ choices: [crash.BUTTON_OPEN_LOGS] });
    await crashed(w);
    expect(w.shell.openPath).toHaveBeenCalledWith(LOGS_DIR);
    expect(w.app.quit).toHaveBeenCalledTimes(1);
  });

  it("本次崩溃之后生成了取证报告：多一个「打开崩溃报告目录」（报告目录 = userData/data/diagnostics/node-reports）；点它就打开那个目录", async () => {
    const startedAt = Date.now() - 5_000;
    const w = makeWorld({
      reportFiles: [{ name: "report.new.json", mtimeMs: startedAt + 100 }],
      choices: [crash.BUTTON_OPEN_REPORTS],
    });
    await crashed(w, { startedAt });
    expect(dialogOpts(w).buttons).toEqual([crash.BUTTON_OPEN_LOGS, crash.BUTTON_OPEN_REPORTS, crash.BUTTON_QUIT]);
    expect(dialogOpts(w).detail).toContain("取证报告");
    expect(w.shell.openPath).toHaveBeenCalledWith(REPORTS_DIR);
    expect(w.app.quit).toHaveBeenCalledTimes(1);
  });

  it("只有旧崩溃留下的报告 / 报告目录不存在：不出现报告按钮", async () => {
    const startedAt = Date.now() - 5_000;
    const old = makeWorld({ reportFiles: [{ name: "report.old.json", mtimeMs: startedAt - 3_600_000 }] });
    await crashed(old, { startedAt });
    expect(dialogOpts(old).buttons).toEqual([crash.BUTTON_OPEN_LOGS, crash.BUTTON_QUIT]);
    const none = makeWorld({ reportsDirThrows: true });
    await crashed(none, { startedAt });
    expect(dialogOpts(none).buttons).toEqual([crash.BUTTON_OPEN_LOGS, crash.BUTTON_QUIT]);
  });

  it("打开目录失败（openPath 返回错误文案 / 抛）：只记日志，照样退出", async () => {
    const a = makeWorld({ choices: [crash.BUTTON_OPEN_LOGS], openPathResult: async () => "no handler" });
    await crashed(a);
    expect(a.logs.join("\n")).toContain("打开目录失败");
    expect(a.app.quit).toHaveBeenCalledTimes(1);
    const b = makeWorld({
      choices: [crash.BUTTON_OPEN_LOGS],
      openPathResult: async () => {
        throw new Error("boom");
      },
    });
    await crashed(b);
    expect(b.logs.join("\n")).toContain("打开目录失败");
    expect(b.app.quit).toHaveBeenCalledTimes(1);
  });
});

describe("II. onRenderProcessGone", () => {
  const gone = (reason: string, exitCode = 5) => ({ reason, exitCode });

  it("主窗页面进程崩溃：记日志 + 刷新页面，不弹窗", async () => {
    const w = makeWorld();
    await w.api.onRenderProcessGone(w.mainWin.webContents, gone("crashed"));
    expect(w.reload).toHaveBeenCalledTimes(1);
    expect(w.dialog.showMessageBox).not.toHaveBeenCalled();
    expect(w.logs).toContain("[main] render-process-gone reason=crashed exitCode=5");
    expect(w.api.get().renderReloadTimes).toHaveLength(1);
  });

  it("clean-exit（正常关窗）等：只记日志，不刷新、不弹窗、不耗配额", async () => {
    const w = makeWorld();
    await w.api.onRenderProcessGone(w.mainWin.webContents, gone("clean-exit", 0));
    expect(w.reload).not.toHaveBeenCalled();
    expect(w.dialog.showMessageBox).not.toHaveBeenCalled();
    expect(w.api.get().renderReloadTimes).toEqual([]);
    expect(w.logs.join("\n")).toContain("reason=clean-exit");
  });

  it("不是主窗的页面（splash 等）崩了：只记日志，不刷新、不弹窗，也不消耗主窗的刷新配额", async () => {
    const w = makeWorld();
    await w.api.onRenderProcessGone({ reload: vi.fn() }, gone("crashed"));
    expect(w.reload).not.toHaveBeenCalled();
    expect(w.dialog.showMessageBox).not.toHaveBeenCalled();
    expect(w.api.get().renderReloadTimes).toEqual([]);
  });

  it("主窗已经没了（mainWindow = null）：只记日志，不抛", async () => {
    const w = makeWorld();
    w.api.set({ mainWindow: null });
    await expect(w.api.onRenderProcessGone(w.mainWin.webContents, gone("crashed"))).resolves.toBeUndefined();
    expect(w.logs.join("\n")).toContain("render-process-gone");
  });

  it("60s 内再次崩溃：不再自动刷新，弹「页面反复崩溃」；点「重新加载页面」→ 刷新，之后还能再提示", async () => {
    const w = makeWorld({ choices: [crash.BUTTON_RELOAD] });
    await w.api.onRenderProcessGone(w.mainWin.webContents, gone("crashed")); // 自动刷新 1 次
    await w.api.onRenderProcessGone(w.mainWin.webContents, gone("crashed")); // 放弃 → 提示 → 用户点「重新加载页面」
    expect(w.dialog.showMessageBox).toHaveBeenCalledTimes(1);
    expect(dialogOpts(w).title).toBe("页面反复崩溃");
    expect(dialogOpts(w).buttons).toEqual([crash.BUTTON_RELOAD, crash.BUTTON_OPEN_LOGS, crash.BUTTON_QUIT]);
    expect(w.reload).toHaveBeenCalledTimes(2);
    expect(w.app.quit).not.toHaveBeenCalled();
    expect(w.api.get().renderGiveUpPrompted).toBe(false);
    await w.api.onRenderProcessGone(w.mainWin.webContents, gone("crashed")); // 用户点了重试后又崩：还能再提示
    expect(w.dialog.showMessageBox).toHaveBeenCalledTimes(2);
  });

  it("提示里点「打开日志目录」：打开后再问一次（页面还是白的，别让用户卡在白屏），直到选「退出」", async () => {
    const w = makeWorld({ choices: [crash.BUTTON_OPEN_LOGS, crash.BUTTON_QUIT] });
    await w.api.onRenderProcessGone(w.mainWin.webContents, gone("oom"));
    await w.api.onRenderProcessGone(w.mainWin.webContents, gone("oom"));
    expect(w.dialog.showMessageBox).toHaveBeenCalledTimes(2);
    expect(w.shell.openPath).toHaveBeenCalledWith(LOGS_DIR);
    expect(w.app.quit).toHaveBeenCalledTimes(1);
    expect(dialogOpts(w).detail).toContain("内存不足");
  });

  it("提示还在显示时又来一次崩溃事件：不重复弹窗", async () => {
    let answer!: (v: { response: number }) => void;
    const w = makeWorld();
    w.dialog.showMessageBox.mockImplementationOnce(() => new Promise((r) => (answer = r)));
    await w.api.onRenderProcessGone(w.mainWin.webContents, gone("crashed"));
    const prompting = w.api.onRenderProcessGone(w.mainWin.webContents, gone("crashed"));
    await tick();
    expect(w.dialog.showMessageBox).toHaveBeenCalledTimes(1);
    await w.api.onRenderProcessGone(w.mainWin.webContents, gone("crashed")); // 提示显示期间
    expect(w.dialog.showMessageBox).toHaveBeenCalledTimes(1);
    answer({ response: 2 }); // 退出
    await prompting;
    expect(w.app.quit).toHaveBeenCalledTimes(1);
  });

  it("累计自动刷新到上限（3 次）后：哪怕间隔很久也不再自动刷新，改为提示", async () => {
    const w = makeWorld();
    const now = Date.now();
    w.api.set({ renderReloadTimes: [now - 300 * 1000, now - 200 * 1000, now - 100 * 1000] });
    await w.api.onRenderProcessGone(w.mainWin.webContents, gone("killed"));
    expect(w.reload).not.toHaveBeenCalled();
    expect(w.dialog.showMessageBox).toHaveBeenCalledTimes(1);
  });
});

describe("III. 源码契约（防回退）", () => {
  const startServerSrc = sliceMainFn("startServer");

  it("server 的 exit 回调收 (code, signal) 并交给 onServerExit，且带 .catch（处置本身出错不能变成未处理的 rejection）；旧的常量 `code=?` 与单按钮弹窗已删", () => {
    expect(startServerSrc).toMatch(/proc\.on\("exit", \(code, signal\) => \{\s*onServerExit\(\{ proc, startedAt, code, signal \}\)\.catch\(/);
    expect(mainSrc).not.toContain('code ?? "?"');
    expect(mainSrc).not.toContain('dialog.showErrorBox(\n        "服务异常退出"');
    expect(startServerSrc.indexOf("const startedAt = Date.now();")).toBeGreaterThan(-1);
    expect(startServerSrc.indexOf("const startedAt = Date.now();")).toBeLessThan(startServerSrc.indexOf("spawn(serverNodeBin()"));
  });

  it("崩溃取证报告目录只有一个来源（nodeReportsDir）：startServer 用它、弹窗的「打开崩溃报告目录」也用它", () => {
    expect(startServerSrc).toContain("const nodeReportDir = nodeReportsDir();");
    expect(mainSrc.match(/"node-reports"/g)).toHaveLength(1);
    expect(sliceMainFn("onServerExit")).toContain("nodeReportsDir()");
  });

  it("进程级事件：只用 uncaughtExceptionMonitor（同步落盘、不改变默认处置）；不装 uncaughtException / unhandledRejection 处理器——致命错误不被吞", () => {
    expect(mainSrc).toMatch(/^process\.on\("uncaughtExceptionMonitor", \(err, origin\) => \{\n  shellLogger\.logSync\(/m);
    expect(mainSrc).not.toMatch(/process\.on\(\s*["']uncaughtException["']/);
    expect(mainSrc).not.toMatch(/process\.on\(\s*["']unhandledRejection["']/);
  });

  it("render-process-gone / child-process-gone 已注册；前者的处置带 .catch", () => {
    expect(mainSrc).toMatch(/app\.on\("render-process-gone", \(_event, webContents, details\) => \{\s*onRenderProcessGone\(webContents, details\)\.catch\(/);
    expect(mainSrc).toMatch(/app\.on\("child-process-gone", \(_event, details\) => \{\s*log\(describeChildGone\(details\)\);/);
  });
});

describe("IV. 启动期崩溃后不再叠一个「启动超时」弹窗（B2-4b 终审 P3-4）", () => {
  // whenReady 回调里的「server 未就绪、放弃启动」分支没法切成函数，走源码文本契约：
  // 从「放弃启动」日志到 showErrorBox("启动超时") 之间必须有 serverCrashPrompted 守卫（先关 splash → 守卫 → 只记日志并 return、不抢先退出）。
  // 成因：server 启动就崩 → onServerExit 弹出（非阻塞的）崩溃窗；与此同时 waitForReady 还在轮询到超时（常规 60s / 首次 150s），
  // 旧的 showErrorBox 是同步阻塞的所以以前不会交错；用户没点崩溃窗就会再弹一个「启动超时」。
  type GuardRule = "no-log-anchor" | "no-error-box" | "guard-missing" | "guard-no-return" | "guard-quits" | "splash-not-closed-first";

  const checkBootCrashGuard = (main: string): GuardRule[] => {
    const iLog = main.indexOf("server 未就绪、放弃启动");
    if (iLog < 0) return ["no-log-anchor"];
    const boxRe = /dialog\.showErrorBox\(\s*"启动超时"/g;
    boxRe.lastIndex = iLog;
    const box = boxRe.exec(main);
    if (!box) return ["no-error-box"];
    // 窗口 = 「放弃启动」日志到启动超时弹窗之间；整行 // 注释剥掉（注释里会解释这个守卫，不剥会让「删了守卫、注释还在」假绿）
    const windowText = main
      .slice(iLog, box.index)
      .split("\n")
      .filter((l) => !/^\s*\/\//.test(l))
      .join("\n");
    const guard = /if\s*\(\s*serverCrashPrompted\s*\)\s*\{([\s\S]*?)\n\s*\}/.exec(windowText);
    if (!guard) return ["guard-missing"];
    const out: GuardRule[] = [];
    if (!/\breturn\s*;/.test(guard[1]!)) out.push("guard-no-return");
    if (/\bapp\.quit\(|\bquitting\s*=\s*true\b/.test(guard[1]!)) out.push("guard-quits");
    const iSplash = windowText.indexOf("closeSplashWindow()");
    if (iSplash < 0 || iSplash > guard.index) out.push("splash-not-closed-first");
    return out;
  };

  const mutateText = (src: string, from: string | RegExp, to: string): string => {
    const out = src.replace(from, to);
    expect(out, `变异没命中：${String(from)}`).not.toBe(src);
    return out;
  };
  const GUARD_BLOCK = /      if \(serverCrashPrompted\) \{[\s\S]*?\n      \}\n(?=      dialog\.showErrorBox\()/;

  it("真实 main.js：先关 splash；server 已崩且弹过崩溃窗时只记日志并 return——不再弹「启动超时」，也不抢先退出（崩溃窗里点完自己 quit）", () => {
    expect(checkBootCrashGuard(mainSrc)).toEqual([]);
  });

  it("「启动超时」弹窗本身还在（没被连带删掉）：server 没崩只是没就绪时照旧提示", () => {
    expect(mainSrc).toMatch(/dialog\.showErrorBox\(\s*"启动超时"/);
  });

  it.each<[string, (s: string) => string, GuardRule]>([
    ["删掉守卫", (s) => mutateText(s, GUARD_BLOCK, ""), "guard-missing"],
    ["条件改成别的变量", (s) => mutateText(s, "if (serverCrashPrompted) {\n        // server 在启动期间", "if (quitting) {\n        // server 在启动期间"), "guard-missing"],
    ["守卫里漏了 return", (s) => mutateText(s, '不再弹「启动超时」");\n        return;\n      }', '不再弹「启动超时」");\n      }'), "guard-no-return"],
    ["守卫里抢先 app.quit()", (s) => mutateText(s, '不再弹「启动超时」");\n        return;', '不再弹「启动超时」");\n        app.quit();\n        return;'), "guard-quits"],
    ["守卫里抢先置 quitting", (s) => mutateText(s, '不再弹「启动超时」");\n        return;', '不再弹「启动超时」");\n        quitting = true;\n        return;'), "guard-quits"],
    [
      "守卫挪到「启动超时」弹窗之后（已经弹过了）",
      (s) => {
        const guard = GUARD_BLOCK.exec(s)![0];
        const removed = mutateText(s, GUARD_BLOCK, "");
        return mutateText(removed, "      quitting = true;\n      await stopServer();\n      app.quit();\n    }\n  });", `${guard}      quitting = true;\n      await stopServer();\n      app.quit();\n    }\n  });`);
      },
      "guard-missing",
    ],
    [
      "先过守卫、后关 splash",
      (s) => {
        const removed = mutateText(s, "      closeSplashWindow();\n      if (serverCrashPrompted) {", "      if (serverCrashPrompted) {");
        return mutateText(removed, "      dialog.showErrorBox(\n        \"启动超时\",", "      closeSplashWindow();\n      dialog.showErrorBox(\n        \"启动超时\",");
      },
      "splash-not-closed-first",
    ],
  ])("守卫自检 · %s → 报出对应违例", (_name, breakIt, rule) => {
    expect(checkBootCrashGuard(breakIt(mainSrc))).toContain(rule);
  });

  it("守卫自检 · 注释里残留 if (serverCrashPrompted) { … } 不算数：真守卫删了、注释还在 → 照样报", () => {
    const broken = mutateText(mainSrc, GUARD_BLOCK, "      // if (serverCrashPrompted) {\n      //   return;\n      // }\n");
    expect(checkBootCrashGuard(broken)).toContain("guard-missing");
  });
});

describe("V. 崩溃弹窗出错也要退出（B2-4b 终审 P3-8）", () => {
  // onServerExit 是崩溃处置的末端：置 serverCrashPrompted 之后，弹窗 / 文案构造一旦抛错，调用方（startServer 的 exit 回调）的 .catch 只记日志；
  // 启动期崩溃时 whenReady 又不再叠「启动超时」弹窗（P3-4）——不退出就是没窗口、没提示的悬着进程。
  // 行为测试在 I 组（切函数体真跑）；这里钉源码形状，防止有人把 try / catch / finally 改回「弹窗之后才 app.quit()」。
  type QuitRule = "no-flag" | "no-try-catch-finally" | "ask-outside-try" | "no-catch-log" | "no-finally-quit" | "quit-in-try";

  // 整行 // 注释剥掉（注释里会解释这个结构，不剥会让「真代码删了、注释还在」假绿）
  const stripWholeLineComments = (s: string): string =>
    s
      .split("\n")
      .filter((l) => !/^\s*\/\//.test(l))
      .join("\n");

  const checkPromptQuits = (main: string): QuitRule[] => {
    const body = stripWholeLineComments(sliceMainFn("onServerExit", main));
    const flag = "serverCrashPrompted = true;";
    const iFlag = body.indexOf(flag);
    if (iFlag < 0) return ["no-flag"];
    const tail = body.slice(iFlag + flag.length);
    // 函数体缩进 2 空格：try / catch / finally 的闭合 `}` 都在 2 空格缩进（内层块更深），以此切成三块
    // 第一块（flag 与 try 之间）正常应该是空的：弹窗挪到那里就保护不到了
    const m = /^([\s\S]*?)\n {2}try \{([\s\S]*?)\n {2}\} catch(?: \(\w+\))? \{([\s\S]*?)\n {2}\} finally \{([\s\S]*?)\n {2}\}\n\};\s*$/.exec(tail);
    if (!m) return ["no-try-catch-finally"];
    const beforeTry = m[1]!;
    const tryBody = m[2]!;
    const catchBody = m[3]!;
    const finallyBody = m[4]!;
    const out: QuitRule[] = [];
    if (/\baskCrashChoice\(/.test(beforeTry) || !/\bawait askCrashChoice\(/.test(tryBody)) out.push("ask-outside-try");
    if (!/\blog\(/.test(catchBody)) out.push("no-catch-log");
    if (!/\bapp\.quit\(\)/.test(finallyBody)) out.push("no-finally-quit");
    if (/\bapp\.quit\(\)/.test(tryBody)) out.push("quit-in-try");
    return out;
  };

  const mutate = (src: string, from: string | RegExp, to: string): string => {
    const out = src.replace(from, to);
    expect(out, `变异没命中：${String(from)}`).not.toBe(src);
    return out;
  };
  const mutateWith = (src: string, from: RegExp, fn: (m: string, ...g: string[]) => string): string => {
    const out = src.replace(from, fn);
    expect(out, `变异没命中：${String(from)}`).not.toBe(src);
    return out;
  };
  const FINALLY_QUIT = "  } finally {\n    app.quit();\n  }\n};";
  const FINALLY_EMPTY = "  } finally {\n    void 0;\n  }\n};";
  // 锚在 serverCrashPrompted = true; 之后：`  try {\n` 是 4 空格缩进 try 的子串、也出现在更早的函数里，不锚会吞掉别处
  const TRY_TAIL = /( {2}serverCrashPrompted = true;\n(?: {2}\/\/[^\n]*\n)*) {2}try \{\n([\s\S]*?)\n {2}\} catch \(err\) \{\n[\s\S]*?\n {2}\} finally \{\n {4}app\.quit\(\);\n {2}\}\n\};/;
  const ASK_STMT = /    const choice = await askCrashChoice\([\s\S]*?\n {4}\);\n/;

  it("真实 main.js：置 serverCrashPrompted 之后，弹窗在 try 里、出错记日志、finally 里 app.quit()（只此一处）", () => {
    expect(checkPromptQuits(mainSrc)).toEqual([]);
  });

  it.each<[string, (s: string) => string, QuitRule]>([
    [
      "回到旧结构：去掉 try / catch / finally，弹窗之后才 app.quit()",
      (s) => mutateWith(s, TRY_TAIL, (_m, head, inner) => `${head}${inner}\n  app.quit();\n};`),
      "no-try-catch-finally",
    ],
    ["finally 里不再 quit", (s) => mutate(s, FINALLY_QUIT, FINALLY_EMPTY), "no-finally-quit"],
    [
      "quit 挪进 try 末尾、finally 留空（弹窗抛错时就不退出了）",
      (s) => mutate(mutate(s, FINALLY_QUIT, FINALLY_EMPTY), "nodeReportsDir());\n  } catch", "nodeReportsDir());\n    app.quit();\n  } catch"),
      "quit-in-try",
    ],
    ["catch 里不留日志", (s) => mutate(s, "    log(`[main] server 崩溃提示出错、直接退出：${err?.message || err}`);\n", "    void err;\n"), "no-catch-log"],
    [
      "弹窗挪到 try 外面（抛错时 try / catch 保护不到它）",
      (s) => {
        const ask = ASK_STMT.exec(s)![0];
        const without = mutate(s, ASK_STMT, "");
        return mutateWith(without, /( {2}serverCrashPrompted = true;\n(?: {2}\/\/[^\n]*\n)*)( {2}try \{\n)/, (_m, a, b) => `${a}${ask}${b}`);
      },
      "ask-outside-try",
    ],
  ])("源码形状自检 · %s → 报出对应违例", (_name, breakIt, rule) => {
    expect(checkPromptQuits(breakIt(mainSrc))).toContain(rule);
  });

  it("源码形状自检 · 注释里残留 finally { app.quit(); } 不算数：真 quit 删了、注释还在 → 照样报", () => {
    const broken = mutate(mainSrc, FINALLY_QUIT, "  } finally {\n    // app.quit();\n  }\n};");
    expect(checkPromptQuits(broken)).toContain("no-finally-quit");
  });
});
