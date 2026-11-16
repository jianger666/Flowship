/**
 * 「被模型方使用政策拦截」的识别 + 连续被拦次数 + 接续历史减带（2026-11-16「接手重构马拉松视频」事故）
 *
 * 事故：run 被 `Request blocked by Anthropic … Usage Policy` 拦下，出错收尾保留落盘 sessionAgentId，
 * 下条消息 Agent.resume 接回——被拦的内容就在那个会话历史里、整份重发，3.9 秒再被拦，聊天再也起不来。
 * 这里锁纯函数：识别口径、事件尾计数、历史逐级减带。接线（出错清锚点 / resume 前跳过）见
 * chat-policy-block-recovery.test.ts。
 */
import { describe, expect, it } from "vitest";

import {
  formatChatHistorySection,
  HISTORY_INJECT_MAX_TURNS,
  HISTORY_INJECT_REDUCED_CHARS,
  HISTORY_INJECT_REDUCED_TURNS,
  selectChatHistoryTurns,
} from "@/lib/chat-history-inject";
import {
  countTrailingPolicyBlocks,
  historyLevelForBlockStreak,
  isAnchorBlockedSession,
  isPolicyBlockEvent,
  isPolicyBlockText,
  POLICY_BLOCK_AGENT_META_KEY,
  trailingPolicyBlock,
} from "@/lib/policy-block";

/** SDK 实际给的拦截串（事故现场原文） */
const BLOCKED_RAW =
  "agent run status=error\n--- SDK stream error message ---\nRequest blocked by Anthropic We are unable to complete this request because it was blocked under Anthropic's Usage Policy.\n--- SDK result dump ---\n{}";

type Ev = {
  id?: string;
  kind: string;
  text?: string;
  meta?: Record<string, unknown>;
};
const ev = (kind: string, text = "", meta?: Record<string, unknown>): Ev => ({
  kind,
  text,
  ...(meta ? { meta } : {}),
});
/** 修复前落盘的旧事件：只有正文里的拦截文案、没有 meta.policyBlock */
const oldSdkErrorEvent = (): Ev =>
  ev(
    "error",
    "SDK ERROR：Request blocked by Anthropic We are unable to complete this request because it was blocked under Anthropic's Usage Policy.",
  );
const oldRunErrorEvent = (): Ev =>
  ev("error", `Chat agent 异常：${BLOCKED_RAW}`);
/** 新版落盘的拦截事件：友好文案 + meta.policyBlock */
const newRunErrorEvent = (): Ev =>
  ev("error", "Chat agent 异常：本轮请求被模型方…", {
    policyBlock: true,
    detail: BLOCKED_RAW,
  });

describe("isPolicyBlockText：只认「被 Anthropic 拦」这个整体", () => {
  it("事故现场原文 → 命中（含 SDK 的 stream error message 形态）", () => {
    expect(isPolicyBlockText(BLOCKED_RAW)).toBe(true);
    expect(
      isPolicyBlockText("Request blocked by Anthropic We are unable…"),
    ).toBe(true);
    // 弯引号 / 无撇号写法
    expect(isPolicyBlockText("blocked under Anthropic’s Usage Policy")).toBe(true);
    expect(isPolicyBlockText("blocked under Anthropics Usage Policy")).toBe(true);
  });

  it("别的报错顺带提到政策 / 限流 / 空值 → 不命中（宁可少判，别把无关错误当拦截清锚点）", () => {
    expect(isPolicyBlockText("rate limit exceeded, see usage policy page")).toBe(false);
    expect(isPolicyBlockText("Network request failed")).toBe(false);
    expect(isPolicyBlockText("")).toBe(false);
    expect(isPolicyBlockText(undefined)).toBe(false);
    expect(isPolicyBlockText(null)).toBe(false);
  });
});

describe("isPolicyBlockEvent", () => {
  it("新事件：meta.policyBlock=true（即使正文是友好文案、没有拦截原文）", () => {
    expect(isPolicyBlockEvent(newRunErrorEvent())).toBe(true);
  });

  it("旧事件：靠正文 / meta.detail 里的拦截原文认（修复前就卡住的对话要能被识别）", () => {
    expect(isPolicyBlockEvent(oldSdkErrorEvent())).toBe(true);
    expect(isPolicyBlockEvent(oldRunErrorEvent())).toBe(true);
    expect(
      isPolicyBlockEvent(ev("error", "Chat agent 异常：某友好文案", { detail: BLOCKED_RAW })),
    ).toBe(true);
  });

  it("不是 error 的事件 / 别的 error → false（assistant 正文里聊到这句话也不算）", () => {
    expect(isPolicyBlockEvent(ev("assistant_message", BLOCKED_RAW))).toBe(false);
    expect(isPolicyBlockEvent(ev("user_reply", BLOCKED_RAW))).toBe(false);
    expect(isPolicyBlockEvent(ev("tool_result", BLOCKED_RAW))).toBe(false);
    expect(isPolicyBlockEvent(ev("error", "Chat agent 异常：fetch failed"))).toBe(false);
  });
});

describe("countTrailingPolicyBlocks：事件尾连续被拦几次", () => {
  it("没有拦截 / 空 → 0", () => {
    expect(countTrailingPolicyBlocks([])).toBe(0);
    expect(
      countTrailingPolicyBlocks([ev("user_reply", "你好"), ev("assistant_message", "你好呀")]),
    ).toBe(0);
  });

  it("事故形态①：干活中途被拦（先有工具进展）→ 1", () => {
    expect(
      countTrailingPolicyBlocks([
        ev("user_reply", "继续"),
        ev("assistant_message", "我先查"),
        ev("tool_call", "shell"),
        ev("tool_result", "pgrep 输出"),
        oldSdkErrorEvent(),
        ev("thinking", "（拦截后才落盘的思考）"),
        oldRunErrorEvent(),
      ]),
    ).toBe(1);
  });

  it("事故形态②：用户说「继续呢」→ resume 后秒被再拦 → 2（一轮里的两条 error 只算一次）", () => {
    expect(
      countTrailingPolicyBlocks([
        ev("assistant_message", "我先查"),
        ev("tool_call", "shell"),
        ev("tool_result", "pgrep 输出"),
        oldSdkErrorEvent(),
        oldRunErrorEvent(),
        ev("user_reply", "继续呢"),
        oldSdkErrorEvent(),
        oldRunErrorEvent(),
      ]),
    ).toBe(2);
  });

  it("再继续被拦一次 → 3（用户消息 / 会话重建 info 夹在中间不打断）", () => {
    expect(
      countTrailingPolicyBlocks([
        ev("tool_call", "shell"),
        oldRunErrorEvent(),
        ev("user_reply", "继续呢"),
        newRunErrorEvent(),
        ev("user_reply", "再试一次"),
        ev("info", "会话已重建：AI 保留了最近 4 轮对话文字"),
        newRunErrorEvent(),
      ]),
    ).toBe(3);
  });

  it("末尾是用户刚发的新消息、还没被拦 → 不把它算成一次拦截（起新会话读历史时就是这个形态）", () => {
    expect(
      countTrailingPolicyBlocks([
        ev("tool_call", "shell"),
        oldRunErrorEvent(),
        ev("user_reply", "继续呢"),
      ]),
    ).toBe(1);
  });

  it("模型在新会话里正常产出过（assistant_message）→ 链断、归 0：历史没毒，后来才被拦", () => {
    expect(
      countTrailingPolicyBlocks([
        oldRunErrorEvent(),
        ev("user_reply", "继续呢"),
        ev("assistant_message", "好，我接着来"),
      ]),
    ).toBe(0);
  });

  it("被拦之前有 tool_call（模型过了请求关、动过手）→ 到此为止，不往更早数", () => {
    expect(
      countTrailingPolicyBlocks([
        oldRunErrorEvent(),
        ev("user_reply", "继续呢"),
        ev("tool_call", "shell"),
        newRunErrorEvent(),
      ]),
    ).toBe(1);
  });

  it("中间夹了别的失败（网络断）→ 链断：那是另一种失败、不能算连续被拦", () => {
    expect(
      countTrailingPolicyBlocks([
        oldRunErrorEvent(),
        ev("user_reply", "继续呢"),
        ev("error", "Chat agent 异常：fetch failed"),
        ev("user_reply", "再来"),
        newRunErrorEvent(),
      ]),
    ).toBe(1);
  });
});

/** 新版收尾落的拦截事件：除 policyBlock 外还记了「是哪个会话被拦」 */
const blockedBy = (agentId: string): Ev =>
  ev("error", "Chat agent 异常：本轮请求被模型方…", {
    policyBlock: true,
    [POLICY_BLOCK_AGENT_META_KEY]: agentId,
    detail: BLOCKED_RAW,
  });

describe("trailingPolicyBlock：带出最近一轮是哪个会话被拦", () => {
  it("meta 键名不是 agentId（子代理转录事件已占用 meta.agentId）", () => {
    expect(POLICY_BLOCK_AGENT_META_KEY).toBe("policyBlockAgentId");
    expect(POLICY_BLOCK_AGENT_META_KEY).not.toBe("agentId");
  });

  it("streak 与 countTrailingPolicyBlocks 一致；没记会话 id 的旧事件 → 不带 agentId 字段", () => {
    const old = [ev("tool_call", "shell"), oldSdkErrorEvent(), oldRunErrorEvent()];
    expect(trailingPolicyBlock(old)).toEqual({ streak: 1 });
    expect(trailingPolicyBlock([])).toEqual({ streak: 0 });
    expect(trailingPolicyBlock(old).streak).toBe(countTrailingPolicyBlocks(old));
  });

  it("读最近一轮里记了会话 id 的那条（SDK ERROR 在前没记、Chat agent 异常在后记了）", () => {
    expect(
      trailingPolicyBlock([
        ev("tool_call", "shell"),
        oldSdkErrorEvent(),
        blockedBy("agent_A"),
      ]),
    ).toEqual({ streak: 1, agentId: "agent_A" });
  });

  it("多轮连续被拦只取最近一轮的会话（更早一轮是另一个会话也不看）", () => {
    expect(
      trailingPolicyBlock([
        ev("tool_call", "shell"),
        blockedBy("agent_A"),
        ev("user_reply", "继续呢"),
        ev("info", "会话已重建"),
        blockedBy("agent_B"),
      ]),
    ).toEqual({ streak: 2, agentId: "agent_B" });
  });

  it("最近一轮没记会话 id、更早一轮记了 → 不借用更早的（否则会把旧会话 id 安到新被拦的会话头上）", () => {
    expect(
      trailingPolicyBlock([
        ev("tool_call", "shell"),
        blockedBy("agent_A"),
        ev("user_reply", "继续呢"),
        oldRunErrorEvent(),
      ]),
    ).toEqual({ streak: 2 });
  });

  it("空串 / 非字符串的会话 id 一律当没记", () => {
    expect(
      trailingPolicyBlock([
        ev("tool_call", "shell"),
        ev("error", "x", { policyBlock: true, [POLICY_BLOCK_AGENT_META_KEY]: "" }),
        ev("error", "x", { policyBlock: true, [POLICY_BLOCK_AGENT_META_KEY]: 42 }),
      ]),
    ).toEqual({ streak: 1 });
  });
});

describe("isAnchorBlockedSession：现锚点是不是被拦的那个会话", () => {
  it("没有拦截 → false", () => {
    expect(isAnchorBlockedSession([], "agent_A")).toBe(false);
    expect(
      isAnchorBlockedSession(
        [ev("user_reply", "你好"), ev("assistant_message", "你好呀")],
        "agent_A",
      ),
    ).toBe(false);
  });

  it("被拦的就是现锚点（Agent.resume 得到同 id）→ true", () => {
    expect(
      isAnchorBlockedSession(
        [ev("tool_call", "shell"), blockedBy("agent_A"), ev("user_reply", "继续呢")],
        "agent_A",
      ),
    ).toBe(true);
  });

  it("【回归】被拦后已起新会话 B、B 还没产出就被问到 → false（别把健康的 B 当毒会话丢掉）", () => {
    expect(
      isAnchorBlockedSession(
        [
          ev("tool_call", "shell"),
          blockedBy("agent_A"),
          ev("user_reply", "继续呢"),
          ev("info", "会话已重建：AI 保留了最近 4 轮对话文字"),
          ev("thinking", "（B 在想）"),
        ],
        "agent_B",
      ),
    ).toBe(false);
  });

  it("B 自己又被拦（最近一轮记的是 B）→ 对 B 是 true、对旧的 A 是 false", () => {
    const events = [
      ev("tool_call", "shell"),
      blockedBy("agent_A"),
      ev("user_reply", "继续呢"),
      blockedBy("agent_B"),
    ];
    expect(isAnchorBlockedSession(events, "agent_B")).toBe(true);
    expect(isAnchorBlockedSession(events, "agent_A")).toBe(false);
  });

  it("修复前的旧事件没记会话 id → 按原口径：事件尾上还有拦截、任何锚点都算毒（不能放过卡住的老对话）", () => {
    const events = [
      ev("tool_call", "shell"),
      oldSdkErrorEvent(),
      oldRunErrorEvent(),
      ev("user_reply", "继续呢"),
    ];
    expect(isAnchorBlockedSession(events, "agent_whatever")).toBe(true);
  });

  it("被拦之后模型有过正常产出 → false（与记没记会话 id 无关）", () => {
    expect(
      isAnchorBlockedSession(
        [blockedBy("agent_A"), ev("user_reply", "继续呢"), ev("assistant_message", "好")],
        "agent_A",
      ),
    ).toBe(false);
  });
});

describe("historyLevelForBlockStreak：逐级减带", () => {
  it("0/1 → full；2 → reduced；≥3 → none", () => {
    expect(historyLevelForBlockStreak(0)).toBe("full");
    expect(historyLevelForBlockStreak(1)).toBe("full");
    expect(historyLevelForBlockStreak(2)).toBe("reduced");
    expect(historyLevelForBlockStreak(3)).toBe("none");
    expect(historyLevelForBlockStreak(9)).toBe("none");
  });
});

/** 造 n 对对话 + 末尾 k 次「被拦 + 用户重试」，最后一条是用户刚发的新消息 */
const longHistoryThenBlocks = (pairs: number, blocks: number): Ev[] => {
  const out: Ev[] = [];
  for (let i = 0; i < pairs; i++) {
    out.push(ev("user_reply", `问 ${i}`), ev("assistant_message", `答 ${i}`));
  }
  out.push(ev("tool_call", "shell"));
  for (let b = 0; b < blocks; b++) {
    out.push(oldRunErrorEvent(), ev("user_reply", `重试 ${b}`));
  }
  return out;
};

describe("selectChatHistoryTurns × 连续被拦：起新会话时逐级减带", () => {
  it("没被拦：照旧最多 12 轮，且结果里不出现 omittedForPolicyBlock（不改变既有形状）", () => {
    const got = selectChatHistoryTurns(longHistoryThenBlocks(10, 0));
    expect(got.turns.length).toBe(HISTORY_INJECT_MAX_TURNS);
    expect("omittedForPolicyBlock" in got).toBe(false);
  });

  it("被拦 1 次：照旧 12 轮（丢掉毒会话后带正常摘要就够）", () => {
    const got = selectChatHistoryTurns(longHistoryThenBlocks(10, 1));
    // 12 轮的上限里包含了「重试 0」这条用户消息
    expect(got.turns.length).toBe(HISTORY_INJECT_MAX_TURNS);
    expect(got.omittedForPolicyBlock).toBeUndefined();
  });

  it("被拦 2 次：减到最近 4 轮、字数封顶也压小", () => {
    const got = selectChatHistoryTurns(longHistoryThenBlocks(10, 2));
    expect(got.turns.length).toBe(HISTORY_INJECT_REDUCED_TURNS);
    expect(got.truncated).toBe(true);
    expect(got.omittedForPolicyBlock).toBeUndefined();
    // 保留的是最近的几轮
    expect(got.turns[got.turns.length - 1].text).toBe("重试 1");

    const huge = "字".repeat(HISTORY_INJECT_REDUCED_CHARS);
    const capped = selectChatHistoryTurns([
      ev("user_reply", "老问题"),
      ev("assistant_message", huge),
      ev("tool_call", "shell"),
      oldRunErrorEvent(),
      ev("user_reply", "重试 0"),
      oldRunErrorEvent(),
      ev("user_reply", "重试 1"),
    ]);
    const total = capped.turns.reduce((n, t) => n + t.text.length, 0);
    expect(total).toBeLessThanOrEqual(HISTORY_INJECT_REDUCED_CHARS);
  });

  it("被拦 ≥3 次：一条历史都不带，并标明原因（保证最后一定能起来）", () => {
    const got = selectChatHistoryTurns(longHistoryThenBlocks(10, 3));
    expect(got.turns).toEqual([]);
    expect(got.omittedForPolicyBlock).toBe(3);
  });

  it("本来就没有历史（新对话首条）→ 照旧空且不带 omitted 标记", () => {
    const got = selectChatHistoryTurns(
      [ev("user_reply", "第一句", undefined)].map((e) => ({ ...e, id: "now" })),
      { skipEventId: "now" },
    );
    expect(got).toEqual({ turns: [], truncated: false });
  });
});

describe("formatChatHistorySection：一条历史都没带时要交代清楚", () => {
  it("omittedForPolicyBlock → 说明被拦 N 次、没带历史、只读对话正文别读工具输出", () => {
    const lines = formatChatHistorySection({
      turns: [],
      truncated: true,
      omittedForPolicyBlock: 3,
    });
    const text = lines.join("\n");
    expect(text).toContain("被安全策略连续拦截");
    expect(text).toContain("连续 3 次");
    expect(text).toContain("user_reply / assistant_message");
    expect(text).toContain("不要");
    expect(text).toContain("tool_result");
    // 事件日志路径在起手 prompt 里排在这一段**上面**——不能写成「下方」
    expect(text).toContain("上文「任务事件日志」");
    expect(text).not.toContain("下方事件日志");
  });

  it("普通空历史仍返回 []（不误出这一段）", () => {
    expect(formatChatHistorySection({ turns: [], truncated: false })).toEqual([]);
  });

  it("有历史时仍是原来的「本窗口已有对话」段", () => {
    const lines = formatChatHistorySection({
      turns: [{ kind: "user_reply", text: "你好" }],
      truncated: false,
    });
    expect(lines[0]).toBe("## 本窗口已有对话（接续，不是新开）");
  });
});
