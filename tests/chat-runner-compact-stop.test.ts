/**
 * compactChatSession 事务级 stop（S3 / 十二轮）
 *
 * 验证：
 * 1) 摘要 send pending 时 cancelChatRun → summarize_cancelled，不二次摘要、不写
 *    compact 事件、不调 Agent.create（不重建）、runStatus 不置 running
 * 2) 摘要成功后重建前置窗口 abort → 不写 compact 事件、不重建
 *
 * 并行隔离：DATA_DIR 在 task-fs-core 模块加载时冻结；ESM 静态 import 会 hoist，
 * 必须先钉 FE_AI_FLOW_DATA_DIR 再动态 import。
 */
import { mkdtempSync, promises as fs } from "node:fs";
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
import { MIN_COMPACT_SUMMARY_CHARS } from "@/lib/server/chat-compact-prompt";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-chat-compact-stop-"));
const DATA_DIR = path.join(TMP_ROOT, "data");
process.env.FE_AI_FLOW_DATA_DIR = DATA_DIR;

const mockCreate = vi.fn();
const mockResume = vi.fn();
vi.mock("@cursor/sdk", () => ({
  Agent: {
    create: (...args: unknown[]) => mockCreate(...args),
    resume: (...args: unknown[]) => mockResume(...args),
  },
}));

const taskFsCore = await import("@/lib/server/task-fs-core");
const { readMetaV06, taskDir, writeMeta } = taskFsCore;
const {
  cancelChatRun,
  closeChatSessionUnconditional,
  compactChatSession,
  CompactChatError,
  hasChatSession,
  isChatCompactInProgress,
  resumeChatSession,
} = await import("@/lib/server/chat-runner");

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(
    `chat-runner-compact-stop DATA_DIR 未隔离到 TMP：${taskDir("probe")}`,
  );
}

const TASK_ID = "t_1700000000900_compact_stop";
const AGENT_ID = "agent_fake_compact_stop";

const BOOT = {
  apiKey: "test-key",
  model: { id: "gpt-test", params: [] as never[] },
};

const makeMeta = (id: string): TaskMetaV06 =>
  ({
    id,
    title: `compact stop ${id}`,
    mode: "chat",
    repoStatus: "developing",
    runStatus: "idle",
    currentActionId: null,
    actions: [],
    mrs: [],
    repoPaths: [],
    sessionAgentId: AGENT_ID,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }) as unknown as TaskMetaV06;

const asTask = (meta: TaskMetaV06): Task => meta as unknown as Task;

/** ≥500 字的合法摘要（过 extractCompactSummaryText 校验） */
const LONG_SUMMARY = "摘要内容".repeat(
  Math.ceil(MIN_COMPACT_SUMMARY_CHARS / 4) + 10,
);
const SUMMARY_PAYLOAD = `<summary>${LONG_SUMMARY}</summary>`;

const makeSummaryRun = (text: string) => ({
  stream: async function* () {
    yield {
      type: "assistant" as const,
      message: { content: [{ type: "text" as const, text }] },
    };
  },
  wait: async () => ({ status: "finished" as const }),
  cancel: vi.fn(),
});

const writeServerCreds = async () => {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(
    path.join(DATA_DIR, "config.json"),
    JSON.stringify({
      apiKey: "server-key",
      defaultModel: { id: "gpt-test", params: [] },
    }),
    "utf-8",
  );
};

beforeEach(async () => {
  mockCreate.mockReset();
  mockResume.mockReset();
  closeChatSessionUnconditional(TASK_ID);
  await new Promise((r) => setTimeout(r, 30));
  await fs.rm(taskDir(TASK_ID), { recursive: true, force: true }).catch(() => {});
  await writeMeta(makeMeta(TASK_ID));
  await writeServerCreds();
});

afterEach(async () => {
  closeChatSessionUnconditional(TASK_ID);
  await new Promise((r) => setTimeout(r, 30));
  expect(isChatCompactInProgress(TASK_ID)).toBe(false);
});

afterAll(async () => {
  closeChatSessionUnconditional(TASK_ID);
  await new Promise((r) => setTimeout(r, 50));
  await fs.rm(TMP_ROOT, { recursive: true, force: true }).catch(() => {});
});

describe("compactChatSession 事务级 stop（S3）", () => {
  it(
    "摘要 send pending 时 cancel → summarize_cancelled，不重试、不写事件、不重建",
    async () => {
      let resolveSend!: (run: unknown) => void;
      const sendGate = new Promise<unknown>((r) => {
        resolveSend = r;
      });
      const mockSend = vi.fn().mockImplementation(() => sendGate);
      mockResume.mockResolvedValue({
        agentId: AGENT_ID,
        close: vi.fn(),
        send: mockSend,
      });

      const task = asTask(makeMeta(TASK_ID));
      expect(await resumeChatSession(task, BOOT)).not.toBeNull();
      expect(hasChatSession(TASK_ID)).toBe(true);

      const compactP = compactChatSession(TASK_ID);
      await vi.waitFor(() => expect(mockSend).toHaveBeenCalledTimes(1), {
        timeout: 3_000,
        interval: 20,
      });

      expect(cancelChatRun(TASK_ID)).toBe(true);

      // 放行 send：cancelledDuringSend 已置位 → summarize_cancelled
      resolveSend(makeSummaryRun(SUMMARY_PAYLOAD));

      let err: unknown;
      try {
        await compactP;
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(CompactChatError);
      expect((err as InstanceType<typeof CompactChatError>).code).toBe(
        "summarize_cancelled",
      );
      expect((err as InstanceType<typeof CompactChatError>).status).toBe(409);

      // 不得第二次摘要、不得重建
      expect(mockSend).toHaveBeenCalledTimes(1);
      expect(mockCreate).not.toHaveBeenCalled();

      // compact_done 在 info.meta；compact_summary 为顶层 kind——全文扫描更稳
      let log = "";
      try {
        log = await fs.readFile(
          path.join(taskDir(TASK_ID), "events.jsonl"),
          "utf-8",
        );
      } catch {
        /* 无事件文件亦可 */
      }
      expect(log).not.toContain("compact_done");
      expect(log).not.toContain('"kind":"compact_summary"');
      // 重建路径不得把任务重新拉起（摘要中途 cancelChatRun 本身不改 runStatus；
      // 完整 stop 路由会归 idle——此处钉「未重建」即可）
      expect(mockCreate).not.toHaveBeenCalled();
      expect(isChatCompactInProgress(TASK_ID)).toBe(false);
    },
  );

  it(
    "摘要成功后重建前置 abort → 不写 compact 事件、不调 runChatSession",
    async () => {
      const mockSend = vi
        .fn()
        .mockResolvedValue(makeSummaryRun(SUMMARY_PAYLOAD));
      mockResume.mockResolvedValue({
        agentId: AGENT_ID,
        close: vi.fn(),
        send: mockSend,
      });

      const task = asTask(makeMeta(TASK_ID));
      expect(await resumeChatSession(task, BOOT)).not.toBeNull();

      // 卡住 readServerChatCreds（读 config.json）以打开 abort 窗口
      const realReadFile = fs.readFile.bind(fs);
      let releaseCreds!: () => void;
      const credsGate = new Promise<void>((r) => {
        releaseCreds = r;
      });
      let credsReadStarted = false;
      const spy = vi
        .spyOn(fs, "readFile")
        .mockImplementation(async (p, opts) => {
          if (String(p).endsWith("config.json")) {
            credsReadStarted = true;
            await credsGate;
          }
          return realReadFile(p, opts as Parameters<typeof realReadFile>[1]);
        });

      try {
        const compactP = compactChatSession(TASK_ID);
        await vi.waitFor(() => expect(mockSend).toHaveBeenCalledTimes(1), {
          timeout: 3_000,
          interval: 20,
        });
        await vi.waitFor(() => expect(credsReadStarted).toBe(true), {
          timeout: 3_000,
          interval: 20,
        });

        // 摘要已成功、读凭据挂起：此时 abort → 不得写事件 / 重建
        expect(cancelChatRun(TASK_ID)).toBe(true);
        releaseCreds();

        let err: unknown;
        try {
          await compactP;
        } catch (e) {
          err = e;
        }
        expect(err).toBeInstanceOf(CompactChatError);
        expect((err as InstanceType<typeof CompactChatError>).code).toBe(
          "summarize_cancelled",
        );

        expect(mockCreate).not.toHaveBeenCalled();
        // 只摘要一次（无重试）
        expect(mockSend).toHaveBeenCalledTimes(1);

        let log = "";
        try {
          log = await fs.readFile(
            path.join(taskDir(TASK_ID), "events.jsonl"),
            "utf-8",
          );
        } catch {
          /* ok */
        }
        expect(log).not.toContain("compact_done");
        expect(log).not.toContain('"kind":"compact_summary"');

        const meta = await readMetaV06(TASK_ID);
        expect(meta?.runStatus).not.toBe("running");
      } finally {
        spy.mockRestore();
        releaseCreds();
      }
    },
  );
});
