/**
 * wk:* 指令映射：哪些 action 算「wk 系」、指令 → stage / scope / 该带哪些 path
 *
 * 这层判定是门禁的总闸——判错了要么该拦的没拦、要么普通 action 被误拦，
 * 所以正反例都要钉死（尤其 `wk-harness` / `wk-fe-harness` 这类同前缀但不是指令的 skill）。
 */
import { describe, expect, it } from "vitest";

import {
  WK_COMMANDS,
  isWkCommand,
  wkCommandForAction,
  wkCommandForSkill,
  wkNeedsBizPath,
  wkNeedsRepoPath,
  wkScopeOf,
  wkStageOf,
} from "@/lib/wk-command";

describe("wkCommandForSkill", () => {
  it("九个官方壳 skill 一一映射成指令名", () => {
    expect(wkCommandForSkill("wk-biz-analyze")).toBe("wk:biz-analyze");
    expect(wkCommandForSkill("wk-repo-design")).toBe("wk:repo-design");
    expect(wkCommandForSkill("wk-repo-execute")).toBe("wk:repo-execute");
    expect(wkCommandForSkill("wk-repo-review")).toBe("wk:repo-review");
    expect(wkCommandForSkill("wk-biz-verify")).toBe("wk:biz-verify");
    // 九个都能映射回去（防表漏项）
    for (const cmd of WK_COMMANDS) {
      expect(wkCommandForSkill(`wk-${cmd.slice(3)}`)).toBe(cmd);
    }
  });

  it("同前缀但不是指令的知识库 skill 一律 null", () => {
    // 这三个真实存在于团队库里，误判会让「打开 wk-harness 文档」之类操作也吃门禁
    expect(wkCommandForSkill("wk-harness")).toBeNull();
    expect(wkCommandForSkill("wk-fe-harness")).toBeNull();
    expect(wkCommandForSkill("wk-java-testing")).toBeNull();
  });

  it("非 wk- 前缀 / 空 / undefined → null", () => {
    expect(wkCommandForSkill("crm-web")).toBeNull();
    expect(wkCommandForSkill("")).toBeNull();
    expect(wkCommandForSkill(undefined)).toBeNull();
    expect(wkCommandForSkill("  wk-repo-design  ")).toBe("wk:repo-design");
  });

  it("isWkCommand 只认九个字面", () => {
    expect(isWkCommand("wk:repo-design")).toBe(true);
    expect(isWkCommand("wk:whatever")).toBe(false);
  });
});

describe("wkCommandForAction（推进 / 后置门禁的唯一判定入口）", () => {
  it("wk- 前缀壳 → 指令", () => {
    expect(wkCommandForAction({ skill: "wk-repo-execute", order: 50 })).toBe(
      "wk:repo-execute",
    );
    // 没 order 也认（isWkFlowShell 的 wk- 前缀分支）
    expect(wkCommandForAction({ skill: "wk-biz-confirm" })).toBe(
      "wk:biz-confirm",
    );
  });

  it("有 order 但 skill 不是官方指令 → null（同事共享的杂项 action 不吃门禁）", () => {
    // isWkFlowShell 对「带 order」返 true，但落不到九个指令上就不该跑门禁
    expect(wkCommandForAction({ skill: "joint-debug-checklist", order: 20 })).toBeNull();
  });

  it("普通自建 action / 缺定义 → null", () => {
    expect(wkCommandForAction({ skill: "my-own-skill" })).toBeNull();
    expect(wkCommandForAction(undefined)).toBeNull();
    expect(wkCommandForAction(null)).toBeNull();
  });
});

describe("stage / scope / path 需求（对齐官方 runner.py 与 command-contract.md）", () => {
  it("stage 名 = 去掉 wk: 前缀", () => {
    expect(wkStageOf("wk:repo-design")).toBe("repo-design");
    expect(wkStageOf("wk:biz-analyze")).toBe("biz-analyze");
  });

  it("repo 域三个指令：repo-design / repo-execute / repo-review", () => {
    const repoScoped = WK_COMMANDS.filter((c) => wkScopeOf(c) === "repo");
    expect(repoScoped).toEqual([
      "wk:repo-design",
      "wk:repo-execute",
      "wk:repo-review",
    ]);
  });

  it("preflight 的 --biz-path / --repo-path 要求与 check_command_gate 一致", () => {
    // prd-review 什么都不校验
    expect(wkNeedsBizPath("wk:prd-review")).toBe(false);
    expect(wkNeedsRepoPath("wk:prd-review")).toBe(false);
    // repo-design 只看业务级
    expect(wkNeedsBizPath("wk:repo-design")).toBe(true);
    expect(wkNeedsRepoPath("wk:repo-design")).toBe(false);
    // repo-execute 两边都看
    expect(wkNeedsBizPath("wk:repo-execute")).toBe(true);
    expect(wkNeedsRepoPath("wk:repo-execute")).toBe(true);
    // repo-review 只看仓库级
    expect(wkNeedsBizPath("wk:repo-review")).toBe(false);
    expect(wkNeedsRepoPath("wk:repo-review")).toBe(true);
  });
});
