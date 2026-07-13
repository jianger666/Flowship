"use client";

/**
 * AskUserInlineCard（V0.13.x：ask_user 从模态弹窗改事件流内联答题卡、用户拍板）
 *
 * 背景：模态弹窗是旧 wait_for_user 阻塞协议的遗产——挡住整屏、答题时看不到事件流上下文、
 * 会话失效时还会永久卡死。V0.11 后 ask 非阻塞（agent 提问后结束回合、答案作为新消息送回
 * 同一会话）、业界（Cursor / Claude Code）提问也都是消息流内联卡片。
 *
 * 形态：渲染在事件流的 ask_user_request 行位置（event-stream.tsx 分流：仅「当前待答」的
 * ask 渲染本卡、已答 / 已作废走 AskUserRequestRow 回放）。答题逻辑整体搬自原 AskUserDialog：
 * - 一次问完所有问题、全答完才能提交；每题选项 ABCD / 自定义文本 / 各自贴图
 * - 「稍后再补充」：confirm 后 deferred 提交、agent 按 default 推进
 * - 提交快捷键跟设置页偏好（mod-enter 任意焦点 / enter 仅 textarea 内）
 * - 失效态（runStatus=error）：显示警示 + 禁交互（不挡屏、无需 dismiss）
 *
 * 提交成功后等 SSE 推 ask_user_reply 事件、findPendingAskEvent 变 null、
 * event-stream 自动切回放卡——本组件不管关闭。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Paperclip, Sparkles } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { ChoiceButton } from "@/components/ui/choice-button";
import { ImageThumb } from "@/components/ui/image-preview";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { MarkdownText } from "@/components/tasks/event-stream/rows";
import { useDialog } from "@/hooks/use-dialog";
import { useImageAttach } from "@/hooks/use-image-attach";
import { useSubmitShortcut } from "@/hooks/use-settings";
import { shouldSubmitOnKeyDown } from "@/lib/submit-shortcut";
import { submitAskReply } from "@/lib/task-store";
import type { ImagePayload } from "@/lib/task-store";
import type {
  AskUserAnswer,
  AskUserQuestion,
  Task,
  TaskEvent,
} from "@/lib/types";

// 单条问题的回答态（子组件上报、父汇总）
// - optionId：选了哪个 option（undefined = 还没选 / 走自定义）
// - text：自定义模式下的自由文本
// - images：本题各自绑的图。仅自定义回答模式才带、选固定选项上报空数组
interface AnswerDraft {
  optionId?: string;
  text: string;
  images: ImagePayload[];
}

// 从 ev.meta 抠 questions[]（meta 不规整时返空、上层判定空就不渲染）
export const extractAskQuestions = (
  meta: TaskEvent["meta"],
): AskUserQuestion[] => {
  if (!meta || !Array.isArray(meta.questions)) return [];
  const out: AskUserQuestion[] = [];
  for (const item of meta.questions as unknown[]) {
    if (!item || typeof item !== "object") continue;
    const m = item as Record<string, unknown>;
    if (typeof m.id !== "string" || typeof m.question !== "string") continue;
    const options: AskUserQuestion["options"] = [];
    if (Array.isArray(m.options)) {
      for (const optRaw of m.options as unknown[]) {
        if (!optRaw || typeof optRaw !== "object") continue;
        const o = optRaw as Record<string, unknown>;
        if (typeof o.id === "string" && typeof o.label === "string") {
          options.push({ id: o.id, label: o.label });
        }
      }
    }
    out.push({
      id: m.id,
      question: m.question,
      options: options.length > 0 ? options : undefined,
      allowText: typeof m.allowText === "boolean" ? m.allowText : true,
    });
  }
  return out;
};

// 字母前缀：A/B/C/D/E/F、超过就用数字（一般不会超 6 个）
const LETTER_PREFIX = ["A", "B", "C", "D", "E", "F"];

// 判断一道题是否已答：选了 option / 填了文字 / 贴了图、任一即算
const isDraftAnswered = (d?: AnswerDraft): boolean =>
  !!d && (!!d.optionId || d.text.trim().length > 0 || d.images.length > 0);

// ----------------- 单题子组件 -----------------

interface AskQuestionItemProps {
  question: AskUserQuestion;
  // 题号（从 1 开始展示）
  index: number;
  // 提交锁：提交中禁所有交互
  submitting: boolean;
  // 上报本题回答态（含图）给父组件
  onChange: (qid: string, draft: AnswerDraft) => void;
}

/**
 * 一道题的完整渲染 + 本题图附件管理。
 * 拆子组件的原因：useImageAttach 是 hook、不能在 questions.map 里循环调用——
 * 每题一个子组件实例 = 各自合法 call 一次 hook、各绑各的图。
 */
const AskQuestionItem = ({
  question,
  index,
  submitting,
  onChange,
}: AskQuestionItemProps) => {
  // 本题选了哪个 option（undefined = 没选 / 走自定义文本）
  const [optionId, setOptionId] = useState<string | undefined>(undefined);
  // 自定义文本草稿
  const [text, setText] = useState("");
  const hasOptions = !!question.options && question.options.length > 0;
  // 自定义输入模式：没 options 的纯文本题天然常显 textarea、有 options 的点「自定义回答」才切
  const [otherMode, setOtherMode] = useState(!hasOptions);

  // 本题图附件：各题独立一套（粘贴 / 拖拽 / 选文件 / 缩略图 / 移除）
  const {
    images,
    isDragging,
    fileInputRef,
    maxImages,
    removeImage,
    triggerFilePicker,
    onPaste,
    onDragOver,
    onDragLeave,
    onDrop,
    onFileInputChange,
  } = useImageAttach({ disabled: submitting });

  // 仅「自定义回答」模式能带图：选固定选项（A/B/C）不带（用户拍板）。
  const inCustomMode = otherMode || !hasOptions;

  // 上报本题回答态给父组件（images 引用稳定、无死循环——同原弹窗实现）
  useEffect(() => {
    const imgPayload: ImagePayload[] = inCustomMode
      ? images.map((p) => ({
          data: p.data,
          mimeType: p.mimeType,
          filename: p.file.name,
        }))
      : [];
    onChange(question.id, { optionId, text, images: imgPayload });
  }, [optionId, text, images, inCustomMode, onChange, question.id]);

  // 点选项：写 optionId、清文本、退出自定义模式（图保留、与答案模式无关）
  const handlePickOption = (optId: string) => {
    setOptionId(optId);
    setText("");
    if (hasOptions) setOtherMode(false);
  };

  // 切到自定义模式：清 optionId、文本框出现（图保留）
  const handleEnterOther = () => {
    setOtherMode(true);
    setOptionId(undefined);
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start gap-2">
        <span className="shrink-0 rounded-md bg-muted px-2 py-0.5 font-mono text-xs">
          Q{index}
        </span>
        {/* min-w-0：flex item 防长 inline code 撑破容器 */}
        <div className="min-w-0 flex-1 text-sm leading-relaxed">
          <MarkdownText text={question.question} />
        </div>
      </div>

      {/* 选项区：切到自定义模式后也保留、随时能跳回点选项 */}
      {hasOptions && (
        <div className="flex flex-col gap-1.5 pl-9">
          {question.options!.map((opt, optIdx) => {
            const letter = LETTER_PREFIX[optIdx] ?? String(optIdx + 1);
            const selected = optionId === opt.id;
            return (
              <ChoiceButton
                key={opt.id}
                shape="card"
                selected={selected}
                disabled={submitting}
                onClick={() => handlePickOption(opt.id)}
                className="flex items-start gap-3 px-3 py-2 text-xs hover:bg-primary/5"
              >
                <span
                  className={cn(
                    "shrink-0 rounded-md px-1.5 py-0.5 font-mono text-[10px]",
                    selected
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted text-muted-foreground",
                  )}
                >
                  {letter}
                </span>
                <span className="wrap-break-word">{opt.label}</span>
              </ChoiceButton>
            );
          })}
          {question.allowText && (
            <ChoiceButton
              shape="tab"
              selected={otherMode}
              disabled={submitting}
              onClick={handleEnterOther}
              className="self-start text-xs"
            >
              {otherMode ? "已选：自定义回答（下方输入）" : "自定义回答"}
            </ChoiceButton>
          )}
        </div>
      )}

      {/* 自定义回答区：图附件整体收在这里——只有自定义回答能带图（用户拍板） */}
      {inCustomMode && (
        <div
          className={cn(
            "flex flex-col gap-2 rounded-md pl-9 transition-colors",
            isDragging && "bg-primary/5 p-1 ring-1 ring-primary/30 ring-inset",
          )}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
        >
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onPaste={onPaste}
            placeholder="输入你的回答…"
            rows={3}
            className="resize-none bg-background text-sm"
            disabled={submitting}
          />

          {images.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {images.map((img, i) => (
                <ImageThumb
                  key={img.id}
                  src={img.dataUrl}
                  alt={img.file.name}
                  onRemove={() => removeImage(img.id)}
                  group={images.map((im) => ({
                    src: im.dataUrl,
                    alt: im.file.name,
                  }))}
                  index={i}
                />
              ))}
            </div>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/jpg,image/webp,image/gif"
            multiple
            className="hidden"
            onChange={onFileInputChange}
          />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={triggerFilePicker}
            disabled={submitting}
            className="h-7 gap-1 self-start px-2 text-xs text-muted-foreground"
            title="给本题附图（也支持粘贴 / 拖拽）"
          >
            <Paperclip className="size-3.5" />
            {images.length > 0 ? `本题附图 ${images.length}/${maxImages}` : "附图"}
          </Button>
        </div>
      )}
    </div>
  );
};

// ----------------- 内联答题卡（主组件） -----------------

interface AskUserInlineCardProps {
  task: Task;
  // 当前待答的 ask_user_request 事件（event-stream 分流保证是 findPendingAskEvent 命中的那条）
  ev: TaskEvent;
}

export const AskUserInlineCard = ({ task, ev }: AskUserInlineCardProps) => {
  const { confirm } = useDialog();
  const submitShortcut = useSubmitShortcut();

  const askId = typeof ev.meta?.askId === "string" ? ev.meta.askId : null;
  const questions = useMemo(() => extractAskQuestions(ev.meta), [ev.meta]);

  // 每题草稿答案（含图）、子组件上报、按 question.id 索引
  const [drafts, setDrafts] = useState<Record<string, AnswerDraft>>({});
  // 提交中：防双击 / 网络重发
  const [submitting, setSubmitting] = useState(false);
  // agent 已断（runStatus=error）：这组 ask 送不达、禁交互 + 引导用输入条唤醒
  const isStale = task.runStatus === "error";

  // askId 切换时清状态；子组件靠 key remount 各自重置
  useEffect(() => {
    setDrafts({});
    setSubmitting(false);
  }, [askId]);

  const handleDraftChange = useCallback((qid: string, draft: AnswerDraft) => {
    setDrafts((prev) => ({ ...prev, [qid]: draft }));
  }, []);

  const answeredCount = useMemo(
    () => questions.filter((q) => isDraftAnswered(drafts[q.id])).length,
    [questions, drafts],
  );
  const allAnswered = questions.length > 0 && answeredCount === questions.length;

  // 网断时 fetch 可能挂很久不 reject，按钮会永久「提交中…」——超时强制解锁可重试
  const SUBMIT_UNLOCK_MS = 30_000;

  const handleSubmit = async () => {
    if (!askId || submitting) return;
    if (!allAnswered) {
      toast.error("请把所有问题都答完再提交");
      return;
    }
    const answers: AskUserAnswer[] = questions.map((q) => {
      const d = drafts[q.id];
      if (d?.optionId) {
        const opt = q.options?.find((o) => o.id === d.optionId);
        return { questionId: q.id, answer: opt?.label ?? "", optionId: d.optionId };
      }
      // 自定义文本、或图-only（answer 留空、后端 replyText 兜底成「见本题附图」）
      return { questionId: q.id, answer: d?.text.trim() ?? "" };
    });
    const imagesByQuestion: Record<string, ImagePayload[]> = {};
    for (const q of questions) {
      const imgs = drafts[q.id]?.images;
      if (imgs && imgs.length > 0) imagesByQuestion[q.id] = imgs;
    }
    setSubmitting(true);
    const unlockTimer = window.setTimeout(() => {
      setSubmitting(false);
      toast.error("提交超时，请检查网络后重试，或在底部输入条继续说");
    }, SUBMIT_UNLOCK_MS);
    try {
      await submitAskReply(task.id, askId, answers, { imagesByQuestion });
      // 提交成功：等 SSE 推 ask_user_reply、findPendingAskEvent 变 null、
      // event-stream 自动切回放卡——这里不主动收起、避免 race。
      // SSE 重连间隙另给 15s：卡片可能仍显示「提交中…」
      window.clearTimeout(unlockTimer);
      window.setTimeout(() => setSubmitting(false), 15_000);
    } catch (err) {
      window.clearTimeout(unlockTimer);
      toast.error(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  };

  // 「稍后再补充」：confirm → deferred 提交、agent 跳过这组 Q 按 default 推进
  const handleDefer = async () => {
    if (!askId || submitting) return;
    const ok = await confirm({
      title: "稍后再补充这些问题？",
      description:
        "AI 会跳过这一组问题、按 default 推进、并把它们列进方案文档「待澄清 / 不确定项」段。你可以稍后在输入条里补充。",
      confirmLabel: "确认稍后补",
      cancelLabel: "回去答题",
    });
    if (!ok) return;
    setSubmitting(true);
    const unlockTimer = window.setTimeout(() => {
      setSubmitting(false);
      toast.error("提交超时，请检查网络后重试，或在底部输入条继续说");
    }, SUBMIT_UNLOCK_MS);
    try {
      await submitAskReply(task.id, askId, [], { deferred: true });
      window.clearTimeout(unlockTimer);
      window.setTimeout(() => setSubmitting(false), 15_000);
    } catch (err) {
      window.clearTimeout(unlockTimer);
      toast.error(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  };

  if (!askId || questions.length === 0) return null;

  return (
    <div
      className="flex flex-col gap-4 rounded-md border-2 border-amber-500/40 bg-amber-500/10 p-3"
      onKeyDown={(e) => {
        // 容器级提交快捷键（事件冒泡覆盖 textarea）：
        // - mod-enter（默认）：任意焦点都可提交
        // - enter：只在 textarea 内裸 Enter 提交（焦点在选项按钮时裸 Enter 不误提交整表）
        const inTextarea = (e.target as HTMLElement).tagName === "TEXTAREA";
        if (submitShortcut === "enter" && !inTextarea) return;
        if (shouldSubmitOnKeyDown(e, submitShortcut)) {
          e.preventDefault();
          void handleSubmit();
        }
      }}
    >
      <div className="flex items-center gap-2 text-xs">
        <Sparkles className="size-4 animate-pulse text-amber-500" />
        <span className="font-medium">
          AI 想跟你确认 {questions.length} 个问题
        </span>
      </div>

      {isStale ? (
        // 失效态：不挡屏、无需 dismiss——提示后用户直接用底部输入条唤醒即可
        <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-destructive" />
          Agent 已断开、这组问题暂时送不达。在底部输入条说句话即可唤醒当前阶段、AI 会接着读历史（含这组问题）继续。
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-5">
            {questions.map((q, qIdx) => (
              <AskQuestionItem
                key={`${askId}:${q.id}`}
                question={q}
                index={qIdx + 1}
                submitting={submitting}
                onChange={handleDraftChange}
              />
            ))}
          </div>

          <div className="flex items-center justify-between gap-2 border-t border-amber-500/20 pt-2 text-xs text-muted-foreground">
            <span className="shrink-0">
              已答 {answeredCount} / {questions.length}
            </span>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="ghost"
                disabled={submitting}
                onClick={() => void handleDefer()}
              >
                稍后再补充
              </Button>
              <Button
                size="sm"
                disabled={submitting || !allAnswered}
                onClick={() => void handleSubmit()}
              >
                {submitting ? "提交中…" : "提交全部回答"}
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
};
