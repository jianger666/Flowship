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
!macroend

; 手动安装器启动时先清残留进程（同事实测「安装一直卡住、提示 Flowship 无法关闭」的根因）：
; Windows 上内置 server 子进程就是 Flowship.exe 本体（ELECTRON_RUN_AS_NODE、无窗口）——
; app 崩溃 / 被强杀后它会变成隐形孤儿进程、NSIS 的「应用正在运行」检查永远过不去、
; 而用户看不到任何可关的窗口。这里直接 taskkill 整棵进程树（任务数据全程落盘、无损）。
;
; 自动更新必须跳过：electron-updater 先从 Flowship.exe 派生 NSIS 安装器，再异步退出 App；
; 此时对 Flowship.exe 使用 /T 会把刚派生的安装器也当作子进程杀掉，表现为「App 已关、
; 长时间不重启、手动打开仍是旧版本」。electron-updater 固定传 --updated，electron-builder
; 将它映射为 ${isUpdated}；更新路径由 App before-quit 按 server PID 精确清理进程树。
!macro customInit
  ${ifNot} ${isUpdated}
    nsExec::Exec 'taskkill /F /T /IM "Flowship.exe"'
  ${endIf}
!macroend

; 手动卸载同款清理。升级时新安装器会给旧卸载器传 --updated；同样必须跳过，
; 否则旧卸载器仍会沿 Flowship 的进程树反杀新安装器。
!macro customUnInit
  ${ifNot} ${isUpdated}
    nsExec::Exec 'taskkill /F /T /IM "Flowship.exe"'
  ${endIf}
!macroend
