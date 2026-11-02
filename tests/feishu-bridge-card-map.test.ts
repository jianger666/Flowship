/**
 * card-map：持久化 + FIFO 上限 + 原子写
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TMP = path.join(os.tmpdir(), `feishu-bridge-map-${Date.now()}`);
process.env.FLOWSHIP_DATA_DIR = path.join(TMP, "data");

const {
  __setCardMapMaxForTest,
  findAskCards,
  findTaskByMessageId,
  getLastProcessedTs,
  readCardMapStore,
  rememberAskCard,
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

// ----------------- 读失败 ≠ 空：读改写不许拿「空」覆盖盘上已有的历史 -----------------

/** root / Windows 下 chmod 000 挡不住读，无法构造「读失败」——这些用例跳过 */
const canMakeUnreadable =
  process.platform !== "win32" && (process.getuid?.() ?? 1) !== 0;

describe("读改写遇到读不出来的 card-map.json：不拿空 store 覆盖已有历史", () => {
  const dir = () => path.join(TMP, "data", "feishu-bridge");
  const file = () => path.join(dir(), "card-map.json");

  const seed = async () => {
    await rememberCardMessage({ messageId: "om_old1", cardId: "c1", taskId: "t1", createdAt: 1 });
    await rememberCardMessage({ messageId: "om_old2", cardId: "c2", taskId: "t2", createdAt: 2 });
    await setLastProcessedTs("1700000000000");
  };

  const corruptFiles = async () =>
    (await fs.readdir(dir())).filter((n) => n.startsWith("card-map.json.corrupt-"));

  it.skipIf(!canMakeUnreadable)(
    "瞬时读错误（这里用权限拒绝模拟）：rememberCardMessage 抛错、旧历史原样保留（以前读失败回空 → 整份被覆盖）",
    async () => {
      await seed();
      await fs.chmod(file(), 0o000);
      try {
        await expect(
          rememberCardMessage({ messageId: "om_new", cardId: "cn", taskId: "tn", createdAt: 3 }),
        ).rejects.toThrow(/card-map/);
      } finally {
        await fs.chmod(file(), 0o600);
      }
      const store = await readCardMapStore();
      expect(store.entries.map((e) => e.messageId)).toEqual(["om_old1", "om_old2"]);
      expect(store.lastProcessedTs).toBe("1700000000000");
      expect(await corruptFiles()).toEqual([]);
    },
  );

  it.skipIf(!canMakeUnreadable)(
    "rememberAskCard / setLastProcessedTs 同样：读不出来就放弃这次写，不抹掉历史与游标",
    async () => {
      await seed();
      await fs.chmod(file(), 0o000);
      try {
        await expect(
          rememberAskCard({
            messageId: "om_old1",
            cardId: "c1",
            routeTaskId: "t1",
            askTaskId: "t1",
            askId: "a1",
          }),
        ).rejects.toThrow(/card-map/);
        await expect(setLastProcessedTs("1800000000000")).rejects.toThrow(/card-map/);
      } finally {
        await fs.chmod(file(), 0o600);
      }
      const store = await readCardMapStore();
      expect(store.entries).toHaveLength(2);
      expect(store.lastProcessedTs).toBe("1700000000000");
      expect(await findAskCards("t1", "a1")).toEqual([]);
    },
  );

  it.skipIf(!canMakeUnreadable)("纯读取（回复锚定 / 补拉游标）读失败仍宽松回空、不抛——只读路径别因此中断消息处理", async () => {
    await seed();
    await fs.chmod(file(), 0o000);
    try {
      expect(await findTaskByMessageId("om_old1")).toBeNull();
      expect(await getLastProcessedTs()).toBe("");
    } finally {
      await fs.chmod(file(), 0o600);
    }
    expect((await findTaskByMessageId("om_old1"))?.taskId).toBe("t1");
  });

  it.each([
    ["不是合法 JSON", "{not json"],
    ["空文件", ""],
    ["JSON 但不是对象（数组）", "[1,2,3]"],
    ["JSON null", "null"],
  ])("文件内容坏了（%s）：隔离成 .corrupt-<ts> 留证，再从空 store 继续写（不卡死在坏文件上）", async (_label, content) => {
    await fs.mkdir(dir(), { recursive: true });
    await fs.writeFile(file(), content, "utf-8");
    await rememberCardMessage({ messageId: "om_new", cardId: "cn", taskId: "tn", createdAt: 3 });
    // 新数据正常落盘
    expect((await findTaskByMessageId("om_new"))?.taskId).toBe("tn");
    // 坏文件原样留着（供人工恢复），而不是被静默覆盖
    const bad = await corruptFiles();
    expect(bad).toHaveLength(1);
    expect(await fs.readFile(path.join(dir(), bad[0]!), "utf-8")).toBe(content);
  });

  it("合法 JSON 但字段类型不对（entries 是字符串）：不悄悄当空——原样复制留证，完好的字段（lastProcessedTs）保住，新数据正常写入", async () => {
    await fs.mkdir(dir(), { recursive: true });
    const bad = JSON.stringify({ entries: "oops", lastProcessedTs: "1700000000000" });
    await fs.writeFile(file(), bad, "utf-8");
    await rememberCardMessage({ messageId: "om_new", cardId: "cn", taskId: "tn", createdAt: 3 });
    expect((await findTaskByMessageId("om_new"))?.taskId).toBe("tn");
    expect(await getLastProcessedTs()).toBe("1700000000000");
    const copies = await corruptFiles();
    expect(copies).toHaveLength(1);
    expect(await fs.readFile(path.join(dir(), copies[0]!), "utf-8")).toBe(bad);
  });

  it("结构正常 / 缺字段的老文件：不产生留证文件（缺字段是正常形态）", async () => {
    await fs.mkdir(dir(), { recursive: true });
    await fs.writeFile(file(), JSON.stringify({ entries: [] }), "utf-8");
    await rememberCardMessage({ messageId: "om_ok", cardId: "c", taskId: "t", createdAt: 1 });
    expect(await corruptFiles()).toEqual([]);
  });

  it(".corrupt-<ts> 留证只保留最近 5 份（反复损坏不无限攒）：最旧的被清掉、最新那份在", async () => {
    await fs.mkdir(dir(), { recursive: true });
    for (let ts = 1; ts <= 7; ts += 1) {
      await fs.writeFile(path.join(dir(), `card-map.json.corrupt-${ts}`), `old-${ts}`, "utf-8");
    }
    await fs.writeFile(file(), "{broken", "utf-8");
    await rememberCardMessage({ messageId: "om_new", cardId: "cn", taskId: "tn", createdAt: 3 });
    const copies = await corruptFiles();
    expect(copies).toHaveLength(5);
    // 旧的 1~7 里只留下最近的几份，且本次新留证的那份（时间戳最大）一定在
    expect(copies).not.toContain("card-map.json.corrupt-1");
    expect(copies).not.toContain("card-map.json.corrupt-2");
    expect(copies).not.toContain("card-map.json.corrupt-3");
    expect(copies.some((n) => Number(n.split("corrupt-")[1]) > 1_000_000)).toBe(true);
    const fresh = copies.find((n) => Number(n.split("corrupt-")[1]) > 1_000_000)!;
    expect(await fs.readFile(path.join(dir(), fresh), "utf-8")).toBe("{broken");
  });

  it("墙钟被回拨（新留证的时间戳比已有的都小）：刚留下的那份证据不会被立刻淘汰，其余仍总共只留 5 份", async () => {
    await fs.mkdir(dir(), { recursive: true });
    for (let ts = 100; ts <= 106; ts += 1) {
      await fs.writeFile(path.join(dir(), `card-map.json.corrupt-${ts}`), `old-${ts}`, "utf-8");
    }
    await fs.writeFile(file(), "{broken-rollback", "utf-8");
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(7); // 比所有已有的时间戳都小
    try {
      await rememberCardMessage({ messageId: "om_rb", cardId: "cr", taskId: "tr", createdAt: 3 });
    } finally {
      nowSpy.mockRestore();
    }
    const copies = await corruptFiles();
    expect(copies).toHaveLength(5);
    expect(copies).toContain("card-map.json.corrupt-7");
    expect(await fs.readFile(path.join(dir(), "card-map.json.corrupt-7"), "utf-8")).toBe("{broken-rollback");
  });

  it(".corrupt- 前缀但后缀不是纯数字时间戳的文件（用户手留的备份）：不碰，不参与「保留 5 份」的淘汰（旧过滤只看前缀、非数字按 ts=0 最先删）", async () => {
    await fs.mkdir(dir(), { recursive: true });
    const manual = Array.from({ length: 8 }, (_, i) => `card-map.json.corrupt-manual-backup-${i}`);
    for (const n of manual) await fs.writeFile(path.join(dir(), n), `keep-${n}`, "utf-8");
    // 带数字但夹杂字母 / 点：同样不是本模块写的格式
    await fs.writeFile(path.join(dir(), "card-map.json.corrupt-123abc"), "keep", "utf-8");
    await fs.writeFile(path.join(dir(), "card-map.json.corrupt-1.bak"), "keep", "utf-8");
    // 再叠 7 份纯数字的（会触发淘汰）+ 一份本次损坏
    for (let ts = 1; ts <= 7; ts += 1) {
      await fs.writeFile(path.join(dir(), `card-map.json.corrupt-${ts}`), `old-${ts}`, "utf-8");
    }
    await fs.writeFile(file(), "{broken", "utf-8");
    await rememberCardMessage({ messageId: "om_new", cardId: "cn", taskId: "tn", createdAt: 3 });
    const names = await fs.readdir(dir());
    for (const n of manual) expect(names, n).toContain(n);
    expect(names).toContain("card-map.json.corrupt-123abc");
    expect(names).toContain("card-map.json.corrupt-1.bak");
    // 纯数字的仍只保留最近 5 份
    expect(names.filter((n) => /^card-map\.json\.corrupt-\d+$/.test(n))).toHaveLength(5);
  });

  it("淘汰旧留证时某一份删不掉（EBUSY）：不中止后面的清理（每条 rm 各自 try/catch）；仍只认纯数字后缀", async () => {
    await fs.mkdir(dir(), { recursive: true });
    for (let ts = 1; ts <= 8; ts += 1) {
      await fs.writeFile(path.join(dir(), `card-map.json.corrupt-${ts}`), `old-${ts}`, "utf-8");
    }
    await fs.writeFile(path.join(dir(), "card-map.json.corrupt-manual-backup"), "keep", "utf-8");
    await fs.writeFile(file(), "{broken", "utf-8");
    // 本次损坏会再产生 1 份 → 共 9 份纯数字，要淘汰最旧的 4 份（1..4）。让第一次删除失败，后面 3 次必须照常执行
    const realRm = fs.rm.bind(fs);
    let failedOnce = false;
    const rmCalls: string[] = [];
    const rmSpy = vi.spyOn(fs, "rm").mockImplementation(async (p, o) => {
      const name = path.basename(String(p));
      if (name.includes(".corrupt-")) rmCalls.push(name);
      if (name.includes(".corrupt-") && !failedOnce) {
        failedOnce = true;
        throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
      }
      return realRm(p, o);
    });
    try {
      await rememberCardMessage({ messageId: "om_rm_fail", cardId: "c", taskId: "t", createdAt: 1 });
    } finally {
      rmSpy.mockRestore();
    }
    expect(rmCalls).toHaveLength(4); // 4 份都尝试了（旧逻辑第一次抛错就整段中止，只试 1 次）
    const names = await fs.readdir(dir());
    expect(names.filter((n) => /^card-map\.json\.corrupt-\d+$/.test(n))).toHaveLength(6); // 5 份保留 + 1 份「删不掉」的
    expect(names).toContain("card-map.json.corrupt-manual-backup");
    expect((await findTaskByMessageId("om_rm_fail"))?.taskId).toBe("t"); // 主流程不受影响
  });

  it("文件不存在（首次）：照常从空开始，不产生 .corrupt 文件", async () => {
    await rememberCardMessage({ messageId: "om_first", cardId: "c", taskId: "t", createdAt: 1 });
    expect((await findTaskByMessageId("om_first"))?.taskId).toBe("t");
    expect(await corruptFiles()).toEqual([]);
  });
});
