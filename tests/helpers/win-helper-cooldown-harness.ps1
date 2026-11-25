param(
  [Parameter(Mandatory = $true)][string]$Source,
  [Parameter(Mandatory = $true)][string]$WorkDir
)
# 把 FlowshipUnlockHelper.cs 里真实的 Cooldown 类抠出来，配上最小桩（Const / Paths / Log），在 PowerShell 7（.NET）里真跑：
# 用 POSIX 文件权限模拟「状态文件读不了 / 删不掉 / 改不了」。只验 Cooldown 自己的状态机，不碰 Windows 专有的部分（那些要真机）。
# 由 tests/desktop-win-helper-pwsh.test.ts 调用；最后一行 RESULT_JSON:[{id,ok,detail}, …] 是结果。
$ErrorActionPreference = 'Stop'
$text = [IO.File]::ReadAllText($Source)
$start = $text.IndexOf('internal static class Cooldown')
$end = $text.IndexOf('/// <summary>系统 API 声明</summary>')
if ($start -lt 0 -or $end -lt $start) { throw '找不到 Cooldown 类' }
$cooldownSrc = $text.Substring($start, $end - $start)

# 第六轮评审 P2-3：凭据存取 CredStore 也抠出来真跑（有没有 / 读 / 写 / 删的文件系统语义）。它在 Cooldown 前面；
# 结尾要把 Cooldown 的 doc 注释（紧挨在 Cooldown 类上面）去掉，只留 CredStore 自己
$credStart = $text.IndexOf('internal static class CredStore')
$credEnd = $text.LastIndexOf('/// <summary>', $start, [StringComparison]::Ordinal)
if ($credStart -lt 0 -or $credEnd -lt $credStart) { throw '找不到 CredStore 类' }
$credSrc = $text.Substring($credStart, $credEnd - $credStart)

$harness = @"
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Security.Cryptography;
using System.Text;
// 真实代码里是 const int；桩里改成可变的静态字段，好让夹紧的场景把窗口缩到 2 秒（不然得真等 10 分钟）。Cooldown 里的用法（Const.CooldownSeconds 当 int 用）两者一样
internal static class Const { internal static int CooldownSeconds = 600; }
// Cred 在真实代码里是只读属性（拼出 cred.bin 的路径）；桩里改成可设置的字段，每个场景指向自己的临时目录
internal static class Paths { internal static string State = null; internal static string Cred = null; }
internal static class Log
{
    internal static List<string> Lines = new List<string>();
    internal static void Write(string level, string message) { Lines.Add(level + ":" + message); }
}
$cooldownSrc
// 桩：真实代码用 Windows 数据保护（DPAPI），这里没有。「加密」恒等——CredStore 的有没有 / 读 / 写 / 删只关心文件系统行为，加密本身要真机才能验
namespace System.Security.Cryptography
{
    internal enum DataProtectionScope { CurrentUser = 0, LocalMachine = 1 }
    internal static class ProtectedData
    {
        internal static byte[] Protect(byte[] userData, byte[] optionalEntropy, DataProtectionScope scope) { return (byte[])userData.Clone(); }
        internal static byte[] Unprotect(byte[] encryptedData, byte[] optionalEntropy, DataProtectionScope scope) { return (byte[])encryptedData.Clone(); }
    }
}
$credSrc
public static class Probe
{
    public static void SetCred(string path) { Paths.Cred = path; }
    public static bool CredExists() { return CredStore.Exists(); }
    // 读出加密字节的长度；没有 = -1；读不了会抛（由调用方判断抛没抛）
    public static int CredReadLen() { byte[] b = CredStore.ReadSealed(); return b == null ? -1 : b.Length; }
    public static bool CredLoadIsNull() { return CredStore.Load() == null; }
    // 只回「读出来的是不是这个」，不把内容带回 PowerShell 的输出
    public static bool CredLoadEquals(string expected) { char[] c = CredStore.Load(); return c != null && new string(c) == expected; }
    public static void CredSave(string pw) { CredStore.Save(pw.ToCharArray()); }
    public static void CredDelete() { CredStore.Delete(); }
    public static void SetState(string path) { Paths.State = path; }
    public static void SetCooldownSeconds(int seconds) { Const.CooldownSeconds = seconds; }
    public static double RemainingSeconds() { return Cooldown.Remaining().TotalSeconds; }
    public static void Start() { Cooldown.Start(); }
    public static bool Clear() { return Cooldown.Clear(); }
    public static int StillBlockedSeconds() { return Cooldown.StillBlockedSeconds(); }
    public static int LogCount(string needle) { int n = 0; foreach (string l in Log.Lines) if (l.Contains(needle)) n++; return n; }
    public static void ResetLog() { Log.Lines.Clear(); }
}
"@

Add-Type -TypeDefinition $harness -Language CSharp

$results = New-Object System.Collections.ArrayList
function Check([string]$id, [bool]$cond, [string]$detail = '') {
  [void]$script:results.Add([pscustomobject]@{ id = $id; ok = $cond; detail = $detail })
}
function Fresh([string]$tag) {
  $dir = Join-Path $WorkDir $tag
  New-Item -ItemType Directory -Path $dir | Out-Null
  [Probe]::SetState((Join-Path $dir 'cooldown.state'))
  [Probe]::ResetLog()
  return $dir
}
function Now() { return [DateTime]::UtcNow }
function FreshCred([string]$tag) {
  $dir = Join-Path $WorkDir $tag
  New-Item -ItemType Directory -Path $dir | Out-Null
  [Probe]::SetCred((Join-Path $dir 'cred.bin'))
  return $dir
}
function Throws([scriptblock]$body) {
  try { & $body | Out-Null; return $false } catch { return $true }
}

try {
  # 没有记录 → 没有冷却
  $d = Fresh 'none'
  Check 'none-is-zero' ([Probe]::RemainingSeconds() -eq 0)

  # Start → 约 600 秒；Clear → true 且归零、文件被删
  [Probe]::Start()
  $s = [Probe]::RemainingSeconds()
  Check 'start-is-full-window' ($s -gt 595 -and $s -le 600) "got $s"
  Check 'clear-returns-true' ([Probe]::Clear())
  Check 'clear-resets' ([Probe]::RemainingSeconds() -eq 0)
  Check 'clear-deletes-file' (-not (Test-Path (Join-Path $d 'cooldown.state')))

  # 状态文件读不了（chmod 000），修改时间在 100 秒前 → 从修改时间起算：约 500 秒，不是每次都回整段 600
  $d = Fresh 'unreadable'
  $state = Join-Path $d 'cooldown.state'
  [IO.File]::WriteAllText($state, (Now).AddSeconds(500).Ticks.ToString())
  [IO.File]::SetLastWriteTimeUtc($state, (Now).AddSeconds(-100))
  & chmod 000 $state
  $s = [Probe]::RemainingSeconds()
  Check 'unreadable-counts-down-from-mtime' ($s -gt 495 -and $s -le 501) "got $s"
  Start-Sleep -Seconds 2
  $s2 = [Probe]::RemainingSeconds()
  Check 'unreadable-keeps-counting-down' ($s2 -lt ($s - 1.5)) "before $s after $s2"
  [void][Probe]::RemainingSeconds()
  [void][Probe]::RemainingSeconds()
  Check 'unreadable-logs-once' ([Probe]::LogCount('读冷却状态失败') -eq 1) ('count=' + [Probe]::LogCount('读冷却状态失败'))

  # 修改时间在 700 秒前（整段冷却早该结束）→ 0 秒；旧写法这里恒为 600
  & chmod 600 $state
  [IO.File]::SetLastWriteTimeUtc($state, (Now).AddSeconds(-700))
  & chmod 000 $state
  Check 'unreadable-expires' ([Probe]::RemainingSeconds() -eq 0)

  # 又能读了：按文件里的截止时刻；记忆作废，下一次读不了会重新记一条日志
  & chmod 644 $state
  [IO.File]::WriteAllText($state, (Now).AddSeconds(300).Ticks.ToString())
  $s = [Probe]::RemainingSeconds()
  Check 'readable-again-uses-file' ($s -gt 295 -and $s -le 300) "got $s"
  [Probe]::ResetLog()
  & chmod 000 $state
  [void][Probe]::RemainingSeconds()
  Check 'unreadable-log-rearms' ([Probe]::LogCount('读冷却状态失败') -eq 1) ('count=' + [Probe]::LogCount('读冷却状态失败'))
  & chmod 644 $state

  # 删不掉但改得了（目录只读、文件可写）→ 改写成 0 标记：Clear 返回 true，Remaining 为 0
  $d = Fresh 'overwrite'
  $state = Join-Path $d 'cooldown.state'
  [IO.File]::WriteAllText($state, (Now).AddSeconds(400).Ticks.ToString())
  & chmod 555 $d
  $ok = [Probe]::Clear()
  Check 'clear-overwrites-marker-returns-true' $ok
  Check 'clear-marker-content-is-zero' ((Test-Path $state) -and ([IO.File]::ReadAllText($state).Trim() -eq '0'))
  Check 'marker-means-no-cooldown' ([Probe]::RemainingSeconds() -eq 0)
  & chmod -R u+rwx $d

  # 删不掉也改不了（目录只读 + 文件只读）→ Clear 返回 false，旧冷却照旧生效
  $d = Fresh 'stuck'
  $state = Join-Path $d 'cooldown.state'
  [IO.File]::WriteAllText($state, (Now).AddSeconds(400).Ticks.ToString())
  & chmod 444 $state
  & chmod 555 $d
  $ok = [Probe]::Clear()
  Check 'clear-stuck-returns-false' (-not $ok)
  $s = [Probe]::RemainingSeconds()
  Check 'clear-stuck-cooldown-remains' ($s -gt 395 -and $s -le 400) "got $s"
  # v3：Clear 失败 + 状态文件是未来时间戳 → 冷却确实还在，DoSet 要回 COOLDOWN_NOT_CLEARED（StillBlockedSeconds 大于 0，约 400）
  $b = [Probe]::StillBlockedSeconds()
  Check 'clear-stuck-future-still-blocked-positive' ($b -gt 395 -and $b -le 401) "got $b"
  & chmod -R u+rwx $d

  # v3（DoSet 误报）：删不掉也改不了，但状态文件里只是一个早已过期的时间戳 → Clear 返回 false，可是根本没有冷却在生效：
  # StillBlockedSeconds 必须是 0（DoSet 据此只记日志、回 OK，不回 COOLDOWN_NOT_CLEARED）
  $d = Fresh 'stuck-expired'
  $state = Join-Path $d 'cooldown.state'
  [IO.File]::WriteAllText($state, (Now).AddSeconds(-100).Ticks.ToString())
  & chmod 444 $state
  & chmod 555 $d
  $ok = [Probe]::Clear()
  Check 'clear-stuck-expired-returns-false' (-not $ok)
  $s = [Probe]::RemainingSeconds()
  Check 'clear-stuck-expired-no-cooldown' ($s -eq 0) "got $s"
  $b = [Probe]::StillBlockedSeconds()
  Check 'clear-stuck-expired-still-blocked-is-zero' ($b -eq 0) "got $b"
  & chmod -R u+rwx $d

  # 内容读不懂（乱码）→ 从修改时间起算
  $d = Fresh 'garbage'
  $state = Join-Path $d 'cooldown.state'
  [IO.File]::WriteAllText($state, 'not-a-number')
  [IO.File]::SetLastWriteTimeUtc($state, (Now).AddSeconds(-200))
  $s = [Probe]::RemainingSeconds()
  Check 'garbage-counts-from-mtime' ($s -gt 395 -and $s -le 401) "got $s"

  # 内存里的冷却：状态文件被删了，这次运行期间仍然有效；Clear 连内存一起清
  $d = Fresh 'memory'
  [Probe]::Start()
  Remove-Item (Join-Path $d 'cooldown.state') -Force
  $s = [Probe]::RemainingSeconds()
  Check 'memory-survives-file-deletion' ($s -gt 595) "got $s"
  [void][Probe]::Clear()
  Check 'clear-clears-memory' ([Probe]::RemainingSeconds() -eq 0)

  # —— 第四轮评审：封顶 → 夹紧 ——
  # 读到远未来的截止时刻（状态文件被改过 / 时钟被往回拨过）：旧写法每次都回满格（封顶），冷却永远结束不了；
  # 现在第一次发现时夹成「那一刻 + 一整段」并固定下来，之后会倒计时、会结束。窗口临时缩成 2 秒，免得真等 10 分钟
  [Probe]::SetCooldownSeconds(2)
  $d = Fresh 'clamp'
  $state = Join-Path $d 'cooldown.state'
  [IO.File]::WriteAllText($state, (Now).AddDays(365).Ticks.ToString())
  $s1 = [Probe]::RemainingSeconds()
  Check 'far-future-is-clamped-to-one-window' ($s1 -gt 0.5 -and $s1 -le 2.0) "got $s1"
  Start-Sleep -Milliseconds 1000
  $s2 = [Probe]::RemainingSeconds()
  Check 'clamped-keeps-counting-down' ($s2 -lt ($s1 - 0.8)) "before $s1 after $s2"
  Start-Sleep -Milliseconds 1500
  $s3 = [Probe]::RemainingSeconds()
  Check 'clamped-expires' ($s3 -eq 0) "got $s3"

  # 夹紧的记忆只由 Start / Clear 重置。冷却走完之后又来了一次新的失败（Start），状态文件随后又被写成远未来：要重新夹成新的一整段，
  # 不能沿用旧的（已过期的）夹紧值——那样新的冷却会被当场判成「已结束」
  [Probe]::Start()
  Start-Sleep -Milliseconds 2300   # 等 Start 记下的 2 秒冷却（内存里那份）自然走完，免得它顶着、掩盖夹紧值的差别
  [IO.File]::WriteAllText($state, (Now).AddDays(365).Ticks.ToString())
  $s4 = [Probe]::RemainingSeconds()
  Check 'clamp-rearms-after-start' ($s4 -gt 0.5 -and $s4 -le 2.0) "got $s4"

  # Clear 同样重置：上面刚夹出的那份等它过期，Clear 一下，状态文件再写成远未来 → 还是重新夹成新的一整段
  Start-Sleep -Milliseconds 2300
  [void][Probe]::Clear()
  [IO.File]::WriteAllText($state, (Now).AddDays(365).Ticks.ToString())
  $s5 = [Probe]::RemainingSeconds()
  Check 'clamp-rearms-after-clear' ($s5 -gt 0.5 -and $s5 -le 2.0) "got $s5"

  # —— 第四轮评审：File.Exists 吞权限错误 ——
  # 状态文件在、但所在目录没有「进入」权限（chmod 000）：File.Exists 对这种情况也返回 false。旧写法把它当成「没有冷却」（少冷却），
  # Clear 则当成「已经清掉了」并返回 true（谎报）。现在：看不见 = 读不了，要有冷却，Clear 要如实返回 false
  [Probe]::SetCooldownSeconds(600)
  $d = Fresh 'hidden'
  $state = Join-Path $d 'cooldown.state'
  [IO.File]::WriteAllText($state, (Now).AddSeconds(300).Ticks.ToString())
  & chmod 000 $d
  $s6 = [Probe]::RemainingSeconds()
  Check 'hidden-state-file-still-cools-down' ($s6 -gt 0) "got $s6"
  $cleared = [Probe]::Clear()
  Check 'hidden-state-file-clear-returns-false' (-not $cleared)
  # v3：读不了 ≠ 没有冷却——Clear 失败后目录仍看不见，StillBlockedSeconds 也必须大于 0（不能因为「读不到记录」就当成已过期而回 OK）
  $b2 = [Probe]::StillBlockedSeconds()
  Check 'hidden-state-file-still-blocked-positive' ($b2 -gt 0) "got $b2"
  & chmod 755 $d

  # —— 第四轮评审：时钟被往回拨 ——
  # 已经固定下来的夹紧值（那一刻 + 一整段）比「现在 + 一整段」还远——系统时钟往回拨过就会这样：要重新压到新的上限，不能让冷却被拉长。
  # 真往回拨系统时钟做不到，这里把「一整段」从 600 秒缩成 2 秒，等价地造出「固定值 > 现在 + 一整段」
  $d = Fresh 'rewind'
  $state = Join-Path $d 'cooldown.state'
  [void][Probe]::Clear()   # 内存冷却和夹紧的记忆都归零，从头来
  [Probe]::SetCooldownSeconds(600)
  [IO.File]::WriteAllText($state, (Now).AddDays(365).Ticks.ToString())
  $s7 = [Probe]::RemainingSeconds()
  Check 'rewind-first-clamp-is-full-window' ($s7 -gt 590 -and $s7 -le 600.0) "got $s7"
  [Probe]::SetCooldownSeconds(2)
  $s8 = [Probe]::RemainingSeconds()
  Check 'rewind-reclamps-to-new-window' ($s8 -gt 0.5 -and $s8 -le 2.0) "got $s8"

  # —— 第六轮评审 P2-3：凭据「有没有」不再用 File.Exists ——
  # 旧写法（Exists / Load 里 File.Exists、Save 里按它挑 Replace / Move）遇到「目录没权限 / 看不见」：Exists 回 false、Load 回 null，
  # 状态页显示「未保存」、解锁回 NO_CREDENTIAL（白白让用户去重新保存），而密码其实还在。
  # 现在：看不见 = 可能有（Exists 回 true），读不了就抛（走调用方的「读不出来」分支）；只有文件 / 目录不存在才算没有。
  # 这里的「加密」是恒等桩（真实 DPAPI 要 Windows），只验文件系统语义。下面的密码都是桩里的假字符串，不是任何真实密码
  $pw1 = 'harness-fake-pw-1'
  $pw2 = 'harness-fake-pw-2'

  # 没有文件（目录在）：没有，不抛
  $d = FreshCred 'cred-none'
  $cred = Join-Path $d 'cred.bin'
  Check 'cred-none-exists-false' (-not [Probe]::CredExists())
  Check 'cred-none-read-null' ([Probe]::CredReadLen() -eq -1)
  Check 'cred-none-load-null' ([Probe]::CredLoadIsNull())

  # 目录都不存在：同样是没有（DirectoryNotFound），不抛
  [Probe]::SetCred((Join-Path $d 'no-such-dir/cred.bin'))
  Check 'cred-missing-dir-exists-false' (-not [Probe]::CredExists())
  Check 'cred-missing-dir-read-null' ([Probe]::CredReadLen() -eq -1)
  Check 'cred-missing-dir-load-null' ([Probe]::CredLoadIsNull())
  [Probe]::SetCred($cred)

  # 第一次保存（目标不存在）：Replace 失败 → Move 成功；读回一致；临时文件不留
  [Probe]::CredSave($pw1)
  Check 'cred-first-save-exists' ([Probe]::CredExists())
  Check 'cred-first-save-roundtrips' ([Probe]::CredLoadEquals($pw1))
  Check 'cred-first-save-no-tmp-left' (-not (Test-Path ($cred + '.tmp')))

  # 再保存（目标在）：Replace 成功，新值生效，临时文件不留
  [Probe]::CredSave($pw2)
  Check 'cred-overwrite-roundtrips-new' ([Probe]::CredLoadEquals($pw2))
  Check 'cred-overwrite-no-tmp-left' (-not (Test-Path ($cred + '.tmp')))

  # 看不见（目录没有「进入」权限）：Exists 必须回 true（旧写法回 false）；读 / 载入要抛，不能回 null（回 null = 调用方回 NO_CREDENTIAL）
  & chmod 000 $d
  Check 'cred-hidden-exists-true' ([Probe]::CredExists())
  Check 'cred-hidden-read-throws' (Throws { [void][Probe]::CredReadLen() })
  Check 'cred-hidden-load-throws' (Throws { [void][Probe]::CredLoadIsNull() })
  & chmod 755 $d
  Check 'cred-visible-again-still-there' ([Probe]::CredLoadEquals($pw2))

  # 文件在、但文件本身读不了（chmod 000）：Exists 回 true；读 / 载入抛，同样不回 null
  & chmod 000 $cred
  Check 'cred-unreadable-file-exists-true' ([Probe]::CredExists())
  Check 'cred-unreadable-file-load-throws' (Throws { [void][Probe]::CredLoadIsNull() })
  & chmod 600 $cred

  # Replace 失败、而目标其实存在：Save 要抛（Move 在目标在时一定抛），不能悄悄覆盖，也不能谎报成功。
  # 用「目标是个目录」造出 Replace 失败（Windows 上对应「目标被占用」）
  $d = FreshCred 'cred-replace-fails'
  $cred = Join-Path $d 'cred.bin'
  New-Item -ItemType Directory -Path $cred | Out-Null
  Check 'cred-save-onto-existing-throws' (Throws { [Probe]::CredSave($pw1) })
  Check 'cred-save-failed-target-untouched' (Test-Path -PathType Container $cred)
  # 注意：「Save 不再按 File.Exists 挑 Replace / Move」这一点在这里造不出行为差异——写临时文件和目标在同一个目录，
  # 「写得了临时文件、却看不见目标」在 POSIX 权限下不可能；悬空链接也不行（.NET 在 Unix 上对悬空链接的 File.Exists 回 true）。
  # 所以这一处只由 desktop-win-helper-protocol.test.ts 的结构断言守着（整个 CredStore 不含 File.Exists + WriteSealed 的形状），
  # 真机上的表现没验证过

  # 删：文件在 → 删掉、Exists 回 false；本来就没有 → 不抛
  $d = FreshCred 'cred-delete'
  [Probe]::CredSave($pw1)
  [Probe]::CredDelete()
  Check 'cred-delete-removes' (-not [Probe]::CredExists())
  Check 'cred-delete-when-none-ok' (-not (Throws { [Probe]::CredDelete() }))
}
finally {
  # 把权限放回来，让外面的临时目录清理得掉
  & chmod -R u+rwx $WorkDir
}

Write-Output ('RESULT_JSON:' + (ConvertTo-Json -InputObject @($results) -Compress))
