"use client";

/**
 * 带 Prism 语法高亮的代码编辑器（基于 react-simple-code-editor）
 *
 * - 用 textarea + 透明 overlay + prism 实时 highlight、自带 tab 处理
 * - 语言通过 language prop 指定（目前只接 json、想加再 import 对应 prism 语言包）
 * - 样式跟 shadcn Textarea 对齐（border / radius / focus ring）、便于无缝替换
 * - 暗色 token 颜色统一放 globals.css（@layer base 里的 .prism-*）、和主题挂钩
 */

import { useId } from "react";
import Editor from "react-simple-code-editor";
import { highlight, languages } from "prismjs";
import "prismjs/components/prism-json";
import "prismjs/components/prism-markdown";

import { cn } from "@/lib/utils";

interface CodeEditorProps {
  value: string;
  onChange: (next: string) => void;
  // 想加新语言要先 import 对应 prism 语言包
  language?: "json" | "markdown";
  placeholder?: string;
  rows?: number;
  className?: string;
  ariaInvalid?: boolean;
  id?: string;
  // disabled 时禁掉编辑、视觉上压暗
  disabled?: boolean;
}

export const CodeEditor = ({
  value,
  onChange,
  language = "json",
  placeholder,
  rows = 14,
  className,
  ariaInvalid,
  id,
  disabled,
}: CodeEditorProps) => {
  // useId 兜底、调用方不传 id 也能给 textarea 一个稳定 id（避免 SSR/CSR 不一致）
  const fallbackId = useId();
  const inputId = id ?? fallbackId;

  // 大致行高 = 16px、用 rows 算个最小高度避免编辑器塌成一行
  const minHeight = `${rows * 1.5}rem`;

  return (
    <div
      className={cn(
        // 模仿 shadcn Textarea：border / 圆角 / focus-within ring / bg
        "rounded-md border bg-transparent shadow-xs",
        "focus-within:border-ring focus-within:ring-ring/50 focus-within:ring-[3px]",
        ariaInvalid && "border-destructive ring-destructive/20",
        disabled && "opacity-50 cursor-not-allowed",
        // 让编辑器内部滚动而不是撑爆 Card
        "overflow-auto",
        className
      )}
      style={{ minHeight }}
    >
      <Editor
        textareaId={inputId}
        value={value}
        onValueChange={(next) => !disabled && onChange(next)}
        highlight={(code) => {
          // prism 没注册该语言时退回纯文本、避免抛错
          const grammar = languages[language];
          return grammar ? highlight(code, grammar, language) : escapeHtml(code);
        }}
        placeholder={placeholder}
        padding={12}
        textareaClassName="focus:outline-none"
        // react-simple-code-editor 把 style 直接传给外层 <div>
        style={{
          fontFamily:
            "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
          fontSize: 12,
          lineHeight: 1.5,
          minHeight,
        }}
      />
    </div>
  );
};

// 万一 grammar 没加载、避免直接把 raw code 当 HTML 注入引入 XSS 风险
const escapeHtml = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
