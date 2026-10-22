/**
 * 会话重建提示（S2a-05）：懒重启 / resume 失败降级起新会话时，写一条用户可见的 info
 *
 * 缺口：chat-inject 懒重启只在「换提供方」「保命轮换」写 info，换模型 / MCP / 工作目录不写；
 * resume 失败降级只 console.warn；接续只灌最近 12 条正文（≤12000 字符、不含工具过程）。
 * 同提供方换模型后 AI「失忆」而用户不知。
 *
 * 口径：N = 实际灌进起手 prompt 的条数（与 runChatSession 同一个 selectChatHistoryTurns + 同样的扫描窗口）；
 * 没有历史（新对话首条）不写；不含内部工具名 / 协议词。
 *
 * 并行隔离：DATA_DIR 在 task-fs-core 加载时冻结，先钉 FLOWSHIP_DATA_DIR 再动态 import。
 */
import { mkdtempSync, promises as fs, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import type { TaskMetaV06 } from "@/lib/server/task-fs-core";
import type { TaskEvent } from "@/lib/types";
import {
  HISTORY_INJECT_MAX_TURNS,
  HISTORY_INJECT_SCAN_EVENTS,
} from "@/lib/chat-history-inject";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-session-rebuilt-"));
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");

const { readEvents, taskDir, writeMeta } = await import(
  "@/lib/server/task-fs-core"
);
const { appendEvent } = await import("@/lib/server/task-fs");
const { announceSessionRebuilt, buildSessionRebuiltText } = await import(
  "@/lib/server/session-rebuilt-notice"
);

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(`session-rebuilt DATA_DIR 未隔离到 TMP：${taskDir("probe")}`);
}

const read = (rel: string): string =>
  readFileSync(path.join(process.cwd(), rel), "utf-8");

const makeMeta = (id: string): TaskMetaV06 =>
  ({
    id,
    title: `session-rebuilt ${id}`,
    mode: "chat",
    repoStatus: "developing",
    runStatus: "idle",
    currentActionId: null,
    actions: [],
    mrs: [],
    repoPaths: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }) as unknown as TaskMetaV06;

let seq = 0;
const alloc = async (): Promise<string> => {
  const id = `t_rebuilt_${Date.now()}_${seq++}`;
  await writeMeta(makeMeta(id));
  return id;
};

/** 依次写 n 对 user_reply / assistant_message，返回最后一条 user_reply 的 id */
const seedHistory = async (id: string, pairs: number): Promise<void> => {
  for (let i = 0; i < pairs; i++) {
    await appendEvent(id, { kind: "user_reply", text: `问 ${i}` });
    await appendEvent(id, { kind: "assistant_message", text: `答 ${i}` });
  }
};

const rebuiltInfos = (events: TaskEvent[]): TaskEvent[] =>
  events.filter((e) => e.kind === "info" && e.text.startsWith("会话已重建"));

describe("buildSessionRebuiltText：文案", () => {
  it("没有历史 → null（新对话首条不是「重建」）", () => {
    expect(buildSessionRebuiltText(0, false)).toBeNull();
  });

  it("被截断 → 「最近 N 轮」+ 更早细节要回读事件日志；N 用实际条数", () => {
    const t = buildSessionRebuiltText(12, true)!;
    expect(t).toBe(
      "会话已重建：AI 保留了最近 12 轮对话文字，更早的细节与工具过程需要回读事件日志。",
    );
  });

  it("没被截断 → 「全部 N 轮」，不再谎称有被省略的更早对话", () => {
    const t = buildSessionRebuiltText(3, false)!;
    expect(t).toContain("全部 3 轮");
    expect(t).not.toContain("更早的细节");
    expect(t).toContain("工具过程需要回读事件日志");
  });

  it("文案不含内部工具名 / 协议词 / 方括号标记", () => {
    for (const t of [buildSessionRebuiltText(5, true)!, buildSessionRebuiltText(1, false)!]) {
      expect(t).not.toMatch(/\[[A-Z_]+/);
      expect(t).not.toMatch(/ask_user|submit_work|wait_|events\.jsonl|resume|session|SDK|MCP/i);
    }
  });
});

describe("announceSessionRebuilt：读事件尾、写一条 info", () => {
  afterAll(async () => {
    await fs.rm(TMP_ROOT, { recursive: true, force: true }).catch(() => {});
  });

  it("有历史：写一条 info，N = 排除「当前这条用户消息」后的条数", async () => {
    const id = await alloc();
    await seedHistory(id, 2); // 4 条历史
    const cur = await appendEvent(id, { kind: "user_reply", text: "这是本次新消息" });

    const wrote = await announceSessionRebuilt(id, { skipEventId: cur!.id });
    expect(wrote).toBe(true);

    const infos = rebuiltInfos(await readEvents(id));
    expect(infos).toHaveLength(1);
    expect(infos[0].text).toContain("全部 4 轮");
    // 与 runChatSession 同口径：当前这条不算进「保留的历史」
    expect(infos[0].text).not.toContain("5 轮");
  });

  it("历史超过上限 → 取 HISTORY_INJECT_MAX_TURNS 条并标 truncated", async () => {
    const id = await alloc();
    await seedHistory(id, 10); // 20 条
    const cur = await appendEvent(id, { kind: "user_reply", text: "新消息" });

    await announceSessionRebuilt(id, { skipEventId: cur!.id });

    const infos = rebuiltInfos(await readEvents(id));
    expect(infos).toHaveLength(1);
    expect(infos[0].text).toContain(`最近 ${HISTORY_INJECT_MAX_TURNS} 轮`);
    expect(infos[0].text).toContain("更早的细节");
  });

  it("没有任何历史（新对话首条、只有本次消息）→ 不写、返回 false", async () => {
    const id = await alloc();
    const cur = await appendEvent(id, { kind: "user_reply", text: "第一句" });

    const wrote = await announceSessionRebuilt(id, { skipEventId: cur!.id });
    expect(wrote).toBe(false);
    expect(rebuiltInfos(await readEvents(id))).toHaveLength(0);
  });

  it("没传 skipEventId 时按文本去掉末条同文用户消息（与 runChatSession 同口径）", async () => {
    const id = await alloc();
    await seedHistory(id, 1);
    await appendEvent(id, { kind: "user_reply", text: "同文消息" });

    await announceSessionRebuilt(id, { skipUserText: "同文消息" });

    const infos = rebuiltInfos(await readEvents(id));
    expect(infos).toHaveLength(1);
    expect(infos[0].text).toContain("全部 2 轮");
  });

  it("任务不存在 / 读盘失败 → 吞掉、返回 false，绝不抛（提示是 best-effort，不能拖垮发消息）", async () => {
    await expect(
      announceSessionRebuilt("t_not_exist_zzz", { skipEventId: "x" }),
    ).resolves.toBe(false);
  });

  it("工具过程事件（tool_call / thinking / info）不算「保留的对话文字」", async () => {
    const id = await alloc();
    await appendEvent(id, { kind: "user_reply", text: "问" });
    await appendEvent(id, { kind: "tool_call", text: "调用 shell" });
    await appendEvent(id, { kind: "thinking", text: "想" });
    await appendEvent(id, { kind: "info", text: "某条提示" });
    await appendEvent(id, { kind: "assistant_message", text: "答" });
    const cur = await appendEvent(id, { kind: "user_reply", text: "新" });

    await announceSessionRebuilt(id, { skipEventId: cur!.id });

    const infos = rebuiltInfos(await readEvents(id));
    expect(infos[0].text).toContain("全部 2 轮");
  });
});

describe("口径同源契约：与 chat-runner 的接续切片用同一个选择函数和扫描窗口", () => {
  it("notice 模块用 selectChatHistoryTurns + HISTORY_INJECT_SCAN_EVENTS（改一处要改两处）", () => {
    const notice = read("src/lib/server/session-rebuilt-notice.ts");
    const runner = read("src/lib/server/chat-runner.ts");
    for (const src of [notice, runner]) {
      expect(src).toMatch(/selectChatHistoryTurns/);
      expect(src).toMatch(/HISTORY_INJECT_SCAN_EVENTS/);
      expect(src).toMatch(/hasMore/);
    }
    expect(HISTORY_INJECT_SCAN_EVENTS).toBeGreaterThan(HISTORY_INJECT_MAX_TURNS);
  });
});
