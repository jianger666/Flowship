# Flowship 产品建议报告（2026-07-14 夜）

> 产出方式：1 个主 Agent 通读 README / HANDOFF / CHANGELOG / ROADMAP，外加 2 个并行子代理——
> 一个调研 2026 年 AI coding agent 行业与竞品（Cursor、Devin、Copilot、Claude Code、Codex、CodeRabbit、Greptile 等），
> 一个以 PM 视角只读扫描本代码库找短板。本报告为三方综合，所有建议都标注了依据与量级估计。
> 当晚还顺手修了 MR 收件箱二期的一串解析 bug（详见文末「今晚的实战教训」），部分建议直接来自这次排障。

---

## TL;DR：最值得做的三件事

1. **飞书远程 HITL（遥控推进 / 答题）**——把「交卷等推进」和 `ask_user` 推到手机上。这是把 Flowship 的最大特色（HITL）从限制变成优势的关键一步，也是今晚这场对话已经验证过的交互形态。
2. **任务队列 + 夜间批跑**——「白天排活、晚上验收」。与 1 配套形成闭环：夜里跑到需要人时，飞书卡片叫你。
3. **任务级成本 / 漏斗度量**——token、耗时、推进→MR→merged 转化率。行业 2026 年已是标配，Flowship 目前完全空白，而且 ROADMAP 里「已记 token」与代码实际不符，需要先补数据层。

行业大背景一句话：**主线已从「IDE 内结对编程」转向「可调度的异步 Agent 团队」**——云端并行、事件/定时触发、IM 遥控、成本度量、知识沉淀成为竞品标配。Flowship 的 HITL 流水线、worktree 隔离、artifact 体系、诚实性校验、提测收件箱都踩中了差异化；空白集中在**异步调度、成本可观测、团队知识层**三块。

---

## P0：远程 HITL —— 飞书遥控推进与答题

**问题**：HITL 是 Flowship 的核心设计，但目前绑死本机——只有 Electron 系统通知（`shell-notify.ts` / `task-attention-watcher.tsx`），ack / ask_user 没有任何远程通道。人一离开电脑，整条流水线就停摆。HANDOFF 里明确写过「不做 bot IM」，建议重新评估这条约束：不是做 IM 机器人对话，而是做**通知 + 轻量操作回传**。

**方案**：
- 任务交卷（等推进）→ 飞书卡片推送到手机，卡片上直接给「推进到下一 action」「先放着」「留言再聊聊」按钮。
- `ask_user` 提问 → 卡片带问题原文 + 选项按钮 / 文本回复框，回复通过已有的 `ask-reply` / `chat-reply` API 回灌（这两条 API 今晚刚修过并发竞态，链路是通的）。
- 实现上可以从最薄的切法起步：本机起一个飞书事件订阅（项目里已有完整的 lark 系列 skill 和 CLI 能力可复用），不必先建服务端。

**依据**：
- 竞品全线已落地：Cursor 有 Slack @Cursor，Devin 有 Slack/移动端，Copilot 有 Teams/Agent API。这是 2026 年成熟形态，不是激进尝试。
- 今晚这场会话本身就是原型验证：用户在外面，通过飞书卡片全程遥控 headless Agent 完成排障、修复、双模型 review、调研、写报告。体验成立。

**量级**：完整愿景是大需求，但可以切成三期，每期独立可用、影响面递增。关键架构决策是**做成旁挂 bridge，不动核心**：任务状态机、runner、HITL 语义一行不改，bridge 只是「事件出口 + 已有 API 的远程调用方」。

| 期 | 内容 | 改动面 | 说明 |
|----|------|--------|------|
| v0 | 单向通知：交卷/提问时发飞书消息 | ≈0，只加一个通知 sink | 通知发送点已集中在 `shell-notify.ts` / attention-watcher，旁边挂一个「发飞书」即可，先用自定义机器人 webhook，连事件订阅都不用。收到通知后仍回电脑操作。 |
| v1 | 卡片带「推进」按钮 | 新增 bridge 模块 + 配置页开关 | 回调走飞书**长连接事件订阅**（websocket，不需要公网地址），收到按钮点击后调本机已有的 advance API。核心零改动。 |
| v1.5 | 反向查询：在飞书里发指令拉任务列表并唤起推进 | 复用 v1 通道，加一个消息命令处理器 | 收到「任务」等指令 → bridge 调本机 `/api/tasks` 拉列表 → 回复卡片（每个任务显示状态 / 当前 action / 是否等推进或提问中，附操作按钮）→ 点按钮调 `advance` / `stop` 等。所有能力本机 API 已齐（`tasks`、`advance`、`question`、`stop`、`ship-precheck`…），bridge 只做翻译。 |
| v2 | ask_user 答题 + 自由文本回复（含**对话模式整体接入**） | 复用 v1 通道 | 回灌走已有的 `ask-reply` / `chat-reply` API——这两条链路今晚刚修过并发竞态，验证是通的。对话模式与 bridge 天然不冲突：chat 事件已走统一事件流（events + `watch-task` SSE），bridge 订阅同一流，在「本轮回复结束 / 等用户输入」时把回复推成飞书消息；飞书上的回复经 `chat-reply` 回灌后，桌面 UI 通过 SSE 同步可见，两端视图一致。注意三点：① 回环过滤（忽略 bot 自己发的消息事件）；② 双端并发回复按现有链路顺序处理（今晚修的竞态正是这类保障）；③ 降噪——不逐段推流，只在轮次结束时推一条（长回复可发卡片摘要 + 「回电脑看全文」）。 |

前提与安全边界：长连接是**本机主动外连**的 websocket，不需要公网地址、不开入站端口；电脑关机或 app 没跑时飞书指令无人消费（可靠飞书事件重试兜底 + bot 回「app 离线」提示）。bridge 只接受配置里指定 open_id 的指令，按钮回调同样校验身份。

用户侧配置成本（**可复用设置页已有的飞书 CLI 登录产物，大幅降低**）：
- Flowship 设置页的 lark-cli 登录（`config init --new`）本来就会引导用户**建一个企业自建应用**，App ID/Secret 已落在 `~/.lark-cli/config.json`（实测确认）。bridge 直接复用这个应用，不用重新建。
- lark-cli 二进制自带 `event consume`（长连接收事件、NDJSON 输出）和 im 发消息命令——bridge 可以直接 spawn 已装好的 lark-cli，**连飞书 SDK 都不用引**，和 meegle CLI 的集成模式完全一致。
- 用户可能需要补的一次性配置：给这个应用开机器人能力 + im 消息权限 + 事件订阅（开放平台控制台点几下 + 发布新版本，几分钟）。Flowship 向导可自检缺哪项、直接给控制台跳转链接。
- **v0（webhook 单向通知）连上面都不用**：建个只有自己的群 → 加自定义机器人 → 粘 webhook URL，1 分钟无审批。

真正的影响点枚举下来只有三处：通知发送点（已集中）、一个新的独立 bridge 模块、设置页的 bot 凭证配置。风险集中在 v1 的事件通道稳定性，而 v0 几乎零风险、当天可上，且立刻有感知价值（「手机上知道任务到站了」）。

---

## P0.5：任务队列 + 夜间批跑

**问题**：`runningTasks` 无全局并发上限、无排队；没有定时 / 事件触发。想「下班前排 5 个任务晚上跑」目前做不到，只能全并发或人肉逐个点。

**方案**：
- 并发配额（如同时最多 N 个 running）+ FIFO/优先级队列，超出的排队。
- 「夜间模式」：低风险 action（plan、review、dev 只读类）进白名单自动串跑；碰到需要 ack 的高风险节点（ship、写库）停下等远程确认——正好接 P0 的飞书通道。
- 后续再加 cron / 事件触发（对标 Cursor Automations、Devin Automations：定时回归、依赖巡检、CI 红了自动派单）。

**依据**：竞品速查表里「夜间批量任务队列」「cron/事件 Automations」两项 Flowship 均为空白；Devin 的 ACU 排队监控、Codex 并行任务面板都是先例。

**量级**：中～大。队列本体是中，配上调度和远程 ack 是大。

---

## P1：成本 / 漏斗度量看板

**问题**：
- `events.jsonl` 只有 `EventKind` 过程事件和 thinking `durationMs`（`types.ts` / `sdk-message-handler.ts`），**没有 token 用量**。注意：ROADMAP 声称「已记 token」，与代码不符，文档需要先纠偏。
- `ActionRecord.startedAt/endedAt`、`MRRecord.status` 数据在（`task-fs-core.ts`），但没有任何汇总视图：合并率、一次通过率、每 action 平均耗时都看不到。

**方案**：
1. 先落数据：从 Cursor SDK usage 里取 token 计入 action 级记录。
2. 再做汇总 API + 简单看板页：按 task / action 类型 / 时间段聚合 token、耗时、成本估算。
3. 交付漏斗：推进 → ack → MR 创建 → merged 的转化与滞留时长。

**依据**：企业侧 2026 年趋势是按人 / 仓 / 工单归因 Agent 成本（Lineman 等）；Cursor 团队版也有分析看板。个人用可以指导「哪类任务费钱」「哪个 action 提示词该优化」，团队推广时更是必答题。

**量级**：中。

---

## P1：收件箱扩张 + Autofix 闭环

**问题**：收件箱现在只有三类事务：待测 MR / 我的 BUG / 待回归（`mr-inbox.ts`）。而「角色事务收件箱」恰恰是 Flowship 对比竞品的差异化优势（速查表里唯一标「重合（优势）」的项），值得加注。

**方案**：
- 扩事务面：可合并但有冲突的 MR、CI 红的 MR、@我的评论、等 ack 超时的任务、临期排期。
- **Autofix 闭环**（对标 Cursor Bugbot→Autofix）：review 审出问题后一键派生 build/dev 任务去修，把 review→build 连成环。现在审完只能人肉转述。
- MR 生命周期补全：合并后自动归档任务 / 提示进入下一节点（现在 MR 状态多在 ship 时写一次，之后少有轮询）。

**量级**：每项中等，可拆开逐个上。

---

## P2：团队知识层

**问题**：skills / rules / custom-actions 全在本机 `dataRoot`，只有文件夹级导出导入（`custom-action-fs.ts`）；learn action 已退役；跨 task 复用 plan 在 ROADMAP 里但没做。知识是单机孤岛，同事排障靠人肉。

**方案**：
- 团队包：skills/rules/actions 打包 + 版本化 + 一键装（可先用 git 仓库当分发渠道，不必建服务）。
- Playbook 沉淀：成功跑通的流水线（prompt 序列 + 参数）一键存为模板，对标 Devin Playbooks/Knowledge。
- 失败模式库：常见失败自助卡，链到已有的脱敏诊断包（`diagnostics.ts`）。

**量级**：中～大，建议在有第二个真实用户时再启动。

---

## P2：Meegle 双向写回 + 分阶段模型路由

- **Meegle 写回**：现在是单向拉（story 进来、bug 扫进来），任务推进 / MR 合并后不回写 Meegle 状态。做成双向后，Flowship 才算真正「嵌入」团队流程而非旁挂工具。量级：中。
- **模型路由**：plan 用重推理模型、build/dev 用快模型，按 action 配置默认模型。竞品（Copilot / Claude Code）已有此形态，实现成本低。量级：小。

---

## 工程健壮性：meegle CLI 契约守护（来自今晚实战）

**今晚的实战教训**：bug 7049704722 没被扫出来，根因是 `readMoqlFieldValue` 按「想象中的」CLI 返回结构写的解析（裸值），而真实返回是 `{ value: { string_value: … } }` 包壳。继续排查发现同一模式的错误还有三处：`listBugStateTransitions` 不认 `transition` 键、`flattenWorkitemFields` 不认 `work_item_attribute`/`work_item_fields`、`pickNestedKeyLabel` 不认 `{id, name}` 数组。**四处全是「接口形状想当然」**，且全部静默失败（返回空/空串，不报错），用户看到的只是「收件箱是 0」。

**建议**：
1. 把今晚抓到的真实 CLI 响应存成 fixtures，解析函数的单测全部改跑真实形状（已部分完成，350/350 通过）。
2. 加一个可选的「live smoke」脚本：对真实 meegle CLI 跑一遍关键查询，校验解析结果非空——接口形状漂移时第一时间报警，而不是静默 0。
3. 解析层统一「解不出来就 warn 日志」，禁止静默吞掉。

**量级**：小，但对可靠性收益极高——收件箱这种「没出现就等于没发生」的功能，静默失败是最伤信任的。

---

## 快改清单（小而值）

| 建议 | 依据 | 量级 |
|------|------|------|
| 失败原因聚类 + 一键「重开本轮」 | 额度 vs 断网文案混在一起（`sdk-error.ts`），诊断只在 `meta.detail` | 小 |
| 按错误类型给「重试/换模型/查额度」 | 自动重试只覆盖网络（`task-runner.ts`），UI 已砍失败重试 chip | 小 |
| 「第一个 story 通关」新手引导 | 五项就绪清单（`setup-checklist.tsx`）之外仍有看板建任务、分支模板、MCP OAuth 等隐性关卡 | 中 |
| ROADMAP 纠偏 | 「已记 token」与代码不符 | 极小 |

---

## 专题调研：SDK 为什么感觉比 Cursor IDE 慢（2026-07-14 深夜补充）

结论：**体感慢是真的，且大头在 Flowship 自己的使用方式，不在模型**。官方论坛也承认 CLI/无头路径 vs IDE 的性能差距是已知待改进项（forum #153787、#142145）。按收益排序：

1. **默认每个 action 冷启新 Agent（收益：大）**：`reuseAgentDefault: false`，推进默认 `forceNewAgent`，review/custom 更是强制 fresh（`ACTION_FRESH_AGENT_DEFAULT`）。代码注释自己写着「Agent.create 冷启动也要数秒」。IDE 是同会话多轮复用。→ 把「续用 Agent」改成默认勾选（仅 review 保留强制 fresh）。
2. **巨型首包 prompt（收益：大）**：`buildSuperPrompt` 每次拼 `_super.md`(26KB) + `_shared.md`(13KB) + playbook（review 高达 46KB）+ rules + skills + 历史，首轮预填超长上下文直接拖慢首 token。→ playbook 按需加载；create 与拼 prompt 并行；续用路径只发短指令。
3. **create 前的串行准备全算进「agent 时间」（收益：大）**：worktree（fetch 30s 上限 + add 120s 上限 + 克隆 node_modules）→ MCP 健康探测（单服 6s 超时）→ 才 create → 才 send。用户点完推进长时间无输出，全被记账成「SDK 慢」。→ 探测结果缓存、worktree 提前/后台做、能重叠的重叠。
4. **模型变体与参数对齐（收益：中～大）**：SDK 必须显式指定 model；`composer-2.5` 只传 id 默认解析成 fast 变体，但若用户配了高 reasoning effort / Max Mode 就会明显比 IDE 慢。→ UI 里把 effort 标出来、默认对齐 IDE。
5. **每次 create 重新拉起 stdio MCP（收益：中）**：IDE 常驻 MCP，SDK 每冷启重新 spawn + 握手。→ 会话复用后此项自动缓解。
6. **交卷追问协议（收益：中，偶发）**：没 `submit_work` 会追问最多 2 轮，每轮是完整模型回合，偶发把墙钟时间翻倍。IDE 无此协议。
7. **环境细节**：`local.cwd` 必须是项目根（大目录扫描是论坛已验证的 CLI 慢主因）；Node ≥ 22.13 避免 HTTP/2 隐性重试。
8. 流式展示不是问题：`sdk-message-handler` 已实时 `assistant_delta` + SSE。

一句话：**先做 1+3（默认续用 + 准备工作前置/缓存），首 token 前的空窗能砍掉十秒级；再做 2（缩首包），每轮都受益。**

**用户拍板（2026-07-14 深夜）**：第 1 条不改——节点间上下文会影响 AI 判断、默认新 agent 是有意设计；第 3 条「准备工作后台做」当晚已实施：
- MCP 探测 TTL 缓存（`mcp-probe.ts`）：ok 缓 5 分钟、fail 缓 30s，`filterHealthyMcp` 热路径命中秒过；设置页 `probeMcpHealthAll` 保持真探并写穿缓存。
- worktree 后台预热（`task-runner.ts` `prewarmTaskWorkspace`）：建任务 / 重开任务后立刻 fire-and-forget 预建 worktree + 克隆依赖，走 advance 互斥锁防与秒推并发；推进时 ensure 幂等秒过。
- prompt 素材与 `Agent.create` 并行（task-runner + chat-runner）：skills / rules / identity（meegle CLI）/ gitlab 段的加载与 create 冷启动重叠。
- 验证：tsc / eslint 干净、350/350 测试通过。

**启动链路打点（同晚追加、用户拍板「打好点后面找你统计」）**：task-runner / chat-runner 各加 2 条 `[perf]` 日志（纯 console、不进 events、零行为风险）：
- `[perf] task=… start-chain workspace=…ms mcp=…ms create=…ms prompt=…ms/…KB send=…ms total=…ms`——启动链路分段耗时 + 首包 prompt 字节数。
- `[perf] task=… first-event ms=…`——send 受理到首个流事件（≈首 token）的等待、量化首包预填开销。
- 统计方式：跑几天后 `grep '\[perf\]' main.log`，即可算各段 P50/P95、验证当晚优化实效、并决定 prompt 要不要缩/缩哪。

**关于「提示词几百 KB」的澄清**：`prompts/` 目录 7 个文件合计 178KB 是**全量**；单次 run 首包只拼 `_super.md`(26KB) + `_shared.md`(13KB) + **当前 action 一份** playbook（11～46KB）+ rules/skills 摘要 + 历史列表，实测量级约 55～90KB（打点的 KB 字段会给出精确值）。V0.6.27 已从「6 份 playbook 全量注入」改成单注入，剩余压缩空间主要在 review 那份 46KB 里的历史注解与重复段。

## 当晚已交付：飞书项目集成——「去修」死路打通（bug 一键建任务）

**问题**：收件箱「我的 BUG」的「去修」按钮只会找「关联需求对应的开发中任务」，找不到就 toast「找不到对应任务、请确认」死路。但线上 bug 的 story 任务早已合并归档是**常态**——最常见的场景反而没有出口。

**方案**（复用现有链路、零新 API）：
1. `MyBugRow` 无任务分支改为 confirm 引导 →「去新建」跳 `/workitems/new?fixBug=1&name=…&url=…&bugUrl=…&storyName=…`。
2. 任务的飞书链接优先挂**关联 story URL**（新增纯函数 `buildStoryUrlFromBug` 从 bug URL 推导、带单测）——之后同 story 的 bug 再点「去修」就能匹配上这个任务、闭环成立；推不出时退 bug 链接。
3. `/workitems/new` 支持引流参数：标题预填「修 BUG：<bug 名>」、飞书链接预填、页头显示 bug 提示条；创建成功后**自动推进「修 BUG」action**（同「去修」直推链路），预置 action 被删走 `?advance=fix-bug` 深链降级，缺 apiKey/模型则停在任务页。成功后 bug 自动标已读。
4. 纯手动建任务路径（无 query）行为完全不变。

**明早验收路径**：收件箱 → 我的 BUG → 挑一个关联需求已合并的 bug 点「去修」→ 弹「新建修 BUG 任务？」→ 去新建（标题/链接已预填、有 bug 提示条）→ 选仓库点启动 → 自动进任务页开始修复。

验证：tsc / eslint 干净、351/351 测试通过（新增 `buildStoryUrlFromBug` 4 组断言）、`next build` 通过（Suspense 约束 OK）。

## 不建议做的方向

- **纯云端 fire-and-forget**：Devin/Codex 已占满这个生态位，Flowship 的差异化恰恰是 HITL + 诚实性校验 + 本地 worktree 可控。往「全自动无人管」卷是以短击长。
- **通用 IM 对话机器人**：远程 HITL 做的是「通知 + 结构化操作回传」，不是让用户在飞书里跟 Agent 闲聊写代码——那是另一个产品。
- **现在就建团队服务端**：知识共享、度量都可以先用文件 / git / 本机订阅起步，等有真实多人使用再考虑服务化。

---

## 附录：竞品功能速查（重合 / 空白）

| # | 功能点 | Flowship 状态 |
|---|--------|------|
| 1 | Autofix：审出问题再派 build | 空白 |
| 2 | 飞书/IM @ 遥控 HITL | 空白 |
| 3 | cron/事件 Automations | 空白 |
| 4 | 夜间批量任务队列 | 空白 |
| 5 | 并行子 Agent 编排 | 部分重合（有 worktree，缺编排器） |
| 6 | 分阶段模型路由 | 空白 |
| 7 | 全库上下文审 + org 规则 | 部分重合 |
| 8 | 自审→确定性校验→人审 | 重合，可显式产品化 |
| 9 | 成本/耗时/成功率度量 | 空白 |
| 10 | Meegle 双向联动 | 部分重合（有入口，缺写回） |
| 11 | Playbook/知识沉淀 | 部分重合 |
| 12 | 提测收件箱式角色入口 | 重合（优势项） |
