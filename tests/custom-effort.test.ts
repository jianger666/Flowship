import { describe, expect, it } from "vitest";

import {
  CUSTOM_EFFORT_PARAM_ID,
  DEFAULT_THINKING_VALUE,
  defaultEffortValue,
  parseCatalogThinkingValues,
  parseEffortValues,
  reasoningFieldsFromCatalog,
  thinkingLevelFromParams,
  thinkingLevelMapFromValues,
  resolveThinkingTriggerLabel,
  withCatalogEffort,
} from "@/lib/custom-effort";
import {
  buildModelsDevIndex,
  catalogModelHasImageInput,
  catalogPiInputModalities,
  lookupCatalogReasoning,
} from "@/lib/server/models-dev-catalog";

const lookupOf = (catalog: unknown) => {
  const index = buildModelsDevIndex(catalog);
  return (id: string) => lookupCatalogReasoning(index, id);
};

describe("custom-effort / models.dev", () => {
  it("只从 type=effort 抽档，null / none 收成 off", () => {
    expect(
      parseEffortValues([
        { type: "toggle" },
        { type: "effort", values: [null, "low", "HIGH", "max"] },
      ]),
    ).toEqual(["off", "low", "high", "max"]);
    expect(parseEffortValues([{ type: "toggle" }])).toEqual([]);
    expect(parseEffortValues([])).toEqual([]);
    expect(
      parseEffortValues([{ type: "effort", values: ["none", "high"] }]),
    ).toEqual(["off", "high"]);
  });

  it("没有 effort、有 budget_tokens → high / max；toggle 单独不画", () => {
    expect(
      parseCatalogThinkingValues([
        { type: "toggle" },
        { type: "budget_tokens", max: 262144 },
      ]),
    ).toEqual(["high", "max"]);
    expect(parseCatalogThinkingValues([{ type: "toggle" }])).toEqual([]);
    expect(
      parseCatalogThinkingValues([
        { type: "effort", values: ["low", "medium"] },
        { type: "budget_tokens", max: 1 },
      ]),
    ).toEqual(["low", "medium"]);
  });

  it("目录没命中 / 只有 toggle → 不画 chips", () => {
    const lookup = lookupOf({
      opencode: {
        models: {
          "glm-5": { reasoning: true, reasoning_options: [{ type: "toggle" }] },
        },
      },
    });
    expect(withCatalogEffort([{ id: "unknown-local", displayName: "x" }], lookup)[0]?.parameters).toBeUndefined();
    expect(withCatalogEffort([{ id: "glm-5", displayName: "GLM-5" }], lookup)[0]?.parameters).toBeUndefined();
  });

  it("effort 档前置 Default，文案用英文 value", () => {
    const lookup = lookupOf({
      opencode: {
        models: {
          "gpt-5.6-sol": {
            reasoning: true,
            reasoning_options: [
              {
                type: "effort",
                values: ["none", "low", "medium", "high", "xhigh", "max"],
              },
            ],
          },
          "muse-spark-1.2": {
            reasoning: true,
            reasoning_options: [
              { type: "effort", values: ["minimal", "low", "medium", "high", "xhigh"] },
            ],
          },
        },
      },
    });
    const sol = withCatalogEffort([{ id: "gpt-5.6-sol", displayName: "Sol" }], lookup)[0];
    expect(sol?.parameters?.[0]?.id).toBe("thinking");
    expect(sol?.parameters?.[0]?.displayName).toBe("thinking");
    expect(sol?.parameters?.[0]?.values.map((v) => v.value)).toEqual([
      "default",
      "off",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(sol?.parameters?.[0]?.values.map((v) => v.displayName)).toEqual([
      "Default",
      "off",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(sol?.variants?.[0]?.params).toEqual([
      { id: CUSTOM_EFFORT_PARAM_ID, value: DEFAULT_THINKING_VALUE },
    ]);

    const muse = withCatalogEffort(
      [{ id: "muse-spark-1.2", displayName: "Muse" }],
      lookup,
    )[0];
    expect(muse?.parameters?.[0]?.values.map((v) => v.value)).toEqual([
      "default",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(muse?.variants?.[0]?.params[0]?.value).toBe("default");
  });

  it("budget 模型画 Default / high / max", () => {
    const lookup = lookupOf({
      alibaba: {
        models: {
          "qwen3.7-plus": {
            reasoning: true,
            reasoning_options: [
              { type: "toggle" },
              { type: "budget_tokens", max: 262144 },
            ],
          },
        },
      },
    });
    const plus = withCatalogEffort(
      [{ id: "qwen3.7-plus", displayName: "Qwen3.7 Plus" }],
      lookup,
    )[0];
    expect(plus?.parameters?.[0]?.values.map((v) => v.value)).toEqual([
      "default",
      "high",
      "max",
    ]);
  });

  it("已有 thinking/effort 的条目不重复补，只规范化 Default", () => {
    const out = withCatalogEffort(
      [
        {
          id: "x",
          displayName: "x",
          parameters: [{ id: "thinking", values: [{ value: "high" }] }],
        },
      ],
      () => ({
        providerId: "opencode",
        reasoning: true,
        effortValues: ["low", "high"],
      }),
    );
    expect(out[0]?.parameters).toHaveLength(1);
    expect(out[0]?.parameters?.[0]?.values.map((v) => v.value)).toEqual([
      "default",
      "high",
    ]);
  });

  it("同 id 优先 opencode，斜杠 id 也能对上尾巴", () => {
    const index = buildModelsDevIndex({
      openrouter: {
        models: {
          "gpt-5.6-sol": {
            reasoning: true,
            reasoning_options: [{ type: "effort", values: ["low"] }],
          },
        },
      },
      opencode: {
        models: {
          "gpt-5.6-sol": {
            reasoning: true,
            reasoning_options: [{ type: "effort", values: ["none", "max"] }],
          },
        },
      },
    });
    expect(lookupCatalogReasoning(index, "gpt-5.6-sol")?.effortValues).toEqual([
      "off",
      "max",
    ]);
    expect(lookupCatalogReasoning(index, "openai/gpt-5.6-sol")?.effortValues).toEqual([
      "off",
      "max",
    ]);
  });

  it("图像能力：attachment 或 modalities.input 含 image 即标多模态", () => {
    expect(
      catalogModelHasImageInput({
        attachment: true,
        modalities: { input: ["text"] },
      }),
    ).toBe(true);
    expect(
      catalogModelHasImageInput({
        attachment: false,
        modalities: { input: ["text", "image", "video"] },
      }),
    ).toBe(true);
    expect(
      catalogModelHasImageInput({
        attachment: false,
        modalities: { input: ["text"] },
      }),
    ).toBe(false);
    expect(catalogModelHasImageInput(null)).toBe(false);
    expect(catalogPiInputModalities(true)).toEqual(["text", "image"]);
    expect(catalogPiInputModalities(false)).toEqual(["text"]);
    expect(catalogPiInputModalities(undefined)).toEqual(["text"]);
  });

  it("glm-5.3-flash 式条目标多模态；纯文本 glm-5.3 不标", () => {
    const index = buildModelsDevIndex({
      zai: {
        models: {
          "glm-5.3-flash": {
            attachment: true,
            modalities: { input: ["text", "image", "video"] },
          },
          "glm-5.3": {
            attachment: false,
            modalities: { input: ["text"] },
          },
        },
      },
    });
    expect(lookupCatalogReasoning(index, "glm-5.3-flash")?.imageInput).toBe(true);
    expect(lookupCatalogReasoning(index, "glm-5.3")?.imageInput).toBe(false);
    expect(lookupCatalogReasoning(index, "unknown-local")?.imageInput).toBeUndefined();
  });

  it("同 id 图像能力 OR：huggingface 纯文本盖不掉官方多模态", () => {
    const hfThenOfficial = buildModelsDevIndex({
      huggingface: {
        models: {
          "glm-5.3-flash": {
            attachment: false,
            modalities: { input: ["text"] },
            reasoning: true,
            reasoning_options: [{ type: "effort", values: ["low"] }],
          },
        },
      },
      zai: {
        models: {
          "glm-5.3-flash": {
            attachment: true,
            modalities: { input: ["text", "image"] },
            reasoning: true,
            reasoning_options: [{ type: "effort", values: ["none", "max"] }],
          },
        },
      },
    });
    expect(lookupCatalogReasoning(hfThenOfficial, "glm-5.3-flash")?.imageInput).toBe(
      true,
    );

    const officialThenWorse = buildModelsDevIndex({
      zhipuai: {
        models: {
          "glm-5.3-flash": {
            attachment: false,
            modalities: { input: ["text"] },
            reasoning: true,
            reasoning_options: [{ type: "effort", values: ["high"] }],
          },
        },
      },
      huggingface: {
        models: {
          "glm-5.3-flash": {
            attachment: true,
            modalities: { input: ["text", "image"] },
          },
        },
      },
    });
    const hit = lookupCatalogReasoning(officialThenWorse, "glm-5.3-flash");
    expect(hit?.imageInput).toBe(true);
    // 档位仍跟更高优先级的 zhipuai，不跟 huggingface
    expect(hit?.providerId).toBe("zhipuai");
    expect(hit?.effortValues).toEqual(["high"]);
  });

  it("thinkingLevelMap：没有的档写 null，有 none 才允许关", () => {
    expect(thinkingLevelMapFromValues(["high", "max"])).toEqual({
      off: null,
      minimal: null,
      low: null,
      medium: null,
      high: "high",
      xhigh: null,
      max: "max",
    });
    expect(thinkingLevelMapFromValues(["none", "low"])?.off).toBe("none");
  });

  it("目录没有 → reasoning false；有思考无档 → 开思考但不带 map", () => {
    expect(reasoningFieldsFromCatalog(null)).toEqual({ reasoning: false });
    expect(
      reasoningFieldsFromCatalog({
        providerId: "opencode",
        reasoning: true,
        effortValues: [],
      }),
    ).toEqual({ reasoning: true });
    expect(
      reasoningFieldsFromCatalog({
        providerId: "opencode",
        reasoning: true,
        effortValues: ["high", "max"],
      }).thinkingLevelMap?.max,
    ).toBe("max");
  });

  it("Default / 没带档 → 不传 thinkingLevel，不再回落到第一档", () => {
    expect(thinkingLevelFromParams()).toBeUndefined();
    expect(
      thinkingLevelFromParams([{ id: "thinking", value: "default" }]),
    ).toBeUndefined();
    expect(thinkingLevelFromParams([{ id: "thinking", value: "high" }])).toBe("high");
    expect(thinkingLevelFromParams([{ id: "effort", value: "high" }])).toBe("high");
    expect(thinkingLevelFromParams([{ id: "effort", value: "none" }])).toBe("off");
    expect(thinkingLevelFromParams([{ id: "thinking", value: "off" }])).toBe("off");
    expect(
      thinkingLevelFromParams([{ id: "effort", value: "xhigh" }], ["high", "max"]),
    ).toBeUndefined();
    expect(defaultEffortValue(["minimal", "low", "high"])).toBe("default");
    expect(defaultEffortValue([])).toBeUndefined();
  });

  it("trigger 常显思考档：没写进 params 的 Default 也要标，不能只靠截断后的模型名", () => {
    const custom = {
      parameters: [
        {
          id: "thinking",
          values: [
            { value: "default" },
            { value: "low" },
            { value: "high" },
          ],
        },
      ],
    };
    expect(resolveThinkingTriggerLabel(custom, undefined, false)).toBe("Default");
    expect(
      resolveThinkingTriggerLabel(
        custom,
        [{ id: "thinking", value: "default" }],
        false,
      ),
    ).toBe("Default");
    expect(
      resolveThinkingTriggerLabel(custom, [{ id: "thinking", value: "high" }], false),
    ).toBe("high");
    expect(resolveThinkingTriggerLabel({ parameters: [] }, undefined, false)).toBeNull();

    const cursor = {
      parameters: [
        {
          id: "thinking",
          values: [
            { value: "none", displayName: "None" },
            { value: "medium", displayName: "Medium" },
            { value: "xhigh", displayName: "Extra High" },
          ],
        },
      ],
      variants: [
        {
          displayName: "default",
          isDefault: true,
          params: [{ id: "thinking", value: "none" }],
        },
      ],
    };
    expect(resolveThinkingTriggerLabel(cursor, undefined, true)).toBe("None");
    expect(
      resolveThinkingTriggerLabel(
        cursor,
        [{ id: "thinking", value: "xhigh" }],
        true,
      ),
    ).toBe("Extra High");
  });
});
