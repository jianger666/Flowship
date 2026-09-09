/**
 * bot 发送者身份字段：live NDJSON 与 enrichment 两种 sender 形态都要归一化，
 * 否则关联判定的发件人一门永远对不上（16:03/16:04 案的根因之一）。
 */
import { describe, expect, it } from "vitest";

import { normalizeInboundEvent } from "@/lib/server/feishu-bridge/inbound";

describe("normalizeInboundEvent bot 发送者", () => {
  it("enrichment 形态（sender.id=app_id + open_bot_id）", () => {
    const msg = normalizeInboundEvent({
      type: "im.message.receive_v1",
      message_id: "om_x",
      chat_id: "oc_1",
      chat_type: "group",
      message_type: "text",
      sender: {
        id: "cli_aade29ca753add0c",
        id_type: "app_id",
        name: "桃子哥",
        open_bot_id: "ou_d9984a9b48e0339fa114f0bd5829213b",
        sender_type: "app",
      },
      content: "hi",
    });
    expect(msg?.sender_app_id).toBe("cli_aade29ca753add0c");
    expect(msg?.sender_bot_open_id).toBe("ou_d9984a9b48e0339fa114f0bd5829213b");
    expect(msg?.sender_type).toBe("app");
  });

  it("官方嵌套 sender_id.{open_id,app_id} 形态", () => {
    const msg = normalizeInboundEvent({
      event: {
        message: {
          message_id: "om_y",
          chat_id: "oc_1",
          chat_type: "group",
          message_type: "text",
          content: "hi",
        },
        sender: {
          sender_type: "app",
          sender_id: { open_id: "ou_bot", app_id: "cli_bot" },
        },
      },
    });
    // 嵌套形态 sender 在 event.sender ——现已归一化（优先级 message.sender > event.sender），
    // 官方形态的 bot 消息 sender 三格不再全空，关联判定能用上
    expect(msg?.message_id).toBe("om_y");
    expect(msg?.sender_id).toBe("ou_bot");
    expect(msg?.sender_app_id).toBe("cli_bot");
    expect(msg?.sender_type).toBe("app");
  });

  it("用户消息不受影响（新字段缺省）", () => {
    const msg = normalizeInboundEvent({
      type: "im.message.receive_v1",
      message_id: "om_z",
      chat_id: "oc_1",
      chat_type: "group",
      message_type: "text",
      sender_id: "ou_user",
      content: "hi",
    });
    expect(msg?.sender_id).toBe("ou_user");
    expect(msg?.sender_app_id).toBeUndefined();
    expect(msg?.sender_bot_open_id).toBeUndefined();
  });
});
