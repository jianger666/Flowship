# Flowship 解锁组件：安装 / 升级脚本（Windows PowerShell 5.1）。
#
# 不要直接运行它。installer.mjs 的引导程序会在「已获得管理员权限 + 本文件 SHA-256 校验通过」之后把它读进内存执行
# （原理见 scripts/lib/win-helper-hashes.mjs）。它做的事，过程全部记在 public\install.log 里，用户随时能看：
#   1. 目录：Program Files\Flowship\unlock 放程序（普通用户不可写）；ProgramData\Flowship\unlock 放数据
#      （加密后的开机密码等，只有 SYSTEM / 管理员能读），其中 public 子目录普通用户只读（管道名、日志）。
#   2. 把发起安装的 Windows 账户（SID）登记进 config.txt：组件只接受这一个账户连它的管道。
#   3. 用系统自带的 C# 编译器把 FlowshipUnlockHelper.cs 编成 exe（编译用的临时目录指到只有管理员能写的 data\build，编完删掉），
#      先跑一次 selftest（不碰任何真实凭据；它也会确认这台电脑读得出「会话是否锁定」，读不出来就装了也没法安全解锁）。
#   环境变量不可信：装到哪里（Program Files / ProgramData）用系统接口取，不读 %ProgramFiles% 之类——同一账户能预先改写它们。
#   4. 建计划任务「\Flowship\Flowship Unlock Helper」（SYSTEM 身份、开机启动），立刻启动，等它把管道名写出来。
#
# 失败一律以固定的退出码结束（和 protocol.mjs 的 ADMIN_EXIT 对账，单测逐项检查）：
#   10 读不到源码  11 源码哈希不符  12 目录不可信且清理失败  13 设置目录权限失败  14 编译失败  15 selftest 失败
#   16 创建计划任务失败  17 组件没能启动  18 旧版没能停下来  19 未预期的错误  91 不是管理员  92 参数不合法  93 PowerShell 被策略限制
param(
  [Parameter(Mandatory = $true)][string]$Source,
  [Parameter(Mandatory = $true)][string]$SourceSha,
  [Parameter(Mandatory = $true)][string]$Sid
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$script:LogFile = $null

function Write-Log([string]$Message) {
  if (-not $script:LogFile) { return }
  try {
    $line = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' ' + $Message + "`r`n"
    [IO.File]::AppendAllText($script:LogFile, $line, (New-Object Text.UTF8Encoding($false)))
  } catch { }
}

function Fail([int]$Code, [string]$Message) {
  Write-Log ('失败（退出码 ' + $Code + '）：' + $Message)
  exit $Code
}

function Get-Sha256Hex([byte[]]$Data) {
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($sha.ComputeHash($Data))).Replace('-', '') }
  finally { $sha.Dispose() }
}

function Test-Exists([string]$Path) {
  try { [void][IO.File]::GetAttributes($Path); return $true }
  catch [IO.FileNotFoundException] { return $false }
  catch [IO.DirectoryNotFoundException] { return $false }
}

# 递归删除；遇到链接（junction / symlink）只删链接本身、绝不进到目标里
function Remove-Tree([string]$Path) {
  $attr = [IO.File]::GetAttributes($Path)
  if ($attr -band [IO.FileAttributes]::ReparsePoint) {
    if ($attr -band [IO.FileAttributes]::Directory) { [IO.Directory]::Delete($Path) } else { [IO.File]::Delete($Path) }
    return
  }
  if ($attr -band [IO.FileAttributes]::Directory) {
    foreach ($child in [IO.Directory]::GetFileSystemEntries($Path)) { Remove-Tree $child }
    [IO.Directory]::Delete($Path)
  } else {
    [IO.File]::SetAttributes($Path, [IO.FileAttributes]::Normal)
    [IO.File]::Delete($Path)
  }
}

# 已经存在的目录要可信：不是链接，且所有者是 SYSTEM 或 Administrators 组（普通进程预先建好的目录所有者是它自己）
function Test-TrustedDir([string]$Dir) {
  $attr = [IO.File]::GetAttributes($Dir)
  if ($attr -band [IO.FileAttributes]::ReparsePoint) { return $false }
  $owner = (Get-Acl -LiteralPath $Dir).GetOwner([Security.Principal.SecurityIdentifier]).Value
  return ($owner -eq 'S-1-5-18' -or $owner -eq 'S-1-5-32-544')
}

# 建一个「只有 SYSTEM / 管理员能写」的目录（UsersRead 为真时普通用户可读）。已存在但不可信的先清掉再建；
# 建的时候就带着权限（不是先建再改），中间没有「谁都能往里放东西」的空档
function New-ProtectedDir([string]$Dir, [bool]$UsersRead) {
  if (Test-Exists $Dir) {
    if (-not (Test-TrustedDir $Dir)) {
      Write-Log ('目录 ' + $Dir + ' 是链接或不属于管理员，先清理再重建')
      try { Remove-Tree $Dir } catch { Fail 12 ('清理不可信的目录失败：' + $_.Exception.Message) }
    }
  }
  $security = New-Object Security.AccessControl.DirectorySecurity
  $security.SetAccessRuleProtection($true, $false)
  $inherit = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
  $propagation = [Security.AccessControl.PropagationFlags]::None
  $allow = [Security.AccessControl.AccessControlType]::Allow
  foreach ($sidText in @('S-1-5-18', 'S-1-5-32-544')) {
    $who = New-Object Security.Principal.SecurityIdentifier($sidText)
    $security.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($who, 'FullControl', $inherit, $propagation, $allow)))
  }
  if ($UsersRead) {
    $users = New-Object Security.Principal.SecurityIdentifier('S-1-5-32-545')
    $security.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($users, 'ReadAndExecute', $inherit, $propagation, $allow)))
  }
  try {
    if (Test-Exists $Dir) { [IO.Directory]::SetAccessControl($Dir, $security) }
    else { [void][IO.Directory]::CreateDirectory($Dir, $security) }
  } catch { Fail 13 ('设置目录权限失败 ' + $Dir + '：' + $_.Exception.Message) }
  try {
    $ownerOnly = New-Object Security.AccessControl.DirectorySecurity
    $ownerOnly.SetOwner((New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')))
    [IO.Directory]::SetAccessControl($Dir, $ownerOnly)
  } catch { Write-Log ('没能把 ' + $Dir + ' 的所有者设为管理员组（不影响使用）：' + $_.Exception.Message) }
}

# 上一层目录（ProgramData\Flowship / Program Files\Flowship）：存在就沿用（Program Files 下的别人动不了；
# ProgramData 下的要可信），不存在才建。ProgramData 默认谁都能往里建东西，所以那一层建出来就收紧
function Initialize-ParentDir([string]$Dir, [bool]$InProgramData) {
  if (Test-Exists $Dir) {
    if (-not $InProgramData) { return }
    if (Test-TrustedDir $Dir) { return }
    New-ProtectedDir $Dir $true
    return
  }
  if ($InProgramData) { New-ProtectedDir $Dir $true } else { [void][IO.Directory]::CreateDirectory($Dir) }
}

function Wait-ProcessGone([string]$Name, [int]$Seconds) {
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Process -Name $Name -ErrorAction SilentlyContinue) -and ((Get-Date) -lt $deadline)) { Start-Sleep -Milliseconds 300 }
  return (-not (Get-Process -Name $Name -ErrorAction SilentlyContinue))
}

# ── 前置检查 ──
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { Fail 91 '没有管理员权限' }
if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') { Fail 93 '系统策略把 PowerShell 限制成了受限语言模式' }
# 下面两条正则都用 \z（严格的字符串结尾，.NET 的 $ 会放过尾随换行）和 -cnotmatch（区分大小写，-notmatch 默认不区分），
# 数字用 [0-9]（.NET 的 \d 会匹配全角 / 阿拉伯数字），和 installer.mjs 里 JS 那一条严格程度一致
if ($SourceSha -cnotmatch '^[0-9A-Fa-f]{64}\z') { Fail 92 '源码哈希的格式不对' }
# 只登记普通用户账户（本地 / 域 / Azure AD）：Everyone、Users、Administrators 这类内置组一律拒绝，免得把管道开放给不该开放的人
if ($Sid -cnotmatch '^S-1-(5-21|12-1)(-[0-9]+){4}\z') { Fail 92 '要登记的账户不是普通用户账户' }

# 装到哪里不能听环境变量的：同一账户能预先改写自己的环境变量（%ProgramFiles% / %ProgramData% 都能被指到用户可写的目录），
# 而这里装的是以 SYSTEM 身份开机运行的程序。用系统接口取已知文件夹（Flowship 的 Windows 版只有 64 位，提权的 PowerShell 也是 64 位的）
$programFiles = [Environment]::GetFolderPath('ProgramFiles')
$programData = [Environment]::GetFolderPath('CommonApplicationData')
if (-not $programFiles -or -not $programData) { Fail 92 '读不到 ProgramFiles / ProgramData 目录' }

$installDir = Join-Path $programFiles 'Flowship\unlock'
$dataDir = Join-Path $programData 'Flowship\unlock'
$pubDir = Join-Path $dataDir 'public'
$exe = Join-Path $installDir 'FlowshipUnlockHelper.exe'
$taskName = 'Flowship Unlock Helper'
$taskPath = '\Flowship\'

try {
  # ── 1. 目录与权限 ──
  Initialize-ParentDir (Join-Path $programData 'Flowship') $true
  Initialize-ParentDir (Join-Path $programFiles 'Flowship') $false
  New-ProtectedDir $installDir $true
  New-ProtectedDir $dataDir $false
  New-ProtectedDir $pubDir $true

  $script:LogFile = Join-Path $pubDir 'install.log'
  [IO.File]::WriteAllText($script:LogFile, '', (New-Object Text.UTF8Encoding($false)))
  Write-Log ('开始安装。PowerShell ' + $PSVersionTable.PSVersion + '，系统 ' + [Environment]::OSVersion.VersionString + '，64 位系统=' + [Environment]::Is64BitOperatingSystem)

  try { $account = (New-Object Security.Principal.SecurityIdentifier($Sid)).Translate([Security.Principal.NTAccount]).Value }
  catch { $account = '(读不出账户名)' }
  Write-Log ('登记账户：' + $account)

  # ── 2. 读源码并校验：先换行统一成 LF、再算 SHA-256，和 Flowship 里写死的期望值对；对不上就不编译 ──
  try { $bytes = [IO.File]::ReadAllBytes($Source) } catch { Fail 10 ('读不到源码文件：' + $_.Exception.Message) }
  $text = [Text.Encoding]::UTF8.GetString($bytes)
  if ($text.Length -gt 0 -and $text[0] -eq [char]0xFEFF) { $text = $text.Substring(1) }
  $text = $text.Replace("`r`n", "`n")
  $got = Get-Sha256Hex ([Text.Encoding]::UTF8.GetBytes($text))
  if ($got -ne $SourceSha.ToUpperInvariant()) { Fail 11 '源码文件的 SHA-256 和期望值对不上，没有安装' }
  Write-Log '源码校验通过'

  # ── 3. 停掉旧版（升级 / 重装） ──
  $oldTask = Get-ScheduledTask -TaskName $taskName -TaskPath $taskPath -ErrorAction SilentlyContinue
  if ($oldTask) { try { Stop-ScheduledTask -InputObject $oldTask -ErrorAction SilentlyContinue } catch { } }
  Get-Process -Name 'FlowshipUnlockHelper' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  if (-not (Wait-ProcessGone 'FlowshipUnlockHelper' 10)) { Fail 18 '旧版组件的进程没有退出' }
  # 旧的管道名文件删掉：新组件起来之后才会重写它，免得读到上一次留下的旧名字
  $pipeFile = Join-Path $pubDir 'pipe.txt'
  if (Test-Exists $pipeFile) { [IO.File]::Delete($pipeFile) }

  # ── 4. 登记账户 ──
  [IO.File]::WriteAllText((Join-Path $dataDir 'config.txt'), $Sid, (New-Object Text.UTF8Encoding($false)))

  # ── 5. 编译：直接编到最终位置（旧 exe 已经没人占用）；失败时清掉半成品 ──
  # Add-Type 会先把源码和命令行（.cs / .cmdline）写进 %TEMP%，再交给 csc.exe 编译。提权进程继承的 %TEMP% 是用户自己的目录，
  # 同一账户下的进程在「写入 → 编译」的空档里换掉它，编出来（并以 SYSTEM 常驻）的就是别人的代码——前面对源码的哈希校验管不到这一步。
  # 所以编译前把 TEMP / TMP 指到只有管理员能写的私有目录（上一次残留的先清掉），编完不管成败都清掉。
  $buildDir = Join-Path $dataDir 'build'
  try { if (Test-Exists $buildDir) { Remove-Tree $buildDir } } catch { }
  New-ProtectedDir $buildDir $false
  $env:TEMP = $buildDir
  $env:TMP = $buildDir
  if (Test-Exists $exe) { [IO.File]::SetAttributes($exe, [IO.FileAttributes]::Normal); [IO.File]::Delete($exe) }
  try {
    Add-Type -TypeDefinition $text -Language CSharp -OutputAssembly $exe -OutputType WindowsApplication -ReferencedAssemblies @('System.Core', 'System.Security') -ErrorAction Stop
  } catch {
    $why = [string]$_.Exception.Message
    if ($why.Length -gt 3000) { $why = $why.Substring(0, 3000) }
    try { Remove-Tree $buildDir } catch { }
    Fail 14 ('编译失败：' + $why)
  }
  try { Remove-Tree $buildDir } catch { }
  if (-not (Test-Exists $exe)) { Fail 14 '编译没有报错，但没有生成 exe' }
  Write-Log '编译完成'

  # ── 6. selftest ──
  $probe = Start-Process -FilePath $exe -ArgumentList 'selftest' -Wait -PassThru -WindowStyle Hidden
  if ($probe.ExitCode -ne 0) { Fail 15 ('selftest 没通过，退出码 ' + $probe.ExitCode + '（也可能是被安全软件拦住了）') }
  Write-Log 'selftest 通过'

  # ── 7. 计划任务：SYSTEM、开机启动、崩了自动重启 ──
  try {
    $action = New-ScheduledTaskAction -Execute $exe -Argument 'service'
    $trigger = New-ScheduledTaskTrigger -AtStartup
    $taskPrincipal = New-ScheduledTaskPrincipal -UserId 'NT AUTHORITY\SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1)
    $description = 'Flowship 解锁组件：电脑锁屏时替 Flowship 在登录界面输入用户保存的开机密码，让 AI 能继续操作电脑。在 Flowship 设置的「电脑操作」里可以卸载。'
    Register-ScheduledTask -TaskName $taskName -TaskPath $taskPath -Action $action -Trigger $trigger -Principal $taskPrincipal -Settings $settings -Description $description -Force | Out-Null
  } catch { Fail 16 ('创建计划任务失败：' + $_.Exception.Message) }
  Write-Log '计划任务已创建'

  # ── 8. 启动并等它就绪（service 起来后会写出 pipe.txt） ──
  Start-ScheduledTask -TaskName $taskName -TaskPath $taskPath
  $deadline = (Get-Date).AddSeconds(20)
  while (-not (Test-Exists $pipeFile) -and ((Get-Date) -lt $deadline)) { Start-Sleep -Milliseconds 300 }
  if (-not (Test-Exists $pipeFile)) { Fail 17 '组件启动后 20 秒内没有就绪（可以看 helper.log）' }
  Write-Log '组件已启动并就绪'
} catch {
  Fail 19 ('未预期的错误：' + $_.Exception.Message)
}

Write-Log '安装完成'
exit 0
