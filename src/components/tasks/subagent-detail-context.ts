"use client";

/**
 * 「打开子代理详情面板」的 context（叶子模块）
 *
 * 单独成文件、不放进 `subagent-detail.tsx`：面板本身要 import 工具块 / 工作过程组 / 事件行去画子代理的过程，
 * 而子代理卡片（`tool-block.tsx`）又要拿「打开面板」的入口——放一起就是 tool-block ↔ subagent-detail 的循环依赖。
 * 这里只有 context，谁都可以依赖它。
 *
 * 没有宿主（`SubagentDetailHost`，挂在 EventStream 根上）的地方拿到 null：卡片 / 条据此不画「详情」入口。
 */

import { createContext, useContext } from "react";

import type { SubagentDetailTarget } from "@/lib/subagent-run";

export type OpenSubagentDetail = (target: SubagentDetailTarget) => void;

export const SubagentDetailContext = createContext<OpenSubagentDetail | null>(
  null,
);

/** 拿「打开子代理详情」的函数；不在宿主里返回 null（调用方据此决定画不画入口） */
export const useOpenSubagentDetail = (): OpenSubagentDetail | null =>
  useContext(SubagentDetailContext);
