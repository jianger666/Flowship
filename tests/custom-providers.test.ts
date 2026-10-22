/**
 * 多自定义 provider：读盘迁移 + 窗口 provider 不跟设置页默认走。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  customProviderNotReadyReason,
  isCustomProviderReady,
  listProviderOptions,
  migrateProviderSettings,
  modelForProviderSwitch,
  isApiKeyFieldPresent,
  isProviderSwitchLocked,
  resolveTaskProvider,
  sessionMatchesProvider,
} from "@/lib/agent-provider";
import {
  customBaseUrlNotice,
  customModelListAttempts,
  customSdkBaseUrlForFace,
  formatFromCustomBaseUrl,
  hasUrlUserinfo,
  normalizeCustomBaseUrl,
  redactUrlUserinfo,
  validateCustomBaseUrl,
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

  it("默认提供方的地址写了但无效（含 userinfo / 缺协议头）：保留该默认、不静默改成 Cursor（第四轮 Q2-07）", () => {
    for (const baseUrl of [
      "https://user:tok@api.example.com/v1",
      "localhost:11434/v1",
      "ftp://api.example.com",
    ]) {
      const out = migrateProviderSettings({
        provider: "cp_bad",
        customProviders: [
          { id: "cp_bad", name: "内网", baseUrl, apiKey: "k", format: "openai" },
        ],
      });
      expect(out.provider, baseUrl).toBe("cp_bad");
      // 它仍然「不算配好」：不进下拉、没有可用凭据，发送时由真实原因拦住
      expect(isCustomProviderReady(out.customProviders[0]!), baseUrl).toBe(false);
    }
    // 反例：已删的 id / 空地址草稿 仍回退 cursor（没有可保留的条目）
    expect(
      migrateProviderSettings({
        provider: "cp_gone",
        customProviders: [
          { id: "cp_other", name: "o", baseUrl: "https://o.example.com/v1", apiKey: "k", format: "openai" },
        ],
      }).provider,
    ).toBe(CURSOR_PROVIDER_ID);
    // 反例：legacy `provider: "custom"` 仍只映射到「配好的」条目
    expect(
      migrateProviderSettings({
        provider: "custom",
        customProviders: [
          { id: "cp_bad", name: "x", baseUrl: "https://u:t@h.example.com", apiKey: "k", format: "openai" },
        ],
      }).provider,
    ).toBe(CURSOR_PROVIDER_ID);
  });

  it("customProviderNotReadyReason：地址写了但无效时说真原因，不说「缺少接口地址」；配好 / Cursor / 不存在 → null", () => {
    const settings = {
      customProviders: [
        { id: "cp_userinfo", name: "内网", baseUrl: "https://u:t@h.example.com/v1", apiKey: "k", format: "openai" as const },
        { id: "cp_empty", name: "草稿", baseUrl: "", apiKey: "", format: "openai" as const },
        { id: "cp_ok", name: "好", baseUrl: "https://ok.example.com/v1", apiKey: "k", format: "openai" as const },
      ],
    };
    const bad = customProviderNotReadyReason(settings, "cp_userinfo");
    expect(bad).toContain("内网");
    expect(bad).toContain("用户名 / 密码");
    expect(bad).not.toContain("tok"); // 不回显地址里的凭据
    expect(bad).not.toContain("u:t@");
    expect(customProviderNotReadyReason(settings, "cp_empty")).toBe("缺少自定义 Provider 接口地址");
    expect(customProviderNotReadyReason(settings, "cp_ok")).toBeNull();
    expect(customProviderNotReadyReason(settings, CURSOR_PROVIDER_ID)).toBeNull();
    expect(customProviderNotReadyReason(settings, "cp_missing")).toBeNull();
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
  it("chat 空闲可切（发过消息也行）、running 才锁", () => {
    expect(isProviderSwitchLocked({ mode: "chat" })).toBe(false);
    expect(isProviderSwitchLocked({ mode: "chat", sessionAgentId: "" })).toBe(
      false,
    );
    expect(
      isProviderSwitchLocked({ mode: "chat", sessionAgentId: "uuid-1" }),
    ).toBe(false);
    expect(
      isProviderSwitchLocked({
        mode: "chat",
        sessionAgentId: "uuid-1",
        runStatus: "running",
      }),
    ).toBe(true);
  });

  it("task 空闲可切（含 error 重试、awaiting_ack 审阅态）、running/终态锁", () => {
    // idle 无步骤 → 放行
    expect(
      isProviderSwitchLocked({ mode: "task", runStatus: "idle" }),
    ).toBe(false);
    // awaiting_user + 终态步骤 → 放行
    expect(
      isProviderSwitchLocked({
        mode: "task",
        runStatus: "awaiting_user",
        currentActionId: "a1",
        actions: [{ id: "a1", status: "completed" }],
      }),
    ).toBe(false);
    // error + 终态步骤 → 放行（换家重试场景）
    expect(
      isProviderSwitchLocked({
        mode: "task",
        runStatus: "error",
        currentActionId: "a1",
        actions: [{ id: "a1", status: "error" }],
      }),
    ).toBe(false);
    // running → 锁
    expect(
      isProviderSwitchLocked({ mode: "task", runStatus: "running" }),
    ).toBe(true);
    // action running（注意是 action 状态、不是 runStatus）→ 锁
    expect(
      isProviderSwitchLocked({
        mode: "task",
        runStatus: "awaiting_user",
        currentActionId: "a1",
        actions: [{ id: "a1", status: "running" }],
      }),
    ).toBe(true);
    // action awaiting_ack → 放行（run 已结束、等的是人审阅；去掉「通过」按钮后
    // action 会在此停留到下次推进，再锁就永远切不了。交卷后流式尾巴由 runStatus /
    // runActive 覆盖，不靠这个锁）
    expect(
      isProviderSwitchLocked({
        mode: "task",
        runStatus: "awaiting_user",
        currentActionId: "a1",
        actions: [{ id: "a1", status: "awaiting_ack" }],
      }),
    ).toBe(false);
    // 终态任务 → 锁
    expect(
      isProviderSwitchLocked({ mode: "task", repoStatus: "merged" }),
    ).toBe(true);
    expect(
      isProviderSwitchLocked({ mode: "task", repoStatus: "abandoned" }),
    ).toBe(true);
    expect(isProviderSwitchLocked({})).toBe(true);
  });
});

describe("isSameProvider", () => {
  it("cursor 家不分 id、自定义按条目 id 精确比", async () => {
    const { isSameProvider } = await import("@/lib/agent-provider");
    expect(isSameProvider("cursor", "cursor")).toBe(true);
    expect(isSameProvider("cp_a", "cp_a")).toBe(true);
    expect(isSameProvider("cp_a", "cp_b")).toBe(false);
    expect(isSameProvider("cursor", "cp_a")).toBe(false);
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
    expect(
      customSdkBaseUrlForFace("https://api.deepseek.com", "openai-completions"),
    ).toBe("https://api.deepseek.com/v1");
    expect(
      customSdkBaseUrlForFace("https://api.deepseek.com/v1/", "openai-completions"),
    ).toBe("https://api.deepseek.com/v1");
    expect(
      customSdkBaseUrlForFace("https://opencode.ai/zen/go/v1", "openai-completions"),
    ).toBe("https://opencode.ai/zen/go/v1");
    // responses 面同口径（SDK 只拼尾段、地址同样要 /v1）
    expect(
      customSdkBaseUrlForFace("https://api.deepseek.com/v1/", "openai-responses"),
    ).toBe("https://api.deepseek.com/v1");
  });

  it("根里已带版本段（/v4 /v3 /v1beta）原样使用，不再强拼 /v1", () => {
    const face = "openai-completions" as const;
    // 智谱 / 火山 / Gemini 的 API 根本身就带版本
    expect(
      customSdkBaseUrlForFace("https://open.bigmodel.cn/api/paas/v4", face),
    ).toBe("https://open.bigmodel.cn/api/paas/v4");
    expect(
      customSdkBaseUrlForFace("https://open.bigmodel.cn/api/paas/v4/", face),
    ).toBe("https://open.bigmodel.cn/api/paas/v4");
    expect(
      customSdkBaseUrlForFace(
        "https://ark.cn-beijing.volces.com/api/v3",
        "openai-responses",
      ),
    ).toBe("https://ark.cn-beijing.volces.com/api/v3");
    expect(
      customSdkBaseUrlForFace(
        "https://generativelanguage.googleapis.com/v1beta/openai",
        face,
      ),
    ).toBe("https://generativelanguage.googleapis.com/v1beta/openai");
    // host 里的 v1 / 路径里的非版本词不算版本段，仍补 /v1
    expect(customSdkBaseUrlForFace("https://v1.example.com", face)).toBe(
      "https://v1.example.com/v1",
    );
    expect(customSdkBaseUrlForFace("https://example.com/v4ult", face)).toBe(
      "https://example.com/v4ult/v1",
    );
  });

  it("拉模型列表：根带版本段时 GET {根}/models，不是 {根}/v1/models", () => {
    const attempts = customModelListAttempts(
      "https://open.bigmodel.cn/api/paas/v4",
      "sk",
      "openai",
      customProviderHeaders,
    );
    expect(attempts.map((a) => a.url)).toEqual([
      "https://open.bigmodel.cn/api/paas/v4/models",
    ]);
  });

  it("Cloudflare Workers AI（F4-02）：路径中间的 /v4/ 是 Cloudflare REST 版本，不是兼容根的版本——仍补 /v1", () => {
    const face = "openai-completions" as const;
    const root = "https://api.cloudflare.com/client/v4/accounts/abc123/ai";
    // 文档里的写法（带 /v1）与不带 /v1 的写法等价，都落在 …/ai/v1
    expect(customSdkBaseUrlForFace(`${root}/v1`, face)).toBe(`${root}/v1`);
    expect(customSdkBaseUrlForFace(root, face)).toBe(`${root}/v1`);
    expect(customSdkBaseUrlForFace(`${root}/v1/`, face)).toBe(`${root}/v1`);
    // models 探测同口径
    const attempts = customModelListAttempts(
      `${root}/v1`,
      "sk",
      "openai",
      customProviderHeaders,
    );
    expect(attempts.map((a) => a.url)).toEqual([`${root}/v1/models`]);
    // 版本段在路径里任意位置都算「已带版本」（第三轮 R10b-02：不再用「版本段后最多再跟一段」的位置规则）
    expect(
      customSdkBaseUrlForFace("https://x.example.com/v2/a/b", face),
    ).toBe("https://x.example.com/v2/a/b");
    expect(
      customSdkBaseUrlForFace("https://x.example.com/v2/openai", face),
    ).toBe("https://x.example.com/v2/openai");
  });

  it("版本号在最前、后面多段的网关地址原样使用（R10b-02：Cloudflare AI Gateway / Vertex）", () => {
    const face = "openai-completions" as const;
    for (const u of [
      "https://gateway.ai.cloudflare.com/v1/acc123/mygw/openai",
      "https://gateway.ai.cloudflare.com/v1/acc123/mygw/compat",
      "https://us-central1-aiplatform.googleapis.com/v1/projects/p/locations/l/endpoints/openapi",
    ]) {
      expect(customSdkBaseUrlForFace(u, face)).toBe(u);
      expect(customSdkBaseUrlForFace(`${u}/`, face)).toBe(u);
      expect(
        customModelListAttempts(u, "sk", "openai", customProviderHeaders).map((a) => a.url),
      ).toEqual([`${u}/models`]);
    }
  });

  it("用户显式写了尾 /v1 就保留——哪怕路径更早处另有 /vN（第四轮 Q2-01：CF AI Gateway workers-ai/v1、OpenRouter 网关）", () => {
    const H = "https://h.example.com";
    // 15 种形态：「路径前缀」+ 用户显式写的 `/v1`；SDK base 与 /models 探测都必须原样保留该 /v1
    const prefixes = [
      "",
      "/api",
      "/openai",
      "/compatible-mode",
      "/v2/openai",
      "/v2/a/b",
      "/v1/acc/gw/workers-ai",
      "/v1/acc/gw/openrouter",
      "/gateway/v1/tenant/openai",
      "/api/v3/team/x",
      "/api/v1/proxy/team",
      "/v1/projects/p/locations/l/endpoints/openapi",
      "/v1beta/openai",
      "/client/v4/accounts/x/ai",
      "/v4/chat",
    ];
    expect(prefixes).toHaveLength(15);
    for (const p of prefixes) {
      const want = `${H}${p}/v1`;
      for (const input of [want, `${want}/`, `${want}?x=1`, `${want}/chat/completions`]) {
        for (const face of ["openai-completions", "openai-responses"] as const) {
          expect(customSdkBaseUrlForFace(input, face), `${face} ${input}`).toBe(want);
        }
        for (const format of ["auto", "openai", "anthropic"] as const) {
          const urls = customModelListAttempts(input, "sk", format, customProviderHeaders).map(
            (a) => a.url,
          );
          // 探测与聊天 base 同口径：全部以 `{base}/models` 为准，不出现被吞掉 /v1 的 `{root}/models`
          expect(new Set(urls), `${format} ${input}`).toEqual(new Set([`${want}/models`]));
        }
      }
    }
    // 点名两个：CF AI Gateway Workers AI / OpenRouter 网关
    const cf = "https://gateway.ai.cloudflare.com/v1/acc123/mygw/workers-ai/v1";
    expect(customSdkBaseUrlForFace(cf, "openai-completions")).toBe(cf);
    const or = "https://gateway.ai.cloudflare.com/v1/acc123/mygw/openrouter/v1";
    expect(customSdkBaseUrlForFace(or, "openai-completions")).toBe(or);
    // Anthropic 面本来就不要 /v1：不受影响
    expect(customSdkBaseUrlForFace(cf, "anthropic-messages")).toBe(
      "https://gateway.ai.cloudflare.com/v1/acc123/mygw/workers-ai",
    );
  });

  it("没写尾 /v1 的老行为不变（Q2-01 反例对）：带版本段原样、没带版本段补 /v1", () => {
    const face = "openai-completions" as const;
    // 路径里有版本段、用户没写尾 /v1 → 原样（R10b-02）
    const cfNoTail = "https://gateway.ai.cloudflare.com/v1/acc123/mygw/workers-ai";
    expect(customSdkBaseUrlForFace(cfNoTail, face)).toBe(cfNoTail);
    expect(
      customModelListAttempts(cfNoTail, "sk", "openai", customProviderHeaders).map((a) => a.url),
    ).toEqual([`${cfNoTail}/models`]);
    // 没版本段、没写 /v1 → 补 /v1
    expect(customSdkBaseUrlForFace("https://h.example.com/api", face)).toBe(
      "https://h.example.com/api/v1",
    );
    expect(
      customModelListAttempts("https://h.example.com/api", "sk", "openai", customProviderHeaders).map(
        (a) => a.url,
      ),
    ).toEqual(["https://h.example.com/api/v1/models"]);
    // 接口尾段后面的 /v1 也算「写了」；尾段在 /v1 之前（`/v1/models`）同样识别
    expect(
      customSdkBaseUrlForFace("https://gw.example.com/v1/a/b/v1/chat/completions", face),
    ).toBe("https://gw.example.com/v1/a/b/v1");
  });

  it("Cloudflare Workers AI `…/client/v4/accounts/<id>/ai[/v1]` 仍补 /v1（F4-02 不回归）", () => {
    const face = "openai-completions" as const;
    const root = "https://api.cloudflare.com/client/v4/accounts/abc123/ai";
    expect(customSdkBaseUrlForFace(root, face)).toBe(`${root}/v1`);
    expect(customSdkBaseUrlForFace(`${root}/v1`, face)).toBe(`${root}/v1`);
  });

  it("粘贴了具体接口地址（D1-06）：先剥接口尾段再按根处理，不拼出 /v1/chat/completions/v1", () => {
    const face = "openai-completions" as const;
    for (const tail of [
      "/v1/chat/completions",
      "/v1/models",
      "/v1/responses",
      "/v1/completions",
      "/v1/embeddings",
      "/chat/completions",
      "/v1/chat/completions/",
    ]) {
      expect(
        customSdkBaseUrlForFace(`https://api.example.com${tail}`, face),
      ).toBe("https://api.example.com/v1");
    }
    expect(normalizeCustomBaseUrl("https://api.anthropic.com/v1/messages")).toBe(
      "https://api.anthropic.com",
    );
    // 版本段在根里的网关：剥完接口尾段原样
    expect(
      customSdkBaseUrlForFace("https://open.bigmodel.cn/api/paas/v4/chat/completions", face),
    ).toBe("https://open.bigmodel.cn/api/paas/v4");
    expect(
      customModelListAttempts(
        "https://api.example.com/v1/models",
        "sk",
        "openai",
        customProviderHeaders,
      ).map((a) => a.url),
    ).toEqual(["https://api.example.com/v1/models"]);
    expect(customBaseUrlNotice("https://api.example.com/v1/chat/completions")).toMatch(
      /具体接口地址/,
    );
    // 普通根地址不提示
    expect(customBaseUrlNotice("https://api.example.com/v1")).toBeNull();
    expect(customBaseUrlNotice("")).toBeNull();
  });

  it("地址里带 userinfo（D1-05）：校验拒绝、不算配好；错误通道里的 URL 凭据被擦掉", () => {
    expect(validateCustomBaseUrl("https://user:sk-secret@api.example.com/v1")).toMatch(
      /不要把用户名/,
    );
    expect(validateCustomBaseUrl("https://sk-secret@api.example.com/v1")).toMatch(
      /不要把用户名/,
    );
    expect(
      isCustomProviderReady({
        id: "cp_x",
        name: "",
        baseUrl: "https://user:sk-secret@api.example.com/v1",
        apiKey: "",
        format: "auto",
      }),
    ).toBe(false);
    const msg =
      "Request cannot be constructed from a URL that includes credentials: https://user:sk-test-xxxx@api.example.com/v1/models";
    const out = redactUrlUserinfo(msg);
    expect(out).not.toMatch(/sk-test-xxxx/);
    expect(out).toContain("https://***@api.example.com/v1/models");
    // 没有 userinfo 的 URL 与路径里的 @ 不受影响
    expect(redactUrlUserinfo("GET https://api.example.com/v1/@scope/models")).toBe(
      "GET https://api.example.com/v1/@scope/models",
    );
  });

  it("userinfo 打码盲区（第四轮 Q2-06）：密码含未编码 @、协议相对写法也不泄露；邮箱 / @scope / 多 URL 不误伤", () => {
    // 之前 3/13 变体仍泄露：正则止于第一个 @、且要求 scheme
    const leaky = [
      "https://user:p@ss-TOK123@host/v1",
      "https://user:abc@TOK123@host/v1",
      "Failed to parse URL from //user:TOK123@host/v1/models",
      "fetch failed: //user:TOK123@host",
      "(//user:TOK123@host)",
      "https://user:TOK123@host/v1",
      "HTTPS://user:TOK123@HOST",
      "http://u:TOK123@127.0.0.1:11434/v1",
      "http://u:TOK123@[::1]:8080/v1",
    ];
    for (const raw of leaky) {
      const out = redactUrlUserinfo(raw);
      expect(out, raw).not.toContain("TOK123");
      expect(out, raw).toContain("***@");
    }
    expect(redactUrlUserinfo("Failed to parse URL from //user:TOK123@host")).toBe(
      "Failed to parse URL from //***@host",
    );
    expect(redactUrlUserinfo("https://user:p@ss-TOK123@host/v1")).toBe("https://***@host/v1");
    // 反例对：无 userinfo 的原样保留
    for (const keep of [
      "GET https://api.example.com/v1/@scope/models",
      "https://api.example.com/v1",
      "联系 me@example.com 了解，或访问 https://example.com/docs",
      "两个地址 https://a.example.com/x 与 https://b.example.com/y@z",
      "path //cdn.example.com/a/@b",
    ]) {
      expect(redactUrlUserinfo(keep), keep).toBe(keep);
    }
  });

  it("hasUrlUserinfo：只在能解析且真带用户名 / 密码时为真", () => {
    expect(hasUrlUserinfo("https://user:tok@api.example.com/v1")).toBe(true);
    expect(hasUrlUserinfo("https://tok@api.example.com/v1")).toBe(true);
    expect(hasUrlUserinfo("https://api.example.com/v1/@scope")).toBe(false);
    expect(hasUrlUserinfo("https://api.example.com")).toBe(false);
    expect(hasUrlUserinfo("not a url")).toBe(false);
    expect(hasUrlUserinfo("")).toBe(false);
  });

  it("`localhost:11434/v1`（没写协议头，D1-07）报「缺少 http://」而不是「只支持 http/https」", () => {
    expect(validateCustomBaseUrl("localhost:11434/v1")).toMatch(/缺少 http/);
    expect(validateCustomBaseUrl("ftp://example.com")).toMatch(/只支持 http/);
  });

  it("地址里带 ?query / #hash（F4-05）：归一时去掉，不拼出畸形请求；设置页提示", () => {
    const face = "openai-completions" as const;
    expect(
      customSdkBaseUrlForFace("https://api.example.com/v1?api-version=2024-01", face),
    ).toBe("https://api.example.com/v1");
    expect(customSdkBaseUrlForFace("https://api.example.com#frag", face)).toBe(
      "https://api.example.com/v1",
    );
    const attempts = customModelListAttempts(
      "https://api.example.com?x=1",
      "sk",
      "openai",
      customProviderHeaders,
    );
    expect(attempts.map((a) => a.url)).toEqual([
      "https://api.example.com/v1/models",
    ]);
    // ?/# 是「已自动处理」的提示、不是错误（R10b-03）：validate 放行，notice 给提示
    expect(validateCustomBaseUrl("https://api.example.com/v1?x=1")).toBeNull();
    expect(validateCustomBaseUrl("https://api.example.com/v1#a")).toBeNull();
    expect(customBaseUrlNotice("https://api.example.com/v1?x=1")).toMatch(/已忽略/);
    expect(customBaseUrlNotice("https://api.example.com/v1#a")).toMatch(/已忽略/);
    expect(validateCustomBaseUrl("https://api.example.com/v1")).toBeNull();
  });

  it("validateCustomBaseUrl：空串放行、非 http(s) 与非地址报错", () => {
    expect(validateCustomBaseUrl("")).toBeNull();
    expect(validateCustomBaseUrl("  ")).toBeNull();
    expect(validateCustomBaseUrl("https://api.deepseek.com/v1")).toBeNull();
    expect(validateCustomBaseUrl("http://127.0.0.1:11434/v1")).toBeNull();
    expect(validateCustomBaseUrl("api.deepseek.com")).toMatch(/格式不对/);
    expect(validateCustomBaseUrl("ftp://example.com")).toMatch(/http/);
  });

  it("Anthropic SDK 地址不含 /v1（DeepSeek /anthropic 根）", () => {
    expect(
      customSdkBaseUrlForFace(
        "https://api.deepseek.com/anthropic",
        "anthropic-messages",
      ),
    ).toBe("https://api.deepseek.com/anthropic");
    expect(
      customSdkBaseUrlForFace(
        "https://api.deepseek.com/anthropic/v1",
        "anthropic-messages",
      ),
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

  it("fetch 异常消息里带 URL 凭据时，抛出的错误不含密钥（D1-05）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        throw new TypeError(
          `Request cannot be constructed from a URL that includes credentials: ${String(input)}`,
        );
      }),
    );
    const err = await listCustomModels({
      baseUrl: "https://user:sk-test-xxxx@api.example.com/v1",
      apiKey: "",
      format: "openai",
    }).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).not.toMatch(/sk-test-xxxx/);
    expect(err?.message).toContain("https://***@api.example.com");
  });
});

describe("POST /api/models：含 userinfo 的地址不发请求（第四轮 Q2-06）", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("地址带用户名 / 密码 → 400 + 原因，一次 fetch 都不发、响应不含凭据；正常地址照常发请求", async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: [{ id: "m1" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const { POST } = await import("@/app/api/models/route");
    const call = (baseUrl: string) =>
      POST(
        new Request("http://localhost/api/models", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ baseUrl, apiKey: "k", format: "openai" }),
        }),
      );

    for (const bad of [
      "https://user:TOK123@api.example.com/v1",
      "https://TOK123@api.example.com/v1",
      "https://user:p@ss-TOK123@api.example.com/v1",
    ]) {
      const res = await call(bad);
      expect(res.status, bad).toBe(400);
      const text = JSON.stringify(await res.json());
      expect(text, bad).toContain("用户名 / 密码");
      expect(text, bad).not.toContain("TOK123");
    }
    expect(fetchSpy).not.toHaveBeenCalled();

    // 反例对：无 userinfo 的地址（含路径里的 @scope）照常拉取
    await call("https://api.example.com/v1/@scope");
    expect(fetchSpy).toHaveBeenCalled();
  });
});
