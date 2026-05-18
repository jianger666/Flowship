# fe-ai-flow vs Cursor IDE vs Claude Code

## 一句话差异化

fe-ai-flow 不是另一个 Cursor / Claude Code、是在它们之上的 **harness 工程化层**。核心价值是让 AI 写代码这件事「自动化 + 流程规范化」、最终保障产出质量。代码具体怎么写 / hunk 怎么改是 Cursor / CC 的事、不是本项目要打的战场。

## 入口形态

| 工具 | 入口 | 形态 |
|---|---|---|
| Cursor IDE | 用户在编辑器里手动唤起 chat / agent | 交互式、用户全程在 IDE |
| Claude Code | CLI 命令行 / IDE 插件 | 交互式、agent 在用户 supervise 下跑 |
| fe-ai-flow | 网页看板、每个任务一张卡 | 半自动、用户只在 phase 边界 ack |

## 核心差异

- **自动化粒度**：Cursor / CC 是「按需 turn」、fe-ai-flow 是「按需求 plan → build 整段」
- **HITL 节奏**：Cursor / CC 是每条 message 都 HITL、fe-ai-flow 是只在 phase 边界 HITL
- **数据可审计**：Cursor / CC chat 历史在 IDE 本地、fe-ai-flow 全程 `events.jsonl` + `artifacts/*.md` 可 diff / 可回放
- **适合场景**：Cursor / CC 适合编辑器内即时辅助、fe-ai-flow 适合「半结构化需求 → PR」流程化交付

## Harness 保障质量的 7 件事（fe-ai-flow 核心能力）

1. **每个 phase 输入 / 输出有 schema**：artifact 用 markdown frontmatter 锁字段
2. **每个 phase 边界用户 ack**：HITL 是底线、不允许偷偷往下走
3. **agent 跑前 / 跑后跑确定性工具**：typecheck / lint / hooks 收敛非确定性
4. **MCP 工具白名单 + 任务级黑名单**：限制 agent 能用的副作用源
5. **Skills 沉淀可复用能力**：场景化判断写在 SKILL.md、跨任务共享
6. **events.jsonl 全量记录**：每次 LLM 调用 / 工具调用 / 用户操作落盘可审计
7. **artifact 持久化 + 可回退**：phase 产出落 `artifacts/<NN>-<phase>.md`、可 diff 历史

## V0.4 当前能力 vs Cursor IDE / Claude Code

- **多角色支持**：V0.4 `Task.role` 字段、同一 story 跨角色多 task 并行（Cursor / CC 不区分角色）
- **chat 自由化**：V0.4 chat 模式表单全选填、首条消息直接启 agent（接近 Cursor / CC 的轻量交互形态）
- **plan 模式（推荐主线）**：粘飞书 story → 自动跑 plan → build、Cursor / CC 不做这件事

## 未来路径（V1.x / V2）

- B 端 rules 库（仿 wk-ai-rules 形态、覆盖表单 / 表格 / 权限 / 接口类型）→ build phase 注入目标仓库 `.cursor/rules/` 当 cursor rule 用
- 角色枚举扩展（be / data / mobile / qa）
- 自定义 workflow 注册（V0.2 写死 `feishu-story-impl`）
- token / cost dashboard
