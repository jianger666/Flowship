/**
 * `+messages-mget` 回包字段锁定：`data.messages[].content / msg_type`。
 * 载荷为 16:03 线上实包（桃子哥卡片，`om_x100b66c858e348b4b290e154d4f6ce1`）
 * 的结构原样节选——字段改名这里先红。注意 `messages` 列表接口走的是
 * `data.items`，两者别混。
 */
import { describe, expect, it } from "vitest";

import { parseMgetMessages } from "@/lib/server/feishu-bridge/lark-api";

// 16:03 真实回包（仅截断 _notice / message_app_link 等无关字段，包体结构原样）
const REAL_MGET_1603 = {
  ok: true,
  identity: "user",
  data: {
    messages: [
      {
        chat_id: "oc_39aa5789fdd906908e70f1b65a9c93c2",
        content:
          "<card>\n@江耳的Flowship 收到，正在开发库查 status=COMPLETED 的入学测评学员。\n@江耳的Flowship 开发环境可用这条已完成数据：\n- **学号：EAA5E7**\n- studentId：`a7fadb12-3793-43ae-b79e-6fbc1cac68bf`\n</card>",
        create_time: "2026-09-08 16:03",
        deleted: false,
        message_id: "om_x100b66c858e348b4b290e154d4f6ce1",
        message_position: "678",
        msg_type: "interactive",
        sender: {
          id: "cli_aade29ca753add0c",
          id_type: "app_id",
          name: "桃子哥",
          open_bot_id: "ou_d9984a9b48e0339fa114f0bd5829213b",
          sender_type: "app",
        },
        update_time: "2026-09-08 16:04",
        updated: true,
      },
    ],
    page_token: "",
    total: 1,
  },
};

describe("parseMgetMessages", () => {
  it("16:03 实包：取到卡片正文与 interactive 类型", () => {
    const out = parseMgetMessages(REAL_MGET_1603);
    expect(out).toHaveLength(1);
    expect(out[0].msgType).toBe("interactive");
    expect(out[0].content).toContain("EAA5E7");
  });

  it("空包 / 异形包返回空数组（调用方 fail-closed）", () => {
    expect(parseMgetMessages({ ok: true, data: { messages: [] } })).toEqual(
      [],
    );
    // 列表接口的 items 形态误传进来也不炸、不误取
    expect(
      parseMgetMessages({ data: { items: [{ content: "x" }] } }),
    ).toEqual([]);
    expect(parseMgetMessages(null)).toEqual([]);
  });
});
