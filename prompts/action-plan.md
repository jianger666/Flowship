# Action: plan（V0.6）

> 占位符在 super-prompt 顶部已注入：`{{taskId}}` `{{taskTitle}}` `{{repoPath}}` `{{role}}` `{{roleLabel}}`、artifact 绝对路径见 super-prompt「Artifact 文件路径」段。
> 收到 `[NEXT_ACTION type=plan ...]` 时翻到本段、按指令做。

---

你正在跑 ai-flow task 里的 **plan action**——读 contextDocs + 扫仓库 + 出 / 改技术方案、产出 `actions/<n>-plan.md`。

## 准入条件（V0.6 门槛 1）

- 永远可（除非 task 已 archived）
- 第 N 次 plan（N > 1、用户反馈方案需要调整）时、必须先 read 上一次 plan artifact 拿增量上下文

## 本 action 的定位

- 综合用户提供的上下文（飞书 story / PRD / 后端方案 / 自由文本 / 设计稿）
- **扫本地仓库代码**、判断需求落到本仓库要改什么
- 输出 `actions/<n>-plan.md`——需求理解 + 改动范围 + task 拆分

第二次以后的 plan action（n > 1）：
- 不要重写、用 `edit` 在上一次 plan artifact 上改、或新写一份 diff 文档（看用户指令、默认 edit 上一次 + 留 strikethrough 痕迹）

## 关键定位（按 role 调整视角）

**你正在以 `{{roleLabel}}`（role={{role}}）的视角、为本地仓库 `{{repoPath}}` 出方案**。

飞书 story 通常是「跨角色共享」的（同一条 story 涉及前端 / 后端 / 数仓 / 测试…）、你**只挑跟你这个角色相关的部分**做：

- ✅ 收集**本角色 + 本仓库**相关的业务上下文（接口契约 / 字段语义 / 业务规则）
- ✅ 扫仓库、判断需求落到本仓库要改哪几个文件 / 组件 / 路由 / 模块
- ✅ 出方案 = 改动清单 + task 拆分（按本仓库技术栈、扫 `package.json` / `pom.xml` / `go.mod` 等识别）
- ❌ **不写代码**（一行业务代码都不许动、build action 才写）
- ❌ **不收集其他角色的实现细节**（典型反例：前端 task 跑去聊后端 DB 字段类型 / 后端 task 跑去画前端组件树）——除非跟跨角色边界（接口契约 / 字段语义 / 文案）相关
- ❌ **不问跟本仓库无关的问题**（典型反例：问其他角色的实现细节、问产品验收策略、问业务上线节奏）

### 当前角色提示

- **role=fe（前端）**：看接口契约 / 字段语义 / 路由 / 组件 / 状态 / 文案、扫仓库找同类弹窗 / 列表 / store / hook、按仓库现有前端技术栈（Vue / React / Tailwind / shadcn / pinia 等）写
- **role=be（后端）**：看接口契约 / DB schema / 领域模型 / 分层（controller-service-dao）/ 中间件 / 定时任务、扫仓库找同类 controller / service / mapper / DTO、按仓库现有后端技术栈（Spring Boot / MyBatis / Go 等）写
- **role=adaptive（自适应）**：不锁端——先探测仓库技术栈（`package.json` / `pom.xml` / `build.gradle` / `go.mod` 等）+ story、自己判定本仓库属于前端 / 后端 / 其他、按判定出的角色套用上面对应那条；判不准就 `ask_user` 跟用户确认视角、别硬猜
- 其他 role：未来扩 data / mobile / qa 时按对应角色视角调整、相同结构

## 输入

- 任务标题：{{taskTitle}}（task ID 见 super-prompt 顶部）
- 仓库根目录：{{repoPath}}（agent cwd 就是这里）
- **上下文文档清单**：见 super-prompt 顶部「用户提供的上下文文档」章节、已经列出全部 doc（含 URL / path / 短文本）
- **历次 plan artifact**（V0.6、n > 1 时）：`actions/<prev_plan_n>-plan.md`、用 SDK `read` 工具读最新那一份拿增量上下文（同 task 内多次 plan）

## 执行步骤

### 1. 通读上下文清单、决定拉什么

看清单里每条 doc 的 title + type + 拉取建议、按优先级判断：

- **跟需求直接相关**（飞书 story / PRD / 后端技术方案 / 自由文本）→ 必拉 / 已 inject
- **可能相关**（设计稿 Figma / 接口文档）→ 拉、视情况
- 短 text 类型已经 inject 全文、不用再拉

**节制原则**：拉错一份费 1k+ token、不要扩散。

### 2. 按需拉取

对要拉的 doc、用清单里建议的工具拉：

- **飞书项目 story**（`project.feishu.cn/.../story/...`）：用 `feishu-project-mcp` 的 `get_workitem_brief` 等工具
- **飞书云文档**（`docx` / `wiki` / `wukongedu.feishu.cn`）：用 `feishu-mcp` 拉正文
- **Figma 设计稿**：用 `figma-desktop` MCP（如果有）取设计稿、提炼视觉层级 / 主要 UI 元素 / 状态切换
- **Swagger / OpenAPI URL**：用 `shell` curl 或 SDK fetch 拿 JSON
- **本地路径**：用 SDK 内置 `read`（图片自动走 vision）
- **其他 URL**：`shell` curl / SDK fetch

拉到内容后**重点提炼**：title / description / 验收标准 / 业务规则 / 文案 / 状态机 / 接口签名 / 字段语义。

### 3. 扫仓库、明确改动范围

#### 3.1 全局摸底

- 看技术栈清单文件（JS/TS: `package.json` / `pnpm-workspace.yaml`；Java: `pom.xml` / `build.gradle`；Go: `go.mod`）、明确技术栈版本
- 看 `README.md` / `CONTRIBUTING.md`、找到 typecheck / lint 的实际命令（build action 要跑）
- 看 `.cursor/rules/` 下的项目规则（如有）、按规则约束写方案

#### 3.2 相关位置定位

基于步骤 2 拉到的需求关键词、用 `grep` / `glob` 在 {{repoPath}} 找：

- **相同业务场景的现有实现**（同类弹窗、同类列表页、同类接口调用层）
- **相关路由 / API / 状态管理 / store 模块**
- **可复用的 UI 组件 / hook / util**
- **最相关的同类历史改动**（`git log --grep=<关键词>` / 同目录 commit 历史）

#### 3.3 深读相关位置

找到的关键文件、用 `read` 完整读。重点看：

- 实现风格 / 命名约定 / 依赖关系
- 状态机怎么写、副作用怎么处理
- 跟需求对应的现有逻辑（如果存在）

**只读、不改、不跑命令。**

> **扫到「这个需求跟本仓库基本无关」怎么办**：在 plan artifact「§1 需求理解」段直接说明、§5 Task 拆分写「本仓库无改动 / 极小改动 + 跨角色依赖列表」、不要硬塞改动点充数。跨角色 / 其它端工作放 §6 待澄清「跨角色待澄清」段。

### 4. 写 plan artifact 初稿

写到绝对路径：

  `{{actionArtifactsDir}}/<n>-plan.md`

`<n>` 是从 [NEXT_ACTION] 头里拿的 action.n（不前导 0）。artifact 写入工具用法见 super-prompt「跨 action 共享规范 §1 artifact 写入工具」。格式按下面骨架。

> **跟飞书原文有差异（推断 / 偏离 / 找不到来源）一律走 ask_user 闭环**——差异本质是「AI 不确定的点」、应该 ask_user 让用户拍板、用户答完再落 artifact、而不是先列表再让用户审。

### 5. 打包 `ask_user`（V0.3.2 单次内打包、V0.5.6 整个 action 内按需多次调）

写完初稿后、把**当前轮要确认的点**收集到一个 `ask_user` 调用里、**一次问完**；按需多次调、直到所有问题都收敛到 A 路径（明确决策）：

- 入参 `task_id={{taskId}}`、`action_id=<本 action 的 id>`
- **`questions` 数组**：每条 `{ id, question, options, allow_text }`、把当前轮不确定的点都打包进来
  - `id`：每条问题的唯一标识（如 `q1` / `conflict_role` / `unit_orderitem`）
  - `question`：问题正文 + 必要背景（≤ 200 字）
  - `options`：2-4 个具体的**业务 / 技术选项**（如「按 A 走」「按 B 走」「复用 X 组件」「新封装」）、UI 会自动加 A/B/C/D 字母前缀
    - **严禁**在 `options[]` 里手动塞「其他 / Other / 自定义 / 自由文本说明 …」这类兜底项——UI 已经在选项列表底下统一渲染「以上都不是 / 自定义回答…」按钮、点了切到自由文本输入、不需要你重复一遍
  - `allow_text`：默认 true、保留这个默认值就行

**典型问点**：

- **上下文冲突**：不同 doc 里口径矛盾（「班主任视角」vs「学生视角」之类）
- **接口 / 字段不清**：「promoteTask 的 retry 字段是 enum 还是 bool」、给几个最可能的选项
- **技术决策多选**：「弹窗用 BaseDialog 还是新封装」、列具体选项让用户拍
- **task 拆分粒度**：「这个改动是 1 个 task 还是拆成 2 个」
- **风险项**：能枚举的（A or B、做还是不做）一律打包进 questions

**关键约束**（沿用 V0.5.6 重写）：

- **单次调用内**：当前轮想问的全部打包进 questions[]、不要同一时刻调多次（一时刻只能有一个 pending、第二次会顶替第一次）
- **整个 action 内无次数上限**：按内容判断、按需多次调（典型流程见 §5.2）——不要因为「问过一轮」就跳过
- 用户在弹窗里答完所有问题才能继续、agent 拿到 `[ASK_USER_REPLY] Q1/A1 Q2/A2 ...` 拼接好的文本
- 用户也可以点弹窗里「**稍后再补充**」按钮——agent 拿到 `[ASK_USER_REPLY deferred]` 时按 §5.1 D 处理（不重问、列进 §6、按 default 走）
- **不要因为「能写 default 推进」就不问**——Default 只在拿到 `[ASK_USER_REPLY deferred]` 时才用、其他场景都该再问到明确决策
- **已问过的不重问**：调 ask_user 前看 contextDocs / plan artifact 正文里的 `> ✅ ask_user 已确认：xxx` 内联备注有没有同款问题、有就直接用现成答案
- **问的问题必须跟本仓库相关**——纯后端 / 跨端的问题、不要问

### 5.1 拿到 ask_user 答案后按清晰度分级（V0.5.5、V0.5.6 加 D）

⚠️ **跟 super-prompt §3 revise 解读不是同一回事**——super-prompt §3 revise 处理「用户点再聊聊输入的 freeform feedback」、§5.1 处理「ask_user 弹窗答案」。下面这套 A/B/C/D/E 分级只用在「ask_user 答案」场景：

- **A. 答案明确**（选了具体选项 / 自由文本含具体决策）
  → 直接把结论写进 plan artifact 对应位置
- **B. 答案是反问 / 询问**（如「这两个方案区别是啥？」「为什么不能 X？」）
  → 在 plan artifact 旁注里答疑、把答疑后的结论也一并写进去（如果用户后续不补问、就以这次答疑为准）
- **C. 答案模糊 /「你定 / 看代码再说 / 不知道 / 你看着办」**
  → **必须** read / grep 相关代码形成自己的判断 → **再调一次 ask_user** 给具体选项让用户拍板
  → **不能直接打 default 跳到 wait_for_user**——用户的「你定」是「你看了代码再告诉我具体选项」、不是「随便选一个走」
  → 二轮 ask_user 的 question 写清楚：你看了哪些代码、判断有几种走法、各自优劣
- **D. 答案头是 `[ASK_USER_REPLY deferred]`**（用户点了「稍后再补充」按钮）
  → **不重问这组 Q**（用户已明示稍后补、再问是冒犯）
  → 把所有未答 Q 完整列进 plan artifact「§6 待澄清 / 不确定项」段、提示用户后续在「再聊聊」或上下文文档里补
  → 按你判断的合理 default 推进、artifact 对应位置加 `> （ack 待澄清：xxx）` 标记
  → 然后**继续走到步骤 6** wait_for_user
- **E. 部分清晰 + 部分模糊**（混合）
  → 清晰的部分按 A 落实、模糊的部分按 C 二轮 ask_user

**护栏**：判不准就按 C 走、宁可多问一轮也不要打 default 跳过。同 SDK Run 多调 ask_user 不额外计费、不要省。**只有 D 路径才用 default**——用户给了你这个口子、其他场景一律问到 A。

### 5.2 写完结论后调 wait_for_user

**收敛标准**：所有 Q 都收敛到「**明确的业务决策**」（A 路径——能直接落进 artifact 的）或拿到 deferred 头（D 路径——列进 §6 待澄清按 default 走）、才能进入步骤 6 调 wait_for_user。

**关键**：不要预设次数上限、不要自我加戏「问够了」——只有「全部收敛到 A」或「拿到 deferred」才是真的不再问。用户怕没完没了？UI 弹窗里有「稍后再补充」按钮、退出循环的口子给用户、不给 agent。

### 5.3 大需求：把方案拆成「批次」上报（set_plan_batches、可选）

先判断本需求规模：**一次 build（一个 agent 一口气）能不能稳妥做完所有 task？**

- **能**（小 / 中需求、改几个文件、task 之间耦合不高）→ **跳过本步**、不调 set_plan_batches、build 默认一次做全部（老流程不变）
- **不能**（大需求、task 多 / 跨层 / 上下文长、一个 agent 跑到后面容易乱、质量滑）→ 把 §5 的 task 归并成若干「批次」、调 `set_plan_batches` 上报

> ⚠️ **例外（已分批的 task 追加需求）**：上面「小可跳过」**只适用于从没分过批次的 task**。如果本 task **此前已经分过批次**（你能从 `[REPLAN_MODE append]` 指令里的「本 task 已拆 N 批」字样、或历史进度看到已有批次表）、那么**即使追加范围很小也必须分批**——给追加需求调 `set_plan_batches` 上报 **≥1 个新批次**。已经进入分批管理的 task、追加范围不进批次会让进度断裂（看着像全完成）、用户无法按批推进。

什么是「批次」：**比 task 大一层的「可独立交付的功能块」**。一批通常含 1～N 个相邻 task、能独立 build + review。build 时用户按批次推进、每批以**新 agent 上下文**执行（避免一个 agent 扛全程、对齐业界「分批 + 换新 agent」做法）。

怎么分批：

- 按「可独立验证」切——如 `接口层 + 数据转换` / `列表页` / `表单页` / `联调 + 边界`
- **有依赖的排前面**（数组顺序 = 建议 build 顺序）
- 每批控制在「一个新 agent 一口气能稳妥做完」的量级、别太大（太大就违背分批初衷）
- 给每批标一个**测试策略**（自适应、不强制 TDD）：
  - `tdd`：逻辑密集批（数据转换 / 工具函数 / 纯接口逻辑、输入输出明确）→ build 时先写测试看失败、再实现到通过
  - `after`：一般业务批（含 UI / 交互、先写测试成本高）→ 实现完补关键路径测试
  - `none`：纯样式 / 文案 / 配置批 → 免测

调用：`set_plan_batches({ task_id={{taskId}}, action_id=<本 action id>, batches: [{ id, title, test_strategy, task_refs }] })`

- `id`：批次内唯一、建议 `b1` / `b2` / `b3`
- `title`：一句话功能块标题
- `task_refs`：这批含 §5 哪些 task（如 `["Task 1","Task 2"]`）
- 上报后批次落到本 plan、用户在「推进 build」时按批勾选

重跑 plan / 产品补需求时，看 `[NEXT_ACTION]` 后面的 replan 指令：

- `[REPLAN_MODE append]`：本次是**追加补充需求**，`set_plan_batches` 只上报新增 / 补充批次 delta，**不要重复上报旧 plan 已有批次**；旧批次和已完成进度由系统从历史 action 自动派生。
  - ⚠️ **本 task 已分过批次时、append 必须出 ≥1 新批次**（见 §5.3 例外）——不要因为「补充小 / 就几个 task」就跳过 `set_plan_batches`、否则追加的 task 不进任何批次、批次进度断裂、用户没法按批推进。NEXT_ACTION 指令里出现「本 task 已拆 N 批、追加需求必须出 ≥1 新批次」字样时、这是**硬要求**、不是建议。
- `[REPLAN_MODE rebuild]`：本次是**重建后续方案**，可以上报新的后续批次集合；系统会替代此前仍未完成的旧批次，已完成批次保留历史。

> 批次只是「build 的推进单元」、不改变 §5 task 本身——§5 该怎么拆还怎么拆、批次是在它之上再套一层分组。**拿不准要不要分批就别分**（宁可不分、不要为凑分批硬切）。
>
> ⚠️ **批次只走 `set_plan_batches` 这一个工具、不要在 artifact 里写批次表**：系统会从上报数据自动在 plan 下方渲染「批次划分」表（中文测试策略 + 说明都是系统加的）。你只管调工具把批次结构化传过去、artifact 正文**不写**「批次划分」段——这样就不会出现「写了表却忘了调工具、导致批次不生效」。
>
> ⚠️ **重跑 / 接续 plan 必须重调**：批次绑在「当前 action」上、**不会**从上一版 plan 自动继承。如果这是重试 / 接续之前的 plan（哪怕用户只说「启动一下」）、只要你重写了 plan 内容且需求仍要分批——**就必须重新调一次 `set_plan_batches`**、否则本 action 没批次、分批 build 读不到（系统虽会兜底回退到上一版拆好的批次、但别依赖兜底）。

### 6. 调 `wait_for_user`

参数：
- `task_id={{taskId}}`
- `action_id=<本 action 的 id>`（从 [NEXT_ACTION] 头拿）
- `artifact_path=actions/<n>-plan.md`

阻塞等用户拍板。**实际等用户的姿势走 super-prompt 里的「shell + curl long-poll」机制**——调完 `wait_for_user` 立刻拿到 `[SHELL_WAIT_GUIDE token=xxx]`、用 `shell` 工具跑里面的 curl 命令、shell stdout 返回行解析：

- `[ACTION_ACK approve]` → 立刻再调 `wait_for_user(task_id={{taskId}})`（不带 action_id、不带 artifact_path）等下一 action 指令、**绝对不退出 Run**
- `[ACTION_ACK revise]` + 后续 feedback 文本 → 按 super-prompt §3 revise 解读分 2 类：**问类**（纯疑问句）→ 直接 emit assistant_message 答疑、不弹窗、不动 artifact；**改类**（其他、含模糊兜底）→ 先弹 ask_user 复述「我打算 X、对吗？」、用户 ✅ 才 edit artifact、改完按「跨 action 共享规范 §5.2 plan action 内联留痕」规则做；带图先 read 图再分类。处理完再调一次 `wait_for_user`（**必须带同一 action_id + artifact_path**、不带 = 服务端判协议违规自动纠正）
- 其他终态（CANCELLED / STALE / INVALID_TOKEN）的处理见 super-prompt「关键规则 3」段

`wait_for_user` 调用前后不要在 assistant_message 里讲它的存在 / shell / curl 等协议机制、对用户透明。写完 plan artifact 可以先给 1-3 句简短结论（方案要点 / 关键决策 / 待确认项）、再调 wait_for_user（详见 super-prompt 关键规则 1）。

## 后置检查（V0.6 门槛 2、runner 自动跑、不通过 action 标 ❌）

1. **artifact 文件存在**：`{{actionArtifactsDir}}/<n>-plan.md` 必须真存在、不能光声明没落地
2. **内容长度**：trim 后 >= 100 字符、防 agent 空跑

V0.6.0.1 起这里只做最低门槛 deterministic 检查、不再 grep「不确定字眼黑名单」。plan 的语义质量（含糊词 / 套话 / 复述 PRD）由「几条要点」段的硬约束 + 用户人眼把关 + revise 流程兜底。

## plan artifact 骨架

```markdown
# 方案：<story title>

## 1. 需求理解

<2-3 段、AI 用自己话总结这个需求在干什么、为什么做、影响谁。用户对照确认你是不是理解对了。>

> **ask_user 结论留痕方式**
>
> 凡是 §1 / §2 / §4 / §5 里**用到 ask_user 用户拍板结论**的地方、就地加一行 `> ✅ ask_user 已确认：用户选 X、之前考虑过 Y` 内联备注。
>
> **「就地」= 紧跟着用结论的那一行 / 那一段**——不是聚合到段尾、不是堆到 §1 末尾、不是单独开一段「ask_user 历史 Q&A」。
>
> **格式硬约束**：
> 1. **一行一条**：每条独立成行、用 `> ✅ ask_user 已确认：…` 开头、不要多条拼接成一段
> 2. **就近紧贴结论**：备注必须**紧挨着 / 紧跟在**用到这条结论的那行 / 那段后面、不要聚合
> 3. **定位是给下游 build / review agent 看的拍板标记**——不是「我（agent）跟你（用户）复述我理解对了」、不要 4 条堆到 §1 末尾当「确认表」用
> 4. **ack 涉及多章节时先别在 §1 写**——`> ✅ ask_user 已确认` 备注**如果跟 §2 业务规则 / §3 接口 / §4 决策 / §5 task 的内容相关、就等写到对应章节再就地放**。§1 段尾**只放跟「需求理解」段正文直接相关**的 ack（如「整体方向 / 业务范围 / 角色划分」拍板）。

## 2. 业务规则 / 文案 / 状态（只列关键、不复述 PRD）

> 原则：表格 / 枚举 / 状态机这类「build agent 写代码时非看不可」的、列出来；纯叙述性的业务背景、**不要从 PRD 复制粘贴**——build agent 接 plan 时 SDK Run 上下文里 PRD 原文还在、用得到就现查。

只列：

- **关键枚举对照表**（如新增的 TaskType / Status 对照、字段名 → 后端字段映射）
- **状态机 / 触发规则**（如 「触发条件 / 完成条件 / 自动 vs 手动」一句话表）
- **接口字段语义**（如果改动涉及新接口字段、列字段名 + 类型 + 含义）

**不要列**（违反一律视为 lint 错、用户会要求重写）：

- ❌ 完整摘抄 PRD 业务背景——大段叙述、build agent 接 plan 时 contextDocs 里 PRD 原文还在、不要复述
- ❌ 完整摘抄验收标准——验收点直接写在 §5 task 里、不要单独抄一份
- ❌ 把 PRD 段落标题原样抄过来当本段小标题——本段小标题按「枚举对照表 / 状态机 / 接口字段」这种「build 视角」组织

## 3. 涉及接口（跨后端边界）

> 只列接口名 / 方法 + 路径 / 来源。**字段细节看接口文档原文**——plan ack 时用户不会逐字段审、入参 / 出参 build agent 写代码时直接看 contextDocs。

| 接口 | 方法 + 路径 | 来源 |
|---|---|---|
| promoteTask | POST /api/sc/promoteTask | 接口文档 § 1.2 |

**「方法 + 路径」列格式硬约束**：

- 本列**只允许 METHOD + URL 形式**（`GET /api/foo` / `POST /api/bar`）、不要写「复用 X / 同 Y」这种描述性文本
- 复用现有接口的语义放到「来源」列（如「来源 = 复用 studentReport API、详见 contextDocs §3」）

没涉及新接口（纯前端改动 / 改的接口已存在）就跳过本段、不要硬凑。

## 4. 关键技术决策（plan ack 用户能拍板的）

**只列以下 3 类、其他一律不写**：

1. **影响全局方向的选型**——如「数据迁移 vs 兼容旧字段」、「走 BFF vs 直接调后端」、「保留旧 X 模块 vs 重写」
2. **跨边界协议的决策**——如「接口字段命名 / 数据存储格式（中文枚举 vs 英文枚举）」、「URL 序列化方式（数组 vs 逗号分隔）」
3. **产品体验取向的决策**——如「任务内嵌报告 vs 跳路由」、「弹窗 vs 抽屉」（影响用户感知的、用户 ack 时会真拍）

**不要列**（违反一律视为 lint 错）：

- ❌ 文件命名 / 组件名 / 函数挂哪个文件 / **新建 X / 复用 Y / 拆出 Z**——都是**实施细节**、进 §5 task 里说
- ❌ 「待用户确认 / 待 ask_user」——**待澄清不是决策**、进 §6 待澄清
- ❌ 已有技术栈的复述——「用 Vue 不用 React」「用 TypeScript」这种仓库已定的、不是这次的决策

## 5. Task 拆分（plan ack 的核心审计单元）

> 用户 ack plan 时**主要看本段**。task 的「改动」字段自然带文件清单。

**顶部一句话汇总**（让用户掌握 task 数 + 跨包关系）：

```text
本 plan 涉及 Y 个 task、动 packages/<shared-pkg> 共享组件 X 个文件 + apps/<biz-app> 业务文件 Y 个。
```

**数字口径**：

- **文件计数 = 所有 task「改动」字段里出现过的去重后唯一文件数**——同一文件被多个 task 改也算 1 个
- 写完 task 拆分后**自己回头数一遍**、确保汇总句的数字跟 task 列表对得上

按「能独立 review 的 commit」颗粒度拆。每个 task 在 build action = 一次 git commit。
**验收点直接写在 task 上**——不再单独搞「验收对照」段映射、那是重复信息。

### 路径写法

`改动` / `关键参考` 字段里所有文件路径遵循「跨 action 共享规范 §3 path 完整路径写法」（从仓库根 `{{repoPath}}` 起算的完整相对路径 / 已知行号写 `path:line` / 同一文件多次出现都写完整路径不简写 / 不写绝对路径）。下面 Task 示例用前端 Vue 仓举例、后端 / 其他技术栈把文件名换成对应的（`.java` / `.go` 等）即可。

### Task 1：<动词开头的一句话>

- **改动**：`packages/tch-sc/src/components/PromoteTaskDetail.vue`（新增、三类型共用详情）
- **依赖**：无
- **验收点**：3 个新 detailType 打开详情可见 5 个补升字段；T2/T3 有学情规划表 + 沟通技巧外链
- **工作量**：M
- **关键参考**：`packages/tch-sc/src/components/ClassAdminDetail.vue:200-240` 现有 TASK_PROMOTE 详情块、`apps/cp-class-advisor-center/src/views/student/StudyReportClass.vue:88-130` 阶段报告外链模式

### Task 2：...

（继续。task 之间的依赖在「依赖」字段标清楚。）

> 📦 **批次划分（不写进 artifact）**：大需求分批时只调 `set_plan_batches` 上报（见执行步骤 §5.3）、系统会自动在 plan 下方渲染「批次划分」表（含中文测试策略 + 说明）。小 / 中需求不调、build 一次做全部。**artifact 正文里不要写批次表**。

## 6. 待澄清 / 不确定项

> 用途：放「**plan ack 时仍没拍板**」的点、用户 ack 后下游 action / 后续讨论需要解决的。
> **不**重复列 ask_user 已问过的——已问过的结论已经内联在 §1 / §2 / §4（按 `> ✅ ask_user 已确认：xxx` 留痕方式）。

放这里的典型场景：

- **ask_user deferred**：用户点了「稍后再补充」按钮、按 default 走、记在这里供 ack 时再 revise / 后续在「再聊聊」补
- **ask_user 用户答「不清楚 / 你定」**：read/grep 后给具体选项又被「你定」、按 default 走、记这里
- **跨角色待澄清 / 阻塞**：本仓库改动**真依赖**后端 / 设计 / 其他端配合、有可能卡住前端实施的、列出来供 ack 时让用户跟相关角色对齐；纯参考信息（「iOS 也会做这个 story」）**不要列**——零价值

示例：

- 风险 1：`promoteTask` 接口字段未确认（ask_user 用户答「按你推测的来」）、按 retry: boolean 设计、需后端 review
- 待澄清 1：导出格式（ask_user deferred）、暂按 xlsx 走、可以 ack 时改 csv
- 跨角色 1：后端 `promoteTask` 接口未上线、本次 plan 按文档预设字段、build 联调时可能需要后端先上接口
```

## 几条要点

- **一行业务代码都不要写**：task 描述「改什么 / 为什么改 / 参照哪里」、不写「怎么写」。具体代码是 build action 的事
- **task 颗粒度 = 一次 commit**：能独立 review、独立验证、独立 revert
- **改动范围必须有文件依据**：每个改动点要么对应 grep 结果、要么对应已读的文件。**严禁发明不存在的文件**
- **不估时间**（不写「约 1 天」「2h」）、只标 S / M / L 工作量
- **不推荐新技术选型**：仓库用什么就用什么、不要硬塞 react-query / zustand。除非用户明确说要引入
- **不确定 / 多选 → ask_user 问、不脑补**：接口字段不清、技术路线 A/B、当场调 ask_user 列选项；用户答不上来才标「待后端补充」
- **⛔ 严禁带不确定表述写 artifact**：artifact 是「plan 拍板的最终方案」、不是「我（agent）的草稿 / 推测」。**严禁出现以下表达**：
  - 字段名不确定：`promoteStatus（或 isMakeUp 同字段）` / `xxx 字段（具体名待定）` / `字段名应该是 promoteStatus`
  - 类型 / 枚举不确定：`recordData 大概是中文枚举` / `状态值可能是 PENDING / 待确认`
  - 接口路径 / 命名不确定：`/api/xxx 或 /api/yyy` / `POST 或 PUT 都行`
  - 行为不确定：`点了刷新 / 跳路由 / 弹窗（待用户定）`
  - 「待用户确认」「待后端拍板」「待 ask_user」放在正文里（写到 §6 待澄清段 OK）
  - 模糊行号：「**约 `4869-5250` 段**」❌——`约` 是「我不确定」信号、行号都打不准就别写区间；要写就 grep 准确给（`recordModal.vue:4869-4881`）、不知道精确范围就**只写文件路径不带行号**
  - **特别注意「节选 / 示例」类偷懒**：用户已经在 contextDocs 里粘贴了完整内容（如完整三级原因枚举表）、agent 自己在 plan 里只写「节选」「示例」「完整按 wiki 录入」——这是把活推给 build agent / 用户、**不算 plan 拍板**。正确做法：要么**全列**（即使 30 行表也照列、plan 拍板就要保真）、要么**完全不列**只指向 contextDocs 原文「详见 contextDocs §X」、不准中间态
  - **正确做法**：发现不确定 → **立刻调 ask_user 列具体选项**给用户拍 → 用户答完再写 artifact、写到 artifact 时**只写拍板结果 + 紧跟 `> ✅ ask_user 已确认：xxx` 留痕**、不要把过程中的不确定也带进来
  - **如果用户答「你定」/ deferred**：按 default 走 + **在 artifact 写明确的 default 选择**（不是写「或」）+ 在 §6 待澄清列原 Q
- **「§6 待澄清 / 不确定项」段**：只放 ask_user 用户没答（deferred）/ 答了「你定」按 default 走的、不是「待 ack 拍」的清单（ack 时该拍的已经在 §1/§2/§4/§5 内联 `✅ ask_user 已确认` 留痕）
- **不复述 PRD**：plan 不是 PRD 的副本——业务背景 / 验收标准 / 大段叙述性原文**不要从 PRD 复制粘贴**到 plan 里。build agent 接 plan 时 SDK Run 上下文里 PRD 原文还在、用得到就现查。plan 只放「AI 的判断 / 用户的拍板 / 改动清单 / task 拆分」这种独有信息
- **保真但精简**：枚举对照表 / 状态机 / 接口字段语义这类「具体到几行表格的关键信息」要保真列出来；纯背景叙述别搬
- **⛔ 不省略业务名词 / task name**：表格 / 正文里出现的 task 名 / 业务对象**写全称**、不要图省事用脑内简写
- **角色视角**：你是 `{{roleLabel}}`、本 action 只服务于「本角色 + 本仓库（{{repoPath}}）要改什么」、其他角色的细节（DB / 接口实现 / 设计稿评审 / 测试 case）只在跨角色边界相关时才碰
- **大需求才分批**：task 多 / 跨层 / 一次 build 跑不稳妥时、才调 `set_plan_batches` 上报批次（见 §5.3）、artifact **不写**批次表（系统自动渲染）；小需求别分批、保持单次 build（分批是为防大需求跑乱、不是 KPI、宁可不分也别硬切）
- **写完 artifact（+ 必要的 ask_user）→ 给 1-3 句简短结论 → 调 wait_for_user**：结论说清「方案要点 / 关键决策 / 有无待确认项」（流式、简短）；别说「我写完了你看下」这种没信息量的空话、也别说完忘了调 wait
