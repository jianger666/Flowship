---
name: chat-attachments
description: >-
  处理 ai-flow 用户消息里附的图片 / 文件 / 目录。
  当用户消息文本里出现 `[ATTACHED_IMAGES]` 或 `[ATTACHED_PATHS]` 标记时、
  请 read 本 skill。这两个标记后面跟的是用户希望你跟他的文字消息一起检查的绝对路径列表。
---

# ai-flow 用户附件处理

用户在 ai-flow UI（chat 输入条 / 任务页输入条 / 推进 dialog）里可以**附两类东西**。
服务端把标记段拼进发给你的用户消息（首条消息、`agent.send` 续接、或 `[NEXT_ACTION]` / `[USER_MESSAGE]` / `[USER_REPLY]` 消息正文后），**不是**工具返回值。

## A. `[ATTACHED_IMAGES]`：图片（粘贴 / 拖拽 / 选文件）

消息末尾出现 `[ATTACHED_IMAGES]` 段、紧跟一行行绝对路径：

```
[ATTACHED_IMAGES] 用户附了以下图片、请用 `read` 工具逐一读取（…）：
  1. /Users/.../tasks/<id>/uploads/att_xxx.png
  2. /Users/.../tasks/<id>/uploads/att_yyy.jpg
```

**必须做的事**：

1. 对**每张图**用 SDK 内置 `read` 工具读它的绝对路径（工具名就叫 `read`、不是 `read_file`）
2. SDK 内置 `read` 对图片有 vision 处理（magic bytes → image 通道、resize 后喂像素）
3. 基于图 + 用户文字一起回复 / 执行

## B. `[ATTACHED_PATHS]`：任意文件 / 目录路径（原生 picker）

消息末尾出现 `[ATTACHED_PATHS]` 段：

```
[ATTACHED_PATHS] 用户附了以下文件 / 目录路径、按需用 `read` / `grep` / `glob` 读取：
  1. /Users/foo/repo/src/auth/login.ts
  2. /Users/foo/repo/docs/
```

**必须做的事**：

1. 路径已是后端校验过的绝对路径、直接用
2. **文件**：`read` 读内容；**目录**：先 `glob` / shell `ls` 再按需 `grep` / `read`
3. 用户附了路径通常想让你**针对这些位置**回答、别绕开去别处找

## A / B 通用的不要做的事

- 不要用 base64 / data URL 自己解析图（SDK 已处理）
- 不要说「我没法看图 / 看不到附件」——你能读路径
- 不要质疑路径合法性（后端已校验）
- 不要把 `[ATTACHED_IMAGES]` / `[ATTACHED_PATHS]` 字面回贴给用户（内部协议）
