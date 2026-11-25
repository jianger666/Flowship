/**
 * 「桥接是否开启」8 秒缓存：设置一落盘就作废（outbound.ts 的 isBridgeEnabledCached / group-outbound.ts 的同名缓存）
 *
 * 背景：两处各缓存 8 秒——关桥接后 8 秒内在途一轮仍会往飞书回流 / 发回执；刚打开时缓存的 false 会让
 * group-outbound 丢掉进行中的一轮。现在两处都订阅 settings-fs 的 onSettingsWritten 直接作废。
 *
 * 写盘走生产入口 patchSettingsFile（设置页 PATCH /api/settings 调的就是它）；初始配置用 writeSettingsFileAtomic
 * （仅测试用）摆好——patchSettingsFile 要求盘上已有 config.json。
 * 「缓存确实在生效」用直接 fs.writeFile（不通知）做对照：否则「作废后重读」可能只是因为缓存本来就没起作用。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { blockAfter, readSource } from "./helpers/source-text";

const TMP = path.join(
  os.tmpdir(),
  `feishu-enabled-cache-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
);
process.env.FLOWSHIP_DATA_DIR = TMP;

const outbound = await import("@/lib/server/feishu-bridge/outbound");
const groupOutbound = await import("@/lib/server/feishu-bridge/group-outbound");
const { patchSettingsFile, settingsFilePath, writeSettingsFileAtomic } =
  await import("@/lib/server/settings-fs");

const BASE = {
  apiKey: "sk-test-not-a-real-key",
  defaultModel: { id: "composer-2" },
  repos: [] as unknown[],
};

const seed = (on: boolean): Promise<void> =>
  writeSettingsFileAtomic({ ...BASE, feishuChatBridge: on });

/** 绕过 settings-fs 直接改盘（不通知订阅者）：用来证明缓存确实在生效 */
const writeRawBypassingNotify = (on: boolean): Promise<void> =>
  fs.writeFile(
    settingsFilePath(),
    JSON.stringify({ ...BASE, feishuChatBridge: on }),
    "utf-8",
  );

beforeEach(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
  await fs.mkdir(TMP, { recursive: true });
  outbound.__setBridgeEnabledReaderForTest(null); // 默认读盘函数 + 清缓存
  outbound.__setBridgeEnabledForTest(null); // 走真实读取 + 清缓存
  groupOutbound.__setGroupOutboundDepsForTest(null); // 默认依赖（真读盘）+ 清缓存
});

afterAll(async () => {
  outbound.__setBridgeEnabledReaderForTest(null);
  outbound.__setBridgeEnabledForTest(null);
  groupOutbound.__setGroupOutboundDepsForTest(null);
  await fs.rm(TMP, { recursive: true, force: true });
});

describe("outbound.isBridgeEnabledCached：设置写盘即作废", () => {
  it("patchSettingsFile 翻转总开关后，下一次读取立刻拿到新值（不等 8 秒 TTL）", async () => {
    await seed(false);
    expect(await outbound.__isBridgeEnabledCachedForTest()).toBe(false);

    // 对照：不通知的改盘读不到——证明缓存在生效（否则下面的断言可能是假绿）
    await writeRawBypassingNotify(true);
    expect(await outbound.__isBridgeEnabledCachedForTest()).toBe(false);

    // 生产写盘入口：落盘后通知 → 缓存作废 → 下一次读到盘上的新值
    const on = await patchSettingsFile({ patch: { feishuChatBridge: true } });
    expect(on.status).toBe("ok");
    expect(await outbound.__isBridgeEnabledCachedForTest()).toBe(true);

    const off = await patchSettingsFile({ patch: { feishuChatBridge: false } });
    expect(off.status).toBe("ok");
    expect(await outbound.__isBridgeEnabledCachedForTest()).toBe(false);
  });

  it("读盘进行中发生了写盘：这次调用拿到的旧值不会被填回缓存（下一次必须重读）——R20-14：此前只有 group-outbound 一侧有这条用例", async () => {
    // 防的回归：作废之后，在途的那次旧读返回时又把写盘前的旧值填进缓存、再顶 8 秒
    let calls = 0;
    let current = false;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    outbound.__setBridgeEnabledReaderForTest(async () => {
      calls += 1;
      const seen = current; // 读盘瞬间看到的值
      if (calls === 1) await gate; // 第一次读卡在「已读到旧值、还没返回」
      return seen;
    });

    const inflight = outbound.__isBridgeEnabledCachedForTest();
    await seed(true); // 读盘期间写盘：通知 → 世代号 +1
    current = true;
    release();
    expect(await inflight).toBe(false); // 在途那次照常拿到它读到的旧值
    expect(await outbound.__isBridgeEnabledCachedForTest()).toBe(true); // 旧值没被缓存，重读
    expect(calls).toBe(2);
  });

  it("对照：读盘没被写盘打断时，结果照常进缓存（第二次读不再调读盘函数）——证明上一条的「不缓存」是世代号在起作用、不是缓存根本没工作", async () => {
    let calls = 0;
    outbound.__setBridgeEnabledReaderForTest(async () => {
      calls += 1;
      return true;
    });
    expect(await outbound.__isBridgeEnabledCachedForTest()).toBe(true);
    expect(await outbound.__isBridgeEnabledCachedForTest()).toBe(true);
    expect(calls).toBe(1);
  });
});

describe("group-outbound.isBridgeEnabledCached：设置写盘即作废", () => {
  it("patchSettingsFile 翻转总开关后，下一次读取立刻拿到新值（不等 8 秒 TTL）", async () => {
    await seed(false);
    expect(await groupOutbound.__isBridgeEnabledCachedForTest()).toBe(false);

    await writeRawBypassingNotify(true);
    expect(await groupOutbound.__isBridgeEnabledCachedForTest()).toBe(false); // 对照：缓存在生效

    const on = await patchSettingsFile({ patch: { feishuChatBridge: true } });
    expect(on.status).toBe("ok");
    expect(await groupOutbound.__isBridgeEnabledCachedForTest()).toBe(true);

    const off = await patchSettingsFile({ patch: { feishuChatBridge: false } });
    expect(off.status).toBe("ok");
    expect(await groupOutbound.__isBridgeEnabledCachedForTest()).toBe(false);
  });

  it("读盘进行中发生了写盘：这次调用拿到的旧值不会被填回缓存（下一次必须重读）", async () => {
    // 防的回归：作废之后，在途的那次旧读返回时又把写盘前的旧值填进缓存、再顶 8 秒
    let calls = 0;
    let current = false;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    groupOutbound.__setGroupOutboundDepsForTest({
      isBridgeEnabled: async () => {
        calls += 1;
        const seen = current; // 读盘瞬间看到的值
        if (calls === 1) await gate; // 第一次读卡在「已读到旧值、还没返回」
        return seen;
      },
    });

    const inflight = groupOutbound.__isBridgeEnabledCachedForTest();
    await seed(true); // 读盘期间写盘：通知 → 世代号 +1
    current = true;
    release();
    expect(await inflight).toBe(false); // 在途那次照常拿到它读到的旧值
    expect(await groupOutbound.__isBridgeEnabledCachedForTest()).toBe(true); // 旧值没被缓存，重读
    expect(calls).toBe(2);
  });
});

// ── R20-14：热重载 ──
// 全局 tap 是「先求值者胜」（存活的 tap 永远是第一版模块的闭包，读第一版里的缓存），旧写法的失效订阅却是「后求值者胜」
// （每次重新求值先注销旧订阅、再订一个清本版变量的）：热重载之后，存活 tap 读的那份缓存没人作废，退回 8 秒 TTL。
// 现在缓存 / 世代号 / 订阅句柄都在 globalThis 的 cell 上、订阅只订一次。这里用 vi.resetModules() 重新求值模块来模拟「新旧两版并存」。
// 没验证：真 Next dev 的 HMR 没有手点过（那一步需要开 dev server 改文件）。
describe("热重载：模块重新求值出第二版后，第一版仍在读的缓存也会被设置写盘作废", () => {
  it("outbound：A 缓存 false → 重新求值出 B → 不通知的改盘两边都还读到 false（缓存在生效）→ 生产写盘后 A 与 B 都立刻读到 true", async () => {
    await seed(false);
    const A = outbound;
    expect(await A.__isBridgeEnabledCachedForTest()).toBe(false); // A（先求值的那一版）缓存了 false

    vi.resetModules();
    const B = await import("@/lib/server/feishu-bridge/outbound");
    expect(B).not.toBe(A); // 确实是两份模块实例（不是同一个缓存的模块）

    await writeRawBypassingNotify(true); // 不通知的改盘：缓存在生效 → 两版都读到旧的 false
    expect(await A.__isBridgeEnabledCachedForTest()).toBe(false);
    expect(await B.__isBridgeEnabledCachedForTest()).toBe(false);

    const on = await patchSettingsFile({ patch: { feishuChatBridge: true } }); // 生产写盘入口
    expect(on.status).toBe("ok");
    // 关键：A（存活 tap 所在的那一版）的缓存也被作废——旧写法下 A 的订阅在 B 求值时被注销，A 会一直读到缓存里的 false
    expect(await A.__isBridgeEnabledCachedForTest()).toBe(true);
    expect(await B.__isBridgeEnabledCachedForTest()).toBe(true);
  });

  it("group-outbound：同一场景", async () => {
    await seed(false);
    const A = groupOutbound;
    expect(await A.__isBridgeEnabledCachedForTest()).toBe(false);

    vi.resetModules();
    const B = await import("@/lib/server/feishu-bridge/group-outbound");
    expect(B).not.toBe(A);

    await writeRawBypassingNotify(true);
    expect(await A.__isBridgeEnabledCachedForTest()).toBe(false);
    expect(await B.__isBridgeEnabledCachedForTest()).toBe(false);

    const on = await patchSettingsFile({ patch: { feishuChatBridge: true } });
    expect(on.status).toBe("ok");
    expect(await A.__isBridgeEnabledCachedForTest()).toBe(true);
    expect(await B.__isBridgeEnabledCachedForTest()).toBe(true);
  });

  it("世代号也是共享的：A 的读盘卡着、B 求值后发生写盘 → A 这次读到的旧值不会填回（跨版本的竞态同样被挡住）", async () => {
    await seed(false);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    outbound.__setBridgeEnabledReaderForTest(async () => {
      const seen = false; // 读盘瞬间看到的（旧）值
      await gate;
      return seen;
    });
    const inflight = outbound.__isBridgeEnabledCachedForTest(); // A 的读盘卡住

    vi.resetModules();
    const B = await import("@/lib/server/feishu-bridge/outbound"); // 此时模块被重新求值
    const on = await patchSettingsFile({ patch: { feishuChatBridge: true } }); // 写盘：共享 cell 的世代号 +1
    expect(on.status).toBe("ok");
    release();
    expect(await inflight).toBe(false); // A 照常拿到它读到的旧值
    outbound.__setBridgeEnabledReaderForTest(null); // 恢复真实读盘
    // 旧值没被填回缓存：B（以及 A）下一次读取走真实读盘、拿到盘上的 true
    expect(await B.__isBridgeEnabledCachedForTest()).toBe(true);
    expect(await outbound.__isBridgeEnabledCachedForTest()).toBe(true);
  });
});

describe("源码结构钉子：缓存 + 世代号 + 订阅句柄在 globalThis 的 cell 上，订阅只订一次", () => {
  it.each([
    ["outbound.ts", "src/lib/server/feishu-bridge/outbound.ts", "ENABLED_CELL_KEY", "getEnabledCell"],
    ["group-outbound.ts", "src/lib/server/feishu-bridge/group-outbound.ts", "BRIDGE_ENABLED_CELL_KEY", "getBridgeEnabledCell"],
  ])("%s：cell 挂 globalThis 用 ??= 只建一次；订阅用 cell.unsub ??= 只订一次，回调里世代号 +1 并清缓存", (_name, rel, key, getter) => {
    const src = readSource(rel);
    // cell 挂在 globalThis 的 KEY 上，`??=` 建一次
    expect(src).toMatch(new RegExp(String.raw`\(g\[${key}\] \?\?= \{ cache: null, gen: 0, unsub: null \}\)`));
    // 订阅：`??=` 只订一次；回调闭包 cell 本身（不是某个模块实例里的变量）
    expect(src).toMatch(/cell\.unsub \?\?= onSettingsWritten\(\(\) => \{\s*cell\.gen \+= 1;\s*cell\.cache = null;\s*\}\);/);
    const sub = blockAfter(src, "cell.unsub ??= onSettingsWritten(");
    expect(sub).toMatch(/cell\.cache = null;/);
    // 不再有模块级的缓存 / 世代号变量（它们正是热重载下「订阅与 tap 方向相反」的根）
    expect(src).not.toMatch(/^let (?:enabledCache|enabledCacheGen|bridgeEnabledCache|bridgeEnabledGen)\b/m);
    // 读缓存都从 cell 里取，并在读盘前先记世代号、读完比对
    expect(src).toMatch(new RegExp(String.raw`const cell = ${getter}\(\);`));
    expect(src).toMatch(/const gen = cell\.gen;/);
    expect(src).toMatch(/if \(gen === cell\.gen\) cell\.cache = \{ value, at: now \};/);
    // 不再有「先注销旧订阅」的旧写法（那是后求值者胜）
    expect(src).not.toMatch(/g\[KEY\]\?\.\(\);/);
  });
});
