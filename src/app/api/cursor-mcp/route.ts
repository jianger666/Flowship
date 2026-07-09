/**
 * GET /api/cursor-mcp
 *
 * MCP 配置读取（V0.13 独立化后语义）：
 * - `servers`：**运行时有效集 = fe 自管配置**（黑名单候选 / 健康探测 / 飞书校验都用它）
 * - `cursor`：`~/.cursor/mcp.json` 原样（仅供设置页「从 Cursor 导入」dialog 展示挑选）
 * - `dirs`：Cursor 配置候选目录（导入 dialog 显示来源）
 *
 * 不脱敏（用户拍板）：本地单机工具、用户看自己的配置、token/env 原样展示。
 */

import {
  getGlobalCursorDirs,
  readEffectiveMcpServers,
  readGlobalCursorMcpServers,
} from "@/lib/server/cursor-config";

export const runtime = "nodejs";

export const GET = async () => {
  const [cursor, effective] = await Promise.all([
    readGlobalCursorMcpServers(),
    readEffectiveMcpServers(),
  ]);
  return new Response(
    JSON.stringify({
      ok: true,
      servers: effective,
      cursor,
      dirs: getGlobalCursorDirs(),
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
};
