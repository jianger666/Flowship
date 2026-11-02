/**
 * 飞书桥接防睡眠（4.4c）
 *
 * 仅接电源时阻止系统睡眠；电池供电不偷电。
 * - macOS：`caffeinate -s`（-s 语义本身就是接电才生效）
 * - Windows：PowerShell + SetThreadExecutionState + 5s 电源/父进程轮询
 *   （父进程 = 本 server；它消失脚本自己释放断言并退出，不留孤儿）
 *
 * 实现抄自 cursor-feedback-extension 的 keep-awake.ts（已双平台验证）。
 */

import { spawn, type ChildProcess } from "node:child_process";

const log = (msg: string): void => {
  console.error(`[feishu-bridge/keep-awake] ${msg}`);
};

/**
 * Windows 常驻脚本：持有/释放电源断言 + 电源状态轮询。
 * ES_CONTINUOUS=0x80000000, ES_SYSTEM_REQUIRED=0x00000001。
 * PowerLineStatus Online=接电（台式机无电池也是 Online）。
 */
export const buildWinKeepAwakePs = (parentPid: number): string => {
  // parentPid 只允许正整数：它会被拼进 PowerShell 脚本文本，不能放任意字符串
  const pid = Number.isSafeInteger(parentPid) && parentPid > 0 ? parentPid : 0;
  return `
Add-Type -Name P -Namespace W -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);'
Add-Type -AssemblyName System.Windows.Forms
$held = $false
$parentPid = ${pid}
while ($true) {
  # 父进程（本 server）没了就自己退出：server 崩溃 / 被 taskkill /F 时 stop() 不会跑，
  # 没有这一步脚本会常驻，每崩一次多一个，接电时整机永不睡眠（评审 P2）。
  if ($parentPid -gt 0 -and -not (Get-Process -Id $parentPid -ErrorAction SilentlyContinue)) {
    if ($held) { [W.P]::SetThreadExecutionState(0x80000000) | Out-Null }
    exit 0
  }
  $ac = [System.Windows.Forms.SystemInformation]::PowerStatus.PowerLineStatus -eq 'Online'
  if ($ac -and -not $held) { [W.P]::SetThreadExecutionState(0x80000001) | Out-Null; $held = $true }
  elseif (-not $ac -and $held) { [W.P]::SetThreadExecutionState(0x80000000) | Out-Null; $held = $false }
  Start-Sleep -Seconds 5
}
`;
};

/** 防睡眠句柄：start/stop 幂等；意外退出 10s 后自动拉起 */
export class KeepAwake {
  private child: ChildProcess | null = null;
  private stopped = false;
  /** 单测可注入 spawn */
  private spawnImpl: typeof spawn = spawn;

  /** 是否持有子进程 */
  isActive = (): boolean => this.child !== null;

  /** 单测替换 spawn */
  __setSpawnForTest = (fn: typeof spawn | null): void => {
    this.spawnImpl = fn ?? spawn;
  };

  /** 启动防睡眠（幂等）。Linux 等不支持平台静默跳过。 */
  start = (): void => {
    if (this.child) return;
    this.stopped = false;

    let bin: string;
    let args: string[];
    if (process.platform === "darwin") {
      bin = "/usr/bin/caffeinate";
      // `-w <pid>`：本 server 进程一退出 caffeinate 自己跟着退。server 被 SIGKILL / 崩溃 /
      // 退出看门狗强杀时（electron-app/main.js before-quit），我们的 stop() 来不及跑，
      // 没有 -w 就会留下孤儿 `caffeinate -s`，插电时整机从此不再睡眠。
      args = ["-s", "-w", String(process.pid)];
    } else if (process.platform === "win32") {
      bin = "powershell.exe";
      args = [
        "-NoProfile",
        "-NonInteractive",
        "-WindowStyle",
        "Hidden",
        "-Command",
        buildWinKeepAwakePs(process.pid),
      ];
    } else {
      log(`平台 ${process.platform} 暂不支持防睡眠，跳过`);
      return;
    }

    let child: ChildProcess;
    try {
      child = this.spawnImpl(bin, args, { stdio: "ignore" });
    } catch (e) {
      log(`启动防睡眠子进程失败: ${e}`);
      return;
    }
    this.child = child;
    log(`防睡眠已启动: pid=${child.pid}（仅接电源时阻止系统睡眠）`);

    // R1-8：exit/error 必须校验身份——stop→start 快切后旧 child 的迟到
    // exit 不得清掉新 child、也不得再排一次重启（否则双 caffeinate）
    child.on("error", (err) => {
      if (this.child !== child) return;
      log(`防睡眠子进程出错: ${err}`);
      this.child = null;
    });
    child.on("exit", () => {
      if (this.child !== child) return;
      this.child = null;
      // 意外退出自动重启；主动 stop 不重启
      if (!this.stopped) {
        log("防睡眠子进程意外退出，10s 后重启");
        setTimeout(() => {
          if (!this.stopped) this.start();
        }, 10_000).unref?.();
      }
    });
  };

  stop = (): void => {
    this.stopped = true;
    if (!this.child) return;
    try {
      this.child.kill();
    } catch {
      // 进程可能已退出
    }
    this.child = null;
    log("防睡眠已停止");
  };
}
