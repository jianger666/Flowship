import { describe, expect, it } from "vitest";

import {
  replaceOpenIdPlaceholders,
  sanitizeInboundCardText,
  stripAgentPanels,
  stripCardFooter,
} from "@/lib/server/feishu-bridge/inbound-card-sanitize";
import { extractInteractiveText } from "@/lib/server/route-helpers";

const PANEL_CARD = `<card>
我先拉取项目信息和审查节点的完整提示词。
▶ 💭 思考了 0.3s
    I should check git status, log, and diff stat against release/1.36.1, using pwsh with small output.
▲
审查范围是 feature 分支相对 \`release/1.36.1\` 的全部改动。先看工作区状态和改动规模。
▶ 🛠️ 工具执行 · 1 步
    📝 **shell** · Succeeded
    📝 pwsh.exe -NoLogo -NoProfile -Command 'git status --short; "---"; git branch --show-current'
▲
▼ 💭 思考了 2.3s
    The branch comparison shows HEAD has 31 commits ahead of release/1.36.1 ...
▲
本地 \`release/1.36.1\` 引用已经落后，改用 \`origin/release/1.36.1\` 作为基线重新算。
▼ 🛠️ 工具执行 · 2 步
    📝 **edit** · Succeeded
    📝 **shell** · Running
▲
</card>`;

describe("stripAgentPanels", () => {
  it("真实样例：只留面板外正文", () => {
    expect(extractInteractiveText(PANEL_CARD)).toBe(
      [
        "我先拉取项目信息和审查节点的完整提示词。",
        "审查范围是 feature 分支相对 `release/1.36.1` 的全部改动。先看工作区状态和改动规模。",
        "本地 `release/1.36.1` 引用已经落后，改用 `origin/release/1.36.1` 作为基线重新算。",
      ].join("\n"),
    );
  });

  it("无配对 ▲（流式截断）：从面板头剥到文末", () => {
    expect(stripAgentPanels("hi\n▶ 💭 思考中\n  abc\n  def")).toBe("hi");
  });

  it("孤立 ▲ 清掉；多余空行压成 2 个换行", () => {
    expect(stripAgentPanels("a\n▲\n\n\n\nb")).toBe("a\n\nb");
  });

  it("面板外 markdown 的 --- 与正文不动", () => {
    const t = "标题\n\n---\n\n正文 ▶ 不在行首";
    expect(stripAgentPanels(t)).toBe(t);
  });
});

describe("stripCardFooter", () => {
  it("模型名 · 耗时页脚", () => {
    expect(
      stripCardFooter(
        "@李安 技术方案已经补上\n---\nclaude-sonnet-5-5-300k-xhigh · 5m14s",
      ),
    ).toBe("@李安 技术方案已经补上");
  });

  it("仅耗时页脚（--- 后带空白、多个 -）", () => {
    expect(stripCardFooter("这条不是新问题。\n--- \n12s")).toBe("这条不是新问题。");
    expect(stripCardFooter("x\n-----\n0.3s\n")).toBe("x");
  });

  it("业务状态行 + 按钮：只剥按钮，状态行保留", () => {
    const t = "**📦 【排课2.0】花果排课效率优化**\n🌿 feature/260917\n---\n🚀 已启动审查\n项目：【排课2.0】花果排课效率优化\n[✕ 关闭]";
    expect(stripCardFooter(t)).toBe(
      "**📦 【排课2.0】花果排课效率优化**\n🌿 feature/260917\n---\n🚀 已启动审查\n项目：【排课2.0】花果排课效率优化",
    );
  });

  it("正文中间的 --- 与 --- 后长文本不误剥", () => {
    const t = "a\n---\nb 12s 之后继续\n\n---\n" + "很长的正文".repeat(30);
    expect(stripCardFooter(t)).toBe(t);
    expect(stripCardFooter("a\n---\n后面是 2s 的说明")).toBe("a");
  });

  it("按钮行：[xxx] / [× xxx]；过长不剥", () => {
    expect(stripCardFooter("hi\n[× 取消]")).toBe("hi");
    expect(stripCardFooter("hi\n[确认]")).toBe("hi");
    const long = `[${"x".repeat(40)}]`;
    expect(stripCardFooter(`hi\n${long}`)).toBe(`hi\n${long}`);
  });
});

describe("replaceOpenIdPlaceholders", () => {
  const id = "ou_3c5a3c78eadf40138676d3f268503064";
  it("裸占位：resolve 到名字", () => {
    expect(replaceOpenIdPlaceholders(`请 @${id} 看`, (o) => (o === id ? "李安" : undefined))).toBe("请 @李安 看");
  });
  it("裸占位：resolve 不出 → @某成员", () => {
    expect(replaceOpenIdPlaceholders(`@${id}`, () => undefined)).toBe("@某成员");
  });
  it("带名字：去掉括号 id（半角 / 全角）", () => {
    expect(replaceOpenIdPlaceholders("@李安(ou_dd96…) 好", () => undefined)).toBe("@李安 好");
    expect(replaceOpenIdPlaceholders("@李安（ou_dd96abcdef）好", () => undefined)).toBe("@李安好");
  });
});

describe("sanitizeInboundCardText / extractInteractiveText", () => {
  it("组合：面板 + 页脚 + open_id", () => {
    const raw = "@李安(ou_dd96…) 好了\n▶ 💭 思考了 1s\n  x\n▲\n---\nmodel · 5m14s";
    expect(sanitizeInboundCardText(raw)).toBe("@李安 好了");
  });

  it("全是面板 → 空 / null", () => {
    expect(sanitizeInboundCardText("▶ 💭 思考\n  x\n▲")).toBe("");
    expect(extractInteractiveText("<card>\n▶ 💭 思考\n  x\n▲\n</card>")).toBeNull();
  });

  it("面板含 < > 不会误吞面板外正文；正文里的 tag 仍被剥", () => {
    const t = extractInteractiveText("<card>\n▶ 思考\n  if a < b then\n▲\n<b>结论</b> c > d\n</card>");
    expect(t).toBe("结论 c > d");
  });

  it("结束态样例", () => {
    expect(
      extractInteractiveText("<card>\n@李安(ou_dd96…) 技术方案已经补上字段……\n---\nclaude-sonnet-5-5-300k-xhigh · 5m14s\n</card>"),
    ).toBe("@李安 技术方案已经补上字段……");
  });

  it("resolveOpenId 透传", () => {
    expect(
      extractInteractiveText("<card>@ou_3c5a3c78eadf40138676d3f268503064 在吗</card>", {
        resolveOpenId: () => "王五",
      }),
    ).toBe("@王五 在吗");
  });

  it("JSON 卡片：collapsible_panel 子树跳过", () => {
    const card = {
      elements: [
        { tag: "markdown", content: "对方的话" },
        { tag: "collapsible_panel", header: { title: { content: "思考" } }, elements: [{ tag: "markdown", content: "内部推理" }] },
        { tag: "markdown", content: "结论" },
      ],
    };
    expect(extractInteractiveText(JSON.stringify(card))).toBe("对方的话\n结论");
  });

  it("20000 截断在净化之后", () => {
    const t = extractInteractiveText(`<card>▶ x\n${"p".repeat(30000)}\n▲\n${"y".repeat(30000)}</card>`);
    expect(t).toBe("y".repeat(20000));
  });
});
