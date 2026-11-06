/**
 * 文件预览的数据形状（server 读文件 / API 响应 / 前端各 viewer 共用的纯类型）
 *
 * 放在 lib/preview 而不是组件目录：server 侧（local-file-read / pptx-extract）要产出这些结构，
 * 前端 viewer 要消费它们，两边不该互相 import 对方的实现文件。
 */

import type { LocalFileKind } from "@/lib/local-file-kind";

/** 文本换行风格：mixed = 同一文件里 CRLF / LF / CR 混用（不编辑，避免保存时悄悄改写） */
export type TextEol = "lf" | "crlf" | "mixed";

/** 表格预览（xlsx 当前 sheet / csv / tsv）：全是展示用字符串，不带公式、样式 */
export interface PreviewTable {
  rows: string[][];
  /** 源数据的总行数 / 最大列数（可能大于 rows 里实际带回的） */
  totalRows: number;
  totalCols: number;
  truncatedRows: boolean;
  truncatedCols: boolean;
  /** csv 识别出的分隔符（xlsx 没有） */
  delimiter?: string;
}

/** pptx 一页的文本大纲（不渲染版式：标题 / 正文要点 / 备注 / 图片数） */
export interface PreviewSlide {
  /** 放映序号（1 起；按 presentation.xml 里的顺序，不是文件名顺序） */
  index: number;
  title: string;
  /** 正文段落；level 是项目符号缩进层级（0 起） */
  paragraphs: { text: string; level: number }[];
  notes: string;
  /** 页面里的图片 / 图表 / 媒体数（只数，不展示） */
  pictureCount: number;
}

/** 压缩包里的一个条目（只列目录，不解压） */
export interface ArchiveEntryInfo {
  name: string;
  /** 解压后大小（中央目录声明值） */
  size: number;
  /** 压缩后大小 */
  compressedSize: number;
  isDir: boolean;
}

export interface LocalFilePreviewPayload {
  kind: LocalFileKind;
  absolutePath: string;
  ext: string;
  size: number;
  /** 磁盘修改时间（ms）：保存时的冲突检测基准，也用来发现「文件被别处改了」 */
  mtimeMs: number;
  /** 文本 / md / code / svg（BOM 已去掉；换行为 CRLF 时已归一成 LF，保存时按 eol 还原） */
  text?: string;
  truncated?: boolean;
  /** 只读了文件末尾（日志文件太大时看尾部） */
  tail?: boolean;
  language?: string;
  eol?: TextEol;
  bom?: boolean;
  /** 能否在预览里编辑（路径在允许范围内 + 内容可安全往返）；不可编辑时 editBlockedReason 说明原因 */
  editable?: boolean;
  editBlockedReason?: string;
  /** docx 转 HTML（xlsx 的 html 只在 server 内部使用，API 响应不再带） */
  html?: string;
  /** image / pdf 走独立 GET */
  mediaPath?: string;
  table?: PreviewTable;
  /** xlsx：全部 sheet 名（只解析当前选中的那一张） + 当前序号 */
  sheetNames?: string[];
  sheetIndex?: number;
  slides?: PreviewSlide[];
  slideCount?: number;
  entries?: ArchiveEntryInfo[];
  entryCount?: number;
  entriesTruncated?: boolean;
  previewable: boolean;
  /** 不可预览时给用户看的具体原因（缺省走通用文案） */
  reason?: string;
}
