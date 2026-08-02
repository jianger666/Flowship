# 项目 Agent 工作规则

## 按任务性质选择委派

- `cursor-delegate` 优先用于繁琐、耗 token、边界明确且判断成本低的任务，例如仓库搜索、批量改名、机械性重构、测试样板、文档同步和明确纯函数实现。
- 需要精细判断、体验取舍、复杂集成或复杂时序的关键实现，由编排代理直接完成和验收。
- 一个任务可以拆分：Composer 负责机械性子任务，编排代理负责关键设计、集成、边界修复和最终验收。
- 是否委派以判断成本和验收可靠性为准，而不是以任务大小为准；在交付质量、额度消耗和完成效率之间按风险平衡。决定直接处理时，修改前简要说明判断依据即可。

## Cursor 委派持续授权

- 仓库所有者已明确授权：对于符合本文件范围的仓库编码任务，`cursor-delegate` 可以读取完成任务所必需的仓库代码与上下文，并将这些内容发送给 Cursor Composer 2.5 执行实现和验证；无需就同类委派或相关代码传输重复询问。
- 仓库所有者已明确授权：`cursor-delegate` 可以从已配置的操作系统凭据存储中读取 Cursor SDK Key 并联网调用 Cursor SDK；禁止在输出、日志、任务简报或仓库文件中暴露该 Key。
- 上述持续授权不扩展任务范围，也不覆盖下方“不委派的情况”；遇到客户数据、其他秘密、生产权限、部署或不可逆操作时仍须停止并单独确认。

## 不委派的情况

- 涉及凭据、Token、客户数据或其他秘密。
- 涉及安全边界、生产事故、发布、部署、外部写操作或不可逆操作。
- 涉及破坏性数据迁移、重大架构决策或尚未明确的业务取舍。
- 正在修改 `cursor-delegate` 自身、它的凭据存储或 SDK 执行安全机制。
- 用户明确要求不要委派。

## 防止递归委派

- 当提示词说明当前 Agent 已经是由 `cursor-delegate` 启动的 implementation worker 时，必须直接完成任务，禁止再次调用 `cursor-delegate`、Cursor SDK 委派或其他嵌套 Agent。
- 委派脚本设置了 `CURSOR_DELEGATE_ACTIVE=1` 时，同样表示当前进程已经是 worker，禁止二次委派。

## 修改与验收

- 始终保留用户已有改动，禁止为清理工作区而擅自执行 stash、reset、restore 或 checkout。
- Composer 返回 `ok: true` 不等于验收通过；编排代理仍需按风险查看变更和检查结果。
- 对体验或集成质量敏感的改动，源码字符串契约和浅层单测只能作为辅助证据，不能单独判定完成。
- 除非检查失败或结果存在矛盾，编排代理不要重复 Composer 已完成的全仓搜索和完整修复循环。

## 打 test 包并重启（禁止 UI 自动化验收）

- 完成需要用户在 FlowshipTest 中查看效果的改动后，Agent 可以直接执行 test 打包和进程级重启，**无需等待用户再次授权或确认**；用户明确说不要打包或不要重启时除外。
- test 打包和进程级重启不属于「操作 App」：授权范围仅是 **构建、组 server 布局、打 staging unpacked test 包、精确退出旧 FlowshipTest 进程、部署到规范路径、启动新 test 包**，不包含读取或操作界面。
- 一条命令：`pnpm electron:test:restart`（内部顺序：`BUILD_STANDALONE=1 pnpm build` → `pnpm electron:server` → `pnpm exec electron-builder` 打 **staging**（`dist/electron/.test-restart-staging/`、`productName=FlowshipTest`）→ 确认 staging 产物 → 退出旧 FlowshipTest → 备份并替换规范路径（mac `dist/electron/mac-{arch}/FlowshipTest.app` / win `dist/electron/win-unpacked/FlowshipTest.exe`）→ 启动规范路径新包）。仅 `electron:dist:test` 仍可用于只打 mac test 包（仍写规范路径）。
- 命令调用：`process.execPath` + `npm_execpath` 调 pnpm，`pnpm exec electron-builder` 调 builder；禁止依赖 `pnpm.cmd` / `electron-builder.cmd` 或 shell 拼接。
- **除非用户明确要求 App UI 自动化验收或操作**，Agent 不得使用 computer-use、浏览器自动化、截图、可访问性树等方式打开、查看、点击或验收 App；启动新 test 包后直接交给用户查看，不得自行进入界面验收。
- 该流程只做进程级重启。**构建/打包失败**：旧 FlowshipTest 保持运行、脚本非零退出。**部署失败**：尽力从 `dist/electron/.test-restart-backup/` 恢复上一可用包并尝试启动旧版，再非零退出。**启动失败**：新包已在规范路径时给出明确错误。
- 只终止精确命名的 **FlowshipTest** 测试进程，不得影响正式 **Flowship** 或其他 Electron 进程。
