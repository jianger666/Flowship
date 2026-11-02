/**
 * schedule create 的 `at` 传了非字符串（数字时间戳 / 对象 / 布尔）时不能被静默忽略：
 * 原来 `typeof args.at === "string" ? args.at : ""` 会把它当「没给 at」——
 * 配 delay_minutes 就悄悄按 delay 建、配 every_minutes 就悄悄按间隔起算，模型还以为设对了。
 * 对照：undefined / null / 空串 仍是「没给」。
 */
import { describe, expect, it } from "vitest";

import { validateScheduleCreate } from "@/lib/schedule";

const NOW = Date.UTC(2026, 10, 1, 12, 0, 0);
const base = { title: "巡检", message: "到点看一眼构建状态并汇报" };

describe("validateScheduleCreate：at 类型校验", () => {
  it.each([
    ["数字时间戳", 1_790_000_000_000],
    ["对象", { iso: "2026-11-02T09:00:00+08:00" }],
    ["布尔", true],
    ["数组", ["2026-11-02T09:00:00+08:00"]],
  ])("at 是%s：报错并点名 at、说明要字符串（即使同时给了 delay_minutes）", (_name, at) => {
    const r = validateScheduleCreate({ ...base, delay_minutes: 30, at }, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("at");
      expect(r.error).toContain("字符串");
    }
  });

  it("at 是数字 + every_minutes：同样报错，不会静默按间隔起算", () => {
    const r = validateScheduleCreate({ ...base, every_minutes: 10, at: 1_790_000_000_000 }, NOW);
    expect(r.ok).toBe(false);
  });

  it("对照：at 缺省 / null / 空串仍按「没给」处理", () => {
    expect(validateScheduleCreate({ ...base, delay_minutes: 30 }, NOW).ok).toBe(true);
    expect(validateScheduleCreate({ ...base, delay_minutes: 30, at: null }, NOW).ok).toBe(true);
    expect(validateScheduleCreate({ ...base, delay_minutes: 30, at: "" }, NOW).ok).toBe(true);
    expect(validateScheduleCreate({ ...base, delay_minutes: 30, at: "   " }, NOW).ok).toBe(true);
  });

  it("对照：合法字符串 at 照常通过", () => {
    const r = validateScheduleCreate({ ...base, at: "2026-11-02T09:00:00+08:00" }, NOW);
    expect(r.ok).toBe(true);
  });
});
