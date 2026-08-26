/**
 * 自定义 provider 协议自动路由（auto 档）：
 * models.dev 目录的 npm 字段 → 请求面。两级闸门 + 显式 override。
 */
import { describe, expect, it } from "vitest";

import {
  buildModelsDevRouteIndex,
  lookupCatalogNpm,
  seedModelsDevCatalogForTest,
} from "@/lib/server/models-dev-catalog";
import {
  faceFromCatalogNpm,
  resolveModelFace,
} from "@/lib/server/custom-route";
import { emptyCustomProvider } from "@/lib/agent-provider";
import {
  customModelListAttempts,
  customSdkBaseUrlForFace,
} from "@/lib/custom-provider-url";
import { customProviderHeaders } from "@/lib/server/custom-provider";

// 与 models.dev 真实结构同形的最小目录
const catalog = {
  "opencode-go": {
    api: "https://opencode.ai/zen/go/v1",
    models: {
      "muse-spark-1.2-contributor": { provider: { npm: "@ai-sdk/openai" } },
      "ox-alpha-free": { provider: { npm: "@ai-sdk/openai-compatible" } },
      "qwen3.8-max": {}, // 缺模型级 npm → 回落提供方级
    },
    npm: "@ai-sdk/anthropic",
  },
  deepseek: {
    api: "https://api.deepseek.com/anthropic/v1",
    models: {
      "deepseek-v4": { provider: { npm: "@ai-sdk/anthropic" } },
    },
  },
  // 目录侧大写 URL：build 与 lookup 必须同口径小写，否则永远查不中
  "uppercase-host": {
    api: "https://Relay.Example.COM/X/v1",
    models: {
      "upper-model": { provider: { npm: "@ai-sdk/openai-compatible" } },
    },
  },
  // 没有 api 字段的提供方：不参与第一级匹配
  "some-aggregator": {
    models: { "muse-spark-1.2-contributor": { provider: { npm: "@ai-sdk/openai" } } },
  },
};

describe("buildModelsDevRouteIndex", () => {
  it("只收带 api 字段的提供方；模型级 npm 缺省回落提供方级", () => {
    const index = buildModelsDevRouteIndex(catalog);
    expect(index.size).toBe(3);
    // key 是归一化（剥尾 /v1）后的 baseURL
    expect(index.has("https://opencode.ai/zen/go")).toBe(true);
    expect(index.has("https://api.deepseek.com/anthropic")).toBe(true);
    expect(
      index.get("https://opencode.ai/zen/go")?.get("qwen3.8-max"),
    ).toBe("@ai-sdk/anthropic");
  });

  it("空 / 非法输入返空表", () => {
    expect(buildModelsDevRouteIndex(null).size).toBe(0);
    expect(buildModelsDevRouteIndex("x").size).toBe(0);
    expect(buildModelsDevRouteIndex({}).size).toBe(0);
  });
});

describe("lookupCatalogNpm", () => {
  const index = buildModelsDevRouteIndex(catalog);

  it("baseURL 归一后精确命中（带不带 /v1、尾斜杠、大小写等价）", () => {
    for (const url of [
      "https://opencode.ai/zen/go/v1",
      "https://opencode.ai/zen/go",
      "https://opencode.ai/zen/go/v1/",
      "HTTPS://OPENCODE.AI/ZEN/GO/V1",
    ]) {
      expect(lookupCatalogNpm(index, url, "muse-spark-1.2-contributor")).toBe(
        "@ai-sdk/openai",
      );
    }
  });

  it("目录侧大写 URL 也命中（build/lookup 同一小写口径）", () => {
    expect(
      lookupCatalogNpm(index, "https://relay.example.com/x", "upper-model"),
    ).toBe("@ai-sdk/openai-compatible");
    expect(
      lookupCatalogNpm(index, "HTTPS://RELAY.EXAMPLE.COM/X/V1/", "upper-model"),
    ).toBe("@ai-sdk/openai-compatible");
  });

  it("斜杠 id 对尾巴", () => {
    expect(
      lookupCatalogNpm(index, "https://opencode.ai/zen/go", "prefix/muse-spark-1.2-contributor"),
    ).toBe("@ai-sdk/openai");
  });

  it("第一级没命中（自建网关）→ null", () => {
    expect(
      lookupCatalogNpm(index, "https://my-relay.example.com/v1", "muse-spark-1.2-contributor"),
    ).toBeNull();
    expect(lookupCatalogNpm(index, "", "muse-spark-1.2-contributor")).toBeNull();
  });

  it("第一级命中但模型 id 查不到 → null（不猜）", () => {
    expect(
      lookupCatalogNpm(index, "https://opencode.ai/zen/go", "unknown-model"),
    ).toBeNull();
  });

  it("没有 api 字段的提供方不参与匹配（同名模型也不命中错表）", () => {
    expect(
      lookupCatalogNpm(index, "https://aggregator.example.com", "muse-spark-1.2-contributor"),
    ).toBeNull();
  });
});

describe("faceFromCatalogNpm", () => {
  it("只认两个特殊包名，其余一律 chat/completions", () => {
    expect(faceFromCatalogNpm("@ai-sdk/openai")).toBe("openai-responses");
    expect(faceFromCatalogNpm("@ai-sdk/anthropic")).toBe("anthropic-messages");
    expect(faceFromCatalogNpm("@ai-sdk/openai-compatible")).toBe(
      "openai-completions",
    );
    expect(faceFromCatalogNpm("@openrouter/ai-sdk-provider")).toBe(
      "openai-completions",
    );
    expect(faceFromCatalogNpm(null)).toBe("openai-completions");
  });
});

describe("resolveModelFace", () => {
  const faceOf = (baseUrl: string, modelId: string, format?: string) =>
    resolveModelFace(baseUrl, modelId, (format ?? "auto") as never);

  it("auto：Go 套餐 muse 走 responses，ox-alpha 走 completions，qwen 走 messages", async () => {
    seedModelsDevCatalogForTest(catalog);
    expect(
      await faceOf("https://opencode.ai/zen/go", "muse-spark-1.2-contributor"),
    ).toBe("openai-responses");
    expect(
      await faceOf("https://opencode.ai/zen/go/v1", "ox-alpha-free"),
    ).toBe("openai-completions");
    expect(await faceOf("https://opencode.ai/zen/go", "qwen3.8-max")).toBe(
      "anthropic-messages",
    );
  });

  it("auto：目录没命中回落 completions（历史行为零变化）", async () => {
    seedModelsDevCatalogForTest(catalog);
    expect(
      await faceOf("https://my-relay.example.com/v1", "any-model"),
    ).toBe("openai-completions");
  });

  it("显式 override 完全跳过目录：选 anthropic 就走 messages，哪怕目录说 responses", async () => {
    seedModelsDevCatalogForTest(catalog);
    expect(
      await faceOf(
        "https://opencode.ai/zen/go",
        "muse-spark-1.2-contributor",
        "anthropic",
      ),
    ).toBe("anthropic-messages");
    expect(
      await faceOf(
        "https://opencode.ai/zen/go",
        "qwen3.8-max",
        "openai",
      ),
    ).toBe("openai-completions");
  });
});

describe("auto 档配套行为", () => {
  it("新条目默认协议是 auto", () => {
    expect(emptyCustomProvider().format).toBe("auto");
  });

  it("responses / completions 的 SDK 地址都带 /v1；messages 不带", () => {
    expect(
      customSdkBaseUrlForFace("https://opencode.ai/zen/go", "openai-responses"),
    ).toBe("https://opencode.ai/zen/go/v1");
    expect(
      customSdkBaseUrlForFace(
        "https://opencode.ai/zen/go/v1",
        "openai-completions",
      ),
    ).toBe("https://opencode.ai/zen/go/v1");
    expect(
      customSdkBaseUrlForFace(
        "https://api.deepseek.com/anthropic",
        "anthropic-messages",
      ),
    ).toBe("https://api.deepseek.com/anthropic");
  });

  it("auto 拉列表：先 Bearer 再 x-api-key，/anthropic 地址保留旁路回退", () => {
    const attempts = customModelListAttempts(
      "https://my-relay.example.com",
      "sk",
      "auto",
      customProviderHeaders,
    );
    // 同 URL 换鉴权头算两次尝试：先 Bearer、再 x-api-key
    expect(attempts.map((a) => a.url)).toEqual([
      "https://my-relay.example.com/v1/models",
      "https://my-relay.example.com/v1/models",
    ]);
    expect(attempts[0]?.headers.authorization).toBe("Bearer sk");
    expect(attempts[1]?.headers["x-api-key"]).toBe("sk");

    const anthropicish = customModelListAttempts(
      "https://api.deepseek.com/anthropic",
      "sk",
      "auto",
      customProviderHeaders,
    );
    // 三种组合都试：本表面 Bearer → 旁路 OpenAI 列表 → 本表面 x-api-key
    expect(anthropicish.map((a) => a.url)).toEqual([
      "https://api.deepseek.com/anthropic/v1/models",
      "https://api.deepseek.com/v1/models",
      "https://api.deepseek.com/anthropic/v1/models",
    ]);
    expect(anthropicish[0]?.headers.authorization).toBe("Bearer sk");
    expect(anthropicish[1]?.headers.authorization).toBe("Bearer sk");
    expect(anthropicish[2]?.headers["x-api-key"]).toBe("sk");
  });
});
