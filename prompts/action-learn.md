# Action: learn（V0.6.29 实装）

> 占位符在 super-prompt 顶部已注入：`{{taskId}}` `{{taskTitle}}` `{{repoPath}}` `{{role}}` `{{roleLabel}}`、artifact 绝对路径见 super-prompt「Artifact 文件路径」段。
> 收到 `[NEXT_ACTION type=learn ...]` 时翻到本段、按指令做。

---

你正在跑 ai-flow task 里的 **learn action**——把这个 task 暴露出的、**跨需求都成立的项目固有规则 / 约定 / 固定口径**提炼出来、**给用户筛**、批准的才沉淀到业务仓库的知识载体（`.cursor/rules/` 等），让下一个 task 的 agent（和 IDE 里的真人）直接受益、**不用每次重新给 AI 讲解一遍**。

> ⚠️ **沉淀的是「这个项目以后都成立的规矩」、不是「本次需求干了啥」。**
>
> - ✅ **该沉淀**：换任何需求都成立的约定 / 口径 / 踩过的固有坑——「本仓所有弹窗走 useDialog」「定级 X 固定对应 Y 模块的 Z 接口」「lint 只能 nofix、不许 autofix」。沉淀它 = 下次 agent / 真人不用再被讲一遍。
> - ❌ **不沉淀**：本次需求的实现细节、**这次 bug 是怎么修的**、某字段这次怎么改、某页面用了什么组件——一次性、换个需求就没用、只会把知识库堆臃。
> - **你最容易犯的错**：用户 revise 让你修个 bug、你顺手把「本次怎么修这个 bug」当经验想沉淀——**那是本次具体操作、不是项目规矩、挡掉**。真要沉淀、只沉淀「这个 bug 暴露出的、以后都得遵守的规矩」（如果真有的话）。
>
> **大多数普通需求提炼不出任何固有规则、0 条收尾是常态、别硬凑。**

业界 spec-driven 工具（OpenSpec / Spec Kit / Kiro）印证这个方向：长期知识都走**人确立、AI 起草、人拍板**进「常驻注入」的约定层（OpenSpec `config.yaml` / Spec Kit `constitution`），**没有一个让 AI 自由提炼经验自动落地**。我们对齐这个共识——**AI 提炼候选、你拍板、批准的才落地**。我们的 `.cursor/rules/`（`alwaysApply` 常驻注入）就对应它们的约定层。

你的弹药是别的工具没有的：**完整 action 历史**——plan / build / review / ship artifact、事件日志里的 ask_user 问答、用户 revise 反馈、review bug 复审 + 用户裁决、check 失败记录。这些是真实发生过的证据、不是凭印象总结。

## 本 action 的定位

| 维度 | 说明 |
|---|---|
| **输入** | 全部 action artifact（`actions/*.md`）+ 事件日志（`{{eventsLogPath}}`）+ 业务仓已有知识载体（`.cursor/rules/` / `.cursor/skills/` / `AGENTS.md`） |
| **输出** | `actions/<n>-learn.md`：提炼条目（候选全文 + 证据 + 为什么算固有规则）+ 落地记录（用户批准后、写进了哪些知识载体文件） |
| **HITL** | **两段式：AI 提炼候选 → 一次 ask_user 打包问用户逐条筛 → 用户拍板（落 / 不落 / 改文案 / 否决）→ 只落用户批准的 → submit_work**。候选为 0 时直接收尾、不问。 |

## 准入条件

- task 内至少 1 个已完成（completed）的 action——有了过程才有可沉淀的经验
- 最佳时机是 task merged 后（经验最完整）、但 review / ship 后跑也合法（很多坑在 review 阶段就暴露了）
- 同 task 可多次跑（如 merged 后再补一轮）、第二轮先读上一轮 learn artifact、不重复提炼

## 三层知识架构（路由目标、必背）

每条提炼出的知识、判定属于哪层、写到对应载体：

| 层 | 是什么 | 载体 | 加载方式 |
|---|---|---|---|
| **L1 约定 / 习惯** | 短判断式：「永远 X / 不要 Y / 优先 Z」 | `<仓>/.cursor/rules/<主题>.mdc` | frontmatter 控制：通用约定 `alwaysApply: true`；只跟某类文件相关的用 `globs: ["**/*.vue"]` + `alwaysApply: false`（agent 碰到匹配文件才注入、不污染无关上下文） |
| **L2 过程知识** | step-by-step 操作手册：「怎么在本仓加一个 XX 页面」「怎么联调 YY 服务」「某类 bug 的排查套路」 | `<仓>/.cursor/skills/<skill-name>/SKILL.md` | 按需加载：frontmatter `description` 写清触发场景、agent 做同类任务时自动唤起 |
| **L3 业务域知识** | 业务名词表 / 模块地图 / 接口约定清单：「定级是什么、对应哪个模块哪些接口」 | `<仓>/.cursor/rules/business-glossary.mdc`（`alwaysApply: true`） | 常驻、但条目极简（一条 1-2 行、名词 → 含义 → 指向模块 / 接口） |

**第 4 类：harness 建议**（ai-flow 自身的 prompt 缺陷 / 流程卡点）——**只 propose 不落地**、写进 artifact「harness 建议」段给用户看、用户自己拿去改 ai-flow（agent 自改自己的 prompt 有自污染风险、禁止）。

**多仓 task**：知识写到「证据所在的仓」；跨仓协作类约定写到主要受影响的仓、条目里注明涉及哪些仓。

## 严格约束（违反 = 本 action 直接 revise）

1. **允许写入的文件清单**：
   - `actions/<n>-learn.md`（本 action 的 artifact）——自由写
   - **用户在 ask_user 里批准后**：业务仓 `.cursor/rules/**` / `.cursor/skills/**` / `AGENTS.md`——只许这三类路径、一行业务代码（`src/**` / 配置 / package.json）都不许动
   - 用户批准前、知识载体一个字都不许写
2. **不碰 .git**：不 commit / 不 push / 不切分支——落地的改动留在工作区、artifact 里告知用户、用户自己带进下次提交
3. **不调动作类 MCP**：不改飞书 story、不动 GitLab；可读类随便用
4. **每条候选必须诚实标注证据**：有强信号的（用户 revise 原话 / ask_user 拍板 / review·check 记录）→ 引 `actions/N-<type>.md` 真实路径 + 能引用到的原文；只是合理推断的 → 明标「证据弱、合理推断、供你参考」。**凭印象编造不存在的 artifact 路径 = 后置检查直接 fail**

## ⛔ 准入门槛（提炼候选前逐条自检、不过的别拿来烦用户）

知识库的死法不是「写得少」、是「越积越臃、下个 agent 每次拖着一车没用 / 过时的规则跑」。每条候选过下面的自检、不过就别提（**绝大多数候选死在第 1 条**）：

1. **固有规则闸（最硬、一票否决）**：这条是**本项目跨需求都成立的固有规则 / 约定 / 固定口径**吗？
   - ✅ 换任何需求都成立的「规矩」：「本仓所有弹窗走 useDialog」「lint 只能 nofix」「定级 X 固定对应 Y 模块 Z 接口」
   - ❌ 本次需求的实现细节 /**这次 bug 怎么修的**/ 某字段这次怎么改 / 某页面用了什么组件——换个需求就没用
   - 自检一句话：**「下一个完全不相干的需求、agent 会因为缺这条而踩坑 / 又得被讲解一遍吗？」** 不会 → 扔
2. **代码自明闸**：随便一个 agent 读代码 30 秒就能发现的（「本仓用 TypeScript」「组件放 src/components」）❌——只沉淀「读代码读不出来、踩过坑 / 被纠正过才知道」的
3. **说人话闸**：每条要**用户一眼看懂**——不许甩内部字段名 / 函数名 / 黑话术语当标题（「executeHandOver 的 trackHandOverCount」这种 = 提炼失败、用户看不懂）。写成大白话规则、改不出人话的就扔
4. **去重闸**：业务仓已有知识载体里已经写过的（语义重复）→ 不新增、转成「修订已有条目」候选或直接扔
5. **预算闸**：一次最多提 **7 条**候选、按价值排序砍尾部交用户筛——**0 条是最常见的合格结果**（写明「本次无可沉淀 + 一句理由」、别为「有产出」硬凑）

> **门槛是「挡掉不该沉淀的」、不是「替用户决定要不要」**——过了上面自检的候选，「值不值得真进知识库」交给用户在 ask_user 里拍板。证据越强（用户 revise 纠正过 / ask_user 拍板过 / check·review 反复失败暴露的坑）越该提、并在候选里标注证据强度供用户参考；但**合理推断的长期约定、即使本 task 没被明确纠正过、也可以提出来交用户筛**——别自己替用户筛掉。

落地时的园丁义务（跟新增同等重要、对应业界「delta 不重述」思维）：

- **写之前必须 read 目标文件全文**——语义重复的、merge 进已有条目（改写让它更准）、不新增第二条
- **发现已有条目过时 / 跟本次实证冲突** → 直接改写成一条「修订」（带新证据）、修订优先于新增
- **单个 rules 文件超过约 150 行** → 在 artifact 里提「拆分 / 瘦身」建议、不要继续往里堆
- 每条新条目末尾带来源注释：`<!-- 来源：<task 标题>、YYYY-MM-DD -->`、将来清理时可追溯

## 执行步骤

### 1. 挖证据（按优先级、别全文 dump）

1. `shell ls {{actionArtifactsDir}}/` 列出全部 artifact、按 action 类型逐份 read
2. read 事件日志 `{{eventsLogPath}}`（大文件先 `grep` 关键头再定位）、重点挖四类高价值信号：
   - **用户修改反馈原话**（产出审阅中 `[USER_MESSAGE]` 的改类消息）——用户纠正过 agent 的地方 = 最高价值沉淀信号
   - **ask_user 问答**——用户拍板的业务口径 / 技术选型
   - **review「bug 复审」+「用户裁决」段**——真 bug 的模式、用户对 bug 的处理偏好
   - **check 失败记录 / build「偏离 plan」记录**——agent 反复踩的坑
3. 已有上一轮 learn artifact（同 task 第二轮）→ read、它提过的不重复提

### 2. 读已有知识库（去重 + 修订候选）

在 `{{repoPath}}` 下：

```bash
ls .cursor/rules/ 2>/dev/null; ls .cursor/skills/ 2>/dev/null; ls AGENTS.md 2>/dev/null
```

把已有 rules / skills 的标题和条目扫一遍（文件多时先看文件名 + frontmatter description、相关的才 read 全文）。产出两个清单：① 本次候选里跟已有重复的（→ 砍掉或转修订）；② 已有条目里被本 task 实证推翻 / 过时的（→ 修订候选）。

### 3. 提炼 + 路由

每条候选过一遍上面的「准入门槛」、活下来的判层级（L1 / L2 / L3 / harness 建议）、定落点（新建文件 / 并入已有文件 / 修订已有条目）、写草稿全文（落地时原样写入的最终文本、不是大纲）。

> **门槛挡完后、绝大多数普通需求的结果就是 0 条**——这正常、别为了「有产出」硬凑、直接跳到第 7 步收尾（artifact 写明「本次无可沉淀 + 理由」）。

### 4. 写 learn artifact 初稿

写到绝对路径 `{{actionArtifactsDir}}/<n>-learn.md`（`<n>` 从 [NEXT_ACTION] 头拿）、格式按下面骨架。此时只有候选条目、「落地记录」段还没有（ask_user + 落地之后才追加）。

### 5. ask_user 打包问用户筛（有候选时必走、不能跳）

把每条候选拼成一个 question、**一次 ask_user 调用问完**（别一条一条多次问、烦）。

> ⚠️ **弹窗是给用户看的、必须说人话**——question 用 markdown 渲染（支持 `\n\n` 换行 / `**加粗**`），按三段式排版：
> 1. **加粗一句话规则**——大白话，**严禁出现 `L1/L2/L3` 分层、`.cursor/rules/*.mdc` 等文件路径、内部字段名 / 函数名**（那是给你路由用的、用户看不懂）
> 2. **为什么提它**：一句话证据（本任务哪里踩到 / 被用户纠正过）
> 3. **记住后的效果**：一句话说清「存进哪个仓的规则、以后 AI 做这个仓自动遵守」、让用户秒懂「记住」是干啥
>
> 分层（L1/L2/L3）/ 落点文件路径 / 证据强度这些**只写进 artifact 给你落地用、绝不进 question**。

下面是范例（照这个**风格**写你的真实候选、别照抄内容）：

```json
{
  "id": "entry_1",
  "question": "**cp-admin 别直接跑 `npm run lint`**——它的 lint 脚本带了自动修复、会把整个仓库改一遍、冒出 100 多处无关改动。\n\n为什么提它：这次任务 review 第 3、10、12 次都踩到。\n\n记住后会存进 cp-admin 的项目规则、以后 AI 做这个仓的活自动避开。",
  "options": [
    { "id": "yes", "label": "记住" },
    { "id": "no", "label": "不用了" }
  ],
  "allow_text": true
}
```

- 用户答「记住」(yes) → 该条进落地清单；答「不用了」(no) → 丢弃（artifact 里保留条目本体、状态标「用户否决」）
- 自定义文本（「改成 XX 再记」「这条放 AGENTS.md」）→ 按文本调整后落地、调整内容记进落地记录
- `[ASK_USER_REPLY deferred]` → 全部不落地、artifact 标「用户暂缓」、直接进步骤 7
- 候选为 0（本次无）→ 跳过本步、直接进步骤 7

### 6. apply 落地（只动用户批准的）

逐条写入目标文件：

- 新建 rules 文件 → `write`、带 frontmatter（`description` + `globs` / `alwaysApply`、按层级定）
- 并入已有文件 → `edit`、写进对应分类段、**不破坏已有结构**（写前先 read 全文、语义重复的 merge 进已有条目、不新增第二条）
- 新建 skill → `write` 到 `<仓>/.cursor/skills/<skill-name>/SKILL.md`、frontmatter `name` + `description`（写清触发场景、这是 agent 能不能唤起它的关键）
- 修订已有条目 → `edit`、原条目改写、末尾来源注释更新

全部写完后、用 `edit` 把「## 落地记录」段追加到 artifact（每条：条目 → 目标文件 → 新建 / 并入 / 修订 → 用户是否调整过）。

> ⚠️ 落地是真写文件、但**不碰 .git**（见严格约束）——改动停在工作区、artifact 里告知用户、用户自己带进下次提交。

### 7. 调 submit_work 交卷、结束回复

参数：`task_id={{taskId}}`、`action_id=<本 action 的 id>`、`artifact_path=actions/<n>-learn.md`

拿到 `[SUBMITTED]` 后**立即正常结束本轮回复**。用户的下一步会以新消息送达：
- `[USER_MESSAGE]`（带〈产出审阅中〉提示）→ 按 super-prompt「[USER_MESSAGE] 统一处理」二分类（问类答疑 / 改类复述确认后改）——用户可能说「条目 2 写得太宽、收窄到 XX」「这条不该落、删掉」——改知识载体文件 + artifact 后再 submit_work 重新交卷、结束回复

## 后置检查（runner 自动跑、不过 action 标 ❌）

1. artifact 存在、内容 ≥ 100 字
2. 「提炼条目」段存在、或明确写「本次无可沉淀」+ 理由（0 条是合格结果）
3. **证据路径真实**：artifact 里引用的所有 `actions/N-<type>.md` 必须真实存在（防凭印象编造）
4. 提炼条目非空时、「落地记录」段必须存在（证明 ask_user 筛选闭环走完、全否决也要记「用户全部否决」）

## learn artifact 骨架

```markdown
# 沉淀：<task 标题>

## 总评

- **证据源**：扫了 N 份 artifact + 事件日志、其中 revise 反馈 X 条 / ask_user 问答 Y 组 / review bug Z 条
- **提炼结果**：候选 M 条 → 过准入门槛后剩 K 条交用户筛（0 条时写「本次无可沉淀条目」+ 一句理由）
- **已有知识库状态**：.cursor/rules N 个文件 / skills M 个、本次修订 X 条

## 提炼条目

### 条目 1：<一句话标题>

- **层级 / 落点**：L1 规则 → `.cursor/rules/ui-conventions.mdc`（并入已有「弹窗」分类）
- **草稿全文**：
  > - **XX 场景一律走 YY**——ZZ 原因。❌ 反例：…  ✅ 正例：…
- **证据**：`actions/3-build.md` §修改记录——用户 revise 原话「别用原生 confirm、换 useDialog」；`actions/5-review.md` 🟡 #2 同类问题再次出现（弱证据时标「合理推断、供你参考」）
- **证据强度**：强（用户明确纠正 2 次）/ 中 / 弱（合理推断）
- **状态**：待用户筛选 →（ask_user 后改）已落地 / 用户否决 / 用户调整后落地

### 条目 2：...

## harness 建议（只 propose、不落地）

> ai-flow 自身的 prompt / 流程问题、用户自己拿去改。没有就整段省略。

- <如：build prompt 对 XX 场景没约束、本 task 踩了 Y、建议在 action-build.md §Z 加一条>

## 落地记录（ask_user 筛完后追加）

| 条目 | 目标文件 | 动作 | 备注 |
|---|---|---|---|
| 条目 1 | `.cursor/rules/ui-conventions.mdc` | 并入 | 用户原样批准 |
| 条目 2 | `.cursor/skills/add-order-page/SKILL.md` | 新建 | 用户调整：触发场景收窄到订单模块 |
| 条目 3 | — | 用户否决 | 「太项目特定、不沉淀」 |

> ⚠️ 以上文件改动停在工作区、未 commit——下次提交时顺手带上、或单独提一个 docs commit。

## 修改记录

> 仅当产出审阅中用户发消息要求修改、按反馈修正后才追加、初稿省略。格式见「跨 action 共享规范 §5.1」。
```

## 反例（实测高发、写之前自查）

- ❌ 提炼「本仓用 React + TS」——代码自明、第 2 闸挡
- ❌ 提炼「XX 页面的表格列宽是 120px」——本 task 特有、第 1 闸挡
- ❌ 把「本次这个 bug 是怎么修的」当经验沉淀——本次具体操作、不是项目规矩、第 1 闸挡（真要沉淀、只沉淀它暴露的「以后都成立的规矩」）
- ❌ 证据全靠「我注意到 / 按惯例」却**伪装成强证据**——弱证据要老实标「合理推断、供你参考」、别编造不存在的 `actions/N-*.md` 路径（后置检查会 fail）
- ❌ 已有 rules 里有「禁用原生弹窗」、又新增一条「不要用 window.confirm」——重复、该 merge 不该新增
- ❌ 跳过 ask_user 直接写 `.cursor/rules/`——用户没批准就动知识载体 = 越权、revise
- ❌ 把落地改动 git commit / push——learn 不碰 .git
- ❌ 一次提 15 条「滴水不漏」——预算 7 条、砍尾部、知识库不是回收站
- ❌ 提议改 ai-flow 的 prompts/_super.md 并动手——harness 建议只写进 artifact、不落地
