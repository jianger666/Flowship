/**
 * pptx → 每页的文本大纲（标题 / 正文要点 / 表格行 / 备注 / 图片数）
 *
 * 不渲染版式：没有 jszip / 渲染引擎可用（也不该为预览加依赖），而「这份 deck 讲了什么」
 * 靠文本大纲就能扫完。解析走 office-zip-guard 的 zip 读取（带解压上限），XML 只用 indexOf / 线性正则扫描——
 * 不用 `[\s\S]*?` 去匹配可能不闭合的大块（输入最大 4MB/页，病态文件会让回溯变成 O(n²)）。
 *
 * 调用方必须先过 assertSafeOfficeZipDeep（zip bomb 守卫），本模块只负责「读出来 + 抽文本」。
 */

import path from "node:path";

import type { PreviewSlide } from "@/lib/preview/types";
import { listZipEntries, readZipEntry } from "@/lib/server/office-zip-guard";

/** 最多解析的页数（再多的 deck 预览也是扫一眼，不为它占 server 时间） */
export const MAX_PPTX_SLIDES = 300;
/** 单页 XML 解压后上限；超过的页只给空内容，不让一个超大页拖慢整份预览 */
const MAX_SLIDE_XML_BYTES = 4 * 1024 * 1024;
/** 单页文本字符上限 */
const MAX_TEXT_PER_SLIDE = 20_000;
/** 不是内容的占位符：页码 / 日期 / 页脚 / 页眉 */
const SKIPPED_PLACEHOLDERS = new Set(["sldNum", "dt", "ftr", "hdr"]);
const TITLE_PLACEHOLDERS = new Set(["title", "ctrTitle"]);

export const decodeXmlText = (s: string): string =>
  s.replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|amp|quot|apos);/g, (_, ent: string) => {
    switch (ent) {
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "amp":
        return "&";
      case "quot":
        return '"';
      case "apos":
        return "'";
      default: {
        const code = ent[1] === "x" ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : "";
      }
    }
  });

interface Element {
  /** 元素在原文里的起始偏移（用来把不同标签的元素按文档顺序合并） */
  start: number;
  /** 含开始标签的整段 XML */
  xml: string;
}

/**
 * 按标签名切出元素（不嵌套同名元素的场景：p:sp / a:p / a:tr / a:tc 在 OOXML 里都不会自嵌套）。
 * 全程 indexOf、线性：开标签位置只往前推，不对每个元素重新扫整个文本。
 */
export const elementsByTag = (xml: string, tag: string): Element[] => {
  const out: Element[] = [];
  const openA = `<${tag}>`;
  const openB = `<${tag} `;
  const close = `</${tag}>`;
  let a = xml.indexOf(openA);
  let b = xml.indexOf(openB);
  let pos = 0;
  for (;;) {
    if (a !== -1 && a < pos) a = xml.indexOf(openA, pos);
    if (b !== -1 && b < pos) b = xml.indexOf(openB, pos);
    const start = a === -1 ? b : b === -1 ? a : Math.min(a, b);
    if (start === -1) break;
    const gt = xml.indexOf(">", start);
    if (gt === -1) break;
    // 自闭合 <a:p/>：没内容，跳过
    if (xml.charCodeAt(gt - 1) === 47) {
      pos = gt + 1;
      continue;
    }
    const end = xml.indexOf(close, gt + 1);
    if (end === -1) break;
    out.push({ start, xml: xml.slice(start, end + close.length) });
    pos = end + close.length;
  }
  return out;
};

const countOf = (xml: string, needle: string): number => {
  let n = 0;
  for (let i = xml.indexOf(needle); i !== -1; i = xml.indexOf(needle, i + needle.length)) n++;
  return n;
};

/** 一个段落（a:p）里的文字：a:t 拼接，a:br 换行 */
const paragraphText = (pXml: string): string => {
  let out = "";
  const re = /<a:t(?:\s[^>]*)?>([^<]*)<\/a:t>|<a:br\s*\/?>/g;
  for (let m = re.exec(pXml); m; m = re.exec(pXml)) {
    out += m[1] !== undefined ? decodeXmlText(m[1]) : "\n";
  }
  return out;
};

const paragraphLevel = (pXml: string): number => {
  const m = /<a:pPr\b[^>]*?\blvl="(\d+)"/.exec(pXml.slice(0, 400));
  return m ? Math.min(Number(m[1]), 6) : 0;
};

const attrOf = (tagXml: string, name: string): string | null => {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(tagXml);
  return m ? decodeXmlText(m[1]!) : null;
};

const placeholderType = (shapeXml: string): string | null => {
  const m = /<p:ph\b([^>]*)\/?>/.exec(shapeXml);
  if (!m) return null;
  return attrOf(m[1]!, "type") ?? "body";
};

interface ShapeText {
  placeholder: string | null;
  paragraphs: { text: string; level: number }[];
}

const shapeParagraphs = (xml: string): { text: string; level: number }[] =>
  elementsByTag(xml, "a:p")
    .map((p) => ({ text: paragraphText(p.xml).trim(), level: paragraphLevel(p.xml) }))
    .filter((p) => p.text.length > 0);

/** 表格：一行一个段落，单元格用 | 隔开 */
const tableRows = (xml: string): { text: string; level: number }[] =>
  elementsByTag(xml, "a:tr")
    .map((tr) => {
      const cells = elementsByTag(tr.xml, "a:tc").map((tc) =>
        shapeParagraphs(tc.xml)
          .map((p) => p.text)
          .join(" "),
      );
      return { text: cells.join(" | ").trim(), level: 0 };
    })
    .filter((r) => r.text.replace(/\|/g, "").trim().length > 0);

/** 把一页 slide XML 按文档顺序拆成「形状文本 + 表格」 */
const slideShapes = (xml: string): ShapeText[] => {
  const shapes = elementsByTag(xml, "p:sp").map((s) => ({ start: s.start, kind: "sp" as const, xml: s.xml }));
  const frames = elementsByTag(xml, "p:graphicFrame").map((s) => ({
    start: s.start,
    kind: "frame" as const,
    xml: s.xml,
  }));
  return [...shapes, ...frames]
    .sort((x, y) => x.start - y.start)
    .map((el): ShapeText => {
      if (el.kind === "frame") {
        return { placeholder: null, paragraphs: tableRows(el.xml) };
      }
      return { placeholder: placeholderType(el.xml), paragraphs: shapeParagraphs(el.xml) };
    });
};

export const parseSlideXml = (
  xml: string,
): { title: string; paragraphs: { text: string; level: number }[]; pictureCount: number } => {
  let title = "";
  const paragraphs: { text: string; level: number }[] = [];
  let budget = MAX_TEXT_PER_SLIDE;
  for (const shape of slideShapes(xml)) {
    if (shape.placeholder && SKIPPED_PLACEHOLDERS.has(shape.placeholder)) continue;
    if (shape.placeholder && TITLE_PLACEHOLDERS.has(shape.placeholder) && !title) {
      title = shape.paragraphs.map((p) => p.text.replace(/\s*\n\s*/g, " ")).join(" ");
      continue;
    }
    for (const p of shape.paragraphs) {
      if (budget <= 0) break;
      const text = p.text.length > budget ? p.text.slice(0, budget) : p.text;
      budget -= text.length;
      paragraphs.push({ text, level: p.level });
    }
  }
  const pictureCount =
    countOf(xml, "<p:pic>") + countOf(xml, "<p:pic ") + countOf(xml, "drawingml/2006/chart");
  return { title, paragraphs, pictureCount };
};

/** 备注页：只取 body 占位符里的文字（备注页里还有幻灯片缩略图 / 页码占位符） */
export const parseNotesXml = (xml: string): string =>
  slideShapes(xml)
    .filter((s) => s.placeholder === "body")
    .flatMap((s) => s.paragraphs.map((p) => p.text))
    .join("\n")
    .slice(0, MAX_TEXT_PER_SLIDE);

interface Relationship {
  id: string;
  type: string;
  target: string;
}

const parseRels = (xml: string): Relationship[] => {
  const out: Relationship[] = [];
  const re = /<Relationship\b[^>]*>/g;
  for (let m = re.exec(xml); m; m = re.exec(xml)) {
    const id = attrOf(m[0], "Id");
    const type = attrOf(m[0], "Type");
    const target = attrOf(m[0], "Target");
    if (id && type && target) out.push({ id, type, target });
  }
  return out;
};

/** Relationship 的 Target 相对「引用它的部件所在目录」解析成 zip 内路径 */
export const resolveZipTarget = (baseDir: string, target: string): string =>
  target.startsWith("/")
    ? path.posix.normalize(target.slice(1))
    : path.posix.normalize(path.posix.join(baseDir, target));

const MAX_RELS_XML_BYTES = 1024 * 1024;

const readText = async (buf: Buffer, name: string, maxBytes: number): Promise<string | null> => {
  try {
    const data = await readZipEntry(buf, name, maxBytes, "pptx");
    return data ? data.toString("utf-8") : null;
  } catch (err) {
    // 单个部件过大 → 当它不存在；其它错误（损坏 / 加密）照常抛
    if ((err as NodeJS.ErrnoException).code === "ENTRY_TOO_LARGE") return null;
    throw err;
  }
};

/** 按 presentation.xml 里的顺序拿到各页的 zip 内路径；解析不出就退回按文件名数字排序 */
const slidePathsInOrder = async (buf: Buffer): Promise<string[]> => {
  const pres = await readText(buf, "ppt/presentation.xml", MAX_RELS_XML_BYTES);
  const rels = await readText(buf, "ppt/_rels/presentation.xml.rels", MAX_RELS_XML_BYTES);
  if (pres && rels) {
    const byId = new Map(parseRels(rels).map((r) => [r.id, r]));
    const ordered: string[] = [];
    const re = /<p:sldId\b[^>]*>/g;
    for (let m = re.exec(pres); m; m = re.exec(pres)) {
      const rid = attrOf(m[0], "r:id");
      const rel = rid ? byId.get(rid) : undefined;
      if (rel && /\/slide$/.test(rel.type)) ordered.push(resolveZipTarget("ppt", rel.target));
    }
    if (ordered.length > 0) return ordered;
  }
  return listZipEntries(buf, "pptx")
    .map((e) => e.name)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)![1]) - Number(/(\d+)\.xml$/.exec(b)![1]));
};

export const extractPptxSlides = async (
  buf: Buffer,
): Promise<{ slides: PreviewSlide[]; slideCount: number }> => {
  const all = await slidePathsInOrder(buf);
  if (all.length === 0) throw new Error("没有找到幻灯片内容，文件可能不是有效的 pptx");
  const slides: PreviewSlide[] = [];
  for (const [i, slidePath] of all.slice(0, MAX_PPTX_SLIDES).entries()) {
    const xml = await readText(buf, slidePath, MAX_SLIDE_XML_BYTES);
    const parsed = xml
      ? parseSlideXml(xml)
      : { title: "", paragraphs: [], pictureCount: 0 };

    let notes = "";
    const dir = path.posix.dirname(slidePath);
    const relsXml = await readText(
      buf,
      `${dir}/_rels/${path.posix.basename(slidePath)}.rels`,
      MAX_RELS_XML_BYTES,
    );
    const notesRel = relsXml ? parseRels(relsXml).find((r) => /\/notesSlide$/.test(r.type)) : undefined;
    if (notesRel) {
      const notesXml = await readText(buf, resolveZipTarget(dir, notesRel.target), MAX_SLIDE_XML_BYTES);
      if (notesXml) notes = parseNotesXml(notesXml);
    }
    slides.push({ index: i + 1, ...parsed, notes });
  }
  return { slides, slideCount: all.length };
};
