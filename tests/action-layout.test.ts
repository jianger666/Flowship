/**
 * action-layout 纯函数：排序 / 显隐 / 删 id 清理 / 关闭自管 skill 推进过滤 / 分组
 */
import { describe, expect, it } from "vitest";

import {
  arrangeByLayout,
  filterAdvanceByDisabledAppSkills,
  filterAdvanceByRequiresKnowledge,
  groupAdvanceActions,
  isWkFlowShell,
  normalizeCollapsedGroups,
  normalizeGroupOrder,
  partitionActionsByGroup,
  removeActionLayoutId,
  resolveActionGroup,
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

  it("清 id 时保留 groupOrder / collapsedGroups", () => {
    const next = removeActionLayoutId(
      {
        order: ["plan", "x"],
        hidden: [],
        groupOrder: ["custom", "builtin", "team", "shared"],
        collapsedGroups: ["team"],
      },
      "x",
    );
    expect(next.groupOrder).toEqual(["custom", "builtin", "team", "shared"]);
    expect(next.collapsedGroups).toEqual(["team"]);
    expect(next.order).toEqual(["plan"]);
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

describe("分组：resolveActionGroup / groupAdvanceActions / normalize*", () => {
  // wk 壳：有 order（九壳 10~90）
  const wkByOrder = def({
    id: "team:wk-plan",
    label: "方案",
    skill: "wk-plan",
    origin: "team",
    order: 20,
  });
  // wk 壳：仅 wk- 前缀、无 order（仍进 team）
  const wkByName = def({
    id: "team:wk-ship",
    label: "提测",
    skill: "wk-ship",
    origin: "team",
  });
  // 有 order 的非 wk 名：仍算壳（order 信号）
  const wkOrderOnly = def({
    id: "team:flow-build",
    label: "开发",
    skill: "flow-build",
    origin: "team",
    order: 30,
  });
  // 共享杂项：origin=team、无 order、非 wk- 前缀
  const sharedMisc = def({
    id: "team:svc-debug",
    label: "服务排查",
    skill: "svc-debug",
    origin: "team",
  });
  const sharedBug = def({
    id: "team:file-bug",
    label: "提缺陷",
    skill: "file-bug",
    origin: "team",
  });
  const appX = def({
    id: "app:x",
    label: "X",
    skill: "x",
    origin: "app-skill",
  });
  const legacy = def({ id: "old", label: "旧", skill: "" });

  const byId = new Map(
    [
      wkByOrder,
      wkByName,
      wkOrderOnly,
      sharedMisc,
      sharedBug,
      appX,
      legacy,
    ].map((d) => [d.id, d] as const),
  );

  it("isWkFlowShell：wk- 前缀或有限 order 取或", () => {
    expect(isWkFlowShell(wkByOrder)).toBe(true);
    expect(isWkFlowShell(wkByName)).toBe(true);
    expect(isWkFlowShell(wkOrderOnly)).toBe(true);
    expect(isWkFlowShell(sharedMisc)).toBe(false);
    expect(isWkFlowShell(undefined)).toBe(false);
  });

  it("归属：builtin / wk壳→team / 其余team→shared / 自建→custom", () => {
    expect(resolveActionGroup("plan", byId)).toBe("builtin");
    expect(resolveActionGroup("team:wk-plan", byId)).toBe("team");
    expect(resolveActionGroup("team:wk-ship", byId)).toBe("team");
    expect(resolveActionGroup("team:flow-build", byId)).toBe("team");
    expect(resolveActionGroup("team:svc-debug", byId)).toBe("shared");
    expect(resolveActionGroup("team:file-bug", byId)).toBe("shared");
    expect(resolveActionGroup("app:x", byId)).toBe("custom");
    expect(resolveActionGroup("old", byId)).toBe("custom");
    expect(resolveActionGroup("ghost", byId)).toBe("custom");
  });

  it("按默认组序分桶、空组不返回、team 按 order 升序", () => {
    const groups = groupAdvanceActions(
      [
        "plan",
        "team:wk-plan",
        "app:x",
        "team:wk-ship",
        "team:flow-build",
        "team:svc-debug",
        "build",
      ],
      byId,
    );
    expect(groups.map((g) => g.key)).toEqual([
      "builtin",
      "team",
      "shared",
      "custom",
    ]);
    expect(groups[0]!.keys).toEqual(["plan", "build"]);
    // team：有 order 的升序（wk-plan=20 → flow-build=30），无 order 的 wk-ship 接后
    expect(groups[1]!.keys).toEqual([
      "team:wk-plan",
      "team:flow-build",
      "team:wk-ship",
    ]);
    expect(groups[2]!.keys).toEqual(["team:svc-debug"]);
    expect(groups[3]!.keys).toEqual(["app:x"]);
  });

  it("groupOrder 可调；空组跳过", () => {
    const groups = groupAdvanceActions(
      ["plan", "app:x"],
      byId,
      ["custom", "builtin", "team", "shared"],
    );
    expect(groups.map((g) => g.key)).toEqual(["custom", "builtin"]);
    expect(groups[0]!.keys).toEqual(["app:x"]);
    expect(groups[1]!.keys).toEqual(["plan"]);
  });

  it("normalizeGroupOrder：去重 + 补齐四组；存量三组在 team 后插 shared", () => {
    expect(normalizeGroupOrder(undefined)).toEqual([
      "builtin",
      "team",
      "shared",
      "custom",
    ]);
    // 存量默认三组 → shared 插在 team 后
    expect(normalizeGroupOrder(["builtin", "team", "custom"])).toEqual([
      "builtin",
      "team",
      "shared",
      "custom",
    ]);
    // 用户调过组序的三组 → shared 仍跟在 team 后
    expect(normalizeGroupOrder(["custom", "builtin", "team"])).toEqual([
      "custom",
      "builtin",
      "team",
      "shared",
    ]);
    expect(normalizeGroupOrder(["custom", "custom", "nope", "builtin"])).toEqual(
      ["custom", "builtin", "team", "shared"],
    );
  });

  it("normalizeCollapsedGroups：只留合法组 key（含 shared）", () => {
    expect(
      normalizeCollapsedGroups(["team", "team", "x", "custom", "shared"]),
    ).toEqual(["team", "custom", "shared"]);
  });

  it("partitionActionsByGroup includeEmpty：空组也出组头（四组）", () => {
    const groups = partitionActionsByGroup(["plan"], byId, undefined, {
      includeEmpty: true,
    });
    expect(groups.map((g) => g.key)).toEqual([
      "builtin",
      "team",
      "shared",
      "custom",
    ]);
    expect(groups[0]!.keys).toEqual(["plan"]);
    expect(groups[1]!.keys).toEqual([]);
    expect(groups[2]!.keys).toEqual([]);
    expect(groups[3]!.keys).toEqual([]);
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
