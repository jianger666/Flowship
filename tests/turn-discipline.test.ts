/**
 * 回合纪律 prompt 片段：chat / task 对 ask_user 措辞一致性
 */
import { describe, expect, it } from "vitest";

import {
  ASK_USER_TURN_LINE,
  chatTurnProtocolSection,
  turnDisciplineSection,
} from "@/lib/server/turn-discipline";

describe("turn-discipline ask_user 单一源", () => {
  it("ASK_USER_TURN_LINE 正向引导调 ask_user", () => {
    expect(ASK_USER_TURN_LINE).toContain("ask_user");
    expect(ASK_USER_TURN_LINE).toContain("[ASK_USER_REPLY]");
    expect(ASK_USER_TURN_LINE).not.toMatch(/别调/);
  });

  it("chat / task 段都引用同一行、chat 不再禁 ask_user", () => {
    const chat = chatTurnProtocolSection();
    const task = turnDisciplineSection();
    expect(chat).toContain(ASK_USER_TURN_LINE);
    expect(task).toContain(ASK_USER_TURN_LINE);
    expect(chat).not.toMatch(/别调 `ask_user`/);
    expect(chat).not.toMatch(/chat 模式禁用/);
  });
});
