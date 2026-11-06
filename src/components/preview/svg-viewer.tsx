"use client";

import { useEffect, useState } from "react";

import { CodeViewer, type CodeViewerProps } from "@/components/preview/code-viewer";
import { ImageViewer } from "@/components/preview/image-viewer";
import { SegmentedTabs } from "@/components/preview/preview-ui";
import { useGuardedTab } from "@/components/preview/use-guarded-tab";
import { pathBasename } from "@/lib/path-utils";

/**
 * SVG：图像 / 源码。图像页签把文本变成 blob URL 交给 <img>——<img> 里的 SVG 不执行脚本、不加载外部资源，
 * 所以不需要净化；绝不能换成 dangerouslySetInnerHTML / iframe / object。
 */
export const SvgViewer = (props: CodeViewerProps) => {
  const { text, truncated, onDirtyChange } = props;
  const renderable = !truncated && text.trim() !== "";
  const { tab, switchTab, handleDirty } = useGuardedTab<"image" | "source">(renderable ? "image" : "source", onDirtyChange);
  const effective = renderable ? tab : "source";

  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!renderable) return;
    const u = URL.createObjectURL(new Blob([text], { type: "image/svg+xml" }));
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [renderable, text]);

  const tabs = renderable ? (
    <SegmentedTabs
      tabs={[
        { id: "image" as const, label: "图像" },
        { id: "source" as const, label: "源码" },
      ]}
      value={effective}
      onChange={switchTab}
    />
  ) : (
    <span className="text-warning">文件较大或为空，只提供源码视图</span>
  );

  if (effective === "image") {
    // url 在 effect 里生成：首帧先占位，别闪一下源码视图
    return url ? <ImageViewer src={url} alt={pathBasename(props.path)} size={props.size} leading={tabs} /> : <div className="h-full" />;
  }
  return <CodeViewer {...props} onDirtyChange={handleDirty} leading={tabs} />;
};
