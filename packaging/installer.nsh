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
