/**
 * 日常任务（没有飞书工作项）和需求任务一样能用需求群。
 *
 * 需求群的关联本来就只存在任务本地（`feishuGroupChatId`），工作项只在三处被「读」：项目群默认回落、
 * 建群时的群名 / 角色成员、分享卡的需求名 / @ 反查。以前日常任务在入口处被一刀切拦掉（按钮不显示、服务端
 * `resolveTaskStory` 抛 `no_story`）；现在这三处各自退化，入口放开。
 *
 * 服务端行为在 feishu-group*.test.ts（ensure / bind / describe / share 的日常任务用例）；
 * 这里钉入口：按钮真会渲出来、详情页 / 事件流 / 播报不再按「有没有飞书链接」分叉。
 *
 * 没有 jsdom：弹窗内的真实交互（点按钮 → 请求 → toast）不在这里验证。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { TaskUtilityActions } from "@/components/tasks/task-utility-actions";
import { DialogProvider } from "@/hooks/use-dialog";
import type { Task } from "@/lib/types";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf-8");

const mkTask = (over: Partial<Task> = {}): Task =>
  ({
    id: "t1",
    title: "修登录页",
    mode: "task",
    repoStatus: "developing",
    runStatus: "idle",
    actions: [],
    events: [],
    repoPaths: ["/tmp/repo"],
    ...over,
  }) as unknown as Task;

const render = (task: Task): string =>
  renderToStaticMarkup(
    createElement(DialogProvider, null, createElement(TaskUtilityActions, { task })),
  );

describe("任务头「需求群」入口：日常任务也有", () => {
  it("日常任务（没有飞书链接）渲出「需求群」按钮", () => {
    expect(render(mkTask({ feishuStoryUrl: undefined }))).toContain("需求群");
    expect(render(mkTask({ feishuStoryUrl: "" }))).toContain("需求群");
  });

  it("需求任务照旧有", () => {
    expect(
      render(mkTask({ feishuStoryUrl: "https://project.feishu.cn/space/story/detail/10001" })),
    ).toContain("需求群");
  });

  it("入口不再按飞书链接判断；弹窗拿到 hasStory 用来区分文案", () => {
    const src = read("src/components/tasks/task-utility-actions.tsx");
    expect(src).not.toMatch(/showRequirementGroup/);
    expect(src).toContain("hasStory={hasStory}");
    expect(src).toContain("const hasStory = !isLightweightDailyTask(task)");
  });
});

describe("弹窗文案：没有工作项就没有「项目群默认」", () => {
  const dialog = read("src/components/tasks/requirement-group-dialog.tsx");

  it("hasStory 缺省按有工作项（原文案不变）", () => {
    expect(dialog).toContain("hasStory = true");
  });

  it("自动创建 / 取消关联 / 换绑 / 重建的说明按 hasStory 分叉：日常任务不提「项目群」「飞书项目上的群绑定」", () => {
    expect(dialog).toContain("按任务标题建群并关联到本任务，首建只拉你本人和你的机器人");
    expect(dialog).toContain("取消后本任务不再关联需求群（群本身不会解散）");
    // 原文案还在（有工作项时）
    expect(dialog).toContain("取消后回到项目群默认。飞书项目上的群绑定不受影响。");
    expect(dialog).toContain('(hasStory ? "飞书项目上的群绑定不受影响。" : "")');
  });
});

describe("分享入口：日常任务不再被隐藏", () => {
  it("详情页产物面板恒开分享（不再传 !isLightweightDailyTask）", () => {
    const page = read("src/app/tasks/[id]/page.tsx");
    expect(page).toMatch(/\n\s+canShareToGroup\n/);
    expect(page).not.toMatch(/canShareToGroup=\{!isLightweightDailyTask/);
  });

  it("事件流 AI 回复的「分享到需求群」：task(log) 形态不再按飞书链接分叉，chat 形态仍按链接（真渲染见 chat-share-regression.test.ts）", () => {
    const rows = read("src/components/tasks/event-stream/rows.tsx");
    // 这条动作条 chat 与 task(log) 共用：只对 task(log) 放开，不然每个 chat 的每条 AI 回复都会冒出「分享到需求群」（第 19 轮 M1）
    expect(rows).toContain('const canShareToGroup = variant === "log" || !isLightweightDailyTask(task);');
    expect(rows).toMatch(/canShareToGroup && \{\s*key: "share",[\s\S]{0,200}label: "分享到需求群"/);
  });
});

describe("仍然需要工作项的两处没有放开（它们本来就依赖工作项的测试人员）", () => {
  it("提测 @ 测试人员：日常任务照旧跳过（没有工作项就没有测试人员名单）", () => {
    const src = read("src/lib/server/feishu-bridge/group-tester-notify.ts");
    expect(src).toContain('if (isLightweightDailyTask(task)) return "skipped_lightweight"');
  });
});
