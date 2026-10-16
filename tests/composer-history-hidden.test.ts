/**
 * G4-06：输入框 ↑ 历史不能带出「事件流里被藏起来的」user_reply。
 *
 * 背景：群里非属主的提问是以 user_reply 落盘的（meta.source=feishu_group + restrictedRunTag），
 * 事件流靠 isHiddenFromEventStream 把它藏进「群问答」tab；buildInputHistory 以前只看
 * kind === "user_reply"，陌生人的问题就会出现在属主输入框的 ↑ 历史里，一按 ↑ 就把别人的话填进去。
 * 隐藏口径只认 isHiddenFromEventStream 这一个闸，这里既测具体场景、也测「与闸一致」的契约。
 *
 * 前端组件没在浏览器里看过；这里只覆盖纯函数（buildInputHistory）。
 */

import { describe, expect, it } from "vitest";

import { buildInputHistory } from "@/lib/composer-history";
import { isHiddenFromEventStream } from "@/lib/event-stream-hidden";
import type { TaskEvent } from "@/lib/types";

let seq = 0;
const ev = (
  kind: TaskEvent["kind"],
  text: string,
  meta?: Record<string, unknown>,
): TaskEvent =>
  ({
    id: `e${++seq}`,
    kind,
    text,
    ts: 1_000 + seq,
    ...(meta ? { meta } : {}),
  }) as TaskEvent;

/** 与 group-route 写的群问题事件同形态：非属主 → 带 restrictedRunTag */
const strangerQuestion = (text: string, runTag = "grp_tok_1"): TaskEvent =>
  ev("user_reply", text, {
    source: "feishu_group",
    feishuMessageId: `om_${runTag}`,
    groupChatId: "oc_x",
    groupSender: "李四",
    groupSenderOpenId: "ou_li",
    restrictedRunTag: runTag,
  });

/** 属主自己在群里说的话：同样是 feishu_group，但没有 restrictedRunTag，事件流里可见 */
const ownerGroupMessage = (text: string): TaskEvent =>
  ev("user_reply", text, {
    source: "feishu_group",
    feishuMessageId: "om_owner",
    groupChatId: "oc_x",
    groupSender: "我",
    groupSenderOpenId: "ou_me",
  });

describe("buildInputHistory：跳过被事件流隐藏的 user_reply（G4-06）", () => {
  it("陌生人的群问题不进 ↑ 历史，属主自己发的照常在", () => {
    const events = [
      ev("user_reply", "帮我看下这个 MR"),
      strangerQuestion("埋点查了吗"),
      ev("assistant_message", "好的"),
      ev("user_reply", "再改一下命名"),
    ];
    expect(buildInputHistory(events)).toEqual([
      "再改一下命名",
      "帮我看下这个 MR",
    ]);
  });

  it("属主自己的群消息（无 restrictedRunTag）事件流里可见，历史里也保留", () => {
    const events = [ownerGroupMessage("群里先说一句"), strangerQuestion("别人的问题")];
    expect(buildInputHistory(events)).toEqual(["群里先说一句"]);
  });

  it("被消音（meta.muted）的 user_reply 同样不进历史", () => {
    const events = [
      ev("user_reply", "正常的一句"),
      ev("user_reply", "被平台消音的一句", { muted: true }),
    ];
    expect(buildInputHistory(events)).toEqual(["正常的一句"]);
  });

  it("隐藏项夹在两条相同消息中间：过滤后相邻去重仍生效", () => {
    const events = [
      ev("user_reply", "继续"),
      strangerQuestion("路人的问题"),
      ev("user_reply", "继续"),
    ];
    expect(buildInputHistory(events)).toEqual(["继续"]);
  });

  it("全是被隐藏的 user_reply → 空历史（↑ 不劫持）", () => {
    expect(
      buildInputHistory([strangerQuestion("a", "t1"), strangerQuestion("b", "t2")]),
    ).toEqual([]);
  });

  it("契约：结果 = 只对「事件流里可见」的 user_reply 取文本（口径只认 isHiddenFromEventStream）", () => {
    const events: TaskEvent[] = [
      ev("user_reply", "u1"),
      strangerQuestion("s1", "t1"),
      ownerGroupMessage("g1"),
      ev("user_reply", "m1", { muted: true }),
      ev("info", "无关"),
      ev("user_reply", "u2", { groupRun: "tokX" }),
      ev("user_reply", "u3"),
    ];
    const expected = events
      .filter((e) => e.kind === "user_reply" && !isHiddenFromEventStream(e))
      .map((e) => e.text.trim())
      .reverse();
    expect(buildInputHistory(events)).toEqual(expected);
    // 自检：这组样本里确实有被闸藏掉的 user_reply，契约断言不是空转
    expect(
      events.some((e) => e.kind === "user_reply" && isHiddenFromEventStream(e)),
    ).toBe(true);
    expect(expected).toEqual(["u3", "g1", "u1"]);
  });
});
