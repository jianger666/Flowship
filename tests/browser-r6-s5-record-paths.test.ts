/* eslint-disable @typescript-eslint/no-explicit-any -- 假 tab / 假 session 是刻意的，被测 .mjs 无类型声明 */
/**
 * R6-34（record 侧）：时间线标记 / export_activity 的文件内容与返回值 / 错误文案里不出现 userData 绝对路径；
 * R6-37：mp4 / frames 导出与 export_activity 的目录逐级经 ensureSafeDir——任务目录 / browser-recordings（根）/ <recId>（叶子）为符号链接时拒绝，且不写任何文件；
 * ffmpeg 运行期间目录被换成符号链接 → 落盘前复核拒绝；已被清理的录制报 BAD_ARGS 且不会顺手建出空目录；导出目录出错的文案不再说 browser-recordings。
 * 真实 BrowserSession + 假 tab（同 tests/browser-e2-p9-ops.test.ts 的口径）。
 */
import nodeCrypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createActivityLog } from "../electron-app/browser/activity-log.mjs";
import { OP_HELPERS } from "../electron-app/browser/index.mjs";
import { createHandlers, normalize } from "../electron-app/browser/ops/record.mjs";
import { exportsRootFor, recordingsRootFor } from "../electron-app/browser/record-policy.mjs";
import { BrowserSession } from "../electron-app/browser/session.mjs";

const isWin = process.platform === "win32";
const TASK = "task-s5";
const jpeg = (tag = 0) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, tag), Buffer.from([0xff, 0xd9])]);
const b64 = (b: Buffer) => b.toString("base64");

class FakeRecTab {
  ready = Promise.resolve();
  opener: string | null = null;
  title = "示例页";
  pendingDialog: any = null;
  hadRecentGesture = vi.fn(() => true);
  navigate = vi.fn(async () => ({ url: this.url, title: this.title, status: 200 }));
  setInputIgnored = vi.fn(async () => {});
  releaseHeldButtons = vi.fn(async () => {});
  overlaySetActive = vi.fn(async () => {});
  overlayHide = vi.fn(async () => {});
  moveToMain = vi.fn();
  moveToParking = vi.fn();
  setBounds = vi.fn();
  setVisible = vi.fn();
  capturePlaceholder = vi.fn(async () => "data:image/jpeg;base64,FAKE");
  ensureCdp = vi.fn(async () => {});
  listeners = new Set<(m: string, p: any, sid?: string | null) => void>();
  destroyHooks = new Set<() => void>();
  destroyed = false;
  calls: Array<{ method: string; params: any; sid: any }> = [];
  constructor(
    public id: string,
    public url: string,
  ) {}
  send = vi.fn(async (method: string, params: any = {}, sid: any = null) => {
    this.calls.push({ method, params, sid });
    if (method === "Runtime.evaluate") return { result: { value: { state: "safe", opaque: 0, opaqueVisible: 0 } } };
    return {};
  });
  cdpSessionIds() {
    return [null];
  }
  async frame(data: Buffer) {
    const before = this.acks().length;
    for (const l of [...this.listeners]) l("Page.screencastFrame", { data: b64(data), sessionId: 1, metadata: {} }, null);
    await vi.waitFor(() => expect(this.acks().length).toBe(before + 1));
  }
  acks = () => this.calls.filter((c) => c.method === "Page.screencastFrameAck");
  onCdpEvent(fn: any) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  addDestroyHook(fn: () => void) {
    this.destroyHooks.add(fn);
    return () => this.destroyHooks.delete(fn);
  }
  destroy = vi.fn(() => {
    this.destroyed = true;
    for (const h of [...this.destroyHooks]) h();
  });
  info(isActive: boolean) {
    return { id: this.id, url: this.url, title: this.title, favicon: null, loading: false, canGoBack: false, canGoForward: false, isActive };
  }
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

interface MkOpts {
  /** 指定 userData（默认 mkdtemp）；清理由调用方负责父目录 */
  userData?: string;
  fs?: any;
  execFile?: any;
  env?: Record<string, string>;
}

const mk = async (opts: MkOpts = {}) => {
  const userData = opts.userData ?? fs.mkdtempSync(path.join(os.tmpdir(), "r6s5-rec-"));
  const clock = { now: 1_700_000_000_000 };
  const activityLog = createActivityLog({ now: () => clock.now });
  let tab!: FakeRecTab;
  const host: any = {
    createTab: ({ id }: { id: string }) => (tab = new FakeRecTab(id, "http://127.0.0.1:1/page")),
    getMainWindow: () => ({}),
    getParkingWindow: () => ({}),
    onChange: vi.fn(),
    emitEvent: vi.fn(),
    emitPicked: vi.fn(),
    startPicker: vi.fn(),
  };
  const session = new BrowserSession({ taskId: TASK, host, activityLog, graceMs: 8_000, now: () => clock.now });
  await session.openTab({});
  const execFile = opts.execFile ?? vi.fn();
  const handlers = createHandlers({
    requireSession: () => session,
    getConfig: () => ({}),
    scheduleState: vi.fn(),
    app: { getPath: () => userData },
    electron: { isAppUrl: () => false },
    addStateContributor: () => {},
    registerExt: () => {},
    log: () => {},
    now: () => clock.now,
    recordLimits: {},
    env: opts.env,
    execFile,
    ...(opts.fs ? { fs: opts.fs } : {}),
  } as any);
  cleanups.push(() => {
    try {
      session.destroy();
    } catch {
      /* 已销毁 */
    }
    fs.rmSync(userData, { recursive: true, force: true });
  });
  const root = recordingsRootFor(userData, TASK)!;
  const exportsRoot = exportsRootFor(userData, TASK)!;
  const taskDir = path.dirname(root);
  return {
    userData,
    tab,
    clock,
    session,
    activityLog,
    root,
    exportsRoot,
    taskDir,
    execFile,
    call: (args: Record<string, unknown>) => (handlers as any).record(TASK, normalize("record", args, OP_HELPERS as any)),
  };
};
type Env = Awaited<ReturnType<typeof mk>>;

const recordOne = async (e: Env, n = 3) => {
  await e.call({ action: "start" });
  for (let i = 0; i < n; i += 1) {
    e.clock.now += 100;
    await e.tab.frame(jpeg(i));
  }
  return e.call({ action: "stop" });
};

const nodeErr = (code: string, syscall: string, p: string, desc: string) => Object.assign(new Error(`${code}: ${desc}, ${syscall} '${p}'`), { code, syscall, path: p, errno: -1 });

// ───────────────────────────── R6-34 ─────────────────────────────

describe("R6-34 record：绝对路径不进时间线标记 / export_activity 内容与返回值 / 错误文案", () => {
  it("export_activity：返回值只有 file + dir（无 path、无 userData）；导出文件内容里其它写入方塞进 AI 条目的 userData 绝对路径被剔除", async () => {
    const e = await mk();
    const perfDir = path.join(e.userData, "data", "tasks", TASK, "browser-traces");
    e.activityLog.addAI({ kind: "download", tabId: "1", url: "", summary: `保存了页面堆快照 heap-1.heapsnapshot，位置 ${perfDir}` });
    e.activityLog.addAI({ kind: "download", tabId: "1", url: "", summary: `另一处只截到前半段 ${e.userData}/data/ta` });
    const r = await e.call({ action: "export_activity", format: "json" });
    expect(r.path).toBeUndefined();
    expect(r).toMatchObject({ action: "export_activity", dir: "browser-exports" });
    expect(r.file).toMatch(/^activity-\d{8}-\d{6}\.json$/);
    expect(JSON.stringify(r)).not.toContain(e.userData);
    const text = fs.readFileSync(path.join(e.exportsRoot, r.file), "utf8");
    expect(text).toContain("保存了页面堆快照 heap-1.heapsnapshot"); // 其余内容照常
    expect(text).not.toContain(e.userData);
    expect(text).not.toContain(path.basename(e.userData));
    const md = await e.call({ action: "export_activity", format: "markdown" });
    const mdText = fs.readFileSync(path.join(e.exportsRoot, md.file), "utf8");
    expect(mdText).not.toContain(e.userData);
    expect(md.path).toBeUndefined();
  });

  it("stop 结果的 ai-action 标记与 timeline.json 里同样没有 userData 绝对路径（录制期间 AI 条目带路径的兜底）", async () => {
    const e = await mk();
    await e.call({ action: "start" });
    e.clock.now += 100;
    e.activityLog.addAI({ kind: "download", tabId: "1", url: "", summary: `保存了页面堆快照 heap-2.heapsnapshot，位置 ${path.join(e.userData, "data", "tasks", TASK, "browser-traces")}` });
    e.clock.now += 100;
    await e.tab.frame(jpeg(1));
    const r = await e.call({ action: "stop" });
    const m = (r.markers as Array<{ type: string; text: string }>).find((x) => x.text.includes("保存了页面堆快照"));
    expect(m, "标记里应有这条 AI 动作").toBeTruthy();
    expect(m!.type).toBe("ai-action");
    expect(JSON.stringify(r.markers)).not.toContain(e.userData);
    expect(JSON.stringify(r.markers)).not.toContain(path.basename(e.userData));
    const tl = fs.readFileSync(r.timelineFile, "utf8");
    expect(tl).toContain("保存了页面堆快照 heap-2.heapsnapshot");
    expect(tl).not.toContain(e.userData);
  });

  it.skipIf(isWin)("写盘失败（ENOSPC，Node 原始 message 带绝对路径）：export_activity 的错误文案只有 errno 码 + 文件名", async () => {
    const real = fs;
    const wrapped = {
      ...real,
      openSync: (p: any, ...rest: any[]) => {
        if (String(p).includes("activity-") || String(p).includes(".activity-")) throw nodeErr("ENOSPC", "open", String(p), "no space left on device");
        return (real.openSync as any)(p, ...rest);
      },
    };
    const e = await mk({ fs: wrapped });
    const err = await e.call({ action: "export_activity" }).then(
      () => null,
      (x: any) => x,
    );
    expect(err).toMatchObject({ code: "INTERNAL" });
    expect(err.message).toContain("导出活动日志失败");
    expect(err.message).toContain("ENOSPC");
    expect(err.message).toContain("磁盘空间不足");
    expect(err.message).toMatch(/\.activity-\d{8}-\d{6}\.json\.\d+\.[0-9a-f]{6}\.tmp/);
    expect(err.message).not.toContain(e.userData);
    expect(err.message).not.toContain(path.basename(e.userData));
    expect(err.message).not.toContain("browser-exports");
  });

  it.skipIf(isWin)("start 建录制目录失败（EACCES）：错误文案不含绝对路径", async () => {
    const real = fs;
    const wrapped = {
      ...real,
      mkdirSync: (p: any, ...rest: any[]) => {
        if (/rec-\d{8}-/.test(String(p))) throw nodeErr("EACCES", "mkdir", String(p), "permission denied");
        return (real.mkdirSync as any)(p, ...rest);
      },
    };
    const e = await mk({ fs: wrapped });
    const err = await e.call({ action: "start" }).then(
      () => null,
      (x: any) => x,
    );
    expect(err).toMatchObject({ code: "INTERNAL" });
    expect(err.message).toContain("无法创建录制目录");
    expect(err.message).toContain("EACCES");
    expect(err.message).toMatch(/mkdir rec-\d{8}-\d{6}-[0-9a-f]{6}/);
    expect(err.message).not.toContain(e.userData);
    expect(err.message).not.toContain("/data/tasks");
  });
});

describe.skipIf(isWin)("R6-34 record：其余 errMsg / scrubClip 通道（timelineError / timeline 解析 / 启动失败 / 目录校验 / ffmpeg stderr）", () => {
  const reject = (p: Promise<any>) => p.then(() => null, (x: any) => x);

  it("timeline.json 写盘失败（ENOSPC，带绝对路径）：summary.timelineError 只有码 / 释义 / 系统调用 / 文件名，timelineFile 为 null", async () => {
    const real = fs as any;
    const wrapped = {
      ...real,
      openSync: (p: any, ...rest: any[]) => {
        if (/\.timeline\.json\./.test(String(p))) throw nodeErr("ENOSPC", "open", String(p), "no space left on device");
        return real.openSync(p, ...rest);
      },
    };
    const e = await mk({ fs: wrapped });
    const r = await recordOne(e);
    expect(r.timelineFile).toBeNull();
    expect(r.timelineError).toMatch(/^ENOSPC（磁盘空间不足） open \.timeline\.json\./);
    expect(r.timelineError).not.toContain(e.userData);
    expect(r.timelineError).not.toContain(path.basename(e.userData));
    expect(r.timelineError).not.toContain("/data/tasks");
  });

  it("export 读 timeline.json 失败（EACCES，带绝对路径）：文案只有 errno 码 + 文件名", async () => {
    const real = fs as any;
    let armed = false;
    const wrapped = {
      ...real,
      readFileSync: (p: any, ...rest: any[]) => {
        if (armed && String(p).endsWith("timeline.json")) throw nodeErr("EACCES", "open", String(p), "permission denied");
        return real.readFileSync(p, ...rest);
      },
    };
    const e = await mk({ fs: wrapped });
    const r = await recordOne(e);
    armed = true;
    const err = await reject(e.call({ action: "export", recId: r.recId }));
    expect(err).toMatchObject({ code: "INTERNAL" });
    expect(err.message).toContain("timeline.json 解析失败");
    expect(err.message).toContain("EACCES");
    expect(err.message).toContain("open timeline.json");
    expect(err.message).not.toContain(e.userData);
    expect(err.message).not.toContain("/data/tasks");
  });

  it("start 的 Page.startScreencast 失败（message 里夹着 userData 路径）：路径被剔除，文件名保留", async () => {
    const e = await mk();
    e.tab.send.mockImplementation((async (method: string) => {
      if (method === "Page.startScreencast") throw new Error(`screencast 失败，见 ${e.userData}/data/tasks/${TASK}/x.log`);
      return {};
    }) as any);
    const err = await reject(e.call({ action: "start" }));
    expect(err).toMatchObject({ code: "INTERNAL" });
    expect(err.message).toContain("无法开始录制");
    expect(err.message).toContain("x.log");
    expect(err.message).not.toContain(e.userData);
    expect(err.message).not.toContain(path.basename(e.userData));
    expect(err.message).not.toContain("/data/tasks");
  });

  it("导出时目录校验遇到 lstat 的 EACCES（带绝对路径）：「录制目录不安全」文案只有 errno 码 + 目录名", async () => {
    const real = fs as any;
    let armed = false;
    const wrapped = {
      ...real,
      lstatSync: (p: any, ...rest: any[]) => {
        if (armed && path.basename(String(p)) === "browser-recordings") throw nodeErr("EACCES", "lstat", String(p), "permission denied");
        return real.lstatSync(p, ...rest);
      },
    };
    const e = await mk({ fs: wrapped });
    const r = await recordOne(e);
    armed = true;
    const err = await reject(e.call({ action: "export", recId: r.recId }));
    expect(err).toMatchObject({ code: "INTERNAL" });
    expect(err.message).toContain("录制目录不安全");
    expect(err.message).toContain("EACCES");
    expect(err.message).toContain("lstat browser-recordings");
    expect(err.message).not.toContain(e.userData);
    expect(err.message).not.toContain("/data/tasks");
  });

  it("端到端（userData 含空格、在家目录之下、Application Support 形状）：时间线标记 / export_activity 返回值与文件内容 / 各错误文案都不含 userData、家目录", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "r6s5 home-"));
    const userData = path.join(home, "Library", "Application Support", "Flowship Dev");
    fs.mkdirSync(userData, { recursive: true });
    cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
    const spy = vi.spyOn(os, "homedir").mockReturnValue(home);
    cleanups.push(() => spy.mockRestore());
    let failActivity = false;
    const real = fs as any;
    const wrapped = {
      ...real,
      openSync: (p: any, ...rest: any[]) => {
        if (failActivity && String(p).includes(".activity-")) throw nodeErr("ENOSPC", "open", String(p), "no space left on device");
        return real.openSync(p, ...rest);
      },
      mkdirSync: (p: any, ...rest: any[]) => {
        if (failActivity && /rec-\d{8}-/.test(String(p))) throw nodeErr("EACCES", "mkdir", String(p), "permission denied");
        return real.mkdirSync(p, ...rest);
      },
    };
    const e = await mk({ userData, fs: wrapped });
    expect(e.userData).toContain("Application Support");
    const bad = [userData, home, path.basename(home), "Application Support", "Flowship Dev", "/Library/"];
    const clean = (what: string, s: string) => {
      for (const b of bad) expect(s, `${what} 不应含 ${b}`).not.toContain(b);
    };

    await e.call({ action: "start" });
    e.clock.now += 100;
    // 录制期间别的写入方（如旧版 perf）塞进 AI 条目的绝对路径：userData / 家目录（含空格）/ 引号路径
    e.activityLog.addAI({ kind: "download", tabId: "1", url: "", summary: `保存了页面堆快照，位置 ${path.join(userData, "data", "tasks", TASK, "browser-traces")}` });
    e.activityLog.addAI({ kind: "download", tabId: "1", url: "", summary: `另存 ${home}/Documents/proj/b.log 与 '${home}/My Docs/c.log'` });
    e.clock.now += 100;
    await e.tab.frame(jpeg(1));
    const r = await e.call({ action: "stop" });
    clean("stop 标记", JSON.stringify(r.markers));
    expect(JSON.stringify(r.markers)).toContain("b.log");
    clean("timeline.json", fs.readFileSync(r.timelineFile, "utf8"));

    for (const format of ["json", "markdown"]) {
      const x = await e.call({ action: "export_activity", format });
      clean(`export_activity(${format}) 返回值`, JSON.stringify(x));
      clean(`export_activity(${format}) 文件`, fs.readFileSync(path.join(e.exportsRoot, x.file), "utf8"));
    }

    failActivity = true;
    const e1 = await reject(e.call({ action: "export_activity" }));
    expect(e1.message).toContain("ENOSPC");
    clean("导出失败文案", e1.message);
    const e2 = await reject(e.call({ action: "start" }));
    expect(e2.message).toContain("EACCES");
    clean("启动失败文案", e2.message);
  });
});

// ───────────────────────────── R6-37 ─────────────────────────────

describe.skipIf(isWin)("R6-37 导出目录逐级经 ensureSafeDir（符号链接一律拒，且不写文件）", () => {
  const withFfmpeg = (writeTmp = true, hook?: () => void) => {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), "r6s5-bin-"));
    fs.writeFileSync(path.join(bin, "ffmpeg"), "#!/bin/sh\n", { mode: 0o755 });
    cleanups.push(() => fs.rmSync(bin, { recursive: true, force: true }));
    const execFile = vi.fn((_b: string, args: string[], opts: any, cb: any) => {
      if (writeTmp) fs.writeFileSync(path.join(opts.cwd, args.at(-1)!), Buffer.alloc(2048, 1));
      hook?.();
      cb(null, "", "");
    });
    return { bin, execFile };
  };

  /** 目录里没有 mp4 / 临时 mp4（递归） */
  const noMp4 = (dir: string): boolean => {
    if (!fs.existsSync(dir)) return true;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === "recording.mp4" || ent.name.endsWith(".tmp.mp4")) return false;
      if (ent.isDirectory() && !noMp4(path.join(dir, ent.name))) return false;
    }
    return true;
  };

  const expectUnsafe = async (p: Promise<unknown>) => {
    const err = await p.then(
      () => null,
      (x: any) => x,
    );
    expect(err, "应当被拒绝").not.toBeNull();
    expect(err).toMatchObject({ code: "INTERNAL" });
    expect(String(err.message)).toContain("录制目录不安全");
    expect(String(err.message)).toContain("不是普通目录");
    expect(String(err.message)).not.toContain(os.tmpdir());
    return err;
  };

  it("基线：真实目录 + 假 ffmpeg → mp4 导出成功（0600，recording.mp4）", async () => {
    const { bin, execFile } = withFfmpeg();
    const e = await mk({ env: { PATH: bin }, execFile });
    const r = await recordOne(e);
    const x = await e.call({ action: "export", format: "mp4" });
    expect(x).toMatchObject({ format: "mp4", file: "recording.mp4", bytes: 2048 });
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(fs.statSync(path.join(r.dir, "recording.mp4")).mode & 0o777).toBe(0o600);
  });

  it("根目录 browser-recordings 是符号链接：mp4 / frames 导出都拒绝，ffmpeg 没被调用，链接目标里没有 mp4", async () => {
    const { bin, execFile } = withFfmpeg();
    const e = await mk({ env: { PATH: bin }, execFile });
    const r = await recordOne(e);
    const moved = path.join(e.userData, "moved-recordings");
    fs.renameSync(e.root, moved);
    fs.symlinkSync(moved, e.root);
    await expectUnsafe(e.call({ action: "export", format: "mp4", recId: r.recId }));
    await expectUnsafe(e.call({ action: "export", format: "frames", recId: r.recId }));
    expect(execFile).not.toHaveBeenCalled();
    expect(noMp4(moved)).toBe(true);
  });

  it("任务目录是符号链接：拒绝，ffmpeg 没被调用，目标里没有 mp4", async () => {
    const { bin, execFile } = withFfmpeg();
    const e = await mk({ env: { PATH: bin }, execFile });
    const r = await recordOne(e);
    const moved = path.join(e.userData, "moved-task");
    fs.renameSync(e.taskDir, moved);
    fs.symlinkSync(moved, e.taskDir);
    const err = await expectUnsafe(e.call({ action: "export", format: "mp4", recId: r.recId }));
    expect(String(err.message)).toContain("任务目录");
    await expectUnsafe(e.call({ action: "export", format: "frames", recId: r.recId }));
    expect(execFile).not.toHaveBeenCalled();
    expect(noMp4(moved)).toBe(true);
  });

  it("叶子目录 <recId> 是符号链接（指向别处的一份录制）：拒绝，ffmpeg 没被调用", async () => {
    const { bin, execFile } = withFfmpeg();
    const e = await mk({ env: { PATH: bin }, execFile });
    const r = await recordOne(e);
    const copy = path.join(e.userData, "elsewhere", "copy");
    fs.mkdirSync(path.dirname(copy), { recursive: true });
    fs.renameSync(r.dir, copy);
    fs.symlinkSync(copy, r.dir);
    await expectUnsafe(e.call({ action: "export", format: "mp4", recId: r.recId }));
    await expectUnsafe(e.call({ action: "export", format: "frames", recId: r.recId }));
    expect(execFile).not.toHaveBeenCalled();
    expect(noMp4(path.dirname(copy))).toBe(true);
  });

  it("ffmpeg 运行期间 browser-recordings 被换成符号链接：落盘前复核拒绝，recording.mp4 没有生成，临时产物被清掉", async () => {
    const holder: { e?: Env; moved?: string } = {};
    const { bin, execFile } = withFfmpeg(true, () => {
      const e = holder.e!;
      holder.moved = path.join(e.userData, "moved-while-running");
      fs.renameSync(e.root, holder.moved);
      fs.symlinkSync(holder.moved, e.root);
    });
    const e = await mk({ env: { PATH: bin }, execFile });
    holder.e = e;
    const r = await recordOne(e);
    await expectUnsafe(e.call({ action: "export", format: "mp4", recId: r.recId }));
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(noMp4(holder.moved!)).toBe(true);
    expect(fs.existsSync(path.join(holder.moved!, r.recId, "recording.mp4"))).toBe(false);
  });

  it("产物是符号链接（ffmpeg 位置被换成指向别处的链接）：拒绝，不 chmod / rename，目标文件不被改动", async () => {
    const victim = path.join(os.tmpdir(), `r6s5-victim-${process.pid}-${Date.now()}.bin`);
    fs.writeFileSync(victim, "precious", { mode: 0o644 });
    cleanups.push(() => fs.rmSync(victim, { force: true }));
    const { bin, execFile } = withFfmpeg(false, undefined);
    execFile.mockImplementation(((_b: string, args: string[], opts: any, cb: any) => {
      fs.symlinkSync(victim, path.join(opts.cwd, args.at(-1)!));
      cb(null, "", "");
    }) as any);
    const e = await mk({ env: { PATH: bin }, execFile });
    const r = await recordOne(e);
    await expect(e.call({ action: "export", format: "mp4", recId: r.recId })).rejects.toMatchObject({ code: "INTERNAL" });
    expect(fs.readFileSync(victim, "utf8")).toBe("precious");
    expect(fs.statSync(victim).mode & 0o777).toBe(0o644); // 没有被 chmod 成 0600
    expect(fs.existsSync(path.join(r.dir, "recording.mp4"))).toBe(false);
  });

  it("ffmpeg 失败：stderr 里夹着的 userData 绝对路径被剔除（scrubClip），文件名保留", async () => {
    const { bin, execFile } = withFfmpeg(false);
    const e = await mk({ env: { PATH: bin }, execFile });
    execFile.mockImplementation(((_b: string, _args: string[], _opts: any, cb: any) => {
      cb(Object.assign(new Error("Command failed"), { code: 1 }), "", `${e.userData}/data/tasks/${TASK}/browser-recordings/x/frame-0001.jpg: No such file or directory\n`);
    }) as any);
    const r = await recordOne(e);
    const err = await e.call({ action: "export", format: "mp4", recId: r.recId }).then(
      () => null,
      (x: any) => x,
    );
    expect(err).toMatchObject({ code: "INTERNAL" });
    expect(err.message).toContain("ffmpeg 导出失败");
    expect(err.message).toContain("frame-0001.jpg");
    expect(err.message).not.toContain(e.userData);
    expect(err.message).not.toContain(path.basename(e.userData));
    expect(err.message).not.toContain("/data/tasks");
  });

  it("mp4 输出临时名已被占用（哪怕是指向别处的符号链接）：拒绝覆盖，ffmpeg 没被调用，链接目标不被改", async () => {
    const { bin, execFile } = withFfmpeg();
    const e = await mk({ env: { PATH: bin }, execFile });
    const r = await recordOne(e);
    const victim = path.join(e.userData, "victim.bin");
    fs.writeFileSync(victim, "precious", { mode: 0o644 });
    fs.symlinkSync(victim, path.join(r.dir, ".rec-deadbeef.tmp.mp4"));
    const realRandom = nodeCrypto.randomBytes;
    const spy = vi.spyOn(nodeCrypto, "randomBytes").mockImplementation(((n: number) => (n === 4 ? Buffer.from("deadbeef", "hex") : (realRandom as any)(n))) as any);
    cleanups.push(() => spy.mockRestore());
    const err = await e.call({ action: "export", format: "mp4", recId: r.recId }).then(
      () => null,
      (x: any) => x,
    );
    expect(err).toMatchObject({ code: "INTERNAL", message: expect.stringContaining("已被占用") });
    expect(execFile).not.toHaveBeenCalled();
    expect(fs.readFileSync(victim, "utf8")).toBe("precious");
    expect(fs.existsSync(path.join(r.dir, "recording.mp4"))).toBe(false);
  });

  it("已被清理 / 不存在的 recId：BAD_ARGS，且不会顺手创建空的 browser-recordings/<recId>", async () => {
    const e = await mk();
    await recordOne(e);
    const ghost = "rec-20200101-000000-ffffff";
    await expect(e.call({ action: "export", recId: ghost })).rejects.toMatchObject({ code: "BAD_ARGS" });
    expect(fs.existsSync(path.join(e.root, ghost))).toBe(false);
  });

  it("没有任何录制时（browser-recordings 都没建）：BAD_ARGS，不创建目录", async () => {
    const e = await mk();
    await expect(e.call({ action: "export", recId: "rec-20200101-000000-ffffff" })).rejects.toMatchObject({ code: "BAD_ARGS" });
    expect(fs.existsSync(e.root)).toBe(false);
  });

  it("export_activity：browser-exports 是符号链接 → 拒绝，目标里没有文件；文案说的是 browser-exports（不再是 browser-recordings），且不含绝对路径", async () => {
    const e = await mk();
    const victim = path.join(e.userData, "victim-exports");
    fs.mkdirSync(victim);
    fs.mkdirSync(e.taskDir, { recursive: true });
    fs.symlinkSync(victim, e.exportsRoot);
    const err = await e.call({ action: "export_activity" }).then(
      () => null,
      (x: any) => x,
    );
    expect(err).toMatchObject({ code: "INTERNAL" });
    expect(String(err.message)).toContain("导出活动日志失败");
    expect(String(err.message)).toContain("browser-exports 不是普通目录");
    expect(String(err.message)).not.toContain("browser-recordings");
    expect(String(err.message)).not.toContain(e.userData);
    expect(fs.readdirSync(victim)).toEqual([]);
  });

  it("export_activity：任务目录是符号链接 → 拒绝，目标里没有 browser-exports 也没有文件", async () => {
    const e = await mk();
    const moved = path.join(e.userData, "moved-task");
    fs.mkdirSync(moved, { recursive: true });
    fs.mkdirSync(path.dirname(e.taskDir), { recursive: true });
    fs.symlinkSync(moved, e.taskDir);
    await expect(e.call({ action: "export_activity" })).rejects.toMatchObject({ code: "INTERNAL", message: expect.stringContaining("任务目录 不是普通目录") });
    expect(fs.readdirSync(moved)).toEqual([]);
  });

  it("start：browser-recordings 是符号链接 → 拒绝创建录制（原有行为不退化），目标里没有 rec- 目录", async () => {
    const e = await mk();
    const victim = path.join(e.userData, "victim-rec");
    fs.mkdirSync(victim);
    fs.mkdirSync(e.taskDir, { recursive: true });
    fs.symlinkSync(victim, e.root);
    await expect(e.call({ action: "start" })).rejects.toMatchObject({ code: "INTERNAL", message: expect.stringContaining("不是普通目录") });
    expect(fs.readdirSync(victim)).toEqual([]);
  });
});
