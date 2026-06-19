/**
 * 兜底 A：chat「没把回答写成正文就想挂等」纯判定单测。
 *
 * 防的事故：chat agent 查完代码 / 只 thinking 就直接 wait_for_user、用户看到空白回复。
 * 2026-06-19 大幅简化：只守「本轮欠回答 + 没发任何非空正文 → 拦」这一条纯客观判定，
 * 删掉了所有语义识别（纯宣告 / 强弱信号 / 答后又查没回报）——它们反复误伤正常对话、是 NLP 无底洞。
 * 所以这里只测两件事：① obligation 边界（本轮欠不欠用户回答）② 有没有发过非空正文。
 */
import { describe, expect, it } from "vitest";

import {
  PREMATURE_CHAT_WAIT_EVENT_LIMIT,
  classifyPrematureChatWait,
} from "@/lib/server/premature-chat-wait";
import type { EventKind, TaskEvent } from "@/lib/types";

// 事件构造器：自增 id + ts，保证顺序稳定
let seq = 0;
const ev = (
  kind: EventKind,
  text = "",
  meta?: Record<string, unknown>,
): TaskEvent => {
  seq += 1;
  return { id: `e${seq}`, ts: 1_700_000_000_000 + seq, kind, text, ...(meta ? { meta } : {}) };
};

const CHAT_START = "Chat 任务启动（model: x、Chat MCP: y）";
// 带 meta 指向首条消息事件的「Chat 任务启动」
const chatStartWithFirstMsg = (firstMessageEventId: string): TaskEvent =>
  ev("info", CHAT_START, { firstMessageEventId });

describe("classifyPrematureChatWait", () => {
  it("0. IO 包装必须读全量事件，避免长轮次把 obligation 边界挤出窗口", () => {
    expect(PREMATURE_CHAT_WAIT_EVENT_LIMIT).toBe(0);
  });

  it("1. resume 起手：chat_start 后无 user_reply / 无工具 / 无正文 → 放行(false)", () => {
    const start = ev("info", CHAT_START);
    expect(classifyPrematureChatWait([start])).toBe(false);
  });

  it("2. 首条消息(meta)：只有 thinking 后就 wait → 拦(true)", () => {
    const um = ev("user_reply", "渠道分级怎么配？");
    const start = chatStartWithFirstMsg(um.id);
    const think = ev("thinking", "用户在问配置化…");
    expect(classifyPrematureChatWait([um, start, think])).toBe(true);
  });

  it("3. 首条消息(meta)：grep/read 后没正文 → 拦(true)", () => {
    const um = ev("user_reply", "这块逻辑在哪？");
    const start = chatStartWithFirstMsg(um.id);
    const t1 = ev("tool_call", "grep 渠道分级");
    const t2 = ev("tool_call", "read config.ts");
    expect(classifyPrematureChatWait([um, start, t1, t2])).toBe(true);
  });

  it("4. 轮内追问 / 催促：user_reply 后无工具无正文就 wait → 拦(true)", () => {
    const um = ev("user_reply", "首问");
    const start = chatStartWithFirstMsg(um.id);
    const ans = ev("assistant_message", "这是回答");
    const nag = ev("user_reply", "你还没回答我啊！");
    const think = ev("thinking", "用户提醒我…");
    expect(classifyPrematureChatWait([um, start, ans, nag, think])).toBe(true);
  });

  it("5. 正常回答：user_reply 后 assistant_message、无后续工具 → 放行(false)", () => {
    const um = ev("user_reply", "问题");
    const start = chatStartWithFirstMsg(um.id);
    const ans = ev("assistant_message", "完整答案在此");
    expect(classifyPrematureChatWait([um, start, ans])).toBe(false);
  });

  it("6. 查完回答：user_reply 后 tool_call、再 assistant_message → 放行(false)", () => {
    const um = ev("user_reply", "问题");
    const start = chatStartWithFirstMsg(um.id);
    const tool = ev("tool_call", "grep");
    const ans = ev("assistant_message", "查到的结论");
    expect(classifyPrematureChatWait([um, start, tool, ans])).toBe(false);
  });

  it("7. 简化后：答完正文、哪怕之后又调了工具 → 放行(false)（不再做「答后又查没回报」判定）", () => {
    const um = ev("user_reply", "问题");
    const start = chatStartWithFirstMsg(um.id);
    const ans = ev("assistant_message", "初步答案");
    const tool = ev("tool_call", "再确认一下 grep");
    expect(classifyPrematureChatWait([um, start, ans, tool])).toBe(false);
  });

  it("8. 兼容旧日志(无 meta)：user_reply 紧贴 chat_start 前一格、只 thinking → 拦(true)", () => {
    const um = ev("user_reply", "首问");
    const start = ev("info", CHAT_START); // 无 meta
    const think = ev("thinking", "…");
    expect(classifyPrematureChatWait([um, start, think])).toBe(true);
  });

  it("9. meta 抗中间插入：user_reply 与 chat_start 间插了 info、靠 meta 仍能识别 → 拦(true)", () => {
    const um = ev("user_reply", "首问");
    const noise = ev("info", "为了可观测性插一条日志");
    const start = chatStartWithFirstMsg(um.id); // 相邻已被打断、但 meta 在
    const think = ev("thinking", "…");
    expect(classifyPrematureChatWait([um, noise, start, think])).toBe(true);
  });

  it("9b. 对照：同样插了 info 但无 meta（旧日志）→ 相邻断了、识别不到 obligation、放行(false)", () => {
    const um = ev("user_reply", "首问");
    const noise = ev("info", "插一条日志");
    const start = ev("info", CHAT_START); // 无 meta、相邻又被打断
    const think = ev("thinking", "…");
    expect(classifyPrematureChatWait([um, noise, start, think])).toBe(false);
  });

  it("10. resume 自检后 wait：无人等回答、读了历史也放行(false)——兜底只守『用户问题不空白』", () => {
    const start = ev("info", CHAT_START); // 无 firstMessage、无 user_reply
    const tool = ev("tool_call", "read 历史 events");
    expect(classifyPrematureChatWait([start, tool])).toBe(false);
  });

  it("11. 空 assistant_message 不算回答：首条消息后只发了空白正文 → 拦(true)", () => {
    const um = ev("user_reply", "问题");
    const start = chatStartWithFirstMsg(um.id);
    const blank = ev("assistant_message", "   ");
    expect(classifyPrematureChatWait([um, start, blank])).toBe(true);
  });

  it("12. 窗口外无 run 起点、无 user_reply → fail-open 放行(false)", () => {
    const t = ev("tool_call", "grep");
    const think = ev("thinking", "…");
    expect(classifyPrematureChatWait([t, think])).toBe(false);
  });

  it("13. 长首轮：首条消息后 400+ 次工具调用、无正文 → 仍能靠全量事件识别 → 拦(true)", () => {
    const um = ev("user_reply", "这个项目里腾讯云的外呼有做呼入功能吗");
    const start = chatStartWithFirstMsg(um.id);
    const tools = Array.from({ length: 450 }, (_, i) =>
      ev("tool_call", `grep/read 第 ${i + 1} 次`),
    );
    expect(classifyPrematureChatWait([um, start, ...tools])).toBe(true);
  });

  // ---- 本次 bug 回归（2026-06-19）：用户问 wait_for_user、agent 答里含该词不再被误伤 ----
  it("14. 用户问 wait_for_user、agent 答含该词的解释 → 放行(false)（旧强信号会误拦、已删）", () => {
    const um = ev("user_reply", "你不调用waitforuser？");
    const start = chatStartWithFirstMsg(um.id);
    const ans = ev(
      "assistant_message",
      "你说得对，Chat 模式下每轮回复后都要调 wait_for_user，这是对话循环能持续的关键。",
    );
    expect(classifyPrematureChatWait([um, start, ans])).toBe(false);
  });

  it("15. 用户问 wait_for_user 但 agent 只 thinking 没发正文 → 仍拦(true)（空白底线不变）", () => {
    const um = ev("user_reply", "你不调用waitforuser？");
    const start = chatStartWithFirstMsg(um.id);
    const think = ev("thinking", "用户问为何没调 wait_for_user");
    expect(classifyPrematureChatWait([um, start, think])).toBe(true);
  });
});
