/**
 * 定时任务落盘层（`schedule-store`）：读写 / 并发 / 任务被删后不复活 / 索引 / 坏文件。
 *
 * DATA_DIR 须在动态 import 前钉死（与 subagent-transcript.test 同构）。
 */
import { mkdtempSync, promises as fs, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-schedule-store-"));
process.env.FLOWSHIP_DATA_DIR = TMP_ROOT;

const store = await import("../src/lib/server/schedule-store");
const { taskDir, DELETED_TOMBSTONE_FILE, withTaskLock } = await import("../src/lib/server/task-fs-core");
const {
  SCHEDULE_FILE,
  SCHEDULE_KEEP_FINISHED,
  SCHEDULE_MAX_ACTIVE_PER_TASK,
  claimFire,
  markCancelled,
} = await import("../src/lib/schedule");

const MIN = 60_000;
const NOW = Date.UTC(2026, 9, 18, 2, 0, 0);

let seq = 0;
const freshTask = async (): Promise<string> => {
  seq += 1;
  const id = `t_sch_${seq}`;
  await fs.mkdir(taskDir(id), { recursive: true });
  return id;
};

const onceInput = (over: Partial<Parameters<typeof store.createSchedule>[1]> = {}) =>
  ({
    kind: "once" as const,
    title: "看 CI",
    message: "去看 CI 结果",
    firstFireAt: NOW + 20 * MIN,
    ...over,
  }) satisfies Parameters<typeof store.createSchedule>[1];

const everyInput = () =>
  ({
    kind: "every" as const,
    title: "盯部署",
    message: "看部署进度",
    firstFireAt: NOW + 10 * MIN,
    intervalMs: 10 * MIN,
  }) satisfies Parameters<typeof store.createSchedule>[1];

const mustCreate = async (taskId: string, input = onceInput()) => {
  const r = await store.createSchedule(taskId, input, NOW);
  if (!r.ok) throw new Error(r.error);
  return r.record;
};

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("创建 / 读取", () => {
  it("创建后落盘到 tasks/<id>/schedules.json（0600），读回一致", async () => {
    const taskId = await freshTask();
    const rec = await mustCreate(taskId);
    const file = path.join(taskDir(taskId), SCHEDULE_FILE);
    expect((statSync(file).mode & 0o777).toString(8)).toBe("600");
    const list = await store.readSchedules(taskId);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: rec.id, title: "看 CI", status: "active", taskId });
  });

  it("没有文件 → 空数组（不抛）", async () => {
    const taskId = await freshTask();
    expect(await store.readSchedules(taskId)).toEqual([]);
  });

  it("并发创建不丢更新（锁内读改写）", async () => {
    const taskId = await freshTask();
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        store.createSchedule(taskId, onceInput({ title: `t${i}` }), NOW),
      ),
    );
    const list = await store.readSchedules(taskId);
    expect(list).toHaveLength(12);
    expect(new Set(list.map((r) => r.id)).size).toBe(12);
  });

  it("单会话进行中（含暂停）的定时有健全性上限；已结束的不占名额", async () => {
    const taskId = await freshTask();
    // R14 Q20-05：完全等价的活定时会被去重（不新建），所以这里每条用不同标题才能真的凑满名额
    for (let i = 0; i < SCHEDULE_MAX_ACTIVE_PER_TASK; i++) await mustCreate(taskId, onceInput({ title: `t${i}` }));
    const over = await store.createSchedule(taskId, onceInput({ title: "满了之后的一条" }), NOW);
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.error).toContain("先取消");
    const first = (await store.readSchedules(taskId))[0]!;
    await store.cancelSchedule(taskId, first.id, "x", NOW);
    expect((await store.createSchedule(taskId, onceInput({ title: "满了之后的一条" }), NOW)).ok).toBe(true);
  });
});

describe("任务没了就不写（绝不把目录又建出来）", () => {
  it("目录不存在 → task_gone，且不会凭空建目录", async () => {
    const dir = taskDir("t_sch_missing");
    const r = await store.createSchedule("t_sch_missing", onceInput(), NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("不存在");
    await expect(fs.stat(dir)).rejects.toThrow();
  });

  it("打了删除标记 → 同样拒绝写入", async () => {
    const taskId = await freshTask();
    await mustCreate(taskId);
    await fs.writeFile(path.join(taskDir(taskId), DELETED_TOMBSTONE_FILE), "x");
    const r = await store.createSchedule(taskId, onceInput(), NOW);
    expect(r.ok).toBe(false);
    const op = await store.cancelSchedule(taskId, "whatever", "x", NOW);
    expect(op).toMatchObject({ ok: false, code: "task_gone" });
  });
});

describe("取消 / 暂停 / 恢复 / 清理", () => {
  it("取消：落盘 cancelled + endNote；重复取消 → bad_state；不存在 → not_found", async () => {
    const taskId = await freshTask();
    const rec = await mustCreate(taskId);
    const r = await store.cancelSchedule(taskId, rec.id, "用户取消", NOW + MIN);
    expect(r).toMatchObject({ ok: true });
    const [saved] = await store.readSchedules(taskId);
    expect(saved).toMatchObject({ status: "cancelled", endNote: "用户取消", nextFireAt: null });
    expect(await store.cancelSchedule(taskId, rec.id, "x", NOW)).toMatchObject({
      ok: false,
      code: "bad_state",
    });
    expect(await store.cancelSchedule(taskId, "sch_nope", "x", NOW)).toMatchObject({
      ok: false,
      code: "not_found",
    });
  });

  it("暂停 / 恢复：只在对应状态可用", async () => {
    const taskId = await freshTask();
    const rec = await mustCreate(taskId, everyInput());
    expect(await store.resumeSchedule(taskId, rec.id, NOW)).toMatchObject({ ok: false, code: "bad_state" });
    const paused = await store.pauseSchedule(taskId, rec.id, NOW + MIN);
    expect(paused).toMatchObject({ ok: true });
    expect(await store.pauseSchedule(taskId, rec.id, NOW)).toMatchObject({ ok: false, code: "bad_state" });
    const resumed = await store.resumeSchedule(taskId, rec.id, NOW + 5 * MIN);
    expect(resumed.ok && resumed.record.nextFireAt).toBe(NOW + 15 * MIN);
  });

  it("清理：只能删已结束的；活着的要先取消", async () => {
    const taskId = await freshTask();
    const rec = await mustCreate(taskId);
    expect(await store.removeFinishedSchedule(taskId, rec.id)).toMatchObject({ ok: false, code: "bad_state" });
    await store.cancelSchedule(taskId, rec.id, "x", NOW);
    expect(await store.removeFinishedSchedule(taskId, rec.id)).toMatchObject({ ok: true });
    expect(await store.readSchedules(taskId)).toEqual([]);
  });

  it("cancelAll（归档用）：只取消还活着的，返回条数；已结束的不动；没有就 0", async () => {
    const taskId = await freshTask();
    expect(await store.cancelAllSchedulesForTask(taskId, "会话已归档", NOW)).toBe(0);
    const a = await mustCreate(taskId);
    await mustCreate(taskId, everyInput());
    // R14 Q20-05：与 a 完全等价的活定时会被去重成同一条，所以 c 要有不同的标题
    const c = await mustCreate(taskId, onceInput({ title: "另一条" }));
    await store.cancelSchedule(taskId, c.id, "先前取消", NOW);
    expect(await store.cancelAllSchedulesForTask(taskId, "会话已归档", NOW + MIN)).toBe(2);
    const list = await store.readSchedules(taskId);
    expect(list.every((r) => r.status === "cancelled")).toBe(true);
    expect(list.find((r) => r.id === a.id)?.endNote).toBe("会话已归档");
    expect(list.find((r) => r.id === c.id)?.endNote).toBe("先前取消");
  });

  it("已结束的记录超过保留上限 → 落盘时丢最早结束的", async () => {
    const taskId = await freshTask();
    const ids: string[] = [];
    for (let i = 0; i < SCHEDULE_KEEP_FINISHED + 4; i++) {
      const rec = await mustCreate(taskId);
      ids.push(rec.id);
      await store.cancelSchedule(taskId, rec.id, "x", NOW + i);
    }
    const list = await store.readSchedules(taskId);
    expect(list).toHaveLength(SCHEDULE_KEEP_FINISHED);
    expect(list.some((r) => r.id === ids[0])).toBe(false);
    expect(list.some((r) => r.id === ids.at(-1))).toBe(true);
  });
});

describe("调度器索引：只盯有会触发的定时的任务", () => {
  it("创建 → 进索引；全取消 → 出索引；暂停且无待投递 → 出索引", async () => {
    const taskId = await freshTask();
    expect(store.scheduleLiveTaskIds()).not.toContain(taskId);
    const rec = await mustCreate(taskId, everyInput());
    expect(store.scheduleLiveTaskIds()).toContain(taskId);
    await store.pauseSchedule(taskId, rec.id, NOW);
    expect(store.scheduleLiveTaskIds()).not.toContain(taskId);
    await store.resumeSchedule(taskId, rec.id, NOW);
    expect(store.scheduleLiveTaskIds()).toContain(taskId);
    await store.cancelSchedule(taskId, rec.id, "x", NOW);
    expect(store.scheduleLiveTaskIds()).not.toContain(taskId);
  });

  it("有待投递（pending）的 once：status 仍 active → 留在索引里直到送达", async () => {
    const taskId = await freshTask();
    const rec = await mustCreate(taskId);
    await store.mutateSchedules(taskId, (list) => ({
      list: list.map((r) => (r.id === rec.id ? claimFire(r, NOW + 20 * MIN) : r)),
      result: null,
    }));
    expect(store.scheduleLiveTaskIds()).toContain(taskId);
  });

  it("任务被删：forget 摘掉；之后 mutate 发现目录没了也会摘掉", async () => {
    const taskId = await freshTask();
    await mustCreate(taskId);
    store.forgetSchedulesForDeletedTask(taskId);
    expect(store.scheduleLiveTaskIds()).not.toContain(taskId);
    await store.createSchedule(taskId, onceInput(), NOW);
    expect(store.scheduleLiveTaskIds()).toContain(taskId);
    await fs.rm(taskDir(taskId), { recursive: true, force: true });
    await store.mutateSchedules(taskId, (list) => ({ list, result: null }));
    expect(store.scheduleLiveTaskIds()).not.toContain(taskId);
  });

  it("重启重建：扫数据目录里有 schedules.json 的任务，按文件内容恢复索引（只读）", async () => {
    const live = await freshTask();
    const dead = await freshTask();
    await mustCreate(live, everyInput());
    const d = await mustCreate(dead);
    await store.cancelSchedule(dead, d.id, "x", NOW);
    store.forgetSchedulesForDeletedTask(live);
    store.forgetSchedulesForDeletedTask(dead);
    // 数据目录里混进手工目录（含点号）不得带崩
    const weird = path.join(path.dirname(taskDir("t_x")), "weird.dir");
    await fs.mkdir(weird, { recursive: true });
    await fs.writeFile(path.join(weird, SCHEDULE_FILE), "[]"); // 里面真有定时文件：只能是名字过滤把它挡在外面

    const before = await fs.readFile(path.join(taskDir(live), SCHEDULE_FILE), "utf-8");
    await store.rebuildScheduleIndex();
    expect(store.scheduleLiveTaskIds()).toContain(live);
    expect(store.scheduleLiveTaskIds()).not.toContain(dead);
    expect(await fs.readFile(path.join(taskDir(live), SCHEDULE_FILE), "utf-8")).toBe(before);
    expect(await store.listTaskIdsWithScheduleFile()).toEqual(expect.arrayContaining([live, dead]));
    expect(await store.listTaskIdsWithScheduleFile()).not.toContain("weird.dir");
  });
});

describe("listTaskIdsWithScheduleFile：全目录扫描", () => {
  it("几百个任务目录也不会一次性全发 stat（并发 ≤ 32）；结果按目录顺序、不随 stat 完成先后抖", async () => {
    const names: string[] = [];
    for (let i = 0; i < 150; i += 1) {
      const id = `t_scan_${i}`;
      names.push(id);
      await fs.mkdir(taskDir(id), { recursive: true });
      if (i % 3 === 0) await fs.writeFile(path.join(taskDir(id), SCHEDULE_FILE), "[]");
    }
    const realStat = fs.stat.bind(fs);
    let inflight = 0;
    let peak = 0;
    const spy = vi.spyOn(fs, "stat").mockImplementation((async (...args: Parameters<typeof fs.stat>) => {
      inflight += 1;
      peak = Math.max(peak, inflight);
      try {
        // 编号越小睡得越久：并发放开的话，完成顺序会和目录顺序相反
        const n = Number(/t_scan_(\d+)/.exec(String(args[0]))?.[1] ?? 0);
        await new Promise((r) => setTimeout(r, Math.max(0, 6 - Math.floor(n / 30))));
        return await realStat(...args);
      } finally {
        inflight -= 1;
      }
    }) as unknown as typeof fs.stat);
    let ids: string[];
    try {
      ids = await store.listTaskIdsWithScheduleFile();
    } finally {
      spy.mockRestore();
    }
    expect(peak).toBeLessThanOrEqual(32);
    expect(peak).toBeGreaterThan(1);
    const scan = ids.filter((id) => id.startsWith("t_scan_"));
    expect(scan).toHaveLength(50);
    const dirOrder = (await fs.readdir(path.dirname(taskDir("t_x")))).filter((n) => names.includes(n));
    expect(scan).toEqual(dirOrder.filter((n) => scan.includes(n)));
  });
});

describe("坏文件不得带崩调度", () => {
  it("整个文件不是 JSON → 当空处理（不抛）", async () => {
    const taskId = await freshTask();
    await fs.writeFile(path.join(taskDir(taskId), SCHEDULE_FILE), "{ not json");
    expect(await store.readSchedules(taskId)).toEqual([]);
  });

  it("单条坏记录被丢弃，好的保留；taskId 以所在目录为准", async () => {
    const taskId = await freshTask();
    const good = await mustCreate(taskId);
    const file = path.join(taskDir(taskId), SCHEDULE_FILE);
    const body = JSON.parse(await fs.readFile(file, "utf-8")) as {
      v: number;
      schedules: unknown[];
    };
    body.schedules.push({ id: "broken" }, { ...good, id: "sch_moved", taskId: "other_task" });
    await fs.writeFile(file, JSON.stringify(body));
    const list = await store.readSchedules(taskId);
    expect(list.map((r) => r.id).sort()).toEqual([good.id, "sch_moved"].sort());
    expect(list.every((r) => r.taskId === taskId)).toBe(true);
  });

  it("mutate 在 changed:false 时不落盘", async () => {
    const taskId = await freshTask();
    await mustCreate(taskId);
    const file = path.join(taskDir(taskId), SCHEDULE_FILE);
    const mtime = statSync(file).mtimeMs;
    await new Promise((r) => setTimeout(r, 15));
    await store.mutateSchedules(taskId, (list) => ({ list, result: null, changed: false }));
    expect(statSync(file).mtimeMs).toBe(mtime);
  });

  it("markCancelled 过的记录再读回仍是合法记录（序列化往返）", async () => {
    const taskId = await freshTask();
    const rec = await mustCreate(taskId, everyInput());
    await store.mutateSchedules(taskId, (list) => ({
      list: list.map((r) => (r.id === rec.id ? markCancelled(claimFire(r, NOW + 10 * MIN), NOW, "x") : r)),
      result: null,
    }));
    const [saved] = await store.readSchedules(taskId);
    // 取消时手上还有没送进会话的一次 → 如实记成 skipped，pending 清掉
    expect(saved).toMatchObject({ status: "cancelled" });
    expect(saved?.history.at(-1)).toMatchObject({ outcome: "skipped" });
    expect(saved?.pending).toBeUndefined();
  });
});

const ioError = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code });

const backupsOf = async (taskId: string): Promise<string[]> =>
  (await fs.readdir(taskDir(taskId))).filter((n) => n.startsWith(`${SCHEDULE_FILE}.corrupt-`));

describe("读不出来 ≠ 没有：IO 错误不得被当成「空」再写回去（review 🔴1）", () => {
  it("schedules.json 的路径是目录（EISDIR）→ 读与读改写都抛，原样不动", async () => {
    const taskId = await freshTask();
    const file = path.join(taskDir(taskId), SCHEDULE_FILE);
    await fs.mkdir(file);
    await expect(store.readSchedules(taskId)).rejects.toMatchObject({ code: "EISDIR" });
    await expect(store.createSchedule(taskId, onceInput(), NOW)).rejects.toMatchObject({ code: "EISDIR" });
    expect(statSync(file).isDirectory()).toBe(true);
  });

  it("读文件中途 EIO → createSchedule 抛，磁盘上已有的两条定时一字不改（不是被一条新记录覆盖）", async () => {
    const taskId = await freshTask();
    await mustCreate(taskId, onceInput({ title: "甲" }));
    await mustCreate(taskId, onceInput({ title: "乙" }));
    const file = path.join(taskDir(taskId), SCHEDULE_FILE);
    const before = await fs.readFile(file, "utf-8");
    const spy = vi.spyOn(fs, "readFile").mockRejectedValueOnce(ioError("EIO"));
    try {
      await expect(store.createSchedule(taskId, onceInput({ title: "丙" }), NOW)).rejects.toMatchObject({
        code: "EIO",
      });
    } finally {
      spy.mockRestore();
    }
    expect(await fs.readFile(file, "utf-8")).toBe(before);
    expect(await store.readSchedules(taskId)).toHaveLength(2);
    expect(await backupsOf(taskId)).toEqual([]);
  });

  it("文件不存在（ENOENT）才是「空」：照常创建", async () => {
    const taskId = await freshTask();
    expect(await store.readSchedules(taskId)).toEqual([]);
    const r = await store.createSchedule(taskId, onceInput(), NOW);
    expect(r.ok).toBe(true);
  });

  it("目录 stat 报 EIO / EMFILE（不是 ENOENT）→ 抛，**不当成任务没了**：索引不被摘掉", async () => {
    const taskId = await freshTask();
    await mustCreate(taskId, everyInput());
    expect(store.scheduleLiveTaskIds()).toContain(taskId);
    const spy = vi.spyOn(fs, "stat").mockRejectedValueOnce(ioError("EMFILE"));
    try {
      await expect(store.mutateSchedules(taskId, (list) => ({ list, result: null }))).rejects.toMatchObject({
        code: "EMFILE",
      });
    } finally {
      spy.mockRestore();
    }
    expect(store.scheduleLiveTaskIds()).toContain(taskId);
    // 瞬时错误过去后一切照常
    const again = await store.mutateSchedules(taskId, (list) => ({ list, result: list.length, changed: false }));
    expect(again).toEqual({ ok: true, result: 1 });
  });

  it("删除标记文件 stat 报非 ENOENT 错误 → 同样抛，不当成「没有标记」继续写", async () => {
    const taskId = await freshTask();
    await mustCreate(taskId);
    const real = fs.stat.bind(fs);
    const spy = vi.spyOn(fs, "stat").mockImplementation(async (p, ...rest) => {
      if (String(p).endsWith(DELETED_TOMBSTONE_FILE)) throw ioError("EACCES");
      return real(p, ...(rest as []));
    });
    try {
      await expect(store.createSchedule(taskId, onceInput(), NOW)).rejects.toMatchObject({ code: "EACCES" });
    } finally {
      spy.mockRestore();
    }
    expect(await store.readSchedules(taskId)).toHaveLength(1);
  });

  it("读路径上的「文件损坏」告警限频：反复读同一个坏文件只提示一次，过了窗口再提示；不同会话各自提示", async () => {
    const a = await freshTask();
    const b = await freshTask();
    await fs.writeFile(path.join(taskDir(a), SCHEDULE_FILE), "{ not json", "utf-8");
    await fs.writeFile(path.join(taskDir(b), SCHEDULE_FILE), "[[[", "utf-8");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    // 只数跟本用例两个会话有关的告警（别的用例遗留的异步读可能也在同一时刻打日志）
    const warned = (id: string): number =>
      warn.mock.calls.filter((c) => String(c[0]).includes(`task=${id}`)).length;
    try {
      for (let i = 0; i < 5; i++) expect(await store.readSchedules(a)).toEqual([]);
      expect(warned(a)).toBe(1);
      // 另一个会话不受影响
      await store.readSchedules(b);
      expect(warned(b)).toBe(1);
      await store.readSchedules(b);
      expect(warned(b)).toBe(1);
      // 过了窗口再提示一次
      clock.mockReturnValue(now + store.CORRUPT_READ_WARN_INTERVAL_MS + 1);
      await store.readSchedules(a);
      expect(warned(a)).toBe(2);
      // 读路径从不动文件：没有改名、原文件还在
      expect(await backupsOf(a)).toEqual([]);
    } finally {
      warn.mockRestore();
      clock.mockRestore();
    }
  });

  it("整个文件损坏 + 要写 → 原文件改名 .corrupt-<ts> 留证据，新文件从空开始且合法", async () => {
    const taskId = await freshTask();
    const file = path.join(taskDir(taskId), SCHEDULE_FILE);
    await fs.writeFile(file, "{ not json");
    // 只读路径不碰文件
    expect(await store.readSchedules(taskId)).toEqual([]);
    expect(await backupsOf(taskId)).toEqual([]);
    expect(await fs.readFile(file, "utf-8")).toBe("{ not json");
    // 读改写路径：先备份再写
    const rec = await mustCreate(taskId);
    const backups = await backupsOf(taskId);
    expect(backups).toHaveLength(1);
    expect(await fs.readFile(path.join(taskDir(taskId), backups[0]!), "utf-8")).toBe("{ not json");
    expect((await store.readSchedules(taskId)).map((r) => r.id)).toEqual([rec.id]);
  });

  it("结构不对（没有 schedules 数组）同样按损坏处理并备份", async () => {
    const taskId = await freshTask();
    const file = path.join(taskDir(taskId), SCHEDULE_FILE);
    await fs.writeFile(file, JSON.stringify({ v: 1, items: [] }));
    await mustCreate(taskId);
    const backups = await backupsOf(taskId);
    expect(backups).toHaveLength(1);
    expect(JSON.parse(await fs.readFile(path.join(taskDir(taskId), backups[0]!), "utf-8"))).toEqual({
      v: 1,
      items: [],
    });
  });

  it("个别记录无效 → 好的保留，原文件先复制成 .corrupt-<ts>（被丢的那条还能手工找回）", async () => {
    const taskId = await freshTask();
    const good = await mustCreate(taskId);
    const file = path.join(taskDir(taskId), SCHEDULE_FILE);
    const body = JSON.parse(await fs.readFile(file, "utf-8")) as { v: number; schedules: unknown[] };
    body.schedules.push({ id: "broken", title: "我是被丢的那条" });
    const original = JSON.stringify(body);
    await fs.writeFile(file, original);
    // 读路径不备份
    expect(await store.readSchedules(taskId)).toHaveLength(1);
    expect(await backupsOf(taskId)).toEqual([]);
    // 写路径备份
    await store.createSchedule(taskId, onceInput({ title: "新的" }), NOW);
    const backups = await backupsOf(taskId);
    expect(backups).toHaveLength(1);
    expect(await fs.readFile(path.join(taskDir(taskId), backups[0]!), "utf-8")).toBe(original);
    const ids = (await store.readSchedules(taskId)).map((r) => r.id);
    expect(ids).toContain(good.id);
    expect(ids).toHaveLength(2);
  });

  it("文件完全正常时不产生任何备份", async () => {
    const taskId = await freshTask();
    await mustCreate(taskId);
    await mustCreate(taskId);
    expect(await backupsOf(taskId)).toEqual([]);
  });

  it("损坏文件改名失败 → 抛、不写：原文件仍在原处", async () => {
    const taskId = await freshTask();
    const file = path.join(taskDir(taskId), SCHEDULE_FILE);
    await fs.writeFile(file, "{ not json");
    const spy = vi.spyOn(fs, "rename").mockRejectedValueOnce(ioError("EACCES"));
    try {
      await expect(store.createSchedule(taskId, onceInput(), NOW)).rejects.toMatchObject({ code: "EACCES" });
    } finally {
      spy.mockRestore();
    }
    expect(await fs.readFile(file, "utf-8")).toBe("{ not json");
  });

  it("个别无效记录的备份复制失败 → 抛、不写（宁可这次不写，也不无痕丢数据）", async () => {
    const taskId = await freshTask();
    await mustCreate(taskId);
    const file = path.join(taskDir(taskId), SCHEDULE_FILE);
    const body = JSON.parse(await fs.readFile(file, "utf-8")) as { schedules: unknown[] };
    body.schedules.push({ id: "broken" });
    const original = JSON.stringify(body);
    await fs.writeFile(file, original);
    const spy = vi.spyOn(fs, "copyFile").mockRejectedValueOnce(ioError("ENOSPC"));
    try {
      await expect(store.createSchedule(taskId, onceInput(), NOW)).rejects.toMatchObject({ code: "ENOSPC" });
    } finally {
      spy.mockRestore();
    }
    expect(await fs.readFile(file, "utf-8")).toBe(original);
  });
});

describe("索引校正与重建（review 🟡）", () => {
  it("syncScheduleIndex：读到的列表里没有要盯的 → 摘掉；有 → 加上（tick 读完顺手校正，别每 5 秒白读）", async () => {
    const taskId = await freshTask();
    const rec = await mustCreate(taskId, everyInput());
    expect(store.scheduleLiveTaskIds()).toContain(taskId);
    store.syncScheduleIndex(taskId, [markCancelled(rec, NOW, "x")]);
    expect(store.scheduleLiveTaskIds()).not.toContain(taskId);
    store.syncScheduleIndex(taskId, [rec]);
    expect(store.scheduleLiveTaskIds()).toContain(taskId);
  });

  it("重建索引时某个任务的文件读不出来 → 先留在索引里（不是摘掉），其它任务照常恢复", async () => {
    const broken = await freshTask();
    const fine = await freshTask();
    await mustCreate(fine, everyInput());
    // broken：schedules.json 是个目录 → stat 通过（被枚举到）、readFile 抛 EISDIR
    await fs.mkdir(path.join(taskDir(broken), SCHEDULE_FILE));
    store.forgetSchedulesForDeletedTask(broken);
    store.forgetSchedulesForDeletedTask(fine);
    await store.rebuildScheduleIndex();
    expect(store.scheduleLiveTaskIds()).toContain(broken);
    expect(store.scheduleLiveTaskIds()).toContain(fine);
    expect(console.warn).toHaveBeenCalled();
  });

  it("重建索引在任务锁内读：同任务的锁被占着时它等着，不会拿一份「读在前」的旧列表去刷索引", async () => {
    const taskId = await freshTask();
    await mustCreate(taskId, everyInput());
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let held!: () => void;
    const heldP = new Promise<void>((r) => (held = r));
    const holder = withTaskLock(taskId, async () => {
      held();
      await gate;
    });
    await heldP;
    store.forgetSchedulesForDeletedTask(taskId);
    let done = false;
    const rebuilding = store.rebuildScheduleIndex().then(() => {
      done = true;
    });
    await new Promise((r) => setTimeout(r, 60));
    expect(done).toBe(false);
    expect(store.scheduleLiveTaskIds()).not.toContain(taskId);
    release();
    await holder;
    await rebuilding;
    expect(store.scheduleLiveTaskIds()).toContain(taskId);
  });
});
