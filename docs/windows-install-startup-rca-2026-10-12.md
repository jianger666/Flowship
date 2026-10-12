# Windows 安装 / 自动更新 / 启动 三类问题排查与修复（2026-10-12）

> 分支：`fix/windows-install-update-startup`（基于 main v1.9.29）。
> 置信度标注：【实锤】= 源码 / 二进制 / 本机实测直接证明；【推断】= 机制成立、数据支持，但**没有在 Windows 真机上复现**；【待验证】= 需要 Windows 真机实验才能下结论。
>
> ⚠️ **本次排查全程在 macOS 上完成，没有任何一项在 Windows 真机上运行过。**
> NSIS 脚本用真实 `electron-builder` + makensis（`-WX`：警告即错误）编译验证过语法与链接，
> 并解开产物头部确认新逻辑进了安装器；但运行时行为（`System::Call` 取磁盘空间、日志写入、
> `.onInit` 里 `Abort`、手动安装的 `MessageBox`、`StdUtils::Time`）与 PowerShell 杀软探测脚本属【待验证】。
>
> 本文经过一轮独立的合并前评审（§9 逐条列出处置）。评审指出 §3.2 原先「手动安装不拦（人在屏幕前）」的结论站不住，已更正。
> 与本文互补的两篇：`windows-slow-rca-2026-07-17.md`、`cursor-sdk-windows-performance-investigation-2026-07-16.md`
> 讲的是**运行期** shell 慢（SDK 的 PowerShell 执行器），与本文的安装 / 更新 / 冷启动是不同问题。

## 1. TL;DR

| # | 用户现象 | 结论 | 本分支做了什么 |
|---|---|---|---|
| 1 | 更新总有问题；装到非 C 盘、应用内更新后 App 被删（不知道修好没） | 【实锤】v1.9.22 起的静默更新门禁存在**逻辑死锁**：手动安装的人永远拿不到「可静默更新」标记，应用内更新永远被拒、只能手动装。早先的 `/D=` 引号 / Temp 目录两类「更新后人没了」已在 v1.9.11~22 加固，但**从没在真机验证过**。【推断】非 C 盘用户被删光的另一大嫌疑是 **%TEMP% 所在盘（多为 C 盘）剩余空间不足** | 修死锁；加磁盘空间**预检**（TEMP 盘 <800MB）：主进程在退出前先量、不够当场弹框；安装器 `.onInit` 再量一道——自动更新静默退出（旧版本一个文件不动）、手动安装弹框问用户（默认「否」）；加 `installer.log` 黑盒记录；接入 electron-updater 日志 |
| 2 | 启动非常慢；首次启动常报「启动超时」，第二次才起得来 | 【实锤】server 本身的成本只有 0.27~0.4s（Mac 热缓存实测），冷启动到就绪只读 **434 个文件**；慢的是「第一次读这些文件」（磁盘 / 杀软 / 未签名 exe 信誉）【推断】。**v1.9.22 之前的版本是 30 秒硬超时**——「第一次超时、第二次好」与它完全吻合，而这批用户因为问题 1 的死锁**被卡在老版本上升不了级**。另外：首启宽限标记是全局一次性的，更新后的第一次启动（同样是冷的）只拿到 60s | 首启标记**按版本记**（更新 / 重装后的第一次启动重新给 150s）；日志补磁盘余量 / 启动参数；启动偏慢时记杀软清单；超时弹框写明日志目录 |
| 3 | 安装非常慢、进度条一直卡着；另一个 AI 说是 Next 打包文件太多 | 【实锤】「文件太多」的**机制是对的**（9,657 个文件、每个文件在安装器里被落盘两遍、无进度的 `CopyFiles` 那一段就是「卡住」）。但**归因不准**：Next 产物只占 23%，**只有配置了自定义供应商才会用到的 pi 依赖闭包占 55%**（5,319 个文件、才 33MB）。安装包也**没有签名**（实锤） | 本分支**未改打包**（没有 Windows 真机无法 A/B、盲改风险大）；给出带实测数字的方案与实验计划，见 §5.3、§8 |

## 2. 方法与证据

| 证据 | 来源 |
|---|---|
| 官方 v1.9.29 Windows 安装器（`fe-ai-flow-1.9.29-win-x64.exe`，123,895,072 B≈118MB）解包后的载荷 | 本机解开，9,657 个文件 / 447.4MB（`Flowship.exe` 单个 221.5MB） |
| 安装器内部流程 | electron-builder 26.15.2 的 NSIS 模板（`app-builder-lib/templates/nsis/include/extractAppPackage.nsh:92-130`、`installSection.nsh:5-7`）+ 用 Node 解出官方安装器头部核对 |
| 本分支的 NSIS 脚本能否编译 | 本机真实 `electron-builder --win nsis --x64 --prepackaged … --publish never`（macOS ≥ Catalina 免 Wine），makensis `-WX` 通过；产物头部里能找到 `installer.log` / `ABORT v` / `WARN v` / `DECLINED v` / `CONTINUE v` / `instDrive=` / `tempFreeMB` / `GetDiskFreeSpaceEx` / `.silent-update-ok` / `marker-write-failed` / `elapsedSec`，以及 UTF-16LE 编码的中文弹框文案；旧的 `instdir=`（完整路径日志）已消失 |
| 冷启动读了哪些文件 | 自写探针：打补丁拦截 `fs` / CJS `Module._extensions` / ESM loader hook，隔离数据目录起打包后的 standalone server，量「冷启动 → `/api/readyz` 就绪 → 首页首次渲染」各阶段读取的不同文件（脚本在会话临时目录、未入库；方法见上，需要复测可另行提交） |
| 签名状态 | 直接解析 PE 头 Certificate Table：v1.9.29 安装器 / `Flowship.exe` / `elevate.exe` 的证书表大小均为 0 = **未签名** |

## 3. 问题 1：更新

### 3.1 死锁（【实锤】，已修）

v1.9.22（2026-09-22，commit `ac0e194`）引入「新安装器标记」门禁：
`installer.nsh` 在安装目录写 `.silent-update-ok`，主进程 `installWinUpdate()` 凭标记才敢静默更新，
没标记 = 老版本装的 → 弹「需要手动更新一次」并打开发布页。

但标记**只写在 `${if} ${isUpdated}` 分支里**（`isUpdated` = 安装器带 `--updated`，只有 electron-updater 静默拉起时才有）：

```
手动安装（双击安装器，从来没有 --updated）→ 不写标记
  → 点「更新」→ 门禁看不到标记 → 拒绝、弹「手动更新一次」
    → 用户手动装 → 还是没有标记 → 永远循环
```

唯一有标记的人：在 ≤v1.9.21 时（还没有门禁）通过应用内静默更新升到 v1.9.22+ 的那批。
**v1.9.22 之后手动安装 / 全新安装的 Windows 用户，应用内更新一次都没成功过**，只会被要求手动下载。
这与「Windows 用户更新软件好像总是有问题」吻合。

**修法**（`packaging/installer.nsh`）：标记改为**每次安装都写**（手动 / 自动都写），仍要求 `$appExe` 存在
（半截安装不落标记，否则门禁会被半截目录骗过）。

**过渡成本无法避免**：门禁逻辑在用户机器上已安装的老版本里，改不了。v1.9.22~v1.9.29 且没标记的用户，
需要**再手动装一次**含本修复的版本（弹框已经在要求这么做），之后才会静默更新。

### 3.2 「装到非 C 盘，应用内更新后 App 被删」有没有修好

早先这一类的原因在 v1.9.11~v1.9.22 陆续加固（代码审阅 + 单测；v1.9.22 的提交说明里写的是「Windows 真机验证待发版前做」，**本次也没有真机验证**）：

| 版本 | 已处理的原因 |
|---|---|
| v1.9.11 起引入、v1.9.22 才下线 | 为含空格的安装目录加了「`/D=` 钉目录」双保险——**这条路本身就是坑**：Node 给含空格路径自动加引号、旧 NSIS 取参不去引号 → `$INSTDIR` 非法 → 旧目录已删、新文件写不进。v1.9.11~v1.9.21 期间通过应用内更新的用户都踩在这条路上；v1.9.22 起不再传 `/D=`，以注册表 InstallLocation 为准 |
| v1.9.15 | 当前 App 进程本身跑在 `%TEMP%` / `old-install` 备份里（上次失败更新的残留、被用户直接点开）时拒绝静默更新（`isUnsafeWinInstallDir`）——否则更新会装进 Temp，Temp 一清 App 就彻底没了，而真正的安装目录（如 `D:\…`）还停在被清空的状态；`$appExe` 不存在时不乱建快捷方式。**这条历史本身说明：线上确实出现过「旧目录已清空、新文件没落到位」的半截更新** |
| v1.9.22 | `taskkill /T` 会把 electron-updater 派生的安装器一起杀掉 → 更新路径不再杀进程；更新墓碑（quitAndInstall 前写、启动核销，装失败变成可见弹框而不是无声消失）；标记门禁（即上面的死锁来源） |

【推断】**这批修复之后，「非 C 盘用户更新后被删光」还有一个没被覆盖的主要嫌疑：空间。**
安装器的真实写盘路径（NSIS 模板 + 官方安装器实测）是：

1. 118MB 的 7z 载荷先落到 `%TEMP%`；
2. 解压 447MB / 9,657 个文件到 `%TEMP%\…\7z-out`；
3. `CopyFiles /SILENT` 整树拷到安装目录。

峰值约 565MB 压在 **%TEMP% 所在盘（通常是 C 盘）**。选装 D 盘的人，恰恰常是因为 C 盘小。
而更新流程是：**旧卸载器先把旧文件搬走再删 → 然后才开始装新的**。空间不够时就是「旧的没了、新的没装全」，
静默安装没有任何界面，用户看到的就是「App 被删了」。

**修法**（三层，口径一致：向下取整到 MB、严格小于 800MB 才算不够、量不到（UNC 等）一律放行）：

1. **主进程预检**（新客户端，`installWinUpdate`）：在 `quitting = true` 之前量 `os.tmpdir()` 所在盘；不够当场弹框、
   什么都不动——App 继续开着、版本不变、不写墓碑、不开发布页（手动装同样要这些空间，送过去只会重蹈覆辙）。
2. **安装器自动更新分支**（`.onInit`，任何破坏性操作之前）：剩余 <800MB 写 `ABORT` 日志并静默 `Abort`——此刻旧版本一个文件都没动。
   这一道保护的是**还没有主进程预检的存量客户端（v1.9.22~29）**：它们拉起的就是新版安装器。
   下次手动打开时「更新墓碑」发现版本没变；新客户端读 `installer.log` 里的 `ABORT`、给空间不足的针对性文案并先让用户清理；
   存量客户端仍是旧文案「去发布页手动安装」——**改不了**（弹框代码在用户机器上的旧版本里），所以下一层必须接住。
3. **安装器手动安装分支**（有界面）：量到且不够，弹 `MessageBox`（是 / 否，**默认「否」**）；选「是」继续（日志记 `CONTINUE`），
   选「否」记 `DECLINED` 并 `Abort`。静默安装（`/S`，无界面可问）、量不到都不弹。

> **更正**：本文初稿写的是「手动安装不拦（人在屏幕前）」，理由站不住。electron-builder 模板的 `installSection.nsh`
> **无条件**调用 `uninstallOldVersion`，所以手动覆盖安装同样先搬走旧文件；而安装向导不会告诉用户是空间的问题，
> 只会在装到一半时给一个失败页。人在屏幕前不等于看得到风险。而且存量客户端被静默 `Abort` 后弹的就是旧文案
> 「去发布页手动安装」——**把人引向一条没有保护的路径**，所以手动路径必须有保护。

阈值 800MB 的依据是 565MB 峰值 + 余量。**阈值只有一个 JS 来源**：`electron-app/disk-space.mjs` 的 `MIN_TEMP_FREE_MB`
（弹框文案读它）；`installer.nsh` 的 `FLOWSHIP_MIN_TEMP_FREE_MB` 必须与它相等——测试对账，包体增长要上调时漏改一处会红
（另有测试断言阈值 ≥ 565MB 且 ≤ 2GB）。

### 3.3 仍然存在的风险（【推断】，未改）

- 静默模式下 `CopyFiles` 重试 5 次（间隔 1s）后，模板会走「最后手段」：直接 `Nsis7z::Extract` 覆盖安装目录并**忽略错误**（`/SD IDRETRY`）——杀软锁文件 / 隔离文件时可能装出半截目录；
- 旧卸载器在更新时把旧文件搬到自己的 `$PLUGINSDIR\old-install`（临时目录，非 C 盘安装时是**跨盘**搬运，慢且吃 C 盘空间）再 `RMDir /r`，注册表项也先删；
- 安装包未签名（见 §5）。

### 3.4 可诊断性（新增）

- `%APPDATA%\fe-ai-flow\logs\installer.log`（与 `main.log` 同目录）：安装器每次安装 / 更新追加几行 ASCII 记录：
  - `init`：版本 / 是否自动更新 / 安装目录与 `%TEMP%` 的**盘符** / `%TEMP%` 所在盘剩余 MB
  - `done`：总耗时秒 / 主程序是否在 / 标记是否写成 / 安装目录盘符
  - `ABORT`：自动更新预检拒绝（旧版本没动）
  - `WARN` → `CONTINUE` / `DECLINED`：手动安装预检不过、弹框问用户后的选择
  （手动安装的耗时包含用户在向导页停留的时间；静默更新是纯安装耗时。）
  **路径只记盘符**（`StrCpy $N $INSTDIR 2` → `E:`）：`FileWrite` 在 Unicode 安装器里按系统 ANSI 代码页
  （简中 = GBK）落盘，而读取端（诊断包 / 主进程）按 UTF-8 解码——中文用户名路径必乱码。完整安装目录由 UTF-8 的 `main.log` 提供。
- 「导出诊断包」会带上 `installer.log`；`main.log` 现在包含 electron-updater 自己的日志（之前打包后写 console、全丢），
  以及 `quitAndInstall` 前一刻的安装目录 / TEMP 盘剩余空间。

## 4. 问题 2：启动慢 / 首次超时

### 4.1 数据（本机 Mac、热缓存、无杀软——这是「理想下限」对照，不是 Windows 的耗时）

| 阶段 | 耗时 | 已读取不同文件 | 体积 | 另有 stat/realpath |
|---|---|---|---|---|
| server 起到 `/api/readyz` 200 | 0.27~0.42s（`Ready in 273ms`） | **434** | 4.8MB | 736 |
| 再加首页首次渲染 `GET /` | 0.31s | **848** | 12.7MB | 949 |

分布：就绪前 330 个来自 `node_modules/next`、47 个 `@opentelemetry/api`、29 个 `.next/server`；
首页后新增 `.next/server` 216 个、`zod` ~96 个、`@connectrpc` 52 个、`@bufbuild` 49 个。
**pi 依赖一个都没加载**（`agent-backend.ts` 里 `import("./custom-agent-backend")` 惰性加载）。
即：到可用为止只碰了安装文件总数的 **4.5%（就绪）/ 8.8%（首页）**。

### 4.2 机制（【推断】）

server 的 CPU 成本不到 1s，Windows 上的「慢」只可能来自**首次访问文件的延迟**：
未签名的新 exe（`Flowship.exe` 既当主进程又当 server，且每个版本哈希都是新的、没有信誉）+ 几百个刚写盘的新 JS，
逐个被杀软 / Defender 云查 / SmartScreen 放行；机械盘 / 冷缓存更放大。第二次启动判定被缓存，秒开。
Node 的 `require` 是同步串行读，延迟不会被并行摊薄。

敏感性估算（**纯算术示意，不是测量**）：就绪前 434 个文件，每个首次访问额外延迟 L：

| L | 10ms | 50ms | 100ms | 200ms |
|---|---|---|---|---|
| 到就绪 | 4s | 22s | 43s | 87s |
| 到首页（848 个） | 8s | 42s | 85s | 170s |

L 在 70~100ms 量级（重度杀软 + 机械盘并不罕见）就会撞穿 30s、逼近 60s。

### 4.3 为什么「第一次超时、第二次好」+ 为什么老用户一直中招

| 版本 | 等待策略 |
|---|---|
| v0.7.0 ~ v1.9.21 | **30 秒硬超时**，到点直接弹「启动超时」（commit `ac0e194` 之前） |
| v1.9.22 ~ v1.9.29 | 首次启动 150s、常规 60s；超时后 server 还活着则每轮续等 2 分钟，不再判死刑。同一批还把就绪探针换成零成本的 `/api/readyz`、把重活挪到就绪之后预热——这些**只减少了 CPU / 启动期工作量，对「首次访问文件的延迟」无能为力** |
| 本分支 | 同上，但「首次」的判定改为**按版本** |

- 30 秒版本上：第一次冷启动慢 → 超时；杀软缓存了判定 → 第二次秒开。**和用户描述完全一致**。
- 这批人想升级到 v1.9.22+ 就得走应用内更新（静默）——而他们若是手动装的（无标记），又被问题 1 的死锁挡回手动路径；
  手动装不走静默，但**每次更新装进来的都是全新的未签名 exe**，又是一次冷启动。
- 另一个缺口（【实锤】源码）：v1.9.22~v1.9.29 的 `first-boot-done` 是**全局一次性**标记（装过、跑通一次就永远「非首次」）。
  但**更新后的第一次启动同样是冷的**（新哈希 exe + 刚写盘的 9.6k 个文件，对杀软和全新安装没区别），却只拿到常规 60s。
  现改为标记里记版本号（`electron-app/first-boot.mjs`，纯函数 + 单测）：版本一致才算「非首次」；
  没有标记 / 损坏 / 旧版本写的无 version 标记 / 版本不同，一律按首次对待。

### 4.4 新增的诊断（为了下次能「看见」而不是猜）

- `[main] disk install=… free=…G tmp=… free=…G userData free=…G argv=…`（排除「盘快满」线索；安装器拉起的首启带 `--updated --force-run`）；
- 启动偏慢（>30s）且最终就绪后，后台记 Windows 安全中心登记的杀软清单（`root/SecurityCenter2 AntiVirusProduct`，10s 超时、不影响启动）。
  脚本让 PowerShell **输出 Base64(UTF-8)**（PowerShell 5.1 的 stdout 被重定向时用 OEM 代码页——简中是 GBK——而 Node 按 UTF-8 解码，
  360 / 火绒 / 腾讯电脑管家的中文名会乱码；这是机制推断、未在 Windows 复现），并把结局分开记：没登记 / 查询失败（如 Server 版没有该命名空间）/ 超时 / 拉不起 PowerShell，
  不再一律「（没取到）」；
- 「启动超时」弹框写明日志目录，让用户整个发过来。

## 5. 问题 3：安装慢 / 进度条卡住

### 5.1 机制（【实锤】模板 + 官方安装器核对）

- `extractAppPackage.nsh:92-130` `extractUsing7za`：先 `Nsis7z::Extract` 到 `$PLUGINSDIR\7z-out`（第 97 行），
  再 `CopyFiles /SILENT "$PLUGINSDIR\7z-out\*" $OUTDIR`（第 108 行）——**每个文件被写两遍**；`CopyFiles /SILENT` 这一段**不更新进度条**；
- `installSection.nsh:5-7`：非静默模式 `SetDetailsPrint none`，详情文字全部压掉；
- 所以用户看到的是：进度条走完解压那一段后**停住**，实际上在无进度地拷 9,657 个文件。
  每个小文件的创建 / 关闭都会触发杀软的写后扫描——**按文件数计费，不是按字节**。
  447MB 里 `Flowship.exe` 一个就 221.5MB，另 9,656 个文件加起来才 226MB。
- 官方安装器未签名（PE 证书表为空）：下载来的安装器会触发 SmartScreen / 云查，也拖慢首次执行。

### 5.2 对「另一个 AI：Next 打包出来的文件太多」的判断

**机制对，归因不准。** 全部 9,657 个文件的互斥构成：

| 类别 | 文件数 | 占比 | 体积 | 说明 |
|---|---|---|---|---|
| **pi 独占依赖闭包**（`@earendil-works/pi-*` 及仅它引用的 116 个包） | **5,319** | **55.1%** | 33.1MB | 只有配置了**自定义供应商**才加载；默认 Cursor 路径一个都不碰（§4.1 实测）。大头：`openai` 838、`@earendil-works/pi-coding-agent` 460、`highlight.js` 396、`@smithy/core` 384、`json-schema-to-ts` 382、`@anthropic-ai/sdk` 317 |
| `node_modules/next` | 1,154 | 11.9% | 25MB | 就绪前实际读 330 个 |
| `.next` 构建产物 | 1,057 | 10.9% | 36.9MB | 首页后实际读 ~250 个 |
| 其余 node_modules（pi 与其他共用 + 其他运行时依赖） | 2,078 | 21.5% | — | |
| app-server 其余（prompts / skills / server.js 等）+ Electron 外壳 | 49 | 0.5% | — | 外壳本体只有 24 个文件 |

「Next 产物」（`next` 包 + `.next`）合计 2,211 个、23%；**pi 是它的 2.4 倍**。
`.d.ts` / `.map` / `.md` 等死重已经被现有裁剪清干净了（全载荷只剩 24 个、0.2MB），**没有零风险的「删垃圾文件」可做**——
剩下的都是真实运行代码，要减只能「打包合并」或「不随包 / 惰性获取」。

### 5.3 方案与实测数字（本分支未实施：没有 Windows 真机就没法 A/B，见 §7、§8）

| 方案 | 收益（实测 / 估算） | 代价 / 风险 |
|---|---|---|
| A. 把 pi 闭包用 esbuild 等打成少数几个文件（或改为首次选自定义供应商时再下载） | 文件数 **−5,319（−55%）**；体积基本不变（33MB） | pi 有 ESM / 动态 import / 语言包惰性加载等，需要 spike；影响 `assemble-server.mjs` 与 Next 的 externals |
| B. `nsis.useZip: true` | 模板走 `nsisunz::Unzip` 直接解到 `$INSTDIR`（`extractAppPackage.nsh:81-82`）：**去掉 7z-out 那一遍落盘 + 无进度的 `CopyFiles`** | 包体 118.2MB → 160.9MB（**+43MB、+36%**，而每次更新都是整包下载，无差分）；失败时 `MessageBox` + `Quit` 无重试 / 原子拷贝语义 |
| C. app-server 打 asar | 文件数骤降到 ~1 个 | `server.js` 启动 `process.chdir(__dirname)`、`.next/cache` 写入、原生 `.node` / 可执行文件需 `asarUnpack`——风险最高，需要单独 spike |
| D. 更新改为带进度窗口的非静默 | 用户看得到进度，不再以为卡死 | 改变更新交互；仍然慢 |
| E. 代码签名（Authenticode；EV 或至少 OV / Azure Trusted Signing） | 同时作用于问题 2、3：SmartScreen / 杀软信誉，**这是文件数以外最大的杠杆** | 需采购证书、改 CI；EV 才能立刻消除 SmartScreen 警告 |

建议次序：**E（并行推进）→ A（先 spike）→ B（在真机 A/B 后再决定）→ D**；C 放最后。

## 6. 本分支改动

| 文件 | 改动 |
|---|---|
| `packaging/installer.nsh` | 标记每次安装都写；`flowshipLog` 宏 + `installer.log`（路径只记盘符）；`customInit` 记 `init` 行并做 TEMP 盘空间预检——自动更新静默 `Abort`、手动安装弹 `MessageBox`（默认「否」）、量不到 / 静默安装放行；`customInstall` 记 `done` 行与耗时 |
| `electron-app/first-boot.mjs`（新） | 首启判定 / 超时取值纯函数 |
| `electron-app/disk-space.mjs`（新） | 磁盘空间换算与预检纯函数（可注入 `statfs`）；`MIN_TEMP_FREE_MB` 阈值的唯一 JS 来源 |
| `electron-app/win-update-guard.mjs` | 新增 `findInstallerAbort`（从 `installer.log` 找预检拦截记录）、`buildSpaceBlockedMessage`、`buildUpdateFailedMessage`（弹框文案：空间在前、手动安装在后）；标记内容仅作诊断的注释 |
| `electron-app/security-products.mjs`（新） | 杀软探测脚本（Base64 输出）+ 结局分类 / 文案 |
| `electron-app/main.js` | 版本化首启标记；磁盘余量 + argv 日志；**主进程磁盘预检**；慢启动杀软清单；超时与「上次更新没有装上」弹框读 `installer.log`、按有无 `ABORT` 给不同文案；electron-updater 日志接入 `main.log`；`quitAndInstall` 前记现场；`waitForReady` 默认值引用 `REGULAR_BOOT_TIMEOUT_MS` |
| `src/lib/server/diagnostics.ts` | 诊断包带 `installer.log`（取尾 64KB，没有则不出现） |
| `tests/first-boot.test.ts`、`tests/diagnostics-installer-log.test.ts`、`tests/disk-space.test.ts`、`tests/security-products.test.ts`（均新）、`tests/win-update-guard.test.ts`、`tests/windows-auto-update-contract.test.ts`、`tests/startup-boot-contract.test.ts` | 新增 / 更新，并做了**变异验证**：初版 29 个变异 + 合并前评审后续提交 79 个（换算与 NSIS 单位 13、主进程预检与弹框 23、NSIS 手动警告与日志盘符 22、杀软探测 21），全部被测试杀死。过程中暴露并补上的漏洞：截断半行解析、只有 `killed` 无 `signal` 的超时、`ERR:` 详情清洗 |

验证：`pnpm typecheck`、`pnpm lint` 通过；全量 vitest 320 个文件 / 4,139 个用例通过（另有仓库原本就 skip 的 1 个文件 / 3 个用例）；NSIS 在 `-WX` 下真实编译通过。
注意：NSIS 与 `main.js` 的大部分断言是**字符串级契约**——它们能防回退，**不能**证明 Windows 上的运行时行为。
写入端 ↔ 读取端的对账是例外：`ABORT` 日志行用安装器源码里的**真实模板**渲染后喂给 `findInstallerAbort`，改一边漏一边会红。

两个对排障有用的 NSIS 细节（都踩过）：
1. `GetDiskFreeSpaceEx(…, *l .r1, *l .r2, *l .r3)` 的输出寄存器会覆盖 `$2`，「量不到」的默认值 `"?"` 必须在调用**之后**赋；
2. 仅安装器 pass 用的 `Var` 必须包在 `!ifndef BUILD_UNINSTALLER` 里，否则卸载器 pass 声明了没人用，`-WX` 下警告变错误、整包打不出来。

## 7. 未验证项（诚实清单）

1. 死锁修复后：手动装新版 → 目录里真有 `.silent-update-ok` → 下次应用内更新真走静默并成功——**Windows 真机 0 次验证**；
2. 预检：`System::Call` 取 TEMP 盘空间的数值是否正确、`.onInit` 里 `Abort` 在 `/S` 下的退出行为、`installer.log` 写入权限、
   **手动安装的 `MessageBox` 是否真的弹出 / 默认按钮是「否」/ 选「否」后旧版本完好 / 选「是」后继续安装**——**只验证了能编译**
   （单位换算与比较口径在 Mac 上有单测；`$TEMP` 与 Node `os.tmpdir()` 是否同一目录属推断，二者都走 `GetTempPath` 语义）；
3. 「空间不足导致非 C 盘用户被删光」只是**最强嫌疑**，没有任何用户日志证实（这正是加 `installer.log` 的原因）；
4. 启动慢的根因（杀软 / 磁盘 / 信誉）**没有任何一台 Windows 的实测数据**；§4.2 的估算只是示意；
5. 各方案的收益（尤其 A / B）是结构性推算，不是 Windows 上的耗时；
6. 杀软探测的 PowerShell 脚本：macOS 上没有 Windows PowerShell，**脚本本身没有执行过**；解析端（Base64 往返、各结局分类）有单测。
   「OEM 代码页会让中文杀软名乱码」是机制推断，同样没在 Windows 复现。

## 8. Windows 真机验证计划（VM 即可，干净 Win10/11）

| 实验 | 步骤 | 看什么 |
|---|---|---|
| **E0 最便宜的一步（评审建议）** | 找一台 Windows **手动装一次**本分支构建（手动安装不会被拦，但 `init` 行照写）；打开 `%APPDATA%\fe-ai-flow\logs\installer.log` | `tempFreeMB=` 是否与资源管理器里该盘剩余空间（MB）一致——**一次验证三件事**：`System::Call` 的取值、单位、日志写入权限；同时看 `instDrive=` / `tempDrive=` 是否是盘符、整个文件有没有乱码 |
| E1 死锁 | ① 装 v1.9.29，确认安装目录**没有** `.silent-update-ok`；点更新 → 弹「手动更新一次」；② 手动装本分支构建；③ 看目录里有 `.silent-update-ok`；再发一个更高版本，点更新 | 第二次更新是否静默完成、`installer.log` 的 `init`/`done` 行、`main.log` 里 `[electron-updater]` 与 `[updater] win quitAndInstall(silent)` |
| E2 预检（三条路径） | 让 `%TEMP%` 所在盘剩余 <800MB：开 `diskpart` 建一个 ~600MB 的 VHDX 挂成 `T:`，`set TEMP=T:\ & set TMP=T:\` 后再启动 App / 安装器。① **新客户端**点更新；② **v1.9.29 装的存量客户端**点更新（拉起的是新安装器）；③ **手动**双击安装器覆盖安装 | ① 主进程弹「磁盘空间不足，暂不更新」、App 不退出、`main.log` 有「拒绝静默更新」；② 安装器静默退出、`installer.log` 出现 `ABORT`、旧版本完好，下次打开弹旧文案；③ 弹 `MessageBox`：回车 / 空格 = 「否」→ `WARN` + `DECLINED`、旧版本完好；选「是」→ `CONTINUE` 并正常装完 |
| E2b 预检不误伤 | 剩余空间正常（>800MB）的机器各跑一遍手动 / 静默安装 / 应用内更新 | **不弹任何框**、`installer.log` 只有 `init` / `done`；`/S` 静默安装在低空间时也不弹（无界面可问） |
| E3 安装耗时 | 同一台机器：Defender 实时防护开 / 把安装目录与 `%TEMP%` 加排除 / 关；各装一次（`/S` 与向导各一次） | `installer.log` 的 `elapsedSec`；Process Monitor 看 `CopyFiles` 阶段耗时；之后 A/B `useZip` |
| E4 冷启动 | 装完立刻首启，抓 `main.log`；再启一次对比 | `server 就绪、轮询耗时`、`[main] disk …`、`启动偏慢…杀软清单`；两次差距 = 首次访问文件的开销 |
| E5（可选）并行预读 | 用探针导出 434 / 848 个启动文件清单，壳在拉起 server 的同时并行预读（只读、失败静默） | 若 E4 证明慢在 IO 延迟，预读能否把「串行 N×L」摊成「N×L/并发」——**先量再决定做不做** |
| E6 杀软探测 | 在**简体中文** Windows（最好装了 360 / 火绒 / 腾讯电脑管家）的 PowerShell 里直接跑 `electron-app/security-products.mjs` 里的 `SECURITY_PROBE_SCRIPT`，再用 `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(<OK: 后面的内容>))` 解码；Windows Server 上再跑一次 | 中文名是否完整、不是乱码；Server 版是否输出 `ERR:CimException`（日志里记成「查询失败」而不是「没登记」）；脚本有没有语法错误 |

用户侧收集：让出问题的人用「导出诊断包」（已含 `installer.log` + `main.log` 尾部），或直接打包 `%APPDATA%\fe-ai-flow\logs\` 整个文件夹。

## 9. 合并前独立评审的处置

评审结论是「建议合并，合并前补 1 处测试」：核心主张独立核对后都成立（死锁成立且修复正确、预检位置安全、阈值与 565MB 峰值自洽、
electron-updater 的 logger 只接 info / warn / error 是安全的、首启标记没有其他依赖）；风险集中在两点——**Windows 真机 0 次验证**，
以及关键改动恰好都落在只有真机才能验证的 NSIS 运行时上。逐条处置如下（每条都先独立复核、不是照单全收）：

| # | 评审意见 | 复核结果 | 处置 |
|---|---|---|---|
| 1【中】 | 预检的单位换算零测试保护，而它是存量用户升级时的唯一防线 | **属实**。复现了 4 个变异——NSIS 除数改成 GB / KB、`diskFreeGB` 单位写错、删掉 `flowshipInitTick` 赋值——测试全部保持绿色 | 采纳「更好的做法」：抽出 `electron-app/disk-space.mjs`（可注入 `statfs` 的纯函数）+ 单测；契约钉死 NSIS 除数 = JS 侧 `BYTES_PER_MB`、`GetDiskFreeSpaceEx` 输出寄存器顺序、计时起点先后、毫秒→秒。这 4 个变异现在全红 |
| 2【中】 | 预检拦下后用户没有出路；手动安装路径没有保护；新弹框顺序有问题 | **属实**。`installSection.nsh` 无条件 `uninstallOldVersion`，手动覆盖安装同样先搬走旧文件；存量客户端被静默 `Abort` 后弹的是旧文案「去发布页手动安装」 | 三条建议全部采纳（§3.2）：① 手动安装量到且不够时 `MessageBox`（默认「否」）；② 弹框读 `installer.log`，有 `ABORT` 给空间不足的针对性文案并先让用户清理、不再开发布页；③ 主进程在 `quitting = true` 之前补一道预检。**没有选「记为已知限制」**，原 RCA 的「手动安装不拦」已更正 |
| 3【低到中，推断】 | 杀软清单可能是乱码；超时与「Server 版没有命名空间」区分不开 | 机制推断合理（PowerShell 5.1 重定向 stdout 走 OEM 代码页、Node 按 UTF-8 解码），**无法在 Windows 复现** | 采纳 Base64 方案（不靠 `[Console]::OutputEncoding`）；结局分成没登记 / 查询失败 / 超时 / 拉不起 PowerShell。脚本本身没在 Windows 执行过（§7-6） |
| 4【低】 | `installer.log` 声称只写 ASCII 实际不保证（写了 `$INSTDIR` / `$TEMP`，中文用户名路径会乱码） | **属实**：头部注释与实际写入内容自相矛盾 | 采纳「只记盘符」；`日志只含 ASCII` 测试升级为**变量白名单**（只允许版本 / 阈值常量 / `$0-$9`）。未做「读取端 GBK 兜底解码」：从源头保证 ASCII 更稳，也不依赖用户机器的 ANSI 代码页恰好是 GBK |
| 5 小项 | ① 弹框 800MB 与 NSIS 阈值两处硬编码 ② 标记内容（版本号）没人读 ③ `waitForReady` 默认值与 `REGULAR_BOOT_TIMEOUT_MS` 重复 | **属实** | ① `MIN_TEMP_FREE_MB` 单一来源 + 对账测试；② 保留（有诊断价值），在 `hasSilentUpdateMarker` 注释里写明门禁只看存在性；③ 默认值改为引用常量 |

合并前清单：1 ✅ 已补；2 ✅ 已处理（采纳而不是记为已知限制）；3 ⏳ **需要 Windows 真机**——见 §8 的 E0（手动装一次，核对 `installer.log` 里
`tempFreeMB=` 与资源管理器里的剩余空间），这是最便宜的真机验证，能一次验证 `System::Call` 取值、单位、日志写入权限三件事。

需要强调的是：处置里新增的 NSIS `MessageBox` 与 PowerShell 脚本**同样落在只有真机才能验证的运行时上**（评审指出的风险类型并没有因此消失）——它们有契约测试 + 变异验证防回退，
也能通过真实 makensis `-WX` 编译，但弹框是否真的弹出、默认按钮、取消后旧版本是否完好，仍以 §8 的 E2 为准。
