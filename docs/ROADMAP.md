# ROADMAP

> 渐进式、不一次性做完。每个阶段验证 ROI 后再投资源。

> ⚠️ **2026-05-15 同步**：V1 流程历经 spec→plan→build → context→plan→build→ship → 最终定型 **`plan → build` 双阶段**（V0.3.4）+ 「**chat 自由对话**」双模式。保活机制从 `wait_for_user` MCP + `keep_alive_a/b/c` 重构为 `shell + curl long-poll`（V0.3.5）。**V0.4 引入多角色 schema**（`Task.role`、当前仅 fe、未来扩 be/data/mobile/qa、详见 `docs/MULTI-ROLE.md`）+ 大规模代码质量清扫（chat-runner / phase prompts / SKILL.md 多处 prompt drift 修复）。当前实际进度看 HANDOFF.md「V0.2 → V0.3.5 演进 + V0.4」段、Chat 架构看 DESIGN.md 第 16 节。

---

## 当前阶段（2026-05-15 同步）

| 阶段 | 状态 | 备注 |
|---|---|---|
| 基础设施（设置页 / shadcn / Tailwind 4 / SDK 验证） | ✅ 完成 | clean slate 重做 |
| 任务列表 + 详情 + 双模式 UI 路由 | ✅ 完成 | 主页卡片列表 / `tasks/[id]` 按 mode 分两套 UI |
| **Plan workflow（V0.3.4 起 = 2 phase chain、单 SDK Run）** | ✅ 完成 | `plan-runner.ts` + 2 个 phase prompt 模板（plan / build） |
| **Chat 模式（wait_for_user MCP）** | ✅ 完成 | `chat-runner.ts` + `chat-mcp.ts` + `watch-chat` |
| **ContextDocsPanel（任务级上下文文档面板）** | ✅ V0.3 完成 | `context-docs-panel.tsx`（V0.3.4 起 plan 自己读、不用 phase 重划） |
| **ask_user 弹窗 modal**（一次打包 + ABCD）| ✅ V0.3.2 完成、V0.3.3 微调 | `ask-user-dialog.tsx`（Other 选中保留其它 option、textarea 移下方） |
| **任务级 MCP 黑名单**（每任务可关闭部分 MCP）| ✅ V0.3.3 完成 | `Task.disabledMcpServers` |
| **shell + curl long-poll 保活**（取代 keep_alive_a/b/c）| ✅ V0.3.5 完成 | 新增 `wait-ack/route.ts`、删 keep_alive 三件套 |
| **断线手动「继续监听」**（Agent.resume）| ✅ V0.3.5 完成 | 新增 `resume-waiting/route.ts` + UI 按钮 |
| **ask_user race fix（grace window）** | ✅ V0.3.5 完成 | `finalizeEntry` 60 秒延迟清 |
| **task-fs 原子写 + 任务级互斥锁** | ✅ V0.3.1 完成 | 修 readMeta race |
| **status=error 诊断增强**（dump CursorSdkError）| ✅ V0.3.2 完成 | `plan-runner.ts` catch dump |
| **多角色 schema（V0.4）** | ✅ V0.4 完成 | `Task.role` + `TASK_ROLE_LABEL` + `phase-1-plan.md` 注入 `{{role}}` + `new-task-dialog.tsx` 选择器、当前仅 fe |
| **代码质量大清扫（V0.4）** | ✅ V0.4 完成 | 修 chat-runner 严重 prompt drift（keep_alive_a/b/c → shell long-poll）、删老 phase prompt 文件、修 SKILL.md / `ask_user` description 残留 |
| Plan + Build 端到端跑通 | 🚧 待用户 demo | 用户最近已能跑通 plan、build phase 也能写 artifact、但 wait-ack 长连接 / 代理稳定性还是隐患 |
| 自动 retry on ConnectError | 🔲 不做 | 用户决定：靠手动「继续监听」、避免 agent 反复踩坑 |
| Cancel chat（保留任务、停 agent） | 🔲 未启动 | 当前只能"删任务" |
| 飞书 / swagger 自动拉 | 🔲 未启动 | 用户已配飞书 MCP、还没接到任务流 |
| cost / token dashboard | 🔲 未启动 | 老路线 W5 |

---

## V1 拍板（2026-05-08 → 2026-05-11 演化版）

### 流程：双模式

```
plan 模式（阶段化、HITL 在 phase 边界）：
  [raw_input] → plan → [前端 ack] → build → [前端 ack] → 完
                ✅                  🚧

chat 模式（单 SDK Run、HITL 走 wait_for_user 阻塞）：
  [raw_input] → 整段对话（agent 反复 wait_for_user、用户在 ChatView 输入触发 chat-reply）→ 用户停 / done
                ✅
```

老版本拍的「spec → plan → build」三步流程：spec 已砍（实测产出对开发参考价值低、反而拉长链路）。chat 模式是 2026-05-09 ~ 2026-05-11 新增的第二条路径、跟 plan 阶段化互补。

### 每步 7 维度缰绳（不变）
1. 输入产物（schema / 上游文件）
2. 工具白名单（哪些 MCP / SDK / 命令可用）
3. 输出产物（含 frontmatter 的 markdown）
4. HITL 闸门（plan 模式 = 前端 ack 按钮、chat 模式 = wait_for_user 阻塞）
5. 自验证（eslint / typecheck / prompt review）
6. 失败回滚（git reset / 上一步重跑）
7. 事件日志（events.jsonl 全量记录）

### B 端阶段二定位
不是「Figma + Token」、是「接口契约 + 数据模型」（权限矩阵 V1.x 待评估）。

### V1 必接 vs 选接 vs V2+
**plan phase（已落地）**：仓库只读 / 类型定义 read / write-disabled / plan.md frontmatter / Task List schema（必）；git log / blame、self-review（选）。
**build phase（待启动）**：Cursor SDK / git 每 task commit / file allowlist / eslint / typecheck / typecheck 失败重试上限（必）；prettier / Cursor rule / Skill（选）；hook / 浏览器截图 / token 上限（V2 补）。
**chat 模式**：用户配的 MCP servers + 内置 `feAiFlowChat` HTTP MCP（提供 wait_for_user）；任务级 MCP 白名单（`Task.enabledMcpServers`）；agent 自由调 SDK 内置工具。

### 预留扩展点（V2 不重构）
1. phase 可注册（`PhaseId` union type、加新 phase 时只扩这个 + 注册 runner）
2. 产物 frontmatter（V2 加字段不动表结构）
3. 「完成」= 最后一个 phase 被 ack、不写死 build 跑完
4. `TaskMode` 留扩展位（未来要加 review 模式之类的、直接扩 union）

详细工具清单看 `docs/DESIGN.md` 第 14 节、reliability 4 件事看第 13 节、与公司 5 阶段对齐看第 15 节、Chat 模式架构看第 16 节。

---

## 已完成里程碑（保留作演化记录）

### 2026-05-08 ~ 2026-05-09：基础设施 + Plan phase

- 设置页（4 张 Card、每张独立保存）
- 任务列表 + 详情页
- `data/tasks/<id>/` 三件套（meta.json / events.jsonl / *.md）
- Plan phase：`prompts/plan-phase.md` + `plan-runner.ts` 流式消费 SDKMessage、artifact 增量写

### 2026-05-09 ~ 2026-05-10：砍 spec phase

实测下来 spec 对开发参考价值有限、plan agent 自己进仓库 grep 一遍后产出的 Task List 已经够准。砍 spec、改 `PhaseId = "plan" | "build"`。

### 2026-05-09 ~ 2026-05-11：Chat 模式落地

- 新建 `TaskMode = "plan" | "chat"`、新建任务默认 chat
- 本地 HTTP MCP `feAiFlowChat`（chat-mcp.ts）+ `wait_for_user(task_id)` 阻塞工具
- `chat-runner.ts` publish-subscribe 模式、`runningChats / subscribers` 挂 globalThis
- `start-chat`（POST、fire-and-forget）+ `watch-chat`（GET、SSE 订阅）拆开、刷新页面不断 agent
- 50s keepalive + 反 anti-loop 双重压制（keepalive 文本变体化 + prompt 反反思指令）
- `completed` 状态可"再聊一次"重启 agent（计费再算一次、UI 有提示）
- 任务删除 cleanup 三步：cancelChat → cleanupChatTaskState → deleteTask

---

## V0.4 / W4：多角色 schema + 通用化（已落地）

**目标**：让 fe-ai-flow 不只服务前端、能扩到后端 / 数仓 / 测试 / 移动端

**实现**（详见 `docs/MULTI-ROLE.md`）：

- `Task.role: TaskRole`（当前仅 `"fe"`、未来扩）+ `TASK_ROLE_LABEL` 中文映射、单一来源
- `task-fs.ts` 老数据兜底 `"fe"`、`plan-runner.ts` 把 `{{role}}` / `{{roleLabel}}` 注入 phase prompt
- `phase-1-plan.md` 强调「以 role 视角、只挑相关部分做、不收集其他角色实现细节」
- `new-task-dialog.tsx` 加角色选择器（当前单值、UI 保留以信号未来扩）
- 顶部 metadata / description 去掉「前端」字眼

**已做的代码质量大清扫**：

- 修 `chat-runner.ts` 严重 prompt drift（buildInitialPrompt 还在教 keep_alive_a/b/c 轮转、chat 模式实际坏了）
- 删 `prompts/phase-{1-context,2-plan,3-build,4-ship}.md` 老文件（V0.3.4 起不再使用）
- 修 phase prompt / SKILL.md / chat-mcp ask_user description 里 `keep_alive` 残留
- README.md 整篇重写到 V0.4、DESIGN.md 顶部 warning 改完整版本演进表

**未启动子项（V0.5+ 再说）**：

- 角色枚举扩展（be / data / mobile / qa）：等真有 1 个非 fe 用户来开新坑、不空设
- `prompts/roles/<role>.md` 片段化（当前角色提示直接写在 phase-1-plan.md「当前角色提示」段、扩展时再抽）

---

## V0.5 / W5：飞书 MCP 自动拉文档（未启动）

**目标**：用户只输入 storyId、自动拉飞书需求 + swagger

**实现**：

- `src/lib/feishu.ts`：通过飞书 OpenAPI 拉 docx 内容
- `src/lib/swagger.ts`：通过 swagger URL 拉接口 schema
- 表单加"自动拉取"按钮、调这两个接口、把返回的内容自动填到需求 / swagger 字段

**预计**：1 天。

**前置依赖**：

- 用户在设置页加飞书 app_id / app_secret（也存 localStorage）
- swagger 集中地址（公司有统一 swagger gateway 吗？需确认）

---

## V0.6 / W6：Cost / Token Dashboard（未启动）

**目标**：知道每个任务花了多少 token / 多少钱

**实现**：

- `llm-log.jsonl` 已经记 token 数（如果 SDK 返回的话）
- 加一个 `/dashboard` 页面、汇总：
  - 今日总 token / 总 cost
  - 按任务 / 按 phase 分布
  - 平均 latency
- 数据源：扫描 `data/tasks/*/llm-log.jsonl`

**未来可选升级**：接 Langfuse 自托管 dashboard、白送一套观测能力。

**预计**：1 天。

---

## V0.3 候选区

### A. 任务级「上下文文档面板」 ✅ 已落地（V0.3）

详情页顶部加可折叠面板、用户随时增 / 删上下文文档（URL / path / 自由文本）、agent 后续 phase 都能用。

- **场景**：飞书 story 链接建任务后、产品 / 后端陆续补 PRD / 接口文档 / 评论、不该被「建任务时一次性填」绑死
- **设计要点**（避坑）：清单 inject + 按需拉取（不全量塞 super-prompt）、prompt 教 agent 发现冲突列「不确定项」
- **已附带做的**：Phase 1 角色变窄（只综合用户提供的上下文、不扫仓库）、Phase 2 接管仓库扫描、Phase 1/2 重叠消失
- **关联**：用户答完的 ask_user 答案会自动落到 contextDocs（title=`Q: 问题`）、后续 phase 复用

### B. Phase 3 ack 前「cursor-rule 沉淀」步骤

Phase 3 build 完成后、ack 前、agent 把本次改动中发现的「值得沉淀的仓库约定」整理成 `proposed-rules.md`、HITL 让用户选哪些写进仓库的 `.cursor/rules/`、下个 task 自动生效。

- **场景**：B 端仓库存在大量隐性约定（dialog 样式 / api 封装 / store 路径）、agent 每次重头摸索成本高、应该一次发现长期沉淀
- **为什么放 Phase 3 之后**：只有真改过代码才知道哪些约定是「真的重要」、凭空扫仓库提议出来的 rule 多半不接地气
- **harness 立场**：「把可重复的知识结构化沉淀」是 harness 的核心命题、这是正统路子

### C. Phase 边界重划（如果 A 不做）

不做 A 的话、备选路径：Phase 1 改成「只拉文档 + 与用户澄清需求」、Phase 2 接管「扫仓库 + 出方案」。如果做了 A、这条自然落地。

---

## V0.7+ / W7+：体验优化

- [ ] 任务搜索 + 标签（归档已落 ✅）
- [ ] cancel 中途打断（不删任务）——chat 模式当前只能"删任务"
- [ ] retry 单 phase（改 prompt 后重跑 plan、不重做整个链路）
- [ ] 比较同一 task 多次执行的 plan 差异
- [ ] 多语言 prompt 模板（B / C 端分开）
- [ ] 团队共享 prompt 库（git submodule？）
- [ ] chat prompt 外提 `prompts/chat-init.md`（待 chat 模式跑稳定 ≥2 周不踩坑）

---

## 不打算做（明确止损）

| 不做的事 | 为什么 |
|---|---|
| 真·multi-agent 协作（PM/Dev/QA 互相谈判式、如 BMAD） | Cognition 警告、共识盲点、debug 灾难。注：phase chain 里多 agent 节点是合法的、跟这条不冲突 |
| AI 自审 review bot | 共识盲点问题、性价比低 |
| 跨 AI 厂商路由（LiteLLM） | 没必要、增加复杂度 |
| 自动跑测试用例 | 公司没单测 / e2e、强行做没意义 |
| 自动 merge MR | 责任归属问题、永远不该自动 |
| 接 IDE plugin | 命令行 + Web UI 已经够、IDE plugin 维护成本高 |

---

## 决策检查表（V 转 V 时）

每个 V 完成后、问自己 4 个问题、再决定下一步投不投：

1. 当前 V 在真实任务上的命中率 ≥ 70% 吗？（不够、回去调 prompt）
2. 用户实际使用频次足够吗？（一周用不到 3 次、说明价值不够）
3. 维护成本是否在增长？（prompt 越来越长、规则越来越多——警惕）
4. 用户主动要扩展吗？（用户不主动提、就是没痒处）

**任意一个 ❌ → 暂停、调研、不要硬推下一阶段**。
