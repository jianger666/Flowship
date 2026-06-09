"use client";

/**
 * BatchPlanTable（V0.6.24）——从 planBatches 渲染「批次划分」表
 *
 * 单一真相源（V0.6.24 改单轨）：plan agent 只调 `set_plan_batches` 上报、落到
 * ActionRecord.planBatches、本组件渲染。artifact markdown 不再写批次表——根治旧「双轨」下
 * agent「写了表就忘了调工具」导致批次不生效的 bug。
 *
 * 中文测试策略标签 / 解释文案全在这里、不依赖 agent 写对、改文案只改本文件。
 */

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { TEST_STRATEGY_LABEL } from "@/lib/types";
import type { PlanBatch } from "@/lib/types";

interface Props {
  batches: PlanBatch[];
}

export const BatchPlanTable = ({ batches }: Props) => {
  // 没批次（小需求 / 没上报）整段不渲染、调用方也判过、双保险
  if (batches.length === 0) return null;

  return (
    <div className="not-prose mt-4 overflow-hidden rounded-lg border bg-card">
      {/* 标题 + 一句话解释（给用户讲清「这是建议的分批编码顺序」） */}
      <div className="border-b px-4 py-2.5">
        <h3 className="text-sm font-semibold">批次划分</h3>
        <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
          建议按下面的批次分批编码实现——每批一个可独立验证的功能块、按依赖顺序排（前批先做）、build
          时逐批推进、每批以新 agent 执行、可单独 review。
        </p>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-14">批次</TableHead>
            <TableHead>标题</TableHead>
            <TableHead>含 task</TableHead>
            <TableHead className="w-28">测试策略</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {batches.map((b) => (
            <TableRow key={b.id}>
              <TableCell className="font-mono text-xs text-muted-foreground">
                {b.id}
              </TableCell>
              <TableCell className="font-medium">{b.title}</TableCell>
              <TableCell className="text-muted-foreground">
                {b.taskRefs.join(" / ")}
              </TableCell>
              <TableCell>{TEST_STRATEGY_LABEL[b.testStrategy]}</TableCell>
            </TableRow>
          ))}
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
