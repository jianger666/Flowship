---
name: chat-history-recovery
description: >-
  恢复任务的历史上下文：当用户引用之前的对话（「刚才」「之前」「上次」之类）、
  或你怀疑 agent 进程重启过、当前上下文不完整时、用 `read` 工具读任务的 `events.jsonl`
  把所需的历史事件找回来。
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
3. **进程曾经重启过**（你启动时如果发现自己是新 agent、用户消息却像在接续话题）

## 怎么用

- 直接调 `read`（SDK 内置工具、名字就是 `read`、不是 `read_file`）读那个绝对路径
- 文件可能很大、按需 grep 关键词 / 看末尾几十行 即可、不需要全读
- 文件可能不存在或为空（首次启动）、安全忽略
- 找到相关事件 → 抽取其 `text` 字段拼到当前回复的上下文里

## 不要做的事

- 不要每次回复前都查（浪费 token、Cursor SDK 后端有自己的 context 管理）
- 不要主动总结历史给用户（用户已经在 UI 看到了完整时间线）
- 不要把 events.jsonl 整段贴给用户（这是内部 log、用户不需要看 raw 数据）
