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
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  $isTextNode,
  COMMAND_PRIORITY_HIGH,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_ENTER_COMMAND,
  PASTE_COMMAND,
  TextNode,
  type EditorState,
  type LexicalNode,
} from "lexical";

import { cn } from "@/lib/utils";
import {
  parseSkillTokens,
  SLASH_RE,
  type SlashSkillsApi,
} from "@/components/slash-skills";
import {
  $createSkillTokenNode,
  $isSkillTokenNode,
  SkillTokenNode,
} from "@/components/composer-skill-token-node";
import {
  $createFileTokenNode,
  $isFileTokenNode,
  FileTokenNode,
} from "@/components/composer-file-token-node";
import {
  AT_RE,
  type AtFileHit,
  type AtMentionApi,
} from "@/components/at-mention";
import { useComposerSession } from "@/components/composer-session";
import { useSubmitShortcut } from "@/hooks/use-settings";
import { isDoubleEsc } from "@/lib/keyboard-shortcuts";
import type { SubmitShortcut } from "@/lib/types";
import type { UseImageAttachReturn } from "@/hooks/use-image-attach";
import { shouldConvertPasteToAttachment } from "@/lib/paste-text-attach";

/** 与旧 textarea 排版对齐，拖高 / placeholder 视觉不变 */
const COMPOSER_EDITOR_CLASS =
  "min-h-13 w-full px-3.5 pt-1 pb-2.5 text-sm leading-normal wrap-anywhere whitespace-pre-wrap";

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
}

const EMPTY_NAMES: ReadonlySet<string> = new Set();

/**
 * 从纯文本里切出 `@rel/path`（停在空白或 `:行号` 前）。
 * 不要求「已知文件清单」——草稿写回 / 历史翻出时靠形态还原 pill。
 */
const FILE_TOKEN_RE = /(^|\s)@([^\s:]+)/g;

interface FileTokenMatch {
  start: number;
  end: number;
  path: string;
}

const parseFileTokens = (line: string): FileTokenMatch[] => {
  const out: FileTokenMatch[] = [];
  FILE_TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FILE_TOKEN_RE.exec(line)) !== null) {
    const leading = m[1] ?? "";
    const filePath = m[2] ?? "";
    if (!filePath) continue;
    // 排除裸 `@word`（无 `/` 也无 `.`、也不以 `/` 结尾）——降低误伤普通 @ 提及
    const looksLikePath =
      filePath.includes("/") ||
      filePath.includes(".") ||
      filePath.endsWith("/");
    if (!looksLikePath) continue;
    const start = m.index + leading.length;
    const end = start + 1 + filePath.length;
    out.push({ start, end, path: filePath });
  }
  return out;
};

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
 * 把一行纯文本拆成 TextNode + SkillTokenNode + FileTokenNode。
 * skill 优先（与 knownNames 对齐）；剩余段再切 file token。
 */
const $nodesFromPlainLine = (
  line: string,
  knownNames: ReadonlySet<string>,
): LexicalNode[] => {
  if (!line) return [];
  const skillTokens = parseSkillTokens(line, knownNames);
  const fileTokens = parseFileTokens(line);

  // 合并区间，按 start 排序；重叠时 skill 优先（先登记的占坑）
  type Span =
    | { kind: "skill"; start: number; end: number; name: string }
    | { kind: "file"; start: number; end: number; path: string };
  const spans: Span[] = [
    ...skillTokens.map(
      (t): Span => ({
        kind: "skill",
        start: t.start,
        end: t.end,
        name: t.name,
      }),
    ),
    ...fileTokens.map(
      (t): Span => ({
        kind: "file",
        start: t.start,
        end: t.end,
        path: t.path,
      }),
    ),
  ].sort((a, b) => a.start - b.start);

  const nodes: LexicalNode[] = [];
  let cursor = 0;
  for (const s of spans) {
    if (s.start < cursor) continue; // 与已消费区间重叠、跳过
    if (s.start > cursor) {
      nodes.push($createTextNode(line.slice(cursor, s.start)));
    }
    if (s.kind === "skill") {
      nodes.push($createSkillTokenNode(s.name));
    } else {
      nodes.push($createFileTokenNode(s.path));
    }
    cursor = s.end;
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

/** 编辑器 → 纯文本（token 序列化为 `/name` / `@path`，段落之间 `\n`） */
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
 * 当前选区锚点对应的纯文本 offset（token 按序列化长度计）。
 * slash / @ 菜单用「光标前文本」匹配 partial。
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
        total += children[i]!.getTextContent().length;
      }
      return total;
    }

    for (const child of p.getChildren()) {
      if (child.getKey() === anchorNode.getKey()) {
        if ($isTextNode(child)) {
          return total + anchor.offset;
        }
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
        if ($isSkillTokenNode(child) || $isFileTokenNode(child)) {
          if (remaining === 0) child.select(0, 0);
          else child.select(len, len);
          return;
        }
        if ($isTextNode(child)) {
          const o = Math.min(remaining, child.getTextContentSize());
          child.select(o, o);
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
 * 手打 `/known-name` → SkillTokenNode（与 parseSkillTokens 同逻辑）。
 */
const $transformSkillTokensInTextNode = (
  node: TextNode,
  knownNames: ReadonlySet<string>,
): void => {
  if (!node.isAttached() || !node.isSimpleText()) return;
  if ($isSkillTokenNode(node) || $isFileTokenNode(node)) return;
  const text = node.getTextContent();
  const tokens = parseSkillTokens(text, knownNames);
  if (tokens.length === 0) return;
  const t = tokens[0]!;
  const start = t.start;
  const end = t.end;

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
  target.replace($createSkillTokenNode(t.name));
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
  const m = before.match(SLASH_RE);
  if (!m) return null;
  const partialLen = m[2]!.length + 1;
  const cutStart = cursor - partialLen;
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
  const m = before.match(AT_RE);
  if (!m) return null;
  const partialLen = (m[2]?.length ?? 0) + 1;
  const cutStart = cursor - partialLen;
  const token = `@${hit.path} `;
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
        if (event?.isComposing) return false;
        const s = slashRef.current;
        if (s?.menuOpen && event) {
          event.preventDefault();
          s.pickAt(s.activeIndex);
          return true;
        }
        const a = atRef.current;
        if (a?.menuOpen && event) {
          // 无候选时不吞 Enter（让提交 / 换行走原逻辑）
          if (a.filtered.length > 0) {
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
          // 走 onChange("")：父级草稿清空 → ExternalValuePlugin 同步清编辑器
          onChange("");
        } else {
          lastEscTsRef.current = now;
        }
      }
    },
    [slash, atMention, lastEmittedRef, onChange],
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
