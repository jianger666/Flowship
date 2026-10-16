/**
 * K3-08：启动时清掉崩溃遗留的 config.json 原子写临时文件。
 *
 * 背景：writePrivateFileAtomic 先写 `<目标>.tmp.<pid>.<rand>` 再 rename；进程在两步之间崩溃时临时文件会一直留在数据目录里，
 * 内容是明文 API key / PAT，而脱敏源（event-secret-redact）与诊断导出都不覆盖它。
 *
 * 全部走真实文件系统（临时数据目录），凭据全是假值；断言只看文件是否还在、不打印文件内容。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { writePrivateFileAtomic } from "@/lib/server/data-root";
import {
  STALE_SETTINGS_TMP_MIN_AGE_MS,
  cleanupStaleSettingsTmpFiles,
  hardenConfigFilePerms,
} from "@/lib/server/settings-fs";

const MIN = 60 * 1000;
const FAKE_SECRET = "sk-FAKE-TMP-CLEANUP-SENTINEL-0001";

let root: string;
let savedDataDir: string | undefined;

const p = (name: string): string => path.join(root, name);
const exists = (target: string): Promise<boolean> =>
  fs.lstat(target).then(
    () => true,
    () => false,
  );
const write = async (name: string, ageMs: number, content = FAKE_SECRET): Promise<void> => {
  await fs.writeFile(p(name), content, { encoding: "utf-8", mode: 0o600 });
  const t = new Date(Date.now() - ageMs);
  await fs.utimes(p(name), t, t);
};

// writePrivateFileAtomic 产出的真实形态：`<目标>.tmp.<pid>.<随机段>`
const TMP_NAMES = [
  "config.json.tmp.4242.k3j9x0a1b2c",
  "config.json.bak.tmp.4242.zz81q0w9e8r",
  "config.json.bak.shrink.tmp.4242.m5n6b7v8c9x",
] as const;

beforeEach(async () => {
  savedDataDir = process.env.FLOWSHIP_DATA_DIR;
  root = await fs.mkdtemp(path.join(os.tmpdir(), "flowship-tmp-cleanup-"));
  process.env.FLOWSHIP_DATA_DIR = root;
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (savedDataDir === undefined) delete process.env.FLOWSHIP_DATA_DIR;
  else process.env.FLOWSHIP_DATA_DIR = savedDataDir;
  await fs.rm(root, { recursive: true, force: true });
});

describe("cleanupStaleSettingsTmpFiles", () => {
  it("超过阈值的三种 tmp（config.json / .bak / .bak.shrink 各一）全部删掉，返回删除个数", async () => {
    for (const name of TMP_NAMES) await write(name, 11 * MIN);
    expect(await cleanupStaleSettingsTmpFiles()).toBe(3);
    for (const name of TMP_NAMES) expect(await exists(p(name)), name).toBe(false);
  });

  it("阈值默认 10 分钟：9 分钟的（可能是正在进行的原子写）不动，11 分钟的才删", async () => {
    expect(STALE_SETTINGS_TMP_MIN_AGE_MS).toBe(10 * MIN);
    await write(TMP_NAMES[0], 9 * MIN);
    await write(TMP_NAMES[1], 11 * MIN);
    await write(TMP_NAMES[2], 0);
    expect(await cleanupStaleSettingsTmpFiles()).toBe(1);
    expect(await exists(p(TMP_NAMES[0]))).toBe(true);
    expect(await exists(p(TMP_NAMES[1]))).toBe(false);
    expect(await exists(p(TMP_NAMES[2]))).toBe(true);
  });

  it("可注入 now / minAgeMs：只按 mtime 与阈值比较", async () => {
    await write(TMP_NAMES[0], 5 * MIN);
    expect(await cleanupStaleSettingsTmpFiles({ minAgeMs: 10 * MIN })).toBe(0);
    expect(await cleanupStaleSettingsTmpFiles({ now: Date.now() + 6 * MIN, minAgeMs: 10 * MIN })).toBe(1);
    expect(await exists(p(TMP_NAMES[0]))).toBe(false);
  });

  it("config.json / .bak / .bak.shrink / .corrupt-* 本身即使很旧也绝不动（它们是备份，不是临时文件）", async () => {
    const keep = [
      "config.json",
      "config.json.bak",
      "config.json.bak.shrink",
      "config.json.corrupt-1760000000000",
    ];
    for (const name of keep) await write(name, 24 * 60 * MIN);
    expect(await cleanupStaleSettingsTmpFiles()).toBe(0);
    for (const name of keep) expect(await exists(p(name)), name).toBe(true);
  });

  it("名字只差一点的不动：别的文件的 tmp、corrupt 的 tmp、没有 tmp 段的、前缀不对的", async () => {
    const keep = [
      // company-env.json 的原子写临时文件（writeCompanyEnvFile → writePrivateFileAtomic，形态与 config.json 的完全一样）。
      // ⚠ 这里钉的是「本函数的作用域只限 config.json 家族」（K3-08 只针对这一族），**不是**「它不含凭据」：
      // 崩溃遗留的 company-env.json.tmp.* 里同样是明文的服务器 / PG / Redis 等密码，目前没有任何地方清它（残余缺口，见 settings-fs.ts 注释）
      "company-env.json.tmp.4242.abc",
      "config.json.corrupt-1760000000000.tmp.4242.abc",
      "config.json.tmp", // 没有 `.tmp.` 后缀段
      "xconfig.json.tmp.4242.abc",
      "config.json.bak.old.tmp.4242.abc",
      "config.json.tmpfile",
    ];
    for (const name of keep) await write(name, 24 * 60 * MIN);
    expect(await cleanupStaleSettingsTmpFiles()).toBe(0);
    for (const name of keep) expect(await exists(p(name)), name).toBe(true);
  });

  it("只清数据目录顶层：子目录里的同名文件不动", async () => {
    await fs.mkdir(p("tasks"), { recursive: true });
    const nested = path.join("tasks", TMP_NAMES[0]);
    await fs.writeFile(p(nested), FAKE_SECRET, "utf-8");
    const old = new Date(Date.now() - 24 * 60 * MIN);
    await fs.utimes(p(nested), old, old);
    await write(TMP_NAMES[1], 11 * MIN);
    expect(await cleanupStaleSettingsTmpFiles()).toBe(1);
    expect(await exists(p(nested))).toBe(true);
  });

  it.skipIf(process.platform === "win32")("只删普通文件：同名目录不动；同名软链不跟随、软链本身与指向的目标都不动", async () => {
    // 同名目录（里面放个文件，删目录会连带删掉）
    await fs.mkdir(p(TMP_NAMES[0]));
    await fs.writeFile(path.join(p(TMP_NAMES[0]), "inner.txt"), "x", "utf-8");
    const old = new Date(Date.now() - 24 * 60 * MIN);
    await fs.utimes(p(TMP_NAMES[0]), old, old);

    // 数据目录之外的一个旧文件，被软链指着
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "flowship-tmp-cleanup-out-"));
    try {
      const target = path.join(outsideDir, "precious.txt");
      await fs.writeFile(target, "precious", "utf-8");
      await fs.utimes(target, old, old);
      await fs.symlink(target, p(TMP_NAMES[1]));
      // 软链自身的 mtime 也设成很旧：若实现用 stat（跟随）或只看名字，这里就会被当成「旧的普通文件」误删
      await fs.lutimes(p(TMP_NAMES[1]), old, old);

      expect(await cleanupStaleSettingsTmpFiles()).toBe(0);
      expect(await exists(path.join(p(TMP_NAMES[0]), "inner.txt"))).toBe(true);
      expect((await fs.lstat(p(TMP_NAMES[1]))).isSymbolicLink()).toBe(true);
      expect(await fs.readFile(target, "utf-8")).toBe("precious");
    } finally {
      await fs.rm(outsideDir, { recursive: true, force: true });
    }
  });

  it("幂等：连跑两次，第二次什么都不删、不抛", async () => {
    for (const name of TMP_NAMES) await write(name, 11 * MIN);
    expect(await cleanupStaleSettingsTmpFiles()).toBe(3);
    expect(await cleanupStaleSettingsTmpFiles()).toBe(0);
  });

  it("数据目录不存在 → 静默返回 0（不抛）", async () => {
    process.env.FLOWSHIP_DATA_DIR = path.join(root, "does-not-exist");
    await expect(cleanupStaleSettingsTmpFiles()).resolves.toBe(0);
  });

  it("某个文件删不掉（权限 / 占用）→ 只 warn 文件名、不抛，其余照常清；日志不含文件内容", async () => {
    for (const name of TMP_NAMES) await write(name, 11 * MIN);
    const realUnlink = fs.unlink.bind(fs);
    vi.spyOn(fs, "unlink").mockImplementation(async (target) => {
      if (String(target).endsWith(TMP_NAMES[2])) {
        throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
      }
      return realUnlink(target);
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await expect(cleanupStaleSettingsTmpFiles()).resolves.toBe(2);
    expect(await exists(p(TMP_NAMES[0]))).toBe(false);
    expect(await exists(p(TMP_NAMES[1]))).toBe(false);
    expect(await exists(p(TMP_NAMES[2]))).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify([...warn.mock.calls, ...log.mock.calls]);
    expect(logged.includes(TMP_NAMES[2])).toBe(true);
    expect(logged.includes(FAKE_SECRET)).toBe(false);
  });

  it("列目录失败（数据目录位置是个文件）→ warn、不抛", async () => {
    const asFile = p("not-a-dir");
    await fs.writeFile(asFile, "x", "utf-8");
    process.env.FLOWSHIP_DATA_DIR = asFile;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(cleanupStaleSettingsTmpFiles()).resolves.toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("启动入口 hardenConfigFilePerms 会顺带清遗留 tmp（instrumentation-node 启动时调的就是它）", () => {
  it("旧 tmp 被清、新 tmp 与 config.json 不动；config.json 仍被收紧为 0600", async () => {
    await write("config.json", 24 * 60 * MIN, JSON.stringify({ apiKey: FAKE_SECRET }));
    await fs.chmod(p("config.json"), 0o644);
    await write(TMP_NAMES[0], 11 * MIN);
    await write(TMP_NAMES[1], 1 * MIN);

    await hardenConfigFilePerms();

    expect(await exists(p(TMP_NAMES[0]))).toBe(false);
    expect(await exists(p(TMP_NAMES[1]))).toBe(true);
    expect(await exists(p("config.json"))).toBe(true);
    if (process.platform !== "win32") {
      expect((await fs.stat(p("config.json"))).mode & 0o777).toBe(0o600);
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────────────────────────
// 第八轮 L1-02：清理（删除）口径 ≠ 读拦截口径。
//
// pi-coding-tools 的读拦截 CONFIG_FILE_FAMILY_RE 对 tmp 用的是 `\.tmp\..+`——宁可多拦，这是对的；
// 但清理拿同一个宽口径去**删**，就会把用户手工留在数据目录里的 `config.json.tmp.my-copy` 这类文件一起删掉
// （审查方实证：该文件与 `config.json.tmp.12345.abc9x` 一起被删、返回 2）。
// 删除只认 writePrivateFileAtomic 的真实形态 `<目标>.tmp.<数字 pid>.<小写字母数字随机段>`。
// ──────────────────────────────────────────────────────────────────────────────────────────────
describe("第八轮 L1-02：清理只删 writePrivateFileAtomic 的真实形态，手工文件即使名字像 tmp 也保留", () => {
  // 读拦截（宽口径）会挡住它们，但它们不是原子写的产物——绝不能删
  const HAND_MADE = [
    "config.json.tmp.my-copy", // 审查方实证用的
    "config.json.tmp.old",
    "config.json.bak.tmp.my-copy",
    "config.json.bak.shrink.tmp.backup-2025",
    "config.json.tmp.12345", // 只有 pid、没有随机段
    // 随机段是小写（Math.random().toString(36)）。⚠ 别和下面「真实形态」用同一个随机串只差大小写：
    // macOS 默认文件系统不区分大小写，两个名字会是同一个文件
    "config.json.tmp.12345.ZZ1QX",
    "config.json.tmp.12345.abc9x.old", // 真实形态后面又跟了后缀
    "config.json.tmp.12345.abc-9x", // 随机段里不会有连字符
    "config.json.tmp.pid.abc9x", // pid 必须是数字
    "config.json.tmp.12345.abc9x.bak",
  ] as const;

  it("手工文件（24 小时前）全部保留；同目录里真实形态（config.json.tmp.12345.abc9x）照删，返回值只数真实的那一个", async () => {
    for (const name of HAND_MADE) await write(name, 24 * 60 * MIN);
    await write("config.json.tmp.12345.abc9x", 24 * 60 * MIN);
    expect(await cleanupStaleSettingsTmpFiles()).toBe(1);
    for (const name of HAND_MADE) expect(await exists(p(name)), name).toBe(true);
    expect(await exists(p("config.json.tmp.12345.abc9x"))).toBe(false);
  });

  it("三个目标（config.json / .bak / .bak.shrink）下的手工文件同样保留，真实形态各删一个", async () => {
    const real = [
      "config.json.tmp.12345.abc9x",
      "config.json.bak.tmp.12345.abc9x",
      "config.json.bak.shrink.tmp.12345.abc9x",
    ];
    const manual = [
      "config.json.tmp.my-copy",
      "config.json.bak.tmp.my-copy",
      "config.json.bak.shrink.tmp.my-copy",
    ];
    for (const name of [...real, ...manual]) await write(name, 24 * 60 * MIN);
    expect(await cleanupStaleSettingsTmpFiles()).toBe(3);
    for (const name of real) expect(await exists(p(name)), name).toBe(false);
    for (const name of manual) expect(await exists(p(name)), name).toBe(true);
  });

  it("走真实函数：writePrivateFileAtomic 对三个目标各写 20 次，rename 前的 tmp 文件名（真函数产出、非手写）全部被清理命中", async () => {
    const produced = new Set<string>();
    const realRename = fs.rename.bind(fs);
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      produced.add(path.basename(String(from)));
      return realRename(from, to);
    });
    for (const target of ["config.json", "config.json.bak", "config.json.bak.shrink"]) {
      for (let i = 0; i < 20; i++) await writePrivateFileAtomic(p(target), "{}");
    }
    vi.restoreAllMocks();
    // 每次写的随机段不同；成功的写不会留 tmp，这里按真函数产出的名字重放成「崩溃遗留」
    expect(produced.size).toBe(60);
    for (const name of produced) {
      expect(name).toMatch(/^config\.json(?:\.bak(?:\.shrink)?)?\.tmp\./);
      await write(name, 11 * MIN);
    }
    expect(await cleanupStaleSettingsTmpFiles()).toBe(60);
    for (const name of produced) expect(await exists(p(name)), name).toBe(false);
  });

  it("随机段的字符集 / 长度边界（Math.random 取 0.5 / 2^-53 / 1-2^-53 / 1e-7）：真函数产出的 tmp 名仍被命中", async () => {
    const produced: string[] = [];
    const realRename = fs.rename.bind(fs);
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      produced.push(path.basename(String(from)));
      return realRename(from, to);
    });
    const edges = [0.5, 2 ** -53, 1 - 2 ** -53, 1e-7];
    for (const v of edges) {
      vi.spyOn(Math, "random").mockReturnValue(v);
      await writePrivateFileAtomic(p("config.json"), "{}");
      vi.mocked(Math.random).mockRestore();
    }
    vi.restoreAllMocks();
    expect(produced).toHaveLength(edges.length);
    for (const name of produced) await write(name, 11 * MIN);
    expect(await cleanupStaleSettingsTmpFiles()).toBe(edges.length);
    for (const name of produced) expect(await exists(p(name)), name).toBe(false);
  });
});
