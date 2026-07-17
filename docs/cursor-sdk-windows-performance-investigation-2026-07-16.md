# Cursor SDK 在 Windows 上明显慢于 IDE：调研与后续验证方案

> 调研日期：2026-07-16  
> 项目：Flowship / `fe-ai-flow`  
> 当前 SDK：`@cursor/sdk@1.0.23`（调研当天 npm `latest` 也是 `1.0.23`）  
> 问题描述：多名 Windows 用户反馈 Flowship 中 Cursor SDK 的中间执行过程明显慢于 Cursor IDE，主要表现为 thinking 久、工具调用久、命令明明很简单但工具长时间不结束。

## 1. 结论摘要

当前证据支持以下判断：

1. **Windows 工具调用慢的第一嫌疑是 Cursor SDK 自己的 PowerShell 执行器。**正常从桌面启动打包后的 Flowship 时，服务进程通常没有 Git Bash 的 `MSYSTEM` / `SHELL` 环境，SDK 会选择 PowerShell。它不是复用常驻终端，而是每条 shell 命令都新起 PowerShell，恢复 shell 状态、执行命令、重新序列化状态，并创建/读取/删除临时文件。
2. **Cursor 官方已确认 Windows agent shell 使用不同于 IDE 集成终端的执行路径，且存在命令结束检测失败/延迟的已知问题。**这与“IDE 快、SDK 慢”和“命令已经结束但工具还在 running”的反馈高度一致。
3. **现有“Agent shell 提速”只覆盖 Bash/Zsh，基本没有覆盖典型 Windows PowerShell 用户。**Windows 没有 `.bashrc` 时，设置页还会显示“无需优化（未检测到 shell 配置文件）”，这个结论对 PowerShell 用户并不成立。
4. **thinking 慢还有 Flowship 自身的放大因素：每轮 prompt 很大。**本机 20 条近期启动日志中，首包 prompt 为 68–109KB，中位数 91KB；每个 action 默认 fresh agent，首轮必须重新注入完整规则、skills、playbook 和上下文。后续每次工具输出又继续扩充模型上下文，因此影响的不只是启动，也包括每个“工具完成 → 下一次 thinking”的模型往返。
5. **当前日志不足以给 Windows 慢点定责。**现有实现没有记录普通工具成功完成的时间、工具墙钟耗时、shell 自报 `executionTime`、thinking delta、每个 model step 的耗时，也没有保存 SDK `requestId`。当前 `first-event` 计时位置还会系统性得到接近 0ms 的误导结果。
6. **Windows Defender / 企业 EDR 很可能进一步放大开销，但目前只是高概率假设。**SDK 每条 PowerShell 命令会读写临时脚本和状态文件，SDK 自身还会写 SQLite/WAL；Flowship 又逐事件 append `events.jsonl`。企业 Windows 上的同步文件扫描可能使这些高频小 IO 明显变慢。
7. **同事截图中的 Clash Verge 故障是本机 Service IPC 失败，不是已经进入 Wintun 驱动安装后失败。**它不能解释本地 `read/shell` 工具为什么慢，但说明这台机器的 TUN 没有生效；如果 Flowship/SDK 与 Cursor IDE 实际走了不同代理路径，可能额外放大 thinking、模型请求或远程 MCP 延迟，需作为独立变量做 A/B。

因此，建议先补齐“模型等待 / 本地工具 / MCP / 事件持久化”四段耗时，再做 PowerShell、Git Bash、Profile、Defender/Dev Drive 的 A/B；不要先凭体感只改 prompt 或只切模型。

## 2. 需要区分的四种“中间慢”

用户界面上的一条“调用 shell / read / mcp”并不能说明具体卡在哪里。至少需要拆成：

| 阶段 | 起点 → 终点 | 可能的瓶颈 |
|---|---|---|
| A. 模型决定工具 | 上一个事件 → `tool-call-started` | 模型排队、reasoning、超大上下文、网络 |
| B. 工具真实执行 | `tool-call-started` → `tool-call-completed` | PowerShell/进程启动、文件 IO、MCP 网络、Defender/EDR |
| C. 工具后模型续跑 | `tool-call-completed` → 下一条 thinking/text/tool | 工具结果回传、上下文膨胀、下一次推理 |
| D. UI/持久化延迟 | SDK 事件到达 → SSE/UI 可见 | Flowship 串行 append JSONL、meta 写入、渲染合并 |

当前 Flowship 基本只看到工具 running，并不能把 B、C、D 分开。

## 3. 已确认的本地代码与 SDK 证据

### 3.1 项目使用的是当前最新 SDK

- `package.json`：`@cursor/sdk: ^1.0.23`
- `pnpm-lock.yaml`：各平台包均锁到 `1.0.23`，包含 `@cursor/sdk-win32-x64@1.0.23`
- 2026-07-16 执行 `npm view @cursor/sdk version dist-tags time --json`：`latest = 1.0.23`

因此问题不能简单归因为“项目还在用旧版 SDK”。后续 Cursor 发版仍应继续复测，因为它仍是 public beta，且近期一直在修本地执行器和平台问题。

### 3.2 Windows 默认会落到 PowerShell

直接检查安装包 `node_modules/@cursor/sdk/dist/esm/357.js`，可以找到以下内部逻辑（bundle 已压缩，建议搜索关键词定位）：

- shell 类型：`Zsh` / `ZshLight` / `Bash` / `PowerShell` / `Naive`
- shell 选择函数附近关键词：`function vt(`、`MSYSTEM`、`userTerminalHint`
- PowerShell 可执行文件选择：`function Ge(`
- PowerShell 状态执行器：`class Ve`

选择逻辑概括如下：

1. 如果 Windows 进程继承了 Git Bash 的 `MSYSTEM`，尝试 Git Bash。
2. 如果 `SHELL` / terminal hint 明确指向 Git Bash，则用 Bash。
3. 否则只要能找到 `pwsh` / `powershell`，就选择 PowerShell。
4. 再找不到才退到 naive shell。

Flowship 的 Electron 壳启动 server 时只是继承 `process.env`，没有显式设置 SDK shell：

- `electron-app/main.js:229-243`
- `src/lib/server/task-runner.ts:1582-1592`
- `src/lib/server/chat-runner.ts:718-745`

用户从开始菜单/桌面图标启动时通常不会继承 Git Bash 的 `MSYSTEM`，所以典型 Windows 用户会走 PowerShell。

### 3.3 SDK 的 PowerShell 工具不是常驻终端

在同一个 `357.js` 中搜索 `function Dump-PowerShellState` 或 `PowerShellState.execute`，能看到 `@cursor/sdk@1.0.23` 每条 PowerShell shell 调用大致执行以下步骤：

1. 根据上一轮保存的 `state` 生成完整 PowerShell 脚本文本。
2. 在系统临时目录创建 `ps-script-<uuid>.ps1`。
3. 启动新的 `pwsh` / `powershell` 进程。
4. 参数包含 `-ExecutionPolicy Bypass`、`-NonInteractive`、`-File <temp.ps1>`。
5. 脚本先恢复上一轮环境状态，再执行用户命令。
6. 执行 `Dump-PowerShellState`：
   - 获取并排序全部环境变量；
   - 对每个环境变量 Base64 编码；
   - 枚举 alias；
   - 逐条 `Add-Content` 写入 `ps-state-out-<uuid>.txt`。
7. Node 进程读取状态文件，更新内存状态，删除脚本与状态文件。

这条链路有几个重要性质：

- 每条命令至少一次 PowerShell 冷启动；
- 每条命令至少创建两个临时文件；
- 状态文件使用多次 `Add-Content` 追加；
- 需要重新枚举环境变量/alias；
- PowerShell 子进程 `exit` 后若 `close` 不到，SDK 内部存在 5 秒兜底等待，并输出：
  `Close event did not fire within ... This may indicate a background process is holding file descriptors open.`

这与 IDE 内常驻集成终端/PTY 的成本模型完全不同。

### 3.4 `-NonInteractive` 不等于 `-NoProfile`

SDK 的上述 PowerShell 参数没有 `-NoProfile`。微软文档对两者的定义是：

- `-NonInteractive`：不允许需要用户输入的交互行为；
- `-NoProfile`：不加载 PowerShell Profiles。

来源：

- <https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_pwsh?view=powershell-7.5>
- <https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_profiles?view=powershell-7.5>

因此安装了 oh-my-posh、conda、nvm、posh-git、PSReadLine 定制或企业初始化脚本的用户，可能在每条 SDK shell 调用时反复承担 Profile 初始化成本。是否所有 Profile 都会在 SDK 实际 host/参数组合下加载，需要在目标 Windows 机器上通过 A/B 实测，不应只靠静态推断。

### 3.5 Cursor 官方已确认相关执行器问题

Windows 已知问题：

- <https://forum.cursor.com/t/cursor-ai-agent-shell-tool-hangs-on-all-commands-windows/162350/8>

Cursor 员工在 2026-06-04 明确说明：

- agent shell 在 Windows 上是已知 bug；
- agent 使用不同于 integrated terminal 的执行路径；
- 该路径可能无法判断命令已经结束，从而挂起；
- 当时没有可靠 workaround，只建议尝试 `cmd.exe` 作为低置信规避。

Shell 状态序列化退化问题：

- <https://forum.cursor.com/t/agent-shell-gets-progressively-slower-then-eventually-hangs/158535/6>

Cursor 员工确认 Bash/Zsh 路径会在每次工具调用重新捕获函数表，某些函数在 round-trip 后产生反馈式膨胀，导致同一会话越跑越慢。官方临时建议在 rc 顶部用 `COMPOSER_NO_INTERACTION` 跳过 nvm/rvm 等重初始化。

注意：该帖子原始复现是 macOS/Bash/Zsh，不能直接证明 PowerShell 存在同样的“函数表滚雪球”；PowerShell 当前 bundle 主要序列化环境变量和 alias。不过它证明了 Cursor 本地 shell 的“恢复 → 执行 → 再序列化”架构本身确实存在性能风险。

### 3.6 现有 Flowship shell boost 没覆盖典型 Windows 用户

相关代码：

- `src/lib/server/shell-boost.ts:1-67`
- `src/components/settings/preference-card.tsx:145-153`
- `tests/shell-boost.test.ts`

当前行为：

- macOS/Linux：探测 `.zshrc`、`.bashrc`
- Windows：只探测 `.bashrc`
- PowerShell Profile：完全不处理
- Windows 没有 `.bashrc`：设置页显示“无需优化（未检测到 shell 配置文件）”

这里至少存在一个产品表述问题：没有 Bash rc 只能说明 Bash 无可优化项，不能说明 SDK 当前实际使用的 PowerShell“不慢”。

另外，官方论坛示例同时提到 `.bashrc` 和 `.bash_profile`；当前实现只处理 `.bashrc`。即使 Windows 强制 Git Bash，如果 login shell 的 `.bash_profile` 没有 source `.bashrc`，现有守卫也可能不生效。

## 4. Flowship 自身会放大的性能因素

### 4.1 首包 prompt 很大

`src/lib/server/task-runner.ts:1572-1650` 会为 fresh agent 拼装并发送 super prompt，包含当前 action playbook、共享规则、skills index、任务信息、历史与用户输入等。

本机 `~/Library/Application Support/fe-ai-flow/logs/main.log` 最近 20 条 `start-chain` 统计：

| 指标 | 中位数 | P90 | 最大值 |
|---|---:|---:|---:|
| workspace | 79ms | 88ms | 112ms |
| MCP 准备 | 1113ms | 1368ms | 1393ms |
| Agent.create | 6ms | 1272ms | 1285ms |
| agent.send | 1816ms | 2371ms | 5352ms |
| 启动总耗时 | 3228ms | 4599ms | 7734ms |
| prompt 大小 | 91KB | 108KB | 109KB |

样本来自 macOS 本机，只用于说明 Flowship 自身的首包规模和固定启动成本，不能代表 Windows 数值。

大 prompt 不只影响首 token。一个 action 内每次工具结果都会回填同一会话，模型在每个 step 都面对不断增长的上下文，因此“工具完成后继续 thinking”也可能比 IDE 中较短的交互任务慢。

### 4.2 默认 fresh agent

- `src/lib/local-store.ts:31-47`：`reuseAgentDefault: false`
- `src/lib/server/task-runner.ts:654-661`：未勾选续用时强起 fresh agent
- `src/lib/types.ts:370-400`：review 固定 fresh，custom 固定 fresh

这是为了隔离上下文、防止长会话跑偏的产品选择，不应未经确认就直接改成全局复用。但它会让每个 action 重复承担创建 agent、MCP 初始化和巨型首包成本，Cursor IDE 的日常对话通常是同一会话连续多轮，不能直接做等价对比。

### 4.3 MCP 冷启动与远程往返

Flowship 起 agent 前会探测并合并自管 MCP；缓存已经降低了大部分健康探测成本，但 fresh agent 仍可能重新拉起 stdio MCP 并握手。执行过程中：

- 本地 stdio MCP：可能受 Windows 子进程启动/杀毒影响；
- 远程 MCP：可能受公司代理、VPN、OAuth、服务端延迟影响；
- Flowship 自己的 task/chat HTTP MCP：走 `127.0.0.1`，理论上应很快，仍需单独记录耗时。

不能把所有 `msg.name = "mcp"` 都当成同一种性能问题，应保存 `innerToolName` 和 provider。

### 4.4 每条过程事件都串行落 JSONL

事件链：

- `src/lib/server/sdk-message-handler.ts:44-197`
- `src/lib/server/task-stream.ts:181-198`
- `src/lib/server/task-fs-core.ts:518-529`

thinking 和工具 running 事件会依次：

1. `mkdir(..., recursive: true)`
2. `appendFile(events.jsonl)`
3. 每隔 5 秒还可能更新 `meta.json`
4. 完成后再 publish SSE

这已经比旧版 O(N²) hydrate 写放大轻很多，但它仍是“先 await 磁盘、再展示下一条事件”。在企业 Windows 的 Defender/EDR 下，高频小文件 append 可能增加 UI 可见延迟。该因素更可能影响“看起来没动”，未必阻塞 SDK 内部真实工具执行。

### 4.5 SDK 自身也在持久化

`@cursor/sdk@1.0.23` 默认本地 store 使用 SQLite/WAL（Node >= 22.13），包括 run event、checkpoint、agent state 等。Flowship 没有传自定义 `local.store`，因此同时存在：

- Cursor SDK 的 SQLite/WAL/checkpoint 写入；
- Flowship 自己的 `events.jsonl`、`meta.json`、artifact 写入；
- PowerShell executor 的临时 `.ps1` 和 state 文件。

这些写入在 macOS 上通常不是主要瓶颈，但在企业 Windows 实时扫描环境中可能叠加。

微软关于 Dev Drive / Defender Performance Mode 的说明：

- <https://learn.microsoft.com/en-us/windows/dev-drive/>
- <https://learn.microsoft.com/en-us/defender-endpoint/microsoft-defender-endpoint-antivirus-performance-mode>

建议优先使用受控的 Dev Drive Performance Mode 做 A/B，不要默认建议用户关闭杀毒或添加大范围排除。

## 5. 当前可观测性缺口

### 5.1 `first-event` 指标位置错误

相关代码：`src/lib/server/task-runner.ts:1642-1650,1989-1999` 和 chat runner 同型逻辑。

当前顺序：

```ts
const run = await agent.send(prompt);
// 记录 send 耗时

const perfStreamStart = Date.now();
for await (const msg of run.stream()) {
  // 记录 first-event
}
```

SDK 的 `send()` 返回时，首事件常已进入内部 buffer，所以本机 `first-event` 基本为 0–7ms。真正的首事件等待被算进了 `send`，因此该指标不能代表 TTFT。

### 5.2 普通工具成功完成没有落时间

`SDKToolUseMessage` 自带：

- `call_id`
- `status: running | completed | error`
- `result`

但当前 handler：

- running：写一条 `tool_call`
- error：写一条 error
- completed：普通工具基本不落事件；artifact 写工具只做刷新

因此无法从 `events.jsonl` 配对工具开始/完成，也无法计算 shell/read/write/MCP 的真实墙钟耗时。

### 5.3 没使用 SDK 1.0.23 的细粒度回调

`Agent.send(..., SendOptions)` 已支持：

- `onDelta(update)`
- `onStep(step)`

`InteractionUpdate` 包含：

- `tool-call-started`
- `tool-call-completed`
- `thinking-delta`
- `thinking-completed`
- `shell-output-delta`
- `step-started`
- `step-completed`（含 `stepDurationMs`）
- `turn-ended`（含 token usage）

shell 成功结果中还有 `executionTime`。这些字段正好可以区分模型等待和本地执行，但当前 Flowship 没消费。

### 5.4 没记录 `requestId`

SDK 近期已在 Run/RunResult 暴露平台生成的 `requestId`，用于关联 Cursor 后端日志和支持工单：

- <https://cursor.com/changelog/sdk-updates-jun-2026>

当前日志只有 `taskId`、`agentId`，没有 `run.id` / `requestId`。如果最终确认是 Cursor backend 或 Windows executor bug，缺少 requestId 会降低官方排查效率。

### 5.5 现有诊断包无法覆盖中间性能

`src/lib/server/diagnostics.ts` 当前包含：

- app/Node/平台版本
- IDE 探测
- 脱敏配置
- `main.log` 最后 300KB

它可以看到启动 `[perf]`，但没有：

- 最近 task 的 `events.jsonl`
- 工具 started/completed 配对
- shell 类型、PowerShell 版本和 Profile 路径
- `requestId`
- EDR/Defender/Dev Drive 状态
- SDK state/temp 路径

因此让同事仅导出现有诊断包，仍不足以证明中间到底卡在哪。

## 6. 建议的最小埋点设计

目标：只记录性能元数据，不把命令参数、工具结果、秘钥写入日志。

建议每个 Run 生成统一 perf context：

```ts
type RunPerfContext = {
  taskId: string;
  actionId?: string;
  agentId: string;
  runId: string;
  requestId?: string;
  platform: NodeJS.Platform;
  model: ModelSelection;
  promptBytes: number;
  startedAt: number;
  lastEventAt: number;
  toolStartedAt: Map<string, number>;
};
```

建议日志事件：

```text
[perf-run] task=... run=... request=... model=... prompt=91KB
[perf-step] task=... run=... type=thinking duration=... gapSincePrev=...
[perf-tool] task=... run=... call=... tool=shell phase=start gapSincePrev=...
[perf-tool] task=... run=... call=... tool=shell phase=done wall=... sdkExecution=... status=success
[perf-step] task=... run=... step=... duration=...
[perf-turn] task=... run=... inputTokens=... reasoningTokens=... total=...
[perf-persist] task=... kind=thinking append=... metaTouch=...
```

工具名称建议归一：

- 内置：`shell/read/write/edit/glob/grep/...`
- MCP：`mcp:<provider>:<innerToolName>`
- 对命令内容只记录可选的安全分类，例如 `git` / `pnpm` / `node` / `other`，不要记录完整命令。

首包建议记录四个时间点：

1. 用户点击/route 收到请求
2. `Agent.create/resume` 完成
3. 调用 `agent.send` 前
4. SDK 第一个 delta/message 到达

`send` 本身返回晚于首事件时，要由 `onDelta` 的真实回调时间作为 TTFT，不能从 `run.stream()` 开始计时。

## 7. Windows A/B 验证矩阵

至少找 2–3 台能稳定复现的 Windows 机器，每台跑同一仓库、同一模型与参数、同一短 prompt。记录中位数和 P90，不只看一次。

### 7.1 基线任务

建议准备三个最小任务：

1. **纯 thinking**：只回答一个不需要工具的问题。
2. **纯 read**：连续读取 5 个小文件，不跑 shell。
3. **纯 shell**：连续执行 5 次几乎零成本的命令，例如输出当前时间或 `git --version`。

由此区分：

- 纯 thinking 也慢：模型参数、网络、prompt/context 为主；
- read 快而 shell 慢：Windows shell executor 为主；
- 所有工具都慢但 thinking 正常：本地事件/SDK store/EDR 或工具调度为主；
- 只有 MCP 慢：MCP server/代理/认证问题。

### 7.2 模型与参数对齐

必须确保 Flowship 与 Cursor IDE 使用完全一致的：

- model id
- variant
- thinking/reasoning effort
- fast/max mode

只比较显示名不够。诊断日志应输出 `model.id + params`，否则“IDE 快”可能只是 IDE 用 fast、Flowship 用 high/xhigh。

### 7.3 PowerShell Profile 成本

可在目标机器手工执行以下只读基准，比较是否加载 Profile 的差值：

```powershell
1..10 | ForEach-Object {
  (Measure-Command { pwsh -NoLogo -NonInteractive -Command "exit" }).TotalMilliseconds
}

1..10 | ForEach-Object {
  (Measure-Command { pwsh -NoLogo -NoProfile -NonInteractive -Command "exit" }).TotalMilliseconds
}
```

说明：这不是完整复现 SDK 状态序列化，只用于测 Profile 对 PowerShell 冷启动的贡献。

进一步记录：

```powershell
pwsh -NoLogo -Command '$PSVersionTable; $PROFILE | Format-List *'
```

如果无 Profile 与有 Profile 差距明显，再做临时 Profile guard A/B。可测试在实际被加载的 Profile 顶部加入：

```powershell
if ($env:CURSOR_AGENT -eq "1") { return }
```

该 guard 基于 SDK 给 shell 子进程注入的 `CURSOR_AGENT=1`。先在单台测试机验证，不要自动改用户 Profile；需要像现有 shell boost 一样备份、幂等、明确可撤销。

### 7.4 PowerShell 与 Git Bash A/B

目标组合：

| 组别 | shell | Profile/rc |
|---|---|---|
| A | SDK 当前默认 PowerShell | 原配置 |
| B | PowerShell | CURSOR_AGENT guard / 干净 Profile |
| C | 强制 Git Bash | 原 `.bashrc/.bash_profile` |
| D | 强制 Git Bash | `COMPOSER_NO_INTERACTION` guard |

注意：`@cursor/sdk@1.0.23` 的公开 `LocalAgentOptions` 没暴露 shell 选择参数。强制 Git Bash 可能只能通过启动 server 时显式设置 `SHELL`/相关环境，或等待 SDK 提供正式选项。不能假设 Cursor IDE 的“默认终端”设置一定会影响 SDK headless executor。

### 7.5 Defender / EDR / 文件系统 A/B

记录以下环境，但不在应用里自动修改安全配置：

- 仓库是否位于系统盘、普通 NTFS、网络盘、OneDrive 同步目录、Dev Drive；
- `%TEMP%` 所在盘；
- 是否启用 Microsoft Defender 或企业第三方 EDR；
- 是否为 Windows 11 Dev Drive + Defender Performance Mode；
- SDK agent store 与 Flowship data 目录所在盘。

可优先比较：普通 NTFS vs 受信任 Dev Drive Performance Mode。微软文档也提到可将 TEMP/TMP 定向到 Dev Drive，但这影响面更大，应由用户/IT 明确操作，不应由应用静默更改。

### 7.6 会话长度退化

每个 shell A/B 都要连续跑至少 20 次，记录第 1、5、10、20 次耗时，以区分：

- 固定冷启动开销；
- 随会话增长的状态序列化退化；
- 偶发 5 秒 close fallback；
- SDK stall auto-retry。

`LocalAgentOptions.enableAgentRetries` 对 headless embedder 默认开启。若出现长时间无事件但最终恢复，需要记录是否发生 SDK 内部重试，避免把重试等待误判为一次正常工具执行。

### 7.7 网络代理路径 A/B

同事的 Clash Verge 截图证明该机 TUN Service 当前不可用。Flowship 仓库没有显式处理 `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` 或 Windows 系统代理；不能仅凭“Cursor IDE 能用”就假定 SDK 子进程走了完全相同的网络路径。

建议在同一台复现机记录并对齐：

- Cursor IDE 的代理/HTTP2设置；
- Clash Verge 是系统代理还是 TUN，TUN 是否真的处于开启状态；
- 启动 Flowship 的进程环境里是否存在代理环境变量，只记录“有/无”，不要把带账号或 token 的代理 URL 写进诊断包；
- 公司 VPN、PAC、透明代理和 TLS 检查是否开启；
- 纯 thinking、纯 read、纯 shell、远程 MCP 四组任务在“系统代理 / 可用 TUN / 无代理直连”下的中位数和 P90。

判断方式：如果网络路径只影响 thinking 和远程 MCP，而本地 read/shell 基本不变，说明它是模型/网络侧的附加因素，不是 Windows shell executor 的根因。

## 8. 修复方向与优先级建议

### P0：先补可观测性

1. 用 `onDelta` 记录 thinking/tool/step 精确时序。
2. 保存 `callId`，配对 started/completed。
3. shell completed 记录 SDK `executionTime` 与 Flowship wall time。
4. 日志加入 run id、requestId、model params。
5. 记录事件持久化耗时，确认 JSONL 是否在 Windows 成为 UI 瓶颈。
6. 诊断包加入最近一轮脱敏 perf 摘要，而不是直接打包完整命令/工具输出。

没有这些数据前，不建议投入较大改造。

### P1：Windows shell 明确化

1. 设置页显示“当前 Agent shell：PowerShell/Git Bash/Naive”。
2. 修正“无 `.bashrc` = 无需优化”的错误文案。
3. 探测 PowerShell 版本、Profile 路径与 Profile 冷启动时间。
4. 验证 PowerShell `CURSOR_AGENT` guard。
5. 如果 A/B 明确 Git Bash 更快，提供显式、可撤销的 shell 选择；不能只依赖进程偶然继承的 `MSYSTEM`。
6. `.bash_profile` 与 `.bashrc` 都纳入守卫探测，避免 login shell 漏掉。

### P1：缩短模型侧每步耗时

1. 将 skills/rules/playbook 进一步按需加载，只在 prompt 注入索引和当前 action 必需内容。
2. 对续用会话只发短 directive，不重复注入能由会话保留的稳定内容。
3. 日志记录 token usage/cache read/cache write/reasoning tokens，确认 91KB prompt 的真实 token 成本。
4. UI 明示当前模型 variant/effort，便于与 IDE 对齐。

注意：是否把“续用 Agent”改为默认，需要另行产品决策。当前 fresh 默认是为隔离上下文和复审独立性服务，不能只为速度直接反转。

### P2：降低 Windows 文件 IO 放大

1. 先 publish SSE，再后台/批量持久化过程事件，或使用单一长期开启的 append handle；需保证崩溃恢复语义。
2. perf 过程日志做采样/聚合，避免为诊断反向增加大量 IO。
3. 评估 SDK 自定义 store 是否能减少 Windows 上 SQLite/WAL 扫描成本，但必须先基准，不要假设 JSONL 一定更快。
4. 给企业用户提供 Dev Drive/Defender Performance Mode 指引，不自动关闭防护。

### P2：向 Cursor 官方反馈

复现后提供：

- `@cursor/sdk` 精确版本；
- Windows 版本、PowerShell 版本；
- run/requestId；
- shell started/completed wall time；
- SDK `executionTime`；
- 是否出现 close fallback / internal retry；
- PowerShell vs Git Bash、Profile vs NoProfile 的 A/B；
- 同模型、同 prompt 下 IDE 与 SDK 的对比。

这些信息比“Windows 上很慢”更容易让 Cursor 定位 executor 问题。

## 9. 当前判断的置信度

| 判断 | 置信度 | 依据 |
|---|---|---|
| Windows 默认大概率走 PowerShell | 高 | SDK 1.0.23 bundle shell 选择逻辑 + Flowship 未显式设置 shell |
| 每条 shell 都新起 PowerShell并做状态文件往返 | 高 | SDK bundle `PowerShellState.execute` 实现 |
| SDK Windows shell 与 IDE 路径不同且存在结束检测 bug | 高 | Cursor 员工公开确认 |
| 现有 shell boost 对典型 Windows 用户无效 | 高 | 代码只处理 `.bashrc`，不处理 PowerShell Profile |
| 大 prompt 会放大每次 thinking | 高 | 本机日志 68–109KB + 模型上下文基本原理 |
| PowerShell Profile 是多人反馈的主要原因 | 中 | SDK 未传 `-NoProfile`，但需目标机器 A/B |
| Defender/企业 EDR 是主要原因 | 中 | 高频临时文件/SQLite/JSONL 模式吻合，但暂无目标机数据 |
| Flowship JSONL append 阻塞了真实 SDK 工具执行 | 低～中 | 会影响事件消费/UI；是否反向阻塞 agent 需埋点验证 |
| 单纯升级 SDK 即可解决 | 低 | 当前已是 npm latest，且 1.0.23 仍含该 PowerShell架构 |

## 10. 给后续 AI 的建议入口

建议从以下文件继续：

1. `node_modules/@cursor/sdk/dist/esm/357.js`
   - 搜索：`PowerShellState.execute`、`Dump-PowerShellState`、`function vt(`、`function Ge(`、`CURSOR_AGENT`
2. `node_modules/@cursor/sdk/dist/esm/vendor/cursor-sdk-shared/delta-types.d.ts`
   - 看 `ToolCallStartedUpdate`、`ToolCallCompletedUpdate`、`ThinkingCompletedUpdate`、`StepCompletedUpdate`
3. `node_modules/@cursor/sdk/dist/esm/agent.d.ts`
   - 看 `SendOptions.onDelta/onStep`
4. `src/lib/server/task-runner.ts`
   - `internalStartAgent`、`consumeSessionRun`、所有 `agent.send`
5. `src/lib/server/chat-runner.ts`
   - chat 同型 send/stream 链，埋点不要只修 task runner
6. `src/lib/server/sdk-message-handler.ts`
   - 普通工具 completed 当前被忽略
7. `src/lib/server/task-stream.ts`、`task-fs.ts`、`task-fs-core.ts`
   - 事件落盘和 SSE 时序
8. `src/lib/server/shell-boost.ts`、`src/components/settings/preference-card.tsx`
   - Windows shell 提速缺口与误导文案
9. `src/lib/server/diagnostics.ts`
   - 诊断包扩展入口

实现埋点时要同时覆盖以下所有 send 路径，避免只修首轮：

- task 新 agent 首轮
- task 跨 action 续用
- task ask/reply、question、follow-up
- chat 新 agent 首轮
- chat 多轮续聊
- Agent.resume 后的 send
- 自动重连/重试后的新 run

## 11. 未做事项

- 本轮只做了只读诊断和文档整理，没有修改 runner、SDK 配置或用户 shell Profile。
- 没有拿到 Windows 同事的目标机 perf 数据，因此尚不能量化 PowerShell、Profile、Defender、模型上下文各占多少。
- 没有通过 patch 修改 `node_modules`；SDK 内部实现只用于定位，不应直接改 vendor bundle。

## 12. 附录：Clash Verge Rev 在 Windows 安装虚拟网卡服务失败

### 12.1 截图判断

截图中的核心错误是：

```text
Install Service failed: Failed to connect to IPC server:
Operation 'GET /magic' failed after retries:
Protocol error: Failed to parse HTTP response: Status timeout
```

这一步不是在访问订阅网站。Clash Verge 的正常 Windows 日志会先连接本机命名管道 `\\.\pipe\clash-verge-service`，向服务发送 `GET /magic`，健康时收到 `200 OK`。截图表示 GUI 无法从本机 Clash Verge Service 获得有效健康响应；因此失败点在 **Service 启动/状态/IPC**，比真正创建 TUN/Wintun 网卡更早。

支持证据：

- [正常日志：连接 Windows named pipe 后 `GET /magic` 返回 200](https://github.com/clash-verge-rev/clash-verge-rev/issues/6390)
- [Windows v2.5.1 同类 `IPC path not ready` 问题](https://github.com/clash-verge-rev/clash-verge-rev/issues/7074)
- [与截图同日附近的 Windows 11 Service Control Manager 7023 问题](https://github.com/clash-verge-rev/clash-verge-rev/issues/7489)

### 12.2 最可能原因

按当前证据排序：

1. **`C:\ProgramData\clash-verge-service\desired-state.json` 损坏或为空。**2026-07-15 的 #7489 使用 2.5.2 AutoBuild，回退 2.5.1 仍失败；手工运行 service 后日志明确报 `failed to parse desired state ... expected value at line 1 column 1`，删除该文件后服务恢复。#7074 也有用户给出相同修复。
2. **旧 Service/内核进程或 owner 状态残留。**#7489 日志同时出现旧 owner lock；#7074 也有人提到后台旧内核占用 service。升级/降级但没有先卸载旧服务时更容易出现版本与状态不一致。
3. **企业安全软件、服务权限或安装包被拦截。**这仍需看 Service Control Manager 和安全软件记录；但对该类报错，单纯“以管理员运行安装器”已有用户验证无效，所以不应把提权当成唯一修复。
4. **Wintun 驱动本身。**当前证据优先级低，因为 `/magic` 健康检查尚未通过，程序还没走到可稳定驱动 TUN 的阶段。

关键评论：

- [#7489：解析 `desired-state.json` 失败，删除后恢复](https://github.com/clash-verge-rev/clash-verge-rev/issues/7489#issuecomment-4979556166)
- [#7074：删除 `desired-state.json` 后重新安装 Service](https://github.com/clash-verge-rev/clash-verge-rev/issues/7074#issuecomment-4849022147)
- [#7074：2.5.1 回退 2.4.7 后可安装](https://github.com/clash-verge-rev/clash-verge-rev/issues/7074#issuecomment-4510000817)

### 12.3 推荐修复顺序

先保留订阅与用户配置，只重置 Service 的运行状态：

1. 在托盘中彻底退出 Clash Verge，不只是关闭窗口。
2. 打开“管理员 PowerShell”，先查看服务和残留进程：

```powershell
Get-Service | Where-Object {
  $_.DisplayName -eq 'Clash Verge Service' -or
  $_.Name -in @('clash-verge-service', 'clash_verge_service')
} | Format-Table Name, DisplayName, Status, StartType

Get-Process | Where-Object {
  $_.ProcessName -match 'clash|verge|mihomo'
} | Select-Object ProcessName, Id, Path
```

3. 停止 Clash Verge Service，备份并删除损坏的 service state：

```powershell
$service = Get-Service | Where-Object {
  $_.DisplayName -eq 'Clash Verge Service' -or
  $_.Name -in @('clash-verge-service', 'clash_verge_service')
}
$service | Stop-Service -Force -ErrorAction SilentlyContinue

$state = 'C:\ProgramData\clash-verge-service\desired-state.json'
if (Test-Path $state) {
  $backup = "$state.bak-$(Get-Date -Format yyyyMMdd-HHmmss)"
  Copy-Item $state $backup
  Remove-Item $state -Force
  Write-Host "Backed up to $backup"
}
```

4. 重启 Windows，正常启动 Clash Verge，在设置中重新安装“虚拟网卡服务”，接受 UAC。
5. 如果仍失败，从 Clash Verge 安装目录的 `resources` 文件夹依次以管理员运行 `clash-verge-service-uninstall.exe` 和 `clash-verge-service-install.exe`，中间确认没有残留的 Clash Verge/mihomo 进程。安装路径可能在 `Program Files` 或 `%LOCALAPPDATA%\Programs`，不要照抄一个固定路径。
6. 仍失败再试[官方最新 AutoBuild](https://github.com/clash-verge-rev/clash-verge-rev/releases/tag/autobuild)。AutoBuild 是预发布版；而且 2026-07-15 的构建仍有人因损坏状态文件失败，所以升级不能替代第 3 步。临时回退 [v2.4.7](https://github.com/clash-verge-rev/clash-verge-rev/releases/tag/v2.4.7) 有成功案例，但回退前应先卸载当前 Service，避免跨版本残留。

不建议先做：

- `netsh winsock reset` / `netsh int ip reset`：同类问题已有用户验证无效；
- 从非官方来源单独下载 Wintun 驱动；
- 关闭 Defender/EDR；如确实被企业安全软件拦截，应让 IT 对官方签名安装包和 service 做定点放行；
- 删除 `%APPDATA%\io.github.clash-verge-rev.clash-verge-rev` 整个用户目录，这会扩大数据损失面。

### 12.4 若仍失败，需要回收的证据

请同事提供以下脱敏信息，便于区分“状态损坏 / 服务崩溃 / 安全软件拦截”：

- Clash Verge 精确版本与下载渠道；
- Windows 版本和 build；
- Clash Verge 日志页中从 `install service` 开始到报错结束的 `[Service]` 日志；
- Windows 事件查看器 → Windows 日志 → 系统 → `Service Control Manager` 的相关事件，尤其是 7023；
- 上述 `Get-Service`、`Get-Process` 的输出；
- `desired-state.json` 是否为 0 字节、截断或无法解析；不要直接贴可能含敏感路径/配置的完整文件；
- Windows 安全中心“保护历史记录”或企业 EDR 是否隔离了 `clash-verge-service*.exe`、`mihomo` 或 `wintun` 相关文件。

可用管理员 PowerShell 快速筛选系统事件：

```powershell
Get-WinEvent -FilterHashtable @{
  LogName = 'System'
  ProviderName = 'Service Control Manager'
} -MaxEvents 100 |
  Where-Object { $_.Message -match 'Clash Verge' } |
  Select-Object TimeCreated, Id, LevelDisplayName, Message
```

### 12.5 与 Cursor SDK 性能问题的关系

这张图本身只能证明 Clash Verge TUN Service 不健康：

- 它**不能**解释为什么本地 read/shell 工具执行慢；这仍优先排查 SDK Windows executor、PowerShell Profile、EDR 和事件持久化。
- 它**可能**解释该同事的 thinking 或远程 MCP 比 IDE 更慢：TUN 未生效后，Cursor IDE、Flowship/SDK 子进程和 MCP server 未必走同一代理路径。
- 所以修好 Clash 后应按 7.7 再跑一次同模型、同 prompt 的 A/B；如果只有网络类步骤改善，说明是叠加因素，不应覆盖主结论。
