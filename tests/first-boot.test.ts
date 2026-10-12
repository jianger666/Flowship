/** 首次启动判定：标记按版本记，更新后的第一次启动同样给「首次」宽限。 */
import { describe, expect, it } from "vitest";

import {
  FIRST_BOOT_TIMEOUT_MS,
  REGULAR_BOOT_TIMEOUT_MS,
  buildFirstBootMarker,
  pickBootTimeoutMs,
  shouldTreatAsFirstBoot,
} from "../electron-app/first-boot.mjs";

const marker = (version: unknown) => JSON.stringify({ ts: 1, version });

describe("shouldTreatAsFirstBoot", () => {
  it("全新安装（没有标记文件）→ 首次", () => {
    expect(shouldTreatAsFirstBoot(null, "1.9.30")).toBe(true);
    expect(shouldTreatAsFirstBoot(undefined, "1.9.30")).toBe(true);
    expect(shouldTreatAsFirstBoot("", "1.9.30")).toBe(true);
  });

  it("版本一致 → 常规启动（只有这一种情况不给宽限）", () => {
    expect(shouldTreatAsFirstBoot(marker("1.9.30"), "1.9.30")).toBe(false);
  });

  it("更新 / 重装 / 回退后版本变了 → 重新按首次对待", () => {
    expect(shouldTreatAsFirstBoot(marker("1.9.29"), "1.9.30")).toBe(true);
    expect(shouldTreatAsFirstBoot(marker("1.9.31"), "1.9.30")).toBe(true);
  });

  it("旧版本写的标记没有 version 字段（只有 ts）→ 首次（升级后恰好需要这一次宽限）", () => {
    expect(shouldTreatAsFirstBoot(JSON.stringify({ ts: 1760000000000 }), "1.9.30")).toBe(true);
  });

  it("标记损坏 / 类型不对 → 首次（宁可多等，长超时对健康机器没有代价）", () => {
    expect(shouldTreatAsFirstBoot("{not json", "1.9.30")).toBe(true);
    expect(shouldTreatAsFirstBoot("null", "1.9.30")).toBe(true);
    expect(shouldTreatAsFirstBoot(marker(""), "1.9.30")).toBe(true);
    expect(shouldTreatAsFirstBoot(marker(1930), "1.9.30")).toBe(true);
  });

  it("当前版本拿不到 → 首次", () => {
    expect(shouldTreatAsFirstBoot(marker("1.9.30"), "")).toBe(true);
    expect(shouldTreatAsFirstBoot(marker("1.9.30"), undefined as unknown as string)).toBe(true);
  });
});

describe("buildFirstBootMarker / pickBootTimeoutMs", () => {
  it("标记带版本号与时间戳，且能被判定函数读回成「同版本 = 非首次」", () => {
    const m = buildFirstBootMarker("1.9.30", 1760000000000);
    expect(m).toEqual({ ts: 1760000000000, version: "1.9.30" });
    expect(shouldTreatAsFirstBoot(JSON.stringify(m), "1.9.30")).toBe(false);
  });

  it("首次 150s、常规 60s（不再是一次性 30s）", () => {
    expect(FIRST_BOOT_TIMEOUT_MS).toBe(150_000);
    expect(REGULAR_BOOT_TIMEOUT_MS).toBe(60_000);
    expect(pickBootTimeoutMs(true)).toBe(150_000);
    expect(pickBootTimeoutMs(false)).toBe(60_000);
  });
});
