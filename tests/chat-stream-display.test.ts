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
  isMarkdownUserReply,
  isScheduleUserReply,
  isStopMarkerInfo,
  resolveStickyTurn,
  shouldCollapseUserMessage,
  shouldShowTurnDivider,
  userReplyDisplayText,
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

describe("userReplyDisplayText / isScheduleUserReply：user_reply 给人看的文本（气泡与粘顶头共用）", () => {
  const BOILERPLATE = "[SCHEDULE_FIRED id=sch_a]\n这是你之前设的定时……\n标题：看 CI\n去看 CI 结果";

  it("定时触发：显示 AI 当时留给自己的话，不是整段 [SCHEDULE_FIRED …] 样板", () => {
    const e = { text: BOILERPLATE, meta: { source: "schedule", scheduleMessage: "  去看 CI 结果  " } };
    expect(isScheduleUserReply(e)).toBe(true);
    expect(userReplyDisplayText(e)).toBe("去看 CI 结果");
  });

  it("定时触发但 meta 里没有 scheduleMessage（旧数据）→ 回落原文，不显示空白", () => {
    expect(userReplyDisplayText({ text: BOILERPLATE, meta: { source: "schedule" } })).toBe(BOILERPLATE);
    expect(userReplyDisplayText({ text: BOILERPLATE, meta: { source: "schedule", scheduleMessage: "   " } })).toBe(
      BOILERPLATE,
    );
  });

  it("飞书群里属主自己的消息：剥内部前缀；剥空了回落原文", () => {
    expect(
      userReplyDisplayText({ text: "[群消息·来自 李四]\n这个接口啥时候好？", meta: { source: "feishu_group" } }),
    ).toBe("这个接口啥时候好？");
    expect(userReplyDisplayText({ text: "[群消息·来自 李四]", meta: { source: "feishu_group" } })).toBe(
      "[群消息·来自 李四]",
    );
  });

  it("普通用户消息 / 没有 meta / 没有 text：原样（不误剥）", () => {
    expect(userReplyDisplayText({ text: "[Bug] 登录失败" })).toBe("[Bug] 登录失败");
    expect(userReplyDisplayText({ text: "你好", meta: { source: "feishu" } })).toBe("你好");
    expect(userReplyDisplayText({})).toBe("");
    expect(isScheduleUserReply({})).toBe(false);
    expect(isScheduleUserReply({ meta: { source: "feishu" } })).toBe(false);
  });
});

describe("isMarkdownUserReply：只有飞书群里机器人发来的才按 markdown 渲染", () => {
  it("source=feishu_group 且服务端明写 groupSenderIsBot=true → 是", () => {
    expect(isMarkdownUserReply({ meta: { source: "feishu_group", groupSenderIsBot: true } })).toBe(true);
  });

  it("真人群消息（没写 groupSenderIsBot / false）、用户自己输入、飞书私聊、定时触发 → 都不是（保持纯文本，`*` `_` 不被当排版）", () => {
    expect(isMarkdownUserReply({ meta: { source: "feishu_group" } })).toBe(false);
    expect(isMarkdownUserReply({ meta: { source: "feishu_group", groupSenderIsBot: false } })).toBe(false);
    // 只认严格的 true：字符串 / 数字都不算（不猜）
    expect(isMarkdownUserReply({ meta: { source: "feishu_group", groupSenderIsBot: "true" } })).toBe(false);
    expect(isMarkdownUserReply({ meta: { source: "feishu_group", groupSenderIsBot: 1 } })).toBe(false);
    expect(isMarkdownUserReply({})).toBe(false);
    expect(isMarkdownUserReply({ meta: null })).toBe(false);
    expect(isMarkdownUserReply({ meta: { source: "feishu" } })).toBe(false);
    // 不是群消息却带着 groupSenderIsBot（脏数据）：不渲染
    expect(isMarkdownUserReply({ meta: { groupSenderIsBot: true } })).toBe(false);
    expect(isMarkdownUserReply({ meta: { source: "schedule", groupSenderIsBot: true } })).toBe(false);
  });
});

describe("resolveStickyTurn：粘顶头显示展示文本（review 🟡）", () => {
  it("定时触发的那一轮粘顶头显示 AI 留的话，不是原始样板；普通轮次不受影响", () => {
    const items = [
      { id: "u1", kind: "user_reply", text: "普通问题" },
      { id: "a1", kind: "assistant_message", text: "回答" },
      {
        id: "s1",
        kind: "user_reply",
        text: "[SCHEDULE_FIRED id=sch_a]\n……样板……",
        meta: { source: "schedule", scheduleMessage: "去看 CI 结果" },
      },
      { id: "a2", kind: "assistant_message", text: "好的" },
    ];
    expect(resolveStickyTurn(items, 1)).toEqual({ id: "u1", text: "普通问题" });
    expect(resolveStickyTurn(items, 3)).toEqual({ id: "s1", text: "去看 CI 结果" });
  });
});

describe("resolveStickyTurn（粘顶轮次头）", () => {
  const items = [
    { id: "u1", kind: "user_reply", text: "问题一" },
    { id: "a1", kind: "assistant_message", text: "回答一" },
    { id: "u2", kind: "user_reply", text: "问题二" },
    { id: "g1", kind: "__work_group__" },
    { id: "a2", kind: "assistant_message", text: "回答二" },
  ];

  it("视口顶正好是 user_reply → 不粘（自身还看得见）", () => {
    expect(resolveStickyTurn(items, 0)).toBeNull();
    expect(resolveStickyTurn(items, 2)).toBeNull();
  });

  it("滚过 user_reply 落到其后的回答/工作组 → 粘那条问题", () => {
    expect(resolveStickyTurn(items, 1)).toEqual({ id: "u1", text: "问题一" });
    expect(resolveStickyTurn(items, 3)).toEqual({ id: "u2", text: "问题二" });
    expect(resolveStickyTurn(items, 4)).toEqual({ id: "u2", text: "问题二" });
  });

  it("空列表 / 负下标 → null", () => {
    expect(resolveStickyTurn([], 0)).toBeNull();
    expect(resolveStickyTurn(items, -1)).toBeNull();
  });

  it("边界来回翻（localIdx 在 user_reply 与下一项之间）结果应稳定可判定", () => {
    // 防回归：旧实现在这两态之间 setState → Virtuoso 重渲 → startIndex 振荡
    expect(resolveStickyTurn(items, 2)).toBeNull();
    expect(resolveStickyTurn(items, 3)?.id).toBe("u2");
    expect(resolveStickyTurn(items, 2)).toBeNull();
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

  // 2026-10-16 用户实测：「正在发送首包…」时点停止，首包没回、没有任何 agent 活动事件，
  // boot 行没人清、一直挂在「用户停止了对话」下面
  describe("用户停止（meta.stopped 标记）", () => {
    const stopEv = (): TaskEvent =>
      ev("info", {
        text: "用户停止了对话（agent 已中断、可继续发消息）",
        meta: { stopped: true },
      });

    it("boot 行之后落了停止标记 → 无活跃进度（停止后不再转圈）", () => {
      const events = [
        ev("user_reply", { text: "挺火的" }),
        bootEv("mcp", "正在检查 MCP…"),
        bootEv("send", "正在发送首包…"),
        stopEv(),
      ];
      expect(extractActiveBootStage(events)).toBeNull();
    });

    it("停止后 user_reply 又进来（排队 / 重发）也不会让旧 boot 行借尸还魂", () => {
      const events = [
        ev("user_reply"),
        bootEv("send", "正在发送首包…"),
        stopEv(),
        ev("user_reply", { text: "再发一条" }),
      ];
      expect(extractActiveBootStage(events)).toBeNull();
    });

    it("停止之后新一轮的 boot 行照常显示（它在停止标记之后、回扫先命中它）", () => {
      const events = [
        ev("user_reply"),
        bootEv("send", "正在发送首包…"),
        stopEv(),
        ev("user_reply", { text: "再发一条" }),
        bootEv("resume", "正在恢复对话…"),
      ];
      expect(extractActiveBootStage(events)?.text).toBe("正在恢复对话…");
    });

    it("只认 meta 标记：普通 info（含文案像停止的）不算边界；非 info 带 stopped 也不算", () => {
      const plain = ev("info", { text: "用户停止了对话（假装的）" });
      const nonInfo = ev("user_reply", { meta: { stopped: true } });
      expect(isStopMarkerInfo(plain)).toBe(false);
      expect(isStopMarkerInfo(nonInfo)).toBe(false);
      expect(isStopMarkerInfo(stopEv())).toBe(true);
      expect(
        extractActiveBootStage([
          ev("user_reply"),
          bootEv("create", "正在创建会话…"),
          plain,
        ])?.text,
      ).toBe("正在创建会话…");
    });
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