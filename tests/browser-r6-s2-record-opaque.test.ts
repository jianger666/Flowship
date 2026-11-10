/* eslint-disable @typescript-eslint/no-explicit-any -- 假 tab / 假 DOM 与被测 .mjs 无类型声明，any 是刻意的 */
/**
 * R6-06：录制的「可见敏感框」探针对读不进的 iframe / 嵌套 > 8 层不能按 safe 放行。
 * - 策略层：vm 里真跑 SECRET_VISIBLE_PROBE_SOURCE（沙箱 iframe 在视口内 / 视口外 / display:none、嵌套 8 层 vs 9 层）+ readProbeVerdict；
 * - op 层：真 BrowserSession + 假 tab，opaque 触发丢帧（skippedOpaque、活动日志只提示一次、timeline 原因 opaque-frame）、非 opaque 正常录。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createActivityLog } from "../electron-app/browser/activity-log.mjs";
import { OP_HELPERS } from "../electron-app/browser/index.mjs";
import { createHandlers, normalize } from "../electron-app/browser/ops/record.mjs";
import { SECRET_VISIBLE_PROBE_SOURCE, probeHasVisibleOpaque, readProbeVerdict } from "../electron-app/browser/record-policy.mjs";
import { BrowserSession } from "../electron-app/browser/session.mjs";

// ───────────────────────── 策略层：vm 假 DOM ─────────────────────────

const el = (tag: string, o: Record<string, any> = {}) => ({
  tagName: tag.toUpperCase(),
  type: o.type ?? "",
  nodeType: 1,
  shadowRoot: o.shadowRoot ?? null,
  contentDocument: o.contentDocument,
  getAttribute: (k: string) => (k === "type" ? (o.type ?? null) : null),
  getBoundingClientRect: () => o.rect ?? { left: 10, top: 10, width: 100, height: 20 },
  ownerDocument: { defaultView: { getComputedStyle: () => ({ visibility: o.visibility ?? "visible", display: o.display ?? "block", webkitTextSecurity: "" }) } },
});
const docOf = (els: any[], active: any = null) => ({ documentElement: {}, activeElement: active, querySelectorAll: () => els });
const run = (doc: any) => {
  const ctx: any = { document: doc, window: { innerWidth: 800, innerHeight: 600, getComputedStyle: () => ({}) }, getComputedStyle: () => ({}) };
  return vm.runInNewContext(SECRET_VISIBLE_PROBE_SOURCE, ctx);
};
const asRes = (value: unknown) => ({ result: { value } });

describe("R6-06 探针：opaqueVisible 与 readProbeVerdict", () => {
  it("视口内读不进去的 iframe（跨域 / 沙箱 contentDocument=null）→ opaqueVisible=1，readProbeVerdict 判 unknown（修之前是 safe）", () => {
    const r = run(docOf([el("iframe", { contentDocument: null }), el("input", { type: "text" })]));
    expect(r).toMatchObject({ state: "safe", opaque: 1, opaqueVisible: 1 });
    expect(readProbeVerdict(asRes(r))).toBe("unknown");
    expect(probeHasVisibleOpaque(asRes(r))).toBe(true);
  });

  it("读不进去的 iframe 在视口外 / display:none / 零尺寸：opaque 计数但不算可见 → 仍 safe（不误伤）", () => {
    for (const o of [
      { rect: { left: 0, top: 5000, width: 300, height: 200 } },
      { rect: { left: 2000, top: 0, width: 300, height: 200 } },
      { display: "none" },
      { visibility: "hidden" },
      { rect: { left: 0, top: 0, width: 0, height: 0 } },
    ]) {
      const r = run(docOf([el("iframe", { contentDocument: null, ...o })]));
      expect(r, JSON.stringify(o)).toMatchObject({ state: "safe", opaque: 1, opaqueVisible: 0 });
      expect(readProbeVerdict(asRes(r)), JSON.stringify(o)).toBe("safe");
    }
  });

  it("可读的同源 iframe 照常穿透（里面普通框 → safe；里面 password → secret）", () => {
    const frame = (inner: any[]) => el("iframe", { contentDocument: docOf(inner), rect: { left: 0, top: 0, width: 300, height: 200 } });
    expect(readProbeVerdict(asRes(run(docOf([frame([el("input", { type: "text" })])]))))).toBe("safe");
    expect(readProbeVerdict(asRes(run(docOf([frame([el("input", { type: "password" })])]))))).toBe("secret");
  });

  it("嵌套深度：8 层可读 iframe → safe；9 层 → 深度耗尽按「可见 opaque」→ unknown", () => {
    const nest = (layers: number) => {
      let inner: any = docOf([el("input", { type: "text" })]);
      for (let i = 0; i < layers; i++) inner = docOf([el("iframe", { contentDocument: inner, rect: { left: 0, top: 0, width: 300, height: 200 } })]);
      return inner;
    };
    const ok = run(nest(8));
    expect(ok).toMatchObject({ state: "safe", opaqueVisible: 0 });
    expect(readProbeVerdict(asRes(ok))).toBe("safe");
    const deep = run(nest(9));
    expect(deep.state).toBe("safe");
    expect(deep.opaqueVisible).toBeGreaterThan(0);
    expect(readProbeVerdict(asRes(deep))).toBe("unknown");
  });

  it("已确认 secret 的仍是 secret（即使同时有 opaque）；形状不对 / 缺 opaqueVisible 字段的老结果不受影响", () => {
    const r = run(docOf([el("iframe", { contentDocument: null }), el("input", { type: "password" })]));
    expect(r.state).toBe("secret");
    expect(readProbeVerdict(asRes(r))).toBe("secret");
    expect(readProbeVerdict(asRes({ state: "safe" }))).toBe("safe");
    expect(readProbeVerdict(asRes({ state: "safe", opaque: 3, opaqueVisible: 0 }))).toBe("safe");
    expect(readProbeVerdict(asRes("garbage"))).toBe("unknown");
    expect(readProbeVerdict({ exceptionDetails: {}, result: { value: { state: "safe" } } })).toBe("unknown");
  });
});

// ───────────────────────── op 层：真 BrowserSession + 假 tab ─────────────────────────

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
  /** 主会话 / 各子会话探针返回的 value（整个对象，含 opaque / opaqueVisible） */
  mainValue: any = { state: "safe", opaque: 0, opaqueVisible: 0 };
  childValue: Record<string, any> = {};
  children: string[] = [];
  constructor(
    public id: string,
    public url: string,
  ) {}
  send = vi.fn(async (method: string, params: any = {}, sid: any = null) => {
    this.calls.push({ method, params, sid });
    if (method === "Runtime.evaluate") return { result: { value: sid ? (this.childValue[sid] ?? { state: "safe", opaque: 0, opaqueVisible: 0 }) : this.mainValue } };
    return {};
  });
  cdpSessionIds() {
    return [null, ...this.children];
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

const mk = async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "r6s2-rec-"));
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
  const session = new BrowserSession({ taskId: "task-r6s2", host, activityLog, graceMs: 8_000, now: () => clock.now });
  await session.openTab({});
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
    execFile: vi.fn(),
  } as any);
  cleanups.push(() => fs.rmSync(userData, { recursive: true, force: true }));
  return {
    tab,
    clock,
    session,
    call: (args: Record<string, unknown>) => (handlers as any).record("task-r6s2", normalize("record", args, OP_HELPERS as any)),
    systemNotes: () => (activityLog.list() as Array<{ actor: string; summary?: string }>).filter((e) => e.actor === "system").map((e) => e.summary ?? ""),
  };
};

const OPAQUE = { state: "safe", opaque: 1, opaqueVisible: 1 };
const HIDDEN_OPAQUE = { state: "safe", opaque: 2, opaqueVisible: 0 };
const NOTE = "录制暂停：存在无法检查的内嵌框架";

describe("R6-06 op：opaque 触发丢帧；非 opaque 正常录", () => {
  it("可见 opaque：帧不写盘，计入 skippedOpaque / redactedFrames，活动日志只提示一次，timeline 原因 opaque-frame", async () => {
    const e = await mk();
    await e.call({ action: "start" });
    e.tab.mainValue = OPAQUE;
    await e.tab.frame(jpeg(1));
    await e.tab.frame(jpeg(2));
    await e.tab.frame(jpeg(3));
    const r = await e.call({ action: "stop" });
    expect(r.frames).toBe(0);
    expect(r.skippedOpaque).toBe(3);
    expect(r.redactedFrames).toBe(3);
    expect(e.systemNotes().filter((s) => s === NOTE)).toHaveLength(1); // 一段暂停只提示一次，不刷屏
    const tl = JSON.parse(fs.readFileSync(r.timelineFile, "utf8"));
    expect(tl.markers.find((m: any) => m.type === "redacted-gap").text).toContain("opaque-frame");
  });

  it("没有 opaque（或 opaque 但不在视口）→ 正常写帧，skippedOpaque=0，没有提示", async () => {
    const e = await mk();
    await e.call({ action: "start" });
    await e.tab.frame(jpeg(1));
    e.tab.mainValue = HIDDEN_OPAQUE;
    await e.tab.frame(jpeg(2));
    const r = await e.call({ action: "stop" });
    expect(r.frames).toBe(2);
    expect(r.skippedOpaque).toBe(0);
    expect(r.redactedFrames).toBe(0);
    expect(e.systemNotes()).not.toContain(NOTE);
  });

  it("opaque 消失后：先过冷却帧再恢复录制；再次出现 opaque 会再提示一次（每段一次）", async () => {
    const e = await mk();
    await e.call({ action: "start" });
    e.tab.mainValue = OPAQUE;
    await e.tab.frame(jpeg(1));
    e.tab.mainValue = { state: "safe", opaque: 0, opaqueVisible: 0 };
    for (const tag of [2, 3, 4, 5]) {
      e.clock.now += 10;
      await e.tab.frame(jpeg(tag));
    }
    e.tab.mainValue = OPAQUE;
    e.clock.now += 10;
    await e.tab.frame(jpeg(6));
    const r = await e.call({ action: "stop" });
    expect(r.skippedOpaque).toBe(2); // 只统计「直接因 opaque 丢的帧」，冷却帧不算
    expect(r.frames).toBeGreaterThanOrEqual(1);
    expect(e.systemNotes().filter((s) => s === NOTE)).toHaveLength(2);
  });

  it("OOPIF 子会话里的可见 opaque 同样丢帧（子会话 unknown 平时被忽略，opaque 不能跟着被忽略）", async () => {
    const e = await mk();
    e.tab.children = ["child-A"];
    await e.call({ action: "start" });
    e.tab.childValue = { "child-A": OPAQUE };
    await e.tab.frame(jpeg(1));
    const r = await e.call({ action: "stop" });
    expect(r.frames).toBe(0);
    expect(r.skippedOpaque).toBe(1);
  });

  it("主会话已确认 secret 时仍按 secret 记（原因 secret-field，不记 skippedOpaque）", async () => {
    const e = await mk();
    await e.call({ action: "start" });
    e.tab.mainValue = { state: "secret", opaque: 1, opaqueVisible: 1 };
    await e.tab.frame(jpeg(1));
    const r = await e.call({ action: "stop" });
    expect(r.frames).toBe(0);
    expect(r.skippedOpaque).toBe(0);
    expect(r.redactedFrames).toBe(1);
  });

  it("活动日志提示文案固定：不含页面内容 / URL", async () => {
    const e = await mk();
    await e.call({ action: "start" });
    e.tab.mainValue = OPAQUE;
    await e.tab.frame(jpeg(1));
    await e.call({ action: "stop" });
    const note = e.systemNotes().find((s) => s.includes("录制暂停"))!;
    expect(note).toBe(NOTE);
    expect(note).not.toContain("127.0.0.1");
  });
});
