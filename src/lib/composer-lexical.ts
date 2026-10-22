/**
 * Composer 的 Lexical 纯逻辑（从 composer-editor.tsx 抽出，便于 headless 行为测试；无 React / DOM）
 *
 * - 纯文本 ⇄ 段落树（skill / file token 还原）、光标 offset 换算、手打 `/skill` 的 transform；
 * - 外部写回（父级 value 变了 → 写进编辑器）：组字（IME）守卫 + 不进撤销栈（第四轮 N2-01 / N2-05）。
 */

import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  $isTextNode,
  CLEAR_HISTORY_COMMAND,
  HISTORY_MERGE_TAG,
  TextNode,
  type LexicalEditor,
  type LexicalNode,
} from "lexical";

import { parseSkillTokens } from "@/lib/skill-token";
import {
  $createSkillTokenNode,
  $isSkillTokenNode,
} from "@/components/composer-skill-token-node";
import {
  $createFileTokenNode,
  $isFileTokenNode,
} from "@/components/composer-file-token-node";
import { findAtFileTokens } from "@/lib/composer-trigger";

/**
 * 把一行纯文本拆成 TextNode + SkillTokenNode + FileTokenNode。
 * skill 优先（与 knownNames 对齐）；剩余段再切 file token。
 */
export const $nodesFromPlainLine = (
  line: string,
  knownNames: ReadonlySet<string>,
): LexicalNode[] => {
  if (!line) return [];
  const skillTokens = parseSkillTokens(line, knownNames);
  // `@path` 还原 pill：不要求「已知文件清单」、靠形态 + 与触发同口径的边界（lib/composer-trigger）
  const fileTokens = findAtFileTokens(line);

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
export const $setRootFromPlainText = (
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
export const $serializeToPlainText = (): string => {
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
export const $getPlainOffset = (): number => {
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
export const $setSelectionFromPlainOffset = (offset: number): void => {
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

/** 同一段落里排在 node 前面的所有兄弟的纯文本（token 按序列化长度计） */
const $textBeforeInParagraph = (node: TextNode): string => {
  let out = "";
  let prev = node.getPreviousSibling();
  while (prev) {
    out = prev.getTextContent() + out;
    prev = prev.getPreviousSibling();
  }
  return out;
};

/**
 * 手打 `/known-name` → SkillTokenNode（与 parseSkillTokens 同逻辑）。
 *
 * 口径与「整段 parseSkillTokens」一致（第四轮 N2-02）：节点开头不是行首——前面还有兄弟节点
 *（比如刚成 pill 的 `/plan`）时，`/` 前一字符要拿兄弟的文本来判，否则 `/plan/review`（紧贴、无分隔）
 * 界面画两个 pill、发送时 skillRefs 只认第一个。做法：带上前缀整段解析，只取起点落在本节点内的 token。
 * 手打热路径（每次按键整节点重算）先做两个零成本短路：没有已知 skill / 文本里没有 `/`。
 */
export const $transformSkillTokensInTextNode = (
  node: TextNode,
  knownNames: ReadonlySet<string>,
): void => {
  if (knownNames.size === 0) return;
  if (!node.isAttached() || !node.isSimpleText()) return;
  if ($isSkillTokenNode(node) || $isFileTokenNode(node)) return;
  const text = node.getTextContent();
  if (!text.includes("/")) return;
  const prefix = $textBeforeInParagraph(node);
  const tokens = parseSkillTokens(prefix + text, knownNames).filter(
    (t) => t.start >= prefix.length,
  );
  if (tokens.length === 0) return;
  const first = tokens[0]!;
  const t = {
    name: first.name,
    start: first.start - prefix.length,
    end: first.end - prefix.length,
  };
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

// —— 外部写回（父级 value 变了 → 写进编辑器）——

/** 外部写回的 update tag：OnChangePlugin / 历史游标据此忽略这次更新 */
export const EXTERNAL_VALUE_TAG = "external-value";

/**
 * 等「不在组字」再执行 fn；此刻已不在组字则立刻执行。返回取消函数。
 *
 * 为什么要等（第四轮 N2-01）：组字（IME）期间整树重建会让 Lexical 把「组字中」标记挪到一个无关的新节点上
 *（`selectEnd()` → `TextNode.select()` 会把 compositionKey 跟到新节点）、预编辑字母被当正文写回，
 * 浏览器里那个被输入法持有的 DOM 文本节点已被移除。所以组字中的外部写回 / 整树重建一律延后。
 * 触发点：编辑器每次更新（Lexical 自己的 compositionend 会触发一次更新）+ 根节点 `compositionend`
 *（兜底；DOM 事件可能先于 Lexical 清标记，所以微任务后再判一次）。
 */
export const runWhenNotComposing = (
  editor: LexicalEditor,
  fn: () => void,
): (() => void) => {
  if (!editor.isComposing()) {
    fn();
    return () => {};
  }
  let done = false;
  const offs: Array<() => void> = [];
  const cleanup = () => {
    for (const off of offs.splice(0)) off();
  };
  const tick = () => {
    if (done || editor.isComposing()) return;
    done = true;
    cleanup();
    fn();
  };
  offs.push(editor.registerUpdateListener(tick));
  const onEnd = () => queueMicrotask(tick);
  offs.push(
    editor.registerRootListener((root, prev) => {
      prev?.removeEventListener("compositionend", onEnd);
      root?.addEventListener("compositionend", onEnd);
    }),
  );
  // registerRootListener 注销时（cleanup）把最后挂着的根一并解绑
  offs.push(() => editor.getRootElement()?.removeEventListener("compositionend", onEnd));
  return () => {
    done = true;
    cleanup();
  };
};

const $readPlainText = (editor: LexicalEditor): string => {
  let text = "";
  editor.getEditorState().read(() => {
    text = $serializeToPlainText();
  });
  return text;
};

export interface ExternalWriteOptions {
  /**
   * 写回可被 Cmd+Z 撤销（默认 false）。程序性写回（发送成功清空 / 失败恢复 / 技能表晚到重建）不进撤销栈：
   * 否则发送后在空输入框按 Cmd+Z 会把已发出的草稿请回来（第四轮 N2-05）。
   * 用户主动的「双击 Esc 清空」传 true，撤销栈保留。
   */
  undoable?: boolean;
}

export interface ExternalValueWriter {
  /** 写回：不在组字 → 立刻写，返回 "applied"；组字中 → 暂存、等组字结束再写，返回 "deferred" */
  write: (
    value: string,
    cursor: number | null,
    opts?: ExternalWriteOptions,
  ) => "applied" | "deferred";
  hasPending: () => boolean;
  /** 卸载 / 换编辑器时丢掉暂存的延后写回 */
  dispose: () => void;
}

/**
 * 外部写回器：组字守卫 + 不进撤销栈。
 *
 * 延后写回落地时用户可能已经敲了新内容（OnChange 还会把组字中的文本同步给父级，覆盖掉那份写回值），
 * 所以落地时按「原文在前、新输入在后」重新合并一次：暂存值 P 来自写回那一刻的草稿 B（合并写回的产物
 * 以 B 结尾），落地时编辑器已是 C → 结果 = P 去掉结尾的 B 再接 C。P 不以 B 结尾（清空 / 整体替换）
 * 则以 P 为准。落地后通过 `onDeferredApplied(text)` 把结果交还父级（同步 value / lastEmitted）。
 */
export const createExternalValueWriter = (deps: {
  editor: LexicalEditor;
  getKnownNames: () => ReadonlySet<string>;
  onDeferredApplied?: (text: string) => void;
}): ExternalValueWriter => {
  const { editor } = deps;
  let pending: {
    value: string;
    base: string;
    undoable: boolean;
  } | null = null;
  let cancelWait: (() => void) | null = null;

  const apply = (
    value: string,
    cursor: number | null,
    undoable: boolean,
  ): void => {
    editor.update(
      () => {
        $setRootFromPlainText(value, deps.getKnownNames());
        if (cursor != null) $setSelectionFromPlainOffset(cursor);
        else $getRoot().selectEnd();
      },
      {
        tag: undoable
          ? [EXTERNAL_VALUE_TAG]
          : [EXTERNAL_VALUE_TAG, HISTORY_MERGE_TAG],
        // 提交之后再清栈：这次写回并入当前历史项（merge 不新增撤销项），
        // 撤销栈里不再留任何写回前的状态（含发送前的草稿碎片）
        onUpdate: undoable
          ? undefined
          : () => editor.dispatchCommand(CLEAR_HISTORY_COMMAND, undefined),
      },
    );
  };

  const flush = (): void => {
    const p = pending;
    pending = null;
    cancelWait = null;
    if (!p) return;
    const current = $readPlainText(editor);
    const merged = p.value.endsWith(p.base)
      ? p.value.slice(0, p.value.length - p.base.length) + current
      : p.value;
    apply(merged, null, p.undoable);
    deps.onDeferredApplied?.(merged);
  };

  return {
    write: (value, cursor, opts) => {
      const undoable = opts?.undoable === true;
      if (editor.isComposing()) {
        pending = { value, base: $readPlainText(editor), undoable };
        cancelWait?.();
        cancelWait = runWhenNotComposing(editor, flush);
        return "deferred";
      }
      pending = null;
      cancelWait?.();
      cancelWait = null;
      apply(value, cursor, undoable);
      return "applied";
    },
    hasPending: () => pending !== null,
    dispose: () => {
      pending = null;
      cancelWait?.();
      cancelWait = null;
    },
  };
};
