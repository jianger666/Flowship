/**
 * K3-07（潜伏，第七轮 review，实证）：`isBypassBlockedReadPath` 是纯词法判断，数据目录 / 文件名大小写变了就返回 false。
 *
 * 机制：旁路读守卫拦的是「数据目录根里的 config.json 及其备份族」+「任意位置的 company-env.json」，原先两侧都是逐字比较。
 * macOS（APFS 默认）/ Windows（NTFS 默认）的文件系统大小写不敏感：`<数据目录>/CONFIG.JSON` 与 `config.json` 是同一个文件，
 * 词法比较却认不出（数据目录目录名的大小写变体同理）；另外硬链接 / 符号链接换个名字也是同一个文件。
 * 当前没有调用方传 readOnly: true，所以是潜伏的；趁没人接线先补。
 *
 * 已拍板的修法（本测试钉住）：
 *   1. darwin / win32：词法比较两侧做 casefold（仅这两个平台；linux 保持大小写敏感）；
 *   2. 对**已存在**的路径再补 dev+ino 比对：stat 后与受保护文件同设备同 inode 即认作同一文件
 *      （覆盖硬链接 / 符号链接 / 大小写不敏感文件系统上的变体，且不依赖平台的词法规则）；
 *   3. stat 失败（不存在 / ENOTDIR / 名字过长 / 非法字符）安静回退到词法判断，绝不抛。
 *
 * 测试方式：平台用 `isBypassBlockedReadPath(path, platform)` 的第二个参数注入（默认 process.platform）；
 * 「纯词法」的用例放进一个空的 ghost 数据目录（里面没有任何文件），这样 stat 一定失败、dev+ino 帮不上忙，
 * 断言的就只是词法 casefold 本身；「dev+ino」的用例则注入 linux（不 casefold），断言的就只是 inode 比对本身。
 * 全程假凭据值 + 临时目录，不读任何真实文件。
 *
 * 刻意未覆盖 / 已知残余：
 *   - Windows 8.3 短名（`CONFIG~1.JSO`）、尾部点 / 空格、`::$DATA`：词法上认不出，已存在的文件会被 dev+ino 兜住，不存在的无从谈起；没在 Windows 上实测；
 *   - `.corrupt-<ts>` / `.tmp.*` 的**硬链接**不在 inode 比对范围（它们没有固定文件名、要 readdir 才能枚举，不值得放进每次工具调用的路径）；
 *     它们的大小写变体由词法 casefold 覆盖；
 *   - 设置保存是「写临时文件 → rename 覆盖」，config.json 的 inode 每次保存都变：保存之前做的硬链接指向旧 inode，与当前文件不再是同一个，认不出（旧版本里的凭据也是凭据，但那种链接得有人先在工作区里造出来）；
 *   - Unicode 规范化（NFC / NFD）变体不处理：APFS 保留规范化但比较时不敏感，已存在的文件由 dev+ino 兜住。
 */
import { existsSync, mkdtempSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-blocked-casefold-"));
const DATA = path.join(TMP_ROOT, "data");
const GHOST = path.join(TMP_ROOT, "ghost-data"); // 空数据目录：没有任何凭据文件
const CWD = path.join(TMP_ROOT, "work");
process.env.FLOWSHIP_DATA_DIR = DATA;

await fs.mkdir(DATA, { recursive: true });
await fs.mkdir(GHOST, { recursive: true });
await fs.mkdir(path.join(CWD, "sub"), { recursive: true });
for (const name of ["config.json", "config.json.bak", "config.json.bak.shrink", "company-env.json"]) {
  await fs.writeFile(path.join(DATA, name), JSON.stringify({ fake: `not-a-real-secret-${name}` }));
}
await fs.writeFile(path.join(DATA, "other.txt"), "unrelated\n");
await fs.writeFile(path.join(CWD, "hello.txt"), "hello\n");

const { isBypassBlockedReadPath, checkBypassRead, validateReadonlyShellCommand } = await import(
  "@/lib/server/pi-coding-tools"
);

/** 临时把数据目录指到 dir 跑 fn（FLOWSHIP_DATA_DIR 每次调用现读） */
const withDataDir = <T>(dir: string, fn: () => T): T => {
  const prev = process.env.FLOWSHIP_DATA_DIR;
  process.env.FLOWSHIP_DATA_DIR = dir;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.FLOWSHIP_DATA_DIR;
    else process.env.FLOWSHIP_DATA_DIR = prev;
  }
};

/** 文件系统本身是否大小写不敏感（macOS APFS / Windows NTFS 默认是；Linux ext4 不是） */
const FS_CASE_INSENSITIVE = existsSync(path.join(DATA, "CONFIG.JSON"));

/** 数据目录根里 config.json 族的大小写变体（全部不存在于 ghost 目录里） */
const FAMILY_VARIANTS = [
  "CONFIG.JSON",
  "Config.Json",
  "config.json.BAK",
  "CONFIG.JSON.Bak.Shrink",
  "Config.Json.Corrupt-1789000000000",
  "config.json.TMP.4242.AbCdEf",
  "CONFIG.JSON.BAK.SHRINK.TMP.4242.ABCDEF",
  "CONFIG.json.bak.tmp.1.x",
];

describe.each(["darwin", "win32"] as const)("A · 词法 casefold（平台 = %s）：大小写变体被拦", (platform) => {
  it("数据目录根里 config.json 族的文件名大小写变体", () => {
    withDataDir(GHOST, () => {
      for (const name of FAMILY_VARIANTS) {
        expect(isBypassBlockedReadPath(path.join(GHOST, name), platform), name).toBe(true);
      }
    });
  });

  it("数据目录自己的大小写变体（FLOWSHIP_DATA_DIR 与调用方拼出的目录大小写不同）", () => {
    withDataDir(GHOST, () => {
      const upper = GHOST.toUpperCase();
      expect(upper).not.toBe(GHOST); // 防测试空转：临时目录名里确有字母
      expect(isBypassBlockedReadPath(path.join(upper, "config.json"), platform)).toBe(true);
      expect(isBypassBlockedReadPath(path.join(upper, "CONFIG.JSON.BAK.SHRINK"), platform)).toBe(true);
      expect(isBypassBlockedReadPath(path.join(upper, "config.json.corrupt-123"), platform)).toBe(true);
    });
  });

  it("company-env.json 任意位置同名即拦，大小写变体同样拦", () => {
    withDataDir(GHOST, () => {
      for (const name of ["Company-Env.JSON", "COMPANY-ENV.JSON", "company-ENV.json"]) {
        expect(isBypassBlockedReadPath(path.join(CWD, name), platform), name).toBe(true);
      }
    });
  });

  it("不误伤：名字相近但不是这一族的、工作区里的同名文件、无关文件", () => {
    withDataDir(GHOST, () => {
      for (const name of ["CONFIG.JSON.TXT", "config.jsonx", "CONFIG.JSON.SHRINK", "CONFIG.JSON.TMPX", "Other.TXT"]) {
        expect(isBypassBlockedReadPath(path.join(GHOST, name), platform), name).toBe(false);
      }
      // 工作区里的 config.json（任意大小写）不在数据目录根，不连坐
      expect(isBypassBlockedReadPath(path.join(CWD, "CONFIG.JSON"), platform)).toBe(false);
      expect(isBypassBlockedReadPath(path.join(CWD, "hello.txt"), platform)).toBe(false);
      // 数据目录的子目录里的 config.json 不是「数据目录根」
      expect(isBypassBlockedReadPath(path.join(GHOST, "tasks", "CONFIG.JSON"), platform)).toBe(false);
    });
  });
});

describe("A2 · linux 保持大小写敏感（casefold 仅 darwin / win32）", () => {
  it("小写原名照拦、大小写变体不拦（ghost 目录里没有文件，纯词法）", () => {
    withDataDir(GHOST, () => {
      expect(isBypassBlockedReadPath(path.join(GHOST, "config.json"), "linux")).toBe(true);
      expect(isBypassBlockedReadPath(path.join(GHOST, "config.json.bak.shrink"), "linux")).toBe(true);
      expect(isBypassBlockedReadPath(path.join(CWD, "company-env.json"), "linux")).toBe(true);
      for (const name of FAMILY_VARIANTS) {
        expect(isBypassBlockedReadPath(path.join(GHOST, name), "linux"), name).toBe(false);
      }
      expect(isBypassBlockedReadPath(path.join(CWD, "Company-Env.JSON"), "linux")).toBe(false);
      expect(isBypassBlockedReadPath(path.join(GHOST.toUpperCase(), "config.json"), "linux")).toBe(false);
    });
  });
});

describe.skipIf(process.platform !== "darwin")("A3 · darwin 真实验证（不注入平台）", () => {
  it("真实数据目录里的大小写变体（文件名 / 目录名 / 备份族）都被拦", () => {
    expect(isBypassBlockedReadPath(path.join(DATA, "CONFIG.JSON"))).toBe(true);
    expect(isBypassBlockedReadPath(path.join(DATA, "Config.Json.BAK"))).toBe(true);
    expect(isBypassBlockedReadPath(path.join(DATA, "config.json.BAK.SHRINK"))).toBe(true);
    expect(isBypassBlockedReadPath(path.join(DATA, "config.json.CORRUPT-1789000000000"))).toBe(true);
    expect(isBypassBlockedReadPath(path.join(DATA, "CONFIG.JSON.tmp.4242.abc"))).toBe(true);
    expect(isBypassBlockedReadPath(path.join(DATA.toUpperCase(), "config.json"))).toBe(true);
    expect(isBypassBlockedReadPath(path.join(DATA, "COMPANY-ENV.JSON"))).toBe(true);
  });

  it("工具层：旁路 read 读大小写变体被拒（拒绝原因是「凭据文件」，不是目录钳制的「越界」）", () => {
    const reason = checkBypassRead(CWD, "t1")({ path: path.join(DATA, "CONFIG.JSON") });
    expect(reason ?? "").toContain("凭据文件");
  });
});

describe("B · dev+ino：同一个文件换个名字也认得（注入 linux，排除词法 casefold 的帮助）", () => {
  it("硬链接：config.json / .bak / .bak.shrink / company-env.json", async () => {
    for (const name of ["config.json", "config.json.bak", "config.json.bak.shrink", "company-env.json"]) {
      const link = path.join(CWD, `hl-${name}.txt`);
      await fs.link(path.join(DATA, name), link);
      expect(isBypassBlockedReadPath(link, "linux"), `${name} 的硬链接`).toBe(true);
      expect(isBypassBlockedReadPath(link), `${name} 的硬链接（默认平台）`).toBe(true);
    }
  });

  it.skipIf(process.platform === "win32")("符号链接（stat 跟随链接）", async () => {
    const link = path.join(CWD, "sym-config.txt");
    await fs.symlink(path.join(DATA, "config.json"), link);
    expect(isBypassBlockedReadPath(link, "linux")).toBe(true);
  });

  it.skipIf(!FS_CASE_INSENSITIVE)("大小写不敏感文件系统上的变体（platform=linux 不做词法 casefold，只靠 inode 认出）", () => {
    expect(isBypassBlockedReadPath(path.join(DATA, "CONFIG.JSON"), "linux")).toBe(true);
    expect(isBypassBlockedReadPath(path.join(DATA, "Config.Json.Bak"), "linux")).toBe(true);
    expect(isBypassBlockedReadPath(path.join(DATA.toUpperCase(), "config.json"), "linux")).toBe(true);
  });

  it("不误伤：内容相同但 inode 不同的拷贝、无关文件、目录、数据目录里的无关文件", async () => {
    await fs.copyFile(path.join(DATA, "config.json"), path.join(CWD, "copy-of-config.txt"));
    expect(isBypassBlockedReadPath(path.join(CWD, "copy-of-config.txt"), "linux")).toBe(false);
    expect(isBypassBlockedReadPath(path.join(CWD, "hello.txt"), "linux")).toBe(false);
    expect(isBypassBlockedReadPath(path.join(CWD, "sub"), "linux")).toBe(false);
    expect(isBypassBlockedReadPath(DATA, "linux")).toBe(false);
    expect(isBypassBlockedReadPath(path.join(DATA, "other.txt"), "linux")).toBe(false);
    expect(isBypassBlockedReadPath(path.join(DATA, "other.txt"))).toBe(false);
  });

  it("工具层：旁路 read / shell cat 读到数据目录文件的硬链接被拒", async () => {
    const link = path.join(CWD, "innocent-notes.txt");
    await fs.link(path.join(DATA, "config.json"), link);
    // 链接在工作区里，目录钳制放行；拦它的只能是「凭据文件」判定
    expect(checkBypassRead(CWD, "t1")({ path: link }) ?? "").toContain("凭据文件");
    const verdict = validateReadonlyShellCommand(CWD, "cat innocent-notes.txt", undefined, undefined);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason ?? "").toContain("凭据文件");
    // 对照：工作区里的普通文件照常放行
    expect(validateReadonlyShellCommand(CWD, "cat hello.txt", undefined, undefined).ok).toBe(true);
  });
});

describe("C · stat 失败安静回退到词法判断（不抛）", () => {
  it("不存在 / ENOTDIR / 名字过长 / 含 NUL：返回 false，不抛", () => {
    const cases: string[] = [
      path.join(CWD, "no-such-file.txt"),
      path.join(DATA, "config.json", "x"), // config.json 是文件，下面没有东西：ENOTDIR
      path.join(CWD, "x".repeat(6000)), // ENAMETOOLONG
      path.join(CWD, "bad\0name"), // ERR_INVALID_ARG_VALUE
    ];
    for (const p of cases) {
      expect(() => isBypassBlockedReadPath(p, "linux"), p.slice(0, 40)).not.toThrow();
      expect(isBypassBlockedReadPath(p, "linux"), p.slice(0, 40)).toBe(false);
      expect(() => isBypassBlockedReadPath(p), p.slice(0, 40)).not.toThrow();
    }
  });

  it("词法命中不依赖 stat：不存在的 config.json 族路径照拦", () => {
    withDataDir(GHOST, () => {
      expect(isBypassBlockedReadPath(path.join(GHOST, "config.json.corrupt-1"), "linux")).toBe(true);
      expect(isBypassBlockedReadPath(path.join(GHOST, "config.json.bak"), "darwin")).toBe(true);
    });
  });
});
