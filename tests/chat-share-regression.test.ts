/**
 * 回归：「分享到需求群」只该对 task(log) 形态的日常任务放开；chat 形态保持 1.9.42 的行为
 * （chat 无飞书链接 → 不出现；chat 有飞书链接 → 出现）。
 * 真渲染 EventRow（SSR），不是源码字符串；放到 tests/ 下即可跑。
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { EventRow } from "@/components/tasks/event-stream/rows";
import { DialogProvider } from "@/hooks/use-dialog";
import type { Task, TaskEvent } from "@/lib/types";

const STORY = "https://project.feishu.cn/x/story/detail/1";
const mk = (over: Partial<Task>): Task =>
  ({ id: "t1", title: "x", mode: "chat", actions: [], events: [], repoPaths: [], ...over }) as unknown as Task;
const ev = { id: "e1", ts: 1, kind: "assistant_message", text: "AI 的回复" } as unknown as TaskEvent;
const html = (task: Task, variant: "chat" | "log") =>
  renderToStaticMarkup(
    createElement(DialogProvider, null, createElement(EventRow, { ev, taskId: task.id, task, variant })),
  );

describe("AI 回复的「分享到需求群」按形态出现", () => {
  it("对照：复制原文在所有形态都有（证明这里真渲染出了动作条）", () => {
    expect(html(mk({}), "chat")).toContain("复制原文");
    expect(html(mk({ mode: "task" }), "log")).toContain("复制原文");
  });
  it("chat 没有飞书链接 → 不出现（没有需求群入口、不能凭空给每个对话建群）", () => {
    expect(html(mk({ feishuStoryUrl: undefined }), "chat")).not.toContain("分享到需求群");
  });
  it("chat 有飞书链接 → 出现（和 1.9.42 一致）", () => {
    expect(html(mk({ feishuStoryUrl: STORY }), "chat")).toContain("分享到需求群");
  });
  it("task(log) 日常任务（没有飞书链接）→ 出现（本次要放开的）", () => {
    expect(html(mk({ mode: "task", feishuStoryUrl: undefined }), "log")).toContain("分享到需求群");
  });
  it("task(log) 需求任务 → 出现", () => {
    expect(html(mk({ mode: "task", feishuStoryUrl: STORY }), "log")).toContain("分享到需求群");
  });
});
