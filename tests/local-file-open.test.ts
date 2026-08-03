import { describe, expect, it, vi } from "vitest";

import {
  requestOpenLocalPath,
  requestRevealLocalPath,
} from "@/lib/local-file-open";

describe("requestOpenLocalPath", () => {
  it("把绝对路径交给系统 open-path API", async () => {
    const fetcher = vi.fn(async () => new Response('{"ok":true}'));

    await requestOpenLocalPath("C:\\report\\cockpit.html", fetcher as typeof fetch);

    expect(fetcher).toHaveBeenCalledWith("/api/system/open-path", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "C:\\report\\cockpit.html" }),
    });
  });

  it("服务端失败时抛出可展示的错误", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response('{"error":"文件不存在"}', {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }),
    );

    await expect(
      requestOpenLocalPath("/tmp/missing.html", fetcher as typeof fetch),
    ).rejects.toThrow("文件不存在");
  });
});

describe("requestRevealLocalPath", () => {
  it("把绝对路径交给跨平台文件管理器 API", async () => {
    const fetcher = vi.fn(async () => new Response('{"ok":true}'));

    await requestRevealLocalPath(
      "C:\\report\\cockpit.html",
      fetcher as typeof fetch,
    );

    expect(fetcher).toHaveBeenCalledWith("/api/system/reveal-in-folder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "C:\\report\\cockpit.html" }),
    });
  });
});
