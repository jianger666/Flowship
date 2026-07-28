"use client";

/**
 * 任务页统一「跟 AI 说」输入条（V0.13.x 单一语义、事件流底部常驻）
 *
 * 客户端只有一条通道（submitTaskQuestion）、所有消息都是 [USER_MESSAGE]、
 * AI 自主二分类（疑问就答 / 要改就改）；产出在等审阅时服务端自动附「重新交卷」
 * 上下文；会话断时服务端按 action 状态走唤醒 / 一次性临时 agent、客户端无感。
 *
 * v1.1.x 起视觉 / 交互统一走 <ConversationComposer>（chat 输入岛同一个组件）：贴图 / 附文件目录 /
 * `/` 唤起 skill / `@` 引用文件 / 顶边拖高；本文件只留业务态（发送通道 / 模型 / 禁用判定 /
 * 运行中停止键）。Cmd/Ctrl+J 聚焦。agent 正在跑时禁用发送、右侧换成 Composer 同款停止键；
 * 任务终态整条隐藏。
 */

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { ConversationComposer } from "@/components/conversation-composer";
import { ComposerSessionProvider } from "@/components/composer-session";
import { buildInputHistory } from "@/lib/composer-history";
import { ModelSelect } from "@/components/ui/model-select";
import { useModels } from "@/hooks/use-models";
import { useRichInput } from "@/hooks/use-rich-input";
import { findPendingAskEvent } from "@/lib/ask-pending";
import { getSettings } from "@/lib/local-store";
import { submitTaskQuestion } from "@/lib/task-store";
import { loadDraft } from "@/lib/view-memory";
import type { ModelSelection, Task } from "@/lib/types";

interface Props {
  task: Task;
  // 提交成功后父组件用返回的最新 task 刷状态（running 态 UI 立即切）
  onTaskUpdate: (next: Task) => void;
  // 运行中停止：与顶栏共用同一 stopTask 通道（父组件持 confirm + stopping 锁）
  onStop?: () => void;
  // 停止请求飞行中——Composer 红方块键 disabled、防双击
  stopping?: boolean;
}

export const TaskTalkComposer = ({
  task,
  onTaskUpdate,
  onStop,
  stopping = false,
}: Props) => {
  // 请求飞行中：防双击
  const [submitting, setSubmitting] = useState(false);
  // agent 在跑时不可说（发送禁用）；运行中 Composer 右侧换成 spinner + 停止键（对齐 chat）
  const isRunning = task.runStatus === "running";
  const busy = submitting || isRunning;

  // 输入态整套（草稿 + skill + 图 + 路径附件 + 聚焦句柄）走公共 hook、跟 chat 输入岛同一份实现
  const rich = useRichInput({
    taskId: task.id,
    draft: { scope: "talk", id: task.id },
    maxImages: 6,
    disabled: busy,
  });

  // 显式指定的模型（id 空 = 跟随会话；选了 = 换这个模型处理本条消息）
  const [pickedModel, setPickedModel] = useState<ModelSelection>({ id: "" });
  // 模型列表：挂载即拉（跟随会话文案要反查 displayName）；打开选择器时再兜底一次
  const { models, fetchModels } = useModels();
  useEffect(() => {
    const s = getSettings();
    if (s.apiKey?.trim() && models.length === 0) void fetchModels(s.apiKey);
  }, [models.length, fetchModels]);

  // 跟随态 trigger：带上会话实际模型名（task.model 快照）；未跑过 / 无模型时退回原占位
  const followPlaceholder = useMemo(() => {
    const id = task.model?.id?.trim();
    if (!id) return "模型 · 跟随会话";
    const m = models.find((x) => x.id === id);
    const raw = m?.displayName;
    // displayName 是图标 token 时退显 id（与 ModelSelect 同口径）
    const name = !raw || /:icon-/.test(raw) ? id : raw;
    return `${name} · 跟随会话`;
  }, [task.model, models]);

  // 切 task 时整条输入态重置再换载对应草稿（详情页在不同任务间导航时组件可能不重挂）。
  // 必须 reset() 全清、不能只清路径附件：贴好的截图 / 已引用的 skill 会跟着串到下一个
  // 任务的会话里（用户在 A 任务贴图没发就切走、回头在 B 任务发送就把 A 的图发过去了）
  const setDraft = rich.setValue;
  const resetInput = rich.reset;
  useEffect(() => {
    // 先读后清：reset() 会把空串写回草稿存储，读晚了就把目标任务的草稿抹掉了
    const draft = loadDraft("talk", task.id);
    resetInput();
    setDraft(draft);
  }, [task.id, setDraft, resetInput]);

  // Cmd/Ctrl+J 聚焦输入条（沿用原「再聊聊」快捷键、入口合一后指到这里）
  const focusInput = rich.focus;
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "j" || !(e.metaKey || e.ctrlKey)) return;
      e.preventDefault();
      focusInput();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [focusInput]);

  // @ / ↑ 历史：task 模式也复用同一 ComposerSession
  const composerSession = useMemo(
    () => ({
      taskId: task.id,
      repoPaths: task.repoPaths,
      inputHistory: buildInputHistory(task.events),
    }),
    [task.id, task.repoPaths, task.events],
  );

  // 有未答提问 → placeholder 轻提示去答题卡；**不禁输入**（同事踩坑：网断 /
  // 会话死后答题卡变 isStale 引导「用底部输入条唤醒」，但这里曾把 awaitingAnswer
  // 绑进 disabled，和 isStale 对锁、只能重新推进）。
  // runStatus=error / action 停摆：提问已没人接，placeholder 也不再指路答题。
  const halted =
    task.runStatus === "error" ||
    task.actions.some(
      (a) =>
        a.id === task.currentActionId &&
        (a.status === "error" || a.status === "cancelled"),
    );
  const awaitingAnswer = !halted && !!findPendingAskEvent(task.events);

  const handleSubmit = async () => {
    if (!rich.hasContent || busy) return;
    setSubmitting(true);
    try {
      // V0.13.x 统一消息通道（用户拍板「别这么多分支」）：全部走 question route、
      // AI 自主二分类（疑问就答 / 要改就改）；产出在等审阅时服务端自动附「重新交卷」上下文。
      // skill 指引不拼进 text——独立字段传服务端，气泡只显示用户原文
      const { text, images, attachments, skillRefs } = rich.payload();
      const result = await submitTaskQuestion(
        task.id,
        text,
        images,
        pickedModel.id ? pickedModel : undefined,
        attachments,
        skillRefs,
      );
      // send 后落盘失败——不可忽略提示
      if (result.persistWarning) {
        toast.error(
          `消息已送达但记录保存失败：${result.persistWarning}`,
        );
      }
      onTaskUpdate(result.task);
      rich.reset();
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
    <ComposerSessionProvider value={composerSession}>
      <div className="border-t px-3 py-2">
        <ConversationComposer
          {...rich.bind}
          editorKey={task.id}
          onSubmit={() => void handleSubmit()}
          placeholder={
            awaitingAnswer
              ? "可先答上方提问，也可在此继续说"
              : "想改、想问、贴图、/ 唤起 skill、@ 引用文件（⌘/Ctrl+J）"
          }
          disabled={busy}
          submitting={submitting}
          leading={
            <ModelSelect
              models={models}
              selection={pickedModel}
              onChange={setPickedModel}
              disabled={busy}
              variant="compact"
              emptyPlaceholder={followPlaceholder}
              followOption="跟随会话"
              onOpenChange={(open) => {
                if (!open) return;
                const s = getSettings();
                if (s.apiKey?.trim() && models.length === 0)
                  void fetchModels(s.apiKey);
              }}
            />
          }
          // 运行中：右侧动作组原地换成 spinner + 红停止键（Composer 同款、与 chat 对齐；无排队）
          running={isRunning}
          onStop={onStop}
          stopping={stopping}
        />
      </div>
    </ComposerSessionProvider>
  );
};
