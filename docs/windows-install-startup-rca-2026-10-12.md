# Windows 安装 / 自动更新 / 启动 三类问题排查与修复（2026-10-12）

> 分支：`fix/windows-install-update-startup`（基于 main v1.9.29）。
> 置信度标注：【实锤】= 源码 / 二进制 / 本机实测直接证明；【推断】= 机制成立、数据支持，但**没有在 Windows 真机上复现**；【待验证】= 需要 Windows 真机实验才能下结论。
>
> ⚠️ **本次排查全程在 macOS 上完成，没有任何一项在 Windows 真机上运行过。**
> NSIS 脚本用真实 `electron-builder` + makensis（`-WX`：警告即错误）编译验证过语法与链接，
> 并解开产物头部确认新逻辑进了安装器；但运行时行为（`System::Call` 取磁盘空间、日志写入、
> `.onInit` 里 `Abort`、`StdUtils::Time`）属【待验证】。
> 与本文互补的两篇：`windows-slow-rca-2026-07-17.md`、`cursor-sdk-windows-performance-investigation-2026-07-16.md`
> 讲的是**运行期** shell 慢（SDK 的 PowerShell 执行器），与本文的安装 / 更新 / 冷启动是不同问题。

## 1. TL;DR

| # | 用户现象 | 结论 | 本分支做了什么 |
|---|---|---|---|
| 1 | 更新总有问题；装到非 C 盘、应用内更新后 App 被删（不知道修好没） | 【实锤】v1.9.22 起的静默更新门禁存在**逻辑死锁**：手动安装的人永远拿不到「可静默更新」标记，应用内更新永远被拒、只能手动装。早先的 `/D=` 引号 / Temp 目录两类「更新后人没了」已在 v1.9.11~22 加固，但**从没在真机验证过**。【推断】非 C 盘用户被删光的另一大嫌疑是 **%TEMP% 所在盘（多为 C 盘）剩余空间不足** | 修死锁；加静默更新**预检**（TEMP 盘 <800MB 直接退出、旧版本一个文件不动）；加 `installer.log` 黑盒记录；接入 electron-updater 日志 |
| 2 | 启动非常慢；首次启动常报「启动超时」，第二次才起得来 | 【实锤】server 本身的成本只有 0.27~0.4s（Mac 热缓存实测），冷启动到就绪只读 **434 个文件**；慢的是「第一次读这些文件」（磁盘 / 杀软 / 未签名 exe 信誉）【推断】。**v1.9.22 之前的版本是 30 秒硬超时**——「第一次超时、第二次好」与它完全吻合，而这批用户因为问题 1 的死锁**被卡在老版本上升不了级**。另外：首启宽限标记是全局一次性的，更新后的第一次启动（同样是冷的）只拿到 60s | 首启标记**按版本记**（更新 / 重装后的第一次启动重新给 150s）；日志补磁盘余量 / 启动参数；启动偏慢时记杀软清单；超时弹框写明日志目录 |
| 3 | 安装非常慢、进度条一直卡着；另一个 AI 说是 Next 打包文件太多 | 【实锤】「文件太多」的**机制是对的**（9,657 个文件、每个文件在安装器里被落盘两遍、无进度的 `CopyFiles` 那一段就是「卡住」）。但**归因不准**：Next 产物只占 23%，**只有配置了自定义供应商才会用到的 pi 依赖闭包占 55%**（5,319 个文件、才 33MB）。安装包也**没有签名**（实锤） | 本分支**未改打包**（没有 Windows 真机无法 A/B、盲改风险大）；给出带实测数字的方案与实验计划，见 §5.3、§8 |

## 2. 方法与证据

| 证据 | 来源 |
|---|---|
| 官方 v1.9.29 Windows 安装器（`fe-ai-flow-1.9.29-win-x64.exe`，123,895,072 B≈118MB）解包后的载荷 | 本机解开，9,657 个文件 / 447.4MB（`Flowship.exe` 单个 221.5MB） |
| 安装器内部流程 | electron-builder 26.15.2 的 NSIS 模板（`app-builder-lib/templates/nsis/include/extractAppPackage.nsh:92-130`、`installSection.nsh:5-7`）+ 用 Node 解出官方安装器头部核对 |
| 本分支的 NSIS 脚本能否编译 | 本机真实 `electron-builder --win nsis --x64 --prepackaged … --publish never`（macOS ≥ Catalina 免 Wine），makensis `-WX` 通过；产物头部里能找到 `installer.log` / `ABORT v` / `tempFreeMB` / `GetDiskFreeSpaceEx` / `.silent-update-ok` / `marker-write-failed` / `elapsedSec` |
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

**修法**：`.onInit`（任何破坏性操作之前）量 `%TEMP%` 所在盘剩余空间，**仅自动更新**且剩余 <800MB 时
写 `ABORT` 日志并 `Abort`——此刻旧版本一个文件都没动；下次手动打开时「更新墓碑」发现版本没变，
弹框说明常见原因（C 盘空间 / 杀软）并给出日志路径。量不到空间（UNC 等）一律放行；手动安装不拦（人在屏幕前）。
800MB 的依据是 565MB 峰值 + 余量；包体增长后需同步上调（测试里断言阈值 ≥ 565MB 且 ≤ 2GB）。

### 3.3 仍然存在的风险（【推断】，未改）

- 静默模式下 `CopyFiles` 重试 5 次（间隔 1s）后，模板会走「最后手段」：直接 `Nsis7z::Extract` 覆盖安装目录并**忽略错误**（`/SD IDRETRY`）——杀软锁文件 / 隔离文件时可能装出半截目录；
- 旧卸载器在更新时把旧文件搬到自己的 `$PLUGINSDIR\old-install`（临时目录，非 C 盘安装时是**跨盘**搬运，慢且吃 C 盘空间）再 `RMDir /r`，注册表项也先删；
- 安装包未签名（见 §5）。

### 3.4 可诊断性（新增）

- `%APPDATA%\fe-ai-flow\logs\installer.log`（与 `main.log` 同目录）：安装器每次安装 / 更新追加几行 ASCII 记录：
  - `init`：版本 / 是否自动更新 / 安装目录 / `%TEMP%` 路径与剩余 MB
  - `done`：总耗时秒 / 主程序是否在 / 标记是否写成
  - `ABORT`：预检拒绝
  （手动安装的耗时包含用户在向导页停留的时间；静默更新是纯安装耗时。）
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
- 启动偏慢（>30s）且最终就绪后，后台记 Windows 安全中心登记的杀软清单（`root/SecurityCenter2 AntiVirusProduct`，10s 超时、失败静默、不影响启动）；
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
| `packaging/installer.nsh` | 标记每次安装都写；`flowshipLog` 宏 + `installer.log`；`customInit` 记 `init` 行并做 TEMP 盘空间预检（仅自动更新、量不到放行）；`customInstall` 记 `done` 行与耗时 |
| `electron-app/first-boot.mjs`（新） | 首启判定 / 超时取值纯函数 |
| `electron-app/main.js` | 版本化首启标记；磁盘余量 + argv 日志；慢启动杀软清单；超时与「上次更新没有装上」弹框补排障线索；electron-updater 日志接入 `main.log`；`quitAndInstall` 前记现场 |
| `src/lib/server/diagnostics.ts` | 诊断包带 `installer.log`（取尾 64KB，没有则不出现） |
| `tests/first-boot.test.ts`（新）、`tests/diagnostics-installer-log.test.ts`（新）、`tests/windows-auto-update-contract.test.ts`、`tests/startup-boot-contract.test.ts` | 新增 / 更新；对上面每一条做了**变异验证**：29 个变异（标记退回只在自动更新写、阈值过小 / 过大、去掉 `Abort`、预检不限自动更新、「未知」默认值被输出寄存器覆盖、日志混入中文、`Var` 声明移出 `!ifndef BUILD_UNINSTALLER`、超时取值内联、标记不记版本、日志不接入……）全部被测试杀死 |

验证：`pnpm typecheck`、`pnpm lint` 通过；全量 vitest 318 个文件 / 4,089 个用例通过；NSIS 在 `-WX` 下真实编译通过。
注意：NSIS 与 `main.js` 的大部分断言是**字符串级契约**——它们能防回退，**不能**证明 Windows 上的运行时行为。

两个对排障有用的 NSIS 细节（都踩过）：
1. `GetDiskFreeSpaceEx(…, *l .r1, *l .r2, *l .r3)` 的输出寄存器会覆盖 `$2`，「量不到」的默认值 `"?"` 必须在调用**之后**赋；
2. 仅安装器 pass 用的 `Var` 必须包在 `!ifndef BUILD_UNINSTALLER` 里，否则卸载器 pass 声明了没人用，`-WX` 下警告变错误、整包打不出来。

## 7. 未验证项（诚实清单）

1. 死锁修复后：手动装新版 → 目录里真有 `.silent-update-ok` → 下次应用内更新真走静默并成功——**Windows 真机 0 次验证**；
2. 预检：`System::Call` 取 TEMP 盘空间的数值是否正确、`.onInit` 里 `Abort` 在 `/S` 下的退出行为、`installer.log` 写入权限——**只验证了能编译**；
3. 「空间不足导致非 C 盘用户被删光」只是**最强嫌疑**，没有任何用户日志证实（这正是加 `installer.log` 的原因）；
4. 启动慢的根因（杀软 / 磁盘 / 信誉）**没有任何一台 Windows 的实测数据**；§4.2 的估算只是示意；
5. 各方案的收益（尤其 A / B）是结构性推算，不是 Windows 上的耗时。

## 8. Windows 真机验证计划（VM 即可，干净 Win10/11）

| 实验 | 步骤 | 看什么 |
|---|---|---|
| E1 死锁 | ① 装 v1.9.29，确认安装目录**没有** `.silent-update-ok`；点更新 → 弹「手动更新一次」；② 手动装本分支构建；③ 看目录里有 `.silent-update-ok`；再发一个更高版本，点更新 | 第二次更新是否静默完成、`installer.log` 的 `init`/`done` 行、`main.log` 里 `[electron-updater]` 与 `[updater] win quitAndInstall(silent)` |
| E2 预检 | 把 C 盘（或 `TEMP` 指向的盘）塞到剩余 <800MB，触发静默更新 | `installer.log` 出现 `ABORT`；旧版本完好；下次打开出现「上次更新没有装上」弹框并带日志路径 |
| E3 安装耗时 | 同一台机器：Defender 实时防护开 / 把安装目录与 `%TEMP%` 加排除 / 关；各装一次（`/S` 与向导各一次） | `installer.log` 的 `elapsedSec`；Process Monitor 看 `CopyFiles` 阶段耗时；之后 A/B `useZip` |
| E4 冷启动 | 装完立刻首启，抓 `main.log`；再启一次对比 | `server 就绪、轮询耗时`、`[main] disk …`、`启动偏慢…杀软清单`；两次差距 = 首次访问文件的开销 |
| E5（可选）并行预读 | 用探针导出 434 / 848 个启动文件清单，壳在拉起 server 的同时并行预读（只读、失败静默） | 若 E4 证明慢在 IO 延迟，预读能否把「串行 N×L」摊成「N×L/并发」——**先量再决定做不做** |

用户侧收集：让出问题的人用「导出诊断包」（已含 `installer.log` + `main.log` 尾部），或直接打包 `%APPDATA%\fe-ai-flow\logs\` 整个文件夹。
