/**
 * 失效 / 断线的提问卡仍要能看到「问了什么」（第二轮 review V6-01）
 *
 * 背景：失效态的答题卡只渲染一行灰字，却叫用户「在底部输入条说句话，AI 会读历史（含这组问题）继续」；
 * 事件流里「已失效」的回放行同样没有题干——用户不知道 AI 到底问了什么、该怎么回。
 *
 * 取题走 lib/ask-pending 的 extractAskQuestions（单一源）；本文件钉两件事：
 * 1. 纯函数：从 meta 取只读题干（脏数据 / meta 丢了退回事件原文）
 * 2. 接线契约：内联卡的失效态、回放行的「已失效」两处都挂了同一个只读题干组件
 *
 * UI 组件在 node 环境跑不起来（见 vitest.config.ts），接线靠源码契约。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { resumeHintFor } from "@/lib/stop-copy";

import {
  ASK_QUESTIONS_READONLY_LABEL,
  readonlyAskQuestions,
} from "@/lib/ask-questions-readonly";

const srcDir = path.resolve(import.meta.dirname, "..", "src");
const read = (...seg: string[]): string =>
  readFileSync(path.join(srcDir, ...seg), "utf-8");

describe("readonlyAskQuestions：失效提问卡的只读题干", () => {
  it("按序号列出 meta.questions 的题干，题号从 1 起", () => {
    const view = readonlyAskQuestions(
      {
        askId: "a1",
        questions: [
          { id: "q1", question: "用哪个库？", options: [{ id: "o1", label: "dayjs" }] },
          { id: "q2", question: "要不要加测试？" },
        ],
      },
      "Q1: 用哪个库？\nQ2: 要不要加测试？",
    );
    expect(view.fromMeta).toBe(true);
    expect(view.items).toEqual([
      { key: "q1", label: "Q1", text: "用哪个库？" },
      { key: "q2", label: "Q2", text: "要不要加测试？" },
    ]);
  });

  it("脏条目（缺 id / question 不是字符串）跳过，序号只数留下来的", () => {
    const view = readonlyAskQuestions(
      {
        questions: [
          { id: "q1" },
          null,
          { id: "q2", question: "留下的这题" },
        ],
      },
      "",
    );
    expect(view.items).toEqual([{ key: "q2", label: "Q1", text: "留下的这题" }]);
    expect(view.fromMeta).toBe(true);
  });

  it("meta.questions 丢了（老事件 / 脏数据）：退回事件原文，整段当一项、没有题号", () => {
    for (const meta of [undefined, {}, { questions: "oops" }, { questions: [] }]) {
      const view = readonlyAskQuestions(meta, "Q1: 原文里的题干");
      expect(view.fromMeta).toBe(false);
      expect(view.items).toEqual([
        { key: "fallback", label: "", text: "Q1: 原文里的题干" },
      ]);
    }
  });

  it("meta 和事件原文都没有内容：返回空（组件据此什么都不画，不留一个空的展开钮）", () => {
    expect(readonlyAskQuestions(undefined, "").items).toEqual([]);
    expect(readonlyAskQuestions({ questions: [] }, "   \n ").items).toEqual([]);
    expect(readonlyAskQuestions(undefined, undefined).items).toEqual([]);
  });

  it("展开钮文案固定，不随题数拼接（Q 数在卡头已经写了）", () => {
    expect(ASK_QUESTIONS_READONLY_LABEL).toBe("查看这组问题");
  });
});

describe("接线契约：失效 / 断线的两处都能看到题干", () => {
  const card = read("components", "tasks", "ask-user-inline.tsx");
  const rows = read("components", "tasks", "event-stream", "rows.tsx");
  const widget = read(
    "components",
    "tasks",
    "event-stream",
    "ask-questions-readonly.tsx",
  );

  it("只读题干组件：取题走 lib、折叠体走 <Collapse>、展开钮带 aria-expanded", () => {
    expect(widget).toContain("readonlyAskQuestions(");
    expect(widget).toContain("<Collapse");
    expect(widget).toContain("aria-expanded");
    // 折叠行样式走事件流单一来源，别另写一份
    expect(widget).toContain("PROCESS_ROW_BUTTON");
    expect(widget).toContain("CollapseChevron");
    // 默认收起：失效了就说明不再等答
    expect(widget).toMatch(/useState\(false\)/);
  });

  it("内联答题卡：失效态（断线 / 过期）下渲染只读题干，且仍保留原来的提示行", () => {
    expect(card).toContain("AskQuestionsReadonly");
    // 组件必须出现在 isStale 分支里（在 notice 之后、非失效分支之前）
    const staleStart = card.indexOf("{isStale ? (");
    const liveStart = card.indexOf("<ComposerSessionProvider value={composerSession}>");
    expect(staleStart).toBeGreaterThan(0);
    expect(liveStart).toBeGreaterThan(staleStart);
    const staleBranch = card.slice(staleStart, liveStart);
    expect(staleBranch).toContain("<AskQuestionsReadonly");
    expect(staleBranch).toContain("meta={ev.meta}");
    // 提示行仍在：第四轮 Q6-07 起恢复引导统一走 stop-copy 的 resumeHintFor（不再各处手写「在底部输入条说句话」）
    expect(staleBranch).toContain("resumeHintFor(task.mode)");
    expect(staleBranch).toContain("AI 会接着读历史（含这组问题）继续");
    expect(resumeHintFor("task")).toContain("在底部输入条说句话");
  });

  it("回放行：「已失效」分支渲染只读题干（跳过 / 过期走各自的折叠行，不重复）", () => {
    expect(rows).toContain("AskQuestionsReadonly");
    expect(rows).toMatch(/\{superseded && \(\s*<AskQuestionsReadonly/);
  });
});
