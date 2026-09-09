/**
 * 群出问登记：三硬门（发件人 / 窗口期 / 必含要素）+ fail-closed + 一问一答即焚
 */
import { beforeEach, describe, expect, it } from "vitest";

import {
  __resetOutboundRegistryForTest,
  burnCorrelatedEntry,
  matchCorrelatedAnswer,
  registerOutboundQuestion,
} from "@/lib/server/feishu-bridge/group-outbound-registry";

beforeEach(() => {
  __resetOutboundRegistryForTest();
});

const reg = () =>
  registerOutboundQuestion({
    taskId: "t1",
    chatId: "oc_1",
    messageId: "om_q1",
    target: "ou_taozi",
    keywords: ["学号"],
  });

describe("registerOutboundQuestion", () => {
  it("要素必填：没有 keywords 不建登记（fail-closed）", () => {
    const r = registerOutboundQuestion({
      taskId: "t1",
      chatId: "oc_1",
      messageId: "om_q1",
      target: "ou_taozi",
      keywords: [],
    });
    expect(r.ok).toBe(false);
    expect(
      matchCorrelatedAnswer({
        taskId: "t1",
        chatId: "oc_1",
        senderIds: ["ou_taozi"],
        text: "学号 EAA5E7",
      }),
    ).toBeNull();
  });

  it("taskId / messageId / target 缺一即拒", () => {
    expect(
      registerOutboundQuestion({
        taskId: "",
        chatId: "oc_1",
        messageId: "om_q1",
        target: "ou_taozi",
        keywords: ["学号"],
      }).ok,
    ).toBe(false);
  });
});

describe("matchCorrelatedAnswer", () => {
  it("三门全过才命中", () => {
    expect(reg().ok).toBe(true);
    const hit = matchCorrelatedAnswer({
      taskId: "t1",
      chatId: "oc_1",
      senderIds: ["ou_taozi"],
      text: "开发环境可用这条：学号 EAA5E7",
    });
    expect(hit?.entry.messageId).toBe("om_q1");
  });

  it("发件人不对 → 不命中（别人 @ 不顶掉等待）", () => {
    reg();
    expect(
      matchCorrelatedAnswer({
        taskId: "t1",
        chatId: "oc_1",
        senderIds: ["ou_other"],
        text: "学号 EAA5E7",
      }),
    ).toBeNull();
  });

  it("发件人多格比对：sender_id 是 app_id 时用 bot open 格也能命中", () => {
    reg();
    const hit = matchCorrelatedAnswer({
      taskId: "t1",
      chatId: "oc_1",
      senderIds: ["cli_xxx", "ou_taozi"],
      text: "学号 EAA5E7",
    });
    expect(hit?.entry.messageId).toBe("om_q1");
  });

  it("缺要素 → 不命中（fail-closed；闲聊含一半也不行）", () => {
    registerOutboundQuestion({
      taskId: "t1",
      chatId: "oc_1",
      messageId: "om_q1",
      target: "ou_taozi",
      keywords: ["学号", "COMPLETED"],
    });
    expect(
      matchCorrelatedAnswer({
        taskId: "t1",
        chatId: "oc_1",
        senderIds: ["ou_taozi"],
        text: "学号 EAA5E7",
      }),
    ).toBeNull();
  });

  it("过期 → 不命中", () => {
    registerOutboundQuestion({
      taskId: "t1",
      chatId: "oc_1",
      messageId: "om_q1",
      target: "ou_taozi",
      keywords: ["学号"],
      ttlMs: 1000,
    });
    expect(
      matchCorrelatedAnswer({
        taskId: "t1",
        chatId: "oc_1",
        senderIds: ["ou_taozi"],
        text: "学号 EAA5E7",
        now: Date.now() + 2000,
      }),
    ).toBeNull();
  });

  it("一问一答即焚：burn 后复读不再命中", () => {
    reg();
    burnCorrelatedEntry("t1", "om_q1");
    expect(
      matchCorrelatedAnswer({
        taskId: "t1",
        chatId: "oc_1",
        senderIds: ["ou_taozi"],
        text: "学号 EAA5E7",
      }),
    ).toBeNull();
  });

  it("不同群不串（chatId 隔离）", () => {
    reg();
    expect(
      matchCorrelatedAnswer({
        taskId: "t1",
        chatId: "oc_other",
        senderIds: ["ou_taozi"],
        text: "学号 EAA5E7",
      }),
    ).toBeNull();
  });

  it("同目标多问取最新（就近配对）", () => {
    registerOutboundQuestion({
      taskId: "t1",
      chatId: "oc_1",
      messageId: "om_old",
      target: "ou_taozi",
      keywords: ["学号"],
    });
    registerOutboundQuestion({
      taskId: "t1",
      chatId: "oc_1",
      messageId: "om_new",
      target: "ou_taozi",
      keywords: ["学号"],
    });
    const hit = matchCorrelatedAnswer({
      taskId: "t1",
      chatId: "oc_1",
      senderIds: ["ou_taozi"],
      text: "学号 EAA5E7",
    });
    expect(hit?.entry.messageId).toBe("om_new");
  });

  it("chatId 为空的登记跨群放行——行为锁定（查不到绑定群时的降级，串味口子已知）", () => {
    registerOutboundQuestion({
      taskId: "t1",
      chatId: "",
      messageId: "om_q1",
      target: "ou_taozi",
      keywords: ["学号"],
    });
    // 为空 = 不做群隔离：同 target 不同群会串，fail-closed 靠发件人+窗口+要素三门兜着
    const hit = matchCorrelatedAnswer({
      taskId: "t1",
      chatId: "oc_other",
      senderIds: ["ou_taozi"],
      text: "学号 EAA5E7",
    });
    expect(hit?.entry.messageId).toBe("om_q1");
  });

  it("senderIds 全空直接 null（防以后放宽成无身份消费）", () => {
    reg();
    expect(
      matchCorrelatedAnswer({
        taskId: "t1",
        chatId: "oc_1",
        senderIds: [undefined, ""],
        text: "学号 EAA5E7",
      }),
    ).toBeNull();
  });
});

describe("hasPendingOutbound + 读时清过期", () => {
  beforeEach(() => {
    __resetOutboundRegistryForTest();
  });

  it("发件人对+窗口内 → true；发件人不对 → false", async () => {
    const { hasPendingOutbound } = await import(
      "@/lib/server/feishu-bridge/group-outbound-registry"
    );
    reg();
    expect(
      hasPendingOutbound({
        taskId: "t1",
        chatId: "oc_1",
        senderIds: ["ou_taozi"],
      }),
    ).toBe(true);
    expect(
      hasPendingOutbound({
        taskId: "t1",
        chatId: "oc_1",
        senderIds: ["ou_other"],
      }),
    ).toBe(false);
  });

  it("match 读时顺手摘掉过期条目（长跑不堆积）", async () => {
    const { __countOutboundForTest } = await import(
      "@/lib/server/feishu-bridge/group-outbound-registry"
    );
    registerOutboundQuestion({
      taskId: "t1",
      chatId: "oc_1",
      messageId: "om_old",
      target: "ou_taozi",
      keywords: ["学号"],
      ttlMs: 1000,
    });
    expect(__countOutboundForTest("t1")).toBe(1);
    // 过期后读一次：不命中，且条目被摘掉
    expect(
      matchCorrelatedAnswer({
        taskId: "t1",
        chatId: "oc_1",
        senderIds: ["ou_taozi"],
        text: "学号 EAA5E7",
        now: Date.now() + 2000,
      }),
    ).toBeNull();
    expect(__countOutboundForTest("t1")).toBe(0);
  });
});

describe("keywords 上限显式报错（不静默截断）", () => {
  beforeEach(() => {
    __resetOutboundRegistryForTest();
  });

  it("超过 5 个直接拒收", () => {
    const r = registerOutboundQuestion({
      taskId: "t1",
      chatId: "oc_1",
      messageId: "om_q1",
      target: "ou_taozi",
      keywords: ["a", "b", "c", "d", "e", "f"],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("最多 5 个");
  });
});

describe("P1：名字不许进登记（昵称可改名冒充，fail-closed）", () => {
  beforeEach(() => {
    __resetOutboundRegistryForTest();
  });

  it("target 是显示名 → 直接拒单，且建不出可命中的登记", () => {
    const r = registerOutboundQuestion({
      taskId: "t1",
      chatId: "oc_1",
      messageId: "om_q1",
      target: "桃子哥",
      keywords: ["学号"],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("ou_xxx");
    // 拒单 = 无登记：改名成目标名也无门可入
    expect(
      matchCorrelatedAnswer({
        taskId: "t1",
        chatId: "oc_1",
        senderIds: ["ou_attacker", "桃子哥"],
        text: "学号 EAA5E7",
      }),
    ).toBeNull();
  });

  it("昵称格即使传进来也命中不了 ID 目标（调用方不再传昵称，双保险）", () => {
    expect(
      registerOutboundQuestion({
        taskId: "t1",
        chatId: "oc_1",
        messageId: "om_q1",
        target: "ou_taozi",
        keywords: ["学号"],
      }).ok,
    ).toBe(true);
    // 攻击者 sender_id 是自己的 ou，名字改成目标名也混在格子里——不命中
    expect(
      matchCorrelatedAnswer({
        taskId: "t1",
        chatId: "oc_1",
        senderIds: ["ou_attacker", "cli_other", "桃子哥"],
        text: "学号 EAA5E7",
      }),
    ).toBeNull();
    // 只有真 ID 格才命中
    expect(
      matchCorrelatedAnswer({
        taskId: "t1",
        chatId: "oc_1",
        senderIds: ["ou_attacker", "ou_taozi"],
        text: "学号 EAA5E7",
      }),
    ).not.toBeNull();
  });

  it("target 空格/大小写变形也进不来（必须 ou_/cli_ 形态）", () => {
    for (const bad of [" 桃子哥 ", "ou taozi", "ou_", "xxx", "ou_桃子"]) {
      expect(
        registerOutboundQuestion({
          taskId: "t1",
          chatId: "oc_1",
          messageId: `om_${bad}`,
          target: bad,
          keywords: ["学号"],
        }).ok,
      ).toBe(false);
    }
    // cli_ 形态放行（@ 机器人按 app_id 登记的合法形态）
    expect(
      registerOutboundQuestion({
        taskId: "t1",
        chatId: "oc_1",
        messageId: "om_cli",
        target: "cli_aac269da35399cf9",
        keywords: ["学号"],
      }).ok,
    ).toBe(true);
  });
});
