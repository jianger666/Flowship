/**
 * R28-5 OrderedEventCommit + R28-3 clear finalGuard 定向测试
 *
 * ① A 写行后 meta touch 挂起 × B append+publish → SSE 序 = 磁盘序
 * ② seq 单调
 * ③ clear.beforeCommit 挂起 × B 安装同 agentId session → 锚点保留
 * ④ 正常 clear 回归
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import type { TaskMetaV06 } from "@/lib/server/task-fs-core";

const TMP_ROOT = mkdtempSync(
  path.join(os.tmpdir(), "fe-ownership-r28-order-anchor-"),
);
process.env.FE_AI_FLOW_DATA_DIR = path.join(TMP_ROOT, "data");

const { readEvents, readMetaV06, taskDir, writeMeta } = await import(
  "@/lib/server/task-fs-core"
);
const {
  agentSessions,
  allocTaskRunInstanceId,
  subscribeTaskStream,
  writeEventAndPublish,
} = await import("@/lib/server/task-stream");
const { clearTaskSessionAgentIdIf, listTasks } = await import(
  "@/lib/server/task-fs"
);
const { setFailpoint, clearFailpoints } = await import(
  "@/lib/server/failpoints"
);

if (!taskDir("probe").startsWith(TMP_ROOT)) {
  throw new Error(
    `ownership-r28-order-anchor DATA_DIR 未隔离到 TMP：${taskDir("probe")}`,
  );
}

await listTasks();

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
    title: `ownership-r28 ${id}`,
    mode: "task",
    repoStatus: "developing",
    runStatus: "idle",
    currentActionId: null,
    actions: [],
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

/** 挂起 failpoint：命中后等 release */
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

describe("ownership-r28-order-anchor（R28-5 / R28-3）", () => {
  const ids: string[] = [];
  const alloc = (): string => {
    const id = `t_r28_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    ids.push(id);
    return id;
  };

  afterEach(() => {
    clearFailpoints();
    for (const id of ids) {
      agentSessions.delete(id);
    }
    ids.length = 0;
  });

  // ─────────────────────────────────────────────────────────────
  // R28-5：OrderedEventCommit
  // ─────────────────────────────────────────────────────────────
  it(
    "R28-5：A 写行后 meta touch 挂起 × B append+publish → SSE 序 = 磁盘序",
    async () => {
      // 旧 bug：appendEvent 写行后 await meta touch 才返回 → writeEventAndPublish
      // 才 publish；链已释放，B 可先 append 先 publish → 磁盘 A→B、SSE B→A。
      // 现：publish 进 append 链；meta touch fire-and-forget——touch 挂起不影响序。
      const id = alloc();
      await writeMeta(makeMeta(id));

      const sseTexts: string[] = [];
      const unsub = subscribeTaskStream(id, (ev) => {
        if (ev.kind === "event") sseTexts.push(String(ev.event.text));
      });

      // A 的后台 meta touch 会走 writeMeta → metaCommit.beforeRename
      const hang = installHangingFailpoint("metaCommit.beforeRename");
      const pA = writeEventAndPublish(id, {
        kind: "info",
        text: "r28-5-A",
      });
      await hang.waitHit();
      // 关键路径已返回（publish 已在链内完成）；touch 仍挂着
      const evA = await raceExpectSettled(pA, 5000);
      expect(evA).not.toBeNull();
      expect(sseTexts).toEqual(["r28-5-A"]);

      // B 在 A 的 meta touch 挂起期间 append+publish——不得反序
      const evB = await raceExpectSettled(
        writeEventAndPublish(id, { kind: "info", text: "r28-5-B" }),
        5000,
      );
      expect(evB).not.toBeNull();
      expect(sseTexts).toEqual(["r28-5-A", "r28-5-B"]);

      hang.release();
      await sleep(50);
      unsub();

      const disk = await readEvents(id);
      const diskTexts = disk.map((e) => e.text);
      expect(diskTexts.filter((t) => t === "r28-5-A" || t === "r28-5-B")).toEqual(
        ["r28-5-A", "r28-5-B"],
      );
      // SSE 到达序必须与磁盘序一致
      expect(sseTexts).toEqual(
        diskTexts.filter((t) => t === "r28-5-A" || t === "r28-5-B"),
      );
    },
    15_000,
  );

  it("R28-5：seq 进程内单调（与写盘序一致）", async () => {
    const id = alloc();
    await writeMeta(makeMeta(id));

    const e1 = await writeEventAndPublish(id, {
      kind: "info",
      text: "r28-5-seq-1",
    });
    const e2 = await writeEventAndPublish(id, {
      kind: "info",
      text: "r28-5-seq-2",
    });
    expect(e1?.seq).toBe(1);
    expect(e2?.seq).toBe(2);
    expect(e2!.seq!).toBeGreaterThan(e1!.seq!);

    const disk = await readEvents(id);
    const marked = disk.filter(
      (e) => e.text === "r28-5-seq-1" || e.text === "r28-5-seq-2",
    );
    expect(marked.map((e) => e.seq)).toEqual([1, 2]);
  });

  it(
    "R28-5：event.beforePublish 挂起时 B 不得先 publish（链内同序）",
    async () => {
      const id = alloc();
      await writeMeta(makeMeta(id));
      const sseTexts: string[] = [];
      const unsub = subscribeTaskStream(id, (ev) => {
        if (ev.kind === "event") sseTexts.push(String(ev.event.text));
      });

      const hang = installHangingFailpoint("event.beforePublish");
      const pA = writeEventAndPublish(id, {
        kind: "info",
        text: "r28-5-pub-A",
      });
      await hang.waitHit();
      // A 已写行、尚未 publish；B 入队应卡在链上
      expect(sseTexts).toEqual([]);

      const pB = writeEventAndPublish(id, {
        kind: "info",
        text: "r28-5-pub-B",
      });
      await sleep(40);
      expect(sseTexts).toEqual([]);

      hang.release();
      await raceExpectSettled(pA, 5000);
      await raceExpectSettled(pB, 5000);
      unsub();

      expect(sseTexts).toEqual(["r28-5-pub-A", "r28-5-pub-B"]);
      const disk = await readEvents(id);
      expect(
        disk
          .filter((e) => e.text === "r28-5-pub-A" || e.text === "r28-5-pub-B")
          .map((e) => e.text),
      ).toEqual(["r28-5-pub-A", "r28-5-pub-B"]);
    },
    15_000,
  );

  // ─────────────────────────────────────────────────────────────
  // R28-3：clear finalGuard
  // ─────────────────────────────────────────────────────────────
  it(
    "R28-3：clear.beforeCommit 挂起 × B 安装同 agentId session → 锚点保留",
    async () => {
      // 旧 bug：锁内先验 extraGuard → await read → 无条件 writeMeta；
      // B 在 read/write 夹缝装同 agentId 内存 session，A 仍清空盘上锚点。
      // 现：prepare + commit(finalGuard)，failpoint 后 B 安装 → finalGuard 拒提交。
      const id = alloc();
      const meta = makeMeta(id);
      (meta as { sessionAgentId?: string }).sessionAgentId = "agent_same";
      await writeMeta(meta);

      const hang = installHangingFailpoint("clear.beforeCommit");
      const pClear = clearTaskSessionAgentIdIf(
        id,
        "agent_same",
        () => agentSessions.get(id) === undefined,
      );
      await hang.waitHit();

      // 权威窗口：prepare 已过、commit 未发起——B 装同 agentId 内存实例
      agentSessions.set(id, {
        instanceId: allocTaskRunInstanceId(),
        agent: {
          agentId: "agent_same",
          send: async () => null,
          close: () => {},
        },
        agentId: "agent_same",
        callerToken: "r28-3-b",
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        startSnapshot: { title: meta.title },
      } as never);

      hang.release();
      const cleared = await raceExpectSettled(pClear, 5000);
      expect(cleared).toBe(false);
      expect((await readMetaV06(id))?.sessionAgentId).toBe("agent_same");
    },
    15_000,
  );

  it("R28-3：正常 clear 回归（条件全符合 → 清锚点）", async () => {
    const id = alloc();
    const meta = makeMeta(id);
    (meta as { sessionAgentId?: string }).sessionAgentId = "agent_gone";
    await writeMeta(meta);

    expect(
      await clearTaskSessionAgentIdIf(
        id,
        "agent_gone",
        () => agentSessions.get(id) === undefined,
      ),
    ).toBe(true);
    expect((await readMetaV06(id))?.sessionAgentId).toBeUndefined();

    // expected 不匹配 / extraGuard false 仍不清
    const meta2 = (await readMetaV06(id))!;
    meta2.sessionAgentId = "agent_keep";
    await writeMeta(meta2);
    expect(await clearTaskSessionAgentIdIf(id, "agent_other")).toBe(false);
    expect((await readMetaV06(id))?.sessionAgentId).toBe("agent_keep");
    expect(
      await clearTaskSessionAgentIdIf(id, "agent_keep", () => false),
    ).toBe(false);
    expect((await readMetaV06(id))?.sessionAgentId).toBe("agent_keep");
  });
});
