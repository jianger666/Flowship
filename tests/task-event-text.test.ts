/**
 * V12-03 / V12-04：任务事件流里两条系统事件的文案 / 形态
 *
 * V12-04：任务标记合入 / 放弃后写的 info 原先是「Task 已标合入 main、收尾结束」「Task 已被 abandon」——
 *   硬编码 main（目标分支常是 master / release）、夹英文 abandon、用「Task」。
 * V12-03：MR「有冲突」是**成功**的事（MR 已经建好 / 推上去了、只是要人手动解冲突），
 *   却以 `kind:"error"` 写入 → 红色错误卡 + 一个会重放旧 user_reply 的「重试」。改成 info + meta.notice
 *   （行动指引形态：默认展开、保留换行）。
 *
 * 判定都放在纯函数里（task-runner 只负责写），可单测。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildMrNoticeEvent,
  formatFinalizeNotice,
} from "../src/lib/task-event-text";

describe("formatFinalizeNotice（V12-04）", () => {
  it("合入：不硬编码分支名、不夹英文、不叫 Task", () => {
    const t = formatFinalizeNotice("merged");
    expect(t).toBe("任务已标记为已合入");
    expect(t).not.toMatch(/main|master|Task|abandon/);
  });

  it("放弃：中文、不叫 Task", () => {
    const t = formatFinalizeNotice("abandoned");
    expect(t).toBe("任务已放弃");
    expect(t).not.toMatch(/Task|abandon/);
  });

  it("带原因时括起来；空白原因当没有", () => {
    expect(formatFinalizeNotice("merged", "MR 已合")).toBe(
      "任务已标记为已合入（MR 已合）",
    );
    expect(formatFinalizeNotice("abandoned", "不做了")).toBe(
      "任务已放弃（不做了）",
    );
    expect(formatFinalizeNotice("abandoned", "")).toBe("任务已放弃");
    expect(formatFinalizeNotice("abandoned", undefined)).toBe("任务已放弃");
  });
});

describe("buildMrNoticeEvent（V12-03）", () => {
  const base = {
    actionId: "act_1",
    mrVerb: "创建",
    targetBranch: "test",
    url: "https://gitlab.example.com/a/b/-/merge_requests/7",
    meta: { repoPath: "/repo", mrIid: 7 },
  };

  it("有冲突：info（不再是 error）+ meta.notice，文案带目标分支与链接，业务 meta 原样保留", () => {
    const e = buildMrNoticeEvent({ ...base, hasConflicts: true });
    expect(e.kind).toBe("info");
    expect(e.actionId).toBe("act_1");
    expect(e.text).toBe(
      "MR 已创建、但跟 test 有冲突、需用户手动解决后才能合：https://gitlab.example.com/a/b/-/merge_requests/7",
    );
    expect(e.meta).toMatchObject({ notice: true, repoPath: "/repo", mrIid: 7 });
  });

  it("无冲突：info、没有 notice（普通细线即可），文案不变", () => {
    const e = buildMrNoticeEvent({ ...base, mrVerb: "推送（v2）", hasConflicts: false });
    expect(e.kind).toBe("info");
    expect(e.text).toBe(
      "MR 已推送（v2）：https://gitlab.example.com/a/b/-/merge_requests/7",
    );
    expect(e.meta.notice).toBeUndefined();
    expect(e.meta).toMatchObject({ repoPath: "/repo", mrIid: 7 });
  });

  it("传入的 meta 对象不被改写", () => {
    const meta = { repoPath: "/repo" };
    buildMrNoticeEvent({ ...base, meta, hasConflicts: true });
    expect(meta).toEqual({ repoPath: "/repo" });
  });
});

describe("task-runner 接线（源码契约）", () => {
  const src = readFileSync(
    path.resolve(import.meta.dirname, "..", "src", "lib", "server", "task-runner.ts"),
    "utf-8",
  );

  it("收尾 info 走 formatFinalizeNotice，旧硬编码文案不再出现", () => {
    expect(src).toContain("formatFinalizeNotice(finalStatus, reason)");
    expect(src).not.toContain("Task 已标合入");
    expect(src).not.toContain("Task 已被 abandon");
  });

  it("MR 事件走 buildMrNoticeEvent，不再有「有冲突 → kind:error」的分支", () => {
    expect(src).toContain("buildMrNoticeEvent({");
    expect(src).not.toContain("需用户手动解决后才能合");
  });
});
