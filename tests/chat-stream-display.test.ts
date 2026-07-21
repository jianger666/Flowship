/**
 * chat 消息流展示纯逻辑单测（2026-07-20 Codex 化批次）
 * - 超长用户消息折叠判定（A2）
 * - 轮次分割线判定（A3）
 * - 启动进度渐进单行归并（F）
 */
import { describe, expect, it } from "vitest";

import {
  USER_MSG_COLLAPSE_CHARS,
  USER_MSG_COLLAPSE_LINES,
  extractActiveBootStage,
  isBootStageInfo,
  shouldCollapseUserMessage,
  shouldShowTurnDivider,
} from "@/lib/chat-stream-display";
import type { TaskEvent } from "@/lib/types";

// 最小事件构造：只填判定用到的字段
let seq = 0;
const ev = (
  kind: TaskEvent["kind"],
  extra?: Partial<TaskEvent>,
): TaskEvent => ({
  id: extra?.id ?? `ev_${++seq}`,
  ts: extra?.ts ?? seq,
  kind,
  text: extra?.text ?? "",
  ...(extra?.meta ? { meta: extra.meta } : {}),
});

/** 启动进度 info（server publishBootProgress 形状） */
const bootEv = (stage: string, text: string): TaskEvent =>
  ev("info", {
    id: `ephemeral_boot_${stage}_${seq + 1}`,
    text,
    meta: { stage, bootStage: true },
  });

describe("shouldCollapseUserMessage（超长用户消息折叠）", () => {
  it("短消息不折叠", () => {
    expect(shouldCollapseUserMessage("你好")).toBe(false);
    expect(shouldCollapseUserMessage("")).toBe(false);
  });

  it("恰好 N 行不折叠、超过 N 行折叠", () => {
    const exactly = Array(USER_MSG_COLLAPSE_LINES).fill("行").join("\n");
    const over = Array(USER_MSG_COLLAPSE_LINES + 1).fill("行").join("\n");
    expect(shouldCollapseUserMessage(exactly)).toBe(false);
    expect(shouldCollapseUserMessage(over)).toBe(true);
  });

  it("无换行的超长单行（大段粘贴）按字符数兜底折叠", () => {
    expect(
      shouldCollapseUserMessage("x".repeat(USER_MSG_COLLAPSE_CHARS + 1)),
    ).toBe(true);
    expect(
      shouldCollapseUserMessage("x".repeat(USER_MSG_COLLAPSE_CHARS)),
    ).toBe(false);
  });

  it("阈值可覆盖", () => {
    expect(shouldCollapseUserMessage("a\nb\nc", 2)).toBe(true);
    expect(shouldCollapseUserMessage("a\nb", 2)).toBe(false);
  });
});

describe("shouldShowTurnDivider（每轮分割线）", () => {
  it("第一条用户消息（第一轮）不画", () => {
    expect(shouldShowTurnDivider(["user_reply"], 0)).toBe(false);
  });

  it("前面有过对话轮（assistant 回过）→ 画", () => {
    const kinds = ["user_reply", "thinking", "assistant_message", "user_reply"];
    expect(shouldShowTurnDivider(kinds, 3)).toBe(true);
  });

  it("首条用户消息前只有过程行 / 虚拟项 → 不画（不算轮）", () => {
    const kinds = ["info", "__tool_block__", "user_reply"];
    expect(shouldShowTurnDivider(kinds, 2)).toBe(false);
  });

  it("非 user_reply 项一律不画", () => {
    const kinds = ["user_reply", "assistant_message"];
    expect(shouldShowTurnDivider(kinds, 1)).toBe(false);
  });

  it("连续两条用户消息：第二条也算新一轮", () => {
    const kinds = ["user_reply", "user_reply"];
    expect(shouldShowTurnDivider(kinds, 1)).toBe(true);
  });

  // Batch C：turn 无正文时整轮只有工作组，下一轮 user_reply 仍应画分割线
  it("此前只有 __work_group__（正文被吸组）→ 画", () => {
    const kinds = ["user_reply", "__work_group__", "user_reply"];
    expect(shouldShowTurnDivider(kinds, 2)).toBe(true);
  });
});

describe("isBootStageInfo（启动进度行识别）", () => {
  it("meta.bootStage 主判定命中", () => {
    expect(isBootStageInfo(bootEv("mcp", "正在检查 MCP…"))).toBe(true);
  });

  it("旧 shape（仅 meta.stage + ephemeral_boot_ 前缀）兜底命中", () => {
    const legacy = ev("info", {
      id: "ephemeral_boot_create_123",
      text: "正在创建会话…",
      meta: { stage: "create" },
    });
    expect(isBootStageInfo(legacy)).toBe(true);
  });

  it("普通 info / 其他 kind 不命中", () => {
    expect(isBootStageInfo(ev("info", { text: "随便一条" }))).toBe(false);
    expect(
      isBootStageInfo(ev("thinking", { meta: { bootStage: true } })),
    ).toBe(false);
    // meta.stage 存在但 id 不是 ephemeral_boot_ 前缀（撞名防御）
    expect(
      isBootStageInfo(ev("info", { id: "ev_x", meta: { stage: "mcp" } })),
    ).toBe(false);
  });
});

describe("extractActiveBootStage（渐进单行归并）", () => {
  it("三条依次到达：始终只取最新一条", () => {
    const base = [ev("user_reply", { text: "第一条" })];
    const mcp = bootEv("mcp", "正在检查 MCP…");
    const create = bootEv("create", "正在创建会话…");
    const send = bootEv("send", "正在发送首包…");

    expect(extractActiveBootStage([...base, mcp])?.text).toBe(
      "正在检查 MCP…",
    );
    expect(extractActiveBootStage([...base, mcp, create])?.text).toBe(
      "正在创建会话…",
    );
    expect(extractActiveBootStage([...base, mcp, create, send])?.text).toBe(
      "正在发送首包…",
    );
  });

  it("assistant 活动出现后整组消失", () => {
    const events = [
      ev("user_reply"),
      bootEv("mcp", "正在检查 MCP…"),
      bootEv("send", "正在发送首包…"),
      ev("assistant_message", { text: "你好" }),
    ];
    expect(extractActiveBootStage(events)).toBeNull();
  });

  it("thinking / tool_call / error 同样视为对话开始", () => {
    for (const kind of ["thinking", "tool_call", "error"] as const) {
      const events = [ev("user_reply"), bootEv("mcp", "…"), ev(kind)];
      expect(extractActiveBootStage(events)).toBeNull();
    }
  });

  it("boot 期间排队进来的 user_reply 不压制进度行", () => {
    const events = [
      ev("user_reply"),
      bootEv("create", "正在创建会话…"),
      ev("user_reply", { text: "排队的第二条" }),
    ];
    expect(extractActiveBootStage(events)?.text).toBe("正在创建会话…");
  });

  it("历史加载（无 boot 行——不落盘）不显示", () => {
    const events = [
      ev("user_reply"),
      ev("assistant_message"),
      ev("user_reply"),
      ev("assistant_message"),
    ];
    expect(extractActiveBootStage(events)).toBeNull();
    expect(extractActiveBootStage([])).toBeNull();
  });
});
