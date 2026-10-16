/**
 * office zip 守卫 × 真实解析器对拍（第四轮审查 M3-01 / M3-02）。
 *
 * 守卫的安全性只有一个前提：**守卫看到的条目集合 === 下游解析器看到的集合**。
 * 上一轮的测试全是手写 zip 只喂守卫，没有一个用例让真实解析器参与，
 * 所以守卫只按 EOCD 声明条数迭代、而 jszip 一路读到「连续的中央目录记录」尽头这种差异一直没被发现
 * （审查者：60KB zip 里藏 60MB 的 document.xml，EOCD 条数 5 改 3，两层守卫都放行、jszip 读到全部 5 条）。
 *
 * 这里每个畸形样例都让**真实**的 jszip（mammoth 用的）和 xlsx 0.20.3（CFB.read，即 XLSX.read 的第一步）
 * 去解析，断言：要么守卫拒绝，要么守卫看到的集合与每个「解析成功」的解析器一致。
 * 解析器自己抛错的样例不要求守卫拒绝（解析器不认就展开不了东西，误报最小）。
 * jszip 的 loadAsync 只读中央目录 + 本地头、不解压条目体；xlsx 的 CFB.read 会解压，
 * 所以样例里的条目都是几十字节的小数据，不会真展开炸弹（M3-01 的 60MB 样例只喂守卫和 jszip）。
 */
import { createRequire } from "node:module";
import zlib from "node:zlib";

import * as XLSX from "xlsx";
import { afterAll, describe, expect, it } from "vitest";

import {
  assertSafeOfficeZip,
  assertSafeOfficeZipDeep,
  listOfficeZipEntryNames,
} from "@/lib/server/office-zip-guard";

const MB = 1024 * 1024;

// ───────────────────────── 真实解析器 ─────────────────────────

interface JSZipInstance {
  file: (name: string, data: Buffer, opts?: { compression?: string }) => JSZipInstance;
  generateAsync: (o: {
    type: "nodebuffer";
    compression?: string;
    streamFiles?: boolean;
  }) => Promise<Buffer>;
}
interface JSZipStatic {
  new (): JSZipInstance;
  loadAsync: (
    data: Buffer,
  ) => Promise<{ files: Record<string, { _data?: { uncompressedSize?: number } }> }>;
}

// jszip 不是本项目的直接依赖（只是 mammoth 的依赖，pnpm 下根 node_modules 里没有），
// 从 mammoth 的真实位置解析，保证对拍的就是 mammoth 实际用的那份
const requireFromHere = createRequire(import.meta.url);
const JSZip = createRequire(requireFromHere.resolve("mammoth"))("jszip") as JSZipStatic;

/** 归一：去掉目录项（jszip 会自动补父目录）、排序，方便集合比较 */
const norm = (names: string[]): string[] => names.filter((n) => !n.endsWith("/")).sort();

const jszipView = async (buf: Buffer): Promise<string[] | Error> => {
  try {
    const zip = await JSZip.loadAsync(buf);
    return norm(Object.keys(zip.files));
  } catch (e) {
    return e as Error;
  }
};

/**
 * xlsx 的 CFB.read 就是 XLSX.read 解 zip 的第一步（parse_zip，会逐条目解压）。
 * 返回的 FullPaths 里带 SheetJS 自己的两个内部哨兵项（根 "" 和 "\u0001Sh33tJ5"），不是 zip 条目，滤掉
 */
const xlsxView = (buf: Buffer): string[] | Error => {
  try {
    const cfb = XLSX.CFB.read(buf, { type: "buffer" }) as { FullPaths: string[] };
    return norm(
      cfb.FullPaths.map((p) => p.replace(/^Root Entry[/]/, "")).filter(
        (p) => p !== "" && p !== "\u0001Sh33tJ5",
      ),
    );
  } catch (e) {
    return e as Error;
  }
};

interface GuardView {
  /** 拒绝时的错误文案；放行为 null */
  rejected: string | null;
  /** 放行时守卫看到的条目名；拒绝为 null */
  names: string[] | null;
}

const guardView = async (buf: Buffer): Promise<GuardView> => {
  try {
    await assertSafeOfficeZipDeep(buf, "docx");
  } catch (e) {
    return { rejected: (e as Error).message, names: null };
  }
  return { rejected: null, names: norm(listOfficeZipEntryNames(buf)) };
};

// ───────────────────────── 诊断：PARITY_TABLE=1 时结束打印「三方各自看到的集合」 ─────────────────────────
// 换 jszip / xlsx 版本、或新增样例时，肉眼复核「谁看到了什么」比读断言快得多。
// 用法：PARITY_TABLE=1 pnpm exec vitest run tests/office-zip-guard-parser-parity.test.ts
// 平时不设这个变量就什么都不打印，不影响门禁输出。
const TABLE: string[] = [];

const fmtParserView = (v: string[] | Error): string =>
  v instanceof Error ? `抛错(${v.message.slice(0, 36)}…)` : `[${v.join(",")}]`;

const recordRow = (
  id: string,
  jszip: string[] | Error,
  xlsx: string[] | Error,
  guard: GuardView,
): void => {
  const g =
    guard.rejected !== null
      ? `拒绝(${guard.rejected.slice(0, 30)}…)`
      : `放行[${(guard.names ?? []).join(",")}]`;
  const pad = " ".repeat(34);
  TABLE.push(
    `${id.padEnd(34)} | 守卫 ${g}\n${pad} | jszip ${fmtParserView(jszip)}\n${pad} | xlsx  ${fmtParserView(xlsx)}`,
  );
};

afterAll(() => {
  if (process.env.PARITY_TABLE) console.info(`\n${TABLE.join("\n")}\n`);
});

// ───────────────────────── zip 构造器（可精确摆放各个区块） ─────────────────────────

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

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_Z64_EOCD = 0x06064b50;
const SIG_Z64_LOCATOR = 0x07064b50;
/** EOCD 签名 PK\x05\x06 的字节形式（数文件里有几个签名用） */
const EOCD_SIG = Buffer.from([0x50, 0x4b, 0x05, 0x06]);

interface RawEntry {
  name: string;
  data: Buffer;
  /** 用 deflate 压缩（默认 store） */
  deflate?: boolean;
  /** 直接给定压缩体与声明的解压后大小（炸弹样例：data 只用来算 crc，传空 Buffer） */
  lie?: { body: Buffer; size: number };
  /** 中央目录里用 zip64 扩展字段声明解压后大小（该字段填 0xFFFFFFFF） */
  zip64Size?: boolean;
  /** 本地头 / 中央目录里写的压缩后大小（默认 = 数据区实际长度；谎报成 0 就是「空 deflate 条目」） */
  csizeField?: number;
}

interface Prepared {
  name: Buffer;
  body: Buffer;
  method: number;
  crc: number;
  size: number;
  /** 写进本地头 / 中央目录的压缩后大小字段 */
  csize: number;
  zip64Size: boolean;
}

const prepare = (e: RawEntry): Prepared => {
  const body = e.lie?.body ?? (e.deflate ? zlib.deflateRawSync(e.data, { level: 9 }) : e.data);
  return {
    name: Buffer.from(e.name),
    body,
    method: e.lie || e.deflate ? 8 : 0,
    crc: crc32(e.data),
    size: e.lie?.size ?? e.data.length,
    csize: e.csizeField ?? body.length,
    zip64Size: e.zip64Size ?? false,
  };
};

const localRecord = (p: Prepared): Buffer => {
  const lh = Buffer.alloc(30);
  lh.writeUInt32LE(SIG_LOCAL, 0);
  lh.writeUInt16LE(20, 4);
  lh.writeUInt16LE(p.method, 8);
  lh.writeUInt32LE(p.crc, 14);
  lh.writeUInt32LE(p.csize, 18);
  lh.writeUInt32LE(p.size, 22);
  lh.writeUInt16LE(p.name.length, 26);
  return Buffer.concat([lh, p.name, p.body]);
};

const centralRecord = (p: Prepared, localOffset: number): Buffer => {
  let extra = Buffer.alloc(0);
  if (p.zip64Size) {
    extra = Buffer.alloc(12);
    extra.writeUInt16LE(0x0001, 0);
    extra.writeUInt16LE(8, 2);
    extra.writeBigUInt64LE(BigInt(p.size), 4);
  }
  const ch = Buffer.alloc(46);
  ch.writeUInt32LE(SIG_CENTRAL, 0);
  ch.writeUInt16LE(20, 4);
  ch.writeUInt16LE(20, 6);
  ch.writeUInt16LE(p.method, 10);
  ch.writeUInt32LE(p.crc, 16);
  ch.writeUInt32LE(p.csize, 20);
  ch.writeUInt32LE(p.zip64Size ? 0xffffffff : p.size, 24);
  ch.writeUInt16LE(p.name.length, 28);
  ch.writeUInt16LE(extra.length, 30);
  ch.writeUInt32LE(localOffset, 42);
  return Buffer.concat([ch, p.name, extra]);
};

interface EocdOptions {
  count: number;
  /** 本盘条目数（默认 = count） */
  thisDisk?: number;
  cdSize: number;
  cdOffset: number;
  diskNumber?: number;
  comment?: Buffer;
  /** 谎报 comment 长度字段（默认 = comment 实际长度） */
  commentLenField?: number;
}

const eocdRecord = (o: EocdOptions): Buffer => {
  const comment = o.comment ?? Buffer.alloc(0);
  const b = Buffer.alloc(22);
  b.writeUInt32LE(SIG_EOCD, 0);
  b.writeUInt16LE(o.diskNumber ?? 0, 4);
  b.writeUInt16LE(o.thisDisk ?? o.count, 8);
  b.writeUInt16LE(o.count, 10);
  b.writeUInt32LE(o.cdSize, 12);
  b.writeUInt32LE(o.cdOffset, 16);
  b.writeUInt16LE(o.commentLenField ?? comment.length, 20);
  return Buffer.concat([b, comment]);
};

const zip64EocdRecord = (o: { count: number; cdSize: number; cdOffset: number }): Buffer => {
  const b = Buffer.alloc(56);
  b.writeUInt32LE(SIG_Z64_EOCD, 0);
  b.writeBigUInt64LE(44n, 4); // 本记录除前 12 字节外的长度
  b.writeUInt16LE(45, 12);
  b.writeUInt16LE(45, 14);
  b.writeBigUInt64LE(BigInt(o.count), 24);
  b.writeBigUInt64LE(BigInt(o.count), 32);
  b.writeBigUInt64LE(BigInt(o.cdSize), 40);
  b.writeBigUInt64LE(BigInt(o.cdOffset), 48);
  return b;
};

const zip64LocatorRecord = (z64Offset: number): Buffer => {
  const b = Buffer.alloc(20);
  b.writeUInt32LE(SIG_Z64_LOCATOR, 0);
  b.writeBigUInt64LE(BigInt(z64Offset), 8);
  b.writeUInt32LE(1, 16);
  return b;
};

/** 把一组条目依次排成本地头 + 数据，返回整段字节与各条目的本地头偏移 */
const layoutLocals = (ps: Prepared[]): { locals: Buffer; offsets: number[] } => {
  const parts: Buffer[] = [];
  const offsets: number[] = [];
  let at = 0;
  for (const p of ps) {
    offsets.push(at);
    const rec = localRecord(p);
    parts.push(rec);
    at += rec.length;
  }
  return { locals: Buffer.concat(parts), offsets };
};

/** 中央目录：可只取其中一部分条目，也可整体平移本地偏移（构造 jszip 的「平移」场景） */
const centralDir = (ps: Prepared[], offsets: number[], pick: number[], shift = 0): Buffer =>
  Buffer.concat(pick.map((i) => centralRecord(ps[i], offsets[i] - shift)));

/** 标准、规矩的 zip（local + 中央目录 + EOCD） */
const standardZip = (entries: RawEntry[], comment?: Buffer): Buffer => {
  const ps = entries.map(prepare);
  const { locals, offsets } = layoutLocals(ps);
  const cd = centralDir(
    ps,
    offsets,
    ps.map((_, i) => i),
  );
  return Buffer.concat([
    locals,
    cd,
    eocdRecord({ count: ps.length, cdSize: cd.length, cdOffset: locals.length, comment }),
  ]);
};

// ───────────────────────── 样例条目 ─────────────────────────

const xml = (s: string): Buffer => Buffer.from(`<?xml version="1.0"?><r>${s}</r>`);

/** 5 个条目，deflate / store 混合：M3-01 原型里 document.xml 排在第 4 位 */
const base5 = (): RawEntry[] => [
  { name: "[Content_Types].xml", data: xml("ct"), deflate: true },
  { name: "_rels/.rels", data: xml("rels"), deflate: true },
  { name: "word/styles.xml", data: xml("styles") },
  { name: "word/document.xml", data: xml("doc"), deflate: true },
  { name: "word/footer.xml", data: xml("footer") },
];

const A: RawEntry = { name: "a.xml", data: xml("a"), deflate: true };
const B: RawEntry = { name: "b.xml", data: xml("b") };
const C: RawEntry = { name: "c.xml", data: xml("c"), deflate: true };

// ───────────────────────── 畸形样例表 ─────────────────────────

interface Sample {
  id: string;
  desc: string;
  build: () => Buffer;
  /**
   * 旧守卫（只按 EOCD 声明条数迭代、不查中央目录收尾）会看到的集合。
   * 有它就表示「该样例确实有杀伤力」：下面的 hostile 解析器看到的集合必须与它不同，
   * 否则这个样例是空转的，起不到回归作用。
   */
  declared?: string[];
  /** 看到与 declared 不同集合的解析器（sanity：证明样例真的能让解析器与守卫错位） */
  hostile?: "jszip" | "xlsx";
  /** 守卫必须拒绝（结构上就是歧义，不论解析器是否认它） */
  mustReject?: boolean;
  /**
   * 守卫必须放行。核心断言保证了「放行时守卫集合 === 每个解析成功的解析器的集合」，
   * 所以这类样例是「看起来古怪、但三方读到的是同一份」，拒绝它们只会误杀。
   */
  mustPass?: boolean;
}

const names = (...es: RawEntry[]): string[] => norm(es.map((e) => e.name));

const SAMPLES: Sample[] = [
  {
    id: "declared-lt-actual",
    desc: "M3-01：EOCD 声明 3 条、中央目录里实际连续 5 条（cdSize 仍是 5 条总长）→ jszip 读到全部 5 条",
    build: () => {
      const ps = base5().map(prepare);
      const { locals, offsets } = layoutLocals(ps);
      const cd = centralDir(ps, offsets, [0, 1, 2, 3, 4]);
      return Buffer.concat([
        locals,
        cd,
        eocdRecord({ count: 3, cdSize: cd.length, cdOffset: locals.length }),
      ]);
    },
    declared: names(...base5().slice(0, 3)),
    hostile: "jszip",
    mustReject: true,
  },
  {
    id: "declared-gt-actual",
    desc: "EOCD 声明 5 条、中央目录里只有 3 条（cdSize = 3 条总长）→ jszip 只读 3 条，xlsx 把 EOCD 字节当第 4、5 条",
    build: () => {
      const ps = base5().map(prepare);
      const { locals, offsets } = layoutLocals(ps);
      const cd = centralDir(ps, offsets, [0, 1, 2]);
      return Buffer.concat([
        locals,
        cd,
        eocdRecord({ count: 5, cdSize: cd.length, cdOffset: locals.length }),
      ]);
    },
    mustReject: true,
  },
  {
    id: "gap-shift",
    desc:
      "EOCD 与中央目录之间还有第二份同长中央目录：jszip 按「EOCD 位置 - cdOffset - cdSize」平移整个读取基准，" +
      "实际读第二份；守卫 / xlsx 读字面偏移处的第一份（A≠B）",
    build: () => {
      // junk 条目撑出足够长的本地区，保证 B 的本地偏移（要预减平移量）不会变成负数
      const junk: RawEntry = { name: "junk", data: Buffer.alloc(120, 0x41) };
      const mk = (name: string): RawEntry => ({ name, data: xml(name), deflate: true });
      const aaa = mk("aaa");
      const ddd = mk("ddd");
      const bbb = mk("bbb");
      const ccc = mk("ccc");
      const ps = [junk, aaa, ddd, bbb, ccc].map(prepare);
      const { locals, offsets } = layoutLocals(ps);
      const cdA = centralDir(ps, offsets, [1, 2]);
      const shift = cdA.length; // jszip 的平移量 = 第二份中央目录的长度（两份同长）
      const cdB = centralDir(ps, offsets, [3, 4], shift);
      expect(cdB.length).toBe(cdA.length);
      return Buffer.concat([
        locals,
        cdA,
        cdB,
        eocdRecord({ count: 2, cdSize: cdA.length, cdOffset: locals.length }),
      ]);
    },
    declared: ["aaa", "ddd"],
    hostile: "jszip",
    mustReject: true,
  },
  {
    id: "prepended-garbage",
    desc: "前置 37 字节垃圾（crx 风格）：jszip 自动平移全部偏移、能读全；xlsx 按字面偏移读到错位数据",
    build: () => Buffer.concat([Buffer.alloc(37, 0x41), standardZip(base5())]),
    mustReject: true,
  },
  {
    id: "trailing-garbage",
    desc: "EOCD comment 长度 0、但文件末尾还有 13 字节尾随垃圾：两个解析器都能读，但 EOCD 与文件末尾对不上",
    build: () => Buffer.concat([standardZip(base5()), Buffer.alloc(13, 0x42)]),
    mustReject: true,
  },
  {
    id: "trailing-garbage-beyond-window",
    desc:
      "尾随 70000 字节垃圾（> EOCD 最大 comment 65535）：jszip / xlsx 都是整文件向前搜、仍能找到真 EOCD 读全；" +
      "守卫的搜索窗口只有 22 + 65535 字节，窗口内找不到签名就拒绝——窗口外的 EOCD 不能被放行",
    build: () => Buffer.concat([standardZip(base5()), Buffer.alloc(70_000, 0x42)]),
    mustReject: true,
  },
  {
    id: "extra-records-after-cd",
    desc:
      "中央目录声明的 3 条（cdSize 准确）之后、EOCD 之前还有 2 条**不同长度**的多余 PK\\x01\\x02 记录：" +
      "jszip 发现 EOCD 前多出字节、把读取基准平移后读到错位的目录；守卫 / xlsx 按字面读前 3 条。" +
      "「同长第二份目录」(gap-shift) 之外再补一个长度不同的，防止只对同长情形生效的特判",
    build: () => {
      const ps = base5().map(prepare);
      const { locals, offsets } = layoutLocals(ps);
      const cd3 = centralDir(ps, offsets, [0, 1, 2]);
      const extra = centralDir(ps, offsets, [3, 4]);
      expect(extra.length).not.toBe(cd3.length);
      return Buffer.concat([
        locals,
        cd3,
        extra,
        eocdRecord({ count: 3, cdSize: cd3.length, cdOffset: locals.length }),
      ]);
    },
    mustReject: true,
  },
  {
    id: "comment-len-too-big",
    desc: "EOCD 的 comment 长度字段 50、文件末尾实际没有 comment：jszip 越界抛错，xlsx 不读 comment",
    build: () => {
      const ps = base5().map(prepare);
      const { locals, offsets } = layoutLocals(ps);
      const cd = centralDir(ps, offsets, [0, 1, 2, 3, 4]);
      return Buffer.concat([
        locals,
        cd,
        eocdRecord({ count: 5, cdSize: cd.length, cdOffset: locals.length, commentLenField: 50 }),
      ]);
    },
    mustReject: true,
  },
  {
    id: "comment-len-too-small",
    desc: "EOCD 的 comment 长度字段 4、但 comment 实际 10 字节：多出的 6 字节是尾随数据",
    build: () => {
      const ps = base5().map(prepare);
      const { locals, offsets } = layoutLocals(ps);
      const cd = centralDir(ps, offsets, [0, 1, 2, 3, 4]);
      return Buffer.concat([
        locals,
        cd,
        eocdRecord({
          count: 5,
          cdSize: cd.length,
          cdOffset: locals.length,
          comment: Buffer.from("0123456789"),
          commentLenField: 4,
        }),
      ]);
    },
    mustReject: true,
  },
  {
    id: "comment-tail-partial-eocd",
    desc:
      "M3-02（搜索起点）：真 EOCD 的 comment 恰好是 20 字节「PK\\x05\\x06 + 条数 + 偏移」的残缺 EOCD（签名在文件末尾 -20 处）。" +
      "xlsx 从 length-4 往前找、选中它并按它的偏移读到 [a,b,c]；守卫旧版从 length-22 起找、选真 EOCD 读 [a,b]；" +
      "jszip 同样选中它但越界抛错",
    build: () => {
      const ps = [A, B, C].map(prepare);
      const { locals, offsets } = layoutLocals(ps);
      const cdFake = centralDir(ps, offsets, [0, 1, 2]);
      const cdReal = centralDir(ps, offsets, [0, 1]);
      const tail = Buffer.alloc(20);
      tail.writeUInt32LE(SIG_EOCD, 0);
      tail.writeUInt16LE(3, 8); // xlsx 读的「条目数」
      tail.writeUInt16LE(3, 10);
      tail.writeUInt32LE(cdFake.length, 12);
      tail.writeUInt32LE(locals.length, 16); // xlsx 读的「中央目录起点」= 第一份（含 c）
      return Buffer.concat([
        locals,
        cdFake,
        cdReal,
        eocdRecord({
          count: 2,
          cdSize: cdReal.length,
          cdOffset: locals.length + cdFake.length,
          comment: tail,
        }),
      ]);
    },
    declared: names(A, B),
    hostile: "xlsx",
    mustReject: true,
  },
  {
    id: "comment-embedded-full-eocd",
    desc:
      "真 EOCD 的 comment 里藏一个完整的 22 字节伪 EOCD（指向另一份中央目录）：三方都选最后一个签名（伪的），" +
      "但伪 EOCD 声明的目录没有紧贴它（中间隔着真目录和真 EOCD）→ 因「目录紧贴 EOCD」校验拒绝（F2-02 去掉「多签名」规则后仍成立）",
    build: () => {
      const ps = [A, B, C].map(prepare);
      const { locals, offsets } = layoutLocals(ps);
      const cdFake = centralDir(ps, offsets, [0, 1, 2]);
      const cdReal = centralDir(ps, offsets, [0, 1]);
      const fakeEocd = eocdRecord({ count: 3, cdSize: cdFake.length, cdOffset: locals.length });
      return Buffer.concat([
        locals,
        cdFake,
        cdReal,
        eocdRecord({
          count: 2,
          cdSize: cdReal.length,
          cdOffset: locals.length + cdFake.length,
          comment: fakeEocd,
        }),
      ]);
    },
    mustReject: true,
  },
  {
    id: "comment-embedded-eocd-with-own-cd",
    desc:
      "真 EOCD 的 comment 里藏一整份「伪中央目录 + 自洽的伪 EOCD」：三方都选最后一个签名（伪的），" +
      "伪 EOCD 自己结构完全合法（目录紧贴它、comment 对齐），jszip / xlsx / 守卫读到的是同一份 [a,b,c]。" +
      "F2-02 之前靠「窗口内不止一个 EOCD 签名」拒绝它；那条规则没有安全收益（见 findEocd 注释），去掉后改为必须放行且三方一致",
    build: () => {
      const ps = [A, B, C].map(prepare);
      const { locals, offsets } = layoutLocals(ps);
      const cdReal = centralDir(ps, offsets, [0, 1]);
      const cdFake = centralDir(ps, offsets, [0, 1, 2]);
      const commentStart = locals.length + cdReal.length + 22; // 真 EOCD（22 字节）之后
      const fakeEocd = eocdRecord({ count: 3, cdSize: cdFake.length, cdOffset: commentStart });
      return Buffer.concat([
        locals,
        cdReal,
        eocdRecord({
          count: 2,
          cdSize: cdReal.length,
          cdOffset: locals.length,
          comment: Buffer.concat([cdFake, fakeEocd]),
        }),
      ]);
    },
    mustPass: true,
  },
  {
    id: "zip64-hidden-in-cd-comment",
    desc:
      "EOCD 盘号 0xFFFF，但字面目录 [a,b] 紧贴 EOCD、结构完全自洽；zip64 记录 + 第二份目录 [a,b,c] 藏在最后一条中央目录记录的 " +
      "file comment 里（jszip 全文件搜 locator，找得到）。jszip 读 [a,b,c]，守卫 / xlsx 读 [a,b]——" +
      "「目录紧贴 EOCD」这类位置校验挡不住，只有对 EOCD zip64 占位本身拒绝才行",
    build: () => {
      const ps = [A, B, C].map(prepare);
      const { locals, offsets } = layoutLocals(ps);
      const recA = centralRecord(ps[0], offsets[0]);
      const recBBase = centralRecord(ps[1], offsets[1]);
      const cdB = centralDir(ps, offsets, [0, 1, 2]);
      const xStart = locals.length + recA.length + recBBase.length; // 藏起来的那份目录的绝对起点
      const z64At = xStart + cdB.length;
      const hidden = Buffer.concat([
        cdB,
        zip64EocdRecord({ count: 3, cdSize: cdB.length, cdOffset: xStart }),
        zip64LocatorRecord(z64At),
      ]);
      const recB = Buffer.concat([recBBase, hidden]);
      recB.writeUInt16LE(hidden.length, 32); // 中央目录记录的 file comment 长度
      const cdA = Buffer.concat([recA, recB]);
      return Buffer.concat([
        locals,
        cdA,
        eocdRecord({ count: 2, cdSize: cdA.length, cdOffset: locals.length, diskNumber: 0xffff }),
      ]);
    },
    declared: names(A, B),
    hostile: "jszip",
    mustReject: true,
  },
  {
    id: "zip64-disknumber-ffff",
    desc:
      "zip64 触发条件差异：EOCD 的盘号字段 0xFFFF（守卫旧版只看条数 / 大小 / 偏移，不认它）。" +
      "jszip 因此改读 zip64 记录指向的 [a,b,c]，守卫 / xlsx 读字面的 [a,b]",
    build: () => {
      const ps = [A, B, C].map(prepare);
      const { locals, offsets } = layoutLocals(ps);
      const cdA = centralDir(ps, offsets, [0, 1]);
      const cdB = centralDir(ps, offsets, [0, 1, 2]);
      const z64At = locals.length + cdA.length + cdB.length;
      return Buffer.concat([
        locals,
        cdA,
        cdB,
        zip64EocdRecord({ count: 3, cdSize: cdB.length, cdOffset: locals.length + cdA.length }),
        zip64LocatorRecord(z64At),
        eocdRecord({ count: 2, cdSize: cdA.length, cdOffset: locals.length, diskNumber: 0xffff }),
      ]);
    },
    declared: names(A, B),
    hostile: "jszip",
    mustReject: true,
  },
  {
    id: "zip64-cdsize-placeholder",
    desc:
      "zip64 在 xlsx 上的差异：EOCD 的 cdSize 填 0xFFFFFFFF 占位，真实值在 zip64 记录。" +
      "守卫旧版 / jszip 跟 zip64 记录读 [a,b,c]；xlsx 完全不读 zip64、按字面条数 / 偏移读 [a,b]",
    build: () => {
      const ps = [A, B, C].map(prepare);
      const { locals, offsets } = layoutLocals(ps);
      const cdA = centralDir(ps, offsets, [0, 1]);
      const cdB = centralDir(ps, offsets, [0, 1, 2]);
      const z64At = locals.length + cdA.length + cdB.length;
      return Buffer.concat([
        locals,
        cdA,
        cdB,
        zip64EocdRecord({ count: 3, cdSize: cdB.length, cdOffset: locals.length + cdA.length }),
        zip64LocatorRecord(z64At),
        eocdRecord({ count: 2, cdSize: 0xffffffff, cdOffset: locals.length }),
      ]);
    },
    declared: names(A, B, C),
    hostile: "xlsx",
    mustReject: true,
  },
  {
    id: "thisdisk-ne-total",
    desc: "「本盘条目数」≠「总条目数」（xlsx 迭代前者、守卫迭代后者）",
    build: () => {
      const ps = base5().map(prepare);
      const { locals, offsets } = layoutLocals(ps);
      const cd = centralDir(ps, offsets, [0, 1, 2, 3, 4]);
      return Buffer.concat([
        locals,
        cd,
        eocdRecord({ count: 5, thisDisk: 3, cdSize: cd.length, cdOffset: locals.length }),
      ]);
    },
    mustReject: true,
  },
];

describe("畸形 zip × 真实解析器对拍：守卫要么拒绝，要么看到的集合与解析器一致", () => {
  for (const s of SAMPLES) {
    it(`${s.id}：${s.desc}`, async () => {
      const buf = s.build();
      const [jszip, xlsx, guard] = [await jszipView(buf), xlsxView(buf), await guardView(buf)];
      recordRow(s.id, jszip, xlsx, guard);

      // sanity：样例确实能让解析器与「旧守卫看到的集合」错位，否则这条用例是空转的
      if (s.hostile && s.declared) {
        const seen = s.hostile === "jszip" ? jszip : xlsx;
        expect(seen, `${s.hostile} 应当能解析该样例`).not.toBeInstanceOf(Error);
        expect(seen as string[]).not.toEqual(norm(s.declared));
      }

      // 核心断言：守卫拒绝，或守卫集合 === 每个解析成功的解析器看到的集合
      if (guard.rejected === null) {
        for (const [parser, view] of [
          ["jszip", jszip],
          ["xlsx", xlsx],
        ] as const) {
          if (view instanceof Error) continue; // 解析器不认：展开不了东西，不要求守卫拒绝
          expect(view, `守卫放行了，但 ${parser} 看到的集合与守卫不同`).toEqual(guard.names);
        }
      }

      if (s.mustPass) {
        expect(guard.rejected, "该结构三方读到同一份集合，不应被误拒").toBeNull();
        // 同时钉住「三方都读到了东西」，避免解析器全抛错时上面的核心断言空转
        expect(jszip).not.toBeInstanceOf(Error);
        expect(xlsx).not.toBeInstanceOf(Error);
      }

      if (s.mustReject) {
        expect(guard.rejected, "该畸形结构必须被守卫拒绝").not.toBeNull();
        // 结构校验在两层守卫共用的中央目录遍历里：同步层同样必须拒绝
        expect(() => assertSafeOfficeZip(buf, "docx")).toThrow();
      }
    });
  }

  // F2-02：stored 的内嵌 zip（docx 里嵌入的 xlsx 图表数据等）会在主 zip 数据区里留下 EOCD 签名，
  // 且小文件里它必然落在末尾 22 + 65535 字节的搜索窗口内。三个解析器（守卫 / xlsx / jszip）都从文件末尾向前
  // 取「最后一个」签名，内嵌的那个排在真 EOCD 之前、谁也不会选它，所以「窗口内出现第二个签名就拒」没有安全收益，
  // 只会把合法文档误杀。真正的防线是下面各条：comment 长度对齐文件末尾 + 目录紧贴 EOCD + 条数正好填满目录。
  it("F2-02：stored 条目数据里内嵌了完整 zip（EOCD 签名在末尾窗口内、早于真 EOCD）：守卫必须放行，且三方集合一致", async () => {
    const inner = standardZip([A]);
    const buf = standardZip([
      ...base5(),
      { name: "word/embeddings/inner.zip", data: inner },
    ]);
    // 内嵌 zip 的 EOCD 签名确实在主 zip 的数据区里
    expect(buf.indexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))).toBeLessThan(buf.length - 22);
    const [jszip, xlsx, guard] = [await jszipView(buf), xlsxView(buf), await guardView(buf)];
    // 两个解析器都选最后一个 EOCD，能正常读全 6 个条目
    expect(jszip).toEqual(norm([...base5().map((e) => e.name), "word/embeddings/inner.zip"]));
    expect(xlsx).toEqual(jszip);
    expect(guard.rejected, "合法的、带 stored 内嵌 zip 的文档被误拒").toBeNull();
    expect(guard.names).toEqual(jszip);
    // 同一份字节按 xlsx 口径也不能误拒（xlsx 标签多一条空 deflate 的特殊规则，这里不涉及）
    await expect(assertSafeOfficeZipDeep(buf, "xlsx")).resolves.toBeUndefined();
  });

  it("F2-02：内嵌 zip 本身又内嵌 zip（窗口内有 3 个 EOCD 签名）：仍放行，三方集合一致", async () => {
    const innermost = standardZip([B]);
    const inner = standardZip([A, { name: "deeper.zip", data: innermost }]);
    const buf = standardZip([
      ...base5(),
      { name: "word/embeddings/inner.zip", data: inner },
    ]);
    let sigs = 0;
    for (let at = buf.indexOf(EOCD_SIG); at >= 0; at = buf.indexOf(EOCD_SIG, at + 1)) sigs++;
    expect(sigs).toBe(3);
    const [jszip, xlsx, guard] = [await jszipView(buf), xlsxView(buf), await guardView(buf)];
    expect(jszip).not.toBeInstanceOf(Error);
    expect(xlsx).toEqual(jszip);
    expect(guard.rejected).toBeNull();
    expect(guard.names).toEqual(jszip);
  });
});

// ───────────────────────── M3-01 原型：60MB document.xml 藏在 60KB 的 zip 里 ─────────────────────────

describe("M3-01 原型（审查者的 60KB zip 内含 60MB document.xml）", () => {
  const build = (declaredCount?: number): Buffer => {
    const body = zlib.deflateRawSync(Buffer.alloc(60 * MB), { level: 9 });
    const entries: RawEntry[] = [
      { name: "[Content_Types].xml", data: xml("ct"), deflate: true },
      { name: "_rels/.rels", data: xml("rels"), deflate: true },
      { name: "word/styles.xml", data: xml("styles"), deflate: true },
      // 第 4 个：声明 / 实际都是 60MB，压缩后只有几十 KB
      { name: "word/document.xml", data: Buffer.alloc(0), lie: { body, size: 60 * MB } },
      { name: "word/footer.xml", data: xml("footer"), deflate: true },
    ];
    const ps = entries.map(prepare);
    const { locals, offsets } = layoutLocals(ps);
    const cd = centralDir(ps, offsets, [0, 1, 2, 3, 4]);
    return Buffer.concat([
      locals,
      cd,
      eocdRecord({ count: declaredCount ?? 5, cdSize: cd.length, cdOffset: locals.length }),
    ]);
  };

  it("原样（EOCD 声明 5 条）：两层守卫都拒绝", async () => {
    const zip = build();
    expect(zip.length).toBeLessThan(200 * 1024);
    expect(() => assertSafeOfficeZip(zip, "docx")).toThrow(/压缩炸弹/);
    await expect(assertSafeOfficeZipDeep(zip, "docx")).rejects.toThrow(/压缩炸弹/);
  });

  it("把 EOCD 条数 5 改成 3：jszip 仍读到全部 5 条（含 60MB 的 document.xml），守卫必须拒绝", async () => {
    const zip = build(3);
    // 实证：真实 jszip 读到全部 5 条，且 document.xml 的声明大小就是 60MB
    const loaded = await JSZip.loadAsync(zip);
    expect(norm(Object.keys(loaded.files))).toEqual(
      norm(["[Content_Types].xml", "_rels/.rels", "word/styles.xml", "word/document.xml", "word/footer.xml"]),
    );
    expect(loaded.files["word/document.xml"]._data?.uncompressedSize).toBe(60 * MB);
    // 修复前：只看前 3 条，两层守卫都放行 → 60MB 被绕过
    expect(() => assertSafeOfficeZip(zip, "docx")).toThrow(/目录结构有歧义/);
    await expect(assertSafeOfficeZipDeep(zip, "docx")).rejects.toThrow(/目录结构有歧义/);
  });
});

// ───────────────────────── 合法文件：必须仍通过，且守卫与解析器看到同一集合 ─────────────────────────

interface LegitSample {
  id: string;
  build: () => Promise<Buffer> | Buffer;
}

const sheetJsXlsx = (compression: boolean): Buffer => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["a", "b"], [1, 2]]), "S");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx", compression }) as Buffer;
};

const docxLike = (): RawEntry[] => [
  {
    name: "[Content_Types].xml",
    data: Buffer.from(
      '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    ),
    deflate: true,
  },
  {
    name: "_rels/.rels",
    data: Buffer.from(
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    ),
    deflate: true,
  },
  {
    name: "word/document.xml",
    data: Buffer.from(
      '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>你好</w:t></w:r></w:p></w:body></w:document>',
    ),
    deflate: true,
  },
];

const LEGIT: LegitSample[] = [
  { id: "最小 docx（deflate）", build: () => standardZip(docxLike()) },
  { id: "SheetJS 写出的 xlsx（存储）", build: () => sheetJsXlsx(false) },
  { id: "SheetJS 写出的 xlsx（deflate）", build: () => sheetJsXlsx(true) },
  {
    id: "jszip 写出的 docx（DEFLATE）",
    build: async () => {
      const z = new JSZip();
      for (const e of docxLike()) z.file(e.name, e.data, { compression: "DEFLATE" });
      return z.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    },
  },
  {
    id: "jszip 写出的 docx（streamFiles：带 data descriptor，Office / Java 写入器常见形态）",
    build: async () => {
      const z = new JSZip();
      for (const e of docxLike()) z.file(e.name, e.data, { compression: "DEFLATE" });
      return z.generateAsync({ type: "nodebuffer", compression: "DEFLATE", streamFiles: true });
    },
  },
  {
    id: "带合法 comment 的 zip（comment 长度与文件末尾对齐、不含签名）",
    build: () => standardZip(docxLike(), Buffer.from("flowship legit zip comment")),
  },
  {
    // EOCD 签名恰好落在守卫搜索窗口的第一个字节（22 + 65535）：窗口若少算 1 字节，合法 zip 会被误拒
    id: "comment 长度 65535（EOCD 允许的最大值，签名在窗口第一个字节）",
    build: () => standardZip(docxLike(), Buffer.alloc(65_535, 0x61)),
  },
  { id: "空 zip（只有 EOCD）", build: () => standardZip([]) },
  {
    id: "含 zip64 扩展字段的小条目（条目级 zip64，不是 EOCD 级）",
    build: () => standardZip([{ name: "small", data: Buffer.from("hi"), zip64Size: true }]),
  },
  {
    id: "100 个条目",
    build: () =>
      standardZip(Array.from({ length: 100 }, (_, i) => ({ name: `f${i}.xml`, data: xml(`${i}`), deflate: i % 2 === 0 }))),
  },
];

describe("合法 docx / xlsx：同步 + 深度守卫都放行，且守卫集合 === 真实解析器集合", () => {
  for (const l of LEGIT) {
    it(l.id, async () => {
      const buf = await l.build();
      expect(() => assertSafeOfficeZip(buf, "docx")).not.toThrow();
      const guard = await guardView(buf);
      expect(guard.rejected, "合法文件不能被误报").toBeNull();

      const jszip = await jszipView(buf);
      const xlsx = xlsxView(buf);
      recordRow(`合法：${l.id.slice(0, 26)}`, jszip, xlsx, guard);
      expect(jszip, "jszip 应能解析合法样例").not.toBeInstanceOf(Error);
      expect(jszip).toEqual(guard.names);

      // xlsx 对「条目级 zip64 扩展字段」这类写法本身有自己的限制（读不了就抛错），不认不算守卫的问题
      if (!(xlsx instanceof Error)) expect(xlsx).toEqual(guard.names);
    });
  }
});

// ───────────────────────── xlsx 的 inflate 不是 zlib：「空 deflate 条目」不能靠例外溜进去 ─────────────────────────

describe("空 deflate 条目（压缩后 / 解压后都声明 0）：xlsx 路径拒绝、docx 路径放行", () => {
  // 为什么 xlsx 要拒绝：xlsx 0.20.3 默认用 SheetJS 自带的纯 JS inflate（Flowship 没调 use_zlib），
  // 且不看 compSize、从数据起点一路喂到文件末尾。zlib 在这段字节上失败 = 里面没有终止块，
  // 纯 JS 版此时越界读到 undefined 当 0 位、永远等不到 final 块，空转到 32 位位偏移回绕才停：
  // 实测 235 字节的 xlsx 让 XLSX.read 同步阻塞 1~3 秒，8 个这样的条目（907 字节）约 12 秒，条目数上限 1 万。
  // 所以这里**不把这些样本喂给 xlsx**（会让测试自己卡住），只断言守卫拒绝；docx（jszip）按 compSize=0 截出空数据，不受影响。
  const garbage = Buffer.from("this-is-not-a-deflate-stream-0123456789");
  // 合法 deflate 流只留开头 3 个字节：没有终止块
  const truncated = zlib.deflateRawSync(Buffer.alloc(4096), { level: 9 }).subarray(0, 3);

  const CASES: { id: string; body: Buffer }[] = [
    { id: "数据区一个字节都没有（写入器对空文件不写 deflate 数据）", body: Buffer.alloc(0) },
    { id: "数据区是不成流的垃圾字节（compSize 谎报成 0）", body: garbage },
    { id: "数据区是被截断、没有终止块的合法流开头（compSize 谎报成 0）", body: truncated },
  ];

  /** a / empty / c 三个条目：empty 的 compSize、uncompSize 都写 0，数据区放 body，其后紧跟 c 的本地头 */
  const buildEmptyDeflateZip = (body: Buffer): { buf: Buffer; dataStart: number } => {
    const ps = [
      { name: "a.xml", data: xml("a"), deflate: true },
      { name: "empty.xml", data: Buffer.alloc(0), lie: { body, size: 0 }, csizeField: 0 },
      { name: "c.xml", data: xml("c"), deflate: true },
    ].map(prepare);
    const { locals, offsets } = layoutLocals(ps);
    const cd = centralDir(ps, offsets, [0, 1, 2]);
    return {
      buf: Buffer.concat([
        locals,
        cd,
        eocdRecord({ count: 3, cdSize: cd.length, cdOffset: locals.length }),
      ]),
      dataStart: offsets[1] + 30 + ps[1].name.length,
    };
  };

  for (const c of CASES) {
    it(c.id, async () => {
      const { buf, dataStart } = buildEmptyDeflateZip(c.body);
      // 前提：zlib 在「数据起点 → 文件末尾」上确实失败——守卫靠它判断「里面没有终止块」，
      // 否则样本走不到空条目分支，下面的断言就是空转
      expect(() => zlib.inflateRawSync(buf.subarray(dataStart))).toThrow();

      await expect(assertSafeOfficeZipDeep(buf, "xlsx")).rejects.toThrow(/空 deflate 条目/);
      // docx：jszip 读到空内容，照旧放行（不误报；与既有「空 deflate 条目放行」用例同口径）
      await expect(assertSafeOfficeZipDeep(buf, "docx")).resolves.toBeUndefined();
      // 同步层只看声明值、不解压，没有「zlib 失败」的信息：两种 label 都不拒绝
      expect(() => assertSafeOfficeZip(buf, "xlsx")).not.toThrow();
      expect(() => assertSafeOfficeZip(buf, "docx")).not.toThrow();

      // docx 放行时守卫看到的集合必须等于 jszip（mammoth）看到的集合
      const guard = await guardView(buf);
      expect(guard.rejected).toBeNull();
      expect(await jszipView(buf)).toEqual(guard.names);
    });
  }
});

// ───────────────────────── EOCD zip64 占位：6 个字段逐个独立拒绝 ─────────────────────────

describe("EOCD zip64 占位值：jszip 的 6 个触发字段任一出现都必须被守卫拒绝", () => {
  // jszip.readEndOfCentral 的触发条件：盘号 / 目录起始盘 / 本盘条数 / 总条数 = 0xFFFF，或 目录大小 / 偏移 = 0xFFFFFFFF；
  // xlsx 的 parse_zip 完全不读 zip64 记录。同一个文件两个解析器必然各读各的，所以守卫一律拒绝。
  // 逐字段列出来，是为了「少检查其中任何一个字段」都能被测试抓到（整体变异只会抓到全删的情形）
  const FIELDS: { name: string; at: number; width: 2 | 4 }[] = [
    { name: "diskNumber", at: 4, width: 2 },
    { name: "diskWithCentralDirStart", at: 6, width: 2 },
    { name: "centralDirRecordsOnThisDisk", at: 8, width: 2 },
    { name: "centralDirRecords", at: 10, width: 2 },
    { name: "centralDirSize", at: 12, width: 4 },
    { name: "centralDirOffset", at: 16, width: 4 },
  ];

  for (const f of FIELDS) {
    it(`${f.name}（EOCD +${f.at}，${f.width} 字节）填占位值 → 守卫拒绝，且真实 jszip 确实把它当 zip64 触发`, async () => {
      const buf = Buffer.from(standardZip(base5()));
      const eocd = buf.length - 22; // 无 comment，EOCD 固定 22 字节
      if (f.width === 2) buf.writeUInt16LE(0xffff, eocd + f.at);
      else buf.writeUInt32LE(0xffffffff, eocd + f.at);

      // 实证 jszip：它因为这个字段去找 zip64 locator（文件里没有，所以抛 ZIP64 相关错误）
      const jszip = await jszipView(buf);
      expect(jszip, `jszip 应因 ${f.name} 触发 zip64 逻辑`).toBeInstanceOf(Error);
      expect((jszip as Error).message).toMatch(/ZIP64/);

      expect(() => assertSafeOfficeZip(buf, "docx")).toThrow(/zip64 占位/);
      await expect(assertSafeOfficeZipDeep(buf, "docx")).rejects.toThrow(/zip64 占位/);
    });
  }
});

// ───────────────────────── F2-01：本地头与中央目录的压缩方式不一致 ─────────────────────────

describe("F2-01：本地头与中央目录的压缩方式不一致（xlsx 看本地头、jszip 看中央目录）", () => {
  // 全部用无害的最小合成数据：4KB 的零字节，deflate 后只有十几个字节；目的只是证明「守卫会拒绝」，
  // 不构造任何真实膨胀的载荷。
  const PLAIN = Buffer.alloc(4096, 0);
  const BODY = zlib.deflateRawSync(PLAIN, { level: 9 });
  const NAME = "xl/sharedStrings.xml";

  interface Side {
    method: number;
    csize: number;
    usize: number;
  }
  interface MismatchSpec {
    central: Side;
    local: Side & {
      /** 本地头 flags（bit3 = 数据在后面带 data descriptor） */
      flags?: number;
      /** 数据区之后的 data descriptor 里写的大小（xlsx 在 flags&8 时读这里，而不是本地头里的 0） */
      descriptor?: { csize: number; usize: number };
    };
  }

  /** a.xml（规矩的 deflate 条目）+ 一个中央目录与本地头压缩方式对不上的条目，数据区放 BODY */
  const buildMismatch = (s: MismatchSpec): Buffer => {
    const a = prepare(A);
    const aLocal = localRecord(a);
    const base: Prepared = {
      name: Buffer.from(NAME),
      body: BODY,
      method: s.central.method,
      crc: crc32(PLAIN),
      size: s.central.usize,
      csize: s.central.csize,
      zip64Size: false,
    };
    const eLocal = Buffer.from(
      localRecord({ ...base, method: s.local.method, size: s.local.usize, csize: s.local.csize }),
    );
    if (s.local.flags) eLocal.writeUInt16LE(s.local.flags, 6);
    let descriptor = Buffer.alloc(0);
    if (s.local.descriptor) {
      descriptor = Buffer.alloc(16);
      descriptor.writeUInt32LE(0x08074b50, 0);
      descriptor.writeUInt32LE(base.crc, 4);
      descriptor.writeUInt32LE(s.local.descriptor.csize, 8);
      descriptor.writeUInt32LE(s.local.descriptor.usize, 12);
    }
    const locals = Buffer.concat([aLocal, eLocal, descriptor]);
    const cd = Buffer.concat([centralRecord(a, 0), centralRecord(base, aLocal.length)]);
    return Buffer.concat([
      locals,
      cd,
      eocdRecord({ count: 2, cdSize: cd.length, cdOffset: locals.length }),
    ]);
  };

  /** 真实 xlsx（CFB.read = XLSX.read 解 zip 的第一步）解出的某个条目内容 */
  const xlsxEntryContent = (buf: Buffer, name: string): Buffer | Error => {
    try {
      const cfb = XLSX.CFB.read(buf, { type: "buffer" }) as {
        FullPaths: string[];
        FileIndex: { content?: ArrayLike<number> }[];
      };
      const i = cfb.FullPaths.findIndex((p) => p.replace(/^Root Entry[/]/, "") === name);
      const content = i < 0 ? undefined : cfb.FileIndex[i].content;
      if (!content) return new Error(`xlsx 没读到条目 ${name}`);
      return Buffer.from(content as ArrayLike<number> as Uint8Array);
    } catch (e) {
      return e as Error;
    }
  };

  /** 真实 jszip（mammoth 用的）解出的某个条目内容 */
  const jszipEntryContent = async (buf: Buffer, name: string): Promise<Buffer | Error> => {
    try {
      const zip = (await JSZip.loadAsync(buf)) as unknown as {
        file: (n: string) => { async: (t: "nodebuffer") => Promise<Buffer> } | null;
      };
      const f = zip.file(name);
      return f ? await f.async("nodebuffer") : new Error(`jszip 没读到条目 ${name}`);
    } catch (e) {
      return e as Error;
    }
  };

  interface Case {
    id: string;
    desc: string;
    spec: MismatchSpec;
    /** 真实 xlsx 读出的内容必须与「中央目录描述的那份」不同——否则样例没有杀伤力、测试空转 */
    xlsxContentDiffersFromCentral: boolean;
    /** jszip 按中央目录读出的内容（拿不到时为 null：jszip 不认这个压缩方式） */
    jszipContent: Buffer | null;
  }

  const CASES: Case[] = [
    {
      id: "中央目录 stored、本地头 deflate + data descriptor 且本地 usize=0",
      desc:
        "守卫按中央目录走 stored 分支（只核对声明大小，不展开）；xlsx 按本地头 inflate、usize 提示为 0 时输出缓冲无上限增长，" +
        "声明大小对它没有任何约束——这是 F2-01 的绕过形态（此处只放 4KB 零字节）",
      spec: {
        central: { method: 0, csize: BODY.length, usize: BODY.length },
        local: {
          method: 8,
          csize: 0,
          usize: 0,
          flags: 0x0008,
          descriptor: { csize: BODY.length, usize: BODY.length },
        },
      },
      xlsxContentDiffersFromCentral: true,
      jszipContent: BODY,
    },
    {
      id: "中央目录 stored、本地头 deflate，本地大小字段与中央目录一致（无描述符）",
      desc: "xlsx 的两处大小校验都过，照样按本地头 inflate",
      spec: {
        central: { method: 0, csize: BODY.length, usize: BODY.length },
        local: { method: 8, csize: BODY.length, usize: BODY.length },
      },
      xlsxContentDiffersFromCentral: true,
      jszipContent: BODY,
    },
    {
      id: "中央目录 deflate、本地头 stored",
      desc: "反方向：守卫 inflate 出 4096 字节，xlsx 把数据区原样当内容——两边读到的内容不是同一份",
      spec: {
        central: { method: 8, csize: BODY.length, usize: PLAIN.length },
        local: { method: 0, csize: BODY.length, usize: PLAIN.length },
      },
      xlsxContentDiffersFromCentral: true,
      jszipContent: PLAIN,
    },
    {
      id: "中央目录是不认识的压缩方式（12）、本地头 deflate",
      desc: "守卫对不认识的方式「按声明值计入预算、不展开」，xlsx 照本地头 inflate",
      spec: {
        central: { method: 12, csize: BODY.length, usize: BODY.length },
        local: {
          method: 8,
          csize: 0,
          usize: 0,
          flags: 0x0008,
          descriptor: { csize: BODY.length, usize: BODY.length },
        },
      },
      xlsxContentDiffersFromCentral: true,
      jszipContent: null,
    },
  ];

  for (const c of CASES) {
    it(`${c.id}：xlsx 标签拒绝（歧义）`, async () => {
      const buf = buildMismatch(c.spec);

      // sanity：真实 xlsx 确实按「本地头」读，读出的内容与中央目录描述的不同（样例有杀伤力）
      const x = xlsxEntryContent(buf, NAME);
      expect(x, "xlsx 应能解析该样例").not.toBeInstanceOf(Error);
      if (c.xlsxContentDiffersFromCentral) {
        const central = c.spec.central.method === 8 ? PLAIN : BODY;
        expect(Buffer.compare(x as Buffer, central), "xlsx 读到的内容应与中央目录描述的不同").not.toBe(0);
      }
      if (c.spec.local.flags === 0x0008) {
        // 本地 usize=0 时 xlsx 的输出缓冲不受任何声明约束，实际展开成 4096 字节（声明里只有十几字节）
        expect((x as Buffer).length).toBe(PLAIN.length);
        expect(c.spec.central.usize).toBeLessThan(PLAIN.length);
      }

      // 同步层只看声明值，本来就放行；真解压层必须因压缩方式不一致拒绝
      expect(() => assertSafeOfficeZip(buf, "xlsx")).not.toThrow();
      await expect(assertSafeOfficeZipDeep(buf, "xlsx")).rejects.toThrow(/压缩方式/);
    });

    it(`${c.id}：docx 标签不受影响（jszip 只看中央目录），守卫放行且 jszip 读到的就是中央目录描述的内容`, async () => {
      const buf = buildMismatch(c.spec);
      await expect(assertSafeOfficeZipDeep(buf, "docx")).resolves.toBeUndefined();
      if (c.jszipContent) {
        const j = await jszipEntryContent(buf, NAME);
        expect(j, "jszip 应能解析该样例").not.toBeInstanceOf(Error);
        expect(Buffer.compare(j as Buffer, c.jszipContent)).toBe(0);
      }
    });
  }

  it("本地头 === 中央目录（最常见的合法写法）：xlsx 标签照常放行，不误杀", async () => {
    const plainDeflate = buildMismatch({
      central: { method: 8, csize: BODY.length, usize: PLAIN.length },
      local: { method: 8, csize: BODY.length, usize: PLAIN.length },
    });
    await expect(assertSafeOfficeZipDeep(plainDeflate, "xlsx")).resolves.toBeUndefined();

    // 流式写入器（Office / jszip streamFiles / Java）：本地头大小为 0、flags 带 bit3、数据后跟 descriptor
    const streamed = buildMismatch({
      central: { method: 8, csize: BODY.length, usize: PLAIN.length },
      local: {
        method: 8,
        csize: 0,
        usize: 0,
        flags: 0x0008,
        descriptor: { csize: BODY.length, usize: PLAIN.length },
      },
    });
    await expect(assertSafeOfficeZipDeep(streamed, "xlsx")).resolves.toBeUndefined();

    const stored = buildMismatch({
      central: { method: 0, csize: BODY.length, usize: BODY.length },
      local: { method: 0, csize: BODY.length, usize: BODY.length },
    });
    await expect(assertSafeOfficeZipDeep(stored, "xlsx")).resolves.toBeUndefined();
  });

  it("上面「合法文件」表里的全部样本按 xlsx 标签同样放行（真实写入器的本地头与中央目录压缩方式必然一致）", async () => {
    for (const l of LEGIT) {
      const buf = await l.build();
      await expect(assertSafeOfficeZipDeep(buf, "xlsx"), l.id).resolves.toBeUndefined();
    }
  });
});
