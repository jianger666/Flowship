"use client";

/**
 * 任务页统一「跟 AI 说」输入条（V0.11.9、事件流底部常驻）
 *
 * 用户拍板的入口合一（原「再聊聊」弹窗 + 「问一问」输入条 + 「重启当前阶段」三合一）：
 * 一个输入条、系统按任务状态自动懂语境：
 * - 当前产出在等审阅（awaiting_ack）→ 按「再聊聊」送（[ACTION_ACK revise]、
 *   agent 自己二分类：纯疑问就答疑、改动意见就改完重新交卷）
 * - 其他时刻、会话在 → 插话（[USER_QUESTION]、疑问就答 / 要改就改、只是不推进任务链——V0.13.x 放开只读限制）
 * - 会话接不回 + 当前 action 停在半路（error / cancelled）→ **唤醒模式**（服务端
 *   起新 agent 原地续同一个 action、用户消息当最新指示、不多一条 action 链——旧「重启当前阶段」的替身）
 * - 会话接不回 + action 已完结 → 一次性临时 agent（疑问就答 / 小改直接改、大改引导走推进）
 *
 * 支持贴图（粘贴 / 附图按钮）；Cmd/Ctrl+J 聚焦（沿用原再聊聊快捷键）。
 * agent 正在跑时禁用；任务终态整条隐藏。
 */

import { useEffect, useRef, useState } from "react";
import { ImagePlus, Loader2, Send } from "lucide-react";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ImageThumb } from "@/components/ui/image-preview";
import { ModelSelect } from "@/components/ui/model-select";
import { Textarea } from "@/components/ui/textarea";
import { useImageAttach } from "@/hooks/use-image-attach";
import { useModels } from "@/hooks/use-models";
import { useSubmitShortcut } from "@/hooks/use-settings";
import { findPendingAskEvent } from "@/lib/ask-pending";
import { getSettings } from "@/lib/local-store";
import { shouldSubmitOnKeyDown } from "@/lib/submit-shortcut";
import { submitTaskQuestion } from "@/lib/task-store";
import type { ModelSelection, Task } from "@/lib/types";

interface Props {
  task: Task;
  // 提交成功后父组件用返回的最新 task 刷状态（running 态 UI 立即切）
  onTaskUpdate: (next: Task) => void;
}

// 输入框自定义拖高的上下界（px）：下界 = 默认两行高、上界防把事件流顶没
const MIN_BOX_HEIGHT = 52;
const MAX_BOX_HEIGHT = 400;

export const TaskTalkComposer = ({ task, onTaskUpdate }: Props) => {
  // 草稿
  const [draft, setDraft] = useState("");
  // 输入框高度（null = 默认）：原生 resize-y 拖柄在右下、往下拉才变高——对贴底输入条反直觉
  //（用户点名）、改成顶边拖柄：往上拉变高、往下拉变矮
  const [boxHeight, setBoxHeight] = useState<number | null>(null);
  // 请求飞行中：防双击
  const [submitting, setSubmitting] = useState(false);
  // 显式指定的模型（id 空 = 跟随会话；选了 = 换这个模型处理本条消息）
  const [pickedModel, setPickedModel] = useState<ModelSelection>({ id: "" });
  const submitShortcut = useSubmitShortcut();
  // 模型列表：打开选择器时按需拉（SWR 缓存、不重复打网络）
  const { models, fetchModels } = useModels();
  // 贴图（粘贴 / 选文件）——revise 高频带截图
  const attach = useImageAttach({ maxImages: 6, disabled: submitting });
  // Cmd/Ctrl+J 聚焦输入条（沿用原「再聊聊」快捷键、入口合一后指到这里）
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "j" || !(e.metaKey || e.ctrlKey)) return;
      e.preventDefault();
      textareaRef.current?.focus();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // agent 在跑时不可说；任务终态整条隐藏
  const busy = submitting || task.runStatus === "running";

  // 有未答提问（且当前阶段没停摆）→ 输入条切「答题引导态」：禁输入、placeholder 指路。
  // 原来能输入、回车才 toast 报 409——用户验收点名「卡点要提前可视化」。
  // 阶段停摆（error/cancelled）时提问已没人接、照常放行（唤醒通道）。
  const halted = task.actions.some(
    (a) =>
      a.id === task.currentActionId &&
      (a.status === "error" || a.status === "cancelled"),
  );
  const awaitingAnswer = !halted && !!findPendingAskEvent(task.events);

  const handleSubmit = async () => {
    const text = draft.trim();
    if ((!text && attach.images.length === 0) || busy) return;
    setSubmitting(true);
    try {
      const images = attach.toUploadPayload();
      // V0.13.x 统一消息通道（用户拍板「别这么多分支」）：全部走 question route、
      // AI 自主二分类（疑问就答 / 要改就改）；产出在等审阅时服务端自动附「重新交卷」上下文
      const updated = await submitTaskQuestion(
        task.id,
        text,
        images,
        pickedModel.id ? pickedModel : undefined,
      );
      onTaskUpdate(updated);
      setDraft("");
      attach.reset();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  // 终态没有可说的对象、整条隐藏
  if (task.repoStatus === "merged" || task.repoStatus === "abandoned") {
    return null;
  }

  return (
    // 输入岛（对齐 chat 输入条形态、V0.12.x 用户点名重整）：圆角边框、focus 高亮、
    // textarea 在上、模型 + 附图 / 发送收进同一条 footer（不再单独一排）
    <div className="border-t px-3 py-2">
      <div className="flex flex-col rounded-lg border bg-background/40 transition-colors focus-within:border-ring/60">
        {/* 顶边拖柄：贴底输入条的直觉方向——往上拉变高。pointer capture 保证拖出手柄仍跟手 */}
        <div
          className="group flex h-2.5 w-full shrink-0 cursor-ns-resize items-center justify-center"
          onPointerDown={(e) => {
            e.preventDefault();
            const startY = e.clientY;
            const startH =
              boxHeight ??
              textareaRef.current?.getBoundingClientRect().height ??
              MIN_BOX_HEIGHT;
            const onMove = (ev: PointerEvent) => {
              const next = Math.min(
                MAX_BOX_HEIGHT,
                Math.max(MIN_BOX_HEIGHT, startH + (startY - ev.clientY)),
              );
              setBoxHeight(next);
            };
            const onUp = () => {
              window.removeEventListener("pointermove", onMove);
              window.removeEventListener("pointerup", onUp);
            };
            window.addEventListener("pointermove", onMove);
            window.addEventListener("pointerup", onUp);
          }}
          aria-label="拖动调整输入框高度"
          title="上下拖动调整高度"
        >
          <div className="h-1 w-10 rounded-full bg-border/60 transition-colors group-hover:bg-muted-foreground/50" />
        </div>

        {/* 已贴的图（发送前可移除、点击看大图）——贴输入框上方 */}
        {attach.images.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-3 pt-2">
            {attach.images.map((img, i) => (
              <ImageThumb
                key={img.id}
                src={img.dataUrl}
                alt={img.file.name}
                className="size-10 rounded bg-background"
                onRemove={() => attach.removeImage(img.id)}
                group={attach.images.map((im) => ({
                  src: im.dataUrl,
                  alt: im.file.name,
                }))}
                index={i}
              />
            ))}
          </div>
        )}

        {/* 高度由顶边拖柄控制（style.height）、不用原生 resize（方向反直觉） */}
        <Textarea
          ref={textareaRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onPaste={attach.onPaste}
          onKeyDown={(e) => {
            if (shouldSubmitOnKeyDown(e, submitShortcut)) {
              e.preventDefault();
              void handleSubmit();
            }
          }}
          placeholder={
            awaitingAnswer ? "先回答上方 AI 的提问" : "想改、想问、贴图都行（⌘/Ctrl+J）"
          }
          rows={2}
          disabled={busy || awaitingAnswer}
          style={boxHeight != null ? { height: boxHeight } : undefined}
          // 没手动拖过：field-sizing 随内容自增、max-h 兜顶；拖过：固定高度接管
          className={cn(
            "min-h-13 resize-none overflow-y-auto border-0 bg-transparent px-3 pt-0.5 pb-2.5 text-sm shadow-none focus-visible:ring-0 dark:bg-transparent",
            boxHeight == null && "max-h-64",
          )}
        />

        {/* footer：左 = 模型（默认跟随会话、下拉里可随时点回）、右 = 附图 + 发送 */}
        <div className="flex items-center justify-between gap-2 px-2 pb-1.5 pt-0.5">
          <ModelSelect
            models={models}
            selection={pickedModel}
            onChange={setPickedModel}
            disabled={busy || awaitingAnswer}
            variant="compact"
            emptyPlaceholder="模型 · 跟随会话"
            followOption="跟随会话"
            onOpenChange={(open) => {
              if (!open) return;
              const s = getSettings();
              if (s.apiKey?.trim() && models.length === 0) void fetchModels(s.apiKey);
            }}
          />
          <div className="flex shrink-0 items-center gap-0.5">
            <Button
              size="icon-xs"
              variant="ghost"
              onClick={attach.triggerFilePicker}
              disabled={busy || awaitingAnswer || attach.images.length >= attach.maxImages}
              aria-label="附图"
              title="附图（也可直接粘贴）"
              className="text-muted-foreground/70"
            >
              <ImagePlus />
            </Button>
            <Button
              size="icon-xs"
              variant="ghost"
              onClick={() => void handleSubmit()}
              disabled={
                busy ||
                awaitingAnswer ||
                (draft.trim().length === 0 && attach.images.length === 0)
              }
              aria-label="发送"
              title="发送"
              className="text-muted-foreground"
            >
              {submitting ? <Loader2 className="animate-spin" /> : <Send />}
            </Button>
          </div>
          <input
            ref={attach.fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/jpg,image/webp,image/gif"
            multiple
            className="hidden"
            onChange={attach.onFileInputChange}
          />
        </div>
      </div>
    </div>
  );
};
