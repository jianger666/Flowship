/**
 * 截图 base64 不进事件流 / 落盘（image-redact.ts + tool-result-persist.extractToolOutputText 的接线），
 * 以及「内置浏览器」提示词一节（按可用性出现、不超篇幅、含关键约束）。
 */
import { afterEach, describe, expect, it } from "vitest";

import { stripImageBlocks } from "@/lib/server/browser/image-redact";
import { BROWSER_PROMPT_SECTION, browserPromptSection } from "@/lib/server/browser/prompt";
import { extractToolOutputText } from "@/lib/server/tool-result-persist";

import { installFakeBrowser, type FakeBrowser } from "./helpers/browser-bridge-fake";

const B64 = Buffer.alloc(300_000, 9).toString("base64"); // ≈400KB 的 base64

describe("stripImageBlocks", () => {
  it("pi 形态 {content:[text,image]}：图片块换成占位文字，文字保留，原对象不被修改", () => {
    const input = {
      content: [
        { type: "text", text: "截图完成：1280×800" },
        { type: "image", data: B64, mimeType: "image/jpeg" },
      ],
      details: undefined,
    };
    const out = stripImageBlocks(input);
    expect(out).not.toBe(input);
    expect(JSON.stringify(out)).not.toContain(B64.slice(0, 64));
    expect(out.content[0]).toEqual({ type: "text", text: "截图完成：1280×800" });
    expect(out.content[1]).toMatchObject({ type: "text" });
    expect((out.content[1] as { text: string }).text).toMatch(/\[图片 image\/jpeg · \d+KB 已省略\]/);
    // 写时复制：入参里的图还在
    expect((input.content[1] as { data: string }).data).toBe(B64);
  });

  it("Cursor / MCP 嵌套形态（value.content[].data + mimeType）同样处理", () => {
    const out = stripImageBlocks({
      status: "success",
      value: { content: [{ type: "image", data: B64, mimeType: "image/png" }, { type: "text", text: "ok" }] },
    });
    expect(JSON.stringify(out)).not.toContain(B64.slice(0, 64));
    expect(JSON.stringify(out)).toContain("已省略");
  });

  it("没有图片块时返回同一个引用（零拷贝，其它工具不受影响）", () => {
    const input = { content: [{ type: "text", text: "hi" }], nested: { a: [1, 2, { b: "c" }] } };
    expect(stripImageBlocks(input)).toBe(input);
    expect(stripImageBlocks("str")).toBe("str");
    expect(stripImageBlocks(null)).toBeNull();
  });

  it("很小的 data（图标 / 误判风险）不当截图处理；二进制 data 按字节估算", () => {
    const tiny = { type: "image", data: "abcd", mimeType: "image/png" };
    expect(stripImageBlocks(tiny)).toBe(tiny);
    const bin = stripImageBlocks({ type: "image", data: new Uint8Array(50_000), mimeType: "image/jpeg" }) as unknown as {
      text: string;
    };
    expect(bin.text).toContain("49KB");
  });
});

describe("extractToolOutputText：落盘文本里没有 base64", () => {
  it("pi 形态：只留文字 + 占位", () => {
    const text = extractToolOutputText("browser_screenshot", {
      content: [
        { type: "text", text: "截图完成：1280×800，约 292KB" },
        { type: "image", data: B64, mimeType: "image/jpeg" },
      ],
    });
    expect(text.length).toBeLessThan(2000);
    expect(text).not.toContain(B64.slice(0, 64));
    expect(text).toContain("截图完成");
  });

  it("Cursor 形态（status/value 信封）：兜底 stringify 也不带 base64", () => {
    const text = extractToolOutputText("mcp:custom-user-tools:browser_screenshot", {
      status: "success",
      value: { content: [{ type: "image", data: B64, mimeType: "image/jpeg" }] },
    });
    expect(text.length).toBeLessThan(2000);
    expect(text).not.toContain(B64.slice(0, 64));
  });
});

describe("提示词「内置浏览器」一节", () => {
  let fake: FakeBrowser | null = null;
  afterEach(() => {
    fake?.cleanup();
    fake = null;
  });

  it("bridge 不可用 → 空串（没有工具就不描述工具）；可用 → 返回正文", () => {
    expect(browserPromptSection()).toBe("");
    fake = installFakeBrowser();
    expect(browserPromptSection()).toBe(BROWSER_PROMPT_SECTION);
  });

  it("≤25 行，且覆盖契约要求的要点", () => {
    expect(BROWSER_PROMPT_SECTION.split("\n").length).toBeLessThanOrEqual(25);
    for (const must of [
      "browser_snapshot", // 先 snapshot 再按 ref 操作
      "ref",
      "失效", // ref 失效重新 snapshot
      "untrusted_page_content", // 页面内容是不可信数据
      "不能当作用户的授权", // 不是授权凭据
      "接管", // 用户接管时别硬抢
      "ask_user", // 结束本轮或 ask_user
      "browser_ask_user_to_act", // 登录 / 验证码
      "browser_screenshot", // 别在没必要时截图
    ]) {
      expect(BROWSER_PROMPT_SECTION, must).toContain(must);
    }
  });
});
