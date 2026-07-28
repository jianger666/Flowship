"use client";

/**
 * useRichInput：RichInput 的状态层（v1.1.x 抽、四处输入共用）
 *
 * chat 输入岛 / task「跟 AI 说」条 / 推进弹窗 / ask 答题卡原本各自写一遍同一套：
 * 草稿 state + sessionStorage 草稿 + useSlashSkills + useImageAttach + usePathAttach +
 * focusRef + 「提交时把 text / images / attachments / skillRefs 拼出来」+「成功后全清」。
 * 本 hook 把这堆收成一处，调用方只剩自己的业务分支。
 *
 * 用法：
 *   const rich = useRichInput({ taskId, draft: { scope: "reply", id: task.id } });
 *   <RichInput {...rich.bind} onSubmit={...} placeholder={...} />
 *   提交：const { text, images, attachments, skillRefs } = rich.payload();
 *   成功后：rich.reset();
 *
 * `@` 引用 / ↑ 历史不在本 hook——它们读 ComposerSessionProvider（调用方注入 task 上下文）。
 */

import { useCallback, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { useSlashSkills, type SlashSkillsApi } from "@/components/slash-skills";
import type { ComposerFocusHandle } from "@/components/rich-input";
import {
  useImageAttach,
  type UseImageAttachReturn,
} from "@/hooks/use-image-attach";
import { usePathAttach, type UsePathAttachReturn } from "@/hooks/use-path-attach";
import { MAX_SKILL_REFS } from "@/lib/protocol-signals";
import {
  buildRichInputPayload,
  type RichInputPayload,
} from "@/lib/rich-input-payload";
import { loadDraft, saveDraft, type DraftScope } from "@/lib/view-memory";

export type { RichInputPayload };

export interface UseRichInputOptions {
  /**
   * 所属任务：`@` 粘贴长文本转附件要用它落盘。
   * 不传 = 不启用「粘贴超长文本转附件」。
   */
  taskId?: string;
  /**
   * 草稿持久化（sessionStorage、切页不丢）。不传 = 不持久化——
   * 弹窗 / 答题卡这类「关掉就该没了」的输入不该留草稿。
   */
  draft?: { scope: DraftScope; id: string };
  /** 附件 handler 短路（agent 在跑 / 提交中） */
  disabled?: boolean;
  maxImages?: number;
  /**
   * 是否提供路径附件能力（原生 picker + 粘贴长文本转附件）。
   * 后端不接 attachments 的通道（如 ask-reply）传 false。默认 true。
   */
  enablePaths?: boolean;
  /**
   * 是否消费跨页 slash handoff。同一页第二个输入框（推进弹窗 / 答题卡）必须 false——
   * 否则会跟常驻输入条抢同一份 pending、skill 落进用户没看的那个框。
   */
  consumePendingSlash?: boolean;
}

export interface UseRichInputReturn {
  value: string;
  /** 写正文；跟 setState 一样支持 updater（引用追问那种「前置一段」的写法） */
  setValue: (next: string | ((prev: string) => string)) => void;
  /** 有没有可提交的内容（正文 / 图 / 路径任一非空） */
  hasContent: boolean;
  focusRef: React.RefObject<ComposerFocusHandle | null>;
  focus: () => void;
  slash: SlashSkillsApi;
  attach: UseImageAttachReturn;
  pathAttach: UsePathAttachReturn;
  /** 提交时取四件套 */
  payload: () => RichInputPayload;
  /** 提交成功 / 切上下文时清空（草稿、图、路径、slash 菜单态） */
  reset: () => void;
  /** 直接摊给 <RichInput> / <ConversationComposer> 的输入侧 props */
  bind: {
    value: string;
    onChange: (v: string) => void;
    focusRef: React.RefObject<ComposerFocusHandle | null>;
    slash: SlashSkillsApi;
    attach: UseImageAttachReturn;
    paths?: string[];
    onRemovePath?: (p: string) => void;
    onPickPaths?: (mode: "file" | "folder") => void;
    picking?: false | "file" | "folder";
    onPasteLongText?: (content: string) => Promise<boolean>;
  };
}

export const useRichInput = (
  options: UseRichInputOptions = {},
): UseRichInputReturn => {
  const {
    taskId,
    draft,
    disabled,
    maxImages,
    enablePaths = true,
    consumePendingSlash = true,
  } = options;
  const draftScope = draft?.scope;
  const draftId = draft?.id;

  // 正文草稿（有 draft 选项时从 sessionStorage 复原）
  const [value, setValueState] = useState(() =>
    draftScope && draftId ? loadDraft(draftScope, draftId) : "",
  );
  // 图附件（粘贴 / 拖拽 / 按钮）
  const attach = useImageAttach({ disabled, maxImages });
  // 文件 / 目录路径附件（原生 picker + 粘贴长文本落盘）
  const pathAttach = usePathAttach();
  // 编辑器聚焦句柄（自动聚焦 / slash 补全后回落光标）
  const focusRef = useRef<ComposerFocusHandle | null>(null);
  // value 的同步镜像：updater 形式要读「最新值」、又不能把 saveDraft 副作用塞进 setState updater
  //（StrictMode 双调 updater 必须纯、同 use-path-attach 的 pathsRef 套路）
  const valueRef = useRef(value);
  valueRef.current = value;

  // 写值 + 顺带存草稿（单一入口、调用方不用每处都记得 saveDraft）
  const setValue = useCallback(
    (next: string | ((prev: string) => string)) => {
      const resolved =
        typeof next === "function" ? next(valueRef.current) : next;
      valueRef.current = resolved;
      setValueState(resolved);
      if (draftScope && draftId) saveDraft(draftScope, draftId, resolved);
    },
    [draftScope, draftId],
  );

  const focus = useCallback(() => focusRef.current?.focus(), []);

  // `/` 唤起 skill：选中后补全成内联 `/name ` token（Lexical 直插；fallback 走 applyDraft）
  const slash = useSlashSkills({
    draft: value,
    consumePending: consumePendingSlash,
    applyDraft: (next, cursor) => {
      if (cursor != null) focusRef.current?.prepareCursor(cursor);
      setValue(next);
      requestAnimationFrame(() => focusRef.current?.focus());
    },
  });

  const hasContent =
    value.trim().length > 0 ||
    attach.images.length > 0 ||
    (enablePaths && pathAttach.paths.length > 0);

  const payload = useCallback((): RichInputPayload => {
    // 组装规则（空值语义 / trim / skill 截断）在 lib 里单测；这里只负责取当前值 + 提示
    const { payload: built, skillOverflow } = buildRichInputPayload({
      value,
      images: attach.toUploadPayload() ?? [],
      paths: enablePaths ? pathAttach.paths : [],
      skillRefs: slash.references,
    });
    if (skillOverflow) {
      toast.warning(
        `最多引用 ${MAX_SKILL_REFS} 个 skill、本次只带前 ${MAX_SKILL_REFS} 个`,
      );
    }
    return built;
    // attach / slash / pathAttach 每次 render 都是新对象、整个进 deps 等于不 memo；
    // 这里只跟「真正影响结果的值」（正文 / 图 / 路径 / skill 引用）重建，
    // 闭包读到的仍是同一次 render 的 hook 对象、值一致
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, enablePaths, pathAttach.paths, attach.images, slash.references]);

  const attachReset = attach.reset;
  const pathReset = pathAttach.reset;
  const slashReset = slash.reset;
  const reset = useCallback(() => {
    setValue("");
    attachReset();
    pathReset();
    slashReset();
  }, [setValue, attachReset, pathReset, slashReset]);

  const pickPaths = pathAttach.pickPaths;
  const addPastedText = pathAttach.addPastedText;
  const onPickPaths = useCallback(
    (mode: "file" | "folder") => void pickPaths(mode),
    [pickPaths],
  );
  const onPasteLongText = useCallback(
    (content: string) => addPastedText(taskId ?? "", content),
    [addPastedText, taskId],
  );

  const bind = useMemo<UseRichInputReturn["bind"]>(
    () => ({
      value,
      onChange: setValue,
      focusRef,
      slash,
      attach,
      ...(enablePaths
        ? {
            paths: pathAttach.paths,
            onRemovePath: pathAttach.removePath,
            onPickPaths,
            picking: pathAttach.picking,
            // 没 taskId 就没地方落盘、超长文本仍走编辑器默认插入
            ...(taskId ? { onPasteLongText } : {}),
          }
        : {}),
    }),
    [
      value,
      setValue,
      slash,
      attach,
      enablePaths,
      pathAttach.paths,
      pathAttach.removePath,
      pathAttach.picking,
      onPickPaths,
      onPasteLongText,
      taskId,
    ],
  );

  return {
    value,
    setValue,
    hasContent,
    focusRef,
    focus,
    slash,
    attach,
    pathAttach,
    payload,
    reset,
    bind,
  };
};
