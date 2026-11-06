/**
 * pptx 文本大纲抽取 + zip 条目读取（真实 zip 字节，不 mock 解析层）
 *
 * 钉住：
 * - 按放映顺序（presentation.xml）而不是文件名顺序；解析不出放映顺序时退回文件名数字序；
 * - 标题 / 正文要点（含缩进层级）/ 表格行 / 备注 / 图片数；页码等占位符被忽略；XML 实体解码；
 * - 病态输入不卡死（大量不闭合标签）、单页超大被跳过而不是拖垮整份；
 * - readZipEntry 的上限 / 缺失 / store+deflate / 加密标志位。
 */
import { describe, expect, it } from "vitest";

import {
  decodeXmlText,
  elementsByTag,
  extractPptxSlides,
  parseNotesXml,
  parseSlideXml,
  resolveZipTarget,
} from "@/lib/server/pptx-extract";
import { assertSafeOfficeZipDeep, listZipEntries, readZipEntry } from "@/lib/server/office-zip-guard";

import { buildPptx, buildZip } from "./helpers/zip-builder";

describe("extractPptxSlides", () => {
  it("标题 / 正文（带层级）/ 备注 / 图片数 都能取到，页码占位符被忽略", async () => {
    const buf = buildPptx([
      {
        title: "季度复盘",
        body: ["增长 20%", ["华东贡献最大", 1], ["其中新客 8%", 2]],
        notes: "开场先讲结论",
        pictures: 2,
        slideNumber: true,
      },
    ]);
    const { slides, slideCount } = await extractPptxSlides(buf);
    expect(slideCount).toBe(1);
    expect(slides).toHaveLength(1);
    const s = slides[0]!;
    expect(s.index).toBe(1);
    expect(s.title).toBe("季度复盘");
    expect(s.paragraphs).toEqual([
      { text: "增长 20%", level: 0 },
      { text: "华东贡献最大", level: 1 },
      { text: "其中新客 8%", level: 2 },
    ]);
    expect(s.notes).toBe("开场先讲结论");
    expect(s.pictureCount).toBe(2);
    // 页码占位符（‹#›）不进正文
    expect(JSON.stringify(s)).not.toContain("‹#›");
  });

  it("按 presentation.xml 的放映顺序输出，而不是 slideN.xml 的文件名顺序", async () => {
    const buf = buildPptx([{ title: "文件1" }, { title: "文件2" }, { title: "文件3" }], [3, 1, 2]);
    const { slides } = await extractPptxSlides(buf);
    expect(slides.map((s) => s.title)).toEqual(["文件3", "文件1", "文件2"]);
    // index 是放映序号（1 起），不是文件序号
    expect(slides.map((s) => s.index)).toEqual([1, 2, 3]);
  });

  it("没有 presentation.xml 时退回文件名数字序（slide2 排在 slide10 前面）", async () => {
    const mk = (n: number, t: string) => ({
      name: `ppt/slides/slide${n}.xml`,
      data:
        '<p:sld xmlns:a="a" xmlns:p="p"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>' +
        `<p:txBody><a:p><a:r><a:t>${t}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`,
    });
    const buf = buildZip([mk(10, "十"), mk(2, "二"), mk(1, "一")]);
    const { slides } = await extractPptxSlides(buf);
    expect(slides.map((s) => s.title)).toEqual(["一", "二", "十"]);
  });

  it("表格按行输出（单元格用 | 隔开），空行被丢弃", async () => {
    const buf = buildPptx([
      {
        title: "指标",
        table: [
          ["名称", "数值"],
          ["DAU", "120"],
          ["", ""],
        ],
      },
    ]);
    const { slides } = await extractPptxSlides(buf);
    expect(slides[0]!.paragraphs.map((p) => p.text)).toEqual(["名称 | 数值", "DAU | 120"]);
  });

  it("XML 实体被解码，段内换行（a:br）保留", () => {
    expect(decodeXmlText("a &amp; b &lt;c&gt; &quot;d&quot; &#65;&#x42;")).toBe('a & b <c> "d" AB');
    // 非法码点不抛错
    expect(decodeXmlText("&#99999999;x")).toBe("x");
    const parsed = parseSlideXml(
      '<p:sp><p:txBody><a:p><a:r><a:t>第一行</a:t></a:r><a:br/><a:r><a:t>第二行 &amp; 更多</a:t></a:r></a:p></p:txBody></p:sp>',
    );
    expect(parsed.paragraphs).toEqual([{ text: "第一行\n第二行 & 更多", level: 0 }]);
  });

  it("备注只取 body 占位符：缩略图 / 页码占位符里的文字不算", () => {
    const xml =
      '<p:notes xmlns:a="a" xmlns:p="p"><p:cSld><p:spTree>' +
      '<p:sp><p:nvSpPr><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>缩略图</a:t></a:r></a:p></p:txBody></p:sp>' +
      '<p:sp><p:nvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>讲稿</a:t></a:r></a:p></p:txBody></p:sp>' +
      '<p:sp><p:nvSpPr><p:nvPr><p:ph type="sldNum"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>7</a:t></a:r></a:p></p:txBody></p:sp>' +
      "</p:spTree></p:cSld></p:notes>";
    expect(parseNotesXml(xml)).toBe("讲稿");
  });

  it("一页里没有标题占位符：title 为空串，其余文字仍在正文里", () => {
    const parsed = parseSlideXml(
      '<p:sp><p:nvSpPr><p:nvPr/></p:nvSpPr><p:txBody><a:p><a:r><a:t>随手一个文本框</a:t></a:r></a:p></p:txBody></p:sp>',
    );
    expect(parsed.title).toBe("");
    expect(parsed.paragraphs.map((p) => p.text)).toEqual(["随手一个文本框"]);
  });

  it("没有任何幻灯片内容 → 明确报错而不是返回空预览", async () => {
    const buf = buildZip([{ name: "docProps/app.xml", data: "<x/>" }]);
    await expect(extractPptxSlides(buf)).rejects.toThrow(/没有找到幻灯片/);
  });

  it("端到端：通过 zip 守卫后的 pptx 能被抽取（deflate 与 store 混用）", async () => {
    const buf = buildPptx([{ title: "守卫通过", body: ["ok"] }]);
    await assertSafeOfficeZipDeep(buf, "pptx");
    const { slides } = await extractPptxSlides(buf);
    expect(slides[0]!.title).toBe("守卫通过");
  });
});

describe("XML 扫描的健壮性", () => {
  it("elementsByTag：不把 <a:pPr> 当成 <a:p>，自闭合元素被跳过", () => {
    const els = elementsByTag("<a:p><a:pPr lvl=\"1\"/><a:r/></a:p><a:p/><a:p x=\"1\">B</a:p>", "a:p");
    expect(els.map((e) => e.xml)).toEqual(['<a:p><a:pPr lvl="1"/><a:r/></a:p>', '<a:p x="1">B</a:p>']);
  });

  it("大量不闭合的开标签：线性时间返回（不是 O(n²) 回溯）", () => {
    const evil = "<p:sp>".repeat(200_000); // 约 1.2MB，没有一个闭合
    const t0 = Date.now();
    const r = parseSlideXml(evil);
    expect(r.paragraphs).toEqual([]);
    expect(Date.now() - t0).toBeLessThan(1500);
  });

  it("单页文本总量封顶，不会把一页超长文本整个塞进响应", () => {
    const huge = "字".repeat(100_000);
    const parsed = parseSlideXml(
      `<p:sp><p:txBody><a:p><a:r><a:t>${huge}</a:t></a:r></a:p></p:txBody></p:sp>`,
    );
    expect(parsed.paragraphs[0]!.text.length).toBe(20_000);
  });

  it("resolveZipTarget：相对 / 绝对 / .. 都按 zip 内路径规范化", () => {
    expect(resolveZipTarget("ppt", "slides/slide1.xml")).toBe("ppt/slides/slide1.xml");
    expect(resolveZipTarget("ppt/slides", "../notesSlides/notesSlide1.xml")).toBe(
      "ppt/notesSlides/notesSlide1.xml",
    );
    expect(resolveZipTarget("ppt", "/ppt/slides/slide2.xml")).toBe("ppt/slides/slide2.xml");
  });
});

describe("readZipEntry / listZipEntries", () => {
  const zip = buildZip([
    { name: "a.txt", data: "hello" },
    { name: "dir/b.txt", data: "world".repeat(1000), deflate: true },
    { name: "dir/", data: "" },
  ]);

  it("store 与 deflate 都能读出，找不到返回 null", async () => {
    expect((await readZipEntry(zip, "a.txt", 1024))!.toString()).toBe("hello");
    expect((await readZipEntry(zip, "dir/b.txt", 1 << 20))!.toString()).toBe("world".repeat(1000));
    expect(await readZipEntry(zip, "nope.txt", 1024)).toBeNull();
  });

  it("超过 maxBytes 抛 ENTRY_TOO_LARGE（deflate 在解压中途就停，不展开整份）", async () => {
    await expect(readZipEntry(zip, "dir/b.txt", 100)).rejects.toMatchObject({ code: "ENTRY_TOO_LARGE" });
    await expect(readZipEntry(zip, "a.txt", 2)).rejects.toMatchObject({ code: "ENTRY_TOO_LARGE" });
  });

  it("listZipEntries：声明大小 / 压缩后大小 / 目录条目；条目数超限被拒", () => {
    const list = listZipEntries(zip);
    expect(list.map((e) => e.name)).toEqual(["a.txt", "dir/b.txt", "dir/"]);
    expect(list[0]).toMatchObject({ declaredSize: 5, compressedSize: 5 });
    expect(list[1]!.declaredSize).toBe(5000);
    expect(list[1]!.compressedSize).toBeLessThan(200);
    expect(() => listZipEntries(zip, "zip", 2)).toThrow(/内部文件数过多/);
  });

  it("不是 zip / 截断：抛可读错误而不是崩溃", () => {
    expect(() => listZipEntries(Buffer.from("not a zip at all, really"))).toThrow();
    expect(() => listZipEntries(zip.subarray(0, zip.length - 10))).toThrow();
  });
});
