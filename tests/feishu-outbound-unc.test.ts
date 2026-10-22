/**
 * Q4-03：飞书桥出站图片的 UNC 守卫；Q4-05：open-path 接统一白名单。
 *
 * 出站：AI 写在回复里的 `![](//host/share/a.png)` 会被 finalize 前「本地图 → image_key」逻辑原样交给
 * `uploadImage`，lark-cli 以 `path.dirname(path.resolve(p))` 为 cwd 起子进程——Windows 上 UNC 当 cwd 会连 SMB、
 * 带 NTLM 凭据。断言：6+ 种 UNC 形态 upload 调用数为 0，正常本地路径仍上传。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { UNC_REJECT_MESSAGE } from "@/lib/unc-path";

vi.mock("@/lib/server/task-fs", () => ({ getTask: vi.fn(async () => null) }));
vi.mock("@/lib/server/chat-pending", () => ({ getPendingAsk: vi.fn(() => null) }));
vi.mock("@/lib/server/feishu-bridge/bridge-config", () => ({
  isFeishuChatBridgeEnabled: vi.fn(async () => true),
  getBridgeDataDir: async () => "/tmp/feishu-bridge-test",
  isBridgeTestInstance: () => true,
  isFeishuBridgeKeepAwakeEnabled: async () => true,
  isFeishuBridgeStreamingEnabled: vi.fn(async () => true),
}));

const spawnMock = vi.hoisted(() =>
  vi.fn(() => ({
    on(ev: string, cb: (code: number) => void) {
      if (ev === "exit") setTimeout(() => cb(0), 0);
      return this;
    },
    unref() {},
  })),
);
const execFileMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: spawnMock, execFile: execFileMock };
});

const { replaceLocalImagesInMarkdown } = await import("@/lib/server/feishu-bridge/outbound");
const { uploadImage: realUploadImage } = await import("@/lib/server/feishu-bridge/lark-api");
const { POST: openPath } = await import("@/app/api/system/open-path/route");

const FALLBACK = "[图片：仅 app 内可见]";

describe("Q4-03：出站图片 UNC 守卫（upload 调用数为 0）", () => {
  const upload = vi.fn(async (p: string) => `img_for(${p})`);
  beforeEach(() => {
    upload.mockClear();
  });

  const UNC_SRCS = [
    "//attacker.example/share/a.png",
    "///attacker.example/share/a.png",
    "\\\\attacker.example\\share\\a.png",
    "\\/attacker.example/share/a.png",
    "file:////attacker.example/share/a.png",
    "file://attacker.example/share/a.png",
    "file:///%2F%2Fattacker.example/share/a.png",
    "\\\\?\\UNC\\attacker.example\\share\\a.png",
  ];

  it.each(UNC_SRCS)("%s → 不上传，降级成「仅 app 内可见」", async (src) => {
    const out = await replaceLocalImagesInMarkdown(`看图 ![x](${src}) 完`, upload);
    expect(upload).not.toHaveBeenCalled();
    expect(out).toBe(`看图 ${FALLBACK} 完`);
  });

  it("同一条消息里 UNC 与本地图并存：只有本地图被上传", async () => {
    const out = await replaceLocalImagesInMarkdown(
      "![a](//h/s/a.png)\n![b](/tmp/ok/b.png)\n![c](file:////h/s/c.png)",
      upload,
    );
    expect(upload).toHaveBeenCalledTimes(1);
    expect(upload).toHaveBeenCalledWith("/tmp/ok/b.png");
    expect(out).toBe(`${FALLBACK}\n![b](img_for(/tmp/ok/b.png))\n${FALLBACK}`);
  });

  it("回归：正常本地绝对路径 / file:///Users/… 仍上传；http 图不动", async () => {
    const a = await replaceLocalImagesInMarkdown("![](/Users/me/a.png)", upload);
    expect(a).toBe("![](img_for(/Users/me/a.png))");
    const b = await replaceLocalImagesInMarkdown("![](file:///Users/me/b%20c.png)", upload);
    expect(b).toBe("![](img_for(/Users/me/b c.png))");
    expect(upload).toHaveBeenCalledTimes(2);
    const c = await replaceLocalImagesInMarkdown("![](https://example.com/x.png)", upload);
    expect(c).toContain("https://example.com/x.png");
    expect(upload).toHaveBeenCalledTimes(2);
  });

  it("file:///C:/x 不再被剥成 `/C:/x`：交给 upload 的是 `C:/x/a.png`（Windows 盘符的标准 file URL 写法）", async () => {
    await replaceLocalImagesInMarkdown("![](file:///C:/x/a.png)", upload);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(upload.mock.calls[0]?.[0]).toBe("C:/x/a.png");
  });

  it("深度防御：lark-api.uploadImage 自己也拒 UNC，且 lark-cli 一次都没被拉起", async () => {
    execFileMock.mockClear();
    for (const p of ["//h/s/a.png", "\\\\h\\s\\a.png", "file:////h/s/a.png"]) {
      await expect(realUploadImage(p)).rejects.toThrow(UNC_REJECT_MESSAGE);
    }
    expect(execFileMock).not.toHaveBeenCalled();
  });
});

describe("Q4-05：POST /api/system/open-path 接统一白名单", () => {
  const post = (p: string) =>
    openPath(
      new Request("http://localhost/api/system/open-path", {
        method: "POST",
        body: JSON.stringify({ path: p }),
      }),
    );
  const withPlatform = async <T,>(platform: string, fn: () => Promise<T>): Promise<T> => {
    const orig = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: platform });
    try {
      return await fn();
    } finally {
      Object.defineProperty(process, "platform", orig);
    }
  };

  beforeEach(() => {
    spawnMock.mockClear();
  });

  it("任何平台：UNC 形态 400 且 spawn 从未调用", async () => {
    for (const p of ["//h/s/a.txt", "\\\\h\\s\\a.txt", "\\\\?\\UNC\\h\\s\\a.txt", "file:////h/s/a.txt"]) {
      const res = await post(p);
      expect(res.status, p).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe(UNC_REJECT_MESSAGE);
    }
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("Windows：NT 命名空间前缀 UNC / `/C:/x` / `/c/Users` 以前能走到 open，现在 400 且 spawn 为 0", async () => {
    await withPlatform("win32", async () => {
      for (const p of ["\\??\\UNC\\h\\s\\a.txt", "\\??\\C:\\a.txt", "/C:/Users/me/a.txt", "/c/Users/me/a.txt"]) {
        const res = await post(p);
        expect(res.status, p).toBe(400);
      }
    });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("回归：正常本地绝对路径照常 spawn 打开（posix 用 open / xdg-open）", async () => {
    const res = await withPlatform("darwin", () => post("/tmp/ok dir/a.txt"));
    expect(res.status).toBe(200);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("回归：Windows 盘符路径不被白名单误拒", async () => {
    const res = await withPlatform("win32", () => post("C:\\Users\\me\\a.txt"));
    expect(res.status).toBe(200);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("回归：相对路径仍是原来的「必须是绝对路径」", async () => {
    const res = await post("relative/a.txt");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("绝对路径");
  });
});
