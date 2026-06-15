# ROADMAP

> 渐进式、不一次性做完。每个阶段验证 ROI 后再投资源。

> ⚠️ **2026-05-28 同步**：V0.6.0 核心重构（phase chain → task 容器 + action 历史）已落地、V0.6.0.1 持续打磨期收尾、V0.6.1 ship action 上线（server-side GitLab REST + 多仓 MR + 飞书 @ 测试人员）。**当前架构**看 `docs/HANDOFF.md`「当前架构快照」段；V0.5 及之前的历史看 `docs/CHANGELOG.md`（时间倒序、新在上）；V0.6 重构设计文档 `docs/V0.6-REFACTOR.md` 已 archived。

---

## V0.6.0 + V0.6.0.1 + V0.6.1 已落地（2026-05-27 ~ 2026-05-28）

V0.5 phase chain 模型废弃、改为 **task 容器 + action 历史** 模型：

- **task 容器**：单个需求生命周期、双状态（`repoStatus` 业务状态 + `runStatus` agent 运行时状态）
- **action 历史**：6 种 action（`plan / build / review / ship / test / learn`）、任意触发不强制顺序、N 单调递增（chat 不是 action、走独立 mode、见下条）
- **mode 区分**：`task` 模式走 action 体系、`chat` 模式走独立 chat-runner（V0.6.0.1 重新剥离）
- **6 个 harness 门槛**：action 前置准入 / 后置 deterministic check / 默认值推断 / anti-patterns prompt / cross-action 一致性自检（P2 留 V0.6.4+）/ placeholder 动态
- **单 SDK Run 永生**：整 task 跑在一个 Run、不一个 action 一个 Run、shell + curl long-poll 保活
- **V0.5 兼容代码 / 数据全删**（不写 migration、开发期重置 `data/tasks/*`）

V0.6.0.1 体验断点 10 条修完、V0.6.1 ship action 端到端跑通（多仓 MR / 飞书 @ 测试人员）。`pnpm typecheck` + `pnpm lint` 三版本都双绿。详细演进看 HANDOFF V0.6.1 + V0.6.0.1 段（V0.6.0 已迁 `docs/CHANGELOG.md`）。

---

## V0.6.2+ 待办（不一次性做完、按 ROI 排）

| 版本 | 内容 | 工时 | 关键依赖 |
|---|---|---|---|
| ~~V0.6.1（ship action）~~ | ✅ V0.6.1 已上线、server-side GitLab REST + 多仓 MR + A+C 飞书 @ 测试人员 | done | done |
| **V0.6.2**（test action）| 飞书测试用例 + AI 手测能力 | 1-2 天 | 飞书 MCP 已接入 |
| **V0.6.3**（learn action）| HITL 落库 dialog + super-prompt 自动注入 AGENTS.md | 1-2 天 | merged 后触发、需先有真实合入 task 验证 |
| **V0.6.4+**（高级）| cross-action 一致性自检（门槛 5）/ MR 状态 polling / learn 自动 cleanup / worktree 隔离 | TBD | 需要前 3 个版本积累足够 task 数据再决定 |

---

## 质量保证体系蓝图：博采四大库 + 飞书差异化（2026-06-05 讨论沉淀、待拍板）

> 用户问「质量保证对齐四大库（Spec Kit / OpenSpec / Superpowers / GStack）后、各借鉴哪些点、做出来啥效果」。这里沉淀讨论结论 + 一个**待拍板的关键矛盾**。**还没动代码、方向待用户回头敲定。**

> **V0.6.23 现状补注**：本段讨论的是 **test action（动态运行时验证）** 方向、仍待拍板。但 **build 阶段**已先用「自适应 TDD 批次策略」部分落地 Superpowers TDD 借鉴点——大需求分批时每批标 `tdd`/`after`/`none`、build agent 按策略用 shell 实跑、**无测试设施自动退化**（正好化解下面「没单测 TDD 落不了地」的矛盾、不强求）。即：TDD 在 build 侧以「自适应可选」形态存在；浏览器 QA / 飞书验收用例（test action）仍空白、方向不变。

### 定位回顾

质量保证对标四大库（详见 `PRODUCT-COMPARISON.md`）：我们「需求层 + 静态代码层」已到位 / 超越（飞书需求 × git diff + fresh peer 两阶段 review + 确定性后置检查），**唯一真空白 = 测试验证（跑起来验证）** = Superpowers 的 TDD + GStack 的浏览器 QA。test action 就是补这格。review（静态、读代码）vs test（动态、跑起来）**不重叠、是两层防线**（四大库也都把 code-review 和 TDD/qa 拆成两件事）。

### 各库借鉴点

| 来源 | 借鉴点 | 落到哪 |
|---|---|---|
| Superpowers | TDD 红绿闭环（Red-Green-Refactor、失败回修；不抄 test-first 硬律、改「build 后补测」） | test ①（自动化测试） |
| GStack | `/qa` 真浏览器 QA（Playwright 真人式点击）+ **diff-aware**（只测 git diff 改动）+ **失败自动生成回归测试** + 三档深度 + qa-only gate | test ②（浏览器 / 运行时） |
| Spec Kit | `/analyze` 跨 artifact 一致性 → 补**门槛 5 cross-action 自检**（plan ↔ build ↔ test 漂移核查） | 门槛 5 |
| OpenSpec | archive 合并 delta → living spec → **注入 AGENTS.md / rules** | learn action |
| 我们独有 | 飞书验收用例作 test 基准（测「满足需求没」、四大库只有 diff 没需求基准） | test 护城河 |

### 端到端效果

`plan → build → review（静态）→ ✨test（动态：diff-aware 拉飞书用例 → 跑测试 / 浏览器 QA → 失败推 build 修 + 生成回归）→ ship → ✨learn（沉淀注入 AGENTS.md）`、每箭头 HITL ack、每步落 md artifact。出来的 PR = 「静态复核过 + 运行时验证过 + 回归沉淀」。比四大库强在多回答「满足飞书需求吗」（需求层验收）。

### ⚠️ 待拍板的关键矛盾（回头必须先解）

**蓝图的 test ①（Superpowers TDD = 跑单测 / e2e）跟本文「不打算做」里的「自动跑测试用例：公司没单测 / e2e、强行做没意义」直接冲突。**

- 校准后判断：对 crm-web 这种**没单测基础**的项目、① TDD 落不了地（没测可跑、补测又被判无意义）；反而 **② GStack 式浏览器黑盒 QA 不依赖项目有单测**（从 UI 外部跑、真人式点）、+ 飞书验收用例、才是适配「没单测公司项目」的质量保证主线。
- 即：一期主线应是 **②（浏览器 QA + 飞书用例）而非 ①（TDD）**——但 ② 需先接 playwright / puppeteer MCP。
- 连带要做：把「不打算做」的「自动跑测试用例」条款**精确化**为「自动跑单测 / e2e（公司无基础设施）」、并澄清「浏览器黑盒 QA」不在此列、是可做项。

**结论：方向（① vs ②、是否接浏览器 MCP、是否修订止损条款）待用户回头敲定、再动代码 / 改上面的 V0.6.2+ 待办表。**

---

## 配置双向绑定 Cursor（跟 Cursor 共用工具、2026-06-01 完成）

> ✅ 已完成。ai-flow 不自己维护 MCP / rules / skills、统一消费 Cursor 的全局（`~/.cursor/`）+ 项目（repo `.cursor/`）配置。定位「锦上添花」、配置单一源在 Cursor、fe 只读不写。

### 最终分工（关键：repo 层 vs 全局层分开处理）

`settingSources` 是**分层**枚举（SDK `options.d.ts`：`SettingSource = "project" | "user" | "team" | "mdm" | "plugins" | "all"`、project 跟 user 是不同层）：

| 配置层 | 来源 | 谁加载 |
|---|---|---|
| **项目层** repo `.cursor/`（rules/skills/mcp/hooks）| 目标仓库 | `Agent.create({ local: { settingSources: ["project"] } })`、SDK 读 |
| **全局层** `~/.cursor/`（rules/skills/mcp）| 用户机器 | **fe 后端自己读**（`cursor-config.ts` + `skills-loader.ts`）注入 |

**为什么全局层 fe 自己读、不靠 settingSources**：`["project"]` **只加载 project 层、够不着 user 层**（全局要 settingSources 含 `"user"`）。但 `"user"` 是粗开关、一开把全局 20-30 个 MCP 全塞进 context、没法 per-task 精简。fe 自己读：可控、可用 `task.disabledMcpServers` per-task 过滤。

### ⚠️ 纠正 2026-05-29 旧探针的误读

旧结论写「`["project"]` 连带加载**全局** skills（skillCount 13 来自 `~/.cursor/skills`）」——**错**：
- 依据 1：SDK 类型 `SettingSource` 把 `project` / `user` 明确分层（注释「project/team 在 cloud always on、user/mdm 无 VM equivalent」）、`["project"]` 只 project 层。
- 依据 2：本地 `~/.cursor/skills/` 实测仅 **3 个**（learn-and-persist-rules / pua / quarterly-review-generator）、跟「13」对不上。那 13 大概率是 fixture cwd 自身的**项目层** skills（恰好印证 `["project"]` 读 project 层）。

**✅ 头号风险已验证（2026-05-29 探针实测、`scripts/probe-mcp-*.mjs`）· chat-tool MCP 共存安全**（两组对照探针）：
- 探针手法：开 `settingSources:["project"]` + inline `mcpServers` 注入零依赖手写 stdio MCP（spawn / 工具调用各落 `/tmp/probe-mcp-<role>.log`、读日志判定、不靠 agent 自我报告）。
- **结论 1（不同名来源、`probe-mcp-coexist.mjs`）：叠加、不覆盖。** inline=probeInline + repo `.cursor/mcp.json`=probeProject（两个不同 key）→ 两个 server 都被 spawn、两个工具 agent 都调通（`PROBE-INLINE-OK` + `PROBE-PROJECT-OK`）。即 **chat-tool（inline 的 aiFlowChat）开 settingSources 后不会丢、安全**；且 settingSources 确实加载 repo `.cursor/mcp.json`（Q1=是、MCP 双向绑定可行）。
- **结论 2（同名 key 冲突、`probe-mcp-conflict.mjs`）：inline 赢、双保险。** inline 跟 repo `.cursor/mcp.json` 用**同一个 server key**（probeShared）时——两进程**都被 spawn**（SDK 进程层不去重、project 进程也 initialize + tools/list 了），但**工具层 inline 覆盖 project**：agent 工具列表里只有 inline 的工具、project 的工具根本不暴露（agent 原话「probeShared 上只有 probe_inline_tool」）。即 **chat-tool 哪怕撞了用户 Cursor 配置的同名 key、agent 用的也是 fe 的 inline 版**（inline 优先级 > settingSources）。小代价：同名时多 spawn 一个没用的 project 进程（无害、且 chat-tool 用独特 key 根本不会撞）。
- 副产品：日志 `skillCount: 13` 来自全局 `~/.cursor/skills`（fixture 自己没 skills）、印证 settingSources 连带加载全局 skills、对应下方「skills 别重复」待办。
- ⚠️ 实测脚本对 stdio MCP 用「server spawn cwd 可能是目标仓库 /tmp」这点踩过坑：探针 server 必须零 npm 依赖（手写 JSON-RPC）、否则 import 阶段崩、日志写不出会误判成「没加载」。

### skills 加载（2026-06-01 修订）
- `loadSkills()` 读**平台自带** `<ai-flow>/skills/` + **全局** `~/.cursor/skills/`（同名平台优先）。
- 不读 repo `.cursor/skills/`（project 层、交 settingSources、避免同一 skill 进 prompt 两次）。
- ⚠️ 修正 0529「只读平台自带」：那样全局 `~/.cursor/skills` 会丢（`["project"]` 够不着 user 层）、必须 fe 读。

### 实装清单（2026-06-01）
- **新 `cursor-config.ts`**：`readGlobalCursorMcpServers` / `readGlobalCursorRulesForPrompt`（alwaysApply 全文 / 其余列 index）/ `getGlobalCursorDirs`（跨平台、win 加 `%APPDATA%` fallback）/ `filterDisabledMcp`。
- **MCP 注入移 server 端**：runner `mergedMcp` = 全局 mcp（按 task 黑名单过滤）+ chat-tool；删 client→server 传 mcpServers 全链路（run-args / route body / runner input）。
- **rules 注入 prompt**：`_super.md` 加 `{{rulesSection}}`、chat `buildInitialPrompt` 加 rules 段。
- **fe 端 MCP 只读**：`GET /api/cursor-mcp` 原样返回 `~/.cursor/mcp.json`（**不脱敏**、用户拍板：本地单机、跟 Cursor 一致）；`mcp-card` 编辑器→只读展示；黑名单候选源走 `useCursorMcp` hook；localStorage `mcpServersJson` 整套废弃。

### 留心
- repo `.cursor/mcp.json`（settingSources 加载）的 server **不进 fe task 黑名单候选**（fe 只读全局 mcp.json）——用户 mcp 通常都在全局、repo 级罕见、可接受。
- **hooks（V0.6.3 起用于 stop hook 兜底）**：`["project"]` 加载 repo `.cursor/hooks.json`（已探针实测、auto + gemini 两模型都验过 stop hook follow-up 同会话拉回成立）。fe 用它做「保证 agent 交卷」的 stop hook 兜底——没 hooks.json 就建 / 有就不注入 / 留存复用 / hook fail-open 向 fe 认领、不误伤 IDE agent。详见 HANDOFF V0.6.3 段。
- **ripgrep 配置**：独立 SDK 进程（非 Next.js）跑 local agent 会报 `Ripgrep path not configured`、需把 `@cursor/sdk-darwin-arm64/bin` 加进 PATH（让内部 `resolveRipgrepFromPath` 命中）。V0.6.3 stop hook 探针复现了这个警告、但**不影响 agent 正常 finished**（只是 ignore 文件映射降级、agent 照常跑完）。**仍待核查 task-runner 在 Next.js 环境下 agent 的 grep 能力是否受影响**。

---

## V0.7+ 候选（V0.6 系列稳定后再启动）

### V0.7 · Cost / Token Dashboard

**目标**：每个 task / 每个 action / 全局看 token 消耗 + 成本。

**实现**：

- `data/tasks/<id>/events.jsonl` 已经记 token 数（SDK 返回的话）
- 加 `/dashboard` 页面、汇总：今日总 token + cost、按 task / action 类型分布、平均 latency
- 数据源：扫 `data/tasks/*/events.jsonl`
- 可选升级：接 Langfuse / Helicone 自托管 dashboard、白送一套观测能力

**预计**：1 天。

### V0.8+ · 体验优化清单

- [ ] task 搜索 + 标签（归档已落 ✅）
- [ ] cancel 中途打断（不删 task）—— 当前 `forceNewAgent` 已覆盖大部分场景、看实测频率
- [ ] 多 task 间复用 plan / artifact（链接式引用、不复制）
- [ ] 比较同一 task 多次执行的 plan 差异（actions/ 时间序差值可视化）
- [ ] 多语言 prompt 模板（B / C 端分开）
- [ ] 团队共享 prompt 库（git submodule？）
- [ ] task 卡片右键菜单（快速 archive / mark merged）

---

## 不打算做（明确止损）

| 不做的事 | 为什么 |
|---|---|
| 真·multi-agent 协作（PM/Dev/QA 互相谈判式、如 BMAD） | Cognition 警告、共识盲点、debug 灾难。注：单 task 多 action 链是合法的、跟这条不冲突 |
| AI 自审 review bot（纯 LLM 看 LLM 写的代码判对错） | 共识盲点 + 性价比低。**注**：V0.6 review action ≠ 这条——前者是「拿 git diff × plan artifact × build artifact 做结构化差值」、用确定性产物、不是 LLM 判断对错、本质是 harness 增量 |
| 跨 AI 厂商路由（LiteLLM） | 没必要、增加复杂度、Cursor SDK 已经覆盖主流模型 |
| 自动跑测试用例 | 公司没单测 / e2e、强行做没意义 |
| 自动 merge MR | 责任归属问题、永远不该自动 |
| 接 IDE plugin | 命令行 + Web UI 已经够、IDE plugin 维护成本高 |
| 黑名单 / 字符串 predicate（V0.5.6.5 试过、V0.6.0.1 已删） | 业务高频词误伤、replace by 「客观可证伪 predicate」路线（命令 exit code / hash / 文件存在性 / JSON schema 校验） |
| advance dialog 「推荐」微标签（V0.6.0.1 已删） | 推断逻辑只是「流程顺推 + 业务状态映射」、谈不上智能推荐、暗示「我跟你说要走这个」反而误导。保留「默认选中」作为减少首次点击的 UX 工具、但不再标推荐二字 |
| ActionTimeline 失败 chip retry 快捷入口（V0.6.0.1 加过又砍） | 语义混乱：点旧 error chip 实际是打断当前 running + 起新 action、跟用户直觉「修复那条历史」差太远。统一从「推进」按钮 + `forceNewAgent` 开关恢复 |

---

## 业界调研结论（2026-05-26、harness memory 部分、V0.6.3 落地）

5 类 harness memory pattern：

| 模式 | 是否采用 | 理由 |
|---|---|---|
| 静态规则文件（Cursor `.cursor/rules/*.mdc` / `CLAUDE.md` / `AGENTS.md`） | ✅ | 项目已用、可控 |
| auto-memory（Claude Code MEMORY.md 自动写） | ⚠️ | 风险：AI 自己改自己 prompt、debug 困难 |
| 自动生成规则（RepoScaffold / mirrorai） | ⚠️ | 同上、自动 review 自动写 rule 易脏 |
| Reflexion 自学习（evolve-loop / Homunculus） | ✅ | learn action 的灵感来源、跟「客观可证伪 predicate」结合 |
| Memory infra runtime（Mem0 / Letta / Zep / Cognee） | ❌ | 重、维护成本高、跟 Cursor SDK 已有的 conversation history 重叠 |

**最终方案 = Reflexion-lite + AGENTS.md 落库**（取业界 1 + 4 类组合、V0.6.3 落地）。

跟现有机制呼应：

- build action 的 `pnpm typecheck` / `pnpm lint` exit code
- review action 的 git diff hash 一致性
- ship action 的 PR URL 非空

这些都是 deterministic predicate、能写进 ACS 沉淀复用。V0.5.6.5 ~ V0.6.0 试过 plan 黑名单 grep 这种字符串 predicate、误伤高、V0.6.0.1 已删——后续 predicate 沉淀走「客观可证伪」路线（命令 exit code / hash / 文件存在性 / JSON schema 校验）、不走「凑字符串黑名单」路线。

---

## 决策检查表（V 转 V 时）

每个 V 完成后、问自己 4 个问题、再决定下一步投不投：

1. 当前 V 在真实 task 上的命中率 ≥ 70% 吗？（不够、回去调 prompt / 加 harness 门槛）
2. 用户实际使用频次足够吗？（一周用不到 3 次、说明价值不够、暂停下一版）
3. 维护成本是否在增长？（prompt 越来越长、规则越来越多、文档越来越散——警惕）
4. 用户主动要扩展吗？（用户不主动提、就是没痒处、不要硬推）

**任意一个 ❌ → 暂停、调研、不要硬推下一阶段**。
