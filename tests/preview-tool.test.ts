/**
 * agent 的 `preview` 工具（起 / 看 / 停本任务项目的 dev server）与它背后的 preview-launch。
 *
 * 钉的是「接线与边界」，进程管理本身（进程组 / pidfile / 日志）在 preview-manager 的集成测试里：
 * - 起服务走和 UI 同一套准入（launchTaskPreview）：终态任务 / 不属于本任务的仓 / 没配命令 / 工作区没建，都拒；
 * - agent 起预览**不顶掉别的任务**（UI 的 takeOver 才顶）；
 * - status / stop 只管本任务自己的预览；
 * - start 等「地址 / 退出」、已在跑不重起、地址探活只探回环；
 * - 工具注册、callerToken 校验、一次性 agent 的清单（用户在场有、定时轮没有）。
 *
 * 没有真起 dev server：这里 mock 掉 preview-manager / 设置 / 任务读取；真实 `npm run dev` 的端到端表现不在这里验证。
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { PreviewSlotStatus } from "@/lib/types";

const WORK_DIR = mkdtempSync(path.join(os.tmpdir(), "fe-preview-tool-"));
afterAll(() => rmSync(WORK_DIR, { recursive: true, force: true }));

const REPO_A = "/w/crm-web";
const REPO_B = "/w/crm-api";

const st = vi.hoisted(() => ({
  task: null as null | { id: string; title: string; repoPaths: string[]; repoStatus: string },
  lifecycle: null as string | null,
  command: "npm run dev" as string | null,
  slots: [] as PreviewSlotStatus[],
  startCalls: [] as Array<Record<string, unknown>>,
  stopCalls: [] as string[],
  stopTaskCalls: [] as string[],
  /** stopPreviewIfOwner 的调用记录（agent 带 repo_path 的 stop 走它） */
  ownerStopCalls: [] as Array<{ repoPath: string; taskId: string }>,
  /** 非 null = 下一次 stopPreviewIfOwner 入队后、判归属前先跑一下（模拟前置检查通过后、用户在 UI 把这个仓接管给了别的任务） */
  beforeOwnerStop: null as null | (() => void),
  /** 非 null = 下一次 startPreview 在队列里让位（模拟前置检查通过后、manager 串行队列里才发现被别人占了 / 准入被拒） */
  yieldNext: null as null | { reason: string; occupied?: boolean },
  /** start 之后 slot 的演进：startPreview 之后每次 getPreviewStatus 调用前依次弹一个改动 */
  onPoll: [] as Array<() => void>,
}));

vi.mock("@/lib/server/chat-gate", () => ({ getChatLifecycle: () => st.lifecycle }));
vi.mock("@/lib/server/task-fs", () => ({ getTaskMeta: async () => st.task }));
vi.mock("@/lib/server/settings-fs", () => ({ getRepoPreviewCommand: async () => st.command }));
vi.mock("@/lib/server/task-worktrees", () => ({
  getTaskWorkRepoPaths: (t: { repoPaths: string[] }) => t.repoPaths.map(() => WORK_DIR),
}));
vi.mock("@/lib/server/preview-manager", () => ({
  getPreviewStatus: () => {
    // 只在 startPreview 之后才演进（start 前的占用检查 / 已在跑检查也会读状态，不能消耗这些脚本）
    if (st.startCalls.length > 0) st.onPoll.shift()?.();
    return st.slots.map((s) => ({ ...s }));
  },
  previewOccupiedReason: (title: string) => `这个仓的预览正被任务「${title}」占用（同一个仓同时只能跑一个预览）`,
  startPreview: async (input: Record<string, unknown>) => {
    st.startCalls.push(input);
    if (st.yieldNext) {
      const y = st.yieldNext;
      st.yieldNext = null;
      return {
        replacedTaskTitle: null,
        status: {
          taskId: input.taskId as string,
          taskTitle: input.taskTitle as string,
          repoPath: input.repoPath as string,
          workDir: input.workDir as string,
          command: input.command as string,
          startedAt: Date.now(),
          url: null,
          exited: true,
          exitCode: null,
          logTail: [y.reason],
        },
        yielded: true,
        yieldReason: y.reason,
        ...(y.occupied ? { occupied: true } : {}),
      };
    }
    const replaced = st.slots.find((s) => s.repoPath === input.repoPath && !s.exited);
    st.slots = st.slots.filter((s) => s.repoPath !== input.repoPath);
    const slot: PreviewSlotStatus = {
      taskId: input.taskId as string,
      taskTitle: input.taskTitle as string,
      repoPath: input.repoPath as string,
      workDir: input.workDir as string,
      command: input.command as string,
      startedAt: Date.now(),
      url: null,
      exited: false,
      exitCode: null,
      logTail: [],
    };
    st.slots.push(slot);
    return { replacedTaskTitle: replaced && replaced.taskId !== input.taskId ? replaced.taskTitle : null, status: { ...slot } };
  },
  stopPreview: async (repoPath: string) => {
    st.stopCalls.push(repoPath);
    st.slots = st.slots.filter((s) => s.repoPath !== repoPath);
  },
  stopPreviewIfOwner: async (repoPath: string, taskId: string) => {
    st.ownerStopCalls.push({ repoPath, taskId });
    const hook = st.beforeOwnerStop;
    st.beforeOwnerStop = null;
    hook?.();
    // 与真实现同语义：归属在「队列里」判；不是本任务的 / 没有 → 什么都不动
    const slot = st.slots.find((s) => s.repoPath === repoPath);
    if (!slot || slot.taskId !== taskId) return false;
    st.slots = st.slots.filter((s) => s.repoPath !== repoPath);
    return true;
  },
  stopPreviewsForTask: async (taskId: string) => {
    st.stopTaskCalls.push(taskId);
    st.slots = st.slots.filter((s) => s.taskId !== taskId);
  },
}));

const { dispatchPreviewTool, launchTaskPreview, probePreviewUrl } = await import("@/lib/server/preview-launch");

const TASK_ID = "t_me";
const slotOf = (over: Partial<PreviewSlotStatus> = {}): PreviewSlotStatus => ({
  taskId: TASK_ID,
  taskTitle: "我的任务",
  repoPath: REPO_A,
  workDir: WORK_DIR,
  command: "npm run dev",
  startedAt: Date.now() - 5000,
  url: null,
  exited: false,
  exitCode: null,
  logTail: [],
  ...over,
});
const reachable = async () => ({ reachable: true, httpStatus: 200 });
const unreachable = async () => ({ reachable: false, httpStatus: null });

beforeEach(() => {
  st.task = { id: TASK_ID, title: "我的任务", repoPaths: [REPO_A], repoStatus: "developing" };
  st.lifecycle = null;
  st.command = "npm run dev";
  st.slots = [];
  st.startCalls = [];
  st.stopCalls = [];
  st.stopTaskCalls = [];
  st.ownerStopCalls = [];
  st.beforeOwnerStop = null;
  st.yieldNext = null;
  st.onPoll = [];
});

describe("launchTaskPreview：与 UI 同一套准入", () => {
  it("任务不存在 / 终态 / 正在停止 / 仓不属于本任务 / 没配命令 / 工作区没建：全部拒绝且没起进程", async () => {
    st.task = null;
    expect(await launchTaskPreview({ taskId: TASK_ID, repoPath: REPO_A, takeOver: true })).toMatchObject({ ok: false, status: 404 });

    st.task = { id: TASK_ID, title: "t", repoPaths: [REPO_A], repoStatus: "merged" };
    expect(await launchTaskPreview({ taskId: TASK_ID, repoPath: REPO_A, takeOver: true })).toMatchObject({ ok: false, status: 409 });
    st.task.repoStatus = "developing";

    st.lifecycle = "stopping";
    expect(await launchTaskPreview({ taskId: TASK_ID, repoPath: REPO_A, takeOver: true })).toMatchObject({ ok: false, status: 409 });
    st.lifecycle = null;

    const other = await launchTaskPreview({ taskId: TASK_ID, repoPath: "/w/other", takeOver: true });
    expect(other).toMatchObject({ ok: false, status: 400 });

    st.command = null;
    const noCmd = await launchTaskPreview({ taskId: TASK_ID, repoPath: REPO_A, takeOver: true });
    expect(noCmd).toMatchObject({ ok: false, status: 409 });
    expect(!noCmd.ok && noCmd.error).toContain("未配置预览启动命令");

    expect(st.startCalls).toEqual([]);
  });

  it("命令只取设置页的那条、工作目录由服务端按任务算：startPreview 收到的就是它们", async () => {
    st.command = "pnpm dev --port 5190";
    const r = await launchTaskPreview({ taskId: TASK_ID, repoPath: REPO_A, takeOver: true });
    expect(r.ok).toBe(true);
    expect(st.startCalls).toEqual([
      { taskId: TASK_ID, taskTitle: "我的任务", repoPath: REPO_A, workDir: WORK_DIR, command: "pnpm dev --port 5190", takeOver: true },
    ]);
  });

  it("takeOver=true（UI）：同仓被别的任务占着就顶掉，并带回被顶任务的名字", async () => {
    st.slots = [slotOf({ taskId: "t_other", taskTitle: "别人的任务", url: "http://localhost:5173/" })];
    const r = await launchTaskPreview({ taskId: TASK_ID, repoPath: REPO_A, takeOver: true });
    expect(r).toMatchObject({ ok: true, replacedTaskTitle: "别人的任务" });
  });

  it("takeOver=false（agent）：同仓被别的任务占着就拒绝、点名占用者、不起进程；对方的位已退出则照常起", async () => {
    st.slots = [slotOf({ taskId: "t_other", taskTitle: "别人的任务", url: "http://localhost:5173/" })];
    const r = await launchTaskPreview({ taskId: TASK_ID, repoPath: REPO_A, takeOver: false });
    expect(r).toMatchObject({ ok: false, status: 409 });
    expect(!r.ok && r.error).toContain("别人的任务");
    expect(!r.ok && r.error).toContain("不要顶掉它");
    expect(st.startCalls).toEqual([]);

    st.slots = [slotOf({ taskId: "t_other", taskTitle: "别人的任务", exited: true, exitCode: 1 })];
    expect((await launchTaskPreview({ taskId: TASK_ID, repoPath: REPO_A, takeOver: false })).ok).toBe(true);
  });

  it("takeOver 原样交给 startPreview：UI = true（顶人）、agent = false（队列内再判一次不顶人）", async () => {
    await launchTaskPreview({ taskId: TASK_ID, repoPath: REPO_A, takeOver: true });
    await launchTaskPreview({ taskId: TASK_ID, repoPath: REPO_A, takeOver: false });
    expect(st.startCalls.map((c) => c.takeOver)).toEqual([true, false]);
  });

  it("竞态：前置检查时没人占、进队列后被别的任务抢先占了（manager 让位）→ 同样 409、带「不要顶掉它」话术、没有 slot 被改", async () => {
    st.yieldNext = { reason: "这个仓的预览正被任务「抢先的任务」占用（同一个仓同时只能跑一个预览）", occupied: true };
    const r = await launchTaskPreview({ taskId: TASK_ID, repoPath: REPO_A, takeOver: false });
    expect(r).toMatchObject({ ok: false, status: 409 });
    expect(!r.ok && r.error).toContain("抢先的任务");
    expect(!r.ok && r.error).toContain("不要顶掉它");
    expect(st.slots).toEqual([]);
  });

  it("manager 让位的别的原因（任务已终结 / 正在停止）：原样转出、不套「别顶人」话术", async () => {
    st.yieldNext = { reason: "任务已终结或正在停止、不能起预览" };
    const r = await launchTaskPreview({ taskId: TASK_ID, repoPath: REPO_A, takeOver: false });
    expect(r).toMatchObject({ ok: false, status: 409, error: "任务已终结或正在停止、不能起预览" });
  });

  it("agent 的 start 工具遇到队列内让位：回 ok:false + 占用者名字，不当成自己起成功", async () => {
    st.yieldNext = { reason: "这个仓的预览正被任务「抢先的任务」占用（同一个仓同时只能跑一个预览）", occupied: true };
    const r = await dispatchPreviewTool({ taskId: TASK_ID, action: "start" }, { waitMs: 0, probe: reachable });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("抢先的任务");
  });
});

describe("preview 工具 · start", () => {
  it("单仓任务可省略 repo_path；探到地址且连得上 → state=running + url，并提示用浏览器工具打开", async () => {
    st.onPoll = [() => { st.slots[0]!.url = "http://localhost:5173/"; st.slots[0]!.logTail = ["VITE ready"]; }];
    const r = await dispatchPreviewTool({ taskId: TASK_ID, action: "start" }, { waitMs: 5000, probe: reachable });
    expect(r).toMatchObject({ ok: true, started: true, state: "running", url: "http://localhost:5173/", reachable: true, http_status: 200, repo_path: REPO_A });
    expect(String(r.hint)).toContain("browser_navigate");
    expect(r.log_tail).toEqual(["VITE ready"]);
    expect(st.startCalls).toHaveLength(1);
  });

  it("地址打出来了但还连不上（编译中）→ state=starting、reachable=false，不当成 running", async () => {
    st.onPoll = [() => { st.slots[0]!.url = "http://localhost:5173/"; }];
    const r = await dispatchPreviewTool({ taskId: TASK_ID, action: "start" }, { waitMs: 5000, probe: unreachable });
    expect(r).toMatchObject({ ok: true, state: "starting", reachable: false });
    expect(String(r.hint)).toContain("wait");
  });

  it("进程起来就退出（命令配错 / 端口被占）→ state=exited + exit_code + 日志尾巴；日志行数与单行长度都封顶", async () => {
    const long = "x".repeat(500);
    st.onPoll = [
      () => {
        st.slots[0]!.exited = true;
        st.slots[0]!.exitCode = 1;
        st.slots[0]!.logTail = [...Array.from({ length: 50 }, (_, i) => `line ${i}`), long];
      },
    ];
    const r = await dispatchPreviewTool({ taskId: TASK_ID, action: "start" }, { waitMs: 5000, probe: reachable });
    expect(r).toMatchObject({ ok: true, state: "exited", exit_code: 1 });
    const tail = r.log_tail as string[];
    expect(tail).toHaveLength(30);
    expect(tail[tail.length - 1]!.length).toBeLessThanOrEqual(301);
    expect(String(r.hint)).toContain("action=start");
  });

  it("到点还没探到地址：如实返回 starting（不假装好了），并提示用 wait 再 status", async () => {
    const r = await dispatchPreviewTool({ taskId: TASK_ID, action: "start" }, { waitMs: 30, probe: reachable });
    expect(r).toMatchObject({ ok: true, started: true, state: "starting", url: null, reachable: null });
  });

  it("本任务该仓已经在跑：不重起（不再调 startPreview），直接返回现状", async () => {
    st.slots = [slotOf({ url: "http://localhost:5173/" })];
    const r = await dispatchPreviewTool({ taskId: TASK_ID, action: "start" }, { waitMs: 100, probe: reachable });
    expect(r).toMatchObject({ ok: true, already_running: true, state: "running" });
    expect(st.startCalls).toEqual([]);
  });

  it("本任务上一次的预览已退出：start 会重起", async () => {
    st.slots = [slotOf({ exited: true, exitCode: 1 })];
    st.onPoll = [() => {}, () => { st.slots[0]!.url = "http://localhost:5173/"; }];
    const r = await dispatchPreviewTool({ taskId: TASK_ID, action: "start" }, { waitMs: 5000, probe: reachable });
    expect(st.startCalls).toHaveLength(1);
    expect(r).toMatchObject({ ok: true, started: true });
  });

  it("多仓任务不填 repo_path → 失败并列出可选的仓；填了不属于本任务的仓 → 失败", async () => {
    st.task!.repoPaths = [REPO_A, REPO_B];
    const amb = await dispatchPreviewTool({ taskId: TASK_ID, action: "start" }, { probe: reachable });
    expect(amb.ok).toBe(false);
    expect(String(amb.error)).toContain(REPO_A);
    expect(String(amb.error)).toContain(REPO_B);
    const bad = await dispatchPreviewTool({ taskId: TASK_ID, action: "start", repoPath: "/w/else" }, { probe: reachable });
    expect(bad.ok).toBe(false);
    expect(String(bad.error)).toContain("不属于本任务");
    expect(st.startCalls).toEqual([]);
  });

  it("该仓被别的任务占着：失败（不顶掉）、错误原文带占用者；没配命令：失败并原话转出", async () => {
    st.slots = [slotOf({ taskId: "t_other", taskTitle: "别人的任务", url: "http://localhost:5173/" })];
    const occ = await dispatchPreviewTool({ taskId: TASK_ID, action: "start" }, { probe: reachable });
    expect(occ.ok).toBe(false);
    expect(String(occ.error)).toContain("别人的任务");
    expect(st.slots[0]!.taskId).toBe("t_other");

    st.slots = [];
    st.command = null;
    const noCmd = await dispatchPreviewTool({ taskId: TASK_ID, action: "start" }, { probe: reachable });
    expect(noCmd).toMatchObject({ ok: false });
    expect(String(noCmd.error)).toContain("未配置预览启动命令");
  });

  it("等待期间预览位被别的任务顶掉：不把别人的预览当成自己的、如实失败", async () => {
    st.onPoll = [() => { st.slots = [slotOf({ taskId: "t_other", taskTitle: "别人的任务" })]; }];
    const r = await dispatchPreviewTool({ taskId: TASK_ID, action: "start" }, { waitMs: 5000, probe: reachable });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("顶掉");
  });

  it("等待期间任务被停止：立刻收手、不空等满 waitMs", async () => {
    const t0 = Date.now();
    st.onPoll = [() => { st.lifecycle = "stopping"; }];
    const r = await dispatchPreviewTool({ taskId: TASK_ID, action: "start" }, { waitMs: 10_000, probe: reachable });
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(r).toMatchObject({ ok: true, state: "starting" });
  });
});

describe("preview 工具 · status / stop 只管本任务", () => {
  it("status：只列本任务的预览；可按 repo_path 过滤", async () => {
    st.task!.repoPaths = [REPO_A, REPO_B];
    st.slots = [
      slotOf({ repoPath: REPO_A, url: "http://localhost:5173/" }),
      slotOf({ repoPath: REPO_B, url: null }),
      slotOf({ taskId: "t_other", taskTitle: "别人的任务", repoPath: "/w/third", url: "http://localhost:9/" }),
    ];
    const all = await dispatchPreviewTool({ taskId: TASK_ID, action: "status" }, { probe: reachable });
    expect((all.previews as Array<{ repo_path: string }>).map((p) => p.repo_path).sort()).toEqual([REPO_A, REPO_B].sort());
    const one = await dispatchPreviewTool({ taskId: TASK_ID, action: "status", repoPath: REPO_B }, { probe: reachable });
    expect(one.previews as unknown[]).toHaveLength(1);
    expect((one.previews as Array<{ state: string }>)[0]!.state).toBe("starting");
  });

  it("status：本任务没有预览时返回空列表，并说明哪些仓被别的任务占着（别的任务的详情不外露）", async () => {
    st.slots = [slotOf({ taskId: "t_other", taskTitle: "别人的任务", url: "http://localhost:5173/", logTail: ["secret log"] })];
    const r = await dispatchPreviewTool({ taskId: TASK_ID, action: "status" }, { probe: reachable });
    expect(r).toMatchObject({ ok: true, previews: [], occupied_by_other_tasks: [{ repo_path: REPO_A, task_title: "别人的任务" }] });
    expect(JSON.stringify(r)).not.toContain("secret log");
    expect(JSON.stringify(r)).not.toContain("5173");
  });

  it("stop：不带 repo_path = 停本任务全部（走 stopPreviewsForTask）；幂等", async () => {
    st.slots = [slotOf()];
    const r = await dispatchPreviewTool({ taskId: TASK_ID, action: "stop" }, { probe: reachable });
    expect(r).toMatchObject({ ok: true, stopped: [REPO_A] });
    expect(st.stopTaskCalls).toEqual([TASK_ID]);
    const again = await dispatchPreviewTool({ taskId: TASK_ID, action: "stop" }, { probe: reachable });
    expect(again).toMatchObject({ ok: true, stopped: [] });
  });

  it("stop：不能停别的任务的预览（点名占用者、没碰进程）；停自己的仓只停那一个", async () => {
    st.slots = [slotOf({ taskId: "t_other", taskTitle: "别人的任务" })];
    const r = await dispatchPreviewTool({ taskId: TASK_ID, action: "stop", repoPath: REPO_A }, { probe: reachable });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("别人的任务");
    expect(st.stopCalls).toEqual([]);
    expect(st.ownerStopCalls).toEqual([]); // 前置检查就拒了、没进 manager
    expect(st.slots).toHaveLength(1);

    st.slots = [slotOf()];
    const mine = await dispatchPreviewTool({ taskId: TASK_ID, action: "stop", repoPath: REPO_A }, { probe: reachable });
    expect(mine).toMatchObject({ ok: true, stopped: [REPO_A] });
    // 带 repo_path 的 stop 走「按归属停」：把自己的 taskId 一起交给 manager，由它在队列里核对
    expect(st.ownerStopCalls).toEqual([{ repoPath: REPO_A, taskId: TASK_ID }]);
    expect(st.stopCalls).toEqual([]); // 不再按仓直接停
    expect(st.slots).toEqual([]);
  });

  it("stop 竞态：前置检查时是本任务的、真正停之前用户在 UI 把这个仓接管给了别的任务 → 不杀别人刚起的预览", async () => {
    st.slots = [slotOf()];
    st.beforeOwnerStop = () => {
      st.slots = [slotOf({ taskId: "t_other", taskTitle: "刚接管的任务" })];
    };
    const r = await dispatchPreviewTool({ taskId: TASK_ID, action: "stop", repoPath: REPO_A }, { probe: reachable });
    expect(r.ok).toBe(true); // 对 agent 来说「我的那个已经不在了」= 目的达到，不报错
    expect(st.ownerStopCalls).toEqual([{ repoPath: REPO_A, taskId: TASK_ID }]);
    expect(st.slots).toHaveLength(1);
    expect(st.slots[0]).toMatchObject({ taskId: "t_other", exited: false });
  });

  it("未知 action / 任务不存在 → ok:false", async () => {
    expect(await dispatchPreviewTool({ taskId: TASK_ID, action: "restart" }, { probe: reachable })).toMatchObject({ ok: false });
    st.task = null;
    expect(await dispatchPreviewTool({ taskId: TASK_ID, action: "status" }, { probe: reachable })).toMatchObject({ ok: false });
  });
});

describe("地址探活只探本机回环", () => {
  it("非 localhost / 127.0.0.1 的地址一律不请求、返回 null（地址来自 dev server 输出，不能让 server 去请求别处）", async () => {
    const f = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
    try {
      expect(await probePreviewUrl("http://169.254.169.254:80/")).toBeNull();
      expect(await probePreviewUrl("http://example.com:3000/")).toBeNull();
      expect(await probePreviewUrl("not a url")).toBeNull();
      expect(f).not.toHaveBeenCalled();
      expect(await probePreviewUrl("http://localhost:5173/")).toEqual({ reachable: true, httpStatus: 200 });
      expect(f).toHaveBeenCalledTimes(1);
      // 不跟随重定向
      expect(f.mock.calls[0]![1]).toMatchObject({ redirect: "manual", method: "GET" });
    } finally {
      f.mockRestore();
    }
  });

  it("连不上 → reachable:false（不抛）；任何 HTTP 状态码都算连得上", async () => {
    const f = vi.spyOn(globalThis, "fetch");
    try {
      f.mockRejectedValueOnce(new Error("ECONNREFUSED"));
      expect(await probePreviewUrl("http://127.0.0.1:5173/")).toEqual({ reachable: false, httpStatus: null });
      f.mockResolvedValueOnce(new Response(null, { status: 500 }));
      expect(await probePreviewUrl("http://127.0.0.1:5173/")).toEqual({ reachable: true, httpStatus: 500 });
    } finally {
      f.mockRestore();
    }
  });
});
