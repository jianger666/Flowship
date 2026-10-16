import { describe, expect, it } from "vitest";

import {
  catalogFromModelOptions,
  currentEffortValue,
  findEffortParam,
  formatModelCatalog,
  isInheritModelArg,
  MODEL_LIST_MAX,
  normalizeSubagentType,
  parseSubagentRequest,
  resolveSubagentModel,
  wantsModelList,
  type ModelCatalogEntry,
} from "@/lib/subagent-spec";
import type { ModelOption } from "@/lib/types";

const CATALOG: ModelCatalogEntry[] = [
  {
    id: "gpt-5",
    displayName: "GPT-5",
    effortParamId: "thinking",
    efforts: ["low", "medium", "high"],
  },
  { id: "plain-model", displayName: "Plain", efforts: [] },
  {
    id: "claude-x",
    displayName: "Claude X",
    effortParamId: "effort",
    efforts: ["off", "high", "max"],
  },
];

const PARENT = {
  id: "gpt-5",
  params: [
    { id: "thinking", value: "high" },
    { id: "other", value: "keep" },
  ],
};

describe("parseSubagentRequest", () => {
  it("prompt 为空 / 缺失 → 报错", () => {
    expect(parseSubagentRequest({})).toEqual({
      ok: false,
      error: "prompt 不能为空",
    });
    expect(parseSubagentRequest({ prompt: "   " }).ok).toBe(false);
    expect(parseSubagentRequest(null).ok).toBe(false);
    expect(parseSubagentRequest("x").ok).toBe(false);
  });

  it("字符串字段 trim；空串当没填；非字符串忽略", () => {
    const r = parseSubagentRequest({
      prompt: "  干活  ",
      description: " 描述 ",
      model: "  ",
      effort: 3,
      subagentType: "explore",
    });
    expect(r).toEqual({
      ok: true,
      request: {
        prompt: "干活",
        description: "描述",
        subagentType: "explore",
        model: undefined,
        effort: undefined,
      },
    });
  });
});

describe("normalizeSubagentType", () => {
  it("只有 explore / readonly 收成 explore，其余（含 Cursor 习惯名）都是 general", () => {
    expect(normalizeSubagentType("explore")).toBe("explore");
    expect(normalizeSubagentType(" Explore ")).toBe("explore");
    expect(normalizeSubagentType("readonly")).toBe("explore");
    expect(normalizeSubagentType("generalPurpose")).toBe("general");
    expect(normalizeSubagentType("shell")).toBe("general");
    expect(normalizeSubagentType(undefined)).toBe("general");
    expect(normalizeSubagentType(42)).toBe("general");
  });
});

describe("resolveSubagentModel · 沿用当前模型", () => {
  it("缺省：模型和当前思考档都沿用", () => {
    expect(resolveSubagentModel({}, PARENT, CATALOG)).toEqual({
      ok: true,
      inherited: true,
      model: { id: "gpt-5", params: PARENT.params },
    });
  });

  it("inherit（大小写不敏感）与填成当前模型 id 都算沿用", () => {
    for (const model of ["inherit", "INHERIT", "gpt-5", "GPT-5"]) {
      const r = resolveSubagentModel({ model }, PARENT, CATALOG);
      expect(r.ok && r.inherited).toBe(true);
      expect(r.ok && r.model.id).toBe("gpt-5");
    }
  });

  it("沿用 + effort：只替换思考档，其它参数保留", () => {
    const r = resolveSubagentModel({ effort: "low" }, PARENT, CATALOG);
    expect(r).toEqual({
      ok: true,
      inherited: true,
      effort: "low",
      model: {
        id: "gpt-5",
        params: [
          { id: "other", value: "keep" },
          { id: "thinking", value: "low" },
        ],
      },
    });
  });

  it("没有父 params 也能沿用", () => {
    const r = resolveSubagentModel({}, { id: "gpt-5" }, CATALOG);
    expect(r).toEqual({ ok: true, inherited: true, model: { id: "gpt-5" } });
  });
});

describe("resolveSubagentModel · 指定其它模型", () => {
  it("换模型：用目录里的规范 id，不把父会话的思考档硬套过去", () => {
    const r = resolveSubagentModel({ model: "CLAUDE-X" }, PARENT, CATALOG);
    expect(r).toEqual({
      ok: true,
      inherited: false,
      model: { id: "claude-x" },
    });
  });

  it("displayName 唯一匹配也认", () => {
    const r = resolveSubagentModel({ model: "claude x" }, PARENT, CATALOG);
    expect(r.ok && r.model.id).toBe("claude-x");
  });

  it("displayName 重名 → 不猜，当没找到", () => {
    const dup: ModelCatalogEntry[] = [
      { id: "a-1", displayName: "Same", efforts: [] },
      { id: "a-2", displayName: "Same", efforts: [] },
    ];
    const r = resolveSubagentModel({ model: "Same" }, { id: "a-1" }, dup);
    expect(r.ok).toBe(false);
  });

  it("换模型 + effort：用目标模型自己的参数 id 与档位", () => {
    const r = resolveSubagentModel(
      { model: "claude-x", effort: "MAX" },
      PARENT,
      CATALOG,
    );
    expect(r).toEqual({
      ok: true,
      inherited: false,
      effort: "max",
      model: { id: "claude-x", params: [{ id: "effort", value: "max" }] },
    });
  });

  it("目录里没有的模型 → 报错并列出可选项（不静默回退到当前模型）", () => {
    const r = resolveSubagentModel({ model: "nope-9" }, PARENT, CATALOG);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("「nope-9」");
    expect(r.error).toContain("- gpt-5");
    expect(r.error).toContain("- claude-x");
    expect(r.error).toContain("inherit");
  });
});

describe("resolveSubagentModel · effort 校验", () => {
  it("default / 空 = 不覆盖（沿用时保留父档位）", () => {
    for (const effort of ["default", "DEFAULT", "  "]) {
      const r = resolveSubagentModel({ effort }, PARENT, CATALOG);
      expect(r).toEqual({
        ok: true,
        inherited: true,
        model: { id: "gpt-5", params: PARENT.params },
      });
    }
  });

  it("档位不在目标模型支持范围 → 报错并列出可选档", () => {
    const r = resolveSubagentModel({ effort: "xhigh" }, PARENT, CATALOG);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("xhigh");
    expect(r.error).toContain("low | medium | high");
  });

  it("目标模型没有 effort 参数 → 报错，不静默丢掉", () => {
    const r = resolveSubagentModel(
      { model: "plain-model", effort: "high" },
      PARENT,
      CATALOG,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("plain-model");
    expect(r.error).toContain("没有 effort");
  });

  it("none 当 off（目录里 none 已被收成 off）", () => {
    const r = resolveSubagentModel(
      { model: "claude-x", effort: "none" },
      PARENT,
      CATALOG,
    );
    expect(r.ok && r.effort).toBe("off");
  });
});

describe("resolveSubagentModel · 拿不到目录", () => {
  it("catalog=null：model id 原样放行（自定义端点常有清单外的可用 id）", () => {
    const r = resolveSubagentModel({ model: "whatever-v2" }, PARENT, null);
    expect(r).toEqual({
      ok: true,
      inherited: false,
      model: { id: "whatever-v2" },
    });
  });

  it("catalog=null + effort：按通用档集合校验，参数 id 用 thinking", () => {
    const ok = resolveSubagentModel(
      { model: "whatever-v2", effort: "xhigh" },
      PARENT,
      null,
    );
    expect(ok).toEqual({
      ok: true,
      inherited: false,
      effort: "xhigh",
      model: { id: "whatever-v2", params: [{ id: "thinking", value: "xhigh" }] },
    });
    const bad = resolveSubagentModel(
      { model: "whatever-v2", effort: "ultra" },
      PARENT,
      null,
    );
    expect(bad.ok).toBe(false);
  });

  it("catalog 非空但当前模型不在其中：沿用 + effort 退回通用档校验", () => {
    const r = resolveSubagentModel(
      { effort: "medium" },
      { id: "ghost-model" },
      CATALOG,
    );
    expect(r.ok && r.model).toEqual({
      id: "ghost-model",
      params: [{ id: "thinking", value: "medium" }],
    });
  });
});

describe("catalogFromModelOptions", () => {
  it("抽出 thinking / effort 参数，去掉 default 档；没有该参数 = efforts 为空", () => {
    const options: ModelOption[] = [
      {
        id: "m1",
        displayName: "M1",
        parameters: [
          {
            id: "thinking",
            values: [
              { value: "default" },
              { value: "low" },
              { value: "high" },
            ],
          },
          { id: "fast", values: [{ value: "true" }, { value: "false" }] },
        ],
      },
      {
        id: "m2",
        displayName: "M2",
        parameters: [{ id: "effort", values: [{ value: "medium" }] }],
      },
      { id: "m3", displayName: "M3" },
      {
        id: "m4",
        displayName: "M4",
        parameters: [{ id: "thinking", values: [{ value: "default" }] }],
      },
    ];
    expect(catalogFromModelOptions(options)).toEqual([
      { id: "m1", displayName: "M1", effortParamId: "thinking", efforts: ["low", "high"] },
      { id: "m2", displayName: "M2", effortParamId: "effort", efforts: ["medium"] },
      { id: "m3", displayName: "M3", efforts: [] },
      // 只有 default 一档 = 没有可调的档
      { id: "m4", displayName: "M4", efforts: [] },
    ]);
  });
});

describe("formatModelCatalog / wantsModelList", () => {
  it("每行 id（显示名）· effort 档；displayName 与 id 相同不重复", () => {
    const text = formatModelCatalog([
      CATALOG[0],
      { id: "same", displayName: "same", efforts: [] },
    ]);
    expect(text).toBe("- gpt-5（GPT-5） · effort: low | medium | high\n- same");
  });

  it("超过上限只列前 N 条并写明还有多少", () => {
    const many: ModelCatalogEntry[] = Array.from(
      { length: MODEL_LIST_MAX + 7 },
      (_, i) => ({ id: `m-${i}`, efforts: [] }),
    );
    const lines = formatModelCatalog(many).split("\n");
    expect(lines).toHaveLength(MODEL_LIST_MAX + 1);
    expect(lines[lines.length - 1]).toBe("…另有 7 个未列出");
  });

  it("wantsModelList 只认 list（大小写 / 空白不敏感）", () => {
    expect(wantsModelList("list")).toBe(true);
    expect(wantsModelList(" LIST ")).toBe(true);
    expect(wantsModelList("inherit")).toBe(false);
    expect(wantsModelList(undefined)).toBe(false);
  });
});

/** 2026-10-13 对真实 Cursor 账号 `Cursor.models.list` 实测的参数形状（只留与 effort 相关的） */
const cursorOptions = (): ModelOption[] => {
  const vals = (...v: string[]) => v.map((value) => ({ value }));
  return [
    {
      id: "claude-sonnet-5-5",
      displayName: "Claude Sonnet 5.5",
      parameters: [
        { id: "context", values: vals("300k", "1m") },
        { id: "reasoning_effort", values: vals("low", "medium", "high", "xhigh", "max") },
      ],
    },
    {
      id: "claude-sonnet-5",
      displayName: "Claude Sonnet 5",
      parameters: [
        { id: "thinking", values: vals("false", "true") },
        { id: "effort", values: vals("low", "medium", "high", "xhigh", "max") },
      ],
    },
    {
      id: "claude-sonnet-4-5",
      displayName: "Claude Sonnet 4.5",
      parameters: [{ id: "thinking", values: vals("false", "true") }],
    },
    {
      id: "composer-2.5",
      displayName: "Composer 2.5",
      parameters: [{ id: "fast", values: vals("false", "true") }],
    },
    { id: "gemini-3.1-pro", displayName: "Gemini 3.1 Pro" },
  ];
};

describe("Cursor 模型的 effort 参数 id 不统一", () => {
  it("findEffortParam：reasoning_effort > effort > thinking；false|true 开关不算档位", () => {
    const [s55, s5, s45, composer, g31] = cursorOptions();
    expect(findEffortParam(s55.parameters)).toEqual({
      id: "reasoning_effort",
      values: ["low", "medium", "high", "xhigh", "max"],
    });
    // thinking 是开关，effort 才是档位
    expect(findEffortParam(s5.parameters)?.id).toBe("effort");
    // 只有开关 → 没有 effort
    expect(findEffortParam(s45.parameters)).toBeNull();
    expect(findEffortParam(composer.parameters)).toBeNull();
    expect(findEffortParam(g31.parameters)).toBeNull();
    expect(findEffortParam(undefined)).toBeNull();
  });

  it("自定义 provider 的 thinking（low/high 档位）仍然认", () => {
    expect(
      findEffortParam([
        {
          id: "thinking",
          values: [{ value: "default" }, { value: "low" }, { value: "high" }],
        },
      ]),
    ).toEqual({ id: "thinking", values: ["low", "high"] });
  });

  it("catalogFromModelOptions：Sonnet 5.5 带 reasoning_effort 档，Sonnet 4.5 / Composer 没有", () => {
    const cat = catalogFromModelOptions(cursorOptions());
    const byId = Object.fromEntries(cat.map((e) => [e.id, e]));
    expect(byId["claude-sonnet-5-5"].effortParamId).toBe("reasoning_effort");
    expect(byId["claude-sonnet-5-5"].efforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(byId["claude-sonnet-5"].effortParamId).toBe("effort");
    expect(byId["claude-sonnet-4-5"].efforts).toEqual([]);
    expect(byId["claude-sonnet-4-5"].effortParamId).toBeUndefined();
    expect(byId["composer-2.5"].efforts).toEqual([]);
  });

  it("换成 Sonnet 5.5 + effort：用 reasoning_effort 这个参数 id 发出去", () => {
    const cat = catalogFromModelOptions(cursorOptions());
    const r = resolveSubagentModel(
      { model: "claude-sonnet-5-5", effort: "high" },
      { id: "composer-2.5" },
      cat,
    );
    expect(r).toEqual({
      ok: true,
      inherited: false,
      effort: "high",
      model: {
        id: "claude-sonnet-5-5",
        params: [{ id: "reasoning_effort", value: "high" }],
      },
    });
  });

  it("沿用 Sonnet 5 + 改 effort：只替换 effort，thinking 开关与其它参数保留", () => {
    const cat = catalogFromModelOptions(cursorOptions());
    const r = resolveSubagentModel(
      { effort: "max" },
      {
        id: "claude-sonnet-5",
        params: [
          { id: "thinking", value: "true" },
          { id: "effort", value: "low" },
        ],
      },
      cat,
    );
    expect(r.ok && r.model.params).toEqual([
      { id: "thinking", value: "true" },
      { id: "effort", value: "max" },
    ]);
  });

  it("目标是 Composer / Sonnet 4.5（没有档位）却指定 effort → 报错，不把开关当档位", () => {
    const cat = catalogFromModelOptions(cursorOptions());
    for (const model of ["composer-2.5", "claude-sonnet-4-5"]) {
      const r = resolveSubagentModel({ model, effort: "high" }, { id: "claude-sonnet-5-5" }, cat);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain("没有 effort");
    }
  });
});

describe("parseSubagentRequest · resume", () => {
  it("resume 字段：trim；空串 / 纯空白 / 非字符串 = 没填", () => {
    const get = (resume: unknown) => {
      const r = parseSubagentRequest({ prompt: "x", resume });
      if (!r.ok) throw new Error("应解析成功");
      return r.request.resume;
    };
    expect(get("  agent-1  ")).toBe("agent-1");
    expect(get("")).toBeUndefined();
    expect(get("   ")).toBeUndefined();
    expect(get(42)).toBeUndefined();
    expect(get(undefined)).toBeUndefined();
  });

  it("resume 不影响 prompt 必填（接着做也得说清楚做什么）", () => {
    expect(parseSubagentRequest({ resume: "agent-1" }).ok).toBe(false);
  });
});

describe("parseSubagentRequest · run_in_background", () => {
  const get = (v: Record<string, unknown>) => {
    const r = parseSubagentRequest({ prompt: "x", ...v });
    if (!r.ok) throw new Error("应解析成功");
    return r.request.runInBackground;
  };

  it("布尔 true / false 原样收；字符串 \"true\" / \"False\"（模型常把布尔写成字符串）也认", () => {
    expect(get({ run_in_background: true })).toBe(true);
    expect(get({ run_in_background: false })).toBe(false);
    expect(get({ run_in_background: " TRUE " })).toBe(true);
    expect(get({ run_in_background: "False" })).toBe(false);
  });

  it("驼峰别名 runInBackground 也认；蛇形优先", () => {
    expect(get({ runInBackground: true })).toBe(true);
    expect(get({ run_in_background: false, runInBackground: true })).toBe(false);
  });

  it("没填 / 乱填（数字、其它字符串、null）= undefined，不当成 true", () => {
    expect(get({})).toBeUndefined();
    expect(get({ run_in_background: 1 })).toBeUndefined();
    expect(get({ run_in_background: "yes" })).toBeUndefined();
    expect(get({ run_in_background: null })).toBeUndefined();
  });
});

describe("currentEffortValue（卡片徽标：当前思考档）", () => {
  it("取档位型参数的值（reasoning_effort / effort / thinking 都认）", () => {
    expect(currentEffortValue([{ id: "reasoning_effort", value: "high" }])).toBe("high");
    expect(currentEffortValue([{ id: "effort", value: "low" }])).toBe("low");
    expect(currentEffortValue([{ id: "thinking", value: "medium" }])).toBe("medium");
  });

  it("大小写 / 空白不敏感；同时有多个按优先级取、跳过取不出值的", () => {
    expect(currentEffortValue([{ id: " Reasoning_Effort ", value: " High " }])).toBe("High");
    expect(
      currentEffortValue([
        { id: "reasoning_effort", value: "default" },
        { id: "thinking", value: "low" },
      ]),
    ).toBe("low");
  });

  it("开关（true / false）、default、空串、没有该参数、没有参数 → undefined（不硬造档位）", () => {
    expect(currentEffortValue([{ id: "thinking", value: "true" }])).toBeUndefined();
    expect(currentEffortValue([{ id: "thinking", value: "false" }])).toBeUndefined();
    expect(currentEffortValue([{ id: "reasoning_effort", value: "default" }])).toBeUndefined();
    expect(currentEffortValue([{ id: "reasoning_effort", value: "  " }])).toBeUndefined();
    expect(currentEffortValue([{ id: "fast", value: "true" }])).toBeUndefined();
    expect(currentEffortValue([])).toBeUndefined();
    expect(currentEffortValue(undefined)).toBeUndefined();
  });
});

describe("isInheritModelArg（与 resolveSubagentModel 的「沿用」同口径）", () => {
  it("缺省 / null / 空串 / inherit（不分大小写、可带空白）算沿用", () => {
    for (const v of [undefined, null, "", "   ", "inherit", " Inherit ", "INHERIT"]) {
      expect(isInheritModelArg(v)).toBe(true);
    }
  });

  it("具体模型 id、list、非字符串（数字等）不算", () => {
    for (const v of ["claude-sonnet-5-5", "list", "composer-2.5", 3, {}, []]) {
      expect(isInheritModelArg(v)).toBe(false);
    }
  });

  it("与 resolveSubagentModel 对 inherit 的判定一致", () => {
    for (const model of [undefined, "", "inherit", "INHERIT", "gpt-5"]) {
      const resolved = resolveSubagentModel({ model }, PARENT, CATALOG);
      if (!resolved.ok) throw new Error("应解析成功");
      // 缺省 / 空 / inherit → inherited；写成与父同 id 也是 inherited，但那不属于「model 参数缺省」
      if (isInheritModelArg(model)) expect(resolved.inherited).toBe(true);
    }
  });
});
