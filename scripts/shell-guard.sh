#!/bin/bash
# fe-ai-flow beforeShellExecution hook（V0.6.27）：agent 跑 shell 命令前问 fe 是否放行。
#
# 行为：Cursor 触发本 hook（stdin 给事件 JSON、含 conversation_id + command）→
#   curl fe /api/hooks/shell-check → 透传 fe 返回：
#   {"permission":"allow"} 放行 / {"permission":"deny","agent_message":"..."} 拦截。
#
# fail-open 铁律（同 stop-hook.sh）：拿不到字段 / fe 没开 / curl 超时 / 任何异常 →
#   输出 {"permission":"allow"} 放行。fe 不认领该 agent（IDE agent）时 fe 端也放行、不误伤。

input=$(cat 2>/dev/null || true)

# 用 node 一次解析出 conversation_id + command（fe 是 node 项目、node 一定在）
# 输出格式：第一行 agent_id、其余行 command（command 可能含换行）
parsed=$(printf '%s' "$input" | node -e '
let s = "";
process.stdin.on("data", (d) => (s += d));
process.stdin.on("end", () => {
  try {
    const j = JSON.parse(s);
    const id = (j.conversation_id || "").trim();
    const cmd = j.command || "";
    process.stdout.write(id + "\n" + cmd);
  } catch {
    process.stdout.write("");
  }
});
' 2>/dev/null || true)

agent_id=$(printf '%s' "$parsed" | head -n 1)
command_text=$(printf '%s' "$parsed" | tail -n +2)

# 拿不到 agent_id / command → fail-open
if [ -z "${agent_id:-}" ] || [ -z "${command_text:-}" ]; then
  echo '{"permission":"allow"}'
  exit 0
fi

# base_url：FE_AI_FLOW_BASE_URL → PORT → 8876（跟 stop-hook.sh 一致）
base="${FE_AI_FLOW_BASE_URL:-}"
base="${base%/}"
if [ -z "$base" ]; then
  port="${PORT:-8876}"
  case "$port" in
    '' | *[!0-9]*) port=8876 ;;
  esac
  base="http://127.0.0.1:${port}"
fi

# 请求体用 node 构造（command 含引号 / 换行、手拼 JSON 会炸）
req_body=$(printf '%s' "$parsed" | node -e '
let s = "";
process.stdin.on("data", (d) => (s += d));
process.stdin.on("end", () => {
  const nl = s.indexOf("\n");
  const id = nl >= 0 ? s.slice(0, nl) : s;
  const cmd = nl >= 0 ? s.slice(nl + 1) : "";
  process.stdout.write(JSON.stringify({ agent_id: id, command: cmd }));
});
' 2>/dev/null || true)

if [ -z "${req_body:-}" ]; then
  echo '{"permission":"allow"}'
  exit 0
fi

# curl fe（超时 3s）、失败 fail-open
resp=$(curl -sS --max-time 3 -X POST "${base}/api/hooks/shell-check" \
  -H 'Content-Type: application/json' \
  -d "$req_body" 2>/dev/null || true)

if [ -z "${resp:-}" ]; then
  echo '{"permission":"allow"}'
else
  printf '%s' "$resp"
fi
exit 0
