/**
 * chat 占位气泡展示分类 + 发出后空窗进度行触发判定（纯函数）。
 *
 * 钉死的产品语义：回车后不再出现「发送中…」虚线气泡——立即发送显示为正式气泡 + 进度行；
 * 只有排队（上一轮还在跑）和状态不明才保留待定样式。
 *
 * 同一个空窗里输入框一侧的判定（2026-10-12 补）：气泡已经说「AI 在处理了」，输入框就必须按运行态画
 * （停止键），而不是只剩一个转圈的发送键；受理前点停止要等提交落地再停（热路径发送前快照窗口里
 * 没有占位，直接停会让 AI 在「已停止」之后被重新拉起）。
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  classifyPendingBubble,
  decideChatStop,
  hasInflightPending,
  hasPendingBubbleContent,
  loadingSinceTs,
  resolveLoadingStart,
  settleStopIntent,
  shouldShowComposerRunning,
  shouldShowComposerStopOnly,
  shouldShowSendLoading,
} from "@/lib/chat-pending-display";
import {
  emptyChatOpState,
  reduceChatOperation,
  shouldHideLocalPlaceholder,
} from "@/lib/chat-pending-reconcile";

describe("classifyPendingBubble", () => {
  it("立即发送（没排队、状态正常）→ inflight：渲染成正式气泡", () => {
    expect(classifyPendingBubble({})).toBe("inflight");
    expect(classifyPendingBubble({ uncertain: false, queued: false })).toBe(
      "inflight",
    );
  });

  it("提交时 run 在跑 → queued：保留待定样式并改说「排队中」", () => {
    expect(classifyPendingBubble({ queued: true })).toBe("queued");
  });

  it("状态不明（uncertain）优先于一切：不能装作已发出，沿用旧样式", () => {
    expect(classifyPendingBubble({ uncertain: true })).toBeUndefined();
    expect(classifyPendingBubble({ uncertain: true, queued: true })).toBeUndefined();
  });
});

describe("hasInflightPending", () => {
  it("只有 inflight 才算；queued / 旧样式 / 空都不算", () => {
    expect(hasInflightPending(undefined)).toBe(false);
    expect(hasInflightPending([])).toBe(false);
    expect(hasInflightPending([{ mode: "queued" }, { mode: undefined }])).toBe(false);
    expect(hasInflightPending([{ mode: "queued" }, { mode: "inflight" }])).toBe(true);
  });
});

describe("shouldShowSendLoading", () => {
  it("原有语义不变：已受理 + 末项是用户消息 + AI 还没动静", () => {
    expect(
      shouldShowSendLoading({ isRunning: true, lastIsUser: true, hasInflight: false }),
    ).toBe(true);
    expect(
      shouldShowSendLoading({ isRunning: true, lastIsUser: false, hasInflight: false }),
    ).toBe(false);
    expect(
      shouldShowSendLoading({ isRunning: false, lastIsUser: true, hasInflight: false }),
    ).toBe(false);
  });

  it("新增：回车后、user_reply 还没落盘（runStatus 可能还没 running）就要有进度行", () => {
    // 冷路径：恢复会话那几秒 runStatus 还是 idle，且末项是上一轮的回复
    expect(
      shouldShowSendLoading({ isRunning: false, lastIsUser: false, hasInflight: true }),
    ).toBe(true);
    // 受理了但 user_reply 还没落盘的窗口：isRunning 已真、末项仍是上一轮回复
    expect(
      shouldShowSendLoading({ isRunning: true, lastIsUser: false, hasInflight: true }),
    ).toBe(true);
  });

  it("占位 → 落盘交接：两段都为真时只出一个进度行（调用方用同一个 __loading__ 项）", () => {
    expect(
      shouldShowSendLoading({ isRunning: true, lastIsUser: true, hasInflight: true }),
    ).toBe(true);
  });
});

describe("shouldShowComposerRunning", () => {
  it("回车后提交还在飞、服务端还没受理（isRunning 仍假）→ 就按运行态画：不能只剩转圈的发送键", () => {
    // 实测这个窗口：热路径 1.3–2.7s、冷路径 4.5–6.7s——气泡已是正式消息、列表末尾是「准备环境…」，
    // 输入框却没有停止键，用户想停也停不了（这是本次要修的现象）
    expect(
      shouldShowComposerRunning({ isRunning: false, submitting: true, awaitingAsk: false }),
    ).toBe(true);
  });

  it("run 在跑 → 运行态（原有语义不变，含提交已落地后的常规情形）", () => {
    expect(
      shouldShowComposerRunning({ isRunning: true, submitting: false, awaitingAsk: false }),
    ).toBe(true);
    // 排队发送：run 在跑 + 又在提交
    expect(
      shouldShowComposerRunning({ isRunning: true, submitting: true, awaitingAsk: false }),
    ).toBe(true);
  });

  it("既没在跑也没在提交 → 常态发送键", () => {
    expect(
      shouldShowComposerRunning({ isRunning: false, submitting: false, awaitingAsk: false }),
    ).toBe(false);
  });

  it("有待答提问时一律不画运行态：回车 = 隐式跳过提问，输入条要保持可发", () => {
    for (const isRunning of [false, true]) {
      for (const submitting of [false, true]) {
        expect(
          shouldShowComposerRunning({ isRunning, submitting, awaitingAsk: true }),
        ).toBe(false);
      }
    }
  });

  // V16-03：后台子代理还在跑时，主 AI 可能早已说完一轮（isRunning 归零）——输入框只剩「发送」键、
  // 没有任何停止入口，用户想停掉后台子代理却无处可点（停止 = 关整个会话，会连带 cancelAll 后台子代理）。
  // 第三轮 R3-02：当初把它并进 shouldShowComposerRunning 会把整套运行态（转圈 / 「排队发送」/ 附件按钮消失）带出来，
  // 改为单独的 shouldShowComposerStopOnly（只多一个停止键）——下面的 describe 钉住这条分工
});

describe("shouldShowComposerStopOnly（R3-02，原 V16-03：后台子代理的停止入口）", () => {
  const idle = { isRunning: false, submitting: false, awaitingAsk: false };

  it("主 AI 空闲但还有后台子代理在跑 → 只多一个停止键（停止键可达），而不是整套运行态", () => {
    expect(shouldShowComposerStopOnly({ ...idle, backgroundSubagentCount: 2 })).toBe(true);
    // 同样的输入下，完整运行态是关的——转圈 / 「排队发送」/ 附件按钮消失都不该出现
    expect(shouldShowComposerRunning(idle)).toBe(false);
  });

  it("后台子代理数是 0 / 没传 → 与原来一致（不凭空多出停止键）", () => {
    expect(shouldShowComposerStopOnly({ ...idle, backgroundSubagentCount: 0 })).toBe(false);
    expect(shouldShowComposerStopOnly(idle)).toBe(false);
  });

  it("有待答提问时后台子代理也不改变「保持可发」：awaitingAsk 仍然最优先", () => {
    expect(
      shouldShowComposerStopOnly({ ...idle, awaitingAsk: true, backgroundSubagentCount: 1 }),
    ).toBe(false);
  });

  it("已经是完整运行态时不重复（运行态自带停止键）", () => {
    expect(
      shouldShowComposerStopOnly({ ...idle, isRunning: true, backgroundSubagentCount: 1 }),
    ).toBe(false);
    expect(
      shouldShowComposerStopOnly({ ...idle, submitting: true, backgroundSubagentCount: 1 }),
    ).toBe(false);
  });
});

describe("decideChatStop", () => {
  it("提交在飞 + 服务端还没受理 → 不能直接停，等提交落地再停", () => {
    // 热路径发送前快照窗口里没有任何占位：此刻 stop 会把会话关掉，随后 sendChatMessage 发现
    // 无会话、落到「起新会话」并重新领 lease——停止后 AI 又被拉起来
    expect(decideChatStop({ submitting: true, runActive: false })).toBe("after_submit");
  });

  it("提交在飞 + 已受理（runActive 已真）→ 直接停：run 已被取消闭包持有", () => {
    // 含两种情形：agent.send 受理后到 HTTP 返回前那几十~几百 ms；以及 AI 在跑时的排队发送
    expect(decideChatStop({ submitting: true, runActive: true })).toBe("now");
  });

  it("没在提交 → 直接停（常规停止；run 没在跑时 stop 本身也是幂等的）", () => {
    expect(decideChatStop({ submitting: false, runActive: true })).toBe("now");
    expect(decideChatStop({ submitting: false, runActive: false })).toBe("now");
  });
});

describe("settleStopIntent", () => {
  it("没登记过停止意图 → 什么都不做（无论提交结果如何）", () => {
    for (const accepted of [false, true]) {
      for (const alive of [false, true]) {
        expect(settleStopIntent({ pending: false, accepted, alive })).toBe("none");
      }
    }
  });

  it("登记过 + 消息已落地 + 任务还在 → 现在兑现这次停止", () => {
    expect(settleStopIntent({ pending: true, accepted: true, alive: true })).toBe("stop");
  });

  it("登记过 + 消息没发出去（被拒 / 状态不明）→ 只收掉「停止中」外观，不 stop", () => {
    // 没有 run 可停；硬 stop 只会落一条多余的「用户停止了对话」，还把用户保留的草稿场景搅乱
    expect(settleStopIntent({ pending: true, accepted: false, alive: true })).toBe("release");
  });

  it("登记过 + 任务已删 / 已切走 → 收掉外观，不 stop（stop 只会 404、弹一条多余的错）", () => {
    expect(settleStopIntent({ pending: true, accepted: true, alive: false })).toBe("release");
    expect(settleStopIntent({ pending: true, accepted: false, alive: false })).toBe("release");
  });
});

describe("loadingSinceTs / resolveLoadingStart：切走再切回后「已等待」接着数", () => {
  it("取最近一条落盘 user_reply 的 ts（末项是用户消息、或其后只跟着启动提示）", () => {
    expect(loadingSinceTs([{ kind: "user_reply", ts: 1000 }], false)).toBe(1000);
    expect(
      loadingSinceTs(
        [
          { kind: "user_reply", ts: 1000 },
          { kind: "assistant_message", ts: 1500 },
          { kind: "user_reply", ts: 2000 },
          { kind: "__work_group__", ts: 2100 },
        ],
        false,
      ),
    ).toBe(2000);
  });

  it("有 inflight 占位时不取：流里最近的 user_reply 是上一轮的，取了会一上来就算成几分钟", () => {
    expect(loadingSinceTs([{ kind: "user_reply", ts: 1000 }], true)).toBeUndefined();
  });

  it("没有 user_reply / ts 缺失或不合法 → undefined（按挂载起算）", () => {
    expect(loadingSinceTs([], false)).toBeUndefined();
    expect(loadingSinceTs([{ kind: "assistant_message", ts: 1 }], false)).toBeUndefined();
    expect(loadingSinceTs([{ kind: "user_reply" }], false)).toBeUndefined();
    expect(loadingSinceTs([{ kind: "user_reply", ts: 0 }], false)).toBeUndefined();
    expect(loadingSinceTs([{ kind: "user_reply", ts: Number.NaN }], false)).toBeUndefined();
  });

  it("resolveLoadingStart：有 since 且不在未来 → 用它；否则（没有 / 时钟偏差的未来值）按挂载那一刻", () => {
    expect(resolveLoadingStart(1000, 5000)).toBe(1000);
    expect(resolveLoadingStart(5000, 5000)).toBe(5000);
    expect(resolveLoadingStart(undefined, 5000)).toBe(5000);
    expect(resolveLoadingStart(9000, 5000)).toBe(5000);
  });

  it("重挂后的已等待秒数：按真实起点算，阶段文案不会退回「准备环境…」", () => {
    const since = 1_000_000;
    const remountAt = since + 20_000;
    const t0 = resolveLoadingStart(since, remountAt);
    expect(Math.floor((remountAt - t0) / 1000)).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// V1-07（第二轮 review）：刷新 / 第二窗口后 bootstrap 重建的占位没有正文，不能画成空白气泡
// ---------------------------------------------------------------------------
describe("hasPendingBubbleContent：占位气泡有没有东西可画", () => {
  it("有文字 → 画", () => {
    expect(hasPendingBubbleContent({ displayText: "稍后帮我看下 CI" })).toBe(true);
  });

  it("没文字也没附件：空白（bootstrap 重建的那种）→ 不画；纯空白字符同理", () => {
    expect(hasPendingBubbleContent({ displayText: "" })).toBe(false);
    expect(hasPendingBubbleContent({ displayText: " \n\t" })).toBe(false);
    expect(
      hasPendingBubbleContent({ displayText: "", images: [], attachments: [], skillRefs: [] }),
    ).toBe(false);
  });

  it("纯附件 / 纯图片 / 纯 skill 的本窗口消息：没文字但确有内容 → 照旧画（不能被一刀切掉）", () => {
    expect(hasPendingBubbleContent({ displayText: "", images: [{}] })).toBe(true);
    expect(hasPendingBubbleContent({ displayText: "", attachments: ["/tmp/a.png"] })).toBe(true);
    expect(hasPendingBubbleContent({ displayText: "", skillRefs: [{ name: "x" }] })).toBe(true);
  });
});

describe("V1-07：bootstrap 重建的排队占位 vs 本窗口登记的占位", () => {
  const snap = (itemId: string) => ({
    type: "queue_state" as const,
    serverItemIds: [itemId],
    recentSettled: [],
    operationSnapshot: [{ itemId, phase: "accepting" }],
  });

  it("刷新后 bootstrap 重建：占位在 ledger 里（计入排队数），但没正文 → 不画气泡", () => {
    const { state } = reduceChatOperation(emptyChatOpState(), snap("cq_rebuilt"));
    expect(state.pending).toHaveLength(1);
    expect(state.pending[0]!.displayText).toBe("");
    // 仍在 ledger：排队条据此显示「N 条排队」并去服务端拉带正文的清单（可编辑 / 删除）
    expect(shouldHideLocalPlaceholder(state.pending[0]!)).toBe(false);
    expect(hasPendingBubbleContent(state.pending[0]!)).toBe(false);
  });

  it("本窗口登记的排队消息（有正文）：照常画", () => {
    const { state } = reduceChatOperation(emptyChatOpState(), {
      type: "register",
      op: {
        id: "cq_local",
        itemId: "cq_local",
        payloadFingerprint: "fp_local",
        persistence: "sending",
        terminalKnowledge: "none",
        networkUncertain: false,
        text: "排队的这一句",
        displayText: "排队的这一句",
      },
    });
    expect(hasPendingBubbleContent(state.pending[0]!)).toBe(true);
  });

  it("本窗口登记的纯附件消息：没文字，但登记时带了附件 → 照常画", () => {
    const { state } = reduceChatOperation(emptyChatOpState(), {
      type: "register",
      op: {
        id: "cq_att",
        itemId: "cq_att",
        payloadFingerprint: "fp_att",
        persistence: "sending",
        terminalKnowledge: "none",
        networkUncertain: false,
        text: "",
        displayText: "",
        attachments: ["/tmp/report.pdf"],
      },
    });
    expect(hasPendingBubbleContent(state.pending[0]!)).toBe(true);
  });

  it("本窗口已登记的占位遇到重连 bootstrap：保留原正文（不被重建成空的）", () => {
    let state = reduceChatOperation(emptyChatOpState(), {
      type: "register",
      op: {
        id: "cq_keep",
        itemId: "cq_keep",
        payloadFingerprint: "fp_keep",
        persistence: "sending",
        terminalKnowledge: "none",
        networkUncertain: false,
        text: "原文",
        displayText: "原文",
      },
    }).state;
    state = reduceChatOperation(state, snap("cq_keep")).state;
    expect(state.pending).toHaveLength(1);
    expect(hasPendingBubbleContent(state.pending[0]!)).toBe(true);
  });
});

describe("V1-07：chat-view 接线（源码契约）", () => {
  const src = readFileSync(
    path.resolve(import.meta.dirname, "..", "src/components/tasks/chat-view.tsx"),
    "utf-8",
  );
  // 含 useMemo 上方那段说明注释
  const memo = src.slice(
    src.indexOf("// 是否渲染本地占位只看 persistence"),
    src.indexOf("useTaskWatch(task.id, {"),
  );

  it("送进事件流的占位要同时过 persisted 隐藏和「有内容可画」两道滤", () => {
    expect(memo).toContain("shouldHideLocalPlaceholder(p)");
    expect(memo).toMatch(/hasPendingBubbleContent\(p\)/);
  });

  it("排队计数（applyLedgerToUi）不过「有内容」滤：重建的占位仍计入，排队条才会出现", () => {
    const apply = src.slice(
      src.indexOf("const applyLedgerToUi = useCallback("),
      src.indexOf("// 切 task：清 streaming 等 UI 态"),
    );
    expect(apply).toContain("shouldHideLocalPlaceholder(p)");
    expect(apply.includes("hasPendingBubbleContent")).toBe(false);
  });

  it("注释说实话：ledger 是纯内存，刷新后占位来自 bootstrap 重建；不再声称「sessionStorage 恢复」", () => {
    expect(src.includes("sessionStorage")).toBe(false);
    expect(memo).toMatch(/纯内存/);
    expect(memo).toMatch(/bootstrap/);
  });
});
