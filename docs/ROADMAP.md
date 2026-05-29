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
