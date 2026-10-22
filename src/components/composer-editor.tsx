/**
 * Composer 输入引擎（Lexical PlainText + SkillTokenNode + FileTokenNode）
 *
 * 替换原原生 textarea + mirror overlay + 原子删除拦截：
 * - skill token = TextNode 子类 + token 模式（品牌色 tag、原子整删、caret 前后可见）
 * - file token = 同构 `@rel/path`（amber tag）；行区间 `:10-50` 留在后续纯文本
 * - 对外仍序列化为纯文本，调用方 value/onChange 协议不变
 * - slash / @ 菜单：选中后把 partial 换成对应 token + 空格
 * - 空输入 ↑↓ 翻本会话 user_reply 历史（有菜单时优先菜单）
 */

"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from "react";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { OnChangePlugin } from "@lexical/react/LexicalOnChangePlugin";
import { PlainTextPlugin } from "@lexical/react/LexicalPlainTextPlugin";
import {
  $getRoot,
  $getSelection,
  $isRangeSelection,
  COMMAND_PRIORITY_HIGH,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_ENTER_COMMAND,
  PASTE_COMMAND,
  TextNode,
  type EditorState,
} from "lexical";

import { cn } from "@/lib/utils";
import {
  matchSlashTrigger,
  parseSkillTokens,
  type SlashSkillsApi,
} from "@/components/slash-skills";
import { SkillTokenNode } from "@/components/composer-skill-token-node";
import { FileTokenNode } from "@/components/composer-file-token-node";
import {
  type AtFileHit,
  type AtMentionApi,
} from "@/components/at-mention";
import { matchAtTrigger } from "@/lib/composer-trigger";
import {
  $getPlainOffset,
  $serializeToPlainText,
  $setRootFromPlainText,
  $setSelectionFromPlainOffset,
  $transformSkillTokensInTextNode,
  createExternalValueWriter,
  runWhenNotComposing,
  type ExternalValueWriter,
} from "@/lib/composer-lexical";
import { menuAria } from "@/lib/menu-scroll";
import { useComposerSession } from "@/components/composer-session";
import { useSubmitShortcut } from "@/hooks/use-settings";
import { isDoubleEsc } from "@/lib/keyboard-shortcuts";
import type { SubmitShortcut } from "@/lib/types";
import type { UseImageAttachReturn } from "@/hooks/use-image-attach";
import { shouldConvertPasteToAttachment } from "@/lib/paste-text-attach";
import { isImeComposing } from "@/lib/ime";

/** 与旧 textarea 排版对齐，拖高 / placeholder 视觉不变 */
const COMPOSER_EDITOR_CLASS =
  "w-full px-3.5 pt-1 pb-2.5 text-sm leading-normal wrap-anywhere whitespace-pre-wrap";

/** 调用方只用 focus（Cmd+J / awaiting 自动聚焦） */
export interface ComposerFocusHandle {
  focus: () => void;
  /**
   * 外部即将写回草稿并希望落位时先调：下一帧 sync 用这个纯文本 offset。
   * token 按序列化长度 `/name` / `@path` 计（跟旧 textarea 光标语义一致）。
   */
  prepareCursor: (offset: number) => void;
}

export interface ComposerEditorProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  placeholder?: string;
  disabled?: boolean;
  focusRef?: RefObject<ComposerFocusHandle | null>;
  /** 量高用：拖柄读 contentEditable 容器高度 */
  boxContainerRef?: RefObject<HTMLDivElement | null>;
  boxHeight: number | null;
  slash?: SlashSkillsApi;
  /** `@` 文件引用（由 Composer 在有 session 时创建） */
  atMention?: AtMentionApi;
  attach?: UseImageAttachReturn;
  /**
   * 超长纯文本粘贴转附件；不传则走 Lexical 默认插入。
   * 异步失败返 false 时本插件把原文插回选区，避免丢用户内容。
   */
  onPasteLongText?: (content: string) => Promise<boolean>;
  className?: string;
  /**
   * 输入框的可访问名称（读屏用；N2-06）。同屏可能有多个输入框（底部输入条 + 答题卡每题的自定义回答 + 推进弹窗指令），
   * 调用方各自传一个能区分的名字；placeholder 不是名字、还会随状态变。
   */
  ariaLabel?: string;
}

const EMPTY_NAMES: ReadonlySet<string> = new Set();

/** 原生 KeyboardEvent 版提交判定（Lexical KEY_ENTER） */
const shouldSubmitNative = (
  event: KeyboardEvent,
  shortcut: SubmitShortcut,
): boolean => {
  if (event.key !== "Enter") return false;
  // 中文 IME 选词 Enter 不能当发送
  if (isImeComposing(event)) return false;
  if (shortcut === "enter") {
    return !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey;
  }
  return (event.metaKey || event.ctrlKey) && !event.altKey;
};

/** 选中 slash 项：按纯文本切 `/partial`，重建为 token + 空格 */
const $replaceSlashPartialWithToken = (
  skillName: string,
  knownNames: ReadonlySet<string>,
): { text: string; cursor: number } | null => {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) return null;
  const plain = $serializeToPlainText();
  const cursor = $getPlainOffset();
  const before = plain.slice(0, cursor);
  const m = matchSlashTrigger(before);
  if (!m) return null;
  const cutStart = m.start;
  const token = `/${skillName} `;
  const next = plain.slice(0, cutStart) + token + plain.slice(cursor);
  const nextCursor = cutStart + token.length;
  $setRootFromPlainText(next, knownNames);
  $setSelectionFromPlainOffset(nextCursor);
  return { text: next, cursor: nextCursor };
};

/** 选中 @ 项：切 `@partial` → FileTokenNode + 空格 */
const $replaceAtPartialWithToken = (
  hit: AtFileHit,
  knownNames: ReadonlySet<string>,
): { text: string; cursor: number } | null => {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) return null;
  const plain = $serializeToPlainText();
  const cursor = $getPlainOffset();
  const before = plain.slice(0, cursor);
  const trigger = matchAtTrigger(before);
  if (!trigger) return null;
  const cutStart = trigger.start;
  const token = `@${hit.path} `;
  const next = plain.slice(0, cutStart) + token + plain.slice(cursor);
  const nextCursor = cutStart + token.length;
  $setRootFromPlainText(next, knownNames);
  $setSelectionFromPlainOffset(nextCursor);
  return { text: next, cursor: nextCursor };
};

// —— Plugins ——

/**
 * 父级 value → 编辑器。写回走 {@link createExternalValueWriter}：
 * - 组字（IME）中不写，等组字结束再写并与期间新敲的内容合并（N2-01）；
 * - 默认不进撤销栈（N2-05）；用户主动的双击 Esc 清空由 undoableNextRef 标记、保留可撤销。
 */
const ExternalValuePlugin = ({
  value,
  knownNames,
  lastEmittedRef,
  pendingCursorRef,
  undoableNextRef,
  onChange,
}: {
  value: string;
  knownNames: ReadonlySet<string>;
  lastEmittedRef: RefObject<string>;
  pendingCursorRef: RefObject<number | null>;
  undoableNextRef: RefObject<boolean>;
  onChange: (value: string) => void;
}) => {
  const [editor] = useLexicalComposerContext();
  const namesRef = useRef(knownNames);
  namesRef.current = knownNames;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const writer = useMemo<ExternalValueWriter>(
    () =>
      createExternalValueWriter({
        editor,
        getKnownNames: () => namesRef.current,
        // 延后写回落地（组字结束）：结果是「写回原文 + 期间新敲的内容」，交还父级与 lastEmitted
        onDeferredApplied: (text) => {
          lastEmittedRef.current = text;
          onChangeRef.current(text);
        },
      }),
    [editor, lastEmittedRef],
  );
  useEffect(() => () => writer.dispose(), [writer]);

  useEffect(() => {
    if (value === lastEmittedRef.current) return;
    const cursor = pendingCursorRef.current;
    const undoable = undoableNextRef.current;
    undoableNextRef.current = false;
    // 组字中延后写回时 lastEmitted 保持原样（OnChange 仍会把组字文本同步给父级）
    if (writer.write(value, cursor, { undoable }) === "applied") {
      lastEmittedRef.current = value;
    }
    pendingCursorRef.current = null;
  }, [value, knownNames, writer, lastEmittedRef, pendingCursorRef, undoableNextRef]);

  return null;
};

const EditablePlugin = ({ disabled }: { disabled?: boolean }) => {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    editor.setEditable(!disabled);
  }, [disabled, editor]);
  return null;
};

const SkillTokenTransformPlugin = ({
  knownNames,
}: {
  knownNames: ReadonlySet<string>;
}) => {
  const [editor] = useLexicalComposerContext();
  const namesRef = useRef(knownNames);
  namesRef.current = knownNames;
  const rebuiltForNamesRef = useRef(false);

  useEffect(() => {
    return editor.registerNodeTransform(TextNode, (node) => {
      $transformSkillTokensInTextNode(node, namesRef.current);
    });
  }, [editor]);

  useEffect(() => {
    if (knownNames.size === 0 || rebuiltForNamesRef.current) return;
    // 组字（IME）中不整树重建（N2-01）：等组字结束再重建，免得把「组字中」标记挪到新节点上
    return runWhenNotComposing(editor, () => {
      rebuiltForNamesRef.current = true;
      editor.update(
        () => {
          const text = $serializeToPlainText();
          if (parseSkillTokens(text, knownNames).length === 0) return;
          const cursor = $getPlainOffset();
          $setRootFromPlainText(text, knownNames);
          $setSelectionFromPlainOffset(cursor);
        },
        // 文本不变、只是把 `/name` 重画成 pill：并入当前历史项，不新增撤销步
        { tag: ["history-merge"] },
      );
    });
  }, [editor, knownNames]);

  return null;
};

const SlashAtAndSubmitPlugin = ({
  slash,
  atMention,
  onSubmit,
  submitShortcut,
  knownNames,
  lastEmittedRef,
  onChange,
}: {
  slash?: SlashSkillsApi;
  atMention?: AtMentionApi;
  onSubmit: () => void;
  submitShortcut: SubmitShortcut;
  knownNames: ReadonlySet<string>;
  lastEmittedRef: RefObject<string>;
  onChange: (value: string) => void;
}) => {
  const [editor] = useLexicalComposerContext();
  const slashRef = useRef(slash);
  slashRef.current = slash;
  const atRef = useRef(atMention);
  atRef.current = atMention;
  const onSubmitRef = useRef(onSubmit);
  onSubmitRef.current = onSubmit;
  const shortcutRef = useRef(submitShortcut);
  shortcutRef.current = submitShortcut;
  const namesRef = useRef(knownNames);
  namesRef.current = knownNames;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!slash) return;
    return slash.registerPickHandler((skill) => {
      const slot: [{ text: string; cursor: number } | null] = [null];
      editor.update(() => {
        slot[0] = $replaceSlashPartialWithToken(skill.name, namesRef.current);
      });
      const result = slot[0];
      if (!result) return false;
      lastEmittedRef.current = result.text;
      onChangeRef.current(result.text);
      slash.onDraftChange(result.text, result.cursor);
      atRef.current?.onDraftChange(result.text, result.cursor);
      return true;
    });
  }, [editor, slash, lastEmittedRef]);

  useEffect(() => {
    if (!atMention) return;
    return atMention.registerPickHandler((hit) => {
      const slot: [{ text: string; cursor: number } | null] = [null];
      editor.update(() => {
        slot[0] = $replaceAtPartialWithToken(hit, namesRef.current);
      });
      const result = slot[0];
      if (!result) return false;
      lastEmittedRef.current = result.text;
      onChangeRef.current(result.text);
      atMention.onDraftChange(result.text, result.cursor);
      slashRef.current?.onDraftChange(result.text, result.cursor);
      return true;
    });
  }, [editor, atMention, lastEmittedRef]);

  useEffect(() => {
    return editor.registerCommand(
      KEY_ENTER_COMMAND,
      (event) => {
        if (event && isImeComposing(event)) return false;
        const s = slashRef.current;
        if (s?.menuOpen && event) {
          event.preventDefault();
          s.pickAt(s.activeIndex);
          return true;
        }
        const a = atRef.current;
        if (a?.menuOpen && event) {
          // 无候选（结果已到、确实没匹配）时不吞 Enter（让提交 / 换行走原逻辑）。
          // 候选还在路上（stale）也要拦下：pickAt 会拒选陈旧候选（V5-02），
          // 但 Enter 不能漏给「提交」——否则半截的 `@But` 被当正文发出去
          if (a.filtered.length > 0 || a.stale) {
            event.preventDefault();
            a.pickAt(a.activeIndex);
            return true;
          }
        }
        if (event && shouldSubmitNative(event, shortcutRef.current)) {
          event.preventDefault();
          onSubmitRef.current();
          return true;
        }
        // 对位组合（原「立即发送」快捷键）现无动作——立即发送已迁到排队面板置顶按钮
        return false;
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [editor]);

  return null;
};

/**
 * 空输入框 ↑↓ 翻本会话历史（shell 风）。
 * 有 slash / @ 菜单时不抢键；非空或光标不在首段起点时保持 Lexical 原生多行行为。
 */
const InputHistoryPlugin = ({
  slash,
  atMention,
  knownNames,
  lastEmittedRef,
  onChange,
  editorKey,
}: {
  slash?: SlashSkillsApi;
  atMention?: AtMentionApi;
  knownNames: ReadonlySet<string>;
  lastEmittedRef: RefObject<string>;
  onChange: (value: string) => void;
  /** 切会话重置游标 */
  editorKey?: string;
}) => {
  const [editor] = useLexicalComposerContext();
  const session = useComposerSession();
  // 稳住引用：session 缺失时别每次新建 []，否则 effect 每渲重绑
  const history = useMemo(
    () => session?.inputHistory ?? [],
    [session?.inputHistory],
  );
  // -1 = 未在翻历史（显示空或用户正在编辑）；0..n-1 = 历史条目；翻过头再 ↓ 回空
  const histIndexRef = useRef(-1);
  // 进入历史前的草稿（通常为空）；↓ 回到 -1 时恢复
  const stashRef = useRef("");

  useEffect(() => {
    histIndexRef.current = -1;
    stashRef.current = "";
  }, [editorKey, session?.taskId]);

  const applyHistoryText = useCallback(
    (text: string) => {
      editor.update(() => {
        $setRootFromPlainText(text, knownNames);
        $getRoot().selectEnd();
      });
      lastEmittedRef.current = text;
      onChange(text);
      const cursor = text.length;
      slash?.onDraftChange(text, cursor);
      atMention?.onDraftChange(text, cursor);
    },
    [editor, knownNames, lastEmittedRef, onChange, slash, atMention],
  );

  useEffect(() => {
    const canTake = (): boolean => {
      if (slash?.menuOpen || atMention?.menuOpen) return false;
      if (history.length === 0) return false;
      let plain = "";
      let atDocStart = false;
      editor.getEditorState().read(() => {
        plain = $serializeToPlainText();
        const sel = $getSelection();
        if (!$isRangeSelection(sel) || !sel.isCollapsed()) {
          atDocStart = false;
          return;
        }
        atDocStart = $getPlainOffset() === 0;
      });
      // 已在翻历史：直接放行 ↑（applyHistoryText 后光标在文末，atDocStart 恒为 false，否则无法连续上翻）
      if (histIndexRef.current >= 0) return true;
      // 未进入历史且输入非空：不劫持（多行编辑保持原生 ↑↓）
      if (plain.length > 0) return false;
      // 空输入时光标必在起点；仍要求 collapsed 在 offset 0
      return atDocStart;
    };

    const unUp = editor.registerCommand(
      KEY_ARROW_UP_COMMAND,
      (event) => {
        if (event?.isComposing) return false;
        if (!canTake()) return false;
        event?.preventDefault();
        if (histIndexRef.current < 0) {
          stashRef.current = "";
          histIndexRef.current = 0;
        } else if (histIndexRef.current < history.length - 1) {
          histIndexRef.current += 1;
        }
        applyHistoryText(history[histIndexRef.current] ?? "");
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );

    const unDown = editor.registerCommand(
      KEY_ARROW_DOWN_COMMAND,
      (event) => {
        if (event?.isComposing) return false;
        // 只有已经在翻历史时才接管 ↓（空输入原生 ↓ 无意义，但也不误伤）
        if (histIndexRef.current < 0) return false;
        if (slash?.menuOpen || atMention?.menuOpen) return false;
        event?.preventDefault();
        if (histIndexRef.current <= 0) {
          histIndexRef.current = -1;
          applyHistoryText(stashRef.current);
          return true;
        }
        histIndexRef.current -= 1;
        applyHistoryText(history[histIndexRef.current] ?? "");
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );

    return () => {
      unUp();
      unDown();
    };
  }, [
    editor,
    history,
    slash?.menuOpen,
    atMention?.menuOpen,
    applyHistoryText,
  ]);

  // 用户开始打字改历史条目 → 脱离历史游标（下次空输入再 ↑ 从最新起）
  useEffect(() => {
    return editor.registerUpdateListener(({ editorState, tags }) => {
      if (tags.has("external-value")) return;
      if (histIndexRef.current < 0) return;
      editorState.read(() => {
        const plain = $serializeToPlainText();
        const expected = history[histIndexRef.current] ?? "";
        if (plain !== expected) {
          histIndexRef.current = -1;
        }
      });
    });
  }, [editor, history]);

  return null;
};

const PasteImagePlugin = ({ attach }: { attach?: UseImageAttachReturn }) => {
  const [editor] = useLexicalComposerContext();
  const attachRef = useRef(attach);
  attachRef.current = attach;

  useEffect(() => {
    return editor.registerCommand(
      PASTE_COMMAND,
      (event) => {
        const a = attachRef.current;
        if (!a || !(event instanceof ClipboardEvent)) return false;
        const items = event.clipboardData?.items;
        if (!items || items.length === 0) return false;
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          if (item && item.kind === "file" && item.type.startsWith("image/")) {
            a.onPaste(event);
            return true;
          }
        }
        return false;
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [editor]);

  return null;
};

/**
 * 粘贴超长纯文本 → 附件 pill（Cursor 同款）。
 * 优先级与 PasteImagePlugin 同级 HIGH：有图时先让图插件吃（本 handler 见图即放行）；
 * 无图且超阈值才 preventDefault + 调 onPasteLongText。
 */
const PasteLongTextPlugin = ({
  onPasteLongText,
}: {
  onPasteLongText?: (content: string) => Promise<boolean>;
}) => {
  const [editor] = useLexicalComposerContext();
  const handlerRef = useRef(onPasteLongText);
  handlerRef.current = onPasteLongText;

  useEffect(() => {
    return editor.registerCommand(
      PASTE_COMMAND,
      (event) => {
        const handler = handlerRef.current;
        if (!handler || !(event instanceof ClipboardEvent)) return false;
        const items = event.clipboardData?.items;
        // 剪贴板带图 → 交给 PasteImagePlugin，不抢
        if (items) {
          for (let i = 0; i < items.length; i++) {
            const item = items[i];
            if (item && item.kind === "file" && item.type.startsWith("image/")) {
              return false;
            }
          }
        }
        const text = event.clipboardData?.getData("text/plain") ?? "";
        if (!shouldConvertPasteToAttachment(text)) return false;

        event.preventDefault();
        // 异步落盘：成功则已加 path pill；失败把原文插回选区（别丢用户内容）
        void (async () => {
          const ok = await handler(text);
          if (ok) return;
          editor.update(() => {
            const selection = $getSelection();
            if ($isRangeSelection(selection)) {
              selection.insertText(text);
            } else {
              const root = $getRoot();
              root.selectEnd();
              const sel = $getSelection();
              if ($isRangeSelection(sel)) sel.insertText(text);
            }
          });
        })();
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [editor]);

  return null;
};

const FocusHandlePlugin = ({
  focusRef,
  pendingCursorRef,
}: {
  focusRef?: RefObject<ComposerFocusHandle | null>;
  pendingCursorRef: RefObject<number | null>;
}) => {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    if (!focusRef) return;
    focusRef.current = {
      focus: () => {
        editor.focus();
      },
      prepareCursor: (offset) => {
        pendingCursorRef.current = offset;
      },
    };
    return () => {
      focusRef.current = null;
    };
  }, [editor, focusRef, pendingCursorRef]);

  return null;
};

const ComposerEditorInner = ({
  value,
  onChange,
  onSubmit,
  placeholder,
  disabled,
  focusRef,
  boxContainerRef,
  boxHeight,
  slash,
  atMention,
  attach,
  onPasteLongText,
  className,
  ariaLabel,
  lastEmittedRef,
  pendingCursorRef,
  editorKey,
}: ComposerEditorProps & {
  lastEmittedRef: RefObject<string>;
  pendingCursorRef: RefObject<number | null>;
  editorKey?: string;
}) => {
  const submitShortcut = useSubmitShortcut();
  const knownNames = slash?.knownNames ?? EMPTY_NAMES;
  // E2 双击 Esc 清空草稿：上次 Esc 的时间戳（窗口判定在 lib/keyboard-shortcuts）
  const lastEscTsRef = useRef<number | null>(null);
  // 下一次外部写回可撤销（双击 Esc 清空专用；其余程序性写回不进撤销栈）
  const undoableNextRef = useRef(false);

  const handleEditorChange = useCallback(
    (editorState: EditorState, _editor: unknown, tags: Set<string>) => {
      if (tags.has("external-value")) return;
      editorState.read(() => {
        const text = $serializeToPlainText();
        const cursor = $getPlainOffset();
        slash?.onDraftChange(text, cursor);
        atMention?.onDraftChange(text, cursor);
        if (text === lastEmittedRef.current) return;
        lastEmittedRef.current = text;
        onChange(text);
      });
    },
    [onChange, slash, atMention, lastEmittedRef],
  );

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      // ↑↓/Tab/Esc：slash 优先，再 @；Enter 在 KEY_ENTER_COMMAND
      if (e.key === "Enter") return;
      if (slash?.onKeyDown(e)) return;
      if (atMention?.onKeyDown(e)) return;
      // E2 双击 Esc 清空草稿（有内容时）；单 Esc 不动现有行为（菜单关闭已在上面消费）
      if (e.key === "Escape" && !e.nativeEvent.isComposing) {
        const now = Date.now();
        if (
          lastEmittedRef.current &&
          isDoubleEsc(lastEscTsRef.current, now)
        ) {
          lastEscTsRef.current = null;
          // 走 onChange("")：父级草稿清空 → ExternalValuePlugin 同步清编辑器；
          // 这是用户主动的清空，保留可 Cmd+Z 撤销（程序性写回默认不进撤销栈，N2-05）
          undoableNextRef.current = true;
          onChange("");
        } else {
          lastEscTsRef.current = now;
        }
      }
    },
    [slash, atMention, lastEmittedRef, onChange],
  );

  const boxStyle = boxHeight != null ? { height: boxHeight } : undefined;

  // 输入框（textbox）侧 aria：菜单开着时 aria-controls 指向列表、aria-activedescendant 指向当前高亮项
  //（V5-03；焦点一直留在编辑器、读屏靠它知道高亮在哪）。slash / @ 同时最多开一个。
  // textbox 角色不允许 aria-expanded，所以不加。
  const menuA11y = menuAria(
    slash?.menuOpen
      ? {
          open: true,
          itemCount: slash.filtered.length,
          activeIndex: slash.activeIndex,
          listId: slash.listId,
        }
      : atMention?.menuOpen
        ? {
            open: true,
            itemCount: atMention.filtered.length,
            activeIndex: atMention.activeIndex,
            listId: atMention.listId,
          }
        : { open: false, itemCount: 0, activeIndex: 0, listId: "" },
  );

  return (
    <>
      <PlainTextPlugin
        contentEditable={
          <div
            ref={boxContainerRef}
            className={cn(
              "relative overflow-y-auto",
              boxHeight == null && "max-h-64",
            )}
            style={boxStyle}
          >
            <ContentEditable
              className={cn(
                COMPOSER_EDITOR_CLASS,
                // 固定高度容器（推进弹窗 / 答题卡 / 拖高过的输入条）必须让编辑器撑满外层、
                // 整块都能点聚焦：否则容器比编辑器高的那截属于外层 div、点了不进编辑器
                //（用户实测「指令框只有顶上一条能点」）。内容超出时编辑器自然长高、外层照常滚。
                // 高度随内容（boxHeight=null）时外层就是被编辑器撑起来的、没有空档，保持两行下限。
                boxHeight != null ? "min-h-full" : "min-h-13",
                "relative outline-none",
                // 禁用态文字走语义 token（text-muted-foreground），不压 opacity-60（V13-12：整体压透明会掉到 AA 以下）
                disabled && "cursor-not-allowed text-muted-foreground",
                className,
              )}
              ariaLabel={ariaLabel ?? "消息输入框"}
              aria-placeholder={placeholder ?? ""}
              ariaControls={menuA11y.controls}
              ariaActiveDescendant={menuA11y.activeDescendant}
              placeholder={
                <div
                  className={cn(
                    COMPOSER_EDITOR_CLASS,
                    // absolute inset-0 已按外层尺寸铺满、不需要再给 min-height
                    "pointer-events-none absolute inset-0 text-muted-foreground",
                  )}
                >
                  {placeholder}
                </div>
              }
              onKeyDown={onKeyDown}
            />
          </div>
        }
        ErrorBoundary={LexicalErrorBoundary}
      />
      <HistoryPlugin />
      <OnChangePlugin onChange={handleEditorChange} />
      <ExternalValuePlugin
        value={value}
        knownNames={knownNames}
        lastEmittedRef={lastEmittedRef}
        pendingCursorRef={pendingCursorRef}
        undoableNextRef={undoableNextRef}
        onChange={onChange}
      />
      <EditablePlugin disabled={disabled} />
      <SkillTokenTransformPlugin knownNames={knownNames} />
      <SlashAtAndSubmitPlugin
        slash={slash}
        atMention={atMention}
        onSubmit={onSubmit}
        submitShortcut={submitShortcut}
        knownNames={knownNames}
        lastEmittedRef={lastEmittedRef}
        onChange={onChange}
      />
      <InputHistoryPlugin
        slash={slash}
        atMention={atMention}
        knownNames={knownNames}
        lastEmittedRef={lastEmittedRef}
        onChange={onChange}
        editorKey={editorKey}
      />
      <PasteImagePlugin attach={attach} />
      <PasteLongTextPlugin onPasteLongText={onPasteLongText} />
      <FocusHandlePlugin
        focusRef={focusRef}
        pendingCursorRef={pendingCursorRef}
      />
    </>
  );
};

export const ComposerEditor = (
  props: ComposerEditorProps & { editorKey?: string },
) => {
  const lastEmittedRef = useRef(props.value);
  const pendingCursorRef = useRef<number | null>(null);

  const initialConfig = useMemo(
    () => ({
      namespace: "ComposerEditor",
      nodes: [SkillTokenNode, FileTokenNode],
      onError: (error: Error) => {
        console.error("[ComposerEditor]", error);
      },
      editable: !props.disabled,
      editorState: () => {
        $setRootFromPlainText(
          props.value,
          props.slash?.knownNames ?? EMPTY_NAMES,
        );
      },
    }),
    // initialConfig 契约：只读一次，后续靠 ExternalValuePlugin / EditablePlugin
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Lexical mount-only
    [],
  );

  return (
    <LexicalComposer initialConfig={initialConfig}>
      <ComposerEditorInner
        {...props}
        lastEmittedRef={lastEmittedRef}
        pendingCursorRef={pendingCursorRef}
      />
    </LexicalComposer>
  );
};
