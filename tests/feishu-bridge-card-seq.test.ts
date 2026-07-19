/**
 * card-seq：冷启动读盘恢复 / 2h 余量兜底 / 节流落盘
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TMP = path.join(os.tmpdir(), `feishu-bridge-seq-${Date.now()}`);
process.env.FLOWSHIP_DATA_DIR = path.join(TMP, "data");

const {
  nextCardSequence,
  flushCardSeqToDisk,
  __resetCardSeqForTest,
  __setCardSeqPersistThrottleForTest,
} = await import("@/lib/server/feishu-bridge/card-seq");

const seqFile = (): string =>
  path.join(TMP, "data", "feishu-bridge", "card-seq.json");

beforeEach(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
  await fs.mkdir(path.join(TMP, "data"), { recursive: true });
  __setCardSeqPersistThrottleForTest(50);
  await __resetCardSeqForTest();
});

afterEach(async () => {
  __setCardSeqPersistThrottleForTest(null);
  await __resetCardSeqForTest();
});

describe("card-seq 落盘与冷启动", () => {
  it("重启恢复：新 Map + 盘上值 → seq 严格大于盘上 last", async () => {
    const cardId = "card_persist";
    // 模拟「重启前」高水位（远超当前秒）
    const highWater = Math.floor(Date.now() / 1000) + 10_000;
    await fs.mkdir(path.dirname(seqFile()), { recursive: true });
    await fs.writeFile(
      seqFile(),
      JSON.stringify({ [cardId]: highWater }, null, 2),
      "utf-8",
    );
    // 只清内存、保留盘文件 → 模拟进程重启后首次 miss 读盘
    await __resetCardSeqForTest({ unlinkDisk: false });

    const next = nextCardSequence(cardId);
    expect(next).toBe(highWater + 1);
  });

  it("盘上无记录 → epochSec + 7200 余量兜底", async () => {
    const before = Math.floor(Date.now() / 1000);
    const next = nextCardSequence("card_cold_miss");
    const after = Math.floor(Date.now() / 1000);
    // floor = sec + 7200；next = max(1, floor) = sec+7200（同秒内）
    expect(next).toBeGreaterThanOrEqual(before + 7200);
    expect(next).toBeLessThanOrEqual(after + 7200);
  });

  it("节流落盘：分配后短时内落盘，flush 可立即刷", async () => {
    const cardId = "card_throttle";
    const seq = nextCardSequence(cardId);
    // 节流未到 → 盘可能还没有
    let earlyExists = true;
    try {
      await fs.access(seqFile());
    } catch {
      earlyExists = false;
    }
    // 立即 flush 必落盘
    await flushCardSeqToDisk();
    const raw = await fs.readFile(seqFile(), "utf-8");
    const store = JSON.parse(raw) as Record<string, number>;
    expect(store[cardId]).toBe(seq);

    // 再分配 + 等节流
    const seq2 = nextCardSequence(cardId);
    await vi.waitFor(async () => {
      const r = await fs.readFile(seqFile(), "utf-8");
      const s = JSON.parse(r) as Record<string, number>;
      expect(s[cardId]).toBe(seq2);
    });
    // earlyExists 仅作观测（不强制——race 下 flush 与 schedule 都可能已写）
    void earlyExists;
  });

  it("同卡连续分配严格递增", () => {
    const a = nextCardSequence("card_mono");
    const b = nextCardSequence("card_mono");
    const c = nextCardSequence("card_mono");
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
  });
});
