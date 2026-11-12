/**
 * GET /api/system/storage：量尺有界并发 + 缓存 + worktree 后台单路（第三轮 review D2b-02 → 2026-11-12 卡顿治理）。
 *
 * 历史：
 * - D2b-02：任务数据目录的 dirSize 在 readdir 循环里串行 `await`，几百个会话 + 慢盘时存储页扫描要等分钟级 → 改有界并发。
 * - 2026-11-12：用户反馈「进会话管理特别卡」。实测每次请求都把全部活任务的 worktree（带 node_modules、单个 3~8GB、
 *   4 个合计 18GB、`du` 串起来 ~40 秒、内核态 CPU 吃满）重量一遍，而页面每次进入 / 每次删除后都会再扫——
 *   现在：任务数据目录并发限 4 + 缓存；worktree **不在请求里量**，先 `null`（统计中）返回、后台**单路**量、量完进缓存；
 *   第二次进页面不再碰磁盘；只有 `?refresh=1`（用户点「重新统计」）才整表重量。
 * - R15 复审（2026-11-12）：`du` 遇到不可读 / 被并发删掉的文件会「输出合计 + 退出 1」（R15-02）——合计要捞出来用，
 *   du 在但没量成时不回退无超时的逐文件遍历、记「量不出」并退避；时钟回拨 / 未来时间戳不可信（R15-18）；
 *   落盘串行；同目录的并发请求共用一次 du。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const probe = vi.hoisted(() => ({
  /** 按目录决定这次 du 的行为（默认 ok）：exit1 = 输出合计但退出 1；killed = 超时被杀、无输出；enoent = 没装 du；empty = 退出 0 但没输出 */
  behavior: (() => "ok") as (dir: string) => "ok" | "exit1" | "killed" | "enoent" | "empty",
  /** true 时 worktree 的 du 一直挂着、直到 releaseWt()——让「pending 正好是 N」这类断言不依赖时序 */
  wtHeld: false,
  wtWaiters: [] as Array<() => void>,
  /** 每次 du 调用拿到的 execFile 选项 */
  optsSeen: [] as unknown[],
  inFlight: 0,
  max: 0,
  calls: 0,
  dataCalls: 0,
  dataInFlight: 0,
  dataMax: 0,
  wtCalls: 0,
  wtInFlight: 0,
  wtMax: 0,
}));

const releaseWt = () => {
  probe.wtHeld = false;
  for (const w of probe.wtWaiters.splice(0)) w();
};

const resetProbe = () => {
  probe.behavior = () => "ok";
  probe.wtHeld = false;
  probe.wtWaiters.length = 0;
  probe.optsSeen.length = 0;
  probe.inFlight = 0;
  probe.max = 0;
  probe.calls = 0;
  probe.dataCalls = 0;
  probe.dataInFlight = 0;
  probe.dataMax = 0;
  probe.wtCalls = 0;
  probe.wtInFlight = 0;
  probe.wtMax = 0;
};

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: (
      cmd: string,
      args: string[],
      opts: unknown,
      cb: (err: Error | null, value?: { stdout: string; stderr: string }) => void,
    ) => {
      if (cmd !== "du") {
        return (actual.execFile as unknown as (...a: unknown[]) => unknown)(cmd, args, opts, cb);
      }
      const dir = args[args.length - 1];
      const idx = Number(/_(\d+)$/.exec(dir)?.[1] ?? "0");
      const isWorktree = dir.includes(`${path.sep}worktrees${path.sep}`);
      // 数据目录 (idx+1) KB；工作区 (1000+idx) KB——一眼分得出配错了谁
      const kb = isWorktree ? 1000 + idx : idx + 1;
      probe.inFlight += 1;
      probe.calls += 1;
      probe.max = Math.max(probe.max, probe.inFlight);
      if (isWorktree) {
        probe.wtCalls += 1;
        probe.wtInFlight += 1;
        probe.wtMax = Math.max(probe.wtMax, probe.wtInFlight);
      } else {
        probe.dataCalls += 1;
        probe.dataInFlight += 1;
        probe.dataMax = Math.max(probe.dataMax, probe.dataInFlight);
      }
      probe.optsSeen.push(opts);
      const behavior = probe.behavior(dir);
      const finish = () => {
        probe.inFlight -= 1;
        if (isWorktree) probe.wtInFlight -= 1;
        else probe.dataInFlight -= 1;
        if (behavior === "ok") {
          cb(null, { stdout: `${kb}\t${dir}\n`, stderr: "" });
        } else if (behavior === "empty") {
          cb(null, { stdout: "", stderr: "" });
        } else if (behavior === "exit1") {
          // 真 du 遇到不可读文件：合计照常输出、退出码 1；promisify 因此 reject、合计在 err.stdout 里
          cb(
            Object.assign(new Error("Command failed: du -sk"), {
              code: 1,
              stdout: `${kb}\t${dir}\n`,
              stderr: "du: locked: Permission denied\n",
            }),
          );
        } else if (behavior === "killed") {
          // 超时被杀：无输出
          cb(
            Object.assign(new Error("Command failed: du -sk"), {
              code: null,
              killed: true,
              signal: "SIGTERM",
              stdout: "",
              stderr: "",
            }),
          );
        } else {
          cb(Object.assign(new Error("spawn du ENOENT"), { code: "ENOENT" }));
        }
      };
      // 编号越小完成得越慢：完成顺序与入参顺序相反，能抓出「按完成顺序回填」的错位
      const run = () => setTimeout(finish, (12 - idx) * 4);
      if (isWorktree && probe.wtHeld) probe.wtWaiters.push(run);
      else run();
      return undefined;
    },
  };
});

const TMP_ROOT = path.join(os.tmpdir(), `fe-storage-du-${Date.now()}`);
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");

import { GET } from "@/app/api/system/storage/route";
import { dirSize } from "@/lib/server/dir-size";
import {
  __persistSizeCacheNowForTest,
  __resetSizeCacheForTest,
  failedScanCount,
  getAnySize,
  getFreshSize,
  loadSizeCache,
  pruneSizeCache,
  putSize,
  clearSizeCache,
  whenScansIdle,
} from "@/lib/server/storage-size-cache";
import { DATA_DIR as TASKS_DIR } from "@/lib/server/task-fs-core";
import { getTaskWorktreesDir } from "@/lib/server/task-worktrees";

const N = 10;
// 末尾 `_NN` 就是序号：du mock 靠它回填大小、并决定谁完成得慢
const idOf = (i: number) => `t_1700000009${String(i).padStart(3, "0")}_${String(i).padStart(2, "0")}`;

interface Body {
  entries: Array<{ id: string; bytes: number; worktreeBytes: number | null }>;
  worktreeScan: { pending: number; failed: number; measuredAt: number | null };
}
const get = async (url?: string): Promise<Body> => {
  const res = await GET(url ? new Request(url) : undefined);
  expect(res.status).toBe(200);
  return (await res.json()) as Body;
};

beforeEach(async () => {
  __resetSizeCacheForTest();
  resetProbe();
  // 每个用例从干净的盘上缓存开始
  await fs.rm(path.join(TMP_ROOT, "data", "storage-size-cache.json"), { force: true });
  for (let i = 0; i < N; i++) {
    await fs.mkdir(path.join(TASKS_DIR, idOf(i)), { recursive: true });
    // 容器目录每个用例重建：上一个用例往里加过子目录（改 mtime）不能漏到这一个——否则「mtime 变了才失效」类用例依赖执行顺序
    await fs.rm(getTaskWorktreesDir(idOf(i)), { recursive: true, force: true });
    await fs.mkdir(getTaskWorktreesDir(idOf(i)), { recursive: true });
  }
});

afterAll(async () => {
  __resetSizeCacheForTest();
  await fs.rm(TMP_ROOT, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("storage GET：有界并发 + 缓存 + worktree 后台单路", () => {
  it("首次请求：任务数据并发限 4、每个任务拿到自己的大小；worktree 不在请求里量（null=统计中）", async () => {
    probe.wtHeld = true; // worktree 的 du 先挂住：pending 恰好是 N，不依赖机器快慢
    const body = await get();

    // 请求返回时只量了任务数据目录；worktree 还没量完（后台排队中）
    expect(probe.dataCalls).toBe(N);
    // 任务数据目录那一段本身要并发（旧实现这段是串行 await → dataMax === 1），且有界
    expect(probe.dataMax).toBeGreaterThan(1);
    expect(probe.dataMax).toBeLessThanOrEqual(4);

    for (let i = 0; i < N; i++) {
      const e = body.entries.find((x) => x.id === idOf(i));
      expect(e, `entry ${idOf(i)}`).toBeDefined();
      expect(e!.bytes).toBe((i + 1) * 1024);
      expect(e!.worktreeBytes, "worktree 没有缓存：先回统计中").toBeNull();
    }
    expect(body.worktreeScan.pending).toBe(N);
    releaseWt();
    await whenScansIdle();
  });

  it("后台量 worktree 是单路（同时只有一个 du 在跑）；量完后再请求拿到各自的大小，且不再碰磁盘", async () => {
    await get();
    await whenScansIdle();
    // 单路：3~8GB 的工作区并发开几路只会把磁盘打满、拖慢界面
    expect(probe.wtCalls).toBe(N);
    expect(probe.wtMax).toBe(1);

    const callsBefore = probe.calls;
    const body = await get();
    for (let i = 0; i < N; i++) {
      const e = body.entries.find((x) => x.id === idOf(i));
      expect(e!.bytes).toBe((i + 1) * 1024);
      expect(e!.worktreeBytes).toBe((1000 + i) * 1024);
    }
    expect(body.worktreeScan.pending).toBe(0);
    expect(body.worktreeScan.measuredAt).toBeTypeOf("number");
    // 第二次进页面：任务数据与 worktree 全走缓存，一个 du 都不再起（这就是「进会话管理不再卡」的核心）
    expect(probe.calls).toBe(callsBefore);
  });

  it("缓存落盘：丢掉内存态（≈重启 server）后第一次请求直接用盘上缓存，不重量", async () => {
    await get();
    await whenScansIdle();
    // 落盘有去抖（1s）——测试里直接触发一次
    await __persistSizeCacheNowForTest();
    const file = path.join(TMP_ROOT, "data", "storage-size-cache.json");
    expect(JSON.parse(await fs.readFile(file, "utf8")).v).toBe(1);

    __resetSizeCacheForTest(); // 模拟 server 重启：内存没了、盘上还在
    resetProbe();
    const body = await get();
    expect(probe.calls).toBe(0);
    expect(body.entries.find((x) => x.id === idOf(3))!.worktreeBytes).toBe(1003 * 1024);
    expect(body.worktreeScan.pending).toBe(0);
  });

  it("?refresh=1（用户点「重新统计」）：整表作废重量，量完拿到新值", async () => {
    await get();
    await whenScansIdle();
    resetProbe();

    probe.wtHeld = true;
    const refreshed = await get("http://localhost/api/system/storage?refresh=1");
    // 整表作废：任务数据重量、worktree 回到统计中
    expect(probe.dataCalls).toBe(N);
    expect(refreshed.entries.every((e) => e.worktreeBytes === null)).toBe(true);
    expect(refreshed.worktreeScan.pending).toBe(N);
    releaseWt();
    await whenScansIdle();
    expect(probe.wtCalls).toBe(N);
    expect(probe.wtMax).toBe(1);
  });

  it("worktree 目录没了（归档清掉）→ 立刻 0、不排量尺；目录在但缓存过期 → 先给旧值顶着、同时后台重量", async () => {
    await get();
    await whenScansIdle();

    // 归档清掉了 #2 的工作区
    await fs.rm(getTaskWorktreesDir(idOf(2)), { recursive: true, force: true });
    // #5 的容器目录结构变了（新增了一个仓的工作区目录）→ mtime 变 → 缓存失效
    await fs.mkdir(path.join(getTaskWorktreesDir(idOf(5)), "new-repo"), { recursive: true });
    resetProbe();

    probe.wtHeld = true;
    const body = await get();
    expect(body.entries.find((x) => x.id === idOf(2))!.worktreeBytes).toBe(0);
    // #5 旧值（1005KB）先顶着，界面不闪「统计中」
    expect(body.entries.find((x) => x.id === idOf(5))!.worktreeBytes).toBe(1005 * 1024);
    expect(body.worktreeScan.pending).toBe(1);
    releaseWt();
    await whenScansIdle();
    expect(probe.wtCalls).toBe(1);
  });
});

// ───────────────────────── R15 复审：失败语义 / 缓存健壮性 / 并发 ─────────────────────────

const isWorktreeDir = (dir: string) => dir.includes(`${path.sep}worktrees${path.sep}`);
const CACHE_FILE = path.join(TMP_ROOT, "data", "storage-size-cache.json");
const DATA_KEY = (i: number) => `data:${idOf(i)}`;
const WT_KEY = (i: number) => `wt:${idOf(i)}`;

describe.skipIf(process.platform === "win32")("dirSize：du 的失败语义（R15-02）", () => {
  let dir: string;
  beforeEach(async () => {
    dir = path.join(TMP_ROOT, `probe_${Math.random().toString(36).slice(2)}_03`);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "a.bin"), Buffer.alloc(5000));
  });

  it("目录不存在 = 0（任务没建过 worktree 很常见）", async () => {
    expect(await dirSize(path.join(TMP_ROOT, "nope"))).toBe(0);
  });

  it("du 非 0 退出但合计已输出（活 worktree 里有不可读 / 被删掉的文件）→ 用 err.stdout 里的合计，不丢、不走遍历", async () => {
    probe.behavior = () => "exit1";
    // idx=3 → 数据目录 (3+1)KB；若误走遍历会得到 5000（a.bin 的表观大小）
    expect(await dirSize(dir)).toBe(4 * 1024);
  });

  it("du 在但没量成（超时被杀、无输出）→ null（量不出），不回退无超时的逐文件遍历", async () => {
    probe.behavior = () => "killed";
    // 遍历会得到 5000；null 证明没有走遍历
    expect(await dirSize(dir)).toBeNull();
  });

  it("du 正常退出却没有可解析的输出 → null", async () => {
    probe.behavior = () => "empty";
    expect(await dirSize(dir)).toBeNull();
  });

  it("du 没装（ENOENT）→ 才走 Node 遍历（表观大小）", async () => {
    probe.behavior = () => "enoent";
    expect(await dirSize(dir)).toBe(5000);
  });

  it("Node 遍历带期限：超了放弃返回 null，不会无限走下去", async () => {
    probe.behavior = () => "enoent";
    expect(await dirSize(dir, { walkDeadlineMs: -1 })).toBeNull();
  });

  it("du 调用带超时与输出上限（不会无限挂住单路队列）", async () => {
    await dirSize(dir);
    const opts = probe.optsSeen.at(-1) as { timeout?: number; maxBuffer?: number };
    expect(opts.timeout).toBeGreaterThan(0);
    expect(opts.timeout).toBeLessThanOrEqual(120_000);
    expect(opts.maxBuffer).toBeGreaterThan(0);
  });
});

describe.skipIf(process.platform === "win32")("storage GET：量不出 / 退避（R15-02）", () => {
  it("worktree 的 du 非 0 退出但有合计：照常记下合计（和正常一样进缓存）", async () => {
    probe.behavior = (dir) => (isWorktreeDir(dir) ? "exit1" : "ok");
    await get();
    await whenScansIdle();
    const body = await get();
    expect(body.entries.find((x) => x.id === idOf(3))!.worktreeBytes).toBe(1003 * 1024);
    expect(body.worktreeScan.failed).toBe(0);
  });

  it("worktree 量不出（超时被杀）：不再标「统计中」、记失败；退避期内后续请求不再起 du；手动重新统计才重试", async () => {
    probe.behavior = (dir) => (isWorktreeDir(dir) ? "killed" : "ok");
    await get();
    await whenScansIdle();
    expect(probe.wtCalls).toBe(N);

    const again = await get();
    // 没数（null）、也不在排队：界面据此标「量不出」而不是一直转圈
    expect(again.entries.every((e) => e.worktreeBytes === null)).toBe(true);
    expect(again.worktreeScan.pending).toBe(0);
    expect(again.worktreeScan.failed).toBe(N);
    // 退避期内：轮询再多次也不再起 du（否则每次轮询都起一次注定失败的 du）
    await get();
    await get();
    await whenScansIdle();
    expect(probe.wtCalls).toBe(N);

    // 手动「重新统计」清掉失败记录 → 重试；这次量得出
    probe.behavior = () => "ok";
    await get("http://localhost/api/system/storage?refresh=1");
    await whenScansIdle();
    const recovered = await get();
    expect(recovered.entries.find((x) => x.id === idOf(4))!.worktreeBytes).toBe(1004 * 1024);
    expect(recovered.worktreeScan.failed).toBe(0);
  });

  it("以前量出过、这次量不出：保留旧值（不变回统计中 / 不清零），记失败", async () => {
    await get();
    await whenScansIdle();
    // #5 的容器目录结构变了 → 戳对不上、缓存失效 → 后台重量；这次 du 失败
    await fs.mkdir(path.join(getTaskWorktreesDir(idOf(5)), "new-repo"), { recursive: true });
    probe.behavior = (dir) => (isWorktreeDir(dir) ? "killed" : "ok");
    await get();
    await whenScansIdle();
    const body = await get();
    expect(body.entries.find((x) => x.id === idOf(5))!.worktreeBytes).toBe(1005 * 1024);
    expect(body.worktreeScan.failed).toBe(1);
    expect(body.worktreeScan.pending).toBe(0);
  });

  it("任务数据目录量不出：本次按 0 / 旧值显示，但失败不进缓存——下一次请求会重新量", async () => {
    probe.behavior = (dir) => (isWorktreeDir(dir) ? "ok" : "killed");
    const first = await get();
    expect(first.entries.every((e) => e.bytes === 0)).toBe(true);
    expect(getAnySize(DATA_KEY(2))).toBeNull();

    probe.behavior = () => "ok";
    resetProbe();
    const second = await get();
    expect(probe.dataCalls).toBe(N);
    expect(second.entries.find((x) => x.id === idOf(2))!.bytes).toBe(3 * 1024);
    await whenScansIdle();
  });
});

describe.skipIf(process.platform === "win32")("storage GET：并发请求与缓存健壮性（R15-23 / R15-18）", () => {
  it("两个请求同时进来：同一目录只起一个 du（任务数据在途去重 + worktree 排队去重）", async () => {
    const [a, b] = await Promise.all([get(), get()]);
    await whenScansIdle();
    expect(probe.dataCalls).toBe(N);
    expect(probe.wtCalls).toBe(N);
    for (const body of [a, b]) {
      for (let i = 0; i < N; i++) {
        expect(body.entries.find((x) => x.id === idOf(i))!.bytes).toBe((i + 1) * 1024);
      }
    }
  });

  const writeCache = async (entries: Record<string, unknown>, v: unknown = 1) => {
    await fs.mkdir(path.dirname(CACHE_FILE), { recursive: true });
    await fs.writeFile(CACHE_FILE, JSON.stringify({ v, entries }));
  };
  const craftAll = async (opts: { dataAt: number; wtAt: number; dataBytes?: number }) => {
    const entries: Record<string, [number, number, number | null]> = {};
    for (let i = 0; i < N; i++) {
      entries[DATA_KEY(i)] = [opts.dataBytes ?? 7 * 1024, opts.dataAt, null];
      const stamp = (await fs.stat(getTaskWorktreesDir(idOf(i)))).mtimeMs;
      entries[WT_KEY(i)] = [9 * 1024, opts.wtAt, stamp];
    }
    await writeCache(entries);
  };

  it("TTL 内：盘上缓存直接用，不起 du；过 TTL：任务数据重量、worktree 先给旧值并后台重量", async () => {
    const now = Date.now();
    await craftAll({ dataAt: now - 60_000, wtAt: now - 60 * 60_000 });
    const fresh = await get();
    expect(probe.calls).toBe(0);
    expect(fresh.entries[0].bytes).toBe(7 * 1024);

    __resetSizeCacheForTest();
    resetProbe();
    await craftAll({ dataAt: now - 11 * 60_000, wtAt: now - 7 * 60 * 60_000 });
    probe.wtHeld = true;
    const expired = await get();
    // 数据目录（TTL 10 分钟）过期 → 重量；worktree（TTL 6 小时）过期 → 旧值顶着 + 后台重量
    expect(probe.dataCalls).toBe(N);
    expect(expired.entries.find((x) => x.id === idOf(1))!.bytes).toBe(2 * 1024);
    expect(expired.entries.find((x) => x.id === idOf(1))!.worktreeBytes).toBe(9 * 1024);
    expect(expired.worktreeScan.pending).toBe(N);
    releaseWt();
    await whenScansIdle();
  });

  it("盘上缓存里的量尺时间在未来（时钟回拨 / 脏数据）：丢弃、重新量，不会一直被当新鲜", async () => {
    await craftAll({ dataAt: Date.now() + 24 * 60 * 60_000, wtAt: Date.now() + 24 * 60 * 60_000 });
    const body = await get();
    expect(probe.dataCalls).toBe(N);
    expect(body.entries.find((x) => x.id === idOf(4))!.bytes).toBe(5 * 1024);
    // worktree 缓存也被丢了 → 回到统计中
    expect(body.entries.find((x) => x.id === idOf(4))!.worktreeBytes).toBeNull();
    await whenScansIdle();
  });

  it("getFreshSize：时钟回拨（now < 量尺时间）当过期，不再判永远新鲜", () => {
    putSize("clock:x", 123, null);
    const at = Date.now();
    expect(getFreshSize("clock:x", { stamp: null, ttlMs: 60_000, now: at })).toBe(123);
    // 系统时间被拨回 1 小时前：now - at 为负
    expect(getFreshSize("clock:x", { stamp: null, ttlMs: 60_000, now: at - 3_600_000 })).toBeNull();
    // 正常过期仍然成立
    expect(getFreshSize("clock:x", { stamp: null, ttlMs: 60_000, now: at + 61_000 })).toBeNull();
  });

  it.each([
    ["文件不是 JSON", "{ not json"],
    ["版本号不对", JSON.stringify({ v: 2, entries: { [DATA_KEY(0)]: [1, Date.now(), null] } })],
    ["entries 缺失", JSON.stringify({ v: 1 })],
    ["字段脏：NaN / 负数 / 字符串 / 非数组", JSON.stringify({ v: 1, entries: { [DATA_KEY(0)]: [-5, Date.now(), null], [DATA_KEY(1)]: ["x", Date.now(), null], [DATA_KEY(2)]: [1, "now", null], [DATA_KEY(3)]: 7 } })],
  ])("盘上缓存损坏（%s）：当空缓存、照常量，不抛", async (_name, content) => {
    await fs.mkdir(path.dirname(CACHE_FILE), { recursive: true });
    await fs.writeFile(CACHE_FILE, content);
    const body = await get();
    expect(probe.dataCalls).toBe(N);
    expect(body.entries.find((x) => x.id === idOf(0))!.bytes).toBe(1 * 1024);
    await whenScansIdle();
  });

  it("pruneSizeCache：不在 live 集合里的条目（含失败记录）被清掉，live 的保留", async () => {
    putSize("data:keep", 1, null);
    putSize("data:drop", 2, null);
    pruneSizeCache(new Set(["data:keep"]));
    expect(getAnySize("data:keep")).toBe(1);
    expect(getAnySize("data:drop")).toBeNull();

    // 失败记录：目录被删后不该永远占着 failed 计数
    probe.behavior = (dir) => (isWorktreeDir(dir) ? "killed" : "ok");
    await get();
    await whenScansIdle();
    expect(failedScanCount()).toBe(N);
    pruneSizeCache(new Set([WT_KEY(0)]));
    expect(failedScanCount()).toBe(1);
  });

  it("手动重新统计与在途量尺：清空时在途的那一个结果属于旧一代，不写回缓存", async () => {
    probe.wtHeld = true;
    await get();
    // 此刻队首的 worktree du 已发出、挂在 held 上
    clearSizeCache();
    releaseWt();
    await whenScansIdle();
    for (let i = 0; i < N; i++) expect(getAnySize(WT_KEY(i)), WT_KEY(i)).toBeNull();
  });

  it("落盘串行：连续并发落盘不交错，最终文件是合法 JSON，目录里没有残留临时文件", async () => {
    await get();
    await whenScansIdle();
    // 慢盘：每次 writeFile 拖 15ms，观察同一时刻最多有几个写在飞（串行 = 1；交错写才会 > 1）
    let inFlight = 0;
    let maxInFlight = 0;
    const realWriteFile = fs.writeFile.bind(fs);
    const spy = vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        await new Promise((r) => setTimeout(r, 15));
        return await realWriteFile(...(args as Parameters<typeof realWriteFile>));
      } finally {
        inFlight -= 1;
      }
    });
    let writes = 0;
    try {
      await Promise.all([
        __persistSizeCacheNowForTest(),
        __persistSizeCacheNowForTest(),
        __persistSizeCacheNowForTest(),
      ]);
      writes = spy.mock.calls.length; // mockRestore 会清掉调用记录，先取
    } finally {
      spy.mockRestore();
    }
    expect(writes).toBe(3);
    expect(maxInFlight).toBe(1);
    const parsed = JSON.parse(await fs.readFile(CACHE_FILE, "utf8"));
    expect(parsed.v).toBe(1);
    expect(Object.keys(parsed.entries).length).toBe(N * 2);
    const left = (await fs.readdir(path.dirname(CACHE_FILE))).filter((f) => f.includes(".tmp."));
    expect(left).toEqual([]);
  });

  it("loadSizeCache 幂等：并发调用不重复读 / 不覆盖本进程已量出的更新值", async () => {
    putSize(DATA_KEY(0), 999, null);
    await writeCache({ [DATA_KEY(0)]: [1, Date.now(), null] });
    await Promise.all([loadSizeCache(), loadSizeCache()]);
    expect(getAnySize(DATA_KEY(0))).toBe(999);
  });
});
