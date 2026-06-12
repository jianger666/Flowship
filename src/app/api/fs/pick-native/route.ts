import { NextResponse } from "next/server";
import { spawn } from "node:child_process";

export const runtime = "nodejs";

/**
 * 原生文件 / 文件夹选择对话框（V0.7.13、用户拍板「全项目换原生」）
 *
 * 取代网页版 FsPickerDialog（自绘文件浏览器、体验差）。原理：本工具 server
 * 跟用户同机（桌面端 / 本机浏览器都是）、server 调系统原生 picker、把绝对路径返给前端。
 *
 * 平台实现：
 * - macOS：osascript choose file / choose folder（多选 ✓）
 * - Windows：powershell OpenFileDialog（文件多选 ✓）/ FolderBrowserDialog（目录单选、
 *   WinForms 该控件不支持多选、要多个目录就多点几次）
 * - Linux：501（暂无用户、要用 zenity 再补）
 *
 * 入参：{ mode: "file" | "folder", multiple?: boolean, prompt?: string }
 * 返回：{ paths: string[] } | { canceled: true } | { error }
 */

// 等用户选择最长 5 分钟、超时杀子进程防泄漏
const PICKER_TIMEOUT_MS = 5 * 60 * 1000;

interface PickerResult {
  status: "ok" | "canceled" | "error" | "timeout";
  paths?: string[];
  error?: string;
}

interface PickBody {
  mode?: "file" | "folder";
  multiple?: boolean;
  prompt?: string;
}

// AppleScript：选完逐项转 POSIX path、linefeed 分隔输出
const buildAppleScript = (mode: "file" | "folder", multiple: boolean, prompt: string): string => {
  const verb = mode === "folder" ? "choose folder" : "choose file";
  const multi = multiple ? " with multiple selections allowed" : "";
  // prompt 转义：双引号防注入（osascript -e 单参数传入、仅需处理引号和反斜杠）
  const safePrompt = prompt.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  if (!multiple) {
    return `POSIX path of (${verb} with prompt "${safePrompt}")`;
  }
  return [
    `set fs to ${verb} with prompt "${safePrompt}"${multi}`,
    `set out to ""`,
    `repeat with f in fs`,
    `  set out to out & POSIX path of f & linefeed`,
    `end repeat`,
    `out`,
  ].join("\n");
};

// PowerShell：WinForms dialog、输出 \n 分隔路径；取消时无输出正常退出
const buildPowerShell = (mode: "file" | "folder", multiple: boolean, prompt: string): string => {
  const safePrompt = prompt.replace(/`/g, "``").replace(/"/g, '`"');
  if (mode === "folder") {
    return [
      "Add-Type -AssemblyName System.Windows.Forms | Out-Null",
      "$d = New-Object System.Windows.Forms.FolderBrowserDialog",
      `$d.Description = "${safePrompt}"`,
      "if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.WriteLine($d.SelectedPath) }",
    ].join("; ");
  }
  return [
    "Add-Type -AssemblyName System.Windows.Forms | Out-Null",
    "$d = New-Object System.Windows.Forms.OpenFileDialog",
    `$d.Title = "${safePrompt}"`,
    `$d.Multiselect = ${multiple ? "$true" : "$false"}`,
    "if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $d.FileNames | ForEach-Object { [Console]::Out.WriteLine($_) } }",
  ].join("; ");
};

const runPicker = (
  mode: "file" | "folder",
  multiple: boolean,
  prompt: string,
  signal: AbortSignal,
): Promise<PickerResult> =>
  new Promise((resolve) => {
    const isWin = process.platform === "win32";
    const proc = isWin
      ? spawn(
          "powershell",
          ["-NoProfile", "-STA", "-NonInteractive", "-Command", buildPowerShell(mode, multiple, prompt)],
          { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
        )
      : spawn("osascript", ["-e", buildAppleScript(mode, multiple, prompt)], {
          stdio: ["ignore", "pipe", "pipe"],
        });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const settle = (r: PickerResult) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };

    proc.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    proc.stderr.on("data", (d: Buffer) => (stderr += d.toString()));

    const timeoutHandle = setTimeout(() => {
      proc.kill("SIGKILL");
      settle({ status: "timeout", error: `选择超时（${PICKER_TIMEOUT_MS}ms）` });
    }, PICKER_TIMEOUT_MS);

    // 客户端断连（关 tab / 切走）→ 杀子进程、不留孤儿 picker
    const onAbort = () => {
      proc.kill("SIGTERM");
      settle({ status: "canceled" });
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });

    proc.on("error", (err) => {
      clearTimeout(timeoutHandle);
      signal.removeEventListener("abort", onAbort);
      settle({ status: "error", error: err.message });
    });

    proc.on("close", (code) => {
      clearTimeout(timeoutHandle);
      signal.removeEventListener("abort", onAbort);
      // mac 用户点取消：exit 1 + stderr 带 "User canceled" / "-128"
      if (code !== 0 && (stderr.includes("User canceled") || stderr.includes("-128"))) {
        settle({ status: "canceled" });
        return;
      }
      if (code !== 0) {
        settle({ status: "error", error: stderr.trim() || `picker exit ${code}` });
        return;
      }
      const paths = stdout
        .split(/\r?\n/)
        .map((s) => s.trim().replace(/\/+$/, ""))
        .filter(Boolean);
      // win 取消：正常退出但无输出
      if (paths.length === 0) {
        settle({ status: "canceled" });
        return;
      }
      settle({ status: "ok", paths });
    });
  });

export const POST = async (req: Request) => {
  if (process.platform !== "darwin" && process.platform !== "win32") {
    return NextResponse.json(
      { error: "当前平台不支持原生选择器、请手填路径" },
      { status: 501 },
    );
  }

  let body: PickBody;
  try {
    body = (await req.json()) as PickBody;
  } catch {
    body = {};
  }
  const mode = body.mode === "folder" ? "folder" : "file";
  const multiple = body.multiple === true;
  const prompt =
    body.prompt?.slice(0, 100) || (mode === "folder" ? "选择目录" : "选择文件");

  const result = await runPicker(mode, multiple, prompt, req.signal);

  switch (result.status) {
    case "ok":
      return NextResponse.json({ paths: result.paths });
    case "canceled":
      return NextResponse.json({ canceled: true });
    case "timeout":
      return NextResponse.json({ error: result.error ?? "选择超时" }, { status: 504 });
    case "error":
    default:
      return NextResponse.json(
        { error: `选择失败：${result.error ?? "未知错误"}` },
        { status: 500 },
      );
  }
};
