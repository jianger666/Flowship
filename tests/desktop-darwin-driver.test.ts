/**
 * macOS 桌面驱动（electron-app/desktop/drivers/darwin.mjs）——用假 koffi / 假 execFile，不碰真实系统。
 *
 * 钉死的是「发给系统的事件序列对不对」，这些在真机上很难肉眼发现、出错又会直接表现为「按错键 / 卡住修饰键」：
 * - 组合键：修饰键按固定顺序按下、倒序抬起，且无论中途是否出错都必须抬起（否则整台电脑像按住了 Cmd）
 * - 文本：Unicode 事件（中文 / emoji）与真实键码事件（ASCII，锁屏输密码用）两条路径；键码路径整段预检，
 *   遇到打不出的字符时一个事件都不发，且报错里不回显字符（那可能是密码）
 * - 鼠标：双击的 clickState、拖拽出错也要抬起按键、滚动方向与分段
 * - 状态：锁屏判断三态（锁 / 没锁 / 读不到）、CoreFoundation 对象都释放
 * - 非 macOS 不加载任何原生库；缺系统符号时 init 失败并说明原因，而不是半残运行
 */
import { describe, expect, it, vi } from "vitest";

import { asciiToKey, createDarwinDriver, MAC_KEYCODES } from "../electron-app/desktop/drivers/darwin.mjs";
import { CANONICAL_KEYS } from "../electron-app/desktop/keys.mjs";

type Desc =
  | { kind: "mouse"; type: number; x: number; y: number; button: number; clickState: number }
  | { kind: "key"; code: number; down: boolean; flags: number; unicode?: number[] }
  | { kind: "scroll"; v: number; h: number };

const FLAG = { shift: 0x20000, ctrl: 0x40000, alt: 0x80000, meta: 0x100000 };
const TRUE_MARK = 9001;
const FALSE_MARK = 9002;

const protoName = (proto: string): string => {
  const m = /([A-Za-z0-9_]+)\s*\(/.exec(proto);
  if (!m) throw new Error(`bad proto: ${proto}`);
  return m[1];
};

const makeFake = (
  opts: {
    locked?: boolean | "missing" | "nodict";
    trusted?: boolean;
    missingFns?: string[];
    loginThrows?: boolean;
    sacThrows?: boolean;
    idle?: number;
    postThrows?: (d: Desc, n: number) => boolean;
  } = {},
) => {
  let seq = 100;
  const objs = new Map<number, Desc>();
  const created: number[] = [];
  const released: number[] = [];
  const posted: Desc[] = [];
  const calls: string[] = [];
  let postCount = 0;

  const newObj = (d: Desc | null): number => {
    seq += 1;
    created.push(seq);
    if (d) objs.set(seq, d);
    return seq;
  };

  const impl: Record<string, (...a: unknown[]) => unknown> = {
    CGEventCreateMouseEvent: (_src, type, pos, button) =>
      newObj({ kind: "mouse", type: type as number, x: (pos as { x: number }).x, y: (pos as { y: number }).y, button: button as number, clickState: 0 }),
    CGEventCreateKeyboardEvent: (_src, code, down) => newObj({ kind: "key", code: code as number, down: down as boolean, flags: -1 }),
    CGEventCreateScrollWheelEvent2: (_src, _units, _count, v, h) => newObj({ kind: "scroll", v: v as number, h: h as number }),
    CGEventKeyboardSetUnicodeString: (ev, len, units) => {
      const d = objs.get(ev as number);
      if (d?.kind === "key") d.unicode = Array.from(units as Uint16Array).slice(0, len as number);
    },
    CGEventSetFlags: (ev, flags) => {
      const d = objs.get(ev as number);
      if (d?.kind === "key") d.flags = Number(flags);
    },
    CGEventSetIntegerValueField: (ev, field, value) => {
      const d = objs.get(ev as number);
      if (d?.kind === "mouse" && field === 1) d.clickState = Number(value);
    },
    CGEventPost: (_tap, ev) => {
      const d = objs.get(ev as number);
      postCount += 1;
      if (d && opts.postThrows?.(d, postCount)) throw new Error("post 失败");
      if (d) posted.push({ ...d });
    },
    CGEventSourceCreate: () => -1,
    CGSessionCopyCurrentDictionary: () => (opts.locked === "nodict" ? null : newObj(null)),
    CFStringCreateWithCString: () => newObj(null),
    CFDictionaryGetValue: () => {
      if (opts.locked === "missing" || opts.locked === undefined) return opts.locked === undefined ? FALSE_MARK : null;
      return opts.locked ? TRUE_MARK : FALSE_MARK;
    },
    CFBooleanGetValue: (v) => v === TRUE_MARK,
    CFRelease: (obj) => {
      released.push(obj as number);
    },
    CGEventSourceSecondsSinceLastEventType: () => opts.idle ?? 42,
    CGMainDisplayID: () => 1,
    CGDisplayBounds: () => ({ origin: { x: 0.2, y: -0.4 }, size: { width: 1512.4, height: 981.6 } }),
    AXIsProcessTrusted: () => opts.trusted ?? false,
    SACLockScreenImmediate: () => {
      calls.push("SACLockScreenImmediate");
      if (opts.sacThrows) throw new Error("SAC 调用失败");
      return 0;
    },
  };

  const koffi = {
    version: "0.0.0-test",
    struct: vi.fn(() => ({})),
    load: vi.fn((path: string) => {
      if (opts.loginThrows && path.includes("login.framework")) throw new Error("login.framework 不存在");
      return {
        func: (proto: string) => {
          const name = protoName(proto);
          if (opts.missingFns?.includes(name)) throw new Error(`symbol not found: ${name}`);
          const f = impl[name];
          if (!f) throw new Error(`假 koffi 没有实现 ${name}`);
          return (...args: unknown[]) => f(...args);
        },
      };
    }),
  };

  return { koffi, posted, created, released, calls };
};

const execOk = () => {
  const log: Array<{ file: string; args: string[] }> = [];
  const exec = vi.fn((file: string, args: string[], _opts: unknown, cb: (e: Error | null, out: string, err: string) => void) => {
    log.push({ file, args });
    cb(null, "", "");
    return { unref() {} };
  });
  return { exec, log };
};

const boot = async (fakeOpts: Parameters<typeof makeFake>[0] = {}) => {
  const fake = makeFake(fakeOpts);
  const ex = execOk();
  const driver = createDarwinDriver({ koffi: fake.koffi, platform: "darwin", execFile: ex.exec as never });
  const r = await driver.init();
  return { fake, ex, driver, r };
};

/** 推进假时钟直到动作结束；返回错误（没有则 null） */
const settle = async (p: Promise<unknown> | unknown): Promise<unknown> => {
  const guarded = Promise.resolve(p).then(
    () => null,
    (e: unknown) => e,
  );
  await vi.runAllTimersAsync();
  return guarded;
};

const keySeq = (posted: Desc[]) =>
  posted.filter((d): d is Extract<Desc, { kind: "key" }> => d.kind === "key").map((d) => ({ code: d.code, down: d.down, flags: d.flags }));

describe("init", () => {
  it("非 macOS：不加载任何原生库，直接说明", async () => {
    const fake = makeFake();
    const driver = createDarwinDriver({ koffi: fake.koffi, platform: "win32" });
    const r = await driver.init();
    expect(r).toMatchObject({ ok: false });
    expect(fake.koffi.load).not.toHaveBeenCalled();
  });

  it("成功：全部库加载、没有绑定失败；重复 init 幂等", async () => {
    const { fake, driver, r } = await boot();
    expect(r).toEqual({ ok: true });
    const d = driver.diagnostics() as { loaded: Record<string, boolean>; bindFailures: string[]; lockScreenApi: string };
    expect(Object.values(d.loaded).every(Boolean)).toBe(true);
    expect(d.bindFailures).toEqual([]);
    expect(d.lockScreenApi).toBe("SACLockScreenImmediate");
    const loads = fake.koffi.load.mock.calls.length;
    await driver.init();
    expect(fake.koffi.load.mock.calls.length).toBe(loads);
  });

  it("缺必需的系统符号：init 失败并点名缺了谁（不是半残运行）", async () => {
    const { r } = await boot({ missingFns: ["CGEventPost"] });
    expect(r).toMatchObject({ ok: false });
    expect((r as { error: string }).error).toContain("CGEventPost");
  });

  it("私有 login.framework 不在：不致命，锁屏退回快捷键", async () => {
    const { r, driver } = await boot({ loginThrows: true });
    expect(r).toEqual({ ok: true });
    expect((driver.diagnostics() as { lockScreenApi: string }).lockScreenApi).toBe("shortcut");
  });
});

describe("键码表", () => {
  it("覆盖 keys.mjs 的全部规范键名", () => {
    const missing = CANONICAL_KEYS.filter((k: string) => (MAC_KEYCODES as Record<string, number>)[k] === undefined);
    expect(missing).toEqual([]);
  });

  it("可打印 ASCII（0x20–0x7E）每个字符都能映射，且不同字符的 (键码, shift) 互不冲突", () => {
    const seen = new Map<string, string>();
    for (let c = 0x20; c <= 0x7e; c += 1) {
      const ch = String.fromCharCode(c);
      const k = asciiToKey(ch);
      expect(k, `字符 ${JSON.stringify(ch)}`).not.toBeNull();
      const sig = `${k!.code}/${k!.shift}`;
      expect(seen.has(sig), `${JSON.stringify(ch)} 与 ${JSON.stringify(seen.get(sig))} 键位冲突`).toBe(false);
      seen.set(sig, ch);
    }
    expect(seen.size).toBe(95);
  });

  it("asciiToKey 的几个代表：大写要 shift、符号按美式布局、非 ASCII / 多字符给 null", () => {
    expect(asciiToKey("a")).toEqual({ code: 0, shift: false });
    expect(asciiToKey("A")).toEqual({ code: 0, shift: true });
    expect(asciiToKey("1")).toEqual({ code: 18, shift: false });
    expect(asciiToKey("!")).toEqual({ code: 18, shift: true });
    expect(asciiToKey("-")).toEqual({ code: 27, shift: false });
    expect(asciiToKey("_")).toEqual({ code: 27, shift: true });
    expect(asciiToKey("+")).toEqual({ code: 24, shift: true });
    expect(asciiToKey(" ")).toEqual({ code: 49, shift: false });
    expect(asciiToKey("你")).toBeNull();
    expect(asciiToKey("ab")).toBeNull();
    expect(asciiToKey("")).toBeNull();
    expect(asciiToKey("\n")).toBeNull();
  });
});

describe("keyCombo", () => {
  it("cmd+shift+v：修饰键按固定顺序按下、倒序抬起，flags 逐级累加 / 递减", async () => {
    vi.useFakeTimers();
    try {
      const { fake, driver } = await boot();
      expect(await settle(driver.keyCombo({ mods: ["shift", "meta"], key: "v" }))).toBeNull();
      expect(keySeq(fake.posted)).toEqual([
        { code: 56, down: true, flags: FLAG.shift },
        { code: 55, down: true, flags: FLAG.shift | FLAG.meta },
        { code: 9, down: true, flags: FLAG.shift | FLAG.meta },
        { code: 9, down: false, flags: FLAG.shift | FLAG.meta },
        { code: 55, down: false, flags: FLAG.shift },
        { code: 56, down: false, flags: 0 },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("单键：flags 显式写 0（不让用户此刻物理按着的修饰键混进来）", async () => {
    vi.useFakeTimers();
    try {
      const { fake, driver } = await boot();
      await settle(driver.keyCombo({ mods: [], key: "enter" }));
      expect(keySeq(fake.posted)).toEqual([
        { code: 36, down: true, flags: 0 },
        { code: 36, down: false, flags: 0 },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("「+」键自动补 shift（美式布局上它是 Shift+=）", async () => {
    vi.useFakeTimers();
    try {
      const { fake, driver } = await boot();
      await settle(driver.keyCombo({ mods: ["meta"], key: "plus" }));
      const seq = keySeq(fake.posted);
      expect(seq.some((e) => e.code === 56 && e.down)).toBe(true); // shift 被按下
      expect(seq.filter((e) => e.code === 24).map((e) => e.flags)).toEqual([FLAG.shift | FLAG.meta, FLAG.shift | FLAG.meta]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("主键投递失败：修饰键仍然全部抬起（不能让电脑卡在按住 Cmd 的状态）", async () => {
    vi.useFakeTimers();
    try {
      const { fake, driver } = await boot({
        postThrows: (d) => d.kind === "key" && d.code === 9 && d.down,
      });
      const err = await settle(driver.keyCombo({ mods: ["ctrl", "meta"], key: "v" }));
      expect(err).toBeInstanceOf(Error);
      const seq = keySeq(fake.posted);
      expect(seq.filter((e) => !e.down).map((e) => e.code)).toEqual([55, 59]); // meta、ctrl 倒序抬起
      expect(seq[seq.length - 1]).toEqual({ code: 59, down: false, flags: 0 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("不认识的键直接报错，什么事件都不发", async () => {
    const { fake, driver } = await boot();
    await expect(driver.keyCombo({ mods: [], key: "nope" })).rejects.toThrow(/不认识的按键/);
    expect(fake.posted).toEqual([]);
  });
});

describe("typeText", () => {
  it("unicode 模式：每个字符一对 down/up，带 UTF-16 单元（emoji 是两个单元），flags 恒为 0", async () => {
    vi.useFakeTimers();
    try {
      const { fake, driver } = await boot();
      await settle(driver.typeText("你a😀"));
      const keys = fake.posted.filter((d): d is Extract<Desc, { kind: "key" }> => d.kind === "key");
      expect(keys.map((k) => [k.down, k.unicode])).toEqual([
        [true, [0x4f60]],
        [false, [0x4f60]],
        [true, [0x61]],
        [false, [0x61]],
        [true, [0xd83d, 0xde00]],
        [false, [0xd83d, 0xde00]],
      ]);
      expect(keys.every((k) => k.flags === 0)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("unicode 模式：换行 / 制表符走真实键码（Return 36 / Tab 48），不带字符串", async () => {
    vi.useFakeTimers();
    try {
      const { fake, driver } = await boot();
      await settle(driver.typeText("\n\t"));
      expect(keySeq(fake.posted).map((e) => e.code)).toEqual([36, 36, 48, 48]);
      expect(fake.posted.every((d) => d.kind !== "key" || d.unicode === undefined)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keys 模式：大写 / 符号按美式布局，shift 一定抬起", async () => {
    vi.useFakeTimers();
    try {
      const { fake, driver } = await boot();
      expect(await settle(driver.typeText("Ab1!", { mode: "keys" }))).toBeNull();
      expect(keySeq(fake.posted)).toEqual([
        // A = shift + a
        { code: 56, down: true, flags: FLAG.shift },
        { code: 0, down: true, flags: FLAG.shift },
        { code: 0, down: false, flags: FLAG.shift },
        { code: 56, down: false, flags: 0 },
        // b
        { code: 11, down: true, flags: 0 },
        { code: 11, down: false, flags: 0 },
        // 1
        { code: 18, down: true, flags: 0 },
        { code: 18, down: false, flags: 0 },
        // ! = shift + 1
        { code: 56, down: true, flags: FLAG.shift },
        { code: 18, down: true, flags: FLAG.shift },
        { code: 18, down: false, flags: FLAG.shift },
        { code: 56, down: false, flags: 0 },
      ]);
      // 没有任何 Unicode 字符串事件
      expect(fake.posted.every((d) => d.kind !== "key" || d.unicode === undefined)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keys 模式：含打不出的字符 → 整段预检失败，一个事件都不发，报错里不回显字符", async () => {
    const { fake, driver } = await boot();
    const err = await (async () => driver.typeText("pass你word", { mode: "keys" }))().catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain("你");
    expect((err as Error).message).not.toContain("pass");
    expect(fake.posted).toEqual([]);
  });

  it("keys 模式：shift 抬起前出错，也要尝试把 shift 抬起来", async () => {
    vi.useFakeTimers();
    try {
      const { fake, driver } = await boot({
        postThrows: (d) => d.kind === "key" && d.code === 0 && d.down, // 主键按下失败
      });
      const err = await settle(driver.typeText("A", { mode: "keys" }));
      expect(err).toBeInstanceOf(Error);
      expect(keySeq(fake.posted).at(-1)).toEqual({ code: 56, down: false, flags: 0 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("canTypeKeys：和 keys 模式的预检同一套判定（ASCII 可打印字符 + 换行 / 制表符才算打得出）", async () => {
    const { driver } = await boot();
    const canTypeKeys = driver.canTypeKeys!;
    expect(canTypeKeys("Abc123!@# ~")).toBe(true);
    expect(canTypeKeys("a\tb\nc\r")).toBe(true);
    expect(canTypeKeys("")).toBe(true);
    for (const bad of ["密码", "pass😀", "café", "a\u0000b", "a\u007fb"]) expect(canTypeKeys(bad), bad).toBe(false);
    // 与真实输入保持一致：canTypeKeys 说「能」的，typeText(keys) 不会因为预检而失败
    vi.useFakeTimers();
    try {
      const ok = await boot();
      expect(await settle(ok.driver.typeText("Zz9~", { mode: "keys" }))).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("unicode 模式 shouldStop：开头就问一次（true 就一个字都不打，且不抛错）", async () => {
    vi.useFakeTimers();
    try {
      const { fake, driver } = await boot();
      const shouldStop = vi.fn(() => true);
      expect(await settle(driver.typeText("hello", { shouldStop }))).toBeNull();
      expect(shouldStop).toHaveBeenCalledTimes(1);
      expect(fake.posted).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("unicode 模式 shouldStop：每 12 个字符问一次，一旦 true 就收手——不再打剩下的字，也不再让出时间片之后继续", async () => {
    vi.useFakeTimers();
    try {
      const { fake, driver } = await boot();
      let asked = 0;
      const shouldStop = () => {
        asked += 1;
        return asked >= 3; // 第 1、2 次（第 0、12 个字符前）放行；第 3 次（第 24 个字符前）喊停
      };
      const text = "a".repeat(40);
      expect(await settle(driver.typeText(text, { shouldStop }))).toBeNull();
      const downs = fake.posted.filter((d) => d.kind === "key" && d.down);
      expect(downs).toHaveLength(24); // 只打了前 24 个，不是 40 个
      expect(asked).toBe(3);
      // 每个按下都配了抬起（收手发生在字符边界上，不留「按住」的键）
      expect(fake.posted.filter((d) => d.kind === "key" && !d.down)).toHaveLength(24);
    } finally {
      vi.useRealTimers();
    }
  });

  it("unicode 模式没传 shouldStop：行为不变（兼容旧调用方）", async () => {
    vi.useFakeTimers();
    try {
      const { fake, driver } = await boot();
      expect(await settle(driver.typeText("x".repeat(30)))).toBeNull();
      expect(fake.posted.filter((d) => d.kind === "key" && d.down)).toHaveLength(30);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("鼠标", () => {
  it("双击：先移过去，再 down/up 两遍，clickState 依次为 1、2", async () => {
    vi.useFakeTimers();
    try {
      const { fake, driver } = await boot();
      await settle(driver.click(100, 200, { count: 2 }));
      expect(fake.posted).toEqual([
        { kind: "mouse", type: 5, x: 100, y: 200, button: 0, clickState: 0 },
        { kind: "mouse", type: 1, x: 100, y: 200, button: 0, clickState: 1 },
        { kind: "mouse", type: 2, x: 100, y: 200, button: 0, clickState: 1 },
        { kind: "mouse", type: 1, x: 100, y: 200, button: 0, clickState: 2 },
        { kind: "mouse", type: 2, x: 100, y: 200, button: 0, clickState: 2 },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("右键用 right 的事件类型 / 按钮号；次数夹在 1–3", async () => {
    vi.useFakeTimers();
    try {
      const { fake, driver } = await boot();
      await settle(driver.click(1, 2, { button: "right", count: 9 }));
      const types = fake.posted.map((d) => (d.kind === "mouse" ? d.type : -1));
      expect(types).toEqual([5, 3, 4, 3, 4, 3, 4]);
      expect(fake.posted.filter((d) => d.kind === "mouse" && d.type === 3).every((d) => d.kind === "mouse" && d.button === 1)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("拖拽：移到起点 → 按下 → 10 段移动 → 抬起", async () => {
    vi.useFakeTimers();
    try {
      const { fake, driver } = await boot();
      await settle(driver.drag({ x: 0, y: 0 }, { x: 100, y: 50 }));
      const types = fake.posted.map((d) => (d.kind === "mouse" ? d.type : -1));
      expect(types).toEqual([5, 1, ...Array(10).fill(6), 2]);
      const last = fake.posted[fake.posted.length - 1];
      expect(last).toMatchObject({ type: 2, x: 100, y: 50 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("拖拽中途投递失败：按键仍然被抬起（鼠标不能卡在按下状态）", async () => {
    vi.useFakeTimers();
    try {
      let drags = 0;
      const { fake, driver } = await boot({
        postThrows: (d) => d.kind === "mouse" && d.type === 6 && (drags += 1) === 3,
      });
      const err = await settle(driver.drag({ x: 0, y: 0 }, { x: 100, y: 0 }));
      expect(err).toBeInstanceOf(Error);
      expect(fake.posted[fake.posted.length - 1]).toMatchObject({ kind: "mouse", type: 2 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("滚动：对外 dy>0 = 向下看，所以滚轮取负；超过 10 格分段发", async () => {
    vi.useFakeTimers();
    try {
      const { fake, driver } = await boot();
      await settle(driver.scroll(10, 20, 0, 25));
      const wheels = fake.posted.filter((d): d is Extract<Desc, { kind: "scroll" }> => d.kind === "scroll").map((d) => [d.v, d.h]);
      expect(wheels).toEqual([
        [-10, 0],
        [-10, 0],
        [-5, 0],
      ]);
      // 先把鼠标移到目标位置，滚动才落在正确的元素上
      expect(fake.posted[0]).toMatchObject({ kind: "mouse", type: 5, x: 10, y: 20 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("滚动：向右 / 向上的符号", async () => {
    vi.useFakeTimers();
    try {
      const { fake, driver } = await boot();
      await settle(driver.scroll(0, 0, 3, -4));
      const w = fake.posted.find((d) => d.kind === "scroll") as Extract<Desc, { kind: "scroll" }>;
      expect([w.v, w.h]).toEqual([4, -3]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("状态读取", () => {
  it("锁屏三态：锁了 / 没锁（键缺失或为假）/ 读不到", async () => {
    expect((await boot({ locked: true })).driver.isScreenLocked()).toBe(true);
    expect((await boot({ locked: false })).driver.isScreenLocked()).toBe(false);
    expect((await boot({ locked: "missing" })).driver.isScreenLocked()).toBe(false);
    expect((await boot({ locked: "nodict" })).driver.isScreenLocked()).toBeNull();
  });

  it("读锁屏状态创建的 CoreFoundation 对象全部释放（不泄漏）", async () => {
    const { fake, driver } = await boot({ locked: true });
    for (let i = 0; i < 5; i += 1) driver.isScreenLocked();
    expect([...fake.released].sort()).toEqual([...fake.created].sort());
  });

  it("idleSeconds / getPrimaryDisplay：数值与取整", async () => {
    const { driver } = await boot({ idle: 7.5 });
    expect(driver.idleSeconds()).toBe(7.5);
    expect(driver.getPrimaryDisplay()).toEqual({ x: 0, y: 0, width: 1512, height: 982 }); // 0.2 / -0.4 取整后是 0（含 -0 归一）
  });

  it("诊断快照不抛、含权限与锁屏状态，且不含用户内容", async () => {
    const { driver } = await boot({ trusted: true, locked: false });
    const d = driver.diagnostics() as Record<string, unknown>;
    expect(d).toMatchObject({ platform: "darwin", ready: true, axTrusted: true, locked: false });
    expect(() => JSON.stringify(d)).not.toThrow();
  });
});

describe("锁屏 / 唤醒", () => {
  it("优先用 SACLockScreenImmediate，不发快捷键", async () => {
    const { fake, driver } = await boot();
    await driver.lockScreen();
    expect(fake.calls).toEqual(["SACLockScreenImmediate"]);
    expect(fake.posted).toEqual([]);
  });

  it("私有接口不在 / 调用失败：退回 Ctrl+Cmd+Q", async () => {
    vi.useFakeTimers();
    try {
      for (const o of [{ loginThrows: true }, { sacThrows: true }]) {
        const { fake, driver } = await boot(o);
        expect(await settle(driver.lockScreen())).toBeNull();
        expect(keySeq(fake.posted).filter((e) => e.down).map((e) => e.code)).toEqual([59, 55, 12]); // ctrl、cmd、q
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("method:'shortcut'：绕开私有接口（它可能「调用成功但没生效」），直接按 Ctrl+Cmd+Q；method:'auto' 与不传一致", async () => {
    vi.useFakeTimers();
    try {
      const { fake, driver } = await boot();
      expect(await settle(driver.lockScreen({ method: "shortcut" }))).toBeNull();
      expect(fake.calls).toEqual([]); // 私有接口一次都没调
      expect(keySeq(fake.posted).filter((e) => e.down).map((e) => e.code)).toEqual([59, 55, 12]);

      const auto = await boot();
      await auto.driver.lockScreen({ method: "auto" });
      expect(auto.fake.calls).toEqual(["SACLockScreenImmediate"]);
      expect(auto.fake.posted).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("wakeDisplay：caffeinate -u -t 5", async () => {
    const { ex, driver } = await boot();
    await driver.wakeDisplay();
    expect(ex.log).toEqual([{ file: "/usr/bin/caffeinate", args: ["-u", "-t", "5"] }]);
  });
});

describe("应用", () => {
  it("openApp：名字走 open -a，绝对路径直接打开", async () => {
    const { ex, driver } = await boot();
    await driver.openApp("微信");
    await driver.openApp("/Applications/Safari.app");
    expect(ex.log).toEqual([
      { file: "/usr/bin/open", args: ["-a", "微信"] },
      { file: "/usr/bin/open", args: ["/Applications/Safari.app"] },
    ]);
  });

  it("openApp：空名 / 超长 / 以 - 开头（会被当成 open 的选项）一律拒绝，不执行命令", async () => {
    const { ex, driver } = await boot();
    for (const bad of ["", "   ", "x".repeat(301), "-a", "--help"]) {
      await expect(driver.openApp(bad)).rejects.toThrow();
    }
    expect(ex.log).toEqual([]);
  });

  it("openApp：系统打不开时给中文提示并带上 stderr", async () => {
    const fake = makeFake();
    const exec = vi.fn((_f: string, _a: string[], _o: unknown, cb: (e: Error | null, out: string, err: string) => void) => {
      cb(new Error("exit 1"), "", "Unable to find application named 'Nope'");
      return { unref() {} };
    });
    const driver = createDarwinDriver({ koffi: fake.koffi, platform: "darwin", execFile: exec as never });
    await driver.init();
    await expect(driver.openApp("Nope")).rejects.toThrow(/打不开应用「Nope」.*Unable to find/);
  });

  describe("openApp：按显示名找应用（「微信」「飞书」「访达」——`open -a` 只认文件名 WeChat / Lark / Finder）", () => {
    type Call = { file: string; args: string[] };
    type Reply = { out?: string; err?: string; fail?: boolean | Error };
    const scripted = (handler: (c: Call) => Reply) => {
      const log: Call[] = [];
      const exec = vi.fn((file: string, args: string[], _o: unknown, cb: (e: Error | null, out: string, err: string) => void) => {
        const c = { file, args };
        log.push(c);
        const r = handler(c);
        if (r.fail) cb(r.fail instanceof Error ? r.fail : new Error("exit 1"), "", r.err ?? "");
        else cb(null, r.out ?? "", "");
        return { unref() {} };
      });
      return { exec, log };
    };
    const bootWith = async (exec: unknown, extra: Record<string, unknown> = {}) => {
      const driver = createDarwinDriver({ koffi: makeFake().koffi, platform: "darwin", execFile: exec as never, homeDir: "/Users/me", ...extra });
      await driver.init();
      return driver;
    };
    const NOT_FOUND = (n: string) => ({ fail: true, err: `Unable to find application named '${n}'` });
    const queryOf = (c: Call) => c.args[0];

    it("`open -a 微信` 找不到 → 按显示名精确搜一次 → 找到 /Applications/WeChat.app 就按路径打开", async () => {
      const { exec, log } = scripted((c) => {
        if (c.file === "/usr/bin/open" && c.args[0] === "-a") return NOT_FOUND("微信");
        if (c.file === "/usr/bin/mdfind") return { out: "/Applications/WeChat.app\n" };
        return {};
      });
      const driver = await bootWith(exec);
      await expect(driver.openApp("微信")).resolves.toBeUndefined();
      expect(log.map((c) => [c.file, c.args.length])).toEqual([
        ["/usr/bin/open", 2],
        ["/usr/bin/mdfind", 1],
        ["/usr/bin/open", 1],
      ]);
      expect(log[0]!.args).toEqual(["-a", "微信"]);
      expect(queryOf(log[1]!)).toBe('kMDItemContentType == "com.apple.application-bundle" && kMDItemDisplayName == "微信"c'); // 精确匹配，不带通配符
      expect(log[2]!.args).toEqual(["/Applications/WeChat.app"]);
    });

    it("`open -a` 认得的名字不去搜（WeChat / Safari 这种）", async () => {
      const { exec, log } = scripted(() => ({}));
      const driver = await bootWith(exec);
      await driver.openApp("Safari");
      expect(log).toEqual([{ file: "/usr/bin/open", args: ["-a", "Safari"] }]);
    });

    it("只认顶层应用：应用包里的辅助程序、别处的副本、不在常见应用目录里的都不算", async () => {
      const { exec, log } = scripted((c) => {
        if (c.args[0] === "-a") return NOT_FOUND("飞书");
        if (c.file === "/usr/bin/mdfind") {
          return {
            out: [
              "/Applications/Lark.app/Contents/Frameworks/Lark Helper.app",
              "/Users/me/Library/Containers/com.bytedance.macos.feishu/Data/Library/Application Support/LarkShell/iron/bundle/x/Lark Helper (Iron).app",
              "/Users/me/Downloads/Lark.app",
              "/Users/me/Applications (Parallels)/{abc} Applications.localized/Lark.app",
              "/Applications/Lark.app",
              "/Applications/Lark.app",
              "/Applications/notes.txt",
            ].join("\n"),
          };
        }
        return {};
      });
      const driver = await bootWith(exec);
      await driver.openApp("飞书");
      expect(log.at(-1)).toEqual({ file: "/usr/bin/open", args: ["/Applications/Lark.app"] });
    });

    it("只有下载目录 / 桌面 / 挂载的安装包里的副本：不打开（可能是没装的安装包或来路不明的拷贝），报找不到", async () => {
      const { exec, log } = scripted((c) => {
        if (c.args[0] === "-a") return NOT_FOUND("微信");
        if (c.file === "/usr/bin/mdfind") {
          return { out: "/Users/me/Downloads/WeChat.app\n/Users/me/Desktop/WeChat.app\n/Volumes/WeChat Installer/WeChat.app\n/private/tmp/WeChat.app\n/Users/me/WeChat.app" };
        }
        return {};
      });
      const driver = await bootWith(exec);
      await expect(driver.openApp("微信")).rejects.toThrow(/打不开应用「微信」/);
      expect(log.filter((c) => c.file === "/usr/bin/open" && c.args[0] !== "-a")).toEqual([]);
    });

    it("同名的多个副本按目录优先级挑：/Applications → 系统自带 → CoreServices → 用户的 ~/Applications", async () => {
      const mk = (paths: string[]) =>
        scripted((c) => {
          if (c.args[0] === "-a") return NOT_FOUND("访达");
          if (c.file === "/usr/bin/mdfind") return { out: paths.join("\n") };
          return {};
        });
      const all = mk(["/Users/me/Applications/X.app", "/System/Library/CoreServices/X.app", "/System/Applications/X.app", "/Applications/X.app"]);
      await (await bootWith(all.exec)).openApp("访达");
      expect(all.log.at(-1)!.args).toEqual(["/Applications/X.app"]);

      const noApplications = mk(["/Users/me/Applications/X.app", "/System/Library/CoreServices/X.app", "/System/Applications/X.app"]);
      await (await bootWith(noApplications.exec)).openApp("访达");
      expect(noApplications.log.at(-1)!.args).toEqual(["/System/Applications/X.app"]);

      const core = mk(["/Users/me/Applications/X.app", "/System/Library/CoreServices/Finder.app"]);
      await (await bootWith(core.exec)).openApp("访达");
      expect(core.log.at(-1)!.args).toEqual(["/System/Library/CoreServices/Finder.app"]);

      const userOnly = mk(["/Users/me/Applications/X.app"]);
      await (await bootWith(userOnly.exec)).openApp("访达");
      expect(userOnly.log.at(-1)!.args).toEqual(["/Users/me/Applications/X.app"]);
    });

    it("同一个目录里有多个同名应用：不替用户选，列出候选让模型换成完整路径，一个都不打开", async () => {
      const { exec, log } = scripted((c) => {
        if (c.args[0] === "-a") return NOT_FOUND("计算器");
        if (c.file === "/usr/bin/mdfind") return { out: "/Applications/Calc A.app\n/Applications/Calc B.app\n" };
        return {};
      });
      const driver = await bootWith(exec);
      await expect(driver.openApp("计算器")).rejects.toThrow(/有多个叫「计算器」的应用：\/Applications\/Calc A\.app、\/Applications\/Calc B\.app.*完整路径/);
      expect(log.filter((c) => c.file === "/usr/bin/open" && c.args[0] !== "-a")).toEqual([]);
    });

    it("候选很多时报错里只列前 5 个（不把一长串路径塞给模型）", async () => {
      const many = Array.from({ length: 7 }, (_, i) => `/Applications/App ${i + 1}.app`);
      const { exec } = scripted((c) => {
        if (c.args[0] === "-a") return NOT_FOUND("同名");
        if (c.file === "/usr/bin/mdfind") return { out: many.join("\n") };
        return {};
      });
      const driver = await bootWith(exec);
      const err = (await driver.openApp("同名").catch((e: unknown) => e)) as Error;
      expect(err.message).toContain("/Applications/App 5.app");
      expect(err.message).not.toContain("/Applications/App 6.app");
    });

    it("按显示名也搜不到：报原来的错（带 open 的 stderr），搜过一次", async () => {
      const { exec, log } = scripted((c) => (c.args[0] === "-a" ? NOT_FOUND("Nope") : { out: "" }));
      const driver = await bootWith(exec);
      await expect(driver.openApp("Nope")).rejects.toThrow(/打不开应用「Nope」：Unable to find application named 'Nope'/);
      expect(log.filter((c) => c.file === "/usr/bin/mdfind")).toHaveLength(1);
    });

    it("名字里有会进 Spotlight 查询语法的字符（引号 / 反斜杠 / 通配符 / 控制字符）或太长：不去搜，直接报原来的错", async () => {
      for (const bad of ['a"b', "a\\b", "a*b", "a\nb", "a\u0001b", "a\u001fb", "a\u0000b", "x".repeat(101)]) {
        const { exec, log } = scripted((c) => (c.args[0] === "-a" ? NOT_FOUND("x") : { out: "/Applications/Evil.app" }));
        const driver = await bootWith(exec);
        await expect(driver.openApp(bad), JSON.stringify(bad)).rejects.toThrow(/打不开应用/);
        expect(log.filter((c) => c.file === "/usr/bin/mdfind"), JSON.stringify(bad)).toEqual([]);
      }
    });

    it("恰好 100 个字符的名字照常去搜", async () => {
      const name = "x".repeat(100);
      const { exec, log } = scripted((c) => (c.args[0] === "-a" ? NOT_FOUND(name) : { out: "" }));
      const driver = await bootWith(exec);
      await expect(driver.openApp(name)).rejects.toThrow();
      expect(log.filter((c) => c.file === "/usr/bin/mdfind")).toHaveLength(1);
    });

    it("`open -a` 超时（被杀）：不再去搜（总时长会超），直接报错", async () => {
      for (const kill of [{ killed: true }, { signal: "SIGTERM" }, { killed: true, signal: "SIGTERM" }]) {
        const { exec, log } = scripted(() => ({ fail: Object.assign(new Error("timed out"), kill) }));
        const driver = await bootWith(exec);
        await expect(driver.openApp("微信"), JSON.stringify(kill)).rejects.toThrow(/打不开应用「微信」/);
        expect(log.map((c) => c.file), JSON.stringify(kill)).toEqual(["/usr/bin/open"]);
      }
    });

    it("每条子进程命令都带超时（Spotlight / open 卡住不能把工具卡死），Spotlight 输出有上限", async () => {
      const { exec } = scripted((c) => {
        if (c.args[0] === "-a") return NOT_FOUND("微信");
        if (c.file === "/usr/bin/mdfind") return { out: "/Applications/WeChat.app" };
        return {};
      });
      const driver = await bootWith(exec);
      await driver.openApp("微信");
      await driver.openApp("/Applications/Safari.app");
      const calls = exec.mock.calls as unknown as Array<[string, string[], { timeout?: number; maxBuffer?: number }]>;
      expect(calls.map(([file, args]) => `${file.split("/").pop()} ${args.length}`)).toEqual(["open 2", "mdfind 1", "open 1", "open 1"]);
      for (const [file, , opts] of calls) {
        expect(opts.timeout, file).toBeGreaterThan(0);
        expect(opts.timeout, file).toBeLessThanOrEqual(15000);
      }
      expect(calls[1]![2].maxBuffer).toBeGreaterThan(0);
    });

    it("Spotlight 本身出错（mdfind 失败 / 不存在）：当作没搜到，报原来的错，不抛别的", async () => {
      const { exec } = scripted((c) => (c.file === "/usr/bin/mdfind" ? { fail: new Error("mdfind: command not found") } : NOT_FOUND("微信")));
      const driver = await bootWith(exec);
      await expect(driver.openApp("微信")).rejects.toThrow(/打不开应用「微信」：Unable to find application named '微信'/);
    });

    it("找到了路径但打不开：报错里用用户给的名字，并带上 open 的 stderr", async () => {
      const { exec } = scripted((c) => {
        if (c.file === "/usr/bin/mdfind") return { out: "/Applications/WeChat.app" };
        if (c.args[0] === "-a") return NOT_FOUND("微信");
        return { fail: true, err: "The application cannot be opened for an unexpected reason" };
      });
      const driver = await bootWith(exec);
      await expect(driver.openApp("微信")).rejects.toThrow(/打不开应用「微信」：The application cannot be opened/);
    });

    it("绝对路径只能是应用（.app，末尾斜杠 / 大小写不限）：别的文件 / 应用包里面的可执行文件不打开，也不执行任何命令", async () => {
      for (const bad of ["/Users/me/run.command", "/etc/passwd", "/Applications/Safari.app/Contents/MacOS/Safari", "/Applications/Safari.app.zip", "/Applications/Safariapp", "/"]) {
        const { exec, log } = scripted(() => ({}));
        const driver = await bootWith(exec);
        await expect(driver.openApp(bad), bad).rejects.toThrow(/只能打开应用/);
        expect(log, bad).toEqual([]);
      }
      const ok = scripted(() => ({}));
      const driver = await bootWith(ok.exec);
      await driver.openApp("/Applications/Safari.app/");
      await driver.openApp("/Applications/Safari.APP");
      expect(ok.log.map((c) => c.args[0])).toEqual(["/Applications/Safari.app/", "/Applications/Safari.APP"]);
    });

    // 第三轮评审：以前任何位置的 .app 都能被一条绝对路径跑起来（下载目录里刚解压的、临时目录里刚放进去的……）
    it("绝对路径只认「应用程序」文件夹里的顶层应用（/Applications、/System/Applications、/System/Library/CoreServices、~/Applications）：别处的 .app、应用包里面的辅助程序、用 .. 绕出去的都拒绝，不执行任何命令", async () => {
      const bad = [
        "/Users/me/Downloads/Evil.app",
        "/Users/me/Desktop/Evil.app/",
        "/private/tmp/Evil.app",
        "/tmp/Evil.app",
        "/Volumes/Installer/Evil.app",
        "/Users/me/Evil.app", // ~/Applications 之外的家目录
        "/Users/other/Applications/Evil.app", // 别的用户的 Applications
        "/Applications/Lark.app/Contents/Frameworks/Lark Helper.app", // 应用包里面的辅助程序
        "/Applications/../tmp/Evil.app", // 词法上以 /Applications 开头、规范化后在别处
        "/Applications/Safari.app/../../Users/me/Downloads/Evil.app",
        "/applications/Safari.app", // 白名单是精确目录（大小写也要对）
        "//tmp/Evil.app",
      ];
      for (const target of bad) {
        const { exec, log } = scripted(() => ({}));
        const driver = await bootWith(exec);
        await expect(driver.openApp(target), target).rejects.toThrow(/只能打开「应用程序」文件夹里的应用/);
        expect(log, target).toEqual([]);
      }
    });

    it("白名单目录里的应用（含子文件夹）照常按路径打开；路径先规范化，交给 open 的就是规范化后的那一条（验证的和执行的是同一个字符串）", async () => {
      const cases: Array<[string, string]> = [
        ["/Applications/Safari.app", "/Applications/Safari.app"],
        ["/Applications/Utilities/Terminal.app", "/Applications/Utilities/Terminal.app"],
        ["/System/Applications/Calculator.app/", "/System/Applications/Calculator.app/"],
        ["/System/Library/CoreServices/Finder.app", "/System/Library/CoreServices/Finder.app"],
        ["/Users/me/Applications/Mine.app", "/Users/me/Applications/Mine.app"],
        ["/Applications//Safari.app", "/Applications/Safari.app"], // 重复斜杠
        ["/Applications/./Safari.app", "/Applications/Safari.app"], // ./
        ["/Applications/x/../Safari.app", "/Applications/Safari.app"], // 规范化后仍在白名单里：打开的是规范化后的，系统不会再经 x 的符号链接绕出去
      ];
      for (const [input, expected] of cases) {
        const { exec, log } = scripted(() => ({}));
        const driver = await bootWith(exec);
        await driver.openApp(input);
        expect(log, input).toEqual([{ file: "/usr/bin/open", args: [expected] }]);
      }
    });

    it("按路径打开失败：报错带路径和 stderr，不会再去按显示名搜", async () => {
      const { exec, log } = scripted(() => ({ fail: true, err: "The file /Applications/Nope.app does not exist." }));
      const driver = await bootWith(exec);
      await expect(driver.openApp("/Applications/Nope.app")).rejects.toThrow(/打不开应用「\/Applications\/Nope\.app」：The file/);
      expect(log.filter((c) => c.file === "/usr/bin/mdfind")).toEqual([]);
    });

    it("~/Applications 取自注入的 homeDir（不写死用户名）", async () => {
      const { exec, log } = scripted((c) => {
        if (c.args[0] === "-a") return NOT_FOUND("我的应用");
        if (c.file === "/usr/bin/mdfind") return { out: "/Users/alice/Applications/Mine.app\n/Users/bob/Applications/Mine.app" };
        return {};
      });
      const driver = await bootWith(exec, { homeDir: "/Users/alice" });
      await driver.openApp("我的应用");
      expect(log.at(-1)!.args).toEqual(["/Users/alice/Applications/Mine.app"]);
    });
  });

  it("listApps：解析 JXA 输出；输出不是 JSON 时给中文错误", async () => {
    const fake = makeFake();
    const apps = [{ name: "访达", pid: 1, frontmost: true, windows: [] }];
    const okExec = vi.fn((_f: string, _a: string[], _o: unknown, cb: (e: Error | null, out: string, err: string) => void) => {
      cb(null, `${JSON.stringify(apps)}\n`, "");
      return { unref() {} };
    });
    const d1 = createDarwinDriver({ koffi: fake.koffi, platform: "darwin", execFile: okExec as never });
    await d1.init();
    await expect(d1.listApps()).resolves.toEqual(apps);

    const badExec = vi.fn((_f: string, _a: string[], _o: unknown, cb: (e: Error | null, out: string, err: string) => void) => {
      cb(null, "not json", "");
      return { unref() {} };
    });
    const d2 = createDarwinDriver({ koffi: makeFake().koffi, platform: "darwin", execFile: badExec as never });
    await d2.init();
    await expect(d2.listApps()).rejects.toThrow(/读取应用列表失败/);
  });
});
