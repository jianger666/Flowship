/**
 * FastCheckpoints 对拍测试：以 SDK 原实现（JsonlLocalAgentStore.checkpoints）为标准答案。
 *
 * 覆盖：
 *   1. 差分对拍：同一串随机操作分别打到 SDK 与 FastCheckpoints，逐步比较结果，最后比较文件**字节**；
 *   2. 文件格式双向互操作（新写旧读 / 旧写新读 / 交替写）；
 *   3. 文件尾形态与异常行（半行 / 缺换行 / 损坏行 / CRLF / 重复键 / 非 ASCII id / 跨块大行 / 短读）；
 *   4. 并发与队列语义、耐久性（每次 create 恰好 fsync 一次且不在追加句柄上）；
 *   5. append 失败回滚与并发读者（close / fsync 失败窗口内，读侧 catchUp 不能让内存与文件脱节）；
 *   6. 平台硬化与单写者护栏：瞬态错误退避重试、rewrite 失败回退与调用顺序、双实例行为。
 * Windows 语义靠 faultyFs 在任意平台注入模拟（追加句柄无写权限、EPERM / EBUSY 瞬态占用），
 * 真机行为以 CI 的 Windows job 为准。
 */
import fs from "node:fs";

import type { LocalAgentCheckpointFilter, LocalAgentStoreCheckpoints } from "@cursor/sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  A,
  allBlobsOk,
  blobData,
  cleanupTmps,
  faultyFs,
  fileOf,
  loadSdk,
  mkErr,
  mkFast,
  mkTmp,
  rng,
  sameBytes,
  sdkReaderOk,
  seed,
  tmpFileOf,
  type FaultHooks,
  type Sdk,
} from "./helpers/fast-store-helpers";

let sdk: Sdk;
beforeAll(async () => {
  sdk = await loadSdk();
});
afterAll(cleanupTmps);

const readRaw = (dir: string): Buffer =>
  fs.existsSync(fileOf(dir)) ? fs.readFileSync(fileOf(dir)) : Buffer.alloc(0);

type Cp = ReturnType<typeof mkFast>;
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
/** 文件里的非空行（按 \n 切） */
const fileLines = (dir: string): string[] =>
  readRaw(dir)
    .toString("utf8")
    .split("\n")
    .filter((l) => l.length > 0);
const parses = (l: string): boolean => {
  try {
    JSON.parse(l);
    return true;
  } catch {
    return false;
  }
};

// ───────────────────────────── 1. 差分对拍 ─────────────────────────────

type Op =
  | { t: "create" | "update"; a: string; b: string; d: Buffer }
  | { t: "get"; a: string; b: string }
  | { t: "delete"; f: LocalAgentCheckpointFilter }
  | { t: "list"; f: LocalAgentCheckpointFilter | undefined };

const AGENTS = ["agent-A", "agent-B", "agent-C"];
const BLOBS = Array.from({ length: 10 }, (_, i) => `b${i}`);

const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
const subset = <T>(r: () => number, xs: readonly T[], max: number): T[] => {
  const n = 1 + Math.floor(r() * max);
  return Array.from(new Set(Array.from({ length: n }, () => pick(r, xs))));
};

const genFilter = (r: () => number, allowEmpty: boolean): LocalAgentCheckpointFilter => {
  const f: { agentIds?: string[]; blobIds?: string[]; limit?: number } = {};
  const roll = r();
  if (roll < 0.5) f.agentIds = subset(r, AGENTS, 2);
  else if (roll < 0.75) f.blobIds = subset(r, BLOBS, 3);
  else if (roll < 0.95 || !allowEmpty) {
    f.agentIds = subset(r, AGENTS, 2);
    f.blobIds = subset(r, BLOBS, 3);
  }
  // 否则空过滤器（匹配全部）——只在 allowEmpty 时出现
  return f;
};

const genOp = (r: () => number): Op => {
  const x = r();
  const a = pick(r, AGENTS);
  const b = pick(r, BLOBS);
  const d = Buffer.from(Array.from({ length: Math.floor(r() * 120) }, () => Math.floor(r() * 256)));
  if (x < 0.35) return { t: "create", a, b, d };
  if (x < 0.6) return { t: "get", a, b };
  if (x < 0.75) return { t: "update", a, b, d };
  if (x < 0.85) return { t: "delete", f: genFilter(r, r() < 0.2) };
  const f = genFilter(r, true);
  return { t: "list", f: { ...f, limit: 1 + Math.floor(r() * 6) } };
};

const exec = async (cp: LocalAgentStoreCheckpoints, op: Op): Promise<unknown> => {
  try {
    switch (op.t) {
      case "create":
        await cp.create({ agentId: op.a, blobId: op.b, data: op.d });
        return "ok";
      case "update":
        await cp.update({ agentId: op.a, blobId: op.b, data: op.d });
        return "ok";
      case "get": {
        const g = await cp.get({ agentId: op.a, blobId: op.b });
        return g ? Buffer.from(g).toString("hex") : null;
      }
      case "delete":
        await cp.delete({ filter: op.f });
        return "ok";
      case "list": {
        // 走完所有分页，顺带覆盖 cursor 语义
        const pages: unknown[] = [];
        let cursor: string | undefined;
        for (let guard = 0; guard < 50; guard++) {
          const res = await cp.list({ filter: { ...op.f, cursor } });
          pages.push(res);
          cursor = res.nextCursor;
          if (!cursor) break;
        }
        return pages;
      }
    }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
};

describe("差分对拍：随机操作序列 vs SDK 原实现", () => {
  const SEEDS = Array.from({ length: 16 }, (_, i) => 1000 + i * 7919);
  for (const s of SEEDS) {
    it(
      `seed=${s}：每步结果一致、最终文件字节一致、重启后读一致`,
      async () => {
        const r = rng(s);
        const dSdk = mkTmp();
        const dFast = mkTmp();
        const oracle = new sdk.JsonlLocalAgentStore(dSdk).checkpoints;
        let fast = mkFast(dFast, sdk);
        const ops = Array.from({ length: 50 }, () => genOp(r));
        for (const [i, op] of ops.entries()) {
          // 每 10 步模拟一次进程重启：新实例从文件重新建索引
          if (i > 0 && i % 10 === 0) fast = mkFast(dFast, sdk);
          const want = await exec(oracle, op);
          const got = await exec(fast, op);
          expect(got, `第 ${i} 步 ${JSON.stringify({ ...op, d: undefined })}`).toEqual(want);
        }
        expect(readRaw(dFast).equals(readRaw(dSdk))).toBe(true);
        // 重启后列出全部，与 SDK 一致
        const reborn = mkFast(dFast, sdk);
        expect(await exec(reborn, { t: "list", f: { limit: 100 } })).toEqual(
          await exec(oracle, { t: "list", f: { limit: 100 } }),
        );
      },
      60_000,
    );
  }
});

describe("基本语义与 SDK 一致", () => {
  it("get 未命中返回 null；空 blob 返回空 Buffer 而不是 null", async () => {
    const cp = mkFast(mkTmp(), sdk);
    expect(await cp.get({ agentId: A, blobId: "nope" })).toBeNull();
    await cp.create({ agentId: A, blobId: "empty", data: new Uint8Array(0) });
    const got = await cp.get({ agentId: A, blobId: "empty" });
    expect(got).not.toBeNull();
    expect(got!.length).toBe(0);
    const oracle = new sdk.JsonlLocalAgentStore(mkTmp()).checkpoints;
    await oracle.create({ agentId: A, blobId: "empty", data: new Uint8Array(0) });
    expect((await oracle.get({ agentId: A, blobId: "empty" }))!.length).toBe(0);
  });

  it("重复 create / update 不存在的 blob：报错文案与 SDK 逐字一致", async () => {
    const fast = mkFast(mkTmp(), sdk);
    const oracle = new sdk.JsonlLocalAgentStore(mkTmp()).checkpoints;
    for (const cp of [fast, oracle]) await cp.create({ agentId: A, blobId: "b", data: Buffer.from("x") });
    const dup = (cp: LocalAgentStoreCheckpoints) =>
      cp.create({ agentId: A, blobId: "b", data: Buffer.from("y") }).catch((e: Error) => e.message);
    const miss = (cp: LocalAgentStoreCheckpoints) =>
      cp.update({ agentId: A, blobId: "zzz", data: Buffer.from("y") }).catch((e: Error) => e.message);
    expect(await dup(fast)).toBe(await dup(oracle));
    expect(await miss(fast)).toBe(await miss(oracle));
    expect(await dup(fast)).toContain("already exists");
    expect(await miss(fast)).toContain("not found");
  });

  it("不同 agent 可以有相同 blobId（内容寻址）；delete 按 agent 过滤只删自己的", async () => {
    const cp = mkFast(mkTmp(), sdk);
    await cp.create({ agentId: "a1", blobId: "same", data: Buffer.from("1") });
    await cp.create({ agentId: "a2", blobId: "same", data: Buffer.from("2") });
    await cp.delete({ filter: { agentIds: ["a1"] } });
    expect(await cp.get({ agentId: "a1", blobId: "same" })).toBeNull();
    expect(sameBytes(await cp.get({ agentId: "a2", blobId: "same" }), Buffer.from("2"))).toBe(true);
  });

  it("update 内容相同是空操作（不重写文件）；内容不同原位替换、行序不变", async () => {
    const dir = mkTmp();
    const cp = mkFast(dir, sdk);
    await seed(cp, 6);
    const before = readRaw(dir);
    await cp.update({ agentId: A, blobId: "b2", data: blobData(2) });
    expect(readRaw(dir).equals(before)).toBe(true);
    expect(cp.getStats().updateNoop).toBe(1);
    expect(cp.getStats().rewrites).toBe(0);

    const changed = Buffer.from("CHANGED-and-longer-than-before".repeat(3));
    await cp.update({ agentId: A, blobId: "b2", data: changed });
    expect(cp.getStats().rewrites).toBe(1);
    expect(await allBlobsOk(cp, 6, { 2: changed })).toBe(true);
    expect(await sdkReaderOk(dir, sdk, 6, { 2: changed })).toBe(true);
    // 行序不变：list 的顺序（文件顺序）仍是 b0..b5
    const lines = readRaw(dir).toString("utf8").trim().split("\n");
    expect(lines.map((l) => (JSON.parse(l) as { blobId: string }).blobId)).toEqual(
      ["b0", "b1", "b2", "b3", "b4", "b5"],
    );
  });

  it("delete 无匹配不重写文件（SDK 会白重写一遍）", async () => {
    const dir = mkTmp();
    const cp = mkFast(dir, sdk);
    await seed(cp, 3);
    await cp.delete({ filter: { agentIds: ["nobody"] } });
    expect(cp.getStats().rewrites).toBe(0);
    expect(await allBlobsOk(cp, 3)).toBe(true);
  });

  it("delete 之后同一实例继续 create / get；重启后一致；SDK 可读", async () => {
    const dir = mkTmp();
    const cp = mkFast(dir, sdk);
    await seed(cp, 10);
    await cp.delete({ filter: { agentIds: [A], blobIds: ["b3", "b4"] } });
    expect(await cp.get({ agentId: A, blobId: "b3" })).toBeNull();
    await cp.create({ agentId: A, blobId: "b3", data: Buffer.from("again") });
    expect(sameBytes(await cp.get({ agentId: A, blobId: "b3" }), Buffer.from("again"))).toBe(true);
    const reborn = mkFast(dir, sdk);
    expect(sameBytes(await reborn.get({ agentId: A, blobId: "b3" }), Buffer.from("again"))).toBe(true);
    expect(await reborn.get({ agentId: A, blobId: "b4" })).toBeNull();
    const oracle = new sdk.JsonlLocalAgentStore(dir).checkpoints;
    expect(await oracle.get({ agentId: A, blobId: "b4" })).toBeNull();
    expect(sameBytes(await oracle.get({ agentId: A, blobId: "b9" }), blobData(9))).toBe(true);
  });
});

// ───────────────────────────── 2. 互操作 ─────────────────────────────

describe("文件格式双向互操作", () => {
  it("新写旧读：create / update / delete 之后 SDK 原实现读到一致内容", async () => {
    const dir = mkTmp();
    const cp = mkFast(dir, sdk);
    await seed(cp, 20);
    await cp.update({ agentId: A, blobId: "b7", data: Buffer.from("U7") });
    await cp.delete({ filter: { agentIds: [A], blobIds: ["b1", "b2"] } });
    const oracle = new sdk.JsonlLocalAgentStore(dir).checkpoints;
    expect(sameBytes(await oracle.get({ agentId: A, blobId: "b7" }), Buffer.from("U7"))).toBe(true);
    expect(await oracle.get({ agentId: A, blobId: "b1" })).toBeNull();
    expect(sameBytes(await oracle.get({ agentId: A, blobId: "b19" }), blobData(19))).toBe(true);
    expect((await oracle.list({ filter: { limit: 1000 } })).items.length).toBe(18);
  });

  it("旧写新读：SDK 写出的文件（含非 ASCII id）新实例直接读", async () => {
    const dir = mkTmp();
    const oracle = new sdk.JsonlLocalAgentStore(dir).checkpoints;
    await seed(oracle, 12);
    await oracle.create({ agentId: "代理-é", blobId: "块-ß", data: Buffer.from("unicode") });
    const cp = mkFast(dir, sdk);
    expect(await allBlobsOk(cp, 12)).toBe(true);
    expect(sameBytes(await cp.get({ agentId: "代理-é", blobId: "块-ß" }), Buffer.from("unicode"))).toBe(true);
    expect(cp.getStats().blobs).toBe(13);
  });

  it("交替写：fast 追加 → SDK 追加（整文件重写）→ 同一 fast 实例追赶；再换新实例", async () => {
    const dir = mkTmp();
    const cp = mkFast(dir, sdk);
    await seed(cp, 5);
    const oracle = new sdk.JsonlLocalAgentStore(dir).checkpoints;
    await oracle.create({ agentId: A, blobId: "from-sdk", data: Buffer.from("S") });
    // 同一实例没重启：get 未命中 → 追赶外部追加
    expect(sameBytes(await cp.get({ agentId: A, blobId: "from-sdk" }), Buffer.from("S"))).toBe(true);
    expect(cp.getStats().catchUps).toBeGreaterThanOrEqual(1);
    await cp.create({ agentId: A, blobId: "after", data: Buffer.from("F") });
    const reborn = mkFast(dir, sdk);
    expect(await allBlobsOk(reborn, 5)).toBe(true);
    expect(sameBytes(await reborn.get({ agentId: A, blobId: "from-sdk" }), Buffer.from("S"))).toBe(true);
    expect(sameBytes(await reborn.get({ agentId: A, blobId: "after" }), Buffer.from("F"))).toBe(true);
    expect(sameBytes(await oracle.get({ agentId: A, blobId: "after" }), Buffer.from("F"))).toBe(true);
  });

  it("违反单写者：外部 SDK 改写了前面的行（偏移全错位）→ 不返回脏数据，重建后自愈", async () => {
    const dir = mkTmp();
    const cp = mkFast(dir, sdk);
    await seed(cp, 10);
    const oracle = new sdk.JsonlLocalAgentStore(dir).checkpoints;
    const longer = Buffer.from("L".repeat(500));
    await oracle.update({ agentId: A, blobId: "b2", data: longer }); // b2 之后所有行后移
    expect(sameBytes(await cp.get({ agentId: A, blobId: "b5" }), blobData(5))).toBe(true);
    expect(sameBytes(await cp.get({ agentId: A, blobId: "b2" }), longer)).toBe(true);
    expect(await allBlobsOk(cp, 10, { 2: longer })).toBe(true);
    expect(cp.getStats().rebuilds).toBeGreaterThanOrEqual(1);
  });

  it("违反单写者：外部把两条等长记录对调（偏移处恰是另一条合法行）→ 行内 id 校验拦住，绝不返回别人的数据", async () => {
    // 比"偏移落在行中间"更危险：偏移处是一条完整、头尾都合法的别人的行。
    // 快路径（可打印 ASCII）与慢路径（引号 / 中文 id 走 JSON.parse）各验一遍。
    const pairs: Array<[string, string]> = [
      ["agent-1", "agent-2"],
      ['q"1', 'q"2'],
      ["代理一", "代理二"],
    ];
    for (const [idA, idB] of pairs) {
      const dir = mkTmp();
      const cp = mkFast(dir, sdk);
      const d1 = Buffer.alloc(64, 1);
      const d2 = Buffer.alloc(64, 2);
      // blobId 相同、agentId 不同：只有 agentId 校验能分辨
      await cp.create({ agentId: idA, blobId: "same", data: d1 });
      await cp.create({ agentId: idB, blobId: "same", data: d2 });
      await cp.warmUp();

      const [l0, l1] = fs.readFileSync(fileOf(dir), "utf8").split("\n");
      expect(Buffer.byteLength(l0)).toBe(Buffer.byteLength(l1)); // 前提：两行等长，旧偏移仍落在整行上
      fs.writeFileSync(fileOf(dir), `${l1}\n${l0}\n`);

      expect(sameBytes(await cp.get({ agentId: idA, blobId: "same" }), d1)).toBe(true);
      expect(sameBytes(await cp.get({ agentId: idB, blobId: "same" }), d2)).toBe(true);
      expect(cp.getStats().rebuilds).toBeGreaterThanOrEqual(1);
    }

    // blobId 不同、agentId 相同：只有 blobId 校验能分辨
    const dir = mkTmp();
    const cp = mkFast(dir, sdk);
    await cp.create({ agentId: A, blobId: "x1", data: Buffer.alloc(64, 7) });
    await cp.create({ agentId: A, blobId: "x2", data: Buffer.alloc(64, 8) });
    await cp.warmUp();
    const [l0, l1] = fs.readFileSync(fileOf(dir), "utf8").split("\n");
    fs.writeFileSync(fileOf(dir), `${l1}\n${l0}\n`);
    expect(sameBytes(await cp.get({ agentId: A, blobId: "x1" }), Buffer.alloc(64, 7))).toBe(true);
    expect(sameBytes(await cp.get({ agentId: A, blobId: "x2" }), Buffer.alloc(64, 8))).toBe(true);
  });
});

// ───────────────────────────── 3. 文件尾形态与异常行 ─────────────────────────────

describe("文件尾形态", () => {
  it("空 / 不存在的文件：get 为 null、create 后可读", async () => {
    const dir = mkTmp();
    const cp = mkFast(dir, sdk);
    expect(await cp.get({ agentId: A, blobId: "x" })).toBeNull();
    expect((await cp.list()).items).toEqual([]);
    await cp.create({ agentId: A, blobId: "x", data: Buffer.from("1") });
    expect(sameBytes(await mkFast(dir, sdk).get({ agentId: A, blobId: "x" }), Buffer.from("1"))).toBe(true);
    const dir2 = mkTmp();
    fs.writeFileSync(fileOf(dir2), "");
    expect(await mkFast(dir2, sdk).get({ agentId: A, blobId: "x" })).toBeNull();
  });

  it("半行尾巴（上次写到一半崩了）：不丢已有数据，首次追加前截掉，SDK 仍可读", async () => {
    const dir = mkTmp();
    await seed(mkFast(dir, sdk), 5);
    fs.appendFileSync(fileOf(dir), '{"agentId":"agent-1","blobId":"half","dataBase64":"AAAA');
    const cp = mkFast(dir, sdk);
    expect(await allBlobsOk(cp, 5)).toBe(true);
    expect(await cp.get({ agentId: A, blobId: "half" })).toBeNull();
    // 只读不修复：扫描本身没有动文件
    expect(readRaw(dir).toString("utf8")).toContain('"blobId":"half"');
    await cp.create({ agentId: A, blobId: "b5", data: blobData(5) });
    expect(readRaw(dir).toString("utf8")).not.toContain("half");
    expect(await allBlobsOk(cp, 6)).toBe(true);
    expect(await allBlobsOk(mkFast(dir, sdk), 6)).toBe(true);
    expect(await sdkReaderOk(dir, sdk, 6)).toBe(true);
  });

  it("完整 JSON 但缺结尾换行（SDK 能读）：并入索引、追加时先补换行、不粘连", async () => {
    const dir = mkTmp();
    await seed(mkFast(dir, sdk), 5);
    const raw = readRaw(dir);
    fs.writeFileSync(fileOf(dir), raw.subarray(0, raw.length - 1)); // 去掉最后的 \n
    expect(await sdkReaderOk(dir, sdk, 5)).toBe(true); // SDK 本来就能读
    const cp = mkFast(dir, sdk);
    expect(await allBlobsOk(cp, 5)).toBe(true); // 最后一个 blob 没被当半行丢掉
    expect(cp.getStats().blobs).toBe(5);
    await cp.create({ agentId: A, blobId: "b5", data: blobData(5) });
    const text = readRaw(dir).toString("utf8");
    expect(text).not.toContain("}{");
    expect(text.endsWith("\n")).toBe(true);
    expect(await allBlobsOk(mkFast(dir, sdk), 6)).toBe(true);
    expect(await sdkReaderOk(dir, sdk, 6)).toBe(true);
  });

  it("缺换行的尾行遇到重写（update）：换行被补上", async () => {
    const dir = mkTmp();
    await seed(mkFast(dir, sdk), 4);
    const raw = readRaw(dir);
    fs.writeFileSync(fileOf(dir), raw.subarray(0, raw.length - 1));
    const cp = mkFast(dir, sdk);
    await cp.update({ agentId: A, blobId: "b0", data: Buffer.from("N") });
    expect(readRaw(dir).toString("utf8").endsWith("\n")).toBe(true);
    expect(await allBlobsOk(mkFast(dir, sdk), 4, { 0: Buffer.from("N") })).toBe(true);
  });

  it("中间的损坏行：跳过并告警，其余可读；头合法但尾巴被截断的行不会解出垃圾", async () => {
    const dir = mkTmp();
    await seed(mkFast(dir, sdk), 6);
    const lines = readRaw(dir).toString("utf8").split("\n");
    lines[2] = '{"agentId":"agent-1","blobId":"b2","dataBase64":"AAA'; // 头合法、尾巴没了
    lines.splice(4, 0, "not json at all");
    fs.writeFileSync(fileOf(dir), lines.join("\n"));
    const warns: string[] = [];
    const cp = mkFast(dir, sdk, { onWarn: (m) => void warns.push(m) });
    expect(await cp.get({ agentId: A, blobId: "b2" })).toBeNull();
    for (const i of [0, 1, 3, 4, 5]) {
      expect(sameBytes(await cp.get({ agentId: A, blobId: `b${i}` }), blobData(i))).toBe(true);
    }
    expect(cp.getStats().corruptSkipped).toBe(2);
    expect(warns.length).toBe(1);
    // 有意差异：SDK 对中间损坏行直接抛错，这里更宽容
    await expect(
      new sdk.JsonlLocalAgentStore(dir).checkpoints.get({ agentId: A, blobId: "b0" }),
    ).rejects.toThrow(/Corrupt local agent store/);
  });

  it("CRLF 与混合换行：读写都正常，SDK 也能读", async () => {
    const dir = mkTmp();
    await seed(mkFast(dir, sdk), 30);
    const raw = readRaw(dir).toString("latin1");
    fs.writeFileSync(fileOf(dir), Buffer.from(raw.replace(/\n/g, "\r\n"), "latin1"));
    const cp = mkFast(dir, sdk);
    expect(await allBlobsOk(cp, 30)).toBe(true);
    await cp.update({ agentId: A, blobId: "b5", data: Buffer.from("NEW") });
    expect(await allBlobsOk(cp, 30, { 5: Buffer.from("NEW") })).toBe(true);
    await cp.create({ agentId: A, blobId: "b30", data: blobData(30) }); // 追加 LF 行 → 混合换行
    expect(await allBlobsOk(mkFast(dir, sdk), 31, { 5: Buffer.from("NEW") })).toBe(true);
    expect(await sdkReaderOk(dir, sdk, 31, { 5: Buffer.from("NEW") })).toBe(true);
  });

  it("空行 / 纯空白行被忽略，不算损坏", async () => {
    const dir = mkTmp();
    await seed(mkFast(dir, sdk), 3);
    const lines = readRaw(dir).toString("utf8").split("\n");
    lines.splice(1, 0, "", "   ", "\r");
    fs.writeFileSync(fileOf(dir), lines.join("\n"));
    const cp = mkFast(dir, sdk);
    expect(await allBlobsOk(cp, 3)).toBe(true);
    expect(cp.getStats().corruptSkipped).toBe(0);
  });

  it("重复键行：取第一个（与 SDK 的 find 一致）", async () => {
    const dir = mkTmp();
    const row = (data: string) =>
      JSON.stringify({ agentId: A, blobId: "dup", dataBase64: Buffer.from(data).toString("base64") });
    fs.writeFileSync(fileOf(dir), `${row("FIRST")}\n${row("SECOND")}\n`);
    const cp = mkFast(dir, sdk);
    const oracle = new sdk.JsonlLocalAgentStore(dir).checkpoints;
    expect(Buffer.from((await cp.get({ agentId: A, blobId: "dup" }))!).toString()).toBe("FIRST");
    expect(Buffer.from((await oracle.get({ agentId: A, blobId: "dup" }))!).toString()).toBe("FIRST");
    expect(cp.getStats().duplicateSkipped).toBe(1);
  });

  it("特殊 id：中文 / 引号 / 反斜杠 / 控制字符，快路径放弃后走整行解析且 key 不错乱", async () => {
    const dir = mkTmp();
    const ids = ["代理-é-ß", 'a"quote', "back\\slash", "tab\there", "new\nline", "nul\u0000x", "a", "a\u0000b"];
    const cp = mkFast(dir, sdk);
    for (const [i, id] of ids.entries()) {
      await cp.create({ agentId: id, blobId: `blob-${id}`, data: Buffer.from(`d${i}`) });
    }
    for (const reader of [cp, mkFast(dir, sdk), new sdk.JsonlLocalAgentStore(dir).checkpoints]) {
      for (const [i, id] of ids.entries()) {
        expect(
          sameBytes(await reader.get({ agentId: id, blobId: `blob-${id}` }), Buffer.from(`d${i}`)),
          `id=${JSON.stringify(id)}`,
        ).toBe(true);
      }
    }
    // (agentId="a", blobId="\u0000b…") 与 (agentId="a\u0000b", …) 不会撞 key
    await cp.create({ agentId: "x", blobId: "y\u0000z", data: Buffer.from("1") });
    await cp.create({ agentId: "x\u0000y", blobId: "z", data: Buffer.from("2") });
    expect(sameBytes(await cp.get({ agentId: "x", blobId: "y\u0000z" }), Buffer.from("1"))).toBe(true);
    expect(sameBytes(await cp.get({ agentId: "x\u0000y", blobId: "z" }), Buffer.from("2"))).toBe(true);
  });

  it("大 blob 与混合尺寸：整行跨越 8MB 扫描块，重启扫描后全部正确（含 SDK 抽样）", async () => {
    const dir = mkTmp();
    const r = rng(42);
    const cp = mkFast(dir, sdk);
    const data: Buffer[] = [];
    let total = 0;
    for (let i = 0; total < 26 << 20; i++) {
      // 1KB ~ 3MB 随机，穿插一个 9MB 的巨型 blob
      const n = i === 6 ? 9 << 20 : 1024 + Math.floor(r() * (3 << 20));
      const b = Buffer.alloc(n, i & 0xff);
      b.writeUInt32LE(i, 0);
      data.push(b);
      total += n;
      await cp.create({ agentId: A, blobId: `big${i}`, data: b });
    }
    const reborn = mkFast(dir, sdk);
    for (const [i, b] of data.entries()) {
      expect(sameBytes(await reborn.get({ agentId: A, blobId: `big${i}` }), b), `blob ${i}`).toBe(true);
    }
    expect(reborn.getStats().blobs).toBe(data.length);
    const oracle = new sdk.JsonlLocalAgentStore(dir).checkpoints;
    expect(sameBytes(await oracle.get({ agentId: A, blobId: "big6" }), data[6])).toBe(true);
    expect(sameBytes(await oracle.get({ agentId: A, blobId: `big${data.length - 1}` }), data[data.length - 1])).toBe(true);
  }, 120_000);

  it("短读（每次 read 只返回一半字节）：扫描与 get 依然正确", async () => {
    const dir = mkTmp();
    await seed(mkFast(dir, sdk), 40);
    const { fs: halfFs } = faultyFs({
      wrapFd: (fd) => ({
        ...fd,
        read: (buf, off, len, pos) => fd.read(buf, off, Math.max(1, Math.ceil(len / 2)), pos),
      }),
    });
    const cp = mkFast(dir, sdk, { fs: halfFs });
    expect(await allBlobsOk(cp, 40)).toBe(true);
  });
});

// ───────────────────────────── 4. 并发 / 队列 / 耐久性 ─────────────────────────────

describe("并发与队列语义", () => {
  it("并发 create 同一个 key：恰好一个成功，另一个报 already exists", async () => {
    const cp = mkFast(mkTmp(), sdk);
    const res = await Promise.allSettled([
      cp.create({ agentId: A, blobId: "race", data: Buffer.from("1") }),
      cp.create({ agentId: A, blobId: "race", data: Buffer.from("2") }),
      cp.create({ agentId: A, blobId: "race", data: Buffer.from("3") }),
    ]);
    expect(res.filter((x) => x.status === "fulfilled").length).toBe(1);
    expect(res.filter((x) => x.status === "rejected").length).toBe(2);
  });

  it("写队列错误隔离：一个写失败不影响后续写", async () => {
    const cp = mkFast(mkTmp(), sdk);
    await cp.create({ agentId: A, blobId: "x", data: Buffer.from("1") });
    const [bad, good] = await Promise.allSettled([
      cp.create({ agentId: A, blobId: "x", data: Buffer.from("dup") }),
      cp.create({ agentId: A, blobId: "y", data: Buffer.from("2") }),
    ]);
    expect(bad.status).toBe("rejected");
    expect(good.status).toBe("fulfilled");
    expect(sameBytes(await cp.get({ agentId: A, blobId: "y" }), Buffer.from("2"))).toBe(true);
  });

  it("并发 200 个 get：同时打开的读句柄不超过 32（防止撑爆 fd 上限）", async () => {
    const dir = mkTmp();
    await seed(mkFast(dir, sdk), 50);
    const { fs: spyFs, log } = faultyFs();
    const cp = mkFast(dir, sdk, { fs: spyFs });
    await cp.warmUp(); // 扫描的句柄不计入
    log.peakOpen = 0;
    const gets = Array.from({ length: 200 }, (_, i) => cp.get({ agentId: A, blobId: `b${i % 50}` }));
    const out = await Promise.all(gets);
    out.forEach((g, i) => expect(sameBytes(g, blobData(i % 50))).toBe(true));
    expect(log.peakOpen).toBeLessThanOrEqual(32);
  });

  it("混合并发：读 + 追加 + 重写式 update + delete 交错，稳定 blob 读取 0 失败，结果正确", async () => {
    const dir = mkTmp();
    const cp = mkFast(dir, sdk);
    const N = 200;
    await seed(cp, N);
    const r = rng(7);
    let bad = 0;
    const ops: Array<Promise<unknown>> = [];
    for (let k = 0; k < 400; k++) {
      const i = Math.floor(r() * 150); // b0..b149 全程不被修改
      ops.push(
        cp.get({ agentId: A, blobId: `b${i}` }).then(
          (g) => void (sameBytes(g, blobData(i)) || bad++),
          () => void bad++,
        ),
      );
    }
    for (let i = 0; i < 15; i++) ops.push(cp.create({ agentId: A, blobId: `n${i}`, data: blobData(1000 + i) }));
    for (const i of [170, 171, 172]) ops.push(cp.update({ agentId: A, blobId: `b${i}`, data: Buffer.from(`UPD-${i}`) }));
    ops.push(cp.delete({ filter: { agentIds: [A], blobIds: ["b190", "b191"] } }));
    const settled = await Promise.allSettled(ops);
    expect(settled.filter((s) => s.status === "rejected").length).toBe(0);
    expect(bad).toBe(0);
    for (const reader of [cp, mkFast(dir, sdk)]) {
      for (const i of [170, 171, 172]) {
        expect(sameBytes(await reader.get({ agentId: A, blobId: `b${i}` }), Buffer.from(`UPD-${i}`))).toBe(true);
      }
      expect(await reader.get({ agentId: A, blobId: "b190" })).toBeNull();
      const listed = await reader.list({ filter: { agentIds: [A], limit: 100000 } });
      expect(listed.items.length).toBe(N + 15 - 2);
    }
    const oracle = new sdk.JsonlLocalAgentStore(dir).checkpoints;
    expect(sameBytes(await oracle.get({ agentId: A, blobId: "b171" }), Buffer.from("UPD-171"))).toBe(true);
    expect(await oracle.get({ agentId: A, blobId: "b191" })).toBeNull();
  }, 60_000);

  it("touchedAgentIds：只含本实例写过的 agent；agentIds() 含索引里全部", async () => {
    const dir = mkTmp();
    await seed(mkFast(dir, sdk), 3, "old-agent"); // 上一个「进程」写的
    const cp = mkFast(dir, sdk);
    expect([...cp.touchedAgentIds()]).toEqual([]);
    await cp.create({ agentId: "new-agent", blobId: "n", data: Buffer.from("1") });
    await cp.create({ agentId: "new-agent", blobId: "n", data: Buffer.from("1") }).catch(() => undefined);
    expect([...cp.touchedAgentIds()].sort()).toEqual(["new-agent"]);
    expect((await cp.agentIds()).sort()).toEqual(["new-agent", "old-agent"]);
  });

  // 「保护先于可见」：文件里出现这个 agent 的第一个字节起，GC 就能从文件追赶到它，所以 touched 必须在
  // 请求一进来（同步，早于入队 / 落盘）就标记。等写完才标记会让 GC 把刚创建的新 agent 当幽灵孤儿清掉。
  it("touchedAgentIds：create / update 一调用就同步标记（早于落盘），写失败也留着", async () => {
    const dir = mkTmp();
    const cp = mkFast(dir, sdk);

    const p1 = cp.create({ agentId: "new-agent", blobId: "n", data: Buffer.from("1") });
    expect(cp.touchedAgentIds().has("new-agent")).toBe(true); // 同步：任务还没跑
    await p1;

    // update 一个不存在的 blob 会失败；agent 仍被保护（只会多保护、不会多删），但不进索引
    const p2 = cp.update({ agentId: "upd-agent", blobId: "x", data: Buffer.from("2") });
    expect(cp.touchedAgentIds().has("upd-agent")).toBe(true);
    await expect(p2).rejects.toThrow(/not found/);

    expect([...cp.touchedAgentIds()].sort()).toEqual(["new-agent", "upd-agent"]);
    expect(await cp.agentIds()).toEqual(["new-agent"]);
  });
});

describe("耐久性", () => {
  it("每次 create 恰好 fsync 一次，且从不在追加句柄上做 sync / truncate / read（Windows 追加句柄语义）", async () => {
    const dir = mkTmp();
    const { fs: strictFs, log } = faultyFs({ windowsAppendSemantics: true });
    const cp = mkFast(dir, sdk, { fs: strictFs, platform: "win32" });
    await seed(cp, 5);
    expect(log.syncs.length).toBe(5);
    expect(log.syncs.every((s) => s.flags === "r+")).toBe(true);
    expect(log.truncates.length).toBe(0);
    expect(await allBlobsOk(mkFast(dir, sdk), 5)).toBe(true);
  });
});

// ───────────────────────────── 5. append 失败回滚 vs 并发读者 ─────────────────────────────

/**
 * 回滚只改文件、不改内存。写者「整行已落盘、登记索引之前」失败（close / fsync 报错）时，窗口内的并发读者
 * （GC 的 agentIds()、list()、get 未命中——都不进写队列）的 catchUp 会把这一行并进索引、并推进 size / seen。
 * 写者随后把文件截回去，内存却留着幽灵条目、size 比文件长：之后每次 create 都 tail mismatch，重试同内容
 * 报 already exists，直到重启。回滚后内存状态必须以文件为准。
 */
describe("append 失败回滚与并发读者", () => {
  type FailAt = "fsync" | "close";
  type Reader = "none" | "list" | "agentIds" | "get-miss";
  const listAll = (cp: Cp) => cp.list({ filter: { agentIds: [A], limit: 1000 } });

  /** 在「写者整行已落盘、尚未登记索引」的窗口内插入一个并发读者，然后让写者报 EIO */
  const mkRig = (dir: string, failAt: FailAt, reader: Reader) => {
    const st = { armed: false, fired: 0, blobsBefore: -1, blobsAfter: -1 };
    // cp 在下面才创建：钩子是闭包，等写者真的失败时才会执行，那时 cp 早已初始化
    const inWindow = async (): Promise<void> => {
      st.fired += 1;
      st.blobsBefore = cp.getStats().blobs;
      if (reader === "list") await listAll(cp);
      else if (reader === "agentIds") await cp.agentIds();
      else if (reader === "get-miss") await cp.get({ agentId: A, blobId: "no-such-blob" });
      st.blobsAfter = cp.getStats().blobs;
    };
    const { fs: fsx } = faultyFs({
      wrapFd: (fd, meta) => ({
        ...fd,
        sync: async () => {
          if (failAt !== "fsync" || !st.armed) return fd.sync();
          st.armed = false;
          await inWindow();
          throw mkErr("EIO");
        },
        close: async () => {
          if (failAt !== "close" || meta.flags !== "a" || !st.armed) return fd.close();
          st.armed = false;
          await fd.close(); // 句柄确实关了，只是 close 报告失败（NFS 写回错误的形态）
          await inWindow();
          throw mkErr("EIO");
        },
      }),
    });
    const cp: Cp = mkFast(dir, sdk, { fs: fsx });
    return { cp, st };
  };

  const cases = (["fsync", "close"] as const).flatMap((f) =>
    (["list", "agentIds", "get-miss", "none"] as const).map((r): [FailAt, Reader] => [f, r]),
  );

  it.each(cases)(
    "%s 失败 + 并发读者 %s：回滚后内存与文件一致，后续 create 不卡死",
    async (failAt, reader) => {
      const dir = mkTmp();
      const { cp, st } = mkRig(dir, failAt, reader);
      await cp.create({ agentId: A, blobId: "b0", data: blobData(0) });
      const bytesBefore = readRaw(dir).length;

      st.armed = true;
      await expect(cp.create({ agentId: A, blobId: "b1", data: blobData(1) })).rejects.toThrow(/EIO/);

      // 前置条件（不满足说明这条用例没测到该场景，而不是被测代码有问题）：注入确实触发；
      // 读者确实在失败窗口内把写者刚落盘、尚未登记的那一行并进了索引（none 变体则没有读者）。
      expect(st.fired).toBe(1);
      expect(st.blobsAfter).toBe(st.blobsBefore + (reader === "none" ? 0 : 1));

      const symptoms = {
        文件相对失败前多出的字节: readRaw(dir).length - bytesBefore,
        失败后的list: (await listAll(cp)).items,
        create新blob: await cp.create({ agentId: A, blobId: "b2", data: blobData(2) }).then(() => "ok", msg),
        重试同一个blob: await cp.create({ agentId: A, blobId: "b1", data: blobData(1) }).then(() => "ok", msg),
      };
      expect(symptoms).toEqual({
        文件相对失败前多出的字节: 0,
        失败后的list: ["b0"],
        create新blob: "ok",
        重试同一个blob: "ok",
      });

      expect(await allBlobsOk(cp, 3)).toBe(true);
      expect(await allBlobsOk(mkFast(dir, sdk), 3)).toBe(true); // 冷启动重扫的结果与热状态一致
      expect(await sdkReaderOk(dir, sdk, 3)).toBe(true); // SDK 原实现读同一文件也一致
    },
  );

  it("磁盘写满（写到一半报错）+ 并发读者：读者碰到的是半行、不并进索引；回滚后正常", async () => {
    const dir = mkTmp();
    let armed = false;
    let blobsSeenByReader = -1;
    const { fs: fsx } = faultyFs({
      wrapFd: (fd, meta) => ({
        ...fd,
        appendFile: async (d) => {
          if (meta.flags !== "a" || !armed) return fd.appendFile(d);
          armed = false;
          await fd.appendFile(d.subarray(0, d.length >> 1)); // 只写了一半
          await listAll(cp);
          blobsSeenByReader = cp.getStats().blobs;
          throw mkErr("ENOSPC");
        },
      }),
    });
    const cp: Cp = mkFast(dir, sdk, { fs: fsx }); // 钩子里引用它：同上，调用时已初始化
    await cp.create({ agentId: A, blobId: "b0", data: blobData(0) });
    const bytesBefore = readRaw(dir).length;

    armed = true;
    await expect(cp.create({ agentId: A, blobId: "b1", data: blobData(1) })).rejects.toThrow(/ENOSPC/);
    expect(blobsSeenByReader).toBe(1); // 前置条件：读者碰到的是半行，没把它当条目
    expect(readRaw(dir).length).toBe(bytesBefore);

    await cp.create({ agentId: A, blobId: "b1", data: blobData(1) });
    await cp.create({ agentId: A, blobId: "b2", data: blobData(2) });
    expect(await allBlobsOk(cp, 3)).toBe(true);
    expect(await sdkReaderOk(dir, sdk, 3)).toBe(true);
  });

  it("回滚本身也失败（truncate 报错）：丢弃索引，下一次写重扫、截掉残行后自愈", async () => {
    const dir = mkTmp();
    let failAppend = false;
    let failTruncate = false;
    let truncateFailures = 0;
    const { fs: fsx } = faultyFs({
      wrapFd: (fd, meta) => ({
        ...fd,
        appendFile: async (d) => {
          if (meta.flags !== "a" || !failAppend) return fd.appendFile(d);
          failAppend = false;
          await fd.appendFile(d.subarray(0, d.length >> 1)); // 写了半行
          throw mkErr("ENOSPC");
        },
        truncate: async (len) => {
          if (!failTruncate) return fd.truncate(len);
          failTruncate = false;
          truncateFailures += 1;
          throw mkErr("EIO");
        },
      }),
    });
    const cp = mkFast(dir, sdk, { fs: fsx });
    await cp.create({ agentId: A, blobId: "b0", data: blobData(0) });
    const bytesBefore = readRaw(dir).length;

    failAppend = true;
    failTruncate = true;
    await expect(cp.create({ agentId: A, blobId: "b1", data: blobData(1) })).rejects.toThrow(/ENOSPC/);
    // 前置条件：回滚确实失败了，残行还留在文件里
    expect(truncateFailures).toBe(1);
    expect(readRaw(dir).length).toBeGreaterThan(bytesBefore);

    const symptoms = {
      create新blob: await cp.create({ agentId: A, blobId: "b2", data: blobData(2) }).then(() => "ok", msg),
      文件里全是完整行: fileLines(dir).every(parses),
      行数: fileLines(dir).length,
    };
    expect(symptoms).toEqual({ create新blob: "ok", 文件里全是完整行: true, 行数: 2 });

    await cp.create({ agentId: A, blobId: "b1", data: blobData(1) });
    expect(await allBlobsOk(cp, 3)).toBe(true);
    expect(await sdkReaderOk(dir, sdk, 3)).toBe(true);
  });

  it("在途 catchUp 跨越回滚 + 重建：读者读到的整行不能回写 size / seen（修复依赖 doCatchUp 的 index / epoch 检查）", async () => {
    const dir = mkTmp();
    let armed = false;
    let holdNextReaderClose = false;
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let markParked!: () => void;
    const parked = new Promise<void>((r) => (markParked = r));
    let reader!: Promise<string[]>;

    const { fs: fsx } = faultyFs({
      wrapFd: (fd, meta) => ({
        ...fd,
        sync: async () => {
          if (!armed) return fd.sync();
          armed = false;
          holdNextReaderClose = true;
          reader = cp.agentIds(); // 此刻整行已落盘：读者会 scan 到它，并停在 close 前
          await parked;
          throw mkErr("EIO");
        },
        close: async () => {
          if (meta.flags === "r" && holdNextReaderClose) {
            holdNextReaderClose = false;
            markParked(); // 扫描结果（含 b1 那一行）已就绪，还没返回给 doCatchUp
            await released;
          }
          return fd.close();
        },
      }),
    });
    const cp: Cp = mkFast(dir, sdk, { fs: fsx }); // 钩子里引用它：调用时已初始化

    await cp.create({ agentId: A, blobId: "b0", data: blobData(0) });
    const bytesBefore = readRaw(dir).length;

    armed = true;
    await expect(cp.create({ agentId: A, blobId: "b1", data: blobData(1) })).rejects.toThrow(/EIO/);

    // 前置条件：文件已回滚；别的调用方（get 命中，不 catchUp）先触发了重建，size / seen 已按回滚后的真实文件重置；
    // 读者还停在 close 前，手里握着旧扫描结果
    expect(readRaw(dir).length).toBe(bytesBefore);
    expect(await cp.get({ agentId: A, blobId: "b0" })).not.toBeNull();
    expect(cp.getStats().blobs).toBe(1);

    release();
    await reader;

    // 读者的结果必须被丢弃：否则 size / seen 被推到文件尾之外，后续 create 又 tail mismatch。
    // 注意顺序：必须先让别处触发重建、再放行读者——重建会重置 size / seen，放行得太早会被随后的 load() 覆盖，污染就暴露不出来。
    await cp.create({ agentId: A, blobId: "b2", data: blobData(2) });
    await cp.create({ agentId: A, blobId: "b1", data: blobData(1) });
    expect(await allBlobsOk(cp, 3)).toBe(true);
    expect(await allBlobsOk(mkFast(dir, sdk), 3)).toBe(true);
    expect(await sdkReaderOk(dir, sdk, 3)).toBe(true);
  });
});

// ───────────────────────────── 6. 平台硬化与单写者护栏 ─────────────────────────────

describe("平台硬化：瞬态错误退避重试", () => {
  /** 抖动系数恒为 1.0：退避序列精确可断言（10 → 20 → 40…） */
  const noJitter = (): number => 0.5;
  /** 记录退避等待、不真等 */
  const mkSleeper = () => {
    const slept: number[] = [];
    return {
      slept,
      sleep: async (ms: number): Promise<void> => {
        slept.push(ms);
      },
    };
  };
  const first = { agentId: A, blobId: "b0", data: blobData(0) };
  const delB1 = { filter: { agentIds: [A], blobIds: ["b1"] } };

  it("Windows：open 遇瞬态 EPERM（杀毒 / 索引器占用）→ 指数退避重试，最终成功", async () => {
    const dir = mkTmp();
    let busy = 3;
    const { slept, sleep } = mkSleeper();
    const { fs: fsx, log } = faultyFs({
      open: (_file, flags) => (flags === "a" && busy-- > 0 ? { code: "EPERM" } : null),
    });
    const cp = mkFast(dir, sdk, { fs: fsx, platform: "win32", sleep, random: noJitter });
    await cp.create(first);
    expect(slept).toEqual([10, 20, 40]);
    expect(log.opens.filter((o) => o.flags === "a").length).toBe(4); // 3 次被拒 + 1 次成功
    expect(await allBlobsOk(mkFast(dir, sdk), 1)).toBe(true);
  });

  it("POSIX：open 遇 EPERM 是真权限错误 → 不重试不等待，原样抛出", async () => {
    const { slept, sleep } = mkSleeper();
    const { fs: fsx, log } = faultyFs({
      open: (_file, flags) => (flags === "a" ? { code: "EPERM" } : null),
    });
    const cp = mkFast(mkTmp(), sdk, { fs: fsx, platform: "linux", sleep });
    await expect(cp.create(first)).rejects.toMatchObject({ code: "EPERM" });
    expect(slept).toEqual([]);
    expect(log.opens.filter((o) => o.flags === "a").length).toBe(1);
  });

  it("重试预算耗尽：不无限重试，抛出原始错误码", async () => {
    const { slept, sleep } = mkSleeper();
    const { fs: fsx } = faultyFs({
      open: (_file, flags) => (flags === "a" ? { code: "EBUSY" } : null),
    });
    const cp = mkFast(mkTmp(), sdk, {
      fs: fsx,
      platform: "win32",
      sleep,
      budgetMs: 100,
      random: noJitter,
    });
    await expect(cp.create(first)).rejects.toMatchObject({ code: "EBUSY" });
    expect(slept.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(100); // 一直重试到预算用完才放弃
    expect(slept.length).toBeLessThan(10); // 而不是无限重试
  });

  it("rewrite 的 rename 遇瞬态 EPERM（Windows）→ 重试后成功，数据正确、tmp 不残留", async () => {
    const dir = mkTmp();
    await seed(mkFast(dir, sdk), 5);
    let busy = 2;
    const { slept, sleep } = mkSleeper();
    const { fs: fsx, log } = faultyFs({
      rename: () => (busy-- > 0 ? { code: "EPERM" } : null),
    });
    const cp = mkFast(dir, sdk, { fs: fsx, platform: "win32", sleep, random: noJitter });
    await cp.delete(delB1);
    expect(log.renames).toBe(3); // 2 次被拒 + 1 次成功
    expect(slept).toEqual([10, 20]);
    expect(await cp.get({ agentId: A, blobId: "b1" })).toBeNull();
    for (const i of [0, 2, 3, 4]) {
      expect(sameBytes(await cp.get({ agentId: A, blobId: `b${i}` }), blobData(i))).toBe(true);
    }
    expect(fs.existsSync(tmpFileOf(dir))).toBe(false);
  });

  it("rewrite 的 rename 彻底失败：清理 tmp，原文件字节与索引原样，之后仍可正常读写", async () => {
    const dir = mkTmp();
    await seed(mkFast(dir, sdk), 5);
    const before = readRaw(dir);
    let fail = true;
    const { fs: fsx } = faultyFs({ rename: () => (fail ? { code: "EIO" } : null) });
    const cp = mkFast(dir, sdk, { fs: fsx });

    await expect(cp.delete(delB1)).rejects.toThrow(/EIO/);
    expect(fs.existsSync(tmpFileOf(dir))).toBe(false); // tmp 不残留
    expect(Buffer.compare(readRaw(dir), before)).toBe(0); // 原文件一个字节没动
    expect(await allBlobsOk(cp, 5)).toBe(true); // 索引也原样：b1 还在

    fail = false;
    await cp.delete(delB1);
    expect(await cp.get({ agentId: A, blobId: "b1" })).toBeNull();
    for (const i of [0, 2, 3, 4]) {
      expect(sameBytes(await cp.get({ agentId: A, blobId: `b${i}` }), blobData(i))).toBe(true);
    }
  });

  it("rewrite 的顺序：先 fsync tmp，再关掉自己的全部句柄，最后才 rename（Windows 占用目标文件会让 rename 失败）", async () => {
    const dir = mkTmp();
    await seed(mkFast(dir, sdk), 5);
    const events: string[] = [];
    let openNow = 0;
    let openAtRename = -1;
    const hooks: FaultHooks = {
      rename: () => {
        events.push("rename");
        openAtRename = openNow;
        return null;
      },
    };
    const { fs: fsx } = faultyFs(hooks);
    // faultyFs 每次 open 才读 hooks.wrapFd，所以可以在拿到 fsx 之后再挂
    hooks.wrapFd = (fd, meta) => {
      openNow += 1;
      let closed = false;
      const tag = meta.file.endsWith(".compact-tmp") ? "tmp" : "main";
      return {
        ...fd,
        sync: async () => {
          events.push(`sync:${tag}`);
          return fd.sync();
        },
        close: async () => {
          if (!closed) {
            closed = true;
            openNow -= 1;
          }
          return fd.close();
        },
      };
    };
    const cp = mkFast(dir, sdk, { fs: fsx });
    await cp.delete(delB1);

    expect(events.indexOf("sync:tmp")).toBeGreaterThanOrEqual(0); // 重写后的内容确实 fsync 过
    expect(events.indexOf("sync:tmp")).toBeLessThan(events.indexOf("rename")); // 且先于 rename
    expect(openAtRename).toBe(0); // rename 那一刻，自己没有任何句柄还开着
  });
});

describe("单写者护栏与多实例", () => {
  it("别人往文件尾追加了半行 → create 抛 tail mismatch，且一个字节都不去动对方的数据", async () => {
    const dir = mkTmp();
    const cp = mkFast(dir, sdk);
    await cp.create({ agentId: A, blobId: "b0", data: blobData(0) });
    fs.appendFileSync(fileOf(dir), '{"agentId":"other","blobId":"x","dataB'); // 别的进程写到一半
    const before = readRaw(dir);

    await expect(cp.create({ agentId: A, blobId: "b1", data: blobData(1) })).rejects.toThrow(
      /tail mismatch/,
    );
    expect(Buffer.compare(readRaw(dir), before)).toBe(0);
  });

  it("双实例：对方已创建的 key，本实例 create 必须报 already exists（create 前先追赶）", async () => {
    const dir = mkTmp();
    const x = mkFast(dir, sdk);
    const y = mkFast(dir, sdk);
    await x.warmUp();
    await y.warmUp(); // 两边先各自建好索引：之后 y 看不到 x 的新写入，除非主动追赶

    await x.create({ agentId: A, blobId: "dup", data: Buffer.from("from-x") });
    await expect(
      y.create({ agentId: A, blobId: "dup", data: Buffer.from("from-y") }),
    ).rejects.toThrow(/already exists/);
    expect(fileLines(dir).length).toBe(1); // 文件里这个 key 只有一行
  });

  it("双实例纯追加交替写：互不覆盖，两个实例与一个冷启动实例都读到全部", async () => {
    const dir = mkTmp();
    const x = mkFast(dir, sdk);
    const y = mkFast(dir, sdk);
    await x.create({ agentId: "ax", blobId: "b0", data: blobData(0) });
    await y.create({ agentId: "ay", blobId: "b0", data: blobData(1) });
    await x.create({ agentId: "ax", blobId: "b1", data: blobData(2) });
    await y.create({ agentId: "ay", blobId: "b1", data: blobData(3) });

    const want: Array<[string, string, Buffer]> = [
      ["ax", "b0", blobData(0)],
      ["ay", "b0", blobData(1)],
      ["ax", "b1", blobData(2)],
      ["ay", "b1", blobData(3)],
    ];
    const oracle = new sdk.JsonlLocalAgentStore(dir).checkpoints;
    for (const reader of [x, y, mkFast(dir, sdk), oracle]) {
      for (const [agentId, blobId, data] of want) {
        expect(sameBytes(await reader.get({ agentId, blobId }), data)).toBe(true);
      }
    }
    expect(fileLines(dir).length).toBe(4);
    expect(fileLines(dir).every(parses)).toBe(true);
  });

  it("复合键无歧义：('ab','c') 与 ('a','bc') 是两个不同的 blob", async () => {
    const dir = mkTmp();
    const cp = mkFast(dir, sdk);
    await cp.create({ agentId: "ab", blobId: "c", data: Buffer.from("1") });
    await cp.create({ agentId: "a", blobId: "bc", data: Buffer.from("2") });
    for (const reader of [cp, mkFast(dir, sdk), new sdk.JsonlLocalAgentStore(dir).checkpoints]) {
      expect(sameBytes(await reader.get({ agentId: "ab", blobId: "c" }), Buffer.from("1"))).toBe(true);
      expect(sameBytes(await reader.get({ agentId: "a", blobId: "bc" }), Buffer.from("2"))).toBe(true);
    }
  });
});
