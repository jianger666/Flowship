import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const readSrc = (rel: string) =>
  readFileSync(path.resolve(import.meta.dirname, "..", rel), "utf-8");

describe("测试任务创建与编辑交互", () => {
  it("创建时固化角色，并在创建 / 编辑两处提供可后补的被测业务分支", () => {
    const launch = readSrc("src/components/tasks/task-launch-form.tsx");
    const edit = readSrc("src/components/tasks/edit-task-dialog.tsx");
    expect(launch).toContain("workRole: userRole ?? undefined");
    expect(launch).toContain("被测业务分支（可后补）");
    expect(edit).toContain("被测业务分支（可后补）");
    expect(edit).toContain("补上后从下一个 Action 起生效");
  });

  it("测试任务不展示 REQ-ID，并且业务分支在探测失败时仍允许手填", () => {
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
});
