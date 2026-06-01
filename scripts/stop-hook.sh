#!/bin/bash
# fe-ai-flow stop hook（V0.6.3）：保证 agent 交卷（调 wait_for_user）后才放行结束 Run。
#
# 行为：agent 想结束 Run → Cursor 触发本 hook（stdin 给事件 JSON）→ 提取 conversation_id
#   （= agent_id）→ curl fe /api/hooks/stop-check 问「这个 agent 的 action 交卷没」→
#   透传 fe 返回：{} = 放行结束 / {"followup_message":"..."} = 同会话拉回补调 wait_for_user。
#
# fail-open 铁律：拿不到 agent_id / fe 没开 / curl 超时 / 任何异常 → 输出 {} 放行。
#   绝不 block agent——尤其用户用 Cursor IDE 打开该 repo 时 IDE agent 也会触发本 hook、
#   fe 不认领（agent_id 不在 runningTasks）就立即放行、不误伤。

# 读 stdin（Cursor 给的 hook 事件 JSON）
input=$(cat 2>/dev/null || true)

# 提取 conversation_id（= agent_id）。用 node 解析（fe 是 node 项目、node 一定在）
agent_id=$(printf '%s' "$input" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{try{process.stdout.write((JSON.parse(s).conversation_id||"").trim())}catch{process.stdout.write("")}})' 2>/dev/null || true)

# 拿不到 agent_id → fail-open
if [ -z "${agent_id:-}" ]; then
  echo '{}'
  exit 0
fi

# base_url：FE_AI_FLOW_BASE_URL → PORT → 8876（跟 chat-mcp getServerBaseUrl 一致）
base="${FE_AI_FLOW_BASE_URL:-}"
base="${base%/}"
if [ -z "$base" ]; then
  port="${PORT:-8876}"
  case "$port" in
    '' | *[!0-9]*) port=8876 ;;
  esac
  base="http://127.0.0.1:${port}"
fi

# curl fe（超时 3s）、失败 fail-open
resp=$(curl -sS --max-time 3 -X POST "${base}/api/hooks/stop-check" \
  -H 'Content-Type: application/json' \
  -d "{\"agent_id\":\"${agent_id}\"}" 2>/dev/null || true)

# 空响应 → fail-open；否则透传 fe 返回（{} 放行 / {"followup_message":...} 拉回）
if [ -z "${resp:-}" ]; then
  echo '{}'
else
  printf '%s' "$resp"
fi
exit 0
