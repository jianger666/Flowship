import { NextResponse } from "next/server";
import { spawn } from "node:child_process";

export const runtime = "nodejs";

// osascript 等用户选目录最长 5 分钟、超过自动退出（防止后端进程泄漏）
const PICKER_TIMEOUT_MS = 5 * 60 * 1000;

interface PickerResult {
  status: "ok" | "canceled" | "error" | "timeout";
  path?: string;
  error?: string;
}

/**
 * 启动 osascript 子进程让用户选目录
 *
 * - 用 spawn + 数组参数（execFile 风格）、避免 shell 拼字符串注入
 * - 监听外部 abortSignal：浏览器关 tab / 客户端断开时同步杀掉子进程、不留孤儿
 * - 用户取消（exit 1 + stderr 包含 "User canceled" 或 "-128"）单独识别
 */
const runPicker = (signal: AbortSignal): Promise<PickerResult> =>
  new Promise((resolve) => {
    const proc = spawn(
      "osascript",
      ["-e", 'POSIX path of (choose folder with prompt "选择仓库目录")'],
      { stdio: ["ignore", "pipe", "pipe"] }
    );

    let stdout = "";
    let stderr = "";
    let settled = false;

    const settle = (r: PickerResult) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };

    proc.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    proc.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });

    // 超时兜底：osascript 默认会一直等用户操作、设个上限避免泄漏
    const timeoutHandle = setTimeout(() => {
      proc.kill("SIGKILL");
      settle({ status: "timeout", error: `选择超时（${PICKER_TIMEOUT_MS}ms）` });
    }, PICKER_TIMEOUT_MS);

    // 客户端断连（关 tab / 用户切走）→ 杀子进程、避免孤儿 osascript 留 5 分钟
    const onAbort = () => {
      proc.kill("SIGTERM");
      settle({ status: "canceled" });
    };
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }

    proc.on("error", (err) => {
      clearTimeout(timeoutHandle);
      signal.removeEventListener("abort", onAbort);
      settle({ status: "error", error: err.message });
    });

    proc.on("close", (code) => {
      clearTimeout(timeoutHandle);
      signal.removeEventListener("abort", onAbort);

      // 用户在 dialog 里点取消：osascript 退出码 1 + stderr 含 "User canceled" / "-128"
      if (
        code !== 0 &&
        (stderr.includes("User canceled") || stderr.includes("-128"))
      ) {
        settle({ status: "canceled" });
        return;
      }
      if (code !== 0) {
        settle({
          status: "error",
          error: stderr.trim() || `osascript exit ${code}`,
        });
        return;
      }
      // 末尾带斜杠（如 /Users/foo/repo/）、统一去掉、保持跟 path.basename 一致
      const path = stdout.trim().replace(/\/$/, "");
      if (!path) {
        settle({ status: "error", error: "未拿到路径" });
        return;
      }
      settle({ status: "ok", path });
    });
  });

/**
 * 弹原生文件夹选择对话框（macOS only）
 *
 * 为什么需要后端：浏览器安全模型禁止网页拿到本地绝对路径、但 settings
 * 里的"仓库路径"必须是绝对路径（给 SDK agent 当 cwd）、所以让 server
 * 调 macOS 自带的 osascript 弹 native dialog、再把路径返给前端。
 *
 * 限制：
 * - 仅 macOS（依赖 osascript）；Linux / Windows 直接报 501、前端会降级到「手填路径」
 * - 仅 server 同机有效；未来如果远程部署需要换成"server 端目录浏览器"方案
 */
export const POST = async (req: Request) => {
  if (process.platform !== "darwin") {
    return NextResponse.json(
      { error: "当前仅支持 macOS、其它平台请用「手填路径」" },
      { status: 501 }
    );
  }

  const result = await runPicker(req.signal);

  switch (result.status) {
    case "ok":
      return NextResponse.json({ path: result.path });
    case "canceled":
      return NextResponse.json({ canceled: true });
    case "timeout":
      return NextResponse.json(
        { error: result.error ?? "选择超时" },
        { status: 504 }
      );
    case "error":
    default:
      return NextResponse.json(
        { error: `选择失败：${result.error ?? "未知错误"}` },
        { status: 500 }
      );
  }
};
