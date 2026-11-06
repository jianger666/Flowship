"use client";

/**
 * 代码 / 文本查看器 + 轻量编辑器（预览窗里 code / text / markdown 源码 / csv 源码 / svg 源码 / json 源码共用）
 *
 * 查看态：按行虚拟列表（react-virtuoso）——行号、语法着色（Prism token → React，不拼 HTML）、
 *   自动换行开关、⌘F / Ctrl+F 查找（命中高亮 + 上一个 / 下一个；输入 `:123` 回车跳到第 123 行）、
 *   `line` 参数定位并高亮、日志按级别着色并默认停在末尾、复制全文。
 * 编辑态：react-simple-code-editor（textarea + Prism 叠层），Tab 缩进、⌘S / Ctrl+S 保存、
 *   状态栏显示行列与「未保存」；保存走 write-local-file（mtime 冲突检测 + 原子写，见 lib/server/local-file-write）。
 *
 * 编辑的边界（服务端 / read-local-file 已判好，这里只管呈现）：editable=false 时「编辑」按钮置灰并用 Tooltip 说明原因。
 * 保存时 BOM / 换行风格原样带回；冲突时让用户选「覆盖 / 放弃我的修改并重新加载」，绝不悄悄覆盖。
 */

import {
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import Editor from "react-simple-code-editor";
import { highlight } from "prismjs";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import {
  ArrowDownToLine,
  ArrowUpToLine,
  Copy,
  Lock,
  Pencil,
  Save,
  Search,
  Undo2,
  WrapText,
} from "lucide-react";
import { toast } from "sonner";

import {
  Dot,
  FindBar,
  PreviewToolbar,
  TextButton,
  ToolButton,
  useCopyText,
} from "@/components/preview/preview-ui";
import { usePersistedBoolean } from "@/components/preview/use-persisted";
import { Tooltip } from "@/components/ui/tooltip";
import { useDialog } from "@/hooks/use-dialog";
import { useShellPlatform } from "@/hooks/use-shell-platform";
import { getModShortcutLabel, isModCombo } from "@/lib/keyboard-shortcuts";
import {
  EDIT_HIGHLIGHT_MAX_CHARS,
  findMatches,
  HIGHLIGHT_MAX_CHARS,
  markSegments,
  splitLines,
  tokenizeToLines,
  type MarkedSegment,
  type Segment,
} from "@/lib/preview/code-lines";
import { formatBytes, formatCount } from "@/lib/preview/format";
import { classifyLogLines, type LogLevel } from "@/lib/preview/log-level";
import { grammarForExt } from "@/lib/preview/prism-grammars";
import type { TextEol } from "@/lib/preview/types";
import { cn } from "@/lib/utils";

const MONO_FONT = "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";
const LINE_HEIGHT_PX = 20;

const LEVEL_CLASS: Record<LogLevel, string> = {
  error: "text-destructive",
  warn: "text-warning",
  info: "",
  debug: "text-muted-foreground",
};

const escapeHtml = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

interface LineRange {
  start: number;
  end: number;
  active: boolean;
}

const CodeLine = memo(function CodeLine({
  index,
  segments,
  ranges,
  flash,
  levelClass,
  wrap,
  gutterCh,
}: {
  index: number;
  segments: readonly Segment[];
  ranges: readonly LineRange[] | undefined;
  flash: boolean;
  levelClass: string;
  wrap: boolean;
  gutterCh: number;
}) {
  const marked: readonly MarkedSegment[] = ranges && ranges.length > 0 ? markSegments(segments, ranges) : segments;
  return (
    <div className={cn("flex font-mono text-xs", flash && "bg-warning/10", levelClass)} style={{ minHeight: LINE_HEIGHT_PX, lineHeight: `${LINE_HEIGHT_PX}px` }}>
      <span
        aria-hidden
        className={cn(
          "sticky left-0 z-[1] shrink-0 select-none pr-3 text-right text-muted-foreground",
          flash ? "bg-warning/10" : "bg-background",
        )}
        style={{ width: `${gutterCh}ch`, boxSizing: "content-box" }}
      >
        {index + 1}
      </span>
      <span className={cn("min-w-0 flex-1 pr-4", wrap ? "break-words whitespace-pre-wrap" : "whitespace-pre")}>
        {marked.map((s, i) => {
          const inner = (
            <span key={i} className={s.type ? `token ${s.type}` : undefined}>
              {s.text}
            </span>
          );
          const mark = s.mark;
          return mark ? (
            <mark
              key={i}
              data-active={mark === "active" ? "" : undefined}
              className={cn("rounded-[2px] text-inherit", mark === "active" ? "bg-warning/55" : "bg-warning/25")}
            >
              {inner}
            </mark>
          ) : (
            inner
          );
        })}
      </span>
    </div>
  );
});

export interface CodeViewerProps {
  path: string;
  ext: string;
  text: string;
  size: number;
  truncated?: boolean;
  /** 只读了文件末尾（日志） */
  tail?: boolean;
  mtimeMs: number;
  eol: TextEol;
  bom: boolean;
  editable: boolean;
  editBlockedReason?: string;
  /** 打开时定位并高亮的行（1 起） */
  line?: number;
  /** 外壳「重新加载」时递增：丢弃未保存草稿，重置为新载入的内容 */
  resetKey: number;
  onDirtyChange: (dirty: boolean) => void;
  /** 保存成功：外壳据此原子地更新 text / mtime / size（不能只更新 mtime，否则本组件会把草稿回退到旧文本），再静默刷新其它页签的数据 */
  onSaved: (r: { text: string; mtimeMs: number; size: number }) => void;
  /** 冲突时用户选「放弃我的修改并重新加载」 */
  onRequestReload: () => void;
  /** 放在工具栏最左侧的内容（视图页签） */
  leading?: ReactNode;
}

const eolLabel = (eol: TextEol): string => (eol === "crlf" ? "CRLF" : eol === "mixed" ? "混合换行" : "LF");

export const CodeViewer = ({
  path,
  ext,
  text,
  size,
  truncated,
  tail,
  mtimeMs,
  eol,
  bom,
  editable,
  editBlockedReason,
  line,
  resetKey,
  onDirtyChange,
  onSaved,
  onRequestReload,
  leading,
}: CodeViewerProps) => {
  const { confirm } = useDialog();
  const copyText = useCopyText();
  const platform = useShellPlatform();
  const editorId = useId();

  const [mode, setMode] = useState<"view" | "edit">("view");
  const [wrap, setWrap] = usePersistedBoolean("flowship.preview.wrap", false);

  // ── 编辑缓冲：baseline = 最近一次已知的磁盘内容；draft = 正在编辑的内容 ──
  const [baseline, setBaseline] = useState(text);
  const [baselineMtime, setBaselineMtime] = useState(mtimeMs);
  const [draft, setDraft] = useState(text);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState<{ currentMtimeMs: number } | null>(null);
  const [caret, setCaret] = useState({ line: 1, col: 1 });

  const baselineRef = useRef(baseline);
  baselineRef.current = baseline;
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const lastReset = useRef(resetKey);

  // 新数据到达（外壳重新加载 / 保存后的静默刷新）：
  // - 草稿没改过，或用户明确选了「放弃修改并重新加载」→ 基准和草稿都换成磁盘上的新内容；
  // - 有未保存的修改 → 基准（含 mtime）一动不动。不能把新的 mtime 收进来：那样「保存后 100ms 内 agent 又改了文件、
  //   用户还在继续打字」时，下一次保存会拿着新 mtime 通过冲突检测，悄悄覆盖掉 agent 的改动；mtime 不动，下一次保存才会 409 拦住。
  useEffect(() => {
    const reset = lastReset.current !== resetKey;
    lastReset.current = resetKey;
    const clean = draftRef.current === baselineRef.current;
    if (!reset && !clean) return;
    setBaseline(text);
    setBaselineMtime(mtimeMs);
    setDraft(text);
    if (reset) setConflict(null);
  }, [text, mtimeMs, resetKey]);

  const dirty = mode === "edit" && draft !== baseline;
  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  // ── 查看态数据 ──
  const grammar = useMemo(() => grammarForExt(ext), [ext]);
  const highlightOn = grammar !== null && text.length <= HIGHLIGHT_MAX_CHARS;
  const segmentLines = useMemo(
    () => tokenizeToLines(text, highlightOn ? grammar!.grammar : null),
    [text, grammar, highlightOn],
  );
  const plainLines = useMemo(() => splitLines(text), [text]);
  const levels = useMemo(
    () => (ext === "log" ? classifyLogLines(plainLines) : null),
    [ext, plainLines],
  );
  const gutterCh = Math.max(3, String(plainLines.length).length) + 1;

  // ── 查找 / 跳行 ──
  const listRef = useRef<VirtuosoHandle>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const findInputRef = useRef<HTMLInputElement>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [active, setActive] = useState(0);
  const [flashLine, setFlashLine] = useState<number | null>(line != null ? line - 1 : null);
  const deferredQuery = useDeferredValue(query);

  const gotoMatch = /^:(\d+)$/.exec(query.trim());
  const gotoLine = gotoMatch ? Number(gotoMatch[1]) : null;
  const found = useMemo(
    () =>
      /^:\d+$/.test(deferredQuery.trim())
        ? { matches: [], capped: false }
        : findMatches(plainLines, deferredQuery, caseSensitive),
    [plainLines, deferredQuery, caseSensitive],
  );
  const matches = found.matches;
  const activeIdx = matches.length === 0 ? 0 : Math.min(active, matches.length - 1);

  const rangesByLine = useMemo(() => {
    const m = new Map<number, LineRange[]>();
    matches.forEach((mt, i) => {
      const arr = m.get(mt.line) ?? [];
      arr.push({ start: mt.start, end: mt.end, active: i === activeIdx });
      m.set(mt.line, arr);
    });
    return m;
  }, [matches, activeIdx]);

  useEffect(() => setActive(0), [deferredQuery, caseSensitive]);

  useEffect(() => {
    const m = matches[activeIdx];
    if (m) listRef.current?.scrollToIndex({ index: m.line, align: "center" });
  }, [matches, activeIdx]);

  const openFind = useCallback(() => {
    setFindOpen(true);
    requestAnimationFrame(() => {
      findInputRef.current?.focus();
      findInputRef.current?.select();
    });
  }, []);
  const closeFind = useCallback(() => {
    setFindOpen(false);
    setQuery("");
    rootRef.current?.focus({ preventScroll: true });
  }, []);

  const jumpToLine = useCallback(
    (n: number) => {
      const idx = Math.min(Math.max(n, 1), plainLines.length) - 1;
      setFlashLine(idx);
      listRef.current?.scrollToIndex({ index: idx, align: "center" });
    },
    [plainLines.length],
  );

  // 窗口已经开着时又从别处点了同一文件的另一行：跳过去（首次挂载由 initialTopMostItemIndex 负责）。
  // 只在 line 的值真的变了才跳：文件被实时刷新时 jumpToLine 的身份会变（行数变了），不能每次都把用户拽回原来那一行
  const prevLine = useRef(line);
  useEffect(() => {
    if (prevLine.current === line) return;
    prevLine.current = line;
    if (line != null) jumpToLine(line);
  }, [line, jumpToLine]);

  const step = useCallback(
    (delta: 1 | -1) => {
      if (gotoLine !== null) {
        jumpToLine(gotoLine);
        return;
      }
      if (matches.length === 0) return;
      setActive((a) => (Math.min(a, matches.length - 1) + delta + matches.length) % matches.length);
    },
    [gotoLine, jumpToLine, matches.length],
  );

  // 打开窗口就聚焦根节点：⌘F / ⌘S 不用先点一下才生效
  useEffect(() => {
    rootRef.current?.focus({ preventScroll: true });
  }, []);

  // ── 编辑 / 保存 ──
  const startEdit = () => {
    setMode("edit");
    setFindOpen(false);
    requestAnimationFrame(() => document.getElementById(editorId)?.focus());
  };

  const save = useCallback(
    async (force = false) => {
      if (saving) return;
      const snapshot = draft;
      if (snapshot === baseline && !force) return;
      setSaving(true);
      try {
        const res = await fetch("/api/system/write-local-file", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            path,
            content: snapshot,
            eol: eol === "crlf" ? "crlf" : "lf",
            bom,
            expectedMtimeMs: baselineMtime,
            force,
          }),
        });
        const json = (await res.json().catch(() => null)) as
          | { mtimeMs?: number; size?: number; error?: string; currentMtimeMs?: number }
          | null;
        if (res.ok && json?.mtimeMs != null) {
          setBaseline(snapshot);
          setBaselineMtime(json.mtimeMs);
          setConflict(null);
          toast.success("已保存");
          onSaved({ text: snapshot, mtimeMs: json.mtimeMs, size: json.size ?? snapshot.length });
        } else if (res.status === 409) {
          setConflict({ currentMtimeMs: json?.currentMtimeMs ?? 0 });
        } else {
          toast.error(json?.error ?? `保存失败（HTTP ${res.status}）`);
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "保存失败");
      } finally {
        setSaving(false);
      }
    },
    [saving, draft, baseline, baselineMtime, path, eol, bom, onSaved],
  );

  const revert = async () => {
    if (draft !== baseline) {
      const ok = await confirm({
        title: "放弃未保存的修改？",
        description: "编辑区会恢复成上次保存（或载入）时的内容。",
        confirmLabel: "放弃修改",
        destructive: true,
        defaultFocus: "cancel",
      });
      if (!ok) return;
    }
    setDraft(baseline);
    setConflict(null);
  };

  const finishEdit = async () => {
    if (draft !== baseline) {
      const ok = await confirm({
        title: "退出编辑？",
        description: "有未保存的修改，退出后会丢失。",
        confirmLabel: "放弃修改并退出",
        destructive: true,
        defaultFocus: "cancel",
      });
      if (!ok) return;
    }
    setDraft(baseline);
    setConflict(null);
    setMode("view");
  };

  const updateCaret = (e: React.SyntheticEvent) => {
    // react-simple-code-editor 把这些事件挂在内部 textarea 上（类型声明却写成 div & textarea），所以取 target
    const ta = e.target as HTMLTextAreaElement;
    if (typeof ta.selectionStart !== "number") return;
    const before = ta.value.slice(0, ta.selectionStart);
    const nl = before.lastIndexOf("\n");
    setCaret({ line: before.split("\n").length, col: before.length - nl });
  };

  const onRootKeyDown = (e: React.KeyboardEvent) => {
    // 与全站同口径：mac 只认 ⌘（Ctrl+F / Ctrl+S 在 mac 文本框里是 Emacs 光标键），其它平台认 Ctrl
    if (isModCombo(e, "s") && mode === "edit") {
      e.preventDefault();
      void save();
    } else if (isModCombo(e, "f") && mode === "view") {
      e.preventDefault();
      openFind();
    }
  };

  const editorHighlight = useCallback(
    (code: string) =>
      grammar && code.length <= EDIT_HIGHLIGHT_MAX_CHARS
        ? highlight(code, grammar.grammar, grammar.id)
        : escapeHtml(code),
    [grammar],
  );

  const copyAll = () => void copyText(mode === "edit" ? draft : text, truncated ? "已载入的内容" : "全文");

  const initialIndex = line != null ? { index: Math.max(0, line - 1), align: "center" as const } : tail ? { index: "LAST" as const, align: "end" as const } : 0;

  const lineCount = mode === "edit" ? draft.split("\n").length : plainLines.length;

  return (
    <div ref={rootRef} tabIndex={-1} onKeyDown={onRootKeyDown} className="flex h-full min-h-0 flex-col outline-none">
      <PreviewToolbar
        left={
          <>
            {leading}
            {mode === "edit" ? (
              <>
                <span className="font-medium text-foreground">编辑中</span>
                {dirty ? <span className="text-warning">● 未保存</span> : <span>已同步</span>}
                <Dot />
                <span className="tabular-nums">第 {caret.line} 行，第 {caret.col} 列</span>
              </>
            ) : (
              <>
                <span className="tabular-nums">{formatCount(lineCount)} 行</span>
                <Dot />
                <span>{formatBytes(size)}</span>
                <Dot />
                <span>{eolLabel(eol)} · UTF-8{bom ? " BOM" : ""}</span>
                {!highlightOn && grammar && <><Dot /><span>文件较大，已关闭语法着色</span></>}
              </>
            )}
          </>
        }
        right={
          mode === "edit" ? (
            <>
              <ToolButton label="复制" onClick={copyAll}>
                <Copy />
              </ToolButton>
              <TextButton onClick={() => void revert()} disabled={!dirty || saving}>
                <Undo2 className="size-3" />
                放弃
              </TextButton>
              <TextButton variant="default" onClick={() => void save()} disabled={!dirty || saving}>
                <Save className="size-3" />
                {saving ? "保存中…" : "保存"}
              </TextButton>
              <TextButton onClick={() => void finishEdit()} disabled={saving}>
                完成
              </TextButton>
            </>
          ) : (
            <>
              <ToolButton label="查找" shortcut={getModShortcutLabel(platform, "F")} onClick={openFind} active={findOpen}>
                <Search />
              </ToolButton>
              <ToolButton label="到顶部" onClick={() => listRef.current?.scrollToIndex({ index: 0, align: "start" })}>
                <ArrowUpToLine />
              </ToolButton>
              <ToolButton label="到底部" onClick={() => listRef.current?.scrollToIndex({ index: "LAST", align: "end" })}>
                <ArrowDownToLine />
              </ToolButton>
              <ToolButton label="自动换行" onClick={() => setWrap(!wrap)} active={wrap}>
                <WrapText />
              </ToolButton>
              <ToolButton label={truncated ? "复制已载入的内容" : "复制全文"} onClick={copyAll}>
                <Copy />
              </ToolButton>
              {editable ? (
                <TextButton onClick={startEdit}>
                  <Pencil className="size-3" />
                  编辑
                </TextButton>
              ) : (
                <Tooltip content={editBlockedReason ?? "这个文件不能在这里编辑"}>
                  <span className="inline-flex h-6 cursor-not-allowed items-center gap-1 px-2 text-xs text-muted-foreground">
                    <Lock className="size-3" />
                    只读
                  </span>
                </Tooltip>
              )}
            </>
          )
        }
      />

      {findOpen && mode === "view" && (
        <FindBar
          value={query}
          onChange={setQuery}
          inputRef={findInputRef}
          placeholder="查找，或输入 :行号 跳转"
          current={activeIdx + 1}
          total={gotoLine !== null ? null : matches.length}
          capped={found.capped}
          caseSensitive={caseSensitive}
          onToggleCase={() => setCaseSensitive((v) => !v)}
          onNext={() => step(1)}
          onPrev={() => step(-1)}
          onClose={closeFind}
          hint={gotoLine !== null ? `回车跳到第 ${gotoLine} 行` : undefined}
        />
      )}

      {conflict && (
        <div role="alert" className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-warning/40 bg-warning/10 px-3 py-1.5 text-xs text-foreground">
          <span>文件在你编辑期间被修改过（可能是 agent 或其它编辑器）。直接保存会覆盖对方的改动。</span>
          <span className="ml-auto flex items-center gap-1">
            <TextButton variant="destructive" onClick={() => void save(true)} disabled={saving}>
              覆盖保存
            </TextButton>
            <TextButton onClick={onRequestReload}>放弃我的修改并重新加载</TextButton>
            <TextButton onClick={() => setConflict(null)}>稍后处理</TextButton>
          </span>
        </div>
      )}

      <div className="min-h-0 flex-1">
        {mode === "edit" ? (
          <div className="h-full overflow-auto bg-background">
            <Editor
              textareaId={editorId}
              value={draft}
              onValueChange={setDraft}
              highlight={editorHighlight}
              padding={12}
              tabSize={ext === "makefile" || ext === "go" ? 4 : 2}
              insertSpaces={ext !== "makefile" && ext !== "go"}
              textareaClassName="focus:outline-none"
              onKeyUp={updateCaret}
              onClick={updateCaret}
              onFocus={updateCaret}
              style={{ fontFamily: MONO_FONT, fontSize: 12, lineHeight: `${LINE_HEIGHT_PX}px`, minHeight: "100%" }}
            />
          </div>
        ) : (
          <Virtuoso
            key={wrap ? "wrap" : "nowrap"}
            ref={listRef}
            style={{ height: "100%" }}
            totalCount={segmentLines.length}
            fixedItemHeight={wrap ? undefined : LINE_HEIGHT_PX}
            initialTopMostItemIndex={initialIndex}
            // 日志：停在底部时新追加的行自动跟上（实时刷新时像 tail -f）；往上翻看历史时不抢滚动位置
            followOutput={ext === "log" ? "auto" : false}
            increaseViewportBy={{ top: 300, bottom: 600 }}
            itemContent={(index) => (
              <CodeLine
                index={index}
                segments={segmentLines[index] ?? []}
                ranges={rangesByLine.get(index)}
                flash={flashLine === index}
                levelClass={levels?.[index] ? LEVEL_CLASS[levels[index]!] : ""}
                wrap={wrap}
                gutterCh={gutterCh}
              />
            )}
          />
        )}
      </div>

      {truncated && (
        <p className="shrink-0 border-t border-border/70 bg-muted/20 px-3 py-1.5 text-xs text-warning">
          {tail ? "文件较大，只显示了末尾部分；完整内容请在文件夹中打开查看" : "文件较大，只显示了前面一部分；完整内容请用 IDE 打开"}
        </p>
      )}
    </div>
  );
};
