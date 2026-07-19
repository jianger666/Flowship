/**
 * card-map：持久化 + FIFO 上限 + 原子写
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const TMP = path.join(os.tmpdir(), `feishu-bridge-map-${Date.now()}`);
process.env.FLOWSHIP_DATA_DIR = path.join(TMP, "data");

const {
  __setCardMapMaxForTest,
  findTaskByMessageId,
  getLastProcessedTs,
  readCardMapStore,
  rememberCardMessage,
  setLastProcessedTs,
} = await import("@/lib/server/feishu-bridge/card-map");

beforeEach(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
  await fs.mkdir(path.join(TMP, "data"), { recursive: true });
  __setCardMapMaxForTest(5);
});

afterEach(async () => {
  __setCardMapMaxForTest(null);
  await fs.rm(TMP, { recursive: true, force: true });
});

describe("card-map", () => {
  it("remember + findTaskByMessageId", async () => {
    await rememberCardMessage({
      messageId: "om_a",
      cardId: "card_1",
      taskId: "task_1",
      createdAt: 1,
    });
    const hit = await findTaskByMessageId("om_a");
    expect(hit?.taskId).toBe("task_1");
    expect(hit?.cardId).toBe("card_1");
    expect(await findTaskByMessageId("om_missing")).toBeNull();
  });

  it("超出上限 FIFO 淘汰最旧", async () => {
    for (let i = 0; i < 8; i++) {
      await rememberCardMessage({
        messageId: `om_${i}`,
        cardId: `c_${i}`,
        taskId: `t_${i}`,
        createdAt: i,
      });
    }
    const store = await readCardMapStore();
    expect(store.entries).toHaveLength(5);
    expect(store.entries[0]?.messageId).toBe("om_3");
    expect(await findTaskByMessageId("om_0")).toBeNull();
    expect((await findTaskByMessageId("om_7"))?.taskId).toBe("t_7");
  });

  it("原子写：落盘为合法 JSON，无残留 tmp", async () => {
    await rememberCardMessage({
      messageId: "om_x",
      cardId: "c",
      taskId: "t",
      createdAt: 1,
    });
    const dir = path.join(TMP, "data", "feishu-bridge");
    const names = await fs.readdir(dir);
    expect(names).toContain("card-map.json");
    expect(names.some((n) => n.includes(".tmp"))).toBe(false);
    const raw = await fs.readFile(path.join(dir, "card-map.json"), "utf-8");
    expect(JSON.parse(raw).entries[0].messageId).toBe("om_x");
  });

  it("lastProcessedTs 读写", async () => {
    expect(await getLastProcessedTs()).toBe("");
    await setLastProcessedTs("1784385499958");
    expect(await getLastProcessedTs()).toBe("1784385499958");
  });
});
