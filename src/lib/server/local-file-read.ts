/**
 * 读本地文件供预览 API 用（绝对路径 + realpath + 扩展名白名单 + 大小截断）
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import mammoth from "mammoth";
import * as XLSX from "xlsx";

import {
  detectLocalFileKind,
  extOfPath,
  extToShikiLang,
  type LocalFileKind,
} from "@/lib/local-file-kind";
import { detectDelimiter, parseDelimited } from "@/lib/preview/csv";
import { contentEditBlockReason, decodeTextBuffer } from "@/lib/preview/text-codec";
import type { LocalFilePreviewPayload, PreviewTable } from "@/lib/preview/types";
import { sanitizePreviewHtml } from "@/lib/preview-html-sanitize";
import {
  assertSafeOfficeZipDeep,
  listZipEntries,
  looksLikeZip,
  withSoftTimeout,
} from "@/lib/server/office-zip-guard";
import { MAX_EDIT_BYTES } from "@/lib/server/local-file-write";
import { extractPptxSlides } from "@/lib/server/pptx-extract";

/**
 * 文本类最多读 512KB；字符展示再截到 20 万（查看器按行虚拟化渲染，几千行不卡；
 * 以前 5 万是因为整段塞进一个 Markdown 代码块，DOM 与高亮都吃不消）。
 */
export const MAX_READ_BYTES = 512 * 1024;
export const MAX_DISPLAY_CHARS = 200_000;
/** 日志太大时看尾部：多展示一些（最近的才是要看的），仍受 512KB 读取上限约束 */
export const MAX_LOG_DISPLAY_CHARS = 400_000;
/** csv / tsv 解析的读取上限：表格是结构化展示，不受 MAX_DISPLAY_CHARS 约束 */
export const MAX_CSV_BYTES = 5 * 1024 * 1024;
/** csv 预览最多带回的行 / 列 */
export const MAX_CSV_PREVIEW_ROWS = 20_000;
export const MAX_CSV_PREVIEW_COLS = 200;
/** 单元格文本上限：超长单元格（整篇文章 / base64）截断展示，防响应体爆炸 */
export const MAX_CELL_CHARS = 2000;
/** 压缩包预览：整包读进内存列目录，上限不宜太大 */
export const MAX_ARCHIVE_PREVIEW_BYTES = 100 * 1024 * 1024;
/** 压缩包预览最多带回的条目数 */
export const MAX_ARCHIVE_PREVIEW_ENTRIES = 5000;
/** pptx 抽文本软超时 */
export const PPTX_EXTRACT_TIMEOUT_MS = 15_000;

/**
 * docx / xlsx 预览的文件大小上限（压缩包本身的大小）。
 * 解析发生在 server 进程内：xlsx（SheetJS）已升到 0.20.3（官方 CDN tarball，npm 上只有停更的 0.18.5），
 * 已修 CVE-2023-30533（原型污染）/ CVE-2024-22363（ReDoS），但解析器本身仍是同步 CPU 调用、无法中断，
 * mammoth 又会把内嵌图全转 base64 塞进 HTML——不设上限一个超大 / 恶意文件就能拖垮本机 server，
 * 所以大小上限 / zip 守卫 / 行列封顶仍是必要的纵深防御，不因升级而放宽。
 */
export const MAX_OFFICE_PREVIEW_BYTES = 20 * 1024 * 1024;

/** xlsx 预览最多渲染的行数（读 +1 行用来判断是否被截断）；超出的行丢弃并给提示 */
export const MAX_XLSX_PREVIEW_ROWS = 5000;
/** xlsx 预览最多渲染的列数 */
export const MAX_XLSX_PREVIEW_COLS = 200;
/**
 * docx 转换（mammoth）软超时。注意是「软」的：Promise.race 只能让 API 及时返回错误，
 * 无法中断 mammoth 内部仍在跑的解析（JS 没有可取消的异步任务），超时后它会继续占用资源直到跑完；
 * 真正的兜底是上面的文件大小上限 + zip bomb 守卫把输入规模先卡住。
 */
export const DOCX_CONVERT_TIMEOUT_MS = 15_000;

export const assertOfficePreviewSize = (size: number): void => {
  if (size > MAX_OFFICE_PREVIEW_BYTES) {
    const mb = (size / 1024 / 1024).toFixed(1);
    throw new Error(
      `文件过大（${mb}MB），超过 ${MAX_OFFICE_PREVIEW_BYTES / 1024 / 1024}MB 预览上限，请用系统应用打开`,
    );
  }
};

const assertAbsolute = (raw: string): void => {
  if (!path.isAbsolute(raw) && !/^[a-zA-Z]:[\\/]/.test(raw)) {
    throw new Error("path 必须是绝对路径");
  }
};

/**
 * 预览读取结果。比 API 响应多一个 server 内部字段 contentEditBlockReason：
 * 「内容层面」能不能安全编辑（路径是否在可编辑范围由 route 层再判一次，合成 editable / editBlockedReason）。
 */
export type ReadLocalFileResult = LocalFilePreviewPayload & {
  contentEditBlockReason?: string | null;
};

export interface ReadLocalFileOptions {
  /** xlsx：要看第几张 sheet（0 起）；其它类型忽略 */
  sheet?: number;
}

const clipCell = (v: unknown): string => {
  const s = v == null ? "" : String(v);
  return s.length > MAX_CELL_CHARS ? `${s.slice(0, MAX_CELL_CHARS)}…` : s;
};

const readTail = async (real: string, size: number, bytes: number): Promise<Buffer> => {
  const fd = await fs.open(real, "r");
  try {
    const buf = Buffer.alloc(bytes);
    await fd.read(buf, 0, bytes, size - bytes);
    return buf;
  } finally {
    await fd.close();
  }
};

const readHead = async (real: string, bytes: number): Promise<Buffer> => {
  const fd = await fs.open(real, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fd.read(buf, 0, bytes, 0);
    return bytesRead === bytes ? buf : buf.subarray(0, bytesRead);
  } finally {
    await fd.close();
  }
};

export const readLocalFileForPreview = async (
  rawPath: string,
  opts: ReadLocalFileOptions = {},
): Promise<ReadLocalFileResult> => {
  assertAbsolute(rawPath);
  const real = await fs.realpath(rawPath);
  const stat = await fs.stat(real);
  if (!stat.isFile()) throw new Error("不是文件");

  // extOfPath 比 path.extname 多认 `.env` / Dockerfile / Makefile 这类没有真扩展名的文件
  const ext = extOfPath(real);
  const kind = detectLocalFileKind(ext);
  const base: Omit<ReadLocalFileResult, "previewable"> = {
    kind,
    absolutePath: real,
    ext,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
  };

  if (kind === "image") {
    return {
      ...base,
      previewable: true,
      mediaPath: `/api/local-image?path=${encodeURIComponent(real)}`,
    };
  }

  if (kind === "pdf") {
    return {
      ...base,
      previewable: true,
      mediaPath: `/api/system/local-file-bytes?path=${encodeURIComponent(real)}`,
    };
  }

  if (kind === "docx") {
    assertOfficePreviewSize(stat.size);
    const buf = await fs.readFile(real);
    // 解析前先过 zip 守卫：中央目录声明值（廉价）+ 真实解压量校验（防谎报大小的 zip bomb，
    // mammoth 会把条目整个解到内存）。真实解压走异步 zlib、带输出上限，不阻塞事件循环
    await assertSafeOfficeZipDeep(buf, "docx");
    const { value: html } = await withSoftTimeout(
      mammoth.convertToHtml({ buffer: buf }),
      DOCX_CONVERT_TIMEOUT_MS,
      `docx 转换超时（>${DOCX_CONVERT_TIMEOUT_MS / 1000}s），文件可能过于复杂，请用系统应用打开`,
    );
    // mammoth 不做净化（官方文档明确）：必须白名单净化后才能给前端 dangerouslySetInnerHTML
    return { ...base, previewable: true, html: sanitizePreviewHtml(html) };
  }

  if (kind === "xlsx") {
    assertOfficePreviewSize(stat.size);
    const buf = await fs.readFile(real);
    // 旧版 .xls 是 CFB 而不是 zip：只有 zip 才需要中央目录检查（xlsx 库按魔数嗅探格式，口径一致）
    if (looksLikeZip(buf)) await assertSafeOfficeZipDeep(buf, "xlsx");
    // 一次只解析**一张** sheet（默认首张，翻页签时按 opts.sheet 再来一次）：
    // xlsx 已升 0.20.3（修了原型污染 / ReDoS 两个已知 CVE，回归见 tests/local-file-read-office.test.ts）。
    // 预览是只读展示，仍把解析面收到最小以防御未知的解析器漏洞——不解析公式（cellFormula:false）、
    // 只解析选中的 sheet（sheets:N，其它 sheet 既不解析也不展示）、不读样式 / VBA（cellStyles/bookVBA 显式关）、
    // 行数封顶（sheetRows，多读 1 行用来判断是否被截断）。
    // 局限：XLSX.read 是同步 CPU 调用，无法加超时 / 中断；防线是文件大小 + zip 守卫 + sheetRows 限规模。
    const wanted = Number.isInteger(opts.sheet) && opts.sheet! > 0 ? opts.sheet! : 0;
    const wb = XLSX.read(buf, {
      type: "buffer",
      cellFormula: false,
      cellStyles: false,
      bookVBA: false,
      sheets: wanted,
      sheetRows: MAX_XLSX_PREVIEW_ROWS + 1,
    });
    if (wanted >= wb.SheetNames.length && wanted > 0) throw new Error("sheet 序号超出范围");
    const first = wb.SheetNames[wanted];
    const sheet = first ? wb.Sheets[first] : undefined;
    let notice = "";
    let table: PreviewTable | undefined;
    if (sheet?.["!ref"]) {
      // 总行列数取 !fullref（sheetRows 截断前的原始范围）；没有就是没被截断，用 !ref
      const full = XLSX.utils.decode_range(sheet["!fullref"] ?? sheet["!ref"]);
      const totalRows = full.e.r - full.s.r + 1;
      const totalCols = full.e.c - full.s.c + 1;
      // 超出行 / 列上限的部分不渲染：直接收窄 !ref，sheet_to_html / sheet_to_json 都只按 !ref 输出
      const range = XLSX.utils.decode_range(sheet["!ref"]);
      const rowsCut = range.e.r >= MAX_XLSX_PREVIEW_ROWS;
      const colsCut = range.e.c >= MAX_XLSX_PREVIEW_COLS;
      if (rowsCut) range.e.r = MAX_XLSX_PREVIEW_ROWS - 1;
      if (colsCut) range.e.c = MAX_XLSX_PREVIEW_COLS - 1;
      if (rowsCut || colsCut) {
        sheet["!ref"] = XLSX.utils.encode_range(range);
        const parts = [
          rowsCut ? `前 ${MAX_XLSX_PREVIEW_ROWS} 行` : "",
          colsCut ? `前 ${MAX_XLSX_PREVIEW_COLS} 列` : "",
        ].filter(Boolean);
        notice = `<p>（表格过大，仅显示${parts.join("、")}；完整内容请用系统应用打开）</p>`;
      }
      const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
        header: 1,
        raw: false,
        defval: "",
        blankrows: true,
      });
      table = {
        rows: matrix.map((r) => r.map(clipCell)),
        totalRows,
        totalCols,
        truncatedRows: totalRows > matrix.length,
        truncatedCols: totalCols > MAX_XLSX_PREVIEW_COLS,
      };
    }
    const rawHtml = sheet
      ? XLSX.utils.sheet_to_html(sheet, { id: "local-file-xlsx-preview" })
      : "<p>（空表格）</p>";
    return {
      ...base,
      kind: "xlsx",
      previewable: true,
      // notice 是固定的受信模板（只含数字），放在净化之后拼接
      html: notice + sanitizePreviewHtml(rawHtml),
      table: table ?? { rows: [], totalRows: 0, totalCols: 0, truncatedRows: false, truncatedCols: false },
      sheetNames: wb.SheetNames,
      sheetIndex: wanted,
    };
  }

  if (kind === "pptx") {
    if (ext === "ppt") {
      return {
        ...base,
        previewable: false,
        reason: "旧版 .ppt（二进制格式）暂不支持预览，请用系统应用打开，或另存为 .pptx",
      };
    }
    assertOfficePreviewSize(stat.size);
    const buf = await fs.readFile(real);
    if (!looksLikeZip(buf)) {
      return { ...base, previewable: false, reason: "文件不是有效的 pptx（不是 zip 容器）" };
    }
    // 与 docx / xlsx 同一套守卫：先挡 zip bomb，再读条目
    await assertSafeOfficeZipDeep(buf, "pptx");
    const { slides, slideCount } = await withSoftTimeout(
      extractPptxSlides(buf),
      PPTX_EXTRACT_TIMEOUT_MS,
      `pptx 解析超时（>${PPTX_EXTRACT_TIMEOUT_MS / 1000}s），文件可能过于复杂，请用系统应用打开`,
    );
    return { ...base, previewable: true, slides, slideCount };
  }

  if (kind === "archive") {
    if (stat.size > MAX_ARCHIVE_PREVIEW_BYTES) {
      return {
        ...base,
        previewable: false,
        reason: `压缩包过大（${(stat.size / 1024 / 1024).toFixed(0)}MB，超过 ${MAX_ARCHIVE_PREVIEW_BYTES / 1024 / 1024}MB），请用系统应用打开`,
      };
    }
    const buf = await fs.readFile(real);
    if (!looksLikeZip(buf)) {
      return { ...base, previewable: false, reason: "文件不是有效的 zip 压缩包" };
    }
    // 只列清单、不解压任何内容：不存在 zip bomb 风险，只做结构校验（中央目录解析与 Office 守卫同一份）
    const all = listZipEntries(buf, "压缩包");
    const entries = all.slice(0, MAX_ARCHIVE_PREVIEW_ENTRIES).map((e) => ({
      name: e.name,
      size: e.declaredSize,
      compressedSize: e.compressedSize,
      isDir: e.name.endsWith("/"),
    }));
    return {
      ...base,
      previewable: true,
      entries,
      entryCount: all.length,
      entriesTruncated: all.length > entries.length,
    };
  }

  if (kind === "csv") {
    const truncatedBytes = stat.size > MAX_CSV_BYTES;
    const buf = truncatedBytes ? await readHead(real, MAX_CSV_BYTES) : await fs.readFile(real);
    const decoded = decodeTextBuffer(buf);
    // 读截断时最后一行可能只有半截：丢到最后一个换行为止，别把半行当一条记录
    let fullText = decoded.text;
    if (truncatedBytes) {
      const nl = fullText.lastIndexOf("\n");
      if (nl > 0) fullText = fullText.slice(0, nl);
    }
    const delimiter = detectDelimiter(fullText, ext);
    const parsed = parseDelimited(fullText, delimiter, {
      maxRows: MAX_CSV_PREVIEW_ROWS,
      maxCols: MAX_CSV_PREVIEW_COLS,
    });
    const table: PreviewTable = {
      rows: parsed.rows.map((r) => r.map(clipCell)),
      totalRows: parsed.totalRows,
      totalCols: parsed.totalCols,
      truncatedRows: parsed.truncatedRows || truncatedBytes,
      truncatedCols: parsed.truncatedCols,
      delimiter,
    };
    // 「源码」页签：与其它文本一样截到展示上限；编辑只在整份文件都载入时才开放
    let text = decoded.text;
    let truncated = truncatedBytes;
    if (text.length > MAX_DISPLAY_CHARS) {
      text = text.slice(0, MAX_DISPLAY_CHARS);
      truncated = true;
    }
    return {
      ...base,
      previewable: true,
      text,
      truncated,
      eol: decoded.eol,
      bom: decoded.bom,
      table,
      contentEditBlockReason: editBlockForContent(decoded, stat.size, truncated),
    };
  }

  if (kind === "markdown" || kind === "code" || kind === "text" || kind === "svg") {
    const isLog = ext === "log";
    let truncated = false;
    let tail = false;
    let buf: Buffer;
    if (stat.size > MAX_READ_BYTES) {
      truncated = true;
      // 日志看尾部（最新的在后面）；其它文件看开头
      if (isLog) {
        buf = await readTail(real, stat.size, MAX_READ_BYTES);
        tail = true;
      } else {
        buf = await readHead(real, MAX_READ_BYTES);
      }
    } else {
      buf = await fs.readFile(real);
    }
    const decoded = decodeTextBuffer(buf);
    let text = decoded.text;
    // 头部读取可能把末尾的多字节字符切断，解码出一个替换符
    if (truncated && !tail) text = text.replace(/\uFFFD$/, "");
    const cap = isLog ? MAX_LOG_DISPLAY_CHARS : ext === "json" ? MAX_READ_BYTES : MAX_DISPLAY_CHARS;
    if (text.length > cap) {
      text = tail ? text.slice(text.length - cap) : text.slice(0, cap);
      truncated = true;
    }
    if (tail) {
      // 尾部读取从任意位置开始（读取起点 / 字符数封顶都可能把第一行切断）：第一行多半是半截，丢掉
      const nl = text.indexOf("\n");
      if (nl >= 0 && nl < 4096) text = text.slice(nl + 1);
    }
    return {
      ...base,
      previewable: true,
      text,
      truncated,
      tail: tail || undefined,
      eol: decoded.eol,
      bom: decoded.bom,
      language: kind === "code" ? extToShikiLang(ext) : undefined,
      contentEditBlockReason: editBlockForContent(decoded, stat.size, truncated),
    };
  }

  // binary / unknown：不给假预览
  return { ...base, previewable: false };
};

/** 内容层面不可编辑的原因（路径范围由 route 层另判）；可编辑返回 null */
const editBlockForContent = (
  decoded: ReturnType<typeof decodeTextBuffer>,
  size: number,
  truncated: boolean,
): string | null => {
  if (truncated || size > MAX_EDIT_BYTES) {
    return `文件超过 ${MAX_EDIT_BYTES / 1024}KB，预览里不提供编辑，请用 IDE`;
  }
  return contentEditBlockReason(decoded);
};

export type { LocalFileKind };
