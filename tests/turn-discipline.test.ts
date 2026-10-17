/**
 * 回合纪律 prompt 片段：chat / task 对 ask_user 措辞一致性
 */
import { describe, expect, it } from "vitest";

import { readFileSync } from "node:fs";
import path from "node:path";

import {
  ASK_USER_TURN_LINE,
  WAIT_TOOL_TURN_LINE,
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

describe("turn-discipline wait 工具单一源", () => {
  it("WAIT_TOOL_TURN_LINE 正向引导调 wait，并点明三件事：别 sleep / 别用原生 await、只睡不检查、间隔拉长", () => {
    expect(WAIT_TOOL_TURN_LINE).toContain("`wait`");
    expect(WAIT_TOOL_TURN_LINE).toContain("sleep");
    expect(WAIT_TOOL_TURN_LINE).toContain("await");
    expect(WAIT_TOOL_TURN_LINE).toContain("不替你检查");
    expect(WAIT_TOOL_TURN_LINE).toContain("间隔拉长");
  });

  it("chat / task 段都引用同一行（不各写各的，改措辞只改一处）", () => {
    expect(chatTurnProtocolSection()).toContain(WAIT_TOOL_TURN_LINE);
    expect(turnDisciplineSection()).toContain(WAIT_TOOL_TURN_LINE);
  });

  it("与「不要为闲聊 / 交卷执行等待」不矛盾：那两条禁的原话还在，wait 是另一件事", () => {
    expect(chatTurnProtocolSection()).toContain("不要为闲聊执行等待 / 轮询");
    expect(turnDisciplineSection()).toContain("不要为交卷执行等待 / 轮询");
  });

  it("WAIT_TOOL_TURN_LINE 带「别拿它空等」约束：手头能做的先做、等用户不是 wait 的活", () => {
    expect(WAIT_TOOL_TURN_LINE).toContain("别拿它空等");
    expect(WAIT_TOOL_TURN_LINE).toContain("ask_user");
  });

  // _super.md 不注入 turnDisciplineSection（避免和核心机制复读），所以 wait 的纪律要自己写一段。
  // 复审指出：之前只是挂在「不要执行等待命令」那条末尾的半句、也没有任何防空转约束；
  // 现在是独立的 `wait` 段——下面把共享行里的关键措辞对一遍，改共享行时这里会提醒同步
  describe("task 主提示词 _super.md 的 wait 段", () => {
    const sup = readFileSync(
      path.resolve(import.meta.dirname, "..", "prompts", "_super.md"),
      "utf-8",
    );
    const section = (() => {
      const start = sup.indexOf("**`wait`（等外部的事）**");
      // 找不到就让整组用例带着可读的原因失败（describe 体里不用 expect）
      if (start < 0) throw new Error("_super.md 缺「`wait`（等外部的事）」段");
      const end = sup.indexOf("\n## ", start);
      return sup.slice(start, end);
    })();

    it("「不要执行任何等待 / 轮询命令」那条还在，并指向 wait 段（二者不矛盾）", () => {
      expect(sup).toContain("不要执行任何等待 / 轮询命令");
      expect(sup).toMatch(/不要执行任何等待 \/ 轮询命令[^\n]*`wait` 段/);
    });

    it("独立成段、且位于核心机制里（在「用户操作怎么到你手上」之前）", () => {
      expect(section.startsWith("**`wait`（等外部的事）**")).toBe(true);
      expect(sup.indexOf("**`wait`（等外部的事）**")).toBeLessThan(
        sup.indexOf("## 用户操作怎么到你手上"),
      );
    });

    it("与共享行同口径：别 sleep / 别用原生 await、只睡不检查、间隔拉长、别空等", () => {
      for (const phrase of [
        "sleep",
        "await",
        "不替你检查",
        "间隔拉长",
        "别拿它空等",
        "`ask_user`",
      ]) {
        expect(section, phrase).toContain(phrase);
        expect(WAIT_TOOL_TURN_LINE, phrase).toContain(phrase);
      }
    });

    it("交代四种返回前缀怎么处理：跳过不代表事已好、被停止立刻收手", () => {
      expect(section).toContain("[WAIT_SKIPPED]");
      expect(section).toContain("不代表事已好");
      expect(section).toContain("[WAIT_INTERRUPTED]");
      expect(section).toContain("[WAIT_CANCELLED]");
      expect(section).toContain("不再调任何工具");
    });

    it("交卷之后不要再调 wait（防止交卷后挂着不结束本轮）", () => {
      expect(section).toMatch(/交卷[^\n]*之后不要再调/);
    });
  });
});
