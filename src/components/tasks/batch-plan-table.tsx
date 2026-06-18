"use client";

/**
 * BatchPlanTable（V0.6.24 起单轨、V0.8.x 改全量总览）
 *
 * 单一真相源：plan agent 调 `set_plan_batches` 上报、落到 ActionRecord.planBatches；
 * 但**展示层用 `deriveEffectiveBatches(task)` 派生的全量有效批次**（不是单个 action 的
 * delta）——这样追加补充需求后、在新 plan artifact 里也能看到完整批次盘子（b1/b2/b3）+
 * 每批进度，跟 advance-dialog 选批 / 进度条同源、不再「选批界面有 b1/b2/b3、artifact 只有 b3」。
 *
 * 中文测试策略标签 / 解释文案全在这里、不依赖 agent 写对、改文案只改本文件。
 */

import { CheckCircle2, Circle } from "lucide-react";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { EffectivePlanBatch } from "@/lib/task-display";
import { TEST_STRATEGY_LABEL } from "@/lib/types";
import { cn } from "@/lib/utils";

interface Props {
  /** 全量有效批次（含 status / sourceActionN，来自 deriveEffectiveBatches）*/
  batches: EffectivePlanBatch[];
  /** 当前查看的 plan action 序号——用于把这次新增的批次标「本次新增」*/
  currentActionN?: number;
}

export const BatchPlanTable = ({ batches, currentActionN }: Props) => {
  // 没批次（小需求 / 没上报）整段不渲染、调用方也判过、双保险
  if (batches.length === 0) return null;

  // 进度（已实现 / 总数）+ 是否跨多次 plan（追加场景才显示「来源 #N」列内标记）
  const done = batches.filter((b) => b.status === "built").length;
  const total = batches.length;
  const multiSource = new Set(batches.map((b) => b.sourceActionN)).size > 1;

  return (
    <div className="not-prose mt-4 overflow-hidden rounded-lg border bg-card">
      {/* 标题 + 进度 + 一句话解释（给用户讲清「这是建议的分批编码顺序」） */}
      <div className="border-b px-4 py-2.5">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">批次划分</h3>
          <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
            {done}/{total} 已实现
          </span>
        </div>
        <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
          建议按下面的批次分批编码实现——每批一个可独立验证的功能块、按依赖顺序排（前批先做）、build
          时逐批推进、每批以新 agent 执行、可单独 review。
        </p>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-16">批次</TableHead>
            <TableHead>标题</TableHead>
            <TableHead>含 task</TableHead>
            <TableHead className="w-24">测试策略</TableHead>
            <TableHead className="w-24">状态</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {batches.map((b) => {
            const built = b.status === "built";
            // 「本次新增」：跨多次 plan 时、属于当前查看 action 的批次才标
            const isNew =
              multiSource &&
              currentActionN != null &&
              b.sourceActionN === currentActionN;
            return (
              <TableRow key={b.effectiveId} className={cn(built && "opacity-70")}>
                <TableCell className="align-top font-mono text-xs text-muted-foreground">
                  <div>{b.rawId}</div>
                  {/* 追加场景标来源：这批是第几次方案引入的 */}
                  {multiSource && (
                    <div className="mt-0.5 text-[10px] text-muted-foreground/70">
                      #{b.sourceActionN}
                    </div>
                  )}
                </TableCell>
                <TableCell className="align-top font-medium">
                  <span>{b.title}</span>
                  {isNew && (
                    <span className="ml-2 inline-block rounded bg-primary/10 px-1.5 py-0.5 align-middle text-[10px] font-normal text-primary">
                      本次新增
                    </span>
                  )}
                </TableCell>
                <TableCell className="align-top text-muted-foreground">
                  {b.taskRefs.join(" / ")}
                </TableCell>
                <TableCell className="align-top whitespace-nowrap">
                  {TEST_STRATEGY_LABEL[b.testStrategy]}
                </TableCell>
                {/* 状态列窄、shadcn td 默认无 whitespace-nowrap（只有 th 有）、
                    不加会把「待实现」挤换行成「待实/现」。span nowrap + icon shrink-0 锁一行 */}
                <TableCell className="align-top whitespace-nowrap">
                  {built ? (
                    <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                      <CheckCircle2 className="size-3.5 shrink-0" />
                      已实现
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-muted-foreground">
                      <Circle className="size-3.5 shrink-0" />
                      待实现
                    </span>
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>

      {/* 测试策略含义脚注：三种策略一句话解释 */}
      <div className="border-t px-4 py-2 text-xs leading-relaxed text-muted-foreground">
        测试策略：
        <strong className="font-medium text-foreground">
          {TEST_STRATEGY_LABEL.tdd}
        </strong>
        ＝先写测试看红再实现到绿；
        <strong className="font-medium text-foreground">
          {TEST_STRATEGY_LABEL.after}
        </strong>
        ＝实现完补关键路径用例；
        <strong className="font-medium text-foreground">
          {TEST_STRATEGY_LABEL.none}
        </strong>
        ＝纯文案 / 样式 / 配置不写测试。
      </div>
    </div>
  );
};
