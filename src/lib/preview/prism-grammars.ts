/**
 * 文件预览 / 编辑器用的 Prism 语法注册（扩展名 → 语法）
 *
 * 为什么是 Prism 而不是预览以前用的 Shiki（Streamdown 内置）：
 * - 编辑器（react-simple-code-editor）本来就是 Prism，查看与编辑两态用同一套着色，切换时不会「换了件衣服」；
 * - Prism 直接给 token 树，行号 / 搜索高亮可以在 token 上做，不用解析 Shiki 输出的 HTML；
 * - 只在预览窗首次打开时随 local-file-preview-body 一起 dynamic 加载，不进每个页面的首包。
 *
 * 颜色在 globals.css（`.token.*` 一套，亮 / 暗主题已适配），这里只管「哪个扩展名用哪个语法」。
 * 语法包有依赖顺序（tsx 依赖 jsx + typescript，cpp 依赖 c，php 依赖 markup-templating……），别随意调换 import 顺序。
 */

import { languages, type Grammar } from "prismjs";
import "prismjs/components/prism-typescript";
import "prismjs/components/prism-jsx";
import "prismjs/components/prism-tsx";
import "prismjs/components/prism-scss";
import "prismjs/components/prism-less";
import "prismjs/components/prism-markup-templating";
import "prismjs/components/prism-php";
import "prismjs/components/prism-java";
import "prismjs/components/prism-kotlin";
import "prismjs/components/prism-go";
import "prismjs/components/prism-rust";
import "prismjs/components/prism-ruby";
import "prismjs/components/prism-swift";
import "prismjs/components/prism-c";
import "prismjs/components/prism-cpp";
import "prismjs/components/prism-csharp";
import "prismjs/components/prism-python";
import "prismjs/components/prism-bash";
import "prismjs/components/prism-yaml";
import "prismjs/components/prism-toml";
import "prismjs/components/prism-sql";
import "prismjs/components/prism-graphql";
import "prismjs/components/prism-docker";
import "prismjs/components/prism-makefile";
import "prismjs/components/prism-ini";
import "prismjs/components/prism-json";
import "prismjs/components/prism-markdown";
import "prismjs/components/prism-diff";

/** 扩展名（小写，不带点）→ Prism 语法 id */
const EXT_TO_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  py: "python",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  css: "css",
  scss: "scss",
  less: "less",
  html: "markup",
  htm: "markup",
  xml: "markup",
  svg: "markup",
  vue: "markup",
  svelte: "markup",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  md: "markdown",
  mdx: "markdown",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  go: "go",
  rs: "rust",
  rb: "ruby",
  php: "php",
  swift: "swift",
  c: "c",
  h: "c",
  cpp: "cpp",
  hpp: "cpp",
  cs: "csharp",
  sql: "sql",
  graphql: "graphql",
  dockerfile: "docker",
  makefile: "makefile",
  ini: "ini",
  cfg: "ini",
  conf: "ini",
  env: "ini",
  diff: "diff",
  patch: "diff",
};

export interface ResolvedGrammar {
  id: string;
  grammar: Grammar;
}

/** 扩展名没有对应语法（txt / log / csv…）时返回 null，调用方按纯文本渲染 */
export const grammarForExt = (ext: string): ResolvedGrammar | null => {
  const id = EXT_TO_LANG[ext.toLowerCase().replace(/^\./, "")];
  if (!id) return null;
  const grammar = languages[id];
  return grammar ? { id, grammar } : null;
};
