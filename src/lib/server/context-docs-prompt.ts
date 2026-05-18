/**
 * 渲染「任务上下文文档」段落、注入 agent 初始 prompt
 *
 * 抽出来给 plan-runner + chat-runner 共用、保证两边对 contextDocs 的呈现方式一致：
 *   - URL / path：只列出元信息、让 agent 按需拉（feishu-mcp / fetch / read_file）
 *   - text：≤ 1000 字默认全 inject、> 1000 字截断（信息保真要求）
 *
 * 跟 plan-runner 早期版本一致、只是搬了位置、没改语义。
 */

import type { Task, TaskContextDoc } from "@/lib/types";

// 长 text 截断阈值、超过这个字数 inline inject 时只放头部 + 截断标记
// 阈值取 1000：覆盖 80% 短文本场景（一段总结、一条要求）；长文档（PRD / 技术方案）一般也不会贴这种纯文本
const TEXT_INLINE_INJECT_MAX = 1000;

const renderContextDocBody = (doc: TaskContextDoc): string => {
  if (doc.type !== "text") {
    return `   ${doc.content.trim()}`;
  }
  const t = doc.content.trim();
  if (t.length <= TEXT_INLINE_INJECT_MAX) {
    return t
      .split("\n")
      .map((line) => `   ${line}`)
      .join("\n");
  }
  const head = t.slice(0, TEXT_INLINE_INJECT_MAX);
  return [
    ...head.split("\n").map((line) => `   ${line}`),
    `   …（**已截断、原文共 ${t.length} 字、超过 ${TEXT_INLINE_INJECT_MAX} 字上限**）`,
  ].join("\n");
};

/**
 * 渲染 contextDocs 段、空列表也会返回一段「目前没文档」的文本
 *
 * @param fallbackHint 没有任何 docs 时附加的提示语
 *                     - plan 模式：「→ 如果 plan phase 上下文极度缺失...」
 *                     - chat 模式：「→ 用户没传上下文文档、按对话内容判断要不要追问」
 */
export const renderContextDocsSection = (
  task: Task,
  fallbackHint?: string,
): string => {
  const docs = task.contextDocs ?? [];
  if (docs.length === 0) {
    const lines = ["## 用户提供的上下文文档（0 份）", "", "用户目前没有提供任何上下文文档。"];
    if (fallbackHint) {
      lines.push("", fallbackHint);
    }
    return lines.join("\n");
  }
  const items = docs.map((doc, i) => {
    const idx = i + 1;
    const titleLine =
      doc.type === "text"
        ? `${idx}. **【${doc.title}】**（text、${doc.content.trim().length} 字）`
        : `${idx}. **【${doc.title}】**（${doc.type}）`;
    return [titleLine, renderContextDocBody(doc)].join("\n");
  });
  return [
    `## 用户提供的上下文文档（${docs.length} 份）`,
    "",
    items.join("\n\n"),
    "",
    "→ **不确定怎么拉 / 怎么处理 doc 间冲突 / text 截断标记是什么意思**、read skill `context-docs-handler`",
  ].join("\n");
};
