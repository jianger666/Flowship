/**
 * 「改bug」预置可用判定（isFixBugPresetUsable）纯逻辑单测
 *
 * 覆盖：出厂态 / 挂自定义 skill / 挂载不可见 / action 缺失（及 legacy、空 skill）
 */
import { describe, expect, it } from "vitest";

import { BUILTIN_FIX_BUG_ACTION_ID, BUILTIN_FIX_BUG_SKILL } from "@/lib/mr-inbox";
import {
  isFixBugPresetUsable,
  type FixBugPresetActionSnap,
} from "@/lib/fix-bug-preset-usable";

const factoryAction = (): FixBugPresetActionSnap => ({
  id: BUILTIN_FIX_BUG_ACTION_ID,
  skill: BUILTIN_FIX_BUG_SKILL,
});

describe("isFixBugPresetUsable", () => {
  it("出厂态（action 挂 fix-bug 且可见）→ 可用", () => {
    expect(
      isFixBugPresetUsable({
        action: factoryAction(),
        visibleSkillNames: [BUILTIN_FIX_BUG_SKILL, "other"],
      }),
    ).toBe(true);
  });

  it("挂载自定义 skill 且可见 → 可用（同事换挂自己的流程）", () => {
    expect(
      isFixBugPresetUsable({
        action: {
          id: BUILTIN_FIX_BUG_ACTION_ID,
          skill: "my-team-fix",
        },
        visibleSkillNames: ["my-team-fix", BUILTIN_FIX_BUG_SKILL],
      }),
    ).toBe(true);
  });

  it("挂载 skill 不可见 → 不可用", () => {
    expect(
      isFixBugPresetUsable({
        action: factoryAction(),
        // 目录还在但 frontmatter name 改过 / SKILL.md 删了 → 列表无 fix-bug
        visibleSkillNames: ["something-else"],
      }),
    ).toBe(false);
  });

  it("action 缺失 → 不可用", () => {
    expect(
      isFixBugPresetUsable({
        action: null,
        visibleSkillNames: [BUILTIN_FIX_BUG_SKILL],
      }),
    ).toBe(false);
  });

  it("legacyPlaybook / 空 skill → 不可用", () => {
    expect(
      isFixBugPresetUsable({
        action: {
          id: BUILTIN_FIX_BUG_ACTION_ID,
          skill: "",
          legacyPlaybook: "旧正文",
        },
        visibleSkillNames: [BUILTIN_FIX_BUG_SKILL],
      }),
    ).toBe(false);
    expect(
      isFixBugPresetUsable({
        action: { id: BUILTIN_FIX_BUG_ACTION_ID, skill: "   " },
        visibleSkillNames: [BUILTIN_FIX_BUG_SKILL],
      }),
    ).toBe(false);
  });
});
