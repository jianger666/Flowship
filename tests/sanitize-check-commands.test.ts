/**
 * sanitizeCheckCommands 单测（安全关键：命令会被 server 自动执行、清洗放水 = 配置注入面）
 */
import { describe, expect, it } from "vitest";

import { sanitizeCheckCommands } from "@/lib/server/task-fs";
import type { CheckCommand } from "@/lib/types";

const cmd = (over: Partial<CheckCommand> = {}): CheckCommand =>
  ({
    name: "typecheck",
    cmd: "pnpm typecheck",
    kind: "typecheck",
    required: true,
    source: "manual",
    ...over,
  }) as CheckCommand;

describe("sanitizeCheckCommands", () => {
  it("正常命令原样保留、source 由调用方打标（不信入参）", () => {
    const out = sanitizeCheckCommands([cmd({ source: "auto" })], "manual");
    expect(out).toHaveLength(1);
    expect(out[0].source).toBe("manual"); // 入参的 auto 被覆盖
    expect(out[0].cmd).toBe("pnpm typecheck");
  });

  it("name / cmd 空白 → 丢弃", () => {
    const out = sanitizeCheckCommands(
      [cmd({ name: "  " }), cmd({ cmd: "" }), cmd()],
      "manual",
    );
    expect(out).toHaveLength(1);
  });

  it("name / cmd 超长截断（80 / 2000）", () => {
    const out = sanitizeCheckCommands(
      [cmd({ name: "x".repeat(200), cmd: "y".repeat(3000) })],
      "manual",
    );
    expect(out[0].name).toHaveLength(80);
    expect(out[0].cmd).toHaveLength(2000);
  });

  it("非法 kind 兜回 custom（防 timeout 表取 undefined 秒杀命令）", () => {
    const out = sanitizeCheckCommands(
      [cmd({ kind: "hack" as CheckCommand["kind"] })],
      "manual",
    );
    expect(out[0].kind).toBe("custom");
  });

  it("required 缺省视为 true、显式 false 保留", () => {
    const out = sanitizeCheckCommands(
      [
        cmd({ required: undefined as unknown as boolean }),
        cmd({ required: false }),
      ],
      "manual",
    );
    expect(out[0].required).toBe(true);
    expect(out[1].required).toBe(false);
  });

  it("timeoutMs clamp 到 [5s, 30min]、0/负数不落字段", () => {
    const out = sanitizeCheckCommands(
      [
        cmd({ timeoutMs: 1 }),
        cmd({ timeoutMs: 99_999_999 }),
        cmd({ timeoutMs: 0 }),
        cmd({ timeoutMs: -5 }),
      ],
      "manual",
    );
    expect(out[0].timeoutMs).toBe(5_000);
    expect(out[1].timeoutMs).toBe(1_800_000);
    expect(out[2].timeoutMs).toBeUndefined();
    expect(out[3].timeoutMs).toBeUndefined();
  });

  it("每仓最多 10 条", () => {
    const out = sanitizeCheckCommands(
      Array.from({ length: 15 }, (_, i) => cmd({ name: `c${i}` })),
      "auto",
    );
    expect(out).toHaveLength(10);
  });
});
