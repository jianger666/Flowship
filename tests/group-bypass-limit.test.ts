/**
 * G3-02：互 @ 熔断删除后缺硬上限 → 保守版硬上限。
 *
 * ① 每个发送人最多占 2 个排队槽（超出走原「满了」口径：真人收忙线文案、机器人静默）。
 * ② 非属主旁路 run 按 task 的 10 分钟滑动窗，窗内最多**启动** 12 次（第六轮口径：起了 run 才计，
 *    另有每发送人 4 次的子限额）；超限**静默丢弃**（不回群消息），
 *    且只写一条节流的 info 事件（每类每窗最多一条）。属主自己、答 pendingAsk 不受限。
 *
 * 路由级用例走真实 routeGroupInboundMessage / pump，只 mock 最外层的注入与发群消息。
 * 第六轮口径的路由级验收（忙线拒收不占名额 / 回放起 run 才计 / 个人限额 / 重投去重 / 失败退还）
 * 在 group-bypass-admit-at-start.test.ts；本文件的纯函数层覆盖 admitGroupBypassRun 自身。
 */
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FeishuInboundMessage } from "@/lib/server/feishu-bridge/types";
import type { Task, TaskSummary } from "@/lib/types";

// 旁路限流的 info 事件走真实落盘太重——mock 掉写入口，只断言写了什么
const writeOwnedEventAndPublish = vi.hoisted(() =>
  vi.fn(async () => ({ id: "ev_mock" })),
);
vi.mock("@/lib/server/task-stream", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/task-stream")>();
  return { ...actual, writeOwnedEventAndPublish };
});

process.env.FLOWSHIP_DATA_DIR = path.join(
  os.tmpdir(),
  `group-bypass-limit-${Date.now()}`,
  "data",
);

const {
  __resetGroupChatCacheForTest,
  __setGroupRouteDepsForTest,
  pumpGroupQuestionQueue,
  routeGroupInboundMessage,
} = await import("@/lib/server/feishu-bridge/group-route");
const shared = await import("@/lib/server/feishu-bridge/group-shared");
const { __resetGroupRosterForTest } = await import(
  "@/lib/server/feishu-bridge/group-roster"
);
const { registerRestrictedQuestion, unregisterRestrictedQuestion } = await import(
  "@/lib/server/task-stream"
);

const OWNER = "ou_owner";
const BOT = "ou_bot";
const CHAT = "oc_req_group";
const TASK = "task-1";

/** admitGroupBypassRun 的短写（now 缺省 = 真实时间） */
const admit = (taskId: string, sender: string, messageId: string, now?: number) =>
  shared.admitGroupBypassRun(taskId, { sender, messageId }, now);

const taskSummary = (): TaskSummary =>
  ({
    id: TASK,
    title: "登录优化",
    mode: "task",
    repoStatus: "developing",
    runStatus: "idle",
    updatedAt: Date.now(),
    createdAt: Date.now(),
    repoPaths: ["/tmp/repo"],
    currentActionId: null,
    mrs: [],
    actionCount: 0,
    feishuStoryUrl: "https://project.feishu.cn/space/story/detail/10001",
  }) as TaskSummary;
const fullTask = (): Task =>
  ({ ...taskSummary(), actions: [], events: [] }) as unknown as Task;

const msg = (
  sender: string,
  id: string,
  over: Partial<FeishuInboundMessage> = {},
): FeishuInboundMessage => ({
  type: "im.message.receive_v1",
  message_id: id,
  create_time: String(Date.now()),
  chat_id: CHAT,
  chat_type: "group",
  message_type: "text",
  sender_id: sender,
  sender_name: sender,
  content: "@Flowship 埋点查了吗",
  mentions: [{ key: "@_user_1", openId: BOT, name: "Flowship" }],
  ...over,
});

const ctx = {
  parseContent: async (m: FeishuInboundMessage) => ({
    text: m.content,
    images: [],
    attachments: [],
  }),
  loadBootContext: async () => ({ apiKey: "sk-test", model: { id: "m1" } }),
};

let handleTaskQuestionInject: ReturnType<typeof vi.fn>;
let injectPendingAskText: ReturnType<typeof vi.fn>;
let sendTextToChat: ReturnType<typeof vi.fn>;

const installDeps = (over: Record<string, unknown> = {}) =>
  __setGroupRouteDepsForTest({
    getBotAppInfo: async () => ({ appId: "cli_self", ownerOpenId: OWNER }),
    getBotOpenId: async () => BOT,
    getBotDisplayName: async () => "Flowship",
    fetchGroupRoster: vi.fn(async (chatId: string) => ({
      chatId,
      members: [],
      fetchedAt: Date.now(),
      source: "none" as const,
    })),
    sendTextToChat,
    listTasks: async () => [taskSummary()],
    getTask: async () => fullTask(),
    getBoundGroupChatId: async () => CHAT,
    getPendingAsk: () => null,
    injectPendingAskText,
    handleTaskQuestionInject,
    ...over,
  } as never);

beforeEach(() => {
  __resetGroupRosterForTest();
  __resetGroupChatCacheForTest();
  shared.__resetGroupReplyStateForTest();
  writeOwnedEventAndPublish.mockClear();
  handleTaskQuestionInject = vi.fn(
    async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
  );
  injectPendingAskText = vi.fn(async () => ({ ok: true as const }));
  sendTextToChat = vi.fn(async () => ({ chat_id: CHAT, message_id: "om_r" }));
  installDeps();
});

afterEach(() => {
  vi.useRealTimers();
  __setGroupRouteDepsForTest(null);
  __resetGroupRosterForTest();
  __resetGroupChatCacheForTest();
  shared.__resetGroupReplyStateForTest();
});

const sentTexts = (): string[] =>
  sendTextToChat.mock.calls.map((c) => String((c as unknown[])[1]));
const infoEvents = () =>
  writeOwnedEventAndPublish.mock.calls
    .map((c) => (c as unknown[])[2] as { kind: string; text: string })
    .filter((e) => e.kind === "info");

describe("G3-02 ②：非属主旁路 run 的 task 级滑动窗（10 分钟 / 启动 12 次）", () => {
  it("第 13 个起静默丢弃：不注入、不回群消息，只写一条 info（后续不再写）", async () => {
    const results = [];
    for (let i = 0; i < 12; i++) {
      // 换人发，排除「每发送人槽位」对本用例的干扰（任务空闲、都不进队）
      results.push(await routeGroupInboundMessage(msg(`ou_u${i}`, `om_${i}`), ctx));
    }
    expect(results.every((r) => r.kind === "sent")).toBe(true);
    expect(handleTaskQuestionInject).toHaveBeenCalledTimes(12);
    sendTextToChat.mockClear();

    const r13 = await routeGroupInboundMessage(msg("ou_u13", "om_13"), ctx);
    expect(r13).toMatchObject({ kind: "skipped" });
    expect(handleTaskQuestionInject).toHaveBeenCalledTimes(12);
    // 静默：群里一个字都不回（回了就是给互 @ 的对端喂噪音）
    expect(sendTextToChat).not.toHaveBeenCalled();
    expect(infoEvents()).toHaveLength(1);
    expect(infoEvents()[0]!.text).toContain("12");

    // 窗内继续被丢弃：仍静默、info 不再写（每窗最多一条）
    const r14 = await routeGroupInboundMessage(msg("ou_u14", "om_14"), ctx);
    const r15 = await routeGroupInboundMessage(msg("ou_u15", "om_15"), ctx);
    expect(r14).toMatchObject({ kind: "skipped" });
    expect(r15).toMatchObject({ kind: "skipped" });
    expect(handleTaskQuestionInject).toHaveBeenCalledTimes(12);
    expect(sendTextToChat).not.toHaveBeenCalled();
    expect(infoEvents()).toHaveLength(1);
  });

  it("窗口滑过（10 分钟后）恢复受理，且新一窗超限时可再写一条 info", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000_000);
    for (let i = 0; i < 12; i++) {
      await routeGroupInboundMessage(msg(`ou_u${i}`, `om_${i}`), ctx);
    }
    expect(
      await routeGroupInboundMessage(msg("ou_x", "om_x1"), ctx),
    ).toMatchObject({ kind: "skipped" });
    expect(infoEvents()).toHaveLength(1);

    // 9 分 59 秒：仍在窗内
    vi.setSystemTime(1_000_000 + 10 * 60 * 1000 - 1000);
    expect(
      await routeGroupInboundMessage(msg("ou_x", "om_x2"), ctx),
    ).toMatchObject({ kind: "skipped" });
    expect(infoEvents()).toHaveLength(1);

    // 滑过窗口：最早那批已出窗，恢复受理
    vi.setSystemTime(1_000_000 + 10 * 60 * 1000 + 1000);
    expect(
      await routeGroupInboundMessage(msg("ou_y1", "om_y1"), ctx),
    ).toMatchObject({ kind: "sent" });
  });

  it("属主自己不受限：连发 15 条都照常注入", async () => {
    for (let i = 0; i < 15; i++) {
      const r = await routeGroupInboundMessage(
        msg(OWNER, `om_o${i}`, { content: "@Flowship 继续" }),
        ctx,
      );
      expect(r).toMatchObject({ kind: "sent" });
    }
    expect(handleTaskQuestionInject).toHaveBeenCalledTimes(15);
    expect(infoEvents()).toHaveLength(0);
  });

  it("答 agent 的 ask_user（pendingAsk）不计入、不受限", async () => {
    installDeps({ getPendingAsk: () => ({ askId: "ask-1", questions: [] }) });
    for (let i = 0; i < 15; i++) {
      const r = await routeGroupInboundMessage(
        msg(`ou_a${i}`, `om_a${i}`, { content: "@Flowship 选 B" }),
        ctx,
      );
      expect(r).toMatchObject({ kind: "sent" });
    }
    expect(injectPendingAskText).toHaveBeenCalledTimes(15);
    expect(infoEvents()).toHaveLength(0);
  });

  it("别的 task 的窗口互不影响", async () => {
    // 同一个 chat 只绑一个 task，这里直接验共享状态层的 per-task 隔离
    // 换发送人：每人最多 4 次，12 个名额用 12 个不同的人填满，排除个人限额对本用例的干扰
    for (let i = 0; i < 12; i++) {
      expect(admit("task-A", `ou_${i}`, `om_${i}`).allowed).toBe(true);
    }
    expect(admit("task-A", "ou_12", "om_12").allowed).toBe(false);
    expect(admit("task-B", "ou_0", "om_0").allowed).toBe(true);
  });

  it("排队回放只计一次：入队不计，pump 回放真正起 run 时计一次", async () => {
    const inFlight = { cancelled: false, cancel: () => {} };
    registerRestrictedQuestion(TASK, inFlight);
    try {
      // 3 个不同发送人排队（每人 1 个槽，不触发发送人上限）→ 入队不计
      for (let i = 0; i < 3; i++) {
        expect(
          await routeGroupInboundMessage(msg(`ou_q${i}`, `om_q${i}`), ctx),
        ).toMatchObject({ kind: "queued" });
      }
    } finally {
      unregisterRestrictedQuestion(TASK, inFlight);
    }
    await pumpGroupQuestionQueue(TASK);
    expect(handleTaskQuestionInject).toHaveBeenCalledTimes(3);
    expect(shared.groupQuestionQueueLength(TASK)).toBe(0);

    // 回放起 run 时计 3（不是入队 + 回放的 6）：窗内还剩 9，下面 9 条全过、第 10 条被拒
    for (let i = 0; i < 9; i++) {
      expect(
        await routeGroupInboundMessage(msg(`ou_r${i}`, `om_r${i}`), ctx),
      ).toMatchObject({ kind: "sent" });
    }
    expect(
      await routeGroupInboundMessage(msg("ou_r9", "om_r9"), ctx),
    ).toMatchObject({ kind: "skipped" });
  });
});

describe("G3-02 ①：每个发送人最多占 2 个排队槽", () => {
  const withBusy = async (fn: () => Promise<void>) => {
    const inFlight = { cancelled: false, cancel: () => {} };
    registerRestrictedQuestion(TASK, inFlight);
    try {
      await fn();
    } finally {
      unregisterRestrictedQuestion(TASK, inFlight);
    }
  };

  it("同一人第 3 个排队问题被拒（走忙线口径），别人仍可排", async () => {
    await withBusy(async () => {
      expect(
        await routeGroupInboundMessage(msg("ou_li", "om_1"), ctx),
      ).toMatchObject({ kind: "queued" });
      expect(
        await routeGroupInboundMessage(msg("ou_li", "om_2"), ctx),
      ).toMatchObject({ kind: "queued" });
      const third = await routeGroupInboundMessage(msg("ou_li", "om_3"), ctx);
      expect(third).toMatchObject({ kind: "skipped" });
      expect(shared.groupQuestionQueueLength(TASK)).toBe(2);
      // 真人超槽位：收到忙线文案（与「队满」同口径）
      expect(sentTexts().some((t) => t.includes("群答疑还在跑"))).toBe(true);
      // 别人不受影响
      expect(
        await routeGroupInboundMessage(msg("ou_wang", "om_4"), ctx),
      ).toMatchObject({ kind: "queued" });
      expect(shared.groupQuestionQueueLength(TASK)).toBe(3);
    });
  });

  it("总队长上限 10 照旧：10 个不同发送人排满后第 11 个落回忙线拒收（原『队满』口径）", async () => {
    // feishu-group-inbound 里同名用例是单一发送人连发 10 条——有了发送人槽位后要换人发
    await withBusy(async () => {
      for (let i = 0; i < 10; i++) {
        expect(
          await routeGroupInboundMessage(msg(`ou_s${i}`, `om_f${i}`), ctx),
        ).toMatchObject({ kind: "queued" });
      }
      expect(shared.groupQuestionQueueLength(TASK)).toBe(10);
      const overflow = await routeGroupInboundMessage(msg("ou_s10", "om_over"), ctx);
      expect(overflow).toMatchObject({ kind: "skipped" });
      expect(sentTexts().some((t) => t.includes("群答疑还在跑"))).toBe(true);
      expect(shared.groupQuestionQueueLength(TASK)).toBe(10);
      expect(handleTaskQuestionInject).not.toHaveBeenCalled();
    });
  });

  it("机器人发件人超槽位：照常拒绝，但整条静默（系统回执对机器人静默）", async () => {
    await withBusy(async () => {
      const bot = (id: string) =>
        msg("ou_otherbot", id, { sender_type: "app" } as never);
      expect(await routeGroupInboundMessage(bot("om_b1"), ctx)).toMatchObject({
        kind: "queued",
      });
      expect(await routeGroupInboundMessage(bot("om_b2"), ctx)).toMatchObject({
        kind: "queued",
      });
      sendTextToChat.mockClear();
      expect(await routeGroupInboundMessage(bot("om_b3"), ctx)).toMatchObject({
        kind: "skipped",
      });
      expect(sendTextToChat).not.toHaveBeenCalled();
      expect(shared.groupQuestionQueueLength(TASK)).toBe(2);
    });
  });
});

describe("G3-02 纯函数层", () => {
  const entry = (id: string, openId = "ou_li") => ({
    messageId: id,
    chatId: CHAT,
    text: `问题 ${id}`,
    parsed: { text: "q", images: [], attachments: [] } as never,
    requester: { openId, name: openId },
    boot: null,
  });
  const cap = { maxPerSender: shared.GROUP_QUESTION_QUEUE_MAX_PER_SENDER };

  it("常量口径：2 个槽 / 10 分钟 / 总 12 次 / 每人 4 次", () => {
    expect(shared.GROUP_QUESTION_QUEUE_MAX_PER_SENDER).toBe(2);
    expect(shared.GROUP_BYPASS_RUN_WINDOW_MS).toBe(10 * 60 * 1000);
    expect(shared.GROUP_BYPASS_RUN_WINDOW_MAX).toBe(12);
    expect(shared.GROUP_BYPASS_RUN_WINDOW_MAX_PER_SENDER).toBe(4);
  });

  it("发送人槽位：第 3 个 queued:false/sender_limit；重投已在队的 id 仍幂等；出队后腾出槽位", () => {
    expect(shared.enqueueGroupQuestion(TASK, entry("a1"), Date.now(), cap).queued).toBe(true);
    expect(shared.enqueueGroupQuestion(TASK, entry("a2"), Date.now(), cap).queued).toBe(true);
    const over = shared.enqueueGroupQuestion(TASK, entry("a3"), Date.now(), cap);
    expect(over).toMatchObject({ queued: false, reason: "sender_limit" });
    // 在槽位满时重投 a1：幂等、不被当成超限
    expect(shared.enqueueGroupQuestion(TASK, entry("a1"), Date.now(), cap)).toMatchObject({
      queued: true,
      position: 1,
    });
    // 出队一个 → 腾出槽位
    shared.shiftGroupQuestionQueue(TASK);
    expect(shared.enqueueGroupQuestion(TASK, entry("a3"), Date.now(), cap).queued).toBe(true);
  });

  it("过期条目不占槽位（先清过期再数）", () => {
    const old = 1_000_000;
    shared.enqueueGroupQuestion(TASK, entry("a1"), old, cap);
    shared.enqueueGroupQuestion(TASK, entry("a2"), old, cap);
    const later = old + shared.GROUP_QUESTION_QUEUE_TTL_MS + 1;
    expect(shared.enqueueGroupQuestion(TASK, entry("a3"), later, cap).queued).toBe(true);
  });

  it("不传 maxPerSender 时不限发送人（纯队列函数的原行为不变）", () => {
    for (let i = 0; i < shared.GROUP_QUESTION_QUEUE_MAX; i++) {
      expect(shared.enqueueGroupQuestion(TASK, entry(`m${i}`)).queued).toBe(true);
    }
  });

  it("admitGroupBypassRun：窗内第 13 次拒绝（total），notify 每窗只一次；窗滑过后恢复且可再通知", () => {
    const t0 = 5_000_000;
    for (let i = 0; i < 12; i++) {
      // 12 个不同发送人：排除个人限额的干扰
      expect(admit(TASK, `ou_${i}`, `om_${i}`, t0 + i)).toEqual({
        allowed: true,
        notify: false,
        counted: true,
      });
    }
    expect(admit(TASK, "ou_12", "om_12", t0 + 100)).toEqual({
      allowed: false,
      notify: true,
      scope: "total",
    });
    expect(admit(TASK, "ou_13", "om_13", t0 + 200)).toEqual({
      allowed: false,
      notify: false,
      scope: "total",
    });
    // 被拒的不进窗口（攻击者不能靠狂发把窗口一直续下去）
    expect(
      admit(TASK, "ou_14", "om_14", t0 + shared.GROUP_BYPASS_RUN_WINDOW_MS + 12).allowed,
    ).toBe(true);
    // 新一窗再次超限时可再通知一次（提示以上一次提示 t0+100 起算一整个窗口）
    const slid = t0 + 100 + shared.GROUP_BYPASS_RUN_WINDOW_MS + 100;
    // ou_14 那次（t0+W+12）仍在新窗内占 1 个，再填 11 个 = 12
    for (let i = 0; i < 11; i++) admit(TASK, `ou_n${i}`, `om_n${i}`, slid + 1);
    expect(admit(TASK, "ou_z", "om_z", slid + 2)).toMatchObject({
      allowed: false,
      notify: true,
      scope: "total",
    });
  });

  it("个人限额：同一发送人第 5 次拒绝（sender），别人仍可；个人 / 总限额的 notify 各自每窗一次", () => {
    const t0 = 5_500_000;
    for (let i = 0; i < 4; i++) {
      expect(admit(TASK, "ou_x", `om_x${i}`, t0 + i)).toMatchObject({
        allowed: true,
        counted: true,
      });
    }
    expect(admit(TASK, "ou_x", "om_x4", t0 + 10)).toEqual({
      allowed: false,
      notify: true,
      scope: "sender",
    });
    // 同一个人的个人限额提示每窗一次（按发送人分桶：别的被限的人各有各的一条，见 group-bypass-r7.test.ts K2-08）
    expect(admit(TASK, "ou_x", "om_x5", t0 + 11)).toMatchObject({
      allowed: false,
      notify: false,
      scope: "sender",
    });
    // 别人不受影响：再填 8 个别人（共 12）
    for (let i = 0; i < 8; i++) {
      expect(admit(TASK, `ou_o${i}`, `om_o${i}`, t0 + 20 + i).allowed).toBe(true);
    }
    // 总额满了：先判总限额；它的提示不被个人限额那条吞掉
    expect(admit(TASK, "ou_late", "om_late", t0 + 40)).toEqual({
      allowed: false,
      notify: true,
      scope: "total",
    });
    // 早先 ou_x 的 4 次出窗后，个人额度恢复
    const slid = t0 + shared.GROUP_BYPASS_RUN_WINDOW_MS + 20;
    expect(admit(TASK, "ou_x", "om_x6", slid)).toMatchObject({ allowed: true });
  });

  it("同一 message_id 重投：窗内幂等放行（counted:false）、不占名额，也不被『已满』挡住", () => {
    const t0 = 5_600_000;
    expect(admit(TASK, "ou_x", "om_dup", t0)).toMatchObject({ allowed: true, counted: true });
    expect(admit(TASK, "ou_x", "om_dup", t0 + 1)).toEqual({
      allowed: true,
      notify: false,
      counted: false,
    });
    // 填满总额（om_dup 占 1 个，再 11 个 = 12）
    for (let i = 0; i < 11; i++) admit(TASK, `ou_${i}`, `om_${i}`, t0 + 10 + i);
    expect(admit(TASK, "ou_full", "om_full", t0 + 50).allowed).toBe(false);
    // 已满时重投 om_dup：仍放行、不重复计
    expect(admit(TASK, "ou_x", "om_dup", t0 + 60)).toMatchObject({
      allowed: true,
      counted: false,
    });
    // 出窗后同一 id 当新到处理
    const slid = t0 + shared.GROUP_BYPASS_RUN_WINDOW_MS + 100;
    expect(admit(TASK, "ou_x", "om_dup", slid)).toMatchObject({ allowed: true, counted: true });
  });

  it("releaseGroupBypassRun：退还后名额回来、同 id 重投重新计一次；窗口已滑过 / 不存在的 id 无副作用", () => {
    const t0 = 5_700_000;
    for (let i = 0; i < 12; i++) admit(TASK, `ou_${i}`, `om_${i}`, t0 + i);
    expect(admit(TASK, "ou_x", "om_x", t0 + 20).allowed).toBe(false);
    expect(shared.releaseGroupBypassRun(TASK, "om_3")).toBe(true);
    // 空出 1 个名额
    expect(admit(TASK, "ou_x", "om_x", t0 + 30)).toMatchObject({ allowed: true, counted: true });
    expect(admit(TASK, "ou_y", "om_y", t0 + 31).allowed).toBe(false);
    // om_3 重投：按新到处理（已无计数），但此刻总额又满了
    expect(admit(TASK, "ou_3", "om_3", t0 + 40).allowed).toBe(false);
    // 重复退还 / 未知 id / 未知 task / 空 id：无副作用
    expect(shared.releaseGroupBypassRun(TASK, "om_3")).toBe(false);
    expect(shared.releaseGroupBypassRun(TASK, "om_none")).toBe(false);
    expect(shared.releaseGroupBypassRun("task-none", "om_0")).toBe(false);
    expect(shared.releaseGroupBypassRun(TASK, "")).toBe(false);
    // 计数已出窗：退还不抛错、不影响后来者
    const slid = t0 + shared.GROUP_BYPASS_RUN_WINDOW_MS + 1000;
    expect(admit(TASK, "ou_late", "om_late", slid).allowed).toBe(true);
    expect(shared.releaseGroupBypassRun(TASK, "om_0")).toBe(false);
  });

  it("groupBypassSenderKey：open_id → 其余稳定 ID 格（bot open_id / app_id）→ 展示名（带 name: 前缀，K2-09）", () => {
    const key = shared.groupBypassSenderKey;
    expect(key({ openId: "ou_a", name: "甲" }, ["ou_a", "ou_b", "cli_c"])).toBe("ou_a");
    expect(key({ openId: "", name: "机器人甲" }, [undefined, "", "cli_c"])).toBe("cli_c");
    expect(key({ openId: "", name: "机器人甲" }, ["", "ou_botopen", "cli_c"])).toBe(
      "ou_botopen",
    );
    expect(key({ openId: "", name: "机器人甲" })).toBe("name:机器人甲");
    expect(key({ openId: "", name: "机器人甲" }, [undefined, undefined])).toBe("name:机器人甲");
  });

  it("滑动窗状态挂 globalThis：模块重求值（HMR）后计数不丢（含个人计数与重投去重）", async () => {
    const t0 = 7_000_000;
    for (let i = 0; i < 4; i++) admit(TASK, "ou_x", `om_x${i}`, t0 + i);
    for (let i = 0; i < 8; i++) admit(TASK, `ou_${i}`, `om_${i}`, t0 + 10 + i);
    vi.resetModules();
    const fresh = await import("@/lib/server/feishu-bridge/group-shared");
    expect(fresh).not.toBe(shared);
    const freshAdmit = (sender: string, id: string, now: number) =>
      fresh.admitGroupBypassRun(TASK, { sender, messageId: id }, now);
    expect(freshAdmit("ou_late", "om_late", t0 + 100).allowed).toBe(false);
    // 个人计数也在：ou_x 的重投 id 仍幂等
    expect(freshAdmit("ou_x", "om_x0", t0 + 101)).toMatchObject({
      allowed: true,
      counted: false,
    });
    fresh.__resetGroupReplyStateForTest();
  });

  it("热更前旧形状的窗口（裸时间戳 stamps、无 senderNoticeAt）：不抛错、旧计数自然作废、个人通知可用", () => {
    const g = globalThis as unknown as Record<
      string,
      { bypassWindows: Map<string, unknown> } | undefined
    >;
    const state = g["__flowshipGroupQuestionQueueStateV1__"];
    expect(state).toBeDefined();
    const t0 = 7_500_000;
    state!.bypassWindows.set(TASK, {
      stamps: [t0, t0 + 1, t0 + 2],
      noticeAt: Number.NEGATIVE_INFINITY,
    });
    for (let i = 0; i < 4; i++) {
      expect(admit(TASK, "ou_x", `om_x${i}`, t0 + 10 + i).allowed).toBe(true);
    }
    expect(admit(TASK, "ou_x", "om_x4", t0 + 20)).toMatchObject({
      allowed: false,
      notify: true,
      scope: "sender",
    });
  });

  it("clearGroupQuestionQueue（终结 / 归档 / 删除）一并清掉该 task 的滑动窗状态", () => {
    for (let i = 0; i < 12; i++) admit(TASK, `ou_${i}`, `om_${i}`, 9_000_000 + i);
    expect(admit(TASK, "ou_x", "om_x", 9_000_100).allowed).toBe(false);
    shared.clearGroupQuestionQueue(TASK);
    expect(admit(TASK, "ou_x", "om_x", 9_000_200).allowed).toBe(true);
  });
});
