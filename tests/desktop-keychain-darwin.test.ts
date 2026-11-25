/**
 * macOS 钥匙串凭据存储（electron-app/desktop/credentials/darwin-keychain.mjs）——假 koffi + 内存里的「系统」，语义对齐真实 API（macOS 27.2 实测）。
 *
 * 开机密码放在 Flowship 自己的专用钥匙串文件里，而不是登录钥匙串：登录钥匙串的条目带一份「分区列表」，
 * 自签证书下写的是创建者那一版的代码哈希，每次升级 / 重新打包都读不出来；专用钥匙串里的条目只认「创建者的签名身份」，
 * 同一张证书签的任何一版都读得出。这里钉死的是：
 * - 升级 / 重新打包（签名身份不变）后读得出；换了签名身份读不出，但「重新保存」是可靠的一步修复（删了重建 → 绑给新身份）
 * - 往返正确（含中文密码、中文条目名 —— 长度参数必须是 UTF-8 字节数）
 * - 专用钥匙串文件：位置 / 权限、口令来自本机硬件标识（拷到别的电脑打不开 → 提示重新保存，不卡死）、被锁了照样能用、
 *   文件损坏 / 旧条目删不掉都「整个删掉重建」，不让用户卡在「保存不了、清除不了」
 * - 旧存法（登录钥匙串）留下的同名条目在保存 / 清除时顺手清掉，清不掉也不影响结果
 * - 读 / 写期间临时关闭钥匙串 UI 交互，结束（含出错）一定恢复原值：否则 ACL 不匹配时会弹窗把主进程同步卡死
 * - 原生内存及时释放：密码缓冲 free、钥匙串 / 条目引用 release，出错路径也不泄漏；传给原生的字节缓冲用完清零
 * - 密码不进日志 / 错误信息；非 macOS / 加载失败：整体不可用且不抛，原因可读
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDarwinKeychain } from "../electron-app/desktop/credentials/darwin-keychain.mjs";

const SERVICE = "Flowship 电脑操作（解锁密码）";
const ACCOUNT = "Flowship";
const ERR_NOT_FOUND = -25300;
const ERR_INTERACTION = -25308;
const ERR_AUTH_FAILED = -25293;

const protoName = (proto: string): string => /([A-Za-z0-9_]+)\s*\(/.exec(proto)![1];

type Item = { data: Buffer; owner: string };
type KeychainFile = { passphrase: string; items: Map<string, Item>; unlocked: boolean };
/** 「系统」：专用钥匙串文件（按路径）+ 登录钥匙串里的条目。多个假 koffi（代表不同的 App 版本 / 签名身份）共享同一个世界 */
type World = { files: Map<string, KeychainFile>; login: Map<string, Item> };
const makeWorld = (): World => ({ files: new Map(), login: new Map() });

type Ref = { kind: "keychain"; path: string } | { kind: "item"; store: Map<string, Item>; key: string; dedicated: boolean };

type FakeOpts = {
  /** 这个假 koffi 代表哪个签名身份（证书 + bundle id；同一身份下的不同版本不区分——实测都读得出）。读条目数据时条目不是这个身份创建的 → -25293 */
  identity?: string;
  interactionPrev?: boolean;
  loadThrows?: boolean;
  /** 读专用钥匙串条目数据时强制返回的状态码 */
  readStatus?: number;
  /** 删专用钥匙串里的条目时返回的状态码（默认成功，不真删） */
  deleteStatus?: number;
  /** SecKeychainDelete（整个钥匙串）返回的状态码：非 0 = 没删（文件留着） */
  deleteKeychainStatus?: number;
  /** SecKeychainCreate 返回的状态码（非 0 = 建不出来） */
  createStatus?: number;
  /** 成功新建 N 条之后，再新建一律失败 */
  failAddsAfter?: number;
  /** 登录钥匙串（旧存法）里删条目返回的状态码 */
  loginDeleteStatus?: number;
  /** 查登录钥匙串时抛异常 */
  loginFindThrows?: boolean;
  /** 在专用钥匙串里「只查条目在不在」时强制返回的状态码 */
  itemLookupStatus?: number;
  /** SecKeychainOpen 返回的状态码（非 0 = 打不开，且没有引用） */
  openStatus?: number;
  /** 往专用钥匙串新建条目时抛异常；"echo" = 异常文字把传进来的密码回显出来（真实原生层 / koffi 的参数报错完全可能这么做） */
  addThrows?: boolean | "echo";
  /** SecKeychainDelete（整个钥匙串）抛异常 */
  deleteKeychainThrows?: boolean;
  /** 读专用钥匙串条目数据时抛异常 */
  readThrows?: boolean;
};

const makeFake = (opts: FakeOpts = {}, world: World = makeWorld()) => {
  const identity = opts.identity ?? "cert-A";
  let addsDone = 0;
  let seq = 1000;
  let interaction = opts.interactionPrev ?? true;
  const refs = new Map<number, Ref>();
  const mem = new Map<number, Buffer>();
  const log = {
    interactionDuringCalls: [] as boolean[],
    interactionSets: [] as boolean[],
    /** 所有创建出来、必须 release 的引用（钥匙串引用 + 条目引用） */
    created: [] as number[],
    released: [] as number[],
    freed: [] as number[],
    adds: 0,
    itemDeletes: 0,
    loginDeletes: 0,
    keychainCreates: 0,
    keychainDeletes: 0,
    unlocks: 0,
    unlockUsedPassword: [] as boolean[],
    /** 传给原生的所有字节缓冲（密码 / 钥匙串口令） */
    byteArgs: [] as Buffer[],
    /** 建 / 解锁钥匙串时传进来的口令（调用当时的文本） */
    passphrases: [] as string[],
    /** get 解码出来的密码缓冲（读完应被清零） */
    decoded: [] as Uint8Array[],
    /** 建钥匙串时的 promptUser 参数（必须是 false：否则系统会弹窗问口令） */
    createPrompt: [] as unknown[],
    /** 假原生层抛出的异常文字（对照组：证明「回显密码」的毒化真的发生过，「不含密码」的断言才不是恒真） */
    thrown: [] as string[],
  };
  const newRef = (r: Ref): number => {
    seq += 1;
    refs.set(seq, r);
    log.created.push(seq);
    return seq;
  };
  const keyOf = (sl: number, service: string, al: number, account: string) => {
    if (sl !== Buffer.byteLength(service, "utf8") || al !== Buffer.byteLength(account, "utf8")) throw new Error("长度参数不是 UTF-8 字节数");
    return `${service}\u0000${account}`;
  };
  const keychainOf = (kcRef: unknown) => {
    const r = refs.get(kcRef as number);
    if (!r || r.kind !== "keychain") throw new Error("不是钥匙串引用");
    return { path: r.path, file: world.files.get(r.path) };
  };
  /** 取一段「指针 + 长度」传进来的字节：长度参数必须恰好等于缓冲长度（传错会多读 / 少读） */
  const text = (pw: unknown, pl: unknown) => {
    if (pl !== (pw as Buffer).length) throw new Error(`长度参数 ${String(pl)} 与缓冲长度 ${(pw as Buffer).length} 不一致`);
    return Buffer.from(pw as Buffer).toString("utf8");
  };

  const impl: Record<string, (...a: unknown[]) => unknown> = {
    SecKeychainCreate: (p, pl, pw, promptUser, _initialAccess, out) => {
      log.keychainCreates += 1;
      log.createPrompt.push(promptUser);
      log.byteArgs.push(pw as Buffer);
      log.passphrases.push(text(pw, pl));
      if (opts.createStatus !== undefined) return opts.createStatus;
      // 实测：同一路径磁盘上已有文件（哪怕是乱码）→ -25296（重复）；文件被绕过系统删掉后能直接重建（系统不记旧账）
      if (fs.existsSync(p as string)) return -25296;
      fs.writeFileSync(p as string, "fake-keychain-file");
      world.files.set(p as string, { passphrase: text(pw, pl), items: new Map(), unlocked: true });
      (out as unknown[])[0] = newRef({ kind: "keychain", path: p as string });
      return 0;
    },
    SecKeychainOpen: (p, out) => {
      if (opts.openStatus !== undefined) return opts.openStatus;
      // 实测：打开是惰性的，乱码文件也能「打开」，到解锁才失败
      (out as unknown[])[0] = newRef({ kind: "keychain", path: p as string });
      return 0;
    },
    SecKeychainUnlock: (kc, pl, pw, usePassword) => {
      log.unlocks += 1;
      log.byteArgs.push(pw as Buffer);
      log.passphrases.push(text(pw, pl));
      log.unlockUsedPassword.push(usePassword as boolean);
      const { file } = keychainOf(kc);
      if (!file) return -25295; // 磁盘上有文件、但不是有效钥匙串（实测 -25295）
      if (text(pw, pl) !== file.passphrase) return ERR_AUTH_FAILED; // 口令不对（实测：即使已是解锁状态，错口令也返回 -25293）
      file.unlocked = true;
      return 0;
    },
    SecKeychainDelete: (kc) => {
      log.keychainDeletes += 1;
      if (opts.deleteKeychainThrows) throw new Error("删钥匙串炸了");
      if (opts.deleteKeychainStatus !== undefined) return opts.deleteKeychainStatus;
      const { path: p } = keychainOf(kc);
      world.files.delete(p);
      fs.rmSync(p, { force: true });
      return 0;
    },
    SecKeychainAddGenericPassword: (kc, sl, service, al, account, pl, pw, out) => {
      log.interactionDuringCalls.push(interaction);
      const key = keyOf(sl as number, service as string, al as number, account as string);
      log.adds += 1;
      log.byteArgs.push(pw as Buffer);
      if (opts.addThrows) {
        const msg = opts.addThrows === "echo" ? `原生层崩了：参数 ${text(pw, pl)} 类型不对` : "原生层崩了";
        log.thrown.push(msg);
        throw new Error(msg);
      }
      const { file } = keychainOf(kc);
      if (!file || !file.unlocked) return ERR_AUTH_FAILED; // 锁着的钥匙串在不许弹窗时读写都是 -25293
      if (file.items.has(key)) return -25299;
      if (opts.failAddsAfter !== undefined && addsDone >= opts.failAddsAfter) return -25295;
      addsDone += 1;
      file.items.set(key, { data: Buffer.from(text(pw, pl), "utf8"), owner: identity });
      (out as unknown[])[0] = newRef({ kind: "item", store: file.items, key, dedicated: true });
      return 0;
    },
    SecKeychainFindGenericPassword: (kc, sl, service, al, account, pl, pw, out) => {
      log.interactionDuringCalls.push(interaction);
      const key = keyOf(sl as number, service as string, al as number, account as string);
      if (kc === null) {
        // 默认搜索列表 = 登录钥匙串（旧存法放的地方）
        if (opts.loginFindThrows) throw new Error("登录钥匙串查询炸了");
        if (!world.login.has(key)) return ERR_NOT_FOUND;
        (out as unknown[])[0] = newRef({ kind: "item", store: world.login, key, dedicated: false });
        return 0;
      }
      const { file } = keychainOf(kc);
      if (!file || !file.unlocked) return ERR_AUTH_FAILED;
      const item = file.items.get(key);
      if (!item) return ERR_NOT_FOUND;
      if (pl === null && opts.itemLookupStatus !== undefined) return opts.itemLookupStatus;
      if (pl !== null) {
        // 取密码数据受访问控制限制：条目不是这个签名身份创建的 → -25293（实测）；同一身份换了一版照样读得出
        if (opts.readThrows) throw new Error("读条目炸了");
        if (opts.readStatus !== undefined) return opts.readStatus;
        if (item.owner !== identity) return ERR_AUTH_FAILED;
      }
      (out as unknown[])[0] = newRef({ kind: "item", store: file.items, key, dedicated: true });
      if (pl !== null) {
        (pl as number[])[0] = item.data.length;
        seq += 1;
        mem.set(seq, Buffer.from(item.data));
        (pw as unknown[])[0] = seq;
      }
      return 0;
    },
    SecKeychainItemDelete: (item) => {
      const r = refs.get(item as number) as Extract<Ref, { kind: "item" }>;
      if (r.dedicated) {
        log.itemDeletes += 1;
        if (opts.deleteStatus !== undefined) return opts.deleteStatus;
      } else {
        log.loginDeletes += 1;
        if (opts.loginDeleteStatus !== undefined) return opts.loginDeleteStatus;
      }
      r.store.delete(r.key);
      return 0;
    },
    SecKeychainItemFreeContent: (_attr, ptr) => {
      log.freed.push(ptr as number);
      mem.delete(ptr as number);
      return 0;
    },
    SecKeychainSetUserInteractionAllowed: (state) => {
      interaction = state as boolean;
      log.interactionSets.push(interaction);
      return 0;
    },
    SecKeychainGetUserInteractionAllowed: (out) => {
      (out as boolean[])[0] = interaction;
      return 0;
    },
    CFRelease: (obj) => {
      log.released.push(obj as number);
    },
  };

  const koffi = {
    load: vi.fn(() => {
      if (opts.loadThrows) throw new Error("Security.framework 加载失败");
      return {
        func: (proto: string) => {
          const name = protoName(proto);
          const f = impl[name];
          if (!f) throw new Error(`假 koffi 没有实现 ${name}`);
          return (...args: unknown[]) => f(...args);
        },
      };
    }),
    decode: (ptr: number, _type: string, n: number) => {
      if (n !== mem.get(ptr)!.length) throw new Error(`解码长度 ${n} 与实际密码长度 ${mem.get(ptr)!.length} 不一致`);
      const raw = new Uint8Array(mem.get(ptr)!);
      log.decoded.push(raw);
      return raw;
    },
  };
  return { koffi, log, getInteraction: () => interaction };
};

let dir = "";
const kcPath = () => path.join(dir, "desktop-keychain", "unlock.keychain-db");
const itemKey = `${SERVICE}\u0000${ACCOUNT}`;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fs-desktop-kc-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

type MakeOpts = {
  fake?: FakeOpts;
  world?: World;
  /** 钥匙串文件位置（缺省 kcPath()） */
  path?: string;
  /** 不注入硬件标识，走默认实现（真的去读 IOPlatformUUID；只在 macOS 上用） */
  realMachineId?: boolean;
  machineId?: string | (() => string);
  fsOverride?: Partial<typeof fs>;
  sink?: string[];
};
const make = (o: MakeOpts = {}) => {
  const world = o.world ?? makeWorld();
  const fake = makeFake(o.fake, world);
  const kc = createDarwinKeychain({
    service: SERVICE,
    account: ACCOUNT,
    path: o.path ?? kcPath(),
    koffi: fake.koffi,
    platform: "darwin",
    ...(o.realMachineId ? {} : { machineId: typeof o.machineId === "function" ? o.machineId : () => o.machineId ?? "MACHINE-1" }),
    fs: o.fsOverride ? ({ ...fs, ...o.fsOverride } as typeof fs) : undefined,
    log: (m: string) => o.sink?.push(m),
  });
  return { world, fake, kc };
};

describe("往返", () => {
  it("保存 → 已保存 → 读回一致（含中文 / 符号），条目名含中文也行（长度按 UTF-8 字节）", () => {
    const { kc } = make();
    expect(kc.has()).toBe(false);
    expect(kc.get()).toBeNull();
    expect(kc.set("密码abc!@#")).toEqual({ ok: true });
    expect(kc.has()).toBe(true);
    expect(kc.get()).toBe("密码abc!@#");
  });

  it("已有条目：删掉重建（不是原地更新）——新条目绑给现在这个签名身份", () => {
    const { fake, kc } = make();
    kc.set("old-secret");
    kc.set("new-secret");
    expect(fake.log.adds).toBe(2);
    expect(fake.log.itemDeletes).toBe(1);
    expect(kc.get()).toBe("new-secret");
  });

  it("删除：读不到、专用钥匙串文件也一起删掉（不留空壳）；本来就没有也算成功", () => {
    const { kc } = make();
    kc.set("x-secret");
    expect(fs.existsSync(kcPath())).toBe(true);
    expect(kc.remove()).toBe(true);
    expect(fs.existsSync(kcPath())).toBe(false);
    expect(kc.has()).toBe(false);
    expect(kc.get()).toBeNull();
    expect(kc.remove()).toBe(true);
  });

  it("删除后再保存：重新建文件，读得出来", () => {
    const { kc } = make();
    kc.set("first-secret");
    kc.remove();
    expect(kc.set("second-secret")).toEqual({ ok: true });
    expect(kc.get()).toBe("second-secret");
  });

  it("参数校验：空密码 / 超过 256 字节都不碰钥匙串，也不建文件", () => {
    const { fake, kc } = make();
    expect(kc.set("")).toMatchObject({ ok: false });
    expect(kc.set("x".repeat(257))).toMatchObject({ ok: false, error: expect.stringContaining("太长") });
    expect(fake.log.adds + fake.log.keychainCreates).toBe(0);
    expect(fs.existsSync(kcPath())).toBe(false);
  });

  it("密码不是字符串：拒绝，不抛、不碰钥匙串", () => {
    const { fake, kc } = make();
    for (const bad of [undefined, null, 123, {}]) {
      expect(kc.set(bad as never)).toMatchObject({ ok: false, error: "密码不能为空" });
    }
    expect(fake.log.keychainCreates).toBe(0);
  });

  it("恰好 256 字节可以保存", () => {
    const { kc } = make();
    expect(kc.set("x".repeat(256))).toEqual({ ok: true });
    expect(kc.get()).toBe("x".repeat(256));
  });

  it("没保存过（文件都不存在）：has=false 且根本不加载钥匙串组件；get 返回 null，不建文件", () => {
    const { fake, kc } = make();
    expect(kc.has()).toBe(false);
    expect(fake.koffi.load).not.toHaveBeenCalled();
    expect(kc.get()).toBeNull();
    expect(fake.log.keychainCreates).toBe(0);
    expect(fs.existsSync(kcPath())).toBe(false);
  });
});

describe("升级 / 重新打包 / 换签名身份之后（这次修复的核心）", () => {
  const makeApps = () => {
    const world = makeWorld();
    return {
      world,
      // 同一个签名身份（同一张证书 + 同一个 bundle id），换了一版：实测读得出
      v1: make({ world, fake: { identity: "cert-A" } }),
      v2: make({ world, fake: { identity: "cert-A" } }),
      // 换了签名证书
      other: make({ world, fake: { identity: "cert-B" } }),
    };
  };

  it("同一个签名身份换了一版：旧版存的，新版「已保存」为真、读得出来——升级不用重新输入", () => {
    const { v1, v2 } = makeApps();
    expect(v1.kc.set("old-secret")).toEqual({ ok: true });
    expect(v2.kc.has()).toBe(true);
    expect(v2.kc.get()).toBe("old-secret");
  });

  it("换了签名身份：「已保存」不再误报（读不出来就是没保存），读取提示重新保存", () => {
    const { v1, other } = makeApps();
    v1.kc.set("old-secret");
    expect(other.kc.has()).toBe(false);
    expect(() => other.kc.get()).toThrow(/重新保存/);
  });

  it("换了签名身份后「保存」= 删了重建：新身份读得出来，旧身份读不出（不会两边互相抢）", () => {
    const { v1, other } = makeApps();
    v1.kc.set("old-secret");
    expect(other.kc.set("new-secret")).toEqual({ ok: true });
    expect(other.kc.get()).toBe("new-secret");
    expect(other.fake.log.itemDeletes).toBe(1);
    expect(() => v1.kc.get()).toThrow(/重新保存/);
  });

  it("「清除」对别的签名身份存的条目也有效，清除后再保存同样读得出来", () => {
    const { v1, other } = makeApps();
    v1.kc.set("old-secret");
    expect(other.kc.remove()).toBe(true);
    expect(other.kc.has()).toBe(false);
    expect(other.kc.set("new-secret")).toEqual({ ok: true });
    expect(other.kc.get()).toBe("new-secret");
  });
});

describe("专用钥匙串文件", () => {
  it("建在指定位置；文件夹 0700、文件 0600（别的用户读不到）；口令是解锁用的、不弹窗（promptUser 由原生层保证）", () => {
    const { fake, kc } = make();
    kc.set("pw-secret");
    expect(fs.statSync(path.dirname(kcPath())).mode & 0o777).toBe(0o700);
    expect(fs.statSync(kcPath()).mode & 0o777).toBe(0o600);
    expect(fake.log.keychainCreates).toBe(1);
  });

  it("上级文件夹也不存在：一路建出来", () => {
    const deep = path.join(dir, "a", "b", "desktop-keychain", "unlock.keychain-db");
    const { kc } = make({ path: deep });
    expect(kc.set("pw-secret")).toEqual({ ok: true });
    expect(fs.existsSync(deep)).toBe(true);
  });

  it("文件夹已存在但权限太松：收紧到 0700", () => {
    fs.mkdirSync(path.dirname(kcPath()), { recursive: true, mode: 0o755 });
    fs.chmodSync(path.dirname(kcPath()), 0o755);
    const { kc } = make();
    kc.set("pw-secret");
    expect(fs.statSync(path.dirname(kcPath())).mode & 0o777).toBe(0o700);
  });

  it("建钥匙串不许系统弹窗问口令（promptUser=false）", () => {
    const { fake, kc } = make();
    kc.set("pw-secret");
    expect(fake.log.createPrompt).toEqual([false]);
  });

  it("系统删钥匙串时抛异常：不外抛，文件系统兜底照样删掉", () => {
    const world = makeWorld();
    make({ world }).kc.set("old-secret");
    const sink: string[] = [];
    const stuck = make({ world, fake: { deleteStatus: ERR_AUTH_FAILED, deleteKeychainThrows: true }, sink });
    expect(stuck.kc.set("new-secret")).toEqual({ ok: true });
    expect(stuck.kc.get()).toBe("new-secret");
    expect(sink.join("\n")).toContain("删除钥匙串出错");
  });

  it("已有文件：重新打开用口令解锁（usePassword=true），不重复创建", () => {
    const world = makeWorld();
    make({ world }).kc.set("pw-secret");
    const second = make({ world });
    expect(second.kc.get()).toBe("pw-secret");
    expect(second.fake.log.keychainCreates).toBe(0);
    expect(second.fake.log.unlocks).toBeGreaterThan(0);
    expect(second.fake.log.unlockUsedPassword.every((v) => v === true)).toBe(true);
  });

  it("被锁住了（用户锁了钥匙串 / 重启后）：每次都先用口令解锁，照样读得出", () => {
    const world = makeWorld();
    const { kc } = make({ world });
    kc.set("pw-secret");
    for (const f of world.files.values()) f.unlocked = false;
    expect(kc.has()).toBe(true);
    for (const f of world.files.values()) f.unlocked = false;
    expect(kc.get()).toBe("pw-secret");
    for (const f of world.files.values()) f.unlocked = false;
    expect(kc.set("pw-secret-2")).toEqual({ ok: true });
    expect(kc.get()).toBe("pw-secret-2");
  });

  it("口令的派生方式固定（改了它 = 所有人已存的密码全打不开）：sha256(盐 + 换行 + 硬件标识) 的十六进制", () => {
    const { fake, kc } = make({ machineId: "MACHINE-1" });
    kc.set("pw-secret");
    kc.get();
    const expected = createHash("sha256").update("flowship.computer-use.keychain.v1\nMACHINE-1").digest("hex");
    expect(expected).toHaveLength(64);
    expect(fake.log.passphrases.length).toBeGreaterThanOrEqual(2);
    expect(new Set(fake.log.passphrases)).toEqual(new Set([expected]));
  });

  it.runIf(process.platform === "darwin")("默认的硬件标识 = 本机 IOPlatformUUID（原样）", () => {
    const out = execFileSync("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], { encoding: "utf8" });
    const uuid = /"IOPlatformUUID"\s*=\s*"([0-9A-Fa-f-]{36})"/.exec(out)![1];
    const { fake, kc } = make({ realMachineId: true });
    expect(kc.set("pw-secret")).toEqual({ ok: true });
    const expected = createHash("sha256").update(`flowship.computer-use.keychain.v1\n${uuid}`).digest("hex");
    expect(new Set(fake.log.passphrases)).toEqual(new Set([expected]));
  });

  it("硬件标识只读一次（读它要起子进程），之后都用缓存的口令", () => {
    const machineId = vi.fn(() => "MACHINE-1");
    const { kc } = make({ machineId });
    kc.set("pw-secret");
    kc.has();
    kc.get();
    kc.remove();
    expect(machineId).toHaveBeenCalledTimes(1);
  });

  it("口令来自本机硬件标识：同一台电脑的不同进程打得开；不同标识（数据拷到别的电脑）打不开", () => {
    const world = makeWorld();
    make({ world, machineId: "MACHINE-1" }).kc.set("pw-secret");
    expect(make({ world, machineId: "MACHINE-1" }).kc.get()).toBe("pw-secret");
    const elsewhere = make({ world, machineId: "MACHINE-2" });
    expect(elsewhere.kc.has()).toBe(false);
    expect(() => elsewhere.kc.get()).toThrow(/打不开.*重新保存|重新保存/);
  });

  it("打不开的日志只在状态变化时记一次（设置页会反复查状态）；恢复后再失败会重新记", () => {
    const world = makeWorld();
    const sink: string[] = [];
    const { kc } = make({ world, sink });
    kc.set("pw-secret");
    const count = () => sink.filter((m) => m.includes("解锁失败")).length;
    const original = world.files.get(kcPath())!;
    const mismatched = { ...original, passphrase: "someone-else" }; // 口令对不上 = 数据来自别的电脑

    world.files.set(kcPath(), mismatched);
    kc.has();
    kc.has();
    expect(() => kc.get()).toThrow();
    expect(count()).toBe(1);

    world.files.set(kcPath(), original); // 恢复
    expect(kc.has()).toBe(true);
    expect(count()).toBe(1);

    world.files.set(kcPath(), mismatched); // 再坏一次要重新记
    kc.has();
    expect(count()).toBe(2);
  });

  it("数据拷到别的电脑后「保存」：旧文件删掉重建，能保存、读得出，不卡在「打不开」", () => {
    const world = makeWorld();
    make({ world, machineId: "MACHINE-1" }).kc.set("pw-secret");
    const elsewhere = make({ world, machineId: "MACHINE-2" });
    expect(elsewhere.kc.set("new-secret")).toEqual({ ok: true });
    expect(elsewhere.kc.get()).toBe("new-secret");
    expect(elsewhere.fake.log.keychainDeletes).toBe(1);
    expect(elsewhere.fake.log.keychainCreates).toBe(1);
  });

  it("文件损坏（不是有效钥匙串）：has=false；get 提示重新保存；保存时删掉残骸重建；清除能清掉", () => {
    fs.mkdirSync(path.dirname(kcPath()), { recursive: true });
    fs.writeFileSync(kcPath(), "garbage");
    const a = make();
    expect(a.kc.has()).toBe(false);
    expect(() => a.kc.get()).toThrow(/打不开/);

    const b = make();
    expect(b.kc.set("pw-secret")).toEqual({ ok: true });
    expect(b.kc.get()).toBe("pw-secret");

    fs.rmSync(kcPath(), { force: true });
    fs.mkdirSync(path.dirname(kcPath()), { recursive: true });
    fs.writeFileSync(kcPath(), "garbage");
    const c = make();
    expect(c.kc.remove()).toBe(true);
    expect(fs.existsSync(kcPath())).toBe(false);
  });

  it("旧条目删不掉（返回错误码）：专用钥匙串里只有这一条，整个删掉重建，保存照样成功", () => {
    const world = makeWorld();
    make({ world }).kc.set("old-secret");
    const stuck = make({ world, fake: { deleteStatus: ERR_AUTH_FAILED } });
    expect(stuck.kc.set("new-secret")).toEqual({ ok: true });
    expect(stuck.kc.get()).toBe("new-secret");
    expect(stuck.fake.log.keychainDeletes).toBe(1);
    expect(stuck.fake.log.keychainCreates).toBe(1);
  });

  it("旧条目删不掉、整个文件也删不掉：如实失败，说清楚要手动删哪个文件夹；不假装成功", () => {
    const world = makeWorld();
    make({ world }).kc.set("old-secret");
    const stuck = make({
      world,
      fake: { deleteStatus: ERR_AUTH_FAILED, deleteKeychainStatus: -1 },
      fsOverride: {
        rmSync: () => {
          throw new Error("EPERM");
        },
      },
    });
    const r = stuck.kc.set("new-secret");
    expect(r).toMatchObject({ ok: false });
    expect((r as { error: string }).error).toContain(path.dirname(kcPath()));
    expect(stuck.fake.log.adds).toBe(0); // 旧条目还在，没有新建（不会出现两条）
    expect(world.files.get(kcPath())?.items.size).toBe(1);
  });

  it("打不开又删不掉：如实失败并说明手动删哪个文件夹", () => {
    fs.mkdirSync(path.dirname(kcPath()), { recursive: true });
    fs.writeFileSync(kcPath(), "garbage");
    const stuck = make({
      fake: { deleteKeychainStatus: -1 },
      fsOverride: {
        rmSync: () => {
          throw new Error("EPERM");
        },
      },
    });
    const r = stuck.kc.set("pw-secret");
    expect(r).toMatchObject({ ok: false });
    expect((r as { error: string }).error).toContain(path.dirname(kcPath()));
  });

  it("清除：专用钥匙串文件删不掉 → 返回 false（别让用户以为已经清掉了）", () => {
    const { kc } = make({
      fake: { deleteKeychainStatus: -1 },
      fsOverride: {
        rmSync: () => {
          throw new Error("EPERM");
        },
      },
    });
    kc.set("pw-secret");
    expect(kc.remove()).toBe(false);
  });

  it("清除：文件系统的删除「没报错却没删掉」→ 也返回 false（以文件是否还在为准）", () => {
    const { kc } = make({
      fake: { deleteKeychainStatus: -1 },
      fsOverride: { rmSync: () => undefined },
    });
    kc.set("pw-secret");
    expect(kc.remove()).toBe(false);
    expect(fs.existsSync(kcPath())).toBe(true);
  });

  it("API 删钥匙串没生效、但文件系统能删：照样清掉", () => {
    const { kc } = make({ fake: { deleteKeychainStatus: -1 } });
    kc.set("pw-secret");
    expect(kc.remove()).toBe(true);
    expect(fs.existsSync(kcPath())).toBe(false);
  });

  it("读不到本机硬件标识：has=false；get / set 给出可读的原因，不抛到外面", () => {
    const { kc } = make({
      machineId: () => {
        throw new Error("ioreg 不可用");
      },
    });
    fs.mkdirSync(path.dirname(kcPath()), { recursive: true });
    fs.writeFileSync(kcPath(), "garbage");
    expect(kc.has()).toBe(false);
    expect(() => kc.get()).toThrow(/硬件标识/);
    expect(kc.set("pw-secret")).toMatchObject({ ok: false, error: expect.stringContaining("硬件标识") });
  });

  it("硬件标识为空串 / 不是字符串也算读不到", () => {
    for (const bad of ["", 12345, null, undefined]) {
      const { kc } = make({ machineId: (() => bad) as unknown as () => string });
      expect(kc.set("pw-secret")).toMatchObject({ ok: false, error: expect.stringContaining("硬件标识") });
    }
  });

  it("系统说打不开（SecKeychainOpen 失败）：当作打不开处理，保存时删掉残骸重建", () => {
    fs.mkdirSync(path.dirname(kcPath()), { recursive: true });
    fs.writeFileSync(kcPath(), "garbage");
    const world = makeWorld();
    const { fake, kc } = make({ world, fake: { openStatus: -25295 } });
    expect(kc.has()).toBe(false);
    expect(() => kc.get()).toThrow(/打不开/);
    expect(kc.set("pw-secret")).toEqual({ ok: true });
    expect(world.files.has(kcPath())).toBe(true); // 重新建了
    expect(fake.log.keychainCreates).toBe(1);
  });

  it("查旧条目时系统报错（不是「没有」）：保存如实失败，翻成中文，什么都不新建", () => {
    const world = makeWorld();
    make({ world }).kc.set("old-secret");
    const { fake, kc } = make({ world, fake: { itemLookupStatus: ERR_INTERACTION } });
    const r = kc.set("new-secret");
    expect(r).toMatchObject({ ok: false });
    expect((r as { error: string }).error).toContain("需要你本人授权");
    expect((r as { error: string }).error).toContain("重新保存开机密码");
    expect(fake.log.adds).toBe(0);
    expect(fake.log.itemDeletes).toBe(0);
  });

  it("原生层抛异常：保存返回通用错误，不抛、不把异常原文（可能带内部信息）透给界面", () => {
    const sink: string[] = [];
    const { kc } = make({ fake: { addThrows: true }, sink });
    const r = kc.set("top-secret-123");
    expect(r).toEqual({ ok: false, error: "保存到钥匙串时出错" });
    expect(sink.join("\n")).toContain("保存出错：原生层崩了"); // 不含密码的异常文字原样记日志（没有多余的「•••」）
    expect(sink.join("\n")).not.toContain("•••");
  });

  // 第二轮评审：原来这条用固定文案的异常断言「日志不含密码」——假原生层本来就没把密码放进异常，断言恒真。
  // 真实的原生层 / koffi 的参数类型报错完全可能回显入参，这里让假原生层回显密码，逼着钥匙串层自己抹。
  it("原生层抛的异常回显了密码：日志里没有整串密码（抹成「•••」）；返回给调用方的仍是通用错误", () => {
    const sink: string[] = [];
    const { fake, kc } = make({ fake: { addThrows: "echo" }, sink });
    const r = kc.set("top-secret-123");
    expect(r).toEqual({ ok: false, error: "保存到钥匙串时出错" });
    // 对照组：毒化真的发生了（异常文字里有整串密码），而且密码确实送进了原生层
    expect(fake.log.thrown).toHaveLength(1);
    expect(fake.log.thrown[0]).toContain("top-secret-123");
    // 日志里：记了这次出错、保留了不含密码的部分、密码被抹掉
    const logs = sink.join("\n");
    expect(logs).toContain("保存出错：原生层崩了：参数 ••• 类型不对");
    expect(logs).not.toContain("top-secret-123");
  });

  it("保存流程里别的失败原因（比如建文件夹的异常）回显了密码：返回给调用方的错误文字也抹掉", () => {
    const thrown: string[] = [];
    const { kc } = make({
      fsOverride: {
        mkdirSync: (() => {
          const msg = "EACCES: 没有权限（正在保存 top-secret-123）";
          thrown.push(msg);
          throw new Error(msg);
        }) as typeof fs.mkdirSync,
      },
    });
    const r = kc.set("top-secret-123");
    expect(thrown).toHaveLength(1); // 对照组：回显密码的异常真的抛过
    expect(r).toEqual({ ok: false, error: "没能创建保存开机密码的文件夹：EACCES: 没有权限（正在保存 •••）" });
    expect(JSON.stringify(r)).not.toContain("top-secret-123");
  });

  it("旧条目动不了、整个删掉后重新创建也失败：把系统的原因翻成中文告诉用户", () => {
    const world = makeWorld();
    make({ world }).kc.set("old-secret");
    const { kc } = make({ world, fake: { deleteStatus: ERR_AUTH_FAILED, createStatus: -25299 } });
    expect(kc.set("new-secret")).toEqual({ ok: false, error: "钥匙串返回了错误（代码 -25299）" });
  });

  it("创建文件夹失败：保存如实失败，说明原因", () => {
    const { kc } = make({
      fsOverride: {
        mkdirSync: (() => {
          throw new Error("EACCES: 没有权限");
        }) as typeof fs.mkdirSync,
      },
    });
    const r = kc.set("pw-secret");
    expect(r).toMatchObject({ ok: false });
    expect((r as { error: string }).error).toContain("没能创建保存开机密码的文件夹");
  });

  it("系统建钥匙串失败：保存如实失败，翻成中文；不留半吊子文件", () => {
    const { kc } = make({ fake: { createStatus: -25299 } });
    expect(kc.set("pw-secret")).toEqual({ ok: false, error: "钥匙串返回了错误（代码 -25299）" });
    expect(fs.existsSync(kcPath())).toBe(false);
  });

  it("文件权限没收紧（chmod 失败）不影响保存", () => {
    const { kc } = make({
      fsOverride: {
        chmodSync: ((p: fs.PathLike, mode: fs.Mode) => {
          if (String(p).endsWith(".keychain-db")) throw new Error("EPERM");
          return fs.chmodSync(p, mode);
        }) as typeof fs.chmodSync,
      },
    });
    expect(kc.set("pw-secret")).toEqual({ ok: true });
    expect(kc.get()).toBe("pw-secret");
  });

  it("检查文件是否存在时出错：清除返回 false（不抛）", () => {
    const { kc } = make({
      fsOverride: {
        existsSync: (() => {
          throw new Error("EIO");
        }) as typeof fs.existsSync,
      },
    });
    expect(kc.remove()).toBe(false);
  });

  it("检查文件是否存在时出错：has=false；get / set 如实报错，不抛", () => {
    const { kc } = make({
      fsOverride: {
        existsSync: (() => {
          throw new Error("EIO");
        }) as typeof fs.existsSync,
      },
    });
    expect(kc.has()).toBe(false);
    expect(() => kc.get()).toThrow(/读不了/);
    expect(kc.set("pw-secret")).toMatchObject({ ok: false, error: expect.stringContaining("读不了") });
  });
});

describe("保存时新建失败", () => {
  it("旧条目删掉了、新建却失败 → 错误里说明旧的已经清掉、要再保存一次（不让用户以为旧密码还在）", () => {
    const { kc } = make({ fake: { failAddsAfter: 1 } });
    expect(kc.set("first-secret")).toEqual({ ok: true });
    const r = kc.set("second-secret");
    expect(r).toMatchObject({ ok: false });
    expect((r as { error: string }).error).toContain("已经清掉了");
    expect(kc.has()).toBe(false);
  });

  it("第一次保存（本来没有条目）就新建失败 → 普通错误，不说「已清掉」", () => {
    const { kc } = make({ fake: { failAddsAfter: 0 } });
    const r = kc.set("first-secret");
    expect(r).toMatchObject({ ok: false });
    expect((r as { error: string }).error).not.toContain("已经清掉了");
  });
});

describe("旧存法（登录钥匙串）留下的条目", () => {
  const seedLegacy = (world: World) => world.login.set(itemKey, { data: Buffer.from("legacy-secret"), owner: "old-build" });

  it("保存成功后顺手清掉；清除时也清掉", () => {
    const world = makeWorld();
    seedLegacy(world);
    const a = make({ world });
    expect(a.kc.set("pw-secret")).toEqual({ ok: true });
    expect(world.login.size).toBe(0);
    expect(a.fake.log.loginDeletes).toBe(1);

    seedLegacy(world);
    expect(a.kc.remove()).toBe(true);
    expect(world.login.size).toBe(0);
  });

  it("没有专用钥匙串文件时清除：也清掉登录钥匙串里的旧条目（用户可能一直没保存过新的）", () => {
    const world = makeWorld();
    seedLegacy(world);
    const { kc } = make({ world });
    expect(kc.remove()).toBe(true);
    expect(world.login.size).toBe(0);
  });

  it("旧条目删不掉 / 查询抛异常：不影响保存和清除的结果", () => {
    const world = makeWorld();
    seedLegacy(world);
    const stuck = make({ world, fake: { loginDeleteStatus: ERR_AUTH_FAILED } });
    expect(stuck.kc.set("pw-secret")).toEqual({ ok: true });
    expect(stuck.kc.get()).toBe("pw-secret");
    expect(world.login.size).toBe(1);

    const sink: string[] = [];
    const boom = make({ world, fake: { loginFindThrows: true }, sink });
    expect(boom.kc.set("pw-secret-2")).toEqual({ ok: true });
    expect(boom.kc.remove()).toBe(true);
    expect(sink.join("\n")).toContain("清理旧条目出错");
  });

  it("保存失败时不去动旧条目；has / get 从来不碰登录钥匙串", () => {
    const world = makeWorld();
    seedLegacy(world);
    const { fake, kc } = make({ world, fake: { failAddsAfter: 0 } });
    expect(kc.set("pw-secret")).toMatchObject({ ok: false });
    expect(world.login.size).toBe(1);
    expect(kc.has()).toBe(false);
    expect(kc.get()).toBeNull();
    expect(fake.log.loginDeletes).toBe(0);
  });
});

describe("钥匙串 UI 交互开关", () => {
  it("读 / 写 / 查询期间是关闭的", () => {
    const { fake, kc } = make();
    kc.set("pw-secret");
    kc.has();
    kc.get();
    expect(fake.log.interactionDuringCalls.length).toBeGreaterThan(0);
    expect(fake.log.interactionDuringCalls.every((v) => v === false)).toBe(true);
  });

  it("结束后恢复原值（原来是开 / 原来是关）", () => {
    for (const prev of [true, false]) {
      const { fake, kc } = make({ fake: { interactionPrev: prev } });
      kc.set("pw-secret");
      kc.get();
      kc.has();
      kc.remove();
      expect(fake.getInteraction()).toBe(prev);
    }
  });

  it("读取出错（访问被拒）：照样恢复；错误信息指向「重新保存」；不泄漏原生内存", () => {
    const { fake, kc } = make({ fake: { readStatus: ERR_INTERACTION } });
    kc.set("pw-secret");
    expect(() => kc.get()).toThrow(/重新保存/);
    expect(fake.getInteraction()).toBe(true);
    // 出错时没有取到密码数据，不应调用 free（free 一个空指针会崩）
    expect(fake.log.freed).toEqual([]);
  });

  it("读取被拒：-25293 和 -25308 一样，提示重新保存；别的错误码不乱指路", () => {
    for (const code of [ERR_AUTH_FAILED, ERR_INTERACTION]) {
      const { kc } = make({ fake: { readStatus: code } });
      kc.set("pw-secret");
      expect(() => kc.get()).toThrow(/重新保存一次开机密码/);
    }
    const { kc } = make({ fake: { readStatus: -25299 } });
    kc.set("pw-secret");
    expect(() => kc.get()).toThrow("钥匙串返回了错误（代码 -25299）");
  });

  it("钥匙串本身有问题的错误码（找不到 / 无效 / 没有默认钥匙串）：说是钥匙串文件的问题，不说「签名变了」", () => {
    for (const code of [-25294, -25295, -25307]) {
      const { kc } = make({ fake: { readStatus: code } });
      kc.set("pw-secret");
      expect(() => kc.get()).toThrow(/钥匙串（文件不存在或已损坏）/);
    }
  });

  it("用户取消授权（-128）：如实说被取消", () => {
    const { kc } = make({ fake: { readStatus: -128 } });
    kc.set("pw-secret");
    expect(() => kc.get()).toThrow("钥匙串授权被取消");
  });
});

describe("内存与清理", () => {
  it("读成功：密码缓冲 free 一次；创建出来的钥匙串 / 条目引用全部 release（含替换旧条目、has、remove 的路径）", () => {
    const { fake, kc } = make();
    kc.set("pw-secret");
    kc.set("pw-secret-2"); // 已有条目 → 删掉重建，找到的条目引用也要释放
    kc.get();
    expect(fake.log.freed).toHaveLength(1);
    kc.has(); // has 也会读一次数据（只确认读得出），数据同样要释放
    expect(fake.log.freed).toHaveLength(2);
    kc.remove();
    expect([...fake.log.released].sort()).toEqual([...fake.log.created].sort());
  });

  it("出错路径也不泄漏：损坏文件重建、旧条目删不掉重建、读取被拒", () => {
    fs.mkdirSync(path.dirname(kcPath()), { recursive: true });
    fs.writeFileSync(kcPath(), "garbage");
    const a = make();
    a.kc.has();
    a.kc.set("pw-secret");
    expect([...a.fake.log.released].sort()).toEqual([...a.fake.log.created].sort());

    const world = makeWorld();
    make({ world }).kc.set("old-secret");
    const b = make({ world, fake: { deleteStatus: ERR_AUTH_FAILED } });
    b.kc.set("new-secret");
    expect([...b.fake.log.released].sort()).toEqual([...b.fake.log.created].sort());

    const c = make({ fake: { readStatus: ERR_AUTH_FAILED } });
    c.kc.set("pw-secret");
    expect(() => c.kc.get()).toThrow();
    c.kc.has();
    expect([...c.fake.log.released].sort()).toEqual([...c.fake.log.created].sort());
  });

  it("读出来的密码缓冲（原生内存的拷贝）读完清零", () => {
    const { fake, kc } = make();
    kc.set("pw-secret");
    expect(kc.get()).toBe("pw-secret");
    expect(fake.log.decoded).toHaveLength(1);
    expect(fake.log.decoded[0].every((x) => x === 0)).toBe(true);
  });

  it("旧存法条目清理路径也不泄漏引用", () => {
    const world = makeWorld();
    world.login.set(itemKey, { data: Buffer.from("legacy-secret"), owner: "old-build" });
    const { fake, kc } = make({ world });
    kc.set("pw-secret");
    world.login.set(itemKey, { data: Buffer.from("legacy-secret"), owner: "old-build" });
    kc.remove();
    expect(fake.log.loginDeletes).toBe(2);
    expect([...fake.log.released].sort()).toEqual([...fake.log.created].sort());
  });

  it("传给原生的字节缓冲（密码、钥匙串口令），用完清零", () => {
    const { fake, kc } = make();
    kc.set("pw-secret-1");
    kc.set("pw-secret-2");
    kc.get();
    expect(fake.log.byteArgs.length).toBeGreaterThanOrEqual(3);
    for (const b of fake.log.byteArgs) expect(b.every((x) => x === 0)).toBe(true);
  });

  it("密码不进日志，也不进错误信息", () => {
    const sink: string[] = [];
    const { kc } = make({ fake: { readStatus: ERR_INTERACTION }, sink });
    kc.set("top-secret-123");
    try {
      kc.get();
    } catch (err) {
      sink.push(String((err as Error).message));
    }
    kc.has();
    expect(sink.join("\n")).not.toContain("top-secret-123");
    expect(sink.length).toBeGreaterThan(0);
  });

  it("本来就没有保存（钥匙串在、条目不在）：has 不记「读不出」的日志", () => {
    const sink: string[] = [];
    const { kc } = make({ fake: { failAddsAfter: 0 }, sink });
    kc.set("pw-secret"); // 建出钥匙串文件、但条目没加进去
    expect(kc.has()).toBe(false);
    expect(sink.filter((m) => m.includes("读不出"))).toEqual([]);
  });

  it("读条目时原生层抛异常：has 返回 false 且不抛（记日志）；get 抛出（调用方会如实报错）", () => {
    const sink: string[] = [];
    const { fake, kc } = make({ fake: { readThrows: true }, sink });
    kc.set("pw-secret");
    expect(kc.has()).toBe(false);
    expect(sink.join("\n")).toContain("查询出错");
    expect(() => kc.get()).toThrow("读条目炸了");
    expect(fake.getInteraction()).toBe(true);
  });

  it("「这一版读不出」的日志同一个错误码只记一次（设置页会反复查状态）", () => {
    const sink: string[] = [];
    const { kc } = make({ fake: { readStatus: ERR_AUTH_FAILED }, sink });
    kc.set("pw-secret");
    kc.has();
    kc.has();
    kc.has();
    expect(sink.filter((m) => m.includes("读不出"))).toHaveLength(1);
  });
});

describe("不可用", () => {
  it("非 macOS：不加载任何库；has=false、set 失败、get 抛错、remove=false，都不崩", () => {
    const fake = makeFake();
    const kc = createDarwinKeychain({ service: SERVICE, account: ACCOUNT, path: kcPath(), koffi: fake.koffi, platform: "win32" });
    expect(kc.available()).toBe(false);
    expect(kc.unavailableReason()).toContain("macOS");
    expect(kc.has()).toBe(false);
    expect(kc.set("x-secret")).toMatchObject({ ok: false, error: expect.stringContaining("macOS") });
    expect(() => kc.get()).toThrow("macOS");
    expect(kc.remove()).toBe(false);
    expect(fake.koffi.load).not.toHaveBeenCalled();
  });

  it("库加载失败：不可用，原因可读，不抛；失败结果记住，不会每次操作都重新加载", () => {
    const { fake, kc } = make({ fake: { loadThrows: true } });
    expect(kc.available()).toBe(false);
    expect(kc.unavailableReason()).toContain("Security.framework 加载失败");
    expect(kc.set("x-secret")).toMatchObject({ ok: false, error: expect.stringContaining("Security.framework 加载失败") });
    expect(() => kc.get()).toThrow("Security.framework 加载失败");
    expect(kc.remove()).toBe(false);
    expect(fake.koffi.load).toHaveBeenCalledTimes(1);
  });

  it("没给钥匙串文件位置（空串 / 没传）：不可用，原因可读，不碰任何东西", () => {
    for (const p of ["", undefined]) {
      const fake = makeFake();
      const kc = createDarwinKeychain({ service: SERVICE, account: ACCOUNT, path: p as unknown as string, koffi: fake.koffi, platform: "darwin" });
      expect(kc.available()).toBe(false);
      expect(kc.unavailableReason()).toContain("位置");
      expect(kc.has()).toBe(false);
      expect(kc.set("x-secret")).toMatchObject({ ok: false });
      expect(kc.remove()).toBe(false);
      expect(() => kc.get()).toThrow("位置");
      expect(fake.koffi.load).not.toHaveBeenCalled();
    }
  });
});
