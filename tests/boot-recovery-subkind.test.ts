/**
 * boot-recovery 的机器标记（meta.subkind="boot-recovery"）端到端：
 * 真跑一遍 boot recovery（临时数据目录、与桌面包数据目录隔离）→ 落盘产物 → 喂给前端判定。
 *
 * 钉三件事：
 *  1) 写入的 error 事件带标记、文案仍是 BOOT_RECOVERY_TEXT 原样、不带 actionId（既有展示 / 既有断言不变）；
 *  2) task 模式被打断的 action：真实落盘数据能让「继续上次 Action」命中，且还原出原参数；
 *  3) chat 的 boot-recovery 路径行为不变（同文案、同标记），但前端不给「继续」入口。
 *
 * task-fs-core 在模块加载时钉死 DATA_DIR，所以每次 resetModules + 先设 env 再 import（同 boot-recovery-test-guard）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

import { planResumeInterruptedAction } from "@/lib/resume-interrupted-action";
import {
  BOOT_RECOVERY_ACTION_WAS_RUNNING_KEY,
  BOOT_RECOVERY_SUBKIND,
  BOOT_RECOVERY_TEXT,
} from "@/lib/stop-copy";

const RECOVERY_FLAG = "__flowshipBootRecoveryPromiseV2__";
const g = globalThis as unknown as Record<string, unknown>;

const root = fs.mkdtempSync(path.join(os.tmpdir(), "flowship-recovery-subkind-"));
const dataDir = path.join(root, "plain", "data");

const seed = (id: string, over: Record<string, unknown>): string => {
  const dir = path.join(dataDir, "tasks", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "meta.json"),
    JSON.stringify({
      id,
      title: id,
      repoStatus: "developing",
      runStatus: "running",
      currentActionId: null,
      actions: [],
      mrs: [],
      repoPaths: [],
      createdAt: 1,
      updatedAt: 1,
      ...over,
    }),
    "utf-8",
  );
  return path.join(dir, "events.jsonl");
};

const loadTaskFs = async () => {
  delete g[RECOVERY_FLAG];
  vi.resetModules();
  const saved = process.env.FLOWSHIP_DATA_DIR;
  process.env.FLOWSHIP_DATA_DIR = dataDir;
  try {
    return await import("@/lib/server/task-fs");
  } finally {
    process.env.FLOWSHIP_DATA_DIR = saved;
  }
};

const readEvents = (file: string) =>
  fs
    .readFileSync(file, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { kind: string; text: string; actionId?: string; meta?: Record<string, unknown> });

afterAll(() => {
  delete g[RECOVERY_FLAG];
  fs.rmSync(root, { recursive: true, force: true });
});

describe("boot-recovery 机器标记 · 端到端", () => {
  it("task 模式 running 被重启打断：error 事件带标记、文案原样；落盘数据让「继续上次 Action」命中并还原原参数", async () => {
    const eventsFile = seed("t_task", {
      mode: "task",
      currentActionId: "act_2",
      actions: [
        {
          id: "act_1",
          n: 1,
          type: "plan",
          status: "completed",
          userInstruction: "先出方案",
          artifactPath: null,
          startedAt: 100,
          endedAt: 200,
        },
        {
          id: "act_2",
          n: 2,
          type: "dev",
          status: "running",
          userInstruction: "联调到 dev 环境",
          artifactPath: null,
          startedAt: 300,
          endedAt: null,
          devPushMode: "mr",
          agentModel: { id: "gpt-5" },
        },
      ],
    });

    const { listTasks, getTask } = await loadTaskFs();
    await listTasks();

    // 1) 事件：标记 + 文案原样 + 不带 actionId（不改变既有展示）
    const events = readEvents(eventsFile);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "error",
      text: BOOT_RECOVERY_TEXT,
      // 翻 error 之前 #2 确实在 running → 标 true（R21-03）
      meta: { subkind: BOOT_RECOVERY_SUBKIND, [BOOT_RECOVERY_ACTION_WAS_RUNNING_KEY]: true },
    });
    expect(events[0]!.actionId).toBeUndefined();

    // 2) 前端判定吃真实落盘产物：被打断的 #2 命中，参数原样还原
    const task = await getTask("t_task");
    expect(task?.runStatus).toBe("error");
    expect(task?.actions.find((a) => a.id === "act_2")?.status).toBe("error");
    const plan = planResumeInterruptedAction(task!);
    expect(plan?.action.id).toBe("act_2");
    expect(plan?.input).toMatchObject({
      actionType: "dev",
      userInstruction: "联调到 dev 环境",
      devPushMode: "mr",
      reuseAgent: false,
      model: { id: "gpt-5" },
    });
    // dev 属对外副作用类 → 必须二次确认
    expect(plan?.confirm).not.toBeNull();
  });

  it("R21-03：已交卷（awaiting_ack）后发一次性问答（runStatus=running）时重启——action 仍按既有语义翻 error，但事件标 false、不给「继续」", async () => {
    // 真实落盘形态：#1 build 已交卷 awaiting_ack；问答期间任务级 runStatus=running（restoreRunStatusAfterQuestion 之前的状态）
    const eventsFile = seed("t_qa", {
      mode: "task",
      currentActionId: "act_1",
      actions: [
        {
          id: "act_1",
          n: 1,
          type: "build",
          status: "awaiting_ack",
          userInstruction: "按 plan 实现登录页",
          artifactPath: null,
          startedAt: 100,
          endedAt: 200,
        },
      ],
    });

    const { listTasks, getTask } = await loadTaskFs();
    await listTasks();

    const events = readEvents(eventsFile);
    expect(events).toHaveLength(1);
    expect(events[0]!.meta).toEqual({
      subkind: BOOT_RECOVERY_SUBKIND,
      [BOOT_RECOVERY_ACTION_WAS_RUNNING_KEY]: false,
    });
    const task = await getTask("t_qa");
    // 既有开机恢复语义不动：runStatus=error、action 也翻 error
    expect(task?.runStatus).toBe("error");
    expect(task?.actions.find((a) => a.id === "act_1")?.status).toBe("error");
    // 但它不是被打断的：前端不提示「继续上次 Action」
    expect(planResumeInterruptedAction(task!)).toBeNull();
  });

  it("chat 的 boot-recovery 路径不变（同文案、同标记），但不给「继续上次 Action」", async () => {
    const eventsFile = seed("t_chat", { mode: "chat" });

    const { listTasks, getTask } = await loadTaskFs();
    await listTasks();

    const events = readEvents(eventsFile);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "error",
      text: BOOT_RECOVERY_TEXT,
      meta: { subkind: BOOT_RECOVERY_SUBKIND },
    });
    const task = await getTask("t_chat");
    expect(task?.runStatus).toBe("error");
    expect(planResumeInterruptedAction(task!)).toBeNull();
  });
});
