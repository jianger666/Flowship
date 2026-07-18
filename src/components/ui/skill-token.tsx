/**
 * composer 内联 token tag 的单一视觉来源（2026-07-12 用户点名立规：同一视觉元素 ≥2 处必须单一来源）。
 *
 * 消费方：
 * - 输入岛 Lexical 节点（skill / file）：createDOM 是裸 DOM → 引 `*_TOKEN_CLASS` 常量
 * - 消息气泡高亮（SkillTokenText 等 React 场景）→ 用 `<SkillToken>` / `<FileToken>`
 *
 * skill = 品牌色；file = amber（跟附路径 chip 的目录色对齐、两种 token 一眼可分）。
 * 改样式只改这里、两边同步；别在任何地方再手写这串 className。
 */

import type { ReactNode } from "react";

/**
 * 品牌色 tag：作用在真实文本 span 上（Lexical caret 正常渲染的前提、别加 inline-flex）。
 * `skill-token-tag` 走 globals.css 的 ::before 补小闪 icon——伪元素不进文本流、
 * 不影响 token 文本序列化和光标（真 <svg> 子元素塞进 TextNode 会破坏两者）。
 */
export const SKILL_TOKEN_CLASS =
  "skill-token-tag rounded-[4px] bg-primary/20 px-0.5 font-medium text-primary ring-1 ring-inset ring-primary/30";

/**
 * 文件 / 目录 `@path` tag：amber 底衬区分 skill；`file-token-tag` ::before 补文件 icon。
 * 目录路径约定带尾 `/`（序列化进消息原文，agent 一眼能辨）。
 */
export const FILE_TOKEN_CLASS =
  "file-token-tag rounded-[4px] bg-amber-500/15 px-0.5 font-medium text-amber-700 ring-1 ring-inset ring-amber-500/30 dark:text-amber-400";

/** React 场景的 skill token tag（气泡高亮等）；children 传 `/skill-name` 原文 */
export const SkillToken = ({
  children,
  title,
}: {
  children: ReactNode;
  title?: string;
}) => (
  <span className={SKILL_TOKEN_CLASS} title={title}>
    {children}
  </span>
);

/** React 场景的文件引用 tag；children 传 `@rel/path` 原文 */
export const FileToken = ({
  children,
  title,
}: {
  children: ReactNode;
  title?: string;
}) => (
  <span className={FILE_TOKEN_CLASS} title={title}>
    {children}
  </span>
);
