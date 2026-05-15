# V0.3.5 全面测试清单

> ⚠️ **临时文件、测完即删**：这是为 V0.3.5 单次测试准备的清单、跑完一轮验收后该 `Delete` 这个文件。重要发现 / 新坑回流到 `docs/HANDOFF.md` 「已知坑 / 待验证」段、清单本身保留没价值。
>
> 跑 `pnpm build && pnpm start:prod`（**不要用 dev**、避免 hot reload 杀任务）

---

## 0. 准备

- [ ] `git stash list` 确认有「stash next.config.ts」、避免 `next.config.ts` 被改触发 hot reload
- [ ] `pnpm typecheck` 通过
- [ ] `pnpm lint` 通过
- [ ] dev terminal 干净（没有遗留 server 进程）

```bash
# 推荐启动方式
pnpm build && pnpm start:prod
```

---

## 1. 基础功能（plan 模式）

### 1.1 创建任务

- [ ] 主页「新建任务」按钮、表单显示 mode=plan、workflow=feishu-story-impl、`feishuStoryUrl` 必填
- [ ] 选仓库（FsPickerDialog 弹窗）、能选到 crm-web 那种业务仓库路径
- [ ] 任务级 MCP 黑名单 UI 能正常勾选（`disabledMcpServers`）
- [ ] 创建后跳转 `tasks/[id]` 详情页、初始化 contextDocs（飞书 story URL 自动作为第一条）

### 1.2 启动 workflow

- [ ] 点「启动 workflow」、agent 进入 plan phase
- [ ] dev terminal 看 `[plan-runner] 已持久化 lastAgentId=agent-...`
- [ ] dev terminal 看 `[chat-mcp] handleChatMcpRequest method=POST sessionId=<none>`（首次握手）

### 1.3 ContextDocs 面板

- [ ] 详情页有 ContextDocsPanel、能加 URL / path / 自由文本
- [ ] agent plan phase 能看到清单（看 plan artifact 内是否引用了用户加的文档）
- [ ] 删 contextDoc、UI 立即移除

---

## 2. ask_user 弹窗（V0.3.2 + V0.3.5 race fix）

### 2.1 基本流程

- [ ] agent 在 plan phase 调 ask_user、UI 弹 modal dialog
- [ ] 问题前自动加 A/B/C/D 字母前缀
- [ ] 选「Other」后保留其它 option 可见、textarea 在下方有底部间距
- [ ] 一次提交所有问题、答案自动加入 contextDocs（title=`Q: 问题`）
- [ ] modal 不可 dismiss（必须答完）

### 2.2 race fix 验证（V0.3.5 重点）

- [ ] **故意制造极端 race**：弹窗一弹立刻提交（agent curl 还没起）
- [ ] dev terminal 出现日志（任一行就算 race fix 生效）：
  - ✅ `[chat-mcp] registerPendingEntry: ... 已有旧 entry token=... resolved=true、立即清` （grace 期被新 wait 顶替）
  - ✅ `[chat-mcp] subscribeWaitAck: ... entry 已 resolved（grace window）、curl 一连就拿到结果` （curl 拿到 grace 期 resolved promise）
- [ ] **不应该**出现：
  - ❌ `subscribeWaitAck 校验失败：token=... 期望 task=<none>` → race fix 失效、需查
  - ❌ shell 0ms exit 0 stdout 空 + agent thinking "Empty output suspicious" + 退 run

### 2.3 历史回放

- [ ] 答完后事件流里有 ask_user_request / ask_user_reply 卡片
- [ ] 卡片显示 Q&A、不是问题原始 JSON

---

## 3. wait_for_user 长连接（V0.3.5 保活核心）

### 3.1 路由健康

- [ ] dev terminal 看 `[wait-ack] GET task=... token=... 起 long-poll 连接`
- [ ] 服务端 60 秒一次 chunked write `[KEEPALIVE ts=...]`（如果 agent 暴露 stdout 进 thinking 能看到）
- [ ] 用户 ack 后日志 `[wait-ack] task=... token=... resolved kind=phase_approve、写 N 字节后关流`
- [ ] curl exit + agent 推进下一 phase

### 3.2 长连接稳定性（关键）

故意不 ack、观察以下时间点：

- [ ] **5 分钟**：long-poll 健康、wait-ack 路由还在 GET running、没有任何 ConnectError
- [ ] **10 分钟**：同上
- [ ] **15 分钟**：同上
- [ ] **30 分钟（curl --max-time 1800 上限）**：curl 自然 exit 0、stdout 拿到最后一次 keepalive 或 timeout、然后 agent 进入下一步（按 prompt 该退 run 等用户「继续监听」）

### 3.3 ack approve / revise

- [ ] 点「通过」→ `[PHASE_ACK approve]` 给 agent → agent 进 build
- [ ] 点「跟 AI 再聊聊」→ 弹 dialog 输入意见 → `[PHASE_ACK revise]\n\n<意见>` → agent 改 artifact 再调 wait_for_user

---

## 4. 断线 / 手动重连（V0.3.5）

### 4.1 故意制造断连

- [ ] **方法 1**：杀 dev server 进程、重启、看任务被 boot recovery 标 failed、UI 显示「继续监听」按钮
- [ ] **方法 2**：等 ConnectError api2.cursor.sh 自然出现、agent 退 run、UI 显示「继续监听」按钮

### 4.2 「继续监听」流程

- [ ] 点「继续监听」按钮、看 dev terminal `[plan-runner] resume agentId=agent-...`
- [ ] agent 拿到 `[RESUME] 继续监听用户 ack` 提示后调 wait_for_user → 重新走 long-poll
- [ ] task.status 重新变 awaiting_user

### 4.3 边界条件

- [ ] 老任务（V0.3.5 之前的）没有 `lastAgentId` → UI 不显示「继续监听」按钮、只显示「重启 workflow」
- [ ] chat 模式任务 → UI 不显示「继续监听」按钮（仅 plan 模式有）

---

## 5. Build phase + 端到端

### 5.1 Build phase

- [ ] plan ack 后 agent 自动进 build phase、写代码 + 跑 pnpm typecheck
- [ ] artifact 路径正确：`data/tasks/<id>/artifacts/02-build.md`
- [ ] 文件改动落到目标仓库（`task.repoPath`）、git status 能看到改动

### 5.2 端到端 demo（V0.3 关键里程碑）

- [ ] 真飞书 story 链接 → plan ack → build ack → 完整跑通一次
- [ ] 整个过程没踩 ConnectError / race / hot reload
- [ ] 总耗时合理、SDK send 配额扣得跟预期一致（plan + build + 重试 N 次）

---

## 6. 设置页 + 周边

### 6.1 模型 / API key

- [ ] 模型列表按钮**不需要 API key 验证**也能拉
- [ ] 选 model + variant、保存、新任务跑时正确传给 SDK

### 6.2 MCP servers

- [ ] JSON 编辑器有 prismjs 高亮
- [ ] JSON 改完保存、新任务里 MCP 注入正确（不在 disabledMcpServers 里的都生效）
- [ ] 任务级 MCP 黑名单（创建任务 / 详情页修改）能覆盖全局

### 6.3 仓库管理

- [ ] 多仓库切换、选 crm-web / fe-ai-flow 等
- [ ] FsPickerDialog 能浏览本地目录树

---

## 7. 性能 / 体感

### 7.1 不应该有的

- [ ] AskUserDialog 输入文字**不卡顿**（之前有性能问题、控制台不该刷红）
- [ ] 事件流滚动顺畅、不超长占屏
- [ ] artifact 预览能渲染 markdown（含 mermaid / code block 高亮）

### 7.2 长任务

- [ ] 30 分钟+ 任务、UI 不雪崩、不内存泄漏
- [ ] dev terminal 日志可控、没刷不停的错误

---

## 已知坑（出现了不要慌、不是 bug）

| 现象 | 原因 | 怎么办 |
|---|---|---|
| `ConnectError: api2.cursor.sh ... ECONNRESET` | 代理 fake-ip 抽风 | 换代理节点 / 重启代理 |
| `Found a change in next.config.ts. Restarting...` | dev mode hot reload | 用 prod mode 跑 |
| `[task-fs] boot recovery: 标记 N 个僵尸任务为 failed` | server 重启 | 跑长任务前先停 server / 用 prod |
| 任务跑很慢 / 突然不动 | 用户没 ack 在等 wait_for_user | 看 UI 状态是不是 awaiting_user |

---

## 测试通过标准

- 1-3 节全部 ✅ + 4 节 4.2 ✅ + 5.1 ✅ + 6 节全部 ✅ → V0.3.5 可以打 tag、考虑做 V0.4 飞书 / swagger 自动拉
- 5.2 端到端跑通 1 次 → 重要里程碑、可以发飞书文档对齐
- 3.2 长连接撑过 15 分钟 → 保活机制基本可信、生产可用
