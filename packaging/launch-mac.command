#!/bin/bash
# fe-ai-flow 绿色包启动器（macOS、双击即跑）
#
# 跟 Windows launch.ps1 同一套逻辑：
#   1. 已在跑 → 直接开浏览器
#   2. 自动更新：比对 VERSION 和 GitHub 最新 release、有新版下载覆盖（data/ logs/ 保留）、
#      网络失败一律跳过（fail-open、不挡启动）
#   3. 起包内便携 node + standalone server（后台、日志落 logs/）
#   4. 等端口起来 → 开浏览器；首次在桌面放一个快捷方式（软链）
#
# ⚠️ 首次使用：浏览器下载的 zip 带 quarantine、双击会被 Gatekeeper 拦——
#    右键本文件 →「打开」一次即可、之后都能直接双击（脚本自己会给包内 node 解 quarantine）。

set -u
ROOT="$(cd "$(dirname "$0")" && pwd)"
PORT=8876
URL="http://localhost:$PORT"
REPO="jianger666/fe-ai-flow"

# 包是按 CPU 架构出的、更新时下载对应架构的 zip
case "$(uname -m)" in
  arm64) ASSET="fe-ai-flow-darwin-arm64.zip" ;;
  *)     ASSET="fe-ai-flow-darwin-x64.zip" ;;
esac

port_up() {
  nc -z 127.0.0.1 "$PORT" >/dev/null 2>&1
}

ensure_shortcut() {
  local link="$HOME/Desktop/fe-ai-flow.command"
  [ -e "$link" ] || ln -s "$ROOT/启动fe-ai-flow.command" "$link" 2>/dev/null || true
}

# --- 0. 给包自身解 quarantine（首次从浏览器下载的 zip 解出来全员带标记、node 会被 Gatekeeper 拦） ---
xattr -rd com.apple.quarantine "$ROOT" 2>/dev/null || true

# --- 1. 已经在跑？ ---
if port_up; then
  open "$URL"
  ensure_shortcut
  exit 0
fi

# --- 2. 自动更新（fail-open） ---
LOCAL_VERSION="$(head -1 "$ROOT/VERSION" 2>/dev/null | tr -d '[:space:]' || true)"
LATEST_JSON="$(curl -fsS --max-time 5 "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null || true)"
LATEST_TAG="$(printf '%s' "$LATEST_JSON" | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("tag_name",""))
except Exception: print("")' 2>/dev/null || true)"
if [ -n "$LATEST_TAG" ] && [ "$LATEST_TAG" != "$LOCAL_VERSION" ]; then
  echo "发现新版本 $LATEST_TAG（当前 $LOCAL_VERSION）、下载中…"
  TMP_ZIP="$(mktemp -t fe-ai-flow-update).zip"
  TMP_DIR="$(mktemp -d -t fe-ai-flow-update)"
  if curl -fsSL --max-time 600 -o "$TMP_ZIP" \
      "https://github.com/$REPO/releases/download/$LATEST_TAG/$ASSET"; then
    unzip -qo "$TMP_ZIP" -d "$TMP_DIR" || true
    SRC="$TMP_DIR/fe-ai-flow"
    [ -d "$SRC" ] || SRC="$TMP_DIR"
    if [ -f "$SRC/server.js" ]; then
      # 覆盖包文件、任务数据和日志保留
      rsync -a --exclude data/ --exclude logs/ "$SRC/" "$ROOT/" 2>/dev/null \
        && echo "已更新到 $LATEST_TAG"
      xattr -rd com.apple.quarantine "$ROOT" 2>/dev/null || true
      chmod +x "$ROOT/node/node" "$ROOT/启动fe-ai-flow.command" 2>/dev/null || true
    fi
  fi
  rm -rf "$TMP_ZIP" "$TMP_DIR" 2>/dev/null || true
fi

# --- 3. 起 server ---
mkdir -p "$ROOT/logs"
cd "$ROOT"
PORT="$PORT" HOSTNAME="127.0.0.1" NODE_ENV=production \
  nohup "$ROOT/node/node" server.js >"$ROOT/logs/server.log" 2>&1 &

# --- 4. 等 ready → 开浏览器 + 桌面快捷方式 ---
for _ in $(seq 1 60); do
  port_up && break
  sleep 0.5
done
open "$URL"
ensure_shortcut
echo "fe-ai-flow 已启动：$URL（本窗口可关闭）"
