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
  ${if} ${isUpdated}
    CreateShortCut "$newDesktopLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
    ClearErrors
    WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"
    CreateShortCut "$newStartMenuLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
    ClearErrors
    WinShell::SetLnkAUMI "$newStartMenuLink" "${APP_ID}"
    System::Call 'shell32.dll::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
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
  ${if} ${isUpdated}
    nsExec::Exec 'taskkill /F /IM "Flowship.exe"'
  ${else}
    nsExec::Exec 'taskkill /F /T /IM "Flowship.exe"'
  ${endIf}
!macroend

; 手动卸载同款 /T 清理。升级时新安装器会给旧卸载器传 --updated：只杀 Flowship.exe
; 本体、不带 /T，避免沿进程树反杀新安装器。
!macro customUnInit
  ${if} ${isUpdated}
    nsExec::Exec 'taskkill /F /IM "Flowship.exe"'
  ${else}
    nsExec::Exec 'taskkill /F /T /IM "Flowship.exe"'
  ${endIf}
!macroend
