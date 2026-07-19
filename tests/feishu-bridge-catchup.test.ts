/**
 * review P1#3：断线补拉分页 + 本人 user 过滤 + 总量 cap
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TMP = path.join(os.tmpdir(), `feishu-bridge-catchup-${Date.now()}`);
process.env.FLOWSHIP_DATA_DIR = path.join(TMP, "data");

const larkApi = vi.hoisted(() => vi.fn());
const getBotAppInfo = vi.hoisted(() =>
  vi.fn(async () => ({ appId: "cli_x", ownerOpenId: "ou_owner" })),
);

vi.mock("@/lib/server/feishu-bridge/lark-api", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/server/feishu-bridge/lark-api")>();
  return {
    ...actual,
    larkApi,
    getBotAppInfo,
    sendTextMessage: vi.fn(async () => ({ chat_id: "c", message_id: "m" })),
  };
});

const { catchUpMissedMessages } = await import(
  "@/lib/server/feishu-bridge/inbound"
);
const { rememberP2pChatId, __resetBridgeStateForTest } = await import(
  "@/lib/server/feishu-bridge/bridge-state"
);
const { setLastProcessedTs } = await import(
  "@/lib/server/feishu-bridge/card-map"
);

const makeItem = (
  id: string,
  opts: {
    senderId?: string;
    senderType?: string;
  } = {},
) => ({
  message_id: id,
  create_time: String(Date.now()),
  chat_id: "oc_p2p",
  msg_type: "text",
  sender: {
    id: opts.senderId ?? "ou_owner",
    sender_type: opts.senderType ?? "user",
  },
  body: { content: JSON.stringify({ text: id }) },
});

beforeEach(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
  await fs.mkdir(path.join(TMP, "data"), { recursive: true });
  await __resetBridgeStateForTest();
  larkApi.mockReset();
  getBotAppInfo.mockClear();
  await rememberP2pChatId("oc_p2p");
  // 5 分钟前——落在补拉窗口内
  await setLastProcessedTs(String(Date.now() - 5 * 60 * 1000));
});

afterEach(async () => {
  await __resetBridgeStateForTest();
  await fs.rm(TMP, { recursive: true, force: true });
});

describe("catchUpMissedMessages", () => {
  it("跟随 has_more/page_token 翻页，过滤非本人 / 非 user", async () => {
    const got: string[] = [];
    larkApi
      .mockResolvedValueOnce({
        data: {
          items: [
            makeItem("om_1"),
            makeItem("om_bot", { senderType: "app" }),
            makeItem("om_other", { senderId: "ou_other" }),
          ],
          has_more: true,
          page_token: "tok_2",
        },
      })
      .mockResolvedValueOnce({
        data: {
          items: [makeItem("om_2")],
          has_more: false,
        },
      });

    await catchUpMissedMessages(async (msg) => {
      got.push(msg.message_id);
    });

    expect(larkApi).toHaveBeenCalledTimes(2);
    const secondParams = (
      larkApi.mock.calls[1] as unknown as [string, string, { params: Record<string, unknown> }]
    )[2].params;
    expect(secondParams.page_token).toBe("tok_2");
    expect(secondParams.page_size).toBe(50);
    expect(got).toEqual(["om_1", "om_2"]);
  });

  it("总量 cap 200 后停止翻页", async () => {
    const page1 = Array.from({ length: 50 }, (_, i) => makeItem(`om_${i}`));
    const page2 = Array.from({ length: 50 }, (_, i) =>
      makeItem(`om_${50 + i}`),
    );
    const page3 = Array.from({ length: 50 }, (_, i) =>
      makeItem(`om_${100 + i}`),
    );
    const page4 = Array.from({ length: 50 }, (_, i) =>
      makeItem(`om_${150 + i}`),
    );
    const page5 = Array.from({ length: 50 }, (_, i) =>
      makeItem(`om_${200 + i}`),
    );
    larkApi
      .mockResolvedValueOnce({
        data: { items: page1, has_more: true, page_token: "t2" },
      })
      .mockResolvedValueOnce({
        data: { items: page2, has_more: true, page_token: "t3" },
      })
      .mockResolvedValueOnce({
        data: { items: page3, has_more: true, page_token: "t4" },
      })
      .mockResolvedValueOnce({
        data: { items: page4, has_more: true, page_token: "t5" },
      })
      .mockResolvedValueOnce({
        data: { items: page5, has_more: true, page_token: "t6" },
      });

    let n = 0;
    await catchUpMissedMessages(async () => {
      n += 1;
    });
    expect(n).toBe(200);
    // 第 4 页注入满 200 后应停止，不再请求第 5 页
    expect(larkApi).toHaveBeenCalledTimes(4);
  });
});
