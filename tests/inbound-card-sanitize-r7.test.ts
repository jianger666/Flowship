/**
 * 第七轮 review K4-07：入向卡片「没有 ▲ 的面板头」之后，用缩进判面板体——缩进只认 ASCII 空格 / tab。
 *
 * 实测（修前）：全角缩进的段落（中文段首空两格 `\u3000\u3000请 review`）被当面板体剥掉、结果为空。
 * 为什么只认 ASCII 空格 / tab：真实面板体的缩进是程序渲染出来的 ASCII 空白；全角空格 / NBSP 是**人写中文段落**的
 * 段首缩进，把它当面板体等于吞掉对方真正说的话。
 *
 * 另有一条「已知局限」只作为现状记录（不是规格）：`▶ 🔧 修复登录` 下面缩进的普通子项，和真面板体在形态上无法区分。
 */
import { describe, expect, it } from "vitest";

import {
  sanitizeInboundCardText,
  stripAgentPanels,
} from "@/lib/server/feishu-bridge/inbound-card-sanitize";

describe("K4-07 · 缩进判据排除全角空格 / NBSP 等非 ASCII 空白", () => {
  it("报复现：面板头（无 ▲）后面紧跟全角缩进的段落 → 段落保留", () => {
    const t = "▶ 💭 思考中\n\u3000\u3000请 review";
    expect(stripAgentPanels(t)).toBe("\u3000\u3000请 review");
    // 完整净化链路里最终 trim 掉首尾空白，但不再是空串
    expect(sanitizeInboundCardText(`<card>\n${t}\n</card>`)).toBe("请 review");
  });

  it("正文 + 面板头 + 全角缩进段落：只剥面板头那一行", () => {
    expect(stripAgentPanels("正文\n▶ 💭 思考中\n\u3000\u3000请 review")).toBe(
      "正文\n\u3000\u3000请 review",
    );
    expect(stripAgentPanels("正文\n▶ 🛠️ 工具执行 · 1 步\n\u3000\u3000请 review")).toBe(
      "正文\n\u3000\u3000请 review",
    );
  });

  it("各种非 ASCII 空白做段首缩进：都不是面板体", () => {
    for (const ws of ["\u3000", "\u00a0", "\u2003", "\u2002", "\u2009"]) {
      const out = stripAgentPanels(`正文\n▶ 💭 思考中\n${ws}${ws}请 review`);
      expect(out, JSON.stringify(ws)).toBe(`正文\n${ws}${ws}请 review`);
    }
  });

  it("ASCII 缩进的面板体照剥，之后第一个全角缩进的段落保留", () => {
    expect(
      stripAgentPanels("正文\n▶ 💭 思考中\n    推理 a\n\u3000\u3000结论：请 review"),
    ).toBe("正文\n\u3000\u3000结论：请 review");
  });

  it("面板体里的段间空行之后，若接着的是全角缩进段落：面板体到此结束，空行与段落都保留", () => {
    expect(
      stripAgentPanels("正文\n▶ 💭 思考中\n    推理 a\n\n\u3000\u3000请 review"),
    ).toBe("正文\n\n\u3000\u3000请 review");
  });

  it("ASCII 空格 / tab 缩进仍是面板体（对照，防收窄过头）", () => {
    expect(stripAgentPanels("正文\n▶ 💭 思考中\n  a")).toBe("正文");
    expect(stripAgentPanels("正文\n▶ 💭 思考中\n\ta")).toBe("正文");
    expect(stripAgentPanels("正文\n▶ 💭 思考中\n \t a\n    b")).toBe("正文");
    // 空行（含全角空格组成的「空行」）仍按空行处理：它后面还是 ASCII 缩进就算体内
    expect(stripAgentPanels("正文\n▶ 💭 思考中\n    a\n\u3000\n    b")).toBe("正文");
  });

  it("有配对 ▲ 时不看缩进（既有语义不变）：全角缩进的行也在面板里被一并剥掉", () => {
    expect(stripAgentPanels("a\n▶ 💭 思考\n\u3000\u3000内容\n▲\nb")).toBe("a\nb");
  });
});

describe("K4-07 · 已知局限（现状如此，不是规格；请勿当作期望行为去依赖）", () => {
  it("【已知局限·现状如此、不是规格】`▶ 🔧 修复登录` 下缩进的普通子项，被当面板体一并剥掉", () => {
    // 面板体的定义就是「紧跟面板头的缩进行」：`▶ 🔧 修复登录` 下缩进的 `- 改了 a.ts` 在形态上和真面板体
    // （`▶ 💭 思考中` 下缩进的推理文字）没有区别，没有额外信号可以区分「真面板体」与「普通缩进子项」。
    // 取舍：保持现状（宁可多剥一个子项，也不把整段推理漏给 agent）。要消除需要对端卡片带结构化标记，不在本轮。
    // 这条断言钉的是「现状」，将来有更好的判据时请直接改掉它，而不是让判据迁就它。
    const t = "本轮改动：\n▶ 🔧 修复登录\n  - 改了 a.ts\n请 review";
    expect(stripAgentPanels(t)).toBe("本轮改动：\n请 review");
  });
});
