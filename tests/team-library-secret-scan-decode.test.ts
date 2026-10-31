/**
 * 上传前敏感扫描：UTF-16 / 夹着 NUL 的文本不再整个跳过（R14 B7-2 · Q13-04）
 *
 * 症状：`collectStagedTextFilesForScan` 与 `scanSensitiveFiles` 各有一层「含 NUL 就是二进制」的判定。
 * Windows 记事本的「Unicode」、Windows PowerShell 5.x 的 `>` 重定向默认存的是 UTF-16（每个 ASCII 字符后跟一个 NUL；PowerShell 7 起默认 UTF-8）——
 * 里面的明文口令整个文件被跳过、照传；非打印占比还是对**字节**算的，UTF-16 的 NUL 字节会把纯文本也判成二进制。
 *
 * 修法：新增纯函数 `decodeForScan(buf, relPath)`——BOM（UTF-8 / UTF-16LE / UTF-16BE）→ 无 BOM 的 UTF-16 按 NUL 位置特征猜
 * → 其余含 NUL 的按扩展名白名单判二进制、不在表里的去 NUL 后照扫 → 解码后再判非打印占比。
 *
 * 上半：`decodeForScan` 纯函数（含与 `scanSensitiveFiles` 的衔接）。
 * 下半：真走 `uploadSkillsToTeamLibrary`（本地 bare 仓当远端，脚手架见 tests/helpers/team-library-e2e.ts）：
 *       UTF-16 口令文件被拦；对照组（UTF-16 但没有口令 / 真二进制 .png）照常上传；
 *       同样的字节叫 .txt 被拦、叫 .png 照传（钉住「接线时把路径交给 decodeForScan」，见最后一条）。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  syncTeamLibrary,
  uploadSkillsToTeamLibrary,
} from "@/lib/server/team-library";
import {
  decodeForScan,
  scanSensitiveFiles,
} from "@/lib/server/team-library-secret-scan";
import { setupTeamLibraryE2E } from "./helpers/team-library-e2e";

const T = 60_000;

const SECRET_LINE = "password=SuperSecretValue99\r\n";

const utf16le = (s: string, bom = true): Buffer =>
  Buffer.concat([
    bom ? Buffer.from([0xff, 0xfe]) : Buffer.alloc(0),
    Buffer.from(s, "utf16le"),
  ]);
const utf16be = (s: string, bom = true): Buffer =>
  Buffer.concat([
    bom ? Buffer.from([0xfe, 0xff]) : Buffer.alloc(0),
    Buffer.from(Buffer.from(s, "utf16le")).swap16(),
  ]);

/** 文本里夹一个 NUL（NUL 两侧字节位上都不集中——不是 UTF-16） */
const TEXT_WITH_NUL = Buffer.from(
  "password=Super\0SecretValue99\n# note: demo\n",
  "utf-8",
);

/** 确定性的二进制垃圾：NUL 占 1/3、且均匀落在奇偶两侧（不像 UTF-16），其余全是控制字符 */
const BINARY_JUNK = Buffer.from(
  Array.from({ length: 600 }, (_, i) => (i % 3 === 0 ? 0 : 1)),
);

/** PNG 文件头 + 一段确定性的伪随机字节（固定种子的 LCG，每次一样） */
const pngLike = (): Buffer => {
  let x = 12345;
  const noise = Array.from({ length: 256 }, () => {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    return (x >> 16) & 0xff;
  });
  return Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
    0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x06, 0x00, 0x00, 0x00, ...noise,
  ]);
};

describe("decodeForScan：把字节解成要扫的文本", () => {
  it.each([
    ["UTF-16LE + BOM", utf16le(SECRET_LINE)],
    ["UTF-16BE + BOM", utf16be(SECRET_LINE)],
    ["UTF-16LE 无 BOM", utf16le(SECRET_LINE, false)],
    ["UTF-16BE 无 BOM", utf16be(SECRET_LINE, false)],
  ])("%s → 解出原文（改前含 NUL 一律跳过）", (_name, buf) => {
    expect(buf.includes(0)).toBe(true);
    expect(decodeForScan(buf, "notes.txt")).toBe(SECRET_LINE);
  });

  it("中英混排的无 BOM UTF-16LE（ASCII 只占一部分字符）也认", () => {
    const text = "密码：SuperSecretValue99\n说明：这是测试环境的口令，请勿外传\n";
    expect(decodeForScan(utf16le(text, false), "notes.txt")).toBe(text);
    expect(decodeForScan(utf16be(text, false), "notes.txt")).toBe(text);
  });

  it("中文为主的无 BOM UTF-16（ASCII 只占约两成）也认——阈值取宽（一成），不是对半", () => {
    const text =
      "密码：Abc12345\n说明：这是测试环境的口令，请勿外传，仅限内部使用，不得截图转发或写进文档\n";
    const chars = [...text];
    const asciiShare =
      chars.filter((c) => c.charCodeAt(0) < 128).length / chars.length;
    // 前置：ASCII 占比在一成与三成之间——上一条的混排例子正好对半，守不住「一成」这条线
    expect(asciiShare).toBeGreaterThan(0.1);
    expect(asciiShare).toBeLessThan(0.3);
    expect(decodeForScan(utf16le(text, false), "notes.txt")).toBe(text);
    expect(decodeForScan(utf16be(text, false), "notes.txt")).toBe(text);
  });

  it("中文里个别字的低字节恰好是 0（如「一」U+4E00）也不影响判定", () => {
    const text = "密码一：SuperSecretValue99\n说明：一二三\n";
    // 「一」是第 3 个字符：字节 4 是它的低字节、恰好是 0（落在偶数位——和「NUL 全在奇数位」的 LE 特征相反的一侧）
    expect(Buffer.from(text, "utf16le")[4]).toBe(0);
    expect(decodeForScan(utf16le(text, false), "notes.txt")).toBe(text);
    expect(decodeForScan(utf16be(text, false), "notes.txt")).toBe(text);
  });

  it("UTF-8 BOM：去掉 BOM、其余原样", () => {
    const buf = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from("password=SuperSecretValue99\n", "utf-8"),
    ]);
    expect(decodeForScan(buf, "a.env")).toBe("password=SuperSecretValue99\n");
  });

  it("普通 UTF-8（含中文）原样返回；空文件返回空串", () => {
    const text = "# 说明\nname: demo\n";
    expect(decodeForScan(Buffer.from(text, "utf-8"), "SKILL.md")).toBe(text);
    expect(decodeForScan(Buffer.alloc(0), "empty.txt")).toBe("");
  });

  it("只有 BOM、没有内容 → 空串（不是 U+FFFD 乱码）", () => {
    expect(decodeForScan(Buffer.from([0xef, 0xbb, 0xbf]), "a.txt")).toBe("");
    expect(decodeForScan(Buffer.from([0xff, 0xfe]), "a.txt")).toBe("");
    expect(decodeForScan(Buffer.from([0xfe, 0xff]), "a.txt")).toBe("");
  });

  it("不改动传入的 Buffer：大端解码要交换字节序，必须在副本上做", () => {
    for (const bom of [true, false]) {
      const buf = utf16be(SECRET_LINE, bom);
      const snapshot = Buffer.from(buf);
      expect(decodeForScan(buf, "notes.txt")).toBe(SECRET_LINE);
      expect(buf.equals(snapshot)).toBe(true);
    }
  });

  it("NUL 在奇偶两侧都不少（各约一成半）、其余是可读 ASCII → 不当 UTF-16，去 NUL 后照扫", () => {
    // 每 7 个字节里 1 个 NUL：NUL 的位置奇偶交替，两侧占比都 ≈ 14.5%——只看「一侧 ≥ 一成」会误判成 UTF-16，
    // 还得要求「另一侧不到它的 1/5」；误判后解出来是一串 CJK、不含控制字符，后面的非打印判定救不回来
    const bytes = Array.from({ length: 400 }, (_, i) =>
      i % 7 === 0 ? 0 : 97 + (i % 26),
    );
    const buf = Buffer.from(bytes);
    let evenNul = 0;
    let oddNul = 0;
    for (let i = 0; i < buf.length; i += 2) {
      if (buf[i] === 0) evenNul++;
      if (buf[i + 1] === 0) oddNul++;
    }
    expect(evenNul / (buf.length / 2)).toBeGreaterThanOrEqual(0.1);
    expect(oddNul / (buf.length / 2)).toBeGreaterThanOrEqual(0.1);
    expect(decodeForScan(buf, "notes.txt")).toBe(
      Buffer.from(bytes.filter((b) => b !== 0)).toString("utf-8"),
    );
  });

  it("奇数长度的 UTF-16（被截断）不抛错、解出前面完整的部分", () => {
    const buf = Buffer.concat([utf16le("password=Super"), Buffer.from([0x53])]);
    expect(decodeForScan(buf, "notes.txt")).toBe("password=Super");
    // 大端要先交换字节序，Node 的 swap16 遇到奇数长度会抛 RangeError——解码前必须先丢掉最后那半个字符
    for (const bom of [true, false]) {
      const be = Buffer.concat([utf16be("password=Super", bom), Buffer.from([0x53])]);
      expect(decodeForScan(be, "notes.txt")).toBe("password=Super");
    }
  });

  it("UTF-16 解出来仍是二进制（控制字符占比高）→ null：非打印占比在解码后判", () => {
    const buf = utf16le("\u0001\u0002\u0003\u0004\u0005\u0006\u0007\u0008\u0001\u0002");
    expect(decodeForScan(buf, "x.txt")).toBeNull();
  });

  it("未知扩展名、文本里夹零星 NUL → 去掉 NUL 照扫（宁可多扫、不漏）", () => {
    expect(decodeForScan(TEXT_WITH_NUL, "config.env")).toBe(
      "password=SuperSecretValue99\n# note: demo\n",
    );
  });

  it("同样的内容、扩展名明确是二进制格式 → 不扫；扩展名大小写、目录名里的点、隐藏文件都按「最后一段文件名」算", () => {
    expect(decodeForScan(TEXT_WITH_NUL, "img/logo.png")).toBeNull();
    expect(decodeForScan(TEXT_WITH_NUL, "a/ICON.PNG")).toBeNull();
    expect(decodeForScan(TEXT_WITH_NUL, "a\\b\\pack.zip")).toBeNull();
    // 目录叫 x.png、文件本身没有扩展名 → 照扫
    expect(decodeForScan(TEXT_WITH_NUL, "dir.png/README")).toContain(
      "password=SuperSecretValue99",
    );
    // `.png` 是隐藏文件名、不是扩展名 → 照扫（正反斜杠两种分隔符都要认：不认的话整串 `a\.png` 的最后一个点后面就是 `png`）
    expect(decodeForScan(TEXT_WITH_NUL, "a/.png")).toContain(
      "password=SuperSecretValue99",
    );
    expect(decodeForScan(TEXT_WITH_NUL, "a\\.png")).toContain(
      "password=SuperSecretValue99",
    );
  });

  it("真二进制：PNG 文件头 + 随机字节 → null", () => {
    const png = pngLike();
    expect(png.includes(0)).toBe(true);
    expect(decodeForScan(png, "img/logo.png")).toBeNull();
  });

  it("未知扩展名的二进制垃圾（NUL 两侧均匀、解码后控制字符占比高）→ null；不会被误当成 UTF-16", () => {
    expect(BINARY_JUNK.includes(0)).toBe(true);
    expect(decodeForScan(BINARY_JUNK, "blob.dat")).toBeNull();
    expect(decodeForScan(BINARY_JUNK, "blob")).toBeNull();
  });

  it("与扫描器衔接：UTF-16 的口令文件解码后能被 scanSensitiveFiles 命中", () => {
    const content = decodeForScan(utf16le(SECRET_LINE), "notes.txt");
    expect(content).not.toBeNull();
    const hits = scanSensitiveFiles([
      { path: "skills/qa/demo/notes.txt", content: content! },
    ]);
    expect(hits.map((h) => h.kind)).toContain("credential-key");
    expect(hits[0]?.file).toBe("skills/qa/demo/notes.txt");
    // 原始字节（含 NUL）直接当字符串喂给扫描器 = 改前的行为：整个文件被跳过
    expect(
      scanSensitiveFiles([
        {
          path: "skills/qa/demo/notes.txt",
          content: utf16le(SECRET_LINE).toString("latin1"),
        },
      ]),
    ).toEqual([]);
  });
});

describe("端到端：上传前的敏感扫描认得 UTF-16 / 夹 NUL 的文本（本地 bare 当远端）", () => {
  let env: Awaited<ReturnType<typeof setupTeamLibraryE2E>>;

  const skillMd = (name: string): string =>
    `---\nname: ${name}\ndescription: ${name} desc\n---\n\n# ${name}\n`;

  /** 往本机自管 skill 目录里写二进制内容的文件（env.writeAppSkill 只写文本） */
  const writeBin = async (
    skill: string,
    rel: string,
    buf: Buffer,
  ): Promise<void> => {
    const abs = path.join(env.dataDir, "skills", skill, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, buf);
  };

  beforeAll(async () => {
    env = await setupTeamLibraryE2E({
      prefix: "fe-tl-scan-decode",
      token: "tok-alice",
      users: {
        "tok-alice": {
          id: 101,
          username: "alice",
          name: "Alice",
          email: "alice@example.com",
        },
      },
    });
    const synced = await syncTeamLibrary();
    expect(synced.ok).toBe(true);
  }, T);

  afterAll(async () => {
    await env.cleanup();
  });

  it(
    "UTF-16 的口令文件 → 被拦（改前整个文件当二进制跳过、照传）；远端不动、本地不留幻影",
    async () => {
      await env.writeAppSkill("u16-leak", { "SKILL.md": skillMd("u16-leak") });
      await writeBin("u16-leak", "config.txt", utf16le(SECRET_LINE));
      const before = await env.remoteHead();

      const r = await uploadSkillsToTeamLibrary(["u16-leak"], "qa");

      expect(r.ok).toBe(false);
      expect(
        (r.sensitiveHits ?? []).some(
          (h) =>
            h.file === "skills/qa/u16-leak/config.txt" &&
            h.kind === "credential-key",
        ),
      ).toBe(true);
      expect(await env.remoteHead()).toBe(before);
      expect(await env.localHead()).toBe(before);
      expect(await env.localStatus()).toBe("");
    },
    T,
  );

  it(
    "对照：UTF-16 但没有口令 → 照常上传",
    async () => {
      await env.writeAppSkill("u16-clean", { "SKILL.md": skillMd("u16-clean") });
      await writeBin("u16-clean", "notes.txt", utf16le("hello world\r\n"));

      const r = await uploadSkillsToTeamLibrary(["u16-clean"], "qa");

      expect(r.ok).toBe(true);
      expect(await env.remoteFiles()).toContain("skills/qa/u16-clean/notes.txt");
    },
    T,
  );

  it(
    "对照：真二进制（.png，含 NUL）→ 不扫、照常上传（即使里面夹着一段 password=… 的文本块）",
    async () => {
      await env.writeAppSkill("png-ok", { "SKILL.md": skillMd("png-ok") });
      // 真 PNG 的 tEXt 块可以带任意文本；已知二进制扩展名整个不扫——接线时把路径一起交给 decodeForScan，这一条才成立
      const textChunk = Buffer.from(
        "\0tEXtComment\0password=SuperSecretValue99\0",
        "latin1",
      );
      await writeBin(
        "png-ok",
        "logo.png",
        Buffer.concat([pngLike(), textChunk]),
      );

      const r = await uploadSkillsToTeamLibrary(["png-ok"], "qa");

      expect(r.ok).toBe(true);
      expect(await env.remoteFiles()).toContain("skills/qa/png-ok/logo.png");
    },
    T,
  );

  it(
    "同样的字节：叫 .txt → 去 NUL 照扫、被拦；叫 .png → 按扩展名整个不扫、照常上传（路径必须交给 decodeForScan）",
    async () => {
      // 上一条的 .png 带 256 字节随机噪声，光看内容就是二进制——不管路径有没有交给 decodeForScan 都会放过，分辨不出接线对不对。
      // 这里文本占 99% 以上（只有文件头 + 几个 NUL，非打印字节占比不到 1%）：不靠扩展名的话，这个文件会被当文本扫、口令被抓。
      const body = Buffer.concat([
        pngLike().subarray(0, 29), // PNG 文件头 + IHDR
        Buffer.from(
          "\0tEXtComment\0\npassword=SuperSecretValue99\n\0" +
            "plain text. ".repeat(200),
          "latin1",
        ),
      ]);

      // 先证明「内容本身扫得出口令」：同样的字节叫 .txt（不在二进制扩展名表里）→ 被拦
      await env.writeAppSkill("twin-txt", { "SKILL.md": skillMd("twin-txt") });
      await writeBin("twin-txt", "logo.txt", body);
      const blocked = await uploadSkillsToTeamLibrary(["twin-txt"], "qa");
      expect(blocked.ok).toBe(false);
      expect(
        (blocked.sensitiveHits ?? []).some(
          (h) =>
            h.file === "skills/qa/twin-txt/logo.txt" &&
            h.kind === "credential-key",
        ),
      ).toBe(true);

      // 再叫 .png：已知二进制扩展名 → 整个不扫、照常上传
      await env.writeAppSkill("twin-png", { "SKILL.md": skillMd("twin-png") });
      await writeBin("twin-png", "logo.png", body);
      const ok = await uploadSkillsToTeamLibrary(["twin-png"], "qa");
      expect(ok.ok).toBe(true);
      expect(await env.remoteFiles()).toContain("skills/qa/twin-png/logo.png");
    },
    T,
  );
});
