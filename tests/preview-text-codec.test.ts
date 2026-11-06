/**
 * 文本编码往返（编辑功能的底线：打开再保存，没改的地方一个字节都不能变）
 */
import { describe, expect, it } from "vitest";

import {
  contentEditBlockReason,
  decodeTextBuffer,
  detectEol,
  encodeTextBuffer,
  hasUtf8Bom,
} from "@/lib/preview/text-codec";

const roundTrip = (buf: Buffer): Buffer => {
  const d = decodeTextBuffer(buf);
  if (d.eol === "mixed") throw new Error("mixed 不允许往返");
  return encodeTextBuffer(d.text, { eol: d.eol, bom: d.bom });
};

describe("detectEol", () => {
  it("纯 LF / 纯 CRLF / 无换行", () => {
    expect(detectEol("a\nb\n")).toBe("lf");
    expect(detectEol("a\r\nb\r\n")).toBe("crlf");
    expect(detectEol("single line")).toBe("lf");
    expect(detectEol("")).toBe("lf");
  });

  it("CRLF 与 LF 混用 → mixed；孤立的 CR → mixed", () => {
    expect(detectEol("a\r\nb\nc")).toBe("mixed");
    expect(detectEol("a\rb")).toBe("mixed");
    expect(detectEol("a\r\nb\rc")).toBe("mixed");
  });
});

describe("decode → encode 往返无损", () => {
  const cases: [string, Buffer][] = [
    ["LF + 末尾换行", Buffer.from("line1\nline2\n")],
    ["LF 无末尾换行", Buffer.from("line1\nline2")],
    ["CRLF", Buffer.from("a\r\nb\r\nc\r\n")],
    ["UTF-8 BOM + CRLF", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("名字,年龄\r\n张三,18\r\n")])],
    ["UTF-8 BOM + LF", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("x\n")])],
    ["多字节字符 / emoji", Buffer.from("你好 🌍\n日本語\n")],
    ["空文件", Buffer.alloc(0)],
    ["只有一个换行", Buffer.from("\n")],
    ["连续空行", Buffer.from("a\n\n\nb\n")],
  ];
  for (const [name, buf] of cases) {
    it(name, () => {
      expect(roundTrip(buf).equals(buf)).toBe(true);
    });
  }

  it("BOM 被剥掉不进 text、但记在 bom 里；CRLF 归一成 LF 给编辑器", () => {
    const d = decodeTextBuffer(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("a\r\nb")]));
    expect(d.bom).toBe(true);
    expect(d.eol).toBe("crlf");
    expect(d.text).toBe("a\nb");
    expect(d.text.charCodeAt(0)).not.toBe(0xfeff);
  });

  it("编辑后保存：新增的换行按原文件风格写成 CRLF，不会出现 \\r\\r\\n", () => {
    const out = encodeTextBuffer("a\nb\r\nc\n", { eol: "crlf", bom: false });
    expect(out.toString()).toBe("a\r\nb\r\nc\r\n");
    expect(out.toString()).not.toContain("\r\r");
  });
});

describe("不能安全往返的内容：识别出来、给原因", () => {
  it("非 UTF-8（GBK 字节）：validUtf8=false，禁止编辑", () => {
    const gbk = Buffer.from([0xc4, 0xe3, 0xba, 0xc3]); // “你好”的 GBK
    const d = decodeTextBuffer(gbk);
    expect(d.validUtf8).toBe(false);
    expect(contentEditBlockReason(d)).toMatch(/UTF-8/);
  });

  it("含 NUL 字节 → 二进制，禁止编辑", () => {
    const d = decodeTextBuffer(Buffer.from([0x61, 0x00, 0x62]));
    expect(d.hasNul).toBe(true);
    expect(contentEditBlockReason(d)).toMatch(/二进制/);
  });

  it("换行混用 → 禁止编辑（保存会悄悄改写）", () => {
    const d = decodeTextBuffer(Buffer.from("a\r\nb\nc"));
    expect(d.eol).toBe("mixed");
    expect(contentEditBlockReason(d)).toMatch(/换行/);
  });

  it("正常 UTF-8 文本没有阻塞原因", () => {
    expect(contentEditBlockReason(decodeTextBuffer(Buffer.from("正常\n文本\n")))).toBeNull();
  });

  it("hasUtf8Bom 只认开头三字节", () => {
    expect(hasUtf8Bom(Buffer.from([0xef, 0xbb, 0xbf, 0x41]))).toBe(true);
    expect(hasUtf8Bom(Buffer.from([0x41, 0xef, 0xbb, 0xbf]))).toBe(false);
    expect(hasUtf8Bom(Buffer.from([0xef, 0xbb]))).toBe(false);
  });
});
