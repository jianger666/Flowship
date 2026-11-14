"use client";

import { useRef, useState } from "react";
import { Loader2, Play, TriangleAlert } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { useDialog } from "@/hooks/use-dialog";
import {
  planResumeInterruptedAction,
  type ResumeAdvanceInput,
  type ResumeTaskView,
} from "@/lib/resume-interrupted-action";
import { actionDisplayLabel } from "@/lib/task-display";
import { cn } from "@/lib/utils";

interface Props {
  /** 任务（传整个 Task 即可）：显示与否、还原什么参数都由 planResumeInterruptedAction 判，本组件不碰判定细节 */
  task: ResumeTaskView;
  /**
   * 点「继续」（含二次确认通过）后的提交函数：页面把它接到既有的推进提交链路（handleAdvance 同一条），
   * 提交失败的善后（toast / 开推进弹窗）也在页面里做，本组件只负责「点了才发起」。
   */
  onResume: (input: ResumeAdvanceInput) => Promise<void>;
  /** 页面级推进在途（顶部「推进」按钮的 loading 态）：此时禁用，防叠跑 */
  busy?: boolean;
  className?: string;
}

/**
 * 「上次 Action 被服务重启打断」提示条 + 一键「继续上次 Action」（仅 task 模式详情页；没有可继续的就不画）。
 *
 * 背景：自更新 / 崩溃重启会把在跑的 agent 打断，boot-recovery 把任务标 error。这不是 AI 出错，
 * 用户却得自己回忆「刚才跑的是哪个 action、写了什么指令」。条挂在详情页头部下方（与「已归档」灰条同位），
 * 中性文字 + warning 图标 / 底衬：不是事故、是「你看一眼」。
 *
 * 契约：
 *  - **必须用户点击才起 agent**，不做自动续跑（自动起 agent 是对外副作用，用户可能已不想继续）；
 *  - 点击 = 用原 action 的参数**新开一个 action**（不是唤醒原 action；唤醒是底部输入条说话的语义）；
 *  - ship / dev / custom 可能已部分对外执行（已 push / 已提 MR / 已发通知），先走 `useDialog().confirm`，文案见 resumeConfirmCopy；
 *  - hook 全在「没有可继续的就不画」之前：显示条件会随事件流 / 状态翻转，hook 个数不能跟着变。
 */
export const InterruptedActionBar = ({
  task,
  onResume,
  busy = false,
  className,
}: Props) => {
  const { confirm } = useDialog();
  // 继续在途（含二次确认弹窗打开期间）：按钮 spinner + 禁用
  const [resuming, setResuming] = useState(false);
  // 同步闸：setState 要等下一帧才生效，连点两下可能叠出两条 action；ref 当场上锁
  const resumingRef = useRef(false);
  // 当前判定结果；plan 为 null = 没有可继续的（任务没被重启打断过 / 已有新一轮 / 归档终态 …）
  const plan = planResumeInterruptedAction(task);
  // 最新判定的 ref：二次确认弹窗开着期间任务可能已变（别处推进 / 又重启恢复），确认后要对照它再提交
  const planRef = useRef(plan);
  planRef.current = plan;

  if (!plan) return null;
  const { action } = plan;

  const handleResume = async () => {
    if (resumingRef.current) return;
    resumingRef.current = true;
    setResuming(true);
    try {
      if (plan.confirm) {
        // 对外副作用类 action：焦点留「取消」，避免回车误触发（同「重启更新」确认的做法）
        const ok = await confirm({ ...plan.confirm, defaultFocus: "cancel" });
        if (!ok) return;
        // 确认期间被打断的那条 action 已不是当前判定对象：用户确认的是旧文案，不能偷偷改提交别的
        if (planRef.current?.action.id !== action.id) {
          toast.info("任务状态已变化，已取消继续");
          return;
        }
      }
      await onResume(plan.input);
    } finally {
      resumingRef.current = false;
      setResuming(false);
    }
  };

  return (
    <div
      role="note"
      className={cn(
        "flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-warning/40 bg-warning/10 px-4 py-2 text-xs text-foreground",
        className,
      )}
    >
      <TriangleAlert className="size-3.5 shrink-0 text-warning" aria-hidden="true" />
      <p className="min-w-0 flex-1">
        <span className="font-medium">
          #{action.n} {actionDisplayLabel(action)}
        </span>{" "}
        在服务重启时被中断，agent 已停止。
      </p>
      <Tooltip content="用上次的指令和参数新开一个 action">
        <Button
          type="button"
          size="xs"
          disabled={resuming || busy}
          onClick={() => void handleResume()}
        >
          {resuming ? (
            <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
          ) : (
            <Play aria-hidden="true" />
          )}
          继续上次 Action
        </Button>
      </Tooltip>
    </div>
  );
};
