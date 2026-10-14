/**
 * `writeOwnedEventAndPublish` 的 origin → 落盘 `meta.groupRun`（答疑旁路 run 的整轮事件打标）
 *
 * 背景：origin 以前只挂在 publish 的 envelope 上、不落盘，UI 没法在重载后把旁路 run 的事件
 * 从主事件流折叠成「群答疑」一行。现在默认把 origin 写进 meta.groupRun。
 *
 * 钉三件事：
 * 1. 带 origin → 落盘事件 meta.groupRun = origin（且不覆盖事件自带的 meta 字段）；不带 origin → 不加；
 * 2. 只为「防投进回群登记」而传 origin 的调用方（group-route 排队回放失败汇总）用
 *    `{ tagGroupRun: false }` 关掉打标——否则 UI 会把这条汇总当旁路事件藏起来；
 * 3. handleSdkMessage（答疑 run 与属主 run 共用的翻译器）把 origin 传到它写的每一类事件。
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import type { TaskMetaV06 } from "@/lib/server/task-fs-core";
import type { TaskEvent } from "@/lib/types";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-task-stream-grouprun-"));
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");

vi.mock("@cursor/sdk", () => ({
  Agent: { create: vi.fn(), resume: vi.fn() },
}));

const { readEvents, taskDir, writeMeta } = await import(
  "@/lib/server/task-fs-core"
);
const { subscribeTaskStream, writeOwnedEventAndPublish } = await import(
  "@/lib/server/task-stream"
);
const { flushThinkingBuffer, handleSdkMessage } = await import(
  "@/lib/server/sdk-message-handler"
);

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(`DATA_DIR 未隔离到 TMP：${taskDir("probe")}`);
}

const ids: string[] = [];
const seed = async (): Promise<string> => {
  const id = `t_grm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  ids.push(id);
  await writeMeta({
    id,
    title: "group-run-meta",
    mode: "task",
    repoStatus: "developing",
    runStatus: "idle",
    currentActionId: null,
    actions: [],
    mrs: [],
    repoPaths: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  } as unknown as TaskMetaV06);
  return id;
};

afterEach(() => {
  // 目录统一在 afterAll 删（落盘是 fire-and-forget 链，边写边删会 ENOENT 噪音）
});
afterAll(() => {
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

const byText = (events: TaskEvent[], text: string) =>
  events.find((e) => e.text === text);

describe("writeOwnedEventAndPublish：origin → meta.groupRun", () => {
  it("带 origin：落盘事件带 meta.groupRun，且 publish 的 envelope 里事件同样带（实时与重载一致）", async () => {
    const id = await seed();
    const published: { origin?: string; meta?: Record<string, unknown> }[] = [];
    const unsub = subscribeTaskStream(id, (ev) => {
      if (ev.kind === "event")
        published.push({ origin: ev.origin, meta: ev.event.meta });
    });

    const wrote = await writeOwnedEventAndPublish(
      id,
      () => true,
      { kind: "info", text: "答疑过程" },
      "rq-tag-1",
    );
    unsub();

    expect(wrote?.meta?.groupRun).toBe("rq-tag-1");
    expect(byText(await readEvents(id), "答疑过程")?.meta).toEqual({
      groupRun: "rq-tag-1",
    });
    expect(published).toEqual([
      { origin: "rq-tag-1", meta: { groupRun: "rq-tag-1" } },
    ]);
  });

  it("事件自带的 meta 字段一个都不覆盖（含自己已写了 groupRun 的）", async () => {
    const id = await seed();
    await writeOwnedEventAndPublish(
      id,
      () => true,
      { kind: "info", text: "带 meta", meta: { subkind: "boot", durationMs: 5 } },
      "rq-tag-2",
    );
    await writeOwnedEventAndPublish(
      id,
      () => true,
      { kind: "info", text: "自带标", meta: { groupRun: "own-tag", subkind: "x" } },
      "rq-tag-2",
    );

    const events = await readEvents(id);
    expect(byText(events, "带 meta")?.meta).toEqual({
      subkind: "boot",
      durationMs: 5,
      groupRun: "rq-tag-2",
    });
    expect(byText(events, "自带标")?.meta).toEqual({
      groupRun: "own-tag",
      subkind: "x",
    });
  });

  it("不带 origin（属主主链）：meta 原样，不加 groupRun；没 meta 的仍然没 meta", async () => {
    const id = await seed();
    await writeOwnedEventAndPublish(id, () => true, { kind: "info", text: "主链无 meta" });
    await writeOwnedEventAndPublish(id, () => true, {
      kind: "info",
      text: "主链有 meta",
      meta: { subkind: "boot" },
    });

    const events = await readEvents(id);
    expect(byText(events, "主链无 meta")?.meta).toBeUndefined();
    expect(byText(events, "主链有 meta")?.meta).toEqual({ subkind: "boot" });
  });

  it("origin + tagGroupRun:false（只为防投递的调用方）：envelope 带 origin，但落盘不打 groupRun", async () => {
    const id = await seed();
    const origins: (string | undefined)[] = [];
    const unsub = subscribeTaskStream(id, (ev) => {
      if (ev.kind === "event") origins.push(ev.origin);
    });

    const wrote = await writeOwnedEventAndPublish(
      id,
      () => true,
      { kind: "info", text: "pump-fail 汇总", meta: { groupQaSummary: { ok: false } } },
      "pump-fail-abc",
      { tagGroupRun: false },
    );
    unsub();

    expect(wrote?.meta).toEqual({ groupQaSummary: { ok: false } });
    expect(byText(await readEvents(id), "pump-fail 汇总")?.meta?.groupRun).toBeUndefined();
    expect(origins).toEqual(["pump-fail-abc"]);
  });

  it("失主（lease=false）：不落盘、返回 null（打标不改变 lease 语义）", async () => {
    const id = await seed();
    const wrote = await writeOwnedEventAndPublish(
      id,
      () => false,
      { kind: "info", text: "失主" },
      "rq-tag-3",
    );
    expect(wrote).toBeNull();
    expect(byText(await readEvents(id), "失主")).toBeUndefined();
  });
});

describe("handleSdkMessage：origin 传到每一类落盘事件", () => {
  const KINDS = ["thinking", "tool_call", "tool_result", "info"] as const;

  /** 喂一串覆盖四类事件的 SDK 消息（thinking / tool_call / tool_result / 压缩 info） */
  const drive = async (id: string, origin: string | undefined) => {
    const ctx = { buffer: "", flush: async () => {} };
    const lease = () => true;
    const callId = `call_${Math.random().toString(36).slice(2, 8)}`;
    const args = { path: "/tmp/x.md" };
    await handleSdkMessage(id, { type: "thinking", text: "想想" } as never, ctx, lease, origin);
    await handleSdkMessage(
      id,
      { type: "tool_call", call_id: callId, name: "read", status: "running", args } as never,
      ctx,
      lease,
      origin,
    );
    await handleSdkMessage(
      id,
      { type: "tool_call", call_id: callId, name: "read", status: "completed", args, result: "ok" } as never,
      ctx,
      lease,
      origin,
    );
    await handleSdkMessage(id, { type: "compaction_start" } as never, ctx, lease, origin);
    await flushThinkingBuffer(id, ctx, lease, origin);
  };

  it("带 origin：thinking / tool_call / tool_result / info 每一类都落 groupRun", async () => {
    const id = await seed();
    await drive(id, "rq-sdk-1");

    const events = await readEvents(id);
    for (const k of KINDS) {
      const list = events.filter((e) => e.kind === k);
      expect(list.length, `缺 ${k} 事件`).toBeGreaterThan(0);
      for (const e of list) expect(e.meta?.groupRun, k).toBe("rq-sdk-1");
    }
  });

  it("不带 origin（属主主链）：同样四类事件都在，但一条都不打 groupRun", async () => {
    const id = await seed();
    await drive(id, undefined);

    const events = await readEvents(id);
    for (const k of KINDS) {
      expect(events.some((e) => e.kind === k), `缺 ${k} 事件`).toBe(true);
    }
    for (const e of events) expect(e.meta?.groupRun).toBeUndefined();
  });
});
