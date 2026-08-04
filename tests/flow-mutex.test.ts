/**
 * 主流程互斥：内置 plan/build/review 与 wk:* 按历史最早主流程锁定
 */
import { describe, expect, it } from "vitest";

import {
  classifyPrimaryFlowAction,
  flowMutexBuiltinDisabledReason,
  flowMutexWkDisabledReason,
  isAdvanceKeyFlowMutexDisabled,
  resolveFlowLock,
  skillNameFromDerivedActionId,
} from "@/lib/flow-mutex";
import type { ActionRecord, CustomActionDef } from "@/lib/types";

const act = (
  partial: Pick<ActionRecord, "n" | "type"> &
    Partial<Pick<ActionRecord, "customActionId">>,
): ActionRecord =>
  ({
    id: `a${partial.n}`,
    status: "completed",
    userInstruction: "",
    artifactPath: null,
    startedAt: partial.n,
    endedAt: partial.n,
    ...partial,
  }) as ActionRecord;

const wkDef = (
  id: string,
  skill: string,
): CustomActionDef =>
  ({
    id,
    label: skill,
    skill,
    order: 10,
    createdAt: 1,
    updatedAt: 1,
  }) as CustomActionDef;

describe("skillNameFromDerivedActionId", () => {
  it("解析 app:/team: 前缀", () => {
    expect(skillNameFromDerivedActionId("team:wk-repo-design")).toBe(
      "wk-repo-design",
    );
    expect(skillNameFromDerivedActionId("app:wk-biz-analyze")).toBe(
      "wk-biz-analyze",
    );
    expect(skillNameFromDerivedActionId("legacy-id")).toBeNull();
  });
});

describe("classifyPrimaryFlowAction", () => {
  it("内置 plan/build/review → legacy", () => {
    expect(classifyPrimaryFlowAction(act({ n: 1, type: "plan" }))).toBe(
      "legacy",
    );
    expect(classifyPrimaryFlowAction(act({ n: 1, type: "build" }))).toBe(
      "legacy",
    );
    expect(classifyPrimaryFlowAction(act({ n: 1, type: "review" }))).toBe(
      "legacy",
    );
  });

  it("ship/dev/非 wk custom → null（不锁定）", () => {
    expect(classifyPrimaryFlowAction(act({ n: 1, type: "ship" }))).toBeNull();
    expect(classifyPrimaryFlowAction(act({ n: 1, type: "dev" }))).toBeNull();
    expect(
      classifyPrimaryFlowAction(
        act({ n: 1, type: "custom", customActionId: "app:fix-bug" }),
      ),
    ).toBeNull();
  });

  it("wk 壳 custom → wk（可从 id 推断 skill）", () => {
    expect(
      classifyPrimaryFlowAction(
        act({
          n: 1,
          type: "custom",
          customActionId: "team:wk-repo-execute",
        }),
      ),
    ).toBe("wk");
  });
});

describe("resolveFlowLock", () => {
  it("无主流程历史 → null", () => {
    expect(
      resolveFlowLock([
        act({ n: 1, type: "ship" }),
        act({ n: 2, type: "dev" }),
        act({ n: 3, type: "custom", customActionId: "app:weekly" }),
      ]),
    ).toBeNull();
  });

  it("最早 wk → 锁 wk", () => {
    expect(
      resolveFlowLock([
        act({ n: 1, type: "ship" }),
        act({
          n: 2,
          type: "custom",
          customActionId: "team:wk-biz-analyze",
        }),
        act({ n: 3, type: "plan" }),
      ]),
    ).toBe("wk");
  });

  it("最早 legacy → 锁 legacy（混合历史按最早）", () => {
    expect(
      resolveFlowLock([
        act({ n: 1, type: "build" }),
        act({
          n: 2,
          type: "custom",
          customActionId: "team:wk-repo-design",
        }),
      ]),
    ).toBe("legacy");
  });

  it("按 n 排序、不看数组顺序", () => {
    expect(
      resolveFlowLock([
        act({ n: 5, type: "plan" }),
        act({
          n: 2,
          type: "custom",
          customActionId: "team:wk-prd-review",
        }),
      ]),
    ).toBe("wk");
  });
});

describe("禁用原因与 advance key", () => {
  const defs = new Map([
    ["team:wk-repo-design", wkDef("team:wk-repo-design", "wk-repo-design")],
  ]);

  it("wk 锁 → 禁用内置 plan/build/review，不禁 ship/dev", () => {
    expect(flowMutexBuiltinDisabledReason("plan", "wk")).toMatch(/wk 流程/);
    expect(flowMutexBuiltinDisabledReason("build", "wk")).toMatch(/wk 流程/);
    expect(flowMutexBuiltinDisabledReason("review", "wk")).toMatch(/wk 流程/);
    expect(flowMutexBuiltinDisabledReason("plan", null)).toBeNull();
  });

  it("legacy 锁 → 禁用 wk 壳", () => {
    expect(
      flowMutexWkDisabledReason(defs.get("team:wk-repo-design"), "legacy"),
    ).toMatch(/内置流程/);
    expect(
      flowMutexWkDisabledReason(
        wkDef("app:fix-bug", "fix-bug"),
        "legacy",
      ),
    ).toBeNull();
  });

  it("isAdvanceKeyFlowMutexDisabled", () => {
    expect(isAdvanceKeyFlowMutexDisabled("plan", "wk", defs)).toBe(true);
    expect(isAdvanceKeyFlowMutexDisabled("ship", "wk", defs)).toBe(false);
    expect(
      isAdvanceKeyFlowMutexDisabled("team:wk-repo-design", "legacy", defs),
    ).toBe(true);
    expect(isAdvanceKeyFlowMutexDisabled("app:fix-bug", "legacy", defs)).toBe(
      false,
    );
  });
});
