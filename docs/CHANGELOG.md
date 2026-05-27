# fe-ai-flow CHANGELOG

本文件记录 fe-ai-flow 所有 V0.x 版本的演进细节、按时间倒序（最新在最上面）。

## 这文件为什么存在

`docs/HANDOFF.md` 主要负责「最小接力上下文 + 当前架构快照 + 最近 1-2 个子版本」、不再吞下所有历史。每次新做完一个子版本后、改动细节追加到本文件顶部；超过 2 个子版本后由 HANDOFF.md「最近演进」段迁移过来。

## 写入规则

1. 新子版本完成后、**先在 HANDOFF.md「最近演进」段写一遍**（用户接力直接看 HANDOFF）
2. 等下一个 / 下下个子版本完成时、把 HANDOFF.md 里**最老的那段**迁移到本文件顶部（保持 HANDOFF.md「最近演进」始终只留 2 个子版本）
3. 本文件**只追加、不修改既有内容**——历史是事实、不要改写
4. 本文件内子版本顺序：**时间倒序**（新在上）；同子版本内部正序（小步迭代有逻辑链、不反过来）

---

### V0.5.14：事件流虚拟滚动 + memo（彻底解决「事件流多了卡」）（2026-05-26）

**背景**：用户实测发现事件流多了之后明显卡顿、滚动 / 输入 / 折叠展开都有延迟感。分析根因：

- 几百条 events 一起 render、每条一个 EventRow（card div + memo state + 可能的 markdown 渲染）
- SSE 一推 chunk → `task.events` 引用变 → 整个事件流子树 reconcile
- `react-markdown` parser 不便宜、几百条 assistant_message 一起 re-render 一下就堵 main thread

**方案 A+B 落地**（用户拍板「彻底解决」）：

1. **`react-virtuoso` 虚拟滚动接管主体**
   - 装 `react-virtuoso@4.18.7`
   - `<Virtuoso data={items} itemContent={...} />` 替代原 `<div onScroll>` + 手动 scroll ref
   - DOM 节点封顶 ~30 个（viewport + buffer）、几百条 events 性能持平
   - `followOutput={(isAtBottom) => isAtBottom ? "smooth" : false}` 一行替代老的「贴底跟随」逻辑：
     - 库自己维护「是否贴底」、不需要 `stickToBottomRef` + `handleScroll` + `useEffect`
     - 删了原本 ~25 行的滚动控制代码
   - `initialTopMostItemIndex={items.length - 1}` 初始定位末尾
2. **`streamingText` 拼成虚拟末尾 item 参与虚拟化**
   - 之前是「特殊渲染在事件列表之后」、需要单独 Footer 组件 + scrollIntoView
   - 现在：`__streaming__` 假事件 push 到 data 数组末尾、跟其他 event 一起 virtualize
   - `followOutput` 自动跟着追加滚动、不需要额外触发
3. **`React.memo` 包裹 row 组件**（`rows.tsx`）
   - `EventRow` / `AskUserRequestRow` / `StreamingAssistantRow` 全部 memo
   - SSE 频繁 setTask 时已渲染 item 跳过 reconcile、ID 稳定的 row props 不变就不重渲染
   - 配合 Virtuoso 的 item 复用、整体 reconcile 工作量降一个数量级

**bundle 影响**：`/tasks/[id]` First Load JS 270 KB → 290 KB（+20 KB / +7%）、`react-virtuoso` ~15 KB gzipped、可接受。

**V0.5.13.4 自动滚动 bug**（顺带修）：

之前 `useEffect` 依赖 `renderEvents.length`、但合并算法（thinking + tool_call）把多条合一条、length 不变、贴底也不滚——用户反馈「自动滚动经常失效」。

修法：dep 换回原始 `task.events.length`（单调递增）。**V0.5.14 接 Virtuoso 后该 useEffect 被整体删除**、bug 自然消失（库自己管贴底）、不需要单独 fix。

**验证**：`pnpm typecheck` ✓ / `pnpm lint` ✓ / `pnpm build` ✓（23 routes 全编译、`/tasks/[id]` First Load 290 KB）

**待联测**：跑一个事件多的真任务（几百条 events）、看滚动 / 切折叠 / 推 chunk 是否丝滑、贴底跟随是否正常。

### V0.5.13.2：所有 dialog 加 Cmd+Enter 提交（默认快捷键）（2026-05-26）

用户拍板「Cmd+Enter 成为所有 dialog 的默认提交快捷键」、跟 event-stream 输入框 / chat 应用通用习惯（Slack/Cursor/ChatGPT）对齐。

**4 个 dialog 一锅都加**（Textarea onKeyDown handler 模板：`Cmd/Ctrl+Enter` 阻止默认 + 调 `handleSubmit`）：

| Dialog | 改动 |
|---|---|
| `revise-dialog.tsx` | Textarea + onKeyDown、placeholder 加「（Cmd+Enter 发送）」 |
| `ask-user-dialog.tsx` | Other 模式 Textarea + onKeyDown（placeholder 不动、原本就很长） |
| `new-task-dialog.tsx` | description Textarea + onKeyDown |
| `advance-dialog.tsx` | fork reason Textarea + onKeyDown |

**安全保证**：每个 `handleSubmit` 内部已有 `!canSubmit` / `!allAnswered` 短路保护、未填完时 Cmd+Enter 无副作用（按钮 disable 也走同样校验）。

**单 `Enter` 保持换行**、避免误发。

**验证**：`pnpm typecheck` ✓ / `pnpm lint` ✓

### V0.5.13：事件流密度优化（summarize 全文压缩 + tool_call 合并）（2026-05-26）

**背景**（用户跑完 V0.5.12 第三轮联测后即时反馈）：

1. 思考块折叠态文本「没占满一排就省略 + 没省略号」、用户看到一句短话不知道下面还有几行
2. review 阶段 agent 频繁 edit `01-plan.md` / `03-review.md`、tool_call 一连十几条卡片刷屏（review 闭环的副作用）

**改动**（全在 `src/components/tasks/event-stream/`）：

1. **`summarize` 改全文空白压缩 + 200 字截**
   - 原本：取 `text.split("\n")[0]` 首行、80 字截、首行短不加省略号
   - 现在：`text.replace(/\s+/g, " ").trim()` 拍平、200 字兜底
   - 配合 truncate class：容器宽度截到哪算哪、自动 `…`、用户看到尽量满的预览
2. **`mergeAdjacentToolCall` 新增（V0.5.13.1 hot-fix 后）**
   - **初版**：同 phase + 同 `meta.name`（tool 名）连续 ≥2 条 tool_call 合一卡
   - **hot-fix 放宽**（用户实测拍板）：去掉「同 tool name」约束、改成「同 phase 连续 tool_call」就合并
     - 原因：AI 探索式调用经常 `read → grep → read → edit` 交错、严格相邻不触发、压不了几条
     - 折叠态：「工具调用 ×N」+ 最后一条 `summarize(ev.text)` 摘要（给用户看「收尾在干嘛」）
     - 展开态：每条子条带 `[tool name]` prefix（蓝色 badge）、看得清谁是谁
   - `meta.batch = [{ id, ts, text, name }]` 保留所有子条
   - `meta.count` 给折叠态显示「×N」后缀
   - 类似 `mergeAdjacentThinking` 不动 events.jsonl 落盘内容、只在 UI 渲染前合并
   - `event-stream.tsx` 的 `renderEvents` useMemo 两道 pass：thinking 合并 → tool_call 合并
3. **`EventRow` batch 折叠态展示**
   - 折叠态文本：`${summarize(ev.text)} ×N` 后缀
   - 展开态：列表展示每条 `[name] {text} {ts}`、字号 [11px] 紧凑 mono
   - 不可展开的 single tool_call 走原逻辑

**用户拍板未选**：C 方案「显示工具调用 / 思考 / phase 边界」过滤器 toggle——每次都要用户操作太烦。B 方案被动降密度、跟 Cursor IDE 行为一致。

**验证**：`pnpm typecheck` ✓ / `pnpm lint` ✓

---

### V0.5.12.3：review prompt 5 点精修 + 第二轮联测 hot-fix（2026-05-26）

**背景**：用户实测 V0.5.12.2 闭环后跑了一道任务 `t_1779688487844_9kzpdc`、闭环 work（agent 调 ask_user / 用户选 b / agent edit plan / 追加用户决策段）、但发现 5 个不完美点。本轮先做 prompt 精修、再跑一轮联测、发现 2 个新边界 case 一并修。

#### 第一轮：5 个 prompt 改动（全在 `prompts/phase-3-review.md`）

1. **P0 strikethrough 分场景规则**（§7.2）：表格 cell 里加 `~~xxx~~` 会破坏列对齐 + markdown 不渲染、agent 会偷偷绕过。改成分场景规则：
   - 段落 / 单层 list item → strikethrough 划掉旧描述、新值跟在后面、末尾加补录标记
   - 表格 cell → 表格直接改新值、用 blockquote 留痕「⚠️ review ack 补录：<字段> 原 X、改为 Y（用户在 ask_user 答 b 接受偏差）」
   - 嵌套 list item → 上层是字符串用 strikethrough、整体清单变更用 blockquote
   - 反例明确禁掉「`| field | ~~old~~ new | ... |`」
2. **P1 飞书未覆盖项纳入闭环**（§7 触发条件 + §7.1 第 3 个 question 模板 + §7.2 落地路径）：之前只闭「实现偏差 + 未完成 task」、漏了「跟飞书需求对照」表里 ❌ 未覆盖 项（飞书原文有、plan 漏列了、build 也没做的）。加 question 模板 `options = [a 加进 plan 作 follow-up / b 接受不做（plan §6 留痕）/ c 跨角色跨仓库不留痕]` + 三条落地路径
3. **P2「§ 用户决策」段位置固定**（骨架加 HTML 注释 + §7.4 第 1 条）：明确放在「未完成 task」段后、「跟飞书需求对照」段前、不要追加到 artifact 末尾。打破阅读流的 anti-pattern 列出来
4. **P3「§ 修改记录」段语义严格**（§7.4 第 2 条）：明确「§7 闭环动作（ask_user 问 / edit plan / 追加决策段）**不属于** §修改记录、§修改记录段只在用户 ack=revise 后按 feedback 改时才追加」。防止双写
5. **P4 plan 拍板口径显性复核**（§1 表格备注 + 骨架加 ## plan 拍板口径复核 段 + §6 提醒）：plan agent 内联的 `> ✅ ask_user 已确认 X` 备注、每条都得列到这个新段、给「✅ 一致 / ⚠️ 跑偏 / N/A 没用到」三选一结论

#### 第二轮：联测发现的 hot-fix（同日跑下来的边界 case）

跑了第二轮真任务（`t_1779688487844_9kzpdc` 回滚 plan + 重跑 review）、5 点行为全部按新规则执行——但发现 2 个新边界 case：

6. **P0.1 blockquote 位置铁则**（§7.2 新增第 4 条）：agent 把 blockquote 插到表格行之间 / list 项之间、破坏 markdown 结构。实测：
   - §2.1 表格被改的 `questionData` 那行紧下方插 blockquote、后面 `mathLevelV2` / `studyPurpose` 两行被切到 blockquote 后面、render 时表格断、那两行变成普通文本
   - §5 Task 1 子列表「`- 改动:`」和「`- 依赖:`」之间插 blockquote、`- 依赖` 起头一个新 list、不再是 task 子项
   - 修：明确「blockquote 必须放在**整个表格 / 整个 list 块结束之后**、不能插中间」、加正确做法 + 反例
7. **P4.1 拍板口径复核段职责严格**：agent 把 review ack 补录的项也列到「plan 拍板口径复核」段（混淆「plan 阶段拍板」和「review 阶段拍板」）。修：明确「本段只列 plan 阶段 `> ✅ ask_user 已确认` 备注、review ack 补录（`> ⚠️ review ack 补录`）归『§ 用户决策』段、不重复列」

#### 第三轮：start-workflow fork 模式漏 ack 上游 phase（代码修复）

8. **`plan-runner.ts` fork 路径自动 ack 上游 phase**（V0.5.12.3 hot-fix）：实测发现 `start-workflow` 路由的 fork 模式（用户在 AdvanceDialog 选「推进 → fork → fromPhase=review」）**只 reset 下游 phase 到 pending、不 markPhaseAcked 上游 phase**——build 状态永远卡在 `awaiting_ack`、UI 显示「BUILD 待确认」、但 review 已经基于 build 跑完了、状态机和实际进度脱节、用户视角懵。
   - 修：fork 路径加循环、对 fromPhase 之前的所有 phase 调 `patchPhase status=ack` + 写 `phase_ack` 事件（meta.autoAck=true）
   - 语义：「fork from X」= 「用户认可 X 之前所有 phase 的产出」、自动 ack 符合直觉
   - 区分 `phase-ack` 路由 fork：那条路径已经在自己路径里调 markPhaseAcked(ackPhase)、走到 plan-runner 时上游已 ack；本修复覆盖的是 `start-workflow` 路由直接 fork 的场景

**验证**：`pnpm typecheck` ✓ / `pnpm lint` ✓

**待联测**：跑新任务（或 fork 老任务再来一轮）、看 review agent 在新 prompt 下是否避开 blockquote 中插问题；fork 从 review 时上游 build phase 状态自动变 ack。

### V0.5.12.2：全局遗留清理（开发期不写兼容代码原则的一次集中执行）（2026-05-26）

**背景**：上一轮做 review phase ask_user 闭环时一度加了 `recommended` 字段、用户实测后拍板「都删、删赶紧、我不希望代码有各种遗留」、顺势让我扫整个项目把其它「向后兼容代码」也清一遍。项目规则原话「开发期不写向后兼容代码、改 schema 直接删旧」、这次集中兑现。

**删的四块**：

1. **`recommended` 推荐机制全链路**（`AskUserQuestion` 字段 + chat-mcp zod schema + ask-user-dialog 一键接受按钮 + 推荐徽章 + prompts/phase-3-review.md 推荐文案）
2. **`task-fs.ts` V0/V1 老 artifact 兜底**：
   - `readArtifact` / `writeArtifact` 不再回退到 task 根的 `<phase>.md`、只走 `artifacts/<NN>-<phase>.md`
   - `phaseArtifactFilename` idx<0 改成抛错（不再返 legacy `<phase>.md`）
   - 删 `sanitizeCurrentPhase`（V0 时代 `spec` phase 兜底）、`currentPhase` 直接读 meta
   - 文件头注释从「spec.md / plan.md / build.md 平铺在 task 根」改成 V0.5 的 `artifacts/01-plan.md` 子目录布局
3. **`repoPath` 单值字段**（V0.5.9 改 `repoPaths: string[]` 数组、当时留了 hydrate `[repoPath]` 兜底）：删 TaskMeta `repoPath?` 字段 + 删 hydrate 双向兼容、`repoPaths: meta.repoPaths ?? []` 一行搞定
4. **`start-workflow` mode 缺省 = restart**（V0.5.7 加的「老 UI 不传 mode 时默认 restart」）：mode 改成必传、不传返 400；`StartWorkflowOptions.mode` 改非可选；`task-store.startWorkflow` 签名 options 改非可选
5. **`local-store.ts` 老 schema 兼容**：删 `migrateDefaultModel`（早期 string → ModelSelection）+ `migrateMcpJson`（早期裸 server map → 带 wrapper）的迁移逻辑、改成纯校验「字段形态不对就回默认值」

**副作用** （用户拍板接受）：

- V0.5.9 之前的 task 打不开（meta.json 里只有 `repoPath` 单值的）——本地 data/tasks/ 老任务作废
- V0 时代 currentPhase=`spec` 的 task 打开会崩——更老的、应该已经没了
- localStorage 里存的老 schema settings 读不出来、用户需重配 API key + 模型 + MCP（5 分钟）
- 外部脚本不带 mode 调 `/start-workflow` API 会 400（项目内 UI 全部走 AdvanceDialog 显式传 mode、无影响）

**验证**：`pnpm typecheck` ✓ / `pnpm lint` ✓ / `pnpm build` ✓

### V0.5.12（迭代二）：review phase 闭环（ask_user + 直改 plan）（2026-05-25）

**背景**（用户实测 V0.5.12 迭代一 diff 视图后提的问题）：跑了一道任务、review phase 列出「实现偏差」段建议「接受偏差并更新 plan」、但用户在 ack 时不知道怎么落地——「更新 plan」这个动作没人做、review 不能动 plan、build 已结束、用户「再聊聊」也不一定能 trigger 改对 plan。流程**没闭环**。

用户拍板路径：「让 AI 通过 ask_user 主动问、像 plan phase 一样」、避免不熟悉的用户面对 artifact 里的 a/b/c 选项盲选。

**核心改动**（`prompts/phase-3-review.md` 重写流程）：

```
§6  写 03-review.md 初稿（不含「§ 用户决策」段）
§7  ⭐新增：如果有「实现偏差」or「未完成 task」段、必须调 ask_user 把所有条目一次性问完
     - 实现偏差 question：options=[a 改回 plan / b 接受偏差并更新 plan]
     - 未完成 task question：options=[a 现在补做 / b 建 follow-up / c 接受不做]
     - ⚠️ AI 不在 prompt / question 文本里偷偷暗示「建议 X」「推荐 Y」、HITL 是底线
§7.2 ask_user 答完后落地：
     - 答 b（接受偏差）→ edit 01-plan.md 对应段落、用 ~~strikethrough~~ 划掉旧描述 + 加 review ack 补录标记
     - 答 c（未完成 task 接受不做）→ edit 01-plan.md §5 task 加注解
     - 答 a → 不动 plan、用户 ack=revise 时回 build / 再走改回 plan 路径
     - 自定义文本 → 不落地、记到决策段、必要时 assistant_message 提示用户再回弹窗选
§7.3 把每条决策追加到 03-review.md「§ 用户决策」段（agent 自己 edit、不在初稿里）
§8  调 wait_for_user 等用户最终 ack

约束扩展：
  - review phase 允许写入 01-plan.md（破例、只在 §7 ask_user 答完 b/c 后、只动描述 / 注解）
  - 其它一切只读不变
  - V0.5.12 limitation：edit 01-plan.md 时**不自动 snapshot 旧 plan**、所以这次 review ack 改动不进 diff 历史、V0.5.13 再补
```

**验证**：`pnpm typecheck` ✓ / `pnpm lint` ✓

**待联测**：跑一道有「实现偏差」段的真任务、看 review agent 是否调 ask_user 弹偏差选项 / 用户选 b 后 01-plan.md 是否被改 + 留下 strikethrough 痕迹 / 03-review.md「§ 用户决策」段是否追加。

### V0.5.12（迭代一）：artifact diff 视图（snapshot + 内嵌 diff）（2026-05-25）

**背景**（用户痛点）：每次「再聊聊」让 AI 改 md 后、不知道哪些地方动了、需要重读长 artifact 找差异。

**核心设计**（用户拍板「第一版先简单」）：

```
后端 snapshot 机制：
  - phase-ack revise 分支、submitPhaseAck 前先 snapshotArtifact(taskId, phaseId)
  - 复制当前 artifact → data/tasks/<id>/artifacts/.revisions/<NN>-<phase>.<ISO>.md
  - meta.revisions[phaseId] 末尾追加 { timestamp, path, size }
  - 每 phase 上限 10 个、超出 GC 删最老（fs 文件 + meta 记录）
  - 仅覆盖「用户主动 revise」单一路径、agent 内部 edit 不触发——第一版聚焦最高频场景

前端 artifact-panel toolbar：
  - 加「正文 / Diff」切换（mode state、默认 content、保持 V0.5.11 hot-fix 简洁感）
  - Diff 模式下显示快照 dropdown（对比上次 / 初版 / 任意快照）+「行内 / 并排」切换
  - 顶部黄色 banner「✨ AI 刚修订了 N 处 [查看修改] [×]」在「有未看 revision」时浮现
  - banner「已看」状态走 localStorage（key: fe-ai-flow:artifact-revisions-seen:<taskId>:<phaseId>）
    不污染 task meta、不同浏览器各自独立（V0.5.12 第一版可接受妥协）

Diff 视图实现：
  - react-diff-viewer-continued 4.2.2、useDarkTheme=true（项目 next-themes forcedTheme="dark"）
  - compareMethod=WORDS_WITH_SPACE（词级 diff、对 markdown 段落级修改友好）
  - showDiffOnly=true 折叠未变行、hideSummary=true 隐藏 lib 自带顶部 bar
  - next/dynamic 懒加载（~36KB 库体积）、用户不切到 Diff 就不拉、First Load JS 270KB（V0.5.11 持平）
```

**新增 API**：

- `GET /api/tasks/[id]/artifact-revisions?phase=plan` → `{ revisions: ArtifactRevision[], current: { content, filename } | null }`
- `GET /api/tasks/[id]/artifact-diff?phase=plan&from=<ts>&to=<ts|current>` → `{ from: { content, timestamp }, to: { content, timestamp | null } }`
  - from / to 都用 timestamp 索引、不接 path 入参、防路径穿越

**新增组件 / 文件**：

- `src/components/tasks/artifact-diff.tsx` —— react-diff-viewer-continued 包装、props: oldText/newText/leftTitle/rightTitle/splitView
- `src/lib/server/task-fs.ts` 新增 `snapshotArtifact` / `listArtifactRevisions` / `readArtifactRevisionContent` / `readCurrentArtifact`
- `src/lib/task-store.ts` 加 `fetchArtifactRevisions` / `fetchArtifactDiff` client helper

**schema 扩展**：

- `Task.revisions?: Partial<Record<PhaseId, ArtifactRevision[]>>`
- `ArtifactRevision = { timestamp: number; path: string; size: number }`
- 老 task 没此字段、hydrate 时按 undefined 兜底、API 路由按 [] 兜底

**不做**（评估后 ROI 低、用户已拍）：

- ❌ rendered markdown + 段级高亮（手写段对齐算法易错、ROI 低）
- ❌ 双视图 split-view（artifact-panel 本就不大、拆栏挤）
- ❌ SDK toolCall 事件流 diff 卡片（事件流已拥挤、bash sed 拿不到 diff 不可靠）
- ❌ 覆盖「agent 自主 edit」（一版只覆盖用户主动 revise、最高频场景搞定就行）

**验证**：`pnpm typecheck` ✓ / `pnpm lint` ✓ / `pnpm build` ✓（23 routes 全编译、`/tasks/[id]` First Load 270 KB 跟 V0.5.11 持平）

**待联测**：跑一道真任务、plan 出方案 → 「再聊聊」改一处 → 等 AI 改完、看 banner 是否浮现、切 Diff 是否清晰看到红绿对比

---

### V0.5.11：系统瘦身 + 提示词重构 + 文档拆分（2026-05-23）

**背景**：用户拍板「整理 + 瘦身系统」三件事：①清死代码 ②重构 plan-runner 提示词拼接的三目运算地狱 ③扫不合理可优化的代码。

**Tier 1：死代码清理（5 处）**

- 删 `prompts/test-checklist-v0.3.5.md`（自标记 V0.3.6 该删、孤儿文件）
- 删 `src/app/api/tasks/[id]/run-plan/` / `start-chat/` / `rerun-phase/` 三个空路由目录（V0.2/V0.4 已迁走、目录留壳）
- 修 `plan-runner.ts` L847 死三目 `nextPhase ? "running" : "running"` → `"running"`

**Tier 2：plan-runner 提示词模板化**

- 新建 `prompts/_super.md`（~340 行、super-prompt 全模板化）
- `plan-runner.ts`：1651 → 1432 行（-219、-13%）
- `buildSuperPrompt()`：~443 → ~100 行（仅变量拼装）
- 抽 `buildForkBanner()` helper、`renderSuperPromptTemplate()`（空字符串保留字面、区别于 `fillTemplate`）
- 收益：以后改 prompt 文案改 `_super.md` 一处、不用碰 .ts

**Tier 3：event-stream.tsx 模块拆分**

- 原 890 行单文件 → 主文件 427 + `event-stream/utils.tsx` 188 + `event-stream/rows.tsx` 343
- utils：EVENT_LABEL / renderEventIcon / formatTs / mergeAdjacentThinking / summarize / meta 解析等纯函数
- rows：MarkdownText / StreamingAssistantRow / EventRow / AskUserRequestRow

**Tier 3 评估后不拆**（ROI 低）：

- `task-fs.ts`（1067 行）：结构已按功能段清晰分块、拆开需要 export 内部 helper 污染 public API
- `chat-mcp.ts`（1160 行）：核心是 stateful module（pendingMap / sessionTransports / awaitingNotifier 全 module-level）、拆需要把 state 提到 store class、改动面大风险高

**文档瘦身**：

- HANDOFF.md：2018 → ~300 行、拆出「当前架构快照」+「最近演进」窗口
- 新建 `docs/CHANGELOG.md`：1954 行、V0.2 ~ V0.5.9 全部演进档案、时间倒序（新在上）
- 写入规则化：新子版本先写 HANDOFF「最近演进」、再老一轮时迁到 CHANGELOG.md 顶部

**Hot-fix 4：artifact-panel 删「渲染 / 原文」切换（2026-05-25）**

- 用户反馈实际无看 raw markdown 的场景、保留切换徒增心智
- `artifact-panel.tsx`：删 `mode` useState / 「渲染 / 原文」两个 Button / `Code2`/`Eye` 图标 import / source 分支渲染
- toolbar 顶部只剩文件名、永远走 ReactMarkdown
- 净减 32 行

**验证**：`pnpm typecheck` ✓ / `pnpm lint` ✓ / `pnpm build` ✓（21 routes 全编译成功、10/10 static pages）

**下个迭代标记**：V0.5.12「artifact diff 视图」规划已对齐（见 `docs/ROADMAP.md`）、本轮代码 0 改动。

---

##### 补 V0.5.10：revise 交互二分类铁则 + Resizable 分栏（2026-05-23、用户拍板）

**背景**（用户原话）：「再聊聊的结果不可控、有时候 AI 是弹窗过来问问题、有时候是在事件流回答我、有时候甚至都不回答我就直接开始改 md、总之什么情况都有。这个交互需要统一」

V0.5.5 起 prompt 里写的是「A 明确改 / B 明确问 / C 含混 / D 带图」4 分类——动机本是「清晰直接干、模糊才 ask_user 复述」、但实操中标准模糊（什么算"明确改动指令"？什么算"明确询问"？）、AI 判得飘忽：

- 用户写「§3 加一行 X」明确改 → AI 大概率直接 edit（OK）
- 用户写「我觉得 §3 怪怪的」隐含改 → AI 可能弹 ask_user（OK）、也可能闷头改（炸）、也可能在事件流答疑（炸）
- 用户写「为什么这里这么写」纯疑问 → AI 大概率事件流答（OK）、偶尔弹 ask_user 复述（绕）

**用户体验**：每次再聊聊都是抽奖、不可预期。

**V0.5.10 设计**（用户拍板「二分类铁则、用户能预测 AI 行为」）：

```
按 feedback 是否纯疑问句、铁则 2 分类：

- 问类（纯疑问句、不含改动暗示）
  字面含「为什么 / 怎么 / 是不是 / 能否 / 为啥 / 是什么 / 干嘛 / 如何 /
       哪里 / 哪个 / 吗 / 呢 / ?」等疑问标记
  且 不含 改动暗示（无「改 / 删 / 加 / 调整 / 不对 / 怪怪的 / 再补 /
       详细点 / 优化」等动词或暗示）
  → 直接 emit assistant_message 答疑、不弹窗、不动 artifact

- 改类（其他所有 feedback、含模糊 / 兜底）
  含明确改动指令 / 含改动暗示 / 模糊看不懂
  → 先弹 ask_user 复述意图（固定模板「我打算 X、对吗?」、二选一 ✅/❌）
    用户 ✅ → 用 edit 改 artifact、按 _shared §5 留修改记录
    用户 ❌ 重说 → 当新一轮 revise feedback、重新走分类
    用户 deferred → 跳过本轮（不重问）
```

**判定护栏**（兜底偏改类）：判不准就当改类、走弹窗——错弹窗成本 1 click + 重说一句、错答疑成本「用户得再点再聊聊 + 重写指令」、明显改类更便宜。

**讨论过程的关键迭代**（用户多次拍板）：

1. **第一稿**：A 永远弹 ask_user 复述（含答疑场景也弹）。用户质疑「如果是事件流里在回答、突然弹个窗、不是打断用户行为吗」——撤回
2. **第二稿**：「动词白名单 → 改类、其他 → 问类」。用户质疑「我不一定非是动词啊、提示词是不是太刻板了」——撤回
3. **第三稿（落地）**：「疑问句白名单 → 问类、其他 → 改类（兜底偏改）」。判定标准是「疑问标记 + 无改动暗示」、改用「疑问标记」白名单替代「动词」白名单、覆盖更准（动词可能没出现、但疑问标记几乎稳定）

**用户的额外担心**：「prompt 是最不可控的、写不好总能带来些预期外的问题」。

针对性降风险动作（蓝军自检）：

- ✅ deferred 路径保留（用户点「稍后再补充」→ 跳过本轮、不重问）
- ✅ 带图先 read 保留（V0.5.4 治过、[ATTACHED_IMAGES] 必须先 read 转 vision 再分类）
- ✅ ask_user 说人话 / 禁公文体保留（V0.5.5 治过、禁词黑名单「[PHASE_ACK revise] / 反馈过短 / 无具体改进意图 / 待澄清」）
- ✅ 严禁趁机优化保留（问类不能偷偷动 artifact）
- ✅ ask_user options 用 `对` / `重说` 中文 id（不冲突 ask-user-dialog 字母前缀 A/B、它们是 letter prefix 不是 id）
- ✅ phase-1 §5.1（ask_user reply 分级）跟 §3（revise feedback 分类）拆开——之前 prompt 写「跟 §3 用同一套」是错引用、两个场景的「分级」根本不是同一回事

**改动文件**（共 6 处）：

- `src/lib/server/plan-runner.ts:402-456` super-prompt §3 revise 解读段（核心、~55 行重写）
- `src/lib/server/plan-runner.ts:L340 / L484` shell stdout 行解释 / §6 闭环段（同步换 2 分类描述）
- `src/lib/server/chat-mcp.ts:L84-86 / L543` 注释 + stdout 行解释（同步换）
- `prompts/_shared.md:L84` §5 修改记录段开头补「问类不留修改记录、改类才留」
- `prompts/phase-1-plan.md` / `phase-2-build.md` / `phase-3-review.md` 各 1 处 `[PHASE_ACK revise]` 处理段（同步换 2 分类、phrasing 按 phase 微调）
- `prompts/phase-1-plan.md:L141-143` §5.1 删除「跟 §3 revise 解读用同一套」错误引用、明确俩场景拆开
- `src/components/tasks/revise-dialog.tsx:L144-152` placeholder 反映新规则、让用户能预期 AI 行为

##### Resizable 分栏布局（V0.5.10、跟 prompt 改造一并落、用户拍板）

**背景**：「既然事件流要展示内容、那就还得优化优化了、可不可以加一个拖动条、可以拖动事件流模块的宽度」——纯疑问改 event-stream 答疑后、长答案需要更多横向空间、固定 `w-[400px]` 不够用了。

**用户拍板 3 个细节**：
- 默认比例：70 / 30（artifact / event-stream、跟当前接近）
- 边界：左 / 右 minSize 都 20%（双向可拖到极限、maxSize 80）
- 持久化：**存在 task 主体上**（不是 localStorage）——不同 task 可不同布局（调研类 task 偏大 event-stream / 改代码 task 偏大 artifact）

**实现**：

1. 装 `react-resizable-panels@4.11.1`（社区事实标准 5k★、shadcn 也用它、无 base-ui 同类替代）
2. `src/components/ui/resizable.tsx` shadcn-style stub：
   - ⚠️ 4.x API 跟 shadcn 文档（基于 2.x）已经不一样：`Group` / `Panel` / `Separator` 替代 `PanelGroup` / `Panel` / `PanelResizeHandle`、`onLayoutChanged(layout: Record<panelId, flexGrow>)` 替代 `onLayout(sizes: number[])`
   - re-export 三件套、保持 shadcn 命名（ResizablePanelGroup / ResizablePanel / ResizableHandle）方便心智模型一致
3. `Task.uiLayout = { artifactPanelSize?: number }` 加到 `types.ts` + `task-fs.ts` 的 `TaskMeta` + `hydrateTaskSummary`
4. `setTaskUiLayout` 持久化 API（`task-fs.ts`）：
   - 不写事件 / 不动 updatedAt（UI 偏好不算业务进展、避免污染时间线 / 自动归档计时）
   - 内置 [10, 90] clamp（防前端 bug 写出 -1 / 200）
5. `PATCH /api/tasks/[id]` 接 `uiLayout` 字段（返 `{ ok: true }` 不返完整 task、拖动期间高频不需要 round-trip 全量）
6. `task-store.ts` 加 `setTaskUiLayout(id, uiLayout)` client helper
7. `src/app/tasks/[id]/page.tsx` 主区双栏改 `<ResizablePanelGroup>`：
   - `defaultSize` 从 `task.uiLayout.artifactPanelSize` 读、没就 70
   - `onLayoutChanged` 拿 `layout["artifact"]`、debounce 500ms PATCH（双保险——onLayoutChanged 本身只在释放鼠标后触发、debounce 防用户连续点 reset / 快速拖几下也只发最后一次）
   - `key={task.id}`：切 task 时整个 Group 重建、defaultSize 重新生效（4.x 的 defaultSize 只在 mount 时读）
   - `minSize={20}` / `maxSize={80}` 双向约束

**验收点（用户实测）**：

1. 进 task 详情页、看到分栏中间有 1px 灰色 handle、hover 变主色 + 显示中间 grip 图标
2. 拖手柄、左右栏宽度实时变、释放后 500ms 内后端 meta.json 出现 `uiLayout.artifactPanelSize: <number>`
3. 刷新页面、布局保留
4. 切到另一个 task、再切回来、布局保留
5. 不同 task 之间布局独立、切换不串扰

##### V0.5.10 改动汇总

- 共 7 个源文件 + 5 个 prompt 文件、`pnpm typecheck` ✓ / `pnpm lint` ✓
- prompt 改动核心：plan-runner.ts super-prompt §3 + 4 个 prompt md 文件
- layout 改动核心：types.ts + task-fs.ts + route.ts + task-store.ts + page.tsx + ui/resizable.tsx + 新装 react-resizable-panels@4.11.1

##### ⚠️ 验证 prompt 必须新起 task（V0.5.10 验收踩坑、必记）

**super-prompt 在 `Agent.create()` 时一次性灌进 SDK Agent、之后 Agent.resume 不会重发**（plan-runner.ts L1068-69 注释明确）。

所以：

- **改 plan-runner.ts / \_shared.md / phase-X.md 任何 prompt → 已起的 task 永远拿不到新 prompt**
- 想验证 prompt 改动效果、**必须新建一个 task 从头跑**
- 已 awaiting_ack 的旧 task 点「再聊聊」、走的还是 task 创建时灌进去的旧 prompt——不是 prompt 写错了、是 prompt 根本没注入

**误判反例（V0.5.10 真实踩过）**：
- 23 日早上改完 V0.5.10 prompt、用户在 21 日起的旧 task 上点「再聊聊」、AI 行为还是旧 4 分类——用户以为「prompt 改坏了」、实际是旧 prompt 残留
- 排查 30 分钟才意识到 task createdAt < prompt mtime、是「prompt 没注入」不是「prompt 错」

**给接力 AI**：每次改 super-prompt 后、用户反馈「prompt 不生效」前先问一句「task 是改 prompt 前还是后起的？」、改后起的才有意义。

##### Resizable hot-fix 两轮（V0.5.10、用户实测拖不动当晚修）

**hot-fix 1：视觉/selector 问题**（用户：「拖不动」）

症状：用户拖左右分栏手柄拖不动、看不到明显的「拖动条」。

根因（挖到 react-resizable-panels 4.x library 源码）：

1. **Separator DOM 上没有 `data-orientation` 属性**——只有 `data-separator`（active/focus/inactive/disabled）+ `aria-orientation`（且值跟 Group orientation **相反**：horizontal group → separator aria-orientation=vertical）。我原本写的 `data-[orientation=vertical]:...` selector 全部不命中、纯 vertical group 视觉错乱（项目当前只用 horizontal、未踩到这部分）。
2. **视觉宽度太窄**：原本 1px 实体 + 4px hit region、用户根本看不到「这里能拖」、对不准就拖不动。
3. **`<Group>` 自带 inline style `display:flex; flexDirection:row; width:100%; height:100%; overflow:hidden`**——我原本用 className 包了一层冗余 `flex h-full w-full`、Group 还在源码里明确说「The following styles cannot be overridden: display, flex-direction, flex-wrap, overflow」、所以多余。

修复（`src/components/ui/resizable.tsx`）：

- ResizablePanelGroup 直 re-export `Group`、去掉所有 className（让 Group 自己控样式）
- ResizableHandle separator 视觉宽 → 1.5px、hit region → 2px（after pseudo）、grip 图标 `h-8 w-4` 更醒目
- selector 从 `data-[orientation=...]` 改成 `aria-[orientation=...]`、注意 separator 的 aria-orientation 跟 group orientation 相反
- 用 lib 自带 `data-[separator=active]` / `data-[separator=focus]` 走 state 颜色、删自定义 group/handle CSS group selector
- 加 `cursor-col-resize` / `cursor-row-resize` 明示鼠标态

**hot-fix 2：defaultSize 单位错（核心 bug）**（用户：「hover/active 有反应、但拖不动 panel」）

症状：手柄视觉已明显、hover/active 颜色切换正常、拖动时 separator 跟着鼠标走、**但左右 panel 完全没变化**。

根因：**4.x 的 `defaultSize / minSize / maxSize` 数字默认是 `px`、不是 `%`**！（lib.js:19-21：`case "number": return [e, "px"]`）

- 我原本传 `defaultSize={70} minSize={20} maxSize={80}` → 70px / 20px / 80px
- 在 1200px 视口里、panel 初始 70px、拖动范围 20-80px、相对视口只能动 60px、**用户视觉上几乎看不出变化**
- separator 自己 active 状态正常切换（事件正常）、看着「拖了但 panel 没变」是因为 panel size 已经卡在 maxSize=80px 上动不了

修复（`src/app/tasks/[id]/page.tsx`）：

- 改传字符串 `defaultSize={`${pct}%`} minSize="20%" maxSize="80%"` 显式百分比
- 字符串无单位 → `%`、`"70%"` 也 → `%`（lib.js:23 endsWith "%"）
- onLayoutChanged 拿到 `layout[panelId]` 已经是百分比（0..100、d.ts L43-45 确认）、可直接存 task.uiLayout.artifactPanelSize
- 删了 initialEventStreamSize、直接 inline `${100 - pct}%`、变量名 `artifactSizePercent` 更直观

**沉淀（避坑教训）**：

- ⚠️ react-resizable-panels 4.x 是 lib 4.0.0 breaking change（direction → orientation、PanelResizeHandle → Separator、defaultSize 默认单位 px）、跟 shadcn 文档基于 2.x 已经差太远
- 接入任何「数字尺寸」prop 前、必须查 source 确认默认单位、不能凭直觉
- 这种 bug 单测难发现（数字布局看不出错）、只能跑出来肉眼看「拖不动」

##### UX 精简（V0.5.10、用户实测当晚）

**1. 「再聊聊」placeholder 精简**：

之前 placeholder 写了 4 行「问类 / 改类」二分类规则——用户实测「不需要、系统该简洁」。

改成一行：「想改、想问、或者贴图说明（支持粘贴 / 拖拽）」。

沉淀到 `.cursor/rules/learned-conventions.mdc` 「UI 文案 / placeholder / 提示语简洁原则」段：placeholder 不超过一行、不把产品交互规则写进 placeholder、AI 行为规则在 prompt 里、用户用 1-2 次就懂、不要塞输入框。

**2. revise 复述 ask_user options 简化**：

之前固定模板：
- `id=对`、`label=「✅ 对、按你说的来」`
- `id=重说`、`label=「❌ 不对、我重新说」`

用户实测：「不对、我重新说」选了无法输入、要点确认 → 退出 → 再点「再聊聊」 → 重写——4 步换 1 件事、纯属多余。AskUserDialog UI 自带「自定义回答」就是「不同意 / 想重说」的入口。

改成只留 1 个 option（label 进一步精简到 2 字、用户拍板「同意」最中性通用）：
- `id=同意`、`label=「✅ 同意」`

用户想改 / 重说就走 UI 自带的「自定义回答」textarea。

**3. AskUserDialog「以上都不是 / 自定义回答…」→「自定义回答」**：

文案精简、不要「以上都不是」赘述。

**4. 加严 ask_user prompt 约束**：

`plan-runner.ts ask_user 段` 加一条：「严禁在 options[] 里塞『不对 / 不同意 / 重新说 / ❌』这类否定选项——UI 自带『自定义回答』就是入口、你列了 `id=不对` option 用户点了也无法继续输入、纯属多余」。

之前已经有「严禁塞『其他 / Other / 自定义』」约束、这次补「严禁塞『不对 / 否定』」、收紧死按钮陷阱。

**V0.5.10 待办（接力 AI / 用户实测）**：

1. **revise 二分类规则测**（重点、用户最担心的就是 prompt）：
   - ⚠️ **必须新建一个 task**——旧 task 拿不到新 prompt（见上方「验证 prompt 必须新起 task」段）
   - 新 task 跑到 plan ack、点「再聊聊」、试三种话验证 AI 行为：
     - 明确改：`§5 把 useState 改成 useReducer` → 弹 ask_user 复述意图、user ✅ 后改 artifact
     - 纯疑问：`§5 为什么用 useState 不用 useReducer？` → 直接事件流 emit assistant_message 答疑、不弹窗
     - 模糊：`§5 怪怪的` → 弹 ask_user 复述意图（兜底改类）
   - 看 ask_user options 是否只有 `对` / `重说`、question 是否说人话不带协议名
   - 看带图 case：发图 + 简短文字、AI 是否先 read 图再判分类
   - 看 deferred case：弹 ask_user 后点「稍后再补充」、AI 是否跳过本轮 revise、不重问
2. **resizable 拖动测**（hot-fix 后再测）：
   - 拖手柄、artifact / event-stream 宽度实时变
   - 释放鼠标后 ~500ms 内 `data/tasks/<id>/meta.json` 出现 `uiLayout`
   - 刷新页面、布局保留
   - 切 task / 回 task、布局保留
   - chat 模式没有 resizable（设计如此、chat 模式整页 ChatView、不分栏）


##### 补 V0.5.9：task 仓库字段单值 → 数组、多仓 cwd 走公共父目录（2026-05-22 晚、用户拍板）

**背景 / 触发**：

用户实操中遇到「一个需求涉及两个项目都要改代码」的场景。原架构 `task.repoPath: string` 只接受一个仓库、SDK Run cwd 也只能指向一个目录、跨仓需求只能拆 task 或者手动 cd——不够顺手。

经多轮场景澄清确认：用户的两个项目都在 `~/Documents/wukong/` 下、都要 AI 写代码、对边界 case（跨父目录）不想加严格限制。

**架构方案**：

```
Settings 配多个 repo（已有）→ 新建 task UI 多选 → task.repoPaths: string[]
                                                       ↓
                              getEffectiveCwd(repoPaths)
                              （单仓 = 仓自身、多仓 = 公共父目录）
                                                       ↓
                              SDK Run local.cwd = effective
                                                       ↓
                              AI 视角下面挂 N 个 git 子仓、路径首段是仓名
```

**改动**：

1. **数据层**
   - `src/lib/types.ts`：`Task.repoPath: string` → `Task.repoPaths: string[]`、`NewTaskInput` 同步
   - `src/lib/server/task-fs.ts:TaskMeta`：保留 `repoPath?: string` 字段标 `@deprecated`、`hydrateTaskSummary` 兼容兜底（老 meta 自动包成 `[repoPath]`）、`createTask` 新数据只写 `repoPaths`

2. **路径工具（`src/lib/path-utils.ts` 新加）**
   - `getCommonParentDir(paths)`：算多个绝对路径的最长共同前缀目录、用于 effective cwd
   - `getEffectiveCwd(repoPaths)`：单仓 = 仓自身、多仓 = `getCommonParentDir`
   - `getRepoShortNames(repoPaths, cwd)`：算每个仓相对 cwd 的短名（多仓 prompt 列子目录用）
   - `formatRepoSectionForPrompt(repoPaths)`：渲染 super-prompt「任务输入 - 仓库段」、单仓 / 多仓自动切换文案 + 多仓附路径约束 + git 命令 cd 子仓说明
   - `buildCursorLink` 第二参数从 `repoPath` 重命名为 `baseDir`（语义改为「effective cwd」、单仓 / 多仓通用）

3. **API**
   - `src/app/api/tasks/route.ts:POST`：body schema `repoPath` → `repoPaths`、`sanitizeRepoPaths` 校验非空数组

4. **UI（`src/components/tasks/new-task-dialog.tsx`）**
   - `repoPath: string` state → `repoPaths: string[]` state
   - 单 Select 控件 → 自实现 `RepoMultiSelect` 子组件（基于 base-ui Popover）：trigger 视觉对齐 shadcn Select、点击展开 Popover、内部 checkbox 列表多选
   - trigger 显示：0 个 = 占位文案、1 个 = 仓名 + 路径、多个 = 「已选 N 个 + projA + projB」
   - 多仓选中时 dialog 下方显示「多仓场景：agent cwd = 公共父目录」说明
   - canSubmit 校验 `repoPaths.length > 0`
   - **迭代记录**：第一稿做了 `ChoiceButton shape="card"` 2 列网格、用户实测反馈「仓库多时铺满屏、要 Select 那种紧凑」、当天迭代成 Popover-style multi-select

5. **后端 runner**
   - `plan-runner.ts` / `chat-runner.ts`：SDK Run `local.cwd` 从 `task.repoPath` → `getEffectiveCwd(task.repoPaths)`
   - prompt fillTemplate 的 `{{repoPath}}` 值改为 effective cwd（语义改为「agent cwd」、单仓行为不变）
   - super-prompt「任务输入」段用 `formatRepoSectionForPrompt` 渲染、单仓 = 一行「仓库根目录」、多仓 = 公共父目录 + 子仓清单 + 路径 / git 命令约束
   - `loadSkills` 接 effective cwd（多仓时跨仓 skill 后续真踩到再聚合）

6. **UI 显示层**
   - `src/lib/task-display.ts` 加 `formatRepoPathsForDisplay(paths)`：0 个 = 「(未配置仓库)」、1 个 = 完整路径、多个 = basename 用 ` + ` 拼
   - `task-card.tsx` / `app/tasks/[id]/page.tsx` 头部用这个 helper、hover tooltip 显示完整路径列表
   - `artifact-panel.tsx` prop `repoPath` 重命名 `baseDir`、`page.tsx` 传 `getEffectiveCwd(task.repoPaths)`
   - `event-stream.tsx` 文件选择器 `initialPath` 同步用 effective cwd

7. **prompt（`prompts/_shared.md` 小改）**
   - 顶部占位符注解加 V0.5.9 注：`{{repoPath}}` 语义改为「agent effective cwd」
   - §3 path 完整路径写法：第 1 条「从仓库根 ...」改成「从 agent cwd（即 `{{repoPath}}`）...」、段末加一段「V0.5.9 多仓场景：路径首段必须是子仓目录名」
   - §7 命令 / 端口自检：`{{repoPath}}/package.json` 加多仓注「多仓时读对应子仓 `{{repoPath}}/<repo>/package.json`」
   - **phase-1/2/3 prompt 不动**：super-prompt 顶部「任务输入」段已经按单 / 多仓自动渲染、AI 看上下文自然知道仓库结构；遵循「新约束 ≤ 3 行写完」原则、不大改 phase prompt 字眼

**收益**：

- 用户一个 task 能覆盖跨仓需求、不用拆 task / 不用手动 cd
- 单仓行为完全兼容（getEffectiveCwd 返仓自身、prompt 文本「仓库根」字眼仍然准确）
- 多仓时 AI 在公共父目录工作、写 `projA/path/...` 形式的路径、cursor link 自动拼回绝对路径、点击跳转 OK
- 老任务自动兼容（`hydrateTaskSummary` 把 `repoPath` 包成 `[repoPath]`、不删旧数据）

**边界**：

- **跨父目录多仓**（如 `~/Documents/A` + `~/Other/B`）：commonParent 算到 `~` 或更上、SDK cwd 设到这种宽目录、AI 多 read 几层才能看到仓——按用户拍板**走宽松**、不报错（V0.5.9 不做边界检查）
- **多仓 git 命令**：`{{repoPath}}` 是父目录、不在 git 仓库里、AI 跑 `git diff` 必报错——prompt 里 super-prompt 顶部「任务输入」段明确说「git 命令必须 cd 到对应子仓」、AI 看到这段自然遵守
- **多仓 skill**：当前 `loadSkills(cwd)` 只扫一个目录、多仓时只看公共父目录的 `.cursor/skills`——子仓里的 skill 暂时看不到、不阻塞使用（fe-ai-flow 内置 skill 走绝对路径加载、不依赖 cwd）

**总改动**：

- `src/lib/types.ts` / `src/lib/path-utils.ts` / `src/lib/task-display.ts` / `src/lib/server/task-fs.ts` / `src/lib/server/plan-runner.ts` / `src/lib/server/chat-runner.ts`
- `src/app/api/tasks/route.ts` / `src/app/tasks/[id]/page.tsx`
- `src/components/tasks/new-task-dialog.tsx` / `src/components/tasks/artifact-panel.tsx` / `src/components/tasks/task-card.tsx` / `src/components/tasks/event-stream.tsx`
- `prompts/_shared.md`
- 共 ~13 个源文件 + 1 个 prompt 文件、`pnpm typecheck` ✓ / `pnpm lint` ✓

##### V0.5.9 hot-fix（用户实测、当天迭代）

1. **UI 第一稿 card grid 改成 Popover multi-select**：用户反馈「仓库多时铺一大片占空间、要 Select 那种紧凑」——当天换成 base-ui Popover + checkbox 列表、trigger 视觉对齐 shadcn SelectTrigger。

2. **`MultiSelect` 抽到 `src/components/ui/multi-select.tsx`**：用户拍板「典型组件就该抽出来、不要刻板的遵守『复用 ≥ 2 才抽』规则」、当天 generic over `T`、render props API（`getKey` / `renderOption` / `renderTrigger` / `placeholder`）。`new-task-dialog.tsx` 删内部 `RepoMultiSelect`、inline 调用通用版。已写进 `learned-conventions.mdc` 抽象门槛例外段。

3. **Dialog 内长内容溢出 fix**（用户实测踩到、附截图）：上下文文档列表里贴超长 chat 文本时、预览那一行撑破 dialog 右边界、textarea 粘日志也被撑宽。三层根因 + 三层修法（一次到位）：
   - **DialogContent 是 grid、grid item 默认 `min-width: auto` 跟内容撑**：`src/components/ui/dialog.tsx` DialogContent className 加 `*:min-w-0`（Tailwind 4 短写、等价 `[&>*]:min-w-0`）——所有 grid item 自动获得 min-w-0、被 max-w-lg 真正 cap 住。**所有 dialog 调用方自动受益、不用单独加**。
   - **`truncate` 在 flex item 上失效**：`context-docs-panel.tsx` 的 truncate span 加 `min-w-0`（dialog 兜底只覆盖第一层 grid item、嵌套 flex 的 truncate 还要自己加）。
   - **Textarea `field-sizing: content` 撑破父**：`src/components/ui/textarea.tsx` 加 `min-w-0 max-w-full wrap-anywhere`。所有 textarea 调用方自动受益。
   - 同步写进 `learned-conventions.mdc` 「Dialog 内长内容溢出」段、避免下次再踩。第一稿只 fix 后两条、用户实测仍然撑破、追加第一条 dialog 层兜底才彻底解决。

**V0.5.9 待办（接力 AI / 用户实测）**：

1. **多选 UI 测**：新建任务 dialog 仓库段、点 trigger 展开 Popover、点 2 个仓库都能选中、再点取消、trigger 显示「已选 N 个 + projA + projB」
2. **多仓 SDK Run cwd 测**：起一个多仓 task、看 plan-runner 日志里 `Agent.create({ local: { cwd: <commonParent> } })`、cwd 是公共父目录、不是其中某个仓
3. **多仓路径首段仓名测**：跑 plan + build、看 artifact 里 AI 写的文件路径是不是 `<repo>/<rest>` 形式（不是直接 `<rest>` 漏了仓名前缀）、点击能跳 Cursor 打开
4. **多仓 git 命令测**：跑 build / review、看 AI 跑 `git diff` 时是否先 `cd <repo>` 再跑（不是在父目录直接跑 git 报错）
5. **老任务 hydrate 测**：用户之前的单仓 task 详情页应该正常显示、不报「repoPath undefined」
6. **跨父目录多仓 case**：用户主动选 2 个不在同一父目录的仓、看 commonParent 是不是算到 `/` 或 `~`、SDK Run 是否能起（按设计宽松）

##### 补 V0.5.8：artifact 间引用走前端 tab 切换（2026-05-22、上述方案 B 落地）

**背景 / 触发**：

V0.5.7.7 hot-fix 段遗留候选——三 phase prompt 里有约 66 处「01-plan.md」「02-build.md」「03-review.md」裸文件名引用、`looksLikePath`（`src/lib/path-utils.ts`）要求路径含 `/` 才算 path、artifact 渲染时这些文件名只是普通 inline code、点不开。

选方案 B（前端识别 + tab 切换）、不动 prompt——prompt 保持简洁、AI 继续写「01-plan.md §4」就好、渲染层接管识别 + 切 tab。

**改动**：

1. `src/lib/path-utils.ts` 加 `looksLikeArtifactRef(s)`：
   - 正则 `^\d{2}-([a-z]+)\.md$`、匹配后用 `PHASE_IDS`（`src/lib/types.ts`）校验 phaseId 合法性
   - 返 `PhaseId`（让调用方按 phaseId 切 tab）、不返序号——序号会随 workflow 增删 phase 漂移、phaseId 是稳态锚点
   - 长度 cap 50、避免误判超长代码片段
2. `src/components/tasks/artifact-panel.tsx`：
   - `Props` 加可选 `onArtifactRefClick?: (phaseId: PhaseId) => void`
   - `buildMarkdownComponents` 接收同名参数、`code` 渲染时**优先** `looksLikeArtifactRef`、命中 + 回调存在 → 渲染成可点 `<button>`（蓝色 + hover 下划线、跟 cursor:// 链接视觉同款）、`onClick` 调回调
   - 不命中再走原 `looksLikePath` 分支（保留 cursor:// deep link 跳转）
3. `src/app/tasks/[id]/page.tsx`：`<ArtifactPanel onArtifactRefClick={setActivePhase} />` 一行接通

**收益**：

- 用户看 review artifact 里写「详见 `01-plan.md` §4」直接点过去、跳到同 task 的 plan tab、不需要手动切顶部 phase 切换条
- prompt 维持简洁（不引入 `data/tasks/{{taskId}}/artifacts/` 这种又长又丑的路径）、AI 写起来心智负担不变
- 实现成本低（path-utils +30 行 helper / artifact-panel +15 行渲染分支 / page +1 行 prop 传递）、风险窄
- 跟现有 `looksLikePath` + cursor:// 跳转互补——一个识别同 task 内 artifact、一个识别仓库内文件路径、各管一段、不冲突

**边界**：

- 切到 `pending` 状态的 phase tab（例如在 build artifact 里点 `03-review.md`、但 review 还没跑）→ `ArtifactPanel` 已有「该 phase 还未启动」占位、自动兜底、无需特殊处理
- 没传 `onArtifactRefClick` 的纯展示场景 → artifact ref 退化成普通 inline code、不可点、不报错
- 未来 workflow 加新 phase（如 `deploy`）→ 只需要 `PHASE_IDS` 加一项、`looksLikeArtifactRef` 自动识别、无需改 `path-utils` 正则

**单文件改动**：`src/lib/path-utils.ts` + `src/components/tasks/artifact-panel.tsx` + `src/app/tasks/[id]/page.tsx` + `docs/HANDOFF.md`、`pnpm typecheck` ✓ / `pnpm lint` ✓。

**V0.5.8 待办（接力 AI / 用户实测）**：

1. **可点测**：起 task 跑完 review、看 review artifact 里 `01-plan.md` / `02-build.md` 引用是否渲染成蓝色按钮、点击切到对应 tab
2. **样式校验**：button hover 是否带下划线、跟 cursor:// 路径链接视觉同款
3. **prompt 里漏 backtick 的 case**：如果 prompt 写 `01-plan.md`（无反引号）、不会被 react-markdown 当 inline code 渲染、识别不到——`grep '0[123]-(plan|build|review)\.md' prompts/` 看是否所有引用都加了反引号、没加的补一下


### V0.5.7：统一推进入口（合并继续监听 + 重启 workflow、解 ENHANCE_YOUR_CALM 死局、2026-05-20 中午）

V0.5.6.5 跑下一份 plan 时、用户在 build phase 后 wait-ack 长连接断、点「继续监听」→ Cursor backend 返 `NGHTTP2_ENHANCE_YOUR_CALM`（HTTP/2 错误码 0xb、服务端要求降速、典型场景是 agent 在 backend 已被清理）。`/resume-waiting` 路由抛 `agent run status=error`、task=failed。

**死局**：之前的 UI 只有两个按钮 ——「继续监听」（Agent.resume）和「重启 workflow」（Agent.create 从 plan 头）。resume 路径死、剩下唯一可走的「重启 workflow」会从 plan 重头跑、**已经写完的 plan / build artifact 被覆盖**——用户原话「重启只能从第一步开始」。

#### 1. 用户拍板：方案 D（一按钮 + 智能 dialog）

| 旧 | 新（V0.5.7） |
|---|---|
| 两个按钮：「继续监听」+ 「重启 workflow」（用户视角技术细节） | 一个按钮：「推进」、打开 AdvanceDialog 让用户选 mode |
| 「重启 workflow」固定从 plan 头 | dialog 内三选项：resume / fork from phase / restart from plan |
| `/resume-waiting` 独立路由 | 合并到 `/start-workflow`（body 加 `mode + fromPhase`、向后兼容 mode 缺省 = restart） |
| resume 失败抛错、task=failed、用户手动 | plan-runner catch 块检测 `NGHTTP2_ENHANCE_YOUR_CALM` / `Stream closed`、自动降级 fork（fromPhase=currentPhase）、用户视角一次推进就能续走 |

#### 2. 三种推进模式（mode）

| mode | 后端动作 | 适用场景 | 成本 |
|---|---|---|---|
| `resume` | `Agent.resume(lastAgentId)` + send 续接 prompt、保留对话历史 | wait-ack 长连接刚断、agent 在 backend 仍活着 | +1 send 配额 |
| `fork` | `Agent.create` 新 agent + super-prompt 顶部 fork banner、从 `fromPhase` 起跑、上游 artifact 复用 | 原 agent 已死、想从指定 phase 续走（默认 = 下一未 ack）/ 测试新模型 | +1 send 配额 |
| `restart` | `Agent.create` 新 agent 从 plan 完全重跑、**覆盖现有 artifact** | 改 prompt 大改动后想看一遍纯净重跑 | +1 send 配额 |

#### 3. resume 自动降级 fork（plan-runner catch 块）

```ts
// plan-runner.ts catch 块
const isEnhanceYourCalm = message.includes("NGHTTP2_ENHANCE_YOUR_CALM") ||
                          causeMessage.includes("NGHTTP2_ENHANCE_YOUR_CALM");
const isStreamClosed = causeMessage.includes("Stream closed") ||
                       causeMessage.includes("ERR_HTTP2_STREAM_ERROR");
const shouldFallbackFork = isResume && (isEnhanceYourCalm || isStreamClosed);

if (shouldFallbackFork) {
  // 不写 task=failed、不发 done 事件——保 SSE 流开着
  await writeEventAndPublish(task.id, {
    kind: "info",
    text: "原 agent 在 Cursor backend 已被清理（NGHTTP2_ENHANCE_YOUR_CALM）\n自动降级为「起新 agent 从当前 phase 接力」",
  });
  fallbackFork = { fromPhase: task.currentPhase };
}
// finally 块末尾 setTimeout 0 → runPlanWorkflow({ fork: { fromPhase } })
```

#### 4. 改动文件清单

| 文件 | 改动 |
|---|---|
| `src/app/api/tasks/[id]/start-workflow/route.ts` | 重写。body 加 `mode + fromPhase` 入参、内部按 mode 分发：resume → 拼 resumePrompt + Agent.resume；fork → runPlanWorkflow({ fork })；restart → 老路径。`mode=resume` 缺 lastAgentId 时自动降级 fork（fromPhase=currentPhase）；**isPlanRunning + task.status 是终态（draft/failed/completed）→ stale state、调 `forceClearStaleRunnerState` 自愈**（避免「点启动按钮无反应」） |
| `src/app/api/tasks/[id]/resume-waiting/route.ts` | **删**（V0.5.7 合并到 /start-workflow） |
| `src/lib/server/plan-runner.ts` | catch 块加 ENHANCE_YOUR_CALM / Stream closed 检测、isResume 命中时不写 failed 改写 info 提示降级、finally 末尾 setTimeout 0 调度 runPlanWorkflow({ fork })；fallbackFork 局部 state；**新加 export `forceClearStaleRunnerState(taskId)`**：暴力 delete runningPlans + forkPendingTasks entry、给 start-workflow 路由清 stale in-memory state 用；注释里 /resume-waiting 字样同步刷成 /start-workflow（mode=resume）；早退提示文案「重启 workflow」改「推进」 |
| `src/lib/task-store.ts` | startWorkflow 加 options（mode + fromPhase）参数；删 resumeWaiting；新加 `StartWorkflowMode` 类型 export |
| `src/components/tasks/advance-dialog.tsx` | **新建**。3 个 ChoiceButton（resume / fork / restart）+ fork 选项内嵌 phase chip 切换；默认值智能：resume 可用且非 draft → 默认 resume；其它 → fork；fromPhase 默认 = inferNextUnackedPhase(task) |
| `src/app/tasks/[id]/page.tsx` | 删「继续监听」按钮 + handleResumeWaiting + canResume + startLabel；加 advanceDialogOpen state + handleAdvance(mode, fromPhase) + handleAdvanceClick（draft 直接 restart、其它弹 dialog）；JSX 末尾挂 `<AdvanceDialog />`；删 useDialog import（不再用 confirm） |
| `src/lib/types.ts` | 加 `PHASE_IDS` 运行时数组（给 fromPhase 校验用）；lastAgentId 注释刷成「/start-workflow（V0.5.7 mode=resume）」 |
| 注释扫尾 | `src/lib/server/chat-mcp.ts` + `src/hooks/use-task-watch.ts` + `src/lib/server/task-fs.ts` + `src/app/api/tasks/[id]/wait-ack/route.ts` 4 个文件 6 处「/resume-waiting」 / 「继续监听」 / 「重启 workflow」字样同步刷 |

`pnpm typecheck` ✓ / `pnpm lint` ✓ 双绿。

#### 5. UX 流程对照（用户视角）

**旧 V0.5.6.x（用户原话「重启只能从第一步开始」）**：
```
wait-ack 断 → task=failed → 看到「继续监听」+ 「重启 workflow」两个按钮
  ├ 点「继续监听」→ resume → backend 拒 → 死局
  └ 点「重启 workflow」→ 从 plan 重跑 → 覆盖现有 artifact
```

**新 V0.5.7**：
```
wait-ack 断 → task=failed → 看到一个「推进」按钮
  └ 点「推进」→ AdvanceDialog 三选一：
       (•) 让原 agent 继续推进（默认、推荐）
            └ 后端 resume；失败 → 自动降级 fork(fromPhase=当前 phase)
       ( ) 从指定 phase 重启
            └ phase chip 切换（默认 = 下一未 ack）、上游 artifact 复用
       ( ) 从头完全重跑（覆盖现有 artifact）
```

##### 补丁：fork 时 reset 下游 phase（V0.5.7、2026-05-20 下午）

**bug**：fork 到 build 重启后、UI 上 review 还是「待确认」——因为 fork 路径只 patch `fromPhase` 自身、没碰下游 phase、`review` 上一轮 agent 留下的 `awaiting_ack` 状态没被清掉。

**修**：`plan-runner.ts` 的 `isFork` 分支里、在 patch `fromPhase` 为 running **之前**、先把 `fromPhase` 之后的所有 phase 全部 reset 为 pending：

```ts
const fromIdx = workflowDef.phases.indexOf(fork!.fromPhase);
const downstreamPhases = workflowDef.phases.slice(fromIdx + 1);
for (const pid of downstreamPhases) {
  await patchPhase(task.id, { phaseId: pid, status: "pending" });
}
```

这样 fork build 后 UI 显示 plan=ack / build=running / review=pending、跟实际进度对齐。

##### 补丁 V0.5.7.1：fork reason textarea + fix mode 提示（2026-05-20 下午）

**问题**（用户提）：方案再细、build 总会有 bug；fork 「从 build 重启」时、上一轮代码已经在仓库 / 上一轮 02-build.md 已经在硬盘、AI 会不会傻乎乎 **rewrite** 已有产物？

**当前实现现状**：
- forkBanner 只说「**上游 phase** 的 artifact 别重做」、**没说当前 phase 也可能有上一轮产物、要当成 fix 模式增量改**
- `fork.reason` 字段在路由里写死「用户主动 fork 从 phase X 重启」、用户根本没机会写具体「修什么 bug」

**改进（V0.5.7.1）**：

1. **AdvanceDialog 的 fork 选项加 textarea**：用户选「从某 phase 重启」时下面出一个 textarea「这次主要想修什么？（bug 描述、可留空、AI 会自己看 git diff）」
   - 用户填了 → 透传到后端、forkBanner 拼上「**本次 reason（用户描述要修的点）：xxx**」
   - 用户留空 → 默认 reason「用户主动 fork 从 phase X 重启」（兼容老路径）

2. **forkBanner 加 fix mode 判定段**：让 AI 自己 read 一下「当前 phase 的 artifact 路径」、然后按条件分支：
   - **如果 artifact 存在且非空** → fix 模式、read 旧 artifact + 跑 git diff（build 特别提醒）、**不要 rewrite、按 reason 增量改、用 `edit` 而非 `write`**
   - **如果 artifact 不存在** → 上一轮没跑到、按 phase 指令正常做

3. **数据流**：
   ```
   AdvanceDialog (用户填 reason) →
     task-store.startWorkflow({ reason }) →
       /api/tasks/[id]/start-workflow (body.reason) →
         runPlanWorkflow({ fork: { fromPhase, reason: "用户主动 fork 从 X 重启、想修：<用户填的>" } }) →
           buildSuperPrompt → forkBanner 拼到 super-prompt 顶部
   ```

4. **理想工作流（用户跑出 bug 后）**：
   ```
   跑代码 → 发现 bug A B C → 回 task 详情点「推进」→
     dialog 选「从 build 重启」+ textarea 填 "A B C" →
   AI fork build 起、read 旧 02-build.md + 跑 git diff、按 A B C 定向 edit、不 rewrite →
   ack → 再跑 verify → 还有 bug 继续 fork、直到干净 → ack 进 review
   ```

**关键代码改动**：
- `src/lib/task-store.ts` `StartWorkflowOptions` 加 `reason?: string`
- `src/app/api/tasks/[id]/start-workflow/route.ts` `PostBody.reason`、fork 分支拼 `finalReason`
- `src/components/tasks/advance-dialog.tsx` fork 选项展开后追加 `<Textarea>` + `onSubmit` 增加 `reason` 参数
- `src/app/tasks/[id]/page.tsx` `handleAdvance` 增加 `reason` 参数、透传给 `startWorkflow`
- `src/lib/server/plan-runner.ts` forkBanner 增加「关于本次 \`${fromPhase}\` phase（fix 模式判定）」段、build 特别提示跑 git diff、按 reason 是否填了分两种引导措辞

##### 补丁 V0.5.7.2：修改记录段 + 禁用内部技术词 + Task 完成情况同名段修正（2026-05-21 下午）

**问题**（用户提）：用户跑 V0.5.7.1 fix mode 联测、看到 AI 修完 bug 后在 `02-build.md` 顶部自行加了一段 `## Fork 修复（build phase 重启）`、底下挂多条 `revise: <标题>` + 「改动 / 内容」自由格式。用户原话：

> 「Fork 修复这个是什么意思、没太懂。可以去掉。其它的按你想得来吧、规范下。保证规范、简洁」

**根因分析**：

| 层 | 现状 | 问题 |
|---|---|---|
| `prompts/phase-2-build.md:113` | 只写「改完更新 02-build.md」、没规定写在哪、什么格式 | AI 自由发挥成顶置 `## Fork 修复` + `revise: xxx` |
| `prompts/phase-2-build.md` 骨架 | 没预留「fix log 段」 | AI 自己造段名 |
| `src/lib/server/plan-runner.ts` fix mode 第 5 条 | 「edit 而非 write、追加 / 修正局部」泛泛、没指明追加到哪 | AI 顶置造段 |
| 用户视角 | artifact 出现「Fork」「revise」等内部技术词、看不懂 | artifact 是给用户和 review agent 看的、不该有内部黑话 |

**额外发现**：`phase-2-build.md` 骨架里 line 129 和 line 170 都叫 `## Task 完成情况`、是 V0.5.5 删除「验收对照」表时遗留的重名 bug——line 170 实际语义是「验收对照」表、本次顺手修正。

**修法**：

1. **`prompts/phase-2-build.md` 骨架加 `## 修改记录` 段**（位置：`## 验收对照` 之后、`## 给用户的交接` 之前）：
   - 只有用户反馈触发修正才写本段、初次 happy path build 不写（整段省略）
   - 用「### 修改 N」三级标题 + 三字段（用户反馈 / 改动文件 / 概要）
   - ⛔ 严禁新建顶层标题（「## Fork 修复」「## Revise」「## 重启修复」等）
   - ⛔ 严禁出现「fork」「revise」「再聊聊」等内部技术词
   - ⛔ 严禁复述「Task 完成情况」「改动文件清单」段
2. **`prompts/phase-2-build.md` line 113 revise 处理段**改成显式指明「A 路径改完代码后用 edit 把本轮修正追加到 02-build.md 的 ## 修改记录 段末尾、按骨架格式」
3. **`src/lib/server/plan-runner.ts` fix mode 第 5 条按 phase 分流**：
   - `build` → 追加到 `## 修改记录` 段末尾、明示 3 禁
   - `plan` → 内联 `> ✅ 已确认：xxx` 留痕（参考 phase-1-plan §1 顶部规则）
   - `review` → 追加到 `## 修改记录` 段末尾（V0.5.7.4 统一规则、跟 build 同套）
   - 拆出第 6 条「写完调用 wait_for_user 让用户验收」、独立步骤更清晰
4. **`prompts/phase-2-build.md` line 170 `## Task 完成情况` 改成 `## 验收对照`**——修正 V0.5.5 删表时遗留的同名段 bug

**改动文件清单**（3 文件、净 +35/-7 行）：

| 文件 | 改动 |
|---|---|
| `prompts/phase-2-build.md` | 骨架加 `## 修改记录` 段 + 4 条禁律；line 113 revise 处理改成显式指向 ## 修改记录；line 170 `## Task 完成情况` → `## 验收对照` |
| `src/lib/server/plan-runner.ts` | forkBanner fix mode 第 5 条按 phase 分流、build 明示 ## 修改记录 + 3 禁、plan/review 内联留痕；拆出第 6 条 wait_for_user |
| `docs/HANDOFF.md` | 加本节 |

`pnpm typecheck` ✓ / `pnpm lint` ✓ 双绿。

**关键决策记录**：

| 决策点 | 用户拍板 | 备选 / 否决理由 |
|---|---|---|
| fix log 写不写 artifact | **写**（保留 V0.5.7.1 设计） | 否决「只动代码不写 log、靠 git log/diff 留痕」——artifact 是 review agent 读 build 的唯一入口、fix 不留痕 review 看不到上下文 |
| fix log 段位置 | **artifact 末尾** | 否决顶置——artifact 主体是「本次 build 报告」、fix log 是次要历史、不该挤掉主体 |
| 段名 | **「修改记录」**（中文、无技术词、用户拍板） | 否决「Fix 历史」「Revise 历史」「调整记录」——artifact 给用户读、不出现技术词；「修改」比「调整」更直白 |
| 一致性范围 | **plan / build / review 三 phase 都改**（fix mode 提示按 phase 分流） | 否决「只改 build」——三 phase 都可能 fork 修复、都需要规范、但段名只 build 强制（plan / review 用既有内联机制） |

**V0.5.7.2 待办（用户测试）**：

- **build 修改记录段格式测**：跑一道 task 到 build ack、点「再聊聊」反馈一个 bug、看 AI 是否：
  1. 不再造「## Fork 修复」顶层标题
  2. 把修正追加到 `## 修改记录` 段末尾、用「### 修改 1」三级标题
  3. 三字段（用户反馈 / 改动文件 / 概要）齐全
  4. artifact 里不出现「fork」「revise」「再聊聊」字样
  5. **不在 task 子条里塞「revise / 修复」子字段**（V0.5.7.3 补、`## Task 完成情况` 顶部加约束）
- **fork build 重启同测**：从 build 重启 + textarea 填 reason、看 AI 写「修改记录」格式是否一致（不是另起一段「## 重启修复」）

##### 补 V0.5.7.3：Task 完成情况字段禁塞 revise 子字段（2026-05-21 下午、V0.5.7.2 联测时补）

V0.5.7.2 改完用户跑了一道 task、回看 02-build.md 发现 fix log 被 AI 拆成两处写：
- 顶部「## Fork 修复（build phase 重启）」段下 10+ 条 `### revise:`（V0.5.7.2 已修）
- `## Task 完成情况` 段下 Task 1 / Task 4 子条**字段里又塞了一行「**revise 修复**：xxx」/ 14 条 `revise:`**（V0.5.7.2 没覆盖）

**根因**：V0.5.7.2 只在 `## 修改记录` 段说「不要复述已有内容」、但没在反向（`## Task 完成情况` 段）说「你这段不准接 revise 子字段」——AI 看 `## Task 完成情况` 字段宽松、把 fix log 当 task 子内容追加进去了。

**修法**：`prompts/phase-2-build.md` 02-build.md 骨架里 `## Task 完成情况` 顶部加一段：

```markdown
> 本段仅记 task 初稿做的事（4 个字段：改动文件 / 关键实现 / 偏离 plan / 局部校验）。
> ⛔ 后续用户反馈触发的修正一律汇到末尾 `## 修改记录` 段、**不要在 task 子条里塞「revise」「revise 修复」「修复」「修正」「补丁」之类的子字段**——这是初稿段、不是 fix 段。
> 反例：「### Task 4：xxx」下面加一行「**revise 修复**：xxx」——禁止；该信息挪到 `## 修改记录` 段下「### 修改 N」三级标题里。
```

**单文件改动**：仅 `prompts/phase-2-build.md`、`pnpm typecheck` ✓ / `pnpm lint` ✓。
- **plan / review fix mode 内联测**：分别从 plan / review fork 重启、看 AI 是否用 `> ✅ 已确认：xxx` 内联、不新建顶层标题
- **同名段修正测**：起新 task 跑完 build、看 02-build.md 顶部是不是「## 验收对照」（不再是「## Task 完成情况」重名）

##### 补 V0.5.7.4：review artifact 风格对齐 plan / build（2026-05-21 下午、用户实测复核交付后提的）

V0.5.7.2 / V0.5.7.3 把 build 段 fix log 规范化后、用户跑了一道 task 到 review、生成出 03-review.md、当面反馈「**这跟 01-plan.md / 02-build.md 格格不入**」。具体观感问题：

- 标题写「`# Review · <story title>`」——中英混排「Review」、跟 plan「`# 方案：xxx`」/ build「`# 实施日志：xxx`」（中文冒号开头）不齐
- 段落编号「`## 一、整体一致性总评` / `## 二、差异分类对照` / `## 三、跟飞书需求对照` / `## 四、交付信息`」——plan / build 都没用中文数字 + 顿号、看起来像两份文档
- 「二、差异分类对照」下挂 4 个 `### 2.1` / `### 2.2` / `### 2.3` / `### 2.4`、外层多一层抽象——plan / build 都是扁平 `##` 直接出顶层段
- fix log 留痕规则跟 build 不一致——V0.5.7.2 给 build 加了 `## 修改记录` 段、review 还在用「`## 二、差异分类对照` 内联 patch + `> ✅ 已确认：xxx`」、两套规则、回看时混乱
- artifact 开头如果带 frontmatter / yaml 头（V0.5.5 起 plan / build 都不带），review 没明文禁、AI 可能补加

**修法**：`prompts/phase-3-review.md` 骨架 + 引用整段重写、`src/lib/server/plan-runner.ts` review fix 提示对齐。

骨架变动总览：

| 段 | V0.5.7.3 之前 | V0.5.7.4 之后 |
|---|---|---|
| 主标题 | `# Review · <story title>` | `# 复核交付：<story title>` |
| 整体一致性 | `## 一、整体一致性总评` | `## 总评` |
| 差异 4 大类 | `## 二、差异分类对照` > `### 2.1/2.2/2.3/2.4` | 拍扁为 4 个独立顶层段：`## 范围扩张` / `## 范围收缩` / `## 实现偏差`（含 `### 偏差 N`）/ `## 未完成` |
| 飞书对照 | `## 三、跟飞书需求对照` | `## 跟飞书需求对照` |
| 交付信息 | `## 四、交付信息（用户复制走）` > `### 4.1/4.2/4.3/4.4` | `## 交付信息（用户复制走）` > `### Commit message 草稿` / `### PR title + body 草稿` / `### 飞书评论草稿（给 PM / 测试看）` / `### 自测 checklist`（无序号） |
| 修改记录 | 无、fix log 内联在「二、差异分类对照」 | **新增 `## 修改记录` 段**、跟 build 同套规则（`### 修改 N` + 「用户反馈 / 影响位置 / 概要」三字段） |
| 约束 | 没明文禁 frontmatter | **新加「严禁写 frontmatter / yaml 头」约束**（§5 严格约束） |

prompt 引用调整：

- 执行步骤标号 §1 ~ §5 全部刷新、跟新骨架对齐
- 「§5 产出交付信息」下子段 §5.1 ~ §5.4 保留、对应骨架里 4 个 `###` 段
- fix mode revise 处理（line 200）：从「内联在『二、差异分类对照』对应分类下」→「**用 `edit` 把本轮修正追加到 03-review.md 的 `## 修改记录` 段末尾**、按骨架「### 修改 N」+ 三字段」
- 「几条要点」段 7 条要点全部刷新引用（如「§4 交付信息」→「交付信息」段；「五、用户决策项」之类历史残留也清掉）

`plan-runner.ts` 同步改动（V0.5.7.2 改过一版「review 分支用内联留痕」、V0.5.7.4 改成「跟 build 同套、追加到 `## 修改记录`」）：

```ts
fork.fromPhase === "review"
  ? `  5. 改完代码 / 描述后**用 \`edit\` 把本轮修正追加到 03-review.md 的 \`## 修改记录\` 段末尾**（按 phase-3-review 骨架里「### 修改 N」三级标题 + 「用户反馈 / 影响位置 / 概要」三字段格式）。\n     ⛔ **严禁新建顶层标题**（如「## Fork 修复」「## Revise」「## 重启修复」），所有 fix log 都汇聚在 \`## 修改记录\` 段下、不要散在「实现偏差」「未完成」等正文章节里。\n     ⛔ **严禁在 artifact 里出现「fork」「revise」「再聊聊」等内部技术词**——artifact 是给用户看的、用「用户反馈」「本次修改」等中文表述。`
```

附带小修：

- 骨架里 commit msg 草稿那段 ` ``` ` 之前是裸三反引号、嵌套在外层 ` ```markdown ` 块里、markdown 渲染会撞、已转义为 `\`\`\``（V0.5.7.4 之前的纯小问题、顺手清掉）

**两文件改动**：`prompts/phase-3-review.md` + `src/lib/server/plan-runner.ts`、`pnpm typecheck` ✓ / `pnpm lint` ✓。

**V0.5.7.4 待办（用户实测）**：
1. **review 风格视觉对照**：起新 task 跑到 review、看 03-review.md 标题 / 段层级是否跟 01-plan.md / 02-build.md 视觉一致
2. **review fix mode 试**：从 review fork 重启 + textarea 填一两条假反馈、看 AI 是否把修正追加到 `## 修改记录` 而不是新建顶层「## Fork 修复」 / 「## Revise」
3. **frontmatter 禁项试**：观察新跑的 03-review.md 头部是否还出现 `---phase: review---` / `task_id:` / `generated_at:` 之类 yaml 块（V0.5.5 起 plan / build 都没了、review 之前缺这条明文）

##### 补 V0.5.7.5：review 段精简——4 类差异 → 三类、未完成段定义收紧、删跨角色项 + 飞书评论草稿（2026-05-21 下午、V0.5.7.4 联测后用户拍板）

V0.5.7.4 跑出来一份 03-review.md（`data/tasks/t_1779244321203_8i29s8` 那个补升任务）、虽然骨架对齐了 plan / build、但用户实测细看后提了三个产品层问题：

**问题 1：「未完成」段塞了非 task 的东西**

V0.5.7.4 那份 artifact 的「未完成」段塞了两行：
- 「跟进页橙色任务类型中文标签」——其实**前端已经做完了 `recordData.taskType` 写入、依赖后端 query_type 配置**、不是 task 未完成
- 「全量 yarn build:dev」——其实是**校验环境缺 OSS 密钥**、是 02-build.md「全量校验」该写的事、不是 plan task 未做完

**根因**：`prompts/phase-3-review.md` §3.4 + 骨架 `## 未完成` 段定义太宽（「02-build.md 标 ✗ 失败 / ⚠ 部分 / 完全没提」）、AI 看到 02-build.md 任意「没全 pass」就抓进来、抓到 校验环境 / 外部依赖 / 跨仓库 这些噪声。

**问题 2：飞书需求对照表塞了跨角色项**

V0.5.7.4 那份 artifact 末尾出现「数仓 / iOS 端改造 / story 跨角色 / ❌ 不在本仓库范围」这条记录。用户视角是「我做前端、数仓 / iOS 不关我事」、噪声。

**根因**：`prompts/phase-3-review.md` §4 + 骨架明文要求列跨角色项（「V0.4 multi-role 时代设计、给用户看 story 全景」）、跟用户实际诉求（「我只关心我做的部分」）错位。

**问题 3：review 整体偏重、调试期想精简**

V0.5.7.4 骨架顶层 7 段：总评 / 范围扩张 / 范围收缩 / 实现偏差 / 未完成 / 跟飞书对照 / 交付信息 + 修改记录。对比 01-plan.md（6 段）、02-build.md（4 段）确实重。

**修法（V0.5.7.5 一次性做完）**：

| 改动 | 修法 | 影响段 |
|---|---|---|
| **顶层段合并** | 「## 范围扩张」+「## 范围收缩」→ **`## 范围偏离`**（一张表、用「类型 = 扩张 / 收缩」字段标）| §3.1 + 骨架 |
| **段重命名 + 定义收紧** | `## 未完成` → `## 未完成 task`、明文「**只列 plan §5 拆分里贴了名、但 build 没做完的 task**」+ ⛔ 三禁项（不收 校验环境 / 外部依赖 / 本仓库以外）| §3.3 + 骨架 |
| **跨角色项删除** | 「跟飞书需求对照」段去「不在本仓库范围 / 跨角色 / 后端 / 测试」项、明文「只列跟本仓库 + 本 role 相关的需求项」| §4 + 骨架 |
| **交付信息删 1 项** | `### 飞书评论草稿（给 PM / 测试看）` 子项整段删——over-design、commit msg 已能给 PM 当沟通材料、用户实测不发飞书评论 | §5 子段编号 5.1~5.4 → 5.1~5.3、骨架表也同步 |
| **文案一致化** | 全文「4 类差异 / 四类差异」→「三类差异」；「飞书评论草稿」从「输出」「几条要点」「交付信息」段的描述里全删；「范围扩张 / 范围收缩」表段标题去除、改为「范围偏离」 | 全文 |
| **修改记录段同步** | 「严禁复述」清单里「范围扩张 / 范围收缩」→「范围偏离」；其它无影响 | 骨架 ## 修改记录 |

最终顶层段：**6 段**（总评 / 范围偏离 / 实现偏差 / 未完成 task / 跟飞书需求对照 / 交付信息 + 默认隐的修改记录）、跟 plan（6 段）持平、跟 build（4 段）仍重 1~2 段、但 review 本身有 4 类差异 + 飞书对照 + 交付 三大职责、6 段已是不可再压。

**单文件改动**：仅 `prompts/phase-3-review.md`、`pnpm typecheck` ✓ / `pnpm lint` ✓。

**V0.5.7.5 待办（用户实测）**：
1. **range 偏离表试**：起新 task 跑到 review、看「范围扩张」「范围收缩」是否真的合并成「范围偏离」单表 + 类型列
2. **未完成 task 段试**：故意做一道 task 让 build 校验环境出问题 + 留个 plan task 没做、看 review 是否只把后者收进「未完成 task」、前者归「总评」build 校验状态
3. **跨角色项消失试**：找一道飞书 story 涉及前端 + 后端 + 测试的、看 review「跟飞书对照」是否只列前端那些、后端 / 测试不出现
4. **飞书评论草稿消失试**：「交付信息」段是否只有 3 个子段：Commit message / PR title+body / 自测 checklist

##### 补 V0.5.7.6：自测 checklist 精简 + 实施位置 path 完整性（2026-05-21 下午、V0.5.7.5 重跑后即时反馈连发）

V0.5.7.5 改完用户立刻重跑了一道 review、拿到的 03-review.md 暴露 **3 个问题**、本节一次性收：

**问题 1：「自测 checklist」段塞前置步骤**

原文：
```
- [ ] 启动 dev：`yarn local`（https://localhost:8877/）
- [ ] 访问 ...
```

「启动 dev」是「跑测试的前提」、不是「测试本身」、PR reviewer 默认会做、写了是废话。

**问题 2：AI 凭空编命令 / 端口**

用户的项目实际跑在 `8080`、AI 没去 read package.json / README 拿真端口、脑补成 `8877`。这是 hallucination、用户视角直接踩雷。

**问题 3：「实施位置」简写文件名 → 前端识别不出 path 链接**

03-review.md「跟飞书需求对照」表的「实施位置」列里、AI 部分写了完整路径、部分简写了纯文件名（如 `recordModal.vue:2189-2221`）。

`src/lib/path-utils.ts: looksLikePath` 启发式判路径要求字符串**含 `/`**、纯文件名识别不出来、用户在 artifact 看到的是死字符串、不能点跳 Cursor。

**根因综合**：

1. §5.3 自测 checklist 段的指导原文「优先列『能自动验的』：启动 dev / 访问 URL / 点按钮 / 看结果」——把「启动 dev」明文列为「优先列」、AI 老实跟单
2. §5.3 没明文要求 AI 自测 step 出现命令 / 端口 / URL 时先 `read` 拿真值、AI 容易凭空编
3. §4 「跟飞书需求做对照」段对 path 写法只说「`path:lineRange` 引用」、没明文「必须从仓库根的完整相对路径起手」

**修法（单文件 + 接力反思）**：

`prompts/phase-3-review.md` 三处改动 + 复杂度自查：

| 段 | 改动 |
|---|---|
| `§5.3 自测 checklist` 段 | 4 条 bullet（净增 1）取代原本「不限 / 优先列启动 dev / 不列回归矩阵」3 条。**第一稿 V0.5.7.6 改了 9 条 bullet、用户反问「没增加复杂度吧」、立即精简到 4 条**（净增 1）：「功能验证 step / 不写前置环境 / 写命令前先 read 拿真值 / 不列回归矩阵」 |
| 骨架自测 checklist 示例 | 删「- [ ] 启动 dev server：`pnpm dev`」那一行、第一行直接是「- [ ] 访问 /users/list」 |
| `§4 跟飞书需求做对照` 段 | 加一段 path 完整性约束 + ✅/❌ 对照（`apps/.../recordModal.vue:2189` 对、`recordModal.vue:2189` 错）、附前端 `looksLikePath` 识别原理 |

**接力反思**：V0.5.7.6 第一稿改了 9 个 bullet、用户立刻问「没增加复杂度吧」——这是 prompt 维护过程中的一个长期教训：**新约束往往用「⛔ 三条子 bullet 展开」的形态写、复杂度叠加快**。后续改 prompt 时硬规则：**单次增量 ≤ 3 行、不展开 ⛔ 三层 bullet、能 fold 成单行就 fold**。

**单文件改动**：仅 `prompts/phase-3-review.md` + `docs/HANDOFF.md`、`pnpm typecheck` ✓ / `pnpm lint` ✓。

**V0.5.7.6 待办（用户实测）**：

1. **「启动 dev」消失试**：自测 checklist 第一项是不是直接「访问 xxx」、不再有「启动 dev」前置
2. **端口准确性试**：让 AI 写需要端口的 checklist step、看 AI 是不是 read package.json / README 拿真端口
3. **path 完整性试**：「实施位置」列每条都从仓库根的完整相对路径起手、前端 markdown 能点链接跳 Cursor

##### 补 V0.5.7.7：跨 phase 共享规范抽离到 `prompts/_shared.md`（2026-05-21 晚、架构 review 推动）

**背景 / 触发**：

用户跑完 V0.5.7.6 后让 AI 站 P8 架构视角 review 一遍 plan / build / review 三 phase 的 prompt 设计、本 AI 抓出几条结构性债：

1. **跨 phase 重复约束**：以下 4 条规则在 3 个 phase prompt 里各写了一遍（写法略有出入、改一处忘改另一处）：
   - artifact 写入工具用法（`write` 创建 / `edit` 改、首次写 `read` artifact-writer skill）
   - artifact 顶部禁 frontmatter（V0.5.5 起约束）
   - path 完整路径写法（V0.5.6.3 / V0.5.6.4 加严、V0.5.7.6 在 review 又加一遍）
   - `## 修改记录` 段格式 + 内部技术词禁项（V0.5.7.2 / V0.5.7.4 在 build / review 各加了一份「⛔ 三条子 bullet」）
2. **典型 bug**：V0.5.7.6 第一稿在 review prompt 加了 9 个 ⛔ bullet 防 AI 编命令 / 端口、用户立刻反问「没增加复杂度吧」——本质是 prompt 复杂度被「跨 phase 重复 + 历史注释 + 反例展开」叠了 3 倍。
3. **debt 量化**：plan 429 行 / build 245 行 / review 390 行、其中约 25-30% 是跨 phase 通用约束的重复。

**改动**：

抽 4 类通用约束到新文件 `prompts/_shared.md`（118 行）、`plan-runner.ts` 在 `buildSuperPrompt()` 里把它拼到「各 phase 详细 prompt」段之前。各 phase prompt 删重复段、只保留 phase 特有约束 + 一行「见 super-prompt 跨 phase 共享规范 §X」reference。

`prompts/_shared.md` 涵盖：

| § | 内容 |
|---|---|
| §1 artifact 写入工具 | `write` 创建 / `edit` 改、首次写前 read `artifact-writer` skill |
| §2 artifact 顶部格式 | 三 phase 都直接 `# 标题` 起头、不带 frontmatter |
| §3 path 完整路径写法 | 从 `{{repoPath}}` 起算、已知行号写 `path:line` 、同文件多次出现都写完整路径、不写绝对路径（带 ✅ / ❌ 反例） |
| §4 内部技术词禁项 | `fork` / `revise` / `[PHASE_ACK]` / `## Fork 修复` / 「fork 模式」「revise 路径」等 artifact 严禁出现 |
| §5 fix mode 修改记录 | §5.1 build / review 用 `## 修改记录` append；§5.2 plan 用内联 `> ✅ 已确认：...` |
| §6 中文表述 | artifact 全文中文（除代码 / 路径） |
| §7 数字 / 命名一致性自检 | task 计数、业务名词全称、命令 / 端口先 read 拿真值（V0.5.7.6 实测教训纳入） |

各 phase prompt 删的内容：

| 文件 | 删了什么 → 改成 |
|---|---|
| `phase-1-plan.md` | 「artifact-writer skill 详述（6 行）」+「路径硬约束段（27 行 + 反例 + 正例）」→ 引用「跨 phase 共享规范 §1 / §3」单行 reference |
| `phase-2-build.md` | 「artifact-writer 引导」+「写 artifact 的 `write` vs `edit` 详述」+「`## 修改记录` 段 ⛔ 三禁项」+「revise feedback 处的『不要新建顶层标题 / 不要复述 / 不要内部技术词』细节」+ 修正「本 phase 是 workflow 最后一个 phase」错误描述（V0.5 起 review 才是最后一个） → 多处引用 reference |
| `phase-3-review.md` | 「严禁写 frontmatter（§5 严格约束第 5 条）」+「写 03-review.md 段的 artifact-writer 详述」+「revise 处的修改记录格式 + 禁项细节」+「`## 修改记录` 段 ⛔ 三禁项」+「§4 跟飞书需求对照段的 path 完整性 ✅/❌ 示例（已在 _shared §3）」+「§5.3 自测 checklist 里命令 / 端口 read 规则（已在 _shared §7）」 → 多处引用 reference + 顶部加「artifact 通用约束见 super-prompt」 |

`plan-runner.ts` 加的代码（V0.5.7.7 注释标记）：

```typescript
const SHARED_PROMPT_FILE = "_shared.md";

const loadSharedPrompt = async (task: Task): Promise<string> => {
  const fpath = path.join(PROMPTS_DIR, SHARED_PROMPT_FILE);
  try {
    const tpl = await fs.readFile(fpath, "utf-8");
    return fillTemplate(tpl, { repoPath: task.repoPath, taskId: task.id });
  } catch (err) { /* 兜底返提示 */ }
};

// buildSuperPrompt() 中：
const sharedRules = await loadSharedPrompt(task);
// ... 拼装 super-prompt 时把 sharedRules 放在「各 phase 详细 prompt」段之前
```

**收益**：

- **改一处即同步**：以前改 frontmatter 规则要扫 3 个文件、漏一个就出 bug（V0.5.7.X 多次出现）；现在只改 `_shared.md` 一处
- **phase prompt 自身复杂度降低**：plan 429 → 403 行（-26）、build 245 → 214 行（-31）、review 390 → 357 行（-33）
- **新人 / 接力 AI 读懂成本下降**：先看 `_shared.md`（118 行）掌握通用约束、再读 phase prompt 看 phase 特有内容
- **总行数微涨**（1064 → 1092、+28 行）是加「见 super-prompt §X」reference 句的开销、属于可接受的偿还成本

**已知未做（V0.5.8 候选）**：

1. **Action A**：`phase-3-review.md` 的 revise 处理里、「明确指令通常是『改回 plan』『修改 plan 描述』『补做 task N』」与 §1「不动业务代码 / 不动 .git」存在内部冲突——按字面理解 review agent 在 revise 时被允许动 plan / 改代码、但本 phase 又禁止动这些。当前 fork mode 走 phase-2-build / phase-1-plan 接力是 OK 的、但 revise 路径下 review agent 自己动手的边界没收敛。**先记账、等用户实操踩到再修**。
2. **Action C**：phase prompt 里仍残留若干「V0.5.6.3 加」「V0.5.6.4 加严」「V0.5.7.6 实测踩坑」之类历史注释——对当前读者无信息量、靠 git blame 才有意义。暂时保留（删了 prompt 自身可读性反倒下降、靠未来定期清理）。

**单文件改动**：`prompts/_shared.md`（新建）+ `prompts/phase-1-plan.md` + `prompts/phase-2-build.md` + `prompts/phase-3-review.md` + `src/lib/server/plan-runner.ts` + `docs/HANDOFF.md`、`pnpm typecheck` ✓ / `pnpm lint` ✓。

**V0.5.7.7 待办（接力 AI / 用户实测）**：

1. **shared 段在 super-prompt 里的可见性测**：起一个新 task 跑 plan、看 SDK Run 日志里 super-prompt 首部是不是「## 跨 phase 共享规范」段（line 之间 _shared.md 内容）
2. **三 phase 引用 reference 命中测**：跑通 plan + build + review 三 phase、看 artifact 里 frontmatter / path 完整性 / 修改记录格式都遵守
3. **revise 路径回归测**：build / review phase 触发 revise、看 `## 修改记录` 段是不是按 `_shared §5.1` 格式追加

**V0.5.7.7 hot-fix（2026-05-21 晚补、用户实测踩坑）**：

抽完 `_shared.md` 后用户立即重跑了一个旧 task 的 build phase 验证、artifact 里出现 `promoteExpireReason.js`、`studentFollow.vue`、`lookStudentInformation.vue` 这种**纯 basename 改动文件**（前端 `looksLikePath` 不识别、用户看不到可点击链接）。

**第一轮修复**（hot-fix-1）：

原因：`_shared §3` 抽出后只在 `phase-1-plan.md`「改动 / 关键参考」和 `phase-3-review.md`「§4 实施位置」两处加了 reference、**`phase-2-build.md` 没在「Task 完成情况」段加显式 reference**——AI 看到骨架 demo 是 `src/api/sc.ts`（带 `src/`、`looksLikePath` 能识别）、自己写时又脑补「basename 应该也行」、就出问题。

修复：在 `phase-2-build.md` 的 `## Task 完成情况` 段顶部加一段⚠️：「改动文件路径必须写仓库根起算的完整相对路径」+ ✅/❌ 对照 + 「同样适用于改动文件清单表 + 验收对照表 + 修改记录」。

**第二轮深挖**（hot-fix-2、用户 /pua 后 P8 揪头发）：

继续审视后发现 build prompt 骨架自己**违反了 _shared §3**——「## 改动文件清单」表 3 个示例 `src/api/sc.ts` / `src/views/sc/PromoteDialog.vue` / `src/views/sc/list/Toolbar.vue` 虽然带 `src/` 能被 `looksLikePath` 识别、但**不是 monorepo 实际场景**（用户仓库是 `apps/cp-class-advisor-center/src/...`）；「## 验收对照」表更严重、3/4 是裸 basename `selList.vue` / `PromoteDialog.vue` / `recordModal.vue` ❌——AI 看到骨架自己就违反规则、自然会模仿。

修复：build 骨架里**所有**文件路径示例改成 monorepo 完整路径（`apps/cp-class-advisor-center/src/...`）、与用户实际仓库结构对齐。

同时给 `_shared §3` 加：

1. **plan / build / review 三 phase 的反例覆盖**——原本只有 plan 上下文反例（`BackLog.vue` / `home.vue`）、补充 build phase 实测反例（`studentFollow.vue` / `lookStudentInformation.vue` / `promoteExpireReason.js`）和 review phase 反例（`recordModal.vue:2189-2225`）、让 AI 直接看到自己 phase 的踩坑
2. **「前端判路径规则」说明**——直接引用 `src/lib/path-utils.ts:looksLikePath` 实现：「必须含 `/`、且最后一段含 `.` 扩展名——纯文件名 `foo.vue` 因为不含 `/` 直接 fall through 成纯文本」——让 AI 理解为什么要带目录前缀

**总改动**：

- `prompts/_shared.md`：+6 行（反例扩展 + 实现说明）
- `prompts/phase-2-build.md`：+11 行（顶部 ⚠️ + 骨架示例改 monorepo + 「同样适用于」扩展到验收对照）
- `pnpm typecheck` ✓ / `pnpm lint` ✓

**教训纳入 prompt 维护原则**：

1. **离骨架字段越近的约束越被遵守**——LLM 注意力衰减、顶部规则段抽离后必须在每个使用场景的字段附近加 reference、不是「顶部加一条就完事」
2. **骨架 demo 必须模拟用户实际仓库结构**——不要用 generic `src/api/sc.ts`、要用 `apps/<biz-app>/src/api/sc.ts` 这种 monorepo 路径；demo 是 AI 模仿的「正确写法」、demo 偷懒 AI 就跟着偷懒
3. **反例要覆盖每个 phase 的实测踩坑**——_shared 是给三 phase 共用的、反例就要分别给 plan / build / review 上下文、不能只给 plan 的让 build agent 自己脑内迁移

**已知未做（V0.5.8 候选）**：

- ~~**artifact 间互相引用问题**~~ ✅ **V0.5.8 落地、走方案 B**：03-review.md 写「详见 01-plan.md §4」时、`01-plan.md` 是裸文件名不含 `/`、`looksLikePath` 也识别不出（66 处类似引用散在三 phase prompt）。两条修复路径：(A) prompt 侧约束写 `data/tasks/{{taskId}}/artifacts/01-plan.md`——太长太丑；(B) 前端 ArtifactPanel 识别 `0N-xxx.md` 走 task 内 tab 切换、不走 cursor:// deep link——更彻底。


### V0.5.6.x：plan 模板三轮硬约束（2026-05-20 上午、V0.5.6.1 + .2 + .3 合订）

> **HANDOFF 分段约定**（V0.5.6.3 加）：同主题连续小版本（V0.x.y.1 / .2 / .3）写完后**立即合并**到 V0.x.y.x 一段、避免单一改动散段冗余。本节就是 V0.5.6.1 + V0.5.6.2 + V0.5.6.3 三段合订示范。

V0.5.6（ask_user 无次数上限 + 稍后再补充）测完、用户跑了几份真实业务 plan（补升任务改造）、暴露 plan 模板**结构** + **约束** + **agent 自律** 三层问题、连续三轮迭代收敛。

#### 0. 三轮驱动（用户原话精炼）

- **轮 1（.1）**：审 V0.5.6 出来的 plan 时直观反馈
  > 「（§1.1）我总感觉不是很懂是干嘛的、特别是差异类型这一块」
  > 「有差异的、我觉得也应该是 AI 要通过 ask 来问我呀、而不是列在方案上」
- **轮 2（.2）**：跑完 .1 模板后追问
  > 「3.1 和 5 的定位上算重复吗你觉得？」
  > 「3.2 和 3.3 你觉得要不要呢？还有技术决策的定位你觉得够清晰吗？」
- **轮 3（.3）**：再跑 .2 模板、连续发现 3 件 issue
  > 「task 里有些路径没有正确解析、确认下是不是没有给 AI 强调路径的规范」
  > 「这一段是我们的规则要求的吗」（指 agent 把 4 条 ack 备注堆 §1 段尾连一行）
  > 「这字段还有不确定的、还有或的、不行」（指 `promoteStatus（或 isMakeUp 同字段）`）

#### 1. 最终章节结构（V0.5.6.x 后 plan artifact 形态）

| 章节 | 内容要点 |
|---|---|
| **1. 需求理解** | 2-3 段总结 + 顶部 ask_user 留痕方式提示 |
| **2. 业务规则 / 文案 / 状态** | 关键枚举 / 状态机 / 字段；加「不要列」3 条 + PRD 复述反例 |
| **3. 涉及接口（跨后端边界）** | 接口名 / 方法 + 路径 / 来源 3 列；没新接口跳过本段 |
| **4. 关键技术决策（plan ack 用户能拍板的）** | 3 类允许 + 3 类禁止 + 反例 + 正例 |
| **5. Task 拆分（plan ack 的核心审计单元）** | 顶部跨包汇总句 + 路径硬约束（仓库根起算的完整路径）+ 每 task：改动 / 依赖 / 验收点 / 工作量 / 关键参考 |
| **6. 待澄清 / 不确定项** | deferred / 答「你定」按 default 走的 / 跨角色待澄清 |

**砍掉的章节**：§1.1（我的理解 vs 飞书原文）/ §3.1（本仓库改动）/ §3.3（不在本仓库范围）/ §6（上下文冲突已通过 ask_user 澄清）—— 6 章变 5 章。

#### 2. 决策清单（按类别）

**A. 结构精简（章节级）**

| ID | 决策 | 一句话理由 |
|---|---|---|
| A1 | 删 §1.1「我的理解 vs 飞书原文」 | 差异本质是 AI 不确定点、应该 ask_user 拍板、不是先列表让用户审；agent 实操大概率全写「✅ 一致」纯噪音 |
| A2 | 删 §6「上下文冲突已通过 ask_user 澄清」 | 信息跟 §1/§2/§4 正文里 ask_user 拍板备注重复、改正文内联；events.jsonl 已记录历史 Q&A、artifact 复述冗余 |
| A3 | §3.2 涉及接口表 5 列 → 3 列 + 升一级为 §3 | 字段细节看 contextDocs、plan ack 不审字段 |
| A4 | 砍 §3.1「本仓库改动」 | 跟 §5 task「改动」字段 100% 重复、用户 ack 跳过它直接看 §5 |
| A5 | 砍 §3.3「不在本仓库范围」 | 跨角色依赖归 §6 待澄清、纯参考信息（「iOS 也会做」）零价值 |

**B. 内容约束（什么该写、什么不该写）**

| ID | 决策 | 关键约束 |
|---|---|---|
| B1 | §2 加 PRD 复述反例 | 「不要列」3 条：业务背景大段叙述 / 验收标准抄一份 / PRD 段落标题直接当本段小标题；加反例代码块 |
| B2 | §4 加 3 类允许 + 3 类禁止 | 允许：全局选型 / 跨边界协议 / 产品体验；禁止：文件命名（进 §5）/ 待用户确认（进 §6）/ 已有技术栈复述 |
| B3 | §5 加跨包汇总句 | monorepo 顶部一句话「涉及 Y task、动 packages/<X> 共享 X 个 + apps/<Y> 业务 Y 个」 |
| B4 | §5 路径硬约束（4 条规则） | ①仓库根起算的相对完整路径 ②同名多 task 也写完整不简写 ③行号定位 `:line` / `:line-line`（V0.5.6.4 加强：**有就写**、前端解析后缀生成 `cursor://file/...:line` 链接、用户点击跳起始行；`:line-line` 末尾不传给协议、由 IDE 视口展示）④禁绝对路径；反例 `selList.vue` → 正例 `apps/cp-class-advisor-center/src/views/mainHome/selList.vue:271-279` |
| B5 | ⛔ 严禁不确定写 artifact | 字眼黑名单：或 / 待定 / TBD / 可能 / 应该是 / 大概 / 暂定；反例 `promoteStatus（或 isMakeUp 同字段）` → 正例：先 ask_user 拍板字段名再写 artifact；plan-runner super-prompt 同步加（双保险） |
| B6 | ask_user 留痕「就地」语义说清楚 | 「就地」= 紧跟用结论的那行 / 那段、不聚合段尾、一行一条；反例：§1 段尾堆 4 条 ack 连一行 → 正例：§2.4 段尾一行 / §2.5 段尾一行 各自就地；**定位是给下游 build / review agent 看的拍板标记**、不是给用户的「确认表」 |

**C. 跨模式策略**

| ID | 决策 | 理由 |
|---|---|---|
| C1 | chat（自由聊天）任务禁用 ask_user | 用户原话「自由 chat 模式下不用提问、直接回答、自由模式就是 talk 而已」；chat 没 artifact、ask_user 弹窗的留痕价值兑现不了；改 prompt 引导走 assistant_message + wait_for_user；先靠 prompt 自律、误调再加 server hardcode |

#### 3. 改动文件清单（.1 + .2 + .3 合表、按文件聚合）

| 文件 | 整体改动（三轮累计） |
|---|---|
| `prompts/phase-1-plan.md` | 骨架：删 §1.1 / §3.1 / §3.3 / §6 上下文冲突；§3.2 升 §3 + 表压 3 列；§4 加 3 类允许 + 3 类禁止 + 反例 + 正例；§5 加跨包汇总句 + 路径硬约束 + 反例 + 正例；原 §7 改名 §6 合 deferred + 跨角色；§2 加「不要列」3 条 + PRD 复述反例；几条要点加 ⛔ 严禁不确定写 artifact 字眼黑名单 + 反例。正文：§1 顶 ask_user 留痕方式说清楚「就地」语义 + 反例 + 正例；几条要点段引用全部刷新到新章节号 |
| `prompts/phase-2-build.md` | 读上游 artifact 段：§3 涉及接口（V0.5.6.2 起只列接口、文件清单挪 §5）/ §4 关键技术决策（V0.5.6.2 起 3 类约束）/ §5 task「改动」字段（V0.5.6.2 起改动范围必须在这里）；删 §1.1 / §6 上下文冲突引用 |
| `prompts/phase-3-review.md` | 关键定位 / 执行步骤 / 飞书对照 / 几条要点同步刷：「§3 涉及面」→「§5 task 改动字段」、「§1.1 我的理解 vs 飞书原文」→「正文内联 `> ✅ ask_user 已确认`」、「§6 上下文冲突已澄清」→「正文内联备注」 |
| `src/lib/server/plan-runner.ts` | 注释里 review phase 要读的章节同步刷；super-prompt「何时调 ask_user」段加 ⛔ 不确定字眼黑名单（B5 双保险）；super-prompt「§7 待澄清」→「§6」、「上下文冲突已澄清段」→「正文内联备注」 |
| `src/lib/server/chat-mcp.ts` | ask_user 工具 description 开头加 `## ⚠️ chat 任务禁用`（C1）；§7→§6；上下文冲突表述换正文内联备注 |
| `src/lib/server/chat-runner.ts` | chat 模式 prompt 原 `## ask_user` 段整段重写、改成「chat 模式禁用、直接 assistant_message + wait_for_user」（C1） |
| `src/app/api/tasks/[id]/ask-reply/route.ts` | 4 处注释 / deferred 提示 §7→§6、上下文冲突表述同步换 |
| `src/lib/task-store.ts` + `src/components/tasks/ask-user-dialog.tsx` | deferred 流程注释 §7→§6（共 4 处） |
| `src/lib/path-utils.ts`（V0.5.6.4） | `parsePathWithLine` 拆 `path[:line[-endLine]]` 后缀；`looksLikePath` 剥掉行号再做扩展名判断；`buildCursorLink` 拼 `cursor://file/<abs>:line`（取起始行、`-line` 末尾不传协议）——修复 AI 写 `:271-279` 后链接坏（`:` 被 encodeURIComponent 成 `%3A`） |
| `prompts/phase-1-plan.md`（V0.5.6.4 第二轮、用户实测后加严） | **§3 接口表**第二列加约束「只允许 METHOD + URL」、复用描述去「来源」列；**§4「不要列」第 1 条**补「**新建 X / 复用 Y / 拆出 Z**」（防 agent 把实施细节当决策）；**§5 路径硬约束 ②** 改「同一文件多次出现（**跨 task 或同行多段**）都写完整路径」+ 反例加「`TaskInfo.vue:75-100、:414-503、:540-760` 裸冒号续接」；**§5 路径硬约束 ③** 精简（删前端解析机制细节、保留「能写就写」语义）；**§5 顶部汇总句**加「数字口径」段（文件计数 = 改动字段去重后唯一文件数）；**⛔ 黑名单**加「节选 / 示例 / 部分 / 完整按 X 录入 / 后续补全」+ 「特别注意偷懒类」段；**几条要点**加「⛔ 不省略业务名词 / task name」（防「学情/关单」这种脑内简写让用户费解） |
| `src/lib/server/plan-runner.ts`（V0.5.6.4 同步） | super-prompt ⛔ 黑名单同步加「节选 / 示例 / 部分 / 完整按 X 录入 / 后续补全」、双保险 |
| `src/lib/server/plan-runner.ts`（V0.5.6.5 新增**写完自检步骤**） | super-prompt 新加 `## 写完 artifact 强制自检` 整段：触发时机 = 调 ask_user / wait_for_user 前；4 步走 ①`shell grep` 黑名单字眼 ②人肉扫业务名词全称 ③扫 ack 留痕位置（不堆 §1 段尾）④扫路径完整性（不裸冒号续接）；4 项 grep 命中数为 0 才允许进 ack。背景：实测同一份 plan agent **间歇性**踩黑名单（§3 严格遵守、§2.2 又写「URL 或 processVariables」）——不是规则不细、是写到后面状态衰减没回头扫、强制 grep 比纯靠记忆稳 |
| `prompts/phase-1-plan.md`（V0.5.6.5 配套）| ⛔ 黑名单加「约 / 大约」+ 行号反例「**约 `4869-5250` 段**」❌；B6 格式约束加第 4 条「ack 涉及多章节时先别在 §1 写」、严禁 §1 段尾连写多条对应下游章节的 ack |

`pnpm typecheck` ✓ / `pnpm lint` ✓ 三轮全程双绿。

#### 4. V0.5.6.x 待办（接力 AI / 用户测试）

- **结构待测**（起新 plan、看 01-plan.md 骨架）：
  1. **没有 §1.1 / §3.1 / §3.3 / §6 上下文冲突**——一气呵成 §1 → §2 → §3 → §4 → §5 → §6 待澄清
  2. §3 只列接口表（3 列、没新接口跳过本段）
  3. §4 决策 3 类允许、不出现「文件命名」「待用户确认」
  4. §5 顶部跨包汇总句、所有 task「改动」字段写仓库根起算的相对完整路径（不再 `selList.vue` 这种 basename）
  5. ask_user 拍板留痕「就地」放在用结论的那行 / 段、一行一条、不堆 §1 段尾连一行
  6. **task「改动 / 关键参考」字段里所有 `path:line` / `path:line-line` 后缀都是可点击链接**（V0.5.6.4）、点击 Cursor 跳起始行；行号缺失时 prompt 应该提醒 agent「有就写」
  7. **同行多段路径每段都带完整 path**（V0.5.6.4 第二轮、`TaskInfo.vue:75-100、TaskInfo.vue:414-503` 而非 `:414-503` 裸冒号续接）、`§3` 接口表第二列纯 METHOD + URL、`§4` 决策不出现「新建 X / 复用 Y」实施细节、`§5` 顶部汇总句文件数 = task 改动字段去重计数、artifact 无「节选 / 示例 / 关单 / 学情」这种偷懒省略
  8. **写完 artifact 自检 4 项**（V0.5.6.5、强制 grep）：①shell grep 黑名单字眼（或/约/大约/可能/待定/TBD/节选/示例 等）零命中 ②业务名词 / task name 全称、无「学情/关单」简写 ③`> ✅ ask_user 已确认` 不堆 §1 段尾（涉及 §2-§5 的挪到对应章节）④`path:line-line` 后缀前必有完整 path、不裸冒号续接
- **内容待测**：
  - 反例测：喂大段 PRD 看 agent 是否抄进 §2
  - 严禁不确定测：刻意问字段命名不清的需求、看 agent 是否真去 ask_user 拍字段名而不是写「A 或 B」
- **多 phase 联测**：build / review agent 读新结构、找文件 / 决策 / 拍板留痕都顺畅
- **chat 禁用 ask_user 测**（C1）：起 chat 任务、agent 走 assistant_message 路径不弹 modal；如果仍误调、加 server 端 `task.mode === "chat"` hardcode 拦截


### V0.5.6：ask_user 无次数上限 + 弹窗加「稍后再补充」（2026-05-20 上午）

> 用户对 V0.5.5 §6 遗留「ask_user 问两轮就停」的拍板——**取消所有「最多 1 次」上限、让 AI 按内容判断要不要继续问；同时弹窗加「稍后再补充」按钮、给用户一个退出循环的口子。**

#### 1. 设计动机（用户拍板）

V0.5.5 联测发现：用户第一轮 ask_user 答模糊（「你定」/「不清楚」）、agent 应该 read/grep 形成判断 → 二轮 ask_user 给具体选项让用户拍板。但实测下来 agent 问完一轮就**自我加戏「问够了」**、直接写 artifact 跳过 wait_for_user 之前的二轮 ask_user。

根因：旧 prompt 写「**写 artifact 初稿阶段最多调用 1 次 ask_user**」——这是 V0.3.2 给 modal 弹窗一次性打包问的设计、但被 agent 理解成了「整个 phase 都只能问一次」、用「问够了」自我说服跳过收敛。

**修法（用户拍板）**：
- ❌ 之前提议过的 B 方案「软上限 5 轮」——用户直接否决（「让 AI 根据内容判断要不要问」、不要预设次数）
- ✅ 用户拍的方向：**完全去掉上限、按内容收敛；UI 加「稍后再补充」按钮给用户退出循环的口子**

#### 2. 协议层 / API 层改造

**`task-store.ts.submitAskReply` 加 `options?: { deferred?: boolean }` 参数**：

```ts
submitAskReply(taskId, askId, answers, { deferred: true });
```

`deferred=true` 表示用户选「稍后再补充」、`answers` 可以为空、body 多带 `deferred:true` 字段。

**`/api/tasks/[id]/ask-reply/route.ts` 改造**：
- body 接 `deferred?: boolean` 字段
- 校验：`deferred=true` 时跳过「answers 必填非空」+「answers 覆盖所有 question」校验
- `buildReplyText(questions, answers, deferred)` 第三参数 deferred、按头分两种格式：
  - `deferred=false` → `[ASK_USER_REPLY]\nQ1: ...\nA: ...\n\nQ2: ...\nA: ...`（旧格式不变）
  - `deferred=true` → `[ASK_USER_REPLY deferred]\n\n用户选择**稍后再补充**、未提供任何答案。\n请按你判断的合理 default 推进、并把以下问题完整列入 artifact「§7 待澄清 / 不确定项」段...\n\n未答问题清单：\n\nQ1: ...\nQ2: ...`
- `ask_user_reply` 事件 meta 加 `deferred: true`（便于前端事件回放识别）

#### 3. UI 层改造（`ask-user-dialog.tsx`）

DialogFooter 加「稍后再补充」按钮、ghost variant 让位主操作「提交全部回答」：

```tsx
<Button size="sm" variant="ghost" disabled={submitting} onClick={() => void handleDefer()}>
  稍后再补充
</Button>
<Button size="sm" disabled={submitting || !allAnswered} onClick={() => void handleSubmit()}>
  {submitting ? "提交中…" : "提交全部回答"}
</Button>
```

`handleDefer` 用 `useDialog().confirm` 二次确认（统一走项目里的 confirm Promise API、不用 window.confirm）：

```ts
const ok = await confirm({
  title: "稍后再补充这些问题？",
  description: "AI 会跳过这一组问题、按 default 推进、并把它们列进方案文档「待澄清 / 不确定项」段。你可以稍后在「再聊聊」或上下文文档里补充。",
  confirmLabel: "确认稍后补",
  cancelLabel: "回去答题",
});
if (!ok) return;
await submitAskReply(task.id, askId, [], { deferred: true });
```

#### 4. Prompt 层重写（去掉「最多 1 次」+ 教 agent 处理 deferred）

**`src/lib/server/chat-mcp.ts` ask_user 工具描述**：
- 标题从「phase 内打包提问（一次问完所有不确定项）」改成「phase 内打包提问（按需多次调、单次内一次问完）」
- 「关键约束」段彻底重写：
  - **单次调用内**：当前轮想问的全部打包进 questions[]、不要同一时刻调多次
  - **整个 phase 内无次数上限**：按内容判断、按需多次调
  - **收敛标准**：所有问题都得到「明确的业务决策」（A 路径）才能 wait_for_user；判不准就再问
- 「返回值」段加 deferred 处理：拿到 `[ASK_USER_REPLY deferred]` 时必须 1) 不再就这组 Q 重新调 ask_user 2) 把这些 Q 列进 §7 待澄清 3) 按 default 推进继续 wait_for_user

**`src/lib/server/plan-runner.ts` super-prompt ask_user 段**：
- 标题改成「V0.5.6 无次数上限、按内容收敛」
- 核心约束段重写、加 V0.5.6 设计动机说明（agent 自我加戏问题）
- 删了 V0.5.1 修复段（「1 次限额仅针对初稿阶段」整段过时）
- 「返回值」段加 deferred 处理
- 「何时不该问」段加「拿到 deferred 头的那组 Q——用户已明示稍后补、不准重问」
- 「调用礼仪」段把「最多调一次 ask_user / 撤销」改成「按需多次调、不要自我加戏问够了」

**`prompts/phase-1-plan.md` §5 / §5.1 / §5.2 重写**：
- §5 标题改 V0.5.6、关键约束段重写（无次数上限 + 按需多次调 + 用户可点稍后再补充）
- §5.1 加 **D 路径**（deferred 头处理：不重问 + 列进 §7 + 按 default 走继续 wait_for_user）、护栏改成「只有 D 才用 default、其他场景一律问到 A」
- §5.2 改写收敛标准：「**全部收敛到 A 或拿到 deferred** 才 wait_for_user」、明示 agent 不预设次数上限不自我加戏

#### 5. 关键决策记录

| 决策点 | 用户拍板 | 备选 / 否决理由 |
|---|---|---|
| 上限策略 | **完全无上限**、AI 按内容判断 | ❌ 软上限 5 轮（用户否决：不要预设次数） |
| 退出循环的口子给谁 | **给用户**（弹窗按钮） | 不给 agent（之前给 agent 就会被自我加戏） |
| 「稍后补」UI 形态 | **全局 1 个 ghost 按钮**、跟「提交全部回答」并列 | 不做 per-question 跳过（复杂度高、用户「单数」表述含义） |
| 二次确认 | `useDialog().confirm` Promise API | 不用 window.confirm（项目规则） |
| 协议头 | `[ASK_USER_REPLY deferred]` | 保留旧 `[ASK_USER_REPLY]`、兼容回放、加后缀区分 |
| Q 的归宿 | agent 列进 artifact §7 待澄清 + 按 default 走 | 不跳过、要让用户在 ack 弹窗看到「哪些没答、走的什么 default」 |

#### 6. 改动文件清单（6 文件、净 +180/-50 行）

| 文件 | 改动 |
|---|---|
| `src/lib/task-store.ts` | `submitAskReply` 加 `options?.deferred` 参数、body 条件携带 |
| `src/app/api/tasks/[id]/ask-reply/route.ts` | body 接 deferred、跳过校验、`buildReplyText` 加 deferred 分支、meta 写 deferred |
| `src/components/tasks/ask-user-dialog.tsx` | 加「稍后再补充」ghost 按钮 + `useDialog().confirm` + `handleDefer` |
| `src/lib/server/chat-mcp.ts` | ask_user 工具 description 整段重写、加 deferred 处理、phase 描述加 review |
| `src/lib/server/plan-runner.ts` | super-prompt ask_user 段重写、删 V0.5.1 1 次限额段、顶部工具列表简介更新 |
| `prompts/phase-1-plan.md` | §5 标题改 V0.5.6、约束重写、§5.1 加 D 路径、§5.2 改收敛标准 |

`pnpm typecheck` ✓ / `pnpm lint` ✓ 双绿。

#### 7. V0.5.6 待办（接力 AI / 用户测试）

- **核心待测**：用户在 ask_user 弹窗答模糊（「你定」/「不清楚」）、看 agent 是否真 read/grep + 二轮 ask_user 给具体选项（不再「问够了」跳过）
- **deferred 闭环测**：用户点「稍后再补充」→ 二次 confirm 确认 → 看 agent
  1. 是否真的不再就这组 Q 重新调 ask_user
  2. 是否把所有未答 Q 完整列进 artifact §6（V0.5.6.1 改名前是 §7）
  3. 是否按合理 default 推进、artifact 各位置加 `> （ack 待澄清：xxx）` 标记
  4. 是否继续 wait_for_user 不退 run
- **revise 闭环也无上限测**：用户在「再聊聊」打模糊话（「test」/「111」）连发 3-4 次、agent 应该每次都 ask_user 复述、不闷头改、不自我加戏
- **没必要场景测**：用户答案明确时 agent 不应该重复多调 ask_user（无上限 ≠ 必须多调、要按内容判断）
- **极端场景**：用户连续点 5+ 次「稍后再补充」（理论上不会、但测一下幂等）


### V0.5.5：A+B 优化 + SDK 诊断 + SSE 重连 + plan 瘦身 + feedback 分级 + 重启加强（2026-05-19 下午 ~ 晚）

> 用户下午联测时遇到一堆细节问题、顺手抽公共代码 / 加诊断口 / 简化 plan 模板 / 重写 revise 解读逻辑 / 让 awaiting_user 也能重启。一晚改完 18 + 文件、净减 100+ 行手工代码。

#### 1. A 类（瘦身）+ B 类（诊断 / SSE）优化六件套

**A1. `task-card.tsx` 删 `AlertDialog` 三件套、改 `useDialog().confirm`**

`AlertDialog` + `useState(deleteOpen)` + 整段 JSX 一共 ~50 行手工状态机、换成 `const { confirm } = useDialog(); const ok = await confirm({...}); if (ok) ...` 一行。

跟 `task-detail/page.tsx` 已经在用的 `confirm` API 对齐、project rule `learned-conventions.mdc` 也明示不用 `window.confirm` 走 `useDialog`。

**A2. 修 `learned-conventions.mdc` 的 dayjs 描述**

之前写「new Date 是 OK 的、不强求 dayjs」、但实际项目里 dayjs 已经引、对齐到「已经在用的 dayjs 优先复用」。

**B3. 抽 `src/lib/server/route-helpers.ts`**

`chat-reply/route.ts` 跟 `phase-ack/route.ts` 各有一份 `errorResponse / isValidModel / isValidMcpServers / parseAndValidateImages / KEEPALIVE_RACE_RETRY_MS / sleep`、复制粘贴。V0.5.5 ask-reply 加贴图时本来又要复制第四份——直接抽 helper、未来加新 route 复用。

helper 内部加了 `MAX_TOTAL_UPLOAD_BYTES`（30MB 全局上限、跟 chat / phase-ack 同款）+ 详细 jsdoc。

**B4. `run-args.ts` 加 `prepareBootArgs` + page.tsx 复用**

`handleApproveWithFork` 之前内联了一段「读 settings → 校验 apiKey → parseMcpServers → filterMcpServersByTask」、跟 `prepareRunArgs` 几乎重复、唯一差是不校验 model（dialog 里挑过）。抽 `prepareBootArgs(task)` 共享前置逻辑、`prepareRunArgs` 内部也调它。

**B5. 抽 `src/lib/path-utils.ts`**

`pathBasename` / `looksLikePath` / `buildCursorLink` 之前散落在 `event-stream.tsx` / `repo-card.tsx` 等组件里、各自 inline 一份。挪到 `lib/path-utils.ts`、跟「`lib/task-display.ts` 是文案唯一源」一个套路。

**B6. `artifact-panel.tsx` 瘦身**

`artifact-panel.tsx` 之前自己实现了 `extractFenchedLanguage` + 一堆 path 兼容代码、复杂度顶到天花板。借 path-utils 抽出顺势精简、单文件 -45 行。

#### 2. SDK status=ERROR/EXPIRED 诊断口（实测见效）

**坑**：`run.wait()` 返 `RunResult { status: "error", durationMs: ... }`、但 RunResult 类型上**没有** `errorCode` / `errorMessage` 字段。throw 出去的报错是干瘪的 `agent run status=error`、完全无法诊断。

但 SDK stream 里其实有一种叫 `SDKStatusMessage` 的消息、`type: "status"` + `status: "CREATING" | "RUNNING" | "FINISHED" | "ERROR" | "CANCELLED" | "EXPIRED"` + `message?: string`——服务端致命错误的具体描述放在这个流消息里、被我们 `handlePlanSdkMessage` 的 `case "status"` 默 ignore 掉了。

**改造**（`plan-runner.ts` + `chat-runner.ts` 双 runner）：

- `AssistantBufferCtx` 加 `sdkErrorMessage` 字段
- `case "status"`：`status === "ERROR" || status === "EXPIRED"` && `message` 非空时、写一条 `error` 事件 + 把 message 存进 `assistantCtx.sdkErrorMessage`
- 最后 throw 时把 `sdkErrorMessage` 拼进 message：`agent run status=error\n--- SDK stream error message ---\n<message>\n--- SDK result dump ---\n...`

**V0.5.5 实测发现**（用户复现一次）：SDK 1.0.13 **偶尔**走到 `case "status"` 时 `message` 字段是空的——

```
[plan-runner] SDK status message: status=ERROR message=(none)
```

这是 SDK 自己的局限、不是我们漏了。加了**无条件 `console.log`** 把 raw status 消息打到 dev server 终端、下次复现能立刻看到「SDK 是真没传 message、还是被我们漏处理了」。

#### 3. SSE 重连修复（用户体感「点继续监听后必须刷新页面」）

**坑**：用户点「继续监听」/「重启 workflow」/「fork 新 agent」后、服务端确实重新跑了 agent、但客户端**不会看到新事件**、必须 F5 刷新。

**根因**：

1. 上一轮 agent 退出后客户端 SSE 已经 close
2. `useTaskWatch` 的 `useEffect` deps 没变化（taskId 不变、callbacks 不变）、不会重连
3. `start-workflow` / `resume-waiting` 路由 `void runPlanWorkflow(...)` 是 fire-and-forget、立刻返回 task 给客户端、`task.status` 还是 `failed`、客户端发起的新 `watch-chat` 请求服务端看到 failed 直接 bootstrap+close

**修法**（三处协同）：

- `use-task-watch.ts` 加 `reconnectKey: number | string = 0` 参数、纳入 `useEffect` deps
- `page.tsx` 加 `watchEpoch` state、`handleStart` / `handleResumeWaiting` / `handleApproveWithFork` 成功后 `++`、强制 `useTaskWatch` 重连
- `start-workflow/route.ts` + `resume-waiting/route.ts`：fire-and-forget 之前**同步**调 `patchPhase(taskStatus: "running")`、把 task.status 切到 running 再返回、客户端 SSE 看到 running 不会立刻 close

#### 4. plan / build / review prompt 模板瘦身

用户实操后觉得 `01-plan.md` 太冗余、「方案规划的内容过于冗余了」。删掉低价值字段：

- **删 plan §2「验收标准」**：跟 §1「需求理解」+ §3「业务规则」重叠、价值低
- **删 plan §7「验收对照」**：跟 review phase 的「跟飞书需求对照」重叠
- **删 plan §8「自动化校验计划」**：build phase 模板里有更具体的
- **删 plan §9「关联文档」**：context_docs 已经在 UI 上显示
- **压缩 plan §3「业务规则」**：原来是「逐字搬 PRD」、改成「只列关键表 / 枚举、不复述 PRD 全文」
- **压缩 plan §1.1「我的理解 vs 飞书原文」**：只列差异（补全 / 偏离 / 缺源）、不复述一致项

**phase-2-build.md / phase-3-review.md 同步更新**：

- 内部所有 `§X` 引用按新编号刷新（旧 §4 → 新 §3、旧 §6 → 新 §5、删了 §7/§8 的引用）
- review 「跟飞书需求对照」从「读 plan §2 验收标准」改成「读 plan §5 task 列表 + contextDocs 原文」、对齐 plan 瘦身后的产出
- build 「Task 完成情况」表替换之前的「验收对照」表（per-task 校验、对齐 plan 新结构）

#### 5. super-prompt `[PHASE_ACK revise]` 重写：feedback 清晰度 4 级分流

**用户反馈**：

> 我感觉这两点的提示词应该是可以共用的是不？AI 要么过度确认（明明用户说得很清楚还要 ask_user 复述）、要么模糊场景就闷头改（用户说「你看着办」就真的随便选了）

**重写后的规则**（`plan-runner.ts` §3 revise 解读、`chat-mcp.ts` shell 引导文案、phase-2 / phase-3 prompt 同步）：

```
A. 明确改动指令（含具体位置 + 动词 + 改前/后）
   → 跳过 ask_user 复述、直接走 3a 改 artifact
B. 明确询问（纯疑问、没改动指令）
   → 跳过 ask_user 复述、直接走 3b 答疑 + emit assistant_message
C. 含混 / 不确定 / 过短（看不懂用户想干嘛）
   → 走 1.1 调 ask_user 复述意图、给具体选项让用户拍板
D. 带图（feedback 含 [ATTACHED_IMAGES]）
   → 先用 read 工具逐一读图、合起来再分 A/B/C

护栏：判不准就当 C、宁多问一次也不要把模糊的判成 A 闷头改
```

**C 路径专用细则**：
- ask_user 的 `question` 直接对用户说话、问意图（不准出现「[PHASE_ACK revise]」「反馈过短」这种协议名 / 公文体）
- 用户答仍模糊 / 「你定 / 看代码再说 / 不知道」 → **read / grep 相关代码形成判断 → 再调一次 ask_user 给具体选项**（不要瞎默认）

#### 6. phase-1-plan.md §5.1 / §5.2：初稿 ask_user 答完后按 §5 同款分级处理

跟 super-prompt §3 用同一套 A/B/C/D 分级（plan 初稿 ask_user 是「主动问」、revise 是「被动收 feedback」、但答案解读规则同步）：

- A. 答案明确 → 直接把结论写进 01-plan.md 对应位置
- B. 答案是反问 → 在 01-plan.md 旁注里答疑、把答疑后结论一并写进去
- C. 答案模糊 → **必须** read / grep 相关代码形成判断 → **再调一次 ask_user** 给具体选项让用户拍板（**不能直接打 default 跳到 wait_for_user**）
- D. 部分清晰 + 部分模糊 → 清晰按 A 落、模糊按 C 二轮

> ⚠️ **已知遗留**（**等下一轮跟用户单独聊**）：用户实测发现「ask_user 问两轮后就直接写 artifact」。根因可能是 §5.2 写的「所有 Q 都按 A/B/C/D 处理完、ask_user 不再有可问的、再 wait_for_user」语义太软、agent 自己判断「问够了」就推进。修法已对齐方向（要么换成「Q 全部收敛到 A 才 wait_for_user、ask_user 没次数上限」、要么加软上限 5 轮）、未实施。

#### 7. awaiting_user 状态下也能「重启 workflow」

**痛点**：用户改了 prompt 想看新 prompt 效果、但 agent 卡在 awaiting_ack、「重启 workflow」按钮不显示——非要等 30 分钟 wait-ack 超时后才能点。

**改造**：

- `page.tsx` `canStart` 加 `awaiting_user` 状态、awaiting_ack 状态下三按钮并存 `[重启 workflow]` + `[再聊聊]` + `[通过 PHASE]`
- 「重启 workflow」在 awaiting_user 下用 `ghost` variant、让位主操作给「通过 PHASE」
- 点击先弹 `useDialog().confirm`（`destructive`）、告知「会 cancel 旧 agent + 从 plan 重头跑 + 已有产物被覆盖 + +1 配额」
- `start-workflow/route.ts` 加分支：`isPlanRunning && task.status === awaiting_user` 时走 fork 路径（`markPlanForFork → cancelPlan → waitForPlanToStop`）再起新 run、其他状态保持 already=true 幂等

中途用户曾要求加单独的「重跑 agent」按钮（保留 phase 状态、只重跑当前 phase）、加完后用户说「就用重启 workflow 就行」、撤销新按钮 + 路由 / helper、合并到 start-workflow。

#### 8. 三个 phase 骨架 YAML frontmatter 全删

`01-plan.md` / `02-build.md` / `03-review.md` 骨架开头之前都有：

```yaml
---
phase: 1-plan
status: ready_for_ack
upstream: raw_input
downstream: 02-build.md
task_id: <taskId>
context_docs: [...]
---
```

用户反馈：「这一块有什么意义吗？」——回看：
- `phase / status`：UI 顶部 PhaseProgress 徽章已经显示
- `task_id`：URL 里有
- `context_docs`：UI 顶部 ContextDocsPanel 完整列出
- `upstream / downstream`：纯架构 metadata、**没有任何代码消费**

**结论**：纯冗余、artifact panel 顶部一大块视觉噪音、删。删完直接从 `# 方案：xxx` 起头。

#### 9. V0.5.5 commit 全景

```
da6e788 feat(v0.5.5): A+B 优化 + SDK 诊断 + SSE 重连 + prompt 瘦身 + revise 分级 + 重启加强
```

> 23 文件 / +899 -540（HANDOFF +182 占大头、代码净减 70 行）。包含 V0.5.5 全部 8 大块改动。

#### 10. V0.5.5 待办（接力 AI / 用户测试）

- **核心待测**：跑完整 plan → build → review、看 V0.5.5 改动是否在用户操作路径上都生效
- ✅ **ask_user 问两轮就停的问题**（§6 末尾遗留）→ **已在 V0.5.6 解决**（用户拍板「无上限 + 加稍后再补充按钮」、见下方 V0.5.6 段）
- **SDK status=ERROR message=(none) 复现**：等下一次 status=error、看 dev server 终端 `[plan-runner] SDK status message: ...` 日志能否拿到 message——拿不到就是 SDK bug、可以反馈 Cursor 团队
- **诊断口扩**：如果下一轮还频发 status=error、考虑在 `case "status"` 同步 publish 一条 `info` 事件（而不只是 console.log）、让用户在前端事件流里也能看到所有 status 跳变

---


### V0.5.4：再聊聊抽组件 + 加贴图 + 弹窗滚动 + hook 复用（2026-05-19 上午）

> 用户上午联测发现 3 个体验问题、顺手抽公共 hook + 加规则。

#### 1. 「再聊聊」输入卡顿（核心修复）

**坑**：用户在「再聊聊」弹窗里打字、明显卡顿。
**根因**：`reviseDraft` state 放在 `TaskDetailPage` 顶层、每次按键触发整页 re-render。`EventStream` 虽然 `memo` 过、但 SSE 持续 `setTask({...prev, events: [...prev.events, ev]})` 让 task 引用持续变化、`memo` 浅比较失效、几百条事件子树参与 reconcile、单次 keystroke > 16ms。
**修法**：抽 `src/components/tasks/revise-dialog.tsx`、`draft` state 下沉到子组件内部、父组件只持 `reviseOpen` + `onSubmit(feedback, images?)`。`memo(ReviseDialogImpl)` 作第二道防线（父 re-render 时 props ref 没变就跳过本组件）。
关键 commit：`e451e73`。

#### 2. 「再聊聊」加贴图（端到端打通）

跟 chat 的贴图链路完全同款：
- 协议层：`ToolReturn.phase_revise` 多 `imagePaths?: string[]`、`formatToolReturnAsText` 在 feedback 后拼 `[ATTACHED_IMAGES]` 段（与 chat 的 user_reply 同款格式、agent 用 `read` 工具看图）
- 后端 API：`phase-ack/route.ts` body 多 `images?: []`、复用 `saveImageAttachments` 落盘、`user_reply.meta.images` 写跟 chat-reply 同款形状（UI 缩略图复用 `extractUserReplyImages`）
- `chat-mcp.ts` `submitPhaseAck(... imagePaths?)` 透传
- `prompts` 一线：`plan-runner.ts` revise 那段加 V0.5.4 段：**「带图时先 `read` 全部图、再 `ask_user` 复述」**、明确禁止「忽略图直接 ask_user」
- 前端：`ReviseDialog` 内嵌贴图 UI（粘贴 / 拖拽 / 选文件 / 缩略图 / 移除）

#### 3. 新建任务弹窗 MCP 多时被挤出屏幕 → 全局 mask 滚动改造（最终态）

**坑**：MCP 服务多、展开后弹窗高度超屏、底部「创建 / 取消」按钮被推出 viewport 看不到。

**演进**：
- 第一版：`NewTaskDialog` 单点修 `max-h-[90vh] overflow-y-auto`（弹窗内部出滚动条）
- 用户拍板：要 **mask 滚（弹窗长在文档流里、超长时整页连同 mask 一起滚）**、不要弹窗内滚
- 最终落地（commit `d413f9b`）：**改全局 `DialogContent` 默认布局**——所有 Dialog 自动获得 mask 滚动、不再需要单独加 max-h / overflow

**关键改动 `src/components/ui/dialog.tsx`**：
- 旧实现：Popup `fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 grid gap-4`、超长内容超屏看不到
- 新实现：
  - `DialogOverlay`（base-ui Backdrop）保留 `fixed inset-0`、只负责视觉遮罩 + click-close
  - **新增 scroll wrapper**：`fixed inset-0 z-50 overflow-y-auto grid place-items-center p-4`（短内容居中、长内容自然撑长 + 整页滚）
  - Popup 改 `relative` + 保留原 `grid gap-4`、随内容高度自然撑
- 注意 base-ui 限制：Backdrop / Popup 是 Portal 内的兄弟节点（不能 Backdrop 套 Popup）、scroll wrapper 必须跟 Backdrop 同层、跟 Popup 是父子

**已知回归 + 修复**（commit `8c4f4d9`）：第一次改造漏带 `grid` className、导致 Popup 内部子项 `gap-4` 失效（block 容器上 gap 是无效 CSS）、子项贴在一起。补回 `relative grid` 共存——`display: grid` + `position: relative` 合法。

**影响范围**：
- 所有 Dialog 自动获得 mask 滚动：`NewTaskDialog` / Settings / `ContextDocsPanel` / `TaskMcpPanel` / `ConfirmDialog` / `PromptDialog` / `FsPickerDialog` / `ApprovePhaseDialog` / `ReviseDialog`
- **`AskUserDialog` 自管布局不受影响**——它显式用 `flex max-h-[80vh] flex-col gap-0 overflow-hidden p-0` 三段布局（sticky header / scroll body / sticky footer）、className 后写 override 掉默认 `grid gap-4 p-4`、新 mask 滚 wrapper 只是把整窗居中、`max-h-[80vh]` 仍然兜住、Q 列表内部滚动行为完全保留
- `DialogFooter` 的 `-mx-4 -mb-4` 依赖父 `DialogContent` 有 `p-4`——新版仍然 `p-4`、不破

**调用方旧的 `max-h-[xx] overflow-y-auto` 应该删掉**（NewTaskDialog 已删）、否则会双层 scroll 体验差。

#### 4. 抽 `useImageAttach` hook（event-stream + revise-dialog 共用）

两处贴图逻辑长得一样、各写一遍 200 行——按用户拍板的新规则（复用 >= 2 且省 30+ 行手工代码 → 抽）抽出。
- `src/hooks/use-image-attach.ts` 新增：state（attachedImages / isDragging / fileInputRef）+ 所有 handler（粘贴 / 拖拽 / 选 / 移除）+ 校验 + `toUploadPayload()`
- `disabled` 选项：调用方未到可输入态时所有 handler 短路
- `ReviseDialog` -130 行 / `EventStream` -155 行 / 净减 60 行手工重复 / bug 以后修一次到位

关键 commit：`69f709a`。

#### 5. ApprovePhaseDialog 不再每次 page re-render 都读 localStorage

`defaultModel` / `apiKey` 之前是 IIFE 每次 page render 都 `getSettings()` 从 localStorage 读 + JSON.parse、SSE 频繁 setTask 时一秒打好几次。改 `useMemo(..., [approveDialogOpen])`、只在 dialog 打开瞬间读一次、关闭后忽略变化。

#### 6. 编码规则补强：减少手戳代码 / 优先复用 + 用成熟库（用户拍板）

`.cursor/rules/learned-conventions.mdc` 「减少 state / 优先用成熟库」段重写、扩三个子节：
- **减少 state**：useState 多 / 派生 state / 不下沉
- **减少重复代码 / 减少手戳方法**（V0.5.4 新加）：同样 handler / UI / 工具函数写两遍就抽；方法体 > 30 行 / 嵌套 > 3 / 单函数 setState > 3 → 拆；避免手撸状态机
- **优先用成熟库**：react-hook-form / @tanstack/react-query / immer / @use-gesture/react / dayjs（已引就直接用、没引但场景合适讨论引入）
- **抽象门槛**：复用 >= 2 且省 30+ 行 → 抽；< 30 行内嵌不抽；修同一类 bug 三次必抽

#### 7. V0.5.3 + V0.5.4 commit 全景

```
8c4f4d9 fix(v0.5.4): DialogContent 补回 grid className（gap-4 间距）
d413f9b feat(v0.5.4): DialogContent 改 mask 滚动（用户拍板方案 A、全局生效）
8b1a167 docs(handoff): 补 V0.5.3 + V0.5.4 演进段
69f709a refactor(v0.5.4): 抽 useImageAttach hook、event-stream + revise-dialog 共用
e451e73 feat(v0.5.4): 再聊聊抽组件 + 加贴图 + 新建任务弹窗整窗滚
cb70090 refactor(v0.5.3): D-1 首页提速 + D-2 删死字段
a15db37 refactor(v0.5.3): 抽 getNextPhase helper + 删死代码 + 注释对齐 V0.5
```

#### 8. 接力 AI 待办

- **真任务联测**（V0.5.2 §11 那些场景）+ **V0.5.4 贴图闭环**：
  - 「再聊聊」贴图（粘贴 / 拖拽 / 选文件）→ 看 agent 是不是**先 `read` 图再 `ask_user`**、还是偷懒跳过
  - mask 滚动跨所有 Dialog 验证：NewTask（MCP 多时）/ Settings / Context Docs / MCP Panel / Confirm/Prompt / FS Picker / Approve / Revise——确认子项间距正常、整窗能滚、不双层 scroll
  - AskUserDialog 自管布局回归测：sticky header / 中间 Q 列表滚 / sticky footer 三段保留
- **首页提速验证**：D-1 改完后用户没明确反馈「快了」、需要联测时确认
- **ask_user「其他答案」框贴图**（用户提议、设计待办、详见 §9）

#### 9. V0.5.7 设计预案：ask_user「其他答案」框支持贴图

> **状态**：用户提议 + 拍板「**每个 question 独立贴图**——做不到就宁可不做」、设计已对齐、**未实施**、延后到 V0.5.7（原本规划在 V0.5.6 号、但 V0.5.5 测完后用户先拍了「ask_user 无次数上限 + 稍后再补充」、那批落到了 V0.5.6、贴图顺延到 V0.5.7、等 V0.5.6 测稳再开）。

**为什么要做**：HITL 通道统一行为——`revise` / `chat-reply` 都允许贴图、唯独 `ask_user` 不允许、语义割裂。典型场景：AI 问「这个组件做 A/B/C/D 哪种」、用户想说「都不是、看截图我要 E」——贴图比文字直接得多。

**用户硬约束**（拒绝简化方案）：

| 方案 | 用户态度 | 理由 |
|---|---|---|
| 整批 ask 共用一组图（max 6） | ❌ **拒绝** | 「语义模糊、不知道图是给哪个问题的、宁可不做、走 ack 后再聊聊补图」 |
| 每 question 独立图集（max 6 / question） | ✅ **要做** | 「图绑特定 question、agent 不用猜归属」 |

**技术难点 + 解法**：

React Hooks 规则禁止在 map / 循环里动态调用 hook、所以「每 question 一个 `useImageAttach` instance」走不通。解法是**升级 `useImageAttach` 成多 key 图集**：

```ts
// 现状（V0.5.4、单 key）：
const { images, onPaste, removeImage, ... } = useImageAttach();

// V0.5.7（多 key、向后兼容）：
const attach = useImageAttach();
attach.getImages('q1');                    // 取 q1 的图
attach.onPaste(e, 'q1');                   // q1 贴图
attach.removeImage(0, 'q1');               // 删 q1 第 0 张
// 老调用方（ReviseDialog / EventStream）不传 key → 走 'default' → API 不变
```

**改动量预估**（≈ 235-255 行、跨 6 文件）：

| 文件 | 改动 |
|---|---|
| `src/hooks/use-image-attach.ts` | 内部 state 改 `Record<key, PendingImage[]>`、API 加 `key?` 默认 `'default'` ≈ 60-80 行重写 |
| `src/components/tasks/ask-user-dialog.tsx` | 每 question「其他答案」展开时附 attach 按钮 + 缩略图条 ≈ 60 行 |
| `src/lib/task-store.ts` | `submitAskReply` 加 `imagesByQuestion?: Record<string, ChatReplyImage[]>` ≈ 5 行 |
| `src/app/api/tasks/[id]/ask-reply/route.ts` | 按 questionId 分组校验 / 保存 + meta 分组 ≈ 70 行 |
| `src/lib/server/chat-mcp.ts` | `imagePathsByQuestion?` 参数 + 每 question reply 拼 `[ATTACHED_IMAGES for Qx]` ≈ 25 行 |
| `src/lib/server/plan-runner.ts` | prompt 增加「ask_user reply 按 Q 号各自 read 图、综合判断意图」≈ 15 行 |

**风险**：
1. **`useImageAttach` 是 V0.5.4 刚抽的 hook**——升级要确保 ReviseDialog / EventStream 两个老用户不退化、上 + 手测两条路径
2. **AskUserDialog 布局变长**——「其他答案」展开 + 缩略图条 + 多 question 场景、`max-h-[80vh]` 内部 scroll body 要兜得住
3. **agent prompt 复杂度**——「N 个 question 各带图集」对 agent 读图调度要求更高、要给清楚示例（建议给一段「3 个 question、Q1/Q3 带图」的标准处理流）

**节奏拍板**：等 V0.5.6 + V0.5.5 + V0.5.4 测稳再开 V0.5.7、避免叠改难定位 bug。

---


### V0.5.3：refactor / 性能 / 死代码清理（2026-05-18 晚 ~ 2026-05-19 早、不破功能）

> V0.5.2 联测过程中扫了一遍代码、发现几处过期注释 / 死字段 / 重复逻辑 / 首页慢、批量清掉。

#### 1. `getNextPhase(workflowDef, current)` helper（去重 `indexOf + idx+1` 三处）

`plan-runner.ts` / `phase-ack/route.ts` / `approve-phase-dialog.tsx` 各自 inline 一段 `workflowDef.phases.indexOf(current) + 1` → 抽到 `src/lib/types.ts` 一个 helper、三处都改用。同时删 `task-store.ts` 里 `FEISHU_WORKFLOW_NEXT_PHASE` 死表（漏网常量、没人 import）。
关键 commit：`a15db37`。

#### 2. D-1：首页加载慢——`listTasks` 不再 hydrate 全量 `events` / `artifact`

**坑**：首页任务列表慢、用户实测「确实慢」。原因：`listTasks` 对每个任务都 `hydrateTask`、跑 `readEvents`（jsonl 全文 parse）+ `readArtifact` × N phases 的 IO + JSON.parse。N 个任务 → N×5 文件 IO + N 次 jsonl 全解析。
**修法**：
- `src/lib/types.ts` 加 `TaskSummary = Omit<Task, "events" | "phases">`、首页只需要这部分字段
- `src/lib/server/task-fs.ts` 加 `hydrateTaskSummary`、`listTasks` 改返 `Promise<TaskSummary[]>`、跳过 events / artifact 读
- `src/lib/task-store.ts` `fetchTasks` 改返 `TaskSummary[]`
- `src/app/page.tsx` + `src/components/tasks/task-card.tsx`：state 改 `TaskSummary`、`canArchive` 入参改 `TaskSummary`

#### 3. D-2：删死字段 `attachedDocs` / `swaggerUrl`

V0.3 上下文文档机制已统一走 `contextDocs`、`attachedDocs` / `swaggerUrl` 仅在 schema / API 留着、UI / agent prompt 都没用。直接删：
- `src/lib/types.ts`：`Task` / `NewTaskInput` / `WorkflowDef.requiredFields` 去掉
- `src/lib/server/task-fs.ts` `TaskMeta` 去掉、`hydrateTask` / `createTask` 不再写
- `src/app/api/tasks/route.ts` POST 不再解析
- `src/lib/server/plan-runner.ts` 模板渲染去掉对应变量

D-1 + D-2 一起在 `cb70090`。

---


### V0.5.1：联测中的 prompt / UI 打磨（2026-05-17 ~ 2026-05-18、持续）

> 用户开始走真任务联测、发现一堆 prompt 边缘 case、UI 交互不顺、SDK 工具名错配。本段记录所有 V0.5.1 的修复与决策、给后续 AI 接力用。

#### 1. SDK 1.0.13 工具名修正（影响所有 prompt + skill）

SDK 1.0.13 工具名是 **`read` / `edit` / `write` / `delete` / `shell` / `grep` / `glob` / `task`**——**不是** `read_file` / `edit_file` / `write_file`。早期 prompt 里大量带 `_file` 后缀的写法导致 agent 调失败 / SDK 拒掉、看起来像 agent 在 hallucinate 工具名、实际是我们 prompt 教错了。

- 全量修：`prompts/phase-1-plan.md` / `prompts/phase-2-build.md` / `prompts/phase-3-review.md` / `src/lib/server/plan-runner.ts` / `src/lib/server/chat-runner.ts` / `skills/*/SKILL.md` / UI 文案 / 代码注释 / `docs/DESIGN.md` 全清
- 关键 commit：`b85cfe5`（prompts 主修）+ `fd2ff12`（代码注释 / UI / docs 清扫）

#### 2. revise feedback 不闷头改、永远先 ask_user 复述（D 方案最终态）

**坑**：用户点「补意见」（旧文案「跟 AI 再聊聊」）只随便打了 `111` 或一句模糊话、agent 直接修改 artifact。
**根因**：旧 prompt 教 agent「拿到 `[PHASE_ACK revise] + feedback` 就改 artifact」、agent 不验证理解就动手、用户根本来不及确认。

**最终方案（用户拍板：不分支、永远弹）**：

- 拿到 `[PHASE_ACK revise] + feedback` 后、**无论 feedback 多清晰、永远先调一次 `ask_user`** 跟用户复述自己的理解 + 改动计划。问题文案动态生成（feedback 清晰 vs 模糊 vs 极短分三档文案）
- 这次 `ask_user` 调用 **不计入「写 artifact 初稿阶段最多 1 次 ask_user」限额**（这俩限制此前打架、agent 优先后者直接动 artifact、所以必须分开计）
- agent 在 `tool_call` 触发的 `assistant_message` 里**严禁泄露协议名**（`[PHASE_ACK revise]` / 「反馈过短」/ 「无具体改进意图」这类公文措辞）、必须自然口吻直接跟用户对话

走过的弯路（按时间顺序）：
- `45d9030`：先做 4 步条件 D 方案（feedback 清晰 → 直接改 / 模糊 → ask_user）→ 用户立刻反馈「我打 `111` 也照样改、不要让 agent 判断质量」
- `b281bb3`：修「ask_user 限额冲突」+「协议泄露」两个坑、但还是有条件分支
- `8a5298e`：彻底拆掉分支、改成「永远先弹」最终态

#### 3. resume-waiting 别撒谎说「artifact 已产出」

**坑**：用户 SSE 断线 → 点「继续监听」、agent resume 后说「方案已完成」、但 `artifacts/01-plan.md` 根本没写完（断线时 agent 还在调 `ask_user`）。
**修复**：`src/app/api/tasks/[id]/resume-waiting/route.ts` 用 `fs.stat` 真实读 artifact 文件大小、空 / 不存在 → 拼 `[RESUME_INCOMPLETE]` 给 agent（明示「artifact 没写完、接着写、写完再 wait_for_user」）；有内容 → 拼 `[RESUME_WAITING]`（提示 artifact 已就绪、继续等用户 ack）。
关键 commit：`a37614c`。

#### 4. agent 中间 phase 提前退 run

**坑**：plan ack approve 后、agent 不进 build、直接 emit「workflow 已完成」退 run。
**修复**：`buildSuperPrompt` 加多段强约束 + 阶段转换 banner、`PHASE_ACK approve` 拿到后必须 emit「进入 X phase」+ 调 phase tool、严禁 summarize 收尾。
关键 commit：`002fae2`。

#### 5. artifact-writer skill（渐进式披露、不再靠 prompt 反复教）

**坑**：plan / build / review 三个 prompt 都得反复教 agent「写 artifact 用 `write` 工具、不要 `edit`」、prompt 越来越长、agent 还是踩坑。
**用户拍板**：用 Skills（Anthropic Agent Skills 标准）做渐进式披露——prompt 里只写一句「写 artifact 前先 `read` `artifact-writer` skill」、agent 第一次写之前自己读 skill 看完整规则。

- 新增：`skills/artifact-writer/SKILL.md`（含工具映射 / 路径规则 / 标准动作 / revise 写法 / 排错 / 跨 phase 复用 6 段）
- `plan-runner.ts` super-prompt + 三个 phase prompt 都简化成「按 `artifact-writer` skill 教的方式」一句话引用
- 关键 commit：`12b9496`

**后续观察**：用 `composer-2 fast` 跑测时偶尔仍用 `edit` 创建新 artifact、起初以为 SDK 会拒、加了「edit + 文件不存在」warning。但实测 **SDK 1.0.13 的 `edit` 工具能创建不存在的文件**、warning 是误报、已删（commit `9df5a9f`）。**当前结论：`write` 是推荐、`edit` 也能用、不再硬拦**。

#### 6. UI 演进：ack 区交互来回三次、最终回到 dialog

ack 区怎么暴露「下一 phase 选模型」「换新 agent」、user-DX 反复磨：

| 版本 | 形态 | 用户反馈 |
|---|---|---|
| V0.5（初版） | 「通过」主按钮 + 齿轮图标打开高级选项 dialog | 「太不显眼了、只有个 icon」 |
| `eecbc18` | 行内化：「下一 phase 模型」selector + 「换 agent」按钮 + 「补意见」+ 「通过」并列、按钮顺序「通过」最后 | 「不太规范、按钮高度对不齐」 |
| `ed23ea1` | 两行布局：上行 muted「下一 phase（X）: [model] [fork]」、下行「[补意见] [通过]」、语义分组 | 「按钮在当前 phase、模型针对下一 phase、很别扭」 |
| `4a7a102`（**最终**） | 回到 dialog：「通过 PHASE」按钮直接打开 `ApprovePhaseDialog`、内含模型 selector + fork toggle、文案标题「通过 X → Y」 | 用户拍板：「先把所有逻辑走通、再回来优化交互」 |

`ApprovePhaseDialog` 同步简化：删了 `DialogDescription` / 警告条 / `ApprovePhaseDialogTrigger`、标题加箭头明示「current → next phase」。

#### 7. 任务级模型字段（`Task.model`、新建任务表单加 selector）

**坑**：ack 回到 dialog 后、plan 阶段（第一个 phase）启动前没有 ack 入口、就没法挑模型——只能用 settings 默认。
**修复**：新建任务表单加「模型」字段、默认值 = `settings.defaultModel`、用户可为本任务单独挑别的。

- `src/lib/types.ts`：`Task` / `NewTaskInput` 加 `model?: ModelSelection`
- `src/lib/server/task-fs.ts`：`TaskMeta` 持久化 `model`、`hydrateTask` 读出来、`createTask` 写进 meta.json
- `src/lib/run-args.ts`：`prepareRunArgs` 优先 `task.model`、空时回退 `settings.defaultModel`（老任务无该字段时自动兜底）
- `src/components/tasks/new-task-dialog.tsx`：加 model selector、列表懒加载（已拉过不重复拉、避免每次开弹窗 toast 噪音）、切到非默认模型时下方 amber 提示
- 关键 commit：`43d3e76`

**模型选择全链路**：
```
新建任务表单（默认 settings.defaultModel、可改）
  → task.model 持久化
  → prepareRunArgs 优先取 task.model 启动 plan/build/review agent
  → 每次 phase ack 时 ApprovePhaseDialog 可再切（切了不同 model 自动隐含 fork）
```

#### 8. 弹窗文案统一极简化

用户拍板「所有弹窗的解释性文案去掉、极简就行」：
- `task-mcp-panel.tsx` `DialogDescription`：从「改完下次启动 workflow / chat 时生效…」缩到「选本任务启用哪些 MCP」
- `context-docs-panel.tsx` `DialogDescription` + 字段帮助文案：从「agent 在 phase 启动时会看到清单、按需拉取（URL → 飞书 / fetch；路径 → SDK `read` 工具）」缩到「agent 启动时会看到清单、按需读取」
- 「跟 AI 再聊聊」按钮文案缩为「补意见」（commit `dfab2b2`）

关键 commit：`8759836`（弹窗）+ `dfab2b2`（按钮）。

#### 9. V0.5.1 commit 全景

按时间倒序（看 `git log` 也行）：

```
43d3e76 feat(new-task): 新建任务表单加模型选择
4a7a102 revert(ui): ack 回到 dialog 弹窗（用户拍板：先走通再优化）
9df5a9f fix(observability): 删 edit+不存在文件的 warning 误报
ed23ea1 feat(ui): ack 区分两行布局
0325021 chore(ui): 换 agent toggle 改用 Button + secondary 状态
eecbc18 feat(ui): phase ack 行内化、模型 selector 外置
12b9496 feat(skill): 加 artifact-writer skill、用渐进式披露替代 prompt 反复教
3f0a9f1 fix(prompts+observability): edit 写新 artifact 第三轮压制
8759836 chore(ui): 弹窗解释性文案统一精简
dfab2b2 chore(ui): 「跟 AI 再聊聊」按钮文案缩短为「补意见」
8a5298e fix(prompts): revise feedback 永远弹 ask_user、不再分支判断
b281bb3 fix(prompts): revise 复述确认两处坑：限额冲突 + 协议泄露
45d9030 fix(prompts): revise feedback 闷头改修复（D 方案：先复述 + ask_user 确认）
a37614c fix(resume): 检查 artifact 实际存在性
002fae2 fix(prompts): 防止 agent 在中间 phase approve 后退 run
fd2ff12 chore: 跟随工具名修正、清理代码注释 / UI 文案 / DESIGN.md
b85cfe5 fix(prompts): SDK 1.0.13 工具名修正 edit_file → write / read_file → read
```

#### 10. V0.5.2 文案 + 意图二分（2026-05-18 收尾、答疑入口最终方案）

**演进**：V0.5.1 §10 原本提议方向 A（新加「问 AI」按钮 + 新协议）、但用户最后拍板了**更简单的方向**——直接把「补意见」按钮**改名「再聊聊」**、不加新协议、**让 agent 在 ask_user 复述时自己判断「用户是想改还是想问」**。

**最终交互**：

```
用户点「再聊聊」→ 输入想说的话（想改 / 想问 / 含混都行）
  → 服务端发 [PHASE_ACK revise] + feedback（协议名沿用、不新增）
  → agent 永远先调 ask_user 复述意图、option 给「我想改 / 我想问 / 先答疑再决定 / 我重新说」
  → 用户在弹窗里选 → agent 走 Path A（改）/ B（只答疑）/ C（先答再决定）
    - Path A: edit artifact → 再 wait_for_user
    - Path B: emit assistant_message 答疑、不动 artifact → 再 wait_for_user
    - Path C: 先 B 答疑、再 ask_user 问「还需要改吗」、按答案走 A 或 B
```

**为什么最终选这个而不是 V0.5.1 §10 的方向 A**：
- 用户视角：少一个按钮、文案更友好（「再聊聊」比「问 AI / 补意见」二选一更直白）
- 实施视角：不新加协议、复用 `[PHASE_ACK revise]` 通道、UI 只改一个文案、prompt 改 D-scheme 即可、工作量从 1.5h 降到 0.5h
- 风险：agent 自己判断意图、可能误判（用户说「这块怎么改」可能是问也可能是要求改）→ 用 ask_user 显式让用户拍板这一步、把判断权重新还给用户

**改动文件**：
- `src/app/tasks/[id]/page.tsx`：按钮文案「补意见」→「再聊聊」、Dialog title「对 X 补意见」→「跟 AI 再聊聊 · X」、Textarea placeholder 改成「想改的地方、有疑问、想问问 AI——都行」、button title 同步
- `src/lib/server/plan-runner.ts`：D-scheme §3 改成「Path A/B/C 三分」、步骤 3 拆 3a（改）+ 3b（仅答疑、严禁 `edit`/`write`、用 `read`/`grep`/`glob` 只读查询 OK）、ask_user options 模板改成「我想改 / 我想问 / 先答再决定 / 我重新说」、绝对禁止段加「走 Path B 答疑时偷偷动 artifact」
- `src/lib/server/chat-mcp.ts` / `src/lib/task-store.ts` / `src/app/api/tasks/[id]/phase-ack/route.ts`：文案 / 注释同步「补意见」→「再聊聊」、说明意图二分
- `src/components/tasks/event-stream.tsx`：注释里的「补意见」改「再聊聊」

**协议层不动**：
- `[PHASE_ACK revise]` 协议名保留（不叫 `[USER_QUESTION]`）、避免老 events.jsonl 兼容问题
- 服务端 phase-ack route 接的还是 `action: "revise" | "approve"`、不变
- agent 自由决定要不要动 artifact、不需要服务端区分

**接力 AI 注意**：
- 走 Path B 时 agent **不能调 `edit` / `write` / `delete`**——这是 prompt 里的绝对禁止、违反 = 用户会发现「我只问了一句、artifact 怎么被偷偷改了」
- `read` / `grep` / `glob` 只读查询 OK、答疑时可能需要查代码或 artifact
- 这次 ask_user 调用**不计入「写 artifact 初稿阶段最多 1 次 ask_user」限额**

#### 11. V0.5.2 之后的待办（接力 AI 该接的）

**真任务联测**（用户多次提到、还没完整跑通一遍）：
- 跑 1-2 个真飞书 story、走完 plan → build → review 三 phase
- 测 fork：build ack 时切模型、确认旧 agent 干净退出、新 agent 接管 review
- 测 03-review.md 4 类差异分流的实际效果、按反馈调 review prompt
- 测新建任务模型字段：选非默认模型 → 跑 plan → 看 SDK Run 用的是不是该模型
- **测「再聊聊」意图二分**（V0.5.2 新加）：分别试三种输入
  - 「字段 X 改只读」（明确想改）→ 看 ask_user 弹的是不是「我想改：…」、选「我想改」后是不是真改了 artifact
  - 「为什么这块用 useReducer？」（明确想问）→ 看 ask_user 弹的是不是「想问还是想改」、选「我想问」后是不是只回了答案、artifact 没动
  - 「111」（含混）→ 看 ask_user 是不是给了「我想改 / 我想问 / 重新说」三选项、是不是没瞎改 artifact

**已知 / 容忍的小坑**：

- `composer-2 fast` 偶尔用 `edit` 创建新 artifact（不是 hard fail、SDK 能处理、warning 已删）
- dev hot reload 杀任务（已知、改 watch 范围内文件就触发、长任务建议 `pnpm build && pnpm start:prod`）
- 代理偶发 ECONNRESET（已知、走科学上网 fake-ip 模式节点抽风、靠手动「继续监听」恢复）

---


### V0.5：review phase + 多 phase 模型选择 + plan 校验前移

> **状态：代码已落地（2026-05-18）、V0.5.1 持续打磨中**（详见下面 V0.5.1 段）。用户拍板「先按 A 来进行、写完三 phase 一起测」、本段记录设计 + 落地结果。

#### 动机

V0.3.3 砍掉 ship phase 是注意力管理决策（先把 plan / build 做扎实、不让后面的 phase 影响）、不是「ship 这个方向不对」。现在 plan + build 走得相对稳了、是时候补"编码完成之后"那一段——但形态从 ship（自动 PR / 飞书同步）转向 **review**（拿确定性产物做差值对照）、因为：

1. **ship 的"动作部分"风险高**：git push / 改飞书 story 状态都是不可逆动作、LLM 选错工具就麻烦
2. **ship 的"信息部分"价值高**：commit msg / PR body / 飞书评论草稿用户每次都要写、自动化 ROI 直接
3. **review 是真正的 harness 增量**：拿 `git diff`（确定性产物）跟 `01-plan.md`（确定性约束）做结构化差值、给用户喂 review 弹药、不让 LLM "判断对错"（避开 Cognition 警告的 AI 自审共识盲点）

#### Phase 拓扑变化

```
当前（V0.4）：plan → build
V0.5 起：     plan → build → review
```

review 完成后任务 = `completed`。PR 提交 + 飞书状态回写 **仍然**由用户手动（不重新自动化）、但 review artifact 里会带 commit msg / PR body / 飞书评论草稿、用户复制走。

#### review phase 设计要点

| 维度 | 设计 |
|---|---|
| **输入** | `01-plan.md` + `02-build.md` + `git diff`（本次 build 实际改动） + contextDocs（飞书需求 + 用户补充文档） + 仓库现状 |
| **产出** | `artifacts/03-review.md` |
| **artifact 结构** | 顶部「整体一致性」总评 + 4 类差异表 + 跟飞书需求对照 + 交付信息（commit msg / PR body / 飞书评论草稿） |
| **HITL** | 用户「整体通过」一次性 ack、或对单项 revise（agent 按指示动 build 或 plan） |
| **差异由谁改** | **按差异类型分流**（详见下表）、不做 agent 自动循环修复 |

**4 类差异分流**（用户拍板「先做出来看效果」、表格仅作设计预案、artifact 模板会给最终形态）：

| 差异类型 | 默认建议 | 谁拍板 |
|---|---|---|
| 范围扩张（plan 没列、实际改了） | 更新 plan task 加上、agent 解释为什么必要 | 用户 ack（默认通过） |
| 范围收缩（plan 列了、实际没改） | 从 plan 删 / 加「已无必要」注解 | 用户 ack |
| 实现偏差（plan 描述跟实际改法不一致） | 🚨 标红、必看 | 用户必选：a) 改回 plan b) 接受偏差 + 更新 plan 描述 |
| 未完成（plan task N 没做） | 列原因 | 用户必选：a) 现在补 b) 建 follow-up task c) 接受 |

**坚决不做** "agent 发现差异自己修、再 review 一轮" 这种自动循环（会死循环 / 烧 token、HITL 闸门被绕过）。

#### plan phase 增强：校验前移（防御性、不开新坑）

review phase 兜底的逻辑可能让 plan / 飞书文档的差异留到 review 才发现、循环回 plan 浪费 1 次 ack。所以 V0.5 同步增强 plan：

- plan agent 生成 `01-plan.md` 时、如果发现自己对飞书 story / contextDocs 的理解跟原文有差异（hallucinate / 偏离 / 信息缺失）、必须在 artifact 里写**「我的理解 vs 飞书原文」对照段**
- 用户审 plan 时直接看到差异、当场修正、不留到 review 阶段
- 实现：改 `prompts/phase-1-plan.md`、加一段「自我校验」步骤 + artifact section 模板

#### agent 复用策略（用户拍板：决定权给用户）

```
默认（V0.5 起）：plan → build → review 全程同一 agent（同一 SDK Run、+0 send 配额、上下文连续）
可选：用户在 phase ack 时手动切「换新 agent」、+1 send 配额、reviewer ≠ author
```

**为什么默认同一个 agent**（不是默认强制起新的）：用户老套餐是 500 次请求计费、不是 token 计费、小需求起新 agent 浪费配额。决定权给用户、复杂 / 重要任务用户自己点「换新 agent」。UI 上 phase ack 弹窗加 toggle、默认关闭、关闭时灰色提示「→ 起新 run、+1 send 配额、reviewer ≠ author、更接近真人 code review」。

#### 模型选择策略（用户提议、值得做）

```
settings.defaultModel = 默认模型（所有 phase / 新建任务的初始选中值）
+ 每个 phase ack 时可切模型（默认值 = settings.defaultModel）
+ 切了不同模型 → UI 暗示「下一 phase 必须起新 agent run」（SDK 限制：同一 run 内不能换模型）
```

实现要点：
- settings 加 / 复用 `defaultModel` 字段（已有）
- 新建任务表单、phase ack 弹窗都加 model selector、初始值 = `defaultModel`
- 切了不同模型 → 自动勾上「换新 agent」toggle、不让用户手动两步操作

#### artifact 模板：03-review.md

放在本文档下方「附录 A: 03-review.md artifact 模板示例」段、供 prompt 设计时直接抄。

#### 不做（V0.5 明确止损）

- ❌ 自动 git push / 自动调飞书 MCP 改 story 状态（V0.3.3 砍 ship 的核心规避项、V0.5 不重新拾起）
- ❌ agent 自动循环修复差异（HITL 闸门优先）
- ❌ 默认强制起新 agent run（用户拍板：决定权给用户、500 次套餐计费现实）
- ❌ 给 review 强制配「专用模型」（用户拍板：默认就是 settings 默认模型、不过度设计）
- ❌ review 之后再加 phase（V0.5 收敛到 review、不一次开多个口子）

#### 实施 checklist（2026-05-18 完成、待联测）

| 步骤 | 文件 | 完成状态 |
|---|---|---|
| 1. 加 PhaseId | `src/lib/types.ts` | ✅ `PhaseId = "plan" \| "build" \| "review"` + `WORKFLOWS.feishu-story-impl.phases` 加 review |
| 2. 写 review prompt | `prompts/phase-3-review.md` | ✅ 拿 git diff + plan + build artifact 做差值对照、按 4 类差异分流、产出 commit msg / PR body / 飞书评论草稿、严格只输出文本不动文件 |
| 3. plan 校验前移 | `prompts/phase-1-plan.md` | ✅ 加「§1.1 我的理解 vs 飞书原文（自我校验、V0.5 校验前移）」对照段、硬约束不可省 |
| 4. plan-runner 支持 review | `src/lib/server/plan-runner.ts` | ✅ `PHASE_PROMPT_FILE` 加 review、`planArtifactPath` 模板变量（给 review 读 01-plan.md）、`task-fs.ts` PHASE_ORDER 加 review |
| 5. phase ack 高级选项 UI | `src/components/tasks/approve-phase-dialog.tsx`（V0.5 新增） | ✅ 主按钮「通过」旁齿轮图标打开 dialog、含模型 selector + 「换新 agent」switch、模型切了自动勾上 fork 且不可关 |
| 6. plan-runner 支持 fork 模式 | `src/lib/server/plan-runner.ts` | ✅ `runPlanWorkflow` 加 `fork?: { fromPhase, reason }`、`buildSuperPrompt` 顶部加 fork banner、`markPlanForFork` + `waitForPlanToStop` helper |
| 7. phase-ack 路由支持 fork | `src/app/api/tasks/[id]/phase-ack/route.ts` | ✅ 接收 `forkAgent / nextModel / bootArgs`、fork 路径走 `markPlanForFork → cancelPlan → waitForPlanToStop → markPhaseAcked → runPlanWorkflow(fork=...)` |
| 8. phase 进度条 / 任务列表展示 review | `src/components/tasks/phase-progress.tsx` + `task-card.tsx` + `task-display.ts` | ✅ PHASE_LABEL 加「复核交付」、PHASE_LABEL_EN 加「Review」、动态 phaseOrder 自动渲染 |

#### 关键实现细节（给后续 AI 用）

**fork 流程**：

```text
用户在 phase ack 弹窗勾「换新 agent」/ 切模型 → 前端调 submitPhaseAck(approve, ..., { forkAgent, nextModel, bootArgs })
  → phase-ack route：
    1. markPlanForFork(taskId)  // 让旧 run 收尾时跳过 done 帧、保留 SSE 连接给新 agent
    2. cancelPlan(taskId)       // cancelPending + run.cancel() 让旧 agent 拿到 [CANCELLED] 退出
    3. waitForPlanToStop(taskId, 10000)  // 轮询等 runningPlans delete、防止新 run 被幂等保护拦截
    4. markPhaseAcked(taskId, ackPhase)  // patch 数据库：ackPhase=ack、currentPhase=nextPhase
    5. runPlanWorkflow({ task, model: nextModel, fork: { fromPhase: nextPhase } })
       → Agent.create 新 agent（不是 resume）
       → super-prompt 顶部加 fork banner、列已完成 phase 的 artifact 路径、提示「直接从 fromPhase 开始」
```

**为什么 fork 时不发 done 给 SSE**：watchChatStream 客户端拿到 done 后会停止订阅、UI 看不到新 agent 的事件。`forkPendingTasks` Set 让 cancelled 分支识别「这是 fork、保留 SSE」。新 agent 启动时新 publishChatStreamEvent 接着推、客户端无感切换。

**plan 校验前移的硬约束**：plan agent 必须写「§1.1 我的理解 vs 飞书原文」段、即使没差异也要写「✅ 所有关键点跟 contextDocs 原文一致」。这是为了把跟飞书的差异前置暴露在 plan ack、不留到 review 阶段才发现循环回 plan。

**review phase 唯一允许的写入**：`{{artifactPath}}`（即 `03-review.md`）。任何其它文件都是只读。这是给 review agent 的硬约束、违反 = 本 phase 直接 revise。所以 review **不调动作类 MCP**（不提 PR / 不改飞书状态）、只输出 commit msg / PR body / 飞书评论草稿 / 自测 checklist 文本、让用户复制走。

#### 附录 A：03-review.md artifact 模板示例

````markdown
---
phase: review
status: awaiting_ack
upstream: 01-plan.md, 02-build.md
downstream: (final)
task_id: t_xxx
generated_at: 2026-05-18T10:00:00+08:00
---

# Review · 任务名称

## 一、整体一致性总评

- **plan 实施完整度**：5/7 task 完成（71%）
- **代码改动跟 plan 范围匹配度**：高 / 中 / 低（附理由）
- **跟飞书 story 原始需求一致性**：高 / 中 / 低（附理由）
- **建议结论**：✅ 可交付 / ⚠️ 有偏差需用户决策 / ❌ 实施严重偏离 plan

## 二、差异分类对照

### 2.1 范围扩张（plan 没列、实际改了）

| 文件 | 改动概要 | 为什么必要 | 建议 |
|---|---|---|---|
| `src/lib/foo.ts` | 新增 utility 函数 | task 3 用到、plan 漏列 | 加入 plan task 3 |

### 2.2 范围收缩（plan 列了、实际没改）

| plan task | 原计划 | 实际状况 | 建议 |
|---|---|---|---|
| task 5 | 改 BarComponent.tsx | 实际已是目标形态、无需改 | 从 plan 删 |

### 2.3 🚨 实现偏差（plan 描述跟实际改法不一致、用户必看）

> 这里每条用户必须选一个处理路径、否则 review 不能 ack。

#### 偏差 1：task 2 的状态管理

- **plan 描述**：用 `useState` 维护表单 state
- **实际改法**：改用 `useReducer`
- **原因**：字段联动复杂、useState 写出来要 5 个 setter 互相调
- **用户选择**：
  - a) 改回 useState（agent 会按 plan 改代码）
  - b) 接受偏差、更新 plan 描述

### 2.4 未完成（plan task N 没做）

| plan task | 原计划 | 为什么没做 | 建议 |
|---|---|---|---|
| task 7 | 加单测 | 时间不足 / 仓库无单测惯例 | a) 现在补 b) follow-up task c) 接受 |

## 三、跟飞书需求对照

| 飞书需求项 | 本次是否覆盖 | 实施位置 | 备注 |
|---|---|---|---|
| 用户列表批量导出 | ✅ | `src/pages/users/list.tsx:42-86` | |
| 导出权限校验 | ❌ | (未实施) | plan 漏列、需要补 |

## 四、交付信息（用户复制走）

### 4.1 Commit message 草稿

```
feat(users): 加用户列表批量导出

- 新增 ExportButton 组件、调 /api/users/export
- ...
```

### 4.2 PR title + body 草稿

**标题**：`feat(users): 用户列表批量导出 [STORY-12345]`

**正文**：（agent 按团队 PR template 填）

### 4.3 飞书评论草稿（给 PM / 测试看）

> 用户列表批量导出已完成、已开 PR #xxx。改动范围：xxx。需要测试关注：xxx。

### 4.4 自测 checklist

- [ ] 启动 dev server、访问 /users/list
- [ ] 点「批量导出」按钮、确认弹窗 → 确认下载文件
- [ ] xxx
````

> ⚠️ 这是设计稿、prompt 拿这个当 schema、不要原样让 agent 复制。实际产出 agent 会按真实改动填、4 类差异里有 0 项时整段省略。

---


### V0.2 → V0.3.5 演进（2026-05-11 ~ 2026-05-15）

#### V0.2（2026-05-11）：4 phase workflow 落地

- **plan 模式 = 4 phase workflow**：context → plan → build → ship、一次 SDK Run 跑完全程
- **`wait_for_user` V2 语义**：支持 chat + workflow 两种模式、workflow 模式带 phase / artifact 参数
- **artifact 路径升级**：`artifacts/<NN>-<phase>.md`、`task-fs` 双读兼容 V0.1
- **新建任务默认 plan + 飞书 story 链接必填**
- **4 个 phase prompt 模板**：`prompts/phase-1-context.md` / `phase-2-plan.md` / `phase-3-build.md` / `phase-4-ship.md`
- **任务详情页 plan 视角**：phase 进度条 + artifact 预览 + 事件流 + 顶部「通过 / 补意见再跑」

#### V0.3（2026-05-11 ~ 2026-05-12）：上下文面板 + ask_user

- **ContextDocsPanel（任务级上下文文档面板）**：详情页可折叠面板、用户随时增删 URL / path / 自由文本、agent 各 phase 都能用
- **Phase 1/2 角色重划**：Phase 1 只综合用户提供的上下文（不扫仓库）、Phase 2 接管仓库扫描、消除两 phase 重叠
- **ask_user MCP 工具（V0.3 inline 形态）**：phase 内细粒度问答、答案自动落到 `contextDocs`（title=`Q: 问题`）后续 phase 复用

#### V0.3.1（2026-05-12）：抗 anti-loop / 文件并发

- **`keep_alive_a/b/c` 三端点轮转**：[USER_AWAITING] 文案伪装成「服务端事件查询接口」、配合 `next` 字段轮转、降低 anti-loop 触发
- **`task-fs` 原子写 + 任务级互斥锁**：彻底解决 `readMeta` 的 `SyntaxError: Unexpected end of JSON input`（race during `appendEvent`）
- **race 条件修复**：phase ack 后旧 keep_alive 调用回 `[STALE]` 而不是 `[CANCELLED]`、避免 agent 误退 run

#### V0.3.2（2026-05-12 ~ 2026-05-13）：协议硬约束 + ask_user 弹窗化

- **`wait_for_user` 重发拦截**：服务端检测到同一 task 已有 pending 还重发 `wait_for_user` → 返 `[PROTOCOL_VIOLATION]` 携带活跃 token、强制 agent 走 `keep_alive_a(token=...)` 续接、不顶替原 entry
- **prompt 反「批量预言 / 自救式重发」**：明确禁止「I will perform N additional tool calls」「Attempt calling wait_for_user again to consolidate state」「已暂停轮询、重新发起 wait_for_user」三类 thinking / message
- **ask_user 改造为弹窗 modal**（用户拍板）：
  - 入参 `question` → `questions[]`、一个 phase 内**只调 1 次 ask_user**、把所有不确定项打包问完
  - UI 用 modal dialog（`ask-user-dialog.tsx`）、不在事件流里 inline、避免被 keep_alive 信息淹没
  - options 自动加 **A/B/C/D 字母前缀**（对标 Cursor `askFollowUpQuestion`）
  - 一次性提交所有答案、不可 dismiss（必须答完）、答案批量 addContextDoc
  - 返回 `[ASK_USER_REPLY]` 头 + `Q1/A1 Q2/A2 ...` 拼接 markdown 给 agent
- **`status=error` 诊断增强**：catch 里 dump `CursorSdkError` 的 `code` / `status` / `requestId` / `endpoint` / `cause` 字段、能拿 requestId 去 Cursor 后台查

#### V0.3.3（2026-05-13）：砍 ship phase + 周边 UX

- **删 ship phase**（提 PR + 同步飞书 story 状态）
  - **砍掉理由 = 注意力管理、不是技术决策**：用户拍板「一个 phase 一个 phase 做扎实、先不让后面的 phase 影响当前焦点」。当时 plan / build 本身的产出还在打磨、ship 自动化（git push / 飞书 MCP）一旦掺进来、踩坑面会同时变大、调试链路变长。先收敛到 `plan → build`、把这两 phase 跑稳之后再考虑后续 phase。
  - ⚠️ **不要再写"砍 ship 因为效果不稳"**——这是早期 commit message 里的错误表述、已统一更正
  - V0.5 起会重新引入"build 之后的 phase"、但形态变了（review、不是 ship）、见下方 V0.5 设计段
- **任务级 MCP 黑名单** `Task.disabledMcpServers`：UI 给每个任务一个开关、settings 加新 MCP 自动对所有任务生效、用户能按任务关掉某些 MCP（黑名单语义而不是白名单）
- **Settings 优化**：模型列表按钮不需要 API key 验证、MCP servers JSON 加 prismjs 高亮
- **AskUserDialog**：「Other」选中时同时显示其它 option（不是切换式）、textarea 移到下方、有底部间距
- **「补意见再跑」按钮**：文案改成更准确的「跟 AI 再聊聊」、对应 dialog 也调整、去掉过度繁琐提示

#### V0.3.4（2026-05-13 ~ 2026-05-14）：context 合进 plan

- **删 context phase、把上下文收集合进 plan phase**：`PhaseId = "plan" | "build"`、phase 序列 = `[plan, build]`
- 合并理由（用户实操后拍板）：分离 context / plan 价值未兑现、用户审 context 时的判断点跟审 plan 时重合、反而多审 1 次、多 ack 1 次、agent 也多写 1 份 artifact。合并后 plan 一气呵成：读上下文 → 扫仓库 → 出方案、用户只审 1 次。
- prompt 同步重写、把原 phase-1-context 内容并入 phase-2-plan
- artifact 结构变成 `artifacts/01-plan.md` + `artifacts/02-build.md`（原 `01-context.md` 概念删除）

#### V0.4（2026-05-15）：多角色 schema + 通用化 + chat 自由化

##### 4.1 多角色 schema

**核心动机**：飞书 story 是「跨角色共享」的——同一条 story 通常涉及前端 / 后端 / 数仓 / 测试 / 移动端、每个研发只关心其中一部分。之前 prompt / UI 把「前端」写死、扩到其他角色得到处改 prompt。

**改造**：

- **`Task.role: TaskRole`**：`types.ts` 加新枚举（当前仅 `"fe"`、未来扩 `be / data / mobile / qa`）+ `TASK_ROLE_LABEL` 中文映射、UI / prompt 统一来源
- **`task-fs.ts`**：`createTask` 默认 `role: "fe"`、`hydrateTask` 老数据兜底 `"fe"`、向后兼容老 task
- **`plan-runner.ts`**：`loadPhasePrompt` 把 `{{role}}` + `{{roleLabel}}` 注入 phase prompt、super-prompt 顶部多加一行「当前角色：xxx」提示
- **`phase-1-plan.md`**：明确「以 `{{roleLabel}}` 视角、为本地仓库出方案」、「只挑跟你这个角色相关的部分做」、列出当前角色 fe 的细化提示
- **`new-task-dialog.tsx`**：新建任务多一个「角色 \*」选择器（当前只有「前端」一项、保留 UI 以信号未来扩展）
- **路线图**：详见 `docs/MULTI-ROLE.md`（含扩 role 的 checklist）

##### 4.2 chat 自由化（用户拍板 2026-05-15）

**核心动机**：之前 chat 模式表单要求填标题 / 仓库 / 首条消息、还要点「启动 Chat」按钮才能进对话——「自由对话」却被表单卡得不自由。

**改造**：

- **表单全选填**：`new-task-dialog.tsx` chat 模式下标题 / 仓库 / 飞书链接 / 描述全可空、不填 `task-fs.createTask` 给默认值（标题占位「未命名对话 MM-DD HH:mm」、仓库默认 `os.homedir()`）
- **删 `/start-chat` 路由**：启动职责合并进 `/chat-reply`、用户在 UI 输入框发首条消息时后端自动 spawn agent
- **首条消息直接 inject prompt**：`chat-runner.buildInitialPrompt(task, skills, firstMessage?)` 加 firstMessage 参数、`runChatSession` 透传、agent 第一次 turn 就回答用户首条、答完才调 `wait_for_user` 进等待
  - 走过的弯路：先做了 `pendingFirstMessage` 队列（agent 起手 wait_for_user → 后端 race 消费）、但 wait_for_user 进来会让 task.status 短暂切 awaiting_user、UI 输入框闪可用、agent 还偏好 emit「正在调用 wait_for_user 等你」之类协议元叙述。直接塞 prompt 一步到位、彻底绕过 race
- **chat 模式也 inject contextDocs**：`buildInitialPrompt` 调 `renderContextDocsSection`、跟 plan 一致。`renderContextDocsSection` / `renderContextDocBody` / `TEXT_INLINE_INJECT_MAX` 从 `plan-runner.ts` 抽到 `src/lib/server/context-docs-prompt.ts`、plan / chat 共用
- **chat 模式详情页打开 ContextDocsPanel**：原本 `!isChatMode && <ContextDocsPanel>` 守卫拿掉、chat 任务也能随时加 / 删上下文

##### 4.3 字段统一：删 feishuUrl

**核心动机**：之前 plan 模式建任务用 `feishuStoryUrl` 字段、chat 模式用 `feishuUrl` 字段、`task-fs.createTask` 又只把 `feishuStoryUrl` 落 contextDocs——chat 模式用户填的「飞书需求文档链接」**两层都没拼进 agent prompt**、agent 看不到。

**改造**：

- 彻底删 `feishuUrl` 字段（`Task` / `NewTaskInput` / `TaskMeta` / API route / plan-runner 模板变量全砍）
- chat 模式表单 label 改「飞书项目链接（选填）」、复用 `feishuStoryUrl` 字段
- `createTask` 不分 mode、`feishuStoryUrl` 有就落「飞书 story」contextDoc

##### 4.4 代码质量大清扫（V0.4 同步做）

- 修 `chat-runner.ts` `buildInitialPrompt`：原本还在教 agent 走 `keep_alive_a/b/c`、chat 模式严重 prompt drift；重写跟 plan-runner 同款 V0.3.5 shell + curl long-poll
- 删 `prompts/phase-1-context.md` / `phase-2-plan.md` / `phase-3-build.md` / `phase-4-ship.md` 老文件（V0.3.4 起不再使用）
- 修 `phase-1-plan.md` / `phase-2-build.md` 内残留的 `keep_alive_a/b/c` 协议描述
- 修 `chat-mcp.ts` `ask_user` 工具 description：返回值从 `[USER_AWAITING]` 改为正确的 `[SHELL_WAIT_GUIDE]` + shell long-poll
- 修 `skills/context-docs-handler/SKILL.md`：4 phase 描述改 2 phase、`01-context.md` 改 `01-plan.md`
- 顶部导航 / metadata 改成「开发流水线」（之前几版叫过「前端需求自动化流水线」「项目级 AI Harness 平台」、用户拍板顶部 UI 用这个最简）
  - ⚠️ **「项目级 AI Harness 平台」仍是项目灵魂**：README.md 开头 / docs 文档都保留这个表述、不要因为顶栏简化就把灵魂去掉。Harness（缰绳）= 用确定性工具压 LLM 非确定性、是这个项目区别于「再造一个 Cursor」的核心命题
- `README.md` 整篇重写到 V0.4
- `DESIGN.md` 顶部 warning 改成完整版本演进表
- `chat-mcp.ts` GLOBAL_KEY bump 到 `__feAiFlowChatStateV6__`（dev 热重载不混入旧 V5 状态）

#### V0.3.5（2026-05-14 ~ 2026-05-15）：保活机制大重构 + race fix

**核心动机**：旧的 `keep_alive_a/b/c` MCP 轮转 + 50s timer 5-6 分钟必踩 anti-loop / SDK 内部超时、用户实测 12 / 15 分钟内必挂。深挖发现：

1. **MCP 工具调用有 60s 硬超时**（SDK 限制、跟模型无关）
2. **shell 工具没硬超时**（实测 `sleep 300` 能跑完、不踩 anti-loop）
3. **模型 bias**：`composer-2` 等模型 5 分钟没看到 stdout 新行就主动 summarize 退出

**新方案：shell + curl long-poll 取代 MCP 轮转**

- `wait_for_user` / `ask_user` MCP 工具**立即返回 shell 引导文本**（不阻塞、不 50s timer）、教 agent 调 `shell` 工具 `curl -sN '<base>/api/tasks/:id/wait-ack?token=…'`
- 新增路由 **`/api/tasks/[id]/wait-ack`**：长 HTTP 连接、`subscribeWaitAck` 拿 pendingMap 里的 promise、服务端 chunked write 每 60 秒一次 keepalive `[KEEPALIVE ts=...]`（普通文本行、防被 SDK shell-output-delta 过滤）、用户 ack 时 resolve promise → 写一行结果 + 关流 → curl exit → agent stdout 拿到结果推进
- **删 `keep_alive_a/b/c` 三件套** + 删 `wait_for_user` 重发拦截 / `[PROTOCOL_VIOLATION]` / 抗 anti-loop prompt 大段
- **prompt 加「钢铁纪律」段**：明确禁 agent 在 shell long-poll 期间 `read` 自己的 terminal 文件 / self-summarize / 提前退出
- wait-ack 路由配置：`runtime = "nodejs"` + `dynamic = "force-dynamic"` + `maxDuration = 3600`（撑 1 小时）
- **手动重连不自动 retry**：`Task.lastAgentId` 持久化（`task-fs.ts: setTaskLastAgentId`）+ 新路由 `/api/tasks/[id]/resume-waiting`：用户连接断了 UI 显示「继续监听」按钮、点了走 `Agent.resume(lastAgentId) + send("[RESUME]…")`、不自动重试（用户决定：避免 agent 反复踩坑、且老套餐 resume 也要 +1 send 配额）

**SDK 升级**：`@cursor/sdk` 1.0.10 → 1.0.13（怀疑修了 transport 重连、实际证明根因是网络、但保留）

**ask_user race fix（2026-05-15）**：

- 原版 `finalizeEntry` 立刻清 `tokenToTask` / `pendingMap`、触发严重 race：
  - agent 调 ask_user → 工具立即返回 SHELL_WAIT_GUIDE、agent 这边还要几秒才发起 shell + curl
  - 用户在 UI 早已看到弹窗、提交答案瞬间 → finalizeEntry 立刻清
  - 几秒后 agent 的 curl 才到 wait-ack 路由 → token 已不在表 → 返回 `[INVALID_TOKEN]` → agent 退 run
- **修复**：`finalizeEntry` resolve promise 后保留 60 秒 grace、晚到的 curl 还能 subscribe 到已 resolved 的 promise 立刻拿结果。`registerPendingEntry` 顶替时立即清旧 entry、不等 grace。新增 `forceCleanupEntry` 工具函数。
- 关键文件：`src/lib/server/chat-mcp.ts` 269-388 行（`GRACE_CLEANUP_MS` / `forceCleanupEntry` / `finalizeEntry` / `registerPendingEntry` / `subscribeWaitAck`）

#### 已知坑（V0.3.5 仍未解决）

- **代理偶发 ECONNRESET**：日志大量出现 `ConnectError: api2.cursor.sh ... Client network socket disconnected before secure TLS connection was established`、用户走科学上网工具 fake-ip 模式（`api2.cursor.sh → 198.18.0.x`）、节点偶发抽风、SDK 当 run error。**代码层无解、用户得换稳定代理节点 / 换协议**
- **dev mode hot reload 杀任务**：`pnpm start` 实际跑 `next dev`（看 `scripts/dev-open.mjs`、不是 prod）、改任何 watch 范围内的源文件就重启 server、跑中的任务被 `boot recovery` 标 failed。建议长任务用 `pnpm build && pnpm start:prod`
- **断线后只能手动「继续监听」**：不自动 retry 是用户决定（计费 + agent 反复踩坑 trade-off）

#### 待验证（用户要测）

- **端到端 demo 验证**：真飞书 story → 走完 plan + build 还没完整跑通一遍
- **V0.3.5 race fix 真实生效**：制造「用户答 ask_user 比 agent 调 curl 快」的极端场景、看 dev terminal 有没有 `[chat-mcp] subscribeWaitAck: ... entry 已 resolved（grace window）` 日志（race 命中 grace 拿到结果）
- **wait-ack 长连接稳定性**：故意不 ack、看能不能撑 5 / 10 / 15 / 30 分钟（无 ConnectError 干扰前提下）

#### 待打磨（未启动）

- **失败恢复**：现在只能「重启 workflow 从头」或「继续监听」、未来要支持「从某个 phase 续跑」（artifact 已落盘可复用）
- **自定义 workflow**：V0.2 写死 `feishu-story-impl`、未来支持多 workflow 注册
- **cost / token dashboard**

---


