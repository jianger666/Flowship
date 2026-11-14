/**
 * turn 用量落盘链：recordTurnUsage 写 meta.tokenUsage + 归属到 running action。
 * 锁住：多轮累加、只记 running action、任务不存在不抛、不顶掉 updatedAt。
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import type { ActionStatus } from "@/lib/types";
import type { TaskMetaV06 } from "@/lib/server/task-fs-core";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-turn-usage-"));
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");

const { readMetaV06, writeMeta } = await import("@/lib/server/task-fs-core");
const { recordTurnUsage } = await import("@/lib/server/task-fs");

const BASE_TS = 1_700_000_000_000;

const makeMeta = (
  id: string,
  actionStatus: ActionStatus = "running",
): TaskMetaV06 =>
  ({
    id,
    title: `turn-usage ${id}`,
    mode: "task",
    repoStatus: "developing",
    runStatus: "running",
    currentActionId: "act_1",
    actions: [
      {
        id: "act_1",
        n: 1,
        type: "build",
        status: actionStatus,
        userInstruction: "",
        artifactPath: "actions/1-build.md",
        startedAt: BASE_TS,
        endedAt: null,
      },
    ],
    mrs: [],
    repoPaths: [],
    createdAt: BASE_TS,
    updatedAt: BASE_TS,
  }) as unknown as TaskMetaV06;

let seq = 0;
const alloc = (): string => `tu_${Date.now()}_${seq++}`;

const usage = (input: number, output: number) => ({
  inputTokens: input,
  outputTokens: output,
  cacheReadTokens: Math.floor(input * 0.8),
  cacheWriteTokens: 0,
  reasoningTokens: 5,
});

afterAll(() => {
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

describe("recordTurnUsage", () => {
  it("首轮落 task 级 tokenUsage、同时记到 running action 上", async () => {
    const id = alloc();
    await writeMeta(makeMeta(id));

    const task = await recordTurnUsage(id, usage(1000, 100));
    expect(task).not.toBeNull();
    // 返回的快照 events 恒空——调用方只拿它 publish 一帧 task
    expect(task?.events).toEqual([]);
    expect(task?.tokenUsage?.turns).toBe(1);

    const meta = await readMetaV06(id);
    expect(meta?.tokenUsage?.last.inputTokens).toBe(1000);
    expect(meta?.tokenUsage?.total.inputTokens).toBe(1000);
    expect(meta?.tokenUsage?.total.reasoningTokens).toBe(5);
    expect(meta?.actions[0]?.tokenUsage?.total.inputTokens).toBe(1000);
    expect(meta?.actions[0]?.tokenUsage?.turns).toBe(1);
  });

  it("多轮累加：last 覆盖、total 累计、turns 递增", async () => {
    const id = alloc();
    await writeMeta(makeMeta(id));

    await recordTurnUsage(id, usage(1000, 100));
    await recordTurnUsage(id, usage(300, 30));

    const meta = await readMetaV06(id);
    expect(meta?.tokenUsage?.last.inputTokens).toBe(300);
    expect(meta?.tokenUsage?.total.inputTokens).toBe(1300);
    expect(meta?.tokenUsage?.total.outputTokens).toBe(130);
    expect(meta?.tokenUsage?.turns).toBe(2);
    expect(meta?.actions[0]?.tokenUsage?.total.inputTokens).toBe(1300);
  });

  it("action 不在 running（迟到的 turn-ended）→ 只记 task 级、不污染已完成 action", async () => {
    const id = alloc();
    await writeMeta(makeMeta(id, "completed"));

    await recordTurnUsage(id, usage(500, 50));

    const meta = await readMetaV06(id);
    expect(meta?.tokenUsage?.total.inputTokens).toBe(500);
    expect(meta?.actions[0]?.tokenUsage).toBeUndefined();
  });

  // turn-ended 在 run 收尾后才到：此时 action 多半已是 awaiting_ack / error。
  // 只认 running 会让绝大多数 action 记不上（实测 11 月 79 个只有 3 个有用量）。
  it("交卷后才到的 turn-ended（awaiting_ack + 主线 runKind）→ 记到该 action", async () => {
    const id = alloc();
    await writeMeta(makeMeta(id, "awaiting_ack"));

    await recordTurnUsage(id, usage(900, 90), { runKind: "task-first" });

    const meta = await readMetaV06(id);
    expect(meta?.tokenUsage?.total.inputTokens).toBe(900);
    expect(meta?.actions[0]?.tokenUsage?.total.inputTokens).toBe(900);
    expect(meta?.actions[0]?.tokenUsage?.turns).toBe(1);
  });

  it("没交卷就失败（error + 主线 runKind）→ 失败的 run 烧的 token 也记到该 action", async () => {
    const id = alloc();
    await writeMeta(makeMeta(id, "error"));

    await recordTurnUsage(id, usage(400, 40), { runKind: "task-followup" });

    const meta = await readMetaV06(id);
    expect(meta?.actions[0]?.tokenUsage?.total.inputTokens).toBe(400);
  });

  it("旁路问答（question）在 awaiting_ack 时跑 → 只记 task 级、不算这个 action 的活", async () => {
    const id = alloc();
    await writeMeta(makeMeta(id, "awaiting_ack"));

    await recordTurnUsage(id, usage(600, 60), { runKind: "question" });

    const meta = await readMetaV06(id);
    expect(meta?.tokenUsage?.total.inputTokens).toBe(600);
    expect(meta?.actions[0]?.tokenUsage).toBeUndefined();
  });

  it("没传 runKind 的非 running action → 保守不记（兼容旧调用方）", async () => {
    const id = alloc();
    await writeMeta(makeMeta(id, "awaiting_ack"));

    await recordTurnUsage(id, usage(300, 30));

    const meta = await readMetaV06(id);
    expect(meta?.tokenUsage?.total.inputTokens).toBe(300);
    expect(meta?.actions[0]?.tokenUsage).toBeUndefined();
  });

  it("已 completed 的 action 即使带主线 runKind 也不记（迟到的 turn-ended 不污染已收口的 action）", async () => {
    const id = alloc();
    await writeMeta(makeMeta(id, "completed"));

    await recordTurnUsage(id, usage(500, 50), { runKind: "task-first" });

    const meta = await readMetaV06(id);
    expect(meta?.tokenUsage?.total.inputTokens).toBe(500);
    expect(meta?.actions[0]?.tokenUsage).toBeUndefined();
  });

  it("currentActionId 为空（chat 模式 / idle）→ 只记 task 级", async () => {
    const id = alloc();
    await writeMeta({
      ...makeMeta(id),
      mode: "chat",
      currentActionId: null,
      actions: [],
    });

    await recordTurnUsage(id, usage(700, 70));

    const meta = await readMetaV06(id);
    expect(meta?.tokenUsage?.total.inputTokens).toBe(700);
    expect(meta?.actions).toEqual([]);
  });

  it("不顶掉 updatedAt（用量是旁路遥测、不该改侧栏排序 / 已读判定）", async () => {
    const id = alloc();
    await writeMeta(makeMeta(id));

    await recordTurnUsage(id, usage(100, 10));

    const meta = await readMetaV06(id);
    expect(meta?.updatedAt).toBe(BASE_TS);
    // 落账时间单独记在 tokenUsage.updatedAt 上
    expect(meta?.tokenUsage?.updatedAt).toBeGreaterThan(BASE_TS);
  });

  it("任务不存在 → 返 null、不抛（埋点绝不能拖垮主流程）", async () => {
    await expect(
      recordTurnUsage("tu_does_not_exist", usage(1, 1)),
    ).resolves.toBeNull();
  });

  it("水位只累加未命中缓存的增量（高命中轮不推高水位）", async () => {
    const id = alloc();
    await writeMeta(makeMeta(id));

    // 单轮 460 万、94% 命中：水位只涨约 27 万，而不是 460 万
    await recordTurnUsage(id, {
      inputTokens: 4613622,
      outputTokens: 22004,
      cacheReadTokens: 4342215,
      cacheWriteTokens: 0,
      reasoningTokens: 10698,
    });
    const meta = await readMetaV06(id);
    expect(meta?.sessionInputTokens).toBe(4613622 - 4342215);
    // 计费口径照全量
    expect(meta?.tokenUsage?.total.inputTokens).toBe(4613622);
  });
});
