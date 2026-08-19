/**
 * Cursor SDK Agent 入口（本 hotfix 薄封装）。
 *
 * create / resume / prompt 一律挂 dataRoot 下的 JSONL store，躲开用户级
 * `~/.cursor` SQLite WAL（Windows 杀毒 / OneDrive 会 SQLITE_CANTOPEN）。
 * 调用方已传 `local.store` 时 withCursorJsonlStore 不会覆盖。
 *
 * 四个 runner 只改这一处 import，下游签名不变。
 */
import { Agent as CursorAgent } from "@cursor/sdk";

import { withCursorJsonlStore } from "./sdk-agent-store";

export const Agent = {
  create: async (input: Parameters<typeof CursorAgent.create>[0]) =>
    CursorAgent.create(await withCursorJsonlStore(input)),

  resume: async (
    agentId: string,
    input: Parameters<typeof CursorAgent.resume>[1],
  ) =>
    CursorAgent.resume(
      agentId,
      await withCursorJsonlStore(input ?? ({} as NonNullable<typeof input>)),
    ),

  prompt: async (
    prompt: string,
    input: Parameters<typeof CursorAgent.prompt>[1],
  ) =>
    CursorAgent.prompt(
      prompt,
      await withCursorJsonlStore(input ?? ({} as NonNullable<typeof input>)),
    ),
};
