/**
 * 读本地文件供预览 API 用（绝对路径 + realpath + 扩展名白名单 + 大小截断）
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import mammoth from "mammoth";
import * as XLSX from "xlsx";

import {
  detectLocalFileKind,
  extToShikiLang,
  type LocalFileKind,
} from "@/lib/local-file-kind";
import { sanitizePreviewHtml } from "@/lib/preview-html-sanitize";
import {
  assertSafeOfficeZipDeep,
  looksLikeZip,
  withSoftTimeout,
} from "@/lib/server/office-zip-guard";

/** 文本类最多读 512KB；字符展示再截到 50k，防 Sheet 卡死 */
export const MAX_READ_BYTES = 512 * 1024;
export const MAX_DISPLAY_CHARS = 50_000;

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

export interface ReadLocalFileResult {
  kind: LocalFileKind;
  absolutePath: string;
  ext: string;
  size: number;
  /** 文本 / md / code */
  text?: string;
  truncated?: boolean;
  language?: string;
  /** docx / xlsx 转 HTML */
  html?: string;
  /** image / pdf 走独立 GET */
  mediaPath?: string;
  previewable: boolean;
}

export const readLocalFileForPreview = async (
  rawPath: string,
): Promise<ReadLocalFileResult> => {
  assertAbsolute(rawPath);
  const real = await fs.realpath(rawPath);
  const stat = await fs.stat(real);
  if (!stat.isFile()) throw new Error("不是文件");

  const ext = path.extname(real).slice(1).toLowerCase();
  const kind = detectLocalFileKind(ext);
  const base: Omit<ReadLocalFileResult, "previewable"> = {
    kind,
    absolutePath: real,
    ext,
    size: stat.size,
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
    // xlsx 已升 0.20.3（修了原型污染 / ReDoS 两个已知 CVE，回归见 tests/local-file-read-office.test.ts）。
    // 预览是只读展示，仍把解析面收到最小以防御未知的解析器漏洞——不解析公式（cellFormula:false）、
    // 只解析首个 sheet（sheets:0，下面也只渲染第一张）、不读样式 / VBA（cellStyles/bookVBA 显式关）、
    // 行数封顶（sheetRows，多读 1 行用来判断是否被截断）。
    // 局限：XLSX.read 是同步 CPU 调用，无法加超时 / 中断；防线是文件大小 + zip 守卫 + sheetRows 限规模。
    const wb = XLSX.read(buf, {
      type: "buffer",
      cellFormula: false,
      cellStyles: false,
      bookVBA: false,
      sheets: 0,
      sheetRows: MAX_XLSX_PREVIEW_ROWS + 1,
    });
    const first = wb.SheetNames[0];
    const sheet = first ? wb.Sheets[first] : undefined;
    let notice = "";
    if (sheet?.["!ref"]) {
      // 超出行 / 列上限的部分不渲染：直接收窄 !ref，sheet_to_html 只按 !ref 输出
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
    };
  }

  if (
    kind === "markdown" ||
    kind === "code" ||
    kind === "text"
  ) {
    let truncated = false;
    let text: string;
    if (stat.size > MAX_READ_BYTES) {
      const fd = await fs.open(real, "r");
      try {
        const buf = Buffer.alloc(MAX_READ_BYTES);
        await fd.read(buf, 0, MAX_READ_BYTES, 0);
        text = buf.toString("utf-8");
      } finally {
        await fd.close();
      }
      truncated = true;
    } else {
      text = await fs.readFile(real, "utf-8");
    }
    if (text.length > MAX_DISPLAY_CHARS) {
      text = text.slice(0, MAX_DISPLAY_CHARS);
      truncated = true;
    }
    return {
      ...base,
      previewable: true,
      text,
      truncated,
      language: kind === "code" ? extToShikiLang(ext) : undefined,
    };
  }

  // pptx / binary / unknown：不给假预览
  return { ...base, previewable: false };
};
