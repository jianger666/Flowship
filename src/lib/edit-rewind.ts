/**
 * 「编辑已发送的消息」的回退规划（纯函数，客户端用）。
 *
 * 语义对齐 Codex / Cursor IDE：编辑一条旧消息 = 这条消息及之后的对话被删掉、换成编辑后的新对话，
 * 然后从这里重新跑（不是在末尾追加一条新消息）。服务端由 `/rewind` 的 `mode:"edit"` 完成回退：
 * 这条消息有文件检查点就连文件一起还原，没有就只回退对话（见 chat-checkpoint.ts: executeChatEditRewind）。
 *
 * 这里只回答界面要问的几个问题：会删多少、会不会还原文件、要不要先停当前回复、要不要弹确认。
 * 确认的原则：只有「会丢东西」才打扰——还原文件（覆盖未提交改动）或删掉这条之后的几轮对话；
 * 改的是刚发的最后一句、且它没有文件检查点（之后只有 AI 对它的回复）就直接改，不弹窗。
 */

import type { TaskEvent } from "@/lib/types";

export interface EditRewindPlan {
  /** 被编辑的 user_reply 事件 id */
  eventId: string;
  /**
   * 这条消息发出时打过文件检查点 → 会连文件一起还原（覆盖未提交改动）。
   * 检查点可能已被裁掉（只保留最近 20 个）：服务端会自动降级成只回退对话（文件只会少改、不会多改），
   * 所以按「会还原」去提醒是偏安全的方向。
   */
  restoresFiles: boolean;
  /** 这条消息之后（不含它自己）还有几条用户消息——它们和各自的回复都会被删 */
  laterUserTurns: number;
  /** 会被删掉的事件数（含这条消息本身） */
  removedEventCount: number;
  /** 当前有回复在跑：要先停掉才能回退（服务端回退要求没有 run） */
  needsStop: boolean;
  /** 要不要弹确认（会丢东西才弹） */
  needsConfirm: boolean;
}

/**
 * @param events 当前本地事件窗口（编辑点之后的事件一定都在窗口里——窗口是尾部分页）
 * @returns 找不到该事件 / 不是用户消息 → null（调用方不该给这条消息出编辑入口）
 */
export const planEditRewind = (input: {
  events: readonly TaskEvent[];
  eventId: string;
  runActive: boolean;
}): EditRewindPlan | null => {
  const idx = input.events.findIndex((e) => e.id === input.eventId);
  if (idx < 0) return null;
  const target = input.events[idx]!;
  if (target.kind !== "user_reply") return null;

  let laterUserTurns = 0;
  for (let i = idx + 1; i < input.events.length; i++) {
    if (input.events[i]!.kind === "user_reply") laterUserTurns += 1;
  }
  const restoresFiles = target.meta?.checkpointed === true;
  return {
    eventId: input.eventId,
    restoresFiles,
    laterUserTurns,
    removedEventCount: input.events.length - idx,
    needsStop: input.runActive,
    needsConfirm: restoresFiles || laterUserTurns > 0,
  };
};

export interface EditRewindConfirmCopy {
  title: string;
  description: string;
  confirmLabel: string;
}

/** 确认弹窗文案；repoBound = 任务绑了工作目录（没还原文件时要说一声「文件不会动」） */
export const editRewindConfirmCopy = (
  plan: EditRewindPlan,
  opts: { repoBound: boolean },
): EditRewindConfirmCopy => {
  const parts: string[] = [];
  if (plan.restoresFiles) {
    parts.push(
      "将恢复文件到发这条消息时的状态，并删除这条消息及之后的对话" +
        (plan.laterUserTurns > 0
          ? `（其后还有 ${plan.laterUserTurns} 轮）`
          : "") +
        "。未提交的改动会被覆盖；原暂存区（staged/unstaged）区分无法恢复，回退后的内容可能全部处于已暂存状态",
    );
  } else {
    parts.push(
      `这条消息之后的 ${plan.laterUserTurns} 轮对话会被删除，换成编辑后的新对话` +
        (opts.repoBound ? "。文件不会被还原（这条消息没有文件检查点）" : ""),
    );
  }
  if (plan.needsStop) parts.push("当前正在进行的回复会先被停止");
  return {
    title: "编辑并从这里重新开始？",
    description: parts.join("。"),
    confirmLabel: "编辑并重发",
  };
};
