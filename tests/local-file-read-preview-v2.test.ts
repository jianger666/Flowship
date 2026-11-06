/**
 * 预览读取 v2：csv / tsv 表格、日志尾部、换行 / BOM 归一、svg / pptx / 压缩包 / 多 sheet xlsx、
 * 无扩展名文件识别、内容层面的「能否编辑」判定。真实文件 + 真实 xlsx / zip，不 mock 解析层。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as XLSX from "xlsx";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { detectLocalFileKind, extOfPath } from "@/lib/local-file-kind";
import {
  MAX_ARCHIVE_PREVIEW_ENTRIES,
  MAX_CELL_CHARS,
  MAX_CSV_PREVIEW_COLS,
  MAX_CSV_PREVIEW_ROWS,
  MAX_DISPLAY_CHARS,
  MAX_LOG_DISPLAY_CHARS,
  MAX_READ_BYTES,
  MAX_XLSX_PREVIEW_ROWS,
  readLocalFileForPreview,
} from "@/lib/server/local-file-read";

import { buildPptx, buildZip } from "./helpers/zip-builder";

let TMP = "";

beforeAll(async () => {
  TMP = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "flowship-preview-v2-")));
});
afterAll(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
});

const put = async (name: string, data: string | Buffer): Promise<string> => {
  const p = path.join(TMP, name);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, data);
  return p;
};

describe("kind 识别（extOfPath）", () => {
  it("没有真扩展名的文件按文件名识别；目录名里的点不干扰", () => {
    expect(extOfPath("/a/b/.env")).toBe("env");
    expect(extOfPath("/a/b/.env.local")).toBe("env");
    expect(extOfPath("/a/b/Dockerfile")).toBe("dockerfile");
    expect(extOfPath("C:\\proj\\Makefile")).toBe("makefile");
    expect(extOfPath("/a.b/Dockerfile")).toBe("dockerfile");
    expect(extOfPath("/a/.gitignore")).toBe("txt");
    expect(extOfPath("/a/LICENSE")).toBe("txt");
    expect(extOfPath("/a/archive.tar.gz")).toBe("gz");
    expect(extOfPath("mp3")).toBe("mp3");
    expect(extOfPath(".ts")).toBe("ts");
    expect(extOfPath("/a/b/noext")).toBe("noext");
  });

  it("新增 kind：svg / csv / tsv / zip 家族；csv 不再是 code（不默认去 IDE）", () => {
    expect(detectLocalFileKind("x.svg")).toBe("svg");
    expect(detectLocalFileKind("x.csv")).toBe("csv");
    expect(detectLocalFileKind("x.TSV")).toBe("csv");
    for (const e of ["zip", "jar", "war", "apk", "whl", "vsix"]) expect(detectLocalFileKind(`a.${e}`), e).toBe("archive");
    // 其余压缩格式仍是 binary（不假装能预览）
    for (const e of ["tar", "gz", "tgz", "7z", "rar"]) expect(detectLocalFileKind(`a.${e}`), e).toBe("binary");
    expect(detectLocalFileKind("/p/.env")).toBe("text");
    expect(detectLocalFileKind("/p/Dockerfile")).toBe("code");
    expect(detectLocalFileKind("/p/Makefile")).toBe("code");
    // html 仍是 code：预览窗不自己渲染 HTML（点链接走系统浏览器）
    expect(detectLocalFileKind("a.html")).toBe("code");
  });
});

describe("csv / tsv", () => {
  it("csv：表格 + 源码文本 + 分隔符；BOM 不进第一个单元格", async () => {
    const f = await put("a.csv", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("名字,年龄\r\n张三,18\r\n李四,20\r\n")]));
    const r = await readLocalFileForPreview(f);
    expect(r.kind).toBe("csv");
    expect(r.previewable).toBe(true);
    expect(r.table).toMatchObject({
      rows: [["名字", "年龄"], ["张三", "18"], ["李四", "20"]],
      totalRows: 3,
      totalCols: 2,
      truncatedRows: false,
      truncatedCols: false,
      delimiter: ",",
    });
    expect(r.table!.rows[0]![0]).toBe("名字");
    expect(r).toMatchObject({ bom: true, eol: "crlf", truncated: false, contentEditBlockReason: null });
    expect(r.text).toBe("名字,年龄\n张三,18\n李四,20\n");
  });

  it("tsv 按制表符；分号分隔的 csv 自动识别", async () => {
    const tsv = await readLocalFileForPreview(await put("b.tsv", "a\tb\n1\t2\n"));
    expect(tsv.table).toMatchObject({ rows: [["a", "b"], ["1", "2"]], delimiter: "\t" });
    const semi = await readLocalFileForPreview(await put("c.csv", "a;b;c\n1;2;3\n4;5;6\n"));
    expect(semi.table!.delimiter).toBe(";");
    expect(semi.table!.rows[2]).toEqual(["4", "5", "6"]);
  });

  it("行数上限：超出的行不带回，给 totalRows 与截断标记", async () => {
    const n = MAX_CSV_PREVIEW_ROWS + 25;
    const lines = Array.from({ length: n }, (_, i) => `r${i},v${i}`);
    const r = await readLocalFileForPreview(await put("big-rows.csv", lines.join("\n")));
    expect(r.table!.rows.length).toBe(MAX_CSV_PREVIEW_ROWS);
    expect(r.table!.totalRows).toBe(n);
    expect(r.table!.truncatedRows).toBe(true);
    // 源码文本只是展示用的前一段：整份文件没载入就不能编辑
    expect(r.truncated).toBe(true);
    expect(r.contentEditBlockReason).toMatch(/编辑/);
  });

  it("列数上限；超长单元格被截断", async () => {
    const wide = Array.from({ length: MAX_CSV_PREVIEW_COLS + 30 }, (_, i) => `c${i}`).join(",");
    const r = await readLocalFileForPreview(await put("wide.csv", `${wide}\n${"x".repeat(MAX_CELL_CHARS + 500)}\n`));
    expect(r.table!.rows[0]!.length).toBe(MAX_CSV_PREVIEW_COLS);
    expect(r.table!.truncatedCols).toBe(true);
    expect(r.table!.rows[1]![0]!.length).toBe(MAX_CELL_CHARS + 1); // 截断 + 省略号
    expect(r.table!.rows[1]![0]!.endsWith("…")).toBe(true);
  });

  it("文件很大（>5MB）：只读开头，最后半行被丢掉，标记截断", async () => {
    const line = "abcdefghij,1234567890\n";
    const f = await put("huge.csv", line.repeat(Math.ceil((5 * 1024 * 1024 + 4096) / line.length)));
    const r = await readLocalFileForPreview(f);
    expect(r.table!.truncatedRows).toBe(true);
    // 每一行都是完整的两列（没有被切断的半行）
    expect(r.table!.rows.every((row) => row.length === 2 && row[1] === "1234567890")).toBe(true);
  });

  it("空 csv：空表格而不是报错", async () => {
    const r = await readLocalFileForPreview(await put("empty.csv", ""));
    expect(r.table).toMatchObject({ rows: [], totalRows: 0 });
    expect(r.previewable).toBe(true);
  });
});

describe("文本：换行 / BOM / 编码 / 截断", () => {
  it("CRLF 归一成 LF 给前端，eol 记下来；BOM 剥掉记下来", async () => {
    const f = await put("crlf.ts", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("a\r\nb\r\n")]));
    const r = await readLocalFileForPreview(f);
    expect(r).toMatchObject({ kind: "code", text: "a\nb\n", eol: "crlf", bom: true, truncated: false, contentEditBlockReason: null });
    expect(r.tail).toBeUndefined();
  });

  it("换行混用 / GBK / 含 NUL：能预览，但内容层面不可编辑并说明原因", async () => {
    const mixed = await readLocalFileForPreview(await put("mixed.txt", "a\r\nb\nc"));
    expect(mixed).toMatchObject({ eol: "mixed", previewable: true });
    expect(mixed.contentEditBlockReason).toMatch(/换行/);
    const gbk = await readLocalFileForPreview(await put("gbk.txt", Buffer.from([0xc4, 0xe3, 0xba, 0xc3])));
    expect(gbk.contentEditBlockReason).toMatch(/UTF-8/);
    const nul = await readLocalFileForPreview(await put("nul.txt", Buffer.from([0x61, 0, 0x62])));
    expect(nul.contentEditBlockReason).toMatch(/二进制/);
  });

  it("超过编辑上限（256KB）但没超读取上限：整份可看、不可编辑", async () => {
    const r = await readLocalFileForPreview(await put("mid.ts", "x\n".repeat(150_000))); // ~300KB
    expect(r.size).toBeGreaterThan(256 * 1024);
    expect(r.contentEditBlockReason).toMatch(/256KB/);
  });

  it("大文本：展示上限从 5 万提到 20 万字符；超出才截断并禁止编辑", async () => {
    const ok = await readLocalFileForPreview(await put("fits.txt", "a".repeat(MAX_DISPLAY_CHARS)));
    expect(ok.text!.length).toBe(MAX_DISPLAY_CHARS);
    expect(ok.truncated).toBe(false);
    const over = await readLocalFileForPreview(await put("over.txt", "a".repeat(MAX_DISPLAY_CHARS + 10)));
    expect(over.text!.length).toBe(MAX_DISPLAY_CHARS);
    expect(over.truncated).toBe(true);
    expect(over.contentEditBlockReason).not.toBeNull();
  });

  it("json 的展示上限放到读取上限（树视图要完整文档）", async () => {
    const items = Array.from({ length: 12_000 }, (_, i) => ({ id: i, name: `item-${i}` }));
    const text = JSON.stringify(items);
    expect(text.length).toBeGreaterThan(MAX_DISPLAY_CHARS);
    expect(text.length).toBeLessThan(MAX_READ_BYTES);
    const r = await readLocalFileForPreview(await put("big.json", text));
    expect(r.truncated).toBe(false);
    expect(JSON.parse(r.text!)).toHaveLength(12_000);
  });

  it("多字节字符被读取上限切在半截：末尾不残留替换符", async () => {
    const f = await put("cut.txt", "你".repeat(MAX_READ_BYTES)); // 每个 3 字节，必然切在字符中间
    const r = await readLocalFileForPreview(f);
    expect(r.truncated).toBe(true);
    expect(r.text!.endsWith("\uFFFD")).toBe(false);
  });

  it("日志超过读取上限：看尾部，第一行（半截）被丢掉，最后一行完整", async () => {
    const lines = Array.from({ length: 40_000 }, (_, i) => `2026-11-06 10:00:00 INFO line-${String(i).padStart(6, "0")}`);
    const f = await put("app.log", `${lines.join("\n")}\n`);
    const r = await readLocalFileForPreview(f);
    expect(r.size).toBeGreaterThan(MAX_READ_BYTES);
    expect(r).toMatchObject({ tail: true, truncated: true });
    const shown = r.text!.split("\n");
    expect(shown[shown.length - 2]).toBe(lines[lines.length - 1]);
    // 每一行都是完整的一条日志，没有被切断的半行
    expect(shown.slice(0, -1).every((l) => /^2026-11-06 10:00:00 INFO line-\d{6}$/.test(l))).toBe(true);
    expect(r.text!.length).toBeLessThanOrEqual(MAX_LOG_DISPLAY_CHARS);
    expect(r.contentEditBlockReason).not.toBeNull();
  });

  it("小日志：完整内容，不标 tail", async () => {
    const r = await readLocalFileForPreview(await put("small.log", "INFO a\nERROR b\n"));
    expect(r.tail).toBeUndefined();
    expect(r.truncated).toBe(false);
    expect(r.text).toBe("INFO a\nERROR b\n");
  });

  it(".env / Dockerfile / Makefile 现在能预览了", async () => {
    const env = await readLocalFileForPreview(await put("proj/.env", "A=1\n"));
    expect(env).toMatchObject({ kind: "text", previewable: true, text: "A=1\n", ext: "env" });
    const docker = await readLocalFileForPreview(await put("proj2/Dockerfile", "FROM node\n"));
    expect(docker).toMatchObject({ kind: "code", previewable: true, ext: "dockerfile" });
    const make = await readLocalFileForPreview(await put("proj3/Makefile", "all:\n\techo\n"));
    expect(make).toMatchObject({ kind: "code", previewable: true });
  });

  it("svg：当文本读（预览里用 <img> 渲染 + 源码切换），不走 local-image（那里故意不放行 svg）", async () => {
    const r = await readLocalFileForPreview(await put("i.svg", '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>'));
    expect(r).toMatchObject({ kind: "svg", previewable: true });
    expect(r.text).toContain("<rect");
    expect(r.mediaPath).toBeUndefined();
  });

  it("html 不在应用内渲染：仍按源码读（链接点击走系统浏览器由 resolveLocalFileOpenTarget 决定）", async () => {
    const r = await readLocalFileForPreview(await put("page.html", "<h1>x</h1>"));
    expect(r.kind).toBe("code");
    expect(r.html).toBeUndefined();
  });

  it("返回 mtimeMs，与磁盘一致（保存时的冲突检测基准）", async () => {
    const f = await put("m.txt", "x");
    expect((await readLocalFileForPreview(f)).mtimeMs).toBe((await fs.stat(f)).mtimeMs);
  });
});

describe("压缩包", () => {
  it("zip 列目录：名字 / 声明大小 / 压缩大小 / 目录标记；不解压", async () => {
    const f = await put(
      "a.zip",
      buildZip([
        { name: "src/", data: "" },
        { name: "src/a.ts", data: "x".repeat(1000), deflate: true },
        { name: "README.md", data: "hello" },
      ]),
    );
    const r = await readLocalFileForPreview(f);
    expect(r).toMatchObject({ kind: "archive", previewable: true, entryCount: 3, entriesTruncated: false });
    expect(r.entries).toEqual([
      { name: "src/", size: 0, compressedSize: 0, isDir: true },
      expect.objectContaining({ name: "src/a.ts", size: 1000, isDir: false }),
      { name: "README.md", size: 5, compressedSize: 5, isDir: false },
    ]);
  });

  it("条目数超过展示上限：只带回前 N 个，给总数与截断标记", async () => {
    const n = MAX_ARCHIVE_PREVIEW_ENTRIES + 7;
    const files = Array.from({ length: n }, (_, i) => ({ name: `f${i}.txt`, data: "" }));
    const r = await readLocalFileForPreview(await put("many.zip", buildZip(files)));
    expect(r.entries!.length).toBe(MAX_ARCHIVE_PREVIEW_ENTRIES);
    expect(r).toMatchObject({ entryCount: n, entriesTruncated: true });
  });

  it("扩展名是 zip 但内容不是 zip：不崩，给原因", async () => {
    const r = await readLocalFileForPreview(await put("fake.zip", "this is plain text"));
    expect(r.previewable).toBe(false);
    expect(r.reason).toMatch(/不是有效的 zip/);
  });

  it("损坏的 zip（中央目录被截断）：抛可读错误（由 route 变成 500 提示），不是静默空列表", async () => {
    const good = buildZip([{ name: "a.txt", data: "x" }]);
    const f = await put("broken.zip", good.subarray(0, good.length - 8));
    await expect(readLocalFileForPreview(f)).rejects.toThrow();
  });
});

describe("pptx", () => {
  it("抽出文本大纲", async () => {
    const f = await put("deck.pptx", buildPptx([{ title: "封面", body: ["副标题"] }, { title: "目录", body: [["第一章", 0], ["第一节", 1]], notes: "备注" }]));
    const r = await readLocalFileForPreview(f);
    expect(r).toMatchObject({ kind: "pptx", previewable: true, slideCount: 2 });
    expect(r.slides!.map((s) => s.title)).toEqual(["封面", "目录"]);
    expect(r.slides![1]).toMatchObject({ notes: "备注", paragraphs: [{ text: "第一章", level: 0 }, { text: "第一节", level: 1 }] });
  });

  it("旧版 .ppt / 不是 zip 的 .pptx：不可预览，给具体原因", async () => {
    const ppt = await readLocalFileForPreview(await put("old.ppt", Buffer.from([0xd0, 0xcf, 0x11, 0xe0])));
    expect(ppt.previewable).toBe(false);
    expect(ppt.reason).toMatch(/\.ppt/);
    const fake = await readLocalFileForPreview(await put("fake.pptx", "not a zip"));
    expect(fake.previewable).toBe(false);
    expect(fake.reason).toMatch(/pptx/);
  });

  it("zip bomb 式的 pptx 在读条目之前被守卫拒绝", async () => {
    const bomb = buildZip([{ name: "ppt/slides/slide1.xml", data: Buffer.alloc(60 * 1024 * 1024), deflate: true }]);
    await expect(readLocalFileForPreview(await put("bomb.pptx", bomb))).rejects.toThrow(/炸弹|拒绝|上限/);
  }, 60_000);
});

describe("xlsx：多 sheet 与结构化表格", () => {
  const workbook = (): Buffer => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["首页列", "值"], ["只在首页", 1]]), "概览");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["明细列"], ["只在第二页"]]), "明细");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["第三页"]]), "附录");
    return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
  };

  it("默认首张：带 sheetNames / sheetIndex / table；html 仍在（read 层兼容旧用法），其它 sheet 内容不出现", async () => {
    const r = await readLocalFileForPreview(await put("multi.xlsx", workbook()));
    expect(r).toMatchObject({ kind: "xlsx", sheetNames: ["概览", "明细", "附录"], sheetIndex: 0 });
    expect(r.table!.rows).toEqual([["首页列", "值"], ["只在首页", "1"]]);
    expect(r.html).toContain("只在首页");
    expect(JSON.stringify(r)).not.toContain("只在第二页");
  });

  it("按序号取第 N 张：只解析并展示那一张", async () => {
    const f = await put("multi2.xlsx", workbook());
    const second = await readLocalFileForPreview(f, { sheet: 1 });
    expect(second).toMatchObject({ sheetIndex: 1, sheetNames: ["概览", "明细", "附录"] });
    expect(second.table!.rows).toEqual([["明细列"], ["只在第二页"]]);
    expect(JSON.stringify(second)).not.toContain("只在首页");
    const third = await readLocalFileForPreview(f, { sheet: 2 });
    expect(third.table!.rows).toEqual([["第三页"]]);
  });

  it("sheet 序号越界 → 抛错；负数 / 非整数按首张处理（route 层已校验过范围）", async () => {
    const f = await put("multi3.xlsx", workbook());
    await expect(readLocalFileForPreview(f, { sheet: 3 })).rejects.toThrow(/超出范围/);
    expect((await readLocalFileForPreview(f, { sheet: -1 })).sheetIndex).toBe(0);
    expect((await readLocalFileForPreview(f, { sheet: 1.5 })).sheetIndex).toBe(0);
  });

  it("行数超过上限：table 带截断标记，totalRows 是原始总数（不是被截后的）", async () => {
    const total = MAX_XLSX_PREVIEW_ROWS + 50;
    const aoa = Array.from({ length: total }, (_, i) => [`row-${i + 1}`]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), "S");
    const r = await readLocalFileForPreview(await put("rows.xlsx", XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer));
    expect(r.table!.rows.length).toBe(MAX_XLSX_PREVIEW_ROWS);
    expect(r.table).toMatchObject({ totalRows: total, truncatedRows: true });
    expect(r.table!.rows[MAX_XLSX_PREVIEW_ROWS - 1]![0]).toBe(`row-${MAX_XLSX_PREVIEW_ROWS}`);
  });

  it("空工作表：空 table，不崩", async () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([]), "Empty");
    const r = await readLocalFileForPreview(await put("empty.xlsx", XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer));
    expect(r.table).toMatchObject({ rows: [], totalRows: 0 });
  });

  it("单元格是格式化后的文本（日期 / 数字按显示值），公式只给缓存值", async () => {
    const ws: XLSX.WorkSheet = {
      A1: { t: "n", v: 1234.5, z: "#,##0.00" },
      A2: { t: "n", v: 3, f: "SUM(1,2)" },
      "!ref": "A1:A2",
    };
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "S");
    const r = await readLocalFileForPreview(await put("fmt.xlsx", XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer));
    expect(r.table!.rows.map((row) => row[0])).toEqual(["1,234.50", "3"]);
    expect(JSON.stringify(r.table)).not.toContain("SUM");
  });
});
