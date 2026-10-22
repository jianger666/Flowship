/**
 * 「排队消息未送达」事件的构造（D8-04）：纯函数，与 chat-runner.noticeQueuedItemsDropped 同口径。
 *
 * 为什么抽出来：task 页的排队条在「停止 / 过期 / 重放失败」时也要丢掉排队的话，
 * 但此前 task 侧只写一条 80 字、无 meta 的灰色细线——用户的原话（尤其是长消息）找不回来。
 * 前端 `DroppedQueueCard` 早就按 `meta.droppedTexts` 分流画「未送达」卡，缺的只是服务端 task 侧写这个字段。
 * 这里锁住：正文摘要的列法、meta 的截断上限、没有文本时不带 meta（不画空卡）、以及卡片标题能还原出 header。
 */
import { describe, expect, it } from "vitest";

import {
  DROPPED_META_TEXT_MAX,
  DROPPED_NOTICE_LIST_MAX,
  DROPPED_NOTICE_SNIPPET_MAX,
  buildDroppedQueueNotice,
} from "@/lib/dropped-queue-notice";
import { droppedNoticeTitle, extractDroppedTexts } from "@/lib/chat-stream-display";

const item = (itemId: string, text: string) => ({ itemId, text });

describe("buildDroppedQueueNotice", () => {
  it("列出摘要 + meta 带完整文本与 itemId（顺序一致）", () => {
    const header = "已停止，2 条排队消息未送达、请重新发送";
    const out = buildDroppedQueueNotice({
      header,
      count: 2,
      items: [item("tq_1", "第一条"), item("tq_2", "第二条\n带换行")],
    });
    expect(out.text).toBe(`${header}：\n- 第一条\n- 第二条 带换行`);
    expect(out.meta).toEqual({
      droppedItemIds: ["tq_1", "tq_2"],
      droppedTexts: ["第一条", "第二条\n带换行"],
    });
  });

  it("摘要压平空白并截到 80 字；meta 里是未截断的完整原文（换行保留）", () => {
    const long = `${"甲".repeat(DROPPED_NOTICE_SNIPPET_MAX + 30)}\n第二行`;
    const out = buildDroppedQueueNotice({
      header: "H",
      count: 1,
      items: [item("a", long)],
    });
    const line = out.text.split("\n")[1]!;
    expect(line).toBe(`- ${"甲".repeat(DROPPED_NOTICE_SNIPPET_MAX)}…`);
    expect(out.meta?.droppedTexts[0]).toBe(long);
  });

  it("超过 5 条：只列前 5 条摘要，末尾「…等 N 条」按总数；meta 仍全量", () => {
    const items = Array.from({ length: 7 }, (_, i) => item(`i${i}`, `消息${i}`));
    const out = buildDroppedQueueNotice({ header: "H", count: 7, items });
    const lines = out.text.split("\n");
    expect(lines.filter((l) => l.startsWith("- "))).toHaveLength(
      DROPPED_NOTICE_LIST_MAX,
    );
    expect(lines.at(-1)).toBe("…等 7 条");
    expect(out.meta?.droppedTexts).toHaveLength(7);
  });

  it("count 大于有文本的条数（图片 / 文件条拿不到文本）：摘要后也补「…等 N 条」", () => {
    const out = buildDroppedQueueNotice({
      header: "H",
      count: 3,
      items: [item("a", "只有这条有字")],
    });
    expect(out.text).toBe("H：\n- 只有这条有字\n…等 3 条");
    expect(out.meta?.droppedItemIds).toEqual(["a"]);
  });

  it("meta 单条超过 2000 字截断（带省略号）；不影响其它条", () => {
    const big = "字".repeat(DROPPED_META_TEXT_MAX + 50);
    const out = buildDroppedQueueNotice({
      header: "H",
      count: 2,
      items: [item("a", big), item("b", "短")],
    });
    expect(out.meta?.droppedTexts[0]).toBe(`${"字".repeat(DROPPED_META_TEXT_MAX)}…`);
    expect(out.meta?.droppedTexts[1]).toBe("短");
  });

  it("按码点截断：emoji 不会被劈成半个代理项", () => {
    const out = buildDroppedQueueNotice({
      header: "H",
      count: 1,
      items: [item("a", "😀".repeat(DROPPED_NOTICE_SNIPPET_MAX + 5))],
    });
    const line = out.text.split("\n")[1]!;
    expect(line).toBe(`- ${"😀".repeat(DROPPED_NOTICE_SNIPPET_MAX)}…`);
  });

  it("没有任何有文本的条（全是图片 / 空白）：只有 header、不带 meta——不画空卡", () => {
    const out = buildDroppedQueueNotice({
      header: "已停止，2 条排队消息未送达、请重新发送",
      count: 2,
      items: [item("a", ""), item("b", "   \n ")],
    });
    expect(out.text).toBe("已停止，2 条排队消息未送达、请重新发送");
    expect(out.meta).toBeUndefined();
  });

  it("前端读者对得上：extractDroppedTexts 取回完整文本、卡片标题就是 header（尾冒号被去掉）", () => {
    const header = "排队的消息没送出去：排队超过 30 分钟已过期";
    const out = buildDroppedQueueNotice({
      header,
      count: 1,
      items: [item("a", "一大段\n多行的话")],
    });
    expect(extractDroppedTexts(out.meta)).toEqual(["一大段\n多行的话"]);
    expect(droppedNoticeTitle(out.text)).toBe(header);
  });
});

// ---------- Q6-04：纯图片 / 文件条的占位 ----------
import {
  describeDroppedAttachments,
  extractDroppedAttachments,
} from "@/lib/dropped-queue-notice";

describe("buildDroppedQueueNotice：图片 / 文件占位（Q6-04）", () => {
  it("describeDroppedAttachments：图 / 文件 / 都有 / 都没有", () => {
    expect(describeDroppedAttachments(2, 0)).toBe("2 张图片");
    expect(describeDroppedAttachments(0, 1)).toBe("1 个文件");
    expect(describeDroppedAttachments(1, 3)).toBe("1 张图片、3 个文件");
    expect(describeDroppedAttachments(0, 0)).toBe("");
  });

  it("纯图片条不再丢：正文有占位行、meta 带 droppedAttachments、droppedTexts 为空", () => {
    const out = buildDroppedQueueNotice({
      header: "已停止，1 条排队消息未送达、请重新发送",
      count: 1,
      items: [{ itemId: "cq_1", text: "", attachments: "2 张图片" }],
    });
    expect(out.text).toContain("- （只有 2 张图片，没有文字）");
    expect(extractDroppedTexts(out.meta)).toEqual([]);
    expect(extractDroppedAttachments(out.meta)).toEqual(["一条只有 2 张图片、没有文字"]);
  });

  it("文字 + 附件混合：droppedItemIds / droppedTexts 仍只含有文字的条且下标对齐；附件说明指向第 N 块原文", () => {
    const out = buildDroppedQueueNotice({
      header: "h",
      count: 3,
      items: [
        { itemId: "a", text: "甲" },
        { itemId: "b", text: "", attachments: "1 个文件" },
        { itemId: "c", text: "丙", attachments: "1 张图片" },
      ],
    });
    expect(out.meta?.droppedItemIds).toEqual(["a", "c"]);
    expect(out.meta?.droppedTexts).toEqual(["甲", "丙"]);
    expect(extractDroppedAttachments(out.meta)).toEqual([
      "一条只有 1 个文件、没有文字",
      "第 2 条附带 1 张图片",
    ]);
    expect(out.text).not.toContain("…等"); // 3 条都列出来了
  });

  it("旧行为不变：没有附件占位时 meta 不带 droppedAttachments；既无文字也无附件仍不画空卡", () => {
    const plain = buildDroppedQueueNotice({ header: "h", count: 1, items: [item("x", "话")] });
    expect(plain.meta && "droppedAttachments" in plain.meta).toBe(false);
    expect(buildDroppedQueueNotice({ header: "h", count: 2, items: [item("x", "  ")] })).toEqual({
      text: "h",
    });
  });

  it("extractDroppedAttachments：脏数据（非数组 / 非字符串 / 空白）被丢掉", () => {
    expect(extractDroppedAttachments(undefined)).toEqual([]);
    expect(extractDroppedAttachments({ droppedAttachments: "x" })).toEqual([]);
    expect(extractDroppedAttachments({ droppedAttachments: ["ok", 1, "  ", null] })).toEqual(["ok"]);
  });
});
