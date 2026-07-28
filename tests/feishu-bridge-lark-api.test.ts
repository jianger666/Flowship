/**
 * lark-api：错误归一化（permission_violations / console_url）+ 队列串行
 */
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetBotAppInfoCacheForTest,
  __resetLarkBinCacheForTest,
  __setLarkExecForTest,
  __setLarkRetryBaseForTest,
  describeLarkCommand,
  fetchChatInfo,
  getBotAppInfo,
  getBotDisplayName,
  larkApi,
  normalizeLarkError,
  parseLarkAuthStatus,
  probeLarkAuthStatus,
  probeSelfInChat,
  runLark,
  uploadImage,
} from "@/lib/server/feishu-bridge/lark-api";
import {
  describeLarkError,
  LarkApiError,
} from "@/lib/server/feishu-bridge/types";

afterEach(() => {
  __setLarkExecForTest(null);
  __resetLarkBinCacheForTest();
  __resetBotAppInfoCacheForTest();
});

describe("normalizeLarkError", () => {
  it("从 stdout JSON 抽出 permission_violations + console_url", () => {
    const err = normalizeLarkError({
      message: "Command failed",
      stdout: JSON.stringify({
        ok: false,
        error: {
          code: 99991672,
          message: "Access denied",
          permission_violations: [{ subject: "cardkit:card:write" }],
          console_url: "https://open.feishu.cn/app/cli_xxx/auth?q=cardkit:card:write",
        },
      }),
      stderr: "",
    });
    expect(err).toBeInstanceOf(LarkApiError);
    expect(err.message).toBe("Access denied");
    expect(err.code).toBe(99991672);
    expect(err.permissionViolations).toEqual([
      { subject: "cardkit:card:write" },
    ]);
    expect(err.consoleUrl).toContain("open.feishu.cn");
  });

  it("超时 killed → 明确超时文案", () => {
    const err = normalizeLarkError({
      message: "killed",
      killed: true,
      code: null,
    });
    expect(err.message).toMatch(/超时/);
  });

  // 2026-07-27 线上：`member_id_type=app_id` 非法枚举报 99992402、
  // message 只有一句「field validation failed」——不抓 code / log_id 根本没法定位
  it("参数校验类错误：抓住 code / log_id / field_violations / 命令标签", () => {
    const err = normalizeLarkError(
      {
        message: "Command failed",
        stdout: JSON.stringify({
          ok: false,
          error: {
            code: 99992402,
            message: "field validation failed",
            log_id: "20260727150651E0B86CE612204C29D019",
            field_violations: [{ field: "member_id_type" }],
          },
        }),
      },
      undefined,
      "api GET /open-apis/im/v1/chats/oc_x/members",
    );
    expect(err.code).toBe(99992402);
    expect(err.logId).toBe("20260727150651E0B86CE612204C29D019");
    expect(err.fieldViolations).toEqual([{ field: "member_id_type" }]);
    expect(err.api).toBe("api GET /open-apis/im/v1/chats/oc_x/members");
  });
});

describe("describeLarkError", () => {
  it("把 code / 命令 / 违规字段 / log_id 拼进一行可诊断文案", () => {
    const line = describeLarkError(
      new LarkApiError("field validation failed", {
        code: 99992402,
        api: "api GET /open-apis/im/v1/chats/oc_x/members",
        fieldViolations: [{ field: "member_id_type" }],
        logId: "2026072715065",
      }),
    );
    expect(line).toContain("field validation failed");
    expect(line).toContain("99992402");
    expect(line).toContain("member_id_type");
    expect(line).toContain("log_id=2026072715065");
    expect(line).toContain("/open-apis/im/v1/chats/oc_x/members");
  });

  it("没有结构化字段时原样返回 message（不加空括号）", () => {
    expect(describeLarkError(new LarkApiError("boom"))).toBe("boom");
  });
});

describe("describeLarkCommand", () => {
  it("取到第一个 --flag 为止", () => {
    expect(
      describeLarkCommand([
        "api",
        "POST",
        "/open-apis/im/v1/chats",
        "--data",
        "{}",
      ]),
    ).toBe("api POST /open-apis/im/v1/chats");
    expect(
      describeLarkCommand(["im", "+messages-send", "--chat-id", "oc_x"]),
    ).toBe("im +messages-send");
  });
});

describe("runLark / larkApi（mock exec）", () => {
  it("ok:false 抛 LarkApiError 且带权限字段", async () => {
    __setLarkExecForTest(async () => ({
      stdout: JSON.stringify({
        ok: false,
        error: {
          message: "no scope",
          permission_violations: ["im:message:send_as_bot"],
          console_url: "https://open.feishu.cn/app/x/auth",
        },
      }),
      stderr: "",
    }));
    await expect(runLark(["auth", "status"])).rejects.toMatchObject({
      name: "LarkApiError",
      message: "no scope",
      consoleUrl: "https://open.feishu.cn/app/x/auth",
    });
  });

  it("失败错误带上出错的那条命令（不然只剩一句无信息量 message）", async () => {
    __setLarkExecForTest(async () => ({
      stdout: JSON.stringify({
        ok: false,
        error: { code: 99992402, message: "field validation failed" },
      }),
      stderr: "",
    }));
    await expect(
      larkApi("GET", "/open-apis/im/v1/chats/oc_x/members", {
        params: { member_id_type: "app_id" },
      }),
    ).rejects.toMatchObject({
      api: "api GET /open-apis/im/v1/chats/oc_x/members",
      code: 99992402,
    });
  });

  it("larkApi 拼 METHOD/path/--data", async () => {
    const calls: string[][] = [];
    __setLarkExecForTest(async (_bin, args) => {
      calls.push(args);
      return {
        stdout: JSON.stringify({ ok: true, data: { card_id: "c1" } }),
        stderr: "",
      };
    });
    const rec = await larkApi("POST", "/open-apis/cardkit/v1/cards", {
      data: { type: "card_json", data: "{}" },
    });
    expect(rec.data).toEqual({ card_id: "c1" });
    expect(calls[0]?.slice(0, 3)).toEqual([
      "api",
      "POST",
      "/open-apis/cardkit/v1/cards",
    ]);
    expect(calls[0]).toContain("--as");
    expect(calls[0]).toContain("bot");
    expect(calls[0]).toContain("--json");
  });

  it("串行队列：后调用等前调用结束", async () => {
    const order: number[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let n = 0;
    __setLarkExecForTest(async () => {
      const id = ++n;
      if (id === 1) await gate;
      order.push(id);
      return { stdout: JSON.stringify({ ok: true, data: { id } }), stderr: "" };
    });
    const p1 = runLark(["a"]);
    const p2 = runLark(["b"]);
    // 尚未 release：order 应仍空或只有准备中
    await vi.waitFor(() => expect(n).toBe(1));
    expect(order).toEqual([]);
    release();
    await Promise.all([p1, p2]);
    expect(order).toEqual([1, 2]);
  });
});

// ----------------- 本机身份 / bot 名（2026-07-27 线上「飞书机器人未登录」回归） -----------------

/** `auth status` 真实样本（test 实例实测、只留判定用得上的字段） */
const authStatusSample = (over: Record<string, unknown> = {}) => ({
  appId: "cli_test",
  brand: "feishu",
  defaultAs: "auto",
  identity: "user",
  identities: {
    bot: { status: "ready", available: true, message: "Bot identity: ready" },
    user: {
      status: "needs_refresh",
      available: true,
      openId: "ou_local_user",
      userName: "陈禄江",
    },
  },
  ...over,
});

/** bot 只登录了、user 身份没登录（应用信息接口兜底路径的前提） */
const botOnlyStatus = () =>
  authStatusSample({
    identities: { bot: { status: "ready", available: true } },
  });

/** CLI 报错样本：stdout 里带结构化 error（normalizeLarkError 靠它抽 code / log_id） */
const cliFailure = (error: Record<string, unknown>) =>
  Object.assign(new Error("Command failed"), {
    stdout: JSON.stringify({ ok: false, error }),
  });

/** 按命令分发的假 lark-cli：返回记录下来的命令序列，没预置的路由一律炸 */
const fakeLarkCli = (routes: {
  authStatus?: () => unknown;
  appInfo?: () => unknown;
  botInfo?: () => unknown;
}): string[] => {
  const commands: string[] = [];
  __setLarkExecForTest(async (_bin, args) => {
    const cmd = describeLarkCommand(args);
    commands.push(cmd);
    const route = cmd.includes("/open-apis/application/v6/applications/")
      ? routes.appInfo
      : cmd.includes("/open-apis/bot/v3/info")
        ? (routes.botInfo ?? (() => ({ ok: true, data: {} })))
        : cmd === "auth status"
          ? (routes.authStatus ?? authStatusSample)
          : undefined;
    if (!route) throw new Error(`本用例未预置该命令：${cmd}`);
    return { stdout: JSON.stringify(route()), stderr: "" };
  });
  return commands;
};

describe("parseLarkAuthStatus", () => {
  it("从 identities 里抠出本人 open_id / 姓名 / bot 可用性", () => {
    expect(parseLarkAuthStatus(authStatusSample())).toEqual({
      appId: "cli_test",
      userOpenId: "ou_local_user",
      userName: "陈禄江",
      botAvailable: true,
    });
  });

  it("bot 不可用如实反映（上层据此才敢说「未登录」）", () => {
    const status = parseLarkAuthStatus(
      authStatusSample({
        identities: { bot: { status: "missing", available: false } },
      }),
    );
    expect(status.botAvailable).toBe(false);
    expect(status.userOpenId).toBe("");
  });
});

describe("getBotAppInfo：本人 open_id 的降级链", () => {
  it("auth status 自带 open_id → 零 API 拿到身份、根本不碰应用信息接口", async () => {
    const commands = fakeLarkCli({});
    await expect(getBotAppInfo()).resolves.toEqual({
      appId: "cli_test",
      ownerOpenId: "ou_local_user",
    });
    expect(commands).toEqual(["auth status"]);
  });

  // 线上故障回归：test 实例的 application/v6 间歇性 EOF，把整条群分享链拖成「未登录」
  it("应用信息接口挂着也照样拿到身份", async () => {
    const commands = fakeLarkCli({
      appInfo: () => {
        throw cliFailure({ code: 99992402, message: "field validation failed" });
      },
    });
    await expect(getBotAppInfo()).resolves.toMatchObject({
      ownerOpenId: "ou_local_user",
    });
    expect(commands.some((c) => c.includes("application/v6"))).toBe(false);
  });

  it("auth status 没有 user 身份 → 退应用信息接口的 owner", async () => {
    const commands = fakeLarkCli({
      authStatus: botOnlyStatus,
      appInfo: () => ({
        ok: true,
        data: {
          app: { app_name: "江耳的Flowship", owner: { owner_id: "ou_owner" } },
        },
      }),
    });
    await expect(getBotAppInfo()).resolves.toEqual({
      appId: "cli_test",
      ownerOpenId: "ou_owner",
      appName: "江耳的Flowship",
    });
    expect(commands).toHaveLength(2);
  });

  it("两条来源都断 → 抛真实原因 + 保住 code / log_id，不谎称未登录", async () => {
    fakeLarkCli({
      authStatus: botOnlyStatus,
      appInfo: () => {
        throw cliFailure({
          code: 99992402,
          message: "field validation failed",
          log_id: "20260727150651E0B86CE612204C29D019",
        });
      },
    });
    await expect(getBotAppInfo()).rejects.toMatchObject({
      name: "LarkApiError",
      code: 99992402,
      logId: "20260727150651E0B86CE612204C29D019",
      message: expect.stringContaining("auth status 无 user 身份"),
    });
  });
});

describe("getBotDisplayName：bot 展示名的降级链", () => {
  it("bot/v3/info 有名字就用它（免审 scope、不打应用信息接口）", async () => {
    const commands = fakeLarkCli({
      botInfo: () => ({
        ok: true,
        data: { bot: { open_id: "ou_bot", app_name: "Flowship·甲" } },
      }),
    });
    await expect(getBotDisplayName()).resolves.toBe("Flowship·甲");
    expect(commands.some((c) => c.includes("application/v6"))).toBe(false);
  });

  // test 实例实测：bot/v3/info 返回空包 {"ok":true,"data":{}}
  it("bot/v3/info 空包 → 退应用信息接口的 app_name", async () => {
    fakeLarkCli({
      appInfo: () => ({ ok: true, data: { app: { app_name: "江耳的Flowship" } } }),
    });
    await expect(getBotDisplayName()).resolves.toBe("江耳的Flowship");
  });

  it("全挂 → null（调用方自己退 app_id），且冷却期内不重复打应用信息接口", async () => {
    const commands = fakeLarkCli({
      appInfo: () => {
        throw cliFailure({ code: 99991672, message: "Access denied" });
      },
    });
    await expect(getBotDisplayName()).resolves.toBeNull();
    await expect(getBotDisplayName()).resolves.toBeNull();
    expect(commands.filter((c) => c.includes("application/v6"))).toHaveLength(1);
  });
});

describe("probeLarkAuthStatus", () => {
  it("CLI 跑挂 → null（= 登录态未知，不等于未登录）", async () => {
    __setLarkExecForTest(async () => {
      throw new Error("spawn ENOENT");
    });
    await expect(probeLarkAuthStatus()).resolves.toBeNull();
  });
});

// ----------------- 瞬时传输失败的安全重试 -----------------
//
// 用户实测报文：`API call failed: Post "https://accounts.feishu.cn/oauth/v3/token": EOF`
// ——挂在取 token 那一跳。重点是**别把写操作也一起重试**：发消息 / 建群在「请求已发出、
// 响应回来路上断了」时重试就是群里两张重复卡、工作项两个孤儿群。

/** exec 抛错的形状（execFile 失败时带 stdout/stderr） */
const execFailure = (over: {
  message?: string;
  stdout?: string;
  stderr?: string;
}) => Object.assign(new Error(over.message ?? "Command failed"), {
  stdout: over.stdout ?? "",
  stderr: over.stderr ?? "",
});

/** 前 n 次抛 err、之后返回成功包；返回调用计数器 */
const failThenSucceed = (n: number, err: unknown) => {
  const state = { calls: 0 };
  __setLarkExecForTest(async () => {
    state.calls += 1;
    if (state.calls <= n) throw err;
    return { stdout: JSON.stringify({ ok: true, data: { fine: true } }), stderr: "" };
  });
  return state;
};

const tokenEofFailure = () =>
  execFailure({
    stdout: JSON.stringify({
      ok: false,
      error: {
        message:
          'API call failed: Post "https://accounts.feishu.cn/oauth/v3/token": EOF',
      },
    }),
  });

describe("runLark 瞬时失败重试", () => {
  beforeEach(() => {
    __setLarkRetryBaseForTest(0);
  });
  afterEach(() => {
    __setLarkRetryBaseForTest(null);
  });

  it("幂等的 GET 撞 ECONNRESET → 重试后成功", async () => {
    const state = failThenSucceed(
      1,
      execFailure({ message: "read ECONNRESET" }),
    );
    await expect(
      larkApi("GET", "/open-apis/im/v1/chats/oc_x"),
    ).resolves.toMatchObject({ data: { fine: true } });
    expect(state.calls).toBe(2);
  });

  it("传输错误只落在 stderr（message 只有一句 Command failed）也认得出来", async () => {
    const state = failThenSucceed(
      1,
      execFailure({ message: "Command failed", stderr: "socket hang up" }),
    );
    await expect(larkApi("GET", "/open-apis/bot/v3/info")).resolves.toBeTruthy();
    expect(state.calls).toBe(2);
  });

  it("写操作撞 EOF → **一次都不重试**（重试会攒出重复卡 / 孤儿群）", async () => {
    const state = failThenSucceed(1, execFailure({ message: "unexpected EOF" }));
    await expect(
      larkApi("POST", "/open-apis/im/v1/messages", { data: {} }),
    ).rejects.toMatchObject({ name: "LarkApiError" });
    expect(state.calls).toBe(1);
  });

  it("写操作但挂在取 token 那一跳 → 重试（业务请求还没发出去、零副作用）", async () => {
    const state = failThenSucceed(1, tokenEofFailure());
    await expect(
      larkApi("POST", "/open-apis/im/v1/chats", { data: { name: "x" } }),
    ).resolves.toBeTruthy();
    expect(state.calls).toBe(2);
  });

  // CLI 也可能 exit 0 但吐 ok:false（走 unwrapOk 那条路）——两种形状都得认
  it("exit 0 + ok:false 的 token EOF → 同样重试", async () => {
    let calls = 0;
    __setLarkExecForTest(async () => {
      calls += 1;
      if (calls === 1) {
        return {
          stdout: JSON.stringify({
            ok: false,
            error: {
              message:
                'API call failed: Post "https://accounts.feishu.cn/oauth/v3/token": EOF',
            },
          }),
          stderr: "",
        };
      }
      return { stdout: JSON.stringify({ ok: true, data: {} }), stderr: "" };
    });
    await expect(
      larkApi("POST", "/open-apis/im/v1/chats", { data: { name: "x" } }),
    ).resolves.toBeTruthy();
    expect(calls).toBe(2);
  });

  it("业务错误（权限不足）一次都不重试——重试多少次都是同一个结果", async () => {
    const state = failThenSucceed(
      1,
      execFailure({
        stdout: JSON.stringify({
          ok: false,
          error: { code: 99991672, message: "Access denied" },
        }),
      }),
    );
    await expect(
      larkApi("GET", "/open-apis/im/v1/chats/oc_x/members"),
    ).rejects.toMatchObject({ code: 99991672 });
    expect(state.calls).toBe(1);
  });

  it("一直抖 → 封顶 3 次尝试后抛原错", async () => {
    const state = failThenSucceed(99, execFailure({ message: "read ECONNRESET" }));
    await expect(larkApi("GET", "/open-apis/bot/v3/info")).rejects.toMatchObject({
      name: "LarkApiError",
    });
    expect(state.calls).toBe(3);
  });
});

// ----------------- 群可达性探针（需求群死绑定检测） -----------------

describe("fetchChatInfo / probeSelfInChat", () => {
  it("fetchChatInfo 取群名（bot 身份）", async () => {
    const calls: string[][] = [];
    __setLarkExecForTest(async (_bin, args) => {
      calls.push(args);
      return {
        stdout: JSON.stringify({ ok: true, data: { name: "登录优化需求群" } }),
        stderr: "",
      };
    });
    await expect(fetchChatInfo("oc_x")).resolves.toEqual({
      chatId: "oc_x",
      name: "登录优化需求群",
    });
    expect(calls[0]?.slice(0, 3)).toEqual([
      "api",
      "GET",
      "/open-apis/im/v1/chats/oc_x",
    ]);
    expect(calls[0]).toContain("bot");
  });

  // tenant token 问的是「机器人在不在群」（它一直在、问了白问）——
  // 只有 user token 才答得出「建群的那个人现在还在不在」
  it("probeSelfInChat 必须走 user 身份", async () => {
    const calls: string[][] = [];
    __setLarkExecForTest(async (_bin, args) => {
      calls.push(args);
      return {
        stdout: JSON.stringify({ ok: true, data: { is_in_chat: false } }),
        stderr: "",
      };
    });
    await expect(probeSelfInChat("oc_x")).resolves.toBe(false);
    expect(calls[0]?.[2]).toBe("/open-apis/im/v1/chats/oc_x/members/is_in_chat");
    expect(calls[0]).toContain("user");
    expect(calls[0]).not.toContain("bot");
  });

  it("响应缺判定字段 → 抛（绝不默认成在群 / 不在群）", async () => {
    __setLarkExecForTest(async () => ({
      stdout: JSON.stringify({ ok: true, data: {} }),
      stderr: "",
    }));
    await expect(probeSelfInChat("oc_x")).rejects.toMatchObject({
      name: "LarkApiError",
    });
  });
});

describe("uploadImage", () => {
  it("绝对路径 → cwd=dirname + --file image=<basename>（lark-cli 拒绝对路径）", async () => {
    const abs = "/tmp/feishu-upload-fixture/att_demo.png";
    const calls: Array<{
      args: string[];
      cwd?: string;
    }> = [];
    __setLarkExecForTest(async (_bin, args, opts) => {
      calls.push({ args, cwd: opts.cwd });
      return {
        stdout: JSON.stringify({
          ok: true,
          data: { image_key: "img_v3_test_key" },
        }),
        stderr: "",
      };
    });
    const key = await uploadImage(abs);
    expect(key).toBe("img_v3_test_key");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.cwd).toBe(path.dirname(abs));
    expect(calls[0]?.args).toContain("--file");
    expect(calls[0]?.args).toContain("image=att_demo.png");
    // 绝不能把绝对路径塞进 --file
    expect(calls[0]?.args.some((a) => a.includes("/tmp/"))).toBe(false);
  });
});
