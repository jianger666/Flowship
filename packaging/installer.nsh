; NSIS 安装钩子（electron-builder 自动 include buildResources/installer.nsh）
;
; 换 logo 后 Windows 老图标不更新的根因（同事实测：装了新版桌面图标还是旧的）：
; Explorer 有图标缓存（iconcache_*.db、按 exe 路径做 key）——exe 路径不变时
; 缓存不失效、桌面 / 开始菜单快捷方式一直显示旧图标。
; 这里安装完成后主动刷新 shell 图标缓存：
;   1. SHChangeNotify(SHCNE_ASSOCCHANGED) —— 通知 Explorer 图标关联变了
;   2. ie4uinit -show —— Win10/11 重建图标缓存（best-effort、失败无害）
; 注：任务栏「固定」的图标是用户级缓存、个别机器仍需取消固定再重新固定一次。

!macro customInstall
  System::Call 'shell32.dll::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
  nsExec::Exec 'ie4uinit.exe -show'

  ; 自更新：旧卸载器可能已经删掉快捷方式，keepShortcuts 也只 rename 不改目标。
  ; 装完强制写回指向当前 $INSTDIR 里的 exe，避免桌面图标「找不到应用」。
  ; v1.9.13：$appExe 不存在（新文件没写进去、旧目录已被清空的半截状态）时绝不重建——
  ; 否则快捷方式会被指向一个不存在的 exe，比“旧快捷方式悬空”更难排查。
  ${if} ${isUpdated}
    ${if} ${FileExists} "$appExe"
      CreateShortCut "$newDesktopLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
      ClearErrors
      WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"
      CreateShortCut "$newStartMenuLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
      ClearErrors
      WinShell::SetLnkAUMI "$newStartMenuLink" "${APP_ID}"
      System::Call 'shell32.dll::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
      ; 新安装器标记：$appExe 存在才落 `.silent-update-ok`，主进程凭它才敢静默更新。
      ; 半截安装（旧目录已清空、新文件没写全、$appExe 缺失）绝不落标记——
      ; 否则下次门禁被半截目录骗过、直接静默往坏目录里装。
      ClearErrors
      FileOpen $0 "$INSTDIR\.silent-update-ok" w
      ${IfNot} ${Errors}
        FileWrite $0 "1"
        FileClose $0
      ${EndIf}
      ClearErrors
    ${else}
      DetailPrint "skip shortcut rewrite: $appExe missing"
    ${endIf}
  ${endIf}
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
