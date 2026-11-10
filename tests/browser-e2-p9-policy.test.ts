/* eslint-disable @typescript-eslint/no-explicit-any -- 极简假 DOM / 脏输入用例是刻意的，被测 .mjs 无类型声明 */
/**
 * E2·P9 / B7：record-policy.mjs 纯逻辑——上限判定、recId 与目录穿越防护、清理策略、时间线生成、ffmpeg 固定参数、PATH 候选、
 * 页内敏感探针（源码可编译 + 真正跑一遍假 DOM）、活动日志导出渲染与脱敏。
 */
import vm from "node:vm";
import { describe, expect, it } from "vitest";

import {
  ACTIVITY_FORMATS,
  EXPORT_FORMATS,
  RECORD_ACTIONS,
  RECORD_LIMITS,
  SECRET_VISIBLE_PROBE_SOURCE,
  buildFfmpegArgs,
  buildTimeline,
  clampStartArgs,
  entriesToMarkers,
  evaluateLimits,
  exportsRootFor,
  ffmpegCandidates,
  frameAt,
  frameFileName,
  framesFps,
  isValidRecId,
  makeRecId,
  markerTypeOf,
  mergeVerdicts,
  readProbeVerdict,
  recordingsRootFor,
  renderActivityExport,
  resolveRecDir,
  selectRecordingsToPrune,
  summarizeTimeline,
  toExportEntry,
} from "../electron-app/browser/record-policy.mjs";

describe("P9·常量与上限", () => {
  it("契约上限：600 帧 / 60s / 150MB；保留 5 个 / 500MB；ffmpeg 120s", () => {
    expect(RECORD_LIMITS.maxFrames).toBe(600);
    expect(RECORD_LIMITS.maxMs).toBe(60_000);
    expect(RECORD_LIMITS.maxBytes).toBe(150 * 1024 * 1024);
    expect(RECORD_LIMITS.keepRecordings).toBe(5);
    expect(RECORD_LIMITS.maxTotalBytes).toBe(500 * 1024 * 1024);
    expect(RECORD_LIMITS.ffmpegTimeoutMs).toBe(120_000);
    expect(Object.isFrozen(RECORD_LIMITS)).toBe(true);
  });

  it("action / 格式表固定（server 侧对账见 tool 测试）", () => {
    expect([...RECORD_ACTIONS]).toEqual(["start", "stop", "status", "export", "export_activity"]);
    expect([...EXPORT_FORMATS]).toEqual(["frames", "mp4", "gif"]);
    expect([...ACTIVITY_FORMATS]).toEqual(["json", "markdown"]);
  });

  it("evaluateLimits：三种到限原因各自触发；未到限返回 null；max_frames 可被 start 收紧", () => {
    expect(evaluateLimits({ frames: 599, bytes: 1, elapsedMs: 1 })).toBeNull();
    expect(evaluateLimits({ frames: 600, bytes: 1, elapsedMs: 1 })?.reason).toBe("max_frames");
    expect(evaluateLimits({ frames: 1, bytes: 1, elapsedMs: 60_000 })?.reason).toBe("max_duration");
    expect(evaluateLimits({ frames: 1, bytes: RECORD_LIMITS.maxBytes, elapsedMs: 1 })?.reason).toBe("max_bytes");
    expect(evaluateLimits({ frames: 10, bytes: 1, elapsedMs: 1, maxFrames: 10 })?.reason).toBe("max_frames");
    // start 的 max_frames 只能收紧、不能放宽超过硬上限
    expect(evaluateLimits({ frames: 600, bytes: 1, elapsedMs: 1, maxFrames: 99999 })?.reason).toBe("max_frames");
    expect(evaluateLimits({ frames: 1, bytes: 1, elapsedMs: 5, maxFrames: 600 }, { ...RECORD_LIMITS, maxMs: 5 })?.text).toContain("时长上限");
  });

  it("clampStartArgs：夹取 + 脏值回默认", () => {
    expect(clampStartArgs({})).toEqual({ maxFrames: 600, quality: 60, everyNth: 6 });
    expect(clampStartArgs({ maxFrames: 99999, quality: 1000, everyNth: 0 })).toEqual({ maxFrames: 600, quality: 90, everyNth: 1 });
    expect(clampStartArgs({ maxFrames: -5, quality: 3, everyNth: 999 })).toEqual({ maxFrames: 1, quality: 20, everyNth: 60 });
    expect(clampStartArgs({ maxFrames: Number.NaN, quality: "x" as unknown as number })).toEqual({ maxFrames: 600, quality: 60, everyNth: 6 });
  });
});

describe("P9·recId / 路径安全", () => {
  it("makeRecId 形状固定，isValidRecId 只认它", () => {
    const id = makeRecId(new Date(2026, 10, 9, 10, 5, 7), "ab12cd");
    expect(id).toBe("rec-20261109-100507-ab12cd");
    expect(isValidRecId(id)).toBe(true);
    for (const bad of ["", "rec-1", "../x", "rec-20261109-100507-ab12cd/..", "rec-20261109-100507-AB12CD", "rec-20261109-100507-ab12cd\n", "..\\..\\x", "/etc/passwd", 123, null, undefined]) {
      expect(isValidRecId(bad)).toBe(false);
    }
  });

  it("makeRecId 对脏 hex 兜底成合法形状", () => {
    expect(isValidRecId(makeRecId(new Date(), "zz!"))).toBe(true);
  });

  it("resolveRecDir：合法 id → root 下一层目录；穿越 / 绝对路径 / 非法 id → null", () => {
    const root = "/tmp/x/tasks/t1/browser-recordings";
    expect(resolveRecDir(root, "rec-20261109-100507-ab12cd")).toBe(`${root}/rec-20261109-100507-ab12cd`);
    for (const bad of ["../browser-state", "rec-20261109-100507-ab12cd/../../x", "/etc", "", "..", ".", "rec-20261109-100507-ab12cd/", "rec-20261109-100507-ab12c%"]) {
      expect(resolveRecDir(root, bad)).toBeNull();
    }
    expect(resolveRecDir("", "rec-20261109-100507-ab12cd")).toBeNull();
  });

  it("根目录：taskId 不安全 / userData 缺失 → null（绝不拼路径）", () => {
    expect(recordingsRootFor("/ud", "task-1")).toBe("/ud/data/tasks/task-1/browser-recordings");
    expect(exportsRootFor("/ud", "task-1")).toBe("/ud/data/tasks/task-1/browser-exports");
    for (const bad of ["../x", "a/b", "", "a b", "x".repeat(201), "..", null as unknown as string]) {
      expect(recordingsRootFor("/ud", bad)).toBeNull();
      expect(exportsRootFor("/ud", bad)).toBeNull();
    }
    expect(recordingsRootFor("", "t")).toBeNull();
  });

  it("frameFileName 固定 4 位补零", () => {
    expect(frameFileName(1)).toBe("frame-0001.jpg");
    expect(frameFileName(600)).toBe("frame-0600.jpg");
  });
});

describe("P9·清理策略 selectRecordingsToPrune", () => {
  const mk = (i: number, bytes = 10) => ({ name: makeRecId(new Date(2026, 0, 1, 0, 0, i), "00000" + (i % 10)), mtimeMs: i * 1000, bytes });

  it("只留最近 keep 个：旧的先删，返回「最旧在前」", () => {
    const es = [1, 2, 3, 4, 5, 6, 7].map((i) => mk(i));
    const rm = selectRecordingsToPrune(es, { keep: 4, maxTotalBytes: 1e9 });
    expect(rm).toEqual([es[0].name, es[1].name, es[2].name]);
  });

  it("总体积上限：从新到旧累计，超过就删更旧的", () => {
    const es = [1, 2, 3].map((i) => mk(i, 100));
    expect(selectRecordingsToPrune(es, { keep: 10, maxTotalBytes: 250 })).toEqual([es[0].name]);
    expect(selectRecordingsToPrune(es, { keep: 10, maxTotalBytes: 50 })).toEqual([es[0].name, es[1].name, es[2].name]);
  });

  it("名字不是 recId 形状的条目（用户自己放的 / 别的功能的目录）永远不选", () => {
    const es = [{ name: "my-important-notes", mtimeMs: 1, bytes: 1e12 }, { name: "../browser-state", mtimeMs: 0, bytes: 1e12 }, mk(5)];
    expect(selectRecordingsToPrune(es, { keep: 0, maxTotalBytes: 0 })).toEqual([es[2].name]);
  });

  it("protect 里的（刚结束 / 进行中）不会被选；脏输入不抛", () => {
    const es = [1, 2, 3].map((i) => mk(i));
    expect(selectRecordingsToPrune(es, { keep: 0, maxTotalBytes: 0, protect: [es[2].name] })).toEqual([es[0].name, es[1].name]);
    expect(selectRecordingsToPrune(null as never, { keep: 1, maxTotalBytes: 1 })).toEqual([]);
    expect(selectRecordingsToPrune([null, undefined, 3] as never, { keep: 1, maxTotalBytes: 1 })).toEqual([]);
  });
});

describe("P9·时间线", () => {
  const frames = [
    { n: 1, file: "frame-0001.jpg", t: 100, bytes: 10 },
    { n: 2, file: "frame-0002.jpg", t: 300, bytes: 20 },
    { n: 3, file: "frame-0003.jpg", t: 900, bytes: 30 },
  ];

  it("frameAt：t 之前最近的一帧；之前没有 → 0", () => {
    expect(frameAt(frames, 50)).toBe(0);
    expect(frameAt(frames, 300)).toBe(2);
    expect(frameAt(frames, 5000)).toBe(3);
    expect(frameAt([], 5)).toBe(0);
  });

  it("markerTypeOf：ai / user / 导航 / 其它系统", () => {
    expect(markerTypeOf({ actor: "ai", kind: "click" })).toBe("ai-action");
    expect(markerTypeOf({ actor: "user", kind: "type" })).toBe("user-action");
    expect(markerTypeOf({ actor: "system", kind: "navigate" })).toBe("navigation");
    // AI 自己的 navigate（活动日志里 actor=ai、kind=navigate）也算导航，actor 另存
    expect(markerTypeOf({ actor: "ai", kind: "navigate" })).toBe("navigation");
    expect(markerTypeOf({ actor: "user", kind: "navigate" })).toBe("navigation");
    expect(markerTypeOf({ actor: "system", kind: "load" })).toBe("navigation");
    expect(markerTypeOf({ actor: "system", kind: "takeover" })).toBe("system");
  });

  it("entriesToMarkers：时间对齐起点、范围外丢弃、坏条目跳过、文字剥控制字符并限长、url 过 redactUrl", () => {
    const entries = [
      { ts: 1000, actor: "system", kind: "navigate", summary: "打开了页面", tabId: "t1", url: "http://a.test/x" },
      { ts: 1400, actor: "ai", kind: "click", summary: "点击了按钮「提交」\u202e\u0000", tabId: "t1", url: "http://a.test/x?token=abc" },
      { ts: 500, actor: "ai", kind: "click", summary: "录制前的动作", tabId: "t1", url: "" },
      { ts: 99999, actor: "ai", kind: "click", summary: "录制后很久", tabId: "t1", url: "" },
      { ts: "bad", actor: "ai", summary: "x" },
      null,
      { ts: 1900, actor: "user", kind: "type", summary: "x".repeat(1000), tabId: "t1", url: "" },
    ];
    const ms = entriesToMarkers(entries, {
      startedAt: 1000,
      endedAt: 2000,
      frames,
      redactUrl: (u) => u.replace(/\?.*/, "?[已隐藏]"),
    });
    expect(ms.map((m) => [m.t, m.type])).toEqual([
      [0, "navigation"],
      [400, "ai-action"],
      [900, "user-action"],
    ]);
    expect(ms[1].url).toBe("http://a.test/x?[已隐藏]");
    expect(ms[1].text).not.toMatch(/[\u202e\u0000]/);
    expect(ms[2].text.length).toBeLessThanOrEqual(160);
    expect(ms[1].frame).toBe(2);
    expect(entriesToMarkers(entries, { startedAt: 1000, endedAt: 2000, frames, max: 1 })).toHaveLength(1);
  });

  it("buildTimeline：gap / user-control 并入 markers 并按时间排序；summarizeTimeline 统计", () => {
    const tl = buildTimeline({
      recId: "rec-20261109-100507-ab12cd",
      tabId: "t1",
      startedAt: 1000,
      endedAt: 3000,
      stopReason: "stopped",
      frames,
      markers: [{ t: 700, type: "ai-action", kind: "click", text: "点击", tabId: "t1", url: "", frame: 2 }],
      gaps: [{ t: 350, endT: 600, skipped: 4, reason: "secret-field" }],
      userControl: [{ t: 1200, endT: 1800 }],
      limits: RECORD_LIMITS,
      params: { quality: 60, everyNth: 6 },
    });
    expect(tl.markers.map((m: { type: string }) => m.type)).toEqual(["redacted-gap", "ai-action", "user-control"]);
    expect(tl.markers[0]).toMatchObject({ t: 350, endT: 600, frame: 2 });
    expect(tl.totalBytes).toBe(60);
    expect(tl.durationMs).toBe(2000);
    expect(tl.frames.map((f: { file: string }) => f.file)).toEqual(["frame-0001.jpg", "frame-0002.jpg", "frame-0003.jpg"]);
    const s = summarizeTimeline(tl);
    expect(s).toMatchObject({ frames: 3, durationMs: 2000, totalBytes: 60, markerCount: 3, stopReason: "stopped" });
    expect(s.markerCounts).toEqual({ "redacted-gap": 1, "ai-action": 1, "user-control": 1 });
    // timeline 是纯 JSON，可往返
    expect(JSON.parse(JSON.stringify(tl))).toEqual(tl);
  });
});

describe("P9·ffmpeg 参数与 PATH 候选", () => {
  it("buildFfmpegArgs：固定数组，输入是相对模式、没有任何路径 / shell 元字符", () => {
    const args = buildFfmpegArgs({ fps: 10, maxBytes: 1000000, outName: ".rec-abcdef12.tmp.mp4" });
    expect(Array.isArray(args)).toBe(true);
    expect(args).toContain("frame-%04d.jpg");
    expect(args.at(-1)).toBe(".rec-abcdef12.tmp.mp4");
    expect(args[args.indexOf("-framerate") + 1]).toBe("10");
    expect(args[args.indexOf("-fs") + 1]).toBe("1000000");
    expect(args).toContain("-nostdin");
    expect(args).toContain("-y");
    // 没有绝对路径、没有会被 shell 解释的字符（参数里只有 % 与 * 在 -vf / 输入模式中，不经 shell）
    for (const a of args) expect(a).not.toMatch(/[;&|`$<>\\\n]|^\/|^[A-Za-z]:\\/);
  });

  it("buildFfmpegArgs：fps / 上限被夹取；输出名只认生成的形状（防注入）", () => {
    expect(buildFfmpegArgs({ fps: 9999, maxBytes: 5e6, outName: ".rec-abcdef12.tmp.mp4" })[6]).toBe("30");
    expect(buildFfmpegArgs({ fps: Number.NaN, maxBytes: 5e6, outName: ".rec-abcdef12.tmp.mp4" })[6]).toBe("2");
    for (const bad of ["x.mp4", "../out.mp4", ".rec-abcdef12.tmp.mp4; rm -rf /", "/tmp/o.mp4", "-f lavfi", ".rec-XYZ.tmp.mp4", ""]) {
      expect(() => buildFfmpegArgs({ fps: 10, maxBytes: 5e6, outName: bad })).toThrow(/非法/);
    }
  });

  it("framesFps：帧数 / 时长，夹在 [1,30]；单帧 / 零时长 → 2", () => {
    expect(framesFps(100, 10_000)).toBe(10);
    expect(framesFps(600, 1000)).toBe(30);
    expect(framesFps(2, 600_000)).toBe(1);
    expect(framesFps(1, 1000)).toBe(2);
    expect(framesFps(5, 0)).toBe(2);
  });

  it("ffmpegCandidates：只收绝对路径项（空 / 相对 / `.` 都跳过），去重", () => {
    expect(ffmpegCandidates("/usr/bin:/opt/homebrew/bin:/usr/bin", "linux")).toEqual(["/usr/bin/ffmpeg", "/opt/homebrew/bin/ffmpeg"]);
    expect(ffmpegCandidates(":.:bin:./x:/ok", "linux")).toEqual(["/ok/ffmpeg"]);
    expect(ffmpegCandidates("", "linux")).toEqual([]);
    expect(ffmpegCandidates(undefined, "linux")).toEqual([]);
    expect(ffmpegCandidates('C:\\tools;"D:\\ff";rel', "win32")).toEqual(["C:\\tools\\ffmpeg.exe", "D:\\ff\\ffmpeg.exe"]);
  });
});

describe("P9·敏感字段探针", () => {
  it("源码可编译；与 secret-field 同源（内嵌 isSecretInfo / readSecretInfo）；只读不写", () => {
    expect(() => new vm.Script(SECRET_VISIBLE_PROBE_SOURCE)).not.toThrow();
    expect(SECRET_VISIBLE_PROBE_SOURCE).toContain("function isSecretInfo");
    expect(SECRET_VISIBLE_PROBE_SOURCE).toContain("function readSecretInfo");
    expect(SECRET_VISIBLE_PROBE_SOURCE).not.toMatch(/appendChild|createElement|innerHTML|\.value\s*=/);
  });

  // 极简假 DOM：只实现探针用到的接口
  const el = (tag: string, o: Record<string, any> = {}) => ({
    tagName: tag.toUpperCase(),
    type: o.type ?? "",
    nodeType: 1,
    shadowRoot: o.shadowRoot ?? null,
    contentDocument: o.contentDocument,
    getAttribute: (k: string) => (k === "type" ? (o.type ?? null) : k === "autocomplete" ? (o.autocomplete ?? null) : null),
    getBoundingClientRect: () => o.rect ?? { left: 10, top: 10, width: 100, height: 20 },
    ownerDocument: { defaultView: { getComputedStyle: () => ({ visibility: o.visibility ?? "visible", display: o.display ?? "block", webkitTextSecurity: o.textSecurity ?? "" }) } },
  });
  const root = (els: any[], active: any = null) => ({ documentElement: {}, activeElement: active, querySelectorAll: () => els });
  const run = (doc: any, extra: Record<string, any> = {}) => {
    const ctx: any = { document: doc, window: { innerWidth: 800, innerHeight: 600, getComputedStyle: () => ({}) }, getComputedStyle: () => ({}), ...extra };
    return vm.runInNewContext(SECRET_VISIBLE_PROBE_SOURCE, ctx);
  };

  it("可见的密码框 → secret；普通文本框 → safe", () => {
    expect(run(root([el("input", { type: "password" })])).state).toBe("secret");
    expect(run(root([el("input", { type: "text" })])).state).toBe("safe");
    expect(run(root([])).state).toBe("safe");
  });

  it("autocomplete=one-time-code / cc-number、-webkit-text-security 的 text 框也算敏感（与 secret-field 同规则）", () => {
    expect(run(root([el("input", { type: "text", autocomplete: "one-time-code" })])).state).toBe("secret");
    expect(run(root([el("input", { type: "text", autocomplete: "cc-number" })])).state).toBe("secret");
    expect(run(root([el("input", { type: "text", textSecurity: "disc" })])).state).toBe("secret");
  });

  it("不可见的密码框（display:none / visibility:hidden / 零尺寸 / 视口外）→ safe；但聚焦的敏感框无论如何都 secret", () => {
    expect(run(root([el("input", { type: "password", display: "none" })])).state).toBe("safe");
    expect(run(root([el("input", { type: "password", visibility: "hidden" })])).state).toBe("safe");
    expect(run(root([el("input", { type: "password", rect: { left: 0, top: 0, width: 0, height: 0 } })])).state).toBe("safe");
    expect(run(root([el("input", { type: "password", rect: { left: 0, top: 5000, width: 100, height: 20 } })])).state).toBe("safe");
    const focused = el("input", { type: "password", display: "none" });
    expect(run(root([focused], focused)).state).toBe("secret");
  });

  it("穿过 shadow root 与同源 iframe；跨域 iframe 计入 opaque", () => {
    const pw = el("input", { type: "password" });
    const host = el("div", { shadowRoot: root([pw]) });
    expect(run(root([host])).state).toBe("secret");
    const inner = el("iframe", { contentDocument: root([el("input", { type: "password" })]), rect: { left: 0, top: 0, width: 300, height: 200 } });
    expect(run(root([inner])).state).toBe("secret");
    const cross = el("iframe", { contentDocument: null });
    const r = run(root([cross, el("input", { type: "text" })]));
    expect(r).toMatchObject({ state: "safe", opaque: 1 });
  });

  it("读取 DOM 抛错 → unknown（fail-closed），不是 safe", () => {
    const boom = { documentElement: {}, activeElement: null, querySelectorAll: () => { throw new Error("x"); } };
    expect(run(boom).state).toBe("unknown");
  });

  it("readProbeVerdict / mergeVerdicts：形状不对一律 unknown；子会话 unknown 不拖累，子会话 secret 一票否决", () => {
    expect(readProbeVerdict({ result: { value: { state: "safe" } } })).toBe("safe");
    expect(readProbeVerdict({ result: { value: { state: "secret" } } })).toBe("secret");
    for (const bad of [null, undefined, {}, { result: {} }, { result: { value: "secret" } }, { result: { value: { state: "weird" } } }, { exceptionDetails: {}, result: { value: { state: "safe" } } }]) {
      expect(readProbeVerdict(bad)).toBe("unknown");
    }
    expect(mergeVerdicts("safe", ["unknown", "safe"])).toBe("safe");
    expect(mergeVerdicts("safe", ["secret"])).toBe("secret");
    expect(mergeVerdicts("unknown", ["safe"])).toBe("unknown");
    expect(mergeVerdicts("secret", [])).toBe("secret");
    expect(mergeVerdicts("safe", undefined as never)).toBe("safe");
  });
});

describe("P9·活动日志导出", () => {
  const redact = { redactText: (s: string, n: number) => s.replace(/sk-[A-Za-z0-9]{10,}/g, "[已隐藏]").slice(0, n), redactUrl: (u: string) => u.replace(/\?.*/, "") };
  const e = { ts: Date.UTC(2026, 10, 9, 2, 3, 4), actor: "ai", kind: "click", summary: "点击了「提交」sk-abcdefghijklmnop\n下一行", tabId: "t1", url: "http://a.test/p?token=zzz" };

  it("toExportEntry：时间 ISO / actor 白名单 / 文字脱敏并压成一行 / url 脱敏", () => {
    const row = toExportEntry(e, redact);
    expect(row.time).toBe("2026-11-09T02:03:04.000Z");
    expect(row.text).toBe("点击了「提交」[已隐藏] 下一行");
    expect(row.url).toBe("http://a.test/p");
    expect(row.actor).toBe("ai");
    expect(toExportEntry({ ...e, actor: "evil" }, redact).actor).toBe("system");
  });

  it("json：合法 JSON 且带 entries；markdown：转义特殊字符、不含脱敏前内容", () => {
    const rows = [toExportEntry(e, redact), toExportEntry({ ...e, summary: "# 标题 [x](http://evil) |", actor: "user" }, redact)];
    const j = JSON.parse(renderActivityExport(rows, "json"));
    expect(j.count).toBe(2);
    expect(j.entries[0].text).not.toContain("sk-");
    const md = renderActivityExport(rows, "markdown");
    expect(md).toContain("# 浏览器活动日志");
    expect(md).not.toContain("sk-abc");
    expect(md).toContain("\\[x\\]\\(http://evil\\)");
    expect(md).toContain("\\# 标题");
    expect(md).toContain("**AI**");
    expect(md).toContain("**用户**");
  });
});
