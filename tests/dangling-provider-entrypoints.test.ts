/**
 * 悬空提供方（任务绑定的自定义提供方已被删）在「直接取启动参数」的旁路入口也必须拒绝（第四轮 Q2-02）
 *
 * 第三轮只拦了主路径（客户端 prepareRunArgs / 服务端 resolveProviderIdForCreate / chat-runner 起会话）。
 * 旁路入口：「问一问」one-shot（task 模式说话条 / 定时 / 飞书走的服务端落点）、群答疑旁路、标题生成，
 * 之前都用 `resolveProviderIdFromDisk` → 静默落回 Cursor，旧对话的上下文 / 代码被送到 Cursor 云端推理（数据出域）。
 *
 * 本文件全是**真实函数 + 真实 settings 盘（临时 FLOWSHIP_DATA_DIR）+ 假 SDK**：
 *  - 断言 SDK 的 `Agent.create` / `Agent.prompt` 从未被调用；
 *  - 断言用户可见的失败通道（error 事件 / done ok=false / runStatus 归位）里有非空原因；
 *  - 每条都配「提供方还在 → 照常起」的反例对，防止拒绝过头。
 */
import { mkdtempSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "dangling-entrypoints-"));
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");

const mockCreate = vi.fn();
const mockPrompt = vi.fn();
vi.mock("@cursor/sdk", () => ({
  Agent: {
    create: (...a: unknown[]) => mockCreate(...a),
    prompt: (...a: unknown[]) => mockPrompt(...a),
    resume: vi.fn(),
  },
}));
vi.mock("@/lib/server/mcp-oauth", () => ({
  enrichMcpServersWithOAuth: async <T>(s: T) => s,
}));
vi.mock("@/lib/server/mcp-probe", () => ({
  filterHealthyMcp: async (servers: Record<string, unknown>) => ({ servers, dropped: [] }),
  invalidateMcpProbeCache: () => {},
}));
vi.mock("@/lib/server/skills-loader", () => ({
  loadSkills: async () => [],
  loadSkillsForTask: async () => [],
  renderSkillsForPrompt: () => "",
}));
vi.mock("@/lib/server/kill-orphans", () => ({ reapTaskOrphans: vi.fn() }));
vi.mock("@/lib/server/meegle-cli", () => ({ resolveUserIdentityForPrompt: async () => "" }));

const { readEvents, readMetaV06, taskDir, writeMeta } = await import("@/lib/server/task-fs-core");
const ts = await import("@/lib/server/task-stream");
const { startOneShotQuestion } = await import("@/lib/server/task-runner");
const { startRestrictedGroupQuestion } = await import("@/lib/server/restricted-question");
const { maybeGenerateChatTitle } = await import("@/lib/server/chat-title");
const { getTask, setTaskRunStatus } = await import("@/lib/server/task-fs");
const { settingsFilePath } = await import("@/lib/server/settings-fs");
const { DANGLING_TASK_PROVIDER_MESSAGE } = await import("@/lib/agent-provider");
// 真 facade：自定义提供方走 pi 后端、不经 @cursor/sdk 的 mock——反例对（提供方还在 → 照常起）要在 facade 入口观察。
// 悬空用例同时断言 facade 与 SDK 两层都从未被调用
const { Agent: FacadeAgent } = await import("@/lib/server/agent-backend");
const facadeCreate = vi.spyOn(FacadeAgent, "create");
const facadePrompt = vi.spyOn(FacadeAgent, "prompt");

if (!taskDir("probe").startsWith(TMP_ROOT)) throw new Error("DATA_DIR 未隔离到 TMP");

const CURSOR_KEY = "CURSOR-KEY-FAKE-0001";
const OTHER = {
  id: "cp_other",
  name: "other",
  baseUrl: "https://other.example.com/v1",
  apiKey: "k",
  format: "auto",
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const waitUntil = async (pred: () => boolean, ms = 8000) => {
  const dl = Date.now() + ms;
  while (Date.now() < dl) {
    if (pred()) return;
    await sleep(20);
  }
  throw new Error("waitUntil 超时");
};

const writeSettings = async (customProviders: unknown[]) => {
  await fs.mkdir(path.dirname(settingsFilePath()), { recursive: true });
  await fs.writeFile(
    settingsFilePath(),
    JSON.stringify({
      apiKey: CURSOR_KEY,
      defaultModel: { id: "m" },
      repos: [],
      customProviders,
    }),
  );
};

const seedTask = async (
  id: string,
  provider: string | undefined,
  extra: Record<string, unknown> = {},
) => {
  await writeMeta({
    id,
    title: "悬空测试",
    mode: "task",
    repoStatus: "developing",
    runStatus: "awaiting_user",
    currentActionId: "act_1",
    ...(provider ? { provider } : {}),
    actions: [
      {
        id: "act_1",
        n: 1,
        type: "plan",
        status: "awaiting_ack",
        userInstruction: "",
        artifactPath: null,
        startedAt: Date.now(),
        endedAt: Date.now(),
      },
    ],
    mrs: [],
    repoPaths: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...extra,
  } as never);
};

const fakeAgent = (agentId: string) => ({
  agentId,
  close: vi.fn(),
  cancel: vi.fn().mockResolvedValue(undefined),
  wait: vi.fn().mockResolvedValue({ status: "finished" as const }),
  send: vi.fn().mockResolvedValue({
    stream: async function* () {},
    wait: vi.fn().mockResolvedValue({ status: "finished" as const }),
    cancel: vi.fn().mockResolvedValue(undefined),
  }),
});

const ids: string[] = [];
const alloc = () => {
  const id = `t_dp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  ids.push(id);
  return id;
};

const errorTexts = async (id: string): Promise<string[]> =>
  (await readEvents(id))
    .filter((e) => e.kind === "error")
    .map((e) => String((e as { text?: string }).text ?? ""));

beforeEach(() => {
  mockCreate.mockReset();
  mockPrompt.mockReset();
  facadeCreate.mockReset();
  facadePrompt.mockReset();
});
afterAll(async () => {
  await sleep(40);
  for (const id of ids) await fs.rm(taskDir(id), { recursive: true, force: true }).catch(() => {});
  await fs.rm(TMP_ROOT, { recursive: true, force: true }).catch(() => {});
});

describe("夹具自检", () => {
  it("@cursor/sdk 的 mock 生效（Agent.create 走到 mockCreate、不联网）", async () => {
    const sdk = await import("@cursor/sdk");
    mockCreate.mockResolvedValue("probe");
    const r = await (sdk.Agent as unknown as { create: (x: unknown) => Promise<unknown> }).create({
      probe: true,
    });
    expect(r).toBe("probe");
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });
});

describe("startOneShotQuestion（task 模式「问一问」：说话条 / 定时 / 飞书的服务端落点）", () => {
  const runOneShot = async (id: string) => {
    const snapshot = (await getTask(id))!;
    await setTaskRunStatus(id, "running");
    startOneShotQuestion(snapshot, "这个接口啥时候好？", undefined, {
      apiKey: CURSOR_KEY,
      model: { id: "m", params: [] as never[] },
    });
    await waitUntil(() => !ts.isTaskStarting(id));
    await sleep(50);
  };

  it("反例对 A：普通任务（无 provider 字段）照常起 agent（证明夹具能走到 Agent.create）", async () => {
    await writeSettings([]);
    const id = alloc();
    await seedTask(id, undefined);
    facadeCreate.mockResolvedValue(fakeAgent("agent_ctl") as never);
    await runOneShot(id);
    expect(facadeCreate).toHaveBeenCalledTimes(1);
    expect((facadeCreate.mock.calls[0]![0] as { apiKey?: string }).apiKey).toBe(CURSOR_KEY);
  });

  it("反例对 B：绑定的自定义提供方还在 → 照常起 agent（没拒绝过头）", async () => {
    await writeSettings([OTHER]);
    const id = alloc();
    await seedTask(id, "cp_other");
    facadeCreate.mockResolvedValue(fakeAgent("agent_custom") as never);
    await runOneShot(id);
    expect(facadeCreate).toHaveBeenCalledTimes(1);
    expect((facadeCreate.mock.calls[0]![0] as { providerId?: string }).providerId).toBe("cp_other");
    expect(await errorTexts(id)).toEqual([]);
  });

  it("悬空任务（provider=cp_gone）：Agent.create 从未被调用；error 事件写明原因；runStatus 归位、不卡在 running", async () => {
    await writeSettings([OTHER]);
    const id = alloc();
    await seedTask(id, "cp_gone");
    facadeCreate.mockResolvedValue(fakeAgent("agent_dangling") as never);
    const seen: Array<{ kind: string; ok?: boolean }> = [];
    const unsub = ts.subscribeTaskStream(id, (ev) => seen.push(ev as never));
    try {
      await runOneShot(id);
    } finally {
      unsub();
    }
    expect(facadeCreate).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
    const errs = await errorTexts(id);
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.join("\n")).toContain(DANGLING_TASK_PROVIDER_MESSAGE);
    expect((await readMetaV06(id))?.runStatus).toBe("awaiting_user");
    // 调用方（飞书 tap / UI）靠 done(ok=false) 收口
    expect(seen.some((e) => e.kind === "done" && e.ok === false)).toBe(true);
  });

  it("删了重加（旧 id 悬空、同名新条目另有 id）同样拒绝，不偷同名新条目", async () => {
    await writeSettings([{ ...OTHER, id: "cp_new_same_name", name: "内网网关" }]);
    const id = alloc();
    await seedTask(id, "cp_old_deleted");
    facadeCreate.mockResolvedValue(fakeAgent("agent_x") as never);
    await runOneShot(id);
    expect(facadeCreate).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
    expect((await errorTexts(id)).join("\n")).toContain(DANGLING_TASK_PROVIDER_MESSAGE);
  });
});

describe("startRestrictedGroupQuestion（群答疑旁路）", () => {
  const runRestricted = async (id: string) => {
    const task = (await getTask(id))!;
    const seen: Array<{ kind: string; ok?: boolean }> = [];
    const unsub = ts.subscribeTaskStream(id, (ev) => seen.push(ev as never));
    try {
      startRestrictedGroupQuestion({
        task,
        text: "[群消息·来自 同事（非任务所有者）]\n这个接口啥时候好？",
        creds: { apiKey: CURSOR_KEY, model: { id: "m", params: [] as never[] } },
      });
      await waitUntil(() => seen.some((e) => e.kind === "done"));
      await sleep(50);
    } finally {
      unsub();
    }
    return seen;
  };

  it("反例对：提供方还在 → 旁路照常起 agent", async () => {
    await writeSettings([OTHER]);
    const id = alloc();
    await seedTask(id, "cp_other");
    facadeCreate.mockResolvedValue(fakeAgent("agent_rq_ok") as never);
    await runRestricted(id);
    expect(facadeCreate).toHaveBeenCalledTimes(1);
    expect((facadeCreate.mock.calls[0]![0] as { providerId?: string }).providerId).toBe("cp_other");
  });

  it("悬空任务：Agent.create 从未被调用；error 事件写明原因；done(ok=false) 让群里收到「没跑成功」", async () => {
    await writeSettings([OTHER]);
    const id = alloc();
    await seedTask(id, "cp_gone");
    facadeCreate.mockResolvedValue(fakeAgent("agent_rq_dangling") as never);
    const seen = await runRestricted(id);
    expect(facadeCreate).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
    const errs = await errorTexts(id);
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.join("\n")).toContain(DANGLING_TASK_PROVIDER_MESSAGE);
    const done = seen.filter((e) => e.kind === "done");
    expect(done).toHaveLength(1);
    expect(done[0]!.ok).toBe(false);
  });
});

describe("maybeGenerateChatTitle（标题生成）", () => {
  const runTitle = async (id: string) => {
    maybeGenerateChatTitle(id, CURSOR_KEY, "帮我看看这个接口");
    await sleep(300);
  };

  it("反例对：提供方还在 → 照常调 Agent.prompt 生成标题", async () => {
    await writeSettings([OTHER]);
    const id = alloc();
    await seedTask(id, "cp_other", { mode: "chat", titleAutoPending: true });
    facadePrompt.mockResolvedValue({ result: "接口排期" } as never);
    await runTitle(id);
    expect(facadePrompt).toHaveBeenCalledTimes(1);
    expect((facadePrompt.mock.calls[0]![1] as { providerId?: string }).providerId).toBe("cp_other");
  });

  it("悬空对话：Agent.prompt 从未被调用（首条消息不送去 Cursor 云端）", async () => {
    await writeSettings([OTHER]);
    const id = alloc();
    await seedTask(id, "cp_gone", { mode: "chat", titleAutoPending: true });
    facadePrompt.mockResolvedValue({ result: "不该被生成" } as never);
    await runTitle(id);
    expect(facadePrompt).not.toHaveBeenCalled();
    expect(mockPrompt).not.toHaveBeenCalled();
  });
});

describe("契约（补充）：说话条发送前拒悬空提供方（.tsx 无法直接 import，只钉源码接线）", () => {
  it("task-talk-composer.handleSubmit 在加闩锁 / 发请求前先判 isTaskProviderDangling，用 DANGLING_TASK_PROVIDER_MESSAGE 提示", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(
      path.resolve(import.meta.dirname, "..", "src/components/tasks/task-talk-composer.tsx"),
      "utf8",
    );
    const at = src.indexOf("const handleSubmit = async () => {");
    expect(at).toBeGreaterThan(0);
    const body = src.slice(at, src.indexOf("submitLatchRef.current = true;", at));
    expect(body).toMatch(/isSettingsLoaded\(\)\s*&&\s*isTaskProviderDangling\(task,\s*getSettings\(\)\)/);
    expect(body).toContain("DANGLING_TASK_PROVIDER_MESSAGE");
    expect(body).toMatch(/toast\.error\(DANGLING_TASK_PROVIDER_MESSAGE\);\s*return;/);
  });
});
