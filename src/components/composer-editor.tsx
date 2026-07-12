/**
 * Composer 输入引擎（Lexical PlainText + SkillTokenNode）
 *
 * 替换原原生 textarea + mirror overlay + 原子删除拦截：
 * - skill token = DecoratorNode（视觉 tag + 整删）
 * - 对外仍序列化为纯文本 `/skill-name`，调用方 value/onChange 协议不变
 * - slash 菜单：打 `/xxx` 时复用 useSlashSkills；选中后把 `/partial` 换成 token + 空格
 * - 手打全名 + 空格 / 外部写回草稿：TextNode transform 或整段 parse 转成 token
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
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  $isTextNode,
  COMMAND_PRIORITY_HIGH,
  KEY_ENTER_COMMAND,
  PASTE_COMMAND,
  TextNode,
  type EditorState,
  type LexicalNode,
} from "lexical";

import { cn } from "@/lib/utils";
import {
  parseSkillTokens,
  type SlashSkillsApi,
} from "@/components/slash-skills";
import {
  $createSkillTokenNode,
  $isSkillTokenNode,
  SkillTokenNode,
} from "@/components/composer-skill-token-node";
import { useSubmitShortcut } from "@/hooks/use-settings";
import type { SubmitShortcut } from "@/lib/types";
import type { UseImageAttachReturn } from "@/hooks/use-image-attach";

/** 与旧 textarea 排版对齐，拖高 / placeholder 视觉不变 */
export const COMPOSER_EDITOR_CLASS =
  "min-h-13 w-full px-3.5 pt-1 pb-2.5 text-sm leading-normal wrap-anywhere whitespace-pre-wrap";

/** 调用方只用 focus（Cmd+J / awaiting 自动聚焦） */
export interface ComposerFocusHandle {
  focus: () => void;
  /**
   * 外部即将写回草稿并希望落位时先调：下一帧 sync 用这个纯文本 offset。
   * token 按序列化长度 `/name` 计（跟旧 textarea 光标语义一致）。
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
  attach?: UseImageAttachReturn;
  className?: string;
}

const EMPTY_NAMES: ReadonlySet<string> = new Set();

/** 原生 KeyboardEvent 版提交判定（Lexical KEY_ENTER） */
const shouldSubmitNative = (
  event: KeyboardEvent,
  shortcut: SubmitShortcut,
): boolean => {
  if (event.key !== "Enter") return false;
  // 中文 IME 选词 Enter 不能当发送
  if (event.isComposing) return false;
  if (shortcut === "enter") {
    return !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey;
  }
  return (event.metaKey || event.ctrlKey) && !event.altKey;
};

/**
 * 把一行纯文本拆成 TextNode + SkillTokenNode。
 * 外部写回 / pick 重建时走这里，不依赖「尾随空格」才能认出 token。
 */
const $nodesFromPlainLine = (
  line: string,
  knownNames: ReadonlySet<string>,
): LexicalNode[] => {
  if (!line) return [];
  const tokens = parseSkillTokens(line, knownNames);
  if (tokens.length === 0) return [$createTextNode(line)];
  const nodes: LexicalNode[] = [];
  let cursor = 0;
  for (const t of tokens) {
    if (t.start > cursor) {
      nodes.push($createTextNode(line.slice(cursor, t.start)));
    }
    nodes.push($createSkillTokenNode(t.name));
    cursor = t.end;
  }
  if (cursor < line.length) {
    nodes.push($createTextNode(line.slice(cursor)));
  }
  return nodes;
};

/** 整段纯文本 → 段落树（`\n` = 段落分隔，跟 PlainText Enter 一致） */
const $setRootFromPlainText = (
  text: string,
  knownNames: ReadonlySet<string>,
): void => {
  const root = $getRoot();
  root.clear();
  const lines = text.split("\n");
  for (const line of lines) {
    const p = $createParagraphNode();
    const nodes = $nodesFromPlainLine(line, knownNames);
    if (nodes.length === 0) {
      p.append($createTextNode(""));
    } else {
      p.append(...nodes);
    }
    root.append(p);
  }
};

/** 编辑器 → 纯文本（token 序列化为 `/name`，段落之间 `\n`） */
const $serializeToPlainText = (): string => {
  const root = $getRoot();
  return root
    .getChildren()
    .map((p) => {
      if (!$isElementNode(p)) return p.getTextContent();
      return p
        .getChildren()
        .map((c) => c.getTextContent())
        .join("");
    })
    .join("\n");
};

/**
 * 当前选区锚点对应的纯文本 offset（token 按 `/name` 长度计）。
 * slash 菜单用「光标前文本」匹配 `/partial`。
 */
const $getPlainOffset = (): number => {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) {
    return $serializeToPlainText().length;
  }
  const anchor = selection.anchor;
  const anchorNode = anchor.getNode();
  const root = $getRoot();
  let total = 0;

  const paragraphs = root.getChildren();
  for (let pi = 0; pi < paragraphs.length; pi++) {
    if (pi > 0) total += 1;
    const p = paragraphs[pi];
    if (!$isElementNode(p)) continue;

    if (anchorNode.getKey() === p.getKey()) {
      const children = p.getChildren();
      const childLimit = Math.min(anchor.offset, children.length);
      for (let i = 0; i < childLimit; i++) {
        total += children[i].getTextContent().length;
      }
      return total;
    }

    for (const child of p.getChildren()) {
      if (child.getKey() === anchorNode.getKey()) {
        if ($isTextNode(child)) {
          return total + anchor.offset;
        }
        // Decorator：offset 0 = 节点前，>0 = 节点后
        return total + (anchor.offset === 0 ? 0 : child.getTextContent().length);
      }
      total += child.getTextContent().length;
    }
  }
  return total;
};

/** 按纯文本 offset 落选区（外部 applyDraft 补全后用） */
const $setSelectionFromPlainOffset = (offset: number): void => {
  const root = $getRoot();
  let remaining = Math.max(0, offset);
  const paragraphs = root.getChildren();

  for (let pi = 0; pi < paragraphs.length; pi++) {
    if (pi > 0) {
      if (remaining === 0) {
        const p = paragraphs[pi];
        if ($isElementNode(p)) p.selectStart();
        return;
      }
      remaining -= 1;
    }
    const p = paragraphs[pi];
    if (!$isElementNode(p)) continue;
    const children = p.getChildren();
    if (children.length === 0) {
      if (remaining === 0) {
        p.selectStart();
        return;
      }
      continue;
    }
    for (const child of children) {
      const len = child.getTextContent().length;
      if (remaining <= len) {
        if ($isTextNode(child)) {
          const o = Math.min(remaining, child.getTextContentSize());
          child.select(o, o);
          return;
        }
        if ($isSkillTokenNode(child)) {
          if (remaining === 0) child.selectPrevious();
          else child.selectNext();
          return;
        }
        child.selectNext();
        return;
      }
      remaining -= len;
    }
  }
  root.selectEnd();
};

/**
 * 手打 `/known-name `（必须带尾随空白）→ 换成 SkillTokenNode。
 * 不要求尾空格会在「既有 skill 又有 skill-xxx」时误转半截名。
 */
const $transformSkillTokensInTextNode = (
  node: TextNode,
  knownNames: ReadonlySet<string>,
): void => {
  if (!node.isAttached() || !node.isSimpleText()) return;
  const text = node.getTextContent();
  const re = /(^|\s)\/([a-zA-Z0-9._-]+)(?=\s)/g;
  let match: RegExpExecArray | null;
  re.lastIndex = 0;
  while ((match = re.exec(text)) !== null) {
    const name = match[2];
    if (!knownNames.has(name)) continue;
    const leading = match[1] ?? "";
    const start = match.index + leading.length;
    const end = start + 1 + name.length;

    let target: TextNode;
    if (start === 0 && end === text.length) {
      target = node;
    } else if (start === 0) {
      target = node.splitText(end)[0]!;
    } else if (end === text.length) {
      target = node.splitText(start)[1]!;
    } else {
      target = node.splitText(start, end)[1]!;
    }
    target.replace($createSkillTokenNode(name));
    return;
  }
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
  const m = before.match(/(^|\s)\/([a-zA-Z0-9._-]*)$/);
  if (!m) return null;
  const partialLen = m[2].length + 1;
  const cutStart = cursor - partialLen;
  const token = `/${skillName} `;
  const next = plain.slice(0, cutStart) + token + plain.slice(cursor);
  const nextCursor = cutStart + token.length;
  $setRootFromPlainText(next, knownNames);
  $setSelectionFromPlainOffset(nextCursor);
  return { text: next, cursor: nextCursor };
};

// —— Plugins ——

const ExternalValuePlugin = ({
  value,
  knownNames,
  lastEmittedRef,
  pendingCursorRef,
}: {
  value: string;
  knownNames: ReadonlySet<string>;
  lastEmittedRef: RefObject<string>;
  pendingCursorRef: RefObject<number | null>;
}) => {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    // 防回环：编辑器 onChange 推出去的值再流回来、内容相同就不重设
    if (value === lastEmittedRef.current) return;
    lastEmittedRef.current = value;
    const cursor = pendingCursorRef.current;
    pendingCursorRef.current = null;
    editor.update(
      () => {
        $setRootFromPlainText(value, knownNames);
        if (cursor != null) $setSelectionFromPlainOffset(cursor);
        else $getRoot().selectEnd();
      },
      { tag: "external-value" },
    );
  }, [value, knownNames, editor, lastEmittedRef, pendingCursorRef]);

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
  // skills 首次拉齐时做一次全文重建（pending handoff / 草稿里已有 `/name`）
  const rebuiltForNamesRef = useRef(false);

  useEffect(() => {
    return editor.registerNodeTransform(TextNode, (node) => {
      $transformSkillTokensInTextNode(node, namesRef.current);
    });
  }, [editor]);

  useEffect(() => {
    if (knownNames.size === 0 || rebuiltForNamesRef.current) return;
    rebuiltForNamesRef.current = true;
    editor.update(() => {
      const text = $serializeToPlainText();
      if (parseSkillTokens(text, knownNames).length === 0) return;
      const cursor = $getPlainOffset();
      $setRootFromPlainText(text, knownNames);
      $setSelectionFromPlainOffset(cursor);
    });
  }, [editor, knownNames]);

  return null;
};

const SlashAndSubmitPlugin = ({
  slash,
  onSubmit,
  submitShortcut,
  knownNames,
  lastEmittedRef,
  onChange,
}: {
  slash?: SlashSkillsApi;
  onSubmit: () => void;
  submitShortcut: SubmitShortcut;
  knownNames: ReadonlySet<string>;
  lastEmittedRef: RefObject<string>;
  onChange: (value: string) => void;
}) => {
  const [editor] = useLexicalComposerContext();
  const slashRef = useRef(slash);
  slashRef.current = slash;
  const onSubmitRef = useRef(onSubmit);
  onSubmitRef.current = onSubmit;
  const shortcutRef = useRef(submitShortcut);
  shortcutRef.current = submitShortcut;
  const namesRef = useRef(knownNames);
  namesRef.current = knownNames;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // 注入 Lexical 版 pick：菜单选中直接插 token，避免先写字符串再 sync 丢光标
  useEffect(() => {
    if (!slash) return;
    return slash.registerPickHandler((skill) => {
      // 用数组槽位避开 TS 对闭包赋值的 never 收窄
      const slot: [{ text: string; cursor: number } | null] = [null];
      editor.update(() => {
        slot[0] = $replaceSlashPartialWithToken(skill.name, namesRef.current);
      });
      const result = slot[0];
      if (!result) return false;
      lastEmittedRef.current = result.text;
      onChangeRef.current(result.text);
      slash.onDraftChange(result.text, result.cursor);
      return true;
    });
  }, [editor, slash, lastEmittedRef]);

  useEffect(() => {
    return editor.registerCommand(
      KEY_ENTER_COMMAND,
      (event) => {
        if (event?.isComposing) return false;
        const s = slashRef.current;
        if (s?.menuOpen && event) {
          event.preventDefault();
          s.pickAt(s.activeIndex);
          return true;
        }
        if (event && shouldSubmitNative(event, shortcutRef.current)) {
          event.preventDefault();
          onSubmitRef.current();
          return true;
        }
        // Shift+Enter / 裸 Enter（mod-enter 模式）→ Lexical 默认换行
        return false;
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [editor]);

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
            // 有图：交给 attach（内部 preventDefault + addFiles）
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
  attach,
  className,
  lastEmittedRef,
  pendingCursorRef,
}: ComposerEditorProps & {
  lastEmittedRef: RefObject<string>;
  pendingCursorRef: RefObject<number | null>;
}) => {
  const submitShortcut = useSubmitShortcut();
  const knownNames = slash?.knownNames ?? EMPTY_NAMES;

  const handleEditorChange = useCallback(
    (editorState: EditorState, _editor: unknown, tags: Set<string>) => {
      // 外部写回触发的 update 不再反向 onChange
      if (tags.has("external-value")) return;
      editorState.read(() => {
        const text = $serializeToPlainText();
        const cursor = $getPlainOffset();
        // 选区变化也要推给 slash（光标挪开 `/partial` 后菜单应关）
        slash?.onDraftChange(text, cursor);
        // 正文没变就别 setState，避免无谓重渲
        if (text === lastEmittedRef.current) return;
        lastEmittedRef.current = text;
        onChange(text);
      });
    },
    [onChange, slash, lastEmittedRef],
  );

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      // ↑↓/Tab/Esc 归 slash；Enter 在 KEY_ENTER_COMMAND 处理，避免重复 pick/提交
      if (!slash) return;
      if (e.key === "Enter") return;
      slash.onKeyDown(e);
    },
    [slash],
  );

  const boxStyle = boxHeight != null ? { height: boxHeight } : undefined;

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
                "relative outline-none",
                disabled && "cursor-not-allowed opacity-60",
                className,
              )}
              aria-placeholder={placeholder ?? ""}
              placeholder={
                <div
                  className={cn(
                    COMPOSER_EDITOR_CLASS,
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
      />
      <EditablePlugin disabled={disabled} />
      <SkillTokenTransformPlugin knownNames={knownNames} />
      <SlashAndSubmitPlugin
        slash={slash}
        onSubmit={onSubmit}
        submitShortcut={submitShortcut}
        knownNames={knownNames}
        lastEmittedRef={lastEmittedRef}
        onChange={onChange}
      />
      <PasteImagePlugin attach={attach} />
      <FocusHandlePlugin
        focusRef={focusRef}
        pendingCursorRef={pendingCursorRef}
      />
    </>
  );
};

export const ComposerEditor = (props: ComposerEditorProps) => {
  // 最近一次从编辑器推给调用方的文本——外部 value 相同则跳过重设
  const lastEmittedRef = useRef(props.value);
  // applyDraft 希望落位的光标；ExternalValuePlugin 消费一次
  const pendingCursorRef = useRef<number | null>(null);

  // LexicalComposer 的 initialConfig 只在 mount 读一次
  const initialConfig = useMemo(
    () => ({
      namespace: "ComposerEditor",
      nodes: [SkillTokenNode],
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
