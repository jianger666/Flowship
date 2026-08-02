---
name: cursor-delegate
description: >-
  用于繁琐、耗 token、边界明确且判断成本低的仓库编码工作，例如仓库搜索、批量修改、
  机械性重构、测试样板、文档同步和明确的纯函数实现。通过 Cursor SDK 把执行循环交给
  Composer 2.5 Fast，由当前对话模型负责拆分和验收。需要精细判断、体验取舍或复杂集成的
  关键部分应由当前对话模型直接完成；混合任务只委派可独立验收的机械子任务。用户明确要求
  使用 Composer 或 SDK 委派时必须使用。涉及安全边界、凭据、破坏性迁移、生产事故、发布、
  外部副作用或不明确的架构取舍时不要委派。
---

# Cursor 编码委派

把低判断成本、费 token 的仓库执行循环交给 **Composer 2.5 Fast**（经 Cursor SDK）。编排代理（当前对话模型，不论 Cursor 或 Codex）负责选择边界、编写简报、处理关键判断和按风险验收。

## 平衡策略

- 优先委派耗 token、可机械执行且可确定性验收的部分，让 worker 自己搜索、修改、运行检查并修复失败。
- 在交付质量、编排额度和完成效率之间按任务风险取得平衡：不要为省额度下放关键判断，也不要为追求完美重复 worker 已可靠完成的工作。
- 是否委派取决于判断成本和验收可靠性，不取决于任务大小。

## 判断是否委派

同时满足以下条件时委派：

- 任务边界在当前仓库内且比较明确。
- 实现过程不依赖持续的产品判断、体验取舍或关键方案选择。
- 可以通过 diff、确定性测试、lint、类型检查或具体行为标准可靠验收。
- 不涉及秘密、生产权限、破坏性操作、发布、提交、推送或外部沟通。

需要精细判断、体验取舍、复杂集成或复杂时序的关键实现，由编排代理直接完成。涉及安全边界、数据迁移、不明确的架构取舍、生产事故、隐含业务决策或高影响不可逆操作时，也由编排代理处理；必要时只委派只读调查。

修改 `cursor-delegate` 自身、它的凭据存储或 SDK 执行安全机制时禁止自我委派，必须由编排代理直接处理。

## 拆分混合任务

- 只把能独立描述、独立修改、独立验收的机械子任务交给 Composer。
- 由编排代理保留关键设计、集成、边界处理和最终质量判断。
- 如果验收失败暴露的是方案理解或体验判断问题，由编排代理接管；不要仅靠增加提示词反复委派。

## 运行 Worker

1. 不要预先读取整个仓库，只读取足以确定工作区和编写准确简报的内容。
2. 简报应包含：
   - 必须实现的行为；
   - 已知路径或符号；
   - 验收标准；
   - 必须运行的检查；
   - 明确不在范围内的事项。
3. 执行：

```bash
node "<skill-dir>/scripts/run-cursor-agent.mjs" \
  --workspace "<absolute-workspace-path>" \
  --task "<worker-brief>"
```

`<skill-dir>` 是本 Skill 所在目录；当前项目中为 `.cursor/skills/cursor-delegate`。较长或不便转义的简报写入临时 UTF-8 文件，再使用 `--task-file <path>`。

脚本始终使用 `composer-2.5` 且 `fast=true`，禁止降级到其他模型。SDK 调用失败时最多重试 4 次，stdout 只输出一个 JSON 对象。

Worker 在 Cursor SDK 本地沙箱中运行。脚本还会标记当前进程已处于委派状态，并阻止嵌套调用 `cursor-delegate`；worker 必须直接完成简报中的任务。

每次委派使用操作系统临时目录中的 SDK JSONL agent store，结束后自动删除。不要改回 SDK 默认的用户级 SQLite store；后者在 Codex、Cursor、Claude Code 等受限宿主中常因用户目录不可写而报 `unable to open database file`。新安装的 SDK runtime 缓存也使用宿主无关的 `cursor-delegate/runtime` 命名空间；旧版 Codex 缓存只作兼容复用。

### 异步执行

脚本是普通本地进程。使用宿主提供的后台会话机制运行，编排代理可以继续沟通或处理互不依赖的工作；不要通过裸 `&` 启动无法可靠回收结果的后台进程。

- 同一工作区且会修改相同文件的后续任务，必须等上一次委派结束并验收后再派，避免互相覆盖。
- 互不相关的任务可以并行委派；禁止使用 `git stash`、`checkout`、`restore` 或 `reset` 清理其他人的改动。
- 后台运行不代表自动可信，返回后仍必须验收。

缺少凭据时执行：

```bash
node "<skill-dir>/scripts/configure-key.mjs"
```

该命令还会把对应操作系统的 Cursor SDK runtime 安装到用户缓存目录。密钥存入 macOS Keychain、Windows DPAPI 或 Linux Secret Service；`CURSOR_API_KEY` 可临时覆盖。禁止把密钥写入 Skill、日志或任务简报。

如果宿主沙箱无法稳定访问系统凭据库，可一次性切换到跨平台兼容文件模式：

```bash
# 从已有系统凭据库迁移，不回显 Key
node "<skill-dir>/scripts/configure-key.mjs" --storage file --migrate

# 新机器首次配置（终端隐藏输入）
node "<skill-dir>/scripts/configure-key.mjs" --storage file
```

兼容文件不会放进仓库，也不绑定 Codex 等宿主产品。默认路径为 macOS 的 `~/Library/Application Support/cursor-delegate/credentials`、Windows 的 `%APPDATA%\\cursor-delegate\\credentials`、Linux 的 `${XDG_CONFIG_HOME:-~/.config}/cursor-delegate/credentials`；可用 `CURSOR_DELEGATE_CREDENTIAL_FILE` 覆盖。macOS/Linux 文件权限固定为 `0600`，Windows 会移除继承 ACL 并只授予当前用户。读取优先级为 `CURSOR_API_KEY` → 兼容文件 → 系统凭据库。为保证平滑升级，macOS 钥匙串和 Windows DPAPI 会只读兼容旧版 `Codex` 命名空间。

兼容文件模式比系统凭据库安全性低，只应用在受信任的个人设备。它解决的是 Key 在沙箱中的可读性；仓库内容发送到 Cursor 服务所需的宿主授权仍由宿主控制。

macOS 上的 worker 需要访问 Keychain 和网络。如果沙箱错误地报告没有凭据，应先使用本机权限重试，再要求用户重新配置。

## 解读结果

- `ok: true` 只表示 worker 已结束，不代表修改自动正确。
- 查看 `result`、`git.status` 和 `git.diffStat`。
- `git.historyChanged` 或 `git.branchChanged` 为 `true` 时立即停止并告知用户，禁止静默重置历史。
- `ok: false` 时报告最终错误，禁止切换到其他模型重试。
- 保留用户原有改动；返回的 Git 状态可能包含委派前已经存在的变化。

## 按风险控制验收成本

- 低风险：查看精简结果和检查结果，抽查最相关的 diff。
- 中风险：检查全部变更片段并运行最小范围的确定性检查。
- 高风险：由编排代理完整评审或接管。

对体验或集成质量敏感的改动，源码字符串契约、浅层单测和 `ok: true` 只能作为辅助证据，不能单独判定完成。

除非结果自相矛盾或检查失败，否则不要重复 Composer 已完成的全仓搜索、完整日志阅读和修复循环。这是节省编排模型额度的关键。

## 安全规则

- Worker 的 shell 和文件操作必须启用 Cursor SDK 本地沙箱；缺少沙箱 runtime 时直接报错，禁止静默关闭。
- 已委派的 worker 禁止再次调用本 Skill、Cursor SDK 委派或其他嵌套 Agent。
- 禁止提交、推送、创建或切换分支、创建 PR、破坏性 Git 操作以及写入工作区之外。
- 禁止委派凭据、Token、客户数据或其他秘密。
- 禁止声称完成实际未执行的验证。
- 禁止删除或还原无关改动。
- 除非用户明确要求，否则 `--max-attempts` 不得超过 4。
