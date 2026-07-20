/**
 * 正文搜索：events.jsonl grep 单测（写临时文件、不碰真实 dataRoot）
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { searchTaskEventsFile } from "@/lib/server/task-content-search";

const tmpDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tmpDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })),
  );
});

const writeEvents = async (lines: object[]): Promise<string> => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flowship-search-"));
  tmpDirs.push(dir);
  const file = path.join(dir, "events.jsonl");
  await fs.writeFile(
    file,
    lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
    "utf-8",
  );
  return file;
};

describe("searchTaskEventsFile", () => {
  it("命中 user_reply / assistant_message，忽略其它 kind", async () => {
    const file = await writeEvents([
      { id: "1", ts: 1, kind: "thinking", text: "秘密关键词不该命中" },
      { id: "2", ts: 2, kind: "user_reply", text: "请帮我修登录关键词问题" },
      { id: "3", ts: 3, kind: "assistant_message", text: "好的我来看" },
    ]);
    const hit = await searchTaskEventsFile(file, "关键词");
    expect(hit).toBeTruthy();
    expect(hit!).toContain("关键词");
  });

  it("少于 2 字 / 无命中返 null", async () => {
    const file = await writeEvents([
      { id: "1", ts: 1, kind: "user_reply", text: "hello world" },
    ]);
    expect(await searchTaskEventsFile(file, "h")).toBeNull();
    expect(await searchTaskEventsFile(file, "zzz")).toBeNull();
  });

  it("优先返回较新命中（文件尾侧）", async () => {
    const file = await writeEvents([
      { id: "1", ts: 1, kind: "user_reply", text: "旧的 alpha 消息" },
      { id: "2", ts: 2, kind: "assistant_message", text: "新的 alpha 回复内容更长一些" },
    ]);
    const hit = await searchTaskEventsFile(file, "alpha");
    expect(hit).toContain("新的");
  });
});
