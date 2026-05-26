"use client";

/**
 * 推进 workflow Dialog（V0.5.7）
 *
 * 触发：plan 任务在 draft / failed / completed / awaiting_user 状态下、顶部「推进」按钮打开。
 *
 * 替代历史上的两个独立按钮 ——「继续监听」（Agent.resume）和「重启 workflow」（Agent.create 从 plan）。
 * V0.5.7 起合并为单一「推进」入口、由用户在 dialog 里显式选「推进方式」：
 *
 * 1. **让原 agent 继续推进**（resume）
 *    - 用 `Agent.resume(lastAgentId)` 复用旧 agent、保留对话历史、新 agent 醒过来调 wait_for_user 续接
 *    - 适用：刚才 wait-ack 长连接突然断了、原 agent 在 Cursor backend 仍然活着
 *    - 不可用条件：task 没有 lastAgentId（如老任务 / agent 从未启动过）
 *    - 后端兜底：如果 Cursor backend 已经清掉旧 agent（NGHTTP2_ENHANCE_YOUR_CALM）、
 *      plan-runner 内部会自动降级 fork（fromPhase=currentPhase）、用户视角一次就能推下去
 *
 * 2. **从某个 phase 重启**（fork from X）
 *    - 用 `Agent.create` 新 agent + super-prompt 顶部 fork banner、从 fromPhase 起跑
 *    - 默认 fromPhase = 下一个未 ack 的 phase（按硬盘 artifact + phase status 推断）
 *    - 适用：原 agent 已经死透、但 plan / build artifact 还想复用；测试新模型 / 新 prompt
 *    - 上游 artifact 会被 agent 直接 read 复用、不会重写
 *
 * 3. **从 Plan 完全重头**（restart）
 *    - 用 `Agent.create` 新 agent + 老 super-prompt 从 plan 起跑
 *    - 适用：测试 prompt 大改动、想看一个 task 从头到尾的纯净跑一遍
 *    - **会覆盖现有 artifact**——agent 重新跑 plan / build / review、之前的内容会被新内容替换
 *
 * 三个选项都会**+1 send 配额**（resume 视情况、其它必然 +1）。
 */

import { useEffect, useMemo, useState } from "react";
import { ArrowRight, Loader2 } from "lucide-react";

import { ChoiceButton } from "@/components/ui/choice-button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { PHASE_LABEL } from "@/lib/task-display";
import type { StartWorkflowMode } from "@/lib/task-store";
import { PHASE_IDS, type PhaseId, type Task } from "@/lib/types";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  task: Task;
  // V0.5.7.1：fork 时支持带 reason（用户填的「想修什么 bug / 重启原因」）、可空
  onSubmit: (
    mode: StartWorkflowMode,
    fromPhase?: PhaseId,
    reason?: string,
  ) => Promise<void>;
  submitting: boolean;
}

// 根据 task.phases 推断「下一个未 ack 的 phase」、给 fork 模式选 fromPhase 时做默认值
// 规则：第一个 status !== "ack" 的 phase（PHASE_IDS 顺序：plan → build → review）
// 全部 ack（completed 任务）→ 兜底选 review、用户可以再改
const inferNextUnackedPhase = (task: Task): PhaseId => {
  for (const pid of PHASE_IDS) {
    const status = task.phases[pid]?.status;
    if (status !== "ack") return pid;
  }
  return "review";
};

// resume 模式可用条件：task 有 lastAgentId
// 没 lastAgentId（如老任务 / agent 从未启动过）→ resume option 显示为 disabled
const canUseResume = (task: Task): boolean => !!task.lastAgentId;

export const AdvanceDialog = ({
  open,
  onOpenChange,
  task,
  onSubmit,
  submitting,
}: Props) => {
  // 用户当前选的 mode；dialog 打开时根据 task 状态智能给默认值
  const [mode, setMode] = useState<StartWorkflowMode>("resume");
  // fork 模式下用户选的 fromPhase；默认 = 下一未 ack
  const [fromPhase, setFromPhase] = useState<PhaseId>(() =>
    inferNextUnackedPhase(task),
  );
  // V0.5.7.1：fork 模式下用户填的「想修什么 bug / 重启原因」、可空
  // 留空场景：上一轮 agent 跑挂了 / 用户只想换 phase 起跑、没具体 bug
  // 填了场景：用户自己跑过代码、发现 N 个 bug、按 bug 说明定向修复
  const [reason, setReason] = useState<string>("");

  // 推断的默认 fromPhase（每次 task 变化重算）
  const inferredFromPhase = useMemo(
    () => inferNextUnackedPhase(task),
    [task],
  );
  const resumeAvailable = useMemo(() => canUseResume(task), [task]);

  // dialog 打开时重置选项：
  //   - resume 可用 + task 非 draft → 默认 resume（最低成本路径）
  //   - 其它情况 → 默认 fork（从推断的 fromPhase 起跑、复用 artifact）
  useEffect(() => {
    if (!open) return;
    if (resumeAvailable && task.status !== "draft") {
      setMode("resume");
    } else {
      setMode("fork");
    }
    setFromPhase(inferredFromPhase);
    // V0.5.7.1：每次打开 dialog 都清空 reason、避免上次填的串到本次
    setReason("");
  }, [open, resumeAvailable, task.status, inferredFromPhase]);

  const handleSubmit = async () => {
    if (mode === "fork") {
      // V0.5.7.1：fork 时把 reason（trim 后）传给上层、空字符串过滤掉
      await onSubmit(mode, fromPhase, reason.trim() || undefined);
    } else {
      await onSubmit(mode);
    }
  };

  // 「推进」按钮文案根据选项变化、给用户预期
  const submitLabel = (() => {
    if (submitting) return "推进中…";
    if (mode === "resume") return "让原 agent 继续";
    if (mode === "fork") return `从 ${PHASE_LABEL[fromPhase]} 起跑`;
    return "从头重跑";
  })();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>推进任务</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-3 py-2">
          {/* Option 1: resume */}
          <ChoiceButton
            shape="card"
            selected={mode === "resume"}
            onClick={() => setMode("resume")}
            disabled={!resumeAvailable || submitting}
            className="flex flex-col gap-1"
            title={
              resumeAvailable
                ? "复用原 agent、保留对话历史"
                : "本任务没有 lastAgentId（如 agent 从未启动）"
            }
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium">让原 agent 继续推进</span>
              <span className="text-[10px] text-muted-foreground">推荐</span>
            </div>
            <p className="text-xs text-muted-foreground leading-relaxed">
              复用旧 agent ID 续接、保留对话历史、agent 重新调 wait_for_user。
              如果 Cursor backend 已清掉旧 agent（NGHTTP2_ENHANCE_YOUR_CALM）、
              会自动降级为「起新 agent 从当前 phase 接力」。
              {!resumeAvailable && (
                <span className="block mt-1 text-amber-500">
                  此任务无 lastAgentId、不可用
                </span>
              )}
            </p>
          </ChoiceButton>

          {/* Option 2: fork from X */}
          <ChoiceButton
            shape="card"
            selected={mode === "fork"}
            onClick={() => setMode("fork")}
            disabled={submitting}
            className="flex flex-col gap-2"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium">从指定 phase 重启</span>
              <span className="text-[10px] text-muted-foreground">
                +1 send 配额
              </span>
            </div>
            <p className="text-xs text-muted-foreground leading-relaxed">
              起一个新 agent、读取上游 artifact 拿上下文、从你选的 phase 开始跑。
              上游 phase 的 artifact 会被复用（不会重写）。
            </p>
            {mode === "fork" && (
              <>
                <div className="flex items-center gap-2 pt-1">
                  <span className="text-xs text-muted-foreground">从</span>
                  <div className="flex gap-1">
                    {PHASE_IDS.map((pid) => (
                      <ChoiceButton
                        key={pid}
                        shape="chip"
                        selected={fromPhase === pid}
                        onClick={(e) => {
                          e.stopPropagation();
                          setFromPhase(pid);
                        }}
                        disabled={submitting}
                      >
                        {PHASE_LABEL[pid]}
                      </ChoiceButton>
                    ))}
                  </div>
                  <ArrowRight className="size-3 text-muted-foreground" />
                  <span className="text-xs text-muted-foreground">开始</span>
                  {fromPhase === inferredFromPhase && (
                    <span className="ml-1 text-[10px] text-primary/80">
                      （推断的下一未完成 phase）
                    </span>
                  )}
                </div>
                {/* V0.5.7.1：bug 描述 textarea、可留空 */}
                {/* 之所以放 fork 选项内：reason 只在 fork 模式下有意义、resume / restart 不需要 */}
                <div
                  className="flex flex-col gap-1 pt-1"
                  onClick={(e) => e.stopPropagation()}
                >
                  <label
                    htmlFor="advance-fork-reason"
                    className="text-xs text-muted-foreground"
                  >
                    这次主要想修什么？
                    <span className="ml-1 text-[10px]">（可留空、AI 会自己看 git diff）</span>
                  </label>
                  <Textarea
                    id="advance-fork-reason"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                        e.preventDefault();
                        void handleSubmit();
                      }
                    }}
                    placeholder="例：A 上拉加载第二页空白；B 学情详情冷启动 500；C 跳转 query 漏了 NEW_C"
                    disabled={submitting}
                    rows={3}
                    className="text-xs"
                  />
                </div>
              </>
            )}
          </ChoiceButton>

          {/* Option 3: restart from plan */}
          <ChoiceButton
            shape="card"
            selected={mode === "restart"}
            onClick={() => setMode("restart")}
            disabled={submitting}
            className="flex flex-col gap-1"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium">从头完全重跑</span>
              <span className="text-[10px] text-destructive">
                覆盖现有 artifact
              </span>
            </div>
            <p className="text-xs text-muted-foreground leading-relaxed">
              起一个新 agent、从 Plan 完全重头跑。
              <span className="text-destructive">
                现有的 plan / build / review artifact 会被新 agent 重新生成覆盖
              </span>
              、适合改了 prompt / 想完整看一遍重跑结果。
            </p>
          </ChoiceButton>
        </div>

        <DialogFooter className="gap-2">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            取消
          </Button>
          <Button onClick={handleSubmit} disabled={submitting}>
            {submitting && <Loader2 className="animate-spin" />}
            {submitLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
