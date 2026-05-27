# fe-ai-flow Handoff

> **权威源**：代码 + 本文件。其余 docs/*.md 为辅助、有冲突以代码 + 本文件为准。
>
> （历史：曾经以飞书 V0.2 草稿为权威、已废弃。）

## 项目定位（一句话）

站在 Cursor SDK 肩膀上的**项目级 AI Harness 平台 · 飞书 story → PR 自动化**。核心是 Harness（缰绳）：每个 phase 边界用确定性工具（typecheck / lint / hooks / Skills / MCP / HITL ack）压住 LLM 非确定性、保证产出可观测、可回退、可复用。

## ⚡ 即将到来：V0.6 重构（设计阶段、代码未动）

> 2026-05-27 拍板、跟用户的真实工作流对齐后发现 V0.5 phase chain 模型存在系统性错配、决定重构为 **task 容器 + action 历史** 模型。**设计文档已落 `docs/V0.6-REFACTOR.md`**、新接力 AI 拿那份文档 + 本文件即可完整理解 V0.6 设计意图。

核心变化：
- **phase chain → action history**：`plan → build → review` 顺序拆掉、6 + 1 种 action（plan / build / review / ship / test / learn / chat）任意触发
- **单 task = 单生命周期**：MR 提了不结束、可继续 build → ship v2 v3 …、最终用户标完成才跑 learn 归档
- **chat 模式吸收**：删 chat-runner、chat 变成 `action=chat`、统一架构
- **6 个 harness 门槛补回顺序约束的隐性保证**：准入条件 / 后置 deterministic 检查 / 推荐 default / anti-patterns prompt / cross-action 一致性 / textarea placeholder
- **保留**：单 SDK Run 永生、shell + curl long-poll 保活、HITL 是底线

未拍板项见 `V0.6-REFACTOR.md` 第 13 节、动手前需跟用户确认 7 个问题。

## 给 AI 接力的最小上下文

接力的 AI 进来后按顺序读：

1. `.cursor/rules/project-context.mdc` —— 强制约束
2. `.cursor/rules/learned-conventions.mdc` —— 编码风格
3. 本文件的「当前架构快照」段（V0.5 系列、稳定架构）+「最近演进」段（V0.5.15 chat-runner 跟 plan-runner 对齐 + V0.5.14 事件流虚拟滚动）
4. `prompts/_super.md` —— **super-prompt 主模板**（V0.5.11 抽出、占位符注入式、改模板优先在这里改、不再回 .ts 改硬编码）
5. `prompts/_shared.md` —— **三 phase 通用 artifact 写法 + 跨 phase 规则**（V0.5.7.7 抽出、改 phase prompt 前必读、避免漏改一处导致跨 phase 不一致）
6. `prompts/phase-1-plan.md` / `prompts/phase-2-build.md` / `prompts/phase-3-review.md` —— phase 特有约束
7. `src/lib/server/plan-runner.ts` 的 `buildSuperPrompt()` —— 看 super-prompt 怎么拼装（V0.5.11 后 ~100 行、纯变量注入）
8. `docs/DESIGN.md` 顶部 warning + 第 16 节（chat 架构、注意节首 V0.3.5 + V0.4 警告）
9. `docs/ROADMAP.md` 当前阶段表
10. `docs/MULTI-ROLE.md`（V0.4 多角色机制）
11. `docs/CHANGELOG.md` —— 历史演进档案（V0.2 ~ V0.5.10）、想看某条早期变更细节再翻、平时不用看
12. `src/lib/server/chat-mcp.ts` 顶部注释（保活机制核心）
13. `src/lib/server/chat-runner.ts` 顶部注释 + `buildInitialPrompt`

## 代码层面要点

### 强制

- 思考和回复永远用中文
- 每次对话操作前唤起 `cursor-feedback` MCP、timeout 600 秒
- 代码改完跑 `pnpm typecheck`（用户对低级错误零容忍）
- 开发期不要写向后兼容代码

### 编码约定（详见 `.cursor/rules/learned-conventions.mdc`）

- UI 组件统一用 shadcn/ui、不要手写原生 element
- 函数声明统一用箭头函数（除了第三方 / Next.js default export）
- 注释中文、解释"为什么"而不是"做什么"
- 每个 useState / useRef / useMemo 跟一行短注释

---

## 当前架构快照（V0.5 系列、稳定）

> 本段只描述「现在的代码是这样组织的」、不带版本号迭代细节。版本演进史看 `docs/CHANGELOG.md`。

### Phase 模型：plan → build → review

```
新建 task → plan（出方案 01-plan.md）→ build（写代码 + 02-build.md）→ review（diff 对照 + 03-review.md）→ completed
```

- 三个 phase 都在**同一个 SDK Run**里跑、phase 间用 `wait_for_user` 阻塞等用户 ack（节省 Cursor 计费——Run 收费、不是请求收费）
- PR 提交 + 飞书状态回写**手动由用户做**（review artifact 里给 commit msg / PR body 草稿、用户复制走）
- ⛔ 不做「agent 发现差异自己改、再 review 一轮」自动循环（HITL 闸门优先、避免 token 爆炸）

### HITL 闸门

每个 phase 结束 = `awaiting_ack` 状态、用户必须 ack 才能进下一 phase：

- **通过 PHASE**：打开 `ApprovePhaseDialog`、可选「换新 agent」+「切下一 phase 模型」
- **再聊聊（revise）**：打开 `ReviseDialog`、用户输入 feedback、走「问类 / 改类」二分类（见下）
- **deferred**：ask_user 弹窗有「稍后再补充」按钮、给用户跳过本轮 ask_user 的口子

### Revise 二分类铁则（V0.5.10 拍板）

用户写 feedback 后、AI 行为**完全可预测**：

```
- 问类（纯疑问句、不含改动暗示）
  字面含「为什么 / 怎么 / 是不是 / 能否 / 吗 / 呢 / ?」等疑问标记 + 不含改动暗示
  → 直接 emit assistant_message 答疑、不弹窗、不动 artifact

- 改类（其他所有 feedback、含模糊 / 兜底）
  → 先弹 ask_user 复述意图（固定模板「我打算 X、对吗?」、只有「✅ 同意」一个选项）
  → 用户 ✅ → 用 edit 改 artifact、按 _shared §5 留修改记录
  → 用户走「自定义回答」重说 → 当新一轮 revise feedback、重新走分类
```

判定护栏：判不准就当改类、走弹窗——错弹窗成本 1 click + 重说一句、错答疑成本「用户得再点再聊聊 + 重写指令」。

### 保活机制：shell + curl long-poll（V0.3.5）

```
agent 调 wait_for_user / ask_user
  → MCP 工具立即返回 shell 引导文本
  → agent 用 SDK shell 工具调 curl -sN <base>/api/tasks/:id/wait-ack?token=…
  → 长 HTTP 连接挂住、服务端每 60 秒 write 一行 [KEEPALIVE ts=...]
  → 用户 ack/reply → 服务端 resolve promise → 写一行结果 → 关流 → curl exit → agent stdout 拿到结果推进
```

**不**走 MCP 60s timer + 轮转——会踩 Cursor backend anti-loop。实证 shell 工具能撑 30 分钟+ 不挂。

### 推进入口三模式（V0.5.7）

task 跑到 failed / awaiting_user / completed 状态后、用户点「推进」、`AdvanceDialog` 三选一：

| mode | 后端动作 | 适用场景 | 成本 |
|---|---|---|---|
| `resume` | `Agent.resume(lastAgentId)` + send 续接 | wait-ack 断、agent 在 backend 仍活着 | +1 send 配额 |
| `fork` | `Agent.create` 新 agent + fork banner、从指定 phase 起跑、上游 artifact 复用 | 原 agent 已死 / 切模型 / 局部 fix | +1 send 配额 |
| `restart` | `Agent.create` 从 plan 完全重跑、覆盖现有 artifact | 改 prompt 大改动后想看纯净重跑 | +1 send 配额 |

**resume 自动降级 fork**：plan-runner catch 块检测 `NGHTTP2_ENHANCE_YOUR_CALM` / `Stream closed`、自动降级 fork（fromPhase = 当前 phase）、用户视角一次推进就能续走。

fork 时 textarea 填 reason（「这次主要想修什么」）、AI 拿到后会先 read 当前 phase artifact 判 fix mode、不 rewrite 已有产物、增量 edit。

### 多角色 schema（V0.4）

`Task.role: TaskRole`（当前仅 `"fe"`、未来扩 `be / data / mobile / qa`）、`TASK_ROLE_LABEL` 中文映射、prompt 顶部「当前角色：xxx」提示让 agent 只挑跟自己 role 相关的部分做。

### 多仓库 cwd 公共父目录（V0.5.9）

`Task.repoPaths: string[]`、SDK Run `local.cwd = getEffectiveCwd(repoPaths)`：

- 单仓 → cwd = 仓自身
- 多仓 → cwd = 公共父目录、AI 视角下挂 N 个 git 子仓、路径首段是仓名
- artifact / prompt 里的所有路径都以 `effective cwd` 为基准
- 多仓 git 命令必须 `cd <repo>` 再跑（super-prompt 已 inject 说明）

### Artifact 间引用走前端 tab 切换（V0.5.8）

`looksLikeArtifactRef(s)` 识别 `0N-<phase>.md` 形式的纯文件名引用（裸名、不含 `/`）、artifact-panel 渲染时把它变成可点 button、点击切到对应 phase 的 tab。

prompt 写「详见 `01-plan.md` §4」无需写完整路径、AI 心智负担不变、用户体验流畅。

### Super-prompt 模板化（V0.5.11）

super-prompt 主模板 = `prompts/_super.md`（17 个占位符）、`buildSuperPrompt()` 只负责变量注入：

```
buildSuperPrompt
  ├─ loadSuperPromptTemplate()    读 _super.md
  ├─ loadSharedPrompt(task)       读 _shared.md（跨 phase 共享规范）
  ├─ loadPhasePrompt × N          每个 phase 自己的 prompt md
  ├─ buildForkBanner()            fork 模式才有内容、否则空字符串
  └─ renderSuperPromptTemplate()  一次性 replace、空字符串保留字面（区别于 fillTemplate）
```

改 prompt 文案优先动 .md 文件、不用回 .ts 改硬编码。`renderSuperPromptTemplate` 跟 `fillTemplate` 区别：前者只把 `undefined`/`null` 替换成 `（未提供）`、后者把空字符串也替换。

### 共享 prompt `_shared.md`（V0.5.7.7）

三 phase 通用约束（artifact 写入工具 / frontmatter 禁项 / path 完整路径写法 / 内部技术词禁项 / fix mode 修改记录 / 中文表述 / 数字命名自检）抽到一份 md、`buildSuperPrompt()` 拼到「各 phase 详细 prompt」段之前。

改约束改一处即同步、不会漏改 3 个 phase 文件其中一个。

### Resizable 分栏（V0.5.10）

任务详情页 artifact / event-stream 双栏可拖动：

- 默认 70 / 30、minSize 20% / maxSize 80%
- 持久化在 `task.uiLayout.artifactPanelSize`（不写事件 / 不动 updatedAt）
- `react-resizable-panels@4.11.1`、4.x API（注意跟 shadcn 文档基于 2.x 不一样、详见 CHANGELOG V0.5.10 hot-fix）

### Artifact 修订快照 + Diff 视图（V0.5.12）

每次用户「再聊聊」（revise）让 AI 改 artifact 之前、后端先 snapshot 当前正文：

- `phase-ack` 路由 revise 分支 → `snapshotArtifact(taskId, phaseId)` → 复制到 `data/tasks/<id>/artifacts/.revisions/<NN>-<phase>.<ISO>.md`
- `Task.revisions[phaseId]` 末尾追加 `{ timestamp, path, size }`、每 phase 上限 10 个、超出 GC 删最老
- 只覆盖「用户主动 revise」单一路径——agent 自主 edit 不触发（最高频场景一版搞定）

`ArtifactPanel` toolbar 加「正文 / Diff」切换：

- Diff 模式下显示快照 dropdown（对比上次 / 初版 / 任意快照）+「行内 / 并排」切换
- 有未看 revision 时 Diff 按钮右上角挂红点、点 Diff 切过去后红点消失（第一版用过 banner、用户拍板「简单点」、改成红点）
- `next/dynamic` 懒加载 `react-diff-viewer-continued`（~36KB 库体积）、不切到 Diff 不拉
- 「已看」状态走 `localStorage`（key `fe-ai-flow:artifact-revisions-seen:<taskId>:<phaseId>`）、不污染 task meta

### Ask_user 协议（V0.3.2 modal + V0.5.6 无次数上限）

- ask_user 弹窗 modal、不在事件流里 inline、避免被 keep_alive 信息淹没
- options 自动加 A/B/C/D 字母前缀、一次性提交所有答案、不可 dismiss
- **整个 phase 内无次数上限**、AI 按内容判断要不要继续问（不预设次数）
- **「稍后再补充」按钮**给用户退出循环的口子、答完点了 → `[ASK_USER_REPLY deferred]` 头、agent 把未答 Q 列进 artifact §6 + 按 default 推进
- ⛔ 没有「AI 推荐项 / 一键接受」机制——HITL 是底线、所有 ask_user 选项必须用户自己拍、AI 不预判倾向

### Review phase 闭环：ask_user → 落地 plan（V0.5.12）

review phase 写完 03-review.md 初稿后、如果「实现偏差」或「未完成 task」段非空、**必须**调一次 ask_user 把所有条目一次性问完、不能让用户去 revise 才表达决策（旧版「a/b/c 嵌 artifact、用户去 revise 写文字答 a/b/c」对不熟悉的用户是盲盒）。

```
ask_user 答完后 agent 落地：
  实现偏差 b（接受偏差 + 更新 plan）→ edit 01-plan.md 对应段落（保留 ~~strikethrough~~ + 加补录标记）
  未完成 task c（接受不做）         → edit 01-plan.md §5 task 加注解
  a（改回 plan / 现在补做）         → 不动 plan、决策段记「等用户 ack=revise 触发」
  自定义文本                       → 不落地、决策段记原话、必要时 assistant_message 提示
→ 每条决策追加到 03-review.md「§ 用户决策」段（agent 自己 edit）
→ 调 wait_for_user 等用户最终 ack
```

约束扩展：review phase **允许** edit 01-plan.md（破例、只在 §7 ask_user 答完 b/c 后、只动描述 / 注解、不动 §5 task 拆分骨架 / 文件清单 / 决策标题）。

⚠️ V0.5.12 limitation：review phase edit 01-plan.md 时不自动 snapshot 旧 plan、diff 视图看不到这次改动、V0.5.13 再补。

---

## 最近演进（窗口式、保留 2 个子版本）

> 写入规则：新子版本完成后在本段顶部追加、超过 2 个时把最老的迁到 `docs/CHANGELOG.md`。

### V0.5.16-design：V0.6 重构设计纪要（2026-05-27、代码未动）

**整体**：跟用户深入对齐工作流（飞书需求 → 多个 MR → 测试反馈 → 改代码再提 → 最终合入）后、确认 V0.5 phase chain 模型存在系统性错配。决定重构为 task 容器 + action history 模型、设计文档落 `docs/V0.6-REFACTOR.md`。**本子版本只产文档、不动代码**。

#### 产出

- **`docs/V0.6-REFACTOR.md`**（新文件、~900 行）：V0.6 完整设计文档、14 节 + 3 附录、包含：
  - 0-1 节：接力上下文 + 重构背景（用户工作流复述 + 4 个错配）
  - 2-3 节：V0.5 核心问题 + V0.6 新架构总览（task 容器 + action history + 单 SDK Run 永生）
  - 4 节：task schema 新旧对比 + 文件系统改造（actions/ 目录、N-<type>.md）
  - 5 节：6 + 1 种 action 详细规格（plan / build / review / ship / test / learn / chat）、每种含触发条件 / 行为 / artifact 骨架 / 后置检查 / 反例
  - 6 节：6 个 harness 门槛设计（P0：准入 + 后置检查 + anti-patterns prompt；P1：推荐 default + placeholder；P2：cross-action 一致性）
  - 7 节：prompt 文件重组方案（phase-N → action-<type>、_super.md 大改）
  - 8 节：UI 改造点（任务详情页 + 推进 dialog + ack dialog）
  - 9 节：「再聊聊」/ revise / chat 在新架构下的语义
  - 10 节：单 SDK Run 永生策略 + wait_for_user 协议改动
  - 11 节：老 task 兼容（只读 / 归档、不写 migration）
  - 12 节：分版本路径（V0.6.0 核心重构 → V0.6.1 ship → V0.6.2 test → V0.6.3 learn → V0.6.4+ 高级）
  - 13 节：未拍板项（7 个动手前必须澄清的）
  - 14 节：新 AI 接力 checklist
- **`docs/HANDOFF.md`**：顶部加「即将到来：V0.6 重构」段（5-10 行）、关键文件索引加 V0.6-REFACTOR.md 行
- **`docs/ROADMAP.md`** 顶部「下一阶段」段重写、原 V0.5.16 learn-phase-only 描述替换为 V0.6 重构概览、指向新设计文档

#### 关键设计决策（不要回头）

1. **phase 顺序拆掉**：plan / build / review / ship / test / learn / chat 是 action 类型、不是顺序约束
2. **单 task 多 MR**：MR 提了 task 不结束、可继续推进、`Task.mrs` 列表追踪
3. **chat 吸收**：删 chat-runner.ts、chat = `action=chat`、统一架构
4. **单 SDK Run 永生**：跟 V0.5 一致、Run 不退（除非 task 标完成 / abandon）
5. **6 harness 门槛补回**：准入 + 后置 + prompt + placeholder + 推荐 default、保证拆顺序后能力不降
6. **老 task 只读**：不写 migration、按 project-context.mdc「不写向后兼容」原则

#### 工作量预估

V0.6.0 核心重构 3-5 天密集开发、不是「加 phase」而是换核心模型。详见 V0.6-REFACTOR.md 第 12 节。

#### 没做的事

实际代码改动**全部留给下一个 AI**——用户拍板「设计这么大量级、单 agent 长对话上下文必塞爆、新 agent 拿设计文档接力更稳」、跟 harness 思想「不依赖单 LLM 连贯性、用结构化文档约束」自洽。

### V0.5.15：chat-runner 对齐 + V0.5.6.2 plan 重构后遗症清理（2026-05-26）

**整体**：接力时一锅做的两类清理。一类是「plan 有、chat 还没」的对齐性 bug（console.log 兜底）；一类是 V0.5.6.2 plan 重构（砍 §3.1 文件清单 + 验收点直接挂 task）只动了 plan、build / review prompt 没跟上的后遗症。无新功能、纯清理 + 对齐。

#### 1. chat-runner `case "status"` 加 console.log 兜底（对齐 plan-runner V0.5.5 增强）

**背景**：SDK 1.0.13 `status=error` 时偶尔不发详细 message、`run.wait()` 拿到的 RunResult 也不带具体描述、chat 模式只能 throw 一个空错误、用户 / dev 看不到任何诊断信息。plan-runner 早就在 case `status` 顶部加了一行无条件 `console.log` 兜底——chat-runner 漏了。

**修法**：`src/lib/server/chat-runner.ts` 的 `case "status"` 头部补一份同款 log：

```
console.log(
  `[chat-runner] SDK status message: status=${msg.status} message=${
    (msg as { message?: string }).message ?? "(none)"
  }`,
);
```

#### 2. phase-2-build.md 骨架跟 V0.5.6.2 plan 重构对齐

V0.5.6.2 把 plan §3.1 文件清单砍掉、验收点直接挂在每个 task 上、但 build 骨架那时没跟上、留了「## 改动文件清单」+「## 验收对照」两个独立段、跟 task 自带字段重复 100%。同时 V0.5 加 review phase 后由 review 出 commit msg、build 还在出一份、也重复。本轮一次性清掉：

- **task 子条加「验收处理」字段**（4 → 5 字段：改动文件 / 关键实现 / 偏离 plan / 验收处理 / 局部校验）——逐条对应 plan §5 该 task 的「验收点」、说明每条是否满足 + 如何验证、解决「review 找不到 task 自带验收点处理结果」的问题
- **删独立的「## 验收对照」段**——跟 task「验收处理」字段重复
- **删独立的「## 改动文件清单」段**——跟 task「改动文件」字段重复、跟 §1 总览「改动文件数」也重复
- **删「## 给用户的交接」段**（commit msg 等）——由 review phase §5.1 统一出
- 同步更新顶部「⚠️ 路径写法」警告（不再引用「## 改动文件清单」/「## 验收对照」表）

#### 3. plan-runner.ts loadPhasePrompt 删 4 个 unused 占位符

历史残留：`title` / `feishuStoryUrl` / `description` / `artifactsDir` 注入了但 phase prompt 没一处引用、按「开发期不写兼容代码」原则清掉。顺便删 `getArtifactsDir` import（dead）。

#### 4. phase-1 artifact 写入工具引用表述统一为 phase-2/3 同款（去括号注解）

`prompts/phase-1-plan.md` 的引用比 phase-2/3 多带括号注解「（创建用 write、改已有用 edit、首次写前 read 一遍 artifact-writer skill）」、详细信息 `_super.md`「跨 phase 共享规范 §1」里已经说清楚、不需要每个 phase 都重复。三 phase 现在表述一致：`artifact 写入工具用法见 super-prompt「跨 phase 共享规范 §1 artifact 写入工具」。`

#### 5. ROADMAP.md V0.5 段「plan phase 校验前移」描述跟 V0.5.6.1 同步

ROADMAP 还写「plan agent 在 01-plan.md 里写『我的理解 vs 飞书原文』对照」、V0.5.6.1 已经撤了这个段、改成「跟原文有差异一律 ask_user 闭环」、ROADMAP 没跟。本轮顺手改成真实实现。

#### 验证

`pnpm typecheck` ✓ / `pnpm lint` ✓（包括清掉的 `getArtifactsDir` import warning）

#### 没做的事（用户拍板「保持手动重启」）

接力文案里另一个小 bug「chat 模式加 `NGHTTP2_ENHANCE_YOUR_CALM` 自动降级（plan 已有、chat 还没）」**暂不做**——尝试实现时跟用户对齐产品设计、用户拍板「就还是用户手动重启」、保留 chat 模式现状：撞 NGHTTP2 → task 标 failed → 用户重新发消息触发自动启动新 agent（走 chat-reply 的「terminal status 自动启动」分支）。

- plan 的「自动降级」是把 resume 失败拉回 fork、用户视角一次推进就够；
- chat 的「自动降级」语义没拍板（要不要 agent 主动读历史 / 要不要断路器 / 要不要 info 提示）、留待真有用户痛点时再单独评估。

> V0.5.10 ~ V0.5.14 系列细节已全部迁到 `docs/CHANGELOG.md` 同名段（包括 V0.5.12 四轮迭代：diff 视图 / review 闭环 / 全局清理 / review prompt 5 点精修；V0.5.13 事件流密度优化 + 4 dialog Cmd+Enter 默认快捷键；V0.5.14 事件流虚拟滚动 + memo）。本窗口当前留：V0.5.16-design（V0.6 重构设计纪要、详见 docs/V0.6-REFACTOR.md）+ V0.5.15（chat-runner 跟 plan-runner 对齐）。V0.6.0 收口时把 V0.5.15 迁到 CHANGELOG.md、V0.5.16-design 也整段迁过去（设计先行、代码落地后形成新一轮稳定快照）。

---

## 关键文件索引

| 内容 | 位置 |
|---|---|
| **V0.6 重构设计文档（2026-05-27 设计阶段、代码未动）** | `docs/V0.6-REFACTOR.md` |
| Plan workflow 整体逻辑 + super-prompt（V0.5.11 重构后） | `src/lib/server/plan-runner.ts` |
| **super-prompt 主模板（V0.5.11 抽出、占位符注入）** | `prompts/_super.md` |
| **跨 phase 共享规范（V0.5.7.7 抽出）** | `prompts/_shared.md` |
| Chat workflow 整体逻辑 + V0.4 firstMessage 注入 | `src/lib/server/chat-runner.ts` |
| contextDocs prompt 渲染 helper（V0.4 抽出、plan/chat 共用） | `src/lib/server/context-docs-prompt.ts` |
| `wait_for_user` / `ask_user` 实现 + pendingMap + grace race fix | `src/lib/server/chat-mcp.ts` |
| wait-ack 长连接路由（V0.3.5、保活核心） | `src/app/api/tasks/[id]/wait-ack/route.ts` |
| 统一推进入口（V0.5.7、resume / fork / restart 三模式） | `src/app/api/tasks/[id]/start-workflow/route.ts` |
| chat-reply 路由（V0.4 合并启动职责） | `src/app/api/tasks/[id]/chat-reply/route.ts` |
| Phase 状态机 patch / 任务级互斥锁 / 原子写 / `lastAgentId` / **artifact snapshot 函数（V0.5.12）** | `src/lib/server/task-fs.ts` |
| **Artifact revisions / diff 路由（V0.5.12）** | `src/app/api/tasks/[id]/artifact-revisions/route.ts` + `artifact-diff/route.ts` |
| ContextDocsPanel（chat / plan 都用） | `src/components/tasks/context-docs-panel.tsx` |
| ask_user 弹窗（V0.3.2 modal、V0.5.6 加 deferred） | `src/components/tasks/ask-user-dialog.tsx` |
| **事件流主组件（V0.5.11 拆分、V0.5.14 接 Virtuoso 虚拟滚动）** | `src/components/tasks/event-stream.tsx` |
| **事件流工具函数（V0.5.11 拆出、V0.5.13 加 mergeAdjacentToolCall）** | `src/components/tasks/event-stream/utils.tsx` |
| **事件流行组件（V0.5.11 拆出、V0.5.14 React.memo 包裹）** | `src/components/tasks/event-stream/rows.tsx` |
| **Artifact 面板（V0.5.12 加 Diff toolbar + banner）** | `src/components/tasks/artifact-panel.tsx` |
| **Artifact diff 组件（V0.5.12、react-diff-viewer-continued 包装）** | `src/components/tasks/artifact-diff.tsx` |
| Chat 视图（V0.4 自由化、无启动按钮） | `src/components/tasks/chat-view.tsx` |
| Plan 模式 UI（V0.5.7「推进」按钮 + V0.5.10 Resizable 分栏） | `src/app/tasks/[id]/page.tsx` |
| 推进 dialog（V0.5.7、resume / fork / restart 三选一） | `src/components/tasks/advance-dialog.tsx` |
| 启动 / phase ack / ask reply / mcp 黑名单 API | `src/app/api/tasks/[id]/start-workflow/route.ts` + `phase-ack/route.ts` + `ask-reply/route.ts` + `route.ts`（PATCH） |
| Plan / build / review phase prompt | `prompts/phase-1-plan.md` + `prompts/phase-2-build.md` + `prompts/phase-3-review.md` |
| Phase ack 高级选项 Dialog（V0.5、切模型 + fork agent） | `src/components/tasks/approve-phase-dialog.tsx` |
| 任务角色 schema + 展示文案（V0.4） | `src/lib/types.ts: TaskRole / TASK_ROLE_LABEL` + `docs/MULTI-ROLE.md` |
| 多仓 cwd / repoPaths 工具（V0.5.9） | `src/lib/path-utils.ts: getCommonParentDir / getEffectiveCwd / formatRepoSectionForPrompt` |
| Resizable 分栏 shadcn-style stub（V0.5.10） | `src/components/ui/resizable.tsx` |
| Skills loader | `src/lib/server/skills-loader.ts` |

## 设计变动流程

权威源 = 代码 + 本文件。设计层面变动：

1. **当前架构变动**（如 phase 模型改、保活机制改、新增大组件）→ 改代码 + 同步更新本文件「当前架构快照」段
2. **小步迭代**（同主题连续 .1 / .2 / .3 微调）→ 改代码 + 写到本文件「最近演进」段顶部
3. **再老一轮时**（「最近演进」积压超过 2 个子版本）→ 把最老那段迁到 `docs/CHANGELOG.md` 顶部

⛔ 不要散落到其它 md 写一份新的演进段。
