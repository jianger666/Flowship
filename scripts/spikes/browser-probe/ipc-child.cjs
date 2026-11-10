"use strict";
/**
 * 探针 T4 的「假 server」：和真 server 一样被 ELECTRON_RUN_AS_NODE 拉起、带 ipc 通道。
 * 只做三件事：回显（测往返延迟 / 大 payload）、报自己的环境、起一个孙进程看 NODE_CHANNEL_FD 会不会泄漏。
 */
const { spawnSync } = require("node:child_process");

process.on("message", (m) => {
  if (!m || typeof m !== "object") return;
  if (m.type === "echo") {
    process.send({ type: "echo", n: m.n, size: typeof m.payload === "string" ? m.payload.length : 0 });
    return;
  }
  if (m.type === "grandchild") {
    const r = spawnSync(
      process.execPath,
      [
        "-e",
        "console.log(JSON.stringify({ fd: process.env.NODE_CHANNEL_FD ?? null, hasSend: typeof process.send }))",
      ],
      { env: { ...process.env }, encoding: "utf8" },
    );
    process.send({ type: "grandchild", out: (r.stdout || "").trim(), err: (r.stderr || "").trim() });
    return;
  }
  if (m.type === "exit") process.exit(0);
});

process.send({
  type: "ready",
  pid: process.pid,
  electron: process.versions.electron ?? null,
  runAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null,
  // Node 在子进程里初始化 ipc 后会从 env 里删掉它；这里确认「server 自己的 env 里没有」
  channelFdInOwnEnv: process.env.NODE_CHANNEL_FD ?? null,
});
