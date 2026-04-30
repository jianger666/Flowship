# ROADMAP

> 渐进式、不一次性做完。每个阶段验证 ROI 后再投资源。

> ⚠️ **2026-04-30 同步**：原 V0.1 spec phase 代码已被用户 clean slate 清空、当前正在重新设计主流程交互形态。下面 V0.1 / V0.2 / V0.3 的具体方案是**上一版本的设想**、保留作参考、不一定再走老路。
> 当前实际进度看 HANDOFF.md「当前状态（最新）」一节。

---

## 当前阶段（重新规划中）

| 阶段 | 状态 | 备注 |
|---|---|---|
| 基础设施（设置页 / shadcn / Tailwind 4 / SDK 验证） | ✅ 完成 | clean slate 重做 |
| 主流程交互（首页 UI 形态） | 🚧 待和用户讨论 | 单段还是分段、表单还是聊天 |
| spec / plan / build 三段式 | 🤔 暂保留为参考 | 用户在思考是否还分段 |
| 飞书 / swagger 自动拉 | 🔲 未启动 | 老路线 W4 |
| cost / token dashboard | 🔲 未启动 | 老路线 W5 |

---

## V0.1（旧设想·保留参考）：Spec 生成

**目标**：粘贴需求 + swagger → AI 输出结构化 spec.md。

**验收标准**：

- [ ] pnpm dev 跑通、http://localhost:3000 打得开
- [ ] 设置页配 API key、加仓库
- [ ] 主页提交一个真实需求（如 6961355105）
- [ ] 流式输出 spec.md、产物落 data/tasks/<id>/spec.md
- [ ] spec.md 命中 80%+：改动文件清单准、source 标了、不编

**当前缺失**：spec phase 整套代码已删、要不要重建看用户拍板。

---

## V0.2 / W2：Plan 生成（旧设想·保留参考）

**目标**：spec.md → plan.md（改动文件 checkbox + grep 校验）

**输出物 schema**：

```markdown
# Plan-{ID}

## 改动文件 checkbox（按执行顺序）
- [ ] src/views/set/allocationRules.vue
  - 操作：编辑
  - 段落：line 580-610（submitRules 内 stuParam 数组）
  - 改动：tags 字段从顶层移到 stuParam.push({ fieldName: "tags", ... })
  - 校验命令：grep -n "fieldName: 'tags'" src/views/set/allocationRules.vue
- [ ] ...

## 跨文件依赖
- (说明哪些文件改动有依赖关系、谁先谁后)

## 风险点
- (AI 不确定的地方)
```

**关键设计**：

1. AI2 不能"自由发挥"——必须按 checkbox 逐项执行
2. 每条改动必须**附 grep / awk 校验命令**——执行完用 shell 跑一下、验证改对了
3. plan.md 跑完、用户必须点 ack 才能进 build phase

**实现要点**：

- 复用 `runSpecPhase` 同样的 SDK 流式架构
- 新增 `prompts/build-plan.md`
- spec.md 作为 plan phase 的输入（注入到 prompt 里）
- API route：`/api/tasks/[id]/run/plan` 单独跑

**预计**：1.5 天。

---

## V0.3 / W3：Build 执行（旧设想·保留参考）

**目标**：plan.md → 实际改动 + git commit + draft MR

**关键挑战**：

1. AI 改的代码必须**通过 lint / typecheck**
2. **每个 checkbox 改完跑一次校验命令**、失败回退
3. **不污染当前分支**——自动 checkout 新分支 `feature/ai-flow/<story-id>`

**执行流**：

```
读 plan.md
  ↓
for each checkbox:
  git stash（保护现场）
  agent.send("执行改动 N、按描述操作 ${file}")
  跑 lint / typecheck
  跑 plan.md 里的校验命令
  通过 → git add + commit
  失败 → git stash pop（回退）+ 标记 failed
↓
git push -u origin <branch>
↓
gitlab MR API 创 draft MR
```

**HITL 介入点**：

- AI 跑完所有 checkbox 后、**不自动 push**
- UI 显示 diff、用户点"确认推送"才推
- MR 创建后、用户决定何时 approve

**实现要点**：

- 新增 `src/lib/git.ts`（git operations、用 simple-git 或直接 child_process）
- 新增 `src/lib/lint.ts`（跑 ESLint / tsc / 用户自定义脚本）
- API route：`/api/tasks/[id]/run/build`

**预计**：3-4 天。

---

## V0.4 / W4：飞书 MCP 集成（未启动）

**目标**：用户只输入 storyId、自动拉飞书需求 + swagger

**实现**：

- `src/lib/feishu.ts`：通过飞书 OpenAPI 拉 docx 内容
- `src/lib/swagger.ts`：通过 swagger URL 拉接口 schema
- 表单加"自动拉取"按钮、调这两个接口、把返回的内容自动填到需求 / swagger 字段

**预计**：1 天。

**前置依赖**：

- 用户在设置页加飞书 app_id / app_secret（也存 localStorage）
- swagger 集中地址（公司有统一 swagger gateway 吗？需确认）

---

## V0.5 / W5：Cost / Token Dashboard（未启动）

**目标**：知道每个任务花了多少 token / 多少钱

**实现**：

- `llm-log.jsonl` 已经记 token 数（如果 SDK 返回的话）
- 加一个 `/dashboard` 页面、汇总：
  - 今日总 token / 总 cost
  - 按任务 / 按 phase 分布
  - 平均 latency
- 数据源：扫描 `data/tasks/*/llm-log.jsonl`

**未来可选升级**：接 Langfuse 自托管 dashboard、白送一套观测能力。

**预计**：1 天。

---

## V0.6+ / W6+：体验优化

- [ ] 任务搜索 + 标签 + 归档
- [ ] cancel 中途打断（agent.cancel()）
- [ ] retry 单 phase（改 prompt 后重跑、不重做整个链路）
- [ ] 比较同一 storyId 多次执行的 spec 差异
- [ ] 多语言 prompt 模板（B / C 端分开）
- [ ] 团队共享 prompt 库（git submodule？）

---

## 不打算做（明确止损）

| 不做的事 | 为什么 |
|---|---|
| Multi-agent 串联 | Cognition 警告、共识盲点、debug 灾难 |
| AI 自审 review bot | 单 agent 自审悖论、性价比低 |
| 跨 AI 厂商路由（LiteLLM） | 没必要、增加复杂度 |
| 自动跑测试用例 | 公司没单测 / e2e、强行做没意义 |
| 自动 merge MR | 责任归属问题、永远不该自动 |
| 接 IDE plugin | 命令行 + Web UI 已经够、IDE plugin 维护成本高 |

---

## 决策检查表（V 转 V 时）

每个 V 完成后、问自己 4 个问题、再决定下一步投不投：

1. 当前 V 在真实任务上的命中率 ≥ 70% 吗？（不够、回去调 prompt）
2. 用户实际使用频次足够吗？（一周用不到 3 次、说明价值不够）
3. 维护成本是否在增长？（prompt 越来越长、规则越来越多——警惕）
4. 用户主动要扩展吗？（用户不主动提、就是没痒处）

**任意一个 ❌ → 暂停、调研、不要硬推下一阶段**。
