/**
 * 发群失败提示（group-failure-notice）的两处改进（B4-4 / Q12b-03 + Q12b-07）：
 *
 * Q12b-03：机器人被移出群 / 被禁言 / 群解散 / 限流——原来只有英文原文 + 「可到设置页飞书桥接检查」，
 *   桥接本身是好的，设置页对被踢毫无帮助。现在认得出的几类直接说人话 + 给能照做的补救；
 *   认不出的（含缺 scope）照旧。分类判定在 lark-errors（`Command failed: <命令行>` 形态的 message 里带着回复正文，
 *   不参与关键词匹配）。
 * Q12b-07：节流 key 加上「哪类消息」——原来同群一分钟只记一条，同一分钟里「回执」失败占了名额，
 *   随后「答疑回复」失败被吞，属主以为答案发出去了。
 *
 * 外部调用全 mock；任务落盘事件只记「写了什么」。
 */
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const writeOwnedEventAndPublish = vi.hoisted(() =>
  vi.fn<(...args: unknown[]) => Promise<{ id: string } | null>>(async () => ({
    id: "ev_owned",
  })),
);

vi.mock("@/lib/server/task-stream", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/task-stream")>();
  return { ...actual, writeOwnedEventAndPublish };
});

process.env.FLOWSHIP_DATA_DIR = path.join(
  os.tmpdir(),
  `group-failure-notice-kinds-${Date.now()}`,
  "data",
);

const { describeGroupSendFailure, noteGroupSendFailure } = await import(
  "@/lib/server/feishu-bridge/group-failure-notice"
);
const { __resetThrottleForTest, throttleOncePerMinute } = await import(
  "@/lib/server/feishu-bridge/group-shared"
);
const { LarkApiError } = await import("@/lib/server/feishu-bridge/types");
const { normalizeLarkError } = await import("@/lib/server/feishu-bridge/lark-api");

const CHAT = "oc_req_group";
const TASK = "task-1";

const SCOPE_ERR =
  "app scope not applied for the required scope(s): cardkit:card:write. Please apply in the console.";

const BOT_GONE_REASON = "机器人已不在这个群里（可能被移出了群）";
const BOT_GONE_HINT =
  "请在群设置 → 机器人 → 添加机器人里，搜本机机器人的名字加回群，或在「需求群」弹窗换绑一个群";
const NO_PERMISSION_REASON =
  "机器人在这个群里没有发言权限（被禁言，或群设置 / 应用可用范围限制了发言）";
const NO_PERMISSION_HINT = "请到群设置里检查机器人的发言权限（若是应用可用范围限制，需要管理员在开放平台调整），或在「需求群」弹窗换绑一个群";
const CHAT_GONE_REASON = "这个群已经解散或失效";
const CHAT_GONE_HINT = "请在「需求群」弹窗取消关联，或换绑 / 重建一个群";
const RATE_LIMITED_REASON = "飞书限流了";
const RATE_LIMITED_HINT = "稍等一会儿通常就恢复，之后再让它重发";
const GENERIC_HINT = "可到设置页飞书桥接检查，详情见应用日志";

const lark = (
  message: string,
  opts: ConstructorParameters<typeof LarkApiError>[1] = {},
): InstanceType<typeof LarkApiError> => new LarkApiError(message, opts);

/** `Command failed: <命令行 + 请求体>` 形态：argv 里带着 agent 写的回复正文 */
const cliFailure = (body: string, stderr: string) =>
  lark(
    `Command failed: /home/u/.flowship/bin/lark-cli im +messages-send --data ${JSON.stringify({ text: body })}\n${stderr}`,
    { code: 1, api: "im +messages-send", raw: { stdout: "", stderr } },
  );

const infoTexts = (): string[] =>
  writeOwnedEventAndPublish.mock.calls
    .map((c) => c[2] as { kind?: string; text?: string } | undefined)
    .filter((e) => e?.kind === "info")
    .map((e) => e!.text!);

beforeEach(() => {
  __resetThrottleForTest();
  writeOwnedEventAndPublish.mockReset();
  writeOwnedEventAndPublish.mockImplementation(async () => ({ id: "ev_owned" }));
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  __resetThrottleForTest();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("describeGroupSendFailure：认得出的几类说人话 + 给补救", () => {
  it("机器人被移出群（230002）：原因 + 飞书码 + log_id；补救是加回群 / 换绑；不是 cardkit 问题", () => {
    const d = describeGroupSendFailure(
      lark("Bot/User can NOT be out of the chat.", {
        code: 230002,
        api: "im +messages-send",
        logId: "L1",
        raw: { code: 230002, msg: "Bot/User can NOT be out of the chat." },
      }),
    );
    expect(d).toEqual({
      kind: "bot_not_in_group",
      cardkitRelated: false,
      reason: `${BOT_GONE_REASON}（飞书 230002 · log_id=L1）`,
      hint: BOT_GONE_HINT,
    });
  });

  it.each([
    ["230035", "被禁言"],
    ["230018", "群设置限制"],
    ["230027", "外部群未开共享"],
    ["230013", "不在应用可用范围"],
  ])("机器人还在群里但没有发言资格（%s，%s）→ no_send_permission，和「被移出」说不同的话", (code) => {
    const d = describeGroupSendFailure(lark("x", { code, raw: { code } }));
    expect(d.kind).toBe("no_send_permission");
    expect(d.reason).toBe(`${NO_PERMISSION_REASON}（飞书 ${code}）`);
    expect(d.hint).toBe(NO_PERMISSION_HINT);
    expect(d.reason).not.toContain("已不在这个群里");
  });

  it("群已解散：补救是取消关联 / 换绑 / 重建", () => {
    const d = describeGroupSendFailure(lark("chat not found", { code: 232011, raw: { code: 232011 } }));
    expect(d).toMatchObject({
      kind: "chat_gone",
      reason: `${CHAT_GONE_REASON}（飞书 232011）`,
      hint: CHAT_GONE_HINT,
      cardkitRelated: false,
    });
  });

  it("限流（99991400）：稍后会好；不建议换群", () => {
    const d = describeGroupSendFailure(lark("request trigger frequency limit", { code: 99991400, raw: { code: 99991400 } }));
    expect(d).toMatchObject({
      kind: "rate_limited",
      reason: `${RATE_LIMITED_REASON}（飞书 99991400）`,
      hint: RATE_LIMITED_HINT,
    });
  });

  it("只有报文没有码：认得出类别，但不编造飞书码", () => {
    const d = describeGroupSendFailure(lark("bot is not in the group"));
    expect(d.kind).toBe("bot_not_in_group");
    expect(d.reason).toBe(BOT_GONE_REASON);
  });

  it("CLI 层失败（code 是退出码）：stderr 里认得出就分类，但退出码不当「飞书 N」展示", () => {
    const d = describeGroupSendFailure(cliFailure("正文", "Error: The bot can not be outside the group"));
    expect(d.kind).toBe("bot_not_in_group");
    expect(d.reason).toBe(BOT_GONE_REASON);
    expect(d.reason).not.toContain("飞书 1");
  });

  it("命令行里的回复正文写了「机器人不在群里」/ rate limit：不影响判定（真实失败是网络抖）→ other，原因取 stderr", () => {
    const d = describeGroupSendFailure(
      cliFailure("提示：机器人不在群里时请先加群，rate limit 时稍等", "Error: socket hang up"),
    );
    expect(d.kind).toBe("other");
    expect(d.hint).toBeUndefined();
    expect(d.reason).toContain("socket hang up");
    expect(d.reason).not.toContain(BOT_GONE_REASON);
    expect(d.reason).not.toContain("提示：机器人不在群里时请先加群");
  });

  it("缺 scope 另有专门说法：即使码也在「机器人不在群」表里，仍走缺权限文案（不分类）", () => {
    const d = describeGroupSendFailure(lark(SCOPE_ERR, { code: 230002, raw: { code: 230002 } }));
    expect(d.kind).toBe("other");
    expect(d.reason).toContain("缺机器人权限：cardkit:card:write");
    expect(d.hint).toBeUndefined();
  });

  it("认不出的照旧：kind=other、没有 hint、cardkit 相关的仍标出", () => {
    const plain = describeGroupSendFailure(new Error("boom"));
    expect(plain).toEqual({ kind: "other", cardkitRelated: false, reason: "boom" });
    const card = describeGroupSendFailure(
      lark("create card failed", { code: 99991, api: "api POST /open-apis/cardkit/v1/cards" }),
    );
    expect(card.kind).toBe("other");
    expect(card.cardkitRelated).toBe(true);
    expect(card.hint).toBeUndefined();
  });
});

// 与 B4-3 的接缝：上面的 `cliFailure` 是手工拼的 `Command failed:` 形态（B4-3 之前的出口形态）。
// 真实路径（`runLark` → `normalizeLarkError`）已经把 message 瘦成「stderr 最后一行 / `lark-cli 调用失败（api）`」——
// 这里喂真实 `normalizeLarkError` 的输出，钉住「面向用户的 reason / 类别 / 补救」在两批合起来之后是什么样。
describe("describeGroupSendFailure × 真实 normalizeLarkError 出口（B4-3 × B4-4 接缝）", () => {
  /** Node `execFile` 失败时抛的错误：message = `Command failed: <命令行>\n<stderr>`，另挂 stdout / stderr / code */
  const execFailure = (body: string, stderr: string): Error =>
    Object.assign(
      new Error(
        `Command failed: /home/u/.flowship/bin/lark-cli im +messages-send --data ${JSON.stringify({ text: body })} --as bot --json\n${stderr}`,
      ),
      { stdout: "", stderr, code: 1 },
    );
  const normalized = (body: string, stderr: string) =>
    normalizeLarkError(execFailure(body, stderr), undefined, "im +messages-send");

  it("认不出的失败：reason 只有 stderr 最后一行（+ 命令标签）——没有命令行、回复正文、Command failed", () => {
    const d = describeGroupSendFailure(
      normalized("提示：机器人不在群里时请先加群，rate limit 时稍等", "Error: weird failure"),
    );
    expect(d.kind).toBe("other");
    expect(d.hint).toBeUndefined();
    expect(d.reason).toBe("Error: weird failure（im +messages-send）");
    expect(d.reason).not.toContain("Command failed");
    expect(d.reason).not.toContain("--data");
    expect(d.reason).not.toContain("提示：机器人不在群里时请先加群");
  });

  it("关键词在 stderr 更靠前的行：message 只剩最后一行，仍认出类别、给补救；退出码不当「飞书 N」展示", () => {
    const d = describeGroupSendFailure(
      normalized(
        "正文",
        "Error: The bot can not be outside the group\nhint: run `lark-cli auth status`",
      ),
    );
    expect(d.kind).toBe("bot_not_in_group");
    expect(d.reason).toBe(BOT_GONE_REASON);
    expect(d.hint).toBe(BOT_GONE_HINT);
  });

  it("stderr 是空的：退回 B4-3 的兜底说法，同样没有命令行 / 回复正文", () => {
    const d = describeGroupSendFailure(normalized("机器人不在群里 rate limit", ""));
    expect(d.kind).toBe("other");
    expect(d.reason).toContain("lark-cli 调用失败");
    expect(d.reason).not.toContain("Command failed");
    expect(d.reason).not.toContain("--data");
    expect(d.reason).not.toContain("机器人不在群里");
  });
});

describe("noteGroupSendFailure：写进事件流的整句话", () => {
  it("机器人被移出群：整句 = 原因 + 补救，不再是英文原文 + 「设置页检查」", async () => {
    await noteGroupSendFailure(
      TASK,
      CHAT,
      lark("Bot/User can NOT be out of the chat.", { code: 230002, raw: { code: 230002 } }),
      "答疑回复",
    );
    expect(infoTexts()).toEqual([
      `群里答疑回复没发出去：${BOT_GONE_REASON}（飞书 230002）。${BOT_GONE_HINT}`,
    ]);
    const text = infoTexts()[0]!;
    expect(text).not.toContain("设置页飞书桥接检查");
    expect(text).not.toContain("cardkit:card:write");
    expect(text).not.toContain("can NOT be out of the chat");
  });

  it.each([
    [lark("x", { code: 230035, raw: { code: 230035 } }), NO_PERMISSION_REASON, NO_PERMISSION_HINT],
    [lark("chat not found", { code: 232011 }), CHAT_GONE_REASON, CHAT_GONE_HINT],
    [lark("frequency limit", { code: 99991400 }), RATE_LIMITED_REASON, RATE_LIMITED_HINT],
  ])("其它认得出的类别各带各的补救（不带通用的「设置页检查」）", async (err, reason, hint) => {
    await noteGroupSendFailure(TASK, CHAT, err, "回执");
    const text = infoTexts()[0]!;
    expect(text.startsWith("群里回执没发出去：")).toBe(true);
    expect(text).toContain(reason);
    expect(text.endsWith(hint)).toBe(true);
    expect(text).not.toContain(GENERIC_HINT);
  });

  it("认不出的原因：文案与改动前一致（通用提示照旧）", async () => {
    await noteGroupSendFailure(TASK, CHAT, new Error("lark 5xx"));
    expect(infoTexts()).toEqual([`群里有一条回复没发出去：lark 5xx。${GENERIC_HINT}`]);
  });

  it("缺 scope 的文案照旧（不被分类吞掉）", async () => {
    await noteGroupSendFailure(TASK, CHAT, new Error(SCOPE_ERR), "答疑回复");
    const text = infoTexts()[0]!;
    expect(text).toContain("缺机器人权限：cardkit:card:write");
    expect(text).toContain("群里的文字走卡片发送（需要 cardkit:card:write）");
  });
});

describe("节流 key 带上「哪类消息」（Q12b-07）", () => {
  const botGone = () => lark("x", { code: 230002 });

  it("同一个群、同一类：一分钟只记一条", async () => {
    await noteGroupSendFailure(TASK, CHAT, botGone(), "答疑回复");
    await noteGroupSendFailure(TASK, CHAT, botGone(), "答疑回复");
    expect(infoTexts()).toHaveLength(1);
  });

  it("同一个群、不同类：各记各的——「回执」失败占了名额也不能把「答疑回复」失败吞掉", async () => {
    await noteGroupSendFailure(TASK, CHAT, botGone(), "回执");
    await noteGroupSendFailure(TASK, CHAT, botGone(), "答疑回复");
    const texts = infoTexts();
    expect(texts).toHaveLength(2);
    expect(texts[0]).toContain("群里回执没发出去");
    expect(texts[1]).toContain("群里答疑回复没发出去");
  });

  it("没带 what（入向回执）与带 what 的各占各的名额；没带 what 的重复调用仍只记一条", async () => {
    await noteGroupSendFailure(TASK, CHAT, new Error("a"));
    await noteGroupSendFailure(TASK, CHAT, new Error("b"));
    await noteGroupSendFailure(TASK, CHAT, new Error("c"), "回执");
    expect(infoTexts()).toHaveLength(2);
  });

  it("没带 what 的 key 形态不变（`group-reply-failed:<chatId>`）：入向占了它，不影响出向各类", async () => {
    expect(throttleOncePerMinute(`group-reply-failed:${CHAT}`)).toBe(true);
    await noteGroupSendFailure(TASK, CHAT, new Error("x")); // 被入向占着的名额挡住
    expect(infoTexts()).toHaveLength(0);
    await noteGroupSendFailure(TASK, CHAT, new Error("x"), "答疑回复"); // 另一类：不受影响
    expect(infoTexts()).toHaveLength(1);
  });

  it("带 what 的 key = `group-reply-failed:<chatId>:<what>`；换个群各记各的", async () => {
    await noteGroupSendFailure(TASK, CHAT, new Error("a"), "产物");
    expect(throttleOncePerMinute(`group-reply-failed:${CHAT}:产物`)).toBe(false);
    expect(throttleOncePerMinute(`group-reply-failed:${CHAT}:问群卡`)).toBe(true);
    await noteGroupSendFailure(TASK, "oc_other", new Error("b"), "产物");
    expect(infoTexts()).toHaveLength(2);
  });

  it("一分钟后同一类可以再记", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-25T12:00:00Z"));
    await noteGroupSendFailure(TASK, CHAT, botGone(), "回执");
    vi.setSystemTime(new Date("2026-10-25T12:00:59Z"));
    await noteGroupSendFailure(TASK, CHAT, botGone(), "回执");
    expect(infoTexts()).toHaveLength(1);
    vi.setSystemTime(new Date("2026-10-25T12:01:01Z"));
    await noteGroupSendFailure(TASK, CHAT, botGone(), "回执");
    expect(infoTexts()).toHaveLength(2);
  });

  it("taskId 为空：什么都不写、也不占这一类的名额", async () => {
    await noteGroupSendFailure("", CHAT, botGone(), "答疑回复");
    expect(infoTexts()).toHaveLength(0);
    expect(throttleOncePerMinute(`group-reply-failed:${CHAT}:答疑回复`)).toBe(true);
  });

  it("写事件炸了也不抛", async () => {
    writeOwnedEventAndPublish.mockRejectedValue(new Error("disk full"));
    await expect(noteGroupSendFailure(TASK, CHAT, botGone(), "回执")).resolves.toBeUndefined();
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("记录发群失败时出错"),
      "disk full",
    );
  });
});
