/**
 * share_to_group 工具：服务端短窗幂等（同 task + 同内容哈希、2 分钟内）。
 *
 * 背景：断线重连 / 会话恢复后模型会把刚发过的卡片原样再调一遍；notify_group_testers 有 skipped_duplicate、
 * submit_mr 会复用已有 open MR，唯独 share_to_group 没有服务端幂等 → 需求群里刷出两张一模一样的卡。
 * 口径对齐 notify_group_testers：发前占位、明确失败退坑、成功占位保留；跳过不当失败（ok:true + outcome）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { TaskMetaV06 } from "@/lib/server/task-fs-core";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-share-dedup-"));
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");

const hoisted = vi.hoisted(() => {
  class FeishuGroupError extends Error {
    code: string;
    botLabel?: string;
    chatId?: string;
    constructor(message: string, code: string) {
      super(message);
      this.code = code;
    }
  }
  return { FeishuGroupError, shareToRequirementGroup: vi.fn() };
});
vi.mock("@/lib/server/feishu-group", () => ({
  FeishuGroupError: hoisted.FeishuGroupError,
  shareToRequirementGroup: hoisted.shareToRequirementGroup,
}));

const { writeMeta } = await import("@/lib/server/task-fs-core");
const { setChatTaskActionHandler } = await import("@/lib/server/chat-pending");
const {
  flowShipTools,
  SHARE_TO_GROUP_DEDUP_WINDOW_MS,
  __resetShareToGroupDedupForTest,
} = await import("@/lib/server/flowship-tools");

const def = flowShipTools.find((t) => t.name === "share_to_group")!;
if (!def) throw new Error("share_to_group tool missing");

const TASK = "t-share-dedup-1";
const OTHER_TASK = "t-share-dedup-2";
const TOK = "tok-share-dedup-1";
const TOK2 = "tok-share-dedup-2";

const meta = (id: string) =>
  ({
    id,
    title: "分享去重",
    mode: "task",
    repoStatus: "developing",
    runStatus: "idle",
    currentActionId: null,
    actions: [],
    mrs: [],
    repoPaths: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }) as unknown as TaskMetaV06;
await writeMeta(meta(TASK));
await writeMeta(meta(OTHER_TASK));
setChatTaskActionHandler(TASK, (async () => {}) as never, TOK);
setChatTaskActionHandler(OTHER_TASK, (async () => {}) as never, TOK2);

afterAll(() => {
  setChatTaskActionHandler(TASK, null);
  setChatTaskActionHandler(OTHER_TASK, null);
  vi.useRealTimers();
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

beforeEach(() => {
  hoisted.shareToRequirementGroup.mockReset();
  hoisted.shareToRequirementGroup.mockResolvedValue({ chatName: "需求群", messageId: "om_1" });
  __resetShareToGroupDedupForTest();
  vi.useRealTimers();
});

type Body = {
  ok: boolean;
  skipped?: boolean;
  outcome?: string;
  message?: string;
  error?: string;
  code?: string;
  messageId?: string;
};
const call = async (args: Record<string, unknown>, task = TASK, tok = TOK): Promise<Body> => {
  const r = await def.handler({ task_id: task, ...args }, tok);
  return JSON.parse((r.content[0] as { text: string }).text) as Body;
};

describe("share_to_group 短窗去重", () => {
  it("同 task + 同内容在窗口内重复 → 第二次 skipped_duplicate（ok:true、不当失败），只真发一次", async () => {
    const a = await call({ content: "进展同步", title: "T" });
    expect(a).toMatchObject({ ok: true, messageId: "om_1" });
    const b = await call({ content: "进展同步", title: "T" });
    expect(b.ok).toBe(true);
    expect(b.skipped).toBe(true);
    expect(b.outcome).toBe("skipped_duplicate");
    // 给模型的出口：说明确需重发怎么办
    expect(b.message).toContain("稍候再试或改动内容");
    expect(hoisted.shareToRequirementGroup).toHaveBeenCalledTimes(1);
  });

  it("内容 / 标题 / 链接 / at 任一不同 → 都算新卡、各发一次", async () => {
    await call({ content: "A" });
    await call({ content: "B" });
    await call({ content: "A", title: "T" });
    await call({ content: "A", links: [{ label: "l", url: "https://x" }] });
    await call({ content: "A", at: ["张三"] });
    await call({ content: "A", kind: "question" });
    expect(hoisted.shareToRequirementGroup).toHaveBeenCalledTimes(6);
  });

  it("不同任务发相同内容互不影响", async () => {
    await call({ content: "同一句" });
    const other = await call({ content: "同一句" }, OTHER_TASK, TOK2);
    expect(other.skipped).toBeUndefined();
    expect(hoisted.shareToRequirementGroup).toHaveBeenCalledTimes(2);
  });

  it("窗口过后相同内容可再发（用户确实想再发一次的出口）", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-01T10:00:00Z"));
    await call({ content: "再发一次" });
    vi.setSystemTime(Date.now() + SHARE_TO_GROUP_DEDUP_WINDOW_MS - 1000);
    expect((await call({ content: "再发一次" })).skipped).toBe(true);
    vi.setSystemTime(Date.now() + 2000);
    const again = await call({ content: "再发一次" });
    expect(again.skipped).toBeUndefined();
    expect(hoisted.shareToRequirementGroup).toHaveBeenCalledTimes(2);
  });

  it("发送明确失败 → 退坑，重试放行（失败那次不算「发过」）", async () => {
    hoisted.shareToRequirementGroup.mockRejectedValueOnce(
      new hoisted.FeishuGroupError("群不可达", "group_unreachable"),
    );
    const failed = await call({ content: "会失败" });
    expect(failed).toMatchObject({ ok: false, code: "group_unreachable" });
    const retry = await call({ content: "会失败" });
    expect(retry).toMatchObject({ ok: true, messageId: "om_1" });
    expect(hoisted.shareToRequirementGroup).toHaveBeenCalledTimes(2);
  });

  it("非 FeishuGroupError 的抛错同样退坑", async () => {
    hoisted.shareToRequirementGroup.mockRejectedValueOnce(new Error("boom"));
    expect((await call({ content: "x" })).ok).toBe(false);
    expect((await call({ content: "x" })).ok).toBe(true);
  });

  it("并发的相同内容调用：只放第一个、其余 skipped_duplicate（发之前占位）", async () => {
    let release!: () => void;
    hoisted.shareToRequirementGroup.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ chatName: "需求群", messageId: "om_slow" });
        }),
    );
    const first = call({ content: "并发" });
    await new Promise((r) => setImmediate(r)); // 让第一个进到 await 里
    const second = await call({ content: "并发" });
    expect(second.outcome).toBe("skipped_duplicate");
    release();
    expect(await first).toMatchObject({ ok: true, messageId: "om_slow" });
    expect(hoisted.shareToRequirementGroup).toHaveBeenCalledTimes(1);
  });

  it("caller token 不匹配：照旧拒绝，不占位", async () => {
    const r = await def.handler({ task_id: TASK, content: "非法" }, "bad-token");
    expect((r.content[0] as { text: string }).text).toContain("");
    expect(hoisted.shareToRequirementGroup).not.toHaveBeenCalled();
    // 非法调用没占位：合法调用不会被当重复
    expect((await call({ content: "非法" })).ok).toBe(true);
  });
});
