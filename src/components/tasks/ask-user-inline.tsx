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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Sparkles } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { ChoiceButton } from "@/components/ui/choice-button";
import { ComposerSessionProvider } from "@/components/composer-session";
import { RichInput } from "@/components/rich-input";
import { cn } from "@/lib/utils";
import { MarkdownText } from "@/components/tasks/event-stream/rows";
import { extractAskQuestions } from "@/lib/ask-pending";
import { useDialog } from "@/hooks/use-dialog";
import { useRichInput } from "@/hooks/use-rich-input";
import { useSubmitShortcut } from "@/hooks/use-settings";
import { MAX_SKILL_REFS } from "@/lib/protocol-signals";
import { shouldSubmitOnKeyDown } from "@/lib/submit-shortcut";
import { submitAskReply } from "@/lib/task-store";
import type { ImagePayload } from "@/lib/task-store";
import type {
  AskUserAnswer,
  AskUserQuestion,
  Task,
  TaskEvent,
} from "@/lib/types";

// 答题框固定高度（px、约 3 行）：卡片内嵌在事件流里、不该随内容长高把上下文顶走
const ASK_INPUT_HEIGHT = 84;

// 单条问题的回答态（子组件上报、父汇总）
// - optionId：选了哪个 option（undefined = 还没选 / 走自定义）
// - text：自定义模式下的自由文本
// - images：本题各自绑的图。仅自定义回答模式才带、选固定选项上报空数组
// - skillRefs：本题 `/` 引用到的 skill（父组件合并去重后随 ask-reply 一起送服务端）
interface AnswerDraft {
  optionId?: string;
  text: string;
  images: ImagePayload[];
  skillRefs: Array<{ name: string; absPath: string }>;
}

// 字母前缀：A-Z、超过 26 个回退数字（选项数量不设上限、schema 已放开）
const LETTER_PREFIX = Array.from({ length: 26 }, (_, i) =>
  String.fromCharCode(65 + i),
);

// 判断一道题是否已答：选了 option / 填了文字 / 贴了图、任一即算
const isDraftAnswered = (d?: AnswerDraft): boolean =>
  !!d && (!!d.optionId || d.text.trim().length > 0 || d.images.length > 0);

// 各题 skill 引用合并去重（按 name、保出现序）——一次 ask-reply 只发一条消息、指引拼一份。
// 上限走 MAX_SKILL_REFS 单一源（服务端 parseAndValidateSkills 同源、别再定第二个常量）
const mergeSkillRefs = (
  drafts: Array<AnswerDraft | undefined>,
): Array<{ name: string; absPath: string }> => {
  const seen = new Set<string>();
  const out: Array<{ name: string; absPath: string }> = [];
  for (const d of drafts) {
    for (const s of d?.skillRefs ?? []) {
      if (seen.has(s.name)) continue;
      seen.add(s.name);
      out.push(s);
      if (out.length >= MAX_SKILL_REFS) return out;
    }
  }
  return out;
};

// ----------------- 单题子组件 -----------------

interface AskQuestionItemProps {
  question: AskUserQuestion;
  // 所属任务：`@` 引文件 / 粘贴落盘要用（本题输入内核透传）
  taskId: string;
  /** 相对路径 inline code 解析基准（task cwd） */
  baseDir?: string;
  // 题号（从 1 开始展示）
  index: number;
  // 提交锁：提交中禁所有交互
  submitting: boolean;
  // 上报本题回答态（含图 / skill 引用）给父组件
  onChange: (qid: string, draft: AnswerDraft) => void;
  // 在答题框里按提交快捷键 = 提交整张卡（一题一发没有意义）
  onSubmitAll: () => void;
}

/**
 * 一道题的完整渲染 + 本题输入态。
 * 拆子组件的原因：useRichInput 是 hook、不能在 questions.map 里循环调用——
 * 每题一个子组件实例 = 各自合法 call 一次 hook、各绑各的正文 / 图 / skill 引用。
 */
const AskQuestionItem = ({
  question,
  taskId,
  baseDir,
  index,
  submitting,
  onChange,
  onSubmitAll,
}: AskQuestionItemProps) => {
  // 本题选了哪个 option（undefined = 没选 / 走自定义文本）
  const [optionId, setOptionId] = useState<string | undefined>(undefined);
  const hasOptions = !!question.options && question.options.length > 0;
  // 自定义输入模式：没 options 的纯文本题天然常显输入框、有 options 的点「自定义回答」才切
  const [otherMode, setOtherMode] = useState(!hasOptions);

  // 本题输入态：跟输入条 / 推进弹窗同一套内核（`/` skill、`@` 引文件、贴图）。
  // 不给路径附件——ask-reply 通道不收 attachments（`@` 引用本身以原文进答案、agent 照样能读）。
  const rich = useRichInput({
    taskId,
    disabled: submitting,
    enablePaths: false,
    consumePendingSlash: false,
  });
  const { value: text, setValue: setText, attach, slash } = rich;
  const images = attach.images;

  // 仅「自定义回答」模式能带图：选固定选项（A/B/C）不带（用户拍板）。
  const inCustomMode = otherMode || !hasOptions;

  // 上报本题回答态给父组件（images / references 引用稳定、无死循环——同原弹窗实现）
  const skillReferences = slash.references;
  useEffect(() => {
    const imgPayload: ImagePayload[] = inCustomMode
      ? images.map((p) => ({
          data: p.data,
          mimeType: p.mimeType,
          filename: p.file.name,
        }))
      : [];
    onChange(question.id, {
      optionId,
      text,
      images: imgPayload,
      // 选了固定选项时正文被清空、skill 引用自然也不该带走
      skillRefs: inCustomMode
        ? skillReferences.map((s) => ({ name: s.name, absPath: s.absPath }))
        : [],
    });
  }, [
    optionId,
    text,
    images,
    skillReferences,
    inCustomMode,
    onChange,
    question.id,
  ]);

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
    <div className="flex flex-col gap-2.5">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 shrink-0 rounded-sm bg-muted/80 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
          Q{index}
        </span>
        {/* min-w-0：flex item 防长 inline code 撑破容器；问题走默认档、选项 12px 压一档 */}
        <div className="min-w-0 flex-1 text-sm leading-relaxed text-foreground">
          <MarkdownText text={question.question} baseDir={baseDir} />
        </div>
      </div>

      {/* 选项区：切到自定义模式后也保留、随时能跳回点选项 */}
      {hasOptions && (
        <div className="flex flex-col gap-1.5 pl-8">
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
                className="flex items-start gap-2.5 px-2.5 py-1.5 text-xs"
              >
                <span
                  className={cn(
                    "shrink-0 rounded-sm px-1.5 py-0.5 font-mono text-[11px] leading-none",
                    selected
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted text-muted-foreground",
                  )}
                >
                  {letter}
                </span>
                <span className="wrap-break-word pt-px">{opt.label}</span>
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

      {/* 自定义回答区：跟输入条同款富输入（`/` skill、`@` 引文件、贴图 / 拖拽）——
          只有自定义回答能带图（用户拍板）；固定高度 3 行、不把事件流顶走 */}
      {inCustomMode && (
        <div className="pl-8">
          <RichInput
            {...rich.bind}
            onSubmit={onSubmitAll}
            placeholder="输入你的回答…"
            disabled={submitting}
            boxHeight={ASK_INPUT_HEIGHT}
            className="bg-background"
          />
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
  // 答题框的 `@` 引文件上下文；inputHistory 留空——答题不该翻「说过的话」
  const composerSession = useMemo(
    () => ({ taskId: task.id, repoPaths: task.repoPaths, inputHistory: [] }),
    [task.id, task.repoPaths],
  );

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
  // 提交成功/超时的 setTimeout：卸载时清掉，避免卸载后 setSubmitting（审查）
  const submitTimersRef = useRef<number[]>([]);
  const trackTimer = (id: number) => {
    submitTimersRef.current.push(id);
    return id;
  };
  const clearTrackedTimer = (id: number) => {
    window.clearTimeout(id);
    submitTimersRef.current = submitTimersRef.current.filter((t) => t !== id);
  };
  useEffect(
    () => () => {
      for (const t of submitTimersRef.current) window.clearTimeout(t);
      submitTimersRef.current = [];
    },
    [],
  );

  // AbortError：超时解锁已 toast + abort，勿再弹一次错误 toast
  const isAbortError = (err: unknown): boolean =>
    (err instanceof DOMException || err instanceof Error) &&
    err.name === "AbortError";

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
    // 各题 `/` 引用的 skill 合并去重（一次 ask-reply 只发一条消息、指引拼一份就够）
    const skillRefs = mergeSkillRefs(questions.map((q) => drafts[q.id]));
    setSubmitting(true);
    // 超时解锁时 abort 在飞请求，避免迟到响应与用户重试撞成重复回答
    const ac = new AbortController();
    const unlockTimer = trackTimer(
      window.setTimeout(() => {
        ac.abort();
        setSubmitting(false);
        toast.error("提交超时，请检查网络后重试，或在底部输入条继续说");
      }, SUBMIT_UNLOCK_MS),
    );
    try {
      const askResult = await submitAskReply(task.id, askId, answers, {
        imagesByQuestion,
        skills: skillRefs.length > 0 ? skillRefs : undefined,
        signal: ac.signal,
      });
      // send 后落盘失败——不可忽略提示
      if (askResult.persistWarning) {
        toast.error(
          `消息已送达但记录保存失败：${askResult.persistWarning}`,
        );
      }
      // 提交成功：等 SSE 推 ask_user_reply、findPendingAskEvent 变 null、
      // event-stream 自动切回放卡——这里不主动收起、避免 race。
      // SSE 重连间隙另给 15s：卡片可能仍显示「提交中…」
      clearTrackedTimer(unlockTimer);
      trackTimer(window.setTimeout(() => setSubmitting(false), 15_000));
    } catch (err) {
      clearTrackedTimer(unlockTimer);
      if (isAbortError(err)) {
        setSubmitting(false);
        return;
      }
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
        "AI 会跳过这一组问题、按 default 继续。你可以稍后在输入条里补充。",
      confirmLabel: "确认稍后补",
      cancelLabel: "回去答题",
    });
    if (!ok) return;
    setSubmitting(true);
    const ac = new AbortController();
    const unlockTimer = trackTimer(
      window.setTimeout(() => {
        ac.abort();
        setSubmitting(false);
        toast.error("提交超时，请检查网络后重试，或在底部输入条继续说");
      }, SUBMIT_UNLOCK_MS),
    );
    try {
      const deferResult = await submitAskReply(task.id, askId, [], {
        deferred: true,
        signal: ac.signal,
      });
      // send 后落盘失败——不可忽略提示
      if (deferResult.persistWarning) {
        toast.error(
          `消息已送达但记录保存失败：${deferResult.persistWarning}`,
        );
      }
      clearTrackedTimer(unlockTimer);
      trackTimer(window.setTimeout(() => setSubmitting(false), 15_000));
    } catch (err) {
      clearTrackedTimer(unlockTimer);
      if (isAbortError(err)) {
        setSubmitting(false);
        return;
      }
      toast.error(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  };

  if (!askId || questions.length === 0) return null;

  return (
    <div
      // 品牌琥珀强调（2026-07-20 用户实测：中性灰不够醒目、看不出「等你答题」）——
      // 与「AI 在等你回答」浮标、侧栏琥珀点同属「等你行动」信号族、一眼锁定
      className="flex flex-col gap-3 rounded-lg border border-brand/40 bg-brand/[0.06] p-3.5"
      onKeyDown={(e) => {
        // 容器级提交快捷键，只管「焦点不在答题框里」的情况（选项按钮 / 卡片本身）：
        // - 焦点在答题框内 → RichInput 内部已按偏好判定并回调 onSubmit，这里必须让开、否则双提交
        // - enter 模式：卡片上裸 Enter 不提交（焦点在选项按钮时会误提交整表）
        const inEditor = !!(e.target as HTMLElement).closest(
          '[contenteditable="true"]',
        );
        if (inEditor || submitShortcut === "enter") return;
        if (shouldSubmitOnKeyDown(e, submitShortcut)) {
          e.preventDefault();
          void handleSubmit();
        }
      }}
    >
      <div className="flex items-center gap-2">
        <Sparkles className="size-3.5 shrink-0 text-brand" />
        <span className="text-xs font-medium text-foreground">
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
          {/* 答题框的 `@` 引文件要 task 上下文；答题不套 ↑ 历史（历史是「说过的话」、跟本题无关） */}
          <ComposerSessionProvider value={composerSession}>
            <div className="flex flex-col">
              {questions.map((q, qIdx) => (
                <div
                  key={`${askId}:${q.id}`}
                  className={cn(
                    qIdx > 0 && "mt-3 border-t border-border/50 pt-3",
                  )}
                >
                  <AskQuestionItem
                    question={q}
                    taskId={task.id}
                    baseDir={task.workCwd}
                    index={qIdx + 1}
                    submitting={submitting}
                    onChange={handleDraftChange}
                    onSubmitAll={() => void handleSubmit()}
                  />
                </div>
              ))}
            </div>
          </ComposerSessionProvider>

          <div className="flex items-center justify-between gap-2 border-t border-border/50 pt-2.5 text-xs text-muted-foreground">
            <span className="shrink-0 tabular-nums">
              已答 {answeredCount} / {questions.length}
            </span>
            <div className="flex items-center gap-1.5">
              <Button
                size="sm"
                variant="ghost"
                disabled={submitting}
                onClick={() => void handleDefer()}
                className="h-7 text-xs text-muted-foreground"
              >
                稍后再补充
              </Button>
              <Button
                size="sm"
                disabled={submitting || !allAnswered}
                onClick={() => void handleSubmit()}
                className="h-7 text-xs"
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
