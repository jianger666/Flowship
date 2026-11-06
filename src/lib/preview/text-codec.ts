/**
 * 文本文件的编码往返（server 读 / 写共用的纯函数）
 *
 * 编辑功能的底线：**打开再保存，没改的地方一个字节都不能变**。所以读的时候就把「会被悄悄改写」的情形
 * 识别出来，不能安全往返的文件（非 UTF-8、含 NUL、换行混用）一律不给编辑：
 * - BOM：读时剥掉并记下，保存时原样补回；
 * - 换行：纯 CRLF 归一成 LF 给编辑器，保存时还原；混用 / 单独的 CR 视为 mixed（不编辑）；
 * - 非 UTF-8：宽松解码只用于显示，保存会把无法解码的字节永久替换成 U+FFFD，所以禁止编辑。
 */

import type { TextEol } from "@/lib/preview/types";

export interface DecodedTextFile {
  /** 去 BOM；eol 为 crlf 时已归一成 LF（mixed 保持原样） */
  text: string;
  eol: TextEol;
  bom: boolean;
  validUtf8: boolean;
  hasNul: boolean;
}

const UTF8_BOM = [0xef, 0xbb, 0xbf] as const;

export const hasUtf8Bom = (buf: Uint8Array): boolean =>
  buf.length >= 3 && buf[0] === UTF8_BOM[0] && buf[1] === UTF8_BOM[1] && buf[2] === UTF8_BOM[2];

/** 数换行：CRLF / 孤立 LF / 孤立 CR（后者几乎只出现在老 Mac 文件或二进制里） */
export const detectEol = (text: string): TextEol => {
  let crlf = 0;
  let lf = 0;
  let cr = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 13) {
      if (text.charCodeAt(i + 1) === 10) {
        crlf++;
        i++;
      } else cr++;
    } else if (c === 10) lf++;
  }
  if (cr > 0) return "mixed";
  if (crlf > 0 && lf > 0) return "mixed";
  return crlf > 0 ? "crlf" : "lf";
};

export const decodeTextBuffer = (buf: Buffer): DecodedTextFile => {
  const bom = hasUtf8Bom(buf);
  const body = bom ? buf.subarray(3) : buf;
  let validUtf8 = true;
  let raw: string;
  try {
    raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body);
  } catch {
    validUtf8 = false;
    raw = body.toString("utf-8");
  }
  const eol = detectEol(raw);
  return {
    text: eol === "crlf" ? raw.replace(/\r\n/g, "\n") : raw,
    eol,
    bom,
    validUtf8,
    hasNul: body.includes(0),
  };
};

/** 把编辑器里的文本（LF）按原文件的 BOM / 换行风格写回字节 */
export const encodeTextBuffer = (
  text: string,
  meta: { eol: "lf" | "crlf"; bom: boolean },
): Buffer => {
  // 浏览器 textarea 一律给 LF；万一带了 CRLF 先归一，避免 crlf 模式下变成 \r\r\n
  const normalized = text.replace(/\r\n/g, "\n");
  const body = meta.eol === "crlf" ? normalized.replace(/\n/g, "\r\n") : normalized;
  const bytes = Buffer.from(body, "utf-8");
  return meta.bom ? Buffer.concat([Buffer.from(UTF8_BOM), bytes]) : bytes;
};

/** 内容层面能否安全往返编辑；不能时返回给用户看的原因 */
export const contentEditBlockReason = (d: DecodedTextFile): string | null => {
  if (!d.validUtf8) return "文件不是 UTF-8 编码，保存会破坏内容，请用 IDE 编辑";
  if (d.hasNul) return "文件含二进制内容，不适合在这里编辑";
  if (d.eol === "mixed") return "文件换行符混用（CRLF / LF），保存会改写，请用 IDE 编辑";
  return null;
};
