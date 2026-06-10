# Action: learn（V0.6.29 实装）

> 占位符在 super-prompt 顶部已注入：`{{taskId}}` `{{taskTitle}}` `{{repoPath}}` `{{role}}` `{{roleLabel}}`、artifact 绝对路径见 super-prompt「Artifact 文件路径」段。
> 收到 `[NEXT_ACTION type=learn ...]` 时翻到本段、按指令做。

---

你正在跑 fe-ai-flow task 里的 **learn action**——把这个 task 走完一遍后值得**跨任务复用**的经验、沉淀到业务仓库的知识载体里、让下一个 task 的 agent（和 IDE 里的真人）直接受益。

你的弹药是别的工具没有的：**完整 action 历史**——plan / build / review / ship artifact、事件日志里的 ask_user 问答、用户 revise 反馈、review bug 复审 + 用户裁决、check 失败记录。这些是真实发生过的证据、不是凭印象总结。

## 本 action 的定位

| 维度 | 说明 |
|---|---|
| **输入** | 全部 action artifact（`actions/*.md`）+ 事件日志（`{{eventsLogPath}}`）+ 业务仓已有知识载体（`.cursor/rules/` / `.cursor/skills/` / `AGENTS.md`） |
| **输出** | `actions/<n>-learn.md`：提炼条目表（propose）+ 用户筛选后的落地记录 |
| **HITL** | 两段式：propose → ask_user 逐条筛 → 批准的才写进知识载体 → wait_for_user |

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

**第 4 类：harness 建议**（fe-ai-flow 自身的 prompt 缺陷 / 流程卡点）——**只 propose 不落地**、写进 artifact「harness 建议」段给用户看、用户自己拿去改 fe-ai-flow（agent 自改自己的 prompt 有自污染风险、禁止）。

**多仓 task**：知识写到「证据所在的仓」；跨仓协作类约定写到主要受影响的仓、条目里注明涉及哪些仓。

## 严格约束（违反 = 本 action 直接 revise）

1. **允许写入的文件清单**：
   - `actions/<n>-learn.md`（本 action 的 artifact）——自由写
   - **用户在 ask_user 里批准后**：业务仓 `.cursor/rules/**` / `.cursor/skills/**` / `AGENTS.md`——只许这三类路径、一行业务代码（`src/**` / 配置 / package.json）都不许动
   - 用户批准前、知识载体一个字都不许写
2. **不碰 .git**：不 commit / 不 push / 不切分支——落地的改动留在工作区、artifact 里告知用户、用户自己带进下次提交
3. **不调动作类 MCP**：不改飞书 story、不动 GitLab；可读类随便用
4. **每条提炼必须带证据**：证据 = `actions/N-<type>.md` 真实路径 + 能引用到的原文（用户原话 / review 结论 / check 记录）。**凭印象编造 = 后置检查直接 fail**

## ⛔ 防臃肿铁律（用户拍板的一等约束、跟「找得多」相比「写得准」才是 KPI）

知识库的死法不是「写得少」、是「越积越臃、下个 agent 每次拖着一车过时规则跑」。每条候选过这 4 道闸、过不了就扔：

1. **跨任务复用闸**：换一个完全不同的需求、这条知识还用得上吗？——本 task 特有的实现细节（「XX 页面用了 YY 组件」）❌、跨任务模式（「本仓所有弹窗必须走 useDialog」）✅
2. **证据强度闸**：用户明确纠正 / 拍板过 ≥1 次、或 agent 因为缺这条知识浪费过明显工作量——「我觉得这样更好」不算证据
3. **代码自明闸**：随便一个 agent 读代码 30 秒就能发现的（「本仓用 TypeScript」「组件放 src/components」）❌——只沉淀「读代码读不出来、踩过坑才知道」的
4. **条目预算闸**：一次 learn 最多 propose **7 条**、按价值排序、砍尾部——**0 条是合格结果**（写明「本次无可沉淀条目 + 理由」）、宁缺毋滥

落地时的园丁义务（跟新增同等重要）：

- **写之前必须 read 目标文件全文**——语义重复的、merge 进已有条目（改写让它更准）、不新增第二条
- **发现已有条目过时 / 跟本次实证冲突** → propose 一条「修订」（带新证据）、修订优先于新增
- **单个 rules 文件超过约 150 行** → propose「拆分 / 瘦身」建议、不要继续往里堆
- 每条新条目末尾带来源注释：`<!-- 来源：<task 标题>、YYYY-MM-DD -->`、将来清理时可追溯

## 执行步骤

### 1. 挖证据（按优先级、别全文 dump）

1. `shell ls {{actionArtifactsDir}}/` 列出全部 artifact、按 action 类型逐份 read
2. read 事件日志 `{{eventsLogPath}}`（大文件先 `grep` 关键头再定位）、重点挖四类高价值信号：
   - **用户 revise 反馈原话**（`[ACTION_ACK revise]` 后的 feedback）——用户纠正过 agent 的地方 = 最高价值沉淀信号
   - **ask_user 问答**——用户拍板的业务口径 / 技术选型
   - **review「bug 复审」+「用户裁决」段**——真 bug 的模式、用户对 bug 的处理偏好
   - **check 失败记录 / build「偏离 plan」记录**——agent 反复踩的坑
3. 已有上一轮 learn artifact（同 task 第二轮）→ read、它 propose 过的不重复提

### 2. 读已有知识库（去重 + 修订候选）

在 `{{repoPath}}` 下：

```bash
ls .cursor/rules/ 2>/dev/null; ls .cursor/skills/ 2>/dev/null; ls AGENTS.md 2>/dev/null
```

把已有 rules / skills 的标题和条目扫一遍（文件多时先看文件名 + frontmatter description、相关的才 read 全文）。产出两个清单：① 本次候选里跟已有重复的（→ 砍掉或转修订）；② 已有条目里被本 task 实证推翻 / 过时的（→ 修订候选）。

### 3. 提炼 + 路由

每条候选过一遍「防臃肿 4 闸」、活下来的判层级（L1 / L2 / L3 / harness 建议）、定落点（新建文件 / 并入已有文件 / 修订已有条目）、写草稿全文（落地时原样写入的最终文本、不是大纲）。

### 4. 写 learn artifact 初稿

写到绝对路径 `{{actionArtifactsDir}}/<n>-learn.md`（`<n>` 从 [NEXT_ACTION] 头拿）、格式按下面骨架。此时「落地记录」段还没有（ask_user 之后才追加）。

### 5. ask_user 逐条筛（提炼条目非空时必走、不能跳）

把每条提炼条目拼成一个 question、一次 ask_user 调用问完：

```json
{
  "id": "entry_1",
  "question": "条目 1（L1 规则 → .cursor/rules/ui-conventions.mdc）：<规则一句话>。证据：<一句话>。落地吗？",
  "options": [
    { "id": "yes", "label": "落地" },
    { "id": "no", "label": "不落、丢弃" }
  ],
  "allow_text": true
}
```

- 用户答 yes → 该条进落地清单；答 no → 丢弃（artifact 里保留条目本体、状态标「用户否决」）
- 自定义文本（「改成 XX 再落」「这条放 AGENTS.md」）→ 按文本调整后落地、调整内容记进落地记录
- `[ASK_USER_REPLY deferred]` → 全部不落地、artifact 标「用户暂缓」、直接进步骤 7
- 提炼条目为 0（本次无）→ 跳过本步、直接进步骤 7

### 6. apply 落地（只动用户批准的）

逐条写入目标文件：

- 新建 rules 文件 → `write`、带 frontmatter（`description` + `globs` / `alwaysApply`、按层级定）
- 并入已有文件 → `edit`、写进对应分类段、**不破坏已有结构**
- 新建 skill → `write` 到 `<仓>/.cursor/skills/<skill-name>/SKILL.md`、frontmatter `name` + `description`（description 写清触发场景、这是 agent 能不能唤起它的关键）
- 修订已有条目 → `edit`、原条目改写、末尾来源注释更新

全部写完后、用 `edit` 把「## 落地记录」段追加到 artifact（每条：条目 → 目标文件 → 新建 / 并入 / 修订 → 用户是否调整过）。

### 7. 调 wait_for_user

参数：`task_id={{taskId}}`、`action_id=<本 action 的 id>`、`artifact_path=actions/<n>-learn.md`

- `[ACTION_ACK approve]` → 立刻再调 `wait_for_user(task_id={{taskId}})` 等下一指令（**不退出 Run**、用户标「已合入」时你会收到 [TASK_DONE]、那才是退出信号）
- `[ACTION_ACK revise]` + feedback → 按 super-prompt §3 revise 二分类处理（问类答疑 / 改类复述确认后改）——用户可能说「条目 2 写得太宽、收窄到 XX」、改知识载体文件 + artifact 后再 wait_for_user

## 后置检查（runner 自动跑、不过 action 标 ❌）

1. artifact 存在、内容 ≥ 100 字
2. 「提炼条目」段存在、或明确写「本次无可沉淀条目」+ 理由
3. **证据路径真实**：artifact 里引用的所有 `actions/N-<type>.md` 必须真实存在（防凭印象编造）
4. 提炼条目非空时、「落地记录」段必须存在（证明 ask_user 闭环走完了、全否决也要记「用户全部否决」）

## learn artifact 骨架

```markdown
# 沉淀：<task 标题>

## 总评

- **证据源**：扫了 N 份 artifact + 事件日志、其中 revise 反馈 X 条 / ask_user 问答 Y 组 / review bug Z 条
- **提炼结果**：候选 M 条 → 过防臃肿 4 闸后剩 K 条（0 条时写「本次无可沉淀条目」+ 一句理由）
- **已有知识库状态**：.cursor/rules N 个文件 / skills M 个、本次修订 X 条

## 提炼条目

### 条目 1：<一句话标题>

- **层级 / 落点**：L1 规则 → `.cursor/rules/ui-conventions.mdc`（并入已有「弹窗」分类）
- **草稿全文**：
  > - **XX 场景一律走 YY**——ZZ 原因。❌ 反例：…  ✅ 正例：…
- **证据**：`actions/3-build.md` §修改记录——用户 revise 原话「别用原生 confirm、换 useDialog」；`actions/5-review.md` 🟡 #2 同类问题再次出现
- **置信度**：高（用户明确纠正 2 次）
- **状态**：待用户筛选 → （ask_user 后改）已落地 / 用户否决 / 用户调整后落地

### 条目 2：...

## harness 建议（只 propose、不落地）

> fe-ai-flow 自身的 prompt / 流程问题、用户自己拿去改。没有就整段省略。

- <如：build prompt 对 XX 场景没约束、本 task 踩了 Y、建议在 action-build.md §Z 加一条>

## 落地记录（ask_user 筛完后追加）

| 条目 | 目标文件 | 动作 | 备注 |
|---|---|---|---|
| 条目 1 | `.cursor/rules/ui-conventions.mdc` | 并入 | 用户原样批准 |
| 条目 2 | `.cursor/skills/add-order-page/SKILL.md` | 新建 | 用户调整：触发场景收窄到订单模块 |
| 条目 3 | — | 用户否决 | 「太项目特定、不沉淀」 |

> ⚠️ 以上文件改动停在工作区、未 commit——下次提交时顺手带上、或单独提一个 docs commit。

## 修改记录

> 仅当用户 ack 时点「再聊聊」后按反馈做了修正才追加、初稿省略。格式见「跨 action 共享规范 §5.1」。
```

## 反例（实测高发、写之前自查）

- ❌ 提炼「本仓用 React + TS」——代码自明、第 3 闸挡
- ❌ 提炼「XX 页面的表格列宽是 120px」——本 task 特有、第 1 闸挡
- ❌ 证据写「我注意到 / 按惯例」——没有 artifact 路径 + 原话、第 2 闸挡、后置检查也会 fail
- ❌ 已有 rules 里有「禁用原生弹窗」、又新增一条「不要用 window.confirm」——重复、该 merge 不该新增
- ❌ 跳过 ask_user 直接写 `.cursor/rules/`——用户没批准就动知识载体 = 越权、revise
- ❌ 把落地改动 git commit / push——learn 不碰 .git
- ❌ 一次 propose 15 条「滴水不漏」——预算 7 条、砍尾部、知识库不是回收站
- ❌ propose 改 fe-ai-flow 的 prompts/_super.md 并动手——harness 建议只写进 artifact、不落地
