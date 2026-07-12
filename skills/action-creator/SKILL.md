---
name: action-creator
description: 对话创建自定义 Action（把 skill 挂到推进面板）。用户说「建/写/加一个 action」「推进里想有个 XX 动作」「把这个流程做成推进步骤」「对话创建 action」时用本 skill。
---

# action-creator：对话创建自定义 Action

## 概念

自定义 action = 把一个 skill 挂到任务推进面板上。内容（做什么、怎么做、输出什么）都在 skill 里；action 壳只有几个挂载参数（label / 产出要求 / 输入框提示）。

## 流程

1. 问清用户（一次问全）：这个动作**做什么**、跑完想看到**什么产出**。已有现成 skill 可挂的直接复用。
   - 产出最终一定会写成任务目录里的 md 交给用户审阅（系统机制、没有「只在对话里回」的形态）——问的是「这份 md 里要包含什么」、别给用户「直接在对话里回答」之类的选项。
2. 建 skill：写法规范见 skill-creator、先 read 它；目录名 kebab-case 英文、落到当前工作目录 `<cwd>/<skill名>/SKILL.md`。**产出要求不写进 skill**——那是壳参数、下一步用 `output` 传。
3. 调 `create_custom_action` 挂壳：
   - `label`：推进按钮显示名（必填、可中文）
   - `skill`：刚建的 skill 名（必填）
   - `output`：产出要求（多行；用户关心「跑完看到什么」就写这里）
   - `placeholder`：推进时提示用户填什么（可选）
4. 告诉用户去「能力页 → Action」查看，可拖拽排序 / 显隐 / 编辑。
