"use client";

/**
 * AskUserDialog（V0.3.2 ask_user 弹窗、用户拍板的形态、V0.5.6 加「稍后再补充」、V0.8.3 每题支持贴图）
 *
 * 跟 V0.3 inline 卡片的差异：
 *   - **弹窗**：在 task 详情页顶层挂、不在 event stream 里、不会被 thinking / tool_call 等过程事件淹没
 *   - **一次问完所有问题**：agent 调 ask_user 时把所有不确定项打包成 questions[]
 *   - **ABCD 前缀**：每个 option 自动加 A/B/C/D 字母前缀（像 Cursor askFollowUpQuestion）
 *   - **一次提交**：所有 question 都答完才能点提交、批量送给 agent
 *   - **强制 action**：不允许 dismiss（点 backdrop / Esc）、避免用户关掉后 agent 永远等
 *
 * V0.5.6 加「稍后再补充」按钮（用户拍板）：
 *   - 配合「ask_user 无次数上限」、给用户一个退出循环的口子
 *   - 点 → useDialog().confirm 二次确认 → POST 时 body 带 deferred:true
 *   - agent 拿到 [ASK_USER_REPLY deferred] 头、跳过这组 Q、按 default 推进、列进 artifact §6 待澄清
 *
 * V0.8.3 每题贴图（用户拍板「每个题各自绑各自的」）：
 *   - 每道题抽成 `AskQuestionItem` 子组件、各自 call 一次 useImageAttach（hook 规则不能在 map 里调、
 *     故必须按子组件拆）、互不影响、零碰 ReviseDialog / EventStream 等老调用方。
 *   - 子组件把「本题回答态 + 图」上报父组件、父汇总成 answers[] + imagesByQuestion 提交。
 *   - **仅「自定义回答」模式能贴图**（用户拍板）：附图按钮 / 缩略图 / 粘贴 / 拖拽整体收在自定义回答区、
 *     选了固定选项就隐藏且上报空图（图状态保留、再切回自定义会重现、不丢用户已贴的图）。
 *   - 自定义回答里图-only（只贴图不填字）也算已答；归属靠后端 replyText 每题内联「本题附图：<basename>」兜住。
 *
 * 数据流：
 *   1. 监听 task.events、找最新一条 ask_user_request 且没对应 ask_user_reply 的 → 弹窗
 *   2. 用户选 option / 写自定义文本 / 贴图 → 子组件上报、父 drafts state 累积
 *   3. 全答完点提交 → POST /api/tasks/[id]/ask-reply、body 带 answers[] + imagesByQuestion
 *      或点「稍后再补充」→ confirm 后 POST 带 deferred:true、answers 可空
 *   4. 服务端 resolve agent、写 ask_user_reply 事件、SSE 推回来、UI 自动关弹窗
 *
 * 设计原则：
 *   - 答案不在本组件持久化、重新打开时清空（避免半填状态搞乱用户）
 *   - 提交失败 toast、按钮回到可点状态
 *   - 已答的 askId 不再弹（看 task.events 里有没有 reply）
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Paperclip, Sparkles } from "lucide-react";
import { toast } from "sonner";

import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ChoiceButton } from "@/components/ui/choice-button";
import { ImageThumb } from "@/components/ui/image-preview";
import { Textarea } from "@/components/ui/textarea";
import { findPendingAskEvent } from "@/lib/ask-pending";
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

// 单条问题在 dialog 里的回答态（子组件上报、父汇总）
// - optionId：选了哪个 option（undefined = 还没选 / 走自定义）
// - text：自定义模式下的自由文本
// - images：本题各自绑的图。**仅自定义回答模式才带**——选了固定选项（A/B/C）上报空数组
//   （用户拍板：没选自定义回答不该能附图、附了图再切回选项也不带）
// 提交时按 optionId 优先、没选才用 text；图单独走 imagesByQuestion
interface AnswerDraft {
  optionId?: string;
  text: string;
  images: ImagePayload[];
}

interface AskUserDialogProps {
  task: Task;
  // 收到答案后父组件刷新（实际上 SSE 也会推、这里是兜底）
  onAnswered?: () => void;
}

// 从 ev.meta 抠 questions[]
// meta 不规整时返空、上层判定空就不弹（防御）
const extractQuestions = (
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
      allowText:
        typeof m.allowText === "boolean" ? m.allowText : true,
    });
  }
  return out;
};

// 字母前缀：A/B/C/D/E/F、超过就空（一般不会超 6 个）
// 跟 Cursor askFollowUpQuestion 一样、option 自动加字母
const LETTER_PREFIX = ["A", "B", "C", "D", "E", "F"];

// 判断一道题是否已答：选了 option / 填了文字 / 贴了图、任一即算
const isDraftAnswered = (d?: AnswerDraft): boolean =>
  !!d &&
  (!!d.optionId || d.text.trim().length > 0 || d.images.length > 0);

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
 *
 * 为什么拆子组件：useImageAttach 是 hook、不能在父组件的 questions.map 里循环调用
 * （违反 hooks 规则）。每道题各自一个子组件实例 = 各自合法地 call 一次 hook、
 * 各绑各的图。父组件只负责汇总上报上来的 draft。
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

  // 仅「自定义回答」模式能带图：选了固定选项（A/B/C）就不带图——即使之前在自定义模式附过、
  // 切到选项后也不提交（用户拍板）。纯文本题（无 options）天然算自定义模式。
  const inCustomMode = otherMode || !hasOptions;

  // 上报本题回答态（含图）给父组件。
  // 依赖含 otherMode：切自定义 / 选项时图要不要带会变。images 是 hook 内 useState、
  // 未变时引用稳定、父 re-render 不会触发本 effect、故无死循环。payload 直接由 images map 出、
  // 不依赖 hook 的 toUploadPayload（那是每次 render 新建的函数、放 deps 会死循环）。
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
        {/* agent 的问题常带 inline code / 编号列表、按 markdown 渲染
            min-w-0：flex item 防长 inline code 撑破 dialog（参考 Dialog 溢出沉淀） */}
        <div className="min-w-0 flex-1 text-sm leading-relaxed">
          <MarkdownText text={question.question} />
        </div>
      </div>

      {/* 选项区：始终显示（如果该 question 有 options）
          切到自定义模式后也保留、用户随时能从 textarea 跳回点选项 */}
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
          {/* 「自定义回答」入口：进自定义模式后高亮 */}
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

      {/* 自定义回答区：有 options 时点「自定义回答」才出现、纯文本题常显。
          图附件（附图按钮 / 缩略图 / 粘贴 / 拖拽）整体收在这里——只有自定义回答能带图（用户拍板）。
          切回固定选项时本区整体隐藏、上报的图也会被置空（见 inCustomMode）。 */}
      {inCustomMode && (
        <div
          className={cn(
            "flex flex-col gap-2 rounded-md pl-9 transition-colors",
            // 拖拽贴图：drag over 时虚线高亮（仅自定义回答区）
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
            placeholder="输入你的回答…（可粘贴 / 拖拽贴图、或写「不清楚 / 你定」让 AI 按 default 走）"
            rows={3}
            className="resize-none text-sm"
            disabled={submitting}
          />

          {/* 缩略图：发送前可移除单张、点击站内看大图（多图左右切换） */}
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

// ----------------- 主弹窗 -----------------

export const AskUserDialog = ({ task, onAnswered }: AskUserDialogProps) => {
  // useDialog 提供 confirm Promise API、用户点「稍后再补充」时弹二次确认
  const { confirm } = useDialog();
  // 提交快捷键跟设置页个人偏好走（全站统一、不再写死 Cmd+Enter）
  const submitShortcut = useSubmitShortcut();

  // 找最新一条待答的 ask_user_request
  // - 倒序扫、第一条没对应 reply 的就是「当前要弹的」
  // - 一次只弹一个 ask（用户答完才会有下一个 ask、串行）
  // 找当前唯一该弹的 ask：倒序第一条「没了结（未答 且 未作废）」的（判定收口在 lib/ask-pending）。
  // 作废 = 断线重启 / 换 agent / 停止时后端补的 info 标记——排除掉它才不会反复复活失效旧弹窗。
  const pendingEvent = useMemo<TaskEvent | null>(
    () => findPendingAskEvent(task.events),
    [task.events],
  );

  const askId =
    pendingEvent && typeof pendingEvent.meta?.askId === "string"
      ? pendingEvent.meta.askId
      : null;
  const questions = useMemo<AskUserQuestion[]>(
    () => (pendingEvent ? extractQuestions(pendingEvent.meta) : []),
    [pendingEvent],
  );

  // 每个 question 的草稿答案（含图）、由子组件上报、按 question.id 索引
  // askId 变了就重置（换了一组问题）
  const [drafts, setDrafts] = useState<Record<string, AnswerDraft>>({});
  // 提交中：防双击 / 网络重发
  const [submitting, setSubmitting] = useState(false);
  // V0.6.24：agent 已断（task.runStatus=error）时这组 ask 不可能再被响应、
  // dialog 转「失效态」可关、解除「不可 dismiss + 提交 409」的死锁、引导用户去推进重启
  const isStale = task.runStatus === "error";
  // 失效态下「我知道了」关闭弹窗的本地开关（正常态无关闭入口、恒 false、不影响原有强制答题）
  const [dismissed, setDismissed] = useState(false);

  // askId 切换时清状态（保证每次新弹窗都是干净的）
  // 子组件靠 key=`${askId}:${q.id}` 强制 remount、各自重置内部 state
  useEffect(() => {
    setDrafts({});
    setSubmitting(false);
    setDismissed(false);
  }, [askId]);

  // 子组件上报回调：稳定引用（setDrafts 函数式更新）、避免子 effect 抖动
  const handleDraftChange = useCallback((qid: string, draft: AnswerDraft) => {
    setDrafts((prev) => ({ ...prev, [qid]: draft }));
  }, []);

  // 已答题数 + 是否全答完（只看当前这组 question、忽略残留旧 qid）
  const answeredCount = useMemo(
    () => questions.filter((q) => isDraftAnswered(drafts[q.id])).length,
    [questions, drafts],
  );
  const allAnswered = questions.length > 0 && answeredCount === questions.length;

  // 正常态 dismissed 恒 false（无关闭入口）、open 跟着 pendingEvent；失效态可被「我知道了」关
  const open = pendingEvent !== null && !dismissed;

  // 提交：拼 answers[] + imagesByQuestion、POST
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
        return {
          questionId: q.id,
          answer: opt?.label ?? "",
          optionId: d.optionId,
        };
      }
      // 自定义文本、或图-only（answer 留空、后端 replyText 兜底成「见本题附图」）
      return {
        questionId: q.id,
        answer: d?.text.trim() ?? "",
      };
    });
    // 每题各自的图汇总成 imagesByQuestion（key=questionId、空的不带）
    const imagesByQuestion: Record<string, ImagePayload[]> = {};
    for (const q of questions) {
      const imgs = drafts[q.id]?.images;
      if (imgs && imgs.length > 0) imagesByQuestion[q.id] = imgs;
    }
    setSubmitting(true);
    try {
      await submitAskReply(task.id, askId, answers, { imagesByQuestion });
      onAnswered?.();
      // 提交成功：等 SSE 推 ask_user_reply 事件、pendingEvent 自动变 null、dialog 关闭
      // 这里不主动 setOpen(false)、避免 race
    } catch (err) {
      // task-store.submitAskReply 已经把 HTTP 4xx 和网络错都归一成 Error.message
      toast.error(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  };

  // V0.5.6 「稍后再补充」：用户点 → confirm → POST deferred:true
  // 配合 ask_user 无次数上限设计——给用户一个退出循环的口子、agent 跳过这组 Q
  // 走 default 推进、把问题列进 artifact §6 待澄清
  const handleDefer = async () => {
    if (!askId || submitting) return;
    const ok = await confirm({
      title: "稍后再补充这些问题？",
      description:
        "AI 会跳过这一组问题、按 default 推进、并把它们列进方案文档「待澄清 / 不确定项」段。你可以稍后在「再聊聊」或上下文文档里补充。",
      confirmLabel: "确认稍后补",
      cancelLabel: "回去答题",
    });
    if (!ok) return;
    setSubmitting(true);
    try {
      await submitAskReply(task.id, askId, [], { deferred: true });
      onAnswered?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        // 正常态：不允许 dismiss（点 backdrop / Esc 关掉、agent 会永远等答案）
        // 失效态（agent 已断、task.runStatus=error）：允许关、好让用户去「推进」重启
        if (!o && isStale) setDismissed(true);
      }}
    >
      {isStale ? (
        // V0.6.24 失效态：agent 已断、这组 ask 送不达了、解除死锁让用户关掉去重启
        <DialogContent
          className="flex w-full max-w-md flex-col gap-0 overflow-hidden p-0"
          showCloseButton={false}
        >
          <DialogHeader className="flex flex-row items-center gap-2 border-b px-5 py-4">
            <AlertTriangle className="size-4 text-destructive" />
            <DialogTitle className="text-sm">问询已失效</DialogTitle>
          </DialogHeader>
          <div className="px-5 py-4 text-sm leading-relaxed text-muted-foreground">
            Agent 已断开（进程重启 / 异常退出）、这组问题没送达、你刚填的答案也没保存。关闭后在底部输入条说句话即可唤醒当前阶段、AI 会接着读历史（含这组问题）继续。
          </div>
          <DialogFooter className="mx-0 mb-0 border-t px-5 py-3">
            <Button size="sm" onClick={() => setDismissed(true)}>
              我知道了
            </Button>
          </DialogFooter>
        </DialogContent>
      ) : (
      <DialogContent
        className="flex max-h-[80vh] w-full max-w-2xl flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl"
        showCloseButton={false}
        onKeyDown={(e) => {
          // 弹窗级提交快捷键、跟设置页偏好走（全站统一）。事件冒泡到 DialogContent、textarea 的
          // Enter 也会经过这里。两档语义：
          // - mod-enter（默认）：Cmd/Ctrl+Enter 任意焦点（选项按钮 / 容器 / textarea）都可提交
          // - enter：裸 Enter 只在 textarea 内提交（避免焦点在选项按钮 / 容器上时裸 Enter 误提交整表）
          const inTextarea =
            (e.target as HTMLElement).tagName === "TEXTAREA";
          if (submitShortcut === "enter" && !inTextarea) return;
          if (
            shouldSubmitOnKeyDown(
              e as React.KeyboardEvent<HTMLElement>,
              submitShortcut,
            )
          ) {
            e.preventDefault();
            void handleSubmit();
          }
        }}
      >
        <DialogHeader className="flex flex-row items-center gap-2 border-b px-5 py-4">
          <Sparkles className="size-4 text-amber-500" />
          <DialogTitle className="text-sm">
            AI 想跟你确认 {questions.length} 个问题
          </DialogTitle>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          <div className="flex flex-col gap-6">
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
        </div>

        <DialogFooter className="mx-0 mb-0 border-t px-5 py-3">
          {/* mx-0 mb-0 是用来 override DialogFooter 默认的 -mx-4 -mb-4——
              那两条是 shadcn 给「父 DialogContent 有 p-4」的场景设计的全宽 footer 效果。
              这里 DialogContent 用了 p-0（让中间滚动区铺满）、负 margin 会把 footer
              拉到 content 边界外、被 overflow-hidden 裁掉、视觉上「贴底没间距」。 */}
          <div className="flex w-full items-center justify-between gap-2 text-xs text-muted-foreground">
            <span className="shrink-0">
              已答 {answeredCount} / {questions.length}
            </span>
            <div className="flex items-center gap-2">
              {/* V0.5.6 「稍后再补充」：让位主操作用 ghost
                  点 → useDialog.confirm → 后端拼 [ASK_USER_REPLY deferred] 给 agent
                  agent 跳过这组 Q、按 default 推进、列进 artifact §6 待澄清 */}
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
        </DialogFooter>
      </DialogContent>
      )}
    </Dialog>
  );
};
