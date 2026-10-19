/**
 * 定时任务服务层（`schedule-service`）：真实投递的接线 + 管理页聚合。
 *
 * 下游 inject / 设置 / 任务元数据都 mock 掉：这里只验「到点那条消息怎么走进会话」——
 *  - chat → handleChatReplyInject、task → handleTaskQuestionInject，且都带 scheduledTrigger:true + meta.source=schedule
 *  - 模型 / 凭据跟这个会话自己走（bootArgsForTask），不是别的
 *  - 归档 / 会话没了 → 永久失败；有未答提问 → 等（不打断）
 * 到点判定与重试语义在 tests/schedule-runner.test.ts。
 */
import { mkdtempSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-schedule-service-"));
process.env.FLOWSHIP_DATA_DIR = TMP_ROOT;

const mocks = vi.hoisted(() => ({
  chatInject: vi.fn(),
  taskInject: vi.fn(),
  getTaskMeta: vi.fn(),
  readSettingsFile: vi.fn(),
  getPendingAsk: vi.fn(),
}));

vi.mock("@/lib/server/chat-inject", () => ({ handleChatReplyInject: mocks.chatInject }));
vi.mock("@/lib/server/task-question-inject", () => ({ handleTaskQuestionInject: mocks.taskInject }));
vi.mock("@/lib/server/chat-pending", () => ({ getPendingAsk: mocks.getPendingAsk }));
vi.mock("@/lib/server/task-fs", () => ({ getTaskMeta: mocks.getTaskMeta }));
vi.mock("@/lib/server/settings-fs", () => ({ readSettingsFile: mocks.readSettingsFile }));
vi.mock("@/lib/server/task-stream", () => ({ writeEventAndPublish: vi.fn(async () => null) }));

const service = await import("@/lib/server/schedule-service");
const store = await import("@/lib/server/schedule-store");
const { taskDir } = await import("@/lib/server/task-fs-core");
const { buildScheduleFireMeta, buildScheduleRecord } = await import("@/lib/schedule");

import type { DeliverRequest } from "@/lib/server/schedule-runner";

const MIN = 60_000;
const NOW = Date.UTC(2026, 9, 18, 2, 0, 0);

const rec = (taskId: string) =>
  buildScheduleRecord(
    taskId,
    { kind: "once", title: "看 CI", message: "去看 CI", firstFireAt: NOW + 10 * MIN },
    NOW,
    "sch_svc",
  );

const request = (taskId: string): DeliverRequest => {
  const record = rec(taskId);
  const pending = { seq: 1, dueAt: NOW + 10 * MIN, since: NOW + 10 * MIN };
  return {
    taskId,
    record,
    pending,
    text: "[SCHEDULE_FIRED id=sch_svc]\n去看 CI",
    meta: buildScheduleFireMeta(record, pending),
    clientItemId: "sch_svc.1.1",
  };
};

const json = (status: number, body: unknown = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const SETTINGS_OK = {
  status: "ok",
  settings: { apiKey: " sk-test ", defaultModel: { id: "composer-2" } },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  mocks.getTaskMeta.mockResolvedValue({ id: "t_svc", mode: "chat", title: "聊天", archived: false });
  mocks.readSettingsFile.mockResolvedValue(SETTINGS_OK);
  mocks.getPendingAsk.mockReturnValue(null);
  mocks.chatInject.mockResolvedValue(json(200, { ok: true }));
  mocks.taskInject.mockResolvedValue(json(200, { ok: true }));
});

describe("deliverScheduleFire：投递前的拦截", () => {
  it("会话已不存在 → 永久失败，不碰 inject", async () => {
    mocks.getTaskMeta.mockResolvedValue(null);
    expect(await service.deliverScheduleFire(request("t_svc"))).toMatchObject({ kind: "failed" });
    expect(mocks.chatInject).not.toHaveBeenCalled();
    expect(mocks.taskInject).not.toHaveBeenCalled();
  });

  it("已归档 → 永久失败（归档时本来就会取消定时，这里是兜底）", async () => {
    mocks.getTaskMeta.mockResolvedValue({ id: "t_svc", mode: "chat", archived: true });
    expect(await service.deliverScheduleFire(request("t_svc"))).toEqual({
      kind: "failed",
      reason: "会话已归档",
      permanent: true,
    });
    expect(mocks.chatInject).not.toHaveBeenCalled();
  });

  it("用户还有没答的提问 → 等（retry），不去打断也不顶掉它", async () => {
    mocks.getTaskMeta.mockResolvedValue({ id: "t_svc", mode: "chat", pendingAskId: "ask_1" });
    const r = await service.deliverScheduleFire(request("t_svc"));
    expect(r.kind).toBe("retry");
    expect(mocks.chatInject).not.toHaveBeenCalled();
  });

  it("会话没了 / 已归档 / 任务已合入 / 已放弃 → 都是 permanent（周期定时据此直接取消，不再每个周期失败一次）", async () => {
    mocks.getTaskMeta.mockResolvedValue(null);
    expect(await service.deliverScheduleFire(request("t_svc"))).toMatchObject({ kind: "failed", permanent: true });
    mocks.getTaskMeta.mockResolvedValue({ id: "t_svc", mode: "chat", archived: true });
    expect(await service.deliverScheduleFire(request("t_svc"))).toMatchObject({ kind: "failed", permanent: true });
    expect(mocks.chatInject).not.toHaveBeenCalled();
  });

  it("task 已合入 / 已放弃 → 永久失败：task 路径对终态任务只写一条 error 就退出，不拦的话会被记成「已送达」", async () => {
    for (const [repoStatus, word] of [
      ["merged", "已合入"],
      ["abandoned", "已放弃"],
    ] as const) {
      mocks.getTaskMeta.mockResolvedValue({ id: "t_svc", mode: "task", repoStatus, archived: false });
      const r = await service.deliverScheduleFire(request("t_svc"));
      expect(r).toMatchObject({ kind: "failed", permanent: true });
      expect(r.kind === "failed" && r.reason).toContain(word);
    }
    expect(mocks.taskInject).not.toHaveBeenCalled();
    expect(mocks.chatInject).not.toHaveBeenCalled();
  });

  it("进行中的 task（developing 等）照常送，终态拦截不误伤", async () => {
    mocks.getTaskMeta.mockResolvedValue({ id: "t_svc", mode: "task", repoStatus: "developing", archived: false });
    expect(await service.deliverScheduleFire(request("t_svc"))).toEqual({ kind: "delivered" });
    expect(mocks.taskInject).toHaveBeenCalledTimes(1);
  });

  it("内存里登记着未答提问（meta.pendingAskId 还没落盘）→ 也要等，不能因为 meta 滞后把定时消息塞到提问前面", async () => {
    mocks.getTaskMeta.mockResolvedValue({ id: "t_svc", mode: "chat", archived: false }); // meta 里没有 pendingAskId
    mocks.getPendingAsk.mockReturnValue({ askId: "ask_mem" });
    const r = await service.deliverScheduleFire(request("t_svc"));
    expect(r.kind).toBe("retry");
    expect(mocks.getPendingAsk).toHaveBeenCalledWith("t_svc");
    expect(mocks.chatInject).not.toHaveBeenCalled();
  });

  it("读不到设置 / 没有可用模型 → 永久失败并指路设置页", async () => {
    mocks.readSettingsFile.mockResolvedValue({ status: "missing" });
    const r1 = await service.deliverScheduleFire(request("t_svc"));
    expect(r1).toMatchObject({ kind: "failed" });
    expect(r1.kind === "failed" && r1.reason).toContain("设置");

    mocks.readSettingsFile.mockResolvedValue({ status: "ok", settings: { apiKey: "sk", defaultModel: { id: "" } } });
    expect((await service.deliverScheduleFire(request("t_svc"))).kind).toBe("failed");
    expect(mocks.chatInject).not.toHaveBeenCalled();
  });
});

describe("deliverScheduleFire：按会话模式分发", () => {
  it("chat：走 handleChatReplyInject；带幂等键 / bootArgs / meta.source=schedule / scheduledTrigger", async () => {
    const req = request("t_svc");
    const r = await service.deliverScheduleFire(req);
    expect(r).toEqual({ kind: "delivered" });
    expect(mocks.taskInject).not.toHaveBeenCalled();
    expect(mocks.chatInject).toHaveBeenCalledTimes(1);
    const [id, body, options] = mocks.chatInject.mock.calls[0]!;
    expect(id).toBe("t_svc");
    expect(body).toMatchObject({
      text: req.text,
      clientItemId: "sch_svc.1.1",
      bootArgs: { apiKey: "sk-test", model: { id: "composer-2" } }, // key 被 trim
    });
    expect(options).toMatchObject({ scheduledTrigger: true });
    expect(options.userReplyMetaExtra).toMatchObject({ source: "schedule", scheduleId: "sch_svc" });
  });

  it("task：走 handleTaskQuestionInject，同样带 scheduledTrigger:true", async () => {
    mocks.getTaskMeta.mockResolvedValue({ id: "t_svc", mode: "task", title: "做需求", archived: false });
    const r = await service.deliverScheduleFire(request("t_svc"));
    expect(r).toEqual({ kind: "delivered" });
    expect(mocks.chatInject).not.toHaveBeenCalled();
    const [, , options] = mocks.taskInject.mock.calls[0]!;
    expect(options).toMatchObject({ scheduledTrigger: true });
    expect(options.userReplyMetaExtra).toMatchObject({ source: "schedule" });
  });

  it("用会话自己的模型：任务上记着的模型优先于设置页默认", async () => {
    mocks.getTaskMeta.mockResolvedValue({
      id: "t_svc",
      mode: "chat",
      archived: false,
      model: { id: "gpt-5" },
    });
    await service.deliverScheduleFire(request("t_svc"));
    expect(mocks.chatInject.mock.calls[0]![1].bootArgs.model.id).toBe("gpt-5");
  });

  it("下游响应分类：202 排队 = 送达；409 忙 = 重试；404 = 永久失败", async () => {
    mocks.chatInject.mockResolvedValueOnce(json(202, { queued: true }));
    expect((await service.deliverScheduleFire(request("t_svc"))).kind).toBe("delivered");
    mocks.chatInject.mockResolvedValueOnce(json(409, { error: "正忙" }));
    expect((await service.deliverScheduleFire(request("t_svc"))).kind).toBe("retry");
    mocks.chatInject.mockResolvedValueOnce(json(404, {}));
    expect((await service.deliverScheduleFire(request("t_svc"))).kind).toBe("failed");
  });

  it("下游响应体不是 JSON 也不抛", async () => {
    mocks.chatInject.mockResolvedValueOnce(new Response("oops", { status: 500 }));
    expect((await service.deliverScheduleFire(request("t_svc"))).kind).toBe("retry");
  });
});

describe("listScheduleItems：管理页聚合", () => {
  const mkTask = async (id: string, meta: Record<string, unknown>) => {
    await fs.mkdir(taskDir(id), { recursive: true });
    return { id, meta };
  };

  it("带上所属会话的标题 / 模式 / 归档；活的在前（下次触发升序），结束的在后（结束时间降序）；会话没了的跳过", async () => {
    const a = await mkTask("t_list_a", { title: "A 会话", mode: "chat" });
    const b = await mkTask("t_list_b", { title: "B 任务", mode: "task", archived: true });
    const gone = await mkTask("t_list_gone", { title: "已删" });
    const metas = new Map([a, b].map((t) => [t.id, t.meta]));
    mocks.getTaskMeta.mockImplementation(async (id: string) => {
      const m = metas.get(id);
      return m ? { id, ...m } : null;
    });

    const mk = async (taskId: string, title: string, firstFireAt: number) => {
      const r = await store.createSchedule(
        taskId,
        { kind: "once", title, message: title, firstFireAt },
        NOW,
      );
      if (!r.ok) throw new Error(r.error);
      return r.record;
    };
    await mk("t_list_a", "晚", NOW + 60 * MIN);
    await mk("t_list_b", "早", NOW + 5 * MIN);
    const old1 = await mk("t_list_a", "旧-先结束", NOW + 30 * MIN);
    const old2 = await mk("t_list_b", "旧-后结束", NOW + 30 * MIN);
    await store.cancelSchedule("t_list_a", old1.id, "x", NOW + 1 * MIN);
    await store.cancelSchedule("t_list_b", old2.id, "x", NOW + 2 * MIN);
    await mk(gone.id, "孤儿", NOW + MIN);

    const items = (await service.listScheduleItems()).filter((i) =>
      ["t_list_a", "t_list_b", gone.id].includes(i.taskId),
    );
    expect(items.map((i) => i.title)).toEqual(["早", "晚", "旧-后结束", "旧-先结束"]);
    expect(items[0]).toMatchObject({ taskTitle: "B 任务", taskMode: "task", taskArchived: true });
    expect(items[1]).toMatchObject({ taskTitle: "A 会话", taskMode: "chat", taskArchived: false });
    expect(items.some((i) => i.taskId === gone.id)).toBe(false);
  });
});

describe("listScheduleItems：主键相同的行顺序是确定的（复审 🟢）", () => {
  it("两个会话各设了同一时刻 → 不论哪个会话先读完，顺序都一样（创建时间 → id）", async () => {
    const taskIds = ["t_tie_a", "t_tie_b", "t_tie_c"];
    for (const id of taskIds) await fs.mkdir(taskDir(id), { recursive: true });
    const fireAt = NOW + 90 * MIN;
    // 创建时间不同：b 最早、c 其次、a 最晚（用显式的 now 造）
    const createdAt: Record<string, number> = { t_tie_b: NOW, t_tie_c: NOW + 1, t_tie_a: NOW + 2 };
    for (const id of taskIds) {
      const r = await store.createSchedule(
        id,
        { kind: "once", title: `同刻-${id}`, message: "x", firstFireAt: fireAt },
        createdAt[id]!,
      );
      if (!r.ok) throw new Error(r.error);
    }
    const orderWith = async (delays: Record<string, number>): Promise<string[]> => {
      mocks.getTaskMeta.mockImplementation(async (id: string) => {
        await new Promise((r) => setTimeout(r, delays[id] ?? 0));
        return { id, title: id, mode: "chat" };
      });
      return (await service.listScheduleItems()).filter((i) => taskIds.includes(i.taskId)).map((i) => i.taskId);
    };
    const first = await orderWith({ t_tie_a: 0, t_tie_b: 20, t_tie_c: 10 });
    const second = await orderWith({ t_tie_a: 20, t_tie_b: 0, t_tie_c: 10 });
    expect(first).toEqual(["t_tie_b", "t_tie_c", "t_tie_a"]);
    expect(second).toEqual(first);
  });

  it("已结束的行同理：结束时间相同 → 创建时间 → id，与读完成先后无关", async () => {
    const taskIds = ["t_tie2_a", "t_tie2_b", "t_tie2_c"];
    for (const id of taskIds) await fs.mkdir(taskDir(id), { recursive: true });
    const createdAt: Record<string, number> = { t_tie2_c: NOW, t_tie2_a: NOW + 1, t_tie2_b: NOW + 2 };
    for (const id of taskIds) {
      const r = await store.createSchedule(
        id,
        { kind: "once", title: `结束-${id}`, message: "x", firstFireAt: NOW + 90 * MIN },
        createdAt[id]!,
      );
      if (!r.ok) throw new Error(r.error);
      await store.cancelSchedule(id, r.record.id, "x", NOW + 5 * MIN); // 结束时间全相同
    }
    const orderWith = async (delays: Record<string, number>): Promise<string[]> => {
      mocks.getTaskMeta.mockImplementation(async (id: string) => {
        await new Promise((r) => setTimeout(r, delays[id] ?? 0));
        return { id, title: id, mode: "chat" };
      });
      return (await service.listScheduleItems()).filter((i) => taskIds.includes(i.taskId)).map((i) => i.taskId);
    };
    const first = await orderWith({ t_tie2_a: 0, t_tie2_b: 20, t_tie2_c: 10 });
    const second = await orderWith({ t_tie2_a: 20, t_tie2_b: 0, t_tie2_c: 10 });
    expect(first).toEqual(["t_tie2_c", "t_tie2_a", "t_tie2_b"]);
    expect(second).toEqual(first);
  });
});

describe("listScheduleItems：有界并发", () => {
  it("有定时的会话再多，逐个读也不会一次性全发出去（≤ 16 路），而且一条不少", async () => {
    const N = 60;
    const ids: string[] = [];
    for (let i = 0; i < N; i += 1) {
      const id = `t_listc_${i}`;
      ids.push(id);
      await fs.mkdir(taskDir(id), { recursive: true });
      const r = await store.createSchedule(
        id,
        { kind: "once", title: `并发-${i}`, message: "x", firstFireAt: NOW + (i + 1) * MIN },
        NOW,
      );
      if (!r.ok) throw new Error(r.error);
    }
    let inflight = 0;
    let peak = 0;
    mocks.getTaskMeta.mockImplementation(async (id: string) => {
      inflight += 1;
      peak = Math.max(peak, inflight);
      try {
        await new Promise((r) => setTimeout(r, 3));
        return ids.includes(id) ? { id, title: id, mode: "chat" } : null;
      } finally {
        inflight -= 1;
      }
    });
    const items = (await service.listScheduleItems()).filter((i) => ids.includes(i.taskId));
    expect(items).toHaveLength(N);
    expect(peak).toBeLessThanOrEqual(16);
    expect(peak).toBeGreaterThan(1);
  });
});

describe("启动锚点", () => {
  it("vitest 下不起定时器（只有真正跑起来的服务才起）", () => {
    expect(process.env.VITEST).toBeTruthy();
    service.ensureScheduleRunnerStarted();
    expect((globalThis as Record<string, unknown>).__flowshipScheduleTimerStartedV1__).toBeUndefined();
  });
});
