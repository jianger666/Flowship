/**
 * 飞书桥接引导探测：scope 齐/缺、cardkit consoleUrl、welcome 成功/失败
 * （全部 mock lark-api / feishu-cli，不真发飞书消息）
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildScopeAuthUrl,
  extractGrantedScopes,
  findMissingScopes,
  isScopeSatisfied,
  probeBridgeStatus,
  REQUIRED_BRIDGE_SCOPES,
  sendWelcomeMessage,
  WELCOME_TEXT,
} from "@/lib/server/feishu-bridge/probe";
import { LarkApiError } from "@/lib/server/feishu-bridge/types";

vi.mock("@/lib/server/feishu-cli", () => ({
  getFeishuCliStatus: vi.fn(),
}));

vi.mock("@/lib/server/feishu-bridge/lark-api", () => ({
  getBotAppInfo: vi.fn(),
  larkApi: vi.fn(),
  createCardEntity: vi.fn(),
  sendTextMessage: vi.fn(),
}));

import { getFeishuCliStatus } from "@/lib/server/feishu-cli";
import {
  createCardEntity,
  getBotAppInfo,
  larkApi,
  sendTextMessage,
} from "@/lib/server/feishu-bridge/lark-api";

const mockedGetFeishuCliStatus = vi.mocked(getFeishuCliStatus);
const mockedGetBotAppInfo = vi.mocked(getBotAppInfo);
const mockedLarkApi = vi.mocked(larkApi);
const mockedCreateCardEntity = vi.mocked(createCardEntity);
const mockedSendTextMessage = vi.mocked(sendTextMessage);

beforeEach(() => {
  mockedGetFeishuCliStatus.mockResolvedValue({
    larkCli: {
      installed: true,
      loggedIn: true,
      version: "1.0.68",
      authDetail: "ou_test",
    },
    meegle: { installed: true, loggedIn: true },
  });
  mockedGetBotAppInfo.mockResolvedValue({
    appId: "cli_probe_app",
    ownerOpenId: "ou_owner_1",
    appName: "probe",
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("scope 工具", () => {
  it("extractGrantedScopes 读 data.app.scopes[].scope", () => {
    const granted = extractGrantedScopes({
      code: 0,
      data: {
        app: {
          scopes: [
            { scope: "im:message", token_types: ["tenant"] },
            { scope: "cardkit:card:write", token_types: ["tenant"] },
            { scope: "im:resource" },
            { scope: "im:message:send_as_bot" },
          ],
        },
      },
    });
    expect(granted).toEqual([
      "im:message",
      "cardkit:card:write",
      "im:resource",
      "im:message:send_as_bot",
    ]);
  });

  it("send 等价：im:message:send 可满足 send_as_bot", () => {
    const set = new Set(["im:message:send", "im:message"]);
    expect(isScopeSatisfied("im:message:send_as_bot", set)).toBe(true);
    expect(isScopeSatisfied("im:message", set)).toBe(true);
    expect(isScopeSatisfied("cardkit:card:write", set)).toBe(false);
  });

  it("缺 scope 时深链拼接正确", () => {
    const missing = findMissingScopes([
      "im:message",
      "im:message:send_as_bot",
    ]);
    expect(missing).toEqual(["cardkit:card:write", "im:resource"]);
    const url = buildScopeAuthUrl("cli_abc", missing);
    expect(url).toBe(
      "https://open.feishu.cn/app/cli_abc/auth?q=cardkit:card:write,im:resource&op_from=openapi&token_type=tenant",
    );
  });

  it("REQUIRED_BRIDGE_SCOPES 名单与提案一致", () => {
    expect([...REQUIRED_BRIDGE_SCOPES]).toEqual([
      "im:message:send_as_bot",
      "im:message",
      "cardkit:card:write",
      "im:resource",
    ]);
  });
});

describe("probeBridgeStatus", () => {
  it("scope 齐全 + cardkit 成功 → 全绿", async () => {
    mockedLarkApi.mockResolvedValue({
      data: {
        app: {
          scopes: REQUIRED_BRIDGE_SCOPES.map((scope) => ({ scope })),
        },
      },
    });
    mockedCreateCardEntity.mockResolvedValue({ card_id: "crd_ok" });

    const status = await probeBridgeStatus();
    expect(status.cli.ok).toBe(true);
    expect(status.scopes.ok).toBe(true);
    expect(status.scopes.missing).toEqual([]);
    expect(status.scopes.authUrl).toBeUndefined();
    expect(status.cardkit.ok).toBe(true);
    expect(status.cardkit.cardId).toBe("crd_ok");
    expect(status.runtime).toBeNull();
  });

  it("缺 scope → missing + authUrl 深链", async () => {
    mockedLarkApi.mockResolvedValue({
      data: {
        app: {
          scopes: [{ scope: "im:message" }],
        },
      },
    });
    mockedCreateCardEntity.mockResolvedValue({ card_id: "crd_x" });

    const status = await probeBridgeStatus();
    expect(status.scopes.ok).toBe(false);
    expect(status.scopes.missing).toEqual([
      "im:message:send_as_bot",
      "cardkit:card:write",
      "im:resource",
    ]);
    expect(status.scopes.authUrl).toBe(
      buildScopeAuthUrl("cli_probe_app", status.scopes.missing),
    );
  });

  it("cardkit 探测失败透出 consoleUrl", async () => {
    mockedLarkApi.mockResolvedValue({
      data: {
        app: {
          scopes: REQUIRED_BRIDGE_SCOPES.map((scope) => ({ scope })),
        },
      },
    });
    mockedCreateCardEntity.mockRejectedValue(
      new LarkApiError("Access denied", {
        consoleUrl:
          "https://open.feishu.cn/app/cli_probe_app/auth?q=cardkit:card:write",
        permissionViolations: [{ subject: "cardkit:card:write" }],
      }),
    );

    const status = await probeBridgeStatus();
    expect(status.cardkit.ok).toBe(false);
    expect(status.cardkit.error).toBe("Access denied");
    expect(status.cardkit.consoleUrl).toContain("open.feishu.cn");
    expect(status.cardkit.consoleUrl).toContain("cardkit:card:write");
  });
});

describe("sendWelcomeMessage", () => {
  it("成功：发给 owner + 欢迎语含命令清单", async () => {
    mockedSendTextMessage.mockResolvedValue({
      message_id: "om_welcome",
      chat_id: "oc_p2p",
    });
    const result = await sendWelcomeMessage();
    expect(result).toEqual({ messageId: "om_welcome", chatId: "oc_p2p" });
    expect(mockedSendTextMessage).toHaveBeenCalledWith(
      "ou_owner_1",
      WELCOME_TEXT,
    );
    // T8：欢迎语只指到 /help、不重复整段命令清单
    expect(WELCOME_TEXT).toMatch(/\/help/);
    expect(WELCOME_TEXT).not.toMatch(/\/stop/);
  });

  it("失败：透传 LarkApiError", async () => {
    mockedSendTextMessage.mockRejectedValue(
      new LarkApiError("P2P chat not found"),
    );
    await expect(sendWelcomeMessage()).rejects.toMatchObject({
      name: "LarkApiError",
      message: "P2P chat not found",
    });
  });
});
