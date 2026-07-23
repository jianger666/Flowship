"use client";

/**
 * Skills 左栏：来源导航（固定 5 项、无嵌套；选中态走 ChoiceButton tab）
 */

import { ChoiceButton } from "@/components/ui/choice-button";
import { cn } from "@/lib/utils";

import type { SourceNavKey } from "./types";

export type NavNode = {
  key: SourceNavKey;
  label: string;
  count: number;
};

type Props = {
  nodes: NavNode[];
  selected: SourceNavKey;
  onSelect: (key: SourceNavKey) => void;
  /** 团队规范总开关关 → 该项弱化（仍可点进去开回来） */
  knowledgeDisabled?: boolean;
};

export const SourceNav = ({
  nodes,
  selected,
  onSelect,
  knowledgeDisabled = false,
}: Props) => (
  <nav className="flex w-40 shrink-0 flex-col gap-0.5 border-r border-border/60 pr-2">
    {nodes.map((node) => (
      <ChoiceButton
        key={node.key}
        shape="tab"
        selected={selected === node.key}
        // 纵向导航：铺满栏宽 + 左右排布 label/count（tab 默认偏行内、这里补布局）
        className={cn(
          "flex w-full items-center gap-1.5 py-1.5",
          node.key === "knowledge" && knowledgeDisabled && "opacity-50",
        )}
        onClick={() => onSelect(node.key)}
      >
        <span className="min-w-0 flex-1 truncate">{node.label}</span>
        <span className="shrink-0 tabular-nums text-[11px] opacity-70">
          {node.count}
        </span>
      </ChoiceButton>
    ))}
  </nav>
);
