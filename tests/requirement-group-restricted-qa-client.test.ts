/**
 * 群答疑「按群开关」的前端侧已删除（第 11 轮：用户决定答疑默认开、不要开关）。
 *
 * 旧版这里测的是 `setRequirementGroupRestrictedQa`（PATCH 开关）与弹窗里的开关接线，整套都没了。
 * 现在只钉「删干净了、没有残留的开关入口 / 过期文案」：
 * - 客户端不再导出开关 helper；
 * - 弹窗不再有开关控件 / 开关状态 / 「默认关闭」「允许群成员 @ 机器人提问」「按群开关」这类文案；
 * - R7-2 / R7-3 的旧过度宣称文案（外部租户会被拒 / 租户一致才放行 / 只能读任务产出与代码）也不得回来。
 * （没有行为可测的纯 UI 删除，所以这里是源码契约；准入行为本身见 group-route-restricted-qa-gate.test.ts。）
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import * as taskStore from "@/lib/task-store";

const read = (rel: string): string =>
  readFileSync(path.resolve(__dirname, "..", rel), "utf8");

const DIALOG = read("src/components/tasks/requirement-group-dialog.tsx");
const TASK_STORE = read("src/lib/task-store.ts");

describe("群答疑开关前端已删除", () => {
  it("task-store 不再导出 setRequirementGroupRestrictedQa", () => {
    expect("setRequirementGroupRestrictedQa" in taskStore).toBe(false);
    expect(TASK_STORE).not.toContain("restrictedQaEnabled");
  });

  it("弹窗里没有开关控件、没有开关状态", () => {
    expect(DIALOG).not.toMatch(/restrictedQa|RestrictedQa|qaBusy/);
    expect(DIALOG).not.toMatch(/from "@\/components\/ui\/switch"/);
    expect(DIALOG).not.toMatch(/<Switch\b/);
  });

  it("弹窗里没有开关文案（默认关闭 / 允许群成员 @ 机器人提问 / 按群开关 / 换绑后需重新开启）", () => {
    expect(DIALOG).not.toContain("允许群成员 @ 机器人提问");
    expect(DIALOG).not.toContain("按群开关");
    expect(DIALOG).not.toContain("默认关闭");
    expect(DIALOG).not.toContain("重新开启");
  });

  it("不回到 R7-2 / R7-3 的旧过度宣称文案", () => {
    expect(DIALOG).not.toContain("只能读任务产出与代码");
    expect(DIALOG).not.toMatch(/外部租户的成员也会被拒/);
    expect(DIALOG).not.toMatch(/租户一致才放行/);
  });
});
