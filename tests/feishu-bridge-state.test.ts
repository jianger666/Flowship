/**
 * bridge-state：读改写遇到「读不出来」的状态文件时不许拿空状态覆盖已有数据
 *
 * 状态里有去重集合（2000 条）、当前对话指针、已结束对话、p2p chatId——整份被空 store 覆盖后，
 * 重投的入向消息会被当成新消息再注入一次、指针和「已结束」标记丢光。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const TMP = path.join(os.tmpdir(), `feishu-bridge-state-${Date.now()}`);
process.env.FLOWSHIP_DATA_DIR = path.join(TMP, "data");

const {
  __resetBridgeStateForTest,
  addEndedChatTaskId,
  getCurrentChatTaskId,
  getEndedChatTaskIds,
  getLastP2pChatId,
  hasProcessedMessageId,
  markProcessedMessageId,
  peekAwaitingChatSearch,
  rememberP2pChatId,
  setAwaitingChatSearch,
  setCurrentChatTaskId,
  takeAwaitingChatSearch,
} = await import("@/lib/server/feishu-bridge/bridge-state");

const dir = () => path.join(TMP, "data", "feishu-bridge");
const file = () => path.join(dir(), "bridge-state.json");
const corruptFiles = async () =>
  (await fs.readdir(dir())).filter((n) => n.startsWith("bridge-state.json.corrupt-"));

/** root / Windows 下 chmod 000 挡不住读，无法构造「读失败」——这些用例跳过 */
const canMakeUnreadable =
  process.platform !== "win32" && (process.getuid?.() ?? 1) !== 0;

const seed = async () => {
  await markProcessedMessageId("om_1");
  await markProcessedMessageId("om_2");
  await setCurrentChatTaskId("task_cur");
  await addEndedChatTaskId("task_ended");
  await rememberP2pChatId("oc_p2p");
  await setAwaitingChatSearch();
};

beforeEach(async () => {
  await __resetBridgeStateForTest();
  await fs.rm(TMP, { recursive: true, force: true });
  await fs.mkdir(path.join(TMP, "data"), { recursive: true });
});

afterEach(async () => {
  await __resetBridgeStateForTest();
  await fs.rm(TMP, { recursive: true, force: true });
});

describe("bridge-state 读改写：读不出来 ≠ 空", () => {
  it.skipIf(!canMakeUnreadable)(
    "瞬时读错误（权限拒绝模拟）：所有写入口都抛错并放弃写入，恢复可读后历史原样（以前读失败回空 → 整份被覆盖）",
    async () => {
      await seed();
      await fs.chmod(file(), 0o000);
      try {
        await expect(markProcessedMessageId("om_3")).rejects.toThrow(/bridge-state/);
        await expect(setCurrentChatTaskId("task_other")).rejects.toThrow(/bridge-state/);
        await expect(addEndedChatTaskId("task_x")).rejects.toThrow(/bridge-state/);
        await expect(rememberP2pChatId("oc_other")).rejects.toThrow(/bridge-state/);
        await expect(takeAwaitingChatSearch()).rejects.toThrow(/bridge-state/);
      } finally {
        await fs.chmod(file(), 0o600);
      }
      expect(await hasProcessedMessageId("om_1")).toBe(true);
      expect(await hasProcessedMessageId("om_2")).toBe(true);
      expect(await hasProcessedMessageId("om_3")).toBe(false);
      expect(await getCurrentChatTaskId()).toBe("task_cur");
      expect(await getEndedChatTaskIds()).toEqual(["task_ended"]);
      expect(await getLastP2pChatId()).toBe("oc_p2p");
      // 一次性 flag 也没被读失败那次吞掉
      expect(await peekAwaitingChatSearch()).toBe(true);
      expect(await corruptFiles()).toEqual([]);
    },
  );

  it.skipIf(!canMakeUnreadable)("纯读取读失败仍宽松回空 / false、不抛（只读路径不中断消息处理）", async () => {
    await seed();
    await fs.chmod(file(), 0o000);
    try {
      expect(await hasProcessedMessageId("om_1")).toBe(false);
      expect(await getCurrentChatTaskId()).toBe("");
      expect(await getEndedChatTaskIds()).toEqual([]);
      expect(await peekAwaitingChatSearch()).toBe(false);
    } finally {
      await fs.chmod(file(), 0o600);
    }
    expect(await hasProcessedMessageId("om_1")).toBe(true);
  });

  it.each([
    ["不是合法 JSON", "{oops"],
    ["空文件", ""],
    ["JSON 但不是对象（数组）", "[]"],
    ["JSON null", "null"],
  ])("文件内容坏了（%s）：隔离成 .corrupt-<ts> 留证，再从空状态继续（不卡死在坏文件上）", async (_label, content) => {
    await fs.mkdir(dir(), { recursive: true });
    await fs.writeFile(file(), content, "utf-8");
    await markProcessedMessageId("om_new");
    expect(await hasProcessedMessageId("om_new")).toBe(true);
    const bad = await corruptFiles();
    expect(bad).toHaveLength(1);
    expect(await fs.readFile(path.join(dir(), bad[0]!), "utf-8")).toBe(content);
  });

  it("合法 JSON 但字段类型不对（processedMessageIds 是字符串）：不悄悄当空——原样复制留证，完好字段（currentChatTaskId）保住", async () => {
    await fs.mkdir(dir(), { recursive: true });
    const bad = JSON.stringify({ processedMessageIds: "oops", currentChatTaskId: "task_keep" });
    await fs.writeFile(file(), bad, "utf-8");
    await markProcessedMessageId("om_new");
    expect(await hasProcessedMessageId("om_new")).toBe(true);
    expect(await getCurrentChatTaskId()).toBe("task_keep");
    const copies = await corruptFiles();
    expect(copies).toHaveLength(1);
    expect(await fs.readFile(path.join(dir(), copies[0]!), "utf-8")).toBe(bad);
  });

  it(".corrupt-<ts> 留证只保留最近 5 份", async () => {
    await fs.mkdir(dir(), { recursive: true });
    for (let ts = 1; ts <= 7; ts += 1) {
      await fs.writeFile(path.join(dir(), `bridge-state.json.corrupt-${ts}`), `old-${ts}`, "utf-8");
    }
    await fs.writeFile(file(), "not json", "utf-8");
    await markProcessedMessageId("om_new");
    const copies = await corruptFiles();
    expect(copies).toHaveLength(5);
    expect(copies).not.toContain("bridge-state.json.corrupt-1");
    expect(copies).not.toContain("bridge-state.json.corrupt-2");
    expect(copies).not.toContain("bridge-state.json.corrupt-3");
    expect(copies.some((n) => Number(n.split("corrupt-")[1]) > 1_000_000)).toBe(true);
  });

  it("文件不存在（首次）：照常从空开始，不产生 .corrupt 文件", async () => {
    await markProcessedMessageId("om_first");
    expect(await hasProcessedMessageId("om_first")).toBe(true);
    expect(await corruptFiles()).toEqual([]);
  });
});
