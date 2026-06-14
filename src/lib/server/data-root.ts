/**
 * 数据根目录单一源（V0.7.0）
 *
 * 桌面端（Electron）注入 FE_AI_FLOW_DATA_DIR 指向系统 userData（卸载/更新不丢数据、
 * 也避免写进只读的 resources 目录）；不注入时回落 process.cwd()/data——
 * dev 行为跟以前完全一致。
 *
 * 所有要落 data/ 的模块（task-fs / mcp-oauth / uploads route）一律走这里、
 * 不要再各自拼 process.cwd()/data。
 */
import path from "node:path";

export const dataRoot = (): string =>
  process.env.FE_AI_FLOW_DATA_DIR || path.join(process.cwd(), "data");
