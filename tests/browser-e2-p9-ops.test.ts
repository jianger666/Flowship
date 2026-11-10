/* eslint-disable @typescript-eslint/no-explicit-any -- 假 tab / 假 session 是刻意的，被测 .mjs 无类型声明 */
/**
 * E2·P9 / B7：ops/record.mjs 主进程 op——参数规整、录制状态机（假 CDP：start → frame* → stop）、每帧 ack、到限自动停、
 * 敏感字段 / Flowship origin 暂停写帧（redacted-gap）、接管标记、同会话互斥、tab 关闭 / 会话销毁收尾、文件权限（临时目录 0600/0700）、
 * 保留策略（只动 recId 目录）、export frames / mp4（假 execFile + PATH 探测）、export_activity 脱敏、record.stop ext 与状态贡献者。
 * 真实 BrowserSession + 假 tab；真 Electron 行为见 scripts/browser-e2e/e2-p9-record.cjs。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createActivityLog } from "../electron-app/browser/activity-log.mjs";
import { OP_HELPERS } from "../electron-app/browser/index.mjs";
import { OP_MODULES } from "../electron-app/browser/ops/index.mjs";
import { createHandlers, findFfmpeg, normalize, pruneRecordings } from "../electron-app/browser/ops/record.mjs";
import { exportsRootFor, makeRecId, recordingsRootFor } from "../electron-app/browser/record-policy.mjs";
import { BrowserSession } from "../electron-app/browser/session.mjs";

const isWin = process.platform === "win32";
// 最小合法 JPEG 头（FF D8 FF + 填充）
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
  /** 页内探针的结论：主会话 / 各子会话 */
  verdict: "safe" | "secret" | "bad" | "throw" = "safe";
  childVerdict: Record<string, "safe" | "secret" | "throw"> = {};
  children: string[] = [];
  probeCount = 0;
  startFails = false;
  constructor(
    public id: string,
    public url: string,
  ) {}
  send = vi.fn(async (method: string, params: any = {}, sid: any = null) => {
    this.calls.push({ method, params, sid });
    if (this.destroyed) throw Object.assign(new Error("标签页已关闭"), { code: "TAB_NOT_FOUND" });
    if (method === "Page.startScreencast" && this.startFails) throw new Error("screencast 不可用");
    if (method === "Runtime.evaluate") {
      this.probeCount += 1;
      const v = sid ? (this.childVerdict[sid] ?? "safe") : this.verdict;
      if (v === "throw") throw new Error("Execution context was destroyed");
      if (v === "bad") return { result: { value: "garbage" } };
      return { result: { value: { state: v, opaque: 0 } } };
    }
    return {};
  });
  cdpSessionIds() {
    return [null, ...this.children];
  }
  /** 推一帧并等该帧处理完（以 ack 出现为准） */
  async frame(data: Buffer | string, sessionId = 1) {
    const before = this.acks().length;
    for (const l of [...this.listeners]) l("Page.screencastFrame", { data: typeof data === "string" ? data : b64(data), sessionId, metadata: {} }, null);
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
  methods = () => this.calls.map((c) => c.method);
}

interface Env {
  userData: string;
  session: any;
  tab: FakeRecTab;
  call: (args: Record<string, unknown>) => Promise<any>;
  root: string;
  recDirs: () => string[];
  contributors: Array<(s: any) => any>;
  ext: Map<string, (s: any, ...a: any[]) => any>;
  execFile: ReturnType<typeof vi.fn>;
  cleanup: () => void;
  activity: () => string[];
  clock: { now: number };
}
const envs: Env[] = [];

const mk = async (opts: { limits?: Record<string, unknown>; env?: Record<string, string>; execFile?: any } = {}): Promise<Env> => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "p9-rec-"));
  const clock = { now: 1_700_000_000_000 };
  // 活动日志与录制共用同一个假时钟：标记的时间对齐靠它
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
  const taskId = "task1";
  const session = new BrowserSession({ taskId, host, activityLog, graceMs: 8_000, now: () => clock.now });
  await session.openTab({});
  const isAppUrl = (u: string) => String(u).includes("flowship.app.test");
  const contributors: Array<(s: any) => any> = [];
  const ext = new Map<string, any>();
  const execFile = opts.execFile ?? vi.fn();
  const handlers = createHandlers({
    requireSession: () => session,
    getConfig: () => ({}),
    scheduleState: vi.fn(),
    app: { getPath: () => userData },
    electron: { isAppUrl },
    addStateContributor: (fn: any) => contributors.push(fn),
    registerExt: (name: string, fn: any) => ext.set(name, fn),
    log: () => {},
    now: () => clock.now,
    recordLimits: opts.limits ?? {},
    env: opts.env,
    execFile,
  } as any);
  const root = recordingsRootFor(userData, taskId)!;
  const env: Env = {
    userData,
    session,
    tab,
    call: async (args) => (handlers as any).record(taskId, normalize("record", args, OP_HELPERS as any)),
    root,
    recDirs: () => (fs.existsSync(root) ? fs.readdirSync(root).filter((n) => n.startsWith("rec-")) : []),
    contributors,
    ext,
    execFile,
    cleanup: () => fs.rmSync(userData, { recursive: true, force: true }),
    activity: () => (session.getState().recent as Array<{ actor: string; summary?: string }>).filter((e) => e.actor === "ai").map((e) => e.summary ?? ""),
    clock,
  };
  envs.push(env);
  return env;
};

afterEach(() => {
  vi.useRealTimers();
  for (const e of envs.splice(0)) {
    try {
      e.session.destroy();
    } catch {
      /* 已销毁 */
    }
    e.cleanup();
  }
});

const rej = (p: Promise<unknown>, code: string) => expect(p).rejects.toMatchObject({ code });
const mode = (p: string) => fs.statSync(p).mode & 0o777;

describe("P9·注册与参数规整", () => {
  it("record op 由 record 模块独占", () => {
    expect(OP_MODULES.filter((m: any) => m.OPS.includes("record"))).toHaveLength(1);
  });

  it("action 必填且只认枚举；start 参数夹取；脏值 BAD_ARGS", () => {
    const n = (a: any) => normalize("record", a, OP_HELPERS as any) as any;
    expect(() => n({})).toThrow(/action/);
    expect(() => n({ action: "rm -rf" })).toThrow(/action/);
    expect(n({ action: "start" })).toMatchObject({ action: "start", maxFrames: 600, quality: 60, everyNth: 6 });
    expect(n({ action: "start", maxFrames: 99999, quality: 1, everyNth: 999 })).toMatchObject({ maxFrames: 600, quality: 20, everyNth: 60 });
    expect(() => n({ action: "start", maxFrames: "many" })).toThrow(/maxFrames/);
    expect(n({ action: "export" }).format).toBe("frames");
    expect(() => n({ action: "export", format: "avi" })).toThrow(/format/);
    expect(n({ action: "export_activity" }).format).toBe("json");
    expect(() => n({ action: "export_activity", format: "html" })).toThrow(/format/);
  });

  it("export 的 recId：路径穿越 / 绝对路径 / 控制字符一律 BAD_ARGS", () => {
    const n = (a: any) => normalize("record", a, OP_HELPERS as any) as any;
    expect(n({ action: "export", recId: "rec-20261109-100507-ab12cd" }).recId).toBe("rec-20261109-100507-ab12cd");
    for (const bad of ["../../etc/passwd", "/etc/passwd", "rec-20261109-100507-ab12cd/../..", "rec-20261109-100507-ab12cd\n", "x".repeat(65)]) {
      expect(() => n({ action: "export", recId: bad })).toThrow();
    }
  });
});

describe("P9·录制状态机", () => {
  it("start → 帧 → stop：每帧 ack、帧写盘（0600）、目录 0700、timeline.json 0600、结果带摘要与路径", async () => {
    const e = await mk();
    const s = await e.call({ action: "start" });
    expect(s).toMatchObject({ action: "start", maxFrames: 600, maxSeconds: 60, maxMB: 150 });
    expect(e.tab.methods()).toContain("Page.startScreencast");
    const start = e.tab.calls.find((c) => c.method === "Page.startScreencast")!.params;
    expect(start).toMatchObject({ format: "jpeg", quality: 60, everyNthFrame: 6 });
    for (let i = 0; i < 3; i += 1) {
      e.clock.now += 100;
      await e.tab.frame(jpeg(i), 100 + i);
    }
    // 每帧都 ack，且 ack 的是该帧的 sessionId
    expect(e.tab.acks().map((c) => c.params.sessionId)).toEqual([100, 101, 102]);
    const r = await e.call({ action: "stop" });
    expect(r).toMatchObject({ action: "stop", frames: 3, stopReason: "stopped", auto: false });
    expect(r.durationMs).toBeGreaterThanOrEqual(300);
    expect(r.totalBytes).toBe(3 * jpeg().length);
    expect(e.tab.methods()).toContain("Page.stopScreencast");
    const dir = r.dir as string;
    expect(path.dirname(dir)).toBe(e.root);
    const files = fs.readdirSync(dir).sort();
    expect(files).toEqual(["frame-0001.jpg", "frame-0002.jpg", "frame-0003.jpg", "timeline.json"]);
    if (!isWin) {
      expect(mode(dir)).toBe(0o700);
      expect(mode(e.root)).toBe(0o700);
      for (const f of files) expect(mode(path.join(dir, f))).toBe(0o600);
    }
    const tl = JSON.parse(fs.readFileSync(path.join(dir, "timeline.json"), "utf8"));
    expect(tl.frames.map((f: any) => f.file)).toEqual(["frame-0001.jpg", "frame-0002.jpg", "frame-0003.jpg"]);
    expect(tl.frames[1].t).toBeGreaterThan(tl.frames[0].t);
    // 帧文件内容就是 jpeg 原样
    expect(fs.readFileSync(path.join(dir, "frame-0002.jpg")).equals(jpeg(1))).toBe(true);
    expect(fs.readdirSync(dir).some((n) => n.endsWith(".tmp"))).toBe(false);
  });

  it("同会话同时只有一个录制：第二次 start BAD_ARGS；stop 后可再开", async () => {
    const e = await mk();
    await e.call({ action: "start" });
    await rej(e.call({ action: "start" }), "BAD_ARGS");
    await e.call({ action: "stop" });
    await e.call({ action: "start" });
    await e.call({ action: "stop" });
    expect(e.recDirs()).toHaveLength(2);
  });

  it("没有进行中的录制时 stop → BAD_ARGS；status 反映状态", async () => {
    const e = await mk();
    await rej(e.call({ action: "stop" }), "BAD_ARGS");
    expect((await e.call({ action: "status" })).recording).toBeNull();
    await e.call({ action: "start" });
    await e.tab.frame(jpeg());
    const st = await e.call({ action: "status" });
    expect(st.recording).toMatchObject({ frames: 1 });
    await e.call({ action: "stop" });
    expect((await e.call({ action: "status" })).recording).toBeNull();
  });

  it("到帧数上限自动停（并说明原因）；之后的帧不再写；下一次 stop 取回自动结束的结果", async () => {
    const e = await mk({ limits: { maxFrames: 3 } });
    await e.call({ action: "start" });
    for (let i = 0; i < 3; i += 1) await e.tab.frame(jpeg(i));
    await vi.waitFor(() => expect(e.tab.methods()).toContain("Page.stopScreencast"));
    // 已停：监听已摘（真实 Chromium 也不会再发帧）；就算有迟到的帧事件也不会再写盘
    expect(e.tab.listeners.size).toBe(0);
    const r = await e.call({ action: "stop" });
    expect(r).toMatchObject({ frames: 3, stopReason: "max_frames", auto: true });
    expect(r.stopReasonText).toContain("帧数上限");
    expect(fs.readdirSync(r.dir).filter((n: string) => n.endsWith(".jpg"))).toHaveLength(3);
    // 结果只能取一次
    await rej(e.call({ action: "stop" }), "BAD_ARGS");
    expect(e.activity().some((s) => s.includes("录制已结束"))).toBe(true);
  });

  it("start 的 max_frames 收紧上限", async () => {
    const e = await mk();
    await e.call({ action: "start", maxFrames: 2 });
    await e.tab.frame(jpeg(1));
    await e.tab.frame(jpeg(2));
    const r = await e.call({ action: "stop" });
    expect(r).toMatchObject({ frames: 2, stopReason: "max_frames" });
  });

  it("到体积上限自动停：超限的那一帧不写", async () => {
    const e = await mk({ limits: { maxBytes: jpeg().length * 2 + 1 } });
    await e.call({ action: "start" });
    await e.tab.frame(jpeg(1));
    await e.tab.frame(jpeg(2));
    await e.tab.frame(jpeg(3));
    const r = await e.call({ action: "stop" });
    expect(r).toMatchObject({ frames: 2, stopReason: "max_bytes" });
    expect(r.totalBytes).toBeLessThanOrEqual(jpeg().length * 2 + 1);
  });

  it("到时长上限自动停（静止页面没有帧事件也会停：定时器）", async () => {
    vi.useFakeTimers();
    const e = await mk({ limits: { maxMs: 5000 } });
    await e.call({ action: "start" });
    expect(e.tab.methods()).not.toContain("Page.stopScreencast");
    await vi.advanceTimersByTimeAsync(5001);
    expect(e.tab.methods()).toContain("Page.stopScreencast");
    const r = await e.call({ action: "stop" });
    expect(r).toMatchObject({ stopReason: "max_duration", auto: true, frames: 0 });
  });

  it("不是 JPEG（魔数不对）/ 空 / 过大的帧不落盘，但仍 ack", async () => {
    const e = await mk({ limits: { maxFrameBytes: 100 } });
    await e.call({ action: "start" });
    await e.tab.frame(Buffer.from("<html>not a jpeg</html>"));
    await e.tab.frame("");
    await e.tab.frame(Buffer.concat([jpeg(), Buffer.alloc(200)]));
    await e.tab.frame(jpeg(5));
    expect(e.tab.acks()).toHaveLength(4);
    const r = await e.call({ action: "stop" });
    expect(r.frames).toBe(1);
  });

  it("start 失败（screencast 不可用）→ INTERNAL，不留目录 / 状态，之后能重新 start", async () => {
    const e = await mk();
    e.tab.startFails = true;
    await rej(e.call({ action: "start" }), "INTERNAL");
    expect(e.recDirs()).toHaveLength(0);
    expect(e.tab.listeners.size).toBe(0);
    e.tab.startFails = false;
    await e.call({ action: "start" });
    await e.call({ action: "stop" });
  });

  it("Flowship 自身 origin 的页面：start 被拒（DENIED）", async () => {
    const e = await mk();
    e.tab.url = "http://flowship.app.test/tasks/1";
    await rej(e.call({ action: "start" }), "DENIED");
    expect(e.recDirs()).toHaveLength(0);
  });

  it("录制中 tab 导航到 Flowship origin：这些帧不写盘（gap=app-origin）", async () => {
    const e = await mk();
    await e.call({ action: "start" });
    e.clock.now += 10;
    await e.tab.frame(jpeg(1));
    e.tab.url = "http://flowship.app.test/x";
    e.clock.now += 10;
    await e.tab.frame(jpeg(2));
    e.tab.url = "http://127.0.0.1:1/page";
    for (const tag of [3, 4, 5]) {
      e.clock.now += 10;
      await e.tab.frame(jpeg(tag)); // 前两帧是冷却帧，第 5 帧才恢复写盘
    }
    const r = await e.call({ action: "stop" });
    expect(r.frames).toBe(2);
    expect(r.redactedGaps).toBe(1);
    const tl = JSON.parse(fs.readFileSync(r.timelineFile, "utf8"));
    expect(tl.markers.find((m: any) => m.type === "redacted-gap").text).toContain("app-origin");
  });
});

describe("P9·敏感字段：暂停写帧 + redacted-gap", () => {
  it("探针说有可见敏感输入框 → 该帧不写、仍 ack；恢复后继续写；timeline 有 redacted-gap 段", async () => {
    const e = await mk();
    await e.call({ action: "start" });
    e.clock.now += 10;
    await e.tab.frame(jpeg(1));
    e.tab.verdict = "secret";
    for (let i = 0; i < 3; i += 1) {
      e.clock.now += 10;
      await e.tab.frame(jpeg(10 + i));
    }
    e.tab.verdict = "safe";
    // 框消失后头 2 帧是「冷却」帧（可能抓取于框消失之前）也不写；第 3 帧才恢复
    for (const tag of [2, 3, 4]) {
      e.clock.now += 10;
      await e.tab.frame(jpeg(tag));
    }
    const r = await e.call({ action: "stop" });
    expect(r.frames).toBe(2);
    expect(r).toMatchObject({ redactedGaps: 1, redactedFrames: 5 });
    // 没写盘：目录里只有两帧（第 1 帧与冷却之后的第 4 帧），且内容不是被暂停 / 冷却的那几帧
    const jpgs = fs.readdirSync(r.dir).filter((n: string) => n.endsWith(".jpg"));
    expect(jpgs).toHaveLength(2);
    expect(fs.readFileSync(path.join(r.dir, "frame-0002.jpg")).equals(jpeg(4))).toBe(true);
    for (const f of jpgs) expect(fs.readFileSync(path.join(r.dir, f)).includes(Buffer.from([10]))).toBe(false);
    const tl = JSON.parse(fs.readFileSync(r.timelineFile, "utf8"));
    const gap = tl.markers.find((m: any) => m.type === "redacted-gap");
    expect(gap).toBeTruthy();
    expect(gap.endT).toBeGreaterThanOrEqual(gap.t);
    expect(gap.text).toContain("secret-field");
    expect(e.tab.acks()).toHaveLength(7);
  });

  it("排队的帧：在上一次敏感探针结束之前就到达的帧，即使探针现在说 safe（框刚消失）也不写——抓取更早，那时框还在", async () => {
    const e = await mk();
    await e.call({ action: "start" });
    // 让第一帧的探针卡住，期间第二帧到达（排队）
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const orig = e.tab.send.getMockImplementation()!;
    let first = true;
    e.tab.send.mockImplementation(async (method: string, params: any, sid: any) => {
      if (method === "Runtime.evaluate" && first) {
        first = false;
        await gate;
        e.tab.probeCount += 1;
        return { result: { value: { state: "secret", opaque: 0 } } };
      }
      return orig(method, params, sid);
    });
    for (const l of [...e.tab.listeners]) l("Page.screencastFrame", { data: b64(jpeg(1)), sessionId: 1 }, null);
    for (const l of [...e.tab.listeners]) l("Page.screencastFrame", { data: b64(jpeg(2)), sessionId: 2 }, null);
    e.tab.verdict = "safe"; // 第二帧的探针会说 safe
    release();
    await vi.waitFor(() => expect(e.tab.acks()).toHaveLength(2));
    // 时间推进后的新帧：先过 2 帧冷却，第 3 帧才写
    for (const tag of [3, 4, 5]) {
      e.clock.now += 10;
      await e.tab.frame(jpeg(tag));
    }
    const r = await e.call({ action: "stop" });
    expect(r.frames).toBe(1);
    expect(r.redactedFrames).toBe(4);
    expect(fs.readFileSync(path.join(r.dir, "frame-0001.jpg")).equals(jpeg(5))).toBe(true);
  });

  it("探针失败 / 超时 / 形状不对 → fail-closed（不写帧，原因 probe-unknown）", async () => {
    const e = await mk();
    await e.call({ action: "start" });
    for (const v of ["throw", "bad"] as const) {
      e.tab.verdict = v;
      await e.tab.frame(jpeg(7));
    }
    const r = await e.call({ action: "stop" });
    expect(r.frames).toBe(0);
    const tl = JSON.parse(fs.readFileSync(r.timelineFile, "utf8"));
    expect(tl.markers.find((m: any) => m.type === "redacted-gap").text).toContain("probe-unknown");
  });

  it("OOPIF 子会话里有敏感输入框也暂停；子会话探针失败不拖累", async () => {
    const e = await mk();
    e.tab.children = ["child-A", "child-B"];
    await e.call({ action: "start" });
    e.tab.childVerdict = { "child-A": "throw", "child-B": "safe" };
    await e.tab.frame(jpeg(1));
    e.tab.childVerdict = { "child-A": "safe", "child-B": "secret" };
    await e.tab.frame(jpeg(2));
    const r = await e.call({ action: "stop" });
    expect(r.frames).toBe(1);
    expect(r.redactedGaps).toBe(1);
    expect(e.tab.calls.filter((c) => c.method === "Runtime.evaluate" && c.sid === "child-B").length).toBeGreaterThan(0);
  });

  it("探针只读：用 Runtime.evaluate returnByValue、没有任何 DOM 写入类 CDP 调用", async () => {
    const e = await mk();
    await e.call({ action: "start" });
    await e.tab.frame(jpeg());
    await e.call({ action: "stop" });
    const methods = new Set(e.tab.methods());
    for (const forbidden of ["DOM.setAttributeValue", "DOM.setOuterHTML", "Input.insertText", "Input.dispatchKeyEvent", "Runtime.callFunctionOn", "Page.addScriptToEvaluateOnNewDocument"]) expect(methods.has(forbidden)).toBe(false);
    const ev = e.tab.calls.find((c) => c.method === "Runtime.evaluate")!;
    expect(ev.params).toMatchObject({ returnByValue: true, silent: true, includeCommandLineAPI: false });
  });
});

describe("P9·时间线标记 / 接管 / 收尾", () => {
  it("录制期间的导航 / AI 动作 / 用户动作成为 markers（时间对齐、文字脱敏），录制前的不算", async () => {
    const e = await mk();
    e.session.activityLog.addAI({ kind: "click", tabId: "t1", url: "http://a.test/old", summary: "录制前的点击" });
    e.clock.now += 5;
    await e.call({ action: "start" });
    e.clock.now += 100;
    await e.tab.frame(jpeg(1));
    e.session.activityLog.addSystem({ kind: "navigate", tabId: "t1", url: "http://a.test/page?token=abc", summary: "打开了页面" });
    e.session.activityLog.addAI({ kind: "click", tabId: "t1", url: "http://a.test/page", summary: "点击了按钮「提交」" });
    e.session.activityLog.ingest({ type: "click", tabId: "t1", url: "http://a.test/page", target: { role: "button", name: "确认" }, ts: e.clock.now });
    e.clock.now += 100;
    await e.tab.frame(jpeg(2));
    const r = await e.call({ action: "stop" });
    const tl = JSON.parse(fs.readFileSync(r.timelineFile, "utf8"));
    const types = tl.markers.map((m: any) => m.type);
    expect(types).toContain("navigation");
    expect(types).toContain("ai-action");
    expect(types).toContain("user-action");
    expect(tl.markers.some((m: any) => String(m.text).includes("录制前的点击"))).toBe(false);
    const nav = tl.markers.find((m: any) => m.type === "navigation");
    expect(nav.url).not.toContain("token=abc");
    expect(r.markerCount).toBe(tl.markers.length);
    expect(r.markerCounts["ai-action"]).toBeGreaterThanOrEqual(1);
    expect(r.markers.length).toBeLessThanOrEqual(40);
  });

  it("用户接管期间继续录，timeline 标 user-control 段（有起止）", async () => {
    const e = await mk();
    await e.call({ action: "start" });
    await e.tab.frame(jpeg(1));
    e.clock.now += 200;
    e.session.controller = "user";
    e.clock.now += 300;
    await e.tab.frame(jpeg(2)); // 接管期间的帧仍然写
    e.session.controller = "idle";
    e.clock.now += 50;
    const r = await e.call({ action: "stop" });
    expect(r.frames).toBe(2);
    expect(r.userControlSegments).toBe(1);
    const tl = JSON.parse(fs.readFileSync(r.timelineFile, "utf8"));
    const seg = tl.markers.find((m: any) => m.type === "user-control");
    expect(seg.endT - seg.t).toBe(300);
  });

  it("接管中直接 stop：user-control 段在收尾时闭合；AI 的 start 在接管期间 USER_CONTROL", async () => {
    const e = await mk();
    await e.call({ action: "start" });
    e.session.controller = "user";
    e.clock.now += 100;
    const r = await e.call({ action: "stop" });
    expect(r.userControlSegments).toBe(1);
    await rej(e.call({ action: "start" }), "USER_CONTROL");
  });

  it("tab 关闭：停止录制并写完 timeline（原因 tab_closed），结果留给下一次 stop", async () => {
    const e = await mk();
    await e.call({ action: "start" });
    await e.tab.frame(jpeg(1));
    e.tab.destroy();
    expect(e.tab.listeners.size).toBe(0);
    const r = await e.call({ action: "stop" });
    expect(r).toMatchObject({ frames: 1, stopReason: "tab_closed", auto: true });
    expect(fs.existsSync(r.timelineFile)).toBe(true);
  });

  it("会话销毁：收尾写 timeline、摘监听、不留 tmp；在途帧处理不会在收尾后再写文件", async () => {
    const e = await mk();
    await e.call({ action: "start" });
    await e.tab.frame(jpeg(1));
    const dir = e.recDirs()[0];
    // 推一帧但不等它处理完就销毁会话
    for (const l of [...e.tab.listeners]) l("Page.screencastFrame", { data: b64(jpeg(2)), sessionId: 9 }, null);
    e.session.destroy();
    await new Promise((r) => setTimeout(r, 30));
    const files = fs.readdirSync(path.join(e.root, dir)).sort();
    expect(files).toContain("timeline.json");
    expect(files.filter((n) => n.endsWith(".jpg"))).toHaveLength(1);
    expect(files.some((n) => n.endsWith(".tmp"))).toBe(false);
    expect(e.tab.listeners.size).toBe(0);
    const tl = JSON.parse(fs.readFileSync(path.join(e.root, dir, "timeline.json"), "utf8"));
    expect(tl.stopReason).toBe("session_closed");
  });
});

describe("P9·面板：状态贡献者与 record.stop", () => {
  it("录制中贡献 recording:{frames,startedAt}；结束后不再贡献", async () => {
    const e = await mk();
    const contrib = () => e.contributors.map((c) => c(e.session)).reduce((a, b) => ({ ...a, ...b }), {});
    expect(contrib()).toEqual({});
    await e.call({ action: "start" });
    await e.tab.frame(jpeg(1));
    expect(contrib().recording).toMatchObject({ frames: 1 });
    expect(Number.isFinite(contrib().recording.startedAt)).toBe(true);
    await e.call({ action: "stop" });
    expect(contrib()).toEqual({});
  });

  it("record.stop（用户在面板点停止，接管期间也可用）：停止并留下系统活动记录；AI 下一次 stop 取回结果；没有录制 → stopped:false", async () => {
    const e = await mk();
    const stop = e.ext.get("record.stop")!;
    expect(await stop(e.session)).toEqual({ stopped: false });
    await e.call({ action: "start" });
    await e.tab.frame(jpeg(1));
    e.session.controller = "user";
    expect(await stop(e.session)).toEqual({ stopped: true, frames: 1 });
    expect(e.session.activityLog.list({ actors: ["system"] }).some((x: any) => /用户停止了录制/.test(x.summary))).toBe(true);
    const r = await e.call({ action: "stop" });
    expect(r).toMatchObject({ frames: 1, stopReason: "user", auto: true });
  });
});

describe("P9·保留策略与目录安全", () => {
  const seed = (root: string, name: string, bytes: number, ageSec: number) => {
    const d = path.join(root, name);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "frame-0001.jpg"), Buffer.alloc(bytes));
    const t = new Date(Date.now() - ageSec * 1000);
    fs.utimesSync(d, t, t);
  };

  it("start 前清最旧的：旧的最多留 4 个（含新录制共 5 个）；非 recId 的目录 / 文件不动", async () => {
    const e = await mk();
    fs.mkdirSync(e.root, { recursive: true });
    for (let i = 0; i < 6; i += 1) seed(e.root, makeRecId(new Date(2026, 0, 1, 0, 0, i), `00000${i}`), 10, 1000 - i * 10);
    fs.mkdirSync(path.join(e.root, "my-notes"));
    fs.writeFileSync(path.join(e.root, "my-notes", "keep.txt"), "x");
    fs.writeFileSync(path.join(e.root, "stray.txt"), "x");
    await e.call({ action: "start" });
    await e.call({ action: "stop" });
    const recs = e.recDirs();
    expect(recs).toHaveLength(5);
    // 删的是最旧的两个（i=0,1 的 mtime 最老）
    expect(recs).not.toContain(makeRecId(new Date(2026, 0, 1, 0, 0, 0), "000000"));
    expect(recs).not.toContain(makeRecId(new Date(2026, 0, 1, 0, 0, 1), "000001"));
    expect(fs.existsSync(path.join(e.root, "my-notes", "keep.txt"))).toBe(true);
    expect(fs.existsSync(path.join(e.root, "stray.txt"))).toBe(true);
  });

  it("体积上限：按总大小清理最旧的", async () => {
    const e = await mk({ limits: { maxTotalBytes: 3000, maxBytes: 1000 } });
    fs.mkdirSync(e.root, { recursive: true });
    for (let i = 0; i < 3; i += 1) seed(e.root, makeRecId(new Date(2026, 0, 1, 0, 0, i), `00000${i}`), 1000, 100 - i);
    await e.call({ action: "start" });
    await e.call({ action: "stop" });
    // 旧的只给新录制留出 maxBytes 余量：3000-1000=2000 → 旧的最多 2 个
    expect(e.recDirs().length).toBeLessThanOrEqual(3);
    expect(e.recDirs()).not.toContain(makeRecId(new Date(2026, 0, 1, 0, 0, 0), "000000"));
  });

  it.skipIf(isWin)("pruneRecordings 不跟随符号链接：符号链接名即使形如 recId 也不删目标", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "p9-link-"));
    try {
      const root = path.join(base, "browser-recordings");
      fs.mkdirSync(root);
      const victim = path.join(base, "victim");
      fs.mkdirSync(victim);
      fs.writeFileSync(path.join(victim, "precious.txt"), "x");
      const name = makeRecId(new Date(2026, 0, 1), "abcdef");
      fs.symlinkSync(victim, path.join(root, name));
      const removed = pruneRecordings({ root, keep: 0, maxTotalBytes: 0 });
      expect(removed).toEqual([]);
      expect(fs.existsSync(path.join(victim, "precious.txt"))).toBe(true);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("P9·export", () => {
  const recordOne = async (e: Env, n = 3) => {
    await e.call({ action: "start" });
    for (let i = 0; i < n; i += 1) {
      e.clock.now += 100;
      await e.tab.frame(jpeg(i));
    }
    return e.call({ action: "stop" });
  };

  it("frames：默认最近一个录制，返回目录 + timeline.json 与摘要", async () => {
    const e = await mk();
    const r = await recordOne(e);
    const x = await e.call({ action: "export", format: "frames" });
    expect(x).toMatchObject({ action: "export", format: "frames", dir: r.dir, frames: 3 });
    expect(fs.existsSync(x.timelineFile)).toBe(true);
    // 指定 rec_id 也行
    expect((await e.call({ action: "export", recId: r.recId })).dir).toBe(r.dir);
  });

  it("export 进行中的录制 → BAD_ARGS；没有任何录制 → BAD_ARGS；不存在 / 已被清理的 rec_id → BAD_ARGS", async () => {
    const e = await mk();
    await rej(e.call({ action: "export" }), "BAD_ARGS");
    await e.call({ action: "start" });
    await rej(e.call({ action: "export", recId: e.recDirs()[0] }), "BAD_ARGS");
    await e.call({ action: "stop" });
    await rej(e.call({ action: "export", recId: "rec-20200101-000000-ffffff" }), "BAD_ARGS");
  });

  it("gif 暂不支持 → UNSUPPORTED，提示用 frames / mp4", async () => {
    const e = await mk();
    await recordOne(e);
    await expect(e.call({ action: "export", format: "gif" })).rejects.toMatchObject({ code: "UNSUPPORTED", message: expect.stringContaining("frames") });
  });

  it("mp4：PATH 上没有 ffmpeg → UNSUPPORTED 并降级提示 frames（不调用 execFile）", async () => {
    const e = await mk({ env: { PATH: "/nonexistent-dir-p9:/also/missing" } });
    await recordOne(e);
    await expect(e.call({ action: "export", format: "mp4" })).rejects.toMatchObject({ code: "UNSUPPORTED", message: expect.stringContaining("frames") });
    expect(e.execFile).not.toHaveBeenCalled();
  });

  it("mp4：空 PATH / 相对 PATH 项（`.`）不会把当前目录里的 ffmpeg 当成执行目标", async () => {
    const e = await mk({ env: { PATH: ".:" } });
    await recordOne(e);
    await rej(e.call({ action: "export", format: "mp4" }), "UNSUPPORTED");
  });

  it.skipIf(isWin)("mp4：找到 ffmpeg 时 execFile 收到固定参数数组（不经 shell）、cwd=录制目录、env 只有 PATH；产物 0600 并改名为 recording.mp4", async () => {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), "p9-bin-"));
    const fake = path.join(bin, "ffmpeg");
    fs.writeFileSync(fake, "#!/bin/sh\n", { mode: 0o755 });
    const execFile = vi.fn((_bin: string, args: string[], opts: any, cb: any) => {
      fs.writeFileSync(path.join(opts.cwd, args.at(-1)!), Buffer.alloc(2048, 1));
      cb(null, "", "");
    });
    const e = await mk({ env: { PATH: bin }, execFile });
    try {
      const r = await recordOne(e);
      const x = await e.call({ action: "export", format: "mp4" });
      expect(execFile).toHaveBeenCalledTimes(1);
      const [binPath, args, opts] = execFile.mock.calls[0] as any[];
      expect(binPath).toBe(fake);
      expect(Array.isArray(args)).toBe(true);
      expect(args).toContain("frame-%04d.jpg");
      expect(opts.cwd).toBe(r.dir);
      expect(opts.timeout).toBe(120_000);
      expect(opts.shell).toBeUndefined();
      expect(Object.keys(opts.env)).toEqual(["PATH"]);
      expect(x).toMatchObject({ format: "mp4", file: "recording.mp4", bytes: 2048 });
      expect(mode(x.path)).toBe(0o600);
      expect(fs.readdirSync(r.dir).some((n: string) => n.endsWith(".tmp.mp4"))).toBe(false);
    } finally {
      fs.rmSync(bin, { recursive: true, force: true });
    }
  });

  it.skipIf(isWin)("mp4：ffmpeg 失败 / 超时 → 清掉半截产物，错误里给出 frames 降级", async () => {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), "p9-bin-"));
    fs.writeFileSync(path.join(bin, "ffmpeg"), "#!/bin/sh\n", { mode: 0o755 });
    let mode_: "fail" | "timeout" = "fail";
    const execFile = vi.fn((_b: string, args: string[], opts: any, cb: any) => {
      fs.writeFileSync(path.join(opts.cwd, args.at(-1)!), Buffer.alloc(10));
      if (mode_ === "timeout") cb(Object.assign(new Error("timeout"), { killed: true, signal: "SIGKILL" }), "", "");
      else cb(Object.assign(new Error("exit 1"), { code: 1 }), "", "Invalid data found when processing input\nsk-abcdefghijklmnopqrstuvwxyz0123 leaked?");
      // （sk- 规则要求带数字；上面这串带 0123，会被脱敏）
    });
    const e = await mk({ env: { PATH: bin }, execFile });
    try {
      const r = await recordOne(e);
      const p1 = e.call({ action: "export", format: "mp4" });
      await expect(p1).rejects.toMatchObject({ code: "INTERNAL", message: expect.stringContaining("frames") });
      await p1.catch((err) => expect(String(err.message)).not.toContain("sk-abcdefghijklmnopqrstuvwxyz0123"));
      mode_ = "timeout";
      await rej(e.call({ action: "export", format: "mp4" }), "TIMEOUT");
      expect(fs.readdirSync(r.dir).some((n: string) => n.includes(".tmp.mp4") || n === "recording.mp4")).toBe(false);
    } finally {
      fs.rmSync(bin, { recursive: true, force: true });
    }
  });

  it("mp4：没有任何帧（全程敏感框）→ BAD_ARGS", async () => {
    const e = await mk({ env: { PATH: "/nonexistent" } });
    await e.call({ action: "start" });
    e.tab.verdict = "secret";
    await e.tab.frame(jpeg());
    await e.call({ action: "stop" });
    await rej(e.call({ action: "export", format: "mp4" }), "BAD_ARGS");
  });

  it("findFfmpeg：存在且可执行才算；目录 / 不可执行 / 不存在都跳过", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "p9-find-"));
    try {
      const dirOnly = path.join(base, "a");
      fs.mkdirSync(path.join(dirOnly, "ffmpeg"), { recursive: true }); // 同名目录
      const good = path.join(base, "b");
      fs.mkdirSync(good);
      fs.writeFileSync(path.join(good, "ffmpeg"), "x", { mode: 0o755 });
      const penv = (o: Record<string, string>) => o as unknown as NodeJS.ProcessEnv;
      expect(findFfmpeg({ env: penv({ PATH: `${dirOnly}:${good}` }), platform: "linux" })?.path).toBe(path.join(good, "ffmpeg"));
      expect(findFfmpeg({ env: penv({ PATH: dirOnly }), platform: "linux" })).toBeNull();
      expect(findFfmpeg({ env: penv({}), platform: "linux" })).toBeNull();
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("P9·export_activity", () => {
  it("写到 browser-exports（目录 0700、文件 0600），json 合法；内容脱敏（凭据 / URL 查询串 / 密码框输入内容）", async () => {
    const e = await mk();
    const log = e.session.activityLog;
    log.addAI({ kind: "click", tabId: "t1", url: "http://a.test/p?token=SECRETQ&x=1#frag", summary: "点击了按钮，Authorization: Bearer abcdefghijklmnopqrstuvwxyz1234 sk-abc123def456ghi789jkl" });
    log.ingest({ type: "input", tabId: "t1", url: "http://a.test/login", value: "hunter2-super-secret", valueLength: 20, target: { tag: "input", inputType: "password", name: "密码" }, ts: 1 });
    log.ingest({ type: "input", tabId: "t1", url: "http://a.test/login", valueLength: 5, target: { tag: "input", inputType: "text", name: "用户名" } });
    const r = await e.call({ action: "export_activity", format: "json" });
    // 会话创建时 openTab 也记了一条系统条目，所以不是恰好 3 条
    expect(r).toMatchObject({ action: "export_activity", format: "json", dir: "browser-exports" });
    expect(r.entries).toBeGreaterThanOrEqual(3);
    // R6-34：返回值不带绝对路径（只有文件名 + 子目录名）；测试自己用已知的 userData 拼出真实路径
    expect(r.path).toBeUndefined();
    expect(JSON.stringify(r)).not.toContain(e.userData);
    const filePath = path.join(exportsRootFor(e.userData, "task1")!, r.file);
    expect(r.file).toMatch(/^activity-\d{8}-\d{6}\.json$/);
    if (!isWin) {
      expect(mode(filePath)).toBe(0o600);
      expect(mode(path.dirname(filePath))).toBe(0o700);
    }
    const text = fs.readFileSync(filePath, "utf8");
    const j = JSON.parse(text);
    expect(j.entries).toHaveLength(r.entries);
    for (const bad of ["SECRETQ", "frag", "hunter2-super-secret", "abcdefghijklmnopqrstuvwxyz1234", "sk-abc123def456ghi789jkl"]) expect(text).not.toContain(bad);
    expect(j.entries.find((x: any) => x.actor === "ai")).toMatchObject({ kind: "click", tab: "t1" });
    expect(j.entries.some((x: any) => String(x.text).includes("内容已隐藏"))).toBe(true);
  });

  it("markdown：.md、0600、转义特殊字符；同一秒重复导出不覆盖（加序号）；只留最近 20 个", async () => {
    const e = await mk({ limits: { keepExports: 3 } });
    e.session.activityLog.addAI({ kind: "click", tabId: "t1", url: "", summary: "[点我](http://evil.test) # 标题" });
    const a = await e.call({ action: "export_activity", format: "markdown" });
    const b = await e.call({ action: "export_activity", format: "markdown" });
    expect(a.file).not.toBe(b.file);
    expect(path.extname(a.file)).toBe(".md");
    const dir = exportsRootFor(e.userData, "task1")!;
    const md = fs.readFileSync(path.join(dir, a.file), "utf8");
    expect(md).toContain("\\[点我\\]\\(http://evil.test\\)");
    for (let i = 0; i < 4; i += 1) await e.call({ action: "export_activity" });
    expect(fs.readdirSync(dir).filter((n) => n.startsWith("activity-"))).toHaveLength(3);
    expect(fs.readdirSync(dir).some((n) => n.endsWith(".tmp"))).toBe(false);
  });

  it("导出本身记一条 AI 活动日志；不依赖 tab / 不走 runAction", async () => {
    const e = await mk();
    await e.call({ action: "export_activity" });
    expect(e.activity().some((s) => s.includes("导出了活动日志"))).toBe(true);
  });
});
