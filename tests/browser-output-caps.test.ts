/**
 * R1-29：fullPage 截图 / PDF 的字节上限（electron-app/browser/output-caps.mjs）。
 * 纯函数：tab.screenshot（fullPage）与 ops/read.mjs 的 printPdf 在拿到 CDP 的 base64 之后、解码之前调用。
 */
import { describe, expect, it } from "vitest";

import {
  FULLPAGE_SHOT_HINT,
  FULLPAGE_SHOT_MAX_BYTES,
  PDF_HINT,
  PDF_MAX_BYTES,
  assertBase64WithinCap,
  base64DecodedBytes,
} from "../electron-app/browser/output-caps.mjs";

describe("base64DecodedBytes", () => {
  it("与 Buffer 解码后的长度一致（含 = 填充）", () => {
    for (const n of [0, 1, 2, 3, 4, 5, 100, 1023]) {
      const buf = Buffer.alloc(n, 7);
      expect(base64DecodedBytes(buf.toString("base64"))).toBe(n);
    }
    expect(base64DecodedBytes(undefined as never)).toBe(0);
  });
});

describe("assertBase64WithinCap", () => {
  it("未超限返回字节数；刚好等于上限放行", () => {
    const b64 = Buffer.alloc(1000).toString("base64");
    expect(assertBase64WithinCap(b64, 1000, "PDF", PDF_HINT)).toBe(1000);
  });

  it("超限抛 BAD_ARGS：写明实际大小 / 上限 / 不会返回半截文件 / 替代做法", () => {
    const b64 = Buffer.alloc(2 * 1024 * 1024).toString("base64");
    let err: { code?: string; message?: string } | undefined;
    try {
      assertBase64WithinCap(b64, 1024 * 1024, "fullPage 截图", FULLPAGE_SHOT_HINT);
    } catch (e) {
      err = e as { code?: string; message?: string };
    }
    expect(err?.code).toBe("BAD_ARGS");
    expect(err?.message).toContain("fullPage 截图");
    expect(err?.message).toContain("2.0MB");
    expect(err?.message).toContain("1MB 上限");
    expect(err?.message).toContain("不会返回被截断的半截文件");
    expect(err?.message).toContain("fullPage:false");
  });

  it("上限常量合理：截图 / PDF 各 30MB", () => {
    expect(FULLPAGE_SHOT_MAX_BYTES).toBe(30 * 1024 * 1024);
    expect(PDF_MAX_BYTES).toBe(30 * 1024 * 1024);
  });
});
