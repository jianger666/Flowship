/**
 * 防休眠子开关的「带读失败信号」读取：readFeishuBridgeKeepAwakeState（R20-16）
 *
 * 口径（与总开关的 readFeishuChatBridgeEnabledState 对齐）：
 *  - true / false = 读到了：文件不存在 / 缺省字段 / 非 false 的脏值都算 true（决策 #14：默认开，只有显式 false 才关）；
 *  - null = 读失败（config.json 损坏 / 读不了 / readSettingsFile 直接抛错）——不知道子开关现在是什么，
 *    对账层据此「保持防休眠现状、不启不停」（行为由 feishu-bridge-settings-sync.test.ts 里的对账用例钉）。
 * boolean 版 isFeishuBridgeKeepAwakeEnabled 保留：读失败 = true（默认值），不抛。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  isFeishuBridgeKeepAwakeEnabled,
  readFeishuBridgeKeepAwakeState,
} from "@/lib/server/feishu-bridge/bridge-config";
import { settingsFilePath } from "@/lib/server/settings-fs";

import { blockAfter, readSource } from "./helpers/source-text";

const TMP_ROOT = path.join(os.tmpdir(), `fe-bridge-keepawake-state-${Date.now()}`);
process.env.FLOWSHIP_DATA_DIR = TMP_ROOT;

const write = (extra: Record<string, unknown> = {}) =>
  fs.writeFile(settingsFilePath(), JSON.stringify(extra), "utf-8");

beforeEach(async () => {
  await fs.rm(TMP_ROOT, { recursive: true, force: true });
  await fs.mkdir(TMP_ROOT, { recursive: true });
});
afterAll(async () => {
  await fs.rm(TMP_ROOT, { recursive: true, force: true });
});

describe("readFeishuBridgeKeepAwakeState：读到了 → boolean", () => {
  it("没有设置文件 → true（缺省开）", async () => {
    expect(await readFeishuBridgeKeepAwakeState()).toBe(true);
  });

  it("缺省字段 → true；显式 true → true；显式 false → false", async () => {
    await write({ feishuChatBridge: true });
    expect(await readFeishuBridgeKeepAwakeState()).toBe(true);
    await write({ feishuBridgeKeepAwake: true });
    expect(await readFeishuBridgeKeepAwakeState()).toBe(true);
    await write({ feishuBridgeKeepAwake: false });
    expect(await readFeishuBridgeKeepAwakeState()).toBe(false);
  });

  it("脏值（字符串 \"false\"、0、null）按开——只认显式 false 才关（与设置页的 boolTrue 口径一致）", async () => {
    for (const dirty of ["false", 0, null]) {
      await write({ feishuBridgeKeepAwake: dirty });
      expect(await readFeishuBridgeKeepAwakeState(), `脏值 ${JSON.stringify(dirty)}`).toBe(true);
    }
  });
});

describe("readFeishuBridgeKeepAwakeState：读失败 → null", () => {
  it("config.json 损坏（JSON 不合法）→ null，不抛", async () => {
    await fs.writeFile(settingsFilePath(), "{ not json", "utf-8");
    expect(await readFeishuBridgeKeepAwakeState()).toBeNull();
  });

  it("config.json 读不了（路径是个目录，非 ENOENT 的读错误）→ null，不抛", async () => {
    await fs.mkdir(settingsFilePath(), { recursive: true });
    expect(await readFeishuBridgeKeepAwakeState()).toBeNull();
  });

  it("readSettingsFile 直接抛错（不是返回 error 状态）→ null，不往外抛", async () => {
    vi.resetModules();
    vi.doMock("@/lib/server/settings-fs", () => ({
      readSettingsFile: async () => {
        throw new Error("EIO: simulated disk failure");
      },
    }));
    try {
      const fresh = await import("@/lib/server/feishu-bridge/bridge-config");
      expect(await fresh.readFeishuBridgeKeepAwakeState()).toBeNull();
      // boolean 版：读失败 = 默认值 true、同样不抛
      expect(await fresh.isFeishuBridgeKeepAwakeEnabled()).toBe(true);
    } finally {
      vi.doUnmock("@/lib/server/settings-fs");
      vi.resetModules();
    }
  });
});

describe("isFeishuBridgeKeepAwakeEnabled（boolean 口径）：读失败 = 开，行为与改动前一致", () => {
  it("缺省 / 显式 false / 损坏", async () => {
    expect(await isFeishuBridgeKeepAwakeEnabled()).toBe(true); // 没文件
    await write({ feishuBridgeKeepAwake: false });
    expect(await isFeishuBridgeKeepAwakeEnabled()).toBe(false);
    await fs.writeFile(settingsFilePath(), "{ not json", "utf-8");
    expect(await isFeishuBridgeKeepAwakeEnabled()).toBe(true);
  });
});

describe("inbound 对账层用的是带失败信号的版本", () => {
  const src = readSource("src/lib/server/feishu-bridge/inbound.ts");

  it("syncKeepAwake：用 readFeishuBridgeKeepAwakeState；null 分支只 warn + return，不碰 start / stop", () => {
    const sync = blockAfter(src, "const syncKeepAwake = async (");
    expect(sync).toMatch(/await readFeishuBridgeKeepAwakeState\(\)/);
    expect(sync).not.toMatch(/isFeishuBridgeKeepAwakeEnabled/);
    const nullBranch = blockAfter(sync, "if (keepAwakeOn === null) {");
    expect(nullBranch).toMatch(/console\.warn\(/);
    expect(nullBranch).toMatch(/\breturn;/);
    expect(nullBranch).not.toMatch(/keepAwake\.(start|stop)\(/);
  });

  it("inbound 不再 import boolean 版（防止以后又顺手改回「读失败 = 开」）", () => {
    const m = /import \{([^}]*)\} from "\.\/bridge-config";/.exec(src);
    expect(m, "找不到 inbound 对 ./bridge-config 的 import").not.toBeNull();
    expect(m![1]).toMatch(/readFeishuBridgeKeepAwakeState/);
    expect(m![1]).not.toMatch(/isFeishuBridgeKeepAwakeEnabled/);
  });
});
