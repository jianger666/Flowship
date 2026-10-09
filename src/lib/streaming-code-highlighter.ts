/**
 * 流式 Markdown 用的代码高亮插件实例（全局一份）。
 *
 * 为什么单独一个模块：
 *   - Shiki 高亮器有初始化开销、节流状态（slot / 结果缓存）也必须跨组件实例共享，别每次 render 新建；
 *   - 前端流畅度上报（use-ui-perf-reporter）要读它的统计，不能为此去 import 整个 markdown-text
 *     （那会把 Streamdown / katex / mermaid 一整串依赖拖进上报链路）。
 *
 * 只给「流式中」的 MarkdownText 用；静态渲染仍用上游 code 插件（命中上游缓存即时上色）。
 * 限频策略与不变式见 throttled-code-plugin.ts。
 */
import { code } from "@streamdown/code";

import { createThrottledCodePlugin } from "@/lib/throttled-code-plugin";

export const streamingCodePlugin = createThrottledCodePlugin(code);
