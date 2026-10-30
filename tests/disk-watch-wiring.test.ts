/**
 * 低磁盘监视的编排（R14 B2-4b / Q15-10 壳部分）：切 `electron-app/main.js` 里真实的 `checkDiskOnce` / `startDiskWatch`
 * 函数体**真实执行**，注入 statfs / Notification / setInterval / app 等替身。判定与文案是 disk-watch.mjs 的纯函数
 * （tests/disk-watch.test.ts 单测），这里测的是 main.js 里把它们接起来的那一层：
 *   I.   checkDiskOnce：量的是 userData/data 所在盘（data 还没建就回退 userData）、量不到不通知、偏低 / 严重各发一条系统通知、
 *        同级别 30 分钟后不重复 / 24 小时后再提醒、低 → 严重立刻再提醒、恢复后再低重新提醒、
 *        系统不支持通知 / 构造抛错 / app.getPath 抛错都不外抛（它跑在定时器里，抛出去就是 uncaughtException）
 *   II.  startDiskWatch：启动立即量一次，注册 30 分钟定时器并 unref，到点回调就是 checkDiskOnce
 *   III. 源码契约：whenReady 里恰好调一次 startDiskWatch、定时器以 .unref() 收尾、阈值不在 main.js 内联（判定全在 disk-watch.mjs）
 * ⚠ 全部是「切函数体 + 替身」：没有在真实 Electron 里让盘变满、没有真的看过系统通知（macOS 通知权限 / 勿扰模式也没验证）。
 */
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { bytesToMB, freeBytes } from "../electron-app/disk-space.mjs";
import * as watch from "../electron-app/disk-watch.mjs";
import { instantiateMany, mainDecls, mainSrc, sliceMainFn } from "./helpers/main-slice";

const FNS = ["checkDiskOnce", "startDiskWatch"];
const PRELUDE = mainDecls("diskNoticeState");

const MB = 1048576;
const H = 3_600_000;
const T0 = 1_700_000_000_000;
const USER = "/u/userData";
const DATA = `${USER}/data`;

interface Api {
  checkDiskOnce: () => void;
  startDiskWatch: () => void;
}

interface WorldOpts {
  /** 目录 → 剩余 MB；没列出的目录 statfs 抛 ENOENT */
  free?: Record<string, number>;
  notifySupported?: boolean;
  notifyThrows?: boolean;
  getPathThrows?: boolean;
}

const makeWorld = (o: WorldOpts = {}) => {
  const logs: string[] = [];
  const shown: Array<{ title: string; body: string }> = [];
  const free: Record<string, number> = { ...(o.free ?? {}) };
  const flags = { supported: o.notifySupported ?? true, throws: o.notifyThrows ?? false };
  const statfsSync = vi.fn((dir: string) => {
    const mb = free[dir];
    if (mb === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return { bavail: mb, bsize: MB };
  });
  class FakeNotification {
    private readonly opts: { title: string; body: string };
    constructor(opts: { title: string; body: string }) {
      if (flags.throws) throw new Error("notification boom");
      this.opts = opts;
    }
    show(): void {
      shown.push(this.opts);
    }
    static isSupported(): boolean {
      return flags.supported;
    }
  }
  const intervals: Array<{ fn: () => void; ms: number; handle: { unref: ReturnType<typeof vi.fn> } }> = [];
  const fakeSetInterval = (fn: () => void, ms: number) => {
    const handle = { unref: vi.fn() };
    intervals.push({ fn, ms, handle });
    return handle;
  };
  const app = {
    getPath: vi.fn((k: string) => {
      if (o.getPathThrows) throw new Error("getPath boom");
      return k === "userData" ? USER : `/u/${k}`;
    }),
  };
  const deps = {
    log: (m: string) => logs.push(m),
    path,
    app,
    statfsSync,
    freeBytes,
    bytesToMB,
    Notification: FakeNotification,
    setInterval: fakeSetInterval,
    classifyDiskLevel: watch.classifyDiskLevel,
    decideDiskNotice: watch.decideDiskNotice,
    buildLowDiskNotice: watch.buildLowDiskNotice,
    emptyDiskNoticeState: watch.emptyDiskNoticeState,
    DISK_CHECK_INTERVAL_MS: watch.DISK_CHECK_INTERVAL_MS,
  };
  const api = instantiateMany<Api>(FNS, deps, PRELUDE, "return { checkDiskOnce, startDiskWatch };");
  return { api, logs, shown, free, flags, statfsSync, intervals, app };
};

afterEach(() => {
  vi.useRealTimers();
});

describe("I. checkDiskOnce：量盘 → 分级 → 通知", () => {
  it("量的是 userData/data 所在盘；剩 10GB → ok：不通知，日志只留一行", () => {
    vi.setSystemTime(T0);
    const w = makeWorld({ free: { [DATA]: 10_240 } });
    w.api.checkDiskOnce();
    expect(w.statfsSync).toHaveBeenCalledTimes(1);
    expect(w.statfsSync).toHaveBeenCalledWith(DATA);
    expect(w.shown).toHaveLength(0);
    expect(w.logs).toEqual(["[disk] 数据目录所在盘剩余 10240MB level=ok"]);
  });

  it("data 目录还没建（全新安装首次启动）→ 回退量 userData", () => {
    vi.setSystemTime(T0);
    const w = makeWorld({ free: { [USER]: 10_240 } });
    w.api.checkDiskOnce();
    expect(w.statfsSync.mock.calls.map((c) => c[0])).toEqual([DATA, USER]);
    expect(w.logs).toEqual(["[disk] 数据目录所在盘剩余 10240MB level=ok"]);
  });

  it("剩余 MB 向下取整（不出现「499.5 MB」这种小数）：日志与通知正文用的是同一个整数", () => {
    vi.setSystemTime(T0);
    const w = makeWorld({ free: { [DATA]: 499.5 } }); // statfs 替身的 bsize = 1MB，bavail = 499.5 即 499.5MB
    w.api.checkDiskOnce();
    expect(w.logs[0]).toContain("剩余 499MB level=critical");
    expect(w.shown).toHaveLength(1);
    expect(w.shown[0]!.body).toContain("499 MB");
    expect(w.shown[0]!.body).not.toContain("499.5");
  });

  it("两个目录都量不到 → unknown：日志写「?」、不通知、不抛", () => {
    vi.setSystemTime(T0);
    const w = makeWorld({ free: {} });
    expect(() => w.api.checkDiskOnce()).not.toThrow();
    expect(w.shown).toHaveLength(0);
    expect(w.logs).toEqual(["[disk] 数据目录所在盘剩余 ? level=unknown"]);
  });

  it("剩 1.5GB → 偏低：发一条系统通知（只有 title / body），日志标注「通知用户」", () => {
    vi.setSystemTime(T0);
    const w = makeWorld({ free: { [DATA]: 1536 } });
    w.api.checkDiskOnce();
    expect(w.shown).toEqual([watch.buildLowDiskNotice({ level: "low", freeMB: 1536 })]);
    expect(w.shown[0].title).toBe("磁盘空间偏低");
    expect(w.shown[0].body).toContain("1.5 GB");
    expect(w.logs).toEqual(["[disk] 数据目录所在盘剩余 1536MB level=low → 通知用户"]);
  });

  it("剩 300MB → 严重：发「严重」通知", () => {
    vi.setSystemTime(T0);
    const w = makeWorld({ free: { [DATA]: 300 } });
    w.api.checkDiskOnce();
    expect(w.shown).toHaveLength(1);
    expect(w.shown[0].title).toBe("磁盘空间严重不足");
    expect(w.shown[0].body).toContain("300 MB");
  });

  it("同级别：30 分钟后、24 小时前都不重复；满 24 小时再提醒", () => {
    const w = makeWorld({ free: { [DATA]: 1536 } });
    vi.setSystemTime(T0);
    w.api.checkDiskOnce();
    vi.setSystemTime(T0 + 30 * 60_000);
    w.api.checkDiskOnce();
    vi.setSystemTime(T0 + 24 * H - 1);
    w.api.checkDiskOnce();
    expect(w.shown).toHaveLength(1);
    vi.setSystemTime(T0 + 24 * H);
    w.api.checkDiskOnce();
    expect(w.shown).toHaveLength(2);
  });

  it("偏低 → 严重：升级立刻再提醒（不用等 24 小时）", () => {
    const w = makeWorld({ free: { [DATA]: 1536 } });
    vi.setSystemTime(T0);
    w.api.checkDiskOnce();
    w.free[DATA] = 300;
    vi.setSystemTime(T0 + 30 * 60_000);
    w.api.checkDiskOnce();
    expect(w.shown.map((n) => n.title)).toEqual(["磁盘空间偏低", "磁盘空间严重不足"]);
  });

  it("恢复正常后再变低：重新提醒（不用等满 24 小时）", () => {
    const w = makeWorld({ free: { [DATA]: 1536 } });
    vi.setSystemTime(T0);
    w.api.checkDiskOnce();
    w.free[DATA] = 10_240;
    vi.setSystemTime(T0 + 30 * 60_000);
    w.api.checkDiskOnce();
    w.free[DATA] = 1536;
    vi.setSystemTime(T0 + 60 * 60_000);
    w.api.checkDiskOnce();
    expect(w.shown).toHaveLength(2);
  });

  it("偶发量不到（statfs 抛）夹在中间：不清记录、不重复提醒", () => {
    const w = makeWorld({ free: { [DATA]: 1536 } });
    vi.setSystemTime(T0);
    w.api.checkDiskOnce();
    delete w.free[DATA];
    vi.setSystemTime(T0 + 30 * 60_000);
    w.api.checkDiskOnce();
    w.free[DATA] = 1536;
    vi.setSystemTime(T0 + 60 * 60_000);
    w.api.checkDiskOnce();
    expect(w.shown).toHaveLength(1);
  });

  it("系统不支持通知：不构造、不抛，日志说明没发出去", () => {
    vi.setSystemTime(T0);
    const w = makeWorld({ free: { [DATA]: 1536 }, notifySupported: false });
    expect(() => w.api.checkDiskOnce()).not.toThrow();
    expect(w.shown).toHaveLength(0);
    expect(w.logs).toEqual([
      "[disk] 数据目录所在盘剩余 1536MB level=low → 通知用户",
      "[disk] 系统通知不可用，没发出去",
    ]);
  });

  it("构造通知时抛错：被收住、记日志、不外抛（它跑在定时器里）", () => {
    vi.setSystemTime(T0);
    const w = makeWorld({ free: { [DATA]: 1536 }, notifyThrows: true });
    expect(() => w.api.checkDiskOnce()).not.toThrow();
    expect(w.logs.at(-1)).toBe("[disk] 低空间检查出错（忽略）：notification boom");
  });

  it("app.getPath 抛错：被收住、记日志、不外抛", () => {
    vi.setSystemTime(T0);
    const w = makeWorld({ free: { [DATA]: 1536 }, getPathThrows: true });
    expect(() => w.api.checkDiskOnce()).not.toThrow();
    expect(w.logs).toEqual(["[disk] 低空间检查出错（忽略）：getPath boom"]);
    expect(w.shown).toHaveLength(0);
  });
});

describe("II. startDiskWatch：启动量一次 + 30 分钟定时", () => {
  it("启动立即量一次；注册 30 分钟定时器并 unref；到点回调就是 checkDiskOnce", () => {
    vi.setSystemTime(T0);
    const w = makeWorld({ free: { [DATA]: 10_240 } });
    w.api.startDiskWatch();
    expect(w.statfsSync).toHaveBeenCalledTimes(1);
    expect(w.intervals).toHaveLength(1);
    expect(w.intervals[0].ms).toBe(30 * 60_000);
    expect(w.intervals[0].handle.unref).toHaveBeenCalledTimes(1);
    expect(w.intervals[0].fn).toBe(w.api.checkDiskOnce);
    w.intervals[0].fn();
    expect(w.statfsSync).toHaveBeenCalledTimes(2);
  });

  it("启动时盘已经偏低：启动那一次就通知（不用等 30 分钟）", () => {
    vi.setSystemTime(T0);
    const w = makeWorld({ free: { [DATA]: 1536 } });
    w.api.startDiskWatch();
    expect(w.shown).toHaveLength(1);
  });
});

describe("III. 源码契约", () => {
  it("whenReady 里恰好调用一次 startDiskWatch()，且在 appReady 里程碑之后", () => {
    const calls = [...mainSrc.matchAll(/^\s*startDiskWatch\(\);/gm)];
    expect(calls).toHaveLength(1);
    const readyAt = mainSrc.indexOf("app.whenReady().then(");
    expect(readyAt).toBeGreaterThan(0);
    expect(calls[0].index).toBeGreaterThan(readyAt);
  });

  it("定时器以 .unref() 收尾（不拖住进程退出），间隔读 DISK_CHECK_INTERVAL_MS 常量", () => {
    expect(sliceMainFn("startDiskWatch")).toContain("setInterval(checkDiskOnce, DISK_CHECK_INTERVAL_MS).unref();");
  });

  it("阈值不在 main.js 内联：判定全在 disk-watch.mjs（main.js 里没有 LOW_DISK_* 阈值名）", () => {
    expect(mainSrc).not.toMatch(/LOW_DISK_(WARN|CRITICAL)_MB/);
  });
});
