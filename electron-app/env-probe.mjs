/**
 * Windows 机器环境取证（脚本常量 + 纯函数、无 electron 依赖，可被 vitest 直接单测）。
 *
 * 为什么要这份：同一份安装包在不同机器上启动 / 安装耗时能差一个数量级，原因都不在我们的代码里，
 * 而在「这台机器」：系统盘是机械硬盘还是 SSD、Defender 实时防护开没开、是不是插着电却在省电模式 /
 * 电池供电（CPU 被降频）、CPU 实际频率。杀软清单（security-products.mjs）只回答「装了谁」，
 * 这里补「它在不在工作」和「硬件被卡在哪」。
 *
 * 约定与 security-products.mjs 一致（理由见那个文件的头注释）：
 * - 脚本只含 ASCII、只用单引号（不含双引号）——避免 argv 引号转义、以及脚本文本被代码页吃掉；
 * - 每一段取证各自 try/catch：某个 cmdlet 不可用（Server 版 / 权限 / 服务没起）只丢这一行；
 * - 每一行结果「立刻」以 `L:<base64(UTF-8)>` 单独输出：超时被杀时 Node 仍能拿到已经输出的部分；
 * - ⚠️ 不能用 `;` 把 `try {}` 和 `catch {}` 隔开（PowerShell 会把 catch 当成孤立语法错误），
 *   所以下面每个 try/catch 是一个整段、段与段之间才用 `; ` 连接。
 * 纯取证：只读、后台、超时自杀，结果只进日志，不影响任何行为。
 */

/** 探测总超时。比杀软清单更宽：Get-Partition / Get-PhysicalDisk 走存储管理 CIM，冷启动可能要几秒。 */
export const ENV_PROBE_TIMEOUT_MS = 20_000;

/** 最多探测几个盘（安装目录 / 用户数据目录 / 临时目录，去重后通常 1~2 个）。 */
const MAX_DRIVES = 4;

/**
 * 这一次启动要不要跑环境取证（只决定「跑不跑」，跑什么见 buildEnvProbeScript）。
 *
 * 只在两种情况下跑：
 * - 首次启动（全新安装 / 刚更新 / 刚重装，按版本判定）：对杀软来说 exe 与 ~1 万个新文件都没见过，
 *   慢启动最集中、也最需要「这台机器是什么环境」来解读；
 * - 这次启动本身偏慢（亮窗用时超过 slowMs）：非首次却慢，正是要查「盘 / 电源 / Defender」的时候。
 * 其余正常启动不拉起 PowerShell：应用没签名，公司电脑上的杀软 / EDR 可能对「未签名程序反复拉起
 * PowerShell」报警，而正常启动拿到这些数据也没有用。
 *
 * 亮窗用时拿不到（缺失 / 非有限）按「不慢」处理：没有证据说慢，就不去惊动杀软。
 *
 * @param {{ firstBoot: boolean, revealSeconds?: number | null, slowMs: number }} p
 *   revealSeconds：亮窗时刻距主进程启动的秒数（boot 时间线的 reveal 里程碑）
 * @returns {{ run: boolean, why: "first-boot" | "slow-boot" | "normal-boot" }}
 */
export const decideEnvProbe = ({ firstBoot, revealSeconds, slowMs }) => {
  if (firstBoot === true) return { run: true, why: "first-boot" };
  const slow =
    typeof revealSeconds === "number" && Number.isFinite(revealSeconds) && revealSeconds * 1000 > slowMs;
  return slow ? { run: true, why: "slow-boot" } : { run: false, why: "normal-boot" };
};

/** 取路径的盘符（"C:\\x" → "C"）；不是盘符路径（UNC / 空）返回 null。 */
export const driveLetterOf = (p) =>
  typeof p === "string" && /^[A-Za-z]:/.test(p) ? p[0].toUpperCase() : null;

const unavailable = (what) =>
  `catch { E ('${what} unavailable ' + $_.Exception.GetType().Name) }`;

/**
 * 生成 PowerShell 脚本。drives 里只接受单个字母（其余丢弃——脚本里会直接嵌进去，不能留注入口）。
 * @param {{ drives?: string[] }} [opts]
 */
export const buildEnvProbeScript = ({ drives = [] } = {}) => {
  const letters = [
    ...new Set(drives.filter((d) => typeof d === "string" && /^[A-Za-z]$/.test(d)).map((d) => d.toUpperCase())),
  ].slice(0, MAX_DRIVES);
  const driveList = letters.length > 0 ? `@(${letters.map((d) => `'${d}'`).join(",")})` : "@()";

  const segments = [
    "$ErrorActionPreference = 'Stop'",
    // E：输出一行结果（base64 避开 OEM 代码页乱码，见 security-products.mjs）
    "function E($s) { 'L:' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$s)) }",
    // Defender 实时防护：on-access 扫描就是「首次读文件被拦下来」的那只手
    "try { $s = Get-MpComputerStatus; " +
      "E ('defender av={0} rtp={1} onAccess={2} mode={3} tamper={4} sigAgeDays={5}' " +
      "-f $s.AntivirusEnabled, $s.RealTimeProtectionEnabled, $s.OnAccessProtectionEnabled, " +
      "$s.AMRunningMode, $s.IsTamperProtected, $s.AntivirusSignatureAge) } " +
      unavailable("defender"),
    // CPU：当前频率 vs 最大频率（长期远低于最大 = 被降频）；物理核 / 逻辑核
    "try { $c = @(Get-CimInstance Win32_Processor)[0]; " +
      "E ('cpu cur={0}MHz max={1}MHz cores={2} logical={3} name={4}' " +
      "-f $c.CurrentClockSpeed, $c.MaxClockSpeed, $c.NumberOfCores, $c.NumberOfLogicalProcessors, " +
      "([string]$c.Name).Trim()) } " +
      unavailable("cpu"),
    // 整机型号：低端机 / 老机型一眼可见
    "try { $m = Get-CimInstance Win32_ComputerSystem; " +
      "E ('machine mfr={0} model={1}' -f ([string]$m.Manufacturer).Trim(), ([string]$m.Model).Trim()) } " +
      unavailable("machine"),
    // 电源计划（本地化名字会被代码页弄乱，所以取 GUID 再映射成英文名）
    "try { $pp = (powercfg /getactivescheme | Out-String); " +
      "$g = [regex]::Match($pp, '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}').Value; " +
      "$names = @{ '381b4222-f694-41f0-9685-ff5bb260df2e' = 'Balanced'; " +
      "'8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c' = 'HighPerformance'; " +
      "'a1841308-3541-4fab-bc81-f71556f20b4a' = 'PowerSaver'; " +
      "'e9a42b02-d5df-448d-aa00-03f14749eb61' = 'UltimatePerformance' }; " +
      "$n = $names[$g.ToLower()]; if (-not $n) { $n = 'custom' }; " +
      "E ('power plan={0} guid={1}' -f $n, $g) } " +
      unavailable("power"),
    // 电池：台式机没有；笔记本「电池供电 + 省电」是启动慢的常见原因
    "try { $b = @(Get-CimInstance Win32_Battery); " +
      "if ($b.Count -eq 0) { E 'battery none' } else { " +
      "$st = 'other'; if ($b[0].BatteryStatus -eq 1) { $st = 'on-battery' } elseif ($b[0].BatteryStatus -eq 2) { $st = 'on-ac' }; " +
      "E ('battery {0} charge={1}%' -f $st, $b[0].EstimatedChargeRemaining) } } " +
      unavailable("battery"),
    // 各盘：介质（SSD / HDD）、总线、文件系统、容量与余量。机械盘上 ~1 万个小文件的创建 / 首次读天然慢
    `foreach ($d in ${driveList}) { try { ` +
      "$p = Get-Partition -DriveLetter $d | Get-Disk | Get-PhysicalDisk; " +
      "$v = Get-Volume -DriveLetter $d; " +
      "E ('disk {0}: media={1} bus={2} health={3} fs={4} sizeGB={5} freeGB={6}' " +
      "-f $d, $p.MediaType, $p.BusType, $p.HealthStatus, $v.FileSystem, " +
      "[math]::Round($p.Size / 1GB), [math]::Round($v.SizeRemaining / 1GB, 1)) } " +
      "catch { E ('disk ' + $d + ': unavailable ' + $_.Exception.GetType().Name) } }",
  ];
  return segments.join("; ");
};

/** 控制字符一律换成空格并截断：日志里一行就是一行。 */
const cleanLine = (s, max = 200) =>
  String(s ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, max);

const sanitize = (s, max) =>
  String(s ?? "")
    .replace(/[^\x20-\x7e]/g, "?")
    .trim()
    .slice(0, max);

const MAX_LINES = 20;

/**
 * 解析 execFile 回调的 (err, stdout)。超时被杀时 stdout 里已输出的行仍然有效，所以先解析行、再看 err。
 * @param {(Error & { killed?: boolean, signal?: string | null, code?: string | number | null }) | null} err
 * @param {string | Buffer | undefined} stdout
 * @returns {{ kind: "ok" | "timeout" | "exec-error" | "unparsable", lines: string[], detail?: string }}
 */
export const parseEnvProbe = (err, stdout) => {
  const text = String(stdout ?? "");
  const lines = [];
  for (const raw of text.split(/\r?\n/)) {
    // trim() 会一并去掉 BOM
    const t = raw.trim();
    if (!t.startsWith("L:")) continue;
    const decoded = cleanLine(Buffer.from(t.slice(2).trim(), "base64").toString("utf8"));
    if (decoded) lines.push(decoded);
    if (lines.length >= MAX_LINES) break;
  }
  if (err) {
    if (err.killed === true || err.signal) return { kind: "timeout", lines };
    const code = err.code;
    const detail = typeof code === "number" ? `exit ${code}` : sanitize(code ?? err.message ?? "unknown", 60);
    return { kind: "exec-error", lines, detail };
  }
  if (lines.length === 0) return { kind: "unparsable", lines, detail: sanitize(text, 40) || "（空输出）" };
  return { kind: "ok", lines };
};

/** 给日志用：每个元素一行；失败 / 超时 / 部分结果各有一句说明，事后才分得清「没有」和「没查到」。 */
export const describeEnvProbe = (result) => {
  const out = [...result.lines];
  switch (result.kind) {
    case "ok":
      break;
    case "timeout":
      out.push(`（环境探测超过 ${ENV_PROBE_TIMEOUT_MS / 1000}s 被放弃，上面是已拿到的 ${result.lines.length} 行）`);
      break;
    case "exec-error":
      out.push(`（无法运行 PowerShell：${result.detail}；已拿到 ${result.lines.length} 行）`);
      break;
    default:
      out.push(`（输出无法解析：${result.detail}）`);
  }
  return out;
};
