"use client";

/**
 * Markdown 查看器：预览 / 源码
 *
 * 预览 = MarkdownText(document)（图片闸门、本地路径链接、代码高亮、mermaid 都沿用）+ 文档外框（页内查找 / 目录）；
 * 开头的 front matter（skills / plan 文件到处都是）拆出来显示成「属性」表，不再渲染成一条横线加乱码。
 * 源码 = CodeViewer（带编辑）：改完保存，预览自动跟着变。
 */

import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

import { CodeViewer, type CodeViewerProps } from "@/components/preview/code-viewer";
import { DocumentPane } from "@/components/preview/document-pane";
import { SegmentedTabs } from "@/components/preview/preview-ui";
import { useGuardedTab } from "@/components/preview/use-guarded-tab";
import { MarkdownText } from "@/components/markdown-text";
import { splitFrontMatter } from "@/lib/preview/front-matter";

const FrontMatterCard = ({ entries }: { entries: { key: string; value: string }[] }) => {
  const [open, setOpen] = useState(true);
  return (
    <div className="mb-4 rounded-md border border-border/70 bg-muted/20 text-xs">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1 px-3 py-1.5 text-left font-medium text-muted-foreground hover:text-foreground"
      >
        {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        属性（{entries.length}）
      </button>
      {open && (
        <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1 border-t border-border/70 px-3 py-2">
          {entries.map((e, i) => (
            <div key={`${e.key}:${i}`} className="contents">
              <dt className="font-mono text-muted-foreground">{e.key}</dt>
              <dd className="min-w-0 break-words whitespace-pre-wrap">{e.value || "—"}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
};

export const MarkdownViewer = (props: CodeViewerProps) => {
  const { text, onDirtyChange } = props;
  const { tab, switchTab, handleDirty } = useGuardedTab<"preview" | "source">("preview", onDirtyChange);
  const split = useMemo(() => splitFrontMatter(text), [text]);

  const tabs = (
    <SegmentedTabs
      tabs={[
        { id: "preview" as const, label: "预览" },
        { id: "source" as const, label: "源码" },
      ]}
      value={tab}
      onChange={switchTab}
    />
  );

  if (tab === "source") {
    return <CodeViewer {...props} onDirtyChange={handleDirty} leading={tabs} />;
  }
  return (
    <DocumentPane leading={tabs} contentKey={text}>
      {split.entries && <FrontMatterCard entries={split.entries} />}
      <MarkdownText text={split.body} variant="document" />
      {props.truncated && <p className="mt-3 text-xs text-warning">文件较大，只显示了前面一部分；完整内容请用 IDE 打开</p>}
    </DocumentPane>
  );
};
