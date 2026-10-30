/**
 * feishu-bridge/lark-errors：「bot 不在群 / 群已解散 / 限流」判定（纯函数）。
 *
 * 这几个判定原先在 feishu-group.ts（bind / share 用），B4-4 抽出来给「发群失败提示」共用
 * （group-failure-notice 不能反向依赖带 meegle 静态边的 feishu-group）。
 * 抽出来之后要钉住的：
 * ① 原有口径没变（码表 / 关键词兜底 / chat gone 的排除法）；
 * ② `Command failed: <命令行>` 形态的 message 带着整个请求体（回复正文），不能参与关键词匹配——
 *    否则回复里写了「机器人不在群」「rate limit」就把一次无关的失败判错类、提示给出错的补救；只认 stderr；
 * ③ 新增的发群失败分类 `classifyGroupSendFailure`：bot 不在群 / 无发言权限 / 群已没 / 限流 / 其它；
 * ④ 与 B4-3 的接缝：真实路径上的错误经过 `normalizeLarkError`，message 已被瘦成「stderr 最后一行」，
 *    不再以 `Command failed:` 开头（见文件末尾那组，喂的是真实 `normalizeLarkError` 的输出，不是手工拼的错误）。
 */
import { describe, expect, it } from "vitest";

import { normalizeLarkError } from "@/lib/server/feishu-bridge/lark-api";
import {
  BOT_NOT_IN_GROUP_LARK_CODES,
  CHAT_GONE_MESSAGE,
  classifyGroupSendFailure,
  isBotNotInGroupSendError,
  isChatGoneError,
} from "@/lib/server/feishu-bridge/lark-errors";
import { LarkApiError } from "@/lib/server/feishu-bridge/types";

const lark = (
  message: string,
  opts: ConstructorParameters<typeof LarkApiError>[1] = {},
): LarkApiError => new LarkApiError(message, opts);

/** `Command failed: <命令行 + 请求体>` 形态：argv 里带着 agent 写的回复正文 */
const cliFailure = (body: string, stderr: string): LarkApiError =>
  lark(
    `Command failed: /home/u/.flowship/bin/lark-cli im +messages-send --data ${JSON.stringify({ text: body })}\n${stderr}`,
    { code: 1, raw: { stdout: "", stderr } },
  );

describe("isBotNotInGroupSendError：码表 + 关键词兜底（原口径不变）", () => {
  it.each(["230002", "230013", "230018", "230027", "230035"])(
    "码 %s（字符串 / 数字都认）命中",
    (code) => {
      expect(isBotNotInGroupSendError(lark("x", { code }))).toBe(true);
      expect(isBotNotInGroupSendError(lark("x", { code: Number(code) }))).toBe(true);
    },
  );

  it("码表恰好是这 5 个（改动要连同发群失败提示的分类一起看）", () => {
    expect([...BOT_NOT_IN_GROUP_LARK_CODES].sort()).toEqual([
      "230002",
      "230013",
      "230018",
      "230027",
      "230035",
    ]);
  });

  it.each([
    "The bot can not be outside the group",
    "bot is not in the group",
    "user not in the chat",
    "机器人不在群里",
  ])("没有码时按报文关键词兜底：%s", (message) => {
    expect(isBotNotInGroupSendError(lark(message))).toBe(true);
  });

  it("关键词兜底不分大小写：真实报文的大小写不固定（去掉正则的 i 标志会漏判）", () => {
    expect(isBotNotInGroupSendError(lark("The Bot Is NOT IN THE GROUP"))).toBe(true);
    expect(isBotNotInGroupSendError(lark("BOT CAN NOT BE OUTSIDE THE GROUP"))).toBe(true);
  });

  it("无关错误 / 非 LarkApiError / 其它码都不命中", () => {
    expect(isBotNotInGroupSendError(lark("boom", { code: 99991400 }))).toBe(false);
    expect(isBotNotInGroupSendError(lark("boom"))).toBe(false);
    expect(isBotNotInGroupSendError(new Error("机器人不在群里"))).toBe(false);
    expect(isBotNotInGroupSendError("机器人不在群里")).toBe(false);
    expect(isBotNotInGroupSendError(undefined)).toBe(false);
  });

  it("Command failed 形态：命令行里的回复正文不参与关键词匹配；stderr 里有才算", () => {
    // 回复正文恰好写了「机器人不在群里」，真实失败是网络抖
    const noise = cliFailure("提示：机器人不在群里时请先加群", "Error: socket hang up");
    expect(isBotNotInGroupSendError(noise)).toBe(false);
    // 没有 stderr 属性 / 非对象 raw：宁可不判
    expect(
      isBotNotInGroupSendError(lark("Command failed: lark-cli … 机器人不在群里", { code: 1 })),
    ).toBe(false);
    // stderr 里真有：命中
    const real = cliFailure("正文", "Error: The bot can not be outside the group");
    expect(isBotNotInGroupSendError(real)).toBe(true);
    // 码优先：就算 stderr 空，码在表里照样命中
    expect(
      isBotNotInGroupSendError(
        lark("Command failed: lark-cli …", { code: 230002, raw: { stdout: "", stderr: "" } }),
      ),
    ).toBe(true);
  });

  it("stderr 只看尾部 500 字：更早的内容不参与（防超长输出里的偶然字样）", () => {
    const stderr = `机器人不在群里${"x".repeat(600)}`;
    expect(isBotNotInGroupSendError(cliFailure("正文", stderr))).toBe(false);
    expect(isBotNotInGroupSendError(cliFailure("正文", `${"x".repeat(600)}机器人不在群里`))).toBe(
      true,
    );
  });
});

describe("isChatGoneError：只认正面信号（原口径不变）", () => {
  it.each([
    "chat not found",
    "chat id is invalid",
    "chat does not exist",
    "the group was dissolved",
    "群已解散",
    "群聊不存在",
  ])("命中：%s", (message) => {
    expect(isChatGoneError(lark(message, { code: 232011 }))).toBe(true);
    expect(CHAT_GONE_MESSAGE.test(message)).toBe(true);
  });

  it("关键词不分大小写：真实报文的大小写不固定（去掉正则的 i 标志会漏判）", () => {
    expect(isChatGoneError(lark("Chat ID NOT FOUND", { code: 232011 }))).toBe(true);
    expect(CHAT_GONE_MESSAGE.test("The Group Was DISSOLVED")).toBe(true);
  });

  it("排除法：暂时性错误 / bot 不在群 / 缺 scope / 非 LarkApiError 都不算群没了", () => {
    expect(isChatGoneError(lark("chat not found ETIMEDOUT"))).toBe(false);
    expect(isChatGoneError(lark("chat not found", { code: 230002 }))).toBe(false);
    expect(isChatGoneError(lark("chat not found", { permissionViolations: [{ subject: "x" }] }))).toBe(
      false,
    );
    expect(isChatGoneError(lark("chat not found", { consoleUrl: "https://open.feishu.cn/x" }))).toBe(
      false,
    );
    expect(isChatGoneError(new Error("chat not found"))).toBe(false);
    expect(isChatGoneError(lark("something else"))).toBe(false);
  });

  it("Command failed 形态：命令行里的回复正文写了「群已解散」不算；stderr 里有才算", () => {
    expect(isChatGoneError(cliFailure("通知：群已解散后请重建", "Error: weird failure"))).toBe(false);
    expect(isChatGoneError(cliFailure("正文", "Error: chat not found"))).toBe(true);
  });
});

describe("classifyGroupSendFailure：发群失败分类", () => {
  it.each([
    ["230002", "bot_not_in_group"],
    ["230035", "no_send_permission"],
    ["230018", "no_send_permission"],
    ["230027", "no_send_permission"],
    ["230013", "no_send_permission"],
    ["99991400", "rate_limited"],
    ["230020", "rate_limited"],
    ["230099", "other"],
  ] as const)("码 %s → %s", (code, kind) => {
    expect(classifyGroupSendFailure(lark("x", { code }))).toBe(kind);
    expect(classifyGroupSendFailure(lark("x", { code: Number(code) }))).toBe(kind);
  });

  it.each([
    ["bot is not in the group", "bot_not_in_group"],
    ["机器人不在群里", "bot_not_in_group"],
    ["chat not found", "chat_gone"],
    ["群已解散", "chat_gone"],
    ["request trigger frequency limit", "rate_limited"],
    ["Rate limit exceeded", "rate_limited"],
    ["429 Too Many Requests", "rate_limited"],
    ["create card failed", "other"],
  ] as const)("没有码时看报文：%s → %s", (message, kind) => {
    expect(classifyGroupSendFailure(lark(message))).toBe(kind);
  });

  it("非 LarkApiError 一律 other（包括带关键词的普通 Error / 字符串 / undefined）", () => {
    expect(classifyGroupSendFailure(new Error("rate limit"))).toBe("other");
    expect(classifyGroupSendFailure("机器人不在群里")).toBe("other");
    expect(classifyGroupSendFailure(undefined)).toBe("other");
    expect(classifyGroupSendFailure(null)).toBe("other");
  });

  it("几类互斥、有明确的先后：码在表里优先于「群没了」的报文；限流码不受报文里暂时性字样影响", () => {
    // 「群没了」报文 + 机器人不在群的码 → 码优先，是 bot_not_in_group
    expect(classifyGroupSendFailure(lark("chat not found", { code: 230002 }))).toBe("bot_not_in_group");
    // 限流码 + 暂时性字样：限流码照样认限流（限流本来就是「稍后再试」）
    expect(classifyGroupSendFailure(lark("network busy", { code: 99991400 }))).toBe("rate_limited");
  });

  it("Command failed 形态：回复正文里的关键词不能把判定带偏；stderr 里的才算", () => {
    expect(classifyGroupSendFailure(cliFailure("这段话里有 rate limit 和 机器人不在群里", "Error: EOF"))).toBe(
      "other",
    );
    expect(classifyGroupSendFailure(cliFailure("正文", "429 Too Many Requests"))).toBe("rate_limited");
    expect(classifyGroupSendFailure(cliFailure("正文", "Error: bot is not in the group"))).toBe(
      "bot_not_in_group",
    );
    expect(classifyGroupSendFailure(cliFailure("正文", "Error: chat not found"))).toBe("chat_gone");
  });
});

// ---------------------------------------------------------------------------------------------
// 接缝：B4-3 的 `normalizeLarkError`（出口把 message 瘦成人话）× B4-4 的判定
//
// 上面的 `cliFailure` 是手工拼的 `Command failed:` 形态——那是 B4-3 之前 `normalizeLarkError` 的出口形态。
// 现在真实路径（`runLark` → `normalizeLarkError`）已经把 message 瘦成「stderr 最后一行 / `lark-cli 调用失败（api）`」，
// 不再以 `Command failed:` 开头、也不带命令行里的回复正文；`raw` 仍是 `{ stdout, stderr }`。
// 下面这组把**真实 `normalizeLarkError(execFile 形态的错误)` 的输出**喂给判定，钉住两批合起来的行为：
// 任何一边改了出口形态 / 取行方式 / 判定文本，都会在这里红。
// ---------------------------------------------------------------------------------------------

/** Node `execFile` 失败时抛的错误：message = `Command failed: <命令行>\n<stderr>`，另挂 stdout / stderr / code */
const execFailure = (opts: { body?: string; stderr?: string; stdout?: string } = {}): Error =>
  Object.assign(
    new Error(
      `Command failed: /home/u/.flowship/bin/lark-cli im +messages-send --data ${JSON.stringify({ text: opts.body ?? "正文" })} --as bot --json\n${opts.stderr ?? ""}`,
    ),
    { stdout: opts.stdout ?? "", stderr: opts.stderr ?? "", code: 1 },
  );

/** 真实出口：`runLark` 对每个 execFile 失败都走这一步 */
const normalized = (opts?: Parameters<typeof execFailure>[0]): LarkApiError =>
  normalizeLarkError(execFailure(opts), undefined, "im +messages-send");

describe("接缝：normalizeLarkError（B4-3 瘦 message）→ 判定（B4-4）", () => {
  it("前提（B4-3）：真实出口的 message 不再以 Command failed 开头、不带命令行里的正文；raw 仍是 { stdout, stderr }", () => {
    const e = normalized({ body: "提示：机器人不在群里时请先加群", stderr: "Error: socket hang up" });
    expect(e.message).toBe("Error: socket hang up");
    expect(e.raw).toEqual({ stdout: "", stderr: "Error: socket hang up" });
  });

  it("回复正文里的关键词不入账：真实失败是别的 → 三个判定都不命中、分类 other", () => {
    const e = normalized({
      body: "这段话里有 rate limit、机器人不在群里、chat not found",
      stderr: "Error: weird failure",
    });
    expect(isBotNotInGroupSendError(e)).toBe(false);
    expect(isChatGoneError(e)).toBe(false);
    expect(classifyGroupSendFailure(e)).toBe("other");
  });

  it.each([
    ["Error: The bot can not be outside the group", "bot_not_in_group"],
    ["Error: chat not found", "chat_gone"],
    ["429 Too Many Requests", "rate_limited"],
  ] as const)("关键词在 stderr 最后一行：%s → %s", (stderr, kind) => {
    expect(classifyGroupSendFailure(normalized({ stderr }))).toBe(kind);
  });

  it.each([
    [
      "机器人不在群",
      "Error: The bot can not be outside the group\nhint: run `lark-cli auth status`",
      "bot_not_in_group",
    ],
    ["群已没", "Error: chat not found\nrequest id: 202610250001", "chat_gone"],
    [
      "限流",
      "Error: 429 Too Many Requests\n    at retry (node:internal/process:1:1)",
      "rate_limited",
    ],
  ] as const)(
    "关键词在 stderr 更靠前的行（最后一行是提示 / 堆栈）：message 只剩最后一行，也要认出来（%s）",
    (_label, stderr, kind) => {
      const e = normalized({ stderr });
      // 前提：message 里确实没有关键词——只靠 raw.stderr 的尾部才认得出
      expect(e.message).not.toMatch(/outside the group|chat not found|too many requests/i);
      expect(classifyGroupSendFailure(e)).toBe(kind);
    },
  );

  it("stderr 尾部 500 字的边界（走瘦 message 这一支）：495 字内的关键词认得出，535 字里落在尾部之外的不认", () => {
    // message 只剩最后一行（全是 y、不含关键词）：命中与否只取决于关键词是否落在 stderr 的最后 500 字里
    const inside = `Error: 机器人不在群里\n${"y".repeat(480)}`;
    const outside = `Error: 机器人不在群里\n${"y".repeat(520)}`;
    expect(inside).toHaveLength(495);
    expect(outside).toHaveLength(535);
    expect(isBotNotInGroupSendError(normalized({ stderr: inside }))).toBe(true);
    expect(isBotNotInGroupSendError(normalized({ stderr: outside }))).toBe(false);
  });

  it("单行超长 stderr：关键词在行首，已落到 stderr 尾部 500 字之外——但被瘦成 300 字的 message 里还在，靠 message 命中", () => {
    const e = normalized({ stderr: `Error: bot is not in the group ${"z".repeat(700)}` });
    expect(e.message.length).toBeLessThanOrEqual(300);
    expect(e.message).toContain("bot is not in the group");
    expect(isBotNotInGroupSendError(e)).toBe(true);
  });

  it("飞书响应体形态（stdout 是 JSON）：错误码优先；没有码时 msg 整句参与关键词匹配", () => {
    const json = (error: Record<string, unknown>) =>
      normalized({ stdout: JSON.stringify({ ok: false, error }) });
    const botGone = json({ code: 230002, message: "Bot/User can NOT be out of the chat." });
    expect(botGone.code).toBe(230002);
    expect(classifyGroupSendFailure(botGone)).toBe("bot_not_in_group");
    expect(
      classifyGroupSendFailure(json({ code: 230035, message: "Send Message Permission deny" })),
    ).toBe("no_send_permission");
    expect(
      classifyGroupSendFailure(json({ code: 99991400, message: "request trigger frequency limit" })),
    ).toBe("rate_limited");
    // 没有码：code 落成进程退出码 1（不在任何码表里），只剩 msg 能判
    expect(classifyGroupSendFailure(json({ message: "bot is not in the group" }))).toBe(
      "bot_not_in_group",
    );
    expect(classifyGroupSendFailure(json({ message: "chat not found" }))).toBe("chat_gone");
  });
});
