/**
 * R27 接线波定向测试（第二十七轮·lease 压进循环与资源函数内部）
 *
 * 七组：R27-1 rename retry 换主拒提交 / R27-2 ensure 内 lease 失效让位 + add 后补偿 /
 * R27-3 resume reject 不清 B 锚点 / R27-4 历史 action submit_mr 拒 /
 * R27-5 同 caller 双 ask 不分裂 / R27-6 chat 假 lease 事件被拦 / R27-7 ENOENT 不 publish。
 *
 * 不动 ownership-r27-matrix（另一代理维护）。
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type { TaskMetaV06 } from "@/lib/server/task-fs-core";
import type { Task } from "@/lib/types";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-ownership-r27-wiring-"));
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");

const mockCreate = vi.fn();
const mockResume = vi.fn();
vi.mock("@cursor/sdk", () => ({
  Agent: {
    create: (...args: unknown[]) => mockCreate(...args),
    resume: (...args: unknown[]) => mockResume(...args),
  },
}));

const mockCreateMR = vi.fn();
vi.mock("@/lib/server/gitlab-client", () => ({
  createMR: (...args: unknown[]) => mockCreateMR(...args),
  getMRMergeStatus: vi.fn(),
  closeOpenMR: vi.fn(),
}));

vi.mock("@/lib/server/mcp-oauth", () => ({
  enrichMcpServersWithOAuth: async <T,>(servers: T) => servers,
}));
vi.mock("@/lib/server/mcp-probe", () => ({
  filterHealthyMcp: async (servers: Record<string, unknown>) => ({
    servers,
    dropped: [],
  }),
  invalidateMcpProbeCache: () => {},
}));
vi.mock("@/lib/server/skills-loader", () => ({
  loadSkills: async () => [],
  renderSkillsForPrompt: () => "",
}));
vi.mock("@/lib/server/kill-orphans", () => ({
  reapTaskOrphans: vi.fn(),
}));
vi.mock("@/lib/server/meegle-cli", () => ({
  resolveUserIdentityForPrompt: async () => "",
}));
vi.mock("@/lib/server/action-checks", () => ({
  runActionCheck: vi.fn(async () => ({ passed: true, details: "ok" })),
  captureActionStartBaseline: vi.fn(async () => null),
  captureReadonlyRepoBaselines: vi.fn(async () => null),
}));

const taskFsCore = await import("@/lib/server/task-fs-core");
const {
  appendEventLine,
  prepareMetaWrite,
  readEvents,
  readMetaV06,
  taskDir,
  writeMeta,
} = taskFsCore;
const {
  agentSessions,
  allocTaskRunInstanceId,
  clearTaskStarting,
  runningTasks,
  subscribeTaskStream,
  writeEventAndPublish,
  writeOwnedEventAndPublish,
} = await import("@/lib/server/task-stream");
const { setFailpoint, clearFailpoints } = await import(
  "@/lib/server/failpoints"
);
const {
  cleanupChatTaskState,
  getPendingAsk,
  registerPendingAsk,
  setChatAwaitingNotifier,
  setChatTaskActionHandler,
} = await import("@/lib/server/chat-pending");
const { clearChatGate } = await import("@/lib/server/chat-gate");
const { buildSessionBridges, resumeTaskSession } = await import(
  "@/lib/server/task-runner"
);
const {
  clearTaskSessionAgentIdIf,
  getTask,
  listTasks,
  setFeishuTesterUserKeys,
} = await import("@/lib/server/task-fs");
const { RenameAbortedError, renameWithRetry } = await import(
  "@/lib/server/data-root"
);
const { ensureTaskWorktrees, WorktreeLeaseLostError } = await import(
  "@/lib/server/task-worktrees"
);
const { validateSubmitMr } = await import("@/lib/server/submit-mr-guard");
const { handleSdkMessage } = await import("@/lib/server/sdk-message-handler");

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(
    `ownership-r27-wiring DATA_DIR 未隔离到 TMP：${taskDir("probe")}`,
  );
}

await listTasks();

const CREDS = {
  apiKey: "k",
  model: { id: "m", params: [] as never[] },
  fallbackModel: { id: "m", params: [] as never[] },
};

afterAll(() => {
  try {
    rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch {
    /* noop */
  }
});

const makeMeta = (id: string): TaskMetaV06 =>
  ({
    id,
    title: `ownership-r27-wiring ${id}`,
    mode: "task",
    repoStatus: "developing",
    runStatus: "running",
    currentActionId: "act_a",
    actions: [
      {
        id: "act_a",
        n: 1,
        type: "plan",
        status: "running",
        userInstruction: "",
        artifactPath: "actions/1-plan.md",
        startedAt: Date.now(),
        endedAt: null,
      },
    ],
    mrs: [],
    repoPaths: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }) as unknown as TaskMetaV06;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const raceExpectSettled = async <T,>(p: Promise<T>, ms: number): Promise<T> => {
  const result = await Promise.race([
    p,
    sleep(ms).then(() => {
      throw new Error(`Promise 未在 ${ms}ms 内 settle`);
    }),
  ]);
  return result as T;
};

const installHangingFailpoint = (name: string) => {
  let hitResolve!: () => void;
  const hit = new Promise<void>((r) => {
    hitResolve = r;
  });
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  setFailpoint(name, async () => {
    hitResolve();
    await gate;
  });
  return { waitHit: () => hit, release: () => release() };
};

/** R27-2 用：初始化一个带一次 commit 的真实 git 仓（main 分支） */
const initGitRepo = (dir: string): void => {
  execFileSync("git", ["init", "-b", "main", dir]);
  execFileSync("git", ["-C", dir, "config", "user.email", "r27@test"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "r27"]);
  writeFileSync(path.join(dir, "a.txt"), "hi");
  execFileSync("git", ["-C", dir, "add", "."]);
  execFileSync("git", ["-C", dir, "commit", "-m", "init"]);
};

describe("ownership R27 wiring", () => {
  const ids: string[] = [];
  const alloc = (): string => {
    const id = `t_r27w_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    ids.push(id);
    return id;
  };

  beforeEach(() => {
    mockCreate.mockReset();
    mockResume.mockReset();
    mockCreateMR.mockReset();
    clearFailpoints();
  });

  afterEach(() => {
    clearFailpoints();
    for (const id of ids.splice(0)) {
      agentSessions.delete(id);
      runningTasks.delete(id);
      clearTaskStarting(id);
      clearChatGate(id);
      cleanupChatTaskState(id);
      try {
        rmSync(taskDir(id), { recursive: true, force: true });
      } catch {
        /* noop */
      }
    }
  });

  // ─────────────────────────────────────────────────────────────
  // R27-1：lease 进 rename retry 循环
  // ─────────────────────────────────────────────────────────────
  it("R27-1 renameWithRetry：beforeAttempt false → 抛 RenameAbortedError、不 rename", async () => {
    const dir = mkdtempSync(path.join(TMP_ROOT, "r27-rename-"));
    const tmp = path.join(dir, "x.tmp");
    const dst = path.join(dir, "x.json");
    writeFileSync(tmp, "payload");
    await expect(
      renameWithRetry(tmp, dst, () => false),
    ).rejects.toBeInstanceOf(RenameAbortedError);
    // 失败的授权不消费：目标未产生
    expect(existsSync(dst)).toBe(false);
  });

  it("R27-1 commit(finalGuard)：rename.beforeAttempt 窗口换主 → 拒提交、盘上不变", async () => {
    const id = alloc();
    const meta = makeMeta(id);
    await writeMeta(meta);

    // 篡改一个字段准备提交
    const dirty = { ...meta, runStatus: "idle" } as TaskMetaV06;
    const prepared = await prepareMetaWrite(dirty);

    let owner = true;
    const hang = installHangingFailpoint("rename.beforeAttempt");
    const p = prepared.commit(() => owner);
    await hang.waitHit();
    // 权威窗口：已进入 retry 循环、fs.rename 尚未发起——此刻换主
    owner = false;
    hang.release();
    const committed = await raceExpectSettled(p, 5000);
    expect(committed).toBe(false);
    const disk = await readMetaV06(id);
    expect(disk?.runStatus).toBe("running");
  });

  // ─────────────────────────────────────────────────────────────
  // R27-2：resource lease 进 ensureTaskWorktrees 内部
  // ─────────────────────────────────────────────────────────────
  it(
    "R27-2 ensure：ensure.beforeWorktreeAdd 窗口 lease 失效 → 让位、不创建 worktree",
    async () => {
      const id = alloc();
      const repo = mkdtempSync(path.join(TMP_ROOT, "r27-repo-"));
      initGitRepo(repo);
      const task = {
        id,
        mode: "task",
        isolateWorktree: true,
        repoPaths: [repo],
        gitBranches: [
          { repoPath: repo, name: "feat/r27-before", baseBranch: "main" },
        ],
        repoBaseBranches: { [repo]: "main" },
        actions: [],
        mrs: [],
      } as unknown as Task;

      let leaseOk = true;
      // 与矩阵同名：ensure.beforeWorktreeAdd（新建路径入口，add 前）
      const hang = installHangingFailpoint("ensure.beforeWorktreeAdd");
      // R28-1：lease 必填函数形参；让位抛 WorktreeLeaseLostError（不吞）
      const p = ensureTaskWorktrees(task, () => leaseOk);
      await hang.waitHit();
      // add 尚未发起——此刻 finalize 接管
      leaseOk = false;
      hang.release();
      await expect(raceExpectSettled(p, 20_000)).rejects.toBeInstanceOf(
        WorktreeLeaseLostError,
      );
      // worktree 未创建
      const list = execFileSync("git", ["-C", repo, "worktree", "list"], {
        encoding: "utf-8",
      });
      expect(list.includes(id)).toBe(false);
    },
    25_000,
  );

  it(
    "R27-2 ensure：add 成功后 lease 失效 → 补偿移除本轮 worktree、createdRepos 空",
    async () => {
      const id = alloc();
      const repo = mkdtempSync(path.join(TMP_ROOT, "r27-repo-"));
      initGitRepo(repo);
      const task = {
        id,
        mode: "task",
        isolateWorktree: true,
        repoPaths: [repo],
        gitBranches: [
          { repoPath: repo, name: "feat/r27-after", baseBranch: "main" },
        ],
        repoBaseBranches: { [repo]: "main" },
        actions: [],
        mrs: [],
      } as unknown as Task;

      let leaseOk = true;
      const hang = installHangingFailpoint("worktree.afterAdd");
      // R28-1：lease 必填；add 后失主抛错 + 补偿移除
      const p = ensureTaskWorktrees(task, () => leaseOk);
      await hang.waitHit();
      // add 已成功、复验前失主——补偿必须移除刚创建的 worktree
      leaseOk = false;
      hang.release();
      await expect(raceExpectSettled(p, 20_000)).rejects.toBeInstanceOf(
        WorktreeLeaseLostError,
      );
      expect(WorktreeLeaseLostError).toBeTruthy();
      const list = execFileSync("git", ["-C", repo, "worktree", "list"], {
        encoding: "utf-8",
      });
      // 补偿后 git 注册里不再有本 task 的 worktree（merged/abandoned 不留物理工作区）
      expect(list.includes(id)).toBe(false);
    },
    30_000,
  );

  // ─────────────────────────────────────────────────────────────
  // R27-3：resume reject 的锚点条件清
  // ─────────────────────────────────────────────────────────────
  it("R27-3 clearTaskSessionAgentIdIf：expected 不匹配 / extraGuard false 不清、全符合才清", async () => {
    const id = alloc();
    const meta = makeMeta(id);
    (meta as { sessionAgentId?: string }).sessionAgentId = "agent_A";
    await writeMeta(meta);

    // extraGuard false → 不清
    expect(await clearTaskSessionAgentIdIf(id, "agent_A", () => false)).toBe(
      false,
    );
    expect((await readMetaV06(id))?.sessionAgentId).toBe("agent_A");

    // 盘上已被 B 改写 → expected 不匹配不清（B 的锚点保留）
    const metaB = (await readMetaV06(id))!;
    metaB.sessionAgentId = "agent_B";
    await writeMeta(metaB);
    expect(await clearTaskSessionAgentIdIf(id, "agent_A")).toBe(false);
    expect((await readMetaV06(id))?.sessionAgentId).toBe("agent_B");

    // 全符合 → 清
    expect(await clearTaskSessionAgentIdIf(id, "agent_B")).toBe(true);
    expect((await readMetaV06(id))?.sessionAgentId).toBeUndefined();
  });

  it("R27-3 resume reject：B 已装内存 session → 确定性失败不清盘上锚点", async () => {
    const id = alloc();
    const meta = makeMeta(id);
    meta.runStatus = "idle";
    (meta as { sessionAgentId?: string }).sessionAgentId = "agent_persisted";
    await writeMeta(meta);
    const task = (await getTask(id))!;

    // Agent.resume 可控 reject：先挂起、B 装 session 后再确定性 reject
    let rejectResume!: (err: Error) => void;
    mockResume.mockImplementation(
      () =>
        new Promise((_, rej) => {
          rejectResume = rej;
        }),
    );

    const pResume = resumeTaskSession(task, CREDS);
    // 等 Agent.resume 真被调
    const deadline = Date.now() + 5000;
    while (mockResume.mock.calls.length === 0 && Date.now() < deadline) {
      await sleep(20);
    }
    expect(mockResume).toHaveBeenCalled();

    // B 接管：装内存 session + 把 B 的 agentId 落盘
    agentSessions.set(id, {
      instanceId: allocTaskRunInstanceId(),
      agent: { agentId: "agent_persisted", send: vi.fn(), close: vi.fn() },
      agentId: "agent_persisted",
      callerToken: "cb",
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      startSnapshot: { title: meta.title },
    } as never);

    // A 确定性 reject（非网络类）——catch 的 conditional clear 因 B 已装 session 不清
    rejectResume(new Error("unauthorized: api key invalid"));
    const rec = await raceExpectSettled(pResume, 5000);
    expect(rec).toBeNull();
    await sleep(80);
    expect((await readMetaV06(id))?.sessionAgentId).toBe("agent_persisted");
  });

  // ─────────────────────────────────────────────────────────────
  // R27-4：action lease——历史 action 的 submit_mr / set_feishu_testers 拒
  // ─────────────────────────────────────────────────────────────
  it("R27-4 validateSubmitMr：历史 ship action（非 current+running）拒", async () => {
    const id = alloc();
    const repo = mkdtempSync(path.join(TMP_ROOT, "r27-submit-"));
    execFileSync("git", ["init", repo]);
    execFileSync(
      "git",
      ["-C", repo, "remote", "add", "origin", "git@git.corp.com:group/proj.git"],
    );
    const meta = makeMeta(id);
    meta.repoPaths = [repo];
    meta.currentActionId = "act_b";
    meta.actions = [
      {
        id: "act_a",
        n: 1,
        type: "ship",
        status: "completed",
        userInstruction: "",
        artifactPath: "actions/1-ship.md",
        startedAt: Date.now(),
        endedAt: Date.now(),
      },
      {
        id: "act_b",
        n: 2,
        type: "ship",
        status: "running",
        userInstruction: "",
        artifactPath: "actions/2-ship.md",
        startedAt: Date.now(),
        endedAt: null,
      },
    ] as TaskMetaV06["actions"];
    (meta as { gitBranches?: unknown }).gitBranches = [
      { repoPath: repo, name: "feat/r27", baseBranch: "main" },
    ];
    await writeMeta(meta);
    const task = (await getTask(id))!;

    const mr = {
      kind: "submit_mr" as const,
      repoPath: repo,
      actionId: "act_a", // 历史 action
      projectPath: "group/proj",
      sourceBranch: "feat/r27",
      targetBranch: "test",
      title: "t",
      description: "d",
      lastCommitHash: "abc",
    };
    const historic = await validateSubmitMr(task, mr as never);
    expect(historic.ok).toBe(false);
    if (!historic.ok) {
      expect(historic.error).toContain("已结束");
    }
    // 当前 running action 仍放行（同参数、只换 actionId）
    const current = await validateSubmitMr(
      task,
      { ...mr, actionId: "act_b" } as never,
    );
    expect(current.ok).toBe(true);
  });

  it("R27-4 setFeishuTesterUserKeys：锁内结构条件不符（action 已切换）→ null 不写", async () => {
    const id = alloc();
    const meta = makeMeta(id);
    meta.currentActionId = "act_b";
    meta.actions = [
      {
        id: "act_a",
        n: 1,
        type: "ship",
        status: "completed",
        userInstruction: "",
        artifactPath: null,
        startedAt: Date.now(),
        endedAt: Date.now(),
      },
      {
        id: "act_b",
        n: 2,
        type: "ship",
        status: "running",
        userInstruction: "",
        artifactPath: null,
        startedAt: Date.now(),
        endedAt: null,
      },
    ] as TaskMetaV06["actions"];
    await writeMeta(meta);

    // 历史 act_a：结构条件锁内拒
    const denied = await setFeishuTesterUserKeys(id, ["u1"], () => true, {
      actionId: "act_a",
      types: ["ship"],
    });
    expect(denied).toBeNull();
    expect((await readMetaV06(id))?.feishuTesterUserKeys).toBeUndefined();

    // 类型不符（plan 不在允许集）：拒
    const wrongType = await setFeishuTesterUserKeys(id, ["u1"], () => true, {
      actionId: "act_b",
      types: ["plan"],
    });
    expect(wrongType).toBeNull();

    // current + running + ship：放行
    const ok = await setFeishuTesterUserKeys(id, ["u1"], () => true, {
      actionId: "act_b",
      types: ["ship"],
    });
    expect(ok).not.toBeNull();
    expect((await readMetaV06(id))?.feishuTesterUserKeys).toEqual(["u1"]);
  });

  // ─────────────────────────────────────────────────────────────
  // R27-5：ask lease 含 askId——同 caller 双 ask 不分裂
  // ─────────────────────────────────────────────────────────────
  it("R27-5 同 caller 双 ask：旧 A 恢复时 pending 已是 B → A 不落 ask event、不切 status", async () => {
    const id = alloc();
    const meta = makeMeta(id);
    await writeMeta(meta);
    const task = (await getTask(id))!;
    const callerToken = String(allocTaskRunInstanceId());
    const bridges = buildSessionBridges(task, { callerToken });
    setChatTaskActionHandler(id, bridges.taskActionHandler, callerToken);
    setChatAwaitingNotifier(id, bridges.awaitingNotifier, callerToken);

    // A 先登记
    registerPendingAsk(id, {
      askId: "ask_A",
      questions: [{ question: "QA?" }] as never,
    });
    // A 的 notifier 在 supersede 后挂起
    const hang = installHangingFailpoint("mcp.askUser.afterSupersede");
    // awaitingNotifier 返回类型含 void——统一包成 Promise 供 raceExpectSettled
    const pA = Promise.resolve(
      bridges.awaitingNotifier(
        {
          kind: "ask_user_request",
          askId: "ask_A",
          token: "tok_A",
          questions: [{ question: "QA?" }] as never,
        } as never,
        // 同 caller：callerStillValid 恒真——R26 的 caller lease 拦不住
        { callerStillValid: () => true },
      ),
    );
    await hang.waitHit();

    // 同 caller 的 B 顶掉 pending map（HTTP 重试 / 并发 ask）
    registerPendingAsk(id, {
      askId: "ask_B",
      questions: [{ question: "QB?" }] as never,
    });

    hang.release();
    await raceExpectSettled(pA, 5000);
    await sleep(50);

    // A 的 ask event 不落盘（askId lease 拦）；pending map 仍指向 B、无分裂
    const events = await readEvents(id);
    expect(
      events.filter(
        (e) =>
          e.kind === "ask_user_request" &&
          (e.meta as { askId?: string } | undefined)?.askId === "ask_A",
      ),
    ).toHaveLength(0);
    expect(getPendingAsk(id)?.askId).toBe("ask_B");
  });

  // ─────────────────────────────────────────────────────────────
  // R27-6：owned sink 假 lease 被拦（chat 主消息流语义）
  // ─────────────────────────────────────────────────────────────
  it("R27-6 writeOwnedEventAndPublish：lease false → 不落盘、不 publish、返 null", async () => {
    const id = alloc();
    await writeMeta(makeMeta(id));
    const seen: string[] = [];
    const unsub = subscribeTaskStream(id, (ev) => {
      if (ev.kind === "event") seen.push(String(ev.event.text));
    });
    const wrote = await writeOwnedEventAndPublish(id, () => false, {
      kind: "assistant_message",
      text: "r27-6-stale-chat-flush",
    });
    unsub();
    expect(wrote).toBeNull();
    const events = await readEvents(id);
    expect(events.some((e) => e.text === "r27-6-stale-chat-flush")).toBe(false);
    expect(seen).toHaveLength(0);
  });

  it("R27-6 handleSdkMessage：chat 假 lease（forceClear 后旧 run）→ 主消息流被拦", async () => {
    const id = alloc();
    await writeMeta(makeMeta(id));
    const before = (await readEvents(id)).length;
    // 模拟 chat A 在 forceClear + B 接管后继续 yield：instanceId lease 恒 false
    await handleSdkMessage(
      id,
      { type: "thinking", text: "r27-6 迟到 chat thinking" } as never,
      { buffer: "", flush: async () => {} },
      () => false,
    );
    await handleSdkMessage(
      id,
      {
        type: "tool_call",
        name: "shell",
        call_id: "call_r27_6",
        status: "completed",
        args: { command: "echo x" },
        result: { output: "x" },
      } as never,
      { buffer: "", flush: async () => {} },
      () => false,
    );
    const events = await readEvents(id);
    expect(events.length).toBe(before);
  });

  // ─────────────────────────────────────────────────────────────
  // R27-7：delete 后 append ENOENT 透传、不 publish 幽灵事件
  // ─────────────────────────────────────────────────────────────
  it("R27-7 meta exists → delete → queued append：返 null、无 SSE envelope、目录不复活", async () => {
    const id = alloc();
    await writeMeta(makeMeta(id));
    const seen: string[] = [];
    const unsub = subscribeTaskStream(id, (ev) => {
      if (ev.kind === "event") seen.push(String(ev.event.text));
    });

    // blocker 占住 append chain（meta 存在检查已通过、appendFile 尚未执行）
    const hang = installHangingFailpoint("event.inQueue");
    const pBlocker = appendEventLine(id, {
      id: "ev_r27_blocker",
      ts: Date.now(),
      kind: "info",
      text: "r27-7-blocker",
    } as never);
    await hang.waitHit();

    // 目标事件排到 blocker 后；此刻 B 删除任务目录
    const pGhost = writeEventAndPublish(id, {
      kind: "info",
      text: "r27-7-ghost",
    });
    await sleep(30);
    rmSync(taskDir(id), { recursive: true, force: true });

    hang.release();
    await raceExpectSettled(pBlocker, 5000).catch(() => {});
    const ghost = await raceExpectSettled(pGhost, 5000);
    unsub();

    // R27-7：未写入 → 返 null、不向在线订阅者发幽灵 envelope
    expect(ghost).toBeNull();
    expect(seen.includes("r27-7-ghost")).toBe(false);
    // 目录不复活
    expect(existsSync(taskDir(id))).toBe(false);
  });
});
