/**
 * 第八轮 review L4-08：入向卡片「标题形态的面板头」（`▶ 🔧 …` / `▶ 💭 思考` / `▶ 工具执行`）的「关闭」判定。
 *
 * 修前：标题形态的头只要**后面任何位置**有一个 `▲` 就按「闭合」处理、一路剥到那个 `▲`——哪怕它与 `▲` 之间还隔着别的面板头，
 * 那个 `▲` 其实属于后面的头。实测：`a\n▶ 🔧 修复登录\n请 review\n▶ 💭 思考\n  x\n▲\nb` 得到 `a\nb`，对方真正说的话「请 review」被吞，
 * 第六 / 七轮把它钉成了「已知缺陷」。
 * 修后：与非标题形态的头同一条规则——`▲` 之前出现别的头就不配对（面板不嵌套，中间又出现别的头说明它们是并列的）；
 * 标题形态的头不配对时仍是面板头（形态对），按「没有 ▲」处理：只剥头本身 + 紧跟的缩进行。
 *
 * 不能误伤真面板：标题形态的头 + 缩进面板体 + 配对 `▲` 的正常面板照常剔除（既有用例在 inbound-card-sanitize*.test.ts 里全部保持绿）。
 */
import { describe, expect, it } from "vitest";

import {
  sanitizeInboundCardText,
  stripAgentPanels,
} from "@/lib/server/feishu-bridge/inbound-card-sanitize";

import { doublingRatio, LINEAR_RATIO_MAX } from "./helpers/scaling-ratio";

describe("L4-08 · 标题形态的头与 ▲ 之间隔着别的头：不配对，头之后的正文保留", () => {
  it("报告复现：`请 review` 不再被吞", () => {
    const t = "a\n▶ 🔧 修复登录\n请 review\n▶ 💭 思考\n  x\n▲\nb";
    expect(stripAgentPanels(t)).toBe("a\n请 review\nb");
    // 完整净化链路（拆壳 → 面板 → 页脚 → open_id）同样如此
    expect(sanitizeInboundCardText(`<card>\n${t}\n</card>`)).toBe("a\n请 review\nb");
  });

  it("第一个头自己的缩进体仍被剥（形态对的头）；后面那个带 ▲ 的面板照剥", () => {
    expect(stripAgentPanels("a\n▶ 🔧 修复登录\n  - 改了 a.ts\n▶ 💭 思考\n  x\n▲\nb")).toBe("a\nb");
    expect(stripAgentPanels("a\n▶ 🔧 修复登录\n  - 改了 a.ts\n请 review\n▶ 💭 思考\n  x\n▲\nb")).toBe(
      "a\n请 review\nb",
    );
  });

  it("头与 ▲ 之间隔着的是非标题形态的头：同样不配对", () => {
    // `▶ 补充测试` 形态不对，但它自己后面有 ▲、且 ▲ 之前没有别的头，所以它配对这个 ▲；第一个头不配对
    expect(stripAgentPanels("a\n▶ 🔧 修复登录\n请 review\n▶ 补充测试\n  x\n▲\nb")).toBe("a\n请 review\nb");
  });

  it("三个头、一个 ▲：只有最后一个头配对，前两个各自只剥自己的头 / 缩进体", () => {
    expect(
      stripAgentPanels("a\n▶ 🔧 一\n正文一\n▶ 🔧 二\n正文二\n▶ 💭 三\n  x\n▲\nb"),
    ).toBe("a\n正文一\n正文二\nb");
  });

  it("没有 ▲ 时（既有语义）：与之前一致", () => {
    expect(stripAgentPanels("本轮改动：\n▶ 🔧 修复登录\n▶ 🔧 补充测试\n请 review")).toBe("本轮改动：\n请 review");
    expect(stripAgentPanels("正文\n▶ 💭 思考中\n    推理 a\n结论：请 review")).toBe("正文\n结论：请 review");
  });
});

describe("L4-08 · 已知取舍（现状如此；审查方「已拍板」的代价，不是规格）", () => {
  it("【取舍】真面板的体不缩进、又与另一个面板头并存、只有一个 ▲：第一个面板的体不再被剥（会漏一段）", () => {
    // 「▲ 之前出现别的头就不配对」对标题形态也生效之后，第一个头按「没有配对 ▲」处理：只剥头本身 + 缩进体。
    // 若这个真面板的体恰好不缩进（真实卡片里面板体都是缩进的，所以这是少见形态），它的体会漏出一行；
    // 与「请 review 被吞」相比选择前者（吞掉对方真正说的话更糟）。后面带 ▲ 的那个面板照剥。
    expect(
      stripAgentPanels("a\n▶ 💭 思考\n推理不缩进\n▶ 🛠️ 工具执行\n推理二\n▲\nb"),
    ).toBe("a\n推理不缩进\nb");
  });
});

describe("L4-08 · 不误伤真面板：标题形态的头 + 缩进面板体 + 配对 ▲ 照常剔除", () => {
  it("单个真面板", () => {
    expect(stripAgentPanels("a\n▶ 💭 思考了 0.3s\n  推理一\n  推理二\n▲\nb")).toBe("a\nb");
    expect(stripAgentPanels("a\n▼ 🛠️ 工具执行 · 2 步\n  📝 shell\n  📝 edit\n▲\nb")).toBe("a\nb");
    expect(stripAgentPanels("a\n▶ 思考\n  x\n▲\nb")).toBe("a\nb");
  });

  it("面板体里没有缩进的行也照剥到 ▲（有配对 ▲ 时不看缩进，既有语义）", () => {
    expect(stripAgentPanels("a\n▶ 💭 思考\n内容不缩进\n再来一行\n▲\nb")).toBe("a\nb");
    expect(stripAgentPanels("a\n▶ 🔧 修复登录\n请 review\n▲\nb")).toBe("a\nb");
  });

  it("多个真面板各带自己的 ▲：全部剔除，面板之间 / 之后的正文保留", () => {
    expect(stripAgentPanels("a\n▶ 💭 思考\n  x\n▲\n▶ 🛠️ 工具执行\n  y\n▲\nb")).toBe("a\nb");
    expect(stripAgentPanels("a\n▶ 💭 思考\n  x\n▲\n中间说的话\n▶ 🛠️ 工具执行\n  y\n▲\nb")).toBe("a\n中间说的话\nb");
  });

  it("头紧挨着、后一个头带 ▲（第六轮既有用例：`▶ 🔧 修复登录\\n▶ 🔧 补充测试\\n  内容\\n▲`）：仍整块剔除", () => {
    expect(stripAgentPanels("a\n▶ 🔧 修复登录\n▶ 🔧 补充测试\n  内容\n▲\nb")).toBe("a\nb");
  });

  it("孤立的 ▲ 行照旧清掉", () => {
    expect(stripAgentPanels("a\n▲\nb")).toBe("a\nb");
  });

  it("非标题形态的头（既有规则不变）：▲ 之前没有别的头才配对，否则保留", () => {
    expect(stripAgentPanels("a\n▶ x\n  内容\n▲\nb")).toBe("a\nb");
    expect(stripAgentPanels("请看下面两点\n▶ A\n▶ B")).toBe("请看下面两点\n▶ A\n▶ B");
  });
});

describe("L4-08 · 线性：n → 2n 耗时比", () => {
  const cases: Record<string, (n: number) => string> = {
    "大量「标题头 + 正文」后接一个带 ▲ 的面板": (n) =>
      `${"▶ 🔧 修复登录\n请 review\n".repeat(n)}▶ 💭 思考\n  x\n▲\nb`,
    "大量标题头紧挨着、最后一个带 ▲": (n) => `${"▶ 🔧 x\n".repeat(n)}  内容\n▲\n`,
    "复现形态重复": (n) => "a\n▶ 🔧 修复登录\n请 review\n▶ 💭 思考\n  x\n▲\nb\n".repeat(n),
    "大量带 ▲ 的真面板": (n) => "▶ 💭 t\n  x\n▲\n".repeat(n),
  };
  for (const [name, build] of Object.entries(cases)) {
    it(name, () => {
      const ratio = doublingRatio((n) => {
        const raw = build(n);
        return () => sanitizeInboundCardText(raw);
      }, 4000, { trials: 9 });
      expect(ratio).toBeLessThan(LINEAR_RATIO_MAX);
    });
  }
});
