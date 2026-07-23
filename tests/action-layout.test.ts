/**
 * action-layout 纯函数：排序 / 显隐 / 删 id 清理 / 关闭自管 skill 推进过滤
 */
import { describe, expect, it } from "vitest";

import {
  arrangeByLayout,
  filterAdvanceByDisabledAppSkills,
  filterAdvanceByRequiresKnowledge,
  removeActionLayoutId,
  sortByOrder,
  usableCustomActions,
} from "@/lib/action-layout";
import type { CustomActionDef } from "@/lib/types";

const def = (
  partial: Pick<CustomActionDef, "id" | "label" | "skill"> &
    Partial<CustomActionDef>,
): CustomActionDef => ({
  createdAt: 1,
  updatedAt: 1,
  ...partial,
});

describe("removeActionLayoutId（D10）", () => {
  it("从 order / hidden 同步清掉目标 id、其它保留", () => {
    const next = removeActionLayoutId(
      {
        order: ["plan", "my-custom", "build", "other"],
        hidden: ["my-custom", "ship"],
      },
      "my-custom",
    );
    expect(next).toEqual({
      order: ["plan", "build", "other"],
      hidden: ["ship"],
    });
  });

  it("id 不在布局里 → 等长原样（可跳过 save）", () => {
    const layout = { order: ["plan", "build"], hidden: ["ship"] };
    const next = removeActionLayoutId(layout, "gone");
    expect(next.order).toEqual(layout.order);
    expect(next.hidden).toEqual(layout.hidden);
  });
});

describe("sortByOrder / arrangeByLayout 冒烟", () => {
  it("order 优先、hidden 过滤", () => {
    expect(sortByOrder(["build", "plan", "ship"], ["ship", "plan"])).toEqual([
      "ship",
      "plan",
      "build",
    ]);
    expect(
      arrangeByLayout(["plan", "build", "ship"], {
        order: ["ship", "plan"],
        hidden: ["build"],
      }),
    ).toEqual(["ship", "plan"]);
  });
});

describe("filterAdvanceByDisabledAppSkills", () => {
  const localA = def({ id: "a", label: "上线审查", skill: "release-check" });
  const localB = def({ id: "b", label: "其它", skill: "other-skill" });
  const teamA = def({
    id: "team:release-check",
    label: "团队上线",
    skill: "release-check",
    origin: "team",
  });
  const legacy = def({
    id: "old",
    label: "旧",
    skill: "",
    legacyPlaybook: "# old",
  });

  it("自管 skill 关闭 → 挂它的自建 action 滤掉；team 派生保留", () => {
    const disabled = new Set(["release-check"]);
    const out = filterAdvanceByDisabledAppSkills(
      [localA, localB, teamA],
      disabled,
    );
    expect(out.map((d) => d.id)).toEqual(["b", "team:release-check"]);
  });

  it("空禁用集 → 原样", () => {
    expect(
      filterAdvanceByDisabledAppSkills([localA, localB], new Set()).map(
        (d) => d.id,
      ),
    ).toEqual(["a", "b"]);
  });

  it("与 usableCustomActions 组合：legacy 先滤、再按关闭 skill 滤", () => {
    const disabled = new Set(["release-check"]);
    const out = filterAdvanceByDisabledAppSkills(
      usableCustomActions([localA, localB, legacy]),
      disabled,
    );
    expect(out.map((d) => d.id)).toEqual(["b"]);
  });
});

describe("filterAdvanceByRequiresKnowledge", () => {
  it("总开关开 → 原样", () => {
    const defs = [
      def({
        id: "app:a",
        label: "A",
        skill: "a",
        origin: "app-skill",
        requiresKnowledge: true,
      }),
    ];
    expect(
      filterAdvanceByRequiresKnowledge(defs, true).map((d) => d.id),
    ).toEqual(["app:a"]);
  });

  it("总开关关 → 藏 requiresKnowledge；app/team 同构", () => {
    const defs = [
      def({
        id: "app:a",
        label: "A",
        skill: "a",
        origin: "app-skill",
        requiresKnowledge: true,
      }),
      def({
        id: "app:b",
        label: "B",
        skill: "b",
        origin: "app-skill",
      }),
      def({
        id: "team:c",
        label: "C",
        skill: "c",
        origin: "team",
        requiresKnowledge: true,
      }),
    ];
    expect(
      filterAdvanceByRequiresKnowledge(defs, false).map((d) => d.id),
    ).toEqual(["app:b"]);
  });
});
