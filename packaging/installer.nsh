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
;   begin     = 用户点「安装」离开向导（手动安装才有；waitSec = 在向导页停留的秒数）
;   uninstalled = 旧版本移除完（uninstSec / 旧卸载器退出码）
;   done      = 文件落盘完成（总耗时秒 / 主程序是否在 / 标记是否写成 / 安装目录盘符）
;   phases    = 阶段汇总（prev 是否覆盖安装 / waitSec 向导停留 / probeSec 文件系统实测 / uninstSec 旧版移除 /
;               extractSec 解压落盘；四段相加 = elapsedSec），见下方「安装阶段计时」
;   fsprobe   = 小文件创建 / 删除实测（inst = 安装目录所在盘、tmp = %TEMP% 所在盘各一行），见下方「文件系统实测」
;   tmpredirect = 旧版本移除提速：result=applied 表示旧卸载器的 TEMP 已临时指到旧安装目录所在盘；其余取值是没改的原因
;               （fresh-install / same-drive / not-drive-path / mkdir-failed / write-failed / already），见「旧版本移除提速」
;   tmprestore  = 旧卸载器退出后还原 TEMP 并清理临时目录（dir=removed 清掉了 / kept 保留：旧卸载器失败）
;   heal      = 旧安装自愈（mode=broken / failed；result=cleaned / partial 表示已强清旧目录），见下方「旧安装自愈」
;   appclose  = 手动安装发现 Flowship 仍在运行、弹框问用户（step=prompt / declined / stuck / aborted / done），见「安装前确认 App 已退出」
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

; 文件系统实测（fsprobe）的上限：最多建这么多个小文件、且最多花这么久（毫秒），先到先停。
; 慢机器上这点上限也要守住——实测本身不能把「点安装之后的等待」再拉长一截。
!define FLOWSHIP_PROBE_MAX_FILES 60
!define FLOWSHIP_PROBE_MAX_MS 1500

; 旧卸载器的临时目录名（建在旧安装目录所在盘的根下，见下方「旧版本移除提速」）。固定名字：
; 清理时按这个名字整目录删，所以它只能装我们自己放进去的东西。
!define FLOWSHIP_TMP_DIRNAME ".flowship-tmp"

!ifndef BUILD_UNINSTALLER
  ; 安装器启动时的 GetTickCount，用来在 customInstall 里算总耗时
  Var flowshipInitTick
  ; 阶段计时（v1.9.30 起）：「安装慢」要分清慢在哪一段，只有一个总耗时分不开——
  ; 手动安装的总耗时还把用户在向导页的停留算了进去。三个时间点依次是：
  ;   init（customInit，安装器启动）→ begin（点「安装」离开向导）→ uninst（旧版本移除完）→ done（文件落盘完）
  ; 静默安装没有向导页，begin 保持等于 init（wait = 0）。
  Var flowshipBeginTick
  ; 文件系统实测（fsprobe）结束的时间点：实测的耗时单独记 probeSec，既不算向导停留、也不算旧版本移除
  Var flowshipProbeTick
  Var flowshipUninstTick
  ; 启动时注册表里是否已有旧安装（1 = 覆盖安装：安装段会先跑旧卸载器删 ~9.6k 个文件，这一段也计入耗时）
  Var flowshipPrev
  ; 旧版本号（注册表 DisplayVersion、取不到 / 全新安装记 "-"）：升级路径定位用，记在 begin 那一行
  Var flowshipPrevVer
  ; 旧版本移除提速：把 TEMP/TMP 临时指到旧安装目录所在盘时，这里存「指到哪个目录」（空 = 没改）
  ; 和改之前 TEMP / TMP 的原值（卸载完据此还原；原值为空 = 本来就没定义，还原时删掉）
  Var flowshipTmpDir
  Var flowshipOrigTemp
  Var flowshipOrigTmp
  ; 旧安装自愈（见 flowshipForceCleanOld）：1 = 旧安装目录已被我们强清（主程序没了）
  Var flowshipHealed
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

; ===== 安装阶段计时（v1.9.30）=====
; 为什么：同事反馈「点完下一步，进度条要等很久」，但 init / done 两个点只能给出一个总耗时，
; 而且手动安装的总耗时包含用户在向导页的停留——根本分不清慢在哪一段。这里补三个节点：
;   begin     用户点「安装」离开向导（只有手动安装有；静默安装没有向导、wait 记 0）
;   uninstalled 旧版本移除完（覆盖安装时旧卸载器要删 ~9.6k 个文件；全新安装这一段 ≈ 0）
;   phases    文件落盘完后一行汇总：prev=是否覆盖安装 waitSec=向导停留 uninstSec=旧版本移除 extractSec=解压落盘
; 读法：waitSec 不是安装慢；uninstSec 大 = 慢在卸载旧版本；extractSec 大 = 慢在写新文件（杀软 / 磁盘）。

; ===== 文件系统实测（fsprobe）=====
; 为什么：安装要落盘 ~9.6k 个小文件，慢的机器上「创建 + 写 + 关闭一个新文件」的单价（杀软 on-access 扫描 /
; 机械盘 / 文件系统）决定总耗时——但这个单价没有任何一行日志能告诉我们。这里在装之前直接量一把：
; 在目标目录里建一批只有几十字节的小文件（扩展名 .js：杀软常按扩展名决定扫不扫）、再整批删掉，记耗时。
;   files    实际建了几个（先到 FLOWSHIP_PROBE_MAX_FILES 或 FLOWSHIP_PROBE_MAX_MS 即停）
;   createMs 建这 files 个文件的总毫秒  → 单价 ≈ createMs / files；9657 个文件的下限 ≈ 单价 × 9657
;   delMs    删掉这批文件的总毫秒（旧版本卸载要删 ~9.6k 个文件，走同一条路径）
;   freeMB   该目录所在盘的剩余空间（?=取不到）
;   err      1 = 连第一个文件都建不出来（目录没权限 / 路径非法）；此时 files 可能是 0
; 参数 TAG 只用来区分两行（inst / tmp）；探测目录是 DIR\.fsprobe，用完立刻删。
; 写日志用的 $0-$9 在这里全程保护（Push/Pop），失败一律静默、绝不影响安装本身。
!macro flowshipFsProbe TAG DIR
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  Push $6
  StrCpy $6 "${TAG}"
  ClearErrors
  CreateDirectory "${DIR}\.fsprobe"
  ; 目标盘剩余空间（MB）→ $4。⚠️ $1/$2/$3 三个输出寄存器都会被这次调用覆盖，未知默认值必须在调用之后再赋
  System::Call 'kernel32::GetDiskFreeSpaceEx(t "${DIR}", *l .r1, *l .r2, *l .r3) i .r0'
  StrCpy $4 "?"
  ${if} $0 != 0
    System::Int64Op $1 / 1048576
    Pop $4
  ${endIf}
  StrCpy $5 "0"
  StrCpy $1 "0"
  System::Call 'kernel32::GetTickCount()i.r0'
  ${Do}
    ClearErrors
    FileOpen $2 "${DIR}\.fsprobe\p$1.js" w
    ${If} ${Errors}
      StrCpy $5 "1"
      ${Break}
    ${EndIf}
    FileWrite $2 "flowship-fsprobe 0123456789abcdef0123456789abcdef0123456789abcdef$\r$\n"
    FileClose $2
    IntOp $1 $1 + 1
    System::Call 'kernel32::GetTickCount()i.r3'
    IntOp $3 $3 - $0
    ${If} $1 >= ${FLOWSHIP_PROBE_MAX_FILES}
    ${OrIf} $3 >= ${FLOWSHIP_PROBE_MAX_MS}
      ${Break}
    ${EndIf}
  ${Loop}
  ; 循环可能因为出错中途 Break，$3 此时不一定是最新值：统一重取一次
  System::Call 'kernel32::GetTickCount()i.r3'
  IntOp $3 $3 - $0
  System::Call 'kernel32::GetTickCount()i.r0'
  Delete "${DIR}\.fsprobe\*.*"
  RMDir "${DIR}\.fsprobe"
  System::Call 'kernel32::GetTickCount()i.r2'
  IntOp $2 $2 - $0
  !insertmacro flowshipLog "fsprobe $6 v${VERSION} files=$1 createMs=$3 delMs=$2 freeMB=$4 err=$5"
  ClearErrors
  Pop $6
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
!macroend

; ===== 旧版本移除提速：旧卸载器的临时目录跟旧安装目录放同一块盘（v1.9.30）=====
; 为什么慢：官方旧卸载器（un.atomicRMDir）对安装目录里的每个文件做 Rename 到它自己的 $PLUGINSDIR\old-install，
; 而 $PLUGINSDIR 在 %TEMP% 下。装在 E: 盘、%TEMP% 在 C: 盘时，每个 Rename 是跨盘移动（= 复制 + 删除），
; 447MB / 9657 个文件被整份写到 C: 再删掉；同一块盘上的 Rename 只改元数据。
; 实测（docs/windows-install-startup-rca-2026-10-12.md §10.4，同机 ABA）：TEMP 在 E: 时 uninstSec=16、
; 换回 C: 为 30（解压耗时 9 / 10 几乎不变），即热状态下省约 14s。
; 旧卸载器是装在用户机器上的旧版本、改不了；能做的只有在新安装器拉起它之前改好它会继承的环境变量：
; ExecWait 用 CreateProcess 继承当前进程的环境块，GetTempPath 依次看 TMP / TEMP。
;
; 做法与边界（任何一步不满足都不改，行为与改动前完全一致，日志 result= 写明原因）：
;   - 只在覆盖安装（注册表有 InstallLocation）、且旧安装目录是「X:\...」盘符路径、且与当前 %TEMP% 不同盘时才改；
;     装在 C: 的人本来就同盘，什么都不动。
;   - 目录建在旧安装目录所在盘的根下（<盘>\.flowship-tmp，与实测用的 E:\tmp 同形），先建、再真写一个文件验证可写，
;     不能写（根目录没权限 / 只读盘）就放弃——不然旧卸载器连临时文件都建不出来，升级会被我们自己卡死。
;   - 要用旧安装目录而不是用户在向导里新选的目录：旧卸载器搬的是旧目录里的文件。
;   - 只对「旧卸载器」这一段生效：customUnInstallCheck（旧卸载器退出后、官方流程必经）里立刻还原 TEMP / TMP，
;     安装完后启动的 App 不会继承到它。本进程自己的 $PLUGINSDIR 在启动时就定了，改环境变量不会挪动它。
;   - 清理：旧卸载器正常退出（退出码 0）才整目录删；失败时保留，里面可能是旧文件的唯一副本。
; 必须在「真正执行安装的那个进程」里设：安装器会重新拉起一个提权的自己，新进程拿到的是系统给的全新环境
; （cmd 里 set TEMP 传不过去，实测无效）。每个进程都会跑自己的 customInit / begin 页，所以各自设各自的。
; 日志只记盘符（见文件开头）。寄存器 $0-$4 全程保护。
!macro flowshipTmpRedirect
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  StrCpy $1 "-"
  StrCpy $2 $TEMP 2
  StrCpy $3 "fresh-install"
  ${if} $flowshipTmpDir != ""
    StrCpy $3 "already"
  ${elseIf} $flowshipPrev == "1"
    ReadRegStr $0 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" "InstallLocation"
    StrCpy $4 $0 1
    ${if} $4 == '"'
      StrCpy $0 $0 "" 1
    ${endIf}
    StrCpy $4 $0 1 1
    ${if} $4 != ":"
      StrCpy $3 "not-drive-path"
    ${else}
      StrCpy $1 $0 2
      ${if} $1 == $2
        StrCpy $3 "same-drive"
      ${else}
        ClearErrors
        CreateDirectory "$1\${FLOWSHIP_TMP_DIRNAME}"
        ${if} ${Errors}
          StrCpy $3 "mkdir-failed"
        ${else}
          ClearErrors
          FileOpen $4 "$1\${FLOWSHIP_TMP_DIRNAME}\.w" w
          ${if} ${Errors}
            StrCpy $3 "write-failed"
            RMDir "$1\${FLOWSHIP_TMP_DIRNAME}"
          ${else}
            FileWrite $4 "x"
            FileClose $4
            Delete "$1\${FLOWSHIP_TMP_DIRNAME}\.w"
            SetFileAttributes "$1\${FLOWSHIP_TMP_DIRNAME}" HIDDEN
            ReadEnvStr $flowshipOrigTemp "TEMP"
            ReadEnvStr $flowshipOrigTmp "TMP"
            StrCpy $flowshipTmpDir "$1\${FLOWSHIP_TMP_DIRNAME}"
            System::Call 'kernel32::SetEnvironmentVariable(t "TEMP", t "$flowshipTmpDir")'
            System::Call 'kernel32::SetEnvironmentVariable(t "TMP", t "$flowshipTmpDir")'
            StrCpy $3 "applied"
          ${endIf}
        ${endIf}
      ${endIf}
    ${endIf}
  ${endIf}
  ClearErrors
  !insertmacro flowshipLog "tmpredirect v${VERSION} result=$3 tempDrive=$2 oldDrive=$1"
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
!macroend

; 还原 TEMP / TMP 并清理临时目录（没改过就什么都不做）。只在 customUnInstallCheck 里用——
; 官方流程里它紧跟在旧卸载器之后、且无论有没有旧版本都会走到。
; 参数是调用点里的两个值：LAUNCHFAILED = 旧卸载器没拉起来的标志（"1" 是）、CODE = 旧卸载器退出码（$R0）。
; 调用方必须已把「没拉起来」的错误标志存进寄存器（RMDir / 日志宏都会改错误标志）；本宏不碰 $R0，只用 $0 做临时变量。
; 顺序：先还原环境变量、再删目录（环境变量还指着这个目录时不能先把它删了）。
!macro flowshipTmpRestore LAUNCHFAILED CODE
  ${if} $flowshipTmpDir != ""
    Push $0
    ${if} $flowshipOrigTemp == ""
      System::Call 'kernel32::SetEnvironmentVariable(t "TEMP", p 0)'
    ${else}
      System::Call 'kernel32::SetEnvironmentVariable(t "TEMP", t "$flowshipOrigTemp")'
    ${endIf}
    ${if} $flowshipOrigTmp == ""
      System::Call 'kernel32::SetEnvironmentVariable(t "TMP", p 0)'
    ${else}
      System::Call 'kernel32::SetEnvironmentVariable(t "TMP", t "$flowshipOrigTmp")'
    ${endIf}
    StrCpy $0 "kept"
    ${if} ${LAUNCHFAILED} == "0"
    ${andIf} ${CODE} == 0
      RMDir /r "$flowshipTmpDir"
      ${ifNot} ${FileExists} "$flowshipTmpDir"
        StrCpy $0 "removed"
      ${endIf}
    ${endIf}
    ClearErrors
    !insertmacro flowshipLog "tmprestore v${VERSION} dir=$0"
    StrCpy $flowshipTmpDir ""
    Pop $0
  ${endIf}
!macroend

; ===== 旧安装自愈（v1.9.32）=====
; 为什么：有同事的机器上「装 / 更新必报 Flowship 无法关闭」、点重试永远过不去，只能手动跑清理脚本
; （结束进程 + 删整个安装目录 + 删卸载注册表项）才能重装。那个框的文案是误导——它是官方
; uninstallOldVersion 在「旧卸载器连续 5 次退出码非 0」之后弹的，跟进程没关系；旧卸载器失败的根因没取证到，
; 但这台机器上它失败之后目录留下半截（主程序没了、注册表还指着它），之后每次安装都撞同一个墙。
; 与其等根因，不如把那个脚本做成安装器自己的兜底，两道：
;   broken = 覆盖安装前预检：注册表有卸载记录、但旧安装目录里已经没有主程序 → 这个安装本来就废了、
;            没有任何东西值得卸载。直接清掉目录 + 删卸载注册表项，官方 uninstallOldVersion 读不到
;            UninstallString 就整段跳过（根本不再去调那个必败的旧卸载器，也就没有那个框）。
;            手动安装在「点安装」那一刻跑（begin 页）、静默安装 / 自动更新在 customInit 里跑。
;   failed = 旧卸载器已经跑了、退出码非 0（官方 5 次重试用尽 / 用户在那个框上点了取消，静默安装自动取消）：
;            以前这里弹框 + Quit，装不下去。现在 App 没在跑的话就强清旧目录、当作移除成功继续往下装。
;            App 还在跑 / 没法确认 / 清完主程序还在 → 保持原行为（弹框 + Quit），不会把一个还活着的 App 删残。
; 安全：只动「X:\…\${APP_FILENAME}」这种盘符路径（目录名必须恰好是 APP_FILENAME，防注册表值被改出花样后
; 整树递归删到别处）；只删安装目录，用户数据在 %APPDATA%\fe-ai-flow、不受影响（旧卸载器自己的兜底也是整目录删）。
; 目录来源与官方 uninstallOldVersion 同口径：注册表 InstallLocation，没有就取卸载器路径的父目录。
; 参数 MODE：字面量 "broken" 或 "failed"。结果记 installer.log 的 heal 行：
;   result=cleaned（目录删干净）/ partial（主程序没了、目录有残留文件）/ healthy / app-running / exe-still-there /
;   process-check-failed / no-uninstall-record / no-location / not-drive-path / not-app-dir
; 成功（cleaned / partial）时 $flowshipHealed = "1"。
; 调用方不需要保护寄存器（自带 Push/Pop，只改错误标志）。
!macro flowshipForceCleanOld MODE
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  StrCpy $flowshipHealed "0"
  StrCpy $2 "ok"
  ; $3 = 卸载器完整路径（UninstallString 里带引号的那段；官方 uninstallOldVersion 的同款解析）
  ReadRegStr $3 SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" "UninstallString"
  !ifdef UNINSTALL_REGISTRY_KEY_2
    ${if} $3 == ""
      ReadRegStr $3 SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY_2}" "UninstallString"
    ${endIf}
  !endif
  ${if} $3 == ""
    ${if} "${MODE}" == "broken"
      StrCpy $2 "no-uninstall-record"
    ${endIf}
  ${endIf}
  StrCpy $4 $3 1
  ${if} $4 == '"'
    StrCpy $3 $3 "" 1
    StrCpy $4 0
    ${Do}
      StrCpy $1 $3 1 $4
      ${if} $1 == ""
      ${orIf} $1 == '"'
        ${ExitDo}
      ${endIf}
      IntOp $4 $4 + 1
    ${Loop}
    StrCpy $3 $3 $4
  ${endIf}
  ; $0 = 旧安装目录
  ReadRegStr $0 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" "InstallLocation"
  ${if} $0 == ""
  ${andIf} $3 != ""
    StrLen $4 $3
    ${Do}
      IntOp $4 $4 - 1
      ${if} $4 < 1
        ${ExitDo}
      ${endIf}
      StrCpy $1 $3 1 $4
      ${if} $1 == "\"
        StrCpy $0 $3 $4
        ${ExitDo}
      ${endIf}
    ${Loop}
  ${endIf}
  ; 容忍被引号包起来 / 带尾部分隔符的旧值
  StrCpy $1 $0 1
  ${if} $1 == '"'
    StrCpy $0 $0 "" 1
  ${endIf}
  StrCpy $1 $0 1 -1
  ${if} $1 == '"'
  ${orIf} $1 == "\"
    StrLen $4 $0
    IntOp $4 $4 - 1
    StrCpy $0 $0 $4
  ${endIf}
  ; 目录必须是「X:\…\${APP_FILENAME}」
  ${if} $2 == "ok"
    ${if} $0 == ""
      StrCpy $2 "no-location"
    ${else}
      StrCpy $1 $0 1 1
      StrCpy $4 $0 1 2
      ${if} $1 != ":"
      ${orIf} $4 != "\"
        StrCpy $2 "not-drive-path"
      ${else}
        StrLen $4 "\${APP_FILENAME}"
        IntOp $4 0 - $4
        StrCpy $1 $0 "" $4
        ${if} $1 != "\${APP_FILENAME}"
          StrCpy $2 "not-app-dir"
        ${endIf}
      ${endIf}
    ${endIf}
  ${endIf}
  ; 触发条件
  ${if} $2 == "ok"
    ${if} "${MODE}" == "broken"
      ; 主程序还在 = 这是个能用的安装，交给官方旧卸载器去卸，这里不碰
      ${if} ${FileExists} "$0\${APP_EXECUTABLE_FILENAME}"
        StrCpy $2 "healthy"
      ${endIf}
    ${else}
      ; App 还在跑就不删：锁住的文件删不掉、半删又装不上，比旧卸载器干净回滚后留下的完整旧版更糟。
      ; 与官方 FIND_PROCESS 的 tasklist 分支同款命令（不限用户：别的会话里的 Flowship 也算在跑）。
      ; 退出码 0 = 找到了、1 = 没找到；其它（cmd / tasklist 起不来）= 没法确认，同样不删。
      nsExec::Exec `"$SYSDIR\cmd.exe" /C tasklist /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" /FO CSV /NH | "$SYSDIR\findstr.exe" /B /I /C:"\"${APP_EXECUTABLE_FILENAME}\""`
      Pop $4
      ${if} $4 == "0"
        StrCpy $2 "app-running"
      ${elseIf} $4 != "1"
        StrCpy $2 "process-check-failed"
      ${endIf}
    ${endIf}
  ${endIf}
  ; 清理：先把当前目录挪出去（进程的 cwd 在旧目录里时目录本身删不掉）；
  ; 确认主程序已经没了才删卸载注册表项（没删干净就不动注册表、保持原行为）
  ${if} $2 == "ok"
    DetailPrint "old install is broken or its uninstaller keeps failing: removing it and installing fresh"
    SetOutPath $TEMP
    RMDir /r "$0"
    ${if} ${FileExists} "$0\${APP_EXECUTABLE_FILENAME}"
      StrCpy $2 "exe-still-there"
    ${else}
      DeleteRegKey SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}"
      !ifdef UNINSTALL_REGISTRY_KEY_2
        DeleteRegKey SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY_2}"
      !endif
      StrCpy $flowshipHealed "1"
      ${if} ${FileExists} "$0\*.*"
        StrCpy $2 "partial"
      ${else}
        StrCpy $2 "cleaned"
      ${endIf}
    ${endIf}
  ${endIf}
  ClearErrors
  ; 日志只记盘符（见文件开头：路径含中文时 ANSI 落盘、读取端会乱码）
  StrCpy $1 $0 2
  !insertmacro flowshipLog "heal v${VERSION} mode=${MODE} result=$2 oldDrive=$1"
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
!macroend

; ===== 安装前确认 App 已退出（v1.9.32，仅有界面的手动安装）=====
; 为什么：以前手动安装在 customInit（安装器一启动、用户还没点「安装」）就无条件 taskkill——用户可能只是点开看看、
; 随后取消，App 却已经被杀；而且用户对「App 被杀了」毫无预期。同时，「Flowship 没退」常常是用户看不见的：
; App 崩溃 / 被强杀后内置 server 会变成没有窗口的孤儿进程（它和主程序是同一个 exe 镜像），
; 用户在任务栏里什么也看不到，却会让后面的文件被占用。
; 现在：点「安装」那一刻（begin 页）先查有没有 Flowship.exe 在跑（不管是有窗口的真没退、还是看不见的孤儿，
; 查到的方式一样）→ 没有就什么都不提示；有就弹框说明「安装需要先退出」，点「确定」才杀（/T 整棵树）、
; 然后等它真退出（最多约 5 秒，逐 0.5 秒复查）；点「取消」退出安装、什么都没动。
; 杀完还在（App 以管理员身份运行 / 在别的 Windows 登录会话里 / 被安全软件保护）：再弹「重试 / 忽略 / 中止」——
; 「忽略」是给多用户同机的人留的口子（别人的进程本来就不该挡我们这个用户的安装）。
; 查不出来（cmd / tasklist 起不来）当作没在跑、不拦安装（与改动前等价：之前也没有任何检查）。
; ⚠️ 这不覆盖「旧卸载器自己失败」那类假「无法关闭」——那时 Flowship.exe 根本没在跑，由上面的旧安装自愈兜底。
; 不覆盖：无界面的 /S 手动安装（没人可问，仍在 customInit 里直接杀）、自动更新（主进程自己清，见 customInit）。
; 日志只在弹过框时写：appclose step=prompt / declined / stuck / aborted / done（done 的 running=0 已退出、1 仍在、? 没法确认）。
; 探测宏：$0 返回 1 = 在跑、0 = 没在跑、? = 没法确认。命令与官方 FIND_PROCESS 的 tasklist 分支同形，但不加用户过滤：
; 官方的 USERNAME 过滤只写 %USERNAME%，而 tasklist 的该过滤器据我所知匹配的是「域\用户」全名，
; 只写用户名在不少机器上可能匹配不到（没有在 Windows 上验证）——查漏了 = 该问的不问、孤儿进程继续挡安装，
; 宁可多问一次（多用户同机的人有「忽略」兜底）。
!macro flowshipAppRunningProbe
  nsExec::Exec `"$SYSDIR\cmd.exe" /C tasklist /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" /FO CSV /NH | "$SYSDIR\findstr.exe" /B /I /C:"\"${APP_EXECUTABLE_FILENAME}\""`
  Pop $0
  ${if} $0 == "0"
    StrCpy $0 "1"
  ${elseIf} $0 == "1"
    StrCpy $0 "0"
  ${else}
    StrCpy $0 "?"
  ${endIf}
!macroend

; 只在 begin 页里展开一次（宏内是固定名字的标签，展开两次会重复定义、编译直接报错）。自带 Push/Pop。
!macro flowshipEnsureAppClosed
  Push $0
  Push $1
  Push $2
  ; $1 = 是否已经问过用户（0 / 1）
  StrCpy $1 "0"
  flowshipAppCloseCheck:
    !insertmacro flowshipAppRunningProbe
    StrCmp $0 "1" 0 flowshipAppCloseDone
    StrCmp $1 "0" flowshipAppCloseAsk flowshipAppCloseRetryAsk
  flowshipAppCloseAsk:
    StrCpy $1 "1"
    !insertmacro flowshipLog "appclose v${VERSION} step=prompt"
    MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "检测到 ${PRODUCT_NAME} 仍在运行（可能只剩没有窗口的后台进程）。$\n$\n安装前需要先退出它：点「确定」将关闭 ${PRODUCT_NAME} 并继续安装（任务数据保存在磁盘上、不会丢失；正在运行的任务会被中断）；点「取消」退出安装。" /SD IDOK IDOK flowshipAppCloseKill
    !insertmacro flowshipLog "appclose v${VERSION} step=declined"
    Quit
  flowshipAppCloseRetryAsk:
    !insertmacro flowshipLog "appclose v${VERSION} step=stuck"
    MessageBox MB_ABORTRETRYIGNORE|MB_ICONEXCLAMATION "无法关闭 ${PRODUCT_NAME}。它可能以管理员身份运行，或运行在其他 Windows 登录会话里。$\n$\n请在任务管理器里手动结束 ${PRODUCT_NAME}（含后台进程），然后点「重试」；点「忽略」不管它、直接继续安装（若文件被占用，安装可能失败）；点「中止」退出安装。" /SD IDIGNORE IDRETRY flowshipAppCloseKill IDIGNORE flowshipAppCloseDone
    !insertmacro flowshipLog "appclose v${VERSION} step=aborted"
    Quit
  flowshipAppCloseKill:
    nsExec::Exec 'taskkill /F /T /IM "${APP_EXECUTABLE_FILENAME}"'
    Pop $0
    StrCpy $2 0
  flowshipAppCloseWait:
    Sleep 500
    !insertmacro flowshipAppRunningProbe
    StrCmp $0 "1" 0 flowshipAppCloseCheck
    IntOp $2 $2 + 1
    IntCmp $2 10 flowshipAppCloseCheck flowshipAppCloseWait flowshipAppCloseCheck
  flowshipAppCloseDone:
    StrCmp $1 "1" 0 flowshipAppCloseEnd
    !insertmacro flowshipLog "appclose v${VERSION} step=done running=$0"
  flowshipAppCloseEnd:
  Pop $2
  Pop $1
  Pop $0
!macroend

; 在「选目录」页之后、「安装」页之前插一个永远不显示的页（creator 里 Abort = 跳过该页）：
; 它的回调恰好在用户点「安装」的那一刻执行一次，正好用来记 begin 时间点。
; （electron-builder 的 instFilesPre 在这个页之后、不能改，所以走 customPageAfterChangeDir 这个官方扩展点。）
; 此刻 $INSTDIR 已经是用户最终选定的目录，所以文件系统实测也放在这里（只有手动安装会走到；
; 静默安装 / 自动更新没有向导页，不跑实测，装机路径与改动前完全一致）。
; begin 日志必须先写、实测后做：begin 是「用户点安装」的时间点，不能把实测耗时算进 waitSec。
!macro customPageAfterChangeDir
  Function flowshipBeginPage
    Push $0
    Push $1
    Push $2
    ; 先确认 App 已退出（见 flowshipEnsureAppClosed）：放在 begin 计时之前——用户在弹框上停留的时间
    ; 算向导停留（waitSec），不算安装慢；也要先于下面的一切（实测 / TEMP 重定向 / 旧安装自愈 / 官方旧卸载器）。
    !insertmacro flowshipEnsureAppClosed
    System::Call 'kernel32::GetTickCount()i.r0'
    StrCpy $flowshipBeginTick $0
    ; probe / 旧版本移除的时间点先对齐到 begin：万一下面的钩子没被调用，对应的秒数也是 0 而不是负数
    StrCpy $flowshipProbeTick $0
    StrCpy $flowshipUninstTick $0
    IntOp $1 $0 - $flowshipInitTick
    IntOp $1 $1 / 1000
    StrCpy $2 $flowshipPrevVer
    !insertmacro flowshipLog "begin v${VERSION} waitSec=$1 prevVer=$2"
    !insertmacro flowshipFsProbe "inst" "$INSTDIR"
    !insertmacro flowshipFsProbe "tmp" "$PLUGINSDIR"
    ; 实测的耗时单独成段（probeSec）：probe / uninst 两个后续时间点都推到实测结束之后，
    ; 这样 waitSec + probeSec + uninstSec + extractSec 恰好等于总耗时
    System::Call 'kernel32::GetTickCount()i.r0'
    StrCpy $flowshipProbeTick $0
    StrCpy $flowshipUninstTick $0
    ; 旧版本移除提速（见 flowshipTmpRedirect）：手动安装在「点安装」这一刻设；静默安装 / 自动更新没有这一页，在 customInit 里设。
    ; 放在 tick 重取之后：建目录 + 验证可写只是几毫秒，算进旧版本移除那一段（它本来就是这一段的一部分）。
    !insertmacro flowshipTmpRedirect
    ; 旧安装自愈（见 flowshipForceCleanOld）：旧目录里主程序已经没了、注册表却还指着它 → 清掉，官方旧卸载器整段跳过。
    ; 放在「点安装」这一刻（用户已确认要装、此后不会再退出向导）；静默安装在 customInit 里跑同一个宏。
    !insertmacro flowshipForceCleanOld "broken"
    Pop $2
    Pop $1
    Pop $0
    Abort
  FunctionEnd
  Page custom flowshipBeginPage
!macroend

; 旧版本移除完的钩子。⚠️ 官方 handleUninstallResult 一旦发现定义了这个宏，就**只**执行它、然后 Return——
; 默认的错误处理（旧卸载器拉不起来 / 退出码非 0）会被跳过，所以这里必须原样复刻一份
; （app-builder-lib templates/nsis/include/installUtil.nsh 的 handleUninstallResult 默认分支），
; 不然覆盖安装时旧卸载器失败会被悄悄吞掉。electron-builder 升级时若该默认分支有改动，这里要同步（契约测试盯着关键语句）。
; 日志宏会 ClearErrors，所以先把「没拉起来」的错误标志存进 $1，再记日志，再按默认逻辑处理。
!macro customUnInstallCheck
  Push $0
  Push $1
  Push $2
  StrCpy $1 "0"
  IfErrors 0 +2
  StrCpy $1 "1"
  ; 旧卸载器的真实退出码先存进 $2：下面自愈成功会把 $R0 改成 0，日志里要记的是真实值
  StrCpy $2 $R0
  ; 旧安装自愈（见 flowshipForceCleanOld）：旧卸载器拉起来了、但退出码非 0（官方 5 次重试用尽）——
  ; App 没在跑就强清旧目录、把退出码当 0 往下装；不满足条件（flowshipHealed 保持 0）则 $R0 原样，走下面的弹框 + Quit。
  ${if} $1 == "0"
  ${andIf} $R0 != 0
    !insertmacro flowshipForceCleanOld "failed"
    ${if} $flowshipHealed == "1"
      StrCpy $R0 0
    ${endIf}
  ${endIf}
  ; 先还原 TEMP / TMP 并清理旧卸载器的临时目录（见 flowshipTmpRedirect）：必须在错误标志存进 $1 之后
  ; （RMDir 会改错误标志），且在下面「拉不起来 → 继续往下装」/ 弹框 Quit 两个分支之前。
  ; 自愈成功时 $R0 已是 0，旧卸载器失败时留在临时目录里的文件（旧文件的残片）一并清掉。
  ; 清理耗时算进 uninstSec（它本来就是移除旧版本的一部分）。
  !insertmacro flowshipTmpRestore $1 $R0
  System::Call 'kernel32::GetTickCount()i.r0'
  StrCpy $flowshipUninstTick $0
  IntOp $0 $0 - $flowshipProbeTick
  IntOp $0 $0 / 1000
  !insertmacro flowshipLog "uninstalled v${VERSION} uninstSec=$0 launchFailed=$1 code=$2"
  ${if} $1 == "1"
    DetailPrint `Uninstall was not successful. Not able to launch uninstaller!`
    Pop $2
    Pop $1
    Pop $0
    Return
  ${endIf}
  ${if} $R0 != 0
    MessageBox MB_OK|MB_ICONEXCLAMATION "$(uninstallFailed): $R0"
    DetailPrint `Uninstall was not successful. Uninstaller error code: $R0.`
    SetErrorLevel 2
    Quit
  ${endIf}
  Pop $2
  Pop $1
  Pop $0
!macroend

; 文件落盘完后的阶段汇总行（在 customInstall 里调用；自带寄存器保护）。
!macro flowshipLogPhases
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  System::Call 'kernel32::GetTickCount()i.r3'
  IntOp $0 $flowshipBeginTick - $flowshipInitTick
  IntOp $0 $0 / 1000
  IntOp $4 $flowshipProbeTick - $flowshipBeginTick
  IntOp $4 $4 / 1000
  IntOp $1 $flowshipUninstTick - $flowshipProbeTick
  IntOp $1 $1 / 1000
  IntOp $2 $3 - $flowshipUninstTick
  IntOp $2 $2 / 1000
  StrCpy $3 $flowshipPrev
  !insertmacro flowshipLog "phases v${VERSION} prev=$3 waitSec=$0 probeSec=$4 uninstSec=$1 extractSec=$2"
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
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
  ; 阶段汇总（向导停留 / 旧版本移除 / 解压落盘）：elapsedSec 拆开来看，见上面「安装阶段计时」
  !insertmacro flowshipLogPhases
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
!macroend

; 手动安装要清残留进程（同事实测「安装一直卡住、提示 Flowship 无法关闭」的根因之一）：
; Windows 上内置 server 子进程就是 Flowship.exe 本体（ELECTRON_RUN_AS_NODE、无窗口）——
; app 崩溃 / 被强杀后它会变成隐形孤儿进程、NSIS 的「应用正在运行」检查永远过不去、
; 而用户看不到任何可关的窗口。手动安装走 /T 清整棵树（任务数据全程落盘、无损）。
; v1.9.32 起有界面的手动安装不在这里杀、改为点「安装」时查到在跑才弹框问（flowshipEnsureAppClosed）；
; 这里只剩无界面的 /S 手动安装（没人可问）直接杀。
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
  ; 阶段计时的两个后续时间点先都等于启动时刻：静默安装没有向导页、不会再被更新，差值自然为 0
  StrCpy $flowshipBeginTick $0
  StrCpy $flowshipProbeTick $0
  StrCpy $flowshipUninstTick $0
  ; 是否覆盖安装：读的和模板 uninstallOldVersion 同一个注册表项（InstallLocation）
  StrCpy $flowshipPrev "0"
  ReadRegStr $0 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" "InstallLocation"
  ${if} $0 != ""
    StrCpy $flowshipPrev "1"
  ${endIf}
  ; 旧版本号（begin 日志里的 prevVer）：取不到 / 全新安装记 "-"；截 24 个字符防注册表值被改出花样
  ReadRegStr $0 SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" "DisplayVersion"
  ${if} $0 == ""
    StrCpy $0 "-"
  ${endIf}
  StrCpy $flowshipPrevVer $0 24
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
  ; 有界面的手动安装不在这里杀（v1.9.32）：用户这时还没确认要装、可能点「取消」退出向导——
  ; 提前杀掉他正在用的 App 不合适。改成在「点安装」那一刻先查、查到在跑再弹框问，
  ; 点「确定」才杀（flowshipEnsureAppClosed，在 begin 页里）。无界面的 /S 手动安装没人可问，仍在这里直接杀。
  ${if} ${isUpdated}
    DetailPrint "update path: skip taskkill (main process owns PID cleanup)"
  ${else}
    ${if} ${Silent}
      nsExec::Exec 'taskkill /F /T /IM "Flowship.exe"'
    ${endIf}
  ${endIf}

  ; 旧版本移除提速（见 flowshipTmpRedirect）：静默安装 / 自动更新没有向导页、也就没有「点安装」那一刻，在这里设。
  ; 放在最后：前面所有 Abort 分支都在它之前，不会出现「改了环境变量却退出」的路径；
  ; 手动安装不在这里设（向导可能停留很久，别让这期间拉起的子进程都带着改过的 TEMP），在 begin 页里设。
  ${if} ${Silent}
    !insertmacro flowshipTmpRedirect
    ; 旧安装自愈（见 flowshipForceCleanOld）：同样放在所有 Abort 分支之后——预检不过要退出时，旧安装一个字节都不动。
    !insertmacro flowshipForceCleanOld "broken"
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
