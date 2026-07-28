/**
 * advance-options：server 端「可推进 action 清单」——与推进弹窗同一套
 * 数据源 / 过滤链 / 分组序（群内推进选择卡、「推进 <名字>」匹配都吃它）。
 * 全部 mock 读盘模块（settings / custom actions / skill 禁用表）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CustomActionDef } from "@/lib/types";

const { listCustomActions, readSettingsFile, readDisabledSkills, readTeamKnowledgeEnabled } =
  vi.hoisted(() => ({
    listCustomActions: vi.fn(),
    readSettingsFile: vi.fn(),
    readDisabledSkills: vi.fn(),
    readTeamKnowledgeEnabled: vi.fn(),
  }));

vi.mock("@/lib/server/custom-action-fs", () => ({ listCustomActions }));
vi.mock("@/lib/server/settings-fs", () => ({ readSettingsFile }));
vi.mock("@/lib/server/skills-loader", () => ({
  readDisabledSkills,
  readTeamKnowledgeEnabled,
}));

const { listAdvanceOptionGroupsForTask } = await import(
  "@/lib/server/advance-options"
);

const def = (over: Partial<CustomActionDef> & { id: string }): CustomActionDef =>
  ({
    label: over.id,
    skill: "",
    createdAt: 0,
    updatedAt: 0,
    ...over,
  }) as CustomActionDef;

/** 正式任务（有飞书链接）/ 日常任务（无）两种形态 */
const formalTask = { feishuStoryUrl: "https://project.feishu.cn/x/story/1" };
const dailyTask = { feishuStoryUrl: undefined };

beforeEach(() => {
  vi.clearAllMocks();
  readSettingsFile.mockResolvedValue({ status: "ok", settings: {} });
  readDisabledSkills.mockResolvedValue(new Set());
  readTeamKnowledgeEnabled.mockResolvedValue(true);
  listCustomActions.mockResolvedValue([]);
});

describe("listAdvanceOptionGroupsForTask", () => {
  it("默认分组序：通用（内置全量）在前、自定义在后；label 取中文标 / def.label", async () => {
    listCustomActions.mockResolvedValue([
      def({
        id: "app:weekly-report",
        label: "周报生成",
        skill: "weekly-report",
        origin: "app-skill",
      }),
    ]);
    const groups = await listAdvanceOptionGroupsForTask(formalTask);
    expect(groups.map((g) => g.key)).toEqual(["builtin", "custom"]);
    expect(groups[0]!.options.map((o) => o.key)).toEqual([
      "plan",
      "build",
      "review",
      "dev",
      "ship",
    ]);
    expect(groups[0]!.options[0]).toMatchObject({
      label: "出方案",
      actionType: "plan",
    });
    expect(groups[1]!.options).toEqual([
      {
        key: "app:weekly-report",
        label: "周报生成",
        actionType: "custom",
        customActionId: "app:weekly-report",
        skill: "weekly-report",
      },
    ]);
  });

  it("布局偏好生效：hidden 的不出现、order 重排组内顺序", async () => {
    readSettingsFile.mockResolvedValue({
      status: "ok",
      settings: {
        actionLayout: {
          order: ["review", "plan"],
          hidden: ["build", "dev", "ship"],
        },
      },
    });
    const groups = await listAdvanceOptionGroupsForTask(formalTask);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.options.map((o) => o.key)).toEqual(["review", "plan"]);
  });

  it("wk 流程壳进「团队」组、按 def.order 升序；杂项共享进「共享」组", async () => {
    listCustomActions.mockResolvedValue([
      def({ id: "team:wk-b", label: "B", skill: "wk-b", origin: "team", order: 20 }),
      def({ id: "team:wk-a", label: "A", skill: "wk-a", origin: "team", order: 10 }),
      def({
        id: "team:misc",
        label: "杂项",
        skill: "misc",
        origin: "team",
        teamCategory: "shared:fe",
      }),
    ]);
    const groups = await listAdvanceOptionGroupsForTask(formalTask);
    expect(groups.map((g) => g.key)).toEqual(["builtin", "team", "shared"]);
    const team = groups.find((g) => g.key === "team")!;
    expect(team.options.map((o) => o.key)).toEqual(["team:wk-a", "team:wk-b"]);
  });

  it("日常任务（无飞书链接）只留自定义组", async () => {
    listCustomActions.mockResolvedValue([
      def({ id: "app:fix", label: "改bug", skill: "fix-bug", origin: "app-skill" }),
    ]);
    const groups = await listAdvanceOptionGroupsForTask(dailyTask);
    expect(groups.map((g) => g.key)).toEqual(["custom"]);
    expect(groups[0]!.options.map((o) => o.key)).toEqual(["app:fix"]);
  });

  it("关掉的自管 skill：挂它的自建 action 不出现", async () => {
    readDisabledSkills.mockResolvedValue(new Set(["weekly-report"]));
    listCustomActions.mockResolvedValue([
      def({
        id: "app:weekly-report",
        label: "周报生成",
        skill: "weekly-report",
        origin: "app-skill",
      }),
      def({ id: "app:fix", label: "改bug", skill: "fix-bug", origin: "app-skill" }),
    ]);
    const groups = await listAdvanceOptionGroupsForTask(formalTask);
    const custom = groups.find((g) => g.key === "custom")!;
    expect(custom.options.map((o) => o.key)).toEqual(["app:fix"]);
  });

  it("团队规范总开关关：requiresKnowledge 与 knowledge 派生 action 隐藏、shared 保留", async () => {
    readTeamKnowledgeEnabled.mockResolvedValue(false);
    listCustomActions.mockResolvedValue([
      def({
        id: "app:needs-kb",
        label: "依赖规范",
        skill: "needs-kb",
        origin: "app-skill",
        requiresKnowledge: true,
      }),
      def({
        id: "team:kb-derived",
        label: "规范派生",
        skill: "kb-derived",
        origin: "team",
        teamCategory: "fe",
      }),
      def({
        id: "team:shared-misc",
        label: "共享杂项",
        skill: "shared-misc",
        origin: "team",
        teamCategory: "shared:fe",
      }),
    ]);
    const groups = await listAdvanceOptionGroupsForTask(formalTask);
    const flat = groups.flatMap((g) => g.options.map((o) => o.key));
    expect(flat).not.toContain("app:needs-kb");
    expect(flat).not.toContain("team:kb-derived");
    expect(flat).toContain("team:shared-misc");
  });

  it("legacy 旧格式 action 不进清单（推进弹窗同口径）", async () => {
    listCustomActions.mockResolvedValue([
      def({ id: "old-one", label: "旧的", legacyPlaybook: "playbook 正文" }),
    ]);
    const groups = await listAdvanceOptionGroupsForTask(formalTask);
    expect(groups.flatMap((g) => g.options.map((o) => o.key))).not.toContain(
      "old-one",
    );
  });

  it("config.json 缺失 / 损坏按空布局兜底、不抛", async () => {
    readSettingsFile.mockResolvedValue({ status: "error", reason: "坏了" });
    const groups = await listAdvanceOptionGroupsForTask(formalTask);
    expect(groups[0]!.options.length).toBeGreaterThan(0);
  });
});
