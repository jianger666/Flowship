import { describe, expect, it } from "vitest";

import {
  canOpenInIde,
  canPreviewInSheet,
  detectLocalFileKind,
  extToShikiLang,
} from "@/lib/local-file-kind";

describe("detectLocalFileKind", () => {
  it("识别常见扩展名", () => {
    expect(detectLocalFileKind("foo.ts")).toBe("code");
    expect(detectLocalFileKind("readme.md")).toBe("markdown");
    expect(detectLocalFileKind("/a/b.png")).toBe("image");
    expect(detectLocalFileKind("doc.pdf")).toBe("pdf");
    expect(detectLocalFileKind("x.docx")).toBe("docx");
    expect(detectLocalFileKind("sheet.xlsx")).toBe("xlsx");
    expect(detectLocalFileKind("deck.pptx")).toBe("pptx");
    expect(detectLocalFileKind("app.exe")).toBe("binary");
    expect(detectLocalFileKind("noext")).toBe("unknown");
  });
});

describe("canOpenInIde / canPreviewInSheet", () => {
  it("IDE 仅 md/code/text", () => {
    expect(canOpenInIde("markdown")).toBe(true);
    expect(canOpenInIde("code")).toBe(true);
    expect(canOpenInIde("pdf")).toBe(false);
    expect(canOpenInIde("binary")).toBe(false);
  });

  it("Sheet 可预览类型", () => {
    expect(canPreviewInSheet("docx")).toBe(true);
    expect(canPreviewInSheet("pptx")).toBe(false);
  });
});

describe("extToShikiLang", () => {
  it("映射语言 id", () => {
    expect(extToShikiLang("ts")).toBe("typescript");
    expect(extToShikiLang("py")).toBe("python");
  });
});
