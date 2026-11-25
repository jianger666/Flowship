# Flowship 解锁组件：卸载脚本（Windows PowerShell 5.1）。
#
# 不要直接运行它。installer.mjs 的引导程序会在「已获得管理员权限 + 本文件 SHA-256 校验通过」之后把它读进内存执行。
# 做的事：停掉并删除计划任务「\Flowship\Flowship Unlock Helper」→ 结束组件进程 → 删除程序目录和数据目录
# （数据目录里有加密保存的开机密码，所以卸载 = 同时清掉保存的密码）。没有参数，也不接受任何外部输入。
#
# 数据目录马上要被删掉，没地方写日志；失败只用退出码说话（和 protocol.mjs 的 ADMIN_EXIT 对账，单测逐项检查）：
#   31 删除计划任务失败  32 删除目录失败（多半是文件被占用，重启电脑后再试）  91 不是管理员
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

function Fail([int]$Code, [string]$Message) {
  exit $Code
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

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { Fail 91 '没有管理员权限' }

# 要删哪里不能听环境变量的（同一账户能预先改写自己的环境变量，把 %ProgramFiles% / %ProgramData% 指到别处），和 install.ps1 一样用系统接口取已知文件夹
$programFiles = [Environment]::GetFolderPath('ProgramFiles')
$programData = [Environment]::GetFolderPath('CommonApplicationData')
# 读不到目录就没法定位要删的东西：明确失败，而不是让 Join-Path 抛未处理异常、以含糊的退出码 1 结束
if (-not $programFiles -or -not $programData) { Fail 32 '读不到 ProgramFiles / ProgramData 目录' }

$taskName = 'Flowship Unlock Helper'
$taskPath = '\Flowship\'
$installDir = Join-Path $programFiles 'Flowship\unlock'
$dataDir = Join-Path $programData 'Flowship\unlock'

try {
  # 1. 停任务、删任务（任务不存在就当已经删过了）
  $task = Get-ScheduledTask -TaskName $taskName -TaskPath $taskPath -ErrorAction SilentlyContinue
  if ($task) {
    try { Stop-ScheduledTask -InputObject $task -ErrorAction SilentlyContinue } catch { }
    try { Unregister-ScheduledTask -InputObject $task -Confirm:$false -ErrorAction Stop } catch { Fail 31 '删除计划任务失败' }
  }

  # 2. 结束进程，等它退出（exe 被占着是删不掉的）
  Get-Process -Name 'FlowshipUnlockHelper' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  $deadline = (Get-Date).AddSeconds(10)
  while ((Get-Process -Name 'FlowshipUnlockHelper' -ErrorAction SilentlyContinue) -and ((Get-Date) -lt $deadline)) { Start-Sleep -Milliseconds 300 }

  # 3. 删目录
  foreach ($dir in @($installDir, $dataDir)) {
    if (Test-Exists $dir) {
      try { Remove-Tree $dir } catch { Fail 32 ('删除目录失败：' + $dir) }
    }
  }

  # 4. 上一层目录是空的就顺手删掉（不空 = 别的东西在用，不碰；链接不碰）
  foreach ($parent in @((Join-Path $programData 'Flowship'), (Join-Path $programFiles 'Flowship'))) {
    try {
      if (Test-Exists $parent) {
        $attr = [IO.File]::GetAttributes($parent)
        if (-not ($attr -band [IO.FileAttributes]::ReparsePoint) -and ([IO.Directory]::GetFileSystemEntries($parent).Length -eq 0)) { [IO.Directory]::Delete($parent) }
      }
    } catch { }
  }

  # 5. 任务计划程序里留下的空文件夹「Flowship」也删掉（删不掉无所谓）
  try {
    $service = New-Object -ComObject 'Schedule.Service'
    $service.Connect()
    $root = $service.GetFolder('\')
    $folder = $root.GetFolder('Flowship')
    if ($folder.GetTasks(0).Count -eq 0) { $root.DeleteFolder('Flowship', 0) }
  } catch { }
} catch {
  Fail 32 '卸载时出现未预期的错误'
}

exit 0
