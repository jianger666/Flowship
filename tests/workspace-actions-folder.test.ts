import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const source = readFileSync(
  path.resolve(
    import.meta.dirname,
    "../src/components/tasks/workspace-actions.tsx",
  ),
  "utf-8",
);

describe("任务文件夹入口", () => {
  it("通过系统 open-path API 打开 taskDirPath", () => {
    expect(source).toContain('fetch("/api/system/open-path"');
    expect(source).toContain("JSON.stringify({ path: taskDirPath })");
    expect(source).toContain("onClick={() => void openTaskFolder()}");
  });

  it("按钮名保持任务文件夹，并用 tooltip 说明文件管理器行为", () => {
    expect(source).toContain("任务文件夹");
    expect(source).toContain("在文件管理器打开");
    expect(source).not.toContain("taskDirAnchor");
    expect(source).not.toMatch(/getIdeAnchorProps\(task\.taskDirPath/);
  });
});
