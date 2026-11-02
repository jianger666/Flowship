/**
 * EditTaskDialog 的 settings 快照不能是 mount 时求值一次就永久陈旧（评审）：
 * dialog 常驻、首次 render 可能早于 initSettings 完成，之后新追加的仓拿不到分支快照。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const src = readFileSync(
  path.join(process.cwd(), "src/components/tasks/edit-task-dialog.tsx"),
  "utf8",
);

describe("EditTaskDialog settings 快照", () => {
  it("不再是 useMemo(() => getSettings(), [])（空依赖 = 永久陈旧）", () => {
    expect(src).not.toMatch(/useMemo\(\(\) => getSettings\(\), \[\]\)/);
  });
  it("打开时 initSettings 完成后刷新快照；依赖 open 与完成计数", () => {
    expect(src).toContain('import { getSettings, initSettings } from "@/lib/local-store";');
    expect(src).toMatch(/void initSettings\(\)\.then\(/);
    expect(src).toContain("setSettingsVersion((v) => v + 1)");
    expect(src).toMatch(/useMemo\(\(\) => getSettings\(\), \[open, settingsVersion\]\)/);
  });
  it("init 回调在关闭 / 卸载后不再 setState（cancelled 闸）", () => {
    expect(src).toMatch(/if \(!cancelled\) setSettingsVersion/);
    expect(src).toMatch(/return \(\) => \{\s*cancelled = true;\s*\};/);
  });
});
