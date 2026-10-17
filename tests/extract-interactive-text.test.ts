/**
 * 卡片抽文本：enrichment 富文本 / 原生 JSON / 抽不出
 */
import { describe, expect, it } from "vitest";

import { buildMarkdownCardJson } from "@/lib/server/feishu-bridge/lark-api";
import { extractInteractiveText } from "@/lib/server/route-helpers";

describe("extractInteractiveText", () => {
  it("enrichment <card> 富文本抽正文（含 16:03 线上卡片形态）", () => {
    const text = extractInteractiveText(
      "<card>\n@江耳的Flowship 开发环境可用这条已完成数据：\n- **学号：EAA5E7**\n</card>",
    );
    expect(text).toContain("EAA5E7");
    expect(text).not.toContain("<card>");
  });

  it("原生卡片 JSON 收集 text/content 节点（含按钮对象里的 content）", () => {
    const text = extractInteractiveText(
      JSON.stringify({
        config: { wide_screen_mode: true },
        elements: [
          { tag: "markdown", text: "学号 EAA5E7" },
          { tag: "button", text: { content: "查看" } },
        ],
      }),
    );
    expect(text).toContain("EAA5E7");
    // 按钮里的结论也是数据：以后 walk 改成只认顶层 text，这个断言会红
    expect(text).toContain("查看");
  });

  it("config 子树不读：文本卡的 config.summary 是正文开头，不能让取回的文本开头多出一遍", () => {
    // 真实产出方：群里文字一律发这张卡（summary = 正文开头 ≤50 字，body 里再有一份全文）
    const body = "已开始跑「接入支付」，预计几分钟，跑完我会在群里回你。";
    const card = buildMarkdownCardJson(body);
    // 前提：卡里确实带了 summary，否则这条用例没在测东西
    expect(
      (card.config as { summary?: { content?: string } }).summary?.content,
    ).toBeTruthy();
    expect(extractInteractiveText(JSON.stringify(card))).toBe(body);
  });

  it("只跳 config 键、不按 summary 名字过滤：别处的 summary.content 仍是正文", () => {
    const text = extractInteractiveText(
      JSON.stringify({
        config: { summary: { content: "预览摘要" } },
        elements: [{ tag: "markdown", summary: { content: "正文里的 summary" } }],
      }),
    );
    expect(text).toBe("正文里的 summary");
  });

  it("引用形态 / 空内容抽不出 → null（调用方回退 unsupported）", () => {
    expect(
      extractInteractiveText(JSON.stringify({ type: "card", data: {} })),
    ).toBeNull();
    expect(extractInteractiveText("")).toBeNull();
    expect(extractInteractiveText("<card>   </card>")).toBeNull();
    expect(extractInteractiveText("not json {{")).toBeNull();
  });

  it("超长截断 20000", () => {
    const text = extractInteractiveText(`<card>${"x".repeat(30000)}</card>`);
    expect(text?.length).toBeLessThanOrEqual(20000);
  });
});
