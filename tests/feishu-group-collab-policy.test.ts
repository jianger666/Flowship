/**
 * 需求群协作行为固定化（2026-07-28 砍掉设置页三个开关）
 *
 * 钉住两件事：
 * 1. 三个读取点**不再受 config.json 影响**——盘上留着老 `groupCollab` 字段、且三项
 *    全填反值时，读出来仍是 `GROUP_COLLAB_POLICY` 的固定值
 * 2. 归一会把退役的 `groupCollab` 键从结果里抹掉——下次落盘顺手清掉老配置残留
 *
 * 行为原则：默认不主动吵群（ask 不发群 / 产出不播报），但别人在群里主动发起的
 * 推进一定有回应（结果回群）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const DATA_DIR = path.join(
  os.tmpdir(),
  `feishu-group-collab-policy-${Date.now()}`,
  "data",
);
process.env.FLOWSHIP_DATA_DIR = DATA_DIR;

const {
  GROUP_COLLAB_POLICY,
  getGroupAutoBroadcastMode,
  isAdvanceResultToGroupEnabled,
  isAskToGroupEnabled,
} = await import("@/lib/server/feishu-bridge/bridge-config");

const { normalizeSettings } = await import("@/lib/local-store");

// 老用户 config.json 里可能留着的三项——全填成与固定策略相反的值
const LEGACY_CONFIG = {
  apiKey: "sk-test",
  groupCollab: {
    askToGroup: true,
    advanceResultToGroup: false,
    autoBroadcast: "all",
  },
};

beforeAll(async () => {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(
    path.join(DATA_DIR, "config.json"),
    JSON.stringify(LEGACY_CONFIG),
    "utf-8",
  );
});

afterAll(async () => {
  await fs.rm(path.dirname(DATA_DIR), { recursive: true, force: true });
});

describe("固定策略：不再读用户设置", () => {
  it("盘上 askToGroup=true 也不发群——ask_user 不再自动往需求群发答题卡", async () => {
    await expect(isAskToGroupEnabled()).resolves.toBe(false);
  });

  it("盘上 advanceResultToGroup=false 也照发——群内发起的推进结果一定回群", async () => {
    await expect(isAdvanceResultToGroupEnabled()).resolves.toBe(true);
  });

  it("盘上 autoBroadcast='all' 也不播——action 完成不自动广播", async () => {
    await expect(getGroupAutoBroadcastMode()).resolves.toBe("off");
  });

  it("常量就是唯一开关（以后要放开只改这里）", () => {
    expect(GROUP_COLLAB_POLICY).toEqual({
      askToGroup: false,
      advanceResultToGroup: true,
      autoBroadcast: "off",
    });
  });
});

describe("退役配置字段清理", () => {
  it("归一结果不带 groupCollab——老残留在下次落盘时被抹掉", () => {
    const normalized = normalizeSettings(
      LEGACY_CONFIG as Parameters<typeof normalizeSettings>[0],
    );
    expect(normalized).not.toHaveProperty("groupCollab");
    // 同批其它字段照常保留、别误伤
    expect(normalized.apiKey).toBe("sk-test");
  });
});
