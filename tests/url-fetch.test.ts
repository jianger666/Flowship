/**
 * URL 投喂（url-fetch）单测
 *
 * extractHttpUrls：去重 / 上限 / 内网剔除 / 静态资源剔除
 * fetchUrlText：vi.stubGlobal("fetch") mock——2xx html 剥标签、非 2xx、超时、text/plain
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildLinkedUrlsSection,
  extractHttpUrls,
  fetchUrlText,
} from "@/lib/server/url-fetch";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("extractHttpUrls", () => {
  it("抽取 http(s) 并去重", () => {
    const text =
      "看这个 https://example.com/a 和重复 https://example.com/a 还有 http://foo.dev/b";
    expect(extractHttpUrls(text)).toEqual([
      "https://example.com/a",
      "http://foo.dev/b",
    ]);
  });

  it("最多返回 max 个（默认 3）", () => {
    const text = [
      "https://a.example/1",
      "https://b.example/2",
      "https://c.example/3",
      "https://d.example/4",
    ].join(" ");
    expect(extractHttpUrls(text)).toHaveLength(3);
    expect(extractHttpUrls(text, 2)).toHaveLength(2);
    expect(extractHttpUrls(text, 0)).toEqual([]);
  });

  it("剔除 localhost / 127.0.0.1 / 10.x / 192.168.x / 172.16-31.x", () => {
    const text = [
      "https://localhost/x",
      "http://127.0.0.1:8080/y",
      "https://10.1.2.3/z",
      "http://192.168.1.1/a",
      "https://172.16.0.5/b",
      "https://172.31.255.1/c",
      "https://172.15.0.1/ok-low", // 172.15 不在 /12
      "https://172.32.0.1/ok-high", // 172.32 不在 /12
      "https://public.example.com/ok",
    ].join(" ");
    expect(extractHttpUrls(text)).toEqual([
      "https://172.15.0.1/ok-low",
      "https://172.32.0.1/ok-high",
      "https://public.example.com/ok",
    ]);
  });

  it("剔除明显静态资源扩展名", () => {
    const text = [
      "https://cdn.example/a.png",
      "https://cdn.example/b.JPG?x=1",
      "https://cdn.example/c.zip",
      "https://docs.example/page",
      "https://docs.example/readme.md",
    ].join(" ");
    expect(extractHttpUrls(text)).toEqual([
      "https://docs.example/page",
      "https://docs.example/readme.md",
    ]);
  });

  it("去掉尾部中英文标点", () => {
    expect(extractHttpUrls("见 https://example.com/doc。")).toEqual([
      "https://example.com/doc",
    ]);
    expect(extractHttpUrls("见 (https://example.com/doc)")).toEqual([
      "https://example.com/doc",
    ]);
  });
});

describe("fetchUrlText", () => {
  it("2xx HTML：剥 script/style/nav/footer + 取 title + 正文", async () => {
    const html = `<!doctype html><html><head><title> Hello World </title></head>
<body>
<nav>菜单</nav>
<script>evil()</script>
<style>.x{}</style>
<p>第一段正文</p>
<footer>页脚</footer>
</body></html>`;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(html, {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
      ),
    );
    const r = await fetchUrlText("https://example.com/page");
    expect(r).not.toBeNull();
    expect(r!.title).toBe("Hello World");
    expect(r!.text).toContain("第一段正文");
    expect(r!.text).not.toContain("evil");
    expect(r!.text).not.toContain("菜单");
    expect(r!.text).not.toContain("页脚");
  });

  it("非 2xx 返 null", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 404 })),
    );
    expect(await fetchUrlText("https://example.com/missing")).toBeNull();
  });

  it("非 html/plain Content-Type 返 null", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("{}", {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    expect(await fetchUrlText("https://example.com/api")).toBeNull();
  });

  it("text/plain 直通（无 title）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("plain body here", {
            status: 200,
            headers: { "content-type": "text/plain" },
          }),
      ),
    );
    const r = await fetchUrlText("https://example.com/raw.txt");
    expect(r).toEqual({ text: "plain body here" });
  });

  it("超时（AbortError）返 null、不抛", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        // 等 signal abort，模拟挂起请求
        await new Promise<void>((_, reject) => {
          const s = init?.signal;
          if (!s) {
            reject(new Error("no signal"));
            return;
          }
          if (s.aborted) {
            reject(new DOMException("Aborted", "AbortError"));
            return;
          }
          s.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        });
        return new Response("late");
      }),
    );
    // 模块内超时 5s——单测用 fake timers 加速
    vi.useFakeTimers();
    const p = fetchUrlText("https://example.com/slow");
    await vi.advanceTimersByTimeAsync(5000);
    await expect(p).resolves.toBeNull();
    vi.useRealTimers();
  });
});

describe("buildLinkedUrlsSection", () => {
  it("成功抓取时拼 [LINKED_URLS] 段", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            "<html><head><title>T</title></head><body><p>Body</p></body></html>",
            {
              status: 200,
              headers: { "content-type": "text/html" },
            },
          ),
      ),
    );
    const section = await buildLinkedUrlsSection(
      "看 https://example.com/doc 这个",
    );
    expect(section).toContain("[LINKED_URLS]");
    expect(section).toContain("https://example.com/doc");
    expect(section).toContain("（T）");
    expect(section).toContain("Body");
  });

  it("全失败 / 无 URL → 空串", async () => {
    expect(await buildLinkedUrlsSection("没有链接")).toBe("");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("x", { status: 500 })),
    );
    expect(
      await buildLinkedUrlsSection("坏链 https://example.com/fail"),
    ).toBe("");
  });
});
