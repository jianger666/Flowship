---
name: action-creator
description: 对话创建自定义 Action（把 skill 挂到推进面板）。用户说「建/写/加一个 action」「推进里想有个 XX 动作」「把这个流程做成推进步骤」「对话创建 action」时用本 skill。
---

# action-creator：对话创建自定义 Action

自定义 Action = **skill 挂载壳**：方法论住在 skill 里、壳只带执行参数（产出要求等）。
创建分两步——先写纯方法论 skill，再调 MCP 工具挂壳。

## 创建流程（按序）

### 1. 先问清（一次问全、别挤牙膏）

- 这个动作**干什么**（给谁用、输入是什么）
- 跑完用户想看到**什么产出**（报告结构 / 清单 / 结论格式……）

信息够了再动手；已有现成 skill 可挂的优先复用、别重复造。

### 2. 写主 skill（纯方法论）

写到**当前工作目录**（对话创建入口已把 cwd 锁在自管 skills 目录）：

```
<cwd>/<skill名>/SKILL.md
```

约束：

- **目录名**用简短中文或 kebab-case 英文都行（如 `写代码` / `perf-audit`）
- frontmatter 必填 `name`（= 目录名）+ `description`（做什么 + 何时用）
- 正文 = **纯方法论**：步骤、边界、怎么判断做完——**零平台词汇**
  - ⛔ 禁止出现：artifact / submit_work / 任务链 / action / 推进面板 / ask_user / 等本平台概念
  - ✅ 写成给任意 agent 都能跟的操作手册；产出形态用「交付物 / 报告 / 清单」等中性词
- **产出要求不要写进 SKILL.md**——那是壳参数，下一步用工具的 `output` 传

### 3. 调 `create_custom_action` 挂壳

主 skill 落盘后再调。关键参数：

| 参数 | 说明 |
|---|---|
| `label` | 推进按钮显示名（必填） |
| `skill` | 刚写好的主 skill 名（必填） |
| `output` | 产出要求（多行；用户关心「跑完看到什么」就写这里） |
| `summary` | 一句话简介（可选） |
| `placeholder` | 推进输入框提示（可选） |

工具若回报「skill 找不到」→ 检查目录名 / SKILL.md 是否写对，修好再调。

### 4. 收尾

告诉用户：**去能力页 → Action tab** 可以看到新动作，可拖拽排序 / 显隐 / 编辑。
不要承诺「立刻出现在某个正在开着的推进弹窗」——刷新或重开推进即可。

## 不要做的事

- 不要直接写 `custom-actions/*/ACTION.md`（壳由工具结构化创建）
- 不要把产出要求塞进 SKILL.md
- 不要在 skill 正文里教平台工具用法
