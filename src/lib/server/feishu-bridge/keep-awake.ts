/**
 * 飞书桥接防睡眠（4.4c）
 *
 * 仅接电源时阻止系统睡眠；电池供电不偷电。
 * - macOS：`caffeinate -s`（-s 语义本身就是接电才生效）
 * - Windows：PowerShell + SetThreadExecutionState + 30s 电池轮询
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
const WIN_KEEP_AWAKE_PS = `
Add-Type -Name P -Namespace W -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);'
Add-Type -AssemblyName System.Windows.Forms
$held = $false
while ($true) {
  $ac = [System.Windows.Forms.SystemInformation]::PowerStatus.PowerLineStatus -eq 'Online'
  if ($ac -and -not $held) { [W.P]::SetThreadExecutionState(0x80000001) | Out-Null; $held = $true }
  elseif (-not $ac -and $held) { [W.P]::SetThreadExecutionState(0x80000000) | Out-Null; $held = $false }
  Start-Sleep -Seconds 30
}
`;

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
      args = ["-s"];
    } else if (process.platform === "win32") {
      bin = "powershell.exe";
      args = [
        "-NoProfile",
        "-NonInteractive",
        "-WindowStyle",
        "Hidden",
        "-Command",
        WIN_KEEP_AWAKE_PS,
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

    child.on("error", (err) => {
      log(`防睡眠子进程出错: ${err}`);
      this.child = null;
    });
    child.on("exit", () => {
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
