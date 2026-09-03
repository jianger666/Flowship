import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const readSrc = (rel: string) =>
  readFileSync(path.resolve(import.meta.dirname, "..", rel), "utf-8");

describe("测试任务创建与编辑交互", () => {
  it("创建时固化角色，并在创建 / 编辑两处提供可后补的被测业务分支", () => {
    const launch = readSrc("src/components/tasks/task-launch-form.tsx");
    const edit = readSrc("src/components/tasks/edit-task-dialog.tsx");
    const shared = readSrc("src/components/tasks/feature-branches-field.tsx");
    expect(launch).toContain("workRole: userRole ?? undefined");
    // 两处只负责可见条件 + hint 文案，行布局只此一份
    expect(launch).toContain("FeatureBranchesField");
    expect(edit).toContain("FeatureBranchesField");
    expect(launch).toContain("开发分支还没建立时可以留空");
    expect(edit).toContain("补上后从下一个 Action 起生效");
    expect(shared).toContain("被测业务分支（可后补）");
  });

  it("测试任务不展示 REQ-ID", () => {
    const launch = readSrc("src/components/tasks/task-launch-form.tsx");
    const edit = readSrc("src/components/tasks/edit-task-dialog.tsx");
    expect(launch).toContain('!isDailyLaunch && userRole !== "qa"');
    expect(edit).toContain("storyUrlLockedHas && !testingTask");
    expect(launch).toContain('userRole !== "qa" &&');
    expect(edit).toContain("!testingTask &&");
    expect(launch).toContain('label="REQ-ID"');
    expect(edit).toContain('<Label htmlFor="edit-req-id">REQ-ID</Label>');
    expect(`${launch}\n${edit}`).not.toContain(">需求编号</Label>");
  });

  it("被测业务分支 Combobox 把 flex-1 打在 wrapper 上，且默认不许造新分支名", () => {
    // 行布局收敛到共用组件后，约束断言跟过去（调用方不再各自拼 Combobox）
    const shared = readSrc("src/components/tasks/feature-branches-field.tsx");
    const launch = readSrc("src/components/tasks/task-launch-form.tsx");
    const edit = readSrc("src/components/tasks/edit-task-dialog.tsx");
    expect(shared).toContain('wrapperClassName="w-auto min-w-0 flex-1"');
    expect(shared).toContain("allowCustom={Boolean(entry?.gitMissing)}");
    expect(shared).not.toContain("className=\"min-w-0 flex-1\"");
    expect(shared).not.toContain("可在上方直接输入业务分支");
    for (const src of [launch, edit]) {
      expect(src).toContain("FeatureBranchesField");
    }
  });
});
