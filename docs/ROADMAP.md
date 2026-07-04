# ROADMAP

> 渐进式、不一次性做完。每个阶段验证 ROI 后再投资源。
> 权威源 = 代码 + `docs/HANDOFF.md`。本文件只管「**未来往哪走 + 明确不做什么 + 决策原则**」；已落地细节看 HANDOFF「当前架构快照」+ `docs/CHANGELOG.md`。

> 🔄 **2026-07-01 校准**：上次同步还停在 5/28（V0.6.0 刚落地）、实际已推进到 **v0.9.4**。「飞书 story → 多仓 MR」核心闭环（`plan → build → review → ship/dev → learn`）已**完整落地并每天在用**（正式实例 22 个真实 task）；**test action 已于 v0.8.25 止损删除**。本文件据此重写：把「已落地」从待办里移出、纠正 test 方向、补代码健康度现状。历史待办表（V0.6.2+ 那版）已过时删除。

---

## 一、已落地能力总览（不再是「待办」、细节见 HANDOFF / CHANGELOG）

一句话：**「飞书 story → 多仓 MR」的核心闭环 + Harness 加固 + 桌面端发版链、都已上线并在日常使用。**

- **Action 体系全实装**：`plan / build / review / ship / dev（联调）/ learn / custom（自定义）`——任意触发不强制顺序、每步落 md artifact、action 间 HITL ack（test 已删、见「四、止损」）
- **6 harness 门槛（缺门槛 5）**：前置准入 / 后置 deterministic check / 默认选中 / anti-patterns prompt / placeholder 动态；**门槛 5（cross-action 一致性自检）仍未做**、见「二、未来候选」
- **Shell 命令硬拦截**：beforeShellExecution hook + 黑名单策略引擎（确定性、非 prompt 软约束）
- **GitLab REST 集成**：多仓 MR + 同分支累计 commit + 冲突门禁 + 飞书 @ 测试人员（A+C 策略）
- **大需求分批 build** + 自适应 TDD 策略（每批 tdd/after/none、无测试设施自动退化）
- **Agent 生命周期**：每 action 默认新 agent（context 隔离）+ shell/curl long-poll 保活
- **配置双向绑定 Cursor**：消费 `~/.cursor` + repo `.cursor` 的 mcp/rules/skills/hooks（fe 只读不写、附录 A）
- **MCP OAuth**：走 OAuth 的远程 MCP 授权 + 注入
- **自定义 Action + 推进面板布局可配**：skill/playbook 封装成 action、拖拽排序 + 显隐混排
- **应用外壳 + 侧栏任务导航** + light/dark 三态主题
- **Electron 桌面端唯一发版链**：薄壳 + 打包 + 自更新（win/mac UX 对齐）
- **learn 知识沉淀「先问后落」**：AI 提炼候选 → 逐条 ask_user → 只落用户批准的

---

## 二、未来候选（没做、按 ROI 排、不一次做完）

| 方向 | 内容 | 状态 / 依赖 |
|---|---|---|
| **Cost / Token Dashboard** | 每 task / action / 全局看 token + 成本、扫 `events.jsonl` 汇总；可选接 Langfuse / Helicone | 未做、数据源已有（events.jsonl 已记 token） |
| **门槛 5：cross-action 一致性自检** | `plan ↔ build ↔ review` 漂移核查（借鉴 Spec Kit `/analyze`） | 未做、一直 pending |
| **多 task 复用 plan / artifact** | 链接式引用、不复制 | 未做 |
| **比较同 task 多次执行差异** | `actions/` 时间序 diff 可视化 | 未做 |
| **多角色扩展** | `be / data / mobile / qa`（`TaskRole` schema 已预留） | 未做 |
| **MR 状态 polling / worktree 隔离** | 高级、需更多 task 数据再评估 | 未做 |

> 体验清单已消化：**归档**（已由「7 天 auto-archive + 侧栏折叠」替代、手动归档概念已删）；**cancel 中途打断**（`forceNewAgent` + 停止/重启已覆盖大部分）。

---

## 三、代码健康度快照（2026-07-01、待拍板是否投入）

客观现状、作为「要不要重构」的讨论输入（**非既定计划**）：

| 文件 | 行数 | 备注 |
|---|---|---|
| ~~`src/lib/server/task-runner.ts` 2944~~ | **1650**（v0.9.7 已拆） | 拆出 `task-stream` / `task-prompts` / `action-gates` / `sdk-message-handler` 四模块、runner 只留编排；`internalStartAgent`（565 行）耦合深、本轮保守未拆 |
| ~~`src/lib/server/chat-mcp.ts` 1967~~ | **949**（v0.9.8 已拆） | 拆出 `chat-pending`（1049 行、pending 状态机 + 信号 API）、chat-mcp 只留 MCP server 本体；`buildMcpServer` 的工具 description 长文本占大头、不再细拆 |
| ~~`src/lib/server/task-fs.ts` 1851~~ | **1181**（v0.9.9 已拆） | 拆出 `task-fs-core`（462 行、路径/schema/锁/事件 IO/hydrate 底座）+ `task-artifacts`（302 行、附件/artifact/revisions）、task-fs 只留 CRUD + patch API |
| `action-checks.ts` / `advance-dialog.tsx` / `tasks/[id]/page.tsx` | 1000+ | 偏大、暂不动（内聚性尚可） |

与 `learned-conventions`（「方法体 > 30 行就拆」「减少手戳代码」）冲突。**2026-07-02 用户拍板启动重构**（「6吧。你做好点，不要改出问题了」）：三轮全部完成——task-runner（v0.9.7）→ chat-mcp（v0.9.8）→ task-fs（v0.9.9）、均纯搬家零逻辑变更 + 归一化 diff 核验 + test 包冒烟。仓库不再有 >1700 行的 server 文件。

---

## 四、明确不做（止损）

| 不做的事 | 为什么 |
|---|---|
| **test action / 自动跑单测 · e2e**（v0.8.25 已删）| 公司项目普遍无单测 / e2e 基础设施、强行做 ROI 低（补测又被判无意义、TDD 落不了地）。质量验证最终定型 = **review（静态读代码）+ build agent 增量自查（v0.9.13 起系统级 CheckRun 也删、见下条）+ 人工验收兜底**。GStack 式浏览器黑盒 QA（不依赖单测）曾评估、但需接 playwright MCP + 维护成本、**暂不启动**。build 侧自适应 TDD 批次策略是唯一保留的 Superpowers 借鉴点（附录 B） |
| **系统级跑项目命令的 CheckRun**（V0.6.25 建、v0.9.13 已删）| 全仓 typecheck/lint 问的是「项目绿不绿」、存量项目基线本来就红——agent 只改两文件也永远红、红色失去信息量、ship 每次都要 override。质量校验改由 build agent **增量**自查（改哪查哪）+ review 人审；后置 check 只保「交付诚实性」（artifact / 指纹 / MR 验真）。细节见 HANDOFF「后置 check 的边界」段 |
| 真·multi-agent 协作（PM/Dev/QA 谈判式、如 BMAD） | Cognition 警告、共识盲点、debug 灾难。注：单 task 多 action 链是合法的、跟这条不冲突 |
| AI 自审 review bot（纯 LLM 看 LLM 写的代码判对错） | 共识盲点 + 性价比低。**注**：V0.6 review action ≠ 这条——前者拿 git diff × plan artifact × build artifact 做结构化差值、用确定性产物、不是 LLM 判断对错、本质是 harness 增量 |
| 跨 AI 厂商路由（LiteLLM） | 没必要、增加复杂度、Cursor SDK 已覆盖主流模型 |
| 自动 merge MR | 责任归属问题、永远不该自动 |
| 接 IDE plugin | 命令行 + Web UI（现桌面壳）已够、IDE plugin 维护成本高 |
| 黑名单 / 字符串 predicate（V0.5.6.5 试过、V0.6.0.1 已删） | 业务高频词误伤、replace by「客观可证伪 predicate」路线（命令 exit code / hash / 文件存在性 / JSON schema 校验） |
| advance dialog「推荐」微标签（V0.6.0.1 已删） | 推断逻辑只是「流程顺推 + 业务状态映射」、谈不上智能推荐、暗示「我跟你说要走这个」反而误导。保留「默认选中」减少首次点击、但不标推荐二字 |
| ActionTimeline 失败 chip retry 快捷入口（V0.6.0.1 加过又砍） | 语义混乱：点旧 error chip 实际是打断当前 running + 起新 action、跟直觉「修复那条历史」差太远。统一从「推进」按钮 + `forceNewAgent` 恢复 |

---

## 五、决策检查表（V 转 V 时）

每个 V 完成后、问自己 4 个问题、再决定下一步投不投：

1. 当前 V 在真实 task 上的命中率 ≥ 70% 吗？（不够、回去调 prompt / 加 harness 门槛）
2. 用户实际使用频次足够吗？（一周用不到 3 次、说明价值不够、暂停下一版）
3. 维护成本是否在增长？（prompt 越来越长、规则越来越多、文档越来越散、**核心文件越来越大**——警惕）
4. 用户主动要扩展吗？（用户不主动提、就是没痒处、不要硬推）

**任意一个 ❌ → 暂停、调研、不要硬推下一阶段**。

---

## 附录 · 调研沉淀留档（已落地 / 已止损、保留当时分析）

> 下面三段是历史调研记录、已有明确结论。保留分析过程供回溯、不再当「待办」。

### A. 配置双向绑定 Cursor（✅ 2026-06-01 完成）

ai-flow 不自己维护 MCP / rules / skills、统一消费 Cursor 的全局（`~/.cursor/`）+ 项目（repo `.cursor/`）配置。定位「锦上添花」、配置单一源在 Cursor、fe 只读不写。

**最终分工（关键：repo 层 vs 全局层分开处理）**——`settingSources` 是分层枚举（`SettingSource = "project" | "user" | "team" | "mdm" | "plugins" | "all"`）：

| 配置层 | 来源 | 谁加载 |
|---|---|---|
| **项目层** repo `.cursor/`（rules/skills/mcp/hooks）| 目标仓库 | `Agent.create({ local: { settingSources: ["project"] } })`、SDK 读 |
| **全局层** `~/.cursor/`（rules/skills/mcp）| 用户机器 | **fe 后端自己读**（`cursor-config.ts` + `skills-loader.ts`）注入 |

为什么全局层 fe 自己读、不靠 settingSources：`["project"]` 只加载 project 层、够不着 user 层；`"user"` 是粗开关、一开把全局 20-30 个 MCP 全塞进 context、没法 per-task 精简。fe 自己读：可控、可用 `task.disabledMcpServers` per-task 过滤。

**✅ 头号风险已验证（2026-05-29 探针实测、`scripts/probe-mcp-*.mjs`）· chat-tool MCP 共存安全**：
- **结论 1（不同名来源）：叠加、不覆盖。** inline=probeInline + repo `.cursor/mcp.json`=probeProject → 两 server 都被 spawn、两工具都调通。chat-tool 开 settingSources 后不会丢、安全。
- **结论 2（同名 key 冲突）：inline 赢、双保险。** 同 server key 时两进程都 spawn、但工具层 inline 覆盖 project、agent 只看到 inline 工具。chat-tool 哪怕撞用户同名 key、用的也是 fe 的 inline 版。

**skills 加载**：`loadSkills()` 读平台自带 `<ai-flow>/skills/` + 全局 `~/.cursor/skills/`（同名平台优先）；不读 repo `.cursor/skills/`（交 settingSources、避免同一 skill 进 prompt 两次）。

**hooks**：`["project"]` 加载 repo `.cursor/hooks.json`、fe 用它做 stop hook + beforeShellExecution 兜底（没 hooks.json 就建 / 有就补缺 / fail-open 只认领 fe 的 agent、不误伤 IDE agent）。

### B. 质量保证体系蓝图 · 博采四大库 + 飞书差异化（2026-06-05 调研 · ⚠️ test 方向已止损）

> ✅ **结论已定（2026-07-01）**：本段讨论的 test action（动态运行时验证）**方向已止损**——test action 于 v0.8.25 删除（理由见「四、止损」）。build 侧「自适应 TDD 批次策略」是唯一落地的借鉴点（大需求分批时每批标 `tdd`/`after`/`none`、build agent 按策略用 shell 实跑、无测试设施自动退化）。下面是当时的对标分析、留档。

对标四大库（详见 `PRODUCT-COMPARISON.md`）：我们「需求层 + 静态代码层」已到位 / 超越（飞书需求 × git diff + fresh peer 两阶段 review + 确定性后置检查）。当时判断唯一空白 = 测试验证（跑起来验证）：

| 来源 | 借鉴点 | 当时设想落点 | 现状 |
|---|---|---|---|
| Superpowers | TDD 红绿闭环（改「build 后补测」）| test ① | ✅ 以「build 侧自适应 TDD」落地 |
| GStack | 真浏览器 QA（Playwright）+ diff-aware + 失败生成回归 | test ② | ❌ 止损（需 playwright MCP、ROI 低） |
| Spec Kit | `/analyze` 跨 artifact 一致性 | 门槛 5 | ⏳ 仍未做（见「二、未来候选」） |
| OpenSpec | archive 合并 delta → 注入 AGENTS.md | learn action | ✅ learn 已落地（先问后落） |
| 我们独有 | 飞书验收用例作 test 基准 | test 护城河 | ❌ 随 test 止损 |

**当时的关键矛盾（已由止损化解）**：Superpowers TDD（跑单测/e2e）跟「公司没单测、强行做没意义」冲突。校准后判断：对无单测基础的项目、① TDD 落不了地、② 浏览器黑盒 QA 需接 MCP + 维护成本。最终整个 test 动态验证方向止损、只保留 build 侧自适应 TDD。

### C. harness memory 业界调研（2026-05-26 · ✅ learn 已落地）

5 类 harness memory pattern 取舍：

| 模式 | 是否采用 | 理由 |
|---|---|---|
| 静态规则文件（`.cursor/rules/*.mdc` / `CLAUDE.md` / `AGENTS.md`） | ✅ | 项目已用、可控 |
| auto-memory（AI 自动写 MEMORY.md） | ⚠️ | AI 自己改自己 prompt、debug 困难 |
| 自动生成规则（RepoScaffold / mirrorai） | ⚠️ | 同上、自动 review 自动写 rule 易脏 |
| Reflexion 自学习（evolve-loop） | ✅ | learn action 灵感来源、跟「客观可证伪 predicate」结合 |
| Memory infra runtime（Mem0 / Letta / Zep） | ❌ | 重、跟 Cursor SDK 已有 conversation history 重叠 |

**最终方案 = Reflexion-lite + AGENTS.md 落库**（业界 1 + 4 类组合）、已由 learn action「先问后落」落地。predicate 沉淀走「客观可证伪」路线（命令 exit code / hash / 文件存在性 / JSON schema 校验）、不走「凑字符串黑名单」。
