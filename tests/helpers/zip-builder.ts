/**
 * 测试用最小 zip 构造器 + 最小 pptx 构造器（真实字节，不 mock 任何解析库）。
 * 只覆盖预览测试需要的：store / deflate 两种方式、UTF-8 文件名。
 */
import zlib from "node:zlib";

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
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

export interface ZipFile {
  name: string;
  data: Buffer | string;
  deflate?: boolean;
}

export const buildZip = (files: ZipFile[]): Buffer => {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const data = typeof f.data === "string" ? Buffer.from(f.data, "utf-8") : f.data;
    const name = Buffer.from(f.name, "utf-8");
    const body = f.deflate ? zlib.deflateRawSync(data) : data;
    const crc = crc32(data);
    const method = f.deflate ? 8 : 0;
    const flags = 0x0800; // 文件名 UTF-8

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(flags, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    locals.push(lh, name, body);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(flags, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);

    offset += lh.length + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
};

const NS =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';

const REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const REL_TYPE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const para = (text: string, level = 0): string =>
  `<a:p>${level > 0 ? `<a:pPr lvl="${level}"/>` : ""}<a:r><a:rPr lang="zh-CN"/><a:t>${esc(text)}</a:t></a:r></a:p>`;

const shape = (ph: string | null, paragraphs: string[]): string =>
  `<p:sp><p:nvSpPr><p:cNvPr id="2" name="s"/><p:cNvSpPr/><p:nvPr>${
    ph ? `<p:ph type="${ph}"/>` : ""
  }</p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>${paragraphs.join("")}</p:txBody></p:sp>`;

export interface TestSlide {
  title?: string;
  /** [文本, 层级] 或纯文本 */
  body?: (string | [string, number])[];
  notes?: string;
  pictures?: number;
  /** 一张表格（行 × 列） */
  table?: string[][];
  /** 额外塞一个页码占位符，验证它被忽略 */
  slideNumber?: boolean;
}

/**
 * 构造最小 pptx。`order` 可打乱 presentation.xml 里的放映顺序（验证按放映顺序而不是文件名顺序输出）：
 * 文件名 slide1..N 保持不变，order 里是「放映顺序对应的文件序号」。
 */
export const buildPptx = (slides: TestSlide[], order?: number[]): Buffer => {
  const seq = order ?? slides.map((_, i) => i + 1);
  const files: ZipFile[] = [];
  files.push({
    name: "ppt/presentation.xml",
    data:
      `<?xml version="1.0" encoding="UTF-8"?><p:presentation ${NS}><p:sldIdLst>` +
      seq.map((n, i) => `<p:sldId id="${256 + i}" r:id="rId${n}"/>`).join("") +
      "</p:sldIdLst></p:presentation>",
    deflate: true,
  });
  files.push({
    name: "ppt/_rels/presentation.xml.rels",
    data:
      `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${REL_NS}">` +
      slides
        .map((_, i) => `<Relationship Id="rId${i + 1}" Type="${REL_TYPE}/slide" Target="slides/slide${i + 1}.xml"/>`)
        .join("") +
      "</Relationships>",
    deflate: true,
  });
  slides.forEach((s, i) => {
    const n = i + 1;
    const shapes: string[] = [];
    if (s.title !== undefined) shapes.push(shape("title", [para(s.title)]));
    if (s.body) {
      shapes.push(
        shape(
          "body",
          s.body.map((b) => (typeof b === "string" ? para(b) : para(b[0], b[1]))),
        ),
      );
    }
    if (s.slideNumber) shapes.push(shape("sldNum", [para("‹#›")]));
    if (s.table) {
      shapes.push(
        "<p:graphicFrame><a:graphic><a:graphicData><a:tbl>" +
          s.table
            .map(
              (row) =>
                "<a:tr>" +
                row.map((c) => `<a:tc><a:txBody>${para(c)}</a:txBody></a:tc>`).join("") +
                "</a:tr>",
            )
            .join("") +
          "</a:tbl></a:graphicData></a:graphic></p:graphicFrame>",
      );
    }
    for (let k = 0; k < (s.pictures ?? 0); k++) shapes.push('<p:pic><p:nvPicPr/></p:pic>');
    files.push({
      name: `ppt/slides/slide${n}.xml`,
      data: `<?xml version="1.0" encoding="UTF-8"?><p:sld ${NS}><p:cSld><p:spTree>${shapes.join("")}</p:spTree></p:cSld></p:sld>`,
      deflate: true,
    });
    if (s.notes !== undefined) {
      files.push({
        name: `ppt/slides/_rels/slide${n}.xml.rels`,
        data:
          `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${REL_NS}">` +
          `<Relationship Id="rId1" Type="${REL_TYPE}/notesSlide" Target="../notesSlides/notesSlide${n}.xml"/>` +
          "</Relationships>",
        deflate: true,
      });
      files.push({
        name: `ppt/notesSlides/notesSlide${n}.xml`,
        data:
          `<?xml version="1.0" encoding="UTF-8"?><p:notes ${NS}><p:cSld><p:spTree>` +
          shape("sldImg", []) +
          shape("body", [para(s.notes)]) +
          shape("sldNum", [para("3")]) +
          "</p:spTree></p:cSld></p:notes>",
        deflate: true,
      });
    }
  });
  return buildZip(files);
};
