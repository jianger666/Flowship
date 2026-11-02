/**
 * 群答疑租户闸的数据源：normalizeInboundEvent 解析 sender_tenant_key（P0 硬化 ②）。
 * 只认「确属发件人」的字段：event.sender.tenant_key（官方原始事件形态）/ 顶层 sender_tenant_key（扁平形态）；
 * **不认 header.tenant_key**——那是应用（机器人）所在租户、不是发件人的（R7-2）；都没有 → 字段缺省（租户闸不拦）。
 * 注意：当前 lark-cli compact 事件里没有 tenant_key，生产里该字段恒缺省、租户闸暂不生效；这里钉的是「将来补上后的语义」。
 */
import { describe, expect, it } from "vitest";

import { normalizeInboundEvent } from "@/lib/server/feishu-bridge/inbound";

const flat = (extra: Record<string, unknown> = {}) => ({
  type: "im.message.receive_v1",
  message_id: "om_1",
  create_time: "1784385499958",
  chat_id: "oc_1",
  chat_type: "group",
  message_type: "text",
  sender_id: "ou_1",
  content: "hi",
  ...extra,
});

describe("normalizeInboundEvent · sender_tenant_key", () => {
  it("event.sender.tenant_key（官方事件形态）", () => {
    const m = normalizeInboundEvent({
      header: { event_type: "im.message.receive_v1" },
      event: {
        sender: { sender_id: { open_id: "ou_1" }, sender_type: "user", tenant_key: "t_a" },
        message: {
          message_id: "om_2",
          chat_id: "oc_2",
          chat_type: "group",
          message_type: "text",
          content: JSON.stringify({ text: "hi" }),
          create_time: "1784385499958",
        },
      },
    });
    expect(m?.sender_tenant_key).toBe("t_a");
  });

  it("只有 header.tenant_key（应用租户）、sender 不带 → 不采用，sender_tenant_key 缺省（R7-2）", () => {
    const m = normalizeInboundEvent({
      header: { event_type: "im.message.receive_v1", tenant_key: "t_h" },
      event: {
        sender: { sender_id: { open_id: "ou_1" }, sender_type: "user" },
        message: {
          message_id: "om_3",
          chat_id: "oc_3",
          chat_type: "group",
          message_type: "text",
          content: JSON.stringify({ text: "hi" }),
          create_time: "1784385499958",
        },
      },
    });
    expect(m).not.toBeNull();
    expect(m?.sender_tenant_key).toBeUndefined();
    expect(m && "sender_tenant_key" in m).toBe(false);
  });

  it("header.tenant_key 与 sender.tenant_key 同时给 → 取 sender 的，header 的不混入", () => {
    const m = normalizeInboundEvent({
      header: { event_type: "im.message.receive_v1", tenant_key: "t_app" },
      event: {
        sender: { sender_id: { open_id: "ou_1" }, sender_type: "user", tenant_key: "t_sender" },
        message: {
          message_id: "om_3b",
          chat_id: "oc_3b",
          chat_type: "group",
          message_type: "text",
          content: JSON.stringify({ text: "hi" }),
          create_time: "1784385499958",
        },
      },
    });
    expect(m?.sender_tenant_key).toBe("t_sender");
  });

  it("扁平形态（compact）里 header 也不采用：顶层只有 header.tenant_key → 缺省", () => {
    const m = normalizeInboundEvent(
      flat({ header: { event_type: "im.message.receive_v1", tenant_key: "t_h2" } }),
    );
    expect(m).not.toBeNull();
    expect(m && "sender_tenant_key" in m).toBe(false);
  });

  it("扁平形态：顶层 sender_tenant_key / tenant_key", () => {
    expect(normalizeInboundEvent(flat({ sender_tenant_key: "t_f1" }))?.sender_tenant_key).toBe(
      "t_f1",
    );
    expect(normalizeInboundEvent(flat({ tenant_key: " t_f2 " }))?.sender_tenant_key).toBe(
      "t_f2",
    );
  });

  it("都没有 / 空白 / 非字符串 → 不写该字段（缺省，租户闸不拦）", () => {
    for (const extra of [{}, { tenant_key: "   " }, { sender_tenant_key: 42 }]) {
      const m = normalizeInboundEvent(flat(extra));
      expect(m).not.toBeNull();
      expect(m && "sender_tenant_key" in m).toBe(false);
    }
  });
});
