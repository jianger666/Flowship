/**
 * diff 语法高亮结果仓（`lib/diff-syntax-store`）：LRU / 体积上限 / 并发合并 / 上游无响应超时。
 *
 * 上游高亮器用假的注入（只造「命中同步返回 / 稍后回调 / 永不回调 / 抛错」四种形态），
 * 假定时器推进超时；token 规整走真实的 `normalizeUpstreamResult`（核对「渲染出的文字 == 源码」），
 * 所以假高亮器要按「源码 + 指纹行」逐行返回单 token，和真实 Shiki 的结果形状一致。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createDiffSyntaxStore,
  DIFF_SYNTAX_REQUEST_TIMEOUT_MS,
  type UpstreamHighlight,
  type UpstreamHighlightResult,
} from "../src/lib/diff-syntax-store";

/** 与真实高亮器同形：每行一个 token、文字 = 该行源码（含喂进来的指纹行） */
const tokensFor = (code: string): UpstreamHighlightResult => ({
  tokens: code.split("\n").map((line) => [{ content: line, color: "#111111" }]),
});

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("请求 / 合并 / 失败", () => {
  it("稍后回调：结果规整后缓存（丢掉指纹行、行数 = 源码行数）；同 key 并发只调一次上游", async () => {
    let cb!: (r: UpstreamHighlightResult | null) => void;
    const highlight = vi.fn<UpstreamHighlight>((_l, _c, callback) => {
      cb = callback;
      return null;
    });
    const store = createDiffSyntaxStore({ highlight });

    const a = store.request("ts", "const a = 1;\nconst b = 2;");
    const b = store.request("ts", "const a = 1;\nconst b = 2;");
    expect(highlight).toHaveBeenCalledTimes(1);
    // 喂给上游的是「源码 + 指纹行」
    expect(highlight.mock.calls[0]![1].startsWith("const a = 1;\nconst b = 2;\n")).toBe(true);
    expect(highlight.mock.calls[0]![1].split("\n")).toHaveLength(3);

    expect(store.get("ts", "const a = 1;\nconst b = 2;")).toBeUndefined();
    cb(tokensFor(highlight.mock.calls[0]![1]));
    await Promise.all([a, b]);
    const got = store.get("ts", "const a = 1;\nconst b = 2;");
    expect(got).toHaveLength(2);
    expect(got![0]![0]).toMatchObject({ content: "const a = 1;", light: "#111111" });
    // 已缓存：再请求不再调上游
    await store.request("ts", "const a = 1;\nconst b = 2;");
    expect(highlight).toHaveBeenCalledTimes(1);
  });

  it("命中上游缓存（同步返回、不回调）也能收尾", async () => {
    const highlight = vi.fn<UpstreamHighlight>((_l, code) => tokensFor(code));
    const store = createDiffSyntaxStore({ highlight });
    await store.request("ts", "x");
    expect(store.get("ts", "x")).toHaveLength(1);
  });

  it("上游同步抛 / 返回的 token 核对不过：缓存 null（别反复请求）", async () => {
    const thrower = vi.fn<UpstreamHighlight>(() => {
      throw new Error("boom");
    });
    const s1 = createDiffSyntaxStore({ highlight: thrower });
    await s1.request("ts", "x");
    expect(s1.get("ts", "x")).toBeNull();
    await s1.request("ts", "x");
    expect(thrower).toHaveBeenCalledTimes(1);

    // 文字对不上源码（上游缓存键撞车拿到别人的结果）→ null
    const wrong = vi.fn<UpstreamHighlight>(() => tokensFor("别的源码\nzzz"));
    const s2 = createDiffSyntaxStore({ highlight: wrong });
    await s2.request("ts", "x");
    expect(s2.get("ts", "x")).toBeNull();
  });

  it("上游回调 null（高亮失败）：缓存 null", async () => {
    const store = createDiffSyntaxStore({
      highlight: (_l, _c, callback) => {
        callback(null);
        return null;
      },
    });
    await store.request("ts", "x");
    expect(store.get("ts", "x")).toBeNull();
  });
});

describe("上游无响应的超时兜底", () => {
  it("超时没回调：按「没有结果」收尾（promise resolve、缓存 null、inflight 放掉）", async () => {
    const highlight = vi.fn<UpstreamHighlight>(() => null); // 永不回调
    const store = createDiffSyntaxStore({ highlight });
    let done = false;
    const p = store.request("ts", "x").then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(DIFF_SYNTAX_REQUEST_TIMEOUT_MS - 1);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    await p;
    expect(done).toBe(true);
    expect(store.get("ts", "x")).toBeNull();
  });

  it("超时后上游又回来了：迟到的结果覆盖 null", async () => {
    let cb!: (r: UpstreamHighlightResult | null) => void;
    let fed = "";
    const store = createDiffSyntaxStore({
      highlight: (_l, code, callback) => {
        cb = callback;
        fed = code;
        return null;
      },
    });
    const p = store.request("ts", "let x = 1;");
    await vi.advanceTimersByTimeAsync(DIFF_SYNTAX_REQUEST_TIMEOUT_MS + 1);
    await p;
    expect(store.get("ts", "let x = 1;")).toBeNull();
    cb(tokensFor(fed));
    expect(store.get("ts", "let x = 1;")).toHaveLength(1);
  });

  it("按时回调：不会再被超时覆盖成 null（定时器已清）", async () => {
    let cb!: (r: UpstreamHighlightResult | null) => void;
    let fed = "";
    const store = createDiffSyntaxStore({
      highlight: (_l, code, callback) => {
        cb = callback;
        fed = code;
        return null;
      },
    });
    const p = store.request("ts", "let x = 1;");
    cb(tokensFor(fed));
    await p;
    await vi.advanceTimersByTimeAsync(DIFF_SYNTAX_REQUEST_TIMEOUT_MS * 2);
    expect(store.get("ts", "let x = 1;")).toHaveLength(1);
  });

  it("超时是可配的", async () => {
    const store = createDiffSyntaxStore({ highlight: () => null, timeoutMs: 50 });
    const p = store.request("ts", "x");
    await vi.advanceTimersByTimeAsync(51);
    await p;
    expect(store.get("ts", "x")).toBeNull();
  });
});

describe("缓存淘汰：LRU + 条数上限 + 体积上限", () => {
  const sync: UpstreamHighlight = (_l, code) => tokensFor(code);

  it("条数封顶：满了淘汰最久没用的", async () => {
    const store = createDiffSyntaxStore({ highlight: sync, maxEntries: 3 });
    for (const c of ["a", "b", "c", "d"]) await store.request("ts", c);
    expect(store.has("ts", "a")).toBe(false); // 最早的被挤掉
    expect(["b", "c", "d"].every((c) => store.has("ts", c))).toBe(true);
    expect(store.stats().entries).toBe(3);
  });

  it("LRU 不是 FIFO：被 touch 过的比没用过的晚淘汰", async () => {
    const store = createDiffSyntaxStore({ highlight: sync, maxEntries: 3 });
    for (const c of ["a", "b", "c"]) await store.request("ts", c);
    store.touch("ts", "a"); // a 刚被用过：新旧顺序变成 b < c < a
    await store.request("ts", "d"); // 满了：淘汰最久没用的 = b，不是最早写入的 a
    expect(store.has("ts", "a")).toBe(true);
    expect(store.has("ts", "b")).toBe(false);
    expect(store.has("ts", "c")).toBe(true);
    expect(store.has("ts", "d")).toBe(true);
  });

  it("get 不改变新旧顺序（渲染期调用要无副作用）", async () => {
    const store = createDiffSyntaxStore({ highlight: sync, maxEntries: 2 });
    await store.request("ts", "a");
    await store.request("ts", "b");
    store.get("ts", "a");
    await store.request("ts", "c");
    expect(store.has("ts", "a")).toBe(false); // 只 get 没 touch：照旧是最久没用的
  });

  it("touch 一个不存在的 key 无操作", () => {
    const store = createDiffSyntaxStore({ highlight: sync });
    expect(() => store.touch("ts", "nope")).not.toThrow();
    expect(store.stats().entries).toBe(0);
  });

  it("体积封顶：源码字符数合计超限就淘汰最久没用的，直到回到上限内", async () => {
    const store = createDiffSyntaxStore({ highlight: sync, maxChars: 25 });
    const code = (c: string) => c.repeat(10);
    await store.request("ts", code("a"));
    await store.request("ts", code("b"));
    expect(store.stats()).toEqual({ entries: 2, chars: 20 });
    await store.request("ts", code("c")); // 30 > 25：淘汰 a
    expect(store.has("ts", code("a"))).toBe(false);
    expect(store.has("ts", code("b"))).toBe(true);
    expect(store.has("ts", code("c"))).toBe(true);
    expect(store.stats()).toEqual({ entries: 2, chars: 20 });
  });

  it("单条就超过总预算：刚写入的这条仍然留下（只淘汰别的），不会一进来就被自己踢掉", async () => {
    const store = createDiffSyntaxStore({ highlight: sync, maxChars: 5 });
    await store.request("ts", "a".repeat(3));
    await store.request("ts", "b".repeat(50));
    expect(store.has("ts", "a".repeat(3))).toBe(false);
    expect(store.has("ts", "b".repeat(50))).toBe(true);
    expect(store.stats()).toEqual({ entries: 1, chars: 50 });
  });

  it("同 key 覆盖（超时的 null 被迟到结果替换）不重复计字符数", async () => {
    let cb!: (r: UpstreamHighlightResult | null) => void;
    let fed = "";
    const store = createDiffSyntaxStore({
      highlight: (_l, code, callback) => {
        cb = callback;
        fed = code;
        return null;
      },
    });
    const p = store.request("ts", "abcdef");
    await vi.advanceTimersByTimeAsync(DIFF_SYNTAX_REQUEST_TIMEOUT_MS + 1);
    await p;
    expect(store.stats()).toEqual({ entries: 1, chars: 6 });
    cb(tokensFor(fed));
    expect(store.stats()).toEqual({ entries: 1, chars: 6 });
  });

  it("不同语言的同一份源码是两条缓存", async () => {
    const store = createDiffSyntaxStore({ highlight: sync });
    await store.request("ts", "x");
    expect(store.has("ts", "x")).toBe(true);
    expect(store.has("py", "x")).toBe(false);
  });
});

describe("接线（源码契约）：hook 用结果仓、effect 里刷新 LRU", () => {
  it("hook 不再自己持有缓存 / 请求逻辑；命中时 touch", async () => {
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const src = readFileSync(
      path.resolve(import.meta.dirname, "..", "src", "hooks", "use-diff-syntax-tokens.ts"),
      "utf-8",
    );
    expect(src).toContain("createDiffSyntaxStore(");
    expect(src).toContain("store.touch(language, seg.code)");
    expect(src).toContain("store.request(language, seg.code)");
    expect(src).not.toContain("new Map");
    expect(src).not.toContain("CACHE_MAX");
  });
});
