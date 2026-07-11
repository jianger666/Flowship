/**
 * remark 插件：识别 Cursor「代码引用」围栏（v1.0、修高亮）
 *
 * 背景：AI（尤其 chat 模式引用现有代码时）常输出
 * ```12:34:src/pages/foo/bar.tsx
 * ...代码...
 * ```
 * fence 的 info token 是「起始行:结束行:文件路径」、不是合法语言名 → Shiki 认不出、
 * 整块退化成灰色纯文本（用户实测「代码块没有高亮」的主因之一）。
 *
 * 处理：
 * 1. lang 重写为按文件后缀推断的语言（tsx / python / ...）→ Shiki 正常高亮
 * 2. 代码块前插入一行 inlineCode 小字「路径 · L12-34」→ 出处不丢（原来靠 header 显示 info 串）
 *
 * 跟 remark-trim-autolink-cjk 同一套自描述最小类型 + 手写 mdast 遍历（不引 mdast 类型包）。
 */

interface MdNode {
  type: string;
  lang?: string | null;
  meta?: string | null;
  value?: string;
  children?: MdNode[];
}

// 起始行:结束行:文件路径（路径里可以有空格——info 串整体匹配）
const REF_RE = /^(\d+):(\d+):(.+)$/;

// 文件后缀 → Shiki 语言 id（覆盖本项目 + 常见业务仓会出现的）
const EXT_LANG: Record<string, string> = {
  ts: "ts",
  tsx: "tsx",
  js: "js",
  jsx: "jsx",
  mjs: "js",
  cjs: "js",
  vue: "vue",
  svelte: "svelte",
  py: "python",
  rb: "ruby",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  m: "objective-c",
  mm: "objective-c",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  css: "css",
  scss: "scss",
  less: "less",
  html: "html",
  json: "json",
  jsonc: "jsonc",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  md: "markdown",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  sql: "sql",
  xml: "xml",
  gradle: "groovy",
  proto: "proto",
};

const langFromPath = (filepath: string): string => {
  const base = filepath.split(/[\\/]/).pop() ?? "";
  const ext = base.includes(".") ? base.split(".").pop()!.toLowerCase() : "";
  return EXT_LANG[ext] ?? "text";
};

export const remarkCodeReference = () => (tree: MdNode) => {
  const walk = (node: MdNode) => {
    const children = node.children;
    if (!children) return;
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (child.type === "code" && child.lang) {
        // mdast 会把 info 串按第一个空格切成 lang + meta、路径带空格时要拼回去整体匹配
        const info = child.meta ? `${child.lang} ${child.meta}` : child.lang;
        const m = REF_RE.exec(info);
        if (m) {
          const [, startLine, endLine, filepath] = m;
          child.lang = langFromPath(filepath);
          child.meta = null;
          // 出处行：紧贴代码块上方的小字 inlineCode（prose 窄间距、视觉是代码块的「标题」）
          children.splice(i, 0, {
            type: "paragraph",
            children: [
              {
                type: "inlineCode",
                value: `${filepath} · L${startLine}-${endLine}`,
              },
            ],
          });
          i++; // 跳过刚插入的段落、别重复处理
        }
      }
      walk(child);
    }
  };
  walk(tree);
};
