# v3.1 实验 A/B 结论报告（`@cursor/sdk@^1.0.31`，源码级实证）

> 结论来源：`node_modules/.pnpm/@cursor+sdk@1.0.31/.../dist/esm/*.d.ts` 类型声明实测，
> 非推测。每条注明文件与行级依据。运行时行为（dispose 真释放量、seq 续跑语义）
> 需真机 SDK 会话实测，此处如实标注 pending，不冒充结论。

## B1 实验 B：四档拦截点判定（② 路线唯一确定）

| 档 | 问题 | 结论 | 依据 |
|---|---|---|---|
| (a) 执行前 hook | 内置工具执行前有无 hook 可先写意图日志 | **无**。公开 API 只有 run-event 订阅（事后），无执行前拦截 | `dist/esm/*.d.ts` 全量 grep `hook\|before\|intercept\|middleware\|onTool`：`local-executor.d.ts` 零命中；`run-event-notifier-api.d.ts` 只有订阅 |
| (b) tool override | 能否整体替换工具实现 / 自研工具 | **部分成立**：自研工具经 `customTools`（合成 MCP `custom-user-tools` 服务器）为一等公民；内置 shell 不可 override，只能移除 | `custom-tools.d.ts`（`createCustomUserToolDefinitions`/`createSdkCustomToolMcpExecutor`）；`options.d.ts:329-370` |
| bash 禁用 | `disallowedTools` 是否一等功能 | **成立**：deny-wins，可 `"shell"` 整组移除（含 shell stdin writes）；**不持久化，create/resume 每次重传** | `options.d.ts` `disallowedTools?: ToolName[]`；`ToolName` 含 `"shell"`（`options.d.ts:301`） |
| (c) PATH shim | worker 注入的 PATH 对 SDK shell 生效否 | **待真机**：声明文件未暴露 shell env 继承语义，bundle 亦无明示。验证法：worker 内 agent 跑 `printenv PATH`（注入标记值）一次即定 | 实验 B 真机项 1 |
| (d) 残余 | 绝对路径/自备二进制/解释器内联 | **成立为已知边界**：`bash-policy.ts` 已列全 + 启发式进 intent；若 (c) 真机失败 → 触发禁用 bash 评估 | 封版纪要修订二2 |

**路线裁决**：(a) 走不通 → 意图日志不靠 hook；(b) 自研工具走 `customTools`（调用方负责包）；bash 走 **(c) PATH shim 主 + (d) 串解析兜底**（待真机确认），最后手段为 `disallowedTools: ["shell"]`（SDK 原生支持，收编自研工具补位）。`BUILTIN_TOOL_FALLBACK_IF_NO_HOOK` 语义不变，实现从"SDK 外挂"变为"SDK 原生参数"，成本反而更低。

## B2 实验 B：store 与恢复语义

| 问题 | 结论 | 依据 |
|---|---|---|
| sqlite 强制路线 | **成立**：`openDefaultLocalAgentStore/ SqliteLocalAgentStore.open({workspaceRef, stateRoot?})` 为公开 API，布局 `index.db` + per-agent checkpoint | `store/sqlite-local-agent-store.d.ts`、`store/open-default-local-agent-store.d.ts` |
| 一 workspace 一 stateRoot | **成立**：原文"Open once per workspace/state root and reuse across Agent.create/resume" | 同上 |
| dispose 可测性 | **成立**：`SqliteLocalAgentStore.dispose()` 存在，实验 A 三级释放可真实执行 | 同上 |
| JSONL 迁移文件清单 | `JSONL_LOCAL_AGENT_STORE_FILES` 导出，迁移按此清单搬运 | `public-api.d.ts:19` |
| resume 续 run / 新 run、seq 重置 | **设计已免疫**：去重键 `(agentId,runId,epoch,localSeq)` 不依赖 SDK 语义；worker 启动自检只影响派发策略。真机确认一次即可 | v3.1 §7 |

## A 实验 A：基线数字（本机实测）

- `experiment-a.mjs`：`heap=4MB/4144MB ratio=0.001 rss=42MB`（空载 server 基线；worker 侧 `heap_size_limit` 由 spawn `--max-old-space-size=1536` 写死，绝对阈值良定义——修正①已确认）
- dispose 三级真实性（agent/executor/store dominator）：**待真机**（需 SDK 会话 + force GC + heap snapshot，需 Cursor 认证，本机无凭证不伪造数据）
- §3 常数当前值：old-space 1.2/1.5G、比例 60/80%、RSS 2.0/2.3G——**初值**，实验 A 真机曲线后校准；`MAX_WORKERS` 动态公式已落地，`RESERVE` 待校准

## 待真机三项（LIVE_CHECKLIST.md）

1. PATH 注入生效性（`printenv PATH`）
2. dispose 三级 dominator + summary 前后堆曲线 + RSS/主进程 44h 曲线
3. 翻转开 flag 全链路（灰线续接、kill 收敛、44h 等价压测）

## A 轮增补：compute-plane 翻转已落码（flag-gated，默认关）

- 翻转点在 `agent-backend.ts` facade（create/resume 的 cursor 分支），不是 task-runner：
  flag 开 → 落位 + manifest 重建 + worker 寄宿；任一步失败降级老路径；关 → 逐字节不变。
- customTools 过 IPC 的是 manifest（纯数据），execute 一律 RPC 回主进程唯一执行点
 （`worker-tools-rpc.dispatchWorkerToolCall`，intent 同处落：share→feishu、notify→notify，
  submit_mr 走自带 intent，其余本地工具不进 WAL）。工具返回体报 ok:false → abandoned 不记 done。
- 身份语义保持 in-process：句柄对象进现有映射比较，线上只传字符串；callerToken 桥接不动。
- 协议测试钉住：握手/流有序/去重/wait 终态/RPC 回包/NACK 抛错（`worker-facade.test.ts` 10 条）。
- 残余真机项：worker 内首次 `Agent.create`（需 Cursor 凭证）、端到端 stream 背压、44h 曲线。

## 残余风险（v1 显式边界，与解释器内联外发并列）

- **bash 跑 `git push` 无生产观测点**：外发 shim 只覆盖 curl/wget/ssh 等二进制，
  `git` 不在名单里——bash 内 `git push` 既不落 shim 行、也不进 tool-call-args
  registry，`git-push` 反查 handler 实际不可达。残余风险小：force-push 在任务红线层
  本就禁止、同 commit 重推是空操作；MR 侧有 `createMRWithIntent` + 409 复用兜底。
  将来 compute-plane 工具拦截落地后，bash 写类统一进 intent，本条消除。
- **external-api shim 行恢复一律 abandoned**：shim 行 args 进不了 registry，
  payloadProvider 返 null → 人工兜底。保守安全（宁漏勿重），符合 at-most-once 哲学。
- **onDelta/onStep 寄宿转发**：worker 侧包转发器、主进程按 runId 派发本地回调
 （`worker-facade` + 单测钉住）；run 结束/cancel/destroy 即清回调，无泄漏。
