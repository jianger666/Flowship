"use client";

/**
 * 任务页统一「跟 AI 说」输入条（V0.13.x 单一语义、事件流底部常驻）
 *
 * 客户端只有一条通道（submitTaskQuestion）、所有消息都是 [USER_MESSAGE]、
 * AI 自主二分类（疑问就答 / 要改就改）；产出在等审阅时服务端自动附「重新交卷」
 * 上下文；会话断时服务端按 action 状态走唤醒 / 一次性临时 agent、客户端无感。
 *
 * v1.1.x 起视觉 / 交互统一走 <Composer>（chat 输入岛同款）：贴图 / 附文件目录 /
 * `/` 唤起 skill / 顶边拖高；本文件只留业务态（发送通道 / 模型 / 禁用判定）。
 * Cmd/Ctrl+J 聚焦。agent 正在跑时禁用；任务终态整条隐藏。
 */

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Composer } from "@/components/composer";
import { useSlashSkills } from "@/components/slash-skills";
import { ModelSelect } from "@/components/ui/model-select";
import { useImageAttach } from "@/hooks/use-image-attach";
import { useModels } from "@/hooks/use-models";
import { usePathAttach } from "@/hooks/use-path-attach";
import { findPendingAskEvent } from "@/lib/ask-pending";
import { getSettings } from "@/lib/local-store";
import { submitTaskQuestion } from "@/lib/task-store";
import { loadDraft, saveDraft } from "@/lib/view-memory";
import type { ModelSelection, Task } from "@/lib/types";

interface Props {
  task: Task;
  // 提交成功后父组件用返回的最新 task 刷状态（running 态 UI 立即切）
  onTaskUpdate: (next: Task) => void;
}

export const TaskTalkComposer = ({ task, onTaskUpdate }: Props) => {
  // 草稿：按 task 记进 sessionStorage（v1.1.x、打半段切页不丢）、发送后清
  const [draft, setDraft] = useState(() => loadDraft("talk", task.id));
  // 请求飞行中：防双击
  const [submitting, setSubmitting] = useState(false);
  // 显式指定的模型（id 空 = 跟随会话；选了 = 换这个模型处理本条消息）
  const [pickedModel, setPickedModel] = useState<ModelSelection>({ id: "" });
  // 模型列表：打开选择器时按需拉（SWR 缓存、不重复打网络）
  const { models, fetchModels } = useModels();
  // 文件 / 目录路径附件（原生 picker、chat 输入岛同款 hook）
  const pathAttach = usePathAttach();
  const resetPaths = pathAttach.reset;
  // 切 task 时换载对应草稿 + 清路径附件（详情页在不同任务间导航时组件可能不重挂）
  useEffect(() => {
    setDraft(loadDraft("talk", task.id));
    resetPaths();
  }, [task.id, resetPaths]);

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

  // `/` 唤起 skill：选中后补全成内联 `/name ` token（Codex 风、留在文本流里）
  const slash = useSlashSkills({
    draft,
    applyDraft: (next, cursor) => {
      setDraft(next);
      saveDraft("talk", task.id, next);
      if (cursor == null) return;
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(cursor, cursor);
      });
    },
  });

  // 有未答提问（且当前阶段没停摆）→ 输入条切「答题引导态」：禁输入、placeholder 指路。
  // 阶段停摆（error/cancelled）时提问已没人接、照常放行（唤醒通道）。
  const halted = task.actions.some(
    (a) =>
      a.id === task.currentActionId &&
      (a.status === "error" || a.status === "cancelled"),
  );
  const awaitingAnswer = !halted && !!findPendingAskEvent(task.events);

  // 贴图（粘贴 / 选文件 / 拖拽）——不可输入时（busy / 答题引导态）所有 handler 短路
  const attach = useImageAttach({
    maxImages: 6,
    disabled: busy || awaitingAnswer,
  });

  const handleSubmit = async () => {
    const text = draft.trim();
    if (
      (!text && attach.images.length === 0 && pathAttach.paths.length === 0) ||
      busy
    )
      return;
    setSubmitting(true);
    try {
      const images = attach.toUploadPayload();
      // V0.13.x 统一消息通道（用户拍板「别这么多分支」）：全部走 question route、
      // AI 自主二分类（疑问就答 / 要改就改）；产出在等审阅时服务端自动附「重新交卷」上下文。
      // 选了 skill：消息头拼「先 read 这些 SKILL.md 再执行」指引
      const updated = await submitTaskQuestion(
        task.id,
        slash.buildSkillPrefix() + text,
        images,
        pickedModel.id ? pickedModel : undefined,
        pathAttach.paths,
      );
      onTaskUpdate(updated);
      setDraft("");
      saveDraft("talk", task.id, "");
      slash.reset();
      attach.reset();
      pathAttach.reset();
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
    <div className="border-t px-3 py-2">
      <Composer
        value={draft}
        onChange={(v) => {
          setDraft(v);
          saveDraft("talk", task.id, v);
        }}
        onSubmit={() => void handleSubmit()}
        placeholder={
          awaitingAnswer
            ? "先回答上方 AI 的提问"
            : "想改、想问、贴图、/ 唤起 skill（⌘/Ctrl+J）"
        }
        disabled={busy || awaitingAnswer}
        submitting={submitting}
        textareaRef={textareaRef}
        slash={slash}
        attach={attach}
        paths={pathAttach.paths}
        onRemovePath={pathAttach.removePath}
        onPickPaths={(mode) => void pathAttach.pickPaths(mode)}
        picking={pathAttach.picking}
        leading={
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
        }
      />
    </div>
  );
};
