# 项目 Agent 工作规则

## 借 Cursor 识图（无视觉能力的模型）

- 当当前模型没有图像输入能力、但需要识别图片（截图、界面选项、报错画面等）时，借用 `cursor-delegate` 让 Composer 2.5 识图，而不是直接回"看不了"。
- 图片获取：
  1. DSH 宿主已配置文本模型图片兜底（`textModelImageFallback: save-to-inbox`、`imageInboxDir: .agents/tmp-vision`）：用户贴图发送后，当前模型会收到一条插件源通知，其中包含图片已保存到 `.agents/tmp-vision/` 的文件相对路径，直接使用该路径即可。
  2. 其他宿主或通知缺失时，请用户提供图片文件路径。
- 清理机制：每次识图前先清空 `.agents/tmp-vision/` 内残留的旧图片（目录已入 `.gitignore`；DSH 侧另有 24 小时 TTL 兜底清理）；简报中使用相对工作区路径；worker 沙箱只允许读写工作区，不要把工作区外的路径直接交给它。
- 执行 `node .agents/skills/cursor-delegate/scripts/run-cursor-agent.mjs --workspace <绝对路径> --task <简报>`；简报需说明：这是只读识图任务、图片相对路径、用户的具体问题，并要求逐项详细描述图片内容（文字、选项、状态、高亮等）。
- 把 worker 返回的识别结果转述给用户；无论成功还是失败，本轮结束后删除对应临时图片，保证 `.agents/tmp-vision/` 只在任务进行中存在文件。
- 识图结果是辅助证据：转述时说明来自 Composer 委派，不要声称是当前模型亲自看到。
- 截图可能包含客户数据或其他秘密时，先向用户确认再委派（图片会发送给 Cursor 服务）；worker 返回 `ok: false` 时如实报告，不要编造识别结果。

## 打包 / 验证流程（默认网页热更，用户要求打 app 才打包）

### 三端口约定

| 端口 | 服务 | 说明 |
|---|---|---|
| **8776** | FlowshipTest 桌面包 | 测试 App 内嵌 server，`pnpm electron:test:restart` 重启后就是它 |
| **8876** | Flowship 正式桌面包 | 正式 App 内嵌 server（别动） |
| **8676** | test 网页热更 | `pnpm dev:web`（`next dev` + HMR），日常改 UI 看它 |

> 注意：8776 是「测试桌面包」的端口、**不是**独立网页服务。想网页热更请走 `pnpm dev:web`（8676），不要直接用 8876（正式包占用）或去碰打包。

> ⚠️ agent shell 环境坑：宿主（Electron）拉起 app-server 时注入了 `ELECTRON_RUN_AS_NODE=1`、`PORT`、`HOSTNAME`、`FLOWSHIP_DATA_DIR`、`__NEXT_PRIVATE_STANDALONE_CONFIG` 等变量。带着这些裸启动 Electron 二进制 / `open xxx.app` 会静默秒退（被当纯 node 跑）、`next build/dev` 会报 `generate is not a function`。`stripHostInjectedEnv()`（见 `src/lib/server/host-env.ts`）**只清洗了 pi provider 的 shell 工具**；**Cursor provider 的本地 agent shell 由 Cursor SDK 内部拉起，SDK（1.0.37）没有给本地 agent 的 env 选项，会原样继承 server 的整份 env**——实测 `PORT=8876`、`HOSTNAME`、`FLOWSHIP_DATA_DIR=<正式数据目录>`、`__NEXT_PRIVATE_*` 都在。所以在 Cursor 会话的 shell 里，凡是会碰数据目录 / 端口的命令（`next dev/build`、起服务、手写脚本）先清：`env -u ELECTRON_RUN_AS_NODE -u FLOWSHIP_DATA_DIR -u FLOWSHIP_PORT -u PORT -u HOSTNAME -u __NEXT_PRIVATE_STANDALONE_CONFIG -u __NEXT_PRIVATE_ORIGIN -u NEXT_DEPLOYMENT_ID <命令>`。**vitest 不用自己清**：`tests/setup/hermetic-env.ts` 在每个测试 worker 起跑前把数据目录指到临时目录并剔掉这些变量，`task-fs` 的 `ensureBootRecovery` 另有运行时防线（VITEST 下数据目录若是正式 userData 就拒绝执行 boot-recovery，判定见 `src/lib/server/app-data-dir.ts`），跑测试不会再改到正式数据里的任务状态。自写脚本要 spawn 子进程时也应传清洗后的 env，参考 `scripts/electron-test-restart.mjs` 的 `cleanEnv()`。

### 跑无头 Electron 脚本（e2e / 探针）：必须走启动器

- agent 要在后台起 Electron 跑自写脚本（`scripts/browser-e2e/*.cjs` 之类）时，**一律** `node scripts/browser-e2e/run.mjs <脚本> [--timeout 秒]`，**不要**直接起 `node_modules/electron/dist/.../Electron <脚本>`。
- 原因（2026-11-07 事故）：脚本有语法错误或主进程抛未捕获异常时，Electron 默认弹**原生模态错误框**（"A JavaScript error occurred in the main process"）并挂住等人点「好」——弹在用户屏幕上、进程也不退出。启动器先 `node --check` 预检（语法错误只在终端报、不起 Electron）、再经 bootstrap 把未捕获异常 / dialog 改成打印 + 非零退出、超时整组杀、不留 Dock 图标，并且已清洗宿主注入的环境变量，不必再手写那串 `env -u …`。
- **钥匙串弹窗（2026-11-07 第二起事故）**：内置浏览器的 partition 是 `persist:` 的，Chromium 启动就要去 macOS 钥匙串取 Cookie 加密密钥（服务名 `Electron Safe Storage`、账户名 `Electron Key`）；用户机器上默认钥匙串缺失 / 锁着时，每起一次 Electron 就弹一次「找不到用于储存 “Electron Key” 的钥匙串」。bootstrap 已在 app ready 之前设了 `--use-mock-keychain`（linux 为 `password-store=basic`），所以**只要走启动器就不会碰系统钥匙串**——这也是又一个不能绕过启动器、直接起 Electron 的理由。
- 脚本自己仍要：userData 指向临时目录、窗口 `show:false`、跑完 `app.exit(0)`；只起 node_modules 里那份 Electron，不碰 Flowship / FlowshipTest 桌面包与 8676 / 8776 / 8876。

### 默认：网页热更新（最快）

- **日常改 UI 验证默认走 `pnpm dev:web`**：起 `next dev --turbo` 在 **8676**，自动清掉宿主注入的 `__NEXT_PRIVATE_STANDALONE_CONFIG` / `NEXT_DEPLOYMENT_ID` / `FLOWSHIP_DATA_DIR`（前两个会让 `next build/dev` 报 `generate is not a function`，后者常被注入成正式包数据目录）、再把数据目录写死到 `fe-ai-flow-test`、起完自动开 `http://localhost:8676/settings`。HMR 秒刷新，改完 typecheck/lint 过即可让用户刷新看效果，**不打包壳**。要换端口/数据目录用 `DEV_WEB_PORT` / `DEV_WEB_DATA_DIR`，别用 `PORT` / `FLOWSHIP_DATA_DIR`。`pnpm start` 同样是 `next dev --turbo`（默认 8876，别跟正式桌面包抢端口）。
- 生产 / `next build` 仍走 webpack（发版链不动）；`next.config.mjs` 的 server 侧 `node:` externals 只给 webpack 用。开发一律 Turbopack（`turbopack.root`），不要再起无 `--turbo` 的 `next dev`。

### 打 test 包并重启（仅当需要 app 验收 / 用户明确要求）

- **用户明确要求「打 app / 打包看看」时就打**（用户不要求时默认网页热更，不要动辄打 5 分钟包）。
- test 打包和进程级重启不属于「操作 App」：授权范围仅是 **构建、组 server 布局、打 staging unpacked test 包、精确退出旧 FlowshipTest 进程、部署到规范路径、启动新 test 包**，不包含读取或操作界面。
- 一条命令：`pnpm electron:test:restart`（内部顺序：`BUILD_STANDALONE=1 pnpm build` → `pnpm electron:server` → `pnpm exec electron-builder` 打 **staging**（`dist/electron/.test-restart-staging/`、`productName=FlowshipTest`）→ 确认 staging 产物 → 退出旧 FlowshipTest → 备份并替换规范路径（mac `dist/electron/mac-{arch}/FlowshipTest.app` / win `dist/electron/win-unpacked/FlowshipTest.exe`）→ 启动规范路径新包）。仅 `electron:dist:test` 仍可用于只打 mac test 包（仍写规范路径）。
- 脚本内已固化两条修复：① spawn 前自动剔除注入的 standalone 环境变量（防 `generate is not a function`）；② 退出旧测试 App 时 osascript 优雅退出被 TCC 权限拦 / 超时，自动降级成进程级精确退出（`pkill -x FlowshipTest`，不碰正式 Flowship）。
- **启动方式：mac 直启二进制、禁止 `open -n`**（2026-08-24 固化）：从 agent 宿主链路 `open -n` 拉起的 FlowshipTest 会静默早退（两次实测、无崩溃日志），直启 `<app>/Contents/MacOS/FlowshipTest` + 清洗环境变量稳定。脚本已改（detached 直启 + cleanEnv 额外剔除 `ELECTRON_RUN_AS_NODE` / `PORT` / `HOSTNAME` / `FLOWSHIP_DATA_DIR`）；手动拉起时也照此：`env -u ELECTRON_RUN_AS_NODE -u PORT -u HOSTNAME -u FLOWSHIP_DATA_DIR nohup <二进制路径> &`。另：跑过 `pnpm dev:web` 后直接 `next build` 会撞 Turbopack 缓存（`Cannot find module '../chunks/ssr/[turbopack]_runtime.js'`），打包前先 `rm -rf .next`。
- **mac test 包用本机固定证书签名**（否则每次重新打包身份都变，「电脑操作」的系统授权和钥匙串里保存的开机密码都失效）：证书由 `node scripts/electron-test-signing.mjs` 创建一次（幂等；放 `~/.flowship-test-signing/` 的专用钥匙串，不碰登录钥匙串）。已存在就沿用，**不要重建**——换证书 = 用户的授权全部重来。`pnpm electron:test:restart` 找到证书会自动解锁并签名，没有就退回 ad-hoc 并在日志里明说。mac test 包另用独立 bundle id `com.jianger.fe-ai-flow.test`（与正式版区分，`electron-builder.yml` 不动）。这张证书只配签本机 test 包，禁止用于发版。
- 验证「电脑操作」这类依赖系统授权（辅助功能 / 屏幕录制）的功能时，别用脚本的直启：直启会继承 agent 宿主链路的「责任进程」，授权被系统算到正式 Flowship 名下；改用 `open <app>`（**不加 `-n`**）启动，或让用户从 Finder 打开。
- 命令调用：`process.execPath` + `npm_execpath` 调 pnpm，`pnpm exec electron-builder` 调 builder；禁止依赖 `pnpm.cmd` / `electron-builder.cmd` 或 shell 拼接。
- 该流程只做进程级重启。**构建/打包失败**：旧 FlowshipTest 保持运行、脚本非零退出。**部署失败**：尽力从 `dist/electron/.test-restart-backup/` 恢复上一可用包并尝试启动旧版，再非零退出。**启动失败**：新包已在规范路径时给出明确错误。
- 只终止精确命名的 **FlowshipTest** 测试进程，不得影响正式 **Flowship** 或其他 Electron 进程。

### 改 Windows 解锁组件前必读（`electron-app/desktop/win-helper/`）

设计、协议、安装链路、已知局限见 `docs/COMPUTER-USE.md`；给同事做真机验收的清单见 `docs/windows-unlock-live-test.md`。动这个目录前记住六条：

- **资源哈希**：改了 `assets/` 里任何一个文件（`FlowshipUnlockHelper.cs` / `install.ps1` / `uninstall.ps1`），**必须跑 `node scripts/win-helper-hashes.mjs`** 把新哈希写回 `protocol.mjs`（`--check` 只校验、不写）。这三个文件会被提权执行，而 Flowship 的安装是用户级的（脚本落在用户可写目录），所以安装时要和写死的 SHA-256 对上才放行；不写回的话单测、afterPack、安装器三处都会拦。哈希按「去 BOM、CRLF→LF」后的 UTF-8 算，`.gitattributes` 已把 `assets/*` 固定成 LF。**改的是 service / typist 的运行行为（不只是协议字段）时，还要把 C# 的 `Const.Version` / `Const.Proto` 与 `protocol.mjs` 的 `HELPER_VERSION` / `PROTOCOL_VERSION` 一起 +1**：旧版 service 不会因为磁盘上的 `.cs` 变了就变，不升版本的话，装着旧版的机器不会被设置页提示升级（第三轮改了冷却恢复语义却没升，第四轮评审才补成 v2；第五轮 `DoSet` 只在冷却确实还在时才回 `COOLDOWN_NOT_CLEARED`，升到 v3；第六轮 `CredStore` 判断凭据「有没有」不再用 `File.Exists`、保存改成先试 `File.Replace` 再回落 `File.Move`，升到 v4）；单测只对账两边一致，不会替你判断该不该升。
- **语法版本**：C# 只能写 **C# 5**（Windows 自带编译器的上限，不要字符串插值、`?.`、`nameof`、表达式体成员、`out var` / 内联 `out T x`、`is T x`）；机器门禁是 `tests/helpers/csharp5-gate.ts` 的规则表（`CSHARP5_RULES`，带违规 / 合法两组样例），**改规则或样例集后要用 Roslyn（C# 5 解析）把样例逐个重新验一遍**（违规的必须被拒、合法的必须 0 错）；它是文本级启发式、只是第一道，按 `docs/COMPUTER-USE.md` §6 用 Roslyn 重编译才是最终的；`.ps1` 必须在 **Windows PowerShell 5.1** 上能跑（不要用 PowerShell 7 才有的语法 / 参数）。在 mac 上用 pwsh 7 只能证明语法和语义，证明不了 5.1。
- **开机密码**不能出现在日志、命令行参数、环境变量、返回值、步骤事件、审计里；只允许存在于 helper 进程内存和 DPAPI 密文里。
- **没有真实 Windows 机器，就不要对外说「Windows 已验证」**：现状是写好 + 静态对账 + 单测。真机跑出的结果写回 `docs/COMPUTER-USE.md` 第 7 节（未验证假设）。
- **服务的接受循环运行期永不因为「接不到客户端」而退出**（退出码 3–6 只能出现在启动阶段）：管道最多 8 个实例，同账户的进程能把它们占满，而计划任务只会重启 5 次——「连续失败 N 次就退出」会把这种占用变成永久停摆。出错只做「丢掉坏实例、退避重试、限频记日志」，日志里不记 `ex.Message`；已连上的客户端要先交给工作线程、再建下一个监听实例。`tests/desktop-win-helper-protocol.test.ts` 钉着，细节见 `docs/COMPUTER-USE.md` §5.3 / §5.4 ⑥。
- **冷却（`Cooldown`）的恢复语义不能退回「读不了就恒当作整段冷却 / 冷却明明还在却回 OK」**：状态文件读不出来时要从修改时间起算（会倒计时）；`Clear()` 返回有没有真的清掉；保存开机密码（`DoSet`）时冷却记录清不掉，只要**冷却确实还在**（`Cooldown.StillBlockedSeconds() > 0`；读不了状态文件时 `Remaining()` 按修改时间起算、不是 0，所以「读不了」不会被当成「没有」）就回 `COOLDOWN_NOT_CLEARED`——带 `saved=1`（**密码其实已经存上了**，只是冷却没清掉，别把它说成「没保存」）和 `wait`（还剩几秒）；记录只是个早已过期的时间戳（`Remaining()` 为 0）则只记日志、照常回 `OK`（那种情况回 `COOLDOWN_NOT_CLEARED` 是误报，v3 起改的）；读到远在未来的截止时刻要**夹紧**（第一次发现时定下「那一刻 + 一整段」并固定，只由 `Start()` / `Clear()` 重置；**已知限制**：同一个冷却期里连续两次把系统时钟拨回去、而旧的夹紧值已过期时，冷却会立刻归零——fail-open、触发条件极窄，故意没改，见 `docs/COMPUTER-USE.md` §5.3），不能每次都回满格（那样冷却永远结束不了）；判断**冷却状态文件 / 凭据**「有没有」**不要用 `File.Exists`**（没权限时它也返回 `false`，会把「看不见」当成「没有」；**范围仅限这两处**——`.cs` 里 `config.txt` / `pipe.txt` / 日志轮转这三处仍是 `File.Exists`，是已知没改的，见 `docs/COMPUTER-USE.md` 里「三处仍用 `File.Exists`」那条，别当成已全部清掉），直接读 / 直接删，只把 `FileNotFoundException` / `DirectoryNotFoundException` 当作不存在（`CredStore` 同理，v4——第六轮评审 P2-3：`Exists()` 用 `File.GetAttributes`，其余异常按「可能存在」处理、交给 `Load()` 去真读；`Save` 不先问有没有，直接 `File.Replace`，失败再回落 `File.Move`，目标已存在就抛、不静默覆盖）。这块逻辑能在没有 Windows 的机器上真跑：`tests/helpers/win-helper-cooldown-harness.ps1` 把 C# 里真实的 `Cooldown` 与 `CredStore` 类抠出来（DPAPI 换成恒等桩，验的是文件语义不是加解密）在 PowerShell 7 / .NET 里跑，`tests/desktop-win-helper-pwsh.test.ts` 钉着（本机要 `FLOWSHIP_PWSH` 指向 pwsh 7；`CI` 里缺 pwsh 会红）。改了它同样要重跑 `node scripts/win-helper-hashes.mjs`，并按 `docs/COMPUTER-USE.md` §6 的做法用 Roslyn 按 C# 5 重编译一次（带反例）。

## 发版流程（用户说发版才做）

- **用户说「发版」只授权打 tag + push，不等于同意弹窗文案**：`src/lib/whats-new.ts` 本版条目草稿必须先给用户过目，**用户亲口说行才能 tag**（2026-09-03 v1.9.7 踩过：直接 tag 了才想起来文案没确认）。
- 顺序：门禁（单测/tsc/eslint）→ whats-new 草稿给用户看 → 用户同意 → commit → tag → push。缺“用户同意文案”这一步，tag 绝不动手。
