# 「改bug」流程 v2 方案（2026-07-16 记录）

> 用户口述方案、本文件是备忘。**2026-07-16 当日用户拍板「先把改bug和收件箱的东西改了」**——skill 流程 v2 + 待回归 bug+MR 一体（合并按钮）已开工；收件箱完整页、飞书全景页留到下一轮讨论。
>
> 开放问题当日拍板：① 合并做独立按钮（与通过/不通过相邻、不耦合）；② 存量 skill 用「精确匹配旧出厂内容才覆盖」的一次性升级（用户改过的不动、历史只有 v1.1.11 一版模板）；③ submit_mr target_branch 沿用 ship 口径（每仓测试分支、默认 test、不探 origin/HEAD）；④ 合并复用现成 `/api/mr-inbox/merge`（settings.gitToken、待测 MR 组已在用）。

## 用户诉求（原话意译）

点击改bug → 跳转 → 推进后：

1. agent 先**查看 bug 内容、自查有没有疑问**——有疑问 `ask_user` 问用户、没疑问直接改
2. 改完后**用提问（`ask_user`）的方式让用户验收**「有没有问题」——有问题继续改、循环
3. 用户说没问题后，**问用户要不要建 MR、并流转状态**
   - 建 MR 后把 MR 链接**评论到 bug 那个飞书项目工作项上**、不评论到原需求项目
4. 测试（QA）收件箱扫 MR 时，对**已流转的 bug（待回归组）**检测该 bug 里有没有 MR——有的话 bug 行上直接给一个「**合并**」按钮

## 现状（v1.1.14 基线）

- 入口链路已有：收件箱「改bug」→ 深链 `?advance=fix-bug&…` → 推进弹窗预选「改bug」→ 用户确认启动（`fix-bug-advance.ts`）
- skill 现流程（`src/lib/server/preset-skill-fix-bug.ts`）：复现（复现不了才 ask_user）→ 最小修复 → 自检 → artifact → bug 工作项评论回填 → `ask_user` 问是否流转 RESOLVED → `submit_work` 交卷
  - 即：**没有「改前疑问门」、没有「改后用户验收」环节、不建 MR**（评论里「MR 链接有则附上」是被动的）
- 收件箱三分组（`mr-inbox-scanner.ts` / `mr-inbox-panel.tsx`）：待测 MR（qa）/ 我的 BUG（fe/be）/ 待回归（qa、RESOLVED 白名单）——待回归行现有「通过 / 不通过」按钮、**没有合并 MR 能力**

## 方案拆解

### 一、skill 流程改造（改 `PRESET_FIX_BUG_SKILL_CONTENT`）

新流程：

1. **疑问门（新增）**：拉 bug 详情后先自查（复现路径清不清楚 / 期望行为明不明确 / 影响面）——有疑问先 `ask_user`、没疑问直接进入修复；保留「复现不了先问、别瞎改」
2. 最小修复 + 自检（不变）
3. **验收门（新增）**：改完不直接收尾——`ask_user` 简述改动、请用户验证「有没有问题」；用户反馈问题就继续改、循环到用户说没问题
4. **收尾（改）**：验收通过后 `ask_user` 问「要不要建 MR + 流转状态」
   - 用户要 → 调 `submit_mr` 建 MR → 把 MR 链接 `comment add` 到 **bug 工作项**（明确写「不评论原需求工作项」）→ 流转 RESOLVED
   - 用户不要 → 只写 artifact、不建不转
   - HITL 铁律保持：未经确认绝不 `transition-state`
5. `submit_work` 交卷

### 二、收件箱「待回归」组合并按钮

- 扫「待回归」bug 时顺带扫该 bug 评论里的 MR 链接（**复用一期 `extractMrUrlsFromText`**、别重写解析）
- 条目带上 `mrUrl` → 待回归行有 MR 时显示「合并」按钮 → server 调 GitLab merge API（token 设置里已有）
- 合并结果 toast；失败（冲突 / 流水线未过 / 权限）把 GitLab 报错带出来

## 涉及文件（下次开工索引）

| 改动 | 文件 |
|------|------|
| skill 模板 | `src/lib/server/preset-skill-fix-bug.ts` |
| submit_mr describe 与 skill 对齐（既有约定：MCP describe 是第二指令源、不能和 prompt 漂移） | `src/lib/server/chat-mcp.ts` |
| 待回归条目带 mrUrl（扫描 + 类型） | `src/lib/server/mr-inbox-scanner.ts`、`src/lib/mr-inbox.ts`、`src/hooks/use-mr-inbox.tsx` |
| 合并按钮 UI | `src/components/mr-inbox/mr-inbox-panel.tsx` |
| GitLab merge 端点 | server 侧新增（或挂现有 gitlab client 处） |

## 补充（2026-07-16 同日讨论）

### 用户意图澄清

「bug 和 bug 的 MR 合到**一个事件**上」——QA 视角一条待回归 = bug + 关联 MR 一体、验收完顺手点合并、不用跳 GitLab。上面「待回归行合并按钮」按这个心智做：行内同时呈现 bug 状态 + MR 状态（可合 / 冲突 / 检查中、复用待测 MR 组现成的 MrStatusChip）、「通过」和「合并」相邻。

### 收件箱形态升级（用户问「是不是太小气」、我同意）

现状：顶栏铃铛 → 380px Popover（`w-95`、max-h ~420px）、三分组挤在下拉里。作为「通知速览」够用、但职责已经长成**工作台队列**了（改bug 推进 / 通过 / 不通过 / 忽略、马上还要加合并）——弹层点外即关、宽度盛不下 bug+MR 一体的富行、操作全靠 hover 挤在行尾。

方向（业界惯例：GitHub 通知下拉 + /notifications 全页、Linear Inbox 独立面板）：
- **铃铛 + Popover 保留**做速览（未读数、点条目跳转）
- **新增收件箱完整页**（如 `/inbox`）：分组做成 section / tab、行有呼吸感——bug 标题全宽 + 描述摘要、chips（优先级 / 状态 / MR 可合性）、操作按钮常驻不靠 hover；bug+MR 一体行放这里才摆得开
- 合并按钮等 fix-bug v2 的新能力直接做在页里、Popover 只保留轻操作

### 飞书整体项目页（用户同日提出、方向认可、边界待拍板）

用户设想：不止收件箱页、还要「飞书整体项目页」——app 内看整个空间的全景（不只「我的排期」）。

我的判断：方向合理（Flowship 从「我的任务执行器」抬成「团队项目工作台」）、但**只做和 app 动作闭环相关的视图、不复刻飞书项目 web**：
- 全景视图 = 空间内需求 / bug 按节点·状态分组列表、筛选「我的 / 全部」、每条挂 Flowship 任务状态徽标（首页看板已有 task 关联逻辑可复用）、条目上直接发起「建任务 / 改bug / 看 MR」
- 纯信息浏览 / 字段编辑 / 评论流不做——一键跳飞书（那边本来就好用）
- 数据源注意：现有 /api/feishu/board 走 workhour 排期（只有自己的）、全景要换 workitem 列表类接口、量级和分页要先探（meegle CLI 有没有现成命令、拉全空间会不会慢）

### GitLab 操作换 glab CLI（用户同日提出、待下轮拍板）

用户想法：把 REST API 换成 GitLab 官方 CLI `glab`、让 AI 的操作「更直接更可控」。我的分层判断：

- **app 功能代码**（`gitlab-client.ts`：收件箱 MR 详情 / 合并 / submit_mr 落库）——**保持 REST 不换**：这层是确定性代码调用、不是 AI 在操作、fetch JSON 比 spawn 子进程解析文本更可控；换 CLI 纯多一层。
- **agent 任务内读操作**（查 MR / CI / diff / 评论、现在 super prompt 教「拿 settings token curl REST」）——**换 glab 是净收益**：命令语义对 LLM 更自然（`glab mr view 123`）、模型训练里见得多、one-shot 成功率高、`glab api` 兜底任意端点。落地要点：
  - 分发复用现有 tools/bin 基建（lark-cli / meegle CLI 同模式、app 启动放 `<data>/tools/bin` + 注入 PATH）、glab 是单二进制跨平台
  - 认证不用交互 login：起 agent 时注入 `GITLAB_TOKEN` + `GITLAB_HOST` 环境变量（glab 原生支持）、token 就是 settings.gitToken
- **agent 写操作**（建 MR / 合并）——**继续收口 submit_mr MCP 工具、glab 写命令列入禁令**：可控性的关键是写操作过门禁（task.mrs 落库、HITL），glab `mr create/merge` 绕过去就失控了。action-ship.md 已有「❌ 自己 curl 建 MR」禁令、届时同款补 glab。

用户追问「能不能全量换（app 功能代码也换 glab）」、我的评估（2026-07-16、建议维持混合）：

- 全量换的好处：单一访问层（AI 和 app 走同一个工具）、REST 细节（分页 / 版本兼容）交给官方 CLI 维护、后续加 CI / approvals 类功能有现成命令。
- 全量换的风险（都落在 app 功能层）：
  1. **结构化输出不保证**——server 需要 mergeable / detailed_merge_status 这类确定字段、glab 部分命令只有人类可读文本、拿 `glab api` 透传 JSON 又等于把 glab 当 curl 用、白多一层子进程
  2. **子进程 vs fetch**——收件箱一轮并发拉 N 个 MR 详情、spawn N 个进程比 Promise.all fetch 慢且重；Windows 杀软对频繁 spawn 的 CLI 有误报前科
  3. **错误处理退化**——REST 有 status code + JSON error、CLI 是 exit code + stderr 文本、随版本漂移、解析更脆
  4. **核心功能依赖硬化**——submit_mr / 收件箱 / 合并按钮从「零外部依赖（Node fetch）」变成「glab 二进制必须健康」、分发失败 = 核心功能全挂（gitlab-client.ts 顶部注释就是当年这么拍的板）
  5. server 端代码 fetch 还是 spawn 都是确定性调用、「AI 更可控」的增益只存在于 agent 读操作层、全量换拿不到额外可控性
- 业界同构参照：gh CLI vs Octokit——人 / AI 用 CLI、服务代码用 SDK/REST、没人在服务里 spawn gh。

## 开放问题（下次开工先拍板）

1. **「合并」和「通过」的关系**：独立按钮（合并归合并、回归归回归）？还是「通过」时检测到 MR 给个「同时合并」勾选？（倾向独立按钮、语义不耦合）
2. **存量用户 skill 不会自动更新**：出厂 skill 只在「不可见时」写入（`preset-actions.ts`、用户改过的内容受尊重）——模板改了之后老用户拿不到新流程。要不要做一次性内容升级（参考 `maybeRelabelFixBugAction` 的幂等校正、但 skill 正文用户可能改过、直接覆盖有风险）？还是只让新装 / 手动重建的人拿新版？
3. **submit_mr 在改bug 场景的 target_branch / 分支约定**：ship 场景有既定约定、改bug 复用哪套要确认
4. **QA 的 GitLab token 权限**：合并按钮走谁的 token（当前设置里的个人 token）——QA 用户配的 token 是否有目标仓库 merge 权限、没有时的报错引导
