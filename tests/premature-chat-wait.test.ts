/**
 * 兜底 A：chat「没把回答写成正文就想挂等」纯判定单测（V0.8.x）
 *
 * 防的事故：chat agent 查完代码 / 只 thinking 就直接 wait_for_user、用户看到空白回复。
 * 这套判定分支多（首条消息 / 轮内追问 / resume 起手 / 答后又查 / meta 关联 vs 旧日志相邻回退），
 * typecheck + lint 只证语法、协议正确性必须喂事件数组测边界（reviewAI 拍板）。
 *
 * 对齐 shell-guard-rules / submit-mr-guard 的「guard 纯逻辑 + 配套单测」惯例。
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

// 工具调用事件的结构化 meta：mcp 工具带 { name:"mcp", innerToolName }、shell 带 { name:"shell" }
// （兜底 A 据结构化字段判「等待握手」、不再靠展示文本子串）
const mcpToolEvent = (innerToolName: string): TaskEvent =>
  ev("tool_call", `调用 mcp: {"toolName":"${innerToolName}"}`, {
    name: "mcp",
    innerToolName,
  });
const shellEvent = (command: string): TaskEvent =>
  ev("tool_call", `调用 shell: {"command":"${command}"}`, { name: "shell" });
// 真·wait-ack 长连接 curl（含 /api/tasks/.../wait-ack 端点）
const WAIT_ACK_CURL =
  'curl -sN \\"http://127.0.0.1:8776/api/tasks/t_x/wait-ack?token=abc\\"';

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

  it("7. 答后又查没回报：assistant_message 后 tool_call → 拦(true)", () => {
    const um = ev("user_reply", "问题");
    const start = chatStartWithFirstMsg(um.id);
    const ans = ev("assistant_message", "初步答案");
    const tool = ev("tool_call", "再确认一下 grep");
    expect(classifyPrematureChatWait([um, start, ans, tool])).toBe(true);
  });

  // ---- 线上事故回归（2026-06-16）：wait_for_user / wait-ack 是「等待握手」、不算干活 ----
  it("7a. 修复后现实：答完正文、wait_for_user 不再写成 tool_call 事件 → 放行(false)", () => {
    const um = ev("user_reply", "你好啊");
    const start = chatStartWithFirstMsg(um.id);
    const think = ev("thinking", "用户在问候");
    const ans = ev("assistant_message", "你好！我是你的对话助手，有什么想聊的直接说。");
    expect(classifyPrematureChatWait([um, start, think, ans])).toBe(false);
  });

  it("7b. 防御：wait_for_user 即便以结构化 mcp tool_call 出现、也不算干活 → 放行(false)", () => {
    const um = ev("user_reply", "你好啊");
    const start = chatStartWithFirstMsg(um.id);
    const ans = ev("assistant_message", "你好！");
    const wait = mcpToolEvent("wait_for_user");
    expect(classifyPrematureChatWait([um, start, ans, wait])).toBe(false);
  });

  it("7b2. 防御：wait_for_user 直发 name（meta.name=wait_for_user）也不算干活 → 放行(false)", () => {
    const um = ev("user_reply", "你好啊");
    const start = chatStartWithFirstMsg(um.id);
    const ans = ev("assistant_message", "你好！");
    const wait = ev("tool_call", "调用 wait_for_user", { name: "wait_for_user" });
    expect(classifyPrematureChatWait([um, start, ans, wait])).toBe(false);
  });

  it("7c. 答后真干活、最后才 wait_for_user：真实 shell grep 仍被识别 → 拦(true)", () => {
    const um = ev("user_reply", "问题");
    const start = chatStartWithFirstMsg(um.id);
    const ans = ev("assistant_message", "初步答案");
    const grep = shellEvent("rg 业务逻辑 src");
    const wait = mcpToolEvent("wait_for_user");
    expect(classifyPrematureChatWait([um, start, ans, grep, wait])).toBe(true);
  });

  it("7d. false-negative 护栏：答后 shell 文本含 /wait-ack 但非 curl wait-ack → 仍算干活 → 拦(true)", () => {
    const um = ev("user_reply", "问题");
    const start = chatStartWithFirstMsg(um.id);
    const ans = ev("assistant_message", "初步答案");
    const grep = shellEvent('rg \\"/wait-ack\\" src'); // 无 curl / 无 /api/tasks/
    expect(classifyPrematureChatWait([um, start, ans, grep])).toBe(true);
  });

  it("7e. false-negative 护栏：答后 shell grep 文本含 wait_for_user（meta.name=shell）→ 仍算干活 → 拦(true)", () => {
    const um = ev("user_reply", "问题");
    const start = chatStartWithFirstMsg(um.id);
    const ans = ev("assistant_message", "初步答案");
    const grep = shellEvent("rg wait_for_user src/lib/server");
    expect(classifyPrematureChatWait([um, start, ans, grep])).toBe(true);
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
    // 这正是 meta 方案要解决的旧日志短板：退化为放行（fail-open）、不误伤
    expect(classifyPrematureChatWait([um, noise, start, think])).toBe(false);
  });

  it("10. wait-ack 的 curl（shell + curl + /api/tasks/ + /wait-ack）不算干活 → 放行(false)", () => {
    const um = ev("user_reply", "问题");
    const start = chatStartWithFirstMsg(um.id);
    const ans = ev("assistant_message", "答案");
    const waitCurl = shellEvent(WAIT_ACK_CURL);
    expect(classifyPrematureChatWait([um, start, ans, waitCurl])).toBe(false);
  });

  it("11. resume 自检后 wait：无人等回答、读了历史也放行(false)——兜底只守『用户问题不空白』", () => {
    const start = ev("info", CHAT_START); // 无 firstMessage、无 user_reply
    const tool = ev("tool_call", "read 历史 events");
    expect(classifyPrematureChatWait([start, tool])).toBe(false);
  });

  it("12. 空 assistant_message 不算回答：首条消息后只发了空白正文 → 拦(true)", () => {
    const um = ev("user_reply", "问题");
    const start = chatStartWithFirstMsg(um.id);
    const blank = ev("assistant_message", "   ");
    expect(classifyPrematureChatWait([um, start, blank])).toBe(true);
  });

  it("13. 窗口外无 run 起点、无 user_reply → fail-open 放行(false)", () => {
    const t = ev("tool_call", "grep");
    const think = ev("thinking", "…");
    expect(classifyPrematureChatWait([t, think])).toBe(false);
  });

  it("14. 长首轮：首条消息后 400+ 次工具调用、仍能靠全量事件识别 obligation → 拦(true)", () => {
    const um = ev("user_reply", "这个项目里腾讯云的外呼有做呼入功能吗");
    const start = chatStartWithFirstMsg(um.id);
    const tools = Array.from({ length: 450 }, (_, i) =>
      ev("tool_call", `grep/read 第 ${i + 1} 次`),
    );
    expect(classifyPrematureChatWait([um, start, ...tools])).toBe(true);
  });
});
