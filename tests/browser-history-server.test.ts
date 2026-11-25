/**
 * 地址栏记忆落盘层（src/lib/server/browser-history.ts）：真实文件系统 + 每条用例独立的临时数据目录。
 * 钉死的行为：记一次访问（新增 / 同地址累加 / 空标题不冲掉旧标题 / 时间用服务端的）、满员淘汰最久没访问的、
 * 串行写不丢更新、坏文件（读路径当空、写路径先备份）、读不出来绝不当空列表去覆盖、userinfo 与坏标题不落盘、
 * 清空是真删（含坏文件）。
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HISTORY_LIMIT, HISTORY_TITLE_MAX, type HistoryEntry } from "@/lib/browser-history";
import {
  HISTORY_FILE,
  HistoryError,
  clearHistory,
  historyPath,
  isHistoryError,
  listHistory,
  recordHistoryVisit,
  removeHistoryEntry,
} from "@/lib/server/browser-history";

import { hist } from "./helpers/history-fake-fetch";

let dir: string;
const file = () => path.join(dir, HISTORY_FILE);
const readFileJson = () => JSON.parse(readFileSync(file(), "utf-8")) as { v: number; history: HistoryEntry[] };
const seed = (history: unknown[]) => writeFileSync(file(), JSON.stringify({ v: 1, history }), "utf-8");

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "fe-history-"));
  process.env.FLOWSHIP_DATA_DIR = dir;
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe("文件位置与空状态", () => {
  it("落在 <dataRoot>/browser-history.json（全局一份，不按任务分）", () => {
    expect(historyPath()).toBe(path.join(dir, "browser-history.json"));
  });

  it("文件不存在 = 空列表，且读取不会凭空建文件", async () => {
    expect(await listHistory()).toEqual([]);
    expect(existsSync(file())).toBe(false);
  });
});

describe("recordHistoryVisit", () => {
  it("新增：规整地址 + 清洗标题 + UUID id + 次数 1；写成 { v:1, history }，文件 0600", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(123_456);
    const { entry, created } = await recordHistoryVisit({ url: "https://Example.COM:443/a?b=1", title: "  Hello \n World  " });
    expect(created).toBe(true);
    expect(entry).toMatchObject({ url: "https://example.com/a?b=1", title: "Hello World", visitCount: 1, lastVisitAt: 123_456 });
    expect(entry.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(readFileJson()).toEqual({ v: 1, history: [entry] });
    if (process.platform !== "win32") expect(statSync(file()).mode & 0o777).toBe(0o600);
    expect(await listHistory()).toEqual([entry]);
  });

  it("没给标题 / 标题清洗后为空 → 用主机名", async () => {
    expect((await recordHistoryVisit({ url: "https://docs.example.com/x" })).entry.title).toBe("docs.example.com");
    expect((await recordHistoryVisit({ url: "https://b.example.com/x", title: "\u200B\u202E  \n" })).entry.title).toBe("b.example.com");
  });

  it("标题里的方向控制符 / 控制字符被剥掉，超长截断", async () => {
    const { entry } = await recordHistoryVisit({ url: "https://a.example/x", title: `evil\u202Etxt\u0007${"字".repeat(HISTORY_TITLE_MAX + 40)}` });
    expect(entry.title).not.toMatch(/[\u202E\u0007]/);
    expect(entry.title.length).toBe(HISTORY_TITLE_MAX + 1);
  });

  it("userinfo 不落盘：文件里找不到用户名和密码", async () => {
    const { entry } = await recordHistoryVisit({ url: "https://admin:hunter2@intranet.example.com/wiki", title: "wiki" });
    expect(entry.url).toBe("https://intranet.example.com/wiki");
    const raw = readFileSync(file(), "utf-8");
    expect(raw).not.toContain("hunter2");
    expect(raw).not.toContain("admin");
  });

  it("访问时间用服务端的现在（接口根本不接受客户端传时间）", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(777_000);
    const input = { url: "https://example.com/a", title: "t", lastVisitAt: 5, at: 5, createdAt: 5 } as Parameters<typeof recordHistoryVisit>[0];
    expect((await recordHistoryVisit(input)).entry.lastVisitAt).toBe(777_000);
  });

  it("同一个地址（规整后）再记 = 累加：不产生重复，id 不变，次数 +1，时间与标题刷新，顶到最前，created:false", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(10_000);
    const first = await recordHistoryVisit({ url: "https://example.com/a", title: "旧标题" });
    vi.setSystemTime(11_000);
    await recordHistoryVisit({ url: "https://other.example/b", title: "其它" });
    vi.setSystemTime(12_000);
    const again = await recordHistoryVisit({ url: "https://EXAMPLE.com:443/a", title: "新标题" });
    expect(again.created).toBe(false);
    expect(again.entry).toMatchObject({ id: first.entry.id, visitCount: 2, lastVisitAt: 12_000, title: "新标题" });
    const list = await listHistory();
    expect(list.map((e) => e.url)).toEqual(["https://example.com/a", "https://other.example/b"]);
    expect(list).toHaveLength(2);
  });

  it("再记时页面标题暂时为空（还在加载）：沿用原来的好标题，不冲成主机名", async () => {
    await recordHistoryVisit({ url: "https://example.com/a", title: "好标题" });
    expect((await recordHistoryVisit({ url: "https://example.com/a", title: "" })).entry.title).toBe("好标题");
    expect((await recordHistoryVisit({ url: "https://example.com/a" })).entry.title).toBe("好标题");
    expect((await listHistory())[0]!.visitCount).toBe(3);
  });

  it("列表最近访问的在最前；文件里也是这个顺序", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    for (const [i, name] of ["a", "b", "c"].entries()) {
      vi.setSystemTime(10_000 + i * 1000);
      await recordHistoryVisit({ url: `https://example.com/${name}`, title: name });
    }
    expect((await listHistory()).map((e) => e.title)).toEqual(["c", "b", "a"]);
    expect(readFileJson().history.map((e) => e.title)).toEqual(["c", "b", "a"]);
  });

  it("同一毫秒记的几条：后记的排在前面（时间戳并列时新的在前）", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(50_000);
    for (const name of ["a", "b", "c"]) await recordHistoryVisit({ url: `https://example.com/${name}`, title: name });
    expect((await listHistory()).map((e) => e.title)).toEqual(["c", "b", "a"]);
  });

  it("地址不可记录 → 拒绝（HistoryError invalid_url，带中文原因），文件原样", async () => {
    await recordHistoryVisit({ url: "https://keep.example/x", title: "keep" });
    const before = readFileSync(file(), "utf-8");
    for (const bad of ["javascript:alert(1)", "file:///etc/passwd", "about:blank", "chrome-error://chromewebdata/", "", "   ", "not a url", undefined, null, 42, {}]) {
      const err = await recordHistoryVisit({ url: bad }).catch((e: unknown) => e);
      expect(isHistoryError(err), String(bad)).toBe(true);
      expect((err as HistoryError).code).toBe("invalid_url");
      expect((err as HistoryError).message.length).toBeGreaterThan(0);
    }
    expect(readFileSync(file(), "utf-8")).toBe(before);
  });

  it(`满员（${HISTORY_LIMIT} 条）：淘汰最久没访问的，新的留下；不拒绝`, async () => {
    seed(Array.from({ length: HISTORY_LIMIT }, (_, i) => hist(i)));
    const { entry, created } = await recordHistoryVisit({ url: "https://new.example/x", title: "new" });
    expect(created).toBe(true);
    const list = await listHistory();
    expect(list).toHaveLength(HISTORY_LIMIT);
    expect(list[0]!.id).toBe(entry.id);
    expect(list.some((e) => e.id === "h-0")).toBe(false); // 最久没访问的
    expect(list.some((e) => e.id === "h-1")).toBe(true);
  });

  it("满员时记已有地址：不淘汰任何条目", async () => {
    seed(Array.from({ length: HISTORY_LIMIT }, (_, i) => hist(i)));
    const r = await recordHistoryVisit({ url: "https://example.com/p0" });
    expect(r.created).toBe(false);
    expect(await listHistory()).toHaveLength(HISTORY_LIMIT);
  });

  it("失败（地址不合法）不卡住串行队列：之后的记录照常成功", async () => {
    await expect(recordHistoryVisit({ url: "nope" })).rejects.toBeInstanceOf(HistoryError);
    expect((await recordHistoryVisit({ url: "https://example.com/ok" })).created).toBe(true);
  });
});

describe("removeHistoryEntry", () => {
  it("按 id 删：返回 true；id 不存在 / 空 / 非字符串 → false，且不动文件", async () => {
    const a = (await recordHistoryVisit({ url: "https://a.example/", title: "a" })).entry;
    const b = (await recordHistoryVisit({ url: "https://b.example/", title: "b" })).entry;
    const before = readFileSync(file(), "utf-8");
    for (const bad of ["no-such-id", "", undefined, null, 42, {}]) expect(await removeHistoryEntry(bad), String(bad)).toBe(false);
    expect(readFileSync(file(), "utf-8")).toBe(before);

    expect(await removeHistoryEntry(a.id)).toBe(true);
    expect((await listHistory()).map((x) => x.id)).toEqual([b.id]);
    expect(await removeHistoryEntry(a.id)).toBe(false);
  });

  it("文件不存在时删 = false，不建文件", async () => {
    expect(await removeHistoryEntry("x")).toBe(false);
    expect(existsSync(file())).toBe(false);
  });
});

describe("clearHistory", () => {
  it("清空：返回清掉了几条，文件被删（不是留一个空壳），之后读 = 空", async () => {
    for (const n of ["a", "b", "c"]) await recordHistoryVisit({ url: `https://${n}.example/` });
    expect(await clearHistory()).toBe(3);
    expect(existsSync(file())).toBe(false);
    expect(await listHistory()).toEqual([]);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("本来就是空 → 0，不建文件；清空后还能继续记", async () => {
    expect(await clearHistory()).toBe(0);
    expect(existsSync(file())).toBe(false);
    await recordHistoryVisit({ url: "https://a.example/" });
    expect(await clearHistory()).toBe(1);
    expect((await recordHistoryVisit({ url: "https://b.example/" })).created).toBe(true);
    expect(await listHistory()).toHaveLength(1);
  });

  it("文件坏了：也清（直接删，不留 .corrupt 备份——用户要清的就是这些内容）", async () => {
    writeFileSync(file(), "{ broken but may still hold https://secret.example/", "utf-8");
    expect(await clearHistory()).toBe(0);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("与并发的记录串行：先排进队的记录被清掉，后排进队的留下", async () => {
    await recordHistoryVisit({ url: "https://old.example/" });
    const ops = [recordHistoryVisit({ url: "https://before.example/" }), clearHistory(), recordHistoryVisit({ url: "https://after.example/" })];
    await Promise.all(ops);
    expect((await listHistory()).map((e) => e.url)).toEqual(["https://after.example/"]);
  });

  it("读不出来（目录占位）→ 抛错，原样保留，不会为了「清空」去删它", async () => {
    mkdirSync(file());
    writeFileSync(path.join(file(), "precious.txt"), "do not touch", "utf-8");
    await expect(clearHistory()).rejects.toThrow();
    expect(readFileSync(path.join(file(), "precious.txt"), "utf-8")).toBe("do not touch");
  });
});

describe("串行写：并发请求不丢更新", () => {
  it("20 个不同地址同时记 → 全部在，没有丢失", async () => {
    await Promise.all(Array.from({ length: 20 }, (_, i) => recordHistoryVisit({ url: `https://example.com/c${i}`, title: `c${i}` })));
    const list = await listHistory();
    expect(list).toHaveLength(20);
    expect(new Set(list.map((e) => e.url)).size).toBe(20);
  });

  it("同一个地址同时记 10 次 → 只有 1 条，次数恰好 10，恰好 1 次 created:true", async () => {
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => recordHistoryVisit({ url: "https://example.com/same", title: `t${i}` })));
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(new Set(results.map((r) => r.entry.id)).size).toBe(1);
    const list = await listHistory();
    expect(list).toHaveLength(1);
    expect(list[0]!.visitCount).toBe(10);
  });

  it("记与删交错：删掉的不会因为并发的记而复活，其余都在", async () => {
    const keep = (await recordHistoryVisit({ url: "https://keep.example/", title: "keep" })).entry;
    const drop = (await recordHistoryVisit({ url: "https://drop.example/", title: "drop" })).entry;
    const ops: Array<Promise<unknown>> = [removeHistoryEntry(drop.id)];
    for (let i = 0; i < 8; i++) ops.push(recordHistoryVisit({ url: `https://more.example/${i}`, title: `m${i}` }));
    await Promise.all(ops);
    const urls = (await listHistory()).map((e) => e.url);
    expect(urls).toContain(keep.url);
    expect(urls).not.toContain(drop.url);
    expect(urls).toHaveLength(9);
  });

  it("原子写不留临时文件", async () => {
    await Promise.all(Array.from({ length: 6 }, (_, i) => recordHistoryVisit({ url: `https://example.com/t${i}` })));
    await removeHistoryEntry((await listHistory())[0]!.id);
    expect(readdirSync(dir).filter((f) => f.includes(".tmp."))).toEqual([]);
    expect(readdirSync(dir)).toEqual([HISTORY_FILE]);
  });
});

describe("损坏的文件：读路径宽容、写路径保守", () => {
  const brokenShapes: Array<[string, string]> = [
    ["不是合法 JSON", "{ this is not json"],
    ["根是数组", JSON.stringify([hist(1)])],
    ["缺 v", JSON.stringify({ history: [hist(1)] })],
    ["v 不认识", JSON.stringify({ v: 2, history: [hist(1)] })],
    ["history 不是数组", JSON.stringify({ v: 1, history: "nope" })],
    ["根是 null", "null"],
    ["空文件", ""],
  ];

  for (const [name, content] of brokenShapes) {
    it(`${name}：读 = 空列表且不动文件；写 = 先把坏文件改名 .corrupt-<时间戳> 留证据，再写新的`, async () => {
      writeFileSync(file(), content, "utf-8");
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      expect(await listHistory()).toEqual([]);
      expect(readFileSync(file(), "utf-8")).toBe(content);
      expect(readdirSync(dir)).toEqual([HISTORY_FILE]);

      const { entry } = await recordHistoryVisit({ url: "https://example.com/new", title: "new" });
      const backup = readdirSync(dir).find((f) => f.startsWith(`${HISTORY_FILE}.corrupt-`));
      expect(backup, name).toBeDefined();
      expect(readFileSync(path.join(dir, backup!), "utf-8")).toBe(content);
      expect(readFileJson()).toEqual({ v: 1, history: [entry] });
      expect(warn).toHaveBeenCalled();
    });
  }

  it("删一条「不存在的」不会为此把坏文件改名（真要写新内容时才备份）", async () => {
    writeFileSync(file(), "{ broken", "utf-8");
    expect(await removeHistoryEntry("whatever")).toBe(false);
    expect(readdirSync(dir)).toEqual([HISTORY_FILE]);
    expect(readFileSync(file(), "utf-8")).toBe("{ broken");
  });

  it("带 BOM 的合法文件（Windows 记事本另存）照常解析，不当损坏", async () => {
    writeFileSync(file(), `\uFEFF${JSON.stringify({ v: 1, history: [hist(1)] })}`, "utf-8");
    expect((await listHistory()).map((e) => e.id)).toEqual(["h-1"]);
    await recordHistoryVisit({ url: "https://example.com/more", title: "more" });
    expect(readdirSync(dir).some((f) => f.includes(".corrupt-"))).toBe(false);
  });

  it("单条坏数据逐条丢弃，不连累其它记录（并且下一次写入会把坏条目清掉）", async () => {
    seed([hist(1), { id: "no-url" }, { url: "https://example.com/no-id" }, { id: "js", url: "javascript:alert(1)" }, null, "str", hist(2)]);
    expect((await listHistory()).map((e) => e.id).sort()).toEqual(["h-1", "h-2"]);
    await recordHistoryVisit({ url: "https://example.com/p9", title: "nine" });
    expect(readFileJson().history).toHaveLength(3);
  });

  it("读路径的坏文件告警限频：同一分钟内反复读只提示一次，过了窗口再提示", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 24 * 3600 * 1000);
    writeFileSync(file(), "{ broken", "utf-8");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await listHistory();
    await listHistory();
    await listHistory();
    expect(warn).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 61_000);
    await listHistory();
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

describe("读不出来 ≠ 空：绝不拿「读不出来的历史」当空列表去覆盖", () => {
  it("历史文件的位置被一个目录占着（EISDIR）：读 / 记 / 删都抛错，原样保留（不会被覆盖或改名）", async () => {
    mkdirSync(file());
    writeFileSync(path.join(file(), "precious.txt"), "do not touch", "utf-8");
    await expect(listHistory()).rejects.toThrow();
    await expect(recordHistoryVisit({ url: "https://example.com/x", title: "x" })).rejects.toThrow();
    await expect(removeHistoryEntry("any")).rejects.toThrow();
    expect(statSync(file()).isDirectory()).toBe(true);
    expect(readFileSync(path.join(file(), "precious.txt"), "utf-8")).toBe("do not touch");
    expect(readdirSync(dir)).toEqual([HISTORY_FILE]);
  });

  it("没有读权限（EACCES）：读 / 记都抛错，内容原样（非 root、非 Windows 才有意义）", async () => {
    if (process.platform === "win32" || (typeof process.getuid === "function" && process.getuid() === 0)) return;
    seed([hist(1)]);
    const before = readFileSync(file(), "utf-8");
    chmodSync(file(), 0o000);
    try {
      await expect(listHistory()).rejects.toThrow();
      await expect(recordHistoryVisit({ url: "https://example.com/y", title: "y" })).rejects.toThrow();
    } finally {
      chmodSync(file(), 0o600);
    }
    expect(readFileSync(file(), "utf-8")).toBe(before);
  });

  it("读失败不会卡住串行队列：之后（恢复正常了）的记录照常成功", async () => {
    mkdirSync(file());
    await expect(recordHistoryVisit({ url: "https://example.com/x" })).rejects.toThrow();
    rmSync(file(), { recursive: true });
    expect((await recordHistoryVisit({ url: "https://example.com/x", title: "x" })).created).toBe(true);
    expect(await listHistory()).toHaveLength(1);
  });
});
