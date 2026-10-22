"use client";

/**
 * 「排队消息未送达」卡（第二轮 review V3-05）
 *
 * run 出错 / 会话关闭时，排在队里还没发出去的消息会被服务端清掉——气泡直接消失、草稿也没回填，
 * 唯一的痕迹是一条 11px 灰色 truncate 细线，用户得自己回想发过什么。
 * 服务端（chat-runner.noticeQueuedItemsDropped）早已把完整文本放进 `meta.droppedTexts`，这里就是它的读者：
 * 把每条丢掉的话完整摆出来，给「复制」和「放回输入框」。
 *
 * 视觉：这是「你看一眼」的提示、不是失败本身（失败是上面那张错误卡）——白卡 + 左侧 3px warning 线，
 * 颜色只落在图标 / 细条上、文字保持中性（事件流 v2：不靠透明度表达层级）。
 * 「放回输入框」的能力由握着草稿的 EventStream 经 StreamActions 注入；没有输入岛（如 task 页）就不画这个按钮、
 * 只留完整文本 + 复制。
 */

import { useState } from "react";
import { CornerDownLeft, Paperclip, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { droppedNoticeTitle, joinDroppedTexts } from "@/lib/chat-stream-display";
import type { TaskEvent } from "@/lib/types";

import { useStreamActions } from "./stream-actions";
import { ActionTag, formatTs } from "./utils";

export const DroppedQueueCard = ({
  ev,
  texts,
  attachments = [],
  actionTag,
}: {
  ev: TaskEvent;
  /** `meta.droppedTexts`（已过 extractDroppedTexts；可为空——只有图片 / 文件的条没有文字） */
  texts: readonly string[];
  /** `meta.droppedAttachments`（图片 / 文件条的文字占位，Q6-04）：放不回输入框，只列出来提醒重新添加 */
  attachments?: readonly string[];
  /** log 形态的 action 归属标，chat 形态不传 */
  actionTag?: string;
}) => {
  const onRestoreDraft = useStreamActions()?.onRestoreDraft;
  // 已放回：防重复点击把同一段话塞进草稿两遍（卡片被虚拟列表卸载重挂后会复位，可接受）
  const [restored, setRestored] = useState(false);
  const joined = joinDroppedTexts(texts);

  return (
    <div className="mt-1.5 rounded-md border border-l-[3px] border-border border-l-warning bg-card p-3">
      <div className="flex items-start gap-2">
        <TriangleAlert
          aria-hidden
          className="mt-0.5 size-4 shrink-0 text-warning"
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-foreground">
              排队消息未送达
            </span>
            {actionTag && <ActionTag label={actionTag} />}
            <span className="text-[11px] tabular-nums text-muted-foreground">
              {formatTs(ev.ts)}
            </span>
          </div>
          <div className="mt-1 text-sm leading-relaxed text-foreground">
            {droppedNoticeTitle(ev.text)}
          </div>
          {/* 每条丢掉的话各占一块：原文、保留换行；很长的限高滚动，别把卡撑爆 */}
          <ul className="mt-2 space-y-1.5">
            {texts.map((t, i) => (
              <li
                key={i}
                className="max-h-32 overflow-auto whitespace-pre-wrap rounded border border-border bg-background px-2 py-1.5 text-xs leading-relaxed text-foreground wrap-anywhere"
              >
                {t}
              </li>
            ))}
          </ul>
          {attachments.length > 0 && (
            <div className="mt-2 rounded border border-dashed border-border bg-background px-2 py-1.5 text-xs leading-relaxed text-foreground">
              <div className="flex items-center gap-1.5 font-medium">
                <Paperclip aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                图片 / 文件无法放回输入框，请重新添加
              </div>
              <ul className="mt-1 list-disc space-y-0.5 pl-5">
                {attachments.map((a, i) => (
                  <li key={i}>{a}</li>
                ))}
              </ul>
            </div>
          )}
          {texts.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {onRestoreDraft && (
              <Button
                variant="outline"
                size="xs"
                disabled={restored}
                onClick={() => {
                  onRestoreDraft(joined);
                  setRestored(true);
                }}
              >
                <CornerDownLeft />
                {restored ? "已放回输入框" : "放回输入框"}
              </Button>
            )}
            <CopyButton
              text={joined}
              label="复制未送达的消息"
              className="p-1.5"
            />
          </div>
          )}
        </div>
      </div>
    </div>
  );
};
