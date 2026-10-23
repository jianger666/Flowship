/**
 * docx / xlsx 本地文件预览（S10-01 / S15-05 / R5-01 / R5-05）：
 * - 输出的 html 必须经过净化（XSS 载荷不会原样进入 API 响应）
 * - 超过大小上限直接拒绝；zip bomb（真实构造的高压缩比 zip）/ 条目数爆炸被拒；
 * - xlsx 用**真实** xlsx 库现场生成工作簿：公式不解析、只解析首个 sheet、行列截断带提示、输出经净化
 * - xlsx 恶意构造输入回归（CVE-2023-30533 原型污染）：手工拼带 `<comment ref="__proto__">` 的 xlsx，
 *   解析后 Object.prototype 不能被污染（xlsx 0.18.5 下会红、0.20.3 绿）
 * - docx 用真实 mammoth 转换现场拼的最小 docx；净化用例才把 mammoth 替换成「吐恶意 HTML」的实现
 * - N1-01 谎报大小的 zip bomb：中央目录 / 本地头里的 uncompressed size 被改小、实际解压远超上限，
 *   守卫必须按**真实**解压量拒绝，且不能把炸弹展开（zlib 带 maxOutputLength 提前掐断）
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

import * as XLSX from "xlsx";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/** 默认直通真实 mammoth；个别用例通过 mammothOverride 换成自定义实现 */
const mammothState = vi.hoisted(() => ({
  override: null as null | ((...args: unknown[]) => Promise<unknown>),
}));
vi.mock("mammoth", async (importActual) => {
  const actual = await importActual<{ default: { convertToHtml: (...a: unknown[]) => Promise<unknown> } }>();
  return {
    default: {
      ...actual.default,
      convertToHtml: (...args: unknown[]) =>
        mammothState.override
          ? mammothState.override(...args)
          : actual.default.convertToHtml(...args),
    },
  };
});

/** 包一层 XLSX.read：行为完全真实，只是记录下返回的工作簿，供断言「解析结果」（而非调用参数） */
vi.mock("xlsx", async (importActual) => {
  const actual = await importActual<typeof import("xlsx")>();
  return { ...actual, read: vi.fn(actual.read) };
});

import {
  DOCX_CONVERT_TIMEOUT_MS,
  MAX_OFFICE_PREVIEW_BYTES,
  MAX_XLSX_PREVIEW_COLS,
  MAX_XLSX_PREVIEW_ROWS,
  assertOfficePreviewSize,
  readLocalFileForPreview,
} from "@/lib/server/local-file-read";
import {
  MAX_OFFICE_ZIP_ENTRIES,
  MAX_OFFICE_ZIP_ENTRY_BYTES,
  MAX_OFFICE_ZIP_TOTAL_BYTES,
  assertSafeOfficeZip,
  assertSafeOfficeZipDeep,
} from "@/lib/server/office-zip-guard";

const TMP = path.join(os.tmpdir(), `flowship-office-preview-${process.pid}-${Date.now()}`);

beforeAll(async () => {
  await fs.mkdir(TMP, { recursive: true });
});

afterAll(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
});

afterEach(() => {
  mammothState.override = null;
  vi.useRealTimers();
});

// ───────────────────────── 测试用 zip 构造器 ─────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (buf: Buffer): number => {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

interface ZipEntry {
  name: string;
  data: Buffer;
  /** 用 deflate 压缩（默认 store） */
  deflate?: boolean;
  /** 中央目录里用 zip64 扩展字段声明 uncompressed size（uncompressed 字段填 0xFFFFFFFF） */
  zip64?: boolean;
  /**
   * 直接给定压缩后的原始 body（method 8），不再由 data 压缩——用来拼「声明很小、实际解压巨大」的炸弹
   * （此时 data 只用于算 crc，传空 Buffer 即可，真实大小靠 declaredSize 谎报）
   */
  rawBody?: Buffer;
  /** 谎报：中央目录和本地头里写的 uncompressed size（默认写 data.length） */
  declaredSize?: number;
  /** 谎报：中央目录和本地头里写的 compressed size（默认写 body.length） */
  declaredCompressedSize?: number;
  /** 覆盖压缩方式（默认：有 rawBody / deflate 为 8，否则 0） */
  method?: number;
  /** 覆盖通用标志位（如 bit0 = 加密），本地头和中央目录同写 */
  flags?: number;
}

/** 构造真实 zip（local header + data + central directory + EOCD），数据不做任何 mock */
const buildZip = (entries: ZipEntry[]): Buffer => {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const body = e.rawBody ?? (e.deflate ? zlib.deflateRawSync(e.data, { level: 9 }) : e.data);
    const crc = crc32(e.data);
    const method = e.method ?? (e.rawBody || e.deflate ? 8 : 0);
    const flags = e.flags ?? 0;
    const declared = e.declaredSize ?? e.data.length;
    const declaredComp = e.declaredCompressedSize ?? body.length;

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(flags, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(declaredComp, 18);
    lh.writeUInt32LE(declared, 22);
    lh.writeUInt16LE(name.length, 26);
    locals.push(lh, name, body);

    const extra = e.zip64 ? Buffer.alloc(12) : Buffer.alloc(0);
    if (e.zip64) {
      extra.writeUInt16LE(0x0001, 0);
      extra.writeUInt16LE(8, 2);
      extra.writeBigUInt64LE(BigInt(declared), 4);
    }
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(flags, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(declaredComp, 20);
    ch.writeUInt32LE(e.zip64 ? 0xffffffff : declared, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt16LE(extra.length, 30);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name, extra);

    offset += lh.length + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
};

/** 最小可被 mammoth 转换的 docx */
const docxEntries = (text: string): ZipEntry[] => [
  {
    name: "[Content_Types].xml",
    data: Buffer.from(
      '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    ),
    deflate: true,
  },
  {
    name: "_rels/.rels",
    data: Buffer.from(
      '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    ),
    deflate: true,
  },
  {
    name: "word/document.xml",
    data: Buffer.from(
      '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
        `<w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
    ),
    deflate: true,
  },
];

const MB = 1024 * 1024;

/**
 * 要现场构造几十到上百 MB 压缩数据的用例（Buffer.alloc 大块 + deflate）：隔离跑也要 0.6–0.8 秒，
 * 全量并行时被放大到 5 秒以上（本机全量实测超时过一次）。CI 的 2 核机器更慢，别靠默认 5s 碰运气。
 * 只放宽超时、不改任何断言。
 */
const BIG_ZIP_TEST_MS = 60_000;

const writeFile = async (name: string, data: Buffer | Uint8Array): Promise<string> => {
  const file = path.join(TMP, name);
  await fs.writeFile(file, data);
  return file;
};

const writeXlsx = async (name: string, wb: XLSX.WorkBook): Promise<string> =>
  writeFile(name, XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer);

/** 取最近一次 XLSX.read（真实实现）返回的工作簿 */
const lastParsedWorkbook = (): XLSX.WorkBook => {
  const results = vi.mocked(XLSX.read).mock.results;
  return results[results.length - 1].value as XLSX.WorkBook;
};

// ───────────────────────── docx ─────────────────────────

describe("docx 预览", () => {
  it("正常的小 docx（真实 mammoth 转换）仍可预览", async () => {
    const file = await writeFile("ok.docx", buildZip(docxEntries("你好，Flowship 文档")));
    const r = await readLocalFileForPreview(file);
    expect(r.kind).toBe("docx");
    expect(r.previewable).toBe(true);
    expect(r.html).toContain("<p>你好，Flowship 文档</p>");
  });

  it("mammoth 输出里的脚本 / 事件属性 / javascript: 链接被剔除、正常内容保留", async () => {
    mammothState.override = async () => ({
      value:
        "<h1>标题</h1><p>正文</p><script>alert(1)</script>" +
        '<a href="javascript:alert(1)">坏链</a><img src="x" onerror="alert(2)">' +
        '<img src="data:image/png;base64,iVBORw0KGgo=" alt="ok">',
      messages: [],
    });
    const file = await writeFile("evil.docx", buildZip(docxEntries("占位")));
    const r = await readLocalFileForPreview(file);
    expect(r.html).toContain("<h1>标题</h1>");
    expect(r.html).toContain("<p>正文</p>");
    expect(r.html).toContain('<img src="data:image/png;base64,iVBORw0KGgo=" alt="ok">');
    expect(r.html).not.toMatch(/<script/i);
    expect(r.html).not.toMatch(/javascript:/i);
    expect(r.html).not.toMatch(/onerror/i);
  });

  it("mammoth 长时间不返回：软超时后给出可读错误", async () => {
    let called = false;
    mammothState.override = () => {
      called = true;
      return new Promise(() => {}); // 永不 resolve
    };
    const file = await writeFile("hang.docx", buildZip(docxEntries("占位")));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const assertion = expect(readLocalFileForPreview(file)).rejects.toThrow(/docx 转换超时/);
    // 等 mammoth 被调用（此时软超时的 setTimeout 已在同一同步段注册）；setImmediate 未被 fake
    while (!called) await new Promise((r) => setImmediate(r));
    await vi.advanceTimersByTimeAsync(DOCX_CONVERT_TIMEOUT_MS + 1);
    await assertion;
  });

  it("zip bomb：压缩包很小、声明解压后 60MB 的单个条目 → 在解压前被拒绝", async () => {
    const bomb = Buffer.alloc(60 * MB); // 全 0：deflate 后只有几十 KB
    const zip = buildZip([...docxEntries("占位"), { name: "word/media/bomb.bin", data: bomb, deflate: true }]);
    expect(zip.length).toBeLessThan(1 * MB); // 确认真的是高压缩比小文件
    const file = await writeFile("bomb.docx", zip);
    await expect(readLocalFileForPreview(file)).rejects.toThrow(/压缩炸弹/);
  });
});

describe("zip 守卫 assertSafeOfficeZip", () => {
  it("正常 docx 放行", () => {
    expect(() => assertSafeOfficeZip(buildZip(docxEntries("x")), "docx")).not.toThrow();
  });

  it("单条目超限拒绝、恰好等于上限放行", () => {
    const over = buildZip([
      { name: "a", data: Buffer.alloc(MAX_OFFICE_ZIP_ENTRY_BYTES + 1), deflate: true },
    ]);
    expect(() => assertSafeOfficeZip(over, "docx")).toThrow(/单个文件.*压缩炸弹/);
    const ok = buildZip([{ name: "a", data: Buffer.alloc(MAX_OFFICE_ZIP_ENTRY_BYTES), deflate: true }]);
    expect(() => assertSafeOfficeZip(ok, "docx")).not.toThrow();
  }, BIG_ZIP_TEST_MS);

  it("每个条目都不超单条上限、但总量超限也拒绝", () => {
    const each = 40 * MB; // < 单条上限；3 个 = 120MB > 总量上限
    expect(each).toBeLessThanOrEqual(MAX_OFFICE_ZIP_ENTRY_BYTES);
    expect(each * 3).toBeGreaterThan(MAX_OFFICE_ZIP_TOTAL_BYTES);
    expect(each * 2).toBeLessThanOrEqual(MAX_OFFICE_ZIP_TOTAL_BYTES);
    const zip = buildZip(
      [1, 2, 3].map((i) => ({ name: `part${i}`, data: Buffer.alloc(each), deflate: true })),
    );
    expect(() => assertSafeOfficeZip(zip, "xlsx")).toThrow(/总量.*压缩炸弹/);
  }, BIG_ZIP_TEST_MS);

  it("条目数爆炸（> 上限）拒绝", () => {
    const entries = Array.from({ length: MAX_OFFICE_ZIP_ENTRIES + 1 }, (_, i) => ({
      name: `f${i}`,
      data: Buffer.alloc(0),
    }));
    expect(() => assertSafeOfficeZip(buildZip(entries), "docx")).toThrow(/文件数过多/);
    expect(() =>
      assertSafeOfficeZip(buildZip(entries.slice(0, MAX_OFFICE_ZIP_ENTRIES)), "docx"),
    ).not.toThrow();
  });

  it("zip64 扩展字段里声明的超大 size 同样被识别", () => {
    const zip = buildZip([{ name: "big", data: Buffer.alloc(60 * MB), deflate: true, zip64: true }]);
    expect(() => assertSafeOfficeZip(zip, "docx")).toThrow(/压缩炸弹/);
    const small = buildZip([{ name: "small", data: Buffer.from("hi"), zip64: true }]);
    expect(() => assertSafeOfficeZip(small, "docx")).not.toThrow();
  });

  it("不是 zip / 中央目录被截断：抛可读错误而不是崩溃", () => {
    expect(() => assertSafeOfficeZip(Buffer.from("not a zip at all"), "docx")).toThrow(/结构损坏/);
    const zip = buildZip(docxEntries("x"));
    const cut = Buffer.concat([zip.subarray(0, 10), zip.subarray(zip.length - 22)]);
    expect(() => assertSafeOfficeZip(cut, "docx")).toThrow(/结构损坏/);
  });
});

// ───────────────────── 谎报大小的 zip bomb（N1-01：真实解压校验） ─────────────────────

/**
 * 造「解压后恰好 bytes 字节全零」的 raw deflate 流：重复 1MB 零的 sync-flush 块（各块自成一体、
 * 字节对齐、非终止块，可直接首尾拼接）再补一个终止空块。
 * 不用真分配 bytes 大小的 buffer 再压缩——1GB 的炸弹也只有约 1MB 压缩数据、构造几乎不花时间
 */
const zeroDeflate = (bytes: number): Buffer => {
  const flushed = (n: number) =>
    zlib.deflateRawSync(Buffer.alloc(n), { level: 9, finishFlush: zlib.constants.Z_SYNC_FLUSH });
  const parts: Buffer[] = [];
  const block = flushed(MB);
  for (let i = 0; i < Math.floor(bytes / MB); i++) parts.push(block);
  const rest = bytes % MB;
  if (rest > 0) parts.push(flushed(rest));
  parts.push(Buffer.from([0x03, 0x00])); // BFINAL=1 的空 fixed-Huffman 块
  return Buffer.concat(parts);
};

/** 谎报大小的条目：声明只有 `declared` 字节，实际解压出 `actual` 字节 */
const lyingEntry = (name: string, actual: number, declared = 1024): ZipEntry => ({
  name,
  data: Buffer.alloc(0),
  rawBody: zeroDeflate(actual),
  declaredSize: declared,
});

/** 把单条目 zip 的中央目录记录复制 times 份（都指向同一段本地数据：重叠条目炸弹） */
const duplicateCentralRecord = (zip: Buffer, times: number): Buffer => {
  const eocdPos = zip.length - 22;
  const cdOffset = zip.readUInt32LE(eocdPos + 16);
  const cdSize = zip.readUInt32LE(eocdPos + 12);
  const cd = zip.subarray(cdOffset, cdOffset + cdSize);
  const dup = Buffer.concat(Array.from({ length: times }, () => cd));
  const eocd = Buffer.from(zip.subarray(eocdPos));
  eocd.writeUInt16LE(times, 8);
  eocd.writeUInt16LE(times, 10);
  eocd.writeUInt32LE(dup.length, 12);
  return Buffer.concat([zip.subarray(0, cdOffset), dup, eocd]);
};

describe("谎报大小的 zip bomb：按真实解压量拒绝（assertSafeOfficeZipDeep）", () => {
  it("声明 1KB、实际解压 1GB：同步（声明值）守卫看不出，真实解压守卫拒绝，且 zlib 全程带上限、没有展开炸弹", async () => {
    const zip = buildZip([
      ...docxEntries("占位"),
      lyingEntry("word/media/bomb.bin", 1024 * MB),
    ]);
    expect(zip.length).toBeLessThan(2 * MB); // 确认真的是高压缩比小文件
    // 对照（回退自检的靶子）：只看中央目录声明值的旧守卫放行了它——这正是 N1-01
    expect(() => assertSafeOfficeZip(zip, "docx")).not.toThrow();

    const inflateSpy = vi.spyOn(zlib, "inflateRaw");
    const baseline = process.memoryUsage().arrayBuffers;
    let peak = baseline;
    // 异步 zlib 不占事件循环，采样器能在解压期间跑；采不到只会让断言更宽松、不会误红
    const sampler = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().arrayBuffers);
    }, 2);
    let limits: Array<number | undefined> = [];
    try {
      await expect(assertSafeOfficeZipDeep(zip, "docx")).rejects.toThrow(/单个文件.*压缩炸弹/);
      // 先取调用记录再还原桩（mockRestore 会清掉 mock.calls）
      limits = inflateSpy.mock.calls.map((c) => (c[1] as zlib.ZlibOptions).maxOutputLength);
    } finally {
      clearInterval(sampler);
      inflateSpy.mockRestore();
    }

    // 每一次 inflate 都带了有限的 maxOutputLength，且不超过单条上限——zlib 在越界处自己掐断
    expect(limits.length).toBeGreaterThanOrEqual(4); // 3 个正常条目 + 炸弹条目
    for (const limit of limits) {
      expect(limit).toBeTypeOf("number");
      expect(limit as number).toBeLessThanOrEqual(MAX_OFFICE_ZIP_ENTRY_BYTES);
    }
    // 粗内存断言：完全展开是 1GB；守卫期间 ArrayBuffer 峰值远低于它（单条上限 50MB + 拼接副本）
    expect(peak - baseline).toBeLessThan(400 * MB);
  });

  it("谎报总量：每个条目声明 1KB、真实各 40MB（单条没超），累计超过总量上限也拒绝", async () => {
    const entries = [1, 2, 3].map((i) => lyingEntry(`part${i}`, 40 * MB));
    expect(40 * MB).toBeLessThanOrEqual(MAX_OFFICE_ZIP_ENTRY_BYTES);
    expect(3 * 40 * MB).toBeGreaterThan(MAX_OFFICE_ZIP_TOTAL_BYTES);
    const zip = buildZip(entries);
    expect(() => assertSafeOfficeZip(zip, "xlsx")).not.toThrow(); // 声明值看不出
    await expect(assertSafeOfficeZipDeep(zip, "xlsx")).rejects.toThrow(/总量.*压缩炸弹/);
  });

  it("重叠条目：多个中央目录记录指向同一段炸弹数据，真实输出逐条累计、照样被总量拦下", async () => {
    // 每条真实 30MB（单条合法）、声明 1KB；5 条 = 150MB > 100MB 总量上限
    const one = buildZip([lyingEntry("shared", 30 * MB)]);
    const zip = duplicateCentralRecord(one, 5);
    expect(() => assertSafeOfficeZip(zip, "docx")).not.toThrow();
    await expect(assertSafeOfficeZipDeep(zip, "docx")).rejects.toThrow(/总量.*压缩炸弹/);
  });

  it("单条边界：真实恰好等于单条上限放行（即使声明很小）、多 1 字节拒绝", async () => {
    const exact = buildZip([lyingEntry("a", MAX_OFFICE_ZIP_ENTRY_BYTES)]);
    await expect(assertSafeOfficeZipDeep(exact, "docx")).resolves.toBeUndefined();
    const over = buildZip([lyingEntry("a", MAX_OFFICE_ZIP_ENTRY_BYTES + 1)]);
    await expect(assertSafeOfficeZipDeep(over, "docx")).rejects.toThrow(/单个文件.*压缩炸弹/);
  });

  it("总量边界：恰好用满总预算放行；再多一个非空条目（哪怕只有 1 字节）就拒绝", async () => {
    const half = MAX_OFFICE_ZIP_TOTAL_BYTES / 2;
    expect(half).toBeLessThanOrEqual(MAX_OFFICE_ZIP_ENTRY_BYTES);
    const full = [lyingEntry("a", half), lyingEntry("b", half)];
    await expect(assertSafeOfficeZipDeep(buildZip(full), "docx")).resolves.toBeUndefined();
    await expect(
      assertSafeOfficeZipDeep(buildZip([...full, lyingEntry("c", 1)]), "docx"),
    ).rejects.toThrow(/总量.*压缩炸弹/);
  });

  it("带「加密」标志位也不能绕过：标了加密的炸弹照样被真实解压拦下（xlsx 与 jszip 看的标志位不同，不能因标志就跳过）", async () => {
    const zip = buildZip([{ ...lyingEntry("enc-bomb", 200 * MB), flags: 1 }]);
    await expect(assertSafeOfficeZipDeep(zip, "xlsx")).rejects.toThrow(/压缩炸弹/);
  });

  it("真加密的条目（数据是密文、解不出）：给出「加密」明确理由", async () => {
    const zip = buildZip([
      {
        name: "secret",
        data: Buffer.alloc(0),
        rawBody: Buffer.from("this-is-ciphertext-not-deflate-0123456789"),
        declaredSize: 100,
        flags: 1,
      },
    ]);
    await expect(assertSafeOfficeZipDeep(zip, "docx")).rejects.toThrow(/加密/);
  });

  it("数据损坏 / 流被截断：拒绝并说明数据损坏", async () => {
    const garbage = buildZip([
      { name: "g", data: Buffer.alloc(0), rawBody: Buffer.from("not deflate at all, really"), declaredSize: 10 },
    ]);
    await expect(assertSafeOfficeZipDeep(garbage, "docx")).rejects.toThrow(/数据损坏/);
    // 合法 deflate 流去掉末尾几个字节：没有终止块、提前结束
    const truncatedBody = zeroDeflate(4 * MB).subarray(0, 200);
    const truncated = buildZip([
      { name: "t", data: Buffer.alloc(0), rawBody: truncatedBody, declaredSize: 10 },
    ]);
    await expect(assertSafeOfficeZipDeep(truncated, "docx")).rejects.toThrow(/数据损坏/);
  });

  it("压缩后 / 解压后都声明为 0 的空 deflate 条目：不算损坏、放行（部分写入器对空文件不写 deflate 数据）", async () => {
    const zip = buildZip([
      ...docxEntries("x"),
      { name: "empty.xml", data: Buffer.alloc(0), rawBody: Buffer.alloc(0), declaredSize: 0 },
    ]);
    await expect(assertSafeOfficeZipDeep(zip, "docx")).resolves.toBeUndefined();
  });

  it("头部对不上：本地头签名被改坏 / 中央目录里的本地偏移越界 → 明确拒绝（结构损坏）", async () => {
    const zip = buildZip(docxEntries("x"));
    const badSig = Buffer.from(zip);
    badSig.writeUInt32LE(0xdeadbeef, 0); // 第一个条目的本地头签名
    await expect(assertSafeOfficeZipDeep(badSig, "docx")).rejects.toThrow(/头部与中央目录对不上.*结构损坏/);

    const badOffset = Buffer.from(zip);
    const cdOffset = badOffset.readUInt32LE(badOffset.length - 22 + 16);
    badOffset.writeUInt32LE(0x00ffffff, cdOffset + 42); // 第一个条目的本地偏移指到文件外
    await expect(assertSafeOfficeZipDeep(badOffset, "docx")).rejects.toThrow(/头部与中央目录对不上/);
  });

  it("存储（method 0）条目用真实长度对照：声明与实际不符 / 数据被截断都拒绝；正常放行", async () => {
    const hello = Buffer.from("hello");
    await expect(
      assertSafeOfficeZipDeep(buildZip([{ name: "ok", data: hello }]), "xlsx"),
    ).resolves.toBeUndefined();
    // 声明解压后 3 字节、实际存了 5 字节
    await expect(
      assertSafeOfficeZipDeep(buildZip([{ name: "lie", data: hello, declaredSize: 3 }]), "xlsx"),
    ).rejects.toThrow(/头部与中央目录对不上/);
    // 声称存了 1MB、文件里根本没这么多
    await expect(
      assertSafeOfficeZipDeep(
        buildZip([{ name: "cut", data: hello, declaredSize: MB, declaredCompressedSize: MB }]),
        "xlsx",
      ),
    ).rejects.toThrow(/头部与中央目录对不上/);
  });

  it("不认识的压缩方式：不展开（两个解析器也展开不了），按声明值计入、不额外拒绝；声明超限仍由同步层拒绝", async () => {
    const inflateSpy = vi.spyOn(zlib, "inflateRaw");
    try {
      const odd = buildZip([
        { name: "weird", data: Buffer.alloc(0), rawBody: zeroDeflate(200 * MB), method: 99, declaredSize: 1024 },
      ]);
      await expect(assertSafeOfficeZipDeep(odd, "docx")).resolves.toBeUndefined();
      expect(inflateSpy).not.toHaveBeenCalled();
      const oddBig = buildZip([
        { name: "weird", data: Buffer.alloc(0), rawBody: Buffer.alloc(8), method: 99, declaredSize: 60 * MB },
      ]);
      await expect(assertSafeOfficeZipDeep(oddBig, "docx")).rejects.toThrow(/压缩炸弹/);
    } finally {
      inflateSpy.mockRestore();
    }
  });

  it("EOCD 里「本盘条目数」与「总条目数」不一致（xlsx 与守卫会看到不同目录）→ 结构损坏", async () => {
    const zip = buildZip(docxEntries("x"));
    const eocd = zip.length - 22;
    const skewed = Buffer.from(zip);
    skewed.writeUInt16LE(skewed.readUInt16LE(eocd + 10) + 5, eocd + 8);
    expect(() => assertSafeOfficeZip(skewed, "docx")).toThrow(/结构损坏/);
    await expect(assertSafeOfficeZipDeep(skewed, "docx")).rejects.toThrow(/结构损坏/);
  });

  it("合法样例仍放行：正常 docx（deflate）、xlsx（存储 / deflate 两种）、含 zip64 扩展字段的小条目、上万个空条目", async () => {
    await expect(assertSafeOfficeZipDeep(buildZip(docxEntries("你好")), "docx")).resolves.toBeUndefined();

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["a", "b"], [1, 2]]), "S");
    for (const compression of [false, true]) {
      const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx", compression }) as Buffer;
      await expect(assertSafeOfficeZipDeep(buf, "xlsx")).resolves.toBeUndefined();
    }

    await expect(
      assertSafeOfficeZipDeep(
        buildZip([{ name: "small", data: Buffer.from("hi"), zip64: true }]),
        "docx",
      ),
    ).resolves.toBeUndefined();

    const many = Array.from({ length: MAX_OFFICE_ZIP_ENTRIES }, (_, i) => ({
      name: `f${i}`,
      data: Buffer.alloc(0),
    }));
    await expect(assertSafeOfficeZipDeep(buildZip(many), "docx")).resolves.toBeUndefined();
  });

  it("端到端：谎报大小的炸弹 docx 在 mammoth 之前被拒，解析器根本没被喂这个文件", async () => {
    let mammothCalled = false;
    mammothState.override = async () => {
      mammothCalled = true;
      return { value: "<p>x</p>", messages: [] };
    };
    const zip = buildZip([...docxEntries("占位"), lyingEntry("word/media/bomb.bin", 300 * MB)]);
    const file = await writeFile("lying-bomb.docx", zip);
    await expect(readLocalFileForPreview(file)).rejects.toThrow(/压缩炸弹/);
    expect(mammothCalled).toBe(false);
  });

  it("端到端：谎报大小的炸弹 xlsx 在 XLSX.read 之前被拒", async () => {
    const zip = buildZip([
      { name: "[Content_Types].xml", data: Buffer.from("<Types/>") },
      lyingEntry("xl/worksheets/sheet1.xml", 300 * MB),
    ]);
    const file = await writeFile("lying-bomb.xlsx", zip);
    vi.mocked(XLSX.read).mockClear();
    await expect(readLocalFileForPreview(file)).rejects.toThrow(/压缩炸弹/);
    expect(XLSX.read).not.toHaveBeenCalled();
  });

  /** 把 buildZip 产物 EOCD 里的条目数改成 n（本盘 / 总数一起改），中央目录本身不动——M3-01 的构造手法 */
  const shrinkDeclaredEntryCount = (zip: Buffer, n: number): Buffer => {
    const out = Buffer.from(zip);
    out.writeUInt16LE(n, out.length - 22 + 8);
    out.writeUInt16LE(n, out.length - 22 + 10);
    return out;
  };

  it("端到端（M3-01）：EOCD 条数被改小、60MB 条目排在声明范围之外——jszip 照样会读到它，docx 预览必须在 mammoth 之前拒绝", async () => {
    let mammothCalled = false;
    mammothState.override = async () => {
      mammothCalled = true;
      return { value: "<p>x</p>", messages: [] };
    };
    const normal = docxEntries("占位");
    const zip = buildZip([...normal, { name: "word/media/bomb.bin", data: Buffer.alloc(60 * MB), deflate: true }]);
    const shrunk = shrinkDeclaredEntryCount(zip, normal.length);
    // 对照：改之前就被拒（声明 60MB）；改之后只看声明条数的旧守卫会放行
    expect(() => assertSafeOfficeZip(zip, "docx")).toThrow(/压缩炸弹/);
    const file = await writeFile("shrunk-count.docx", shrunk);
    await expect(readLocalFileForPreview(file)).rejects.toThrow(/目录结构有歧义/);
    expect(mammothCalled).toBe(false);
  }, BIG_ZIP_TEST_MS);

  it("端到端（M3-01）：同样的手法对 xlsx：XLSX.read 之前就被拒", async () => {
    const zip = buildZip([
      { name: "[Content_Types].xml", data: Buffer.from("<Types/>") },
      { name: "xl/worksheets/sheet1.xml", data: Buffer.alloc(60 * MB), deflate: true },
    ]);
    const shrunk = shrinkDeclaredEntryCount(zip, 1);
    const file = await writeFile("shrunk-count.xlsx", shrunk);
    vi.mocked(XLSX.read).mockClear();
    await expect(readLocalFileForPreview(file)).rejects.toThrow(/目录结构有歧义/);
    expect(XLSX.read).not.toHaveBeenCalled();
  }, BIG_ZIP_TEST_MS);

  it("端到端（xlsx 纯 JS inflate 空转）：含「压缩后 / 解压后都声明 0 的空 deflate 条目」的 xlsx 在 XLSX.read 之前被拒", async () => {
    // XLSX.read 在这种文件上会同步空转数秒（实测 235 字节 ≈ 1~3 秒、每个条目叠加一次），必须根本没被调用；
    // 同一份条目换成 docx 照常放行（jszip 不受影响，见既有「空 deflate 条目放行」用例）
    const zip = buildZip([
      { name: "[Content_Types].xml", data: Buffer.from("<Types/>") },
      { name: "xl/empty.xml", data: Buffer.alloc(0), rawBody: Buffer.alloc(0), declaredSize: 0 },
    ]);
    const file = await writeFile("empty-deflate-entry.xlsx", zip);
    vi.mocked(XLSX.read).mockClear();
    await expect(readLocalFileForPreview(file)).rejects.toThrow(/空 deflate 条目/);
    expect(XLSX.read).not.toHaveBeenCalled();
  });

  it("端到端：deflate 压缩的正常 xlsx 经新守卫仍能预览", async () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["列A", "列B"], ["值1", "值2"]]), "S");
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx", compression: true }) as Buffer;
    const r = await readLocalFileForPreview(await writeFile("deflated.xlsx", buf));
    expect(r.kind).toBe("xlsx");
    expect(r.html).toContain("值2");
  });
});

describe("zip 守卫接线契约（N1-01）", () => {
  const src = (p: string) => fs.readFile(path.resolve(import.meta.dirname, "..", p), "utf-8");

  it("预览路径在解析器之前 await 真实解压守卫，不再只调同步声明值守卫", async () => {
    const code = await src("src/lib/server/local-file-read.ts");
    const docxGuard = code.indexOf('await assertSafeOfficeZipDeep(buf, "docx")');
    const xlsxGuard = code.indexOf('await assertSafeOfficeZipDeep(buf, "xlsx")');
    expect(docxGuard).toBeGreaterThan(-1);
    expect(xlsxGuard).toBeGreaterThan(-1);
    expect(docxGuard).toBeLessThan(code.indexOf("mammoth.convertToHtml("));
    expect(xlsxGuard).toBeLessThan(code.indexOf("XLSX.read("));
    // 没有残留只看声明值的同步调用
    expect(code).not.toMatch(/\bassertSafeOfficeZip\(/);
  });

  it("守卫用异步 zlib.inflateRaw 且必带 maxOutputLength，不用不设上限 / 阻塞事件循环的写法", async () => {
    const code = await src("src/lib/server/office-zip-guard.ts");
    expect(code).toContain("zlib.inflateRaw(data, { maxOutputLength }");
    expect(code).not.toContain("inflateRawSync");
    expect(code).not.toContain("gunzip");
  });
});

// ───────────────────────── xlsx（真实库） ─────────────────────────

describe("xlsx 预览（真实 xlsx 库）", () => {
  it("正常小表格可预览；单元格里的 HTML 特殊字符以转义文本展示", async () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet([
        ["姓名", "备注"],
        ["张三", "<img src=x onerror=alert(1)>"],
        ["李四", "<script>alert(2)</script>"],
      ]),
      "Sheet1",
    );
    const r = await readLocalFileForPreview(await writeXlsx("plain.xlsx", wb));
    expect(r.kind).toBe("xlsx");
    expect(r.previewable).toBe(true);
    expect(r.html).toContain("<table>");
    expect(r.html).toContain("张三");
    expect(r.html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(r.html).toContain("&lt;script&gt;alert(2)&lt;/script&gt;");
    expect(r.html).not.toMatch(/<img/i);
    expect(r.html).not.toMatch(/<script/i);
    // 未截断：没有提示
    expect(r.html).not.toContain("表格过大");
  });

  it("公式不被解析：解析结果里没有 f，预览展示缓存值", async () => {
    const ws: XLSX.WorkSheet = {
      A1: { t: "n", v: 1 },
      A2: { t: "n", v: 2 },
      A3: { t: "n", v: 3, f: "SUM(A1:A2)" },
      "!ref": "A1:A3",
    };
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "S");
    const file = await writeXlsx("formula.xlsx", wb);

    // 文件里确实带公式（对照：不关 cellFormula 时能读到 f）
    const control = XLSX.read(await fs.readFile(file), { type: "buffer" });
    expect(control.Sheets.S.A3.f).toBe("SUM(A1:A2)");

    const r = await readLocalFileForPreview(file);
    const parsed = lastParsedWorkbook();
    expect(parsed.Sheets.S.A3.f).toBeUndefined();
    expect(parsed.Sheets.S.A3.v).toBe(3);
    expect(r.html).toContain(">3<");
    expect(r.html).not.toContain("SUM(");
  });

  it("只解析首个 sheet：其它 sheet 既不解析也不展示", async () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["首页独有"]]), "First");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["第二页独有内容"]]), "Second");
    const file = await writeXlsx("sheets.xlsx", wb);

    // 对照：默认会解析全部 sheet
    expect(Object.keys(XLSX.read(await fs.readFile(file), { type: "buffer" }).Sheets)).toEqual([
      "First",
      "Second",
    ]);

    const r = await readLocalFileForPreview(file);
    expect(Object.keys(lastParsedWorkbook().Sheets)).toEqual(["First"]);
    expect(r.html).toContain("首页独有");
    expect(r.html).not.toContain("第二页独有内容");
  });

  it("超过行数上限的 xlsx：多出的行被截断并带提示", async () => {
    const total = MAX_XLSX_PREVIEW_ROWS + 50;
    const aoa = Array.from({ length: total }, (_, i) => [`row-${i + 1}-end`, i + 1]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), "S");
    const r = await readLocalFileForPreview(await writeXlsx("many-rows.xlsx", wb));

    expect(r.html).toContain(`row-${MAX_XLSX_PREVIEW_ROWS}-end`);
    expect(r.html).not.toContain(`row-${MAX_XLSX_PREVIEW_ROWS + 1}-end`);
    expect(r.html).not.toContain(`row-${total}-end`);
    expect(r.html).toContain(`仅显示前 ${MAX_XLSX_PREVIEW_ROWS} 行`);
    expect((r.html?.match(/<tr>/g) ?? []).length).toBe(MAX_XLSX_PREVIEW_ROWS);
    // 解析规模也被限制：解析器本身只读了上限 +1 行（用来判断是否截断），而不是整张 5050 行
    const parsed = lastParsedWorkbook().Sheets.S;
    expect(parsed[`A${MAX_XLSX_PREVIEW_ROWS + 1}`]).toBeDefined();
    expect(parsed[`A${MAX_XLSX_PREVIEW_ROWS + 2}`]).toBeUndefined();
    expect(parsed[`A${total}`]).toBeUndefined();
  });

  it("恰好等于行数上限：不截断、没有提示", async () => {
    const aoa = Array.from({ length: MAX_XLSX_PREVIEW_ROWS }, (_, i) => [`row-${i + 1}-end`]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), "S");
    const r = await readLocalFileForPreview(await writeXlsx("exact-rows.xlsx", wb));
    expect(r.html).toContain(`row-${MAX_XLSX_PREVIEW_ROWS}-end`);
    expect(r.html).not.toContain("表格过大");
  });

  it("超过列数上限的 xlsx：多出的列被截断并带提示", async () => {
    const cols = MAX_XLSX_PREVIEW_COLS + 20;
    const row = Array.from({ length: cols }, (_, i) => `col-${i + 1}-end`);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([row]), "S");
    const r = await readLocalFileForPreview(await writeXlsx("many-cols.xlsx", wb));

    expect(r.html).toContain(`col-${MAX_XLSX_PREVIEW_COLS}-end`);
    expect(r.html).not.toContain(`col-${MAX_XLSX_PREVIEW_COLS + 1}-end`);
    expect(r.html).toContain(`仅显示前 ${MAX_XLSX_PREVIEW_COLS} 列`);
  });

  it("输出经过净化：SheetJS 原始输出里的 javascript: 链接 / 属性里的 <img onerror> 不会进 API 响应", async () => {
    const ws = XLSX.utils.aoa_to_sheet([
      ["点我", "<img src=x onerror=alert(1)>"],
      ["正常", "内容"],
    ]);
    ws.A1.l = { Target: "javascript:alert(1)" };
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "S");
    const file = await writeXlsx("xss.xlsx", wb);

    // 对照：不净化时 SheetJS 的原始输出仍带 javascript: 链接（净化器依旧必要）；
    // data-v 属性值自 0.20.2 起已被 SheetJS 自己转义（旧版 0.18.5 是未转义的 <img onerror>），
    // 这里锁住新行为：若升级回退 / 库行为变回未转义，这条会红
    const rawWb = XLSX.read(await fs.readFile(file), { type: "buffer" });
    const raw = XLSX.utils.sheet_to_html(rawWb.Sheets.S);
    expect(raw).toContain('href="javascript:alert(1)"');
    expect(raw).toContain('data-v="&lt;img src=x onerror=alert(1)&gt;"');
    expect(raw).not.toContain('data-v="<img');

    const r = await readLocalFileForPreview(file);
    expect(r.html).toContain("点我");
    expect(r.html).toContain("内容");
    expect(r.html).not.toMatch(/javascript:/i);
    expect(r.html).not.toMatch(/<img/i);
    expect(r.html).not.toMatch(/data-v/i);
    expect(r.html).not.toMatch(/<script/i);
  });

  it("xlsx zip bomb（声明解压后 60MB 的条目）在解析前被拒绝", async () => {
    const zip = buildZip([
      { name: "[Content_Types].xml", data: Buffer.from("<Types/>") },
      { name: "xl/worksheets/sheet1.xml", data: Buffer.alloc(60 * MB), deflate: true },
    ]);
    expect(zip.length).toBeLessThan(1 * MB);
    const file = await writeFile("bomb.xlsx", zip);
    vi.mocked(XLSX.read).mockClear();
    await expect(readLocalFileForPreview(file)).rejects.toThrow(/压缩炸弹/);
    expect(XLSX.read).not.toHaveBeenCalled(); // 守卫先于解析器，解析器根本没被喂这个文件
  }, BIG_ZIP_TEST_MS);

  it("旧版 .xls（CFB 而非 zip）：跳过 zip 守卫，仍可被解析器读出并预览", async () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["旧版表头"], ["旧版内容"]]), "Legacy");
    const buf = XLSX.write(wb, { type: "buffer", bookType: "biff8" }) as Buffer;
    expect(buf.subarray(0, 4).toString("hex")).toBe("d0cf11e0"); // CFB 魔数，确认真的不是 zip
    const r = await readLocalFileForPreview(await writeFile("legacy.xls", buf));
    expect(r.kind).toBe("xlsx");
    expect(r.html).toContain("旧版表头");
    expect(r.html).toContain("旧版内容");
  });
});

// ───────────────────────── xlsx 恶意构造输入（CVE 回归） ─────────────────────────

const OOXML_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/**
 * 最小可解析的 xlsx：1 个 sheet（A1="hello"）+ 1 条批注，批注挂载的单元格地址 `commentRef` 由调用方指定。
 * 全部是真实 OOXML 部件、手工拼 zip，不依赖任何 xlsx 库的写入能力（库写不出非法地址）。
 */
const xlsxWithComment = (commentRef: string, commentText: string): Buffer => {
  const xml = (body: string): Buffer => Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>${body}`);
  const rels = (type: string, target: string): Buffer =>
    xml(
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="${OOXML_REL}/${type}" Target="${target}"/></Relationships>`,
    );
  const SS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
  const CT = "application/vnd.openxmlformats-officedocument.spreadsheetml";
  return buildZip([
    {
      name: "[Content_Types].xml",
      data: xml(
        `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
          `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
          `<Default Extension="xml" ContentType="application/xml"/>` +
          `<Override PartName="/xl/workbook.xml" ContentType="${CT}.sheet.main+xml"/>` +
          `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="${CT}.worksheet+xml"/>` +
          `<Override PartName="/xl/comments1.xml" ContentType="${CT}.comments+xml"/></Types>`,
      ),
    },
    { name: "_rels/.rels", data: rels("officeDocument", "xl/workbook.xml") },
    {
      name: "xl/workbook.xml",
      data: xml(
        `<workbook xmlns="${SS}" xmlns:r="${OOXML_REL}"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      ),
    },
    { name: "xl/_rels/workbook.xml.rels", data: rels("worksheet", "worksheets/sheet1.xml") },
    {
      name: "xl/worksheets/sheet1.xml",
      data: xml(
        `<worksheet xmlns="${SS}"><dimension ref="A1"/><sheetData><row r="1">` +
          `<c r="A1" t="inlineStr"><is><t>hello</t></is></c></row></sheetData></worksheet>`,
      ),
    },
    { name: "xl/worksheets/_rels/sheet1.xml.rels", data: rels("comments", "../comments1.xml") },
    {
      name: "xl/comments1.xml",
      data: xml(
        `<comments xmlns="${SS}"><authors><author>a</author></authors><commentList>` +
          `<comment ref="${commentRef}" authorId="0"><text><t>${commentText}</t></text></comment></commentList></comments>`,
      ),
    },
  ]);
};

/** Object.prototype 上是否被塞进了 `c`（SheetJS 往批注所属单元格上写的属性名） */
const prototypeHasC = (): boolean => Object.prototype.hasOwnProperty.call(Object.prototype, "c");

describe("xlsx 恶意构造输入（CVE-2023-30533 原型污染回归）", () => {
  // 漏洞原理：xl/comments*.xml 里 <comment ref="__proto__">，旧版（< 0.19.3）直接 sheet[ref] 取单元格，
  // 取到的是 Object.prototype，随后往上写 c = [...] —— 全进程的 {} 都多了一个 `c` 数组。
  // 0.19.3 起校验批注地址（"XLSX Ensure comment address is valid"）。
  // 实测：同一个文件在 xlsx 0.18.5 下 ({}).c 被污染（含 flowship 的收窄读取选项），0.20.3 不会。
  afterEach(() => {
    // 万一回退到有漏洞的版本，别让污染扩散到同一 worker 里的其它测试，红也只红这里
    Reflect.deleteProperty(Object.prototype, "c");
  });

  it("对照：批注地址合法（A1）时，构造的文件确实被解析、批注挂到 A1 上，且不污染原型", async () => {
    const buf = xlsxWithComment("A1", "normal-comment");
    // 直接解析（默认选项）证明这个手工 xlsx 是有效的、批注路径真的被走到——否则下面的「不污染」是空转
    const wb = XLSX.read(buf, { type: "buffer" });
    expect(wb.Sheets.Sheet1.A1.v).toBe("hello");
    expect(wb.Sheets.Sheet1.A1.c?.[0]?.t).toBe("normal-comment");
    expect(prototypeHasC()).toBe(false);

    const r = await readLocalFileForPreview(await writeFile("comment-a1.xlsx", buf));
    expect(r.html).toContain("hello");
    expect(prototypeHasC()).toBe(false);
  });

  it("恶意批注地址 __proto__：flowship 预览路径解析后 Object.prototype 不被污染，预览照常可用", async () => {
    expect(prototypeHasC()).toBe(false); // 前置：环境干净
    const buf = xlsxWithComment("__proto__", "polluted-by-comment");
    const file = await writeFile("comment-proto.xlsx", buf);

    const r = await readLocalFileForPreview(file); // 走产品实际的读取选项
    expect(r.kind).toBe("xlsx");
    expect(r.html).toContain("hello");
    expect(prototypeHasC()).toBe(false);
    expect(({} as { c?: unknown }).c).toBeUndefined();

    // 默认选项同样不污染（防止「只在收窄选项下才安全」的假象）
    XLSX.read(buf, { type: "buffer" });
    expect(prototypeHasC()).toBe(false);
    expect(({} as { c?: unknown }).c).toBeUndefined();
  });
});

// ───────────────────────── 大小上限 ─────────────────────────

describe("docx / xlsx 大小上限", () => {
  it("assertOfficePreviewSize：上限内放行、超限抛带 MB 数的中文错误", () => {
    expect(() => assertOfficePreviewSize(MAX_OFFICE_PREVIEW_BYTES)).not.toThrow();
    expect(() => assertOfficePreviewSize(MAX_OFFICE_PREVIEW_BYTES + 1)).toThrow(/文件过大.*预览上限/);
  });

  it.each(["big.xlsx", "big.docx"])("%s 超限在读文件内容之前就被拒绝", async (name) => {
    const file = path.join(TMP, name);
    // 稀疏文件：只改 size、不真写 20MB
    const fh = await fs.open(file, "w");
    await fh.truncate(MAX_OFFICE_PREVIEW_BYTES + 1024);
    await fh.close();
    await expect(readLocalFileForPreview(file)).rejects.toThrow(/文件过大/);
  });
});
