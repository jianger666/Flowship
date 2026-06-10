/**
 * GET /api/tasks/[id]/wait-ack?token=<token>
 *
 * # V0.3.5 核心路由：shell long-poll 替代 MCP 50s 保活
 *
 * 给 agent 的 `shell` 工具 curl 用、一条长 HTTP 连接、chunked stream：
 *   - 每 60 秒服务端 write 一段 `[KEEPALIVE ts=...]\n`（普通文本行、保中间链路 + 让 agent 看到 stdout 一直有动静）
 *   - 用户在 UI 上 ack/reply → submitXxx resolve pendingMap.entry.result → 路由 write 结果文本 + end
 *   - curl 拿到 stdout、shell 命令 exit 0、agent 推进下一步
 *
 * ## keepalive 内容为什么不用 SSE 注释（`:` 开头）
 *
 * V0.3.5 实测（2026-05-14）：原来用 `: keepalive` SSE 注释格式、curl 静默吃下、stdout 不输出。
 * 看似省 token 但有副作用：agent 看不到 stdout 新行、连续 5 分钟"无动静"触发 Cursor 模型层的训练 bias
 * （"shell 卡了、我该 summarize 并退出 run"）。改成 `[KEEPALIVE ts=...]` 普通行、agent 通过
 * shell-output-delta 持续看到"还活着"信号、不会主动 summarize 退出。super-prompt 教过忽略这种行。
 *
 * ## 为什么这么设计
 *
 * 旧版 MCP wait_for_user 是阻塞工具、Cursor SDK 60s 硬超时打断、靠 keep_alive_a/b/c 三 tool 轮转拖时间、
 * 5-6 分钟必被 Cursor backend anti-loop 判定循环、agent emit 文本退 run。
 *
 * 实证（scripts/test-shell-sleep.mjs）：SDK `shell` 工具**不受 MCP 60s 硬超时**、`sleep 300` 都能跑完、
 * 且 agent 不重复调 shell、anti-loop 不会触发。
 *
 * 把「等用户」从 MCP 工具阻塞挪到 shell + curl 长连接、anti-loop 风险彻底消失。
 *
 * ## 异常路径
 *
 * - **token 不合法**：写一行 `[INVALID_TOKEN]\n` + end、curl exit 0、agent 看到 INVALID_TOKEN 自然结束 run
 * - **客户端断开（curl exit / max-time / 网络断）**：abort signal 触发、清 keepalive timer + close stream
 *   - **不清 pendingMap entry**：entry 留着、用户在 UI 点「推进 → 让原 agent 继续」走 /api/tasks/[id]/advance（mode=resume）复用
 * - **服务端进程重启**：pendingMap 内存丢、cold-start recovery 标 failed、UI 引导用户重新启动 task
 */

import {
  subscribeWaitAck,
  formatToolReturnAsText,
  getWaitAckKeepaliveMs,
} from "@/lib/server/chat-mcp";
import { SIGNALS, keepaliveLine } from "@/lib/protocol-signals";

// 强制走 Node runtime（不要 edge、edge 不支持长连接 + 我们的 globalState）
export const runtime = "nodejs";
// 禁止 Next.js 缓存这条响应
export const dynamic = "force-dynamic";
// Next.js 单次响应最大时长（秒）。Node runtime 实际无硬限、shell curl 自己用 --max-time 卡 30 分钟
export const maxDuration = 3600;

interface Ctx {
  params: Promise<{ id: string }>;
}

export const GET = async (req: Request, { params }: Ctx): Promise<Response> => {
  const { id: taskId } = await params;
  const token = new URL(req.url).searchParams.get("token");
  if (!token) {
    return new Response("missing token query param\n", { status: 400 });
  }

  console.log(
    `[wait-ack] GET task=${taskId} token=${token} 起 long-poll 连接`,
  );

  const entry = subscribeWaitAck(taskId, token);
  if (!entry) {
    // token 无效（已被消费 / 从未存在 / taskId 不匹配）
    // 给 agent 一个可识别的退出信号、不要让它陷在 retry loop
    return new Response(`${SIGNALS.INVALID_TOKEN}\n本 token 已被前置事件消费或无效、agent 应自然结束 run。\n`, {
      status: 200,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-cache, no-store, no-transform",
      },
    });
  }

  const encoder = new TextEncoder();
  const keepaliveMs = getWaitAckKeepaliveMs();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          // 已经被 abort 关掉、忽略
        }
      };

      // V0.6.21：连接建立立即发一个 keepalive——配合 agent 端 while-loop 重连：
      // 下一轮 curl 一连上就有 stdout、把每轮切换的「无输出」间隙从 ~60s 降到秒级。
      // SDK shell 是 idle-timeout（多久没输出才杀、非总时长）、持续输出才不被杀；
      // 60s 间隔已实测够撑 30 分钟、但 while 多轮切换叠加 sleep、这一行是额外保险。
      try {
        controller.enqueue(encoder.encode(keepaliveLine()));
      } catch {
        // 已被 abort、忽略
      }

      // chunked keepalive 心跳：每 60 秒一次普通文本行
      // 双重作用：
      //   1. 维持中间链路（nginx / ELB / 浏览器 proxy）connection、不被 idle 砍
      //   2. **让 agent 通过 shell-output-delta 持续看到 stdout 新行**、防止模型 bias 自己 summarize 退出
      const keepaliveTimer = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(keepaliveLine()));
        } catch {
          clearInterval(keepaliveTimer);
          close();
        }
      }, keepaliveMs);

      // 等 entry 结果 promise 解算（用户 ack / submit / cancel / stale 顶替）
      entry.result
        .then((value) => {
          if (closed) return;
          const text = formatToolReturnAsText(value);
          console.log(
            `[wait-ack] task=${taskId} token=${token} resolved kind=${value.kind}、写 ${text.length} 字节后关流`,
          );
          try {
            controller.enqueue(encoder.encode(text + "\n"));
          } catch {
            // 已 abort、忽略
          }
          clearInterval(keepaliveTimer);
          close();
        })
        .catch((err) => {
          console.error(
            `[wait-ack] task=${taskId} token=${token} promise rejected`,
            err,
          );
          try {
            controller.enqueue(
              encoder.encode(
                `${SIGNALS.INTERNAL_ERROR}\nwait-ack promise rejected: ${err instanceof Error ? err.message : String(err)}\n`,
              ),
            );
          } catch {
            // ignore
          }
          clearInterval(keepaliveTimer);
          close();
        });

      // 客户端主动断（curl exit / max-time / 网络断）→ abort signal
      // 注意：**不清 pendingMap entry**、留着给「推进 → 让原 agent 继续」按钮复用
      req.signal?.addEventListener("abort", () => {
        if (closed) return;
        console.log(
          `[wait-ack] task=${taskId} token=${token} 客户端 abort、entry 保留等 resume`,
        );
        clearInterval(keepaliveTimer);
        close();
      });
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-cache, no-store, no-transform",
      // 提示 nginx 等反向代理不要缓冲（部分企业代理识别）
      "x-accel-buffering": "no",
      // 显式 chunked（虽然 Response stream 默认就是 chunked、写明白让 LB 别误判 content-length）
      "transfer-encoding": "chunked",
    },
  });
};
