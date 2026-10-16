/**
 * 第六轮 review H1-06：入向卡片里「`▶ 🔧 …` 形态对、但没有配对 ▲」的面板头，
 * 不能再一路剥到文末把后面的正文吞掉。
 *
 * 既有语义（tests/inbound-card-sanitize*.test.ts 钉着）不变：
 * - 有配对 ▲：照旧剥到 ▲；
 * - 形态对（思考 / 工具执行 / 💭🛠🧠⚙🔧）且没有 ▲（流式截断）：面板体仍会被剥掉，
 *   只是「面板体」现在有明确边界——紧跟面板头的缩进行（段间空行只要后面还是缩进行就算体内）。
 */
import { describe, expect, it } from "vitest";

import {
  sanitizeInboundCardText,
  stripAgentPanels,
} from "@/lib/server/feishu-bridge/inbound-card-sanitize";

import { doublingRatio, LINEAR_RATIO_MAX } from "./helpers/scaling-ratio";

describe("H1-06 · 没有 ▲ 的面板头只剥到「面板体」结束", () => {
  it("报告复现：▶ 🔧 要点列表后面的「请 review」不被吞", () => {
    const t = "本轮改动：\n▶ 🔧 修复登录\n▶ 🔧 补充测试\n请 review";
    const out = stripAgentPanels(t);
    expect(out).toContain("本轮改动：");
    expect(out).toContain("请 review");
    expect(out).toBe("本轮改动：\n请 review");
    // 完整净化链路（拆壳 → 面板 → 页脚 → open_id）同样如此
    expect(sanitizeInboundCardText(`<card>\n${t}\n</card>`)).toBe(
      "本轮改动：\n请 review",
    );
  });

  it("要点列表与后文隔着空行：空行及之后的正文保留", () => {
    expect(
      stripAgentPanels("本轮改动：\n▶ 🔧 修复登录\n▶ 🔧 补充测试\n\n请 review"),
    ).toBe("本轮改动：\n\n请 review");
  });

  it("真面板（流式截断、没有 ▲）：缩进的面板体照旧被剥，面板体里的段间空行不算结束", () => {
    expect(stripAgentPanels("正文\n▶ 💭 思考中\n    推理 a\n\n    推理 b")).toBe("正文");
    expect(stripAgentPanels("正文\n▶ 💭 思考中\n    推理 a\n   \n\t推理 b")).toBe("正文");
    expect(stripAgentPanels("正文\n▶ 🛠️ 工具执行 · 1 步\n    📝 shell\n\n\n\n    📝 edit")).toBe("正文");
  });

  it("面板体到第一个不缩进的非空行为止：后面的正文保留", () => {
    expect(stripAgentPanels("正文\n▶ 💭 思考中\n    推理 a\n结论：请 review")).toBe(
      "正文\n结论：请 review",
    );
    expect(stripAgentPanels("正文\n▶ 🛠️ 工具执行 · 1 步\n    📝 shell\n\n请 review")).toBe(
      "正文\n\n请 review",
    );
  });

  it("面板头后面没有缩进体、紧跟的就是别的内容：只剥头那一行", () => {
    expect(stripAgentPanels("a\n▶ 💭 思考\n结论")).toBe("a\n结论");
    // 头是最后一行（流式刚开始）：照旧剥掉
    expect(stripAgentPanels("a\n▶ 💭 思考")).toBe("a");
  });

  it("多个连续的无 ▲ 面板，各自带缩进体：全部剥掉，之后的正文保留", () => {
    expect(
      stripAgentPanels("a\n▶ 💭 思考\n  x\n▶ 🛠️ 工具执行\n  y\n尾巴"),
    ).toBe("a\n尾巴");
    expect(stripAgentPanels("a\n▶ 💭 思考\n  x\n▶ 🛠️ 工具执行\n  y")).toBe("a");
  });

  it("有配对 ▲ 时仍照旧剥到 ▲（不看缩进，面板体里没缩进的行也剥）", () => {
    expect(stripAgentPanels("a\n▶ x\n  内容\n▲\nb")).toBe("a\nb");
    expect(stripAgentPanels("a\n▶ 💭 思考\n内容不缩进\n再来一行\n▲\nb")).toBe("a\nb");
    expect(stripAgentPanels("a\n▶ 🔧 修复登录\n▶ 🔧 补充测试\n  内容\n▲\nb")).toBe("a\nb");
  });

  it("无 ▲ 的面板头之后、文中另有带 ▲ 的面板：「请 review」保留（第八轮 L4-08 修复；第六 / 七轮曾把「被吞」钉成已知缺陷）", () => {
    // 第一个头（`▶ 🔧 修复登录`，形态对）与它之后的 ▲ 之间还隔着别的面板头（`▶ 💭 思考`）：面板不嵌套，
    // 那个 ▲ 属于后面的头，不是第一个头的收尾——与非标题形态的头同一条规则（▲ 之前出现别的头就不配对）。
    // 第一个头于是按「没有配对 ▲」处理：只剥头本身 + 紧跟的缩进行，「请 review」不缩进、照常保留。
    expect(
      stripAgentPanels("a\n▶ 🔧 修复登录\n请 review\n▶ 💭 思考\n  x\n▲\nb"),
    ).toBe("a\n请 review\nb");
  });

  describe("线性：n → 2n 耗时比", () => {
    const cases: Record<string, (n: number) => string> = {
      "大量无体的 ▶ 🔧 头": (n) => "▶ 🔧 x\n".repeat(n),
      "大量带缩进体的无 ▲ 面板": (n) => "▶ 🔧 x\n    body\n".repeat(n),
      "面板头后一长串空行再缩进体": (n) => `▶ 💭 t\n${"\n".repeat(n)}    x\n后文`,
      "面板头后一长串空行、没有后文": (n) => `▶ 💭 t\n${"\n".repeat(n)}`,
      "面板头后一长串纯空白行": (n) => `▶ 💭 t\n${"   \n".repeat(n)}    x\n后文`,
      "大量「面板体 + 空行」交替": (n) => "▶ 💭 t\n    a\n\n".repeat(n),
      "大量带 ▲ 的面板": (n) => "▶ 💭 t\n  x\n▲\n".repeat(n),
      "复现形态重复": (n) => "本轮改动：\n▶ 🔧 修复登录\n▶ 🔧 补充测试\n请 review\n".repeat(n),
    };
    for (const [name, build] of Object.entries(cases)) {
      it(name, () => {
        const ratio = doublingRatio((n) => {
          const raw = build(n);
          return () => sanitizeInboundCardText(raw);
        }, 4000);
        expect(ratio).toBeLessThan(LINEAR_RATIO_MAX);
      });
    }
  });
});
