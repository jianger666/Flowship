import { describe, expect, it } from "vitest";

import {
  groupChatRenderItems,
  isBootInfoItem,
  isBootInfoText,
  isWorkGroup,
  type WorkGroupItem,
} from "../src/lib/chat-turns";
import type { StreamRenderItem } from "../src/lib/tool-display";
import type { TaskEvent } from "../src/lib/types";

const ev = (
  partial: Partial<TaskEvent> & Pick<TaskEvent, "id" | "kind" | "text">,
): TaskEvent => ({
  ts: 1,
  ...partial,
});

const boot = (id: string, text: string, ts = 1): TaskEvent =>
  ev({ id, kind: "info", text, ts });

// 线上真实文案（2026-09-23 用户截图那 6 行里的启动 5 行）
const BOOT_TEXTS = [
  "正在唤醒当前阶段…",
  "已唤醒当前 出方案 阶段（n=38）、新 agent 接手继续",
  "正在准备工作区…",
  "正在启动 agent…（model: gemini-3.8-flash、系统工具 + MCP: context7, wk-knowledge, insights）",
  "⚠️ 已跳过 1 个不可用的 MCP：figma-desktop（连接失败：fetch failed（connect ECONNREFUSED 127.0.0.1:3845））——相关能力本次不可用、去设置页检查 / 授权",
];

describe("isBootInfoText", () => {
  it("5 类启动链文案命中", () => {
    for (const t of BOOT_TEXTS) expect(isBootInfoText(t)).toBe(true);
  });

  it("操作反馈不命中：停止标记 / 批次通知 / 已回复", () => {
    expect(
      isBootInfoText("用户停止了 出方案 action（agent 已中断、可重新「推进」）"),
    ).toBe(false);
    expect(isBootInfoText("本次新增 1 个批次，已并入方案")).toBe(false);
    expect(isBootInfoText("已回复")).toBe(false);
    expect(isBootInfoText("已完成，产出已更新，请审阅。")).toBe(false);
  });

  it("非字符串不命中", () => {
    expect(isBootInfoText(undefined)).toBe(false);
    expect(isBootInfoText(null)).toBe(false);
    expect(isBootInfoText("")).toBe(false);
  });
});

describe("isBootInfoItem", () => {
  it("只有 kind=info 且文案命中才算", () => {
    expect(isBootInfoItem(boot("b1", BOOT_TEXTS[0]!))).toBe(true);
    // 同文案但 kind 不是 info → 不算
    expect(
      isBootInfoItem(ev({ id: "t1", kind: "thinking", text: BOOT_TEXTS[0]! })),
    ).toBe(false);
    // kind 是 info 但文案不对 → 不算
    expect(
      isBootInfoItem(ev({ id: "i1", kind: "info", text: "用户停止了 X" })),
    ).toBe(false);
    // 工具块不受影响
    const tool = {
      kind: "__tool_block__",
      id: "tb",
      callId: "tb",
      name: "shell",
      status: "success",
      text: "调用",
      ts: 1,
    } as StreamRenderItem;
    expect(isBootInfoItem(tool)).toBe(false);
  });
});

describe("groupChatRenderItems 启动折叠", () => {
  it("截图场景：user → 启动 5 行 → 停止标记，前 5 行收进一组、停止标记独立", () => {
    const user = ev({ id: "u", kind: "user_reply", text: "2", ts: 1 });
    const boots = BOOT_TEXTS.map((t, i) => boot(`b${i}`, t, 2 + i));
    const stop = ev({
      id: "s",
      kind: "info",
      text: "用户停止了 出方案 action（agent 已中断、可重新「推进」）",
      ts: 10,
    });
    const out = groupChatRenderItems([user, ...boots, stop]);
    expect(out.map((x) => x.kind)).toEqual([
      "user_reply",
      "__work_group__",
      "info",
    ]);
    const g = out[1] as WorkGroupItem;
    expect(isWorkGroup(out[1]!)).toBe(true);
    expect(g.members.map((m) => m.id)).toEqual(["b0", "b1", "b2", "b3", "b4"]);
    expect(g.stepCount).toBe(5);
    expect(out[2]).toMatchObject({ id: "s" });
  });

  it("启动行与后续 thinking 粘成同一组（少占一行是一行）", () => {
    const out = groupChatRenderItems([
      ev({ id: "u", kind: "user_reply", text: "q", ts: 1 }),
      boot("b0", BOOT_TEXTS[0]!, 2),
      boot("b1", BOOT_TEXTS[3]!, 3),
      ev({ id: "t", kind: "thinking", text: "想", ts: 4 }),
    ]);
    expect(out.map((x) => x.kind)).toEqual(["user_reply", "__work_group__"]);
    expect((out[1] as WorkGroupItem).members.map((m) => m.id)).toEqual([
      "b0",
      "b1",
      "t",
    ]);
  });

  it("error 照旧隔断：启动组不吞错误", () => {
    const out = groupChatRenderItems([
      boot("b0", BOOT_TEXTS[0]!, 1),
      ev({ id: "e", kind: "error", text: "炸了", ts: 2 }),
    ]);
    expect(out.map((x) => x.kind)).toEqual(["__work_group__", "error"]);
    expect((out[0] as WorkGroupItem).members).toHaveLength(1);
  });

  it("assistant_message 照旧隔断前后组", () => {
    const out = groupChatRenderItems([
      boot("b0", BOOT_TEXTS[2]!, 1),
      ev({ id: "a", kind: "assistant_message", text: "插话", ts: 2 }),
      boot("b1", BOOT_TEXTS[2]!, 3),
    ]);
    expect(out.map((x) => x.kind)).toEqual([
      "__work_group__",
      "assistant_message",
      "__work_group__",
    ]);
  });
});
