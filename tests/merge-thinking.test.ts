import { describe, expect, it } from "vitest";

import { coalesceAdjacentThinking } from "@/lib/merge-thinking";
import type { TaskEvent } from "@/lib/types";

const ev = (
  id: string,
  kind: TaskEvent["kind"],
  text: string,
  extra?: Partial<TaskEvent>,
): TaskEvent => ({
  id,
  ts: 1,
  kind,
  text,
  ...extra,
});

describe("coalesceAdjacentThinking", () => {
  it("token 级 thinking 直接拼接、不加换行", () => {
    const out = coalesceAdjacentThinking([
      ev("a", "thinking", "用"),
      ev("b", "thinking", "户"),
      ev("c", "thinking", "给了"),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe("a");
    expect(out[0]!.text).toBe("用户给了");
  });

  it("中间夹 user_reply / 工具会打断", () => {
    const out = coalesceAdjacentThinking([
      ev("t1", "thinking", "先"),
      ev("u", "user_reply", "你好"),
      ev("t2", "thinking", "后"),
    ]);
    expect(out.map((e) => e.id)).toEqual(["t1", "u", "t2"]);
  });

  it("durationMs 累加", () => {
    const out = coalesceAdjacentThinking([
      ev("a", "thinking", "a", { meta: { durationMs: 10 } }),
      ev("b", "thinking", "b", { meta: { durationMs: 15 } }),
    ]);
    expect(out[0]!.meta?.durationMs).toBe(25);
  });
});
