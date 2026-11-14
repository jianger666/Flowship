"use client";

/**
 * 推进弹窗「高级选项」折叠区（默认收起）
 *
 * 只负责壳：折叠头（箭头 + 「高级」+ 取值摘要）+ 过渡展开体；里面放什么由调用方传 children。
 * 折进来的只能是低频纯运行参数（续用 agent / 模型 / 合并后删源分支）——会决定对外副作用走向的选项
 * 与阻断性 / 警示性内容不许进来（接线契约见 tests/advance-advanced-wiring-contract.test.ts）。
 *
 * 要点：
 *  - 摘要在**收起时**显示（用户看不到控件、仍要知道这次实际怎么跑）；偏离默认 / 不可逆倾向的段
 *    用 Badge warning 标出，展开后控件本身就可见，摘要隐藏免得重复；
 *  - 展开体收起时仍挂载（grid-rows 0fr↔1fr 过渡 + inert 挡 tab 焦点），子表单状态与模型下拉不丢，
 *    写法与本弹窗 action 组头折叠一致；
 *  - 触发器带 aria-expanded / aria-controls，摘要里的强调段带 sr-only「注意：」让读屏也分得出。
 */

import { Fragment, useId, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { AdvancedSummarySegment } from "@/lib/advance-advanced-summary";
import { cn } from "@/lib/utils";

interface Props {
  /** 是否展开（受控：偏好 + 强制展开由 useAdvanceAdvancedOpen 合成） */
  open: boolean;
  /** 用户点触发器 */
  onOpenChange: (next: boolean) => void;
  /** 折叠头摘要段（buildAdvancedSummary 产出）；空则只显示「高级」 */
  summary: readonly AdvancedSummarySegment[];
  children: ReactNode;
}

export const AdvanceAdvancedSection = ({
  open,
  onOpenChange,
  summary,
  children,
}: Props) => {
  // aria-controls 指向展开体：useId 保证同页多实例也唯一
  const panelId = useId();
  return (
    <div className="grid">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => onOpenChange(!open)}
        // h-auto + whitespace-normal：摘要放不下时折行、不裁切（被裁掉的偏偏可能是「删除源分支」）
        className="h-auto min-h-7 w-full justify-start gap-1.5 px-2 py-1 text-left text-xs font-normal whitespace-normal text-muted-foreground aria-expanded:bg-transparent aria-expanded:hover:bg-muted"
      >
        <ChevronDown
          className={cn(
            "size-3.5 shrink-0 transition-transform duration-150 motion-reduce:transition-none",
            !open && "-rotate-90",
          )}
        />
        <span className="shrink-0 font-medium">高级</span>
        {!open && summary.length > 0 && (
          <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1.5 gap-y-0.5">
            {summary.map((seg) => (
              <Fragment key={seg.key}>
                <span aria-hidden>·</span>
                {seg.emphasized ? (
                  <Badge variant="warning" size="xs">
                    <span className="sr-only">注意：</span>
                    {seg.text}
                  </Badge>
                ) : (
                  <span>{seg.text}</span>
                )}
              </Fragment>
            ))}
          </span>
        )}
      </Button>
      {/* 展开 / 收起走 grid-rows 过渡：高度平滑变化、弹窗不猛跳；收起时 inert 挡 tab 焦点（仍挂载、状态不丢） */}
      <div
        id={panelId}
        className={cn(
          "grid transition-[grid-template-rows] duration-150 ease-out motion-reduce:transition-none",
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
        )}
        inert={!open}
      >
        <div className="min-h-0 overflow-hidden">
          {/* pt 放内层：收起时（0fr + overflow-hidden）不留空缝 */}
          <div className="pt-1.5">{children}</div>
        </div>
      </div>
    </div>
  );
};
