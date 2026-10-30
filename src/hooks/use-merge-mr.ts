"use client";

/**
 * 收件箱「合并 MR」动作（确认框 + 请求 + 提示 + 防重入）——待测 MR 行与待回归行共用（Q10-05）。
 *
 * 以前 `MrInboxRow` 和 `RegressionBugRow` 各抄了一份 handleMerge，只有忙碌状态的存法不同；
 * 一处改了（比如 sha 守卫、提示文案）另一处很容易漏。
 */

import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";

import { useDialog } from "@/hooks/use-dialog";
import { useMrInbox } from "@/hooks/use-mr-inbox";
import { describeMergeSuccess } from "@/lib/mr-inbox-messages";

/** 合并一个 MR 所需的最小信息：两种行（待测 MR / 待回归 bug 的关联 MR）都给得出 */
export interface MergeMrTarget {
  mrUrl: string;
  title: string;
  sourceBranch?: string;
  targetBranch?: string;
  /** 扫描那一刻源分支的 HEAD：带上后作者再推新提交会被服务端拒绝，不会把没看过的改动一并合入 */
  headSha?: string;
}

export const useMergeMr = () => {
  const { mergeMr } = useMrInbox();
  const { confirm } = useDialog();
  // 请求进行中（按钮 disabled + 转圈）
  const [merging, setMerging] = useState(false);
  // 同步闸：setState 要等下一次渲染才生效，双击的第二下可能抢在 disabled 之前进来，
  // 也可能在第一下的确认框还开着时又弹出第二个确认框
  const busyRef = useRef(false);

  const merge = useCallback(
    async (target: MergeMrTarget): Promise<void> => {
      if (busyRef.current) return;
      busyRef.current = true;
      try {
        const ok = await confirm({
          title: "合并这个 MR？",
          description: `${target.title}（${target.sourceBranch} → ${target.targetBranch}）`,
          confirmLabel: "合并",
        });
        if (!ok) return;
        setMerging(true);
        try {
          // 带上扫描那一刻的源分支 HEAD：作者之后又推了新提交会被服务端拒绝，而不是把没看过的改动一并合入
          const result = await mergeMr(target.mrUrl, target.headSha);
          toast.success(describeMergeSuccess(result));
        } catch (err) {
          toast.error(
            `合并失败：${err instanceof Error ? err.message : String(err)}`,
          );
        } finally {
          setMerging(false);
        }
      } finally {
        busyRef.current = false;
      }
    },
    [confirm, mergeMr],
  );

  return { merging, merge };
};
