---
name: action-creator
description: 创建、修改本平台的自定义 Action（任务推进动作、ACTION.md）。只要用户提到「建/写/加/改一个 action」「把这个 skill 包成 action」「推进的时候想有个 XX 动作」「给测试/团队做一个 XX 步骤」，即使没说 action 这个词、只要意图是「在任务推进面板里多一种可选动作」，都用本 skill。
---

# action-creator：创建 / 修改自定义 Action

Action = 任务（task）推进面板里的一个动作按钮。用户点它 → agent 按 playbook 干活 → 产出
artifact 等用户审阅。本质上 action 就是「task 模式下的 skill 接入口」：它告诉 agent
这一步做什么、可以点名要用哪些 skill。

## 存储规范（对齐 skill 的目录形式）

一个 action = 一个目录 + ACTION.md：

```
<custom-actions 目录>/<action-id>/ACTION.md
```

- **目录名 = action id**：kebab-case 短横线小写（如 `api-test`、`risk-review`）、只用字母数字和 `-_`
- **写到哪（按顺序判定）**：
  1. 当前工作目录本身就叫 `custom-actions`（「AI 帮建」入口开的对话）→ 直接在当前目录下建 `<id>/ACTION.md`
  2. 环境变量 `FE_AI_FLOW_DATA_DIR` 存在 → 写到 `$FE_AI_FLOW_DATA_DIR/custom-actions/<id>/ACTION.md`
  3. 都不满足 → 先 `echo $FE_AI_FLOW_DATA_DIR` 确认、再问用户

## ACTION.md 结构

```markdown
---
label: 接口验证          # 必填：推进面板按钮上显示的名字（2~6 个字最佳）
summary: 读接口文档写自动化脚本并跑通   # 选填：列表里的一句话说明
skills:                  # 选填：本 action 要用的 skill 名（平台会注入引用、缺失的自动过滤）
  - api-testing
freshAgent: true         # 选填：true = 每次执行新开 agent（上下文干净）；省略 = 跟随用户勾选
placeholder: 贴接口文档链接或说明要验哪些接口   # 选填：推进弹窗输入框的提示文案
---

这里是 playbook 正文（给 agent 的执行指引）：

1. 按序步骤写清「做什么 / 怎么做 / 产出什么」
2. 明确产出物形态（artifact 里要有哪些段落）
3. 写清边界（不许做什么、遇到什么情况要 ask_user）
```

## 创建流程

1. **先弄清意图再动手**：问清（一次问全）——这个动作给谁用、输入是什么、产出是什么、
   要不要关联已有 skill（用户提到团队 skill 包时优先引用而不是把内容抄进 playbook）。
2. **playbook 写法**：像给新同事写操作手册——按序步骤 + 产出格式 + 边界约束。
   有信息密度、别写「认真分析」这类空话。需要用户输入的地方引用「用户指令」。
3. **关联 skill**：`skills` 字段填 skill 的 name（不是路径）；playbook 里写
   「先 read 对应 SKILL.md 再执行」的引导由平台自动注入、不用重复写。
4. **自检**：建完 `cat` 一遍确认 frontmatter 合法（YAML 可解析、label 存在）；
   告诉用户「去任务的推进面板就能看到这个动作」+ 能力页 Action tab 可以编辑 / 排序 / 隐藏。

## 修改已有 action

先 `ls` 目录找到对应 `<id>/ACTION.md`、读原文再改；用户没让动的字段别动；
改完提醒「已生效、推进弹窗直接可见」。
