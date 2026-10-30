/**
 * card-seq：bumpCardSequence（R14 B4-3 · Q12a-07 序号冲突自愈）
 *
 * 飞书回 300317（序号没严格递增）说明服务端那边这张卡的序号已经走到了我们前面
 * （重启后内存 / 盘上都没有记录而卡在上一个进程里走远了、或别处多走了几步）。
 * 自愈 = 把该卡序号直接抬到 max(上次 + 1000, 墙钟秒 + 2h)，下一次 next 就不会再撞。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TMP = path.join(os.tmpdir(), `feishu-bridge-seq-bump-${Date.now()}`);
process.env.FLOWSHIP_DATA_DIR = path.join(TMP, "data");

const {
  bumpCardSequence,
  nextCardSequence,
  flushCardSeqToDisk,
  __resetCardSeqForTest,
  __setCardSeqPersistThrottleForTest,
} = await import("@/lib/server/feishu-bridge/card-seq");

const seqFile = (): string => path.join(TMP, "data", "feishu-bridge", "card-seq.json");

const NOW = new Date("2026-10-25T00:00:00Z");
const NOW_SEC = Math.floor(NOW.getTime() / 1000);

beforeEach(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
  await fs.mkdir(path.join(TMP, "data"), { recursive: true });
  __setCardSeqPersistThrottleForTest(50);
  await __resetCardSeqForTest();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(async () => {
  vi.useRealTimers();
  __setCardSeqPersistThrottleForTest(null);
  await __resetCardSeqForTest();
});

describe("bumpCardSequence", () => {
  it("没有任何记录的卡：抬到墙钟秒 + 2h（与冷启动 floor 同一套），之后 next 从它的下一个开始", () => {
    const bumped = bumpCardSequence("card_cold");
    expect(bumped).toBe(NOW_SEC + 7200);
    expect(nextCardSequence("card_cold")).toBe(bumped + 1);
  });

  it("已经走在墙钟前面的卡：至少再往前跳 1000（覆盖「别处多走了几步」）", () => {
    const first = nextCardSequence("card_ahead"); // 冷 miss：NOW_SEC + 7200
    expect(first).toBe(NOW_SEC + 7200);
    const bumped = bumpCardSequence("card_ahead");
    expect(bumped).toBe(first + 1000);
    expect(nextCardSequence("card_ahead")).toBe(bumped + 1);
  });

  it("反复 bump 严格递增（不会原地踏步）", () => {
    const a = bumpCardSequence("card_rep");
    const b = bumpCardSequence("card_rep");
    const c = bumpCardSequence("card_rep");
    expect(b).toBe(a + 1000);
    expect(c).toBe(b + 1000);
  });

  it("墙钟推进后：取 max(last + 1000, 墙钟 + 2h)——last 已落后墙钟时以墙钟为准", () => {
    const first = bumpCardSequence("card_clock"); // NOW_SEC + 7200
    vi.setSystemTime(new Date(NOW.getTime() + 3 * 3600 * 1000)); // 3 小时后
    const bumped = bumpCardSequence("card_clock");
    expect(bumped).toBe(NOW_SEC + 3 * 3600 + 7200);
    expect(bumped).toBeGreaterThan(first + 1000);
  });

  it("不超过 int32 上限（飞书的 sequence 是 int32）", () => {
    vi.setSystemTime(new Date("2038-06-01T00:00:00Z")); // 墙钟 + 2h 已经超过 2^31 - 1
    expect(bumpCardSequence("card_i32")).toBe(2_147_483_647);
  });

  it("只动这一张卡，别的卡的序号不受影响", () => {
    const other = nextCardSequence("card_other");
    bumpCardSequence("card_victim");
    expect(nextCardSequence("card_other")).toBe(other + 1);
  });

  it("抬高后的序号会落盘（重启后 next 仍在它之上，不会又撞一次）", async () => {
    const bumped = bumpCardSequence("card_persist");
    await flushCardSeqToDisk();
    const onDisk = JSON.parse(await fs.readFile(seqFile(), "utf-8")) as Record<string, number>;
    expect(onDisk.card_persist).toBe(bumped);

    await __resetCardSeqForTest({ unlinkDisk: false }); // 只清内存，模拟重启
    expect(nextCardSequence("card_persist")).toBe(bumped + 1);
  });

  it("bump 之后不手动 flush：节流定时器到点自己落盘（上一条用例手动 flush 会强制写盘，分不出 bump 有没有排落盘）", async () => {
    const bumped = bumpCardSequence("card_throttle");
    await vi.waitFor(
      async () => {
        const onDisk = JSON.parse(await fs.readFile(seqFile(), "utf-8")) as Record<string, number>;
        expect(onDisk.card_throttle).toBe(bumped);
      },
      { timeout: 3000, interval: 25 },
    );
  });

  it("重启后（内存是空的、盘上有水位）：bump 先灌盘再算，不会把序号拉回到盘上水位之下", async () => {
    const onDisk = NOW_SEC + 7200 + 50_000; // 盘上水位远在「墙钟 + 2h」前面（卡在上个进程里走得很远）
    await fs.mkdir(path.dirname(seqFile()), { recursive: true });
    await fs.writeFile(seqFile(), JSON.stringify({ card_restart: onDisk }));
    await __resetCardSeqForTest({ unlinkDisk: false }); // 只清内存与水合标记、盘文件保留 = 模拟重启

    expect(bumpCardSequence("card_restart")).toBe(onDisk + 1000);
    expect(nextCardSequence("card_restart")).toBe(onDisk + 1001);
  });

  it("映射满了（1000 张卡）再 bump 一张新卡：清掉最旧的一半，较新的卡和新卡不受影响", () => {
    for (let i = 0; i < 1000; i += 1) nextCardSequence(`fill_${i}`);
    bumpCardSequence("card_new");
    // 最旧的一半被清了：回到「冷 miss」，与第一次分配同值；较新的一半还在：在自己上次的基础上 +1
    expect(nextCardSequence("fill_0")).toBe(NOW_SEC + 7200);
    expect(nextCardSequence("fill_499")).toBe(NOW_SEC + 7200);
    expect(nextCardSequence("fill_500")).toBe(NOW_SEC + 7201);
    expect(nextCardSequence("fill_999")).toBe(NOW_SEC + 7201);
    expect(nextCardSequence("card_new")).toBe(NOW_SEC + 7201);
  });
});
