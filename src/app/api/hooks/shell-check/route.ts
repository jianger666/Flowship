/**
 * POST /api/hooks/shell-check（V0.6.27）
 *
 * fe 起的 SDK agent 每次跑 shell 命令前、业务仓库 .cursor/hooks.json 的
 * beforeShellExecution hook（scripts/shell-guard.mjs）会 POST 本路由。
 * 本路由用 shell-guard-rules 判定命令是否踩了硬禁令（--fix / force push / dev server 等）。
 *
 * 请求：{ agent_id: string, command: string }
 *
 * 返回（透传给 Cursor beforeShellExecution hook）：
 * - 放行：{ "permission": "allow" }
 * - 拦截：{ "permission": "deny", "agent_message": "..." }——agent 收到解释、换只读命令重试
 *
 * 认领（fail-safe、同 stop-check）：agent_id 不在 runningTasks（IDE agent / 已死 task）
 * → 一律放行、绝不误伤非 fe agent。
 */
import { findTaskIdByAgentId } from "@/lib/server/task-runner";
import { publishTaskStreamEvent } from "@/lib/server/task-stream";
import { appendEvent } from "@/lib/server/task-fs";
import { evaluateShellCommand } from "@/lib/server/shell-guard-rules";

export const runtime = "nodejs";

interface ShellCheckBody {
  agent_id?: string;
  command?: string;
}

const allow = (): Response =>
  new Response(JSON.stringify({ permission: "allow" }), {
    headers: { "Content-Type": "application/json" },
  });

export const POST = async (req: Request): Promise<Response> => {
  let body: ShellCheckBody;
  try {
    body = (await req.json()) as ShellCheckBody;
  } catch {
    return allow(); // body 解析失败 fail-open
  }

  const agentId = body.agent_id?.trim();
  const command = body.command ?? "";
  if (!agentId || !command.trim()) return allow();

  // 认领：不是 fe 自己的活 agent（IDE agent / 已死 task）→ 放行、不管
  const taskId = findTaskIdByAgentId(agentId);
  if (!taskId) return allow();

  const verdict = evaluateShellCommand(command);
  if (verdict.verdict === "allow") return allow();

  console.warn(
    `[shell-check] task=${taskId} 拦截命令: ${command.slice(0, 200)} → ${verdict.reason}`,
  );

  // 拦截留痕：写进 task 事件流、用户在 UI 直接看到 agent 试图跑什么被拦了
  try {
    const event = await appendEvent(taskId, {
      kind: "error",
      text: `🛡️ shell-guard 拦截了一条命令：\`${command.slice(0, 300)}\`\n${verdict.reason}`,
    });
    if (event) publishTaskStreamEvent(taskId, { kind: "event", event });
  } catch {
    // 留痕失败不影响拦截本身
  }

  return new Response(
    JSON.stringify({
      permission: "deny",
      agent_message: `${verdict.reason}\n（ai-flow shell-guard 硬拦截、这条规则在 prompt「shell 安全」段也有写。请换合规命令继续、不要重试原命令。）`,
    }),
    { headers: { "Content-Type": "application/json" } },
  );
};
