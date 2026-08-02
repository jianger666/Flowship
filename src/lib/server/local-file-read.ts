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

/** 文本类最多读 512KB；字符展示再截到 50k，防 Sheet 卡死 */
export const MAX_READ_BYTES = 512 * 1024;
export const MAX_DISPLAY_CHARS = 50_000;

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
    const buf = await fs.readFile(real);
    const { value: html } = await mammoth.convertToHtml({ buffer: buf });
    return { ...base, previewable: true, html };
  }

  if (kind === "xlsx") {
    const buf = await fs.readFile(real);
    const wb = XLSX.read(buf, { type: "buffer" });
    const first = wb.SheetNames[0];
    const sheet = first ? wb.Sheets[first] : undefined;
    const html = sheet
      ? XLSX.utils.sheet_to_html(sheet, { id: "local-file-xlsx-preview" })
      : "<p>（空表格）</p>";
    return { ...base, kind: "xlsx", previewable: true, html };
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
