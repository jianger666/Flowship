# Action: build（V0.6）

> 占位符在 super-prompt 顶部已注入：`{{taskId}}` `{{taskTitle}}` `{{repoPath}}` `{{role}}` `{{roleLabel}}`、artifact 绝对路径见 super-prompt「Artifact 文件路径」段。
> 收到 `[NEXT_ACTION type=build ...]` 时翻到本段、按指令做。

---

你正在跑 ai-flow task 里的 **build action**——按 plan（有则）或用户指令写代码 + 跑 typecheck/lint、产出 `actions/<n>-build.md`。这是整段 task 里**最关键、也最危险**的 action——你要**真的改代码**。

## 准入条件（V0.6.17 起：plan 可选）

- **plan 不再是硬前置**（V0.6.17 放开）——有 plan 按 plan 工单走、无 plan 按用户指令直接改（改文案 / 修小 bug 不必先出方案）。两种模式差异见「本 action 的目标」+「执行步骤 1」。
- **分支准入分两种模式**（看「任务基本信息」段有没有「任务隔离工作区」说明）：
  - **隔离工作区模式（V0.10 默认）**：分支已由系统在 worktree 里检出好、[NEXT_ACTION] 不会注入 checkout 引导——**你不需要（也不许）自己 checkout**、直接做下面的铁律自检后开工
  - **原仓库直跑模式**：runner 在 [NEXT_ACTION ...] 头后注入一段「## 准入：build 第一动作、逐仓 idempotent checkout 分支」shell 引导、按那段命令**逐仓** checkout / 建分支：
    - 多仓 task：每仓共用同一 branch name；base 分支 = 用户建 task 时填的「线上分支」、没填则各仓自探（`git symbolic-ref refs/remotes/origin/HEAD`）
    - **idempotent**：每次 build 都会注入这段 hint、命令本身判 `if git show-ref ... then checkout else fetch + checkout -b`、多次跑不会副作用
    - checkout 失败（工作区脏 / 探不到主分支 / 仓不是 git 仓）→ 立刻 emit 简短 assistant_message 告知问题、调 submit_work 等用户处理、**不要**自己 force / reset
    - **注入的 checkout 引导末尾带一道 verify**（V0.6.20）：checkout 后会 `git rev-parse` 确认当前分支 == 目标分支、不对则 `exit 1`——看到这个 error 别忽略、当成 checkout 失败处理（停 + submit_work）

- **🔒 铁律（V0.6.20、写代码前最后一道闸、两种模式都必做）：动任何代码前、必须确认当前在本 task 的 feature 分支上**——`git rev-parse --abbrev-ref HEAD` 拿当前分支、跟「## 仓库分支配置」段里这仓的 branch name 比对：
  - 一致 → 正常往下做
  - 不一致（在主分支 / 别的 feature / 别的 task 的分支）→ **立刻停**、`ask_user` 报告「当前在 X 分支、不是目标 Y 分支、要我切过去还是你来处理」、**绝不在错分支上改一行代码**
  - **即使 checkout 引导没注入 / 没跑成功（异常情况），这道自检也必须做**——曾踩坑：agent 没收到 checkout 引导就直接在别的需求分支上改了代码、污染了那个分支

## 本 action 的目标

输入（按存在与否取舍）：
- **最新 plan artifact**（`actions/<plan_n>-plan.md`、**有则必读**）—— 需求理解 + task 清单 + 改动范围 + 业务上下文
- **最近 review artifact**（`actions/<review_n>-review.md`、**有则必读**、V0.6.17）—— 上一轮复核发现的 bug / 差异、build 要知道它提了啥（解不解决见执行步骤 1.2）
- 上一个 build artifact（如果有、`actions/<prev_build_n>-build.md`）—— 增量改动参考

输出：
1. 用户仓库（`{{repoPath}}`）里**真实的代码改动**
2. `actions/<n>-build.md`（实施日志 + 校验结果）

**改动范围**：有 plan 时**严格按最新 plan artifact 的 task 顺序和改动范围**（不在 plan 范围内的文件一行都不许动）；无 plan 时**以用户指令圈定的范围为准**（指令没点到的文件别乱动、拿不准就 ask_user）。

> **分批 build（V0.6.23）**：如果 [NEXT_ACTION] 里带了 `[BUILD_BATCHES]` 段（大需求 plan 拆了批次、用户只让你做其中几批）、则**本次范围进一步收窄到那几批对应的 task**——`[BUILD_BATCHES]` 没列的批次、即使在 plan §5 里、这次也一行都不要动。详见执行步骤 §3.0。

## 输入文件

- **plan artifact**（`<n>-plan.md` 取最大 n、**有则必读**、本 action 工单 + 业务上下文）：list `{{actionArtifactsDir}}/` 找；无 plan 时按用户指令走
- **最近 review artifact**（`<n>-review.md`、**有则必读**、V0.6.17）：上一轮复核的 bug、读取 + 「问用户修哪些」见执行步骤 1.2
- **上一个 build artifact**（如有、V0.6 同 task 多次 build 时存在）：read 拿增量上下文、避免覆盖别人改的
- 仓库根目录（实际改这里）：`{{repoPath}}`

## 严格约束（违反 = 本 action 直接 revise）

1. **改动范围受控**——超出范围的文件一行都不许动
   - **有 plan**：范围 = 最新 plan artifact §5 task 拆分的「改动」字段。发现 plan 漏了某个必须改的文件、**不要自己加**、写进 build artifact 的「偏离 plan」、让用户 ack 时拍板
   - **无 plan**（V0.6.17 直接 build）：范围 = 用户指令圈定的文件 / 模块。指令没点到的别顺手改、拿不准是否该动就 ask_user
   - **review 授权的修复**：执行步骤 1.2 里用户答应本次修的 review bug、属于已授权范围、可以改
2. **不动 .git**——不 commit、不 push、不 rebase、不 reset、不 stash
   - **例外**：原仓库直跑模式下、build action 开头 runner 注入的 idempotent checkout hint、按那段 shell 命令跑（详见上面准入条件）；隔离工作区模式无此例外（分支已检出、全程不动 git）
   - 跑完 checkout 后**绝对不再动 git**——commit / push / pr 都是 ship action 的职责、不归 build
3. **不删测试 / 配置文件**——除非最新 plan artifact 明确指定
4. **不动用户业务仓库根的 README / package.json**——除非最新 plan artifact 明确说要改
5. **不上 npm install / pnpm add 新依赖**——除非最新 plan artifact 明确批准了某个依赖
6. **不动 ai-flow 项目本身**——agent 改的是用户业务仓库（`{{repoPath}}`）、不是 ai-flow
7. **不跑下一个 action**——build action 写完 artifact 后调 submit_work 等用户 ack、拿到 approve 后等下一 action 指令（**不要**自动 review）
8. **artifact 只写本轮增量、禁止搬运上轮实现文档**——新建一个 build action 时，`actions/<n>-build.md` 的主语是「本轮做了什么 / 没做什么 / 为什么」。可以引用上一轮 build（如「沿用 build #14」），但不要把上一轮的 Task 完成情况、实现细节、验收清单整段复制过来伪装成本轮产出。

## 执行步骤

### 1. 读上游 artifact

用 SDK 内置 `read`、先 `glob` 或 `shell ls` 看 `{{actionArtifactsDir}}/` 里有哪些 artifact、再按下面取舍：

**1.1 plan artifact**
- 有 `<n>-plan.md`（取 n 最大）→ **read**、当工单（吸收点见下）
- 没有 plan（V0.6.17 直接 build）→ 跳过、改动范围以「用户指令」为准；指令含糊到圈不出范围就先 `ask_user` 问清楚再动手、别瞎改

**1.2 最近 review artifact（V0.6.17）**
- 有 `<n>-review.md`（n 最大、且比上一个 build 新）→ **read**、看它列的 🔴 阻塞 / 🟡 建议
- review 的 bug **不一定本次都要解决**——解不解决是**用户**的决定。流程：
  - **先排除已有定论的**（两个来源）：① review artifact 的「### 用户裁决」段——用户在 review ack 时已表态「不改 / 延后」的；② 历史 build artifact 留痕——之前 build 弹窗里选「跳过」的。这两处已否决的 bug **不要再问**（否决过一次就是否决了、重复问 = 骚扰）
  - 剩下**还没决定过**的未解决 🔴/🟡 → 用 `ask_user` 问「本次 build 修哪些？」（options：全修 / 只修 🔴 / 本次跳过 / 我挑几条）
  - 按答案纳入本次范围、没让修的别动、并在 build artifact 留痕「review 的某 🟡：用户选跳过」（给下一次 build 看、形成「决定链」、避免重复问）
- 没 review、或 review 比上一个 build 旧（已被消化）→ 跳过本步

**1.3 上一个 build artifact**
- 有（V0.6 多次 build）→ read 拿增量、避免覆盖别人改的；**只吸收上下文，不复制正文**。本轮 artifact 要写「相对上一轮新增 / 修改 / 决策」，而不是重写上一轮完整实现。

关键吸收点（来自 plan artifact、无 plan 时跳过本段）：

- §1「需求理解」+ §2「业务规则 / 文案 / 状态」：业务上下文（含 plan agent 内联的 `> ✅ ask_user 已确认：xxx` 用户拍板点、按这个口径走、不要回退到原文）
- §3「涉及接口（跨后端边界）」：本 action 调用的接口清单
- §4「关键技术决策」：决策点已经拍板、按结论实施、不要二次质疑
- §5「Task 拆分」：执行顺序 + task 自带的验收点（验收点直接对应每个 task、不再有单独的「验收对照」表）
- §6「待澄清 / 不确定项」：用户 deferred 或答「你定」按 default 走的、本 action 实施时按 plan 的 default 走、有阻塞才 ask_user

> **PRD / 飞书原文需要现查时**：plan 不复述 PRD、所以业务背景细节直接看 SDK Run 上下文里 plan agent 已经读过的 contextDocs；找不到时用可用的飞书工具（`feishu-mcp` / `feishu-project-mcp`、没配 MCP 就用内置 `lark-cli` / `meegle` CLI）再拉一次（少量 token、可接受）。

### 2. 验证仓库脚本（编译 / 类型检查 / lint）

先按仓库技术栈找到实际可用的「编译 / 类型检查」和「lint」命令、以仓库实际配置为准（plan 不再推测命令清单、build 自己查准）：

- **JS / TS 仓**（有 `package.json`）：读 scripts，typecheck 如 `pnpm typecheck` / `pnpm tsc --noEmit` / `npm run type-check`、lint 如 `pnpm lint` / `pnpm eslint`
- **Java（Maven）仓**（有 `pom.xml`）：编译如 `mvn -q compile`、检查如 `mvn -q checkstyle:check`（若配了）
- **Java（Gradle）仓**（有 `build.gradle`）：编译如 `./gradlew compileJava`、检查如 `./gradlew check`
- **其他技术栈**：看 README / CONTRIBUTING / Makefile 找编译 + 静态检查命令

> ⛔ **跑 lint script 前先 `read` 看它真正是什么**（共享规范 §9）——很多仓库 `lint` script 内部带 `--fix`（真实事故：某 Angular 仓 `npm run lint` = `ng lint --fix=true`、把整仓自动改花、停止后还在后台 orphan 继续改）。**看到 `--fix` / `--write` 就不跑**、校验只用只读命令（typecheck / `tsc --noEmit` / 不带 fix 的 lint）。也不要起 dev server / `--watch`（长驻、挂死 Run）。

> ⚠️ **不要跑全量 build / 打包命令**（如 `pnpm build` / `vite build` / `mvn package` / `gradle build`）—— 这类通常耗时几十秒到几分钟、上面的类型检查 / 编译已覆盖大部分错误、全量打包边际收益低、ROI 不值。除非用户在 plan / 反馈里**明确要求**、否则跳过。

### 3. 按计划执行（有 plan 按 task 顺序、无 plan 按指令拆步）

- **有 plan**：按 plan §5 的 task 顺序逐个做
- **无 plan**：把用户指令拆成几个小改动步骤、逐步做（每步同样「改一处 → 局部校验」、别一把梭）

**3.0 分批 build（V0.6.23、仅当 [NEXT_ACTION] 带 `[BUILD_BATCHES]` 段时）**：

大需求 plan 会拆「批次」、用户在推进 build 时只勾本次要做的几批。这时 [NEXT_ACTION] 里有一段 `[BUILD_BATCHES]`、列了本次该做哪些批次（含每批的标题 / 测试策略 / 含哪些 task）：

> **变体（V0.6.29）**：`[BUILD_BATCHES]` 也可能标「**本次 build 不绑定批次**」（用户没勾批次 = 自由改动、常见于回头修 bug / 跨批次散改）——这时范围以用户指令为准、**不要顺手开做未完成批次**、artifact 总览「本次完成批次」写「无（自由改动）」、按段内随附规则走、下面的批次规则不适用。

- **只做 `[BUILD_BATCHES]` 列出的批次对应的 task**——plan §5 里属于其它批次的 task、这次一行都不要碰（下次推进别的批次时再做）
- **按每批的「测试策略」走**：
  - `tdd`（先写测试）→ 对这批的核心逻辑：**先写测试、跑一遍看它失败（红）→ 再写实现让测试通过（绿）**。测试放仓库现有测试目录 / 同级 `__tests__`、用仓库现有测试框架（jest / vitest / junit 等、先 `read` 配置确认）
  - `after`（实现后测试）→ 先实现、再对关键路径补测试
  - `none`（免测）→ 跳过测试、正常实现即可
  - 仓库**没有任何测试设施**（没装测试框架 / 没测试目录）→ `tdd`/`after` 退化成「正常实现 + 在 build artifact 写明该测什么 / 为什么没法自动测」、**别为了凑测试硬装框架 / 改仓库测试配置**
- build artifact 总览里**写明「本次完成批次：<id 列表>」**——给人 / review 交叉核对用（整体进度 + review 增量 / 集成范围是系统按你勾选的批次自动推导的、**不解析这行文本**、但写清楚便于人工对账）

> 没有 `[BUILD_BATCHES]` 段（小需求 / plan 没分批）→ 跳过本步、按下面的常规流程做全部。

每个 task / 步骤的循环：

```
read 涉及到的文件 → 心里盘清楚改动 → edit / write 改动 →
（如有 shell 命令的 task：shell 执行 + 记录输出）→
跑该 task 涉及范围的 lint / typecheck（局部验证）→
下一个 task
```

**SDK 工具选择（改业务代码）**：

- **改已存在的代码文件** → 用 `edit` 工具、args `{ path, oldText, newText, replaceAll? }` 或 `{ path, edits: [...] }` 批量
- **创建新的代码文件** → 用 `write` 工具、args `{ path, fileText }`
- **删除文件** → 用 `delete` 工具
- **跑命令** → 用 `shell` 工具

**写 build artifact** → 见「跨 action 共享规范 §1 artifact 写入工具」。

每个 task 改完后、在 build artifact 里追加该 task 的实施记录。

> **增量 build 写法（V0.6.26 起强制、V0.6.29 加布局规则）**：
>
> - **布局（V0.6.29、用户拍板）**：本轮真动过的 task **置顶详写**（紧跟「本轮处理结论」）；没动的 task **不要按 plan 顺序逐个占标题穿插**、统一收拢到「Task 完成情况」末尾的「### 沿用 / 未触及」一行清单里——否则本轮增量被夹在一堆「沿用」中间、用户找不到这轮到底改了啥。
> - **沿用引用写成行内代码**：`build #18`（带反引号、空格 + #）或 `actions/18-build.md`——UI 会渲染成可点击跳转到那个 action、裸文本「沿用 build #18」跳不了。
> - 本轮如果真的改了代码：artifact 重点写本轮改了哪些文件、解决了哪条用户反馈 / review 建议、相对上一轮有什么变化。
> - 本轮如果评估后决定**不改代码**：artifact 必须在总览和单独段落里明确写「本轮无代码改动」，列出依据（例如 review 判定非阻塞、用户已授权某取舍、当前代码已满足），并记录验证命令。不要把上一轮 build 的实现清单整段搬过来。
> - 无代码改动时必须写清「有效实现来源」：例如「有效实现沿用 build #14（`actions/14-build.md`），后续 review / ship 请读取该 build 作为代码改动来源」。否则后续 action 只读到“无改动”会丢失真正实现上下文。
> - 有效实现来源必须是真正改过代码的 build，或者能继续追溯到真正改过代码的 build；如果上一个 build 也是“无代码改动”，沿链继续找，直到找到「本 build / 有代码改动」的来源。
> - 找不到有效实现来源时，不要把批次写成完成；artifact 明确写「本轮未产生代码改动，且未找到可沿用的有效实现来源」，在 `## 没解决的问题 / 偏离` 里标为未完成，等待用户决定。
> - 区分两个概念：`本轮代码改动=无` 不等于 `工作区无改动`。如果工作区仍有旧改动，要写「工作区现存改动来自 build #N，本轮未新增代码改动」，避免后续 ship / review 误判。
> - 旧任务完成情况只能一句话引用（收进「### 沿用 / 未触及」清单、如「Task 2：沿用 `build #14`」），不要重复粘贴旧的关键实现 / 验收处理。否则用户会误以为这轮又实现了一遍，review 也无法判断本轮增量。

### 4. 全量校验

所有 task 完成后、用 SDK 内置 `shell` 工具跑 §2 查到的命令（全量）：

- 类型检查 / 编译（如 typecheck / `mvn compile` / `gradlew compileJava`）
- Lint / 静态检查（若仓库配了）

每条命令的退出码、关键 stdout/stderr 摘要、记到 build artifact。

**有编译错 / 类型错 / lint 错 = 必须修**。这是用户对低级错误零容忍的硬约束。

> ⚠️ **不跑全量 build / 打包命令**——见 §2 段尾说明。除非用户在 plan / 反馈里明确要求、不跑 `pnpm build` / `vite build` / `mvn package` 等。

### 5. 写 build artifact

写到绝对路径：

  `{{actionArtifactsDir}}/<n>-build.md`

`<n>` 是从 [NEXT_ACTION] 头里拿的 action.n。artifact 写入工具用法见「跨 action 共享规范 §1 artifact 写入工具」。格式按下面骨架。

### 6. 调 `submit_work` 交卷、结束回复

参数：
- `task_id={{taskId}}`
- `action_id=<本 action 的 id>`
- `artifact_path=actions/<n>-build.md`

拿到 `[SUBMITTED]` 后**立即正常结束本轮回复**。用户的下一步会以新消息送达：

- `[ACTION_ACK revise]` + feedback → 按 super-prompt「revise 闭环」分 2 类：**问类**（纯疑问句）→ 直接 emit assistant_message 答疑、不弹窗、不动代码 / artifact；**改类**（其他、含模糊兜底）→ 先弹 ask_user 复述「我打算改 X、对吗？」、用户 ✅ 才动代码、改完代码后**用 `edit` 把本轮修正追加到 build artifact 的 `## 修改记录` 段末尾**（格式 / 禁项见「跨 action 共享规范 §5.1」）；带图先 read 图再分类。处理完再调一次 `submit_work`（同 action_id + artifact_path）重新交卷、结束回复
- `[NEXT_ACTION ...]` → 用户推进下一 action（= 认可本产出、UI 没有单独「通过」按钮）、按新指令执行、**绝对不自动进入 review**——下一个 action 类型由用户在 UI 选

## 自检（V0.6.3 起：runner 不再自动跑后置检查、build 质量靠你自检 + 用户人眼把关）

> V0.6.3 撤掉了 runner 的自动后置检查（原来写死 `pnpm typecheck` / `pnpm lint`、对多技术栈如 Java 会误报、后面会重做成技术栈自适应 / 独立 check）。现在 build 的质量门槛**由你自己保证**：

1. **§4 的类型检查 / 编译必须 exit 0**——不过就当场修、修到过为止（用户对低级错误零容忍）
2. **lint / 静态检查（若仓库配了）exit 0**——同上
3. **`git status --porcelain` 真有改动**——确认你真写了代码（不是 artifact 写满但 git 没动）

把每条结果如实记进 build artifact、让用户 ack 时能核对。

## build artifact 骨架

> 下面骨架里的命令 / 文件名是 JS/TS 仓示例（`pnpm` / `.ts`）、**按你仓库实际技术栈替换**（Java：`mvn` / `gradle` / `.java`、Go：`go` / `.go`）。
> **重要**：本骨架记录的是「本轮 build action 的增量产出」。多轮 build 时，不要复制上一轮 build artifact 的完整 Task 完成情况；只写本轮新增 / 修改 / 不改决策，旧实现用「沿用 build #N」引用即可。

```markdown
# 编码实现：<story title>

## 总览

- 本次完成批次：<如 b1 / b2；未分批时写「全部（未分批）」；[BUILD_BATCHES] 标了「不绑定批次」时写「无（自由改动）」>
- 本轮处理类型：<首次实现 / 修 bug / 响应 review / 评估后不改>
- 本轮代码改动：<有 / 无；无则写清「无代码改动」>
- 有效实现来源：<本轮有代码改动写「本 build」；本轮无代码改动写「沿用 build #N（actions/N-build.md）」；找不到写「未找到、不能视为完成」>
- 工作区改动归属：<本轮新增 / 沿用 build #N 的未提交改动 / 无工作区改动>
- 改动文件数：<本轮实际改动文件数；无改动写 0>
- 全量校验：lint=<pass/fail>、typecheck=<pass/fail>、测试=<pass/fail/skip>
- 偏离 plan：<有 / 无、详见下文>

## 本轮处理结论

<用 2-5 条写清本轮相对上一轮新增了什么；如果无代码改动，写清为什么不改、依据来自哪条 review / 用户反馈 / 当前代码事实。>

## Task 完成情况

> 本段仅记**本轮涉及的 task 增量**（5 个字段：改动文件 / 关键实现 / 偏离 plan / 验收处理 / 局部校验）。
> ⛔ 后续用户反馈触发的修正一律汇到末尾 `## 修改记录` 段、**不要在 task 子条里塞「revise」「revise 修复」「修复」「修正」「补丁」之类的子字段**——这是初稿段、不是 fix 段。
> ⛔ 多轮 build 时，不要复制上一轮已经完成的 task 详情、也**不要按 plan 顺序给每个沿用 task 单开标题**——本轮动过的 task 置顶详写、没动的统一收进本段末尾「### 沿用 / 未触及」清单（V0.6.29 布局规则、见上文）；本轮无代码改动时，本段只列「评估结论」，不要铺旧实现。
>
> ⚠️ **「改动文件」字段路径写法**：每个文件**必须**写从仓库根 `{{repoPath}}` 起算的完整相对路径（详见「跨 action 共享规范 §3」）、不要简写成 basename。

### Task 1：<名字>（✓ 完成 / ✗ 失败 / ⚠ 部分）

- **改动文件**：
  - `apps/cp-class-advisor-center/src/api/sc.ts`（+12 / -0）
- **关键实现**：
  - 新增 `promoteTask` 函数、走仓库统一 axios 实例
  - 错误码遵循仓库 `ApiError` 约定
- **偏离 plan**（如有）：
  - 无 / 或：「plan 写错误处理用 try/catch、但仓库统一拦截已做、所以直接 throw」
  - ⚠️ **本轮如果是用户指令 / 产品反馈触发的改动**（plan 没列、是 ack 时 / 新一轮里用户让加 / 改的）、务必写清来源：「按产品反馈：xxx」「用户指令：xxx」——review 阶段据此判「已授权变更」、不再重复问用户（V0.6.10、不写来源会被当成无据偏差重新问一遍）
- **验收处理**（逐条对应 plan §5 该 task 的「验收点」、说明每条是否满足 + 如何验证）：
  - ✅ 参数符合接口文档 § 1.2：手测 payload 跟 swagger 对比
  - ⚠ 返回数据兜底分支：mock 接口已 cover、待联调
- **局部校验**：
  - `pnpm eslint src/api/sc.ts` → pass
  - `pnpm tsc --noEmit` → pass

### Task 2：...

### 沿用 / 未触及（增量轮才有本小节、首轮全做时省略）

- Task 1 / Task 2 / Task 4：沿用 `build #18`、本轮未改
- TaskInfo 定级编辑：沿用 `build #18`、本轮未改

## 全量校验

| 项 | 命令 | 退出码 | 关键输出 |
|---|---|---|---|
| Lint | `pnpm lint` | 0 | 0 errors, 0 warnings |
| Typecheck | `pnpm tsc --noEmit` | 0 | （空、pass）|

## 没解决的问题 / 偏离

如有 task 没完成、写在这里、并说明原因（让用户在 ack 时决策是 revise 还是放过去）。

- T5 未完成：依赖后端接口字段未确认（见 plan artifact「待澄清 / 不确定项」#2）、改用 mock 提交、待联调
- 偏离 plan #1：plan 指示在 `BaseDialog` 上派生新组件、实际发现仓库已经有 `PromoteDialog` 历史残留、复用而不是新增、避免重复

## 修改记录

> **何时写本段**：仅当用户 ack 时点「再聊聊」后、按用户反馈做了修正——追加到本段。初稿走 happy path 整段省略（不写空标题）。
> 详细格式 / 禁项见「跨 action 共享规范 §5.1 build / review / ship action」。

### 修改 1：<一句话标题（25 字以内）>

- **用户反馈**：<feedback 原话核心语义、20 字以内>
- **改动文件**：
  - `apps/cp-class-advisor-center/src/views/mainHome/selList.vue:271-279`
  - `packages/tch-sc/src/components/PromoteTaskDetail.vue`
- **概要**：1-2 句说明改了什么、为什么改

### 修改 2：...
```

## 几条要点

- **改之前先读**：每个文件改之前先 `read` 完整看一遍、不要凭印象改
- **小步走、改一个 task 跑一次局部 lint**：避免大堆错误堆到最后才发现
- **保持仓库风格**：缩进、命名、import 顺序、注释风格 → 全跟周围现有代码一致
- **不发明 import 路径**：用 `grep` / `read` 确认 import 路径真存在
- **TypeScript strict**：仓库一般开了 strict、不要写 `any`（除非局部有非常充分的理由）
- **不写无信息密度的注释**：「调用接口」「返回 null」这种废话注释不要加。中文注释、解释「为什么」不解释「是什么」
- **跑 shell 慢的命令**：`pnpm install` / 全量 build 可能耗时几分钟、agent 不要因为「等太久」就放弃、shell 工具有 timeout 参数、合理放宽
- **写完 → 给 1-3 句简短结论 → 调 submit_work**：结论说清「改了哪几个文件 / 实现了什么 / typecheck·lint 过没 / 有无遗留」（流式、简短、别长篇复述）；别说「我改完了你看下」这种没信息量的空话、也别说完忘了调 wait（详见 super-prompt 关键规则 1）
- **绝对不自动进入下一 action**：build 交卷后结束回复、不要自己跑 review / ship——下一 action 类型由用户在 UI 选
- **分批 build 只做被指定的批次**：[NEXT_ACTION] 带 `[BUILD_BATCHES]` 时严守本次批次范围、别顺手把别的批次也做了（那样 review / 进度推导就乱了）；artifact 总览记清「本次完成批次」
