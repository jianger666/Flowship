/**
 * Chat 长会话压缩（P4.2）——摘要指令与续接 preamble
 *
 * 九段结构照搬 Grok Build full_replace_summary_prompt（Apache-2.0），
 * 外壳中文化；灵感来源见 docs/grok-build-portable-assets-2026-07-17.md §1.1。
 */

/** GB MIN_SUMMARY_SEED_CHARS：清洗后短于 500 字视为失败、可重试 */
export const MIN_COMPACT_SUMMARY_CHARS = 500;

/**
 * 生成 summarize 指令（发给存活会话的一次性问答、不落 user_reply）。
 * keepHints 非空时追加「用户特别要求保留」。
 */
export const buildCompactSummarizePrompt = (keepHints?: string): string => {
  const userContextSection =
    keepHints && keepHints.trim().length > 0
      ? `\n用户特别要求保留：${keepHints.trim()}\n`
      : "";

  return `你的任务是为截至目前的对话生成一份忠实、简洁的摘要，以便后续助手在丢弃早期回合后仍能无缝续接。后继助手会看到用户的原始诉求加上本摘要。请抓住续作所需的信息——用户的明确请求、你最近的动作、关键技术细节、文件路径、命令、配置与架构决策——但要精炼：优先紧凑叙述与短引用，不要大段原文堆砌，也不要注水。一份能装进窗口的聚焦摘要远比被截断的详尽长文有用，目标最多几千字。
${userContextSection}
关键：若更早回合里已有压缩摘要（标有 <conversation_summary> 标签，或带有「本会话由长对话压缩续接」类 preamble），请将其视为早期历史的权威来源，并把其中仍然相关的信息带入新摘要，避免连续压缩时丢失要点。

先在私下推理中梳理对话；不要单独输出分析块。最终摘要放在唯一的 <summary>...</summary> 块内，并按下列编号章节组织。即使某节为空也要保留标题（写「无」）：

1. 主要请求与意图：用户所有明确请求及其底层意图，保留细节、约束、范围边界与偏好。
2. 关键技术概念：讨论或依赖过的技术、语言、框架、库、工具与模式。
3. 文件与代码段：检查、创建或修改过的每个文件。给出完整路径、为何重要、相关代码——对你写过或改过的代码给出完整片段（最近改动要全文），不要只写描述。
4. 错误与修复：遇到的每个错误、失败命令或测试/构建失败、根因、以及确切修复方式。来自用户反馈的修复请原文保留。
5. 问题求解：已解决的问题，以及进行中的诊断/排查（含仍在验证的假设）。
6. 全部用户消息：按时间顺序列出所有非工具结果的用户消息。这对理解意图演变至关重要。重要：不要把本条压缩指令本身算作用户消息——它是系统生成的压缩提示。
7. 未完成项：用户明确要求但尚未完成的任务。不要发明用户从未提过的任务。
8. 当前工作：发出本摘要请求前一刻你在做什么，含最近的文件名、代码、命令与状态。要具体到能从中途续作。
9. 可选下一步：直接延续最近工作的单一下一步，且严格符合用户最新明确请求。若先前任务已完成，仅在明显属于用户既定目标时提议下一步——否则写明应先与用户确认再继续。若有下一步，请从最近消息中摘一句原话，标明做到哪里，避免漂移。

重要：不要调用或使用任何工具。只输出 <summary>...</summary> 文本块，闭合标签后不要再写任何内容。

若先前对话提到 /tmp/compaction/segment_*.md 或 /tmp/compaction/INDEX.md（或类似持久化目录）中的文件，那些是给未来工作代理的带外记忆通道，不是给你的。你上下文里已有完整对话。不要尝试读取这些文件，也不要发出 read / grep / list_dir 等引用它们的工具调用。把这类笔记当作背景，仅从对话文本生成摘要。`;
};

/**
 * 从模型输出中提取摘要正文：优先剥 <summary>…</summary>；
 * 没有标签则用全文 trim（仍受 ≥500 字校验）。
 */
export const extractCompactSummaryText = (raw: string): string => {
  const trimmed = raw.trim();
  const match = trimmed.match(/<summary>([\s\S]*?)<\/summary>/i);
  if (match?.[1]) return match[1].trim();
  // 去掉可能的 <analysis> scratchpad（GB format_compact_summary 同款）
  return trimmed.replace(/<analysis>[\s\S]*?<\/analysis>/gi, "").trim();
};

/** 注入新会话首包的续接 preamble（GB continuation 中文化） */
export const buildCompactContinuationSection = (summary: string): string =>
  [
    "## 会话续接（长对话压缩）",
    "",
    "本会话由长对话压缩续接，此前对话摘要如下：",
    "",
    summary.trim(),
    "",
  ].join("\n");
