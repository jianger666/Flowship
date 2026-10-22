/**
 * 任务事件流里两条系统事件的文案 / 形态（纯函数、可单测；task-runner 只负责写）
 *
 * 第二轮 review：
 *  - V12-04：标记合入 / 放弃的收尾 info 原先写死 `main`、夹英文 abandon、叫「Task」；
 *  - V12-03：MR「有冲突」是**成功**的事（MR 已建好 / 推上去，只是要人手动解冲突），
 *    却以 kind=error 写入 → 红色错误卡 + 一个会重放旧 user_reply 的「重试」。
 */

/** 任务收尾（标记合入 / 放弃）后写进事件流的那句话；不写死分支名 */
export const formatFinalizeNotice = (
  finalStatus: "merged" | "abandoned",
  reason?: string,
): string => {
  const head = finalStatus === "merged" ? "任务已标记为已合入" : "任务已放弃";
  const why = reason?.trim();
  return why ? `${head}（${why}）` : head;
};

export interface MrNoticeInput {
  actionId: string;
  /** 「创建」/「推送（v2）」——拼进「MR 已{动作}」 */
  mrVerb: string;
  targetBranch: string;
  url: string;
  hasConflicts: boolean;
  /** 业务 meta（repoPath / mrUrl / mergeStatus …）原样带上 */
  meta: Record<string, unknown>;
}

export interface MrNoticeEvent {
  kind: "info";
  actionId: string;
  text: string;
  meta: Record<string, unknown>;
}

/**
 * MR 建好 / 推上去后的事件：永远是 info（MR 已经成功了）。
 * 有冲突时多带 `meta.notice`——行动指引形态（默认展开、保留换行），用户一眼看到「这条 MR 要手动解冲突」，
 * 但不再是红色错误卡、也没有「重试」。
 */
export const buildMrNoticeEvent = (input: MrNoticeInput): MrNoticeEvent => {
  const { actionId, mrVerb, targetBranch, url, hasConflicts, meta } = input;
  return {
    kind: "info",
    actionId,
    text: hasConflicts
      ? `MR 已${mrVerb}、但跟 ${targetBranch} 有冲突、需用户手动解决后才能合：${url}`
      : `MR 已${mrVerb}：${url}`,
    meta: hasConflicts ? { ...meta, notice: true } : { ...meta },
  };
};
