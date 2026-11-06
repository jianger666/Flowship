"use client";

import { CodeViewer, type CodeViewerProps } from "@/components/preview/code-viewer";
import { SegmentedTabs } from "@/components/preview/preview-ui";
import { TableViewer } from "@/components/preview/table-viewer";
import { useGuardedTab } from "@/components/preview/use-guarded-tab";
import type { PreviewTable } from "@/lib/preview/types";

/** csv / tsv：表格 / 源码。表格是只读视图；要改数据在源码页签里改（保存后表格自动刷新）。 */
export const CsvViewer = (props: CodeViewerProps & { table?: PreviewTable }) => {
  const { table, onDirtyChange, ...codeProps } = props;
  const { tab, switchTab, handleDirty } = useGuardedTab<"table" | "source">(table ? "table" : "source", onDirtyChange);
  const effective = table ? tab : "source";

  const tabs = table ? (
    <SegmentedTabs
      tabs={[
        { id: "table" as const, label: "表格" },
        { id: "source" as const, label: "源码" },
      ]}
      value={effective}
      onChange={switchTab}
    />
  ) : (
    <span className="text-warning">文件较大，只提供源码视图</span>
  );

  if (effective === "table" && table) return <TableViewer table={table} leading={tabs} />;
  return <CodeViewer {...codeProps} onDirtyChange={handleDirty} leading={tabs} />;
};
