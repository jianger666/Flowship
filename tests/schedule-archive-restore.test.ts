/**
 * 归档取消定时 → 取消归档时还原（第三轮 review D2b-03）。
 *
 * 取消是有意设计（归档后的会话不该被定时消息悄悄唤醒），但此前：toast 一字不提，「撤销」只翻归档标记，
 * 剩余定时全没了，唯一线索是事件流里一条 info。现在：
 *  - 归档取消的记录带 `archiveCancelled`（取消前的状态 + 下次触发时刻）；用户 / AI 自己取消的没有，不还原；
 *  - 取消归档时按「恢复」口径还原：周期定时从现在起重新计一个完整间隔、一次性定时没过点就照旧、过点了记成「已错过」；
 *  - 归档 / 取消归档的 PATCH 响应带 `report`（取消 / 恢复了几条），前端 toast 据此告知。
 */
import { mkdtempSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-schedule-archive-"));
process.env.FLOWSHIP_DATA_DIR = TMP_ROOT;

const store = await import("../src/lib/server/schedule-store");
const { taskDir } = await import("../src/lib/server/task-fs-core");
const { markCancelled, markRestoredAfterArchive, buildScheduleRecord } = await import(
  "../src/lib/schedule"
);

const MIN = 60_000;
const NOW = Date.UTC(2026, 9, 18, 2, 0, 0);

let seq = 0;
const freshTask = async (): Promise<string> => {
  seq += 1;
  const id = `t_arch_${seq}`;
  await fs.mkdir(taskDir(id), { recursive: true });
  return id;
};

const every = (title = "盯部署", over: Record<string, unknown> = {}) => ({
  kind: "every" as const,
  title,
  message: "看进度",
  firstFireAt: NOW + 10 * MIN,
  intervalMs: 10 * MIN,
  ...over,
});
const once = (title = "看 CI", at = NOW + 30 * MIN) => ({
  kind: "once" as const,
  title,
  message: "去看结果",
  firstFireAt: at,
});

const mustCreate = async (taskId: string, input: Parameters<typeof store.createSchedule>[1]) => {
  const r = await store.createSchedule(taskId, input, NOW);
  if (!r.ok) throw new Error(r.error);
  return r.record;
};

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("markRestoredAfterArchive（纯函数）", () => {
  const cancelledByArchive = (input: Parameters<typeof buildScheduleRecord>[1], status: "active" | "paused" = "active") => {
    const rec = buildScheduleRecord("t_x", input, NOW);
    const before = status === "paused" ? { ...rec, status: "paused" as const } : rec;
    return {
      ...markCancelled(before, NOW + MIN, "会话已归档"),
      archiveCancelled: { prevStatus: status, nextFireAt: before.nextFireAt },
    };
  };

  it("周期定时：还原为 active，从「现在」起重新计一个完整间隔，不补归档期间的；清掉取消痕迹", () => {
    const cancelled = cancelledByArchive(every());
    const later = NOW + 5 * 60 * MIN;
    const r = markRestoredAfterArchive(cancelled, later);
    expect(r.status).toBe("active");
    expect(r.nextFireAt).toBe(later + 10 * MIN);
    expect(r.endedAt).toBeUndefined();
    expect(r.endNote).toBeUndefined();
    expect(r.archiveCancelled).toBeUndefined();
  });

  it("周期定时已认领满 maxRuns：不能多触发 → 直接 done", () => {
    const rec = { ...buildScheduleRecord("t_x", every("满额", { maxRuns: 2 }), NOW), seq: 2 };
    const cancelled = {
      ...markCancelled(rec, NOW + MIN, "会话已归档"),
      archiveCancelled: { prevStatus: "active" as const, nextFireAt: rec.nextFireAt },
    };
    const r = markRestoredAfterArchive(cancelled, NOW + 2 * MIN);
    expect(r.status).toBe("done");
  });

  it("一次性定时：没过点 → 原时刻照旧；已过点 → 记成「已错过」（保留记录、不补发）", () => {
    const cancelled = cancelledByArchive(once("看 CI", NOW + 30 * MIN));
    const stillFuture = markRestoredAfterArchive(cancelled, NOW + 10 * MIN);
    expect(stillFuture.status).toBe("active");
    expect(stillFuture.nextFireAt).toBe(NOW + 30 * MIN);

    const pastDue = markRestoredAfterArchive(cancelled, NOW + 60 * MIN);
    expect(pastDue.status).toBe("missed");
    expect(pastDue.missedCount).toBe(1);
    expect(pastDue.endNote).toContain("归档");
  });

  it("归档前就是暂停的：还原回暂停（不替用户擅自开跑）", () => {
    const cancelled = cancelledByArchive(every(), "paused");
    const r = markRestoredAfterArchive(cancelled, NOW + 60 * MIN);
    expect(r.status).toBe("paused");
    expect(r.nextFireAt).toBe(cancelled.archiveCancelled!.nextFireAt);
  });

  it("不是归档取消的（没有标记）/ 不是 cancelled：原样返回，绝不乱还原", () => {
    const rec = buildScheduleRecord("t_x", every(), NOW);
    const userCancelled = markCancelled(rec, NOW + MIN, "用户取消");
    expect(markRestoredAfterArchive(userCancelled, NOW + 2 * MIN)).toBe(userCancelled);
    expect(markRestoredAfterArchive(rec, NOW + 2 * MIN)).toBe(rec);
  });
});

describe("schedule-store：归档取消 / 取消归档还原", () => {
  it("restorable 取消 + 还原：只还原归档取消的，用户先前自己取消的保持取消", async () => {
    const taskId = await freshTask();
    const a = await mustCreate(taskId, every("周期A"));
    const b = await mustCreate(taskId, once("一次B"));
    const mine = await mustCreate(taskId, once("用户自己取消的", NOW + 90 * MIN));
    await store.cancelSchedule(taskId, mine.id, "用户取消", NOW + MIN);

    const n = await store.cancelAllSchedulesForTask(taskId, "会话已归档", NOW + 2 * MIN, {
      restorable: true,
    });
    expect(n).toBe(2);
    let list = await store.readSchedules(taskId);
    expect(list.every((r) => r.status === "cancelled")).toBe(true);
    expect(store.scheduleLiveTaskIds()).not.toContain(taskId);

    const restored = await store.restoreArchiveCancelledSchedules(taskId, NOW + 3 * MIN);
    expect(restored).toBe(2);
    list = await store.readSchedules(taskId);
    const byId = new Map(list.map((r) => [r.id, r]));
    expect(byId.get(a.id)!.status).toBe("active");
    expect(byId.get(a.id)!.nextFireAt).toBe(NOW + 3 * MIN + 10 * MIN);
    expect(byId.get(b.id)!.status).toBe("active");
    expect(byId.get(mine.id)!.status).toBe("cancelled");
    expect(byId.get(mine.id)!.archiveCancelled).toBeUndefined();
    // 调度索引同步刷新（否则还原了也没人 tick）
    expect(store.scheduleLiveTaskIds()).toContain(taskId);
    // 幂等：再来一次没有可还原的
    expect(await store.restoreArchiveCancelledSchedules(taskId, NOW + 4 * MIN)).toBe(0);
  });

  it("Q9-06：Detailed 把「过点→已错过」「用满→已结束」单独计数（旧口径只数回到进行中的）", async () => {
    const taskId = await freshTask();
    const live = await mustCreate(taskId, every("周期A"));
    const gone = await mustCreate(taskId, once("一次B", NOW + 30 * MIN));
    await store.cancelAllSchedulesForTask(taskId, "会话已归档", NOW + MIN, { restorable: true });
    // 取消归档时 B 已过点（NOW + 30min 之后才回来）
    const outcome = await store.restoreArchiveCancelledSchedulesDetailed(taskId, NOW + 60 * MIN);
    expect(outcome).toEqual({ restored: 1, missed: 1, ended: 0 });
    const byId = new Map((await store.readSchedules(taskId)).map((r) => [r.id, r]));
    expect(byId.get(live.id)!.status).toBe("active");
    expect(byId.get(gone.id)!.status).toBe("missed");
    // 幂等：再来一次什么都没有
    expect(await store.restoreArchiveCancelledSchedulesDetailed(taskId, NOW + 61 * MIN)).toEqual({
      restored: 0,
      missed: 0,
      ended: 0,
    });
  });

  it("Q9-06：旧口径函数仍只返回「回到进行中」的条数（过点的不计入）", async () => {
    const taskId = await freshTask();
    await mustCreate(taskId, once("只有一次", NOW + 30 * MIN));
    await store.cancelAllSchedulesForTask(taskId, "会话已归档", NOW + MIN, { restorable: true });
    expect(await store.restoreArchiveCancelledSchedules(taskId, NOW + 60 * MIN)).toBe(0);
  });

  it("默认（非 restorable）取消不带标记——任务终结时的取消不会被「取消归档」还原", async () => {
    const taskId = await freshTask();
    await mustCreate(taskId, every());
    expect(await store.cancelAllSchedulesForTask(taskId, "任务已终结", NOW + MIN)).toBe(1);
    expect((await store.readSchedules(taskId))[0].archiveCancelled).toBeUndefined();
    expect(await store.restoreArchiveCancelledSchedules(taskId, NOW + 2 * MIN)).toBe(0);
  });

  it("任务不存在 / 没有定时：返回 0、不抛", async () => {
    expect(await store.restoreArchiveCancelledSchedules("t_arch_missing", NOW)).toBe(0);
    const taskId = await freshTask();
    expect(await store.restoreArchiveCancelledSchedules(taskId, NOW)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Q9-02：归档 → 终结 → 取消归档，不得复活已终结任务的定时
// ---------------------------------------------------------------------------
describe("Q9-02：archive → finalize → unarchive", () => {
  it("归档后任务被终结：取消归档不会把定时复活（旧：返回 1、状态 active）", async () => {
    const taskId = await freshTask();
    await mustCreate(taskId, every());
    // 1) 归档：取消 + 打还原标记
    expect(await store.cancelAllSchedulesForTask(taskId, "会话已归档", NOW, { restorable: true })).toBe(1);
    // 2) 归档期间任务被终结（合入 / 放弃）：非 restorable 的取消
    expect(await store.cancelAllSchedulesForTask(taskId, "任务已结束", NOW + MIN)).toBe(0);
    // 3) 取消归档：不应还原任何定时
    expect(await store.restoreArchiveCancelledSchedules(taskId, NOW + 2 * MIN)).toBe(0);
    const list = await store.readSchedules(taskId);
    expect(list).toHaveLength(1);
    expect(list[0]!.status).toBe("cancelled");
    expect(list[0]!.archiveCancelled).toBeUndefined();
  });

  it("反例（旧树能用的情形仍能用）：只归档不终结 → 取消归档照常还原", async () => {
    const taskId = await freshTask();
    await mustCreate(taskId, every());
    await store.cancelAllSchedulesForTask(taskId, "会话已归档", NOW, { restorable: true });
    expect(await store.restoreArchiveCancelledSchedules(taskId, NOW + 2 * MIN)).toBe(1);
    const list = await store.readSchedules(taskId);
    expect(list[0]!.status).toBe("active");
  });

  it("归档时已有的用户取消 / 终结时再次归档：标记只留在「因归档取消」的记录上，其余不动", async () => {
    const taskId = await freshTask();
    const a = await mustCreate(taskId, every("a"));
    await mustCreate(taskId, once("b"));
    await store.cancelSchedule(taskId, a.id, "用户取消", NOW);
    await store.cancelAllSchedulesForTask(taskId, "会话已归档", NOW, { restorable: true });
    // 终结：b 带标记被去标记；a（用户取消、无标记）原样
    await store.cancelAllSchedulesForTask(taskId, "任务已结束", NOW + MIN);
    const list = await store.readSchedules(taskId);
    expect(list.every((r) => r.status === "cancelled" && !r.archiveCancelled)).toBe(true);
    expect(await store.restoreArchiveCancelledSchedules(taskId, NOW + 2 * MIN)).toBe(0);
  });

  it("终结本身仍会取消还活着的定时并返回条数（行为不变）", async () => {
    const taskId = await freshTask();
    await mustCreate(taskId, every("x"));
    await mustCreate(taskId, once("y"));
    expect(await store.cancelAllSchedulesForTask(taskId, "任务已结束", NOW)).toBe(2);
    // 再终结一次：没有存活的 → 0，且幂等
    expect(await store.cancelAllSchedulesForTask(taskId, "任务已结束", NOW + MIN)).toBe(0);
  });
});
