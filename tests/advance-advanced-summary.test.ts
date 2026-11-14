/**
 * 推进弹窗「高级选项」折叠头摘要（lib/advance-advanced-summary）：
 * 适用项判定 + 各取值组合下的摘要文案 / 强调标记。
 *
 * 钉死的口径：
 *  - 没选中 action → 无适用项（整区不渲染、不出空折叠）；removeSourceBranch 只在 ship 出现
 *  - 摘要顺序固定：续用 → 提供方 → 模型 → 删源分支
 *  - 强调（emphasized）：续用偏离设置页默认（双向）、模型 / 思考档偏离打开瞬间默认、没选模型、
 *    弹窗内换了提供方、开了「合并后删源分支」（不看默认值，不可逆倾向每次都标）
 *  - 续用时不列提供方 / 模型（续接旧会话不能换模型，列出来反而误导）
 */
import { describe, expect, it } from "vitest";

import {
  buildAdvancedSummary,
  formatAdvancedSummary,
  hasAdvancedItems,
  resolveAdvancedItems,
  type AdvancedSummaryInput,
} from "@/lib/advance-advanced-summary";
import type { ActionType } from "@/lib/types";

const ALL_ACTIONS: ActionType[] = ["plan", "build", "review", "ship", "dev", "custom"];

/** 默认形态：review、新 agent、模型 = 打开瞬间默认、没换提供方、保留源分支 */
const input = (over: Partial<AdvancedSummaryInput> = {}): AdvancedSummaryInput => ({
  actionType: "review",
  reuseAgent: false,
  reuseAgentDefault: false,
  providerChanged: false,
  providerLabel: "",
  model: { id: "sonnet-5" },
  defaultModel: { id: "sonnet-5" },
  modelLabel: "sonnet-5",
  thinkingLabel: null,
  removeSourceBranch: false,
  ...over,
});

const texts = (over?: Partial<AdvancedSummaryInput>) =>
  buildAdvancedSummary(input(over)).map((s) => s.text);
const emphasizedKeys = (over?: Partial<AdvancedSummaryInput>) =>
  buildAdvancedSummary(input(over))
    .filter((s) => s.emphasized)
    .map((s) => s.key);

describe("resolveAdvancedItems / hasAdvancedItems：高级区适用项", () => {
  it("没选中 action（全部被隐藏）：没有任何适用项，整区不渲染", () => {
    const items = resolveAdvancedItems(null);
    expect(items).toEqual({ agentRuntime: false, removeSourceBranch: false });
    expect(hasAdvancedItems(items)).toBe(false);
  });

  it.each(ALL_ACTIONS)("%s：续用 + 模型这块运行参数都适用（payload 对每个已选 action 都带）", (type) => {
    const items = resolveAdvancedItems(type);
    expect(items.agentRuntime).toBe(true);
    expect(hasAdvancedItems(items)).toBe(true);
  });

  it("合并后删源分支只有 ship 适用（其它 action 提交时 payload 里本就是 undefined）", () => {
    for (const type of ALL_ACTIONS) {
      expect(resolveAdvancedItems(type).removeSourceBranch, type).toBe(type === "ship");
    }
  });

  it("只有 removeSourceBranch 适用也算有内容（将来 agentRuntime 对某类 action 关掉时的组合）", () => {
    expect(hasAdvancedItems({ agentRuntime: false, removeSourceBranch: true })).toBe(true);
    expect(hasAdvancedItems({ agentRuntime: true, removeSourceBranch: false })).toBe(true);
  });
});

describe("buildAdvancedSummary：文案", () => {
  it("没选中 action → 空摘要", () => {
    expect(buildAdvancedSummary(input({ actionType: null }))).toEqual([]);
  });

  it("review 默认：新 agent + 模型，没有删源分支段，且全部不强调", () => {
    const segs = buildAdvancedSummary(input());
    expect(segs.map((s) => s.key)).toEqual(["reuse", "model"]);
    expect(segs.map((s) => s.text)).toEqual(["新 agent", "sonnet-5"]);
    expect(segs.every((s) => !s.emphasized)).toBe(true);
  });

  it("ship 默认：多出「合并后保留源分支」，仍不强调", () => {
    const segs = buildAdvancedSummary(input({ actionType: "ship" }));
    expect(segs.map((s) => s.text)).toEqual(["新 agent", "sonnet-5", "合并后保留源分支"]);
    expect(segs.every((s) => !s.emphasized)).toBe(true);
  });

  it("非 ship 的 action 不出现删源分支段，哪怕 state 里 removeSourceBranch=true（它在别的 action 下不提交）", () => {
    for (const type of ALL_ACTIONS.filter((t) => t !== "ship")) {
      const segs = buildAdvancedSummary(input({ actionType: type, removeSourceBranch: true }));
      expect(segs.map((s) => s.key), type).not.toContain("removeSource");
    }
  });

  it("模型带思考档：「模型（档位）」", () => {
    expect(texts({ thinkingLabel: "high" })).toEqual(["新 agent", "sonnet-5（high）"]);
    // 空白档位当没有
    expect(texts({ thinkingLabel: "  " })).toEqual(["新 agent", "sonnet-5"]);
  });

  it("modelLabel 为空串时回退用模型 id（列表没拉到、没有展示名）", () => {
    expect(texts({ modelLabel: "", model: { id: "raw-id" }, defaultModel: { id: "raw-id" } })).toEqual([
      "新 agent",
      "raw-id",
    ]);
  });

  it("续用：只剩「续用当前 agent」（续接旧会话不能换模型，不列模型 / 提供方）", () => {
    const segs = buildAdvancedSummary(input({ reuseAgent: true, reuseAgentDefault: true }));
    expect(segs.map((s) => s.text)).toEqual(["续用当前 agent"]);
  });

  it("续用 + ship：续用 / 删源分支两段", () => {
    expect(texts({ actionType: "ship", reuseAgent: true, reuseAgentDefault: true })).toEqual([
      "续用当前 agent",
      "合并后保留源分支",
    ]);
  });

  it("换了提供方：多一段「提供方 X」排在模型前", () => {
    const segs = buildAdvancedSummary(
      input({
        providerChanged: true,
        providerLabel: "DeepSeek",
        model: { id: "deepseek-chat" },
        modelLabel: "deepseek-chat",
      }),
    );
    expect(segs.map((s) => s.key)).toEqual(["reuse", "provider", "model"]);
    expect(segs.map((s) => s.text)).toEqual(["新 agent", "提供方 DeepSeek", "deepseek-chat"]);
  });

  it("提供方名过长截断（自建提供方名字不受控，摘要挤在一行里）", () => {
    const label = "一个特别特别特别长的自建提供方名字";
    const seg = buildAdvancedSummary(input({ providerChanged: true, providerLabel: label })).find(
      (s) => s.key === "provider",
    );
    expect(seg?.text).toBe(`提供方 ${label.slice(0, 12)}…`);
  });

  it("没换提供方时不出现提供方段（providerLabel 传什么都不影响）", () => {
    expect(buildAdvancedSummary(input({ providerChanged: false, providerLabel: "DeepSeek" })).map((s) => s.key)).toEqual([
      "reuse",
      "model",
    ]);
  });

  it("没选模型：「未选模型」，不管 modelLabel / thinkingLabel 传了什么", () => {
    expect(
      texts({ model: { id: "" }, defaultModel: { id: "" }, modelLabel: "x", thinkingLabel: "high" }),
    ).toEqual(["新 agent", "未选模型"]);
    expect(texts({ model: { id: "  " }, defaultModel: { id: "" } })).toEqual(["新 agent", "未选模型"]);
  });
});

describe("buildAdvancedSummary：强调（偏离默认 / 不可逆倾向）", () => {
  it("全是默认值：没有任何强调", () => {
    expect(emphasizedKeys()).toEqual([]);
    expect(emphasizedKeys({ actionType: "ship" })).toEqual([]);
  });

  it("续用与设置页默认不同：强调（双向——默认续用时改成新 agent 也标）", () => {
    expect(emphasizedKeys({ reuseAgent: true, reuseAgentDefault: false })).toEqual(["reuse"]);
    expect(emphasizedKeys({ reuseAgent: false, reuseAgentDefault: true })).toEqual(["reuse"]);
  });

  it("续用与默认一致（设置页默认就是续用）：不强调", () => {
    expect(emphasizedKeys({ reuseAgent: true, reuseAgentDefault: true })).toEqual([]);
  });

  it("模型换了 id：强调模型段", () => {
    expect(emphasizedKeys({ model: { id: "opus-4" }, modelLabel: "opus-4" })).toEqual(["model"]);
  });

  it("模型 id 没变、思考档 params 变了：也强调（effort 这类参数改过要看得出）", () => {
    expect(
      emphasizedKeys({
        model: { id: "sonnet-5", params: [{ id: "thinking", value: "high" }] },
        thinkingLabel: "high",
      }),
    ).toEqual(["model"]);
  });

  it("params 只是顺序不同：不算换了模型（按 id 排序后比对）", () => {
    const a = [
      { id: "effort", value: "high" },
      { id: "thinking", value: "true" },
    ];
    const b = [...a].reverse();
    expect(emphasizedKeys({ model: { id: "m", params: a }, defaultModel: { id: "m", params: b } })).toEqual([]);
  });

  it("没选模型：强调（提交会被拦，需要用户处理）——即使默认本来就是空", () => {
    expect(emphasizedKeys({ model: { id: "" }, defaultModel: { id: "" } })).toEqual(["model"]);
  });

  it("换了提供方：提供方段一律强调；模型回到新家默认也随之偏离，一并强调", () => {
    expect(
      emphasizedKeys({
        providerChanged: true,
        providerLabel: "DeepSeek",
        model: { id: "deepseek-chat" },
        modelLabel: "deepseek-chat",
      }),
    ).toEqual(["provider", "model"]);
  });

  it("开了合并后删源分支：强调（不可逆倾向）", () => {
    expect(emphasizedKeys({ actionType: "ship", removeSourceBranch: true })).toEqual(["removeSource"]);
    const seg = buildAdvancedSummary(input({ actionType: "ship", removeSourceBranch: true })).find(
      (s) => s.key === "removeSource",
    );
    expect(seg?.text).toBe("合并后删除源分支");
  });

  it("多项同时偏离：各自独立强调", () => {
    expect(
      emphasizedKeys({
        actionType: "ship",
        reuseAgent: false,
        reuseAgentDefault: true,
        model: { id: "opus-4" },
        modelLabel: "opus-4",
        removeSourceBranch: true,
      }),
    ).toEqual(["reuse", "model", "removeSource"]);
  });
});

describe("formatAdvancedSummary：纯文本形态", () => {
  it("需求里的示例：高级 · 新 agent · sonnet-5 · 合并后保留源分支", () => {
    expect(formatAdvancedSummary(buildAdvancedSummary(input({ actionType: "ship" })))).toBe(
      "高级 · 新 agent · sonnet-5 · 合并后保留源分支",
    );
  });

  it("续用：高级 · 续用当前 agent", () => {
    expect(
      formatAdvancedSummary(buildAdvancedSummary(input({ reuseAgent: true, reuseAgentDefault: true }))),
    ).toBe("高级 · 续用当前 agent");
  });

  it("空摘要只剩「高级」", () => {
    expect(formatAdvancedSummary([])).toBe("高级");
  });
});
