/**
 * expect_group_reply handler 用例（失败形状必须全 JSON，keywords/about 均为备注可选）。
 *
 * caller 校验 / target 形态 / 成功登记三支，模型侧只用 parse 一支 JSON。
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import type { TaskMetaV06 } from "@/lib/server/task-fs-core";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-expect-reply-"));
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");

const { writeMeta } = await import("@/lib/server/task-fs-core");
const { setChatTaskActionHandler } = await import(
  "@/lib/server/chat-pending"
);
const { flowShipTools } = await import("@/lib/server/flowship-tools");
const {
  __resetOutboundRegistryForTest,
  matchCorrelatedAnswer,
} = await import("@/lib/server/feishu-bridge/group-outbound-registry");

const def = flowShipTools.find((t) => t.name === "expect_group_reply")!;
if (!def) throw new Error("expect_group_reply tool missing");

const TASK = "t-exp-1";
const TOK = "tok-exp-1";

await writeMeta({
  id: TASK,
  title: "expect-reply",
  mode: "task",
  repoStatus: "developing",
  runStatus: "awaiting_user",
  currentActionId: "act_1",
  actions: [
    {
      id: "act_1",
      n: 1,
      type: "plan",
      status: "running",
      userInstruction: "",
      artifactPath: "actions/1-plan.md",
      startedAt: Date.now(),
      endedAt: null,
    },
  ],
  mrs: [],
  repoPaths: [],
  createdAt: Date.now(),
  updatedAt: Date.now(),
} as unknown as TaskMetaV06);
setChatTaskActionHandler(TASK, (async () => {}) as never, TOK);

const call = async (args: Record<string, unknown>, token?: string) => {
  const r = await def.handler(args, token);
  return JSON.parse(
    (r.content[0] as { text: string }).text,
  ) as Record<string, unknown>;
};

afterAll(() => {
  setChatTaskActionHandler(TASK, null);
  __resetOutboundRegistryForTest();
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

describe("expect_group_reply handler", () => {
  beforeEach(() => {
    __resetOutboundRegistryForTest();
  });
  it("caller 对不上 → JSON {ok:false}（不是纯文本）", async () => {
    const r = await call(
      { task_id: TASK, message_id: "om_1", target: "ou_x", keywords: ["学号"] },
      "wrong-tok",
    );
    expect(r.ok).toBe(false);
    expect(typeof r.error).toBe("string");
  });

  it("keywords 为空也能登记（备注可选，不硬拦）", async () => {
    const r = await call(
      { task_id: TASK, message_id: "om_1", target: "ou_x", keywords: [] },
      TOK,
    );
    expect(r.ok).toBe(true);
    expect(
      matchCorrelatedAnswer({
        taskId: TASK,
        chatId: "oc_any",
        senderIds: ["ou_x"],
        text: "结论如下",
      }),
    ).not.toBeNull();
  });

  it("P1：target 填显示名 → 拒单（附带去哪找 id），且建不出登记", async () => {
    const r = await call(
      { task_id: TASK, message_id: "om_3", target: "桃子哥", keywords: ["学号"] },
      TOK,
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain("ou_xxx");
    expect(
      matchCorrelatedAnswer({
        taskId: TASK,
        chatId: "oc_any",
        senderIds: ["ou_x", "桃子哥"],
        text: "学号 EAA5E7",
      }),
    ).toBeNull();
  });

  it("成功登记 → 两门能命中（发件人 + 窗口期）", async () => {
    const r = await call(
      {
        task_id: TASK,
        message_id: "om_2",
        target: "ou_x",
        keywords: ["学号"],
      },
      TOK,
    );
    expect(r.ok).toBe(true);
    const hit = matchCorrelatedAnswer({
      taskId: TASK,
      chatId: "oc_any",
      senderIds: ["ou_x"],
      text: "学号 EAA5E7",
    });
    expect(hit?.entry.messageId).toBe("om_2");
  });

  it("同目标覆盖要可见：hint 带被顶掉的旧登记", async () => {
    await call(
      { task_id: TASK, message_id: "om_old", target: "ou_x" },
      TOK,
    );
    const r = await call(
      { task_id: TASK, message_id: "om_new", target: "ou_x" },
      TOK,
    );
    expect(r.ok).toBe(true);
    expect(r.hint).toContain("om_old");
  });

  it("ttl_minutes 透传：占位传 10，11 分钟后过期", async () => {
    const r = await call(
      { task_id: TASK, message_id: "om_ttl", target: "ou_x", ttl_minutes: 10 },
      TOK,
    );
    expect(r.ok).toBe(true);
    expect(
      matchCorrelatedAnswer({
        taskId: TASK,
        chatId: "oc_any",
        senderIds: ["ou_x"],
        text: "结论",
      }),
    ).not.toBeNull();
    expect(
      matchCorrelatedAnswer({
        taskId: TASK,
        chatId: "oc_any",
        senderIds: ["ou_x"],
        text: "结论",
        now: Date.now() + 11 * 60 * 1000,
      }),
    ).toBeNull();
  });
});
