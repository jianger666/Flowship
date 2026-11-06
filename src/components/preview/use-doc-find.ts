"use client";

/**
 * 渲染后文档（markdown 预览 / docx）的页内查找：CSS Custom Highlight API
 *
 * 命中用 Range 登记到 CSS.highlights（浏览器直接在文字上画高亮，不改 DOM、不影响 React 渲染的节点）；
 * 样式在 globals.css 的 ::highlight(preview-find / preview-find-active)。
 * Chromium 105+（Electron 现役版本都满足）。不支持的环境 supported=false，调用方就不显示查找入口。
 */

import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type RefObject } from "react";

import { locateMatches } from "@/lib/preview/text-locate";

const HIT = "preview-find";
const ACTIVE = "preview-find-active";

const supportsHighlight = (): boolean =>
  typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight !== "undefined";

const clearHighlights = () => {
  if (!supportsHighlight()) return;
  CSS.highlights.delete(HIT);
  CSS.highlights.delete(ACTIVE);
};

export interface DocFind {
  supported: boolean;
  open: boolean;
  setOpen: (v: boolean) => void;
  query: string;
  setQuery: (v: string) => void;
  caseSensitive: boolean;
  toggleCase: () => void;
  current: number;
  total: number;
  capped: boolean;
  next: () => void;
  prev: () => void;
  close: () => void;
}

/** contentKey 变化（文档内容换了）时重新搜 */
export const useDocFind = (containerRef: RefObject<HTMLElement | null>, contentKey: unknown): DocFind => {
  const [supported] = useState(supportsHighlight);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const deferred = useDeferredValue(query);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [active, setActive] = useState(0);
  const [ranges, setRanges] = useState<Range[]>([]);
  const [capped, setCapped] = useState(false);
  const rangesRef = useRef<Range[]>([]);
  rangesRef.current = ranges;

  // 收集命中
  useEffect(() => {
    const root = containerRef.current;
    if (!supported || !open || !root || !deferred) {
      setRanges([]);
      setCapped(false);
      return;
    }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => {
        const tag = n.parentElement?.tagName;
        return tag === "SCRIPT" || tag === "STYLE" ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
      },
    });
    const nodes: Text[] = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as Text);
    const { matches, capped: c } = locateMatches(
      nodes.map((n) => n.data),
      deferred,
      caseSensitive,
    );
    const rs = matches.map((m) => {
      const r = document.createRange();
      r.setStart(nodes[m.startNode]!, m.startOffset);
      r.setEnd(nodes[m.endNode]!, m.endOffset);
      return r;
    });
    setRanges(rs);
    setCapped(c);
    setActive(0);
  }, [supported, open, deferred, caseSensitive, containerRef, contentKey]);

  const activeIdx = ranges.length === 0 ? 0 : Math.min(active, ranges.length - 1);

  // 画高亮 + 滚到当前
  useEffect(() => {
    if (!supported) return;
    if (ranges.length === 0) {
      clearHighlights();
      return;
    }
    CSS.highlights.set(HIT, new Highlight(...ranges));
    const cur = ranges[activeIdx]!;
    CSS.highlights.set(ACTIVE, new Highlight(cur));
    const el = cur.startContainer.parentElement;
    el?.scrollIntoView({ block: "center", inline: "nearest" });
  }, [supported, ranges, activeIdx]);

  // 卸载时清掉（高亮登记在全局 CSS.highlights 上，不清会残留到下一个文件）
  useEffect(() => clearHighlights, []);

  const step = useCallback((delta: 1 | -1) => {
    const n = rangesRef.current.length;
    if (n === 0) return;
    setActive((a) => (Math.min(a, n - 1) + delta + n) % n);
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
    clearHighlights();
  }, []);

  return useMemo(
    () => ({
      supported,
      open,
      setOpen,
      query,
      setQuery,
      caseSensitive,
      toggleCase: () => setCaseSensitive((v) => !v),
      current: activeIdx + 1,
      total: ranges.length,
      capped,
      next: () => step(1),
      prev: () => step(-1),
      close,
    }),
    [supported, open, query, caseSensitive, activeIdx, ranges.length, capped, step, close],
  );
};
