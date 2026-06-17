"use client";

/**
 * 批次进度入口（V0.6.24 chip + dialog 形态）——对齐「上下文文档 / MCP servers」交互。
 *
 * - 外层紧凑 Button、放进 task 头部 chip 行（跟文档 / MCP 并排）、不占独立行
 * - 拆了批次：实色「批次进度 done/total」chip、点开 Dialog 看进度条 + 每批详情
 * - 没拆批次：灰色「未分批」chip 占位（用户要求、不再 return null）、点开 Dialog 说明 + 引导分批
 * - 数据纯派生自 task.actions（computeBatchProgress）、跟 advance-dialog 选批 / plan 产物表同源
 */

import { useState } from "react";
import { Check, Layers } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { computeBatchProgress } from "@/lib/task-display";
import { TEST_STRATEGY_LABEL } from "@/lib/types";
import type { Task } from "@/lib/types";
import { cn } from "@/lib/utils";

interface Props {
  task: Task;
}

export const BatchProgress = ({ task }: Props) => {
  // 详情 Dialog 开关、默认关
  const [open, setOpen] = useState(false);
  // 批次进度快照（总数 / 已完成 / 每批是否做过）——随 SSE 推 task 自动重算
  const { batches, total, done, doneIds } = computeBatchProgress(task);
  // 是否拆了批次——决定 chip 文案 / 颜色 + Dialog 内容
  const hasBatches = total > 0;
  // 进度百分比（未分批时无意义、置 0）
  const pct = hasBatches ? Math.round((done / total) * 100) : 0;

  return (
    <>
      {/* 触发 chip：拆了批次=实色「批次进度 N/M」、没拆=灰色「未分批」占位 */}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
        className={cn(!hasBatches && "text-muted-foreground")}
      >
        <Layers />
        {hasBatches ? "批次进度" : "未分批"}
        {hasBatches && (
          <span className="ml-1 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
            {done}/{total}
          </span>
        )}
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{hasBatches ? "批次划分" : "未分批"}</DialogTitle>
            <DialogDescription>
              {hasBatches
                ? `大需求分批 build 进度（已完成 ${done}/${total} 批）`
                : "本方案未拆分批次"}
            </DialogDescription>
          </DialogHeader>

          {hasBatches ? (
            <>
              {/* 总进度条 */}
              <div className="h-1.5 overflow-hidden rounded-full bg-border">
                <div
                  className="h-full rounded-full bg-primary transition-all"
                  style={{ width: `${pct}%` }}
                />
              </div>

              {/* 批次列表：已做绿勾 / 待做序号 + 标题 + 测试策略 + 关联 task */}
              <ul className="flex flex-col gap-1.5">
                {batches.map((b, i) => {
                  const isDone = doneIds.has(b.effectiveId);
                  return (
                    <li
                      key={b.effectiveId}
                      className="flex items-start gap-2 rounded-md border px-3 py-2"
                    >
                      {/* 序号 / 绿勾 */}
                      <span
                        className={cn(
                          "mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-full border font-mono text-[10px]",
                          isDone
                            ? "border-primary/40 bg-primary/10 text-primary"
                            : "border-border bg-background text-muted-foreground",
                        )}
                      >
                        {isDone ? <Check className="size-3" /> : i + 1}
                      </span>
                      {/* 标题 + 策略 / 关联 task */}
                      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <div className="flex items-center gap-1.5">
                          <span className="min-w-0 flex-1 truncate text-sm font-medium">
                            {b.title}
                          </span>
                          <Badge
                            variant="outline"
                            className="shrink-0 px-1 py-0 text-[10px]"
                          >
                            #{b.sourceActionN}
                          </Badge>
                          {b.duplicateOfEffectiveId && (
                            <Badge
                              variant="secondary"
                              className="shrink-0 px-1 py-0 text-[10px]"
                            >
                              疑似重复
                            </Badge>
                          )}
                          {isDone && (
                            <Badge
                              variant="secondary"
                              className="shrink-0 px-1 py-0 text-[10px]"
                            >
                              已做
                            </Badge>
                          )}
                        </div>
                        <span className="text-xs text-muted-foreground">
                          {b.rawId} · {TEST_STRATEGY_LABEL[b.testStrategy]}
                          {b.taskRefs.length > 0
                            ? ` · ${b.taskRefs.join(" / ")}`
                            : ""}
                        </span>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </>
          ) : (
            // 未分批：说明 + 引导（跟 plan 产物顶部 A' 提示呼应）
            <p className="text-sm leading-relaxed text-muted-foreground">
              小 / 中需求单次 build 即可。大需求想分批 → 在 plan 用「再聊聊」让
              AI 拆成批次。
            </p>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
};
