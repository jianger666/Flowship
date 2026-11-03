/**
 * `/api/local-media`（本地音视频 HTTP 通道）行为测试
 *
 * 直接调路由导出的 GET / HEAD（= serveLocalMedia），用 `new Request(...)` 造请求、临时目录里造假文件。
 * 覆盖：整段 200 / Range 206 / 416 / If-Range / If-None-Match 304 / HEAD / 路径守卫 / 大文件不进内存 / 客户端取消。
 *
 * 关于「流是否被销毁」的断言：用 vi.mock 包一层 `createReadStream`，把被测代码创建的 fs.ReadStream 记下来，
 * 之后直接看 `destroyed` / `closed` / `bytesRead`——比盯进程句柄数稳定得多。
 */
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import type { ReadStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { GET, HEAD, dynamic, runtime } from "@/app/api/local-media/route";
import { resolveLocalMediaFile, serveLocalMedia } from "@/lib/server/local-media";
import { UNC_REJECT_MESSAGE } from "@/lib/unc-path";

// 记录被测代码创建的所有文件读流（透传，不改行为）
const createdStreams = vi.hoisted(() => [] as ReadStream[]);
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const createReadStream: typeof actual.createReadStream = (...args) => {
    const stream = actual.createReadStream(...args);
    createdStreams.push(stream);
    return stream;
  };
  // node:fs 的 ESM 命名空间类型里没有 default 字段，但运行时有（CJS 互操作）；两处都换成包了记录的版本
  const actualDefault = (actual as unknown as { default: typeof actual }).default;
  return { ...actual, createReadStream, default: { ...actualDefault, createReadStream } };
});

const BASE = "http://127.0.0.1:3000/api/local-media";
const urlFor = (p: string): string => `${BASE}?path=${encodeURIComponent(p)}`;

const get = (p: string, headers?: Record<string, string>, signal?: AbortSignal): Promise<Response> =>
  GET(new Request(urlFor(p), { headers, signal }));
const head = (p: string, headers?: Record<string, string>): Promise<Response> =>
  HEAD(new Request(urlFor(p), { method: "HEAD", headers }));

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const hex = (buf: ArrayBuffer | Uint8Array | Buffer): string => Buffer.from(buf as Uint8Array).toString("hex");

const headersOf = (res: Response): Record<string, string> => Object.fromEntries(res.headers.entries());

/** 轮询等条件成立；超时就带上说明让用例失败 */
const waitFor = async (cond: () => boolean, what: string, timeoutMs = 2000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`等待超时：${what}`);
    await sleep(5);
  }
};

/** 读端「不挂起」：reader.read() 在限定时间内要么出结果要么抛错，都算 settled */
const settlesWithin = async (p: Promise<unknown>, ms = 2000): Promise<boolean> =>
  Promise.race([p.then(() => true, () => true), sleep(ms).then(() => false)]);

/** 监听进程级未处理异常；用例末尾断言 seen 为空 */
const watchProcessErrors = () => {
  const seen: unknown[] = [];
  const onRejection = (reason: unknown) => seen.push(reason);
  const onException = (err: unknown) => seen.push(err);
  process.on("unhandledRejection", onRejection);
  process.on("uncaughtException", onException);
  return {
    seen,
    stop: () => {
      process.off("unhandledRejection", onRejection);
      process.off("uncaughtException", onException);
    },
  };
};

/** 采样进程 RSS 峰值：与实现无关地断言「没把大文件读进内存」（整文件读入会涨几百 MB） */
const trackPeakRss = () => {
  const baseline = process.memoryUsage.rss();
  let max = baseline;
  const timer = setInterval(() => {
    max = Math.max(max, process.memoryUsage.rss());
  }, 2);
  timer.unref();
  return {
    /** 停止采样，返回相对起点的 RSS 峰值增长（字节） */
    stop: (): number => {
      clearInterval(timer);
      max = Math.max(max, process.memoryUsage.rss());
      return max - baseline;
    },
  };
};

const lastStream = (): ReadStream => {
  const s = createdStreams.at(-1);
  if (!s) throw new Error("被测代码没有创建文件流");
  return s;
};

/** 确定性内容：第 i 字节 = (i*7+3) % 251，任意两段切片基本不会撞 */
const patternBytes = (size: number): Buffer =>
  Buffer.from(Array.from({ length: size }, (_, i) => (i * 7 + 3) % 251));

const SIZE = 1000;
const FULL = patternBytes(SIZE);
const MTIME = new Date("2024-01-02T03:04:05.000Z");
const LAST_MODIFIED = "Tue, 02 Jan 2024 03:04:05 GMT";

let root = "";
const p = (...segs: string[]): string => path.join(root, ...segs);

let clip = ""; // 1000 字节的标准 mp4
let etag = "";

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "fvt-media-"));

  clip = p("clip.mp4");
  await fs.writeFile(clip, FULL);
  await fs.utimes(clip, MTIME, MTIME);
  etag = `"${SIZE}-${Math.floor((await fs.stat(clip)).mtimeMs)}"`;

  // 零字节
  await fs.writeFile(p("empty.mp4"), "");
  // 非白名单扩展名（内容故意是「机密」，守卫失效就会被读出来）
  for (const name of ["note.txt", "pic.svg", "code.ts", "movie.mkv", "noext", "clip.mp4.txt"]) {
    await fs.writeFile(p(name), "SECRET");
  }
  // 目录冒充媒体文件
  await fs.mkdir(p("dir.mp4"));
  // 软链
  await fs.symlink(p("note.txt"), p("link-secret.mp4"));
  await fs.symlink(clip, p("link-clip.mp4"));
  await fs.writeFile(p("real.mov"), FULL);
  await fs.symlink(p("real.mov"), p("link-to-mov.mp4"));
  await fs.symlink(p("dir.mp4"), p("link-dir.mp4"));
  await fs.symlink(p("no-such-target.mp4"), p("link-dangling.mp4"));
  // 特殊文件名
  await fs.writeFile(p("测试 视频 #1 (最终版).mp4"), FULL);
  // 大小写扩展名
  await fs.writeFile(p("UPPER.MP4"), FULL);
  await fs.writeFile(p("Mixed.Mp3"), FULL);
});

afterAll(async () => {
  // 只删自己创建的这一个目录（精确路径）
  if (root) await fs.rm(root, { recursive: true, force: true });
});

beforeEach(() => {
  createdStreams.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("路由壳", () => {
  it("导出 GET / HEAD，运行时 nodejs、force-dynamic", () => {
    expect(typeof GET).toBe("function");
    expect(typeof HEAD).toBe("function");
    expect(runtime).toBe("nodejs");
    expect(dynamic).toBe("force-dynamic");
  });

  it("GET / HEAD 都是 serveLocalMedia 的直通（同一请求同一结果）", async () => {
    const req = () => new Request(urlFor(clip), { headers: { range: "bytes=1-3" } });
    const a = await GET(req());
    const b = await serveLocalMedia(req());
    expect(a.status).toBe(b.status);
    expect(headersOf(a)).toEqual(headersOf(b));
    expect(hex(await a.arrayBuffer())).toBe(hex(await b.arrayBuffer()));
  });
});

describe("resolveLocalMediaFile", () => {
  it("返回 realpath + 文件事实", async () => {
    const r = await resolveLocalMediaFile(clip);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.file.real).toBe(await fs.realpath(clip));
    expect(r.file.size).toBe(SIZE);
    expect(r.file.ext).toBe("mp4");
    expect(r.file.mime).toBe("video/mp4");
    expect(r.file.kind).toBe("video");
    expect(r.file.etag).toBe(etag);
    expect(r.file.lastModified).toBe(LAST_MODIFIED);
  });

  it("首尾空白会被裁掉", async () => {
    const r = await resolveLocalMediaFile(`  ${clip}\n`);
    expect(r.ok).toBe(true);
  });

  it("音频扩展名 kind=audio", async () => {
    const r = await resolveLocalMediaFile(p("Mixed.Mp3"));
    expect(r.ok && r.file.kind).toBe("audio");
    expect(r.ok && r.file.ext).toBe("mp3");
  });

  it("软链：real 是链接目标的真实路径", async () => {
    const r = await resolveLocalMediaFile(p("link-clip.mp4"));
    expect(r.ok && r.file.real).toBe(await fs.realpath(clip));
  });

  it("失败结果带 status + error", async () => {
    expect(await resolveLocalMediaFile("")).toMatchObject({ ok: false, status: 400 });
    expect(await resolveLocalMediaFile(p("nope.mp4"))).toMatchObject({ ok: false, status: 404 });
    const unc = await resolveLocalMediaFile("//host/share/a.mp4");
    expect(unc).toMatchObject({ ok: false, status: 400, error: expect.stringContaining(UNC_REJECT_MESSAGE) });
  });
});

describe("整段 200", () => {
  it("状态码 / 头 / 字节全对", async () => {
    const res = await get(clip);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("video/mp4");
    expect(res.headers.get("content-length")).toBe(String(SIZE));
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(res.headers.get("etag")).toBe(etag);
    expect(res.headers.get("last-modified")).toBe(LAST_MODIFIED);
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-range")).toBeNull();
    expect(hex(await res.arrayBuffer())).toBe(hex(FULL));
  });

  it("不发 CORS 头", async () => {
    const res = await get(clip, { origin: "https://evil.example" });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    await res.arrayBuffer();
  });

  it("ETag 是强校验器（不带 W/）且随内容 / mtime 变化", async () => {
    const f = p("etag-change.mp4");
    await fs.writeFile(f, "aaaa");
    await fs.utimes(f, MTIME, MTIME);
    const first = (await head(f)).headers.get("etag");
    expect(first).toMatch(/^"\d+-\d+"$/);
    await fs.writeFile(f, "aaaaa"); // 大小变
    await fs.utimes(f, MTIME, MTIME);
    const second = (await head(f)).headers.get("etag");
    expect(second).not.toBe(first);
    const later = new Date(MTIME.getTime() + 5000);
    await fs.utimes(f, later, later); // mtime 变
    const third = (await head(f)).headers.get("etag");
    expect(third).not.toBe(second);
  });

  it.each([
    ["mp4", "video/mp4"],
    ["m4v", "video/mp4"],
    ["mov", "video/quicktime"],
    ["webm", "video/webm"],
    ["mp3", "audio/mpeg"],
    ["m4a", "audio/mp4"],
    ["aac", "audio/aac"],
    ["wav", "audio/wav"],
    ["flac", "audio/flac"],
    ["ogg", "audio/ogg"],
    ["opus", "audio/ogg"],
  ])("扩展名 .%s → Content-Type %s", async (ext, mime) => {
    const f = p(`kind-${ext}.${ext}`);
    await fs.writeFile(f, "xyz");
    const res = await get(f);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(mime);
    expect(await res.text()).toBe("xyz");
  });

  it("扩展名大小写不敏感（.MP4 / .Mp3）", async () => {
    const a = await get(p("UPPER.MP4"));
    expect(a.status).toBe(200);
    expect(a.headers.get("content-type")).toBe("video/mp4");
    expect(hex(await a.arrayBuffer())).toBe(hex(FULL));
    const b = await get(p("Mixed.Mp3"));
    expect(b.status).toBe(200);
    expect(b.headers.get("content-type")).toBe("audio/mpeg");
    await b.arrayBuffer();
  });

  it("文件名带中文 / 空格 / # / 括号（URL 编码往返）", async () => {
    const res = await get(p("测试 视频 #1 (最终版).mp4"));
    expect(res.status).toBe(200);
    expect(hex(await res.arrayBuffer())).toBe(hex(FULL));
  });

  it("首尾带空白的 path 参数也能服务", async () => {
    const res = await GET(new Request(`${BASE}?path=${encodeURIComponent(` ${clip} `)}`));
    expect(res.status).toBe(200);
    await res.arrayBuffer();
  });
});

describe("Range", () => {
  // [Range 头, 起, 止]（闭区间）
  const OK_RANGES: Array<[string, number, number]> = [
    ["bytes=0-9", 0, 9],
    ["bytes=10-", 10, 999],
    ["bytes=-5", 995, 999],
    ["bytes=990-5000", 990, 999], // end 超界 → 截到最后一个字节
    ["bytes=0-1000000", 0, 999],
    ["bytes=0-999", 0, 999],
    ["bytes=0-0", 0, 0],
    ["bytes=999-999", 999, 999],
    ["bytes=999-", 999, 999],
    ["bytes=-1", 999, 999],
    ["bytes=-1000", 0, 999],
    ["bytes=-5000", 0, 999], // 尾部 N 超过文件大小 → 整段（仍是 206）
    ["Bytes=0-9", 0, 9], // 单位大小写不敏感
  ];

  it.each(OK_RANGES)("%s → 206，Content-Range / Content-Length / 字节正确", async (range, start, end) => {
    const res = await get(clip, { range });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe(`bytes ${start}-${end}/${SIZE}`);
    expect(res.headers.get("content-length")).toBe(String(end - start + 1));
    expect(res.headers.get("content-type")).toBe("video/mp4");
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(res.headers.get("etag")).toBe(etag);
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    const body = await res.arrayBuffer();
    expect(body.byteLength).toBe(end - start + 1);
    expect(hex(body)).toBe(hex(FULL.subarray(start, end + 1)));
  });

  // 起点越界 / 后缀长度 0：语法对但不可满足 → 416
  it.each(["bytes=1000-", "bytes=1000-2000", "bytes=5000-", "bytes=99999-100000", "bytes=-0"])(
    "%s → 416，Content-Range: bytes */size，无 body",
    async (range) => {
      const res = await get(clip, { range });
      expect(res.status).toBe(416);
      expect(res.headers.get("content-range")).toBe(`bytes */${SIZE}`);
      expect(res.body).toBeNull();
      expect(await res.text()).toBe("");
      expect(res.headers.get("accept-ranges")).toBe("bytes");
    },
  );

  // 多段 / 语法错误：一律当没带 Range → 200 整段
  it.each([
    "bytes=0-9,20-29",
    "bytes=0-9, 20-29",
    "bytes=abc",
    "bytes=",
    "bytes=-",
    "bytes=9-0",
    "bytes=-5-",
    "bytes=1.5-3",
    "bytes= 0-9",
    "bytes=0 -9",
    "items=0-9",
    "0-9",
    "bytes",
  ])("%j → 当没带：200 整段", async (range) => {
    const res = await get(clip, { range });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-range")).toBeNull();
    expect(res.headers.get("content-length")).toBe(String(SIZE));
    expect(hex(await res.arrayBuffer())).toBe(hex(FULL));
  });

  it("同一文件连续多次不同 Range 互不影响", async () => {
    for (const [range, start, end] of OK_RANGES.slice(0, 5)) {
      const res = await get(clip, { range });
      expect(hex(await res.arrayBuffer()), range).toBe(hex(FULL.subarray(start, end + 1)));
    }
  });

  it("软链路径 + Range", async () => {
    const res = await get(p("link-clip.mp4"), { range: "bytes=2-4" });
    expect(res.status).toBe(206);
    expect(hex(await res.arrayBuffer())).toBe(hex(FULL.subarray(2, 5)));
  });
});

describe("If-Range / If-None-Match", () => {
  it("If-Range = 当前 ETag → 按 Range 返回 206", async () => {
    const res = await get(clip, { range: "bytes=0-9", "if-range": etag });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe(`bytes 0-9/${SIZE}`);
    expect(hex(await res.arrayBuffer())).toBe(hex(FULL.subarray(0, 10)));
  });

  it("If-Range = 旧 ETag → 忽略 Range，200 整段", async () => {
    const res = await get(clip, { range: "bytes=0-9", "if-range": `"999-1"` });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-range")).toBeNull();
    expect(res.headers.get("content-length")).toBe(String(SIZE));
    expect(hex(await res.arrayBuffer())).toBe(hex(FULL));
  });

  it("If-Range 不匹配 + 起点越界的 Range：也忽略 Range → 200，而不是 416", async () => {
    const res = await get(clip, { range: "bytes=5000-", "if-range": `"stale"` });
    expect(res.status).toBe(200);
    await res.arrayBuffer();
  });

  it("If-Range 匹配 + 起点越界 → 416", async () => {
    const res = await get(clip, { range: "bytes=5000-", "if-range": etag });
    expect(res.status).toBe(416);
  });

  it("If-Range = 弱 ETag（W/）→ 无效，200 整段", async () => {
    const res = await get(clip, { range: "bytes=0-9", "if-range": `W/${etag}` });
    expect(res.status).toBe(200);
    await res.arrayBuffer();
  });

  it("If-Range = Last-Modified 日期：一致 → 206；不一致 → 200", async () => {
    const ok = await get(clip, { range: "bytes=0-9", "if-range": LAST_MODIFIED });
    expect(ok.status).toBe(206);
    await ok.arrayBuffer();
    const stale = await get(clip, { range: "bytes=0-9", "if-range": "Mon, 01 Jan 2024 00:00:00 GMT" });
    expect(stale.status).toBe(200);
    expect(stale.headers.get("content-range")).toBeNull();
    await stale.arrayBuffer();
  });

  it("没有 Range 时 If-Range 无作用", async () => {
    const res = await get(clip, { "if-range": `"stale"` });
    expect(res.status).toBe(200);
    await res.arrayBuffer();
  });

  it("文件改了之后，用旧 ETag 做 If-Range 拿到的是新文件整段", async () => {
    const f = p("rewritten.mp4");
    await fs.writeFile(f, "old-content-old");
    await fs.utimes(f, MTIME, MTIME);
    const oldEtag = (await head(f)).headers.get("etag") as string;
    await fs.writeFile(f, "NEW-content-NEW!");
    await fs.utimes(f, MTIME, MTIME);
    const res = await get(f, { range: "bytes=0-2", "if-range": oldEtag });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("NEW-content-NEW!");
  });

  it("If-None-Match 命中 → 304，无 body，带校验头", async () => {
    const res = await get(clip, { "if-none-match": etag });
    expect(res.status).toBe(304);
    expect(res.body).toBeNull();
    expect(await res.text()).toBe("");
    expect(res.headers.get("etag")).toBe(etag);
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(res.headers.get("last-modified")).toBe(LAST_MODIFIED);
    expect(createdStreams).toHaveLength(0); // 304 不该打开文件
  });

  it.each([
    ["*", "通配"],
    ["W/{etag}", "弱标记前缀"],
    [`"other", {etag}`, "逗号列表里命中一个"],
  ])("If-None-Match %s（%s）→ 304", async (tpl) => {
    const res = await get(clip, { "if-none-match": tpl.replace("{etag}", etag) });
    expect(res.status).toBe(304);
  });

  it("If-None-Match 不命中 → 正常 200", async () => {
    const res = await get(clip, { "if-none-match": `"1-1"` });
    expect(res.status).toBe(200);
    expect(hex(await res.arrayBuffer())).toBe(hex(FULL));
  });

  it("If-None-Match 命中优先于 Range → 304", async () => {
    const res = await get(clip, { "if-none-match": etag, range: "bytes=0-9" });
    expect(res.status).toBe(304);
    expect(res.headers.get("content-range")).toBeNull();
  });

  it("If-None-Match 不命中 + Range → 206", async () => {
    const res = await get(clip, { "if-none-match": `"1-1"`, range: "bytes=0-9" });
    expect(res.status).toBe(206);
    await res.arrayBuffer();
  });
});

describe("HEAD", () => {
  // GET 与 HEAD 同一组请求头 → 状态码、头完全一致；HEAD 无 body、不开文件流
  // 注意：it.each 的表在收集阶段就求值，那时 beforeAll 还没跑——路径 / etag 一律用函数惰性取
  const CASES: Array<[string, () => string, () => Record<string, string>]> = [
    ["整段 200", () => clip, () => ({})],
    ["206 区间", () => clip, () => ({ range: "bytes=10-19" })],
    ["206 后缀", () => clip, () => ({ range: "bytes=-5" })],
    ["416", () => clip, () => ({ range: "bytes=5000-" })],
    ["304", () => clip, () => ({ "if-none-match": etag })],
    ["If-Range 不匹配 → 200", () => clip, () => ({ range: "bytes=0-9", "if-range": `"stale"` })],
    ["If-Range 匹配 → 206", () => clip, () => ({ range: "bytes=0-9", "if-range": etag })],
    ["零字节文件 200", () => p("empty.mp4"), () => ({})],
    ["多段 Range 当没带", () => clip, () => ({ range: "bytes=0-1,5-6" })],
  ];

  it.each(CASES)("%s：头与 GET 一致，HEAD 无 body", async (_name, fileOf, headersFn) => {
    const file = fileOf();
    const headers = headersFn();
    const g = await get(file, headers);
    const gBody = await g.arrayBuffer();
    createdStreams.length = 0;
    const h = await head(file, headers);
    expect(h.status).toBe(g.status);
    expect(headersOf(h)).toEqual(headersOf(g));
    expect(h.body).toBeNull();
    expect(await h.text()).toBe("");
    expect(createdStreams).toHaveLength(0);
    // 有 Content-Length 的 GET：HEAD 报的长度就是 GET 实际给的字节数
    const len = g.headers.get("content-length");
    if (len !== null) expect(Number(len)).toBe(gBody.byteLength);
  });

  it("206 的 HEAD：Content-Range / Content-Length 正确", async () => {
    const h = await head(clip, { range: "bytes=100-199" });
    expect(h.status).toBe(206);
    expect(h.headers.get("content-range")).toBe(`bytes 100-199/${SIZE}`);
    expect(h.headers.get("content-length")).toBe("100");
  });

  it("HEAD 整段：Content-Length = 文件大小、ETag 可供「文件是否重新生成」探测", async () => {
    const h = await head(clip);
    expect(h.status).toBe(200);
    expect(h.headers.get("content-length")).toBe(String(SIZE));
    expect(h.headers.get("etag")).toBe(etag);
  });

  it("HEAD 的守卫与 GET 同口径（404 / 400）", async () => {
    expect((await head(p("nope.mp4"))).status).toBe(404);
    expect((await head(p("note.txt"))).status).toBe(400);
    expect((await head("//host/share/a.mp4")).status).toBe(400);
  });
});

describe("路径守卫", () => {
  it("path 为空 / 缺失 / 全空白 → 400", async () => {
    expect((await GET(new Request(`${BASE}?path=`))).status).toBe(400);
    expect((await GET(new Request(BASE))).status).toBe(400);
    expect((await get("   ")).status).toBe(400);
  });

  it.each(["a.mp4", "./a.mp4", "../a.mp4", "sub/a.mp4", "~/a.mp4", "file:///tmp/a.mp4", "http://127.0.0.1/a.mp4"])(
    "相对路径 / 非路径 %j → 400",
    async (raw) => {
      const res = await get(raw);
      expect(res.status).toBe(400);
    },
  );

  it("相对路径即使命中 cwd 下真实文件也不服务", async () => {
    const rel = path.relative(process.cwd(), clip);
    expect((await get(rel)).status).toBe(400);
  });

  it.each([
    "//host/share/a.mp4",
    "\\\\host\\share\\a.mp4",
    "\\/host/share/a.mp4",
    "/\\host\\share\\a.mp4",
    "///host/share/a.mp4",
    "\\\\?\\UNC\\host\\share\\a.mp4",
    "file:////host/share/a.mp4",
    "file://host/share/a.mp4",
  ])("UNC / 网络共享 %j → 400，且文案是 UNC 提示", async (raw) => {
    const res = await get(raw);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain(UNC_REJECT_MESSAGE);
  });

  it("UNC / 相对路径 / 扩展名不合法：在碰文件系统（realpath）之前就拒", async () => {
    const spy = vi.spyOn(fs, "realpath");
    for (const raw of ["", "//host/share/a.mp4", "\\\\host\\share\\a.mp4", "rel/a.mp4", p("note.txt")]) {
      await get(raw);
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it.each(["note.txt", "pic.svg", "code.ts", "movie.mkv", "noext", "clip.mp4.txt"])(
    "非白名单扩展名 %s（文件真实存在）→ 400，不泄露内容",
    async (name) => {
      const res = await get(p(name));
      expect(res.status).toBe(400);
      const text = await res.text();
      expect(text).not.toContain("SECRET");
      expect(createdStreams).toHaveLength(0);
    },
  );

  it("错误响应是 JSON，Cache-Control: no-store", async () => {
    const res = await get(p("note.txt"));
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(typeof ((await res.json()) as { error: unknown }).error).toBe("string");
  });

  it("不存在 → 404", async () => {
    const res = await get(p("nope.mp4"));
    expect(res.status).toBe(404);
  });

  it("路径里含 NUL 字符 → 4xx（不是 500 / 不抛）", async () => {
    const res = await get(`${p("clip")}\0.mp4`);
    expect([400, 404]).toContain(res.status);
  });

  it("目录（叫 dir.mp4）→ 404", async () => {
    const res = await get(p("dir.mp4"));
    expect(res.status).toBe(404);
    expect(createdStreams).toHaveLength(0);
  });

  it("软链指到目录 → 404", async () => {
    expect((await get(p("link-dir.mp4"))).status).toBe(404);
  });

  it("悬空软链 → 404", async () => {
    expect((await get(p("link-dangling.mp4"))).status).toBe(404);
  });

  it("软链（叫 .mp4）指到非媒体文件 → 404，不泄露内容", async () => {
    const res = await get(p("link-secret.mp4"));
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("SECRET");
    expect(createdStreams).toHaveLength(0);
  });

  it("软链指到真媒体文件 → 正常服务", async () => {
    const res = await get(p("link-clip.mp4"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("video/mp4");
    expect(hex(await res.arrayBuffer())).toBe(hex(FULL));
  });

  it("软链名是 .mp4、目标是 .mov：以真实文件为准（Content-Type = video/quicktime）", async () => {
    const res = await get(p("link-to-mov.mp4"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("video/quicktime");
    await res.arrayBuffer();
  });

  it("路径里带 `..` 回绕（dir/../file）：按真实路径判，仍受扩展名白名单约束", async () => {
    expect((await get(`${p("dir.mp4")}/../note.txt`)).status).toBe(400);
    const ok = await get(`${p("dir.mp4")}/../clip.mp4`);
    expect(ok.status).toBe(200);
    await ok.arrayBuffer();
  });

  it.skipIf(process.platform === "win32")("命名管道（叫 pipe.mp4）→ 404，不挂起", async () => {
    const fifo = p("pipe.mp4");
    execFileSync("mkfifo", [fifo]);
    const res = await get(fifo);
    expect(res.status).toBe(404);
    expect(createdStreams).toHaveLength(0);
  });

  describe("零字节文件", () => {
    it("200，空 body，Content-Length: 0，不开文件流", async () => {
      const res = await get(p("empty.mp4"));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-length")).toBe("0");
      expect(res.headers.get("content-type")).toBe("video/mp4");
      expect(await res.text()).toBe("");
      expect(createdStreams).toHaveLength(0);
    });

    it.each(["bytes=0-9", "bytes=0-", "bytes=-5", "bytes=0-0"])("带 Range %s → 416，bytes */0", async (range) => {
      const res = await get(p("empty.mp4"), { range });
      expect(res.status).toBe(416);
      expect(res.headers.get("content-range")).toBe("bytes */0");
      expect(await res.text()).toBe("");
    });

    it("HEAD 同样是 200 + Content-Length: 0", async () => {
      const res = await head(p("empty.mp4"));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-length")).toBe("0");
    });
  });
});

describe("大文件不进内存", () => {
  const BIG = 600 * 1024 * 1024;
  const MARK_HEAD = Buffer.from("HEAD-MARK");
  const MARK_MID = Buffer.from("MID-MARK!");
  const MARK_TAIL = Buffer.from("TAIL-MARK");
  const MID_POS = Math.floor(BIG / 2);
  const TAIL_POS = BIG - MARK_TAIL.length;
  let big = "";

  beforeAll(async () => {
    big = p("big-sparse.mp4");
    const fh = await fs.open(big, "w");
    try {
      await fh.truncate(BIG); // 稀疏文件：只占几个块
      await fh.write(MARK_HEAD, 0, MARK_HEAD.length, 0);
      await fh.write(MARK_MID, 0, MARK_MID.length, MID_POS);
      await fh.write(MARK_TAIL, 0, MARK_TAIL.length, TAIL_POS);
    } finally {
      await fh.close();
    }
  });

  afterAll(async () => {
    // 测完立刻删（afterAll 的整目录清理是第二道保险）
    if (big) await fs.rm(big, { force: true });
  });

  it("Range 取头 / 中 / 尾：内容正确、耗时短、只读了请求的字节、进程内存没涨", async () => {
    const rss = trackPeakRss();
    const t0 = performance.now();
    const cases: Array<[number, Buffer]> = [
      [0, MARK_HEAD],
      [MID_POS, MARK_MID],
      [TAIL_POS, MARK_TAIL],
    ];
    for (const [start, mark] of cases) {
      createdStreams.length = 0;
      const end = start + mark.length - 1;
      const res = await get(big, { range: `bytes=${start}-${end}` });
      expect(res.status).toBe(206);
      expect(res.headers.get("content-range")).toBe(`bytes ${start}-${end}/${BIG}`);
      expect(res.headers.get("content-length")).toBe(String(mark.length));
      expect(Buffer.from(await res.arrayBuffer()).toString()).toBe(mark.toString());
      // 文件流只读了这几个字节，不是整个文件
      expect(lastStream().bytesRead).toBe(mark.length);
    }
    expect(performance.now() - t0).toBeLessThan(2000);
    // 600MB 的文件整个读进内存会让 RSS 涨几百 MB；流式读只会涨一点点缓冲
    expect(rss.stop()).toBeLessThan(200 * 1024 * 1024);
  });

  it("后缀 Range（bytes=-9）与开放区间（bytes=N-）取尾部", async () => {
    const a = await get(big, { range: "bytes=-9" });
    expect(a.status).toBe(206);
    expect(Buffer.from(await a.arrayBuffer()).toString()).toBe(MARK_TAIL.toString());
    const b = await get(big, { range: `bytes=${TAIL_POS}-` });
    expect(b.status).toBe(206);
    expect(Buffer.from(await b.arrayBuffer()).toString()).toBe(MARK_TAIL.toString());
  });

  it("HEAD / 304 / 416：只看元信息，不开文件流、Content-Length 是真实大小", async () => {
    const h = await head(big);
    expect(h.status).toBe(200);
    expect(h.headers.get("content-length")).toBe(String(BIG));
    const etag304 = h.headers.get("etag") as string;
    expect((await get(big, { "if-none-match": etag304 })).status).toBe(304);
    const r416 = await get(big, { range: `bytes=${BIG}-` });
    expect(r416.status).toBe(416);
    expect(r416.headers.get("content-range")).toBe(`bytes */${BIG}`);
    expect(createdStreams).toHaveLength(0);
  });

  it("整段 GET：分块流式，读第一块后取消，只读了很小一部分", async () => {
    const rss = trackPeakRss();
    const res = await get(big);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe(String(BIG));
    const stream = lastStream();
    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    // 第一块只是一小段（不会把 600MB 一次交出来）
    expect(first.value!.byteLength).toBeGreaterThan(0);
    expect(first.value!.byteLength).toBeLessThanOrEqual(1024 * 1024);
    expect(Buffer.from(first.value!.subarray(0, MARK_HEAD.length)).toString()).toBe(MARK_HEAD.toString());
    await reader.cancel();
    await waitFor(() => stream.closed, "取消后文件流应已关闭");
    expect(stream.bytesRead).toBeLessThan(16 * 1024 * 1024);
    expect(rss.stop()).toBeLessThan(200 * 1024 * 1024);
  });
});

describe("客户端取消", () => {
  const CANCEL_SIZE = 64 * 1024 * 1024;
  let cancelFile = "";
  let guard: ReturnType<typeof watchProcessErrors>;

  beforeAll(async () => {
    cancelFile = p("cancel-sparse.mp4");
    const fh = await fs.open(cancelFile, "w");
    try {
      await fh.truncate(CANCEL_SIZE);
    } finally {
      await fh.close();
    }
  });

  beforeEach(() => {
    guard = watchProcessErrors();
  });

  afterEach(async () => {
    // 让可能的未处理 rejection / 异常有机会冒出来
    await sleep(50);
    await new Promise<void>((r) => setImmediate(r));
    guard.stop();
  });

  it("读一块后 AbortController.abort()：文件流被销毁并关闭、读端不挂起、无未处理异常", async () => {
    const ac = new AbortController();
    const res = await get(cancelFile, undefined, ac.signal);
    expect(res.status).toBe(200);
    const stream = lastStream();
    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(stream.destroyed).toBe(false);

    ac.abort();

    await waitFor(() => stream.destroyed, "abort 后文件流应被销毁");
    await waitFor(() => stream.closed, "abort 后文件句柄应被关闭");
    expect(await settlesWithin(reader.read())).toBe(true);
    await sleep(50);
    expect(guard.seen).toEqual([]);
  });

  it("没读任何数据就 abort：同样销毁文件流", async () => {
    const ac = new AbortController();
    const res = await get(cancelFile, undefined, ac.signal);
    const stream = lastStream();
    ac.abort();
    await waitFor(() => stream.destroyed, "abort 后文件流应被销毁");
    await waitFor(() => stream.closed, "abort 后文件句柄应被关闭");
    expect(await settlesWithin(res.arrayBuffer())).toBe(true);
    await sleep(50);
    expect(guard.seen).toEqual([]);
  });

  it("读一块后 body.cancel()：文件流被销毁并关闭、无未处理异常", async () => {
    const res = await get(cancelFile);
    const stream = lastStream();
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel();
    await waitFor(() => stream.destroyed, "cancel 后文件流应被销毁");
    await waitFor(() => stream.closed, "cancel 后文件句柄应被关闭");
    await sleep(50);
    expect(guard.seen).toEqual([]);
  });

  it("完全没读就 res.body.cancel()", async () => {
    const res = await get(cancelFile);
    const stream = lastStream();
    await res.body!.cancel();
    await waitFor(() => stream.destroyed, "cancel 后文件流应被销毁");
    await waitFor(() => stream.closed, "cancel 后文件句柄应被关闭");
    await sleep(50);
    expect(guard.seen).toEqual([]);
  });

  it("signal 已经 aborted（客户端在服务端读盘间隙里断开）：不抛、不开文件、不挂起、无未处理异常", async () => {
    const ac = new AbortController();
    ac.abort();
    // 回归：曾经 new Response(已 cancel 的 web stream) 抛 TypeError → 路由 500
    const res = await get(cancelFile, undefined, ac.signal);
    expect(res.status).toBe(200);
    expect(createdStreams).toHaveLength(0);
    expect(await settlesWithin(res.arrayBuffer())).toBe(true);
    await sleep(50);
    expect(guard.seen).toEqual([]);
  });

  it("Range 请求也一样：signal 已 aborted 时不抛", async () => {
    const ac = new AbortController();
    ac.abort();
    const res = await get(cancelFile, { range: "bytes=10-19" }, ac.signal);
    expect(res.status).toBe(206);
    expect(createdStreams).toHaveLength(0);
    expect(await settlesWithin(res.arrayBuffer())).toBe(true);
  });

  it("206 区间读一半就 abort：同样销毁", async () => {
    const ac = new AbortController();
    const res = await get(cancelFile, { range: "bytes=1000-" }, ac.signal);
    expect(res.status).toBe(206);
    const stream = lastStream();
    const reader = res.body!.getReader();
    await reader.read();
    ac.abort();
    await waitFor(() => stream.destroyed, "abort 后文件流应被销毁");
    expect(await settlesWithin(reader.read())).toBe(true);
    await sleep(50);
    expect(guard.seen).toEqual([]);
  });

  it("读完整个响应之后再 abort：无副作用、无未处理异常", async () => {
    const ac = new AbortController();
    const res = await get(clip, undefined, ac.signal);
    expect(hex(await res.arrayBuffer())).toBe(hex(FULL));
    ac.abort();
    await sleep(20);
    expect(guard.seen).toEqual([]);
  });

  it("并发两个请求，取消其中一个不影响另一个读完", async () => {
    const acA = new AbortController();
    const resA = await get(clip, undefined, acA.signal);
    const streamA = lastStream();
    const resB = await get(clip);
    const streamB = lastStream();
    expect(streamB).not.toBe(streamA);
    acA.abort();
    await waitFor(() => streamA.destroyed, "A 应被销毁");
    expect(hex(await resB.arrayBuffer())).toBe(hex(FULL));
    expect(streamB.destroyed).toBe(true); // B 读完后自然结束
    await settlesWithin(resA.arrayBuffer());
    await sleep(20);
    expect(guard.seen).toEqual([]);
  });

  it("读到一半文件被截断：响应提前结束，不挂起、无未处理异常", async () => {
    const f = p("shrinking.mp4");
    const fh = await fs.open(f, "w");
    try {
      await fh.truncate(8 * 1024 * 1024);
    } finally {
      await fh.close();
    }
    const res = await get(f);
    const reader = res.body!.getReader();
    await reader.read();
    await fs.truncate(f, 0);
    const drain = (async () => {
      for (;;) {
        const r = await reader.read();
        if (r.done) return;
      }
    })();
    expect(await settlesWithin(drain, 3000)).toBe(true);
    await sleep(50);
    expect(guard.seen).toEqual([]);
  });

  it("底层文件流报错：只终止这条响应，读端不挂起、无未处理异常", async () => {
    const res = await get(cancelFile);
    const stream = lastStream();
    const reader = res.body!.getReader();
    await reader.read();
    stream.destroy(new Error("模拟读盘错误"));
    expect(await settlesWithin(reader.read())).toBe(true);
    await sleep(50);
    expect(guard.seen).toEqual([]);
  });
});
