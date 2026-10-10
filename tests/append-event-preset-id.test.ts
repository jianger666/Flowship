/**
 * appendEvent 的预设 id（thinking 实时帧 → 落盘事件复用同一个 id）
 *
 * 背景（2026-10-10）：一段思考要攒到结束才落一条 thinking 事件，期间前端靠 thinking_delta 实时帧
 * 把「进行中的思考行」画进流程。服务端在第一个 chunk 时就预定好落盘事件的 id、随每帧带给前端，
 * 落盘时复用——前端的进行中行与落盘行是同一个 React 节点，用户点开着读的内容不会被收起。
 *
 * 这条链上最容易悄悄坏的一环就是 appendEvent：它原来是 `{ id: newEventId(), ts, ...ev }`，
 * 谁往事件里塞了 id 都会被 spread 顺序决定生死。这里用真实实现（临时数据目录）钉死：
 *   - 传了 id 就用它（返回值 / 落盘的行 / onCommitted 收到的事件三处一致）；
 *   - 没传、传 undefined、传空串 → 现生成，绝不把 undefined / 空串写进事件；
 *   - events.jsonl 的行格式不变（键顺序仍是 id、ts 打头）。
 */
import { mkdtempSync, promises as fs, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import type { TaskMetaV06 } from "@/lib/server/task-fs-core";
import type { TaskEvent } from "@/lib/types";

const TMP_ROOT = mkdtempSync(
  path.join(os.tmpdir(), "fe-append-event-preset-id-"),
);
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");

vi.mock("@cursor/sdk", () => ({
  Agent: {
    create: vi.fn(),
    resume: vi.fn(),
  },
}));
vi.mock("@/lib/server/mcp-oauth", () => ({
  enrichMcpServersWithOAuth: async <T>(servers: T) => servers,
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
  loadSkillsForTask: async () => [],
  renderSkillsForPrompt: () => "",
}));
vi.mock("@/lib/server/kill-orphans", () => ({
  reapTaskOrphans: vi.fn(),
}));
vi.mock("@/lib/server/action-checks", () => ({
  runActionCheck: vi.fn(async () => ({ passed: true, details: "ok" })),
  captureActionStartBaseline: vi.fn(async () => null),
  captureReadonlyRepoBaselines: vi.fn(async () => null),
}));

const { EVENTS_FILE, clearEventSeqCounter, taskDir, writeMeta } = await import(
  "@/lib/server/task-fs-core"
);
const { appendEvent } = await import("@/lib/server/task-fs");

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(
    `append-event-preset-id DATA_DIR 未隔离到 TMP：${taskDir("probe")}`,
  );
}

afterAll(() => {
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

const makeMeta = (id: string): TaskMetaV06 =>
  ({
    id,
    title: "preset-id",
    mode: "chat",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    repoStatus: "idle",
    runStatus: "idle",
    actions: [],
    mrs: [],
    repoPaths: [],
    currentActionId: null,
  }) as unknown as TaskMetaV06;

/** events.jsonl 里已落盘的行（原始解析结果，保留键顺序） */
const readLines = async (id: string): Promise<Array<Record<string, unknown>>> => {
  const raw = await fs.readFile(path.join(taskDir(id), EVENTS_FILE), "utf-8");
  return raw
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
};

describe("appendEvent 的预设 id", () => {
  const ids: string[] = [];
  const alloc = async (): Promise<string> => {
    const id = `t_preset_id_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    ids.push(id);
    await writeMeta(makeMeta(id));
    return id;
  };

  afterEach(async () => {
    for (const id of ids.splice(0)) {
      clearEventSeqCounter(id);
      await fs.rm(taskDir(id), { recursive: true, force: true }).catch(() => {});
    }
  });

  it("没传 id：现生成（行为不变）", async () => {
    const id = await alloc();
    const ev = await appendEvent(id, { kind: "thinking", text: "想" });

    expect(ev).not.toBeNull();
    expect(typeof ev!.id).toBe("string");
    expect(ev!.id).toMatch(/^e_/);
    expect(typeof ev!.ts).toBe("number");
  });

  it("传了 id：返回值 / 落盘的行 / onCommitted 收到的事件，三处都是这个 id", async () => {
    const id = await alloc();
    const committed: TaskEvent[] = [];
    const ev = await appendEvent(
      id,
      { kind: "thinking", text: "整段思考", id: "e_preset_1" },
      undefined,
      (e) => committed.push(e),
    );

    expect(ev?.id).toBe("e_preset_1");
    expect(committed.map((e) => e.id)).toEqual(["e_preset_1"]);
    const lines = await readLines(id);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.id).toBe("e_preset_1");
    expect(lines[0]!.text).toBe("整段思考");
  });

  it("id 是 undefined 或空串：回退到现生成，绝不把 undefined / 空串写进事件", async () => {
    const id = await alloc();
    const a = await appendEvent(id, { kind: "thinking", text: "a", id: undefined });
    const b = await appendEvent(id, { kind: "thinking", text: "b", id: "" });

    for (const ev of [a, b]) {
      expect(typeof ev!.id).toBe("string");
      expect(ev!.id.length).toBeGreaterThan(0);
      expect(ev!.id).toMatch(/^e_/);
    }
    const lines = await readLines(id);
    expect(lines.map((l) => typeof l.id)).toEqual(["string", "string"]);
    expect(lines.every((l) => (l.id as string).length > 0)).toBe(true);
  });

  it("events.jsonl 的行格式不变：键顺序仍是 id、ts 打头（不管有没有预设 id）", async () => {
    const id = await alloc();
    await appendEvent(id, { kind: "info", text: "无预设" });
    await appendEvent(id, { kind: "thinking", text: "有预设", id: "e_preset_2" });

    const lines = await readLines(id);
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(Object.keys(line).slice(0, 2)).toEqual(["id", "ts"]);
    }
  });

  it("预设 id 的事件和别的事件并存：seq 照常递增，互不影响", async () => {
    const id = await alloc();
    const first = await appendEvent(id, { kind: "info", text: "先" });
    const preset = await appendEvent(id, {
      kind: "thinking",
      text: "思考",
      id: "e_preset_3",
    });
    const last = await appendEvent(id, { kind: "info", text: "后" });

    expect(preset!.seq).toBe(first!.seq! + 1);
    expect(last!.seq).toBe(preset!.seq! + 1);
    expect((await readLines(id)).map((l) => l.id)).toEqual([
      first!.id,
      "e_preset_3",
      last!.id,
    ]);
  });
});
