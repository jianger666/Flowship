/**
 * 渲染「任务上下文文档」段落、注入 agent 初始 prompt
 *
 * 抽出来给 plan-runner + chat-runner 共用、保证两边对 contextDocs 的呈现方式一致：
 *   - URL / path：只列出元信息、让 agent 按需拉（飞书 MCP 或内置 CLI / fetch / `read` 工具）
 *   - text：≤ 1000 字默认全 inject、> 1000 字截断（信息保真要求）
 *   - image（V0.6.0.1）：列绝对路径、agent 用 `read` 工具读、SDK 自动转 vision
 */

import type { Task, TaskContextDoc } from "@/lib/types";

// 长 text 截断阈值、超过这个字数 inline inject 时只放头部 + 截断标记
// 阈值取 1000：覆盖 80% 短文本场景（一段总结、一条要求）；长文档（PRD / 技术方案）一般也不会贴这种纯文本
const TEXT_INLINE_INJECT_MAX = 1000;

const renderContextDocBody = (doc: TaskContextDoc): string => {
  if (doc.type === "text") {
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
  }
  if (doc.type === "image") {
    return [
      `   ${doc.content.trim()}`,
      "   → 用 `read` 工具读这个路径、SDK 会自动转 vision（用户截图说明、比文字直接）",
    ].join("\n");
  }
  return `   ${doc.content.trim()}`;
};

/**
 * 渲染 contextDocs 段；没有文档时返回空串（整段不注入——「用户没提供文档」不需要专门说一段，调用方对空串不占位）
 */
export const renderContextDocsSection = (task: Task): string => {
  const docs = task.contextDocs ?? [];
  if (docs.length === 0) return "";
  const items = docs.map((doc, i) => {
    const idx = i + 1;
    let typeLabel: string;
    if (doc.type === "text") {
      typeLabel = `text、${doc.content.trim().length} 字`;
    } else if (doc.type === "image") {
      typeLabel = "image、用户截图";
    } else {
      typeLabel = doc.type;
    }
    const titleLine = `${idx}. **【${doc.title}】**（${typeLabel}）`;
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
