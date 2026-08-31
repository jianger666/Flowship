---
name: chat-history-recovery
description: >-
  恢复任务的历史上下文：起手 prompt 已有「本窗口已有对话」时先用那一段；
  用户引用更早内容、或你怀疑上下文不完整时，再用 `read` 读任务的 `events.jsonl`。
---

# ai-flow Chat 历史上下文恢复

本任务的所有历史事件（之前你的回复、用户的消息、你调过的工具、思考过程等）都按时间序追加在 `events.jsonl` 里、JSONL 格式（每行一条 JSON 事件）。

## 文件位置

文件绝对路径由 ai-flow 启动时的初始 prompt 已经告诉你（变量 `eventsLogPath`、形如 `/Users/.../data/tasks/<task_id>/events.jsonl`）。

## 事件 schema

```json
{ "id": "ev_xxx", "ts": 1234567890, "kind": "assistant_message", "text": "...", "meta": { ... } }
```

`kind` 取值：

- `assistant_message`：你之前说过的话
- `user_reply`：用户之前发过的消息
  - `meta.images`：用户附过的图片（含 absPath / mimeType）
  - `meta.attachments`：用户附过的文件 / 目录路径
- `tool_call`：你调过的工具（read / grep / shell / write / edit / 其他 MCP 等）
- `thinking`：你的思考过程
- `info` / `error`：系统消息 / 错误

## 什么时候该 `read` 这个文件

1. 用户问「刚才」「之前」「上次」「你说的那个」之类、明显引用历史的话题
2. 你感觉缺少上下文、不知道「之前做到哪了 / 用户为啥这样问」
3. **起手 prompt 已经带了「本窗口已有对话」**：那是最近几轮正文，一般够用；只有那里没有的更早细节 / 工具过程，才读本文件末尾
4. 起手 prompt **没有**「本窗口已有对话」、但用户消息像在接续旧话题（你是新 agent）→ 先读本文件末尾的 `user_reply` / `assistant_message`

## 怎么用

- 直接调 `read`（SDK 内置工具、名字就是 `read`、不是 `read_file`）读那个绝对路径
- 文件可能很大、按需 grep 关键词 / 看末尾几十行 即可、不需要全读
- 文件可能不存在或为空（首次启动）、安全忽略
- 找到相关事件 → 抽取其 `text` 字段拼到当前回复的上下文里

## 不要做的事

- 不要每次回复前都查（浪费 token；会话还活着时历史已经在上下文里）
- 起手 prompt 已注入「本窗口已有对话」时，不要再整份重读一遍同一段正文
- 不要主动总结历史给用户（用户已经在 UI 看到了完整时间线）
- 不要把 events.jsonl 整段贴给用户（这是内部 log、用户不需要看 raw 数据）
