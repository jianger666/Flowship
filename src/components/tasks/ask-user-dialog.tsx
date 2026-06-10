"use client";

/**
 * AskUserDialog（V0.3.2 ask_user 弹窗、用户拍板的形态、V0.5.6 加「稍后再补充」）
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
 * 数据流：
 *   1. 监听 task.events、找最新一条 ask_user_request 且没对应 ask_user_reply 的 → 弹窗
 *   2. 用户选 option / 写 Other 文本 → 内部 answers state 累积
 *   3. 全答完点提交 → POST /api/tasks/[id]/ask-reply、body 带 answers[]
 *      或点「稍后再补充」→ confirm 后 POST 带 deferred:true、answers 可空
 *   4. 服务端 resolve agent、写 ask_user_reply 事件、SSE 推回来、UI 自动关弹窗
 *
 * 设计原则：
 *   - 答案不在本组件持久化、重新打开时清空（避免半填状态搞乱用户）
 *   - 提交失败 toast、按钮回到可点状态
 *   - 已答的 askId 不再弹（看 task.events 里有没有 reply）
 */

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Sparkles } from "lucide-react";
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
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { useDialog } from "@/hooks/use-dialog";
import { submitAskReply } from "@/lib/task-store";
import type {
  AskUserAnswer,
  AskUserQuestion,
  Task,
  TaskEvent,
} from "@/lib/types";

// 单条问题在 dialog 里的回答态
// - optionId：选了哪个 option（undefined = 还没选 / 走 Other）
// - text：Other 模式下的自由文本
// 提交时按 optionId 优先、没选才用 text
interface AnswerDraft {
  optionId?: string;
  text: string;
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

export const AskUserDialog = ({ task, onAnswered }: AskUserDialogProps) => {
  // useDialog 提供 confirm Promise API、用户点「稍后再补充」时弹二次确认
  const { confirm } = useDialog();

  // 找最新一条待答的 ask_user_request
  // - 倒序扫、第一条没对应 reply 的就是「当前要弹的」
  // - 一次只弹一个 ask（用户答完才会有下一个 ask、串行）
  const pendingEvent = useMemo<TaskEvent | null>(() => {
    for (let i = task.events.length - 1; i >= 0; i--) {
      const ev = task.events[i];
      if (ev.kind !== "ask_user_request") continue;
      const askId =
        typeof ev.meta?.askId === "string" ? ev.meta.askId : null;
      if (!askId) continue;
      const replied = task.events.some(
        (e) =>
          e.kind === "ask_user_reply" &&
          typeof e.meta?.askId === "string" &&
          e.meta.askId === askId,
      );
      if (!replied) return ev;
      // 已答的略过、看下一条更老的（一般也是已答、循环到底）
    }
    return null;
  }, [task.events]);

  const askId =
    pendingEvent && typeof pendingEvent.meta?.askId === "string"
      ? pendingEvent.meta.askId
      : null;
  const questions = useMemo<AskUserQuestion[]>(
    () => (pendingEvent ? extractQuestions(pendingEvent.meta) : []),
    [pendingEvent],
  );

  // 每个 question 的草稿答案、由 question.id 索引
  // askId 变了就重置（换了一组问题）
  const [drafts, setDrafts] = useState<Record<string, AnswerDraft>>({});
  // 提交中：防双击 / 网络重发
  const [submitting, setSubmitting] = useState(false);
  // 自定义文本模式：哪个 question 切到了 textarea
  // Set<questionId>
  const [otherMode, setOtherMode] = useState<Set<string>>(new Set());
  // V0.6.24：agent 已断（task.runStatus=error）时这组 ask 不可能再被响应、
  // dialog 转「失效态」可关、解除「不可 dismiss + 提交 409」的死锁、引导用户去推进重启
  const isStale = task.runStatus === "error";
  // 失效态下「我知道了」关闭弹窗的本地开关（正常态无关闭入口、恒 false、不影响原有强制答题）
  const [dismissed, setDismissed] = useState(false);

  // askId 切换时清状态（保证每次新弹窗都是干净的）
  // 失败重试也走这里——之后再讨论体验是否要保留草稿
  useEffect(() => {
    setDrafts({});
    setOtherMode(new Set());
    setSubmitting(false);
    setDismissed(false);
  }, [askId]);

  // 判断是否所有 question 都已答
  // - 选了 optionId、或者 Other 文本非空、都算答了
  const allAnswered = useMemo(() => {
    if (questions.length === 0) return false;
    for (const q of questions) {
      const d = drafts[q.id];
      if (!d) return false;
      if (d.optionId) continue;
      if (d.text && d.text.trim().length > 0) continue;
      return false;
    }
    return true;
  }, [questions, drafts]);

  // 正常态 dismissed 恒 false（无关闭入口）、open 跟着 pendingEvent；失效态可被「我知道了」关
  const open = pendingEvent !== null && !dismissed;

  // 点选项按钮：写 optionId、清 text（确保只用一种答案）
  // 退出 other 模式（如果之前切过）
  const handlePickOption = (qid: string, optionId: string) => {
    setDrafts((prev) => ({
      ...prev,
      [qid]: { optionId, text: "" },
    }));
    setOtherMode((prev) => {
      if (!prev.has(qid)) return prev;
      const next = new Set(prev);
      next.delete(qid);
      return next;
    });
  };

  // 切到 Other 模式：清 optionId、文本框出现
  const handleEnterOther = (qid: string) => {
    setOtherMode((prev) => {
      const next = new Set(prev);
      next.add(qid);
      return next;
    });
    setDrafts((prev) => ({
      ...prev,
      [qid]: { text: prev[qid]?.text ?? "" },
    }));
  };

  // 改 Other 文本
  const handleOtherChange = (qid: string, text: string) => {
    setDrafts((prev) => ({
      ...prev,
      [qid]: { ...prev[qid], text },
    }));
  };

  // 提交：拼 answers[]、POST
  const handleSubmit = async () => {
    if (!askId || submitting) return;
    if (!allAnswered) {
      toast.error("请把所有问题都答完再提交");
      return;
    }
    const answers: AskUserAnswer[] = questions.map((q) => {
      const d = drafts[q.id]!;
      if (d.optionId) {
        const opt = q.options?.find((o) => o.id === d.optionId);
        return {
          questionId: q.id,
          answer: opt?.label ?? "",
          optionId: d.optionId,
        };
      }
      return {
        questionId: q.id,
        answer: d.text.trim(),
      };
    });
    setSubmitting(true);
    try {
      await submitAskReply(task.id, askId, answers);
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
            Agent 已断开（进程重启 / 异常退出）、这组问题没送达、你刚填的答案也没保存。关闭后点右上角「推进」重新启动（默认起新 agent）、AI 会接着读历史继续。
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
          // 弹窗级提交快捷键：Mac Cmd+Enter，Windows/Linux Ctrl+Enter。
          // 不只绑 textarea，避免焦点在选项按钮上时快捷键失效。
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
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
            {questions.map((q, qIdx) => {
              const d = drafts[q.id];
              const inOther = otherMode.has(q.id);
              const selectedOptId = d?.optionId;
              return (
                <div key={q.id} className="flex flex-col gap-3">
                  <div className="flex items-start gap-2">
                    <span className="shrink-0 rounded-md bg-muted px-2 py-0.5 font-mono text-xs">
                      Q{qIdx + 1}
                    </span>
                    <p className="text-sm leading-relaxed wrap-break-word">
                      {q.question}
                    </p>
                  </div>

                  {/* 选项区：始终显示（如果该 question 有 options）
                      切到 Other 模式后也保留、用户随时能从 textarea 跳回点选项 */}
                  {q.options && q.options.length > 0 && (
                    <div className="flex flex-col gap-1.5 pl-9">
                      {q.options.map((opt, optIdx) => {
                        const letter =
                          LETTER_PREFIX[optIdx] ?? String(optIdx + 1);
                        const selected = selectedOptId === opt.id;
                        return (
                          <ChoiceButton
                            key={opt.id}
                            shape="card"
                            selected={selected}
                            disabled={submitting}
                            onClick={() => handlePickOption(q.id, opt.id)}
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
                      {/* 「自定义回答」入口：进 Other 模式后高亮、提示当前在用 textarea
                          V0.5.10 拍板：文案精简到「自定义回答」、不要「以上都不是」赘述 */}
                      {q.allowText && (
                        <ChoiceButton
                          shape="tab"
                          selected={inOther}
                          disabled={submitting}
                          onClick={() => handleEnterOther(q.id)}
                          className="self-start text-xs"
                        >
                          {inOther ? "已选：自定义回答（下方输入）" : "自定义回答"}
                        </ChoiceButton>
                      )}
                    </div>
                  )}

                  {/* Other 模式 textarea：选项区不动、出现在下方
                      没有 options 时也显示（纯文本问题） */}
                  {(inOther || !q.options || q.options.length === 0) && (
                    <div className="flex flex-col gap-2 pl-9">
                      <Textarea
                        value={d?.text ?? ""}
                        onChange={(e) =>
                          handleOtherChange(q.id, e.target.value)
                        }
                        placeholder="输入你的回答…（或写「不清楚 / 你定」让 AI 按 default 走）"
                        rows={3}
                        className="resize-none text-sm"
                        disabled={submitting}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        <DialogFooter className="mx-0 mb-0 border-t px-5 py-3">
          {/* mx-0 mb-0 是用来 override DialogFooter 默认的 -mx-4 -mb-4——
              那两条是 shadcn 给「父 DialogContent 有 p-4」的场景设计的全宽 footer 效果。
              这里 DialogContent 用了 p-0（让中间滚动区铺满）、负 margin 会把 footer
              拉到 content 边界外、被 overflow-hidden 裁掉、视觉上「贴底没间距」。 */}
          <div className="flex w-full items-center justify-between gap-2 text-xs text-muted-foreground">
            <span className="shrink-0">
              已答 {Object.values(drafts).filter(
                (d) =>
                  d.optionId ||
                  (d.text && d.text.trim().length > 0),
              ).length}{" "}
              / {questions.length}
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
