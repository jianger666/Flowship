/**
 * 归档的「点了就走 + 进行中反馈」（用户反馈：点归档很久才 toast、还被拽回排期页）。
 *
 * 根因之一在客户端：toast 和 `router.push` 都排在 `await setTaskArchivedWithReport` 之后，而服务端清隔离工作区
 * 要几十秒；push 用的还是点击那一帧闭包里的 activeId——用户早切去别处，返回时仍被硬拽回排期页。
 * 纯函数在 worktree-report.ts，组件接线用源码契约钉（tsconfig 是 jsx:preserve，组件没法直接 import）。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  ARCHIVE_PENDING_TOAST_DELAY_MS,
  archiveLeaveTarget,
  archiveToastId,
  buildArchivePendingToast,
} from "@/lib/worktree-report";

const sidebar = readFileSync(path.join(process.cwd(), "src/components/app-sidebar.tsx"), "utf8");

describe("archiveLeaveTarget：只有点击那一刻正看着这个任务才离开", () => {
  it("正看着 task 模式任务 → 回排期首页；chat → 对话列表", () => {
    expect(archiveLeaveTarget({ id: "t1", mode: "task" }, "t1")).toBe("/");
    expect(archiveLeaveTarget({ id: "t1" }, "t1")).toBe("/");
    expect(archiveLeaveTarget({ id: "t1", mode: "chat" }, "t1")).toBe("/chats");
  });

  it("没看着它（在别的任务 / 非任务页）→ 不动路由", () => {
    expect(archiveLeaveTarget({ id: "t1", mode: "task" }, "t2")).toBeNull();
    expect(archiveLeaveTarget({ id: "t1", mode: "task" }, undefined)).toBeNull();
  });
});

describe("进行中 toast", () => {
  it("toast id 按任务区分：两个任务同时归档各自一条、互不覆盖；同一任务进行中 / 结果共用一个 id", () => {
    expect(archiveToastId("t1")).not.toBe(archiveToastId("t2"));
    expect(archiveToastId("t1")).toBe(archiveToastId("t1"));
  });

  it("隔离工作区任务多一句说明，非隔离任务只有标题行", () => {
    expect(buildArchivePendingToast("改文案", true)).toEqual({
      message: "正在归档「改文案」…",
      description: "正在停止 agent、清理隔离工作区，可以先去做别的",
    });
    expect(buildArchivePendingToast("闲聊", false)).toEqual({ message: "正在归档「闲聊」…" });
  });

  it("延迟出现：快归档不闪（>0 且不至于让用户觉得没反应）", () => {
    expect(ARCHIVE_PENDING_TOAST_DELAY_MS).toBeGreaterThan(0);
    expect(ARCHIVE_PENDING_TOAST_DELAY_MS).toBeLessThanOrEqual(1000);
  });
});

describe("侧栏 handleArchive 接线（时序行为见 archive-feedback.test.ts）", () => {
  const start = sidebar.indexOf("const handleArchive = async");
  const end = sidebar.indexOf("const empty = sorted.length === 0", start);
  const body = sidebar.slice(start, end);

  it("定位到了函数体", () => {
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
  });

  it("时序全交给 runArchiveWithFeedback：把点击那一帧的 activeId / router / toast 传进去", () => {
    expect(sidebar).toContain('import { runArchiveWithFeedback } from "@/lib/archive-feedback"');
    expect(body).toContain("await runArchiveWithFeedback({");
    expect(body).toContain("archive: () => setTaskArchivedWithReport(task.id, true)");
    expect(body).toMatch(/\bactiveId,/);
    expect(body).toContain("navigate: (to) => router.push(to)");
    expect(body).toMatch(/\btoast,\s*\}\);/);
  });

  it("组件里不再自己编排：没有裸 router.push / loading toast / 计时器（退回去就绕过了行为测试）", () => {
    // router.push 只剩传给 navigate 的那一处
    expect(body.split("router.push(").length - 1).toBe(1);
    expect(body).not.toContain("toast.loading(");
    expect(body).not.toContain("setTimeout(");
    expect(body).not.toContain("archiveLeaveTarget(");
  });

  it("失败回调放行标记再恢复行；onSettled 兜底放行 archiving 标记", () => {
    const failed = body.slice(body.indexOf("onFailed: () => {"), body.indexOf("onSettled: () => {"));
    expect(failed.indexOf("unmarkArchiving(task.id)")).toBeGreaterThan(0);
    expect(failed.indexOf("unmarkArchiving(task.id)")).toBeLessThan(failed.indexOf("upsertTask({ ...task, archived: task.archived })"));
    expect(failed).toContain("void refresh()");
    const settled = body.slice(body.indexOf("onSettled: () => {"));
    expect(settled).toContain("unmarkArchiving(task.id)");
    expect(settled).toContain("next.delete(task.id)");
  });
});
