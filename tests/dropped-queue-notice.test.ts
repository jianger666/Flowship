/**
 * V3-05：run 出错 / 会话关闭时排队消息被丢——前端要读 `meta.droppedTexts`
 *
 * 服务端（chat-runner.noticeQueuedItemsDropped）早就把完整文本放进 `meta.droppedTexts / droppedItemIds`、
 * 注释写「供前端回填」，但全 src 没有任何前端读者：排队气泡直接消失、草稿不回填，
 * 唯一的痕迹是一条 11px 灰色 truncate 细线（用户要重发得自己去回想发过什么）。
 *
 * 这里分两层：
 *  - 纯函数（chat-stream-display）：读 meta、拼回填文本、标题 / 草稿前置——真正的判定都在这，可单测；
 *  - 接线源码契约：rows 在 chat / log 分叉前把这类 info 分流到 DroppedQueueCard，
 *    「放回输入框」由 EventStream（握着草稿）经 StreamActions 注入，卡片本身不碰草稿。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  droppedNoticeTitle,
  extractDroppedTexts,
  joinDroppedTexts,
  prependRestoredToDraft,
} from "../src/lib/chat-stream-display";

const srcDir = path.resolve(import.meta.dirname, "..", "src");
const read = (...seg: string[]): string =>
  readFileSync(path.join(srcDir, ...seg), "utf-8");

describe("extractDroppedTexts：读服务端写的 meta.droppedTexts", () => {
  it("取出完整文本（保持顺序 / 换行）", () => {
    expect(
      extractDroppedTexts({
        droppedItemIds: ["a", "b"],
        droppedTexts: ["第一条\n带换行", "第二条"],
      }),
    ).toEqual(["第一条\n带换行", "第二条"]);
  });

  it("没有 meta / 没有该字段 / 不是数组 / 空数组 → 空（走原来的细线）", () => {
    expect(extractDroppedTexts(undefined)).toEqual([]);
    expect(extractDroppedTexts(null)).toEqual([]);
    expect(extractDroppedTexts({})).toEqual([]);
    expect(extractDroppedTexts({ droppedTexts: "不是数组" })).toEqual([]);
    expect(extractDroppedTexts({ droppedTexts: [] })).toEqual([]);
  });

  it("过滤掉非字符串 / 纯空白的脏项（meta 是落盘数据、不可全信）", () => {
    expect(
      extractDroppedTexts({ droppedTexts: ["有效", "", "   \n", 3, null, "也有效"] }),
    ).toEqual(["有效", "也有效"]);
    expect(extractDroppedTexts({ droppedTexts: ["", "  "] })).toEqual([]);
  });
});

describe("放回输入框的文本拼法", () => {
  it("多条用空行隔开、顺序不变（重发时一眼分得清是几条）", () => {
    expect(joinDroppedTexts(["甲", "乙", "丙"])).toBe("甲\n\n乙\n\n丙");
    expect(joinDroppedTexts(["只有一条"])).toBe("只有一条");
  });

  it("输入框里已有草稿 → 放回的内容前置、不覆盖草稿；没有草稿 → 原样", () => {
    expect(prependRestoredToDraft("", "丢掉的话")).toBe("丢掉的话");
    expect(prependRestoredToDraft("   \n", "丢掉的话")).toBe("丢掉的话");
    expect(prependRestoredToDraft("正在写的草稿", "丢掉的话")).toBe(
      "丢掉的话\n\n正在写的草稿",
    );
  });
});

describe("droppedNoticeTitle：卡片标题取服务端文案首行", () => {
  it("摘要列表（「：\\n- …」）不重复进标题——完整文本在下面单独展示", () => {
    const text =
      "本轮出错，3 条排队消息未送达、请重新发送：\n- 第一条摘要\n- 第二条摘要\n…等 3 条";
    expect(droppedNoticeTitle(text)).toBe(
      "本轮出错，3 条排队消息未送达、请重新发送",
    );
  });

  it("没有冒号 / 单行文案原样保留；空串给兜底", () => {
    expect(droppedNoticeTitle("会话已关闭，2 条排队消息未送达、请重新发送")).toBe(
      "会话已关闭，2 条排队消息未送达、请重新发送",
    );
    expect(droppedNoticeTitle("")).toBe("排队消息未送达、请重新发送");
  });
});

describe("接线源码契约", () => {
  const rows = read("components", "tasks", "event-stream", "rows.tsx");
  const card = read("components", "tasks", "event-stream", "dropped-queue-card.tsx");
  const actions = read("components", "tasks", "event-stream", "stream-actions.tsx");
  const eventStream = read("components", "tasks", "event-stream.tsx");

  it("rows：info 带 droppedTexts 时在 chat / log 分叉之前分流到 DroppedQueueCard", () => {
    const idx = rows.indexOf("extractDroppedTexts(ev.meta)");
    const chatIdx = rows.indexOf("// ---------- chat 形态");
    expect(idx).toBeGreaterThan(0);
    expect(chatIdx).toBeGreaterThan(0);
    expect(idx).toBeLessThan(chatIdx);
    expect(rows).toContain("<DroppedQueueCard");
  });

  it("卡片：完整展示每条丢掉的文本 + 复制 + 放回输入框（能力由 StreamActions 注入、没有就不画按钮）", () => {
    expect(card).toContain("放回输入框");
    expect(card).toContain("CopyButton");
    expect(card).toContain("onRestoreDraft");
    expect(card).toContain("useStreamActions");
    // 卡片自己不碰草稿 / 输入框
    expect(card).not.toContain("useRichInput");
    expect(card).not.toContain("saveDraft");
  });

  it("StreamActions 声明 onRestoreDraft；EventStream（握着草稿）仅在有输入岛时注入", () => {
    expect(actions).toContain("onRestoreDraft?:");
    expect(eventStream).toContain("onRestoreDraft");
    expect(eventStream).toContain("prependRestoredToDraft");
    expect(eventStream).toContain("<StreamActionsProvider");
  });
});
