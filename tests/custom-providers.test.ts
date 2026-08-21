/**
 * 多自定义 provider：读盘迁移 + 窗口 provider 不跟设置页默认走。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  listProviderOptions,
  migrateProviderSettings,
  modelForProviderSwitch,
  isApiKeyFieldPresent,
  isProviderSwitchLocked,
  resolveTaskProvider,
  sessionMatchesProvider,
} from "@/lib/agent-provider";
import {
  customModelListAttempts,
  customSdkBaseUrl,
  formatFromCustomBaseUrl,
  normalizeCustomBaseUrl,
} from "@/lib/custom-provider-url";
import { customProviderHeaders, listCustomModels } from "@/lib/server/custom-provider";
import {
  resetModelsDevCatalogForTest,
  seedModelsDevCatalogForTest,
} from "@/lib/server/models-dev-catalog";
import {
  CURSOR_PROVIDER_ID,
  LEGACY_CUSTOM_PROVIDER_ID,
  defaultModelForProvider,
} from "@/lib/types";

const cursorDefault = { id: "composer-2.5" };
const customDefault = { id: "gpt-4o" };

const oneCustom = {
  id: LEGACY_CUSTOM_PROVIDER_ID,
  name: "OpenCode",
  baseUrl: "https://opencode.ai/zen/go/v1",
  apiKey: "k",
  format: "openai" as const,
  defaultModel: customDefault,
};

describe("migrateProviderSettings", () => {
  it("旧单槽 customProvider 迁成 cp_legacy，provider: custom 改成该 id", () => {
    const out = migrateProviderSettings({
      provider: "custom",
      customProvider: {
        baseUrl: "https://opencode.ai/zen/go/v1",
        apiKey: "k",
        format: "openai",
        defaultModel: customDefault,
      },
    });
    expect(out.provider).toBe(LEGACY_CUSTOM_PROVIDER_ID);
    expect(out.customProviders).toHaveLength(1);
    expect(out.customProviders[0]?.id).toBe(LEGACY_CUSTOM_PROVIDER_ID);
    expect(out.customProviders[0]?.baseUrl).toBe(
      "https://opencode.ai/zen/go/v1",
    );
    expect(out.customProviders[0]?.name).toBe("opencode.ai");
  });

  it("已有 customProviders 时不再吃旧 customProvider", () => {
    const out = migrateProviderSettings({
      provider: "cp_new",
      customProvider: {
        baseUrl: "http://old",
        apiKey: "",
        format: "openai",
      },
      customProviders: [
        {
          id: "cp_new",
          name: "新",
          baseUrl: "http://new",
          apiKey: "",
          format: "openai",
        },
      ],
    });
    expect(out.provider).toBe("cp_new");
    expect(out.customProviders).toHaveLength(1);
    expect(out.customProviders[0]?.baseUrl).toBe("http://new");
  });

  it("provider 指向已删的 id 回退 cursor", () => {
    const out = migrateProviderSettings({
      provider: "cp_gone",
      customProviders: [],
    });
    expect(out.provider).toBe(CURSOR_PROVIDER_ID);
  });

  it("provider 指向没填地址的草稿回退 cursor", () => {
    const out = migrateProviderSettings({
      provider: "cp_draft",
      customProviders: [
        {
          id: "cp_draft",
          name: "草稿",
          baseUrl: "",
          apiKey: "",
          format: "openai",
        },
      ],
    });
    expect(out.provider).toBe(CURSOR_PROVIDER_ID);
  });
});

describe("isProviderSwitchLocked", () => {
  it("空对话还能切，发过消息（有会话锚点）就锁", () => {
    expect(isProviderSwitchLocked({ mode: "chat" })).toBe(false);
    expect(isProviderSwitchLocked({ mode: "chat", sessionAgentId: "" })).toBe(
      false,
    );
    expect(
      isProviderSwitchLocked({ mode: "chat", sessionAgentId: "uuid-1" }),
    ).toBe(true);
  });

  it("任务模式创建后就锁", () => {
    expect(isProviderSwitchLocked({ mode: "task" })).toBe(true);
    expect(isProviderSwitchLocked({})).toBe(true);
  });
});

describe("defaultModelForProvider", () => {
  it("cursor 用 settings.defaultModel", () => {
    expect(
      defaultModelForProvider(
        {
          provider: CURSOR_PROVIDER_ID,
          defaultModel: cursorDefault,
          customProviders: [oneCustom],
        },
        CURSOR_PROVIDER_ID,
      ),
    ).toEqual(cursorDefault);
  });

  it("自定义 id 用那一条的 defaultModel，不回退 Cursor", () => {
    expect(
      defaultModelForProvider(
        {
          provider: LEGACY_CUSTOM_PROVIDER_ID,
          defaultModel: cursorDefault,
          customProviders: [oneCustom],
        },
        LEGACY_CUSTOM_PROVIDER_ID,
      ),
    ).toEqual(customDefault);
  });

  it("自定义未配默认模型返空", () => {
    expect(
      defaultModelForProvider(
        {
          defaultModel: cursorDefault,
          customProviders: [{ ...oneCustom, defaultModel: undefined }],
        },
        LEGACY_CUSTOM_PROVIDER_ID,
      ),
    ).toEqual({ id: "" });
  });
});

describe("resolveTaskProvider", () => {
  const settings = { customProviders: [oneCustom] };

  it("窗口已绑定的 id 不受设置页默认劫持", () => {
    expect(
      resolveTaskProvider(
        { provider: CURSOR_PROVIDER_ID },
        { customProviders: [oneCustom], provider: LEGACY_CUSTOM_PROVIDER_ID } as never,
      ),
    ).toBe(CURSOR_PROVIDER_ID);
    expect(
      resolveTaskProvider(
        { provider: LEGACY_CUSTOM_PROVIDER_ID },
        { customProviders: [oneCustom] },
      ),
    ).toBe(LEGACY_CUSTOM_PROVIDER_ID);
  });

  it("老任务没 provider、有 pi 锚点 → 迁后的自定义", () => {
    expect(
      resolveTaskProvider(
        { sessionAgentId: "/tmp/data/pi-sessions/abc.jsonl" },
        settings,
      ),
    ).toBe(LEGACY_CUSTOM_PROVIDER_ID);
  });

  it("老任务没 provider、也没 pi 锚点 → cursor（即使设置页默认是自定义）", () => {
    expect(resolveTaskProvider({}, settings)).toBe(CURSOR_PROVIDER_ID);
  });

  it("窗口绑的 id 已从列表删掉 → cursor，不偷第一条自定义", () => {
    expect(
      resolveTaskProvider(
        {
          provider: "cp_gone",
          sessionAgentId: "/tmp/data/pi-sessions/abc.jsonl",
        },
        { customProviders: [oneCustom] },
      ),
    ).toBe(CURSOR_PROVIDER_ID);
  });

  it("窗口绑的 id 还在但地址被清空 → 仍是该 id，不偷别的、不改跑 Cursor", () => {
    expect(
      resolveTaskProvider(
        { provider: "cp_draft" },
        {
          customProviders: [
            oneCustom,
            {
              id: "cp_draft",
              name: "草稿",
              baseUrl: "",
              apiKey: "",
              format: "openai",
            },
          ],
        },
      ),
    ).toBe("cp_draft");
  });
});

describe("listProviderOptions", () => {
  it("没填合法地址的草稿不进下拉", () => {
    const options = listProviderOptions({
      customProviders: [
        oneCustom,
        {
          id: "cp_draft",
          name: "",
          baseUrl: "",
          apiKey: "",
          format: "openai",
        },
        {
          id: "cp_bad",
          name: "坏",
          baseUrl: "not-a-url",
          apiKey: "",
          format: "openai",
        },
      ],
    });
    expect(options.map((o) => o.value)).toEqual([
      CURSOR_PROVIDER_ID,
      LEGACY_CUSTOM_PROVIDER_ID,
    ]);
  });
});

describe("sessionMatchesProvider", () => {
  it("pi 锚点只能配自定义，UUID 只能配 cursor", () => {
    expect(
      sessionMatchesProvider("/data/pi-sessions/x.jsonl", LEGACY_CUSTOM_PROVIDER_ID),
    ).toBe(true);
    expect(
      sessionMatchesProvider("/data/pi-sessions/x.jsonl", CURSOR_PROVIDER_ID),
    ).toBe(false);
    expect(sessionMatchesProvider("agt_abc123", CURSOR_PROVIDER_ID)).toBe(true);
    expect(
      sessionMatchesProvider("agt_abc123", LEGACY_CUSTOM_PROVIDER_ID),
    ).toBe(false);
  });
});

describe("isApiKeyFieldPresent", () => {
  it("空串算传了（自定义本地无鉴权），缺字段才没有", () => {
    expect(isApiKeyFieldPresent("")).toBe(true);
    expect(isApiKeyFieldPresent("sk-x")).toBe(true);
    expect(isApiKeyFieldPresent(undefined)).toBe(false);
  });
});

describe("modelForProviderSwitch", () => {
  it("新提供方没配默认模型 → 清空，不沿用上一家", () => {
    expect(modelForProviderSwitch(undefined)).toBeUndefined();
    expect(modelForProviderSwitch({ id: "" })).toBeUndefined();
    expect(modelForProviderSwitch({ id: "  " })).toBeUndefined();
  });

  it("新提供方有默认模型 → 用它", () => {
    expect(modelForProviderSwitch({ id: "deepseek-chat" })).toEqual({
      id: "deepseek-chat",
    });
    expect(
      modelForProviderSwitch({
        id: " gpt-4o ",
        params: [{ id: "temp", value: "0" }],
      }),
    ).toEqual({
      id: "gpt-4o",
      params: [{ id: "temp", value: "0" }],
    });
  });
});

describe("custom baseUrl 归一", () => {
  it("带不带 /v1、尾斜杠都收成同一根", () => {
    expect(normalizeCustomBaseUrl("https://api.deepseek.com/v1")).toBe(
      "https://api.deepseek.com",
    );
    expect(normalizeCustomBaseUrl("https://api.deepseek.com/v1/")).toBe(
      "https://api.deepseek.com",
    );
    expect(normalizeCustomBaseUrl("https://api.deepseek.com")).toBe(
      "https://api.deepseek.com",
    );
  });

  it("OpenAI SDK 地址始终落到 /v1", () => {
    expect(customSdkBaseUrl("https://api.deepseek.com", "openai")).toBe(
      "https://api.deepseek.com/v1",
    );
    expect(customSdkBaseUrl("https://api.deepseek.com/v1/", "openai")).toBe(
      "https://api.deepseek.com/v1",
    );
    expect(customSdkBaseUrl("https://opencode.ai/zen/go/v1", "openai")).toBe(
      "https://opencode.ai/zen/go/v1",
    );
  });

  it("Anthropic SDK 地址不含 /v1（DeepSeek /anthropic 根）", () => {
    expect(
      customSdkBaseUrl("https://api.deepseek.com/anthropic", "anthropic"),
    ).toBe("https://api.deepseek.com/anthropic");
    expect(
      customSdkBaseUrl("https://api.deepseek.com/anthropic/v1", "anthropic"),
    ).toBe("https://api.deepseek.com/anthropic");
  });

  it("地址以 /anthropic 结尾时协议跟 Anthropic", () => {
    expect(
      formatFromCustomBaseUrl("https://api.deepseek.com/anthropic", "openai"),
    ).toBe("anthropic");
    expect(formatFromCustomBaseUrl("https://api.deepseek.com", "openai")).toBe(
      "openai",
    );
    expect(formatFromCustomBaseUrl("https://api.anthropic.com", "anthropic")).toBe(
      "anthropic",
    );
  });

  it("Anthropic 拉模型：本表面 404 时回退旁路 OpenAI /v1/models", () => {
    const attempts = customModelListAttempts(
      "https://api.deepseek.com/anthropic",
      "sk",
      "anthropic",
      customProviderHeaders,
    );
    expect(attempts.map((a) => a.url)).toEqual([
      "https://api.deepseek.com/anthropic/v1/models",
      "https://api.deepseek.com/v1/models",
      "https://api.deepseek.com/anthropic/v1/models",
    ]);
    expect(attempts[0]?.headers["x-api-key"]).toBe("sk");
    expect(attempts[1]?.headers.authorization).toBe("Bearer sk");
  });
});

describe("listCustomModels", () => {
  beforeEach(() => {
    resetModelsDevCatalogForTest();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    resetModelsDevCatalogForTest();
  });

  it("Anthropic /v1/models 404 后吃 OpenAI 列表；目录没有就不猜 effort", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/anthropic/v1/models")) {
          return { ok: false, status: 404, json: async () => ({}) };
        }
        return {
          ok: true,
          json: async () => ({ data: [{ id: "deepseek-v4-flash" }] }),
        };
      }),
    );
    const models = await listCustomModels({
      baseUrl: "https://api.deepseek.com/anthropic",
      apiKey: "sk",
      format: "anthropic",
    });
    expect(models.map((m) => m.id)).toEqual(["deepseek-v4-flash"]);
    expect(models[0]?.parameters).toBeUndefined();
  });

  it("目录命中后按该模型 effort 档补 chips", async () => {
    seedModelsDevCatalogForTest({
      opencode: {
        models: {
          "deepseek-v4-flash": {
            reasoning: true,
            reasoning_options: [
              { type: "toggle" },
              { type: "effort", values: ["low", "high", "max"] },
            ],
          },
        },
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ data: [{ id: "deepseek-v4-flash" }] }),
      })),
    );
    const models = await listCustomModels({
      baseUrl: "https://api.deepseek.com/v1",
      apiKey: "sk",
      format: "openai",
    });
    expect(models[0]?.parameters?.[0]?.id).toBe("thinking");
    expect(models[0]?.parameters?.[0]?.displayName).toBe("thinking");
    expect(models[0]?.parameters?.[0]?.values.map((v) => v.value)).toEqual([
      "default",
      "low",
      "high",
      "max",
    ]);
  });
});
