/**
 * Q7b-02：搜索可见分段缓存不再被流式帧冲刷 / 撑大。
 *
 * 旧行为：key 是全文，流式每帧一份新字符串 + 一份分段数组；一条 50KB 回复 2000 帧 ≈ 数十 MB 驻留，
 * 而且 4000 条的 LRU 被这些一次性帧挤掉稳定回复的条目；上限按条数而不是按字节。
 */
import { describe, expect, it } from "vitest";

import {
  markdownToSearchableFields,
  markdownVisibleSegmentsCacheStats,
} from "@/lib/markdown-visible-search";

/**
 * 这些用例纯 CPU（每帧都真跑 unified 解析、帧越长越慢）：空载 1~2s，但全量并发 / 机器高负载时会涨到 5s+，
 * 撞上 vitest 默认 5s 超时（第五轮全量复跑里出现过一次，单跑通过）。放宽超时只防「慢」被当「错」，不放宽任何断言。
 */
const HEAVY_PARSE_TIMEOUT_MS = 30_000;

const para = (i: number): string => `第 ${i} 段：这是一段用来凑长度的正文，包含 alpha beta gamma 与一些 **强调**。`;
const stable = (i: number): string => `稳定回复 ${i}\n\n${Array.from({ length: 6 }, (_, k) => para(i * 10 + k)).join("\n\n")}`;

describe("Q7b-02：流式帧不在缓存里堆积", () => {
  it("一条长回复吐 300 帧：缓存条数只多个位数（始终只留最新帧），总字符数 ≈ 一帧而不是 300 帧之和", () => {
    const before = markdownVisibleSegmentsCacheStats();
    let text = "";
    let frames = 0;
    for (let k = 0; k < 300; k++) {
      text += para(k) + "\n\n";
      markdownToSearchableFields(text, "__streaming__", "body");
      frames++;
    }
    const after = markdownVisibleSegmentsCacheStats();
    expect(frames).toBe(300);
    expect(after.parses - before.parses).toBe(300); // 每帧照常解析（正确性不变）
    // 开头几帧不足 200 字（不淘汰的短文本下限），之后始终只留最新一帧
    expect(after.size - before.size).toBeLessThanOrEqual(6);
    // 最终一帧约 300 × ~50 字；累计所有帧约 300 × 平均 7500 ≈ 2.2M 字符——必须远小于它
    expect(after.chars - before.chars).toBeLessThan(text.length * 2);
  }, HEAVY_PARSE_TIMEOUT_MS);

  it("流式帧不挤掉稳定回复：灌 60 条稳定回复后再吐 300 帧，稳定回复全部仍命中（解析次数不增）", () => {
    const items = Array.from({ length: 60 }, (_, i) => stable(i));
    for (const t of items) markdownToSearchableFields(t, "o", "body");
    let text = "";
    for (let k = 0; k < 300; k++) {
      text += para(k) + "\n\n";
      markdownToSearchableFields(text, "__streaming__", "body");
    }
    const parses = markdownVisibleSegmentsCacheStats().parses;
    for (const t of items) markdownToSearchableFields(t, "o", "body");
    expect(markdownVisibleSegmentsCacheStats().parses).toBe(parses);
  }, HEAVY_PARSE_TIMEOUT_MS);

  it("回归：稳定文本仍然命中缓存（第二次不再解析），不同 owner / field 共用同一份分段", () => {
    const t = stable(777);
    markdownToSearchableFields(t, "a", "body");
    const p = markdownVisibleSegmentsCacheStats().parses;
    const r = markdownToSearchableFields(t, "b", "extra0");
    expect(markdownVisibleSegmentsCacheStats().parses).toBe(p);
    expect(r[0]?.ownerId).toBe("b");
  });

  it("回归：短文本的巧合前缀不被误淘汰（「好的」→「好的，……」两条都还在缓存里）", () => {
    markdownToSearchableFields("好的", "o", "body");
    markdownToSearchableFields("好的，我来处理这个问题", "o", "body");
    const p = markdownVisibleSegmentsCacheStats().parses;
    markdownToSearchableFields("好的", "o", "body");
    markdownToSearchableFields("好的，我来处理这个问题", "o", "body");
    expect(markdownVisibleSegmentsCacheStats().parses).toBe(p);
  });
});

describe("第五轮 P4：多条流并发吐字，各自的过时帧也被淘汰（不再只认「上一次插入的一个」）", () => {
  it("两条流交替吐 200 帧：缓存条数仍只多个位数（旧：交替插入使淘汰全部失效，堆积到 ~400）", () => {
    const before = markdownVisibleSegmentsCacheStats();
    let a = "流 A\n\n";
    let b = "流 B\n\n";
    for (let k = 0; k < 200; k++) {
      a += para(k) + "\n\n";
      b += para(1000 + k) + "\n\n";
      markdownToSearchableFields(a, "__streaming_a__", "body");
      markdownToSearchableFields(b, "__streaming_b__", "body");
    }
    const after = markdownVisibleSegmentsCacheStats();
    expect(after.parses - before.parses).toBe(400); // 每帧照常解析
    // 开头不足 200 字的短帧不淘汰（两条流各几帧），之后每条流只留最新一帧
    expect(after.size - before.size).toBeLessThanOrEqual(16);
    expect(after.chars - before.chars).toBeLessThan((a.length + b.length) * 3);
  }, HEAVY_PARSE_TIMEOUT_MS);

  it("三条流 + 一条稳定回复穿插：稳定回复不被误淘汰（它不是任何流帧的前缀）", () => {
    const keep = stable(4242);
    markdownToSearchableFields(keep, "o", "body");
    const streams = ["甲", "乙", "丙"].map((n) => `流 ${n}\n\n`);
    for (let k = 0; k < 60; k++) {
      for (let i = 0; i < streams.length; i++) {
        streams[i] += para(k * 10 + i) + "\n\n";
        markdownToSearchableFields(streams[i]!, `__s${i}__`, "body");
      }
    }
    const p = markdownVisibleSegmentsCacheStats().parses;
    markdownToSearchableFields(keep, "o", "body");
    expect(markdownVisibleSegmentsCacheStats().parses).toBe(p);
  }, HEAVY_PARSE_TIMEOUT_MS);
});

describe("Q7b-02：按字符预算而不是只按条数限制", () => {
  it("灌入大量互不相同的 ~150K 字符文本：缓存总字符数不超过预算", () => {
    const { maxChars } = markdownVisibleSegmentsCacheStats();
    const body = "字".repeat(150_000);
    for (let i = 0; i < 30; i++) {
      // 前缀各不相同，避免被「过时前缀帧」规则当成同一条流
      markdownToSearchableFields(`${i}-${"x".repeat(i)}${body}`, "o", "body");
    }
    const s = markdownVisibleSegmentsCacheStats();
    expect(s.chars).toBeLessThanOrEqual(maxChars);
    expect(s.size).toBeGreaterThan(0);
  }, HEAVY_PARSE_TIMEOUT_MS);

  it("超长文本（> 20 万字）仍不入缓存，且不计入字符数", () => {
    const before = markdownVisibleSegmentsCacheStats();
    markdownToSearchableFields("长".repeat(200_001), "o", "body");
    const after = markdownVisibleSegmentsCacheStats();
    expect(after.size).toBe(before.size);
    expect(after.chars).toBe(before.chars);
  });
});
