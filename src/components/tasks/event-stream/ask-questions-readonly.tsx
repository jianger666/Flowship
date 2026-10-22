"use client";

/**
 * 失效 / 断线提问的只读题干（第二轮 review V6-01）
 *
 * 失效态的答题卡、「已失效」的回放行原先只剩一行灰字，却叫用户「在底部输入条说句话，
 * AI 会读历史（含这组问题）继续」——用户根本不知道问了什么。这里把题干折叠着放回去：
 * 默认收起（已经不再等答、别抢戏），点开只读。
 *
 * 折叠行样式 / 展开引导线走 stream-style 单一来源，折叠体走 `<Collapse>`（别自写过渡）。
 * 题干是 markdown（常带行内 code），用 MarkdownText 渲染、和答题卡里的题干同一套。
 * 不放在 rows.tsx 里：答题卡（ask-user-inline）和回放行都要用，放叶子文件避免互相 import。
 */

import { useMemo, useState } from "react";

import { MarkdownText } from "@/components/markdown-text";
import {
  ASK_QUESTIONS_READONLY_LABEL,
  readonlyAskQuestions,
} from "@/lib/ask-questions-readonly";
import { cn } from "@/lib/utils";
import type { TaskEvent } from "@/lib/types";

import { Collapse } from "./collapse";
import {
  CollapseChevron,
  PROCESS_BODY_RAIL,
  PROCESS_ROW_BUTTON,
} from "./stream-style";

interface AskQuestionsReadonlyProps {
  /** ask_user_request 事件的 meta（题目在 meta.questions） */
  meta: TaskEvent["meta"];
  /** meta 丢了时退回的事件原文 */
  fallbackText?: string;
  /** 相对路径 inline code 的解析基准（task cwd） */
  baseDir?: string;
}

export const AskQuestionsReadonly = ({
  meta,
  fallbackText,
  baseDir,
}: AskQuestionsReadonlyProps) => {
  // 默认收起：失效了就说明不再等答，题干只是「回头看一眼」
  const [open, setOpen] = useState(false);
  const { items } = useMemo(
    () => readonlyAskQuestions(meta, fallbackText),
    [meta, fallbackText],
  );
  if (items.length === 0) return null;

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={PROCESS_ROW_BUTTON}
      >
        <CollapseChevron open={open} />
        <span className="min-w-0 flex-1 truncate">
          {ASK_QUESTIONS_READONLY_LABEL}
        </span>
      </button>
      <Collapse open={open}>
        <div className={cn(PROCESS_BODY_RAIL, "ml-2 flex flex-col gap-2 py-1")}>
          {items.map((item) => (
            <div key={item.key} className="flex items-start gap-2.5">
              {item.label && (
                <span className="mt-0.5 shrink-0 rounded-sm bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                  {item.label}
                </span>
              )}
              {/* min-w-0：flex item 防长 inline code / 路径撑破卡片（同答题卡题干） */}
              <div className="min-w-0 flex-1 text-sm leading-relaxed text-foreground">
                <MarkdownText text={item.text} baseDir={baseDir} />
              </div>
            </div>
          ))}
        </div>
      </Collapse>
    </div>
  );
};
