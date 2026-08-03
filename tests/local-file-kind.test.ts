import { describe, expect, it } from "vitest";

import {
  canOpenInIde,
  canPreviewInSheet,
  detectLocalFileKind,
  extToShikiLang,
  resolveLocalFileOpenTarget,
  shouldOpenLocalFileInBrowser,
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

describe("shouldOpenLocalFileInBrowser", () => {
  it("html / htm 直接进入系统默认浏览器", () => {
    expect(shouldOpenLocalFileInBrowser("/tmp/report.html")).toBe(true);
    expect(shouldOpenLocalFileInBrowser("C:\\tmp\\REPORT.HTM")).toBe(true);
  });

  it("只识别 HTML 扩展名", () => {
    expect(shouldOpenLocalFileInBrowser("/tmp/report.tsx")).toBe(false);
    expect(shouldOpenLocalFileInBrowser("/tmp/report.html.txt")).toBe(false);
  });
});

describe("resolveLocalFileOpenTarget", () => {
  it("HTML 页面进浏览器，带行号的 HTML 进 IDE", () => {
    expect(resolveLocalFileOpenTarget("/tmp/report.html")).toBe("browser");
    expect(resolveLocalFileOpenTarget("C:\\tmp\\REPORT.HTM")).toBe("browser");
    expect(resolveLocalFileOpenTarget("/tmp/report.html", 42)).toBe("ide");
  });

  it("代码文件进 IDE，非代码文件留在应用内预览", () => {
    expect(resolveLocalFileOpenTarget("/tmp/report.tsx")).toBe("ide");
    expect(resolveLocalFileOpenTarget("/tmp/report.py", 7)).toBe("ide");
    expect(resolveLocalFileOpenTarget("/tmp/readme.md", 7)).toBe("preview");
    expect(resolveLocalFileOpenTarget("/tmp/screenshot.png")).toBe("preview");
    expect(resolveLocalFileOpenTarget("/tmp/report.pdf")).toBe("preview");
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
