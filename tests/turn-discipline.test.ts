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

  it("chat 段含飞书缺权限指引（只推免审、不重试、不静默降级）", () => {
    const chat = chatTurnProtocolSection();
    expect(chat).toContain("app_scope_not_applied");
    expect(chat).toContain("只推免审");
    expect(chat).toContain("静默降级");
    // P2：免审举例不得再含群成员（成员列表要审核、只告知）
    expect(chat).not.toContain("群成员、群信息");
    expect(chat).toContain("群成员列表");
  });
});
