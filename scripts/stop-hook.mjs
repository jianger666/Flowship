#!/usr/bin/env node
// ai-flow stop hook（V0.6.3 .sh 版、V0.6.29 改写 Node）：保证 agent 交卷（调 wait_for_user）后才放行结束 Run。
//
// 行为：agent 想结束 Run → Cursor 触发本 hook（stdin 给事件 JSON）→ 提取 conversation_id
//   （= agent_id）→ POST fe /api/hooks/stop-check 问「这个 agent 的 action 交卷没」→
//   透传 fe 返回：{} = 放行结束 / {"followup_message":"..."} = 同会话拉回补调 wait_for_user。
//
// 为什么是 Node 不是 bash（V0.6.29、同事 Windows 实测踩坑）：
//   hooks.json command 指 .sh 时、Windows 没有 shebang 机制、系统按文件关联处理、
//   .sh 的关联应用恰好是 IDE → hook 每触发一次 IDE 就「打开」脚本一次、且拦截从未生效。
//   ai-flow 本身跑在 Node 上、`node <本文件>` 跨平台必可执行、还顺带去掉 curl 依赖。
//
// fail-open 铁律：拿不到 agent_id / fe 没开 / 超时 / 任何异常 → 输出 {} 放行。
//   绝不 block agent——尤其用户用 Cursor IDE 打开该 repo 时 IDE agent 也会触发本 hook、
//   fe 不认领（agent_id 不在 runningTasks）就立即放行、不误伤。

const FAIL_OPEN = "{}";

// 读完整 stdin（Cursor 给的 hook 事件 JSON）
const readStdin = () =>
  new Promise((resolve) => {
    let s = "";
    process.stdin.on("data", (d) => (s += d));
    process.stdin.on("end", () => resolve(s));
    process.stdin.on("error", () => resolve(""));
  });

// base_url：FE_AI_FLOW_BASE_URL → PORT → 8876（跟 chat-mcp getServerBaseUrl 一致）
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
    const agentId = String(JSON.parse(input).conversation_id ?? "").trim();
    if (agentId) {
      const resp = await fetch(`${baseUrl()}/api/hooks/stop-check`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent_id: agentId }),
        // 3s 超时、fe 没开 / 卡住一律 fail-open（同 .sh 版 curl --max-time 3）
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
