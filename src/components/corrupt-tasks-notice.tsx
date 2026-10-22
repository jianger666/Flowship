"use client";

/**
 * 侧栏底部的「N 个任务数据损坏」提示（F3-02）
 *
 * 为什么要有：任务 meta.json 损坏后，列表接口会把它从 tasks 里拿掉——它从侧栏消失、
 * 点进去还显示「任务不存在」，用户不知道发生了什么。服务端已把这类任务单独放进 `corrupt` 数组
 * （useTaskList().corrupt），这里把它亮出来：哪个任务、为什么、接下来怎么办。
 *
 * 形态刻意克制（用户要求「不要做成红色大块」）：贴在列表滚动区**下方**（不随长列表滚走、有损坏时才出现）的
 * 一行 muted 小字 + warning 色小图标（warning =「你看一眼」，不是 destructive 的「失败」），
 * 点开 Popover 看清单。文案 / 恢复说明全在 lib/corrupt-task-display 的纯函数里（有单测）。
 */

import { AlertTriangle, ChevronRight } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import type { CorruptTaskInfo } from "@/lib/corrupt-task";
import {
  corruptDismissKey,
  dismissCorrupt,
  pruneDismissedCorrupt,
  readDismissedCorrupt,
  visibleCorruptTasks,
  writeDismissedCorrupt,
} from "@/lib/corrupt-task-dismiss";
import {
  corruptSummaryText,
  describeCorruptTask,
} from "@/lib/corrupt-task-display";
import { requestRevealLocalPath } from "@/lib/local-file-open";

const getStorage = (): Storage | null => {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
};

export const CorruptTasksNotice = ({
  corrupt,
  listTrusted = false,
}: {
  corrupt: readonly CorruptTaskInfo[];
  /**
   * 列表已加载且最近一次拉取没失败（loaded && !loadError）。可信时「空列表」= 真的没有损坏，
   * 才清掉已修好任务的忽略记录；不可信（还没加载 / 拉取失败）时空列表不清，免得丢忽略（Q8-04）。
   */
  listTrusted?: boolean;
}) => {
  // 「忽略」记忆（R9a-04）：旧版遗留 / 旧 schema 目录应用修不了也删不掉，不给忽略就会永远挂一条警告
  const [dismissed, setDismissed] = useState<string[]>(() =>
    readDismissedCorrupt(getStorage()),
  );
  const visible = useMemo(
    () => visibleCorruptTasks(corrupt, dismissed),
    [corrupt, dismissed],
  );
  // 任务修好 / 被删之后清掉对应忽略记录（再坏要重新提示）；
  // 列表可信（已加载且没失败）时空列表也清（唯一一条被忽略的任务修好后同类别再坏要重新提示，Q8-04）
  useEffect(() => {
    const pruned = pruneDismissedCorrupt(dismissed, corrupt, { listTrusted });
    if (pruned.length !== dismissed.length) {
      setDismissed(pruned);
      writeDismissedCorrupt(getStorage(), pruned);
    }
  }, [corrupt, dismissed, listTrusted]);
  const dismiss = useCallback(
    (infos: readonly CorruptTaskInfo[]) => {
      const next = dismissCorrupt(dismissed, infos);
      setDismissed(next);
      writeDismissedCorrupt(getStorage(), next);
    },
    [dismissed],
  );

  // 没有损坏（含旧服务端没这个字段 / 全被忽略）时什么都不画，侧栏跟改前一模一样
  if (visible.length === 0) return null;

  const items = visible.map((info) => ({ info, d: describeCorruptTask(info) }));

  return (
    <div className="shrink-0 border-t border-border/60 px-2 py-1.5">
      <Popover>
        <PopoverTrigger
          render={
            <button
              type="button"
              className="flex w-full cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <AlertTriangle
                className="size-3.5 shrink-0 text-warning"
                aria-hidden
              />
              <span className="min-w-0 flex-1 truncate">
                {corruptSummaryText(items.length)}
              </span>
              <ChevronRight className="size-3.5 shrink-0" aria-hidden />
            </button>
          }
        />
        {/* 侧栏在左缘：弹层向右展开、底边对齐触发条（Portal + fixed，不被侧栏 overflow-hidden 裁） */}
        <PopoverContent side="right" align="end" className="w-96 p-2">
          <div className="mb-0.5 flex items-center justify-between gap-2 px-1">
            <span className="text-xs font-medium">数据损坏的任务</span>
            {/* 应用不提供修复 / 删除：给「忽略」让用户能把这条常驻警告收起来（记在本机，任务换了损坏类别会重新提示） */}
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => dismiss(visible)}
            >
              全部忽略
            </Button>
          </div>
          <p className="mb-1 px-1 text-[11px] text-muted-foreground">
            这些任务的目录还在磁盘上，只是 meta.json 读不出来，所以没出现在列表里。
          </p>
          <ul className="max-h-72 divide-y overflow-y-auto">
            {items.map(({ info, d }) => (
              <li key={corruptDismissKey(info)} className="flex flex-col gap-0.5 px-1 py-2 text-xs">
                <span className="font-mono text-[11px] break-all">{d.id}</span>
                <span>{d.reason}</span>
                <span className="text-muted-foreground">{d.recovery}</span>
                {d.metaPath ? (
                  // 需要手动修复 / 排查时才给路径，附复制按钮（路径长、手抄易错）
                  <div className="mt-0.5 flex items-start gap-1.5">
                    <code className="min-w-0 flex-1 font-mono text-[11px] break-all text-muted-foreground">
                      {d.metaPath}
                    </code>
                    <CopyButton
                      text={d.metaPath}
                      label="复制路径"
                      className="shrink-0"
                    />
                  </div>
                ) : null}
                <div className="mt-1 flex items-center gap-1">
                  {d.metaPath ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      onClick={() => {
                        void requestRevealLocalPath(d.metaPath as string).catch(
                          (err) =>
                            toast.error(
                              err instanceof Error
                                ? err.message
                                : "在文件管理器中显示失败",
                            ),
                        );
                      }}
                    >
                      在文件夹中显示
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    onClick={() => dismiss([info])}
                  >
                    忽略
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </PopoverContent>
      </Popover>
    </div>
  );
};
