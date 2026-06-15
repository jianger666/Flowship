# ai-flow 多角色通用化路线图

> 沉淀 V0.4「按角色读 story」设计的来龙去脉、以及未来扩 enum 时的操作指南。

> ⚠️ **部分实现细节已随 V0.6 演进**（以 `docs/HANDOFF.md` 为准）：① phase chain → task 容器 + action 历史（不再有「phase 序列」）；② `prompts/phase-*.md` → `prompts/action-*.md`；③ 单仓 `Task.repoPath` → 多仓 `Task.repoPaths`（V0.6.1）。下面的 **role 机制 / 扩 role checklist 仍有效**、只是文件名 / 字段名按上述映射读。

## 起因

ai-flow 一开始是前端项目（crm-web）的专属工具、整套 prompt 都是「前端 Vue / React 项目」假设。

但实际飞书项目（wukongedu / wk-dm）的 story 不是「前端 story」或「后端 story」、而是**「跨角色共享的产品需求」**：

```
story 6993079032（产品需求）
├─ role_members:
│   ├─ PM（产品负责人）
│   ├─ UI&UX（设计）
│   ├─ ferd（前端开发）
│   ├─ berd（后端开发）
│   ├─ role_tester（测试）
│   ├─ QA（测试负责人）
│   ├─ 技术负责人
│   └─ 数仓负责人（蔡行）
├─ 工作节点:
│   ├─ 数仓中间表准备
│   ├─ 技术排期（前端 + 后端共用一个节点、不分）
│   └─ 测试排期
└─ wiki: 详细需求正文（PM 在飞书 wiki 写、不在 story 里）
```

研发要做的是**从 story 里挑「跟我有关」的部分**、而不是从 0 写一个全栈实现。

## 短期方案（V0.4）：task.role 字段

**「一个 story、多 task、每个 task 锁一个 repo + 一个 role」**：

- 用户在新建 task 时显式选 role（schema 上是 `TaskRole` enum、UI 是 Select）
- 同一条 story URL 填到前端 task 和后端 task（同事各自在本地建）
- 前端同事 task：`role = "fe"`、`repoPath = crm-web`、agent 以前端视角扫仓库 / 出方案
- 后端同事 task：未来 `role = "be"`、`repoPath = crm-server`、agent 以后端视角扫
- workflow 仍是同一个 `feishu-story-impl`（V0.6 起 action 任意触发、不再有固定 phase 序列）

**关键工程决定**：

| 决定 | 选择 | 理由 |
|---|---|---|
| 角色字段位置 | `Task.role` enum 单字段 | 不为「未来可能多 role」搞 string[]、保持简单 |
| 当前 enum 值 | 单值 `"fe"` | V0.4 只做前端、后续扩值 |
| UI 暴露方式 | Select 显式选（即便只 fe 一个 option） | 用户预期「以后会有更多角色」、不藏掉 |
| 角色文案 | `TASK_ROLE_LABEL` 单一来源 | 避免组件各自维护中文映射、漂移风险 |
| harness 工具链 | 不存 task、agent 自己探测 | 看 `package.json` / `pom.xml` / `go.mod` 等识别 |
| prompt 模板 | 单 `action-plan.md`、内嵌 role 段 | 不拆 `prompts/roles/*.md` 子目录、只一个 role 时过度设计 |
| MCP 装配 | 不按 role 区分、用现有任务级黑名单 | 角色多了再说 |

## 完整 role 枚举（未来扩展）

短期不实现、但前期设计预留：

| role | 中文 | 典型仓库 | 关心的 story 部分 | harness 工具链 |
|---|---|---|---|---|
| `fe` ✅ | 前端 | `crm-web` / `student-h5` / Vue / React / Next | 接口契约 / 字段语义 / 路由 / 组件 / 状态 / 文案 / 设计稿 | `pnpm typecheck` / `pnpm lint` / `pnpm build` |
| `be` | 后端 | `crm-server` / Java / Go / Node | 接口设计 / DB schema / 事务 / 业务规则 / 错误码 | `mvn verify` / `go test ./...` / `pnpm test` |
| `data` | 数仓 | `dbt` / SQL 仓库 / Hive jobs | 中间表 / 字段口径 / 数据准确性 / 调度依赖 | `dbt compile / test` / SQL lint |
| `mobile-ios` | iOS | Swift 仓库 / `*.xcodeproj` | 接口 / 页面 / 状态 / 推送 / 上架 | `xcodebuild` / SwiftLint / 单测 |
| `mobile-android` | Android | Kotlin 仓库 / `*.gradle` | 同上 + Android 平台特性 | `gradle build` / ktlint / 单测 |
| `qa` | 测试 | 测试代码仓库 / Cypress / Playwright | 验收标准 / 测试 case / e2e 流 | playwright / cypress / 单测 |

注意：
- **B 端前端 / C 端前端 V0.4 不拆**——视觉规范 / 用户群差异主要落在 prompt 输出风格、工程侧（schema / harness）一样。**实操中确实需要再拆**时、可在 `TaskRole` 加 `fe-b` / `fe-c`、`fe` 保留兜底
- **fullstack 单仓库**（同一 repo 前后端都写）暂不支持——会一直支持「一个 task 锁一个 role」、跨 role 工作就拆两个 task

## 扩 role 的 checklist

加一个新 role（比如 `be`）时、必须改的文件：

1. **`src/lib/types.ts`**
   - `TaskRole` enum 加 `"be"`
   - `TASK_ROLE_LABEL` 加 `be: "后端"`

2. **`src/components/tasks/new-task-dialog.tsx`**
   - `ROLE_OPTIONS` 数组加 `"be"`（UI Select 自动出新 option）

3. **`prompts/action-plan.md`**
   - 「当前角色提示」段加 `role=be` 的描述块、说明后端视角是什么（关心接口设计 / DB / 业务规则）
   - 不需要拆新文件——同一 prompt 内按 role 分支即可（agent 看到 `{{role}}` 注入值后自己取对应段）

4. **`prompts/action-build.md`**
   - 「严格约束」段补充：「按 role 选 build / typecheck / test 命令」（其实当前已经让 agent 自己 detect、可能不用改）

5. **测试**
   - 新建一个 `role=be` 的 task、跑端到端、看 plan / build artifact 是否反映后端视角

可选（按 ROI 决定）：
- 给 `prompts/roles/<role>.md` 单独文件存特异指令——只有当单文件分支注释太繁琐时才拆（≥ 4 个 role 时考虑）
- MCP 按 role 默认装配（前端默认装 figma-mcp、后端默认装 swagger-mcp）

## 不做的

明确不做、避免过度设计：

- ⚠️ **一个 task 多 repo**：V0.4 设计是单仓（`Task.repoPath: string`）、**V0.6.1 已改多仓**（`Task.repoPaths: string[]`、ship 支持多仓 MR）。「一个 task 锁一个 role」仍成立、但仓库不再限单个
- ❌ **一个 task 多 role**：同上
- ❌ **role + repoType 校验**：前端 role 选了 Java 仓库不报错——大概率是用户配错、agent 自己扫 repo 也能识别异常、不挡用户路
- ❌ **自动从 story 识别角色**：agent 看 story 自己挑 ferd / berd 节点细节、不要 ai-flow 帮用户拆 task
- ❌ **「角色市场」/「角色 marketplace」**：role 数量是有限的、不做插件式扩展

## 未来探索（不在路线图）

- **跨 repo 协同**：前端 task 跑完、自动建一个后端 task 让后端同事跑（需要全员都用 ai-flow、目前用户基数不够）
- **story 自动状态同步**：phase ack 后自动改飞书 story 的「前端完成度 / 后端完成度」字段（V0.3.3 已砍 ship phase——出于注意力管理、先把 plan/build 做扎实）
- **角色协作仪表盘**：在 story 维度看「前端 task=plan ack、后端 task=build running」之类的全局视图

## 关联文档

- 项目核心约束：`.cursor/rules/project-context.mdc`
- 当前架构（task + action）：`docs/HANDOFF.md`「当前架构快照」段
