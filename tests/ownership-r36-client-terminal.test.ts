/**
 * R35-2 / R35-5 → R36 退出矩阵（client Operation + TaskTerminalCoordinator）
 *
 * ① SSE 终态先到、fetch 后 reject → 视为已接受、清草稿、不生成新 id
 * ② 空文本不同附件 / 同文案不同 skill → 不复用旧 operation
 * ③ detail/list/chat mutation 200 在 task_deleted 后到达 → 不得复活
 * ④ 在线帧与重连 410 走同一 commitTaskDeleted
 * ⑤ 同 id 已 deleted 后切到其它 task 再切回 → 仍 sticky deleted
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  computeChatPayloadFingerprint,
  fingerprintFromChatSendArgs,
  imageKeysFromPayloads,
} from "@/lib/chat-payload-fingerprint";
import {
  allocClientChatQueueItemId,
  emptyChatOpState,
  findReusableUncertainOperation,
  reduceChatOperation,
  type ChatOperation,
} from "@/lib/chat-pending-reconcile";
import {
  canCommitTaskListRefresh,
  filterTaskListAfterRefresh,
} from "@/lib/task-list-refresh";
import {
  __resetTaskTerminalForTests,
  canCommitTaskSnapshot,
  commitTaskDeleted,
  getTaskTerminalGeneration,
  isTaskTerminalDeleted,
  subscribeTaskTerminalList,
} from "@/lib/task-terminal";
import type { TaskSummary } from "@/lib/types";

afterEach(() => {
  __resetTaskTerminalForTests();
});

const op = (
  partial: Partial<ChatOperation> &
    Pick<ChatOperation, "itemId" | "payloadFingerprint" | "displayText">,
): ChatOperation => ({
  text: partial.text ?? partial.displayText,
  phase: partial.phase ?? "sending",
  ...partial,
});

describe("R35-2：Operation reducer（HTTP ↔ SSE 仲裁）", () => {
  it("① server 已 handedOff、SSE 终态先到、fetch 随后 reject → 清草稿、不标 uncertain", () => {
    // R36-2：user_reply 仅 persisted；成功终态来自 message_op handedOff/delivered
    const itemId = "cq_r36_sse_first";
    const fp = fingerprintFromChatSendArgs({ text: "hello" });
    let state = emptyChatOpState();

    // 请求前登记
    state = reduceChatOperation(state, {
      type: "register",
      op: op({
        itemId,
        payloadFingerprint: fp,
        displayText: "hello",
        text: "hello",
      }),
    }).state;
    expect(state.pending).toHaveLength(1);

    // SSE user_reply → persisted（非终态）
    state = reduceChatOperation(state, {
      type: "user_reply",
      ev: { text: "hello", meta: { queueItemId: itemId } },
    }).state;
    expect(state.pending[0]?.phase).toBe("persisted");
    expect(state.outcomes[itemId]).toBeUndefined();

    // message_op handedOff → delivered
    state = reduceChatOperation(state, {
      type: "message_op",
      itemId,
      phase: "handedOff",
    }).state;
    expect(state.pending).toHaveLength(0);
    expect(state.outcomes[itemId]).toBe("delivered");
    expect(state.settled).toContain(itemId);

    // HTTP 随后 network reject → clearDraft=true，不回 uncertain
    const rejected = reduceChatOperation(state, {
      type: "http_reject_network",
      itemId,
    });
    expect(rejected.clearDraft).toBe(true);
    expect(rejected.state.pending).toHaveLength(0);
    expect(
      findReusableUncertainOperation(rejected.state.pending, fp),
    ).toBeUndefined();

    // 用户再点发送：无 uncertain 可复用 → 必须新 id（不会拿旧 id 双发）
    const nextId = allocClientChatQueueItemId();
    expect(nextId).not.toBe(itemId);
    const reuse = findReusableUncertainOperation(rejected.state.pending, fp);
    expect(reuse).toBeUndefined();
  });

  it("①b failed 终态 + fetch reject → 保留草稿（clearDraft=false）", () => {
    const itemId = "cq_r36_failed";
    let state = emptyChatOpState();
    state = reduceChatOperation(state, {
      type: "register",
      op: op({
        itemId,
        payloadFingerprint: "fp_x",
        displayText: "x",
      }),
    }).state;
    state = reduceChatOperation(state, {
      type: "queue_failed",
      itemIds: [itemId],
    }).state;
    expect(state.outcomes[itemId]).toBe("failed");

    const rejected = reduceChatOperation(state, {
      type: "http_reject_network",
      itemId,
    });
    expect(rejected.clearDraft).toBe(false);
  });

  it("①c 无终态 network reject → 标 uncertain", () => {
    const itemId = "cq_r36_unc";
    let state = emptyChatOpState();
    state = reduceChatOperation(state, {
      type: "register",
      op: op({
        itemId,
        payloadFingerprint: "fp_u",
        displayText: "u",
      }),
    }).state;
    const rejected = reduceChatOperation(state, {
      type: "http_reject_network",
      itemId,
    });
    expect(rejected.clearDraft).toBe(false);
    expect(rejected.state.pending[0]?.phase).toBe("uncertain");
  });

  it("② 两条空文本不同附件 → 不复用旧 operation", () => {
    const fpA = fingerprintFromChatSendArgs({
      text: "",
      attachments: ["/tmp/a.png"],
    });
    const fpB = fingerprintFromChatSendArgs({
      text: "",
      attachments: ["/tmp/b.png"],
    });
    expect(fpA).not.toBe(fpB);

    const pending: ChatOperation[] = [
      op({
        itemId: "cq_att_a",
        payloadFingerprint: fpA,
        displayText: "[附件]",
        phase: "uncertain",
        attachments: ["/tmp/a.png"],
      }),
    ];
    expect(findReusableUncertainOperation(pending, fpA)?.itemId).toBe(
      "cq_att_a",
    );
    expect(findReusableUncertainOperation(pending, fpB)).toBeUndefined();
  });

  it("②b 同文案不同 skill → 不复用旧 operation", () => {
    const fpA = fingerprintFromChatSendArgs({
      text: "跑一下",
      skills: [{ name: "alpha", absPath: "/skills/alpha" }],
    });
    const fpB = fingerprintFromChatSendArgs({
      text: "跑一下",
      skills: [{ name: "beta", absPath: "/skills/beta" }],
    });
    expect(fpA).not.toBe(fpB);

    const pending: ChatOperation[] = [
      op({
        itemId: "cq_skill_a",
        payloadFingerprint: fpA,
        displayText: "跑一下",
        phase: "uncertain",
      }),
    ];
    expect(findReusableUncertainOperation(pending, fpB)).toBeUndefined();
    expect(findReusableUncertainOperation(pending, fpA)?.itemId).toBe(
      "cq_skill_a",
    );
  });

  it("fingerprint 契约：JSON.stringify([text, imagePaths, attachmentPaths, skills])", () => {
    const imagePaths = imageKeysFromPayloads([
      { data: "aaa", mimeType: "image/png", filename: "x.png" },
    ]);
    const skills = [{ name: "s", absPath: "/s" }];
    const a = computeChatPayloadFingerprint({
      text: "t",
      imagePaths,
      attachmentPaths: ["/a"],
      skills,
    });
    const b = computeChatPayloadFingerprint({
      text: "t",
      imagePaths,
      attachmentPaths: ["/a"],
      skills,
    });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe("R35-5：TaskTerminalCoordinator（sticky deleted）", () => {
  it("③ detail/list/chat mutation 200 在 task_deleted 后到达 → 不可提交", () => {
    const taskId = "t_r36_deleted";
    let listEpoch = 0;
    const successfulDeleted = new Set<string>();
    const list: TaskSummary[] = [
      {
        id: taskId,
        title: "gone",
        mode: "chat",
        repoStatus: "developing",
        runStatus: "idle",
        actionCount: 0,
        createdAt: 1,
        updatedAt: 1,
      } as TaskSummary,
    ];

    const unsub = subscribeTaskTerminalList((id) => {
      listEpoch += 1;
      successfulDeleted.add(id);
    });

    // 模拟在线 task_deleted
    commitTaskDeleted(taskId);
    expect(isTaskTerminalDeleted(taskId)).toBe(true);
    expect(canCommitTaskSnapshot(taskId)).toBe(false);
    expect(listEpoch).toBe(1);

    // 迟到 detail / chat mutation
    expect(canCommitTaskSnapshot(taskId)).toBe(false);

    // 迟到 list refresh（epoch 已推进）
    const startEpoch = 0;
    expect(canCommitTaskListRefresh(startEpoch, listEpoch)).toBe(false);
    const filtered = filterTaskListAfterRefresh(
      list,
      new Set(),
      successfulDeleted,
    );
    expect(filtered.find((t) => t.id === taskId)).toBeUndefined();

    unsub();
  });

  it("④ 在线帧与重连 410 走同一 commitTaskDeleted", () => {
    const taskId = "t_r36_same_sink";
    let commits = 0;
    const unsub = subscribeTaskTerminalList(() => {
      commits += 1;
    });

    // 在线帧
    commitTaskDeleted(taskId);
    const gen1 = getTaskTerminalGeneration(taskId);
    // 重连 410（同一 sink，幂等 sticky；R36-7：404 不再走此 sink）
    commitTaskDeleted(taskId);
    const gen2 = getTaskTerminalGeneration(taskId);

    expect(isTaskTerminalDeleted(taskId)).toBe(true);
    expect(commits).toBe(2);
    expect(gen2).toBeGreaterThan(gen1);

    unsub();
  });

  it("⑤ 同 id 已 deleted 后切到其它 task 再切回 → 仍 deleted（sticky）", () => {
    const a = "t_r36_sticky_a";
    const b = "t_r36_sticky_b";
    commitTaskDeleted(a);

    // 切到 B
    expect(canCommitTaskSnapshot(b)).toBe(true);
    // 再切回 A——仍不可提交（不因路由切换解除）
    expect(isTaskTerminalDeleted(a)).toBe(true);
    expect(canCommitTaskSnapshot(a)).toBe(false);
  });

  it("本 tab DELETE 成功路径：list listener 推进 epoch + 记 id", () => {
    const taskId = "t_r36_local_del";
    let epoch = 0;
    const deletedIds = new Set<string>();
    const unsub = subscribeTaskTerminalList((id) => {
      epoch += 1;
      deletedIds.add(id);
    });

    commitTaskDeleted(taskId);
    expect(epoch).toBe(1);
    expect(deletedIds.has(taskId)).toBe(true);
    expect(canCommitTaskSnapshot(taskId)).toBe(false);

    unsub();
  });
});
