/**
 * 设置项 `linkOpenMode`（链接默认打开方式）：默认内置，读盘归一化只认显式 "system"，保存口径放行。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { DEFAULT_SETTINGS, normalizeSettings } from "@/lib/local-store";

describe("linkOpenMode 设置页接线（读源码契约）", () => {
  const read = (rel: string) => readFileSync(path.resolve(import.meta.dirname, "..", rel), "utf8");

  it("设置页没有值时显示「内置」（与默认一致），不是「系统」", () => {
    expect(read("src/app/settings/page.tsx")).toContain('linkOpenMode={settings.linkOpenMode ?? "builtin"}');
  });

  it("偏好卡把选择值归一化后再保存（脏值不落盘）", () => {
    expect(read("src/components/settings/preference-card.tsx")).toContain("onChange={(v) => onLinkOpenModeChange(normalizeLinkOpenMode(v))}");
  });
});

describe("linkOpenMode 默认值与读盘归一化", () => {
  it("DEFAULT_SETTINGS 默认内置", () => {
    expect(DEFAULT_SETTINGS.linkOpenMode).toBe("builtin");
  });

  it("老配置没有该字段 → 内置", () => {
    expect(normalizeSettings({}).linkOpenMode).toBe("builtin");
    expect(normalizeSettings({ apiKey: "k", jumpIde: "cursor" }).linkOpenMode).toBe("builtin");
  });

  it("显式 system → system；显式 builtin → builtin", () => {
    expect(normalizeSettings({ linkOpenMode: "system" }).linkOpenMode).toBe("system");
    expect(normalizeSettings({ linkOpenMode: "builtin" }).linkOpenMode).toBe("builtin");
  });

  it.each([["SYSTEM"], [""], [0], [true], [null], [["system"]], [{ v: "system" }], ["browser"]])("脏值 %j → 内置（不跟着脏值走）", (v) => {
    expect(normalizeSettings({ linkOpenMode: v as never }).linkOpenMode).toBe("builtin");
  });
});
