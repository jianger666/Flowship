/**
 * `schedule` 工具：工具定义 / handler（create · list · cancel）/ Cursor 路径带 taskId。
 *
 * 到点调度本身在 tests/schedule-runner.test.ts；纯逻辑在 tests/schedule.test.ts；落盘在 tests/schedule-store.test.ts。
 */
import { mkdtempSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-schedule-tool-"));
process.env.FLOWSHIP_DATA_DIR = TMP_ROOT;

const published = vi.hoisted(
  () => [] as Array<{ taskId: string; ev: { kind: string; text?: string; meta?: Record<string, unknown> } }>,
);
vi.mock("@/lib/server/task-stream", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/task-stream")>();
  return {
    ...actual,
    writeEventAndPublish: vi.fn(async (taskId: string, ev: (typeof published)[number]["ev"]) => {
      published.push({ taskId, ev });
      return null;
    }),
  };
});

// 会话元数据：默认走真实实现（临时目录里没有 meta.json = null = 不拦）；用例里可覆盖成「已归档 / 已终结」
const metaOverride = vi.hoisted(() => ({ value: undefined as Record<string, unknown> | null | undefined }));
vi.mock("@/lib/server/task-fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/task-fs")>();
  return {
    ...actual,
    getTaskMeta: vi.fn(async (id: string) =>
      metaOverride.value === undefined ? actual.getTaskMeta(id) : metaOverride.value,
    ),
  };
});

const { buildSdkCustomTools, flowShipTools } = await import("@/lib/server/flowship-tools");
const taskStreamMod = await import("@/lib/server/task-stream");
const { readSchedules } = await import("@/lib/server/schedule-store");
const { taskDir } = await import("@/lib/server/task-fs-core");
const { SCHEDULE_TOOL_NAME, SCHEDULE_SUBKIND } = await import("@/lib/schedule");
const { setChatTaskActionHandler, getExpectedCallerToken } = await import("@/lib/server/chat-pending");

const def = flowShipTools.find((t) => t.name === SCHEDULE_TOOL_NAME)!;

const textOf = (r: { content: Array<{ type: "text"; text: string }> }): string =>
  r.content.map((c) => c.text).join("");

let seq = 0;
const freshTask = async (): Promise<string> => {
  seq += 1;
  const id = `t_tool_${seq}`;
  await fs.mkdir(taskDir(id), { recursive: true });
  // 当前 agent 实例登记的 callerToken = "tok"（真实路径里 installSessionIfCurrent 注册；schedule 有副作用、先验它）
  setChatTaskActionHandler(id, (async () => ({ ok: true })) as never, "tok");
  return id;
};

const run = async (taskId: string | undefined, args: Record<string, unknown>): Promise<string> =>
  textOf(await def.handler(args, "tok", taskId ? { taskId } : undefined));

beforeEach(() => {
  metaOverride.value = undefined;
  published.length = 0;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("schedule 工具定义", () => {
  it("名字是 schedule，已注册进 flowShipTools，且不和别的工具撞名", () => {
    expect(SCHEDULE_TOOL_NAME).toBe("schedule");
    expect(def).toBeDefined();
    const names = flowShipTools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("描述把关键事说清：自己叫自己、到点消息前缀、错过不补、别硬 wait、周期要自己取消", () => {
    const d = def.description;
    expect(d).toContain("[SCHEDULE_FIRED id=…]");
    expect(d).toContain("不会补发");
    expect(d).toContain("wait");
    expect(d).toContain("cancel");
    expect(d).toContain("归档或删除");
    expect(d).toContain("不是用户说话");
  });

  it("schema：action 必填，其余可选", () => {
    const schema = JSON.parse(JSON.stringify(def.parameters)) as {
      required?: string[];
      properties: Record<string, { enum?: string[] }>;
    };
    expect(schema.required).toEqual(["action"]);
    expect(Object.keys(schema.properties).sort()).toEqual(
      ["action", "at", "delay_minutes", "every_minutes", "id", "max_runs", "message", "title"].sort(),
    );
    expect(schema.properties.action?.enum).toEqual(["create", "list", "cancel"]);
  });
});

describe("handler：create", () => {
  it("一次性（delay_minutes）：落盘 + 返回 [SCHEDULED id=…] + 事件流写一条 info（带 subkind=schedule）", async () => {
    const taskId = await freshTask();
    const out = await run(taskId, { action: "create", title: "看 CI", message: "去看 CI", delay_minutes: 20 });
    const [rec] = await readSchedules(taskId);
    expect(rec).toMatchObject({ kind: "once", title: "看 CI", message: "去看 CI", status: "active" });
    expect(out).toContain(`[SCHEDULED id=${rec!.id}]`);
    expect(out).toContain("不会补发");
    expect(out).toContain("不要为了等它去 wait");
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      taskId,
      ev: { kind: "info", meta: { subkind: SCHEDULE_SUBKIND, scheduleId: rec!.id, phase: "created" } },
    });
    expect(published[0]!.ev.text).toContain("看 CI");
  });

  it("周期（every_minutes + max_runs）", async () => {
    const taskId = await freshTask();
    const out = await run(taskId, {
      action: "create",
      title: "盯部署",
      message: "看部署",
      every_minutes: 10,
      max_runs: 3,
    });
    const [rec] = await readSchedules(taskId);
    expect(rec).toMatchObject({ kind: "every", intervalMs: 600_000, maxRuns: 3 });
    expect(out).toContain("每 10 分钟");
    expect(out).toContain("首次");
  });

  it("参数不合法：回「参数错误」+ 具体原因，不落盘不写事件", async () => {
    const taskId = await freshTask();
    expect(await run(taskId, { action: "create", title: "x", message: "y" })).toContain("参数错误");
    expect(await run(taskId, { action: "create", title: "x", message: "y", delay_minutes: 0.1 })).toContain("wait");
    expect(await run(taskId, { action: "create", message: "y", delay_minutes: 5 })).toContain("title");
    expect(await readSchedules(taskId)).toEqual([]);
    expect(published).toHaveLength(0);
  });

  it("会话目录没了（被删）→ 创建失败而不是假装成功", async () => {
    // 实例仍登记着（token 校验放行），只是任务目录没了
    setChatTaskActionHandler("t_tool_gone", (async () => ({ ok: true })) as never, "tok");
    const out = await run("t_tool_gone", { action: "create", title: "x", message: "y", delay_minutes: 5 });
    expect(out).toContain("创建失败");
    expect(published).toHaveLength(0);
  });
});

describe("handler：list / cancel", () => {
  it("list：只列进行中 / 暂停的；没有就说没有", async () => {
    const taskId = await freshTask();
    expect(await run(taskId, { action: "list" })).toContain("没有进行中的定时");
    await run(taskId, { action: "create", title: "A", message: "a", delay_minutes: 5 });
    await run(taskId, { action: "create", title: "B", message: "b", every_minutes: 5 });
    const [a] = await readSchedules(taskId);
    const listed = await run(taskId, { action: "list" });
    expect(listed).toContain("2 条定时");
    expect(listed).toContain(a!.id);
    expect(listed).toContain("一次性");
    expect(listed).toContain("每 5 分钟");

    await run(taskId, { action: "cancel", id: a!.id });
    const after = await run(taskId, { action: "list" });
    expect(after).toContain("1 条定时");
    expect(after).not.toContain(a!.id);
  });

  it("cancel：落盘取消（endNote=AI 取消）+ [CANCELLED id=…] + 写 info", async () => {
    const taskId = await freshTask();
    await run(taskId, { action: "create", title: "A", message: "a", every_minutes: 5 });
    const [rec] = await readSchedules(taskId);
    published.length = 0;
    const out = await run(taskId, { action: "cancel", id: rec!.id });
    expect(out).toContain(`[CANCELLED id=${rec!.id}]`);
    expect((await readSchedules(taskId))[0]).toMatchObject({ status: "cancelled", endNote: "AI 取消" });
    expect(published[0]).toMatchObject({
      ev: { kind: "info", meta: { scheduleId: rec!.id, phase: "cancelled" } },
    });
  });

  it("cancel：缺 id / 不存在 / 重复取消 → 明确报错，不写事件", async () => {
    const taskId = await freshTask();
    await run(taskId, { action: "create", title: "A", message: "a", delay_minutes: 5 });
    const [rec] = await readSchedules(taskId);
    published.length = 0;
    expect(await run(taskId, { action: "cancel" })).toContain("需要 id");
    expect(await run(taskId, { action: "cancel", id: "sch_nope" })).toContain("取消失败");
    await run(taskId, { action: "cancel", id: rec!.id });
    published.length = 0;
    expect(await run(taskId, { action: "cancel", id: rec!.id })).toContain("取消失败");
    expect(published).toHaveLength(0);
  });

  it("未知 action → 提示可用值", async () => {
    const taskId = await freshTask();
    expect(await run(taskId, { action: "nuke" })).toContain("create / list / cancel");
  });

  it("没有 taskId（不是正式会话）→ 明确说不可用，不乱建", async () => {
    expect(await run(undefined, { action: "create", title: "x", message: "y", delay_minutes: 5 })).toContain(
      "定时不可用",
    );
  });
});

describe("Cursor 路径：buildSdkCustomTools 把 taskId 带进回调", () => {
  it("带 taskId → 能创建到该会话名下；不带 → 不可用", async () => {
    const taskId = await freshTask();
    const tools = buildSdkCustomTools("tok", { taskId });
    const r = (await tools.schedule!.execute!(
      { action: "create", title: "A", message: "a", delay_minutes: 5 },
      {} as never,
    )) as { content: Array<{ type: "text"; text: string }> };
    expect(textOf(r)).toContain("[SCHEDULED id=");
    expect(await readSchedules(taskId)).toHaveLength(1);

    const bare = buildSdkCustomTools("tok");
    const r2 = (await bare.schedule!.execute!(
      { action: "create", title: "A", message: "a", delay_minutes: 5 },
      {} as never,
    )) as { content: Array<{ type: "text"; text: string }> };
    expect(textOf(r2)).toContain("定时不可用");
  });
});

describe("callerToken：被新 agent 接管 / 已停止的旧实例不许再建或取消定时（复审 🟡）", () => {
  const OLD = "任务已被新 agent 接管、本次调用忽略";

  it("token 对不上（旧实例）→ create 被拒：不落盘、不写事件", async () => {
    const taskId = await freshTask();
    const out = textOf(
      await def.handler({ action: "create", title: "x", message: "y", delay_minutes: 5 }, "old-tok", { taskId }),
    );
    expect(out).toBe(OLD);
    expect(await readSchedules(taskId)).toEqual([]);
    expect(published).toHaveLength(0);
  });

  it("token 对不上 → cancel 也被拒：已有的定时原样不动", async () => {
    const taskId = await freshTask();
    await run(taskId, { action: "create", title: "x", message: "y", delay_minutes: 5 });
    const [rec] = await readSchedules(taskId);
    published.length = 0;
    const out = textOf(await def.handler({ action: "cancel", id: rec!.id }, "old-tok", { taskId }));
    expect(out).toBe(OLD);
    expect((await readSchedules(taskId))[0]!.status).toBe("active");
    expect(published).toHaveLength(0);
  });

  it("没带 token / 这个会话没有登记任何实例（已停止）→ 同样拒绝（fail-closed）", async () => {
    const taskId = await freshTask();
    expect(
      textOf(await def.handler({ action: "create", title: "x", message: "y", delay_minutes: 5 }, undefined, { taskId })),
    ).toBe(OLD);
    // 实例被注销（stop / 换 agent 清掉 handler）后，原来的 token 也失效
    setChatTaskActionHandler(taskId, null);
    expect(getExpectedCallerToken(taskId)).toBeNull();
    expect(await run(taskId, { action: "create", title: "x", message: "y", delay_minutes: 5 })).toBe(OLD);
    expect(await readSchedules(taskId)).toEqual([]);
  });

  it("token 对得上的当前实例照常能建 / 列 / 取消（校验不是一刀切拒绝）", async () => {
    const taskId = await freshTask();
    expect(await run(taskId, { action: "create", title: "x", message: "y", delay_minutes: 5 })).toContain("[SCHEDULED");
    expect(await run(taskId, { action: "list" })).toContain("x");
    const [rec] = await readSchedules(taskId);
    expect(await run(taskId, { action: "cancel", id: rec!.id })).toContain("[CANCELLED");
  });

  it("没有 taskId 仍是「定时不可用」（校验排在它后面，文案不被盖掉）", async () => {
    expect(await run(undefined, { action: "list" })).toContain("定时不可用");
  });
});

describe("handler：创建的前置拦截与健壮性（review 修复）", () => {
  it("会话已归档 → 创建失败、不落盘、不写事件（归档的 chat 后台可能还有 AI 在跑，不能再给它建必然送不进去的定时）", async () => {
    const taskId = await freshTask();
    metaOverride.value = { id: taskId, archived: true, mode: "chat" };
    const out = await run(taskId, { action: "create", title: "x", message: "y", every_minutes: 5 });
    expect(out).toContain("创建失败");
    expect(out).toContain("已归档");
    expect(await readSchedules(taskId)).toEqual([]);
    expect(published).toHaveLength(0);
  });

  it("任务已合入 / 已放弃 → 创建失败，文案点明是哪种终态", async () => {
    const taskId = await freshTask();
    metaOverride.value = { id: taskId, repoStatus: "merged", mode: "task" };
    expect(await run(taskId, { action: "create", title: "x", message: "y", delay_minutes: 5 })).toContain("已合入");
    metaOverride.value = { id: taskId, repoStatus: "abandoned", mode: "task" };
    expect(await run(taskId, { action: "create", title: "x", message: "y", delay_minutes: 5 })).toContain("已放弃");
    expect(await readSchedules(taskId)).toEqual([]);
  });

  it("进行中的会话照常能建（拦截只针对归档 / 终态）", async () => {
    const taskId = await freshTask();
    metaOverride.value = { id: taskId, archived: false, repoStatus: "developing", mode: "chat" };
    expect(await run(taskId, { action: "create", title: "x", message: "y", delay_minutes: 5 })).toContain("[SCHEDULED");
  });

  it("提示事件写失败：定时已落盘，模型看到的仍是创建成功（否则它会重试 → 重复创建）", async () => {
    const taskId = await freshTask();
    (taskStreamMod.writeEventAndPublish as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("磁盘满了"),
    );
    const out = await run(taskId, { action: "create", title: "x", message: "y", delay_minutes: 5 });
    expect(out).toContain("[SCHEDULED");
    expect(out).not.toContain("创建失败");
    expect(await readSchedules(taskId)).toHaveLength(1);
  });

  it("取消时提示事件写失败：同样仍报取消成功", async () => {
    const taskId = await freshTask();
    await run(taskId, { action: "create", title: "x", message: "y", delay_minutes: 5 });
    const [rec] = await readSchedules(taskId);
    (taskStreamMod.writeEventAndPublish as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("磁盘满了"),
    );
    const out = await run(taskId, { action: "cancel", id: rec!.id });
    expect(out).toContain("[CANCELLED");
    expect((await readSchedules(taskId))[0]!.status).toBe("cancelled");
  });

  it("回执里的时间带本机时区偏移（模型照着写 at 不会差一个时区）", async () => {
    const taskId = await freshTask();
    const out = await run(taskId, { action: "create", title: "x", message: "y", delay_minutes: 30 });
    expect(out).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}（本机时间）/);
  });

  it("数字参数传成字符串：兼容；at 只写日期：参数错误且给带偏移的示例", async () => {
    const taskId = await freshTask();
    const ok = await run(taskId, { action: "create", title: "x", message: "y", every_minutes: "10", max_runs: "3" });
    expect(ok).toContain("[SCHEDULED");
    expect(await readSchedules(taskId)).toMatchObject([{ kind: "every", intervalMs: 600_000, maxRuns: 3 }]);
    const bad = await run(taskId, { action: "create", title: "x", message: "y", at: "2026-12-01" });
    expect(bad).toContain("参数错误");
    expect(bad).toContain("具体时刻");
  });

  it("描述教模型：at 要带时刻 / 不能只写日期；max_runs 按到点次数计", () => {
    expect(def.description).toContain("不能只写日期");
    expect(def.description).toContain("到点次数");
  });
});
