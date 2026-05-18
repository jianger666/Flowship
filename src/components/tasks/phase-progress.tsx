"use client";

/**
 * Phase 进度条
 * - 顶部按 workflow.phases 顺序展示（feishu-story-impl：plan → build → review、V0.5 起）
 * - 当前 phase 高亮、ack 过的打勾、awaiting_ack 琥珀色待确认、failed 红色
 * - 点击 phase 圆点切换右侧产物面板的 active tab（受控）
 *
 * V0.2 起 phases 序列由父组件传入（任务关联 workflow 决定）、不再写死
 */

import { Check, Circle, CircleDashed, Loader2, X } from "lucide-react";

import { ChoiceButton } from "@/components/ui/choice-button";
import { cn } from "@/lib/utils";
import { PHASE_LABEL, PHASE_LABEL_EN } from "@/lib/task-display";
import type { PhaseId, PhaseState, PhaseStatus } from "@/lib/types";

// 状态 → 圆点 icon / 颜色
const renderDot = (status: PhaseStatus) => {
  switch (status) {
    case "ack":
      return <Check className="size-4" />;
    case "running":
      return <Loader2 className="size-4 animate-spin" />;
    case "awaiting_ack":
      return <Circle className="size-4 fill-current" />;
    case "failed":
      return <X className="size-4" />;
    default:
      return <CircleDashed className="size-4" />;
  }
};

const dotClass = (status: PhaseStatus, isCurrent: boolean): string =>
  cn(
    "flex size-7 items-center justify-center rounded-full border transition-colors",
    {
      "bg-emerald-500/15 border-emerald-500/40 text-emerald-500":
        status === "ack",
      "bg-primary/15 border-primary text-primary":
        status === "running" || (isCurrent && status === "awaiting_ack"),
      "bg-amber-500/15 border-amber-500/50 text-amber-500":
        status === "awaiting_ack" && !isCurrent,
      "bg-destructive/15 border-destructive/50 text-destructive":
        status === "failed",
      "bg-muted/40 border-border text-muted-foreground": status === "pending",
    },
  );

interface Props {
  // 按 workflow 顺序的 phase id 列表（feishu-story-impl: [plan, build, review]、V0.5 起）
  phaseOrder: PhaseId[];
  phases: Record<PhaseId, PhaseState>;
  currentPhase: PhaseId;
  activePhase: PhaseId;
  onActivePhaseChange?: (id: PhaseId) => void;
}

export const PhaseProgress = ({
  phaseOrder,
  phases,
  currentPhase,
  activePhase,
  onActivePhaseChange,
}: Props) => {
  return (
    <div className="flex items-center gap-3">
      {phaseOrder.map((id, idx) => {
        const phase = phases[id];
        const isCurrent = id === currentPhase;
        const isActive = id === activePhase;
        return (
          <div key={id} className="flex items-center gap-3">
            <ChoiceButton
              shape="tab"
              selected={isActive}
              onClick={() => onActivePhaseChange?.(id)}
              className="flex items-center gap-2 px-2 py-1"
            >
              <span className={dotClass(phase.status, isCurrent)}>
                {renderDot(phase.status)}
              </span>
              <span className="font-medium">{PHASE_LABEL[id]}</span>
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground/70">
                {PHASE_LABEL_EN[id]}
              </span>
              {phase.status === "awaiting_ack" && (
                <span className="text-xs text-amber-500">待确认</span>
              )}
              {phase.status === "failed" && (
                <span className="text-xs text-destructive">失败</span>
              )}
            </ChoiceButton>
            {idx < phaseOrder.length - 1 && (
              <div className="h-px w-8 bg-border" aria-hidden />
            )}
          </div>
        );
      })}
    </div>
  );
};
