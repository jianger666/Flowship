/**
 * HTTP Range / If-Range / If-None-Match（media-range）
 *
 * `<video>` 拖进度、边下边播全靠 `Range: bytes=…`。口径（RFC 9110 §14）：
 * 语法不对一律当没带（200 整段）；语法对但起点越界才 416；end 超出末尾截到最后一个字节。
 */
import { describe, expect, it } from "vitest";

import {
  buildMediaEtag,
  ifNoneMatchHits,
  ifRangeAllowsRange,
  parseRangeHeader,
} from "@/lib/media/media-range";

const NONE = { kind: "none" } as const;
const UNSAT = { kind: "unsatisfiable" } as const;
const range = (start: number, end: number) => ({ kind: "range", start, end }) as const;

describe("parseRangeHeader：没带 / 不可用 → none", () => {
  it("缺省 / 空串 / 空白", () => {
    expect(parseRangeHeader(undefined, 100)).toEqual(NONE);
    expect(parseRangeHeader(null, 100)).toEqual(NONE);
    expect(parseRangeHeader("", 100)).toEqual(NONE);
    expect(parseRangeHeader("   ", 100)).toEqual(NONE);
  });

  it("非 bytes 单位", () => {
    expect(parseRangeHeader("items=0-5", 100)).toEqual(NONE);
    expect(parseRangeHeader("lines=0-5", 100)).toEqual(NONE);
    expect(parseRangeHeader("0-5", 100)).toEqual(NONE);
  });

  it("多段范围当没带（媒体元素从不发多段）", () => {
    expect(parseRangeHeader("bytes=0-1,5-9", 100)).toEqual(NONE);
    expect(parseRangeHeader("bytes=0-1, 5-9", 100)).toEqual(NONE);
    expect(parseRangeHeader("bytes=0-5,", 100)).toEqual(NONE);
  });

  it("语法不对：bytes=- / bytes= / 缺横线 / 含空格 / 负数 / 字母", () => {
    for (const bad of ["bytes=-", "bytes=", "bytes=5", "bytes= 0-5", "bytes=0 -5", "bytes=a-b", "bytes=0-5x", "bytes==0-5", "bytes=--5"]) {
      expect(parseRangeHeader(bad, 100), bad).toEqual(NONE);
    }
  });

  it("起点 > 终点：语法上不合法，按没带", () => {
    expect(parseRangeHeader("bytes=10-5", 100)).toEqual(NONE);
    expect(parseRangeHeader("bytes=99-0", 100)).toEqual(NONE);
  });

  it("文件大小非法（NaN / 负数 / 小数 / Infinity）→ 无法判定，按没带", () => {
    expect(parseRangeHeader("bytes=0-5", Number.NaN)).toEqual(NONE);
    expect(parseRangeHeader("bytes=0-5", -1)).toEqual(NONE);
    expect(parseRangeHeader("bytes=0-5", 10.5)).toEqual(NONE);
    expect(parseRangeHeader("bytes=0-5", Number.POSITIVE_INFINITY)).toEqual(NONE);
    expect(parseRangeHeader("bytes=-5", Number.NaN)).toEqual(NONE);
  });

  it("数字超出 safe integer：不当有效范围（起点 / 终点 / 尾部长度三处）", () => {
    const huge = "99999999999999999999";
    expect(parseRangeHeader(`bytes=${huge}-`, 100)).toEqual(NONE);
    expect(parseRangeHeader(`bytes=0-${huge}`, 100)).toEqual(NONE);
    expect(parseRangeHeader(`bytes=-${huge}`, 100)).toEqual(NONE);
    // 恰好 MAX_SAFE_INTEGER 还是合法数字：终点被截到文件末尾
    expect(parseRangeHeader(`bytes=0-${Number.MAX_SAFE_INTEGER}`, 100)).toEqual(range(0, 99));
    expect(parseRangeHeader(`bytes=0-${Number.MAX_SAFE_INTEGER + 1}`, 100)).toEqual(NONE);
  });
});

describe("parseRangeHeader：正常范围", () => {
  it("闭区间 start-end", () => {
    expect(parseRangeHeader("bytes=0-0", 100)).toEqual(range(0, 0));
    expect(parseRangeHeader("bytes=0-9", 100)).toEqual(range(0, 9));
    expect(parseRangeHeader("bytes=10-19", 100)).toEqual(range(10, 19));
    expect(parseRangeHeader("bytes=99-99", 100)).toEqual(range(99, 99));
  });

  it("开放终点 start-：到文件末尾（浏览器边下边播最常见）", () => {
    expect(parseRangeHeader("bytes=0-", 100)).toEqual(range(0, 99));
    expect(parseRangeHeader("bytes=50-", 100)).toEqual(range(50, 99));
    expect(parseRangeHeader("bytes=99-", 100)).toEqual(range(99, 99));
  });

  it("终点超出文件末尾 → 截到最后一个字节", () => {
    expect(parseRangeHeader("bytes=50-200", 100)).toEqual(range(50, 99));
    expect(parseRangeHeader("bytes=0-100", 100)).toEqual(range(0, 99));
    expect(parseRangeHeader("bytes=0-99", 100)).toEqual(range(0, 99));
    expect(parseRangeHeader("bytes=99-1000", 100)).toEqual(range(99, 99));
  });

  it("单位大小写不敏感；首尾空白忽略", () => {
    expect(parseRangeHeader("BYTES=0-9", 100)).toEqual(range(0, 9));
    expect(parseRangeHeader("Bytes=10-", 100)).toEqual(range(10, 99));
    expect(parseRangeHeader("  bytes=0-9  ", 100)).toEqual(range(0, 9));
  });

  it("前导零的数字照常解析", () => {
    expect(parseRangeHeader("bytes=007-0010", 100)).toEqual(range(7, 10));
  });

  it("大文件（超 4GB）不溢出", () => {
    const size = 5 * 1024 ** 3;
    expect(parseRangeHeader(`bytes=${4 * 1024 ** 3}-`, size)).toEqual(range(4 * 1024 ** 3, size - 1));
  });
});

describe("parseRangeHeader：越界 → unsatisfiable", () => {
  it("起点 >= 文件大小", () => {
    expect(parseRangeHeader("bytes=100-", 100)).toEqual(UNSAT);
    expect(parseRangeHeader("bytes=100-200", 100)).toEqual(UNSAT);
    expect(parseRangeHeader("bytes=500-", 100)).toEqual(UNSAT);
  });

  it("起点是最后一个字节之后紧邻的位置也越界（边界）", () => {
    expect(parseRangeHeader("bytes=1-", 1)).toEqual(UNSAT);
    expect(parseRangeHeader("bytes=0-", 1)).toEqual(range(0, 0));
  });

  it("文件大小为 0：任何带起点 / 尾部长度的范围都不可满足", () => {
    expect(parseRangeHeader("bytes=0-", 0)).toEqual(UNSAT);
    expect(parseRangeHeader("bytes=0-0", 0)).toEqual(UNSAT);
    expect(parseRangeHeader("bytes=-5", 0)).toEqual(UNSAT);
  });

  it("没有 Range 头时，空文件仍是 none（整段 200）", () => {
    expect(parseRangeHeader(undefined, 0)).toEqual(NONE);
  });

  it("尾部 0 字节 bytes=-0：不可满足", () => {
    expect(parseRangeHeader("bytes=-0", 100)).toEqual(UNSAT);
    expect(parseRangeHeader("bytes=-00", 100)).toEqual(UNSAT);
  });
});

describe("parseRangeHeader：尾部 N 字节 bytes=-N", () => {
  it("取最后 N 个字节", () => {
    expect(parseRangeHeader("bytes=-1", 100)).toEqual(range(99, 99));
    expect(parseRangeHeader("bytes=-10", 100)).toEqual(range(90, 99));
    expect(parseRangeHeader("bytes=-99", 100)).toEqual(range(1, 99));
  });

  it("N 恰好等于文件大小 → 整段", () => {
    expect(parseRangeHeader("bytes=-100", 100)).toEqual(range(0, 99));
  });

  it("N 超过文件大小 → 整段（不是 416，也不是负起点）", () => {
    expect(parseRangeHeader("bytes=-101", 100)).toEqual(range(0, 99));
    expect(parseRangeHeader("bytes=-100000", 100)).toEqual(range(0, 99));
  });

  it("MP4 的 moov 在尾部：浏览器会先发 bytes=-N 探测", () => {
    expect(parseRangeHeader("bytes=-65536", 1_000_000)).toEqual(range(1_000_000 - 65536, 999_999));
  });
});

describe("buildMediaEtag", () => {
  it("强 ETag：带双引号的 size-mtime，mtime 取整（向下）", () => {
    expect(buildMediaEtag(1234, 1700000000000)).toBe('"1234-1700000000000"');
    expect(buildMediaEtag(1234, 1700000000000.9)).toBe('"1234-1700000000000"');
    expect(buildMediaEtag(0, 0)).toBe('"0-0"');
  });

  it("不是弱标记（If-Range 需要强校验器）", () => {
    expect(buildMediaEtag(1, 2).startsWith("W/")).toBe(false);
    expect(buildMediaEtag(1, 2)).toMatch(/^".*"$/);
  });

  it("size 或 mtime 任一变化 → ETag 变化", () => {
    const base = buildMediaEtag(100, 1000);
    expect(buildMediaEtag(101, 1000)).not.toBe(base);
    expect(buildMediaEtag(100, 1001)).not.toBe(base);
    // 同一毫秒内的小数差不改变 ETag
    expect(buildMediaEtag(100, 1000.4)).toBe(base);
  });
});

describe("ifRangeAllowsRange", () => {
  const etag = '"100-1700000000000"';
  const lm = "Tue, 14 Nov 2023 22:13:20 GMT";

  it("没带 If-Range → 允许", () => {
    expect(ifRangeAllowsRange(undefined, etag, lm)).toBe(true);
    expect(ifRangeAllowsRange(null, etag, lm)).toBe(true);
    expect(ifRangeAllowsRange("", etag, lm)).toBe(true);
  });

  it("强 ETag 完全一致 → 允许；不一致 → 拒（资源已变，整段 200）", () => {
    expect(ifRangeAllowsRange(etag, etag, lm)).toBe(true);
    expect(ifRangeAllowsRange(`  ${etag}  `, etag, lm)).toBe(true);
    expect(ifRangeAllowsRange('"100-1700000000001"', etag, lm)).toBe(false);
    expect(ifRangeAllowsRange('"other"', etag, lm)).toBe(false);
  });

  it("弱 ETag 在 If-Range 里无效 → 拒，即使内容与当前 ETag 一样", () => {
    expect(ifRangeAllowsRange(`W/${etag}`, etag, lm)).toBe(false);
    expect(ifRangeAllowsRange(`W/${etag}`, `W/${etag}`, lm)).toBe(false);
  });

  it("HTTP 日期：与 Last-Modified 完全一致 → 允许；否则拒", () => {
    expect(ifRangeAllowsRange(lm, etag, lm)).toBe(true);
    expect(ifRangeAllowsRange("Tue, 14 Nov 2023 22:13:21 GMT", etag, lm)).toBe(false);
    expect(ifRangeAllowsRange("garbage", etag, lm)).toBe(false);
  });

  it("ETag 形态的值不会去和 Last-Modified 比；日期形态的值不会去和 ETag 比", () => {
    expect(ifRangeAllowsRange(etag, etag, etag.slice(1, -1))).toBe(true);
    expect(ifRangeAllowsRange(lm, lm, lm)).toBe(true);
    expect(ifRangeAllowsRange('"x"', etag, '"x"')).toBe(false);
  });
});

describe("ifNoneMatchHits", () => {
  const etag = '"100-1700000000000"';

  it("没带 → 不命中", () => {
    expect(ifNoneMatchHits(undefined, etag)).toBe(false);
    expect(ifNoneMatchHits(null, etag)).toBe(false);
    expect(ifNoneMatchHits("", etag)).toBe(false);
  });

  it("通配 * → 命中", () => {
    expect(ifNoneMatchHits("*", etag)).toBe(true);
    expect(ifNoneMatchHits("  *  ", etag)).toBe(true);
  });

  it("单个 ETag：一致命中，不一致不命中", () => {
    expect(ifNoneMatchHits(etag, etag)).toBe(true);
    expect(ifNoneMatchHits('"100-1700000000001"', etag)).toBe(false);
    expect(ifNoneMatchHits('"100-170000000000"', etag)).toBe(false);
  });

  it("逗号分隔多个：任一一致就命中；空白容忍", () => {
    expect(ifNoneMatchHits(`"a", ${etag}, "b"`, etag)).toBe(true);
    expect(ifNoneMatchHits(`"a","b",${etag}`, etag)).toBe(true);
    expect(ifNoneMatchHits('"a", "b"', etag)).toBe(false);
  });

  it("弱标记前缀 W/ 在 If-None-Match 里用弱比较：去掉前缀后一致就命中", () => {
    expect(ifNoneMatchHits(`W/${etag}`, etag)).toBe(true);
    expect(ifNoneMatchHits(`"a", W/${etag}`, etag)).toBe(true);
    expect(ifNoneMatchHits('W/"other"', etag)).toBe(false);
  });

  it("* 只在整个头就是 * 时才是通配；夹在列表里当普通值（不命中）", () => {
    expect(ifNoneMatchHits('"a", *', etag)).toBe(false);
  });
});
