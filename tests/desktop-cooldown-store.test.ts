/**
 * 自动解锁冷却截止时刻的落盘（electron-app/desktop/cooldown-store.mjs）及它在会话里的「重启不清零」语义。
 *
 * 为什么：「一次错误即停」是为了不让 AI 把错的开机密码反复输进去（连续输错会触发账户锁定）。冷却只放内存的话，
 * 输错之后重启 / 崩溃重启 / 自动更新 relaunch 就清零，下一次请求会再输一遍同样的错密码（第二轮评审 P1-1）。
 *
 * 这里用**真实**文件系统（系统临时目录里的私有目录）跑存取，再用「两个先后创建的 session 共用同一个文件」模拟重启。
 * 会话本身的冷却细节（注入假 store 的各种边界）见 desktop-session.test.ts。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createCooldownStore } from "../electron-app/desktop/cooldown-store.mjs";
import { cooldownFilePath } from "../electron-app/desktop/index.mjs";
import { createDesktopSession, SESSION_LIMITS } from "../electron-app/desktop/session.mjs";

let dir = "";
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "flowship-cooldown-test-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const fileIn = (d: string) => path.join(d, "desktop-state", "unlock-cooldown.json");
const posix = process.platform !== "win32";

describe("createCooldownStore：存取", () => {
  it("文件不存在 = 没失败过（0），不抛", () => {
    expect(createCooldownStore({ file: fileIn(dir) }).load()).toBe(0);
  });

  it("存了再读：原样回来；目录自动建；没有残留的临时文件", () => {
    const store = createCooldownStore({ file: fileIn(dir) });
    store.save(1_700_000_600_000);
    expect(store.load()).toBe(1_700_000_600_000);
    expect(fs.readdirSync(path.dirname(fileIn(dir)))).toEqual(["unlock-cooldown.json"]);
  });

  it.skipIf(!posix)("权限：文件 0600、目录 0700（只有当前用户能读写）", () => {
    createCooldownStore({ file: fileIn(dir) }).save(1_700_000_600_000);
    expect(fs.statSync(fileIn(dir)).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(fileIn(dir))).mode & 0o777).toBe(0o700);
  });

  it("内容里只有版本号和一个时间戳（没有任何密码 / 用户内容）", () => {
    createCooldownStore({ file: fileIn(dir) }).save(1_700_000_600_000);
    expect(JSON.parse(fs.readFileSync(fileIn(dir), "utf8"))).toEqual({ v: 1, until: 1_700_000_600_000 });
  });

  it("save(0) / 负数 / NaN：覆盖写成 until:0（不删文件——删失败的话旧冷却会在下次启动「复活」），读出来是 0", () => {
    const store = createCooldownStore({ file: fileIn(dir) });
    for (const v of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      store.save(1_700_000_600_000);
      store.save(v);
      expect(fs.existsSync(fileIn(dir))).toBe(true);
      expect(store.load()).toBe(0);
    }
  });

  it("小数时间戳取整", () => {
    const store = createCooldownStore({ file: fileIn(dir) });
    store.save(1_700_000_600_000.9);
    expect(store.load()).toBe(1_700_000_600_000);
  });
});

describe("createCooldownStore：读不了 / 读不懂 = 抛错（调用方据此 fail-closed）", () => {
  const writeRaw = (raw: string) => {
    fs.mkdirSync(path.dirname(fileIn(dir)), { recursive: true });
    fs.writeFileSync(fileIn(dir), raw);
  };

  it.each([
    ["不是 JSON", "not json{"],
    ["空文件", ""],
    ["版本号不对", JSON.stringify({ v: 2, until: 1 })],
    ["缺版本号", JSON.stringify({ until: 1 })],
    ["until 不是数字", JSON.stringify({ v: 1, until: "1700000000000" })],
    ["until 是负数", JSON.stringify({ v: 1, until: -1 })],
    ["until 缺失", JSON.stringify({ v: 1 })],
    ["顶层不是对象", JSON.stringify(42)],
    ["顶层是 null", "null"],
  ])("%s", (_name, raw) => {
    writeRaw(raw);
    expect(() => createCooldownStore({ file: fileIn(dir) }).load()).toThrow(/冷却记录/);
  });

  it("路径是个目录（读出 EISDIR 之类、不是「文件不存在」）：抛错，不当成没失败过", () => {
    fs.mkdirSync(fileIn(dir), { recursive: true });
    expect(() => createCooldownStore({ file: fileIn(dir) }).load()).toThrow(/读取冷却记录失败/);
  });

  it("读到的错误信息里不带路径 / 内容（只给错误码）", () => {
    fs.mkdirSync(fileIn(dir), { recursive: true });
    try {
      createCooldownStore({ file: fileIn(dir) }).load();
      throw new Error("应当抛错");
    } catch (err) {
      expect(String((err as Error).message)).not.toContain(dir);
    }
  });
});

describe("createCooldownStore：写入是原子的", () => {
  it("rename 失败：旧记录原样保留、临时文件被清掉、错误抛出去", () => {
    const store = createCooldownStore({ file: fileIn(dir) });
    store.save(1_700_000_600_000);
    const failing = createCooldownStore({
      file: fileIn(dir),
      fsImpl: { ...fs, renameSync: () => { throw new Error("rename 失败"); } },
    });
    expect(() => failing.save(1_700_009_999_000)).toThrow("rename 失败");
    expect(store.load()).toBe(1_700_000_600_000);
    expect(fs.readdirSync(path.dirname(fileIn(dir)))).toEqual(["unlock-cooldown.json"]);
  });

  it("写临时文件失败：错误抛出去，旧记录不受影响", () => {
    const store = createCooldownStore({ file: fileIn(dir) });
    store.save(1_700_000_600_000);
    const failing = createCooldownStore({
      file: fileIn(dir),
      fsImpl: { ...fs, writeFileSync: () => { throw new Error("磁盘满了"); } },
    });
    expect(() => failing.save(1_700_009_999_000)).toThrow("磁盘满了");
    expect(store.load()).toBe(1_700_000_600_000);
  });
});

describe("cooldownFilePath", () => {
  it("在 userData 下自己的 desktop-state 目录里（不进 logs/——那个文件夹会被整个发给开发者）", () => {
    const p = cooldownFilePath("/u/data");
    expect(p).toBe(path.join("/u/data", "desktop-state", "unlock-cooldown.json"));
    expect(p).not.toContain(`${path.sep}logs${path.sep}`);
  });
});

// ── 重启不清零（两个先后创建的 session 共用同一个文件）──

type World = { locked: boolean };
const NOW = 1_700_000_000_000;

const makeSession = (
  world: World,
  store: ReturnType<typeof createCooldownStore>,
  over: { unlockOk?: boolean; hang?: boolean; log?: (m: string) => void } = {},
) => {
  const unlock = vi.fn(async () => {
    // hang：输密码到 unlock() 返回之间进程被杀 / 崩溃——这个 promise 永远不兑现，session 后半段（结算冷却）永远不会跑
    if (over.hang) return new Promise<never>(() => {});
    if (over.unlockOk) {
      world.locked = false;
      return { ok: true };
    }
    return { ok: false, error: "提交后仍是锁屏" };
  });
  const session = createDesktopSession({
    driver: {
      platform: "darwin",
      isScreenLocked: () => world.locked,
      idleSeconds: () => 100,
      lockScreen: () => { world.locked = true; },
    } as never,
    unlocker: {
      supported: true,
      hasCredential: async () => true,
      unlock,
      lock: async () => { world.locked = true; return { ok: true }; },
    } as never,
    overlay: { show: () => {}, hide: () => {}, isShown: () => false },
    getPolicy: () => ({ enabled: true, lockedAccess: true }),
    cooldownStore: store,
    log: over.log,
  });
  return { session, unlock };
};

const codeOf = async (p: Promise<unknown>): Promise<string | undefined> => {
  try {
    await p;
  } catch (err) {
    return (err as { code?: string }).code;
  }
  return undefined;
};

describe("重启（新建 session、共用同一个冷却文件）不会清零", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("输错 → 重启 → 下一次请求被冷却挡住：不会把同一个错密码再输一遍", async () => {
    const store = createCooldownStore({ file: cooldownFilePath(dir) });
    const first = makeSession({ locked: true }, store);
    expect(await codeOf(first.session.begin("t1", { allowUnlock: true }))).toBe("UNLOCK_FAILED");
    expect(first.unlock).toHaveBeenCalledTimes(1);

    // —— 应用重启 ——
    const second = makeSession({ locked: true }, createCooldownStore({ file: cooldownFilePath(dir) }));
    expect(second.session.status().unlockCooldownUntil).toBe(NOW + SESSION_LIMITS.unlockCooldownMs);
    expect(await codeOf(second.session.begin("t1", { allowUnlock: true }))).toBe("UNLOCK_FAILED");
    expect(second.unlock).not.toHaveBeenCalled(); // 一个键都没输
  });

  it("冷却时间过了之后，重启后的新 session 可以再试", async () => {
    const store = createCooldownStore({ file: cooldownFilePath(dir) });
    const first = makeSession({ locked: true }, store);
    await codeOf(first.session.begin("t1", { allowUnlock: true }));

    vi.setSystemTime(NOW + SESSION_LIMITS.unlockCooldownMs + 1);
    const second = makeSession({ locked: true }, createCooldownStore({ file: cooldownFilePath(dir) }), { unlockOk: true });
    expect(second.session.status().unlockCooldownUntil).toBe(0);
    await expect(second.session.begin("t1", { allowUnlock: true })).resolves.toMatchObject({ unlockedByUs: true });
    expect(second.unlock).toHaveBeenCalledTimes(1);
  });

  it("重启前用户重新保存了开机密码（resetUnlockCooldown）：冷却记录被清掉，重启后可以再试", async () => {
    const store = createCooldownStore({ file: cooldownFilePath(dir) });
    const first = makeSession({ locked: true }, store);
    await codeOf(first.session.begin("t1", { allowUnlock: true }));
    first.session.resetUnlockCooldown();

    const second = makeSession({ locked: true }, createCooldownStore({ file: cooldownFilePath(dir) }), { unlockOk: true });
    expect(second.session.status().unlockCooldownUntil).toBe(0);
    await expect(second.session.begin("t1", { allowUnlock: true })).resolves.toMatchObject({ unlockedByUs: true });
  });

  it("记录文件坏了：按一整段冷却处理（fail-closed），并记日志；不是「没失败过」", async () => {
    fs.mkdirSync(path.dirname(cooldownFilePath(dir)), { recursive: true });
    fs.writeFileSync(cooldownFilePath(dir), "garbage");
    const logs: string[] = [];
    const s = makeSession({ locked: true }, createCooldownStore({ file: cooldownFilePath(dir) }), { log: (m) => logs.push(m) });
    expect(s.session.status().unlockCooldownUntil).toBe(NOW + SESSION_LIMITS.unlockCooldownMs);
    expect(await codeOf(s.session.begin("t1", { allowUnlock: true }))).toBe("UNLOCK_FAILED");
    expect(s.unlock).not.toHaveBeenCalled();
    expect(logs.join("\n")).toMatch(/冷却记录读不了/);
  });

  // 第三轮评审 P1-2：冷却要在**输密码之前**预写。以前等 unlock() 返回之后才落盘——输密码到 unlock() 返回之间最长十来秒，
  // 这段窗口里应用退出 / 崩溃 / 自动更新重启，重启后冷却是空的，同一个（可能错的）密码会被再输一遍
  it("输密码途中进程死掉（unlock 永不返回）→ 重启 → 冷却已经在盘上：下一次请求被挡住，一个键都不输", async () => {
    const first = makeSession({ locked: true }, createCooldownStore({ file: cooldownFilePath(dir) }), { hang: true });
    void first.session.begin("t1", { allowUnlock: true }).catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(first.unlock).toHaveBeenCalledTimes(1);
    // 此刻 unlock() 还没返回，session 没来得及做任何「结算」——盘上必须已经有冷却
    expect(createCooldownStore({ file: cooldownFilePath(dir) }).load()).toBe(NOW + SESSION_LIMITS.unlockCooldownMs);

    // —— 进程被杀，应用重启 ——
    const second = makeSession({ locked: true }, createCooldownStore({ file: cooldownFilePath(dir) }), { unlockOk: true });
    expect(second.session.status().unlockCooldownUntil).toBe(NOW + SESSION_LIMITS.unlockCooldownMs);
    expect(await codeOf(second.session.begin("t1", { allowUnlock: true }))).toBe("UNLOCK_FAILED");
    expect(second.unlock).not.toHaveBeenCalled(); // 一个键都没输

    // 一整段冷却过去之后恢复
    vi.setSystemTime(NOW + SESSION_LIMITS.unlockCooldownMs + 1);
    const third = makeSession({ locked: true }, createCooldownStore({ file: cooldownFilePath(dir) }), { unlockOk: true });
    await expect(third.session.begin("t1", { allowUnlock: true })).resolves.toMatchObject({ unlockedByUs: true });
  });

  it("解锁成功：预写的冷却被撤回——盘上读出来是 0，重启后可以直接用（不会被误判成「刚失败过」）", async () => {
    const first = makeSession({ locked: true }, createCooldownStore({ file: cooldownFilePath(dir) }), { unlockOk: true });
    await expect(first.session.begin("t1", { allowUnlock: true })).resolves.toMatchObject({ unlockedByUs: true });
    expect(createCooldownStore({ file: cooldownFilePath(dir) }).load()).toBe(0);

    const second = makeSession({ locked: true }, createCooldownStore({ file: cooldownFilePath(dir) }), { unlockOk: true });
    expect(second.session.status().unlockCooldownUntil).toBe(0);
    await expect(second.session.begin("t1", { allowUnlock: true })).resolves.toMatchObject({ unlockedByUs: true });
    expect(second.unlock).toHaveBeenCalledTimes(1);
  });

  it("没输过密码的失败（attempted:false）不进冷却：预写的记录被撤回（盘上读出来是 0）", async () => {
    const world = { locked: true };
    const store = createCooldownStore({ file: cooldownFilePath(dir) });
    const s = createDesktopSession({
      driver: { platform: "darwin", isScreenLocked: () => world.locked, idleSeconds: () => 100, lockScreen: () => {} } as never,
      unlocker: {
        supported: true,
        hasCredential: async () => true,
        unlock: async () => ({ ok: false, attempted: false, code: "NEED_PERMISSION", error: "没权限" }),
        lock: async () => ({ ok: true }),
      } as never,
      overlay: { show: () => {}, hide: () => {}, isShown: () => false },
      getPolicy: () => ({ enabled: true, lockedAccess: true }),
      cooldownStore: store,
    });
    expect(await codeOf(s.begin("t1", { allowUnlock: true }))).toBe("NEED_PERMISSION");
    // 预写过又撤回：文件在，但记录是 0 = 没有冷却（重启后读出来不在冷却）
    expect(store.load()).toBe(0);
    expect(createDesktopSession({
      driver: { platform: "darwin", isScreenLocked: () => world.locked, idleSeconds: () => 100, lockScreen: () => {} } as never,
      unlocker: null,
      overlay: { show: () => {}, hide: () => {}, isShown: () => false },
      getPolicy: () => ({ enabled: true, lockedAccess: true }),
      cooldownStore: createCooldownStore({ file: cooldownFilePath(dir) }),
    }).status().unlockCooldownUntil).toBe(0);
  });
});
