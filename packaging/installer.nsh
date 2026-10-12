; NSIS 安装钩子（electron-builder 自动 include buildResources/installer.nsh）
;
; 换 logo 后 Windows 老图标不更新的根因（同事实测：装了新版桌面图标还是旧的）：
; Explorer 有图标缓存（iconcache_*.db、按 exe 路径做 key）——exe 路径不变时
; 缓存不失效、桌面 / 开始菜单快捷方式一直显示旧图标。
; 这里安装完成后主动刷新 shell 图标缓存：
;   1. SHChangeNotify(SHCNE_ASSOCCHANGED) —— 通知 Explorer 图标关联变了
;   2. ie4uinit -show —— Win10/11 重建图标缓存（best-effort、失败无害）
; 注：任务栏「固定」的图标是用户级缓存、个别机器仍需取消固定再重新固定一次。

; ===== 安装诊断日志 + 静默更新预检（v1.9.30）=====
; 为什么：Windows 用户「更新后 App 没了 / 安装卡住 / 装到一半」是黑盒——静默安装没有任何界面，
; 事后既不知道装到哪一步、也不知道耗时多久、更不知道当时盘上还剩多少空间。
; 这里在 %APPDATA%\fe-ai-flow\logs\installer.log（与壳的 main.log 同目录、
; 「导出诊断包」会一并带上）追加几行最小记录：
;   init      = 安装器启动（版本 / 是否自动更新 / 安装目录与 %TEMP% 的盘符 / %TEMP% 所在盘剩余空间）
;   done      = 文件落盘完成（总耗时秒 / 主程序是否在 / 标记是否写成 / 安装目录盘符）
;   ABORT     = 静默更新预检不过、主动退出（此时旧版本一个文件都没动）
;   WARN      = 手动安装预检不过、弹框问用户（CONTINUE = 用户选了继续；DECLINED = 取消、旧版本没动）
; 只写 ASCII、路径只记盘符（StrCpy $N $INSTDIR 2 → "E:"）：FileWrite 在 Unicode 安装器里按系统 ANSI
; 代码页（简体中文是 GBK）落盘，而读取端（诊断包 / 主进程）按 UTF-8 解码——中文用户名路径必乱码。
; 完整的安装目录由 main.log（UTF-8）提供。
; 写不进去（没权限 / 目录建不出来）一律静默忽略，绝不影响安装本身。
;
; 预检阈值 800MB 的由来（v1.9.29 实测包）：7z 载荷 118MB 先落到 %TEMP%，再解压 447MB 到
; %TEMP%\...\7z-out，最后整树拷到安装目录（electron-builder 的 extractUsing7za 两遍落盘）。
; 峰值约 565MB 压在 %TEMP% 所在盘（多数人是 C 盘，选 D 盘装的人恰恰常因为 C 盘小）。
; 旧卸载器在升级时先把旧文件搬走再删——此后空间不够就是「旧的没了、新的没装全」。
; 这一步在手动安装（覆盖旧版）和自动更新里一视同仁（installSection.nsh 无条件调用 uninstallOldVersion），
; 区别只在有没有人能看到提示：自动更新静默、没界面 → 直接 Abort；手动安装 → 弹框让用户选，默认「否」。
; 所以在 .onInit 里（任何破坏性操作之前）先量。
; 阈值与主进程预检共用一个数：electron-app/disk-space.mjs 的 MIN_TEMP_FREE_MB（测试对账，改一处漏一处会红）。
!define FLOWSHIP_MIN_TEMP_FREE_MB 800

!ifndef BUILD_UNINSTALLER
  ; 安装器启动时的 GetTickCount，用来在 customInstall 里算总耗时
  Var flowshipInitTick
!endif

; 追加一行日志："[ts=<unix 秒>] <MSG>"。全程保护寄存器（Push/Pop），失败不报错。
!macro flowshipLog MSG
  Push $R7
  Push $R8
  Push $R9
  ReadEnvStr $R9 "APPDATA"
  ${if} $R9 != ""
    ${StdUtils.Time} $R7
    CreateDirectory "$R9\fe-ai-flow\logs"
    ClearErrors
    FileOpen $R8 "$R9\fe-ai-flow\logs\installer.log" a
    ${IfNot} ${Errors}
      FileSeek $R8 0 END
      FileWrite $R8 "[ts=$R7] ${MSG}$\r$\n"
      FileClose $R8
    ${EndIf}
    ClearErrors
  ${endIf}
  Pop $R9
  Pop $R8
  Pop $R7
!macroend

!macro customInstall
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  System::Call 'shell32.dll::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
  nsExec::Exec 'ie4uinit.exe -show'

  ; 新安装器标记 `.silent-update-ok`：主进程凭它才敢静默更新（旧版本装的目录没有它、
  ; 旧卸载器有已知缺陷，必须先手动装一次过渡）。
  ; v1.9.30：手动安装也必须落标记。之前只在 ${isUpdated}（自动更新）分支里写——
  ; 而手动装的人从来不走那条路径，于是门禁永远拒绝他们、弹的「手动更新一次」装完还是没标记，
  ; 死循环（大多数 Windows 用户都是手动装的，这就是「更新总是有问题」）。
  ; 仍然要求 $appExe 存在：半截安装（旧目录已清空、新文件没写全、$appExe 缺失）绝不落标记，
  ; 否则下次门禁被半截目录骗过、直接静默往坏目录里装。
  StrCpy $1 "no-appExe"
  ${if} ${FileExists} "$appExe"
    StrCpy $1 "marker-write-failed"
    ClearErrors
    FileOpen $0 "$INSTDIR\.silent-update-ok" w
    ${IfNot} ${Errors}
      FileWrite $0 "${VERSION}"
      FileClose $0
      StrCpy $1 "ok"
    ${EndIf}
    ClearErrors
  ${endIf}

  ; 自更新：旧卸载器可能已经删掉快捷方式，keepShortcuts 也只 rename 不改目标。
  ; 装完强制写回指向当前 $INSTDIR 里的 exe，避免桌面图标「找不到应用」。
  ; v1.9.13：$appExe 不存在（新文件没写进去、旧目录已被清空的半截状态）时绝不重建——
  ; 否则快捷方式会被指向一个不存在的 exe，比“旧快捷方式悬空”更难排查。
  StrCpy $2 "0"
  ${if} ${isUpdated}
    StrCpy $2 "1"
    ${if} ${FileExists} "$appExe"
      CreateShortCut "$newDesktopLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
      ClearErrors
      WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"
      CreateShortCut "$newStartMenuLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
      ClearErrors
      WinShell::SetLnkAUMI "$newStartMenuLink" "${APP_ID}"
      System::Call 'shell32.dll::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
    ${else}
      DetailPrint "skip shortcut rewrite: $appExe missing"
    ${endIf}
  ${endIf}

  ; 完成记录：总耗时 = 安装器启动（customInit）到文件全部落盘的秒数。
  ; 注意：手动安装包含用户在向导页（选目录 / 点下一步）停留的时间；静默更新才是纯安装耗时。
  System::Call 'kernel32::GetTickCount()i.r3'
  IntOp $3 $3 - $flowshipInitTick
  IntOp $3 $3 / 1000
  ; 只记盘符（见文件开头：路径含中文时 ANSI 落盘、读取端会乱码）
  StrCpy $4 $INSTDIR 2
  !insertmacro flowshipLog "done v${VERSION} updated=$2 marker=$1 elapsedSec=$3 instDrive=$4"
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
!macroend

; 手动安装器启动时先清残留进程（同事实测「安装一直卡住、提示 Flowship 无法关闭」的根因）：
; Windows 上内置 server 子进程就是 Flowship.exe 本体（ELECTRON_RUN_AS_NODE、无窗口）——
; app 崩溃 / 被强杀后它会变成隐形孤儿进程、NSIS 的「应用正在运行」检查永远过不去、
; 而用户看不到任何可关的窗口。手动安装走 /T 清整棵树（任务数据全程落盘、无损）。
;
; 自动更新禁止 /T：electron-updater 从 Flowship.exe 派生本安装器；/T 会把安装器
; 当子进程杀掉，旧卸载器已经 RMDir 掉安装目录之后新文件拷不进去，桌面快捷方式
; 指向空路径（「找不到应用」）。electron-updater 固定传 --updated → ${isUpdated}。
; 更新路径仍要杀掉 Flowship.exe 本体（不带 /T），清掉隐形 server，避免文件被锁。
!macro customInit
  ; $INSTDIR 归一化（历史 E 盘含空格坑的残留防线）：主进程已不再传 /D=，
  ; $INSTDIR 即注册表 InstallLocation 原样、一般不带引号；这里保留剥首尾引号 +
  ; 尾部分隔符（此时机在 initMultiUser 之后，正好），防注册表值被第三方改出花样。
  StrCpy $0 $INSTDIR 1
  ${if} $0 == '"'
    StrCpy $INSTDIR $INSTDIR "" 1
  ${endIf}
  StrCpy $0 $INSTDIR 1 -1
  ${if} $0 == '"'
    StrLen $1 $INSTDIR
    IntOp $1 $1 - 1
    StrCpy $INSTDIR $INSTDIR $1 0
  ${endIf}
  StrCpy $0 $INSTDIR 1
  ${if} $0 == "'"
    StrCpy $INSTDIR $INSTDIR "" 1
  ${endIf}
  StrCpy $0 $INSTDIR 1 -1
  ${if} $0 == "'"
    StrLen $1 $INSTDIR
    IntOp $1 $1 - 1
    StrCpy $INSTDIR $INSTDIR $1 0
  ${endIf}
  StrLen $1 $INSTDIR
  ${if} $1 > 3
    StrCpy $0 $INSTDIR 1 -1
    ${if} $0 == "\"
      IntOp $1 $1 - 1
      StrCpy $INSTDIR $INSTDIR $1 0
    ${elseIf} $0 == "/"
      IntOp $1 $1 - 1
      StrCpy $INSTDIR $INSTDIR $1 0
    ${endIf}
  ${endIf}

  ; 诊断记录 + 磁盘空间预检（见文件开头「安装诊断日志」一节）。
  ; 此刻 .onInit 还没做任何破坏性操作（旧卸载器要等安装段才跑），所以 Abort = 旧版本原样保留。
  System::Call 'kernel32::GetTickCount()i.r0'
  StrCpy $flowshipInitTick $0
  Push $2
  Push $3
  Push $4
  Push $5
  ; GetDiskFreeSpaceEx(目录, 调用者可用字节, 总字节, 总空闲字节)：取不到（UNC 等）返回 0、当未知处理。
  ; ⚠️ 三个输出寄存器 $1/$2/$3 都会被这次调用覆盖，所以「未知」的默认值必须在调用之后再赋。
  System::Call 'kernel32::GetDiskFreeSpaceEx(t "$TEMP", *l .r1, *l .r2, *l .r3) i .r0'
  StrCpy $2 "?"
  ${if} $0 != 0
    System::Int64Op $1 / 1048576
    Pop $2
  ${endIf}
  ${if} ${isUpdated}
    StrCpy $3 "1"
  ${else}
    StrCpy $3 "0"
  ${endIf}
  ; 日志里的路径只记盘符（前 2 个字符，如 "E:"）：见文件开头，完整路径含中文会乱码。
  StrCpy $4 $INSTDIR 2
  StrCpy $5 $TEMP 2
  !insertmacro flowshipLog "init v${VERSION} updated=$3 instDrive=$4 tempDrive=$5 tempFreeMB=$2"
  ; 自动更新（静默、没界面）：不够就直接退出。主进程已经 quit，下次手动打开时「更新墓碑」会发现
  ; 版本没变、读本日志里的 ABORT 弹框说明空间不足。
  ${if} ${isUpdated}
  ${andIf} $2 != "?"
  ${andIf} $2 < ${FLOWSHIP_MIN_TEMP_FREE_MB}
    !insertmacro flowshipLog "ABORT v${VERSION} tempFreeMB=$2 < ${FLOWSHIP_MIN_TEMP_FREE_MB} old install untouched"
    Pop $5
    Pop $4
    Pop $3
    Pop $2
    Abort
  ${endIf}
  ; 手动安装（有界面、人在屏幕前）：覆盖安装同样会先搬走旧文件，但安装向导不会告诉用户是空间的问题——
  ; 装到一半没空间了只会看到一个失败页。所以量到且不够时先问一句：默认「否」（回车 / 空格 = 取消），
  ; 选「是」才继续（用户知道风险，日志留 CONTINUE 便于事后排查）。
  ; 量不到（?）、静默安装（/S 无界面可问）、自动更新（上面已处理）都不弹。
  ; /SD IDYES：万一在没有桌面的环境里跑，按「继续」走，等价于改动前的行为、不会把安装卡死在对话框上。
  ${ifNot} ${isUpdated}
  ${andIfNot} ${Silent}
  ${andIf} $2 != "?"
  ${andIf} $2 < ${FLOWSHIP_MIN_TEMP_FREE_MB}
    !insertmacro flowshipLog "WARN v${VERSION} tempFreeMB=$2 < ${FLOWSHIP_MIN_TEMP_FREE_MB} asking user"
    MessageBox MB_YESNO|MB_ICONEXCLAMATION|MB_DEFBUTTON2 "临时文件所在的磁盘 $5 仅剩约 $2 MB 可用空间，低于安装所需的 ${FLOWSHIP_MIN_TEMP_FREE_MB} MB。$\n$\n空间不足时安装可能中途失败；若是覆盖安装，旧版本会先被移除，失败后程序将无法使用（任务数据不受影响）。$\n$\n建议先清理该磁盘（清空回收站、删除临时文件），再重新运行本安装程序。$\n$\n是否仍要继续安装？" /SD IDYES IDYES flowshipSpaceContinue
    !insertmacro flowshipLog "DECLINED v${VERSION} user cancelled, old install untouched"
    Pop $5
    Pop $4
    Pop $3
    Pop $2
    Abort
    flowshipSpaceContinue:
    !insertmacro flowshipLog "CONTINUE v${VERSION} user chose to install anyway"
  ${endIf}
  Pop $5
  Pop $4
  Pop $3
  Pop $2

  ; 更新路径不杀任何进程：主进程 before-quit 已按 server PID 精确清理；按镜像名杀
  ; 分不清主程序 / server 子进程（同一个 exe 镜像），/T 更会顺手杀掉 electron-updater
  ; 派生的本安装器（旧目录已删、新文件没写完 = 更新完 App 没了）。只有用户手动安装
  ; （本安装器不是 Flowship 的子进程）才需要清隐形孤儿 server。
  ${if} ${isUpdated}
    DetailPrint "update path: skip taskkill (main process owns PID cleanup)"
  ${else}
    nsExec::Exec 'taskkill /F /T /IM "Flowship.exe"'
  ${endIf}
!macroend

; 手动卸载同款 /T 清理。升级时新安装器会给旧卸载器传 --updated：只杀 Flowship.exe
; 本体、不带 /T，避免沿进程树反杀新安装器。
!macro customUnInit
  ; 更新中旧卸载器绝不碰进程：它是新安装器拉起的，按名杀（尤其 /T）极易误伤
  ; 正在装新文件的父进程；主进程退出时自清 server，不需要卸载器插手。
  ${if} ${isUpdated}
    DetailPrint "uninstall for update: skip taskkill (owner cleans up)"
  ${else}
    nsExec::Exec 'taskkill /F /T /IM "Flowship.exe"'
  ${endIf}
!macroend
