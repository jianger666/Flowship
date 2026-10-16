/**
 * API Key 缓存指纹（S13-15 隐私）：不含 key 前后 4 位，且能区分不同 key
 */
import { describe, expect, it } from "vitest";

import { isLegacyKeyHash, keyHashOf } from "@/lib/api-key-cache";

describe("keyHashOf", () => {
  const key = "crsr_abcdef0123456789SECRETTAILwxyz";

  it("同 key 稳定、不同 key 不同", () => {
    expect(keyHashOf(key)).toBe(keyHashOf(key));
    expect(keyHashOf(key)).not.toBe(keyHashOf(`${key}x`));
    // 仅中间不同（旧指纹只看长度 + 前后 4 位、这种会撞）
    expect(keyHashOf("crsr_AAAAAAAAAAAAAAAA_wxyz")).not.toBe(
      keyHashOf("crsr_BBBBBBBBBBBBBBBB_wxyz"),
    );
  });

  it("指纹里不含 key 的前 4 / 后 4 位明文，也不含冒号（与旧格式可区分）", () => {
    const h = keyHashOf(key);
    expect(h).not.toContain(key.slice(0, 4));
    expect(h).not.toContain(key.slice(-4));
    expect(h).not.toContain(":");
    expect(isLegacyKeyHash(h)).toBe(false);
  });

  it("旧格式 `长度:前4:后4` 被识别为 legacy（读到就清）", () => {
    expect(isLegacyKeyHash(`${key.length}:${key.slice(0, 4)}:${key.slice(-4)}`)).toBe(true);
    expect(isLegacyKeyHash(undefined)).toBe(false);
  });
});

// useApiKeyInfo 的两处竞态 / 陈旧显示（没有 React 渲染测试环境，只能靠源码断言钉住接线）：
// 1) 换成没缓存的新 key：必须先清掉上一把 key 的姓名 / 邮箱，不能让它挂在新 key 下面等接口；
// 2) 静默刷新时必须复位 loading——上面的 abort 可能刚中止一个非静默请求，被中止的请求不会自己复位。
describe("useApiKeyInfo 竞态契约", () => {
  const readHook = async () => {
    const { readFileSync } = await import("node:fs");
    return readFileSync("src/hooks/use-api-key-info.ts", "utf8");
  };

  it("未命中缓存时先 setInfo(null)（else 分支）", async () => {
    const src = await readHook();
    expect(src).toMatch(/if \(cached\) \{[\s\S]*?setInfo\(cached\);[\s\S]*?\} else \{[\s\S]*?setInfo\(null\);[\s\S]*?\}/);
  });

  it("静默刷新时 setLoading(false)", async () => {
    const src = await readHook();
    expect(src).toMatch(/if \(silent\) setLoading\(false\);/);
  });
});
