/* eslint-disable @typescript-eslint/no-explicit-any -- 被测 .mjs 无类型声明，any 是刻意的 */
/**
 * E2·P4 / B1：WebSocket 帧 / SSE 事件采集（net-streams.mjs：上限、脱敏、二进制只记长度、clear 不复活）、initiator（≤3 帧、URL 脱敏）、
 * network_detail 的帧块、HAR 1.2 导出（har.mjs：结构合法、URL / 头 / body / 帧全脱敏、没有明文选项、0600 / 0700、路径主进程生成、自动收尾）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import * as harMod from "../electron-app/browser/har.mjs";
import * as streamsMod from "../electron-app/browser/net-streams.mjs";

// .mjs 的 JSDoc 推断类型过窄（联合类型 / 可选字段访问会报错），测试里按 any 用
const { buildHar, buildHarEntry, HAR_DIR_NAME, HAR_KEEP_FILES, harBaseName, harDirFor, pruneHarDir, writeHarFile } = harMod as any;
const {
  assembleStreamDetail,
  base64ByteLength,
  createStreamCollector,
  formatInitiator,
  INITIATOR_MAX_FRAMES,
  makeSseEvent,
  makeWsFrame,
  STREAM_PAYLOAD_MAX,
  STREAMS_PER_TAB,
  WS_FRAMES_PER_SOCKET,
} = streamsMod as any;

const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
const BEARER = "Bearer abcdef0123456789abcdef0123456789";
const TOKEN_Q = "token=SUPERSECRETTOKEN123456";

// ───────────────────────── 帧 / 事件 ─────────────────────────

describe("makeWsFrame / makeSseEvent：先脱敏后截断", () => {
  it("文本帧里的 Bearer / token= / JWT 入缓冲前就被脱敏（缓冲里从来没有明文）", () => {
    const f = makeWsFrame("received", { opcode: 1, payloadData: `{"auth":"${BEARER}","jwt":"${JWT}","q":"?${TOKEN_Q}"}` }, 1);
    expect(f.text).not.toContain("abcdef0123456789abcdef0123456789");
    expect(f.text).not.toContain(JWT);
    expect(f.text).not.toContain("SUPERSECRETTOKEN123456");
    expect(f.dir).toBe("received");
    expect(f.opcode).toBe(1);
  });

  it("负载截到 4KB；秘密落在截断点附近也不会被劈成两段漏过（先脱敏后截断）", () => {
    const big = `${"x".repeat(STREAM_PAYLOAD_MAX - 10)} ${BEARER} tail`;
    const f = makeWsFrame("sent", { opcode: 1, payloadData: big }, 1);
    expect(f.text.length).toBeLessThanOrEqual(STREAM_PAYLOAD_MAX);
    expect(f.text).not.toContain("abcdef01234");
    const long = makeWsFrame("sent", { opcode: 1, payloadData: "y".repeat(STREAM_PAYLOAD_MAX * 3) }, 1);
    expect(long.text).toHaveLength(STREAM_PAYLOAD_MAX);
    expect(long.truncated).toBe(true);
    expect(long.length).toBe(STREAM_PAYLOAD_MAX * 3);
  });

  it("二进制帧只记长度（按 base64 解码后的字节数），不含 text；控制帧同样只有长度", () => {
    const b64 = Buffer.from("secret-binary-payload-with-token=ABCDEF1234567890").toString("base64");
    const f = makeWsFrame("received", { opcode: 2, payloadData: b64 }, 1);
    expect(f).toMatchObject({ opcode: 2, binary: true, length: Buffer.from(b64, "base64").length });
    expect("text" in f).toBe(false);
    const close = makeWsFrame("received", { opcode: 8, payloadData: "bye" }, 1);
    expect(close).toMatchObject({ opcode: 8, binary: true, length: 3 });
    expect("text" in close).toBe(false);
    expect(base64ByteLength("")).toBe(0);
    expect(base64ByteLength("YQ==")).toBe(1);
    expect(base64ByteLength("YWI=")).toBe(2);
    expect(base64ByteLength("YWJj")).toBe(3);
  });

  it("脏输入不炸：缺 response / payload 不是字符串", () => {
    expect(() => makeWsFrame("sent", undefined, 1)).not.toThrow();
    expect(makeWsFrame("sent", { opcode: 1, payloadData: 123 }, 1).text).toBe("");
    expect(() => makeSseEvent(undefined, 1)).not.toThrow();
  });

  it("SSE：data / event 名 / id 都过脱敏，页面可以往 event 名里塞任何东西", () => {
    const e = makeSseEvent({ data: `hello ${BEARER}`, eventName: `evt ${BEARER}`, eventId: `id-${JWT}` }, 5);
    const all = JSON.stringify(e);
    expect(all).not.toContain("abcdef0123456789abcdef0123456789");
    expect(all).not.toContain(JWT);
    expect(e.dir).toBe("event");
    expect(makeSseEvent({ data: "x", eventName: "", eventId: "" }, 1)).not.toHaveProperty("event");
  });
});

describe("formatInitiator：≤3 帧、URL 脱敏", () => {
  it("只取前 3 帧；每帧「函数 url:行:列」（行列 1 起算）", () => {
    const frames = Array.from({ length: 8 }, (_, i) => ({ functionName: `fn${i}`, url: `https://a.test/app.js`, lineNumber: i, columnNumber: 4 }));
    const r = formatInitiator({ type: "script", stack: { callFrames: frames } })!;
    expect(r.type).toBe("script");
    expect(r.stack).toHaveLength(INITIATOR_MAX_FRAMES);
    expect(r.stack[0]).toBe("fn0 https://a.test/app.js:1:5");
  });

  it("栈里的 URL 查询敏感参数 / userinfo 被脱敏；匿名函数与 inline 脚本有占位", () => {
    const r = formatInitiator({ type: "script", stack: { callFrames: [{ functionName: "", url: `https://u:pw123456@a.test/app.js?${TOKEN_Q}`, lineNumber: 0, columnNumber: 0 }, { functionName: "g", url: "", lineNumber: 2 }] } })!;
    const text = r.stack.join("\n");
    expect(text).not.toContain("SUPERSECRETTOKEN123456");
    expect(text).not.toContain("pw123456");
    expect(r.stack[0]).toContain("(anonymous)");
    expect(r.stack[1]).toContain("<inline>");
  });

  it("parser / preload 没有调用栈 → 用发起文档位置；other 且无栈 → undefined；类型字符串被净化", () => {
    expect(formatInitiator({ type: "parser", url: "https://a.test/index.html", lineNumber: 9 })!.stack).toEqual(["<parser> https://a.test/index.html:10"]);
    expect(formatInitiator({ type: "other" })).toBeUndefined();
    expect(formatInitiator(null)).toBeUndefined();
    expect(formatInitiator({ type: "scr<ipt>\n", stack: { callFrames: [{ functionName: "f", url: "https://a.test/x.js" }] } })!.type).toBe("script");
    // 超长函数名 / URL 被截断
    const long = formatInitiator({ type: "script", stack: { callFrames: [{ functionName: "f".repeat(500), url: `https://a.test/${"p".repeat(1000)}` }] } })!;
    expect(long.stack[0].length).toBeLessThan(400);
  });
});

// ───────────────────────── 采集器 ─────────────────────────

const mkCollector = (opts: { maxFrames?: number; maxStreams?: number; budget?: number } = {}) => {
  const ring: any[] = [];
  let id = 0;
  let t = 1000;
  const col = createStreamCollector({
    now: () => (t += 1),
    addEntry: (partial: any) => {
      const entry = { ...partial, id: ++id };
      ring.push(entry);
      return { entry, detail: {} };
    },
    ...opts,
  });
  return { col, ring };
};

describe("createStreamCollector：WebSocket", () => {
  it("created 入环 type=WebSocket；握手补 status / 头；帧入缓冲；closed 补 durationMs", () => {
    const { col, ring } = mkCollector();
    expect(col.handle("Network.webSocketCreated", { requestId: "w1", url: "wss://a.test/ws?token=SUPERSECRETTOKEN123456" }, null)).toBe(true);
    expect(ring).toHaveLength(1);
    expect(ring[0]).toMatchObject({ type: "WebSocket", method: "GET", status: null });
    col.handle("Network.webSocketWillSendHandshakeRequest", { requestId: "w1", timestamp: 10, request: { headers: { Authorization: "Bearer x" } } }, null);
    col.handle("Network.webSocketHandshakeResponseReceived", { requestId: "w1", response: { status: 101, headers: { Upgrade: "websocket" } } }, null);
    col.handle("Network.webSocketFrameSent", { requestId: "w1", response: { opcode: 1, payloadData: "ping" } }, null);
    col.handle("Network.webSocketFrameReceived", { requestId: "w1", response: { opcode: 1, payloadData: `pong ${BEARER}` } }, null);
    col.handle("Network.webSocketClosed", { requestId: "w1", timestamp: 12.5 }, null);
    expect(ring[0]).toMatchObject({ status: 101, closed: true, durationMs: 2500, frameCount: 2 });
    const f = col.framesOf(1, 50)!;
    expect(f.kind).toBe("websocket");
    expect(f.frames.map((x: any) => x.dir)).toEqual(["sent", "received"]);
    expect(JSON.stringify(f)).not.toContain("abcdef0123456789abcdef0123456789");
    expect(f.closed).toBe(true);
  });

  it("每个 socket 最多保留 200 帧（挤掉最旧的、记 dropped、total 继续累加）", () => {
    const { col } = mkCollector();
    col.handle("Network.webSocketCreated", { requestId: "w1", url: "wss://a.test/ws" }, null);
    for (let i = 0; i < WS_FRAMES_PER_SOCKET + 55; i += 1) col.handle("Network.webSocketFrameReceived", { requestId: "w1", response: { opcode: 1, payloadData: `m${i}` } }, null);
    const f = col.framesOf(1, 500)!;
    expect(f.frames).toHaveLength(WS_FRAMES_PER_SOCKET);
    expect(f.total).toBe(WS_FRAMES_PER_SOCKET + 55);
    expect(f.dropped).toBe(55);
    expect(f.frames[0].text).toBe("m55"); // 最旧的 55 帧被挤掉
    expect(col.framesOf(1, 5)!.frames.map((x: any) => x.text)).toEqual(["m250", "m251", "m252", "m253", "m254"]); // limit 取最近的
  });

  it("每个 tab 最多 50 个 socket：挤掉最旧的整条（帧一起没了，条目标 framesEvicted）", () => {
    const { col, ring } = mkCollector();
    for (let i = 0; i < STREAMS_PER_TAB + 5; i += 1) col.handle("Network.webSocketCreated", { requestId: `w${i}`, url: `wss://a.test/${i}` }, null);
    expect(col.size()).toBe(STREAMS_PER_TAB);
    expect(col.framesOf(ring[0].id)).toBeNull();
    expect(ring[0].framesEvicted).toBe(true);
    expect(col.framesOf(ring[STREAMS_PER_TAB + 4].id)).not.toBeNull();
    // 被挤出之后到达的帧一律忽略
    col.handle("Network.webSocketFrameReceived", { requestId: "w0", response: { opcode: 1, payloadData: "late" } }, null);
    expect(col.size()).toBe(STREAMS_PER_TAB);
  });

  it("总字符预算兜底：超预算从最旧连接的最旧帧开始丢", () => {
    const { col } = mkCollector({ budget: 10_000 });
    col.handle("Network.webSocketCreated", { requestId: "w1", url: "wss://a.test/1" }, null);
    for (let i = 0; i < 10; i += 1) col.handle("Network.webSocketFrameReceived", { requestId: "w1", response: { opcode: 1, payloadData: "z".repeat(3000) } }, null);
    const f = col.framesOf(1, 500)!;
    expect(f.frames.length * 3000).toBeLessThanOrEqual(10_000);
    expect(f.dropped).toBeGreaterThan(0);
    expect(col.stats().totalChars).toBeLessThanOrEqual(10_000);
  });

  it("clear 后连接与帧一起清空，清空后到达的帧不会让连接「复活」", () => {
    const { col } = mkCollector();
    col.handle("Network.webSocketCreated", { requestId: "w1", url: "wss://a.test/1" }, null);
    col.handle("Network.webSocketFrameReceived", { requestId: "w1", response: { opcode: 1, payloadData: "a" } }, null);
    col.clear();
    expect(col.size()).toBe(0);
    expect(col.has(null, "w1")).toBe(false);
    col.handle("Network.webSocketFrameReceived", { requestId: "w1", response: { opcode: 1, payloadData: "b" } }, null);
    expect(col.size()).toBe(0);
    expect(col.stats().totalChars).toBe(0);
  });

  it("按 sessionId 区分同名 requestId（OOPIF 子会话）；帧错误标 failed；非流事件返回 false 交还调用方", () => {
    const { col, ring } = mkCollector();
    col.handle("Network.webSocketCreated", { requestId: "w1", url: "wss://a.test/1" }, null);
    col.handle("Network.webSocketCreated", { requestId: "w1", url: "wss://a.test/2" }, "child");
    expect(col.size()).toBe(2);
    col.handle("Network.webSocketFrameError", { requestId: "w1", errorMessage: `bad ${BEARER}` }, "child");
    expect(ring[1].failed).toBe(true);
    expect(ring[1].errorText).not.toContain("abcdef0123456789abcdef0123456789");
    expect(ring[0].failed).toBeUndefined();
    expect(col.handle("Network.requestWillBeSent", { requestId: "x" }, null)).toBe(false);
    expect(col.handle("Network.webSocketFrameSent", {}, null)).toBe(true); // 缺 requestId：吞掉，不炸
  });

  it("initiator 随 webSocketCreated 进条目（≤3 帧）", () => {
    const { col, ring } = mkCollector();
    col.handle(
      "Network.webSocketCreated",
      { requestId: "w1", url: "wss://a.test/1", initiator: { type: "script", stack: { callFrames: Array.from({ length: 6 }, (_, i) => ({ functionName: `f${i}`, url: "https://a.test/a.js", lineNumber: i })) } } },
      null,
    );
    expect(ring[0].initiator.stack).toHaveLength(3);
  });
});

describe("createStreamCollector：SSE", () => {
  it("openSse 之后 eventSourceMessageReceived 进缓冲；endSse 标 closed + durationMs；失败标 failed", () => {
    const { col } = mkCollector();
    const entry: any = { id: 7, ts: 1000, type: "EventSource" };
    const detail: any = {};
    col.openSse(null, "s1", entry, detail, 5);
    expect(detail.stream).toBe("sse");
    col.handle("Network.eventSourceMessageReceived", { requestId: "s1", eventName: "tick", eventId: "1", data: `n=1 ${BEARER}` }, null);
    col.handle("Network.eventSourceMessageReceived", { requestId: "s1", eventName: "tick", eventId: "2", data: "n=2" }, null);
    const f = col.framesOf(7)!;
    expect(f.kind).toBe("sse");
    expect(f.frames).toHaveLength(2);
    expect(JSON.stringify(f)).not.toContain("abcdef0123456789abcdef0123456789");
    expect(f.frames[0]).toMatchObject({ dir: "event", event: "tick", eventId: "1" });
    expect(col.endSse(null, "s1", { timestamp: 7 })).toBe(true);
    expect(entry).toMatchObject({ closed: true, durationMs: 2000, frameCount: 2 });
    expect(col.endSse(null, "nope")).toBe(false);
    const e2: any = { id: 8, ts: 1 };
    col.openSse(null, "s2", e2, {}, 1);
    col.endSse(null, "s2", { failed: true, errorText: "net::ERR_X" });
    expect(e2).toMatchObject({ failed: true, errorText: "net::ERR_X" });
  });

  it("SSE 也受 200 帧上限；clear 后再来的事件被忽略", () => {
    const { col } = mkCollector();
    col.openSse(null, "s1", { id: 1, ts: 1 }, {}, 1);
    for (let i = 0; i < 300; i += 1) col.handle("Network.eventSourceMessageReceived", { requestId: "s1", data: `e${i}` }, null);
    expect(col.framesOf(1, 500)!.frames).toHaveLength(200);
    col.clear();
    col.handle("Network.eventSourceMessageReceived", { requestId: "s1", data: "late" }, null);
    expect(col.size()).toBe(0);
  });
});

describe("assembleStreamDetail：network_detail 的帧块（与 include_body 同闸）", () => {
  const frames = {
    kind: "websocket",
    total: 2,
    dropped: 0,
    closed: false,
    frames: [
      { dir: "sent", ts: 1100, length: 4, opcode: 1, text: "ping" },
      { dir: "received", ts: 1200, length: 100, opcode: 2, binary: true },
    ],
  };
  it("没带 include_body：只给方向 / 大小 / 时间，不含负载文本，并提示怎么看内容", () => {
    const d = assembleStreamDetail({ base: { id: 1 }, entry: { ts: 1000, frameCount: 2 }, streamFrames: frames as any, includeText: false });
    expect(JSON.stringify(d)).not.toContain("ping");
    expect(d.frames.textIncluded).toBe(false);
    expect(d.frames.items[0]).toMatchObject({ dir: "sent", tMs: 100, length: 4, opName: "text" });
    expect(d.frames.items[1]).toMatchObject({ binary: true, opName: "binary" });
    expect(d.frames.note).toContain("include_body");
  });
  it("带 include_body：给文本；帧已被挤出缓冲时给 unavailableReason", () => {
    const d = assembleStreamDetail({ base: { id: 1 }, entry: { ts: 1000 }, streamFrames: frames as any, includeText: true });
    expect(d.frames.items[0].text).toBe("ping");
    expect(d.frames.items[1]).not.toHaveProperty("text");
    const gone = assembleStreamDetail({ base: { id: 1 }, entry: { ts: 1000 }, streamFrames: null as any, includeText: true });
    expect(gone.frames.items).toEqual([]);
    expect(gone.frames.unavailableReason).toContain("50");
  });
});

// ───────────────────────── HAR ─────────────────────────

describe("buildHarEntry：全部出站内容过脱敏，没有明文选项", () => {
  const entry = { id: 3, ts: 1_700_000_000_000, method: "POST", url: `https://u:pw123456@a.test/api?${TOKEN_Q}&ok=1`, status: 200, type: "Fetch", durationMs: 42 };
  const detail = {
    requestHeaders: { Authorization: BEARER, Cookie: "sid=SESSIONSECRET123", "X-Trace": "t1", "X-Custom": `Bearer ${"z".repeat(30)}`, "Content-Type": "application/json" },
    responseHeaders: { "Set-Cookie": "sid=NEWSESSIONSECRET; HttpOnly", Location: `https://a.test/next?${TOKEN_Q}`, "Content-Type": "application/json" },
    mimeType: "application/json",
  };
  const body = { requestText: `{"password":"hunter2hunter2","note":"${BEARER}"}`, response: { ok: true, body: `{"jwt":"${JWT}","name":"x"}`, base64Encoded: false } };

  it("URL / queryString / 请求头 / 响应头 / Location / postData / response body 都不含明文凭据", () => {
    const h = buildHarEntry({ entry, detail, body });
    const all = JSON.stringify(h);
    for (const secret of ["SUPERSECRETTOKEN123456", "pw123456", "SESSIONSECRET123", "NEWSESSIONSECRET", "abcdef0123456789abcdef0123456789", JWT, "hunter2hunter2", "z".repeat(30)]) {
      expect(all).not.toContain(secret);
    }
    // 非敏感信息保留
    expect(h.request.url).toContain("ok=1");
    expect(h.request.queryString.find((q: any) => q.name === "ok")?.value).toBe("1");
    expect(h.request.headers.find((x: any) => x.name === "X-Trace")?.value).toBe("t1");
    expect(h.request.cookies).toEqual([]);
    expect(h.response.cookies).toEqual([]);
    expect(h.request.postData.text).toContain("[已隐藏]");
    expect(h.response.content.text).toContain("name");
  });

  it("没有「关闭脱敏」的入口：传 redact:false / plain 之类的参数无效", () => {
    const h = buildHarEntry({ entry, detail, body, redact: false, plain: true, raw: true } as any);
    expect(JSON.stringify(h)).not.toContain("SUPERSECRETTOKEN123456");
    expect(buildHarEntry.length).toBe(1); // 只有一个对象参数
    const built = buildHar({ entries: [h], redact: false } as any);
    expect(built.text).not.toContain("SUPERSECRETTOKEN123456");
  });

  it("不带 body 参数（networkBodyRead 关或 include_bodies=false）：不含 postData / 响应体文本", () => {
    const h = buildHarEntry({ entry, detail });
    expect(h.request.postData).toBeUndefined();
    expect(h.response.content.text).toBeUndefined();
    expect(h.response.content.size).toBe(0);
  });

  it("非文本响应体不导出；取 body 失败时写 comment 而不是丢条目；base64 文本能解码后脱敏", () => {
    const img = buildHarEntry({ entry, detail: { ...detail, mimeType: "image/png" }, body: { response: { ok: true, body: "AAAA", base64Encoded: true } } });
    expect(img.response.content.text).toBeUndefined();
    expect(img.response.content.comment).toContain("非文本");
    const fail = buildHarEntry({ entry, detail, body: { response: { ok: false, reason: "body 已被淘汰" } } });
    expect(fail.response.content.comment).toContain("淘汰");
    const b64 = buildHarEntry({ entry, detail, body: { response: { ok: true, body: Buffer.from(`k ${BEARER}`).toString("base64"), base64Encoded: true } } });
    expect(b64.response.content.text).not.toContain("abcdef0123456789abcdef0123456789");
  });

  it("扩展字段：_ruled / _cache / _initiator（URL 脱敏）/ _error / SW / 被截断 URL", () => {
    const h = buildHarEntry({
      entry: { ...entry, ruled: "mock", cache: "fromDiskCache", fromServiceWorker: true, errorText: `net::ERR ${BEARER}`, initiator: { type: "script", stack: [`f https://a.test/a.js?${TOKEN_Q}:1:1`] }, url: `${entry.url}…` },
      detail,
    });
    expect(h).toMatchObject({ _ruled: "mock", _cache: "fromDiskCache", _fromServiceWorker: true, _urlTruncated: true, _resourceType: "Fetch", _id: 3 });
    expect(JSON.stringify(h)).not.toContain("SUPERSECRETTOKEN123456");
    expect(JSON.stringify(h)).not.toContain("abcdef0123456789abcdef0123456789");
  });

  it("WebSocket / SSE 条目带帧：没带 body 时只有长度；带 body 时是已脱敏文本", () => {
    const frames = {
      kind: "websocket",
      frames: [
        { dir: "sent", ts: 5, opcode: 1, length: 9, text: "hello [已隐藏]" },
        { dir: "received", ts: 6, opcode: 2, length: 99, binary: true },
      ],
    };
    const noBody = buildHarEntry({ entry: { ...entry, type: "WebSocket", url: "wss://a.test/ws" }, detail: {}, streamFrames: frames });
    expect(noBody._webSocketMessages.map((m: any) => m.data)).toEqual(["", ""]);
    expect(noBody._webSocketMessages.map((m: any) => m.type)).toEqual(["send", "receive"]);
    const withBody = buildHarEntry({ entry: { ...entry, type: "WebSocket", url: "wss://a.test/ws" }, detail: {}, body: {}, streamFrames: frames });
    expect(withBody._webSocketMessages[0].data).toBe("hello [已隐藏]");
    const sse = buildHarEntry({ entry: { ...entry, type: "EventSource" }, detail: {}, body: {}, streamFrames: { kind: "sse", frames: [{ dir: "event", ts: 1, event: "tick", eventId: "9", length: 3, text: "abc" }] } });
    expect(sse._serverSentEvents[0]).toMatchObject({ event: "tick", id: "9", data: "abc" });
  });
});

describe("buildHar：HAR 1.2 结构与体积上限", () => {
  const mkEntry = (i: number, size = 10) =>
    buildHarEntry({ entry: { id: i, ts: 1_700_000_000_000 + i, method: "GET", url: `https://a.test/${i}`, status: 200, type: "Fetch", durationMs: 5 }, detail: { mimeType: "text/plain" }, body: { response: { ok: true, body: "x".repeat(size) } } });

  it("结构合法：log.version 1.2 / creator / entries；每条有 startedDateTime / time / request / response / cache / timings；JSON 可往返", () => {
    const built = buildHar({ entries: [mkEntry(1), mkEntry(2)] });
    const har = JSON.parse(built.text);
    expect(har.log.version).toBe("1.2");
    expect(har.log.creator).toMatchObject({ name: expect.any(String), version: expect.any(String) });
    expect(har.log.entries).toHaveLength(2);
    for (const e of har.log.entries) {
      expect(new Date(e.startedDateTime).toISOString()).toBe(e.startedDateTime);
      expect(typeof e.time).toBe("number");
      expect(e.request).toMatchObject({ method: "GET", httpVersion: expect.any(String), headers: expect.any(Array), queryString: expect.any(Array), cookies: [], headersSize: -1, bodySize: -1 });
      expect(e.response).toMatchObject({ status: 200, statusText: "OK", content: expect.objectContaining({ mimeType: "text/plain" }), redirectURL: "" });
      expect(e.cache).toEqual({});
      expect(e.timings).toMatchObject({ send: 0, wait: 5, receive: 0 });
    }
    expect(built).toMatchObject({ kept: 2, omitted: 0 });
    expect(built.bytes).toBe(Buffer.byteLength(built.text));
    expect(har.log.comment).toContain("脱敏");
  });

  it("超过体积上限：从最旧的条目开始丢并在 comment 注明；最新的一条一定保留", () => {
    const entries = Array.from({ length: 30 }, (_, i) => mkEntry(i + 1, 2000));
    const built = buildHar({ entries, maxBytes: 20_000 });
    expect(built.bytes).toBeLessThanOrEqual(20_000);
    expect(built.omitted).toBeGreaterThan(0);
    expect(built.kept + built.omitted).toBe(30);
    const har = JSON.parse(built.text);
    expect(har.log.entries.at(-1)._id).toBe(30);
    expect(har.log.entries[0]._id).toBe(30 - built.kept + 1);
    expect(har.log.comment).toContain("已丢弃最旧的");
  });
});

describe("HAR 落盘：路径主进程生成、0600 / 0700、自动收尾", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });
  const tmp = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "p4-har-"));
    dirs.push(d);
    return d;
  };

  it("harDirFor：固定在 <userData>/data/tasks/<taskId>/browser-har；taskId 不是安全字符 / userData 缺失 → null（绝不拼路径）", () => {
    expect(harDirFor("/u", "task-1")).toBe(path.join("/u", "data", "tasks", "task-1", HAR_DIR_NAME));
    for (const bad of ["../x", "a/b", "a\\b", "", "a b", "..", "a\u0000b", "x".repeat(201), undefined, null]) expect(harDirFor("/u", bad as never)).toBeNull();
    expect(harDirFor("", "t")).toBeNull();
    expect(harDirFor(undefined as never, "t")).toBeNull();
  });

  it("harBaseName：net-时间戳[-主机名]，主机名只留 [a-z0-9.-]，不接受调用方传名", () => {
    const d = new Date(2026, 10, 9, 8, 7, 6);
    expect(harBaseName(d, "https://Api.Example.com/x")).toBe("net-20261109-080706-api.example.com");
    expect(harBaseName(d, "not a url")).toBe("net-20261109-080706");
    const name = harBaseName(d, "https://evil.test/../../etc/passwd");
    expect(name).not.toContain("/");
    expect(name).not.toContain("..passwd");
    expect(harBaseName(d, `https://${"a".repeat(80)}.test/`).length).toBeLessThan(70);
  });

  it.skipIf(process.platform === "win32")("写文件 0600、目录 0700；已存在不覆盖（加 -2 后缀）；没有残留临时文件", () => {
    const dir = path.join(tmp(), "browser-har");
    const text = JSON.stringify({ log: { version: "1.2" } });
    const a = writeHarFile({ dir, base: "net-x", text });
    const b = writeHarFile({ dir, base: "net-x", text });
    expect(a.file).toBe("net-x.har");
    expect(b.file).toBe("net-x-2.har");
    expect(fs.statSync(a.path).mode & 0o777).toBe(0o600);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    expect(a.bytes).toBe(Buffer.byteLength(text));
  });

  it("目录是符号链接 / 内容超过上限 → 拒绝写入", () => {
    const root = tmp();
    const real = path.join(root, "real");
    fs.mkdirSync(real);
    const link = path.join(root, "link");
    fs.symlinkSync(real, link);
    expect(() => writeHarFile({ dir: link, base: "n", text: "{}" })).toThrow(/符号链接/);
    expect(fs.readdirSync(real)).toEqual([]);
    expect(() => writeHarFile({ dir: path.join(root, "d"), base: "n", text: "x".repeat(100), maxBytes: 50 })).toThrow(/上限/);
  });

  it("pruneHarDir：只动普通 .har 文件；保留最新 HAR_KEEP_FILES 个且不超过 7 天", () => {
    const dir = tmp();
    const now = Date.now();
    for (let i = 0; i < HAR_KEEP_FILES + 4; i += 1) {
      const p = path.join(dir, `f${i}.har`);
      fs.writeFileSync(p, "{}");
      fs.utimesSync(p, new Date(now - i * 1000), new Date(now - i * 1000));
    }
    const old = path.join(dir, "old.har");
    fs.writeFileSync(old, "{}");
    fs.utimesSync(old, new Date(now - 30 * 86400_000), new Date(now - 30 * 86400_000));
    fs.writeFileSync(path.join(dir, "keep.txt"), "not har");
    const removed = pruneHarDir({ dir, now });
    expect(removed).toBe(4 + 1);
    const left = fs.readdirSync(dir);
    expect(left.filter((f) => f.endsWith(".har"))).toHaveLength(HAR_KEEP_FILES);
    expect(left).toContain("keep.txt");
    expect(left).not.toContain("old.har");
    expect(pruneHarDir({ dir: path.join(dir, "nope") })).toBe(0);
  });
});
