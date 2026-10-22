/**
 * 运行中输入框 placeholder 的键位提示必须跟个人提交快捷键一致（第二轮 review U3b-04）。
 *
 * 之前 task 说话条写死「AI 正在跑，回车排队…」，而默认设置是 `mod-enter`：
 * 用户照着提示按 Enter 只会换行、排不进队。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { getRunningQueuePlaceholder } from "@/lib/submit-shortcut";

describe("getRunningQueuePlaceholder", () => {
  it("mod-enter（默认）：提示 Cmd/Ctrl+Enter，不再说「回车」", () => {
    const text = getRunningQueuePlaceholder("mod-enter");
    expect(text).toContain("Cmd/Ctrl+Enter");
    expect(text).toContain("排队");
    expect(text).not.toContain("回车");
  });

  it("enter：提示 Enter", () => {
    const text = getRunningQueuePlaceholder("enter");
    expect(text).toContain("Enter");
    expect(text).not.toContain("Cmd/Ctrl");
  });
});

describe("task 说话条不再写死「回车排队」", () => {
  it("task-talk-composer 用 getRunningQueuePlaceholder + useSubmitShortcut", () => {
    const src = readFileSync(
      path.resolve(import.meta.dirname, "../src/components/tasks/task-talk-composer.tsx"),
      "utf-8",
    );
    expect(src).not.toContain("回车排队");
    expect(src).toContain("getRunningQueuePlaceholder(submitShortcut)");
    expect(src).toContain("useSubmitShortcut()");
  });
});
