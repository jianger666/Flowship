#!/bin/sh
# PATH shim 外发包装器（v3.1 §5.3 第一层，精确、OS 级不可绕过）。
# 安装：worker spawn 时把本目录 prepend 到 PATH，原二进制用 FLOWSHIP_REAL_<NAME> 传入绝对路径。
# 行为：写 intent 行 → exec 真二进制。fail-closed：FLOWSHIP_INTENT_FILE 未配置或落盘失败都拒绝执行。
# 用法：ln -s egress-wrapper.sh curl; FLOWSHIP_REAL_CURL=/usr/bin/curl PATH=<shim>:$PATH ...
set -eu
name="$(basename "$0")"
upper="$(printf '%s' "$name" | tr '[:lower:]' '[:upper:]')"
eval "real=\"\${FLOWSHIP_REAL_${upper}:-}\""
# A1 修复：未配置 INTENT_FILE 直接拒执行，不再静默放行（旧 /dev/null 缺省已删）。
if [ -z "${FLOWSHIP_INTENT_FILE:-}" ]; then
  echo "[path-shim] $name: 未配置 FLOWSHIP_INTENT_FILE，拒绝执行" >&2
  exit 77
fi
: "${FLOWSHIP_TASK_ID:=unknown}"
: "${FLOWSHIP_ACTION_ID:=unknown}"
: "${FLOWSHIP_TOOLCALL_ID:=unknown}"
if [ -z "$real" ]; then
  echo "[path-shim] $name: 未配置 FLOWSHIP_REAL_${upper}，拒绝执行" >&2
  exit 77
fi
# 顺手修：argv JSON 依赖 python3，缺失即 fail-closed（坏 JSON 行会被静默跳过 = intent 丢失）。
if ! command -v python3 >/dev/null 2>&1; then
  echo "[path-shim] $name: 缺少 python3（argv 记账需要），拒绝执行" >&2
  exit 78
fi
# 最小 intent 行（执行器侧按 task/action/toolCall 归一幂等键；写失败直接拒执行）
printf '{"taskId":"%s","actionId":"%s","toolCallId":"%s","kind":"external-api","via":"path-shim","bin":"%s","argv":%s}\n' \
  "$FLOWSHIP_TASK_ID" "$FLOWSHIP_ACTION_ID" "$FLOWSHIP_TOOLCALL_ID" "$name" "$(printf '%s\n' "$@" | python3 -c 'import json,sys; print(json.dumps([l.rstrip(chr(10)) for l in sys.stdin]))')" >> "$FLOWSHIP_INTENT_FILE" 2>/dev/null || {
  echo "[path-shim] intent 落盘失败，拒绝执行 $name" >&2
  exit 78
}
exec "$real" "$@"
