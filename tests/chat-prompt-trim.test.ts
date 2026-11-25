/**
 * chat 起手 prompt 的「去水分」钉子：删掉的几句不能回来、留下的几句不能被误删。
 * 真调 buildInitialPrompt（`__buildChatInitialPromptForTest`），不是源码字符串断言。
 *
 * 背景（提示词审计）：
 * - 「你能用的工具」只剩「以 schema 为准、别凭记忆猜名字」一句：读 / 搜 / 编辑 / shell 的能力清单是在复述工具 schema；
 * - Skills 的「调用规则」两条是常识，已删；
 * - Cursor 账号级 User Rules 的忽略声明只对 Cursor 后端成立（那个注入只有 Cursor 服务端会做），pi / 自定义后端不再带；
 * - 「回复正文直接输出」只留 recency 钉子（用户当前句之后）这一份——所以钉子本身必须钉住、不能被人当成冗余删掉；
 *   chat 不挂 submit_work（见 chat-system-tools.ts），起手文案也不再提它。
 */
import { describe, expect, it } from "vitest";

import { __buildChatInitialPromptForTest } from "@/lib/server/chat-runner";
import type { Task } from "@/lib/types";

const chatTaskFixture = (): Task =>
  ({
    id: "t_chat_prompt_trim",
    title: "chat prompt trim",
    mode: "chat",
    repoStatus: "developing",
    runStatus: "idle",
    currentActionId: null,
    actions: [],
    mrs: [],
    repoPaths: [],
    createdAt: 1,
    updatedAt: 1,
    events: [],
  }) as unknown as Task;

const USER_TEXT = "帮我看看这个文件";

const build = (isCursorBackend: boolean): string =>
  __buildChatInitialPromptForTest(
    chatTaskFixture(),
    [],
    "（用户规则占位）",
    { text: USER_TEXT },
    "",
    "",
    "",
    "",
    isCursorBackend,
    { turns: [], truncated: false },
  );

const CURSOR_ACCOUNT_RULES = "Cursor 账号级 User Rules";

describe("Cursor 账号级 User Rules 的忽略声明：只对 Cursor 后端注入", () => {
  it("Cursor 后端：带，且夹在「用户规则」与「Skills」两节之间", () => {
    const p = build(true);
    expect(p).toContain(CURSOR_ACCOUNT_RULES);
    expect(p.indexOf("## 用户规则")).toBeLessThan(p.indexOf(CURSOR_ACCOUNT_RULES));
    expect(p.indexOf(CURSOR_ACCOUNT_RULES)).toBeLessThan(p.indexOf("## Skills"));
  });

  it("pi / 自定义后端：不带（那个注入只有 Cursor 服务端会做，对它们是纯噪音）", () => {
    expect(build(false)).not.toContain(CURSOR_ACCOUNT_RULES);
  });

  it("两种后端「用户规则」「Skills」两节都还在（条件注入没误伤相邻内容）", () => {
    for (const cursor of [true, false]) {
      const p = build(cursor);
      expect(p, String(cursor)).toContain("## 用户规则（必遵守）");
      expect(p, String(cursor)).toContain("## Skills（Flowship 自带能力扩展）");
    }
  });
});

describe("「你能用的工具」只声明权威来源，不复述能力清单", () => {
  const p = build(true);

  it("留着：以 schema 为准、别凭记忆猜名字（双链路实测踩过的护栏）", () => {
    expect(p).toContain("## 你能用的工具");
    expect(p).toContain("以你实际收到的工具 schema 为准");
    expect(p).toContain("不要凭记忆猜名字");
  });

  it("删了：能力清单（读 / 搜 / 编辑 / shell …）与「另外还有平台工具」", () => {
    expect(p).not.toContain("核心能力");
    expect(p).not.toContain("按内容搜索");
    expect(p).not.toContain("跑 shell 命令");
    expect(p).not.toContain("另外还有平台工具");
  });
});

describe("Skills 段：「调用规则」两条（常识）已删，索引头还在", () => {
  const p = build(true);

  it("删了", () => {
    expect(p).not.toContain("调用规则");
    expect(p).not.toContain("同一段对话内同一个 skill 通常读一次就够");
  });

  it("留着：命中场景时用 read 读 SKILL.md 的引导", () => {
    expect(p).toContain("命中场景时用 SDK 内置 `read` 工具读取对应 SKILL.md");
  });
});

describe("回合协议：「正文直接输出」只留末尾钉子一份；chat 不再提 submit_work", () => {
  const p = build(true);

  it("起手协议段不再有「回复正文直接输出」条，整份起手 prompt 也不再出现 submit_work", () => {
    expect(p).not.toContain("**回复正文直接输出**");
    expect(p).not.toContain("submit_work");
  });

  it("末尾钉子还在，且钉在用户当前句之后（它现在是唯一一份，别当成冗余删掉）", () => {
    expect(p).toContain("完整答案直接写出来");
    expect(p.indexOf("完整答案直接写出来")).toBeGreaterThan(p.indexOf(USER_TEXT));
  });

  it("留着的回合纪律：说完正常结束回复、不为闲聊等待 / 轮询", () => {
    expect(p).toContain("**说完就正常结束回复**");
    expect(p).toContain("不要为闲聊执行等待 / 轮询");
  });
});
