/**
 * 当前 provider 的默认模型：cursor / 自定义 id 各记各的，互不回退。
 * 回归点：切到自定义后仍显示 composer-2.5（那是 Cursor id，自定义端点认不得）。
 */
import { describe, expect, it } from "vitest";

import { defaultModelForProvider } from "@/lib/types";

const cursorDefault = { id: "composer-2.5" };
const customDefault = { id: "gpt-4o" };
const customRow = {
  id: "cp_legacy",
  name: "x",
  baseUrl: "http://x",
  apiKey: "",
  format: "openai" as const,
  defaultModel: customDefault,
};

describe("defaultModelForProvider", () => {
  it("cursor 用 settings.defaultModel", () => {
    expect(
      defaultModelForProvider({
        provider: "cursor",
        defaultModel: cursorDefault,
        customProviders: [customRow],
      }),
    ).toEqual(cursorDefault);
  });

  it("自定义已配自己的默认模型就用它", () => {
    expect(
      defaultModelForProvider(
        {
          provider: "cp_legacy",
          defaultModel: cursorDefault,
          customProviders: [customRow],
        },
        "cp_legacy",
      ),
    ).toEqual(customDefault);
  });

  it("自定义未配默认模型返空、不回退 Cursor 的 composer-2.5", () => {
    expect(
      defaultModelForProvider(
        {
          provider: "cp_legacy",
          defaultModel: cursorDefault,
          customProviders: [{ ...customRow, defaultModel: undefined }],
        },
        "cp_legacy",
      ),
    ).toEqual({ id: "" });
    expect(
      defaultModelForProvider(
        {
          provider: "cp_legacy",
          defaultModel: cursorDefault,
          customProviders: [
            { ...customRow, defaultModel: { id: "  " } },
          ],
        },
        "cp_legacy",
      ),
    ).toEqual({ id: "" });
  });
});
