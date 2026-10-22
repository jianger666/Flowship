/**
 * V12-02：作废提问的事件文案
 *
 * 旧句式 `上一组提问因${reason}失效、无需再回答。` 拼出
 *   「因会话已失效失效」「因推进新 action失效」「因输入条唤醒当前 action失效」——
 * 原因本身带「失效」就叠字、带英文 action 就漏空格还夹英文。
 * 新句式：「上一组提问已失效（{原因}），无需再回答」，原因只写名词短语。
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const TMP = mkdtempSync(path.join(os.tmpdir(), "ask-supersede-text-"));
process.env.FLOWSHIP_DATA_DIR = path.join(TMP, "data");

const { formatSupersededAskText, supersedePendingAsks } = await import(
  "@/lib/server/ask-supersede"
);
const { createTask, getTask } = await import("@/lib/server/task-fs");
const { writeEventAndPublish } = await import("@/lib/server/task-stream");

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe("formatSupersededAskText", () => {
  it("句式：上一组提问已失效（原因），无需再回答", () => {
    expect(formatSupersededAskText("用户停止")).toBe(
      "上一组提问已失效（用户停止），无需再回答。",
    );
    expect(formatSupersededAskText("被新提问顶替")).toBe(
      "上一组提问已失效（被新提问顶替），无需再回答。",
    );
  });

  it("不再出现旧的叠字 / 漏空格拼法", () => {
    for (const reason of ["会话已失效", "推进新阶段", "输入条唤醒当前阶段"]) {
      const t = formatSupersededAskText(reason);
      expect(t).not.toMatch(/因.*失效失效/);
      expect(t).not.toMatch(/因[^，。（）]*失效、/);
      expect(t).toContain(`（${reason}）`);
    }
  });
});

describe("真实 supersedePendingAsks 写出的事件", () => {
  it("事件正文走新句式、meta 仍带 supersededAskId（飞书卡置态靠它）", async () => {
    const task = await createTask({ title: "作废文案", mode: "chat" } as never);
    await writeEventAndPublish(task.id, {
      kind: "ask_user_request",
      text: "需要你确认",
      meta: { askId: "ask-text-1", token: "tok", questions: [] },
    });

    await supersedePendingAsks(task.id, "推进新阶段");

    const fresh = await getTask(task.id);
    const marker = fresh!.events.find(
      (e) => e.kind === "info" && e.meta?.supersededAskId === "ask-text-1",
    );
    expect(marker?.text).toBe("上一组提问已失效（推进新阶段），无需再回答。");
  });
});

describe("调用方的原因是名词短语（无英文 action）", () => {
  it("task-runner 的两处作废原因改成中文「阶段」", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(
      path.resolve(import.meta.dirname, "..", "src", "lib", "server", "task-runner.ts"),
      "utf-8",
    );
    expect(src).toContain('supersedePendingAsks(task.id, "推进新阶段")');
    expect(src).toContain('supersedePendingAsks(fresh.id, "输入条唤醒当前阶段")');
    expect(src).not.toContain('"推进新 action"');
    expect(src).not.toContain('"输入条唤醒当前 action"');
  });
});
