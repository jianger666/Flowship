#!/usr/bin/env node
// ai-flow beforeShellExecution hook（V0.6.27 .sh 版、V0.6.29 改写 Node）：
// agent 跑 shell 命令前问 fe 是否放行。
//
// 行为：Cursor 触发本 hook（stdin 给事件 JSON、含 conversation_id + command）→
//   POST fe /api/hooks/shell-check → 透传 fe 返回：
//   {"permission":"allow"} 放行 / {"permission":"deny","agent_message":"..."} 拦截。
//
// 为什么是 Node 不是 bash：见 stop-hook.mjs 头注释（Windows 不能执行 .sh、按文件关联
// 打开到 IDE、且拦截从未生效）。拦截规则单一源在 server 端 shell-guard-rules.ts、
// 本脚本只是 relay、改写不影响规则。
//
// fail-open 铁律（同 stop-hook.mjs）：拿不到字段 / fe 没开 / 超时 / 任何异常 →
//   输出 {"permission":"allow"} 放行。fe 不认领该 agent（IDE agent）时 fe 端也放行、不误伤。

const FAIL_OPEN = '{"permission":"allow"}';

const readStdin = () =>
  new Promise((resolve) => {
    let s = "";
    process.stdin.on("data", (d) => (s += d));
    process.stdin.on("end", () => resolve(s));
    process.stdin.on("error", () => resolve(""));
  });

// base_url：FE_AI_FLOW_BASE_URL → PORT → 8876（跟 stop-hook.mjs 一致）
const baseUrl = () => {
  const env = (process.env.FE_AI_FLOW_BASE_URL ?? "").replace(/\/+$/, "");
  if (env) return env;
  const rawPort = process.env.PORT ?? "";
  const port = /^\d+$/.test(rawPort) ? rawPort : "8876";
  return `http://127.0.0.1:${port}`;
};

const main = async () => {
  let out = FAIL_OPEN;
  try {
    const input = await readStdin();
    const parsed = JSON.parse(input);
    const agentId = String(parsed.conversation_id ?? "").trim();
    const command = String(parsed.command ?? "");
    if (agentId && command) {
      const resp = await fetch(`${baseUrl()}/api/hooks/shell-check`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent_id: agentId, command }),
        signal: AbortSignal.timeout(3000),
      });
      const text = await resp.text();
      if (text.trim()) out = text;
    }
  } catch {
    // fail-open：任何异常都放行
  }
  process.stdout.write(out);
};

void main();
