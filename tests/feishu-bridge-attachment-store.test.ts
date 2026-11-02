/**
 * attachment-store：入向附件落盘的净化 / 子目录 / 唯一前缀 / TTL 清扫（P1：发件人可控的文件名覆盖状态文件）
 *
 * 旧实现把下载产物 rename 成「bridge 目录顶层 + 发件人给的文件名」（只把斜杠换成下划线）：
 * 文件名叫 `bridge-state.json` / `card-map.json` 就把去重表 / 路由指针 / card-map 整个覆盖了；
 * 同名附件互相覆盖；非图片附件没有任何 TTL。这里钉住新的落点与清扫范围。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetAttachmentSweepForTest,
  ATTACHMENT_TTL_MS,
  ATTACHMENTS_DIR_NAME,
  maybeSweepStaleAttachments,
  placeAttachment,
  sanitizeAttachmentFileName,
  sweepStaleAttachments,
} from "@/lib/server/feishu-bridge/attachment-store";

let bridgeDir = "";

beforeEach(async () => {
  bridgeDir = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-attach-store-"));
  __resetAttachmentSweepForTest();
});

afterEach(async () => {
  await fs.rm(bridgeDir, { recursive: true, force: true });
});

/** 在 bridge 目录顶层造一个「刚下载好」的产物（与 lark-api.downloadMessageResource 的落点一致） */
const makeDownload = async (content = "payload", name = `dl-${Date.now()}-key`): Promise<string> => {
  const p = path.join(bridgeDir, name);
  await fs.writeFile(p, content);
  return p;
};

describe("sanitizeAttachmentFileName", () => {
  it("正常文件名（含中文、空格）原样保留", () => {
    expect(sanitizeAttachmentFileName("报告 v2.pdf")).toBe("报告 v2.pdf");
    expect(sanitizeAttachmentFileName("notes.txt")).toBe("notes.txt");
  });

  it.each([
    "a/b.pdf",
    "a\\b.pdf",
    "../../etc/passwd",
    "..\\..\\Windows\\system32\\x.dll",
    "/abs/path/x.txt",
    "C:\\Users\\x\\y.txt",
    "....//....//x",
  ])("路径分隔符 / 穿越：%s → 单段安全文件名（无分隔符、无 ..、不以点开头、basename 不变）", (raw) => {
    const out = sanitizeAttachmentFileName(raw);
    expect(out).not.toMatch(/[\\/]/);
    expect(out).not.toContain("..");
    expect(out.startsWith(".")).toBe(false);
    expect(path.basename(out)).toBe(out);
    expect(path.win32.basename(out)).toBe(out);
    expect(out.length).toBeGreaterThan(0);
  });

  it("保持旧行为：斜杠 → 下划线", () => {
    expect(sanitizeAttachmentFileName("a/b.pdf")).toBe("a_b.pdf");
  });

  it("控制字符（含 NUL / 换行）与 Windows 非法字符一律换成下划线", () => {
    expect(sanitizeAttachmentFileName("a\u0000b\nc\td.txt")).toBe("a_b_c_d.txt");
    expect(sanitizeAttachmentFileName('a<b>c:d"e|f?g*h.txt')).toBe("a_b_c_d_e_f_g_h.txt");
  });

  it("末尾的点与空格去掉（Windows 会静默吞掉）；开头的点去掉（不留隐藏文件）", () => {
    expect(sanitizeAttachmentFileName("a.txt. . ")).toBe("a.txt");
    expect(sanitizeAttachmentFileName(".env")).toBe("env");
    expect(sanitizeAttachmentFileName(".bashrc.")).toBe("bashrc");
  });

  it.each([
    ["CON", "_CON"],
    ["nul.txt", "_nul.txt"],
    ["COM1.log", "_COM1.log"],
    ["lpt9", "_lpt9"],
    ["Aux.tar.gz", "_Aux.tar.gz"],
    ["console.txt", "console.txt"], // 只拦「第一个点之前恰好等于保留名」
    ["com10.txt", "com10.txt"],
  ])("Windows 保留设备名：%s → %s", (raw, want) => {
    expect(sanitizeAttachmentFileName(raw)).toBe(want);
  });

  it.each(["", "   ", ".", "..", "...", " . . "])("净化后为空（%j）→ 兜底名 file", (raw) => {
    expect(sanitizeAttachmentFileName(raw)).toBe("file");
  });

  it("尾部 / 头部夹着 Unicode 空白（NBSP / 全角空格 / BOM）：去尾点、去头点在 trim 之后，不残留尾点或隐藏文件（旧顺序：先去尾点再 trim，trim 吃掉空白后尾点又露出来）", () => {
    expect(sanitizeAttachmentFileName("report.pdf.\u00a0")).toBe("report.pdf");
    expect(sanitizeAttachmentFileName("a.b.\u3000")).toBe("a.b");
    expect(sanitizeAttachmentFileName("name.\ufeff")).toBe("name");
    expect(sanitizeAttachmentFileName("name. \u00a0 .")).toBe("name");
    // 头部同理：空白挡在点前面时 ^\.+ 匹配不到，trim 之后就成了隐藏文件
    expect(sanitizeAttachmentFileName("\u00a0.hidden")).toBe("hidden");
    expect(sanitizeAttachmentFileName(" .bashrc")).toBe("bashrc");
    // 结果里不会以点 / 空白收尾或开头（任何平台都安全）
    for (const raw of ["x.\u00a0", "\u3000.x", " . ", "..\u00a0..", "f.txt.\u2003"]) {
      const out = sanitizeAttachmentFileName(raw);
      expect(out, raw).not.toMatch(/^[.\s]|[.\s]$/);
    }
  });

  it("超长截断后末尾又落在点 / Unicode 空白上：同样收掉", () => {
    // 197 个 a + "." + NBSP(2 字节) 恰好 200 字节：截断点正好落在 NBSP 之后
    const out = sanitizeAttachmentFileName(`${"a".repeat(197)}.\u00a0${"b".repeat(20)}`);
    expect(out).not.toMatch(/[.\s]$/);
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(200);
  });

  it("兜底名可指定；null / undefined 也不炸", () => {
    expect(sanitizeAttachmentFileName("", "video.mp4")).toBe("video.mp4");
    expect(sanitizeAttachmentFileName(undefined as unknown as string)).toBe("file");
    expect(sanitizeAttachmentFileName(null as unknown as string)).toBe("file");
  });

  const bytes = (s: string): number => Buffer.byteLength(s, "utf8");

  it("按 UTF-8 字节限长（≤200）且保留扩展名；扩展名本身超长（乱码）就不保留", () => {
    const long = `${"长".repeat(300)}.pdf`;
    const out = sanitizeAttachmentFileName(long);
    expect(bytes(out)).toBeLessThanOrEqual(200);
    expect(out.endsWith(".pdf")).toBe(true);

    const ascii = `${"a".repeat(500)}.pdf`;
    const asciiOut = sanitizeAttachmentFileName(ascii);
    expect(bytes(asciiOut)).toBeLessThanOrEqual(200);
    expect(asciiOut.endsWith(".pdf")).toBe(true);

    const weird = `${"x".repeat(50)}.${"e".repeat(300)}`;
    expect(bytes(sanitizeAttachmentFileName(weird))).toBeLessThanOrEqual(200);
  });

  it("按字节而非 UTF-16 码元：100 个汉字（旧上限 120 码元放行、实际 300 字节）也被截到 200 字节内，不留半个字", () => {
    const out = sanitizeAttachmentFileName(`${"汉".repeat(100)}.pdf`);
    expect(bytes(out)).toBeLessThanOrEqual(200);
    expect(out.endsWith(".pdf")).toBe(true);
    // 只剩整字：不含替换符，且 UTF-8 往返无损
    expect(out).not.toContain("\ufffd");
    expect(Buffer.from(out, "utf8").toString("utf8")).toBe(out);
    expect(out.slice(0, -".pdf".length)).toMatch(/^汉+$/);
  });

  it("截断落在代理对（emoji，4 字节）中间时整颗丢掉、不留孤立代理项", () => {
    // 4 字节 emoji 反复叠：200 字节恰好装 50 个；加个 1 字节前缀让边界落进某个 emoji 中间
    const out = sanitizeAttachmentFileName(`a${"😀".repeat(80)}.png`);
    expect(bytes(out)).toBeLessThanOrEqual(200);
    expect(out.endsWith(".png")).toBe(true);
    expect(out).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/);
    expect(Buffer.from(out, "utf8").toString("utf8")).toBe(out);
  });

  it("没超限的多字节名原样保留（不误截）", () => {
    const name = `${"汉".repeat(60)}.pdf`; // 184 字节
    expect(sanitizeAttachmentFileName(name)).toBe(name);
  });

  it.each([
    ["\u2028", "行分隔符 U+2028"],
    ["\u2029", "段分隔符 U+2029"],
    ["\u0085", "NEL U+0085"],
    ["\u202e", "RLO U+202E"],
    ["\u202a", "LRE U+202A"],
    ["\u202c", "PDF U+202C"],
    ["\u2066", "LRI U+2066"],
    ["\u2069", "PDI U+2069"],
    ["\u200e", "LRM U+200E"],
    ["\u200f", "RLM U+200F"],
    ["\u061c", "ALM U+061C"],
  ])("不可见的换行 / 双向控制符 %j（%s）换成下划线", (ch) => {
    expect(sanitizeAttachmentFileName(`a${ch}b.txt`)).toBe("a_b.txt");
  });

  it("RLO 伪装扩展名（photo\\u202Egnp.exe 显示成 photoexe.png）：控制符被换掉，真实扩展名 .exe 如实可见", () => {
    const out = sanitizeAttachmentFileName("photo\u202Egnp.exe");
    expect(out).toBe("photo_gnp.exe");
  });

  it("不误伤正常文字：ZWJ 组合 emoji / 阿拉伯文 / 日文 / 全角标点原样保留", () => {
    for (const name of ["👨\u200d👩\u200d👧.png", "تقرير.pdf", "報告書（最終版）.docx", "ｆｕｌｌ．txt"]) {
      expect(sanitizeAttachmentFileName(name)).toBe(name);
    }
  });
});

describe("placeAttachment：落点 = <bridge>/attachments/<messageId>/<前缀>-<净化名>", () => {
  it("文件名叫 bridge-state.json / card-map.json / card-seq.json：不覆盖同级状态文件，内容完好地挪到子目录", async () => {
    for (const stateName of ["bridge-state.json", "card-map.json", "card-seq.json"]) {
      const statePath = path.join(bridgeDir, stateName);
      await fs.writeFile(statePath, `STATE:${stateName}`);
      const src = await makeDownload(`EVIL:${stateName}`, `dl-1-${stateName}`);

      const dest = await placeAttachment(src, stateName, "om_evil_1");

      // 状态文件原封不动（旧实现 rename 到顶层同名，这里就被覆盖成 EVIL）
      expect(await fs.readFile(statePath, "utf-8")).toBe(`STATE:${stateName}`);
      // 附件在子目录、带唯一前缀；内容是发件人发的那份
      expect(path.dirname(dest)).toBe(path.join(bridgeDir, ATTACHMENTS_DIR_NAME, "om_evil_1"));
      expect(path.basename(dest)).toMatch(new RegExp(`^[0-9a-f]{6}-${stateName.replace(".", "\\.")}$`));
      expect(await fs.readFile(dest, "utf-8")).toBe(`EVIL:${stateName}`);
      // 下载产物被挪走（不留 dl-* 残留）
      await expect(fs.access(src)).rejects.toThrow();
    }
  });

  it("同一条消息里的同名附件互不覆盖（唯一前缀）", async () => {
    const a = await placeAttachment(await makeDownload("A", "dl-1-a"), "报告.pdf", "om_same");
    const b = await placeAttachment(await makeDownload("B", "dl-1-b"), "报告.pdf", "om_same");
    expect(a).not.toBe(b);
    expect(await fs.readFile(a, "utf-8")).toBe("A");
    expect(await fs.readFile(b, "utf-8")).toBe("B");
    expect(path.dirname(a)).toBe(path.dirname(b));
  });

  it("不同消息的同名附件落在各自的 messageId 子目录", async () => {
    const a = await placeAttachment(await makeDownload("A", "dl-1-a"), "x.txt", "om_1");
    const b = await placeAttachment(await makeDownload("B", "dl-1-b"), "x.txt", "om_2");
    expect(path.basename(path.dirname(a))).toBe("om_1");
    expect(path.basename(path.dirname(b))).toBe("om_2");
  });

  it.each(["../../escape.txt", "..\\..\\escape.txt", "/etc/passwd", "a/../../b"])(
    "文件名穿越 %s：落点仍在 messageId 子目录内",
    async (name) => {
      const dest = await placeAttachment(await makeDownload(), name, "om_trav");
      const rel = path.relative(path.join(bridgeDir, ATTACHMENTS_DIR_NAME, "om_trav"), dest);
      expect(rel.startsWith("..")).toBe(false);
      expect(path.isAbsolute(rel)).toBe(false);
      expect(rel).toBe(path.basename(dest)); // 直接在该目录下，没有再多一层
    },
  );

  it.each(["../../x", "..\\y", "om/with/slash", "", "...."])(
    "messageId 也不可信（%j）：目录名只留安全字符，落点仍在 attachments/ 之内",
    async (mid) => {
      const dest = await placeAttachment(await makeDownload(), "f.txt", mid);
      const root = path.join(bridgeDir, ATTACHMENTS_DIR_NAME);
      const rel = path.relative(root, dest);
      expect(rel.startsWith("..")).toBe(false);
      expect(rel.split(path.sep)).toHaveLength(2); // <msgDir>/<file>
    },
  );

  it("超长中文文件名真能落盘：文件系统 NAME_MAX 是 255 字节，不是 120 个字符（旧实现 100 个汉字 → ENAMETOOLONG）", async () => {
    const src = await makeDownload("BIG", "dl-1-long");
    const dest = await placeAttachment(src, `${"需求评审会议纪要".repeat(20)}.pdf`, "om_long");
    expect(Buffer.byteLength(path.basename(dest), "utf8")).toBeLessThanOrEqual(255);
    expect(path.basename(dest).endsWith(".pdf")).toBe(true);
    expect(await fs.readFile(dest, "utf-8")).toBe("BIG");
  });

  it("源文件不存在 → 抛错（由 router 降级沿用原下载路径）", async () => {
    await expect(
      placeAttachment(path.join(bridgeDir, "dl-missing"), "x.txt", "om_x"),
    ).rejects.toThrow();
  });
});

describe("sweepStaleAttachments：只清 attachments/ 与 dl-* 里过期的文件", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const now = Date.now();

  const writeAged = async (rel: string, ageMs: number): Promise<string> => {
    const p = path.join(bridgeDir, rel);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, "x");
    const t = new Date(now - ageMs);
    await fs.utimes(p, t, t);
    return p;
  };
  const exists = (p: string): Promise<boolean> =>
    fs.access(p).then(
      () => true,
      () => false,
    );

  it("默认 TTL 是 30 天", () => {
    expect(ATTACHMENT_TTL_MS).toBe(30 * DAY);
  });

  it("过期的清掉、没过期的留着；清空的 messageId 目录顺手删；bridge 顶层状态文件与其它文件一概不碰（即便很旧）", async () => {
    const oldPdf = await writeAged("attachments/om_old/old.pdf", 40 * DAY);
    const newPdf = await writeAged("attachments/om_new/new.pdf", 1 * DAY);
    const mixedOld = await writeAged("attachments/om_mixed/old.txt", 31 * DAY);
    const mixedNew = await writeAged("attachments/om_mixed/new.txt", 29 * DAY);
    const dlOld = await writeAged("dl-1700000000-oldkey", 45 * DAY);
    const dlNew = await writeAged("dl-1700000001-newkey", 2 * DAY);
    // 很旧的状态文件 / 其它文件：绝不能被清
    const state = await writeAged("bridge-state.json", 400 * DAY);
    const cardMap = await writeAged("card-map.json", 400 * DAY);
    const other = await writeAged("other-old.bin", 400 * DAY);

    const removed = await sweepStaleAttachments(bridgeDir, ATTACHMENT_TTL_MS, now);

    expect(removed).toBe(3); // old.pdf / mixed 里的 old.txt / dl-old
    expect(await exists(oldPdf)).toBe(false);
    expect(await exists(path.dirname(oldPdf))).toBe(false); // 清空的目录一起删
    expect(await exists(mixedOld)).toBe(false);
    expect(await exists(dlOld)).toBe(false);

    expect(await exists(newPdf)).toBe(true);
    expect(await exists(mixedNew)).toBe(true);
    expect(await exists(path.dirname(mixedNew))).toBe(true);
    expect(await exists(dlNew)).toBe(true);
    expect(await exists(state)).toBe(true);
    expect(await exists(cardMap)).toBe(true);
    expect(await exists(other)).toBe(true);
  });

  it("边界：略小于 TTL 不清、略大于 TTL 才清（两侧各留 1s 余量）", async () => {
    // 不能卡 ±1ms：fs.utimes(Date) 把毫秒换成浮点秒落盘，读回的 mtimeMs 有亚毫秒误差，
    // 「刚好等于 TTL」的文件会随机落在边界哪一侧（旧用例连跑 10 次约一半红）
    const inside = await writeAged("attachments/om_in/in.bin", 30 * DAY - 1_000);
    const outside = await writeAged("attachments/om_out/out.bin", 30 * DAY + 1_000);

    const removed = await sweepStaleAttachments(bridgeDir, ATTACHMENT_TTL_MS, now);

    expect(removed).toBe(1);
    expect(await exists(inside)).toBe(true);
    expect(await exists(outside)).toBe(false);
  });

  it("没有 attachments 目录（还没收过附件）/ bridge 目录不存在：返回 0、不抛", async () => {
    expect(await sweepStaleAttachments(bridgeDir, ATTACHMENT_TTL_MS, now)).toBe(0);
    expect(
      await sweepStaleAttachments(path.join(bridgeDir, "nope"), ATTACHMENT_TTL_MS, now),
    ).toBe(0);
  });

  it("符号链接：只删链接本身、不跟随（链接指向 bridge 外的目标不受影响）", async () => {
    const target = path.join(bridgeDir, "..", `feishu-attach-target-${Date.now()}.txt`);
    await fs.writeFile(target, "precious");
    try {
      const dir = path.join(bridgeDir, "attachments", "om_link");
      await fs.mkdir(dir, { recursive: true });
      const link = path.join(dir, "link.txt");
      try {
        await fs.symlink(target, link);
      } catch {
        return; // 无符号链接权限的环境（Windows 非管理员）跳过
      }
      const old = new Date(now - 60 * DAY);
      await fs.lutimes(link, old, old);

      await sweepStaleAttachments(bridgeDir, ATTACHMENT_TTL_MS, now);

      expect(await fs.readFile(target, "utf-8")).toBe("precious");
      await expect(fs.lstat(link)).rejects.toThrow();
    } finally {
      await fs.rm(target, { force: true });
    }
  });
});

describe("maybeSweepStaleAttachments：节流（≥ 6 小时一次）+ 永不抛", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const HOUR = 60 * 60 * 1000;

  it("第一次真跑（清掉过期的），6 小时内再调不跑，超过 6 小时再跑", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const now = Date.now();
      const old = path.join(bridgeDir, "attachments", "om_a", "a.bin");
      await fs.mkdir(path.dirname(old), { recursive: true });
      await fs.writeFile(old, "x");
      await fs.utimes(old, new Date(now - 40 * DAY), new Date(now - 40 * DAY));

      expect(await maybeSweepStaleAttachments(bridgeDir, now)).toBe(true);
      await expect(fs.access(old)).rejects.toThrow();

      // 6 小时内再来一个过期文件：节流，不跑
      const old2 = path.join(bridgeDir, "attachments", "om_b", "b.bin");
      await fs.mkdir(path.dirname(old2), { recursive: true });
      await fs.writeFile(old2, "x");
      await fs.utimes(old2, new Date(now - 40 * DAY), new Date(now - 40 * DAY));
      expect(await maybeSweepStaleAttachments(bridgeDir, now + 5 * HOUR)).toBe(false);
      await expect(fs.access(old2)).resolves.toBeUndefined();

      expect(await maybeSweepStaleAttachments(bridgeDir, now + 7 * HOUR)).toBe(true);
      await expect(fs.access(old2)).rejects.toThrow();
    } finally {
      log.mockRestore();
    }
  });

  it("bridge 目录不存在也不抛", async () => {
    await expect(
      maybeSweepStaleAttachments(path.join(bridgeDir, "nope")),
    ).resolves.toBe(true);
  });
});
