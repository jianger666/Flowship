/**
 * POST /api/hooks/stop-check（V0.6.3）
 *
 * fe 起的 SDK agent 想结束 Run 时、业务仓库 .cursor/hooks.json 里的 fe stop hook 脚本会 curl 本路由。
 * 本路由判断「当前 action 交卷没」、决定放行结束、还是 follow-up 把 agent 同会话拉回补调 submit_work。
 *
 * 请求：{ agent_id: string }（= stop hook stdin 的 conversation_id）
 *
 * 返回（透传给 Cursor stop hook）：
 * - 放行结束：{}                            —— 交卷了 / task 终态 / 不认领这个 agent
 * - 拉回补调：{ "followup_message": "..." }  —— 最后一个 action 还 running = 没交卷
 *
 * 认领（fail-safe）：agent_id 不在 runningTasks（IDE agent / 已死 task）→ 返 {} 放行、绝不误伤非 fe agent。
 */
import { findTaskIdByAgentId } from "@/lib/server/task-runner";
import { getPendingAsk } from "@/lib/server/chat-pending";
import { getTask } from "@/lib/server/task-fs";
import { runningChecks } from "@/lib/server/task-stream";

export const runtime = "nodejs";

interface StopCheckBody {
  agent_id?: string;
}

// 放行：让 agent 正常结束 Run
const passthrough = (): Response =>
  new Response(JSON.stringify({}), {
    headers: { "Content-Type": "application/json" },
  });

export const POST = async (req: Request): Promise<Response> => {
  let body: StopCheckBody;
  try {
    body = (await req.json()) as StopCheckBody;
  } catch {
    return passthrough(); // body 解析失败也 fail-open
  }

  const agentId = body.agent_id?.trim();
  if (!agentId) return passthrough();

  // 认领：agent_id → task_id；不认领（IDE agent / 已死 task）→ 放行
  const taskId = findTaskIdByAgentId(agentId);
  // 诊断 log（V0.6.3 首次联调验证认领是否命中——即 hook 的 conversation_id 是否 === SDK
  // agent.agentId；命中=推断成立、未命中可能是 IDE agent 也可能是该推断不成立、看 log 判断）
  console.log(
    `[stop-check] agent_id=${agentId} → task=${taskId ?? "未命中(放行)"}`,
  );
  if (!taskId) return passthrough();

  const task = await getTask(taskId);
  if (!task) return passthrough();

  // task 终态（已合 / 已弃）→ agent 本就该退、放行
  if (task.repoStatus === "merged" || task.repoStatus === "abandoned") {
    return passthrough();
  }

  // 看最后一个 action 交卷没（没 action 直接放行）
  const last = task.actions[task.actions.length - 1];
  if (!last) return passthrough();

  // running = agent 干完想退但没交卷 → follow-up 同会话拉回补调。
  // V0.11 两个豁免（run 自然结束是正常出口）：
  //   - 刚交卷、后置 check 还在后台跑（action 状态尚未翻 awaiting_ack）→ 放行
  //   - ask_user 提问在等用户答（结束回复等答案就是正确姿势）→ 放行
  if (last.status === "running") {
    const checkInFlight = runningChecks.get(taskId)?.actionId === last.id;
    const askPending = !!getPendingAsk(taskId);
    if (checkInFlight || askPending) {
      console.log(
        `[stop-check] task=${taskId} action#${last.n}(${last.type}) ${
          checkInFlight ? "已交卷（check 在跑）" : "ask 等答案"
        } → 放行`,
      );
      return passthrough();
    }
    console.log(
      `[stop-check] task=${taskId} action#${last.n}(${last.type}) 未交卷 → followup 拉回`,
    );
    const followup = [
      "[ai-flow] 检测到你还没对当前 action 交卷、不要结束本次回复。",
      `当前 action：id=${last.id}、type=${last.type}、n=${last.n}。`,
      last.artifactPath ? `artifact 路径：${last.artifactPath}。` : "",
      "请先调用 submit_work 工具（传 task_id / action_id / artifact_path）交卷、然后再结束回复。",
    ]
      .filter(Boolean)
      .join("\n");
    return new Response(JSON.stringify({ followup_message: followup }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  // awaiting_ack / completed / error / cancelled → 已交卷或已处理、放行
  console.log(
    `[stop-check] task=${taskId} action#${last.n}(${last.type}) status=${last.status} → 放行`,
  );
  return passthrough();
};
