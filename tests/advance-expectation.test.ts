/**
 * 推进的乐观并发期望值（R14 Q7a-04）：纯函数契约
 *
 * 三态语义是整条修复的地基，写死在这里：
 *  - 没带（undefined）= 老客户端 / 飞书群路径 → 不校验、保持旧行为
 *  - 带了 null = 客户端看到「当前没有 action」
 *  - 带了字符串 = 客户端看到的当前 action id
 * 「没带」和「带了 null」必须严格区分——合并成一个会让老客户端（没带）被当成「期望空闲」而误拒。
 */
import { describe, expect, it } from "vitest";

import {
  ADVANCE_STALE_MESSAGE,
  isAdvanceExpectationStale,
  parseExpectedCurrentActionId,
} from "@/lib/server/advance-expectation";

describe("parseExpectedCurrentActionId：请求体解析", () => {
  it("缺省 → ok + undefined（不校验，旧行为）", () => {
    expect(parseExpectedCurrentActionId(undefined)).toEqual({
      ok: true,
      value: undefined,
    });
  });

  it("null → ok + null（客户端看到的是「当前没有 action」，与缺省不是一回事）", () => {
    const r = parseExpectedCurrentActionId(null);
    expect(r).toEqual({ ok: true, value: null });
    // 严格区分：值是 null、不是 undefined
    expect(r.ok && r.value === null).toBe(true);
  });

  it("非空字符串 → ok + 原值", () => {
    expect(parseExpectedCurrentActionId("act_1")).toEqual({
      ok: true,
      value: "act_1",
    });
  });

  it("字符串两端空白被裁掉（和服务端存的 id 比较时不被空白坑）", () => {
    expect(parseExpectedCurrentActionId("  act_1\n")).toEqual({
      ok: true,
      value: "act_1",
    });
  });

  it.each([
    ["空串", ""],
    ["全空白", "   "],
    ["数字", 3],
    ["布尔", true],
    ["对象", { id: "act_1" }],
    ["数组", ["act_1"]],
  ])("%s → 非法（400 文案点名字段）", (_name, raw) => {
    const r = parseExpectedCurrentActionId(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("expectedCurrentActionId");
  });
});

describe("isAdvanceExpectationStale：期望是否陈旧", () => {
  it("没带期望（undefined）：永远不算陈旧，不管盘上是什么（老客户端 / 飞书路径不被误拒）", () => {
    expect(isAdvanceExpectationStale("act_1", undefined)).toBe(false);
    expect(isAdvanceExpectationStale(null, undefined)).toBe(false);
    expect(isAdvanceExpectationStale(undefined, undefined)).toBe(false);
  });

  it("盘上与期望一致 → 不陈旧（正常推进放行）", () => {
    expect(isAdvanceExpectationStale("act_1", "act_1")).toBe(false);
    expect(isAdvanceExpectationStale(null, null)).toBe(false);
  });

  it("盘上缺省（undefined，老任务 / 迁移残留）与 null 等价", () => {
    expect(isAdvanceExpectationStale(undefined, null)).toBe(false);
    // 反过来：盘上缺省 = 没有当前 action，客户端却以为有 → 陈旧
    expect(isAdvanceExpectationStale(undefined, "act_1")).toBe(true);
  });

  it("id 不同 → 陈旧（别的请求已经推进过，当前 action 换人了）", () => {
    expect(isAdvanceExpectationStale("act_2", "act_1")).toBe(true);
  });

  it("客户端以为空闲（null）、盘上其实有当前 action → 陈旧", () => {
    expect(isAdvanceExpectationStale("act_1", null)).toBe(true);
  });

  it("客户端以为有 action、盘上已回到空闲（null）→ 陈旧", () => {
    expect(isAdvanceExpectationStale(null, "act_1")).toBe(true);
  });
});

describe("ADVANCE_STALE_MESSAGE：陈旧文案（专用，不复用「请重发」那句）", () => {
  it("不得诱导重发：重复提交时第一次其实已成功，「请重发」会让用户再起一条 action", () => {
    expect(ADVANCE_STALE_MESSAGE).not.toContain("请重发");
    // 明说这次没有重复推进，并指给用户下一步（先看最新进度）
    expect(ADVANCE_STALE_MESSAGE).toContain("没有重复推进");
    expect(ADVANCE_STALE_MESSAGE).toContain("最新进度");
  });

  it("与 runner 的通用让位文案（TASK_OP_STALE_HTTP_MESSAGE）不是同一句：路由靠它区分「推进陈旧」与「停止中 / 任务已变更」", () => {
    expect(ADVANCE_STALE_MESSAGE).not.toBe("正在停止/任务已变更、请重发");
    // 单行：toast 只留首行，整句得能放进一行里讲清结论
    expect(ADVANCE_STALE_MESSAGE).not.toContain("\n");
  });
});
