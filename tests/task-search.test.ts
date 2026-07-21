/**
 * 任务全文检索（task-search）单测
 *
 * 用 tmp 目录造 2~3 个任务（标题命中 / 内容命中 / 无命中），
 * 断言排序、摘要截取、大小写不敏感、空 q。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  buildSnippet,
  includesIgnoreCase,
  searchTasks,
  type TaskSearchDeps,
} from "@/lib/server/task-search";

const TMP = path.join(os.tmpdir(), `fe-task-search-${Date.now()}`);

/** 写一条极简 events.jsonl 行 */
const eventLine = (kind: string, text: string): string =>
  JSON.stringify({
    id: `e_${Math.random().toString(36).slice(2, 8)}`,
    ts: Date.now(),
    kind,
    text,
  });

beforeAll(async () => {
  await fs.mkdir(TMP, { recursive: true });

  // t1：标题含「登录」、mtime 较旧
  await fs.mkdir(path.join(TMP, "t1"), { recursive: true });
  await fs.writeFile(
    path.join(TMP, "t1", "events.jsonl"),
    `${eventLine("user_reply", "随便聊聊天气")}\n`,
    "utf-8",
  );

  // t2：正文含「登录 bug」、标题无关；mtime 最新
  await fs.mkdir(path.join(TMP, "t2"), { recursive: true });
  await fs.writeFile(
    path.join(TMP, "t2", "events.jsonl"),
    [
      eventLine("info", "系统事件不参与检索"),
      eventLine(
        "assistant_message",
        `${"前缀填充字".repeat(20)}这里出现登录 bug 的复现步骤${"后缀填充字".repeat(20)}`,
      ),
      // 第二条也命中——应停在首个命中，摘要来自上面那条
      eventLine("user_reply", "还有另一处登录问题"),
    ].join("\n") + "\n",
    "utf-8",
  );

  // t3：标题与正文都不含关键词
  await fs.mkdir(path.join(TMP, "t3"), { recursive: true });
  await fs.writeFile(
    path.join(TMP, "t3", "events.jsonl"),
    `${eventLine("user_reply", "完全无关的内容")}\n`,
    "utf-8",
  );
});

afterAll(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
});

const deps: TaskSearchDeps = {
  listSummaries: async () => [
    { id: "t1", title: "修复登录页样式", mode: "chat", updatedAt: 100 },
    { id: "t2", title: "排查接口超时", mode: "task", updatedAt: 300 },
    { id: "t3", title: "周会纪要", mode: "chat", updatedAt: 200 },
  ],
  getEventsPath: (id) => path.join(TMP, id, "events.jsonl"),
};

describe("includesIgnoreCase / buildSnippet", () => {
  it("大小写不敏感匹配", () => {
    expect(includesIgnoreCase("Hello LOGIN world", "login")).toBe(true);
    expect(includesIgnoreCase("abc", "xyz")).toBe(false);
    expect(includesIgnoreCase("abc", "")).toBe(false);
  });

  it("摘要截取命中词前后约 40 字并加省略号", () => {
    const text = `${"甲".repeat(50)}命中词${"乙".repeat(50)}`;
    const snip = buildSnippet(text, "命中词", 40);
    expect(snip.startsWith("…")).toBe(true);
    expect(snip.endsWith("…")).toBe(true);
    expect(snip).toContain("命中词");
    // 半径 40 + 词长 3 → 中间段长度约 83
    expect(snip.length).toBeLessThan(text.length);
  });
});

describe("searchTasks", () => {
  it("空 q / 全空白返回空数组", async () => {
    expect(await searchTasks("", deps)).toEqual([]);
    expect(await searchTasks("   ", deps)).toEqual([]);
  });

  it("标题命中优先于内容命中，同组按 mtime 倒序；无命中不出现", async () => {
    const results = await searchTasks("登录", deps);
    expect(results.map((r) => r.taskId)).toEqual(["t1", "t2"]);
    expect(results[0].matchedIn).toBe("title");
    expect(results[0].snippet).toBeUndefined();
    expect(results[1].matchedIn).toBe("content");
    expect(results[1].snippet).toBeTruthy();
    expect(results[1].snippet).toContain("登录");
    // t3 无命中
    expect(results.find((r) => r.taskId === "t3")).toBeUndefined();
  });

  it("大小写不敏感：用 BUG 命中正文 bug", async () => {
    const results = await searchTasks("BUG", deps);
    expect(results.map((r) => r.taskId)).toEqual(["t2"]);
    expect(results[0].matchedIn).toBe("content");
  });

  it("内容命中摘要来自首个匹配事件，且带上下文截断", async () => {
    const results = await searchTasks("登录", deps);
    const content = results.find((r) => r.taskId === "t2");
    expect(content?.snippet).toBeTruthy();
    // 不应吞进第二条 user_reply「另一处登录问题」全文（首命中即停）
    expect(content?.snippet).not.toContain("另一处登录问题");
    expect(content?.snippet).toContain("登录 bug");
  });
});
